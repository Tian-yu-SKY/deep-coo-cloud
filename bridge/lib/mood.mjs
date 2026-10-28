// dsh-link/bridge/lib/mood.mjs — 只读心情派生（Phase 3B）。
//
// 数据源：服务器 deep-soul `~/.dsh/deep-soul/mind.db`（SQLite WAL）。
// 安全：**绝不直接打开/写服务器 DB**。每次刷新经 SSH：
//   1) 把 mind.db + -wal + -shm 复制到服务器 /tmp/dsh-link-mood-<rand>.db*
//   2) 在副本上以 python3 sqlite3 只读查询（file:...?mode=ro）
//   3) 立即删除 /tmp 副本
// 派生公式（无现成 mood 表，按 task-8 规则）：
//   valence = Σ(valence_i × affect_w_i × decay_i) / Σ(affect_w_i × decay_i)   （active 节点）
//   arousal 同理；decay = 0.5 ^ (age / 半衰期)，半衰期默认 7 天，age 用 last_hit（缺失用 created_at）
//   label：valence>0.25 开心 / <-0.25 低落 / 其余平静；arousal>0.5 附「有精神」、<0.2 附「懒洋洋」
// 表结构来源（服务器 mindcore/store.py，只读核对）：
//   nodes(id, uid, region, kind, text, valence REAL, arousal REAL, affect_w REAL NOT NULL,
//         belief_w, created_at REAL(s), last_hit REAL(s), ..., status TEXT='active', valid_to REAL)
//   self_snapshots(day TEXT PRIMARY KEY, text TEXT NOT NULL, vec BLOB)
import { randomBytes } from 'node:crypto';
import { shQuote } from './ssh.mjs';

export const MOOD_SOURCE = 'deep-soul:mind.db(readonly)';
export const DEFAULT_HALF_LIFE_DAYS = 7;
const DAY_MS = 86400000;

/** 在服务器副本上运行的只读 python 读取器；打印一行 `__MOOD__{json}`。 */
export const MOOD_READER_PY = String.raw`
import sqlite3, json, os, time

def read():
    db = os.environ['MOOD_DB']
    con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    out = {'ok': True, 'source': 'deep-soul:mind.db(readonly)'}
    tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    node_cols = [r[1] for r in cur.execute('PRAGMA table_info(nodes)')]
    out['nodeColumns'] = node_cols
    out['tables'] = tables
    missing = [c for c in ('valence', 'arousal', 'affect_w') if c not in node_cols]
    if 'nodes' not in tables or missing:
        out['ok'] = False
        out['error'] = 'nodes 表/列缺失: missing=%s tables=%s' % (missing, tables)
        return out
    now = time.time()
    selected = ['valence', 'arousal', 'affect_w', 'status']
    for optional in ('last_hit', 'created_at', 'valid_to'):
        if optional in node_cols:
            selected.append(optional)
    rows = [dict(r) for r in cur.execute('SELECT %s FROM nodes' % ','.join(selected))]
    out['rows'] = rows
    out['rowCount'] = len(rows)
    try:
        if 'valid_to' in node_cols:
            out['memoryCount'] = cur.execute(
                "SELECT COUNT(*) FROM nodes WHERE status='active' AND (valid_to IS NULL OR valid_to > ?)",
                (now,)).fetchone()[0]
        else:
            out['memoryCount'] = cur.execute(
                "SELECT COUNT(*) FROM nodes WHERE status='active'").fetchone()[0]
    except Exception as e:
        out['memoryCount'] = None
        out['memoryCountError'] = str(e)
    try:
        if 'self_snapshots' in tables:
            row = cur.execute('SELECT day, text FROM self_snapshots ORDER BY day DESC LIMIT 1').fetchone()
            if row is not None:
                out['selfNote'] = row['text']
                out['selfNoteDay'] = row['day']
    except Exception as e:
        out['selfNoteError'] = str(e)
    try:
        out['dbBytes'] = os.path.getsize(db)
    except Exception:
        out['dbBytes'] = None
    out['now'] = now
    return out

try:
    result = read()
except Exception as e:
    result = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
print('__MOOD__' + json.dumps(result, ensure_ascii=False))
`;

const asNumber = (value) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 3) => Number(value.toFixed(digits));

/** 服务器时间戳可能是秒或毫秒；统一成毫秒。 */
export function toMillis(value) {
  const number = asNumber(value);
  if (number === null || number <= 0) return null;
  return number > 1e12 ? Math.round(number) : Math.round(number * 1000);
}

