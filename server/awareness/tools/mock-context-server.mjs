// dsh-link/server/awareness/tools/mock-context-server.mjs
// 本地测试用：模拟 T13 bridge 的 GET /context（不依赖 bridge / 不需要 token 校验）。
// 用法：node tools/mock-context-server.mjs [port]   （默认 47899）
// 然后：node local-sync.mjs --once --bridge-base http://127.0.0.1:47899
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 47899)
const startedAt = Date.now()

function sampleEvents() {
  const now = Date.now()
  return [
    {
      at: now - 20 * 1000,
      surface: 'desktop',
      kind: 'window',
      summary: '前台：Visual Studio Code · dsh-link/server/awareness（测试快照）',
    },
    {
      at: now - 3 * 60 * 1000,
      surface: 'dsh-local',
      kind: 'session',
      summary: '本机 DSH 活跃会话：「示例本机会话」（运行中，测试快照）',
    },
    {
      at: now - 6 * 60 * 1000,
      surface: 'desktop',
      kind: 'activity',
      summary: '示例事件：主人在看桌宠（模拟事件）',
    },
  ]
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  if (request.method === 'GET' && url.pathname === '/context') {
    const events = sampleEvents()
    const body = JSON.stringify({ ok: true, events, updatedAt: Date.now(), count: events.length })
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(body)
    return
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, spec: 'mock-context-server', port, uptimeMs: Date.now() - startedAt }))
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: `unknown route ${request.method} ${url.pathname}` } }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-context-server listening on http://127.0.0.1:${port} (GET /context, /health)`)
})
