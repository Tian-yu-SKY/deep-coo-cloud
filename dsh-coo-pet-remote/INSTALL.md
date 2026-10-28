# 安装 / 验收 / 卸载 / 热重载 —— `dsh-coo-pet-remote`（通用分发版）

> 本文件是**通用安装说明**（不包含任何某台机器的路径/服务器/账号信息）。
> 改了什么、原理与已知限制见 [REMOTE-BRAIN.md](REMOTE-BRAIN.md)；打包/分发注意见 [DISTRIBUTION.md](DISTRIBUTION.md)。
> **当前版本：`0.4.1-remote.1`。**

---

## 0. 前置条件

| # | 依赖 | 说明 |
| --- | --- | --- |
| 1 | **DSH**（DeepSeek Harness，桌面版或 Web 版） | 插件以 bundle 形式挂进某个 profile；node >= 22.13 |
| 2 | **Coopanion** | 桌宠窗口与页面素材都来自它（插件只**复制**素材到自己的数据目录，不写安装目录） |
| 3（仅 `brain: remote`） | **bridge** | 一个本机服务，负责连远端 DSH 并把对话转成 WebSocket。它由 bridge 项目单独部署；本插件只连它的 `bridgeUrl`，不包含/不启动它 |
| 4（仅 `brain: remote`） | **bridge token** | bridge 启动时会生成 token；把它配置给插件（三种方式见 §2.2） |

> 不想用 remote 也可以：把 `brain` 改成 `local`（插件内自建会话，只调 DSH 的 llm）或
> `session`（本机 DSH 的独立会话）——这两种模式不需要 bridge/Coopanion 以外的任何东西。

---

## 1. 安装

任选一种（都通过 DSH 的插件机制，**不要**手改 profile 的 `cordis.patch.yml`）：

**A. 从包目录 / tarball 安装（推荐给自建分发）**

```text
plugin_manager { action: "install_bundle", target: "file:<解压或克隆出来的插件目录>" }
# 或
plugin_manager { action: "install_bundle", target: "link:<插件目录绝对路径>" }
```

**B. 从 npm/registry 安装**（如果你把它发布到了自己的源）

```text
plugin_manager { action: "install_bundle", target: "dsh-coo-pet-remote" }
```

**C. 命令行**（等价）

```bash
dsh plugin --profile <profile> add link:<插件目录>
# 或 dsh plugin --profile <profile> add dsh-coo-pet-remote
```

装完确认：

- `plugin_manager { action: "list_bundles" }` 能看到 `dsh-coo-pet-remote`；
- profile 的 `package.json` 里 `dependencies` 有它、`dsh.profile.bundles` 有 `"dsh-coo-pet-remote"`；
- 若 `dependencies` 写了但 `bundles` 没写（pnpm 偶发 EPERM）：
  `plugin_manager { action: "set_bundle", target: "dsh-coo-pet-remote", enabled: true }`。

> **本机部署相关配置**（Coopanion 装在哪、dataDir 放哪、bridge token 在哪）**不要**写进发布物；
> 用「同 id 覆盖」的本地配置 bundle 注入（模板见 `config-bundle/`，说明见其 README）。
> 不装覆盖层也完全可以：插件默认自动探测，缺什么会在日志/`pet_status` 里明确告诉你。

---

## 2. 配置

### 2.1 默认值（分发版）

插件自带 `cordis.patch.yml` 里只有通用默认值，**没有任何本机路径**：

```yaml
brain: remote
bridgeUrl: 'http://127.0.0.1:47891'
bridgeSessionId: pet-local
bridgeTimeoutMs: 240000
moodIntervalMs: 60000
moodTimeoutMs: 5000
scale: 2
scaleMin: 0.5
scaleMax: 3
skin: { figure: whale, scheme: harness, outfit: maid }
chatRounds: 3
# 下面这些「不写」= 自动探测 / 默认位置；需要时再填（注意是注释，不要在发布物里写死）：
# cooRoot / petExe / cooDataRoot / dataDir / bridgeToken / bridgeTokenFile / packsExtraDirs / settingsFile
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `cooRoot` / `petExe` / `cooDataRoot` | 自动探测 | Config → Windows 注册表 → 常见安装位置 → 环境变量 `COOPANION_HOME`；`petExe` 默认 `<cooRoot>/Coopanion.exe` |
| `dataDir` | `$DSH_HOME/dsh-coo-pet` | 她的数据（素材副本、DIY 设置、皮肤、窗口档案）。在插件包外，升级不会删 |
| `bridgeTokenFile` | 未配置 | 支持绝对路径、**相对 dataDir**、`~`；也可直接用 `bridgeToken`，或环境变量 `DSH_COO_PET_BRIDGE_TOKEN_FILE` |
| `bridgeUrl` | `http://127.0.0.1:47891` | bridge 的本地 HTTP 地址 |
| `bridgeSessionId` | `pet-local` | bridge 那一端给桌宠用的会话 id（只用于显示/对接） |
| `packsExtraDirs` | 派生默认 | 额外形象包根目录（另自动加 `<cooDataRoot>/figures`、`<dataDir>/figures`、`COOPANION_PACK_ROOTS`） |
| `settingsFile` | `<dataDir>/pet-settings.json` | DIY 设置文件（鲸歌面板/换装页/手改都写它，~1s 热应用） |
| `brain` | `remote` | 改 `local` / `session` 可不需要 bridge |

