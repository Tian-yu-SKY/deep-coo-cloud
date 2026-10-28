#!/usr/bin/env node
/**
 * dsh-link/context-observer/observer.mjs — 本机情境观察器（T14 / Phase 5）。
 *
 * 「本机的眼睛」：观察主人在电脑上做什么（前台窗口）以及本机 DSH 在哪个会话干活，
 * 把**变化**摘要成情境事件，POST 给本机 bridge 的 `POST /context`（T13），
 * 由 bridge 注入到「鲸歌」人格的每一轮对话里（桌宠 / 面板 / 服务器会话共享）。
 *
 * 设计原则：
 *  - 只用 node 内置模块 + Windows 自带 PowerShell；不需要 npm 依赖；
 *  - 只采「前台窗口的进程名 + 窗口标题」与「本机 DSH 会话标题/运行状态」，
 *    **不采屏幕像素、不采键盘/输入内容、不采聊天正文、不读任何文档内容**；
 *  - 隐私 blocklist（密码/银行/私钥/token…）命中：不推标题，只推进程名，并标 private；
 *  - `PAUSED` 文件（或 `--paused`）存在时暂停采集与推送，删除后自动恢复；
 *  - bridge 不在/接口未就绪：事件本地排队（最多 20 条）重试，不丢、不阻塞；
 *  - 单实例锁；日志 `logs/observer.log`（2MB 滚动）；`state.json` 记录最近观察/推送。
 *
 * 运行：
 *   node observer.mjs                    # 常驻（按间隔采集并推送）
 *   node observer.mjs --once             # 只跑一轮（采集+推送），打印 JSON，退出
 *   node observer.mjs --once --no-push   # 只采集不推送（隐私/调试）
 *   node observer.mjs --paused           # 启动即暂停（等价于放一个 PAUSED 文件）
 *   node observer.mjs --verbose          # 同时把日志打到 stdout
 *   node observer.mjs --config custom.json
 *
 * 事件格式（与 bridge /context 契约一致）：
 *   { at: <ms>, surface: 'desktop'|'dsh-local', kind: 'window'|'session', summary: '<200 字以内>', private: false }
 */

import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 脚本所在目录（所有相对路径以它为准）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 本文件版本。 */
export const VERSION = '1.0.0';

/** 默认配置；`config.json`（若存在）与 CLI 参数会覆盖。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 前台窗口采样间隔（任务要求 15–20s）。 */
  foregroundIntervalMs: 18_000,
  /** 本机 DSH 会话采样间隔。 */
  dshIntervalMs: 30_000,
  /**
   * 心跳重推间隔：把「当前前台窗口 + 本机 DSH 活跃会话（≤2）」按原 summary 再推一遍。
   * bridge 对相同 summary 去重合并（hits+1 / at 刷新），所以不会刷屏；
   * 作用：bridge 重启导致 /context 缓冲清零后，不用等下一次窗口切换就能恢复情境。
   */
  heartbeatMs: 60_000,
  /** bridge 状态探测间隔：GET /health 的 pid 变化或 /context 为空 → 立即重推。 */
  bridgeHealthIntervalMs: 30_000,
  /** bridge 状态探测超时。 */
  bridgeProbeTimeoutMs: 5_000,
  /** 本机 DSH「活跃」判定：最近这么多毫秒内更新过。 */
  dshActiveWindowMs: 30 * 60 * 1000,
  /** 同时推的活跃 DSH 会话上限（1–2 个就够；多了会挤占注入额度）。 */
  dshSessionsMax: 2,
  /** 是否把 subagent/teammate 子会话算进「本机 DSH 活跃会话」。 */
  includeSubagentSessions: false,
  /** 本机 DSH Web 地址。 */
  dshUrl: 'http://127.0.0.1:53316',
  /** 本机 DSH 的 $DSH_HOME（空 = 环境变量 DSH_HOME 或 ~/.dsh）。 */
  dshHome: '',
  /** bridge HTTP 地址。 */
  bridgeUrl: 'http://127.0.0.1:47891',
  /** bridge token 文件。 */
  bridgeTokenFile: '<your-workspace>/dsh-link/bridge/token.txt',
  /** PAUSED 开关文件（相对本目录）。 */
  pausedFile: 'PAUSED',
  /** 单实例锁文件（相对本目录）。 */
  lockFile: 'observer.lock',
  /** 状态文件（相对本目录）。 */
  stateFile: 'state.json',
  /** 日志文件（相对本目录）。 */
  logFile: 'logs/observer.log',
  /** 日志滚动阈值（字节）。 */
  logMaxBytes: 2 * 1024 * 1024,
  /** 本地排队上限。 */
  maxQueue: 20,
  /** 单次 POST 最多带多少条事件（bridge 批量 upsert）。 */
  maxBatch: 10,
  /** POST /context 超时。 */
  pushTimeoutMs: 8_000,
  /** PowerShell 子进程超时。 */
  execTimeoutMs: 10_000,
  /** 标题截断上限（字）。 */
  titleMaxChars: 80,
  /** 单条窗口摘要总长上限（字）：bridge 注入预算有限，P1 建议 ≤60。 */
  summaryMaxChars: 60,
  /** 会话标题截断上限（字）。 */
  sessionTitleMaxChars: 60,
  /** 隐私 blocklist：标题命中 → 不推标题、只推进程名 + private。 */
  blocklistKeywords: [
    'password', 'passwd', '密码', '银行', '网银', 'bank', '私钥', 'private key', 'id_rsa',
    'seed phrase', '助记词', 'token', 'secret', 'api key', 'apikey', '密钥', '信用卡', 'credit card',
    '身份证', '1password', 'bitwarden', 'keepass', 'lastpass', 'kdbx', '密码卡',
  ],
  /** 隐私 blocklist：进程名命中 → 视为敏感窗口。 */
  blocklistProcesses: [
    '1password', 'bitwarden', 'keepass', 'lastpass', 'dashlane', 'keeper', 'enpass', 'protonpass',
  ],
  /**
   * 聊天/IM 类进程：只推进程名 + 「（聊天）」，**不推窗口标题**，避免群名/联系人泄漏；
   * 仍作为公开事件（persona 可以知道「主人在用 QQ/微信」），不标 private。
   * 需要更严格时把它也加进 blocklistProcesses（那就完全不注入）。
   */
  hideTitleProcesses: [
    'qq', 'wechat', '微信', 'telegram', 'discord', 'slack', 'whatsapp', 'wecom', '企业微信',
    'dingtalk', '钉钉', 'feishu', 'lark', 'line', 'signal',
  ],
  /** blocklist 命中时是否标 private（bridge 不返回/不注入，只计数）。 */
  privateOnBlocklist: true,
  /** PowerShell 可执行文件候选。 */
  powershellCandidates: ['pwsh.exe', 'powershell.exe'],
});

// ───────────────────────────── 小工具 ─────────────────────────────

