# deep-coo-cloud 插件包 — 安装说明

> deep-coo-cloud（本包由 `pack/pack.mjs` 构建生成；构建时已对源码脱敏，**不包含任何真实服务器 IP、域名、QQ 号、本机路径、SSH 私钥或 token**。
> 首次使用请在「设置 → 通用/连接」或 `config.json` 里填入**你自己的**配置。

## 包含组件

| 目录 | 说明 | 必需 |
| --- | --- | --- |
| `deep-coo-cloud/` | DSH Web UI 插件：deep-coo-cloud 面板（默认侧栏名「鲸歌」：聊天 / 总控台 / 设置 / Coo 市场 / 桌宠 DIY） | ✅ |
| `bridge/` | 本机桥接服务：连你的 DSH 服务器、提供人格会话/情境/心情/市场代理 | ✅（要用服务器人格时） |
| `dsh-coo-pet-remote/` | Coo 桌宠插件（可选；把 Coo 桌宠接到服务器人格） | 可选 |
| `context-observer/` | 本机情境观察器（前台窗口 / 本机 DSH 活跃会话 → bridge） | 可选 |
| `server/` | 服务器侧共享情境注入插件 + 同步器（部署到你的 DSH 服务器） | 可选 |

## 前置条件

- Windows（本机） + DeepSeek Harness（DSH）0.2.x
- 可选：一台 Linux 云服务器（跑 DSH，用作人格大脑）、Coopanion（桌宠窗口/素材）
- Node.js ≥ 22（DSH 自带 node 也可）
- ssh 客户端（连你的服务器）

## 一、安装鲸歌面板（必需）

1. 把 `deep-coo-cloud/` 放到任意目录，例如 `D:\dsh-plugins\deep-coo-cloud`。
2. 在 DSH 里安装该 bundle：
   ```
   plugin_manager install_bundle target="link:D:/dsh-plugins/deep-coo-cloud"
   ```
   （或在 DSH 插件设置里选择该目录）
3. 刷新 DSH 页面 → 左侧栏出现「鲸歌」；打开后可在「设置 → 通用/连接」修改：
   - 左侧栏名称、面板标题
   - 桥接地址（默认 `http://127.0.0.1:47891`，与下方 bridge 对应）
   - 服务器 SSH（`user@host`，留空则禁用「应用到服务器」等 SSH 功能）
   - QQ 预览白名单（`private:<QQ号>` / `group:<群号>`，留空=不预览；扩展与隐私相关）

## 二、启动 bridge（必需，用于服务器人格/情境/市场）

1. 复制 `bridge/config.example.json` 为 `bridge/config.json`，填写：
   - `host`：你的服务器地址（IP 或域名）
   - `user`：SSH 用户名（如 `root`）
   - `keyPath`：SSH 私钥路径
   - `sessionId`：服务器上的 DSH 会话 id（默认 `pet-local`）
   - `roleCardPath`：服务器上角色卡路径
2. 在本机运行：
   ```
   node bridge/server.mjs
   ```
   首次启动会生成 `bridge/token.txt`。
3. 可选登录自启：运行 `bridge/install-autostart.cmd`。

## 三、可选组件

- **桌宠**：把 `dsh-coo-pet-remote/` 用 `plugin_manager install_bundle link:<目录>` 安装；在插件配置里填 `bridgeTokenFile`（指向 `bridge/token.txt`）与 `cooRoot`（自动探测不到时）。
- **本机情境**：把 `context-observer/` 放好，按 README 配置后运行 `start-observer.vbs`；会通过 bridge 提供前台窗口/DSH 会话给服务器人格。
- **服务器情境注入**：把 `server/awareness-bundle/` 安装到你的服务器 DSH profile（见 `server/PHASE5-AWARENESS.md`/`SETUP.md`），并把 `server/awareness/local-sync.mjs` 配成每 30s 同步。

## 四、Coo 市场（可选）

面板「Coo 市场」可浏览/下载 Coo 社区 Cortico 扩展（npm 包），下载到本机由你自行审查；扩展需在 Coopanion 中安装运行，本插件不执行第三方代码。

## 五、隐私与安全

- 本包不含任何真实服务器 IP/域名/QQ/路径/SSH key/token；`dist/privacy-report.txt` 是构建时的隐私扫描结果。
- 运行时会产生的文件（`bridge/config.json`、`bridge/token.txt`、各组件 `logs/`、`state.json`、下载的扩展）都属于你本机数据，请勿随包分发。
- 服务器侧：`server/` 里所有路径/QQ 白名单都要按你的环境改；不要在公开仓库提交你的配置。

## 六、卸载/回滚

- 面板：`plugin_manager remove_bundle deep-coo-cloud`
- 桌宠：`plugin_manager remove_bundle dsh-coo-pet-remote`
- bridge/observer：删除目录 + 移除登录自启（`uninstall-autostart.cmd`）
- 服务器插件：按 `server/PHASE5-AWARENESS.md` 回滚说明
