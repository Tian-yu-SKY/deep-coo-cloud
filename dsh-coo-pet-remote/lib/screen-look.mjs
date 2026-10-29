/**
 * 自动看屏幕 + 自己决定说不说（v0.4.6 / task-36）。
 *
 * 设计边界（重要）：
 * - 截图只落本机 `dataDir/screenshots/`，**不会**上传；发出去的只有**文字 caption**，
 *   而且只发给现有远程大脑（= 同一个人格），不新增任何第三方通道。
 * - 视觉模型是用户本机回环 Ollama（默认 `http://127.0.0.1:11434` + `qwen2.5vl:3b`）；
 *   endpoint 只允许 http(s) + 回环地址（和面板 T35 的规则一致）。
 * - 所有副作用（截图/推理/大脑/气泡/时钟/随机数）都可注入，测试不碰真实屏幕与网络；
 *   任何一步失败都只写 `lastError`，绝不把插件搞崩。
 *
 * 调度（默认值，全部可配）：
 *   每 5s tick 一次 → 读 `<dataDir>/screen-autolook.json` 开关（面板写）
 *   → enabled / 未暂停 / 距上次 ≥ minGap / 本小时 < maxPerHour / 到 nextDue
 *   → 截图 + 64×36 灰度 dHash 去重 → Ollama caption → caption Jaccard 相似度去重
 *   → 用远程人格决定：不想说回 `[沉默]`，否则 say() 一句。
 *
 * 状态写 `<dataDir>/screen-look-state.json` 供面板/`pet_status` 读。
 */

import { execFile } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const SCREEN_AUTO_FILE = 'screen-autolook.json';
export const SCREEN_STATE_FILE = 'screen-look-state.json';
export const SCREEN_TICK_MS = 5_000;
export const SCREEN_KEEP_SHOTS = 10;
export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 720;
/** 两帧 64 位 dHash 的汉明距离 ≤ 这个值就算「屏幕没变」（光标/时钟的小变化不算）。 */
export const SCREEN_SAME_HAMMING = 8;
/** caption 的 Jaccard 相似度 > 这个值就跳过（避免反复念叨同一屏）。 */
export const SCREEN_CAPTION_SIMILARITY = 0.85;
export const SCREEN_SILENCE = '[沉默]';
export const SCREEN_DEFAULT_PROMPT = '用两三句中文描述这张屏幕截图。';
export const SCREEN_DECIDE_TEMPLATE = '（你偷偷瞄了一眼主人的屏幕，看到：${caption}。'
  + '用你自己的语气直接说一句（≤40字），可以吐槽、关心或提醒；'
  + '除非真的不想打扰，否则不要回「[沉默]」。）';

export const SCREEN_DEFAULTS = Object.freeze({
  autolook: false,
  intervalMs: 180_000,
  minGapMs: 120_000,
  maxPerHour: 8,
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5vl:3b',
  prompt: SCREEN_DEFAULT_PROMPT,
  timeoutMs: 120_000,
});

