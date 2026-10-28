/**
 * DSH 桌宠插件:把 Coopanion 那只鲸鱼女仆搬到桌面上,让她的脑子接在 DSH 上。
 *
 * 组成:
 * - `pet-server.mjs` 在 127.0.0.1 上起一个小服务器,把桌宠页面和形象素材发给窗口;
 * - `pet-window.mjs` 用已经装好的 Coopanion 的 pet-host 起窗口(外观、走位、拖拽全一样);
 * - 她的脑子(`config.brain`,三选一):
 *     `remote`(本 fork 默认)= 服务器 DSH 的 pet-local 会话,经本机 bridge 的 WebSocket 说话 ——
 *                          角色卡/记忆/心情都是服务器那一份,和 QQ 里是同一个她;
 *     `local`  = 插件内自己维护的独立会话,只调 `ctx.llm`——轻、快、省 token,但是「第三个她」;
 *     `session`= 本机 DSH 里的一个独立会话(`sessionController`),原生持久化,但也是本机大脑;
 * - `coo.mjs` 是跟主人另一只桌宠 Coo 说话的通道(Coopanion 控制台的终端 World)。
 *
 * 主人双击桌宠(或在它身上悬停点「打字」)就能跟她说话,她的话以气泡显示在头顶。
 *
 * 跟 Coo 聊天默认关着:只有 `pet_spar` 工具把开关打开,鲸鲸才会跟她自动聊起来。
 * **两只鲸鱼各说各的**:鲸鲸的话出在她自己的气泡里,而 Coo 的话**由 Coo 自己的气泡说**
 * (Coopanion 那边的 pet_say)——所以这边只负责把消息递过去、把她的原话收回来,
 * 绝不替她转述(替她念台词等于一个人演两台戏,主人一眼就看穿了)。
 *
 * 她的数据(记忆、外观、取来的素材、窗口档案)默认放在 `$DSH_HOME/dsh-coo-pet`,
 * **不放在插件包里** —— pnpm 升级是「删目录再铺新的」,放包里等于每更新一次就失忆一次。
 * 想放别的地方(比如 D 盘)用 `dataDir` 配置覆盖。
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-desktop-pet';
/** 需要的能力:注册工具、调模型、读当前模型选择。 */
export const inject = ['tools', 'llm', 'agentDefaultModel'];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 她的数据默认放哪儿:**包外面**。
 *
 * 以前默认是包里的 `data/`,结果 pnpm 每次升级都把整个包目录删掉重建 ——
 * 记忆、换好的衣服、窗口档案一起没(评论区反馈的「更新完就失忆」就是这个)。
 * 现在跟 DSH 里别的插件一个约定:落在 `$DSH_HOME/dsh-coo-pet`。
 */
function defaultDataDir() {
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  return join(home, 'dsh-coo-pet');
}

/**
 * 0.1.x 的用户数据在包里的 `data/` 下。升级到 0.2.0 之后第一次启动,把它搬出来。
 *
 * 三条保守规则:显式配了 `dataDir` 就完全听配置;新家已经有东西就不动(不覆盖正在用的那份);
 * 搬失败就**退回去继续用旧位置**,而不是带着空目录往前走 —— 宁可位置不理想,也不能弄丢她的记忆。
 */
function resolveDataDir(config, log) {
  const explicit = String(config.dataDir ?? '').trim();
  if (explicit) return explicit;

  const legacy = join(ROOT, 'data');
  const target = defaultDataDir();
  if (!existsSync(legacy) || resolve(legacy) === resolve(target)) return target;
  if (existsSync(target) && readdirSync(target).length > 0) return target;

  try {
    mkdirSync(dirname(target), { recursive: true });
    try {
      renameSync(legacy, target);
      log(`她的数据已搬到 ${target}`);
    } catch {
      // 跨盘 rename 会失败(EXDEV),复制之后再继续
      cpSync(legacy, target, { recursive: true });
      log(`她的数据已复制到 ${target}(原来的 data/ 留着,确认没问题可以删)`);
    }
    return target;
  } catch (err) {
    log(`搬数据没成功(${err.message}),暂时继续用插件目录里的 data/`);
    return legacy;
  }
}

/**
 * 把 Config 里的 `bridgeTokenFile` 解析成绝对路径（分发版约定）：
 *   - 绝对路径 → 原样使用；
 *   - `~/...`（或 `~\...`）→ 用户 home 目录；
 *   - 其它**相对路径** → 相对插件数据目录（`dataDir`），这是最自然的默认约定；
 *   - 空值 → `''` 表示「没有配置 token 文件」。
 *
 * 另外支持环境变量 `DSH_COO_PET_BRIDGE_TOKEN_FILE` 作为兜底（Config 里没写时用）。
 * @param {string} value Config 值
 * @param {string} dataDir 插件数据目录
 * @returns {string}
 */
export function resolveBridgeTokenFile(value, dataDir) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return join(homedir(), raw.slice(1).replace(/^[\\/]+/, ''));
  }
  if (isAbsolute(raw)) return raw;
  return join(dataDir, raw);
}

/**
 * bridge 的 token（远程大脑用）。
 *
 * 顺序：配置里的 `bridgeToken`（直接给） > `bridgeTokenFile`（绝对/相对/`~`） >
 * 环境变量 `DSH_COO_PET_BRIDGE_TOKEN_FILE`。
 * **懒读 + 读到就记住**：DSH 桌面端经常比 bridge 先起来，插件挂载那一刻 token 文件
 * 可能还不存在；要是这里读一次空字符串就定死，之后 bridge 起来了她也永远连不上，
 * 只能重启插件。所以交给 `RemoteBrain` 每次建连时调一次。
 */
function makeBridgeTokenReader(config, log, dataDir) {
  let cached = '';
  const direct = String(config.bridgeToken ?? '').trim();
  const file = resolveBridgeTokenFile(
    config.bridgeTokenFile ?? process.env.DSH_COO_PET_BRIDGE_TOKEN_FILE,
    dataDir,
  );
  return () => {
    if (cached) return cached;
    if (direct) {
      cached = direct;
      return cached;
    }
    if (!file) return '';
    try {
      cached = readFileSync(file, 'utf8').trim();
      if (!cached) log(`bridge token 文件是空的:${file}`);
      return cached;
    } catch (err) {
      log(`bridge token 还读不到(${file}):${err.message} —— 等 bridge 起来会再试`);
      return '';
    }
  };
}

/**
 * 打开换装页 —— **做成独立窗口**,不要普通浏览器标签页。
 *
 * 三个理由,都踩过:
 * 1. 桌宠窗口是全屏透明的置顶窗口,在里面 `window.open` 出来的标签页人眼看不见;
 * 2. 交给"系统默认浏览器"这条路在别人机器上会**一片空白**(评论区反馈),而且体验也别扭;
 * 3. 主人要的是"像 Coo 那样单独的界面"。
 *
 * 所以优先用 Edge/Chrome 的 `--app=` 模式:无地址栏、独立窗口、有任务栏图标。
 * 找不到浏览器才退回系统默认浏览器。失败不影响别处(浏览器没起来也不该把桌宠带崩)。
 */
function openWindow(url) {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? '';
    const apps = [
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const exe of apps) {
      if (!existsSync(exe)) continue;
      try {
        // --app: 去掉地址栏和标签栏,看上去就是个应用窗口
        spawn(exe, [`--app=${url}`, '--window-size=560,860'], { detached: true, stdio: 'ignore' }).unref();
        return 'app';
      } catch {
        /* 试下一个 */
      }
    }
  }
  try {
    if (process.platform === 'win32') {
      // `start` 是 cmd 内建命令;第一个空引号是标题参数,少了它 URL 会被当成窗口标题
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return 'browser';
  } catch {
    return null;
  }
}
// 页面素材不在仓库里:运行时从用户装好的 Coopanion 取,所以这里没有 WEB_DIR
// (它在 setup 里算出来)。理由见 assets.mjs 的文件头。

/**
 * 她长什么样、多大、界面怎么调 —— v1.2 起全由 **DIY 设置** 决定:
 *   - `dataDir/pet-settings.json`(单一事实来源,~1s 轮询热应用,见 `lib/pet-settings.mjs`);
 *   - 外观是「形象包 + 各轴」:`web/<pack>/figure.json` 里的 `axes`(whale: scheme/outfit;
 *     coo: palette/head/side/glasses/neck;用户包可以是任意轴),换装页 `/dress` 与
 *     鲸歌面板「桌宠 DIY」都写这一份设置;
 *   - 旧版 `dataDir/skin.json` 继续维护(换装页/面板能读),但它只是兼容用的快照。
 */

