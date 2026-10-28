#!/usr/bin/env node
// dsh-link/bridge/tools/context-push.mjs — 向 bridge POST /context 推情境事件（供 T14 联调/Lead 复跑/手工测试）。
//
// 用法：
//   node tools/context-push.mjs --window "VS Code — PHASE5-CONTEXT.md" \
//        --session "「服务器dsh与本机dsh联通」（运行中）" [--at <ms>] [--private]
//   node tools/context-push.mjs --json '{"events":[{...}]}'
//   node tools/context-push.mjs --json @events.json
//   node tools/context-push.mjs --show            # GET /context 打印当前缓冲
//
// 说明：用 Node 的 fetch 发 UTF-8 JSON（Windows 下 curl -d 中文会按本地代码页发出 → 乱码）。
// token 默认读 bridge/token.txt；鉴权走 x-bridge-token + Bearer + query（三种服务端都认）。
import fs from 'node:fs';
import { loadConfig } from '../lib/config.mjs';
import { resolveBridgeBase, apiGet } from '../lib/http-client.mjs';

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const optionValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const cfg = loadConfig(optionValue('--config'));
const token = fs.readFileSync(optionValue('--token-file') ?? cfg.tokenFile, 'utf8').trim();
const { base } = await resolveBridgeBase(optionValue('--config'));

if (hasFlag('--show')) {
  const listed = await apiGet(base, '/context?limit=' + (optionValue('--limit') ?? '20'));
  console.log(JSON.stringify(listed, null, 2));
  process.exit(0);
}

const at = Number(optionValue('--at')) || Date.now();
const isPrivate = hasFlag('--private');
const events = [];

// 支持中文的 surface/kind 快捷参数
const surfaceFlags = [
  ['--window', 'desktop', 'window'],
  ['--activity', 'desktop', 'activity'],
  ['--session', 'dsh-local', 'session'],
  ['--dsh-activity', 'dsh-local', 'activity'],
  ['--qq', 'qq', 'activity'],
  ['--panel', 'panel', 'activity'],
];
for (const [flag, surface, kind] of surfaceFlags) {
  const summary = optionValue(flag);
  if (summary !== undefined) events.push({ at, surface, kind, summary, private: isPrivate });
}

if (optionValue('--json')) {
  const raw = optionValue('--json');
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  const parsed = JSON.parse(text);
  const extra = Array.isArray(parsed) ? parsed : parsed.events;
  if (!Array.isArray(extra)) throw new Error('--json 需要 {"events":[...]} 或数组');
  events.push(...extra);
}

if (events.length === 0) {
  console.error('没有事件可推：用 --window/--session/--activity/--qq/--panel 或 --json；查缓冲用 --show');
  process.exit(1);
}

const response = await fetch(`${base}/context?token=${encodeURIComponent(token)}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-bridge-token': token,
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ events }),
});
const text = await response.text();
let body;
try { body = JSON.parse(text); } catch { body = { raw: text }; }
console.log(JSON.stringify({ httpStatus: response.status, ...body, pushed: events.length }, null, 2));
process.exit(response.ok && body?.ok === true ? 0 : 1);
