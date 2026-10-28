// dsh-link-awareness / awareness.mjs
//
// 纯逻辑层：把「本机情境快照 + QQ 近期活动 + QQ 桥接状态 + 最近跨端对话」拼成一段情境块。
// 设计约束（与 deep-soul 一致，安全优先）：
//   1. 只依赖 node: 内置模块；不含任何机器/用户/QQ 私有默认值（路径由 $DSH_HOME 或 ~ 解析，QQ 相关输入默认关闭）；
//   2. 所有读取/解析失败都降级为「不注入」，绝不抛异常（systemPrompt 的 text 函数里抛错
//      会让整轮 prompt 组装失败）；
//   3. 只读文件，不写任何服务器数据；
//   4. 时间/大小全部可配置，便于测试注入 now 与假文件。
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOG_PREFIX = '[dsh-link-awareness]'

/** DSH 数据目录：优先 $DSH_HOME，否则 ~/.dsh（跨平台，不写死任何私有路径）。 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/** 默认情境快照路径：`$DSH_HOME/shared-awareness.json`（未设 DSH_HOME 时 `~/.dsh/shared-awareness.json`）。 */
export const DEFAULT_CONTEXT_FILE = join(resolveDshHome(), 'shared-awareness.json')

export const DEFAULTS = Object.freeze({
  // 输入文件（只读）
  // 本机情境快照：默认 $DSH_HOME/shared-awareness.json；由本机同步器（awareness/local-sync.mjs）写入。
  contextFile: DEFAULT_CONTEXT_FILE,
  // QQ 集成全部默认关闭（空字符串=不启用），需要时由部署者指向自己的 qq-bridge 状态文件。
  qqActivityFile: '', // 例：'~/.dsh/qq-bridge/state/qq-activity.log'（需自行展开/填绝对路径）
  // T17：QQ 双向消息原文（social-v2.json：conversations.*.recentMessages，isSelf 区分谁说的）
  socialFile: '', // 空=不启用 QQ 预览/QQ 对话；填你自己的 social-v2.json 绝对路径
  bridgeLogFile: '', // 空=不启用 QQ 桥接状态
  // 本机情境：只取最近 N 分钟的事件；快照整体超过 staleAfterMinutes 视为「同步已停」，本地部分降级不注入
  maxAgeMinutes: 20,
  staleAfterMinutes: 30,
  contextMaxItems: 5,
  // 本机与服务器的时钟/NTP 偏差容忍：事件时间轻微「超前」不算无效（按刚刚处理）
  clockSkewToleranceMinutes: 15,
  // QQ 近况：只看最近 N 分钟的活动日志
  qqWindowMinutes: 90,
  qqMaxItems: 3,
  qqTailLines: 60,
  qqIncludePreview: false, // 默认不把群/私聊正文带进其它会话（隐私）
  // 正文预览（activity 日志回退路径用；social-v2 路径用下面的 qqPreview*）
  qqPreviewChatTypes: ['private'],
  qqPreviewChats: [], // 需预览的私聊会话 key 列表（如 '<chatType>:<id>'），默认空=需显式配置
  // T17 social-v2 预览：私聊/群聊原文 + 鲸歌自己的回复原文
  qqPreviewIncludeSelf: false,
  qqPreviewGroup: false, // 群聊预览总开关（部署者明确开启并配置白名单）
  qqPreviewGroups: [], // group key 白名单（如 '<chatType>:<id>'）或 'all'；默认空=不预览任何群
  qqPreviewMaxChars: 60, // 每段正文最多 60 字（先裁剪）
  qqPreviewLineMaxChars: 60, // 整行硬上限 60 字（再裁剪）
  qqPreviewMinTextChars: 4, // 缩行时每段正文最少保留 4 字（省略号不计）
  qqPreviewMaxItems: 4, // 预览行总数上限
  // T20：跨端对话连续性（本机/面板最近对话 + QQ 最近对话原文，放在注入块最前面）
  dialogueInclude: true,
  dialogueMaxItems: 10, // 跨端对话段总行数上限
  dialogueMaxChars: 700, // 跨端对话段整块上限（字符）
  dialogueSurfaces: ['panel', 'qq-private', 'qq-group'], // 参与对话段的面（QQ 面只在 socialFile 配置后才有数据）
  dialogueSourceMaxItems: 6, // 每个来源最多取最近 6 条
  dialogueTextMaxChars: 80, // 每行正文最多 80 字
  // 注入块
  blockMaxChars: 1000,
  order: 903,
  // 日志节流
  logThrottleMs: 60000,
})

