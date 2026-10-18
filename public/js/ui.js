import {
  DEFAULT_STAGES,
  formatDuration,
  isActive,
  jobDuration,
  logLineClass,
  shortCommit,
  stageIcon,
  stageMessage,
  statusLabel,
  statusTone,
  STATUS_LABELS,
} from './format.js';

const byId = (id) => document.getElementById(id);

export const els = {
  repoBranch: byId('repo-branch'),
  repoCommit: byId('repo-commit'),
  repoPath: byId('repo-path'),
  appCombo: byId('app-combo'),
  appInput: byId('app-filter'),
  appClear: byId('app-clear'),
  appToggle: byId('app-toggle'),
  appOptions: byId('app-options'),
  appCount: byId('app-count'),
  variantGrid: byId('variant-grid'),
  targetShell: byId('target-shell'),
  targetName: byId('target-name'),
  targetBase: byId('target-base'),
  targetHint: byId('target-hint'),
  deployForm: byId('deploy-form'),
  deployButton: byId('deploy-button'),
  deployButtonText: byId('deploy-button-text'),
  formMessage: byId('form-message'),
  pullToggle: byId('pull-toggle'),
  installToggle: byId('install-toggle'),
  installHint: byId('install-hint'),
  refreshButton: byId('refresh-button'),
  runApp: byId('run-heading'),
  runVariant: byId('run-variant'),
  runSub: byId('run-sub'),
  runStatus: byId('run-status'),
  runStatusText: byId('run-status-text'),
  traverse: byId('traverse'),
  runTarget: byId('run-target'),
  runCommit: byId('run-commit'),
  runDuration: byId('run-duration'),
  errorBanner: byId('error-banner'),
  errorTitle: byId('error-title'),
  errorMessage: byId('error-message'),
  runPanel: document.querySelector('.run-panel'),
  console: document.querySelector('.console'),
  consoleStage: byId('console-stage'),
  logOutput: byId('log-output'),
  followLog: byId('follow-log'),
  downloadLog: byId('download-log'),
  cancelJob: byId('cancel-job'),
  toastStack: byId('toast-stack'),
};

const MAX_LOG_LINES = 3000;
let deployAllowed = false;
let deployBusy = false;
let variantAppSignature = '';
let deployRoot = '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setMeta(meta) {
  deployRoot = meta.deployRoot || '';
  els.targetBase.textContent = deployRoot ? `${deployRoot.replace(/\/+$/, '')}/` : '—';
  els.targetBase.title = deployRoot || '';
  const repo = meta.repo;
  els.repoPath.textContent = meta.repoPath || '—';
  els.repoPath.title = meta.repoPath || '';
  if (meta.installCommand) els.installHint.textContent = meta.installCommand;

  if (repo) {
    els.repoBranch.textContent = repo.branch === 'HEAD' ? 'detached' : repo.branch;
    els.repoBranch.classList.toggle('is-dirty', Boolean(repo.dirty));
    els.repoBranch.classList.toggle('is-mismatch', repo.branchMatches === false);
    const warnings = [];
    if (repo.branchMatches === false) {
      warnings.push(`配置要求分支 ${repo.expectedBranch}，当前是 ${repo.branch}`);
    }
    if (repo.dirty) warnings.push(`${repo.dirtyCount} 个未提交改动：\n${(repo.dirtyFiles || []).join('\n')}`);
    els.repoBranch.title = warnings.join('\n\n') || repo.branch;
    els.repoCommit.textContent = shortCommit(repo.commit);
    els.repoCommit.title = [repo.subject, repo.committedAt].filter(Boolean).join(' · ');
    els.repoBranch.parentElement.classList.remove('is-muted');
  } else {
    els.repoBranch.textContent = 'Git 读取失败';
    els.repoBranch.classList.remove('is-dirty');
    els.repoBranch.classList.remove('is-mismatch');
    els.repoBranch.title = meta.repoError || '无法读取 Git 信息';
    els.repoCommit.textContent = '—';
    els.repoBranch.parentElement.classList.add('is-muted');
  }
}

export function setAppCount(text) {
  els.appCount.textContent = text;
}

export function setAppInputValue(value) {
  els.appInput.value = value ?? '';
  setAppClearVisible(Boolean(els.appInput.value));
}

export function setAppClearVisible(visible) {
  els.appClear.hidden = !visible;
}