/** 等一会儿。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** 去掉控制字符/零宽字符、折叠空白。 */
export function normalizeText(value, maxLength = 10_000) {
  const text = String(value ?? '')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** 截断到 maxChars（含省略号也不超过 maxChars）。 */
export function truncateText(value, maxChars = 80) {
  const text = normalizeText(value, Math.max(1, maxChars * 4));
  const limit = Math.max(1, Number(maxChars) || 80);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

/** 进程名归一化（去 .exe、去空白；无则 '未知程序'）。 */
export function normalizeProcessName(value) {
  const text = normalizeText(value, 120).replace(/\.exe$/i, '').trim();
  return text === '' ? '' : text;
}

// ───────────────────────────── 隐私与窗口摘要 ─────────────────────────────

/**
 * 是否命中隐私 blocklist（标题关键词或进程名）。
 * @param {string} processName 进程名
 * @param {string} title 窗口标题
 * @param {Record<string, any>} cfg
 */
export function isSensitiveWindow(processName, title, cfg = DEFAULT_CONFIG) {
  const processLower = normalizeProcessName(processName).toLowerCase();
  const titleLower = normalizeText(title, 2_000).toLowerCase();
  const keywordHit = (cfg.blocklistKeywords ?? []).some((keyword) => {
    const needle = String(keyword ?? '').trim().toLowerCase();
    return needle !== '' && titleLower.includes(needle);
  });
  if (keywordHit) return true;
  return (cfg.blocklistProcesses ?? []).some((entry) => {
    const needle = String(entry ?? '').trim().toLowerCase();
    return needle !== '' && processLower.includes(needle);
  });
}

// 常见应用名后缀：窗口标题常以「 - 应用名」结尾，注入 prompt 时是噪音（P1 可读性）。
const APP_NAME_SUFFIXES = [
  'Microsoft Edge', 'Google Chrome', 'Mozilla Firefox', 'Visual Studio Code', 'DeepSeek Harness',
  'Windows Terminal', 'Notepad', 'Brave', 'Opera', 'Vivaldi', 'Safari', '微信', 'WeChat', 'QQ',
];
/** 终端类进程：路径式标题只输出「（终端）」。 */
const TERMINAL_PROCESS_NAMES = new Set([
  'bash', 'cmd', 'powershell', 'pwsh', 'conhost', 'windowsterminal', 'wt', 'mintty', 'msys2', 'zsh', 'sh',
]);

/** 标题是否像一个文件系统路径（终端窗口常把 cwd/命令行当标题）。 */
export function looksLikePath(text) {
  const value = normalizeText(text, 500);
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/[\w.-]+\//.test(value);
}

/** 取路径最后一段（去掉 .exe；取不到返回空串）。 */
export function pathBasename(text) {
  const value = normalizeText(text, 500);
  const parts = value.split(/[\\/]+/).filter((part) => part !== '');
  const last = parts.length > 0 ? parts[parts.length - 1] : '';
  return last.replace(/\.exe$/i, '').trim();
}

/**
 * 清洗窗口标题：去掉路径式标题与尾部重复的应用名（bridge owner 的 P1 建议）。
 * 例：`C:\Users\...\bin\bash`（进程 bash）→ `（终端）`；
 *     `标题 - 个人 - Microsoft Edge` → `标题`；`标题 — DeepSeek Harness` → `标题`。
 * @param {string} processName
 * @param {string} title
 * @returns {string} 清洗后的标题（可能是空串或 `（终端）`）
 */
export function cleanWindowTitle(processName, title) {
  const processNameLower = normalizeProcessName(processName).toLowerCase();
  let text = normalizeText(title, 4_000);
  if (text === '') return '';
  if (looksLikePath(text)) {
    const base = pathBasename(text).toLowerCase();
    if (TERMINAL_PROCESS_NAMES.has(processNameLower) || TERMINAL_PROCESS_NAMES.has(base)) return '（终端）';
    return pathBasename(text);
  }
  // 去掉尾部应用名；Edge/Chrome 会多一段配置名（如「 - 个人 - Microsoft Edge」），先整段剥。
  for (let round = 0; round < 2; round += 1) {
    const before = text;
    for (const appName of APP_NAME_SUFFIXES) {
      const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const withProfile = new RegExp(`\\s+[-—–|]\\s+[^-—–|]{1,24}\\s+[-—–|]\\s+${escaped}$`);
      const plain = new RegExp(`\\s+[-—–|]\\s+${escaped}$`);
      text = text.replace(withProfile, '').replace(plain, '').trim();
    }
    if (text === before) break;
  }
  return text;
}

/** 进程名是否命中某个列表（精确或「前缀 + 非字母后缀」，避免 qq 误伤 qqmusic）。 */
function matchesProcessName(processNameLower, entries) {
  return (entries ?? []).some((entry) => {
    const needle = String(entry ?? '').trim().toLowerCase();
    if (needle === '') return false;
    if (processNameLower === needle) return true;
    if (!processNameLower.startsWith(needle)) return false;
    return /^[^a-z]/.test(processNameLower.slice(needle.length));
  });
}

/**
 * 把一个前台窗口变成情境摘要（标题清洗/截断；命中 blocklist 只留进程名）。
 * 摘要总长受 `summaryMaxChars`（默认 60）限制，避免占用注入额度。
 * @param {{ process?: string, title?: string }} windowInfo
 * @param {Record<string, any>} [cfg]
 * @returns {{ summary: string, private: boolean, sensitive: boolean }}
 */
export function summarizeWindow(windowInfo, cfg = DEFAULT_CONFIG) {
  const processName = normalizeProcessName(windowInfo?.process);
  const rawTitle = truncateText(windowInfo?.title ?? '', cfg.titleMaxChars ?? 80);
  const sensitive = isSensitiveWindow(processName, rawTitle, cfg);
  if (sensitive) {
    return {
      summary: processName === '' ? '未知程序' : processName,
      private: cfg.privateOnBlocklist !== false,
      sensitive: true,
    };
  }
  const title = cleanWindowTitle(processName, rawTitle);
  const maxChars = Math.max(12, Number(cfg.summaryMaxChars) || DEFAULT_CONFIG.summaryMaxChars);
  const build = (candidate) => truncateText(candidate, maxChars);
  // 聊天/IM 类：只告诉 persona「在用什么」，绝不带出群名/联系人等标题内容。
  if (processName !== '' && matchesProcessName(processName.toLowerCase(), cfg.hideTitleProcesses)) {
    return { summary: build(`${processName}（聊天）`), private: false, sensitive: false };
  }
  if (processName === '' && title === '') return { summary: '', private: false, sensitive: false };
  if (title === '') return { summary: build(processName), private: false, sensitive: false };
  if (processName === '') return { summary: build(title), private: false, sensitive: false };
  if (title === '（终端）') return { summary: build(`${processName}（终端）`), private: false, sensitive: false };
  return { summary: build(`${processName} · ${title}`), private: false, sensitive: false };
}

/** 窗口变化判重 key（进程 + 归一化标题）。 */
export function windowKey(windowInfo) {
  return `${normalizeProcessName(windowInfo?.process).toLowerCase()}|${normalizeText(windowInfo?.title ?? '', 2_000)}`;
}

/**
 * 前台窗口 → 一条 bridge 情境事件；无窗口信息时返回 null。
 * @param {{ process?: string, title?: string }} windowInfo
 * @param {Record<string, any>} [cfg]
 * @param {number} [at]
 */
export function buildWindowEvent(windowInfo, cfg = DEFAULT_CONFIG, at = Date.now()) {
  const summary = summarizeWindow(windowInfo, cfg);
  if (summary.summary === '') return null;
  return { at, surface: 'desktop', kind: 'window', summary: summary.summary, private: summary.private };
}

// ───────────────────────────── 本机 DSH 会话 ─────────────────────────────

/** 解析本机 DSH 的 home（优先显式配置，其次 DSH_HOME，最后 ~/.dsh）。 */
export function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') return process.env.DSH_HOME.trim();
  return path.join(os.homedir(), '.dsh');
}

const base64url = (value) => Buffer.from(value).toString('base64')
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/, '');