/* ============================== 小工具 ============================== */

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** 读 JSON；不存在/坏 JSON/非对象都返回 null，不抛错。 */
export function readJsonSafe(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 读自动看屏开关：文件里 `{enabled:boolean}` 优先；文件不存在/坏了 → 用 Config 默认值。
 * @param {string} file `<dataDir>/screen-autolook.json`
 * @param {boolean} fallback Config `screenAutoLook`
 * @returns {boolean}
 */
export function readAutoEnabled(file, fallback = false) {
  const value = readJsonSafe(file);
  if (value && typeof value.enabled === 'boolean') return value.enabled;
  return fallback === true;
}

/** 状态文件默认形状（面板 readScreenAutoState 只挑它认识的字段）。 */
export function emptyState(enabled = false) {
  return {
    enabled: enabled === true,
    lastLookAt: null,
    lastSpokenAt: null,
    lastCaption: '',
    lastSpoken: '',
    totalLooks: 0,
    totalSpoken: 0,
    lastError: '',
    /** 内部去重用（面板忽略）：64 位 dHash hex / 下次可看时间。 */
    lastHash: '',
    nextDueAt: null,
  };
}

/** 读状态文件（不存在/坏了 → 默认空状态），字段类型不合法就回落默认。 */
export function readState(file) {
  const value = readJsonSafe(file);
  const state = emptyState(value?.enabled === true);
  if (!value) return state;
  const num = (x) => {
    if (x === null || x === undefined || x === '') return null;
    return Number.isFinite(Number(x)) ? Number(x) : null;
  };
  const str = (x, fallback = '') => (typeof x === 'string' ? x : fallback);
  return {
    ...state,
    enabled: value.enabled === true,
    lastLookAt: num(value.lastLookAt),
    lastSpokenAt: num(value.lastSpokenAt),
    lastCaption: str(value.lastCaption),
    lastSpoken: str(value.lastSpoken),
    totalLooks: num(value.totalLooks) ?? 0,
    totalSpoken: num(value.totalSpoken) ?? 0,
    lastError: str(value.lastError),
    lastHash: str(value.lastHash),
    nextDueAt: num(value.nextDueAt),
  };
}

/** 原子写状态（tmp + rename；失败只返回 false，由调用方决定要不要记日志）。 */
export function writeState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/** 视觉 endpoint 只允许 http/https + 回环（和面板 T35 一致）。 */
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

/** 下一次的间隔：interval × [0.8, 1.2)（random 可注入，测试边界用 0 / 0.999）。 */
export function jitteredInterval(intervalMs, random = Math.random) {
  const base = Number(intervalMs) > 0 ? Number(intervalMs) : SCREEN_DEFAULTS.intervalMs;
  const r = typeof random === 'function' ? Math.min(0.999999, Math.max(0, Number(random()) || 0)) : 0.5;
  return Math.round(base * (0.8 + r * 0.4));
}

/**
 * 本轮该不该看（纯函数，所有时间戳都是毫秒）：
 * enabled / 未暂停 / 距上次 ≥ minGap / 本小时次数 < maxPerHour / 已到 nextDue。
 */
export function isLookDue({
  now, enabled, paused = false, lastLookAt = null, nextDueAt = null,
  recentLooks = [], minGapMs = SCREEN_DEFAULTS.minGapMs, maxPerHour = SCREEN_DEFAULTS.maxPerHour,
} = {}) {
  if (enabled !== true) return { due: false, reason: 'disabled' };
  if (paused) return { due: false, reason: 'paused' };
  const t = Number(now) || Date.now();
  if (Number.isFinite(lastLookAt) && t - lastLookAt < Math.max(0, Number(minGapMs) || 0)) {
    return { due: false, reason: 'min-gap' };
  }
  const hourAgo = t - 3_600_000;
  const hourly = (Array.isArray(recentLooks) ? recentLooks : []).filter((at) => Number.isFinite(at) && at > hourAgo).length;
  if (hourly >= Math.max(0, Number(maxPerHour) || 0)) return { due: false, reason: 'hourly-limit' };
  if (Number.isFinite(nextDueAt) && t < nextDueAt) return { due: false, reason: 'not-yet' };
  return { due: true, reason: 'due' };
}

/** caption 分词：中文按字 bigram、英文/数字按词；标点空白不要。 */
export function captionTokens(text) {
  const body = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!body) return new Set();
  const tokens = new Set();
  for (const word of body.match(/[a-z0-9]+/g) ?? []) tokens.add(`w:${word}`);
  const cjk = body.replace(/[^\u3400-\u9fff]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (run.length === 1) tokens.add(`c:${run}`);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(`c:${run.slice(i, i + 2)}`);
  }
  return tokens;
}

