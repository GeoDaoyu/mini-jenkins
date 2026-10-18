import { runCommand } from './runner.js';

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

function redactCredentials(text) {
  return text.replace(/(https?:\/\/)[^/\s@]+@/g, '$1***@');
}

function classifyGitStream(line, stream) {
  if (stream !== 'stderr') return stream;
  if (/(^|\b)(error|fatal|denied|conflict|rejected|aborting)(\b|:)/i.test(line)) return 'stderr';
  if (/(^|\b)warning(\b|:)/i.test(line)) return 'warn';
  return 'stdout';
}

export class GitError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.detail = detail;
  }
}

async function capture(config, args, { timeoutMs = 20_000 } = {}) {
  const lines = [];
  const result = await runCommand({
    command: 'git',
    args,
    cwd: config.repoPath,
    env: GIT_ENV,
    timeoutMs,
    onLine: (line, stream) => {
      if (stream === 'stdout') lines.push(line);
    },
  });
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(' ')} 失败（退出码 ${result.code ?? 'signal'}）`, {
      code: result.code,
      detail: lines.join('\n'),
    });
  }
  return lines.join('\n').trim();
}

async function headCommit(config) {
  try {
    return await capture(config, ['rev-parse', 'HEAD']);
  } catch {
    return '';
  }
}

export async function readRepoInfo(config) {
  const branch = await capture(config, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await capture(config, ['rev-parse', 'HEAD']);
  const log = await capture(config, ['log', '-1', '--format=%H%x00%s%x00%cI']);
  const [fullHash = head, subject = '', committedAt = ''] = log.split('\x00');
  const status = await capture(config, ['status', '--porcelain=v1']);
  const dirtyFiles = status ? status.split('\n').filter(Boolean) : [];

  return {
    branch,
    expectedBranch: config.branch || branch,
    branchMatches: !config.branch || config.branch === branch,
    detached: branch === 'HEAD',
    commit: fullHash,
    shortCommit: fullHash.slice(0, 7),
    subject,
    committedAt,
    dirty: dirtyFiles.length > 0,
    dirtyCount: dirtyFiles.length,
    dirtyFiles: dirtyFiles.slice(0, 10),
  };
}

export async function pullLatest(config, { onLine = () => {}, signal, timeoutMs } = {}) {
  const info = await readRepoInfo(config);
  if (info.detached) {
    throw new GitError('仓库处于 detached HEAD 状态，无法自动拉取。请先切换到部署分支。');
  }
  const branch = config.branch || info.branch;
  if (config.branch && info.branch !== config.branch) {
    throw new GitError(
      `仓库当前分支是 ${info.branch}，但配置要求 ${config.branch}。请先执行 git checkout ${config.branch}。`,
    );
  }
  if (config.requireClean && info.dirty) {
    throw new GitError(
      `工作区有 ${info.dirtyCount} 个未提交改动，requireClean 已开启，已停止拉取。`,
      { detail: info.dirtyFiles.join('\n') },
    );
  }
  if (info.dirty) {
    onLine(`工作区有 ${info.dirtyCount} 个未提交改动，继续尝试快进合并。`, 'warn');
  }

  const before = info.commit;
  onLine(`当前分支 ${branch}，HEAD ${before.slice(0, 7)}`, 'stdout');
  onLine(`git pull --ff-only ${config.remote} ${branch}`, 'stdout');

  const result = await runCommand({
    command: 'git',
    args: ['pull', '--ff-only', '--no-rebase', '--progress', config.remote, branch],
    cwd: config.repoPath,
    env: GIT_ENV,
    onLine: (line, stream) =>
      onLine(redactCredentials(line), classifyGitStream(line, stream)),
    signal,
    timeoutMs,
  });

  if (result.aborted) throw new GitError('拉取代码已取消');
  if (result.timedOut) throw new GitError('拉取代码超时');
  if (result.code !== 0) {
    throw new GitError(
      `拉取代码失败（退出码 ${result.code ?? 'signal'}）。如果本地有未提交改动，请先在服务器上处理。`,
      { code: result.code },
    );
  }

  const after = await headCommit(config);
  let changedFiles = [];
  if (before && after && before !== after) {
    try {
      const diff = await capture(config, ['diff', '--name-only', before, after]);
      changedFiles = diff ? diff.split('\n').filter(Boolean) : [];
    } catch (error) {
      onLine(`无法读取本次变更文件列表：${error.message}`, 'warn');
    }
  }
  const dependencyChanged = changedFiles.some(
    (file) => file === 'pnpm-lock.yaml' || file === 'package.json' || file.endsWith('/package.json'),
  );

  if (before === after) onLine('代码已是最新，没有新的提交。', 'stdout');
  else onLine(`代码已更新：${before.slice(0, 7)} → ${after.slice(0, 7)}（${changedFiles.length} 个文件）`, 'stdout');

  return { branch, before, after, changedFiles, dependencyChanged, info };
}

export async function currentHead(config) {
  return headCommit(config);
}
