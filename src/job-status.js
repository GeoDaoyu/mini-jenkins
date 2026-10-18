export const FINISHED_STATUSES = new Set(['success', 'failed', 'canceled']);

export function isFinished(status) {
  return FINISHED_STATUSES.has(status);
}