export function getAppInputValue() {
  return els.appInput.value;
}

export function setAppInputDisabled(disabled) {
  els.appInput.disabled = Boolean(disabled);
  els.appClear.disabled = Boolean(disabled);
  els.appToggle.disabled = Boolean(disabled);
}

export function focusAppInput() {
  els.appInput.focus();
}

export function selectAppInputText() {
  els.appInput.select();
}

export function setAppListOpen(open) {
  els.appOptions.hidden = !open;
  els.appInput.setAttribute('aria-expanded', String(Boolean(open)));
  els.appCombo.classList.toggle('is-open', Boolean(open));
  els.appToggle.setAttribute('aria-label', open ? '收起应用列表' : '展开应用列表');
  if (!open) els.appInput.removeAttribute('aria-activedescendant');
}

export function renderAppOptions(apps, selectedName, activeIndex, onChoose, onActivate) {
  els.appOptions.replaceChildren();
  if (apps.length === 0) {
    els.appOptions.append(element('li', 'combo-empty', '没有匹配的应用'));
    els.appInput.removeAttribute('aria-activedescendant');
    return;
  }

  for (const [index, app] of apps.entries()) {
    const item = element('li', 'combo-option');
    item.id = `app-option-${index}`;
    item.dataset.index = String(index);
    item.role = 'option';
    item.setAttribute('aria-selected', String(app.name === selectedName));
    item.classList.toggle('is-active', index === activeIndex);
    if (!app.deployable) item.classList.add('is-disabled');
    item.append(
      element('span', 'combo-option-name', app.name),
      element(
        'span',
        'combo-option-meta',
        app.deployable ? `${app.variants.length} 环境` : '无构建脚本',
      ),
    );
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('mouseenter', () => onActivate(index));
    item.addEventListener('click', () => onChoose(app.name));
    els.appOptions.append(item);
  }

  setAppActiveIndex(activeIndex);
}

export function setAppActiveIndex(index) {
  let activeId = null;
  for (const item of els.appOptions.querySelectorAll('.combo-option')) {
    const active = Number(item.dataset.index) === index;
    item.classList.toggle('is-active', active);
    if (active) {
      activeId = item.id;
      item.scrollIntoView({ block: 'nearest' });
    }
  }
  if (activeId) els.appInput.setAttribute('aria-activedescendant', activeId);
  else els.appInput.removeAttribute('aria-activedescendant');
}

export function setTargetName(value) {
  els.targetName.value = value ?? '';
}

export function getTargetName() {
  return els.targetName.value;
}

export function setTargetDisabled(disabled) {
  els.targetName.disabled = Boolean(disabled);
}

export function setTargetValidity(valid, message = '') {
  els.targetShell.classList.toggle('is-invalid', !valid);
  els.targetName.setAttribute('aria-invalid', String(!valid));
  els.targetHint.textContent = message;
  els.targetHint.classList.toggle('is-error', !valid);
}

export function renderVariants(app, selected, onSelect) {
  const signature = app
    ? `${app.name}:${app.variants.map((variant) => `${variant.name}:${variant.script}`).join(',')}`
    : 'none';
  if (signature !== variantAppSignature) {
    variantAppSignature = signature;
    els.variantGrid.replaceChildren();
    if (!app || app.variants.length === 0) {
      els.variantGrid.append(
        element('p', 'variant-empty', '这个应用没有 package.json 或可用的 build 脚本。'),
      );
      return;
    }

    const chips = [];
    for (const variant of app.variants) {
      const chip = element('button', 'variant-chip');
      chip.type = 'button';
      chip.role = 'radio';
      chip.dataset.variant = variant.name;
      chip.title = variant.script;
      chip.append(
        element('span', 'variant-name', variant.name === 'default' ? '默认' : variant.name),
        element('span', 'variant-script', variant.script),
      );
      chip.addEventListener('click', () => onSelect(variant.name));
      chips.push(chip);
      els.variantGrid.append(chip);
    }

    for (const [index, chip] of chips.entries()) {
      chip.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const next = chips[(index + offset + chips.length) % chips.length];
        next.focus();
        next.click();
      });
    }
  }

  let selectedChip = null;
  for (const chip of els.variantGrid.querySelectorAll('.variant-chip')) {
    const isSelected = chip.dataset.variant === selected;
    chip.setAttribute('aria-checked', String(isSelected));
    chip.tabIndex = isSelected ? 0 : -1;
    if (isSelected) selectedChip = chip;
  }

  if (selectedChip) {
    const gridRect = els.variantGrid.getBoundingClientRect();
    const chipRect = selectedChip.getBoundingClientRect();
    if (chipRect.top < gridRect.top || chipRect.bottom > gridRect.bottom) {
      els.variantGrid.scrollTop += chipRect.top - gridRect.top - 4;
    }
  }
}