export function log(...args) {
  try { console.log(LOG_PREFIX, ...args) } catch { /* 日志失败不影响边界 */ }
}
export function logError(...args) {
  try { console.error(LOG_PREFIX, ...args) } catch { /* ignore */ }
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 规整一段摘要：折叠空白、截断。 */
export function clampText(value, maxChars = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** HH:MM（服务器本地时区）。 */
export function formatClock(at) {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 相对时间（中文，注入块用）。 */
export function relativeTime(at, now = Date.now()) {
  const elapsed = Math.max(0, now - at)
  if (elapsed < 60 * 1000) return '刚刚'
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / 60000)} 分钟前`
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)} 小时前`
  const d = new Date(at)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// 只读文件读取（带 mtime+size 缓存；stat 失败 → 空结果 + error，不抛）
// ---------------------------------------------------------------------------

/** @returns {{value:any, error:string|null, mtimeMs:number}} */
export function readJsonCached(path, cache) {
  try {
    const st = statSync(path)
    const hit = cache.get(path)
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
    const entry = { mtimeMs: st.mtimeMs, size: st.size, value: JSON.parse(readFileSync(path, 'utf8')), error: null }
    cache.set(path, entry)
    return entry
  } catch (error) {
    const entry = { mtimeMs: -1, size: -1, value: null, error: String(error?.message ?? error) }
    cache.set(path, entry)
    return entry
  }
}

/**
 * 读文件尾部若干行：文件大于 maxBytes 时只从尾部读，避免大日志整读。
 * @returns {{lines:string[], error:string|null, mtimeMs:number}}
 */
export function readTailCached(path, cache, { maxLines = 40, maxBytes = 65536 } = {}) {
  try {
    const st = statSync(path)
    const hit = cache.get(path)
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
    let text = ''
    if (st.size <= maxBytes) {
      text = readFileSync(path, 'utf8')
    } else {
      const fd = openSync(path, 'r')
      try {
        const start = st.size - maxBytes
        const buf = Buffer.alloc(maxBytes)
        readSync(fd, buf, 0, maxBytes, start)
        text = buf.toString('utf8')
        // 丢掉第一行（可能被截断）
        const firstBreak = text.indexOf('\n')
        text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
      } finally {
        closeSync(fd)
      }
    }
    const lines = text.split('\n').filter((line) => line.length > 0).slice(-maxLines)
    const entry = { mtimeMs: st.mtimeMs, size: st.size, lines, error: null }
    cache.set(path, entry)
    return entry
  } catch (error) {
    const entry = { mtimeMs: -1, size: -1, lines: [], error: String(error?.message ?? error) }
    cache.set(path, entry)
    return entry
  }
}

// ---------------------------------------------------------------------------
// 本机情境
// ---------------------------------------------------------------------------

const SURFACE_LABEL = {
  desktop: '本机',
  'dsh-local': '本机 DSH',
  qq: 'QQ',
  panel: '鲸歌面板',
}

/**
 * 从快照里挑出最近 maxAgeMinutes 内、非 private 的情境条目（新→旧，去重）。
 * @param {{events?:any[], updatedAt?:number, syncedAt?:number}|null} snapshot
 * @returns {{items:{at:number,summary:string,surface:string}[], stale:boolean, skipped:number, error:string|null}}
 */
export function buildContextItems(snapshot, { now = Date.now(), cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  if (snapshot === null || typeof snapshot !== 'object') {
    return { items: [], stale: false, skipped: 0, error: snapshot === null ? 'snapshot-unavailable' : 'snapshot-invalid' }
  }
  const updatedAt = Number(snapshot.updatedAt)
  // 「快照是否还在同步」看 syncedAt（local-sync 最后一次成功写入），没有则退回 updatedAt。
  const syncedAt = Number(snapshot.syncedAt)
  const freshness = Number.isFinite(syncedAt) && syncedAt > 0 ? syncedAt : updatedAt
  const stale = Number.isFinite(freshness) && freshness > 0 && now - freshness > settings.staleAfterMinutes * 60000
  if (stale) return { items: [], stale: true, skipped: 0, error: null }
  const maxAgeMs = settings.maxAgeMinutes * 60000
  // 本机快照时间来自本机时钟，服务器时钟可能有几分钟偏差：超前不超过容忍值的仍视为有效（按「刚刚」处理），
  // 而不是当成非法事件丢掉（第一版就踩过：本机比服务器快 ~4.6 分钟，导致大部分事件被过滤）。
  const maxFutureMs = settings.clockSkewToleranceMinutes * 60000
  const events = Array.isArray(snapshot.events) ? snapshot.events : []
  const seen = new Set()
  const items = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.private === true) continue // boot 端已经过滤过，这里再兜一层
    const at = Number(event.at)
    const summary = clampText(event.summary, 160)
    if (!Number.isFinite(at) || at <= 0 || summary.length === 0) continue
    const age = now - at
    if (age < -maxFutureMs || age > maxAgeMs) continue
    if (seen.has(summary)) continue
    seen.add(summary)
    items.push({
      at,
      summary,
      surface: typeof event.surface === 'string' ? event.surface : 'unknown',
      label: SURFACE_LABEL[event.surface] ?? '本机',
    })
    if (items.length >= settings.contextMaxItems) break
  }
  items.sort((left, right) => right.at - left.at)
  return { items, stale: false, skipped: events.length - items.length, error: null }
}

// ---------------------------------------------------------------------------
// QQ 近期活动（qq-activity.log）
// ---------------------------------------------------------------------------

const ACTIVITY_LINE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(group|private):(\S+)\s+\[([^\]]*)\]\s+(.*)$/
const SEND_LINE = /工具统一发送：成功\s*(\d+)\s*\/\s*(\d+)\s*条/

