'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getCapabilities, requireTeamEdition } = require('../utils/instance-edition');
const { csrfProtection } = require('../middleware/csrf');

const personal = getCapabilities('personal');
const team = getCapabilities('team');
assert.strictEqual(personal.personalProviders, true);
assert.strictEqual(personal.adminStats, false);
assert.strictEqual(team.personalProviders, true);
assert.strictEqual(team.adminStats, true);

(async () => {
  const guard = requireTeamEdition('personal');
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await guard({ session: { user: { id: 1 } } }, response, () => { throw new Error('Personal Team route unexpectedly passed'); });
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(response.body.type, 'team_edition_required');

  const consoleSource = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
  assert.match(consoleSource, /legacyUpstreamEntry[\s\S]*personalProviders/);
  assert.match(consoleSource, /page === 'myProviders'/);
  assert.match(consoleSource, /page === 'myTeamModels'/);

  const adminSource = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  assert.match(adminSource, /'\/stats', '\/message-stats', '\/usage-logs'/);
  const consolePage = fs.readFileSync(path.join(__dirname, '../../public/pages/console.html'), 'utf8');
  assert.match(consolePage, /data-page="myUpstream" data-capability="personalProviders"/);

  let nextCalled = false;
  const req = {
    method: 'POST', path: '/api/example', headers: {}, body: {},
    session: { csrfToken: 'token' }, get() { return 'example.test'; }, protocol: 'https',
    app: { locals: { csrfAllowedOrigins: [] } }
  };
  csrfProtection(req, { status(code) { assert.strictEqual(code, 403); return this; }, json(body) { assert.strictEqual(body.type, 'csrf_failed'); } }, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  req.headers.origin = 'https://example.test';
  req.app.locals.csrfAllowedOrigins = ['https://example.test'];
  csrfProtection(req, { status() { return this; }, json() {} }, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  console.log('Batch E permission boundary tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
