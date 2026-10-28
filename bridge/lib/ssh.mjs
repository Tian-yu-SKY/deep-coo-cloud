// dsh-link/bridge/lib/ssh.mjs — SSH 隧道（自动重连）与一次性远程只读命令。
// 只用 node 内置模块；ssh 可执行文件从 PATH 解析（Windows 自带 OpenSSH / Linux 包）。
// 本文件不含任何主机/用户/密钥默认值 —— 全部来自 config.json。
import { spawn } from 'node:child_process';
import net from 'node:net';

const BASE_OPTS = (cfg) => {
  const options = [];
  if (typeof cfg.sshKey === 'string' && cfg.sshKey.trim() !== '') options.push('-i', cfg.sshKey);
  options.push(
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
  );
  if (typeof cfg.sshKnownHosts === 'string' && cfg.sshKnownHosts.trim() !== '') {
    options.push('-o', `UserKnownHostsFile=${cfg.sshKnownHosts}`);
  }
  options.push(
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  );
  return options;
};

/** 是否已配置可用的 SSH 目标（serverHost + sshUser）。 */
export function hasSshTarget(cfg) {
  return Boolean(cfg && typeof cfg.serverHost === 'string' && cfg.serverHost.trim()
    && typeof cfg.sshUser === 'string' && cfg.sshUser.trim());
}

/** 远程 shell 单引号转义，供 cat / sha256sum 等一次性命令使用。 */
export function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function probeTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export class SshManager {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.child = null;
    this.tunnelUp = false;
    this.stopping = false;
    this.backoffMs = 1000;
    this.port = cfg.localTunnelPort;
    this.portBumps = 0;
    this._readyWaiters = [];
    this._spawnedAt = 0;
  }

  get target() {
    return `${this.cfg.sshUser}@${this.cfg.serverHost}`;
  }

  start() {
    this.stopping = false;
    this.log.info(`ssh tunnel: 127.0.0.1:${this.port} -> ${this.cfg.serverHost}:127.0.0.1:${this.cfg.remoteDshPort} as ${this.target}`);
    this._spawnTunnel();
  }

  _spawnTunnel() {
    if (this.stopping) return;
    const args = [
      ...BASE_OPTS(this.cfg),
      '-o', 'ExitOnForwardFailure=yes',
      '-N',
      '-L', `127.0.0.1:${this.port}:127.0.0.1:${this.cfg.remoteDshPort}`,
      this.target,
    ];
    this._spawnedAt = Date.now();
    let stderrTail = '';
    const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (d) => {
      const text = d.toString().trim();
      if (text) this.log.debug(`ssh: ${text}`);
    });
    child.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (!text) return;
      stderrTail = `${stderrTail}\n${text}`.slice(-2000);
      this.log.warn(`ssh: ${text}`);
    });
    child.on('error', (error) => {
      this.log.error(`ssh spawn failed: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      const lifetime = Date.now() - this._spawnedAt;
      if (this.child === child) this.child = null;
      this.tunnelUp = false;
      if (this.stopping) return;
      // 端口被占用 / 转发失败：协议要求自增端口重试。
      if (lifetime < 8000 && /Address already in use|bind|forwarding|Permission denied|Cannot listen/i.test(stderrTail) && this.portBumps < 20) {
        this.portBumps += 1;
        this.port += 1;
        this.log.warn(`ssh tunnel bind failed; retry on 127.0.0.1:${this.port} (bump #${this.portBumps})`);
        setTimeout(() => this._spawnTunnel(), 500);
        return;
      }
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      this.log.warn(`ssh tunnel exited (code=${code} signal=${signal}); reconnect in ${delay}ms`);
      setTimeout(() => this._spawnTunnel(), delay);
    });
    // 等待端口真正可连（ssh -N 起来后代理端口由 ssh 自己 listen）。
    this._waitTunnelReady(15000).catch(() => { /* 由下一次重连兜底 */ });
  }

  async _waitTunnelReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) return false;
      if (await probeTcp('127.0.0.1', this.port, 800)) {
        this.tunnelUp = true;
        this.backoffMs = 1000;
        this.portBumps = 0;
        this.log.info(`ssh tunnel ready (127.0.0.1:${this.port})`);
        for (const waiter of this._readyWaiters.splice(0)) waiter(true);
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** 等待隧道首次可用；返回是否在同一轮内可用。 */
  waitUntilUp(timeoutMs = 20000) {
    if (this.tunnelUp) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.tunnelUp), timeoutMs);
      this._readyWaiters.push((ok) => { clearTimeout(timer); resolve(ok); });
    });
  }

  /** 一次性 ssh 远程命令（只读用途：读 .credentials.yaml / 角色卡 / sha256sum）。 */
  async capture(command, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const args = [...BASE_OPTS(this.cfg), this.target, command];
      const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error(`ssh capture timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`ssh capture spawn failed: ${error.message}`));
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`ssh capture failed (code ${code}): ${stderr.trim().slice(0, 300)}`));
      });
    });
  }

  stop() {
    this.stopping = true;
    this.tunnelUp = false;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
  }
}
