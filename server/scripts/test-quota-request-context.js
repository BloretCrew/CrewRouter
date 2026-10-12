'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const http = require('node:http');
const { EventEmitter } = require('node:events');

function harness({ realIdentity = false } = {}) {
  const begins = [];
  const ends = [];
  const module = { exports: {} };
  const capture = {
    async beginAttempt(context, provider, key) {
      const id = String(begins.length + 1);
      begins.push({ id, context, provider: provider.id, key });
      return id;
    },
    async endAttempt(id, metadata) { ends.push({ id, ...metadata }); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/quota-request-context'), 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout, globalThis, TextDecoder, TextEncoder, Date, AbortController, ReadableStream,
    require(name) {
      if (name === './request-quota-capture') return capture;
      if (name === './money') return require('../utils/money');
      if (name === '../models/database') return { pool: { async query() {} } };
      if (name === './billing') return require('../utils/billing');
      if (name === './request-lifecycle') return require('../utils/request-lifecycle');
      if (name === '../logger') return { info() {}, warn() {} };
      if (name === './request-source') return { clientMetaFromReq: () => ({ requestSource: 'test' }) };
      if (name === './session-identity' && realIdentity) return require('../utils/session-identity');
      if (name === './session-identity') return { extractRequestIdentity: () => ({ project: 'project', sessionId: 'session' }) };
      return require(name);
    }
  });
  return { ...module.exports, begins, ends, capture };
}

const provider = { id: 'provider', quota_enabled: true, api_key: 'default' };
function options(key, extra = {}) {
  return { quotaProvider: provider, quotaKey: key, body: JSON.stringify({ model: 'actual-model', stream: true }), ...extra };
}

async function mockServer(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/retry') { res.writeHead(429); res.end('limited'); return; }
    if (req.url === '/json') { res.end(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } })); return; }
    if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Length': 1000 }); res.write('partial');
      setTimeout(() => res.destroy(), 20); return;
    }
    if (req.url === '/unknown') { res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n');
    const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 100);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP body EOF, cancel, actual key fallback and billing isolation', async t => {
  const h = harness();
  const base = await mockServer(t);
  const state = { id: 'logical', req: { apiUser: { userId: 9, keyId: 11 }, body: { model: 'requested' } }, attempts: [], skips: [] };
  await h.storage.run(state, async () => {
    const rejected = await h.quotaFetch(`${base}/retry`, options('key-A', { body: undefined }));
    await rejected.text();
    const success = await h.quotaFetch(`${base}/json`, options('key-B', { body: undefined }));
    assert.equal(h.ends.filter(e => e.id === '2').length, 0, 'headers are not terminal');
    await success.json();
    await h.linkUsage({ id: 42, points: 5, weightedTokens: 7 });
    assert.equal(h.begins[0].key, 'key-A');
    assert.equal(h.begins[1].key, 'key-B');
    assert.equal(h.begins[1].context.user_id, 9);
    assert.equal(h.ends.find(e => e.id === '1').status, 'rejected');
    assert.equal(h.ends.some(e => e.id === '1' && e.usage_record_id), false);
    assert.equal(h.ends.at(-1).usage_record_id, 42);
    assert.equal(h.ends.at(-1).input_tokens, 3);
    const stream = await h.quotaFetch(`${base}/stream`, options('key-C', { body: undefined }));
    const reader = stream.body.getReader();
    await reader.read();
    assert.equal(h.ends.some(e => e.id === '3'), false);
    await reader.cancel();
    assert.equal(h.ends.at(-1).status, 'cancelled');
    assert.equal(h.ends.at(-1).usage_quality, 'actual');
    const unknown = await h.quotaFetch(`${base}/unknown`, options('key-D', { body: undefined }));
    await unknown.json();
    assert.equal(h.ends.at(-1).usage_quality, 'unknown');
    assert.equal(h.ends.at(-1).total_tokens, undefined);
    const complete = await h.quotaFetch(`${base}/stream`, options('key-E', { body: undefined }));
    const r = complete.body.getReader();
    while (!(await r.read()).done) { /* Consume the real upstream body. */ }
    assert.equal(h.ends.at(-1).status, 'success');
  });
});