/** 两段 caption 的 Jaccard 相似度（0–1）。 */
export function captionSimilarity(a, b) {
  const left = captionTokens(a);
  const right = captionTokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

/** 64×36 灰度字节 → 64 位 dHash（9×8 采样，横向比较）。 */
export function dhashFromGrayBytes(gray, width = 64, height = 36) {
  const size = width * height;
  if (!gray || gray.length < size) return '';
  const sample = (gx, gy) => {
    const x = Math.min(width - 1, Math.round((gx * (width - 1)) / 8));
    const y = Math.min(height - 1, Math.round((gy * (height - 1)) / 7));
    return gray[y * width + x];
  };
  let bits = '';
  for (let gy = 0; gy < 8; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      bits += sample(gx + 1, gy) > sample(gx, gy) ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 64×36 灰度 hex（PowerShell 输出）→ dHash。 */
export function dhashFromGrayHex(hex, width = 64, height = 36) {
  const text = String(hex ?? '').trim();
  if (!/^[0-9a-f]+$/i.test(text) || text.length !== width * height * 2) return '';
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) gray[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return dhashFromGrayBytes(gray, width, height);
}

/** 两帧 dHash 的汉明距离；任一为空 → Infinity（当作完全变了）。 */
export function hammingHex(a, b) {
  const left = String(a ?? '').toLowerCase();
  const right = String(b ?? '').toLowerCase();
  if (!left || !right || left.length !== right.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    let x = parseInt(left[i], 16) ^ parseInt(right[i], 16);
    while (x) { distance += x & 1; x >>= 1; }
  }
  return distance;
}

/** 下一次截图文件名（auto-<时间>.jpg，本地时区）。 */
export function screenshotFilePath(dir, now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds())}`;
  return join(dir, `auto-${stamp}.jpg`);
}

/** 只保留最近 keep 张 `auto-*.jpg`（别的文件不碰）。 */
export function pruneScreenshots(dir, keep = SCREEN_KEEP_SHOTS) {
  try {
    const files = readdirSync(dir)
      .filter((name) => /^auto-.*\.jpg$/i.test(name))
      .map((name) => ({ name, file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of files.slice(Math.max(0, Number(keep) || 0))) {
      try { rmSync(entry.file, { force: true }); } catch { /* 删不掉算了 */ }
    }
    return files.length;
  } catch {
    return 0;
  }
}

/** 截图目录：Config `screenShotDir`（绝对或相对 dataDir）否则 `<dataDir>/screenshots`。 */
export function resolveShotDir(configured, dataDir) {
  const raw = String(configured ?? '').trim();
  if (!raw) return join(dataDir, 'screenshots');
  return isAbsolute(raw) ? raw : resolve(dataDir, raw);
}

/**
 * 本机情境观察器的 PAUSED 检测（只读，不写）。
 * 候选顺序：环境变量 `DSH_CONTEXT_PAUSED_FILE` → `<dataDir>/../context-observer/PAUSED`
 * → `<dataDir>/context-observer/PAUSED`。文件存在即视为暂停。
 */
export function isContextPaused({ dataDir, env = process.env } = {}) {
  const candidates = [
    env?.DSH_CONTEXT_PAUSED_FILE,
    dataDir ? join(dirname(dataDir), 'context-observer', 'PAUSED') : '',
    dataDir ? join(dataDir, 'context-observer', 'PAUSED') : '',
  ].map((item) => String(item ?? '').trim()).filter(Boolean);
  return candidates.some((file) => existsSync(file));
}

/** 拼「自己决定说不说」的提示词（纯函数，测试可直接断言）。 */
export function buildDecidePrompt(caption) {
  return SCREEN_DECIDE_TEMPLATE.replace('${caption}', String(caption ?? '').trim());
}

/* ============================== 截图（PowerShell + System.Drawing） ============================== */

/**
 * 截主屏 → 1280×720 JPEG（质量 80），同时把屏幕缩成 64×36 灰度输出 hex（给 dHash 用）。
 * 只在本机执行 PowerShell，不装任何依赖、不执行第三方代码。
 *
 * @param {object} opts
 * @param {string} opts.screenshotPath
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {Function} [opts.execFileImpl] 测试注入（默认 node:child_process.execFile）
 * @returns {Promise<{bytes: number, grayHex: string}>}
 */
export async function captureScreenJpeg({
  screenshotPath, width = SCREEN_WIDTH, height = SCREEN_HEIGHT,
  platform = process.platform, execFileImpl = execFile,
} = {}) {
  if (platform !== 'win32') {
    throw Object.assign(new Error('看屏幕只支持 Windows 本机截图'), { code: 'unsupported-platform' });
  }
  if (!screenshotPath) throw Object.assign(new Error('截图路径为空'), { code: 'capture-failed' });
  mkdirSync(dirname(screenshotPath), { recursive: true });
  const safePath = String(screenshotPath).replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$s=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$src=[System.Drawing.Bitmap]::new($s.Width,$s.Height);',
    '$sg=[System.Drawing.Graphics]::FromImage($src);',
    '$sg.CopyFromScreen($s.X,$s.Y,0,0,$s.Size);',
    `$w=${Math.max(1, Number(width) || SCREEN_WIDTH)};$h=${Math.max(1, Number(height) || SCREEN_HEIGHT)};`,
    '$bmp=[System.Drawing.Bitmap]::new($w,$h);',
    '$g=[System.Drawing.Graphics]::FromImage($bmp);',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
    '$g.DrawImage($src,0,0,$w,$h);',
    "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'} | Select-Object -First 1;",
    '$params=[System.Drawing.Imaging.EncoderParameters]::new(1);',
    '$params.Param[0]=[System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality,80);',
    `$bmp.Save('${safePath}',$codec,$params);`,
    '$small=[System.Drawing.Bitmap]::new(64,36);',
    '$gs=[System.Drawing.Graphics]::FromImage($small);',
    '$gs.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
    '$gs.DrawImage($src,0,0,64,36);',
    '$sb=[System.Text.StringBuilder]::new();',
    'for($y=0;$y -lt 36;$y++){for($x=0;$x -lt 64;$x++){[void]$sb.Append($small.GetPixel($x,$y).R.ToString("X2"))}};',
    '[Console]::Out.Write($sb.ToString());',
    '$sg.Dispose();$g.Dispose();$gs.Dispose();$src.Dispose();$bmp.Dispose();$small.Dispose();',
  ].join(' ');
  const stdout = await new Promise((resolvePromise, reject) => {
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (error, out, stderr) => {
      if (error) {
        reject(Object.assign(new Error(`截图失败：${String(stderr || error.message || error).trim()}`), { code: 'capture-failed' }));
        return;
      }
      resolvePromise(String(out ?? ''));
    });
  });
  if (!existsSync(screenshotPath)) throw Object.assign(new Error('截图失败：文件未生成'), { code: 'capture-failed' });
  const bytes = statSync(screenshotPath).size;
  if (bytes <= 0) throw Object.assign(new Error('截图失败：文件为空'), { code: 'capture-failed' });
  const grayHex = stdout.trim().split(/\s+/).pop() ?? '';
  return { bytes, grayHex };
}

/* ============================== 视觉模型（本机回环 Ollama） ============================== */

/**
 * 调本机 Ollama `/api/generate`，`images` 只发到回环 endpoint。
 * @returns {Promise<{caption: string, elapsedMs: number}>}
 */
export async function callVisionModel({
  endpoint, model, prompt, timeoutMs = SCREEN_DEFAULTS.timeoutMs,
  imageBuffer, fetchImpl = globalThis.fetch,
} = {}) {
  const normalized = normalizeVisionEndpoint(endpoint);
  const chosenModel = String(model ?? '').trim();
  if (!normalized || !chosenModel) {
    throw Object.assign(new Error('未配置视觉模型 endpoint/model（endpoint 必须是回环地址）'), { code: 'vision-unavailable' });
  }
  if (!imageBuffer || imageBuffer.length === 0) {
    throw Object.assign(new Error('没有截图可发'), { code: 'vision-empty-image' });
  }
  const startedAt = Date.now();
  const timeout = Math.max(1_000, Number(timeoutMs) || SCREEN_DEFAULTS.timeoutMs);
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeout)
    : undefined;
  let response;
  try {
    response = await fetchImpl(`${normalized}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: chosenModel,
        prompt: String(prompt ?? '').trim() || SCREEN_DEFAULT_PROMPT,
        images: [imageBuffer.toString('base64')],
        stream: false,
        options: { num_ctx: 8192, num_predict: 160, temperature: 0.2 },
      }),
      signal,
    });
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ETIMEDOUT');
    throw Object.assign(
      new Error(isTimeout ? `视觉模型推理超时（>${Math.round(timeout / 1000)}s）` : `视觉模型请求失败：${err?.message ?? err}`),
      { code: isTimeout ? 'vision-timeout' : 'vision-request-failed' },
    );
  }
  if (!response || response.ok !== true) {
    let detail = '';
    try { detail = typeof response?.text === 'function' ? String(await response.text()).slice(0, 200) : ''; } catch { detail = ''; }
    throw Object.assign(new Error(`视觉模型返回 HTTP ${response?.status ?? 'unknown'}${detail ? `：${detail}` : ''}`), { code: 'vision-http-error' });
  }
  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw Object.assign(new Error(`视觉模型返回的不是 JSON：${err?.message ?? err}`), { code: 'vision-bad-json' });
  }
  const caption = typeof data?.response === 'string' ? data.response.trim() : '';
  if (!caption) throw Object.assign(new Error('视觉模型没有返回描述'), { code: 'vision-empty' });
  return { caption, elapsedMs: Date.now() - startedAt };
}

