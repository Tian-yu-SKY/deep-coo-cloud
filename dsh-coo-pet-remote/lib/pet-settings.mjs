/**
 * 桌宠 DIY 设置(`pet-settings.json`)的纯函数:默认值、校验、外观解析。
 *
 * 文件长这样(所有字段可选,缺的用默认值;见 REMOTE-BRAIN.md「桌宠 DIY」):
 * ```json
 * {"skin":{"figure":"whale","scheme":"harness","outfit":"maid","palette":"mint",
 *          "head":"none","side":"none","glasses":"none","neck":"none"},
 *  "scale":2,"bubbleSize":1,"fontSize":1,"bubbleSpeed":1,"glow":7,
 *  "theme":"dark","roam":"free","sound":true,
 *  "hoverButtons":["chat","cooChat"],"doubleClickChat":true,
 *  "frameRate":0,"lockFrameRate":true}
 * ```
 *
 * 关键概念(和页面 `coo/coo.js` 的 `normalizeSkin` / 换装页 `picksOf` 对齐):
 *   - `skin` 的前 8 个字段是**给人和 UI 看的、按轴拆开的值**:`figure` + 各轴
 *     (whale 的 `scheme`/`outfit`、coo 的 `palette`/`head`/`side`/`glasses`/`neck`);
 *   - 页面真正吃的是 `normalizeSkin(skin)` 之后的形状:非 coo pack 把**所有轴**拼进
 *     `scheme`(如 `harness-cape`,或命中 preset 时直接用 preset id),coo 则用
 *     `palette` + 四个配件槽;
 *   - 所以这里做了两件事:`resolveSkin()`(设置 → 页面 skin)和 `decodePageSkin()`
 *     (换装页存回来的页面 skin → 设置字段)。
 *
 * 纯函数,不碰文件/网络,便于单测(test/pet-diy.test.mjs)。落盘/轮询在 impl.js。
 */

/** 默认的界面设置(与 task-22 的 schema 一致)。 */
export const DEFAULT_UI_PREFS = Object.freeze({
  scale: 2,
  bubbleSize: 1,
  fontSize: 1,
  bubbleSpeed: 1,
  glow: 7,
  theme: 'dark',
  roam: 'free',
  sound: true,
  hoverButtons: ['chat', 'cooChat'],
  doubleClickChat: true,
  frameRate: 0,
  lockFrameRate: true,
});

/** 数值字段的允许范围(scale 的上下限来自配置,单独传)。 */
export const UI_LIMITS = Object.freeze({
  bubbleSize: [0.5, 2],
  fontSize: [0.5, 2],
  bubbleSpeed: [0.5, 2],
  glow: [0, 14],
  frameRate: [0, 60],
});
/** 默认的 scale 范围(配置 `scaleMin`/`scaleMax` 可覆盖)。 */
export const DEFAULT_SCALE_RANGE = Object.freeze([0.5, 3]);

export const THEMES = Object.freeze(['dark', 'light']);
/** 页面 `ROAM_ORDER = ['off','calm','free']`,顺序不重要,值必须是这三个。 */
export const ROAMS = Object.freeze(['free', 'calm', 'off']);
/** 页面 `ACTIONS` 里真实存在的 hover 按钮 id(页面会再按 `id in ACTIONS` 过滤,这里先挡一道)。 */
export const HOVER_ACTIONS = Object.freeze(['chat', 'voice', 'roam', 'theme', 'sound', 'hide', 'dress', 'cooChat']);

/** 固定的 skin 轴字段(其余轴放 `skin.axes` 里,给用户自定义 pack 用)。 */
export const SKIN_SLOT_FIELDS = Object.freeze(['head', 'side', 'glasses', 'neck']);
export const SKIN_FIELDS = Object.freeze(['figure', 'scheme', 'outfit', 'palette', ...SKIN_SLOT_FIELDS]);
/** 页面 `CHANNEL_DEFAULT`:配件各颜色通道的取值来源(body/eye/具体色)。 */
export const DEFAULT_CHANNEL_COLORS = Object.freeze({
  head: { main: 'body', acc: 'eye' },
  side: { main: 'eye', acc: 'eye' },
  glasses: { main: 'body', acc: 'eye' },
  neck: { main: 'eye', acc: 'eye' },
});
/** figure 必须是页面 accepts 的小写 id(web/coo/coo.js 的 FIGURE_ID)。 */
const FIGURE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const copyColors = (raw) => {
  const out = JSON.parse(JSON.stringify(DEFAULT_CHANNEL_COLORS));
  if (!isPlainObject(raw)) return out;
  for (const slot of SKIN_SLOT_FIELDS) {
    for (const channel of ['main', 'acc']) {
      const value = raw[slot]?.[channel];
      if (typeof value === 'string') out[slot][channel] = value;
    }
  }
  return out;
};

