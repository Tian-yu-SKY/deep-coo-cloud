// dsh-link/bridge/lib/context.mjs — 情境总线（Phase 5 / T13）。
//
// 用途：本机观察器（T14）把「主人在干嘛」通过 POST /context 推进来，bridge 保存成
// 环形缓冲；/say 与 WS /chat 每轮把最近情境拼成 ≤600 字的一段注入 prompt，
// 让桌宠/面板/服务器鲸歌（经 T15 同步）都知道主人当前情境。
//
// 规则（task-13）：
//   - 最多 contextMaxEvents（默认 120）条；TTL contextTtlMs（默认 60 分钟）；
//   - 相同 summary 去重合并时间（保留一条，at 取较新，hits+1）；
//   - private=true 事件只计数/不返回、不注入；
//   - GET /context 只返回未过期 private=false；注入同样只取 public；
//   - 无情境时不注入；contextInjection=false 可整体关闭。
const ALLOWED_SURFACES = new Set(['desktop', 'dsh-local', 'qq', 'panel']);
const ALLOWED_KINDS = new Set(['window', 'session', 'activity']);
const CONTEXT_HEADER = '【主人当前情境（本机自动感知，按需自然使用，不要逐条复述）】';

const clampSummary = (value, maxChars) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);

/** 时间→中文相对时间（注入块用）。 */
export function relativeTime(at, now = Date.now()) {
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60 * 1000) return '刚刚';
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 1000))} 分钟前`;
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 60 * 1000))} 小时前`;
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把一条情境渲染成注入块里的一行（"- 前台窗口：…（3 分钟前）"）。 */
export function formatContextLine(event, now = Date.now()) {
  const summary = clampSummary(event.summary, 200);
  const label = event.surface === 'desktop' && event.kind === 'window'
    ? `前台窗口：${summary}`
    : event.surface === 'desktop'
      ? `桌面活动：${summary}`
      : event.surface === 'dsh-local' && event.kind === 'session'
        ? `本机 DSH 会话：${summary}`
        : event.surface === 'dsh-local'
          ? `本机 DSH：${summary}`
          : event.surface === 'qq'
            ? `QQ：${summary}`
            : event.surface === 'panel'
              ? `面板：${summary}`
              : `${event.surface ?? 'unknown'}：${summary}`;
  return `- ${label}（${relativeTime(event.at, now)}）`;
}

function toMillis(value, now) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(number) || number <= 0) return now;
  const ms = number > 1e12 ? number : number * 1000;
  // 时钟漂移：未来超过 60s 的按 now 处理；不因此丢弃
  return Math.min(ms, now + 60 * 1000);
}

export class ContextBus {
  constructor({ cfg = {}, log = null } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.maxEvents = Math.max(1, Number(cfg.contextMaxEvents) || 120);
    this.ttlMs = Math.max(60 * 1000, Number(cfg.contextTtlMs) || 60 * 60 * 1000);
    this.maxSummaryChars = 200;
    this.maxInjectChars = Math.max(100, Number(cfg.contextInjectMaxChars) || 600);
    this.maxInjectItems = Math.max(1, Number(cfg.contextInjectMaxItems) || 6);
    this.enabled = cfg.contextInjection !== false;
    this.events = []; // 插入顺序（旧→新），环形上限
    this.updatedAt = null;
    this.stats = {
      storedTotal: 0,
      droppedTotal: 0,
      dedupedTotal: 0,
      lastPostAt: null,
      lastStored: 0,
      lastDropped: 0,
      injectedTurns: 0,
      lastInjectionAt: null,
      lastInjectionChars: 0,
      lastInjectionItems: 0,
    };
  }

  _purge(now) {
    const before = this.events.length;
    this.events = this.events.filter((event) => now - event.at <= this.ttlMs);
    return before - this.events.length;
  }

  /** 归一化一条事件；非法返回 null。 */
  _normalize(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const summary = clampSummary(raw.summary, this.maxSummaryChars);
    if (!summary) return null;
    const at = toMillis(raw.at, now);
    if (now - at > this.ttlMs) return null; // 入队时已过期，直接丢弃
    return {
      at,
      surface: ALLOWED_SURFACES.has(raw.surface) ? raw.surface : 'unknown',
      kind: ALLOWED_KINDS.has(raw.kind) ? raw.kind : 'activity',
      summary,
      private: raw.private === true,
      hits: 1,
      firstAt: at,
    };
  }

