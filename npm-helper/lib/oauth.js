'use strict';

/**
 * OAuth PKCE 登录、access token 临期自动刷新与统一凭证解析。
 *
 * 刷新必须持独占锁串行执行：服务端把旧 refresh_token 的第二次使用按重放处理
 * 并吊销整条授权链，多 hook 并发无锁刷新会互踩导致全员掉线。Python 版用
 * fcntl.flock，Node 零依赖改为「wx 独占创建 + 自旋重试」，最多等 5s。
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { CONFIG_PATH, TOKEN_LOCK_PATH, loadCfg, saveCfg, effectiveUrl } = require('./config');
const { postForm } = require('./http');

const OAUTH_CLIENT_ID = 'crewrouter-helper';
const OAUTH_SCOPE = 'events:report';
const REFRESH_AHEAD_SEC = 60; // 过期前 60s 触发自动刷新
const LOCK_WAIT_MS = 5000;    // wx 锁自旋等待上限
const LOCK_STALE_MS = 15000;  // 残留锁超过该时长视为持有者已崩溃

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 无 Atomics 时自旋兜底 */ }
  }
}

function acquireTokenLock(timeoutMs = LOCK_WAIT_MS) {
  fs.mkdirSync(path.dirname(TOKEN_LOCK_PATH), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(TOKEN_LOCK_PATH, 'wx'); // O_EXCL 语义：只可能有一个创建者
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } catch (_) {}
      return fd;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(TOKEN_LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(TOKEN_LOCK_PATH); // 清理崩溃残留后立即重试
          continue;
        }
      } catch (_) { /* 锁恰好被释放，直接重试 */ }
      if (Date.now() >= deadline) return null;
      sleepSync(50);
    }
  }
}

function releaseTokenLock(fd) {
  if (fd == null) return;
  try { fs.closeSync(fd); } catch (_) {}
  try { fs.unlinkSync(TOKEN_LOCK_PATH); } catch (_) {}
}

/** PKCE S256：verifier 仅存内存，challenge 进授权链接 */
function makePkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function tokenRequest(baseUrl, form) {
  if (!baseUrl) return null;
  try {
    const res = await postForm(baseUrl + '/oauth/token', form);
    return res.status >= 200 && res.status < 300 ? JSON.parse(res.body) : null;
  } catch (_) {
    return null; // 与 Python 版一致：token 往返失败静默返回 None
  }
}

async function refreshAccess(url, refreshToken, clientId) {
  const out = await tokenRequest(url, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (!out || !out.access_token || !out.refresh_token) return null;
  return {
    access_token: String(out.access_token),
    refresh_token: String(out.refresh_token),
    expires_at: Date.now() / 1000 + (Number(out.expires_in) || 86400),
  };
}

async function oauthAccessToken(cfg) {
  const exp = Number(cfg.expires_at) || 0;
  if (cfg.access_token && exp > Date.now() / 1000 + REFRESH_AHEAD_SEC) {
    return String(cfg.access_token);
  }
  if (!cfg.refresh_token) return null;

  const url = effectiveUrl(cfg);
  const clientId = String(cfg.client_id || OAUTH_CLIENT_ID);
  const fd = acquireTokenLock(); // 拿不到锁最多等 5s，随后无锁尽力而为
  try {
    // 拿到锁后重读配置：可能已被其他并发进程刷新过
    const fresh = loadCfg() || {};
    const freshExp = Number(fresh.expires_at) || 0;
    if (
      fresh.access_token &&
      freshExp > Date.now() / 1000 + REFRESH_AHEAD_SEC &&
      fresh.refresh_token
    ) {
      return String(fresh.access_token);
    }
    const pair = await refreshAccess(url, String(fresh.refresh_token || cfg.refresh_token), clientId);
    if (!pair) return null;
    const merged = { ...cfg, ...pair };
    if (!merged.client_id) merged.client_id = clientId;
    try { saveCfg(merged); } catch (_) {}
    return pair.access_token;
  } finally {
    releaseTokenLock(fd);
  }
}

/**
 * 上报链路的统一凭证入口，优先级与 Python 版一致：
 * OAuth access 未过期直用 → 临期加锁刷新 → 无 OAuth 字段回落静态 key。
 * 返回 { url, token } 或 null。
 */
async function getCredential() {
  const cfg = loadCfg();
  if (!cfg) return null;
  const url = effectiveUrl(cfg);
  let token = null;
  if (cfg.refresh_token) token = await oauthAccessToken(cfg);
  if (!token) {
    const key = process.env.CREWROUTER_KEY != null ? process.env.CREWROUTER_KEY : cfg.key;
    if (key) token = String(key);
  }
  if (!url || !token) return null;
  return { url, token };
}

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
        stdio: 'ignore',
        detached: true,
      }).unref();
    }
  } catch (_) { /* 打不开就靠用户手动复制链接 */ }
}

