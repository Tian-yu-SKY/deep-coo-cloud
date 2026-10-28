#!/usr/bin/env node
// dsh-link/bridge/supervisor.mjs — 本机 bridge 守护进程（单实例）。
//
// 职责：每 intervalMs 探一次 bridge 的 `GET /health`；发现 bridge 崩溃 / 被杀 / 卡死时自动拉起。
// 启动：由 server.mjs 在启动时自举为 detached 子进程；也可以手动 `node supervisor.mjs`。
// 停止：`node supervisor.mjs --stop`（写停止标记 → 守护停掉 bridge 并退出；stop-bridge.cmd 是它的壳）。
//
// 单实例：supervisor.lock（lib/proc-lock.mjs，进程死了锁自动可回收）。
// 日志：logs/supervisor.log（1MB 滚动）。
//
// 测试/排障用环境变量（生产不要设）：
//   SUPERVISOR_INTERVAL_MS / SUPERVISOR_START_GRACE_MS / SUPERVISOR_SPAWN_GRACE_MS
//   SUPERVISOR_HANG_MS / SUPERVISOR_DOWN_CHECKS / SUPERVISOR_BOOT_WAIT_MAX_MS
//
// 退出码：0 = 正常；1 = 配置/启动错误（--once 模式下标示 bridge 不健康）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BRIDGE_DIR, loadConfig, DEFAULT_CONFIG_PATH } from './lib/config.mjs';
import { createLogger } from './lib/log.mjs';
import {
  acquireProcLock, isProcessAlive, isProcLockHeld, readProcLock, releaseProcLock,
} from './lib/proc-lock.mjs';

const SELF = fileURLToPath(import.meta.url);
const SERVER_JS = path.join(BRIDGE_DIR, 'server.mjs');
const LOCK_FILE = path.join(BRIDGE_DIR, 'supervisor.lock');
const STOP_FILE = path.join(BRIDGE_DIR, 'supervisor.stop');
const START_LOCK_FILE = path.join(BRIDGE_DIR, 'bridge.start.lock');
const SPEC = 'bridge-protocol-v1';

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const optValue = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const CONFIG_PATH = path.resolve(optValue('--config', DEFAULT_CONFIG_PATH));
const ONCE = hasFlag('--once');
const STOP = hasFlag('--stop');

const log = createLogger({
  file: path.join(BRIDGE_DIR, 'logs', 'supervisor.log'),
  maxBytes: 1024 * 1024,
  level: 'info',
});

const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const TIMING = {
  intervalMs: envInt('SUPERVISOR_INTERVAL_MS', 10000),
  startGraceMs: envInt('SUPERVISOR_START_GRACE_MS', 45000),
  spawnGraceMs: envInt('SUPERVISOR_SPAWN_GRACE_MS', 60000),
  hangMs: envInt('SUPERVISOR_HANG_MS', 60000),
  downChecks: envInt('SUPERVISOR_DOWN_CHECKS', 3),
  bootWaitMaxMs: envInt('SUPERVISOR_BOOT_WAIT_MAX_MS', 300000),
  healthTimeoutMs: envInt('SUPERVISOR_HEALTH_TIMEOUT_MS', 3000),
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ─────────────────────────── 健康检查 ───────────────────────────

/** 单次 GET /health；返回 { ok, body, port }；任何异常都不抛。 */
export function httpHealth(port, host = '127.0.0.1', timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const request = http.get({ host, port, path: '/health', timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          finish({
            ok: response.statusCode === 200 && parsed?.ok === true && parsed?.spec === SPEC,
            body: parsed,
            port,
          });
        } catch {
          finish({ ok: false, port });
        }
      });
      response.on('error', () => finish({ ok: false, port }));
    });
    request.on('timeout', () => { request.destroy(); finish({ ok: false, port }); });
    request.on('error', () => finish({ ok: false, port }));
  });
}

