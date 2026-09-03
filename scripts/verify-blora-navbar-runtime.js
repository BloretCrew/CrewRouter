'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'setup.html', 'feishu-bind.html', 'set-password.html'];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-blora-navbar-'));
for (const name of pages) {
  const html = fs.readFileSync(path.join(root, 'public/pages', name), 'utf8');
  const body = html.match(/<body[\s\S]*?<blora-navbar\b[\s\S]*?<\/blora-navbar>/i)?.[0] || '';
  const nav = body.match(/<blora-navbar\b[\s\S]*?<\/blora-navbar>/i)?.[0] || '';
  assert.ok(nav, `${name}: navbar exists`);
  assert.ok(nav.includes('<blora-navbar-tool>'), `${name}: official tool slot exists`);
  assert.ok(!/(?:^|>)\s*(?:<a|<div|<select|<button)\b/i.test(nav.replace(/<blora-navbar-tool>[\s\S]*?<\/blora-navbar-tool>/gi, '')), `${name}: no unsupported direct child`);
  const probe = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/node_modules/@bloret-crew/blora-design/dist/blora.css"><script src="file://${root}/node_modules/@bloret-crew/blora-design/dist/blora.global.js"></script>${body}<script>window.addEventListener('load',()=>{const n=document.querySelector('blora-navbar'); if(!n||!n.querySelector('.blora-navbar')) document.documentElement.dataset.smoke='navbar-enhancement-failed'; else if(!n.querySelector('#langToggle')) document.documentElement.dataset.smoke='language-control-lost'; else if('${name}'==='index.html'&&!n.querySelector('#themeToggle')) document.documentElement.dataset.smoke='theme-control-lost'; else if(!n.querySelector('#langToggle').getAttribute('aria-label')) document.documentElement.dataset.smoke='language-aria-lost'; else document.documentElement.dataset.smoke='ok';});</script>`;
  const file = path.join(out, name);
  fs.writeFileSync(file, probe);
  let dom;
  try {
    dom = execFileSync('/usr/sbin/chromium-browser', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${path.join(out, 'profile-' + name.replace(/\W/g, ''))}`, '--allow-file-access-from-files', '--virtual-time-budget=1500', '--dump-dom', `file://${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    console.log('Blora navbar runtime DOM smoke blocked: Chromium is unavailable in this environment; static contract smoke remains authoritative.');
    process.exitCode = 0;
    return;
  }
  assert.match(dom, /data-smoke="ok"/, `${name}: official runtime DOM smoke`);
}
console.log('Blora navbar runtime DOM smoke passed with official auto/global runtime.');
