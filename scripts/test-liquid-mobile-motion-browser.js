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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description || ''));
    return response.result.value;
  }
}

async function goto(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await sleep(900);
}

async function overflow(cdp) {
  return cdp.evaluate(`({
    inner: innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
  })`);
}

async function openTab(debug, metrics) {
  const target = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
  return { cdp, id: target.id };
}

async function closeTab(debug, session) {
  try { session.cdp.ws.close(); } catch { /* already closed */ }
  await fetch(`${debug}/json/close/${session.id}`).catch(() => {});
}

async function main() {
  const debug = 'http://127.0.0.1:18572';
  const base = 'http://127.0.0.1:18571';
  const desktop = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
  const phone = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

  const desktopTab = await openTab(debug, desktop);
  try {
    console.log('goto showcase 1440');
    await goto(desktopTab.cdp, `${base}/showcase`);
    const tokens = await desktopTab.cdp.evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const btn = document.querySelector('.nav-cta, .hero-buttons .btn-primary, .blora-button');
      const btnCs = btn ? getComputedStyle(btn) : null;
      return {
        spring: cs.getPropertyValue('--spring').trim(),
        springSoft: cs.getPropertyValue('--spring-soft').trim(),
        glide: cs.getPropertyValue('--glide').trim(),
        btnTransition: btnCs ? btnCs.transition : '',
        sheetIn: [...document.styleSheets].some(sheet => {
          try { return [...sheet.cssRules].some(r => r.name === 'lg-sheet-in'); }
          catch { return false; }
        }),
      };
    })()`);
    assert.equal(tokens.spring, 'cubic-bezier(.3, 1.45, .55, 1)', '晶液 --spring');
    assert.equal(tokens.springSoft, 'cubic-bezier(.25, 1.2, .5, 1)', '晶液 --spring-soft');
    assert.ok(tokens.glide.startsWith('linear('), '晶液 --glide');
    assert.match(tokens.btnTransition, /scale/, '按钮 transition 含 scale');
    assert.ok(tokens.sheetIn, '存在 lg-sheet-in 关键帧');

    const desktopOverflow = await overflow(desktopTab.cdp);
    assert.ok(desktopOverflow.overflow <= 1, `showcase 1440 无横向溢出 ${desktopOverflow.overflow}`);
  } finally {
    await closeTab(debug, desktopTab);
  }

  const pages = [
    ['/showcase', 'showcase'],
    ['/store', 'store'],
    ['/data', 'data'],
    ['/', 'login'],
    ['/setup', 'setup'],
    ['/playground', 'playground'],
    ['/console', 'console'],
    ['/admin', 'admin'],
    ['/usage', 'usage'],
    ['/purchase', 'purchase'],
  ];
  for (const [path, name] of pages) {
    const session = await openTab(debug, phone);
    try {
      console.log('goto', name, '390');
      await goto(session.cdp, `${base}${path}`);
      const box = await overflow(session.cdp);
      assert.ok(box.overflow <= 2, `${name} 390 无横向溢出 (${box.overflow}, html=${box.html}, inner=${box.inner})`);
      if (name === 'console' || name === 'admin') {
        const scroll = await session.cdp.evaluate(`(() => {
          const cs = el => getComputedStyle(el);
          const html = document.documentElement;
          const body = document.body;
          const main = document.querySelector('.main-content');
          const section = document.querySelector('.lg-page.active .content-section, .page.active .content-section');
          const nested = [...document.querySelectorAll('div, section, article, main, table')]
            .filter(el => {
              if (el.closest('blora-dialog, blora-drawer, .modal, .pg-container')) return false;
              const s = cs(el);
              const oy = s.overflowY;
              if (oy !== 'auto' && oy !== 'scroll') return false;
              const h = el.clientHeight;
              return h > 160 && el.scrollHeight > h + 8;
            })
            .map(el => ({
              tag: el.tagName.toLowerCase(),
              id: el.id || '',
              className: String(el.className || '').slice(0, 80),
              h: el.clientHeight,
              sh: el.scrollHeight,
              oy: cs(el).overflowY,
              ox: cs(el).overflowX,
            }));
          return {
            htmlOy: cs(html).overflowY,
            bodyOy: cs(body).overflowY,
            mainOy: main ? cs(main).overflowY : null,
            sectionOy: section ? cs(section).overflowY : null,
            nested,
          };
        })()`);
        assert.notEqual(scroll.bodyOy, 'auto', `${name} body 不应是纵向滚动容器`);
        assert.notEqual(scroll.bodyOy, 'scroll', `${name} body 不应是纵向滚动容器`);
        if (scroll.mainOy) {
          assert.notEqual(scroll.mainOy, 'auto', `${name} .main-content 不应是纵向滚动容器`);
          assert.notEqual(scroll.mainOy, 'scroll', `${name} .main-content 不应是纵向滚动容器`);
        }
        if (scroll.sectionOy) {
          assert.notEqual(scroll.sectionOy, 'auto', `${name} .content-section 不应是纵向滚动容器`);
          assert.notEqual(scroll.sectionOy, 'scroll', `${name} .content-section 不应是纵向滚动容器`);
        }
        const offenders = scroll.nested.filter(n =>
          /content-section|main-content|app-container|stats-table-card|blora-card|chart-card/.test(`${n.className} ${n.id}`)
        );
        assert.equal(offenders.length, 0, `${name} 区块不应各自滚动 ${JSON.stringify(offenders)}`);
      }
      if (name === 'showcase') {
        const mobileMotion = await session.cdp.evaluate(`(() => {
          const btn = document.querySelector('.nav-cta, .hero-buttons .btn-primary');
          const cs = btn ? getComputedStyle(btn) : null;
          const toast = document.createElement('div');
          toast.className = 'toast-stack';
          document.body.append(toast);
          const toastCs = getComputedStyle(toast);
          const left = toastCs.left;
          toast.remove();
          const dialogRule = [...document.styleSheets].flatMap(sheet => {
            try { return [...sheet.cssRules]; } catch { return []; }
          }).some(r => r instanceof CSSMediaRule && /390px|640px/.test(r.conditionText) && [...r.cssRules].some(x => /blora-dialog/.test(x.selectorText || '') && /22px/.test(x.cssText)));
          return {
            btnScale: cs ? cs.transition : '',
            toastLeft: left,
            dialogMobile: dialogRule,
          };
        })()`);
        assert.match(mobileMotion.btnScale, /scale/, '390 按钮仍有 scale 弹簧');
        assert.notEqual(mobileMotion.toastLeft, 'auto', '390 toast 铺满宽度');
        assert.ok(mobileMotion.dialogMobile, '640/390 对话框圆角 22px');
      }
    } finally {
      await closeTab(debug, session);
    }
  }

  const consoleTab = await openTab(debug, desktop);
  try {
    console.log('goto console 1440');
    await goto(consoleTab.cdp, `${base}/console`);
    const consoleMotion = await consoleTab.cdp.evaluate(`(() => {
      const btn = document.querySelector('.blora-button');
      const cs = btn ? getComputedStyle(btn) : null;
      const sidebar = document.querySelector('.business-sidebar-navigation .blora-sidebar-nav__link');
      const sideCs = sidebar ? getComputedStyle(sidebar) : null;
      return {
        btnTransition: cs ? cs.transition : '',
        sidebarTransition: sideCs ? sideCs.transition : '',
        path: location.pathname,
      };
    })()`);
    if (consoleMotion.path === '/console') {
      assert.match(consoleMotion.btnTransition, /scale/, '控制台按钮 scale 弹簧');
      if (consoleMotion.sidebarTransition) assert.match(consoleMotion.sidebarTransition, /scale/, '侧栏链接 scale 弹簧');
    }
  } finally {
    await closeTab(debug, consoleTab);
  }

  console.log('PASS liquid mobile + motion 390/1440');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
