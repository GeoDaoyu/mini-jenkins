import { api } from './api.js';
import * as ui from './ui.js';
import { isActive } from './format.js';

const state = {
  meta: null,
  apps: [],
  app: null,
  variant: null,
  variantByApp: new Map(),
  appListOpen: false,
  appFilterActive: false,
  filteredApps: [],
  appActiveIndex: -1,
  targetName: '',
  targetValid: false,
  currentJob: null,
  currentJobId: null,
  source: null,
  streamJobId: null,
  lastSeq: 0,
  logLines: [],
  loadedLogFor: null,
  cancelArmed: false,
  cancelTimer: null,
  submitting: false,
  refreshing: false,
  reconnectTimer: null,
};

function disarmCancel() {
  state.cancelArmed = false;
  if (state.cancelTimer) {
    clearTimeout(state.cancelTimer);
    state.cancelTimer = null;
  }
  ui.setCancelArmed(false);
}

const TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function firstDeployableApp() {
  return state.apps.find((app) => app.deployable) ?? state.apps[0] ?? null;
}

function updateDeployAvailability() {
  ui.setDeployEnabled(Boolean(state.app?.deployable && state.variant && state.targetValid));
}

function validateTarget() {
  const { app, variant } = state;
  let valid = Boolean(app && variant && state.targetName);
  let message = '';
  if (!app) {
    valid = false;
    message = '请先选择应用。';
  } else if (!variant) {
    valid = false;
    message = '这个应用没有可用的构建脚本。';
  } else if (!state.targetName) {
    valid = false;
    message = '请输入发布文件夹名称。';
  } else if (!TARGET_NAME_RE.test(state.targetName)) {
    valid = false;
    message = '只能包含字母、数字、点、下划线和连字符，且不能以点开头。';
  } else {
    message = `默认 ${variant.targetName}；文件夹必须直接位于 ${state.meta?.deployRoot || '发布根目录'} 下。`;
  }
  state.targetValid = valid;
  ui.setTargetValidity(valid, message);
  updateDeployAvailability();
}

function applyTargetName(value) {
  state.targetName = String(value ?? '').trim();
  ui.setTargetName(state.targetName);
  validateTarget();
}

function handleTargetInput() {
  state.targetName = ui.getTargetName().trim();
  validateTarget();
}

function handleTargetBlur() {
  if (!state.targetName && state.variant) {
    applyTargetName(state.variant.targetName);
    return;
  }
  ui.setTargetName(state.targetName);
  validateTarget();
}

function selectApp(name, preferredVariant) {
  const app = state.apps.find((item) => item.name === name) ?? firstDeployableApp();
  state.app = app;
  ui.setAppInputValue(app?.name ?? '');
  ui.setAppCount(`${state.apps.length} 个应用`);
  ui.setTargetDisabled(!app);

  if (!app) {
    state.variant = null;
    ui.renderVariants(null, null, selectVariant);
    applyTargetName('');
    return;
  }

  const remembered = state.variantByApp.get(app.name);
  const variant =
    app.variants.find((item) => item.name === preferredVariant) ??
    app.variants.find((item) => item.name === remembered) ??
    app.variants.find((item) => item.recommended) ??
    app.variants[0] ??
    null;
  selectVariant(variant?.name ?? null);
}

function selectVariant(name) {
  const app = state.app;
  const variant = app?.variants.find((item) => item.name === name) ?? null;
  state.variant = variant;
  if (variant && app) state.variantByApp.set(app.name, variant.name);
  ui.renderVariants(app, variant?.name ?? null, selectVariant);
  applyTargetName(variant?.targetName ?? app?.name ?? '');
}

function syncFormToJob(job) {
  const app = state.apps.find((item) => item.name === job.app);
  if (!app) return;
  // Only mirror the app/variant/target. Pull/install stay as the operator left
  // them, so viewing an old no-pull build cannot silently become the default.
  selectApp(app.name, job.variant);
  if (job.targetName) applyTargetName(job.targetName);
}

