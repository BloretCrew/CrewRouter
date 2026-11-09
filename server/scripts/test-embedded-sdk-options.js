'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createCrewRouter } = require('../sdk/embedded');

const CONFIG = {
  app: {
    name: 'CrewRouter Embedded Options Test',
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'embedded-options-test-secret',
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

function fakePool() {
  const state = { ended: false, queries: 0 };
  return {
    state,
    pool: {
      query: async () => {
        state.queries += 1;
        return { rows: [], rowCount: 0 };
      },
      end: async () => {
        state.ended = true;
      },
    },
  };
}

test('external pool and feature presets are honored', async () => {
  const { pool: externalPool, state } = fakePool();
  const cr = createCrewRouter({
    config: CONFIG,
    pool: externalPool,
    session: false,
    features: ['gateway'],
    console: false,
    migrate: false,
    backgroundTasks: false,
    plugins: false,
    store: false,
    handleSignals: false,
  });

  try {
    await cr.start({ listen: false });
    const database = require('../models/database');
    assert.equal(database.pool, externalPool);
    assert.equal(database.ownsPool, false);

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
      assert.equal((await version.json()).name, CONFIG.app.name);

      // Management feature is not mounted.
      const management = await fetch(`${base}/api/user/api-keys`);
      assert.equal(management.status, 404);

      // Console pages are disabled.
      const consolePage = await fetch(`${base}/console`);
      assert.equal(consolePage.status, 404);
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await cr.stop();
  }

  // The embedded host owns the external pool; stop() must not end it.
  assert.equal(state.ended, false);
});