/**
 * 解析一行 qq-activity.log；非「入站消息 / 统一发送」行返回 null。
 * 日志只有 HH:MM:SS（无日期）：若解析出的时刻比 now 晚 5 分钟以上，视为昨天。
 */
export function parseActivityLine(line, now = Date.now()) {
  if (typeof line !== 'string') return null
  const match = ACTIVITY_LINE.exec(line.trim())
  if (match === null) return null
  const [, hh, mm, ss, chat, chatId] = match
  const body = match[7]
  const at = new Date(now)
  at.setHours(Number(hh), Number(mm), Number(ss), 0)
  let timestamp = at.getTime()
  if (timestamp > now + 5 * 60 * 1000) timestamp -= 24 * 60 * 60 * 1000
  const send = SEND_LINE.exec(body)
  if (send) {
    return { at: timestamp, chat, chatId, key: `${chat}:${chatId}`, kind: 'out', count: Math.max(1, Number(send[1]) || 1), text: '' }
  }
  if (body.startsWith('消息已入未读')) {
    return { at: timestamp, chat, chatId, key: `${chat}:${chatId}`, kind: 'in', count: 1, text: body.replace(/^消息已入未读[:：]\s*/, '') }
  }
  return null
}

// ---------------------------------------------------------------------------
// QQ 双向消息原文预览（social-v2.json，T17）
//
// social-v2 结构：{ conversations: { "private:test-chat": { recentMessages: [...] }, "group:test-group": {...} } }
// 每条消息：{ sender, text|plain, isSelf(自己=鲸歌), isOwner(主人), time(ms), ... }
// 预览约定（与 bridge T18 /dashboard 对齐，逐字一致）：
//   · 私聊配对：`QQ 私聊 HH:MM 你：「<来信>」→ 我：「<鲸歌回复>」`
//   · 群聊配对：`QQ 群聊 HH:MM <sender>：「<群消息>」→ 我：「<鲸歌回复>」`
//   · 单边：只写有的那一侧（`你：…` / `我：…`）
//   · 整行硬上限 60 字（JS String.length；中文=1、emoji=2）
// ---------------------------------------------------------------------------

/** 纯占位文本（[图片]/[表情]…）：选消息时优先跳过，避免预览只有占位符。 */
const MEDIA_PLACEHOLDER = /^\[[^\]]{0,8}(图片|表情|语音|视频|文件|动画表情|转发)[^\]]{0,8}\]$/

const stripEllipsis = (text) => (text.endsWith('…') ? text.slice(0, -1) : text)

/** 拆 conversation key（`group:test-group` / `private:test-chat`）。 */
export function splitChatKey(key) {
  const text = String(key ?? '')
  const index = text.indexOf(':')
  if (index <= 0 || index >= text.length - 1) return null
  return { chat: text.slice(0, index), chatId: text.slice(index + 1) }
}

/**
 * 收集一个 social-v2 会话里最近 windowMinutes 内可读消息（按时间升序）。
 * @returns {{time:number,text:string,isSelf:boolean,isOwner:boolean,sender:string,placeholder:boolean}[]}
 */
export function collectSocialMessages(conversation, { now = Date.now(), cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  const windowMs = Math.max(1, Number(settings.qqWindowMinutes) || 90) * 60000
  const messages = Array.isArray(conversation?.recentMessages) ? conversation.recentMessages : []
  const items = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const time = Number(message.time)
    if (!Number.isFinite(time) || time <= 0) continue
    const age = now - time
    if (age > windowMs) continue
    if (age < -15 * 60 * 1000) continue // 极端时钟偏差：未来太远的事件忽略
    const raw = typeof message.text === 'string' && message.text.trim().length > 0
      ? message.text
      : typeof message.plain === 'string'
        ? message.plain
        : ''
    const text = clampText(raw, 200)
    if (text.length === 0) continue
    items.push({
      time,
      text,
      isSelf: message.isSelf === true,
      isOwner: message.isOwner === true,
      sender: typeof message.sender === 'string' ? message.sender.trim() : '',
      placeholder: MEDIA_PLACEHOLDER.test(text),
    })
  }
  items.sort((left, right) => left.time - right.time)
  return items
}

/** 从列表里取「最近一条」；优先非占位文本，找不到再退回最后一条。 */
function latestReadable(items) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].placeholder !== true) return items[index]
  }
  return items.length > 0 ? items[items.length - 1] : null
}

/**
 * 配对规则：A=最近一条非 self 消息，B=最近一条 self 消息；
 * 仅当 B.time > A.time（她真的回了）才配对，否则只渲染 A；没有 A 但有 B 时只渲染 B。
 * @returns {{incoming:object|null, self:object|null, paired:boolean}|null}
 */
