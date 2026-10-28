/**
 * dsh-link/context-observer/tools/stop.mjs — 停止正在运行的观察器（读 observer.lock 里的 pid）。
 *
 * Windows 上 process.kill(pid) 是硬终止（观察器收不到 SIGTERM），所以这里顺手删掉锁文件，
 * 避免留下陈旧锁；下次启动本来也会自动接管陈旧锁。
 *
 * 用法：node tools/stop.mjs
 * 退出码：0 已停止 / 本来就没在跑；2 锁里没有 pid；1 其他失败。
 */

import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(path.dirname(HERE), 'observer.lock');

function removeLock() {
  try {
    unlinkSync(LOCK_FILE);
    return true;
  } catch {
    return false;
  }
}

let info;
try {
  info = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
} catch (error) {
  if (error && error.code === 'ENOENT') {
    console.log('[INFO] 观察器没有在运行（无 observer.lock）');
    process.exit(0);
  }
  console.log(`[FAIL] 读不到 observer.lock：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const pid = Number(info?.pid);
if (!Number.isFinite(pid) || pid <= 0) {
  console.log('[WARN] observer.lock 里没有合法 pid');
  removeLock();
  process.exit(2);
}

try {
  process.kill(pid);
  removeLock();
  console.log(`[OK] 已停止观察器 pid=${pid}`);
  process.exit(0);
} catch (error) {
  if (error && error.code === 'ESRCH') {
    removeLock();
    console.log(`[INFO] 观察器已退出（陈旧锁 pid=${pid}，已清理）`);
    process.exit(0);
  }
  console.log(`[FAIL] 停止 pid=${pid} 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
