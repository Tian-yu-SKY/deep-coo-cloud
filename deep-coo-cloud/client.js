/**
 * 「鲸歌」面板 —— Client 半（浏览器）。
 *
 * 无构建步骤的纯 ESM/CJS 工厂 bundle：由 DSH Web 的 `__ModuleLoader__` 载入，
 * `require('react')` 从宿主模块表取 React（不重复安装、不引任何 Harness Client 包）。
 *
 * 注册两个位置：
 *  - `sidebar.panellist`：id=`whale-chat`、label=「鲸歌」、order=5（官方 Plugins=0、
 *    定时任务=10 之间），图标是一头带音符的小鲸鱼；
 *  - `main` keyed `whale-chat`：整页聊天面板（标题 / 连接状态 / 刷新 / 气泡列表 /
 *    多行输入 + 发送）。
 *
 * 数据面（只走同源 `/whale-panel/*`，由 Host 半代理到 127.0.0.1:47891 的 bridge）：
 *  - `GET  /whale-panel/history?limit=200` 载入历史（PANEL-PROTOCOL §1）；
 *  - `GET  /whale-panel/config` 拿 WS 地址 + token，浏览器直连 bridge `WS /events`
 *    （PANEL-PROTOCOL §2：snapshot / message / status / ping）；
 *  - `POST /whale-panel/say` 发消息（PANEL-PROTOCOL §3，阻塞到轮结束）；
 *  - `GET  /whale-panel/health` 每 5s 轮询连接状态。
 * WS 断线按指数退避重连；断线期间用 `/history` 轮询兜底（bridge 还没上 /events 时也可用）。
 * 样式只用 DSH 主题 token（--dsw-alias-*），跟随明暗主题。
 */

