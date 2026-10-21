'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { clearLatencyStatsCache, queryLatencyStats } = require('../utils/latency-stats');

// 仅允许显式提供的隔离数据库执行；生产库不要设置该变量。
test('隔离 PostgreSQL：延迟百分位、限流快照与用户范围', { skip: !process.env.LATENCY_STATS_TEST_DATABASE_URL }, async () => {
  const db = new Client({ connectionString: process.env.LATENCY_STATS_TEST_DATABASE_URL });
  await db.connect();
  const schema = `latency_stats_${process.pid}`;
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  try {
    await db.query(`
      CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE usage_records (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        model_id TEXT,
        provider_id TEXT,
        request_source TEXT,
        is_stream BOOLEAN,
        ttft_ms INTEGER,
        e2e_ms INTEGER,
        tpot_ms NUMERIC(12,3),
        output_tps NUMERIC(12,3),
        upstream_processing_ms INTEGER,
        service_tier VARCHAR(32),
        rate_limit JSONB,
        prompt_tokens INTEGER,
        cached_tokens INTEGER,
        completion_tokens INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO models VALUES ('m1', 'Model 1');
      INSERT INTO providers VALUES ('p1', 'Provider 1');
      INSERT INTO usage_records
        (user_id, model_id, provider_id, request_source, is_stream, ttft_ms, e2e_ms, tpot_ms, output_tps, upstream_processing_ms, service_tier, rate_limit, prompt_tokens, cached_tokens, completion_tokens, created_at)
      VALUES
        (1, 'm1', 'p1', 'codex', true, 100, 1100, 10, 100, 50, 'default', '{"headers":{"x-ratelimit-remaining-requests":"9"}}'::jsonb, 1000, 400, 10, '2026-10-20 10:00:00'),
        (1, 'm1', 'p1', 'codex', true, 200, 1300, 20, 50, 60, 'priority', NULL, 1000, 500, 10, '2026-10-21 10:00:00'),
        (1, 'm1', 'p1', 'codex', false, NULL, 800, NULL, NULL, 70, 'default', NULL, 1000, 600, 10, '2026-10-21 11:00:00'),
        (2, 'm1', 'p1', 'claude_code', true, 900, 2000, 90, 10, 80, 'default', NULL, 1000, 100, 10, '2026-10-21 12:00:00');
    `);
    clearLatencyStatsCache();
    const queryable = { query: (sql, params) => db.query(sql, params) };

    const user = await queryLatencyStats(queryable, { start: '2026-10-20', end: '2026-10-21', is_stream: '1' }, 'user', 1);
    assert.equal(user.summary.requests, 2);
    assert.equal(user.summary.ttft.p50, 150);
    assert.equal(user.summary.ttft.p95, 195);
    assert.equal(user.summary.outputTps.p50, 75);
    assert.equal(user.summary.cacheHitRate, 0.45);
    assert.equal(user.byModel[0].name, 'Model 1');
    assert.equal(user.byProvider[0].name, 'Provider 1');
    assert.equal(user.rateLimits[0].providerName, 'Provider 1');
    assert.equal(user.coverage.measuredRequests, 2);

    const admin = await queryLatencyStats(queryable, { start: '2026-10-20', end: '2026-10-21' }, 'admin', null);
    assert.equal(admin.summary.requests, 4);
    assert.equal(admin.summary.measuredRequests, 4);
    assert.equal(admin.byModel[0].requests, 4);
  } finally {
    clearLatencyStatsCache();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
});
