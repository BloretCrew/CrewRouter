'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { AppState } = require('./state');
const { registerIpc } = require('./ipc');
const { createMainWindow } = require('./window');
const { createOfficialLogin } = require('./official-login');
const { applyMenu } = require('./menu');
const { LocalServerManager } = require('../server-manager');
const { ConnectionManager } = require('../connection-manager');
const { ProfileStore, validateLocalDisplayName } = require('../profile-store');
const { validateRemoteUrl } = require('../url-policy');

const DEFAULT_DEMO_URL = 'https://crewrouter.bloret.net';
const LOCAL_TOKEN_HEADER = 'x-crewrouter-desktop-token';
const rendererEntry = path.join(__dirname, '..', 'renderer', 'index.html');
const preloadPath = path.join(__dirname, '..', 'preload.js');

function requestFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, { method: options.method || 'GET', headers: options.headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, headers: response.headers, json: async () => JSON.parse(body) }));
    });
    request.setTimeout(8000, () => request.destroy(new Error('连接超时')));
    request.once('error', reject);
    request.end(options.body || undefined);
  });
}

function pickLocal(status) {
  if (!status) return { ready: false, pid: null, port: null, baseUrl: null, logsDir: null, version: null };
  return { ready: Boolean(status.ready), pid: status.pid || null, port: status.port || null, baseUrl: status.baseUrl || null, logsDir: status.logsDir || null, version: status.version || null };
}

