#!/usr/bin/env node
'use strict';
/**
 * 浏览器回归：模型库顶部不再展示已关闭（禁用）的 API Key。
 *
 * 前置：先启动隔离演示服务与无头 Chrome：
 *   node scripts/verify-blora-correction-browser.js --server
 *   node scripts/verify-blora-correction-browser.js --chrome
 *   node scripts/test-library-closed-keys-browser.js
 *
 * 断言覆盖（1440px 与 390px 各一轮）：
 *  - 演示 Key 均启用时芯片、绑定栏正常，点击芯片可切换当前 Key
 *  - 点击模型仍能正常绑定（主路径不回归）
 *  - 单个 Key 被关闭后从顶部芯片、绑定栏消失
 *  - 全部 Key 被关闭时芯片清空、显示「去启用」引导，点击模型给出关闭提示并跳转
 *  - API Key 页面仍展示被关闭的 Key（可在原处重新启用）
 *  - 顶部 Key 区域无横向溢出
 */
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
    assert.equal(typeof expression, 'string', 'evaluate() requires a string expression');
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

const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';

/** 模型展示名可能是展示名也可能是模型 id（演示数据两种都出现过） */
const MODEL_NAME = /GPT-4\.1|gpt-4\.1|DeepSeek V3|deepseek-chat/;
const keyFixture = (closedIds) => `(() => {
  const original = window.fetch.bind(window);
  window.__closedKeys = ${JSON.stringify(closedIds.map(String))};
  window.fetch = async (url, options = {}) => {
    const response = await original(url, options);
    if (String(url) !== '/api/user/api-keys') return response;
    const keys = await response.clone().json();
    return new Response(JSON.stringify(keys.map(key => (
      window.__closedKeys.includes(String(key.id)) ? { ...key, enabled: false } : { ...key, enabled: true }
    ))), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})()`;

const chipState = () => `(() => {
  const chips = [...document.querySelectorAll('#libraryKeyChips .model-library-key-item')].map(el => ({
    id: el.dataset.keyId,
    name: el.querySelector('.key-name')?.textContent || '',
    active: el.classList.contains('active'),
  }));
  const selector = document.getElementById('modelLibraryKeySelector');
  const summary = document.getElementById('modelLibraryBindingSummary');
  const bar = document.getElementById('modelLibraryBindingBar');
  return {
    chips,
    selectorHidden: selector ? getComputedStyle(selector).display === 'none' : null,
    summaryText: summary ? summary.textContent.replace(/\\s+/g, ' ').trim() : '',
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    barScroll: bar ? bar.scrollWidth : null,
    barClient: bar ? bar.clientWidth : null,
  };
})()`;

/** 点击模型卡片上不触发其它交互的空白处（避开星标按钮、可用率图与操作区） */
const MODEL_CLICK_POINT = `(() => {
  const interactive = '.model-uptime, .model-star-btn, .model-library-item-actions, blora-dropdown, button';
  const candidates = [[0.5, 0.28], [0.5, 0.5], [0.75, 0.28], [0.3, 0.5], [0.5, 0.72], [0.2, 0.2]];
  for (const el of document.querySelectorAll('.model-library-item')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // 只考虑当前视口内（含吸附顶栏之外）的卡片
    if (r.bottom < 0 || r.top > innerHeight) continue;
    for (const [fx, fy] of candidates) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit)) continue;
      if (hit.closest(interactive)) continue;
      return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
})()`;

/** 把第一个模型卡片滚到视口中间，避免点中吸附顶栏 */
const SCROLL_FIRST_MODEL = `(() => {
  const el = document.querySelector('.model-library-item');
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return true;
})()`;

