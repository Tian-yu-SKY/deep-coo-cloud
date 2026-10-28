// dsh-link/server/awareness/local-sync.mjs
//
// 本机 → 服务器「共享情境快照」同步器（可分发通用版）。
//
// 数据流：
//   本机 bridge GET /context?limit=20  ──►  本脚本生成快照 JSON（过滤 private）
//      └─ ssh <your-user>@<your-server>：base64 原子写入 <remote-context-file>（可选 chown/chmod）
//         └─ 服务器插件 dsh-link-awareness 每轮 prompt 读取该文件 → 注入所有 agent 的运行时上下文
//
// 用法（本机/任意客户端机器）：
//   node local-sync.mjs --once            # 跑一次（验证/演示用）
//   node local-sync.mjs --once --dry-run  # 只打印将要写入的快照，不写服务器
//   node local-sync.mjs --loop            # 常驻：默认每 30s 同步一次
//   node local-sync.mjs --start           # 后台启动常驻（写 pid 文件）
//   node local-sync.mjs --stop            # 停止常驻
//   node local-sync.mjs --status          # 看状态
//   node local-sync.mjs --print           # 打印当前快照
//
// 配置（优先级：CLI 参数 > 环境变量 > 本目录 config.json > 默认值；示例见 config.example.json）：
//   SSH 写入必填：--ssh-host / AWARENESS_SSH_HOST、--remote-file / AWARENESS_REMOTE_FILE
//   可选：--ssh-key / AWARENESS_SSH_KEY、--ssh-bin / AWARENESS_SSH_BIN、
//         --token-file / AWARENESS_TOKEN_FILE（bridge 鉴权 token 文件）、
//         --bridge-base / AWARENESS_BRIDGE_BASE、--interval-ms / AWARENESS_INTERVAL_MS、
//         --history-session / AWARENESS_HISTORY_SESSION（启用 /history 对话同步）
//   缺少 SSH 写入必填参数时会打印本用法并以退出码 2 结束（不会静默写错地方）。
//
// 安全：只读 bridge /context、/history；只写服务器一个快照文件（原子写+可选 chown/chmod）；不碰 QQ/角色卡/preset。
// 失败：每轮最多重试 2 次；写失败只记录日志、保留服务器上的旧快照（插件侧会按 30 分钟过期降级）。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 打包时约定：本脚本在 <pkg>/server/awareness/，bridge 在 <pkg>/bridge/；仅作为相对默认值用，可由配置覆盖。
const PACKAGE_ROOT = resolve(HERE, '..', '..')

const LOG_PREFIX = '[awareness-sync]'
const MAX_SNAPSHOT_BYTES = 12 * 1024 // 情境事件 + 本机对话 ≤12KB
const MAX_EVENTS = 20
const MAX_SUMMARY_CHARS = 200

export const DEFAULTS = {
  bridgeBase: 'http://127.0.0.1:47891', // 本机 bridge（通用回环地址）
  tokenFile: '', // bridge token 文件；空=不发送 token（无鉴权 bridge 可留空）
  sshHost: '', // 必填：'<user>@<your-server>'（或 AWARENESS_SSH_HOST）
  sshKey: '', // 可选：SSH 私钥路径；空=用 ssh 默认身份/agent
  sshBin: '', // 可选：ssh 可执行文件；空=自动探测 PATH/系统 OpenSSH
  remoteFile: '', // 必填：服务器上的快照文件绝对路径（或 AWARENESS_REMOTE_FILE）
  remoteOwner: '', // 可选：写完后 chown 的属主（如 '<user>:<user>'）；空=不改
  remoteMode: '600',
  intervalMs: 30000,
  minWriteIntervalMs: 5 * 60 * 1000, // 内容没变时，5 分钟才重写一次（保持「还在同步」的新鲜度）
  requestTimeoutMs: 6000,
  retries: 2,
  retryDelayMs: 3000,
  logFile: join(HERE, 'logs', 'local-sync.log'),
  logMaxBytes: 1024 * 1024,
  stateFile: join(HERE, 'state.json'),
  pidFile: join(HERE, 'local-sync.pid'),
  sshConnectTimeoutSec: 8,
  // 跨端对话：本机/面板最近对话（bridge GET /history）；默认不指定 sessionId = 不启用
  historyPath: '/history',
  historySession: '', // 例：'pet-local'（或 AWARENESS_HISTORY_SESSION）
  historyLimit: 8,
  dialogueTextMaxChars: 200,
  snapshotMaxBytes: MAX_SNAPSHOT_BYTES,
}

