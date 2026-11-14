'use strict';

// 校验标准 generator 产物的真实 JSON Schema；不连接数据库。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const Ajv2020 = require('ajv/dist/2020');
const root = path.resolve(__dirname, '../..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const api = read('sdk/contract/openapi.json');
const schemas = api.components.schemas;
const ajv = new Ajv2020({ strict: false });
for (const [name, schema] of Object.entries(schemas)) ajv.addSchema(schema, name);
const valid = (schema, value) => ajv.getSchema(schema)(value);

test('签名四个操作均使用精确响应/请求 schema，与发布 OpenAPI 一致', () => {
  assert.deepEqual(api, read('docs/api/openapi.json'));
  const manifest = read('sdk/contract/operations.json').operations;
  for (const [route, prefix] of [['/api/user/signature', 'User'], ['/api/user/api-keys/{id}/signature', 'Key']]) {
    for (const method of ['get', 'put']) {
      const op = api.paths[route][method];
      assert.equal(op.responses[200].content['application/json'].schema.$ref, `#/components/schemas/${prefix}Signature${method === 'put' ? 'Updated' : ''}`);
      const entry = manifest.find(item => item.path === route.replace('{id}', ':id') && item.method === method.toUpperCase());
      assert(entry, `${method} ${route}`);
      assert.equal(op['x-crewrouter-permission'], prefix === 'User' ? `account.profile.${method === 'get' ? 'read' : 'write'}` : `keys.${method === 'get' ? 'read' : 'write'}`);
      if (method === 'put') {
        assert.equal(op.requestBody.required, true);
        assert.equal(op.requestBody.content['application/json'].schema.$ref, `#/components/schemas/${prefix}SignaturePut`);
        assert.equal(op.responses[400].content['application/json'].schema.$ref, '#/components/schemas/SignatureValidationError');
        assert.match(op.responses[400].description, /No fields are written/);
      }
    }
  }
});

test('完整 PUT 的新旧字段必填组合有效，缺失任一字段不合法', () => {
  for (const prefix of ['User', 'Key']) {
    const name = `${prefix}SignaturePut`;
    const schema = schemas[name];
    assert.deepEqual(schema.anyOf[0].required, ['enabled', 'template']);
    assert.equal(schema.properties.template.maxLength, 2000);
    assert.deepEqual(schema.properties.template.type, ['string', 'null']);
    const fields = ['signature_', prefix === 'Key' ? 'key_signature_' : 'api_signature_'];
    const states = prefix === 'Key' ? [true, false, null] : [true, false];
    for (const enabled of states) {
      for (const template of ['', null, 'x'.repeat(2000)]) {
        for (const enabledPrefix of ['', ...fields]) {
          for (const templatePrefix of ['', ...fields]) {
            assert(valid(name, { [`${enabledPrefix}enabled`]: enabled, [`${templatePrefix}template`]: template }));
          }
        }
      }
    }
    for (const body of [{}, { enabled: true }, { template: '' }, { signature_enabled: true }, { key_signature_template: null }, { enabled: 'off', template: '' }, { enabled: 0, template: '' }, { enabled: true, template: [] }, { enabled: true, template: 'x'.repeat(2001) }]) {
      assert.equal(valid(name, body), false, `${name} ${JSON.stringify(body)}`);
    }
    assert.match(schema.description, /normalized values must agree/);
    assert.match(schema.description, /conflicts return 400/);
    assert.equal(schema.properties.signature_enabled.deprecated, true);
    assert.equal(schema.properties[fields[1] + 'template'].deprecated, true);
  }
  assert.equal(valid('UserSignaturePut', { enabled: null, template: '' }), false);
  assert.equal(valid('KeySignaturePut', { enabled: null, template: '' }), true);
});

test('GET/PUT Key 响应包括继承、有效状态和兼容字段，并严格验证三态', () => {
  const sample = {
    enabled: null, template: null,
    key_signature_enabled: null, key_signature_template: null,
    user_signature_enabled: true, user_signature_template: 'owner',
    inherited: { enabled: true, template: 'owner' },
    effective: { enabled: true, template: 'owner', source: 'user' },
  };
  assert(valid('KeySignature', sample));
  assert(valid('KeySignatureUpdated', { success: true, ...sample }));
  assert.equal(valid('KeySignature', { ...sample, effective: { enabled: true, template: '', source: 'member' } }), false);
  assert.equal(valid('KeySignature', { ...sample, inherited: { enabled: null, template: '' } }), false);
  const missing = { ...sample }; delete missing.key_signature_enabled;
  assert.equal(valid('KeySignature', missing), false);
  assert.equal(valid('KeySignatureUpdated', { ...sample, success: false }), false);
  assert.match(schemas.KeySignature.properties.enabled.description, /not the Co-Key member/);
  assert.match(schemas.KeySignature.properties.effective.properties.template.description, /Empty means no signature/);
});

test('用户响应及 400 错误结构均为明确 schema', () => {
  const sample = { enabled: true, template: '', api_signature_enabled: true, api_signature_template: '' };
  assert(valid('UserSignature', { ...sample, defaults: { template: '{model}', variables: ['model'] } }));
  assert(valid('UserSignatureUpdated', { ...sample, success: true }));
  assert.equal(valid('UserSignature', { ...sample, defaults: {} }), false);
  assert.equal(valid('UserSignatureUpdated', { ...sample, enabled: null, success: true }), false);
  for (const code of ['missing_signature_field', 'invalid_signature_field', 'conflicting_signature_fields', 'invalid_signature_enabled', 'invalid_signature_template']) {
    assert(valid('SignatureValidationError', { error: 'invalid input', code }));
  }
  assert.equal(valid('SignatureValidationError', { error: 'invalid input' }), false);
});
