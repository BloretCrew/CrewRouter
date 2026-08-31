'use strict';
const assert = require('assert');
const { normalizeEdition, getCapabilities, metadata, requireTeamEdition } = require('../utils/instance-edition');

assert.strictEqual(normalizeEdition(' personal '), 'personal');
assert.strictEqual(normalizeEdition('TEAM'), 'team');
assert.strictEqual(normalizeEdition('enterprise'), null);
assert.throws(() => getCapabilities(null), /edition/);
assert.strictEqual(getCapabilities('personal').teamAdmin, false);
assert.strictEqual(getCapabilities('team').teamAdmin, true);
assert.deepStrictEqual(metadata('personal').edition, 'personal');

(async () => {
  const guard = requireTeamEdition('personal');
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await guard({ session: { user: { id: 1 } } }, response, () => { throw new Error('guard unexpectedly passed'); });
  assert.strictEqual(response.statusCode, 403);
  assert.strictEqual(response.body.type, 'team_edition_required');
  const teamResponse = { statusCode: 200, json() {} };
  let passed = false;
  await requireTeamEdition('team')({}, teamResponse, () => { passed = true; });
  assert.strictEqual(passed, true);
  console.log('instance edition validation tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
