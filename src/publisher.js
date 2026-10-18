import fs from 'node:fs/promises';
import path from 'node:path';
import { CancelledError } from './errors.js';

function ensureNotAborted(signal) {
  if (signal?.aborted) throw new CancelledError();
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function describeDirectory(dir) {
  let files = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    try {
      const stat = await fs.stat(path.join(entry.parentPath ?? entry.path, entry.name));
      bytes += stat.size;
    } catch {
      /* file disappeared or is unreadable; size is informational */
    }
  }
  return { files, bytes };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/**
 * Publish a build atomically: copy dist to a sibling staging directory, then
 * rename it into place. Visitors see either the old or the new site, never a
 * half-copied directory.
 */
export async function publishDist({
  distPath,
  targetPath,
  targetName,
  jobId,
  onLine = () => {},
  signal,
}) {
  ensureNotAborted(signal);

  let stat;
  try {
    stat = await fs.stat(distPath);
  } catch {
    throw new Error(`构建产物不存在: ${distPath}`);
  }
  if (!stat.isDirectory()) throw new Error(`构建产物不是目录: ${distPath}`);

  const topLevel = await fs.readdir(distPath);
  if (topLevel.length === 0) throw new Error(`构建产物是空目录: ${distPath}`);
  if (!topLevel.includes('index.html')) {
    onLine(`警告: ${distPath} 根目录没有 index.html，请确认构建配置。`, 'stderr');
  }

  const parent = path.dirname(targetPath);
  await fs.mkdir(parent, { recursive: true });

  const stamp = String(jobId).replace(/[^A-Za-z0-9_-]/g, '');
  const staging = path.join(parent, `.${targetName}.staging-${stamp}`);
  const previous = path.join(parent, `.${targetName}.old-${stamp}`);

  const { files, bytes } = await describeDirectory(distPath);
  onLine(`复制 ${files} 个文件（${formatBytes(bytes)}）到暂存目录…`, 'stdout');

  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(distPath, staging, { recursive: true, force: true });
  ensureNotAborted(signal);

  const hadTarget = await pathExists(targetPath);
  if (hadTarget) {
    await fs.rm(previous, { recursive: true, force: true });
    await fs.rename(targetPath, previous);
  }

  try {
    ensureNotAborted(signal);
    await fs.rename(staging, targetPath);
  } catch (error) {
    if (hadTarget && (await pathExists(previous)) && !(await pathExists(targetPath))) {
      await fs.rename(previous, targetPath).catch(() => {});
    }
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  if (hadTarget) {
    await fs.rm(previous, { recursive: true, force: true }).catch((error) => {
      onLine(`旧的发布目录清理失败（不影响本次部署）: ${error.message}`, 'stderr');
    });
  }

  onLine(`已发布到 ${targetPath}`, 'stdout');
  return { targetPath, files, bytes, replaced: hadTarget };
}