/** 读 state.json 里 bridge 实际监听的 apiPort（bridge 遇到端口占用会自增）。 */
export function readStatePort(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const port = Number(parsed?.apiPort);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** 探配置端口（以及 state.json 里记录的实际端口）；返回第一个健康的 bridge。 */
export async function probeHealth(cfg) {
  const ports = [...new Set([cfg.apiPort, readStatePort(cfg.stateFile)].filter((port) => Number.isInteger(port) && port > 0))];
  for (const port of ports) {
    const health = await httpHealth(port, cfg.listenHost || '127.0.0.1', TIMING.healthTimeoutMs);
    if (health.ok) return { ...health, configuredPort: port === cfg.apiPort };
  }
  return { ok: false, port: null };
}

// ─────────────────────────── 进程工具 ───────────────────────────

/** 结束进程及其子进程（Windows 用 taskkill /T；其它平台按进程组）。 */
function killTree(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (process.platform === 'win32') {
    // stdio: ignore（不用管道）——受限沙箱/无控制台的启动上下文里也能正常执行
    const result = spawnSync('taskkill', ['/PID', String(value), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (result.status === 0) return true;
  }
  try { process.kill(-value, 'SIGKILL'); return true; } catch { /* 不是进程组组长 */ }
  try { process.kill(value, 'SIGKILL'); return true; } catch { return false; }
}

/** bridge 被强杀时 ssh 子进程可能残留并占着隧道端口；重启前清掉（只认 ssh.exe，不动别的进程）。 */
function cleanupOrphanTunnel(cfg) {
  if (process.platform !== 'win32') return;
  if (!Number.isInteger(cfg.localTunnelPort) || cfg.localTunnelPort <= 0) return;
  try {
    const netstat = spawnSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'utf8' });
    const pattern = new RegExp(`127\\.0\\.0\\.1:${cfg.localTunnelPort}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    const line = String(netstat.stdout || '').split(/\r?\n/).find((item) => pattern.test(item));
    if (!line) return;
    const pid = Number(pattern.exec(line)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const tasklist = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' });
    if (!/^"?ssh/i.test(String(tasklist.stdout || '').trim())) return;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    log.warn(`清理残留 ssh 隧道进程 pid=${pid}（占用 127.0.0.1:${cfg.localTunnelPort}）`);
  } catch { /* 清理失败不影响拉起 */ }
}

// ─────────────────────────── 停止标记 ───────────────────────────

function stopRequested(startedAt) {
  try {
    const stat = fs.statSync(STOP_FILE);
    return stat.mtimeMs >= startedAt - 2000;
  } catch {
    return false;
  }
}

// ─────────────────────────── 守护主循环 ───────────────────────────

async function runSupervisor(cfg) {
  const lock = acquireProcLock(LOCK_FILE);
  if (!lock.acquired) {
    log.info(`已有 supervisor 在运行 pid=${lock.holder?.pid ?? '?'}，本进程退出`);
    return 0;
  }
  process.on('exit', () => releaseProcLock(LOCK_FILE));

  const startedAt = Date.now();
  try { fs.rmSync(STOP_FILE, { force: true }); } catch { /* ignore */ }
  log.info(`supervisor 启动 pid=${process.pid} interval=${TIMING.intervalMs}ms config=${CONFIG_PATH}`);

  let downChecks = 0;
  let everHealthy = false;
  let lastHealthyAt = 0;
  let knownBridgePid = null;
  let lastSpawnPid = null;
  let hangSince = 0;
  let spawnGraceUntil = startedAt + TIMING.startGraceMs;
  let fastExitStreak = 0;
  let lastHeartbeatAt = Date.now();
  let stop = false;

  const requestStop = () => { stop = true; };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  function spawnBridge(reason) {
    cleanupOrphanTunnel(cfg);
    const spawnedAt = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [SERVER_JS, '--config', CONFIG_PATH, '--supervised'], {
        cwd: BRIDGE_DIR,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      log.error(`bridge 启动失败（${reason}）: ${error.message}`);
      return null;
    }
    child.on('error', (error) => log.error(`bridge spawn error: ${error.message}`));
    child.on('exit', (code, signal) => {
      const lifetime = Date.now() - spawnedAt;
      log.warn(`bridge 进程退出 pid=${child.pid} code=${code} signal=${signal}（存活 ${Math.round(lifetime / 1000)}s）`);
      // 只有“启动后几秒内、从未健康过就退出”才是真·启动失败（配置错误 / 端口冲突等），需要冷却；
      // 已经健康过再被杀（taskkill / 崩溃）→ 立刻走正常重启路径，不等冷却。
      const healthyAfterSpawn = lastHealthyAt >= spawnedAt;
      if (!healthyAfterSpawn && lifetime < 5000) {
        fastExitStreak += 1;
        const coolDownMs = fastExitStreak >= 3 ? 300000 : 60000;
        spawnGraceUntil = Math.max(spawnGraceUntil, Date.now() + coolDownMs);
        log.warn(`bridge 启动后未健康即退出（连续 ${fastExitStreak} 次）→ ${Math.round(coolDownMs / 1000)}s 后再试；详情见 logs/bridge.log`);
      } else {
        fastExitStreak = 0;
      }
    });
    if (child.pid) child.unref();
    lastSpawnPid = child.pid ?? null;
    log.info(`已启动 bridge pid=${child.pid ?? '?'}（原因：${reason}）`);
    return child.pid ?? null;
  }

  async function stopEverything(reason) {
    log.info(`supervisor 停止中（${reason}）...`);
    const health = await probeHealth(cfg);
    const pid = (health.ok && Number(health.body?.pid)) || (lastSpawnPid && isProcessAlive(lastSpawnPid) ? lastSpawnPid : null);
    if (pid) {
      log.info(`停止 bridge pid=${pid}`);
      killTree(pid);
      for (let index = 0; index < 40; index += 1) {
        if (!isProcessAlive(pid)) break;
        await sleep(200);
      }
      if (isProcessAlive(pid)) killTree(pid);
    }
    try { fs.rmSync(STOP_FILE, { force: true }); } catch { /* ignore */ }
    releaseProcLock(LOCK_FILE);
  }

  while (!stop) {
    await sleep(TIMING.intervalMs);
    if (stop) break;
    if (stopRequested(startedAt)) {
      await stopEverything('收到停止标记');
      return 0;
    }
    const now = Date.now();
    const health = await probeHealth(cfg);

    if (health.ok) {
      if (!everHealthy) log.info(`bridge 健康 pid=${health.body?.pid} port=${health.port}`);
      everHealthy = true;
      downChecks = 0;
      hangSince = 0;
      fastExitStreak = 0;
      lastHealthyAt = now;
      knownBridgePid = Number(health.body?.pid) || knownBridgePid;
      if (health.configuredPort === false) {
        log.warn(`端口漂移：bridge 在 ${health.port}，配置 apiPort=${cfg.apiPort}；桌宠/面板固定连 ${cfg.apiPort} 会失败（请检查端口占用）`);
      }
      if (now - lastHeartbeatAt > 30 * 60 * 1000) {
        lastHeartbeatAt = now;
        log.info(`supervisor 心跳：bridge 健康 pid=${knownBridgePid} port=${health.port}`);
      }
      continue;
    }

    downChecks += 1;
    if (now < spawnGraceUntil) continue;

    // bridge 可能正在启动（登录自启刚拉起 / 刚被守护拉起）：start lock 新鲜且进程活着 → 给它时间
    const startLock = readProcLock(START_LOCK_FILE);
    const booting = isProcLockHeld(startLock, { staleMs: TIMING.bootWaitMaxMs });
    const recentlyHealthy = lastHealthyAt > 0 && now - lastHealthyAt < 10 * 60 * 1000;
    if (booting && !recentlyHealthy && startLock.startedAt > 0 && now - startLock.startedAt < TIMING.bootWaitMaxMs) {
      if (downChecks === TIMING.downChecks) log.info(`bridge 正在启动（pid=${startLock?.pid}，start lock 有效），继续等待`);
      spawnGraceUntil = now + Math.min(TIMING.startGraceMs, 15000);
      continue;
    }
    if (downChecks < TIMING.downChecks) continue;

    // 进程还活着但 /health 不通 → 卡死判定（给它 hangMs 观察期再强杀）
    const livePid = (knownBridgePid && isProcessAlive(knownBridgePid))
      ? knownBridgePid
      : (booting && startLock?.pid && isProcessAlive(startLock.pid) ? startLock.pid : null);
    if (livePid) {
      if (!hangSince) {
        hangSince = now;
        log.warn(`bridge pid=${livePid} 健康检查失败，观察 ${Math.round(TIMING.hangMs / 1000)}s 后再决定是否重启`);
      } else if (now - hangSince >= TIMING.hangMs) {
        log.error(`bridge pid=${livePid} 连续 ${Math.round((now - hangSince) / 1000)}s 无响应 → 判定卡死，强制结束并重启`);
        killTree(livePid);
        await sleep(2000);
        knownBridgePid = null;
        hangSince = 0;
        downChecks = 0;
        spawnGraceUntil = Date.now() + TIMING.spawnGraceMs;
        spawnBridge('hang-restart');
      }
      continue;
    }

    // 进程已不存在 → 自动拉起
    knownBridgePid = null;
    hangSince = 0;
    downChecks = 0;
    spawnGraceUntil = Date.now() + TIMING.spawnGraceMs;
    if (!spawnBridge('health-check-failed')) for (let index = 0; index < 3; index += 1) await sleep(1000);
  }

  await stopEverything('收到退出信号');
  return 0;
}

// ─────────────────────────── --stop 模式 ───────────────────────────

async function stopCommand() {
  try {
    fs.mkdirSync(path.dirname(STOP_FILE), { recursive: true });
    fs.writeFileSync(STOP_FILE, `${JSON.stringify({ at: Date.now(), by: 'supervisor --stop' })}\n`);
  } catch (error) {
    console.error(`[dsh-link-supervisor] 写停止标记失败: ${error.message}`);
  }

  const lock = readProcLock(LOCK_FILE);
  if (lock && isProcessAlive(lock.pid)) {
    console.log(`[dsh-link-bridge] 已通知 supervisor（pid=${lock.pid}）停止...`);
    for (let index = 0; index < 60; index += 1) {
      if (!isProcessAlive(lock.pid)) break;
      await sleep(250);
    }
    if (isProcessAlive(lock.pid)) {
      console.log('[dsh-link-bridge] supervisor 未按预期退出，强制结束');
      killTree(lock.pid);
    }
  } else {
    console.log('[dsh-link-bridge] 没有正在运行的 supervisor');
  }

  // 兜底：若仍有 bridge 在监听（例如刚启动、守护还没接手），直接结束它
  try {
    const cfg = loadConfig(CONFIG_PATH);
    const health = await probeHealth(cfg);
    if (health.ok && health.body?.pid) {
      console.log(`[dsh-link-bridge] 结束残留 bridge pid=${health.body.pid}`);
      killTree(Number(health.body.pid));
    }
  } catch { /* 配置坏了也要能停 */ }

  try { fs.rmSync(STOP_FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* ignore */ }
  console.log('[dsh-link-bridge] 已停止（supervisor + bridge）。');
  return 0;
}

// ─────────────────────────── 入口 ───────────────────────────

async function main() {
  if (STOP) return stopCommand();
  let cfg;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch (error) {
    log.error(`supervisor 读取配置失败: ${error.message}`);
    console.error(`[dsh-link-supervisor] 配置错误：${error.message}`);
    return 1;
  }
  if (ONCE) {
    const health = await probeHealth(cfg);
    console.log(JSON.stringify({ supervisor: { pid: process.pid }, ...health }, null, 2));
    return health.ok ? 0 : 1;
  }
  return runSupervisor(cfg);
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === SELF;
if (isMain) {
  main()
    .then((code) => { process.exit(code ?? 0); })
    .catch((error) => {
      log.error(`supervisor 崩溃: ${error?.stack ?? error}`);
      process.exit(1);
    });
}
