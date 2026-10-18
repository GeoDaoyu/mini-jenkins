export const ACTIVE_STATUSES = new Set(['queued', 'running']);

export const STATUS_LABELS = {
  idle: '待命',
  queued: '排队中',
  running: '部署中',
  success: '成功',
  failed: '失败',
  canceled: '已取消',
};

export const DEFAULT_STAGES = [
  { id: 'pull', label: '拉取代码', status: 'pending', message: '' },
  { id: 'install', label: '安装依赖', status: 'pending', message: '' },
  { id: 'build', label: '构建', status: 'pending', message: '' },
  { id: 'deploy', label: '发布', status: 'pending', message: '' },
];

export function isActive(status) {
  return ACTIVE_STATUSES.has(status);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (totalMinutes > 0) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function jobDuration(job, now = Date.now()) {
  if (!job?.startedAt) return null;
  const start = Date.parse(job.startedAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : '—';
}

export function stageStatusText(status) {
  switch (status) {
    case 'running':
      return '进行中';
    case 'success':
      return '完成';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    case 'skipped':
      return '已跳过';
    default:
      return '等待';
  }
}

export function stageIcon(stage, index) {
  switch (stage.status) {
    case 'success':
      return '✓';
    case 'failed':
      return '✕';
    case 'canceled':
      return '×';
    case 'skipped':
      return '–';
    case 'running':
      return '●';
    default:
      return String(index + 1).padStart(2, '0');
  }
}

export function stageMessage(stage) {
  if (stage.status === 'pending') return '等待';
  if (stage.status === 'running') return '进行中';
  return stage.message || stageStatusText(stage.status);
}

export function statusLabel(job) {
  if (!job) return STATUS_LABELS.idle;
  if (job.cancelRequested && isActive(job.status)) return '正在取消…';
  if (job.status === 'queued' && job.queuePosition) return `排队中 · 第 ${job.queuePosition} 位`;
  return STATUS_LABELS[job.status] ?? job.status;
}

export function statusTone(status) {
  return ['success', 'failed', 'running', 'queued', 'canceled'].includes(status) ? status : 'idle';
}

export function logLineClass(stream, text) {
  if (stream === 'stderr') return 'is-stderr';
  if (stream === 'warn') return 'is-warn';
  if (stream === 'stage') return 'is-stage';
  if (stream === 'meta' || stream === 'log-meta') return 'is-meta';
  if (/^\[[^\]]+\]\s*$/.test(text) || text.startsWith('=====')) return 'is-meta';
  if (/\[[a-z]+!\]/.test(text)) return 'is-stderr';
  if (/^▶ |^✓ |^部署成功|^开始部署/.test(text)) return 'is-stage';
  return '';
}
