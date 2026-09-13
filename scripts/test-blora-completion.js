'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const pages = fs.readdirSync(path.join(root, 'public/pages')).filter(n => n.endsWith('.html') && !n.endsWith('.bak'));
for (const name of pages) {
  const html = fs.readFileSync(path.join(root, 'public/pages', name), 'utf8');
  assert.match(html, /blora-page/ , `${name}: missing Blora page`);
  assert.match(html, /blora-scope/, `${name}: missing Blora scope`);
  assert.match(html, /\/js\/blora-theme\.js\?v=1/, `${name}: missing shared theme bridge`);
  assert.doesNotMatch(html, /<select\b/i, `${name}: native select remains`);
}
const js = fs.readFileSync(path.join(root, 'public/js/blora-theme.js'), 'utf8');
assert.match(js, /data-blora-color-scheme/);
assert.match(js, /prefers-color-scheme/);
assert.match(js, /direction === 'rtl'/);
console.log(`Blora completion static checks passed for ${pages.length} pages.`);
