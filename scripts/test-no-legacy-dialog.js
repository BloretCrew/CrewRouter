#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));

assert.ok(!pkg.dependencies['@fluentui/web-components'], 'Fluent UI must not be a production dependency');
assert.ok(!lock.packages['']?.dependencies?.['@fluentui/web-components'], 'Fluent UI must not be locked as a root dependency');
assert.ok(!Object.keys(lock.packages).some((name) => name.includes('@fluentui/')), 'Fluent UI packages must not remain in the lockfile');

const pagesDir = path.join(root, 'public/pages');
for (const name of fs.readdirSync(pagesDir).filter((entry) => entry.endsWith('.html') && !entry.endsWith('.bak'))) {
  const html = fs.readFileSync(path.join(pagesDir, name), 'utf8');
  assert.ok(!html.includes('/js/dialog.js'), `${name} must not load the legacy dialog script`);
}
const dialog = fs.readFileSync(path.join(root, 'public/js/blora-dialog.js'), 'utf8');
assert.match(dialog, /createElement\(['"]blora-dialog['"]\)/, 'dialog adapter must create official Blora dialogs');
assert.doesNotMatch(dialog, /dialog-overlay|dialog-panel|dialog-btn/, 'dialog adapter must not render legacy dialog classes');
console.log('No Fluent dependency or legacy dialog entrypoint checks passed.');
