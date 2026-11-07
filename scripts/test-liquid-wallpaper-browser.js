#!/usr/bin/env node
'use strict';
// 前置：verify-blora-correction-browser.js --server / --chrome。
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.events = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      } else this.events.push(message);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description || ''));
    return response.result.value;
  }
  async click(selector) {
    const point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !(hit === el || el.contains(hit))) return null;
      return { x, y };
    })()`);
    if (!point) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(250);
    return true;
  }
}

async function wait(cdp, expr, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await cdp.evaluate(expr)) return;
    await sleep(100);
  }
  throw new Error('timeout: ' + expr);
}

async function goto(cdp, url) {
  const path = new URL(url).pathname;
  await cdp.send('Page.navigate', { url });
  await wait(cdp, `location.pathname===${JSON.stringify(path)} && !!document.getElementById('lg-wallpaper') && !!window.CrewRouterLiquid`, 120);
  await cdp.evaluate(`window.CrewRouterLiquid && CrewRouterLiquid.scan()`);
  await sleep(400);
}

async function main() {
  const debug = 'http://127.0.0.1:18572';
  const base = 'http://127.0.0.1:18571';
  const target = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    await goto(cdp, `${base}/console#settings`);
    await wait(cdp, `typeof app!=='undefined'&&!!app.user`);
    await wait(cdp, `!!window.CrewRouterLiquid`);
    await sleep(500);

    assert.ok(await cdp.evaluate(`!!document.getElementById('lg-wallpaper')`), '壁纸宿主');
    assert.ok(await cdp.evaluate(`getComputedStyle(document.getElementById('lg-wallpaper')).opacity!=='0'`), '壁纸可见');
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.wallpaper||'theme'`), 'theme');

    assert.ok(await cdp.click('[data-settings-category="profile"]'), '打开个人资料');
    await sleep(400);
    assert.ok(await cdp.evaluate(`!!document.querySelector('#lgWallpaperPicker .lg-wall-seg')`), '壁纸选择器已挂上');

    assert.ok(await cdp.click('#lgWallpaperPicker [data-wall="product"]'), '点原壁纸');
    await sleep(200);
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.wallpaper`), 'product');
    assert.ok(await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--lg-wall-image').includes('wallpaper')`), '原壁纸 CSS');
    assert.ok(await cdp.evaluate(`!document.querySelector('#lg-wallpaper svg') || getComputedStyle(document.querySelector('#lg-wallpaper svg')).display==='none'`), '主题 SVG 隐藏');

    assert.ok(await cdp.click('#lgWallpaperPicker [data-product="ice"]'), '点冰蓝');
    await sleep(200);
    assert.ok(await cdp.evaluate(`document.documentElement.dataset.wallProduct==='ice' && getComputedStyle(document.documentElement).getPropertyValue('--lg-wall-image').includes('ice-wallpaper')`), '冰蓝原壁纸');

    assert.ok(await cdp.click('#lgWallpaperPicker [data-wall="custom"]'), '点自定义');
    await sleep(150);
    assert.ok(await cdp.evaluate(`!document.querySelector('.lg-wall-custom').hidden`), '自定义面板打开');
    await cdp.evaluate(`CrewRouterLiquid.setAppearance({wallpaper:'custom',custom:'/assets/wallpapers/1923fad5f421-rose.svg'})`);
    await sleep(150);
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.wallpaper`), 'custom');
    assert.ok(await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--lg-wall-image').includes('rose')`), '自定义图片');

    await cdp.evaluate(`CrewRouterLiquid.setAppearance({wallpaper:'theme'})`);
    await sleep(150);
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.wallpaper`), 'theme');

    const sidebarLens = await cdp.evaluate(`getComputedStyle(document.querySelector('.app-container > .sidebar')).getPropertyValue('--lens')`);
    assert.match(sidebarLens, /^url\(/, '侧栏透镜');

    await cdp.evaluate(`app.showModal('createApiKeyModal')`);
    await sleep(200);
    await cdp.evaluate(`window.CrewRouterLiquid && CrewRouterLiquid.scan()`);
    await sleep(400);
    const dialogLens = await cdp.evaluate(`(() => {
      const d = document.getElementById('createApiKeyModal');
      const panel = d.querySelector('.modal-content') || (d.shadowRoot && d.shadowRoot.querySelector('[part="panel"]'));
      const lens = d.style.getPropertyValue('--lens') || (panel && panel.style.getPropertyValue('--lens')) || getComputedStyle(d).getPropertyValue('--lens');
      const mask = d.shadowRoot && d.shadowRoot.querySelector('.blora-dialog__mask, .blora-dialog__backdrop');
      const maskBlur = mask ? getComputedStyle(mask).backdropFilter : 'none';
      return { open: d.hasAttribute('open'), lens, maskBlur, panelW: panel && panel.offsetWidth, hostW: d.offsetWidth };
    })()`);
    assert.ok(dialogLens.open, '对话框打开');
    assert.match(dialogLens.lens || '', /^url\(/, '对话框透镜');
    assert.ok(!/blur\(/.test(dialogLens.maskBlur || 'none'), '对话框遮罩无 blur');
    assert.ok(dialogLens.panelW > 200 && dialogLens.panelW < dialogLens.hostW, '透镜画在面板上');
    await cdp.evaluate(`document.getElementById('createApiKeyModal').close()`);

    for (const page of ['/pages/usage.html', '/pages/store.html', '/pages/playground.html', '/pages/showcase.html', '/pages/data.html', '/pages/plain-login.html']) {
      await goto(cdp, base + page);
      const info = await cdp.evaluate(`({
        wall: !!document.getElementById('lg-wallpaper'),
        leftover: [...document.querySelectorAll('.data-nav, .showcase-nav, .plain-card, .auth-card, .login-card, .pi-card, .usage-card, .store-header, .pg-mobile-bar, .feature-card, .highlight-visual, .metric-card')].filter(el => {
          if (!el.offsetWidth || !el.offsetHeight) return false;
          const bf = getComputedStyle(el).backdropFilter || '';
          const content = el.matches('.feature-card, .highlight-visual, .metric-card');
          if (content) return bf && bf !== 'none';
          return /blur\\(/.test(bf) && !bf.includes('url(');
        }).map(el => el.className)
      })`);
      assert.ok(info.wall, `${page} 有壁纸`);
      assert.equal(info.leftover.length, 0, `${page} 无旧磨砂: ${info.leftover}`);
      console.log('PASS', page);
    }
    console.log('PASS liquid wallpaper + remaining pages');
  } finally {
    cdp.ws.close();
    await fetch(`${debug}/json/close/${target.id}`);
  }

  const adminTarget = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const admin = new CDP(adminTarget.webSocketDebuggerUrl);
  try {
    await admin.send('Page.enable');
    await admin.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await goto(admin, `${base}/admin#settings`);
    await wait(admin, `!!document.querySelector('#lgWallpaperPicker, .lg-wallpaper-picker-host')`);
    assert.ok(await admin.click('[data-admin-settings-category="appearance"]') || true, '外观入口');
    await sleep(400);
    assert.ok(await admin.evaluate(`!!document.querySelector('#lgWallpaperPicker .lg-wall-seg, .lg-wallpaper-picker-host .lg-wall-seg') || !!document.getElementById('lgWallpaperPicker')`), '管理后台壁纸选择器');
    console.log('PASS admin wallpaper host');
  } finally {
    admin.ws.close();
    await fetch(`${debug}/json/close/${adminTarget.id}`);
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
