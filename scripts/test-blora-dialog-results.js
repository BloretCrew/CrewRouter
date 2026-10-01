'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.attributes = new Map(); this.children = []; this.style = { setProperty() {} }; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  hasAttribute(key) { return this.attributes.has(key); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  show() { this.setAttribute('open', ''); }
  close() { this.attributes.delete('open'); this.dispatchEvent(new Event('blora-close')); }
  remove() { this.removed = true; }
}
const body = new Element('body');
const context = vm.createContext({
  document: { body, documentElement: new Element('html'), createElement: (tag) => new Element(tag), getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
  window: {}, t: (value) => value, Event, EventTarget,
});
vm.runInContext(fs.readFileSync(require.resolve('../public/js/blora-dialog.js'), 'utf8') + '\nthis.dialogAPI = Dialog;', context);
(async () => {
  for (const value of ['renamed profile', 0, null, { saved: true }]) {
    const modal = context.dialogAPI.showModal({ title: '设置', content: '' });
    modal.close(value);
    assert.strictEqual(await modal.promise, value);
    assert.strictEqual(modal.element.removed, true);
  }
  const dismissed = context.dialogAPI.showModal({ title: '设置', content: '' });
  dismissed.element.close();
  assert.strictEqual(await dismissed.promise, false);
  console.log('Dialog result, dismissal and removal regressions passed (5 cases).');
})().catch((error) => { console.error(error); process.exitCode = 1; });
