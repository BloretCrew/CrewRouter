'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateConfigSchema, validateConfig, applyDefaults } = require('./config-schema');

test('validates schema definition, default values and supported field types', () => {
  const schema = {
    endpoint: { type: 'string', required: true, min: 8, max: 100 },
    retries: { type: 'integer', min: 0, max: 5, default: 2 },
    mode: { type: 'string', options: ['safe', 'fast'], default: 'safe' },
    enabled: { type: 'boolean', default: true },
  };
  assert.equal(validateConfigSchema(schema), null);
  assert.equal(validateConfigSchema({ retries: { type: 'integer', min: 5, max: 1 } }), 'configSchema.retries.min 不能大于 max');
  assert.equal(validateConfigSchema({ mode: { type: 'string', default: 'unknown', options: ['safe'] } }), 'configSchema.mode.default mode 必须是允许选项之一');
  assert.equal(validateConfig({ endpoint: 'https://example.com', mode: 'fast', retries: 3, enabled: false }, schema), null);
  assert.deepEqual(applyDefaults({ endpoint: 'https://example.com' }, schema), {
    endpoint: 'https://example.com', retries: 2, mode: 'safe', enabled: true,
  });
});

test('rejects missing required, wrong type, bounds, enum and unknown properties', () => {
  const schema = {
    count: { type: 'integer', required: true, min: 1, max: 3 },
    mode: { type: 'string', options: ['a', 'b'] },
  };
  assert.equal(validateConfig({}, schema), 'count 为必填项');
  assert.equal(validateConfig({ count: '2' }, schema), 'count 类型必须为 integer');
  assert.equal(validateConfig({ count: 4 }, schema), 'count 不能大于 3');
  assert.equal(validateConfig({ count: 2, mode: 'c' }, schema), 'mode 必须是允许选项之一');
  assert.equal(validateConfig({ count: 2, injected: true }, schema), '不支持的配置项: injected');
});

test('preserves legacy arbitrary JSON configuration when no schema exists', () => {
  assert.equal(validateConfig({ oldKey: { nested: true } }, null), null);
});
