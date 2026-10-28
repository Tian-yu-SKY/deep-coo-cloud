#!/usr/bin/env node
/**
 * dsh-link/context-observer/tools/probe.mjs — 一次性探针：
 * 采集「前台窗口 + 本机 DSH 活跃会话」，打印将要推给 bridge 的情境事件 JSON。
 *
 * 用法：
 *   node tools/probe.mjs                 # 只采集（不推送）
 *   node tools/probe.mjs --json          # 机器可读 JSON（只采集）
 *   node tools/probe.mjs --push          # 采集并真实 POST bridge /context
 *   node tools/probe.mjs --no-dsh        # 只看前台窗口
 *   node tools/probe.mjs --bridge-url=http://127.0.0.1:47891 --token-file=D:/.../token.txt
 *
 * 说明：本工具不写日志/状态文件，可用于 Lead/人工复核；--push 时与观察器共用同一 POST 逻辑。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOnce } from '../observer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

function parse(argv) {
  const options = { push: false, json: false, noDsh: false, bridgeUrl: '', tokenFile: '', dshUrl: '' };
  for (const argument of argv) {
    if (argument === '--push') options.push = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--no-dsh') options.noDsh = true;
    else if (argument.startsWith('--bridge-url=')) options.bridgeUrl = argument.slice('--bridge-url='.length);
    else if (argument.startsWith('--token-file=')) options.tokenFile = argument.slice('--token-file='.length);
    else if (argument.startsWith('--dsh-url=')) options.dshUrl = argument.slice('--dsh-url='.length);
    else if (argument === '--help' || argument === '-h') {
      console.log('用法: node tools/probe.mjs [--push] [--json] [--no-dsh] [--bridge-url=...] [--token-file=...]');
      process.exit(0);
    } else {
      console.error(`不认识的参数：${argument}`);
      process.exit(1);
    }
  }
  return options;
}

const options = parse(process.argv.slice(2));

// 延迟 import：loadConfig 会读 config.json，先拿到 config 再应用 CLI 覆盖。
const { DEFAULT_CONFIG, applyCliOptions, loadConfig, isPaused } = await import('../observer.mjs');
const cfg = applyCliOptions(loadConfig(''), {
  bridgeUrl: options.bridgeUrl,
  tokenFile: options.tokenFile,
  dshUrl: options.dshUrl,
});

if (isPaused(cfg)) {
  console.log('⚠ 观察器处于 PAUSED 状态（PAUSED 文件存在）——本探针仍只做一次本地采集，不改变开关。');
}

const result = await collectOnce(cfg, {
  push: options.push,
  noDsh: options.noDsh,
});

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.push && result.push.ok === false ? 1 : 0);
}

console.log(`观察时间：${result.observedAt}`);
if (result.window.error) {
  console.log(`前台窗口：采集失败 — ${result.window.error}`);
} else {
  console.log(`前台窗口：${result.window.process || '未知程序'} · ${result.window.title || '（无标题）'}`);
  if (result.window.sensitive) console.log('  ⚠ 命中隐私 blocklist：只推进程名，且标 private（bridge 不注入）');
}
if (result.dsh.error) {
  console.log(`本机 DSH：采集失败 — ${result.dsh.error}`);
} else {
  console.log(`本机 DSH：${result.dsh.active.length} 个活跃会话 / 共 ${result.dsh.total} 个会话`);
  for (const session of result.dsh.active) {
    console.log(`  - 「${session.title}」${session.running ? '运行中' : '刚更新'}`);
  }
}
console.log(`将要推送 ${result.events.length} 条事件：`);
console.log(JSON.stringify(result.events, null, 2));
if (options.push) {
  console.log(`推送结果：${JSON.stringify(result.push)}`);
  if (!result.push || result.push.ok !== true) process.exit(1);
} else {
  console.log('（未推送；加 --push 真实发送到 bridge /context）');
}

// 避免误用：DEFAULT_CONFIG 引用以提示「配置里改了间隔/blocklist 也生效」。
void DEFAULT_CONFIG;
