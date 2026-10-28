// dsh-link/bridge/lib/dashboard.mjs — 总控台聚合数据（Phase 5 / T18）。
//
// `GET /dashboard` 的只读数据聚合：
//   bridge  本机 bridge 自身（pid/uptime/version/busy）
//   server  服务器服务状态：SSH `systemctl is-active dsh-web qq-bridge`（缓存 30s，超时降级 null）
//   mood    最近一次心情快照（本地，来自 MoodMonitor）
//   context 最近 5 条本机情境（本地，来自 ContextBus）
//   qq      QQ 近况预览：SSH 只读 social-v2.json 的 conversations[*].recentMessages，
//           生成与 T17 awareness 一致的行格式（缓存 20s，失败降级 source:"activity"）
//   components 本机组件：observer / sync / mirror（读锁/状态/日志，缓存 10s）
// 设计原则：每个字段独立 try/catch；SSH 全部有缓存；单字段失败不影响其它字段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_VERSION = '2.2.0';
const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = path.resolve(BRIDGE_DIR, '..');

/** 相对目录以 **bridge 目录** 为基准解析（config 默认如 '../context-observer'）。 */
function resolveDir(dir, fallbackRelative) {
  const raw = dir !== undefined && dir !== null && dir !== '' ? String(dir) : fallbackRelative;
  return path.isAbsolute(raw) ? raw : path.resolve(BRIDGE_DIR, raw);
}

