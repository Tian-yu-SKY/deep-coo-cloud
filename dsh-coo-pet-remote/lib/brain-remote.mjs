/**
 * 桌宠的大脑(远程 bridge 版):她的对话跑在**服务器 DSH** 的 `pet-local` 会话里,
 * 本机这只 Coo 只负责显示气泡——这样角色卡、记忆(deep-soul 的 mind.db)、心情
 * 全都是服务器那一份,和 QQ 里的她是同一个她。
 *
 * 和另外两个后端的区别:
 * - `brain.mjs`(PetBrain)     插件内自己维护上下文,只调 `ctx.llm`——轻,但她是「第三个她」;
 * - `brain-session.mjs`       本机 DSH 的一个独立会话——本机大脑,同样不是服务器那个;
 * - `brain-remote.mjs`(这里)   只当**前端**:说一句 → 本机 bridge 的 WebSocket `/chat` →
 *                              bridge 经 SSH 隧道丢给服务器 DSH 的 pet-local 会话 →
 *                              把流式回复原样收回来。
 *
 * 接口和上面两个保持一致(`busy` / `history` / `sessionId` / `say` / `forget` / `stop`),
 * 所以 `impl.js` 选后端时只换工厂函数,上层流程一行都不用动。
 *
 * 协议:v1,见 `dsh-link/BRIDGE-PROTOCOL.md` §4 的 WS `/chat?token=...`:
 *   客户端 → bridge: {type:'say', requestId, text}
 *   bridge → 客户端(按序): {type:'accepted', requestId}
 *                          {type:'delta', requestId, text}      增量,客户端自己累积
 *                          {type:'final', requestId, text}      完整回复
 *                         /{type:'error', requestId, code, message}
 * 同一条连接串行:上一个 requestId 没 final 之前不受理新的 say(本插件这边先用
 * `busy` 挡住,免得把主人的话丢半句)。
 *
 * 两个必须记住的点:
 * 1. **不写死「连一次就完事」**:bridge 会随本机 SSH 隧道断开/重连,所以这里维持
 *    一条长连接,断了就按指数退避自己接回去(上限 30 秒,和 bridge 的隧道重连一个量级);
 *    下一句 `say` 也会主动发起一次连接,不用等退避定时器。
 * 2. **token 是懒读的**:DSH 桌面端常常比 bridge 先起来,插件挂载那一刻
 *    `bridge/token.txt` 可能还不存在。`bridgeToken` 可以传字符串,也可以传
 *    一个「每次连接时现取」的函数(impl.js 传的是读文件的函数)。
 */
import { randomUUID } from 'node:crypto';

/** bridge 默认地址(协议 v1 的本地 HTTP/WS 端口)。 */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47891';
/** 服务器上给这只桌宠用的会话 id(bridge 的 config.json 里也是它)。 */
export const DEFAULT_BRIDGE_SESSION_ID = 'pet-local';
/** 一轮最多等多久:服务器 agent 要想、要调记忆工具,给得比 bridge 的 requestTimeoutMs 略宽一点。 */
const DEFAULT_TIMEOUT_MS = 240_000;
/** 建连最多等多久:bridge 就在 127.0.0.1,真要慢也是它没起来,别让主人干等。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
/** 断线重连退避:从 500ms 翻倍到 30s(和协议里 SSH 隧道的上限一致)。 */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** 本地只留最近这么多句给 `pet_status` 看个数——真正的记忆在服务器。 */
const HISTORY_KEEP = 40;
/** 远程大脑也给了空回复时的兜底台词(和另外两个后端一致)。 */
const NO_REPLY = '(人家张了张嘴,没说出话来……)';
/** 心情自动刷新间隔(默认 60 秒;配置 `moodIntervalMs` 可改,0 = 不自动刷新)。 */
const DEFAULT_MOOD_INTERVAL_MS = 60_000;
/** 单次 `GET /mood` 超时(默认 5 秒;bridge 只读本地 SQLite,正常是毫秒级)。 */
const DEFAULT_MOOD_TIMEOUT_MS = 5_000;