/** @param {object[]} packs @returns {string[]} */
export function figureIds(packs) {
  return (Array.isArray(packs) ? packs : []).map((pack) => pack?.id).filter((id) => typeof id === 'string');
}

/**
 * 设置里的 skin → 页面 skin(以及拆开的设置字段)。
 *
 * 规则(和换装页一致):
 *   1. `skin.scheme` 若是当前 pack 的 **preset id** → 用 `preset.pick` 展开各轴;
 *   2. 否则每个轴按 `skin.axes[axis]` › `skin[axis]` › 该轴第一个 option 取值;
 *   3. 页面 skin 的 `scheme` = 命中 preset 时用 preset id,否则按轴顺序把 option id 用 `-` 连起来
 *      (如 `harness-cape`)——这正是页面 `picksOf`/`schemeOf` 的约定;
 *   4. coo 这类带 `palette/head/side/glasses/neck` 轴的 pack,这些值也平铺进页面 skin。
 *
 * @param {object} skinIn `pet-settings.json` 里的 `skin`(可为空)
 * @param {object[]} packs `scanFigurePacks()` 的结果
 * @param {{ fallbackFigure?: string }} [opts]
 */
export function resolveSkin(skinIn, packs, { fallbackFigure = 'whale' } = {}) {
  const input = isPlainObject(skinIn) ? skinIn : {};
  const list = Array.isArray(packs) ? packs.filter((pack) => pack && typeof pack.id === 'string') : [];
  const warnings = [];
  const wanted = typeof input.figure === 'string' ? input.figure : null;
  let pack = list.find((item) => item.id === wanted) ?? null;
  if (wanted && !pack) warnings.push(`未知形象包「${wanted}」,已回退`);
  if (!pack) {
    const fallback = list.find((item) => item.id === fallbackFigure) ?? list[0] ?? null;
    if (pack === null && wanted) pack = fallback;
    else if (!wanted) pack = fallback;
  }
  const figure = pack?.id ?? (typeof input.figure === 'string' && FIGURE_ID.test(input.figure) ? input.figure : fallbackFigure);
  const axes = pack?.axes ?? [];
  const extraAxesIn = isPlainObject(input.axes) ? input.axes : {};

  if (!pack || axes.length === 0) {
    // 没有 pack 元数据(比如还没复制好):保守透传页面能理解的字段,不让她消失
    const scheme = typeof input.scheme === 'string' && /^[a-z0-9-]*$/.test(input.scheme) ? input.scheme : '';
    return {
      figure,
      pack,
      picks: {},
      pageScheme: scheme,
      pageSkin: { figure, scheme, colors: copyColors(input.colors) },
      settingsSkin: {
        figure,
        scheme,
        outfit: typeof input.outfit === 'string' ? input.outfit : '',
        palette: typeof input.palette === 'string' ? input.palette : 'mint',
        head: typeof input.head === 'string' ? input.head : 'none',
        side: typeof input.side === 'string' ? input.side : 'none',
        glasses: typeof input.glasses === 'string' ? input.glasses : 'none',
        neck: typeof input.neck === 'string' ? input.neck : 'none',
        colors: copyColors(input.colors),
      },
      warnings,
    };
  }

  /**
   * 每个轴的取值优先级:**显式轴值(axes / 固定字段) > preset 展开 > 该轴第一个 option**。
   *
   * 「显式优先」是给面板用的:鲸歌面板会把它渲染出的每个轴的值都发过来(whale 的
   * scheme=harness + outfit=cape),此时不能被 preset `harness` 覆盖回 maid。
   * 用户只给 `scheme: "harness"`(preset id)时,outfit 没有显式值,才由 preset 展开。
   */
  const preset = axes.length && typeof input.scheme === 'string'
    ? (pack.presets ?? []).find((item) => item.id === input.scheme) ?? null
    : null;
  /** @type {Record<string, string>} */
  const picks = {};
  for (const axis of axes) {
    const explicit = extraAxesIn[axis.id] ?? input[axis.id];
    const candidates = [
      explicit,
      preset?.pick?.[axis.id],
    ];
    let chosen = null;
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      if (!axis.options.some((option) => option.id === candidate)) continue;
      chosen = candidate;
      break;
    }
    if (!chosen) {
      chosen = axis.options[0]?.id ?? '';
      const given = typeof explicit === 'string' ? explicit : '';
      if (given) warnings.push(`形象包「${pack.id}」的轴 ${axis.id} 没有选项「${given}」,用默认 ${chosen}`);
    }
    picks[axis.id] = chosen;
  }
  // page scheme 与页面 `schemeOf` 一致:能命中某个 preset 就用 preset id,否则各轴拼串
  const matchingPreset = (pack.presets ?? []).find(
    (item) => axes.every((axis) => item.pick?.[axis.id] === picks[axis.id]),
  ) ?? null;
  const pageScheme = matchingPreset ? matchingPreset.id : axes.map((axis) => picks[axis.id]).join('-');

  /** 页面 normalizeSkin 认的形状 */
  const pageSkin = { figure: pack.id, scheme: pageScheme, colors: copyColors(input.colors) };
  for (const axis of axes) {
    if (axis.id === 'palette' || SKIN_SLOT_FIELDS.includes(axis.id)) pageSkin[axis.id] = picks[axis.id];
  }

  /** 存回设置/skin.json 的固定字段形状(按轴拆开,方便 UI 显示「whale · harness · maid」) */
  const settingsSkin = {
    figure: pack.id,
    scheme: typeof input.scheme === 'string' && /^[a-z0-9-]*$/.test(input.scheme) ? input.scheme : '',
    outfit: '',
    palette: 'mint',
    head: 'none',
    side: 'none',
    glasses: 'none',
    neck: 'none',
    colors: copyColors(input.colors),
  };
  const extras = {};
  for (const axis of axes) {
    if (SKIN_FIELDS.includes(axis.id)) settingsSkin[axis.id] = picks[axis.id];
    else extras[axis.id] = picks[axis.id];
  }
  if (Object.keys(extras).length) settingsSkin.axes = extras;
  // 没有 scheme 轴的 pack(如 coo):保留用户原来的 scheme 值(页面不用它,但 normalizeSkin 认)
  if (!axes.some((axis) => axis.id === 'scheme') && !settingsSkin.scheme) settingsSkin.scheme = 'deepseek';
  return { figure: pack.id, pack, picks, pageScheme, pageSkin, settingsSkin, warnings };
}

