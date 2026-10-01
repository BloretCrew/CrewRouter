'use strict';

// 启动页只根据主进程推送的状态快照渲染；用户操作只发 IPC，不在本地猜测结果。
const api = window.crewrouterDesktop;
const i18n = window.CrewRouterDesktopI18n;
const $ = (id) => document.getElementById(id);
const t = (key, vars) => i18n.t(key, vars);

const IDLE_VIEWS = new Set(['welcome', 'local-name', 'remote-method', 'custom-url', 'settings']);
function createIcon(name, size = 16) {
  return window.Blora.createBloraIcon(name === 'more' ? 'ellipsis' : name === 'refresh' ? 'refresh-cw' : name, size);
}
function mountIcons(root = document) {
  window.Blora.hydrateIcons(root);
}

const state = { status: null, view: 'welcome', profiles: [], settings: null, prefillApplied: false, busy: false };
const views = [...document.querySelectorAll('.launcher__view')];

function showFatal(message) {
  views.forEach((view) => { view.hidden = view.dataset.view !== 'error'; });
  $('error-result').setAttribute('description', message);
  $('retry').hidden = true;
  $('dismiss-error').hidden = true;
}
if (!api || !i18n) { showFatal(i18n ? i18n.t('bridge.missing') : '桌面桥接加载失败，请重启应用后重试。'); throw new Error('CrewRouter Desktop preload API unavailable'); }

