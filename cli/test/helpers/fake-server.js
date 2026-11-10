'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const result = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function createFakeServer(options = {}) {
  const sessions = new Map();
  const state = {
    user: options.user || { id: 1, username: 'admin', email: 'admin@example.com', isAdmin: true },
    apiAdmin: options.apiAdmin !== false,
    twoFactor: options.twoFactor === true,
    loginCalls: 0,
    meCalls: 0,
    requests: [],
    keys: [{ id: 1, name: 'demo', key_prefix: 'sk-demo', enabled: true, total_requests: 2, total_tokens: 10, total_cost: 0.1, current_model_name: 'm1' }],
    providers: [{ id: 'p1', name: 'Provider', format: 'openai', enabled: true, base_url: 'https://p.example' }],
    models: [{ id: 'm1', name: 'Model 1', provider: 'p1', provider_name: 'Provider', enabled: true, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2 }],
  };
  function newSession() {
    const sid = crypto.randomBytes(8).toString('hex');
    sessions.set(sid, { csrf: crypto.randomBytes(8).toString('hex'), user: null, pending: null });
    return sid;
  }
  function send(res, status, body, sid) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) };
    if (sid) headers['Set-Cookie'] = `connect.sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
    res.writeHead(status, headers);
    res.end(text);
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const body = await readBody(req);
    const jar = cookies(req);
    const sid = jar['connect.sid'];
    let session = sid ? sessions.get(sid) : null;
    state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const isApiKey = Boolean(req.headers['x-api-key']);
    const apiAdmin = state.apiAdmin && req.headers['x-api-key'] === 'sk-admin';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isApiKey) {
      const token = req.headers['x-csrf-token'];
      const origin = req.headers.origin;
      if (!session || (token !== session.csrf && !(origin && options.strictCsrf !== true))) {
        return send(res, 403, { error: 'CSRF 校验失败', type: 'csrf_failed' });
      }
    }
    if (path === '/api/version' && req.method === 'GET') return send(res, 200, { name: 'CrewRouter', version: '1.0.0' });
    if (path === '/api/setup/status' && req.method === 'GET') return send(res, 200, { needsSetup: false, needsEdition: false, dbReady: true });
    if (path === '/api/instance' && req.method === 'GET') return send(res, 200, { runtime: 'server', edition: 'team', auth: { required: true, methods: ['password'] } });
    if (path === '/api/csrf-token' && req.method === 'GET') {
      if (!session) { const next = newSession(); session = sessions.get(next); return send(res, 200, { token: session.csrf }, next); }
      return send(res, 200, { token: session.csrf });
    }
    if (path === '/auth/login' && req.method === 'POST') {
      state.loginCalls++;
      if (!session) return send(res, 403, { error: 'csrf' }, newSession());
      if (body.login !== 'admin' || body.password !== 'pass') return send(res, 401, { error: '用户名或密码错误' });
      if (state.twoFactor) {
        const next = newSession();
        sessions.get(next).pending = state.user;
        return send(res, 200, { require2FA: true, userId: state.user.id }, next);
      }
      session.user = state.user;
      return send(res, 200, state.user);
    }
    if (path === '/auth/login/2fa' && req.method === 'POST') {
      if (!session || !session.pending) return send(res, 401, { error: '请先验证密码' });
      if (String(body.code) !== '123456') return send(res, 401, { error: '验证码错误' });
      session.user = session.pending;
      session.pending = null;
      return send(res, 200, state.user);
    }
    if (path === '/auth/me' && req.method === 'GET') {
      state.meCalls++;
      if (!session || !session.user) return send(res, 401, { error: '未登录' });
      return send(res, 200, session.user);
    }
    if (path === '/auth/logout' && req.method === 'GET') {
      if (sid) sessions.delete(sid);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    const authed = Boolean((session && session.user) || (isApiKey && (req.headers['x-api-key'] === 'sk-user' || req.headers['x-api-key'] === 'sk-admin')));
    if (!authed) return send(res, 401, { error: '请先登录' });
    const admin = Boolean((session && session.user.isAdmin) || apiAdmin);
    if (path === '/api/user/balance') {
      if (options.balance403) return send(res, 403, { error: '缺少权限', code: 'permission_denied' });
      return send(res, 200, { balance: 42, refund_balance: 1, rate_limit_rpm: 60 });
    }
    if (path === '/api/user/stats') return send(res, 200, {
      summary: { total_requests: 10, total_tokens: 1000, total_cost: 1.5, avg_latency: 120 },
      daily: [{ date: '2026-11-10', requests: 10, tokens: 1000, cost: 1.5 }],
      byModel: [{ model_id: 'm1', model_name: 'Model 1', requests: 10, tokens: 1000, cost: 1.5 }],
      byApiKey: [{ key_id: 1, key_name: 'demo', requests: 10, tokens: 1000, cost: 1.5 }],
      bySource: [],
    });
    if (path === '/api/user/api-keys' && req.method === 'GET') return send(res, 200, state.keys);
    if (path === '/api/user/api-keys' && req.method === 'POST') {
      const created = { id: 2, name: body.name, key_prefix: 'sk-new', key: 'sk-new-secret', enabled: true };
      state.keys.push(created);
      return send(res, 200, created);
    }
    if (/^\/api\/user\/api-keys\/\d+\/enabled$/.test(path) && req.method === 'PUT') {
      const id = Number(path.split('/')[4]);
      const key = state.keys.find(item => item.id === id);
      if (key) key.enabled = body.enabled;
      return send(res, 200, { success: true, enabled: body.enabled });
    }
    if (/^\/api\/user\/api-keys\/\d+$/.test(path) && req.method === 'DELETE') {
      const id = Number(path.split('/')[4]);
      state.keys = state.keys.filter(item => item.id !== id);
      return send(res, 200, { success: true });
    }
    if (/^\/api\/user\/api-keys\/\d+\/config$/.test(path)) return send(res, 200, { env: { ANTHROPIC_AUTH_TOKEN: 'secret' } });
    if (path === '/api/admin/providers') {
      if (!admin) return send(res, 403, { error: '无管理员权限', code: 'admin_required' });
      return send(res, 200, { items: state.providers, total: state.providers.length, stats: { total: 1, enabledCount: 1, globalCount: 1, userCount: 0 } });
    }
    if (path === '/api/user/my-providers') return send(res, 200, state.providers);
    if (path === '/api/user/providers') return send(res, 200, state.providers);
    if (path === '/api/admin/models') {
      if (!admin) return send(res, 403, { error: '无管理员权限', code: 'admin_required' });
      return send(res, 200, { items: state.models, total: 1, page: 1, stats: { enabledCount: 1 } });
    }
    if (path === '/api/user/models') return send(res, 200, state.models);
    if (path === '/api/user/sessions') return send(res, 200, {
      days: 30, page: 1, pageSize: 30, total: 1,
      items: [{ sessionKey: 'sess-1', harness: 'claude_code', requestCount: 3, totalTokens: 300, models: ['m1'], lastSeen: '2026-11-10T00:00:00Z' }],
    });
    if (path === '/api/user/sessions/sess-1/messages') return send(res, 200, { records: [{ created_at: '2026-11-10T00:00:00Z', model_name: 'm1', tokens_used: 10, response_preview: 'hello' }] });
    return send(res, 404, { error: 'not found' });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        state,
        sessions,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

module.exports = { createFakeServer };
