// local-pet preset 的唯一安全守卫（与 QQ preset 的 qq-tool-restrict.mjs 同一套 API 用法）。
//
// 目的：本地/Coo 桌宠会话（agent preset id = local-pet）**只**能看见/调用长期记忆类工具
// （mind_*，deep-soul 注册的全局工具），任何本地执行 / 文件 / 网络 / 子代理 / 插件管理 /
// 调度 / QQ 发送类工具都既不在 schema 里出现，也无法执行。
//
// 两层防护（与 qq-tool-restrict 的设计同源）：
//   1) ctx.tools.restrict({ allow: MEMORY_TOOLS })
//      只放行白名单里的**继承（全局）工具**，其余全部从该 agent 的可见工具表中隐藏。
//      必须是 allow 白名单而不是 deny 黑名单：QQ / 手机 / web-search 的 MCP 工具是
//      异步注册的（stdio 握手完成后才 ctx.tools.register），restrict 时可能还不存在，
//      黑名单会静默漏掉它们；allow 白名单对**之后**注册的继承工具同样生效
//      （view() 在读取时逐层重新判定 admits）。
//      注意：restrict 只过滤「继承来的」工具（全局层 + 祖先层），不会影响 preset 自己
//      行注册的 scoped 工具；本 preset 的 plugins 里没有任何注册工具的行，所以白名单
//      就是这台 agent 的全部能力面。
//   2) ctx.tools.guard(...) 执行期白名单兜底：任何不在 MEMORY_TOOLS 里的调用一律拒绝，
//      返回友好原因（即使哪天 restrict 失效或工具被别处重注册，也不会真的执行）。
//
// 关于 restrict 的「未知名字整批抛错」：DSH 0.2.1-rc.2 的 restrict() 会校验名字是否
// 已在全局工具表里，只要有一个未知就整批失败（不是逐个跳过）。本 bundle 的 preset 行与
// deep-soul 等 bundle 行在同一次 profile 激活中挂载，正常情况下 7 个 mind_* 在 restrict
// 时都已注册（可参考线上 qq-tool-restrict 的 known global tools 日志）。万一没赶上，
// 这里按错误信息里列出的真实全局工具名取交集重试一次，并延迟再试一次；仍失败则只保留
// 执行期白名单（fail-closed：所有工具调用都会被拒绝，宁可没工具也不越权）。
export const name = 'local-pet-guard'

export const inject = ['tools']

/** 唯一允许的模型侧工具：deep-soul 长期记忆（与 QQ 会话共享同一份 mind.db）。 */
const MEMORY_TOOLS = Object.freeze([
  'mind_claim',
  'mind_pin',
  'mind_recall',
  'mind_remember',
  'mind_resolve',
  'mind_self',
  'mind_status',
])

function log(...args) {
  try {
    console.log('[local-pet-guard]', ...args)
  } catch {
    // 日志失败不影响边界
  }
}

/** 从 restrict 抛错信息里取出当时真实存在的全局工具名（DSH 0.2.1-rc.2 的错误格式）。 */
function knownGlobalToolsFromMessage(message) {
  const match = /known global tools: ([\s\S]*)$/.exec(message)
  if (!match) return undefined
  const names = match[1]
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
  return new Set(names)
}

export function apply(ctx) {
  let restricted = false

  const attemptRestrict = (label, names) => {
    try {
      ctx.tools.restrict({ allow: [...names] })
      restricted = true
      log(
        `restrict(${label}) ok — 只继承白名单全局工具：${names.join(', ')}；` +
          '其余继承工具（QQ/MCP/手机/搜索/插件管理/session-sync/hindsight 等）全部隐藏',
      )
      return true
    } catch (error) {
      log(`restrict(${label}) failed: ${String(error?.message ?? error).slice(0, 1600)}`)
      return false
    }
  }

  // 1) 首选：一次到位的 allow 白名单。
  if (!attemptRestrict('allow:memory', MEMORY_TOOLS)) {
    // 2) 兜底：按错误信息里的真实全局工具名取交集，立即重试一次。
    let parsed
    try {
      // 再探一次，拿到最新错误信息用于解析（本次调用若成功会直接置 restricted）
      try {
        ctx.tools.restrict({ allow: [...MEMORY_TOOLS] })
        restricted = true
        log('restrict(allow:memory) ok on retry')
      } catch (error) {
        parsed = knownGlobalToolsFromMessage(String(error?.message ?? error))
      }
      if (!restricted && parsed !== undefined) {
        const known = parsed
        const allowed = MEMORY_TOOLS.filter((name) => known.has(name))
        if (allowed.length > 0) {
          log(`已知全局工具 ${known.size} 个；白名单交集 ${allowed.length} 个：${allowed.join(', ')}`)
          attemptRestrict('allow:memory∩known', allowed)
        } else {
          log('白名单与当前全局工具零交集，暂不施加 allow 限制，等待延迟重试')
        }
      }
      // 3) 延迟重试：给同一轮 profile 激活里稍后注册的 bundle 行留时间（最多 3 次）。
      if (!restricted) {
        let tries = 0
        const retry = () => {
          tries += 1
          if (restricted) return
          let failure
          try {
            ctx.tools.restrict({ allow: [...MEMORY_TOOLS] })
            restricted = true
            log(`restrict(allow:memory) ok on delayed retry #${tries}`)
            return
          } catch (error) {
            failure = String(error?.message ?? error)
          }
          const known = knownGlobalToolsFromMessage(failure)
          const allowed = known === undefined ? [] : MEMORY_TOOLS.filter((name) => known.has(name))
          if (allowed.length > 0) {
            attemptRestrict(`allow:memory∩known(delayed#${tries})`, allowed)
            return
          }
          if (tries < 3) {
            const timer = setTimeout(retry, 2000)
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => () => clearTimeout(timer), 'local-pet-guard/restrict-retry')
            }
          } else {
            log('delayed restrict retries exhausted — fail-closed：仅执行期白名单生效（所有工具调用都会被拒绝）')
          }
        }
        const timer = setTimeout(retry, 2000)
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => clearTimeout(timer), 'local-pet-guard/restrict-retry')
        }
      }
    } catch (error) {
      log('fallback restrict block failed:', String(error?.message ?? error).slice(0, 800))
    }
  }

  // 4) 执行期白名单：最后一道门，对所有工具调用生效（与 restrict 是否成功无关）。
  ctx.tools.guard((exec) => {
    const tool = typeof exec?.name === 'string' ? exec.name : ''
    if (MEMORY_TOOLS.includes(tool)) return undefined
    log(`DENY tool call: ${tool || '(empty name)'}`)
    return (
      `工具 "${tool || '(无名)'}" 不在 local-pet 白名单内，已拒绝：` +
      '本地/Coo 桌宠会话只能使用长期记忆类工具（mind_*），没有任何 shell / 文件 / 网络 / ' +
      '子代理 / 插件管理 / 调度 / QQ 发送能力。'
    )
  })
  // 明确声明守卫已安装（journal 证据）。
  log(`guard installed; allowed = ${MEMORY_TOOLS.join(', ')}; restrictApplied = ${restricted}`)
}
