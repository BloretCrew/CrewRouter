'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const { ensureModelTraceTables } = require('../utils/model-trace-migration');
const { createStore, keyId } = require('../utils/model-trace-store');
const { createRunner } = require('../utils/model-trace-runner');
const { createRouter } = require('../routes/model-trace');
const { requestSpec, parseResponse } = require('../utils/model-trace-transport');

const keys = model => [{ key: model.api_key, enabled: true }, { key: 'disabled-secret', enabled: false }];
const version = { bank_hash: 'a'.repeat(64), source_commit: 'test', algorithm_version: 'test-v1' };
const core = { generateChallenges: () => Array.from({ length: 3 }, () => ({ prompt: 'independent challenge', expected_count: 100 })),
  parseNumbers: text => text.match(/\d+/g)?.map(Number) || [] };
const loadCore = async () => core;
const loadBank = async () => ({ bank: { models: [{ id: 'candidate', display_name: 'Candidate', family: 'family' }] }, metadata: version });
const score = async outputs => ({ used_outputs: outputs.length, results: [{ model: 'candidate', probability: 1 }] });

async function main() {
  const port = Number(process.env.MODEL_TRACE_TEST_PG_PORT);
  if (!port || port === 5432) throw new Error('Use MODEL_TRACE_TEST_PG_PORT for a disposable local PostgreSQL instance.');
  const admin = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  const schema = `model_trace_test_${randomUUID().replace(/-/g, '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', options: `-c search_path=${schema}` });
  const store = createStore({ pool, getKeys: keys });
  let server;
  let router;
  const runners = [];
  try {
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,balance NUMERIC(18,6),is_admin BOOLEAN DEFAULT FALSE);
      CREATE TABLE teams(id INTEGER PRIMARY KEY,quota_rules JSONB);
      CREATE TABLE user_teams(user_id INTEGER,team_id INTEGER);
      CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,base_url TEXT,format TEXT,api_key TEXT,api_keys JSONB,key_mode TEXT,
        proxy_pool JSONB,proxy_subscription_url TEXT,test_user_agent TEXT,created_by INTEGER,enabled BOOLEAN);
      CREATE TABLE models(id TEXT PRIMARY KEY,name TEXT,upstream_model_id TEXT,model_multiplier NUMERIC,provider TEXT,enabled BOOLEAN);
      CREATE TABLE team_models(team_id INTEGER,model_id TEXT,enabled BOOLEAN);
      CREATE TABLE usage_records(id SERIAL PRIMARY KEY,user_id INTEGER,model_id TEXT,provider_id TEXT,request_type TEXT,
        request_source TEXT,tokens_used INTEGER,prompt_tokens INTEGER,completion_tokens INTEGER,cached_tokens INTEGER,
        weighted_tokens BIGINT,cost NUMERIC(10,6),history_hidden BOOLEAN,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE quota_data(user_id INTEGER,model_name TEXT,created_at TIMESTAMP,token_used INTEGER,weighted_tokens BIGINT,count INTEGER,quota NUMERIC,
        UNIQUE(user_id,model_name,created_at));
      INSERT INTO users VALUES(1,1,FALSE),(2,1,FALSE),(3,0,FALSE),(4,1,TRUE);
      INSERT INTO teams VALUES(1,'[]'),(2,'[]');
      INSERT INTO user_teams VALUES(1,1),(2,2),(3,1),(4,2);
      INSERT INTO providers VALUES('p','Provider','https://example.com','openai','top-secret',NULL,'fixed',NULL,NULL,NULL,NULL,TRUE);
      INSERT INTO models VALUES('m','Model','fixed-model',1,'p',TRUE);
      INSERT INTO team_models VALUES(1,'m',TRUE);`);
    await pool.query('ALTER TABLE providers ADD COLUMN proxy_enabled BOOLEAN, ADD COLUMN proxy_mode TEXT, ADD COLUMN proxy_url TEXT, ADD COLUMN proxy_use_system BOOLEAN');
    await ensureModelTraceTables(pool);
    await ensureModelTraceTables(pool);
    const body = () => ({ model_id: 'm', key_id: keyId('top-secret'), idempotency_key: randomUUID() });
    await assert.rejects(store.create(2, body(), version), error => error.status === 403);
    await assert.rejects(store.create(4, body(), version), error => error.status === 403);
    await assert.rejects(store.create(3, body(), version), error => error.status === 402);
    await assert.rejects(store.create(1, { ...body(), key_id: keyId('disabled-secret') }, version), error => error.status === 403);
    await pool.query('UPDATE providers SET created_by=2');
    await assert.rejects(store.create(1, body(), version), error => error.status === 403);
    await pool.query('UPDATE providers SET created_by=NULL');

    const creation = body();
    const duplicates = await Promise.all([store.create(1, creation, version), store.create(1, creation, version)]);
    assert.equal(duplicates[0].id, duplicates[1].id);
    const job = duplicates[0];
    assert.equal(JSON.stringify(job.target).includes('top-secret'), false);
    await assert.rejects(store.get(2, job.id), error => error.status === 404);
    await assert.rejects(store.cancel(2, job.id), error => error.status === 404);
    await assert.rejects(store.create(1, { ...creation, model_id: 'another' }, version), error => error.status === 409);
    await store.claim(job.id);
    assert.equal(await store.claim(job.id), undefined);
    const initialBalance = Number((await pool.query('SELECT balance FROM users WHERE id=1')).rows[0].balance);
    const reserved = await store.reserve(job.id, 1, 100);
    assert.equal(reserved.key, 'top-secret');
    assert.equal(await store.reserve(job.id, 2, 100), null);
    assert.equal(await store.markSent(job.id, 1), true);
    assert.equal(await store.markSent(job.id, 1), false);
    const diagnostic = { usage: { promptTokens: 100, completionTokens: 200, cachedTokens: 0 }, valid: true, number_count: 100 };
    await Promise.all([store.settle(job.id, 1, diagnostic), store.settle(job.id, 1, diagnostic)]);
    assert.equal(Number((await pool.query('SELECT balance FROM users WHERE id=1')).rows[0].balance), initialBalance - 0.0003);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM usage_records')).rows[0].count), 1);
    assert.equal(Number((await pool.query('SELECT SUM(count) AS count FROM quota_data')).rows[0].count), 1);
    await store.reserve(job.id, 2, 100);
    await store.markSent(job.id, 2);
    await store.settle(job.id, 2, { usage: { promptTokens: 379, completionTokens: 200, cachedTokens: 0 } });
    assert.equal((await store.get(1, job.id)).probes[1].cost, 0.000579);
    assert.equal(Number((await pool.query('SELECT balance FROM users WHERE id=1')).rows[0].balance), initialBalance - 0.000879);
    await store.reserve(job.id, 3, 100);
    await store.markSent(job.id, 3);
    await store.recover();
    const interrupted = await store.get(1, job.id);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.attempted, 3);
    assert.equal(interrupted.valid_outputs, 1);
    assert.equal(interrupted.usage_unknown, true);
    const balanceAfterRecover = Number((await pool.query('SELECT balance FROM users WHERE id=1')).rows[0].balance);
    await store.recover();
    assert.equal(Number((await pool.query('SELECT balance FROM users WHERE id=1')).rows[0].balance), balanceAfterRecover);
    assert.equal((await store.list(1, 1, 10)).jobs.length, 1);
    assert.equal((await store.list(2, 1, 10)).jobs.length, 0);

    async function resetLimits() { await pool.query("UPDATE model_trace_jobs SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 minutes'"); }
    await resetLimits();
    const queued = await store.create(1, { ...body(), parent_job_id: job.id }, version);
    await store.cancel(1, queued.id);
    assert.equal((await store.get(1, queued.id)).status, 'canceled');
    assert.equal(await store.claim(queued.id), undefined);
    await resetLimits();
    const revoked = await store.create(1, body(), version);
    await store.claim(revoked.id);
    await pool.query('UPDATE team_models SET enabled=FALSE');
    await assert.rejects(store.reserve(revoked.id, 1, 100), error => error.status === 403);
    await pool.query('UPDATE team_models SET enabled=TRUE');
    await pool.query("UPDATE providers SET api_key='new-secret'");
    await assert.rejects(store.reserve(revoked.id, 1, 100), error => error.status === 403);
    await pool.query("UPDATE providers SET api_key='top-secret'");
    await store.finish(revoked.id, 'failed');

    await pool.query(`UPDATE teams SET quota_rules='[{"rule_type":"requests","rule_value":100,"duration_hours":24}]' WHERE id=1`);
    const covered = await store.create(3, body(), version);
    await store.claim(covered.id);
    await store.reserve(covered.id, 1, 100);
    await store.markSent(covered.id, 1);
    await store.settle(covered.id, 1, diagnostic);
    assert.equal((await store.get(3, covered.id)).cost, 0);
    await store.finish(covered.id, 'partial');
    await pool.query(`UPDATE teams SET quota_rules='[{"rule_type":"requests","rule_value":1,"duration_hours":24}]' WHERE id=1`);
    await assert.rejects(store.create(3, body(), version), error => error.status === 402);
    await pool.query("UPDATE teams SET quota_rules='[]'");

    await resetLimits();
    let calls = 0;
    const transport = async options => {
      assert.equal(options.target.protocol, 'openai');
      assert.equal(options.target.upstream_model_id, 'fixed-model');
      assert.equal(options.key, 'top-secret');
      assert.ok(await options.beforeSend());
      calls++;
      return { text: Array(100).fill('2').join(' '), usage: diagnostic.usage };
    };
    const runner = createRunner({ store, loadCore, transport, score });
    runners.push(runner);
    const automatic = await store.create(1, body(), version);
    runner.enqueue(automatic.id);
    runner.enqueue(automatic.id);
    while (!runner.idle()) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 3);
    assert.equal((await store.get(1, automatic.id)).status, 'completed');
    assert.equal((await store.get(1, automatic.id)).attempted, 3);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM usage_records WHERE request_type=\'model_trace\'')).rows[0].count), 7);
    assert.equal((await store.get(1, automatic.id)).result.model_ranking.length, 1);

    await resetLimits();
    let started;
    const onStarted = new Promise(resolve => { started = resolve; });
    const cancellationRunner = createRunner({ store, loadCore, score, transport: async options => {
      await options.beforeSend();
      started();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('top-secret upstream error')), { once: true }));
    } });
    runners.push(cancellationRunner);
    const canceled = await store.create(1, body(), version);
    cancellationRunner.enqueue(canceled.id);
    await onStarted;
    await store.cancel(1, canceled.id);
    cancellationRunner.cancel(canceled.id);
    while (!cancellationRunner.idle()) await new Promise(resolve => setTimeout(resolve, 5));
    const cancelView = await store.get(1, canceled.id);
    assert.equal(cancelView.status, 'canceled');
    assert.equal(cancelView.attempted, 1);
    assert.equal(cancelView.usage_unknown, true);
    assert.equal(JSON.stringify(cancelView).includes('top-secret'), false);

    await resetLimits();
    let failures = 0;
    const errorRunner = createRunner({ store, loadCore, score, transport: async options => {
      await options.beforeSend();
      return { text: '', usage: null, definite_rejection: true, error: `上游 HTTP ${[401, 429, 500][failures++]}` };
    } });
    runners.push(errorRunner);
    const errored = await store.create(1, body(), version);
    errorRunner.enqueue(errored.id);
    while (!errorRunner.idle()) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(failures, 1);
    const errorView = await store.get(1, errored.id);
    assert.equal(errorView.status, 'failed');
    assert.equal(errorView.usage_unknown, false);
    assert.equal(errorView.cost, 0);
    assert.deepEqual(errorView.probes.map(probe => probe.error), ['上游 HTTP 401']);

    await resetLimits();
    let partialCalls = 0;
    const partialRunner = createRunner({ store, loadCore, score, transport: async options => {
      await options.beforeSend();
      partialCalls++;
      if (partialCalls === 3) throw new Error('network disconnected secret');
      return { text: partialCalls === 1 ? Array(100).fill('2').join(' ') : 'refusal', usage: partialCalls === 1 ? diagnostic.usage : null };
    } });
    runners.push(partialRunner);
    const partial = await store.create(1, body(), version);
    partialRunner.enqueue(partial.id);
    while (!partialRunner.idle()) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await store.get(1, partial.id)).status, 'partial');
    assert.equal((await store.get(1, partial.id)).valid_outputs, 1);
    assert.equal(partialCalls, 3);

    await resetLimits();
    const timeoutRunner = createRunner({ store, loadCore, score, transport: async options => {
      await options.beforeSend();
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) return reject(new Error('timeout'));
        options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
    } });
    runners.push(timeoutRunner);
    const timedOut = await store.create(1, body(), version);
    await pool.query(`UPDATE model_trace_jobs SET target=jsonb_set(target,'{timeout_ms}','10') WHERE id=$1`, [timedOut.id]);
    timeoutRunner.enqueue(timedOut.id);
    while (!timeoutRunner.idle()) await new Promise(resolve => setTimeout(resolve, 5));
    const timeoutView = await store.get(1, timedOut.id);
    assert.equal(timeoutView.status, 'interrupted');
    assert.equal(timeoutView.attempted, 1);
    assert.equal(timeoutView.usage_unknown, true);

    for (const protocol of ['openai', 'anthropic', 'responses']) {
      const spec = requestSpec({ protocol, upstream_model_id: 'fixed', max_output_tokens: 4096 }, 'challenge', 'secret');
      assert.equal(spec.body.model, 'fixed');
      assert.equal(spec.body.stream, false);
      assert.equal('tools' in spec.body, false);
      const data = protocol === 'anthropic' ? { content: [{ text: 'abc' }], usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2 } }
        : protocol === 'responses' ? { output: [{ content: [{ text: 'abc' }] }], usage: { input_tokens: 3, output_tokens: 4 } }
          : { choices: [{ message: { content: 'abc' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
      assert.equal(parseResponse(data, protocol).text, 'abc');
      assert.equal(parseResponse(data, protocol).usage.completionTokens, 4);
      assert.equal(parseResponse({}, protocol).usage, null);
    }
    assert.equal(parseResponse({ usage: { prompt_tokens: -1, completion_tokens: 3 } }, 'openai').usage, null);

    let httpCalls = 0;
    router = createRouter({ pool, getKeys: keys, loadCore, loadBank, score, transport: async options => { httpCalls++; return transport(options); } });
    await router.initialize();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { id: Number(req.headers['test-user'] || 1) }, csrfToken: 'test-csrf' }; next(); });
    app.use('/api/user/model-trace', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${server.address().port}/api/user/model-trace`;
    const response = await fetch(`${root}/targets`);
    const targetView = await response.json();
    assert.equal(JSON.stringify(targetView).includes('top-secret'), false);
    assert.equal(targetView.targets[0].keys.length, 1);
    for (const path of ['/bank', '/jobs', `/jobs/${automatic.id}`]) assert.equal((await fetch(root + path)).status, 200);
    assert.equal(httpCalls, 0);
    assert.equal((await fetch(`${root}/jobs/${automatic.id}`, { headers: { 'test-user': '2' } })).status, 404);
    assert.equal((await fetch(`${root}/jobs/not-a-uuid`)).status, 404);
    assert.equal((await fetch(`${root}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) })).status, 403);
    assert.equal((await fetch(`${root}/jobs`, { method: 'POST', headers: { Authorization: 'Bearer bogus', 'X-CSRF-Token': 'test-csrf' } })).status, 403);
    assert.equal(httpCalls, 0);
    console.log('PASS ModelTrace isolated PostgreSQL: migration replay, ownership/Team/admin boundaries, enabled fixed Key, explicit reads, CSRF, idempotency, locked reservation/settlement, quota, history, cancellation, restart interruption, three-call budget, protocols and secret redaction.');
  } finally {
    if (router) await router.shutdown();
    await Promise.all(runners.map(runner => runner.stop()));
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