test('network failure, timeout, abort before send and non-LLM exclusion', async () => {
  const h = harness();
  const state = { id: 'logical', attempts: [], skips: [] };
  await h.storage.run(state, async () => {
    await assert.rejects(h.quotaFetch('mock', options('key'), async () => { throw new Error('secret must not persist'); }));
    assert.equal(h.ends.at(-1).status, 'failed');
    assert.equal(JSON.stringify(h.ends).includes('secret'), false);
    const error = new Error('timeout'); error.name = 'TimeoutError';
    await assert.rejects(h.quotaFetch('mock', options('key2'), async () => { throw error; }));
    assert.equal(h.ends.at(-1).status, 'timeout');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.quotaFetch('mock', options('key3', { signal: controller.signal }), async () => { throw controller.signal.reason; }));
    assert.equal(h.begins.length, 2);
    assert.equal(state.skips[0].reason, 'aborted_before_upstream');
    await h.quotaFetch('not-llm', {}, async () => new Response('{}'));
    assert.equal(h.begins.length, 2);
  });
});

test('concurrent request identity isolation and fail-open persistence', async () => {
  const h = harness();
  await Promise.all([1, 2].map(userId => h.storage.run({ id: String(userId), req: { apiUser: { userId } }, attempts: [], skips: [] }, async () => {
    const r = await h.quotaFetch('mock', options(String(userId)), async () => {
      await new Promise(resolve => setTimeout(resolve, userId === 1 ? 10 : 1));
      return new Response('{"usage":{"prompt_tokens":1,"completion_tokens":2}}');
    });
    await r.json();
    await h.linkUsage({ id: userId * 10 });
  })));
  for (const begin of h.begins) {
    assert.equal(h.ends.find(e => e.id === begin.id && e.usage_record_id)?.usage_record_id, begin.context.user_id * 10);
  }
  h.capture.beginAttempt = async () => { throw new Error('DB unavailable'); };
  assert.deepEqual(await (await h.quotaFetch('mock', options('key'), async () => new Response('{}'))).json(), {});
});

test('multi-round billing links each actual usage without copying aggregate tokens or duplicating cost', async () => {
  const h = harness();
  await h.storage.run({ id: 'agent', attempts: [], skips: [] }, async () => {
    const attempts = [];
    for (const tokens of [2, 9]) {
      const r = await h.quotaFetch('mock', options('key'), async () => new Response(JSON.stringify({ usage: { prompt_tokens: tokens, completion_tokens: 1 } })));
      await r.json(); attempts.push(r.quotaAttempt);
    }
    await h.linkUsage({ id: 50, points: 100, weightedTokens: 13, attempts });
    const links = h.ends.filter(e => e.usage_record_id === 50);
    assert.deepEqual(links.map(e => e.input_tokens), [2, 9]);
    assert.deepEqual(links.map(e => e.weighted_tokens), [3, 10]);
    assert.equal(links.reduce((sum, e) => sum + Number(e.points), 0), 100);
  });
});

test('authentication rejection and no upstream requests record skip facts', () => {
  const h = harness();
  const req = {};
  const res = new EventEmitter(); res.statusCode = 401;
  h.requestMiddleware(req, res, () => {});
  res.emit('finish'); res.emit('close');
  assert.equal(req._quotaRequestContext.skips.length, 1);
  assert.equal(req._quotaRequestContext.skips[0].reason, 'rejected_before_upstream');
});


test('HTTP truncated body and cancellation after headers terminate the actual attempt', async t => {
  const h = harness();
  const base = await mockServer(t);
  const broken = await h.quotaFetch(`${base}/truncated`, options('key-A', { body: undefined }));
  await assert.rejects(broken.text());
  assert.equal(h.ends.at(-1).status, 'failed');
  const controller = new AbortController();
  const stream = await h.quotaFetch(`${base}/stream`, options('key-B', { body: undefined, signal: controller.signal }));
  const reader = stream.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read());
  assert.equal(h.ends.at(-1).status, 'cancelled');
  assert.equal(h.ends.at(-1).input_tokens, 3);
});

