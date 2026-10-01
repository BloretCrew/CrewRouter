'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'setup.html', 'feishu-bind.html', 'set-password.html'];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-blora-navbar-'));
try {
  for (const name of pages) {
    const html = fs.readFileSync(path.join(root, 'public/pages', name), 'utf8');
    const language = html.match(/<blora-(?:dropdown|select)\b[^>]*id="langToggle"[\s\S]*?<\/blora-(?:dropdown|select)>/i)?.[0];
    assert.ok(language, `${name}: real language control exists`);
    const theme = html.match(/<button\b[^>]*id="themeToggle"[\s\S]*?<\/button>/i)?.[0] || '';
    const nav = html.match(/<blora-navbar\b[\s\S]*?<\/blora-navbar>/i)?.[0];
    if (['setup.html', 'feishu-bind.html'].includes(name)) {
      assert.ok(nav?.includes('<blora-navbar-tool>'), `${name}: official tool slot exists`);
      assert.ok(!/(?:^|>)\s*(?:<a|<div|<select|<button)\b/i.test(nav.replace(/<blora-navbar-tool>[\s\S]*?<\/blora-navbar-tool>/gi, '')), `${name}: no unsupported direct child`);
    } else assert.ok(theme, `${name}: real theme button exists`);
    const controlMarkup = nav || `${language}${theme}`;
    const probe = `<!doctype html><meta charset="utf-8"><script>window.t=v=>v;</script><link rel="stylesheet" href="file://${root}/node_modules/@bloret-crew/blora-design/dist/blora.css">${controlMarkup}<script src="file://${root}/node_modules/@bloret-crew/blora-design/dist/blora.global.js"></script><script src="file://${root}/public/js/theme.js"></script><script>window.addEventListener('load',()=>{setTimeout(()=>{try {
      const lang=document.querySelector('#langToggle');
      if (!customElements.get(lang.localName)||!lang.getAttribute('aria-label')) throw Error('official language control or accessible name lost');
      if (lang.localName==='blora-dropdown') {
        const trigger=lang.querySelector('button[slot="trigger"]');
        if (!trigger||trigger.type!=='button') throw Error('language trigger lost');
        trigger.click();
        if (trigger.getAttribute('aria-expanded')!=='true'||lang.querySelector('[role="menu"]').getAttribute('aria-hidden')!=='false') throw Error('dropdown does not open');
        const links=Array.from(lang.querySelectorAll('a[href]'));
        if (!links.some(a=>a.getAttribute('href').includes('lang=zh'))||!links.some(a=>a.getAttribute('href').includes('lang=en'))) throw Error('language navigation lost');
        lang.close();
      } else {
        const trigger=lang.shadowRoot?.querySelector('button[role="combobox"]');
        if (!trigger) throw Error('select enhancement failed');
        trigger.click();
        if (trigger.getAttribute('aria-expanded')!=='true') throw Error('select does not open');
        const option=lang.shadowRoot.querySelectorAll('[role="option"]')[1];
        if(!option) throw Error('language option lost');
        option.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,composed:true}));
        if (lang.value!=='en') throw Error('language selection failed');
      }
      const button=document.querySelector('#themeToggle');
      if(button){ localStorage.setItem('theme','light'); window.themeManager.theme='light'; window.themeManager.applyTheme(); button.click(); if(localStorage.getItem('theme')!=='dark'||document.documentElement.getAttribute('data-blora-color-scheme')!=='dark') throw Error('real theme action failed'); }
      const navbar=document.querySelector('blora-navbar'); if(navbar&&!navbar.querySelector('.blora-navbar')) throw Error('navbar enhancement failed');
      document.documentElement.dataset.smoke='ok';
    } catch(error) { document.documentElement.dataset.smoke=error.message; }},100);});</script>`;
    const file = path.join(out, name);
    fs.writeFileSync(file, probe);
    const dom = execFileSync('google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${path.join(out, 'profile-' + name.replace(/\W/g, ''))}`, '--allow-file-access-from-files', '--virtual-time-budget=2000', '--dump-dom', `file://${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    assert.match(dom, /data-smoke="ok"/, `${name}: official language/theme runtime smoke`);
    console.log(`${name}: official language/theme controls passed.`);
  }
  console.log('Blora public controls runtime DOM smoke passed.');
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
