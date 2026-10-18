import fs from 'node:fs/promises';
import { currentHead, pullLatest } from './git.js';
import { publishDist } from './publisher.js';
import { runCommand, formatCommand, withoutControlEnv } from './runner.js';
import { CancelledError } from './errors.js';

function nowIso() {
  return new Date().toISOString();
}

function currentStage(job) {
  return job.stages.find((stage) => stage.status === 'running') ?? null;
}

function assertActive(ctx) {
  if (ctx.isCancelled()) throw new CancelledError();
}

function classifyPackageStream(line, stream) {
  if (stream !== 'stderr') return stream;
  if (/^\$ /.test(line) || /^> /.test(line)) return 'stdout';
  if (/\bWARN\b/i.test(line)) return 'warn';
  return stream;
}

function timeoutMessage(label, timeoutMs) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${label}超时（超过 ${minutes} 分钟）`;
}

async function runStage(job, ctx, stageId, action) {
  const stage = job.stages.find((item) => item.id === stageId);
  if (!stage || stage.status === 'skipped') return null;
  assertActive(ctx);

  stage.status = 'running';
  stage.startedAt = nowIso();
  stage.message = '';
  await ctx.touch();
  ctx.log(`▶ ${stage.label}`, 'stage');

  try {
    const result = await action(stage);
    stage.status = 'success';
    stage.message = result?.message ?? '';
    stage.finishedAt = nowIso();
    await ctx.touch();
    ctx.log(`✓ ${stage.label}完成${stage.message ? `（${stage.message}）` : ''}`, 'stdout');
    return result;
  } catch (error) {
    stage.status = ctx.isCancelled() ? 'canceled' : 'failed';
    stage.message = ctx.isCancelled() ? '已取消' : error.message;
    stage.finishedAt = nowIso();
    await ctx.touch();
    throw error;
  }
}

async function runPackageCommand(job, ctx, args, label, timeoutMs, env = {}) {
  const { config } = ctx;
  ctx.log(`$ ${formatCommand(config.pnpmBin, args)}`, 'stdout');
  const result = await runCommand({
    command: config.pnpmBin,
    args,
    cwd: config.repoPath,
    env: { ...withoutControlEnv(), ...env },
    inheritEnv: false,
    onLine: (line, stream) => ctx.log(line, classifyPackageStream(line, stream)),
    signal: ctx.signal,
    timeoutMs,
  });
  if (result.aborted) throw new CancelledError();
  if (result.timedOut) throw new Error(timeoutMessage(label, timeoutMs));
  if (result.code !== 0) {
    throw new Error(`${label}失败（退出码 ${result.code ?? result.signal}）`);
  }
  return result;
}

/**
 * Execute the pull → install → build → publish pipeline for one job.
 * `ctx` supplies cancellation, logging, and snapshot/persistence hooks.
 */
export async function runDeployment(job, ctx) {
  const { config } = ctx;
  let pullResult = null;

  if (!job.pull) {
    try {
      job.commitBefore = (await currentHead(config)) || null;
    } catch {
      /* commit is informational; a missing HEAD should not block the build */
    }
  }

  pullResult = await runStage(job, ctx, 'pull', async () => {
    const result = await pullLatest(config, {
      onLine: ctx.log,
      signal: ctx.signal,
      timeoutMs: config.pullTimeoutMs,
    });
    job.branch = result.branch;
    job.commitBefore = result.before;
    job.commitAfter = result.after;
    if (result.dependencyChanged && !job.install) {
      ctx.log('依赖清单有变化，建议下次部署勾选“重新安装依赖”。', 'warn');
    }
    return {
      message:
        result.before === result.after
          ? `已是最新 ${result.after.slice(0, 7)}`
          : `${result.before.slice(0, 7)} → ${result.after.slice(0, 7)}`,
    };
  });

  await runStage(job, ctx, 'install', async () => {
    const result = await runPackageCommand(
      job,
      ctx,
      config.installArgs,
      '依赖安装',
      config.buildTimeoutMs,
      { NO_COLOR: '1' },
    );
    return { message: `${(result.durationMs / 1000).toFixed(1)}s` };
  });

  await runStage(job, ctx, 'build', async () => {
    ctx.log(`清理旧构建产物：${job.distPath}`, 'stdout');
    await fs.rm(job.distPath, { recursive: true, force: true });
    const args = ['--filter', `./${config.appsDir}/${job.app}`, 'run', job.script];
    const result = await runPackageCommand(job, ctx, args, '构建', config.buildTimeoutMs, {
      NO_COLOR: '1',
    });
    return { message: `${(result.durationMs / 1000).toFixed(1)}s` };
  });

  await runStage(job, ctx, 'deploy', async () => {
    assertActive(ctx);
    const result = await publishDist({
      distPath: job.distPath,
      targetPath: job.targetPath,
      targetName: job.targetName,
      jobId: job.id,
      onLine: ctx.log,
      signal: ctx.signal,
    });
    job.artifact = { files: result.files, bytes: result.bytes };
    return { message: `${result.files} 个文件 · ${result.targetPath}` };
  });

  if (pullResult && job.commitAfter) {
    ctx.log(`本次发布提交：${job.commitAfter.slice(0, 7)}`, 'stage');
  }
  return { pullResult };
}
