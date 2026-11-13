'use strict';

const assert = require('assert');
const { detectConflicts, overlaps } = require('../utils/policy/conflicts');
const { diffSnapshots } = require('../utils/policy/versions');
const { simulatePolicy } = require('../utils/policy/simulations');
const { publicChannel, MASK } = require('../utils/policy/channels');
const { dayString } = require('../utils/policy/metrics');

function policy(overrides = {}) {
  return {
    id: 1, name: 'p', scope_type: 'team', scope_id: 1, effect: 'deny', action: 'block',
    priority: 100, enabled: true, status: 'published',
    conditions: { clients: ['claude_code'] }, ...overrides,
  };
}

(async () => {
  assert.strictEqual(overlaps(['claude_code'], ['claude_code']), true);
  assert.strictEqual(overlaps(['claude*'], ['claude_code']), true);
  assert.strictEqual(overlaps(['codex'], ['claude_code']), false);
  console.log('ok - condition overlap detection');

  const conflicts = detectConflicts([
    policy({ id: 1, effect: 'deny' }),
    policy({ id: 2, effect: 'allow', action: 'warn' }),
  ]);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].dimension[0], 'clients');
  console.log('ok - deny/allow conflict detected');

  const diff = diffSnapshots({ name: 'a', conditions: { clients: ['a'] }, priority: 1 }, { name: 'b', conditions: { clients: ['b'] }, priority: 1 });
  assert.ok(diff.name);
  assert.ok(diff.conditions);
  assert.strictEqual(diff.priority, undefined);
  console.log('ok - version diff');

  const simulation = await simulatePolicy(
    policy(),
    [{ client: 'claude_code' }, { client: 'codex' }],
    { queryUsage: async () => 0 }
  );
  assert.strictEqual(simulation.total, 2);
  assert.strictEqual(simulation.matched, 1);
  assert.strictEqual(simulation.examples.length, 1);
  console.log('ok - policy simulation');

  const masked = publicChannel({ id: 1, config: { url: 'https://example.com', secret: 'super-secret' } });
  assert.strictEqual(masked.config.secret, MASK);
  assert.strictEqual(masked.config.url, 'https://example.com');
  console.log('ok - channel secret masking');

  assert.match(dayString(new Date('2026-11-13T10:00:00Z')), /^2026-11-13$/);
  console.log('ok - metrics day string');

  console.log('all policy lifecycle tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