function ipcErrorMessage(error) {
  return String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
function fieldControl(field) { return field?.querySelector?.('input, textarea') || null; }
function fieldValue(field) { return String(fieldControl(field)?.value ?? field?.value ?? '').trim(); }
function setFieldValue(field, value) { const control = fieldControl(field); if (control) control.value = value; field?.setAttribute('value', value); }
function setFieldError(field, message = '') { if (message) { field.setAttribute('error', message); field.setAttribute('state', 'invalid'); } else { field.removeAttribute('error'); field.removeAttribute('state'); } }
// 与主进程 validateLocalDisplayName 一致：拒绝 HTML/引号/斜杠与控制字符。
function hasUnsafeNameCharacter(value) {
  if (/[<>"'`\\/]/.test(value)) return true;
  return Array.from(value).some((char) => { const code = char.codePointAt(0); return code < 32 || code === 127; });
}

function showInlineAlert(message) {
  const alert = $('inline-alert');
  alert.setAttribute('description', message);
  alert.hidden = false;
}
function hideInlineAlert() { $('inline-alert').hidden = true; }

function applyTheme(theme) {
  const scheme = theme === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.bloraColorScheme = scheme;
  document.documentElement.style.colorScheme = scheme;
}

function setView(next, { focus = true } = {}) {
  state.view = next;
  document.getElementById('launcher').dataset.view = next;
  views.forEach((view) => { view.hidden = view.dataset.view !== next; });
  hideInlineAlert();
  if (!focus) return;
  const target = next === 'remote-method' ? $('official-remote') : next === 'settings' ? $('settings-back') : next === 'local-name' ? fieldControl($('local-username-field')) : next === 'custom-url' ? fieldControl($('custom-url-field')) : next === 'welcome' ? ($('saved-panel').hidden ? $('choose-local') : $('profile-list').querySelector('button')) : next === 'error' ? ($('retry').hidden ? $('dismiss-error') : $('retry')) : null;
  window.requestAnimationFrame(() => target?.focus?.());
}

function badgeFor(profile) {
  if (profile.mode === 'local' || profile.runtime === 'desktop-local') return 'LOCAL';
  return profile.edition === 'team' ? 'TEAM' : 'PERSONAL';
}

function renderProfiles() {
  const list = $('profile-list');
  const panel = $('saved-panel');
  list.replaceChildren();
  const profiles = state.profiles;
  panel.hidden = profiles.length === 0;
  $('saved-count').textContent = profiles.length ? t('saved.count', { count: profiles.length }) : '';
  $('choices-title').textContent = profiles.length ? t('choices.titleMore') : t('choices.title');
  $('hero-eyebrow').textContent = profiles.length ? t('hero.welcome') : t('hero.first');
  $('hero-title').textContent = profiles.length ? t('hero.titleBack') : t('hero.title');
  $('hero-lead').textContent = profiles.length ? t('hero.leadBack') : t('hero.lead');
  profiles.forEach((profile) => {
    const row = document.createElement('div');
    row.className = 'blora-list__item launcher__profile';
    row.setAttribute('role', 'listitem');
    row.dataset.id = profile.id;
    const icon = document.createElement('span');
    icon.className = 'launcher__profile-icon blora-avatar';
    icon.dataset.size = 'sm';
    icon.dataset.variant = 'primary';
    icon.appendChild(createIcon(profile.mode === 'local' ? 'home' : 'globe', 18));
    const meta = document.createElement('div');
    meta.className = 'blora-list__meta';
    const title = document.createElement('div');
    title.className = 'blora-list__title';
    const name = document.createElement('span');
    name.textContent = profile.name;
    const badge = document.createElement('span');
    badge.className = 'blora-badge';
    badge.dataset.variant = profile.mode === 'local' ? 'success' : 'neutral';
    badge.textContent = badgeFor(profile);
    title.append(name, badge);
    const desc = document.createElement('div');
    desc.className = 'blora-list__desc';
    const when = i18n.formatTime(profile.lastConnectedAt);
    desc.textContent = `${profile.mode === 'local' ? t('choice.local') : profile.url} · ${when ? t('saved.lastConnected', { time: when }) : t('saved.never')}`;
    meta.append(title, desc);
    const actions = document.createElement('div');
    actions.className = 'launcher__profile-actions';
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'blora-button';
    connect.dataset.variant = 'primary';
    connect.dataset.size = 'sm';
    connect.dataset.action = 'connect';
    connect.textContent = t('saved.connect');
    const more = document.createElement('blora-dropdown');
    more.setAttribute('align', 'end');
    more.setAttribute('placement', 'bottom');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.slot = 'trigger';
    trigger.className = 'blora-button';
    trigger.dataset.variant = 'ghost';
    trigger.dataset.size = 'sm';
    trigger.setAttribute('aria-label', t('saved.more'));
    trigger.appendChild(createIcon('more', 16));
    const rename = document.createElement('blora-dropdown-item');
    rename.setAttribute('value', 'rename');
    rename.textContent = t('profile.rename');
    const remove = document.createElement('blora-dropdown-item');
    remove.setAttribute('value', 'delete');
    remove.textContent = t('profile.delete');
    more.append(trigger, rename, remove);
    actions.append(connect, more);
    row.append(icon, meta, actions);
    list.appendChild(row);
  });
}

async function refreshProfiles() {
  try { state.profiles = await api.listProfiles(); } catch { state.profiles = []; }
  renderProfiles();
}

function renderProgress(status) {
  const kind = status.pending?.kind || (status.mode === 'starting-local' ? 'local' : 'custom');
  const official = status.mode === 'awaiting-official-login';
  $('progress-title').textContent = status.mode === 'connected' ? t('progress.opening') : official ? t('progress.official') : kind === 'local' ? t('progress.local') : t('progress.remote');
  $('official-wait').hidden = !official;
  $('progress-bar-wrap').hidden = official;
  const progress = status.progress;
  const percent = progress && progress.total ? Math.round((progress.step / progress.total) * 100) : (status.mode === 'connected' ? 100 : 5);
  const bar = $('progress-bar');
  bar.setAttribute('value', String(percent));
  bar.setAttribute('label', progress?.label || $('progress-title').textContent);
  $('progress-label').textContent = progress?.label || '';
}

function renderError(status) {
  const error = status.error || {};
  $('error-result').setAttribute('title', t('error.title'));
  $('error-result').setAttribute('description', error.message || '');
  $('retry').hidden = !error.retry;
  $('error-open-logs').hidden = error.kind !== 'local';
  $('dismiss-error').hidden = false;
}

function renderSettings(status) {
  const settings = state.settings;
  if (settings) {
    ['autoConnect', 'notifications', 'updateChecks'].forEach((key) => { $(`pref-${key}`).toggleAttribute('checked', settings[key] !== false); });
    $('pref-theme').setAttribute('value', settings.theme || 'system');
    $('pref-language').setAttribute('value', settings.language || status.language || 'zh');
  }
  const local = status.localServer || {};
  $('local-status').textContent = local.ready ? t('settings.running') : t('settings.stopped');
  $('local-pid').textContent = local.ready && local.pid ? String(local.pid) : '-';
  $('local-port').textContent = local.ready && local.port ? String(local.port) : '-';
  $('local-version').textContent = local.version || '-';
  $('local-logs').textContent = local.logsDir || '-';
  $('local-restart').disabled = !status.localProfile;
  $('local-stop').disabled = !local.ready;
  $('local-restart').textContent = local.ready ? t('settings.restartLocal') : t('local.submit');
}

function render(status) {
  if (!status) return;
  state.status = status;
  if (status.language && status.language !== i18n.language) { i18n.setLanguage(status.language); mountIcons(); renderProfiles(); }
  if (status.theme) applyTheme(status.theme);
  $('local-chip').hidden = !status.localServer?.ready;
  const busy = ['starting-local', 'connecting', 'awaiting-official-login', 'connected'].includes(status.mode);
  state.busy = busy;
  document.querySelectorAll('.launcher__view:not([data-view="progress"]) button').forEach((button) => { button.disabled = busy; });
  ['local-username-field', 'custom-url-field'].forEach((id) => $(id).toggleAttribute('disabled', busy));
  if (busy) { renderProgress(status); setView('progress', { focus: false }); if (document.activeElement?.closest('[hidden]')) $('cancel-pending').focus(); return; }
  if (status.mode === 'error') { renderError(status); setView('error'); return; }
  if (state.view === 'settings') renderSettings(status);
  if (!IDLE_VIEWS.has(state.view)) setView('welcome');
  if (status.prefill?.serverUrl && !state.prefillApplied) {
    state.prefillApplied = true;
    setFieldValue($('custom-url-field'), status.prefill.serverUrl);
    setView('custom-url');
  }
}

let confirmResolver = null;
function confirmDialog({ message, okLabel = t('nav.confirm'), danger = true }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = t('nav.confirm');
  $('confirm-text').textContent = message;
  $('confirm-ok').textContent = okLabel;
  $('confirm-ok').dataset.variant = danger ? 'danger' : 'primary';
  return new Promise((resolve) => {
    confirmResolver?.(false);
    confirmResolver = resolve;
    dialog.show();
  });
}
$('confirm-ok').addEventListener('click', () => { const resolve = confirmResolver; confirmResolver = null; $('confirm-dialog').close(); resolve?.(true); });
$('confirm-cancel').addEventListener('click', () => { const resolve = confirmResolver; confirmResolver = null; $('confirm-dialog').close(); resolve?.(false); });
$('confirm-dialog').addEventListener('blora-close', () => { const resolve = confirmResolver; confirmResolver = null; resolve?.(false); });

let renameResolver = null;
function renameDialog(current) {
  setFieldValue($('rename-field'), current);
  setFieldError($('rename-field'));
  return new Promise((resolve) => {
    renameResolver?.(null);
    renameResolver = resolve;
    $('rename-dialog').show();
    setTimeout(() => fieldControl($('rename-field'))?.focus(), 60);
  });
}
$('rename-ok').addEventListener('click', () => { const value = fieldValue($('rename-field')); if (!value) { setFieldError($('rename-field'), t('local.required')); return; } const resolve = renameResolver; renameResolver = null; $('rename-dialog').close(); resolve?.(value); });
$('rename-cancel').addEventListener('click', () => { const resolve = renameResolver; renameResolver = null; $('rename-dialog').close(); resolve?.(null); });
$('rename-dialog').addEventListener('blora-close', () => { const resolve = renameResolver; renameResolver = null; resolve?.(null); });

async function run(action, { field } = {}) {
  hideInlineAlert();
  try { return await action(); }
  catch (error) {
    const message = ipcErrorMessage(error) || t('error.title');
    // 主进程失败时会先推送 error 状态（状态推送与 IPC 回复同序），这里只处理动作前置校验类错误。
    if (state.status?.mode !== 'error') {
      if (field) setFieldError(field, message);
      showInlineAlert(message);
    }
    return null;
  }
}

$('open-settings').addEventListener('click', async () => {
  if (state.busy) return;
  try { const data = await api.getDesktopSettings(); state.settings = data.settings; state.profiles = data.profiles || state.profiles; } catch (error) { showInlineAlert(ipcErrorMessage(error)); return; }
  renderSettings(state.status || {});
  setView('settings');
});
$('settings-back').addEventListener('click', () => { refreshProfiles(); setView('welcome'); });
$('choose-local').addEventListener('click', () => {
  if (state.busy) return;
  if (state.status?.localProfile?.displayName) { run(() => api.startLocal()); return; }
  setView('local-name');
});
$('choose-remote').addEventListener('click', () => { if (!state.busy) setView('remote-method'); });
$('local-back').addEventListener('click', () => setView('welcome'));
$('remote-back').addEventListener('click', () => setView('welcome'));
$('custom-back').addEventListener('click', () => setView('remote-method'));
$('official-remote').addEventListener('click', () => { if (!state.busy) run(() => api.openOfficialLogin()); });
$('custom-remote').addEventListener('click', () => { if (!state.busy) setView('custom-url'); });
$('local-profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.busy) return;
  const field = $('local-username-field');
  const value = fieldValue(field);
  setFieldError(field);
  if (!value) { setFieldError(field, t('local.required')); fieldControl(field)?.focus(); return; }
  if (value.length > 64 || hasUnsafeNameCharacter(value)) { setFieldError(field, t('local.invalid')); fieldControl(field)?.focus(); return; }
  run(() => api.startLocal(value), { field });
});
$('connection-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.busy) return;
  const field = $('custom-url-field');
  const value = fieldValue(field);
  setFieldError(field);
  if (!value) { setFieldError(field, t('custom.required')); fieldControl(field)?.focus(); return; }
  let parsed;
  try { parsed = new URL(value); } catch { setFieldError(field, t('custom.invalid')); fieldControl(field)?.focus(); return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) { setFieldError(field, t('custom.protocol')); fieldControl(field)?.focus(); return; }
  run(() => api.connectCustomRemote(value), { field });
});
$('cancel-pending').addEventListener('click', () => run(() => api.cancelPending()));
$('reopen-login').addEventListener('click', () => run(() => api.reopenOfficialLogin()));
$('retry').addEventListener('click', () => run(() => api.retry()));
$('error-open-logs').addEventListener('click', () => run(() => api.openLogs()));
$('dismiss-error').addEventListener('click', async () => { await run(() => api.clearError()); await refreshProfiles(); setView('welcome'); });
$('profile-list').addEventListener('click', async (event) => {
  const row = event.target.closest('.launcher__profile');
  if (!row || state.busy) return;
  const profile = state.profiles.find((item) => item.id === row.dataset.id);
  if (!profile) return;
  if (event.target.closest('[data-action="connect"]')) { run(() => api.switchProfile(profile.id)); return; }
});
$('profile-list').addEventListener('blora-select', async (event) => {
  const row = event.target.closest('.launcher__profile');
  if (!row || state.busy) return;
  const profile = state.profiles.find((item) => item.id === row.dataset.id);
  if (!profile) return;
  const action = event.detail.value;
  if (action === 'rename') {
    const name = await renameDialog(profile.name);
    if (name && name !== profile.name) { await run(async () => { state.profiles = await api.renameProfile(profile.id, name); }); renderProfiles(); }
  } else if (action === 'delete') {
    if (await confirmDialog({ message: t('confirm.deleteProfile', { name: profile.name }), okLabel: t('profile.delete') })) { await run(async () => { state.profiles = await api.deleteProfile(profile.id); }); renderProfiles(); }
  }
});

function selectValue(select, fallback) {
  const value = typeof select.value === 'string' && select.value ? select.value : select.getAttribute('value');
  return value || fallback;
}
function savePreferences() {
  const language = selectValue($('pref-language'), i18n.language);
  return run(async () => {
    state.settings = await api.saveDesktopSettings({ autoConnect: $('pref-autoConnect').checked, notifications: $('pref-notifications').checked, updateChecks: $('pref-updateChecks').checked, theme: selectValue($('pref-theme'), 'system'), language });
    renderSettings(state.status || {});
  });
}
['pref-autoConnect', 'pref-notifications', 'pref-updateChecks'].forEach((id) => $(id).addEventListener('change', savePreferences));
['pref-theme', 'pref-language'].forEach((id) => { $(id).addEventListener('change', savePreferences); });
$('local-restart').addEventListener('click', async () => {
  if (!state.status?.localServer?.ready) { run(() => api.startLocal()); return; }
  if (await confirmDialog({ message: t('confirm.restartLocal'), okLabel: t('settings.restartLocal'), danger: false })) run(() => api.restartLocal());
});
$('local-stop').addEventListener('click', async () => { if (await confirmDialog({ message: t('confirm.stopLocal'), okLabel: t('settings.stopLocal') })) run(() => api.stopLocal()); });
$('local-open-logs').addEventListener('click', () => run(() => api.openLogs()));
$('copy-diagnostics').addEventListener('click', () => run(async () => { await navigator.clipboard.writeText(JSON.stringify(await api.getDiagnostics(), null, 2)); $('settings-message').textContent = t('settings.copied'); }));
$('restart-app').addEventListener('click', async () => { if (await confirmDialog({ message: t('confirm.restartApp'), okLabel: t('settings.restartApp'), danger: false })) run(() => api.restartApp()); });
$('quit-app').addEventListener('click', async () => { if (await confirmDialog({ message: t('confirm.quit'), okLabel: t('settings.quit') })) run(() => api.quit()); });
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (state.status?.theme === 'system') applyTheme('system'); });

mountIcons();
i18n.apply();
api.onStatus(render);
(async () => {
  try {
    const status = await api.getStatus();
    if (status.language) i18n.setLanguage(status.language);
    await refreshProfiles();
    try { const data = await api.getDesktopSettings(); state.settings = data.settings; } catch {}
    render(status);
    try { const diagnostics = await api.getDiagnostics(); if (diagnostics?.version) $('app-version').textContent = `v${diagnostics.version}`; } catch {}
  } catch (error) { showFatal(ipcErrorMessage(error) || t('bridge.missing')); }
})();
