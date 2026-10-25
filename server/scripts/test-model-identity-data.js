'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ensureUsageModelIdentityColumns, MODEL_IDENTITY_COLUMNS } = require('../utils/usage-model-migration');
const filters = require('../utils/usage-logs-filter');
const { createModelIdentity, createModelIdentityStream } = require('../utils/model-identity');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const logger = { info() {}, warn() {}, error() {}, stream() {} };
const row = { id: 7, user_id: 41, requested_model: '=client', resolved_model: 'route', response_model: 'upstream', tokens_used: 12, prompt_tokens: 8, completion_tokens: 4, cost: '0.125', created_at: new Date('2026-01-01T00:00:00Z') };

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

function loadHandler(file, route, pool, extra = {}) {
  const source = read(file);
  const start = source.indexOf(`router.get('${route}',`);
  assert(start >= 0, route);
  const end = source.indexOf('\n});', start) + 4;
  let handler;
  const context = {
    router: { get(_route, ...handlers) { handler = handlers.at(-1); } },
    requireAuth() {}, requireAdmin() {}, pool, Logger: logger,
    ...filters,
    formatShanghaiDateTime: () => '2026-01-01 08:00:00',
    analyzeMessages: () => ({}),
    require: name => {
      if (name === '../utils/request-source') return { sourceLabel: value => value || 'unknown' };
      throw new Error(`Unexpected require: ${name}`);
    },
    ...extra
  };
  vm.createContext(context);
  for (const name of ['csvEscapeUser', 'csvEscape', 'customInstructionsFiles']) {
    if (source.includes(`function ${name}(`)) vm.runInContext(functionSource(source, name), context);
  }
  vm.runInContext(source.slice(start, end), context);
  return { handler, context };
}

function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; }, send(data) { this.data = data; }, setHeader(key, value) { this.headers[key] = value; } };
}

async function testReads() {
  for (const file of ['routes/user.js', 'routes/admin.js']) {
    for (const route of ['/usage-logs', '/usage-logs/:id', '/usage-logs/export']) {
      const routeSource = read(file);
      const registration = routeSource.slice(routeSource.indexOf(`router.get('${route}',`)).split('async (req, res)')[0];
      assert(registration.includes('requireAuth'));
      if (file.includes('admin')) assert(registration.includes('requireAdmin'));
      const calls = [];
      const pool = { async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] };
        for (const field of MODEL_IDENTITY_COLUMNS) assert(sql.includes(`u.${field}`));
        if (file.includes('user')) {
          assert(sql.includes('u.user_id = $'));
          assert(params.includes(41));
        }
        return { rows: [row] };
      } };
      const { handler, context } = loadHandler(file, route, pool);
      const res = response();
      await handler({ session: { user: { id: 41 } }, query: {}, params: { id: '7' } }, res);
      assert.strictEqual(res.statusCode, 200);
      if (route.endsWith('export')) {
        const lines = res.data.replace(/^\ufeff/, '').split('\n');
        assert(lines[0].endsWith('客户端请求模型,路由模型,上游响应模型'));
        assert(lines[1].endsWith("'=client,route,upstream"));
      } else {
        const actual = res.data.log || res.data.logs[0];
        for (const field of MODEL_IDENTITY_COLUMNS) assert.strictEqual(actual[field], row[field]);
        assert.strictEqual(actual.cost, row.cost);
        assert.strictEqual(actual.tokens_used, row.tokens_used);
      }
      const escape = context.csvEscapeUser || context.csvEscape;
      assert.strictEqual(escape('a,"b"\n'), '"a,""b""\n"');
      assert.strictEqual(escape(' \t=SUM(1)'), "' \t=SUM(1)");
      assert.strictEqual(escape(null), '');
      assert.strictEqual(escape(-1), '-1');
      if (route.endsWith(':id')) {
        const denied = loadHandler(file, route, { async query() { return { rows: [] }; } });
        const missing = response();
        await denied.handler({ session: { user: { id: 42 } }, query: {}, params: { id: '7' } }, missing);
        assert.strictEqual(missing.statusCode, 404);
      }
    }
  }
  for (const route of ['/trace-sessions/:publicId', '/trace-sessions/:publicId/export']) {
    let count = 0;
    const pool = { async query(sql, params) {
      count++;
      if (count === 1) {
        assert(sql.includes('user_id = $2'));
        assert.deepStrictEqual(Array.from(params), ['trace', 41]);
        return { rows: [{ id: 2 }] };
      }
      assert(sql.includes('ur.user_id = $2'));
      assert.deepStrictEqual(Array.from(params), [2, 41]);
      return { rows: [row] };
    } };
    const { handler } = loadHandler('routes/user.js', route, pool);
    const res = response();
    await handler({ session: { user: { id: 41 } }, params: { publicId: 'trace' }, query: {} }, res);
    assert.strictEqual(res.data.events[0].response_model, 'upstream');
    const denied = loadHandler('routes/user.js', route, { async query() { return { rows: [] }; } });
    const missing = response();
    await denied.handler({ session: { user: { id: 42 } }, params: { publicId: 'trace' }, query: {} }, missing);
    assert.strictEqual(missing.statusCode, 404);
  }
}