/**
 * 换装页存回来的**页面 skin** → 设置里的固定字段(用于 `/api/skin` 保存、迁移旧 skin.json)。
 *
 * 支持两种历史形状:
 *   - 页面形状:`scheme` 是 preset id 或各轴拼起来的字符串(coo 则带 palette/配件槽);
 *   - 旧插件 `buildSkin` 形状:`scheme`/`outfit` 分开(此时 scheme 常是 preset id)。
 *
 * @param {object} pageSkin
 * @param {object[]} packs
 * @returns {object | null} 设置用的 skin 字段(解析不了返回 null)
 */
export function decodePageSkin(pageSkin, packs, { fallbackFigure = 'whale' } = {}) {
  if (!isPlainObject(pageSkin)) return null;
  const list = Array.isArray(packs) ? packs.filter((pack) => pack && typeof pack.id === 'string') : [];
  const figure = typeof pageSkin.figure === 'string' ? pageSkin.figure : fallbackFigure;
  const pack = list.find((item) => item.id === figure) ?? null;
  if (!pack || !Array.isArray(pack.axes) || pack.axes.length === 0) {
    const resolved = resolveSkin({ ...pageSkin, figure }, list, { fallbackFigure });
    return resolved?.settingsSkin ?? null;
  }
  const preset = (pack.presets ?? []).find((item) => item.id === pageSkin.scheme) ?? null;
  const parts = String(pageSkin.scheme ?? '').split('-').filter(Boolean);
  const picks = {};
  pack.axes.forEach((axis, index) => {
    // 页面 `scheme` 优先:上游 onSave 写进 skin.json 的就是**拼好的 scheme**
    // (例:`deepseek-cape`,而相邻的 `outfit` 字段可能是 config 里的旧值 maid,不能信);
    // 页面 shape 里没有各轴字段;旧 buildSkin 形状的 scheme 通常是 preset id,也在这里展开。
    const candidates = [
      preset?.pick?.[axis.id],
      parts[index],
      isPlainObject(pageSkin.axes) ? pageSkin.axes[axis.id] : undefined,
      pageSkin[axis.id],
    ];
    let chosen = null;
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      if (!axis.options.some((option) => option.id === candidate)) continue;
      chosen = candidate;
      break;
    }
    picks[axis.id] = chosen ?? axis.options[0]?.id ?? '';
  });
  const resolved = resolveSkin({ figure, axes: picks, colors: pageSkin.colors }, list, { fallbackFigure });
  if (resolved) return resolved.settingsSkin;
  return null;
}

