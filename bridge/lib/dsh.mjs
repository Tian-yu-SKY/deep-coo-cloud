// dsh-link/bridge/lib/dsh.mjs — 服务器 DSH Web API 客户端（经 SSH 隧道）。
// 参考实现：qq-bridge/src/dsh-client.js（同一套 Cookie 铸造 / RPC 包装 / remote.mux 协议）。
// 只用 node 内置模块（全局 fetch / WebSocket / crypto）。
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const COOKIE_LIFETIME_MS = 60 * 60 * 1000;
// 每 55 分钟重铸（协议 §2.4）；铸造是纯本地 HMAC，提前换比撞 401 便宜。
const COOKIE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SECRET_BYTES = 32;
// 服务器与本机时钟可能有偏差（实测 2026-10-28 服务器慢约 274s）：
// DSH 校验 `issuedAt > now` 就拒绝，所以 Cookie 时间戳必须用「服务器时钟」。
const CLOCK_SENTINEL = '__BRIDGE_CLOCK_MS__';
const CLOCK_SAFETY_MARGIN_MS = 5000;
const CLOCK_REMEASURE_WINDOW_MS = 10 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** 旧 payload -> 新协议 { args } 包装。与 qq-bridge/dsh-client.js 的映射一致。 */
const METHOD_ARG_WRAPPERS = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/rename': 'request',
  'session/fork': 'request',
  'session/updateQueue': 'request',
  'session/page': 'request',
  'session/search': 'request',
  'session/follow': 'request',
  'session/projections': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
  'workspace/delete': 'request',
  'workspace/archiveSession': 'request',
  'workspace/insertBefore': 'request',
  'workspace/insertSessionBefore': 'request',
  'agentPresets/list': null,
  'settings/describe': null,
};

export function wrapArgs(method, payload) {
  const endpoint = method.replaceAll('.', '/');
  let body = payload ?? {};
  // 新版 SessionPromptRequest 强制要求 requestId（幂等去重）。
  if (endpoint === 'session/prompt' && typeof body.requestId !== 'string') {
    body = { ...body, requestId: randomUUID() };
  }
  const wrapper = METHOD_ARG_WRAPPERS[endpoint];
  if (wrapper === null) return { args: {} };
  if (wrapper === undefined) return { args: body };
  return { args: { [wrapper]: body } };
}

export class ApiError extends Error {
  constructor(code, message, details) {
    super(`${code ?? 'unknown'}: ${message ?? 'unknown error'}`);
    this.name = 'ApiError';
    this.code = code ?? 'unknown';
    this.detailMessage = message ?? 'unknown error';
    this.details = details;
  }
}

/** 服务器 DSH Web API 客户端：离线铸 Cookie + 一元 RPC。 */
export class DshClient {
  constructor({ cfg, ssh, log }) {
    this.cfg = cfg;
    this.ssh = ssh;
    this.log = log;
    this._secret = null;
    this._cookie = null;
    this._cookieMintedAtLocal = 0;
    this._cookieExpiresAt = 0; // 服务器时钟 epoch
    this._clockOffsetMs = 0; // 服务器时钟 - 本机时钟
    this._clockMeasuredAt = 0;
  }

  get authority() {
    return `127.0.0.1:${this.ssh.port}`;
  }

  get baseUrl() {
    return `http://${this.authority}`;
  }

  get cookieAgeMs() {
    return this._cookieMintedAtLocal ? Date.now() - this._cookieMintedAtLocal : null;
  }

  get clockOffsetMs() {
    return this._clockOffsetMs;
  }

  get clockMeasuredAt() {
    return this._clockMeasuredAt;
  }

  /** 估算的服务器当前时间（epoch ms，整数）。Cookie 的 issuedAt/expiresAt 都用它。
   *  DSH 校验 `Number.isSafeInteger(issuedAt)`，时间戳必须是整数。 */
  serverNow() {
    return Date.now() + Math.round(this._clockOffsetMs);
  }

