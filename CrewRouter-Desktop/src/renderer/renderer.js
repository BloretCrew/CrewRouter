'use strict';

const api = window.crewrouterDesktop;
const settingsButton = document.getElementById('settings');
settingsButton?.addEventListener('click', () => api.openSettings());
const runtimeError = document.getElementById('runtime-error');
const statusEl = document.getElementById('status');
const feedbackEl = document.querySelector('.blora-feedback');
function showRuntimeError(message) {
  if (runtimeError) runtimeError.textContent = message;
  if (statusEl) statusEl.textContent = message;
  if (feedbackEl) feedbackEl.dataset.state = 'error';
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
  settings: [['path', { d: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z' }], ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.4 1.4-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L9 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H7v-2h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L8.4 9 9.8 7.6l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h2v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 9l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v2H21a1.7 1.7 0 0 0-1.6 1Z' }]],
};
function createBloraIcon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size)); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true'); svg.dataset.bloraIcon = name;
  (iconPaths[name] || []).forEach(([tag, attrs]) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value)); svg.appendChild(node); });
  return svg;
}
function mountIcons() {
  document.querySelectorAll('[data-icon]').forEach((host) => {
    const name = host.dataset.icon;
    if (host.querySelector('svg') || !iconPaths[name]) return;
    host.appendChild(createBloraIcon(name, host.classList.contains('mode-option__icon') ? 20 : 16));
  });
}
mountIcons();
const formEl = document.getElementById('connection-form');
const introEl = document.getElementById('intro');
const urlEl = document.getElementById('remote-url');
const urlErrorEl = document.getElementById('url-error');
const localButton = document.getElementById('local');
const localProfileStep = document.getElementById('local-profile-step');
const localProfileForm = document.getElementById('local-profile-form');
const localUsername = document.getElementById('local-username');
const localUsernameError = document.getElementById('local-username-error');
const localContinue = document.getElementById('local-continue');
const remoteChoice = document.getElementById('remote-choice');
const remoteChoiceStep = document.getElementById('remote-choice-step');
const officialRemote = document.getElementById('official-remote');
const officialRemoteStep = document.getElementById('official-remote-step');
const officialRemoteForm = document.getElementById('official-remote-form');
const officialRemoteUrl = document.getElementById('official-remote-url');
const officialUrlError = document.getElementById('official-url-error');
const officialBack = document.getElementById('official-back');
const customRemote = document.getElementById('custom-remote');
const remoteStep = document.getElementById('remote-step');
const modeStep = document.getElementById('mode-step');
const choiceBackButton = document.getElementById('choice-back');
const backButton = document.getElementById('back');
const remoteButton = document.getElementById('remote');
const quitButton = document.getElementById('quit');
let isBusy = false;
function setStatus(message, state = 'idle') { statusEl.textContent = message; feedbackEl.dataset.state = state; }
function busy(value) {
  isBusy = value;
  [localButton, localContinue, remoteChoice, officialRemote, officialBack, customRemote, choiceBackButton, backButton, remoteButton, quitButton].forEach((button) => { if (button) button.disabled = value; });
  [localButton, localContinue, remoteChoice, officialRemote, customRemote, remoteButton].forEach((button) => { if (button) button.setAttribute('aria-busy', String(value)); });
}
function setUrlError(message = '') { urlErrorEl.textContent = message; urlEl.setAttribute('aria-invalid', message ? 'true' : 'false'); }
function showError(error) { busy(false); setStatus(error?.message || '连接失败，请检查地址后重试。', 'error'); }
function showLocalProfileStep() { modeStep.hidden = true; remoteChoiceStep.hidden = true; remoteStep.hidden = true; localProfileStep.hidden = false; setStatus('请输入用户名'); localUsername.focus(); }
function showRemoteChoiceStep() { modeStep.hidden = true; localProfileStep.hidden = true; remoteStep.hidden = true; officialRemoteStep.hidden = true; remoteChoiceStep.hidden = false; setStatus('请选择远程连接方式'); officialRemote.focus(); }
function showOfficialRemoteStep() { modeStep.hidden = true; localProfileStep.hidden = true; remoteChoiceStep.hidden = true; remoteStep.hidden = true; officialRemoteStep.hidden = false; setStatus('请输入目标服务器'); officialRemoteUrl.focus(); }
function showRemoteStep() { modeStep.hidden = true; remoteChoiceStep.hidden = true; officialRemoteStep.hidden = true; remoteStep.hidden = false; setStatus('请输入服务器地址'); urlEl.focus(); }
function showModeStep() { remoteStep.hidden = true; remoteChoiceStep.hidden = true; officialRemoteStep.hidden = true; localProfileStep.hidden = true; modeStep.hidden = false; setUrlError(); setStatus('请选择一个连接方式'); remoteChoice.focus(); }
function describeStatus(status) {
  if (!status) return;
  if (status.error) return showError(new Error(status.error));
  if (status.needsLocalProfile && status.mode === 'connect') return showLocalProfileStep();
  if (settingsButton) settingsButton.hidden = status.mode === 'remote' || status.runtime !== 'desktop-local';
  if (status.mode && status.mode !== 'connect') {
    const authLabel = status.auth ? (status.auth.required === false ? '免登录' : `登录：${(status.auth.methods || []).join('、') || '服务器'}`) : '';
    const metadata = [status.runtime, status.edition, authLabel].filter(Boolean).join(' · ');
    introEl.textContent = `当前连接：${status.mode === 'local' ? '本地' : '远程'}${metadata ? `（${metadata}）` : ''}`;
  }
  if (status.message) setStatus(status.message, status.mode && status.mode !== 'connect' ? 'success' : 'idle');
}
localButton.addEventListener('click', () => { if (!isBusy) showLocalProfileStep(); });
localProfileForm.addEventListener('submit', async (event) => {
  event.preventDefault(); if (isBusy) return;
  localUsernameError.textContent = ''; localUsername.setAttribute('aria-invalid', 'false');
  const displayName = localUsername.value.trim();
  if (!displayName) { localUsernameError.textContent = '用户名不能为空。'; localUsername.setAttribute('aria-invalid', 'true'); setStatus('请先输入用户名。', 'error'); localUsername.focus(); return; }
  if (displayName.length > 64) { localUsernameError.textContent = '用户名不能超过 64 个字符。'; localUsername.setAttribute('aria-invalid', 'true'); setStatus('用户名长度不符合要求。', 'error'); localUsername.focus(); return; }
  if (/[<>"'`\\/\u0000-\u001f\u007f]/.test(displayName)) { localUsernameError.textContent = '用户名包含不安全字符，请使用普通文字、数字或短横线。'; localUsername.setAttribute('aria-invalid', 'true'); setStatus('用户名格式不符合要求。', 'error'); localUsername.focus(); return; }
  busy(true); setStatus('正在启动本地服务…'); try { await api.setupLocalProfile(displayName); } catch (error) { showError(error); }
});
remoteChoice.addEventListener('click', () => { if (!isBusy) showRemoteChoiceStep(); });
officialRemote.addEventListener('click', () => { if (!isBusy) showOfficialRemoteStep(); });
officialBack.addEventListener('click', () => { if (!isBusy) showRemoteChoiceStep(); });
officialRemoteForm.addEventListener('submit', async (event) => {
  event.preventDefault(); if (isBusy) return;
  officialUrlError.textContent = '';
  const url = officialRemoteUrl.value.trim();
  if (!url) { officialUrlError.textContent = '请输入目标服务器地址。'; setStatus('需要目标服务器地址才能继续。', 'error'); officialRemoteUrl.focus(); return; }
  let parsed; try { parsed = new URL(url); } catch { officialUrlError.textContent = '请输入有效的 URL。'; setStatus('地址格式不正确。', 'error'); officialRemoteUrl.focus(); return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) { officialUrlError.textContent = '仅支持 http:// 或 https:// 地址。'; setStatus('地址格式不正确。', 'error'); officialRemoteUrl.focus(); return; }
  busy(true); setStatus('正在验证目标并打开官方 Demo…'); try { await api.connectRemote(url); } catch (error) { showError(error); }
});
customRemote.addEventListener('click', () => { if (!isBusy) showRemoteStep(); });
choiceBackButton.addEventListener('click', () => { if (!isBusy) showModeStep(); });
backButton.addEventListener('click', () => { if (!isBusy) showRemoteChoiceStep(); });
formEl.addEventListener('submit', async (event) => {
  event.preventDefault(); if (isBusy) return;
  const url = urlEl.value.trim(); setUrlError();
  if (!url) { setUrlError('请输入远程服务器地址。'); setStatus('需要服务器地址才能连接。', 'error'); urlEl.focus(); return; }
  let parsed; try { parsed = new URL(url); } catch { setUrlError('请输入有效的 URL。'); setStatus('地址格式不正确。', 'error'); urlEl.focus(); return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) { setUrlError('仅支持 http:// 或 https:// 地址。'); setStatus('地址格式不正确。', 'error'); urlEl.focus(); return; }
  busy(true); setStatus('正在直接连接自定义服务器…'); try { await api.connectCustomRemote(url); } catch (error) { showError(error); }
});
quitButton.addEventListener('click', () => { if (!isBusy) api.quit(); });
api.onStatus(describeStatus); api.getStatus().then(describeStatus).catch(showError);
