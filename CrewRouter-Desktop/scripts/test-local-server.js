'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { LocalServerManager, resolveServerEntry } = require('../src/server-manager');

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
  const manager = new LocalServerManager({ mode: packaged ? 'packaged' : 'development', serverEntry, userData, startupTimeoutMs: 90000, displayName: 'Desktop Tester', localIdentityId: 'local-test-identity' });
  const progress = [];
  manager.on('progress', (event) => { progress.push(event); console.error(`[progress] ${event.step}/${event.total} ${event.label}`); });
  let status;
  try {
    status = await manager.start();
    if (!status.ready || !status.version || !status.edition || !status.setup || typeof status.setup.needsSetup !== 'boolean') fail('Local server did not provide complete health metadata');
    if (!manager.localToken) fail('Local server manager did not generate a local token');
    const base = status.baseUrl;
    const tokenHeader = { 'x-crewrouter-desktop-token': manager.localToken };
    const [instance, setup, root, consolePage, me, meWithoutToken] = await Promise.all([
      request(`${base}/api/instance`),
      request(`${base}/api/setup/status`),
      request(`${base}/`, tokenHeader),
      request(`${base}/console`, tokenHeader),
      request(`${base}/auth/me`, tokenHeader),
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
    if (meWithoutToken.status !== 401) fail(`Loopback request without the desktop token must not receive a session (got HTTP ${meWithoutToken.status})`);
    if (![200, 403].includes(apiKeys.status) || ![200, 401, 403].includes(models.status)) fail(`Local API bootstrap failed: apiKeys=${apiKeys.status} models=${models.status} me=${me.body}`);
    if (!progress.some((event) => event.step === 1) || !progress.some((event) => event.step === 3)) fail('Local server manager did not report startup progress');
    console.log(JSON.stringify({ ...status, smoke: { root: root.status, console: consolePage.status, authMe: me.status, authMeWithoutToken: meWithoutToken.status, apiKeys: apiKeys.status, models: models.status }, database: status.database, resourceRoot: packaged ? resourceRoot : undefined }));
  } finally {
    await manager.stop();
    if (!status?.ready) {
      for (const logName of ['server.log', 'postgres.log']) {
        const logPath = path.join(userData, 'logs', logName);
        if (fs.existsSync(logPath)) console.error(`${logName}:\n${await fsp.readFile(logPath, 'utf8')}`);
      }
    }
    await fsp.rm(userData, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