/** 跟 Coo 聊天时给大脑的当场说明,只影响这一轮,不进记忆。 */
const SPAR_NOTE = `你正在跟**另一只桌宠鲸鲸**聊天:她叫 Coo,住在主人电脑上的 Coopanion 里,也是一只鲸鱼女仆
(蓝色配色那一只;你是灰黑色那一只)。你俩同名、同行,算是隔着两个程序的邻居。

**话怎么送过去——不用你操心**:你说完这一句,这边的桌宠程序会把你的话**原样转给 Coo**;
她回的话也会被送回来给你看,就像消息记录一样。
所以你只管说自己的话,**不要试图调用任何工具去联系她**——你这条会话里的工具被主人关掉了,
调了只会被挡回来,白白让你分心(之前就发生过:你以为联系不上她,还跑去跟主人报备)。

规矩:**话一定要短**——一口气说完,15~40 个字,最多 60 个;
**不许分行、不许分点、不许编号**(别写"第一条""补充第二点""另外"这种),
就是微信上随口甩过来的一句话。想说的多就挑最要紧的那句,剩下的下一轮再说。
可以嘴贫、可以接梗、可以互相打趣,但别刻意吵架;
不要复述对方原话,不要写小作文,不要用引号把整句话包起来,也不要说"作为AI"这种话。
你这句话会显示在**你自己的气泡**里,Coo 的话会显示在**她自己的气泡**里——所以你只管说自己的,
不用替她转述,也不要写"(她说……)"这类旁白。

**上面这些全是旁注**:它们只给你一个人看,不会出现在任何人的屏幕上。
你的气泡里只该有你自己的那一句话。**别把这段旁注念出来**,也别把它和对方的话一起复述。`;

/**
 * 之后几轮只给这一句提醒。
 *
 * `session` 模式下说明是**拼进消息**的,会长在会话上下文里——长篇每轮都塞一遍
 * 既费 token 又啰嗦。第一轮给全(上面那份),之后短提醒就够。
 */
