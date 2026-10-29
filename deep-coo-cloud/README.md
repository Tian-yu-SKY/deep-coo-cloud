# 鲸歌面板（`@local/dsh-whale-panel`）

本机 DSH Web UI 里的「鲸歌」聊天面板：侧栏多一个**鲸歌**图标，点开是一整页聊天，
实时显示并续聊**服务器 DSH** 上的 `pet-local` 会话（同一个「鲸歌」人格，和 Coo 桌宠/QQ 共用会话与记忆）。
数据全部经本机 bridge（`http://127.0.0.1:47891`）转发，协议见 `dsh-link/PANEL-PROTOCOL.md`。

**T21 起合并为一个侧栏入口「鲸歌」**：整页面板内部用顶部 Tab 切换 **聊天 / 总控台 / 设置 / Coo 市场**（T24 新增第 4 个）
（Tab 记忆在 localStorage），并开放更多自定义项（刷新间隔 / 区块开关 / 字号 / 发送键 / 情境观察 /
服务器 QQ 预览配置 / 桌宠 DIY / 路径）。原「鲸歌」聊天行为不变；独立「总控台」入口已删除（详见 §1.1）。
T24 加「Coo 市场」Tab：浏览 npm 上的 Coo/Coopanion 扩展（Cortico 市场）；T25 起可**一键下载到本机** `coo-extensions/`，
并可在二次确认后 best-effort 安装进 Coopanion（第三方代码警告 + 需重启 Coopanion）。本插件始终**不执行**扩展代码（详见 §1.3）。

- Host 半：`index.js` —— 在 DSH Web 服务器注册同源路由 `/whale-panel/*`（聊天/设置/服务器 QQ 配置）与 `/control-center/*`（状态聚合/PAUSED，Tab 内复用），代理 bridge HTTP、转发 bridge token、按需 ssh 读写服务器 awareness patch。
- Client 半：`client.js` —— 注册**一个** `sidebar.panellist`（id=`whale-chat`、label=「鲸歌」、order=5）与一个 `main` keyed 整页 Tab 外壳。
- 无构建步骤（纯 ESM/CJS 工厂 bundle）；样式只用 DSH 主题 token（`--dsw-alias-*`），跟随明暗主题。
- 版本：`2.5.0`（T37 自动看屏幕开关/状态，配合 T36 桌宠插件；包名 `deep-coo-cloud`）；离线测试 **151 项**（host / client / manifest / control-center / settings / pet-diy / pet-diy-import / coo-market / coo-market-download / coo-plugins / pet-plugins / vision 十二组）。
- **可分发**：默认配置不含任何本机/服务器私有信息（IP/域名/QQ 号/路径/SSH key/token）；侧栏名称、面板标题、Tab 文案、桥接地址、服务器 SSH、QQ 白名单均可在「设置 → 通用/连接」里配置（保存到 `whale-panel/settings.json`）。
- 「设置 → 桌宠 DIY」依赖 coo-fork 桌宠插件 **`dsh-coo-pet-remote@0.4.0-remote.1`**（T22）：写 `coo-pet-data/pet-settings.json` 后插件 ~1s 热应用；该插件 config 未覆盖 settingsFile，默认路径与本插件默认一致。

---

## 1. 功能

| 能力 | 说明 |
| --- | --- |
| 侧栏入口 | 「鲸歌」图标（小鲸鱼 + 音符），在官方 Plugins 与定时任务之间（order=5） |
| 整页面板 | 标题「鲸歌 · 服务器人格」、连接状态点、实时/轮询标记、心情 chip、刷新按钮 |
| 历史消息 | 打开时 `GET /history?limit=200` 载入（user 右 / assistant 左气泡，时间 HH:MM） |
| 实时增量 | 浏览器直连 bridge `WS /events`：`snapshot` / `message` / `status` / `ping`（心跳忽略） |
| 发送 | 多行输入（Enter 发送、Shift+Enter 换行）；发送中禁用并显示「正在想…」；`POST /say` 阻塞到轮结束 |
| 断线恢复 | WS 指数退避重连（1s→2s→4s→8s→15s，±20% 抖动）；断线期间自动用 `/history` 5s 轮询兜底 |
| 错误提示 | bridge 未连 / 超时 / busy / 红线会话 / 历史接口未就绪等都有中文可读提示 |
| 状态轮询 | `GET /health` 每 5s：bridge↔服务器状态、`busy`、`mood.label`、`sessionId` |

### 1.1 面板内 Tab（T21 合并版）

| Tab | 内容 |
| --- | --- |
| **聊天**（默认） | 原「鲸歌 · 服务器人格」页：历史/实时消息、输入框、连接状态、心情 chip；发送键与气泡字号跟随设置 |
| **总控台** | 原独立总控台全部内容：状态卡片 ×5（bridge/服务器/QQ桥/桌宠/心情）、情境流（5 条）、QQ 近况（4 行）、组件状态（observer/sync/mirror + 四个 Startup vbs）、操作（刷新 / 暂停恢复情境观察 / 复制诊断 / 切到设置）、**本机桌宠插件**（前台感知/跨端接话/桌宠 DIY/看屏幕状态）、折叠的 Coopanion 扩展管理；**只在激活时每 N 秒刷新**（N 来自设置的刷新间隔，默认 10s） |
| **设置** | 见下方清单；本地设置即时保存到 `whale-panel/settings.json`，服务器 QQ 配置应用会重启服务器 dsh-web（约 10s） |
| **Coo 市场**（T24/T25） | 浏览 npm 上 Coo/Coopanion 的 Cortico 扩展（缓存 10min）：搜索/类型筛选/排序/月下载/已安装/已下载状态、详情展开；**一键下载到本机** `coo-extensions/`，可选「安装到 Coopanion（高级，二次确认 + 需重启）」；始终不执行扩展代码 |

Tab 状态记忆在 `localStorage`（key `whale-panel.tab`）；切走 Tab 会卸载该 Tab 的定时器/WS，切回重新加载，避免后台空转。

### 1.2 设置项清单（T21）

| 分组 | 设置 | 说明 |
| --- | --- | --- |
| 面板 | 刷新间隔 | 5s / 10s / 30s（总控台 Tab 生效） |
| 面板 | 显示区块 | 状态卡片 / 情境流 / QQ近况 / 组件状态 / 操作（勾选隐藏） |
| 面板 | 聊天气泡字号 | 小 / 中 / 大 |
| 面板 | 发送键 | Enter 发送 / Ctrl+Enter 发送（Shift+Enter 与普通换行相应变化） |
| 情境观察 | 暂停/恢复 + 状态 | 写/删 `context-observer/PAUSED`；显示 running/pid/最后心跳 + 隐私边界说明 |
| QQ 预览（服务器） | `qqPreviewGroup` | 是否包含群聊预览（checkbox） |
| QQ 预览（服务器） | `qqPreviewGroups` | 群白名单（`group:数字`，逗号/空格分隔） |
| QQ 预览（服务器） | `qqPreviewChats` | 私聊白名单（`private:数字`） |
| QQ 预览（服务器） | `qqPreviewMaxItems` / `qqPreviewMaxChars` | 最多行数 1–10 / 每行最多字数 20–200 |
| QQ 预览（服务器） | 「应用并重启服务器 DSH（约 10s）」 | **二次确认**后：Host ssh 读 patch → 只改上面 5 个字段 → 原子写回（先备份 `.bak-t21`）→ `systemctl restart dsh-web` → 轮询 active + 回读校验；失败自动回滚并回读提示 |
| 桌宠 DIY | 形象包 | 下拉选择 `coo-pet-data/web/*/figure.json` 扫描出的包（内置 coo / whale，T22 可复制用户包）；切包动态渲染该包的 axes |
| 桌宠 DIY | 外观轴 | 按 figure.json 动态渲染（whale：配色/服装；coo：配色/头顶/耳侧配件/眼镜/颈饰；用户包任意 axes）；有 presets 时显示快捷预设按钮 |
| 桌宠 DIY | 大小/气泡/光晕 | 大小 0.5–3（step 0.05）；气泡大小/字号/气泡速度 0.5–2；光晕 0–14 |
| 桌宠 DIY | 主题/走位/音效/按钮 | 主题 亮/暗；走位 free/calm/off；音效 / 双击聊天 / 锁定帧率开关；悬停按钮勾选（chat/voice/roam/theme/sound/hide/dress/cooChat） |
| 桌宠 DIY | 保存并应用 | POST 写 `coo-pet-data/pet-settings.json`（合并其它字段、原子写、备份 `.bak`），toast「已应用（桌宠 1s 内变化）」；「刷新形象包列表」重新扫描 |
| 桌宠 DIY | **导入形象包（ZIP）**（T30） | 选 zip 上传到 Host → 安全解包（拒绝绝对路径/`..`/盘符/超 5000 条）→ 找 `figure.json`（深度≤3）→ 校验 id `^[a-z0-9][a-z0-9-]{0,31}$` → 安装到 `coo-pet-data/figures/<id>` 与 `web/<id>`；同名 409 → 二次确认 `replace=1`（旧包备份到 `figures/.backup-*`）；成功后刷新列表并选中新包，**不自动保存 pet-settings** |
| 路径 | dshLinkRoot / 本地设置文件 | 显示路径 + 「打开 dsh-link 目录」按钮（Host 侧 explorer，固定路径） |

