/**
 * 「鲸歌」面板 —— Host 半。
 *
 * 职责（全部只在本机回环内）：
 * 1. 在 DSH Web 服务器上注册同源路由 `/whale-panel/*`，把浏览器端的请求代理到
 *    本机 bridge（默认 `http://127.0.0.1:47891`）。为什么需要代理：bridge 的 HTTP
 *    接口不带 CORS 头，浏览器从 DSH 页面（如 http://127.0.0.1:53316）直接 fetch
 *    会被跨源拦截；Host 半在 Node 里代取就不存在 CORS 问题。
 * 2. `GET /whale-panel/config` 读出 bridge token 文件内容，把 token 交给同源的
 *    Client 半，用于浏览器直连 `ws://127.0.0.1:47891/events?token=...`
 *    （WebSocket 不受 CORS 限制，但 bridge 的 /events 要 token）。
 *    token 只在内存/响应里流转：**不打印到日志、不在面板 UI 显示**。
 * 3. 红线：bridgeUrl 必须是回环地址；token 文件与代理目标都来自本 bundle 的
 *    `cordis.patch.yml` 配置，Client 端无法指定任意 URL；浏览器请求必须与 DSH
 *    Web 页面同源（跨源 Origin 一律 403）。
 *
 * 本文件只用 node 内置模块，不需要任何 npm 依赖，也不导出服务。
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件行名（Loader 行 id 由 cordis.patch.yml 决定，这里是插件名）。 */
export const name = 'whale-panel';

/** 依赖 DSH Web 服务器服务；没有 webServer 的 profile 里插件保持不激活。 */
export const inject = ['webServer'];

/** 「鲸歌」聊天面板的同源路由前缀。 */
export const ROUTE_PREFIX = '/whale-panel';

/** 「总控台」的同源路由前缀（T19）。 */
export const CONTROL_PREFIX = '/control-center';

/** 两组路由前缀（apply 会把同一个 handler 挂到两个 prefix 上）。 */
export const ROUTE_PREFIXES = [ROUTE_PREFIX, CONTROL_PREFIX];

/** 四个登录自启 vbs（总控台「组件状态」展示用）。 */
export const AUTOSTART_FILES = Object.freeze([
  { id: 'bridge', label: 'bridge', file: 'dsh-link-bridge.vbs' },
  { id: 'observer', label: '情境观察器', file: 'dsh-link-context-observer.vbs' },
  { id: 'sync', label: '本机→服务器同步', file: 'dsh-link-awareness-sync.vbs' },
  { id: 'mirror', label: '会话镜像', file: 'dsh-link-session-mirror.vbs' },
]);

/** 插件自身目录（settings.json 默认落在这里；link: 安装时=工作区目录）。 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 面板名称/标题/Tab 文案默认值（T26；可被 config.ui / settings.json 覆盖）。 */
export const UI_DEFAULTS = Object.freeze({
  sidebarLabel: '鲸歌',
  panelTitle: '鲸歌',
  tabLabels: Object.freeze({ chat: '聊天', control: '总控台', settings: '设置', market: 'Coo 市场' }),
});

/** QQ 预览默认值（T26：默认不预览任何会话，不包含任何真实 QQ 号）。 */
export const QQ_DEFAULTS = Object.freeze({
  qqPreviewGroup: true,
  qqPreviewGroups: Object.freeze([]),
  qqPreviewChats: Object.freeze([]),
  qqPreviewMaxItems: 4,
  qqPreviewMaxChars: 60,
});

/** 本地面板设置默认值（T21/T26）。 */
export const SETTINGS_DEFAULTS = Object.freeze({
  refreshIntervalMs: 10_000,
  sections: Object.freeze({ cards: true, context: true, qq: true, components: true, actions: true }),
  chatFontSize: 'medium',
  sendKey: 'enter',
  ui: UI_DEFAULTS,
  bridgeUrl: '',
  serverSshHost: '',
  awarenessPatchPath: '',
  qqPreviewGroup: QQ_DEFAULTS.qqPreviewGroup,
  qqPreviewGroups: QQ_DEFAULTS.qqPreviewGroups,
  qqPreviewChats: QQ_DEFAULTS.qqPreviewChats,
  qqPreviewMaxItems: QQ_DEFAULTS.qqPreviewMaxItems,
  qqPreviewMaxChars: QQ_DEFAULTS.qqPreviewMaxChars,
});

/** 允许的刷新间隔 / 字号 / 发送键。 */
const SETTINGS_REFRESH_OPTIONS = [5_000, 10_000, 30_000];
const SETTINGS_FONT_SIZES = ['small', 'medium', 'large'];
const SETTINGS_SEND_KEYS = ['enter', 'ctrl-enter'];

/** 服务器 QQ 预览配置：只允许这 5 个字段（T17/T20 共用的 patch 文件，绝不整体覆盖）。 */
export const AWARENESS_FIELDS = Object.freeze({
  qqPreviewGroup: { type: 'boolean' },
  qqPreviewGroups: { type: 'array', pattern: /^group:\d{1,25}$/ },
  qqPreviewChats: { type: 'array', pattern: /^private:\d{1,25}$/ },
  qqPreviewMaxItems: { type: 'integer', min: 1, max: 10 },
  qqPreviewMaxChars: { type: 'integer', min: 20, max: 200 },
});

/** 

/** 默认配置；patch 里的 config 会覆盖同名项。全部为通用默认（不含任何本机/服务器私有值）。 */
export const DEFAULTS = Object.freeze({
  bridgeUrl: 'http://127.0.0.1:47891',
  /** bridge token 文件（空 = <dshLinkRoot>/bridge/token.txt；可由 config 覆盖）。 */
  tokenFile: '',
  token: '',
  sessionId: 'pet-local',
  healthTimeoutMs: 5_000,
  historyTimeoutMs: 10_000,
  sayTimeoutMs: 260_000,
  maxBodyBytes: 64 * 1024,
  /** 工作区根（空 = 插件目录的上一级；总控台读组件状态/锁/自启文件与 PAUSED 用）。 */
  dshLinkRoot: '',
  /** Startup 目录覆盖（空 = 当前用户 %APPDATA% 下的 Startup）。 */
  startupDir: '',
  /** bridge /dashboard 超时（T18 目标 <2s；冷启动留余量）。 */
  dashboardTimeoutMs: 6_000,
  /** 本地面板设置文件（空 = 插件目录下 settings.json）。 */
  settingsFile: '',
  /** 面板名称/标题/Tab 文案（settings.json 可覆盖）。 */
  ui: UI_DEFAULTS,
  /** 服务器 SSH（空 = 不启用 SSH 功能：QQ 预览配置读写/重启服务器都禁用）。 */
  sshHost: '',
  serverSshHost: '',
  /** SSH 私钥/known_hosts（空 = 用系统默认 ssh 配置；默认推导 <dshLinkRoot>/.ssh/id_ed25519）。 */
  sshKey: '',
  sshKnownHosts: '',
  /** 服务器上的 awareness bundle patch（空 = 不启用服务器 QQ 配置读写）。 */
  awarenessPatchPath: '',
  /** 需要重启的服务器服务名。 */
  remoteDshService: 'dsh-web',
  /** 写服务器 patch 后要 chown 的属主（空 = 不改属主；如 'user:group'）。 */
  remoteFileOwner: '',
  /** SSH 单条命令超时 / 重启等待上限。 */
  sshTimeoutMs: 20_000,
  applyRestartWaitMs: 45_000,
  /** 服务器 QQ 配置读取缓存（设置页打开时避免每次都 ssh）。 */
  awarenessCacheMs: 15_000,
  /** QQ 预览默认白名单（空 = 不预览任何会话；由设置页/依赖插件写入）。 */
  qqPreviewGroup: QQ_DEFAULTS.qqPreviewGroup,
  qqPreviewGroups: QQ_DEFAULTS.qqPreviewGroups,
  qqPreviewChats: QQ_DEFAULTS.qqPreviewChats,
  qqPreviewMaxItems: QQ_DEFAULTS.qqPreviewMaxItems,
  qqPreviewMaxChars: QQ_DEFAULTS.qqPreviewMaxChars,
  /** 桌宠 DIY（T23）：coo-pet-data 根 / 设置文件 / legacy skin / 形象包目录（空 = 由 dshLinkRoot 推导）。 */
  cooPetDataRoot: '',
  petSettingsFile: '',
  petSkinFile: '',
  petPacksDir: '',
  /** 桌宠形象包 ZIP 导入（T30）：上传上限 128MB / 解包超时 120s。 */
  petImportMaxBytes: 128 * 1024 * 1024,
  petImportTimeoutMs: 120_000,
  /** 本机视觉模型（T35）：Ollama endpoint / 模型 / prompt / 推理超时 / 截图目录（空=cooPetDataRoot/screenshots）。 */
  visionEndpoint: 'http://127.0.0.1:11434',
  visionModel: 'qwen2.5vl:3b',
  visionPrompt: 'Describe this screenshot in 2-3 short Chinese sentences. Answer in Chinese only. Say what the user is probably doing and what is clearly visible. Do not read the screen word by word or guess private details; if unclear, keep it brief.',
  visionTimeoutMs: 120_000,
  screenShotDir: '',
  /** Coo 插件列表/启动（T33）：主程序 exe / 进程状态缓存 / 重启等待。 */
  cooExeName: 'Coopanion.exe',
  cooProcessCacheMs: 3_000,
  cooRestartWaitMs: 1_500,
  /** Coo 市场（T24）：npm registry 搜索 URL / 缓存 10min / 超时 / 本机 Coopanion 扩展目录（空=自动探测）。 */
  cooMarketUrl: 'https://registry.npmjs.org/-/v1/search?text=cortico&size=250',
  cooMarketCacheMs: 600_000,
  cooMarketTimeoutMs: 15_000,
  cooExtensionsDir: '',
  /** Coo 市场下载/安装（T25）：下载目录（空=<dshLinkRoot>/coo-extensions）/ 上限 / 超时 / tar / Coopanion 根（空=自动探测）。 */
  cooDownloadsDir: '',
  cooDownloadMaxBytes: 200 * 1024 * 1024,
  cooDownloadTimeoutMs: 120_000,
  cooTarPath: 'tar.exe',
  cooRoot: '',
  cooPnpmPath: '',
});

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const TOKEN_PATTERN = /^[0-9a-fA-F]{16,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** 解码 Windows CLI 输出（PowerShell 可能输出 GBK；UTF-8 失败时回退 GBK）。 */
export function decodeCliOutput(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''));
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

/** 合并 ui 配置（字符串 trim + tabLabels 只接受已知 key）。 */
export function resolveUiConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ui = { ...UI_DEFAULTS, tabLabels: { ...UI_DEFAULTS.tabLabels } };
  if (typeof source.sidebarLabel === 'string' && source.sidebarLabel.trim() !== '') ui.sidebarLabel = source.sidebarLabel.trim().slice(0, 40);
  if (typeof source.panelTitle === 'string') ui.panelTitle = source.panelTitle.trim().slice(0, 80);
  if (source.tabLabels && typeof source.tabLabels === 'object' && !Array.isArray(source.tabLabels)) {
    for (const key of Object.keys(UI_DEFAULTS.tabLabels)) {
      const value = source.tabLabels[key];
      if (typeof value === 'string' && value.trim() !== '') ui.tabLabels[key] = value.trim().slice(0, 24);
    }
  }
  return ui;
}

/** 合并 QQ 预览默认配置（数组只保留字符串；非法值回退默认空数组）。 */
export function resolveQqConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = (value) => (Array.isArray(value) ? value.map((item) => String(item)).filter((item) => item !== '') : []);
  return {
    qqPreviewGroup: typeof source.qqPreviewGroup === 'boolean' ? source.qqPreviewGroup : QQ_DEFAULTS.qqPreviewGroup,
    qqPreviewGroups: Array.isArray(source.qqPreviewGroups) ? list(source.qqPreviewGroups) : [...QQ_DEFAULTS.qqPreviewGroups],
    qqPreviewChats: Array.isArray(source.qqPreviewChats) ? list(source.qqPreviewChats) : [...QQ_DEFAULTS.qqPreviewChats],
    qqPreviewMaxItems: Number.isFinite(Number(source.qqPreviewMaxItems)) ? Number(source.qqPreviewMaxItems) : QQ_DEFAULTS.qqPreviewMaxItems,
    qqPreviewMaxChars: Number.isFinite(Number(source.qqPreviewMaxChars)) ? Number(source.qqPreviewMaxChars) : QQ_DEFAULTS.qqPreviewMaxChars,
  };
}

/** 校验 bridge 地址：只允许 http/https + 回环/局域网主机（不含路径）。 */
export function isAllowedBridgeUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host.endsWith('.local')) return true;
    if (!host.includes('.')) return true; // 局域网单标签主机名
    return false;
  } catch {
    return false;
  }
}

/** 校验 serverSshHost：空表示禁用；否则 user@host。 */
export function isAllowedSshHost(value) {
  const text = String(value ?? '').trim();
  if (text === '') return true;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(text) && !text.includes('..') && text.length <= 200;
}

/**
 * 解析 Coopanion 根目录（自动探测）：config > 环境变量 > 常见安装位置 > 运行中进程（Windows）。
 * @returns {string|null}
 */
let detectedCooRootCache;
export function detectCooRoot(settings = {}) {
  const configured = typeof settings.cooRoot === 'string' ? settings.cooRoot.trim() : '';
  if (configured !== '') return configured;
  if (detectedCooRootCache !== undefined) return detectedCooRootCache;
  const candidates = [];
  for (const envName of ['COOPANION_ROOT', 'COO_ROOT', 'COOPANION_HOME']) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value.trim());
  }
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (typeof base === 'string' && base.trim() !== '') candidates.push(path.join(base, 'Coopanion'));
  }
  candidates.push(path.join(process.cwd(), 'Coopanion'));
  for (const candidate of candidates) {
    try {
      if (existsSync(path.join(candidate, 'data'))) { detectedCooRootCache = candidate; return candidate; }
    } catch { /* ignore */ }
  }
  if (process.platform === 'win32') {
    try {
      const output = decodeCliOutput(execFileSync('wmic', ['process', 'where', "name='Coopanion.exe'", 'get', 'ExecutablePath', '/value'], {
        windowsHide: true, timeout: 4_000, encoding: 'buffer',
      }));
      const match = String(output).match(/ExecutablePath=(.+)/);
      if (match) {
        const root = path.dirname(match[1].trim());
        if (existsSync(path.join(root, 'data'))) { detectedCooRootCache = root; return root; }
      }
    } catch { /* ignore */ }
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "(Get-Process -Name Coopanion -ErrorAction SilentlyContinue | Select-Object -First 1).Path"], {
        windowsHide: true, timeout: 6_000, encoding: 'utf8',
      });
      const line = String(output).split(/\r?\n/).map((item) => item.trim()).find((item) => item !== '');
      if (line && existsSync(line)) {
        const root = path.dirname(line);
        if (existsSync(path.join(root, 'data'))) { detectedCooRootCache = root; return root; }
      }
    } catch { /* ignore */ }
  }
  detectedCooRootCache = null;
  return null;
}