export function setDeployEnabled(allowed) {
  deployAllowed = Boolean(allowed);
  syncDeployButton();
}

export function setDeployBusy(busy) {
  deployBusy = Boolean(busy);
  syncDeployButton();
}

function syncDeployButton() {
  els.deployButton.disabled = !deployAllowed || deployBusy;
  els.deployButtonText.textContent = deployBusy ? '正在提交…' : '开始部署';
}

export function setFormMessage(text, tone = 'error') {
  els.formMessage.textContent = text || '';
  els.formMessage.className = 'form-message';
  if (text && tone) els.formMessage.classList.add(`is-${tone}`);
}

export function renderIdle() {
  els.runApp.textContent = '准备就绪';
  els.runVariant.hidden = true;
  els.runSub.textContent = '在左侧选择一个应用，开始第一次部署。';
  renderStatus(null);
  renderTraverse(DEFAULT_STAGES);
  els.runTarget.textContent = '—';
  els.runTarget.title = '';
  els.runCommit.textContent = '—';
  els.runCommit.title = '';
  els.runDuration.textContent = '—';
  els.errorBanner.hidden = true;
  els.console.dataset.status = 'idle';
  els.consoleStage.textContent = '';
  els.downloadLog.hidden = true;
  els.cancelJob.hidden = true;
  setLogs([]);
  document.title = 'mini-jenkins · 前端部署控制台';
}

export function renderJob(job) {
  if (!job) {
    renderIdle();
    return;
  }

  els.runApp.textContent = job.app;
  els.runVariant.hidden = false;
  els.runVariant.textContent = job.variant === 'default' ? 'default' : job.variant;
  els.runSub.textContent = `任务 ${job.id} · 脚本 ${job.script}`;

  renderStatus(job);
  renderTraverse(job.stages);
  renderDuration(job);

  els.runTarget.textContent = job.targetPath || '—';
  els.runTarget.title = job.targetPath || '';
  const commit = job.commitAfter || job.commitBefore;
  els.runCommit.textContent = shortCommit(commit);
  els.runCommit.title = commit || '';
  const failedStage = job.error?.stage
    ? job.stages.find((stage) => stage.id === job.error.stage)
    : null;
  if (job.error) {
    const canceled = job.status === 'canceled';
    els.errorBanner.hidden = false;
    els.errorBanner.dataset.tone = canceled ? 'canceled' : 'failed';
    els.errorTitle.textContent = canceled
      ? '任务已取消'
      : failedStage
        ? `${failedStage.label}失败`
        : '部署失败';
    els.errorMessage.textContent = job.error.message || '';
  } else {
    els.errorBanner.hidden = true;
  }

  els.console.dataset.status = job.status;
  const running = job.stages.find((stage) => stage.status === 'running');
  els.consoleStage.textContent = running
    ? `${running.label}…`
    : job.status === 'queued'
      ? '排队中'
      : job.status === 'success'
        ? '完成'
        : job.status === 'failed'
          ? '失败'
          : job.status === 'canceled'
            ? '已取消'
            : '';

  setDownloadLog(job.id);
  setCancelState(job);
  document.title = isActive(job.status)
    ? `${statusLabel(job)} · ${job.app} | mini-jenkins`
    : `${job.app} · ${STATUS_LABELS[job.status] ?? job.status} | mini-jenkins`;
}

export function renderDuration(job) {
  if (!job) {
    els.runDuration.textContent = '—';
    return;
  }
  if (job.status === 'queued' && !job.startedAt) {
    els.runDuration.textContent = '排队中';
    return;
  }
  const ms = jobDuration(job);
  els.runDuration.textContent = ms === null ? '—' : formatDuration(ms);
}

