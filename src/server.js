import { loadConfig, loadDotenv, PROJECT_ROOT } from './config.js';
import { JobManager } from './job-manager.js';
import { createApp } from './app.js';
import { readRepoInfo } from './git.js';
import path from 'node:path';

function formatUrl(host, port) {
  const display = host.includes(':') ? `[${host}]` : host;
  return `http://${display}:${port}`;
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    throw new Error(`需要 Node.js >= 24，当前是 ${process.version}`);
  }
  loadDotenv(path.join(PROJECT_ROOT, '.env'));
  const config = loadConfig();

  const jobs = new JobManager({ config });

  const app = createApp({ config, jobs });
  const server = app.listen(config.port, config.host, async () => {
    console.log('');
    console.log('  mini-jenkins 已启动');
    console.log(`  地址      ${formatUrl(config.host, config.port)}`);
    console.log(`  仓库      ${config.repoPath}`);
    console.log(`  发布根目录 ${config.deployRoot}`);
    try {
      const repo = await readRepoInfo(config);
      console.log(`  当前分支   ${repo.branch} @ ${repo.shortCommit}${repo.dirty ? '（有未提交改动）' : ''}`);
    } catch (error) {
      console.log(`  Git 状态   ${error.message}`);
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      console.warn('  警告      监听在非本机地址且没有认证，请用防火墙或 nginx 限制访问！');
    }
    console.log('');
  });

  server.on('error', (error) => {
    console.error(`启动失败: ${error.message}`);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在停止…`);
    server.close();
    try {
      await jobs.shutdown();
    } catch (error) {
      console.error(`停止任务时出错: ${error.message}`);
    }
    server.closeAllConnections?.();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(`\nmini-jenkins 启动失败:\n${error.message}\n`);
  process.exit(1);
});