### 2.2 配置 bridge token（remote 模式唯一必须自己填的东西）

先启动 bridge（它会在自己的 tokenFile 里生成 token），然后三选一：

1. **文件路径**（推荐）：`bridgeTokenFile: '<path or relative path to bridge token file>'`
   - 绝对路径，或相对 `dataDir` 的路径，或 `~/...`；
2. **直接给值**：`bridgeToken: '<token>'`（优先于文件）；
3. **环境变量**：`DSH_COO_PET_BRIDGE_TOKEN_FILE=<path>`（Config 没写时兜底）。

没配之前会看到（而不是静默失败）：

- 启动日志 warn：`还没配置 bridge token:请先运行 bridge 并生成 token…`；
- `pet_status` 一行：`bridge 配置:还没设置 bridgeToken / bridgeTokenFile —— …`；
- 说话时气泡：`连不上本机 bridge(…):…还没拿到 bridge token…`。

### 2.3 本机覆盖配置（可选，推荐做）

把 `config-bundle/` **复制到不会随插件发布的位置**，按注释把占位填上（Coopanion 路径 / dataDir /
bridge token 文件），再 `install_bundle` 安装；它必须排在 `dsh-coo-pet-remote` **之后**。
详见 `config-bundle/README.md`。这样升级/换机器只动覆盖包，不改插件包。

---

## 3. 生效 / 热重载

插件是 Host 插件，安装后通常**当场加载**；改了 `lib/*` 后不用重启 DSH，用「disable → enable」即可拿到新代码
（入口是动态 `import(...?v=<时间戳>)`）：

```text
plugin_manager { action: "set_bundle", target: "dsh-coo-pet-remote", enabled: false }
plugin_manager { action: "set_bundle", target: "dsh-coo-pet-remote", enabled: true }
```

（装过覆盖层时：先关覆盖层再关插件，开插件后再开覆盖层；按 bundles 数组顺序。）

**确认版本/状态**：任意会话里让模型调 `pet_status`，应看到：

```text
桌宠窗口 / 气泡连接 / 她的大脑(remote 连接状态) / 外观 / 界面 / 形象包 / DIY 设置 /
心情 / 聊天开关 / 插件:dsh-coo-pet-remote v0.4.1-remote.1
```

只有需要重启的情况：换了包名/bundle id、DSH 自身升级、或 profile 处于半写坏状态。

---

## 4. 验收清单

**基础**

- [ ] 桌宠窗口出现（Coopanion 的透明窗口，可拖拽/甩飞）；`pet_status` 显示窗口在跑、气泡连接通
- [ ] 双击桌宠 → 打字 → 气泡回答；remote 模式下回答来自 bridge 另一端（同一份角色卡/记忆）
- [ ] 断 bridge/断 token：说话气泡报可读错误，**不降级**成本地人格；恢复后自动接回
- [ ] `pet_forget` 回执说明「远端记忆没删」
- [ ] 换装页能打开、保存外观后重载仍在

**remote / bridge**

- [ ] `curl <bridgeUrl>/health` 正常；`curl <bridgeUrl>/mood` 返回 `{ok:true,mood:…}`（缺 `/mood` 时状态显示「心情未知」，聊天不受影响）
- [ ] `pet_status` 的 brain 行显示 bridge 连接状态、token 已拿到、记忆在远端
- [ ] `pet_status` 有「心情: …」行且与 `/mood` 一致；回话气泡动作随心情变

**DIY（v1.2）**

- [ ] `pet_status` 有「外观 / 界面 / 形象包 / DIY 设置」四行；`形象包` 至少 `whale`，装了 Coo 包还有 `coo`
- [ ] 换装页里能切换形象包与各轴（配色/服装/配件）
- [ ] 手改 `<dataDir>/pet-settings.json`（例如 `scale: 1.2`、`skin.figure: "coo"`）→ **约 1s 内**桌面变化；改回也立即恢复
- [ ] 无效值（`scale: 99`、非法 theme、未知 figure）被 clamp/忽略并记 warning，插件不崩
- [ ] 用户/Workshop 形象包放进 `<cooDataRoot>/figures/<id>` 或 `<dataDir>/figures/<id>` 后，重载插件
      能在换装页/`/api/figures` 里看到（`<dataDir>/web/<id>/` 出现只读副本；Coopanion 目录不被写）

**安全/隐私**

