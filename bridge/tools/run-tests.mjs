// dsh-link/bridge/tools/run-tests.mjs — 语法检查 + 全部单测（跨平台，无第三方依赖）。
//
// 用法：
//   node tools/run-tests.mjs               # 语法检查 + 跑 test/*.test.mjs
//   node tools/run-tests.mjs --check-only  # 只做语法检查
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['tmp', 'dist', 'logs', 'node_modules', '.git']);
const CHECK_ONLY = process.argv.includes('--check-only');

function walk(dir, filter) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walk(full, filter));
    } else if (filter(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const mjsFiles = walk(BRIDGE_DIR, (name) => name.endsWith('.mjs')).sort();
const testFiles = walk(path.join(BRIDGE_DIR, 'test'), (name) => name.endsWith('.test.mjs')).sort();

let failed = 0;
console.log(`[check] node --check：${mjsFiles.length} 个 .mjs`);
for (const file of mjsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`  FAIL  ${path.relative(BRIDGE_DIR, file)}\n${result.stderr ?? ''}`);
  }
}
if (failed === 0) console.log(`[check] 全部通过（${mjsFiles.length}/${mjsFiles.length}）`);

if (!CHECK_ONLY) {
  console.log(`\n[test] 单测文件：${testFiles.length} 个`);
  for (const file of testFiles) {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
    const took = Date.now() - startedAt;
    if (result.status !== 0) {
      failed += 1;
      console.error(`  FAIL  ${path.relative(BRIDGE_DIR, file)}（exit=${result.status ?? result.signal}）`);
    } else {
      console.log(`  OK    ${path.relative(BRIDGE_DIR, file)}（${took}ms）`);
    }
  }
}

if (failed > 0) {
  console.error(`\n[FAIL] ${failed} 项失败`);
  process.exit(1);
}
console.log('\n[OK] 全部检查/测试通过');
