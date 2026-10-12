'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { parseQuotaQuery, accountScope, publicItem, groupItems, queryProviderQuotaOverview, queryProviderQuotaHistory, queryUsageContribution } = require('../utils/provider-quota-stats');
const { queryMultiDimensionStats } = require('../utils/multi-dimension-stats');

function mockPool(responses) {
  return { calls: [], async query(sql, params) {
    this.calls.push({ sql, params });
    assert.ok(responses.length, 'unexpected database query');
    return { rows: responses.shift() };
  } };
}
const range = { start: '2026-01-01', end: '2026-01-31' };
const sample = { provider_id: 'p1', provider_name: '供应商', account_id: 'a1', label: '账户', kind: 'balance', unit: 'USD', window_key: '', total: '100', used: '20', remaining: '80', used_percent: null, observed_at: '2026-01-20T00:00:00Z', status: 'success', last_attempt_status: 'failed', last_attempt_at: '2026-01-21T00:00:00Z' };

test('额度明细保留设置兼容旧请求，支持0及上限校验', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname,'../routes/admin.js'),'utf8');
  const start = source.indexOf('const RETENTION_LIMITS = {');
  const end = source.indexOf("router.get('/retention-config'",start);
  const context = {};
  vm.runInNewContext(source.slice(start,end),context);
  const base = {compress_days:14,purge_days:90,compress_size_gb:0,purge_size_gb:0,agg_enabled:true};
  assert.equal(context.normalizeRetentionPayload(base).providerQuotaDays,undefined);
  assert.equal(context.normalizeRetentionPayload({...base,provider_quota_days:0}).providerQuotaDays,0);
  assert.equal(context.normalizeRetentionPayload({...base,provider_quota_days:3650}).providerQuotaDays,3650);
  for (const value of [-1,3651,1.5,'']) assert.throws(()=>context.normalizeRetentionPayload({...base,provider_quota_days:value}));
});

test('日期与分页严格校验，上海自然日边界', () => {
  for (const query of [{ start: '2026-02-30', end: '2026-03-01' }, { start: '2026-01-01' }, { days: '1x' }, { days: [] }, { limit: 201 }, { page: 0 }, { provider_id: {} }, { start: '2025-01-01', end: '2026-01-01' }]) {
    assert.throws(() => parseQuotaQuery(query), error => error.status === 400);
  }
  assert.equal(parseQuotaQuery({ ...range, limit: '200' }).limit, 200);
});

test('权限使用当前模型授权和逐路径 Team 隐藏判断，账户 ID 不能绕过权限', () => {
  const params = [];
  const sql = accountScope({ provider_id: 'p1', account_id: 'other-account' }, 'user', 7, params);
  assert.match(sql, /EXISTS/);
  assert.match(sql, /vp.enabled = TRUE AND vp.quota_enabled = TRUE/);
  assert.match(sql, /ut.user_id = \$1/);
  assert.match(sql, /ht.id = ut.team_id AND ht.hide_provider_quota = TRUE/);
  assert.match(sql, /a.id::text = \$3/);
  assert.deepEqual(params, [7, 'p1', 'other-account']);
  assert.throws(() => accountScope({}, 'user', null, []));
});

test('类型、单位和窗口不混合汇总；百分比和未知单位不可相加；零与缺失分离', () => {
  const item = publicItem({ ...sample, remaining: 0, used: null, secret: 'never-return', quality: { token: 'never-return' } });
  assert.equal(item.remaining, 0);
  assert.equal(item.used, null);
  assert.equal(item.secret, undefined);
  const groups = groupItems([
    item, { ...item, account_id: 'a2', remaining: 10 },
    { ...item, unit: 'CNY', remaining: 70 },
    { ...item, kind: 'window', unit: 'percent', used_percent: 95 },
    { ...item, unit: 'unknown', remaining: 5 },
    { ...item, window_key: 'other', remaining: 3 }
  ]);
  assert.equal(groups.length, 5);
  assert.equal(groups[0].remaining, 10);
  assert.equal(groups[2].remaining, null);
  assert.equal(groups[3].aggregatable, false);
  assert.ok(groups.every(group => group.used_percent === undefined));
});

