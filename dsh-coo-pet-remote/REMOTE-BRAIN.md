# `brain: remote` —— Coo 桌宠的「服务器大脑」fork 说明

> **上游**：[dsh-coo-pet](https://github.com/vortioxetine213/dsh-coo-pet) v0.2.1（MIT）
> **本 fork**：`dsh-coo-pet-remote` **0.4.2-remote.1（v1.2：多形象包 + 桌宠 DIY；通用可分发版）**
> **协议**：bridge v1（WS `/chat?token=...`）+ bridge v1.1 的 `GET /mood`（具体说明见 bridge 项目）
> **状态**：单元/集成/分发自查 48/48 通过；**未安装、未重启、未启动 Coopanion、未碰 Coopanion 目录/服务器**
> 写给：接手安装/维护的人。装法/热重载看 [INSTALL.md](INSTALL.md)，分发/打包看 [DISTRIBUTION.md](DISTRIBUTION.md)。

---

## 0. 一句话

上游 dsh-coo-pet 有两种大脑：`local`（插件内自建会话，第三个她）和 `session`（本机 DSH 会话，另一个她）。
本 fork 新增第三种 **`remote`**：这只桌宠只当**显示器**，对话在**远端 DSH 的一个会话**里跑，
经本机 bridge（SSH 隧道 + 离线 cookie）用 WebSocket 收发 —— 于是角色卡、长期记忆（deep-soul 的 `mind.db`）、
角色卡 / 记忆 / 心情都用远端那一份，**和远端那边是同一个她**。

v1.1 起再把「心情」接到桌面上：`pet_status` 显示 bridge 从 `mind.db` 只读派生出的心情快照
（`GET /mood`），气泡动作（`happy/sad/excited/neutral/sleepy`…）也按心情微调。**只读**，不影响聊天主链路。

v1.2 起把「外观」彻底打开：支持 **多形象包**（内置 `coo` / `whale`、Coopanion 用户装包、Steam Workshop 包），
外观/大小/气泡/主题等由 `dataDir/pet-settings.json` 的 **DIY 设置**驱动，改文件 **~1s 热应用**
（鲸歌面板「设置 → 桌宠 DIY」写的也是它）。不用重启 DSH、不用重装插件。

---

## 1. 架构（只多了一条线，其余全是上游原样）

```
 本机 Coopanion 的 pet-host 窗口(外观/走位/拖拽/气泡, 上游原样)
        ▲ 页面 WS(上游 pet-server.mjs)
        │
 dsh-coo-pet-remote (本 fork, 装在本机 desktop profile)
   ├─ pet-server.mjs     ← v1.2 改:`/api/figures` 扫 web/*/figure.json(多 pack)
   ├─ pet-window.mjs     ← 只把 DEFAULT_EXE 改成空(由 cooRoot 推导)；assets.mjs / coo.mjs 未改
   ├─ impl.js            ← 选大脑 + 心情 + v1.2 DIY 设置(轮询/校验/广播)
   ├─ brain-remote.mjs   ← WS 客户端(协议 v1) + 心情轮询(GET /mood)
   ├─ mood.mjs           ← (v1.1) 心情 → 文案 / 气泡动作(纯函数)
   ├─ figures.mjs        ← (v1.2) 形象包发现/导入(用户/Workshop 包 → web/<pack>/)
   └─ pet-settings.mjs   ← (v1.2) pet-settings.json → 设置/页面 skin 的纯函数
        │ ws://127.0.0.1:47891/chat?token=...   +   GET http://127.0.0.1:47891/mood
        ▼
 本机 bridge(bridge/server.mjs, 由独立的 bridge 项目实现)
   ├─ 离线铸 DSH cookie + SSH 隧道 → 服务器 127.0.0.1:3080
   ├─ session/create / session/prompt / session/follow → 桌宠会话
   ├─ 角色卡 once 注入(只读)
   └─ GET /mood(v1.1):经 SSH 把 mind.db 复制到 /tmp 只读查询,派生心情 → 缓存
        │ SSH
        ▼
 远端 DSH: 桌宠会话(agentPreset 由 bridge 配置,例如 local-pet)
   ├─ 角色卡(bridge 侧只读注入;本插件不读也不写)
   └─ deep-soul mind.db(全局唯一一份:记忆/心情)
```

她的话走 `accepted → delta* → final` 流回来；`impl.js` 仍然等 `final` 才在气泡里一次性说完
（上游的显示方式没动，`onDelta` 已实现但暂时只用于日志/调试钩子）。

**v1.2 的外观数据流**（和上面那条远程链路解耦，bridge 挂了也不影响换装/DIY）：

```
 Coopanion 安装目录 web/whale, web/coo ──(ensureAssets 复制)──┐
 <Coopanion data>/figures/<id> ─┐                            │
 <插件 dataDir>/figures/<id>   ─┼─(importFigurePacks 只读复制)┼──► dataDir/web/<pack>/figure.json
 COOPANION_PACK_ROOTS / packsExtraDirs ─┘                    │
                                                              ▼
 鲸歌面板「桌宠 DIY」/ 换装页 / 手改文件 ──► dataDir/pet-settings.json ──(impl 每 ~1s 轮询)
                                                              │ 校验 + resolveSkin
                                                              ▼
                                    snapshot/`{t:'prefs'}` → 桌宠页面(大小/气泡/主题/形象包)
                                    + dataDir/skin.json(legacy 兼容快照)
```

---

## 2. 改动清单（相对上游 802d2d3）

### 2.1 新增文件

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `lib/brain-remote.mjs` | 643 | 远程大脑：WS 长连接、协议收发、重连退避、超时/取消、`forget`/`stop`；**v1.1** 加心情轮询（`GET /mood` + 定时刷新） |
| `lib/mood.mjs` | 162 | **v1.1 新增**：心情 → `pet_status` 文案(`describeMood`)/ 气泡动作(`moodActions`)，纯函数、只用形象包 vocab 里的安全词 |
| `lib/figures.mjs` | 182 | **v1.2 新增**：形象包发现(`scanFigurePacks`)/导入(`importFigurePacks`)，多 pack、坏包记 problem、目标已存在不覆盖 |
| `lib/pet-settings.mjs` | 429 | **v1.2 新增**：`pet-settings.json` 的默认值/校验(`normalizeSettings`)/设置↔页面 skin 解析(`resolveSkin`/`decodePageSkin`)/`skin.json` 兼容(`skinJsonOf`)，纯函数 |
| `test/mock-bridge.mjs` | 185 | 零依赖 mock bridge：`node:http` 升级 + 复用插件自带 `lib/ws.mjs` 做**真** WebSocket 服务端；v1.1 起也提供 `GET /mood` 的可控实现 |
| `test/brain-remote.test.mjs` | 392 | 远程大脑单元测试（15 条：聊天 9 + 连接/工具 1 + 心情 5） |
| `test/mood.test.mjs` | 127 | **v1.1 新增**：心情文案/动作映射纯函数测试（9 条） |
| `test/pet-diy.test.mjs` | 379 | **v1.2 新增**：形象包扫描/导入、设置校验/降级、preset/多轴/coo 槽位/自定义轴解析、旧 skin.json 迁移（14 条） |
| `test/impl-remote.test.mjs` | 481 | `impl.js` 端到端集成测试（假 Cordis ctx + 假 Coopanion 目录 + 假桌宠页面 + mock bridge；含心情/气泡动作/v1.2 多 pack 与 pet-settings 热应用+广播/v0.4.1 token 路径与缺配置提示） |
| `test/distribution.test.mjs` | 164 | **v0.4.1 新增**：分发自查（发布白名单/源码/patch/config-bundle 无私有值；默认配置未写死部署字段；打包白名单合理） |
| `test/stubs/dsh-tools.mjs`、`test/stubs/loader.mjs` | 30 | 只在测试里把 `@deepseek-ai/dsh-tools` 换成替身（DSH 宿主之外解析不到这个包） |
| `dev/remote-probe.mjs` | 102 | 独立探针：不起 DSH/Coopanion，直接验 `RemoteBrain ↔ bridge`（支持 `--self-test` 用内置 mock） |
| `config-bundle/` | 3 文件 | **本地配置覆盖模板**（`@local/dsh-coo-pet-remote-config`）：填占位后安装，**不随包发布**；装法见 `config-bundle/README.md` |
| `REMOTE-BRAIN.md` / `INSTALL.md` / `DISTRIBUTION.md` | 本文件 | 原理与限制 / 安装验收 / 打包分发 |

### 2.2 修改文件

**`lib/impl.js`（+550/−117，1358 行）** —— 选大脑/心情/DIY 设置/分发通用化这几圈改动，窗口/换装/互聊/工具逻辑其余原样：

| 位置（行号） | 改动 |
| --- | --- |
| `~100` `makeBridgeTokenReader()` | 新增。bridge token 的**懒读器**：`bridgeToken` 优先，否则读 `bridgeTokenFile`；读到就缓存，读不到下次建连再读（DSH 常常比 bridge 先启动，不能一次读空就定死） |
| `~299` | `brainMode` 从二选一改成三选一：`config.brain === 'remote' ? 'remote' : ...` |
| `~303–312` | 新增 bridge 配置解析：`bridgeUrl`（默认 `http://127.0.0.1:47891`）、`bridgeSessionId`（默认 `pet-local`）、`bridgeTimeoutMs`（默认 240000）、`readBridgeToken` |
| `~247` | 动态 import 列表加 `RemoteBrain`（沿用上游 `?v=<rev>` 缓存穿透技巧） |
| `~465–476` | `sessionController` **只在 `brain: session` 时才拿/才等 10 秒**；remote/local 不碰它（改前是任何模式都 `ctx.get` 一次） |
| `~494` | 新增 `makeRemoteBrain()` 工厂（传 bridgeUrl / token 读取函数 / sessionId / timeout） |
| `~507–515` | `brainKind` 三值；remote 时启动日志打印「她的大脑:远程 bridge …」 |
| `~521–529` | `fallbackToLocal()` 只允许 `session → local`。**remote 绝不降级**（降级＝凭空多出第三个她） |
| `~531–541` | `brainSay()`：session 失败照旧降级重试；**remote 失败只记 `warn` 日志然后原样抛错**，由气泡显示可读错误 |
| `~552` | `tools.guard` 仍然只在 `brainKind === 'session'` 挂；remote 的工具边界在 bridge 另一端的 preset/工具守卫 |
| `~878` | `pet_status` 新增 remote 分支：brain 模式、bridge 地址、服务器会话 id、连接正常/断开、`lastError`、token 是否拿到、本机显示记录条数、说明「记忆在服务器」 |
| `~966` | `pet_forget`：remote 模式清空本机显示记录，并明确回执「服务器记忆没删」 |
| 文件头 | 文档更新：三种大脑 + remote 的定位 |
| **v1.1** `~247` | 动态 import 加 `mood.mjs?v=`（`describeMood` / `moodActions`） |
| **v1.1** `~257` | 读 `package.json` 的 `version`，`pet_status` 里显示「插件:dsh-coo-pet-remote v0.3.1-remote.1」——热重载后一眼确认拿到的是新代码 |
| **v1.1** `~504–515` | `makeRemoteBrain()` 透传 `moodIntervalMs` / `moodTimeoutMs`（NaN/负数走默认；0 = 不自动刷新） |
| **v1.1** `~591` | 新增 `replyActions()`：remote 模式 `moodActions(brain.mood)`，其它模式保持 `['happy']`；替换 `onUserText` / 互聊 / `pet_talk` 三处回话的 `['happy']` |
| **v1.1** `~902–929` | `pet_status` 加「心情: …」行（`describeMood`；没有数据时「未知（bridge 未提供）」）+ 插件版本行；工具描述同步更新 |
| **v1.2** `~226–236` | 动态 import 加 `figures.mjs?v=` / `pet-settings.mjs?v=`（`scanFigurePacks`/`importFigurePacks`/`settingsFromConfig`/`normalizeSettings`/`resolveSkin`/`decodePageSkin`/`uiPrefsOf`/`skinJsonOf`/`normalizeScaleRange`） |
| **v1.2** `~280–290` | 形象包导入:默认根 `<cooDataRoot>/figures`、`<dataDir>/figures` + 配置 `packsExtraDirs` + 环境变量 `COOPANION_PACK_ROOTS`；`importFigurePacks()` 只读复制到 `WEB_DIR/<pack>/`，坏包/失败只记日志 |
| **v1.2** `~300–490` | DIY 设置机器:`settingsFile` 路径（默认 `<dataDir>/pet-settings.json`）、`scaleRange`(scaleMin/scaleMax)、初始设置（配置 + 旧 skin.json 迁移）、原子写、`applySettings()`（解析→SKIN/PREF、写 skin.json、broadcast `{t:'prefs'}`）、`pullSettings()`（1s 轮询、未知 figure 保留当前、无效值 clamp/忽略 + warning） |
| **v1.2** `~530–560` | 页面回推:`{t:'prefs'}`（音效/走位/主题/双击…）→ 合并进设置 + 落盘 + 广播；换装页 `POST /api/skin` → `decodePageSkin` → 设置 + skin.json |
| **v1.2** `~565` | `snapshot()` 从 `PREF` 取 scale/bubbleSize/fontSize/bubbleSpeed/glow/theme/roam/sound/hoverButtons/doubleClickChat/frameRate/lockFrameRate + `skin`（页面形状） |
| **v1.2** `~1020–1030` | 生命周期:启动后 `startSettingsWatch()`；插件卸载时 `stopSettingsWatch()`（清 1s 轮询） |
| **v1.2** `pet_status` | 新增「外观:figure=… 各轴=… scale=…」「界面:scale/bubble/glow/…」「形象包:N 个 [ids]」「DIY 设置:<路径>」四行摘要 |
| **v0.4.1** `~100` | 新增导出 `resolveBridgeTokenFile(value, dataDir)`：绝对 / 相对 dataDir / `~` / 空；`makeBridgeTokenReader` 支持它 + 环境变量 `DSH_COO_PET_BRIDGE_TOKEN_FILE` |
| **v0.4.1** `~292` | `petExe` / `cooDataRoot` 对空字符串友好（`''` → 从 `cooRoot` 推导，不再写死路径） |
| **v0.4.1** `~560` | 启动日志打印 token **来源**（不打印 token 本身）；没配置时给「先跑 bridge 生成 token，再配 bridgeTokenFile/bridgeToken/env」的清晰 warn |
| **v0.4.1** `pet_status` | remote 且没配 token 来源时多一行「bridge 配置:还没设置 bridgeToken / bridgeTokenFile —— …」 |

**`cordis.patch.yml`** —— 默认值改成 remote；**部署相关路径一律留空/自动探测**（分发版不写死任何本机路径）：

```yaml
- insert:
    - id: dsh-coo-pet-remote          # id 必须全局唯一且与包名一致（DSH 安装契约）
      name: dsh-coo-pet-remote
      config:
        autoStart: true
        brain: remote
        bridgeUrl: 'http://127.0.0.1:47891'
        bridgeSessionId: pet-local    # 只是 bridge 那端的会话 id，按需改
        bridgeTimeoutMs: 240000
        moodIntervalMs: 60000         # v1.1：心情刷新间隔(0 = 只在挂载时刷一次)
        moodTimeoutMs: 5000           # v1.1：GET /mood 超时
        skin: { figure: whale, scheme: harness, outfit: maid }  # v1.2:只用来生成初始 pet-settings
        scale: 2                      # v1.2:初始大小
        scaleMin: 0.5                 # v1.2:允许范围
        scaleMax: 3
        chatRounds: 3
        # ---- 以下默认留空 = 自动探测 / 用默认位置；需要时再填 ----
        # cooRoot: '<your Coopanion install dir>'
        # petExe: '<your Coopanion install dir>/Coopanion.exe'
        # cooDataRoot: '<your Coopanion install dir>/data'
        # dataDir: '<your data dir>'                 # 空 = $DSH_HOME/dsh-coo-pet
        # bridgeToken: '<bridge token>'
        # bridgeTokenFile: '<path to bridge token file>'  # 绝对 / 相对 dataDir / ~
        # packsExtraDirs: ['<extra figure pack root>']
        # settingsFile: '<path to pet-settings.json>'
```

**`lib/pet-server.mjs`（+12/−26）**：
- `figures()` 从「写死只读 `web/whale/figure.json`」改成 `scanFigurePacks(webDir).packs` ——
  内置 `coo`/`whale` + 所有复制进来的用户/Workshop 包都出现在 `/api/figures`；
- `/api/figures/status` 的 `problems` 现在真的列出「web 下有 figure.json 但解析失败」的包
  （另加 `packs` 计数），`importable`/`max`/`depth` 字段保持不变（换装页兼容）。

**`package.json`**：
- 包名 `dsh-coo-pet` → **`dsh-coo-pet-remote`**，版本 `0.2.1` → `0.3.0-remote.1`（v1 远程大脑）→
  `0.3.1-remote.1`（v1.1 心情）→ `0.4.0-remote.1`（v1.2 多形象包 + 桌宠 DIY）→
  **`0.4.2-remote.1`（通用/可分发版：默认无本机路径、配置自动探测、token 缺失有提示）**
  （理由：bundle entry id 必须与包名一致且全局唯一；也避免以后官方包装进来时两份同名冲突）；
- `scripts.test` / `test:remote` 指向五个测试文件（brain-remote / mood / pet-diy / distribution / impl-remote）；
  `files` 加 `REMOTE-BRAIN.md`、`INSTALL.md`、`DISTRIBUTION.md`、`LICENSE`；
- `dsh.bundle.patch`、`exports`、`peerDependencies`、`engines.node >= 22.13` 全部保持。

### 2.3 完全没改的文件（升级上游时不用重打补丁）

`lib/index.js`、`lib/ws.mjs`、`lib/assets.mjs`、`lib/coo.mjs`、`lib/brain.mjs`、
`lib/brain-session.mjs`、`NOTICE`、`LICENSE`、`dev/`（除新增探针）。
`lib/pet-window.mjs` 只改了一处：`DEFAULT_EXE` 由上游作者的硬编码路径改成空串（由 `impl.js`
从 `cooRoot` 推导后传入，分发版不内置任何路径）。
`README.md` / `README.zh-CN.md` 只在顶部加 fork 说明 + 把示例路径换成占位。

### 2.4 通用化 / 分发改造（v0.4.1）

目标：把插件做成**可分发包**，不泄露本机部署隐私；默认配置在任何机器上都成立（或给出清晰提示）。

- **默认值通用化**（`cordis.patch.yml` / `config-bundle/` 模板）：

  | 配置 | 分发版默认 | 说明 |
  | --- | --- | --- |
  | `cooRoot` / `petExe` / `cooDataRoot` | **不写**（自动探测） | `findCooRoot()`：Config → Windows 注册表 → 常见位置 → `COOPANION_HOME`；`petExe` 默认 `<cooRoot>/Coopanion.exe`，`cooDataRoot` 默认 `<cooRoot>/data` |
  | `dataDir` | 不写 → `$DSH_HOME/dsh-coo-pet` | 数据在插件包外，升级不删；不再钉在某个工作区 |
  | `bridgeTokenFile` | **不写**（未配置） | 支持绝对路径 / **相对 dataDir** / `~/...`；也认环境变量 `DSH_COO_PET_BRIDGE_TOKEN_FILE`；或直接给 `bridgeToken` |
  | `bridgeUrl` / `bridgeSessionId` | `127.0.0.1:47891` / `pet-local` | 协议默认值，按需改 |
  | `settingsFile` / `packsExtraDirs` | 不写（派生默认） | `<dataDir>/pet-settings.json` / `<cooDataRoot>/figures` + `<dataDir>/figures` + `COOPANION_PACK_ROOTS` |
  | `brain` | `remote`（保留原行为） | 可改 `local` / `session`（不需要 bridge） |

- **首次安装体验**：remote 模式但没配 token 来源时——
  - 启动日志 warn：`还没配置 bridge token:请先运行 bridge 并生成 token…`（说明 `bridgeTokenFile`/`bridgeToken`/环境变量三种配法）；
  - `pet_status` 增加一行 `bridge 配置:还没设置 bridgeToken / bridgeTokenFile —— …`；
  - 说话时气泡报「还没拿到 bridge token…」；其它窗口/换装/DIY 功能不受影响。
- **代码**：
  - `lib/impl.js` 新增导出 `resolveBridgeTokenFile(value, dataDir)`（绝对 / 相对 / `~` / 空），
    启动时把 token **来源**打进日志（不打印 token 本身）；
  - `petExe`/`cooDataRoot` 对空字符串友好（`''` → 从 `cooRoot` 推导）；
  - `lib/pet-window.mjs` `DEFAULT_EXE` 清空（必须由上层传入，或报可读错误）；
  - `lib/brain-remote.mjs` 的错误提示不再引用本机目录，改为「见 bridge 的启动说明」。
- **本地配置模板**：`config-bundle/` 改成**模板**（只含通用默认 + `<PLACEHOLDER>` 注释），
  本机部署相关的值由使用者复制到**不会随包发布**的目录里再安装；它不在 `package.json files` 白名单里。
- **自查**：`test/distribution.test.mjs` 自动 grep 发布白名单/源码/模板里的私有值
  （本机盘符、用户名、服务器 IP、SSH 私钥名、角色卡名、QQ 号/会话 id、部署用户名/目录），
  并校验默认 patch 不写死部署字段、打包白名单不含 test/dev/config-bundle。
- 打包方式与注意见 [DISTRIBUTION.md](DISTRIBUTION.md)。

### 2.5 v0.4.2 修复：导入新形象包后不重扫（真机 bug）

**现象**：面板通过 ZIP 导入新 pack（落盘到 `web/<id>/`、面板也能列出）→ 保存 `pet-settings.json` 选它 →
插件仍显示旧 pack、`pet_status` 的「形象包」列表不变。

**根因**：`reloadPacks()`（重新扫 `web/*/figure.json` 的入口）只在
`normalization.warnings` 包含**字面量**「未知形象包」时触发；T22 之后 warning 文案改成了
「不是已安装的形象包…」，条件永远不成立 —— 文案成了逻辑开关。

**修复**：
- 新增 `ensurePackKnown(figure)`：语义判断 —— `figure` 不在当前 `PACKS` 就先 `reloadPacks()`，再判一次；
- 用在所有入口：启动 normalize 前（settings / 旧 skin.json / Config 的 figure）、settings 轮询、
  `applySettings()`（此时丢弃按旧 PACKS 传进来的 resolved 结果，重算）、换装页 `/api/skin` 保存；
- 保险层：重扫后仍找不到 → **保留当前 figure + warn**（不悄悄回退 whale），不影响已加载的包；
- 删掉所有「按 warning 文案触发重扫」的代码；单测覆盖「zip 落盘 → 保存 figure → 1s 内自动重扫采用」
  与「重扫后仍未知 → 保留当前」。


> `lib/index.js` 的薄壳 + 动态 import 设计正好帮了大忙：`impl.js` 和 `brain-remote.mjs` 都是
> `?v=<时间戳>` 动态加载的，改完文件重载插件就生效，**不用重启 DSH**。

---

## 3. `brain-remote.mjs` 设计要点

### 3.1 接口（和另两个后端对齐，`impl.js` 上层无感）

| 成员 | 语义 |
| --- | --- |
| `busy: boolean` | 上一句没 `final` 前为 true；`say` 期间再调直接抛「桌宠还在想上一句」 |
| `history: {role,text}[]` | 最近 40 条，**只用于 `pet_status` 显示个数**；真正记忆在服务器 |
| `sessionId: string` | bridge 另一端的会话 id（默认 `pet-local`，可配），只用于显示 |
| `connected: boolean` | 加给 `pet_status` 用：WS 现在通不通 |
| `lastError: string \| null` | 加给 `pet_status` 用：最近一次连接错误 |
| `say(text, {note?, signal?}) => Promise<string>` | 发一轮，等到 `final`，返回正文 |
| `forget()` | 只清本机 `history`；日志与 `pet_forget` 回执都说明「服务器记忆没删」 |
| `stop(): Promise<void>` | 卸载时：清重连定时器、失败在等的那句、关连接，不再重连 |
| `onDelta(fullText)` | 构造参数；每次 `delta` 后回调**累积后的全文**（与 `brain.mjs`/`brain-session.mjs` 的约定一致） |
| `chatUrlOf(bridgeUrl, token)` | 导出工具：`http/https` → `ws/wss`，path 保留，token 进 query |
| **v1.1** `mood: object \| null` | 最近一次 `GET /mood` 的心情快照；没刷到/失败过就是 `null`（或保留的旧值） |
| **v1.1** `moodLastError: string \| null` | 最近一次心情刷新失败原因（`HTTP 500` / `超时` / `返回的不是 JSON`…），`pet_status` 在从未拿到心情时附带显示 |
| **v1.1** `refreshMood() => Promise<object \| null>` | 手动刷一次；**永不 reject**，失败保留旧值；并发调用合并 |
| **v1.1** `moodIntervalMs` / `moodTimeoutMs` | 构造参数：刷新间隔（默认 60000，0 = 不自动刷）/ 单次超时（默认 5000） |
| **v1.1** `onMood(mood)` | 构造参数；刷到新快照时回调（探针/调试用） |
| **v1.1** `httpBaseOf(bridgeUrl)` | 导出工具：`ws/wss/http/https` → HTTP(S) 根地址（`GET /mood` 用） |

### 3.2 协议实现（对应 BRIDGE-PROTOCOL §4）

- **发**：`{"type":"say","requestId":"<uuid>","text":"..."}`；`requestId` 用 `node:crypto.randomUUID()`。
- **收**：`accepted`（记日志）→ `delta`（累积，`requestId` 匹配才收）→ `final`（取 `frame.text`，缺省用累积文本）；
  `error` → reject(`bridge 说:<message>(<code>)`)。
- **串行**：本端 `busy` 先挡（bridge 也会挡，但别把主人的话丢在半路）。
  `say` 在**连接 bridge 之前**就置 `busy`（上游两个后端没有前置 await，所以没这个窗口；
  远程模式连 WS 要时间，不提前置 busy 的话两个并发调用会一起挤进来、后一个覆盖 `pending`）。
- **超时**：默认 240000ms（与 bridge 的 `requestTimeoutMs` 同量级）；超时后该 `requestId` 作废，
  迟到帧按 `requestId` 丢弃，不会串到下一句。
- **取消**：`signal` abort → 当前句 reject（**不会**去取消服务器 turn，协议里 bridge 也不这么做）。
- **`note` 怎么处理**：远程模式没有 system 通道，旁注只能拼进 user 消息（`note\n\ntext`），
  和上游 `brain-session.mjs` 的策略一致；`impl.js` 的 `scrubEcho()` 负责把可能被复述的旁注剥掉。
  代价是它会长在服务器会话上下文里（见 §6 限制 2）。
- **token 懒读**：`bridgeToken` 既可以是字符串也可以是函数；`impl.js` 传的是"读 token.txt"的函数，
  每次建连才读，读到就缓存 → bridge 晚于 DSH 启动也能接上，bridge 轮换 token 后重载插件即生效。
- **长连接 + 重连**：断线后 500ms → 1s → 2s → … → 30s 指数退避重连（定时器 `unref`，不拖住 DSH 退出）；
  下一句 `say` 会主动取消退避、立即重连（主人刚开口时干等 30 秒最难受）。
  连接中途断掉时，正在等的那句明确失败（bridge 不会因此取消服务器 turn，收不回来）。
- **URL 构造**：`http://127.0.0.1:47891` → `ws://127.0.0.1:47891/chat?token=<urlencoded>`；
  支持 `https/wss` 与带子路径的地址。

### 3.3 `impl.js` 接线

```
brain: remote ──► makeRemoteBrain() ──► RemoteBrain
   │                                     ▲ bridgeUrl / bridgeToken(函数) / sessionId / timeoutMs
   │                                     ▲ moodIntervalMs / moodTimeoutMs(v1.1)
   ├─ 不等 sessionController(省 10 秒)
   ├─ 不挂 tools.guard(工具边界在服务器 preset)
   ├─ brainSay 失败不降级 → 记 warn 日志 + 气泡报可读错误
   ├─ pet_status 显示 bridge 连接状态/服务器会话/记忆归属/心情 + 插件版本
   ├─ replyActions():remote 按 brain.mood 挑气泡动作,local/session 仍是 happy
   └─ pet_forget 只清本机显示记录(回执说明)
brain: local / session 仍是上游原逻辑(session 失败降级 local 的行为保留)
```

### 3.4 心情联动（v1.1）

**数据从哪来**：bridge v1.1 的 `GET /mood`（由 bridge 项目在远端**只读**导出心情快照；本插件只消费结果，不关心其内部实现）：

```json
{"ok": true,
 "mood": {"label":"开心·有精神","valence":0.321,"arousal":0.512,"energy":"有精神",
          "memoryCount":5,"selfNote":"…","updatedAt":1793189156878,
          "source":"deep-soul:mind.db(readonly)"},
 "meta": {"enabled":true,"intervalMs":60000,"lastRefreshAt":1793189…,"tookMs":812,"lastError":null}}
```

- `energy` 是**字符串**（`有精神` / `平常` / `懒洋洋`），不是数值；`label` 是 bridge 拼好的复合标签
  （`开心` / `低落` / `平静`，可能带 `·有精神` / `·懒洋洋` 后缀）。「标签优先、数值兜底」。
- `mood` 可能是 `null`（deep-soul 没数据 / bridge 刷新失败）→ 插件显示「未知（bridge 未提供）」，
  **不影响聊天**：`/chat`(WS) 与 `/mood`(HTTP) 是两条独立的路。
- **2026-10-28 对真实 bridge 的只读实测**（`/mood` 上线后，`curl /mood` + 用本模块解析，未发聊天）：
  返回 `{"ok":true,"mood":{"label":"平静·懒洋洋","valence":0,"arousal":0,"energy":"懒洋洋",
  "memoryCount":5,"selfNote":"我很在意自己的名字","updatedAt":1793189100648,…},"meta":{…}}`
  → `pet_status` 心情行「心情: 平静·懒洋洋（valence 0.00 / arousal 0.00，记忆 5 条）」→ 气泡动作 `sleepy`。

**插件怎么用**：

1. 挂载时立刻刷一次，之后每 `moodIntervalMs`（默认 60s）刷一次；普通 HTTP GET，单次超时 5s（可配）。
2. 刷新失败**静默保留旧值**（`moodLastError` 记原因），不抛错、不阻塞聊天；bridge 没起时只是每 60s 白试一次。
3. `stop()`（插件卸载/热重载）会停定时器并 abort 在飞的请求 —— disable→enable 不会留下双份轮询。
4. `pet_status` 输出：`心情: 开心·有精神（valence 0.72 / arousal 0.80，记忆 5 条）`；
   从未拿到过：`心情: 未知（bridge 未提供）`；local/session 大脑：`心情: 不适用（local/session 大脑不查 bridge 心情）`。
5. 气泡动作：回话（双击输入 / `pet_talk` / 互聊）时用 `moodActions(brain.mood)` 挑动作；
   问候、报错、`pet_say` 显式指定的动作保持不变。

**可用 action 集合（重要）**：动作名必须是形象包 `web/whale/figure.json` 的 `vocab` 里的词
（页面 `pet-app.js` 的 `body.do(word)` 只认这些；实测来源 `<dataDir>/web/whale/figure.json`，共 38 个）：

```text
neutral happy wink love shy surprised angry sad sleepy thinking smug pout worried determined
flustered scared excited cry confused stand jump hop look turn nod shake spin sit sleep dizzy
walk run wave bow shiver flap dance
```

心情映射**只用其中「脸部表情」子集**（`lib/mood.mjs` 的 `SAFE_MOOD_ACTIONS`，16 个）：
`neutral happy wink love shy surprised angry sad sleepy thinking smug pout worried excited cry confused`
—— 说话时突然 `walk / jump / sit / sleep / dizzy` 会显得莫名其妙，所以不用。
（映射逻辑有单测兜底：任何输入都只可能产出这 16 个词之一。）

映射规则（`moodActions`，标签 → 数值 → 默认）：

| 心情 | 气泡动作 |
| --- | --- |
| bridge 复合标签 `开心` / `开心·有精神` | `happy` / `excited` |
| `低落`（含 `·有精神` / `·懒洋洋`） | `sad` |
| `平静` / `平静·有精神` / `平静·懒洋洋` | `neutral` / `neutral` / `sleepy` |
| 其它中英标签（`难过`→sad、`焦虑`→worried、`害羞`→shy、`喜欢`→love、`好奇`→thinking…） | 见 `lib/mood.mjs` 的 `LABEL_RULES`（具体词排在泛化词前） |
| 无标签、有数值 | `valence <= -0.25 → sad`；`valence < 0.15 → neutral`（低 `energy` → sleepy）；
  正面：高 `arousal`(>=0.7) → excited、低 `energy` → sleepy，否则 happy |
| 什么都没有 | `['happy']`（和上游默认一致） |

---

## 3.5 桌宠 DIY：多形象包 + 实时设置（v1.2）

### 3.5.1 形象包（figure pack）

一个 pack = 一个含 `figure.json` 的目录（页面按 `base + entry` 加载 body、按 `axes` 渲染换装选项）。
本插件在启动时把三类来源统一收进 `dataDir/web/<packId>/`，然后 `/api/figures` 扫描 `web/*/figure.json`：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| Coopanion 内置 | `web/whale`（大肥鱼）、`web/coo` | 随 `ensureAssets` 整个 `web/` 复制，无需额外配置 |
| Coopanion 用户包 | `<cooDataRoot>/figures/<id>/figure.json` | 默认 `<cooDataRoot>/figures`（装了包就自动生效） |
| 插件数据目录 | `<dataDir>/figures/<id>/` | 默认 `<dataDir>/figures` |
| Steam Workshop / 额外根 | 环境变量 `COOPANION_PACK_ROOTS`（路径分隔符分隔）+ 配置 `packsExtraDirs` | Coopanion 自己也是这么读 Workshop 包的 |

导入规则（`lib/figures.mjs` 的 `importFigurePacks`）：

- **只读复制**，绝不写 Coopanion 安装目录/用户 data 目录；
- 目标 `web/<packId>` **已存在就跳过**（不覆盖换装页正在用的副本）；
- `packId` 取 `figure.json` 的 `id`（不合法回退目录名，再不合法跳过并记 problem）；
- 原生目录里混的普通目录（`i18n/`、`kit/`…没有 figure.json）**不算错误**，直接跳过；
- 任何一个包坏掉/复制失败只记日志，不影响桌宠启动与其它包。

`GET /api/figures`（由 `scanFigurePacks` 生成）返回数组，字段与页面用法一致：

```json
[
  {"id":"whale","base":"/web/whale/","name":{"zh":"DeepSeek 大肥鱼","en":"DeepSeek Chan"},
   "thumb":"thumbs/deepseek.png","entry":"figure.js","export":"createWhaleBody","model":"model.json",
   "axes":[{"id":"scheme","options":[{"id":"deepseek"},{"id":"harness"}, …]},
           {"id":"outfit","options":[{"id":"maid"},{"id":"cape"}, …]}],
   "presets":[{"id":"deepseek","pick":{"scheme":"deepseek","outfit":"maid"}}, …],
   "vocab":[{"id":"happy"}, …],"version":"1.0.0","about":"…"},
  {"id":"coo","base":"/web/coo/","name":{"zh":"Coo","en":"Coo"},"entry":"figure.js","export":"createCooBody",
   "axes":[{"id":"palette",…},{"id":"head",…},{"id":"side",…},{"id":"glasses",…},{"id":"neck",…}],
   "presets":[],"vocab":[…],"version":"1.0.0"},
  {"id":"my-pack","base":"/web/my-pack/", …}
]
```

`GET /api/figures/status` 保持换装页兼容的 `{importable:false,max:0,depth:3,problems:[…]}`，
其中 `problems` 现在会列出坏掉的 pack（`{dir,reason}`）；另附 `packs` 计数。

实际本机（2026-10-28 只读验证）：`whale(scheme×8,outfit×3)`、`coo(palette×12,head×9,side×6,glasses×4,neck×4)`，
`problems=[]`。

### 3.5.2 `pet-settings.json`（单一事实来源）

默认路径 `<dataDir>/pet-settings.json`（配置 `settingsFile` 可覆盖；鲸歌面板「桌宠 DIY」写的就是它）。
**启动时不存在就按配置生成**，之后 impl 每 **1s** 检查文件内容变化，变了就校验并热应用 + 广播，
不需要重启 DSH、不需要重载插件。

```json
{
  "skin": {
    "figure": "whale", "scheme": "harness", "outfit": "maid",
    "palette": "mint", "head": "none", "side": "none", "glasses": "none", "neck": "none",
    "axes": { "color": "blue" }
  },
  "scale": 2, "bubbleSize": 1, "fontSize": 1, "bubbleSpeed": 1, "glow": 7,
  "theme": "dark", "roam": "free", "sound": true,
  "hoverButtons": ["chat", "cooChat"], "doubleClickChat": true,
  "frameRate": 0, "lockFrameRate": true
}
```

| 字段 | 类型/范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| `skin.figure` | 已安装 pack 的 id | `whale` | 未知 id 会被**忽略并保留当前**（不会让你凭空换包） |
| `skin.scheme` / `outfit` / `palette` / `head` / `side` / `glasses` / `neck` | 该 pack 对应轴的 option | pack 默认 | 内置两包：whale 用 scheme+outfit，coo 用 palette+head/side/glasses/neck；`scheme` 也可填 pack 的 **preset id** |
| `skin.axes` | `{<axisId>: <optionId>}` | `{}` | **扩展**：用户/Workshop 包有任意轴时，面板把非固定字段放这里 |
| `scale` | `scaleMin`~`scaleMax`（默认 0.5–3） | 2（配置 `scale`） | 桌宠大小；越界 clamp |
| `bubbleSize` / `fontSize` / `bubbleSpeed` | 0.5–2 | 1 | 气泡大小/字号/打字速度 |
| `glow` | 0–14（取整） | 7 | 桌面光晕 |
| `theme` | `dark` / `light` | `dark` | 明暗 |
| `roam` | `free` / `calm` / `off` | `free` | 页面走位模式 |
| `sound` | bool | true | 音效 |
| `hoverButtons` | 数组，元素 ∈ `chat/voice/roam/theme/sound/hide/dress/cooChat` | `["chat","cooChat"]` | 悬停按钮（非法项被过滤） |
| `doubleClickChat` / `lockFrameRate` | bool | true / true | 双击聊天/锁帧 |
| `frameRate` | 0–60（取整，0=不限） | 0 | 帧率上限 |

**应用语义（`lib/pet-settings.mjs`）**：

- 数值越界 → **clamp** + warning；类型错/枚举非法/未知 hover 项 → **忽略** + warning；
- 文件里**没写**的字段沿用上一份生效设置（hand-edit 半份文件不会把其它设置重置成出厂值）；
  写了但非法 → 尽量保留上一份（`normalizeSettings(...,{fallback})`）；
- 应用后：`SKIN`(页面形状) + `PREF`(界面字段) 进 `snapshot`（新连上的页面）并
  `broadcast({t:'prefs', skin, scale, bubbleSize, …})`（已连页面即时变）；
- 外观真的变了才写 legacy `dataDir/skin.json`（换装页/面板 fallback 读取）；
- 写设置文件是**原子写**（tmp+rename），插件自己只在「启动生成」和「页面/换装页回推」时写，
  并会合并现有字段（不覆盖面板写的其它键）。

**设置 → 页面 skin 的解析规则**（`resolveSkin`，和换装页 `picksOf`/`schemeOf` 一致）：

1. `skin.scheme` 若等于当前 pack 的 **preset id** → 用 `preset.pick` 展开各轴；
2. 否则每个轴取 `skin.axes[axis]` › `skin[axis]` ›（preset 展开）› 该轴第一个 option；
3. 页面 `skin.scheme` = 命中 preset 时用 preset id，否则按 `figure.json` 的 axes 顺序把 option id 用 `-`
   连起来（如 `harness-cape`、coo 的 `mono-cat-none-none-bell`）；
4. coo 这类带 `palette/head/side/glasses/neck` 轴的 pack，这些值也平铺进页面 skin；
5. 反向（换装页 `POST /api/skin`）走 `decodePageSkin`：composed scheme 优先解回各轴，
   兼容旧 `skin.json`（其 `scheme` 是拼好的，旁边 `outfit` 字段可能是 config 旧值）。

**配置项**（`cordis.patch.yml`，都可选）：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `scale` | 2 | 生成初始设置时的 scale |
| `scaleMin` / `scaleMax` | 0.5 / 3 | scale 允许范围（0.1–5 内） |
| `settingsFile` | `<dataDir>/pet-settings.json` | DIY 设置文件路径 |
| `packsExtraDirs` | `[]`（另自动加 `<cooDataRoot>/figures`、`<dataDir>/figures`、`COOPANION_PACK_ROOTS`） | 额外形象包根目录 |

**与外部设置面板（「桌宠 DIY」）的契约**：面板写 `coo-pet-data/pet-settings.json`（合并写、原子写、`.bak`），
插件 ~1s 内应用并广播；面板**不要写** `skin.json` / `web/**`；面板显示优先读 `pet-settings.json`，
`skin.json` 仅 fallback。插件在遇到未知 `figure` 时会**重新导入+重扫**一次 pack（新丢进
`figures/` 的包不用重载插件）。

`pet_status` 会直接给出验证所需摘要：

```text
外观:figure=coo palette=mono head=cat side=none glasses=none neck=none scale=1.2(scheme=deepseek outfit= …)
界面:scale=1.2 bubbleSize=1.3 fontSize=1 bubbleSpeed=1 glow=9 theme=light roam=calm sound=false …
形象包:2 个 [whale, coo] — <realpath>/web
DIY 设置:<realpath>/pet-settings.json —— 改这个文件 ~1s 生效
```

---

## 4. 测试

### 4.1 跑法（node >= 22.13，不需要 npm install）

```bash
cd <this package dir>
node --test test/brain-remote.test.mjs test/mood.test.mjs test/pet-diy.test.mjs test/distribution.test.mjs test/impl-remote.test.mjs
# 或 npm test / npm run test:remote
```

> `test/distribution.test.mjs` 是**分发前自查**：扫描 `package.json files` 白名单 + 源码 + patch +
> config-bundle 模板，确认没有本机盘符/用户名/服务器 IP/SSH 私钥名/角色卡名/QQ 号/部署账号等私有值，
> 并校验默认配置没有写死部署字段。发布前跑一次，等于自动 `grep`。

### 4.2 结果（2026-10-28/29 实测，v1.2 + 分发自查）

```text
# brain-remote(15) + mood(9) + pet-diy(14) + distribution(5) + impl(5) = 48
✔ chatUrlOf / 流式 delta→final / busy / 超时(迟到 final 不串句) / 断线重连 / 并发 busy
✔ bridge error 帧 / 连不上 bridge(token 提示) / forget 只清本地
✔ httpBaseOf / mood 刷新成功 / 自动轮询+stop 清定时器 / HTTP500 保留旧值 / mood:null 404 / /mood 超时
✔ impl.js:remote 端到端(假 ctx + mock bridge,不碰 DSH/Coopanion)
✔ moodActions 默认/标签优先/v1.1 复合标签/数值兜底/只产 vocab 安全词/大小写
✔ describeMood 格式/未提供/memoryCount 字符串与小数
✔ scanFigurePacks 多 pack+排序+坏包 problem+非 pack 忽略;web 不存在不抛错
✔ importFigurePacks 复制到 web/<id>/、已存在跳过、非法 id problem、缺根目录忽略
✔ normalizeSettings 默认值/合法值/越界 clamp/类型与枚举降级/hover 过滤/scale 范围/fallback 保留
✔ resolveSkin whale preset 展开/多轴拼 scheme/coo 槽位/自定义 axes/未知 figure 回退
✔ decodePageSkin composed scheme / preset id / coo / 旧 buildSkin 形状
✔ settingsFromConfig 配置打底+旧 skin.json 迁移 / skinJsonOf 字段与 colors
✔ impl 集成:多 pack `/api/figures`、pet-settings 热应用(scale 1.2 + figure coo)、`{t:'prefs'}` 广播、
   skin.json 兼容写入、无效值降级(scale 99→3、未知 figure 保留当前)、pet_status 外观/形象包摘要
✔ v0.4.1:resolveBridgeTokenFile 绝对/相对 dataDir/~ / 空;相对 token 文件真的能连上 bridge(启动日志有来源);
   缺 token 时启动 warn + pet_status 提示行 + 说话报可读错误(不崩、不假装能聊)
✔ 分发自查:发布白名单/源码/模板无私有值;默认 patch 未写死部署字段;config-bundle 是模板;打包白名单合理
✔ v0.4.2:设置引用「刚导入(zip 落盘)」的 pack → 自动重扫并采用(形象包 2→3、figure 变化、/api/figures 同步);
   重扫后仍未知的 figure → 保留当前 + warn,不丢已加载的包

ℹ tests 48  ℹ pass 48  ℹ fail 0   (~6s)
```

> 真实部署数据目录只读验证（2026-10-28）：扫描 `<dataDir>/web` 得到
> `whale(scheme×8,outfit×3)` + `coo(palette×12,head×9,side×6,glasses×4,neck×4)`、`problems=[]`；
> 用旧 `skin.json`（`scheme:"deepseek-cape"`, `outfit:"maid"` 旧值）做迁移，
> 正确还原成 `scheme=deepseek, outfit=cape`（页面 skin `deepseek-cape`）——「冬装」不会丢。
>
> **部署环境 reload 后的真机实测**（2026-10-28 23:4x，只读 GET，未改设置）：`pet-settings.json` 已按迁移结果生成
> （`figure=whale, scheme=deepseek, outfit=cape`），`skin.json` 被规范化为同内容；
> live `GET /api/figures` → `[whale, coo]`（coo 五轴、两者 vocab 37）、
> `GET /api/figures/status` → `{"importable":false,"max":0,"depth":3,"problems":[],"packs":2}`；
> `GET /api/state` → `scale=2, theme=dark, skin={"figure":"whale","scheme":"deepseek-cape",…}`
> —— v1.2 已在真机生效、旧外观（冬装）无损迁移。

覆盖：v1 的任务要求（**delta→final 流式 / busy 拒绝 / 超时错误 / 重连恢复**）+ 并发/错误/token/forget；
v1.1 的**心情刷新/自动轮询/失败保留旧值/超时/stop 清定时器/文案格式/动作映射（含只产出合法 vocab 词）**；
以及 `impl.js` 端到端（含「假桌宠页面」收 `t:'say'` 帧，断言心情 开心·有精神 → 气泡动作 `excited`）。

另：bridge 的 `/mood` 上线后（2026-10-28 20:30），用**真实 bridge** 做了一次只读解析验证：
`RemoteBrain.refreshMood()` 成功拿到 `平静·懒洋洋`（memoryCount 5），`describeMood` / `moodActions`
输出分别是「平静·懒洋洋（valence 0.00 / arousal 0.00，记忆 5 条）」和 `['sleepy']`；
**没有**发聊天、没有触发 `/mood/refresh`、没有碰服务器。

### 4.3 mock 是怎么造的（为什么可信）

- 不用 npm 包：`test/mock-bridge.mjs` = `node:http` 的 upgrade + 插件自带的 `lib/ws.mjs`
  （零依赖 RFC 6455 **服务端**实现）→ 跑的是**真 WebSocket 握手/分帧**，不是假 socket；
- v1.1 心情：同一个 mock 的 HTTP 侧提供 `GET /mood`，可控制成功 / `mood:null`(404) / HTTP 错误 / 延迟超时
  （`state.mood` / `moodError` / `moodDelayMs` / `moodRequests`），形状对齐 bridge v1.1 的真实返回；
- 客户端用 Node 内置 `WebSocket`（本插件 `coo.mjs` 上游就是这么用的），不需要额外依赖；
- `impl-remote.test.mjs` 用假 Cordis ctx 调用**真实 `setup()`**：临时目录造最小假 Coopanion 素材，
  `autoStart:false`（绝不起窗口），验证工具注册、`pet_talk` 真的经 bridge 说话、bridge 挂了不降级、
  `pet_status` 心情行、**假桌宠页面收到的心气泡动作**（`role=pet&host=window` 的 WS 客户端收 `t:'say'`）等；
- `@deepseek-ai/dsh-tools` 在 DSH profile 外解析不到，用 `#module.register` 的 loader 替身解决；
- v1.2 DIY：`pet-diy.test.mjs` 全走临时目录（造 whale/coo/自定义 pack 的 figure.json），
  不碰真实 `coo-pet-data`；`impl-remote.test.mjs` 在假 Coopanion 素材里也给 coo+whale 两个 pack，
  通过 HTTP `GET /api/figures` / `GET /api/state` + 假桌宠页面 WS 帧验证「写设置 → 1s 内生效 → 广播」；
  没有启动真实 Coopanion/窗口/DSH。

### 4.4 独立探针

```bash
# 自测模块（内置 mock，不需要真 bridge）
"$NODE" dev/remote-probe.mjs --self-test
# [final] 自测通过   [probe] PASS(...)

# 连真 bridge（会真的往 bridge 另一端的会话发一句，别刷屏）
"$NODE" dev/remote-probe.mjs "只回复 OK" --url=http://127.0.0.1:47891
```

---

## 5. 与上游同步 / 升级维护

- fork 里保留了上游的 `.git`（base commit `802d2d3`），直接看差异：
  ```bash
  git -C <this package dir> status
  git -C <this package dir> diff          # 修改文件的完整 diff
  git -C <this package dir> diff --stat
  ```
- **升级上游的推荐步骤**：
  1. 另建干净 clone（或在上游仓库）里 `git pull` 到新版；
  2. 按 §2.2 的**锚点**逐条重打：
     - 搜索 `const brainMode = config.brain === 'session'` → 改成三选一；
     - 搜索 `makeBridgeTokenReader` 所在位置（`resolveDataDir` 之后插入）；
     - 搜索 `两个大脑的接口一致` / `三个后端的接口一致` 附近；
     - 搜索 `let sessionController = ctx.get('sessionController')`（新版可能改了等法）；
     - 搜索 `const fallbackToLocal` / `const brainSay` / `if (brainKind === 'session')` / `pet_status` 里
       `她的大脑:` / `pet_forget`；
     - 动态 import 列表加 `brain-remote.mjs?v=` 与 `mood.mjs?v=`；
     - v1.1 心情：`say()` 之后加 `replyActions()`；`onUserText` / 互聊 / `pet_talk` 三处回话的
       `['happy']` 换成 `replyActions()`；`pet_status` 加心情行与版本行；`makeRemoteBrain()` 透传
       `moodIntervalMs`/`moodTimeoutMs`；
     - v1.2 DIY：`setup()` 里 `ensureAssets` 之后接 `importFigurePacks` + `scanFigurePacks`；
       删 `buildSkin`/`soundOn`，换成 `figures.mjs`/`pet-settings.mjs` 的机器（初始设置、1s 轮询、
       `applySettings`、`startSettingsWatch/stopSettingsWatch`、`onPagePrefs`/`onDressSkin`）；
       `pet-server.mjs` 的 `figures()` 换成 `scanFigurePacks`；
   3. 把新版未改动的文件（§2.3）整体覆盖回来，只保留上面几处改动；
   4. `node --check lib/impl.js && node --test test/brain-remote.test.mjs test/mood.test.mjs test/pet-diy.test.mjs test/impl-remote.test.mjs`；
   5. 上游若自己也实现了 `remote`：优先对齐它的配置名（`bridgeUrl`/`bridgeTokenFile`/`bridgeSessionId`），
      把本 fork 的 `brain-remote.mjs` / `mood.mjs` / `figures.mjs` / `pet-settings.mjs` 当参考实现收进上游 PR（上游是 MIT，允许）。
- **版本号策略**：`0.4.x-remote.N`（当前 `0.4.2-remote.1` = v1 远程大脑 + v1.1 心情 + v1.2 DIY + v0.4.1 分发通用化 + v0.4.2 导入 pack 重扫修复）；
  上游每跟一个版本，把前缀跟到上游 minor（如上游 0.3.x → 我们 0.4.1-remote.2）。
- **不要**把本 fork 发布到 DSH STORE（bundle id/包名与上游不同是刻意的，但仍属个人 fork）。
- `dev/NOTES.md` 仍是上游的踩坑记录（尤其第 1/2/3/4/5/14 条与本次改动相关），继续有效。

---

## 6. 已知限制（装之前先看）

1. **`pet_forget` 不会让她真失忆**：远程模式下记忆在 bridge 另一端的会话/记忆库里，
   本插件没有也不该有删服务器会话的权限。它只清本机显示记录，回执里写明。
2. **旁注（`note`）会进服务器会话上下文**：远程模式没有 system 通道，`note` 只能拼进 user 消息。
   斗嘴/互聊时会多占一点上下文，模型偶尔可能复述（`impl.js` 的 `scrubEcho` 兜底 + 重试）。
3. **bridge 断线时正在等的那句会失败**：bridge 协议里客户端断开不取消服务器 turn，所以那句话的
   结果收不回来；重连后可以重说（服务器可能已经答过一遍，浪费一点 token）。
4. **气泡不是逐字流式的**：`onDelta` 已实现，但上游 `impl.js` 的显示方式是等 `final` 后一次性
   出气泡（上游 `local/session` 也一样）。要做"边想边冒字"得改页面协议，属后续可选项。
5. **remote 不降级**：bridge/服务器都不可用时，她只会报错（气泡一句人话 + 日志），
   不会偷偷变成本地人格。这是刻意的——避免"两个她"。
6. **本机 `history` 不是记忆**：只留 40 条给 `pet_status` 看个数；真正的记忆/角色卡在服务器。
7. **单连接串行**：一个插件实例一条 WS；两个 DSH/两个 Coopanion 同时开不会共享这条连接（也会抢窗口）。
8. **远端侧前置条件**：远端要有对应的桌宠会话（preset 由 bridge 配置）与 bridge 的
   `config.json` 一致；本 fork 只负责本机这半边。
9. **token 轮换**：`bridgeTokenFile` 指向的文件换了内容后，插件需要重载（或重启 DSH）才会重新读；
   读到过一次就一直用缓存。
10. **Coopanion 升级**：本 fork 没有改素材/窗口/补丁逻辑，但仍沿用上游对 Coopanion 版本的敏感性
    （见上游 `dev/NOTES.md` 第 9/11/17 条：升级后跑 `dev/patch-test.mjs`、必要时清 `dataDir/web` 重取）。
11. **数据目录**：默认 `$DSH_HOME/dsh-coo-pet`（含从 Coopanion 复制的素材
    和 100MB+ 的 Chromium 窗口档案）。删掉它 = 丢皮肤/窗口档案，不影响服务器记忆。
12. **`brain: remote` 时 `ctx.llm` / `agentDefaultModel` 用不到**，但 `inject` 仍声明着（上游原样）；
    若某个 profile 没有这些服务，插件照旧起不来（和上游一致，未改）。
13. **心情依赖 bridge v1.1 的 `GET /mood`**：bridge 还是 v1（没有这个路由）时，`pet_status` 显示
    「心情: 未知（bridge 未提供）」，其余功能完全正常；bridge 升级后**重载插件**（或等 60s 下一轮刷新）即可看到。
14. **心情可能过期**：bridge 下线/刷新失败时插件保留最后一次快照（`moodLastError` 记原因），
    所以界面上的心情是「上一次拿到的」，`updatedAt` 暂未显示；bridge 恢复后下一轮刷新自动更新。
15. **`energy` 在 bridge v1.1 是字符串**（`有精神`/`平常`/`懒洋洋`），不是数值；
    数值兜底分支里的 `energy` 阈值只对「第三方 bridge 给了数字」的情况有效，本插件不为它硬造值。
16. **气泡动作只是「表情微调」**：不改形象配色/服装，也不会为心情播专门的动画；动作从 16 个脸部表情里挑，
    而且**只在回话气泡**上用（问候/报错/`pet_say` 显式指定动作不变）。
17. **心情刷新是额外的本机 HTTP 请求**（默认每 60s 一次，127.0.0.1）；bridge 端才是真正读 `mind.db`
    的重活（bridge 端默认也是 60s 一轮只读查询）。嫌频繁可把 `moodIntervalMs` 调大。
18. **DIY 设置只对 remote 无关的部分生效**：外观/大小/主题/走位/音效是**本机页面**的事，和服务器大脑无关；
    换 DSH/Coopanion 窗口尺寸不会变（scale 是页面内形象缩放，不是窗口大小）。
19. **用户 pack 需要合法 `figure.json` 且 option id 要 lowercase-kebab**：页面 `normalizeSkin` 的
    `scheme` 正则只认 `[a-z0-9-]`；option id 里带大写/空格/中文时，页面会退回该 pack 的默认 option。
20. **自定义轴（`skin.axes`）只是数据传递**：页面 `normalizeSkin` 只认 `figure/scheme/palette/head/side/glasses/neck`
    这几个通道，用户 pack 的额外轴由 body 的 `setScheme`（拼进 scheme 的各段）解释 —— pack 的 figure.js
    要自己支持，否则只影响它自己的加载逻辑，不会崩整个页面。
21. **新丢进 `figures/` 的 pack**：插件在遇到「未知 figure」时会自动重新导入+重扫一次；
    但**已经在用的**新 pack 需要在设置里真正引用它一次才会触发（或重载插件）。
22. **`pet-settings.json` 是唯一事实来源**：手改 `skin.json` 不会改变外观（它只是兼容快照）；
    同理旧 `skin.json` 只在 `pet-settings.json` 不存在时才用于生成初始设置。
23. **并发写**：插件与鲸歌面板都会写 `pet-settings.json`（都原子写 + 合并）；极端同时写时**后写者赢**，
    可能丢一次对方的改动（下一次面板保存会再写回）。插件写它只发生在「启动生成」和「页面/换装页回推」。
24. **形象包复制是启动时行为**：`<Coopanion data>/figures` 里新增/删除 pack 不会实时反映到 `web/`
    （已复制的不会删；删除 pack 后 web 里的旧副本仍在 → 用 `DataDir` 清理或重载插件）。
25. **`scale` 影响的是页面内缩放**：范围由 `scaleMin/scaleMax`（默认 0.5–3）限制，超出会被 clamp。

---

## 7. 安全边界（本次交付遵守的约束）

- 只改本插件目录（上游源码的 fork），没有改 Coopanion / bridge / DSH profile；
- **没有**安装插件、**没有**改本机 profile / `cordis.patch.yml` / `~/.dsh`；
- **没有**启动 Coopanion、**没有**启动桌宠窗口（集成测试用假 Coopanion 目录 + `autoStart:false`）；
- **没有**触碰远端环境（不 SSH、不 prompt、不读写会话）；远端侧的 preset/会话部署不在本包范围内；
- 测试时的 bridge 全是进程内 mock（127.0.0.1 随机端口），用完即关；
  v1.1 的 `GET /mood` 也走 mock，**没有**去连正在跑的真实 bridge / 远端（格式按 bridge 项目的
  `/mood` 实现对齐；真实联调在部署环境完成）；
- 插件运行期写入范围仍是上游那两处：`dataDir` + profile 里一个 bundle 记录；
  **不写 Coopanion 安装目录**（素材只 `cpSync` 到 dataDir 后在副本上打补丁）；
- v1.2 只读复制用户/Workshop 的形象包（`<Coopanion data>/figures` → `dataDir/web/<pack>`），
  不写来源目录；DIY 测试全在临时目录，真实 `coo-pet-data` 只做过只读扫描/迁移验证
  （本次改造**没有**安装/重载插件、没有启动 Coopanion、没有跑真实 setup）。

---

## 8. 文件清单（本插件包）

```
lib/index.js                 上游未改(薄壳,动态 import)
lib/impl.js                  ★ 改:brain 三选一 / bridge 配置(含 resolveBridgeTokenFile) / 不降级
                             / pet_status(心情+外观+形象包+版本+缺 token 提示) / replyActions / pet_forget
                             / v1.2 DIY 设置机器(轮询/应用/广播/换装页回写)
lib/brain-remote.mjs         ★ 新:远程大脑(WS 客户端 + v1.1 心情轮询)
lib/mood.mjs                 ★ 新(v1.1):心情 → 文案 / 气泡动作(纯函数,16 个安全动作白名单)
lib/figures.mjs              ★ 新(v1.2):形象包扫描/导入(多来源、坏包降级)
lib/pet-settings.mjs         ★ 新(v1.2):pet-settings 校验 / 设置↔页面 skin 解析 / skin.json 兼容
lib/brain.mjs                上游未改(local 大脑)
lib/brain-session.mjs        上游未改(session 大脑)
lib/pet-server.mjs           ★ 改:`figures()` 扫描多 pack;/api/figures/status 列出坏包
lib/pet-window.mjs           ★ 微改:DEFAULT_EXE 清空(由 cooRoot 推导,默认不内置路径)
lib/assets.mjs               上游未改(复制来的 web 由 figures.mjs 追加用户 pack)
lib/coo.mjs                  上游未改(Coo 控制台通道)
lib/ws.mjs                   上游未改(零依赖 WS 服务端,测试复用)
cordis.patch.yml             ★ 改:通用默认(brain: remote + bridge*/mood*/scale 等);部署路径全部不写(#占位)
package.json                 ★ 改:包名/版本(0.4.2-remote.1)/test/test:remote/files
test/                        ★ 新:mock bridge(含 /mood) + 5 个测试文件(含 distribution 自查) + dsh-tools 替身
config-bundle/               ★ 新:本地配置覆盖模板(+README),填占位后用,**不随包发布**
dev/remote-probe.mjs         ★ 新:独立探针(--self-test 可离线自测;token 走参数/env)
dev/*.mjs, dev/NOTES.md      上游未改(不随包发布)
REMOTE-BRAIN.md              本文件(原理/限制)
INSTALL.md                   安装/验收/卸载/热重载(通用版)
DISTRIBUTION.md              分发/打包/发布前自查(通用版)
README.md / README.zh-CN.md  上游原文档 + 顶部 fork 说明(大脑/心情/DIY 部分以本文件为准)
LICENSE / NOTICE             上游(MIT)与第三方声明
```