function resolveLanguage(settings, electron) {
  if (settings?.language === 'zh' || settings?.language === 'en') return settings.language;
  let locale = '';
  try { locale = String(electron?.app?.getLocale?.() || ''); } catch {}
  if (!locale) return 'zh';
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function createApp({ electron, env = process.env, fetchImpl = requestFetch, logger = console, userData: userDataOverride, isPackaged, localManagerFactory } = {}) {
  if (!electron) throw new Error('createApp 需要 electron 实例');
  const state = new AppState();
  const demoUrl = env.CREWROUTER_DEMO_URL || DEFAULT_DEMO_URL;
  const ctx = { electron, env, logger, state, rendererEntry, preloadPath, demoUrl, mainWindow: null, window: null, connection: null, local: null, officialLogin: null, quitting: false, userData: null };
  let actionSeq = 0;

  const userData = () => ctx.userData || (ctx.userData = userDataOverride || electron.app.getPath('userData'));
  const packaged = () => (typeof isPackaged === 'boolean' ? isPackaged : Boolean(electron.app.isPackaged));
  const createManager = (options) => (localManagerFactory ? localManagerFactory(options) : new LocalServerManager(options));

  // 推送给窗口的状态按当前页面裁剪：只有启动页和本地控制台能拿到完整快照，其余（包括切换过渡期的远程页面）只拿裁剪版。
  function audienceForWindow() {
    const url = ctx.window?.currentUrl() || '';
    if (!url || url.startsWith('file:')) return 'launcher';
    try { return new URL(url).origin === state.target && state.instance?.runtime === 'desktop-local' ? 'launcher' : 'remoteConsole'; } catch { return 'remoteConsole'; }
  }
  function sendStatus() { ctx.window?.send('desktop:status', state.snapshot(audienceForWindow())); }
  state.on('change', sendStatus);

  async function openSafeExternal(raw) {
    const result = await validateRemoteUrl(raw);
    if (!result.ok) throw new Error(result.error);
    return electron.shell.openExternal(result.url.toString());
  }

  // 统一的动作包装：忙碌保护、状态迁移、失败落到 error 状态并携带重试信息；被取消的动作静默结束。
  async function runAction(kind, retry, fn) {
    if (state.isBusy()) throw new Error('已有操作正在进行，请稍候。');
    const seq = ++actionSeq;
    const cancelled = () => seq !== actionSeq;
    state.begin(kind, retry ? { retry } : {});
    try {
      const result = await fn(cancelled);
      return cancelled() ? state.snapshot('launcher') : result;
    } catch (error) {
      if (cancelled()) return state.snapshot('launcher');
      if (error?.cancelled) { state.reset(); return state.snapshot('launcher'); }
      logger.error(`[desktop] ${kind} failed: ${error.message}`);
      // 页面加载失败时窗口会停在 Chromium 错误页，必须先回到启动页再展示错误。
      if (ctx.window && !(ctx.window.currentUrl() || '').startsWith('file:')) await ctx.window.loadLauncher().catch(() => {});
      state.fail(error.message, { kind, retry });
      throw error;
    }
  }

  async function connect(url, { local = false, name, id, displayName, localIdentityId, officialTarget = false, cancelled = () => false } = {}) {
    const total = local ? 4 : 2;
    state.step(local ? 4 : 1, total, local ? '正在读取本地服务信息' : '正在检查服务器');
    const profile = await ctx.connection.connect({ id, url, mode: local ? 'local' : 'remote', allowLocalhost: local, resolveDns: officialTarget ? false : undefined, name: name || (local ? '本地 CrewRouter' : new URL(url).hostname), displayName, localIdentityId });
    if (cancelled()) return state.snapshot('launcher');
    const target = new URL(profile.url).origin;
    const summary = { id: profile.id, name: profile.name, mode: profile.mode, lastConnectedAt: profile.lastConnectedAt };
    state.set({ target, instance: profile, profile: summary, progress: { step: total, total, label: '正在打开页面' } });
    try {
      await ctx.window.loadTarget(local ? `${target}/console` : target);
      if (local) await ctx.window.win.webContents.executeJavaScript(`(() => { document.getElementById('desktop-settings')?.remove(); const card = document.getElementById('desktopSettingsCard'); if (card) card.hidden = false; })()`, true);
    } catch (error) {
      state.set({ target: null });
      throw new Error(`页面加载失败：${error.message}`);
    }
    if (cancelled()) return state.snapshot('launcher');
    state.connected({ target, instance: profile, profile: summary });
    return state.snapshot('launcher');
  }

  function attachLocalToken(baseUrl, token) {
    const session = electron.session?.defaultSession;
    if (!session?.webRequest?.onBeforeSendHeaders || !baseUrl || !token) return;
    session.webRequest.onBeforeSendHeaders({ urls: [`${baseUrl}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [LOCAL_TOKEN_HEADER]: token } });
    });
  }

  function detachTarget() {
    const keepError = state.mode === 'error';
    state.set({ mode: keepError ? 'error' : 'idle', target: null, instance: null, profile: null, pending: null, progress: null, ...(keepError ? {} : { error: null }) });
  }

  function createLocalManager({ localIdentityId, displayName }) {
    const manager = createManager({
      mode: packaged() ? 'packaged' : 'development',
      resourceRoot: packaged() ? path.join(process.resourcesPath, 'server') : undefined,
      userData: userData(),
      runtime: 'desktop-local',
      edition: 'personal',
      auth: { required: false, methods: ['local'] },
      demo: false,
      localIdentityId,
      displayName,
      logger,
    });
    manager.on('progress', ({ step, total, label }) => { if (state.isBusy()) state.step(step, total, label); });
    manager.on('exit', ({ code, signal, wasReady, aborted, logPath }) => {
      if (ctx.local !== manager) return;
      state.set({ localServer: pickLocal(manager.getStatus()) });
      if (ctx.quitting || aborted || !wasReady) return;
      logger.error(`[desktop] local server exited unexpectedly (code ${code}, signal ${signal || 'none'})`);
      const retry = { action: 'local', payload: { displayName } };
      showLauncher().catch(() => {}).finally(() => {
        state.fail(`本地服务意外退出（code ${code ?? 'null'}${signal ? `, ${signal}` : ''}）。日志：${logPath || '未知'}`, { kind: 'local', retry });
      });
    });
    return manager;
  }

  async function startLocal({ displayName, profile: selected } = {}) {
    const store = ctx.connection.store;
    const active = store.getActive();
    const profile = selected?.mode === 'local' ? selected : (state.localProfile?.mode === 'local' ? state.localProfile : (active?.mode === 'local' ? active : null));
    let resolvedName = profile?.displayName || null;
    if (typeof displayName === 'string' && displayName.trim()) {
      const validated = validateLocalDisplayName(displayName);
      if (!validated.ok) throw new Error(validated.error);
      resolvedName = validated.value;
    }
    if (!resolvedName) throw new Error('首次本地使用需要先设置用户名。');
    const localIdentityId = profile?.localIdentityId || crypto.randomUUID();
    const retry = { action: 'local', payload: { displayName: resolvedName } };
    return runAction('local', retry, async (cancelled) => {
      const running = ctx.local;
      const reusable = Boolean(running?.getStatus().ready && running.options.displayName === resolvedName && running.options.localIdentityId === localIdentityId);
      if (!reusable) {
        if (running) { await running.stop().catch(() => {}); if (ctx.local === running) ctx.local = null; }
        const manager = createLocalManager({ localIdentityId, displayName: resolvedName });
        ctx.local = manager;
        try {
          await manager.start();
        } catch (error) {
          await manager.stop().catch(() => {});
          if (ctx.local === manager) ctx.local = null;
          state.set({ localServer: pickLocal(null) });
          throw error;
        }
        attachLocalToken(manager.getStatus().baseUrl, manager.localToken);
      }
      const status = ctx.local.getStatus();
      state.set({ localServer: pickLocal(status) });
      if (cancelled()) return state.snapshot('launcher');
      const result = await connect(status.baseUrl, { local: true, name: resolvedName, id: profile?.id || crypto.randomUUID(), displayName: resolvedName, localIdentityId, cancelled });
      state.set({ localProfile: store.getActive() });
      return result;
    });
  }

  async function connectCustom(rawUrl) {
    const target = await validateRemoteUrl(rawUrl);
    if (!target.ok) throw new Error(target.error);
    const url = target.url.toString();
    return runAction('custom', { action: 'custom', payload: { url } }, (cancelled) => connect(url, { name: target.url.hostname, cancelled }));
  }

  async function switchProfile(id) {
    const profile = ctx.connection.listProfiles().find((item) => item.id === id);
    if (!profile) throw new Error('profile 不存在');
    if (profile.mode === 'local') return startLocal({ profile });
    return runAction('profile', { action: 'profile', payload: { id } }, (cancelled) => connect(profile.url, { id: profile.id, name: profile.name, displayName: profile.displayName, localIdentityId: profile.localIdentityId, officialTarget: true, cancelled }));
  }

  async function openOfficialLogin() {
    if (state.isBusy()) throw new Error('已有操作正在进行，请稍候。');
    actionSeq += 1;
    try { return await ctx.officialLogin.start(); }
    catch (error) { state.fail(error.message, { kind: 'official-login', retry: { action: 'official-login' } }); throw error; }
  }

  // 官方站回调后的连接：不经过 runAction 的忙碌保护（此时状态已是 connecting），失败由 official-login 落到 error。
  async function officialConnect(url, options) {
    const seq = ++actionSeq;
    try {
      return await connect(url, { ...options, cancelled: () => seq !== actionSeq });
    } catch (error) {
      if (ctx.window && !(ctx.window.currentUrl() || '').startsWith('file:')) await ctx.window.loadLauncher().catch(() => {});
      throw error;
    }
  }

  async function reopenOfficialLogin() {
    if (!ctx.officialLogin?.isPending()) throw new Error('当前没有等待中的官方站登录');
    await ctx.officialLogin.reopen();
  }

  async function retry() {
    const retryInfo = state.error?.retry || state.pending?.retry;
    if (!retryInfo) throw new Error('没有可重试的操作');
    if (state.mode === 'error') state.reset();
    switch (retryInfo.action) {
      case 'local': return startLocal({ displayName: retryInfo.payload?.displayName });
      case 'custom': return connectCustom(retryInfo.payload?.url || '');
      case 'profile': return switchProfile(retryInfo.payload?.id || '');
      case 'official-login': return openOfficialLogin();
      default: throw new Error(`未知的重试动作：${retryInfo.action}`);
    }
  }

  async function cancelPending() {
    actionSeq += 1;
    if (ctx.officialLogin?.isPending()) ctx.officialLogin.cancel();
    if (state.mode === 'starting-local' && ctx.local && !ctx.local.getStatus().ready) {
      const manager = ctx.local;
      manager.abort();
      await manager.stop().catch(() => {});
      if (ctx.local === manager) ctx.local = null;
      state.set({ localServer: pickLocal(null) });
    }
    if (state.isBusy()) state.reset();
    return state.snapshot('launcher');
  }

  async function showLauncher() {
    if (ctx.officialLogin?.isPending()) ctx.officialLogin.cancel();
    detachTarget();
    await ctx.window?.loadLauncher();
    return state.snapshot('launcher');
  }

  async function stopLocal() {
    const manager = ctx.local;
    if (!manager) return;
    if (state.target && state.instance?.runtime === 'desktop-local') await showLauncher();
    await manager.stop();
    if (ctx.local === manager) ctx.local = null;
    state.set({ localServer: pickLocal(null) });
  }

  async function restartLocal() {
    const displayName = ctx.local?.options.displayName || state.localProfile?.displayName;
    await stopLocal();
    return startLocal({ displayName });
  }

  function deleteProfile(id) {
    if (state.target && state.profile?.id === id) throw new Error('不能删除当前连接的 profile');
    if (state.localProfile?.id === id && ctx.local?.getStatus().ready) throw new Error('本地服务运行中，不能删除本地 profile');
    ctx.connection.store.remove(id);
    if (state.localProfile?.id === id) state.set({ localProfile: null });
    if (state.profile?.id === id) state.set({ profile: null });
    return ctx.connection.listProfiles();
  }

  function applyPreferences(settings) {
    const theme = ['system', 'light', 'dark'].includes(settings?.theme) ? settings.theme : 'system';
    const language = resolveLanguage(settings, electron);
    if (electron.nativeTheme) electron.nativeTheme.themeSource = theme;
    state.set({ theme, language });
    applyMenu({ electron, language, isDev: !packaged(), actions: { showLauncher: () => showLauncher().catch((error) => logger.error(error.message)), openLogs: () => openLogs().catch((error) => logger.error(error.message)) } });
  }

  function saveSettings(settings) {
    const saved = ctx.connection.store.saveSettings(settings);
    applyPreferences(saved);
    return saved;
  }

  async function openLogs() {
    const dir = ctx.local?.getStatus().logsDir || path.join(userData(), 'logs');
    const result = await electron.shell.openPath(dir);
    if (result) throw new Error(result);
    return dir;
  }

  function diagnostics(audience = 'launcher') {
    const base = { app: 'CrewRouter Desktop', version: electron.app.getVersion(), platform: process.platform, arch: process.arch, mode: state.mode, target: state.target, runtime: state.instance?.runtime || null, edition: state.instance?.edition || null };
    if (audience === 'remoteConsole') return base;
    const local = ctx.local?.getStatus() || null;
    return { ...base, profileId: state.profile?.id || null, localServer: local ? { ready: local.ready, port: local.port, version: local.version, database: local.database } : null, electron: process.versions.electron || null, node: process.versions.node };
  }

  function onLoadFailed({ errorCode, errorDescription, url }) {
    // 连接过程中的失败由 connect() 处理；这里只处理已连接页面之后的加载失败（例如刷新时服务器不可达）。
    if (!state.target || state.isBusy()) return;
    let sameTarget = false;
    try { sameTarget = new URL(url).origin === state.target; } catch {}
    if (!sameTarget) return;
    const retry = state.profile ? { action: 'profile', payload: { id: state.profile.id } } : null;
    showLauncher().catch(() => {}).finally(() => state.fail(`页面加载失败（${errorCode}）：${errorDescription}`, { kind: 'connect', retry }));
  }

  function handleProtocol(raw) {
    let url;
    try { url = new URL(raw); } catch { return false; }
    if (url.protocol !== 'crewrouter:' || url.hostname !== 'connect') return false;
    const serverUrl = url.searchParams.get('serverUrl') || url.searchParams.get('url') || '';
    // 深链只预填地址，由用户在启动页确认后才连接。
    state.set({ prefill: serverUrl ? { serverUrl } : null });
    showLauncher().catch((error) => logger.error(error.message));
    return true;
  }

  async function createWindow() {
    ctx.window = createMainWindow({ electron, state, rendererEntry, preloadPath, env, logger, onLoadFailed, openSafeExternal });
    ctx.mainWindow = ctx.window.win;
    ctx.mainWindow.on('closed', () => { ctx.mainWindow = null; ctx.window = null; });
    await ctx.window.loadLauncher();
  }

  async function autoConnect() {
    const activeProfile = ctx.connection.activeProfile();
    if (!activeProfile || !ctx.connection.store.getSettings().autoConnect) return;
    try {
      if (activeProfile.mode === 'local' && activeProfile.displayName) await startLocal({ displayName: activeProfile.displayName, profile: activeProfile });
      else if (activeProfile.mode === 'remote') await switchProfile(activeProfile.id);
    } catch (error) { logger.warn(`[desktop] auto connect failed: ${error.message}`); }
  }

  async function init() {
    delete process.env.CREWROUTER_SERVER_ROOT;
    delete process.env.CREWROUTER_PACKAGED_SERVER_ROOT;
    ctx.connection = new ConnectionManager({ store: new ProfileStore(path.join(userData(), 'profiles.json')), fetchImpl });
    ctx.officialLogin = createOfficialLogin({ electron, demoUrl, fetchImpl, state, connect: officialConnect, validateRemoteUrl, logger });
    applyPreferences(ctx.connection.store.getSettings());
    const activeProfile = ctx.connection.activeProfile();
    if (activeProfile?.mode === 'local' && activeProfile.displayName) state.set({ localProfile: activeProfile });
    registerIpc({ ipcMain: electron.ipcMain, ctx, actions: { showLauncher, startLocal, connectCustom, openOfficialLogin, reopenOfficialLogin, cancelPending, retry, openSafeExternal, switchProfile, deleteProfile, saveSettings, restartLocal, stopLocal, openLogs, diagnostics } });
    try { electron.app.setAsDefaultProtocolClient?.('crewrouter'); } catch (error) { logger.warn(`[desktop] protocol registration failed: ${error.message}`); }
    await createWindow();
    await autoConnect();
    const protocolArg = (process.argv || []).find((value) => value.startsWith('crewrouter://'));
    if (protocolArg) handleProtocol(protocolArg);
  }

  function bootstrap() {
    const { app } = electron;
    if (!app.requestSingleInstanceLock()) { app.quit(); return false; }
    app.on('second-instance', (_event, argv) => {
      ctx.window?.focus();
      const protocolArg = (argv || []).find((arg) => arg.startsWith('crewrouter://'));
      if (protocolArg) handleProtocol(protocolArg);
    });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
    app.on('activate', () => { if (!ctx.mainWindow) { detachTarget(); createWindow().catch((error) => logger.error(error.message)); } });
    app.on('before-quit', (event) => {
      if (ctx.quitting) return;
      ctx.quitting = true;
      if (ctx.officialLogin?.isPending()) ctx.officialLogin.cancel();
      const manager = ctx.local;
      if (!manager) return;
      event.preventDefault();
      manager.stop().catch((error) => logger.error(`[desktop] stop local failed: ${error.message}`)).finally(() => app.quit());
    });
    app.whenReady().then(init).catch((error) => { logger.error(`[desktop] bootstrap failed: ${error.stack || error.message}`); app.exit(1); });
    return true;
  }

  return { bootstrap, init, state, ctx, actions: { connect, startLocal, connectCustom, switchProfile, openOfficialLogin, reopenOfficialLogin, retry, cancelPending, showLauncher, stopLocal, restartLocal, deleteProfile, saveSettings, openLogs, diagnostics, openSafeExternal, handleProtocol, onLoadFailed } };
}

module.exports = { createApp, requestFetch, DEFAULT_DEMO_URL, LOCAL_TOKEN_HEADER, rendererEntry, preloadPath };