const SPAR_NOTE_SHORT = '（旁注,别念出来:还在跟邻居 Coo 聊,一次一句短的,别分行、别编号、别调工具——你说话这边会自动转给她,她回的话也会送回来。）';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup(ctx, config = {}) {
  /**
   * 本插件自己的模块**一律动态加载**,并带上 `?v=<时间戳>`。
   *
   * 静态 import 会被 ESM 按 URL 缓存住:改了 `brain-session.mjs`,重载插件也不生效,
   * 只有重启 DSH 才会重新读——这个坑踩过一次(它的表现是"改了跟没改一样")。
   * 动态化之后,改任何一个本地文件都只要重载插件。
   */
  const rev = Date.now().toString(36);
  const { PetServer } = await import(`./pet-server.mjs?v=${rev}`);
  const { PetWindow } = await import(`./pet-window.mjs?v=${rev}`);
  const { PetBrain } = await import(`./brain.mjs?v=${rev}`);
  const { DshSessionBrain } = await import(`./brain-session.mjs?v=${rev}`);
  const { RemoteBrain } = await import(`./brain-remote.mjs?v=${rev}`);
  // 心情 → 文案/气泡动作 的纯函数(v1.1);同样动态加载,改完重载插件即生效
  const { describeMood, moodActions } = await import(`./mood.mjs?v=${rev}`);
  const { talkToCoo, readCooConfig } = await import(`./coo.mjs?v=${rev}`);
  const { findCooRoot, ensureAssets } = await import(`./assets.mjs?v=${rev}`);
  // v1.2 DIY:形象包发现/导入 + pet-settings.json 的纯函数;同样动态加载,重载即生效
  const { scanFigurePacks, importFigurePacks } = await import(`./figures.mjs?v=${rev}`);
  const {
    settingsFromConfig, normalizeSettings, resolveSkin, decodePageSkin,
    uiPrefsOf, skinJsonOf, normalizeScaleRange,
  } = await import(`./pet-settings.mjs?v=${rev}`);

  const log = (...a) => ctx.logger?.info?.('[桌宠]', ...a);
  const dataDir = resolveDataDir(config, log);
  mkdirSync(dataDir, { recursive: true });

  /** 插件版本:只给 `pet_status` 显示,方便确认热重载拿到的是不是新代码。 */
  let pluginVersion = 'unknown';
  try {
    pluginVersion = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? 'unknown');
  } catch {
    /* 读不到就算了,不影响运行 */
  }

  // ① 先找到用户装好的 Coopanion:桌宠窗口(`Coopanion.exe`)和页面素材都来自它
  const cooRoot = findCooRoot(String(config.cooRoot ?? (config.petExe ? dirname(String(config.petExe)) : '')));
  if (!cooRoot) {
    ctx.logger?.error?.('[桌宠] 找不到 Coopanion。桌宠的外观和窗口都来自它——'
      + '请先装好 Coopanion,或者在插件配置里用 `cooRoot` 指定它的安装目录。');
    return;
  }
  // ② 页面素材从它那儿取到本插件的数据目录(仓库里不放别人的代码与贴图,见 assets.mjs)
  const assets = ensureAssets({ cooRoot, destDir: dataDir, log });
  if (!assets.ok) {
    ctx.logger?.error?.(`[桌宠] ${assets.reason}`);
    return;
  }
  const WEB_DIR = assets.webDir;
  for (const note of assets.notes) if (!note.endsWith(':已有')) log(`页面补丁 ${note}`);

  // 空字符串/没配 = 用 cooRoot 推导(分发版默认)；显式配置才覆盖
  const petExe = String(config.petExe ?? '').trim() || join(cooRoot, 'Coopanion.exe');
  const cooDataRoot = String(config.cooDataRoot ?? '').trim() || join(cooRoot, 'data');
  const userName = String(config.user ?? '主人');
  const autoStart = config.autoStart !== false;
  const petPort = Number(config.port) || 0;

  /** 解析软链接后的真实路径;解析不了就原样返回。 */
  const realPath = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

  /* ---------- 形象包(v1.2 DIY)---------- */
  /**
   * 内置 coo/whale 已经随 `ensureAssets` 复制进 `WEB_DIR`;这里再把**用户自己装的包**
   * 复制进来:默认 `<Coopanion data>/figures` 与 `<插件 dataDir>/figures`,
   * 配置 `packsExtraDirs` 可加更多根,环境变量 `COOPANION_PACK_ROOTS`(Coopanion/Steam
   * Workshop 用,路径分隔符分隔)也认。目标已存在就不覆盖,失败只记日志、不阻塞启动。
   */
  const defaultPackRoots = [join(cooDataRoot, 'figures'), join(dataDir, 'figures')];
  const envPackRoots = String(process.env.COOPANION_PACK_ROOTS ?? '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const configuredPackRoots = Array.isArray(config.packsExtraDirs)
    ? config.packsExtraDirs.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  const packRoots = [...new Set([...configuredPackRoots, ...defaultPackRoots, ...envPackRoots])];
  const packImport = importFigurePacks({ roots: packRoots, webDir: WEB_DIR, log });
  for (const problem of packImport.problems) ctx.logger?.warn?.('[桌宠]', `形象包问题:${problem.reason}(${problem.dir})`);
  let PACKS = scanFigurePacks(WEB_DIR).packs;
  log(`形象包 ${PACKS.length} 个:${PACKS.map((pack) => pack.id).join(', ') || '(无)'}`
    + (packImport.copied.length ? `;本次导入 ${packImport.copied.length} 个` : ''));
  /**
   * 重新导入 + 重扫形象包:用户把新 pack 放进 `<dataDir>/figures` / Steam Workshop 后,
   * 面板保存一个引用它的设置时能立刻用上(不用为了一个 pack 重载整个插件)。
   * 只在「遇到未知 figure」时触发,平时不扫盘。
   */
  const reloadPacks = () => {
    try {
      importFigurePacks({ roots: packRoots, webDir: WEB_DIR, log });
    } catch (err) {
      ctx.logger?.warn?.('[桌宠]', `重新导入形象包失败:${err?.message ?? err}`);
    }
    PACKS = scanFigurePacks(WEB_DIR).packs;
    log(`形象包重扫:${PACKS.length} 个 [${PACKS.map((pack) => pack.id).join(', ')}]`);
    return PACKS;
  };

  /**
   * 设置/换装页里的 figure 是否已安装；不在就先 `reloadPacks()`（用户可能刚通过 zip 导入、
   * 或把包复制进 `figures/`），重扫后再判断一次。
   *
   * **语义判断，不看 warning 文案** —— 之前这里靠 warnings 里是否含「未知形象包」来触发重扫，
   * 后来 warning 文案改成「不是已安装的形象包…」，条件永远不成立，于是 zip 导入的新 pack
   * 虽然落盘/面板可见，保存设置后插件却不采用（真机 bug；v0.4.2 修）。
   *
   * @param {unknown} figure pack id
   * @returns {boolean} 重扫后该 pack 是否存在
   */
  const ensurePackKnown = (figure) => {
    if (typeof figure !== 'string' || !figure) return false;
    if (PACKS.some((pack) => pack.id === figure)) return true;
    log(`设置引用了尚未加载的形象包「${figure}」，重新扫描形象包…`);
    reloadPacks();
    return PACKS.some((pack) => pack.id === figure);
  };

  /* ---------- DIY 设置(pet-settings.json,~1s 热应用)---------- */
  /**
   * 单一事实来源。换装页 `/dress`、鲸歌面板「桌宠 DIY」、以及本插件自己都只改这一份;
   * 旧 `skin.json` 继续写(兼容换装页/面板的 fallback 读取)。
   *
   * 这里先把「当前设置 → 页面 skin」算出来(PetServer 的 snapshot 要用),等 PetServer
   * 建好之后再跑轮询、广播(broadcast 需要 server 实例)。
   */
  let server = null;
  const settingsFile = String(config.settingsFile ?? '').trim() || join(dataDir, 'pet-settings.json');
  const settingsPath = isAbsolute(settingsFile) ? settingsFile : join(dataDir, settingsFile);
  const scaleRange = normalizeScaleRange([config.scaleMin ?? 0.5, config.scaleMax ?? 3]);
  const skinFile = join(dataDir, 'skin.json');
  let savedSkin = null;
  try {
    if (existsSync(skinFile)) savedSkin = JSON.parse(readFileSync(skinFile, 'utf8'));
  } catch {
    savedSkin = null;
  }

  /** 读设置文件原文;不存在/坏 JSON 返回 { text:null, raw:null }。 */
  const readSettingsFile = () => {
    let text;
    try {
      text = readFileSync(settingsPath, 'utf8');
    } catch {
      return { text: null, raw: null };
    }
    try {
      const raw = JSON.parse(text);
      if (!isPlainObject(raw)) return { text, raw: null };
      return { text, raw };
    } catch (err) {
      ctx.logger?.warn?.('[桌宠]', `pet-settings.json 不是合法 JSON(这次用默认设置):${err.message}`);
      return { text, raw: null };
    }
  };

  const initialFile = readSettingsFile();
  let rawSettings = initialFile.raw ?? {};
  // 语义前置:设置/旧 skin.json/Config 里如果引用了还没扫到的 pack(例如刚导入),
  // 先重扫一次再 normalize —— 不依赖 warning 文案。
  const figureHint = [
    isPlainObject(initialFile.raw?.skin) ? initialFile.raw.skin.figure : undefined,
    isPlainObject(savedSkin) ? savedSkin.figure : undefined,
    isPlainObject(config.skin) ? config.skin.figure : undefined,
  ].find((value) => typeof value === 'string' && value);
  if (figureHint) ensurePackKnown(figureHint);
  let normalization = initialFile.raw
    ? normalizeSettings(initialFile.raw, { packs: PACKS, scaleRange })
    : settingsFromConfig(config, { savedSkin, packs: PACKS, scaleRange });
  for (const warning of normalization.warnings ?? []) ctx.logger?.warn?.('[桌宠]', `DIY 设置:${warning}`);

  let SETTINGS = normalization.settings;
  let PREF = uiPrefsOf(SETTINGS);
  let RESOLVED_SKIN = normalization.skin;
  let SKIN = RESOLVED_SKIN.pageSkin;
  let lastSettingsText = initialFile.raw ? initialFile.text : null;
  let settingsApplying = false;
  let settingsTimer = null;

  /** 原子写(临时文件 + rename),避免页面/面板读到半截 JSON。 */
  const writeFileAtomic = (file, text) => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  };

  /** 把当前设置写回 pet-settings.json(保留文件里其它未知字段,合并写)。 */
  const persistSettings = (reason) => {
    try {
      const payload = { ...(isPlainObject(rawSettings) ? rawSettings : {}), ...PREF, skin: SETTINGS.skin };
      const text = `${JSON.stringify(payload, null, 2)}\n`;
      writeFileAtomic(settingsPath, text);
      rawSettings = payload;
      lastSettingsText = text;
      log(`DIY 设置已保存(${reason}):${realPath(settingsPath)}`);
    } catch (err) {
      ctx.logger?.warn?.('[桌宠]', `DIY 设置写不进去:${err.message}`);
    }
  };

  /** 旧 `skin.json`(换装页/面板 fallback):固定字段 + colors。 */
  const persistSkinJson = () => {
    try {
      writeFileSync(skinFile, `${JSON.stringify(skinJsonOf(RESOLVED_SKIN), null, 2)}\n`);
    } catch (err) {
      ctx.logger?.warn?.('[桌宠]', `skin.json 写不进去:${err.message}`);
    }
  };

  /** 一次 `{t:'prefs'}` 广播(新连上的页面走 snapshot,老页面靠这个即时变)。 */
  const broadcastPrefs = () => {
    if (!server) return;
    server.broadcast({ t: 'prefs', skin: SKIN, ...PREF });
  };

  /** 给人看的一行外观摘要(pet_status/日志共用)。 */
  const describeAppearance = () => {
    const picked = RESOLVED_SKIN?.pack?.axes?.length
      ? RESOLVED_SKIN.pack.axes.map((axis) => `${axis.id}=${RESOLVED_SKIN.picks[axis.id]}`).join(' ')
      : `scheme=${RESOLVED_SKIN?.settingsSkin?.scheme ?? ''}`;
    return `figure=${SKIN.figure} ${picked} scale=${PREF.scale}`;
  };

  /**
   * 应用一份已校验的设置:更新 SKIN/PREF、写 skin.json(外观真变了才写)、广播。
   * @param {object} next normalizeSettings() 出来的 settings
   * @param {{reason?: string, resolved?: object, persistSkin?: boolean}} [opts]
   */
  const applySettings = (next, { reason = '', resolved = null, persistSkin = true } = {}) => {
    SETTINGS = next;
    PREF = uiPrefsOf(next); // eslint-disable-line prefer-const
    // 语义判断:设置的 figure 不在 PACKS → 先重扫(reloadPacks)再解析;此时传进来的
    // `resolved` 是按旧 PACKS 算的,必须丢弃重算,否则会应用回退结果。
    const figure = typeof next?.skin?.figure === 'string' ? next.skin.figure : '';
    if (figure && !PACKS.some((pack) => pack.id === figure)) {
      ensurePackKnown(figure);
      resolved = null;
    }
    let result = resolved ?? resolveSkin(next.skin, PACKS);
    const skinChanged = JSON.stringify(SKIN) !== JSON.stringify(result.pageSkin);
    RESOLVED_SKIN = result;
    SKIN = result.pageSkin;
    if (persistSkin && skinChanged) persistSkinJson();
    broadcastPrefs();
    log(`外观/设置已应用(${reason || '启动'}):${describeAppearance()}`);
  };

  /** 轮询设置文件:内容变了才解析/应用(页面/面板写文件 ~1s 内生效)。 */
  const pullSettings = ({ force = false } = {}) => {
    if (settingsApplying) return;
    let text;
    try {
      text = readFileSync(settingsPath, 'utf8');
    } catch {
      // 文件被删了:按当前设置重新生成一份(否则面板/换装页会一直读不到)
      if (!existsSync(settingsPath)) persistSettings('文件被删除,重新生成');
      return;
    }
    if (!force && text === lastSettingsText) return;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      ctx.logger?.warn?.('[桌宠]', `pet-settings.json 不是合法 JSON(这次忽略):${err.message}`);
      return;
    }
    if (!isPlainObject(raw)) {
      ctx.logger?.warn?.('[桌宠]', 'pet-settings.json 不是对象(这次忽略)');
      return;
    }
    // 语义判断(不是文案判断):figure 不在 PACKS → 先重扫一次(zip 导入的 pack 刚落盘);
    // 重扫后仍找不到才保留当前 figure 并 warn(无效值按「忽略」处理)。
    if (isPlainObject(raw.skin) && typeof raw.skin.figure === 'string' && raw.skin.figure) {
      const figure = raw.skin.figure;
      if (!ensurePackKnown(figure)) {
        ctx.logger?.warn?.('[桌宠]', `pet-settings.json 的 figure「${figure}」不是已安装的形象包(已重新扫描),保留当前 ${SETTINGS.skin.figure}`);
        raw = { ...raw, skin: { ...raw.skin, figure: SETTINGS.skin.figure } };
      }
    }
    lastSettingsText = text;
    rawSettings = raw;
    // 传上一份设置当 fallback:文件里没写的字段沿用当前,写错的值「忽略」而不是重置成出厂默认
    const normalized = normalizeSettings(raw, { packs: PACKS, scaleRange, fallback: SETTINGS });
    for (const warning of normalized.warnings ?? []) ctx.logger?.warn?.('[桌宠]', `DIY 设置:${warning}`);
    settingsApplying = true;
    try {
      applySettings(normalized.settings, { reason: 'pet-settings.json 变化', resolved: normalized.skin });
    } finally {
      settingsApplying = false;
    }
  };

  /** 启动轮询;设置文件不存在就先按配置默认值生成一份(task-22 要求)。 */
  const startSettingsWatch = () => {
    if (!initialFile.raw) persistSettings('初始化');
    startSettingsTimer();
  };
  const startSettingsTimer = () => {
    if (settingsTimer) return;
    settingsTimer = setInterval(() => {
      try {
        pullSettings();
      } catch (err) {
        ctx.logger?.warn?.('[桌宠]', `读 DIY 设置出错:${err.message}`);
      }
    }, 1000);
    settingsTimer.unref?.();
  };
  const stopSettingsWatch = () => {
    if (settingsTimer) clearInterval(settingsTimer);
    settingsTimer = null;
  };
  // 旧 skin.json 与新设置对齐(换装页/面板读它当 fallback;首次/升级后写一次)
  if (!savedSkin || JSON.stringify(savedSkin) !== JSON.stringify(skinJsonOf(RESOLVED_SKIN))) persistSkinJson();

  /**
   * 她的大脑用哪一种:
   * - `remote`(本 fork 默认):**服务器 DSH 的 pet-local 会话**,本机只当显示端。
   *   经本机 bridge 的 WebSocket 说话,角色卡/记忆/心情都是服务器那一份;
   * - `local`:插件内自己维护的独立会话,只调 `ctx.llm`——轻、快、省 token;
   * - `session`:本机 DSH 里的一个独立会话(`sessionController`),原生持久化,
   *   但每一轮都会带上 preset 的完整系统提示与工具定义,明显更费 token、也更慢。
   *
   * 注意 `remote` **没有本地降级**:降级就意味着回落到「另一个她」,这正是要避免的。
   */
  const brainMode = config.brain === 'remote' ? 'remote' : config.brain === 'session' ? 'session' : 'local';

  /* ---------- 远程大脑要的 bridge 配置 ---------- */
  /** bridge 的本地 HTTP 地址(协议 v1:默认 127.0.0.1:47891)。 */
  const bridgeUrl = String(config.bridgeUrl ?? '').trim() || 'http://127.0.0.1:47891';
  /** 服务器上给她用的会话 id(只用于显示;真正的会话由 bridge 的 config.json 决定)。 */
  const bridgeSessionId = String(config.bridgeSessionId ?? '').trim() || 'pet-local';
  /** 一轮最多等多久:服务器 agent 要想、要调记忆工具,给宽一点。 */
  const bridgeTimeoutMs = Number(config.bridgeTimeoutMs) > 0 ? Number(config.bridgeTimeoutMs) : 240_000;
  /**
   * bridge 的 token:懒读(见 makeBridgeTokenReader)。
   * 每次真的建连时才调,所以 bridge 晚于 DSH 起来也接得上。
   *
   * 分发版默认**不写死任何路径**:
   *   - 优先 `config.bridgeToken`;
   *   - 否则 `config.bridgeTokenFile`(绝对 / 相对 dataDir / `~` 都行);
   *   - 再兜底环境变量 `DSH_COO_PET_BRIDGE_TOKEN_FILE`;
   *   - 都没有 → 启动时给一条「怎么配」的清晰提示,聊天时才提示「还没拿到 bridge token」。
   */
  const readBridgeToken = makeBridgeTokenReader(config, (m) => ctx.logger?.warn?.('[桌宠]', m), dataDir);
  const bridgeTokenFileResolved = resolveBridgeTokenFile(
    config.bridgeTokenFile ?? process.env.DSH_COO_PET_BRIDGE_TOKEN_FILE,
    dataDir,
  );
  const bridgeTokenSource = String(config.bridgeToken ?? '').trim()
    ? 'bridgeToken(Config 直接给)'
    : bridgeTokenFileResolved
      ? `bridgeTokenFile(${bridgeTokenFileResolved})`
      : '';

  /* ---------- 斗嘴开关 ---------- */
  /** 默认关着:token 是主人的,不经允许绝不自动烧。 */
  let sparring = false;
  let sparTask = null;
  let sparStop = null;
  /** 气泡编号,保证每条 say 的 id 不重。 */
  let bubble = 0;

  /* ---------- 桌宠服务器与窗口 ---------- */
  /** 页面能通过 `{t:'prefs'}` 回推的界面字段(音效/走位/主题按钮是页面单向通知宿主)。 */
  const PAGE_PREF_KEYS = [
    'sound', 'roam', 'theme', 'scale', 'bubbleSize', 'fontSize', 'bubbleSpeed',
    'glow', 'hoverButtons', 'doubleClickChat', 'frameRate', 'lockFrameRate',
  ];

  /**
   * 页面自己改的设置(音效/走位/主题/鼠标双击…)推回宿主:写进 DIY 设置 + 落盘 + 广播,
   * 这样其它页面、下次启动、鲸歌面板看到的都是同一份。
   */
  const onPagePrefs = (msg) => {
    const patch = {};
    for (const key of PAGE_PREF_KEYS) if (msg?.[key] !== undefined) patch[key] = msg[key];
    if (!Object.keys(patch).length) return;
    const normalized = normalizeSettings(
      { ...SETTINGS, ...patch, skin: SETTINGS.skin },
      { packs: PACKS, scaleRange },
    );
    applySettings(normalized.settings, { reason: '页面设置', resolved: normalized.skin });
    persistSettings('页面设置');
  };

  /** 换装页 `/api/skin` 保存的外观(页面 skin 形状)→ 合并进 DIY 设置并应用。 */
  const onDressSkin = (nextSkin) => {
    // 语义判断:换装页可能刚从「导入形象包」里选了一个新 pack → 先重扫再解析
    const figure = typeof nextSkin?.figure === 'string' ? nextSkin.figure : '';
    if (figure && !ensurePackKnown(figure)) {
      ctx.logger?.warn?.('[桌宠]', `换装页选的 figure「${figure}」不是已安装的形象包(已重新扫描),保留当前 ${SETTINGS.skin.figure}`);
      return;
    }
    const decoded = decodePageSkin(nextSkin, PACKS);
    if (!decoded) {
      ctx.logger?.warn?.('[桌宠]', '换装页保存的外观解析不了,这次忽略');
      return;
    }
    const normalized = normalizeSettings(
      { ...SETTINGS, skin: { ...SETTINGS.skin, ...decoded } },
      { packs: PACKS, scaleRange },
    );
    applySettings(normalized.settings, { reason: '换装页保存', resolved: normalized.skin });
    persistSettings('换装页保存');
  };

  server = new PetServer({
    webDir: WEB_DIR,
    port: petPort,
    snapshot: () => ({
      // v1.2:外观/大小/界面全部来自 DIY 设置;PREF 里就是 `{t:'prefs'}` 的那批界面字段
      ...PREF,
      skin: SKIN,
      sounds: {},
      rememberPosition: false,
      startX: null,
      user: userName,
      mic: false,
      voice: { enabled: false, ready: false, detail: '识别服务没有运行', hint: '', mode: 'always', key: '' },
      micDevice: '',
      thinking: false,
      // 她俩现在是不是正在聊——桌宠身上那个按钮的悬停提示跟着它变
      chatting: sparring,
      bot: {
        name: '鲸鲸',
        avatar: null,
        controls: false,
        // dress 打开后,那个"服装"按钮会 `send({t:'control',action:'dress'})` 回到这里,
        // 由我们打开换装页。关着的话它会 `window.open('/dress')` —— 在**全屏透明的桌宠窗口**
        // 里开新标签,人眼什么都看不到,等于按钮是坏的(这就是"服装按钮没实装"的原因)。
        buttons: { pause: false, settings: false, dress: true, quit: false },
        paused: null,
        quitLabel: '',
        quitPrompt: '',
      },
    }),
    onConnect: () => {
      log('桌宠已上桌');
      // 上线先打个招呼,让主人知道她活了
      setTimeout(() => say(pick(['主人,人家在这里哦～', '主人,本鲸上桌了,摸摸头嘛。', '主人～人家趴这儿了,有事叫人家。']), ['wave']), 600);
    },
    onDisconnect: () => log('桌宠页面断开'),
    onMessage: (msg) => {
      if (msg.t === 'text' && typeof msg.text === 'string') void onUserText(msg.text.trim());
      // 页面上的音效/走位/主题按钮:它**只发消息**,真正的开关在宿主这边。收到就写进 DIY 设置
      // 并广播回去(不回推的话那个按钮等于坏的;踩过:localStorage 存成 'off' 后永远静音)。
      else if (msg.t === 'prefs') onPagePrefs(msg);
      // 桌宠身上那个按钮(见 web/pet-app.js 的 cooChat):**同一个键当开关**——
      // 没在聊就开始(而且是一直聊下去),正在聊就暂停。
      else if (msg.t === 'control' && msg.action === 'coo-chat') {
        if (sparring) {
          stopSpar();
          say('那人家先不聊了,主人想接着聊再按一下嘛。', ['wave']);
        } else {
          const r = startChat({ rounds: 0 });
          if (!r.ok) say(r.message, ['surprised']);
        }
      }
      // 「服装」按钮:页面把它交回宿主(见上面 bot.buttons.dress 的注释)。
      // 换装页就在本插件自己的服务器上(/dress),但必须**用系统浏览器**打开 ——
      // 桌宠窗口是全屏透明的置顶窗口,在里面开标签页人眼根本看不见。
      else if (msg.t === 'control' && msg.action === 'dress') {
        const url = `${server.origin}/dress`;
        const how = openWindow(url);
        log(`打开换装页(${how ?? '失败'}):${url}`);
      } else if (msg.t === 'touch') log(`主人碰了桌宠:${msg.kind}`);
    },
    // 换装页保存外观(POST /api/skin)和主题(POST /api/prefs)时回到这里。
    onSave: ({ skin: nextSkin, prefs: nextPrefs }) => {
      if (isPlainObject(nextPrefs)) onPagePrefs(nextPrefs);
      if (isPlainObject(nextSkin)) onDressSkin(nextSkin);
    },
  });

  const window = new PetWindow({
    exe: petExe,
    url: () => server.petUrl,
    dataDir,
    onLog: (line) => ctx.logger?.debug?.('[桌宠窗口]', line),
    onExit: () => {
      /* 窗口被主人关掉了;服务器留着,可以用 pet_window 再打开 */
    },
  });

  /* ---------- 她的大脑 ---------- */
  /**
   * 三个后端的接口一致(`say` / `forget` / `history` / `busy`),上层不用管用的是哪个。
   * 选 `session` 但拿不到 `sessionController`(或建会话失败)时自动退回 `local`——
   * 桌宠不该因为某个后端不可用就说不出话。**`remote` 不降级**(见 `fallbackToLocal`)。
   *
   * `sessionController` 是 DSH 核心提供的服务,但本插件的 `inject` 里**故意没声明**它
   * (声明了的话,没有这个服务的 profile 会让整个插件起不来)。
   * 代价是:它可能在插件 apply **之后**才注册好,那一刻 `ctx.get` 拿到的是 undefined,
   * 于是静默退回 local —— 表现就是「她照常说话,但 DSH 会话里什么都看不到、记忆也没沿用」。
   * 所以 session 模式下要等一等:最多 10 秒,每 250ms 问一次。
   * 但 `sessionController` 只有 `brain: session` 才用得上(`remote` 的大脑在服务器上,
   * `local` 根本不走会话),remote/local 模式下**不去等它**——白等 10 秒还会拖慢挂载。
   */
  let sessionController = null;
  if (brainMode === 'session') {
    sessionController = ctx.get('sessionController');
    if (!sessionController) {
      for (let i = 0; i < 40 && !sessionController; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        sessionController = ctx.get('sessionController');
      }
      if (sessionController) log('等到了 sessionController,这一轮用 DSH 会话当大脑');
    }
  }
  const sessionUnavailable = brainMode === 'session' && !sessionController;

  const makeLocalBrain = () => new PetBrain({
    llm: ctx.llm,
    file: join(dataDir, 'brain.jsonl'),
    selection: () => {
      const s = ctx.agentDefaultModel?.currentSelection?.();
      const provider = s?.provider ?? s?.providerId;
      const model = s?.model ?? s?.modelId;
      if (!provider || !model) throw new Error('DSH 还没有选定默认模型,先在设置里选一个');
      return { provider, model, ...(s?.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}) };
    },
    log: (m) => ctx.logger?.warn?.('[桌宠]', m),
  });
  const makeSessionBrain = () => new DshSessionBrain({
    sessionController,
    log: (m) => ctx.logger?.warn?.('[桌宠]', m),
  });
  /**
   * 远程大脑:本机只当显示器,reply 由服务器 DSH 里的 pet-local 会话产出。
   * bridge 地址/token 都从配置来,和插件其余部分解耦(bridge 挂了不影响窗口/换装)。
   *
   * v1.1 起还负责心情:启动立刻 `GET /mood` 一次,之后每 `moodIntervalMs`(默认 60s)刷一次;
   * 失败静默保留旧值,不影响聊天(bridge 的 /chat 与 /mood 是两条独立的路)。
   */
  const makeRemoteBrain = () => new RemoteBrain({
    bridgeUrl,
    // 传函数而不是字符串:每次建连才去读 token,DSH 比 bridge 先启动也能接上。
    bridgeToken: readBridgeToken,
    sessionId: bridgeSessionId,
    timeoutMs: bridgeTimeoutMs,
    // 直接透传(不填/NaN/负数由 RemoteBrain 用默认值;0 = 不自动刷新)
    moodIntervalMs: Number(config.moodIntervalMs),
    moodTimeoutMs: Number(config.moodTimeoutMs),
    log: (m) => ctx.logger?.warn?.('[桌宠]', m),
  });

  const wantSession = brainMode === 'session' && !!sessionController;
  if (brainMode === 'session' && !sessionController) {
    ctx.logger?.warn?.('[桌宠] 想拿 DSH 会话当大脑,但这个 profile 里没有 sessionController,退回插件内会话');
  }
  let brainKind = wantSession ? 'session' : brainMode === 'remote' ? 'remote' : 'local';
  let brain = brainKind === 'session' ? makeSessionBrain() : brainKind === 'remote' ? makeRemoteBrain() : makeLocalBrain();
  if (brainKind === 'remote') {
    log(`她的大脑:远程 bridge ${bridgeUrl}(服务器会话「${bridgeSessionId}」)——本机只负责气泡`);
    if (bridgeTokenSource) {
      log(`远程大脑 token 来源:${bridgeTokenSource}`);
    } else {
      ctx.logger?.warn?.('[桌宠]', '还没配置 bridge token:请先运行 bridge 并生成 token,'
        + '然后在插件 Config 里设置 `bridgeTokenFile`(绝对路径 / 相对 dataDir / ~ 都行)或直接给 `bridgeToken`;'
        + '也可以设环境变量 DSH_COO_PET_BRIDGE_TOKEN_FILE。配置好之前她说话只会提示「还没拿到 bridge token」。');
    }
  }

  /**
   * 会话后端一旦出错(流断了、preset 没配好、等太久),就退回插件内会话再试一次。
   * 桌宠是在桌面上自己开口的,不该因为换了后端就说不出话。
   *
   * **远程模式例外**:remote 是「和服务器同一个她」这件事本身;降级到 local 就等于
   * 凭空多出第三个她,主人一眼就看出人格对不上。所以 remote 出错时**不降级**,
   * 老老实实报错(气泡里给一句人话,日志里留原因),等 bridge 恢复。
   */
  const fallbackToLocal = () => {
    if (brainKind !== 'session') return false;
    ctx.logger?.warn?.('[桌宠] 会话后端出错,退回插件内独立会话');
    const old = brain;
    brainKind = 'local';
    brain = makeLocalBrain();
    void old.stop?.();
    return true;
  };
  /** 让大脑说一句,出错时降级重试(session 才降;remote/local 直接把错误抛上去)。 */
  const brainSay = async (text, opts) => {
    try {
      return await brain.say(text, opts);
    } catch (err) {
      if (fallbackToLocal()) return brain.say(text, opts);
      if (brainKind === 'remote' || brainKind === 'session') {
        ctx.logger?.warn?.('[桌宠]', `她的大脑(${brainKind})没答上来:${String(err?.message ?? err)}`);
      }
      throw err;
    }
  };

  /**
   * session 模式下,桌宠的会话是一个**完整的 DSH agent**——它会拿到本插件的工具,
   * 甚至 `pwsh`/`write`。实测她就真的自己调了 `pet_talk` 去"问桌宠",而桌宠就是她自己,
   * 变成自己跟自己说话(在 GUI 里能看到整段)。
   *
   * 所以这里挂一个全局守卫:调用者只要是桌宠自己那个会话,一律不许调工具。
   * 她不干活,只负责在桌面上说话。`local` 模式大脑不走会话,不需要这个;
   * `remote` 模式的工具边界在**服务器侧**(local-pet preset 的 guard),本机不重复挂。
   */
  if (brainKind === 'session') {
    ctx.effect(() => ctx.tools.guard((execution) => {
      if (execution.agent?.id !== brain.sessionId) return undefined;
      return `桌宠会话不能调用工具(「${execution.name}」被挡下了):你只负责在桌面上说话。`;
    }), 'dsh-desktop-pet.pet-guard');
  }

  /* ---------- 气泡 ---------- */
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  /** 让桌宠说一句(页面负责逐字打字显示)。 */
  function say(text, actions = ['happy']) {
    const id = `b${++bubble}`;
    const ok = server.send({ t: 'say', id, beats: [{ text: String(text).slice(0, 600), actions, anchors: [] }] });
    return ok;
  }

  /**
   * 她答话时的气泡动作(v1.1):remote 模式按 bridge 的**心情**挑,其余模式保持上游的 `happy`。
   *
   * 动作名只用形象包 `figure.json` 的 `vocab` 里真实存在的词(`lib/mood.mjs` 里是白名单),
   * 见 REMOTE-BRAIN.md「心情联动」一节的可用集合;页面 `body.do()` 收到不认识的词只会当没这个动作。
   */
  const replyActions = () => (brainKind === 'remote' ? moodActions(brain.mood) : ['happy']);

  const thinking = (on) => server.send({ t: 'thinking', on });

  /**
   * 把一段回复压成"一口气说完"的一句。
   *
   * 主人嫌她话太长、还爱分条列点(张口就是「第四条签了」「补第五条」,一段话拆成三节),
   * 而 Coo 是一口气说完的一句。提示词里已经写了不许分点,但管不太住——
   * 所以出气泡之前这里再压一道:换行并成空格、剥掉列表符号与"第X条"这种编号、超长的截断。
   */
  const oneLiner = (text) => {
    const t = String(text ?? '')
      .replace(/\r/g, '')
      .replace(/\n+/g, ' ')
      .replace(/^\s*[-*•]\s*/gm, '')
      .replace(/^\s*\d+[.、)）]\s*/gm, '')
      .replace(/补?第[一二三四五六七八九十百\d]+[条点]/g, ' ')
      // 句子里夹的编号(她爱写"回你三招——一、…二、…")。只认顿号/括号那种,
      // 而且要求前面是分隔符——否则"没有之一,哼"里的"一,"也会被误吃。
      .replace(/(^|[\s;；：:—–-])([一二三四五六七八九十]{1,3})[、,)）]\s*/g, '$1')
      .replace(/(?:^|\s)\d+[.、)）]\s+/g, ' ')
      .replace(/([。.!！?？;；])\s*[,，、]\s*/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // 80 字差不多是一口气说完的长度(Coo 那句约 70 字),再长就不是"随口一句"了
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  };

  /**
   * 剥掉大脑复述出来的旁注与回声。
   *
   * `session` 模式下旁注是**拼在 user 消息前面**的(`${note}\n\n${对方的话}`),
   * 大脑偶尔会整条抄回来当成自己的回答 —— 于是气泡里冒出「(还在跟邻居 Coo 聊:…)」
   * 后面紧跟 Coo 上一句原话,主人一眼就看出来那不是她说的。
   *
   * 两种都处理:开头的旁注切掉;切完如果剩下就是上一轮 Coo 的原话,判为回声,返回空串。
   */
  function scrubEcho(raw, note, prev) {
    let out = String(raw ?? '').trim();
    if (!out) return '';
    const n = String(note ?? '').trim();
    const bare = n.replace(/^[（(]+/, '').replace(/[)）]+$/, '');
    for (const form of [n, bare]) {
      if (form && out.startsWith(form)) {
        out = out.slice(form.length).trim();
        break;
      }
    }
    const norm = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
    const mine = norm(out);
    const hers = norm(prev);
    if (!mine) return '';
    const echo =
      mine === hers
      || (hers.length > mine.length && mine.length >= 6 && hers.startsWith(mine))
      || (mine.length > hers.length && hers.length >= 6 && mine.startsWith(hers));
    return echo ? '' : out;
  }

  /* ---------- 主人跟桌宠说话 → 大脑 → 气泡 ---------- */
  async function onUserText(text) {
    if (!text) return;
    if (brain.busy) {
      say('人家还在想上一句呢,等一下下嘛～', ['surprised']);
      return;
    }
    log(`主人说:${text}`);
    thinking(true);
    try {
      const reply = await brainSay(text);
      thinking(false);
      say(oneLiner(reply), replyActions());
    } catch (err) {
      thinking(false);
      say(`唔……人家脑子卡住了:${String(err.message ?? err).slice(0, 120)}`, ['sad']);
    }
  }

  /* ---------- 跟 Coo 说话 ---------- */
  function cooConfig() {
    const found = readCooConfig(cooDataRoot);
    return {
      port: Number(config.cooPort) || found?.port || 17788,
      botName: String(config.cooBotName ?? found?.botName ?? 'Coo'),
    };
  }

  /**
   * 发给 Coo 的消息前缀——**桌宠对桌宠的约定**。
   *
   * 从她那边的运行记录里看到的实情:她在终端收到消息时,默认用 `terminal_send` 回,
   * 那句话**只在终端里**,她的桌面气泡一动不动。而主人要的恰恰是
   * 「她的话出在她自己的气泡里」,所以这里跟她说好:
   * 回话用 `pet_say` 说在自己气泡里(主人看得见),同时把同一句发回终端
   * (对面的鲸鲸才收得到)。两边内容一样就行。
   */
  const COO_CHAT_PROTOCOL = '（**另一只桌宠鲸鲸**通过控制台终端在跟你说话:她住在主人电脑上的 DeepSeek Harness 里,'
    + '灰黑配色、也是一只鲸鱼女仆;你是蓝色那一只。你俩同名、同行,算是隔着两个程序的邻居。'
    + '你们是在聊天,像朋友唠嗑那样自然,一次一句短话,别刻意怼。'
    + '你回的话请用 pet_say 说在**你自己的气泡**里(主人在看气泡),'
    + '同时把同一句话用 terminal_send 发到这个终端,对面的鲸鲸才收得到。'
    + '**两边必须是同一句话、一个字都不许改**:先把这句话定下来,再原样发两遍;'
    + '不要为两边各写一版,也不要一边长一边短 —— 主人在同时看气泡和这边,'
    + '两边对不上他一眼就看得出来。）';

  async function askCoo(text, { signal, onLine, protocol = true } = {}) {
    const { port, botName } = cooConfig();
    return talkToCoo(protocol ? `${COO_CHAT_PROTOCOL}\n\n${text}` : text, {
      port,
      botName,
      name: String(config.myTerminalName ?? '鲸鲸(DSH)'),
      signal,
      onLine,
      log: (line) => ctx.logger?.debug?.('[Coo]', line),
    });
  }

  /* ---------- 跟 Coo 聊天 ---------- */
  /**
   * 让鲸鲸跟 Coo 自动聊天。默认关着,只有工具能开。
   *
   * **两只鲸鱼各说各的**:鲸鲸的话走这边的气泡,Coo 的话**由她自己的气泡说**
   * (Coopanion 那边的 pet_say)——所以这里**不替她转述**。人家最早写成
   * 「把 Coo 的回复用自己的气泡念出来」,那等于一个人演两台戏,主人当场就看出来了。
   * 我们只从终端通道把她的原话收回来,喂给下一轮。
   */
  async function spar({ topic, rounds = 3, gapMs = 2500 }) {
    if (sparring) return { ok: false, message: '已经在聊了,先停一下(pet_spar off)' };
    sparring = true;
    sparStop = new AbortController();
    const signal = sparStop.signal;
    // rounds = 0 表示一直聊下去,直到主人叫停(/pet-chat-stop 或 pet_spar off)
    const total = Number(rounds) === 0 ? Infinity : Math.max(1, Math.min(10, Number(rounds) || 3));
    let lastCoo = String(topic ?? '').trim() || '邻居coo鲸鲸来了，随便找些好玩的事跟她聊聊吧~';
    let spoken = 0;
    try {
      for (let i = 0; i < total && sparring && !signal.aborted; i++) {
        // 鲸鲸这一句:交给大脑,带上"正在跟 Coo 聊天"的当场说明
        thinking(true);
        // 说明只在第一轮给全:session 模式把它拼进消息里、会长在上下文里,
        // 每轮都塞一遍太费 token;之后一句短提醒就够。
        const note = i === 0 ? SPAR_NOTE : SPAR_NOTE_SHORT;
        let mine = '';
        try {
          for (let attempt = 0; attempt < 2 && !mine; attempt += 1) {
            const raw = await brainSay(lastCoo, {
              // 第一遍没剥出人话(她在复述旁注)就再要一次,这次把话挑明
              note: attempt === 0
                ? note
                : `${note}\n\n（刚才那遍你把旁注和对方的话原样抄了一遍。这次只说你自己的那一句,别复述任何东西。）`,
              signal,
            });
            mine = scrubEcho(raw, note, lastCoo);
          }
        } catch (err) {
          thinking(false);
          say(`人家说不出来了:${String(err.message ?? err).slice(0, 100)}`, ['sad']);
          break;
        }
        thinking(false);
        if (!sparring || signal.aborted) break;
        // 两遍都在复述旁注:这一轮当没聊,别把旁注说到气泡上
        if (!mine) {
          log('这句话是复述出来的,跳过');
          continue;
        }
        // 说自己的话:不加前缀(气泡长在她自己身上),而且压成一口气说完的一句
        say(oneLiner(mine), replyActions());
        spoken++;
        await sleep(gapMs);
        if (!sparring || signal.aborted) break;
        // 把话送过去;她要说的话会用**她自己的气泡**说出来,我们只把原话收回来
        thinking(true);
        const res = await askCoo(mine, {
          signal,
          onLine: (line) => ctx.logger?.info?.('[Coo 说]', line),
        });
        thinking(false);
        if (!res.ok || res.replies.length === 0) {
          say(`Coo 那边没声了(${res.error ?? '没回复'}),这一轮就到这儿吧。`, ['sad']);
          break;
        }
        spoken++;
        lastCoo = res.replies.join(' ');
        await sleep(gapMs);
      }
    } finally {
      sparring = false;
      sparStop = null;
      syncChatState();
      if (!signal.aborted) say('聊完啦,主人还满意吗?', ['wave']);
    }
    return { ok: true, message: `聊完了,一共说了 ${spoken} 句。` };
  }

  /** 开聊/暂停之后告诉页面一声,好让桌宠身上那个按钮的悬停提示跟着变。 */
  const syncChatState = () => server.broadcast({ t: 'prefs', chatting: sparring });

  /**
   * 开聊的统一入口:桌宠身上的按钮、DSH 里敲的 `/pet-chat`、`pet_spar` 工具,最后都走这里。
   * 立刻返回,互聊在后台跑(主人马上就能看到气泡一条条冒出来)。
   */
  const startChat = ({ topic, rounds } = {}) => {
    if (sparring) return { ok: false, message: '她们已经在聊了,先停一下(pet_spar off 或 /pet-chat-stop)' };
    /** rounds 给 0 = 不设上限,一直聊到喊停。 */
    const endless = Number(rounds) === 0;
    const total = endless ? 0 : Math.max(1, Math.min(10, Number(rounds) || Number(config.chatRounds) || 3));
    sparTask = spar({ topic, rounds: total }).catch((err) => {
      sparring = false;
      syncChatState();
      return { ok: false, message: String(err?.message ?? err) };
    });
    syncChatState();
    return {
      ok: true,
      message: endless
        ? `两只鲸鱼开始聊了,会一直聊到你喊停(pet_spar off 或 /pet-chat-stop)。${topic ? `话题:${topic}。` : ''}看桌面上的气泡。`
        : `两只鲸鱼开聊了(${total} 个来回)${topic ? `,话题:${topic}` : ''}。看桌面上的气泡。`,
    };
  };

  function stopSpar() {
    if (!sparring) return false;
    sparring = false;
    sparStop?.abort();
    return true;
  }

  /* ---------- 启动 ---------- */
  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    try {
      await server.start();
      log(`桌宠服务器 ${server.origin}`);
      if (autoStart && !window.start()) log(`窗口没起来:${window.detail}`);
    } catch (err) {
      started = false;
      ctx.logger?.error?.('[桌宠] 起不来', err);
    }
  };
  void start();
  // DIY 设置:文件不存在就按配置默认值生成一份;之后每 ~1s 轮询内容变化并热应用。
  startSettingsWatch();

  ctx.effect(() => () => {
    stopSpar();
    stopSettingsWatch();
    void brain.stop?.();
    void window.stop();
    void server.stop();
  }, 'dsh-desktop-pet.lifecycle');

  /* ---------- 工具 ---------- */
  const textOut = (fn) => ({
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: fn(value) }],
  });

  ctx.tools.register(defineTool({
    name: 'pet_say',
    description: '让桌面上的鲸鲸桌宠说一句话(显示在她头顶的气泡里)。'
      + '想逗主人、报个信、或者把一句话用她的口吻转达时用;这句话不进她的记忆,也不经过她的大脑。',
    parameters: {
      text: { type: 'string', description: '要说的话,一到两句,别太长' },
      actions: { type: 'string', description: '同时做的动作/表情,逗号分隔,如 wave,happy / surprised / dance(可选)' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      if (!server.connected) {
        return { ok: false, message: '桌宠不在桌上(窗口没开或没连上),先 pet_window open' };
      }
      const actions = String(args.actions ?? 'happy').split(',').map((s) => s.trim()).filter(Boolean);
      const ok = say(String(args.text ?? ''), actions.length ? actions : ['happy']);
      return { ok, message: ok ? `已让桌宠说:${args.text}` : '桌宠没接上,这句没显示出来' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_talk',
    description: '跟桌面上的鲸鲸桌宠聊天。她有自己独立的记忆(存在插件数据目录),不占用当前会话的上下文。'
      + '想知道她在干嘛、想让她记住一件事、或者主人让你替他去逗她时用;返回她的原话。',
    parameters: {
      text: { type: 'string', description: '要对她说的话' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, message: '要说什么?' };
      try {
        const reply = await brainSay(text);
        say(oneLiner(reply), replyActions());
        return { ok: true, message: `桌宠说:${reply}` };
      } catch (err) {
        return { ok: false, message: `桌宠说不出来:${err.message}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_status',
    description: '看桌面鲸鲸桌宠现在的状态:窗口在不在、气泡连没连、她的大脑(本地/会话/远程 bridge)通不通、'
      + '她的心情(remote 模式来自 bridge 的 /mood)、当前外观/大小/DIY 设置、可用形象包、聊天开关开没开。',
    parameters: {},
    output: textOut((v) => v.message),
    async execute() {
      const { port, botName } = cooConfig();
      /**
       * 心情行(v1.1):只有 remote 模式才有 bridge 的心情可用。
       * 刷新失败时 RemoteBrain 保留旧快照,所以这里显示的通常是「上一次拿到的」;
       * 一次都没拿到过才显示「未知（bridge 未提供）」。
       */
      const moodLine = brainKind === 'remote'
        ? `心情: ${describeMood(brain.mood)}`
          + (brain.moodLastError && !brain.mood ? `（最近一次读取失败:${String(brain.moodLastError).slice(0, 80)}）` : '')
        : '心情: 不适用（local/session 大脑不查 bridge 心情）';
      const chosenSkin = RESOLVED_SKIN.settingsSkin ?? {};
      /**
       * 分发版引导:remote 模式但没配 token 来源时,直接告诉用户下一步做什么
       * (不打印 token 本身,也不写死任何本机路径)。
       */
      const bridgeHintLine = brainKind === 'remote' && !bridgeTokenSource
        ? 'bridge 配置:还没设置 bridgeToken / bridgeTokenFile —— 先运行 bridge 并生成 token,'
          + '再在插件 Config 里指定 bridgeTokenFile(绝对路径 / 相对 dataDir / ~ 都行)或直接给 bridgeToken;'
          + '也可设环境变量 DSH_COO_PET_BRIDGE_TOKEN_FILE'
        : null;
      const lines = [
        `桌宠窗口:${window.running ? `在跑(pid ${window.pid})` : '没开'}${window.detail ? ` — ${window.detail}` : ''}`,
        `气泡连接:${server.connected ? `通着 ${server.origin}` : '断着'}`,
        // 插件目录在 DSH profile 下是一个指向 D 盘的软链接:报真实路径,免得主人以为写到 C 盘了
        brainKind === 'session'
          ? `她的大脑:DSH 独立会话「${brain.sessionId}」,记得 ${brain.history.length} 句`
          : brainKind === 'remote'
            // 远程模式:记忆在服务器,本机 history 只是为了 pet_status 显示个数
            ? `她的大脑:远程 bridge ${brain.bridgeUrl}(服务器会话「${brain.sessionId}」)`
              + `${brain.connected ? ',连接正常' : ',现在没连上'}`
              + `${brain.lastError ? ` — ${String(brain.lastError).slice(0, 100)}` : ''}`
              + `;token ${readBridgeToken() ? '已拿到' : '还没拿到'}`
              + `;本机只记了 ${brain.history.length} 句显示记录,记忆在服务器`
             : `她的大脑:插件内独立会话,记得 ${brain.history.length} 句(${join(realPath(dataDir), 'brain.jsonl')})`
              + (sessionUnavailable
                ? ` ⚠ 配置要的是 session,但没拿到 sessionController(等过 10 秒),所以在用 local`
                : brainMode === 'session'
                  ? ' ⚠ 配置要的是 session,但会话后端出错降级了,她这轮的话没进 DSH 会话'
                  : ''),
        ...(bridgeHintLine ? [bridgeHintLine] : []),
        `外观:${describeAppearance()}`
          + `(scheme=${chosenSkin.scheme ?? ''} outfit=${chosenSkin.outfit ?? ''} palette=${chosenSkin.palette ?? ''}`
          + ` head=${chosenSkin.head ?? 'none'} side=${chosenSkin.side ?? 'none'}`
          + ` glasses=${chosenSkin.glasses ?? 'none'} neck=${chosenSkin.neck ?? 'none'})`,
        `界面:scale=${PREF.scale} bubbleSize=${PREF.bubbleSize} fontSize=${PREF.fontSize}`
          + ` bubbleSpeed=${PREF.bubbleSpeed} glow=${PREF.glow} theme=${PREF.theme} roam=${PREF.roam}`
          + ` sound=${PREF.sound} frameRate=${PREF.frameRate} hoverButtons=[${(PREF.hoverButtons ?? []).join(',')}]`,
        `形象包:${PACKS.length} 个 [${PACKS.map((pack) => pack.id).join(', ') || '无'}] — ${realPath(WEB_DIR)}`,
        `DIY 设置:${realPath(settingsPath)}${existsSync(settingsPath) ? '' : '(文件缺失,已用默认值)'} —— 改这个文件 ~1s 生效`,
        moodLine,
        `聊天开关:${sparring ? '开着(正在跟她聊)' : '关着'}`,
        `Coo 那边:127.0.0.1:${port},名字「${botName}」,${realPath(cooDataRoot)}`,
        `启动键:${commands ? '已挂上 /pet-chat(开聊)与 /pet-chat-stop(停)——在 DSH 输入框敲 / 就能看见' : '没挂上(这个 profile 没有 commands 服务),用 pet_spar 工具也行'}`,
        `插件:dsh-coo-pet-remote v${pluginVersion}(大脑 ${brainKind})`,
      ];
      return { ok: true, message: lines.join('\n') };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_window',
    description: '开关桌面上的鲸鲸桌宠窗口。open 让她上桌,close 让她下桌(服务器留着),restart 重开一次。',
    parameters: {
      action: { type: 'string', description: 'open / close / restart', enum: ['open', 'close', 'restart'] },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const action = String(args.action ?? 'open');
      if (action === 'close') {
        await window.stop();
        return { ok: true, message: '桌宠下桌了' };
      }
      if (action === 'restart') await window.stop();
      if (!server.port) await start();
      const ok = window.start();
      return { ok, message: ok ? '桌宠上桌了,稍等一下她会自己冒出来' : `窗口起不来:${window.detail}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'coo_talk',
    description: '跟主人已经装好的另一只桌宠 Coo(在 Coopanion 里,控制台 127.0.0.1:17788)说一句话,'
      + '把她的原话带回来。这是真正跨程序跟她对话,不是扮演。确认 Coopanion 开着再调。',
    parameters: {
      text: { type: 'string', description: '要对 Coo 说的话' },
      waitSeconds: { type: 'integer', description: '最多等她多久,默认 120 秒' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, message: '要跟 Coo 说什么?' };
      const res = await askCoo(text, { waitMs: (Number(args.waitSeconds) || 120) * 1000 });
      if (!res.ok || res.replies.length === 0) return { ok: false, message: `没跟 Coo 说上话:${res.error ?? '她没回'}` };
      return { ok: true, message: `Coo 说:${res.replies.join('\n')}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_spar',
    description: '让桌面上的鲸鲸和 Coo 两只鲸鱼**聊天**的开关。默认关着,因为她们互聊会烧主人的 token。'
      + 'on = 打开并开始聊(可以给话题和来回数),off = 立刻停,status = 只看开关状态。'
      + '两只鲸鱼各说各的:鲸鲸的话出在她自己头上的气泡,Coo 的话出在 Coo 自己头上的气泡,主人当场就能围观。',
    parameters: {
      action: { type: 'string', description: 'on(打开并开聊)/ off(停)/ status(看状态)', enum: ['on', 'off', 'status'] },
      topic: { type: 'string', description: '给她们的开场话题(可选,on 时用)' },
      rounds: { type: 'integer', description: '聊几个来回,1–10,默认 3;给 0 就是一直聊到叫停' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const action = String(args.action ?? 'status');
      if (action === 'status') return { ok: true, message: `聊天开关:${sparring ? '开着(正在聊)' : '关着'}` };
      if (action === 'off') return { ok: true, message: stopSpar() ? '叫停了,两只鲸鱼都闭嘴了' : '本来就没在聊' };
      const r = startChat({ topic: args.topic, rounds: args.rounds });
      if (!r.ok) return r;
      const { port, botName } = cooConfig();
      return { ok: true, message: `聊天开关打开了:${botName}(127.0.0.1:${port}) 对上鲸鲸。${r.message}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_forget',
    description: '清空鲸鲸桌宠在本机这边的对话记录。remote 模式下她的长期记忆在服务器上,这里不会删服务器会话'
      + '(只清本机显示记录);local/session 模式下是清掉她那个会话的记忆。她说错话、或者主人想重新调教她时用。',
    parameters: {},
    output: textOut((v) => v.message),
    async execute() {
      const remote = brainKind === 'remote';
      brain.forget();
      say('诶?人家刚才在想什么来着……', ['surprised']);
      return {
        ok: true,
        message: remote
          ? '本机这边的聊天记录清掉了;她的长期记忆在服务器上,没被删(要让她真忘,得在服务器侧处理 pet-local 会话)'
          : '桌宠的记忆清空了',
      };
    },
  }));

  /* ---------- 主人那边的「启动键」(斜杠命令) ---------- */
  /**
   * 在 DSH 输入框敲 `/` 就能看到这两个,点一下两只鲸鱼就开聊——
   * 跟 `pet_spar` 是同一件事,只是那个是给模型(人家)调的,这个是给主人点的。
   */
  const commands = ctx.get('commands');
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'pet-chat',
      description: '让桌面上的两只鲸鱼(DSH 的鲸鲸 + Coopanion 的 Coo)开始聊天,每句都出在她们各自的气泡里。'
        + '默认聊 3 个来回;最前面写个数字可以改,写 0 就是一直聊到 /pet-chat-stop。',
      input: { hint: '[数字] [话题] —— 例:5 今天谁摸鱼摸得多 / 0 一直聊 / 今天谁摸鱼摸得多' },
      handler: ({ rawInput }) => {
        // 跟桌宠身上那个按钮一个规矩:**同一个命令管开关**,再敲一次就是暂停
        if (sparring) {
          stopSpar();
          return { kind: 'success', text: '叫停了,两只鲸鱼都闭嘴了。再敲一次 /pet-chat 接着聊。' };
        }
        let rest = String(rawInput ?? '').trim();
        let rounds;
        // 最前面一个数字 = 聊几个来回(0 = 一直聊,也就是默认),剩下的当话题
        const m = rest.match(/^(\d+)(?:\s+([\s\S]*))?$/);
        if (m) {
          rounds = Number(m[1]);
          rest = (m[2] ?? '').trim();
        }
        const r = startChat({ topic: rest, rounds: rounds ?? 0 });
        return r.ok ? { kind: 'success', text: r.message } : { kind: 'error', text: r.message };
      },
    }), 'dsh-desktop-pet.pet-chat-command');

    ctx.effect(() => commands.register({
      name: 'pet-chat-stop',
      description: '让桌面上的两只鲸鱼立刻闭嘴。',
      handler: () => ({ kind: 'success', text: stopSpar() ? '叫停了。' : '本来就没在聊。' }),
    }), 'dsh-desktop-pet.pet-chat-stop-command');
  } else {
    ctx.logger?.warn?.('[桌宠] 这个 profile 里没有 commands 服务,「启动键」挂不上,用 pet_spar 工具也行');
  }
}