/** Coo 路径：config 显式值优先；extensions 目录/Coopanion pnpm 依赖自动探测的 cooRoot。 */
export function resolveCooPaths(settings) {
  const root = detectCooRoot(settings) || '';
  const downloadsDir = typeof settings.cooDownloadsDir === 'string' && settings.cooDownloadsDir.trim() !== ''
    ? path.resolve(settings.cooDownloadsDir.trim())
    : path.join(settings.dshLinkRoot, 'coo-extensions');
  const extensionsDir = typeof settings.cooExtensionsDir === 'string' && settings.cooExtensionsDir.trim() !== ''
    ? path.resolve(settings.cooExtensionsDir.trim())
    : (root !== '' ? path.join(root, 'data', 'extensions') : path.join(settings.dshLinkRoot, 'coo-extensions-installed'));
  const pnpmPath = typeof settings.cooPnpmPath === 'string' && settings.cooPnpmPath.trim() !== ''
    ? settings.cooPnpmPath.trim()
    : (root !== '' ? path.join(root, 'resources', 'app', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') : '');
  return { root, downloadsDir, extensionsDir, pnpmPath };
}

/**
 * 合并 config 与 settings.json，得到本次请求实际使用的设置（bridge 地址 / SSH / UI / QQ）。
 */
export function resolveEffectiveSettings(settings) {
  let stored = null;
  try {
    const file = resolveSettingsFile(settings);
    stored = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    stored = null;
  }
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const local = mergeSettings(SETTINGS_DEFAULTS, stored);
  const ui = resolveUiConfig({
    ...(settings.ui && typeof settings.ui === 'object' ? settings.ui : {}),
    ...(raw.ui && typeof raw.ui === 'object' && !Array.isArray(raw.ui) ? raw.ui : {}),
  });
  const bridgeUrl = typeof raw.bridgeUrl === 'string' && raw.bridgeUrl.trim() !== ''
    ? raw.bridgeUrl.trim().replace(/\/$/, '')
    : settings.bridgeUrl;
  const sshHost = Object.prototype.hasOwnProperty.call(raw, 'serverSshHost')
    ? String(raw.serverSshHost ?? '').trim()
    : (settings.serverSshHost || settings.sshHost || '');
  const awarenessPatchPath = Object.prototype.hasOwnProperty.call(raw, 'awarenessPatchPath')
    ? String(raw.awarenessPatchPath ?? '').trim()
    : settings.awarenessPatchPath;
  const qq = {
    qqPreviewGroup: typeof raw.qqPreviewGroup === 'boolean' ? raw.qqPreviewGroup : settings.qqPreviewGroup,
    qqPreviewGroups: Array.isArray(raw.qqPreviewGroups) ? raw.qqPreviewGroups.slice() : [...settings.qqPreviewGroups],
    qqPreviewChats: Array.isArray(raw.qqPreviewChats) ? raw.qqPreviewChats.slice() : [...settings.qqPreviewChats],
    qqPreviewMaxItems: Number.isFinite(Number(raw.qqPreviewMaxItems)) ? Number(raw.qqPreviewMaxItems) : settings.qqPreviewMaxItems,
    qqPreviewMaxChars: Number.isFinite(Number(raw.qqPreviewMaxChars)) ? Number(raw.qqPreviewMaxChars) : settings.qqPreviewMaxChars,
  };
  return {
    ...settings,
    ...qq,
    ui,
    bridgeUrl,
    sshHost,
    serverSshHost: sshHost,
    awarenessPatchPath,
    localSettings: local,
    localRaw: raw,
    sshEnabled: sshHost !== '' && awarenessPatchPath !== '',
  };
}

/**
 * 解析并校验 bundle config。
 * @param {Record<string, unknown>} [config] patch 里的 config
 * @returns {{ ok: true, value: Record<string, any> } | { ok: false, error: string }}
 */
export function resolveConfig(config = {}) {
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  let bridgeUrl;
  try {
    bridgeUrl = normalizeBridgeUrl(merged.bridgeUrl);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const sessionId = typeof merged.sessionId === 'string' && SESSION_ID_PATTERN.test(merged.sessionId.trim())
    ? merged.sessionId.trim()
    : DEFAULTS.sessionId;
  const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
  const PLUGIN_PARENT = path.dirname(PLUGIN_DIR);
  const dshLinkRoot = trimmed(merged.dshLinkRoot) !== ''
    ? trimmed(merged.dshLinkRoot).replace(/[\\/]+$/, '')
    : PLUGIN_PARENT;
  const tokenFile = trimmed(merged.tokenFile) !== ''
    ? path.resolve(trimmed(merged.tokenFile))
    : path.join(dshLinkRoot, 'bridge', 'token.txt');
  const sshKey = trimmed(merged.sshKey) !== ''
    ? path.resolve(trimmed(merged.sshKey))
    : path.join(dshLinkRoot, '.ssh', 'id_ed25519');
  const sshKnownHosts = trimmed(merged.sshKnownHosts) !== ''
    ? path.resolve(trimmed(merged.sshKnownHosts))
    : path.join(dshLinkRoot, '.ssh', 'known_hosts');
  const configuredRoot = typeof merged.cooPetDataRoot === 'string' ? merged.cooPetDataRoot.trim() : '';
  const cooPetDataRoot = configuredRoot !== '' ? configuredRoot.replace(/[\\/]+$/, '') : path.join(dshLinkRoot, 'coo-pet-data');
  const resolveUnder = (value, fallbackName) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text !== '' ? path.resolve(text) : path.join(cooPetDataRoot, fallbackName);
  };
  const ui = resolveUiConfig(merged.ui);
  const qq = resolveQqConfig(merged);
  return {
    ok: true,
    value: {
      bridgeUrl,
      tokenFile,
      token: typeof merged.token === 'string' ? merged.token : '',
      sessionId,
      healthTimeoutMs: positive(merged.healthTimeoutMs, DEFAULTS.healthTimeoutMs),
      historyTimeoutMs: positive(merged.historyTimeoutMs, DEFAULTS.historyTimeoutMs),
      sayTimeoutMs: positive(merged.sayTimeoutMs, DEFAULTS.sayTimeoutMs),
      maxBodyBytes: positive(merged.maxBodyBytes, DEFAULTS.maxBodyBytes),
      dshLinkRoot,
      ui,
      ...qq,
      cooPetDataRoot,
      petSettingsFile: resolveUnder(merged.petSettingsFile, 'pet-settings.json'),
      petSkinFile: resolveUnder(merged.petSkinFile, 'skin.json'),
      petPacksDir: resolveUnder(merged.petPacksDir, 'web'),
      petImportMaxBytes: positive(merged.petImportMaxBytes, DEFAULTS.petImportMaxBytes),
      petImportTimeoutMs: positive(merged.petImportTimeoutMs, DEFAULTS.petImportTimeoutMs),
      visionEndpoint: typeof merged.visionEndpoint === 'string' && merged.visionEndpoint.trim() !== ''
        ? merged.visionEndpoint.trim()
        : DEFAULTS.visionEndpoint,
      visionModel: typeof merged.visionModel === 'string' && merged.visionModel.trim() !== ''
        ? merged.visionModel.trim()
        : DEFAULTS.visionModel,
      visionPrompt: typeof merged.visionPrompt === 'string' && merged.visionPrompt.trim() !== ''
        ? merged.visionPrompt.trim()
        : DEFAULTS.visionPrompt,
      visionTimeoutMs: positive(merged.visionTimeoutMs, DEFAULTS.visionTimeoutMs),
      screenShotDir: typeof merged.screenShotDir === 'string' ? merged.screenShotDir.trim() : '',
      cooExeName: typeof merged.cooExeName === 'string' && merged.cooExeName.trim() !== ''
        ? merged.cooExeName.trim()
        : DEFAULTS.cooExeName,
      cooProcessCacheMs: positive(merged.cooProcessCacheMs, DEFAULTS.cooProcessCacheMs),
      cooRestartWaitMs: positive(merged.cooRestartWaitMs, DEFAULTS.cooRestartWaitMs),
      cooMarketUrl: trimmed(merged.cooMarketUrl) !== '' ? trimmed(merged.cooMarketUrl) : DEFAULTS.cooMarketUrl,
      cooMarketCacheMs: positive(merged.cooMarketCacheMs, DEFAULTS.cooMarketCacheMs),
      cooMarketTimeoutMs: positive(merged.cooMarketTimeoutMs, DEFAULTS.cooMarketTimeoutMs),
      cooExtensionsDir: trimmed(merged.cooExtensionsDir),
      cooDownloadsDir: trimmed(merged.cooDownloadsDir),
      cooDownloadMaxBytes: positive(merged.cooDownloadMaxBytes, DEFAULTS.cooDownloadMaxBytes),
      cooDownloadTimeoutMs: positive(merged.cooDownloadTimeoutMs, DEFAULTS.cooDownloadTimeoutMs),
      cooTarPath: trimmed(merged.cooTarPath) !== '' ? trimmed(merged.cooTarPath) : DEFAULTS.cooTarPath,
      cooRoot: trimmed(merged.cooRoot).replace(/[\\/]+$/, ''),
      cooPnpmPath: trimmed(merged.cooPnpmPath),
      startupDir: trimmed(merged.startupDir),
      dashboardTimeoutMs: positive(merged.dashboardTimeoutMs, DEFAULTS.dashboardTimeoutMs),
      settingsFile: trimmed(merged.settingsFile),
      sshHost: trimmed(merged.serverSshHost) || trimmed(merged.sshHost),
      serverSshHost: trimmed(merged.serverSshHost) || trimmed(merged.sshHost),
      sshKey,
      sshKnownHosts,
      awarenessPatchPath: trimmed(merged.awarenessPatchPath),
      remoteDshService: trimmed(merged.remoteDshService) !== '' ? trimmed(merged.remoteDshService) : DEFAULTS.remoteDshService,
      remoteFileOwner: trimmed(merged.remoteFileOwner),
      sshTimeoutMs: positive(merged.sshTimeoutMs, DEFAULTS.sshTimeoutMs),
      applyRestartWaitMs: positive(merged.applyRestartWaitMs, DEFAULTS.applyRestartWaitMs),
      awarenessCacheMs: positive(merged.awarenessCacheMs, DEFAULTS.awarenessCacheMs),
    },
  };
}

/**
 * 只接受 http(s) + 回环主机名；返回去掉路径/query 的 origin。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBridgeUrl(value) {
  const raw = String(value ?? '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`whale-panel: bridgeUrl 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`whale-panel: bridgeUrl 必须是 http(s)：${raw}`);
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error(`whale-panel: bridgeUrl 必须是本机回环地址（红线），收到 ${url.hostname}`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Host 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  const log = ctx.logger ?? console;
  if (!resolved.ok) {
    log.error?.(`[whale-panel] 配置无效，面板不启用：${resolved.error}`);
    return;
  }
  const settings = resolved.value;
  const handler = createRouteHandler(settings, {
    getOrigin: () => {
      try {
        return ctx.webServer.getOrigin();
      } catch {
        return undefined;
      }
    },
    log,
  });
  for (const prefix of ROUTE_PREFIXES) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: prefix, handler }),
      `whale-panel: routes ${prefix}`,
    );
  }
  log.info?.(
    `[whale-panel] 已注册 ${ROUTE_PREFIXES.join('/*, ')}/* -> ${settings.bridgeUrl}`
    + `（session=${settings.sessionId}，总控台根=${settings.dshLinkRoot}）`,
  );
}

/**
 * 创建 `/whale-panel/*` 的请求处理器（与 Cordis 解耦，便于离线测试）。
 * @param {Record<string, any>} settings resolveConfig().value
 * @param {{ getOrigin?: () => string | undefined, log?: Console, fetchImpl?: typeof fetch }} [deps]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRouteHandler(settings, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const log = deps.log ?? console;
  const getOrigin = deps.getOrigin ?? (() => undefined);

  const proxy = (path, options = {}) => proxyJson(fetchImpl, resolveEffectiveSettings(settings), path, options);
  // 设置页读取服务器 QQ 配置的短期缓存（apply 后主动失效）
  const awarenessCache = { at: 0, value: null };
  // Coo 市场 npm 搜索结果缓存（10min；失败保留旧缓存）
  const marketCache = { at: 0, items: null, error: null };
  // Coo 主程序进程状态缓存（~3s；避免总控台轮询频繁起 PowerShell）
  const cooProcCache = { at: 0, value: null };
  // 本机视觉模型（Ollama）探测缓存 10s
  const visionProbeCache = { at: 0, value: null };

  return async function handleRoute(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求 URL 无法解析' } });
    }
    if (!isSameOrigin(req, getOrigin())) {
      return sendJson(res, 403, { ok: false, error: { code: 'forbidden-origin', message: '只允许 DSH 页面同源访问本机面板接口' } });
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    // config + settings.json 合并后的实际设置（bridge 地址 / SSH / UI / QQ 白名单）
    const effective = resolveEffectiveSettings(settings);

    try {
      if (path === `${ROUTE_PREFIX}/config`) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return await handleConfig(res, effective);
      }
      if (path === `${ROUTE_PREFIX}/health`) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        const result = await proxy('/health', { timeoutMs: effective.healthTimeoutMs });
        return sendJson(res, result.status, result.data);
      }
      if (path === `${ROUTE_PREFIX}/history`) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        const result = await proxy(buildHistoryPath(url.searchParams, effective), { timeoutMs: effective.historyTimeoutMs });
        return sendJson(res, result.status, result.data);
      }
      if (path === `${ROUTE_PREFIX}/say`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleSay(req, res, effective, proxy);
      }
      if (path === `${CONTROL_PREFIX}/status`) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        const status = await collectControlCenterStatus(effective, { fetchImpl, now: deps.now });
        return sendJson(res, 200, status);
      }
      if (path === `${CONTROL_PREFIX}/pause-context`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handlePauseContext(req, res, effective);
      }
      // ── T21：合并版面板的设置 / 服务器 QQ 预览 / 打开目录 ──
      if (path === `${ROUTE_PREFIX}/settings`) {
        if (method === 'GET') return await handleSettingsGet(res, effective, deps, awarenessCache);
        if (method === 'POST') return await handleSettingsPost(req, res, effective);
        return methodNotAllowed(res, 'GET, POST');
      }
      if (path === `${ROUTE_PREFIX}/apply-awareness`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleApplyAwareness(req, res, effective, deps, awarenessCache);
      }
      if (path === `${ROUTE_PREFIX}/open-directory`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleOpenDirectory(res, effective, deps);
      }
      // ── T23：桌宠 DIY ──
      if (path === `${ROUTE_PREFIX}/pet-diy`) {
        if (method === 'GET') return await handlePetDiyGet(res, effective);
        if (method === 'POST') return await handlePetDiyPost(req, res, effective);
        return methodNotAllowed(res, 'GET, POST');
      }
      // ── T30：桌宠形象包 ZIP 导入（原始二进制；只落文件，不执行包内代码）──
      if (path === `${ROUTE_PREFIX}/pet-diy/import-pack`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handlePetDiyImportPack(req, res, effective, deps, url.searchParams.get('replace') === '1');
      }
      // ── T24：Coo 市场（浏览）──
      if (path === `${ROUTE_PREFIX}/coo-market`) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return await handleCooMarketGet(res, effective, deps, marketCache);
      }
      // ── T25：Coo 市场下载 / 安装 / 打开目录（只写 coo-extensions；安装需显式确认）──
      if (path === `${ROUTE_PREFIX}/coo-market/download`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooMarketDownload(req, res, effective, deps);
      }
      if (path === `${ROUTE_PREFIX}/coo-market/install`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooMarketInstall(req, res, effective, deps);
      }
      if (path === `${ROUTE_PREFIX}/coo-market/open-dir`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooMarketOpenDir(res, effective, deps);
      }
      // ── T38：Coo 市场包 → 本机桌宠原生适配（只改本机开关/恢复 observer，不装 Coo 主程序）──
      if (path === `${ROUTE_PREFIX}/coo-market/apply`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooMarketApply(req, res, effective, deps);
      }
      // ── T33：Coo 插件列表 / 安装 / 卸载 / 运行 / 重启（主程序重启才加载新扩展；绝不杀 pet-host）──
      if (path === `${ROUTE_PREFIX}/coo-plugins`) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return await handleCooPluginsGet(res, effective, deps, cooProcCache);
      }
      if (path === `${ROUTE_PREFIX}/coo-plugins/install`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooPluginsInstall(req, res, effective, deps, cooProcCache);
      }
      if (path === `${ROUTE_PREFIX}/coo-plugins/uninstall`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooPluginsUninstall(req, res, effective, deps, cooProcCache);
      }
      if (path === `${ROUTE_PREFIX}/coo-plugins/run`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooPluginsRun(req, res, effective, deps, cooProcCache);
      }
      if (path === `${ROUTE_PREFIX}/coo-plugins/restart`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooPluginsRestart(req, res, effective, deps, cooProcCache);
      }
      if (path === `${ROUTE_PREFIX}/coo-plugins/open-dir`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleCooPluginsOpenDir(req, res, effective, deps);
      }
      // ── T34：本机桌宠插件（远程人格原生能力，只读聚合；与 Coopanion 扩展无关）──
      if (path === `${ROUTE_PREFIX}/pet-plugins`) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return await handlePetPluginsGet(res, effective, deps, visionProbeCache);
      }
      // ── T35：看屏幕（PowerShell 截图 → 本机 Ollama 视觉模型；不向外发图）──
      if (path === `${ROUTE_PREFIX}/screen-look`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleScreenLook(req, res, effective, deps);
      }
      // ── T37：自动看屏幕开关（写 screen-autolook.json 给 T36 桌宠插件读）──
      if (path === `${ROUTE_PREFIX}/pet-plugins/screen-auto`) {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await handleScreenAutoToggle(req, res, effective);
      }
      return sendJson(res, 404, {
        ok: false,
        error: { code: 'not-found', message: `未知的面板接口 ${method} ${path}` },
      });
    } catch (error) {
      log.warn?.(`[whale-panel] ${method} ${path} 处理失败：${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        return sendJson(res, 500, { ok: false, error: { code: 'internal', message: '面板接口内部错误' } });
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return undefined;
    }
  };
}

/**
 * `GET /whale-panel/config`：把 bridge 地址、sessionId、WS 地址和 token 交给同源 Client。
 * token 从 token 文件即时读取（bridge 重新生成 token 后无需重载插件）。
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, any>} settings
 */
async function handleConfig(res, settings) {
  const tokenResult = readBridgeToken(settings);
  const coo = resolveCooPaths(settings);
  return sendJson(res, 200, {
    ok: true,
    sessionId: settings.sessionId,
    bridgeUrl: settings.bridgeUrl,
    eventsUrl: `${settings.bridgeUrl.replace(/^http/, 'ws')}/events`,
    token: tokenResult.token,
    tokenPresent: typeof tokenResult.token === 'string',
    tokenError: tokenResult.error,
    ui: settings.ui,
    sshEnabled: settings.sshEnabled === true,
    qqDefaults: {
      qqPreviewGroup: settings.qqPreviewGroup,
      qqPreviewGroups: settings.qqPreviewGroups,
      qqPreviewChats: settings.qqPreviewChats,
      qqPreviewMaxItems: settings.qqPreviewMaxItems,
      qqPreviewMaxChars: settings.qqPreviewMaxChars,
    },
    paths: { dshLinkRoot: settings.dshLinkRoot, downloadsDir: coo.downloadsDir },
  });
}

/**
 * `POST /whale-panel/say`：把 `{text}` 交给 bridge 的阻塞 `/say`，原样透传结果。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, any>} settings
 * @param {(path: string, options?: Record<string, any>) => Promise<{ status: number, data: any }>} proxy
 */
async function handleSay(req, res, settings, proxy) {
  let raw;
  try {
    raw = await readBody(req, settings.maxBodyBytes);
  } catch (error) {
    if (error && error.code === 'payload-too-large') {
      return sendJson(res, 413, { ok: false, error: { code: 'payload-too-large', message: '消息太长了' } });
    }
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  let body;
  try {
    body = raw.trim() === '' ? null : JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体不是合法 JSON' } });
  }
  const text = body && typeof body.text === 'string' ? body.text : '';
  if (text.trim() === '') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'text 不能为空' } });
  }
  if (text.length > 8_000) {
    return sendJson(res, 400, { ok: false, error: { code: 'text-too-long', message: 'text 超过 8000 字' } });
  }
  const payload = { text };
  if (body && typeof body.requestId === 'string' && body.requestId !== '') payload.requestId = body.requestId;
  const result = await proxy('/say', { method: 'POST', body: payload, timeoutMs: settings.sayTimeoutMs });
  return sendJson(res, result.status, result.data);
}

/**
 * 把浏览器查询参数收敛成 bridge `/history` 的查询串（session 固定为配置值）。
 * @param {URLSearchParams} searchParams
 * @param {Record<string, any>} settings
 * @returns {string}
 */
