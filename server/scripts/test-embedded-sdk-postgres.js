'use strict';

const assert = require('node:assert/strict');
const { Pool } = require('pg');
const express = require('express');
const { createCrewRouter } = require('../sdk/embedded');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  connectionTimeoutMillis: 5000,
});

const config = {
  app: { name: 'CrewRouter Embedded PostgreSQL CI', host: '127.0.0.1', port: 0, sessionSecret: 'embedded-postgres-ci-secret' },
  database: { host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT) || 5432, name: process.env.PGDATABASE || 'postgres', user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres' },
  edition: 'personal',
  runtime: 'server',
  demo: false,
  loginReport: { enabled: false },
  statsReport: { enabled: false },
};

async function main() {
  const cr = createCrewRouter({
    config,
    pool,
    session: false,
    features: ['gateway', 'management', 'events'],
    console: false,
    migrate: true,
    backgroundTasks: true,
    plugins: false,
    store: false,
    handleSignals: false,
  });
  const host = express();
  let server;
  try {
    await cr.start({ listen: false });
    host.use('/', cr.app);
    server = await new Promise((resolve, reject) => {
      const listener = host.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    const address = server.address();
    const version = await fetch(`http://127.0.0.1:${address.port}/api/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).name, config.app.name);
    const adminRoute = await fetch(`http://127.0.0.1:${address.port}/api/user/api-keys`);
    assert.ok([401, 403].includes(adminRoute.status), `expected auth rejection, got ${adminRoute.status}`);
  } finally {
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await cr.stop();
  }

  const stillOwned = await pool.query('SELECT 1 AS external_pool_still_open');
  assert.equal(stillOwned.rows[0].external_pool_still_open, 1);
  await pool.end();
  console.log('Embedded PostgreSQL host integration passed; the external pool remained open until host closure.');
}

main().catch(async error => {
  console.error(error);
  try { await pool.end(); } catch (_) {}
  process.exitCode = 1;
});