function filteredApps() {
  if (!state.appFilterActive) return state.apps;
  const filter = ui.getAppInputValue().trim().toLowerCase();
  if (!filter) return state.apps;
  return state.apps.filter((app) => app.name.toLowerCase().includes(filter));
}

function renderAppList({ resetActive = false } = {}) {
  const apps = filteredApps();
  state.filteredApps = apps;
  if (resetActive || state.appActiveIndex < 0 || state.appActiveIndex >= apps.length) {
    const selectedIndex = apps.findIndex((app) => app.name === state.app?.name);
    state.appActiveIndex = selectedIndex >= 0 ? selectedIndex : apps.length ? 0 : -1;
  }
  ui.renderAppOptions(
    apps,
    state.app?.name,
    state.appActiveIndex,
    chooseAppFromList,
    activateAppOption,
  );
  const filter = state.appFilterActive ? ui.getAppInputValue().trim() : '';
  ui.setAppCount(filter ? `${apps.length} / ${state.apps.length}` : `${state.apps.length} 个应用`);
}

function openAppList({ selectText = false } = {}) {
  if (!state.apps.length) return;
  state.appListOpen = true;
  state.appFilterActive = false;
  ui.setAppListOpen(true);
  renderAppList();
  if (selectText) ui.selectAppInputText();
}

function closeAppList({ resetInput = true } = {}) {
  state.appListOpen = false;
  state.appFilterActive = false;
  state.appActiveIndex = -1;
  ui.setAppListOpen(false);
  if (resetInput) {
    ui.setAppInputValue(state.app?.name ?? '');
    ui.setAppCount(`${state.apps.length} 个应用`);
  }
}

function activateAppOption(index) {
  state.appActiveIndex = index;
  ui.setAppActiveIndex(index);
}

function chooseAppFromList(name) {
  closeAppList({ resetInput: false });
  ui.setFormMessage('');
  selectApp(name, null);
  // Keep the completed name selected so the next keystroke replaces it.
  ui.selectAppInputText();
}

function handleAppFocus() {
  if (!state.appListOpen) openAppList({ selectText: true });
}

function handleAppClick() {
  if (!state.appListOpen) openAppList({ selectText: true });
}

function handleAppInput() {
  state.appFilterActive = true;
  ui.setAppClearVisible(Boolean(ui.getAppInputValue()));
  if (!state.appListOpen) {
    state.appListOpen = true;
    ui.setAppListOpen(true);
  }
  renderAppList({ resetActive: true });
}

function clearAppFilter() {
  ui.setAppInputValue('');
  state.appFilterActive = true;
  ui.focusAppInput();
  openAppList();
  renderAppList({ resetActive: true });
}

function handleAppKeydown(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!state.appListOpen) {
      openAppList();
      return;
    }
    const length = state.filteredApps.length;
    if (!length) return;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    state.appActiveIndex = (state.appActiveIndex + direction + length) % length;
    ui.setAppActiveIndex(state.appActiveIndex);
    return;
  }

  if (event.key === 'Enter') {
    // Never let Enter inside the combobox submit the deploy form.
    event.preventDefault();
    if (!state.appListOpen) {
      openAppList();
      return;
    }
    const app = state.filteredApps[state.appActiveIndex] ?? state.filteredApps[0];
    if (app) chooseAppFromList(app.name);
    return;
  }

  if (event.key === 'Escape') {
    if (state.appListOpen) {
      event.preventDefault();
      closeAppList();
    }
    return;
  }

  if (event.key === 'Tab') closeAppList();
}

function handleAppBlur(event) {
  if (ui.els.appCombo.contains(event.relatedTarget)) return;
  const value = ui.getAppInputValue().trim();
  const exact = state.apps.find((app) => app.name.toLowerCase() === value.toLowerCase());
  if (exact) {
    closeAppList({ resetInput: false });
    selectApp(exact.name, null);
  } else {
    closeAppList();
  }
}

function updateHash(jobId) {
  const next = jobId ? `#job=${encodeURIComponent(jobId)}` : '#';
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
}

