# deep-coo-cloud 长期会话 Token 修复报告

**版本**：T39 · 2026-10-30  
**范围**：服务器 DSH 的 `local-pet` agent preset（本机 Coo 桌宠使用）  
**结论**：本地桌宠会话已补上自动压缩；长对话不再无限携带全部历史，实测 20 轮压力测试触发 4 次压缩，单轮输入稳定在约 1.0 万–2.2 万 tokens。

---

## 1. 现象

本机桌宠、面板聊天、自动看屏幕都使用服务器上的同一个 `pet-local` 会话。长期使用后，每轮请求会把越来越长的历史重新发给模型，导致：

- token 随对话轮数线性增长；
- 累计消耗按平方增长；
- 桌宠越聊越贵、越聊越慢。

QQ 侧同一个人格没有明显问题，因此一开始误以为是 deep-soul 记忆系统差异。

## 2. 根因

对比服务器上的两个 agent preset：

| preset | 使用方 | 是否带 compaction |
| --- | --- | --- |
| `qq-chat` | QQ 私聊 / 群聊 | ✅ 有 `compaction-basic` + `command-compact` |
| `local-pet` | 本机 Coo 桌宠 / 面板 / 看屏幕 | ❌ 只有 persona + 工具守卫 |

`local-pet` 缺少压缩配置，所以 `pet-local` 会话会一直携带全部历史。

另一个放大因素：`deepseek-flash` 的 `contextWindow = 1,000,000`，默认压缩触发比例 `0.8`，即默认要接近 **80 万 tokens** 才压缩。对桌宠来说，这等于没有压缩。

> deep-soul 记忆插件本身没有问题；它负责“记得什么”，不负责“每轮带多少上下文”。

## 3. 修复内容

在服务器 `dsh-link-local-pet` bundle 的 `cordis.patch.yml` 中，为 `local-pet` preset 增加与 `qq-chat` 一致的 compaction 组：

| 配置 | 值 | 作用 |
| --- | --- | --- |
| `thresholdRatio` | `0.02` | 约 2 万 tokens 即触发压缩（远低于默认 80 万） |
| `retainTokens` | `1500` | 逐字保留最近约 10 条短消息的 token 预算 |
| `maxTokens` | `2000` | 限制摘要输出，避免摘要本身过大 |
| `tool-result-pruner` | 50k / 45k / 2k | 先修剪超大工具输出 |

压缩后：

- 旧历史被替换为一段摘要；
- 最近约 10 条短消息逐字保留；
- 更早的细节仍可通过 deep-soul 的 `mind_recall` 查询。

## 4. 实测结果

### 4.1 测试方法

- 隔离测试会话：`local-pet` preset，不触碰真实 `pet-local`；
- 每轮发送 **4,204 字符**填充文本，连续 20 轮；
- 数据来源：服务器账户 usage 账本 + 会话 `compaction/*` 事件。

### 4.2 每轮输入 tokens

| 轮次 | 输入 tokens | 说明 |
| --- | --- | --- |
| 1 | 12,039 | |
| 2 | 16,036 | 累积 |
| 3 | 19,312 | 累积 |
| 4 | 21,805 | 接近阈值 |
| 5 | 10,383 | 压缩后回落 |
| 6 | 12,876 | |
| 7 | 15,369 | |
| 8 | 17,862 | |
| 9 | 20,355 | 接近阈值 |
| 10 | 13,015 | 压缩后回落 |
| 11 | 16,290 | |
| 12 | 18,783 | |
| 13 | 21,276 | |
| 14 | 13,021 | 压缩后回落 |
| 15 | 16,293 | |
| 16 | 19,565 | |
| 17 | 22,058 | 峰值 |
| 18 | 11,259 | 压缩后回落 |
| 19 | 13,752 | |
| 20 | 16,271 | |

### 4.3 汇总

- 20 轮共触发 **4 次压缩**；
- 单轮输入 **10,383–22,058 tokens**；
- 20 轮累计约 **327,620 tokens**；
- 会话记录中确认出现 4 条 `compaction/summary` 事件；
- 最近一次摘要使用 12,039 输入 tokens，释放 5,298 tokens 历史。

作为参照：另一个未触发压缩的测试会话，同样 10 轮 4.2k 字填充，输入 token 从 34,433 线性涨到 56,909，累计 456,671 tokens，完全没有回落。

> 注意：这是“每轮 4.2k 字”的极端压力测试，日常桌宠短句远低于这个量，压缩触发会更少、平均 token 更低。

## 5. 影响面与安全

| 项目 | 状态 |
| --- | --- |
| deep-soul 记忆插件 / `mind.db` | **未修改**；实测仍有 318 条记忆、心情可读 |
| QQ 两个会话 / QQ preset | **未修改** |
| 本机 `deep-coo-cloud` 面板 | **未修改** |
| 本机桌宠插件 `dsh-coo-pet-remote` | **未修改** |
| 本机 bridge | 仅重启，代码未改 |
| 服务器 `local-pet` preset | 增加 compaction 组 |
| 服务器 `workspace.json` | 仅移除 `pet-local` 的归档标记 |
| `pet-local` 会话 | 旧会话已归档，新建一个干净会话 |

旧会话被归档的是**聊天记录**，不是记忆库；长期记忆仍在 deep-soul 中。

## 6. 部署与回滚

部署文件：

```text
<server-home>/dsh-link-local-pet/cordis.patch.yml
```

部署后重启 `dsh-web`，并让 bridge 创建一个新的 `pet-local` 会话（旧 preset 不会自动应用到已有会话）。

回滚：

1. 恢复 `cordis.patch.yml` 备份；
2. 重启 `dsh-web`；
3. 如需恢复旧会话，按服务器备份目录恢复，并确认 `workspace.json` 的归档列表状态。

## 7. 后续建议

1. 如果要求“严格只带最近 10 条”，需要在 bridge 层做滚动窗口，而不是依赖 compaction 的 token 预算；
2. 若觉得压缩仍偏晚，可把 `thresholdRatio` 调低（如 `0.01`），但不要低于系统提示词 + 工具 schema 的体量，否则会频繁触发摘要；
3. 若觉得保留太多，可把 `retainTokens` 调到 `800` 左右；
4. 定期观察 usage 账本中的单轮输入 tokens，确认峰值稳定在目标范围。

## 8. 附：配置片段

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        thresholdRatio: 0.02
        retainTokens: 1500
        maxTokens: 2000
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 50000
        headChars: 45000
        tailChars: 2000
```

---

**相关文件**：`server/local-pet-bundle/cordis.patch.yml`、`server/local-pet-bundle/README.md`
