'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { fetchOpenRouterUsage } = require('../utils/openrouter-usage');
const { fetchMoonshotUsage } = require('../utils/moonshot-usage');
const { fetchSiliconFlowUsage } = require('../utils/siliconflow-usage');

let creditsMode = 'ok';
let keyMode = 'ok';
let moonshotMode = 'ok';
let siliconflowMode = 'ok';
const requests = [];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  requests.push({ url: req.url, auth: req.headers.authorization });
  if (req.url === '/api/v1/credits') {
    if (creditsMode === 'ok') return json(res, 200, { data: { total_credits: 100, total_usage: 25 } });
    return json(res, 403, { error: { message: 'Management key required' } });
  }
  if (req.url === '/api/v1/key') {
    if (keyMode === 'ok') {
      return json(res, 200, { data: { limit: 100, limit_remaining: 75, usage: 25, usage_daily: 1, usage_weekly: 5, usage_monthly: 20 } });
    }
    return json(res, 401, { error: { message: 'Missing Authentication header' } });
  }
  if (req.url === '/v1/users/me/balance') {
    if (moonshotMode === 'ok') {
      return json(res, 200, { code: 0, data: { available_balance: 49.5, voucher_balance: 46.5, cash_balance: 3 }, status: true });
    }
    return json(res, 401, { error: { message: 'Invalid Authentication' } });
  }
  if (req.url === '/v1/user/info') {
    if (siliconflowMode === 'ok') {
      return json(res, 200, { code: 20000, message: 'OK', status: true, data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } });
    }
    if (siliconflowMode === 'code') return json(res, 200, { code: 20012, message: 'invalid token', status: false });
    return json(res, 401, { code: 20012, message: 'invalid token', status: false });
  }
  json(res, 404, { error: { message: 'not found' } });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const provider = (path, key = 'sk-test-key') => ({ name: 'Test', base_url: `${base}${path}`, api_key: key });
  try {
    // OpenRouter：Management Key 查账户 Credits
    const credits = await fetchOpenRouterUsage(provider('/api/v1'));
    assert.equal(credits.currency, 'USD');
    assert.equal(credits.total, 100);
    assert.equal(credits.used, 25);
    assert.equal(credits.remaining, 75);
    assert.equal(requests.at(-1).url, '/api/v1/credits');
    assert.equal(requests.at(-1).auth, 'Bearer sk-test-key');

    // OpenRouter：普通 Key 的 /credits 被拒后回退 /api/v1/key
    creditsMode = 'deny';
    const keyQuota = await fetchOpenRouterUsage(provider('/api/v1'));
    assert.equal(keyQuota.total, 100);
    assert.equal(keyQuota.used, 25);
    assert.equal(keyQuota.remaining, 75);
    assert.match(keyQuota.extra, /普通 Key 额度/);
    assert.deepEqual(requests.slice(-2).map(item => item.url), ['/api/v1/credits', '/api/v1/key']);

    // 两种 Key 都失败时错误包含两段原因
    keyMode = 'deny';
    await assert.rejects(() => fetchOpenRouterUsage(provider('/api/v1')), (error) => {
      assert.match(error.message, /Management key required/);
      assert.match(error.message, /Missing Authentication header/);
      return true;
    });

    // Moonshot
    moonshotMode = 'ok';
    const moonshot = await fetchMoonshotUsage(provider('/v1'));
    assert.equal(moonshot.currency, 'CNY');
    assert.equal(moonshot.total, 49.5);
    assert.equal(moonshot.remaining, 49.5);
    assert.equal(moonshot.used, null);
    assert.equal(requests.at(-1).url, '/v1/users/me/balance');
    assert.equal(requests.at(-1).auth, 'Bearer sk-test-key');
    moonshotMode = 'deny';
    await assert.rejects(() => fetchMoonshotUsage(provider('/v1')), /Invalid Authentication/);

    // SiliconFlow
    siliconflowMode = 'ok';
    const siliconflow = await fetchSiliconFlowUsage(provider('/v1'));
    assert.equal(siliconflow.currency, 'CNY');
    assert.equal(siliconflow.total, 88.88);
    assert.equal(siliconflow.used, null);
    assert.equal(requests.at(-1).url, '/v1/user/info');
    assert.equal(requests.at(-1).auth, 'Bearer sk-test-key');
    siliconflowMode = 'code';
    await assert.rejects(() => fetchSiliconFlowUsage(provider('/v1')), /invalid token/);
    siliconflowMode = 'deny';
    await assert.rejects(() => fetchSiliconFlowUsage(provider('/v1')), /invalid token/);

    await assert.rejects(() => fetchOpenRouterUsage(provider('/api/v1', '')), /未配置 OpenRouter API Key/);
    await assert.rejects(() => fetchMoonshotUsage(provider('/v1', '')), /未配置 Moonshot API Key/);
    await assert.rejects(() => fetchSiliconFlowUsage(provider('/v1', '')), /未配置 SiliconFlow API Key/);

    console.log('OpenRouter / Moonshot / SiliconFlow HTTP integration passed');
  } finally {
    server.close();
  }
});