function closeStream() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  state.streamJobId = null;
}

async function connectStream(job, { reset = true } = {}) {
  closeStream();
  state.streamJobId = job.id;
  if (reset) {
    state.lastSeq = 0;
    state.logLines = [];
    state.loadedLogFor = null;
    ui.setLogs([]);
  }
  const suffix = reset ? '' : `?since=${state.lastSeq}`;
  const source = new EventSource(`${api.eventsUrl(job.id)}${suffix}`);
  state.source = source;

  source.addEventListener('snapshot', (event) => {
    if (state.streamJobId !== job.id) return;
    try {
      const data = JSON.parse(event.data);
      if (data.job) mergeJob(data.job);
    } catch {
      /* ignore malformed event */
    }
  });

  source.addEventListener('log', (event) => {
    if (state.streamJobId !== job.id) return;
    try {
      const data = JSON.parse(event.data);
      if (typeof data.seq === 'number' && data.seq <= state.lastSeq) return;
      if (typeof data.seq === 'number') state.lastSeq = data.seq;
      const line = { text: data.line || '', stream: data.stream || '' };
      state.logLines.push(line);
      if (state.logLines.length > 3000) state.logLines.shift();
      ui.appendLogLine(line);
    } catch {
      /* ignore malformed event */
    }
  });

  source.addEventListener('end', async (event) => {
    if (state.streamJobId !== job.id) return;
    try {
      const data = JSON.parse(event.data);
      if (state.currentJob) {
        state.currentJob = {
          ...state.currentJob,
          status: data.status || state.currentJob.status,
          cancelRequested: false,
        };
        ui.renderJob(state.currentJob);
      }
    } catch {
      /* ignore malformed event */
    }
    closeStream();
    if (state.currentJobId === job.id) {
      try {
        await loadFullLog(job.id);
        await refreshCurrentJob();
        await refreshMeta();
      } catch (error) {
        ui.toast(`刷新任务结果失败：${error.message}`);
      }
    }
  });

  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) return;
    if (state.streamJobId !== job.id || !isActive(state.currentJob?.status)) return;
    state.source = null;
    state.streamJobId = null;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.currentJobId === job.id && isActive(state.currentJob?.status)) {
        ui.toast('日志连接中断，正在重连…');
        void connectStream(state.currentJob, { reset: false });
      }
    }, 2500);
  };
}

function mergeJob(job) {
  if (!job || job.id !== state.currentJobId) return;
  state.currentJob = job;
  ui.renderJob(job);
  if (!isActive(job.status) || job.cancelRequested) disarmCancel();
  else if (state.cancelArmed) ui.setCancelArmed(true);
}

