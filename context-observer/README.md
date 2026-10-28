# 本机情境观察器（`dsh-link/context-observer`）

「本机的眼睛」。它观察**主人在电脑上做什么**（前台窗口）和**本机 DSH 在哪个会话干活**，
把变化摘要成情境事件，`POST` 给本机 bridge 的 `/context`（T13 情境总线），由 bridge 注入到
「鲸歌」人格的每一轮对话里——桌宠、鲸歌面板、服务器会话（经 T15）因此知道主人此刻的情境。

> 状态：已交付、离线 **31 项**测试 + 真实 bridge 联调通过；**T16 起带心跳/自愈**（bridge 重启后自动恢复情境）；
> 登录自启已由 Lead 安装（Startup `dsh-link-context-observer.vbs`）并常驻运行。
> 只写本目录；不改 bridge、不重启 DSH、不碰 Coopanon/服务器/QQ。

---

## 1. 它采什么、不采什么（隐私边界）

| 采集 | 说明 |
| --- | --- |
| ✅ 前台窗口 | 每 **18s**（可配 15–20s）取一次：进程名 + 窗口标题，标题截断 ≤80 字 |
| ✅ 本机 DSH 活跃会话 | 每 **30s**：`running=true` 或最近 30 分钟内更新过的会话标题 + 运行状态（排除空白会话与 subagent 子会话） |
| ✅ 变化摘要 | 只在**变化时**推送，例如 `DeepSeek Harness · 服务器dsh与本机dsh联通`、`bash（终端）`、`「服务器dsh与本机dsh联通」（运行中）` |
| ✅ 标题清洗 | 去尾部重复应用名/配置名（` - 个人 - Microsoft Edge`、` — DeepSeek Harness` 之类）、路径式终端标题只留 `进程（终端）`；单条摘要总长 ≤**60** 字（P1，bridge owner 建议） |
| ✅ 心跳 / 自愈（T16） | 每 **60s** 把「当前窗口 + ≤2 个 DSH 会话」按原 summary 重推一次（bridge 去重不刷屏）；每 **30s** 探 `GET /health` 的 pid——bridge 重启（pid 变）/ `/context` 为空时**立即重推**；observer 启动也先推一次。bridge 崩了事件排队，恢复后自动补推 |
| ❌ 屏幕像素 / 截图 | 不采集 |
| ❌ 键盘输入 / 剪贴板 | 不采集 |
| ❌ 聊天正文 / 文件内容 / 浏览器页面内容 | 不采集（本机 DSH 只读会话**标题**与运行状态） |

**隐私开关**

1. **blocklist**（`config.json` 可改）：窗口标题命中 `password/密码/银行/私钥/token/secret/…`，
   或进程名命中 `1password/bitwarden/keepass/lastpass/…` 时：
   - **不推标题**，只推进程名（如 `keepass`）；
   - 事件标 `private: true` → bridge **只计数、不注入 prompt、不出现在 `GET /context`**
     （`/diagnostics.context.privateCount` 可见）。
   本机 DSH 会话标题命中 blocklist 时同样隐藏标题并标 private。
2. **PAUSED 开关**：在本目录放一个 `PAUSED` 文件（或启动加 `--paused`）→ **停止采集与推送**，
   删除 `PAUSED` 后自动恢复（每 3s 检查一次）。也可以 `taskkill`/`stop-observer.cmd` 直接停进程。
3. **聊天/IM 类窗口**（`hideTitleProcesses`：QQ、微信、Telegram、Discord、Slack、企业微信、钉钉、飞书…）：
   **只推进程名 + 「（聊天）」**（如 `QQ（聊天）`），**不推窗口标题**（避免群名/联系人泄漏），
   但仍是公开事件——persona 可以知道「主人在用 QQ」，不会知道聊了什么。命中密码/银行等关键词时仍按 private 处理。
4. 本地留存：`logs/observer.log` 会记录最近推送摘要（含窗口标题），`state.json` 记录最近一次观察结果；
   这些文件都在本机本目录内，不对外发送。需要更严格时用 PAUSED 暂停。