// 环境变量 → 配置键（优先级：CLI > 环境变量 > config.json > 默认值）
const ENV_KEYS = {
  AWARENESS_BRIDGE_BASE: 'bridgeBase',
  AWARENESS_TOKEN_FILE: 'tokenFile',
  AWARENESS_SSH_HOST: 'sshHost',
  AWARENESS_SSH_KEY: 'sshKey',
  AWARENESS_SSH_BIN: 'sshBin',
  AWARENESS_REMOTE_FILE: 'remoteFile',
  AWARENESS_REMOTE_OWNER: 'remoteOwner',
  AWARENESS_HISTORY_SESSION: 'historySession',
}

// ---------------------------------------------------------------------------
// 配置 / 日志
// ---------------------------------------------------------------------------
function loadConfig() {
  let fileConfig = {}
  const configPath = join(HERE, 'config.json')
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (error) {
      console.error(LOG_PREFIX, `config.json 解析失败，使用默认配置: ${error.message}`)
    }
  }
  const merged = { ...DEFAULTS, ...fileConfig }
  // 忽略空字符串/空值的文件配置（避免 "key": "" 把默认值覆盖成空）
  for (const [key, value] of Object.entries(merged)) {
    if (value === '' && Object.hasOwn(fileConfig, key) && fileConfig[key] === '') merged[key] = DEFAULTS[key]
  }
  // 环境变量覆盖（AWARENESS_*；CLI 参数在 main() 里最后覆盖）
  for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
    const value = process.env[envKey]
    if (typeof value === 'string' && value.trim().length > 0) merged[configKey] = value.trim()
  }
  const envInterval = Number(process.env.AWARENESS_INTERVAL_MS)
  if (Number.isFinite(envInterval) && envInterval > 0) merged.intervalMs = Math.max(5000, envInterval)
  return merged
}

/** 远程写入的必填参数（缺失时打印用法，不做任何写入）。 */
export function missingRemoteConfig(config) {
  const missing = []
  if (!config?.sshHost) missing.push('sshHost（--ssh-host / AWARENESS_SSH_HOST）')
  if (!config?.remoteFile) missing.push('remoteFile（--remote-file / AWARENESS_REMOTE_FILE）')
  return missing
}

/** 打印用法（缺参数时调用；不含任何私有默认值）。 */
export function usageText() {
  return [
    '用法: node local-sync.mjs <命令> [选项]',
    '',
    '命令:',
    '  --once             # 同步一次（默认命令）',
    '  --once --dry-run   # 只打印将要写入的快照，不写远端',
    '  --loop             # 常驻：按 interval 周期同步',
    '  --start / --stop   # 后台启动 / 停止常驻',
    '  --status           # 显示运行状态与配置',
    '  --print            # 打印当前快照（dry-run）',
    '',
    '必填（SSH 写入远端）:',
    '  --ssh-host <user>@<your-server>    或 AWARENESS_SSH_HOST',
    '  --remote-file <absolute-path>      或 AWARENESS_REMOTE_FILE（远端快照文件绝对路径）',
    '',
    '可选:',
    '  --ssh-key <path>                   或 AWARENESS_SSH_KEY（空=用 ssh 默认身份/agent）',
    '  --ssh-bin <path>                   或 AWARENESS_SSH_BIN',
    '  --token-file <path>                或 AWARENESS_TOKEN_FILE（bridge token 文件；空=不发送 token）',
    '  --bridge-base <url>                或 AWARENESS_BRIDGE_BASE（默认 http://127.0.0.1:47891）',
    '  --interval-ms <ms>                 或 AWARENESS_INTERVAL_MS（默认 30000）',
    '  --history-session <id>             或 AWARENESS_HISTORY_SESSION（启用 /history 对话同步）',
    '  --remote-owner <user:group>        或 AWARENESS_REMOTE_OWNER（写后 chown；空=不改）',
    '',
    '也可以在本目录 config.json 里配置（见 config.example.json）。',
  ].join('\n')
}

function printUsage(stream = process.stderr) {
  try { stream.write(`${usageText()}\n`) } catch { /* ignore */ }
}

