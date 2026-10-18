import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cleanup,
  collectSse,
  createFixture,
  getJson,
  pushUpdate,
  readDeployed,
  startServer,
  waitForJob,
  waitUntil,
} from './helpers.js';

test('拉取代码、构建并原子发布，第二次部署能拿到远端新提交', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  const meta = await getJson(server.baseUrl, '/api/meta');
  assert.equal(meta.status, 200);
  const demo = meta.data.apps.find((app) => app.name === 'demo');
  assert.ok(demo, 'meta 应包含 demo 应用');
  assert.deepEqual(
    demo.variants.map((variant) => variant.name),
    ['prod', 'test', 'default'],
  );
  assert.equal(demo.recommendedVariant, 'prod');
  const prod = demo.variants.find((variant) => variant.name === 'prod');
  assert.equal(prod.script, 'build:prod');
  assert.equal(prod.targetName, 'demo');

  const first = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'demo', variant: 'prod', pull: true, install: false },
  });
  assert.equal(first.status, 202);
  const firstJob = await waitForJob(server.baseUrl, first.data.job.id);
  assert.equal(firstJob.status, 'success');
  assert.deepEqual(
    firstJob.stages.map((stage) => [stage.id, stage.status]),
    [
      ['pull', 'success'],
      ['install', 'skipped'],
      ['build', 'success'],
      ['deploy', 'success'],
    ],
  );
  assert.ok(firstJob.commitAfter);

  const firstHtml = await readDeployed(path.join(fixture.deploy, 'demo', 'index.html'));
  assert.match(firstHtml, /demo prod v1/);
  assert.ok(firstJob.artifact.files >= 1);

  const secondCommit = await pushUpdate(fixture, 'apps/demo/version.txt', 'v2\n', 'release v2');
  const second = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'demo', variant: 'prod', pull: true },
  });
  assert.equal(second.status, 202);
  const secondJob = await waitForJob(server.baseUrl, second.data.job.id);
  assert.equal(secondJob.status, 'success');
  assert.equal(secondJob.commitAfter, secondCommit);

  const secondHtml = await readDeployed(path.join(fixture.deploy, 'demo', 'index.html'));
  assert.match(secondHtml, /demo prod v2/);
  assert.match(secondHtml, new RegExp(secondCommit.slice(0, 7)));

  const events = await collectSse(server.baseUrl, secondJob.id);
  assert.ok(events.some((event) => event.type === 'snapshot'));
  assert.ok(events.some((event) => event.type === 'log' && /构建/.test(event.line)));
  const end = events.find((event) => event.type === 'end');
  assert.equal(end?.status, 'success');
});

test('发布文件夹名可修改，但必须位于 deployRoot 下', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  const created = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'demo', variant: 'prod', pull: false, targetName: 'manual-demo' },
  });
  assert.equal(created.status, 202);
  const job = await waitForJob(server.baseUrl, created.data.job.id);
  assert.equal(job.status, 'success');
  assert.equal(job.targetName, 'manual-demo');
  assert.equal(job.targetPath, path.join(fixture.deploy, 'manual-demo'));
  const html = await readDeployed(path.join(fixture.deploy, 'manual-demo', 'index.html'));
  assert.match(html, /demo prod v1/);

  for (const targetName of ['../escape', 'nested/dir', '.hidden', 'bad name']) {
    const response = await getJson(server.baseUrl, '/api/jobs', {
      method: 'POST',
      body: { app: 'demo', variant: 'prod', pull: false, targetName },
    });
    assert.equal(response.status, 400, `targetName ${targetName} should be rejected`);
    assert.match(response.data.error, /发布文件夹名称不合法/);
  }

  const wrongType = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'demo', variant: 'prod', pull: false, targetName: 123 },
  });
  assert.equal(wrongType.status, 400);
  assert.match(wrongType.data.error, /targetName 必须是字符串/);
});

test('构建失败时给出失败阶段与错误日志，不发布产物', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  const created = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'broken', variant: 'default', pull: true },
  });
  assert.equal(created.status, 202);

  const job = await waitForJob(server.baseUrl, created.data.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.stage, 'build');
  assert.match(job.error.message, /构建失败/);
  const buildStage = job.stages.find((stage) => stage.id === 'build');
  assert.equal(buildStage.status, 'failed');
  assert.equal(job.stages.find((stage) => stage.id === 'deploy').status, 'skipped');

  await assert.rejects(fs.access(path.join(fixture.deploy, 'broken-target')));

  const log = await getJson(server.baseUrl, `/api/jobs/${job.id}/log`);
  assert.equal(log.status, 200);
  assert.match(log.text, /boom: fixture build failed/);
});

test('任务串行执行，排队任务可取消，后续任务继续运行', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  const slow = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'slow', variant: 'default', pull: false },
  });
  assert.equal(slow.status, 202);

  await waitUntil(async () => {
    const { data } = await getJson(server.baseUrl, `/api/jobs/${slow.data.job.id}`);
    return data.job.stages.find((stage) => stage.id === 'build')?.status === 'running';
  });

  const duplicate = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'slow', variant: 'default', pull: false },
  });
  assert.equal(duplicate.status, 409);

  const queued = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'demo', variant: 'prod', pull: false },
  });
  assert.equal(queued.status, 202);
  assert.equal(queued.data.job.status, 'queued');
  assert.equal(queued.data.job.queuePosition, 1);

  const canceled = await getJson(server.baseUrl, `/api/jobs/${slow.data.job.id}/cancel`, {
    method: 'POST',
  });
  assert.equal(canceled.status, 200);

  const slowJob = await waitForJob(server.baseUrl, slow.data.job.id);
  assert.equal(slowJob.status, 'canceled');
  assert.equal(slowJob.stages.find((stage) => stage.id === 'build').status, 'canceled');

  const demoJob = await waitForJob(server.baseUrl, queued.data.job.id, { timeoutMs: 40_000 });
  assert.equal(demoJob.status, 'success');
  assert.ok(demoJob.startedAt >= slowJob.finishedAt);
  const html = await readDeployed(path.join(fixture.deploy, 'demo', 'index.html'));
  assert.match(html, /demo prod/);
});

test('无登录，跨站 POST 仍然被拒绝', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  const meta = await getJson(server.baseUrl, '/api/meta');
  assert.equal(meta.status, 200);

  const crossSite = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: { app: 'demo', variant: 'prod' },
  });
  assert.equal(crossSite.status, 403);

  const sameSite = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    headers: { Origin: server.baseUrl },
    body: { app: 'missing-app', variant: 'prod' },
  });
  assert.equal(sameSite.status, 400);

  const health = await getJson(server.baseUrl, '/api/health');
  assert.equal(health.status, 200);
});
