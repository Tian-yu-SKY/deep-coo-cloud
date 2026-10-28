/**
 * 桌宠页面素材的来源。
 *
 * 页面素材(`pet.html` / `pet-app.js` / `pet.css` / whale 贴图…)不是本项目的作品:
 * 它们出自 Coopanion 的 `cortico-world-desktop-pet` 包,那个包是 **AGPL-3.0**,
 * 而 `web/whale/` 那批贴图连 AGPL 都不覆盖——原作者在 THIRD_PARTY_NOTICES 里
 * 明确写了"不在本包的 AGPL 授权范围内",而且围裙上印着 DeepSeek、OpenAI、
 * Anthropic、Google、阿里云、月之暗面、MiniMax 的商标。
 *
 * 所以本仓库**一张图、一行别人的代码都不放**,改成运行时从用户已经装好的
 * Coopanion 里取:把它的 `cortico-world-desktop-pet/web/` 复制到本插件的数据目录,
 * 再对 `pet-app.js` 打三处补丁(加那个"跟邻居 Coo 聊天"的按钮)。
 *
 * 这对用户不算额外要求:桌宠窗口本来就要用 Coopanion 的 `Coopanion.exe`。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 装着页面素材的那个包,相对于 Coopanion 的安装目录。 */
export const PET_PKG = join('resources', 'app', 'node_modules', 'cortico-world-desktop-pet');

/** 装得比较多的几个位置;注册表也问不到时,拿这些兜底。 */
const COMMON_ROOTS = [
  process.env.COOPANION_HOME ?? '',
  'C:\\Program Files\\Coopanion',
  'C:\\Program Files (x86)\\Coopanion',
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Coopanion'),
  join(process.env.APPDATA ?? '', 'Coopanion'),
];

let registryCache = null;

/**
 * 问 Windows 的"卸载信息",把 Coopanion 的安装目录捞出来。
 *
 * 用户完全可能装在 D 盘、E 盘或者某个自建目录里,光猜常见位置是不够的;
 * 而只要用安装包装过,注册表就会留下 InstallLocation。结果缓存一次,
 * 免得每次挂载都去 query 一遍注册表。
 */
function fromRegistry() {
  if (registryCache) return registryCache;
  registryCache = [];
  if (process.platform !== 'win32') return registryCache;
  for (const hive of ['HKCU', 'HKLM']) {
    const key = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
    try {
      const text = execFileSync('reg', ['query', key, '/s', '/f', 'Coopanion'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+?)\s*$/i);
        if (!m) continue;
        registryCache.push(
          m[1]
            .replace(/^"|"$/g, '') // 去掉可能包着的引号
            .replace(/,\d+$/, '') // DisplayIcon 尾巴上的图标序号 ",0"
            .replace(/\\[^\\]+\.exe$/i, ''), // 去掉可执行文件名,只留目录
        );
      }
    } catch {
      /* 这个 hive 里没有,或者 reg 用不了,继续试下一个 */
    }
  }
  return registryCache;
}

/** 这个目录像不像一个装了桌宠素材的 Coopanion。 */
const looksRight = (root) => !!root && existsSync(join(root, PET_PKG, 'web', 'pet.html'));

/**
 * 找出 Coopanion 的安装目录:配置 > 注册表 > 常见位置。
 * @param {string} [hint] 配置或调用方给的候选(比如 petExe 所在的目录)
 * @returns {string | null}
 */
export function findCooRoot(hint) {
  for (const candidate of [hint, ...fromRegistry(), ...COMMON_ROOTS]) {
    if (looksRight(candidate)) return candidate;
  }
  return null;
}

/**
 * 给 `pet-app.js` 打补丁:加一个「跟邻居 Coo 聊天」的按钮。
 *
 * 用**字符串锚点**而不是行号——Coopanion 升级后行号一定会变,但下面这几段原文
 * 是它稳定的结构。锚点找不到就跳过并如实报告,绝不硬改:
 * 桌宠照样能用,只是少一个按钮。
 *
 * @returns {{ text: string, notes: string[] }}
 */