/**
 * 把 bridge 地址规整成 HTTP(S) 根地址 —— `GET /mood` 走这里。
 *
 * `brain-remote` 的聊天走 WS(`chatUrlOf`),但心情是普通 HTTP GET;
 * 两者共用同一个 `bridgeUrl` 配置,只是协议头不同。
 *
 * @param {string} bridgeUrl 例:`http://127.0.0.1:47891` / `ws://...`
 * @returns {string} 例:`http://127.0.0.1:47891`
 */
export function httpBaseOf(bridgeUrl) {
  const raw = String(bridgeUrl ?? '').trim() || DEFAULT_BRIDGE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`bridgeUrl 不是合法地址:${raw}`);
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`bridgeUrl 只支持 http/https/ws/wss:${raw}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * 把配置里的 bridge 地址拼成 `/chat` 的 WebSocket URL。
 *
 * 接受 `http://host:port`、`https://...`、`ws://...`、`wss://...`;
 * 地址里带的 path 会保留(bridge 以后若挂在子路径下也不用改这里)。
 *
 * @param {string} bridgeUrl 例:`http://127.0.0.1:47891`
 * @param {string} [token] bridge 的本地 token
 * @returns {string} 例:`ws://127.0.0.1:47891/chat?token=abc`
 */
export function chatUrlOf(bridgeUrl, token = '') {
  const raw = String(bridgeUrl ?? '').trim() || DEFAULT_BRIDGE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`bridgeUrl 不是合法地址:${raw}`);
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`bridgeUrl 只支持 http/https/ws/wss:${raw}`);
  }
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = `${base}/chat`;
  url.search = '';
  url.hash = '';
  const t = String(token ?? '').trim();
  if (t) url.searchParams.set('token', t);
  return url.toString();
}

export class RemoteBrain {
  /**
   * @param {object} opts
   * @param {string} [opts.bridgeUrl] bridge 的 HTTP 地址(默认 127.0.0.1:47891)
   * @param {string | (() => string)} [opts.bridgeToken] bridge 的 token;函数形式每次连接时现取
   * @param {string} [opts.sessionId] 服务器上的会话 id(只用于显示,默认 pet-local)
   * @param {number} [opts.timeoutMs] 一轮最多等多久
   * @param {number} [opts.connectTimeoutMs] 建连最多等多久
   * @param {number} [opts.reconnectMinMs] 重连退避起点(测试用)
   * @param {number} [opts.reconnectMaxMs] 重连退避上限
   * @param {(text: string) => void} [opts.onDelta] 收到流式增量时回调(参数是**累积后的全文**)
   * @param {number} [opts.moodIntervalMs] 心情自动刷新间隔(默认 60000;0 = 不自动刷新)
   * @param {number} [opts.moodTimeoutMs] 单次 `GET /mood` 超时(默认 5000)
   * @param {(mood: object) => void} [opts.onMood] 心情刷新成功时回调
   * @param {(line: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    this.bridgeUrl = String(opts.bridgeUrl ?? '').trim() || DEFAULT_BRIDGE_URL;
    this.bridgeToken = opts.bridgeToken ?? '';
    this.sessionId = String(opts.sessionId ?? opts.bridgeSessionId ?? '').trim() || DEFAULT_BRIDGE_SESSION_ID;
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnectMinMs = Number(opts.reconnectMinMs) > 0 ? Number(opts.reconnectMinMs) : RECONNECT_MIN_MS;
    this.reconnectMaxMs = Number(opts.reconnectMaxMs) > 0 ? Number(opts.reconnectMaxMs) : RECONNECT_MAX_MS;
    const moodInterval = Number(opts.moodIntervalMs);
    this.moodIntervalMs = Number.isFinite(moodInterval) ? Math.max(0, moodInterval) : DEFAULT_MOOD_INTERVAL_MS;
    this.moodTimeoutMs = Number(opts.moodTimeoutMs) > 0 ? Number(opts.moodTimeoutMs) : DEFAULT_MOOD_TIMEOUT_MS;
    this.onDelta = opts.onDelta;
    this.onMood = opts.onMood;
    this.log = opts.log ?? (() => {});

    /**
     * 最近一次 `GET /mood` 拿到的心情快照(bridge 不可用 / 还没刷到时是 null)。
     * 只读缓存:刷新失败**保留旧值**,让桌宠状态至少不会忽然变成「未知」。
     */
    this.mood = null;
    this.moodFetchedAt = null;
    this.moodLastError = null;
    /** 正在跑的那次刷新(并发调用合并成一次)。 */
    this.moodFetching = null;
    /** 自动刷新的 interval。 */
    this.moodTimer = null;
    /** 正在跑的那次刷新的 AbortController(stop 时要掐掉)。 */
    this.moodAbort = null;

