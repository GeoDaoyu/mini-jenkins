import { randomBytes } from 'node:crypto';
import { pickVariant } from './discovery.js';
import { runDeployment } from './deploy-runner.js';
import { CancelledError, UserError } from './errors.js';
import { isFinished } from './job-status.js';

const MAX_EVENTS = 6000;
const MAX_LOG_LINES = 5000;
const MAX_QUEUED_JOBS = 20;
const STAGE_LABELS = {
  pull: '拉取代码',
  install: '安装依赖',
  build: '构建',
  deploy: '发布',
};

function nowIso() {
  return new Date().toISOString();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function logTime() {
  const date = new Date();
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function makeStages(pull, install) {
  return ['pull', 'install', 'build', 'deploy'].map((id) => {
    const skipped = (id === 'pull' && !pull) || (id === 'install' && !install);
    return {
      id,
      label: STAGE_LABELS[id],
      status: skipped ? 'skipped' : 'pending',
      startedAt: null,
      finishedAt: null,
      message: skipped ? '未勾选，已跳过' : '',
    };
  });
}

function markRemainingStages(job, status, message) {
  const stamp = nowIso();
  for (const stage of job.stages) {
    if (stage.status !== 'pending' && stage.status !== 'running') continue;
    stage.status = status;
    stage.message = message;
    stage.finishedAt = stamp;
  }
}

function currentStage(job) {
  return job.stages.find((stage) => stage.status === 'running') ?? null;
}

function serializedStage(stage) {
  return {
    id: stage.id,
    label: stage.label,
    status: stage.status,
    startedAt: stage.startedAt ?? null,
    finishedAt: stage.finishedAt ?? null,
    message: stage.message ?? '',
  };
}

export class JobManager {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
    this.jobs = [];
    this.pending = [];
    this.active = null;
    this.pumping = false;
    this.runPromise = null;
  }

  nextJobId() {
    const date = new Date();
    const base = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
      date.getHours(),
    )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = `${base}-${randomBytes(2).toString('hex')}`;
      if (!this.jobs.some((job) => job.id === id)) return id;
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  hydrateRuntime(job) {
    job.events = [];
    job.eventSeq = 0;
    job.subscribers = new Set();
    job.controller = new AbortController();
    job.cancelRequested = false;
    job.logLines = [];
    job.logDropped = 0;
    return job;
  }

  findJob(id) {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  publicJob(job) {
    const queueIndex = this.pending.indexOf(job);
    return {
      id: job.id,
      app: job.app,
      variant: job.variant,
      script: job.script,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      pull: job.pull,
      install: job.install,
      branch: job.branch ?? null,
      commitBefore: job.commitBefore ?? null,
      commitAfter: job.commitAfter ?? null,
      targetName: job.targetName,
      targetPath: job.targetPath,
      distPath: job.distPath,
      stages: job.stages.map(serializedStage),
      error: job.error,
      artifact: job.artifact,
      queuePosition: job.status === 'queued' && queueIndex !== -1 ? queueIndex + 1 : null,
      cancelRequested: Boolean(job.cancelRequested),
      lastSeq: job.eventSeq,
    };
  }

  emit(job, type, payload = {}) {
    const event = { seq: (job.eventSeq += 1), ts: nowIso(), type, ...payload };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) {
      job.events.splice(0, job.events.length - MAX_EVENTS);
    }
    for (const listener of job.subscribers) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error?.(`[events] 推送失败: ${error.message}`);
      }
    }
  }

  emitSnapshot(job) {
    this.emit(job, 'snapshot', { job: this.publicJob(job) });
  }

  touch(job) {
    this.emitSnapshot(job);
  }

  appendLog(job, line, stream, stage) {
    const tag = stage ? `[${stage}${stream === 'stderr' ? '!' : ''}]` : '[job]';
    job.logLines.push(`[${logTime()}] ${tag} ${line}`);
    if (job.logLines.length > MAX_LOG_LINES) {
      const overflow = job.logLines.length - MAX_LOG_LINES;
      job.logLines.splice(0, overflow);
      job.logDropped += overflow;
    }
  }

  log(job, line, stream = 'stdout') {
    const stage = currentStage(job)?.id ?? null;
    this.emit(job, 'log', { line, stream, stage });
    this.appendLog(job, line, stream, stage);
  }

  /**
   * Keep only unfinished jobs plus, optionally, the job that just finished.
   * There is no history feature: once a newer job finishes, older jobs and
   * their in-memory logs can be released.
   */
  pruneFinishedJobs(keepId = null) {
    this.jobs = this.jobs.filter(
      (job) => !isFinished(job.status) || (keepId !== null && job.id === keepId),
    );
  }

  async createJob({ app, variant, pull = true, install = false, targetName }) {
    if (this.pending.length >= MAX_QUEUED_JOBS) {
      throw new UserError(`部署队列已满（最多 ${MAX_QUEUED_JOBS} 个等待任务），请稍后再试`, 429);
    }
    const picked = pickVariant(this.config, app, variant, targetName);
    const duplicate = this.jobs.find(
      (job) =>
        (job.status === 'queued' || job.status === 'running') &&
        job.app === picked.app &&
        job.variant === picked.variant &&
        job.targetName === picked.targetName,
    );
    if (duplicate) {
      throw new UserError(
        `${app} · ${picked.variant} → ${picked.targetName} 已有任务在队列中或正在执行`,
        409,
      );
    }

    this.pruneFinishedJobs();

    const job = {
      id: this.nextJobId(),
      app: picked.app,
      variant: picked.variant,
      script: picked.script,
      status: 'queued',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      pull: Boolean(pull),
      install: Boolean(install),
      branch: this.config.branch || null,
      commitBefore: null,
      commitAfter: null,
      targetName: picked.targetName,
      targetPath: picked.targetPath,
      distPath: picked.distPath,
      stages: makeStages(Boolean(pull), Boolean(install)),
      error: null,
      artifact: null,
    };
    this.hydrateRuntime(job);
    job.logLines.push(`===== ${nowIso()} ${job.app} / ${job.variant} =====`);

    this.jobs.unshift(job);
    this.pending.push(job);
    this.emitSnapshot(job);
    this.refreshQueuePositions();
    this.pump();
    return this.publicJob(job);
  }

  refreshQueuePositions() {
    for (const job of this.pending) this.emitSnapshot(job);
  }

  pump() {
    if (this.pumping || this.active) return;
    const next = this.pending.shift();
    if (!next) return;
    this.pumping = true;
    this.refreshQueuePositions();
    this.runPromise = this.runJob(next)
      .catch((error) => {
        this.logger.error?.(`[queue] 任务 ${next.id} 异常: ${error.stack ?? error.message}`);
      })
      .finally(() => {
        this.pumping = false;
        this.runPromise = null;
        this.refreshQueuePositions();
        this.pump();
      });
  }

  async runJob(job) {
    this.active = job;
    job.status = 'running';
    job.startedAt = nowIso();

    try {
      this.touch(job);
      this.log(job, `开始部署 ${job.app} · ${job.variant}`, 'stage');
      await runDeployment(job, {
        config: this.config,
        signal: job.controller.signal,
        isCancelled: () => job.cancelRequested || job.controller.signal.aborted,
        log: (line, stream) => this.log(job, line, stream),
        touch: () => this.touch(job),
      });
      job.status = 'success';
      job.finishedAt = nowIso();
      this.log(job, '部署成功。', 'stage');
      this.touch(job);
    } catch (error) {
      const canceled =
        job.cancelRequested || job.controller.signal.aborted || error instanceof CancelledError;
      const failedStage = job.stages.find(
        (stage) => stage.status === 'failed' || stage.status === 'canceled',
      );
      markRemainingStages(job, 'skipped', '未执行');
      job.status = canceled ? 'canceled' : 'failed';
      job.finishedAt = nowIso();
      job.error = {
        message: canceled ? '已取消' : error.message || '部署失败',
        stage: failedStage?.id ?? null,
      };
      this.log(job, canceled ? '任务已取消。' : `部署失败：${job.error.message}`, 'stderr');
      this.touch(job);
    } finally {
      this.emit(job, 'end', { status: job.status });
      // Events are only replayed to late SSE reconnects; the full log is kept
      // separately in memory (bounded by MAX_LOG_LINES).
      if (job.events.length > 1000) job.events = job.events.slice(-1000);
      this.active = null;
      this.pruneFinishedJobs(job.id);
    }
  }

  async cancelJob(id) {
    const job = this.findJob(id);
    if (!job) throw new UserError('任务不存在', 404);
    if (isFinished(job.status)) throw new UserError('任务已经结束，无法取消', 409);

    if (job.status === 'queued') {
      const index = this.pending.indexOf(job);
      if (index !== -1) this.pending.splice(index, 1);
      markRemainingStages(job, 'skipped', '已取消，未执行');
      job.status = 'canceled';
      job.finishedAt = nowIso();
      job.error = { message: '已在开始前取消', stage: null };
      this.appendLog(job, '排队中的任务已取消。', 'stderr', null);
      this.emitSnapshot(job);
      this.emit(job, 'end', { status: 'canceled' });
      this.refreshQueuePositions();
      this.pump();
      return this.publicJob(job);
    }

    if (this.active === job) {
      job.cancelRequested = true;
      job.controller.abort();
      this.log(job, '收到取消请求，正在终止当前进程…', 'stderr');
      this.emitSnapshot(job);
      return this.publicJob(job);
    }

    throw new UserError('任务当前状态无法取消', 409);
  }

  getPublicJob(id) {
    const job = this.findJob(id);
    return job ? this.publicJob(job) : null;
  }

  subscribe(id, listener) {
    const job = this.findJob(id);
    if (!job) return null;
    job.subscribers.add(listener);
    return () => job.subscribers.delete(listener);
  }

  eventsSince(id, since = 0) {
    const job = this.findJob(id);
    if (!job) return null;
    const after = Number.isFinite(since) ? since : 0;
    return job.events.filter((event) => event.seq > after);
  }

  getLog(id) {
    const job = this.findJob(id);
    if (!job) return null;
    if (job.logDropped > 0) {
      return `…较早的 ${job.logDropped} 行日志已从内存中移除…\n${job.logLines.join('\n')}`;
    }
    return job.logLines.join('\n');
  }

  get activeJobId() {
    return this.active?.id ?? null;
  }

  async shutdown() {
    const queued = [...this.pending];
    this.pending = [];
    for (const job of queued) {
      markRemainingStages(job, 'skipped', '服务停止，未执行');
      job.status = 'failed';
      job.finishedAt = nowIso();
      job.error = { message: '服务停止，任务未执行', stage: null };
      this.emitSnapshot(job);
      this.emit(job, 'end', { status: 'failed' });
    }

    if (this.active) {
      this.active.cancelRequested = true;
      this.active.controller.abort();
      this.log(this.active, '服务停止，正在终止任务…', 'stderr');
      if (this.runPromise) {
        await Promise.race([
          this.runPromise.catch(() => {}),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 8000);
            timer.unref?.();
          }),
        ]);
      }
    }
  }
}
