# dsh-link-local-pet bundle 说明（Phase 1，T7）

> 注：本文档随插件包分发，示例中的服务器地址 / 用户名 / QQ 号 / 本机路径 / 角色卡名均已脱敏为 `<your-...>` 占位；真实部署请替换为你自己的值。

这是服务器 web profile 新增的**唯一** Phase 1 产物入口（另一个是 `pet-local` 会话，属运行数据）。

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包声明：`private`、`type: module`、`dsh.bundle.patch` 指向本目录的 cordis.patch.yml。**故意不写 `exports`**：preset 的 plugins 子行用裸子路径 `dsh-link-local-pet/guard.mjs`，没有 exports 时 Node 按文件路径解析，才能命中这个文件。 |
| `cordis.patch.yml` | 插入 `preset-local-pet` 行：`id: local-pet`、`order: 12`，plugins 含 persona（人设前缀）+ local-pet-guard（工具守卫）+ **compaction**（compaction-basic / command-compact / tool-result-pruner）。 |
| `guard.mjs` | 工具边界：`ctx.tools.restrict({allow: 7 个 mind_*})` 隐藏其余所有继承工具 + `ctx.tools.guard()` 执行期白名单兜底。 |

## 会话压缩（T39）

`local-pet` 默认会把同一会话的全部历史带进每次请求；模型窗口 1,000,000 tokens 时默认压缩阈值高达 80 万，桌宠等于没有压缩。T39 补上与 `qq-chat` 一致的 compaction 组：

- `thresholdRatio: 0.02` → 约 2 万 tokens 触发压缩
- `retainTokens: 1500` → 逐字保留最近约 10 条短消息的 token 预算
- `maxTokens: 2000` → 摘要输出上限
- 更早历史写摘要；细节仍由 deep-soul 的 `mind_recall` 查询

> 这是**按 token 预算**保留最近一小段，不是硬性按消息条数切；要严格 10 条需在 bridge 层做滚动窗口。

安装方式（服务器 root 执行；bundle 以 `link:` 依赖装进 profile，符号链接 `node_modules/dsh-link-local-pet`）：

```bash
scp -r local-pet-bundle root@<your-server-ip>:<user-home>/dsh-link-local-pet   # 属主改为 <user>
sudo -u <user> -H env HOME=<user-home> PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/dsh plugin --profile web add link:<user-home>/dsh-link-local-pet
```

回滚：`dsh plugin --profile web remove dsh-link-local-pet`（或恢复 profile 三文件备份）+ `systemctl restart dsh-web`。

> 为什么 `restrict` 用 allow 白名单而不是 deny 黑名单：QQ/手机/web-search 的 MCP 工具是在
> stdio 握手完成后**异步**注册的，restrict 执行时它们可能还没进全局工具表；allow 白名单
> 对之后注册的继承工具同样生效，能把它们一起挡住（详见 guard.mjs 头注释）。
