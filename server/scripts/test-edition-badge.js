'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pages = ['index.html', 'showcase.html', 'console.html', 'admin.html', 'playground.html', 'store.html', 'data.html', 'setup.html', 'feishu-bind.html', 'oauth-consent.html', 'purchase.html', 'set-password.html', 'plugin-install.html'];
const publicDir = path.resolve('public');
for (const page of pages) {
  const html = fs.readFileSync(path.join(publicDir, 'pages', page), 'utf8');
  assert(html.includes('data-edition-badge'), `${page} must include a badge mount`);
  assert(html.includes('/css/edition-badge.css'), `${page} must include badge CSS`);
  assert(html.includes('/js/edition-badge.js'), `${page} must include badge script`);
}

const css = fs.readFileSync(path.join(publicDir, 'css', 'edition-badge.css'), 'utf8');
assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|background:|border-radius:/i);
assert.match(css, /\.brand-edition-badge\[hidden\]/);

const source = fs.readFileSync(path.join(publicDir, 'js/edition-badge.js'), 'utf8');
let ready;
const classes = new Set();
const attrs = new Map();
const elements = [{ textContent: '', hidden: true, dataset: {}, classList: { add: value => classes.add(value) }, setAttribute: (key, value) => attrs.set(key, value) }];
const context = {
  window: {},
  document: {
    readyState: 'loading',
    querySelector: () => elements[0],
    querySelectorAll: () => elements,
    addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') ready = callback; },
  },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ runtime: 'server', edition: 'team' }) }),
};
vm.runInNewContext(source, context);
const badge = context.window.CrewRouterEditionBadge;
assert.strictEqual(typeof ready, 'function', 'auto mount must wait for DOMContentLoaded');
assert.strictEqual(badge.resolve({ runtime: 'desktop-local', edition: 'personal' }), 'LOCAL');
assert.strictEqual(badge.resolve({ runtime: 'server', edition: 'personal' }), 'PERSONAL');
assert.strictEqual(badge.resolve({ runtime: 'server', edition: 'team' }), 'TEAM');
assert.strictEqual(badge.resolve({ runtime: 'server', edition: 'unknown' }), '');
assert.strictEqual(badge.resolve({ edition: '<img src=x onerror=alert(1)>' }), '');

badge.mount({ runtime: 'desktop-local', edition: 'personal' });
assert.deepStrictEqual([elements[0].textContent, elements[0].hidden], ['LOCAL', false]);
assert.ok(classes.has('blora-tag'));
assert.strictEqual(attrs.get('data-variant'), 'primary');
const firstDataset = elements[0].dataset.editionBadgeValue;
badge.mount({ runtime: 'desktop-local', edition: 'personal' });
assert.strictEqual(elements[0].dataset.editionBadgeValue, firstDataset, 'same label mount remains idempotent');
badge.mount(null);
assert.deepStrictEqual([elements[0].textContent, elements[0].hidden], ['', true]);

console.log('edition badge tests passed');
