// dsh-link/bridge/lib/messages.mjs — 会话消息提取/归一化/合并/分页（/history 与 WS /events 共用）。
//
// 数据来自 DSH 的 durable 会话事件（session/page 的 records、mux session/follow 的
// snapshot.records / 实时 event）。只取 user/message 与 assistant/message；
// 系统/工具事件不输出（协议要求 role 仅 user|assistant）。
//
// 消息 id 设计：`m-<seq>`（seq = 该消息事件在会话日志里的序号），
// 既稳定又可反解：/history 的 `before=<id>` 可换算成 session/page 的 beforeSeq。

const MESSAGE_EVENT_TYPES = new Set(['user/message', 'assistant/message']);
const MAX_TEXT_CHARS = 200000;

/** epoch 数字可能是秒/毫秒；字符串按 ISO 解析。统一返回毫秒或 null。 */
export function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return Math.round(value > 1e12 ? value : value * 1000);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** ContentBlock[] -> 纯文本（只取 text block，保留块间换行）。 */
export function blocksToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

const ROLE_CARD_HEAD = '【角色卡（长期设定';
const USER_MESSAGE_MARKER = '【用户消息】\n';

/**
 * bridge 的角色卡注入把「角色卡 + 用户消息」拼成一条 user/message；
 * 面板展示时剥掉角色卡外壳，只留用户原文（避免历史里出现 4000 字设定）。
 */
export function stripRoleCardEnvelope(text) {
  if (!text.startsWith(ROLE_CARD_HEAD)) return text;
  const index = text.lastIndexOf(USER_MESSAGE_MARKER);
  return index >= 0 ? text.slice(index + USER_MESSAGE_MARKER.length) : text;
}

/**
 * 从一条 durable 事件提取消息；不是「可展示的」user/assistant 消息则返回 null。
 *
 * 实测 user/message 的 data 形状：`{ content: ContentBlock[], source: {kind, rpcId}, role, id }`。
 * `source.kind`：
 *   - 'user'             → 真实用户输入（本机 Coo / bridge /say / 服务器 Web UI / 外部客户端）
 *   - 'runtime-context'  → DSH 每轮注入的运行时上下文（working dir / 时间 / 记忆预取等）
 *   - 'plugin:*'         → 插件注入（如 plugin:hindsight 的召回知识）
 * 面板只要真实用户消息，注入类一律不进历史（否则会被几千字系统提示刷屏）。
 * assistant 的 data.message.content 里可能只有 reasoning/tool-call，没有 text 时也不返回。
 *
 * @param {object} event DSH session event（含 seq/time/data）
 * @param {{currentTurn?: number}} context 当前 turn（assistant 消息归属用）
 */
export function messageFromEvent(event, context = {}) {
  if (!event || typeof event !== 'object' || !MESSAGE_EVENT_TYPES.has(event.type)) return null;
  const data = event.data ?? {};
  const role = event.type === 'user/message' ? 'user' : 'assistant';
  if (role === 'user') {
    const sourceKind = data.source?.kind;
    if (typeof sourceKind === 'string' && sourceKind.length > 0 && sourceKind !== 'user') return null;
  }
  let text = blocksToText(data.message?.content) || blocksToText(data.content);
  if (!text && typeof data.text === 'string') text = data.text;
  if (role === 'user') text = stripRoleCardEnvelope(text);
  if (!text.trim()) return null; // 纯工具调用/空消息/注入上下文不返回
  const seq = Number.isSafeInteger(event.seq) ? event.seq : null;
  const at = toMillis(event.time) ?? toMillis(data.time) ?? Date.now();
  const turnValue = Number.isFinite(data.turn) ? data.turn : context.currentTurn;
  const id = seq !== null ? `m-${seq}` : `m-${role}-${at}-${text.length}`;
  return {
    id,
    role,
    text: text.slice(0, MAX_TEXT_CHARS),
    at,
    ...(Number.isFinite(turnValue) ? { turn: turnValue } : {}),
    seq,
  };
}

