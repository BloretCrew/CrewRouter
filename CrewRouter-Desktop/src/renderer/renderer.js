'use strict';

const api = window.crewrouterDesktop;
const settingsButton = document.getElementById('settings');
const runtimeError = document.getElementById('runtime-error');
const statusEl = document.getElementById('status');
const statusPanel = document.getElementById('status-panel');
const statusResult = document.getElementById('status-result');
const stepsEl = document.getElementById('oobe-steps');
const introEl = document.getElementById('intro');
const panels = {
  welcome: document.getElementById('welcome-panel'),
  local: document.getElementById('local-profile-panel'),
  remote: document.getElementById('remote-method-panel'),
  custom: document.getElementById('custom-target-panel'),
};
const localField = document.getElementById('local-username-field');
const customField = document.getElementById('custom-url-field');
const localError = document.getElementById('local-username-error');
const customError = document.getElementById('url-error');
let currentStep = 'welcome';
let isBusy = false;

function showRuntimeError(message) {
  if (runtimeError) runtimeError.textContent = message;
  if (statusEl) statusEl.textContent = message;
  if (statusPanel) statusPanel.hidden = false;
  if (statusResult) { statusResult.setAttribute('variant', 'error'); statusResult.setAttribute('title', '桌面桥接加载失败'); statusResult.setAttribute('description', message); }
}
if (!api) { showRuntimeError('桌面桥接加载失败，请重启应用后重试。'); throw new Error('CrewRouter Desktop preload API unavailable'); }

const iconPaths = {
  'arrow-right': [['line', { x1: '5', y1: '12', x2: '19', y2: '12' }], ['polyline', { points: '12 5 19 12 12 19' }]],
  'chevron-left': [['polyline', { points: '15 18 9 12 15 6' }]],
  'chevron-right': [['polyline', { points: '9 18 15 12 9 6' }]],
  'external-link': [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
  globe: [['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '2', y1: '12', x2: '22', y2: '12' }], ['path', { d: 'M12 2a15.3 15.3 0 0 1 0 20M12 2a15.3 15.3 0 0 0 0 20' }]],
  home: [['path', { d: 'm3 10 9-7 9 7' }], ['path', { d: 'M5 9v11h14V9' }], ['path', { d: 'M9 20v-6h6v6' }]],
  search: [['circle', { cx: '11', cy: '11', r: '7' }], ['path', { d: 'm20 20-4-4' }]],
  settings: [['path', { d: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z' }], ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.4 1.4-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L9 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H7v-2h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L8.4 9 9.8 7.6l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 9l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v2H21a1.7 1.7 0 0 0-1.6 1Z' }]],
};
function createBloraIcon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }).forEach(([key, value]) => svg.setAttribute(key, String(value)));
  svg.dataset.bloraIcon = name;
  (iconPaths[name] || []).forEach(([tag, attrs]) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value)); svg.appendChild(node); });
  return svg;
}
function mountIcons() { document.querySelectorAll('[data-icon]').forEach((host) => { if (!host.querySelector('svg') && iconPaths[host.dataset.icon]) host.appendChild(createBloraIcon(host.dataset.icon, host.classList.contains('oobe-choice__icon') ? 20 : 16)); }); }
mountIcons();