export function patchPetApp(src) {
  const notes = [];
  let out = src;

  /**
   * 只在「还没打过、且锚点还在」的时候插一次。
   *
   * `anchors` 可以给**一组**,按顺序取第一个命中的——Coopanion 会重构页面代码,
   * 单一锚点迟早会断(踩过:`ctl.setThinking` 那行在 0.1.21 里就没了),
   * 多写几个等价位置能让补丁活得更久。
   */
  const insert = (label, marker, anchors, text, after = false) => {
    if (out.includes(marker)) return void notes.push(`${label}:已有`);
    const list = Array.isArray(anchors) ? anchors : [anchors];
    const hit = list.find((a) => out.includes(a));
    if (!hit) return void notes.push(`${label}:锚点没找到(试了 ${list.length} 个),跳过`);
    out = after ? out.replace(hit, hit + text) : out.replace(hit, text + hit);
    notes.push(`${label}:已打上`);
  };

  // ① prefs 里加一个 chatting:那个按钮的提示要读它
  insert(
    'chatting 字段',
    'chatting: false,',
    '  lockFrameRate: false,\n};',
    '  /** 她俩现在是不是正在聊(DSH 那份插件加的)。 */\n  chatting: false,\n',
  );
  // ② 宿主推来的 prefs 里带 chatting 时存下来(挨着别的布尔偏好插,顺序不影响)
  insert(
    'chatting 同步',
    "if (typeof p.chatting === 'boolean')",
    [
      // 0.1.19 起 applyPrefs 就是这么逐项同步的
      "  if (typeof p.doubleClickChat === 'boolean') prefs.doubleClickChat = p.doubleClickChat;\n",
      // 再往前一点的版本
      "  if (typeof p.thinking === 'boolean') ctl.setThinking(p.thinking);\n",
      "  if (typeof p.lockFrameRate === 'boolean') prefs.lockFrameRate = p.lockFrameRate;\n",
    ],
    "  if (typeof p.chatting === 'boolean') prefs.chatting = p.chatting;\n",
    true,
  );
  // ③ 动作表里加那个按钮(**插在 `const ACTIONS = {` 之后**,也就是进到表里面——
  //    插到前面会变成 `cooChat: {...} const ACTIONS = {`,直接语法错误,踩过)
  insert(
    'cooChat 按钮',
    'cooChat: {',
    'const ACTIONS = {\n',
    [
      '  /**',
      '   * 跟另一只桌宠 Coo 聊天——DSH 那份插件加的(原版 Coopanion 没有)。',
      '   * 点一下把事件发回宿主,由插件决定是开聊还是暂停。',
      '   */',
      '  cooChat: {',
      '    icon: () => ICONS.chat,',
      "    state: () => (prefs.chatting ? '正在跟邻居 Coo 聊着 · 点一下让她们暂停' : '招呼邻居 Coo 过来聊两句 · 点一下开聊,再点一下暂停'),",
      "    run: () => send({ t: 'control', action: 'coo-chat' }),",
      '  },',
      '',
    ].join('\n'),
    true,
  );
  // ④ 没有窗口宿主时,自己量任务栏高度
  //
  // 页面用 `host.onFloor(cb)` 拿到"地面下面还有多少像素(任务栏)",窗口宿主给不出来时
  // 它就是 0 → 地面线贴着窗口底边 → **她的脚被任务栏挡住**(评论区反馈过"跑到底下去了")。
  // 这里按「窗口高 - 屏幕可用高」自己算,并且按 DPI 缩放的比值换算成页面像素。
  insert(
    'floor 兜底',
    'floorBelow 兜底',
    "host?.onFloor?.((px) => { below = px; body?.set({ bounds: bounds() }); });\n",
    [
      '// floorBelow 兜底:自己量任务栏高度(见 DSH 桌宠插件的注释)',
      '// 不判断 host 有没有 onFloor —— 实测 pet-host 报的是 0,她的脚会被任务栏挡住。',
      '{',
      '  const measureFloor = () => {',
      '    const scale = innerHeight / (screen.height || innerHeight);',
      '    below = Math.max(0, Math.round((screen.height - (screen.availHeight || screen.height)) * scale));',
      '    body?.set({ bounds: bounds() });',
      '  };',
      '  measureFloor();',
      '  addEventListener(\'resize\', measureFloor);',
      '}',
      '',
    ].join('\n'),
    true,
  );

  return { text: out, notes };
}