function testSessionMerging() {
  const source = read('routes/sessions-view.js');
  const context = { crypto: require('crypto'), parseMessagesToEvents: () => [{ type: 'text', role: 'user', text: 'same' }], truncStr: value => value, LIMIT_THINKING: 300, LIMIT_TEXT: 2000, MAX_EVENTS_PER_RECORD: 120 };
  vm.createContext(context);
  vm.runInContext(functionSource(source, 'buildDetailRecords'), context);
  const records = context.buildDetailRecords([row, { ...row, id: 8, response_model: 'other' }]);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].tokens, 24);
  assert.strictEqual(records[0].repeatCount, 2);
  assert.strictEqual(records[0].modelIdentities[1].response_model, 'other');
  assert.strictEqual(context.buildDetailRecords([{ id: 9 }])[0].response_model, null);
  assert(source.includes('model_id, requested_model, resolved_model, response_model'));
}

async function testIndependentWrites() {
  const source = read('routes/playground.js');
  const calls = [];
  let failFull = false;
  const context = {
    pool: { async query(sql, params) {
      if (sql.startsWith('INSERT')) {
        if (failFull && sql.includes('plugin_meta')) throw new Error('full insert failed');
        calls.push({ sql, params });
      }
      return { rows: [{ team_id: null, provider: 'provider' }] };
    } },
    Logger: logger,
    calculatePointsToDeduct: async () => 0.125,
    clientMetaFromReq: () => ({ requestSource: 'unknown', userAgent: null }),
    ...require('../utils/request-metrics'),
    recordQuotaData() {},
    require: name => {
      if (name === '../plugins/hooks') return { hasSubscribers: () => false, applyStatsRecord: async () => ({}) };
      if (name === '../utils/balance') return { deductPoints: async () => {} };
      throw new Error(name);
    }
  };
  vm.createContext(context);
  vm.runInContext(`async ${functionSource(source, 'recordUsage')}`, context);
  const identity = createModelIdentity('client', 'route');
  const stream = createModelIdentityStream(identity);
  stream.push('data: {"model":"up');
  stream.push('stream"}\r\n\r\ndata: [DONE]\n\n');
  stream.finish();
  for (const fallback of [false, true]) {
    failFull = fallback;
    await context.recordUsage(41, 'local', 12, 12, 0.125, [], 'text', { promptTokens: 8, completionTokens: 4 }, null, {}, 'stop', {}, identity.snapshot());
    const call = calls.at(-1);
    for (const field of MODEL_IDENTITY_COLUMNS) assert(call.sql.includes(field));
    assert.deepStrictEqual(Array.from(call.params.slice(-13, -10)), ['client', 'route', 'upstream']);
    assert.strictEqual(call.params[0], 41);
    assert.strictEqual(call.params[2], 12);
  }
  assert(source.indexOf('modelIdentity.observe(data)') < source.indexOf('const openaiResp ='));
  assert(source.includes('identityStream.push(value)'));
  const agent = read('routes/agent.js');
  const mockAgentFetch = async () => ({ ok: true, json: async () => ({ model: 'original', usage: {} }) });
  const ctx = {
    createModelIdentity,
    loadProvider: async () => ({ format: 'anthropic' }), keyAttempts: () => ['key'],
    upstreamUrl: () => 'https://mock.invalid/messages', validateUrl: async url => ({ ok: true, url: new URL(url) }),
    systemPrompt: () => '', anthropicTools: () => [], toAnthropicMessages: value => value,
    quotaFetch: mockAgentFetch,
    fetch: mockAgentFetch,
    parseModelResponse: () => ({ model: 'rewritten' }), extractUsage: () => ({}), AbortSignal
  };
  vm.createContext(ctx);
  vm.runInContext(`async ${functionSource(agent, 'callManageModel')}`, ctx);
  const reply = await ctx.callManageModel({ id: 'local', upstream_model_id: 'route' }, []);
  assert.strictEqual(reply.identity.response_model, 'original');
  assert.strictEqual(reply.identity.resolved_model, 'route');
  assert.strictEqual(reply.identity.requested_model, null);
  const billingSource = read('utils/agent-billing.js');
  const billingWrites = [];
  let released = false;
  const billingClient = {
    async query(sql, params) {
      if (sql.includes('INSERT INTO usage_records')) {
        billingWrites.push({ sql, params });
        return { rows: [{ id: 71 }] };
      }
      if (sql.startsWith('SELECT')) return { rows: [{ team_id: null }] };
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('UPDATE usage_records')) return { rows: [] };
      throw new Error(`Unexpected billing fixture SQL: ${sql}`);
    },
    release() { released = true; }
  };
  const billingContext = {
    pool: { connect: async () => billingClient },
    calculateCost: () => ({ weightedTokens: 12, pointsCost: 0.125 }),
    clientMetaFromReq: context.clientMetaFromReq,
    logAgentError(error) { throw error; },
    require: name => {
      if (name === './quota-request-context') return { linkUsage: async () => {} };
      if (name === './balance') return { deductPoints: async (_userId, _points, client) => {
        assert.strictEqual(client, billingClient);
        return { ok: true, pointsToDeduct: 0.125 };
      } };
      throw new Error(`Unexpected billing fixture dependency: ${name}`);
    }
  };
  vm.createContext(billingContext);
  vm.runInContext(`async ${functionSource(billingSource, 'recordAgentUsage')}`, billingContext);
  failFull = false;
  await billingContext.recordAgentUsage({ userId: 41, modelConfig: { id: 'local' }, requestType: 'agent_manage', promptTokens: 8, completionTokens: 4, identity: identity.snapshot() });
  assert.strictEqual(billingWrites.length, 1);
  assert.deepStrictEqual(Array.from(billingWrites[0].params.slice(-3)), ['client', 'route', 'upstream']);
  assert.strictEqual(billingWrites[0].params[2], 12);
  assert.strictEqual(released, true);
  assert(agent.includes('identities.every(item => item?.response_model'));
}