**只改自己的字段**：服务器 `cordis.patch.yml` 由 T17/T20 共用（awareness bundle），应用时只替换这 5 个 `qqPreview*` 键，**保留注释与其它所有键（如 T20 的 `dialogueEnabled` 等）**——有单测覆盖（见 §4）。

**导入形象包（T30）**：`POST /whale-panel/pet-diy/import-pack` 接收原始 ZIP 字节（`application/zip`，≤128MB/120s），
写临时文件 → 系统 `tar -tf` 校验条目 → `tar -xf` 解包到临时目录 → 深度≤3 找 `figure.json`（多个 → 400）→
校验 id → 复制到 `coo-pet-data/figures/<id>` 与 `web/<id>`（只复制普通文件/目录，**拒绝符号链接**）；
同名已存在且未带 `?replace=1` → **409**；替换会先把旧目录备份到 `figures/.backup-<id>-<ts>/`；失败清理临时目录。
**只落文件、绝不执行 zip 内任何代码**；成功后刷新 `GET /whale-panel/pet-diy` 即可在「形象包」下拉里选中。
本机样例：`<workspace>/sample-coo-pack.zip`（可用来验证导入流程）。

### 1.3 Coo 市场（T24）

- **数据源**：npm registry `https://registry.npmjs.org/-/v1/search?text=cortico&size=250`（本机可访问；GitHub 官方索引本机被封，不需要）。
  Host 侧过滤 `name` 含 cortico 的包（含 `@scope/cortico-world-...` 这类），按月下载降序，内存缓存 **10 分钟**；失败降级：
  有旧缓存 → `ok:false` + `cached:true` + 旧列表；无缓存 → `ok:false` + 空列表（页面显示可读错误，不影响其它 Tab）。
- **kind 推断**：`cortico-world-*`/关键词 `cortico-world` → `world`；`cortico-provider-*` → `provider`；`cortico-bot-*` → `bot`；
  `cortico-panel-*` → `panel`；其余 → `other`。
- **已安装扫描**：`<Coopanion-root>/data/extensions/*/package.json`（可配 `cooExtensionsDir`），列表行显示「已安装 vX」/「未安装」。
- **UI**：搜索（name/description/keywords）、类型筛选（全部/World/Provider/Bot/Panel/其他）、排序（月下载量/最近更新）、
  行详情（publisher/license/更新时间、keywords chips、homepage/repository/npm 外链、复制包名、安装指引）、刷新按钮；
  顶部横幅明确「这些扩展由 Coopanion 安装并运行；本插件只做浏览/指引，不安装、不执行」。
- **安装指引**：在 Coopanion 设置 → 扩展 → 市场搜索同名安装；或在 Coopanion 的数据目录执行
  `corepack pnpm add <pkg>`（由 Cortico Core 加载运行）。**本插件不执行任何扩展代码，也不改 Coopanion 安装目录。**

#### 1.3.1 下载 / 安装（T25）

- **下载到本机**（每行「下载」按钮；Host `POST /whale-panel/coo-market/download`）：
  - 只接受合法 npm 包名（scoped 允许，长度 ≤214，拒绝 `..`）；Host 拉 `registry.npmjs.org/<pkg>` 元数据 →
    下载 tarball（上限 **200MB / 120s**）→ 系统 `tar.exe` 列条目并做**路径穿越/绝对路径校验**（必须全在 `package/` 下）→
    解包到临时目录 → 校验 `package/package.json` → 移动到 **`<workspace>/dsh-link/coo-extensions/<安全包名>/`**
    （`@scope/name` → `scope__name`）→ 写 `_meta.json`（name/version/tarball/integrity/downloadedAt/bytes）。
  - 同版本已下载 → `cached:true` 不重复下载；旧版本会被替换（旧目录 `.old-*` 成功后删除）；失败会清理临时目录。
  - **只下载文件，绝不执行**；下载目录可配 `cooDownloadsDir`，可用「打开下载目录」按钮打开。
  - 回滚：删除 `dsh-link/coo-extensions/<name>/` 即可。
- **安装到 Coopanion（高级）**（详情里按钮；Host `POST /whale-panel/coo-market/install`）：
  - 必须 `confirm:true`（否则 400 + 第三方代码警告）；只允许**已下载**的包名。
  - best-effort 用 Coopanion 自带 pnpm（默认 `<cooRoot>/resources/app/node_modules/pnpm/bin/pnpm.cjs`）
    把 `<name>@<version>` add 进 `cooExtensionsDir`（默认 `<Coopanion-root>/data/extensions`；目录不存在会创建并写最小 package.json）。
  - 返回 `{ok,installed:true,needRestart:true,output}`，明确提示 **需重启 Coopanion 才生效**；失败返回可读错误 + 手动安装提示，不改 Coopanion 安装目录（resources/app）。
  - 回滚：在 Coopanion 设置 → 扩展里卸载，或在 extensions 目录执行 `pnpm remove <pkg>` 后重启 Coopanion。

### 1.4 通用 / 连接（T26，可分发）

设置 Tab 顶部新增「通用 / 连接」区块（保存到 `whale-panel/settings.json`，Host 白名单校验）：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 左侧栏名称 | `鲸歌` | 侧栏入口显示名（`ui.sidebarLabel`） |
| 面板标题 | `鲸歌` | 聊天面板标题（`ui.panelTitle`） |
| 桥接地址 | 空（用 config 默认 `http://127.0.0.1:47891`） | 只允许 http/https + 回环/局域网地址 |
| 服务器 SSH 主机 | 空（禁用 SSH 功能） | `user@host`；空时「应用并重启服务器 DSH」禁用并提示 |
| 服务器 patch 路径 | 空（禁用服务器 QQ 配置读写） | 服务器 awareness patch 绝对路径；**与 SSH 主机都填**才启用 |
| QQ 群/私聊白名单 | 空（不预览任何会话） | `group:<id>` / `private:<id>`，逗号分隔；服务器不可读时作默认值 |
| 工作区根 / 下载目录 | 自动推导 | 只显示（`dshLinkRoot` / `coo-extensions`） |

- 名称/标题/Tab 文案保存后 **刷新页面生效**（Client 启动时从 `GET /whale-panel/config` 读取并重注册侧栏 label）。
- Host 所有路由在每次请求时合并 `config + settings.json` 得到 effective 设置（bridge 地址、SSH 主机、QQ 默认、UI 名称）。
- **隐私**：插件源码/默认配置不含 IP、域名、QQ 号、绝对路径、SSH key、token；`settings.json` 与 `coo-extensions/` 是运行时本机文件，不在分发包内。

### 1.5 总控台「Coo 插件」（T33）

总控台新增「Coo 插件」卡，把「Coo 市场」下载的扩展加入 Coopanion 并运行：

- **数据**：`GET /whale-panel/coo-plugins` → `coo:{running,pids,petHostPids,root,exe,canLaunch}` + `downloaded[]`（`<dshLinkRoot>/coo-extensions`，读 `package.json.cortico.kind`）+ `installed[]`（`<cooRoot>/data/extensions` 与 node_modules）；进程状态缓存 ~3s（避免频繁 PowerShell）。
- **主程序判定**：`Coopanion.exe` 且 CommandLine **不含** `--pet-host`/`--type=` 的进程；pet-host/子进程永不杀。
- **操作**（全部先二次确认，提示「第三方扩展将在 Coopanion 里运行，请自行判断安全」）：
  - 「加入并运行」= `POST .../install {confirm:true}`（pnpm add）→ Coo 未运行则自动 `POST .../run`，Coo 在跑则提示需重启；
  - 已安装：`POST .../run {name}`（未装 → 409 `needInstall`；已运行 → 409 `needRestart`；否则 `spawn(Coopanion.exe, {cwd:cooRoot, detached:true})`）；
  - 「重启并运行」= `POST .../restart {confirm:true}`（只 `taskkill /PID` 主程序，等 ~1.5s 再 spawn；pet-host 不动）；
  - 「卸载」= `POST .../uninstall {confirm:true}`（pnpm remove，需重启 Coo）；
  - 「打开安装/下载目录」= `POST .../open-dir {which:'extensions'|'downloads'}`。