/** 换装页地板图标补丁要内联到页面里的默认动作/标签（impl 会传真实配置覆盖）。 */
const DEFAULT_DOCK = {
  actions: ['panel', 'figures', 'home', 'mail', 'music', 'chat'],
  labels: ['Settings panel', 'Figure packs folder', 'Coopanion home page', 'Open mail', 'Toggle sound', 'Chat panel'],
  style: [
    '.floor-action{background:none;border:0;color:inherit;cursor:pointer;border-radius:6px;padding:3px;line-height:0}',
    '.floor-action:hover{background:color-mix(in srgb,currentColor 12%,transparent)}',
    '.floor-action:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    '.floor-icons .floor-action svg{pointer-events:none;width:20px;height:20px}',
  ].join('\n'),
};

/**
 * 换装页地板图标的补丁（v0.4.3 / task-32）：把 `stage.js` 的 `dressFloor()` 里那 6 个
 * **装饰** svg 换成真实按钮，点击 `POST /api/dock`（动作白名单与执行在 `lib/dock.mjs` + impl）。
 *
 * - 只改**复制到数据目录的副本**（`ensureAssets`），不动 Coopanion 安装目录；
 * - 锚点找不到就原样返回并记 note，绝不硬改；已有补丁标记就跳过（幂等）；
 * - `row` 的 `aria-hidden` 去掉，按钮可聚焦、有 `title`/`aria-label`；
 * - 样式只作用于 `.floor-icons`，不影响整页其它 svg。
 *
 * @param {string} src `stage.js` 原文
 * @param {{actions?: string[], labels?: string[], style?: string}} [dock]
 * @returns {{ text: string, notes: string[] }}
 */
