#!/usr/bin/env node
'use strict';
// 前置：verify-blora-correction-browser.js --server / --chrome。
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
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

async function main() {
  const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
  const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';

  for (const width of [1440, 1024, 390]) {
    const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
    const cdp = new CDP(target.webSocketDebuggerUrl);
    const check = async (expression, label) => assert.ok(await cdp.evaluate(expression), label);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/admin?editor=${width}&run=${Date.now()}#adminProviders` });
      for (let i = 0; i < 120; i++) {
        if (await cdp.evaluate("typeof adminApp !== 'undefined' && !!document.querySelector('.provider-row-actions')")) break;
        await sleep(100);
      }
      assert.ok(await cdp.click('.provider-row-actions button[onclick*="editProviderById"]'), '编辑入口');
      await sleep(700);

      const panel = await cdp.evaluate(`(() => {
        const dialog = document.getElementById('addProviderModal');
        const box = dialog.shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height, innerWidth, innerHeight };
      })()`);
      if (width > 900) {
        assert.ok(panel.width >= 900 && panel.width < panel.innerWidth, `桌面编辑器宽度 ${JSON.stringify(panel)}`);
        assert.ok(panel.height >= 800 && panel.height <= panel.innerHeight, `桌面编辑器高度 ${JSON.stringify(panel)}`);
        await check("getComputedStyle(document.querySelector('#addProviderModal .provider-editor-pages')).flexDirection === 'column'", '桌面分区导航应为侧栏');
      } else {
        assert.ok(Math.abs(panel.width - panel.innerWidth) < 2, `小屏编辑器宽度 ${JSON.stringify(panel)}`);
        assert.ok(Math.abs(panel.height - panel.innerHeight) < 2, `小屏编辑器高度 ${JSON.stringify(panel)}`);
        await check("getComputedStyle(document.querySelector('#addProviderModal .provider-editor-pages')).flexDirection === 'row'", '小屏分区导航应横排');
      }
      await check("!!document.querySelector('#providerEditorSummary strong')", '编辑器标题摘要缺失');

      await cdp.evaluate(`document.getElementById('providerName').focus();document.getElementById('providerName').select()`);
      await cdp.send('Input.insertText', { text: 'Browser provider edit' });
      for (let i = 1; i < 7; i++) {
        assert.ok(await cdp.click('#providerEditorNext'), '下一页');
        await check(`adminApp._providerEditorPage === ${i} && document.querySelectorAll('#addProviderModal .provider-form-section:not([hidden])').length === 1`, '单页展示');
      }
      for (let i = 5; i >= 0; i--) assert.ok(await cdp.click('#providerEditorPrevious'), '上一页');
      await check("document.getElementById('providerName').value === 'Browser provider edit'", '输入保留');

      assert.ok(await cdp.click('#addProviderModal .provider-editor-header .modal-close'), '关闭编辑');
      await sleep(300);
      await check("!!document.querySelector('blora-dialog[open] [data-dialog-cancel]')", '未保存修改应提示');
      assert.ok(await cdp.click('[data-dialog-cancel]'), '继续编辑');
      await sleep(300);
      await check("document.getElementById('addProviderModal').hasAttribute('open')", '取消提示后应保留弹窗');
      assert.ok(await cdp.click('#addProviderModal .provider-editor-header .modal-close'), '再次关闭');
      await sleep(300);
      assert.ok(await cdp.click('[data-dialog-confirm]'), '放弃修改');
      await sleep(350);
      await check("!document.getElementById('addProviderModal').hasAttribute('open')", '放弃后应关闭弹窗');

      await cdp.evaluate("adminApp.showAddProviderModal('panel')");
      await sleep(350);
      assert.ok(await cdp.click('#saveProviderBtn'), '空表单保存');
      await sleep(300);
      await check("!document.getElementById('providerEditorAlert').hidden && adminApp._providerEditorPage === 0", '空表单错误应定位到基本信息');
      await check("document.getElementById('providerName').getAttribute('aria-invalid') === 'true'", '名称字段应标记错误');

      await cdp.evaluate(`(() => {
        const set = (id, value) => {
          const el = document.getElementById(id);
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('providerName', 'Validation provider');
        set('providerBaseUrl', 'https://example.test/v1');
        set('providerKeyMode', 'script');
      })()`);
      await sleep(200);
      await check("getComputedStyle(document.getElementById('providerKeySelectModeWrap')).display === 'none'", '脚本模式应隐藏 Key 选择策略');
      assert.ok(await cdp.click('#saveProviderBtn'), '脚本模式空脚本保存');
      await sleep(300);
      await check("adminApp._providerEditorPage === 1 && document.getElementById('providerKeyScript').getAttribute('aria-invalid') === 'true'", '脚本错误应定位到密钥页');

      await cdp.evaluate(`(() => {
        const set = (id, value) => {
          const el = document.getElementById(id);
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('providerKeyScript', 'return "fixture-key"');
        set('providerQuotaEnabled', 'true');
        set('providerQuotaMode', 'cpa');
      })()`);
      await sleep(300);
      await check("document.getElementById('providerQuotaModeGroup').hidden === false", '启用额度后应展示查询方式');
      assert.ok(await cdp.click('#saveProviderBtn'), 'CPA 配置缺失保存');
      await sleep(300);
      await check("adminApp._providerEditorPage === 2 && document.getElementById('providerCpaManagementUrl').getAttribute('aria-invalid') === 'true'", 'CPA 错误应定位到额度页');

      await cdp.evaluate(`(() => {
        window.__providerSaved = null;
        const original = window.fetch.bind(window);
        window.fetch = async (url, options = {}) => {
          if (String(url) === '/api/admin/providers' && options.method === 'POST') {
            window.__providerSaved = JSON.parse(options.body);
            return new Response(JSON.stringify({ id: 'fixture-provider' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (String(url).includes('/tags')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
          return original(url, options);
        };
      })()`);
      await cdp.evaluate(`(() => {
        const set = (id, value) => {
          const el = document.getElementById(id);
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('providerQuotaEnabled', 'false');
        set('providerCpaManagementUrl', '');
      })()`);
      await sleep(250);
      assert.ok(await cdp.click('#saveProviderBtn'), '保存编辑');
      await sleep(800);
      await check("window.__providerSaved?.name === 'Validation provider'", '保存跨页表单');
      await check("!document.getElementById('addProviderModal').hasAttribute('open')", '保存后应关闭弹窗');

      if (process.env.PROVIDER_EDITOR_SCREENSHOT_DIR) {
        const shot = await cdp.send('Page.captureScreenshot');
        require('node:fs').writeFileSync(`${process.env.PROVIDER_EDITOR_SCREENSHOT_DIR}/provider-editor-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
      console.log(`PASS provider editor layout and validation ${width}px`);
    } finally {
      cdp.ws.close();
      await fetch(`${debugging}/json/close/${target.id}`);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
