// dsh-link/bridge/lib/http-client.mjs — CLI/selftest 访问本机 bridge HTTP API 的小工具。
import fs from 'node:fs';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.mjs';

/** 找到正在运行的 bridge：优先 state.json 记录的 apiPort，再退回 config.apiPort。 */
export async function resolveBridgeBase(configPath = DEFAULT_CONFIG_PATH) {
  const cfg = loadConfig(configPath);
  const candidates = [];
  try {
    const state = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    if (Number.isInteger(state?.apiPort)) candidates.push(state.apiPort);
  } catch { /* state 可能还不存在 */ }
  if (!candidates.includes(cfg.apiPort)) candidates.push(cfg.apiPort);
  for (const port of candidates) {
    try {
      const response = await fetch(`http://${cfg.listenHost}:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return { base: `http://${cfg.listenHost}:${port}`, port, cfg };
    } catch { /* 试下一个 */ }
  }
  throw new Error(`bridge 未运行（尝试端口 ${candidates.join('/')} 均失败）：请先执行 node bridge/server.mjs`);
}

export async function apiGet(base, route, { timeoutMs = 30000 } = {}) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(timeoutMs) });
  return parseResponse(route, response);
}

export async function apiPost(base, route, body, { timeoutMs = 30000 } = {}) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseResponse(route, response);
}

async function parseResponse(route, response) {
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${route} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  if (!response.ok || value?.ok === false) {
    const error = value?.error ?? {};
    const err = new Error(`${route} 失败 (HTTP ${response.status}, ${error.code ?? 'unknown'}): ${error.message ?? 'unknown error'}`);
    err.code = error.code;
    throw err;
  }
  return value;
}
