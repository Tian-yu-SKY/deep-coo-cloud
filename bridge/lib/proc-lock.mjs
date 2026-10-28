// dsh-link/bridge/lib/proc-lock.mjs — 进程级锁文件（单实例 / 启动窗口互斥）。
// 只用 node 内置模块；不依赖任何第三方包。
//
// 锁文件内容：{ "pid": 1234, "startedAt": 1700000000000 }
// 判定规则：
//   - pid 进程还活着（且可选：锁未超过 staleMs）→ 视为已被持有；
//   - pid 已死（或锁过期）→ 视为陈旧锁，可清理后重新获取。
import fs from 'node:fs';
import path from 'node:path';

/** pid 对应的进程是否还活着（Windows/Linux 通用）。EPERM = 进程存在但无权限，按存活处理。 */
export function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 读锁文件；不存在 / 坏 JSON / 无 pid 返回 null。 */
export function readProcLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { ...parsed, pid, startedAt: Number(parsed.startedAt) || 0 };
  } catch {
    return null;
  }
}

/** 锁是否有效：进程活着；给了 staleMs 时还要锁龄未超过它（0 = 不看锁龄）。 */
export function isProcLockHeld(lock, { staleMs = 0 } = {}) {
  if (!lock) return false;
  if (!isProcessAlive(lock.pid)) return false;
  if (staleMs > 0 && lock.startedAt > 0 && Date.now() - lock.startedAt > staleMs) return false;
  return true;
}

/**
 * 尝试原子获取锁文件（open wx）。
 * - 成功：{ acquired: true }
 * - 已被活进程持有：{ acquired: false, holder }
 * - 并发写入中的空/半截文件（5s 内）：也按“已有进程在占”处理，避免抢锁竞态
 */
export function acquireProcLock(file, { staleMs = 0 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const holder = readProcLock(file);
      if (isProcLockHeld(holder, { staleMs })) return { acquired: false, holder };
      // 文件存在但读不出内容：可能是另一个进程刚 wx 建好还没写完，短暂让行。
      if (!holder) {
        try {
          const stat = fs.statSync(file);
          if (Date.now() - stat.mtimeMs < 5000) return { acquired: false, holder: null };
        } catch { /* 文件刚被删掉，重试 */ }
      }
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }
  return { acquired: false, holder: readProcLock(file) };
}

/** 释放锁（只删除确实属于自己的锁；其他进程持有的锁不动）。 */
export function releaseProcLock(file, pid = process.pid) {
  const lock = readProcLock(file);
  if (lock && lock.pid !== pid) return false;
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  return true;
}
