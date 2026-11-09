'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createCrewRouter } = require('../sdk/embedded');

const CONFIG = {
  app: {
    name: 'CrewRouter Embedded Test',
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'embedded-test-secret',
  },
  demo: true,
  edition: 'team',
  runtime: 'server',
  loginReport: { enabled: false },
  statsReport: { enabled: false },
};

function options(extra = {}) {
  return {
    config: CONFIG,
    migrate: false,
    backgroundTasks: false,
    plugins: false,
    store: false,
    handleSignals: false,
    ...extra,
  };
}

test('embedded instance serves /api/version and stops cleanly', async () => {
  const cr = createCrewRouter(options());
  const server = await cr.start({ port: 0, host: '127.0.0.1' });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(`${base}/api/version`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.name, CONFIG.app.name);
    assert.match(response.headers.get('x-crewrouter-request-id') || '', /^[A-Za-z0-9._:-]+$/);
    assert.equal(server.listening, true);
  } finally {
    await cr.stop();
  }

  assert.equal(server.listening, false);
  await assert.rejects(fetch(`${base}/api/version`));
});

test('a host can mount the app without CrewRouter listening', async () => {
  const express = require('express');
  const cr = createCrewRouter(options());
  try {
    await cr.start({ listen: false });
    assert.equal(cr.server, null);

    const host = express();
    host.use('/', cr.app);
    const server = host.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`);
      assert.equal(response.status, 200);
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await cr.stop();
  }
});

test('a second embedded instance is rejected', async () => {
  const cr = createCrewRouter(options());
  try {
    assert.throws(
      () => createCrewRouter(options()),
      /ERR_CREWROUTER_MULTIPLE_INSTANCES/,
    );
  } finally {
    await cr.stop();
  }
});

test('basePath is rejected', () => {
  assert.throws(
    () => createCrewRouter(options({ basePath: '/ai' })),
    /ERR_CREWROUTER_BASE_PATH_UNSUPPORTED/,
  );
});

test('unsupported preview options are rejected', () => {
  for (const key of ['pool', 'session', 'features', 'console', 'oauthRoutes']) {
    assert.throws(
      () => createCrewRouter(options({ [key]: false })),
      /ERR_CREWROUTER_UNSUPPORTED_OPTION/,
    );
  }
});
