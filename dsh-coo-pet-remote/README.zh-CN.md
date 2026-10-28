# dsh-coo-pet

> **本目录是 fork：`dsh-coo-pet-remote` 0.4.3-remote.1（通用/可分发版）。**
> 在官方 v0.2.1 的 `local` / `session` 两种大脑之外新增了 **`brain: remote`**：
> 这只桌宠只当显示器，对话跑在**远端 DSH 的会话**里（经本机 **bridge** 的 WebSocket），
> 角色卡/记忆/心情都以远端那一份为准。**不内置任何本机路径**：Coopanion 自动探测，
> bridge token 由你配置（`bridgeTokenFile` / `bridgeToken` / 环境变量
> `DSH_COO_PET_BRIDGE_TOKEN_FILE`），所有数据落在 `$DSH_HOME/dsh-coo-pet`。
> v1.1 起 `pet_status` 会显示 bridge 的心情（`GET /mood`）、气泡动作跟着心情微调；
> v1.2 起支持**多形象包**（内置 coo/whale + 用户/Workshop pack）与
> `dataDir/pet-settings.json` 的 **DIY 设置**（外观各轴/大小/气泡/主题…，改文件 ~1s 热生效）。
> v0.4.3 起换装页 `/dress` 地板上的 6 个装饰图标变成真按钮（面板/形象包目录/项目主页/邮箱/音效/聊天面板，
> 只走白名单 `POST /api/dock`）。
> 安装见 [INSTALL.md](INSTALL.md)；原理/限制见 [REMOTE-BRAIN.md](REMOTE-BRAIN.md)；
> 打包见 [DISTRIBUTION.md](DISTRIBUTION.md)；下面仍是官方 README 原文。

[English](README.md) | **简体中文**

把 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的桌宠接进 **DeepSeek Harness (DSH)**。

她住在你的桌面上，大脑是 DSH 里的一个**独立会话** —— 有自己的记忆，能跟你聊天，
也能跟 Coopanion 里那只 **Coo** 聊天：两只桌宠各说各的，各自用**自己的气泡**说话。

```
     ┌──────────────────────────┐
     │  Coopanion 的桌宠窗口    │  透明、置顶、点击穿透;
     │  whale 形象 / 走位 / 拖拽 │  由 Coopanion 自带的 pet-host 提供
     └───────────┬──────────────┘
                 │ WebSocket(pet 协议)
     ┌───────────▼──────────────┐
     │  pet-server(本插件)      │  127.0.0.1,只认回环 Host
     └───────────┬──────────────┘
                 │
     ┌───────────▼──────────────┐        ┌─────────────────────┐
     │  brain(本插件)           │        │  Coopanion 的 Coo   │
     │  独立会话 · 独立记忆      │◄──────►│  终端对话 World      │
     └──────────────────────────┘        └─────────────────────┘
```

## 先决条件:必须先装 Coopanion

桌宠的**窗口和外形全部来自 Coopanion**,本插件在运行时从你已安装的那份里读取:
它去 `cortico-world-desktop-pet/web/` 取页面与形象素材,并用 `Coopanion.exe --pet-host`
起桌宠窗口。**不装 Coopanion,就没有形象、也没有窗口。**

**本插件不分发 Coopanion 的任何代码或贴图。** 那些素材是 AGPL-3.0 的,而
`web/whale/` 的贴图连 AGPL 都不覆盖 —— 原作者在 `THIRD_PARTY_NOTICES` 里明确写了
"不在本包的 AGPL 授权范围内",而且围裙上印着 DeepSeek、OpenAI、Anthropic、Google、
阿里云、月之暗面、MiniMax 的商标。所以本仓库一张图、一行别人的代码都不放,
一律运行时从用户自己的安装里取。细节见 [LICENSE](LICENSE) 与 `lib/assets.mjs`。

插件会自己找 Coopanion 的安装目录:先看 `cooRoot` 配置,再问 Windows 注册表,
最后试几个常见位置;都找不到才会报错并提示你在配置里指定。

## 安装

`desktop` 换成你自己的 DSH profile 名。

```bash
# 从 GitHub
dsh plugin --profile desktop add github:vortioxetine213/dsh-coo-pet

# 或从 npm(收录之后)
dsh plugin --profile desktop add dsh-coo-pet
```