- **Cortico 语义**：安装/卸载后必须重启 Coopanion 主程序才会加载/卸载扩展；本插件只操作 `coo-extensions` 与 `<cooRoot>/data/extensions`，**不执行任何扩展代码**。
- 空态会提示「先去 Coo 市场下载插件」并可一键切到 Coo 市场 Tab。

### 1.6 总控台「本机桌宠插件」（T34，B 方案）

用户澄清：要装的是**本机桌宠**（dsh-coo-pet-remote，远程 DSH 人格）的插件，不是 Coo 主程序扩展。
B 方案不碰大脑：只在本机桌宠侧聚合/开关原生能力，保留远程人格、记忆与 QQ 同一身份。

- **Host `GET /whale-panel/pet-plugins`**（只读）：聚合
  `observer{running,paused,pid,lastHeartbeatAt,foreground{process,title}}`（读 context-observer 状态）、
  `crossChat{configured,sshEnabled,awarenessPatchConfigured,qqGroupsCount,qqChatsCount}`、
  `diy{packCount,packs[]}`（扫 `coo-pet-data/web`）、`screen{available,model,endpoint,reason,requires:'vision-model',
  auto:{enabled,lastLookAt,lastSpokenAt,lastCaption,lastSpoken,totalLooks,totalSpoken,lastError}}`
  （真实探测本机 Ollama `/api/tags`；auto 读 T36 的 `screen-look-state.json`/`screen-autolook.json`）。
  不执行任何第三方代码、不改设置。
- **总控台 UI「本机桌宠插件」卡**（状态卡片之后）：
  - 前台感知 / 游戏陪玩：运行中/已暂停 + 当前前台窗口（进程/标题）；按钮「暂停/恢复」复用现有
    `POST /control-center/pause-context`；
  - 跨端接话（QQ ↔ 桌面）：显示已启用/未配置（SSH/QQ 白名单计数）+「去设置」；
  - 桌宠 DIY / 形象包：显示已安装形象包数量 +「去设置」；
  - 看屏幕（T35）：真实探测本机 Ollama（`GET /api/tags`，1.5s 超时、缓存 10s）；可用时显示「看一眼屏幕」按钮，
    点击 → PowerShell 截主屏 1280×720 JPEG（存 `<coo-pet-data>/screenshots/latest.jpg`）→ 本机 Ollama
    `qwen2.5vl:3b` 生成中文 caption（显示在卡片内，可滚动；截图只存本机、只发回环 Ollama）；不可用时禁用+原因；
  - **自动看屏幕（T37，配合 T36）**：同一行有「自动看屏幕：开/关」按钮（`POST /whale-panel/pet-plugins/screen-auto`
    原子写 `<coo-pet-data>/screen-autolook.json` 供桌宠插件读取），并显示
    `上次看 HH:MM · 共 N 次 · 上次说：「…」`（读 `<coo-pet-data>/screen-look-state.json`，无数据「还没看过」）；
    自动节奏/间隔/限流/相似度去重/说不说由 T36 桌宠插件负责，本面板只做开关与展示；
  - 底部说明：保留远程人格、记忆与 QQ 同一身份，这些插件不改变大脑。
- **原「Coo 插件」卡**改为默认折叠的 `<details>`，标题「Coopanion 扩展（仅 Coo 主程序，不影响本机桌宠）」；
  安装/运行/重启只影响 Coo 主程序，不再作为本机桌宠的主操作。

## 2. 架构与鉴权（为什么有 Host 半）

bridge 的 HTTP 接口（`/health` `/history` `/say` …）**没有 CORS 头**，浏览器从 DSH 页面
（`http://127.0.0.1:53316`）直接 `fetch('http://127.0.0.1:47891/...')` 会被跨源拦截；
而浏览器直连 `WS /events` 不受 CORS 限制，但 bridge 要求 `?token=<token>`，浏览器又读不了本地文件。

所以分两段：

```
浏览器 (DSH 页面, 同源)                    Host 半 (DSH Web 进程, Node)              bridge
  GET  /whale-panel/config   ───────────▶  读 token 文件 + 拼 eventsUrl    （不转发）
  GET  /whale-panel/health   ───────────▶  fetch bridge /health          ──▶ 127.0.0.1:47891
  GET  /whale-panel/history  ───────────▶  fetch bridge /history         ──▶ 127.0.0.1:47891
  POST /whale-panel/say      ───────────▶  fetch bridge /say (≤280s)     ──▶ 127.0.0.1:47891
  WS   ws://127.0.0.1:47891/events?token=…  ◀────────────────────────────────── 浏览器直连
  GET  /control-center/status        ──────▶  bridge /dashboard（T18；缺则 /health+/mood+/context）
                                            + 本机文件/锁/自启 + PAUSED        ──▶ 127.0.0.1:47891
  POST /control-center/pause-context ──────▶  写/删 context-observer/PAUSED（只此固定路径）
  GET  /whale-panel/settings         ──────▶  本地 settings.json + 观察器状态
                                            + ssh 只读服务器 patch（5 个 qqPreview 键）      ──▶ <your-host>
  POST /whale-panel/settings         ──────▶  写本地 settings.json（白名单字段）
  POST /whale-panel/apply-awareness  ──────▶  ssh 写服务器 patch（二次确认） + restart dsh-web
  POST /whale-panel/open-directory   ──────▶  explorer 打开 dshLinkRoot（固定路径）
  GET  /whale-panel/pet-diy          ──────▶  读 pet-settings.json + 扫描 web/*/figure.json + skin.json   ──▶ coo-pet-data（只读）
  POST /whale-panel/pet-diy          ──────▶  白名单校验 + 合并写 pet-settings.json（原子写 + .bak 备份；插件 ~1s 热应用）
  POST /whale-panel/pet-diy/import-pack ────▶  原始 ZIP（≤128MB）→ 安全校验/解包 → coo-pet-data/figures|web/<id>（不执行）
  GET  /whale-panel/pet-plugins        ──────▶  本机桌宠原生插件状态（observer/跨端/DIY/看屏幕探测；只读）
  POST /whale-panel/screen-look        ──────▶  截图 1280×720 JPEG → 本机 Ollama 视觉模型 → caption（只发回环）
  POST /whale-panel/pet-plugins/screen-auto ─▶  写 `<coo-pet-data>/screen-autolook.json` {enabled}（T36 读取；原子写）
  GET  /whale-panel/coo-plugins        ──────▶  已下载/已安装 Coo 插件 + Coopanion 主程序状态（缓存 ~3s）
  POST /whale-panel/coo-plugins/install|uninstall  ─▶  pnpm add/remove（confirm；需重启 Coopanion）
  POST /whale-panel/coo-plugins/run|restart        ─▶  spawn Coopanion.exe / 只杀主程序后重启（不杀 pet-host）
  POST /whale-panel/coo-plugins/open-dir           ─▶  explorer 打开 extensions/downloads
  GET  /whale-panel/coo-market       ──────▶  npm search(cortico) 缓存 10min + 扫 Coopanion extensions（只读） ──▶ registry.npmjs.org / 本机
  POST /whale-panel/coo-market/download  ────▶  下载 npm tarball（≤200MB/120s）→ 校验 tar 条目 → 解包到 dsh-link/coo-extensions/（不执行）
  POST /whale-panel/coo-market/install   ────▶  二次确认后用 Coopanion 自带 pnpm 安装到 extensions（需重启 Coopanion）
  POST /whale-panel/coo-market/open-dir  ────▶  explorer 打开 coo-extensions 下载目录
```

安全约束（已写进代码并有离线测试）：

- `bridgeUrl` 必须是回环地址（`127.0.0.1` / `localhost` / `::1`），否则插件拒绝启用并记错误日志（红线）。
- 浏览器发来的跨源 `Origin` 一律 **403**；同源（`localhost` 与 `127.0.0.1` 同端口视为同源）或无 Origin（curl/本机脚本）放行。
- token 仅在 `/whale-panel/config` 响应里交给同源页面，**不打印到日志、不在面板 UI 显示**；token 每次请求即时读文件，bridge 换 token 后无需重载插件。
- `session` 参数由配置固定为 `pet-local`，浏览器不能指定任意会话；两个 QQ 红线会话永远不会被面板访问。
- 只监听/只调用本机回环；不写 bridge、不装其他插件、不碰 Coopanion/服务器。

## 3. 安装（由 Lead 用 `plugin_manager` 执行）

安装目标（包根目录绝对路径）：

```text
<workspace>\dsh-link\whale-panel
```

`link:` 方式安装（推荐：本目录源码原地链接，改代码后重载插件生效，不复制）：

```text
plugin_manager {
  action: "install_bundle",
  target: "link:<workspace>/dsh-link/whale-panel"
}
```

若 `link:` 不被接受，用文件方式：