async function testMigrationMock() {
  let fields = ['id'];
  let alters = 0;
  const client = { async query(sql) {
    if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '15s', statement_timeout: '0' }] };
    if (sql.includes('pg_attribute')) return { rows: fields.map(column_name => ({ column_name })) };
    if (sql.startsWith('ALTER')) { alters++; fields = fields.concat(MODEL_IDENTITY_COLUMNS); }
    return { rows: [] };
  } };
  await ensureUsageModelIdentityColumns(client);
  await ensureUsageModelIdentityColumns(client);
  assert.strictEqual(alters, 1);
  assert(read('scripts/init-db.js').includes('await ensureUsageModelIdentityColumns(client)'));
  assert(read('index.js').includes("require('./utils/usage-model-migration').ensureUsageModelIdentityColumns(client)"));
}

async function testIsolatedDatabase() {
  const url = process.env.MODEL_IDENTITY_TEST_DATABASE_URL;
  if (!url) { console.log('SKIP isolated PostgreSQL: MODEL_IDENTITY_TEST_DATABASE_URL not set'); return; }
  const parsed = new URL(url);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
  assert(parsed.pathname.startsWith('/crewrouter_model_test'));
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  const blocker = new Client({ connectionString: url });
  await client.connect();
  await blocker.connect();
  const schema = `identity_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await blocker.query(`SET search_path TO ${schema}`);
    await client.query('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    await client.query('CREATE TABLE models (id VARCHAR(100) PRIMARY KEY)');
    await client.query('CREATE TABLE api_keys (id INTEGER PRIMARY KEY)');
    const createTable = read('scripts/init-db.js').match(/CREATE TABLE IF NOT EXISTS usage_records \([\s\S]*?\n      \)/)[0];
    await client.query(createTable.replace('usage_records', 'fresh_usage_records'));
    await client.query('INSERT INTO fresh_usage_records DEFAULT VALUES');
    const fresh = (await client.query('SELECT * FROM fresh_usage_records')).rows[0];
    for (const field of MODEL_IDENTITY_COLUMNS) assert.strictEqual(fresh[field], null);
    await client.query('CREATE TABLE usage_records (id SERIAL PRIMARY KEY, tokens_used INTEGER, cost NUMERIC)');
    await client.query('INSERT INTO usage_records(tokens_used,cost) VALUES (12,0.125)');
    for (let i = 0; i < 2; i++) {
      await client.query('BEGIN');
      await ensureUsageModelIdentityColumns(client);
      await client.query('COMMIT');
    }
    const historical = (await client.query('SELECT * FROM usage_records')).rows[0];
    for (const field of MODEL_IDENTITY_COLUMNS) assert.strictEqual(historical[field], null);
    assert.strictEqual(historical.tokens_used, 12);
    assert.strictEqual(historical.cost, '0.125');
    const columns = await client.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'usage_records' AND column_name = ANY($2)", [schema, MODEL_IDENTITY_COLUMNS]);
    assert.strictEqual(columns.rows.length, 3);
    for (const col of columns.rows) {
      assert.strictEqual(col.data_type, 'text');
      assert.strictEqual(col.is_nullable, 'YES');
      assert.strictEqual(col.column_default, null);
    }
    await client.query('BEGIN');
    await client.query('INSERT INTO usage_records(requested_model,resolved_model,response_model) VALUES ($1,$2,$3)', ['client', 'route', 'upstream']);
    await client.query('ROLLBACK');
    assert.strictEqual((await client.query('SELECT COUNT(*)::int AS n FROM usage_records')).rows[0].n, 1);
    await client.query('BEGIN');
    await client.query('INSERT INTO usage_records(tokens_used,cost,requested_model,resolved_model,response_model) VALUES ($1,$2,$3,$4,$5)', [12, '0.125', 'client', 'route', 'upstream']);
    await client.query('COMMIT');
    const saved = (await client.query('SELECT * FROM usage_records ORDER BY id DESC LIMIT 1')).rows[0];
    assert.strictEqual(saved.response_model, 'upstream');
    assert.strictEqual(saved.tokens_used, 12);
    assert.strictEqual(saved.cost, '0.125');
    await client.query('ALTER TABLE usage_records DROP COLUMN response_model');
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE usage_records IN ACCESS EXCLUSIVE MODE');
    await client.query('BEGIN');
    const start = Date.now();
    await assert.rejects(ensureUsageModelIdentityColumns(client), error => error.code === '55P03');
    assert(Date.now() - start < 20000);
    await client.query('ROLLBACK');
    await blocker.query('ROLLBACK');
    await client.query('BEGIN');
    await ensureUsageModelIdentityColumns(client);
    await client.query('COMMIT');
    const settings = await client.query("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout");
    assert.strictEqual(settings.rows[0].lock_timeout, '0');
    assert.strictEqual(settings.rows[0].statement_timeout, '0');
    console.log('PASS isolated PostgreSQL nullable TEXT, historical NULL, repeat migration, rollback and bounded lock wait');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await Promise.all([client.end(), blocker.end()]);
  }
}

(async () => {
  await testMigrationMock();
  await testReads();
  testSessionMerging();
  await testIndependentWrites();
  await testIsolatedDatabase();
  console.log('PASS model identity data, route handlers, CSV safety, session merging and independent writes');
})().catch(error => { console.error(error); process.exitCode = 1; });
