#!/usr/bin/env node
// dsh-link/bridge/cli.mjs — bridge 命令行。
// 用法：
//   node bridge/cli.mjs health
//   node bridge/cli.mjs list
//   node bridge/cli.mjs ensure [--session <id>] [--preset <name>] [--cwd <path>]
//   node bridge/cli.mjs say "只回复 OK" [--session <id>] [--role-card auto|on|off] [--json]
//   node bridge/cli.mjs archive <sessionId>
//   node bridge/cli.mjs state
//   node bridge/cli.mjs diagnostics
// 说明：cli 只是本机 bridge HTTP API 的薄封装；bridge 没跑会提示先启动。
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_PATH } from './lib/config.mjs';
import { apiGet, apiPost, resolveBridgeBase } from './lib/http-client.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const positionals = [];
const options = {};
for (let index = 1; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[arg.slice(2)] = next;
        index += 1;
      } else {
        options[arg.slice(2)] = true;
      }
    }
  } else {
    positionals.push(arg);
  }
}

function usage() {
  console.log(`dsh-link bridge CLI
  node bridge/cli.mjs health
  node bridge/cli.mjs list
  node bridge/cli.mjs mood [--refresh] [--json]
  node bridge/cli.mjs dashboard [--json]
  node bridge/cli.mjs history [--session <id>] [--limit 200] [--before <messageId>] [--json]
  node bridge/cli.mjs context [--limit 20] [--json]
  node bridge/cli.mjs ensure [--session <id>] [--preset <name>] [--cwd <path>]
  node bridge/cli.mjs say "<text>" [--session <id>] [--role-card auto|on|off] [--json]
  node bridge/cli.mjs archive <sessionId>
  node bridge/cli.mjs unarchive <sessionId>
  node bridge/cli.mjs state
  node bridge/cli.mjs diagnostics

bridge 启动：node bridge/server.mjs`);
}

function glyph(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === null || value === undefined) return '-';
  return String(value);
}

function printList(data) {
  const rows = data.items ?? [];
  console.log(`会话数: ${data.count ?? rows.length}`);
  if (rows.length === 0) return;
  const header = ['sessionId', 'agentPreset', 'running', 'cwd', 'title'];
  const widths = header.map((title) => title.length);
  const cells = rows.map((item) => [item.sessionId, item.agentPreset, item.running, item.cwd, item.title]
    .map(glyph));
  for (const row of cells) {
    row.forEach((cell, index) => { widths[index] = Math.max(widths[index], Math.min(cell.length, 60)); });
  }
  const line = (row) => row.map((cell, index) => cell.slice(0, 60).padEnd(widths[index])).join('  ');
  console.log(line(header));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of cells) console.log(line(row));
}

