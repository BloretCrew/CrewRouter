'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const css = fs.readFileSync('public/css/sidebar-blora.css', 'utf8');
assert.ok(css.includes('#mobileSidebarDrawer .blora-drawer[data-position="left"] .blora-drawer__panel'));
assert.ok(css.includes('width: min(300px, 88vw)'));
assert.match(css, /mobile-sidebar-drawer-content \.sidebar-nav\s*\{[^}]*overflow-y:\s*auto/s);
assert.match(css, /mobile-sidebar-drawer-content \.sidebar-footer\s*\{[^}]*flex:\s*0 0 auto/s);

for (const page of ['console', 'admin']) {
  const html = fs.readFileSync(`public/pages/${page}.html`, 'utf8');
  assert.match(html, /dataset\.mobileUserAvatar/);
  assert.match(html, /dataset\.mobileUsername/);
  assert.match(html, /window\.syncMobileSidebarUserInfo = syncUserInfo/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length, `${page} should contain inline scripts`);
  for (const script of scripts) new vm.Script(script[1], { filename: `${page}.inline.js` });
}

for (const file of ['public/js/app.js', 'public/js/admin.js']) {
  const source = fs.readFileSync(file, 'utf8');
  new vm.Script(source, { filename: file });
  assert.match(source, /window\.syncMobileSidebarUserInfo\?\.\(\)/);
  assert.match(source, /avatarEl\.classList\.add\('avatar-fallback'\)/);
}

console.log('Mobile sidebar contract: PASS');