## 2. 事件契约（与 bridge `/context` 一致）

```json
{
  "events": [
    {"at": 1793195182766, "surface": "desktop",  "kind": "window",  "summary": "DeepSeek Harness · 服务器dsh与本机dsh联通", "private": false},
    {"at": 1793195182766, "surface": "desktop",  "kind": "window",  "summary": "bash（终端）", "private": false},
    {"at": 1793195182766, "surface": "dsh-local", "kind": "session", "summary": "「服务器dsh与本机dsh联通」（运行中）", "private": false}
  ]
}
```

- 鉴权：`POST /context?token=<bridge/token.txt>`；同时在头里带 `authorization: Bearer <token>` 和
  `x-bridge-token: <token>`（bridge 认任一种，多余头不影响）。
- 成功判据：`200 && {ok:true}` → 清空队列；bridge 不在 / `/context` 未就绪（404 / 网络错误）→
  **本地排队**（最多 20 条，丢最旧并计数）按 5s 节奏重试，不丢事件、不影响桌面。
- bridge 侧规则：TTL 60 分钟、环形 120 条、相同 summary 去重合并（`hits+1`）、private 只计数不注入。
- **可靠性（T16）**：心跳重推使用与变化事件相同的 summary，靠 bridge 去重合并，不会刷屏或塞满缓冲；
  bridge 重启导致 `/context` 清零后，observer 通过「pid 变化 / context 为空」检测立即重推（默认 30s 探测轮询），
  不需要等窗口切换；观察器启动也先推一次当前状态。

## 3. 启停

```bash
# 本机内置 node（与 bridge 相同）
NODE="node"

# 只跑一轮（采集 + 推送），打印 JSON 后退出 —— Lead/人工验证用
"$NODE" observer.mjs --once
"$NODE" observer.mjs --once --no-push    # 只采集不推送（看隐私摘要）

# 常驻（前台可见日志，Ctrl+C 停）
"$NODE" observer.mjs --verbose

# Windows 脚本
start-observer.cmd            # 前台可见控制台（调试）
start-observer.vbs            # 隐藏启动（无窗口）
stop-observer.cmd             # 按 observer.lock 里的 pid 停止
```

- 单实例：`observer.lock`（含 pid）；重复启动会打印「已有观察器在运行（pid=…）」退出码 2；
  进程被硬杀后留下的陈旧锁会在下次启动时自动接管。
- `PAUSED`：本目录放 `PAUSED` 文件即暂停采集与推送（见 §1）。

## 4. 登录自启（**脚本已交付，尚未安装；是否启用由 Lead 决定**）

```cmd
install-autostart.cmd     :: 在当前用户 Startup 放 dsh-link-context-observer.vbs（无需管理员、不写注册表）
uninstall-autostart.cmd   :: 删除它
```