async function main() {
  if (!command || command === 'help' || options.help === true) {
    usage();
    return 0;
  }
  const configPath = options.config ? path.resolve(String(options.config)) : DEFAULT_CONFIG_PATH;
  const { base, cfg } = await resolveBridgeBase(configPath);

  switch (command) {
    case 'health': {
      const value = await apiGet(base, '/health');
      console.log(JSON.stringify(value, null, 2));
      return value.ok === true ? 0 : 1;
    }
    case 'state': {
      console.log(JSON.stringify(await apiGet(base, '/state'), null, 2));
      return 0;
    }
    case 'mood': {
      const value = options.refresh === true
        ? await apiPost(base, '/mood/refresh', {}, { timeoutMs: (cfg.moodTimeoutMs ?? 45000) + 15000 })
        : await apiGet(base, '/mood', { timeoutMs: (cfg.moodTimeoutMs ?? 45000) + 15000 });
      if (options.json === true) {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(JSON.stringify(value.mood, null, 2));
        const meta = value.meta ?? {};
        if (meta.lastError) console.log(`meta.lastError: ${meta.lastError}`);
        console.log(`meta: lastRefreshAt=${meta.lastRefreshAt ?? '-'} lastSuccessAt=${meta.lastSuccessAt ?? '-'} tookMs=${meta.tookMs ?? '-'} nodeRows=${meta.nodeRows ?? '-'} dbBytes=${meta.dbBytes ?? '-'}`);
      }
      return value.ok === true ? 0 : 1;
    }
    case 'diagnostics': {
      console.log(JSON.stringify(await apiGet(base, '/diagnostics'), null, 2));
      return 0;
    }
    case 'list': {
      const data = await apiGet(base, '/sessions');
      if (options.json === true) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        printList(data);
      }
      return 0;
    }
    case 'ensure': {
      const body = {};
      if (options.session !== undefined) body.sessionId = String(options.session);
      if (options.preset !== undefined) body.agentPreset = String(options.preset);
      if (options.cwd !== undefined) body.cwd = String(options.cwd);
      const result = await apiPost(base, '/ensure', body);
      console.log(JSON.stringify(result, null, 2));
      return result.ok === true ? 0 : 1;
    }
    case 'history': {
      const params = new URLSearchParams();
      params.set('session', options.session !== undefined ? String(options.session) : cfg.sessionId);
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      if (options.before !== undefined) params.set('before', String(options.before));
      const data = await apiGet(base, `/history?${params.toString()}`, { timeoutMs: 60000 });
      if (options.json === true) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`sessionId=${data.sessionId} count=${data.messages.length} hasMore=${data.hasMore} nextBefore=${data.nextBefore ?? '-'} source=${data.source}`);
        for (const message of data.messages) {
          const time = message.at ? new Date(message.at).toISOString().slice(11, 19) : '--:--:--';
          console.log(`${time} [${String(message.role).padEnd(9)}] ${(message.text ?? '').replace(/\n/g, ' ').slice(0, 120)}`);
        }
      }
      return data.ok === true ? 0 : 1;
    }
    case 'say': {
      const text = options.text !== undefined ? String(options.text) : positionals.join(' ');
      if (!text.trim()) {
        console.error('ERROR: say 需要文本，例如 node bridge/cli.mjs say "只回复 OK"');
        return 1;
      }
      const body = { text };
      if (options.session !== undefined) body.sessionId = String(options.session);
      if (options['role-card'] !== undefined) {
        const mode = String(options['role-card']).toLowerCase();
        body.injectRoleCard = mode === 'auto' ? 'auto' : (mode === 'on' || mode === 'always' || mode === 'true');
      }
      const result = await apiPost(base, '/say', body, { timeoutMs: cfg.requestTimeoutMs + 30000 });
      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`sessionId: ${result.sessionId}`);
        console.log(`ms: ${result.ms}  deltas: ${result.deltas} (durable=${result.durableDeltas ?? '-'} stream=${result.streamDeltas ?? '-'})`);
        console.log(`role-card-injected: ${glyph(result.injected)}`);
        console.log(`context-injected: ${glyph(result.contextInjected)} (items=${result.contextItems ?? 0}, chars=${result.contextChars ?? 0})`);
        console.log('--- reply ---');
        console.log(result.text);
      }
      return 0;
    }
    case 'archive': {
      const sessionId = options.session !== undefined ? String(options.session) : positionals[0];
      if (!sessionId) {
        console.error('ERROR: archive 需要 sessionId');
        return 1;
      }
      const result = await apiPost(base, '/archive', { sessionId });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case 'context': {
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      const data = await apiGet(base, '/context?'.concat(params.toString()));
      if (options.json === true) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`context: count=${data.count} updatedAt=${data.updatedAt ?? '-'}`);
        for (const event of data.events ?? []) {
          console.log(`  [${event.surface}/${event.kind}] ${event.summary}  @${new Date(event.at).toISOString().slice(11, 19)}`);
        }
      }
      return 0;
    }
    case 'dashboard': {
      let token = '';
      try { token = fs.readFileSync(cfg.tokenFile, 'utf8').trim(); } catch { /* 下面会提示 */ }
      const data = await apiGet(base, `/dashboard?token=${encodeURIComponent(token)}`, { timeoutMs: 10000 });
      if (options.json === true) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const bridgeInfo = data.bridge ?? {};
        const serverInfo = data.server ?? {};
        const components = data.components ?? {};
        console.log(`bridge: pid=${bridgeInfo.pid} uptime=${Math.round((bridgeInfo.uptimeMs ?? 0) / 1000)}s version=${bridgeInfo.version} busy=${bridgeInfo.busy}`);
        console.log(`server: up=${serverInfo.up} dsh-web=${serverInfo.dshWeb ?? '-'} qq-bridge=${serverInfo.qqBridge ?? '-'} tunnel=${serverInfo.tunnel}`);
        console.log(`mood: ${data.mood ? `${data.mood.label}（v=${data.mood.valence} a=${data.mood.arousal} memories=${data.mood.memoryCount}）` : '-'}`);
        console.log(`context: count=${data.context?.count ?? 0} updatedAt=${data.context?.updatedAt ?? '-'}`);
        for (const event of data.context?.events ?? []) console.log(`  [${event.surface}] ${event.summary}`);
        console.log(`qq(${data.qq?.source ?? '-'}): ${data.qq?.lines?.length ?? 0} 行`);
        for (const line of data.qq?.lines ?? []) console.log(`  ${line}`);
        for (const [name, value] of Object.entries(components)) {
          console.log(`component ${name}: running=${value?.running ?? false} pid=${value?.pid ?? '-'} lastAt=${value?.lastAt ?? value?.lastWriteAt ?? value?.lastRunAt ?? '-'}`);
        }
        if (data.errors) console.log(`errors: ${JSON.stringify(data.errors)}`);
        console.log(`tookMs: ${data.tookMs ?? '-'}`);
      }
      return 0;
    }
    case 'unarchive': {
      const sessionId = options.session !== undefined ? String(options.session) : positionals[0];
      if (!sessionId) {
        console.error('ERROR: unarchive 需要 sessionId');
        return 1;
      }
      console.log(JSON.stringify(await apiPost(base, '/unarchive', { sessionId }), null, 2));
      return 0;
    }
    default: {
      console.error(`ERROR: 未知命令 ${command}`);
      usage();
      return 1;
    }
  }
}

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