  /** 经 SSH 往返测量服务器时钟偏差（取往返中点，误差 ±RTT/2；取整避免小数时间戳）。 */
  async measureClock() {
    const startedAt = Date.now();
    const output = await this.ssh.capture('date +%s%3N', { timeoutMs: 15000 });
    const finishedAt = Date.now();
    const remoteEpoch = Number.parseInt(output.trim(), 10);
    if (!Number.isFinite(remoteEpoch)) throw new Error(`无法解析服务器时钟输出: ${JSON.stringify(output.slice(0, 80))}`);
    this._clockOffsetMs = Math.round(remoteEpoch - (startedAt + finishedAt) / 2);
    this._clockMeasuredAt = Date.now();
    this.log.info(`服务器时钟偏差: ${this._clockOffsetMs}ms（正=服务器更快；rtt=${finishedAt - startedAt}ms）`);
    return this._clockOffsetMs;
  }

  /** 经 SSH 只读服务器 DSH 的持久化签名密钥；只在内存持有，不落盘。
   *  同一次 SSH 往返顺带测量服务器时钟偏差（避免额外一次连接）。 */
  async loadSecret({ force = false } = {}) {
    if (this._secret && !force) return this._secret;
    const remotePath = typeof this.cfg.remoteCredentialsPath === 'string' ? this.cfg.remoteCredentialsPath.trim() : '';
    if (!remotePath) {
      throw new Error('remoteCredentialsPath 未配置：请在 config.json 里填写远端 DSH 凭据文件路径（如 <remote-home>/.dsh/.credentials.yaml）');
    }
    const command = `cat ${remotePath}; printf '\\n${CLOCK_SENTINEL}\\n'; date +%s%3N`;
    const startedAt = Date.now();
    const text = await this.ssh.capture(command);
    const finishedAt = Date.now();
    const [credentialText = '', clockText = ''] = text.split(CLOCK_SENTINEL);
    const match = credentialText.match(/client-connection\/browser-session:[\s\S]{0,2000}?secret:\s*([A-Za-z0-9_-]+)/);
    if (!match) throw new Error('browser-session secret not found in server .credentials.yaml');
    const decoded = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    if (decoded.byteLength !== SECRET_BYTES) {
      throw new Error(`browser-session secret has unexpected length ${decoded.byteLength} (expect ${SECRET_BYTES})`);
    }
    const remoteEpoch = Number.parseInt(clockText.trim(), 10);
    if (Number.isFinite(remoteEpoch)) {
      this._clockOffsetMs = Math.round(remoteEpoch - (startedAt + finishedAt) / 2);
      this._clockMeasuredAt = Date.now();
      this.log.info(`服务器时钟偏差: ${this._clockOffsetMs}ms（正=服务器更快；rtt=${finishedAt - startedAt}ms）`);
    }
    this.log.addSecret(match[1]);
    this._secret = decoded;
    this.log.info('server browser-session secret loaded (in-memory only)');
    return decoded;
  }

  /** 离线铸 Cookie（authority 绑定当前隧道端口，端口自增后重新铸造）。
   *  时间戳用服务器时钟：DSH 会拒绝 issuedAt 在服务器未来时刻的 Cookie。 */
  async ensureCookie({ force = false } = {}) {
    const now = this.serverNow();
    if (!force && this._cookie && now < this._cookieExpiresAt - COOKIE_REFRESH_MARGIN_MS) return this._cookie;
    const secret = await this.loadSecret({ force });
    if (Date.now() - this._clockMeasuredAt > CLOCK_REMEASURE_WINDOW_MS) {
      try {
        await this.measureClock();
      } catch (error) {
        this.log.warn(`measureClock 失败（沿用旧偏差）: ${error.message}`);
      }
    }
    const authority = this.authority;
    const issuedAt = Math.round(this.serverNow() - CLOCK_SAFETY_MARGIN_MS);
    const expiresAt = issuedAt + COOKIE_LIFETIME_MS;
    const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
    const signature = b64url(createHmac('sha256', secret).update(body).digest());
    const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
    this._cookie = `${name}=v1.${body}.${signature}`;
    this._cookieMintedAtLocal = Date.now();
    this._cookieExpiresAt = expiresAt;
    this.log.debug(`cookie minted: authority=${authority} issuedAt=${issuedAt} expiresAt=${expiresAt} offsetMs=${Math.round(this._clockOffsetMs)} serverNow=${Math.round(this.serverNow())}`);
    return this._cookie;
  }