```text
plugin_manager { action: "install_bundle", target: "file:<workspace>/dsh-link/whale-panel" }
```

安装后确认：

- `plugin_manager { action: "list_bundles" }` 能看到 `@local/dsh-whale-panel`（bundle 名可能是 `@local/dsh-whale-panel` 或依赖项名）。
- 查看安装结果里的 `application`：`applied` 才算生效；Host 半注册 `/whale-panel` 路由，Client 半随页面 HMR 载入。
- 打开 DSH Web UI：侧栏出现两个图标——「鲸歌」（order=5）与「总控台」（order=4）；点开分别是整页聊天与控制中心。
- 排查：浏览器控制台不应有 `slot entry crashed in 'main'`；Host 日志应有
  `[whale-panel] 已注册 /whale-panel/*, /control-center/* -> http://127.0.0.1:47891`。

### 重载已安装插件（T21 更新后，Lead 执行）

插件已通过 `link:<workspace>/dsh-link/whale-panel` 安装，源码改动无需重装，但 **Host/Client 都要换到新代码**：

```text
# 1) 热重载 bundle（Host 半新增 settings/apply/open-directory 路由 + Client 半合并版 Tab）
plugin_manager { action: "set_bundle", target: "@local/dsh-whale-panel", enabled: false }
plugin_manager { action: "set_bundle", target: "@local/dsh-whale-panel", enabled: true }

# 2) 刷新 DSH Web 页面（client.js 新模块代需要页面刷新；只 reload 插件不够，见 §5-7）
# 3) 侧栏应只剩一个「鲸歌」图标（原独立「总控台」入口已删除）；点开顶部有 聊天 | 总控台 | 设置 三个 Tab
# 4) 自查（浏览器 DevTools Console）：
#    fetch('/control-center/status').then(r=>r.json()).then(s=>console.log(s.ok, s.dashboard, s.components))
```

若热重载后侧栏仍只有「鲸歌」：重启 DSH 一次（Client 模块代的已知限制，见 §5-7）。

> 本插件不改 profile 的 `package.json` / `cordis.patch.yml`；patch 由 `install_bundle` 合并。

### 配置（可选，改 `cordis.patch.yml` 后重载）

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | `http://127.0.0.1:47891` | bridge 地址（config 层必须回环；设置页可覆盖为局域网地址） |
| `tokenFile` | 空（= `<dshLinkRoot>/bridge/token.txt`） | bridge token 文件（用于 WS `/events`） |
| `ui.sidebarLabel` | `鲸歌` | 左侧栏名称（设置 → 通用/连接 可改；刷新页面生效） |
| `ui.panelTitle` | `鲸歌` | 面板标题（空 = 用 sidebarLabel） |
| `ui.tabLabels` | `{chat, control, settings, market}` 中文 | 四个 Tab 文案（可选覆盖） |
| `token` | 空 | 直接给明文 token（两者都有时 `token` 优先；一般不用） |
| `sessionId` | `pet-local` | 要显示/续聊的服务器会话 id |
| `healthTimeoutMs` | `5000` | `/health` 代理超时 |
| `historyTimeoutMs` | `10000` | `/history` 代理超时 |
| `sayTimeoutMs` | `260000` | `/say` 代理超时（bridge 一轮上限 240s） |
| `dshLinkRoot` | 空（= 插件目录的上一级） | 工作区根：总控台组件状态/锁/自启文件、PAUSED、token/下载目录都从它推导 |
| `startupDir` | 空（= 当前用户 `%APPDATA%\...\Startup`） | 覆盖 Startup 目录（测试/非默认安装用） |
| `dashboardTimeoutMs` | `6000` | bridge `/dashboard` 超时（T18 目标 <2s；冷启动留余量） |
| `settingsFile` | 空（= 插件目录 `settings.json`） | 本地面板设置文件（Host 管理，白名单字段） |
| `serverSshHost` / `sshHost` | 空（= 不启用 SSH 功能） | 服务器 SSH（`user@host`）；空时设置页只读本地，`apply-awareness` 返回 400 ssh-disabled |
| `sshKey` / `sshKnownHosts` | 空（= 用系统默认 ssh 配置；默认推导 `<dshLinkRoot>/.ssh/id_ed25519` / known_hosts） | SSH 私钥/known_hosts（只走本机 ssh 客户端） |
| `awarenessPatchPath` | 空（= 不启用服务器 QQ 配置读写；设置页「通用/连接」可覆盖） | 服务器 awareness patch 路径；只改其中 5 个 `qqPreview*` 键 |
| `remoteFileOwner` | 空（= 不改属主） | 写服务器 patch 后 `chown` 的属主（如 `user:group`；默认空 = 不改属主） |
| `qqPreviewGroups` / `qqPreviewChats` | `[]`（不预览任何会话） | QQ 预览白名单默认值（设置 → 通用/连接 可改） |
| `qqPreviewMaxItems` / `qqPreviewMaxChars` | `4` / `60` | QQ 预览最多行数 / 每行字数 |
| `remoteDshService` | `dsh-web` | 「应用并重启服务器 DSH」重启的服务名 |
| `sshTimeoutMs` / `applyRestartWaitMs` | `20000` / `45000` | ssh 单命令超时 / 重启轮询上限 |
| `awarenessCacheMs` | `15000` | 设置页读取服务器配置的缓存（避免每次打开都 ssh） |
| `cooPetDataRoot` | 空（= `dshLinkRoot/coo-pet-data`） | 桌宠数据根（T23）；T22 插件默认 settingsFile 即 `coo-pet-data/pet-settings.json`（未覆盖 config），与本插件默认一致 |
| `petSettingsFile` / `petSkinFile` / `petPacksDir` | 空（= 上面根下 `pet-settings.json` / `skin.json` / `web`） | 桌宠 DIY 设置/当前 skin/形象包目录；`web` 由 T22 复制用户包 |
| `petImportMaxBytes` / `petImportTimeoutMs` | `134217728`（128MB） / `120000` | 形象包 ZIP 上传上限 / 解包超时（T30） |
| `cooMarketUrl` | npm search（text=cortico,size=250） | Coo 市场数据源（需本机能访问 registry.npmjs.org） |
| `cooMarketCacheMs` / `cooMarketTimeoutMs` | `600000` / `15000` | 市场缓存 10min / 拉取超时 |
| `cooExtensionsDir` | 空（= 自动探测 Coopanion 的 `data/extensions`；探测不到回退 `<dshLinkRoot>/coo-extensions-installed`） | 本机 Coopanion 已安装扩展目录（只读扫描；安装按钮会写这里，需确认） |
| `cooDownloadsDir` | 空（= `<dshLinkRoot>/coo-extensions`） | T25 下载目录（只写这里；删除子目录即回滚） |
| `cooDownloadMaxBytes` / `cooDownloadTimeoutMs` | `209715200` / `120000` | tarball 上限 200MB / 下载超时 120s |
| `cooTarPath` | `tar.exe`（Windows 自动用 System32\tar.exe，避免 MSYS tar） | 解包用系统 tar（只解包，不执行包内容） |
| `cooRoot` / `cooPnpmPath` | 空（自动探测 Coopanion 安装：环境变量/常见目录/运行中进程；pnpm 在 `<cooRoot>/resources/app/node_modules/pnpm/bin/pnpm.cjs`） | 安装到 Coopanion 时用的根与 pnpm |
| `visionEndpoint` | `http://127.0.0.1:11434` | 本机 Ollama 地址（只允许 http/https + 回环） |
| `visionModel` | `qwen2.5vl:3b` | 视觉模型名（探测 /api/tags；generate 时使用） |
| `visionPrompt` | 中文两三句描述 prompt | 视觉模型提示词（不逐字读屏/不猜隐私） |
| `visionTimeoutMs` | `120000` | 视觉推理超时（热推理 ~1.3s，冷加载 ~12s） |
| `screenShotDir` | 空（= `<cooPetDataRoot>/screenshots`） | 看屏幕截图目录（latest.jpg） |
| `cooExeName` | `Coopanion.exe` | 要 spawn 的 Coo 主程序 exe（相对 `cooRoot`） |
| `cooProcessCacheMs` / `cooRestartWaitMs` | `3000` / `1500` | Coopanion 进程状态缓存 / 重启时等待旧进程退出 |

### 前置条件

1. 本机 bridge 在跑：`curl -s http://127.0.0.1:47891/health` 返回 `{"ok":true,...}`；
2. `bridge/token.txt` 存在（bridge 首次启动自动生成）；
3. bridge 版本含 `/history` + `WS /events`（bridge v2；缺失时面板仍可显示 `/health` 状态，历史区提示「bridge 还没有 /history 接口」，WS 自动退化为轮询）；
4. 服务器 `pet-local` 会话存在（`/health` 里 `sessionExists:true`）。