const pad2 = (value) => String(value).padStart(2, '0');
export function formatClock(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '--:--';
  const date = new Date(Number(ms));
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 文本压缩与截断（最多 max 个字符，超长加 …）。 */
export function clampText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const max = Math.max(1, Math.floor(Number(maxChars) || 1));
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

const allowAll = (list) => Array.isArray(list) && list.some((item) => String(item).toLowerCase() === 'all');
function isChatAllowed(list, key, peerId, fallback) {
  // 安全默认：未配置或空数组 = **不预览**（分发版不会意外暴露任何 QQ 会话）；
  // 需要全允许时在 config 里显式写 ["all"]。
  const wanted = Array.isArray(list) ? list : (Array.isArray(fallback) ? fallback : []);
  if (wanted.length === 0) return false;
  if (allowAll(wanted)) return true;
  return wanted.some((item) => {
    const text = String(item);
    return text === key || text === peerId || text === `private:${peerId}` || text === `group:${peerId}`;
  });
}

const PLACEHOLDER_RE = /^\[(图片|表情|语音|视频|文件|转发|动画表情)\]$/;

function textLength(value) {
  const text = String(value ?? '');
  return text.endsWith('…') ? text.length - 1 : text.length;
}

function shrinkText(value) {
  const text = String(value ?? '');
  const core = text.endsWith('…') ? text.slice(0, -1) : text;
  if (core.length <= 1) return '…';
  return `${core.slice(0, core.length - 1)}…`;
}

const isPlaceholder = (message) => PLACEHOLDER_RE.test(String(message?.text ?? '').trim());

/**
 * 单条会话 → 一行预览（与 T17 awareness 的 formatPreviewLine 规则逐字对齐）。
 * - 配对：A=最近非 self，B=最近 self；仅 B.time > A.time 才渲染 `A→我：「B」`，时钟取 A.time
 * - A.time >= B.time / 无 B → 只渲染 A；无 A 有 B → 只渲染 B（需 qqPreviewIncludeSelf）
 * - 整行硬上限 qqPreviewLineMaxChars（默认 60）；超长反复缩较长段，两段到最小仍超 → 删回复段，再超 → 丢弃
 * @returns {string|null}
 */
export function formatPreviewLine({ chat, sender, incoming = null, self = null, cfg = {} } = {}) {
  const lineMax = Math.max(20, Number(cfg.qqPreviewLineMaxChars) || 60);
  const textMax = Math.max(10, Number(cfg.qqPreviewMaxChars) || 60);
  const minChars = Math.max(1, Number(cfg.qqPreviewMinTextChars) || 4);
  const includeSelf = cfg.qqPreviewIncludeSelf !== false;
  const incomingTime = Number(incoming?.time);
  const selfTime = Number(self?.time);
  const paired = Boolean(incoming) && Boolean(self) && selfTime > incomingTime;

  let head;
  let a = null;
  let b = null;
  if (incoming) {
    const clock = formatClock(incomingTime);
    if (chat === 'group') {
      const senderLabel = clampText(sender || '群友', 16) || '群友';
      head = `QQ 群聊 ${clock} ${senderLabel}：`;
    } else {
      head = `QQ 私聊 ${clock} 你：`;
    }
    a = clampText(incoming.text, textMax);
    if (paired) b = clampText(self.text, textMax);
  } else if (self && includeSelf) {
    const clock = formatClock(selfTime);
    head = chat === 'group' ? `QQ 群聊 ${clock} 我：` : `QQ 私聊 ${clock} 我：`;
    b = clampText(self.text, textMax);
  } else {
    return null;
  }

  const render = () => {
    if (a !== null) return `${head}「${a}」${b !== null ? `→ 我：「${b}」` : ''}`;
    return `${head}「${b}」`;
  };

  while (render().length > lineMax) {
    if (a !== null) {
      const lenA = textLength(a);
      const lenB = b !== null ? textLength(b) : -1;
      const shrinkAFirst = b === null || lenA > lenB; // 等长时先缩回复段 B
      if (shrinkAFirst && lenA > minChars) {
        a = shrinkText(a);
        continue;
      }
      if (b !== null) {
        if (textLength(b) > minChars) {
          b = shrinkText(b);
          continue;
        }
        b = null; // 两段都到最小仍超长 → 删回复段（退化为单边）
        continue;
      }
      return null; // 单边仍超长 → 丢弃该行
    }
    return null;
  }
  return render();
}

function pickIncoming(messages) {
  const nonSelf = messages.filter((message) => message.isSelf !== true);
  if (nonSelf.length === 0) return null;
  const nonPlaceholder = nonSelf.filter((message) => !isPlaceholder(message));
  const pool = nonPlaceholder.length > 0 ? nonPlaceholder : nonSelf;
  return pool[pool.length - 1];
}

function pickSelf(messages) {
  const self = messages.filter((message) => message.isSelf === true);
  if (self.length === 0) return null;
  // T17 规则：B=最近 self（优先非占位；都占位才退回占位）
  const nonPlaceholder = self.filter((message) => !isPlaceholder(message));
  const pool = nonPlaceholder.length > 0 ? nonPlaceholder : self;
  return pool[pool.length - 1];
}

/**
 * 由 social-v2.json 的 conversations 生成可读预览行（规则与 T17 完全一致）。
 * - 私聊行在前、群聊行在后，各自按会话最新活动时间降序；总行数 ≤ qqPreviewMaxItems（默认 4）
 * - qqWindowMinutes（默认 90）之外的旧消息不参与
 * @returns {{lines:string[], updatedAt:number|null, conversations:number}}
 */
export function buildQqLines({ conversations, now = Date.now(), cfg = {} } = {}) {
  const windowMs = Math.max(1, Number(cfg.qqWindowMinutes) || 90) * 60 * 1000;
  const maxItems = Math.max(1, Math.min(12, Number(cfg.qqPreviewMaxItems) || 4));
  const groupEnabled = cfg.qqPreviewGroup === true;
  const privateCandidates = [];
  const groupCandidates = [];

  for (const [key, conversation] of Object.entries(conversations ?? {})) {
    if (!conversation || typeof conversation !== 'object') continue;
    const sep = key.indexOf(':');
    const type = sep >= 0 ? key.slice(0, sep) : '';
    const peerId = sep >= 0 ? key.slice(sep + 1) : key;
    if (type !== 'private' && type !== 'group') continue;
    if (type === 'private' && !isChatAllowed(cfg.qqPreviewChats, key, peerId, [])) continue;
    if (type === 'group') {
      if (!groupEnabled) continue;
      if (!isChatAllowed(cfg.qqPreviewGroups, key, peerId, [])) continue;
    }
    const messages = (Array.isArray(conversation.recentMessages) ? conversation.recentMessages : [])
      .filter((message) => message && typeof message === 'object'
        && String(message.text ?? '').trim()
        && Number.isFinite(Number(message.time))
        && now - Number(message.time) <= windowMs)
      .map((message) => ({ ...message, time: Number(message.time) }))
      .sort((left, right) => left.time - right.time);
    if (messages.length === 0) continue;
    const incoming = pickIncoming(messages);
    const self = pickSelf(messages);
    const line = formatPreviewLine({ chat: type, sender: incoming?.sender, incoming, self, cfg });
    if (!line) continue;
    const candidate = { at: messages[messages.length - 1].time, line };
    if (type === 'private') privateCandidates.push(candidate);
    else groupCandidates.push(candidate);
  }

  const byRecency = (left, right) => right.at - left.at;
  privateCandidates.sort(byRecency);
  groupCandidates.sort(byRecency);
  const picked = [...privateCandidates, ...groupCandidates].slice(0, maxItems);
  return {
    lines: picked.map((item) => item.line),
    updatedAt: picked.length > 0 ? Math.max(...picked.map((item) => item.at)) : null,
    conversations: Object.keys(conversations ?? {}).length,
  };
}

/** 远端只读读取 social-v2.json 的 python 脚本（打印 `__QQ__{json}`；text 只带前若干字）。
 *  路径必须由调用方通过 SOCIAL_FILE 环境变量传入（本文件不带任何部署路径默认值）。 */
export const QQ_READER_PY = String.raw`
import json, os, sys, time
path = os.environ.get('SOCIAL_FILE', '')
if not path:
    print('__QQ__' + json.dumps({'ok': False, 'error': 'SOCIAL_FILE not configured'}))
    raise SystemExit(0)
try:
    st = os.stat(path)
    with open(path, 'r', encoding='utf-8') as fh:
        doc = json.load(fh)
    convs = doc.get('conversations') or {}
    out = {'ok': True, 'mtimeMs': int(st.st_mtime * 1000), 'conversations': {}}
    for key, conv in convs.items():
        if not isinstance(conv, dict):
            continue
        recent = conv.get('recentMessages') or []
        slim = []
        for message in recent[-12:]:
            if not isinstance(message, dict):
                continue
            body = message.get('text') or message.get('plain') or ''
            slim.append({
                'time': message.get('time'),
                'text': str(body)[:200],
                'sender': message.get('sender'),
                'isSelf': message.get('isSelf') is True,
                'isOwner': message.get('isOwner') is True,
            })
        out['conversations'][key] = {'recentMessages': slim}
    print('__QQ__' + json.dumps(out, ensure_ascii=False))
except Exception as exc:
    print('__QQ__' + json.dumps({'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, ensure_ascii=False))
`;

function parseQqReaderOutput(output) {
  const line = String(output ?? '').split('\n').find((item) => item.startsWith('__QQ__'));
  if (!line) throw new Error(`QQ 读取器无输出（${String(output ?? '').slice(0, 200)}）`);
  const payload = JSON.parse(line.slice('__QQ__'.length));
  if (!payload || payload.ok !== true) throw new Error(`social-v2 读取失败: ${payload?.error ?? 'unknown'}`);
  return payload;
}

const pidAlive = (pid) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const readJsonFile = (fsApi, file) => {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const fileMtimeMs = (fsApi, file) => {
  try {
    return fsApi.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

export class DashboardService {
  constructor({ ssh, cfg = {}, log = null, moodMonitor = null, contextBus = null, runtime = null, fsApi = fs, now = () => Date.now() } = {}) {
    this.ssh = ssh;
    this.cfg = cfg;
    this.log = log;
    this.moodMonitor = moodMonitor;
    this.contextBus = contextBus;
    this.runtime = runtime;
    this.fs = fsApi;
    this.now = now;
    this.serverTtlMs = Math.max(5000, Number(cfg.dashboardServerStatusTtlMs) || 30000);
    this.qqTtlMs = Math.max(5000, Number(cfg.dashboardQqTtlMs) || 20000);
    this.componentsTtlMs = Math.max(2000, Number(cfg.dashboardComponentsTtlMs) || 10000);
    this.sshTimeoutMs = Math.max(1000, Number(cfg.dashboardSshTimeoutMs) || 6000);
    this.qqTimeoutMs = Math.max(1000, Number(cfg.dashboardQqTimeoutMs) || 8000);
    this.socialFile = typeof cfg.qqSocialFile === 'string' ? cfg.qqSocialFile : '';
    this.activityFile = typeof cfg.qqActivityFile === 'string' ? cfg.qqActivityFile : '';
    const paths = cfg.dashboardPaths ?? {};
    this.paths = {
      observerDir: resolveDir(paths.observerDir ?? cfg.observerDir, '../context-observer'),
      syncDir: resolveDir(paths.syncDir ?? cfg.syncDir, '../server/awareness'),
      mirrorDir: resolveDir(paths.mirrorDir ?? cfg.mirrorDir, '../session-mirror'),
    };
    this._cache = { server: null, qq: null, components: null };
    this._lastDurations = { server: null, qq: null, components: null };
    this._inflight = {};
    this._prefetchTimer = null;
    this.coldBudgetMs = Math.max(300, Number(cfg.dashboardColdBudgetMs) || 1800);
  }

  _cached(name, ttlMs, fetcher) {
    const cached = this._cache[name];
    const now = this.now();
    if (cached) {
      if (now - cached.at < ttlMs) return Promise.resolve(cached.value);
      // 过期但已有旧值：**立刻返回旧值 + 后台刷新**（stale-while-revalidate，保证 /dashboard <2s）
      this._refreshInBackground(name, fetcher);
      return Promise.resolve(cached.value);
    }
    // 从未成功过：冷启动，最多等 coldBudgetMs，超时先降级、后台继续拉
    return this._reloadWithBudget(name, fetcher);
  }

  /** 后台刷新（同一字段并发去重；失败保留旧缓存并记日志）。 */
  _refreshInBackground(name, fetcher) {
    if (this._inflight[name]) return this._inflight[name];
    const startedAt = this.now();
    const promise = (async () => {
      try {
        const value = await fetcher();
        this._cache[name] = { at: this.now(), value };
        this._lastDurations[name] = this.now() - startedAt;
        return value;
      } catch (error) {
        this._lastDurations[name] = this.now() - startedAt;
        this.log?.warn(`dashboard: ${name} 后台刷新失败（保留旧缓存）: ${error.message}`);
        throw error;
      } finally {
        delete this._inflight[name];
      }
    })();
    promise.catch(() => { /* 调用方不等待时避免未处理拒绝 */ });
    this._inflight[name] = promise;
    return promise;
  }

  /** 冷启动：最多等待 coldBudgetMs，超时先降级返回（后台继续完成并缓存）。 */
  async _reloadWithBudget(name, fetcher) {
    const fetchPromise = this._refreshInBackground(name, fetcher);
    let timer = null;
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`dashboard ${name} cold fetch timeout (${this.coldBudgetMs}ms)`)), this.coldBudgetMs);
    });
    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 后台预取：缓存接近过期就提前刷新，用户请求永远命中缓存。 */
  start() {
    if (this._prefetchTimer) return;
    const intervalMs = Math.max(3000, Math.min(10000, Math.floor(Math.min(this.serverTtlMs, this.qqTtlMs) / 3)));
    this._prefetchTimer = setInterval(() => {
      const now = this.now();
      const jobs = [
        ['server', this.serverTtlMs, () => this._fetchServer()],
        ['qq', this.qqTtlMs, () => this._fetchQq()],
        ['components', this.componentsTtlMs, async () => this._readComponents()],
      ];
      for (const [name, ttlMs, fetcher] of jobs) {
        const cached = this._cache[name];
        if (!cached || now - cached.at > ttlMs * 0.75) this._refreshInBackground(name, fetcher);
      }
    }, intervalMs);
    this._prefetchTimer.unref?.();
    this.log?.info(`dashboard 后台预取启动: interval=${intervalMs}ms coldBudget=${this.coldBudgetMs}ms`);
  }

  stop() {
    if (this._prefetchTimer) clearInterval(this._prefetchTimer);
    this._prefetchTimer = null;
  }

  /** 等待所有后台刷新完成（测试/诊断用）。 */
  async waitForBackground() {
    await Promise.allSettled(Object.values(this._inflight));
  }

  _fetchServer() {
    return (async () => {
      const output = await this.ssh.capture('systemctl is-active dsh-web qq-bridge', { timeoutMs: this.sshTimeoutMs });
      const lines = String(output ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
      const dshWeb = lines[0] ?? null;
      const qqBridge = lines[1] ?? null;
      const tunnel = Boolean(this.ssh?.tunnelUp);
      return {
        up: dshWeb === 'active' && qqBridge === 'active' && tunnel,
        dshWeb,
        qqBridge,
        tunnel,
      };
    })();
  }

  _fetchQq() {
    return (async () => {
      const encoded = Buffer.from(QQ_READER_PY, 'utf8').toString('base64');
      const command = `echo ${encoded} | base64 -d | SOCIAL_FILE=${JSON.stringify(this.socialFile)} python3 -`;
      const output = await this.ssh.capture(command, { timeoutMs: this.qqTimeoutMs });
      const payload = parseQqReaderOutput(output);
      const formatted = buildQqLines({
        conversations: payload.conversations,
        now: this.now(),
        cfg: this.cfg,
      });
      return {
        updatedAt: payload.mtimeMs ?? formatted.updatedAt ?? null,
        lines: formatted.lines,
        source: 'social-v2',
        conversations: formatted.conversations,
      };
    })();
  }

  // ── bridge 自身 ──
  getBridgeStatus() {
    const now = this.now();
    return {
      pid: process.pid,
      uptimeMs: this.runtime?.startedAt ? now - this.runtime.startedAt : null,
      version: BRIDGE_VERSION,
      busy: Boolean(this.runtime?.busy),
    };
  }

  // ── 服务器服务状态（SSH，缓存 30s）──
  async getServerStatus() {
    try {
      return await this._cached('server', this.serverTtlMs, () => this._fetchServer());
    } catch (error) {
      this.log?.warn(`dashboard: server 状态获取失败（降级 null）: ${error.message}`);
      this._cache.server = {
        at: this.now(),
        value: { up: false, dshWeb: null, qqBridge: null, tunnel: Boolean(this.ssh?.tunnelUp), error: error.message },
      };
      return this._cache.server.value;
    }
  }

  // ── QQ 近况（SSH 读 social-v2.json，缓存 20s；未配置则关闭）──
  async getQqPreview() {
    if (!this.socialFile) {
      // 分发默认：未配置 qqSocialFile 时不访问服务器、不输出任何 QQ 行
      return { updatedAt: null, lines: [], source: 'activity', disabled: true };
    }
    try {
      return await this._cached('qq', this.qqTtlMs, () => this._fetchQq());
    } catch (error) {
      this.log?.warn(`dashboard: QQ 预览获取失败（降级 activity）: ${error.message}`);
      const fallback = await this._activityFallback();
      this._cache.qq = { at: this.now(), value: fallback };
      return fallback;
    }
  }

  /** social-v2 不可用时的回退：只读 qq-activity.log 尾部（解析不出/未配置就 lines=[]）。 */
  async _activityFallback() {
    if (!this.activityFile) return { updatedAt: null, lines: [], source: 'activity' };
    try {
      const output = await this.ssh.capture(`tail -n 6 ${this.activityFile}`, { timeoutMs: this.sshTimeoutMs });
      const lines = [];
      for (const raw of String(output ?? '').split('\n')) {
        const text = raw.trim();
        if (!text) continue;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON 行忽略 */ }
        if (!parsed || typeof parsed !== 'object') continue;
        const at = Number(parsed.time ?? parsed.at ?? parsed.ts);
        const body = parsed.text ?? parsed.message ?? parsed.summary ?? parsed.action;
        if (!body) continue;
        lines.push(`QQ 活动 ${formatClock(Number.isFinite(at) ? (at > 1e12 ? at : at * 1000) : Date.now())}：${clampText(body, 50)}`);
      }
      return { updatedAt: null, lines: lines.slice(-3).reverse(), source: 'activity' };
    } catch {
      return { updatedAt: null, lines: [], source: 'activity' };
    }
  }

  // ── 心情 / 情境（本地）──
  getMood() {
    const mood = this.moodMonitor?.mood;
    if (!mood) return null;
    return {
      label: mood.label,
      valence: mood.valence,
      arousal: mood.arousal,
      memoryCount: mood.memoryCount,
    };
  }

  getContext() {
    try {
      const listed = this.contextBus?.list({ limit: 5 }) ?? { events: [], updatedAt: null, count: 0 };
      const summary = this.contextBus?.summary?.() ?? {};
      return {
        count: summary.count ?? listed.count ?? listed.events.length,
        updatedAt: listed.updatedAt ?? summary.updatedAt ?? null,
        events: (listed.events ?? []).slice(0, 5).map((event) => ({
          surface: event.surface,
          summary: event.summary,
          at: event.at,
        })),
      };
    } catch (error) {
      return { count: 0, updatedAt: null, events: [], error: error.message };
    }
  }

  // ── 本机组件（读锁/状态/日志，缓存 10s）──
  async getComponents() {
    try {
      return await this._cached('components', this.componentsTtlMs, async () => this._readComponents());
    } catch (error) {
      this.log?.warn(`dashboard: components 读取失败（全降级）: ${error.message}`);
      return { observer: { running: false }, sync: { running: false }, mirror: { running: false } };
    }
  }

  _readComponents() {
    const now = this.now();
    const recentMs = 2 * 60 * 1000;
    return {
      observer: this._readObserver(now, recentMs),
      sync: this._readSync(now, recentMs),
      mirror: this._readMirror(now, recentMs),
    };
  }

  _readObserver(now, recentMs) {
    try {
      const dir = this.paths.observerDir;
      const lock = readJsonFile(this.fs, path.join(dir, 'observer.lock'));
      const state = readJsonFile(this.fs, path.join(dir, 'state.json'));
      const logMtime = fileMtimeMs(this.fs, path.join(dir, 'logs', 'observer.log'));
      const pid = Number(lock?.pid ?? state?.pid) || null;
      const lastAt = Number(state?.updatedAt) || Number(lock?.startedAt) || logMtime || null;
      const running = pidAlive(pid) || (lastAt !== null && now - lastAt < recentMs) || (logMtime !== null && now - logMtime < recentMs);
      return {
        running,
        pid,
        lastAt,
        paused: state?.paused === true,
        bridgePid: state?.bridge?.pid ?? null,
        windowEvents: state?.counters?.windowEvents ?? null,
        dshEvents: state?.counters?.dshEvents ?? null,
      };
    } catch (error) {
      return { running: false, error: error.message };
    }
  }

  _readSync(now, recentMs) {
    try {
      const dir = this.paths.syncDir;
      const pid = Number(String(this.fs.readFileSync(path.join(dir, 'local-sync.pid'), 'utf8')).trim()) || null;
      const logPath = path.join(dir, 'logs', 'local-sync.log');
      const logMtime = fileMtimeMs(this.fs, logPath);
      let lastWriteAt = null;
      let events = null;
      try {
        const logText = this.fs.readFileSync(logPath, 'utf8');
        const lines = String(logText).trim().split('\n').reverse();
        for (const line of lines) {
          const wrote = line.match(/WROTE\s+\S+\s+events=(\d+)/);
          if (!wrote) continue;
          events = Number(wrote[1]);
          const stamp = line.match(/^\[?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]?/);
          if (stamp) {
            const parsed = Date.parse(stamp[1]);
            if (Number.isFinite(parsed)) lastWriteAt = parsed;
          }
          break;
        }
      } catch { /* 日志临时不可读 */ }
      if (lastWriteAt === null) lastWriteAt = logMtime;
      const running = pidAlive(pid) || (lastWriteAt !== null && now - lastWriteAt < recentMs);
      return { running, pid, lastWriteAt, events };
    } catch (error) {
      return { running: false, pid: null, lastWriteAt: null, events: null, error: error.message };
    }
  }

  _readMirror(now, recentMs) {
    try {
      const dir = this.paths.mirrorDir;
      const pid = Number(String(this.fs.readFileSync(path.join(dir, 'mirror-loop.lock'), 'utf8')).trim()) || null;
      const logMtime = fileMtimeMs(this.fs, path.join(dir, 'logs', 'mirror-loop.log'));
      const state = readJsonFile(this.fs, path.join(dir, 'state.json'));
      let mirrored = null;
      let lastRunAt = null;
      if (state && typeof state.sessions === 'object' && state.sessions !== null) {
        mirrored = Object.keys(state.sessions).length;
        for (const entry of Object.values(state.sessions)) {
          const stamped = Date.parse(entry?.mirroredAt ?? '');
          if (Number.isFinite(stamped) && (lastRunAt === null || stamped > lastRunAt)) lastRunAt = stamped;
        }
      }
      if (lastRunAt === null) lastRunAt = logMtime;
      const running = pidAlive(pid) || (lastRunAt !== null && now - lastRunAt < 5 * 60 * 1000);
      return { running, pid, lastRunAt, mirrored };
    } catch (error) {
      return { running: false, pid: null, lastRunAt: null, mirrored: null, error: error.message };
    }
  }

  /** 聚合入口；任何字段失败都不影响其它字段。 */
  async getDashboard() {
    const at = this.now();
    const errors = [];
    const server = await this.getServerStatus().catch((error) => {
      errors.push({ field: 'server', message: error.message });
      return { up: false, dshWeb: null, qqBridge: null, tunnel: Boolean(this.ssh?.tunnelUp) };
    });
    if (server?.error) errors.push({ field: 'server', message: server.error });
    const qq = await this.getQqPreview().catch((error) => {
      errors.push({ field: 'qq', message: error.message });
      return { updatedAt: null, lines: [], source: 'activity' };
    });
    let mood = null;
    try {
      mood = this.getMood();
    } catch (error) {
      errors.push({ field: 'mood', message: error.message });
    }
    let context = null;
    try {
      context = this.getContext();
    } catch (error) {
      errors.push({ field: 'context', message: error.message });
      context = { count: 0, updatedAt: null, events: [] };
    }
    const components = await this.getComponents();
    return {
      ok: true,
      at,
      bridge: this.getBridgeStatus(),
      server,
      mood,
      context,
      qq,
      components,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  /** 后台预热（启动时调用一次，降低首次 /dashboard 延迟）。 */
  warm() {
    void this.getServerStatus().catch(() => {});
    void this.getQqPreview().catch(() => {});
    void this.getComponents().catch(() => {});
  }

  /** 诊断信息（/diagnostics.dashboard 用）。 */
  info() {
    return {
      version: BRIDGE_VERSION,
      cache: {
        server: this._cache.server ? { at: this._cache.server.at } : null,
        qq: this._cache.qq ? { at: this._cache.qq.at } : null,
        components: this._cache.components ? { at: this._cache.components.at } : null,
      },
      ttlMs: { server: this.serverTtlMs, qq: this.qqTtlMs, components: this.componentsTtlMs },
      coldBudgetMs: this.coldBudgetMs,
      prefetch: Boolean(this._prefetchTimer),
      inflight: Object.keys(this._inflight),
      lastDurationsMs: { ...this._lastDurations },
      paths: this.paths,
      socialFile: this.socialFile,
    };
  }
}