function isActiveWithin(row, nowMs) {
  const status = String(row?.status ?? 'active').toLowerCase();
  if (status && status !== 'active') return false;
  const validTo = toMillis(row?.valid_to);
  if (validTo !== null && validTo <= nowMs) return false;
  return true;
}

/**
 * 由节点行派生心情（纯函数，便于单测）。
 * @param {object} input
 * @param {Array<object>} input.rows nodes 行（来自 MOOD_READER_PY）
 * @param {string|null} input.selfNote 最新 self_snapshots.text
 * @param {number|null} input.memoryCount DB 侧 active 节点计数（缺省用过滤后行数）
 * @param {number} input.now 当前 epoch ms
 * @param {number} input.halfLifeDays 时间衰减半衰期（天）
 */
export function computeMood({
  rows = [],
  selfNote = null,
  memoryCount = null,
  now = Date.now(),
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
} = {}) {
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const halfLifeMs = Math.max(0.1, Number(halfLifeDays) || DEFAULT_HALF_LIFE_DAYS) * DAY_MS;
  let weightSum = 0;
  let valenceSum = 0;
  let arousalSum = 0;
  let latestTouchMs = 0;
  let activeRows = 0;
  let nonZeroValence = 0;
  let nonZeroArousal = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (!isActiveWithin(row, nowMs)) continue;
    const affectW = asNumber(row.affect_w);
    if (affectW === null || affectW <= 0) continue;
    const valence = clamp(asNumber(row.valence) ?? 0, -1, 1);
    const arousal = clamp(asNumber(row.arousal) ?? 0, 0, 1);
    if (valence !== 0) nonZeroValence += 1;
    if (arousal !== 0) nonZeroArousal += 1;
    const touchedMs = toMillis(row.last_hit) ?? toMillis(row.created_at);
    if (touchedMs !== null && touchedMs > latestTouchMs) latestTouchMs = touchedMs;
    const ageMs = touchedMs === null ? 0 : Math.max(0, nowMs - touchedMs);
    const decay = Math.pow(0.5, ageMs / halfLifeMs);
    const weight = affectW * decay;
    if (!(weight > 0)) continue;
    activeRows += 1;
    weightSum += weight;
    valenceSum += valence * weight;
    arousalSum += arousal * weight;
  }

  const valence = weightSum > 0 ? clamp(valenceSum / weightSum, -1, 1) : 0;
  const arousal = weightSum > 0 ? clamp(arousalSum / weightSum, 0, 1) : 0;
  // 没有任何可用记忆节点时按中性处理（避免 arousal=0 被误判成「懒洋洋」）。
  const hasData = weightSum > 0;
  const energy = !hasData ? '平常' : arousal > 0.5 ? '有精神' : arousal < 0.2 ? '懒洋洋' : '平常';
  const baseLabel = valence > 0.25 ? '开心' : valence < -0.25 ? '低落' : '平静';
  const label = !hasData || energy === '平常' ? baseLabel : `${baseLabel}·${energy}`;

  return {
    label,
    valence: round(valence),
    arousal: round(arousal),
    energy,
    memoryCount: Number.isFinite(memoryCount) ? memoryCount : activeRows,
    selfNote: selfNote ?? null,
    updatedAt: latestTouchMs > 0 ? latestTouchMs : nowMs,
    source: MOOD_SOURCE,
    // 诊断用（不改变客户端的核心字段）：解释数值来源
    stats: {
      activeRows,
      rowCount: rows.length,
      weightSum: round(weightSum, 4),
      valenceSum: round(valenceSum, 4),
      arousalSum: round(arousalSum, 4),
      nonZeroValence,
      nonZeroArousal,
      halfLifeDays: Number(halfLifeDays) || DEFAULT_HALF_LIFE_DAYS,
    },
  };
}

/** 构造「复制 DB 到 /tmp → 只读查询 → 删除副本」的远程 shell 命令（不含秘密，可日志）。 */
export function buildMoodRefreshCommand(dbPath) {
  const encoded = Buffer.from(MOOD_READER_PY, 'utf8').toString('base64');
  const tmp = `/tmp/dsh-link-mood-${randomBytes(6).toString('hex')}.db`;
  const quoted = shQuote(dbPath);
  return [
    `TMP=${tmp}`,
    `cp ${quoted} "$TMP"`,
    `for s in -wal -shm; do [ -f ${quoted}$s ] && cp ${quoted}$s "$TMP$s"; done`,
    `echo ${encoded} | base64 -d | MOOD_DB="$TMP" python3 -`,
    'rm -f "$TMP" "$TMP-wal" "$TMP-shm"',
  ].join('; ');
}

