'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearLatencyStatsCache,
  parseLatencyQuery,
  queryLatencyStats,
} = require('../utils/latency-stats');

function summaryRow() {
  return {
    requests: '100',
    measured: '90',
    ttft_ms_p50: '400',
    ttft_ms_p75: '500',
    ttft_ms_p95: '800',
    ttft_ms_p99: '1000',
    e2e_ms_p50: '2400',
    e2e_ms_p75: '3000',
    e2e_ms_p95: '5000',
    e2e_ms_p99: '7000',
    tpot_ms_p50: '12.3456',
    tpot_ms_p75: '15',
    tpot_ms_p95: '20',
    tpot_ms_p99: '25',
    output_tps_p50: '70.1234',
    output_tps_p75: '80',
    output_tps_p95: '100',
    output_tps_p99: '120',
    upstream_processing_ms_p50: '200',
    upstream_processing_ms_p75: '250',
    upstream_processing_ms_p95: '400',
    upstream_processing_ms_p99: '500',
    upstream_processing_avg: '230.6',
    prompt_tokens: '100000',
    cached_tokens: '64000',
    tps_ge_50: '0.8',
    tps_ge_80: '0.4',
    tps_ge_90: '0.25',
    tps_ge_100: '0.1',
  };
}

function fakeDb(queryLog = []) {
  return {
    async query(sql, params) {
      queryLog.push({ sql, params });
      if (sql.includes('DISTINCT ON')) {
        return { rows: [{ provider_id: 'p1', provider_name: 'Provider', rate_limit: { headers: {} }, service_tier: 'default', created_at: '2026-10-21T10:00:00Z' }] };
      }
      if (sql.includes('GROUP BY to_char')) {
        return { rows: [{ date: '2026-10-21', requests: '100', measured: '90', ttft_ms_p50: '400', ttft_ms_p75: '500', ttft_ms_p95: '800', ttft_ms_p99: '1000', e2e_ms_p50: '2400', e2e_ms_p75: '3000', e2e_ms_p95: '5000', e2e_ms_p99: '7000', output_tps_p50: '70', output_tps_p75: '80', output_tps_p95: '100', output_tps_p99: '120' }] };
      }
      if (sql.includes('GROUP BY ur.model_id')) {
        return { rows: [{ model_id: 'm1', model_name: 'Model 1', requests: '60', measured: '58', ttft_ms_p50: '350', ttft_ms_p75: '450', ttft_ms_p95: '700', ttft_ms_p99: '900', e2e_ms_p50: '2000', e2e_ms_p75: '2500', e2e_ms_p95: '4000', e2e_ms_p99: '6000', tpot_ms_p50: '11', tpot_ms_p75: '13', tpot_ms_p95: '18', tpot_ms_p99: '22', output_tps_p50: '72', output_tps_p75: '82', output_tps_p95: '102', output_tps_p99: '122', prompt_tokens: '60000', cached_tokens: '30000' }] };
      }
      if (sql.includes('GROUP BY ur.provider_id')) {
        return { rows: [{ provider_id: 'p1', provider_name: 'Provider', requests: '60', measured: '58', ttft_ms_p50: '350', ttft_ms_p75: '450', ttft_ms_p95: '700', ttft_ms_p99: '900', e2e_ms_p50: '2000', e2e_ms_p75: '2500', e2e_ms_p95: '4000', e2e_ms_p99: '6000', output_tps_p50: '72', output_tps_p75: '82', output_tps_p95: '102', output_tps_p99: '122', prompt_tokens: '60000', cached_tokens: '30000' }] };
      }
      if (sql.includes('AS requests')) {
        return { rows: [summaryRow()] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

test('parseLatencyQuery defaults to 7 days and clamps to 90', () => {
  const defaultQuery = parseLatencyQuery({});
  assert.equal(defaultQuery.days, 7);
  assert.equal(defaultQuery.clipped, false);

  const longRange = parseLatencyQuery({ days: '365' });
  assert.equal(longRange.days, 90);
  assert.equal(longRange.clipped, true);

  const custom = parseLatencyQuery({ start: '2026-01-01', end: '2026-04-30' });
  assert.equal(custom.end, '2026-04-30');
  assert.equal(custom.days, 90);
  assert.equal(custom.clipped, true);
  assert.ok(custom.start > '2026-01-01');
});

test('parseLatencyQuery validates dates and stream filter', () => {
  assert.throws(() => parseLatencyQuery({ start: 'bad', end: '2026-10-01' }), /有效的开始和结束日期/);
  assert.throws(() => parseLatencyQuery({ start: '2026-10-05', end: '2026-10-01' }), /开始日期不能晚于结束日期/);
  assert.equal(parseLatencyQuery({ is_stream: '1' }).isStream, true);
  assert.equal(parseLatencyQuery({ is_stream: 'false' }).isStream, false);
  assert.equal(parseLatencyQuery({ is_stream: 'x' }).isStream, null);
});

test('user scope forces user_id and maps percentiles', async () => {
  clearLatencyStatsCache();
  const log = [];
  const data = await queryLatencyStats(fakeDb(log), { days: '7', model_id: 'm1', is_stream: '1' }, 'user', 42);
  assert.deepEqual(log[0].params.slice(0, 2), [data.window.start, data.window.end]);
  assert.equal(log[0].params[2], 42);
  assert.ok(log[0].params.includes('m1'));
  assert.ok(log[0].params.includes(true));
  assert.equal(data.summary.ttft.p50, 400);
  assert.equal(data.summary.tpot.p50, 12.3);
  assert.equal(data.summary.outputTps.p50, 70.12);
  assert.equal(data.summary.cacheHitRate, 0.64);
  assert.equal(data.summary.tpsThresholds.ge50, 0.8);
  assert.equal(data.coverage.totalRequests, 100);
  assert.equal(data.coverage.measuredRequests, 90);
  assert.equal(data.byModel[0].name, 'Model 1');
  assert.equal(data.byProvider[0].name, 'Provider');
  assert.equal(data.rateLimits[0].providerName, 'Provider');
  assert.equal(data.daily[0].date, '2026-10-21');
  assert.equal(data.window.timezone, 'Asia/Shanghai');
});

test('admin scope omits user_id and results are cached', async () => {
  clearLatencyStatsCache();
  const log = [];
  const db = fakeDb(log);
  await queryLatencyStats(db, { days: '7' }, 'admin', null);
  const afterFirst = log.length;
  assert.equal(afterFirst, 5);
  assert.equal(log[0].params.length, 2, 'admin query has no user filter');

  await queryLatencyStats(db, { days: '7' }, 'admin', null);
  assert.equal(log.length, afterFirst, 'second call must hit the cache');
});

test('query timeout maps to a 503 error', async () => {
  clearLatencyStatsCache();
  const db = {
    async query() {
      const error = new Error('canceling statement due to statement timeout');
      error.code = '57014';
      throw error;
    },
  };
  await assert.rejects(
    () => queryLatencyStats(db, { days: '7' }, 'admin', null),
    error => error.status === 503 && /缩小时间范围/.test(error.message)
  );
});
