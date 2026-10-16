'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const dir = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
const source = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
const factory = new vm.Script(`(${source})`).runInNewContext({
  Object, Array, String, Number, Boolean, Map, Set, Promise, Symbol, JSON, Math, Date, RegExp,
  Error, TypeError, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
});

let hook;
const logs = [];
const ctx = {
  pluginId: manifest.id,
  config: { providerId: 'opencode-primary' },
  log: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  on(name, handler) { assert.equal(name, 'gateway:beforeUpstream'); hook = handler; },
};

(async () => {
  await factory(ctx);
  assert.equal(typeof hook, 'function');

  const untouched = { url: 'https://other.test/v1/chat/completions', headers: {}, bodyText: '{"model":"m"}' };
  assert.equal(await hook(untouched, { provider: { id: 'other' }, requestType: 'openai' }), untouched);

  const original = {
    url: 'https://opencode.test/v1/chat/completions',
    headers: { Authorization: 'Bearer configured' },
    bodyText: JSON.stringify({ model: 'free-model', messages: [{ role: 'user', content: 'hi' }] }),
  };
  const rewritten = await hook(original, { provider: { id: 'opencode-primary' }, requestType: 'openai' });
  const body = JSON.parse(rewritten.bodyText);
  assert.equal(rewritten.headers.Authorization, 'Bearer public');
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  for (const name of ['shell', 'edit', 'glob', 'grep', 'read']) {
    const tool = body.tools.find((item) => item.function?.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.ok(tool.function.description.length > 0);
    assert.ok(Object.keys(tool.function.parameters.properties).length > 0);
  }
  assert.equal(JSON.parse(original.bodyText).stream, undefined, 'original payload is not mutated');
  console.log('OpenCode provider adapter tests passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
