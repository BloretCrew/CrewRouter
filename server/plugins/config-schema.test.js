'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateConfigSchema, validateConfig, applyDefaults, preserveSecrets, redactConfig } = require('./config-schema');

test('validates schema defaults, field types, ranges and enums', () => {
  const schema = {
    endpoint: { type: 'string', required: true, min: 8, max: 200 },
    retries: { type: 'integer', default: 2, min: 0, max: 5 },
    mode: { type: 'string', options: ['safe', 'fast'], default: 'safe' },
    enabled: { type: 'boolean', default: true },
  };
  assert.equal(validateConfigSchema(schema), null);
  assert.deepEqual(applyDefaults({ endpoint: 'https://x' }, schema), { endpoint: 'https://x', retries: 2, mode: 'safe', enabled: true });
  assert.equal(validateConfig({ endpoint: 'https://x', retries: 3, mode: 'fast', enabled: false }, schema), null);
  assert.match(validateConfig({ endpoint: 'x' }, schema), /retries/);
  assert.match(validateConfig({ endpoint: 'https://x', retries: 9, mode: 'safe', enabled: true }, schema), /retries/);
  assert.match(validateConfigSchema({ secret: { type: 'secret', default: 'unsafe' } }), /不能设置默认值/);
});

test('preserves omitted or blank secret input and never returns secret values', () => {
  const schema = {
    apiToken: { type: 'secret', label: 'API Token', required: true },
    note: { type: 'string' },
  };
  const original = { apiToken: 'private-token', note: 'old' };
  assert.deepEqual(preserveSecrets({ note: 'updated' }, original, schema), { apiToken: 'private-token', note: 'updated' });
  assert.deepEqual(preserveSecrets({ apiToken: '', note: 'updated' }, original, schema), { apiToken: 'private-token', note: 'updated' });
  assert.deepEqual(preserveSecrets({ apiToken: 'replacement', note: 'updated' }, original, schema), { apiToken: 'replacement', note: 'updated' });
  assert.deepEqual(redactConfig(original, schema), { config: { note: 'old' }, configSecrets: { apiToken: true } });
  assert.equal(validateConfig({ apiToken: 1, note: 'x' }, schema), 'apiToken 类型必须是 string');
});

test('legacy plugins without schemas keep arbitrary object configuration', () => {
  assert.equal(validateConfig({ arbitrary: { nested: true } }, null), null);
  assert.deepEqual(redactConfig({ arbitrary: { nested: true } }, null), { config: { arbitrary: { nested: true } }, configSecrets: {} });
  assert.equal(validateConfig([], null), 'config 必须是对象');
});
