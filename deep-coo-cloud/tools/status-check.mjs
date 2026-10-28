#!/usr/bin/env node
/**
 * dsh-link/whale-panel/tools/status-check.mjs — 总控台真实数据自检（不装插件、不开浏览器）。
 *
 * 直接调用 Host 半的 `collectControlCenterStatus()`，输出 `/control-center/status` 的真实聚合结果：
 * bridge `/dashboard`（T18 上线前后都能跑：缺失则降级 /health+/mood+/context）、本机组件文件/锁、
 * 四个登录自启 vbs、PAUSED 状态。用于 Lead 重载插件前/后对比，以及排查「卡片为什么是未连接」。
 *
 * 用法：
 *   node tools/status-check.mjs            # 完整 JSON
 *   node tools/status-check.mjs --summary  # 人类可读摘要
 *   node tools/status-check.mjs --bridge-url=http://127.0.0.1:47891 --dsh-link-root=D:/... 
 */

import { collectControlCenterStatus, resolveConfig } from '../index.js';

const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const overrides = {};
for (const argument of args) {
  if (argument.startsWith('--bridge-url=')) overrides.bridgeUrl = argument.slice('--bridge-url='.length);
  else if (argument.startsWith('--dsh-link-root=')) overrides.dshLinkRoot = argument.slice('--dsh-link-root='.length);
  else if (argument.startsWith('--token-file=')) overrides.tokenFile = argument.slice('--token-file='.length);
  else if (argument === '--summary' || argument === '--help' || argument === '-h') {
    if (argument !== '--summary') {
      console.log('用法: node tools/status-check.mjs [--summary] [--bridge-url=...] [--dsh-link-root=...] [--token-file=...]');
      process.exit(0);
    }
  } else {
    console.error(`不认识的参数：${argument}`);
    process.exit(1);
  }
}

const resolved = resolveConfig(overrides);
if (!resolved.ok) {
  console.error(`配置无效：${resolved.error}`);
  process.exit(1);
}

const status = await collectControlCenterStatus(resolved.value, {});
const timeText = new Date(status.at).toISOString();

if (!summaryOnly) {
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

const yesNo = (value) => (value ? '是' : '否');
console.log(`总控台数据自检 @ ${timeText}`);
console.log(`dshLinkRoot: ${status.dshLinkRoot}`);
console.log(`dashboard: ${status.dashboard.available ? '可用（T18）' : `降级（${status.dashboard.error}）`}`);
console.log(`bridge: pid=${status.bridge?.pid ?? '—'} uptime=${status.bridge?.uptimeMs ?? '—'}ms busy=${yesNo(status.bridge?.busy)}`);
console.log(`server: up=${yesNo(status.server?.up)} dshWeb=${status.server?.dshWeb ?? '—'} qqBridge=${status.server?.qqBridge ?? '—'} tunnel=${yesNo(status.server?.tunnel)}`);
console.log(`mood: ${status.mood?.label ?? '—'} (valence=${status.mood?.valence ?? '—'}, memory=${status.mood?.memoryCount ?? '—'})`);
console.log(`context: count=${status.context.count} events=${status.context.events.length}`);
for (const event of status.context.events) console.log(`  - [${event.surface}] ${event.summary}`);
console.log(`qq: ${status.qq.available ? `${status.qq.lines.length} 行（${status.qq.source}）` : `不可用：${status.qq.reason}`}`);
for (const line of status.qq.lines) console.log(`  - ${line}`);
console.log(`pet: online=${yesNo(status.pet.online)} wsChat=${status.pet.wsChat}`);
console.log(`paused: ${yesNo(status.paused.paused)} (${status.paused.path})`);
for (const [name, component] of Object.entries(status.components)) {
  console.log(`component.${name}: running=${yesNo(component.running)} pid=${component.pid ?? '—'}`);
}
console.log(`autostart: ${status.autostart.map((entry) => `${entry.label}=${entry.installed ? '✓' : '✗'}`).join(' ')}`);
console.log(`errors: ${status.errors.length === 0 ? '无' : status.errors.map((entry) => `${entry.field}: ${entry.message}`).join('; ')}`);
console.log(`tokenPresent: ${yesNo(status.tokenPresent)}`);