export function pickPreviewPair(items, { includeSelf = true } = {}) {
  // 防御性排序：调用方传未排序列表也能得到稳定结果（bridge T18 复用同一函数）
  const list = (Array.isArray(items) ? [...items] : []).sort((left, right) => Number(left.time) - Number(right.time))
  const incoming = latestReadable(list.filter((item) => item.isSelf !== true))
  const self = includeSelf ? latestReadable(list.filter((item) => item.isSelf === true)) : null
  if (incoming !== null && self !== null && self.time > incoming.time) {
    return { incoming, self, paired: true }
  }
  if (incoming !== null) return { incoming, self: null, paired: false }
  if (self !== null) return { incoming: null, self, paired: false }
  return null
}

/** 单边行：prefix + 正文 + 」；整行超限时从正文尾部逐字缩（补 …），缩到最小仍超则返回 null。 */
function truncateSingle(prefix, text, { maxChars, maxText, minText }) {
  let body = clampText(text, maxText)
  const build = () => `${prefix}${body}」`
  if (build().length <= maxChars) return build()
  const minBase = Math.max(1, Math.min(minText, stripEllipsis(body).length))
  while (build().length > maxChars) {
    const base = stripEllipsis(body)
    if (base.length <= minBase) return null
    body = `${base.slice(0, base.length - 1)}…`
  }
  return build()
}

/** 配对行：缩「较长的那段」直到整行 ≤ maxChars；两段都到最小仍超 → 丢回复段退化为单边。 */
function truncatePaired(prefix, separator, askText, answerText, { maxChars, maxText, minText }) {
  let ask = clampText(askText, maxText)
  let answer = clampText(answerText, maxText)
  const build = () => `${prefix}${ask}${separator}${answer}」`
  if (build().length <= maxChars) return build()
  for (let guard = 0; guard < 400; guard += 1) {
    if (build().length <= maxChars) return build()
    const askBase = stripEllipsis(ask).length
    const answerBase = stripEllipsis(answer).length
    const askMin = Math.max(1, Math.min(minText, askBase))
    const answerMin = Math.max(1, Math.min(minText, answerBase))
    // 较长的那段先缩；等长时先缩回复段（保证「你」的原文优先保留）
    if (answerBase >= askBase && answerBase > answerMin) {
      answer = `${stripEllipsis(answer).slice(0, answerBase - 1)}…`
      continue
    }
    if (askBase > askMin) {
      ask = `${stripEllipsis(ask).slice(0, askBase - 1)}…`
      continue
    }
    return truncateSingle(prefix, askText, { maxChars, maxText, minText })
  }
  return null
}

/**
 * 原子预览行构造（私聊/群聊、单边/配对、60 字硬上限）。
 * @param {{chat:'private'|'group', sender?:string, incoming?:object|null, self?:object|null, cfg?:object}} input
 * @returns {string|null}
 */