  invalidateCookie() {
    this._cookie = null;
    this._cookieExpiresAt = 0;
    this._cookieMintedAtLocal = 0;
    this._secret = null;
    // 保留时钟偏差估计；下次 loadSecret 会重新测量。
  }

  /** 一元 RPC：POST /api/<method>，信封 {type:'client-request', rpcId, method, payload:{args}}。 */
  async callUnary(method, payload = {}, { timeoutMs = 30000, allowRetry = true } = {}) {
    const endpoint = method.replaceAll('.', '/');
    const cookie = await this.ensureCookie();
    const rpcId = randomUUID();
    const envelope = { type: 'client-request', rpcId, method: endpoint, payload: wrapArgs(method, payload) };
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`DSH ${method} fetch failed: ${error.message}`);
    }
    if (response.status === 401 && allowRetry) {
      const unauthorizedBody = await response.text().catch(() => '');
      this.log.warn(`DSH ${method}: HTTP 401 (body=${JSON.stringify(unauthorizedBody.slice(0, 80))}), re-reading secret and re-minting cookie`);
      this.invalidateCookie();
      return this.callUnary(method, payload, { timeoutMs, allowRetry: false });
    }
    const text = await response.text();
    let full;
    try {
      full = JSON.parse(text);
    } catch {
      throw new Error(`DSH ${method} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }
    if (!full || full.type !== 'server-response' || full.rpcId !== rpcId || !full.result) {
      throw new Error(`invalid server-response for ${method} (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }
    const result = full.result;
    if (result.ok !== true) {
      const error = result.error ?? {};
      throw new ApiError(error.code, error.message, error.details);
    }
    return result.value;
  }

  async listSessions() {
    const value = await this.callUnary('session.list', { _request: {} }, { timeoutMs: 30000 });
    const items = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
    return items;
  }

  async createSession({ cwd, sessionId, agentPreset }) {
    const payload = { cwd };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    if (agentPreset !== undefined) payload.agentPreset = agentPreset;
    return this.callUnary('session.create', payload, { timeoutMs: 60000 });
  }

  async prompt({ sessionId, content, requestId, mode = 'queue' }) {
    return this.callUnary('session.prompt', {
      sessionId,
      mode,
      content,
      requestId,
    }, { timeoutMs: 30000 });
  }

  async archiveSession(sessionId) {
    return this.callUnary('workspace.archiveSession', { sessionId }, { timeoutMs: 30000 });
  }

  async agentPresetsList() {
    const value = await this.callUnary('agentPresets.list', {}, { timeoutMs: 30000 });
    return value?.presets ?? value ?? [];
  }
}

/**
 * remote.mux 事件流客户端：WebSocket /api/remote.mux + session/follow。
 * 帧格式（实测/源码确认）：{type:'item'|'end'|'error', streamId, value?, error?}；
 * item.value.type = 'snapshot' | 'event' | 'assistant-stream'。
 * 断线自动重连并重放 follow（跨重连保留 desired）。
 */
export class MuxFollower extends EventEmitter {
  constructor({ client, log, maxMessages = 10 }) {
    super();
    this.client = client;
    this.log = log;
    this.maxMessages = maxMessages;
    this.socket = null;
    this.opened = false;
    this.stopping = false;
    this.streams = new Map(); // streamId -> sessionId
    this.desired = new Map(); // sessionId -> { ready, waiters: [] }
    this.reconnectDelayMs = 1000;
    this._reconnectTimer = null;
    this.deltaCount = 0;
    this.frameStats = new Map(); // 统计 item.value.type / event.type，便于 Phase 0 取证
    // v2：历史定位用。snapshot.cursor / 事件 seq 都是「会话日志游标」，
    // session/page 需要 throughSeq，所以跟 stream 一起记录。
    this.cursors = new Map();
    this.lastSeqs = new Map();
  }

  /** 已知的会话日志游标（snapshot.cursor 与已收事件 seq 取最大）；未知返回 null。 */
  getCursor(sessionId) {
    const sid = String(sessionId);
    const candidates = [this.cursors.get(sid), this.lastSeqs.get(sid)]
      .filter((value) => Number.isFinite(value));
    return candidates.length > 0 ? Math.max(...candidates) : null;
  }