/** 从 records（[{type:'event',event}] 或事件数组）提取消息，顺带跟踪 turn 归属。 */
export function messagesFromRecords(records) {
  if (!Array.isArray(records)) return [];
  const messages = [];
  let currentTurn = null;
  for (const record of records) {
    const event = record && typeof record === 'object' && record.type === 'event' && record.event
      ? record.event
      : record;
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'turn/start' && Number.isFinite(event.data?.turn)) currentTurn = event.data.turn;
    const message = messageFromEvent(event, { currentTurn });
    if (message) messages.push(message);
  }
  return messages;
}

const sortKey = (message) => [Number.isFinite(message.at) ? message.at : 0, Number.isFinite(message.seq) ? message.seq : -1];

function compareMessages(left, right) {
  const [leftAt, leftSeq] = sortKey(left);
  const [rightAt, rightSeq] = sortKey(right);
  return leftAt - rightAt || leftSeq - rightSeq;
}

/** 去重（按 id）并按时间/序号排序（旧→新）。 */
export function mergeMessages(...lists) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (!message || typeof message !== 'object' || typeof message.id !== 'string') continue;
      if (!byId.has(message.id)) byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(compareMessages);
}

/** 从消息 id 反解 seq（`m-123` / 纯数字）；失败返回 null。 */
export function seqFromMessageId(id) {
  if (typeof id === 'number' && Number.isInteger(id) && id >= 0) return id;
  if (typeof id !== 'string') return null;
  const match = id.trim().match(/^m-(\d+)$/) ?? id.trim().match(/^(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** 输出给面板的字段（协议 §1；去掉内部 seq）。 */
export function toWireMessage(message) {
  const out = { id: message.id, role: message.role, text: message.text, at: message.at };
  if (Number.isFinite(message.turn)) out.turn = message.turn;
  return out;
}

/**
 * 分页（旧→新返回最后 limit 条，before 为「返回更早消息」的游标）。
 * @returns {{messages:Array, hasMore:boolean, nextBefore:string|null}}
 */
export function paginateMessages({ messages = [], limit = 100, before = null } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  const sorted = mergeMessages(messages);
  let end = sorted.length;
  if (before !== null && before !== undefined && before !== '') {
    const index = sorted.findIndex((message) => message.id === before);
    if (index >= 0) {
      end = index;
    } else {
      const seq = seqFromMessageId(before);
      if (seq !== null) {
        const seqIndex = sorted.findIndex((message) => Number.isFinite(message.seq) && message.seq >= seq);
        end = seqIndex >= 0 ? seqIndex : sorted.length;
      }
    }
  }
  const start = Math.max(0, end - cap);
  const slice = sorted.slice(start, end);
  return {
    messages: slice.map(toWireMessage),
    hasMore: start > 0,
    nextBefore: start > 0 && slice.length > 0 ? slice[0].id : null,
  };
}

/**
 * 运行期消息滚动缓存（按会话分桶，按 id 去重，容量上限防内存膨胀）。
 * 用于 mux 实时事件 + 快照恢复历史。
 */
export class MessageCache {
  constructor({ maxPerSession = 1000 } = {}) {
    this.maxPerSession = Math.max(50, Number(maxPerSession) || 1000);
    this.bySession = new Map();
  }

  get size() {
    let total = 0;
    for (const bucket of this.bySession.values()) total += bucket.size;
    return total;
  }

  sessionSize(sessionId) {
    return this.bySession.get(String(sessionId))?.size ?? 0;
  }

  /** 加入一条消息；返回 true 表示新消息（用于广播去重）。 */
  add(sessionId, message) {
    if (!message || typeof message.id !== 'string') return false;
    const sid = String(sessionId);
    let bucket = this.bySession.get(sid);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(sid, bucket);
    }
    if (bucket.has(message.id)) return false;
    bucket.set(message.id, message);
    if (bucket.size > this.maxPerSession) {
      const ordered = [...bucket.values()].sort(compareMessages);
      const drop = ordered.slice(0, bucket.size - this.maxPerSession);
      for (const item of drop) bucket.delete(item.id);
    }
    return true;
  }

  addMany(sessionId, messages) {
    const added = [];
    for (const message of messages ?? []) {
      if (this.add(sessionId, message)) added.push(message);
    }
    return added;
  }

  list(sessionId) {
    return [...(this.bySession.get(String(sessionId))?.values() ?? [])].sort(compareMessages);
  }

  clear(sessionId) {
    if (sessionId === undefined) this.bySession.clear();
    else this.bySession.delete(String(sessionId));
  }
}
