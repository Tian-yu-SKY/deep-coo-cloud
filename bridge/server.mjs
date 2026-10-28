#!/usr/bin/env node
// dsh-link/bridge/server.mjs — 本机 bridge 服务（协议 v1 + panel v1：/history、WS /events）。
//
// 职责：独家持有服务器 DSH 鉴权与 SSH 隧道，向本机 Coo 桌宠 / 「鲸歌」面板提供
//       /health /state /say /chat(WS) /mood /history /events(WS) 接口；
//       角色卡只读注入；forbiddenSessionIds 红线。
// 运行：node bridge/server.mjs [--once] [--config <path>] [--supervised] [--no-supervisor]
// 守护：启动时自举 supervisor.mjs（崩溃/被杀/卡死自动拉起；登录自启后由它负责常驻）。
// 环境：本机内置 node v24（全局 fetch / WebSocket / crypto），无 npm 依赖。
// 安全：只监听 listenHost(127.0.0.1)；secret/cookie/角色卡全文不进日志，不落盘。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { BRIDGE_DIR, loadConfig, DEFAULT_CONFIG_PATH } from './lib/config.mjs';
import { createLogger } from './lib/log.mjs';
import { acquireProcLock, isProcessAlive, readProcLock, releaseProcLock } from './lib/proc-lock.mjs';
import { SshManager, shQuote } from './lib/ssh.mjs';
import { ApiError, DshClient, MuxFollower, runTurn } from './lib/dsh.mjs';
import { MoodMonitor } from './lib/mood.mjs';
import { MessageCache } from './lib/messages.mjs';
import { HistoryService } from './lib/history.mjs';
import { EventHub } from './lib/events.mjs';
import { ContextBus } from './lib/context.mjs';
import { DashboardService } from './lib/dashboard.mjs';
import { attachWebSocketEndpoints } from './lib/ws-server.mjs';

const SPEC = 'bridge-protocol-v1';

// ───────────────────────────── CLI 参数 ─────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const optValue = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const ONCE = hasFlag('--once');
const CHECK_CONFIG = hasFlag('--check-config');
const SUPERVISED = hasFlag('--supervised');
const NO_SUPERVISOR = hasFlag('--no-supervisor') || process.env.DSH_BRIDGE_NO_SUPERVISOR === '1';
const CONFIG_PATH = path.resolve(optValue('--config', DEFAULT_CONFIG_PATH));
const SUPERVISOR_JS = path.join(BRIDGE_DIR, 'supervisor.mjs');
const SUPERVISOR_LOCK_FILE = path.join(BRIDGE_DIR, 'supervisor.lock');
const SUPERVISOR_STOP_FILE = path.join(BRIDGE_DIR, 'supervisor.stop');
const START_LOCK_FILE = path.join(BRIDGE_DIR, 'bridge.start.lock');

// ── 启动窗口互斥 ───────────────────────────────────────────────
// 登录自启 / 守护重拉 / 手动启动 可能同时发生：先到先得，只允许一个 bridge 进入 bootstrap。
// 监听成功后立即释放（之后的防双开由 detectRunningBridge 探测 /health 负责）。
if (!ONCE && !CHECK_CONFIG) {
  const startLock = acquireProcLock(START_LOCK_FILE, { staleMs: 180000 });
  if (!startLock.acquired) {
    console.log(`[dsh-link-bridge] 另一个 bridge 正在启动（pid=${startLock.holder?.pid ?? '?'}），本进程退出`);
    process.exit(0);
  }
  process.on('exit', () => releaseProcLock(START_LOCK_FILE));
}

/** 读配置；缺失/占位/非法时给出可读提示并退出（不抛栈崩溃）。 */
function loadConfigOrExit(file) {
  try {
    return loadConfig(file);
  } catch (error) {
    console.error(`[dsh-link-bridge] 配置错误：\n${error.message}`);
    process.exit(1);
  }
}

// ───────────────────────────── 基础工具 ─────────────────────────────
class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function loadOrCreateToken(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return { token: existing, created: false };
  } catch { /* 不存在则创建 */ }
  const token = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { token, created: true };
}

class StateStore {
  constructor(file) {
    this.file = file;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  update(patch) {
    const next = { ...this.read(), ...patch };
    this.write(next);
    return next;
  }
}

/** 服务器角色卡：经 SSH 只读读取，只保留 sha256/长度用于日志。 */
class RoleCard {
  constructor(cfg, ssh, log) {
    this.cfg = cfg;
    this.ssh = ssh;
    this.log = log;
    this.text = null;
    this.sha256 = null;
    this.bytes = 0;
    this.loadedAt = null;
  }

  async load() {
    if (!this.cfg.roleCardPath) {
      this.log.info('roleCardPath 未配置，跳过角色卡注入（只读人格文件可选）');
      return this;
    }
    const remote = `cat ${shQuote(this.cfg.roleCardPath)}`;
    const text = await this.ssh.capture(remote, { timeoutMs: 30000 });
    if (!text || text.trim().length === 0) throw new Error('role card is empty');
    this.text = text;
    this.sha256 = sha256Hex(text);
    this.bytes = Buffer.byteLength(text, 'utf8');
    this.loadedAt = Date.now();
    this.log.info(`role card loaded: path=${this.cfg.roleCardPath} bytes=${this.bytes} sha256=${this.sha256}`);
    return this;
  }