async function loadFullLog(id) {
  try {
    const text = await api.log(id);
    if (state.currentJobId !== id) return;
    if (text === null) {
      state.loadedLogFor = id;
      ui.setLogs([{ text: '没有找到这个任务的日志文件。', stream: 'meta' }]);
      return;
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    state.logLines = lines.map((line) => ({ text: line, stream: '' }));
    ui.setLogs(state.logLines);
    state.loadedLogFor = id;
  } catch (error) {
    if (state.currentJobId !== id) return;
    ui.setLogs([{ text: `日志读取失败：${error.message}`, stream: 'stderr' }]);
    ui.toast(`日志读取失败：${error.message}`);
  }
}

async function selectJob(input) {
  let job = input;
  if (typeof input === 'string') {
    try {
      job = (await api.job(input)).job;
    } catch (error) {
      ui.toast(error.message);
      updateHash(null);
      return;
    }
  }
  if (!job) return;

  closeStream();
  disarmCancel();
  state.currentJob = job;
  state.currentJobId = job.id;
  state.lastSeq = 0;
  state.logLines = [];
  state.loadedLogFor = null;
  syncFormToJob(job);
  ui.renderJob(job);
  ui.setLogs([]);
  updateHash(job.id);

  if (isActive(job.status)) {
    await connectStream(job);
  } else {
    await loadFullLog(job.id);
  }
}

async function refreshCurrentJob() {
  if (!state.currentJobId) return;
  let data;
  try {
    data = await api.job(state.currentJobId);
  } catch {
    return;
  }
  const current = data.job;
  if (!current || current.id !== state.currentJobId) return;
  if (state.currentJob && current.lastSeq < state.currentJob.lastSeq && isActive(state.currentJob.status)) {
    return;
  }
  state.currentJob = current;
  ui.renderJob(current);
  if (state.cancelArmed && isActive(current.status)) ui.setCancelArmed(true);
  else if (!isActive(current.status)) disarmCancel();

  if (!isActive(current.status) && state.loadedLogFor !== current.id && !state.source) {
    await loadFullLog(current.id);
  } else if (isActive(current.status) && !state.source && !state.reconnectTimer) {
    void connectStream(current, { reset: false });
  }
}

function applyMeta(meta) {
  const previous = {
    app: state.app?.name,
    variant: state.variant?.name,
    target: state.targetName,
  };
  closeAppList({ resetInput: false });
  state.meta = meta;
  state.apps = meta.apps;
  ui.setMeta(meta);
  ui.setAppInputDisabled(meta.apps.length === 0);

  const appName = previous.app;
  if (!appName || !meta.apps.some((app) => app.name === appName)) {
    selectApp(firstDeployableApp()?.name ?? null);
  } else {
    selectApp(appName, previous.variant);
    if (previous.target && state.variant?.name === previous.variant) {
      applyTargetName(previous.target);
    }
  }

  if (meta.apps.length === 0) {
    ui.setFormMessage('仓库中没有发现 apps/* 应用，请检查配置。', 'error');
  }
}

async function refreshMeta() {
  applyMeta(await api.meta());
}

async function refreshAll({ silent = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  ui.setRefreshBusy(true);
  try {
    // Pull first so apps added on the remote show up in the same refresh,
    // then apply the app list/Git state returned with the pull result.
    const result = await api.pull();
    applyMeta(result);
    await refreshCurrentJob();
    if (silent) return;

    const pull = result.pull ?? {};
    if (pull.status === 'failed') {
      ui.setFormMessage(`已刷新，但拉取失败：${pull.message}`, 'error');
      ui.toast(`拉取失败：${pull.message}`);
    } else if (pull.status === 'skipped') {
      ui.setFormMessage(pull.message || '已跳过拉取。', 'info');
    } else {
      const hint = pull.dependencyChanged ? ' 依赖有变化，部署时请勾选「重新安装依赖」。' : '';
      ui.setFormMessage(`${pull.message || '已刷新。'}${hint}`, 'info');
    }
  } catch (error) {
    ui.toast(`刷新失败：${error.message}`);
  } finally {
    state.refreshing = false;
    ui.setRefreshBusy(false);
  }
}

async function handleDeploy(event) {
  event.preventDefault();
  if (state.submitting || !state.app || !state.variant) return;
  if (!state.targetValid) {
    ui.setFormMessage('请检查发布文件夹名称。', 'error');
    return;
  }
  state.submitting = true;
  ui.setDeployBusy(true);
  ui.setFormMessage('');
  try {
    const data = await api.create({
      app: state.app.name,
      variant: state.variant.name,
      targetName: state.targetName,
      pull: ui.els.pullToggle.checked,
      install: ui.els.installToggle.checked,
    });
    ui.setFormMessage('任务已加入队列。', 'success');
    await selectJob(data.job);
    ui.scrollToRunPanel();
  } catch (error) {
    ui.setFormMessage(error.message, 'error');
  } finally {
    state.submitting = false;
    ui.setDeployBusy(false);
  }
}

async function handleCancel() {
  const job = state.currentJob;
  if (!job || !isActive(job.status) || job.cancelRequested) return;
  if (!state.cancelArmed) {
    state.cancelArmed = true;
    ui.setCancelArmed(true);
    state.cancelTimer = setTimeout(disarmCancel, 3500);
    return;
  }
  disarmCancel();
  try {
    const data = await api.cancel(job.id);
    mergeJob(data.job);
    ui.toast('已发送取消请求', 'success');
  } catch (error) {
    ui.toast(error.message);
  }
}

function bindEvents() {
  ui.els.appInput.addEventListener('focus', handleAppFocus);
  ui.els.appInput.addEventListener('mousedown', (event) => {
    if (state.appListOpen) return;
    // Keep the completed app name selected so typing starts a new filter
    // instead of appending to the old one.
    event.preventDefault();
    ui.focusAppInput();
    openAppList({ selectText: true });
  });
  ui.els.appInput.addEventListener('click', handleAppClick);
  ui.els.appInput.addEventListener('input', handleAppInput);
  ui.els.appInput.addEventListener('keydown', handleAppKeydown);
  ui.els.appInput.addEventListener('blur', handleAppBlur);
  ui.els.appClear.addEventListener('click', clearAppFilter);
  ui.els.appToggle.addEventListener('click', () => {
    if (state.appListOpen) {
      closeAppList();
    } else {
      ui.focusAppInput();
      openAppList({ selectText: true });
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (state.appListOpen && !ui.els.appCombo.contains(event.target)) closeAppList();
  });

  ui.els.targetName.addEventListener('input', handleTargetInput);
  ui.els.targetName.addEventListener('blur', handleTargetBlur);

  ui.els.deployForm.addEventListener('submit', (event) => void handleDeploy(event));
  ui.els.refreshButton.addEventListener('click', () => void refreshAll());
  ui.els.cancelJob.addEventListener('click', () => void handleCancel());
  ui.els.followLog.addEventListener('change', () => {
    if (ui.els.followLog.checked) ui.scrollLogToBottom();
  });
  ui.els.logOutput.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = ui.els.logOutput;
    if (scrollHeight - scrollTop - clientHeight > 32 && ui.els.followLog.checked) {
      ui.els.followLog.checked = false;
    }
  });
  window.addEventListener('hashchange', () => {
    const id = new URLSearchParams(window.location.hash.slice(1)).get('job');
    if (id && id !== state.currentJobId) void selectJob(id);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshCurrentJob().catch(() => {});
  });
}

function startPolling() {
  setInterval(() => {
    if (state.currentJobId) void refreshCurrentJob().catch(() => {});
  }, 5000);
  setInterval(() => {
    if (state.currentJob && isActive(state.currentJob.status)) ui.renderDuration(state.currentJob);
  }, 1000);
}

async function boot() {
  bindEvents();
  try {
    const meta = await api.meta();
    state.meta = meta;
    state.apps = meta.apps;
    ui.setMeta(meta);
    ui.setAppInputDisabled(meta.apps.length === 0);
    if (meta.repo && meta.repo.branchMatches === false) {
      ui.toast(`仓库当前分支 ${meta.repo.branch} 与配置的 ${meta.repo.expectedBranch} 不一致，部署会失败。`);
    }

    const hashId = new URLSearchParams(window.location.hash.slice(1)).get('job');
    let initialJob = hashId ? await safeFetchJob(hashId) : null;
    if (!initialJob && meta.activeJobId) initialJob = await safeFetchJob(meta.activeJobId);

    const initialApp =
      meta.apps.find((app) => app.name === initialJob?.app)?.name ??
      firstDeployableApp()?.name ??
      null;
    selectApp(initialApp, initialJob?.variant);

    if (initialJob) await selectJob(initialJob);
    else ui.renderIdle();

    if (meta.apps.length === 0) {
      ui.setFormMessage('仓库中没有发现 apps/* 应用，请检查配置。', 'error');
    }
    startPolling();
  } catch (error) {
    ui.renderIdle();
    ui.setFormMessage(`初始化失败：${error.message}`, 'error');
    ui.toast(`初始化失败：${error.message}`);
  }
}

async function safeFetchJob(id) {
  try {
    return (await api.job(id)).job;
  } catch {
    return null;
  }
}

void boot();
