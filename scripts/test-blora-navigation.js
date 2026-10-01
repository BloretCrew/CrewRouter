'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const services = fs.readFileSync('public/js/blora-services.js', 'utf8');
const source = services.slice(services.indexOf('let currentNavigation;'), services.indexOf('syncNavigation();'));
const attributes = () => new Map();
const items = [true, false].map(active => ({
  dataset: {}, attrs: attributes(), classList: { contains: name => name === 'active' && active },
  setAttribute(key, value) { this.attrs.set(key, value); }, removeAttribute(key) { this.attrs.delete(key); },
}));
const context = vm.createContext({ document: { querySelectorAll: () => items, querySelector: () => null, getElementById: () => null } });
vm.runInContext(source + '\nsyncNavigation();', context);
assert.equal(items[0].dataset.variant, 'secondary');
assert.equal(items[0].attrs.get('aria-current'), 'page');
assert.equal(items[1].dataset.variant, 'ghost');
assert.equal(items[1].attrs.has('aria-current'), false);
items[0].classList.contains = () => false;
items[1].classList.contains = () => true;
vm.runInContext('syncNavigation();', context);
assert.equal(items[0].attrs.has('aria-current'), false);
assert.equal(items[1].attrs.get('aria-current'), 'page');
console.log('Navigation selected variant and aria-current follow the real route state.');