    /** 最近几轮,只为 `pet_status` 显示个数;真正的记忆在服务器,不在本机。 */
    this.history = [];
    /** 上一句还没说完时不接新的。 */
    this.busy = false;
    /** 当前这条 WebSocket(没连上时是 null)。 */
    this.ws = null;
    /** 正在建连的 promise(并发 say 共用同一次连接)。 */
    this.opening = null;
    /** 退避重连定时器。 */
    this.reconnectTimer = null;
    this.backoffMs = this.reconnectMinMs;
    /** 正在等 final 的那一句。 */
    this.pending = null;
    /** 最近一次错误,给 pet_status 显示。 */
    this.lastError = null;
    this.stopped = false;
    this.everConnected = false;
    // 心情是「锦上添花」:不阻塞挂载,启动就刷一次,之后按 moodIntervalMs 刷。
    this.startMoodLoop();
  }

  /** bridge 的 WS 现在通着吗。 */
  get connected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  /* ---------- 心情(bridge v1.1 的 GET /mood) ---------- */

  /**
   * 开始自动刷新心情(幂等;`moodIntervalMs = 0` 表示只手动刷)。
   *
   * 启动**立刻**刷一次、再按间隔刷:否则 `pet_status` 前 60 秒都是「未知」。
   * 定时器 `unref`,不拖住 DSH 退出;失败是静默的(见 refreshMood),所以 bridge 没起来时
   * 只会每 60 秒白试一次,不打扰聊天。
   */
  startMoodLoop() {
    if (this.stopped || this.moodTimer || this.moodIntervalMs <= 0) return;
    this.moodTimer = setInterval(() => {
      void this.refreshMood();
    }, this.moodIntervalMs);
    this.moodTimer.unref?.();
    void this.refreshMood();
  }

  /** 停掉自动刷新(stop 时调用;也方便测试)。 */
  stopMoodLoop() {
    if (this.moodTimer) {
      clearInterval(this.moodTimer);
      this.moodTimer = null;
    }
  }

  /**
   * 刷一次心情快照:普通 HTTP `GET <bridgeUrl>/mood`。
   *
   * **永不 reject**:超时/网络错/非 JSON/格式不对时保留旧 `mood` 并在 `moodLastError`
   * 里记原因(日志只留一行,不刷屏)。并发调用合并成同一次请求。
   *
   * @returns {Promise<object | null>} 成功返回新快照;失败返回**当前**快照(可能是旧值/null)
   */
  refreshMood() {
    if (this.stopped) return Promise.resolve(this.mood);
    if (this.moodFetching) return this.moodFetching;
    const run = this.fetchMoodOnce().finally(() => {
      if (this.moodFetching === run) this.moodFetching = null;
    });
    this.moodFetching = run;
    return run;
  }

  /** @returns {Promise<object | null>} 单次 GET /mood(失败返回旧值,不抛) */
  async fetchMoodOnce() {
    let url;
    try {
      url = `${httpBaseOf(this.bridgeUrl)}/mood`;
    } catch (err) {
      this.moodLastError = String(err?.message ?? err);
      this.log(`[心情] bridgeUrl 有问题,读不了心情:${this.moodLastError}`);
      return this.mood;
    }
    const abort = new AbortController();
    this.moodAbort = abort;
    const timer = setTimeout(() => abort.abort(), this.moodTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: abort.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        this.moodLastError = `HTTP ${res.status}`;
        this.log(`[心情] bridge 暂时给不出心情(${this.moodLastError}),继续用上一次的`);
        return this.mood;
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        this.moodLastError = '返回的不是 JSON';
        this.log(`[心情] bridge 的 /mood 不是 JSON,继续用上一次的`);
        return this.mood;
      }
      const next = body && typeof body === 'object' ? body.mood : null;
      if (!next || typeof next !== 'object') {
        // bridge 明确说没有(deep-soul 没数据)或格式不对:保留旧值,不算成功
        this.moodLastError = String(body?.error ?? 'bridge 没有心情数据');
        this.log(`[心情] ${this.moodLastError}`);
        return this.mood;
      }
      this.mood = { ...next };
      this.moodFetchedAt = Date.now();
      this.moodLastError = null;
      try {
        this.onMood?.(this.mood);
      } catch (err) {
        this.log(`onMood 回调出错:${err?.message ?? err}`);
      }
      return this.mood;
    } catch (err) {
      this.moodLastError = abort.signal.aborted ? '超时' : String(err?.message ?? err);
      this.log(`[心情] 暂时读不到(${this.moodLastError}),继续用上一次的`);
      return this.mood;
    } finally {
      clearTimeout(timer);
      if (this.moodAbort === abort) this.moodAbort = null;
    }
  }

  /** @returns {string} 当前要带的 token(每次现取,读到就记住) */
  token() {
    try {
      const raw = typeof this.bridgeToken === 'function' ? this.bridgeToken() : this.bridgeToken;
      return String(raw ?? '').trim();
    } catch (err) {
      this.log(`读 bridge token 失败:${err?.message ?? err}`);
      return '';
    }
  }

  /** @returns {string} 这次连接用的 WebSocket URL */
  url() {
    return chatUrlOf(this.bridgeUrl, this.token());
  }

  /**
   * 拿到一条可用的连接;没有就连。
   *
   * 已经连上 → 立刻返回;正在连 → 一起等;没连 → 马上发起一次(不用等退避定时器,
   * 主人刚刚开口,这时候干等 30 秒是最难受的)。
   */
  async ensureConnected() {
    if (this.stopped) throw new Error('桌宠的远程大脑已经停了(插件被卸载了?)');
    if (this.connected) return;
    // 主动连的时候取消正在排队的退避重连,免得同一时刻开两条
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.opening) this.startConnect();
    try {
      await this.opening;
    } catch (err) {
      throw this.connectionError(err);
    }
    if (!this.connected) throw this.connectionError(new Error('刚连上就断了'));
  }

  /**
   * 发起一次连接,把 promise 记在 `this.opening` 上。
   * 失败时 **不在这里吞掉**:`ensureConnected` 会把它翻成给主人看的话;
   * 后台重连路径则自己 `.catch` 掉。
   */
  startConnect() {
    let promise;
    try {
      promise = this.connectOnce();
    } catch (err) {
      promise = Promise.reject(err);
    }
    this.opening = promise;
    const clear = () => {
      if (this.opening === promise) this.opening = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** 真正建一条 WebSocket;open 就 resolve,失败就 reject 并排上重连。 */
  connectOnce() {
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      let timer = null;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (err) {
          this.lastError = String(err?.message ?? err);
          reject(err);
        } else {
          this.backoffMs = this.reconnectMinMs;
          this.lastError = null;
          resolve();
        }
      };

      let url;
      try {
        url = this.url();
      } catch (err) {
        settle(err);
        this.scheduleReconnect();
        return;
      }
      if (typeof WebSocket !== 'function') {
        settle(new Error('这个 node 没有内置 WebSocket(需要 node >= 22.13)'));
        return;
      }

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        settle(new Error(`建 WebSocket 失败:${err?.message ?? err}`));
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;
      const drop = () => {
        if (this.ws === ws) this.ws = null;
      };

      timer = setTimeout(() => {
        drop();
        try {
          ws.close();
        } catch {
          /* 可能是还在 CONNECTING,关不掉就由 GC 收 */
        }
        settle(new Error(`${Math.round(this.connectTimeoutMs / 1000)} 秒没连上`));
        this.scheduleReconnect();
      }, this.connectTimeoutMs);

      ws.addEventListener('open', () => {
        opened = true;
        this.everConnected = true;
        this.log(`远程大脑已连上 bridge:${this.bridgeUrl}`);
        settle(null);
      });
      ws.addEventListener('message', (ev) => {
        try {
          this.onFrame(ev);
        } catch (err) {
          this.log(`处理 bridge 帧出错:${err?.message ?? err}`);
        }
      });
      ws.addEventListener('error', () => {
        // WebSocket 规范里 error 之后一定跟一个 close;真正的收尾在 close 里做,
        // 这里只把原因记下来,好让主人看到的是「连接被拒」而不是「断了」。
        if (!opened) this.lastError = this.lastError ?? '连接被拒绝(检查 bridge 是否在跑、token 对不对)';
      });
      ws.addEventListener('close', (ev) => {
        drop();
        clearTimeout(timer);
        timer = null;
        const code = Number(ev?.code) || 0;
        if (!opened) {
          const reason = this.lastError && this.lastError !== '连上又断了' ? `:${this.lastError}` : '';
          settle(new Error(`连接被关上(code=${code || '?'})${reason}`));
          this.scheduleReconnect();
          return;
        }
        if (this.stopped) {
          settle(null);
          return;
        }
        this.log(`远程大脑和 bridge 断了(code=${code || '?'}),${this.backoffMs}ms 后重连`);
        this.lastError = `连接断了(code=${code || '?'})`;
        // 这一轮还没说完:bridge 不会因为客户端断开而取消服务器 turn(协议 §4),
        // 所以收不回来了 —— 明确失败,别让气泡一直转圈。
        this.failPending(new Error('bridge 连接断了,这一句没等到回复'));
        this.scheduleReconnect();
      });
    });
  }

  /** 排一次退避重连;已经有排队的就不重复排。 */
  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.connected || this.opening) return;
      this.startConnect().catch(() => {
        /* 失败会自己在 close 里排下一次 */
      });
    }, delay);
    // 别让一条断掉的桥把进程钉住(DSH 退出时不该被它拖着)
    this.reconnectTimer.unref?.();
  }

  /**
   * 处理 bridge 推来的帧。
   * @param {{data?: unknown}} ev WebSocket message 事件
   */
  onFrame(ev) {
    const raw = typeof ev?.data === 'string' ? ev.data : String(ev?.data ?? '');
    if (!raw) return;
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.log(`bridge 推来一个不是 JSON 的帧(忽略):${raw.slice(0, 120)}`);
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const type = frame.type;

    if (type === 'accepted') {
      this.log(`bridge 已收下这一句(${frame.requestId ?? '?'})`);
      return;
    }

    if (type === 'delta') {
      const cur = this.pending;
      if (!cur || frame.requestId !== cur.requestId) return; // 上一句的残帧,忽略
      if (typeof frame.text === 'string' && frame.text) {
        cur.text += frame.text;
        try {
          this.onDelta?.(cur.text);
        } catch (err) {
          this.log(`onDelta 回调出错:${err?.message ?? err}`);
        }
      }
      return;
    }

    if (type === 'final') {
      const cur = this.pending;
      if (!cur || frame.requestId !== cur.requestId) return;
      cur.final = typeof frame.text === 'string' ? frame.text : cur.text;
      cur.settle(cur.final);
      return;
    }

    if (type === 'error') {
      const cur = this.pending;
      // requestId 对不上的是已经超时/被取消的那一句,别拿它去炸下一句
      if (frame.requestId && (!cur || frame.requestId !== cur.requestId)) return;
      const message = String(frame.message ?? '').trim() || 'bridge 报错了但没给原因';
      const code = String(frame.code ?? '').trim();
      this.failPending(new Error(`bridge 说:${message}${code ? `(${code})` : ''}`));
      return;
    }

    this.log(`bridge 推来未知类型的帧(忽略):${String(type)}`);
  }

  /** 把正在等回复的那一句以错误收尾(调用方在 finally 里清 pending)。 */
  failPending(err) {
    const cur = this.pending;
    if (!cur) return;
    cur.fail(err);
  }

  /** 给 worker 之外(ensureConnected)看的「连不上」错误:说人话,并带排查提示。 */
  connectionError(err) {
    const reason = String(err?.message ?? err);
    const token = this.token();
    const hint = token
      ? '确认 bridge 服务在运行(见 bridge 的启动说明),端口与 bridgeUrl 一致'
      : '还没拿到 bridge token:先启动 bridge 生成 token,再在插件 Config 里配置 bridgeTokenFile(或 bridgeToken)';
    return new Error(`连不上本机 bridge(${this.bridgeUrl}):${reason}。${hint}`);
  }

  /**
   * 跟她说一句,等 bridge 把这一轮说完,返回正文。
   *
   * `note` 是这一轮的当场说明(比如「你正在跟另一只桌宠 Coo 聊天」)。
   * 远程模式没有 system 通道可用,**说明只能拼进这一轮的消息正文**——和
   * `brain-session.mjs` 一样,`impl.js` 的 `scrubEcho` 负责把可能被复述的旁注剥掉。
   * 只影响这一轮,不进本机 history;但它会进服务器会话的上下文(这是远程大脑的固有代价)。
   */
  async say(text, { signal, note = '' } = {}) {
    if (this.busy) throw new Error('桌宠还在想上一句');
    const body = String(text ?? '').trim();
    if (!body) return '';
    const prompt = note ? `${note}\n\n${body}` : body;

    // **先把 busy 立起来再 await**:连 bridge 也要时间,而 `onUserText`/`pet_talk`/互聊
    // 三条路径都可能并发调到这里。要是等连上才置 busy,两个并发调用会一起挤进来,
    // 后一个把 `pending` 覆盖掉,前一个只能等超时。上游另两个后端没有 await 前置,
    // 所以没这个窗口;远程模式有,必须自己堵上。
    this.busy = true;
    const requestId = randomUUID();
    let timer = null;
    let onAbort = null;
    try {
      await this.ensureConnected();
      if (this.stopped) throw new Error('桌宠的远程大脑已经停了(插件被卸载了?)');
      if (!this.connected) throw this.connectionError(new Error('连接刚断开'));
      if (signal?.aborted) throw new Error('这一句被取消了');

      const done = new Promise((settle, fail) => {
        this.pending = { requestId, text: '', final: null, settle, fail };
      });
      try {
        this.ws.send(JSON.stringify({ type: 'say', requestId, text: prompt }));
      } catch (err) {
        throw new Error(`跟 bridge 发不出去:${err?.message ?? err}`);
      }

      if (signal) {
        onAbort = () => this.failPending(new Error('这一句被取消了'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timeout = new Promise((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`bridge 那边 ${Math.round(this.timeoutMs / 1000)} 秒还没答完`)),
          this.timeoutMs,
        );
      });
      const reply = await Promise.race([done, timeout]);
      const out = String(reply ?? '').trim() || NO_REPLY;
      this.history.push({ role: 'user', text: body }, { role: 'assistant', text: out });
      if (this.history.length > HISTORY_KEEP) this.history = this.history.slice(-HISTORY_KEEP);
      return out;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
      this.pending = null;
      this.busy = false;
    }
  }

  /**
   * 让她失忆 —— 远程模式下**只能清本机这边的显示记录**。
   *
   * 她真正的记忆(角色卡/长期记忆/mind.db)在服务器上,本机插件没有权限也不该
   * 去删服务器会话(协议 §7:不写服务器任何文件)。所以这里只清 history 并说清楚,
   * 免得主人以为「点了 forget 她就真忘了」——那是假的。
   */
  forget() {
    const n = this.history.length;
    this.history = [];
    this.log(
      `远程大脑的 forget 只清了本机这 ${n} 句显示记录;服务器会话「${this.sessionId}」的记忆没动`
      + '(要让她真忘,得在服务器侧删/归档那个会话)。',
    );
  }

  /** 插件卸载时收尾:断开连接、停掉心情定时器、失败掉还在等的那一句,不再重连。 */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    // 1) 心情:停定时器 + 掐掉可能在飞的 GET /mood(不然它会挂到超时才结束)
    this.stopMoodLoop();
    this.moodAbort?.abort();
    this.moodAbort = null;
    // 2) 聊天:取消重连、失败在等的那句、关 WS
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending(new Error('桌宠的远程大脑已经停了'));
    const opening = this.opening;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'pet stopped');
      } catch {
        /* 可能还没 open,关不掉就算了 */
      }
    }
    if (opening) await opening.catch(() => {});
    // 3) 等可能已经开始的那次 mood 请求收尾(它自己的 finally 会清 moodFetching)
    await this.moodFetching?.catch(() => {});
  }
}