bridge 没起也可以装：面板会显示「bridge 未连接」，bridge 起来后 5s 内自动恢复，无需刷新页面。

### 卸载

```text
plugin_manager { action: "remove_bundle", target: "@local/dsh-whale-panel" }
```

或 `plugin_manager { action: "set_bundle", target: "@local/dsh-whale-panel", enabled: false }` 仅停用。
卸载后侧栏图标与整页面板消失；不影响 bridge、Coo 桌宠、QQ、服务器会话。

## 4. 验证

本目录内（使用 DSH 内置 node）：

```bash
NODE="<user-home>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"

# 1) 语法
for f in index.js client.js test/*.mjs tools/*.mjs; do "$NODE" --check "$f"; done

# 2) 离线自测（mock bridge / mock ssh / mock coo-pet-data / mock npm+tar，不联网、不写服务器/真实桌宠数据；101 项）
"$NODE" --test test/host.test.mjs test/client.test.mjs test/manifest.test.mjs test/control-center.test.mjs test/settings.test.mjs test/pet-diy.test.mjs

# 2.5) 总控台真实数据自检（直接调 Host 半聚合；不装插件、不开浏览器）
"$NODE" tools/status-check.mjs --summary

# 3) 真实 bridge 只读冒烟（config / health / history）
"$NODE" tools/live-smoke.mjs

# 4) 真实发送冒烟（会消耗服务器一轮模型调用，按需）
"$NODE" tools/live-smoke.mjs --say "只回复：面板链路 OK"
```

覆盖点：Host 路由注册（两组 prefix）/拒绝非回环/同源校验/token 转发/health·history·say 代理/桥掉线 502/
**总控台 status 聚合（dashboard 优先、缺失降级、bridge 掉线仍返回本机组件）/pause-context 写删与边界**/
错误边界；Client 模块 id/inject/slot 注册参数（两个 sidebar + 两个 main）/中英文案 key 完整/
消息合并去重与排序/本地乐观消息回收/指数退避/WS URL/图标与面板静态渲染不抛错/
**总控台卡片与组件行模型/格式化函数/layout 切换 main key**/不引 Harness Client 包/主题 token；
manifest、patch、locale、icon 合规。

### 总控台联调记录（2026-10-28，T19）

**阶段 1：T18 `/dashboard` 未上线时（bridge pid 28180）** —— 自动降级，其余卡片照常：

```text
dashboard: 降级（unknown route GET /dashboard）
bridge: pid=28180 uptime=1429965ms busy=否
server: up=是 dshWeb=— qqBridge=— tunnel=是
context: count=6 events=5
pet: online=是 wsChat=1
component.observer: running=是 pid=13296
component.sync: running=是 pid=27668
component.mirror: running=是 pid=18160
autostart: bridge=✓ 情境观察器=✓ 本机→服务器同步=✓ 会话镜像=✓
```

**阶段 2：T18 `/dashboard` 上线后（无需改插件）** —— 自动切到真实聚合（最终版 bridge 2.2.0，pid 21656；面板顶部 chip 显示 `dashboard 1ms`）：

```text
dashboard: 可用（T18）
bridge: pid=27212 uptime=84481ms busy=否
server: up=是 dshWeb=active qqBridge=active tunnel=是
mood: 平静·懒洋洋 (valence=0, memory=278)
context: count=3 events=3
qq: 2 行（social-v2）
  - QQ 私聊 22:19 你：「你在那边给我发个消息，问个好」→ 我：「会自己跟你问好的」
  - QQ 群聊 21:52 天羽tian_yu：「数据不是很多」
pet: online=是 wsChat=1
component.observer: running=是 pid=13296
component.sync: running=是 pid=27668
component.mirror: running=是 pid=18160
autostart: bridge=✓ 情境观察器=✓ 本机→服务器同步=✓ 会话镜像=✓
errors: 无
```

**HTTP 路由冒烟**（本地临时起 http server，用真实配置跑 Host handler，不装插件、不开浏览器）：
`GET /control-center/status` → `ok:true, dashboard.available:true, components.observer/sync/mirror:running, autostart 4/4`；
跨源 Origin → `403`；`POST /control-center/pause-context`（用临时 dshLinkRoot，不碰真实 observer）→
`paused:true` 且 PAUSED 文件创建、`paused:false` 后文件删除；`GET /whale-panel/health` 回归正常。

> T18 `/dashboard` 鉴权已核对：无 token → 401、带 token → 200；Host 半三种方式带 token（query/Bearer/x-bridge-token）。
> 真实像素（侧栏图标/卡片布局/明暗主题）仍需在页面里人工确认——本次未安装、未重启 DSH（由 Lead 统一 reload）。

**视觉验证说明**：离线测试只做「静态渲染不抛错 + slot 注册参数 + 样式只用主题 token」，
真实像素效果（明暗主题下的外观、侧栏图标大小、窄窗口布局）需要装进 DSH 后在 Web UI 里人工确认；
本次交付未安装插件（安装由 Lead 统一执行），所以**渲染效果尚未在真实页面截图验证**。

### 联调记录（2026-10-28，T11 × T10）

- **Host 代理 → 真实 bridge 只读冒烟 PASS（4/4）**：`/whale-panel/config`（tokenPresent=true、eventsUrl=`ws://127.0.0.1:47891/events`）、`/whale-panel/health`（`server.up=true`，`sessionId=pet-local`）、`/whale-panel/history`（36 条 = user 18 + assistant 18）。
- **WS `/events` 实测**：浏览器同款 URL（`ws://127.0.0.1:47891/events?token=…`）握手成功，收到 `snapshot`（36 条）与 `status{running:false}` 帧；bridge 侧已修复「多端点 upgrade 监听器互相 destroy」的 bug（T10，单分发器方案），并实测 `message`（user/assistant）与外部来源（服务器 Web UI 直发）都能实时推送。
- **未实测项**：经代理的真实 `POST /say`（会触发服务器一轮模型调用）在开发期未自动执行；bridge 的 `/say` 本身已由 T10 实测（`say → 200 + 完整回复`），本插件的代理路径由 mock 测试覆盖（透传 body / 状态码 / `busy` 409 / 超时 / 桥掉线）。装好后在面板里发一句即可完成验收。

### T26 联调记录（2026-10-29，未安装、未重启本机 DSH）

- 默认配置全部通用：`bridgeUrl=http://127.0.0.1:47891`、`dshLinkRoot=''`（推导为插件目录上一级）、`tokenFile=''`（推导 `<dshLinkRoot>/bridge/token.txt`）、`serverSshHost=''`（SSH 禁用）、`awarenessPatchPath=''`、`qqPreviewGroups/qqPreviewChats=[]`、`cooRoot/cooExtensionsDir/cooDownloadsDir=''`（自动探测/推导）、`ui.sidebarLabel='鲸歌'`。
- **私有值 grep 自查**：`index.js` / `client.js` / `cordis.patch.yml` / `test/*.mjs` 中不含 `<your-host>`、QQ 号、`D:/...` 本机路径、`C:/Users/...`、SSH key 文件名等私有值（README 全部用占位符；测试用 `example.test` / `group:<id>` 占位）。
- T26 新增测试：默认通用值、UI/桥接/SSH/QQ 白名单校验与保存、显式空 SSH → `GET settings` 返回 disabled 且 `apply-awareness` 400 `ssh-disabled`、`GET /config` 下发 ui/sshEnabled/qqDefaults/paths、client `localizeWithUi`/Tab 文案覆盖/设置页「通用 / 连接」渲染。
- 未实测真实「局域网 bridge」与真实 SSH 应用（默认禁用；需要的用户填 `serverSshHost` 后用）。全部测试离线 mock。

### T37 联调记录（2026-10-29，未安装、未重启本机 DSH）

- 离线测试 **151/151 PASS**：新增 pet-plugins 用例（GET screen.auto 默认空/读 `screen-look-state.json` 全字段/
  只有 `screen-autolook.json` 时 enabled 回退；POST screen-auto 写入 `{enabled,updatedAt}` 原子文件、非法 body 400、
  403/405）+ client 用例（`formatScreenAutoLine` 无数据/次数/上次说、screen 行携带 auto 状态、中英文案）。
- 与 T36 的互操作文件约定（已实现）：
  - 面板写 `<cooPetDataRoot>/screen-autolook.json`：`{enabled:boolean, updatedAt}`（T36 读 enabled）；
  - 面板只读 `<cooPetDataRoot>/screen-look-state.json`：`{enabled,lastLookAt,lastSpokenAt,lastCaption,lastSpoken,totalLooks,totalSpoken,lastError}`
    （时间戳均为 **epoch 毫秒**；T36 内部的 `lastHash/nextDueAt` 等调度字段面板忽略；文件缺失/坏 JSON 时显示「还没看过」）。
  - T36 每 5s tick 读 `screen-autolook.json` 只看 `enabled`（忽略 `updatedAt`）；文件缺失回落 Config `screenAutoLook`。
