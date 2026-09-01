'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('public/js/edition-badge.js', 'utf8');
const context = {
  window: {},
  document: { querySelector: () => null, addEventListener: () => {} },
  fetch: () => Promise.reject(new Error('not used')),
};
vm.runInNewContext(source, context);
const badge = context.window.CrewRouterEditionBadge;

assert.strictEqual(badge.resolve({ runtime: 'desktop-local', edition: 'personal' }), 'LOCAL');
assert.strictEqual(badge.resolve({ runtime: 'server', edition: 'personal' }), 'PERSONAL');
assert.strictEqual(badge.resolve({ runtime: 'server', edition: 'team' }), 'TEAM');
assert.strictEqual(badge.resolve({ runtime: 'server', edition: 'unknown' }), '');
assert.strictEqual(badge.resolve({ runtime: 'server' }), '');
assert.strictEqual(badge.resolve({ edition: '<img src=x onerror=alert(1)>' }), '');

let mounts = 0;
const elements = [{ textContent: '', hidden: false }, { textContent: '', hidden: false }];
context.document.querySelectorAll = () => elements;
badge.mount({ runtime: 'desktop-local', edition: 'personal' });
assert.deepStrictEqual(elements.map((element) => [element.textContent, element.hidden]), [['LOCAL', false], ['LOCAL', false]]);
badge.mount(null);
assert.deepStrictEqual(elements.map((element) => [element.textContent, element.hidden]), [['', true], ['', true]]);
mounts += elements.length;
assert.strictEqual(mounts, 2);

console.log('edition badge tests passed');
