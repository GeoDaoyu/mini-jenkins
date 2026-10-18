import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const MAX_LINE_LENGTH = 4000;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

export function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Remove the console's own secrets before handing the environment to a build.
 * Repo code is trusted enough to run, but it has no business reading the
 * deployment console's own control variables.
 */
export function withoutControlEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith('MINI_JENKINS_')) delete env[key];
  }
  return env;
}

/**
 * Run a command without a shell, stream merged stdout/stderr line by line.
 * Resolves with an exit result; rejects only when the process cannot start.
 */
export function runCommand({
  command,
  args = [],
  cwd,
  env = {},
  inheritEnv = true,
  onLine = () => {},
  signal,
  timeoutMs = 0,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ code: null, signal: 'SIGTERM', aborted: true, timedOut: false, durationMs: 0 });
      return;
    }

    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: inheritEnv ? { ...process.env, ...env } : { ...env },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new Error(`无法启动命令 ${command}: ${error.message}`));
      return;
    }

    let settled = false;
    let aborted = false;
    let timedOut = false;
    let killTimer = null;
    let timeoutTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };

    const terminate = () => {
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
      killTimer.unref?.();
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const decoder = new StringDecoder('utf8');
    const flushers = [];

    const createLinePump = (stream, streamName) => {
      let buffer = '';
      const emit = (rawLine) => {
        const line = stripAnsi(rawLine).replace(/\s+$/u, '');
        if (!line) return;
        onLine(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line, streamName);
      };
      const push = (text) => {
        buffer += text;
        const parts = buffer.split(/\r\n|\n|\r/);
        buffer = parts.pop() ?? '';
        for (const part of parts) emit(part);
      };
      stream.on('data', (chunk) => push(decoder.write(chunk)));
      stream.on('end', () => push(decoder.end()));
      flushers.push(() => {
        if (buffer) emit(buffer);
        buffer = '';
      });
    };

    createLinePump(child.stdout, 'stdout');
    createLinePump(child.stderr, 'stderr');

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      const hint =
        error.code === 'ENOENT'
          ? `找不到命令 "${command}"。请检查配置中的 pnpmBin 或服务器 PATH。`
          : error.message;
      reject(new Error(hint));
    });

    child.on('close', (code, closeSignal) => {
      for (const flush of flushers) flush();
      for (const stream of [child.stdout, child.stderr]) stream.destroy();
      finish({
        code,
        signal: closeSignal,
        aborted,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