test('all API transport calls explicitly bind the selected provider and key', () => {
  const source = fs.readFileSync(require.resolve('../routes/api'), 'utf8');
  const direct = [...source.matchAll(/await fetchWithModelIdentity\(url, \{([\s\S]*?)\}\);/g)];
  assert.equal(direct.length, 5);
  assert.equal(direct.every(match => match[1].includes('quotaProvider: providerWithKey, quotaKey: providerWithKey.api_key')), true);
  assert.match(source, /fetchWithModelIdentity\(fetchOpts.url, \{[^\n]*quotaProvider: provider, quotaKey: provider.api_key/);
  const fusion = fs.readFileSync(require.resolve('../fusion/index'), 'utf8');
  assert.equal((fusion.match(/quotaProvider: provider,/g) || []).length, 2);
  assert.equal((fusion.match(/quotaKey: provider.api_key/g) || []).length, 2);
  for (const file of ['../routes/agent', '../routes/playground', '../fusion/synthesizer']) {
    const code = fs.readFileSync(require.resolve(file), 'utf8');
    assert.equal(/await fetch\(url/.test(code), false);
    assert.match(code, /quotaFetch\(url/);
  }
});

test('all buffered and stream consumers terminate without eager body reads', async () => {
  const h = harness();
  for (const method of ['arrayBuffer', 'blob', 'formData']) {
    const response = method === 'formData' ? new Response('a=b', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      : new Response('{"usage":{"prompt_tokens":2,"completion_tokens":1}}');
    const r = await h.quotaFetch('mock', options('key'), async () => response);
    await r[method]();
    assert.equal(h.ends.at(-1).status, 'success');
  }
  for (const method of ['iterate', 'pipeTo', 'pipeThrough', 'tee']) {
    let reads = 0;
    const response = new Response(new ReadableStream({ pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode('data: {"usage":\n' + 'data: {"prompt_tokens":2,"completion_tokens":3}}\n\n'));
      controller.close();
    } }, { highWaterMark: 0 }));
    const r = await h.quotaFetch('mock', options('key'), async () => response);
    assert.equal(reads, 0);
    if (method === 'iterate') for await (const chunk of r.body) assert.ok(chunk.length);
    if (method === 'pipeTo') await r.body.pipeTo(new WritableStream({ write() {} }));
    if (method === 'pipeThrough') for await (const chunk of r.body.pipeThrough(new TransformStream())) assert.ok(chunk.length);
    if (method === 'tee') await Promise.all(r.body.tee().map(async branch => { for await (const chunk of branch) assert.ok(chunk.length); }));
    assert.equal(h.ends.at(-1).status, 'success');
    assert.equal(h.ends.at(-1).total_tokens, 5);
  }
});

test('duplicate terminal callbacks are serialized and usage corrections are retained', async () => {
  const h = harness();
  let active = 0;
  let peak = 0;
  const persist = h.capture.endAttempt;
  h.capture.endAttempt = async (id, metadata) => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    await persist(id, metadata); active--;
  };
  const r = await h.quotaFetch('mock', options('key'), async (_url, init) => {
    init.quotaOnTerminal('failed', new Error('private error'));
    init.quotaOnTerminal('failed', new Error('private error'));
    return new Response('{"usage":{"prompt_tokens":2,"completion_tokens":3}}');
  });
  await r.json();
  assert.equal(peak, 1);
  assert.equal(h.ends.length, 2);
  assert.equal(h.ends.at(-1).status, 'failed');
  assert.equal(h.ends.at(-1).total_tokens, 5);
});

test('unknown usage receives estimated residual billing with exact cost conservation', async () => {
  const h = harness();
  const attempts = [];
  for (const body of ['{"usage":{"prompt_tokens":3,"completion_tokens":1}}', '{}', '{}']) {
    const r = await h.quotaFetch('mock', options('key'), async () => new Response(body));
    await r.json(); attempts.push(r.quotaAttempt);
  }
  await h.linkUsage({ id: 77, attempts, weightedTokens: 10, points: '0.000007' });
  const links = h.ends.filter(row => row.usage_record_id === 77);
  assert.deepEqual(links.map(row => row.weighted_tokens), [4, 3, 3]);
  assert.deepEqual(links.map(row => row.usage_quality), ['actual', 'estimated', 'estimated']);
  const { toMoneyMicros } = require('../utils/money');
  assert.equal(links.reduce((sum, row) => sum + toMoneyMicros(row.points), 0n), 7n);
});

test('real identity project/cwd snapshot and no-upstream persistence read final auth user', async () => {
  const h = harness();
  const rows = [];
  const db = { async query(sql, params) { rows.push({ sql, params }); } };
  const req = { apiUser: { userId: 9, teamId: 8, keyId: 7 } };
  await h.persistLogicalRequest({ id: 'logical', req, skips: [{ reason: 'cache_hit' }], startedAt: new Date() }, { statusCode: 200 }, db);
  assert.deepEqual(Array.from(rows[0].params).slice(1, 7), [9, 8, 7, 'project', 'session', 'test']);
  assert.equal(rows[0].params[10], 'cache_hit');
  const real = harness({ realIdentity: true });
  await real.persistLogicalRequest({ id: 'logical', req: { body: { cwd: '/workspace/project' }, headers: { 'x-session-id': 'session' } }, skips: [], startedAt: new Date() }, { statusCode: 200 }, db);
  assert.equal(rows[1].params[4], '/workspace/project');
  const identity = require('../utils/session-identity').extractRequestIdentity({ body: { cwd: '/workspace/project' }, headers: { 'x-session-id': 'session' } });
  assert.equal(identity.cwd, '/workspace/project');
  assert.equal(identity.sessionId, 'session');
});

test('logical request schema is idempotent in isolated PostgreSQL', { skip: !process.env.QUOTA_TEST_DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const url = new URL(process.env.QUOTA_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.startsWith('/crewrouter_quota_test'));
  const admin = new Pool({ connectionString: url.toString() });
  const schema = `network_logical_${process.pid}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
  try {
    const h = harness();
    await h.ensureLogicalRequestSchema(db);
    await h.ensureLogicalRequestSchema(db);
    const id = require('node:crypto').randomUUID();
    const state = { id, req: { apiUser: { userId: 5, teamId: 6, keyId: 7 } }, startedAt: new Date(), skips: [{ reason: 'rejected_before_upstream' }] };
    await h.persistLogicalRequest(state, { statusCode: 401 }, db);
    await h.persistLogicalRequest(state, { statusCode: 401 }, db);
    const result = await db.query('SELECT * FROM quota_logical_requests');
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].user_id, 5);
    assert.equal(result.rows[0].skip_reason, 'rejected_before_upstream');
    assert.equal(result.rows[0].status, 'rejected');
  } finally {
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});


test('HTTP iteration, pipe, buffered consumption and protocol failure preserve terminal facts', async t => {
  const h = harness();
  const base = await mockServer(t);
  for (const method of ['arrayBuffer', 'blob', 'iterate', 'pipeTo']) {
    const stream = method === 'iterate' || method === 'pipeTo';
    const r = await h.quotaFetch(`${base}/${stream ? 'stream' : 'json'}`, options('key', { body: undefined }));
    if (method === 'iterate') for await (const chunk of r.body) assert.ok(chunk.length);
    else if (method === 'pipeTo') await r.body.pipeTo(new WritableStream({ write() {} }));
    else await r[method]();
    assert.equal(h.ends.at(-1).status, 'success');
    assert.equal(h.ends.at(-1).total_tokens, 7);
  }
  const failed = await h.quotaFetch('mock', options('key'), async () => new Response('data: {"type":"response.failed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'));
  for await (const chunk of failed.body) assert.ok(chunk.length);
  assert.equal(h.ends.at(-1).status, 'failed');
  assert.equal(h.ends.at(-1).error_class, 'protocol_error');
  assert.equal(h.ends.at(-1).total_tokens, 3);
});

test('finish persistence is asynchronous, once-only and uses authentication set after middleware', async () => {
  const h = harness();
  const req = new EventEmitter();
  const res = new EventEmitter(); res.statusCode = 403;
  h.requestMiddleware(req, res, () => {});
  req.apiUser = { userId: 14, teamId: 15, keyId: 16 };
  res.emit('finish'); res.emit('close');
  await req._quotaRequestContext.persisted;
  assert.equal(req._quotaRequestContext.skips.length, 1);
  assert.equal(req._quotaRequestContext.signal.aborted, false);
});

function balanceHarness(db, linkUsage) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/balance'), 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(name) {
      if (name === '../models/database') return { pool: { async query() { return { rows: [] }; } } };
      if (name === '../logger') return { info() {}, warn() {}, error() {} };
      if (name === './money') return require('../utils/money');
      if (name === './points-deduct') return { async calculatePointsToDeduct({ pointsCost }) { return pointsCost; } };
      if (name === './quota-request-context') return { linkUsage, storage: { getStore() {} } };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return args => module.exports.recordUsageAndDeduct({ pool: db, userId: 1, usageQuery: 'INSERT usage', usageValues: ['chat'], pointsToDeduct: 2, pointsCost: 2, ...args });
}

async function within(promise, ms = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('billing/capture connection deadlock')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test('billing releases max1 connection before capture and capture failure never rolls back committed debit', async () => {
  let held = false;
  let balance = 10;
  let deductions = 0;
  let commits = 0;
  let rollbacks = 0;
  let links = 0;
  const db = { async connect() {
    assert.equal(held, false, 'capture must not connect while billing holds the only client');
    held = true;
    let saved;
    return {
      async query(sql, values) {
        if (sql === 'BEGIN') saved = balance;
        if (sql === 'COMMIT') commits++;
        if (sql === 'ROLLBACK') { rollbacks++; balance = saved; }
        if (sql.startsWith('SELECT balance')) return { rows: [{ balance, team_id: null }] };
        if (sql.startsWith('UPDATE users')) { balance -= Number(values[0]); deductions++; }
        return { rows: [{ id: 22 }] };
      },
      release() { held = false; }
    };
  } };
  const bill = balanceHarness(db, async () => {
    const client = await db.connect();
    try { links++; throw new Error('capture unavailable'); } finally { client.release(); }
  });
  const result = await within(bill());
  assert.equal(result.ok, true);
  assert.equal(result.id, 22);
  assert.equal(result.pointsToDeduct, 2);
  assert.equal(balance, 8);
  assert.equal(commits, 1);
  assert.equal(rollbacks, 0);
  assert.equal(links, 1);
  await assert.rejects(bill({ pointsToDeduct: 20, pointsCost: 20 }), error => error.billingFailure === true);
  assert.equal(balance, 8);
  assert.equal(deductions, 1);
  assert.equal(commits, 1);
  assert.equal(rollbacks, 1);
  assert.equal(links, 1);
  assert.equal(held, false);
});

test('PostgreSQL max1 concurrent billing and attempt correction complete with exact debit and isolated failures', { skip: !process.env.QUOTA_TEST_DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const url = new URL(process.env.QUOTA_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.startsWith('/crewrouter_quota_test'));
  const admin = new Pool({ connectionString: url.toString() });
  const schema = `network_billing_${process.pid}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 1000, options: `-c search_path=${schema}` });
  let links = 0;
  const statements = [];
  db.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (sql, ...args) => { statements.push(sql); return query(sql, ...args); };
  });
  try {
    await db.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,balance NUMERIC(20,6),team_id INTEGER,updated_at TIMESTAMPTZ);
      CREATE TABLE usage_records(id BIGSERIAL PRIMARY KEY,cost NUMERIC(20,6));
      CREATE TABLE attempts(usage_record_id BIGINT PRIMARY KEY,points NUMERIC(20,6));
      INSERT INTO users(id,balance) VALUES(1,10)`);
    const bill = balanceHarness(db, async ({ id, points }) => {
      const client = await db.connect();
      try {
        await client.query('INSERT INTO attempts VALUES($1,$2)', [id, points]);
        links++;
      } finally { client.release(); }
    });
    const args = { usageQuery: 'INSERT INTO usage_records(cost) VALUES($1) RETURNING id', usageValues: [2] };
    const results = await within(Promise.all([bill(args), bill(args)]));
    assert.equal(results.every(result => result.ok && result.pointsToDeduct === 2), true);
    assert.equal((await db.query('SELECT balance FROM users')).rows[0].balance, '6.000000');
    assert.equal((await db.query('SELECT SUM(points) AS points FROM attempts')).rows[0].points, '4.000000');
    assert.equal(links, 2);
    const failingCapture = balanceHarness(db, async () => {
      const client = await db.connect();
      try { throw new Error('capture fails after commit'); } finally { client.release(); }
    });
    const rollbackBefore = statements.filter(sql => sql === 'ROLLBACK').length;
    assert.equal((await within(failingCapture(args))).ok, true);
    assert.equal(statements.filter(sql => sql === 'ROLLBACK').length, rollbackBefore);
    assert.equal((await db.query('SELECT balance FROM users')).rows[0].balance, '4.000000');
    await assert.rejects(within(bill({ ...args, pointsCost: 100, pointsToDeduct: 100 })), error => error.billingFailure === true);
    await assert.rejects(within(bill({ ...args, usageQuery: 'INSERT INTO missing_table VALUES(1)' })), error => error.billingFailure === true);
    assert.equal((await db.query('SELECT balance FROM users')).rows[0].balance, '4.000000');
    assert.equal((await db.query('SELECT COUNT(*) AS count FROM usage_records')).rows[0].count, '3');
    assert.equal(links, 2);
    assert.equal(statements.filter(sql => sql === 'ROLLBACK').length, rollbackBefore + 2);
  } finally {
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

test('slow begin does not delay forwarding and late id receives terminal and billing updates in order', async () => {
  const h = harness();
  const begin = h.capture.beginAttempt;
  h.capture.beginAttempt = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return begin(...args);
  };
  const started = Date.now();
  let sentAt;
  const r = await h.quotaFetch('mock', options('key'), async () => {
    sentAt = Date.now();
    return new Response('{"usage":{"prompt_tokens":2,"completion_tokens":1}}');
  });
  assert.ok(sentAt - started < 1000);
  await r.json();
  await h.linkUsage({ attempt: r.quotaAttempt, id: 123, points: 2 });
  assert.ok(Date.now() - started < 1300);
  await r.quotaAttempt.persistence;
  assert.equal(h.ends.at(-1).id, h.begins[0].id);
  assert.equal(h.ends.at(-1).usage_record_id, 123);
  assert.equal(h.ends.at(-1).status, 'success');
  assert.equal(h.persistenceHealth.pending, 0);
  assert.ok(h.persistenceHealth.timedOut > 0);
});

test('pending config/end cannot block forwarding, EOF or usage linking', async () => {
  const h = harness();
  h.capture.getCaptureConfig = () => new Promise(() => {});
  h.capture.endAttempt = () => new Promise(() => {});
  let sentAt;
  const started = Date.now();
  const r = await h.quotaFetch('mock', options('key'), async () => {
    sentAt = Date.now();
    return new Response('data: [DONE]\n\n');
  });
  assert.ok(sentAt - started < 1000);
  const reader = r.body.getReader();
  await reader.read();
  const eof = Date.now();
  assert.equal((await reader.read()).done, true);
  assert.ok(Date.now() - eof < 1000);
  await within(h.linkUsage({ attempt: r.quotaAttempt, id: 5 }), 1000);
});

test('capture pending operations are capped and strict has a separate bounded budget', async () => {
  const h = harness();
  h.capture.getCaptureConfig = async () => ({ mode: 'strict' });
  const r = await h.quotaFetch('mock', options('key'), async () => new Response('{}'));
  assert.equal(r.quotaAttempt.deadline, 25000);
  await r.json();
  h.persistenceHealth.pending = 1000;
  const previous = h.begins.length;
  const skipped = await h.quotaFetch('mock', options('key'), async () => new Response('{}'));
  await skipped.json();
  assert.equal(h.begins.length, previous);
  assert.ok(h.persistenceHealth.rejected > 0);
});

test('committed billing returns within deadline even if linkUsage never resolves', async () => {
  let held = false;
  let committed = false;
  const db = { async connect() {
    held = true;
    return { async query(sql) {
      if (sql === 'COMMIT') committed = true;
      if (sql.startsWith('SELECT balance')) return { rows: [{ balance: 10 }] };
      return { rows: [{ id: 1 }] };
    }, release() { held = false; } };
  } };
  const bill = balanceHarness(db, () => new Promise(() => {}));
  const result = await within(bill(), 2000);
  assert.equal(result.ok, true);
  assert.equal(committed, true);
  assert.equal(held, false);
});

test('real rejected logical request never persists credential text in project/session', { skip: !process.env.QUOTA_TEST_DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const url = new URL(process.env.QUOTA_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.startsWith('/crewrouter_quota_test'));
  const admin = new Pool({ connectionString: url.toString() });
  const schema = `network_redaction_${process.pid}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}` });
  try {
    const h = harness({ realIdentity: true });
    await h.ensureLogicalRequestSchema(db);
    await h.persistLogicalRequest({ id: require('node:crypto').randomUUID(), startedAt: new Date(), skips: [{ reason: 'rejected_before_upstream' }],
      req: { body: { project: 'api_key=sk-review-secret' }, headers: { 'x-session-id': 'Bearer sk-review-secret' } } }, { statusCode: 401 }, db);
    const row = (await db.query('SELECT * FROM quota_logical_requests')).rows[0];
    assert.equal(JSON.stringify(row).includes('sk-review-secret'), false);
    assert.match(row.project_id, /^redacted:[a-f0-9]{64}$/);
    assert.match(row.session_id, /^redacted:[a-f0-9]{64}$/);
    assert.equal(row.status, 'rejected');
    assert.equal(h.safeText('a'.repeat(1000), 128).length, 128);
  } finally { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
