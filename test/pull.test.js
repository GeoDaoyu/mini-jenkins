import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cleanup,
  createFixture,
  getJson,
  pushUpdate,
  startServer,
  waitUntil,
} from './helpers.js';

const ADDED_APP = JSON.stringify(
  { name: 'added', private: true, scripts: { build: 'node build.mjs' } },
  null,
  2,
);

test('刷新接口：拉取远端新增的 app，并返回最新的应用列表和 Git 状态', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  const commit = await pushUpdate(fixture, 'apps/added/package.json', ADDED_APP, 'add app');
  const result = await getJson(server.baseUrl, '/api/pull', { method: 'POST' });

  assert.equal(result.status, 200);
  assert.equal(result.data.pull.status, 'updated');
  assert.equal(result.data.pull.after, commit);
  assert.equal(result.data.pull.before !== result.data.pull.after, true);
  assert.ok(result.data.pull.changedFiles.includes('apps/added/package.json'));
  assert.equal(result.data.repo.shortCommit, commit.slice(0, 7));
  assert.ok(result.data.apps.some((app) => app.name === 'added'));

  const again = await getJson(server.baseUrl, '/api/pull', { method: 'POST' });
  assert.equal(again.status, 200);
  assert.equal(again.data.pull.status, 'unchanged');
  assert.equal(again.data.pull.before, commit);
});

test('刷新接口：拉取失败时仍返回应用列表和 Git 状态', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  // Upstream changes a file that the server-side clone has modified locally,
  // so `git pull --ff-only` refuses to overwrite it.
  await pushUpdate(
    fixture,
    'apps/demo/package.json',
    JSON.stringify({ name: 'demo', private: true, scripts: { build: 'node build.mjs' } }, null, 2),
    'upstream demo change',
  );
  await fs.writeFile(
    path.join(fixture.repo, 'apps/demo/package.json'),
    JSON.stringify({ name: 'demo', private: true, scripts: {} }),
  );

  const result = await getJson(server.baseUrl, '/api/pull', { method: 'POST' });

  assert.equal(result.status, 200);
  assert.equal(result.data.pull.status, 'failed');
  assert.ok(result.data.pull.message);
  assert.ok(Array.isArray(result.data.apps));
  assert.ok(result.data.apps.some((app) => app.name === 'demo'));
  assert.ok(result.data.repo);
});

test('刷新接口：有任务运行时跳过拉取', async (t) => {
  const fixture = await createFixture();
  const server = await startServer({ configPath: fixture.configPath });
  t.after(async () => {
    await server.close();
    await cleanup(fixture);
  });

  const created = await getJson(server.baseUrl, '/api/jobs', {
    method: 'POST',
    body: { app: 'slow', variant: 'default', pull: false, install: false },
  });
  assert.equal(created.status, 202);

  await waitUntil(() => server.jobs.activeJobId, { timeoutMs: 15_000 });

  const result = await getJson(server.baseUrl, '/api/pull', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.data.pull.status, 'skipped');
  assert.equal(result.data.pull.reason, 'active-job');
  assert.ok(result.data.apps.length > 0);
});