function buildHistoryPath(searchParams, settings) {
  const params = new URLSearchParams();
  params.set('session', settings.sessionId);
  const limitRaw = Number(searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
  params.set('limit', String(limit));
  const before = searchParams.get('before');
  if (before && SESSION_ID_PATTERN.test(before)) params.set('before', before);
  return `/history?${params.toString()}`;
}

// ───────────────────────────── 总控台（T19） ─────────────────────────────

/** 情境观察器 PAUSED 开关的唯一允许路径（只由 dshLinkRoot 推导，客户端不能指定）。 */
export function contextPausedFile(settings) {
  return path.join(path.resolve(settings.dshLinkRoot), 'context-observer', 'PAUSED');
}

/** pid 是否存活（Windows 下 EPERM 视为存活）。 */
export function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/** 读 JSON 文件；失败返回 null（不抛）。 */
function readJsonSafe(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.trim() === '' ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** 读纯文本；失败返回 ''。 */
function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 文件 mtime（毫秒）；不存在返回 null。 */
function fileMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** 数字或 null。 */
function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 解析 pid 文本（数字或 JSON）。 */
function toPid(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

/** 当前用户的 Startup 目录。 */
export function resolveStartupDir(settings) {
  if (typeof settings.startupDir === 'string' && settings.startupDir !== '') return settings.startupDir;
  const appData = process.env.APPDATA;
  if (typeof appData === 'string' && appData !== '') {
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** 四个登录自启 vbs 是否存在。 */
export function collectAutostart(settings) {
  const dir = resolveStartupDir(settings);
  return AUTOSTART_FILES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    file: entry.file,
    path: path.join(dir, entry.file),
    installed: existsSync(path.join(dir, entry.file)),
  }));
}

/**
 * 本机组件状态（直接读文件/锁，不依赖 bridge）。
 * @param {Record<string, any>} settings
 * @param {number} [now]
 */
export function collectControlComponents(settings, now = Date.now()) {
  const root = settings.dshLinkRoot;
  return {
    observer: collectObserverComponent(path.join(root, 'context-observer'), now),
    sync: collectSyncComponent(path.join(root, 'server', 'awareness'), now),
    mirror: collectMirrorComponent(path.join(root, 'session-mirror'), now),
  };
}

function collectObserverComponent(dir, now) {
  const lock = readJsonSafe(path.join(dir, 'observer.lock'));
  const state = readJsonSafe(path.join(dir, 'state.json'));
  const pid = toPid(lock?.pid) ?? toPid(state?.pid);
  const logAt = fileMtime(path.join(dir, 'logs', 'observer.log'));
  const recentlyActive = logAt !== null && now - logAt < 120_000;
  return {
    running: isPidAlive(pid) || recentlyActive,
    pid,
    paused: state?.paused === true || existsSync(path.join(dir, 'PAUSED')),
    lastAt: finiteOrNull(state?.updatedAt),
    lastWindow: state?.lastWindow
      ? { process: String(state.lastWindow.process ?? ''), title: String(state.lastWindow.title ?? '') }
      : null,
    lastHeartbeatAt: finiteOrNull(state?.bridge?.lastHeartbeatAt),
    heartbeats: finiteOrNull(state?.counters?.heartbeats) ?? 0,
    bridgePid: finiteOrNull(state?.bridge?.pid),
    pending: finiteOrNull(state?.pusher?.pending) ?? 0,
    logAt,
  };
}

function collectSyncComponent(dir, now) {
  const pid = toPid(readTextSafe(path.join(dir, 'local-sync.pid')));
  const state = readJsonSafe(path.join(dir, 'state.json'));
  const logAt = fileMtime(path.join(dir, 'logs', 'local-sync.log'));
  const recentlyActive = logAt !== null && now - logAt < 120_000;
  return {
    running: isPidAlive(pid) || recentlyActive,
    pid,
    lastWriteAt: finiteOrNull(state?.lastWriteAt),
    lastFetchAt: finiteOrNull(state?.lastFetchAt),
    events: finiteOrNull(state?.lastEventCount) ?? 0,
    lastError: typeof state?.lastError === 'string' ? state.lastError : null,
    logAt,
  };
}

function collectMirrorComponent(dir, now) {
  const pid = toPid(readTextSafe(path.join(dir, 'mirror-loop.lock')));
  const state = readJsonSafe(path.join(dir, 'state.json'));
  const logAt = fileMtime(path.join(dir, 'logs', 'mirror-loop.log'));
  const recentlyActive = logAt !== null && now - logAt < 180_000;
  const sessions = state && typeof state.sessions === 'object' && state.sessions !== null
    ? Object.keys(state.sessions).length
    : null;
  return {
    running: isPidAlive(pid) || recentlyActive,
    pid,
    lastRunAt: finiteOrNull(state?.lastRunAt) ?? finiteOrNull(state?.lastMirrorAt) ?? logAt,
    mirrored: finiteOrNull(state?.mirroredCount) ?? sessions,
    lastError: typeof state?.lastError === 'string' ? state.lastError : null,
    logAt,
  };
}

/** 带 token 的 bridge GET；失败不抛，返回 {ok,status,data,error}。 */
async function fetchBridgeJson(settings, pathname, timeoutMs, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const token = readBridgeToken(settings).token;
  const url = new URL(`${settings.bridgeUrl}${pathname}`);
  if (typeof token === 'string') url.searchParams.set('token', token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 6_000));
  try {
    const response = await fetchImpl(url.href, {
      method: 'GET',
      cache: 'no-store',
      headers: typeof token === 'string'
        ? { accept: 'application/json', authorization: `Bearer ${token}`, 'x-bridge-token': token }
        : { accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, status: response.status, data: null, error: 'bad-json' };
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        error: (data && data.error && data.error.message) || `HTTP ${response.status}`,
      };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return {
      ok: false,
      status: 0,
      data: null,
      error: aborted ? 'timeout' : (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 聚合总控台状态：优先 bridge `/dashboard`（T18），缺失时降级为 /health + /mood +
 * /context + /diagnostics；本机组件状态始终直接读文件/锁（不依赖 bridge）。
 * 全部字段独立降级，本函数不会因为 bridge 不可用而失败。
 * @param {Record<string, any>} settings
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
 */
export async function collectControlCenterStatus(settings, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const errors = [];
  const tokenResult = readBridgeToken(settings);
  const dashboardResult = await fetchBridgeJson(settings, '/dashboard', settings.dashboardTimeoutMs, deps);
  const dashboard = dashboardResult.ok && dashboardResult.data && dashboardResult.data.ok !== false
    ? dashboardResult.data
    : null;
  if (dashboard === null) {
    errors.push({ field: 'dashboard', message: dashboardResult.error ?? 'unavailable' });
  }

  const healthResult = await fetchBridgeJson(settings, '/health', settings.healthTimeoutMs, deps);
  const health = healthResult.ok ? healthResult.data ?? null : null;
  if (health === null) errors.push({ field: 'health', message: healthResult.error ?? 'unavailable' });

  let mood = dashboard?.mood ?? null;
  if (mood === null) {
    const moodResult = await fetchBridgeJson(settings, '/mood', settings.healthTimeoutMs, deps);
    if (moodResult.ok) mood = moodResult.data?.mood ?? null;
    else errors.push({ field: 'mood', message: moodResult.error ?? 'unavailable' });
  }
  if (mood === null && health?.mood) mood = health.mood;

  let context = dashboard?.context ?? null;
  if (context === null) {
    const contextResult = await fetchBridgeJson(settings, '/context?limit=6', settings.healthTimeoutMs, deps);
    if (contextResult.ok) context = contextResult.data ?? null;
    else {
      context = health?.context ?? null;
      errors.push({ field: 'context', message: contextResult.error ?? 'unavailable' });
    }
  }

  let clients = health?.clients ?? null;
  if (clients === null) {
    const diagnosticsResult = await fetchBridgeJson(settings, '/diagnostics', settings.healthTimeoutMs, deps);
    if (diagnosticsResult.ok) clients = diagnosticsResult.data?.clients ?? null;
  }
  const wsChat = finiteOrNull(clients?.wsChat) ?? 0;
  const lastClientAt = finiteOrNull(clients?.lastWsClientAt);
  const pet = {
    online: wsChat > 0,
    brainConnected: wsChat > 0,
    wsChat,
    lastClientAt,
  };

  const components = collectControlComponents(settings, now);
  const paused = existsSync(contextPausedFile(settings));
  const contextEvents = context && Array.isArray(context.events)
    ? context.events
      .filter((event) => event && typeof event === 'object')
      .map((event) => ({
        at: finiteOrNull(event.at),
        surface: typeof event.surface === 'string' ? event.surface : 'unknown',
        kind: typeof event.kind === 'string' ? event.kind : 'activity',
        summary: String(event.summary ?? ''),
      }))
      .filter((event) => event.summary !== '')
      .sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
      .slice(0, 5)
    : [];

  return {
    ok: true,
    at: now,
    bridgeUrl: settings.bridgeUrl,
    dshLinkRoot: settings.dshLinkRoot,
    tokenPresent: typeof tokenResult.token === 'string',
    dashboard: {
      available: dashboard !== null,
      error: dashboard === null ? (dashboardResult.error ?? 'unavailable') : null,
      // T18：/dashboard 自带耗时（热路径 0–2ms）；面板顶部显示，便于诊断
      tookMs: dashboard !== null && Number.isFinite(Number(dashboard.tookMs)) ? Number(dashboard.tookMs) : null,
      // T18：单字段降级原因（不影响其它字段），透传给面板诊断
      errors: dashboard !== null && Array.isArray(dashboard.errors)
        ? dashboard.errors.filter((entry) => entry && typeof entry === 'object').slice(0, 5)
        : [],
    },
    bridge: dashboard?.bridge ?? (health
      ? { pid: finiteOrNull(health.pid), uptimeMs: finiteOrNull(health.uptimeMs), version: health.spec ?? null, busy: health.busy === true }
      : null),
    server: dashboard?.server ?? (health?.server
      ? {
        up: health.server.up === true,
        tunnel: health.server.tunnel === true,
        dshWeb: null,
        qqBridge: null,
        sessionExists: health.server.sessionExists !== false,
        sessionId: health.server.sessionId ?? settings.sessionId,
        agentPreset: health.server.agentPreset ?? null,
      }
      : null),
    mood: mood
      ? {
        label: typeof mood.label === 'string' ? mood.label : null,
        valence: finiteOrNull(mood.valence),
        arousal: finiteOrNull(mood.arousal),
        energy: typeof mood.energy === 'string' ? mood.energy : null,
        memoryCount: finiteOrNull(mood.memoryCount),
        updatedAt: finiteOrNull(mood.updatedAt),
      }
      : null,
    context: {
      available: context !== null,
      count: finiteOrNull(context?.count) ?? (Array.isArray(context?.events) ? context.events.length : 0),
      updatedAt: finiteOrNull(context?.updatedAt),
      events: contextEvents,
    },
    qq: dashboard?.qq
      ? {
        available: true,
        updatedAt: finiteOrNull(dashboard.qq.updatedAt),
        source: typeof dashboard.qq.source === 'string' ? dashboard.qq.source : null,
        lines: Array.isArray(dashboard.qq.lines)
          ? dashboard.qq.lines.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, 4)
          : [],
      }
      : {
        available: false,
        updatedAt: null,
        source: null,
        lines: [],
        reason: '需要 bridge /dashboard（T18 上线后自动出现 QQ 近况）',
      },
    pet,
    components,
    autostart: collectAutostart(settings),
    paused: { paused, path: contextPausedFile(settings) },
    errors,
  };
}

/**
 * 写/删 `context-observer/PAUSED`（只允许这个固定路径）。
 * @param {Record<string, any>} settings
 * @param {boolean} paused
 * @returns {{ok: boolean, paused?: boolean, path?: string, error?: string}}
 */
export function setContextPaused(settings, paused) {
  const expected = path.join(path.resolve(settings.dshLinkRoot), 'context-observer', 'PAUSED');
  const file = contextPausedFile(settings);
  if (path.resolve(file) !== path.resolve(expected)) {
    return { ok: false, error: 'pause 路径越界（只允许 context-observer/PAUSED）' };
  }
  try {
    if (paused === true) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `paused by whale-panel control-center at ${new Date().toISOString()}\n`, 'utf8');
    } else if (existsSync(file)) {
      unlinkSync(file);
    }
    return { ok: true, paused: existsSync(file), path: file };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `POST /control-center/pause-context`：body `{paused:true|false}`。
 */
async function handlePauseContext(req, res, settings) {
  let raw;
  try {
    raw = await readBody(req, settings.maxBodyBytes);
  } catch (error) {
    if (error && error.code === 'payload-too-large') {
      return sendJson(res, 413, { ok: false, error: { code: 'payload-too-large', message: '请求体太大' } });
    }
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  let body;
  try {
    body = raw.trim() === '' ? null : JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体不是合法 JSON' } });
  }
  if (!body || typeof body.paused !== 'boolean') {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: 'body 需要 {"paused": true|false}' },
    });
  }
  const result = setContextPaused(settings, body.paused);
  if (result.ok !== true) {
    return sendJson(res, 500, { ok: false, error: { code: 'pause-failed', message: result.error ?? '写 PAUSED 失败' } });
  }
  return sendJson(res, 200, { ok: true, paused: result.paused, path: result.path, at: Date.now() });
}

// ───────────────────────────── 桌宠 DIY（T23） ─────────────────────────────

/** pet-settings.json 默认值（与 coo-fork T22 schema 对齐；文件不存在时返回）。 */
export const PET_DIY_DEFAULTS = Object.freeze({
  skin: Object.freeze({
    figure: 'whale',
    scheme: 'harness',
    outfit: 'maid',
    palette: 'mint',
    head: 'none',
    side: 'none',
    glasses: 'none',
    neck: 'none',
  }),
  scale: 2,
  bubbleSize: 1,
  fontSize: 1,
  bubbleSpeed: 1,
  glow: 7,
  theme: 'dark',
  roam: 'free',
  sound: true,
  hoverButtons: Object.freeze(['chat', 'cooChat']),
  doubleClickChat: true,
  frameRate: 0,
  lockFrameRate: true,
});

/** 数值限制（前端 slider 也用这份）。 */
export const PET_DIY_LIMITS = Object.freeze({
  scale: Object.freeze({ min: 0.5, max: 3, step: 0.05 }),
  bubbleSize: Object.freeze({ min: 0.5, max: 2, step: 0.05 }),
  fontSize: Object.freeze({ min: 0.5, max: 2, step: 0.05 }),
  bubbleSpeed: Object.freeze({ min: 0.5, max: 2, step: 0.05 }),
  glow: Object.freeze({ min: 0, max: 14, step: 1, integer: true }),
  frameRate: Object.freeze({ min: 0, max: 60, step: 1, integer: true }),
  themes: Object.freeze(['light', 'dark']),
  roams: Object.freeze(['free', 'calm', 'off']),
});

/** 桌宠数据路径（设置/皮肤/pack 目录）。 */
export function petDiyPaths(settings) {
  return {
    dataRoot: settings.cooPetDataRoot,
    settingsFile: settings.petSettingsFile || path.join(settings.cooPetDataRoot, 'pet-settings.json'),
    skinFile: settings.petSkinFile || path.join(settings.cooPetDataRoot, 'skin.json'),
    packsDir: settings.petPacksDir || path.join(settings.cooPetDataRoot, 'web'),
  };
}

/** figure.json 里 name/本地化对象 → 字符串（优先中文，其次英文，最后 id）。 */
function localizedName(value, fallback = '') {
  if (typeof value === 'string' && value !== '') return value;
  if (value && typeof value === 'object') {
    if (typeof value.zh === 'string' && value.zh !== '') return value.zh;
    if (typeof value.en === 'string' && value.en !== '') return value.en;
    for (const item of Object.values(value)) if (typeof item === 'string' && item !== '') return item;
  }
  return fallback;
}

/** 扫描 packsDir 下每个包目录里的 figure.json，返回规范化形象包清单（失败跳过并记 warning）。 */
export function scanFigurePacks(packsDir) {
  const packs = [];
  const warnings = [];
  let entries = [];
  try {
    entries = readdirSync(packsDir, { withFileTypes: true });
  } catch (error) {
    return { packs, warnings: [`读不到形象包目录 ${packsDir}：${error instanceof Error ? error.message : String(error)}`] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packsDir, entry.name);
    const figurePath = path.join(dir, 'figure.json');
    if (!existsSync(figurePath)) continue; // web/ 下的 i18n/kit/speech 等支持目录不算形象包
    const figure = readJsonSafe(figurePath);
    if (!figure || typeof figure !== 'object') {
      warnings.push(`${entry.name}：figure.json 损坏`);
      continue;
    }
    const axes = Array.isArray(figure.axes) ? figure.axes
      .filter((axis) => axis && typeof axis === 'object' && typeof axis.id === 'string')
      .map((axis) => ({
        id: axis.id,
        name: localizedName(axis.name, axis.id),
        options: Array.isArray(axis.options) ? axis.options
          .filter((option) => option && typeof option === 'object' && typeof option.id === 'string')
          .map((option) => ({
            id: option.id,
            name: localizedName(option.name, option.id),
            ...(typeof option.accent === 'string' ? { accent: option.accent } : {}),
            ...(typeof option.thumb === 'string' ? { thumb: option.thumb } : {}),
          })) : [],
      })) : [];
    const presets = Array.isArray(figure.presets) ? figure.presets
      .filter((preset) => preset && typeof preset === 'object' && typeof preset.id === 'string')
      .map((preset) => ({
        id: preset.id,
        name: localizedName(preset.name, preset.id),
        pick: preset.pick && typeof preset.pick === 'object' ? { ...preset.pick } : {},
        ...(typeof preset.accent === 'string' ? { accent: preset.accent } : {}),
      })) : [];
    packs.push({
      id: typeof figure.id === 'string' && figure.id !== '' ? figure.id : entry.name,
      dir: entry.name,
      name: localizedName(figure.name, entry.name),
      version: typeof figure.version === 'string' ? figure.version : null,
      axes,
      presets,
    });
  }
  packs.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return { packs, warnings };
}

/** 合并默认值 + 存储值（保留未知字段）。 */
function mergePetDiySettings(stored) {
  const base = PET_DIY_DEFAULTS;
  const merged = {
    ...base,
    skin: { ...base.skin, ...(stored && typeof stored === 'object' && stored.skin && typeof stored.skin === 'object' ? stored.skin : {}) },
    hoverButtons: Array.isArray(stored?.hoverButtons) ? [...stored.hoverButtons] : [...base.hoverButtons],
  };
  if (stored && typeof stored === 'object') {
    for (const [key, value] of Object.entries(stored)) {
      if (key === 'skin' || key === 'hoverButtons') continue;
      merged[key] = value;
    }
  }
  return merged;
}

/** GET /whale-panel/pet-diy：设置 + 形象包清单 + 当前生效（skin.json 优先）。 */
export function readPetDiy(settings) {
  const paths = petDiyPaths(settings);
  const stored = readJsonSafe(paths.settingsFile);
  const skin = readJsonSafe(paths.skinFile);
  const scanned = scanFigurePacks(paths.packsDir);
  const parsedSettings = mergePetDiySettings(stored);
  // 当前生效：pet-settings（若存在）优先，skin.json 作为 fallback（与 coo-fork 约定一致）
  const storedSkin = stored && typeof stored === 'object' && stored.skin && typeof stored.skin === 'object' ? stored.skin : null;
  const current = {
    ...PET_DIY_DEFAULTS.skin,
    ...(skin && typeof skin === 'object' ? skin : {}),
    ...(storedSkin ?? {}),
    scale: Number.isFinite(Number(parsedSettings.scale)) ? Number(parsedSettings.scale) : PET_DIY_DEFAULTS.scale,
    bubbleSize: Number.isFinite(Number(parsedSettings.bubbleSize)) ? Number(parsedSettings.bubbleSize) : PET_DIY_DEFAULTS.bubbleSize,
    fontSize: Number.isFinite(Number(parsedSettings.fontSize)) ? Number(parsedSettings.fontSize) : PET_DIY_DEFAULTS.fontSize,
    bubbleSpeed: Number.isFinite(Number(parsedSettings.bubbleSpeed)) ? Number(parsedSettings.bubbleSpeed) : PET_DIY_DEFAULTS.bubbleSpeed,
    glow: Number.isFinite(Number(parsedSettings.glow)) ? Number(parsedSettings.glow) : PET_DIY_DEFAULTS.glow,
    theme: parsedSettings.theme,
    roam: parsedSettings.roam,
    sound: parsedSettings.sound !== false,
  };
  return {
    ok: true,
    at: Date.now(),
    settingsFile: paths.settingsFile,
    skinFile: paths.skinFile,
    packsDir: paths.packsDir,
    defaults: PET_DIY_DEFAULTS,
    limits: PET_DIY_LIMITS,
    settings: parsedSettings,
    settingsExists: stored !== null,
    skin: skin && typeof skin === 'object' ? skin : null,
    current,
    packs: scanned.packs,
    warnings: scanned.warnings,
  };
}

/** 校验数值字段（range + step + integer）。 */
function validatePetNumber(key, value, spec, errors) {
  const number = Number(value);
  if (!Number.isFinite(number)) { errors.push(`${key} 需要数字`); return undefined; }
  if (number < spec.min || number > spec.max) { errors.push(`${key} 需在 ${spec.min}–${spec.max} 之间`); return undefined; }
  if (spec.integer && !Number.isInteger(number)) { errors.push(`${key} 需要整数`); return undefined; }
  if (!spec.integer) {
    const steps = number / spec.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) { errors.push(`${key} 需要 ${spec.step} 的步进`); return undefined; }
  }
  return Math.round(number * 1000) / 1000;
}

/**
 * 校验 POST /whale-panel/pet-diy 的 body（白名单子集）。
 * @returns {{ok: boolean, patch?: object, errors?: string[]}}
 */
export function validatePetDiyPatch(input, packs) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['body 需要是 JSON 对象'] };
  }
  const allowedKeys = new Set([
    'skin', 'scale', 'bubbleSize', 'fontSize', 'bubbleSpeed', 'glow', 'theme', 'roam', 'sound',
    'hoverButtons', 'doubleClickChat', 'frameRate', 'lockFrameRate',
  ]);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) return { ok: false, errors: [`不支持的字段：${unknown.join(', ')}`] };
  const errors = [];
  const patch = {};
  const packById = new Map((packs ?? []).map((pack) => [pack.id, pack]));

  if (input.skin !== undefined) {
    if (!input.skin || typeof input.skin !== 'object' || Array.isArray(input.skin)) {
      return { ok: false, errors: ['skin 需要是对象'] };
    }
    const skin = {};
    const figureId = input.skin.figure;
    const pack = typeof figureId === 'string' ? packById.get(figureId) : null;
    if (figureId !== undefined) {
      if (typeof figureId !== 'string' || !packById.has(figureId)) {
        return { ok: false, errors: [`figure 不在形象包清单内：${String(figureId)}`] };
      }
      skin.figure = figureId;
    }
    const targetPack = pack ?? packById.get(PET_DIY_DEFAULTS.skin.figure) ?? (packs ?? [])[0];
    const axisById = new Map((targetPack?.axes ?? []).map((axis) => [axis.id, axis]));
    const FIXED_SKIN_FIELDS = ['scheme', 'outfit', 'palette', 'head', 'side', 'glasses', 'neck'];
    for (const [key, value] of Object.entries(input.skin)) {
      if (key === 'figure') continue;
      if (key === 'axes') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { ok: false, errors: ['skin.axes 需要对象'] };
        }
        const axesPatch = {};
        for (const [axisId, optionId] of Object.entries(value)) {
          const axis = axisById.get(axisId);
          if (!axis) return { ok: false, errors: [`skin.axes 不支持的轴：${axisId}`] };
          const optionIds = new Set(axis.options.map((option) => option.id));
          if (typeof optionId !== 'string' || !optionIds.has(optionId)) {
            return { ok: false, errors: [`skin.axes.${axisId} 的值不在选项内：${String(optionId)}`] };
          }
          axesPatch[axisId] = optionId;
        }
        skin.axes = axesPatch;
        continue;
      }
      if (!axisById.has(key) && !FIXED_SKIN_FIELDS.includes(key)) {
        return { ok: false, errors: [`不支持的 skin 字段：${key}`] };
      }
      if (typeof value !== 'string') return { ok: false, errors: [`skin.${key} 需要字符串`] };
      const axis = axisById.get(key);
      if (axis) {
        const optionIds = new Set(axis.options.map((option) => option.id));
        if (!optionIds.has(value)) {
          return { ok: false, errors: [`skin.${key} 的值不在形象包选项内：${value}`] };
        }
      }
      skin[key] = value;
    }
    patch.skin = skin;
  }

  if (input.scale !== undefined) { const v = validatePetNumber('scale', input.scale, PET_DIY_LIMITS.scale, errors); if (v !== undefined) patch.scale = v; }
  if (input.bubbleSize !== undefined) { const v = validatePetNumber('bubbleSize', input.bubbleSize, PET_DIY_LIMITS.bubbleSize, errors); if (v !== undefined) patch.bubbleSize = v; }
  if (input.fontSize !== undefined) { const v = validatePetNumber('fontSize', input.fontSize, PET_DIY_LIMITS.fontSize, errors); if (v !== undefined) patch.fontSize = v; }
  if (input.bubbleSpeed !== undefined) { const v = validatePetNumber('bubbleSpeed', input.bubbleSpeed, PET_DIY_LIMITS.bubbleSpeed, errors); if (v !== undefined) patch.bubbleSpeed = v; }
  if (input.glow !== undefined) { const v = validatePetNumber('glow', input.glow, PET_DIY_LIMITS.glow, errors); if (v !== undefined) patch.glow = v; }
  if (input.frameRate !== undefined) { const v = validatePetNumber('frameRate', input.frameRate, PET_DIY_LIMITS.frameRate, errors); if (v !== undefined) patch.frameRate = v; }
  if (input.theme !== undefined) {
    if (!PET_DIY_LIMITS.themes.includes(input.theme)) errors.push(`theme 只允许 ${PET_DIY_LIMITS.themes.join('/')}`);
    else patch.theme = input.theme;
  }
  if (input.roam !== undefined) {
    if (!PET_DIY_LIMITS.roams.includes(input.roam)) errors.push(`roam 只允许 ${PET_DIY_LIMITS.roams.join('/')}`);
    else patch.roam = input.roam;
  }
  for (const key of ['sound', 'doubleClickChat', 'lockFrameRate']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') errors.push(`${key} 需要 boolean`);
    else patch[key] = input[key];
  }
  if (input.hoverButtons !== undefined) {
    if (!Array.isArray(input.hoverButtons)) errors.push('hoverButtons 需要字符串数组');
    else {
      // 与 coo-fork 对齐：只保留页面真实存在的 action id，非法项静默过滤
      const allowed = ['chat', 'voice', 'roam', 'theme', 'sound', 'hide', 'dress', 'cooChat'];
      patch.hoverButtons = [...new Set(input.hoverButtons.map((item) => String(item).trim()))].filter((item) => allowed.includes(item));
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(patch).length === 0) return { ok: false, errors: ['没有可应用的字段'] };
  return { ok: true, patch };
}

