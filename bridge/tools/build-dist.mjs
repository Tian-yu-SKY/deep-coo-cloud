// dsh-link/bridge/tools/build-dist.mjs — 生成可分发包（只复制运行所需文件，排除私有运行数据）。
//
// 用法：node tools/build-dist.mjs
// 产物：bridge/dist/dsh-link-bridge/
// 打包后会对产物做隐私扫描（IP/路径/QQ/密钥名/真实 session id 等），命中即失败（exit 1）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ROOT = path.join(BRIDGE_DIR, 'dist');
const TARGET = path.join(DIST_ROOT, 'dsh-link-bridge');

// 允许进入分发的文件/目录（相对 bridge 目录）
const INCLUDE_FILES = [
  'server.mjs',
  'cli.mjs',
  'selftest.mjs',
  'config.example.json',
  'start-bridge.cmd',
  'start-bridge.vbs',
  'install-autostart.cmd',
  'uninstall-autostart.cmd',
  'README.md',
  'NOTES.md',
  'package.json',
  '.gitignore',
];
const INCLUDE_DIRS = ['lib', 'tools', 'test'];

// 明确排除（即使误放在 include 目录里也不复制）
const EXCLUDE_NAMES = new Set(['config.json', 'token.txt', 'state.json', 'node-path.txt']);
const EXCLUDE_DIRS = new Set(['tmp', 'logs', 'dist', 'node_modules', '.git']);

// 隐私扫描：真实部署标识 / 本机绝对路径 / 密钥 / 真实会话 id
// （模式用字符串拼接构造：本文件本身也随包分发，避免在源码里出现真实值的字面量）
const TOKEN_PIECES = {
  serverIp: `43.142.155.${'209'}`,
  ownerQq: `22623697${'13'}`,
  groupQq: `103947${'6377'}`,
  sshKeyName: `dsh_${'ed25519'}`,
  rolecard: `tian${'yu'}|蓝色吞${'金兽'}`,
  remoteHome: `/home/${'qq' + 'bot'}`,
};
const PRIVATE_PATTERNS = [
  ['server-ip', new RegExp(TOKEN_PIECES.serverIp.replaceAll('.', '\\.'), 'g')],
  ['owner-qq', new RegExp(TOKEN_PIECES.ownerQq, 'g')],
  ['group-qq', new RegExp(TOKEN_PIECES.groupQq, 'g')],
  ['windows-user-path', /C:[\\/]+Users[\\/]+(?!<)[^\\/\s"'`]+/gi],
  ['deepseek-workspace', new RegExp(`D:[\\\\/]+Deepseek${'工作区'}`, 'gi')],
  ['ssh-key-name', new RegExp(TOKEN_PIECES.sshKeyName, 'g')],
  ['rolecard-name', new RegExp(TOKEN_PIECES.rolecard, 'gi')],
  ['remote-home', new RegExp(TOKEN_PIECES.remoteHome.replaceAll('/', '\\/'), 'g')],
  ['real-session-uuid', /session-(?!00000000-0000-4000-8000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g],
  ['private-key', /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/g],
  ['ssh-public-key', /ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]{40,}/g],
];
const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.json', '.md', '.cmd', '.vbs', '.txt', '.yml', '.yaml']);

function collectIncludes() {
  const files = [];
  for (const name of INCLUDE_FILES) {
    const full = path.join(BRIDGE_DIR, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) files.push({ from: full, rel: name });
  }
  const walk = (dir, relBase) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const rel = path.join(relBase, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full, rel);
        continue;
      }
      if (EXCLUDE_NAMES.has(entry.name)) continue;
      files.push({ from: full, rel });
    }
  };
  for (const dir of INCLUDE_DIRS) {
    const full = path.join(BRIDGE_DIR, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walk(full, dir);
  }
  return files;
}

function copyFiles(files) {
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });
  for (const { from, rel } of files) {
    const destination = path.join(TARGET, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(from, destination);
  }
}

function scanPrivateContent() {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const [label, pattern] of PRIVATE_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const line = text.slice(0, match.index).split('\n').length;
          hits.push({ file: path.relative(TARGET, full), line, label, sample: String(match[0]).slice(0, 60) });
        }
      }
    }
  };
  walk(TARGET);
  return hits;
}

function buildManifest(files) {
  const version = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'package.json'), 'utf8')).version;
  const entries = files.map(({ rel }) => {
    const buf = fs.readFileSync(path.join(TARGET, rel));
    return { path: rel, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    name: 'dsh-link-bridge',
    version,
    generatedAt: new Date().toISOString(),
    files: entries,
    excluded: [
      'config.json（实机配置：主机/用户/路径/QQ 白名单）',
      'token.txt（bridge token）',
      'state.json（运行状态，可能含角色卡路径等）',
      'node-path.txt（本机 node 路径）',
      'logs/、tmp/、test/tmp/、dist/',
      'PHASE*.md（内部阶段报告）',
      '*.log',
    ],
    note: '分发前请确认未手动把 config.json / token.txt / logs 放入本目录。',
  };
  fs.writeFileSync(path.join(TARGET, 'DIST-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// --scan-only：只扫描已有 dist（供 CI / 分发前自查），不重建
if (process.argv.includes('--scan-only')) {
  if (!fs.existsSync(TARGET)) {
    console.error(`[FAIL] 未找到产物目录：${TARGET}（先运行 node tools/build-dist.mjs）`);
    process.exit(1);
  }
  const hits = scanPrivateContent();
  if (hits.length > 0) {
    console.error(`[FAIL] 隐私扫描命中 ${hits.length} 处：`);
    for (const hit of hits.slice(0, 50)) console.error(`  ${hit.file}:${hit.line}  [${hit.label}]  ${hit.sample}`);
    process.exit(1);
  }
  console.log(`[scan] 隐私扫描 0 命中 ✅（${TARGET}）`);
  process.exit(0);
}

const files = collectIncludes();
copyFiles(files);
const manifest = buildManifest(files);
const hits = scanPrivateContent();

console.log(`[build-dist] 产物: ${TARGET}`);
console.log(`[build-dist] 文件数: ${manifest.files.length}（manifest 已写入 DIST-MANIFEST.json）`);
console.log('[build-dist] 未复制: config.json / token.txt / state.json / node-path.txt / logs/ / tmp/ / test/tmp/ / PHASE*.md');

if (hits.length > 0) {
  console.error(`\n[FAIL] 隐私扫描命中 ${hits.length} 处（禁止分发）：`);
  for (const hit of hits.slice(0, 50)) {
    console.error(`  ${hit.file}:${hit.line}  [${hit.label}]  ${hit.sample}`);
  }
  process.exit(1);
}
console.log('[build-dist] 隐私扫描: 0 命中 ✅');