- 未安装/未 reload DSH；未真实打开自动看屏幕（T36 插件需 reload 后才会读开关）。

### T35 联调记录（2026-10-29，未安装、未重启本机 DSH）

- 离线测试 **147/147 PASS**，新增 `vision.test.mjs` 6 项：endpoint 回环校验、probeVision
  （tags 含模型 available=true / 缺模型/失败 false / 10s 缓存不重复请求）、screen-look 成功
  （mock 截图 + mock Ollama：caption/model/elapsedMs/截图路径/bytes、请求体 model/images/stream=false/
  num_ctx=8192/num_predict=160）、截图失败 502、Ollama 500→502、超时→504、非回环 endpoint→502、403/405；
  client 新增 1 项（视觉可用时 screen 行可点击/按钮文案）。
- **真实 Ollama 冒烟**（不截真实屏幕）：用 PowerShell 自造 320×180 纯色测试图 → `qwen2.5vl:3b`
  `POST /api/generate` → 200、**热推理 1651ms**、caption「这张图的主色调是蓝色。」；
  `GET /whale-panel/pet-plugins` 探测 → `screen:{available:true,model:'qwen2.5vl:3b',endpoint:'http://127.0.0.1:11434'}`。
- 截图脚本（System.Drawing 1280×720 JPEG quality 80）已用合成位图验证保存分支；**未截真实屏幕**（留给 Lead reload 后点按钮验证）。
- 安全：截图只写本机 `coo-pet-data/screenshots/latest.jpg`，只发本机回环 Ollama，不外发、不执行扩展代码。

### T34 联调记录（2026-10-29，未安装、未重启本机 DSH）

- 离线测试 **139/139 PASS**，新增 `pet-plugins.test.mjs` 4 项：observer running/paused/前台窗口、跨端配置
  （SSH/QQ 计数）、DIY 形象包数量、看屏幕 available=false+reason、observer 文件缺失降级、403/405；
  client 新增 2 项（`buildPetPluginRows` 状态映射、总控台「本机桌宠插件」卡静态渲染 + Coo 卡 `<details>` 折叠）。
- 真实只读冒烟：`GET /whale-panel/pet-plugins` 从本机 context-observer 读到 running=true、前台窗口
  `Apex Legends (r5apex_dx12)`、`diy.packCount>0`、`screen.available=false`；未做任何写入/执行。
- Coo 主程序扩展卡保留但默认折叠；未修改 T33 的安装/运行/重启逻辑。

### T33 联调记录（2026-10-29，未安装、未重启本机 DSH，未安装/未启动真 Coo）

- 离线测试 **133/133 PASS**，新增 `coo-plugins.test.mjs` 11 项：进程分类（只把不含 `--pet-host`/`--type=` 的算主程序）、
  下载/已装元数据扫描（`package.json.cortico.kind`/displayName）、GET 结构、install/uninstall 的 confirm 与 404、
  run 未装 409 `needInstall`/在跑 409 `needRestart`/未跑 spawn、exe 缺失 400、restart 只杀主进程（pet-host 不动）、
  open-dir、进程状态缓存；client 新增 2 项（`buildCooPluginRows` 合并/kind、总控台 Coo 插件卡静态渲染/空态）。
- **真实只读冒烟**（本地临时 http server 调 Host handler，未装插件、未启动/未杀任何 Coo 进程）：
  `GET /whale-panel/coo-plugins` → 200（首查 ~978ms，含 PowerShell 进程枚举；第二次缓存 ~9ms）；
  `coo.running=false`，`petHostPids` 正确列出 pet-host/子进程、未误判为主程序；`cooRoot`/`exe`/`canLaunch` 正确；
  已下载列表读到 2 个包（`cortico-world-screen-look`、`cortico-world-gaming-alont1`，kind=world，installed=false），
  `installed=[]`（Coopanion extensions 当前为空）。**未做真实安装/启动/重启**（留给 Lead 真机验证）。

### T30 联调记录（2026-10-29，未安装、未重启本机 DSH）

- 离线测试 **120/120 PASS**，新增 `pet-diy-import.test.mjs` 12 项：条目校验（绝对路径/`..`/盘符/空/超 5000）、
  figure.json 深度/多个、符号链接拒绝、正常导入（figures+web，GET 列表可见）、嵌套一层只装包内容、
  无 figure/多 figure/id 非法/name 缺失 400、危险条目/坏 zip/超上限 413/415/403/405、已存在 409、
  `replace=1` 备份旧包并替换、临时目录清理；client 新增 2 项（导入 URL/结果文案/上限、设置页导入按钮 + file input）。
- **真机式冒烟（真实 zip + 真实系统 tar，临时 coo-pet-data）**：PowerShell `Compress-Archive` 生成 535B zip →
  `POST /whale-panel/pet-diy/import-pack` → 200（`demo-pack` v0.9.0，3 files）；再次导入 → 409 `already-exists`；
  `GET /pet-diy` 列表出现该包；实例文件为 `web/demo-pack/{figure.json,index.js,thumbs/thumb.png}`，临时目录已清理。
  样例 zip 已放 `<workspace>/sample-coo-pack.zip` 供 Lead 真机验证。
- 未在真实用户桌宠上导入（Lead reload 后用自己的 zip 验证）；只写我们自己的 `coo-pet-data`，不写 Coopanion 安装目录、不执行包内代码。

### T25 联调记录（2026-10-28，未安装、未重启本机 DSH）

- 离线测试 **101/101 PASS**，新增 `coo-market-download.test.mjs` 10 项（包名校验/安全目录名/tar 条目安全/已下载扫描/
  下载成功+_meta+GET 反映/同版本缓存/非法名 400/不存在 404/危险 tarball 422/下载失败 500/install 未确认 400/
  未下载 404/confirm 成功 mock pnpm/pnpm 失败 500/open-dir/403/405；另补 extensions/node_modules（含 @scope）扫描测试）
  + client 2 项（下载按钮/已下载徽标/安装二次确认块、onlyDownloaded 筛选）。
- **真实下载冒烟**（本地临时 http server 调 Host handler，未装插件）：`POST /whale-panel/coo-market/download
  {name:"cortico-world-screen-look"}` → 200、tarball **33234 bytes**、解包到
  `<workspace>/dsh-link/coo-extensions/cortico-world-screen-look/`（package.json/README/src/_meta.json 等，
  integrity sha512 记录在 `_meta.json`）；`GET /whale-panel/coo-market` 返回 downloadsDir + downloaded 列表且该行
  `downloaded:true`；第二次请求 `cached:true`。**未安装到 Coopanion**（该步只用 mock 验证，真实安装留给用户点按钮）。
- tar 命中问题与修复：PATH 里 Git/MSYS 的 `tar` 不认 Windows 盘符路径（`Cannot connect to D:`），已改为自动使用
  `%SystemRoot%/System32/tar.exe`（可用 `cooTarPath` 覆盖）。

### T24 联调记录（2026-10-28，未安装、未重启本机 DSH）

- 离线测试 **89/89 PASS**，新增 `coo-market.test.mjs` 7 项（kind 推断 / npm 结果归一化 / extensions 扫描含坏包 /
  GET 成功 + 已安装映射 + 缓存不重复请求 / npm 失败无缓存降级 / 失败有旧缓存保留列表 / 跨源 403 + 405）+
  client 4 项（搜索过滤、排序、下载数格式化/kind/外链规范化、市场面板静态渲染；Shell 测试更新为 4 Tab）。
- **真实 npm 只读冒烟**（本地临时 http server 调 Host handler，未装插件）：`GET /whale-panel/coo-market`
  → 200、**1240ms**（首次拉取）、`items=206`（world 190 / provider 8 / bot 7 / other 1）、
  `installed=[]`（本机 `Coopanion/data/extensions` 不存在）、第二次请求 `cached=true`（10min 缓存）；
  含 `cortico-world-screen-look`、`cortico-world-cua-alont1`、`cortico-provider-gemini-web`，
  也正确识别 `@wocwang/cortico-world-gpt-sovits-for-coopanion`（scoped 包）。
- **未实测**真实点击安装（本插件也不安装）：市场只提供浏览/指引；Coopanion 侧安装行为不在本插件范围。

### T23 联调记录（2026-10-28，未安装、未重启本机 DSH；依赖 T22 `0.4.0-remote.1`）

