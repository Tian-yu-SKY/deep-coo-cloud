/**
 * 真实 bridge 冒烟（不是 node --test 的一部分，需要本机 bridge 在跑）：
 *
 *   node test/live-smoke.mjs            # 只读：config / health / history
 *   node test/live-smoke.mjs --say      # 额外真实发一句（会消耗服务器一轮模型调用！）
 *   node test/live-smoke.mjs --say "只回复 OK"
 *
 * 它直接调用 Host 半的 createRouteHandler（假 req/res），等价于「浏览器 → DSH Web →
 * Host 代理 → bridge」这条链路，但不用装插件、不开浏览器。
 */

import { Readable } from 'node:stream';
import { createRouteHandler, resolveConfig } from '../index.js';

const PAGE_ORIGIN = 'http://127.0.0.1:53316';

/** 极简假 req/res，够 createRouteHandler 用。 */
function invoke(handler, request = {}) {
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() {} });
    req.method = request.method ?? 'GET';
    req.url = request.url ?? '/';
    req.headers = { host: '127.0.0.1:53316', origin: PAGE_ORIGIN, ...(request.headers ?? {}) };
    const chunks = [];
    let status = 0;
    let settled = false;
    const res = {
      headersSent: false,
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        res.headersSent = true;
        void nextHeaders;
      },
      setHeader() {},
      end(chunk) {
        if (settled) return;
        settled = true;
        if (chunk) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text === '' ? null : JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status, text, json });
      },
    };
    handler(req, res).catch((error) => {
      if (!settled) reject(error);
    });
    if (request.body !== undefined) req.push(request.body);
    req.push(null);
  });
}

const resolved = resolveConfig({});
if (!resolved.ok) {
  console.error('✖ 配置无效：', resolved.error);
  process.exit(1);
}
const handler = createRouteHandler(resolved.value, { getOrigin: () => PAGE_ORIGIN });

const sayIndex = process.argv.indexOf('--say');
const sayText = sayIndex === -1 ? null : (process.argv[sayIndex + 1] && !process.argv[sayIndex + 1].startsWith('--')
  ? process.argv[sayIndex + 1]
  : '只回复：面板链路 OK');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

const config = await invoke(handler, { url: '/whale-panel/config' });
check('GET /whale-panel/config 200 且同源', config.status === 200 && config.json?.ok === true, {
  eventsUrl: config.json?.eventsUrl,
  tokenPresent: config.json?.tokenPresent,
  tokenError: config.json?.tokenError,
});
check('config 带 token（WS /events 需要）', config.json?.tokenPresent === true);

const health = await invoke(handler, { url: '/whale-panel/health' });
check('GET /whale-panel/health 200', health.status === 200 && health.json?.ok === true, {
  up: health.json?.server?.up,
  sessionId: health.json?.server?.sessionId,
  busy: health.json?.busy,
});

const history = await invoke(handler, { url: '/whale-panel/history?limit=200' });
const messages = history.json?.messages ?? [];
const roles = messages.reduce((acc, message) => {
  acc[message.role] = (acc[message.role] ?? 0) + 1;
  return acc;
}, {});
check('GET /whale-panel/history 200 且有 user/assistant 消息', history.status === 200 && Array.isArray(messages) && messages.length > 0, {
  count: messages.length,
  roles,
  hasMore: history.json?.hasMore,
  source: history.json?.source,
});

if (sayText !== null) {
  console.log(`… 真实发送：${sayText}（阻塞到轮结束，最多 280s）`);
  const startedAt = Date.now();
  const say = await invoke(handler, {
    method: 'POST',
    url: '/whale-panel/say',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: sayText }),
  });
  check('POST /whale-panel/say 200 且拿到回复', say.status === 200 && say.json?.ok === true, {
    ms: Date.now() - startedAt,
    text: typeof say.json?.text === 'string' ? say.json.text.slice(0, 120) : say.json?.error,
  });
  const after = await invoke(handler, { url: '/whale-panel/history?limit=10' });
  const tail = (after.json?.messages ?? []).slice(-2).map((message) => `${message.role}:${message.text.slice(0, 40)}`);
  check('发送后 /history 能看到新消息', tail.length === 2, tail);
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}（${checks.length - failed.length}/${checks.length}）`);
process.exit(failed.length === 0 ? 0 : 1);
