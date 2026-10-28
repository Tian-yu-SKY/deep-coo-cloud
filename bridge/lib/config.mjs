// dsh-link/bridge/lib/config.mjs — 配置加载（server.mjs / cli.mjs / selftest.mjs / tools 共用）。
//
// 分发原则：本文件及所有默认值**不含任何部署隐私**（主机/IP/用户/QQ/私有路径/密钥名）。
// 私有信息只允许出现在运行期的 `config.json`（打包排除，见 `tools/build-dist.mjs`）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG_PATH = path.join(BRIDGE_DIR, 'config.json');
export const EXAMPLE_CONFIG_PATH = path.join(BRIDGE_DIR, 'config.example.json');

/** 配置错误（可读提示，调用方捕获后打印，不让进程抛栈崩溃）。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PLACEHOLDER_PATTERN = /^<[^>]*>$/;
const isPlaceholder = (value) => typeof value === 'string' && PLACEHOLDER_PATTERN.test(value.trim());

const REQUIRED_FIELDS = [
  ['serverHost', '远程服务器地址（host 或 IP）'],
  ['sshUser', 'SSH 登录用户'],
  ['sshKey', 'SSH 私钥路径'],
  ['remoteCredentialsPath', '远端 DSH 凭据文件路径（如 <remote-home>/.dsh/.credentials.yaml）'],
  ['cwd', '远端会话工作目录（如 <remote-home>）'],
];

const LOCAL_PATH_FIELDS = ['tokenFile', 'stateFile', 'logFile', 'sshKey', 'sshKnownHosts'];

/** 相对路径按 bridge 目录解析（分发到任何目录都能跑）；空值/占位保持原样。 */
function resolveLocalPath(value) {
  if (typeof value !== 'string' || value.trim() === '' || isPlaceholder(value)) return value;
  return path.isAbsolute(value) ? value : path.resolve(BRIDGE_DIR, value);
}

function defaultCfg() {
  return {
    // ── 必填（没有通用默认值；缺了会给出可读错误）──
    serverHost: '',
    sshUser: '',
    sshKey: '',
    remoteCredentialsPath: '',
    cwd: '',
    // ── 连接 / 端口 ──
    sshKnownHosts: '',            // 可选；留空则用 ssh 默认 known_hosts
    remoteDshPort: 3080,
    localTunnelPort: 13380,
    listenHost: '127.0.0.1',
    apiPort: 47891,
    // ── 本机文件（默认放 bridge 目录，随包不带数据）──
    tokenFile: path.join(BRIDGE_DIR, 'token.txt'),
    stateFile: path.join(BRIDGE_DIR, 'state.json'),
    logFile: path.join(BRIDGE_DIR, 'logs', 'bridge.log'),
    maxLogBytes: 2 * 1024 * 1024,
    // ── 会话 / 人格（均为通用示例值，跨部署无隐私）──
    sessionId: 'pet-local',
    agentPreset: 'local-pet',
    roleCardPath: '',             // 留空 = 不做角色卡注入
    roleCardMode: 'once',
    requestTimeoutMs: 240000,
    followSnapshotMessages: 10,
    ensureOnStart: false,
    followSessionIds: ['pet-local'],
    messageCacheMax: 1000,
    historyDefaultLimit: 100,
    forbiddenSessionIds: [],
    // ── 心情（只读 deep-soul mind.db；留空 = 关闭）──
    mindDbPath: '',
    moodEnabled: true,
    moodIntervalMs: 60000,
    moodTimeoutMs: 45000,
    moodHalfLifeDays: 7,
    // ── 情境总线 ──
    contextInjection: true,
    contextMaxEvents: 120,
    contextTtlMs: 60 * 60 * 1000,
    contextInjectMaxChars: 600,
    contextInjectMaxItems: 6,
    // ── 总控台 /dashboard（QQ 预览留空/占位 = 不输出任何 QQ 行）──
    dashboardServerStatusTtlMs: 30000,
    dashboardQqTtlMs: 20000,
    dashboardComponentsTtlMs: 10000,
    dashboardSshTimeoutMs: 6000,
    dashboardColdBudgetMs: 1800,
    qqSocialFile: '',             // 留空 = 关闭 QQ 预览
    qqActivityFile: '',
    qqPreviewChats: [],           // 空数组 = 不预览任何私聊（安全默认）
    qqPreviewGroups: [],
    qqPreviewGroup: false,
    qqPreviewIncludeSelf: true,
    qqPreviewMaxChars: 60,
    qqPreviewLineMaxChars: 60,
    qqPreviewMinTextChars: 4,
    qqPreviewMaxItems: 4,
    qqWindowMinutes: 90,
    dashboardPaths: {
      observerDir: '../context-observer',
      syncDir: '../server/awareness',
      mirrorDir: '../session-mirror',
    },
  };
}

