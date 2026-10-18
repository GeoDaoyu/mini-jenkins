import path from 'node:path';
import express from 'express';
import { requireSameOrigin } from './security.js';
import { discoverApps } from './discovery.js';
import { UserError } from './errors.js';
import { readRepoInfo } from './git.js';
import { isFinished } from './job-status.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function parseSince(value) {
  const number = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function apiNotFound(req, res) {
  res.status(404).json({ error: '接口不存在' });
}

export function createApp({ config, jobs, logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    next();
  });

  app.use(requireSameOrigin);
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), activeJobId: jobs.activeJobId });
  });

  app.get('/api/meta', async (req, res, next) => {
    try {
      let repo = null;
      let repoError = null;
      try {
        repo = await readRepoInfo(config);
      } catch (error) {
        repoError = error.message;
      }
      const apps = discoverApps(config);
      res.json({
        serverTime: new Date().toISOString(),
        repo,
        repoError,
        apps,
        activeJobId: jobs.activeJobId,
        branch: config.branch || repo?.branch || null,
        repoPath: config.repoPath,
        deployRoot: config.deployRoot,
        installCommand: [config.pnpmBin, ...config.installArgs].join(' '),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/jobs', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      if (typeof body.app !== 'string' || !body.app.trim()) {
        throw new UserError('请选择一个应用');
      }
      if (body.variant !== undefined && typeof body.variant !== 'string') {
        throw new UserError('variant 必须是字符串');
      }
      if (body.pull !== undefined && typeof body.pull !== 'boolean') {
        throw new UserError('pull 必须是布尔值');
      }
      if (body.install !== undefined && typeof body.install !== 'boolean') {
        throw new UserError('install 必须是布尔值');
      }
      if (body.targetName !== undefined && typeof body.targetName !== 'string') {
        throw new UserError('targetName 必须是字符串');
      }
      const job = await jobs.createJob({
        app: body.app.trim(),
        variant: body.variant,
        targetName: body.targetName,
        pull: body.pull !== false,
        install: body.install === true,
      });
      res.status(202).json({ job });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.getPublicJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    res.json({ job });
  });

  app.get('/api/jobs/:id/events', (req, res) => {
    const job = jobs.getPublicJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }

    const since = parseSince(req.query.since ?? req.get('last-event-id'));
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');

    const writeEvent = (event) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* the client went away between the close event and this write */
      }
    };

    // Subscribe before replaying: Node runs this block synchronously, so no
    // event can slip through between "already finished?" and subscription.
    const unsubscribe = jobs.subscribe(req.params.id, writeEvent);
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({
        type: 'snapshot',
        job,
        replay: true,
      })}\n\n`,
    );
    const replayed = jobs.eventsSince(req.params.id, since) ?? [];
    for (const event of replayed) writeEvent(event);

    const latest = jobs.getPublicJob(req.params.id);
    if (!latest || isFinished(latest.status)) {
      // A job recovered after a restart has no in-memory events, and a client
      // reconnecting with a high Last-Event-ID may have replayed nothing.
      // Always give it a terminal event so the UI fetches the full log.
      if (latest && replayed.at(-1)?.type !== 'end') {
        writeEvent({
          seq: latest.lastSeq,
          ts: new Date().toISOString(),
          type: 'end',
          status: latest.status,
        });
      }
      unsubscribe?.();
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(': ping\n\n');
      } catch {
        /* client disconnected */
      }
    }, 15_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.get('/api/jobs/:id/log', async (req, res, next) => {
    try {
      const log = await jobs.getLog(req.params.id);
      if (log === null) {
        res.status(404).json({ error: '日志不存在' });
        return;
      }
      res.type('text/plain; charset=utf-8').send(log);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/jobs/:id/cancel', async (req, res, next) => {
    try {
      const job = await jobs.cancelJob(req.params.id);
      res.json({ job });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', apiNotFound);

  app.use(
    express.static(config.publicDir, {
      index: 'index.html',
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.accepts('html')) {
      next();
      return;
    }
    if (path.extname(req.path)) {
      next();
      return;
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  app.use((req, res) => {
    res.status(404).type('text/plain; charset=utf-8').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (res.headersSent) return;
    let status = 500;
    let message = error.message || '服务器内部错误';
    if (error instanceof UserError) status = error.status;
    else if (error.type === 'entity.parse.failed') {
      status = 400;
      message = '请求体不是合法的 JSON';
    } else if (error.type === 'entity.too.large') {
      status = 413;
      message = '请求体过大';
    }
    if (status >= 500) logger.error?.(error.stack || error.message);
    res.status(status).json({ error: message });
  });

  return app;
}
