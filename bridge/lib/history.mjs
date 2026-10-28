// dsh-link/bridge/lib/history.mjs — 会话历史（只读）。
//
// 目标：给本机「鲸歌」面板提供 pet-local 的历史消息，**同时包含**
//   ① bridge 自己发出的轮次；② 外部来源（服务器 Web UI / 其他客户端）的轮次。
//
// 取数策略（实测 rc.2/rc.3）：
//   1) `session/history` RPC —— 任务要求优先；rc.2/rc.3 源码里**没有这个方法**（实测 404），
//      只探测一次并记日志，可用则用。
//   2) `session/page` RPC —— rc.2/rc.3 真正的一元只读历史接口，需要 `throughSeq`（会话日志游标）：
//      `{address:{kind:'session',sessionId}, throughSeq:<cursor>, maxMessages, beforeSeq?}`
//      → `{records:[{type:'event',event}], hasMore}`。游标从 mux `session/follow` 的 snapshot.cursor
//      或已收事件的 seq 得到（MuxFollower.getCursor）；未知时先强制重订阅拿一次 snapshot。
//   3) 兜底：mux `session/follow` 快照的 records + bridge 运行期消息缓存（MessageCache）。
// 全程只读，不调用 prompt / 不触发模型。
import {
  messagesFromRecords,
  mergeMessages,
  paginateMessages,
  seqFromMessageId,
} from './messages.mjs';

export class HistoryService {
  constructor({ client, follower, cache, log, cfg }) {
    this.client = client;
    this.follower = follower;
    this.cache = cache;
    this.log = log;
    this.cfg = cfg;
    this.historyRpcState = 'unknown'; // unknown | available | missing
    this.lastSource = null;
    this.lastWarning = null;
  }

  /** 探测 `session/history` 是否存在（只探一次；rc.2/rc.3 实测不存在）。 */
  async probeHistoryRpc(sessionId) {
    if (this.historyRpcState !== 'unknown') return this.historyRpcState;
    try {
      await this.client.callUnary('session.history', {
        address: { kind: 'session', sessionId },
        maxMessages: 1,
      }, { timeoutMs: 8000 });
      this.historyRpcState = 'available';
      this.log.info('history: session/history RPC 可用');
    } catch (error) {
      this.historyRpcState = 'missing';
      this.log.info(`history: session/history RPC 不可用（${error?.code ?? error?.message}），改用 session/page 一元接口`);
    }
    return this.historyRpcState;
  }

  /** `session/page` 一元历史（需要游标）。 */
  async pageRpc({ sessionId, maxMessages, beforeSeq, cursor }) {
    const request = {
      address: { kind: 'session', sessionId },
      throughSeq: Number.isFinite(cursor) ? cursor : 0,
      maxMessages,
    };
    if (Number.isInteger(beforeSeq)) request.beforeSeq = beforeSeq;
    return this.client.callUnary('session.page', request, { timeoutMs: 20000 });
  }

  /**
   * 读取一段历史。
   * @param {{sessionId:string, limit?:number, before?:string|null}} params
   * @returns {{ok:true,sessionId,messages,hasMore,nextBefore,source,warning?}}
   */
  async getHistory({ sessionId, limit = null, before = null }) {
    const sid = String(sessionId);
    const cap = Math.max(1, Math.min(500, Number(limit) || Number(this.cfg.historyDefaultLimit) || 100));
    const beforeSeq = seqFromMessageId(before);
    let messages = [];
    let hasMore = false;
    let source = null;
    let warning = null;

    await this.probeHistoryRpc(sid);

    // 1) 优先 session/history（若某版本支持）
    if (this.historyRpcState === 'available') {
      try {
        const value = await this.client.callUnary('session.history', {
          address: { kind: 'session', sessionId: sid },
          maxMessages: cap + 20,
          ...(beforeSeq !== null ? { beforeSeq } : {}),
        }, { timeoutMs: 20000 });
        const records = value?.records ?? value?.messages ?? value?.events ?? [];
        messages = messagesFromRecords(records);
        hasMore = value?.hasMore === true;
        source = 'session/history';
      } catch (error) {
        warning = `session/history 失败: ${error.message}`;
        this.log.warn(warning);
      }
    }

    // 2) session/page（rc.2/rc.3 主路径）；游标未知时先取一次 follow 快照
    if (!source) {
      let cursor = this.follower.getCursor(sid);
      try {
        if (cursor === null) {
          const snapshot = await this.follower.refresh(sid, 10000, {
            maxMessages: Math.min(500, Math.max(cap + 20, 50)),
          });
          if (snapshot) {
            messages = messagesFromRecords(snapshot.records ?? []);
            cursor = Number.isFinite(snapshot.cursor) ? snapshot.cursor : null;
            source = 'follow-snapshot';
          }
        }
        if (source !== 'follow-snapshot' && cursor !== null) {
          const page = await this.pageRpc({ sessionId: sid, maxMessages: cap, beforeSeq, cursor });
          messages = messagesFromRecords(page?.records ?? []);
          hasMore = page?.hasMore === true;
          source = 'session/page';
        }
      } catch (error) {
        warning = `session/page 失败: ${error.message}`;
        this.log.warn(warning);
      }
    }

    // 3) 兜底：再抢一次快照 + 运行期缓存
    if (!source) {
      try {
        const snapshot = await this.follower.refresh(sid, 10000, {
          maxMessages: Math.min(500, Math.max(cap + 20, 50)),
        });
        if (snapshot) {
          messages = messagesFromRecords(snapshot.records ?? []);
          source = 'follow-snapshot';
        }
      } catch { /* ignore */ }
      if (!source) {
        if (this.cache.sessionSize(sid) === 0) {
          throw Object.assign(new Error(`无法读取会话历史（${warning ?? '无可用数据源'}）`), { code: 'history-unavailable' });
        }
        source = 'cache';
      }
    }

    // 合并运行期缓存（含 mux 实时收到、可能比 page 更新的消息；也补外部来源）
    let cached = this.cache.list(sid);
    if (beforeSeq !== null) cached = cached.filter((message) => Number.isFinite(message.seq) && message.seq < beforeSeq);
    let merged = mergeMessages(messages, cached);

    // before 处理：能换算成 seq 的已在数据源侧过滤；否则用本地分页按 id 截断
    let page;
    if (before !== null && before !== undefined && before !== '' && beforeSeq === null) {
      page = paginateMessages({ messages: merged, limit: cap, before });
      merged = merged.slice(0, Math.max(0, merged.length)); // 保持原样（paginate 已处理）
    } else {
      if (beforeSeq !== null) {
        merged = merged.filter((message) => !Number.isFinite(message.seq) || message.seq < beforeSeq);
      }
      page = paginateMessages({ messages: merged, limit: cap });
    }

    this.lastSource = source;
    this.lastWarning = warning;
    const effectiveHasMore = hasMore || page.hasMore;
    return {
      ok: true,
      sessionId: sid,
      messages: page.messages,
      hasMore: effectiveHasMore,
      nextBefore: effectiveHasMore ? (page.messages[0]?.id ?? null) : null,
      source,
      ...(warning ? { warning } : {}),
    };
  }
}