function rotateLog(logFile) {
  try {
    const stat = statSync(logFile)
    if (stat.size > 1024 * 1024) renameSync(logFile, `${logFile}.1`)
  } catch { /* 不存在就算了 */ }
}

function createLogger(config) {
  try { mkdirSync(dirname(config.logFile), { recursive: true }) } catch { /* ignore */ }
  return {
    write(level, message) {
      const line = `${new Date().toISOString()} ${level} ${message}\n`
      try {
        rotateLog(config.logFile)
        appendFileSync(config.logFile, line)
      } catch { /* ignore */ }
      if (level === 'ERROR' || level === 'WARN' || process.env.AWARENESS_VERBOSE === '1') {
        try { process.stderr.write(`${LOG_PREFIX} ${level} ${message}\n`) } catch { /* ignore */ }
      }
    },
    info(message) { this.write('INFO', message) },
    warn(message) { this.write('WARN', message) },
    error(message) { this.write('ERROR', message) },
  }
}

// ---------------------------------------------------------------------------
// 工具探测
// ---------------------------------------------------------------------------
function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* next */ }
  }
  return ''
}

export function detectSshKey(config) {
  // 只用显式配置/环境变量提供的私钥；不猜测、不引用任何私有默认路径。
  return config?.sshKey ? String(config.sshKey) : ''
}

export function detectSshBin(config) {
  if (config.sshBin) return config.sshBin
  const candidates = [
    'ssh',
    'C:/Windows/System32/OpenSSH/ssh.exe',
    'C:/Program Files/Git/usr/bin/ssh.exe',
    'C:/Program Files (x86)/Git/usr/bin/ssh.exe',
  ]
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['-V'], { timeout: 5000, encoding: 'utf8' })
      if (result.status === 0 || (result.stderr ?? '').toLowerCase().includes('openssh')) return candidate
    } catch { /* next */ }
  }
  return 'ssh'
}

function readToken(config) {
  // token 可选：未配置 tokenFile = 不发送鉴权（适用于无鉴权的本机 bridge）
  if (!config?.tokenFile) return ''
  try {
    return readFileSync(config.tokenFile, 'utf8').trim()
  } catch {
    return ''
  }
}

/** 拼 bridge 请求鉴权头（token 为空则只带 accept）。 */
function bridgeHeaders(config, token) {
  return token
    ? { authorization: `Bearer ${token}`, 'x-bridge-token': token, accept: 'application/json' }
    : { accept: 'application/json' }
}

/** token 非空时加 query 参数（兼容只认 query 的 bridge）。 */
function appendToken(url, token) {
  if (token) url.searchParams.set('token', token)
}

// ---------------------------------------------------------------------------
// bridge /context → 快照
// ---------------------------------------------------------------------------
const SURFACES = new Set(['desktop', 'dsh-local', 'qq', 'panel'])
const KINDS = new Set(['window', 'session', 'activity'])

function clampText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 1)}…`
}

/** 归一化 bridge GET /context 的响应（兼容 {events}、{context:{events}}、{value:{events}}）。 */
export function normalizeContextResponse(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object') return { events: [], updatedAt: null }
  const bag = payload.context ?? payload.value ?? payload
  const rawEvents = Array.isArray(bag.events) ? bag.events : Array.isArray(payload.events) ? payload.events : []
  const updatedAt = Number(bag.updatedAt ?? payload.updatedAt)
  const events = []
  const seen = new Set()
  for (const raw of rawEvents) {
    if (raw === null || typeof raw !== 'object') continue
    if (raw.private === true) continue // 双保险：bridge 已过滤，本机再兜一层
    const summary = clampText(raw.summary, MAX_SUMMARY_CHARS)
    const at = Number(raw.at)
    if (!summary || !Number.isFinite(at) || at <= 0) continue
    const key = `${at}|${summary}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push({
      at,
      surface: SURFACES.has(raw.surface) ? raw.surface : 'unknown',
      kind: KINDS.has(raw.kind) ? raw.kind : 'activity',
      summary,
    })
  }
  events.sort((left, right) => right.at - left.at)
  return { events: events.slice(0, MAX_EVENTS), updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null }
}

