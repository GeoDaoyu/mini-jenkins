import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/job-manager.js';
import { createApp } from '../src/app.js';

const execFileAsync = promisify(execFile);
const silentLogger = { log() {}, warn() {}, error() {} };

const DEMO_BUILD = `
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const variant = process.env.APP_ENV ?? 'none';
const version = fs.existsSync('version.txt') ? fs.readFileSync('version.txt', 'utf8').trim() : 'v1';
const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', '<!doctype html><h1>demo ' + variant + ' ' + version + ' ' + head + '</h1>');
`;

const SLOW_BUILD = `
import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', 'slow');
console.log('slow build started');
await new Promise((resolve) => setTimeout(resolve, 30000));
`;

const BROKEN_BUILD = `
console.error('boom: fixture build failed');
process.exit(2);
`;

export async function sh(command, args, cwd, options = {}) {
  return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024, ...options });
}

export async function git(args, cwd) {
  return sh('git', ['-c', 'user.name=Mini Jenkins Test', '-c', 'user.email=test@example.com', ...args], cwd);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

async function writeApp(root, name, scripts, buildScript = DEMO_BUILD) {
  const dir = path.join(root, 'apps', name);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, 'package.json'), {
    name,
    private: true,
    scripts,
  });
  await fs.writeFile(path.join(dir, 'build.mjs'), buildScript);
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/**
 * Build a temp pnpm monorepo with a bare origin, a served clone, and a dev clone.
 */
export async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-jenkins-test-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const dev = path.join(root, 'dev');
  const deploy = path.join(root, 'deploy');

  await fs.mkdir(repo, { recursive: true });
  await sh('git', ['init', '--bare', '-b', 'main', remote], root);
  await git(['init', '-b', 'main'], repo);

  await writeJson(path.join(repo, 'package.json'), { name: 'fixture', private: true });
  await writeFile(path.join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n**/dist/\n');

  await writeApp(repo, 'demo', {
    build: 'APP_ENV=dev node build.mjs',
    'build:prod': 'APP_ENV=prod node build.mjs',
    'build:test': 'APP_ENV=test node build.mjs',
  });
  await writeApp(repo, 'other', {
    build: 'APP_ENV=dev node build.mjs',
    'build:prod': 'APP_ENV=prod node build.mjs',
  });
  await writeApp(repo, 'slow', { build: 'node build.mjs' }, SLOW_BUILD);
  await writeApp(repo, 'broken', { build: 'node build.mjs' }, BROKEN_BUILD);

  await git(['add', '.'], repo);
  await git(['commit', '-m', 'initial fixture'], repo);
  await git(['remote', 'add', 'origin', remote], repo);
  await git(['push', '-u', 'origin', 'main'], repo);

  await git(['clone', remote, dev], root);

  await writeJson(path.join(root, 'config.json'), {
    host: '127.0.0.1',
    port: 3081,
    repoPath: './repo',
    branch: 'main',
    remote: 'origin',
    appsDir: 'apps',
    deployRoot: './deploy',
    pnpmBin: process.env.MINI_JENKINS_PNPM || 'pnpm',
    installArgs: ['install', '--frozen-lockfile'],
  });

  return { root, repo, remote, dev, deploy, configPath: path.join(root, 'config.json') };
}

export async function pushUpdate(fixture, relativePath, content, message = 'update') {
  const file = path.join(fixture.dev, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await git(['add', '.'], fixture.dev);
  await git(['commit', '-m', message], fixture.dev);
  const { stdout } = await git(['rev-parse', 'HEAD'], fixture.dev);
  await git(['push', 'origin', 'main'], fixture.dev);
  return stdout.trim();
}

export async function startServer({ configPath, env = {}, logger = silentLogger }) {
  const config = loadConfig({ configPath, env });
  const jobs = new JobManager({ config, logger });
  const app = createApp({ config, jobs, logger });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    config,
    jobs,
    server,
    baseUrl,
    async close() {
      await jobs.shutdown();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function api(baseUrl, route, { method = 'GET', body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}

export async function getJson(baseUrl, route, options = {}) {
  const response = await api(baseUrl, route, options);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: response.status, headers: response.headers, data, text };
}

export async function waitForJob(baseUrl, id, { timeoutMs = 30_000, predicate } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const { status, data } = await getJson(baseUrl, `/api/jobs/${id}`);
    if (status === 200) {
      last = data.job;
      const terminal = ['success', 'failed', 'canceled'].includes(last.status);
      if (predicate ? predicate(last) : terminal) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待任务 ${id} 超时，最后状态: ${JSON.stringify(last)}`);
}

export async function waitUntil(check, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('等待条件超时');
}

export async function collectSse(baseUrl, id, { timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${baseUrl}/api/jobs/${id}/events`, {
    signal: controller.signal,
  });
  if (response.status !== 200) throw new Error(`SSE 返回 ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let ended = false;

  try {
    while (!ended) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine);
          events.push(event);
          if (event.type === 'end') ended = true;
        } catch {
          /* ignore keepalive fragments */
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

export async function cleanup(fixture) {
  if (fixture?.root) await fs.rm(fixture.root, { recursive: true, force: true }).catch(() => {});
}

export async function readDeployed(file) {
  return fs.readFile(path.join(file), 'utf8');
}