/** 回复里是否明确表示「不打扰」。 */
export function isSilenceReply(reply) {
  const text = String(reply ?? '').trim();
  if (text === '') return true;
  if (text.includes(SCREEN_SILENCE) || text.includes('［沉默］')) return true;
  // 远程大脑在空回复时会兜底成「(人家张了张嘴,没说出话来……)」——那等于没说
  if (text.includes('没说出话来') && text.includes('张了张嘴')) return true;
  return false;
}

/** 把她的回复压成适合气泡的一句（去掉换行/编号，≤80 字）。 */
export function bubbleReplyText(reply) {
  return String(reply ?? '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/^\s*[-*•]\s*/g, '')
    .replace(/^\s*\d+[.、)）]\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80);
}

function formatClock(ms) {
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/* ============================== 调度器 ============================== */

/**
 * 自动看屏调度器。用法：
 * ```js
 * const look = createScreenAutoLook({ dataDir, config, log, getBrain, isBrainAvailable, brainSay, say });
 * look.start(); // 5s tick
 * look.tickOnce(); // 测试可直接调
 * look.statusLine(); // pet_status
 * look.stop();
 * ```
 *
 * `config` 里认的字段（都有默认值）：
 * `screenIntervalMs` / `screenMinGapMs` / `screenMaxPerHour` / `visionEndpoint` /
 * `visionModel` / `visionPrompt` / `visionTimeoutMs` / `screenShotDir`；
 * 开关默认值用 `screenAutoLook`，实际开关以 `<dataDir>/screen-autolook.json` 为准。
 */
export function createScreenAutoLook({
  dataDir, config = {}, log = () => {},
  now = () => Date.now(), random = Math.random,
  getBrain = () => null,
  isBrainAvailable = () => true,
  brainSay,
  say,
  isPaused = () => isContextPaused({ dataDir }),
  capture = captureScreenJpeg,
  vision = callVisionModel,
  fetchImpl,
  execFileImpl,
  tickMs = SCREEN_TICK_MS,
  keepShots = SCREEN_KEEP_SHOTS,
} = {}) {
  if (!dataDir) throw new Error('createScreenAutoLook 需要 dataDir');
  const autoFile = join(dataDir, SCREEN_AUTO_FILE);
  const stateFile = join(dataDir, SCREEN_STATE_FILE);
  const shotDir = resolveShotDir(config.screenShotDir, dataDir);
  const settings = {
    fallbackEnabled: config.screenAutoLook === true,
    intervalMs: Number(config.screenIntervalMs) > 0 ? Number(config.screenIntervalMs) : SCREEN_DEFAULTS.intervalMs,
    minGapMs: Number(config.screenMinGapMs) >= 0 ? Number(config.screenMinGapMs) : SCREEN_DEFAULTS.minGapMs,
    maxPerHour: Number(config.screenMaxPerHour) > 0 ? Number(config.screenMaxPerHour) : SCREEN_DEFAULTS.maxPerHour,
    endpoint: String(config.visionEndpoint ?? '').trim() || SCREEN_DEFAULTS.endpoint,
    model: String(config.visionModel ?? '').trim() || SCREEN_DEFAULTS.model,
    prompt: String(config.visionPrompt ?? '').trim() || SCREEN_DEFAULTS.prompt,
    timeoutMs: Number(config.visionTimeoutMs) > 0 ? Number(config.visionTimeoutMs) : SCREEN_DEFAULTS.timeoutMs,
  };

  let state = readState(stateFile);
  /** 内存里的「本小时已看次数」（重启后只从 lastLookAt 恢复一个，不落盘历史）。 */
  let recentLooks = Number.isFinite(state.lastLookAt) ? [state.lastLookAt] : [];
  let nextDueAt = Number.isFinite(state.nextDueAt) ? state.nextDueAt : 0;
  let timer = null;
  let ticking = false;

  const enabled = () => readAutoEnabled(autoFile, settings.fallbackEnabled);
  const persist = () => {
    state.enabled = enabled();
    state.nextDueAt = nextDueAt || null;
    if (!writeState(stateFile, state)) log(`自动看屏状态写不进去:${stateFile}`);
  };
  const scheduleNext = (at) => {
    nextDueAt = Math.max(0, Number(at) || 0);
    persist();
  };

  /** 给 pet_status / 面板的一行摘要。 */
  const statusLine = () => {
    const on = enabled();
    const parts = [
      `看屏幕(自动): ${on ? '开' : '关'}`,
      `上次 ${formatClock(state.lastLookAt)}`,
      `共 ${state.totalLooks} 次`,
    ];
    if (state.lastSpoken) parts.push(`上次说:「${String(state.lastSpoken).slice(0, 24)}」`);
    if (state.lastError) parts.push(`最近错误:${String(state.lastError).slice(0, 80)}`);
    return parts.join(' · ');
  };

  const getState = () => ({ ...state, enabled: enabled() });

  /**
   * 跑一轮检查。任何异常都吞掉并写 `lastError`，返回一个描述对象（测试/日志用）。
   * @returns {Promise<{skipped?: string, looked?: boolean, spoken?: boolean, caption?: string, error?: string}>}
   */
  async function tickOnce() {
    if (ticking) return { skipped: 'overlap' };
    ticking = true;
    const at = now();
    try {
      const on = enabled();
      if (state.enabled !== on) { state.enabled = on; persist(); }
      const paused = isPaused();
      const brain = getBrain();
      const due = isLookDue({
        now: at,
        enabled: on,
        paused,
        lastLookAt: state.lastLookAt,
        nextDueAt,
        recentLooks,
        minGapMs: settings.minGapMs,
        maxPerHour: settings.maxPerHour,
      });
      if (!due.due) return { skipped: due.reason };
      if (!brain) return { skipped: 'no-brain' };
      if (brain.busy) return { skipped: 'brain-busy' };
      if (!isBrainAvailable()) return { skipped: 'brain-unavailable' };

      // ---- 1) 截图 ----
      mkdirSync(shotDir, { recursive: true });
      const shotPath = screenshotFilePath(shotDir, at);
      let captureResult;
      try {
        captureResult = await capture({
          screenshotPath: shotPath,
          width: SCREEN_WIDTH,
          height: SCREEN_HEIGHT,
          execFileImpl,
        });
      } catch (err) {
        const message = `截图失败:${err?.message ?? err}`;
        state.lastError = String(message).slice(0, 300);
        state.lastLookAt = at;
        recentLooks = [...recentLooks.filter((t) => t > at - 3_600_000), at];
        scheduleNext(at + jitteredInterval(settings.intervalMs, random));
        log(message);
        return { skipped: 'capture-failed', error: message };
      }
      state.totalLooks += 1;
      state.lastLookAt = at;
      recentLooks = [...recentLooks.filter((t) => t > at - 3_600_000), at];
      pruneScreenshots(shotDir, keepShots);
      const hash = dhashFromGrayHex(captureResult?.grayHex ?? '');
      // ---- 2) 屏幕没变就跳过（不调模型） ----
      if (hash && state.lastHash && hammingHex(hash, state.lastHash) <= SCREEN_SAME_HAMMING) {
        state.lastHash = hash;
        state.lastError = '';
        scheduleNext(at + jitteredInterval(settings.intervalMs, random));
        return { skipped: 'same-screen', looked: false };
      }
      if (hash) state.lastHash = hash;

      // ---- 3) 本机视觉模型 ----
      let caption;
      try {
        const bytes = readFileSync(shotPath);
        const result = await vision({
          endpoint: settings.endpoint,
          model: settings.model,
          prompt: settings.prompt,
          timeoutMs: settings.timeoutMs,
          imageBuffer: bytes,
          fetchImpl,
        });
        caption = String(result?.caption ?? '').trim();
        if (!caption) throw new Error('视觉模型返回空描述');
      } catch (err) {
        const message = `视觉模型失败:${err?.message ?? err}`;
        state.lastError = String(message).slice(0, 300);
        scheduleNext(at + jitteredInterval(settings.intervalMs, random));
        log(message);
        return { skipped: 'vision-failed', error: message };
      }
      state.lastError = '';

      // ---- 4) 和上次 caption 太像就跳过（不重复念叨同一屏） ----
      const previousCaption = state.lastCaption;
      const similarity = previousCaption ? captionSimilarity(caption, previousCaption) : 0;
      state.lastCaption = caption.slice(0, 500);
      if (similarity > SCREEN_CAPTION_SIMILARITY) {
        scheduleNext(at + jitteredInterval(settings.intervalMs, random));
        return { skipped: 'similar-caption', looked: true, caption };
      }

      // ---- 5) 让她自己决定说不说（同一个人格） ----
      let reply = '';
      try {
        reply = String(await brainSay(buildDecidePrompt(caption)) ?? '').trim();
      } catch (err) {
        const message = `她的大脑没答上来:${err?.message ?? err}`;
        state.lastError = String(message).slice(0, 300);
        scheduleNext(at + jitteredInterval(settings.intervalMs, random));
        log(message);
        return { skipped: 'brain-failed', looked: true, error: message };
      }
      scheduleNext(at + jitteredInterval(settings.intervalMs, random));
      if (isSilenceReply(reply)) {
        return { skipped: 'silent', looked: true, caption };
      }
      const text = bubbleReplyText(reply);
      if (!text) return { skipped: 'empty-reply', looked: true, caption };
      const actions = random() < 0.5 ? ['wave'] : ['happy'];
      let spoke = false;
      try {
        spoke = say(text, actions) !== false;
      } catch (err) {
        log(`自动看屏说话失败:${err?.message ?? err}`);
      }
      if (spoke) {
        state.lastSpokenAt = at;
        state.lastSpoken = text;
        state.totalSpoken += 1;
        persist();
        log(`自动看屏:${caption.slice(0, 60)} → 「${text}」`);
      }
      return { looked: true, spoken: spoke, caption, reply: text };
    } catch (err) {
      // 兜底：任何没预料到的异常都不许把插件带崩
      const message = `自动看屏异常:${err?.message ?? err}`;
      state.lastError = String(message).slice(0, 300);
      try { persist(); } catch { /* ignore */ }
      log(message);
      return { error: message };
    } finally {
      ticking = false;
    }
  }

  return {
    tickOnce,
    statusLine,
    getState,
    enabled,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tickOnce(); }, Math.max(1_000, Number(tickMs) || SCREEN_TICK_MS));
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
