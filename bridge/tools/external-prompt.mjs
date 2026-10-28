#!/usr/bin/env node
// dsh-link/bridge/tools/external-prompt.mjs — 模拟「外部来源」客户端，直接向服务器 DSH 的 pet-local
// 发一条 prompt（**不经过 bridge 的 /say**），用来验证 bridge 的 /events 能否实时收到外部消息。
//
// 用法：
//   node tools/external-prompt.mjs "【外部来源测试】只回复：外部OK"
//   node tools/external-prompt.mjs "..." --session pet-local
//
// 说明：这是独立进程，自己走 SSH 隧道 + 离线铸 cookie + session/prompt；
// 与服务器 Web UI 发消息同一条 DSH API 路径，因此等价于「外部来源」。
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../lib/config.mjs';
import { createLogger } from '../lib/log.mjs';
import { SshManager, probeTcp } from '../lib/ssh.mjs';
import { DshClient } from '../lib/dsh.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const optionValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const text = positional[0] ?? '【外部来源测试】只回复：外部OK';
const cfg = loadConfig();
const sessionId = optionValue('--session') ?? cfg.sessionId;
const log = createLogger({ level: 'warn' }); // 不写 bridge.log，避免污染
// 复用 bridge 已建立的 SSH 隧道（127.0.0.1:<localTunnelPort>）：
// 本工具只借用隧道 + 自己铸 cookie，**不经过 bridge 的 /say**，等价于「另一个 DSH 客户端」。
const realSsh = new SshManager(cfg, log); // 不 start()：只用于 capture（读 secret/时钟），隧道用 bridge 的
const sshShim = {
  get port() { return cfg.localTunnelPort; },
  capture: (command, options) => realSsh.capture(command, options),
};
const client = new DshClient({ cfg, ssh: sshShim, log });

try {
  const reachable = await probeTcp('127.0.0.1', cfg.localTunnelPort, 1500);
  if (!reachable) throw new Error(`bridge 隧道 127.0.0.1:${cfg.localTunnelPort} 不可达（先启动 bridge）`);
  await client.ensureCookie();
  const requestId = randomUUID();
  await client.prompt({
    sessionId,
    content: [{ type: 'text', text }],
    requestId,
    mode: 'queue',
  });
  console.log(JSON.stringify({
    ok: true,
    via: 'external-client (direct DSH API via existing tunnel, bypassing bridge /say)',
    sessionId,
    requestId,
    text,
    note: 'bridge /events 应收到该 user 消息 + 随后的 assistant 回复',
  }, null, 2));
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
} catch (error) {
  console.error(`external-prompt 失败: ${error.message}`);
  process.exit(1);
}
