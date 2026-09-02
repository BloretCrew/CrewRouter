'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { LocalServerManager, findFreePort, resolveServerEntry } = require('../src/server-manager');

function fail(message) { throw new Error(message); }

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.once('error', reject);
  });
}

(async () => {
  const packaged = process.argv.includes('--packaged');
  const root = process.env.CREWROUTER_SERVER_ROOT;
  const resourceRoot = process.env.CREWROUTER_RESOURCE_ROOT || path.join(__dirname, '..', 'staging', 'server');
  const serverEntry = packaged
    ? resolveServerEntry('packaged', { resourceRoot })
    : resolveServerEntry('development', { serverRoot: root, resourceRoot });
  const bundleRoot = path.dirname(serverEntry);
  for (const forbidden of ['.env', '.env.local']) {
    if (fs.existsSync(path.join(bundleRoot, forbidden))) fail(`Unsafe packaged file found: ${forbidden}`);
  }
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'crewrouter-local-test-'));
  const manager = new LocalServerManager({ mode: packaged ? 'packaged' : 'development', serverEntry, userData, startupTimeoutMs: 30000 });
  let status;
  try {
    status = await manager.start();
    if (!status.ready || !status.version || !status.edition || !status.setup || typeof status.setup.needsSetup !== 'boolean') fail('Local server did not provide complete health metadata');
    const base = status.baseUrl;
    const [instance, setup, root, consolePage, me] = await Promise.all([
      request(`${base}/api/instance`),
      request(`${base}/api/setup/status`),
      request(`${base}/`),
      request(`${base}/console`),
      request(`${base}/auth/me`),
    ]);
    const cookie = me.headers['set-cookie']?.map((value) => value.split(';', 1)[0]).join('; ');
    const [apiKeys, models] = await Promise.all([
      request(`${base}/api/user/api-keys`, cookie ? { cookie } : {}),
      request(`${base}/v1/models`, cookie ? { cookie } : {}),
    ]);
    const metadata = instance.json();
    if (metadata.runtime !== 'desktop-local' || metadata.edition !== 'personal' || metadata.auth?.required !== false || JSON.stringify(metadata.auth?.methods) !== JSON.stringify(['local'])) fail('Local instance metadata is incorrect');
    if (setup.json().needsSetup !== false) fail('Local server incorrectly requires setup');
    if (root.status !== 200 || root.headers.location?.includes('/setup')) fail('Local root entered setup flow');
    if (consolePage.status !== 200 || consolePage.body.length < 100) fail('Local console did not load');
    const meData = me.json();
    if (me.status !== 200 || meData.needsPasswordSetup !== false || meData.local !== true) fail(`Local session was not initialized: status=${me.status} body=${me.body}`);
    if (![200, 403].includes(apiKeys.status) || ![200, 401, 403].includes(models.status)) fail(`Local API bootstrap failed: apiKeys=${apiKeys.status} models=${models.status} me=${me.body}`);
    console.log(JSON.stringify({ ...status, smoke: { root: root.status, console: consolePage.status, authMe: me.status, apiKeys: apiKeys.status, models: models.status }, resourceRoot: packaged ? resourceRoot : undefined }));
  } finally {
    await manager.stop();
    if (!status?.ready) {
      const logPath = path.join(userData, 'logs', 'server.log');
      if (fs.existsSync(logPath)) console.error(`Server log:\n${await fsp.readFile(logPath, 'utf8')}`);
    }
    await fsp.rm(userData, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