export function patchStageDock(src, dock) {
  if (typeof src !== 'string' || !src) return { text: src, notes: ['地板图标:源码为空,跳过'] };
  const toastHelper = [
    '  const dshFloorToast = (text) => {',
    "    let el = document.getElementById('dsh-floor-toast');",
    '    if (!el) {',
    "      el = document.createElement('div');",
    "      el.id = 'dsh-floor-toast';",
    "      el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;background:rgba(20,26,36,.92);color:#fff;font:13px/1.5 system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .15s';",
    '      document.body.append(el);',
    '    }',
    "    el.textContent = String(text ?? '');",
    "    el.style.opacity = '1';",
    '    clearTimeout(el._t);',
    "    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2600);",
    '  };',
  ].join('\n');
  const hasV1 = src.includes('dsh-floor-style') || src.includes('data-action="panel"');
  if (hasV1 && src.includes('dsh-floor-toast')) return { text: src, notes: ['地板图标:已有'] };
  if (hasV1) {
    // v0.4.3 的老补丁没有点击反馈:只把 fetch 那两行换成带头 toast 的版本(不动其它结构)
    const v1Fetch = [
      "      fetch('/api/dock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })",
      "        .catch((err) => console.warn('[dsh-coo-pet] floor action failed', action, err));",
    ].join('\n');
    if (!src.includes(v1Fetch)) return { text: src, notes: ['地板图标:旧补丁升级锚点没找到,跳过'] };
    const v2Fetch = [
      toastHelper,
      "      fetch('/api/dock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })",
      "        .then((res) => res.json().catch(() => ({})))",
      "        .then((data) => {",
      "          if (data && data.message) dshFloorToast(data.message);",
      "          else if (data && data.ok === false) dshFloorToast('操作失败');",
      '        })',
      "        .catch((err) => { console.warn('[dsh-coo-pet] floor action failed', action, err); dshFloorToast('操作失败: ' + (err && err.message ? err.message : err)); });",
    ].join('\n');
    return { text: src.replace(v1Fetch, v2Fetch), notes: ['地板图标:旧补丁已升级(点击有 toast 反馈)'] };
  }
  const notes = [];
  const config = {
    actions: Array.isArray(dock?.actions) && dock.actions.length === 6 ? dock.actions : DEFAULT_DOCK.actions,
    labels: Array.isArray(dock?.labels) && dock.labels.length === 6 ? dock.labels : DEFAULT_DOCK.labels,
    style: typeof dock?.style === 'string' && dock.style ? dock.style : DEFAULT_DOCK.style,
  };
  const anchors = [
    "row.innerHTML = DOCK.map(line).join('');",
    'row.innerHTML = DOCK.map(line).join("");',
  ];
  const start = anchors.map((anchor) => src.indexOf(anchor)).find((index) => index >= 0) ?? -1;
  if (start < 0) return { text: src, notes: ['地板图标:锚点没找到(dressFloor 可能改过),跳过'] };
  const appendAnchor = 'floor.append(row);';
  const appendIndex = src.indexOf(appendAnchor, start);
  if (appendIndex < 0 || appendIndex - start > 400) {
    return { text: src, notes: ['地板图标:锚点没找到(floor.append 不在附近),跳过'] };
  }
  const replacement = [
    '/* dsh-coo-pet dock patch v2:装饰图标 → 真按钮(只 POST /api/dock,点击有 toast 反馈) */',
    '{',
    `  const ACTIONS = ${JSON.stringify(config.actions)};`,
    `  const LABELS = ${JSON.stringify(config.labels)};`,
    `  const STYLE = ${JSON.stringify(config.style)};`,
    toastHelper,
    "  if (!document.getElementById('dsh-floor-style')) {",
    "    const style = document.createElement('style');",
    "    style.id = 'dsh-floor-style';",
    '    style.textContent = STYLE;',
    '    document.head.append(style);',
    '  }',
    '  if (!row.dataset.dshDockBound) {',
    "    row.dataset.dshDockBound = '1';",
    "    row.addEventListener('click', (event) => {",
    "      const button = event.target instanceof Element ? event.target.closest('.floor-action') : null;",
    "      const action = button ? button.getAttribute('data-action') : '';",
    '      if (!action) return;',
    '      event.preventDefault();',
    '      event.stopPropagation();',
    "      fetch('/api/dock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })",
    "        .then((res) => res.json().catch(() => ({})))",
    "        .then((data) => {",
    "          if (data && data.message) dshFloorToast(data.message);",
    "          else if (data && data.ok === false) dshFloorToast('操作失败');",
    '        })',
    "        .catch((err) => { console.warn('[dsh-coo-pet] floor action failed', action, err); dshFloorToast('操作失败: ' + (err && err.message ? err.message : err)); });",
    '    });',
    '  }',
    '  row.innerHTML = DOCK.map((shape, index) => {',
    '    const action = ACTIONS[index] || \'\';',
    '    const label = LABELS[index] || action;',
    "    return '<button type=\"button\" class=\"floor-action\" data-action=\"' + action + '\" title=\"' + label + '\" aria-label=\"' + label + '\">' + line(shape) + '</button>';",
    "  }).join('');",
    '  floor.append(row);',
    '}',
  ].join('\n');
  let out = `${src.slice(0, start)}${replacement}${src.slice(appendIndex + appendAnchor.length)}`;
  const ariaPatterns = [
    "  row.setAttribute('aria-hidden', 'true');\n",
    "row.setAttribute('aria-hidden', 'true');\n",
    "  row.setAttribute('aria-hidden', 'true');",
    "row.setAttribute('aria-hidden', 'true');",
  ];
  const aria = ariaPatterns.find((pattern) => out.includes(pattern));
  if (aria) out = out.replace(aria, '');
  else notes.push('地板图标:aria-hidden 锚点没找到(按钮可能被无障碍树忽略)');
  notes.push('地板图标:已换成按钮(点击有 toast 反馈)');
  return { text: out, notes };
}