/**
 * 从 `$DSH_HOME/.credentials.yaml` 读 browser-session secret。
 * 只读本机文件；调用方不得把返回值/ cookie 写进日志。
 * @param {string} dshHome
 * @returns {Buffer}
 */
export function readBrowserSessionSecret(dshHome) {
  const file = path.join(dshHome, '.credentials.yaml');
  const text = readFileSync(file, 'utf8');
  const match = text.match(/client-connection\/browser-session:[\s\S]{0,400}?secret:\s*([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`browser-session secret 不在 ${file}`);
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

/**
 * 离线铸 DSH 浏览器 cookie（算法与 `dsh-link/probe.mjs` / qq-bridge dsh-client.js 一致）。
 * @param {string} dshUrl
 * @param {Buffer} secret
 * @param {number} [now]
 */
export function mintDshCookie(dshUrl, secret, now = Date.now()) {
  const authority = new URL(dshUrl).host;
  const body = base64url(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 3_600_000,
  }), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(body).digest());
  const name = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`;
  return `${name}=v1.${body}.${signature}`;
}

/** 构造 `session/list` 的 client-request 信封。 */
export function buildSessionListEnvelope(rpcId = randomUUID()) {
  return {
    type: 'client-request',
    rpcId,
    method: 'session/list',
    payload: { args: { _request: {} } },
  };
}

/**
 * 从 session/list 的 items 里挑出「活跃会话」：
 * running=true 或最近 dshActiveWindowMs 内更新过；默认排除空白会话与 subagent 子会话。
 * @param {Array<Record<string, any>>} items
 * @param {{ now?: number, cfg?: Record<string, any> }} [options]
 * @returns {Array<{ sessionId: string, title: string, running: boolean, updatedAt: number }>}
 */
export function selectDshActivity(items, options = {}) {
  const cfg = options.cfg ?? DEFAULT_CONFIG;
  const now = options.now ?? Date.now();
  const activeWindowMs = Math.max(60_000, Number(cfg.dshActiveWindowMs) || DEFAULT_CONFIG.dshActiveWindowMs);
  const includeSubagent = cfg.includeSubagentSessions === true;
  const list = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.blank === true) continue;
    if (!includeSubagent && (item.parentSessionId !== undefined && item.parentSessionId !== null)) continue;
    const running = item.running === true;
    const updatedAt = Number(item.updatedAt);
    const recent = Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt <= activeWindowMs;
    if (!running && !recent) continue;
    const title = truncateText(item.projections?.values?.title ?? '', cfg.sessionTitleMaxChars ?? 60) || '未命名会话';
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId : '';
    if (sessionId === '') continue;
    list.push({ sessionId, title, running, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 });
  }
  list.sort((left, right) => (Number(right.running) - Number(left.running)) || (right.updatedAt - left.updatedAt));
  const max = Math.max(1, Number(cfg.dshSessionsMax) || DEFAULT_CONFIG.dshSessionsMax);
  return list.slice(0, max);
}

/** 活跃会话 → bridge 情境事件（标题命中 blocklist 时隐藏标题并标 private）。 */
export function buildDshSessionEvents(activeSessions, cfg = DEFAULT_CONFIG, at = Date.now()) {
  const events = [];
  for (const session of Array.isArray(activeSessions) ? activeSessions : []) {
    const status = session.running ? '运行中' : '刚更新';
    const sensitive = isSensitiveWindow('', session.title, cfg);
    if (sensitive) {
      events.push({
        at,
        surface: 'dsh-local',
        kind: 'session',
        summary: `「已隐藏标题的会话」（${status}）`,
        private: cfg.privateOnBlocklist !== false,
      });
      continue;
    }
    events.push({
      at,
      surface: 'dsh-local',
      kind: 'session',
      summary: `「${session.title}」（${status}）`,
      private: false,
    });
  }
  return events;
}

/**
 * 采集一次本机 DSH 活跃会话（离线 cookie + POST /api/session/list）。
 * 不写任何文件、不触发模型。
 * @param {{ dshUrl?: string, dshHome?: string, timeoutMs?: number }} [options]
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [deps]
 * @returns {Promise<{ ok: boolean, active: Array<any>, total: number, error?: string }>}
 */
export async function collectDshActivity(options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now();
  const dshUrl = String(options.dshUrl ?? DEFAULT_CONFIG.dshUrl).replace(/\/+$/, '');
  const dshHome = resolveDshHome(options.dshHome ?? DEFAULT_CONFIG.dshHome);
  const timeoutMs = Number(options.timeoutMs) || 15_000;
  try {
    const secret = readBrowserSessionSecret(dshHome);
    const cookie = mintDshCookie(dshUrl, secret, now);
    const response = await fetchImpl(`${dshUrl}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, accept: 'application/json' },
      body: JSON.stringify(buildSessionListEnvelope()),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`session/list HTTP ${response.status}`);
    const payload = await response.json();
    if (payload && payload.result && payload.result.ok === false) {
      throw new Error(`session/list 失败：${payload.result.error?.message ?? 'unknown'}`);
    }
    const items = payload?.result?.value?.items;
    if (!Array.isArray(items)) throw new Error('session/list 返回结构不认识（缺 result.value.items）');
    const cfg = { ...DEFAULT_CONFIG, ...options };
    const active = selectDshActivity(items, { now, cfg });
    return { ok: true, active, total: items.length };
  } catch (error) {
    return { ok: false, active: [], total: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// ───────────────────────────── 前台窗口（PowerShell P/Invoke） ─────────────────────────────

/**
 * 一次调用取当前前台窗口的 {pid, process, title}。
 * 用 EncodedCommand（UTF-16LE base64）传脚本：不落临时 .ps1、不受执行策略影响。
 * 返回 UTF-8 JSON 一行。
 */
export const FOREGROUND_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Windows PowerShell 5.1 默认按 OEM/GBK 输出；显式改 UTF-8，避免中文标题变乱码。
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}',
  "$src = @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class W {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
  '}',
  "'@",
  'Add-Type -TypeDefinition $src',
  '$handle = [W]::GetForegroundWindow()',
  '$sb = New-Object System.Text.StringBuilder 2048',
  '[void][W]::GetWindowText($handle, $sb, 2048)',
  // 注意：$PID 是 PowerShell 只读自动变量，这里必须叫 $windowPid（大小写不敏感，$pid 会炸）。
  '[uint32]$windowPid = 0',
  '[void][W]::GetWindowThreadProcessId($handle, [ref]$windowPid)',
  '$processName = $null',
  'if ($windowPid -gt 0) { try { $processName = (Get-Process -Id $windowPid -ErrorAction Stop).ProcessName } catch {} }',
  '[pscustomobject]@{ windowPid = $windowPid; process = $processName; title = $sb.ToString() } | ConvertTo-Json -Compress',
].join('\n');

