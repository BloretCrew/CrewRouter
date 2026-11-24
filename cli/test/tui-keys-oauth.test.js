'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

const runtime = { client: { isAdmin: false }, cfg: { tui: { days: 30 } }, profileName: 'test' };

test('API key page loads OAuth authorizations and confirms global revoke', async () => {
  const calls = [];
  runtime.client.get = async path => {
    calls.push({ path, method: 'GET' });
    if (path === '/api/user/api-keys') return [];
    if (path === '/oauth/authorizations') return { authorizations: [{ id: 5, client_name: 'Desktop App', client_id: 'client-1', created_at: '2026-11-01T00:00:00Z', scopes: ['profile'] }] };
    return {};
  };
  runtime.client.post = async (path, body) => { calls.push({ path, method: 'POST', body }); return { ok: true }; };
  const page = buildPages(runtime).find(item => item.id === 'keys');
  const data = await page.load();
  const authSection = data.sections.find(section => section.title === 'OAuth 授权');
  assert.ok(authSection.rows[0].label.includes('Desktop App'));
  let warning = '';
  await authSection.rows[0].run({ confirm: async (_title, message) => { warning = message; return false; } });
  assert.ok(warning.includes('所有访问令牌立即失效'));
  assert.equal(calls.some(call => call.method === 'POST'), false);
  await authSection.rows[0].run({ confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.at(-1), { path: '/oauth/authorizations/revoke', method: 'POST', body: { id: 5 } });
});
