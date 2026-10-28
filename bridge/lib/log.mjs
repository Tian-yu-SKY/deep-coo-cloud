// dsh-link/bridge/lib/log.mjs — 文件日志（滚动上限默认 2MB）+ 控制台输出。
// 安全约束：任何 secret / token / cookie / 角色卡全文都不得进日志。
// 调用方只登记需要脱敏的字符串（addSecret），日志写入前统一替换成 ***。
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ file = null, maxBytes = 2 * 1024 * 1024, level = 'info' } = {}) {
  const secrets = new Set();
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  function rotateIfNeeded() {
    if (!file) return;
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < maxBytes) return;
    const rolled = `${file}.1`;
    try { fs.rmSync(rolled, { force: true }); } catch { /* ignore */ }
    try { fs.renameSync(file, rolled); } catch { /* ignore */ }
  }

  function redact(text) {
    let out = text;
    for (const secret of secrets) {
      if (secret.length >= 6 && out.includes(secret)) out = out.split(secret).join('***');
    }
    // 兜底：cookie 形态 v1.<base64url>.<base64url> 整体抹掉
    out = out.replace(/v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, 'v1.***.***');
    return out;
  }

  function write(levelName, message) {
    const line = `${new Date().toISOString()} ${levelName.toUpperCase()} ${redact(String(message))}\n`;
    if (file) {
      rotateIfNeeded();
      try { fs.appendFileSync(file, line); } catch { /* 日志失败不影响主流程 */ }
    }
    if (LEVELS[levelName] >= LEVELS[level]) process.stdout.write(line);
  }

  return {
    file,
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 6) secrets.add(secret);
    },
  };
}