- 生成文件：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-link-context-observer.vbs`
  （由 `tools/autostart.mjs install` 生成，内嵌本目录与 node 绝对路径；隐藏启动、cwd=本目录）。
- 查看状态：`node tools/autostart.mjs status`（安装状态 + 观察器是否在跑）。
- **T14 未执行安装**。启用前建议先人工跑一轮 `--once --no-push` 看摘要是否符合预期。

## 5. 配置

默认值写在 `observer.mjs` 的 `DEFAULT_CONFIG`；把 `config.example.json` 复制成 `config.json` 即覆盖默认
（也可 `--config=path` 指定）。常用项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `foregroundIntervalMs` | `18000` | 前台窗口采样间隔（15–20s） |
| `dshIntervalMs` | `30000` | 本机 DSH 会话采样间隔 |
| `heartbeatMs` | `60000` | 心跳重推间隔（当前窗口 + ≤2 会话；bridge 同 summary 去重） |
| `bridgeHealthIntervalMs` | `30000` | 轮询 bridge `/health` pid；pid 变化或 `/context` 为空 → 立即重推 |
| `bridgeProbeTimeoutMs` | `5000` | bridge 状态探测超时 |
| `dshActiveWindowMs` | `1800000` | 「最近更新」窗口（30 分钟） |
| `dshSessionsMax` | `2` | 同时推送的活跃会话上限（1–2 个就够，多了挤占注入额度） |
| `includeSubagentSessions` | `false` | 是否把 subagent/teammate 子会话算进活跃会话 |
| `dshUrl` / `dshHome` | `http://127.0.0.1:53316` / 自动 | 本机 DSH 地址与 `$DSH_HOME`（读 `.credentials.yaml` 铸离线 cookie） |
| `bridgeUrl` / `bridgeTokenFile` | `http://127.0.0.1:47891` / `<your-workspace>/dsh-link/bridge/token.txt` | bridge 地址与 token |
| `pausedFile` | `PAUSED` | 暂停开关文件名 |
| `maxQueue` / `maxBatch` | `20` / `10` | 排队上限 / 单次 POST 批量上限 |
| `titleMaxChars` / `summaryMaxChars` / `sessionTitleMaxChars` | `80` / `60` / `60` | 标题截断 / 单条窗口摘要总长 / 会话标题截断 |
| `blocklistKeywords` / `blocklistProcesses` | 见 `config.example.json` | 隐私 blocklist（命中不推标题 + private） |
| `hideTitleProcesses` | QQ/微信/Telegram/Discord/Slack/… | 聊天类只推进程名 + 「（聊天）」，不推标题（不标 private） |
| `privateOnBlocklist` | `true` | 命中时是否标 private（false = 仍不推标题，但公开摘要） |
| `powershellCandidates` | `["pwsh.exe","powershell.exe"]` | 优先 PowerShell 7（默认 UTF-8），退到 Windows PowerShell 5.1 |

改了 `config.json` 需要重启观察器生效。

## 6. 编码（Windows 中文坑，已处理）

Windows PowerShell 5.1 默认按 OEM/GBK 输出中文，Node 按 UTF-8 读会变乱码。本实现三层防护：

1. PowerShell 脚本开头显式 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false)`；
2. 优先用 `pwsh.exe`（PowerShell 7，默认 UTF-8），没有才退 `powershell.exe`；
3. Node 侧用 **Buffer 接收**并 `decodePowerShellOutput()`：先按 UTF-8 解码，若出现替换字符（U+FFFD）再尝试 GBK 兜底。

另外脚本用 `-EncodedCommand`（UTF-16LE base64）传入，不落临时 `.ps1`、不受执行策略限制；
变量名用 `$windowPid`（**不能用 `$pid`**——PowerShell 里 `$PID` 是只读自动变量，会直接报错）。

> 提醒：手工用 `curl -d '中文'` 在 cmd 下测试 `/context` 会因 GBK 变乱码；要用 Node `fetch`（本观察器就是）
> 或 `curl --data-binary @events.json`（文件为 UTF-8）。

## 7. 验证

```bash
NODE="node"

