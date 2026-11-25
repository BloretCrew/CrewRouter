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
    return [{ code: 'SECRET-CODE-12345', amount: 10, fee_rate: 0.1, net_amount: 9.0909 }, { code: 'ANOTHER-CODE-ABCDE', amount: 15, fee_rate: 0, net_amount: 15 }];
  });
  assert.deepEqual(calls, ['/api/user/balance', '/api/user/code-balances']);
  assert.deepEqual(data.sections.map(section => section.title), ['当前积分', '可退款兑换码明细（补充信息）', 'Team 与限额']);
  assert.equal(data.sections[0].cards[0].value, '125 积分');
  assert.ok(data.sections[0].rows.some(row => row.label.includes('可退款余额：20.5000 积分')));
  assert.match(data.sections[0].rows.find(row => row.label === '个人请求限额').detail, /30 次请求.*50\.0K Token/);
  const refundRows = data.sections[1].rows;
  assert.deepEqual(refundRows.map(row => row.cells), [
    { code: 'SEC…345', amount: '10.0000 积分', fee: '10.00%', net: '9.0909 积分' },
    { code: 'ANO…CDE', amount: '15.0000 积分', fee: '0.00%', net: '15.0000 积分' },
  ]);
  assert.doesNotMatch(JSON.stringify(refundRows), /SECRET-CODE|ANOTHER-CODE/);
  assert.match(data.sections[2].description, /Team One · Shared quota/);
  assert.match(data.sections[2].rows[0].label, /1 天 · 请求次数：25 \/ 100 · 25\.0%/);
  assert.ok(data.sections[2].rows[0].detail.includes('█████'));
  assert.match(data.sections[2].rows[1].label, /6 小时 · Token 用量：50\.0K \/ 100\.0K · 50\.0%/);
});
