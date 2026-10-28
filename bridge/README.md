# dsh-link bridge

本机 **零依赖** Node 服务：通过 SSH 隧道把本机客户端（桌宠 / 面板 / CLI）接到远端 DSH 服务器的会话上，
提供 HTTP 与 WebSocket API（对话、历史、事件、情境、心情、总控台聚合）。

> 这是可分发版本：**源码与模板不含任何部署隐私**（主机/IP、SSH 用户、QQ 号、绝对路径、密钥名、token）。
> 真实部署信息只写在运行期的 `config.json`（已被 `.gitignore` / 打包脚本排除）。

---

## 1. 环境要求

- **Node.js ≥ 22**（需要内置 `fetch` 与 WebSocket；Node 24 已实测）。
- **OpenSSH 客户端**（`ssh` 在 PATH；Windows 10/11 自带，Linux 用系统包）。
- 远端（可选）：`python3`（用于只读解析远端 mind.db / QQ 状态文件；不启用相关功能则不需要）。

## 2. 快速开始

```bash
# 1) 进入 bridge 目录
cd dsh-link/bridge

# 2) 复制配置模板并填写（必填字段见下表）
cp config.example.json config.json
#   Windows: copy config.example.json config.json

# 3) 校验配置（缺字段/仍是占位值会给出可读错误，不会崩栈）
node server.mjs --check-config

# 4) 前台启动（调试）
node server.mjs

# 5) 健康检查
curl http://127.0.0.1:47891/health
```

后台常驻：

- **Windows**：双击 `start-bridge.vbs`（无窗口）；或 `start-bridge.cmd`（前台控制台）。
- **自愈守护**：bridge 启动时会自动拉起 `supervisor.mjs`（detached，单实例）。守护每 10s 探一次
  `GET /health`，bridge 崩溃 / 被 taskkill / 卡死无响应时自动重新拉起（默认 ~30s 内恢复）；
  bridge 也会反过来保活守护。日志在 `logs/supervisor.log`。
- **登录自启 + 重启后自动重连**：`install-autostart.cmd`（写入 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-link-bridge.vbs`，
  无需管理员；`uninstall-autostart.cmd` 卸载）。登录后 vbs → bridge → SSH 隧道 → 远端 DSH；
  断网/服务器重启时 SSH 隧道自己有退避重连，物理重启后由登录自启恢复整条桥。
- **主动停止**：`stop-bridge.cmd`（或 `node supervisor.mjs --stop`）——先停守护再停 bridge，
  不会被守护又拉起来；下次登录/双击 `start-bridge.vbs` 再启动。
- **Node 路径**：脚本按 `bridge/node-path.txt` → `%DSH_NODE_PATH%` → PATH 里的 `node` 顺序解析；
  若 node 不在 PATH，创建 `node-path.txt`（一行绝对路径）或设置环境变量。
- **运行期锁文件**（可安全删除，勿手改）：`supervisor.lock`（守护单实例）、`bridge.start.lock`
  （启动窗口互斥，防登录自启与守护重拉同时起两份）、`supervisor.stop`（停止标记，仅存在一瞬间）。

## 3. 配置字段（config.json）

### 必填

| 字段 | 说明 |
| --- | --- |
| `serverHost` | 远端服务器 host 或 IP（如 `203.0.113.10`） |
| `sshUser` | SSH 登录用户（如 `ubuntu`） |
| `sshKey` | SSH 私钥路径（如 `~/.ssh/id_ed25519` 的绝对路径） |
| `remoteCredentialsPath` | 远端 DSH 凭据文件（如 `<remote-home>/.dsh/.credentials.yaml`） |
| `cwd` | 远端会话工作目录（如 `<remote-home>`） |

### 常用可选

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sshKnownHosts` | 空 | 自定义 known_hosts 路径；留空用 ssh 默认 |
| `remoteDshPort` / `localTunnelPort` | 3080 / 13380 | 远端 DSH 端口 / 本机隧道端口 |
| `apiPort` / `listenHost` | 47891 / 127.0.0.1 | 本机 HTTP 监听 |
| `sessionId` / `agentPreset` | pet-local / local-pet | 默认会话与 agent preset（通用示例值） |
| `roleCardPath` | 空 | 远端人格文件；留空 = 不注入角色卡 |
| `mindDbPath` | 空 | 远端 mind.db（心情）；留空 = 关闭心情 |
| `qqSocialFile` / `qqActivityFile` | 空 | 远端 QQ 状态文件；留空 = 关闭 QQ 预览 |
| `qqPreviewChats` / `qqPreviewGroups` | `[]` | QQ 预览白名单（`["all"]` 表示全允许；默认不预览任何会话） |
| `forbiddenSessionIds` | `[]` | 红线会话：永不创建/prompt/归档 |