# 语法
for f in observer.mjs tools/*.mjs test/*.mjs; do "$NODE" --check "$f"; done

# 离线测试（25 项；不连 bridge、不跑 PowerShell、不改真实状态）
"$NODE" --test test/observer.test.mjs

# 一次性探针（只采集，不推送）
"$NODE" tools/probe.mjs
# 真实推送到 bridge /context
"$NODE" tools/probe.mjs --push

# 常驻 1~2 分钟后看 bridge 侧
"$NODE" observer.mjs --verbose
curl -s http://127.0.0.1:47891/context?limit=20
curl -s http://127.0.0.1:47891/diagnostics | node -e "..."   # 看 context 摘要/计数
```

**实测证据（2026-10-28，bridge pid 13836，`/context` 最终版）**：

- 一次性推送 `tools/probe.mjs --push` → `{"ok":true,"status":200,"pushed":3,"stored":3,"pending":0}`；
  bridge 响应 `{"ok":true,"stored":3,"dropped":0,"deduped":1,"total":5}`。
- 常驻约 2 分钟（两段）：真实检测到**前台窗口变化**并推送（`DeepSeek Harness · …`、`msedge · …`、
  `bash · …` 控制台标题），本机 DSH 活跃会话也按变化推送；bridge 每次均 200（日志 `context 收到 N 条`，dropped=0）。
- `GET /context?limit=20` → HTTP 200，`count:6`（`desktop/window` 4 条 + `dsh-local/session` 2 条），
  UTF-8 自检：**0 个替换字符、0 个 latin-1 乱码字符**。示例（`GET /context` 原样）：
  - `desktop/window`：`DeepSeek Harness · 服务器dsh与本机dsh联通`（尾部应用名已清洗）
  - `desktop/window`：`msedge · 深度灵魂插件逻辑图 — DeepSeek Harness 和另外 4 个页面`（去掉 ` - 个人 - Microsoft Edge`）
  - `desktop/window`：`bash（终端）`（路径式终端标题）
  - `dsh-local/session`：`「服务器dsh与本机dsh联通」（运行中）`
  - `dsh-local/session`：`「将权限审批提示改为中文」（刚更新）`
- `/diagnostics.context`：`count:6, privateCount:1, storedTotal:15, dedupedTotal:8, injectedTurns:4, injection:"on"`。
- **隐私实测**：常驻期间真实捕获到 QQ 窗口标题（`【服务器】老…等6个会话`）——已按 P3 加固：
  聊天/IM 类窗口现在只输出 `QQ（聊天）`（不推标题）；修复前已进 bridge 缓冲的窗口标题事件
  会在 60 分钟 TTL 后自然过期（无删除接口，未为此重启 bridge）。
- **闭环证据**：bridge 日志在 13:50/13:51 出现
  `context 注入: session=pet-local items=5/6 chars=311/404` —— 观察器推的情境已被注入「鲸歌」每轮对话。
- 单实例锁第二个实例 exit=2；`stop-observer.cmd` 停掉 pid 并清理锁；`PAUSED` 期间不采集不推送；
  登录自启脚本已交付但 **未安装**（`node tools/autostart.mjs status` → `not installed`）。
- 取证文件：`tools/.verify/EVIDENCE.md`（机器写入，UTF-8 阅读器可读）、
  `tools/.verify/context-final.json`、`tools/.verify/diagnostics-final.json`。

### 可靠性实测（T16：bridge 重启后自动恢复情境）

> 2026-10-28 22:10（本机），observer pid=13296（新代码） + bridge pid 25780 → 28180。

| 时刻 | 事件 |
| --- | --- |
| 22:10:43 | kill 旧 bridge（pid 25780），`/health` → 000 |
| 22:10:45 | `bridge/start-bridge.vbs` 重启 |
| 22:10:52 | bridge ready（新 pid 28180，启动 8s） |
| 22:10:53 | **`/context` 自动恢复 count=4**（ready 后 1s、kill 后 9s，验收要求 90s 内 ✅） |
| 22:11:14 | observer 探测到新 pid（state.json `bridge.pid=28180`） |
| 22:11:21–22 | local-sync 写回服务器快照 events=6；服务器文件 count=7（<server-user> 600） |
| 22:11:2x | 服务器 journal 恢复注入：`localItems=5`（QQ 会话真实轮次） |
| 22:15:24 | **pet-local 轮次注入恢复**：bridge `context 注入 items=6 chars=296`；服务器 journal `inject agent=pet-local localItems=5`（修复前同位置是 `localItems=0`） |

observer.log：`bridge 探测失败 → 心跳重推（periodic）→ 未成功事件留队列 → bridge 恢复后立即补推`。
详细时间线与证据见 `tools/.verify/EVIDENCE.md` §7。

### 关于中文乱码（Lead 反馈的问题，已定位并修复）

根因与修法：

1. Windows PowerShell 5.1 默认按 OEM/GBK 输出 → 脚本开头显式
   `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = …`；
2. Node 侧不再直接按 UTF-8 信任 stdout，而是 **Buffer 接收 + `decodePowerShellOutput()`**：
   UTF-8 优先、出现 U+FFFD 时 GBK 兜底；
3. 优先 `pwsh.exe`（PowerShell 7 默认 UTF-8），本机没装则自动退 `powershell.exe`
   （已实测中文窗口标题完整）；
4. 修掉了 PowerShell 自动变量冲突：`$PID` 是只读变量，脚本里改用 `$windowPid`
   （此前会导致前台采集直接失败）；
5. 推送面：Node `fetch(JSON.stringify(...))` 发 UTF-8 body（不要用 cmd/curl `-d` 塞中文，会按 GBK 发）。

实测：修后 `GET /context` 中 desktop / dsh-local 两类摘要中文全部可读
（工具化校验 0 个替换字符、0 个 latin-1 乱码字符）。bridge 缓冲里若残留修复前的旧乱码事件，
是历史事件，60 分钟 TTL 后自然消失（bridge 重启也可清空）。


## 8. 已知限制

1. **只有 Windows**：前台窗口靠 `user32.dll` P/Invoke（PowerShell）；Linux/macOS 需另写采集器。
2. 每次采样启动一个 PowerShell 进程（约 0.3–1s CPU/进程开销），18s 一次；对普通桌面无感，但不是零成本。
3. 部分特殊窗口（UWP/受保护进程/锁屏）标题可能为空或进程名取不到 → 该轮跳过，不影响其他。
4. 只观察「当前前台窗口」，不保留窗口切换历史；变化被 18s 采样粒度截断（短于 18s 的切换看不到）。
5. 本机 DSH 只看会话**标题 + 运行状态**，不读聊天正文；标题本身由 DSH 生成，可能含敏感词 → 已套用 blocklist。
6. `stop-observer.cmd` 在 Windows 上是硬终止（信号不可捕获），日志可能缺少退出行；陈旧锁下次启动自动接管，
   本脚本已顺手清理锁文件。
7. `PAUSED` 生效期间**不采集也不推送**（不是「采集但不推」）；恢复后重新从当前状态推一次变化。
8. bridge 不在时不丢事件，但队列上限 20 条，长时间离线会丢最旧事件（会记 `droppedTotal`）。
9. 排队事件在 bridge 恢复后按 5s 节奏批量补推；bridge 的 60 分钟 TTL 可能让过旧事件被丢弃（bridge 侧行为）。
10. 本目录日志/状态文件含最近窗口标题，属本机隐私数据；不要把它拷贝/外发。
11. 标题清洗是启发式：极少数标题恰好以「 - 某应用名」结尾但那是正文一部分时会被误删；可改
    `blocklist`/`summaryMaxChars` 影响有限，不影响原文在其他地方的可用性。

## 9. 文件

```
dsh-link/context-observer/
├── observer.mjs              # 主程序：采集 / 隐私过滤 / 推送 / 队列 / 锁 / 日志 / 状态
├── config.example.json       # 可选配置样例（复制为 config.json 生效）
├── start-observer.cmd        # 前台可见启动（调试）
├── start-observer.vbs        # 隐藏启动
├── stop-observer.cmd         # 停止（读 observer.lock）
├── install-autostart.cmd     # 安装登录自启（未执行）
├── uninstall-autostart.cmd   # 卸载登录自启
├── tools/
│   ├── probe.mjs             # 一次性探针（前台窗口 + DSH 会话 + 待推事件；--push 真推）
│   ├── stop.mjs              # 停止观察器（读 observer.lock，顺带清锁）
│   └── autostart.mjs         # 自启安装/卸载/状态
├── test/observer.test.mjs    # 26 项离线测试
└── README.md
```

运行时生成（可删）：`observer.lock`、`state.json`、`logs/observer.log`（2MB 滚动，`.1` 为旧文件）。