- **T22 已交付确认**（coo-fork）：`dsh-coo-pet-remote@0.4.0-remote.1`，接口与 T23 完全兼容；插件 config 未覆盖 settingsFile → 默认 `coo-pet-data/pet-settings.json` 与 Host 默认一致；插件启动时生成默认设置 + 每 1s 轮询热应用 + broadcast `prefs`；插件只合并写 pet-settings（启动生成/页面回推），不写 `web/**`；未知 figure 保留当前包、越界数值 clamp、非法枚举/类型忽略。

- 离线测试 **78/78 PASS**，新增 `pet-diy.test.mjs` 7 项：figure 包扫描（含 axes/presets/name 归一化、坏包 warning、
  i18n/kit/speech 等支持目录静默跳过）、默认值/skin.json fallback、GET 路由、POST 合并写 + 保留未知字段 +
  `.bak` 备份 + hoverButtons 过滤 + `skin.axes`、10 类无效输入 400 不落盘、跨源 403/方法 405、校验器单测；
  client 新增 5 项（`petSkinForFigure`/`setPetSkinAxis`/`applyPetPreset`/`petDraftFromData`/`collectPetDiyBody`/
  `petDiySummary` + 设置页静态渲染含「桌宠 DIY」）。
- **真实 coo-pet-data 只读冒烟**（本地临时 http server 调 Host handler，未装插件）：`GET /whale-panel/pet-diy`
  → HTTP 200；扫出 `coo`（配色/头顶/耳侧配件/眼镜/颈饰 5 轴）与 `whale`（配色/服装 2 轴，含 8 个配色/3 套服装选项）；
  `current` 从 `skin.json` 读到 `figure=whale, scheme=deepseek-cape, outfit=maid, scale=2`（T22 的 pet-settings.json
  尚未由插件生成，故 `settingsExists=false`，返回默认值）。全程未写 coo-pet-data、未写 skin.json。
- **真机联调已通过**（2026-10-28 23:35，Lead 已 reload 桌宠插件 `v0.4.0-remote.1`、鲸歌面板新路由已 live）：
  - live `GET /whale-panel/pet-diy`（DSH 53316）→ 200，`settingsExists=true`，扫出 `whale`/`coo` 两包，
    `current = whale · deepseek · cape · scale 2`（与插件迁移后的 pet-settings/skin 一致）；
  - live `POST /whale-panel/pet-diy {scale:2.15, glow:9}` → 200（备份 `pet-settings.json.bak`）→
    轮询桌宠 pet-server `GET /api/state` **404ms** 即变 `scale=2.15/glow=9`（<1s 热应用）；
  - 恢复原始 pet-settings 内容（原子写）→ **1211ms** 回到 `scale=2/glow=7`，文件与恢复前字节一致；测试 `.bak` 已删。
  - 联调期间用户在同时调桌宠（文件 23:35–23:38 多次变化，figure/scale/theme 变化），我们只做了上述受控
    scale/glow 往返、之后未再写用户设置；live GET 随后 1.5s×6 轮询与文件内容实时一致（`at` 为当前时刻）。
  - 一致性口径（与 T22 确认）：文件写入 → 插件下一个 **≤1s 轮询 tick** 才应用/广播，这个窗口内运行态可能还是旧值
    属预期；Host `GET /pet-diy` 直接读文件，稳态与文件一致。联调窗口内偶发读到的瞬时旧值即该窗口/并发编辑所致，不是 bug。
  - 未验证桌面**像素**变化（需人眼/截图），但 pet-server `/api/state` + `pet_status` 外观/界面行已证明生效。

### T21 联调记录（2026-10-28，未安装、未重启本机 DSH）

- 离线测试 **66/66 PASS**，新增 `settings.test.mjs` 12 项：本地设置读写/校验、服务器 patch 解析、
  **白名单合并只改 5 个键且保留 T20 dialogue 等其它键/注释**、mock ssh 完整 apply 流程（写 patch→restart→
  active→回读）、restart 失败自动回滚、GET/POST settings、open-directory、ssh 不可用降级、同源/方法边界。
- **真实 ssh 只读冒烟**（本地临时 http server 调 Host handler，未安装插件）：`GET /whale-panel/settings`
  → HTTP 200；从服务器读到 `awareness.config = {qqPreviewGroup:true, qqPreviewGroups:["group:<group-id>"],
  qqPreviewChats:["private:<private-id>"], qqPreviewMaxItems:4, qqPreviewMaxChars:60}`（与当前服务器 patch 一致）；
  观察器 running/pid 正常；跨源 Origin → 403。
- **未实测**：真正的「应用并重启服务器 DSH」（需要你点按钮确认；会重启服务器 dsh-web 约 10s，
  QQ 桥自动重连）——mock ssh 单测覆盖了成功/回滚两条路径；真实 apply 留给你/用户决定何时执行。
- 真实像素（三个 Tab、设置表单、明暗主题）仍需 reload 后人工确认。

## 5. 已知限制

