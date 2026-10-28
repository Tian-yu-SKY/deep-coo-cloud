#!/usr/bin/env node
// dsh-link/bridge/tools/events-probe.mjs — 验证 /history 与 WS /events 的小工具（Lead 可复跑）。
//
// 用法：
//   node tools/events-probe.mjs                      # 打印 /history 摘要 + 连 /events 30s，收 snapshot/status/ping
//   node tools/events-probe.mjs --say "只回复：事件OK" # 同时发一句 /say，等待 assistant message 实时推送
//   node tools/events-probe.mjs --session pet-local --seconds 20 --json
//
// 退出码：0 = 收到 snapshot 且（未 --say 或收到对应 assistant 回复）；1 = 失败。
import fs from 'node:fs';
import { loadConfig } from '../lib/config.mjs';
import { apiGet, apiPost, resolveBridgeBase } from '../lib/http-client.mjs';

const argv = process.argv.slice(2);
const options = {};
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 0) options[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[arg.slice(2)] = next;
        index += 1;
      } else options[arg.slice(2)] = true;
    }
  }
}

const cfg = loadConfig(options.config);
const sessionId = options.session ? String(options.session) : cfg.sessionId;
const seconds = Math.max(3, Number(options.seconds) || 20);
const sayText = options.say !== undefined ? String(options.say) : null;
const jsonOut = options.json === true;

const { base } = await resolveBridgeBase(options.config);
const token = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
console.log(`[probe] bridge=${base} session=${sessionId} token=${token.slice(0, 4)}…（不显示全文）`);

// 1) /history
const history = await apiGet(base, `/history?session=${encodeURIComponent(sessionId)}&limit=50`);
console.log(`[probe] /history: count=${history.messages.length} hasMore=${history.hasMore} nextBefore=${history.nextBefore ?? '-'} source=${history.source}`);
for (const message of history.messages.slice(-4)) {
  console.log(`[probe]   history ${message.role.padEnd(9)} ${JSON.stringify((message.text ?? '').replace(/\n/g, ' ').slice(0, 70))}`);
}

// 2) WS /events
const wsUrl = `${base.replace(/^http/, 'ws')}/events?token=${encodeURIComponent(token)}&session=${encodeURIComponent(sessionId)}`;
console.log(`[probe] ws ${wsUrl.replace(token, token.slice(0, 4) + '…')}`);
const ws = new WebSocket(wsUrl);
const frames = [];
let snapshotSeen = false;
let expectedReply = null;
let gotExpectedReply = false;

const finish = (reason) => {
  try { ws.close(); } catch { /* ignore */ }
  const summary = {
    reason,
    snapshotSeen,
    messageCount: frames.filter((frame) => frame.type === 'message').length,
    statusCount: frames.filter((frame) => frame.type === 'status').length,
    pingCount: frames.filter((frame) => frame.type === 'ping').length,
    messages: frames.filter((frame) => frame.type === 'message').map((frame) => ({
      role: frame.message?.role, text: (frame.message?.text ?? '').slice(0, 80), at: frame.message?.at,
    })),
    gotExpectedReply,
  };
  if (jsonOut) console.log(JSON.stringify(summary, null, 2));
  else console.log(`[probe] 汇总: ${JSON.stringify(summary)}`);
  process.exit(snapshotSeen && (!sayText || gotExpectedReply) ? 0 : 1);
};

const timer = setTimeout(() => finish('timeout'), seconds * 1000);

ws.addEventListener('open', async () => {
  console.log('[probe] WS /events 已连接，等待 snapshot…');
  if (sayText) {
    setTimeout(async () => {
      try {
        console.log(`[probe] POST /say ${JSON.stringify(sayText)}`);
        const result = await apiPost(base, '/say', { text: sayText, sessionId }, { timeoutMs: cfg.requestTimeoutMs + 30000 });
        console.log(`[probe] /say 返回: session=${result.sessionId} ms=${result.ms} deltas=${result.deltas} reply=${JSON.stringify(result.text)}`);
        expectedReply = result.text;
      } catch (error) {
        console.error(`[probe] /say 失败: ${error.message}`);
      }
    }, 600);
  }
});

ws.addEventListener('message', (event) => {
  let frame;
  try { frame = JSON.parse(event.data); } catch { return; }
  frames.push(frame);
  if (frame.type === 'snapshot') {
    snapshotSeen = true;
    console.log(`[probe] snapshot: sessionId=${frame.sessionId} messages=${frame.messages?.length ?? 0}`);
    for (const message of (frame.messages ?? []).slice(-3)) {
      console.log(`[probe]   snapshot ${message.role.padEnd(9)} ${JSON.stringify((message.text ?? '').slice(0, 60))}`);
    }
  } else if (frame.type === 'message') {
    const message = frame.message ?? {};
    console.log(`[probe] message  ${String(message.role).padEnd(9)} ${JSON.stringify((message.text ?? '').replace(/\n/g, ' ').slice(0, 80))}`);
    if (sayText && message.role === 'assistant' && message.text && (!expectedReply || message.text.includes(expectedReply.slice(0, 10)))) {
      gotExpectedReply = true;
      clearTimeout(timer);
      setTimeout(() => finish('assistant-message-received'), 200);
    }
  } else if (frame.type === 'status') {
    console.log(`[probe] status   session=${frame.sessionId} running=${frame.running} busy=${frame.busy}`);
  } else if (frame.type === 'ping') {
    // 心跳不刷屏
  } else if (frame.type === 'error') {
    console.error(`[probe] error ${frame.code}: ${frame.message}`);
  }
});

ws.addEventListener('error', () => {
  console.error('[probe] WS 连接错误');
  clearTimeout(timer);
  finish('ws-error');
});
ws.addEventListener('close', () => {
  if (!snapshotSeen) { clearTimeout(timer); finish('closed-before-snapshot'); }
});
