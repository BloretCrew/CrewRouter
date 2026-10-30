'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createIsolatedPostgresFixture } = require('./test-support/isolated-postgres');

test('isolated fixture closes every tracked connection and removes its cluster even when cleanup rejects', async () => {
  let cleanup;
  const fixture = createIsolatedPostgresFixture({ after(callback) { cleanup = callback; } }, 'fixture-failure');
  const closed = [];
  const failure = new Error('offline cleanup failure');
  const failingConnection = { end() { closed.push('first'); throw failure; } };
  fixture.track(failingConnection);
  fixture.track({ async end() { closed.push('second'); } });
  fixture.track(failingConnection);
  try {
    await assert.rejects(cleanup(), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure);
    assert.deepEqual(closed, ['first', 'second']);
    assert.equal(fs.existsSync(fixture.dataDir), false);
    assert.equal(fs.existsSync(fixture.socketDir), false);
  } finally {
    fixture.stop();
  }
});

test('isolated fixture uses only its new private socket and shuts down its actual PostgreSQL process', async () => {
  let cleanup;
  const fixture = createIsolatedPostgresFixture({ after(callback) { cleanup = callback; } }, 'fixture-success');
  const pool = fixture.track(new Pool(fixture.connection));
  const pid = Number(fs.readFileSync(`${fixture.dataDir}/postmaster.pid`, 'utf8').split('\n')[0]);
  try {
    await fixture.assertIsolation(pool);
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
    await cleanup();
    assert.equal(fs.existsSync(fixture.dataDir), false);
    assert.equal(fs.existsSync(fixture.socketDir), false);
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    await assert.rejects(pool.query('SELECT 1'), /end|ending/);
  } finally {
    fixture.stop();
  }
});