/** 合并写 pet-settings.json（保留其它字段；备份 .bak；原子写）。 */
export function savePetDiy(settings, patch) {
  const paths = petDiyPaths(settings);
  const stored = readJsonSafe(paths.settingsFile);
  const base = stored && typeof stored === 'object' ? stored : {};
  const baseSkin = base.skin && typeof base.skin === 'object' ? base.skin : {};
  const patchSkin = patch.skin && typeof patch.skin === 'object' ? patch.skin : {};
  const next = {
    ...base,
    ...patch,
    skin: {
      ...baseSkin,
      ...patchSkin,
      ...(patchSkin.axes && typeof patchSkin.axes === 'object'
        ? { axes: { ...(baseSkin.axes && typeof baseSkin.axes === 'object' ? baseSkin.axes : {}), ...patchSkin.axes } }
        : {}),
    },
  };
  mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
  let backupPath = null;
  if (stored !== null) {
    backupPath = `${paths.settingsFile}.bak`;
    try { writeFileSync(backupPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8'); } catch { backupPath = null; }
  }
  const temporary = `${paths.settingsFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temporary, paths.settingsFile);
  return { ok: true, settings: next, file: paths.settingsFile, backupPath };
}

/**
 * `GET /whale-panel/pet-diy`。
 */
async function handlePetDiyGet(res, settings) {
  try {
    return sendJson(res, 200, readPetDiy(settings));
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'pet-diy-read-failed', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * `POST /whale-panel/pet-diy`：校验 + 合并写 + 回读（coo-fork T22 在 ~1s 内热应用）。
 */
async function handlePetDiyPost(req, res, settings) {
  let body;
  try {
    body = await readJsonBody(req, settings.maxBodyBytes);
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, {
      ok: false,
      error: { code: (error && error.code) || 'bad-request', message: error instanceof Error ? error.message : '读取请求体失败' },
    });
  }
  const snapshot = readPetDiy(settings);
  const validated = validatePetDiyPatch(body, snapshot.packs);
  if (!validated.ok) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: (validated.errors ?? []).join('；') },
    });
  }
  try {
    const saved = savePetDiy(settings, validated.patch);
    const readback = readPetDiy(settings);
    return sendJson(res, 200, {
      ok: true,
      applied: Object.keys(validated.patch),
      file: saved.file,
      backupPath: saved.backupPath,
      settings: readback.settings,
      current: readback.current,
      packs: readback.packs,
      warnings: readback.warnings,
      note: '已写入 pet-settings.json；桌宠插件应在 ~1s 内热应用',
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'pet-diy-write-failed', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

// ───────────────────────────── 自动看屏幕开关（T37，配合 T36） ─────────────────────────────
// 面板只读写两个本机小文件：screen-autolook.json（开关，面板写/T36 读）与
// screen-look-state.json（T36 写的运行状态，面板只读）。不执行任何第三方代码。

export const SCREEN_AUTO_FILE = 'screen-autolook.json';
export const SCREEN_STATE_FILE = 'screen-look-state.json';

/** 读 T36 自动看屏幕状态（不存在/损坏 → 默认空，不报错）。 */
export function readScreenAutoState(settings) {
  const petPaths = petDiyPaths(settings);
  const state = readJsonSafe(path.join(petPaths.dataRoot, SCREEN_STATE_FILE));
  const toggle = readJsonSafe(path.join(petPaths.dataRoot, SCREEN_AUTO_FILE));
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const toggleSource = toggle && typeof toggle === 'object' && !Array.isArray(toggle) ? toggle : {};
  const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    enabled: typeof source.enabled === 'boolean'
      ? source.enabled
      : (toggleSource.enabled === true),
    lastLookAt: finite(source.lastLookAt),
    lastSpokenAt: finite(source.lastSpokenAt),
    lastCaption: typeof source.lastCaption === 'string' ? source.lastCaption : '',
    lastSpoken: typeof source.lastSpoken === 'string' ? source.lastSpoken : '',
    totalLooks: finite(source.totalLooks) ?? 0,
    totalSpoken: finite(source.totalSpoken) ?? 0,
    lastError: typeof source.lastError === 'string' ? source.lastError : '',
  };
}

/** 原子写开关文件（确保 cooPetDataRoot 存在）。 */
export function writeScreenAutoToggle(settings, enabled) {
  const petPaths = petDiyPaths(settings);
  mkdirSync(petPaths.dataRoot, { recursive: true });
  const file = path.join(petPaths.dataRoot, SCREEN_AUTO_FILE);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const value = { enabled: enabled === true, updatedAt: new Date().toISOString() };
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  return { file, value };
}

/** POST /whale-panel/pet-plugins/screen-auto：{enabled:boolean} → 写开关文件。 */
async function handleScreenAutoToggle(req, res, settings) {
  let body;
  try {
    body = await readJsonBody(req, settings.maxBodyBytes);
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body 需要 {enabled:boolean}' } });
  }
  try {
    const written = writeScreenAutoToggle(settings, body.enabled);
    return sendJson(res, 200, {
      ok: true,
      enabled: written.value.enabled,
      updatedAt: written.value.updatedAt,
      file: written.file,
      note: written.value.enabled
        ? '已开启自动看屏幕；桌宠插件会在满足间隔/限流条件时自己看并决定说不说。'
        : '已关闭自动看屏幕。',
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'write-failed', message: error instanceof Error ? error.message : String(error) } });
  }
}

// ───────────────────────────── 本机视觉模型 / 看屏幕（T35） ─────────────────────────────
// 只访问配置的回环 Ollama；截图只写本机 coo-pet-data/screenshots，不外发、不执行第三方代码。

const VISION_PROBE_TIMEOUT_MS = 1_500;
const VISION_PROBE_CACHE_MS = 10_000;
const SCREEN_WIDTH = 640;
const SCREEN_HEIGHT = 360;

/** 视觉 endpoint 只允许 http/https + 回环。 */
export function normalizeVisionEndpoint(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') return '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/** 探测本机 Ollama 是否装有 visionModel（1.5s 超时，缓存 10s；失败不影响整个接口）。 */
export async function probeVision(settings, deps = {}, cache = { at: 0, value: null }) {
  const endpoint = normalizeVisionEndpoint(settings.visionEndpoint);
  const model = typeof settings.visionModel === 'string' ? settings.visionModel.trim() : '';
  if (endpoint === '' || model === '') {
    return { available: false, model, endpoint, reason: '未配置视觉模型 endpoint/model（或 endpoint 不是回环地址）' };
  }
  const now = Date.now();
  if (cache.value !== null && now - cache.at < VISION_PROBE_CACHE_MS) return cache.value;
  const fetchImpl = deps.visionFetch ?? deps.fetchImpl ?? globalThis.fetch;
  let value;
  try {
    const response = await fetchImpl(`${endpoint}/api/tags`, {
      headers: { accept: 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(VISION_PROBE_TIMEOUT_MS)
        : undefined,
    });
    if (!response || response.ok !== true) throw new Error(`HTTP ${response && response.status ? response.status : 'unknown'}`);
    const data = await response.json();
    const models = Array.isArray(data && data.models)
      ? data.models.map((entry) => (entry && typeof entry.name === 'string' ? entry.name : '')).filter((name) => name !== '')
      : [];
    const present = models.some((name) => name === model
      || name.startsWith(`${model}`)
      || model.startsWith(`${name}:`));
    value = present
      ? { available: true, model, endpoint, modelsCount: models.length }
      : { available: false, model, endpoint, modelsCount: models.length, reason: `本地视觉模型未运行/未安装（Ollama /api/tags 里没有 ${model}）` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    value = { available: false, model, endpoint, reason: `视觉模型不可用：${message}` };
  }
  cache.value = value;
  cache.at = now;
  return value;
}

/** 截图路径（默认 <cooPetDataRoot>/screenshots/latest.jpg）。 */
export function resolveScreenshotPath(settings) {
  const petPaths = petDiyPaths(settings);
  const dir = typeof settings.screenShotDir === 'string' && settings.screenShotDir.trim() !== ''
    ? path.resolve(settings.screenShotDir.trim())
    : path.join(petPaths.dataRoot, 'screenshots');
  return path.join(dir, 'latest.jpg');
}

/** PowerShell + System.Drawing 截主屏，缩放到 640x360 JPEG（质量 80）。 */
export async function captureScreenJpeg(settings, screenshotPath, deps = {}) {
  if (typeof deps.captureScreen === 'function') {
    const result = await deps.captureScreen(settings, screenshotPath);
    const bytes = Number(result && result.bytes) || (existsSync(screenshotPath) ? statSync(screenshotPath).size : 0);
    if (bytes <= 0) throw Object.assign(new Error('截图文件为空'), { code: 'capture-failed' });
    return { bytes };
  }
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('看屏幕只支持 Windows 本机截图'), { code: 'unsupported-platform' });
  }
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const safePath = String(screenshotPath).replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$s=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
    `$w=${SCREEN_WIDTH};$h=${SCREEN_HEIGHT};`,
    '$src=[System.Drawing.Bitmap]::new($s.Width,$s.Height);',
    '$sg=[System.Drawing.Graphics]::FromImage($src);',
    '$sg.CopyFromScreen($s.X,$s.Y,0,0,$s.Size);',
    '$bmp=[System.Drawing.Bitmap]::new($w,$h);',
    '$g=[System.Drawing.Graphics]::FromImage($bmp);',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
    '$g.DrawImage($src,0,0,$w,$h);',
    "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'} | Select-Object -First 1;",
    '$params=[System.Drawing.Imaging.EncoderParameters]::new(1);',
    '$params.Param[0]=[System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality,80);',
    `$bmp.Save('${safePath}',$codec,$params);`,
    '$sg.Dispose();$g.Dispose();$src.Dispose();$bmp.Dispose();',
  ].join(' ');
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`截图失败：${(stderr || '').trim() || error.message}`), { code: 'capture-failed' }));
      else resolve();
    });
  });
  if (!existsSync(screenshotPath)) throw Object.assign(new Error('截图失败：文件未生成'), { code: 'capture-failed' });
  const bytes = statSync(screenshotPath).size;
  if (bytes <= 0) throw Object.assign(new Error('截图失败：文件为空'), { code: 'capture-failed' });
  return { bytes };
}

/** 调本机 Ollama /api/generate（图片只发到 loopback）。 */
export async function callVisionModel(settings, imageBuffer, deps = {}) {
  const endpoint = normalizeVisionEndpoint(settings.visionEndpoint);
  const model = typeof settings.visionModel === 'string' ? settings.visionModel.trim() : '';
  if (endpoint === '' || model === '') {
    throw Object.assign(new Error('未配置视觉模型 endpoint/model（endpoint 必须是回环地址）'), { code: 'vision-unavailable', status: 502 });
  }
  const prompt = typeof settings.visionPrompt === 'string' && settings.visionPrompt.trim() !== ''
    ? settings.visionPrompt.trim()
    : 'Describe this screenshot in 2-3 short Chinese sentences. Answer in Chinese only. Do not read the screen word by word.';
  const timeoutMs = Math.max(1_000, Number(settings.visionTimeoutMs) || 120_000);
  const fetchImpl = deps.visionFetch ?? deps.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images: [imageBuffer.toString('base64')],
        stream: false,
        options: { num_ctx: 8192, num_predict: 120, temperature: 0.2, num_gpu: 0 },
      }),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
    });
  } catch (error) {
    const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.code === 'ETIMEDOUT');
    throw Object.assign(
      new Error(timeout ? `视觉模型推理超时（>${Math.round(timeoutMs / 1000)}s）` : `视觉模型请求失败：${error instanceof Error ? error.message : String(error)}`),
      { code: timeout ? 'vision-timeout' : 'vision-request-failed', status: timeout ? 504 : 502 },
    );
  }
  if (!response || response.ok !== true) {
    let detail = '';
    try { detail = response && typeof response.text === 'function' ? String(await response.text()).slice(0, 200) : ''; } catch { detail = ''; }
    throw Object.assign(new Error(`视觉模型返回 HTTP ${response && response.status ? response.status : 'unknown'}${detail ? `：${detail}` : ''}`), { code: 'vision-http-error', status: 502 });
  }
  const data = await response.json();
  const caption = data && typeof data.response === 'string' ? data.response.trim() : '';
  if (caption === '') throw Object.assign(new Error('视觉模型没有返回描述'), { code: 'vision-empty', status: 502 });
  return { caption, model, elapsedMs: Date.now() - startedAt };
}

/** POST /whale-panel/screen-look：截图 → Ollama 视觉描述（只在本机，不向外发图）。 */
async function handleScreenLook(req, res, settings, deps) {
  const screenshotPath = resolveScreenshotPath(settings);
  let capture;
  try {
    capture = await captureScreenJpeg(settings, screenshotPath, deps);
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: { code: (error && error.code) || 'capture-failed', message: error instanceof Error ? error.message : String(error) } });
  }
  let result;
  try {
    const image = readFileSync(screenshotPath);
    result = await callVisionModel(settings, image, deps);
  } catch (error) {
    const status = error && Number(error.status) ? Number(error.status) : 502;
    return sendJson(res, status, { ok: false, error: { code: (error && error.code) || 'vision-failed', message: error instanceof Error ? error.message : String(error) } });
  }
  return sendJson(res, 200, {
    ok: true,
    caption: result.caption,
    model: result.model,
    elapsedMs: result.elapsedMs,
    screenshot: { path: screenshotPath, bytes: capture.bytes },
    note: '截图只保存在本机 coo-pet-data/screenshots/latest.jpg，并只发到本机回环 Ollama。',
  });
}

// ───────────────────────────── 本机桌宠插件（T34） ─────────────────────────────
// 「本机桌宠」= dsh-coo-pet-remote（远程 DSH 人格）里的原生能力，不是 Coopanion 扩展。
// 这个接口只读聚合：context-observer 的前台感知、跨端接话配置、桌宠 DIY 形象包数量、看屏幕可用性。
// 不执行任何第三方代码、不改变远程 DSH 大脑/记忆/QQ 身份。

/**
 * `GET /whale-panel/pet-plugins`：本机桌宠原生能力状态。
 * 只读现有 observer 状态文件 + 设置 + 形象包目录。
 */
async function handlePetPluginsGet(res, settings, deps = {}, visionProbeCache = { at: 0, value: null }) {
  const now = Date.now();
  const components = collectControlComponents(settings, now);
  const observer = components.observer ?? {};
  const foreground = observer.lastWindow && typeof observer.lastWindow === 'object'
    ? {
      process: typeof observer.lastWindow.process === 'string' ? observer.lastWindow.process : '',
      title: typeof observer.lastWindow.title === 'string' ? observer.lastWindow.title : '',
    }
    : null;
  const petPaths = petDiyPaths(settings);
  const scanned = scanFigurePacks(petPaths.packsDir);
  const packCount = scanned.packs.length;
  const packs = scanned.packs.slice(0, 40).map((pack) => ({
    id: pack.id,
    name: pack.name,
    version: pack.version,
  }));
  const sshEnabled = settings.sshEnabled === true;
  const qqGroups = Array.isArray(settings.qqPreviewGroups) ? settings.qqPreviewGroups : [];
  const qqChats = Array.isArray(settings.qqPreviewChats) ? settings.qqPreviewChats : [];
  const crossChatConfigured = sshEnabled || qqGroups.length > 0 || qqChats.length > 0;
  const awarenessPatchPath = typeof settings.awarenessPatchPath === 'string' ? settings.awarenessPatchPath : '';
  return sendJson(res, 200, {
    ok: true,
    at: now,
    observer: {
      running: observer.running === true,
      paused: observer.paused === true,
      pid: Number.isFinite(Number(observer.pid)) ? Number(observer.pid) : null,
      lastHeartbeatAt: Number.isFinite(Number(observer.lastHeartbeatAt)) ? Number(observer.lastHeartbeatAt) : null,
      foreground,
    },
    crossChat: {
      configured: crossChatConfigured,
      sshEnabled,
      awarenessPatchConfigured: awarenessPatchPath !== '',
      qqGroupsCount: qqGroups.length,
      qqChatsCount: qqChats.length,
      note: '跨端接话 = 本机桌宠与 QQ 共用远程 DSH 人格/记忆；需要配置服务器 SSH 或 QQ 白名单。',
    },
    diy: {
      packCount,
      packs,
      packsError: scanned.warnings.length > 0 ? scanned.warnings[0] : null,
      note: '桌宠 DIY（形象包/大小/气泡/主题）只改本机外观，不改远程人格。',
    },
    screen: {
      ...(await probeVision(settings, deps, visionProbeCache)),
      auto: readScreenAutoState(settings),
      requires: 'vision-model',
    },
    note: '这些是本机桌宠（远程 DSH 人格）的原生插件，不是 Coopanion 扩展；保留远程人格、记忆与 QQ 同一身份。',
  });
}

// ───────────────────────────── Coo 插件列表 / 启动（T33） ─────────────────────────────
// 总控台「Coo 插件」卡：列出已下载（coo-extensions）与已安装（Coopanion data/extensions）的 Cortico 扩展；
// 安装/卸载走 Coopanion 自带 pnpm → **需重启 Coopanion 主程序才加载**；运行/重启只 spawn Coopanion.exe，
// 绝不杀带 --pet-host / --type= 的 pet-host 进程，也不执行任何扩展代码。

/** 分类 Coopanion 进程：主程序 = 不含 --pet-host/--type=；其余算 pet-host/子进程。 */
export function classifyCooProcesses(processes) {
  const list = Array.isArray(processes) ? processes : [];
  const main = [];
  const petHost = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const pid = Number(entry.pid ?? entry.ProcessId) || 0;
    if (pid <= 0) continue;
    const commandLine = typeof entry.commandLine === 'string'
      ? entry.commandLine
      : (typeof entry.CommandLine === 'string' ? entry.CommandLine : '');
    if (commandLine.includes('--pet-host') || commandLine.includes('--type=')) petHost.push(pid);
    else main.push(pid);
  }
  main.sort((left, right) => left - right);
  petHost.sort((left, right) => left - right);
  return { running: main.length > 0, pids: main, petHostPids: petHost };
}

/** 默认进程列表：PowerShell CIM 查 Coopanion.exe 的 PID+CommandLine（失败返回 []）。 */
export function defaultListCoopanionProcesses(settings, timeoutMs = 8_000) {
  const command = "Get-CimInstance Win32_Process -Filter \"Name='Coopanion.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  try {
    const output = decodeCliOutput(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: timeoutMs, encoding: 'buffer',
    }));
    const parsed = JSON.parse(String(output).trim() || '[]');
    const array = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    return array
      .map((entry) => ({ pid: Number(entry.ProcessId) || 0, commandLine: String(entry.CommandLine || '') }))
      .filter((entry) => entry.pid > 0);
  } catch {
    return [];
  }
}

/** 读 Coopanion 进程（缓存 ~3s）。 */
async function readCooProcesses(settings, deps, cache) {
  const now = Date.now();
  const ttl = Math.max(200, Number(settings.cooProcessCacheMs) || 3_000);
  if (cache.value !== null && now - cache.at < ttl) return cache.value;
  const list = deps.listProcesses
    ? await deps.listProcesses(settings)
    : defaultListCoopanionProcesses(settings);
  const classified = classifyCooProcesses(list);
  cache.value = classified;
  cache.at = now;
  return classified;
}

/** 从本地 package.json 读 Coo 扩展元数据（kind/displayName 等）。 */
export function readCooPluginPackage(packageFile) {
  const pkg = readJsonSafe(packageFile);
  if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string') return null;
  const cortico = pkg.cortico && typeof pkg.cortico === 'object' ? pkg.cortico : {};
  const rawKind = typeof cortico.kind === 'string' ? cortico.kind : '';
  const kind = ['world', 'provider', 'bot', 'panel'].includes(rawKind) ? rawKind : 'other';
  const displayName = localizedName(cortico.displayName ?? cortico.name ?? pkg.displayName ?? pkg.name, pkg.name);
  return {
    name: pkg.name,
    version: typeof pkg.version === 'string' ? pkg.version : '',
    kind,
    displayName,
    description: typeof pkg.description === 'string' ? pkg.description : '',
  };
}

/** 扫描已下载（coo-extensions）的 Coo 插件元数据。 */
export function scanDownloadedCooPlugins(dir) {
  const entries = scanDownloadedExtensions(dir).downloaded;
  return entries.map((entry) => {
    const info = readCooPluginPackage(path.join(dir, entry.dir, 'package.json')) ?? {};
    return {
      name: entry.name,
      version: info.version || entry.version,
      kind: info.kind || 'other',
      displayName: info.displayName || entry.name,
      description: info.description || '',
      downloadedAt: entry.downloadedAt,
      bytes: entry.bytes,
      dir: entry.dir,
    };
  }).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

/** 扫描 Coopanion 已安装的 Coo 插件（支持 extensions/<pkg> 与 extensions/node_modules/<pkg>、@scope）。 */
export function scanInstalledCooPlugins(dir) {
  const list = [];
  const add = (packageFile, relativeDir) => {
    const info = readCooPluginPackage(packageFile);
    if (info) list.push({ ...info, dir: relativeDir });
  };
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === 'node_modules') {
      try {
        for (const child of readdirSync(path.join(dir, 'node_modules'), { withFileTypes: true })) {
          // pnpm 的 node_modules/<pkg> 是指向 .pnpm/... 的符号链接；Dirent.isDirectory() 为 false，
          // 必须把 symlink 也当目录读，否则「已安装」列表永远为空（真机踩过）。
          if (child.name.startsWith('.')) continue;
          if (!child.isDirectory() && !child.isSymbolicLink()) continue;
          if (child.name.startsWith('@')) {
            for (const scoped of readdirSync(path.join(dir, 'node_modules', child.name), { withFileTypes: true })) {
              if (scoped.isDirectory() || scoped.isSymbolicLink()) add(path.join(dir, 'node_modules', child.name, scoped.name, 'package.json'), `${child.name}/${scoped.name}`);
            }
          } else {
            add(path.join(dir, 'node_modules', child.name, 'package.json'), `node_modules/${child.name}`);
          }
        }
      } catch { /* ignore */ }
      continue;
    }
    add(path.join(dir, entry.name, 'package.json'), entry.name);
  }
  return list.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

/** Coo 根/exe/pnpm 上下文（root 未探测到 → ok:false）。 */
export function resolveCooRuntime(settings) {
  const coo = resolveCooPaths(settings);
  const root = coo.root;
  const exe = root !== '' ? path.join(root, settings.cooExeName || 'Coopanion.exe') : '';
  return {
    ...coo,
    exe,
    exeExists: exe !== '' && existsSync(exe),
    rootExists: root !== '' && existsSync(root),
  };
}

/** 默认卸载：Coopanion 自带 pnpm remove（只改 extensions 目录）。 */
function defaultUninstallFromCoopanion(settings, name, deps = {}) {
  const coo = resolveCooPaths(settings);
  const pnpmPath = coo.pnpmPath;
  if (pnpmPath === '' || !existsSync(pnpmPath)) {
    return Promise.reject(new Error(`找不到 Coopanion 自带 pnpm${pnpmPath ? `：${pnpmPath}` : '（未探测到 Coopanion 安装）'}；可到 Coopanion 设置→扩展 手动卸载`));
  }
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [pnpmPath, 'remove', name, '--config.strict-dep-builds=false', '--dir', coo.extensionsDir, '--reporter=append-only'], {
      cwd: coo.extensionsDir,
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (error) reject(new Error(`pnpm remove 失败：${error.message}\n${output.split(/\r?\n/).slice(-6).join('\n')}`));
      else resolve({ output: output.split(/\r?\n/).slice(-8).join('\n') });
    });
  });
}

/** 默认启动 Coopanion 主程序（固定 exe，detached，不执行扩展代码）。 */
export function spawnCoopanion(settings, runtime, deps = {}) {
  const spawnImpl = typeof deps.spawnProcess === 'function' ? deps.spawnProcess : spawn;
  // DSH 的宿主/工具进程可能带 ELECTRON_RUN_AS_NODE=1；Coopanion 是 Electron 应用，
  // 继承这个变量会被当成 Node 跑并以 0 退出（真机踩过：点了「运行」窗口不出现）。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnImpl(runtime.exe, [], {
    cwd: runtime.root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  if (child && typeof child.unref === 'function') child.unref();
  return { pid: child && Number(child.pid) ? Number(child.pid) : null };
}

/** 默认杀主进程（taskkill /F）。 */
function defaultKillProcess(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve());
  });
}

function readJsonBodySafe(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

/** GET /whale-panel/coo-plugins：下载/已装/主程序状态。 */
async function handleCooPluginsGet(res, settings, deps, procCache) {
  const runtime = resolveCooRuntime(settings);
  const processes = await readCooProcesses(settings, deps, procCache);
  const downloaded = scanDownloadedCooPlugins(runtime.downloadsDir);
  const installed = scanInstalledCooPlugins(runtime.extensionsDir);
  const installedByName = new Map(installed.map((item) => [item.name, item]));
  return sendJson(res, 200, {
    ok: true,
    coo: {
      running: processes.running,
      pids: processes.pids,
      petHostPids: processes.petHostPids,
      root: runtime.root || null,
      exe: runtime.exeExists ? runtime.exe : null,
      canLaunch: runtime.exeExists,
    },
    extensionsDir: runtime.extensionsDir,
    downloadsDir: runtime.downloadsDir,
    warning: runtime.root === '' ? '未探测到 Coopanion 安装目录（可通过 config cooRoot 指定）' : null,
    downloaded: downloaded.map((item) => {
      const installedItem = installedByName.get(item.name);
      return {
        ...item,
        installed: Boolean(installedItem),
        installedVersion: installedItem ? installedItem.version : null,
      };
    }),
    installed,
  });
}

/** POST /whale-panel/coo-plugins/install：只装已下载包（pnpm add），需 confirm。 */
async function handleCooPluginsInstall(req, res, settings, deps, procCache) {
  let body;
  try {
    body = readJsonBodySafe(await readJsonBody(req, settings.maxBodyBytes));
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  if (!body || body.confirm !== true) {
    return sendJson(res, 400, { ok: false, error: { code: 'confirmation-required', message: '需要 confirm:true 才会把第三方扩展安装到 Coopanion（第三方代码将在 Coopanion 里运行，需重启 Coopanion 生效）。' } });
  }
  const validated = validatePackageName(body.name);
  if (!validated.ok) return sendJson(res, 400, { ok: false, error: { code: 'invalid-name', message: validated.error } });
  const runtime = resolveCooRuntime(settings);
  if (runtime.root === '') return sendJson(res, 400, { ok: false, error: { code: 'coo-root-missing', message: '未探测到 Coopanion 安装目录（可通过 config cooRoot 指定）' } });
  const downloaded = scanDownloadedCooPlugins(runtime.downloadsDir).find((item) => item.name === validated.name);
  if (!downloaded) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-downloaded', message: `本机还没有下载 ${validated.name}（先到 Coo 市场下载）` } });
  }
  try {
    const install = deps.runInstall
      ? await deps.runInstall({ name: downloaded.name, version: downloaded.version, extensionsDir: runtime.extensionsDir, settings })
      : await defaultInstallIntoCoopanion(settings, downloaded.name, downloaded.version);
    procCache.value = null;
    procCache.at = 0;
    const processes = await readCooProcesses(settings, deps, procCache);
    return sendJson(res, 200, {
      ok: true,
      installed: true,
      name: downloaded.name,
      version: downloaded.version,
      needRestart: true,
      cooRunning: processes.running,
      pids: processes.pids,
      extensionsDir: runtime.extensionsDir,
      output: install && install.output ? String(install.output) : '',
      message: processes.running
        ? '已加入 Coopanion；Coo 正在运行，需重启 Coopanion 才会加载新扩展'
        : '已加入 Coopanion；点击「运行」启动 Coopanion 后加载',
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'install-failed', message: error instanceof Error ? error.message : String(error), hint: '可到 Coopanion 设置 → 扩展 手动安装' } });
  }
}

/** POST /whale-panel/coo-plugins/uninstall：只卸已装包（pnpm remove），需 confirm。 */
async function handleCooPluginsUninstall(req, res, settings, deps, procCache) {
  let body;
  try {
    body = readJsonBodySafe(await readJsonBody(req, settings.maxBodyBytes));
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  if (!body || body.confirm !== true) {
    return sendJson(res, 400, { ok: false, error: { code: 'confirmation-required', message: '需要 confirm:true 才会从 Coopanion 卸载扩展（卸载后需重启 Coopanion 生效）。' } });
  }
  const validated = validatePackageName(body.name);
  if (!validated.ok) return sendJson(res, 400, { ok: false, error: { code: 'invalid-name', message: validated.error } });
  const runtime = resolveCooRuntime(settings);
  if (runtime.root === '') return sendJson(res, 400, { ok: false, error: { code: 'coo-root-missing', message: '未探测到 Coopanion 安装目录' } });
  const installed = scanInstalledCooPlugins(runtime.extensionsDir).find((item) => item.name === validated.name);
  if (!installed) return sendJson(res, 404, { ok: false, error: { code: 'not-installed', message: `Coopanion 里没有安装 ${validated.name}` } });
  try {
    const removed = deps.runUninstall
      ? await deps.runUninstall({ name: installed.name, extensionsDir: runtime.extensionsDir, settings })
      : await defaultUninstallFromCoopanion(settings, installed.name);
    procCache.value = null;
    procCache.at = 0;
    const processes = await readCooProcesses(settings, deps, procCache);
    return sendJson(res, 200, {
      ok: true,
      removed: true,
      name: installed.name,
      needRestart: true,
      cooRunning: processes.running,
      output: removed && removed.output ? String(removed.output) : '',
      message: '已从 Coopanion 卸载；需重启 Coopanion 使其不再加载',
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'uninstall-failed', message: error instanceof Error ? error.message : String(error), hint: '可到 Coopanion 设置 → 扩展 手动卸载' } });
  }
}

/** POST /whale-panel/coo-plugins/run：已装且 Coo 未运行 → spawn 主程序；未装/在跑分别 409。 */
async function handleCooPluginsRun(req, res, settings, deps, procCache) {
  let body;
  try {
    body = readJsonBodySafe(await readJsonBody(req, settings.maxBodyBytes));
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  const validated = validatePackageName(body && body.name);
  if (!validated.ok) return sendJson(res, 400, { ok: false, error: { code: 'invalid-name', message: validated.error } });
  const runtime = resolveCooRuntime(settings);
  if (runtime.root === '') return sendJson(res, 400, { ok: false, error: { code: 'coo-root-missing', message: '未探测到 Coopanion 安装目录' } });
  const installed = scanInstalledCooPlugins(runtime.extensionsDir).some((item) => item.name === validated.name);
  if (!installed) return sendJson(res, 409, { ok: false, error: { code: 'need-install', message: `先安装 ${validated.name} 再运行` }, needInstall: true, name: validated.name });
  procCache.value = null;
  procCache.at = 0;
  const processes = await readCooProcesses(settings, deps, procCache);
  if (processes.running) {
    return sendJson(res, 409, { ok: false, error: { code: 'need-restart', message: 'Coo 已经在运行；新扩展需要重启 Coopanion 才加载' }, needRestart: true, pids: processes.pids });
  }
  if (!runtime.exeExists) return sendJson(res, 400, { ok: false, error: { code: 'coo-exe-missing', message: `找不到 ${runtime.exe}（可检查 config cooRoot/cooExeName）` } });
  try {
    const launched = deps.spawnCoopanion ? await deps.spawnCoopanion(settings, runtime) : spawnCoopanion(settings, runtime);
    procCache.value = null;
    return sendJson(res, 200, {
      ok: true,
      launched: true,
      pid: launched && launched.pid ? launched.pid : null,
      exe: runtime.exe,
      message: '已启动 Coopanion；新扩展会在 Coopanion 启动时加载',
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'launch-failed', message: error instanceof Error ? error.message : String(error) } });
  }
}

/** POST /whale-panel/coo-plugins/restart：confirm 后只杀主进程（不含 --pet-host/--type=）再 spawn。 */
async function handleCooPluginsRestart(req, res, settings, deps, procCache) {
  let body;
  try {
    body = readJsonBodySafe(await readJsonBody(req, settings.maxBodyBytes));
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  if (!body || body.confirm !== true) {
    return sendJson(res, 400, { ok: false, error: { code: 'confirmation-required', message: '需要 confirm:true 才会重启 Coopanion（会结束当前 Coo 主程序，不影响 pet-host）。' } });
  }
  const runtime = resolveCooRuntime(settings);
  if (runtime.root === '') return sendJson(res, 400, { ok: false, error: { code: 'coo-root-missing', message: '未探测到 Coopanion 安装目录' } });
  if (!runtime.exeExists) return sendJson(res, 400, { ok: false, error: { code: 'coo-exe-missing', message: `找不到 ${runtime.exe}` } });
  procCache.value = null;
  procCache.at = 0;
  const processes = await readCooProcesses(settings, deps, procCache);
  const killed = [];
  try {
    for (const pid of processes.pids) {
      if (pid <= 0 || processes.petHostPids.includes(pid)) continue;
      if (deps.killProcess) await deps.killProcess(pid);
      else await defaultKillProcess(pid);
      killed.push(pid);
    }
    const waitMs = Math.max(0, Number(settings.cooRestartWaitMs) || 1_500);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const launched = deps.spawnCoopanion ? await deps.spawnCoopanion(settings, runtime) : spawnCoopanion(settings, runtime);
    procCache.value = null;
    return sendJson(res, 200, {
      ok: true,
      restarted: true,
      killed,
      launched: true,
      pid: launched && launched.pid ? launched.pid : null,
      petHostPids: processes.petHostPids,
      message: '已重启 Coopanion 主程序（pet-host 未受影响）；新扩展会在启动时加载',
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'restart-failed', message: error instanceof Error ? error.message : String(error), killed } });
  }
}

/** POST /whale-panel/coo-plugins/open-dir：explorer 打开 extensions/downloads 固定目录。 */
async function handleCooPluginsOpenDir(req, res, settings, deps) {
  if (process.platform !== 'win32') {
    return sendJson(res, 501, { ok: false, error: { code: 'unsupported-platform', message: '打开目录仅支持 Windows' } });
  }
  let body = null;
  try { body = readJsonBodySafe(await readJsonBody(req, settings.maxBodyBytes)); } catch { body = null; }
  const which = body && body.which === 'downloads' ? 'downloads' : 'extensions';
  const runtime = resolveCooRuntime(settings);
  const target = which === 'downloads' ? runtime.downloadsDir : runtime.extensionsDir;
  try {
    mkdirSync(target, { recursive: true });
    const execFileImpl = deps.execFile ?? execFile;
    execFileImpl('explorer.exe', [target], { windowsHide: false }, () => {});
    return sendJson(res, 200, { ok: true, path: target, which });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'open-failed', message: error instanceof Error ? error.message : String(error) } });
  }
}

// ───────────────────────────── 桌宠形象包 ZIP 导入（T30） ─────────────────────────────
// 用户把 Coo 形象包 zip 上传到本机 → 校验 zip 条目/路径穿越 → 解包临时目录 → 找 figure.json
// → 校验 id → 安装到 coo-pet-data/figures/<id> 与 web/<id>（已存在 409；replace=1 先备份）。
// 只复制普通文件，拒绝符号链接；**绝不执行**包内代码。

/** zip 条目上限 / figure.json 的 id 规则。 */
export const PET_IMPORT_MAX_ENTRIES = 5000;
export const PET_FIGURE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 读取原始二进制请求体（兼容 application/zip；超过 maxBytes → payload-too-large）。 */
export function readRawBody(req, maxBytes, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('上传超时'), { code: 'timeout' }));
      try { req.destroy?.(); } catch { /* ignore */ }
    }, Math.max(1_000, timeoutMs));
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        finish(Object.assign(new Error(`上传文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`), { code: 'payload-too-large' }));
        try { req.destroy?.(); } catch { /* ignore */ }
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', (error) => finish(Object.assign(new Error('读取上传内容失败'), { code: 'bad-request', cause: error })));
  });
}

/** 校验 zip 条目：拒绝绝对路径/盘符/.. /空条目/超长/超数量。 */
export function validateImportZipEntries(entries, maxEntries = PET_IMPORT_MAX_ENTRIES) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { ok: false, error: 'zip 里没有文件' };
  if (list.length > maxEntries) return { ok: false, error: `zip 条目过多（${list.length} > ${maxEntries}）` };
  const normalized = [];
  for (const raw of list) {
    const text = String(raw ?? '').trim();
    if (text === '') return { ok: false, error: 'zip 含空条目' };
    if (text.length > 1024) return { ok: false, error: `zip 条目路径太长：${text.slice(0, 80)}…` };
    const slash = text.replace(/\\/g, '/');
    if (slash.startsWith('/')) return { ok: false, error: `zip 含绝对路径条目：${text}` };
    if (/^[a-zA-Z]:/.test(slash)) return { ok: false, error: `zip 含盘符条目：${text}` };
    const parts = slash.split('/').filter((part) => part !== '');
    if (parts.length === 0) return { ok: false, error: 'zip 含空条目' };
    if (parts.includes('..')) return { ok: false, error: `zip 含路径穿越条目：${text}` };
    normalized.push(slash);
  }
  return { ok: true, entries: normalized };
}

/** 在解包目录里找 figure.json（深度 ≤ maxDepth，返回按深度/路径排序的列表）。 */
export function findFigureJson(root, maxDepth = 3) {
  const matches = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (entry.isFile() && entry.name === 'figure.json') {
        matches.push({ file: full, dir, depth, relative: path.relative(root, full) });
      }
    }
  };
  walk(root, 0);
  matches.sort((left, right) => left.depth - right.depth || left.relative.localeCompare(right.relative));
  return matches;
}

/** 递归复制形象包目录（只允许普通文件/目录；拒绝符号链接/特殊文件）。 */
export function copyPackDirectory(sourceDir, targetDir) {
  let files = 0;
  const walk = (source, target) => {
    const stats = lstatSync(source);
    if (stats.isSymbolicLink()) throw Object.assign(new Error('形象包含符号链接，拒绝导入'), { code: 'unsafe-pack' });
    if (stats.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        walk(path.join(source, entry.name), path.join(target, entry.name));
      }
      return;
    }
    if (!stats.isFile()) throw Object.assign(new Error('形象包含非普通文件，拒绝导入'), { code: 'unsafe-pack' });
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    files += 1;
  };
  walk(sourceDir, targetDir);
  return files;
}

/** 系统 tar 列 zip 条目（Windows 自动用 System32 tar）。 */
function defaultZipList(settings, zipPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(resolveTarBinary(settings), ['-tf', zipPath], {
      windowsHide: true,
      timeout: Math.max(5_000, timeoutMs),
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`tar 列出 zip 条目失败：${(stderr || '').trim() || error.message}`));
      else resolve(String(stdout).split(/\r?\n/).filter((line) => line.trim() !== ''));
    });
  });
}

/** 系统 tar 解包 zip（-xf 自动识别格式）。 */
function defaultZipExtract(settings, zipPath, destDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(resolveTarBinary(settings), ['-xf', zipPath, '-C', destDir], {
      windowsHide: true,
      timeout: Math.max(5_000, timeoutMs),
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`tar 解包 zip 失败：${(stderr || '').trim() || error.message}`));
      else resolve();
    });
  });
}

/** 解包 + 校验 + 安装形象包（不执行任何内容）。 */
export async function installImportedPack(settings, zipBuffer, options = {}, deps = {}) {
  const replace = options.replace === true;
  const dataRoot = settings.cooPetDataRoot;
  const figuresDir = path.join(dataRoot, 'figures');
  const webDir = path.join(dataRoot, 'web');
  const timeoutMs = Math.max(5_000, Number(settings.petImportTimeoutMs) || 120_000);
  let tempRoot = null;
  try {
    mkdirSync(dataRoot, { recursive: true });
    tempRoot = mkdtempSync(path.join(dataRoot, '.tmp-import-'));
    const zipPath = path.join(tempRoot, 'upload.zip');
    writeFileSync(zipPath, zipBuffer);

    let rawEntries;
    try {
      rawEntries = deps.zipList
        ? await deps.zipList(settings, zipPath, { timeoutMs })
        : await defaultZipList(settings, zipPath, timeoutMs);
    } catch (error) {
      return { ok: false, status: 400, code: 'bad-zip', error: `不是有效的 ZIP：${error instanceof Error ? error.message : String(error)}` };
    }
    const entriesCheck = validateImportZipEntries(rawEntries);
    if (!entriesCheck.ok) return { ok: false, status: 400, code: 'unsafe-zip', error: entriesCheck.error };

    const extractDir = path.join(tempRoot, 'extract');
    mkdirSync(extractDir, { recursive: true });
    try {
      if (deps.zipExtract) await deps.zipExtract(settings, zipPath, extractDir, { timeoutMs });
      else await defaultZipExtract(settings, zipPath, extractDir, timeoutMs);
    } catch (error) {
      return { ok: false, status: 400, code: 'bad-zip', error: `解包 ZIP 失败：${error instanceof Error ? error.message : String(error)}` };
    }

    const matches = findFigureJson(extractDir, 3);
    if (matches.length === 0) {
      return { ok: false, status: 400, code: 'no-figure', error: 'zip 里没找到 figure.json（需位于深度 3 以内的目录）' };
    }
    if (matches.length > 1) {
      return { ok: false, status: 400, code: 'multiple-figures', error: `找到多个 figure.json（${matches.length} 个），请一个 zip 只放一个形象包` };
    }
    const figureFile = matches[0].file;
    const figure = readJsonSafe(figureFile);
    if (!figure || typeof figure !== 'object') {
      return { ok: false, status: 400, code: 'bad-figure', error: 'figure.json 不是合法 JSON 对象' };
    }
    const id = typeof figure.id === 'string' ? figure.id.trim() : '';
    if (!PET_FIGURE_ID_RE.test(id)) {
      return { ok: false, status: 400, code: 'bad-id', error: `figure.json 的 id 不合法（需 ^[a-z0-9][a-z0-9-]{0,31}$）：${id || '(空)'}` };
    }
    const name = localizedName(figure.name, '');
    if (name === '') return { ok: false, status: 400, code: 'bad-name', error: 'figure.json 缺少可读的 name' };
    const version = typeof figure.version === 'string' ? figure.version : '';
    const packRoot = path.dirname(figureFile);
    const figuresTarget = path.join(figuresDir, id);
    const webTarget = path.join(webDir, id);
    const exists = existsSync(figuresTarget) || existsSync(webTarget);
    if (exists && !replace) {
      return {
        ok: false,
        status: 409,
        code: 'already-exists',
        id,
        exists: true,
        error: `形象包 ${id} 已存在；如要替换请带 ?replace=1 再次上传`,
      };
    }

    let backupDir = null;
    if (exists) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupDir = path.join(figuresDir, `.backup-${id}-${stamp}`);
      mkdirSync(backupDir, { recursive: true });
      if (existsSync(figuresTarget)) renameSync(figuresTarget, path.join(backupDir, 'figures'));
      if (existsSync(webTarget)) renameSync(webTarget, path.join(backupDir, 'web'));
    }

    const stage = path.join(tempRoot, 'stage');
    let files = 0;
    try {
      files = copyPackDirectory(packRoot, stage);
      mkdirSync(figuresDir, { recursive: true });
      mkdirSync(webDir, { recursive: true });
      copyPackDirectory(stage, figuresTarget);
      copyPackDirectory(stage, webTarget);
    } catch (error) {
      for (const target of [figuresTarget, webTarget]) {
        try { rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (backupDir !== null) {
        try { if (existsSync(path.join(backupDir, 'figures'))) renameSync(path.join(backupDir, 'figures'), figuresTarget); } catch { /* ignore */ }
        try { if (existsSync(path.join(backupDir, 'web'))) renameSync(path.join(backupDir, 'web'), webTarget); } catch { /* ignore */ }
        try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      throw error;
    }

    return {
      ok: true,
      id,
      name,
      version,
      replaced: exists,
      dirs: [figuresTarget, webTarget],
      files,
      backupDir,
    };
  } catch (error) {
    const code = error && error.code === 'unsafe-pack' ? 'unsafe-pack' : 'import-failed';
    return { ok: false, status: code === 'unsafe-pack' ? 400 : 500, code, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (tempRoot !== null) {
      try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/** POST /whale-panel/pet-diy/import-pack：原始 zip 上传（同源校验在 handleRoute 统一做）。 */
async function handlePetDiyImportPack(req, res, settings, deps, replace) {
  const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  if (contentType !== '' && !/^application\/(zip|x-zip-compressed|octet-stream)\b/.test(contentType)) {
    return sendJson(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: '请上传 ZIP 文件（Content-Type: application/zip）' } });
  }
  const limit = Math.max(1, Number(settings.petImportMaxBytes) || 128 * 1024 * 1024);
  let body;
  try {
    body = await readRawBody(req, limit, Math.max(5_000, Number(settings.petImportTimeoutMs) || 120_000));
  } catch (error) {
    const code = error && error.code ? error.code : 'bad-request';
    const status = code === 'payload-too-large' ? 413 : (code === 'timeout' ? 408 : 400);
    return sendJson(res, status, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
  }
  const result = await installImportedPack(settings, body, { replace }, deps);
  if (!result.ok) {
    return sendJson(res, result.status || 400, {
      ok: false,
      error: { code: result.code || 'import-failed', message: result.error },
      ...(typeof result.id === 'string' ? { id: result.id } : {}),
      ...(result.exists === true ? { exists: true } : {}),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    id: result.id,
    name: result.name,
    version: result.version,
    replaced: result.replaced === true,
    dirs: result.dirs,
    files: result.files,
    backupDir: result.backupDir,
    note: '已导入形象包（未执行包内任何代码）；可在「形象包」下拉中选择，保存并应用后桌宠 ~1s 内变化。',
  });
}

// ───────────────────────────── Coo 市场浏览（T24） ─────────────────────────────
// Coo/Coopanion 的扩展是 npm 包（cortico-world-* / cortico-provider-* / cortico-bot-*），由 Cortico Core
// 安装到 Coopanion data/extensions 并在 Coopanion 运行时执行。本插件只浏览 npm 元数据 + 指出安装位置，
// 绝不安装/执行扩展代码。

/** Coo 市场 kind 列表（client 筛选用）。 */
export const COO_MARKET_KINDS = Object.freeze(['world', 'provider', 'bot', 'panel', 'other']);

/** 从 name/keywords/description 推断扩展类型。 */
export function inferMarketKind(name, keywords, description) {
  const pkgName = typeof name === 'string' ? name.toLowerCase() : '';
  const words = Array.isArray(keywords) ? keywords.map((item) => String(item).toLowerCase()) : [];
  const text = `${pkgName} ${typeof description === 'string' ? description.toLowerCase() : ''} ${words.join(' ')}`;
  if (pkgName.startsWith('cortico-world-') || words.includes('cortico-world')) return 'world';
  if (pkgName.startsWith('cortico-provider-') || words.includes('cortico-provider')) return 'provider';
  if (pkgName.startsWith('cortico-bot-') || words.includes('cortico-bot')) return 'bot';
  if (pkgName.startsWith('cortico-panel-') || words.includes('cortico-panel')) return 'panel';
  if (pkgName === 'cortico' || words.includes('cortico-framework') || text.includes('framework')) return 'other';
  return 'other';
}

/** npm search 单条结果 → 市场 item（字段与 client 契约固定）。 */
export function normalizeMarketItem(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const pkg = entry.package && typeof entry.package === 'object' ? entry.package : null;
  if (!pkg || typeof pkg.name !== 'string' || pkg.name === '') return null;
  const links = pkg.links && typeof pkg.links === 'object' ? pkg.links : {};
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map((item) => String(item)) : [];
  const description = typeof pkg.description === 'string' ? pkg.description : '';
  const kind = inferMarketKind(pkg.name, keywords, description);
  return {
    name: pkg.name,
    version: typeof pkg.version === 'string' ? pkg.version : '',
    description,
    keywords,
    downloadsMonthly: Number.isFinite(Number(entry.downloads && entry.downloads.monthly))
      ? Number(entry.downloads.monthly)
      : 0,
    updated: typeof pkg.date === 'string' ? pkg.date : (typeof entry.updated === 'string' ? entry.updated : null),
    homepage: typeof links.homepage === 'string' ? links.homepage : null,
    repository: typeof links.repository === 'string' ? links.repository : null,
    npm: typeof links.npm === 'string' ? links.npm : `https://www.npmjs.com/package/${pkg.name}`,
    license: typeof pkg.license === 'string' ? pkg.license : null,
    publisher: pkg.publisher && typeof pkg.publisher.username === 'string' ? pkg.publisher.username : null,
    kind,
  };
}

/** 扫描本机 Coopanion 已安装扩展（extensions 下每个包目录的 package.json；失败/不存在返回 []）。 */
export function scanInstalledExtensions(dir) {
  const installed = [];
  const warnings = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { installed, warnings };
  }
  const readInstalledFrom = (packageFile, dirName) => {
    if (!existsSync(packageFile)) return;
    const pkg = readJsonSafe(packageFile);
    if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string') {
      warnings.push(`${dirName}：package.json 损坏`);
      return;
    }
    installed.push({
      name: pkg.name,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      dir: dirName,
    });
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules') {
      // pnpm add 之后的布局：extensions/node_modules/<pkg>/ 与 extensions/node_modules/@scope/<pkg>/
      for (const child of readdirSync(path.join(dir, 'node_modules'), { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        if (child.name.startsWith('@')) {
          for (const scoped of readdirSync(path.join(dir, 'node_modules', child.name), { withFileTypes: true })) {
            if (scoped.isDirectory()) readInstalledFrom(path.join(dir, 'node_modules', child.name, scoped.name, 'package.json'), scoped.name);
          }
        } else {
          readInstalledFrom(path.join(dir, 'node_modules', child.name, 'package.json'), child.name);
        }
      }
      continue;
    }
    readInstalledFrom(path.join(dir, entry.name, 'package.json'), entry.name);
  }
  installed.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return { installed, warnings };
}

