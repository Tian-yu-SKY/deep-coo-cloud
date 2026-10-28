# 分发 / 打包说明（`dsh-coo-pet-remote`）

> 目标：把插件安全地发给别人 / 装到别的机器时，**不泄露本机部署隐私**、不会把本地数据打进去。
> 本文件不包含任何某台机器的路径 / 服务器 / 账号。

---

## 0. 一句话

`npm pack` 只会带上 `package.json` 里 `files` 白名单列出的东西（`lib/`、`cordis.patch.yml`、
文档、LICENSE/NOTICE）。本地部署相关的 `config-bundle/`、`test/`、`dev/`、`data/`、`.git/`
都不在白名单里，**正常打包不会带出去**；发布前再跑一次自查测试确认内容干净。

---

## 1. 会随包发布的内容

| 路径 | 说明 |
| --- | --- |
| `lib/` | 全部运行时模块（`index.js` / `impl.js` / `brain-*.mjs` / `mood.mjs` / `figures.mjs` / `pet-settings.mjs` / `pet-server.mjs` / `pet-window.mjs` / `assets.mjs` / `coo.mjs` / `ws.mjs`） |
| `cordis.patch.yml` | bundle 挂载声明 + **通用**默认配置（不含任何本机路径） |
| `README.md` / `README.zh-CN.md` | 上游文档 + fork 说明 |
| `REMOTE-BRAIN.md` | 原理 / 架构 / 已知限制 |
| `INSTALL.md` | 通用安装 / 验收 / 卸载 |
| `DISTRIBUTION.md` | 本文件 |
| `NOTICE` / `LICENSE` | 上游 MIT + 第三方声明（Coopanion 素材不在授权范围，运行时才从本机 Coopanion 复制） |

## 2. 明确不发布的内容（本地物）

| 路径 | 为什么 |
| --- | --- |
| `config-bundle/` | **本地配置覆盖模板**：填了本机 Coopanion 路径 / dataDir / bridge token 后**绝不能发布**；正常打包也不在白名单里 |
| `test/` | 测试（`node --test`；需要 node >= 22.13，不属于运行时依赖） |
| `dev/` | 上游开发脚本 + 本 fork 的 `remote-probe.mjs` |
| `data/`、`<dataDir>` | 运行时生成的数据（素材副本、`pet-settings.json`、`skin.json`、Chromium 档案），永远不进包 |
| `.git/` | npm pack 自动忽略 |

> 建议分发前在干净 checkout 里打包（避免把本地改过的配置文件带进去）：
> ```bash
> rm -rf node_modules   # 本包没有运行时依赖，可省
> npm pack --dry-run    # 先看清单；确认没有 config-bundle/ data/ test/ dev/ .git/
> npm pack
> ```

## 3. 发布前自查（必做）

```bash
# 1) 分发自查（自动 grep：私有值 + 默认配置 + 打包白名单）
node --test test/distribution.test.mjs

# 2) 全量测试（可选但推荐）
npm test

# 3) 打包清单肉眼确认
npm pack --dry-run
```

`test/distribution.test.mjs` 会检查：

- `package.json files` 白名单 + `lib/` + `test/` + `dev/` + `config-bundle/` 模板里**没有**：
  本机盘符路径（含 Coopanion/工作区等私有目录）、本机用户名路径、部署服务器 IP、
  SSH 私钥文件名、角色卡专属名、QQ 号 / QQ 会话 id、部署账号名 / 部署目录名；
- 默认 `cordis.patch.yml` 的**生效配置**里没有写死 `cooRoot` / `petExe` / `cooDataRoot` /
  `dataDir` / `bridgeToken` / `bridgeTokenFile`（只允许注释里的 `<...>` 占位）；
- `config-bundle/` 是模板（生效配置不写死本机值），且不在发布白名单；
- 打包白名单包含必需文档、不包含 `test/` / `dev/` / `config-bundle/` / `data/`。

如果给自己的源发布，把这一条加进 CI：`node --test test/distribution.test.mjs` 失败即阻断发布。

## 4. 包里不含、但运行需要的「配套件」

| 配套件 | 谁提供 | 说明 |
| --- | --- | --- |
| **Coopanion** | 用户自己装 | 桌宠窗口与页面素材来源；插件运行时只**只读复制**到自己的 `dataDir`，不重分发、不改安装目录 |
| **bridge**（remote 模式） | 单独部署 | 本机服务，连远端 DSH；本插件只连它的 `bridgeUrl` 并读它生成的 token（配置注入，不进包） |
| **bridge token** | 用户运行时配置 | `bridgeTokenFile` / `bridgeToken` / 环境变量 `DSH_COO_PET_BRIDGE_TOKEN_FILE`；不落任何文件进包 |
| **远端 DSH / 会话** | 用户自己的环境 | remote 模式的「大脑」；角色卡/记忆/心情都在那边，本包不含任何远端数据 |

> 如果只想要「本地大脑」：把 Config 的 `brain` 改成 `local`（不需要 bridge/远端 DSH），
> 但窗口与素材仍需要 Coopanion。

## 5. 版本 / 命名 / 兼容

- 包名：`dsh-coo-pet-remote`（与 bundle entry id 一致，DSH 安装契约要求全局唯一）；
- 版本：`0.4.x-remote.N`（当前 `0.4.3-remote.1`）；
- `engines.node >= 22.13`；`peerDependencies: @deepseek-ai/dsh-tools`（DSH 宿主提供）；
- `dsh.bundle.patch: ./cordis.patch.yml`（DSH bundle 挂载入口）；
- 升级发布建议在 `CHANGELOG`/GitHub release 里说明「上游 base commit」与 fork 差异（见 `REMOTE-BRAIN.md` §5）。

## 6. 许可证 / 第三方

- 本插件代码：MIT（见 `LICENSE`）。
- 上游 `dsh-coo-pet`：MIT（见 `NOTICE`）。
- Coopanion 的页面素材 / 形象贴图：**AGPL-3.0 且部分贴图/商标不在其授权范围内**，
  所以本包**不重分发**任何 Coopanion 素材；运行时从用户本机安装的 Coopanion 复制到其数据目录
  （见 `NOTICE` 与上游 README「Prerequisite: Coopanion is required」）。
- 发布时不要附带从 Coopanion 复制出来的 `web/`、贴图、截图等资产。

## 7. 用户可以怎么装

```text
# 从 tarball / 目录
plugin_manager { action: "install_bundle", target: "file:<path to .tgz or unpacked dir>" }
# 或 CLI
dsh plugin --profile <profile> add <path-or-package-name>
```

安装后按 `INSTALL.md` 配置 `bridgeTokenFile`（remote）或改 `brain: local`（不需要 bridge）。
所有机器相关配置建议走单独的本地覆盖 bundle（`config-bundle/` 模板），**不要**改插件包里的
`cordis.patch.yml`，这样升级不会丢配置、也不会把本机路径写进发布物。