/**
 * 校验/补全一份 `pet-settings.json`。无效值**忽略并记 warning**(不抛错、不写坏别处)。
 *
 * @param {object} raw 读到的 JSON(可以是残缺的)
 * @param {object} opts
 * @param {object[]} [opts.packs] 可用形象包(决定 skin 合法性)
 * @param {[number, number]} [opts.scaleRange] scale 允许范围
 * @param {string} [opts.fallbackFigure]
 * @param {object} [opts.fallback] 上一份已生效的设置:文件里**没写**的字段用它,
 *   写了但非法/类型错的字段也尽量保留它的值(「忽略」而不是重置成出厂默认)
 * @returns {{ settings: object, warnings: string[], skin: ReturnType<typeof resolveSkin> }}
 */
export function normalizeSettings(raw, {
  packs = [], scaleRange = DEFAULT_SCALE_RANGE, fallbackFigure = 'whale', fallback = null,
} = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const base = isPlainObject(fallback) ? fallback : null;
  const [scaleMin, scaleMax] = normalizeScaleRange(scaleRange);
  const warnings = [];
  const settings = { ...DEFAULT_UI_PREFS, hoverButtons: [...DEFAULT_UI_PREFS.hoverButtons] };
  if (base) {
    for (const key of Object.keys(DEFAULT_UI_PREFS)) {
      if (key === 'hoverButtons') {
        if (Array.isArray(base.hoverButtons)) settings.hoverButtons = [...base.hoverButtons];
      } else if (base[key] !== undefined) {
        settings[key] = base[key];
      }
    }
  }

  // 数值字段:合法就 clamp/取整,非法类型忽略并 warning
  const ranges = {
    scale: [scaleMin, scaleMax],
    ...UI_LIMITS,
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (source[key] === undefined) continue;
    const value = finiteNumber(source[key]);
    if (value === null) {
      warnings.push(`${key}=${JSON.stringify(source[key])} 不合法(要数字)`);
      continue;
    }
    const clamped = clamp(value, min, max);
    if (clamped !== value) warnings.push(`${key}=${value} 超出 ${min}~${max},已用 ${clamped}`);
    settings[key] = key === 'glow' || key === 'frameRate' ? Math.round(clamped) : clamped;
  }

  // 枚举
  if (source.theme !== undefined) {
    if (THEMES.includes(source.theme)) settings.theme = source.theme;
    else warnings.push(`theme=${JSON.stringify(source.theme)} 不合法(只能是 dark/light)`);
  }
  if (source.roam !== undefined) {
    if (ROAMS.includes(source.roam)) settings.roam = source.roam;
    else warnings.push(`roam=${JSON.stringify(source.roam)} 不合法(只能是 free/calm/off)`);
  }

  // 布尔
  for (const key of ['sound', 'doubleClickChat', 'lockFrameRate']) {
    if (source[key] === undefined) continue;
    if (typeof source[key] === 'boolean') settings[key] = source[key];
    else warnings.push(`${key}=${JSON.stringify(source[key])} 不合法(要布尔)`);
  }

  // hover 按钮:只留页面 ACTIONS 里有的
  if (source.hoverButtons !== undefined) {
    if (Array.isArray(source.hoverButtons)) {
      const kept = source.hoverButtons.filter((id) => typeof id === 'string' && HOVER_ACTIONS.includes(id));
      const dropped = source.hoverButtons.filter((id) => !(typeof id === 'string' && HOVER_ACTIONS.includes(id)));
      if (dropped.length) warnings.push(`hoverButtons 忽略不认识的项:${dropped.map((v) => JSON.stringify(v)).join(',')}`);
      settings.hoverButtons = [...new Set(kept)];
    } else {
      warnings.push('hoverButtons 不是数组,已忽略');
    }
  }

  // skin:文件里没写就沿用 fallback 的外观;写了的字段覆盖(同一 pack 的其它轴不丢)
  const baseSkin = isPlainObject(base?.skin) ? base.skin : null;
  let skinIn;
  if (isPlainObject(source.skin)) {
    skinIn = baseSkin ? { ...baseSkin, ...source.skin } : source.skin;
    if (isPlainObject(source.skin.colors)) skinIn.colors = source.skin.colors;
  } else {
    skinIn = baseSkin ?? {};
  }
  const resolved = resolveSkin(skinIn, packs, { fallbackFigure });
  settings.skin = resolved.settingsSkin;
  for (const warning of resolved.warnings) if (!warnings.includes(warning)) warnings.push(warning);

  return { settings, warnings, skin: resolved };
}

