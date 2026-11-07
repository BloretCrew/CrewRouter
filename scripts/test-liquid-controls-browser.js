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
    await sleep(400);

    const checkbox = await cdp.evaluate(`(() => {
      const host = document.querySelector('blora-checkbox.schedule-day, blora-checkbox');
      const box = host && host.querySelector('.blora-checkbox__box');
      if (!box) return null;
      const cs = getComputedStyle(box);
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      host.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const input = host.querySelector('input');
      return {
        w: cs.width, r: cs.borderRadius, bg: cs.backgroundColor,
        checked: !!(input && input.checked), accent,
      };
    })()`);
    assert.ok(checkbox, '找到 blora-checkbox');
    assert.equal(checkbox.w, '18px', 'checkbox 宽 18px');
    assert.equal(checkbox.r, '6px', 'checkbox 圆角 6px');
    if (checkbox.checked) assert.equal(checkbox.bg, checkbox.accent, '选中 checkbox 用强调色');

    await cdp.evaluate(`document.getElementById('createKeyTagPopover').show()`);
    await sleep(200);
    await cdp.evaluate(`CrewRouterLiquid.scan()`);
    await sleep(200);
    const radio = await cdp.evaluate(`(() => {
      const host = document.querySelector('#createKeyTagColors blora-radio');
      const dot = host && host.querySelector('.blora-radio__dot');
      if (!dot) return null;
      const cs = getComputedStyle(dot);
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      host.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { w: cs.width, r: cs.borderRadius, border: cs.borderTopColor, accent, checked: !!host.querySelector('input:checked') };
    })()`);
    assert.ok(radio, '找到 blora-radio');
    assert.equal(radio.w, '18px', 'radio 宽 18px');
    if (radio.checked) assert.equal(radio.border, radio.accent, '选中 radio 边框强调色');
    await cdp.evaluate(`document.getElementById('createKeyTagPopover').close()`);

    await cdp.evaluate(`(() => {
      const modal = document.getElementById('usageScriptModal');
      const bar = document.getElementById('ccsBarOptions');
      if (bar) bar.hidden = false;
      modal.show();
    })()`);
    await sleep(200);
    await cdp.evaluate(`CrewRouterLiquid.scan()`);
    await sleep(200);
    const slider = await cdp.evaluate(`(() => {
      const input = document.querySelector('#ccsBarLength .blora-slider__input, blora-slider .blora-slider__input');
      if (!input) return null;
      const cs = getComputedStyle(input);
      return { h: cs.height, accent: cs.accentColor, bg: cs.backgroundImage || cs.background };
    })()`);
    assert.ok(slider, '找到 blora-slider');
    assert.equal(slider.h, '6px', 'slider 轨道高度');
    assert.ok(slider.accent !== 'auto' && slider.accent !== '', 'slider accent-color');
    await cdp.evaluate(`document.getElementById('usageScriptModal').close()`);

    const pagination = await cdp.evaluate(`(() => {
      const item = document.querySelector('#sessionsPagination .blora-pagination__item[aria-current="page"], .blora-pagination__item');
      if (!item) return { missing: true };
      const cs = getComputedStyle(item);
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      item.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { current: item.getAttribute('aria-current') === 'page', bg: cs.backgroundColor, accent, radius: cs.borderRadius };
    })()`);
    if (!pagination.missing && pagination.current) {
      assert.equal(pagination.bg, pagination.accent, '分页当前页强调色');
    }

    const dynamic = await cdp.evaluate(`(async () => {
      const d = document.createElement('blora-dialog');
      d.id = 'lgProbeDialog';
      d.innerHTML = '<span slot="title">probe</span><p>dynamic</p>';
      document.body.append(d);
      if (d.show) d.show(); else d.setAttribute('open', '');
      CrewRouterLiquid.scan();
      await new Promise(r => setTimeout(r, 80));
      CrewRouterLiquid.scan();
      const panel = d.querySelector('.modal-content') || (d.shadowRoot && d.shadowRoot.querySelector('[part="panel"]'));
      const lens = d.style.getPropertyValue('--lens') || (panel && panel.style.getPropertyValue('--lens')) || getComputedStyle(d).getPropertyValue('--lens');
      const mask = d.shadowRoot && d.shadowRoot.querySelector('.blora-dialog__mask, .blora-dialog__backdrop');
      const maskBlur = mask ? getComputedStyle(mask).backdropFilter : 'none';
      const out = {
        scoped: d.classList.contains('lg-scope'),
        open: d.hasAttribute('open'),
        lens,
        maskBlur,
        panelBg: panel ? getComputedStyle(panel).backgroundColor : '',
      };
      d.close ? d.close() : d.removeAttribute('open');
      d.remove();
      return out;
    })()`);
    assert.ok(dynamic.scoped, '动态对话框自动 lg-scope');
    assert.ok(dynamic.open, '动态对话框打开过');
    assert.match(dynamic.lens || '', /^url\(/, '动态对话框透镜');
    assert.ok(!/blur\(/.test(dynamic.maskBlur || 'none'), '动态对话框遮罩无 blur');

    const toast = await cdp.evaluate(`(() => {
      const card = CrewRouterLiquid.toast('晶液探针', 'success');
      CrewRouterLiquid.scan();
      const cs = getComputedStyle(card);
      const symbol = card.querySelector('.toast-symbol');
      const symbolBg = symbol ? getComputedStyle(symbol).backgroundColor : '';
      return {
        kind: card.dataset.kind,
        radius: cs.borderRadius,
        bg: cs.backgroundColor,
        filter: cs.backdropFilter || cs.webkitBackdropFilter,
        lens: card.style.getPropertyValue('--lens') || cs.getPropertyValue('--lens'),
        hasSymbol: !!symbol,
        symbolBg,
        solidGreen: /^(rgb\\(22,\\s*163,\\s*74\\)|#16a34a)$/i.test(cs.backgroundColor.replace(/\\s/g, '')),
      };
    })()`);
    assert.equal(toast.kind, 'success', 'toast kind=success');
    assert.ok(toast.hasSymbol, 'toast 有彩色圆点');
    assert.equal(toast.radius, '22px', 'toast 圆角 22px');
    assert.equal(toast.solidGreen, false, 'toast 不是实心绿色条');
    assert.match(toast.filter || '', /url\(|blur\(/, 'toast 有透镜或回退模糊');

    const picker = await cdp.evaluate(`(() => {
      const overlay = document.createElement('div');
      overlay.id = 'scriptAiModelPickerOverlay';
      overlay.className = 'script-ai-model-picker-overlay lg-scope';
      overlay.innerHTML = '<div role="dialog" class="script-ai-model-picker"><p>probe</p></div>';
      document.body.append(overlay);
      CrewRouterLiquid.scan();
      const panel = overlay.querySelector('[role="dialog"]');
      const cs = getComputedStyle(panel);
      const out = {
        radius: cs.borderRadius,
        border: cs.borderTopWidth,
        filter: cs.backdropFilter || cs.webkitBackdropFilter,
        lens: panel.style.getPropertyValue('--lens') || cs.getPropertyValue('--lens'),
        overlayBg: getComputedStyle(overlay).backgroundColor,
      };
      overlay.remove();
      return out;
    })()`);
    assert.equal(picker.radius, '32px', '模型选择器圆角 32px');
    assert.equal(picker.border, '0px', '模型选择器无描边');
    assert.match(picker.filter || '', /url\(|blur\(/, '模型选择器透镜');

    const navbar = await cdp.evaluate(`(() => {
      const host = document.createElement('blora-navbar');
      host.setAttribute('brand-href', '/');
      host.setAttribute('title', 'CrewRouter');
      host.setAttribute('variant', 'floating');
      host.className = 'public-navbar';
      document.body.append(host);
      const bar = host.querySelector('.blora-navbar');
      if (!bar) return { missing: true };
      CrewRouterLiquid.scan();
      const cs = getComputedStyle(bar);
      const before = getComputedStyle(bar, '::before');
      const out = {
        missing: false,
        radius: cs.borderRadius,
        border: cs.borderTopWidth,
        filter: cs.backdropFilter || cs.webkitBackdropFilter,
        lens: bar.style.getPropertyValue('--lens') || cs.getPropertyValue('--lens'),
        beforeFilter: before.backdropFilter || before.webkitBackdropFilter || 'none',
        beforeDisplay: before.display,
      };
      host.remove();
      return out;
    })()`);
    assert.equal(navbar.missing, false, '公开页有悬浮导航');
    assert.ok(!/blur\(20px\)/.test(navbar.beforeFilter || ''), '导航 ::before 无 vendor blur(20px)');
    assert.match(navbar.filter || '', /url\(|blur\(/, '导航胶囊透镜');

    console.log('PASS liquid controls + dynamic dialog + toast + navbar');
  } finally {
    cdp.ws.close();
    await fetch(`${debug}/json/close/${target.id}`).catch(() => {});
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