/**
 * 源目录的「指纹」:整个 `web/` 的文件数 + 总字节 + 最新修改时间。
 *
 * 以前只看 `pet-app.js` 一个文件 —— 因为 Coopanion 每次升级几乎都会动它,够用。
 * 但它**改别的文件时也可能不碰页面代码**:比如只加一套服装(改 `figure.json`、
 * 往 `outfits/` 和 `thumbs/` 里放贴图),`pet-app.js` 一行没改。那时指纹不变、
 * 不会重取,用户就死活看不到新衣服。所以改成扫整个目录。
 *
 * 467 个文件递归 stat 只要几十毫秒,启动时跑一次,不值一提。
 */
function sourceStamp(src) {
  try {
    let count = 0;
    let total = 0;
    let newest = 0;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        // 符号链接不跟进去(上游的 web/ 里有软链接,跟进去会绕圈或重复计数)
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const s = statSync(full);
        count += 1;
        total += s.size;
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      }
    };
    walk(src);
    return `${count}:${total}:${Math.round(newest)}`;
  } catch {
    return 'unknown';
  }
}

/**
 * 把页面素材准备到本插件的数据目录(仓库里不放这些文件)。
 *
 * 两种情况下会重新拷:
 *   1. 还没有副本;
 *   2. **源头的指纹变了** —— 整个 `web/` 任何文件(页面、形象、贴图)有变动都算。
 *      旧副本配新版宿主可能出问题(踩过:副本是 0.1.16 的、Coopanion 已经是 0.1.21,
 *      页面照常显示,但补丁锚点对不上,那个聊天按钮的状态就同步不了);
 *      而**只加了新服装、没改页面代码**的那种升级,以前因为指纹只看 `pet-app.js`
 *      会被漏掉,用户看不到新衣服。
 *
 * 补丁每次都对一遍,拷完立刻打,所以重拷不会把它弄丢。
 *
 * @param {{ cooRoot: string, destDir: string, log?: (line: string) => void, dock?: {actions?: string[], labels?: string[], style?: string} }} opts
 * @returns {{ ok: true, webDir: string, notes: string[] } | { ok: false, reason: string }}
 */
export function ensureAssets({ cooRoot, destDir, log, dock }) {
  const src = join(cooRoot, PET_PKG, 'web');
  const dest = join(destDir, 'web');
  const petHtml = join(dest, 'pet.html');
  const appFile = join(dest, 'pet-app.js');
  const stampFile = join(dest, '.source-stamp');
  const stamp = sourceStamp(src);

  const hasCopy = existsSync(petHtml);
  let oldStamp = '';
  if (hasCopy) {
    try {
      oldStamp = readFileSync(stampFile, 'utf8').trim();
    } catch {
      oldStamp = '';
    }
  }

  if (!hasCopy || oldStamp !== stamp) {
    if (!existsSync(join(src, 'pet.html'))) return { ok: false, reason: `没在 ${src} 找到桌宠页面素材` };
    // 先清干净再拷:Coopanion 升级时可能删掉过文件,cpSync 只覆盖不删除,
    // 不清的话副本里会留着上一版的残留(实测多出过 4 个文件)。
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    try {
      writeFileSync(stampFile, stamp);
    } catch {
      /* 写不上就算了,下次大不了再拷一遍 */
    }
    log?.(
      hasCopy
        ? `Coopanion 的页面素材变过了(${oldStamp || '未知'} → ${stamp}),重新取了一份`
        : `页面素材已从 Coopanion 取好:${src} → ${dest}`,
    );
  }

  let notes = [];
  try {
    const before = readFileSync(appFile, 'utf8');
    const patched = patchPetApp(before);
    notes = patched.notes;
    if (patched.text !== before) writeFileSync(appFile, patched.text);
  } catch (err) {
    notes = [`补丁没打上:${err.message}`];
  }
  // v0.4.3:换装页地板图标(装饰 → 真按钮,只调用本机 /api/dock)
  try {
    const stageFile = join(dest, 'stage.js');
    const before = readFileSync(stageFile, 'utf8');
    const patched = patchStageDock(before, dock);
    notes.push(...patched.notes.map((note) => `stage.js ${note}`));
    if (patched.text !== before) writeFileSync(stageFile, patched.text);
  } catch (err) {
    notes.push(`stage.js 补丁没打上:${err.message}`);
  }
  return { ok: true, webDir: dest, notes };
}
