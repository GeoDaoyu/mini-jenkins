import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3081,
  repoPath: '',
  branch: '',
  remote: 'origin',
  appsDir: 'apps',
  deployRoot: '',
  pnpmBin: 'pnpm',
  installArgs: ['install', '--frozen-lockfile'],
  requireClean: false,
  pullTimeoutMinutes: 10,
  buildTimeoutMinutes: 30,
};

function fail(message) {
  throw new Error(`配置错误: ${message}`);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  fail(`无法把 "${value}" 解析为布尔值`);
}

function parsePositiveNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${field} 必须是正数`);
  return number;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port 必须是 1-65535 的整数');
  return port;
}

function assertRef(value, field) {
  if (typeof value !== 'string' || !REF_RE.test(value) || value.includes('..')) {
    fail(`${field} 不是合法的 git 引用: ${JSON.stringify(value)}`);
  }
  return value;
}

export function loadDotenv(file) {
  if (!fs.existsSync(file)) return false;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.warn(`无法读取 ${file}（${error.message}），将只使用已有环境变量。`);
    return false;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
  return true;
}

/**
 * Load and validate configuration. Environment variables win over config.json.
 */
export function loadConfig({ configPath, env = process.env } = {}) {
  const resolvedConfigPath = path.resolve(
    configPath || env.MINI_JENKINS_CONFIG || path.join(PROJECT_ROOT, 'config.json'),
  );
  if (!fs.existsSync(resolvedConfigPath)) {
    throw new Error(
      `找不到配置文件 ${resolvedConfigPath}，请先执行 cp config.example.json config.json 并修改路径。`,
    );
  }

  let fileConfig;
  try {
    fileConfig = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析配置文件 ${resolvedConfigPath}: ${error.message}`);
  }

  const config = { ...DEFAULTS, ...fileConfig };
  const baseDir = path.dirname(resolvedConfigPath);

  if (env.MINI_JENKINS_HOST) config.host = env.MINI_JENKINS_HOST;
  if (env.MINI_JENKINS_PORT) config.port = env.MINI_JENKINS_PORT;
  if (env.MINI_JENKINS_REPO_PATH) config.repoPath = env.MINI_JENKINS_REPO_PATH;
  if (env.MINI_JENKINS_DEPLOY_ROOT) config.deployRoot = env.MINI_JENKINS_DEPLOY_ROOT;
  if (env.MINI_JENKINS_BRANCH) config.branch = env.MINI_JENKINS_BRANCH;
  if (env.MINI_JENKINS_REMOTE) config.remote = env.MINI_JENKINS_REMOTE;
  if (env.MINI_JENKINS_PNPM) config.pnpmBin = env.MINI_JENKINS_PNPM;
  if (env.MINI_JENKINS_REQUIRE_CLEAN !== undefined) {
    config.requireClean = parseBoolean(env.MINI_JENKINS_REQUIRE_CLEAN, config.requireClean);
  }

  if (!config.repoPath) fail('repoPath 不能为空（也可以设置 MINI_JENKINS_REPO_PATH）');
  if (!config.deployRoot) fail('deployRoot 不能为空（也可以设置 MINI_JENKINS_DEPLOY_ROOT）');

  const repoPath = path.resolve(baseDir, config.repoPath);
  const deployRoot = path.resolve(baseDir, config.deployRoot);

  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    fail(`repoPath 不存在或不是目录: ${repoPath}`);
  }
  const appsDir = path.resolve(repoPath, config.appsDir);
  if (!fs.existsSync(appsDir) || !fs.statSync(appsDir).isDirectory()) {
    fail(`应用目录不存在: ${appsDir}`);
  }

  if (config.branch) assertRef(config.branch, 'branch');
  assertRef(config.remote, 'remote');
  if (typeof config.pnpmBin !== 'string' || !config.pnpmBin.trim() || config.pnpmBin.startsWith('-')) {
    fail('pnpmBin 必须是可执行文件名或路径');
  }
  if (!Array.isArray(config.installArgs) || config.installArgs.some((arg) => typeof arg !== 'string')) {
    fail('installArgs 必须是字符串数组');
  }

  const normalized = {
    ...config,
    host: String(config.host),
    port: parsePort(config.port),
    repoPath,
    deployRoot,
    branch: config.branch || '',
    remote: config.remote,
    appsDir: config.appsDir,
    appsPath: appsDir,
    pnpmBin: config.pnpmBin,
    installArgs: [...config.installArgs],
    requireClean: parseBoolean(config.requireClean, false),
    pullTimeoutMs: parsePositiveNumber(config.pullTimeoutMinutes, 'pullTimeoutMinutes') * 60_000,
    buildTimeoutMs: parsePositiveNumber(config.buildTimeoutMinutes, 'buildTimeoutMinutes') * 60_000,
    configPath: resolvedConfigPath,
    projectRoot: PROJECT_ROOT,
    publicDir: path.join(PROJECT_ROOT, 'public'),
  };

  return normalized;
}

export { NAME_RE };