/** 真实拉 npm search（可注入 npmFetch 便于测试）。 */
async function fetchCooMarketItems(settings, deps) {
  const fetchImpl = deps.npmFetch ?? deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 不支持 fetch');
  const timeoutMs = Math.max(1_000, Number(settings.cooMarketTimeoutMs) || 15_000);
  const response = await fetchImpl(settings.cooMarketUrl, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-whale-panel/1.4.0 coo-market' },
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  });
  if (!response || typeof response.ok !== 'boolean' || response.ok !== true) {
    throw new Error(`npm registry HTTP ${response && response.status ? response.status : 'unknown'}`);
  }
  const data = await response.json();
  const objects = data && Array.isArray(data.objects) ? data.objects : [];
  const items = objects
    .map((entry) => normalizeMarketItem(entry))
    .filter((item) => item !== null && /cortico/i.test(item.name));
  items.sort((left, right) => (right.downloadsMonthly - left.downloadsMonthly)
    || String(left.name).localeCompare(String(right.name)));
  return items;
}

/** T38：Coo 市场包 → 本机桌宠原生适配注册表（首版两个；其余 unsupported）。 */
export const COO_MARKET_NATIVE_ADAPTERS = Object.freeze({
  'cortico-world-screen-look': Object.freeze({
    adapter: 'screen',
    label: '自动看屏幕',
    appliedHint: '开启本机桌宠自动看屏幕（T36 负责节奏与是否说话）',
  }),
  'cortico-world-gaming-alont1': Object.freeze({
    adapter: 'foreground',
    label: '前台感知 / 游戏陪玩',
    appliedHint: '恢复本机桌宠前台感知（若被暂停）',
  }),
});