window.__ModuleLoader__.load({
  id: 'deep-coo-cloud',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** 面板在 `sidebar.panellist` / `main` 两处的共同 id。 */
    const PANEL_ID = 'whale-chat';
    /** 侧栏顺序：官方 Plugins=0、定时任务=10，面板放在两者之间。 */
    const PANEL_ORDER = 5;
    /** Client locale 命名空间。 */
    const NS = 'whale-panel';
    /** 同源 Host 半路由根。 */
    const API_ROOT = 'whale-panel/';
    /** 历史一次拉多少条（PANEL-PROTOCOL 上限 500）。 */
    const HISTORY_LIMIT = 200;
    /** 连接状态轮询间隔。 */
    const HEALTH_INTERVAL_MS = 5_000;
    /** WS 断开时的历史轮询间隔。 */
    const POLL_INTERVAL_MS = 5_000;
    /** 发送超时：bridge 一轮最多 240s（config.requestTimeoutMs），留一点余量。 */
    const SEND_TIMEOUT_MS = 280_000;
    /** 本地乐观消息与权威消息「同文本」判重的时间窗口。 */
    const LOCAL_MATCH_WINDOW_MS = 5 * 60_000;
    /** 总控台面板 id / 侧栏顺序（与「鲸歌」并列，放在它前面）。 */
    const CONTROL_PANEL_ID = 'control-center';
    const CONTROL_PANEL_ORDER = 4;
    /** 总控台同源 API 根（Host 半 /control-center/*）。 */
    const CONTROL_API_ROOT = 'control-center/';
    /** 总控台自动刷新间隔（可被设置里的 refreshIntervalMs 覆盖）。 */
    const CONTROL_REFRESH_MS = 10_000;
    /** 合并版面板的三个 Tab（T21）；状态存 localStorage。 */
    const TAB_IDS = ['chat', 'control', 'settings', 'market'];
    const TAB_STORAGE_KEY = 'whale-panel.tab';
    /** 客户端本地设置兜底（与 Host SETTINGS_DEFAULTS 一致；设置接口失败时用）。 */
    /** 桌宠 DIY：固定外观字段 / 悬停按钮 action id（与 coo-fork T22 一致）。 */
    const PET_FIXED_SKIN_FIELDS = ['scheme', 'outfit', 'palette', 'head', 'side', 'glasses', 'neck'];
    const PET_HOVER_BUTTON_IDS = ['chat', 'voice', 'roam', 'theme', 'sound', 'hide', 'dress', 'cooChat'];
    const LOCAL_SETTINGS_FALLBACK = Object.freeze({
      refreshIntervalMs: 10_000,
      sections: Object.freeze({ cards: true, context: true, qq: true, components: true, actions: true }),
      chatFontSize: 'medium',
      sendKey: 'enter',
    });

    /** 简体中文文案（key 与 en 必须一一对应，测试会校验）。 */
    const zh = {
      title: '鲸歌 · 服务器人格',
      'title.short': '鲸歌',
      refresh: '刷新',
      placeholder: '跟她说点什么…（Enter 发送，Shift+Enter 换行）',
      send: '发送',
      sending: '正在想…',
      'status.connected': '已连接',
      'status.connecting': '连接中…',
      'status.bridgeOffline': 'bridge 未连接',
      'status.serverOffline': '服务器未连',
      'status.sessionMissing': '会话不存在',
      live: '实时',
      polling: '轮询',
      loading: '正在载入历史…',
      empty: '还没有对话。跟她说句话吧。',
      'history.missing': 'bridge 还没有 /history 接口（等 bridge v2 就绪后点刷新）',
      'history.failed': '历史消息加载失败',
      'role.user': '你',
      'role.assistant': '鲸歌',
      mood: '心情',
      'err.bridge-unreachable': '没连上 bridge（127.0.0.1:47891）。先启动 dsh-link bridge 再刷新。',
      'err.bridge-timeout': 'bridge 响应超时了，稍后再试。',
      'err.busy': '她还在想上一句，等这一轮结束再发。',
      'err.timeout': '服务器这一轮超时了，稍后再试。',
      'err.stream-lost': '事件流中断，这一轮的回复可能不完整。',
      'err.stream-interrupted': '事件流中断，这一轮的回复可能不完整。',
      'err.forbidden-session': '这是红线会话，面板不允许访问。',
      'err.bad-bridge-response': 'bridge 返回了无法解析的内容。',
      'err.client-timeout': '请求超时了，稍后再试。',
      'err.network': '浏览器网络请求失败。',
      'err.unknown': '出错了，稍后再试。',
      'err.text-too-long': '消息太长了（最多 8000 字）。',
      'err.payload-too-large': '消息太长了。',
      'err.bad-json': '请求内容格式不对。',
      'err.method-not-allowed': '接口调用方式不对。',
      'cc.title': '鲸歌 · 总控台',
      'cc.short': '总控台',
      'cc.loading': '正在读取状态…',
      'cc.updatedAt': '最后刷新',
      'cc.paused': '情境观察已暂停',
      'cc.refresh': '刷新',
      'cc.pause': '暂停情境观察',
      'cc.resume': '恢复情境观察',
      'cc.pauseBusy': '处理中…',
      'cc.pausedNotice': '已暂停情境观察（写入 context-observer/PAUSED）',
      'cc.resumedNotice': '已恢复情境观察（删除 PAUSED）',
      'cc.copied': '诊断 JSON 已复制到剪贴板',
      'cc.copyFailed': '复制失败：浏览器不允许访问剪贴板',
      'cc.copyDiag': '复制诊断 JSON',
      'cc.openChat': '打开鲸歌面板',
      'cc.openChatHint': '找不到 layout 服务：请关闭总控台后点击左侧「鲸歌」',
      'cc.degraded': 'dashboard 降级',
      'cc.unreachable': '未连接',
      'cc.unknown': '未知',
      'cc.online': '在线',
      'cc.offline': '离线',
      'cc.running': '运行中',
      'cc.idle': '空闲',
      'cc.busy': '忙碌',
      'cc.notRunning': '未运行',
      'cc.card.bridge': '本机 bridge',
      'cc.card.server': '服务器 DSH',
      'cc.card.qq': 'QQ 桥接',
      'cc.card.pet': 'Coo 桌宠',
      'cc.card.mood': '心情',
      'cc.card.observer': '情境观察器',
      'cc.card.sync': '本机→服务器同步',
      'cc.card.mirror': '会话镜像',
      'cc.comp.lastHeartbeat': '最后心跳',
      'cc.comp.lastWrite': '最后写入',
      'cc.comp.lastRun': '上次镜像',
      'cc.comp.events': '事件',
      'cc.comp.mirrored': '已镜像会话',
      'cc.comp.pending': '排队',
      'cc.comp.uptime': '运行',
      'cc.comp.tunnel': '隧道',
      'cc.comp.tunnelOn': '隧道已连接',
      'cc.comp.brain': '脑连接',
      'cc.comp.memory': '记忆',
      'cc.comp.autostart': '登录自启',
      'cc.section.context': '情境流（最近 5 条）',
      'cc.section.qq': 'QQ 近况',
      'cc.section.components': '组件状态',
      'cc.section.actions': '操作',
      'cc.coo.title': 'Coo 插件',
      'cc.coo.running': '运行中 · pid {pid}',
      'cc.coo.stopped': '未运行',
      'cc.coo.openExtensions': '打开安装目录',
      'cc.coo.openDownloads': '打开下载目录',
      'cc.coo.openDir': '目录',
      'cc.coo.downloaded': '已下载',
      'cc.coo.installed': '已安装',
      'cc.coo.addAndRun': '加入并运行',
      'cc.coo.run': '运行',
      'cc.coo.restartAndRun': '重启并运行',
      'cc.coo.uninstall': '卸载',
      'cc.coo.empty': '还没有从 Coo 市场下载任何插件。',
      'cc.coo.gotoMarket': '去 Coo 市场',
      'cc.coo.safety': '第三方扩展将在 Coopanion 里运行，请自行判断安全。',
      'cc.coo.confirmInstall': '确认把 {name} 加入 Coopanion？（pnpm add；需重启 Coopanion 生效）',
      'cc.coo.confirmUninstall': '确认从 Coopanion 卸载 {name}？（需重启 Coopanion 生效）',
      'cc.coo.confirmRestart': '确认重启 Coopanion？会结束当前 Coo 主程序（不影响 pet-host）。',
      'cc.coo.confirmRun': '确认启动 Coopanion？（已安装扩展会随启动加载）',
      'cc.coo.actionDone': '已处理：{action}',
      'cc.coo.needRestart': 'Coo 正在运行；新扩展需重启 Coopanion 后加载（可用「重启并运行」）。',
      'cc.coo.needInstall': '该插件尚未安装到 Coopanion。',
      'cc.coo.installedAndRunning': '已加入并启动 Coopanion。',
      'cc.coo.err': 'Coo 插件列表读取失败',
      'cc.coo.confirm': '确认',
      'cc.coo.cancel': '取消',
      'cc.coo.busy': '处理中…',
      'cc.contextTotal': '共 {n} 条',
      'cc.contextEmpty': '暂无情境事件（观察器未推送或已暂停）',
      'cc.qqPending': '需要 bridge /dashboard（T18）上线后显示 QQ 近况',
      'cc.qqEmpty': '暂无 QQ 预览',
      'cc.err.status': '总控台状态读取失败',
      'cc.surface.desktop': '桌面',
      'cc.surface.dsh': '本机DSH',
      'cc.surface.qq': 'QQ',
      'cc.surface.panel': '面板',
      'cc.surface.other': '其它',
      'tab.chat': '聊天',
      'tab.control': '总控台',
      'tab.settings': '设置',
      'set.title': '鲸歌 · 设置',
      'set.short': '设置',
      'set.loading': '正在读取设置…',
      'set.group.panel': '面板',
      'set.refresh': '刷新间隔',
      'set.seconds': '{n} 秒',
      'set.fontsize': '聊天气泡字号',
      'set.font.small': '小',
      'set.font.medium': '中',
      'set.font.large': '大',
      'set.sendkey': '发送键',
      'set.send.enter': 'Enter 发送（Shift+Enter 换行）',
      'set.send.ctrl': 'Ctrl+Enter 发送（Enter 换行）',
      'set.sections': '显示区块（总控台）',
      'set.section.cards': '状态卡片',
      'set.section.context': '情境流',
      'set.section.qq': 'QQ 近况',
      'set.section.components': '组件状态',
      'set.section.actions': '操作',
      'set.save': '保存设置',
      'set.saving': '保存中…',
      'set.saved': '本地设置已保存（立即生效）',
      'set.group.observer': '情境观察',
      'set.observerHint': '隐私边界：只采集前台窗口进程名/标题与本机 DSH 会话标题，不采集屏幕像素/输入内容；敏感窗口仅推进程名并标 private。',
      'set.group.qq': 'QQ 预览（服务器插件）',
      'set.qq.groupEnabled': '包含群聊预览',
      'set.qq.groups': '群白名单（group:数字，逗号/空格分隔）',
      'set.qq.chats': '私聊白名单（private:数字，逗号/空格分隔）',
      'set.qq.maxItems': '最多行数（1–10）',
      'set.qq.maxChars': '每行最多字数（20–200）',
      'set.qq.apply': '应用并重启服务器 DSH（约 10s）',
      'set.qq.confirm': '再次点击确认：将写服务器 cordis.patch.yml（只改 5 个 qqPreview 字段）并重启 dsh-web（约 10s，QQ 桥自动重连）。',
      'set.qq.confirmApply': '确认执行（写配置 + 重启）',
      'set.qq.cancel': '取消',
      'set.qq.applying': '正在写配置并重启服务器…（最多 90s）',
      'set.qq.applied': '已应用并重启完成',
      'set.qq.applyFailed': '服务器应用失败',
      'set.qq.pending': '需要 bridge / 服务器 SSH 配置可用；当前读取失败：',
      'set.group.paths': '路径',
      'set.openDir': '打开 dsh-link 目录',
      'set.settingsFile': '本地设置文件',
      'set.reloadHint': '本地设置保存后立即生效；服务器 QQ 配置应用会重启 dsh-web（约 10s），QQ 桥/鲸歌自动重连。',
      'set.unknown': '未知',
      'set.group.general': '通用 / 连接',
      'set.uiLabel': '左侧栏名称',
      'set.panelTitle': '面板标题',
      'set.bridgeUrl': '桥接地址',
      'set.bridgeHint': '空 = 用插件 config 默认（http://127.0.0.1:47891）；只允许 http/https + 回环/局域网',
      'set.sshHost': '服务器 SSH 主机',
      'set.sshHint': '空 = 不启用服务器 SSH 功能（QQ 预览配置读写/应用并重启）；填 user@host 启用',
      'set.sshDisabledHint': 'SSH 未配置：无法读写服务器 QQ 预览配置；需同时填写「服务器 SSH 主机」和「服务器 patch 路径」',
      'set.awarenessPath': '服务器 patch 路径',
      'set.awarenessPathHint': '服务器上 awareness bundle 的 cordis.patch.yml 绝对路径（与 SSH 主机都填才启用服务器 QQ 配置读写）',
      'set.qqGroups': 'QQ 群白名单（本机默认）',
      'set.qqChats': 'QQ 私聊白名单（本机默认）',
      'set.qqLocalHint': 'group:<id> / private:<id>，逗号分隔；空 = 不预览任何会话（服务器不可读时用作默认值）',
      'set.pathDshLinkRoot': '工作区根',
      'set.pathDownloads': '下载目录',
      'set.labelsReloadHint': '名称/标题/Tab 文案保存后需刷新页面生效。',
      'set.savedReload': '已保存；名称/标题/Tab 文案刷新页面后生效',
      'set.taskHint': '这些是 Coo 扩展市场的第三方包；下载/安装不执行扩展代码',
      'set.group.pet': '桌宠 DIY',
      'set.pet.summary': '当前',
      'set.pet.pack': '形象包',
      'set.pet.presets': '预设',
      'set.pet.scale': '大小',
      'set.pet.bubbleSize': '气泡大小',
      'set.pet.fontSize': '字号',
      'set.pet.bubbleSpeed': '气泡速度',
      'set.pet.glow': '光晕',
      'set.pet.theme': '主题',
      'set.pet.theme.light': '亮',
      'set.pet.theme.dark': '暗',
      'set.pet.roam': '走位',
      'set.pet.roam.free': '自由走',
      'set.pet.roam.calm': '安静（少走）',
      'set.pet.roam.off': '固定不走',
      'set.pet.sound': '音效',
      'set.pet.hoverButtons': '悬停按钮',
      'set.pet.doubleClick': '双击聊天',
      'set.pet.frameRate': '帧率上限',
      'set.pet.lockFrameRate': '锁定帧率',
      'set.pet.save': '保存并应用',
      'set.pet.saving': '应用中…',
      'set.pet.saved': '已应用（桌宠 1s 内变化）',
      'set.pet.refreshPacks': '刷新形象包列表',
      'set.pet.import': '导入形象包（ZIP）',
      'set.pet.importing': '上传中…',
      'set.pet.importHint': '支持 Coo 形象包 ZIP（内含 figure.json，≤128MB）。只解包文件到本机 coo-pet-data，不执行包内代码。',
      'set.pet.imported': '已导入 {id}{version}',
      'set.pet.importFailed': '导入失败',
      'set.pet.importTooLarge': '文件超过 128MB，无法导入',
      'set.pet.importConflict': '形象包 {id} 已存在，替换？旧包会备份到 figures/.backup-*。',
      'set.pet.importReplace': '替换',
      'set.pet.importCancel': '取消',
      'set.pet.packsError': '形象包读取失败',
      'set.pet.requiresT22': '需要 coo-fork 桌宠插件 0.4.0+ 才会热应用；保存后约 1s 生效，无需重启。',
      'set.pet.currentFallback': '当前生效读取失败',
      'tab.market': 'Coo 市场',
      'mkt.note': '这些是 Coo/Coopanion 的扩展（Cortico 市场），由 Coopanion 安装并运行；本插件只做浏览/下载/指引，不执行扩展代码。第三方包请自行判断安全。',
      'mkt.download': '下载',
      'mkt.downloading': '下载中…',
      'mkt.downloadAgain': '重新下载',
      'mkt.downloaded': '已下载',
      'mkt.downloadNotice': '已下载到 dsh-link/coo-extensions/<name>',
      'mkt.downloadFailed': '下载失败',
      'mkt.openDownloadsDir': '打开下载目录',
      'mkt.downloadsDir': '下载目录',
      'mkt.filterDownloaded': '已下载',
      'mkt.installToCoop': '安装到 Coopanion（高级）',
      'mkt.installWarning': '第三方代码将运行在 Coopanion 里，需重启 Coopanion 生效；本插件不执行扩展代码。确认安装？',
      'mkt.installConfirm': '确认安装',
      'mkt.installCancel': '取消',
      'mkt.installing': '安装中…',
      'mkt.installed': '已安装',
      'mkt.installedNotice': '已安装到 Coopanion，重启 Coopanion 后生效',
      'mkt.installFailed': '安装失败',
      'mkt.installNeedDownload': '请先下载到本机',
      'mkt.search': '搜索名称/描述/关键词',
      'mkt.kind': '类型',
      'mkt.kind.all': '全部',
      'mkt.kind.world': 'World',
      'mkt.kind.provider': 'Provider',
      'mkt.kind.bot': 'Bot',
      'mkt.kind.panel': 'Panel',
      'mkt.kind.other': '其他',
      'mkt.sort': '排序',
      'mkt.sort.downloads': '月下载量',
      'mkt.sort.updated': '最近更新',
      'mkt.refresh': '刷新',
      'mkt.loading': '正在从 npm 拉取 Cortico 扩展…',
      'mkt.empty': '没有匹配的扩展',
      'mkt.count': '共 {n} 个',
      'mkt.cached': '缓存（{t} 更新）',
      'mkt.stale': 'npm 刷新失败，显示上次缓存',
      'mkt.installed': '已安装',
      'mkt.notInstalled': '未安装',
      'mkt.downloads': '月下载',
      'mkt.copy': '复制包名',
      'mkt.copied': '已复制包名',
      'mkt.copyFailed': '复制失败',
      'mkt.installHint': '安装：在 Coopanion 设置 → 扩展 → 市场里搜同名安装；或在 Coopanion 的数据目录执行 corepack pnpm add {pkg}（由 Cortico Core 加载运行）。',
      'mkt.openNpm': 'npm 页面',
      'mkt.homepage': '主页',
      'mkt.repository': '仓库',
      'mkt.updatedAt': '更新于',
      'mkt.keywords': '关键词',
      'mkt.license': '许可',
      'mkt.publisher': '发布者',
      'mkt.error': '市场读取失败',
      'mkt.npmFailed': 'npm 请求失败',
      'mkt.installedDir': '已安装扩展目录',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      title: 'Whale Song · Server Persona',
      'title.short': 'Whale Song',
      refresh: 'Refresh',
      placeholder: 'Say something… (Enter to send, Shift+Enter for a new line)',
      send: 'Send',
      sending: 'Thinking…',
      'status.connected': 'Connected',
      'status.connecting': 'Connecting…',
      'status.bridgeOffline': 'Bridge offline',
      'status.serverOffline': 'Server offline',
      'status.sessionMissing': 'Session missing',
      live: 'Live',
      polling: 'Polling',
      loading: 'Loading history…',
      empty: 'No messages yet. Say something to her.',
      'history.missing': 'The bridge has no /history endpoint yet (wait for bridge v2, then refresh)',
      'history.failed': 'Failed to load history',
      'role.user': 'You',
      'role.assistant': 'Whale Song',
      mood: 'Mood',
      'err.bridge-unreachable': "Can't reach the bridge (127.0.0.1:47891). Start dsh-link bridge, then refresh.",
      'err.bridge-timeout': 'The bridge timed out. Try again later.',
      'err.busy': 'She is still thinking about the previous message. Wait for this turn to finish.',
      'err.timeout': 'The server turn timed out. Try again later.',
      'err.stream-lost': 'The event stream was lost; this reply may be incomplete.',
      'err.stream-interrupted': 'The event stream was interrupted; this reply may be incomplete.',
      'err.forbidden-session': 'This is a red-line session; the panel may not access it.',
      'err.bad-bridge-response': 'The bridge returned something unreadable.',
      'err.client-timeout': 'The request timed out. Try again.',
      'err.network': 'The browser network request failed.',
      'err.unknown': 'Something went wrong. Try again.',
      'err.text-too-long': 'The message is too long (8000 characters max).',
      'err.payload-too-large': 'The message is too long.',
      'err.bad-json': 'Malformed request body.',
      'err.method-not-allowed': 'Wrong request method.',
      'cc.title': 'Whale Song · Control Center',
      'cc.short': 'Control Center',
      'cc.loading': 'Reading status…',
      'cc.updatedAt': 'Updated',
      'cc.paused': 'Context observation paused',
      'cc.refresh': 'Refresh',
      'cc.pause': 'Pause context observation',
      'cc.resume': 'Resume context observation',
      'cc.pauseBusy': 'Working…',
      'cc.pausedNotice': 'Context observation paused (wrote context-observer/PAUSED)',
      'cc.resumedNotice': 'Context observation resumed (PAUSED removed)',
      'cc.copied': 'Diagnostics JSON copied to clipboard',
      'cc.copyFailed': 'Copy failed: clipboard unavailable',
      'cc.copyDiag': 'Copy diagnostics JSON',
      'cc.openChat': 'Open Whale Song panel',
      'cc.openChatHint': 'layout service unavailable: close this panel and click "Whale Song" in the sidebar',
      'cc.degraded': 'dashboard degraded',
      'cc.unreachable': 'Unreachable',
      'cc.unknown': 'Unknown',
      'cc.online': 'Online',
      'cc.offline': 'Offline',
      'cc.running': 'Running',
      'cc.idle': 'Idle',
      'cc.busy': 'Busy',
      'cc.notRunning': 'Not running',
      'cc.card.bridge': 'Local bridge',
      'cc.card.server': 'Server DSH',
      'cc.card.qq': 'QQ bridge',
      'cc.card.pet': 'Coo desktop pet',
      'cc.card.mood': 'Mood',
      'cc.card.observer': 'Context observer',
      'cc.card.sync': 'Local to server sync',
      'cc.card.mirror': 'Session mirror',
      'cc.comp.lastHeartbeat': 'Last heartbeat',
      'cc.comp.lastWrite': 'Last write',
      'cc.comp.lastRun': 'Last mirror',
      'cc.comp.events': 'events',
      'cc.comp.mirrored': 'mirrored sessions',
      'cc.comp.pending': 'pending',
      'cc.comp.uptime': 'uptime',
      'cc.comp.tunnel': 'tunnel',
      'cc.comp.tunnelOn': 'tunnel connected',
      'cc.comp.brain': 'brain connection',
      'cc.comp.memory': 'memories',
      'cc.comp.autostart': 'Login autostart',
      'cc.section.context': 'Context stream (latest 5)',
      'cc.section.qq': 'QQ recent',
      'cc.section.components': 'Components',
      'cc.section.actions': 'Actions',
      'cc.coo.title': 'Coo plugins',
      'cc.coo.running': 'Running · pid {pid}',
      'cc.coo.stopped': 'Not running',
      'cc.coo.openExtensions': 'Open extensions dir',
      'cc.coo.openDownloads': 'Open downloads dir',
      'cc.coo.openDir': 'Dir',
      'cc.coo.downloaded': 'Downloaded',
      'cc.coo.installed': 'Installed',
      'cc.coo.addAndRun': 'Add and run',
      'cc.coo.run': 'Run',
      'cc.coo.restartAndRun': 'Restart and run',
      'cc.coo.uninstall': 'Uninstall',
      'cc.coo.empty': 'No plugins downloaded from the Coo market yet.',
      'cc.coo.gotoMarket': 'Go to Coo Market',
      'cc.coo.safety': 'Third-party extensions run inside Coopanion; judge their safety yourself.',
      'cc.coo.confirmInstall': 'Add {name} to Coopanion? (pnpm add; restart Coopanion to load)',
      'cc.coo.confirmUninstall': 'Uninstall {name} from Coopanion? (restart Coopanion to take effect)',
      'cc.coo.confirmRestart': 'Restart Coopanion? This ends the current Coo main process (pet-host is untouched).',
      'cc.coo.confirmRun': 'Launch Coopanion? Installed extensions load on startup.',
      'cc.coo.actionDone': 'Done: {action}',
      'cc.coo.needRestart': 'Coo is running; restart Coopanion to load new extensions (use "Restart and run").',
      'cc.coo.needInstall': 'This plugin is not installed in Coopanion yet.',
      'cc.coo.installedAndRunning': 'Added and launched Coopanion.',
      'cc.coo.err': 'Failed to read Coo plugins',
      'cc.coo.confirm': 'Confirm',
      'cc.coo.cancel': 'Cancel',
      'cc.coo.busy': 'Working…',
      'cc.contextTotal': '{n} events',
      'cc.contextEmpty': 'No context events yet (observer not pushing or paused)',
      'cc.qqPending': 'Needs bridge /dashboard (T18) to show QQ preview',
      'cc.qqEmpty': 'No QQ preview',
      'cc.err.status': 'Failed to read control-center status',
      'cc.surface.desktop': 'Desktop',
      'cc.surface.dsh': 'Local DSH',
      'cc.surface.qq': 'QQ',
      'cc.surface.panel': 'Panel',
      'cc.surface.other': 'Other',
      'tab.chat': 'Chat',
      'tab.control': 'Control Center',
      'tab.settings': 'Settings',
      'set.title': 'Whale Song · Settings',
      'set.short': 'Settings',
      'set.loading': 'Loading settings…',
      'set.group.panel': 'Panel',
      'set.refresh': 'Refresh interval',
      'set.seconds': '{n}s',
      'set.fontsize': 'Chat bubble font size',
      'set.font.small': 'Small',
      'set.font.medium': 'Medium',
      'set.font.large': 'Large',
      'set.sendkey': 'Send key',
      'set.send.enter': 'Enter to send (Shift+Enter for new line)',
      'set.send.ctrl': 'Ctrl+Enter to send (Enter for new line)',
      'set.sections': 'Visible blocks (Control Center)',
      'set.section.cards': 'Status cards',
      'set.section.context': 'Context stream',
      'set.section.qq': 'QQ recent',
      'set.section.components': 'Components',
      'set.section.actions': 'Actions',
      'set.save': 'Save settings',
      'set.saving': 'Saving…',
      'set.saved': 'Local settings saved (effective immediately)',
      'set.group.observer': 'Context observation',
      'set.observerHint': 'Privacy: only foreground process/title and local DSH session titles are collected; no screen pixels or keystrokes. Sensitive windows publish process name only and are marked private.',
      'set.group.qq': 'QQ preview (server plugin)',
      'set.qq.groupEnabled': 'Include group chats',
      'set.qq.groups': 'Group allowlist (group:<id>, comma separated)',
      'set.qq.chats': 'Private-chat allowlist (private:<id>)',
      'set.qq.maxItems': 'Max lines (1–10)',
      'set.qq.maxChars': 'Max chars per line (20–200)',
      'set.qq.apply': 'Apply and restart server DSH (~10s)',
      'set.qq.confirm': 'Click again to confirm: writes server cordis.patch.yml (only the 5 qqPreview fields) and restarts dsh-web (~10s; QQ bridge reconnects automatically).',
      'set.qq.confirmApply': 'Confirm (write + restart)',
      'set.qq.cancel': 'Cancel',
      'set.qq.applying': 'Writing config and restarting server… (up to 90s)',
      'set.qq.applied': 'Applied and server restarted',
      'set.qq.applyFailed': 'Server apply failed',
      'set.qq.pending': 'Requires bridge / server SSH; read failed: ',
      'set.group.paths': 'Paths',
      'set.openDir': 'Open dsh-link directory',
      'set.settingsFile': 'Local settings file',
      'set.reloadHint': 'Local settings apply immediately; applying server QQ config restarts dsh-web (~10s) and QQ bridge / Whale Song reconnect automatically.',
      'set.unknown': 'Unknown',
      'set.group.general': 'General / Connection',
      'set.uiLabel': 'Sidebar label',
      'set.panelTitle': 'Panel title',
      'set.bridgeUrl': 'Bridge URL',
      'set.bridgeHint': 'Empty = plugin config default (http://127.0.0.1:47891); only http/https loopback/LAN',
      'set.sshHost': 'Server SSH host',
      'set.sshHint': 'Empty = SSH features disabled (server QQ preview config/apply); fill user@host to enable',
      'set.sshDisabledHint': 'SSH not configured: server QQ preview config is disabled; fill both Server SSH host and server patch path above',
      'set.awarenessPath': 'Server patch path',
      'set.awarenessPathHint': 'Absolute path of the awareness cordis.patch.yml on your server (needed together with SSH host)',
      'set.qqGroups': 'QQ group allowlist (local default)',
      'set.qqChats': 'QQ private allowlist (local default)',
      'set.qqLocalHint': 'group:<id> / private:<id>, comma separated; empty = no sessions previewed (fallback when server unreadable)',
      'set.pathDshLinkRoot': 'Workspace root',
      'set.pathDownloads': 'Downloads dir',
      'set.labelsReloadHint': 'Label/title/tab changes take effect after refreshing the page.',
      'set.savedReload': 'Saved; label/title/tab changes take effect after refreshing the page',
      'set.taskHint': 'Third-party packages from the Coo extension market; downloading/installing never executes extension code',
      'set.group.pet': 'Pet DIY',
      'set.pet.summary': 'Current',
      'set.pet.pack': 'Figure pack',
      'set.pet.presets': 'Presets',
      'set.pet.scale': 'Scale',
      'set.pet.bubbleSize': 'Bubble size',
      'set.pet.fontSize': 'Font size',
      'set.pet.bubbleSpeed': 'Bubble speed',
      'set.pet.glow': 'Glow',
      'set.pet.theme': 'Theme',
      'set.pet.theme.light': 'Light',
      'set.pet.theme.dark': 'Dark',
      'set.pet.roam': 'Roaming',
      'set.pet.roam.free': 'Free roam',
      'set.pet.roam.calm': 'Calm (rare)',
      'set.pet.roam.off': 'Stay put',
      'set.pet.sound': 'Sound',
      'set.pet.hoverButtons': 'Hover buttons',
      'set.pet.doubleClick': 'Double-click to chat',
      'set.pet.frameRate': 'Frame-rate cap',
      'set.pet.lockFrameRate': 'Lock frame rate',
      'set.pet.save': 'Save and apply',
      'set.pet.saving': 'Applying…',
      'set.pet.saved': 'Applied (pet updates within ~1s)',
      'set.pet.refreshPacks': 'Refresh figure packs',
      'set.pet.import': 'Import figure pack (ZIP)',
      'set.pet.importing': 'Uploading…',
      'set.pet.importHint': 'Accepts a Coo figure-pack ZIP (figure.json inside, ≤128MB). Only extracts files into local coo-pet-data; never executes pack code.',
      'set.pet.imported': 'Imported {id}{version}',
      'set.pet.importFailed': 'Import failed',
      'set.pet.importTooLarge': 'File exceeds 128MB and cannot be imported',
      'set.pet.importConflict': 'Figure pack {id} already exists. Replace it? The old pack will be backed up under figures/.backup-*.',
      'set.pet.importReplace': 'Replace',
      'set.pet.importCancel': 'Cancel',
      'set.pet.packsError': 'Failed to read figure packs',
      'set.pet.requiresT22': 'Requires coo-fork pet plugin 0.4.0+ to hot-apply; changes take effect within ~1s, no restart needed.',
      'set.pet.currentFallback': 'Failed to read current pet settings',
      'tab.market': 'Coo Market',
      'mkt.note': 'These are Coo/Coopanion extensions (Cortico market), installed and run by Coopanion; this plugin only browses/downloads/guides and never executes extension code. Judge third-party package safety yourself.',
      'mkt.download': 'Download',
      'mkt.downloading': 'Downloading…',
      'mkt.downloadAgain': 'Re-download',
      'mkt.downloaded': 'Downloaded',
      'mkt.downloadNotice': 'Downloaded to dsh-link/coo-extensions/<name>',
      'mkt.downloadFailed': 'Download failed',
      'mkt.openDownloadsDir': 'Open downloads dir',
      'mkt.downloadsDir': 'Downloads dir',
      'mkt.filterDownloaded': 'Downloaded',
      'mkt.installToCoop': 'Install into Coopanion (advanced)',
      'mkt.installWarning': 'Third-party code will run inside Coopanion and requires restarting Coopanion; this plugin never executes extension code. Install anyway?',
      'mkt.installConfirm': 'Confirm install',
      'mkt.installCancel': 'Cancel',
      'mkt.installing': 'Installing…',
      'mkt.installed': 'Installed',
      'mkt.installedNotice': 'Installed into Coopanion; restart Coopanion to take effect',
      'mkt.installFailed': 'Install failed',
      'mkt.installNeedDownload': 'Download it to this machine first',
      'mkt.search': 'Search name/description/keywords',
      'mkt.kind': 'Kind',
      'mkt.kind.all': 'All',
      'mkt.kind.world': 'World',
      'mkt.kind.provider': 'Provider',
      'mkt.kind.bot': 'Bot',
      'mkt.kind.panel': 'Panel',
      'mkt.kind.other': 'Other',
      'mkt.sort': 'Sort',
      'mkt.sort.downloads': 'Monthly downloads',
      'mkt.sort.updated': 'Recently updated',
      'mkt.refresh': 'Refresh',
      'mkt.loading': 'Fetching Cortico extensions from npm…',
      'mkt.empty': 'No matching extensions',
      'mkt.count': '{n} packages',
      'mkt.cached': 'cached ({t})',
      'mkt.stale': 'npm refresh failed; showing cached list',
      'mkt.installed': 'Installed',
      'mkt.notInstalled': 'Not installed',
      'mkt.downloads': 'downloads/mo',
      'mkt.copy': 'Copy package name',
      'mkt.copied': 'Package name copied',
      'mkt.copyFailed': 'Copy failed',
      'mkt.installHint': 'Install: search it in Coopanion Settings → Extensions → Market; or run corepack pnpm add {pkg} in the Coopanion data directory (loaded by Cortico Core).',
      'mkt.openNpm': 'npm page',
      'mkt.homepage': 'Homepage',
      'mkt.repository': 'Repository',
      'mkt.updatedAt': 'Updated',
      'mkt.keywords': 'Keywords',
      'mkt.license': 'License',
      'mkt.publisher': 'Publisher',
      'mkt.error': 'Failed to read market',
      'mkt.npmFailed': 'npm request failed',
      'mkt.installedDir': 'Installed extensions dir',
    };

    /** 没有 locale 服务时的兜底（按中文）。 */
    function fallbackTranslate(key) {
      const value = zh[key];
      return typeof value === 'string' ? value : key;
    }

    // ---------------------------------------------------------------------
    // 纯函数工具（组件与离线测试共用；通过 __test 暴露）
    // ---------------------------------------------------------------------

    /** 把 bridge 的 role 收敛成 user/assistant；其它角色不渲染。 */
    function normalizeRole(role) {
      if (role === 'user') return 'user';
      if (role === 'assistant') return 'assistant';
      return null;
    }

    /**
     * 校验并归一化一条 bridge 消息。
     * @returns {{ id: string, role: 'user'|'assistant', text: string, at: number, turn?: number, local?: true } | null}
     */
    function normalizeMessage(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const role = normalizeRole(raw.role);
      if (role === null) return null;
      const id = typeof raw.id === 'string' && raw.id !== ''
        ? raw.id
        : typeof raw.id === 'number' && Number.isFinite(raw.id) ? String(raw.id) : null;
      if (id === null) return null;
      const text = typeof raw.text === 'string' ? raw.text : '';
      const at = Number.isFinite(raw.at) ? raw.at : Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0;
      const message = { id, role, text, at };
      if (Number.isFinite(raw.turn)) message.turn = raw.turn;
      if (raw.local === true) message.local = true;
      return message;
    }

    /** 按时间排序；本地乐观消息也按 at 参与排序，at 相同保持插入顺序。 */
    function sortMessages(list) {
      return list
        .map((message, index) => ({ message, index }))
        .sort((a, b) => (a.message.at - b.message.at) || (a.index - b.index))
        .map((entry) => entry.message);
    }

    /**
     * 合并消息（按 id 去重、按 at 排序、清理已被权威数据覆盖的本地乐观消息）。
     * 返回同一个引用表示没有变化（便于 React 跳过渲染）。
     * @param {Array<Record<string, any>>} previous
     * @param {Array<Record<string, any>> | Record<string, any>} incoming
     */
    function mergeMessages(previous, incoming) {
      const base = Array.isArray(previous) ? previous : [];
      const incomingList = Array.isArray(incoming) ? incoming : [incoming];
      const byId = new Map();
      for (const message of base) {
        if (message && typeof message.id === 'string') byId.set(message.id, message);
      }
      let changed = false;
      for (const raw of incomingList) {
        const message = normalizeMessage(raw);
        if (message === null) continue;
        const existing = byId.get(message.id);
        if (existing === undefined) {
          byId.set(message.id, message);
          changed = true;
          continue;
        }
        if (existing.role !== message.role || existing.text !== message.text) {
          byId.set(message.id, { ...existing, ...message });
          changed = true;
        }
      }
      if (!changed) return base;
      const list = sortMessages(Array.from(byId.values()));
      const authoritative = list.filter((message) => message.local !== true);
      const cleaned = list.filter((message) => {
        if (message.local !== true) return true;
        return !authoritative.some((candidate) => candidate.role === message.role
          && candidate.text === message.text
          && Math.abs(candidate.at - message.at) < LOCAL_MATCH_WINDOW_MS);
      });
      return cleaned;
    }

    /** 指数退避：1s/2s/4s/8s/15s，±20% 抖动，最低 800ms。 */
    function backoffDelay(attempt) {
      const safe = Math.max(0, Math.min(Number(attempt) || 0, 6));
      const base = Math.min(15_000, 1_000 * Math.pow(2, Math.min(safe, 4)));
      const jitter = Math.round(base * 0.2 * (Math.random() * 2 - 1));
      return Math.max(800, base + jitter);
    }

    /** epoch 毫秒 -> 本地 HH:MM（无效输入返回空串）。 */
    function formatClock(at) {
      const value = Number(at);
      if (!Number.isFinite(value) || value <= 0) return '';
      const date = new Date(value);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    }

    /** 校验并拼出浏览器直连 bridge 的 WS 地址（只接受 ws/wss）。 */
    function buildEventsUrl(base, token) {
      if (typeof base !== 'string' || base === '') return null;
      let url;
      try {
        url = new URL(base);
      } catch {
        return null;
      }
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
      if (typeof token === 'string' && token !== '') url.searchParams.set('token', token);
      return url.href;
    }

    /** 同源 API 根（按 document.baseURI 解析，兼容子路径部署）。 */
    let cachedApiBase = null;
    function apiBase() {
      if (cachedApiBase !== null) return cachedApiBase;
      try {
        cachedApiBase = new URL(API_ROOT, document.baseURI);
      } catch {
        cachedApiBase = new URL(`http://127.0.0.1/${API_ROOT}`);
      }
      return cachedApiBase;
    }

    /** 拼一个同源 API 地址。 */
    function api(path) {
      return new URL(String(path).replace(/^\/+/, ''), apiBase()).href;
    }

    /** 总控台 API 根（/control-center/*）。 */
    let cachedControlBase = null;
    function controlApiBase() {
      if (cachedControlBase !== null) return cachedControlBase;
      try {
        cachedControlBase = new URL(CONTROL_API_ROOT, document.baseURI);
      } catch {
        cachedControlBase = new URL(`http://127.0.0.1/${CONTROL_API_ROOT}`);
      }
      return cachedControlBase;
    }

    /** 拼一个总控台同源 API 地址。 */
    function controlApi(path) {
      return new URL(String(path).replace(/^\/+/, ''), controlApiBase()).href;
    }

    /**
     * 同源 JSON 请求（带超时），永远 resolve，用 `{ ok, status, data }` 表达结果。
     */
    async function fetchJson(url, options = {}) {
      const method = options.method ?? 'GET';
      const timeoutMs = options.timeoutMs ?? 15_000;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          cache: 'no-store',
          headers: options.body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller === null ? undefined : controller.signal,
        });
        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        return {
          ok: response.ok && !(data && data.ok === false),
          status: response.status,
          data,
          error: null,
        };
      } catch (error) {
        const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
        return {
          ok: false,
          status: 0,
          data: null,
          error: {
            code: aborted ? 'client-timeout' : 'network',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    /** 从失败响应里取错误码（宿主代理 / bridge / 浏览器三层的格式都兼容）。 */
    function errorCode(result) {
      if (!result) return '';
      if (result.data && result.data.error && typeof result.data.error.code === 'string') return result.data.error.code;
      if (result.error && typeof result.error.code === 'string') return result.error.code;
      if (typeof result.status === 'number' && result.status > 0) return `http-${result.status}`;
      return '';
    }

    /** 把错误码翻译成可读文案。 */
    function readableReason(result, t) {
      const code = errorCode(result);
      const translate = typeof t === 'function' ? t : fallbackTranslate;
      if (code !== '' && Object.prototype.hasOwnProperty.call(zh, `err.${code}`)) return translate(`err.${code}`);
      const detail = result && result.data && result.data.error && typeof result.data.error.message === 'string'
        ? result.data.error.message
        : '';
      return detail !== '' ? detail : translate('err.unknown');
    }


    // ---------------------------------------------------------------------
    // 总控台纯函数工具（组件与离线测试共用）
    // ---------------------------------------------------------------------

    /** 毫秒时长 → 人类可读（"2d3h" / "1h20m" / "12m" / "30s" / "—"）。 */
    function formatUptime(ms) {
      if (ms === null || ms === undefined || ms === '') return '—';
      const value = Number(ms);
      if (!Number.isFinite(value) || value < 0) return '—';
      const totalSeconds = Math.floor(value / 1000);
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (days > 0) return `${days}d${hours}h`;
      if (hours > 0) return `${hours}h${minutes}m`;
      if (minutes > 0) return `${minutes}m`;
      return `${seconds}s`;
    }

    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / MM-DD HH:mm / —。 */
    function relativeTime(at, now = Date.now()) {
      const value = Number(at);
      if (!Number.isFinite(value) || value <= 0) return '—';
      const elapsed = Math.max(0, now - value);
      if (elapsed < 60_000) return '刚刚';
      if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
      if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
      const date = new Date(value);
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** 数值保留两位小数；非数字返回 —。 */
    function formatNumber(value) {
      if (value === null || value === undefined || value === '') return '—';
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(2) : '—';
    }

    /** 情境事件：过滤非法项、按时间新→旧、限制条数。 */
    function sortContextEvents(events, limit = 5) {
      const list = Array.isArray(events) ? events : [];
      return list
        .filter((event) => event && typeof event === 'object' && typeof event.summary === 'string' && event.summary !== '')
        .slice()
        .sort((left, right) => {
          const leftAt = Number.isFinite(Number(left.at)) ? Number(left.at) : 0;
          const rightAt = Number.isFinite(Number(right.at)) ? Number(right.at) : 0;
          return rightAt - leftAt;
        })
        .slice(0, Math.max(1, Number(limit) || 5));
    }

    /** surface → 本地化标签。 */
    function surfaceLabel(surface, t) {
      const translate = typeof t === 'function' ? t : fallbackTranslate;
      if (surface === 'desktop') return translate('cc.surface.desktop');
      if (surface === 'dsh-local') return translate('cc.surface.dsh');
      if (surface === 'qq') return translate('cc.surface.qq');
      if (surface === 'panel') return translate('cc.surface.panel');
      return translate('cc.surface.other');
    }

    /** 状态卡片模型（纯函数，供组件与测试使用）。 */
    /** T33：合并「已下载」与「已安装」Coo 插件 → 总控台行。 */
    function buildCooPluginRows(pluginData) {
      const data = pluginData && typeof pluginData === 'object' ? pluginData : {};
      const downloaded = Array.isArray(data.downloaded) ? data.downloaded : [];
      const installed = Array.isArray(data.installed) ? data.installed : [];
      const rows = [];
      const seen = new Set();
      for (const item of downloaded) {
        if (!item || typeof item.name !== 'string' || seen.has(item.name)) continue;
        const match = installed.find((entry) => entry && entry.name === item.name) ?? null;
        rows.push({
          name: item.name,
          displayName: item.displayName || (match && match.displayName) || item.name,
          version: item.version || (match && match.version) || '',
          kind: item.kind || (match && match.kind) || 'other',
          downloaded: true,
          installed: item.installed === true || match !== null,
          installedVersion: (match && match.version) || item.installedVersion || null,
        });
        seen.add(item.name);
      }
      for (const item of installed) {
        if (!item || typeof item.name !== 'string' || seen.has(item.name)) continue;
        rows.push({
          name: item.name,
          displayName: item.displayName || item.name,
          version: item.version || '',
          kind: item.kind || 'other',
          downloaded: false,
          installed: true,
          installedVersion: item.version || null,
        });
        seen.add(item.name);
      }
      return rows;
    }

    /** kind → 文案（复用 Coo 市场的 kind 文案）。 */
    function cooPluginKindLabel(kind, t) {
      return t(`mkt.kind.${['world', 'provider', 'bot', 'panel'].includes(kind) ? kind : 'other'}`);
    }

    function buildControlCards(status, t) {
      const translate = typeof t === 'function' ? t : fallbackTranslate;
      const bridge = status && status.bridge;
      const server = status && status.server;
      const pet = status && status.pet;
      const mood = status && status.mood;
      const bridgeOk = !!(status && (status.dashboard?.available || (bridge && bridge.pid)));
      const cards = [
        {
          id: 'bridge',
          title: translate('cc.card.bridge'),
          value: bridge ? (bridge.pid ? `pid ${bridge.pid}` : translate('cc.unknown')) : translate('cc.unreachable'),
          sub: bridge
            ? `${translate('cc.comp.uptime')} ${formatUptime(bridge.uptimeMs)} · ${bridge.busy ? translate('cc.busy') : translate('cc.idle')}`
              + (bridge.version ? ` · ${bridge.version}` : '')
            : '',
          state: bridgeOk ? 'ok' : 'error',
        },
        {
          id: 'server',
          title: translate('cc.card.server'),
          value: server
            ? (server.dshWeb ? String(server.dshWeb) : (server.up ? translate('cc.online') : translate('cc.unknown')))
            : translate('cc.unknown'),
          sub: server
            ? (server.tunnel ? translate('cc.comp.tunnelOn') : '')
              + (server.sessionId ? ` · ${server.sessionId}` : '')
            : '',
          state: !server ? 'idle' : (server.up ? 'ok' : 'error'),
        },
        {
          id: 'qq',
          title: translate('cc.card.qq'),
          value: server && server.qqBridge ? String(server.qqBridge) : translate('cc.unknown'),
          sub: server && server.qqBridge ? '' : translate('cc.qqPending'),
          state: server && server.qqBridge === 'active' ? 'ok' : 'idle',
        },
        {
          id: 'pet',
          title: translate('cc.card.pet'),
          value: pet ? (pet.online ? translate('cc.online') : translate('cc.offline')) : translate('cc.unknown'),
          sub: pet && pet.online ? `${translate('cc.comp.brain')} · wsChat=${pet.wsChat ?? 0}` : '',
          state: pet && pet.online ? 'ok' : 'idle',
        },
        {
          id: 'mood',
          title: translate('cc.card.mood'),
          value: mood && mood.label ? mood.label : translate('cc.unknown'),
          sub: mood
            ? `valence ${formatNumber(mood.valence)} / arousal ${formatNumber(mood.arousal)}`
              + (Number.isFinite(Number(mood.memoryCount)) ? ` · ${translate('cc.comp.memory')} ${mood.memoryCount}` : '')
            : '',
          state: mood && mood.label ? 'ok' : 'idle',
        },
      ];
      return cards;
    }

    /** 顶部 dashboard 状态 chip：未就绪=降级标记；就绪=显示 T18 /dashboard 耗时（tookMs）。 */
    function dashboardChip(status, t) {
      const translate = typeof t === 'function' ? t : fallbackTranslate;
      if (!status || !status.dashboard) return null;
      if (status.dashboard.available !== true) {
        return { state: 'warn', text: translate('cc.degraded') };
      }
      const rawTookMs = status.dashboard.tookMs;
      const tookMs = rawTookMs === null || rawTookMs === undefined || rawTookMs === '' ? NaN : Number(rawTookMs);
      if (Number.isFinite(tookMs)) return { state: 'ok', text: `dashboard ${tookMs}ms` };
      return { state: 'ok', text: 'dashboard' };
    }

    /** 组件状态行（纯函数）。 */
    function buildComponentRows(status, t) {
      const translate = typeof t === 'function' ? t : fallbackTranslate;
      const components = (status && status.components) || {};
      const observer = components.observer || {};
      const sync = components.sync || {};
      const mirror = components.mirror || {};
      const stateOf = (running, paused) => (paused ? 'warn' : (running ? 'ok' : 'error'));
      const stateText = (running) => (running ? translate('cc.running') : translate('cc.notRunning'));
      return [
        {
          id: 'observer',
          label: translate('cc.card.observer'),
          state: stateOf(observer.running, observer.paused),
          stateText: observer.paused ? translate('cc.paused') : stateText(observer.running),
          value: observer.pid ? `pid ${observer.pid}` : '—',
          sub: `${translate('cc.comp.lastHeartbeat')} ${relativeTime(observer.lastHeartbeatAt)}`
            + ` · ${translate('cc.comp.pending')} ${Number(observer.pending) || 0}`,
        },
        {
          id: 'sync',
          label: translate('cc.card.sync'),
          state: stateOf(sync.running, false),
          stateText: stateText(sync.running),
          value: `${translate('cc.comp.events')} ${Number(sync.events) || 0}`,
          sub: `${translate('cc.comp.lastWrite')} ${relativeTime(sync.lastWriteAt)}`,
        },
        {
          id: 'mirror',
          label: translate('cc.card.mirror'),
          state: stateOf(mirror.running, false),
          stateText: stateText(mirror.running),
          value: `${translate('cc.comp.mirrored')} ${Number.isFinite(Number(mirror.mirrored)) ? mirror.mirrored : '—'}`,
          sub: `${translate('cc.comp.lastRun')} ${relativeTime(mirror.lastRunAt)}`,
        },
      ];
    }

    // ---------------------------------------------------------------------
    // 图标
    // ---------------------------------------------------------------------

    /** 侧栏图标：一头朝左的鲸鱼 + 一个八分音符（原创造型）。 */
    function WhaleIcon(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
        className: 'wp-icon',
      },
      h('path', {
        d: 'M2.2 13.1c0-3.3 3.1-6 7-6 2.6 0 4.9 1 6.3 2.6l2.9-2.5c.7-.6 1.6-.1 1.6.8v9c0 .9-1 1.4-1.6.8l-2.8-2.4c-1 2-2.9 3.4-5.3 3.8l1.5 1.6c.5.5.1 1.3-.6 1.3h-2.5c-.4 0-.9-.2-1.2-.5l-1.3-1.3c-2.3-.4-4-1.6-4-3.2Z',
        fill: 'currentColor',
      }),
      h('circle', { cx: 7.2, cy: 12.2, r: 1.05, fill: 'var(--dsw-alias-bg-base, #ffffff)' }),
      h('path', { d: 'M8.4 7.4c0-1.4.9-2.5 2.1-2.9', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.75 }),
      h('g', { fill: 'currentColor' },
        h('circle', { cx: 18.1, cy: 5.2, r: 1.25 }),
        h('rect', { x: 18.9, y: 0.9, width: 1, height: 4.4, rx: 0.5 }),
        h('path', { d: 'M19.9.9c1.2.2 2.1.9 2.4 1.8.1.3-.4.6-.6.3-.4-.5-1-.9-1.9-1.1V.9Z' })),
      );
    }


    /** 总控台图标：四格仪表盘 + 指针（原创造型，与鲸鱼图标同风格）。 */
    function ControlCenterIcon(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
        className: 'wp-icon',
      },
      h('rect', { x: 3, y: 3, width: 7.4, height: 7.4, rx: 2, fill: 'currentColor', opacity: 0.92 }),
      h('rect', { x: 13.6, y: 3, width: 7.4, height: 7.4, rx: 2, fill: 'currentColor', opacity: 0.55 }),
      h('rect', { x: 3, y: 13.6, width: 7.4, height: 7.4, rx: 2, fill: 'currentColor', opacity: 0.55 }),
      h('path', {
        d: 'M14.2 17.2a3.6 3.6 0 1 1 6.9 1.2',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
      }),
      h('path', { d: 'M17.6 17.4l2.6-1.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      );
    }

    // ---------------------------------------------------------------------
    // 总控台样式（卡片网格；只用主题 token）
    // ---------------------------------------------------------------------

    const CONTROL_STYLE_CSS = [
      '.cc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;}',
      '.cc-card{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);min-width:0;}',
      '.cc-card[data-state="error"]{border-color:var(--dsw-alias-state-error-secondary);}',
      '.cc-card[data-state="ok"]{border-color:var(--dsw-alias-state-success-tertiary);}',
      '.cc-card-title{font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.cc-card-value{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.cc-card-sub{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}',
      '.cc-section{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.cc-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.cc-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.cc-section-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.cc-list{display:flex;flex-direction:column;gap:6px;}',
      '.cc-list-row{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:1.6;}',
      '.cc-tag{flex:none;font-size:11px;padding:0 6px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.cc-list-text{flex:1;min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.cc-list-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.cc-lines{display:flex;flex-direction:column;gap:4px;}',
      '.cc-line{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.cc-empty{padding:8px 0;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.cc-rows{display:flex;flex-direction:column;gap:6px;}',
      '.cc-row{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.6;min-width:0;}',
      '.cc-badge{flex:none;font-size:11px;padding:0 6px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.cc-badge[data-state="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary);}',
      '.cc-badge[data-state="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-tertiary);}',
      '.cc-badge[data-state="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary);}',
      '.cc-row-label{flex:none;color:var(--dsw-alias-label-secondary);}',
      '.cc-row-value{flex:none;color:var(--dsw-alias-label-primary);}',
      '.cc-row-sub{min-width:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}',
      '.cc-autostart{display:flex;flex-wrap:wrap;gap:6px;padding-top:2px;}',
      '.cc-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-secondary);}',
      '.cc-chip[data-installed="no"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-tertiary);}',
      '.cc-actions{display:flex;flex-wrap:wrap;gap:8px;}',
      '.wp-banner-ok{color:var(--dsw-alias-state-success-primary);}',
      '.set-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary);}',
      '.set-note-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.set-note-error{color:var(--dsw-alias-state-error-primary);}',
      '.cc-coo-rows{display:flex;flex-direction:column;gap:8px;}',
      '.cc-coo-row{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}',
      '.cc-coo-row[data-installed="yes"]{border-color:var(--dsw-alias-state-success-tertiary);}',
      '.cc-coo-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.cc-coo-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.cc-coo-pkg{display:block;font-family:var(--dsh-code-font-family, monospace);font-size:11px;',
      'color:var(--dsw-alias-label-tertiary);font-weight:400;overflow-wrap:anywhere;}',
      '.cc-badge[data-kind="world"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary);}',
      '.cc-badge[data-kind="provider"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-tertiary);}',
      '.cc-badge[data-kind="bot"]{color:var(--dsw-alias-brand-primary);}',
      '.cc-coo-confirm{display:flex;flex-direction:column;gap:6px;}',
      '.cc-chip[data-installed="yes"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary);}',
      '@media (max-width:720px){.cc-cards{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));}}',
    ].join('');

    /**
     * 「鲸歌 · 总控台」整页控制中心（T19）。
     * @param {{ t?: (key: string) => string, openPanel?: (id: string) => boolean }} props
     */
    function ControlCenterPanel(props) {
      const t = props && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const settings = props && props.settings ? normalizeLocalSettings(props.settings) : LOCAL_SETTINGS_FALLBACK;
      const switchTab = props && typeof props.switchTab === 'function' ? props.switchTab : null;
      const active = props ? props.active !== false : true;
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [loading, setLoading] = useState(true);
      const [pauseBusy, setPauseBusy] = useState(false);
      const [cooPlugins, setCooPlugins] = useState(null);
      const [cooError, setCooError] = useState('');
      const [cooNotice, setCooNotice] = useState('');
      const [cooBusy, setCooBusy] = useState('');
      const [cooConfirm, setCooConfirm] = useState(null);
      const aliveRef = useRef(false);
      const tRef = useRef(t);
      tRef.current = t;
      const statusRef = useRef(null);
      statusRef.current = status;

      /** 拉一次 /control-center/status（10s 自动 + 手动刷新共用）。 */
      const load = useCallback(async () => {
        const result = await fetchJson(controlApi('status'), { timeoutMs: 12_000 });
        if (!aliveRef.current) return null;
        if (result.ok && result.data && result.data.ok === true) {
          setStatus(result.data);
          setError('');
          return result.data;
        }
        setError(`${tRef.current('cc.err.status')}：${readableReason(result, tRef.current)}`);
        return null;
      }, []);

      /** T33：拉 Coo 插件列表（下载/已装/主程序状态）。 */
      const loadCooPlugins = useCallback(async () => {
        const result = await fetchJson(api('coo-plugins'), { timeoutMs: 15_000 });
        if (!aliveRef.current) return null;
        if (result.ok && result.data && result.data.ok === true) {
          setCooPlugins(result.data);
          setCooError('');
          return result.data;
        }
        setCooError(`${tRef.current('cc.coo.err')}：${readableReason(result, tRef.current)}`);
        return null;
      }, []);

      // 只在「总控台」Tab 激活时刷新（切走就停定时器，省资源；T21）
      useEffect(() => {
        if (!active) return undefined;
        aliveRef.current = true;
        let mounted = true;
        load().finally(() => {
          if (mounted && aliveRef.current) setLoading(false);
        });
        loadCooPlugins();
        const interval = Number(settings.refreshIntervalMs) || CONTROL_REFRESH_MS;
        const timer = setInterval(() => {
          if (aliveRef.current) {
            load();
            loadCooPlugins();
          }
        }, interval);
        return () => {
          mounted = false;
          aliveRef.current = false;
          clearInterval(timer);
        };
      }, [load, active, settings.refreshIntervalMs]);

      const manualRefresh = () => {
        setLoading(true);
        load().finally(() => {
          if (aliveRef.current) setLoading(false);
        });
        loadCooPlugins();
      };

      /** T33：执行一个 Coo 插件动作（install/uninstall/run/restart）。 */
      const executeCooAction = async (action, name) => {
        if (cooBusy !== '') return;
        setCooBusy(`${action}:${name}`);
        setCooError('');
        setCooNotice('');
        try {
          const body = { name };
          if (action === 'install' || action === 'uninstall' || action === 'restart') body.confirm = true;
          const result = await fetchJson(api(`coo-plugins/${action}`), {
            method: 'POST',
            body,
            timeoutMs: action === 'install' || action === 'uninstall' ? 320_000 : 25_000,
          });
          if (!aliveRef.current) return;
          if (result.ok && result.data && result.data.ok === true) {
            setCooNotice(result.data.message || tRef.current('cc.coo.actionDone').replace('{action}', action));
            const refreshed = await loadCooPlugins();
            if (action === 'install' && refreshed && refreshed.coo && refreshed.coo.running === false) {
              const runResult = await fetchJson(api('coo-plugins/run'), { method: 'POST', body: { name }, timeoutMs: 25_000 });
              if (aliveRef.current) {
                if (runResult.ok && runResult.data && runResult.data.ok === true) setCooNotice(tRef.current('cc.coo.installedAndRunning'));
                else if (runResult.status === 409) setCooNotice(tRef.current('cc.coo.needRestart'));
                else setCooError(readableReason(runResult, tRef.current));
                await loadCooPlugins();
              }
            }
          } else if (result.status === 409 && result.data && result.data.needRestart) {
            setCooNotice(tRef.current('cc.coo.needRestart'));
            await loadCooPlugins();
          } else if (result.status === 409 && result.data && result.data.needInstall) {
            setCooError(tRef.current('cc.coo.needInstall'));
          } else {
            setCooError(readableReason(result, tRef.current));
          }
        } finally {
          if (aliveRef.current) setCooBusy('');
        }
      };

      const requestCooAction = (action, name) => {
        setCooNotice('');
        setCooError('');
        setCooConfirm({ action, name });
      };

      const confirmCooAction = async () => {
        const next = cooConfirm;
        setCooConfirm(null);
        if (next) await executeCooAction(next.action, next.name);
      };

      const openCooDir = async (which) => {
        setCooNotice('');
        const result = await fetchJson(api('coo-plugins/open-dir'), { method: 'POST', body: { which }, timeoutMs: 5_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data && result.data.ok === true) setCooNotice(result.data.path);
        else setCooError(readableReason(result, tRef.current));
      };

      const togglePause = async () => {
        if (pauseBusy) return;
        const next = !(statusRef.current && statusRef.current.paused && statusRef.current.paused.paused === true);
        setPauseBusy(true);
        setNotice('');
        try {
          const result = await fetchJson(controlApi('pause-context'), {
            method: 'POST',
            body: { paused: next },
            timeoutMs: 8_000,
          });
          if (!aliveRef.current) return;
          if (result.ok && result.data && result.data.ok === true) {
            setNotice(next ? tRef.current('cc.pausedNotice') : tRef.current('cc.resumedNotice'));
            await load();
          } else {
            setError(readableReason(result, tRef.current));
          }
        } finally {
          if (aliveRef.current) setPauseBusy(false);
        }
      };

      const openSettingsTab = () => {
        setNotice('');
        if (switchTab !== null) {
          switchTab('settings');
          return;
        }
        setNotice(t('cc.openChatHint'));
      };

      const copyDiagnostics = async () => {
        setNotice('');
        const payload = JSON.stringify({
          copiedAt: new Date().toISOString(),
          status: statusRef.current,
        }, null, 2);
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(payload);
            setNotice(tRef.current('cc.copied'));
            return;
          }
          throw new Error('clipboard unavailable');
        } catch {
          if (aliveRef.current) setNotice(tRef.current('cc.copyFailed'));
        }
      };

      const cards = buildControlCards(status, t);
      const dashChip = dashboardChip(status, t);
      const componentRows = buildComponentRows(status, t);
      const contextEvents = sortContextEvents(status?.context?.events, 5);
      const qq = status?.qq;
      const paused = !!(status?.paused && status?.paused.paused === true);
      const contextTotal = String(status?.context?.count ?? 0);

      return h('div', { className: 'wp-root', 'data-control-center': CONTROL_PANEL_ID },
        h('style', { dangerouslySetInnerHTML: { __html: `${STYLE_CSS}\n${CONTROL_STYLE_CSS}` } }),
        h('header', { className: 'wp-header' },
          h('div', { className: 'wp-heading' },
            h('div', { className: 'wp-title' }, t('cc.title')),
            h('div', { className: 'wp-sub' },
              h('span', { className: 'wp-chip' }, status
                ? `${t('cc.updatedAt')} ${formatClock(status.at)}`
                : t('cc.loading')),
              paused
                ? h('span', { className: 'wp-status', 'data-state': 'warn' }, h('span', { className: 'wp-dot' }), t('cc.paused'))
                : h('span', { className: 'wp-status', 'data-state': status ? 'ok' : 'idle' }, h('span', { className: 'wp-dot' }), status ? t('cc.online') : t('cc.loading')),
              dashChip !== null
                ? h('span', { className: 'wp-chip', 'data-dashboard': dashChip.state }, dashChip.text)
                : null,
              status && status.tokenPresent === false
                ? h('span', { className: 'wp-chip' }, t('cc.unknown'))
                : null)),
          h('div', { className: 'wp-actions' },
            h('button', { type: 'button', className: 'wp-btn', onClick: manualRefresh, disabled: loading },
              loading ? t('cc.loading') : t('cc.refresh')))),
        error !== ''
          ? h('div', { className: 'wp-banners' }, h('div', { className: 'wp-banner wp-banner-error' }, error))
          : null,
        notice !== ''
          ? h('div', { className: 'wp-banners' }, h('div', { className: 'wp-banner wp-banner-ok' }, notice))
          : null,
        h('div', { className: 'wp-scroll' },
          h('div', { className: 'cc-cards', style: settings.sections.cards ? undefined : { display: 'none' } }, cards.map((card) => h('div', {
            className: 'cc-card',
            key: card.id,
            'data-state': card.state,
            'data-card': card.id,
          },
          h('div', { className: 'cc-card-title' }, card.title),
          h('div', { className: 'cc-card-value' }, card.value),
          card.sub !== '' ? h('div', { className: 'cc-card-sub' }, card.sub) : null))),
          // ── T33：Coo 插件（下载 → 加入 → 运行/重启）──
          h('div', { className: 'cc-section', 'data-coo-plugins': '1' },
            h('div', { className: 'cc-section-head' },
              h('span', { className: 'cc-section-title' }, t('cc.coo.title')),
              h('span', { className: 'cc-section-meta' },
                cooPlugins && cooPlugins.coo
                  ? (cooPlugins.coo.running
                    ? t('cc.coo.running').replace('{pid}', (cooPlugins.coo.pids || []).join(','))
                    : t('cc.coo.stopped'))
                  : t('cc.loading'))),
            h('div', { className: 'cc-actions' },
              h('button', { type: 'button', className: 'wp-btn', onClick: () => { loadCooPlugins(); }, disabled: cooBusy !== '' }, t('cc.refresh')),
              h('button', { type: 'button', className: 'wp-btn', onClick: () => openCooDir('extensions') }, t('cc.coo.openExtensions')),
              h('button', { type: 'button', className: 'wp-btn', onClick: () => openCooDir('downloads') }, t('cc.coo.openDownloads'))),
            cooPlugins && cooPlugins.warning
              ? h('div', { className: 'set-note set-note-warn' }, cooPlugins.warning)
              : null,
            cooError !== '' ? h('div', { className: 'set-note set-note-error' }, cooError) : null,
            cooNotice !== '' ? h('div', { className: 'set-note' }, cooNotice) : null,
            h('div', { className: 'set-note' }, t('cc.coo.safety')),
            (() => {
              const rows = buildCooPluginRows(cooPlugins);
              const running = !!(cooPlugins && cooPlugins.coo && cooPlugins.coo.running);
              if (rows.length === 0) {
                return h('div', { className: 'cc-empty' },
                  h('div', {}, t('cc.coo.empty')),
                  switchTab !== null
                    ? h('button', { type: 'button', className: 'wp-btn', onClick: () => switchTab('market') }, t('cc.coo.gotoMarket'))
                    : null);
              }
              return h('div', { className: 'cc-coo-rows' }, rows.map((row) => h('div', { className: 'cc-coo-row', key: row.name, 'data-installed': row.installed ? 'yes' : 'no' },
                h('div', { className: 'cc-coo-main' },
                  h('span', { className: 'cc-coo-name' }, row.displayName, h('span', { className: 'cc-coo-pkg' }, row.name)),
                  h('span', { className: 'cc-badge', 'data-kind': row.kind }, cooPluginKindLabel(row.kind, t)),
                  row.version !== '' ? h('span', { className: 'cc-chip' }, `v${row.version}`) : null,
                  row.installed ? h('span', { className: 'cc-chip', 'data-installed': 'yes' }, t('cc.coo.installed')) : null,
                  row.downloaded && !row.installed ? h('span', { className: 'cc-chip' }, t('cc.coo.downloaded')) : null),
                h('div', { className: 'cc-actions' },
                  !row.installed && row.downloaded
                    ? h('button', { type: 'button', className: 'wp-btn wp-btn-primary', disabled: cooBusy !== '', onClick: () => requestCooAction('install', row.name) }, t('cc.coo.addAndRun'))
                    : null,
                  row.installed
                    ? h('button', {
                      type: 'button',
                      className: 'wp-btn wp-btn-primary',
                      disabled: cooBusy !== '',
                      onClick: () => requestCooAction(running ? 'restart' : 'run', row.name),
                    }, running ? t('cc.coo.restartAndRun') : t('cc.coo.run'))
                    : null,
                  row.installed
                    ? h('button', { type: 'button', className: 'wp-btn', disabled: cooBusy !== '', onClick: () => requestCooAction('uninstall', row.name) }, t('cc.coo.uninstall'))
                    : null,
                  h('button', { type: 'button', className: 'wp-btn', onClick: () => openCooDir(row.installed ? 'extensions' : 'downloads') }, t('cc.coo.openDir'))),
                cooBusy === `install:${row.name}` || cooBusy === `uninstall:${row.name}` || cooBusy === `run:${row.name}` || cooBusy === `restart:${row.name}`
                  ? h('div', { className: 'set-note' }, t('cc.coo.busy'))
                  : null,
                cooConfirm && cooConfirm.name === row.name
                  ? h('div', { className: 'cc-coo-confirm' },
                    h('div', { className: 'set-note set-note-warn' },
                      cooConfirm.action === 'install' ? t('cc.coo.confirmInstall').replace('{name}', row.name)
                        : cooConfirm.action === 'uninstall' ? t('cc.coo.confirmUninstall').replace('{name}', row.name)
                          : cooConfirm.action === 'restart' ? t('cc.coo.confirmRestart')
                            : t('cc.coo.confirmRun'),
                      ' ', t('cc.coo.safety')),
                    h('div', { className: 'cc-actions' },
                      h('button', { type: 'button', className: 'wp-btn wp-btn-primary', disabled: cooBusy !== '', onClick: confirmCooAction }, t('cc.coo.confirm')),
                      h('button', { type: 'button', className: 'wp-btn', disabled: cooBusy !== '', onClick: () => setCooConfirm(null) }, t('cc.coo.cancel'))))
                  : null)));
            })()),
          h('div', { className: 'cc-section', style: settings.sections.context ? undefined : { display: 'none' } },
            h('div', { className: 'cc-section-head' },
              h('span', { className: 'cc-section-title' }, t('cc.section.context')),
              h('span', { className: 'cc-section-meta' }, t('cc.contextTotal').replace('{n}', contextTotal))),
            h('div', { className: 'cc-list' }, contextEvents.length === 0
              ? h('div', { className: 'cc-empty' }, t('cc.contextEmpty'))
              : contextEvents.map((event, index) => h('div', { className: 'cc-list-row', key: `ctx-${index}` },
                h('span', { className: 'cc-tag' }, surfaceLabel(event.surface, t)),
                h('span', { className: 'cc-list-text' }, String(event.summary ?? '')),
                h('span', { className: 'cc-list-time' }, relativeTime(event.at)))))),
          h('div', { className: 'cc-section', style: settings.sections.qq ? undefined : { display: 'none' } },
            h('div', { className: 'cc-section-head' },
              h('span', { className: 'cc-section-title' }, t('cc.section.qq')),
              h('span', { className: 'cc-section-meta' }, qq && qq.source ? String(qq.source) : '')),
            h('div', { className: 'cc-lines' },
              qq && qq.available && Array.isArray(qq.lines) && qq.lines.length > 0
                ? qq.lines.slice(0, 4).map((line, index) => h('div', {
                  className: 'cc-line',
                  key: `qq-${index}`,
                }, String(line)))
                : h('div', { className: 'cc-empty' }, qq && qq.available ? t('cc.qqEmpty') : t('cc.qqPending')))),
          h('div', { className: 'cc-section', style: settings.sections.components ? undefined : { display: 'none' } },
            h('div', { className: 'cc-section-head' },
              h('span', { className: 'cc-section-title' }, t('cc.section.components'))),
            h('div', { className: 'cc-rows' }, componentRows.map((row) => h('div', { className: 'cc-row', key: row.id },
              h('span', { className: 'cc-badge', 'data-state': row.state }, row.stateText),
              h('span', { className: 'cc-row-label' }, row.label),
              h('span', { className: 'cc-row-value' }, row.value),
              h('span', { className: 'cc-row-sub' }, row.sub)))),
            h('div', { className: 'cc-autostart' }, (status?.autostart ?? []).map((entry) => h('span', {
              className: 'cc-chip',
              key: entry.id,
              'data-installed': entry.installed ? 'yes' : 'no',
            }, `${entry.label}${entry.installed ? ' ✓' : ' ✗'}`)))),
          h('div', { className: 'cc-section', style: settings.sections.actions ? undefined : { display: 'none' } },
            h('div', { className: 'cc-section-head' },
              h('span', { className: 'cc-section-title' }, t('cc.section.actions'))),
            h('div', { className: 'cc-actions' },
              h('button', { type: 'button', className: 'wp-btn', onClick: manualRefresh, disabled: loading }, t('cc.refresh')),
              h('button', {
                type: 'button',
                className: paused ? 'wp-btn wp-btn-primary' : 'wp-btn',
                onClick: togglePause,
                disabled: pauseBusy,
              }, pauseBusy ? t('cc.pauseBusy') : (paused ? t('cc.resume') : t('cc.pause'))),
              h('button', { type: 'button', className: 'wp-btn', onClick: openSettingsTab }, t('set.short')),
              h('button', { type: 'button', className: 'wp-btn', onClick: copyDiagnostics }, t('cc.copyDiag'))))));
    }

    // ---------------------------------------------------------------------
    // 样式（只用主题 token；容器与控件跟随明暗主题）
    // ---------------------------------------------------------------------

    const STYLE_CSS = [
      '.wp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font-size:var(--dsh-content-font-size,14px);}',
      '.wp-header{display:flex;align-items:flex-start;gap:12px;padding:14px 20px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:none;}',
      '.wp-heading{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}',
      '.wp-title{font-size:16px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary);}',
      '.wp-sub{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;line-height:1.6;',
      'color:var(--dsw-alias-label-tertiary);}',
      '.wp-chip{padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap;}',
      '.wp-status{display:inline-flex;align-items:center;gap:5px;padding:0 7px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.wp-status[data-state="ok"]{color:var(--dsw-alias-state-success-primary);',
      'border-color:var(--dsw-alias-state-success-tertiary);}',
      '.wp-status[data-state="warn"]{color:var(--dsw-alias-state-warn-primary);',
      'border-color:var(--dsw-alias-state-warn-tertiary);}',
      '.wp-status[data-state="error"]{color:var(--dsw-alias-state-error-primary);',
      'border-color:var(--dsw-alias-state-error-secondary);}',
      '.wp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;}',
      '.wp-actions{display:flex;gap:8px;flex:none;}',
      '.wp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;',
      'padding:6px 12px;font:inherit;font-size:13px;line-height:1.4;cursor:pointer;',
      'transition:background-color .12s ease,border-color .12s ease;}',
      '.wp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.wp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.wp-btn:disabled{opacity:.45;cursor:default;}',
      '.wp-btn-primary{background:var(--dsw-alias-button-primary-fill);',
      'border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
      '.wp-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);',
      'border-color:var(--dsw-alias-button-primary-hover);}',
      '.wp-banners{display:flex;flex-direction:column;flex:none;}',
      '.wp-banner{padding:8px 20px;font-size:12px;line-height:1.6;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.wp-banner-error{color:var(--dsw-alias-state-error-primary);}',
      '.wp-banner-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.wp-scroll{flex:1;min-height:0;overflow-y:auto;padding:18px 20px 8px;display:flex;',
      'flex-direction:column;gap:14px;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;}',
      '.wp-row{display:flex;}',
      '.wp-row-user{justify-content:flex-end;}',
      '.wp-row-assistant{justify-content:flex-start;}',
      '.wp-message{display:flex;flex-direction:column;gap:3px;max-width:min(72ch,82%);min-width:0;}',
      '.wp-row-user .wp-message{align-items:flex-end;}',
      '.wp-meta{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);padding:0 4px;}',
      '.wp-bubble{padding:9px 13px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;',
      'line-height:1.6;border:1px solid transparent;}',
      '.wp-row-user .wp-bubble{background:var(--dsw-alias-button-primary-fill);',
      'color:var(--dsw-alias-label-primary-foreground);border-bottom-right-radius:4px;}',
      '.wp-row-assistant .wp-bubble{background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);',
      'border-bottom-left-radius:4px;}',
      '.wp-empty{margin:auto;text-align:center;color:var(--dsw-alias-label-tertiary);',
      'font-size:13px;line-height:1.8;padding:24px;}',
      '.wp-typing{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);',
      'font-size:12px;padding:0 2px 12px;}',
      '.wp-typing-dot{width:5px;height:5px;border-radius:50%;background:currentColor;',
      'animation:wp-blink 1.2s infinite ease-in-out;}',
      '.wp-typing-dot:nth-child(2){animation-delay:.18s;}',
      '.wp-typing-dot:nth-child(3){animation-delay:.36s;}',
      '@keyframes wp-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.wp-typing-dot{animation:none;}}',
      '.wp-composer{display:flex;align-items:flex-end;gap:10px;padding:12px 20px 16px;flex:none;',
      'border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.wp-input{flex:1;min-height:40px;max-height:140px;resize:none;padding:10px 12px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:10px;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font:inherit;line-height:1.5;outline:none;}',
      '.wp-input::placeholder{color:var(--dsw-alias-label-dimmed);}',
      '.wp-input:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.wp-input:disabled{opacity:.6;}',
      '@media (max-width:720px){.wp-header{padding:12px 14px 10px;}.wp-scroll{padding:14px 14px 6px;}',
      '.wp-composer{padding:10px 14px 14px;}.wp-message{max-width:92%;}}',
    ].join('');


    // ---------------------------------------------------------------------
    // 合并版 Tab / 本地设置工具（T21）
    // ---------------------------------------------------------------------

    /** 读取上次 Tab（非法值回退 chat；storage 可注入便于测试）。 */
    function readStoredTab(storage) {
      try {
        const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
        const stored = target ? target.getItem(TAB_STORAGE_KEY) : null;
        return TAB_IDS.includes(stored) ? stored : 'chat';
      } catch {
        return 'chat';
      }
    }

    /** 记忆 Tab（隐私模式/禁用 localStorage 时静默忽略）。 */
    function storeTab(tab, storage) {
      try {
        const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
        if (target && TAB_IDS.includes(tab)) target.setItem(TAB_STORAGE_KEY, tab);
      } catch {
        /* ignore */
      }
    }

    /** 合并设置：只接受合法字段（与 Host 校验一致），非法回退兜底。 */
    function normalizeLocalSettings(raw) {
      const base = LOCAL_SETTINGS_FALLBACK;
      const merged = {
        refreshIntervalMs: base.refreshIntervalMs,
        sections: { ...base.sections },
        chatFontSize: base.chatFontSize,
        sendKey: base.sendKey,
      };
      if (!raw || typeof raw !== 'object') return merged;
      if ([5_000, 10_000, 30_000].includes(Number(raw.refreshIntervalMs))) merged.refreshIntervalMs = Number(raw.refreshIntervalMs);
      if (raw.sections && typeof raw.sections === 'object') {
        for (const key of Object.keys(base.sections)) {
          if (typeof raw.sections[key] === 'boolean') merged.sections[key] = raw.sections[key];
        }
      }
      if (['small', 'medium', 'large'].includes(raw.chatFontSize)) merged.chatFontSize = raw.chatFontSize;
      if (['enter', 'ctrl-enter'].includes(raw.sendKey)) merged.sendKey = raw.sendKey;
      return merged;
    }

    /** 插件 UI 名称配置（T26；apply 时从 Host /config 读取，可被 settings.json 覆盖）。 */
    const uiState = { sidebarLabel: '', panelTitle: '', tabLabels: {} };

    /** 用配置的侧栏名称替换文案里的默认产品名（鲸歌 / Whale Song）。 */
    function localizeWithUi(t, ui) {
      const label = ui && typeof ui.sidebarLabel === 'string' ? ui.sidebarLabel : '';
      return (key) => {
        const text = t(key);
        if (label === '' || typeof text !== 'string') return text;
        return text.split('鲸歌').join(label).split('Whale Song').join(label);
      };
    }

    /** 解析 QQ 白名单文本 → 数组（支持逗号/空格/顿号分隔；缺前缀自动补）。 */
    function parseIdList(text, prefix) {
      const items = String(text ?? '')
        .split(/[\s,，、]+/)
        .map((item) => item.trim())
        .filter((item) => item !== '');
      return items.map((item) => {
        if (/^(group|private):\d+$/.test(item)) return item;
        const digits = item.replace(/\D+/g, '');
        return digits === '' ? item : `${prefix}:${digits}`;
      });
    }

    /** 数组 → 输入框文本。 */
    function joinIdList(list) {
      return Array.isArray(list) ? list.join(', ') : '';
    }

    /** T30：形象包 ZIP 上传上限（与 Host config 默认一致）。 */
    const PET_IMPORT_MAX_BYTES = 128 * 1024 * 1024;

    /** T30：形象包导入 URL（replace=true 时带 ?replace=1）。 */
    function buildImportPackUrl(replace) {
      return `${api('pet-diy/import-pack')}${replace === true ? '?replace=1' : ''}`;
    }

    /** T30：把 Host 导入结果整理成 toast 文案。 */
    function summarizeImportPackResult(data) {
      const id = data && typeof data.id === 'string' ? data.id : '';
      const version = data && typeof data.version === 'string' && data.version !== '' ? ` v${data.version}` : '';
      return id === '' ? '' : `已导入 ${id}${version}`;
    }

    /** T30：上传原始 ZIP 字节（不走 fetchJson，避免被 JSON 化）。 */
    async function uploadPetPack(file, replace) {
      const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : null;
      const response = await fetch(buildImportPackUrl(replace), {
        method: 'POST',
        headers: { 'content-type': (file && file.type) || 'application/zip' },
        body: buffer,
      });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      return { status: response.status, ok: response.ok === true && !!data && data.ok === true, data };
    }

    /** 设置页保存前抓取表单值（纯函数，便于测试）。 */
    function collectAwarenessBody(confirm, draft) {
      return {
        confirm: confirm === true,
        qqPreviewGroup: draft.qqPreviewGroup === true,
        qqPreviewGroups: parseIdList(draft.groupsText, 'group'),
        qqPreviewChats: parseIdList(draft.chatsText, 'private'),
        qqPreviewMaxItems: Number(draft.qqPreviewMaxItems),
        qqPreviewMaxChars: Number(draft.qqPreviewMaxChars),
      };
    }

    // ---------------------------------------------------------------------
    // 面板组件
    // ---------------------------------------------------------------------




    // ---------------------------------------------------------------------
    // Coo 市场工具（T24；纯函数，供市场面板与测试）
    // ---------------------------------------------------------------------

    const COO_MARKET_CACHE_MS = 600_000;
    const COO_MARKET_KINDS = ['world', 'provider', 'bot', 'panel', 'other'];

    /** 本地过滤：name/description/keywords + kind。 */
    function filterCooMarketItems(items, query, kind, onlyDownloaded = false) {
      const needle = String(query ?? '').trim().toLowerCase();
      const wantedKind = kind && kind !== 'all' ? kind : null;
      return (Array.isArray(items) ? items : []).filter((item) => {
        if (!item || typeof item.name !== 'string') return false;
        if (onlyDownloaded && item.downloaded !== true) return false;
        if (wantedKind !== null && item.kind !== wantedKind) return false;
        if (needle === '') return true;
        const keywordText = Array.isArray(item.keywords) ? item.keywords.filter((word) => typeof word === 'string') : [];
        const haystack = [item.name, item.description, ...keywordText]
          .filter((part) => typeof part === 'string')
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    }

    /** 排序：downloads（月下载降序）或 updated（最近更新降序）。 */
    function sortCooMarketItems(items, sort) {
      const list = [...(Array.isArray(items) ? items : [])];
      if (sort === 'updated') {
        list.sort((left, right) => (Date.parse(right.updated ?? '') || 0) - (Date.parse(left.updated ?? '') || 0)
          || (right.downloadsMonthly ?? 0) - (left.downloadsMonthly ?? 0));
      } else {
        list.sort((left, right) => (right.downloadsMonthly ?? 0) - (left.downloadsMonthly ?? 0)
          || String(left.name).localeCompare(String(right.name)));
      }
      return list;
    }

    /** 月下载数格式化（4086 → 4.1k，34548 → 34.5k，1200000 → 1.2M）。 */
    function formatDownloads(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return '0';
      if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
      if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
      return String(Math.round(number));
    }

    /** kind 文案（未知 kind 回退 other）。 */
    function marketKindLabel(kind, t) {
      const key = COO_MARKET_KINDS.includes(kind) ? kind : 'other';
      return t(`mkt.kind.${key}`);
    }

    /** 规范化外链（去掉 git+ 前缀；只保留 http(s)）。 */
    function marketLinks(item) {
      const links = [];
      const clean = (url) => {
        if (typeof url !== 'string' || url === '') return null;
        const stripped = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://');
        return /^https?:\/\//.test(stripped) ? stripped : null;
      };
      const homepage = clean(item.homepage);
      const repository = clean(item.repository);
      const npm = clean(item.npm) ?? (typeof item.name === 'string' ? `https://www.npmjs.com/package/${item.name}` : null);
      if (homepage !== null) links.push({ key: 'homepage', labelKey: 'mkt.homepage', url: homepage });
      if (repository !== null) links.push({ key: 'repository', labelKey: 'mkt.repository', url: repository });
      if (npm !== null) links.push({ key: 'npm', labelKey: 'mkt.openNpm', url: npm });
      return links;
    }

    /** 市场列表一行（点击展开详情；行内可下载/安装）。 */
    function CooMarketRow(props) {
      const { item, open, t, onToggle, onCopy, onDownload, downloading, onInstall, installing, installConfirm, onInstallConfirm, onInstallCancel } = props;
      const links = marketLinks(item);
      const keywords = Array.isArray(item.keywords) ? item.keywords.slice(0, 12) : [];
      const downloaded = item.downloaded === true;
      return h('div', { className: 'mkt-row', 'data-open': open ? '1' : 'false', 'data-kind': item.kind },
        h('div', {
          className: 'mkt-summary',
          role: 'button',
          tabIndex: 0,
          onClick: onToggle,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); }
          },
        },
        h('span', { className: 'mkt-line' },
          h('span', { className: 'mkt-name' }, item.name),
          h('span', { className: 'mkt-version' }, item.version ? `v${item.version}` : ''),
          h('span', { className: 'mkt-kind', 'data-kind': item.kind }, marketKindLabel(item.kind, t)),
          item.installed
            ? h('span', { className: 'mkt-badge', 'data-installed': 'yes' }, `${t('mkt.installed')}${item.installedVersion ? ` · v${item.installedVersion}` : ''}`)
            : h('span', { className: 'mkt-badge' }, t('mkt.notInstalled')),
          downloaded
            ? h('span', { className: 'mkt-badge', 'data-downloaded': 'yes' }, `${t('mkt.downloaded')}${item.downloadedVersion ? ` v${item.downloadedVersion}` : ''}`)
            : null,
          h('span', { className: 'mkt-downloads' }, `↓ ${formatDownloads(item.downloadsMonthly)}/${t('mkt.downloads')}`)),
        h('span', { className: 'mkt-desc' }, item.description || '—')),
        h('button', {
          type: 'button',
          className: 'wp-btn mkt-download',
          disabled: downloading,
          onClick: (event) => { event.stopPropagation(); if (!downloading && typeof onDownload === 'function') onDownload(item.name); },
        }, downloading ? t('mkt.downloading') : (downloaded ? t('mkt.downloadAgain') : t('mkt.download'))),
        open
          ? h('div', { className: 'mkt-detail' },
            h('div', { className: 'mkt-detail-row' },
              t('mkt.publisher'), ' ', item.publisher || '—', ' · ', t('mkt.license'), ' ', item.license || '—',
              item.updated ? ` · ${t('mkt.updatedAt')} ${String(item.updated).slice(0, 10)}` : ''),
            keywords.length > 0
              ? h('div', { className: 'mkt-detail-row' }, `${t('mkt.keywords')}：`,
                h('span', { className: 'mkt-keywords' }, keywords.map((word) => h('span', { className: 'mkt-keyword', key: word }, word))))
              : null,
            h('div', { className: 'mkt-detail-row' }, links.map((link) => h('a', {
              key: link.key,
              className: 'mkt-link',
              href: link.url,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, t(link.labelKey)))),
            h('div', { className: 'set-actions' },
              h('button', {
                type: 'button',
                className: 'wp-btn wp-btn-primary',
                disabled: downloading,
                onClick: (event) => { event.stopPropagation(); if (!downloading && typeof onDownload === 'function') onDownload(item.name); },
              }, downloading ? t('mkt.downloading') : t('mkt.download')),
              h('button', {
                type: 'button',
                className: 'wp-btn',
                onClick: (event) => { event.stopPropagation(); if (typeof onCopy === 'function') onCopy(item.name); },
              }, t('mkt.copy')),
              h('button', {
                type: 'button',
                className: 'wp-btn',
                disabled: installing || !downloaded,
                onClick: (event) => {
                  event.stopPropagation();
                  if (typeof onInstall === 'function') onInstall(downloaded ? item.name : null);
                },
              }, installing ? t('mkt.installing') : t('mkt.installToCoop'))),
            !downloaded ? h('div', { className: 'set-note' }, t('mkt.installNeedDownload')) : null,
            installConfirm === item.name
              ? h('div', { className: 'set-note set-note-warn' },
                h('div', {}, t('mkt.installWarning')),
                h('div', { className: 'set-actions' },
                  h('button', { type: 'button', className: 'wp-btn wp-btn-primary', disabled: installing, onClick: (event) => { event.stopPropagation(); if (typeof onInstallConfirm === 'function') onInstallConfirm(item.name); } }, t('mkt.installConfirm')),
                  h('button', { type: 'button', className: 'wp-btn', disabled: installing, onClick: (event) => { event.stopPropagation(); if (typeof onInstallCancel === 'function') onInstallCancel(); } }, t('mkt.installCancel'))))
              : null,
            h('div', { className: 'set-note' }, t('mkt.installHint').replace('{pkg}', item.name)))
          : null);
    }

    /** 「Coo 市场」Tab：浏览/下载 npm 上的 Cortico 扩展；安装到 Coopanion 需二次确认（不执行扩展代码）。 */
    function CooMarketPanel(props) {
      const t = props && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [query, setQuery] = useState('');
      const [kind, setKind] = useState('all');
      const [sort, setSort] = useState('downloads');
      const [onlyDownloaded, setOnlyDownloaded] = useState(false);
      const [expanded, setExpanded] = useState('');
      const [downloading, setDownloading] = useState([]);
      const [installing, setInstalling] = useState(false);
      const [installConfirm, setInstallConfirm] = useState('');
      const aliveRef = useRef(false);
      const tRef = useRef(t);
      tRef.current = t;

      const load = useCallback(async () => {
        setLoading(true);
        const result = await fetchJson(api('coo-market'), { timeoutMs: 20_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data && typeof result.data === 'object') {
          setData(result.data);
          setError(result.data.ok === false
            ? `${tRef.current('mkt.npmFailed')}：${result.data.error || ''}`
            : '');
        } else {
          setError(readableReason(result, tRef.current));
        }
        setLoading(false);
      }, []);

      useEffect(() => {
        aliveRef.current = true;
        load();
        return () => { aliveRef.current = false; };
      }, [load]);

      const items = data && Array.isArray(data.items) ? data.items : [];
      const downloadedNames = new Set((data && Array.isArray(data.downloaded) ? data.downloaded : []).map((entry) => entry.name));
      const withFlags = items.map((item) => ({ ...item, downloaded: item.downloaded === true || downloadedNames.has(item.name) }));
      const visible = sortCooMarketItems(filterCooMarketItems(withFlags, query, kind, onlyDownloaded), sort);
      const installedCount = data && Array.isArray(data.installed) ? data.installed.length : 0;
      const downloadedCount = (data && Array.isArray(data.downloaded) ? data.downloaded.length : 0);
      const stale = !!(data && data.ok === false && data.cached === true && items.length > 0);
      const downloadsDir = data && typeof data.downloadsDir === 'string' ? data.downloadsDir : '';

      const copyName = async (name) => {
        setNotice('');
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('clipboard unavailable');
          }
          await navigator.clipboard.writeText(name);
          setNotice(tRef.current('mkt.copied'));
        } catch {
          setNotice(tRef.current('mkt.copyFailed'));
        }
      };

      const download = async (name) => {
        if (typeof name !== 'string' || downloading.includes(name)) return;
        setDownloading((previous) => [...previous, name]);
        setNotice('');
        setError('');
        try {
          const result = await fetchJson(api('coo-market/download'), { method: 'POST', body: { name }, timeoutMs: 180_000 });
          if (!aliveRef.current) return;
          if (result.ok && result.data && result.data.ok === true) {
            const dataOut = result.data;
            setNotice(tRef.current('mkt.downloadNotice').replace('<name>', dataOut.name));
            setInstallConfirm('');
            await load();
          } else {
            setError(`${tRef.current('mkt.downloadFailed')}：${readableReason(result, tRef.current)}`);
          }
        } finally {
          if (aliveRef.current) setDownloading((previous) => previous.filter((item) => item !== name));
        }
      };

      const openDownloadsDir = async () => {
        setNotice('');
        const result = await fetchJson(api('coo-market/open-dir'), { method: 'POST', timeoutMs: 5_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data && result.data.ok === true) setNotice(result.data.path);
        else setError(readableReason(result, tRef.current));
      };

      const requestInstall = (name) => {
        if (typeof name !== 'string') return;
        setNotice('');
        setInstallConfirm(name);
      };

      const confirmInstall = async (name) => {
        if (installing) return;
        setInstalling(true);
        setNotice('');
        setError('');
        try {
          const result = await fetchJson(api('coo-market/install'), {
            method: 'POST',
            body: { name, confirm: true },
            timeoutMs: 320_000,
          });
          if (!aliveRef.current) return;
          if (result.ok && result.data && result.data.ok === true) {
            setNotice(tRef.current('mkt.installedNotice'));
            setInstallConfirm('');
            await load();
          } else {
            setError(`${tRef.current('mkt.installFailed')}：${readableReason(result, tRef.current)}`);
          }
        } finally {
          if (aliveRef.current) setInstalling(false);
        }
      };

      return h('div', { className: 'wp-root', 'data-coo-market': '1' },
        h('style', { dangerouslySetInnerHTML: { __html: `${STYLE_CSS}\n${CONTROL_STYLE_CSS}\n${SHELL_STYLE_CSS}` } }),
        h('header', { className: 'wp-header' },
          h('div', { className: 'wp-heading' },
            h('div', { className: 'wp-title' }, t('tab.market')),
            h('div', { className: 'wp-sub' },
              h('span', { className: 'wp-chip' }, loading
                ? t('mkt.loading')
                : t('mkt.count').replace('{n}', String(visible.length))),
              installedCount > 0 ? h('span', { className: 'wp-chip' }, `${t('mkt.installed')} ${installedCount}`) : null,
              downloadedCount > 0 ? h('span', { className: 'wp-chip', 'data-downloaded-count': '1' }, `${t('mkt.downloaded')} ${downloadedCount}`) : null,
              stale ? h('span', { className: 'wp-chip' }, t('mkt.stale')) : null,
              data && data.updatedAt
                ? h('span', { className: 'wp-chip' }, t('mkt.cached').replace('{t}', new Date(data.updatedAt).toLocaleTimeString()))
                : null)),
          h('div', { className: 'wp-actions' },
            h('button', { type: 'button', className: 'wp-btn', onClick: openDownloadsDir }, t('mkt.openDownloadsDir')),
            h('button', { type: 'button', className: 'wp-btn', onClick: load, disabled: loading }, t('mkt.refresh')))),
        h('div', { className: 'wp-banners' },
          h('div', { className: 'wp-banner' }, t('mkt.note'))),
        error !== '' ? h('div', { className: 'wp-banners' }, h('div', { className: 'wp-banner wp-banner-error' }, error)) : null,
        notice !== '' ? h('div', { className: 'wp-banners' }, h('div', { className: 'wp-banner wp-banner-ok' }, notice)) : null,
        h('div', { className: 'mkt-toolbar' },
          h('input', {
            className: 'set-input mkt-search',
            type: 'search',
            value: query,
            placeholder: t('mkt.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('label', { className: 'mkt-filter' }, t('mkt.kind'), ' ',
            h('select', { className: 'set-select', value: kind, onChange: (event) => setKind(event.target.value) },
              h('option', { value: 'all' }, t('mkt.kind.all')),
              COO_MARKET_KINDS.map((item) => h('option', { key: item, value: item }, t(`mkt.kind.${item}`))))),
          h('label', { className: 'mkt-filter' }, t('mkt.sort'), ' ',
            h('select', { className: 'set-select', value: sort, onChange: (event) => setSort(event.target.value) },
              h('option', { value: 'downloads' }, t('mkt.sort.downloads')),
              h('option', { value: 'updated' }, t('mkt.sort.updated')))),
          h('label', { className: 'set-check mkt-filter' },
            h('input', { type: 'checkbox', checked: onlyDownloaded, onChange: (event) => setOnlyDownloaded(event.target.checked) }),
            ` ${t('mkt.filterDownloaded')}`),
          downloadsDir !== '' ? h('span', { className: 'set-row-hint' }, `${t('mkt.downloadsDir')}: ${downloadsDir}`) : null),
        h('div', { className: 'wp-scroll mkt-list' },
          loading && items.length === 0
            ? h('div', { className: 'set-note' }, t('mkt.loading'))
            : visible.length === 0
              ? h('div', { className: 'set-note' }, t('mkt.empty'))
              : visible.map((item) => h(CooMarketRow, {
                key: item.name,
                item,
                open: expanded === item.name,
                t,
                onToggle: () => setExpanded(expanded === item.name ? '' : item.name),
                onCopy: copyName,
                onDownload: download,
                downloading: downloading.includes(item.name),
                onInstall: requestInstall,
                installing: installing && installConfirm === item.name,
                installConfirm,
                onInstallConfirm: confirmInstall,
                onInstallCancel: () => setInstallConfirm(''),
              }))));
    }

    // ---------------------------------------------------------------------
    // 桌宠 DIY 工具（T23；纯函数，供设置页与测试）
    // ---------------------------------------------------------------------

    /** 找形象包。 */
    function findPetPack(packs, figureId) {
      return (Array.isArray(packs) ? packs : []).find((pack) => pack && pack.id === figureId) ?? null;
    }

    /** 取某外观轴的当前值（固定字段优先，其次 skin.axes）。 */
    function petAxisValue(skin, axisId) {
      if (!skin || typeof skin !== 'object') return null;
      if (typeof skin[axisId] === 'string') return skin[axisId];
      if (skin.axes && typeof skin.axes === 'object' && typeof skin.axes[axisId] === 'string') return skin.axes[axisId];
      return null;
    }

    /** 切换形象包时构造合法 skin：每个轴用旧值（若合法）否则第一个 option；非固定轴塞进 axes。 */
    function petSkinForFigure(packs, figureId, previous) {
      const pack = findPetPack(packs, figureId) ?? (Array.isArray(packs) ? packs[0] : null);
      const prev = previous && typeof previous === 'object' ? previous : {};
      const skin = { figure: pack && pack.id ? pack.id : (figureId || 'whale') };
      const axes = {};
      for (const axis of (pack && Array.isArray(pack.axes) ? pack.axes : [])) {
        const optionIds = (axis.options ?? []).map((option) => option.id);
        const current = typeof prev[axis.id] === 'string' ? prev[axis.id] : (prev.axes && prev.axes[axis.id]);
        const fallback = optionIds.includes('none') ? 'none' : (optionIds[0] ?? 'none');
        const value = optionIds.includes(current) ? current : fallback;
        if (PET_FIXED_SKIN_FIELDS.includes(axis.id)) skin[axis.id] = value;
        else axes[axis.id] = value;
      }
      for (const key of PET_FIXED_SKIN_FIELDS) {
        if (skin[key] === undefined && typeof prev[key] === 'string') skin[key] = prev[key];
      }
      skin.axes = axes;
      return skin;
    }

    /** 设置某个轴（固定字段 or axes）。 */
    function setPetSkinAxis(draft, axisId, value) {
      const skin = { ...draft.skin, axes: { ...(draft.skin.axes ?? {}) } };
      if (PET_FIXED_SKIN_FIELDS.includes(axisId)) skin[axisId] = value;
      else skin.axes[axisId] = value;
      return { ...draft, skin };
    }

    /** 应用预设（pick 里的合法轴值写进 skin）。 */
    function applyPetPreset(draft, pack, preset) {
      const skin = { ...draft.skin, axes: { ...(draft.skin.axes ?? {}) } };
      const axes = pack && Array.isArray(pack.axes) ? pack.axes : [];
      for (const [axisId, value] of Object.entries(preset && preset.pick ? preset.pick : {})) {
        const axis = axes.find((item) => item.id === axisId);
        if (!axis || !(axis.options ?? []).some((option) => option.id === value)) continue;
        if (PET_FIXED_SKIN_FIELDS.includes(axisId)) skin[axisId] = value;
        else skin.axes[axisId] = value;
      }
      return { ...draft, skin };
    }

    /** `GET /whale-panel/pet-diy` → 设置页草稿。 */
    function petDraftFromData(petDiy) {
      const settings = petDiy && petDiy.settings && typeof petDiy.settings === 'object' ? petDiy.settings : {};
      const packs = petDiy && Array.isArray(petDiy.packs) ? petDiy.packs : [];
      const skinSource = settings.skin && typeof settings.skin === 'object' ? settings.skin : {};
      const figure = skinSource.figure || (petDiy && petDiy.current && petDiy.current.figure) || (packs[0] && packs[0].id) || 'whale';
      const skin = petSkinForFigure(packs, figure, { ...(petDiy && petDiy.current ? petDiy.current : {}), ...skinSource });
      const num = (value, fallback) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value));
      return {
        skin,
        scale: num(settings.scale, 2),
        bubbleSize: num(settings.bubbleSize, 1),
        fontSize: num(settings.fontSize, 1),
        bubbleSpeed: num(settings.bubbleSpeed, 1),
        glow: num(settings.glow, 7),
        theme: settings.theme === 'light' ? 'light' : 'dark',
        roam: ['free', 'calm', 'off'].includes(settings.roam) ? settings.roam : 'free',
        sound: settings.sound !== false,
        hoverButtons: Array.isArray(settings.hoverButtons) ? [...settings.hoverButtons] : ['chat', 'cooChat'],
        doubleClickChat: settings.doubleClickChat !== false,
        frameRate: num(settings.frameRate, 0),
        lockFrameRate: settings.lockFrameRate !== false,
      };
    }

    /** 草稿 → POST body（只含白名单字段）。 */
    function collectPetDiyBody(draft) {
      const skin = { ...draft.skin };
      const axes = skin.axes && typeof skin.axes === 'object' ? { ...skin.axes } : {};
      if (Object.keys(axes).length > 0) skin.axes = axes;
      else delete skin.axes;
      return {
        skin,
        scale: draft.scale,
        bubbleSize: draft.bubbleSize,
        fontSize: draft.fontSize,
        bubbleSpeed: draft.bubbleSpeed,
        glow: draft.glow,
        theme: draft.theme,
        roam: draft.roam,
        sound: draft.sound,
        hoverButtons: Array.isArray(draft.hoverButtons) ? draft.hoverButtons : [],
        doubleClickChat: draft.doubleClickChat,
        frameRate: draft.frameRate,
        lockFrameRate: draft.lockFrameRate,
      };
    }

    /** 「当前：whale · harness · maid · scale 2」摘要。 */
    function petDiySummary(petDiy, draft) {
      const current = petDiy && petDiy.current ? petDiy.current : {};
      const skin = draft && draft.skin ? draft.skin : {};
      const figure = current.figure || skin.figure || '—';
      const pack = findPetPack(petDiy && petDiy.packs, figure) ?? findPetPack(petDiy && petDiy.packs, skin.figure);
      const parts = [figure];
      for (const axis of (pack && Array.isArray(pack.axes) ? pack.axes : [])) {
        const value = petAxisValue(skin, axis.id) ?? petAxisValue(current, axis.id);
        if (value && value !== 'none') parts.push(value);
      }
      const scale = Number(draft && draft.scale !== undefined ? draft.scale : current.scale);
      if (Number.isFinite(scale)) parts.push(`scale ${scale}`);
      return parts.join(' · ');
    }

    // ---------------------------------------------------------------------
    // 合并版外壳：顶部 Tab（聊天 / 总控台 / 设置）+ 设置页（T21）
    // ---------------------------------------------------------------------

    const SHELL_STYLE_CSS = [
      '.wp-shell{display:flex;flex-direction:column;height:100%;min-height:0;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}',
      '.wp-shell-tabs{display:flex;align-items:center;gap:4px;padding:8px 14px;flex:none;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.wp-tab{appearance:none;border:1px solid transparent;background:transparent;',
      'color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 14px;',
      'font:inherit;font-size:13px;line-height:1.4;cursor:pointer;}',
      '.wp-tab:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.wp-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.wp-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2);',
      'border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.wp-shell-body{flex:1;min-height:0;display:flex;flex-direction:column;}',
      '.wp-chat-size-small .wp-bubble{font-size:12px;}',
      '.wp-chat-size-medium .wp-bubble{font-size:inherit;}',
      '.wp-chat-size-large .wp-bubble{font-size:16px;}',
      '.set-group{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.set-group-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.set-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;line-height:1.6;}',
      '.set-row-label{flex:none;min-width:150px;color:var(--dsw-alias-label-secondary);}',
      '.set-row-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.set-input,.set-select{font:inherit;font-size:13px;padding:5px 8px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);',
      'color:var(--dsw-alias-label-primary);}',
      '.set-input:focus,.set-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0;}',
      '.set-input{min-width:min(360px,100%);}',
      '.set-checks{display:flex;flex-wrap:wrap;gap:8px 14px;}',
      '.set-check{display:inline-flex;align-items:center;gap:5px;font-size:13px;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;}',
      '.set-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.set-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary);}',
      '.set-note-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.set-note-error{color:var(--dsw-alias-state-error-primary);}',
      '.set-mono{font-family:var(--dsh-code-font-family, monospace);font-size:12px;',
      'color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.set-range{width:min(260px,100%);accent-color:var(--dsw-alias-brand-primary);}',
      '.set-range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.mkt-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px;flex:none;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.mkt-search{min-width:min(320px,100%);}',
      '.mkt-filter{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary);}',
      '.mkt-list{display:flex;flex-direction:column;gap:8px;padding:12px 16px;}',
      '.mkt-row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.mkt-row[data-open="1"]{border-color:var(--dsw-alias-brand-primary);}',
      '.mkt-summary{appearance:none;display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;',
      'border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;padding:10px 12px;cursor:pointer;}',
      '.mkt-summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:10px;}',
      '.mkt-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.mkt-name{font-weight:600;font-size:13px;overflow-wrap:anywhere;}',
      '.mkt-version{font-family:var(--dsh-code-font-family, monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.mkt-kind{font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}',
      '.mkt-kind[data-kind="world"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary);}',
      '.mkt-kind[data-kind="provider"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-tertiary);}',
      '.mkt-kind[data-kind="bot"]{color:var(--dsw-alias-brand-primary);}',
      '.mkt-badge{font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-tertiary);}',
      '.mkt-badge[data-installed="yes"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-tertiary);}',
      '.mkt-downloads{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:auto;}',
      '.mkt-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.mkt-detail{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px;border-top:1px dashed var(--dsw-alias-border-l2);}',
      '.mkt-detail-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:1.6;',
      'color:var(--dsw-alias-label-tertiary);}',
      '.mkt-keywords{display:inline-flex;gap:5px;flex-wrap:wrap;}',
      '.mkt-keyword{font-size:11px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}',
      '.mkt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;}',
      '.mkt-link:hover{text-decoration:underline;}',
      '.mkt-download{flex:none;margin:0 12px 10px;align-self:flex-start;}',
      '.mkt-summary{cursor:pointer;}',
      '.mkt-badge[data-downloaded="yes"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.mkt-install-warn{color:var(--dsw-alias-state-warn-primary);}',
    ].join('');

    /** 设置页（T21）：面板偏好 / 情境观察 / 服务器 QQ 预览 / 路径。 */
    function SettingsPanel(props) {
      const t = props && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const switchTab = props && typeof props.switchTab === 'function' ? props.switchTab : null;
      const initial = normalizeLocalSettings(props && props.settings);
      const [detail, setDetail] = useState(null);
      const [draft, setDraft] = useState(initial);
      const [qqDraft, setQqDraft] = useState({ qqPreviewGroup: true, groupsText: '', chatsText: '', qqPreviewMaxItems: 4, qqPreviewMaxChars: 60 });
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [applying, setApplying] = useState(false);
      const [confirmApply, setConfirmApply] = useState(false);
      const [notice, setNotice] = useState('');
      const [error, setError] = useState('');
      const [applyInfo, setApplyInfo] = useState(null);
      const [conn, setConn] = useState({
        sidebarLabel: '', panelTitle: '', bridgeUrl: '', serverSshHost: '', awarenessPath: '', groupsText: '', chatsText: '',
      });
      const [petDiy, setPetDiy] = useState(null);
      const [petDraft, setPetDraft] = useState(null);
      const [importing, setImporting] = useState(false);
      const [importConflict, setImportConflict] = useState(null);
      const fileInputRef = useRef(null);
      const [petError, setPetError] = useState('');
      const [petSaving, setPetSaving] = useState(false);
      const aliveRef = useRef(false);
      const tRef = useRef(t);
      tRef.current = t;

      /** 读本地设置 + 观察器状态 + 服务器 awareness 配置。 */
      const load = useCallback(async () => {
        const [result, petResult] = await Promise.all([
          fetchJson(api('settings'), { timeoutMs: 25_000 }),
          fetchJson(api('pet-diy'), { timeoutMs: 10_000 }),
        ]);
        if (aliveRef.current) {
          if (petResult.ok && petResult.data && petResult.data.ok === true) {
            setPetDiy(petResult.data);
            setPetDraft(petDraftFromData(petResult.data));
            setPetError('');
          } else {
            setPetError(`${tRef.current('set.pet.packsError')}：${readableReason(petResult, tRef.current)}`);
          }
        }
        if (!aliveRef.current) return null;
        if (result.ok && result.data && result.data.ok === true) {
          const data = result.data;
          setDetail(data);
          setDraft(normalizeLocalSettings(data.settings));
          const localSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
          const ui = data.ui && typeof data.ui === 'object' ? data.ui : {};
          const qqDefaults = data.qqDefaults && typeof data.qqDefaults === 'object' ? data.qqDefaults : {};
          setConn({
            sidebarLabel: typeof ui.sidebarLabel === 'string' ? ui.sidebarLabel : '',
            panelTitle: typeof ui.panelTitle === 'string' ? ui.panelTitle : '',
            bridgeUrl: typeof localSettings.bridgeUrl === 'string' ? localSettings.bridgeUrl : '',
            serverSshHost: typeof localSettings.serverSshHost === 'string'
              ? localSettings.serverSshHost
              : (data.sshConfig && typeof data.sshConfig.host === 'string' ? data.sshConfig.host : ''),
            awarenessPath: typeof localSettings.awarenessPatchPath === 'string' && localSettings.awarenessPatchPath !== ''
              ? localSettings.awarenessPatchPath
              : (data.sshConfig && typeof data.sshConfig.patchPath === 'string' ? data.sshConfig.patchPath : ''),
            groupsText: joinIdList(Array.isArray(localSettings.qqPreviewGroups) ? localSettings.qqPreviewGroups : qqDefaults.qqPreviewGroups),
            chatsText: joinIdList(Array.isArray(localSettings.qqPreviewChats) ? localSettings.qqPreviewChats : qqDefaults.qqPreviewChats),
          });
          const awarenessConfig = data.awareness && data.awareness.config ? data.awareness.config : null;
          if (awarenessConfig) {
            setQqDraft({
              qqPreviewGroup: awarenessConfig.qqPreviewGroup !== false,
              groupsText: joinIdList(awarenessConfig.qqPreviewGroups),
              chatsText: joinIdList(awarenessConfig.qqPreviewChats),
              qqPreviewMaxItems: Number.isFinite(Number(awarenessConfig.qqPreviewMaxItems)) ? Number(awarenessConfig.qqPreviewMaxItems) : 4,
              qqPreviewMaxChars: Number.isFinite(Number(awarenessConfig.qqPreviewMaxChars)) ? Number(awarenessConfig.qqPreviewMaxChars) : 60,
            });
          }
          setError('');
          return data;
        }
        setError(`${tRef.current('cc.err.status')}：${readableReason(result, tRef.current)}`);
        return null;
      }, []);

      useEffect(() => {
        aliveRef.current = true;
        const timer = setTimeout(() => {
          load().finally(() => {
            if (aliveRef.current) setLoading(false);
          });
        }, 0);
        return () => {
          aliveRef.current = false;
          clearTimeout(timer);
        };
      }, [load]);

      /** 保存本地设置（立即生效，并回传给外壳）。 */
      const saveLocal = async () => {
        if (saving) return;
        setSaving(true);
        setNotice('');
        setError('');
        try {
          const body = {
            ...draft,
            ui: { sidebarLabel: conn.sidebarLabel.trim(), panelTitle: conn.panelTitle.trim() },
            bridgeUrl: conn.bridgeUrl.trim(),
            serverSshHost: conn.serverSshHost.trim(),
            awarenessPatchPath: conn.awarenessPath.trim(),
            qqPreviewGroups: parseIdList(conn.groupsText, 'group'),
            qqPreviewChats: parseIdList(conn.chatsText, 'private'),
          };
          const result = await fetchJson(api('settings'), { method: 'POST', body, timeoutMs: 10_000 });
          if (!aliveRef.current) return;
          if (result.ok && result.data && result.data.ok === true) {
            const next = normalizeLocalSettings(result.data.settings);
            setDraft(next);
            setNotice(`${tRef.current('set.saved')}；${tRef.current('set.labelsReloadHint')}`);
            if (props && typeof props.onSettingsSaved === 'function') props.onSettingsSaved(next);
          } else {
            setError(readableReason(result, tRef.current));
          }
        } finally {
          if (aliveRef.current) setSaving(false);
        }
      };

      /** 暂停/恢复情境观察（沿用 /control-center/pause-context）。 */
      const togglePause = async () => {
        const currentlyPaused = !!(detail && detail.observer && detail.observer.paused);
        setNotice('');
        const result = await fetchJson(controlApi('pause-context'), {
          method: 'POST',
          body: { paused: !currentlyPaused },
          timeoutMs: 8_000,
        });
        if (!aliveRef.current) return;
        if (result.ok && result.data && result.data.ok === true) {
          setNotice(result.data.paused ? tRef.current('cc.pausedNotice') : tRef.current('cc.resumedNotice'));
          await load();
        } else {
          setError(readableReason(result, tRef.current));
        }
      };

      /** 打开 dsh-link 目录（Host 侧 explorer，固定路径）。 */
      const openDirectory = async () => {
        setNotice('');
        const result = await fetchJson(api('open-directory'), { method: 'POST', timeoutMs: 5_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data && result.data.ok === true) setNotice(`已打开：${result.data.path}`);
        else setError(readableReason(result, tRef.current));
      };

      /** 应用服务器 QQ 预览（二次确认；写 patch + 重启 dsh-web）。 */
      const applyAwareness = async () => {
        if (applying) return;
        if (!confirmApply) {
          setConfirmApply(true);
          return;
        }
        setApplying(true);
        setNotice('');
        setError('');
        setApplyInfo(null);
        const body = collectAwarenessBody(true, qqDraft);
        try {
          const result = await fetchJson(api('apply-awareness'), { method: 'POST', body, timeoutMs: 95_000 });
          if (!aliveRef.current) return;
          if (result.ok && result.data && result.data.ok === true) {
            const restart = result.data.restart || {};
            setNotice(`${tRef.current('set.qq.applied')}（active=${restart.active ?? '?'}，${Math.round(Number(restart.ms) || 0)}ms）`);
            setApplyInfo(result.data);
            setConfirmApply(false);
            await load();
          } else {
            const data = result.data || {};
            const parts = [readableReason(result, tRef.current)];
            if (data.journalTail) parts.push(String(data.journalTail).split(/\r?\n/).slice(-4).join(' | '));
            if (data.restored === true) parts.push('已自动回滚到备份配置');
            setError(`${tRef.current('set.qq.applyFailed')}：${parts.join('；')}`);
            setApplyInfo(data);
            setConfirmApply(false);
          }
        } finally {
          if (aliveRef.current) setApplying(false);
        }
      };


      /** 刷新形象包列表（重新 GET pet-diy；保留当前草稿）。 */
      const refreshPetPacks = async () => {
        setPetError('');
        const result = await fetchJson(api('pet-diy'), { timeoutMs: 10_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data && result.data.ok === true) {
          setPetDiy(result.data);
          if (petDraft === null) setPetDraft(petDraftFromData(result.data));
        } else {
          setPetError(`${tRef.current('set.pet.packsError')}：${readableReason(result, tRef.current)}`);
        }
      };

      /** T30：应用导入结果 —— 刷新 packs 并选中新包（不自动保存 pet-settings）。 */
      const applyImportedPack = async (data) => {
        const result = await fetchJson(api('pet-diy'), { timeoutMs: 10_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data && result.data.ok === true) {
          const snapshot = result.data;
          setPetDiy(snapshot);
          const fresh = petDraftFromData(snapshot);
          const skin = petSkinForFigure(snapshot.packs, data.id, { ...fresh.skin, ...(petDraft && petDraft.skin ? petDraft.skin : {}) });
          setPetDraft({ ...fresh, skin });
        }
        setNotice(tRef.current('set.pet.imported')
          .replace('{id}', data.id || '')
          .replace('{version}', typeof data.version === 'string' && data.version !== '' ? ` v${data.version}` : ''));
      };

      /** T30：处理用户选中的 zip 文件（≤128MB；409 时进入替换确认）。 */
      const handlePackFile = async (file, options = {}) => {
        if (!file || importing) return;
        const replace = options.replace === true;
        setImportConflict(null);
        setNotice('');
        if (typeof file.size === 'number' && file.size > PET_IMPORT_MAX_BYTES) {
          setError(tRef.current('set.pet.importTooLarge'));
          return;
        }
        setImporting(true);
        setError('');
        try {
          const result = await uploadPetPack(file, replace);
          if (!aliveRef.current) return;
          if (result.ok && result.data) {
            await applyImportedPack(result.data);
          } else if (result.status === 409) {
            setImportConflict({
              file,
              id: (result.data && result.data.id) || (result.data && result.data.error && result.data.error.id) || '',
            });
          } else {
            const message = result.data && result.data.error && result.data.error.message
              ? result.data.error.message
              : readableReason({ ok: false, status: result.status, data: result.data }, tRef.current);
            setError(`${tRef.current('set.pet.importFailed')}：${message}`);
          }
        } finally {
          if (aliveRef.current) setImporting(false);
        }
      };

      /** T30：选中文件（input change）。 */
      const onPackFileChosen = (event) => {
        const file = event && event.target && event.target.files && event.target.files[0];
        if (event && event.target) {
          try { event.target.value = ''; } catch { /* ignore */ }
        }
        if (file) handlePackFile(file);
      };

      /** 选择形象包：按新 pack 的 axes 重建合法 skin。 */
      const selectPetPack = (figureId) => {
        if (!petDraft) return;
        const skin = petSkinForFigure(petDiy && petDiy.packs, figureId, { ...petDraft.skin, ...(petDiy && petDiy.current ? petDiy.current : {}), ...petDraft.skin });
        setPetDraft({ ...petDraft, skin });
      };

      /** 保存并应用桌宠 DIY（Host 写 pet-settings.json，插件 ~1s 热应用）。 */
      const savePet = async () => {
        if (!petDraft || petSaving) return;
        setPetSaving(true);
        setNotice('');
        setError('');
        try {
          const result = await fetchJson(api('pet-diy'), {
            method: 'POST',
            body: collectPetDiyBody(petDraft),
            timeoutMs: 10_000,
          });
          if (!aliveRef.current) return;
          if (result.ok && result.data && result.data.ok === true) {
            const data = result.data;
            setPetDiy((previous) => ({ ...(previous || {}), ...data, settings: data.settings, current: data.current }));
            setPetDraft(petDraftFromData(data));
            setNotice(tRef.current('set.pet.saved'));
          } else {
            setError(readableReason(result, tRef.current));
          }
        } finally {
          if (aliveRef.current) setPetSaving(false);
        }
      };

      const petNumberRow = (label, key, min, max, step) => h('div', { className: 'set-row' },
        h('span', { className: 'set-row-label' }, label),
        h('input', {
          className: 'set-range',
          type: 'range',
          min,
          max,
          step,
          value: petDraft[key],
          onChange: (event) => setPetDraft({ ...petDraft, [key]: Number(event.target.value) }),
        }),
        h('span', { className: 'set-mono' }, String(petDraft[key])));

      const awareness = detail && detail.awareness ? detail.awareness : null;
      const observer = detail && detail.observer ? detail.observer : null;
      const awarenessOk = !!(awareness && awareness.ok === true);
      const selectRow = (label, value, options, onChange, hint) => h('div', { className: 'set-row' },
        h('span', { className: 'set-row-label' }, label),
        h('select', { className: 'set-select', value: String(value), onChange },
          options.map((option) => h('option', { key: String(option.value), value: String(option.value) }, option.label))),
        hint ? h('span', { className: 'set-row-hint' }, hint) : null);

      return h('div', { className: 'wp-root', 'data-whale-settings': '1' },
        h('header', { className: 'wp-header' },
          h('div', { className: 'wp-heading' },
            h('div', { className: 'wp-title' }, t('set.title')),
            h('div', { className: 'wp-sub' },
              h('span', { className: 'wp-chip' }, loading ? t('set.loading') : (detail && detail.settingsFile ? detail.settingsFile : t('set.short'))))),
          h('div', { className: 'wp-actions' },
            switchTab !== null
              ? h('button', { type: 'button', className: 'wp-btn', onClick: () => switchTab('control') }, t('tab.control'))
              : null)),
        error !== '' ? h('div', { className: 'wp-banners' }, h('div', { className: 'wp-banner wp-banner-error' }, error)) : null,
        notice !== '' ? h('div', { className: 'wp-banners' }, h('div', { className: 'wp-banner wp-banner-ok' }, notice)) : null,
        h('div', { className: 'wp-scroll' },
          // ── 通用 / 连接（T26）──
          h('div', { className: 'set-group', 'data-general': '1' },
            h('div', { className: 'set-group-title' }, t('set.group.general')),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.uiLabel')),
              h('input', {
                className: 'set-input',
                value: conn.sidebarLabel,
                placeholder: '鲸歌',
                onChange: (event) => setConn({ ...conn, sidebarLabel: event.target.value }),
              })),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.panelTitle')),
              h('input', {
                className: 'set-input',
                value: conn.panelTitle,
                placeholder: t('set.uiLabel'),
                onChange: (event) => setConn({ ...conn, panelTitle: event.target.value }),
              })),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.bridgeUrl')),
              h('input', {
                className: 'set-input',
                value: conn.bridgeUrl,
                placeholder: detail && typeof detail.bridgeUrl === 'string' ? detail.bridgeUrl : 'http://127.0.0.1:47891',
                onChange: (event) => setConn({ ...conn, bridgeUrl: event.target.value }),
              })),
            h('div', { className: 'set-note' }, t('set.bridgeHint')),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.sshHost')),
              h('input', {
                className: 'set-input',
                value: conn.serverSshHost,
                placeholder: 'user@host',
                onChange: (event) => setConn({ ...conn, serverSshHost: event.target.value }),
              })),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.awarenessPath')),
              h('input', {
                className: 'set-input',
                value: conn.awarenessPath,
                placeholder: '/srv/awareness/cordis.patch.yml',
                onChange: (event) => setConn({ ...conn, awarenessPath: event.target.value }),
              })),
            h('div', { className: 'set-note' }, detail && detail.sshConfig && detail.sshConfig.enabled === false
              ? t('set.sshDisabledHint')
              : t('set.sshHint')),
            h('div', { className: 'set-note' }, t('set.awarenessPathHint')),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.qqGroups')),
              h('input', {
                className: 'set-input',
                value: conn.groupsText,
                placeholder: 'group:<id>',
                onChange: (event) => setConn({ ...conn, groupsText: event.target.value }),
              })),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.qqChats')),
              h('input', {
                className: 'set-input',
                value: conn.chatsText,
                placeholder: 'private:<id>',
                onChange: (event) => setConn({ ...conn, chatsText: event.target.value }),
              })),
            h('div', { className: 'set-note' }, t('set.qqLocalHint')),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.pathDshLinkRoot')),
              h('span', { className: 'set-mono' }, detail && detail.paths && detail.paths.dshLinkRoot ? detail.paths.dshLinkRoot : '—'),
              h('span', { className: 'set-row-label' }, t('set.pathDownloads')),
              h('span', { className: 'set-mono' }, detail && detail.paths && detail.paths.downloadsDir ? detail.paths.downloadsDir : '—')),
            h('div', { className: 'set-note' }, t('set.labelsReloadHint')),
            h('div', { className: 'set-actions' },
              h('button', { type: 'button', className: 'wp-btn wp-btn-primary', onClick: saveLocal, disabled: saving || loading },
                saving ? t('set.saving') : t('set.save')))),
          // ── 面板偏好 ──
          h('div', { className: 'set-group' },
            h('div', { className: 'set-group-title' }, t('set.group.panel')),
            selectRow(t('set.refresh'), draft.refreshIntervalMs, [
              { value: 5_000, label: t('set.seconds').replace('{n}', '5') },
              { value: 10_000, label: t('set.seconds').replace('{n}', '10') },
              { value: 30_000, label: t('set.seconds').replace('{n}', '30') },
            ], (event) => setDraft({ ...draft, refreshIntervalMs: Number(event.target.value) })),
            selectRow(t('set.fontsize'), draft.chatFontSize, [
              { value: 'small', label: t('set.font.small') },
              { value: 'medium', label: t('set.font.medium') },
              { value: 'large', label: t('set.font.large') },
            ], (event) => setDraft({ ...draft, chatFontSize: event.target.value })),
            selectRow(t('set.sendkey'), draft.sendKey, [
              { value: 'enter', label: t('set.send.enter') },
              { value: 'ctrl-enter', label: t('set.send.ctrl') },
            ], (event) => setDraft({ ...draft, sendKey: event.target.value })),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.sections')),
              h('div', { className: 'set-checks' }, Object.keys(LOCAL_SETTINGS_FALLBACK.sections).map((key) => h('label', {
                className: 'set-check',
                key,
              }, h('input', {
                type: 'checkbox',
                checked: draft.sections[key] !== false,
                onChange: (event) => setDraft({ ...draft, sections: { ...draft.sections, [key]: event.target.checked } }),
              }), t(`set.section.${key}`))))),
            h('div', { className: 'set-actions' },
              h('button', { type: 'button', className: 'wp-btn wp-btn-primary', onClick: saveLocal, disabled: saving || loading },
                saving ? t('set.saving') : t('set.save')))),
          // ── 情境观察 ──
          h('div', { className: 'set-group' },
            h('div', { className: 'set-group-title' }, t('set.group.observer')),
            h('div', { className: 'set-row' },
              h('span', { className: 'wp-status', 'data-state': observer && observer.running ? (observer.paused ? 'warn' : 'ok') : 'error' },
                h('span', { className: 'wp-dot' }),
                observer && observer.paused ? t('cc.paused') : (observer && observer.running ? t('cc.running') : t('cc.notRunning'))),
              observer && observer.pid ? h('span', { className: 'wp-chip' }, `pid ${observer.pid}`) : null,
              observer ? h('span', { className: 'wp-chip' }, `${t('cc.comp.lastHeartbeat')} ${relativeTime(observer.lastHeartbeatAt)}`) : null,
              h('button', { type: 'button', className: 'wp-btn', onClick: togglePause },
                observer && observer.paused ? t('cc.resume') : t('cc.pause'))),
            h('div', { className: 'set-note' }, t('set.observerHint'))),
          // ── 服务器 QQ 预览 ──
          h('div', { className: 'set-group' },
            h('div', { className: 'set-group-title' }, t('set.group.qq')),
            awarenessOk ? null : h('div', { className: 'set-note set-note-warn' },
              t('set.qq.pending') + (awareness && awareness.error ? awareness.error : '—')),
            awarenessOk ? null : h('div', { className: 'set-note set-note-warn' }, t('set.sshDisabledHint')),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.qq.groupEnabled')),
              h('label', { className: 'set-check' }, h('input', {
                type: 'checkbox',
                checked: qqDraft.qqPreviewGroup,
                onChange: (event) => setQqDraft({ ...qqDraft, qqPreviewGroup: event.target.checked }),
              }), t('set.qq.groupEnabled'))),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.qq.groups')),
              h('input', {
                className: 'set-input',
                value: qqDraft.groupsText,
                placeholder: 'group:<id>',
                onChange: (event) => setQqDraft({ ...qqDraft, groupsText: event.target.value }),
              })),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.qq.chats')),
              h('input', {
                className: 'set-input',
                value: qqDraft.chatsText,
                placeholder: 'private:<id>',
                onChange: (event) => setQqDraft({ ...qqDraft, chatsText: event.target.value }),
              })),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.qq.maxItems')),
              h('input', {
                className: 'set-input',
                type: 'number',
                min: 1,
                max: 10,
                value: qqDraft.qqPreviewMaxItems,
                onChange: (event) => setQqDraft({ ...qqDraft, qqPreviewMaxItems: Number(event.target.value) }),
              }),
              h('span', { className: 'set-row-label' }, t('set.qq.maxChars')),
              h('input', {
                className: 'set-input',
                type: 'number',
                min: 20,
                max: 200,
                value: qqDraft.qqPreviewMaxChars,
                onChange: (event) => setQqDraft({ ...qqDraft, qqPreviewMaxChars: Number(event.target.value) }),
              })),
            applyInfo && applyInfo.restart
              ? h('div', { className: 'set-note' }, `${t('set.qq.applied')}：active=${applyInfo.restart.active ?? '?'}，${Math.round(Number(applyInfo.restart.ms) || 0)}ms`)
              : null,
            confirmApply
              ? h('div', { className: 'set-note set-note-warn' }, t('set.qq.confirm'))
              : null,
            h('div', { className: 'set-actions' },
              h('button', { type: 'button', className: 'wp-btn wp-btn-primary', onClick: applyAwareness, disabled: applying || !awarenessOk },
                applying ? t('set.qq.applying') : (confirmApply ? t('set.qq.confirmApply') : t('set.qq.apply'))),
              confirmApply
                ? h('button', { type: 'button', className: 'wp-btn', onClick: () => setConfirmApply(false), disabled: applying }, t('set.qq.cancel'))
                : null)),
          // ── 桌宠 DIY（T23）──
          h('div', { className: 'set-group', 'data-pet-diy': '1' },
            h('div', { className: 'set-group-title' }, t('set.group.pet')),
            petError !== '' ? h('div', { className: 'set-note set-note-warn' }, petError) : null,
            h('div', { className: 'set-row', 'data-pet-import-row': '1' },
              h('button', {
                type: 'button',
                className: 'wp-btn',
                'data-pet-import': '1',
                disabled: importing || petDiy === null,
                onClick: () => { if (fileInputRef.current) fileInputRef.current.click(); },
              }, importing ? t('set.pet.importing') : t('set.pet.import')),
              h('input', {
                ref: fileInputRef,
                type: 'file',
                accept: '.zip,application/zip',
                style: { display: 'none' },
                onChange: onPackFileChosen,
              }),
              h('span', { className: 'set-note' }, t('set.pet.importHint'))),
            petDiy === null || petDraft === null
              ? h('div', { className: 'set-note' }, loading ? t('set.loading') : t('set.pet.currentFallback'))
              : [
                h('div', { className: 'set-row', key: 'pet-summary' },
                  h('span', { className: 'wp-chip', 'data-pet-summary': '1' },
                    `${t('set.pet.summary')}：${petDiySummary(petDiy, petDraft)}`),
                  h('button', { type: 'button', className: 'wp-btn', onClick: refreshPetPacks }, t('set.pet.refreshPacks'))),
                h('div', { className: 'set-note', key: 'pet-import-hint' }, t('set.pet.importHint')),
                importConflict !== null
                  ? h('div', { className: 'set-note set-note-warn', key: 'pet-import-conflict' },
                    h('div', {}, t('set.pet.importConflict').replace('{id}', importConflict.id || '?')),
                    h('div', { className: 'set-actions' },
                      h('button', {
                        type: 'button',
                        className: 'wp-btn wp-btn-primary',
                        disabled: importing,
                        onClick: () => { if (importConflict) handlePackFile(importConflict.file, { replace: true }); },
                      }, t('set.pet.importReplace')),
                      h('button', {
                        type: 'button',
                        className: 'wp-btn',
                        disabled: importing,
                        onClick: () => setImportConflict(null),
                      }, t('set.pet.importCancel'))))
                  : null,
                h('div', { className: 'set-row', key: 'pet-pack' },
                  h('span', { className: 'set-row-label' }, t('set.pet.pack')),
                  h('select', {
                    className: 'set-select',
                    value: petDraft.skin.figure,
                    onChange: (event) => selectPetPack(event.target.value),
                  }, (petDiy.packs ?? []).map((pack) => h('option', { key: pack.id, value: pack.id }, pack.name || pack.id)))),
                (() => {
                  const pack = findPetPack(petDiy.packs, petDraft.skin.figure);
                  return (pack && Array.isArray(pack.presets) && pack.presets.length > 0)
                    ? h('div', { className: 'set-row', key: 'pet-presets' },
                      h('span', { className: 'set-row-label' }, t('set.pet.presets')),
                      h('div', { className: 'set-actions' }, pack.presets.map((preset) => h('button', {
                        key: preset.id,
                        type: 'button',
                        className: 'wp-btn',
                        onClick: () => setPetDraft(applyPetPreset(petDraft, pack, preset)),
                      }, preset.name || preset.id))))
                    : null;
                })(),
                ...(findPetPack(petDiy.packs, petDraft.skin.figure)?.axes ?? []).map((axis) => h('div', {
                  className: 'set-row',
                  key: `pet-axis-${axis.id}`,
                },
                h('span', { className: 'set-row-label' }, axis.name || axis.id),
                h('select', {
                  className: 'set-select',
                  value: petAxisValue(petDraft.skin, axis.id) ?? '',
                  onChange: (event) => setPetDraft(setPetSkinAxis(petDraft, axis.id, event.target.value)),
                }, (axis.options ?? []).map((option) => h('option', { key: option.id, value: option.id }, option.name || option.id))))),
                petNumberRow(t('set.pet.scale'), 'scale', 0.5, 3, 0.05),
                petNumberRow(t('set.pet.bubbleSize'), 'bubbleSize', 0.5, 2, 0.05),
                petNumberRow(t('set.pet.fontSize'), 'fontSize', 0.5, 2, 0.05),
                petNumberRow(t('set.pet.bubbleSpeed'), 'bubbleSpeed', 0.5, 2, 0.05),
                petNumberRow(t('set.pet.glow'), 'glow', 0, 14, 1),
                h('div', { className: 'set-row', key: 'pet-theme-roam' },
                  h('span', { className: 'set-row-label' }, t('set.pet.theme')),
                  h('select', {
                    className: 'set-select',
                    value: petDraft.theme,
                    onChange: (event) => setPetDraft({ ...petDraft, theme: event.target.value }),
                  },
                  h('option', { value: 'light' }, t('set.pet.theme.light')),
                  h('option', { value: 'dark' }, t('set.pet.theme.dark'))),
                  h('span', { className: 'set-row-label' }, t('set.pet.roam')),
                  h('select', {
                    className: 'set-select',
                    value: petDraft.roam,
                    onChange: (event) => setPetDraft({ ...petDraft, roam: event.target.value }),
                  },
                  h('option', { value: 'free' }, t('set.pet.roam.free')),
                  h('option', { value: 'calm' }, t('set.pet.roam.calm')),
                  h('option', { value: 'off' }, t('set.pet.roam.off')))),
                h('div', { className: 'set-row', key: 'pet-bools' },
                  h('div', { className: 'set-checks' },
                    h('label', { className: 'set-check' }, h('input', {
                      type: 'checkbox',
                      checked: petDraft.sound,
                      onChange: (event) => setPetDraft({ ...petDraft, sound: event.target.checked }),
                    }), t('set.pet.sound')),
                    h('label', { className: 'set-check' }, h('input', {
                      type: 'checkbox',
                      checked: petDraft.doubleClickChat,
                      onChange: (event) => setPetDraft({ ...petDraft, doubleClickChat: event.target.checked }),
                    }), t('set.pet.doubleClick')),
                    h('label', { className: 'set-check' }, h('input', {
                      type: 'checkbox',
                      checked: petDraft.lockFrameRate,
                      onChange: (event) => setPetDraft({ ...petDraft, lockFrameRate: event.target.checked }),
                    }), t('set.pet.lockFrameRate')))),
                h('div', { className: 'set-row', key: 'pet-frameRate' },
                  h('span', { className: 'set-row-label' }, t('set.pet.frameRate')),
                  h('input', {
                    className: 'set-input',
                    type: 'number',
                    min: 0,
                    max: 60,
                    value: petDraft.frameRate,
                    onChange: (event) => setPetDraft({ ...petDraft, frameRate: Number(event.target.value) }),
                  })),
                h('div', { className: 'set-row', key: 'pet-hover' },
                  h('span', { className: 'set-row-label' }, t('set.pet.hoverButtons')),
                  h('div', { className: 'set-checks' }, PET_HOVER_BUTTON_IDS.map((actionId) => h('label', { className: 'set-check', key: actionId },
                    h('input', {
                      type: 'checkbox',
                      checked: Array.isArray(petDraft.hoverButtons) && petDraft.hoverButtons.includes(actionId),
                      onChange: (event) => {
                        const set = new Set(Array.isArray(petDraft.hoverButtons) ? petDraft.hoverButtons : []);
                        if (event.target.checked) set.add(actionId); else set.delete(actionId);
                        setPetDraft({ ...petDraft, hoverButtons: [...set] });
                      },
                    }), actionId)))),
                h('div', { className: 'set-note' }, t('set.pet.requiresT22')),
                h('div', { className: 'set-actions' },
                  h('button', { type: 'button', className: 'wp-btn wp-btn-primary', onClick: savePet, disabled: petSaving },
                    petSaving ? t('set.pet.saving') : t('set.pet.save'))),
              ]),
          // ── 路径 ──
          h('div', { className: 'set-group' },
            h('div', { className: 'set-group-title' }, t('set.group.paths')),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, 'dshLinkRoot'),
              h('span', { className: 'set-mono' }, detail && detail.dshLinkRoot ? detail.dshLinkRoot : t('set.unknown')),
              h('button', { type: 'button', className: 'wp-btn', onClick: openDirectory }, t('set.openDir'))),
            h('div', { className: 'set-row' },
              h('span', { className: 'set-row-label' }, t('set.settingsFile')),
              h('span', { className: 'set-mono' }, detail && detail.settingsFile ? detail.settingsFile : '—')),
            h('div', { className: 'set-note' }, t('set.reloadHint')))));
    }

    /**
     * 合并版「鲸歌」整页外壳（T21）：顶部 Tab 聊天 / 总控台 / 设置。
     * 保留单个 sidebar 入口（id=whale-chat）。
     */
    function WhalePanelShell(props) {
      const t = props && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const ui = uiState;
      const tt = localizeWithUi(t, ui);
      const panelTitle = (typeof ui.panelTitle === 'string' && ui.panelTitle !== '')
        ? ui.panelTitle
        : (ui.sidebarLabel || t('title'));
      const [tab, setTab] = useState(readStoredTab);
      const [settings, setSettings] = useState(LOCAL_SETTINGS_FALLBACK);
      const aliveRef = useRef(false);
      const tRef = useRef(t);
      tRef.current = t;

      const loadSettings = useCallback(async () => {
        const result = await fetchJson(api('settings'), { timeoutMs: 25_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data && result.data.ok === true) {
          setSettings(normalizeLocalSettings(result.data.settings));
        }
      }, []);

      useEffect(() => {
        aliveRef.current = true;
        loadSettings();
        return () => { aliveRef.current = false; };
      }, [loadSettings]);

      useEffect(() => {
        storeTab(tab);
      }, [tab]);

      const switchTab = (next) => {
        if (TAB_IDS.includes(next)) setTab(next);
      };

      const tabLabels = { chat: 'tab.chat', control: 'tab.control', settings: 'tab.settings', market: 'tab.market' };
      const tabText = (id) => (ui.tabLabels && typeof ui.tabLabels[id] === 'string' && ui.tabLabels[id] !== ''
        ? ui.tabLabels[id]
        : t(tabLabels[id]));
      return h('div', { className: 'wp-shell', 'data-whale-panel': PANEL_ID },
        h('style', { dangerouslySetInnerHTML: { __html: `${STYLE_CSS}\n${CONTROL_STYLE_CSS}\n${SHELL_STYLE_CSS}` } }),
        h('div', { className: 'wp-shell-tabs', role: 'tablist' },
          TAB_IDS.map((id) => h('button', {
            key: id,
            type: 'button',
            role: 'tab',
            className: 'wp-tab',
            'data-active': tab === id ? 'true' : 'false',
            'aria-selected': tab === id ? 'true' : 'false',
            onClick: () => switchTab(id),
          }, tabText(id)))),
        h('div', { className: 'wp-shell-body' },
          tab === 'chat'
            ? h(WhalePanel, { t: tt, settings, title: panelTitle })
            : tab === 'control'
              ? h(ControlCenterPanel, { t: tt, settings, active: true, switchTab })
              : tab === 'settings'
                ? h(SettingsPanel, { t: tt, settings, switchTab, onSettingsSaved: (next) => setSettings(normalizeLocalSettings(next)) })
                : h(CooMarketPanel, { t: tt })));
    }

    /**
     * 整页「鲸歌」聊天面板。
     * @param {{ t?: (key: string) => string }} props `main` slot 注册时经 inject 传入的 t
     */
    function WhalePanel(props) {
      const t = props && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const settings = props && props.settings ? normalizeLocalSettings(props.settings) : LOCAL_SETTINGS_FALLBACK;
      const sendKey = settings.sendKey;
      const [messages, setMessages] = useState([]);
      const [connection, setConnection] = useState({ state: 'connecting', sessionExists: true });
      const [realtime, setRealtime] = useState('connecting');
      const [historyState, setHistoryState] = useState({ state: 'loading', code: '', count: 0, hasMore: false });
      const [sending, setSending] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [draft, setDraft] = useState('');
      const [sessionId, setSessionId] = useState('');
      const [moodLabel, setMoodLabel] = useState('');

      const aliveRef = useRef(false);
      const tRef = useRef(t);
      tRef.current = t;
      const wsRef = useRef(null);
      const wsStateRef = useRef('idle');
      const attemptRef = useRef(0);
      const reconnectTimerRef = useRef(null);
      const connectRef = useRef(null);
      const seqRef = useRef(0);
      const scrollRef = useRef(null);

      /** 合并消息（按 id 去重、排序、清理乐观消息）。 */
      const merge = useCallback((incoming) => {
        setMessages((previous) => mergeMessages(previous, incoming));
      }, []);

      /** 载入历史；silent 表示轮询兜底（失败时不覆盖已成功状态）。 */
      const loadHistory = useCallback(async (options) => {
        const silent = !!(options && options.silent);
        const result = await fetchJson(api(`history?limit=${HISTORY_LIMIT}`), { timeoutMs: 15_000 });
        if (!aliveRef.current) return null;
        if (result.ok && result.data && Array.isArray(result.data.messages)) {
          merge(result.data.messages);
          setHistoryState({
            state: 'ok',
            code: '',
            count: result.data.messages.length,
            hasMore: result.data.hasMore === true,
          });
          if (!silent) setError('');
          return result.data;
        }
        const code = errorCode(result);
        setHistoryState((previous) => (silent && previous.state === 'ok'
          ? previous
          : { state: 'error', code, count: 0, hasMore: false }));
        return null;
      }, [merge]);

      /** 轮询 bridge /health（连接状态 + busy + 心情）。 */
      const checkHealth = useCallback(async () => {
        const result = await fetchJson(api('health'), { timeoutMs: 6_000 });
        if (!aliveRef.current) return;
        if (result.ok && result.data) {
          const server = result.data.server && typeof result.data.server === 'object' ? result.data.server : {};
          const up = server.up === true;
          setConnection({
            state: up ? 'ok' : 'warn',
            sessionExists: server.sessionExists !== false,
            detail: typeof result.data.lastError === 'string' ? result.data.lastError : '',
          });
          setBusy(result.data.busy === true);
          if (typeof server.sessionId === 'string' && server.sessionId !== '') setSessionId(server.sessionId);
          const mood = result.data.mood;
          setMoodLabel(mood && typeof mood.label === 'string' ? mood.label : '');
        } else {
          setConnection({ state: 'down', sessionExists: true, detail: '' });
          setBusy(false);
          setMoodLabel('');
        }
      }, []);

      /** WS 断开后的指数退避重连（用 ref 调 connect，避免循环依赖）。 */
      const scheduleReconnect = useCallback(() => {
        if (!aliveRef.current) return;
        if (reconnectTimerRef.current !== null) return;
        if (wsRef.current !== null) return;
        wsStateRef.current = 'polling';
        setRealtime('polling');
        const attempt = attemptRef.current;
        attemptRef.current = attempt + 1;
        const delay = backoffDelay(attempt);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (aliveRef.current && typeof connectRef.current === 'function') connectRef.current();
        }, delay);
      }, []);

      /** 建立 WS /events 连接（先向 Host 半要 config：eventsUrl + token）。 */
      const connect = useCallback(async () => {
        if (!aliveRef.current) return;
        if (wsRef.current !== null) return;
        setRealtime((previous) => (previous === 'live' ? previous : 'connecting'));
        const result = await fetchJson(api('config'), { timeoutMs: 8_000 });
        if (!aliveRef.current) return;
        if (!result.ok || !result.data || typeof result.data.eventsUrl !== 'string') {
          scheduleReconnect();
          return;
        }
        const url = buildEventsUrl(result.data.eventsUrl, result.data.token);
        if (url === null) {
          setRealtime('polling');
          scheduleReconnect();
          return;
        }
        let socket;
        try {
          socket = new WebSocket(url);
        } catch {
          scheduleReconnect();
          return;
        }
        wsRef.current = socket;
        socket.onopen = () => {
          if (!aliveRef.current) {
            try { socket.close(); } catch { /* ignore */ }
            return;
          }
          attemptRef.current = 0;
          wsStateRef.current = 'live';
          setRealtime('live');
          loadHistory({ silent: true });
        };
        socket.onmessage = (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!payload || typeof payload !== 'object') return;
          if (payload.type === 'snapshot' && Array.isArray(payload.messages)) {
            merge(payload.messages);
            if (typeof payload.sessionId === 'string' && payload.sessionId !== '') setSessionId(payload.sessionId);
            return;
          }
          if (payload.type === 'message' && payload.message) {
            merge([payload.message]);
            return;
          }
          if (payload.type === 'status' && typeof payload.running === 'boolean') {
            setBusy(payload.running);
          }
        };
        socket.onerror = () => { /* onclose 负责重连 */ };
        socket.onclose = () => {
          if (wsRef.current === socket) wsRef.current = null;
          if (!aliveRef.current) return;
          wsStateRef.current = 'polling';
          setRealtime('polling');
          scheduleReconnect();
        };
      }, [loadHistory, merge, scheduleReconnect]);
      connectRef.current = connect;

      /** 挂载：拉历史 + 健康检查 + 连 WS，并起两个 5s 定时器。 */
      useEffect(() => {
        aliveRef.current = true;
        loadHistory();
        checkHealth();
        connect();
        const healthTimer = setInterval(() => { checkHealth(); }, HEALTH_INTERVAL_MS);
        const pollTimer = setInterval(() => {
          if (wsStateRef.current !== 'live') loadHistory({ silent: true });
        }, POLL_INTERVAL_MS);
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          checkHealth();
          if (wsStateRef.current !== 'live') connectRef.current();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          aliveRef.current = false;
          clearInterval(healthTimer);
          clearInterval(pollTimer);
          document.removeEventListener('visibilitychange', onVisible);
          if (reconnectTimerRef.current !== null) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          const socket = wsRef.current;
          wsRef.current = null;
          wsStateRef.current = 'idle';
          if (socket !== null) {
            try { socket.close(); } catch { /* ignore */ }
          }
        };
      }, [checkHealth, connect, loadHistory]);

      /** 新消息/发送状态变化时滚到底。 */
      useEffect(() => {
        const element = scrollRef.current;
        if (element !== null) element.scrollTop = element.scrollHeight;
      }, [messages, sending, busy]);

      /** 刷新：重拉历史与健康；WS 不在线则立即重连。 */
      const refresh = async () => {
        setError('');
        if (reconnectTimerRef.current !== null) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        attemptRef.current = 0;
        const jobs = [checkHealth(), loadHistory()];
        if (wsStateRef.current !== 'live') jobs.push(connectRef.current());
        await Promise.all(jobs);
      };

      /** 发送：本地乐观 user 气泡 + 阻塞 /say，结束后用 /history 对齐权威消息。 */
      const send = async () => {
        const text = draft.trim();
        if (text === '' || sending) return;
        seqRef.current += 1;
        const optimistic = {
          id: `local-u-${seqRef.current}`,
          role: 'user',
          text,
          at: Date.now(),
          local: true,
        };
        setDraft('');
        setError('');
        setSending(true);
        setMessages((previous) => mergeMessages(previous, [optimistic]));
        try {
          const result = await fetchJson(api('say'), {
            method: 'POST',
            body: { text },
            timeoutMs: SEND_TIMEOUT_MS,
          });
          if (!aliveRef.current) return;
          if (!result.ok) {
            setError(readableReason(result, tRef.current));
            return;
          }
          const replied = result.data && typeof result.data.text === 'string' ? result.data.text : '';
          const history = await loadHistory({ silent: true });
          if (!aliveRef.current) return;
          if (history === null && replied.trim() !== '') {
            seqRef.current += 1;
            setMessages((previous) => mergeMessages(previous, [{
              id: `local-a-${seqRef.current}`,
              role: 'assistant',
              text: replied,
              at: Date.now(),
              local: true,
            }]));
          }
        } catch (failure) {
          if (aliveRef.current) setError(readableReason({ error: { code: 'network', message: String(failure) } }, tRef.current));
        } finally {
          if (aliveRef.current) setSending(false);
        }
      };

      const onDraftChange = (event) => {
        setDraft(event.target.value);
        const element = event.target;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
      };

      const onInputKeyDown = (event) => {
        if (event.nativeEvent && event.nativeEvent.isComposing) return;
        if (sendKey === 'ctrl-enter') {
          if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          send();
          return;
        }
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        send();
      };

      const status = (() => {
        if (connection.state === 'ok' && connection.sessionExists === false) {
          return { state: 'warn', text: t('status.sessionMissing') };
        }
        if (connection.state === 'ok') return { state: 'ok', text: t('status.connected') };
        if (connection.state === 'warn') return { state: 'warn', text: t('status.serverOffline') };
        if (connection.state === 'down') return { state: 'error', text: t('status.bridgeOffline') };
        return { state: 'idle', text: t('status.connecting') };
      })();
      const historyWarning = (() => {
        if (historyState.state !== 'error') return '';
        if (historyState.code === 'not-found' || historyState.code === 'http-404' || historyState.code === 'bad-bridge-response') {
          return t('history.missing');
        }
        return t('history.failed');
      })();
      const thinking = sending || busy;

      return h('div', { className: `wp-root wp-chat-size-${settings.chatFontSize}`, 'data-whale-panel': PANEL_ID },
        h('style', { dangerouslySetInnerHTML: { __html: STYLE_CSS } }),
        h('header', { className: 'wp-header' },
          h('div', { className: 'wp-heading' },
            h('div', { className: 'wp-title' }, (props && typeof props.title === 'string' && props.title !== '') ? props.title : t('title')),
            h('div', { className: 'wp-sub' },
              sessionId !== '' ? h('span', { className: 'wp-chip' }, sessionId) : null,
              h('span', { className: 'wp-status', 'data-state': status.state },
                h('span', { className: 'wp-dot' }),
                status.text),
              h('span', { className: 'wp-chip' }, realtime === 'live' ? t('live') : t('polling')),
              moodLabel !== '' ? h('span', { className: 'wp-chip' }, `${t('mood')} ${moodLabel}`) : null,
            )),
          h('div', { className: 'wp-actions' },
            h('button', { type: 'button', className: 'wp-btn', onClick: refresh }, t('refresh')))),
        error !== '' || historyWarning !== ''
          ? h('div', { className: 'wp-banners' },
            error !== '' ? h('div', { className: 'wp-banner wp-banner-error' }, error) : null,
            historyWarning !== '' ? h('div', { className: 'wp-banner wp-banner-warn' }, historyWarning) : null)
          : null,
        h('div', { className: 'wp-scroll', ref: scrollRef },
          messages.length === 0
            ? h('div', { className: 'wp-empty' },
              historyState.state === 'loading' ? t('loading') : t('empty'))
            : messages.map((message) => {
              const isUser = message.role === 'user';
              const clock = formatClock(message.at);
              return h('div', {
                className: `wp-row ${isUser ? 'wp-row-user' : 'wp-row-assistant'}`,
                key: message.id,
              },
              h('div', { className: 'wp-message' },
                h('div', { className: 'wp-meta' },
                  isUser ? t('role.user') : t('role.assistant'),
                  clock !== '' ? ` · ${clock}` : ''),
                h('div', { className: 'wp-bubble' }, message.text === '' ? '…' : message.text)));
            }),
          thinking
            ? h('div', { className: 'wp-typing' },
              h('span', null, t('sending')),
              h('span', { className: 'wp-typing-dot' }),
              h('span', { className: 'wp-typing-dot' }),
              h('span', { className: 'wp-typing-dot' }))
            : null),
        h('div', { className: 'wp-composer' },
          h('textarea', {
            className: 'wp-input',
            rows: 2,
            value: draft,
            placeholder: t('placeholder'),
            disabled: sending,
            onChange: onDraftChange,
            onKeyDown: onInputKeyDown,
            'aria-label': t('placeholder'),
          }),
          h('button', {
            type: 'button',
            className: 'wp-btn wp-btn-primary',
            disabled: sending || draft.trim() === '',
            onClick: send,
          }, sending ? t('sending') : t('send'))));
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = fallbackTranslate;
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'whale-panel: dictionaries');
          t = ctx.locale.bind(NS);
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[whale-panel] locale 服务不可用，使用内置中文文案', error);
        }
        // T21/T26：只保留一个侧栏入口；label 用配置（sidebarLabel），没配置回退 locale。
        let sidebarDisposer = null;
        const registerSidebar = () => {
          try { if (typeof sidebarDisposer === 'function') sidebarDisposer(); } catch { /* ignore */ }
          sidebarDisposer = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => uiState.sidebarLabel || t('title.short'),
            locale: NS,
          }, WhaleIcon);
        };
        ctx.slots.inject('sidebar.panellist', () => {
          registerSidebar();
          return () => {
            try { if (typeof sidebarDisposer === 'function') sidebarDisposer(); } catch { /* ignore */ }
            sidebarDisposer = null;
          };
        });
        // 读 Host /config 拿 ui 名称/Tab 文案；拿到后重注册 label（刷新页面后也生效）
        try {
          ctx.effect(() => {
            let alive = true;
            fetchJson(api('config'), { timeoutMs: 8_000 }).then((result) => {
              if (!alive) return;
              if (result.ok && result.data && result.data.ok === true && result.data.ui && typeof result.data.ui === 'object') {
                Object.assign(uiState, result.data.ui);
                registerSidebar();
              }
            }).catch(() => { /* ignore */ });
            return () => { alive = false; };
          }, 'whale-panel: ui config');
        } catch { /* ignore */ }
        // 整页面板（root scope keyed，key 必须与侧栏 id 一致）。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, WhalePanelShell));
      },
      /** 离线测试用（宿主忽略未知字段）。 */
      __test: {
        PANEL_ID,
        PANEL_ORDER,
        TAB_IDS,
        TAB_STORAGE_KEY,
        uiState,
        localizeWithUi,
        LOCAL_SETTINGS_FALLBACK,
        readStoredTab,
        storeTab,
        normalizeLocalSettings,
        parseIdList,
        joinIdList,
        collectAwarenessBody,
        COO_MARKET_CACHE_MS,
        COO_MARKET_KINDS,
        filterCooMarketItems,
        sortCooMarketItems,
        formatDownloads,
        marketKindLabel,
        marketLinks,
        CooMarketRow,
        CooMarketPanel,
        PET_FIXED_SKIN_FIELDS,
        PET_HOVER_BUTTON_IDS,
        findPetPack,
        petAxisValue,
        petSkinForFigure,
        setPetSkinAxis,
        applyPetPreset,
        petDraftFromData,
        collectPetDiyBody,
        petDiySummary,
        PET_IMPORT_MAX_BYTES,
        buildImportPackUrl,
        summarizeImportPackResult,
        uploadPetPack,
        WhalePanelShell,
        SettingsPanel,
        SHELL_STYLE_CSS,
        CONTROL_PANEL_ID,
        CONTROL_PANEL_ORDER,
        CONTROL_API_ROOT,
        CONTROL_REFRESH_MS,
        NS,
        zh,
        en,
        formatUptime,
        relativeTime,
        formatNumber,
        sortContextEvents,
        surfaceLabel,
        buildControlCards,
        buildCooPluginRows,
        cooPluginKindLabel,
        buildComponentRows,
        dashboardChip,
        ControlCenterIcon,
        ControlCenterPanel,
        CONTROL_STYLE_CSS,
        mergeMessages,
        normalizeMessage,
        sortMessages,
        backoffDelay,
        formatClock,
        buildEventsUrl,
        errorCode,
        readableReason,
        STYLE_CSS,
        WhaleIcon,
        WhalePanel,
      },
    };
  },
});