export function formatPreviewLine({ chat, sender = '', incoming = null, self = null, cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  if (chat !== 'private' && chat !== 'group') return null
  const includeSelf = settings.qqPreviewIncludeSelf === true
  const ask = incoming !== null && typeof incoming?.text === 'string' && incoming.text.length > 0 ? incoming : null
  const answer = includeSelf && self !== null && typeof self?.text === 'string' && self.text.length > 0 ? self : null
  if (ask === null && answer === null) return null
  const label = chat === 'private' ? 'QQ 私聊' : 'QQ 群聊'
  const role = chat === 'private' ? '你' : String(sender || '').trim() || '群友'
  const limits = {
    maxChars: Math.max(20, Number(settings.qqPreviewLineMaxChars) || 60),
    maxText: Math.max(4, Number(settings.qqPreviewMaxChars) || 60),
    minText: Math.max(1, Number(settings.qqPreviewMinTextChars) || 4),
  }
  if (ask !== null && answer !== null) {
    const clock = formatClock(Math.min(ask.time, answer.time))
    const prefix = `${label} ${clock} ${role}：「`
    const paired = truncatePaired(prefix, '」→ 我：「', ask.text, answer.text, limits)
    return paired !== null ? paired : truncateSingle(prefix, ask.text, limits)
  }
  const only = ask ?? answer
  const clock = formatClock(only.time)
  const onlyRole = ask !== null ? role : '我'
  return truncateSingle(`${label} ${clock} ${onlyRole}：「`, only.text, limits)
}

/**
 * 从 social-v2 生成预览行（白名单 / 排序 / 总数上限）。
 * 私聊行优先，其次群聊行；同类型按最新消息时间降序。
 * @returns {{lines:string[], source:'social-v2'|'none', entries:object[]}}
 */
export function buildQqPreview({ social, now = Date.now(), cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  const conversations = social?.conversations
  if (conversations === null || typeof conversations !== 'object' || Array.isArray(conversations)) {
    return { lines: [], source: 'none', entries: [] }
  }
  const privateAllow = Array.isArray(settings.qqPreviewChats) ? settings.qqPreviewChats.map(String) : []
  const allowGroup = settings.qqPreviewGroup === true
  const groupAllow = settings.qqPreviewGroups === 'all'
    ? 'all'
    : Array.isArray(settings.qqPreviewGroups)
      ? settings.qqPreviewGroups.map(String)
      : []
  const includeSelf = settings.qqPreviewIncludeSelf === true
  const maxItems = Math.max(1, Number(settings.qqPreviewMaxItems) || 4)
  const entries = []
  for (const [key, conversation] of Object.entries(conversations)) {
    const parsedKey = splitChatKey(key)
    if (parsedKey === null) continue
    if (parsedKey.chat === 'private') {
      if (privateAllow.length > 0 && !privateAllow.includes(key)) continue
    } else if (parsedKey.chat === 'group') {
      if (!allowGroup) continue
      if (groupAllow !== 'all' && !groupAllow.includes(key)) continue
    } else {
      continue
    }
    const items = collectSocialMessages(conversation, { now, cfg: settings })
    if (items.length === 0) continue
    const pair = pickPreviewPair(items, { includeSelf })
    if (pair === null) continue
    const line = formatPreviewLine({
      chat: parsedKey.chat,
      sender: pair.incoming?.sender ?? '',
      incoming: pair.incoming,
      self: includeSelf ? pair.self : null,
      cfg: settings,
    })
    if (line === null) continue
    entries.push({
      key,
      chat: parsedKey.chat,
      line,
      lastTime: Math.max(pair.incoming?.time ?? 0, pair.self?.time ?? 0),
    })
  }
  entries.sort((left, right) => {
    if (left.chat !== right.chat) return left.chat === 'private' ? -1 : 1
    return right.lastTime - left.lastTime
  })
  const kept = entries.slice(0, maxItems)
  return { lines: kept.map((entry) => entry.line), source: kept.length > 0 ? 'social-v2' : 'none', entries: kept }
}

/** 统计 activity 日志里的收发（social-v2 不可用时的回退数据源）。 */
function collectActivity(lines, now, settings) {
  const windowMs = settings.qqWindowMinutes * 60000
  const outbound = []
  const inbound = []
  for (const line of lines) {
    const parsed = parseActivityLine(line, now)
    if (parsed === null) continue
    const age = now - parsed.at
    if (age < 0 || age > windowMs) continue
    if (parsed.kind === 'out') outbound.push(parsed)
    else inbound.push(parsed)
  }
  outbound.sort((left, right) => right.at - left.at)
  inbound.sort((left, right) => right.at - left.at)
  return { outbound, inbound, lastAt: Math.max(...[...outbound, ...inbound].map((item) => item.at), 0) || null }
}

/** activity 日志回退摘要（social-v2 读不到时沿用改造前行为，不回归旧的 20 字实现）。 */
function buildActivityQqSummary({ lines = [], now = Date.now(), cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  const { outbound, inbound, lastAt } = collectActivity(lines, now, settings)
  const items = []
  const previewTypes = Array.isArray(settings.qqPreviewChatTypes) ? settings.qqPreviewChatTypes : ['private']
  const previewChats = Array.isArray(settings.qqPreviewChats) ? settings.qqPreviewChats : []
  const canPreview = (parsed) => {
    if (!settings.qqIncludePreview) return false
    if (!previewTypes.includes(parsed.chat)) return false
    if (parsed.chat === 'group' && settings.qqPreviewGroup !== true) return false
    if (previewChats.length > 0 && !previewChats.includes(parsed.key ?? `${parsed.chat}:${parsed.chatId}`)) return false
    return typeof parsed.text === 'string' && parsed.text.trim().length > 0
  }
  if (outbound.length > 0) {
    const total = outbound.reduce((sum, item) => sum + item.count, 0)
    const chat = outbound[0].chat === 'group' ? '群聊' : '私聊'
    items.push(`鲸歌 ${formatClock(outbound[0].at)} 在 QQ ${chat}回复过消息（${total} 条）`)
  }
  // 私聊：开启预览时给出最近 N 条主人原话（默认只允许配置的会话）；否则只报条数
  const privateIn = inbound.filter((item) => item.chat === 'private')
  const previewable = privateIn.filter(canPreview)
  if (previewable.length > 0) {
    for (const item of previewable.slice(0, Math.max(1, settings.qqPreviewMaxItems))) {
      items.push(`QQ 私聊 ${formatClock(item.at)} 主人说：「${clampText(item.text, settings.qqPreviewMaxChars)}」`)
    }
    const rest = privateIn.length - Math.min(privateIn.length, previewable.length)
    if (rest > 0) items.push(`QQ 私聊另有 ${rest} 条新消息未展开`)
  } else if (privateIn.length > 0) {
    items.push(`QQ 私聊最近有 ${privateIn.length} 条新消息（${formatClock(privateIn[0].at)}）`)
  }
  // 群聊：默认只报条数；开启 qqPreviewGroup 时附一句最近群消息
  const groupIn = inbound.filter((item) => item.chat === 'group')
  if (groupIn.length > 0) {
    const latest = groupIn.filter(canPreview)[0]
    const preview = latest ? `，最近「${clampText(latest.text, settings.qqPreviewMaxChars)}」` : ''
    items.push(`QQ 群聊最近有 ${groupIn.length} 条新消息（${formatClock(groupIn[0].at)}${preview}）`)
  }
  const lastAtValue = Math.max(...[...outbound, ...inbound].map((item) => item.at), 0) || null
  return { items: items.slice(0, settings.qqMaxItems), outbound: outbound.length, inbound: inbound.length, lastAt: lastAtValue, source: 'activity' }
}

/**
 * QQ 近况：优先 social-v2 双向原文预览（私聊/群聊 + 鲸歌回复原文）；
 * social-v2 读不到/无可用会话时回退 activity 日志计数摘要。
 * @returns {{items:string[], outbound:number, inbound:number, lastAt:number|null, source:'social-v2'|'activity'}}
 */
export function buildQqSummary({ lines = [], social = null, now = Date.now(), cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  const preview = buildQqPreview({ social, now, cfg: settings })
  if (preview.lines.length > 0) {
    const activity = collectActivity(lines, now, settings)
    return {
      items: preview.lines.slice(0, Math.max(1, Number(settings.qqPreviewMaxItems) || 4)),
      outbound: activity.outbound.length,
      inbound: activity.inbound.length,
      lastAt: preview.entries.reduce((max, entry) => Math.max(max, entry.lastTime), activity.lastAt ?? 0) || null,
      source: 'social-v2',
    }
  }
  return buildActivityQqSummary({ lines, now, cfg: settings })
}

// ---------------------------------------------------------------------------
// T20：跨端对话连续性（本机/面板最近对话 + QQ 最近对话原文）
//
// 这一段放在注入块最前面，用于「在 QQ 说一句 → 本机 Coo/面板接着聊，或反过来」。
// 数据来源（全部只读）：
//   · panel      ← shared-awareness.json.dialogue（local-sync 从 bridge /history 拉的本机/面板对话）
//   · qq-private ← social-v2.json conversations['private:<owner>'].recentMessages（双向，isSelf 区分）
//   · qq-group   ← social-v2.json conversations['group:<id>'].recentMessages（双向，含 sender 昵称）
// 规则：每个来源最多取最近 dialogueSourceMaxItems 条 → 跨来源按时间升序 → 只留最近 dialogueMaxItems 行
//       → 整段（含 header）≤ dialogueMaxChars 字（超了从最旧的行开始丢）→ 每行正文 ≤ dialogueTextMaxChars 字。
// ---------------------------------------------------------------------------

export const DIALOGUE_HEADER =
  '【最近跨端对话（可能来自另一个窗口；用于自然接话，不要复述来源、不要逐条引用）】'

/** 每个来源取最近 N 条（输入需按时间升序）。 */
function latestPerSource(items, cap) {
  return items.slice(-Math.max(1, cap))
}

/** 本机/面板 dialogue → 候选行。 */
function panelDialogueCandidates(dialogue, settings) {
  const messages = Array.isArray(dialogue?.messages) ? dialogue.messages : []
  const items = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const at = Number(message.at)
    const role = message.role === 'user' || message.role === 'assistant' ? message.role : null
    const text = clampText(message.text, settings.dialogueTextMaxChars)
    if (role === null || !Number.isFinite(at) || text.length === 0) continue
    items.push({ at, line: `- 本机/面板 · ${role === 'user' ? '你' : '鲸歌'}：「${text}」` })
  }
  items.sort((left, right) => left.at - right.at)
  return latestPerSource(items, settings.dialogueSourceMaxItems)
}

/** social-v2 单个会话 → 候选行（双向，isSelf 区分谁说的）。 */
function socialDialogueCandidates(conversation, surface, settings) {
  const messages = Array.isArray(conversation?.recentMessages) ? conversation.recentMessages : []
  const items = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const at = Number(message.time)
    if (!Number.isFinite(at) || at <= 0) continue
    const raw = typeof message.text === 'string' && message.text.trim() ? message.text : message.plain
    const text = clampText(raw, settings.dialogueTextMaxChars)
    if (text.length === 0) continue
    const isSelf = message.isSelf === true
    const sender = typeof message.sender === 'string' && message.sender.trim() ? message.sender.trim() : ''
    const label = surface === 'qq-group' ? (isSelf ? '鲸歌' : (sender || '群友')) : (isSelf ? '鲸歌' : '主人')
    items.push({ at, line: `- ${surface === 'qq-group' ? 'QQ群' : 'QQ私聊'} · ${label}：「${text}」` })
  }
  items.sort((left, right) => left.at - right.at)
  return latestPerSource(items, settings.dialogueSourceMaxItems)
}

/**
 * 生成「最近跨端对话」段（不含 header 的 lines；header 由 DIALOGUE_HEADER 提供）。
 * @returns {{lines:string[], chars:number, panel:number, qqPrivate:number, qqGroup:number}}
 */
export function buildDialogueItems({ dialogue = null, social = null, now = Date.now(), cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  const result = { lines: [], chars: 0, panel: 0, qqPrivate: 0, qqGroup: 0 }
  if (settings.dialogueInclude !== true) return result
  const surfaces = Array.isArray(settings.dialogueSurfaces) ? settings.dialogueSurfaces.map(String) : []
  const candidates = []
  if (surfaces.includes('panel')) {
    const items = panelDialogueCandidates(dialogue, settings)
    result.panel = items.length
    candidates.push(...items)
  }
  const conversations = social?.conversations
  if (conversations !== null && typeof conversations === 'object' && !Array.isArray(conversations)) {
    if (surfaces.includes('qq-private')) {
      const allowed = Array.isArray(settings.qqPreviewChats) ? settings.qqPreviewChats.map(String) : []
      for (const [key, conversation] of Object.entries(conversations)) {
        if (!key.startsWith('private:')) continue
        if (allowed.length > 0 && !allowed.includes(key)) continue
        const items = socialDialogueCandidates(conversation, 'qq-private', settings)
        result.qqPrivate += items.length
        candidates.push(...items)
      }
    }
    if (surfaces.includes('qq-group') && settings.qqPreviewGroup === true) {
      const groupAllow = settings.qqPreviewGroups === 'all'
        ? 'all'
        : Array.isArray(settings.qqPreviewGroups)
          ? settings.qqPreviewGroups.map(String)
          : []
      for (const [key, conversation] of Object.entries(conversations)) {
        if (!key.startsWith('group:')) continue
        if (groupAllow !== 'all' && !groupAllow.includes(key)) continue
        const items = socialDialogueCandidates(conversation, 'qq-group', settings)
        result.qqGroup += items.length
        candidates.push(...items)
      }
    }
  }
  if (candidates.length === 0) return result
  // 跨来源按时间升序，只保留最近 dialogueMaxItems 条
  candidates.sort((left, right) => left.at - right.at)
  let kept = candidates.slice(-Math.max(1, Number(settings.dialogueMaxItems) || 10))
  // 整段字符预算：header + lines ≤ dialogueMaxChars，超了从最旧的行开始丢
  const maxChars = Math.max(80, Number(settings.dialogueMaxChars) || 700)
  const render = () => `${DIALOGUE_HEADER}\n${kept.map((item) => item.line).join('\n')}`
  while (kept.length > 1 && render().length > maxChars) kept = kept.slice(1)
  let text = render()
  if (text.length > maxChars) {
    // 极端兜底：单行超长时直接截断（正常不会发生：每行 ≤ ~100 字）
    text = text.slice(0, maxChars)
    kept = kept.slice(0, 1)
  }
  result.lines = kept.map((item) => item.line)
  result.chars = text.length
  return result
}

// ---------------------------------------------------------------------------
// QQ 桥接状态（bridge.log，可选）
// ---------------------------------------------------------------------------

const BRIDGE_LOG_LINE = /^(\d{2}):(\d{2}):(\d{2})\s+\[bridge\]\s+(.*)$/

/** 从 bridge.log 尾部提取最近一条「DSH 已就绪 / 不可用」状态（10 分钟内）。 */
export function buildBridgeStatus({ lines = [], now = Date.now() } = {}) {
  let found = null
  for (const line of lines) {
    const match = BRIDGE_LOG_LINE.exec(String(line).trim())
    if (match === null) continue
    const body = match[4]
    let state = null
    if (body.includes('DSH 已就绪')) state = '已就绪'
    else if (body.includes('DSH 不可用')) state = '不可用（重连中）'
    if (state === null) continue
    const at = new Date(now)
    at.setHours(Number(match[1]), Number(match[2]), Number(match[3]), 0)
    let timestamp = at.getTime()
    if (timestamp > now + 5 * 60 * 1000) timestamp -= 24 * 60 * 60 * 1000
    if (found === null || timestamp >= found.at) found = { at: timestamp, state }
  }
  if (found === null) return null
  if (now - found.at > 10 * 60 * 1000) return null
  return `QQ 桥接：${found.state}（${formatClock(found.at)}）`
}

// ---------------------------------------------------------------------------
// 组装注入块
// ---------------------------------------------------------------------------

export const AWARENESS_HEADER =
  '【共享情境（本机 + QQ 自动同步；只作背景参考，不要逐条复述；' +
  '不要在群里或回复里透露本机窗口标题、路径、进程名等系统细节）】'

/**
 * 纯函数：拼注入块。无任何有效内容时返回空 text（调用方据此跳过）。
 * 结构（T20）：先「最近跨端对话」段（便于跨端接话），再「共享情境」段（本机情境 + QQ 预览 + 桥接状态）。
 * @returns {{text:string, chars:number, contextItems:number, qqItems:number, dialogueItems:number, qqSource:string, stale:boolean, reason:string}}
 */
export function buildAwarenessBlock({ contextSnapshot = null, contextError = null, qqLines = [], socialSnapshot = null, socialError = null, dialogueSnapshot = null, bridgeLines = [], now = Date.now(), cfg = {} } = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  const context = buildContextItems(contextSnapshot, { now, cfg: settings })
  const qq = buildQqSummary({ lines: qqLines, social: socialSnapshot, now, cfg: settings })
  const bridgeStatus = buildBridgeStatus({ lines: bridgeLines, now })
  const dialogue = buildDialogueItems({ dialogue: dialogueSnapshot, social: socialSnapshot, now, cfg: settings })
  const awarenessLines = []
  for (const item of context.items) awarenessLines.push(`- ${item.summary}（${relativeTime(item.at, now)}）`)
  for (const item of qq.items) awarenessLines.push(`- ${item}`)
  if (bridgeStatus !== null) awarenessLines.push(`- ${bridgeStatus}`)
  let dialogueLines = [...dialogue.lines]
  let awarenessKept = [...awarenessLines]
  const compose = () => {
    const parts = []
    if (dialogueLines.length > 0) parts.push(`${DIALOGUE_HEADER}\n${dialogueLines.join('\n')}`)
    if (awarenessKept.length > 0) parts.push(`${AWARENESS_HEADER}\n${awarenessKept.join('\n')}`)
    return parts.join('\n\n')
  }
  let text = compose()
  if (text.length === 0) {
    const reason = context.stale
      ? 'context-stale'
      : context.error !== null
        ? `context-${contextError ?? context.error}`
        : 'no-data'
    return {
      text: '',
      chars: 0,
      contextItems: 0,
      qqItems: 0,
      dialogueItems: 0,
      qqSource: qq.source,
      stale: context.stale,
      reason,
    }
  }
  // 超字符预算：先裁「共享情境」尾部（保留最前面的跨端对话段，便于接话），再裁对话最旧行
  while (text.length > settings.blockMaxChars && awarenessKept.length > 0) {
    awarenessKept.pop()
    text = compose()
  }
  while (text.length > settings.blockMaxChars && dialogueLines.length > 1) {
    dialogueLines.shift()
    text = compose()
  }
  if (text.length > settings.blockMaxChars) text = text.slice(0, settings.blockMaxChars)
  const contextItems = Math.min(context.items.length, awarenessKept.length)
  return {
    text,
    chars: text.length,
    contextItems,
    qqItems: Math.min(qq.items.length, Math.max(0, awarenessKept.length - contextItems)),
    dialogueItems: dialogueLines.length,
    qqSource: qq.source,
    stale: context.stale,
    reason: 'ok',
  }
}

// ---------------------------------------------------------------------------
// 带缓存的 builder（插件每轮调用一次）
// ---------------------------------------------------------------------------

export function createBlockBuilder(cfg = {}) {
  const settings = { ...DEFAULTS, ...cfg }
  const cache = new Map()
  let lastKey = ''
  let lastLogAt = 0
  return {
    cache,
    cfg: settings,
    /** @param {{agentId?:string}} [options] */
    build(options = {}) {
      const now = Date.now()
      const agentId = String(options.agentId ?? '')
      let block
      try {
        const contextEntry = readJsonCached(settings.contextFile, cache)
        // QQ 相关输入默认关闭（空字符串）：不读文件、不注入 QQ 段，只有部署者显式配置才启用
        const qqEntry = settings.qqActivityFile
          ? readTailCached(settings.qqActivityFile, cache, { maxLines: settings.qqTailLines })
          : { lines: [] }
        const socialEntry = settings.socialFile
          ? readJsonCached(settings.socialFile, cache)
          : { value: null, error: null }
        const bridgeEntry = settings.bridgeLogFile
          ? readTailCached(settings.bridgeLogFile, cache, { maxLines: 20 })
          : { lines: [] }
        block = buildAwarenessBlock({
          contextSnapshot: contextEntry.value,
          contextError: contextEntry.error,
          qqLines: qqEntry.lines,
          socialSnapshot: socialEntry.value,
          socialError: socialEntry.error,
          // T20：本机/面板最近对话（local-sync 写入快照的 dialogue 字段）
          dialogueSnapshot: contextEntry.value?.dialogue ?? null,
          bridgeLines: bridgeEntry.lines,
          now,
          cfg: settings,
        })
      } catch (error) {
        // 理论上走不到（内部全 try/catch），这里再兜一层：任何异常都不注入
        return { text: '', chars: 0, contextItems: 0, qqItems: 0, dialogueItems: 0, qqSource: 'none', stale: false, reason: `build-error:${String(error?.message ?? error)}` }
      }
      const key = `${agentId}|${block.chars}|${block.contextItems}|${block.qqItems}|${block.dialogueItems}|${block.stale}|${block.reason}|${block.qqSource}`
      if (key !== lastKey || now - lastLogAt > settings.logThrottleMs) {
        lastKey = key
        lastLogAt = now
        if (block.text.length > 0) {
          log(`inject agent=${agentId || '(unknown)'} chars=${block.chars} dialogue=${block.dialogueItems} localItems=${block.contextItems} qqItems=${block.qqItems} qqSrc=${block.qqSource}${block.stale ? ' localStale=1' : ''}`)
        } else {
          log(`skip inject agent=${agentId || '(unknown)'} reason=${block.reason} qqSrc=${block.qqSource}`)
        }
      }
      return block
    },
  }
}
