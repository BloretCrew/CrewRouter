'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateConfigSchema, validateConfig, applyDefaults, preserveSecrets, redactConfig } = require('./config-schema');

test('validates declarative schema definition, defaults, types, ranges and enums', () => {
  const schema = {
    endpoint: { type: 'string', required: true, min: 8, max: 200 },
    retries: { type: 'integer', min: 0, max: 5, default: 2 },
    mode: { type: 'string', options: ['safe', 'fast'], default: 'safe' },
    enabled: { type: 'boolean', default: true },
  };
  assert.equal(validateConfigSchema(schema), null);
  assert.equal(validateConfigSchema({ retries: { type: 'integer', min: 5, max: 1 } }), 'configSchema.retries.min 不能大于 max');
  assert.equal(validateConfigSchema({ mode: { type: 'string', default: 'unknown', options: ['safe'] } }), 'configSchema.mode.default mode 必须是允许的选项之一');
  assert.deepEqual(applyDefaults({ endpoint: 'https://example.com' }, schema), { endpoint: 'https://example.com', retries: 2, mode: 'safe', enabled: true });
  assert.equal(validateConfig({ endpoint: 'https://example.com', mode: 'fast', retries: 3, enabled: false }, schema), null);
});

test('rejects missing required fields, invalid types, bounds, enums and unknown properties', () => {
  const schema = { count: { type: 'integer', required: true, min: 1, max: 3 }, mode: { type: 'string', options: ['a', 'b'] } };
  assert.equal(validateConfig({}, schema), 'count 为必填项');
  assert.equal(validateConfig({ count: '2' }, schema), 'count 类型必须是 integer');
  assert.equal(validateConfig({ count: 4 }, schema), 'count 不能大于 3');
  assert.equal(validateConfig({ count: 2, mode: 'c' }, schema), 'mode 必须是允许的选项之一');
  assert.equal(validateConfig({ count: 2, injected: true }, schema), '不支持的配置项: injected');
});

test('preserves blank secrets and redacts secret values from management responses', () => {
  const schema = { apiToken: { type: 'secret', label: 'API Token', required: true }, note: { type: 'string' } };
  const original = { apiToken: 'private-token', note: 'old' };
  assert.equal(validateConfigSchema(schema), null);
  assert.deepEqual(preserveSecrets({ note: 'updated' }, original, schema), { apiToken: 'private-token', note: 'updated' });
  assert.deepEqual(preserveSecrets({ apiToken: '', note: 'updated' }, original, schema), { apiToken: 'private-token', note: 'updated' });
  assert.deepEqual(preserveSecrets({ apiToken: null, note: 'updated' }, original, schema), { apiToken: 'private-token', note: 'updated' });
  assert.deepEqual(preserveSecrets({ apiToken: 'replacement', note: 'updated' }, original, schema), { apiToken: 'replacement', note: 'updated' });
  assert.deepEqual(redactConfig(original, schema), { config: { note: 'old' }, configSecrets: { apiToken: true } });
  assert.equal(JSON.stringify(redactConfig(original, schema)).includes(original.apiToken), false);
  assert.equal(validateConfig({ apiToken: 123, note: 'x' }, schema), 'apiToken 类型必须是 string');
  assert.equal(validateConfig({ apiToken: 'valid-token', note: 'x' }, schema), null);
  assert.equal(validateConfigSchema({ apiToken: { type: 'secret', default: 'unsafe' } }), 'configSchema.apiToken secret 字段不能设置默认值');
});

test('legacy plugins without schemas keep arbitrary JSON object configuration', () => {
  assert.equal(validateConfig({ oldKey: { nested: true } }, null), null);
  assert.deepEqual(redactConfig({ oldKey: { nested: true } }, null), { config: { oldKey: { nested: true } }, configSecrets: {} });
  assert.equal(validateConfig([], null), 'config 必须是对象');
});