/** PowerShell 脚本 → `-EncodedCommand` 参数（UTF-16LE base64）。 */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * 解码 PowerShell 子进程 stdout。
 * 优先 UTF-8（脚本里已把 OutputEncoding 设成 UTF-8）；若出现替换字符（U+FFFD），
 * 再尝试按 GBK 解码——双保险，避免 Windows PowerShell 5.1 的 OEM 代码页把中文窗口标题弄乱。
 * @param {Buffer|Uint8Array|string} output
 * @returns {string}
 */
export function decodePowerShellOutput(output) {
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output ?? '');
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(buffer);
    if (!gbk.includes('\uFFFD')) return gbk;
  } catch {
    /* 运行时没有 GBK 解码器就保持 UTF-8 结果 */
  }
  return utf8;
}

/** 从 PowerShell 输出里取最后一行 JSON（兼容偶发 Warning 行）。 */
export function parseForegroundOutput(stdout) {
  const text = decodePowerShellOutput(stdout).trim();
  if (text === '') throw new Error('PowerShell 没有输出');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{') && line.endsWith('}'));
  const line = lines.length > 0 ? lines[lines.length - 1] : text;
  const parsed = JSON.parse(line);
  return {
    pid: Number(parsed.windowPid ?? parsed.pid) || null,
    process: normalizeProcessName(parsed.process),
    title: normalizeText(parsed.title ?? '', 4_000),
  };
}

/** 已探测到的 PowerShell 可执行文件（进程内缓存，避免每 18s 重复探测）。 */
let cachedPowerShell = null;

/**
 * 选一个可用的 PowerShell：优先 pwsh（PowerShell 7，默认 UTF-8），退到 powershell.exe。
 * @param {string[]} [candidates]
 * @param {{ execFileImpl?: typeof execFile }} [deps]
 * @returns {Promise<{ executable: string, version: string }>}
 */
