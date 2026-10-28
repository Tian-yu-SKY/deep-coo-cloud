# `config-bundle` —— 本机配置覆盖模板（不随插件发布）

这个目录是一个**可选的** DSH bundle：它不含代码，只用「同 id 覆盖」的方式，把
`dsh-coo-pet-remote` 的**本机部署相关配置**（Coopanion 安装位置、数据目录、bridge token
文件路径等）从插件默认值里拆出来。

## 为什么需要它

- 插件包本身是**通用可分发**的：默认不写死任何机器上的路径；
- 每台机器上 Coopanion 装在哪、bridge token 在哪、数据目录想放哪都不一样；
- 把这些值放进这个本地 bundle，升级/分享插件包时不会丢配置，也不会把本机路径带进发布物。

> ⚠️ **不要把填了本机路径的这份 bundle 发布**到 npm / 分享给别人。
> 插件 `package.json` 的 `files` 白名单里**不包含** `config-bundle/`，正常 `npm pack` 不会带上它；
> 发布前仍建议用 `npm pack --dry-run` 确认。

## 用法

1. 把本目录复制到一个不会随插件发布的位置（例如你自己的部署工作区）；
2. 编辑复制出来的 `cordis.patch.yml`，把 `<...>` 占位换成真实值（哪些可填见文件内注释）；
3. 安装（任选其一）：
   ```text
   plugin_manager { action: "install_bundle", target: "link:<你的本地配置bundle目录>" }
   # 或 dsh plugin --profile <profile> add link:<你的本地配置bundle目录>
   ```
4. 确保 `dsh.profile.bundles` 里它排在 `dsh-coo-pet-remote` **之后**；
5. 重载插件（disable→enable）或重启 DSH 生效。

## 最小可用示例

只配「Coopanion 在哪 + bridge token 在哪 + 数据放哪」这三样就够跑 remote：

```yaml
- id: dsh-coo-pet-remote
  name: dsh-coo-pet-remote
  config:
    autoStart: true
    brain: remote
    bridgeUrl: 'http://127.0.0.1:47891'
    bridgeSessionId: pet-local
    bridgeTimeoutMs: 240000
    moodIntervalMs: 60000
    moodTimeoutMs: 5000
    scale: 2
    scaleMin: 0.5
    scaleMax: 3
    cooRoot: '<COOPANION_INSTALL_DIR>'
    dataDir: '<DATA_DIR>'
    bridgeTokenFile: '<BRIDGE_TOKEN_FILE>'
```

不装这个 bundle 也完全可以：只要插件默认值/自动探测能覆盖你的环境（Coo 装在常见位置、
`$DSH_HOME/dsh-coo-pet` 可写，且你用 `bridgeTokenFile`/`bridgeToken` 或环境变量
`DSH_COO_PET_BRIDGE_TOKEN_FILE` 配好了 bridge token）。