装完**重启 DSH**,她会自己上桌。

## 更新

**这一段是写给你的 DSH 里的 AI 看的。** 把这个仓库地址和这段字发给它,它就知道该怎么更新,
而且不会把她聊过的话和换过的衣服弄丢。

随手重跑一遍 `add` **是不管用的**。`dsh plugin add` 只是把参数转给 `pnpm add`;同一条 `github:`
依赖已经在 lockfile 里时,pnpm 解析出同一个 commit,直接打一句 `Already up to date` ——
**一行新代码都不会下**。另外 pnpm 拉 GitHub 依赖走的是 `codeload.github.com`,而 git 的
`insteadOf` 重写不管这个域名,所以哪怕 `github.com` 能开,它也可能 404。

### 1. 先看装的是哪个版本

```bash
dsh plugin --profile desktop list
```

或者直接读 profile 目录下 `node_modules/dsh-coo-pet/package.json` 的 `version`,跟本仓库的比。

### 2. 先备份她的数据(仅 0.1.x 需要)

**0.1.x** 的数据是放在包**里面**的:`data/brain.jsonl`(她的记忆)、`data/skin.json`(她的外观)、
`data/web/`(取来的素材)、`data/pet-window/`(Chromium 档案)。删包会把它们一起删掉。
所以第 3 步之前,先把整个 `data` 目录拷到别处,装完再拷回新包里。