export async function resolvePowerShellExecutable(candidates = DEFAULT_CONFIG.powershellCandidates, deps = {}) {
  if (cachedPowerShell !== null) return cachedPowerShell;
  const execFileImpl = deps.execFileImpl ?? execFile;
  const list = Array.isArray(candidates) && candidates.length > 0 ? candidates : DEFAULT_CONFIG.powershellCandidates;
  let lastError = null;
  for (const executable of list) {
    try {
      const version = await new Promise((resolve, reject) => {
        execFileImpl(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
          timeout: 8_000,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 8 * 1024,
        }, (error, out) => {
          if (error) reject(error);
          else resolve(String(out ?? '').trim());
        });
      });
      cachedPowerShell = { executable, version: version || 'unknown' };
      return cachedPowerShell;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`找不到可用的 PowerShell（试过 ${list.join(', ')}）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** 测试用：清掉 PowerShell 探测缓存。 */
export function resetPowerShellCache() {
  cachedPowerShell = null;
}

/**
 * 采集一次前台窗口。失败时返回 { ok:false, error }，绝不抛出（观察器不应因此退出）。
 * @param {{ execFileImpl?: typeof execFile, timeoutMs?: number, powershellCandidates?: string[], executable?: string }} [options]
 */
export async function collectForegroundInfo(options = {}) {
  const execFileImpl = options.execFileImpl ?? execFile;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_CONFIG.execTimeoutMs;
  const encoded = encodePowerShellCommand(FOREGROUND_PS_SCRIPT);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  let candidates;
  if (typeof options.executable === 'string' && options.executable !== '') {
    candidates = [options.executable];
  } else {
    try {
      candidates = [(await resolvePowerShellExecutable(options.powershellCandidates, { execFileImpl })).executable];
    } catch (error) {
      // 探测失败也再直接试一遍候选（例如权限/瞬时错误），保留可诊断的错误信息。
      candidates = Array.isArray(options.powershellCandidates) && options.powershellCandidates.length > 0
        ? options.powershellCandidates
        : DEFAULT_CONFIG.powershellCandidates;
      void error;
    }
  }
  let lastError = null;
  for (const executable of candidates) {
    try {
      const output = await new Promise((resolve, reject) => {
        execFileImpl(executable, args, {
          timeout: timeoutMs,
          windowsHide: true,
          encoding: 'buffer',
          maxBuffer: 64 * 1024,
        }, (error, out) => {
          if (error) reject(error);
          else resolve(out);
        });
      });
      return { ok: true, ...parseForegroundOutput(output) };
    } catch (error) {
      lastError = error;
      // 缓存的 PowerShell 失效（例如被卸载）时清掉缓存，下次重新探测。
      if (error && error.code === 'ENOENT') cachedPowerShell = null;
    }
  }
  return {
    ok: false,
    pid: null,
    process: '',
    title: '',
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

// ───────────────────────────── 推送 / 上下文总线 ─────────────────────────────

/** 读 bridge token（hex）；失败返回 null。 */
export function readBridgeToken(tokenFile) {
  try {
    const token = readFileSync(tokenFile, 'utf8').trim();
    return /^[0-9a-fA-F]{16,128}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * `/context` 推送器：批量 POST、bridge 不可用时本地排队（有上限）。
 * token 每次推送时重新读（bridge 换 token 不用重启观察器）。
 * @param {{
 *   bridgeUrl?: string, tokenProvider?: () => (string|null|Promise<string|null>),
 *   fetchImpl?: typeof fetch, log?: any, maxQueue?: number, maxBatch?: number,
 *   timeoutMs?: number, now?: () => number,
 * }} [options]
 */
export function createPusher(options = {}) {
  const bridgeUrl = String(options.bridgeUrl ?? DEFAULT_CONFIG.bridgeUrl).replace(/\/+$/, '');
  const tokenProvider = options.tokenProvider ?? (() => null);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? null;
  const maxQueue = Math.max(1, Number(options.maxQueue) || DEFAULT_CONFIG.maxQueue);
  const maxBatch = Math.max(1, Math.min(maxQueue, Number(options.maxBatch) || DEFAULT_CONFIG.maxBatch));
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_CONFIG.pushTimeoutMs);
  const now = options.now ?? (() => Date.now());

  const queue = [];
  const stats = {
    queuedTotal: 0,
    droppedTotal: 0,
    pushedTotal: 0,
    rejectedTotal: 0,
    lastError: null,
    lastSuccessAt: null,
    lastStatus: null,
    endpointMissing: false,
  };

  return {
    /** 入队；超过上限丢最旧的。 */
    enqueue(events) {
      const list = (Array.isArray(events) ? events : [events]).filter((event) => event && typeof event.summary === 'string');
      for (const event of list) {
        // 队列内同 summary 合并：心跳重推可能与「变化事件」重复，避免占两份额度。
        const index = queue.findIndex((item) => item.summary === event.summary);
        if (index >= 0) {
          queue[index] = { ...queue[index], ...event, private: queue[index].private === true || event.private === true };
        } else {
          queue.push(event);
        }
      }
      stats.queuedTotal += list.length;
      while (queue.length > maxQueue) {
        queue.shift();
        stats.droppedTotal += 1;
      }
      return { accepted: list.length, pending: queue.length, dropped: stats.droppedTotal };
    },
    /** 推送当前队列（最多 maxBatch 条）；返回结果对象，不抛。 */
    async flush() {
      if (queue.length === 0) return { ok: true, skipped: true, pending: 0 };
      let token;
      try {
        token = await tokenProvider();
      } catch (error) {
        stats.lastError = `token 读取失败：${error instanceof Error ? error.message : String(error)}`;
        stats.rejectedTotal += 1;
        return { ok: false, pending: queue.length, error: stats.lastError };
      }
      if (typeof token !== 'string' || token === '') {
        stats.lastError = 'bridge token 不可用（bridge 未启动？）';
        stats.rejectedTotal += 1;
        return { ok: false, pending: queue.length, error: stats.lastError };
      }
      const batch = queue.slice(0, maxBatch);
      const url = `${bridgeUrl}/context?token=${encodeURIComponent(token)}`;
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'x-bridge-token': token,
          },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let payload = null;
        if (text.trim() !== '') {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }
        stats.lastStatus = response.status;
        if (response.status === 404) {
          stats.lastError = 'bridge 还没有 /context 接口（等 bridge 上线）';
          stats.rejectedTotal += 1;
          stats.endpointMissing = true;
          log?.warn?.(`/context 404：接口未就绪，事件继续排队（pending=${queue.length}）`);
          return { ok: false, status: 404, pending: queue.length, error: stats.lastError };
        }
        if (!response.ok || (payload && payload.ok === false)) {
          stats.lastError = payload?.error?.message ?? `HTTP ${response.status}`;
          stats.rejectedTotal += 1;
          log?.warn?.(`/context 推送失败（HTTP ${response.status}）：${stats.lastError}，pending=${queue.length}`);
          return { ok: false, status: response.status, pending: queue.length, error: stats.lastError };
        }
        queue.splice(0, batch.length);
        stats.pushedTotal += batch.length;
        stats.rejectedTotal = 0;
        stats.lastError = null;
        stats.lastSuccessAt = now();
        stats.endpointMissing = false;
        return {
          ok: true,
          status: response.status,
          pushed: batch.length,
          stored: Number.isFinite(payload?.stored) ? payload.stored : null,
          pending: queue.length,
          response: payload,
        };
      } catch (error) {
        stats.lastError = error instanceof Error ? error.message : String(error);
        stats.rejectedTotal += 1;
        log?.warn?.(`/context 网络失败：${stats.lastError}，pending=${queue.length}`);
        return { ok: false, pending: queue.length, error: stats.lastError };
      }
    },
    /** 当前待推送条数（runObserver 的 flush 节奏判断用）。 */
    get pending() {
      return queue.length;
    },
    /** 只读快照（state.json 用）。 */
    snapshot() {
      return { pending: queue.length, ...stats };
    },
    queue,
  };
}

// ───────────────────────────── 心跳 / bridge 恢复 ─────────────────────────────

/**
 * 心跳重推事件：当前前台窗口 + 本机 DSH 活跃会话（≤ dshSessionsMax）。
 * 摘要与「变化事件」完全一致，bridge 端按 summary 去重（hits+1、at 刷新），不会刷屏。
 * @param {{process?: string, title?: string}|null} windowInfo 最近一次采集到的窗口
 * @param {Array<{title: string, running: boolean}>} activeSessions 最近一次采集到的活跃会话
 * @param {Record<string, any>} [cfg]
 * @param {number} [at]
 */
export function buildHeartbeatEvents(windowInfo, activeSessions, cfg = DEFAULT_CONFIG, at = Date.now()) {
  const events = [];
  if (windowInfo && (windowInfo.process || windowInfo.title)) {
    const event = buildWindowEvent(windowInfo, cfg, at);
    if (event) events.push(event);
  }
  const maxSessions = Math.max(1, Number(cfg.dshSessionsMax) || DEFAULT_CONFIG.dshSessionsMax);
  events.push(...buildDshSessionEvents((activeSessions ?? []).slice(0, maxSessions), cfg, at));
  return events;
}

/**
 * 根据上一次 bridge 状态与本次探测，判断是否要立即重推情境。
 * - pid 变化 → bridge 重启过（缓冲已清零）
 * - contextCount === 0 → 缓冲为空（重启后/被 TTL 清空）
 * @param {{pid: number|null, contextCount: number|null}|null} previous
 * @param {{ok: boolean, pid?: number|null, contextCount?: number|null, error?: string}} current
 * @returns {{shouldRepush: boolean, reason: string, pid: number|null, previousPid?: number}}
 */
export function detectBridgeReset(previous, current) {
  const pid = current && Number.isFinite(Number(current.pid)) ? Number(current.pid) : null;
  if (!current || current.ok !== true) {
    return { shouldRepush: false, reason: current ? 'bridge-unreachable' : 'no-probe', pid };
  }
  const previousPid = previous && Number.isFinite(Number(previous.pid)) ? Number(previous.pid) : null;
  const contextCount = Number.isFinite(Number(current.contextCount)) ? Number(current.contextCount) : null;
  if (previousPid !== null && pid !== null && pid !== previousPid) {
    return { shouldRepush: true, reason: 'bridge-restarted', pid, previousPid };
  }
  if (contextCount === 0) return { shouldRepush: true, reason: 'context-empty', pid };
  return {
    shouldRepush: false,
    reason: 'healthy',
    pid,
    ...(previousPid !== null ? { previousPid } : {}),
  };
}

/**
 * 探测 bridge：`GET /health` 的 pid + `GET /context?limit=1` 的条数。失败不抛。
 * @param {Record<string, any>} [cfg]
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ok: boolean, pid: number|null, contextCount: number|null, error?: string}>}
 */
export async function probeBridgeState(cfg = DEFAULT_CONFIG, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const bridgeUrl = String(cfg.bridgeUrl ?? DEFAULT_CONFIG.bridgeUrl).replace(/\/+$/, '');
  const timeoutMs = Math.max(500, Number(cfg.bridgeProbeTimeoutMs) || DEFAULT_CONFIG.bridgeProbeTimeoutMs);
  const getJson = async (path) => {
    const response = await fetchImpl(`${bridgeUrl}${path}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  try {
    const health = await getJson('/health');
    const pid = Number.isFinite(Number(health?.pid)) ? Number(health.pid) : null;
    let contextCount = null;
    try {
      const context = await getJson('/context?limit=1');
      contextCount = Array.isArray(context?.events)
        ? context.events.length
        : (Number.isFinite(Number(context?.count)) ? Number(context.count) : null);
    } catch {
      /* /context 暂时不可用不影响 pid 探测 */
    }
    return { ok: true, pid, contextCount };
  } catch (error) {
    return { ok: false, pid: null, contextCount: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// ───────────────────────────── 日志 / 状态 / 锁 ─────────────────────────────

/**
 * 简单文件日志：`logs/observer.log`，超过 logMaxBytes 时滚动成 `.1`。
 * @param {string} file
 * @param {{ maxBytes?: number, echo?: boolean }} [options]
 */
export function createLogger(file, options = {}) {
  const maxBytes = Number(options.maxBytes) || DEFAULT_CONFIG.logMaxBytes;
  const echo = options.echo === true;
  mkdirSync(path.dirname(file), { recursive: true });
  const write = (level, message) => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    try {
      if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    } catch {
      /* 滚动失败不影响写入 */
    }
    try {
      appendFileSync(file, line, 'utf8');
    } catch {
      /* 磁盘满等极端情况不阻塞观察器 */
    }
    if (echo) process.stdout.write(line);
  };
  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
    line: write,
  };
}

/** 原子写 JSON（tmp + rename）。 */
export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

/** pid 是否还活着。 */
export function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/**
 * 单实例锁。已有活着的实例时返回 {ok:false, pid}。
 * @param {string} lockFile
 */
export function acquireLock(lockFile) {
  try {
    const previous = JSON.parse(readFileSync(lockFile, 'utf8'));
    const pid = Number(previous?.pid);
    if (pid !== process.pid && isProcessAlive(pid)) return { ok: false, pid };
  } catch {
    /* 不存在 / 损坏 → 直接接管 */
  }
  mkdirSync(path.dirname(lockFile), { recursive: true });
  writeJsonAtomic(lockFile, { pid: process.pid, startedAt: Date.now(), host: os.hostname(), version: VERSION });
  return { ok: true, pid: process.pid };
}

/** 释放锁（只删自己的）。 */
export function releaseLock(lockFile) {
  try {
    const previous = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (Number(previous?.pid) === process.pid) unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
}

/** PAUSED 开关（文件存在或 --paused 参数）。 */
export function isPaused(cfg = DEFAULT_CONFIG, forced = false) {
  if (forced) return true;
  if (!cfg.pausedFile) return false;
  const file = path.isAbsolute(cfg.pausedFile) ? cfg.pausedFile : path.join(HERE, cfg.pausedFile);
  return existsSync(file);
}

// ───────────────────────────── 配置与参数 ─────────────────────────────

/** 读 config.json（可选）并与默认配置合并。 */
export function loadConfig(configFile) {
  let fileConfig = {};
  if (typeof configFile === 'string' && configFile !== '') {
    const resolved = path.isAbsolute(configFile) ? configFile : path.join(HERE, configFile);
    fileConfig = JSON.parse(readFileSync(resolved, 'utf8'));
  } else {
    const defaultFile = path.join(HERE, 'config.json');
    if (existsSync(defaultFile)) {
      try {
        fileConfig = JSON.parse(readFileSync(defaultFile, 'utf8'));
      } catch (error) {
        throw new Error(`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { ...DEFAULT_CONFIG, ...fileConfig };
}

/** 解析 CLI 参数。 */
export function parseArgs(argv = []) {
  const options = {
    once: false,
    paused: false,
    verbose: false,
    noDsh: false,
    noPush: false,
    help: false,
    config: '',
    bridgeUrl: '',
    dshUrl: '',
    tokenFile: '',
    foregroundIntervalMs: 0,
    dshIntervalMs: 0,
    json: false,
  };
  for (const argument of argv) {
    if (argument === '--once') options.once = true;
    else if (argument === '--paused') options.paused = true;
    else if (argument === '--verbose') options.verbose = true;
    else if (argument === '--no-dsh') options.noDsh = true;
    else if (argument === '--no-push') options.noPush = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--config=')) options.config = argument.slice('--config='.length);
    else if (argument.startsWith('--bridge-url=')) options.bridgeUrl = argument.slice('--bridge-url='.length);
    else if (argument.startsWith('--dsh-url=')) options.dshUrl = argument.slice('--dsh-url='.length);
    else if (argument.startsWith('--token-file=')) options.tokenFile = argument.slice('--token-file='.length);
    else if (argument.startsWith('--window-interval=')) options.foregroundIntervalMs = Number(argument.slice('--window-interval='.length));
    else if (argument.startsWith('--dsh-interval=')) options.dshIntervalMs = Number(argument.slice('--dsh-interval='.length));
    else throw new Error(`不认识的参数：${argument}（--help 看用法）`);
  }
  return options;
}

/** 把 CLI 覆盖应用到配置。 */
export function applyCliOptions(cfg, options = {}) {
  const merged = { ...cfg };
  if (options.bridgeUrl) merged.bridgeUrl = options.bridgeUrl;
  if (options.dshUrl) merged.dshUrl = options.dshUrl;
  if (options.tokenFile) merged.bridgeTokenFile = options.tokenFile;
  if (Number(options.foregroundIntervalMs) > 0) merged.foregroundIntervalMs = Number(options.foregroundIntervalMs);
  if (Number(options.dshIntervalMs) > 0) merged.dshIntervalMs = Number(options.dshIntervalMs);
  return merged;
}

/** CLI 用法。 */
export function usageText() {
  return [
    '本机情境观察器 — 把「主人在干嘛」推给 bridge /context（只推摘要，不采屏幕/输入）',
    '',
    '用法: node observer.mjs [options]',
    '  --once                 只执行一轮（采集 + 推送）后打印 JSON 并退出',
    '  --no-push              只采集、不推送（配合 --once 做隐私检查）',
    '  --no-dsh               不采集本机 DSH 会话（只观察前台窗口）',
    '  --paused               启动即暂停（等价于放一个 PAUSED 文件）',
    '  --verbose              日志同时打印到 stdout',
    '  --config=<file>        使用指定配置文件（默认 ./config.json，可缺省）',
    '  --bridge-url=<url>     覆盖 bridge 地址（默认 http://127.0.0.1:47891）',
    '  --token-file=<file>    覆盖 bridge token 文件',
    '  --dsh-url=<url>        覆盖本机 DSH Web 地址（默认 http://127.0.0.1:53316）',
    '  --window-interval=<ms> 前台窗口采样间隔（默认 18000）',
    '  --dsh-interval=<ms>    本机 DSH 采样间隔（默认 30000）',
    '  --help                 显示本帮助',
    '',
    '心跳/桥恢复（config.json 可调）: heartbeatMs=60000（每 60s 重推当前状态）、',
    '  bridgeHealthIntervalMs=30000（轮询 bridge pid；重启或 /context 为空立即重推）。',
    '',
    '暂停: 在本目录放一个 PAUSED 文件（或删除它恢复）。',
  ].join('\n');
}

// ───────────────────────────── 一轮采集 ─────────────────────────────

/**
 * 采集一轮：前台窗口 + 本机 DSH 活跃会话 → 情境事件；可选推送。
 * `--once` 与 tools/probe.mjs 共用。
 */
export async function collectOnce(cfg = DEFAULT_CONFIG, options = {}) {
  const log = options.log ?? null;
  const now = Date.now();
  const collectForegroundImpl = options.collectForeground ?? collectForegroundInfo;
  const collectDshImpl = options.collectDsh ?? collectDshActivity;
  const foreground = options.skipForeground === true
    ? { ok: false, error: 'skipped' }
    : await collectForegroundImpl({ timeoutMs: cfg.execTimeoutMs, powershellCandidates: cfg.powershellCandidates });
  const windowSummary = foreground.ok ? summarizeWindow(foreground, cfg) : null;
  const windowEvent = foreground.ok ? buildWindowEvent(foreground, cfg, now) : null;

  let dsh = { ok: false, active: [], total: 0, error: 'skipped' };
  if (options.noDsh !== true) {
    dsh = await collectDshImpl({
      dshUrl: cfg.dshUrl,
      dshHome: cfg.dshHome,
      timeoutMs: 15_000,
      ...cfg,
    }, { now });
  }
  const dshEvents = dsh.ok ? buildDshSessionEvents(dsh.active, cfg, now) : [];

  const events = [];
  if (windowEvent) events.push(windowEvent);
  events.push(...dshEvents);

  const result = {
    observedAt: new Date(now).toISOString(),
    window: foreground.ok
      ? { pid: foreground.pid, process: foreground.process, title: foreground.title, sensitive: windowSummary?.sensitive === true }
      : { error: foreground.error },
    dsh: dsh.ok ? { total: dsh.total, active: dsh.active } : { error: dsh.error },
    events,
  };

  if (options.push === true && events.length > 0) {
    const pusher = options.pusher ?? createPusher({
      bridgeUrl: cfg.bridgeUrl,
      tokenProvider: () => readBridgeToken(cfg.bridgeTokenFile),
      log,
      maxQueue: cfg.maxQueue,
      maxBatch: cfg.maxBatch,
      timeoutMs: cfg.pushTimeoutMs,
    });
    pusher.enqueue(events);
    result.push = await pusher.flush();
    log?.info?.(`--once 推送：${JSON.stringify(result.push)}`);
  } else if (events.length > 0) {
    result.push = { ok: false, skipped: true, reason: 'not requested' };
  }
  return result;
}

// ───────────────────────────── 常驻主循环 ─────────────────────────────

/**
 * 常驻运行（依赖可注入，便于测试）。
 * @param {Record<string, any>} cfg
 * @param {{ log: any, pusher?: any, forcedPaused?: boolean, collectForeground?: Function, collectDsh?: Function, sleepImpl?: Function, signal?: AbortSignal }} deps
 */
export async function runObserver(cfg, deps = {}) {
  const log = deps.log ?? createLogger(path.join(HERE, cfg.logFile), { maxBytes: cfg.logMaxBytes });
  const sleepImpl = deps.sleepImpl ?? sleep;
  const collectForegroundImpl = deps.collectForeground ?? collectForegroundInfo;
  const collectDshImpl = deps.collectDsh ?? collectDshActivity;
  const probeBridgeImpl = deps.probeBridge ?? probeBridgeState;
  const nowFn = deps.now ?? (() => Date.now());
  const pusher = deps.pusher ?? createPusher({
    bridgeUrl: cfg.bridgeUrl,
    tokenProvider: () => readBridgeToken(cfg.bridgeTokenFile),
    log,
    maxQueue: cfg.maxQueue,
    maxBatch: cfg.maxBatch,
    timeoutMs: cfg.pushTimeoutMs,
  });
  const statePath = deps.statePath
    ?? (path.isAbsolute(cfg.stateFile) ? cfg.stateFile : path.join(HERE, cfg.stateFile));
  const abortSignal = deps.signal ?? null;
  const pausedForced = deps.forcedPaused === true;

  const state = {
    pid: process.pid,
    version: VERSION,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    paused: false,
    lastWindow: null,
    dsh: { signature: null, active: [] },
    bridge: {
      pid: null,
      contextCount: null,
      lastCheckAt: null,
      lastHeartbeatAt: null,
      heartbeats: 0,
      lastResetReason: null,
      lastError: null,
    },
    counters: { windowEvents: 0, dshEvents: 0, pushes: 0, errors: 0, heartbeats: 0 },
    lastPush: null,
  };
  let stopped = false;
  let pausedLogged = false;
  let lastWindowKey = null;
  let lastDshSignature = null;
  let lastForegroundAt = 0;
  let lastDshAt = 0;
  let lastFlushAt = 0;
  let lastErrorLogAt = 0;
  // 心跳 / bridge 恢复状态
  let lastWindowInfo = null;
  let lastDshActive = [];
  let lastHeartbeatAt = 0;
  let lastBridgeProbeAt = 0;
  let bridgeSnapshot = null;
  let heartbeatForced = true;
  let heartbeatDueReason = 'startup';
  let lastBridgeDownLogAt = 0;
  const heartbeatMs = Math.max(1_000, Number(cfg.heartbeatMs) || DEFAULT_CONFIG.heartbeatMs);
  const bridgeHealthIntervalMs = Math.max(
    1_000,
    Number(cfg.bridgeHealthIntervalMs) || DEFAULT_CONFIG.bridgeHealthIntervalMs,
  );

  const stop = () => { stopped = true; };
  const writeState = () => {
    state.updatedAt = Date.now();
    state.pusher = pusher.snapshot ? pusher.snapshot() : null;
    try {
      writeJsonAtomic(statePath, state);
    } catch (error) {
      log.warn(`state.json 写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const logError = (message) => {
    const now = Date.now();
    if (now - lastErrorLogAt > 60_000) {
      lastErrorLogAt = now;
      log.warn(message);
    }
    state.counters.errors += 1;
  };

  const tickForeground = async () => {
    const result = await collectForegroundImpl({ timeoutMs: cfg.execTimeoutMs, powershellCandidates: cfg.powershellCandidates });
    if (!result.ok) {
      logError(`前台窗口采集失败：${result.error}`);
      return;
    }
    const key = windowKey(result);
    lastWindowInfo = { process: result.process, title: result.title };
    state.lastWindow = {
      process: result.process,
      title: truncateText(result.title, cfg.titleMaxChars),
      key,
      at: Date.now(),
    };
    if (key === lastWindowKey) return;
    lastWindowKey = key;
    const event = buildWindowEvent(result, cfg);
    if (!event) return;
    pusher.enqueue([event]);
    state.counters.windowEvents += 1;
    log.info(`前台变化：${event.summary}${event.private ? ' [private]' : ''}`);
  };

  const tickDsh = async () => {
    const result = await collectDshImpl({
      dshUrl: cfg.dshUrl,
      dshHome: cfg.dshHome,
      timeoutMs: 15_000,
      ...cfg,
    });
    if (!result.ok) {
      logError(`本机 DSH 会话采集失败：${result.error}`);
      return;
    }
    lastDshActive = result.active;
    const signature = result.active.map((session) => `${session.sessionId}:${session.running ? 1 : 0}:${session.title}`).join('|');
    if (signature === lastDshSignature) return;
    lastDshSignature = signature;
    state.dsh = {
      signature,
      active: result.active.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        running: session.running,
        updatedAt: session.updatedAt,
      })),
    };
    const events = buildDshSessionEvents(result.active, cfg);
    if (events.length === 0) return;
    pusher.enqueue(events);
    state.counters.dshEvents += events.length;
    log.info(`本机 DSH 活跃会话：${result.active.map((session) => `「${session.title}」${session.running ? '运行中' : '刚更新'}`).join('、') || '无'}`);
  };

  /** 心跳：把当前窗口 + ≤2 个 DSH 会话按原 summary 再推一次（bridge 端去重）。 */
  const sendHeartbeat = async (reason) => {
    const at = nowFn();
    const events = buildHeartbeatEvents(lastWindowInfo, lastDshActive, cfg, at);
    lastHeartbeatAt = at;
    state.bridge.lastHeartbeatAt = at;
    state.bridge.lastResetReason = reason;
    if (events.length === 0) {
      log.info(`心跳重推（${reason}）：暂无可推状态（窗口/DSH 还没采到）`);
      return { ok: false, reason, pushed: 0, skipped: true };
    }
    state.counters.heartbeats += 1;
    state.bridge.heartbeats += 1;
    pusher.enqueue(events);
    log.info(`心跳重推（${reason}）：${events.length} 条（窗口=${lastWindowInfo?.process ?? '未知'}，DSH会话=${lastDshActive.length}）`);
    const flushed = await pusher.flush();
    if (flushed.ok) {
      state.counters.pushes += 1;
      state.lastPush = { at: nowFn(), pushed: flushed.pushed, stored: flushed.stored, pending: flushed.pending, reason };
    } else {
      state.bridge.lastError = flushed.error ?? 'unknown';
      log.warn(`心跳重推未成功（${flushed.error ?? 'unknown'}），事件留在队列重试（pending=${flushed.pending ?? '?'}）`);
    }
    return { ok: flushed.ok === true, reason, ...flushed };
  };

  /** 探测 bridge：pid 变化 / /context 为空 → 立即重推当前状态。 */
  const checkBridge = async (now) => {
    const current = await probeBridgeImpl(cfg);
    state.bridge.lastCheckAt = now;
    const decision = detectBridgeReset(bridgeSnapshot, current);
    if (!current || current.ok !== true) {
      state.bridge.contextCount = null;
      state.bridge.lastError = (current && current.error) || 'probe failed';
      if (now - lastBridgeDownLogAt > 60_000) {
        lastBridgeDownLogAt = now;
        log.warn(`bridge 探测失败（${state.bridge.lastError}）：保持心跳/队列重试中`);
      }
      bridgeSnapshot = null; // 恢复后第一次成功探测按「context 为空/重启」触发重推
      return;
    }
    state.bridge.pid = decision.pid;
    state.bridge.lastError = null;
    if (Number.isFinite(Number(current.contextCount))) state.bridge.contextCount = Number(current.contextCount);
    if (decision.shouldRepush) {
      log.info(
        `bridge 状态变化（pid=${decision.pid ?? '?'}、contextCount=${current.contextCount ?? '?'}）：`
        + `${decision.reason} → 立即重推`,
      );
      heartbeatDueReason = decision.reason;
      heartbeatForced = true;
    }
    bridgeSnapshot = {
      pid: decision.pid,
      contextCount: Number.isFinite(Number(current.contextCount)) ? Number(current.contextCount) : null,
    };
  };

  const signalListeners = [];
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => stop();
    try {
      process.on(signal, listener);
      signalListeners.push([signal, listener]);
    } catch {
      /* ignore */
    }
  }

  log.info(
    `观察器启动 v${VERSION}（窗口 ${cfg.foregroundIntervalMs}ms / DSH ${cfg.dshIntervalMs}ms`
    + ` / 心跳 ${heartbeatMs}ms / bridge ${cfg.bridgeUrl}）`,
  );
  while (!stopped && !(abortSignal !== null && abortSignal.aborted === true)) {
    const paused = isPaused(cfg, pausedForced);
    if (paused) {
      state.paused = true;
      if (!pausedLogged) {
        pausedLogged = true;
        log.info('已暂停（PAUSED 存在或 --paused）：不采集、不推送；删除 PAUSED 后自动恢复');
      }
      writeState();
      await sleepImpl(3_000);
      continue;
    }
    if (pausedLogged) {
      pausedLogged = false;
      state.paused = false;
      log.info('暂停结束，恢复采集');
    }
    state.paused = false;
    const now = nowFn();
    if (now - lastForegroundAt >= cfg.foregroundIntervalMs) {
      lastForegroundAt = now;
      await tickForeground();
    }
    if (now - lastDshAt >= cfg.dshIntervalMs) {
      lastDshAt = now;
      await tickDsh();
    }
    // 桥状态：pid 变化（bridge 重启）/ /context 为空 → 立即重推，不必等窗口切换
    if (now - lastBridgeProbeAt >= bridgeHealthIntervalMs) {
      lastBridgeProbeAt = now;
      await checkBridge(now);
    }
    // 启动即推一次；之后每 heartbeatMs 心跳重推；桥恢复/重启由 checkBridge 强制触发
    if (heartbeatForced) {
      heartbeatForced = false;
      await sendHeartbeat(heartbeatDueReason);
    } else if (now - lastHeartbeatAt >= heartbeatMs) {
      await sendHeartbeat('periodic');
    }
    if (pusher.pending > 0 && now - lastFlushAt >= 5_000) {
      lastFlushAt = now;
      const flushed = await pusher.flush();
      if (flushed.ok) {
        state.counters.pushes += 1;
        state.lastPush = { at: Date.now(), pushed: flushed.pushed, stored: flushed.stored, pending: flushed.pending };
      }
    }
    writeState();
    await sleepImpl(1_000);
  }

  for (const [signal, listener] of signalListeners) {
    try { process.off(signal, listener); } catch { /* ignore */ }
  }
  if (pusher.pending > 0) {
    log.info(`退出前尝试清空待推送队列（pending=${pusher.pending}）`);
    await pusher.flush();
  }
  writeState();
  log.info('观察器退出');
  return state;
}

// ───────────────────────────── CLI ─────────────────────────────

/**
 * CLI 入口。返回进程退出码。
 */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[observer] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (options.help) {
    console.log(usageText());
    return 0;
  }
  let cfg;
  try {
    cfg = applyCliOptions(loadConfig(options.config), options);
  } catch (error) {
    console.error(`[observer] 读取配置失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const logFile = path.isAbsolute(cfg.logFile) ? cfg.logFile : path.join(HERE, cfg.logFile);
  const log = createLogger(logFile, { maxBytes: cfg.logMaxBytes, echo: options.verbose });

  const paused = options.paused || isPaused(cfg);
  if (paused) log.info(`启动时处于暂停状态（${options.paused ? '--paused' : `${cfg.pausedFile} 存在`}）`);

  if (options.once) {
    // --once 是人工显式执行；处于 PAUSED 时仍只读采集一次用于查看，但不推送。
    const result = await collectOnce(cfg, {
      log,
      push: options.noPush !== true && !paused,
      noDsh: options.noDsh,
    });
    if (paused) log.info('--once：处于 PAUSED，跳过推送（只采集打印）');
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`观察时间：${result.observedAt}`);
      console.log(`前台窗口：${result.window.error ?? `${result.window.process || '未知程序'} · ${result.window.title || '（无标题）'}`}${result.window.sensitive ? '（敏感：只推进程名）' : ''}`);
      console.log(`本机 DSH：${result.dsh.error ?? `${result.dsh.active.length} 个活跃会话 / 共 ${result.dsh.total} 个`}`);
      for (const session of result.dsh.active ?? []) {
        console.log(`  - 「${session.title}」${session.running ? '运行中' : '刚更新'}`);
      }
      console.log('将推送事件：');
      console.log(JSON.stringify(result.events, null, 2));
      if (result.push) console.log(`推送结果：${JSON.stringify(result.push)}`);
    }
    return result.push && result.push.ok === false && result.push.skipped !== true ? 1 : 0;
  }

  const lockFile = path.isAbsolute(cfg.lockFile) ? cfg.lockFile : path.join(HERE, cfg.lockFile);
  const lock = acquireLock(lockFile);
  if (!lock.ok) {
    const message = `已有观察器在运行（pid=${lock.pid}）；如需重启先停掉它（stop-observer.cmd）`;
    log.error(message);
    console.error(`[observer] ${message}`);
    return 2;
  }
  const cleanup = () => releaseLock(lockFile);
  try {
    process.on('exit', cleanup);
    await runObserver(cfg, { log, forcedPaused: paused });
    return 0;
  } catch (error) {
    log.error(`观察器异常退出：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  } finally {
    cleanup();
  }
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[observer] 未捕获异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
}
