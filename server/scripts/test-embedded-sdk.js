'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
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

    const consoleResponse = await fetch(`${base}/console`);
    assert.equal(consoleResponse.status, 404);
  } finally {
    await cr.stop();
  }

  assert.equal(server.listening, false);
  await assert.rejects(fetch(`${base}/api/version`));
});

test('startup failure stops partial initialization and releases the singleton', async () => {
  const app = require('../index');
  const originalStart = app.startServer;
  const originalStop = app.stopServer;
  let cleanupCalls = 0;
  const startupError = Object.assign(new Error('simulated startup failure'), { code: 'ERR_TEST_STARTUP' });
  app.startServer = async () => { throw startupError; };
  app.stopServer = async () => { cleanupCalls += 1; };
  const cr = createCrewRouter(options());
  try {
    await assert.rejects(cr.start(), { code: 'ERR_TEST_STARTUP' });
    assert.equal(cr.server, null);
    assert.equal(cleanupCalls, 1);
    await cr.stop();
  } finally {
    app.startServer = originalStart;
    app.stopServer = originalStop;
  }
  const replacement = createCrewRouter(options());
  await replacement.stop();
});

test('concurrent start calls share one listener and repeated stop is safe', async () => {
  const cr = createCrewRouter(options());
  const [first, second] = await Promise.all([
    cr.start({ port: 0, host: '127.0.0.1' }),
    cr.start({ port: 0, host: '127.0.0.1' }),
  ]);
  assert.equal(first, second);
  assert.equal(first.listening, true);
  await Promise.all([cr.stop(), cr.stop()]);
  assert.equal(first.listening, false);
  await assert.rejects(cr.start(), { code: 'ERR_CREWROUTER_STOPPED' });
});

test('listener startup failure releases instance and can be retried', async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = blocker.address().port;
  const cr = createCrewRouter(options());
  try {
    await assert.rejects(cr.start({ port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
    assert.equal(cr.server, null);
    await new Promise((resolve) => blocker.close(resolve));
    const server = await cr.start({ port, host: '127.0.0.1' });
    assert.equal(server.listening, true);
  } finally {
    await cr.stop();
    if (blocker.listening) await new Promise((resolve) => blocker.close(resolve));
  }
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

test('invalid preview options are rejected', () => {
  assert.throws(
    () => createCrewRouter(options({ pool: {} })),
    /ERR_CREWROUTER_INVALID_POOL/,
  );
  assert.throws(
    () => createCrewRouter(options({ session: 'bad' })),
    /ERR_CREWROUTER_INVALID_SESSION/,
  );
  assert.throws(
    () => createCrewRouter(options({ features: 'bad' })),
    /ERR_CREWROUTER_INVALID_FEATURES/,
  );
});