test('概览保留失败前有效值，日聚合趋势与独立请求贡献不发生多对多膨胀', async () => {
  const pool = mockPool([
    [sample, { ...sample, account_id: 'a2', remaining: '30' }],
    [{ ...sample, date: '2026-01-20', sample_count: '2', observed_consumption: '5' }],
    [{ account_id: 'a1', provider_id: 'p1', first_observed_at: '2026-01-01T00:00:00Z' }],
    [{ provider_id: 'p1', date: '2026-01-20', requests: '3', tokens: '100', cost: '2' }]
  ]);
  const result = await queryProviderQuotaOverview(pool, range, 'user', 7);
  assert.equal(result.summary.accounts, 2);
  assert.equal(result.summary.failed, 2);
  assert.equal(result.accounts[0].remaining, 80);
  assert.equal(result.accounts[0].status, 'failed');
  assert.equal(result.groups[0].remaining, 110);
  assert.equal(result.groups[0].observed_consumption, 5);
  assert.equal(result.usage_trend[0].requests, 3);
  assert.equal(result.accounts[0].requests, 3);
  assert.equal(result.coverage.samples, 2);
  assert.equal(result.coverage.usage_complete, false);
  assert.match(pool.calls[0].sql, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.match(pool.calls[0].sql, /provider_quota_daily_agg/);
  assert.match(pool.calls[0].sql, /DISTINCT ON \(candidate.kind, candidate.unit, candidate.window_key\)/);
  assert.equal(result.coverage.started_at, '2026-01-01T00:00:00Z');
  assert.match(pool.calls[3].sql, /NOT EXISTS \(SELECT 1 FROM provider_usage_archived/);
  assert.doesNotMatch(pool.calls[3].sql, /JOIN provider_quota_observation/);
  assert.match(pool.calls[3].sql, /u.user_id = \$3/);
});

test('无可见账户时概览不会泄漏请求或趋势', async () => {
  const pool = mockPool([[], [], [], [{ provider_id: 'p1', requests: 3, tokens: 100, cost: 2 }]]);
  const result = await queryProviderQuotaOverview(pool, range, 'user', 7);
  assert.equal(result.accounts.length, 0);
  assert.equal(result.trend.length, 0);
  assert.equal(result.usage_trend.length, 0);
});

test('历史分页使用同一权限和筛选，不返回错误详情、凭据或原始响应', async () => {
  const pool = mockPool([[{ total: 123 }], [{ ...sample, observation_id: 'obs1', error: 'secret', token: 'secret' }]]);
  const result = await queryProviderQuotaHistory(pool, { ...range, page: 2, limit: 10, account_id: 'a1', window_key: 'month', status: 'failed' }, 'user', 9);
  assert.equal(result.total, 123);
  assert.equal(result.page, 2);
  assert.equal(result.limit, 10);
  assert.equal(result.rows[0].error, undefined);
  assert.equal(result.rows[0].token, undefined);
  assert.equal(result.rows[0].observation_id, 'obs1');
  assert.deepEqual(pool.calls[1].params.slice(-2), [10, 10]);
  assert.match(pool.calls[0].sql, /hide_provider_quota/);
  assert.match(pool.calls[0].sql, /a.id::text/);
  assert.match(pool.calls[1].sql, /o.checked_at DESC, o.id DESC, i.kind, i.unit, i.window_key/);
});

test('请求关联的筛选从长期源读取，不通过当前模型推断历史供应商', async () => {
  const pool = mockPool([[]]);
  await queryUsageContribution(pool, parseQuotaQuery({ ...range, model_id: 'm1', team_id: '2', workspace_path: 'project', api_key_id: '5' }), 'admin');
  const { sql, params } = pool.calls[0];
  assert.match(sql, /provider_usage_daily_agg/);
  assert.match(sql, /SUM\(u.request_count\)/);
  assert.match(sql, /u.model_id = \$3/);
  assert.match(sql, /u.workspace_path/);
  assert.deepEqual(params, ['2026-01-01', '2026-01-31', 'm1', '5', '2', 'project']);
});

test('多维额度拒绝不支持的维度和跨账户使用率组合', async () => {
  const pool = mockPool([]);
  for (const query of [
    { data_source: 'quota', dimensions: 'user' },
    { data_source: 'quota', dimensions: 'provider', metric: 'used_percent' },
    { data_source: 'quota', dimensions: 'account', metric: 'cost' },
    { data_source: 'unknown' }
  ]) await assert.rejects(queryMultiDimensionStats(pool, query, 'admin'), error => error.status === 400);
  assert.equal(pool.calls.length, 0);
});

test('多维请求默认响应兼容，关联分析单独返回去重账户面板', async () => {
  const row = { value_0: 'm1', name_0: '模型', requests: 2, tokens: 10, cost: '1' };
  const basePool = mockPool([[row]]);
  const base = await queryMultiDimensionStats(basePool, {}, 'user', 7);
  assert.deepEqual(base, { dimensions: ['model'], metric: 'requests', rows: [{ labels: ['模型'], values: ['m1'], requests: 2, tokens: 10, cost: 1 }] });
  const pool = mockPool([[row], [sample], [], [], []]);
  const result = await queryMultiDimensionStats(pool, { ...range, data_source: 'association', provider_id: 'p1' }, 'user', 7);
  assert.equal(result.rows[0].requests, 2);
  assert.equal(result.provider_quota.accounts.length, 1);
  assert.equal(result.quota_context, 'independent_provider_accounts_not_additive');
  assert.match(pool.calls[0].sql, /u.provider_id = \$4/);
});

test('管理员和用户路由均注册额度与历史入口，固定组合接口保持默认兼容', () => {
  const admin = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  const user = fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8');
  assert.match(admin, /router.get\('\/stats\/provider-quota', requireAuth, requireProviderManager/);
  assert.match(user, /router.get\('\/stats\/provider-quota\/history', requireAuth, requireProviderAccessContext/);
  assert.match(admin, /req.query.data_source === 'association'/);
  assert.match(admin, /quota_account_ids/);
});

test('多维按选择维度聚合已知单位金额，未知单位与账户使用率不相加', async () => {
  const accounts = [sample, { ...sample, account_id: 'a2', remaining: 30 }, { ...sample, account_id: 'a3', unit: 'unknown', remaining: 7 }, { ...sample, account_id: 'a4', unit: 'unknown', remaining: 8 }];
  const pool = mockPool([accounts, [], [], []]);
  const result = await queryMultiDimensionStats(pool, { ...range, data_source: 'quota', dimensions: 'provider', metric: 'remaining' }, 'admin');
  assert.equal(result.rows.find(row => row.unit === 'USD').value, 110);
  assert.equal(result.rows.filter(row => row.unit === 'unknown').length, 2);
  assert.equal(result.rows.find(row => row.unit === 'USD').account_ids.length, 2);
  const percentPool = mockPool([[{ ...sample, kind: 'window', unit: 'percent', used_percent: 30 }, { ...sample, account_id: 'a2', kind: 'window', unit: 'percent', used_percent: 70 }], [], [], []]);
  const percent = await queryMultiDimensionStats(percentPool, { ...range, data_source: 'quota', dimensions: 'provider,account', metric: 'used_percent' }, 'admin');
  assert.equal(percent.rows.length, 2);
  assert.ok(percent.rows.every(row => !row.aggregatable));
});

test('趋势质量白名单、样本与百分点字段完整且敏感字段不返回', () => {
  const item = publicItem({ ...sample, observed_consumption: 3, anomaly_count: 1, sample_count: 5, percent_change: 2,
    quality: { event: 'gap', source: 'passive', precision: 'observation', token: 'secret' } });
  assert.equal(item.sample_count, 5);
  assert.equal(item.percent_change, 2);
  assert.equal(item.quality.event, 'gap');
  assert.equal(item.quality.token, undefined);
});