function renderStatus(job) {
  if (!job) {
    els.runStatus.dataset.status = 'idle';
    els.runStatusText.textContent = STATUS_LABELS.idle;
    return;
  }
  els.runStatus.dataset.status = job.cancelRequested && isActive(job.status) ? 'canceled' : statusTone(job.status);
  els.runStatusText.textContent = statusLabel(job);
}

export function renderTraverse(stages) {
  const list = stages?.length ? stages : DEFAULT_STAGES;
  els.traverse.replaceChildren();
  for (const [index, stage] of list.entries()) {
    const status = stage.status || 'pending';
    const item = element('li', `traverse-step is-${status}`);
    const node = element('span', 'step-node', stageIcon(stage, index));
    node.setAttribute('aria-hidden', 'true');
    const body = element('div', 'step-body');
    const label = element('strong', 'step-label', stage.label || stage.id);
    const message = element('span', 'step-message', stageMessage(stage));
    message.title = stage.message || '';
    body.append(label, message);
    item.append(node, body);
    item.setAttribute('aria-label', `${stage.label || stage.id}：${stageMessage(stage)}`);
    els.traverse.append(item);
  }
}

export function setLogs(lines) {
  els.logOutput.replaceChildren();
  const normalized = (lines || []).map((line) =>
    typeof line === 'string' ? { text: line, stream: '' } : line,
  );
  const visible = normalized.slice(-MAX_LOG_LINES);
  if (visible.length === 0) {
    els.logOutput.append(element('p', 'log-empty', '等待任务开始…'));
    return;
  }
  if (normalized.length > visible.length) {
    els.logOutput.append(
      element('div', 'log-line is-meta', `…仅显示最后 ${MAX_LOG_LINES} 行，完整日志请下载查看。`),
    );
  }
  const fragment = document.createDocumentFragment();
  for (const line of visible) {
    const div = element('div', `log-line ${logLineClass(line.stream, line.text)}`.trim(), line.text);
    fragment.append(div);
  }
  els.logOutput.append(fragment);
  if (els.followLog.checked) scrollLogToBottom();
}

export function appendLogLine(line) {
  const empty = els.logOutput.querySelector('.log-empty');
  if (empty) empty.remove();
  const div = element('div', `log-line ${logLineClass(line.stream, line.text)}`.trim(), line.text);
  els.logOutput.append(div);
  while (els.logOutput.children.length > MAX_LOG_LINES) {
    els.logOutput.firstElementChild?.remove();
  }
  if (els.followLog.checked) scrollLogToBottom();
}

export function setFollow(value) {
  els.followLog.checked = Boolean(value);
  if (value) scrollLogToBottom();
}

export function scrollLogToBottom() {
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

export function setDownloadLog(id) {
  if (!id) {
    els.downloadLog.hidden = true;
    els.downloadLog.removeAttribute('href');
    els.downloadLog.removeAttribute('download');
    return;
  }
  els.downloadLog.hidden = false;
  els.downloadLog.href = `/api/jobs/${encodeURIComponent(id)}/log`;
  els.downloadLog.setAttribute('download', `${id}.log`);
}

export function setCancelState(job) {
  const active = job && isActive(job.status);
  if (!active) {
    els.cancelJob.hidden = true;
    els.cancelJob.disabled = true;
    els.cancelJob.classList.remove('is-armed');
    els.cancelJob.textContent = '取消任务';
    return;
  }
  els.cancelJob.hidden = false;
  if (job.cancelRequested) {
    els.cancelJob.disabled = true;
    els.cancelJob.classList.remove('is-armed');
    els.cancelJob.textContent = '正在取消…';
    return;
  }
  els.cancelJob.disabled = false;
  els.cancelJob.textContent = '取消任务';
}

export function setCancelArmed(armed) {
  els.cancelJob.classList.toggle('is-armed', Boolean(armed));
  els.cancelJob.textContent = armed ? '再次点击确认' : '取消任务';
}

export function setRefreshBusy(busy) {
  els.refreshButton.classList.toggle('is-busy', Boolean(busy));
  els.refreshButton.disabled = Boolean(busy);
}

export function scrollToRunPanel() {
  if (!window.matchMedia('(max-width: 940px)').matches) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.runPanel.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}

export function toast(message, tone = 'error') {
  const node = element('div', `toast${tone === 'success' ? ' is-success' : ''}`, message);
  els.toastStack.append(node);
  setTimeout(() => node.remove(), 4200);
}
