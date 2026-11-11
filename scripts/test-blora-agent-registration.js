const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname, '../public/js/blora-agent.js'), 'utf8');

// The current page binds synchronously; the organizer uses blora-dialog rather
// than the retired blora-drawer component, so no upgrade wait is required.
const element = {
  classList: { add() {}, remove() {}, toggle() {} },
  dataset: {},
  appendChild() {},
  setAttribute() {},
  removeAttribute() {},
  hasAttribute() { return false; },
  addEventListener() {},
  querySelectorAll() { return []; },
  close() {}
};
const context = {
  window: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}
  },
  document: {
    addEventListener() {},
    getElementById: id => (id === 'baHistory' || id === 'bloraAgentPage' || id === 'baComposer' || id === 'baAttachments') ? element : null,
    createElement: () => ({ ...element }),
    querySelector: () => null
  },
  customElements: { whenDefined: () => Promise.resolve() },
  MutationObserver: class { observe() {} disconnect() {} },
  location: { hash: '' },
  Dom: { escapeHtml: value => value },
  setHTML() {}
};

vm.runInNewContext(source, context);
const page = context.window.BloraAgentPage;
page.bind();
assert.equal(page.bound, true);
page.bind();
assert.equal(page.bound, true);
console.log('Agent page binds once synchronously and ignores repeated calls.');