/** 生成快照对象；超 12KB 时先丢最旧情境事件，再丢最旧对话消息。 */
export function buildSnapshot({ events, dialogue = null, updatedAt = null, now = Date.now(), maxBytes = MAX_SNAPSHOT_BYTES }) {
  const kept = [...events]
  let snapshot = {
    schema: 1,
    source: 'bridge:/context',
    device: 'dsh-link-local',
    syncedAt: now,
    updatedAt: updatedAt ?? now,
    count: kept.length,
    events: kept,
    ...(dialogue !== null && typeof dialogue === 'object' ? { dialogue } : {}),
  }
  const size = () => Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  while (size() > maxBytes && snapshot.events.length > 0) {
    snapshot.events = snapshot.events.slice(0, -1)
    snapshot.count = snapshot.events.length
  }
  while (size() > maxBytes && Array.isArray(snapshot.dialogue?.messages) && snapshot.dialogue.messages.length > 1) {
    snapshot.dialogue.messages.shift()
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// bridge /history → 本机/面板最近对话（T20 跨端对话连续性）
// ---------------------------------------------------------------------------

/** bridge 的 context/角色卡注入会拼进 user 消息；展示/注入前剥掉这些外壳，只留用户原话。 */
const INJECTED_BLOCK_HEAD = /^【(?:主人当前情境|共享情境|角色卡（长期设定)[^】]*】/

export function cleanHistoryUserText(text) {
  let value = String(text ?? '')
  const marker = '【用户消息】'
  const markerIndex = value.lastIndexOf(marker)
  if (markerIndex >= 0) value = value.slice(markerIndex + marker.length)
  const lines = value.split('\n')
  const dropLeadingBlank = () => {
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  }
  dropLeadingBlank()
  // 反复剥掉开头的注入块（header + 紧跟的 "- ..." 行 + 空行）
  while (lines.length > 0 && INJECTED_BLOCK_HEAD.test(lines[0].trim())) {
    lines.shift()
    while (lines.length > 0) {
      const line = lines[0]
      if (line.trim() === '' || /^[ \t]*[-•*][ \t]/.test(line)) {
        lines.shift()
        continue
      }
      break
    }
    dropLeadingBlank()
  }
  return lines.join('\n').trim()
}

/**
 * 归一化 bridge GET /history 响应 → 快照 dialogue.messages。
 * 只保留 role user/assistant、时间有效；user 消息剥注入外壳；每条 ≤ maxChars；取最近 limit 条。
 * @returns {{role:'user'|'assistant', text:string, at:number}[]}
 */
export function normalizeHistoryResponse(payload, { limit = 8, maxChars = 200 } = {}) {
  const cap = Math.max(1, Math.min(50, Number(limit) || 8))
  const textCap = Math.max(20, Number(maxChars) || 200)
  const rawMessages = Array.isArray(payload?.messages) ? payload.messages : []
  const messages = []
  for (const raw of rawMessages) {
    if (raw === null || typeof raw !== 'object') continue
    const role = raw.role === 'user' ? 'user' : raw.role === 'assistant' ? 'assistant' : null
    if (role === null) continue
    const at = Number(raw.at)
    if (!Number.isFinite(at) || at <= 0) continue
    const text = clampText(role === 'user' ? cleanHistoryUserText(raw.text) : raw.text, textCap)
    if (text.length === 0) continue
    messages.push({ role, text, at })
  }
  messages.sort((left, right) => left.at - right.at)
  return messages.slice(-cap)
}

async function fetchHistory(config, logger) {
  const token = readToken(config)
  const url = new URL(config.historyPath || '/history', config.bridgeBase)
  url.searchParams.set('session', config.historySession)
  url.searchParams.set('limit', String(config.historyLimit || 8))
  appendToken(url, token)
  const response = await fetch(url, {
    headers: bridgeHeaders(config, token),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GET /history HTTP ${response.status}: ${text.slice(0, 200)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`GET /history 返回非 JSON: ${text.slice(0, 200)}`)
  }
  if (payload?.ok === false) throw new Error(`GET /history 失败: ${payload?.error?.code ?? 'unknown'} ${payload?.error?.message ?? ''}`.trim())
  return normalizeHistoryResponse(payload, { limit: config.historyLimit || 8, maxChars: config.dialogueTextMaxChars || 200 })
}

async function fetchContext(config, logger) {
  const token = readToken(config)
  const url = new URL('/context', config.bridgeBase)
  url.searchParams.set('limit', String(MAX_EVENTS))
  appendToken(url, token)
  const response = await fetch(url, {
    method: 'GET',
    headers: bridgeHeaders(config, token),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GET /context HTTP ${response.status}: ${text.slice(0, 200)}`)
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error(`GET /context 返回非 JSON: ${text.slice(0, 200)}`) }
  if (payload?.ok === false) throw new Error(`GET /context 失败: ${payload?.error?.code ?? 'unknown'} ${payload?.error?.message ?? ''}`.trim())
  return normalizeContextResponse(payload)
}

/**
 * 读 bridge /health 里的 serverClockOffsetMs（服务器时钟 - 本机时钟）。
 * 服务器与本机可能有几分钟 NTP 偏差；快照时间统一换算到服务器时钟，插件侧算 age 才准。
 * 拿不到就返回 0（插件侧还有 15 分钟超前容忍）。
 */
async function fetchServerClockOffset(config) {
  try {
    const token = readToken(config)
    const url = new URL('/health', config.bridgeBase)
    appendToken(url, token)
    const response = await fetch(url, { headers: bridgeHeaders(config, token), signal: AbortSignal.timeout(config.requestTimeoutMs) })
    if (!response.ok) return 0
    const payload = await response.json()
    const offset = Number(payload?.auth?.serverClockOffsetMs)
    if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 60 * 60 * 1000) return 0
    return offset
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// SSH 写入（原子写 + 属主/权限）
// ---------------------------------------------------------------------------
export function buildRemoteWriteCommand(config) {
  const target = config.remoteFile
  const tmp = `${target}.tmp`
  const steps = [`base64 -d > ${tmp}`]
  if (config.remoteOwner) steps.push(`chown ${config.remoteOwner} ${tmp}`)
  if (config.remoteMode) steps.push(`chmod ${config.remoteMode} ${tmp}`)
  steps.push(`mv -f ${tmp} ${target}`)
  return steps.join(' && ')
}

function sshWrite(config, sshBin, sshKey, jsonText, logger) {
  const command = buildRemoteWriteCommand(config)
  const encoded = Buffer.from(jsonText, 'utf8').toString('base64')
  const args = []
  if (sshKey) {
    args.push('-i', sshKey, '-o', 'IdentitiesOnly=yes')
  }
  args.push(
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${config.sshConnectTimeoutSec}`,
    config.sshHost,
    command,
  )
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(sshBin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolvePromise({ ok: false, error: `spawn ssh failed: ${error.message}` })
      return
    }
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolvePromise({ ok: false, error: `ssh error: ${error.message}` }))
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ ok: true, bytes: Buffer.byteLength(jsonText, 'utf8') })
      else resolvePromise({ ok: false, error: `ssh exit ${code}: ${(stderr || stdout).trim().slice(0, 300)}` })
    })
    try {
      child.stdin.write(`${encoded}\n`)
      child.stdin.end()
    } catch (error) {
      resolvePromise({ ok: false, error: `ssh stdin failed: ${error.message}` })
    }
  })
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------
function readState(config) {
  try { return JSON.parse(readFileSync(config.stateFile, 'utf8')) } catch { return {} }
}