/**
 * 读取 config.json 并补默认值；缺文件 / 缺必填 / 仍是占位值时抛 `ConfigError`（可读提示）。
 * @param {string} file 配置文件路径（默认 bridge/config.json）
 */
export function loadConfig(file = DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ConfigError(
        `未找到配置文件：${file}\n`
        + `请先复制模板并填写：\n`
        + `  cp "${EXAMPLE_CONFIG_PATH}" "${file}"\n`
        + `必填字段：${REQUIRED_FIELDS.map(([key]) => key).join('、')}；`
        + `留空即关闭的可选功能：roleCardPath / mindDbPath / qqSocialFile 等。`,
      );
    }
    throw new ConfigError(`无法读取配置文件 ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON（${file}）：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`配置文件顶层必须是 JSON 对象（${file}）`);
  }

  const cfg = { ...defaultCfg(), ...parsed };
  // 本机文件路径：相对 bridge 目录解析（配置里可写相对路径）
  for (const field of LOCAL_PATH_FIELDS) cfg[field] = resolveLocalPath(cfg[field]);
  // 可选远程路径：模板占位值视为「未配置/关闭」，避免拿"<...>"去 SSH 访问
  for (const field of ['roleCardPath', 'mindDbPath', 'qqSocialFile', 'qqActivityFile']) {
    if (isPlaceholder(cfg[field])) cfg[field] = '';
  }
  if (isPlaceholder(cfg.sshKnownHosts)) cfg.sshKnownHosts = '';

  const problems = [];
  for (const [field, description] of REQUIRED_FIELDS) {
    const value = cfg[field];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`缺少必填字段 ${field}（${description}）`);
      continue;
    }
    if (isPlaceholder(value)) {
      problems.push(`字段 ${field} 仍是占位值 ${JSON.stringify(value)}，请填写真实值（${description}）`);
    }
  }
  if (!Array.isArray(cfg.forbiddenSessionIds)) cfg.forbiddenSessionIds = [];
  if (!Array.isArray(cfg.followSessionIds)) cfg.followSessionIds = ['pet-local'];
  if (!Array.isArray(cfg.qqPreviewChats)) cfg.qqPreviewChats = [];
  if (!Array.isArray(cfg.qqPreviewGroups)) cfg.qqPreviewGroups = [];
  if (cfg.apiPort === cfg.localTunnelPort) cfg.apiPort += 1;
  if (problems.length > 0) {
    throw new ConfigError(
      `配置文件 ${file} 不完整：\n- ${problems.join('\n- ')}\n`
      + `可参考模板：${EXAMPLE_CONFIG_PATH}`,
    );
  }
  return cfg;
}

/** 供 --check-config / 测试用的轻量校验（loadConfig 已含同样检查）。 */
export function configProblems(cfg) {
  const problems = [];
  for (const [field, description] of REQUIRED_FIELDS) {
    if (typeof cfg?.[field] !== 'string' || cfg[field].trim() === '') problems.push(`缺少 ${field}（${description}）`);
    else if (isPlaceholder(cfg[field])) problems.push(`${field} 仍是占位值`);
  }
  return problems;
}