**0.2.0 起**数据改放在 `%DSH_HOME%\dsh-coo-pet\`(通常是 `C:\Users\<你>\.dsh\dsh-coo-pet\`),
在包外面,更新不再碰它。从 0.1.x 升上来时,插件第一次启动会自动把它搬过去 ——
前提是那时旧的 `data` 目录还在;要是已经删了,就自己拷一份回去。

### 3. 先删,再装

```bash
dsh plugin --profile desktop remove dsh-coo-pet
dsh plugin --profile desktop add github:vortioxetine213/dsh-coo-pet
```

必须先 `remove`:光 `add` 就是那条会打 `Already up to date` 的命令。

如果 `add` 在从 `codeload.github.com` 拉取时报错,就先用镜像 clone 下来,再从本地目录装:

```bash
git clone https://gh-proxy.com/https://github.com/vortioxetine213/dsh-coo-pet
dsh plugin --profile desktop add file:<clone 下来的目录>
```

### 4. 重启 DSH

升级只有重启后才生效。`plugin_manager set_bundle`(关掉再打开)能重载代码,但升级之后请直接重启。

### 5. 验一下

- `pet_status` 应该报出窗口、气泡连着、记忆有多少条 —— 而不是报后端降级。
- 如果她该跟 Coo 聊天,跑一次 `/pet-chat 1`,看有没有 Coo 的话回来。一句都不回来通常是
  Coopanion 没开,或者它的对话通道又被改名了(见下面的更新记录,0.2.0 起插件自己会认)。

### 更新记录

| 版本 | 改了什么 |
|---|---|
| 0.2.1 | 上游只换了衣服、没动页面代码时也能跟上 —— 素材指纹从「只看 `pet-app.js`」改成扫整个 `web/` 目录。Coopanion 0.2.8 那套店员装就是这种情况:贴图和 `figure.json` 是新的,页面一行没改。 |
| 0.2.0 | 跟 Coo 说话不再写死 `world:terminal` —— Coopanion 把它改名成 `world:console` 之后,所有旧版本都连不上;现在自动探测并回退。她的数据搬出包目录,更新不再弄丢记忆和外观。 |
| 0.1.0 | 第一个公开版:桌宠窗口、气泡对话、独立会话大脑、双鲸聊天、换装页,以及音效、帧率、任务栏那几处修复。 |

## 用法

**跟她说话**:双击她,或者把鼠标停在她身上点旁边冒出来的「打字」按钮。
她的话会以气泡显示在头顶,一边想一边逐字蹦出来。

**让她跟 Coo 聊天**:两个入口,都不烧到你想停为止。

| 入口 | 怎么写 |
|---|---|
| DSH 输入框 | `/pet-chat` 开聊、`/pet-chat-stop` 叫停 |
| 桌宠身上 | 鼠标停在她身上,点那个「跟 Coo 聊天」按钮 —— **同一个键管开关**,再点一下暂停 |

`/pet-chat` 还能带参数:

```
/pet-chat 5 今天谁摸鱼摸得多    # 聊 5 个来回,并给个开场话题
/pet-chat 0                    # 一直聊到你喊停
```

> 默认**关着**,不会自动开聊 —— 互聊时两边都在调模型,是要花 token 的。

## 配置

都在 `cordis.patch.yml` 里,改完重载插件生效。一般只有前两个需要动。

| 键 | 说明 |
|---|---|
| `cooRoot` | Coopanion 的安装目录。默认自动探测 |
| `brain` | `session`(默认)= 她的大脑是 DSH 里的独立会话;`local` = 插件内自建会话,**没有工具、最省 token** |
| `skin.scheme` | 配色:`deepseek` / `harness` / `chatgpt` / `claude` / `gemini` / `qwen` / `kimi` / `minimax` |
| `chatRounds` | 上面那个按钮和不带数字的 `/pet-chat` 默认聊几个来回(最多 10) |
| `user` | 她怎么称呼你,默认「主人」 |
| `autoStart` | 装上就上桌,默认 `true` |
| `port` | 桌宠页面服务器端口,默认让系统分配 |
| `petExe` | `Coopanion.exe` 的路径,默认取 `cooRoot` 下的 |
| `dataDir` | 她的数据放哪(记忆、外观、窗口档案、取来的素材),默认 `$DSH_HOME/dsh-coo-pet` —— 在包外面,升级不会删 |

### 两种大脑的区别

| | `local` | `session`(默认) |
|---|---|---|
| 记忆 | `data/brain.jsonl`,最近 40 句 | DSH 原生持久化,会话列表里能翻到 |
| 人格 | 插件内置的鲸鲸人设 | DSH 的 preset 人格 |
| 每轮开销 | 小(一段人设 + 40 句历史) | 大(preset 的完整系统提示 + 工具定义) |
| 工具 | 没有,她只聊天 | **有**,她那个会话会拿到 DSH 的工具 |
| 速度 | 快 | 慢一些(要走一整轮 agent loop) |

`session` 模式下有一条**保险**:会话后端一旦出错(流断了、等太久、preset 没配好),
插件会自动退回 `local` 重试一次 —— 她不会因为换了后端就说不出话。

## 给 DSH 里的 AI 用的工具

装好之后,你的 AI 会多出这些工具:

| 工具 | 干什么 |
|---|---|
| `pet_say` | 让桌宠说一句(直接上气泡,不过大脑、不进记忆) |
| `pet_talk` | 跟桌宠聊天,返回她的原话 |
| `pet_status` | 看她现在的状态:窗口、气泡、记忆条数、聊天开关 |
| `pet_window` | `open` / `close` / `restart` 让她上下桌 |
| `coo_talk` | 跨程序跟 Coopanion 的 Coo 说一句,把她的原话带回来 |
| `pet_spar` | 上面那个聊天开关(工具版) |
| `pet_forget` | 清空她的记忆 |

## 常见问题

**装完没有桌宠。**
99% 是没找到 Coopanion。先确认它确实装了,然后在 `cordis.patch.yml` 里写明确路径:

```yaml
config:
  cooRoot: '<your Coopanion 安装目录>'
```

**窗口出来了但是空的(没有鲸鱼)。**
极可能是 Chromium profile 撞车:Coopanion 默认把 pet-host 的档案放在
`<安装目录>\data\pet-window`,如果它自己的桌宠正跑着,两个进程抢同一个 GPU 缓存目录,
后起的那个 WebGL 起不来。本插件已经用 `CORTICO_COMPANION_DATA` 把窗口档案指到自己的
`dataDir` 了 —— 如果你改过这个变量,检查一下别指回 Coopanion 的目录。

**她说话很长、还爱分条列点。**
插件在出气泡之前会强制压成一句(去换行、剥编号、超 80 字截断);如果还是长,
把 `brain` 换成 `local`,内置人设里对长度管得更严。

## 许可

代码是 [MIT](LICENSE)。**Coopanion 的素材不在本项目的授权范围内**,见上面「先决条件」,
以及 [LICENSE](LICENSE) 末尾那段说明。

## 开发

见 [dev/NOTES.md](dev/NOTES.md) —— 里面有架构决策、踩过的坑、验证记录和调试脚本的用法。
