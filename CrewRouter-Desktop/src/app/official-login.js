'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const CLIENT_ID = 'crewrouter-desktop';
const SCOPE = 'events:report';
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${body}</p>`;

function parseSetCookie(headers) {
  const raw = Array.isArray(headers?.['set-cookie']) ? headers['set-cookie'][0] : headers?.['set-cookie'];
  if (!raw) throw new Error('Web Session 交换未返回登录 Cookie');
  const pair = String(raw).split(';', 1)[0];
  const separator = pair.indexOf('=');
  if (separator <= 0) throw new Error('Web Session 返回的 Cookie 格式无效');
  return { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() };
}

// 官方站登录：Desktop 打开官方站选择实例 → 目标实例 OAuth（PKCE）→ 回环回调 → 交换 Web Session → 进入 ConnectionManager。
function createOfficialLogin({ electron, demoUrl, fetchImpl, state, connect, validateRemoteUrl, ttlMs = DEFAULT_TTL_MS, logger = console }) {
  let current = null;

  function closeCurrent() {
    if (!current) return;
    clearTimeout(current.timer);
    try { current.server.close(); } catch {}
    current = null;
  }

  async function finish({ routerUrl, code, verifier }) {
    const target = await validateRemoteUrl(routerUrl, { resolveDns: false });
    if (!target.ok) throw new Error(target.error);
    state.step(1, 3, '正在交换登录会话');
    const exchange = await fetchImpl(new URL('/oauth/desktop-session', target.url), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, code_verifier: verifier }).toString(),
    });
    if (!exchange.ok) throw new Error(`Web Session 交换失败（HTTP ${exchange.status}）`);
    const cookie = parseSetCookie(exchange.headers);
    const cookieUrl = `${target.url.origin}/`;
    const cookieStore = electron.session.defaultSession.cookies;
    await cookieStore.remove(cookieUrl, cookie.name).catch(() => {});
    await cookieStore.set({ url: cookieUrl, name: cookie.name, value: cookie.value, path: '/', httpOnly: true, secure: target.url.protocol === 'https:', sameSite: 'lax' });
    const installed = await cookieStore.get({ url: cookieUrl, name: cookie.name });
    if (!installed.length || installed[0].value !== cookie.value) throw new Error('Web Session Cookie 写入失败');
    state.step(2, 3, '正在打开目标 CrewRouter');
    return connect(target.url.toString(), { officialTarget: true, name: target.url.hostname });
  }

  function handleRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/callback') { response.writeHead(404); response.end(); return; }
    let payload = null;
    try { payload = JSON.parse(Buffer.from(url.searchParams.get('state') || '', 'base64url').toString('utf8')); } catch {}
    const code = url.searchParams.get('code') || '';
    const valid = Boolean(current) && payload?.nonce === current.nonce && Boolean(code) && typeof payload?.router_url === 'string';
    if (!valid) {
      // 无效回调不终止流程，避免本机其他进程通过伪造回调打断登录。
      logger.warn('[official-login] rejected callback with invalid state');
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE('CrewRouter Desktop', '登录回调无效，请关闭此页面并在 Desktop 中重试。'));
      return;
    }
    const { verifier } = current;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE('CrewRouter Desktop', '登录已完成，请回到 CrewRouter Desktop。'));
    closeCurrent();
    state.set({ mode: 'connecting', pending: { kind: 'official-login', startedAt: Date.now(), retry: { action: 'official-login' } }, progress: { step: 1, total: 3, label: '已收到授权，正在建立登录会话' } });
    finish({ routerUrl: payload.router_url, code, verifier }).catch((error) => {
      logger.error(`[official-login] ${error.message}`);
      state.fail(`官方站登录后打开目标失败：${error.message}`, { kind: 'official-login', retry: { action: 'official-login' } });
    });
  }

  async function start() {
    const demo = await validateRemoteUrl(demoUrl, { resolveDns: false });
    if (!demo.ok) throw new Error(`官方站地址无效：${demo.error}`);
    closeCurrent();
    const nonce = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const server = http.createServer(handleRequest);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const loginUrl = new URL('/store', demo.url.origin);
    loginUrl.searchParams.set('helper_login', '1');
    loginUrl.searchParams.set('state', nonce);
    loginUrl.searchParams.set('redirect_uri', redirectUri);
    loginUrl.searchParams.set('client_id', CLIENT_ID);
    loginUrl.searchParams.set('scope', SCOPE);
    loginUrl.searchParams.set('code_challenge', challenge);
    loginUrl.searchParams.set('code_challenge_method', 'S256');
    const expiresAt = Date.now() + ttlMs;
    current = { server, nonce, verifier, loginUrl: loginUrl.toString(), expiresAt, timer: null };
    current.timer = setTimeout(() => {
      closeCurrent();
      state.fail('官方站登录等待超时，请重新发起。', { kind: 'official-login', retry: { action: 'official-login' } });
    }, ttlMs);
    current.timer.unref?.();
    state.begin('official-login', { site: demo.url.origin, loginUrl: loginUrl.toString(), expiresAt, retry: { action: 'official-login' } });
    await electron.shell.openExternal(loginUrl.toString());
    return state.snapshot('launcher');
  }

  async function reopen() {
    if (!current) throw new Error('当前没有等待中的官方站登录');
    await electron.shell.openExternal(current.loginUrl);
  }

  function cancel() {
    const pending = Boolean(current);
    closeCurrent();
    if (pending && state.mode === 'awaiting-official-login') state.reset();
    return pending;
  }

  return { start, cancel, reopen, isPending: () => Boolean(current), callbackPort: () => current?.server.address()?.port || null };
}

module.exports = { createOfficialLogin, parseSetCookie, CLIENT_ID };
