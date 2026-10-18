import fs from 'node:fs';
import path from 'node:path';
import { NAME_RE } from './config.js';
import { UserError } from './errors.js';

const BUILD_RE = /^build:(.+)$/;
const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VARIANT_ORDER = ['prod', 'test', 'default'];

function readPackage(appDir) {
  const file = path.join(appDir, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function extractVariants(pkg) {
  const scripts = pkg?.scripts ?? {};
  const variants = [];
  const seen = new Set();
  if (typeof scripts.build === 'string') {
    variants.push({ name: 'default', label: '默认', script: 'build' });
    seen.add('default');
  }
  for (const [script, command] of Object.entries(scripts)) {
    const match = script.match(BUILD_RE);
    if (!match || typeof command !== 'string') continue;
    const name = match[1];
    if (!VARIANT_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    variants.push({ name, label: name, script });
  }
  variants.sort((a, b) => {
    const aIndex = VARIANT_ORDER.indexOf(a.name);
    const bIndex = VARIANT_ORDER.indexOf(b.name);
    if (aIndex !== -1 || bIndex !== -1) {
      return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
    }
    return a.name.localeCompare(b.name, 'en');
  });
  return variants;
}

function targetForName(config, name) {
  const root = path.resolve(config.deployRoot);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) {
    throw new Error(`非法的发布目录: ${name}`);
  }
  return { name, path: target };
}

export function resolveTargetPath(config, app) {
  return targetForName(config, app);
}

/**
 * Resolve the publish directory for a request. The directory is always a
 * direct child of deployRoot; the caller may override the folder name, but
 * never the parent.
 */
export function resolveRequestedTarget(config, app, targetName) {
  const fallback = resolveTargetPath(config, app);
  if (targetName === undefined || targetName === null) return fallback;
  if (typeof targetName !== 'string') {
    throw new UserError('发布文件夹名称必须是字符串');
  }
  const name = targetName.trim();
  if (!name) return fallback;
  if (name.length > 100) {
    throw new UserError('发布文件夹名称过长（最多 100 个字符）');
  }
  if (!NAME_RE.test(name)) {
    throw new UserError('发布文件夹名称不合法：只能包含字母、数字、点、下划线和连字符');
  }
  const root = path.resolve(config.deployRoot);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) {
    throw new UserError(`发布文件夹必须直接位于 ${root} 下`);
  }
  return { name, path: target };
}

function makeCommandLabel(config, app, script) {
  return `${config.pnpmBin} --filter ./${config.appsDir}/${app} run ${script}`;
}

export function appExists(config, app) {
  if (!app || !NAME_RE.test(app)) return false;
  const dir = path.join(config.appsPath, app);
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function discoverApps(config) {
  const entries = fs.readdirSync(config.appsPath, { withFileTypes: true });
  const apps = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
    const appDir = path.join(config.appsPath, entry.name);
    const pkg = readPackage(appDir);
    const variants = extractVariants(pkg).map((variant) => {
      const target = resolveTargetPath(config, entry.name);
      return {
        ...variant,
        recommended: false,
        target: target.path,
        targetPath: target.path,
        targetName: target.name,
        command: makeCommandLabel(config, entry.name, variant.script),
      };
    });
    const recommended =
      variants.find((variant) => variant.name === 'prod') ??
      variants.find((variant) => variant.name === 'default') ??
      variants[0] ??
      null;
    if (recommended) recommended.recommended = true;

    apps.push({
      name: entry.name,
      description: typeof pkg?.description === 'string' ? pkg.description : '',
      deployable: variants.length > 0,
      recommendedVariant: recommended?.name ?? null,
      variants,
    });
  }

  apps.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return apps;
}

export function getApp(config, app) {
  if (!appExists(config, app)) throw new UserError(`应用不存在: ${app}`);
  const pkg = readPackage(path.join(config.appsPath, app));
  if (!pkg) throw new UserError(`应用 ${app} 缺少可解析的 package.json`);
  const variants = extractVariants(pkg).map((variant) => {
    const target = resolveTargetPath(config, app);
    return {
      ...variant,
      target,
      targetPath: target.path,
      targetName: target.name,
      command: makeCommandLabel(config, app, variant.script),
    };
  });
  return { name: app, variants };
}

export function pickVariant(config, app, variantName, targetName) {
  const info = getApp(config, app);
  const requested = variantName || 'default';
  const variant = info.variants.find((item) => item.name === requested);
  if (!variant) {
    const available = info.variants.map((item) => item.name).join(', ') || '无';
    throw new UserError(`应用 ${app} 没有可用的构建环境 "${requested}"（可选: ${available}）`);
  }
  const target = resolveRequestedTarget(config, app, targetName);
  return {
    app,
    variant: variant.name,
    script: variant.script,
    command: variant.command,
    targetName: target.name,
    targetPath: target.path,
    distPath: path.join(config.appsPath, app, 'dist'),
  };
}