/** 浏览器 PKCE 授权：本机随机端口收回调 → 换 token → 写配置（chmod 600）。返回退出码。 */
async function runLogin({ url }) {
  const { verifier, challenge } = makePkce();
  const state = crypto.randomBytes(16).toString('base64url');
  if (!url) return runStoreLogin({ verifier, challenge, state });
  return runDirectLogin({ base: String(url).replace(/\/+$/, ''), verifier, challenge, state });
}

async function runStoreLogin({ verifier, challenge, state }) {
  const server = await createCallbackServer();
  const storeUrl = 'https://crewrouter.bloret.net/store?' + new URLSearchParams({
    helper_login: '1', client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE,
    redirect_uri: server.redirectUri, state, code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  console.log('[crewrouter-helper] 未指定 --url，正在打开官方商店选择要登录的 CrewRouter...');
  printBrowserUrl(storeUrl);
  const callback = await waitForCallback(server);
  if (!callback) return 1;
  let selected;
  try { selected = JSON.parse(Buffer.from(callback.state, 'base64url').toString('utf8')); } catch (_) {}
  if (callback.error || !callback.code || !selected || selected.nonce !== state) {
    console.error(`[crewrouter-helper] 授权被拒绝或回调校验失败：${callback.error || 'state 无效'}`);
    return 1;
  }
  const base = String(selected.router_url || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    console.error('[crewrouter-helper] 商店未返回有效的 CrewRouter 地址');
    return 1;
  }
  return exchangeAuthorizationCode(base, callback, verifier, server.redirectUri);
}

async function runDirectLogin({ base, verifier, challenge, state }) {
  if (!base) {
    console.error('[crewrouter-helper] 需要 --url 或环境变量 CREWROUTER_URL，例如：crewrouter-helper login --url http://127.0.0.1:20003');
    return 1;
  }
  const server = await createCallbackServer();
  const authUrl = base + '/oauth/authorize?' + new URLSearchParams({
    client_id: OAUTH_CLIENT_ID, response_type: 'code', scope: OAUTH_SCOPE,
    redirect_uri: server.redirectUri, state, code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  console.log(`[crewrouter-helper] 正在打开浏览器进行授权（本机回调端口 ${server.port}）...`);
  printBrowserUrl(authUrl);
  const callback = await waitForCallback(server);
  if (!callback) return 1;
  if (callback.error || !callback.code) {
    console.error(`[crewrouter-helper] 授权被拒绝或失败：${callback.error || '缺少 code'}`);
    return 1;
  }
  if (callback.state !== state) {
    console.error('[crewrouter-helper] state 校验失败，放弃换取 token');
    return 1;
  }
  return exchangeAuthorizationCode(base, callback, verifier, server.redirectUri);
}

function printBrowserUrl(url) {
  if (process.env.CREWROUTER_NO_BROWSER === '1' || process.env.CR_REPORT_NO_BROWSER === '1') console.log(url);
  else { openBrowser(url); console.log(`[crewrouter-helper] 若浏览器未自动打开，请手动访问：\n${url}`); }
}

function createCallbackServer() {
  return new Promise((resolve, reject) => {
    let callback = null;
    let settled = false;
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || requestUrl.pathname !== '/callback') {
        res.writeHead(404); return res.end('Not found');
      }
      if (settled) { res.writeHead(410); return res.end('Callback already handled'); }
      callback = {
        code: requestUrl.searchParams.get('code') || '',
        state: requestUrl.searchParams.get('state') || '',
        error: requestUrl.searchParams.get('error') || '',
      };
      const body = Buffer.from(`<meta charset="utf-8"><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:80vh;">${callback.code ? '登录成功，请回到终端。' : '授权失败，请回终端重试。'}</body>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
      res.end(body);
      settled = true;
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, redirectUri: `http://127.0.0.1:${port}/callback`, callback: () => callback, close: () => server.close() });
    });
  });
}

async function waitForCallback(server) {
  const deadline = Date.now() + 300000;
  while (!server.callback() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  server.close();
  if (!server.callback()) { console.error('[crewrouter-helper] 等待授权超时（5 分钟）'); return null; }
  return server.callback();
}

async function exchangeAuthorizationCode(base, callback, verifier, redirectUri) {
  const out = await tokenRequest(base, {
    grant_type: 'authorization_code', code: callback.code, client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri, code_verifier: verifier,
  });
  if (!out || !out.access_token || !out.refresh_token) {
    console.error('[crewrouter-helper] 授权码换取 token 失败'); return 1;
  }
  saveCfg({ url: base, client_id: OAUTH_CLIENT_ID, access_token: String(out.access_token),
    refresh_token: String(out.refresh_token), expires_at: Date.now() / 1000 + (Number(out.expires_in) || 86400),
    scope: String(out.scope || OAUTH_SCOPE) });
  console.log(`[crewrouter-helper] 登录成功，凭证已写入 ${CONFIG_PATH}（权限 600）`);
  return 0;
}

module.exports = {
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  REFRESH_AHEAD_SEC,
  acquireTokenLock,
  releaseTokenLock,
  makePkce,
  oauthAccessToken,
  getCredential,
  runLogin,
};
