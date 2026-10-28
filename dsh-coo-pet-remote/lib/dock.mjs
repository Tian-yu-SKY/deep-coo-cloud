/**
 * 换装页 `/dress` 地板上那 6 个图标的**真实动作**（v0.4.3 / task-32）。
 *
 * 上游 `stage.js` 的 `dressFloor()` 只是画一排装饰图标（`aria-hidden`、无监听）。
 * 本 fork 由 `assets.mjs` 的 `patchStageDock()` 在**复制到数据目录的副本**上把它们包成
 * 真按钮（`<button class="floor-action" data-action=...>`），点击只 `POST /api/dock`；
 * 服务端（`pet-server.mjs`）只接受下面的**白名单**，由 `impl.js` 注入执行器：
 *
 *   panel   → 启动/聚焦 Coopanion 主程序
 *   figures → 打开本插件数据目录里的 `web/`（形象包目录）
 *   home    → 系统浏览器打开 Coopanion 项目主页
 *   mail    → 系统浏览器打开网页邮箱
 *   music   → 切换桌宠音效（= 页面音效按钮的行为）
 *   chat    → 系统浏览器打开 `dshPanelUrl`（本机 DSH 面板地址，Config 里配）
 *
 * **安全边界**：这里只做白名单分派；不接受任意命令、不接受任意 URL。
 * 唯一的「可变 URL」是用户自己在 Config 里填的 `dshPanelUrl`，且必须是 http(s)。
 *
 * 这个文件不写死任何本机路径/地址；默认主页/邮箱是公开网址，`dshPanelUrl` 由配置注入。
 */

/** 允许的动作（顺序 = 页面图标顺序：网格/文件夹/地球/信封/音符/聊天气泡）。 */
export const DOCK_ACTIONS = Object.freeze(['panel', 'figures', 'home', 'mail', 'music', 'chat']);

/** 页面上每个按钮的 title / aria-label（英文，和换装页本身的语言表无关，尽量中性）。 */
export const DOCK_LABELS = Object.freeze({
  panel: 'Settings panel',
  figures: 'Figure packs folder',
  home: 'Coopanion home page',
  mail: 'Open mail',
  music: 'Toggle sound',
  chat: 'Chat panel',
});

/** 固定动作的公开 URL（不来自配置）。 */
export const DOCK_URLS = Object.freeze({
  home: 'https://github.com/Pal-AI-Lab/Coopanion',
  mail: 'https://mail.qq.com',
});

/**
 * 注入换装页的样式（只作用于 `.floor-icons` 里的按钮/图标，避免污染整页 svg）。
 * 尺寸沿用上游 svg 的视觉大小（20px）。
 */
export const DOCK_STYLE = [
  '.floor-action{background:none;border:0;color:inherit;cursor:pointer;border-radius:6px;padding:3px;line-height:0}',
  '.floor-action:hover{background:color-mix(in srgb,currentColor 12%,transparent)}',
  '.floor-action:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
  '.floor-icons .floor-action svg{pointer-events:none;width:20px;height:20px}',
].join('\n');

/** 给页面补丁用的一份纯数据（assets.mjs 会 JSON 内联进 stage.js，避免依赖模块加载顺序）。 */
export function dockPageConfig() {
  return {
    actions: [...DOCK_ACTIONS],
    labels: DOCK_ACTIONS.map((action) => DOCK_LABELS[action] ?? action),
    style: DOCK_STYLE,
  };
}

const isHttpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * 执行一个白名单动作。
 *
 * 所有副作用都通过 `deps` 注入，方便单测（不真的起进程/开浏览器）：
 * - `spawn(command, args, options)`：起子进程（impl 传 `node:child_process` 的 spawn）
 * - `openUrl(url)`：用系统浏览器/宿主打开 URL（impl 传 `openWindow`）
 * - `toggleSound()`：切换音效并返回 `{ok,message,sound}`（impl 实现）
 * - `log(line)`：日志
 *
 * @param {string} action
 * @param {object} deps
 * @param {string} [deps.cooExe] Coopanion.exe 路径
 * @param {string} [deps.webDir] 插件数据目录里的 web/（形象包目录）
 * @param {string} [deps.dshPanelUrl] 本机 DSH 面板地址（chat 用）
 * @param {(cmd: string, args: string[], opts: object) => any} [deps.spawn]
 * @param {(url: string) => (string | null)} [deps.openUrl]
 * @param {() => ({ok: boolean, message: string, sound?: boolean})} [deps.toggleSound]
 * @param {(line: string) => void} [deps.log]
 * @returns {{ok: boolean, message: string, action?: string, sound?: boolean, hint?: string}}
 */
export function executeDockAction(action, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  if (!DOCK_ACTIONS.includes(action)) {
    return { ok: false, message: `未知的地板动作:${String(action)}` };
  }
  const spawnDetached = (command, args, options) => {
    if (typeof deps.spawn !== 'function') throw new Error('spawn 未注入');
    const child = deps.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
    child?.unref?.();
  };
  const openUrl = (url) => {
    if (typeof deps.openUrl !== 'function') return null;
    return deps.openUrl(url);
  };

  if (action === 'panel') {
    const exe = String(deps.cooExe ?? '').trim();
    if (!exe) return { ok: false, message: '没有配置 Coopanion.exe(Config 的 `cooRoot`/`petExe`)' };
    try {
      spawnDetached(exe, [], { windowsHide: false });
      return { ok: true, action, message: '已启动 Coopanion' };
    } catch (err) {
      log(`启动 Coopanion 失败:${err?.message ?? err}`);
      return { ok: false, message: `启动 Coopanion 失败:${err?.message ?? err}` };
    }
  }

  if (action === 'figures') {
    const dir = String(deps.webDir ?? '').trim();
    if (!dir) return { ok: false, message: '形象包目录还没准备好' };
    try {
      if (process.platform === 'win32') spawnDetached('explorer.exe', [dir], { windowsHide: true });
      else if (process.platform === 'darwin') spawnDetached('open', [dir], {});
      else spawnDetached('xdg-open', [dir], {});
      return { ok: true, action, message: `已打开形象包目录:${dir}` };
    } catch (err) {
      log(`打开形象包目录失败:${err?.message ?? err}`);
      return { ok: false, message: `打开形象包目录失败:${err?.message ?? err}` };
    }
  }

  if (action === 'home' || action === 'mail') {
    const url = DOCK_URLS[action];
    const how = openUrl(url);
    if (!how) return { ok: false, message: `没有找到可用的浏览器,打不开 ${url}` };
    return { ok: true, action, message: `已用系统浏览器打开 ${url}` };
  }

  if (action === 'music') {
    if (typeof deps.toggleSound !== 'function') return { ok: false, message: '音效开关还没准备好' };
    const result = deps.toggleSound();
    return { ok: result?.ok !== false, action, message: result?.message ?? '已切换音效', sound: result?.sound };
  }

  // chat
  const panelUrl = String(deps.dshPanelUrl ?? '').trim();
  if (!panelUrl) {
    log('地板「聊天气泡」:还没配置 dshPanelUrl(本机 DSH 面板地址),这次忽略');
    return {
      ok: false,
      action,
      message: '还没配置 dshPanelUrl(本机 DSH 面板地址);请在插件 Config 里设置它(本机部署可用配置覆盖 bundle 注入)',
      hint: 'dshPanelUrl',
    };
  }
  if (!isHttpUrl(panelUrl)) return { ok: false, action, message: `dshPanelUrl 不是合法的 http(s) 地址:${panelUrl}` };
  const how = openUrl(panelUrl);
  if (!how) return { ok: false, action, message: `没有找到可用的浏览器,打不开 ${panelUrl}` };
  return { ok: true, action, message: `已用系统浏览器打开面板 ${panelUrl}` };
}
