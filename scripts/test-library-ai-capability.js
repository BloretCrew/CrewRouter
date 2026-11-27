#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const context = vm.createContext({ console, fetch: async () => ({ ok: true, json: async () => context.keys }) });
vm.runInContext(source.slice(0, source.indexOf('const app = new ConsoleApp();')) + '\nglobalThis.App = ConsoleApp;', context);
const app = Object.create(context.App.prototype);
app._renderLibraryKeySelector = () => {};
app._updateLibraryBindingBar = () => {};
(async () => {
  const permissions = ['gateway.chat', 'gateway.messages', 'gateway.responses', 'gateway.gemini'];
  for (const permission of permissions) assert.ok(app._keyHasAiCapability({ permissions: [permission] }));
  for (const value of [undefined, null, [], ['gateway.models'], ['keys.read'], 'gateway.chat']) {
    assert.equal(app._keyHasAiCapability({ permissions: value }), false);
  }
  context.keys = permissions.map((permission, i) => ({id: i + 1, permissions: [permission], enabled: true}));
  context.keys.push({id: 8, permissions: [], enabled: true}, {id: 9, permissions: ['gateway.models']}, {id: 10, permissions: ['gateway.chat'], enabled: false});
  app._librarySelectedKeyId = 8;
  await app._loadLibraryKeys();
  assert.deepEqual(Array.from(app._libraryKeys, key => key.id), [1, 2, 3, 4]);
  assert.equal(app._librarySelectedKeyId, 1);
  assert.equal(context.keys.length, 7, '原始列表保留全部 Key');
  context.keys = [{id: 8, permissions: []}];
  await app._loadLibraryKeys();
  assert.equal(app._libraryNoAiKeys, true);
  assert.equal(app._libraryAllKeysClosed, false);
  assert.equal(app._librarySelectedKeyId, null);
  context.keys = [{id: 1, permissions: ['gateway.chat'], enabled: false}, {id: 8, permissions: []}];
  await app._loadLibraryKeys();
  assert.equal(app._libraryAllKeysClosed, true);
  assert.equal(app._libraryNoAiKeys, false);
  context.keys = [];
  await app._loadLibraryKeys();
  assert.equal(app._libraryNoAiKeys, false);
  assert.equal(app._libraryAllKeysClosed, false);
  console.log('PASS: 四类 AI 权限、无 AI、关闭、空列表及选中项回退');
})().catch(error => { console.error(error); process.exitCode = 1; });