  /**
   * 批量 upsert（POST /context）。
   * @returns {{stored:number, dropped:number, deduped:number, total:number}}
   */
  addEvents(rawEvents, now = Date.now()) {
    this._purge(now);
    if (!Array.isArray(rawEvents)) return { stored: 0, dropped: 0, deduped: 0, total: this.events.length };
    let stored = 0;
    let dropped = 0;
    let deduped = 0;
    for (const raw of rawEvents) {
      const event = this._normalize(raw, now);
      if (!event) {
        dropped += 1;
        continue;
      }
      const existing = this.events.find((item) => item.summary === event.summary);
      if (existing) {
        existing.at = Math.max(existing.at, event.at);
        existing.hits += 1;
        // 只要出现过一次 private，就保持 private（避免私密内容被同名公开事件带出）
        existing.private = existing.private || event.private;
        deduped += 1;
        stored += 1;
        continue;
      }
      this.events.push(event);
      stored += 1;
    }
    // 环形上限：丢最旧的插入项
    while (this.events.length > this.maxEvents) this.events.shift();
    this.updatedAt = stored > 0 ? now : this.updatedAt;
    this.stats.storedTotal += stored;
    this.stats.droppedTotal += dropped;
    this.stats.dedupedTotal += deduped;
    this.stats.lastPostAt = now;
    this.stats.lastStored = stored;
    this.stats.lastDropped = dropped;
    if (stored > 0) {
      this.log?.info(`context 收到 ${stored} 条（dropped=${dropped} deduped=${deduped} total=${this.events.length}）`);
    }
    return { stored, dropped, deduped, total: this.events.length };
  }

  _active(now) {
    return this.events.filter((event) => now - event.at <= this.ttlMs);
  }

  /** GET /context：未过期、非 private，按时间新→旧。 */
  list({ limit = 20, now = Date.now() } = {}) {
    const cap = Math.max(1, Math.min(this.maxEvents, Number(limit) || 20));
    const publicEvents = this._active(now)
      .filter((event) => !event.private)
      .sort((left, right) => right.at - left.at)
      .slice(0, cap)
      .map((event) => ({
        at: event.at,
        surface: event.surface,
        kind: event.kind,
        summary: event.summary,
        ...(event.hits > 1 ? { hits: event.hits } : {}),
      }));
    return { events: publicEvents, updatedAt: this.updatedAt, count: publicEvents.length };
  }

  /** 摘要（/health、/state 用）。 */
  summary(now = Date.now()) {
    const active = this._active(now);
    const publicEvents = active.filter((event) => !event.private);
    return {
      count: publicEvents.length,
      privateCount: active.length - publicEvents.length,
      updatedAt: this.updatedAt,
      lastPostAt: this.stats.lastPostAt,
      injectedTurns: this.stats.injectedTurns,
      lastInjectionAt: this.stats.lastInjectionAt,
      injection: this.enabled ? 'on' : 'off',
      sample: publicEvents
        .sort((left, right) => right.at - left.at)
        .slice(0, 3)
        .map((event) => formatContextLine(event, now).replace(/^-\s*/, '')),
    };
  }

  /** /diagnostics 用：计数与最近事件。 */
  diagnostics(now = Date.now()) {
    const active = this._active(now);
    return {
      ...this.summary(now),
      bufferSize: this.events.length,
      active: active.length,
      maxEvents: this.maxEvents,
      ttlMs: this.ttlMs,
      storedTotal: this.stats.storedTotal,
      droppedTotal: this.stats.droppedTotal,
      dedupedTotal: this.stats.dedupedTotal,
      lastStored: this.stats.lastStored,
      lastDropped: this.stats.lastDropped,
      lastInjectionChars: this.stats.lastInjectionChars,
      lastInjectionItems: this.stats.lastInjectionItems,
      recent: this.list({ limit: 10, now }).events,
    };
  }

  /**
   * 生成注入块；无有效 public 情境或功能关闭时返回 null。
   * @returns {{text:string, items:number}|null}
   */
  buildInjectionBlock({ now = Date.now() } = {}) {
    if (!this.enabled) return null;
    const publicEvents = this._active(now)
      .filter((event) => !event.private)
      .sort((left, right) => right.at - left.at);
    if (publicEvents.length === 0) return null;
    const seen = new Set();
    const lines = [];
    for (const event of publicEvents) {
      const line = formatContextLine(event, now);
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= this.maxInjectItems) break;
    }
    if (lines.length === 0) return null;
    let text = `${CONTEXT_HEADER}\n${lines.join('\n')}`;
    while (text.length > this.maxInjectChars && lines.length > 1) {
      lines.pop();
      text = `${CONTEXT_HEADER}\n${lines.join('\n')}`;
    }
    if (text.length > this.maxInjectChars) text = text.slice(0, this.maxInjectChars);
    return { text, items: lines.length };
  }

  /** sayTurn 成功带注入时登记统计。 */
  recordInjection(block) {
    if (!block) return;
    this.stats.injectedTurns += 1;
    this.stats.lastInjectionAt = Date.now();
    this.stats.lastInjectionChars = block.text.length;
    this.stats.lastInjectionItems = block.items;
  }
}

export { CONTEXT_HEADER, ALLOWED_SURFACES, ALLOWED_KINDS };