完整字段见 `config.example.json`。敏感信息（主机、用户、路径、QQ 白名单）只在 `config.json`，
**不要提交/打包**。

## 4. HTTP / WS API（本机回环）

| 方法/路径 | 说明 |
| --- | --- |
| `GET /health` | 健康与版本 |
| `GET /state` | 运行状态摘要 |
| `GET /mood` / `POST /mood/refresh` | 只读心情快照 / 刷新 |
| `GET /dashboard` | 总控台聚合（需 token；server/QQ 走 SSH 缓存） |
| `GET /context` / `POST /context` | 本机情境总线（POST 需 token） |
| `GET /history?session=…&limit=…[&before=…]` | 会话历史 |
| `GET /sessions` / `POST /ensure` | 会话列表 / 确保会话存在 |
| `POST /say` | 发送一轮对话（可选角色卡/情境注入） |
| `POST /archive` / `POST /unarchive` | 归档 / 取消归档 |
| `GET /diagnostics` | 诊断信息 |
| `WS /chat?token=…` | 对话 WebSocket |
| `WS /events?token=…` | 事件流 WebSocket |

bridge token 首次启动生成在 `token.txt`（0600 建议）。HTTP token 支持三种方式：
`?token=`、`x-bridge-token` 头、`Authorization: Bearer`。

## 5. 验证

```bash
node tools/run-tests.mjs          # 语法检查 + 全部单测
node tools/run-tests.mjs --check-only
```

缺配置时启动会打印可读错误并退出（例如提示复制 `config.example.json`、哪些字段缺失/仍是占位值）。

## 6. 分发打包

```bash
node tools/build-dist.mjs
# 产物：bridge/dist/dsh-link-bridge/  （可压缩分发）
```

打包脚本只复制运行所需文件，并在产物上做隐私扫描（IP/路径/QQ/密钥名/session id 等，命中即失败）。
**不会进入 dist**：

- `config.json`（实机配置）、`token.txt`、`state.json`、`node-path.txt`
- `logs/`、`tmp/`、`test/tmp/`、`dist/`
- `PHASE*.md`（内部阶段报告）
- 任何 `*.log`

## 7. 常见问题

- **`--check-config` 报“未找到配置文件”**：先 `cp config.example.json config.json` 并填写必填字段。
- **握手/连接失败**：确认 `ssh {sshUser}@{serverHost}` 可免交互登录（`BatchMode=yes`），
  远端 DSH 在 `remoteDshPort` 监听；`sshKnownHosts` 可指向自定义 known_hosts。
- **端口被占用**：改 `apiPort` / `localTunnelPort`；bridge 首次启动会自动做单实例检查。
- **中文 Windows 下启动脚本乱码**：自启 vbs 由 `tools/autostart.mjs` 以 UTF-16LE+BOM 生成，
  请不要手动用记事本另存为 UTF-8。
- **关机/重启后桌宠「大脑」没连上**：按顺序查
  1) 是否已登录桌面（自启只在登录后触发）；
  2) `curl http://127.0.0.1:47891/health` 是否 200；不行看 `logs/bridge.log` 尾部；
  3) `logs/supervisor.log` 是否有「已启动 bridge / 判定卡死」记录；
  4) `ssh` 是否可免交互登录远端（`ssh -i <key> <user>@<host> true`）。
  需要手动恢复时双击 `start-bridge.vbs` 即可（它会把守护一起拉起）。
- **怎么确认守护在跑**：`bridge/supervisor.lock` 里的 pid 存活即可；日志 `logs/supervisor.log`。
- **bridge 被 `taskkill /IM node.exe` 杀了怎么办**：守护会在 ~30s 内自动重拉；
  若 node.exe 被整批杀掉（守护也死于同一刀），重新登录 / 双击 `start-bridge.vbs` 即可恢复。
