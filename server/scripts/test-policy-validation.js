'use strict';

const assert = require('assert');
const { normalizePolicyInput, normalizePolicySettingsInput, PolicyValidationError } = require('../utils/policy/validation');

function expectInvalid(description, input, field) {
  try {
    normalizePolicyInput(input);
  } catch (error) {
    assert.ok(error instanceof PolicyValidationError, `${description}: wrong error type`);
    if (field) assert.ok(error.details.some(item => String(item.field).startsWith(field)), `${description}: missing field ${field}, got ${JSON.stringify(error.details)}`);
    console.log(`ok - ${description}`);
    return;
  }
  throw new Error(`${description}: expected validation error`);
}

const base = {
  name: '禁止 Claude Code',
  scope_type: 'team',
  scope_id: 1,
  effect: 'deny',
  action: 'block',
  category: 'client',
  conditions: { clients: ['claude_code'] },
};

const normalized = normalizePolicyInput(base);
assert.strictEqual(normalized.name, '禁止 Claude Code');
assert.deepStrictEqual(normalized.conditions.clients, ['claude_code']);
assert.strictEqual(normalized.status, 'published');
assert.strictEqual(normalized.rollout_percent, 100);
console.log('ok - valid client policy');

expectInvalid('unknown condition rejected', { ...base, conditions: { unknown_field: true } }, 'conditions');
expectInvalid('invalid cidr rejected', { ...base, conditions: { ips: ['999.1.1.1/8'] } }, 'conditions.ips');
expectInvalid('invalid timezone rejected', {
  ...base,
  conditions: { schedule: { timezone: 'Mars/Base', weekly: {} } },
}, 'conditions.schedule');
expectInvalid('invalid weekday rejected', {
  ...base,
  conditions: { schedule: { timezone: 'Asia/Shanghai', weekly: { funday: [['09:00', '10:00']] } } },
}, 'conditions.schedule');
expectInvalid('invalid regex rejected', {
  ...base,
  conditions: { prompt: { regex: ['['] } },
}, 'conditions.prompt');
expectInvalid('empty conditions rejected', { ...base, conditions: {} }, 'conditions');

const allow = normalizePolicyInput({
  ...base,
  scope_type: 'global',
  scope_id: null,
  effect: 'allow',
  action: 'block',
  conditions: { clients: ['claude_code'] },
});
assert.strictEqual(allow.action, 'warn');
console.log('ok - allow policy action coerced to warn');

const settings = normalizePolicySettingsInput({
  enforcement_mode: 'shadow',
  allowlist_dimensions: ['clients', 'ips'],
  hit_retention_days: 30,
});
assert.strictEqual(settings.enforcement_mode, 'shadow');
assert.deepStrictEqual(settings.allowlist_dimensions, ['clients', 'ips']);
console.log('ok - policy settings normalized');

console.log('all policy validation tests passed');
