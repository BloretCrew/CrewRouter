'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'setup.html', 'feishu-bind.html', 'set-password.html'];
for (const name of pages) {
  const file = path.join(root, 'public/pages', name);
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /<body[^>]*class="[^"]*\bblora-page\b/);
  assert.match(html, /\/css\/auth-shell\.css/);
  assert.match(html, /\/blora\/auto\.js\?v=2\.0\.8/);
  assert.match(html, /<blora-navbar\b[^>]*variant="floating"/);
  assert.match(html, /class="[^"]*blora-input/);
  assert.match(html, /blora-button[^>]*data-variant="(primary|secondary)"/);
  assert.doesNotMatch(html, /--blora-[\w-]+\s*:/);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (script[1].trim()) assert.doesNotThrow(() => new vm.Script(script[1], { filename: file }), `${name} inline script syntax`);
  }
}
const css = fs.readFileSync(path.join(root, 'public/css/auth-shell.css'), 'utf8');
assert.doesNotMatch(css, /--blora-[\w-]+\s*:/);
assert.match(css, /var\(--blora-color-action-primary-default\)/);
console.log('Blora public Batch A static checks passed.');
