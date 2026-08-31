'use strict';

const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { LocalServerManager } = require('../src/server-manager');

(async () => {
  const root = process.env.CREWROUTER_SERVER_ROOT;
  if (!root) throw new Error('Set CREWROUTER_SERVER_ROOT to run the local integration test');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'crewrouter-local-test-'));
  const manager = new LocalServerManager({ mode: 'development', serverRoot: root, userData, demo: true, startupTimeoutMs: 30000 });
  try {
    const status = await manager.start();
    if (!status.ready || !status.version || !status.edition || !status.setup || typeof status.setup.needsSetup !== 'boolean') throw new Error('Local server did not provide complete health metadata');
    console.log(JSON.stringify(status));
  } finally {
    await manager.stop();
    await fs.rm(userData, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