/** 从 SSH 输出里取出 `__MOOD__{json}` 并解析。 */
export function parseMoodReaderOutput(output) {
  const line = String(output ?? '').split('\n').find((item) => item.startsWith('__MOOD__'));
  if (!line) throw new Error(`mood reader 无输出（${String(output ?? '').slice(0, 200)}）`);
  const payload = JSON.parse(line.slice('__MOOD__'.length));
  if (!payload || payload.ok !== true) throw new Error(`mood DB 解析失败: ${payload?.error ?? 'unknown error'}`);
  return payload;
}

/**
 * 心情监视器：每 moodIntervalMs 经 SSH 刷新一次；失败 mood=null（不影响聊天）。
 * 只读保证：所有查询都在服务器 /tmp 的 DB 副本上执行，原库只被 cp 读取。
 */
export class MoodMonitor {
  constructor({ ssh, cfg, log }) {
    this.ssh = ssh;
    this.cfg = cfg;
    this.log = log;
    this.intervalMs = Math.max(5000, Number(cfg.moodIntervalMs) || 60000);
    this.timeoutMs = Math.max(5000, Number(cfg.moodTimeoutMs) || 45000);
    this.halfLifeDays = Number(cfg.moodHalfLifeDays) || DEFAULT_HALF_LIFE_DAYS;
    this.dbPath = typeof cfg.mindDbPath === 'string' ? cfg.mindDbPath : '';
    // 未配置 mindDbPath = 心情功能关闭（分发版默认不访问任何私有 DB）
    this.enabled = cfg.moodEnabled !== false && Boolean(this.dbPath);
    this._mood = null;
    this._timer = null;
    this._refreshing = null;
    this._meta = {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      lastRefreshAt: null,
      lastSuccessAt: null,
      tookMs: null,
      lastError: null,
      nodeRows: null,
      memoryCount: null,
      nodeColumns: null,
      selfNoteDay: null,
      dbBytes: null,
      source: MOOD_SOURCE,
    };
  }

  get mood() {
    return this._mood;
  }

  /** 诊断信息（/diagnostics 用）。 */
  get info() {
    return { mood: this._mood, ...this._meta };
  }

  start() {
    if (!this.enabled || this._timer) return;
    this.log.info(`mood monitor 启动: interval=${this.intervalMs}ms halfLife=${this.halfLifeDays}d db=${this.dbPath}`);
    this.refresh().catch(() => { /* refresh 内部已处理 */ });
    this._timer = setInterval(() => {
      this.refresh().catch(() => { /* ignore */ });
    }, this.intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** 立即刷新一次（并发调用复用同一个 Promise）。 */
  refresh() {
    if (!this.enabled) return Promise.resolve(null);
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _doRefresh() {
    const startedAt = Date.now();
    try {
      const payload = await this._readRemote();
      const nowMs = payload.now ? Math.round(Number(payload.now) * 1000) : Date.now();
      const mood = computeMood({
        rows: payload.rows ?? [],
        selfNote: payload.selfNote ?? null,
        memoryCount: payload.memoryCount ?? null,
        now: nowMs,
        halfLifeDays: this.halfLifeDays,
      });
      this._mood = mood;
      Object.assign(this._meta, {
        lastRefreshAt: Date.now(),
        lastSuccessAt: Date.now(),
        tookMs: Date.now() - startedAt,
        lastError: null,
        nodeRows: payload.rowCount ?? (payload.rows ?? []).length,
        memoryCount: mood.memoryCount,
        nodeColumns: payload.nodeColumns ?? null,
        selfNoteDay: payload.selfNoteDay ?? null,
        dbBytes: payload.dbBytes ?? null,
      });
      this.log.info(`mood 刷新: label=${mood.label} valence=${mood.valence} arousal=${mood.arousal} memoryCount=${mood.memoryCount} took=${Date.now() - startedAt}ms`);
      return mood;
    } catch (error) {
      this._mood = null;
      Object.assign(this._meta, {
        lastRefreshAt: Date.now(),
        tookMs: Date.now() - startedAt,
        lastError: error.message,
      });
      this.log.warn(`mood 刷新失败（不影响聊天）: ${error.message}`);
      return null;
    }
  }

  async _readRemote() {
    const command = buildMoodRefreshCommand(this.dbPath);
    const output = await this.ssh.capture(command, { timeoutMs: this.timeoutMs });
    return parseMoodReaderOutput(output);
  }
}
