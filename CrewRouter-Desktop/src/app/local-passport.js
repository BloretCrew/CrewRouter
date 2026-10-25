'use strict';

const DEFAULT_PASSPORT_ORIGIN = 'https://passport.bloret.net';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PROVIDER_ORIGINS = new Set(['https://github.com', 'https://open.feishu.cn', 'https://passport.feishu.cn']);

function passportOrigin(raw = DEFAULT_PASSPORT_ORIGIN) {
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('PassPort origin 配置无效');
  }
  return url.origin;
}

function thirdPartyAuthorization(url) {
  return url.protocol === 'https:' && !url.username && !url.password && PROVIDER_ORIGINS.has(url.origin);
}

function createLocalPassport({ electron, getTarget, getWindow, fetchImpl, getToken = () => null, logger = console, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let current = null;
  const sessionHeaders = () => getToken() ? { 'x-crewrouter-desktop-token': getToken() } : {};

  let cleanup = Promise.resolve();
  let cleanupError = null;
  let cleanupFlow = null;
  let cleanupRunning = false;

  function alert(message, target) {
    if (getTarget() !== target) return;
    const main = getWindow();
    try { if (new URL(main?.currentUrl()).origin !== target) return; } catch { return; }
    main.win.webContents.executeJavaScript(`(() => { const el = document.getElementById('errorMessage'); if (el) { el.textContent = ${JSON.stringify(message)}; el.hidden = !el.textContent; el.classList.toggle('show', Boolean(el.textContent)); } })()`).catch(() => {});
  }

  function close(flow) {
    if (current === flow) current = null;
    clearTimeout(flow.timer);
    if (flow.win && !flow.win.isDestroyed()) flow.win.destroy();
  }

  function cancel(message = '') {
    const active = current;
    if (active) {
      active.cancelMessage = message || '已取消登录，可重新登录。';
      active.cancelToken = getToken();
      cleanupFlow = active;
      close(active);
      alert(message || '正在取消登录…', active.target);
    }
    if (!cleanupFlow || cleanupRunning) return cleanup;
    const flow = cleanupFlow;
    cleanupRunning = true;
    cleanup = cleanup.then(async () => {
      try {
        const headers = flow.cancelToken ? { 'x-crewrouter-desktop-token': flow.cancelToken } : {};
        const response = await electron.session.defaultSession.fetch(`${flow.target}/auth/passport/cancel`, { credentials: 'include', redirect: 'error', headers });
        if (!response.ok) throw new Error(`取消授权返回 HTTP ${response.status}`);
        cleanupError = null;
        cleanupFlow = null;
        alert(flow.cancelMessage, flow.target);
      } catch (error) {
        cleanupError = error;
        alert(`取消授权失败，请重试：${error.message}`, flow.target);
      } finally {
        cleanupRunning = false;
      }
    });
    return cleanup;
  }

  async function start(entry) {
    if (current) { current.win?.focus(); return; }
    const target = getTarget();
    if (!target) return;
    await (cleanupFlow ? cancel() : cleanup);
    if (getTarget() !== target) return;
    if (cleanupError) { alert(`授权清理尚未完成：${cleanupError.message}`, target); return; }
    if (current) { current.win?.focus(); return; }
    alert('', target);
    const flow = { target, win: null, timer: null, callbackSeen: false };
    current = flow;
    flow.timer = setTimeout(() => cancel('登录等待超时，请重新登录。'), timeoutMs);
    flow.timer.unref?.();
    try {
      const response = await fetchImpl(new URL('/auth/status', target));
      if (!response.ok) throw new Error(`认证状态返回 HTTP ${response.status}`);
      const status = await response.json();
      if (status.passportConfigured === false) throw new Error('本地 PassPort 登录尚未配置，请按 Desktop 部署说明配置应用后重启');
      const origin = passportOrigin(status.passportOrigin ?? DEFAULT_PASSPORT_ORIGIN);
      if (current !== flow || getTarget() !== target) return;
      const win = new electron.BrowserWindow({
        width: 600, height: 760, show: false, autoHideMenuBar: true,
        parent: getWindow()?.win, title: 'Bloret PassPort 登录',
        webPreferences: { session: electron.session.defaultSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
      });
      flow.win = win;
      const contents = win.webContents;
      const allowed = (raw) => {
        try {
          const url = new URL(raw);
          if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return false;
          if (url.origin === origin || thirdPartyAuthorization(url)) return true;
          if (url.origin !== target) return false;
          if (url.pathname === '/auth/passport/callback') { flow.callbackSeen = true; return true; }
          return flow.callbackSeen && url.pathname === '/console' && !url.search && !url.hash;
        } catch { return false; }
      };
      const guard = (event, url, _inPlace, isMainFrame = true) => {
        if (!isMainFrame || current !== flow || getTarget() !== target || !allowed(url)) event.preventDefault();
      };
      contents.on('will-navigate', guard);
      contents.on('will-redirect', guard);
      contents.on('render-process-gone', () => { if (current === flow) cancel('授权页面已退出，请重试。'); });
      contents.on('will-attach-webview', (event) => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('did-navigate', async (_event, raw, responseCode) => {
        if (current !== flow || getTarget() !== target) return;
        const url = new URL(raw);
        if (responseCode >= 400 || (url.origin === target && url.pathname === '/')) { cancel('授权失败，请重新登录。'); return; }
        if (!flow.callbackSeen || url.origin !== target || url.pathname !== '/console' || url.search || url.hash || flow.verifying) return;
        flow.verifying = true;
        try {
          const response = await electron.session.defaultSession.fetch(`${target}/auth/me`, { credentials: 'include', redirect: 'error', headers: sessionHeaders() });
          const user = response.ok ? await response.json() : null;
          if (!response.ok || !user?.id) throw new Error('登录会话无效');
          if (current !== flow || getTarget() !== target) return;
          const main = getWindow();
          close(flow);
          await main?.loadTarget(`${target}/console`);
          main?.focus();
        } catch (error) {
          if (current === flow) cancel(`授权失败：${error.message}`);
          else alert(`打开控制台失败：${error.message}`, target);
        }
      });
      contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3 && current === flow) { logger.warn(`[local-passport] ${description}`); cancel('授权页面网络错误，请重试。'); }
      });
      win.on('closed', () => { if (current === flow) cancel(); });
      win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
      // loadURL 不触发 will-navigate；入口仅由主进程加载一次。
      await win.loadURL(entry);
    } catch (error) {
      if (current === flow) { cancel(`授权失败：${error.message}`); logger.warn(`[local-passport] ${error.message}`); }
    }
  }

  function intercept(raw, { redirect = false, source = '' } = {}) {
    const target = getTarget();
    if (!target) return false;
    let url;
    try { url = new URL(raw); } catch { return false; }
    if (url.origin === target && url.pathname === '/auth/passport') {
      if (url.username || url.password) return true;
      start(url.toString());
      return true;
    }
    // 兜底捕获程序导航入口后的 HTTP 重定向，不将 Cookie 带到系统浏览器。
    if (redirect && url.origin !== target && (() => {
      try { const entry = new URL(source || getWindow()?.currentUrl()); return entry.origin === target && entry.pathname === '/auth/passport'; } catch { return false; }
    })()) {
      start(`${target}/auth/passport`);
      getWindow()?.loadTarget(`${target}/`).catch((error) => logger.warn(`[local-passport] ${error.message}`));
      return true;
    }
    return false;
  }

  return { intercept, cancel, isPending: () => Boolean(current), isTrustedContents: (id) => Number.isInteger(id) && Boolean(current?.win && !current.win.isDestroyed() && current.win.webContents.id === id) };
}

module.exports = { createLocalPassport, passportOrigin, thirdPartyAuthorization, DEFAULT_PASSPORT_ORIGIN };