/** 未适配包的统一说明。 */
export const COO_MARKET_UNSUPPORTED_REASON = '该包是 Coopanion 扩展，本机桌宠暂未适配（需要原生适配）';

/** 查一个包是否有本机桌宠原生适配。 */
export function resolveCooMarketNative(name) {
  const entry = typeof name === 'string' && Object.prototype.hasOwnProperty.call(COO_MARKET_NATIVE_ADAPTERS, name)
    ? COO_MARKET_NATIVE_ADAPTERS[name]
    : null;
  if (!entry) {
    return { supported: false, adapter: null, label: '', appliedHint: '', reason: COO_MARKET_UNSUPPORTED_REASON };
  }
  return { supported: true, adapter: entry.adapter, label: entry.label, appliedHint: entry.appliedHint, reason: '' };
}

/** 推断某适配当前是否已应用（screen → autolook enabled；foreground → observer 未暂停）。 */
function cooMarketNativeApplied(settings, native) {
  if (!native || native.supported !== true) return false;
  if (native.adapter === 'screen') return readScreenAutoState(settings).enabled === true;
  if (native.adapter === 'foreground') return collectControlComponents(settings, Date.now()).observer.paused !== true;
  return false;
}

/**
 * `GET /whale-panel/coo-market`：npm 搜索（缓存 10min）+ 本机已安装扩展映射 + 原生适配标记。
 * 失败不崩：有缓存回 ok:false + cached:true + 旧数据；无缓存回 ok:false + 空列表。
 */
async function handleCooMarketGet(res, settings, deps, cache) {
  const now = Date.now();
  const ttl = Math.max(1_000, Number(settings.cooMarketCacheMs) || 600_000);
  const cooPaths = resolveCooPaths(settings);
  const installedScan = scanInstalledExtensions(cooPaths.extensionsDir);
  const installedNames = new Set(installedScan.installed.map((entry) => entry.name));
  const downloadsScan = scanDownloadedExtensions(cooPaths.downloadsDir);
  const downloadedByName = new Map(downloadsScan.downloaded.map((entry) => [entry.name, entry]));
  let cached = false;
  let refreshError = null;

  if (cache.items === null || now - cache.at > ttl) {
    try {
      cache.items = await fetchCooMarketItems(settings, deps);
      cache.at = Date.now();
      cache.error = null;
    } catch (error) {
      refreshError = error instanceof Error ? error.message : String(error);
      cache.error = refreshError;
      if (cache.items !== null) cached = true;
    }
  } else {
    cached = true;
  }

  const items = (cache.items ?? []).map((item) => {
    const downloaded = downloadedByName.get(item.name) ?? null;
    const native = resolveCooMarketNative(item.name);
    return {
      ...item,
      native: { ...native, applied: cooMarketNativeApplied(settings, native) },
      installed: installedNames.has(item.name),
      installedVersion: installedScan.installed.find((entry) => entry.name === item.name)?.version ?? null,
      downloaded: downloaded !== null,
      downloadedVersion: downloaded ? downloaded.version : null,
      downloadedAt: downloaded ? downloaded.downloadedAt : null,
    };
  });
  const kindCounts = items.reduce((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});
  const updatedAt = cache.items !== null ? new Date(cache.at).toISOString() : null;
  return sendJson(res, 200, {
    ok: cache.items !== null && refreshError === null,
    updatedAt,
    cached,
    error: refreshError,
    items,
    installed: installedScan.installed,
    installedDir: cooPaths.extensionsDir,
    downloaded: downloadsScan.downloaded,
    downloadsDir: cooPaths.downloadsDir,
    cooRoot: cooPaths.root,
    kindCounts,
    source: settings.cooMarketUrl,
    note: '这些是 Coo/Coopanion 的扩展包，不能直接运行在本机桌宠；已适配包下载后可一键应用到本机桌宠（自动看屏幕/前台感知），未适配的暂不生效。',
  });
}

// ───────────────────────────── Coo 市场下载 / 安装（T25） ─────────────────────────────
// 只下载 npm tarball 到本机 coo-extensions（绝不执行代码）；安装到 Coopanion 需要用户显式 confirm，
// 用 Coopanion 自带的 pnpm 做 best-effort 安装，并明确提示需要重启 Coopanion 才生效。

/** npm 包名白名单（scoped 允许；长度 ≤ 214；不允许大写/空格/..）。 */
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** 校验 npm 包名；返回 {ok, name?, error?}。 */
export function validatePackageName(input) {
  if (typeof input !== 'string') return { ok: false, error: 'name 需要字符串' };
  const name = input.trim();
  if (name === '') return { ok: false, error: 'name 不能为空' };
  if (name.length > 214) return { ok: false, error: 'name 太长（npm 上限 214）' };
  if (name.includes('..') || name.startsWith('.') || name.startsWith('_')) {
    return { ok: false, error: 'name 不能包含 .. / 不能以 . 或 _ 开头' };
  }
  if (!PACKAGE_NAME_RE.test(name)) return { ok: false, error: `不是合法 npm 包名：${name}` };
  return { ok: true, name };
}

/** 包名 → 下载目录下的安全子目录名（@scope/name → scope__name）。 */
export function safePackageDir(name) {
  return String(name)
    .replace(/^@/, '')
    .replace(/[\\/]+/g, '__')
    .replace(/[^a-zA-Z0-9._~-]/g, '_')
    .slice(0, 180) || 'package';
}

/** tar 条目安全检查：拒绝绝对路径/盘符/.. 穿越，且必须全部在 package/ 根下。 */
export function validateTarEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { ok: false, error: 'tarball 内没有文件' };
  for (const entry of list) {
    const text = String(entry).replace(/\\/g, '/');
    if (text === '' || text === './') continue;
    if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return { ok: false, error: `tarball 含绝对路径条目：${text}` };
    const parts = text.split('/');
    if (parts.includes('..')) return { ok: false, error: `tarball 含路径穿越条目：${text}` };
    if (parts[0] !== 'package' && parts[0] !== 'package/') return { ok: false, error: `tarball 顶层不是 package/：${text}` };
  }
  return { ok: true };
}

/** 扫描已下载扩展（coo-extensions/<dir>/_meta.json）。 */
export function scanDownloadedExtensions(dir) {
  const downloaded = [];
  const warnings = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { downloaded, warnings: [], dir };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const meta = readJsonSafe(path.join(dir, entry.name, '_meta.json'));
    if (!meta || typeof meta !== 'object' || typeof meta.name !== 'string') continue;
    downloaded.push({
      name: meta.name,
      version: typeof meta.version === 'string' ? meta.version : '',
      dir: entry.name,
      downloadedAt: typeof meta.downloadedAt === 'string' ? meta.downloadedAt : null,
      bytes: Number.isFinite(Number(meta.bytes)) ? Number(meta.bytes) : 0,
    });
  }
  downloaded.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return { downloaded, warnings, dir };
}

/** 默认下载器：fetch 取 tarball，限制字节数与超时，写到 destPath。 */
export async function downloadFileTo(url, destPath, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 不支持 fetch');
  const maxBytes = Number(options.maxBytes) || 200 * 1024 * 1024;
  const timeoutMs = Number(options.timeoutMs) || 120_000;
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'dsh-whale-panel/1.5.0 coo-market-download' },
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  });
  if (!response || response.ok !== true) throw new Error(`下载 tarball 失败：HTTP ${response && response.status ? response.status : 'unknown'}`);
  const chunks = [];
  let bytes = 0;
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error(`tarball 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
      chunks.push(buffer);
    }
  } else if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    bytes = buffer.length;
    if (bytes > maxBytes) throw new Error(`tarball 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    chunks.push(buffer);
  } else {
    throw new Error('无法读取 tarball 响应体');
  }
  writeFileSync(destPath, Buffer.concat(chunks));
  return { bytes };
}

/** 解析系统 tar（Windows 必须用 System32	ar.exe，避免 PATH 里的 MSYS/Git tar 不认盘符路径）。 */
export function resolveTarBinary(settings) {
  const configured = typeof settings.cooTarPath === 'string' && settings.cooTarPath.trim() !== '' ? settings.cooTarPath.trim() : 'tar.exe';
  if (/[\/]/.test(configured)) return configured;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:/Windows';
    const candidate = path.join(systemRoot, 'System32', 'tar.exe');
    if (existsSync(candidate)) return candidate;
  }
  return configured;
}

/** 默认 tar -tzf：列条目。 */
function defaultTarList(settings, tarPath) {
  return new Promise((resolve, reject) => {
    execFile(resolveTarBinary(settings), ['-tzf', tarPath], { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`tar 列出条目失败：${(stderr || '').trim() || error.message}`));
      else resolve(String(stdout).split(/\r?\n/).filter((line) => line.trim() !== ''));
    });
  });
}

/** 默认 tar -xzf：解包到 destDir。 */
function defaultTarExtract(settings, tarPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile(resolveTarBinary(settings), ['-xzf', tarPath, '-C', destDir], { windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`tar 解包失败：${(stderr || '').trim() || error.message}`));
      else resolve();
    });
  });
}