function fieldValue(field) { return String(field?.value || '').trim(); }
function setFieldError(field, element, message = '') { element.textContent = message; if (message) field.setAttribute('error', message); else field.removeAttribute('error'); }
function setStatus(message, variant = 'info') {
  statusPanel.hidden = false;
  statusEl.textContent = message;
  statusResult.setAttribute('variant', variant);
  statusResult.setAttribute('title', variant === 'error' ? '需要处理' : variant === 'success' ? '已完成' : '正在处理');
  statusResult.setAttribute('description', message);
}
function updateProgress(step) {
  const index = step === 'welcome' ? 0 : (step === 'local' || step === 'remote' ? 1 : 2);
  stepsEl.setAttribute('current', String(index));
  stepsEl.current = index;
  stepsEl.setCurrent?.(index);
}
function focusStep(step) {
  const target = step === 'welcome' ? document.getElementById('local') : step === 'local' ? localField : step === 'remote' ? document.getElementById('official-remote') : customField;
  window.requestAnimationFrame(() => target?.focus?.());
}
function renderStep(step, { focus = true } = {}) {
  currentStep = step;
  Object.entries(panels).forEach(([name, panel]) => { panel.hidden = name !== step; });
  updateProgress(step);
  statusPanel.hidden = true;
  if (focus) focusStep(step);
}
function setBusy(value) {
  isBusy = value;
  document.querySelectorAll('button').forEach((button) => { button.disabled = value; if (value) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy'); });
  [localField, customField].forEach((field) => { if (field) field.toggleAttribute('disabled', value); });
}
function showError(error, field, errorElement) { setBusy(false); if (field) setFieldError(field, errorElement, error?.message || '连接失败，请检查地址后重试。'); setStatus(error?.message || '连接失败，请检查地址后重试。', 'error'); }
function validateUrl(value, field, errorElement, requiredMessage) {
  setFieldError(field, errorElement);
  if (!value) { setFieldError(field, errorElement, requiredMessage); setStatus(requiredMessage, 'error'); field.focus(); return false; }
  let parsed; try { parsed = new URL(value); } catch { setFieldError(field, errorElement, '请输入有效的 URL。'); setStatus('地址格式不正确。', 'error'); field.focus(); return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) { setFieldError(field, errorElement, '仅支持 http:// 或 https:// 地址。'); setStatus('地址格式不正确。', 'error'); field.focus(); return false; }
  return true;
}

settingsButton?.addEventListener('click', () => api.openSettings());
document.getElementById('local').addEventListener('click', () => { if (!isBusy) renderStep('local'); });
document.getElementById('remote-choice').addEventListener('click', () => { if (!isBusy) renderStep('remote'); });
document.getElementById('choice-back').addEventListener('click', () => { if (!isBusy) renderStep('welcome'); });
document.getElementById('local-back').addEventListener('click', () => { if (!isBusy) renderStep('welcome'); });
document.getElementById('official-remote').addEventListener('click', async () => { if (isBusy) return; setBusy(true); setStatus('正在打开官方站…'); try { await api.openOfficialDemo(); } catch (error) { showError(error); renderStep('remote', { focus: false }); } });
document.getElementById('custom-remote').addEventListener('click', () => { if (!isBusy) renderStep('custom'); });
document.getElementById('custom-back').addEventListener('click', () => { if (!isBusy) renderStep('remote'); });
document.getElementById('local-profile-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (isBusy) return;
  const displayName = fieldValue(localField); setFieldError(localField, localError);
  if (!displayName) { setFieldError(localField, localError, '用户名不能为空。'); setStatus('请先输入用户名。', 'error'); localField.focus(); return; }
  if (displayName.length > 64 || /[<>"'`\\/\u0000-\u001f\u007f]/.test(displayName)) { setFieldError(localField, localError, '用户名格式不符合要求。'); setStatus('用户名格式不符合要求。', 'error'); localField.focus(); return; }
  setBusy(true); setStatus('正在启动本地服务…'); try { await api.setupLocalProfile(displayName); } catch (error) { showError(error); }
});
document.getElementById('connection-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (isBusy || !validateUrl(fieldValue(customField), customField, customError, '请输入远程服务器地址。')) return;
  setBusy(true); setStatus('正在直接连接自定义服务器…'); try { await api.connectCustomRemote(fieldValue(customField)); } catch (error) { showError(error, customField, customError); }
});
document.getElementById('quit').addEventListener('click', () => { if (!isBusy) api.quit(); });

function describeStatus(status) {
  if (!status) return;
  if (status.error) return showError(new Error(status.error));
  if (settingsButton) settingsButton.hidden = status.mode === 'remote' || status.runtime !== 'desktop-local';
  // 首次启动必须先展示欢迎页；只有用户选择本地使用后才进入用户名步骤。
  if (status.needsLocalProfile && status.mode === 'connect' && currentStep === 'local') { setStatus('请输入用户名。'); return; }
  if (status.mode && status.mode !== 'connect') {
    const authLabel = status.auth ? (status.auth.required === false ? '免登录' : `登录：${(status.auth.methods || []).join('、') || '服务器'}`) : '';
    const metadata = [status.runtime, status.edition, authLabel].filter(Boolean).join(' · ');
    introEl.textContent = `当前连接：${status.mode === 'local' ? '本地' : '远程'}${metadata ? `（${metadata}）` : ''}`;
    renderStep('welcome', { focus: false }); setStatus(status.message || '连接已完成。', 'success');
  }
  if (status.message && status.mode === 'connect') setStatus(status.message);
  if (status.mode === 'redirecting') { setBusy(false); renderStep('remote', { focus: false }); setStatus('官方站已打开，请在浏览器中继续。', 'success'); }
}
api.onStatus(describeStatus);
api.getStatus().then(describeStatus).catch(showError);