  async start() {
    this.stopping = false;
    await this._connect();
  }

  async _connect() {
    if (this.stopping) return;
    let cookie;
    try {
      cookie = await this.client.ensureCookie();
    } catch (error) {
      this.log.error(`mux auth failed: ${error.message}`);
      return this._scheduleReconnect();
    }
    const url = `${this.client.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`;
    let socket;
    try {
      // Node 24 的全局 WebSocket 支持第二参数 options.headers（已实测）。
      socket = new WebSocket(url, { headers: { cookie } });
    } catch (error) {
      this.log.error(`mux WebSocket ctor failed: ${error.message}`);
      return this._scheduleReconnect();
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.stopping) return;
      this.opened = true;
      this.reconnectDelayMs = 1000;
      this.log.info('mux connected');
      this.emit('mux-up');
      for (const sessionId of this.desired.keys()) this._sendOpen(sessionId);
    });
    socket.addEventListener('message', (event) => this._onFrame(event));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.opened = false;
      this.socket = null;
      this.streams.clear();
      for (const entry of this.desired.values()) entry.ready = false;
      this.emit('mux-down');
      if (this.stopping) return;
      this.log.warn('mux closed; reconnecting');
      this._scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // 细节不可得（handshake 失败等）；close 事件会随后触发重连。
    });
  }

  _scheduleReconnect() {
    if (this.stopping || this._reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
    this.log.warn(`mux reconnect in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect().catch((error) => this.log.error(`mux reconnect failed: ${error.message}`));
    }, delay);
  }

  _sendOpen(sessionId, maxMessages = null) {
    if (!this.opened || !this.socket || this.socket.readyState !== 1) return;
    for (const existing of this.streams.values()) if (existing === sessionId) return;
    const streamId = randomUUID();
    this.streams.set(streamId, sessionId);
    try {
      this.socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId },
              maxMessages: Number.isSafeInteger(maxMessages) && maxMessages > 0 ? maxMessages : this.maxMessages,
              assistantStream: true,
            },
          },
        },
      }));
    } catch (error) {
      this.streams.delete(streamId);
      this.log.error(`mux send open failed for ${sessionId}: ${error.message}`);
    }
  }

  /** 订阅一个会话的事件；返回 ready Promise（收到 snapshot 即 ready）。 */
  follow(sessionId) {
    const sid = String(sessionId);
    let entry = this.desired.get(sid);
    if (!entry) {
      entry = { ready: false, waiters: [] };
      this.desired.set(sid, entry);
    } else if (!entry.ready && ![...this.streams.values()].includes(sid)) {
      // 之前的 stream 已结束（session/not-found 等）：重新 open 一次。
      this._sendOpen(sid);
    }
    this._sendOpen(sid);
    return {
      unsubscribe: () => {
        this.desired.delete(sid);
        for (const [streamId, mapped] of [...this.streams.entries()]) {
          if (mapped === sid) this.streams.delete(streamId);
        }
      },
    };
  }

  waitReady(sessionId, timeoutMs = 15000) {
    const sid = String(sessionId);
    const entry = this.desired.get(sid);
    if (!entry) return Promise.resolve(false);
    if (entry.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      entry.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * 强制重新订阅一个会话并等待新的开场快照（稳定性兜底用）。
   * 用于：mux 断流重连后 / 一轮超时前，从 snapshot.records 里恢复本轮已落盘的文本。
   * @returns snapshot 值；超时或未连接时返回 null。
   */
  refresh(sessionId, timeoutMs = 10000, options = {}) {
    const sid = String(sessionId);
    if (!this.desired.has(sid)) this.desired.set(sid, { ready: false, waiters: [] });
    // 丢掉旧 stream 映射，强制重发 open（旧 stream 即使还在，其后续帧会被忽略）。
    for (const [streamId, mapped] of [...this.streams.entries()]) {
      if (mapped === sid) this.streams.delete(streamId);
    }
    const entry = this.desired.get(sid);
    if (entry) entry.ready = false;
    return new Promise((resolve) => {
      let settled = false;
      const onSnapshot = ({ sessionId: snapshotSession, snapshot }) => {
        if (snapshotSession !== sid || settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('snapshot', onSnapshot);
        this._markReady(sid);
        resolve(snapshot);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.off('snapshot', onSnapshot);
        resolve(null);
      }, timeoutMs);
      this.on('snapshot', onSnapshot);
      // 已连接则立即重发 open；未连接则等重连后 desired 重放自动触发。
      this._sendOpen(sid, options.maxMessages);
    });
  }

  _markReady(sessionId) {
    const entry = this.desired.get(sessionId);
    if (!entry) return;
    const waiters = entry.ready ? [] : entry.waiters.splice(0);
    entry.ready = true;
    for (const waiter of waiters) waiter();
  }

  _bumpStat(key) {
    this.frameStats.set(key, (this.frameStats.get(key) ?? 0) + 1);
  }

  _onFrame(event) {
    let message;
    try {
      if (typeof event.data !== 'string') return;
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string' || typeof message.streamId !== 'string') return;
    const sessionId = this.streams.get(message.streamId);
    if (!sessionId) return;

    if (message.type === 'item') {
      const value = message.value;
      if (!value || typeof value !== 'object') return;
      if (value.type === 'snapshot') {
        this._bumpStat('snapshot');
        if (Number.isFinite(value.cursor)) this.cursors.set(sessionId, value.cursor);
        this._markReady(sessionId);
        this.emit('snapshot', { sessionId, snapshot: value });
      } else if (value.type === 'event') {
        const eventType = value.event?.type ?? 'unknown';
        this._bumpStat(`event:${eventType}`);
        const seq = value.event?.seq;
        if (Number.isFinite(seq)) this.lastSeqs.set(sessionId, Math.max(this.lastSeqs.get(sessionId) ?? -1, seq));
        this.emit('event', { sessionId, event: value.event });
      } else if (value.type === 'assistant-stream') {
        this._bumpStat('assistant-stream');
        this.emit('assistant-stream', { sessionId, frame: value.frame });
      } else {
        this._bumpStat(`item:${value.type}`);
      }
      return;
    }

    if (message.type === 'end') {
      this.streams.delete(message.streamId);
      this.log.warn(`mux follow stream ended for ${sessionId}`);
      const entry = this.desired.get(sessionId);
      if (entry) {
        entry.ready = false;
        setTimeout(() => {
          if (!this.stopping && this.desired.has(sessionId)) this._sendOpen(sessionId);
        }, 2000);
      }
      this.emit('stream-end', { sessionId });
      return;
    }

    if (message.type === 'error') {
      this.streams.delete(message.streamId);
      this.log.error(`mux stream error for ${sessionId}: ${message.error?.code} ${message.error?.message}`);
      this.emit('stream-error', { sessionId, error: message.error });
    }
  }

  stop() {
    this.stopping = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    this.opened = false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 发送一轮 prompt 并收集 assistant 文本（v1.1 稳定性加固）。
 * - 流式 delta：优先 durable 事件 assistant/chunk（rc.3+），否则 assistant-stream 帧（rc.2 实测）。
 * - 最终文本：assistant/message 的 content[].text 拼接；为空时回退 delta 累积。
 * - 断流：mux 断开重连期间**不立即失败**；重连/强制重订阅后从 snapshot.records 恢复本轮已落盘文本。
 * - prompt 投递失败（未 accepted）自动重试 1 次（同一 requestId，DSH 幂等去重）。
 * - 只有整轮超过 requestTimeoutMs 才最终失败；失败前再抢一次快照，能捞到文本就按 partial 返回。
 * @returns {text, turn, reason, deltaCount, durableDeltas, streamDeltas, recovered, partial, promptAttempts}
 */
export async function runTurn({ client, follower, log, sessionId, text, requestId, timeoutMs = 240000, onDelta, promptRetryDelayMs = 1200 }) {
  const sid = String(sessionId);
  follower.follow(sid);
  let ready = await follower.waitReady(sid, 8000);
  if (!ready) {
    log.warn(`mux follow not ready for ${sid}; retry open once`);
    follower.follow(sid);
    ready = await follower.waitReady(sid, 12000);
  }
  if (!ready) {
    throw Object.assign(new Error('mux session/follow 未就绪（未收到 snapshot），拒绝发送 prompt 以免丢流'), { code: 'stream-not-ready' });
  }

  return new Promise((resolve, reject) => {
    let ourTurn = null;
    let textFromMessage = '';
    let textFromDurableDelta = '';
    let textFromStreamDelta = '';
    let durableDeltaCount = 0;
    let streamDeltaCount = 0;
    let settled = false;
    let promptAttempts = 0;
    let recovered = false;
    let refreshing = null;
    let timer = null;
    let watchdog = null;
    let lastEventAt = Date.now();

    const finalText = () => textFromMessage || textFromDurableDelta || textFromStreamDelta;

    const cleanup = () => {
      follower.off('event', onEvent);
      follower.off('assistant-stream', onAssistantStream);
      follower.off('stream-error', onStreamError);
      follower.off('snapshot', onSnapshot);
      follower.off('mux-up', onMuxUp);
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const result = (extra = {}) => ({
      text: finalText(),
      turn: ourTurn,
      reason: extra.reason ?? null,
      deltaCount: durableDeltaCount || streamDeltaCount,
      durableDeltas: durableDeltaCount,
      streamDeltas: streamDeltaCount,
      recovered,
      partial: false,
      promptAttempts,
      ...extra,
    });

    /** 从 session/follow 的开场快照恢复本 turn 的文本（断流/超时兜底）。 */
    const recoverFromSnapshot = (snapshot) => {
      try {
        const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
        const events = records
          .map((record) => record?.event ?? record)
          .filter((event) => event && typeof event.type === 'string');
        if (events.length === 0) return false;
        let lastStartedTurn = null;
        for (const event of events) {
          if (event.type === 'turn/start') lastStartedTurn = event.data?.turn ?? lastStartedTurn;
        }
        if (ourTurn === null && lastStartedTurn !== null) ourTurn = lastStartedTurn;
        if (ourTurn === null) return false;
        let snapshotText = '';
        let ended = false;
        for (const event of events) {
          const turn = event.data?.turn;
          if (turn !== undefined && turn !== ourTurn) continue;
          if (event.type === 'assistant/message') {
            for (const block of event.data?.message?.content ?? []) {
              if (block?.type === 'text' && typeof block.text === 'string') snapshotText += block.text;
            }
          }
          if (event.type === 'turn/end') ended = true;
        }
        if (snapshotText.length > textFromMessage.length) {
          textFromMessage = snapshotText;
          recovered = true;
          log.info(`快照恢复本轮文本: session=${sid} chars=${snapshotText.length} turn=${ourTurn}`);
        }
        if (ended) {
          log.info(`快照显示本轮已结束（turn/end），直接收尾: session=${sid}`);
          finish(null, result({ reason: { kind: 'completed' }, recovered: true }));
          return true;
        }
        return snapshotText.length > 0;
      } catch (error) {
        log.warn(`快照恢复解析失败: ${error.message}`);
        return false;
      }
    };

    /** 强制重新 follow + 用最新快照恢复；并发调用合并。 */
    const refreshAndRecover = (label) => {
      if (settled) return Promise.resolve(false);
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          const snapshot = await follower.refresh(sid, 10000);
          if (!snapshot) {
            log.warn(`refresh 未拿到快照（${label}，session=${sid}）`);
            return false;
          }
          return recoverFromSnapshot(snapshot);
        } catch (error) {
          log.warn(`refresh 失败（${label}）: ${error.message}`);
          return false;
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    };

    const onEvent = ({ sessionId: eventSession, event }) => {
      if (eventSession !== sid || !event || typeof event.type !== 'string' || settled) return;
      lastEventAt = Date.now();
      const data = event.data ?? {};
      if (event.type === 'turn/start') {
        if (ourTurn === null) {
          ourTurn = data.turn;
          log.info(`turn/start 已到（session=${sid} turn=${ourTurn}）`);
        }
        return;
      }
      if (ourTurn === null || data.turn !== ourTurn) return;
      if (event.type === 'assistant/chunk') {
        const chunk = data.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          textFromDurableDelta += chunk.text;
          durableDeltaCount += 1;
          if (onDelta) onDelta(chunk.text);
        }
        return;
      }
      if (event.type === 'assistant/message') {
        for (const block of data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') textFromMessage += block.text;
        }
        return;
      }
      if (event.type === 'turn/end') {
        finish(null, result({ reason: data.reason ?? null }));
      }
    };

    const onAssistantStream = ({ sessionId: eventSession, frame }) => {
      if (eventSession !== sid || !frame || settled) return;
      lastEventAt = Date.now();
      if (ourTurn === null || frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        textFromStreamDelta += chunk.text;
        streamDeltaCount += 1;
        // durable 通道没有 delta 时才用 stream 通道回放，避免重复推给客户端。
        if (durableDeltaCount === 0 && onDelta) onDelta(chunk.text);
      }
    };

    const onStreamError = ({ sessionId: errorSession, error }) => {
      if (errorSession !== sid || settled) return;
      // 单条 follow 流报错不直接判死整轮：交给 refresh / 超时兜底（服务器重启时常见）。
      log.warn(`mux stream error（继续等待恢复）: session=${sid} ${error?.code}: ${error?.message}`);
    };

    const onSnapshot = ({ sessionId: snapshotSession, snapshot }) => {
      if (snapshotSession !== sid || settled) return;
      log.info(`收到重连快照，尝试恢复本轮（session=${sid}）`);
      recoverFromSnapshot(snapshot);
    };

    const onMuxUp = () => {
      if (settled) return;
      log.warn(`mux 已重连，强制重订阅并尝试恢复本轮（session=${sid}）`);
      setTimeout(() => { refreshAndRecover('mux-up').catch(() => {}); }, 500);
    };

    /** prompt 投递：失败自动重试 1 次（同一 requestId，DSH 幂等去重）。 */
    const deliverPrompt = async () => {
      promptAttempts += 1;
      try {
        await client.prompt({ sessionId: sid, content: [{ type: 'text', text }], requestId, mode: 'queue' });
      } catch (error) {
        if (promptAttempts >= 2) {
          throw Object.assign(new Error(`prompt 投递失败（已重试 1 次）: ${error.message}`), { code: 'prompt-delivery-failed' });
        }
        log.warn(`prompt 投递失败，${promptRetryDelayMs}ms 后重试 1 次: ${error.message}`);
        await sleep(promptRetryDelayMs);
        await deliverPrompt();
      }
    };

    follower.on('event', onEvent);
    follower.on('assistant-stream', onAssistantStream);
    follower.on('stream-error', onStreamError);
    follower.on('snapshot', onSnapshot);
    follower.on('mux-up', onMuxUp);

    // 整轮硬超时：失败前最后抢一次快照（能捞到文本就按 partial 返回）。
    timer = setTimeout(async () => {
      if (settled) return;
      log.warn(`turn 达到 requestTimeout=${timeoutMs}ms，最后尝试快照恢复（session=${sid}，当前=${finalText().length}字）`);
      try { await refreshAndRecover('timeout'); } catch { /* ignore */ }
      if (settled) return;
      if (finalText().length > 0) {
        finish(null, Object.assign(result({ reason: { kind: 'recovered-at-timeout' }, recovered: true }), { partial: true }));
      } else {
        finish(Object.assign(new Error(`turn 超时且事件流已丢失（session=${sid}，promptAttempts=${promptAttempts}）`), { code: 'stream-lost' }));
      }
    }, timeoutMs);

    // 看门狗：mux 断开或长时间无事件时主动重订阅+快照恢复（不判死）。
    watchdog = setInterval(() => {
      if (settled) return;
      const idleMs = Date.now() - lastEventAt;
      if (!follower.opened && idleMs > 15000) {
        refreshAndRecover('watchdog-mux-down').catch(() => {});
      } else if (idleMs > 45000) {
        log.warn(`turn ${Math.round(idleMs / 1000)}s 无事件，主动重订阅尝试恢复（session=${sid}）`);
        refreshAndRecover('watchdog-idle').catch(() => {});
      }
    }, 15000);
    watchdog.unref?.();

    deliverPrompt().catch((error) => finish(error));
  });
}