  /** once 模式：state 里同一会话 + 同一 sha256 已注入过则跳过。 */
  shouldInject(sessionId, state) {
    if (!this.text) return false;
    if (this.cfg.roleCardMode === 'off') return false;
    if (this.cfg.roleCardMode === 'always') return true;
    const record = state?.roleCard;
    return !(record?.sessionId === String(sessionId)
      && record?.sha256 === this.sha256
      && record?.injected === true);
  }

  buildPrompt(userText) {
    return `【角色卡（长期设定，读一遍记住即可，不要复述原文）】\n${this.text}\n\n【用户消息】\n${userText}`;
  }
}

// ───────────────────────────── 主程序 ─────────────────────────────
const cfg = loadConfigOrExit(CONFIG_PATH);
if (CHECK_CONFIG) {
  console.log(`[dsh-link-bridge] 配置检查通过：${CONFIG_PATH}`);
  process.exit(0);
}
const log = createLogger({
  file: cfg.logFile,
  maxBytes: cfg.maxLogBytes,
  level: process.env.BRIDGE_LOG_LEVEL || cfg.logLevel || 'info',
});

/**
 * supervisor 自举：守护进程负责 bridge 崩溃 / 被杀 / 卡死后的自动拉起。
 * - 单实例由 supervisor.lock 保证（已有守护在跑就直接复用，不起第二个）；
 * - 每次调用都先看锁（进程死了锁会被 supervisor 自己回收），所以可以当保活用。
 * @returns {number|null} 守护 pid（已存在或刚启动）
 */
function ensureSupervisor(reason) {
  if (ONCE || CHECK_CONFIG || NO_SUPERVISOR) return null;
  try {
    const holder = readProcLock(SUPERVISOR_LOCK_FILE);
    if (holder && isProcessAlive(holder.pid)) return holder.pid;
    const child = spawn(process.execPath, [SUPERVISOR_JS, '--config', CONFIG_PATH], {
      cwd: BRIDGE_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => log.warn(`supervisor 启动失败: ${error.message}`));
    if (child.pid) child.unref();
    log.info(`supervisor 已启动 pid=${child.pid ?? '?'}（${reason}）`);
    return child.pid ?? null;
  } catch (error) {
    log.warn(`supervisor 启动失败: ${error.message}`);
    return null;
  }
}

const ssh = new SshManager(cfg, log);
const client = new DshClient({ cfg, ssh, log });
const follower = new MuxFollower({ client, log, maxMessages: cfg.followSnapshotMessages });
const stateStore = new StateStore(cfg.stateFile);
const roleCard = new RoleCard(cfg, ssh, log);
const moodMonitor = new MoodMonitor({ ssh, cfg, log });
// Phase 4：/history + WS /events（本机「鲸歌」面板）
const messageCache = new MessageCache({ maxPerSession: cfg.messageCacheMax });
const historyService = new HistoryService({ client, follower, cache: messageCache, log, cfg });
const eventHub = new EventHub({
  follower,
  history: historyService,
  cache: messageCache,
  log,
  cfg,
  busyGetter: () => runtime.busy !== null,
});
// Phase 5：情境总线（T14 推送 → 每轮注入 prompt；T15 拉取同步到服务器）
const contextBus = new ContextBus({ cfg, log });
const { token, created: tokenCreated } = loadOrCreateToken(cfg.tokenFile);

const runtime = {
  apiPort: cfg.apiPort,
  listener: null,
  startedAt: Date.now(),
  lastApiOkAt: 0,
  lastError: null,
  sessionExists: false,
  busy: null,
  lastTurn: null,
  followerStarted: false,
  moodStarted: false,
  eventsStarted: false,
  wsChatClients: 0,
  lastWsClientAt: null,
  lastWsClientAddr: null,
  dashboardWarmed: false,
  stopping: false,
};
let httpServer = null;

// Phase 5（T18）：总控台聚合 /dashboard（server/qq 走 SSH 缓存；components 读本机文件）
const dashboardService = new DashboardService({
  ssh,
  cfg,
  log,
  moodMonitor,
  contextBus,
  runtime,
});

function setError(error, context = '') {
  const message = `${context ? `${context}: ` : ''}${error?.message ?? String(error)}`;
  runtime.lastError = message.slice(0, 500);
  log.warn(`lastError <- ${runtime.lastError}`);
}

// ─────────────────── 红线：forbiddenSessionIds 永不触碰 ───────────────────
function assertAllowed(sessionId) {
  const sid = String(sessionId ?? '');
  if (!sid) throw new BridgeError('bad-request', 'sessionId 不能为空');
  if (cfg.forbiddenSessionIds.includes(sid)) {
    log.error(`RED-LINE: 拒绝对 forbidden session 的任何操作：${sid}`);
    throw new BridgeError('forbidden-session', `会话 ${sid} 是 QQ 绑定会话，bridge 永不创建/提示/删除它`);
  }
  return sid;
}

async function listSessionsSafe() {
  const items = await client.listSessions();
  const allowed = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const sid = item.sessionId ?? item.header?.id;
    if (cfg.forbiddenSessionIds.includes(sid)) {
      // list 也不能把 QQ 会话暴露给上层：过滤并告警（红线的最小干预解释）。
      log.warn(`RED-LINE: list 结果里出现 forbidden session ${sid}，已从返回中过滤`);
      continue;
    }
    allowed.push(item);
  }
  runtime.lastApiOkAt = Date.now();
  return allowed;
}

function summarizeSession(item) {
  return {
    sessionId: item.sessionId ?? item.header?.id ?? null,
    title: item.title ?? item.name ?? item.header?.title ?? null,
    agentPreset: item.agentPreset ?? item.header?.agentPreset ?? null,
    running: item.running ?? item.isRunning ?? null,
    blank: item.blank ?? null,
    lastPromptAt: item.lastPromptAt ?? null,
    cwd: item.cwd ?? item.header?.cwd ?? null,
  };
}

async function refreshSessionState() {
  const items = await listSessionsSafe();
  runtime.sessionExists = items.some((item) => (item.sessionId ?? item.header?.id) === cfg.sessionId);
  return items;
}

async function ensureSession({ sessionId, cwd = cfg.cwd, agentPreset, createIfMissing = true }) {
  const sid = assertAllowed(sessionId ?? cfg.sessionId);
  const items = await listSessionsSafe();
  const found = items.find((item) => (item.sessionId ?? item.header?.id) === sid);
  if (found) {
    runtime.sessionExists = runtime.sessionExists || sid === cfg.sessionId;
    return { sessionId: sid, created: false, exists: true, agentPreset: summarizeSession(found).agentPreset };
  }
  if (!createIfMissing) return { sessionId: sid, created: false, exists: false, agentPreset: null };

  let value;
  let presetUsed = agentPreset ?? null;
  try {
    value = await client.createSession({ cwd, sessionId: sid, agentPreset });
  } catch (error) {
    const message = String(error?.message ?? '');
    const presetRejected = error instanceof ApiError
      && /preset|agent-preset|agentPreset|unknown|not-found|bad-request/i.test(`${error.code} ${message}`);
    if (agentPreset && presetRejected) {
      log.warn(`session/create 拒绝 agentPreset="${agentPreset}"（${message.slice(0, 200)}），按协议回退：不带 preset 重试`);
      value = await client.createSession({ cwd, sessionId: sid });
      presetUsed = null;
    } else {
      throw error;
    }
  }
  const actualId = typeof value?.sessionId === 'string' && value.sessionId ? value.sessionId : sid;
  const actualPreset = value?.agentPreset ?? presetUsed;
  runtime.lastApiOkAt = Date.now();
  if (actualId === cfg.sessionId) runtime.sessionExists = true;
  log.info(`session ensured: requested=${sid} actual=${actualId} cwd=${cwd} agentPreset=${actualPreset ?? '(none)'}`);
  return { sessionId: actualId, created: true, exists: true, agentPreset: actualPreset };
}

// ─────────────────────────── 一轮对话 ───────────────────────────
async function sayTurn({ text, requestId, sessionId, injectRoleCard = 'auto', onDelta = null }) {
  if (typeof text !== 'string' || text.trim() === '') throw new BridgeError('bad-request', 'text 不能为空');
  if (runtime.busy) throw new BridgeError('busy', '还在想上一句');
  const sid = assertAllowed(sessionId ?? cfg.sessionId);
  const rid = typeof requestId === 'string' && requestId ? requestId : randomUUID();

  runtime.busy = { requestId: rid, sessionId: sid, startedAt: Date.now() };
  const startedAt = Date.now();
  try {
    const ensure = await ensureSession({
      sessionId: sid,
      agentPreset: sid === cfg.sessionId ? cfg.agentPreset : undefined,
    });
    const actualSessionId = ensure.sessionId;

    const state = stateStore.read();
    let promptText = text;
    let injected = false;
    const autoInject = roleCard.shouldInject(actualSessionId, state);
    const wantInject = injectRoleCard === true || (injectRoleCard === 'auto' && autoInject);
    if (wantInject) {
      if (!roleCard.text) throw new BridgeError('role-card-unavailable', '角色卡尚未加载完成（SSH 读取失败？）');
      promptText = roleCard.buildPrompt(text);
      injected = true;
      log.info(`role card 注入: session=${actualSessionId} sha256=${roleCard.sha256} 用户文本=${text.length}字 注入后=${promptText.length}字`);
    } else if (injectRoleCard === 'auto' && cfg.roleCardMode === 'once' && roleCard.text) {
      log.info(`role card 注入跳过（once 模式已注入过）: session=${actualSessionId} sha256=${roleCard.sha256}`);
    }

    // Phase 5：每轮注入「主人当前情境」（≤600 字；无情境不加；不影响角色卡 once 逻辑）
    let contextBlock = null;
    if (cfg.contextInjection !== false) {
      const block = contextBus.buildInjectionBlock();
      if (block) {
        promptText = `${block.text}\n\n${promptText}`;
        contextBlock = block;
        log.info(`context 注入: session=${actualSessionId} items=${block.items} chars=${block.text.length} 最终 prompt=${promptText.length}字`);
      }
    }

    log.info(`turn start: session=${actualSessionId} requestId=${rid} textLen=${text.length} injected=${injected} context=${contextBlock ? contextBlock.items : 0}`);
    const outcome = await runTurn({
      client,
      follower,
      log,
      sessionId: actualSessionId,
      text: promptText,
      requestId: rid,
      timeoutMs: cfg.requestTimeoutMs,
      onDelta,
    });
    const ms = Date.now() - startedAt;
    if (contextBlock) contextBus.recordInjection(contextBlock);

    const nextState = stateStore.read();
    if (injected) {
      nextState.roleCard = {
        path: cfg.roleCardPath,
        sessionId: actualSessionId,
        sha256: roleCard.sha256,
        injected: true,
        injectedAt: Date.now(),
      };
    }
    nextState.lastTurnAt = Date.now();
    nextState.lastTurn = {
      requestId: rid,
      sessionId: actualSessionId,
      textLen: text.length,
      replyLen: outcome.text.length,
      ms,
      deltaCount: outcome.deltaCount,
      reason: outcome.reason,
      injected,
      recovered: outcome.recovered === true,
      partial: outcome.partial === true,
      promptAttempts: outcome.promptAttempts ?? 1,
      contextItems: contextBlock?.items ?? 0,
      contextChars: contextBlock?.text.length ?? 0,
    };
    stateStore.write(nextState);
    runtime.lastTurn = nextState.lastTurn;
    runtime.lastError = null;
    log.info(`turn end: session=${actualSessionId} ms=${ms} replyLen=${outcome.text.length} deltas=${outcome.deltaCount} recovered=${outcome.recovered === true} partial=${outcome.partial === true} promptAttempts=${outcome.promptAttempts ?? 1} contextItems=${contextBlock?.items ?? 0} reason=${JSON.stringify(outcome.reason ?? null)}`);
    return {
      text: outcome.text,
      sessionId: actualSessionId,
      ms,
      deltas: outcome.deltaCount,
      durableDeltas: outcome.durableDeltas,
      streamDeltas: outcome.streamDeltas,
      turn: outcome.turn,
      reason: outcome.reason,
      injected,
      recovered: outcome.recovered === true,
      partial: outcome.partial === true,
      promptAttempts: outcome.promptAttempts ?? 1,
      contextInjected: contextBlock !== null,
      contextItems: contextBlock?.items ?? 0,
      contextChars: contextBlock?.text.length ?? 0,
    };
  } catch (error) {
    setError(error, 'turn');
    throw error;
  } finally {
    runtime.busy = null;
  }
}

// ─────────────────────────── health / state ───────────────────────────
function buildHealth() {
  const dshReachable = ssh.tunnelUp && Date.now() - runtime.lastApiOkAt < 180000;
  return {
    ok: true,
    spec: SPEC,
    pid: process.pid,
    server: {
      up: Boolean(ssh.tunnelUp && dshReachable),
      tunnel: Boolean(ssh.tunnelUp),
      sessionId: cfg.sessionId,
      sessionExists: runtime.sessionExists,
      agentPreset: cfg.agentPreset,
      tunnelPort: ssh.port,
      apiPort: runtime.apiPort,
    },
    auth: {
      cookieAgeMs: client.cookieAgeMs,
      roleCardSha256: roleCard.sha256,
      roleCardBytes: roleCard.bytes,
      serverClockOffsetMs: Math.round(client.clockOffsetMs),
      serverClockMeasuredAt: client.clockMeasuredAt || null,
    },
    lastError: runtime.lastError,
    busy: runtime.busy !== null,
    mood: moodMonitor.mood ? { label: moodMonitor.mood.label, updatedAt: moodMonitor.mood.updatedAt } : null,
    context: contextBus.summary(),
    clients: { wsChat: runtime.wsChatClients, lastWsClientAt: runtime.lastWsClientAt },
    uptimeMs: Date.now() - runtime.startedAt,
  };
}

function buildState() {
  const state = stateStore.read();
  const record = state.roleCard;
  const injected = record?.sessionId === cfg.sessionId
    && record?.sha256 === roleCard.sha256
    && record?.injected === true;
  return {
    ok: true,
    sessionId: cfg.sessionId,
    roleCard: {
      path: cfg.roleCardPath,
      sha256: roleCard.sha256,
      bytes: roleCard.bytes,
      injected,
      injectedAt: record?.sessionId === cfg.sessionId ? record?.injectedAt ?? null : null,
    },
    mood: moodMonitor.mood,
    context: contextBus.summary(),
    lastTurnAt: state.lastTurnAt ?? null,
    lastError: runtime.lastError,
  };
}

// ─────────────────────────── HTTP API ───────────────────────────
function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new BridgeError('payload-too-large', `请求体超过 ${limitBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BridgeError('bad-request', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, error) {
  const code = error instanceof BridgeError ? error.code
    : error instanceof ApiError ? error.code
      : (typeof error?.code === 'string' && error.code ? error.code : 'internal');
  const status = code === 'busy' ? 409
    : code === 'unauthorized' ? 401
      : code === 'forbidden-session' ? 403
        : code === 'bad-request' || code === 'payload-too-large' ? 400
          : code === 'timeout' || code === 'stream-lost' ? 504
            : code === 'stream-not-ready' || code === 'prompt-delivery-failed' || code === 'stream-interrupted'
              || code === 'history-unavailable' ? 503
              : 500;
  sendJson(res, status, { ok: false, error: { code, message: error?.message ?? String(error) } });
}

/** POST /context 的 token 鉴权：支持 x-bridge-token / Authorization: Bearer / ?token=。 */
function isBridgeTokenPresent(req, url) {
  const headerToken = req.headers['x-bridge-token'];
  if (typeof headerToken === 'string' && headerToken.length > 0 && headerToken === token) return true;
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim() === token;
  }
  return url.searchParams.get('token') === token;
}

async function handleHttp(req, res) {
  const url = new URL(req.url, `http://${cfg.listenHost}:${runtime.apiPort}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/health') return sendJson(res, 200, buildHealth());
  if (method === 'GET' && pathname === '/state') return sendJson(res, 200, buildState());

  // Phase 5：情境总线（T14 推送；GET 供 T15/面板拉取）
  if (method === 'POST' && pathname === '/context') {
    if (!isBridgeTokenPresent(req, url)) {
      throw new BridgeError('unauthorized', 'POST /context 需要 bridge token（x-bridge-token / Authorization: Bearer / ?token=）');
    }
    const body = await readJsonBody(req);
    const result = contextBus.addEvents(body?.events);
    return sendJson(res, 200, { ok: true, ...result, updatedAt: contextBus.updatedAt });
  }
  if (method === 'GET' && pathname === '/context') {
    const listed = contextBus.list({ limit: url.searchParams.get('limit') });
    return sendJson(res, 200, { ok: true, ...listed });
  }

  // Phase 5（T18）：总控台聚合（token 鉴权；server/qq 走 SSH 缓存，字段独立降级）
  if (method === 'GET' && pathname === '/dashboard') {
    if (!isBridgeTokenPresent(req, url)) {
      throw new BridgeError('unauthorized', 'GET /dashboard 需要 bridge token（query ?token= / x-bridge-token / Authorization: Bearer）');
    }
    const startedAt = Date.now();
    const data = await dashboardService.getDashboard();
    const tookMs = Date.now() - startedAt;
    log.info(`dashboard: took=${tookMs}ms server=${data.server?.dshWeb ?? '-'} qqLines=${data.qq?.lines?.length ?? 0} source=${data.qq?.source ?? '-'}`);
    return sendJson(res, 200, { ...data, tookMs });
  }

  if (method === 'GET' && pathname === '/mood') {
    return sendJson(res, 200, {
      ok: true,
      mood: moodMonitor.mood,
      meta: {
        enabled: moodMonitor.info.enabled,
        intervalMs: moodMonitor.info.intervalMs,
        lastRefreshAt: moodMonitor.info.lastRefreshAt,
        lastSuccessAt: moodMonitor.info.lastSuccessAt,
        tookMs: moodMonitor.info.tookMs,
        lastError: moodMonitor.info.lastError,
        nodeRows: moodMonitor.info.nodeRows,
        memoryCount: moodMonitor.info.memoryCount,
        dbBytes: moodMonitor.info.dbBytes,
        selfNoteDay: moodMonitor.info.selfNoteDay,
        dbPath: cfg.mindDbPath,
        halfLifeDays: cfg.moodHalfLifeDays,
        source: moodMonitor.info.source,
      },
    });
  }
  if (method === 'POST' && pathname === '/mood/refresh') {
    const mood = await moodMonitor.refresh();
    return sendJson(res, 200, { ok: true, mood, meta: moodMonitor.info });
  }

  // 下面是 bridge 内部/CLI 使用的扩展接口（仍只监听 127.0.0.1）。
  if (method === 'GET' && pathname === '/sessions') {
    const items = await listSessionsSafe();
    return sendJson(res, 200, { ok: true, count: items.length, items: items.map(summarizeSession) });
  }
  if (method === 'POST' && pathname === '/ensure') {
    const body = await readJsonBody(req);
    const result = await ensureSession({
      sessionId: body.sessionId ?? cfg.sessionId,
      cwd: body.cwd ?? cfg.cwd,
      agentPreset: body.agentPreset === undefined
        ? (body.sessionId ? undefined : cfg.agentPreset)
        : body.agentPreset,
      createIfMissing: body.createIfMissing !== false,
    });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (method === 'POST' && pathname === '/archive') {
    const body = await readJsonBody(req);
    const sid = assertAllowed(body.sessionId);
    const value = await client.archiveSession(sid);
    const archivedIds = Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : [];
    log.info(`archiveSession ok: ${sid} (archiveSet=${archivedIds.length}, inSet=${archivedIds.includes(sid)})`);
    if (sid === cfg.sessionId) runtime.sessionExists = false;
    return sendJson(res, 200, {
      ok: true,
      sessionId: sid,
      archived: true,
      inArchiveSet: archivedIds.includes(sid),
      archivedCount: archivedIds.length,
      archivedSessionIds: archivedIds,
    });
  }
  if (method === 'POST' && pathname === '/unarchive') {
    const body = await readJsonBody(req);
    const sid = assertAllowed(body.sessionId);
    const value = await client.callUnary('workspace.unarchiveSession', { sessionId: sid }, { timeoutMs: 30000 });
    const archivedIds = Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : [];
    log.info(`unarchiveSession: ${sid} (archiveSet=${archivedIds.length}, inSet=${archivedIds.includes(sid)})`);
    return sendJson(res, 200, {
      ok: true,
      sessionId: sid,
      archived: false,
      inArchiveSet: archivedIds.includes(sid),
      archivedCount: archivedIds.length,
    });
  }
  if (method === 'POST' && pathname === '/say') {
    const body = await readJsonBody(req);
    const result = await sayTurn({
      text: body.text,
      requestId: body.requestId,
      sessionId: body.sessionId ?? cfg.sessionId,
      injectRoleCard: body.injectRoleCard === undefined ? 'auto' : body.injectRoleCard,
    });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (method === 'GET' && pathname === '/history') {
    const sessionId = assertAllowed(url.searchParams.get('session') ?? cfg.sessionId);
    const result = await historyService.getHistory({
      sessionId,
      limit: url.searchParams.get('limit'),
      before: url.searchParams.get('before'),
    });
    return sendJson(res, 200, result);
  }
  if (method === 'GET' && pathname === '/diagnostics') {
    return sendJson(res, 200, {
      ok: true,
      clock: {
        serverOffsetMs: Math.round(client.clockOffsetMs),
        measuredAt: client.clockMeasuredAt || null,
        note: 'serverOffsetMs>0 表示服务器时钟更快；Cookie 时间戳已按服务器时钟铸造',
      },
      mux: {
        connected: follower.opened,
        desiredSessions: [...follower.desired.keys()],
        streams: [...follower.streams.values()],
        frameStats: Object.fromEntries(follower.frameStats),
      },
      lastTurn: runtime.lastTurn,
      roleCard: { sha256: roleCard.sha256, bytes: roleCard.bytes, loadedAt: roleCard.loadedAt },
      clients: {
        wsChat: runtime.wsChatClients,
        lastWsClientAt: runtime.lastWsClientAt,
        lastWsClientAddr: runtime.lastWsClientAddr,
        events: eventHub.info.clients,
      },
      history: {
        source: historyService.lastSource,
        warning: historyService.lastWarning ?? null,
        cacheSize: messageCache.size,
        cacheBySession: eventHub.info.cacheBySession,
        followSessionIds: eventHub.info.followSessionIds,
        running: eventHub.info.running,
      },
      mood: moodMonitor.info,
      context: contextBus.diagnostics(),
      dashboard: dashboardService.info(),
      forbiddenSessionIds: cfg.forbiddenSessionIds,
    });
  }
  if (method === 'GET' && pathname === '/') {
    const body = [
      `dsh-link bridge (${SPEC})`,
      'GET  /health',
      'GET  /state',
      'GET  /mood',
      'POST /mood/refresh',
      'GET  /dashboard        (需 token：总控台聚合)',
      'GET  /context?limit=20',
      'POST /context {"events":[{at,surface,kind,summary,private?}]}  (需 token)',
      'GET  /history?session=pet-local&limit=200[&before=<messageId>]',
      'GET  /sessions',
      'POST /ensure  {"sessionId"?,"cwd"?,"agentPreset"?}',
      'POST /say     {"text","requestId"?,"sessionId"?,"injectRoleCard"?:true|false|"auto"}',
      'POST /archive {"sessionId"}',
      'GET  /diagnostics',
      'WS   /chat?token=<bridge token>',
      'WS   /events?token=<bridge token>[&session=pet-local]',
      '',
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(body);
  }

  sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${method} ${pathname}` } });
}

function createHttpServer() {
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log.warn(`HTTP ${req.method} ${req.url} 失败: ${error.message}`);
      if (!res.headersSent) sendError(res, error);
      else try { res.end(); } catch { /* ignore */ }
    });
  });
  // 注意：**多个 WS 端点必须用一次 attachWebSocketEndpoints 挂载**（单一 upgrade 分发器）。
  // 旧写法给每个端点各挂一个 upgrade 监听器，Node 按注册顺序调用、第一个不匹配就 destroy，
  // 导致后注册的端点（/events）握手必失败（T11 面板联调实测）。
  attachWebSocketEndpoints(server, [
    {
      path: '/chat',
      isTokenValid: (provided) => typeof provided === 'string' && provided.length > 0 && provided === token,
      onConnection: (conn, req) => {
        runtime.wsChatClients += 1;
        runtime.lastWsClientAt = Date.now();
        runtime.lastWsClientAddr = req?.socket?.remoteAddress ?? '?';
        log.info(`ws /chat 客户端已连接（当前 ${runtime.wsChatClients} 个）`);
        let currentRequestId = null;
        conn.on('message', (raw) => {
          let message;
          try {
            message = JSON.parse(raw);
          } catch {
            conn.sendJson({ type: 'error', code: 'bad-request', message: '不是合法 JSON' });
            return;
          }
          if (message?.type !== 'say') {
            conn.sendJson({ type: 'error', code: 'bad-request', message: `未知消息类型 ${String(message?.type)}` });
            return;
          }
          if (currentRequestId || runtime.busy) {
            conn.sendJson({ type: 'error', requestId: message.requestId ?? null, code: 'busy', message: '还在想上一句' });
            return;
          }
          const requestId = typeof message.requestId === 'string' && message.requestId
            ? message.requestId : randomUUID();
          currentRequestId = requestId;
          conn.sendJson({ type: 'accepted', requestId });
          sayTurn({
            text: message.text,
            requestId,
            sessionId: message.sessionId ?? cfg.sessionId,
            injectRoleCard: message.injectRoleCard === undefined ? 'auto' : message.injectRoleCard,
            onDelta: (deltaText) => conn.sendJson({ type: 'delta', requestId, text: deltaText }),
          }).then((result) => {
            conn.sendJson({ type: 'final', requestId, text: result.text });
          }).catch((error) => {
            conn.sendJson({ type: 'error', requestId, code: error?.code ?? 'internal', message: error?.message ?? String(error) });
          }).finally(() => {
            currentRequestId = null;
          });
        });
        conn.on('close', () => {
          runtime.wsChatClients = Math.max(0, runtime.wsChatClients - 1);
          log.info(`ws /chat 客户端已断开（当前 ${runtime.wsChatClients} 个）`);
        });
      },
    },
    {
      // panel protocol §2：WS /events（snapshot + message + status + ping）
      path: '/events',
      isTokenValid: (provided) => typeof provided === 'string' && provided.length > 0 && provided === token,
      onConnection: (conn, req) => {
        let requestedSession = null;
        try {
          requestedSession = new URL(req.url, 'http://127.0.0.1').searchParams.get('session');
        } catch { /* ignore */ }
        eventHub.addClient(conn, { sessionId: requestedSession }).catch((error) => {
          log.error(`ws /events 接入失败: ${error.message}`);
          try {
            conn.sendJson({ type: 'error', code: 'internal', message: error.message });
            conn.close(1011, 'internal error');
          } catch { /* ignore */ }
        });
      },
    },
  ], { log });
  return server;
}

function startHttpServer(port, attemptsLeft = 20) {
  const server = createHttpServer();
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      log.warn(`apiPort ${port} 被占用，自增重试 -> ${port + 1}`);
      startHttpServer(port + 1, attemptsLeft - 1);
      return;
    }
    setError(error, `listen ${port}`);
    log.error(`HTTP 服务启动失败: ${error.message}`);
  });
  server.listen(port, cfg.listenHost, () => {
    httpServer = server;
    runtime.apiPort = port;
    releaseProcLock(START_LOCK_FILE); // bootstrap 窗口结束，正常防双开交给 /health 探测
    log.info(`bridge ready: http://${cfg.listenHost}:${port}  (tunnel 127.0.0.1:${ssh.port} -> ${cfg.serverHost}:${cfg.remoteDshPort})`);
    log.info(`ws chat: ws://${cfg.listenHost}:${port}/chat?token=<token.txt>`);
    log.info(`ws events: ws://${cfg.listenHost}:${port}/events?token=<token.txt>（follow: ${eventHub.info.followSessionIds.join(', ')}）`);
    stateStore.update({ apiPort: port, localTunnelPort: ssh.port, sessionId: cfg.sessionId, updatedAt: Date.now() });
  });
  return server;
}

// ─────────────────────────── 启动 / 后台重试 ───────────────────────────
async function ensureReady() {
  if (!ssh.tunnelUp) return false;
  if (!client._cookie) {
    try {
      await client.ensureCookie();
      log.info('DSH cookie minted');
    } catch (error) {
      setError(error, 'cookie');
      return false;
    }
  }
  if (!roleCard.text) {
    try {
      await roleCard.load();
    } catch (error) {
      log.warn(`角色卡读取失败（稍后重试）: ${error.message}`);
    }
  }
  if (!runtime.followerStarted) {
    runtime.followerStarted = true;
    follower.start().catch((error) => log.error(`mux start 失败: ${error.message}`));
  }
  if (!runtime.eventsStarted) {
    runtime.eventsStarted = true;
    eventHub.start();
  }
  if (!runtime.moodStarted && cfg.moodEnabled !== false) {
    runtime.moodStarted = true;
    moodMonitor.start();
  }
  if (!runtime.dashboardWarmed) {
    runtime.dashboardWarmed = true;
    dashboardService.warm(); // 预热 SSH 缓存（systemctl / social-v2），让首次 /dashboard 也 <2s
    dashboardService.start(); // 后台预取：缓存接近过期提前刷新（stale-while-revalidate）
  }
  return true;
}

async function bootstrap() {
  log.info(`dsh-link bridge 启动: config=${CONFIG_PATH} token=${tokenCreated ? 'newly-created' : 'loaded'} spec=${SPEC}`);
  log.info(`red-line forbiddenSessionIds: ${cfg.forbiddenSessionIds.join(', ')}`);
  ssh.start();
  const tunnelUp = await ssh.waitUntilUp(30000);
  log.info(`ssh tunnel up: ${tunnelUp}`);
  if (!tunnelUp) {
    setError(new Error('SSH 隧道 30s 内未就绪，继续后台重试'), 'bootstrap');
    return false;
  }
  const ready = await ensureReady();
  if (!ready) return false;
  try {
    const items = await refreshSessionState();
    log.info(`session/list: ${items.length} 个会话（已过滤 forbidden）；${cfg.sessionId} exists=${runtime.sessionExists}`);
  } catch (error) {
    setError(error, 'session/list');
  }
  if (cfg.ensureOnStart) {
    try {
      const result = await ensureSession({ sessionId: cfg.sessionId, agentPreset: cfg.agentPreset });
      log.info(`ensureOnStart: session=${result.sessionId} created=${result.created} agentPreset=${result.agentPreset ?? '(none)'}`);
    } catch (error) {
      setError(error, 'ensureOnStart');
    }
  }
  return true;
}

let retryTimer = null;
let supervisorTick = 0;
function startRetryLoop() {
  retryTimer = setInterval(async () => {
    if (runtime.stopping) return;
    // 守护保活：每 6 次（约 60s）确认 supervisor 还活着；它若被误杀，bridge 自己把它拉回来。
    supervisorTick += 1;
    if (supervisorTick % 6 === 0) ensureSupervisor('keepalive');
    try {
      if (!ssh.tunnelUp) return; // ssh 自己会重连
      await ensureReady();
      if (Date.now() - runtime.lastApiOkAt > 60000 && !runtime.busy) {
        await refreshSessionState();
      }
    } catch (error) {
      setError(error, 'retry-loop');
    }
  }, 10000);
}

function shutdown(signal) {
  if (runtime.stopping) return;
  runtime.stopping = true;
  log.info(`bridge 退出 (${signal})`);
  releaseProcLock(START_LOCK_FILE);
  // 正常退出时给守护留停止标记，让它别把 bridge 又拉起来；硬杀（taskkill /F）不会走到这里 → 守护会重拉。
  if (!ONCE && !NO_SUPERVISOR) {
    try {
      fs.writeFileSync(SUPERVISOR_STOP_FILE, `${JSON.stringify({ at: Date.now(), reason: `bridge-shutdown:${signal}` })}\n`);
    } catch { /* ignore */ }
  }
  if (retryTimer) clearInterval(retryTimer);
  try { dashboardService.stop(); } catch { /* ignore */ }
  try { eventHub.stop(); } catch { /* ignore */ }
  try { moodMonitor.stop(); } catch { /* ignore */ }
  try { follower.stop(); } catch { /* ignore */ }
  try { ssh.stop(); } catch { /* ignore */ }
  try { httpServer?.close(); } catch { /* ignore */ }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shutdown(signal);
    setTimeout(() => process.exit(0), 300);
  });
}
process.on('uncaughtException', (error) => {
  setError(error, 'uncaughtException');
  log.error(`uncaughtException: ${error.stack ?? error.message}`);
});
process.on('unhandledRejection', (reason) => {
  setError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
  log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

/** 防双开：若目标端口上已有本 bridge 在跑（/health 返回 spec=bridge-protocol-v1），直接退出 0。 */
async function detectRunningBridge() {
  const ports = new Set([cfg.apiPort]);
  try {
    const state = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    if (Number.isInteger(state?.apiPort)) ports.add(state.apiPort);
  } catch { /* state 可能还不存在 */ }
  for (const port of ports) {
    try {
      const response = await fetch(`http://${cfg.listenHost}:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const body = await response.json();
      if (body?.ok === true && body?.spec === SPEC) {
        return { pid: body.pid, apiPort: port, health: body };
      }
    } catch { /* 端口没人 / 不是本 bridge */ }
  }
  return null;
}

if (!ONCE) {
  const existing = await detectRunningBridge();
  if (existing) {
    console.log(`[dsh-link-bridge] 已在运行: pid=${existing.pid} apiPort=${existing.apiPort}（防双开，本进程退出）`);
    log.info(`防双开：检测到已在运行的 bridge pid=${existing.pid} apiPort=${existing.apiPort}，本进程退出`);
    process.exit(0);
  }
}

// 拉起 supervisor 守护（崩溃 / 被杀 / 卡死后自动重拉 bridge；已有守护则复用）。
if (!ONCE) {
  try { fs.rmSync(SUPERVISOR_STOP_FILE, { force: true }); } catch { /* ignore */ }
  ensureSupervisor(SUPERVISED ? 'bridge-start(supervised)' : 'bootstrap');
}

const ready = await bootstrap();
if (ONCE) {
  const health = buildHealth();
  log.info(`--once: server.up=${health.server.up} tunnel=${health.server.tunnel} roleCardSha256=${health.auth.roleCardSha256 ?? '-'}`);
  process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  shutdown('--once');
  process.exit(health.server.up ? 0 : 1);
}

startHttpServer(cfg.apiPort);
startRetryLoop();
if (!ready) {
  log.warn('bootstrap 未完全成功，服务已启动并将在后台持续重试');
}
