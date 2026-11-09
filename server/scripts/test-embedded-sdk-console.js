'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createCrewRouter } = require('../sdk/embedded');

const CONFIG = {
  app: {
    name: 'CrewRouter Embedded Console Test',
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'embedded-console-test-secret',
  },
  demo: true,
  edition: 'team',
  runtime: 'server',
  loginReport: { enabled: false },
  statsReport: { enabled: false },
};

test('console:true serves static console pages', async () => {
  const cr = createCrewRouter({
    config: CONFIG,
    console: true,
    migrate: false,
    backgroundTasks: false,
    plugins: false,
    store: false,
    handleSignals: false,
  });

  const server = await cr.start({ port: 0, host: '127.0.0.1' });
  const { port } = server.address();
  try {
    const version = await fetch(`http://127.0.0.1:${port}/api/version`);
    assert.equal(version.status, 200);

    const page = await fetch(`http://127.0.0.1:${port}/console`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
  } finally {
    await cr.stop();
  }
});
