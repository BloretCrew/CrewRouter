'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createCrewRouter } = require('../sdk/embedded');

const CONFIG = {
  app: {
    name: 'CrewRouter Embedded Features Test',
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'embedded-features-test-secret',
  },
  database: {
    host: '127.0.0.1',
    port: 1,
    name: 'unused',
    user: 'unused',
    password: '',
  },
  demo: false,
  edition: 'personal',
  runtime: 'server',
  loginReport: { enabled: false },
  statsReport: { enabled: false },
};

const poolState = { ended: false };
const externalPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  end: async () => {
    poolState.ended = true;
  },
};

test('features:"all" mounts management routes but keeps console off', async () => {
  const cr = createCrewRouter({
    config: CONFIG,
    pool: externalPool,
    session: false,
    features: 'all',
    console: false,
    migrate: false,
    backgroundTasks: false,
    plugins: false,
    store: false,
    handleSignals: false,
  });

  try {
    await cr.start({ listen: false });

    const express = require('express');
    const host = express();
    host.use('/', cr.app);
    const server = host.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
      const version = await fetch(`${base}/api/version`);
      assert.equal(version.status, 200);

      // The management route is mounted; without credentials it answers 401/403,
      // not 404.
      const management = await fetch(`${base}/api/user/api-keys`);
      assert.notEqual(management.status, 404);
      assert.ok([401, 403].includes(management.status), `unexpected status ${management.status}`);

      const consolePage = await fetch(`${base}/console`);
      assert.equal(consolePage.status, 404);
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await cr.stop();
  }

  assert.equal(poolState.ended, false);
});
