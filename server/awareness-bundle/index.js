// dsh-link-awareness — 服务器「共享情境」注入插件（host-only，DSH 0.2.1-rc.2）
//
// 作用：把「本机主人此刻在干嘛（T13 bridge /context 快照，由 local-sync 同步到
// $DSH_HOME/shared-awareness.json）」+「QQ 近期活动摘要」+「QQ 桥接状态」，
// 通过 DSH 的 systemPrompt.context 机制注入**服务器上所有 agent 的每轮运行时上下文**。
//
// 机制（对照 dsh-deep-soul 的写法）：
//   ctx.systemPrompt.context({ name, order, text }) —— text 可以是 (context) => string，
//   DSH 在**每次组装 prompt 时**调用它；返回空字符串即不注入。运行时上下文快照
//   （"This snapshot supersedes earlier runtime-context snapshots"）本身每轮替换，
//   所以情境是「每轮刷新」而不是累积。
//
// 安全底线（任何一条失败都只是不注入，绝不影响 DSH 启动/其它插件/QQ）：
//   1. apply() 整体 try/catch；
//   2. text() 内部整体 try/catch（prompt 组装里抛错会让整轮失败，必须吞掉）；
//   3. 只读 contextFile / qq-activity.log / bridge.log，不写任何文件；
//   4. 不改角色卡/QQ 配置/桥接状态/preset；不向 QQ 会话发任何 prompt；
//   5. 文件缺失/解析失败/快照过期 → 对应部分降级不注入（日志说明原因）。
import {
  DEFAULTS,
  createBlockBuilder,
  log,
  logError,
} from './awareness.mjs'

export const name = 'dsh-link-awareness'

// 只依赖 systemPrompt 与 timer 两个宿主服务（timer 仅用于「当前在线 agent」证据日志）。
export const inject = ['systemPrompt', 'timer']

export function apply(ctx, rawConfig) {
  try {
    const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
    if (config.enabled === false) {
      log('disabled by config (enabled=false); no injection registered')
      return
    }
    const cfg = { ...DEFAULTS, ...config }
    const builder = createBlockBuilder(cfg)

    // ---- 1) 核心：全局注册运行时上下文（所有 agent 共享；text 每轮刷新） ----
    const text = (context) => {
      try {
        const agentId = String(context?.agent?.id ?? context?.agent?.sessionId ?? '')
        return builder.build({ agentId }).text
      } catch (error) {
        // 绝不向 prompt 组装抛错
        try { logError('inject degraded (caught):', String(error?.message ?? error)) } catch { /* ignore */ }
        return ''
      }
    }
    try {
      ctx.systemPrompt.context({
        name: 'dsh-link-awareness',
        order: Number.isFinite(Number(cfg.order)) ? Number(cfg.order) : DEFAULTS.order,
        text,
      })
      log(
        `registered systemPrompt.context name=dsh-link-awareness order=${cfg.order} ` +
          `contextFile=${cfg.contextFile} qqActivityFile=${cfg.qqActivityFile} blockMaxChars=${cfg.blockMaxChars}`,
      )
    } catch (error) {
      logError('systemPrompt.context registration failed; running degraded (no injection):', String(error?.message ?? error))
      return
    }

    // ---- 2) 证据/可观测：定期列出当前在线 agent（含 QQ 会话 id），只在集合变化时打日志 ----
    // 这不是注入逻辑，只是让「哪些 agent 会拿到注入」在 journal 里可见、可验证。
    let lastAgentKey = ''
    const scanAgents = () => {
      try {
        const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
        if (agents === undefined || agents === null || typeof agents.list !== 'function') return
        const ids = agents
          .list()
          .map((agent) => String(agent?.id ?? agent?.sessionId ?? ''))
          .filter((id) => id.length > 0)
          .sort()
        const key = ids.join(',')
        if (key === lastAgentKey) return
        lastAgentKey = key
        log(`live agents (${ids.length}): ${ids.join(', ')} — awareness applies to all of them`)
      } catch { /* 证据日志失败忽略 */ }
    }
    try {
      ctx.effect(() => ctx.interval(scanAgents, 60000))
      // 启动早期（QQ bridge 恢复会话后）补一次扫描，方便验证
      const timer = setTimeout(scanAgents, 15000)
      ctx.effect(() => () => clearTimeout(timer))
    } catch (error) {
      logError('agent scan setup failed (ignored):', String(error?.message ?? error))
    }

    // ---- 3) 启动即做一次试构建（只为把「命中/降级」原因写进 journal，不缓存结果） ----
    try {
      builder.build({ agentId: '(startup-probe)' })
    } catch { /* ignore */ }
  } catch (error) {
    // 最后一道保险：任何异常都只降级，不阻塞 DSH 启动
    logError('apply failed; running degraded (no injection):', String(error?.message ?? error))
  }
}