/** 下载并解包一个 npm 扩展包到 coo-extensions（不执行任何代码）。 */
export async function downloadCooExtension(settings, rawName, deps = {}) {
  const validated = validatePackageName(rawName);
  if (!validated.ok) return { ok: false, code: 'invalid-name', error: validated.error, status: 400 };
  const name = validated.name;
  const dirName = safePackageDir(name);
  const cooPaths = resolveCooPaths(settings);
  const targetDir = path.join(cooPaths.downloadsDir, dirName);
  const fetchImpl = deps.npmFetch ?? deps.fetchImpl ?? globalThis.fetch;

  const metadataResponse = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json', 'user-agent': 'dsh-whale-panel/1.5.0 coo-market-download' },
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(Math.max(2_000, Number(settings.cooMarketTimeoutMs) || 15_000))
      : undefined,
  });
  if (!metadataResponse || metadataResponse.ok !== true) {
    return {
      ok: false,
      code: metadataResponse && metadataResponse.status === 404 ? 'not-found' : 'metadata-failed',
      error: `npm 元数据请求失败：HTTP ${metadataResponse && metadataResponse.status ? metadataResponse.status : 'unknown'}`,
      status: metadataResponse && metadataResponse.status === 404 ? 404 : 502,
    };
  }
  const metadata = await metadataResponse.json();
  const latest = metadata && metadata['dist-tags'] && typeof metadata['dist-tags'].latest === 'string'
    ? metadata['dist-tags'].latest
    : null;
  const versionInfo = latest && metadata.versions ? metadata.versions[latest] : null;
  if (!latest || !versionInfo || !versionInfo.dist || typeof versionInfo.dist.tarball !== 'string') {
    return { ok: false, code: 'bad-metadata', error: 'npm 元数据缺少 dist-tags.latest / dist.tarball', status: 502 };
  }
  const tarball = versionInfo.dist.tarball;
  const integrity = typeof versionInfo.dist.integrity === 'string' ? versionInfo.dist.integrity : null;
  const existing = readJsonSafe(path.join(targetDir, '_meta.json'));
  if (existing && existing.name === name && existing.version === latest) {
    return { ok: true, cached: true, name, version: latest, dir: targetDir, bytes: Number(existing.bytes) || 0, tarball, integrity };
  }

  mkdirSync(cooPaths.downloadsDir, { recursive: true });
  const tempRoot = path.join(cooPaths.downloadsDir, `.tmp-${safePackageDir(name)}-${process.pid}-${Date.now()}`);
  const tarFile = path.join(tempRoot, 'package.tgz');
  const extractDir = path.join(tempRoot, 'extract');
  try {
    mkdirSync(extractDir, { recursive: true });
    const download = deps.downloadFile
      ? await deps.downloadFile(tarball, tarFile, { maxBytes: settings.cooDownloadMaxBytes, timeoutMs: settings.cooDownloadTimeoutMs }, deps)
      : await downloadFileTo(tarball, tarFile, { maxBytes: settings.cooDownloadMaxBytes, timeoutMs: settings.cooDownloadTimeoutMs }, { fetchImpl });
    const bytes = Number(download && download.bytes) || readFileSync(tarFile).length;

    const entries = deps.tarList ? await deps.tarList(tarFile) : await defaultTarList(settings, tarFile);
    const entriesCheck = validateTarEntries(entries);
    if (!entriesCheck.ok) return { ok: false, code: 'unsafe-tarball', error: entriesCheck.error, status: 422 };

    if (deps.tarExtract) await deps.tarExtract(tarFile, extractDir);
    else await defaultTarExtract(settings, tarFile, extractDir);

    const packageRoot = path.join(extractDir, 'package');
    if (!existsSync(path.join(packageRoot, 'package.json'))) {
      return { ok: false, code: 'bad-tarball', error: '解包后没有 package/package.json', status: 502 };
    }
    // 替换旧版本（先备份到 .old-*，成功后删除）
    let oldDir = null;
    if (existsSync(targetDir)) {
      oldDir = `${targetDir}.old-${Date.now()}`;
      renameSync(targetDir, oldDir);
    }
    renameSync(packageRoot, targetDir);
    const meta = {
      name,
      version: latest,
      tarball,
      integrity,
      downloadedAt: new Date().toISOString(),
      bytes,
      note: '下载自 npm registry；本插件不执行该扩展代码，安装/运行需在 Coopanion 完成。',
    };
    writeFileSync(path.join(targetDir, '_meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    if (oldDir !== null) {
      try { rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { ok: true, cached: false, name, version: latest, dir: targetDir, bytes, tarball, integrity };
  } catch (error) {
    return {
      ok: false,
      code: 'download-failed',
      error: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  } finally {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** POST /whale-panel/coo-market/download：下载扩展 tarball 到本机 coo-extensions。 */
async function handleCooMarketDownload(req, res, settings, deps) {
  let body;
  try {
    body = await readJsonBody(req, settings.maxBodyBytes);
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, { ok: false, error: { code: (error && error.code) || 'bad-request', message: error instanceof Error ? error.message : '读取请求体失败' } });
  }
  const result = await downloadCooExtension(settings, body && body.name, deps);
  if (!result.ok) {
    return sendJson(res, result.status || 500, { ok: false, error: { code: result.code || 'download-failed', message: result.error } });
  }
  return sendJson(res, 200, {
    ok: true,
    cached: result.cached === true,
    name: result.name,
    version: result.version,
    dir: result.dir,
    bytes: result.bytes,
    tarball: result.tarball,
    integrity: result.integrity,
    downloadsDir: resolveCooPaths(settings).downloadsDir,
    note: '已下载到本机（未执行）；可在详情里安装到 Coopanion（需确认并重启 Coopanion 才生效）。',
  });
}

/** 找 Coopanion 自带 pnpm（默认 <cooRoot>/resources/app/node_modules/pnpm/bin/pnpm.cjs）。 */
function resolvePnpmPath(settings) {
  return resolveCooPaths(settings).pnpmPath;
}

/** 默认安装器：用 Coopanion 自带 pnpm 把包 add 进 extensions 目录（best effort）。 */
async function defaultInstallIntoCoopanion(settings, name, version, deps = {}) {
  const cooPaths = resolveCooPaths(settings);
  const extensionsDir = cooPaths.extensionsDir;
  mkdirSync(extensionsDir, { recursive: true });
  const manifestFile = path.join(extensionsDir, 'package.json');
  if (!existsSync(manifestFile)) {
    writeFileSync(manifestFile, `${JSON.stringify({ name: 'coopanion-extensions', private: true }, null, 2)}\n`, 'utf8');
  }
  const pnpmPath = resolvePnpmPath(settings);
  if (pnpmPath === '' || !existsSync(pnpmPath)) {
    throw new Error(`找不到 Coopanion 自带 pnpm${pnpmPath ? `：${pnpmPath}` : '（未探测到 Coopanion 安装）'}；可改 config cooRoot/cooPnpmPath，或到 Coopanion 设置→扩展 手动安装`);
  }
  const spec = version ? `${name}@${version}` : name;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [pnpmPath, 'add', spec, '--config.strict-dep-builds=false', '--dir', extensionsDir, '--reporter=append-only'], {
      cwd: extensionsDir,
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (error) reject(new Error(`pnpm add 失败：${error.message}\n${output.split(/\r?\n/).slice(-6).join('\n')}`));
      else resolve({ output: output.split(/\r?\n/).slice(-8).join('\n') });
    });
  });
}

/** POST /whale-panel/coo-market/install：安装到 Coopanion（需 confirm:true；只允许已下载包）。 */
async function handleCooMarketInstall(req, res, settings, deps) {
  let body;
  try {
    body = await readJsonBody(req, settings.maxBodyBytes);
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, { ok: false, error: { code: (error && error.code) || 'bad-request', message: error instanceof Error ? error.message : '读取请求体失败' } });
  }
  if (!body || body.confirm !== true) {
    return sendJson(res, 400, {
      ok: false,
      error: {
        code: 'confirmation-required',
        message: '需要显式 confirm:true 才会把扩展安装到 Coopanion（第三方代码将在 Coopanion 里运行，需重启 Coopanion 生效；本插件不执行扩展代码）。',
      },
    });
  }
  const validated = validatePackageName(body.name);
  if (!validated.ok) return sendJson(res, 400, { ok: false, error: { code: 'invalid-name', message: validated.error } });
  const name = validated.name;
  const cooPaths = resolveCooPaths(settings);
  const downloaded = scanDownloadedExtensions(cooPaths.downloadsDir).downloaded.find((entry) => entry.name === name);
  if (!downloaded) {
    return sendJson(res, 404, {
      ok: false,
      error: { code: 'not-downloaded', message: `本机还没有下载 ${name}（先点「下载到本机」）` },
    });
  }
  try {
    const install = deps.runInstall
      ? await deps.runInstall({ name, version: downloaded.version, extensionsDir: cooPaths.extensionsDir, settings })
      : await defaultInstallIntoCoopanion(settings, name, downloaded.version);
    return sendJson(res, 200, {
      ok: true,
      installed: true,
      name,
      version: downloaded.version,
      needRestart: true,
      extensionsDir: cooPaths.extensionsDir,
      output: install && install.output ? String(install.output) : '',
      note: '已用 Coopanion 自带 pnpm 安装；**需要重启 Coopanion** 才会加载。第三方代码将在 Coopanion 里运行，请自行判断安全。',
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: {
        code: 'install-failed',
        message: error instanceof Error ? error.message : String(error),
        hint: '可到 Coopanion 设置 → 扩展 手动安装；或检查 config cooPnpmPath/cooExtensionsDir。',
      },
    });
  }
}

/** POST /whale-panel/coo-market/apply：把已下载且已适配的包应用到本机桌宠（幂等、不装 Coo 主程序）。 */
async function handleCooMarketApply(req, res, settings, deps) {
  let body;
  try {
    body = readJsonBodySafe(await readJsonBody(req, settings.maxBodyBytes));
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
  }
  const validated = validatePackageName(body && body.name);
  if (!validated.ok) {
    return sendJson(res, 400, { ok: false, error: { code: 'invalid-name', message: validated.error } });
  }
  const name = validated.name;
  const cooPaths = resolveCooPaths(settings);
  const downloaded = scanDownloadedExtensions(cooPaths.downloadsDir).downloaded.find((entry) => entry.name === name);
  if (!downloaded) {
    return sendJson(res, 404, {
      ok: false,
      error: { code: 'not-downloaded', message: `本机还没有下载 ${name}（先在 Coo 市场下载）` },
    });
  }
  const native = resolveCooMarketNative(name);
  if (!native.supported) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'not-supported', message: native.reason },
      native: { ...native, applied: false },
    });
  }
  try {
    if (native.adapter === 'screen') {
      const wasEnabled = readScreenAutoState(settings).enabled === true;
      const written = writeScreenAutoToggle(settings, true);
      return sendJson(res, 200, {
        ok: true,
        applied: true,
        alreadyApplied: wasEnabled,
        adapter: 'screen',
        label: native.label,
        message: wasEnabled ? '已应用：自动看屏幕（原本已开启）' : '已应用：自动看屏幕',
        file: written.file,
        native: { ...native, applied: true },
      });
    }
    if (native.adapter === 'foreground') {
      const paused = existsSync(contextPausedFile(settings));
      if (paused) setContextPaused(settings, false);
      return sendJson(res, 200, {
        ok: true,
        applied: true,
        alreadyApplied: !paused,
        adapter: 'foreground',
        label: native.label,
        message: paused ? '已应用：前台感知/游戏陪玩（已恢复情境观察）' : '已应用：前台感知/游戏陪玩（本来就在运行）',
        native: { ...native, applied: true },
      });
    }
    return sendJson(res, 400, { ok: false, error: { code: 'not-supported', message: '未知的原生适配类型' } });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'apply-failed', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** POST /whale-panel/coo-market/open-dir：explorer 打开下载目录。 */
async function handleCooMarketOpenDir(res, settings, deps) {
  if (process.platform !== 'win32') {
    return sendJson(res, 501, { ok: false, error: { code: 'unsupported-platform', message: '打开目录仅支持 Windows' } });
  }
  const target = path.resolve(resolveCooPaths(settings).downloadsDir);
  try {
    mkdirSync(target, { recursive: true });
    const execFileImpl = deps.execFile ?? execFile;
    execFileImpl('explorer.exe', [target], { windowsHide: false }, () => {});
    return sendJson(res, 200, { ok: true, path: target });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'open-failed', message: error instanceof Error ? error.message : String(error) } });
  }
}

// ───────────────────────────── 合并版设置 / 服务器 QQ 预览（T21） ─────────────────────────────

/** 本地 settings.json 路径（默认插件目录）。 */
export function resolveSettingsFile(settings) {
  if (typeof settings.settingsFile === 'string' && settings.settingsFile.trim() !== '') {
    return path.resolve(settings.settingsFile.trim());
  }
  return path.join(PLUGIN_DIR, 'settings.json');
}

/** 读本地设置（缺失/损坏 → 默认值）。 */
export function readLocalSettings(settings) {
  let stored = null;
  const file = resolveSettingsFile(settings);
  try {
    stored = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    stored = null;
  }
  return { settings: mergeSettings(SETTINGS_DEFAULTS, stored), file };
}

/** 把 stored 合法字段合并到 base 上（非法字段丢弃）。 */
function mergeSettings(base, stored) {
  const merged = {
    refreshIntervalMs: base.refreshIntervalMs,
    sections: { ...base.sections },
    chatFontSize: base.chatFontSize,
    sendKey: base.sendKey,
  };
  if (!stored || typeof stored !== 'object') return merged;
  if (SETTINGS_REFRESH_OPTIONS.includes(Number(stored.refreshIntervalMs))) {
    merged.refreshIntervalMs = Number(stored.refreshIntervalMs);
  }
  if (stored.sections && typeof stored.sections === 'object') {
    for (const key of Object.keys(SETTINGS_DEFAULTS.sections)) {
      if (typeof stored.sections[key] === 'boolean') merged.sections[key] = stored.sections[key];
    }
  }
  if (SETTINGS_FONT_SIZES.includes(stored.chatFontSize)) merged.chatFontSize = stored.chatFontSize;
  if (SETTINGS_SEND_KEYS.includes(stored.sendKey)) merged.sendKey = stored.sendKey;
  if (stored.ui && typeof stored.ui === 'object' && !Array.isArray(stored.ui)) {
    merged.ui = resolveUiConfig({ ...base.ui, ...stored.ui });
  }
  if (typeof stored.bridgeUrl === 'string') merged.bridgeUrl = stored.bridgeUrl.trim();
  if (typeof stored.serverSshHost === 'string') merged.serverSshHost = stored.serverSshHost.trim();
  if (typeof stored.awarenessPatchPath === 'string') merged.awarenessPatchPath = stored.awarenessPatchPath.trim();
  const qq = resolveQqConfig({
    qqPreviewGroup: typeof stored.qqPreviewGroup === 'boolean' ? stored.qqPreviewGroup : base.qqPreviewGroup,
    qqPreviewGroups: Array.isArray(stored.qqPreviewGroups) ? stored.qqPreviewGroups : base.qqPreviewGroups,
    qqPreviewChats: Array.isArray(stored.qqPreviewChats) ? stored.qqPreviewChats : base.qqPreviewChats,
    qqPreviewMaxItems: stored.qqPreviewMaxItems !== undefined ? stored.qqPreviewMaxItems : base.qqPreviewMaxItems,
    qqPreviewMaxChars: stored.qqPreviewMaxChars !== undefined ? stored.qqPreviewMaxChars : base.qqPreviewMaxChars,
  });
  Object.assign(merged, qq);
  return merged;
}

/** 校验并归一化 POST /whale-panel/settings 的 body。 */
export function sanitizeSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body 需要是 JSON 对象' };
  }
  const patch = {};
  if (input.refreshIntervalMs !== undefined) {
    const value = Number(input.refreshIntervalMs);
    if (!SETTINGS_REFRESH_OPTIONS.includes(value)) {
      return { ok: false, error: `refreshIntervalMs 只允许 ${SETTINGS_REFRESH_OPTIONS.join('/')}` };
    }
    patch.refreshIntervalMs = value;
  }
  if (input.sections !== undefined) {
    if (!input.sections || typeof input.sections !== 'object' || Array.isArray(input.sections)) {
      return { ok: false, error: 'sections 需要是对象' };
    }
    const sections = {};
    for (const key of Object.keys(SETTINGS_DEFAULTS.sections)) {
      if (input.sections[key] === undefined) continue;
      if (typeof input.sections[key] !== 'boolean') return { ok: false, error: `sections.${key} 需要 boolean` };
      sections[key] = input.sections[key];
    }
    patch.sections = sections;
  }
  if (input.chatFontSize !== undefined) {
    if (!SETTINGS_FONT_SIZES.includes(input.chatFontSize)) {
      return { ok: false, error: `chatFontSize 只允许 ${SETTINGS_FONT_SIZES.join('/')}` };
    }
    patch.chatFontSize = input.chatFontSize;
  }
  if (input.sendKey !== undefined) {
    if (!SETTINGS_SEND_KEYS.includes(input.sendKey)) {
      return { ok: false, error: `sendKey 只允许 ${SETTINGS_SEND_KEYS.join('/')}` };
    }
    patch.sendKey = input.sendKey;
  }
  // ── T26：通用/连接/QQ 白名单 ──
  if (input.ui !== undefined) {
    if (!input.ui || typeof input.ui !== 'object' || Array.isArray(input.ui)) return { ok: false, error: 'ui 需要是对象' };
    const ui = {};
    for (const key of ['sidebarLabel', 'panelTitle']) {
      if (input.ui[key] === undefined) continue;
      if (typeof input.ui[key] !== 'string') return { ok: false, error: `ui.${key} 需要字符串` };
      if (input.ui[key].length > (key === 'sidebarLabel' ? 40 : 80)) return { ok: false, error: `ui.${key} 太长` };
      ui[key] = input.ui[key].trim();
    }
    if (input.ui.tabLabels !== undefined) {
      if (!input.ui.tabLabels || typeof input.ui.tabLabels !== 'object' || Array.isArray(input.ui.tabLabels)) {
        return { ok: false, error: 'ui.tabLabels 需要是对象' };
      }
      const tabLabels = {};
      for (const key of Object.keys(UI_DEFAULTS.tabLabels)) {
        if (input.ui.tabLabels[key] === undefined) continue;
        if (typeof input.ui.tabLabels[key] !== 'string') return { ok: false, error: `ui.tabLabels.${key} 需要字符串` };
        if (input.ui.tabLabels[key].length > 24) return { ok: false, error: `ui.tabLabels.${key} 太长` };
        tabLabels[key] = input.ui.tabLabels[key].trim();
      }
      ui.tabLabels = tabLabels;
    }
    patch.ui = ui;
  }
  if (input.bridgeUrl !== undefined) {
    if (typeof input.bridgeUrl !== 'string') return { ok: false, error: 'bridgeUrl 需要字符串' };
    const value = input.bridgeUrl.trim();
    if (value !== '' && !isAllowedBridgeUrl(value)) {
      return { ok: false, error: 'bridgeUrl 只允许 http/https + 回环或局域网地址（如 http://127.0.0.1:47891）' };
    }
    patch.bridgeUrl = value;
  }
  if (input.awarenessPatchPath !== undefined) {
    if (typeof input.awarenessPatchPath !== 'string') return { ok: false, error: 'awarenessPatchPath 需要字符串' };
    const value = input.awarenessPatchPath.trim();
    if (value.length > 500) return { ok: false, error: 'awarenessPatchPath 太长' };
    if (value.includes(String.fromCharCode(13)) || value.includes(String.fromCharCode(10)) || value.includes(String.fromCharCode(0))) {
      return { ok: false, error: 'awarenessPatchPath 含非法字符' };
    }
    patch.awarenessPatchPath = value;
  }
  if (input.serverSshHost !== undefined) {
    if (typeof input.serverSshHost !== 'string') return { ok: false, error: 'serverSshHost 需要字符串' };
    const value = input.serverSshHost.trim();
    if (!isAllowedSshHost(value)) return { ok: false, error: 'serverSshHost 需要 user@host 形式（或留空禁用）' };
    patch.serverSshHost = value;
  }
  for (const key of ['qqPreviewGroups', 'qqPreviewChats']) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key])) return { ok: false, error: `${key} 需要字符串数组` };
    const list = [...new Set(input[key].map((item) => String(item).trim()).filter((item) => item !== ''))];
    if (list.length > 20) return { ok: false, error: `${key} 最多 20 项` };
    const prefix = key === 'qqPreviewGroups' ? 'group:' : 'private:';
    if (list.some((item) => !new RegExp(`^${prefix}\\d{1,25}$`).test(item))) {
      return { ok: false, error: `${key} 的项需要 ${prefix}<数字>` };
    }
    patch[key] = list;
  }
  if (input.qqPreviewGroup !== undefined) {
    if (typeof input.qqPreviewGroup !== 'boolean') return { ok: false, error: 'qqPreviewGroup 需要 boolean' };
    patch.qqPreviewGroup = input.qqPreviewGroup;
  }
  if (input.qqPreviewMaxItems !== undefined) {
    const value = Number(input.qqPreviewMaxItems);
    if (!Number.isInteger(value) || value < 1 || value > 10) return { ok: false, error: 'qqPreviewMaxItems 需要 1–10 的整数' };
    patch.qqPreviewMaxItems = value;
  }
  if (input.qqPreviewMaxChars !== undefined) {
    const value = Number(input.qqPreviewMaxChars);
    if (!Number.isInteger(value) || value < 20 || value > 200) return { ok: false, error: 'qqPreviewMaxChars 需要 20–200 的整数' };
    patch.qqPreviewMaxChars = value;
  }
  if (Object.keys(patch).length === 0) return { ok: true, patch: {} };
  return { ok: true, patch };
}

