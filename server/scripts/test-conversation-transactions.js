'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

function loadRoutes(pool) {
  const handlers = new Map();
  const router = {};
  for (const method of ['get', 'post', 'put', 'delete']) router[method] = (route, ...callbacks) => handlers.set(`${method} ${route}`, callbacks.at(-1));
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../routes/conversations.js'), 'utf8'), {
    module: { exports: {} }, Buffer,
    require(id) {
      if (id === 'express') return { Router: () => router };
      if (id === '../models/database') return { pool };
      if (id === '../middleware/auth') return { requireAuth() {} };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return async (method, route, { id, userId = 7, messages, body = {}, msgIndex } = {}) => {
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
    await handlers.get(`${method} ${route}`)({ params: { id: String(id), msgIndex: String(msgIndex) }, session: { user: { id: userId } }, body: messages === undefined ? body : { ...body, messages } }, res);
    return res;
  };
}
function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await waiting; } };
}
function instrument(pool, intercept) {
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (sql, args) => {
        await intercept(client, sql, args);
        return client.query(sql, args);
      } };
    },
  };
}
async function observeLockWait(pool) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const waiting = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0");
    if (waiting.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a real PostgreSQL Lock wait, observed none');
}
const msg = content => ({ role: 'user', content });

async function main() {
  const cluster = createIsolatedPostgres('conversations');
  const pool = new Pool({ ...cluster.connection, max: 6, options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`
      CREATE TABLE users(id int PRIMARY KEY);
      INSERT INTO users VALUES(7),(8);
      CREATE TABLE conversations(id serial PRIMARY KEY,user_id int NOT NULL REFERENCES users(id),title varchar(255),model varchar(100),system_prompt text,temperature real,max_tokens int,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
      CREATE TABLE conversation_messages(id serial PRIMARY KEY,conversation_id int NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role varchar(20) NOT NULL,content text NOT NULL CHECK(content <> '__FAIL__'),reasoning text,meta jsonb);
    `);
    const route = loadRoutes(pool);
    const create = async (messages, body = {}) => {
      const result = await route('post', '/', { messages, body });
      assert.equal(result.statusCode, 200, JSON.stringify(result.body));
      return result.body.id;
    };
    const contents = async id => (await pool.query('SELECT content FROM conversation_messages WHERE conversation_id=$1 ORDER BY id', [id])).rows.map(row => row.content);
    const id = await create([msg('original')], { temperature: 0 });
    assert.equal((await route('get', '/:id', { id })).body.temperature, 0);
    for (const messages of [null, {}, [msg('partial'), { role: 'assistant' }], [msg('partial'), { role: 'user', content: [] }], [{ ...msg('bad'), meta: { value: '\0' } }]]) {
      const response = await route('put', '/:id/messages', { id, body: { messages } });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(await contents(id), ['original']);
    }
    assert.equal((await route('put', '/:id/messages', { id })).statusCode, 400);
    console.log('PASS invalid replacement batches preserve history, including missing messages and malformed JSON text');

    const countBefore = Number((await pool.query('SELECT count(*) FROM conversations')).rows[0].count);
    assert.equal((await route('post', '/', { messages: [msg('partial'), msg('__FAIL__')] })).statusCode, 500);
    assert.equal(Number((await pool.query('SELECT count(*) FROM conversations')).rows[0].count), countBefore);
    for (const method of ['post', 'put']) {
      assert.equal((await route(method, '/:id/messages', { id, messages: [msg('partial'), msg('__FAIL__')] })).statusCode, 500);
      assert.deepEqual(await contents(id), ['original']);
    }
    console.log('PASS database failures roll back create, append and replacement completely');

    // Writer A owns the parent row before pausing. B must really block in PG,
    // then replace all of A's batch, rather than interleave individual messages.
    const writeGate = gate();
    let paused = false;
    const writerA = loadRoutes(instrument(pool, async (_client, sql) => {
      if (!paused && sql.startsWith('DELETE FROM conversation_messages WHERE conversation_id')) { paused = true; await writeGate.wait(); }
    }));
    const first = writerA('put', '/:id/messages', { id, messages: [msg('A1'), msg('A2')] });
    await writeGate.entered;
    const second = route('put', '/:id/messages', { id, messages: [msg('B1'), msg('B2')] });
    await observeLockWait(pool);
    writeGate.release();
    assert.equal((await first).statusCode, 200);
    assert.equal((await second).statusCode, 200);
    assert.deepEqual(await contents(id), ['B1', 'B2']);
    console.log('PASS concurrent replacements show real parent-row Lock waiting and retain one complete batch');

    // A reader holding FOR SHARE sees its old parent and old messages together;
    // replacement waits until that coherent response has been assembled.
    const readGate = gate();
    let reading = false;
    const reader = loadRoutes(instrument(pool, async (_client, sql) => {
      if (!reading && sql.startsWith('SELECT role, content')) { reading = true; await readGate.wait(); }
    }));
    const read = reader('get', '/:id', { id });
    await readGate.entered;
    const replacing = route('put', '/:id/messages', { id, messages: [msg('C')] });
    await observeLockWait(pool);
    readGate.release();
    assert.deepEqual((await read).body.messages.map(row => row.content), ['B1', 'B2']);
    assert.equal((await replacing).statusCode, 200);
    assert.deepEqual(await contents(id), ['C']);
    console.log('PASS detail reads hold a parent SHARE lock across parent and message reads');

    const orderedSource = await create([msg('ordered1'), msg('ordered2'), msg('ordered3')]);
    const forkId = (await route('post', '/:id/fork', { id: orderedSource })).body.id;
    assert.deepEqual(await contents(forkId), ['ordered1', 'ordered2', 'ordered3']);
    const beforeForkFailure = Number((await pool.query('SELECT count(*) FROM conversations')).rows[0].count);
    const failedFork = loadRoutes(instrument(pool, async (client, sql) => {
      if (sql.includes('SELECT $1, role, content')) await client.query('SELECT 1/0');
    }));
    assert.equal((await failedFork('post', '/:id/fork', { id })).statusCode, 500);
    assert.equal(Number((await pool.query('SELECT count(*) FROM conversations')).rows[0].count), beforeForkFailure);
    console.log('PASS fork preserves ordered messages and copy failure leaves no empty child');

    // Fork's snapshot lock also prevents a concurrent writer from changing the
    // source between copying its metadata and its ordered message batch.
    const forkGate = gate();
    let forking = false;
    const slowFork = loadRoutes(instrument(pool, async (_client, sql) => {
      if (!forking && sql.startsWith('INSERT INTO conversations')) { forking = true; await forkGate.wait(); }
    }));
    const fork = slowFork('post', '/:id/fork', { id });
    await forkGate.entered;
    const append = route('post', '/:id/messages', { id, messages: [msg('D1'), msg('D2')] });
    await observeLockWait(pool);
    forkGate.release();
    assert.deepEqual(await contents((await fork).body.id), ['C']);
    assert.equal((await append).statusCode, 200);
    assert.deepEqual(await contents(id), ['C', 'D1', 'D2']);
    console.log('PASS fork and append serialize with a real Lock wait');

    for (const [method, endpoint, extra] of [
      ['get', '/:id', {}], ['put', '/:id', { body: { title: 'foreign' } }],
      ['post', '/:id/messages', { messages: [msg('foreign')] }], ['put', '/:id/messages', { messages: [] }],
      ['post', '/:id/fork', {}], ['delete', '/:id/messages/:msgIndex', { msgIndex: 0 }], ['delete', '/:id', {}],
    ]) assert.equal((await route(method, endpoint, { id, userId: 8, ...extra })).statusCode, 404);
    assert.deepEqual(await contents(id), ['C', 'D1', 'D2']);
    for (const msgIndex of ['NaN', '-1', '1junk', '999', '9007199254740992']) {
      assert.equal((await route('delete', '/:id/messages/:msgIndex', { id, msgIndex })).statusCode, 400);
    }
    assert.equal((await route('delete', '/:id/messages/:msgIndex', { id, msgIndex: '1' })).statusCode, 200);
    assert.deepEqual(await contents(id), ['C', 'D2']);
    assert.equal((await route('put', '/:id/messages', { id, messages: [] })).statusCode, 200);
    assert.deepEqual(await contents(id), []);
    console.log('PASS ownership, strict message indexes and explicit empty replacement preserve valid responses');

    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n, 0);
    console.log('PASS rejected and successful requests leave no open transactions');
  } finally {
    await pool.end();
    const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    cluster.stop();
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
    console.log('PASS temporary PostgreSQL PID, data and socket directories are gone');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
