import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { discoverApps } from '../src/discovery.js';
import { cleanup, createFixture } from './helpers.js';

test('配置校验：路径和目标目录', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanup(fixture));

  const config = loadConfig({ configPath: fixture.configPath, env: {} });
  assert.equal(config.port, 3081);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.repoPath, fixture.repo);
});

test('应用与环境发现：build 脚本、推荐环境、发布目录', async (t) => {
  const fixture = await createFixture();
  t.after(() => cleanup(fixture));
  const config = loadConfig({ configPath: fixture.configPath, env: {} });
  const apps = discoverApps(config);

  assert.equal(apps.length, 4);
  const demo = apps.find((app) => app.name === 'demo');
  assert.deepEqual(
    demo.variants.map((variant) => [variant.name, variant.script]),
    [
      ['prod', 'build:prod'],
      ['test', 'build:test'],
      ['default', 'build'],
    ],
  );
  assert.equal(demo.recommendedVariant, 'prod');
  assert.equal(demo.variants[0].targetName, 'demo');
  assert.match(demo.variants[0].targetPath, /deploy[/\\]demo$/);
  assert.match(demo.variants[0].command, /pnpm --filter \.\/apps\/demo run build:prod/);

  const slow = apps.find((app) => app.name === 'slow');
  assert.equal(slow.recommendedVariant, 'default');
  assert.equal(slow.variants.length, 1);

  // Any directory under apps/ is an app, even before it has a package.json.
  await fs.mkdir(path.join(fixture.repo, 'apps', 'no-package-yet'));
  const withEmptyApp = discoverApps(config);
  const emptyApp = withEmptyApp.find((app) => app.name === 'no-package-yet');
  assert.ok(emptyApp, 'apps/* 目录即使没有 package.json 也应出现在应用列表');
  assert.equal(emptyApp.deployable, false);
  assert.deepEqual(emptyApp.variants, []);
});
