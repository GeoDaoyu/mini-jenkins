import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCommand, runCommand, stripAnsi, withoutControlEnv } from '../src/runner.js';

test('构建环境不包含 mini-jenkins 自身的控制变量', () => {
  const env = withoutControlEnv({
    PATH: '/usr/bin',
    HOME: '/home/deploy',
    MINI_JENKINS_SECRET: 'top-secret',
    MINI_JENKINS_DEBUG: '1',
    NODE_ENV: 'production',
  });
  assert.equal(env.MINI_JENKINS_SECRET, undefined);
  assert.equal(env.MINI_JENKINS_DEBUG, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/deploy');
  assert.equal(env.NODE_ENV, 'production');
});

test('子进程日志分行、去除 ANSI，并在超时后终止', async () => {
  const lines = [];
  const result = await runCommand({
    command: process.execPath,
    args: [
      '-e',
      'console.log("\\u001b[32mstdout-line\\u001b[0m"); console.error("stderr-line"); setTimeout(() => {}, 5000);',
    ],
    timeoutMs: 300,
    onLine: (line, stream) => lines.push({ line, stream }),
  });

  assert.equal(result.timedOut, true);
  assert.ok(lines.some((entry) => entry.line === 'stdout-line' && entry.stream === 'stdout'));
  assert.ok(lines.some((entry) => entry.line === 'stderr-line' && entry.stream === 'stderr'));
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
});

test('取消信号会终止子进程', async () => {
  const controller = new AbortController();
  const promise = runCommand({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  setTimeout(() => controller.abort(), 80);
  const result = await promise;
  assert.equal(result.aborted, true);
});

test('命令展示会转义带空格的参数', () => {
  assert.equal(
    formatCommand('pnpm', ['--filter', './apps/my app', 'run', 'build:prod']),
    'pnpm --filter "./apps/my app" run build:prod',
  );
});
