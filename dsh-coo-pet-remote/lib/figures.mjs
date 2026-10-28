/**
 * 形象包(figure pack)的发现与导入。
 *
 * 一个 pack = 一个含 `figure.json` 的目录(页面 `/api/figures` 靠它列出形象、
 * 换装页靠它的 `axes`/`presets` 渲染选项,桌宠 body 按 `base + entry` 加载)。
 *
 * 三类来源:
 *   1. Coopanion 自带的 `web/whale`、`web/coo` —— 随 `ensureAssets` 整个 `web/` 复制到我们的数据目录;
 *   2. 用户自己装的包:`<Coopanion data>/figures/<id>` 与 `<插件 dataDir>/figures/<id>`(只读复制);
 *   3. Steam Workshop 等额外根:配置 `packsExtraDirs`(Coopanion 自己的 `COOPANION_PACK_ROOTS` 格式是
 *      路径分隔符分隔的多个根,impl.js 会把环境变量里的根也加进来)。
 *
 * 导入规则(**保守**,不阻塞启动):
 *   - 只在 `web/<packId>` 不存在时复制,已有就不动(避免覆盖换装页里已经生效的副本);
 *   - `packId` 取 `figure.json` 的 `id`(不合法的回退目录名,再不合法跳过);
 *   - 任何一个包出错只记 problem,不影响其它包,也不影响桌宠启动。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const FIGURE_FILE = 'figure.json';
/** 与页面 `normalizeSkin` 接受的 figure id 同一个规则(web/coo/coo.js 的 FIGURE_ID)。 */
export const FIGURE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 读一个目录里的 figure.json;没有/坏掉返回 null(调用方决定是跳过还是记 problem)。 */
export function readFigureManifest(dir) {
  const file = join(dir, FIGURE_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 把 figure.json 规整成页面/我们的设置逻辑都认的形状(字段都做防御)。 */
export function normalizeManifest(raw, { dir, base }) {
  const axes = (Array.isArray(raw?.axes) ? raw.axes : [])
    .filter((axis) => axis && typeof axis.id === 'string' && Array.isArray(axis.options))
    .map((axis) => ({
      ...axis,
      options: axis.options.filter((option) => option && typeof option.id === 'string'),
    }))
    .filter((axis) => axis.options.length > 0);
  const presets = (Array.isArray(raw?.presets) ? raw.presets : [])
    .filter((preset) => preset && typeof preset.id === 'string');
  const id = typeof raw?.id === 'string' && FIGURE_ID.test(raw.id) ? raw.id : null;
  return {
    id: id ?? dir,
    // 页面用 base + entry / base + thumb / base + option.thumb,所以 base 指向**实际目录**
    base,
    name: raw?.name ?? id ?? dir,
    thumb: typeof raw?.thumb === 'string' ? raw.thumb : null,
    entry: typeof raw?.entry === 'string' ? raw.entry : 'figure.js',
    export: typeof raw?.export === 'string' ? raw.export : 'createBody',
    model: raw?.model ?? null,
    axes,
    presets,
    // 形象「会说的词」:页面 body-host 直接 `.map(w => w.id)`,必须原样透传(上游踩过 undefined 崩页面)
    vocab: Array.isArray(raw?.vocab) ? raw.vocab : [],
    version: raw?.version ?? null,
    about: raw?.about ?? null,
    sounds: raw?.sounds,
    voice: raw?.voice,
  };
}

/**
 * 扫描 `webDir` 下所有含 figure.json 的一级目录。
 *
 * @param {string} webDir 例:`<dataDir>/web`
 * @returns {{ packs: object[], problems: {dir: string, reason: string}[] }}
 */
export function scanFigurePacks(webDir) {
  const problems = [];
  let entries = [];
  try {
    entries = readdirSync(webDir, { withFileTypes: true });
  } catch (err) {
    return { packs: [], problems: [{ dir: webDir, reason: `读不了 web 目录:${err?.message ?? err}` }] };
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;
    const full = join(webDir, dir);
    let stat;
    try {
      stat = statSync(join(full, FIGURE_FILE));
    } catch {
      continue; // 没有 figure.json:是普通素材目录(i18n/kit/speech…),不是形象包
    }
    if (!stat.isFile()) continue;
    const raw = readFigureManifest(full);
    if (!raw) {
      problems.push({ dir, reason: 'figure.json 解析失败(不是合法 JSON / 不是对象)' });
      continue;
    }
    packs.push(normalizeManifest(raw, { dir, base: `/web/${dir}/` }));
  }
  // 内置的 whale/coo 排前面(换装页/下拉框顺序稳定),其余按 id 排序
  const builtin = ['whale', 'coo'];
  packs.sort((a, b) => {
    const ai = builtin.indexOf(a.id);
    const bi = builtin.indexOf(b.id);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.id.localeCompare(b.id);
  });
  return { packs, problems };
}

/**
 * 把额外来源里的形象包复制进 `webDir/<packId>`(目标已存在就跳过)。
 *
 * @param {object} opts
 * @param {string[]} [opts.roots] 每个根下**一级目录**就是候选 pack
 * @param {string} opts.webDir 目标 web 目录
 * @param {(line: string) => void} [opts.log]
 * @returns {{ copied: {id: string, from: string, to: string}[], skipped: {id: string, from: string, reason: string}[], problems: {dir: string, reason: string}[] }}
 */
export function importFigurePacks({ roots = [], webDir, log } = {}) {
  const copied = [];
  const skipped = [];
  const problems = [];
  const seen = new Set();
  const webFull = resolve(webDir);
  for (const rawRoot of roots) {
    const root = String(rawRoot ?? '').trim();
    if (!root) continue;
    const full = resolve(root);
    if (seen.has(full)) continue;
    seen.add(full);
    if (full === webFull) continue; // 别把 web 自己当来源
    if (!existsSync(full)) continue;
    let entries = [];
    try {
      entries = readdirSync(full, { withFileTypes: true });
    } catch (err) {
      problems.push({ dir: full, reason: `读不了 pack 根目录:${err?.message ?? err}` });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = join(full, entry.name);
      const raw = readFigureManifest(src);
      if (!raw) {
        // 普通目录(或坏包)不算错:很多用户根目录里会混别的文件
        continue;
      }
      const id = typeof raw.id === 'string' && FIGURE_ID.test(raw.id) ? raw.id : entry.name;
      if (!FIGURE_ID.test(id)) {
        problems.push({ dir: src, reason: `figure id 不合法:${JSON.stringify(raw.id ?? entry.name)}` });
        continue;
      }
      const dest = join(webDir, id);
      if (existsSync(dest)) {
        skipped.push({ id, from: src, reason: '目标已存在(不覆盖)' });
        continue;
      }
      try {
        cpSync(src, dest, { recursive: true, force: true });
        copied.push({ id, from: src, to: dest });
        log?.(`形象包已导入:${id} ← ${src}`);
      } catch (err) {
        problems.push({ dir: src, reason: `复制失败:${err?.message ?? err}` });
        log?.(`形象包复制失败(${id}):${err?.message ?? err}`);
      }
    }
  }
  for (const problem of problems) if (!problem.reason.startsWith('复制失败')) log?.(`形象包跳过 ${basename(problem.dir)}:${problem.reason}`);
  // mkdir 只是兜底:webDir 由 ensureAssets 创建;这里保证目标根存在(测试里也会单独调)
  if (!existsSync(webDir)) {
    try {
      mkdirSync(webDir, { recursive: true });
    } catch {
      /* 上面 cpSync 会再报错 */
    }
  }
  return { copied, skipped, problems };
}
