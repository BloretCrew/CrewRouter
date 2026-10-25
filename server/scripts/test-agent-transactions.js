'use strict';

// New Unix-only PostgreSQL cluster; synthetic identities and bytes only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const { claimThread, decideApproval } = require('../utils/agent-state');
const { resolveToolDecision, redactSecrets } = require('../utils/agent-tools');
const { insertImage, getImageContent, TEST_IMAGE_PNG } = require('../utils/agent-images');
const money = require('../utils/money');
const logger = { info() {}, warn() {}, error() {} };

function load(relative, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), {
    module, setTimeout, clearTimeout,
    require(name) {
      assert(Object.hasOwn(dependencies, name), `Unexpected fixture dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

function routeFunction(name) {
  const source = fs.readFileSync(path.resolve(__dirname, '../routes/agent.js'), 'utf8');
  const start = source.indexOf(`async function ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

async function main() {
  const cluster = createIsolatedPostgres('agent-transactions');
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  // max=1 deliberately verifies that a live claim cannot exhaust this pool.
  const pool = new Pool({ ...cluster.connection, max: 1 });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY, is_admin BOOLEAN, balance NUMERIC(18,6), refund_balance NUMERIC(18,6) DEFAULT 0, team_id INTEGER, updated_at TIMESTAMP);
      INSERT INTO users(id,is_admin,balance) VALUES(1,true,10),(2,false,10);
      CREATE TABLE teams(id INTEGER PRIMARY KEY,quota_rules JSONB);
      INSERT INTO teams VALUES(1,'[{"rule_type":"requests","rule_value":1,"duration_hours":24}]');
      CREATE TABLE models(id TEXT PRIMARY KEY,enabled BOOLEAN,output_kind TEXT);
      INSERT INTO models VALUES('fixture-model',true,'chat');
      CREATE TABLE agent_threads(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),mode TEXT,model_id TEXT,title TEXT DEFAULT 'synthetic',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP);
      INSERT INTO agent_threads(id,user_id,mode,model_id,updated_at) VALUES(1,1,'manage','fixture-model',CURRENT_TIMESTAMP),(2,2,'manage','fixture-model',CURRENT_TIMESTAMP);
      CREATE TABLE agent_messages(id SERIAL PRIMARY KEY,thread_id INTEGER REFERENCES agent_threads(id),role TEXT,content TEXT,tool_calls JSONB,tool_call_id TEXT,tool_name TEXT);
      CREATE TABLE agent_approvals(id INTEGER PRIMARY KEY,thread_id INTEGER REFERENCES agent_threads(id),user_id INTEGER,tool_call_id TEXT,tool_name TEXT,arguments JSONB,status TEXT,resolved_at TIMESTAMP);
      INSERT INTO agent_approvals VALUES(1,1,1,'call-fixture','set_model_enabled','{"id":"fixture-model","enabled":false}','pending',NULL);
      CREATE TABLE usage_records(id SERIAL PRIMARY KEY,user_id INTEGER,model_id TEXT,tokens_used BIGINT,weighted_tokens NUMERIC,prompt_tokens BIGINT,completion_tokens BIGINT,cost NUMERIC(18,6),request_type TEXT,provider_id TEXT,request_source TEXT,user_agent TEXT,requested_model TEXT,resolved_model TEXT,response_model TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE agent_images(id SERIAL PRIMARY KEY,user_id INTEGER,model_id TEXT,prompt TEXT,size TEXT,mime TEXT,bytes BYTEA,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    const claim = await claimThread(pool, 1, 1);
    assert(claim);
    assert.equal((await pool.query('SELECT 1 AS alive')).rows[0].alive, 1);
    assert.equal(await claimThread(pool, 1, 1), null, 'another connection/process cannot enter the same thread');
    assert.equal(await claimThread(pool, 2, 1), null, 'foreign owner cannot claim a thread');
    await claim.release();
    const again = await claimThread(pool, 1, 1);
    assert(again);
    await again.release();
    const disconnected = await claimThread(pool, 1, 1);
    await pool.query('SELECT pg_terminate_backend($1)', [disconnected.client.processID]);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(decideApproval(pool, { threadId: 1, approvalId: 1, userId: 1,
      decision: 'allow', edition: 'team', transactionClient: disconnected.client }, resolveToolDecision));
    await disconnected.release().catch(() => {});
    assert.equal((await pool.query('SELECT status FROM agent_approvals')).rows[0].status, 'pending',
      'a lost claim connection must never fall back to another writable connection');
    const stateSource = fs.readFileSync(path.resolve(__dirname, '../routes/agent.js'), 'utf8');
    function routeBody(marker) {
      const start = stateSource.indexOf('async (req, res) => {', stateSource.indexOf(marker));
      return stateSource.slice(start, stateSource.indexOf('\n});', start) + 2);
    }
    const save = vm.runInNewContext(`(${routeFunction('saveThreadMessages')})`, { pool });
    let started;
    const runStarted = new Promise(resolve => { started = resolve; });
    let finish;
    const finishRun = new Promise(resolve => { finish = resolve; });
    const runRoute = vm.runInNewContext(`(${routeBody("router.post('/manage/runs'")})`, {
      pool, claimThread, assertHasBalance: async () => ({ ok: true }),
      loadUsableModel: async () => ({ id: 'fixture-model' }), normalizeMessage: row => row, logAgentError() {},
      continueManage: async (_req, response, { thread, messages }) => {
        started(); await finishRun; await save(thread.id, messages); response.end();
      },
    });
    const response = () => ({ statusCode: 200, headersSent: false, writableEnded: false,
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { this.writableEnded = true; } });
    const runReq = text => ({ session: { user: { id: 1 } }, body: { text, thread_id: 1, model: 'fixture-model' } });
    // The pending approval is temporarily absent to exercise the normal run.
    await pool.query("UPDATE agent_approvals SET status='denied'");
    const firstRunResponse = response();
    const firstRun = runRoute(runReq('first-run'), firstRunResponse);
    let startTimer;
    try {
      await Promise.race([runStarted, new Promise((_, reject) => {
        startTimer = setTimeout(() => reject(new Error('Synthetic run did not start')), 2000);
      })]);
      const secondResponse = response();
      await runRoute(runReq('conflicting-run'), secondResponse);
      assert.equal(secondResponse.statusCode, 409);
    } finally { clearTimeout(startTimer); finish(); await firstRun; }
    assert.deepEqual((await pool.query('SELECT content FROM agent_messages')).rows.map(row => row.content), ['first-run']);

    const writer = new Pool({ ...cluster.connection, max: 1 });
    try {
      const writerSave = vm.runInNewContext(`(${routeFunction('saveThreadMessages')})`, { pool: writer });
      let interleaved = false;
      const snapshotPool = { async connect() {
        const client = await pool.connect();
        return { async query(sql, args) {
          const result = await client.query(sql, args);
          if (!interleaved && sql.includes('FROM agent_threads WHERE id')) {
            interleaved = true;
            await writerSave(1, [{ role: 'user', content: 'new-snapshot' }]);
          }
          return result;
        }, release() { client.release(); } };
      } };
      const read = vm.runInNewContext(`(${routeBody("router.get('/manage/threads/:id'")})`, { pool: snapshotPool, normalizeMessage: row => row, logAgentError() {} });
      const readResponse = response();
      await read({ params: { id: 1 }, session: { user: { id: 1 } } }, readResponse);
      assert.equal(readResponse.statusCode, 200);
      assert.equal(readResponse.body.messages[0].content, 'first-run', 'thread reads must retain a single snapshot across replacement');
      assert.equal((await pool.query('SELECT content FROM agent_messages')).rows[0].content, 'new-snapshot');
    } finally { await writer.end(); }
    const unavailableRead = vm.runInNewContext(`(${routeBody("router.get('/manage/threads/:id'")})`, {
      pool: { async connect() { throw new Error('isolated pool failure'); } }, logAgentError() {},
    });
    const unavailableReadResponse = response();
    await unavailableRead({ params: { id: 1 }, session: { user: { id: 1 } } }, unavailableReadResponse);
    assert.equal(unavailableReadResponse.statusCode, 500, 'a failed read connection must be handled inside the route');
    await pool.query("DELETE FROM agent_messages; UPDATE agent_approvals SET status='pending'");
    const params = { threadId: 1, approvalId: 1, userId: 1, decision: 'allow', edition: 'team' };
    const resolve = async (...args) => redactSecrets(await resolveToolDecision(...args));
    await pool.query(`CREATE FUNCTION fail_approval() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'isolated approval failure'; END$$;
      CREATE TRIGGER fail_approval BEFORE UPDATE ON agent_approvals FOR EACH ROW EXECUTE FUNCTION fail_approval()`);
    await assert.rejects(decideApproval(pool, params, resolve), /isolated approval failure/);
    assert.equal((await pool.query('SELECT enabled FROM models')).rows[0].enabled, true);
    assert.equal((await pool.query('SELECT status FROM agent_approvals')).rows[0].status, 'pending');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM agent_messages')).rows[0].n, 0);
    await pool.query('DROP TRIGGER fail_approval ON agent_approvals; UPDATE users SET is_admin=false WHERE id=1');
    await assert.rejects(decideApproval(pool, params, resolve), /管理员权限已撤销/);
    await pool.query('UPDATE users SET is_admin=true WHERE id=1');
    const parallel = new Pool({ ...cluster.connection, max: 1 });
    try {
      const decisions = await Promise.all([decideApproval(pool, params, resolve), decideApproval(parallel, { ...params, decision: 'deny' }, resolve)]);
      assert.equal(decisions.filter(Boolean).length, 1, 'approval can be consumed only once');
    } finally { await parallel.end(); }
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM agent_messages')).rows[0].n, 1);
    assert.equal(await decideApproval(pool, params, resolve), null);

    const points = load('utils/points-deduct.js', {
      '../models/database': { pool }, './quota-data': { getUserQuotaBuffer: () => [] }, './money': money,
    });
    const balance = load('utils/balance.js', {
      '../models/database': { pool }, '../logger': logger, './money': money, './points-deduct': points,
    });
    let captureFailure = false;
    let captures = 0;
    const billing = load('utils/agent-billing.js', {
      '../models/database': { pool }, '../logger': logger,
      './billing': { calculateCost: () => ({ weightedTokens: 7000000, pointsCost: 7 }) },
      './request-source': { clientMetaFromReq: () => ({}) }, './balance': balance,
      './quota-request-context': { async linkUsage() { captures++; if (captureFailure) throw new Error('isolated capture failure'); } },
    });
    const usage = { userId: 1, modelConfig: { id: 'fixture-model' }, requestType: 'imagine',
      identity: { requested_model: 'fixture-requested', resolved_model: 'fixture-resolved', response_model: 'fixture-response' } };
    const persist = client => insertImage(client, { userId: 1, modelId: 'fixture-model', prompt: 'synthetic', size: '1x1', bytes: TEST_IMAGE_PNG });
    const billed = await Promise.allSettled([billing.recordAgentUsage({ ...usage, persist }), billing.recordAgentUsage({ ...usage, persist })]);
    assert.equal(billed.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await pool.query('SELECT balance::text FROM users WHERE id=1')).rows[0].balance, '3.000000');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM usage_records')).rows[0].n, 1);
    assert.deepEqual((await pool.query('SELECT requested_model,resolved_model,response_model FROM usage_records')).rows[0],
      { requested_model: 'fixture-requested', resolved_model: 'fixture-resolved', response_model: 'fixture-response' });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM agent_images')).rows[0].n, 1);
    assert.equal(captures, 1);
    assert.equal(await getImageContent(pool, 1, 2), null);
    await pool.query('UPDATE users SET balance=10 WHERE id=1');
    await assert.rejects(billing.recordAgentUsage({ ...usage, persist: async client => {
      await persist(client); throw new Error('isolated persistence failure');
    } }), /isolated persistence failure/);
    assert.equal((await pool.query('SELECT balance::text FROM users WHERE id=1')).rows[0].balance, '10.000000');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM usage_records')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM agent_images')).rows[0].n, 1);
    captureFailure = true;
    assert.equal(await billing.recordAgentUsage(usage), 7, 'capture failure after commit cannot turn a charged request into failure');
    captureFailure = false;
    await pool.query('TRUNCATE usage_records; UPDATE users SET balance=10,team_id=1 WHERE id=1');
    const quota = await Promise.all([billing.recordAgentUsage(usage), billing.recordAgentUsage(usage)]);
    assert.deepEqual(quota.sort(), [0, 7], 'request limit=1 covers the first request; only the next request is charged');
    assert.equal((await pool.query('SELECT balance::text FROM users WHERE id=1')).rows[0].balance, '3.000000');
    await pool.query(`TRUNCATE usage_records; UPDATE users SET balance=10 WHERE id=1;
      UPDATE teams SET quota_rules='[{"rule_type":"tokens","rule_value":7000000,"duration_hours":24}]'`);
    const tokenQuota = await Promise.all([billing.recordAgentUsage(usage), billing.recordAgentUsage(usage)]);
    assert.deepEqual(tokenQuota.sort(), [0, 7], 'tokens exactly reaching the limit cover that request, then charge the next');
    assert.equal((await pool.query('SELECT balance::text FROM users WHERE id=1')).rows[0].balance, '3.000000');

    // Use the real continuation/persistence code; no model/network dependency.
    const events = [];
    const context = { pool, normalizeModel: value => value, logAgentError() {}, redactError: value => value,
      beginSse: () => event => events.push(event.type), loadPersistedEdition: async () => 'team',
      runManageLoop: async ({ modelCaller }) => { await modelCaller([]); return { status: 'completed', messages: [{ role: 'assistant', content: 'synthetic' }], content: 'synthetic' }; },
      callManageModel: async () => ({ usage: { prompt_tokens: 1 } }), executeTool() { throw new Error('No tool execution expected'); },
      recordAgentUsage: billing.recordAgentUsage };
    vm.createContext(context);
    vm.runInContext(`${routeFunction('saveThreadMessages')}\n${routeFunction('continueManage')}\nthis.run = continueManage`, context);
    await pool.query('UPDATE users SET balance=0,team_id=NULL WHERE id=1');
    const res = { writableEnded: false, end() { this.writableEnded = true; } };
    await context.run({ session: { user: { id: 1 } }, body: { model: 'fixture-model' } }, res,
      { thread: { id: 1 }, messages: [], model: { id: 'fixture-model' } });
    assert(events.includes('run.failed'));
    assert(!events.includes('run.completed'), 'never announce completion before a successful debit');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM agent_messages')).rows[0].n, 1, 'failed billing cannot replace committed tool history');
    await pool.query('UPDATE users SET balance=10 WHERE id=1');
    let completionBalance;
    context.beginSse = () => event => {
      if (event.type === 'run.completed') completionBalance = pool.query('SELECT balance::text FROM users WHERE id=1');
    };
    const successClaim = await claimThread(pool, 1, 1);
    try {
      await context.run({ session: { user: { id: 1 } }, body: { model: 'fixture-model' } },
        { writableEnded: false, end() { this.writableEnded = true; } },
        { thread: { id: 1 }, messages: [], model: { id: 'fixture-model' }, claim: successClaim });
    } finally { await successClaim.release(); }
    assert(completionBalance, 'successful committed runs announce completion');
    assert.equal((await completionBalance).rows[0].balance, '3.000000', 'completion observers already see the committed debit');

    await pool.query(`INSERT INTO agent_approvals VALUES(2,1,1,'call-after-commit','set_model_enabled','{"id":"fixture-model","enabled":true}','pending',NULL)`);
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/agent.js'), 'utf8');
    const routeStart = routeSource.indexOf('async (req, res) => {', routeSource.indexOf("router.post('/manage/approvals/:id'"));
    const routeEnd = routeSource.indexOf('\n});', routeStart);
    let resumed = false;
    const approvalContext = {
      pool, claimThread, decideApproval, resolveToolDecision, redactSecrets,
      loadUsableModel: async () => ({ id: 'fixture-model' }), normalizeMessage: value => value,
      loadPersistedEdition: async () => 'team', ACTIONS: {},
      logAction: async () => { throw new Error('isolated audit failure'); }, logAgentError() {},
      continueManage: async (_req, response, { messages }) => {
        assert(messages.some(message => message.tool_call_id === 'call-after-commit'));
        resumed = true; response.end();
      },
    };
    const approvalRoute = vm.runInNewContext(`(${routeSource.slice(routeStart, routeEnd + 2)})`, approvalContext);
    const approvalResponse = { statusCode: 200, headersSent: false, writableEnded: false,
      status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; },
      end() { this.writableEnded = true; } };
    await approvalRoute({ params: { id: 2 }, body: { decision: 'allow' }, session: { user: { id: 1 } }, get: () => '' }, approvalResponse);
    assert.equal(approvalResponse.statusCode, 200, 'post-commit audit failures cannot make an applied decision appear rejected');
    assert(resumed);
    assert.equal((await pool.query('SELECT status FROM agent_approvals WHERE id=2')).rows[0].status, 'approved');
    assert.equal((await pool.query('SELECT enabled FROM models')).rows[0].enabled, true);
    await pool.query(`INSERT INTO agent_approvals VALUES(3,1,1,'call-resume-failure','set_model_enabled','{"id":"fixture-model","enabled":false}','pending',NULL)`);
    const readFailurePool = { options: pool.options, connect: () => pool.connect(), async query(sql, args) {
      if (sql.includes('SELECT role, content, tool_calls')) throw new Error('isolated post-commit read failure');
      return pool.query(sql, args);
    } };
    const resumeFailure = vm.runInNewContext(`(${routeSource.slice(routeStart, routeEnd + 2)})`, { ...approvalContext, pool: readFailurePool });
    const failedResponse = response();
    const retryRequest = { params: { id: 3 }, body: { decision: 'allow' }, session: { user: { id: 1 } }, get: () => '' };
    await resumeFailure(retryRequest, failedResponse);
    assert.equal(failedResponse.statusCode, 503);
    assert.equal(failedResponse.body.approval_applied, true);
    assert.equal(failedResponse.body.status, 'approved');
    assert.equal((await pool.query('SELECT status FROM agent_approvals WHERE id=3')).rows[0].status, 'approved');
    assert.equal((await pool.query('SELECT enabled FROM models')).rows[0].enabled, false);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM agent_messages WHERE tool_call_id='call-resume-failure'")).rows[0].n, 1);
    const retryResponse = response();
    await resumeFailure(retryRequest, retryResponse);
    assert.equal(retryResponse.statusCode, 404, 'retry cannot consume the committed approval again');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM agent_messages WHERE tool_call_id='call-resume-failure'")).rows[0].n, 1);
    console.log('Agent transactions: claims with pool max=1, owner isolation, atomic approval/permissions, concurrent billing/quota, image rollback and completion ordering passed');
  } finally {
    try { await pool.end(); }
    finally {
      cluster.stop();
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
      assert.equal(fs.existsSync(cluster.dataDir), false);
      assert.equal(fs.existsSync(cluster.socketDir), false);
      console.log('Agent transactions: pool closed, postmaster gone, temporary data and sockets removed');
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