/** 原子写 JSON。 */
function writeJsonAtomicSync(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

/** 本地设置持久化：在现有值上合并 patch。 */
export function saveLocalSettings(settings, patch) {
  const { settings: current, file } = readLocalSettings(settings);
  const next = {
    ...current,
    ...patch,
    sections: { ...current.sections, ...(patch.sections ?? {}) },
  };
  writeJsonAtomicSync(file, next);
  return { settings: next, file };
}

// ── 服务器 awareness patch：只改 5 个 qqPreview* 键，保留其它键/注释（T17/T20 共用文件） ──

/** 从 patch 文本里取 config 块的缩进信息。 */
function findConfigBlock(lines) {
  const configIndex = lines.findIndex((line) => /^\s*config:\s*$/.test(line));
  if (configIndex < 0) return null;
  const configIndent = (lines[configIndex].match(/^(\s*)/) ?? [''])[1];
  let end = lines.length;
  for (let index = configIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = (line.match(/^(\s*)/) ?? [''])[1];
    if (indent.length <= configIndent.length) { end = index; break; }
  }
  return { configIndex, configIndent, end, keyIndent: `${configIndent}  ` };
}

/** 读取 config 块内某个 key 的原始值文本。 */
function readConfigValue(lines, block, key) {
  const matcher = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
  for (let index = block.configIndex + 1; index < block.end; index += 1) {
    const match = lines[index].match(matcher);
    if (match) return match[2];
  }
  return undefined;
}

/** 解析 YAML 里的 5 个 qqPreview 键（只做简单标量/数组解析，够用）。 */
export function extractAwarenessPreview(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const block = findConfigBlock(lines);
  if (!block) return { ok: false, error: 'patch 里找不到 config: 块' };
  const parseScalar = (raw) => {
    if (raw === undefined) return undefined;
    const value = raw.trim();
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
  };
  const parseArray = (raw) => {
    if (raw === undefined) return undefined;
    const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => item.trim().replace(/^['"]/, '').replace(/['"]$/, '')).filter(Boolean);
  };
  return {
    ok: true,
    config: {
      qqPreviewGroup: parseScalar(readConfigValue(lines, block, 'qqPreviewGroup')),
      qqPreviewGroups: parseArray(readConfigValue(lines, block, 'qqPreviewGroups')),
      qqPreviewChats: parseArray(readConfigValue(lines, block, 'qqPreviewChats')),
      qqPreviewMaxItems: parseScalar(readConfigValue(lines, block, 'qqPreviewMaxItems')),
      qqPreviewMaxChars: parseScalar(readConfigValue(lines, block, 'qqPreviewMaxChars')),
    },
  };
}

/** 校验 apply-awareness 的编辑字段（只允许白名单）。 */
export function validateAwarenessUpdates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body 需要是 JSON 对象' };
  }
  const unknown = Object.keys(input).filter((key) => key !== 'confirm' && AWARENESS_FIELDS[key] === undefined);
  if (unknown.length > 0) return { ok: false, error: `不支持的字段：${unknown.join(', ')}` };
  const updates = {};
  for (const [key, spec] of Object.entries(AWARENESS_FIELDS)) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, error: `${key} 需要 boolean` };
      updates[key] = value;
      continue;
    }
    if (spec.type === 'integer') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
        return { ok: false, error: `${key} 需要 ${spec.min}–${spec.max} 的整数` };
      }
      updates[key] = number;
      continue;
    }
    if (spec.type === 'array') {
      if (!Array.isArray(value)) return { ok: false, error: `${key} 需要字符串数组` };
      const list = value.map((item) => String(item).trim()).filter((item) => item !== '');
      if (list.length > 20) return { ok: false, error: `${key} 最多 20 项` };
      for (const item of list) {
        if (!spec.pattern.test(item)) return { ok: false, error: `${key} 的项格式不对：${item}` };
      }
      updates[key] = list;
    }
  }
  if (Object.keys(updates).length === 0) return { ok: false, error: '没有可应用的字段' };
  return { ok: true, updates };
}

/** YAML 值格式化（只覆盖白名单字段的类型）。 */
function formatYamlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => `'${String(item).replaceAll("'", "''")}'`).join(', ')}]`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * 行级合并 patch：只改 qqPreview* 5 个键，保留注释、缩进与其它所有配置（T20 的 dialogue 等）。
 * @returns {{ok: boolean, text?: string, changed?: string[], error?: string}}
 */
export function mergeAwarenessPatch(text, updates) {
  const lines = String(text ?? '').split(/\r?\n/);
  const block = findConfigBlock(lines);
  if (!block) return { ok: false, error: 'patch 里找不到 config: 块，拒绝写入' };
  const changed = [];
  for (const [key, value] of Object.entries(updates)) {
    if (AWARENESS_FIELDS[key] === undefined) return { ok: false, error: `不允许的字段：${key}` };
    const serialized = formatYamlValue(value);
    const matcher = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
    let replaced = false;
    for (let index = block.configIndex + 1; index < block.end; index += 1) {
      const match = lines[index].match(matcher);
      if (!match) continue;
      const trailing = lines[index].includes('#')
        ? ` ${lines[index].slice(lines[index].indexOf('#')).trim()}`
        : '';
      lines[index] = `${match[1]}${key}: ${serialized}${trailing}`;
      replaced = true;
      changed.push(key);
      break;
    }
    if (replaced) continue;
    let insertAt = block.configIndex + 1;
    for (let index = block.configIndex + 1; index < block.end; index += 1) {
      if (lines[index].trim() !== '') insertAt = index + 1;
    }
    lines.splice(insertAt, 0, `${block.keyIndent}${key}: ${serialized}`);
    block.end += 1;
    changed.push(key);
  }
  return { ok: true, text: lines.join('\n'), changed };
}

// ── SSH 执行 / 服务器 patch 应用 ──

/** 默认 ssh 执行器：spawn 一个 ssh 子进程，可选 stdin；返回 {ok, code, stdout, stderr}。 */
export function defaultSshRunner(settings) {
  return (command, options = {}) => new Promise((resolve) => {
    const host = settings.sshHost || settings.serverSshHost || '';
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
    if (typeof settings.sshKey === 'string' && settings.sshKey !== '') {
      args.unshift('-i', settings.sshKey);
      args.push('-o', 'IdentitiesOnly=yes');
    }
    if (typeof settings.sshKnownHosts === 'string' && settings.sshKnownHosts !== '') {
      args.push('-o', `UserKnownHostsFile=${settings.sshKnownHosts}`);
    }
    args.push(host, command);
    let settled = false;
    let child;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      child = spawn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), error: 'ssh-spawn-failed' });
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, code: -2, stdout: Buffer.concat(stdout).toString('utf8'), stderr: 'timeout', error: 'ssh-timeout' });
    }, Math.max(1_000, Number(options.timeoutMs) || settings.sshTimeoutMs));
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), error: 'ssh-error' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        code: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error: code === 0 ? null : 'ssh-command-failed',
      });
    });
    if (options.input !== undefined) {
      try { child.stdin.write(options.input); } catch { /* ignore */ }
    }
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

function resolveSshRunner(settings, deps) {
  return deps.runSsh ?? defaultSshRunner(settings);
}

/** ssh 读远端文本文件。 */
async function sshReadText(settings, remotePath, deps) {
  const runner = resolveSshRunner(settings, deps);
  const result = await runner(`cat "${remotePath}"`, { timeoutMs: settings.sshTimeoutMs });
  if (!result.ok) {
    return { ok: false, error: `ssh 读取 ${remotePath} 失败：${(result.stderr || '').trim() || result.error || 'unknown'}` };
  }
  return { ok: true, text: result.stdout };
}

/** 读服务器 QQ 预览配置（带短期缓存；设置页用）。 */
async function readAwarenessConfig(settings, deps, cache) {
  const now = Date.now();
  const ttl = Math.max(1_000, Number(settings.awarenessCacheMs) || 15_000);
  if (cache.value !== null && now - cache.at < ttl) return cache.value;
  const read = await sshReadText(settings, settings.awarenessPatchPath, deps);
  let value;
  if (!read.ok) {
    value = { ok: false, path: settings.awarenessPatchPath, error: read.error, config: null };
  } else {
    const parsed = extractAwarenessPreview(read.text);
    value = parsed.ok
      ? { ok: true, path: settings.awarenessPatchPath, config: parsed.config, error: null }
      : { ok: false, path: settings.awarenessPatchPath, error: parsed.error, config: null };
  }
  cache.value = value;
  cache.at = now;
  return value;
}

/** ssh 原子写远端文本文件（base64 走 stdin；写前备份 .bak-t21）。 */
async function sshWriteText(settings, remotePath, content, deps) {
  const runner = resolveSshRunner(settings, deps);
  const backup = `${remotePath}.bak-t21`;
  const temporary = `${remotePath}.tmp-t21`;
  const base64 = Buffer.from(content, 'utf8').toString('base64');
  const ownerPart = typeof settings.remoteFileOwner === 'string' && settings.remoteFileOwner.trim() !== ''
    ? ` && chown ${settings.remoteFileOwner.trim()} "${remotePath}"`
    : '';
  const command = `cp "${remotePath}" "${backup}" && base64 -d > "${temporary}" && `
    + `mv "${temporary}" "${remotePath}"${ownerPart} && chmod 644 "${remotePath}"`;
  const result = await runner(command, { input: base64, timeoutMs: settings.sshTimeoutMs });
  if (!result.ok) {
    const detail = (result.stderr || '').trim() || result.error || 'unknown';
    return { ok: false, error: `ssh 写 ${remotePath} 失败：${detail}` };
  }
  return { ok: true, backup };
}

/** 重启服务器 DSH 并轮询 active；失败带 journal 尾部。 */
async function restartRemoteDsh(settings, deps) {
  const runner = resolveSshRunner(settings, deps);
  const startedAt = Date.now();
  const service = settings.remoteDshService;
  const restart = await runner(`systemctl restart ${service}`, { timeoutMs: settings.sshTimeoutMs });
  if (!restart.ok) {
    const journal = await runner(`journalctl -u ${service} -n 20 --no-pager`, { timeoutMs: settings.sshTimeoutMs });
    return {
      ok: false,
      stage: 'restart',
      error: `systemctl restart ${service} 失败：${(restart.stderr || '').trim() || restart.error || 'unknown'}`,
      journalTail: (journal.stdout || '').trim().split(/\r?\n/).slice(-20).join('\n'),
      ms: Date.now() - startedAt,
    };
  }
  const deadline = Date.now() + Math.max(5_000, Number(settings.applyRestartWaitMs) || 45_000);
  let active = 'unknown';
  while (Date.now() < deadline) {
    const status = await runner(`systemctl is-active ${service}`, { timeoutMs: settings.sshTimeoutMs });
    active = String(status.stdout ?? '').trim();
    if (active === 'active') return { ok: true, active, ms: Date.now() - startedAt };
    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
  }
  const journal = await runner(`journalctl -u ${service} -n 20 --no-pager`, { timeoutMs: settings.sshTimeoutMs });
  return {
    ok: false,
    stage: 'restart-wait',
    active,
    error: `${service} 重启后 ${Math.round((Date.now() - startedAt) / 1000)}s 内未 active（当前 ${active}）`,
    journalTail: (journal.stdout || '').trim().split(/\r?\n/).slice(-10).join('\n'),
    ms: Date.now() - startedAt,
  };
}

/** sleep（host 侧小工具）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** GET /whale-panel/settings：本地设置 + 观察器状态 + 服务器 QQ 预览配置。 */
async function handleSettingsGet(res, settings, deps, awarenessCache) {
  const local = readLocalSettings(settings);
  const components = collectControlComponents(settings, Date.now());
  const coo = resolveCooPaths(settings);
  const sshEnabled = settings.sshEnabled === true;
  const awareness = sshEnabled
    ? await readAwarenessConfig(settings, deps, awarenessCache)
    : {
      ok: false,
      disabled: true,
      path: settings.awarenessPatchPath,
      config: null,
      error: 'SSH 未配置（serverSshHost / awarenessPatchPath 为空）；QQ 预览服务器配置读写已禁用。',
    };
  return sendJson(res, 200, {
    ok: true,
    settings: local.settings,
    defaults: SETTINGS_DEFAULTS,
    refreshOptions: SETTINGS_REFRESH_OPTIONS,
    settingsFile: local.file,
    dshLinkRoot: settings.dshLinkRoot,
    observer: components.observer,
    awareness,
    ui: settings.ui,
    bridgeUrl: settings.bridgeUrl,
    qqDefaults: {
      qqPreviewGroup: settings.qqPreviewGroup,
      qqPreviewGroups: settings.qqPreviewGroups,
      qqPreviewChats: settings.qqPreviewChats,
      qqPreviewMaxItems: settings.qqPreviewMaxItems,
      qqPreviewMaxChars: settings.qqPreviewMaxChars,
    },
    paths: {
      dshLinkRoot: settings.dshLinkRoot,
      cooRoot: coo.root,
      downloadsDir: coo.downloadsDir,
      extensionsDir: coo.extensionsDir,
    },
    sshConfig: {
      configured: sshEnabled,
      enabled: sshEnabled,
      host: settings.sshHost,
      patchPath: settings.awarenessPatchPath,
      service: settings.remoteDshService,
    },
  });
}

/** POST /whale-panel/settings：合并保存本地设置。 */
async function handleSettingsPost(req, res, settings) {
  let body;
  try {
    body = await readJsonBody(req, settings.maxBodyBytes);
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, {
      ok: false,
      error: { code: (error && error.code) || 'bad-request', message: error instanceof Error ? error.message : '读取请求体失败' },
    });
  }
  const sanitized = sanitizeSettingsPatch(body);
  if (!sanitized.ok) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: sanitized.error } });
  }
  try {
    const saved = saveLocalSettings(settings, sanitized.patch);
    return sendJson(res, 200, { ok: true, settings: saved.settings, file: saved.file });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'settings-write-failed', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** POST /whale-panel/apply-awareness：写服务器 patch（只 white-list 字段）→ 重启 DSH → 回读验证。 */
async function handleApplyAwareness(req, res, settings, deps, awarenessCache) {
  let body;
  try {
    body = await readJsonBody(req, settings.maxBodyBytes);
  } catch (error) {
    const status = error && error.code === 'payload-too-large' ? 413 : 400;
    return sendJson(res, status, {
      ok: false,
      error: { code: (error && error.code) || 'bad-request', message: error instanceof Error ? error.message : '读取请求体失败' },
    });
  }
  if (!body || body.confirm !== true) {
    return sendJson(res, 400, {
      ok: false,
      error: {
        code: 'confirmation-required',
        message: '需要显式 confirm:true 才会写服务器配置并重启 DSH',
      },
    });
  }
  if (settings.sshEnabled !== true) {
    return sendJson(res, 400, {
      ok: false,
      error: {
        code: 'ssh-disabled',
        message: 'SSH 未配置（serverSshHost / awarenessPatchPath 为空），服务器 QQ 配置读写功能已禁用；可在设置 → 通用/连接 里填写。',
      },
    });
  }
  const validated = validateAwarenessUpdates(body);
  if (!validated.ok) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: validated.error } });
  }
  const read = await sshReadText(settings, settings.awarenessPatchPath, deps);
  if (!read.ok) {
    return sendJson(res, 502, { ok: false, error: { code: 'ssh-read-failed', message: read.error } });
  }
  const merged = mergeAwarenessPatch(read.text, validated.updates);
  if (!merged.ok) {
    return sendJson(res, 409, { ok: false, error: { code: 'patch-merge-failed', message: merged.error } });
  }
  const write = await sshWriteText(settings, settings.awarenessPatchPath, merged.text, deps);
  if (!write.ok) {
    return sendJson(res, 502, { ok: false, error: { code: 'ssh-write-failed', message: write.error } });
  }
  awarenessCache.value = null;
  awarenessCache.at = 0;
  const restart = await restartRemoteDsh(settings, deps);
  if (!restart.ok) {
    const runner = resolveSshRunner(settings, deps);
    const rollback = await runner(
      `cp "${write.backup}" "${settings.awarenessPatchPath}" && chmod 644 "${settings.awarenessPatchPath}" && systemctl restart ${settings.remoteDshService}`,
      { timeoutMs: settings.sshTimeoutMs },
    );
    const readback = await readAwarenessConfig(settings, deps, { at: 0, value: null });
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'restart-failed', message: restart.error },
      stage: restart.stage,
      active: restart.active ?? null,
      journalTail: restart.journalTail ?? '',
      restored: rollback.ok,
      patched: true,
      awareness: readback,
      ms: restart.ms,
    });
  }
  const readback = await readAwarenessConfig(settings, deps, awarenessCache);
  return sendJson(res, 200, {
    ok: true,
    applied: merged.changed,
    restart: { ok: true, active: restart.active, ms: restart.ms },
    backupPath: write.backup,
    awareness: readback,
  });
}

/** POST /whale-panel/open-directory：只允许打开配置的 dshLinkRoot。 */
async function handleOpenDirectory(res, settings, deps) {
  if (process.platform !== 'win32') {
    return sendJson(res, 501, { ok: false, error: { code: 'unsupported-platform', message: '打开目录仅支持 Windows' } });
  }
  const target = path.resolve(settings.dshLinkRoot);
  if (!existsSync(target)) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `目录不存在：${target}` } });
  }
  try {
    const execFileImpl = deps.execFile ?? execFile;
    execFileImpl('explorer.exe', [target], { windowsHide: false }, () => {});
    return sendJson(res, 200, { ok: true, path: target });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'open-failed', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * 代理一个 bridge HTTP 请求；网络/超时错误转换成可读 JSON 错误。
 * @param {typeof fetch} fetchImpl
 * @param {Record<string, any>} settings
 * @param {string} path bridge 相对路径（可带 query）
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, data: any }>}
 */
async function proxyJson(fetchImpl, settings, path, options = {}) {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? settings.healthTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${settings.bridgeUrl}${path}`, {
      method,
      headers: options.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: { code: 'bad-bridge-response', message: text.slice(0, 300) } };
      }
    }
    return { status: response.status, data };
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      return {
        status: 504,
        data: { ok: false, error: { code: 'bridge-timeout', message: `bridge 响应超过 ${timeoutMs}ms` } },
      };
    }
    return {
      status: 502,
      data: {
        ok: false,
        error: {
          code: 'bridge-unreachable',
          message: `连不上 bridge ${settings.bridgeUrl}：${error instanceof Error ? error.message : String(error)}`,
        },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取 bridge token（优先 config.token，其次 token 文件）。不做日志输出。
 * @param {Record<string, any>} settings
 * @returns {{ token: string | null, error: string | null }}
 */
export function readBridgeToken(settings) {
  const inline = typeof settings.token === 'string' ? settings.token.trim() : '';
  if (inline !== '') {
    if (TOKEN_PATTERN.test(inline)) return { token: inline, error: null };
    return { token: null, error: 'config.token 不是合法的 bridge token（应为 hex 字符串）' };
  }
  if (!settings.tokenFile) return { token: null, error: '未配置 tokenFile' };
  try {
    const token = readFileSync(settings.tokenFile, 'utf8').trim();
    if (!TOKEN_PATTERN.test(token)) {
      return { token: null, error: `token 文件内容不像 bridge token：${settings.tokenFile}` };
    }
    return { token, error: null };
  } catch (error) {
    return {
      token: null,
      error: `读不到 token 文件 ${settings.tokenFile}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 同源校验：浏览器请求（带 Origin）必须与 DSH Web 页面同源；非浏览器请求（无 Origin）放行。
 * 回环主机名（127.0.0.1 / localhost）视为等价，只要端口一致。
 * @param {import('node:http').IncomingMessage} req
 * @param {string | undefined} pageOrigin
 * @returns {boolean}
 */
function isSameOrigin(req, pageOrigin) {
  const header = req.headers ? req.headers.origin : undefined;
  if (typeof header !== 'string' || header.trim() === '') return true;
  if (typeof pageOrigin !== 'string' || pageOrigin === '') return false;
  let got;
  let want;
  try {
    got = new URL(header);
    want = new URL(pageOrigin);
  } catch {
    return false;
  }
  if (got.host === want.host) return true;
  return got.port === want.port
    && LOOPBACK_HOSTNAMES.has(got.hostname)
    && LOOPBACK_HOSTNAMES.has(want.hostname);
}

/**
 * 读取请求体，超过 limit 时报 payload-too-large。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('payload too large'), { code: 'payload-too-large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => fail(error));
  });
}

/**
 * 读取并解析 JSON 请求体（错误码：bad-json / payload-too-large / bad-request）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<any>}
 */
async function readJsonBody(req, limit) {
  let raw;
  try {
    raw = await readBody(req, limit);
  } catch (error) {
    throw Object.assign(new Error('读取请求体失败'), {
      code: error && error.code === 'payload-too-large' ? 'payload-too-large' : 'bad-request',
    });
  }
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad-json' });
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} allow
 */
function methodNotAllowed(res, allow) {
  res.setHeader?.('allow', allow);
  return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `只支持 ${allow}` } });
}
