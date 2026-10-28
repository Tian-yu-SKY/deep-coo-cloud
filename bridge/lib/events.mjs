// dsh-link/bridge/lib/events.mjs — WS /events 实时事件中枢（panel protocol §2）。
//
// - 连接后先发 snapshot（最近 100 条，来自 HistoryService），之后推 message / status / ping。
// - 只推 followSessionIds（默认仅 pet-local）；**绝不关注/推送两个 QQ 绑定会话（红线）**。
// - 常驻 follow：bridge 启动后即对 followSessionIds 保持 mux 订阅，
//   因此外部来源（服务器 Web UI / 其他客户端）发给 pet-local 的消息也能实时收到并广播。
import { messagesFromRecords, messageFromEvent, mergeMessages, toWireMessage } from './messages.mjs';

export const EVENTS_SNAPSHOT_LIMIT = 100;
export const EVENTS_PING_INTERVAL_MS = 25000;

export class EventHub {
  constructor({ follower, history, cache, log, cfg, busyGetter }) {
    this.follower = follower;
    this.history = history;
    this.cache = cache;
    this.log = log;
    this.cfg = cfg;
    this.busyGetter = typeof busyGetter === 'function' ? busyGetter : () => false;

    const wanted = Array.isArray(cfg.followSessionIds) && cfg.followSessionIds.length > 0
      ? cfg.followSessionIds
      : [cfg.sessionId];
    this.followSessionIds = [];
    for (const raw of wanted) {
      const sid = String(raw);
      if (cfg.forbiddenSessionIds.includes(sid)) {
        this.log.error(`EVENTS RED-LINE: followSessionIds 里出现 forbidden session ${sid}，已忽略（绝不关注/推送）`);
        continue;
      }
      if (!this.followSessionIds.includes(sid)) this.followSessionIds.push(sid);
    }
    if (this.followSessionIds.length === 0) this.followSessionIds = [cfg.sessionId];

    this.clients = new Set();
    this.currentTurns = new Map();
    this.running = new Map();
    this.started = false;
  }

  isFollowed(sessionId) {
    return this.followSessionIds.includes(String(sessionId));
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.follower.on('event', this._onEvent);
    this.follower.on('snapshot', this._onSnapshot);
    for (const sid of this.followSessionIds) {
      this.follower.follow(sid);
      this.log.info(`events: 常驻 follow ${sid}（外部来源消息也会实时进入 /events）`);
    }
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.follower.off('event', this._onEvent);
    this.follower.off('snapshot', this._onSnapshot);
    for (const client of this.clients) {
      try { client.close(1001, 'bridge shutdown'); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  /** mux 实时事件 → 消息/状态广播。 */
  _onEvent = ({ sessionId, event }) => {
    if (!event || !this.isFollowed(sessionId)) return;
    const sid = String(sessionId);
    if (event.type === 'turn/start') {
      if (Number.isFinite(event.data?.turn)) this.currentTurns.set(sid, event.data.turn);
      this.running.set(sid, true);
      this._broadcast({ type: 'status', sessionId: sid, running: true, busy: Boolean(this.busyGetter()) });
      return;
    }
    if (event.type === 'turn/end') {
      this.running.set(sid, false);
      this._broadcast({ type: 'status', sessionId: sid, running: false, busy: Boolean(this.busyGetter()) });
      return;
    }
    const message = messageFromEvent(event, { currentTurn: this.currentTurns.get(sid) });
    if (!message) return;
    if (!this.cache.add(sid, message)) return;
    this._broadcast({ type: 'message', sessionId: sid, message: toWireMessage(message) });
  };

  /** 重连快照里可能带上断线期间的消息（含外部来源）：补进缓存并广播新增。 */
  _onSnapshot = ({ sessionId, snapshot }) => {
    if (!this.isFollowed(sessionId)) return;
    const sid = String(sessionId);
    const messages = messagesFromRecords(snapshot?.records ?? []);
    const added = this.cache.addMany(sid, messages);
    for (const message of added) {
      this._broadcast({ type: 'message', sessionId: sid, message: toWireMessage(message) });
    }
  };

  _broadcast(frame) {
    if (this.clients.size === 0) return;
    const text = JSON.stringify(frame);
    for (const client of this.clients) {
      try { client.sendText(text); } catch (error) {
        this.log.warn(`events broadcast 失败: ${error.message}`);
      }
    }
  }

  /**
   * 接入一个 WS /events 客户端：先发 snapshot，再注册进广播集合。
   * @param {import('./ws-server.mjs').WsConnection} conn
   * @param {{sessionId?: string|null}} options
   */
  async addClient(conn, { sessionId = null } = {}) {
    let sid = this.followSessionIds[0];
    if (sessionId !== null && sessionId !== undefined && sessionId !== '') {
      const requested = String(sessionId);
      if (this.cfg.forbiddenSessionIds.includes(requested) || !this.isFollowed(requested)) {
        this.log.error(`EVENTS RED-LINE: 客户端请求 session=${requested}，拒绝（不在 followSessionIds 或属红线会话）`);
        conn.sendJson({
          type: 'error',
          code: 'forbidden-session',
          message: `session ${requested} 不在 followSessionIds 内（红线保护）`,
        });
        conn.close(1008, 'forbidden session');
        return;
      }
      sid = requested;
    }

    let snapshotMessages = [];
    try {
      const result = await this.history.getHistory({ sessionId: sid, limit: EVENTS_SNAPSHOT_LIMIT });
      snapshotMessages = result.messages;
    } catch (error) {
      this.log.warn(`events snapshot 取历史失败，退回运行期缓存: ${error.message}`);
      snapshotMessages = this.cache.list(sid).map(toWireMessage).slice(-EVENTS_SNAPSHOT_LIMIT);
    }
    // 拉历史期间可能又来了实时消息：用缓存补齐，保证 snapshot 不丢
    const knownIds = new Set(snapshotMessages.map((message) => message.id));
    const extra = this.cache.list(sid)
      .map(toWireMessage)
      .filter((message) => !knownIds.has(message.id));
    const merged = mergeMessages(snapshotMessages, extra).slice(-EVENTS_SNAPSHOT_LIMIT);

    conn.sendJson({ type: 'snapshot', sessionId: sid, messages: merged });
    conn.sendJson({
      type: 'status',
      sessionId: sid,
      running: this.running.get(sid) === true,
      busy: Boolean(this.busyGetter()),
    });
    this.clients.add(conn);
    const pingTimer = setInterval(() => {
      try { conn.sendJson({ type: 'ping', at: Date.now() }); } catch { /* ignore */ }
    }, EVENTS_PING_INTERVAL_MS);
    pingTimer.unref?.();
    conn.on('close', () => {
      clearInterval(pingTimer);
      this.clients.delete(conn);
      this.log.info(`ws /events 客户端-1（当前 ${this.clients.size}）`);
    });
    this.log.info(`ws /events 客户端+1（当前 ${this.clients.size}，session=${sid}，snapshot=${merged.length} 条）`);
  }

  get info() {
    return {
      clients: this.clients.size,
      followSessionIds: this.followSessionIds,
      cacheSize: this.cache.size,
      cacheBySession: Object.fromEntries(this.followSessionIds.map((sid) => [sid, this.cache.sessionSize(sid)])),
      running: Object.fromEntries(this.followSessionIds.map((sid) => [sid, this.running.get(sid) === true])),
      snapshotLimit: EVENTS_SNAPSHOT_LIMIT,
      pingIntervalMs: EVENTS_PING_INTERVAL_MS,
    };
  }
}