const waitFor = async (cdp, expression, label) => {
  for (let i = 0; i < 120; i++) {
    if (await cdp.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${label} :: ${JSON.stringify(await cdp.evaluate(chipState()))}`);
};

async function main() {
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(res => res.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  let assertions = 0;
  const check = async (expression, message) => {
    if (typeof expression !== 'string') { assert.ok(expression, message); assertions++; return; }
    assert.ok(await cdp.evaluate(expression), message); assertions++;
  };
  const equal = async (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
  const captureToasts = () => cdp.evaluate(`(() => {
    if (window.__toastWrapped) { app._lastToast = null; return; }
    window.__toastWrapped = true;
    app._lastToast = null;
    const wrapped = app.showToast.bind(app);
    app.showToast = (msg, type) => { app._lastToast = { msg: String(msg), type }; return wrapped(msg, type); };
  })()`);
  try {
    await cdp.send('Page.enable');
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/console#modelLibrary` });
      await waitFor(cdp, `typeof app !== 'undefined' && !!app.user && !!document.querySelector('#libraryKeyChips .model-library-key-item')`, `console ready at ${width}px`);
      await sleep(600);

      // 1) 演示 Key 均启用：两个芯片 + 绑定栏展示当前 Key 与其模型
      const initial = await cdp.evaluate(chipState());
      await equal(initial.chips.map(c => c.name).sort(), ['生产环境 Key', '测试环境 Key'].sort(), `${width}px 默认芯片包含全部启用的 Key`);
      await equal(initial.selectorHidden, false, `${width}px 有 Key 时切换区域可见`);
      await check(initial.summaryText.includes('生产环境 Key') || initial.summaryText.includes('测试环境 Key'), `${width}px 绑定栏展示当前 Key`);
      await check(MODEL_NAME.test(initial.summaryText), `${width}px 绑定栏展示当前 Key 的绑定模型`);
      await check(initial.docScroll <= initial.docClient + 1 && initial.barScroll <= initial.barClient + 1, `${width}px 顶部 Key 区域无横向溢出`);

      // 2) 交互：点击另一个芯片切换当前 Key
      const other = initial.chips.find(c => !c.active);
      assert.ok(await cdp.click(`#libraryKeyChips .model-library-key-item[data-key-id="${other.id}"]`), `click chip ${other.id}`);
      await waitFor(cdp, `document.querySelector('#libraryKeyChips .model-library-key-item[data-key-id="${other.id}"]').classList.contains('active')`, 'chip becomes active');
      const switched = await cdp.evaluate(chipState());
      await check(switched.summaryText.includes(other.name), `${width}px 绑定栏跟随点击的 Key`);
      await check(switched.chips.length === 2, `${width}px 切换后仍有两个芯片`);

      // 3) 主路径不回归：启用态下点击模型仍可绑定
      await cdp.evaluate(`document.querySelector('.model-library-provider-header').click()`);
      await sleep(1200);
      await cdp.evaluate(SCROLL_FIRST_MODEL);
      await sleep(300);
      const bindPoint = await cdp.evaluate(MODEL_CLICK_POINT);
      assert.ok(bindPoint, `${width}px 找到可点击的模型卡片空白处`);
      await captureToasts();
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...bindPoint });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...bindPoint });
      await sleep(700);
      const bindToast = await cdp.evaluate('app._lastToast');
      await check(!!bindToast && /已绑定|队列/.test(bindToast.msg), `${width}px 启用态点击模型仍可绑定（${bindToast && bindToast.msg}）`);

      // 4) 关闭一个 Key 后重新加载模型库：顶部不再展示它
      await cdp.evaluate(keyFixture([Number(other.id)]));
      await cdp.evaluate('app.loadModelLibrary()');
      await waitFor(cdp, `document.querySelectorAll('#libraryKeyChips .model-library-key-item').length === 1`, 'closed key chip removed');
      const afterClose = await cdp.evaluate(chipState());
      await equal(afterClose.chips.map(c => c.id), [String(initial.chips.find(c => c.active).id)], `${width}px 只保留仍启用的 Key 芯片`);
      await check(!afterClose.summaryText.includes(other.name), `${width}px 已关闭的 Key 不出现在绑定栏`);
      await check(afterClose.docScroll <= afterClose.docClient + 1 && afterClose.barScroll <= afterClose.barClient + 1, `${width}px 关闭后仍无横向溢出`);

      // 5) 关闭全部 Key：芯片清空、给出「去启用」引导
      await cdp.evaluate(keyFixture(initial.chips.map(c => Number(c.id))));
      await cdp.evaluate('app.loadModelLibrary()');
      await waitFor(cdp, `document.querySelectorAll('#libraryKeyChips .model-library-key-item').length === 0`, 'all chips cleared');
      await sleep(300);
      const allClosed = await cdp.evaluate(chipState());
      await equal(allClosed.chips, [], `${width}px 全部关闭时芯片为空`);
      await equal(allClosed.selectorHidden, true, `${width}px 全部关闭时隐藏 Key 切换区域`);
      await check(allClosed.summaryText.includes('API Key 已全部关闭'), `${width}px 全部关闭时提示已全部关闭`);
      await check(allClosed.summaryText.includes('去启用 API Key'), `${width}px 引导按钮为去启用`);
      await check(!allClosed.summaryText.includes('还没有 API Key'), `${width}px 不再提示创建 Key`);

      // 6) 真实交互：全部关闭时点击模型给出关闭提示并跳转 API Key 页
      await cdp.evaluate(`document.querySelector('.model-library-provider-header').click()`);
      await sleep(1200);
      await cdp.evaluate(SCROLL_FIRST_MODEL);
      await sleep(300);
      const closedPoint = await cdp.evaluate(MODEL_CLICK_POINT);
      assert.ok(closedPoint, `${width}px 全部关闭时仍找到可点击的模型卡片`);
      await captureToasts();
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...closedPoint });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...closedPoint });
      await sleep(800);
      const closedToast = await cdp.evaluate('app._lastToast');
      await check(!!closedToast && closedToast.msg.includes('已全部关闭'), `${width}px 全部关闭时点击模型提示先启用 Key（${closedToast && closedToast.msg}）`);
      await check((await cdp.evaluate('location.hash')) === '#apiKeys', `${width}px 全部关闭时点击模型跳转 API Key 页`);

      // 7) API Key 页面回归：被关闭的 Key 仍可查看与启用
      await sleep(600);
      await waitFor(cdp, `document.querySelectorAll('#apiKeysList .api-key-card').length >= 2`, 'api key page rendered');
      const keyCards = await cdp.evaluate(`[...document.querySelectorAll('#apiKeysList .api-key-card')].map(el => el.textContent.replace(/\\s+/g, ' '))`);
      await check(keyCards.some(text => text.includes('已禁用')), `${width}px API Key 页面仍标记已禁用的 Key`);
      await check((await cdp.evaluate(`document.querySelectorAll('#apiKeysList .api-key-card').length`)) >= 2, `${width}px API Key 页面仍列出全部 Key`);
      await check((await cdp.evaluate(`document.querySelectorAll('#apiKeysList .api-key-enable-toggle').length`)) >= 2, `${width}px API Key 页面保留启用开关`);

      // 8) 恢复启用后模型库顶部恢复
      await cdp.evaluate(keyFixture([]));
      await cdp.evaluate('location.hash = "#modelLibrary"');
      await waitFor(cdp, `document.querySelectorAll('#libraryKeyChips .model-library-key-item').length === 2`, 'restored chips');
      const restored = await cdp.evaluate(chipState());
      await equal(restored.chips.length, 2, `${width}px 恢复启用后芯片回来`);
      await check(MODEL_NAME.test(restored.summaryText), `${width}px 恢复后绑定栏展示绑定模型`);
      await check(restored.docScroll <= restored.docClient + 1, `${width}px 恢复后无横向溢出`);

      console.log(`PASS model-library closed keys @ ${width}px (${assertions} assertions so far)`);
    }
    console.log(`PASS ${assertions} browser assertions`);
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