/** 允许配置给 [scaleMin, scaleMax],这里保证顺序/范围合法。 */
export function normalizeScaleRange(range) {
  const fallback = DEFAULT_SCALE_RANGE;
  if (!Array.isArray(range) || range.length < 2) return [...fallback];
  const minRaw = finiteNumber(range[0]);
  const maxRaw = finiteNumber(range[1]);
  let min = minRaw ?? fallback[0];
  let max = maxRaw ?? fallback[1];
  min = clamp(min, 0.1, 5);
  max = clamp(max, 0.1, 5);
  if (min >= max) return [...fallback];
  return [min, max];
}

/**
 * 由插件配置 + 旧的 skin.json 生成**初始设置**(首次启动写 pet-settings.json 用)。
 *
 * @param {object} config 插件 config
 * @param {object} opts
 * @param {object | null} [opts.savedSkin] 旧 `dataDir/skin.json`(可能来自上游 buildSkin)
 * @param {object[]} [opts.packs]
 * @param {[number, number]} [opts.scaleRange]
 */
export function settingsFromConfig(config = {}, { savedSkin = null, packs = [], scaleRange = DEFAULT_SCALE_RANGE, fallbackFigure = 'whale' } = {}) {
  const configSkin = isPlainObject(config.skin) ? { ...config.skin } : {};
  let skinIn = { ...configSkin };
  if (isPlainObject(savedSkin)) {
    const decoded = decodePageSkin(savedSkin, packs, { fallbackFigure });
    if (decoded) skinIn = { ...skinIn, ...decoded };
  }
  const raw = {
    skin: skinIn,
  };
  const scale = finiteNumber(config.scale);
  if (scale !== null) raw.scale = scale;
  const normalized = normalizeSettings(raw, { packs, scaleRange, fallbackFigure });
  return normalized;
}

/**
 * 设置 → 页面 `{t:'prefs'}` / snapshot 的界面字段(不含 skin;skin 用 resolveSkin().pageSkin)。
 * @param {object} settings
 */
export function uiPrefsOf(settings) {
  const {
    skin, ...ui
  } = settings ?? {};
  return { ...ui, hoverButtons: [...(ui.hoverButtons ?? DEFAULT_UI_PREFS.hoverButtons)] };
}

/**
 * 设置 → 页面一次 `{t:'prefs'}` 广播 / init snapshot 的内容。
 * @param {object} settings
 * @param {ReturnType<typeof resolveSkin>} resolved
 */
export function pagePrefsOf(settings, resolved) {
  return { skin: resolved.pageSkin, ...uiPrefsOf(settings) };
}

/**
 * skin.json(legacy 兼容文件)的内容:固定字段 + 颜色。
 * 与上游 `buildSkin` 的字段集一致,只是 `scheme` 存该轴的值(页面拼接值不入盘)。
 * @param {ReturnType<typeof resolveSkin>} resolved
 */
export function skinJsonOf(resolved) {
  const skin = resolved?.settingsSkin ?? {};
  return {
    figure: skin.figure,
    scheme: skin.scheme ?? '',
    outfit: skin.outfit ?? '',
    palette: skin.palette ?? 'mint',
    head: skin.head ?? 'none',
    side: skin.side ?? 'none',
    glasses: skin.glasses ?? 'none',
    neck: skin.neck ?? 'none',
    colors: resolved?.pageSkin?.colors ?? copyColors(null),
  };
}
