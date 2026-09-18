'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadIsolated(file, overrides) {
  const filename = path.resolve(__dirname, file);
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, require: name => overrides[name] || localRequire(name),
    process, Buffer, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

async function main() {
  const { proxyFetch } = loadIsolated('../proxy-pool.js', {
    './models/database': { pool: {} },
    './logger': { info() {}, warn() {}, error() {} },
  });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/oauth/token') {
      const params = new URLSearchParams(body);
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'fixture+refresh&token=值');
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      res.end(JSON.stringify({ access_token: 'fresh-fixture', refresh_token: 'rotated-fixture', expires_in: 3600 }));
    } else if (req.headers.authorization === 'Bearer expired-fixture') {
      res.writeHead(401).end(JSON.stringify({ error: 'expired' }));
    } else {
      assert.equal(req.headers.authorization, 'Bearer fresh-fixture');
      res.end(JSON.stringify({ plan_type: 'plus', rate_limit: {
        allowed: true, primary_window: { used_percent: 23 }, secondary_window: { used_percent: 45 },
      } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = new http.Agent();
  try {
    const { fetchCodexUsage } = loadIsolated('../utils/codex-usage.js', {
      './quota-http': { quotaRequest: (url, init) => proxyFetch(base + new URL(url).pathname, { ...init, agent }) },
    });
    let saved;
    const provider = { oauth_access_token: 'expired-fixture', oauth_refresh_token: 'fixture+refresh&token=值', oauth_account_id: 'fixture-account' };
    const quota = await fetchCodexUsage(provider, { saveTokens: async value => { saved = value; } });
    assert.equal(quota.planName, 'plus');
    assert.equal(quota.used, 23);
    assert.equal(quota.periods[1].percent, 45);
    assert.equal(saved.accessToken, 'fresh-fixture');
    assert.equal(saved.refreshToken, 'rotated-fixture');
    assert.equal(provider.oauth_access_token, 'fresh-fixture');
    assert.equal(requests.length, 3);
    assert.equal(requests[2].headers['chatgpt-account-id'], 'fixture-account');
    assert(requests[1].body.includes('%2B') && requests[1].body.includes('%26'));
    requests.length = 0;
    await fetchCodexUsage(provider, { saveTokens: async () => assert.fail('有效令牌不应刷新') });
    assert.equal(requests.length, 1);
    const rejected = loadIsolated('../utils/codex-usage.js', {
      './quota-http': { quotaRequest: async () => ({
        ok: false, status: 400,
        text: async () => JSON.stringify({ error: { code: 'invalid_refresh_token', message: 'Invalid refresh token.' } }),
      }) },
    });
    await assert.rejects(
      () => rejected.fetchCodexUsage({ oauth_access_token: 'e', oauth_refresh_token: 'b' }),
      error => /Invalid refresh token\./.test(error.message) && !/\[object Object\]/.test(error.message)
    );
    console.log('PASS Codex quota: expired token → form POST over axios transport → persist rotated token → retry usage; valid token unchanged');
  } finally {
    agent.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
