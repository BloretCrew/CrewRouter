'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'setup.html', 'feishu-bind.html', 'set-password.html'];
const navbarContract = require(path.join(root, 'node_modules/@bloret-crew/blora-design/contracts/navbar.contract.json'));
const cardContract = require(path.join(root, 'node_modules/@bloret-crew/blora-design/contracts/card.contract.json'));
assert.ok(cardContract.classes['blora-card']);
assert.ok(cardContract.classes['blora-card__desc']);
const allowedNavbarChildren = (navbarContract.slots.default.match(/<blora-navbar-(?:link|action|tool)>/g) || []).map((tag) => tag.slice(1, -1));
assert.deepStrictEqual(allowedNavbarChildren, ['blora-navbar-link', 'blora-navbar-action', 'blora-navbar-tool']);
for (const name of pages) {
  const file = path.join(root, 'public/pages', name);
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /<body[^>]*class="[^"]*\bblora-page\b/);
  assert.match(html, /\/css\/auth-shell\.css/);
  assert.match(html, /\/blora\/auto\.js\?v=2\.1\.0/);
  assert.match(html, /<(?:blora-select|blora-dropdown)\b[^>]*id="langToggle"[^>]*aria-label="[^"]+"/);
  for (const language of ['zh', 'en']) assert.match(html, new RegExp(`<blora-(?:option|dropdown-item)\\b[^>]*value="${language}"`));
  if (['index.html', 'set-password.html'].includes(name)) {
    assert.match(html, /<button\b[^>]*id="themeToggle"[^>]*class="[^"]*blora-button[^>]*type="button"[^>]*aria-label="[^"]+"/);
    assert.match(html, /<blora-dropdown\b[^>]*id="langToggle"/);
    assert.match(html, /<button\b[^>]*slot="trigger"[^>]*type="button"/);
  } else {
    assert.match(html, /<blora-navbar\b[^>]*variant="floating"/);
    const navbar = html.match(/<blora-navbar\b[^>]*>([\s\S]*?)<\/blora-navbar>/i);
    assert.ok(navbar, `${name} navbar contract root`);
    const directChildren = navbar[1].replace(/<blora-navbar-tool\b[\s\S]*?<\/blora-navbar-tool>/gi, '').match(/<([a-z][\w-]*)\b[^>]*>/gi) || [];
    assert.deepStrictEqual(directChildren, [], `${name} navbar has unsupported direct children`);
    assert.strictEqual((navbar[1].match(/<blora-navbar-tool\b/g) || []).length, 1);
    assert.strictEqual((navbar[1].match(/<blora-navbar-(?:link|action)\b/g) || []).length, 0);
  }
  const surfaces = [...html.matchAll(/<[a-z][\w-]*\b[^>]*class="([^"]*)"[^>]*>/gi)]
    .map(match => new Set(match[1].split(/\s+/)))
    .filter(classes => classes.has('auth-card') || classes.has('setup-card'));
  assert.ok(surfaces.length > 0, `${name}: authentication surfaces exist`);
  for (const classes of surfaces) assert.ok(classes.has('blora-card'), `${name}: official Card surface`);
  assert.match(html, /class="[^"]*\bblora-h2\b/);
  assert.match(html, /class="[^"]*blora-input/);
  assert.match(html, /blora-button[^>]*data-variant="(primary|secondary)"/);
  assert.doesNotMatch(html, /--blora-[\w-]+\s*:/);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (script[1].trim()) assert.doesNotThrow(() => new vm.Script(script[1], { filename: file }), `${name} inline script syntax`);
  }
}
const css = fs.readFileSync(path.join(root, 'public/css/auth-shell.css'), 'utf8');
assert.doesNotMatch(css, /--blora-[\w-]+\s*:/);
assert.doesNotMatch(css, /(?:^|[;{])\s*(?:background(?:-color|-image)?|color|border(?:-(?:color|radius|width|style))?|box-shadow)\s*:/m, 'authentication CSS must compose official surfaces, not repaint them');
assert.match(css, /var\(--blora-space-\d+\)/, 'authentication layout uses public spacing tokens');
console.log('Blora public Batch A static checks passed.');
