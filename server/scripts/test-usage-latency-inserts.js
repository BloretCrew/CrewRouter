'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'routes/api.js'), 'utf8');
const playgroundSource = fs.readFileSync(path.join(root, 'routes/playground.js'), 'utf8');
const initDbSource = fs.readFileSync(path.join(root, 'scripts/init-db.js'), 'utf8');

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

test('every gateway usage insert carries latency metric columns and values', () => {
  const inserts = count(apiSource, /INSERT INTO usage_records/g);
  assert.equal(inserts, 8, 'gateway usage insert count changed; update metrics wiring');
  assert.ok(count(apiSource, /USAGE_METRIC_COLUMNS/g) >= inserts, 'each insert needs the metric columns');
  assert.ok(count(apiSource, /usageMetricPlaceholders\(/g) >= inserts, 'each insert needs metric placeholders');
  assert.ok(count(apiSource, /usageMetricValues\(/g) >= inserts, 'each insert needs metric values');
  assert.equal(count(apiSource, /\$\{USAGE_METRIC_COLUMNS\}/g), inserts, 'metric columns must be interpolated into each insert');
  assert.equal(count(apiSource, /\$\{usageMetricPlaceholders\(/g), inserts, 'metric placeholders must be interpolated into each insert');
});

test('playground usage inserts carry latency metric columns and values', () => {
  const inserts = count(playgroundSource, /INSERT INTO usage_records/g);
  assert.equal(inserts, 2);
  assert.ok(count(playgroundSource, /USAGE_METRIC_COLUMNS/g) >= inserts);
  assert.ok(count(playgroundSource, /usageMetricPlaceholders\(/g) >= inserts);
  assert.ok(count(playgroundSource, /usageMetricValues\(/g) >= inserts);
  assert.equal(count(playgroundSource, /\$\{USAGE_METRIC_COLUMNS\}/g), inserts);
  assert.equal(count(playgroundSource, /\$\{usageMetricPlaceholders\(/g), inserts);
});

test('init-db migrates latency columns for existing databases', () => {
  assert.match(initDbSource, /ensureUsageLatencyColumns/);
  assert.match(initDbSource, /ttft_ms INTEGER/);
  assert.match(initDbSource, /rate_limit JSONB/);
  assert.match(initDbSource, /e2e_ms INTEGER/);
});

test('ensureUsageLatencyColumns only adds missing columns and restores timeouts', async () => {
  const { ensureUsageLatencyColumns } = require('../utils/usage-latency-migration');
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '5s', statement_timeout: '10s' }] };
      if (sql.includes('pg_attribute')) return { rows: [{ column_name: 'ttft_ms' }, { column_name: 'e2e_ms' }] };
      return { rows: [] };
    },
  };
  await ensureUsageLatencyColumns(client);
  const alter = calls.find(call => call.sql.startsWith('ALTER TABLE usage_records'));
  assert.ok(alter, 'ALTER TABLE must run');
  assert.ok(alter.sql.includes('ADD COLUMN IF NOT EXISTS is_stream BOOLEAN'));
  assert.ok(!alter.sql.includes('ADD COLUMN IF NOT EXISTS ttft_ms'));
  assert.ok(alter.sql.includes('rate_limit JSONB'));
  const restore = calls[calls.length - 1];
  assert.match(restore.sql, /set_config\('lock_timeout'/);
  assert.deepEqual(restore.params, ['5s', '10s']);
});

test('gateway proxies begin attempts and forward upstream observability headers', () => {
  for (const fn of [
    'proxyOpenAI',
    'proxyChatToResponses',
    'proxyAnthropic',
    'proxyAnthropicToAnthropic',
    'proxyOpenAIStreamToAnthropic',
    'proxyOpenAIForResponses',
    'proxyAnthropicForResponses',
  ]) {
    const start = apiSource.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, `${fn} missing`);
    const next = apiSource.indexOf('\nasync function ', start + 1);
    const block = apiSource.slice(start, next > 0 ? next : start + 12000);
    assert.match(block, /beginAttempt\(/, `${fn} must begin a metrics attempt`);
    assert.match(block, /forwardUpstreamHeaders\(/, `${fn} must forward upstream headers`);
  }
});