function writeState(config, patch) {
  const state = { ...readState(config), ...patch }
  try { writeFileSync(config.stateFile, `${JSON.stringify(state, null, 2)}\n`) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 单轮同步
// ---------------------------------------------------------------------------
export async function syncOnce(config, logger, { dryRun = false } = {}) {
  const state = readState(config)
  const now = Date.now()
  const sshKey = detectSshKey(config)
  const sshBin = detectSshBin(config)
  if (!dryRun) {
    const missing = missingRemoteConfig(config)
    if (missing.length > 0) {
      logger.error(`配置不完整，未执行写入：缺少 ${missing.join('、')}（运行 --help 查看用法）`)
      return { ok: false, error: `config-incomplete: ${missing.join(', ')}` }
    }
  }
  let lastError = null
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    try {
      const context = await fetchContext(config, logger)
      const clockOffsetMs = await fetchServerClockOffset(config)
      // 统一换算到服务器时钟（事件 at / syncedAt / updatedAt 全部 + offset）
      const events = context.events.map((event) => ({ ...event, at: event.at + clockOffsetMs }))
      // 跨端对话：配置了 historySession 才拉 bridge /history；失败只降级该字段
      let dialogue = null
      if (config.historySession) {
        try {
          const messages = await fetchHistory(config, logger)
          if (messages.length > 0) {
            dialogue = {
              sessionId: config.historySession,
              source: 'bridge:/history',
              updatedAt: now + clockOffsetMs,
              messages,
            }
          }
        } catch (error) {
          logger.warn(`history 拉取失败（dialogue 降级为空）: ${String(error?.message ?? error)}`)
        }
      }
      const snapshot = buildSnapshot({
        events,
        dialogue,
        updatedAt: (context.updatedAt ?? now) + clockOffsetMs,
        now: now + clockOffsetMs,
        maxBytes: config.snapshotMaxBytes || MAX_SNAPSHOT_BYTES,
      })
      snapshot.clockOffsetMs = clockOffsetMs
      const jsonText = `${JSON.stringify(snapshot)}\n`
      const hash = createHash('sha256').update(jsonText).digest('hex')
      const dialogueCount = Array.isArray(snapshot.dialogue?.messages) ? snapshot.dialogue.messages.length : 0
      const basePatch = {
        lastFetchAt: now,
        lastEventCount: snapshot.events.length,
        lastDialogueCount: dialogueCount,
        lastSnapshotHash: hash,
        lastError: null,
      }
      if (dryRun) {
        logger.info(`dry-run: events=${snapshot.events.length} dialogue=${dialogueCount} bytes=${Buffer.byteLength(jsonText)} updatedAt=${snapshot.updatedAt}`)
        return { ok: true, dryRun: true, snapshot, jsonText }
      }
      const contentChanged = state.lastSnapshotHash !== hash
      const lastWriteAt = Number(state.lastWriteAt) || 0
      const mustWrite = contentChanged || now - lastWriteAt >= config.minWriteIntervalMs
      if (!mustWrite) {
        writeState(config, { ...basePatch, lastSkippedWriteAt: now })
        logger.info(`skip write: unchanged (${snapshot.events.length} events / ${dialogueCount} dialogue, last write ${Math.round((now - lastWriteAt) / 1000)}s ago)`)
        return { ok: true, skipped: true, snapshot }
      }
      const result = await sshWrite(config, sshBin, sshKey, jsonText, logger)
      if (!result.ok) throw new Error(result.error)
      writeState(config, {
        ...basePatch,
        lastSuccessAt: now,
        lastWriteAt: now,
        lastWriteBytes: result.bytes,
        lastSshKey: sshKey,
        consecutiveFailures: 0,
      })
      logger.info(
        `WROTE ${config.remoteFile} events=${snapshot.events.length} dialogue=${dialogueCount} bytes=${result.bytes} ` +
          `bridgeUpdatedAt=${snapshot.updatedAt} ssh=${sshBin} key=${sshKey}`,
      )
      return { ok: true, snapshot, bytes: result.bytes }
    } catch (error) {
      lastError = String(error?.message ?? error)
      if (attempt < config.retries) await new Promise((r) => setTimeout(r, config.retryDelayMs * (attempt + 1)))
    }
  }
  writeState(config, {
    lastFetchAt: now,
    lastError,
    consecutiveFailures: (Number(state.consecutiveFailures) || 0) + 1,
  })
  logger.error(`sync failed: ${lastError}`)
  return { ok: false, error: lastError }
}

// ---------------------------------------------------------------------------
// 常驻 / 启停
// ---------------------------------------------------------------------------
async function runLoop(config, logger) {
  logger.info(`loop start pid=${process.pid} intervalMs=${config.intervalMs} bridge=${config.bridgeBase}`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    logger.info('loop stop')
    try { rmSync(config.pidFile, { force: true }) } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  while (!stopping) {
    await syncOnce(config, logger)
    await new Promise((r) => setTimeout(r, config.intervalMs))
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function startDetached(config, logger) {
  const existing = readPid(config)
  if (existing !== null && isPidAlive(existing)) {
    console.log(`already running pid=${existing}`)
    return 0
  }
  // 把本次 CLI 覆盖参数透传给后台子进程（去掉 --start，换成 --loop），避免子进程丢失配置
  const passthrough = []
  const sourceArgs = process.argv.slice(2)
  for (let index = 0; index < sourceArgs.length; index += 1) {
    const arg = sourceArgs[index]
    if (arg === '--start') continue
    if (arg === '--loop') continue
    passthrough.push(arg)
    if (!arg.startsWith('--') && index === 0) continue
    if (!arg.includes('=') && ['--bridge-base', '--token-file', '--ssh-host', '--ssh-key', '--ssh-bin', '--remote-file', '--remote-owner', '--history-session', '--interval-ms'].includes(arg)) {
      index += 1
      if (index < sourceArgs.length) passthrough.push(sourceArgs[index])
    }
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--loop', ...passthrough], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: HERE,
    env: process.env,
  })
  child.unref()
  try { writeFileSync(config.pidFile, `${child.pid}\n`) } catch { /* ignore */ }
  logger.info(`started detached pid=${child.pid}`)
  console.log(`started pid=${child.pid} log=${config.logFile}`)
  return 0
}

function readPid(config) {
  try {
    const pid = Number(String(readFileSync(config.pidFile, 'utf8')).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function stop(config, logger) {
  const pid = readPid(config)
  if (pid === null) {
    console.log('not running (no pid file)')
    return 0
  }
  let killed = false
  try {
    process.kill(pid, 'SIGTERM')
    killed = true
  } catch { /* ignore */ }
  if (!killed) {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true })
      killed = result.status === 0
    } catch { /* ignore */ }
  }
  try { rmSync(config.pidFile, { force: true }) } catch { /* ignore */ }
  logger.info(`stop pid=${pid} killed=${killed}`)
  console.log(killed ? `stopped pid=${pid}` : `pid=${pid} not running / already exited`)
  return 0
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main(argv) {
  const config = loadConfig()
  const logger = createLogger(config)
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
  const valueOf = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
  }
  // CLI 覆盖（优先级最高）
  const cliKeys = [
    ['--bridge-base', 'bridgeBase'],
    ['--token-file', 'tokenFile'],
    ['--ssh-host', 'sshHost'],
    ['--ssh-key', 'sshKey'],
    ['--ssh-bin', 'sshBin'],
    ['--remote-file', 'remoteFile'],
    ['--remote-owner', 'remoteOwner'],
    ['--history-session', 'historySession'],
  ]
  for (const [flag, key] of cliKeys) {
    const value = valueOf(flag, '')
    if (value !== '') config[key] = value
  }
  if (valueOf('--interval-ms', '') !== '') config.intervalMs = Math.max(5000, Number(valueOf('--interval-ms', config.intervalMs)))
  const dryRun = flags.has('--dry-run')
  if (flags.has('--help') || flags.has('-h') || argv.includes('-h')) {
    printUsage(process.stdout)
    return 0
  }
  const requireRemote = (action) => {
    const missing = missingRemoteConfig(config)
    if (missing.length > 0) {
      console.error(`${LOG_PREFIX} 无法${action}：缺少必填参数 ${missing.join('、')}`)
      console.error('')
      printUsage()
      return false
    }
    return true
  }
  if (flags.has('--start')) {
    if (!requireRemote('启动常驻')) return 2
    return startDetached(config, logger)
  }
  if (flags.has('--stop')) return stop(config, logger)
  if (flags.has('--status')) {
    const pid = readPid(config)
    const alive = pid !== null && isPidAlive(pid)
    console.log(JSON.stringify({
      running: alive,
      pid: alive ? pid : null,
      config,
      state: readState(config),
    }, null, 2))
    return 0
  }
  if (flags.has('--print')) {
    const result = await syncOnce(config, logger, { dryRun: true })
    console.log(JSON.stringify(result.snapshot ?? { ok: false, error: result.error }, null, 2))
    return result.ok ? 0 : 0
  }
  if (flags.has('--loop')) {
    if (!requireRemote('启动常驻')) return 2
    try { writeFileSync(config.pidFile, `${process.pid}\n`) } catch { /* ignore */ }
    await runLoop(config, logger)
    return 0
  }
  // 默认：跑一次
  if (!dryRun && !requireRemote('同步')) return 2
  const result = await syncOnce(config, logger, { dryRun })
  if (!result.ok) {
    console.error(`sync failed: ${result.error}`)
    return 1
  }
  if (dryRun) console.log(JSON.stringify(result.snapshot, null, 2))
  return 0
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(LOG_PREFIX, 'FATAL', error?.stack ?? error)
    process.exit(1)
  })
}