1. **只服务一个会话**：`sessionId` 固定（默认 `pet-local`）；不支持切换会话/多服务器。
2. **`/say` 是阻塞式**：bridge 返回完整回复后面板才结束「正在想…」；真正的逐字流式需要 bridge 侧提供流式 WS（本轮未做，面板当前按 PANEL-PROTOCOL 的阻塞 `/say` 设计）。
3. **实时依赖 bridge `WS /events`**：当前 bridge v2 若 `/events` 握手失败（例如升级监听器冲突 bug），面板不会报错，会自动退化为 5s 轮询 `/history`（外部来源消息会延迟 ≤5s 出现；发送路径不受影响）。
4. **token 交给同源页面**：浏览器端能看到 token（WS 查询串限制），因此面板接口只允许同源访问；同机其他进程仍可读 token 文件（与 `bridge/token.txt` 本身权限同级，未扩大暴露面）。
5. **历史一次 200 条**：不支持「加载更早」分页按钮（bridge `/history` 已支持 `before`，后续可加）。
6. **消息去重按 id**：bridge 若对同一消息给出不同 id（例如重连快照 id 策略变化），可能短暂重复一条；面板按文本+时间的乐观消息回收只覆盖发送场景。
7. **安装/重载**：首次安装走 HMR 即可；**替换已安装版本的 `client.js` 后**按 DSH 规则需要页面刷新（或重启 DSH）才能拿到新 JS 模块代，单纯 reload 插件不一定够。
8. **外部来源验证**：需要在**服务器 Web UI** 给 `pet-local` 发一句，本机面板经 `WS /events` 收到并显示；bridge `/history` 里也应出现（此条依赖 T10 的 `/events` 正常）。
9. **总控台的 QQ 近况/服务器服务状态依赖 bridge `/dashboard`（T18）**：旧 bridge 无此接口时该区块显示「需要 bridge /dashboard」、`dshWeb/qqBridge` 显示未知，其余卡片/组件照常；`/dashboard` 上线后插件无需改动自动切换（已实测）。
10. **暂停按钮只控制情境观察器**（写/删 `context-observer/PAUSED`）：不会停 bridge/同步/镜像/桌宠；观察器在 ≤3s 内进入暂停、删除后自动恢复。Host 只允许写这个固定路径。
11. **组件 running 判定是启发式**：pid 锁存活或相关日志 2 分钟内更新（mirror 3 分钟）；进程被硬杀留下陈旧锁时会表现为「运行中」，以实际 pid/日志为准。
12. **总控台 `dashboard` 降级时 dshWeb/qqBridge 显示「未知」**：这两个字段来自 SSH（T18 `/dashboard`），本机文件推不出来。
13. **「复制诊断 JSON」依赖浏览器剪贴板权限**：`http://127.0.0.1` 一般视为安全上下文可用；不可用时面板给「复制失败」提示（诊断 JSON 仍可在 DevTools 里 `fetch('/control-center/status')` 取）。
14. **「打开鲸歌面板」改为「切到设置」**（T21 合并后同一面板内 Tab 直达，不再需要 layout 服务）。
15. **「应用并重启服务器 DSH」会真重启服务器 `dsh-web`（约 10s）**：期间 QQ 桥/服务器鲸歌短暂断开并自动重连；写前自动备份 `cordis.patch.yml.bak-t21`，重启失败会自动回滚备份并重新拉起（best effort）。只在用户二次确认后执行。
16. **服务器 QQ 配置编辑只覆盖 5 个 `qqPreview*` 字段**：其它字段（含 T20 dialogue 配置）原样保留；若 T20/T17 同时改同一 patch 文件，仍有极小的「读到旧内容→写入」竞态窗口（apply 前会重新读一次，正常操作不会撞上）。
17. **设置页打开时 Host 需要 ssh 读服务器 patch**（首次约 0.5–2s，15s 缓存）；SSH 不可用时 QQ 预览分组显示读取失败，本地设置/观察器状态不受影响。
18. **本地设置文件 `whale-panel/settings.json` 由 Host 管理**：删掉即恢复默认；`plugin_manager` 重装不会删它（link: 安装，文件在源码目录）。
19. **Tab 切换会卸载非激活 Tab**：聊天 Tab 切走时 WS 会断开，切回重新拉历史+连 WS（约 1s）；总控台 Tab 只在激活时轮询。
20. **桌宠 DIY 依赖 coo-fork T22 插件 0.4.0+**：Host 只负责读写 `pet-settings.json`；没有新版插件时保存成功但桌宠不会变（UI 已注明需 0.4.0+）。
21. **Host 不写 `skin.json`/`web/`**：`skin.json` 由桌宠插件独占写（T23 只读作为「当前生效」fallback；T22 升级后会规范化 `scheme` 为轴值、`outfit` 单独存）。`web/<pack>/` 由 T22 复制用户包：新包放进 `coo-pet-data/figures` 或 Coopanion `data/figures` 后，在设置里被引用一次会触发重导入+重扫（不用重载插件）；「刷新形象包列表」能看到已复制的。
22. **桌宠 DIY 写的是本机 coo-pet-data 的相对固定路径**：路径可由 Config 覆盖（`cooPetDataRoot/petSettingsFile/petSkinFile/petPacksDir`）；只接受白名单字段/值，非法值 400 不落盘；hoverButtons 非法 action 静默过滤（与插件一致）。
23. **`scheme` 语义**：桌宠页面可能把配色+服装拼成展示值（旧 skin.json 里可能是 `deepseek-cape`），而 pet-settings 里 `scheme` 是轴值（如 `harness`）——设置页以 pet-settings 为准、skin.json 仅 fallback；真正的「当前：… 」摘要可能显示旧 skin 值，保存一次后即刷新。
24. **Coo 市场只浏览、不安装/不执行扩展**：扩展由 Coopanion 的 Cortico Core 安装运行，运行时不兼容 DSH；本插件最多给 npm 包名/版本/链接/安装指引。
25. **Coo 市场依赖本机能访问 `registry.npmjs.org`**：GitHub 官方索引本机被封不影响（用 npm search）；断网/registry 故障时显示旧缓存（10min TTL）或可读错误，不影响其它 Tab。
26. **Coo 市场不保证第三方包安全**：列表只是 npm 公共元数据（含 scoped 包），下载/许可/关键词来自 registry；安装时请自行判断来源与权限。
27. **已安装扫描仅读 `cooExtensionsDir`**：支持 `<dir>/<pkg>/package.json` 与 `<dir>/node_modules/<pkg>/package.json`（含 `@scope`）；默认 `<Coopanion-root>/data/extensions`（当前不存在 → installed 为空）。
28. **下载 ≠ 安装/运行**：下载只是把 npm tarball 解到 `dsh-link/coo-extensions/`，本插件绝不执行；要运行必须在 Coopanion 里安装并被 Cortico Core 加载。
29. **安装到 Coopanion 是高级操作**：需二次确认；第三方代码将运行在 Coopanion 里，**需重启 Coopanion 生效**；best-effort 依赖 Coopanion 自带 pnpm 路径（找不到会返回手动安装提示）；不改 Coopanion 安装目录（resources/app）。
30. **下载来源是 npm 公共 registry，不保证第三方包安全**：只做包名/大小/路径穿越校验，不做签名/内容审计；请自行判断来源与权限。
31. **下载/安装回滚**：下载 → 删 `dsh-link/coo-extensions/<name>/`；安装 → Coopanion 设置→扩展卸载或 extensions 目录 `pnpm remove <pkg>` 后重启 Coopanion。
32. **默认不启用 SSH**（`serverSshHost=''`）：QQ 预览服务器配置读写/「应用并重启服务器 DSH」默认禁用，需要用户在「设置 → 通用/连接」填 `user@host`（以及 config `awarenessPatchPath`）后才可用。
33. **名称/标题/Tab 文案保存后需刷新页面生效**（Client 模块在插件加载时读取一次 `/config` 并重注册侧栏 label）；`ui.*` 也可直接写在 config 里作为分发默认值。
34. **bridge 地址的 config 层仍要求回环**（安全红线）；设置页可覆盖为局域网地址（仅 http/https + 回环/局域网校验）。
35. **形象包导入只支持 zip**（≤128MB，一个 zip 只能含一个 `figure.json`，id 需匹配 `^[a-z0-9][a-z0-9-]{0,31}$`）；只复制普通文件/目录（拒绝符号链接/特殊文件），不执行包内代码。
36. **导入目标只写本机 `coo-pet-data/figures` 与 `web`**：不写 Coopanion 安装目录；`replace=1` 会先备份旧目录到 `figures/.backup-<id>-<ts>`（不会自动清理，可手动删）。
37. **导入后需「刷新形象包列表」或重新打开设置页**才能在「形象包」下拉选中（本实现导入成功会自动刷新并选中，但不会自动保存 pet-settings/应用到桌面，需再点「保存并应用」）。
38. **Coo 插件安装/卸载后必须重启 Coopanion 主程序才生效**（Cortico 语义）；「重启并运行」会结束当前 Coo 主程序（不影响 pet-host；正在使用的 Coo 窗口会关闭）。
39. **Coo 插件操作会运行第三方代码**：安装/运行等于让 Coopanion 加载这些扩展，请自行判断来源与安全；本插件只执行 pnpm add/remove 与 spawn Coopanion.exe，不执行扩展代码。
40. **依赖 Coopanion 安装可探测**（`cooRoot`/`Coopanion.exe`/自带 pnpm）：探测不到时卡片给出可读错误，可在 config 里显式配置 `cooRoot`/`cooPnpmPath`；安装/卸载走 Coopanion pnpm，失败会回显输出与手动操作提示。
41. **「本机桌宠插件」卡聚合现有原生能力、不执行第三方代码**：前台感知/跨端接话/DIY 的状态来自 observer 状态文件与设置；「看屏幕」需要本机 Ollama 运行且装有 `visionModel`（默认 qwen2.5vl:3b），探测失败/未运行时按钮禁用并显示原因。
42. **看屏幕截图只存本机**：`coo-pet-data/screenshots/latest.jpg`（可配 `screenShotDir`），只发回环 Ollama；截图本身是当前主屏内容，请在知情下使用；推理超时/模型崩会返回可读 502/504。
43. **Coopanion 扩展卡默认折叠且只影响 Coo 主程序**：不影响本机桌宠/远程人格/QQ；「加入并运行」不再是主操作，需展开后显式确认。
44. **自动看屏幕开关只写本机开关文件**：实际节奏/间隔/限流/相似度去重/是否说话由 T36 桌宠插件负责；T36 未安装/未 reload 时开关只落盘不生效。
45. **screen.auto 状态只读 T36 的输出文件**：`screen-look-state.json` 不存在/损坏时显示「还没看过」，不报错；自动看屏幕仍受 T36 自己的暂停（context-observer PAUSED）与 brain busy 约束。

## 6. 文件

```
dsh-link/whale-panel/
├── package.json          # dsh.bundle.patch + dsh.client（platform=web, immediately, inject）
├── cordis.patch.yml      # insert 行：id=whale-panel + 默认 config
├── index.js              # Host 半：/whale-panel/* + /control-center/* 同源路由（node 内置模块）
├── client.js             # Client 半：两个 sidebar.panellist + 两个 main 面板（__ModuleLoader__ 工厂）
├── locale/{zh,en}.json   # 插件管理器的标题/描述（meta.title / meta.description）
├── icon.svg              # 插件与管理器图标（原创鲸鱼 + 音符）
├── test/
│   ├── mock-bridge.mjs        # 离线 mock bridge（/health /history /say /dashboard）
│   ├── host.test.mjs          # Host 半（鲸歌）
│   ├── client.test.mjs        # Client 半（聊天/总控台/设置 Tab/模型）
│   ├── control-center.test.mjs # 总控台聚合/降级/pause
│   ├── settings.test.mjs      # T21 本地设置 + 服务器 patch 合并/apply（mock ssh）
│   ├── pet-diy.test.mjs       # T23 桌宠 DIY 包扫描/校验/合并写（mock coo-pet-data）
│   ├── coo-market.test.mjs    # T24 Coo 市场 npm 归一化/缓存/降级/安装扫描（mock npm）
│   ├── coo-market-download.test.mjs  # T25 下载/解包校验/缓存/安装确认（mock npm+tar+pnpm）
│   └── manifest.test.mjs      # bundle/manifest/显示资源
├── tools/
│   ├── live-smoke.mjs         # 真实 bridge 冒烟（只读，可选 --say）
│   └── status-check.mjs       # 总控台真实数据自检（--summary 人类可读）
├── settings.json              # 运行时生成：本地面板设置（删除即恢复默认）
└── （下载目录不在插件内：<workspace>/dsh-link/coo-extensions/，T25 运行时生成）
└── README.md
```
