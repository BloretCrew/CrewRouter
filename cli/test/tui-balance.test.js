'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

test('balance page mirrors web order and explains Team quota usage', async () => {
  const calls = [];
  const runtime = { client: { isAdmin: false, baseUrl: 'https://router.example', authType: () => 'session' }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const page = buildPages(runtime).find(item => item.id === 'balance');
  const data = await page.load(async path => {
    calls.push(path);
    if (path === '/api/user/balance') return { balance: 125, refund_balance: 20.5, rate_limit_rpm: 30, rate_limit_tpm: 50000, group: { name: 'Team One', description: 'Shared quota', rules: [{ rule_type: 'requests', rule_value: 100, current: 25, duration_hours: 24, description: 'Daily request cap' }, { rule_type: 'tokens', rule_value: 100000, current: 50000, duration_hours: 6 }] } };
    return [{ id: 1 }, { id: 2 }];
  });
  assert.deepEqual(calls, ['/api/user/balance', '/api/user/code-balances']);
  assert.deepEqual(data.sections.map(section => section.title), ['当前积分', 'Team 与限额']);
  assert.equal(data.sections[0].cards[0].value, '125 积分');
  assert.ok(data.sections[0].rows.some(row => row.label.includes('可退款余额：20.5000 积分')));
  assert.ok(data.sections[0].rows.some(row => row.label.includes('2 条充值记录')));
  assert.match(data.sections[1].description, /Team One · Shared quota/);
  assert.match(data.sections[1].rows[0].label, /1 天 · 请求次数：25 \/ 100 · 25\.0%/);
  assert.ok(data.sections[1].rows[0].detail.includes('█████'));
  assert.match(data.sections[1].rows[1].label, /6 小时 · Token 用量：50\.0K \/ 100\.0K · 50\.0%/);
});