- [ ] Coopanion 安装目录未被改写（插件只复制素材到 dataDir）
- [ ] 本机 profile 只多了插件条目；`cordis.patch.yml` 未被手改
- [ ] 发布物里没有本机路径/服务器/账号：`node --test test/distribution.test.mjs` 全 PASS
- [ ] 数据只落在 `<dataDir>`（默认 `$DSH_HOME/dsh-coo-pet`）；没有写插件包目录内

---

## 5. 卸载 / 回滚

1. 先关桌宠窗口（插件还在时）：`pet_window { action: "close" }`；**不要** `taskkill /IM Coopanion.exe`
   （会误杀用户自己那只 Coopanion；pet-host 是 DSH 子进程，DSH 退出会自己退）。
2. 卸载本地覆盖配置（装过才需要）：`remove_bundle` target 你的本地覆盖包名。
3. 卸载插件：`plugin_manager { action: "remove_bundle", target: "dsh-coo-pet-remote" }`；
   确认 profile `dependencies` / `dsh.profile.bundles` 里都没有了。
4. 若代码仍被加载（`pet_*` 工具还在），重启 DSH 使其彻底卸载。
5. （可选）删 `<dataDir>`：只影响本机素材副本/DIY 设置/窗口档案，**远端记忆不受影响**；
   **不要**删 Coopanion 自己的 `figures/`（那是用户形象包源目录，插件只读）。
6. 不需要回滚的地方：Coopanion 安装目录（只读）、bridge（独立进程）、远端 DSH/会话（本插件不改）。

---

## 6. 排障

| 现象 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 启动日志「找不到 Coopanion」 | 没装好 / 装在非常规位置 / 注册表无效 | 装好 Coopanion，或配置 `cooRoot`（路径指向包含 `resources/app/node_modules/cortico-world-desktop-pet` 的目录） |
| 窗口在但画面透明/没有鲸鱼 | Chromium 档案抢 GPU 缓存 | 确认 `CORTICO_COMPANION_DATA` 指向 `<dataDir>`；删 `<dataDir>/pet-window` 重开；查 `[桌宠窗口]` 日志 |
| 说话报「连不上本机 bridge」 | bridge 没跑 / 端口不对 / token 不对 | `curl <bridgeUrl>/health`；核对 `bridgeUrl`；按 §2.2 配 token |
| 说话报「还没拿到 bridge token」 | 没配 `bridgeTokenFile`/`bridgeToken`，或文件不存在/空 | 先启动 bridge 生成 token，再按 §2.2 配；配好后不用重启 DSH（下次连接会重读） |
| `pet_status` 没有「心情:」行 | 还是旧版本代码 | 热重载（§3）；确认版本行 `v0.4.1-remote.1` |
| `心情: 未知（bridge 未提供）` | bridge 端没有 `/mood`（旧版）/ 远端无心情数据 | 升级/重启 bridge；或先不管，聊天不受影响 |
| `pet_status` 形象包只有 1 个 | 旧版本 / web 下没有其他 pack | 热重载；确认 `<dataDir>/web/*/figure.json` 与本机 Coopanion 的 `web/` |
| 用户 pack 不出现 | 放错层级 / `figure.json` 坏 / id 不合法 / `web/<id>` 已存在 | 检查 `<cooDataRoot>/figures/<id>/figure.json` 或 `<dataDir>/figures/<id>/`；`id` 要求 `[a-z0-9][a-z0-9-]*`；看启动日志 `形象包 N 个` 与 `/api/figures/status` 的 `problems`；重载插件 |
| `pet-settings.json` 改了没生效 | 不是合法 JSON / 字段名错 / 值非法被忽略 | 看 DSH 日志 `[桌宠] DIY 设置:` warning；确认 `pet_status` 里「DIY 设置:」指向的就是你改的文件（`settingsFile`） |
| 换装页保存后外观回退 | 设置文件与换装页并发写（后写者赢） | 重新保存一次；或直接手改 `pet-settings.json`（它有合并/校验） |
| 热重载后窗口没回来 | 插件重挂载后窗口需重开 | `pet_window { action: "open" }`；仍不行再考虑重启 DSH |

---

## 7. 硬约束

1. 不手改 profile 的 `cordis.patch.yml`；配置走本地覆盖 bundle 或插件自带 patch。
2. 不安装/不启用上游同名的 `dsh-coo-pet`（两个桌宠会抢窗口与端口）。
3. 不写 Coopanion 安装目录/用户数据（素材与形象包只**只读复制**）。
4. 不要把本机路径、token、服务器信息写进要分发的插件包；发布前跑
   `node --test test/distribution.test.mjs` 自查，并用 `npm pack --dry-run` 确认内容。
5. 不要把填了本机值的 `config-bundle/` 发布/分享（它是本地覆盖模板）。
6. 卸载/回滚按 §5；不要用 `taskkill /IM Coopanion.exe`。
