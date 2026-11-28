#!/usr/bin/env node
'use strict';
// 请求名映射弹窗回归。前置：verify-blora-correction-browser.js --server / --chrome。
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
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(400);
    const point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !(hit === el || el.contains(hit))) return null;
      return { x, y };
    })()`);
    if (!point) return false;
    if (this.mobile) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1 }] });
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    await sleep(250);
    return true;
  }
}

const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';

async function main() {
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const check = async (expression, label) => assert.ok(await cdp.evaluate(expression), label);
  const dialogOpen = `!!document.querySelector('blora-dialog[open] .ml-request-bindings')`;
  try {
    await cdp.send('Page.enable');
    // 演示 Key 默认没有 AI 权限；测试夹具只补充内存中的权限字段，让模型库渲染出 Key。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]) === '/api/user/api-keys' && (!args[1]?.method || args[1].method === 'GET')) {
          const keys = await response.clone().json();
          return new Response(JSON.stringify(keys.map(key => ({ ...key, permissions: ['gateway.chat', 'gateway.messages', 'gateway.responses', 'gateway.gemini'] }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return response;
      };
    ` });
    for (const width of [1440, 390]) {
      cdp.mobile = width === 390;
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: cdp.mobile });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: cdp.mobile });
      await cdp.send('Page.navigate', { url: `${base}/console#modelLibrary` });
      for (let i = 0; i < 120; i++) {
        if (await cdp.evaluate(`typeof app !== 'undefined' && !!document.querySelector('.ml-key-choice-model')`)) break;
        await sleep(100);
      }
      await sleep(800);

      // 每个视口都从固定夹具开始，避免上一轮写入影响这一轮。
      await cdp.evaluate(`(async () => {
        const headers = await app._csrfHeaders({ 'Content-Type': 'application/json' });
        await fetch('/api/user/api-keys/1/request-model-bindings', {
          method: 'PUT', credentials: 'same-origin', headers,
          body: JSON.stringify({ bindings: [
            { request_model_name: 'fast-chat', harness: null, model_id: 'deepseek-chat' },
            { request_model_name: 'fast-chat', harness: 'codex', model_id: 'gpt-4.1' },
          ] }),
        });
        await app._loadLibraryKeys();
      })()`);
      await sleep(1000);

      // 从 Key 菜单进入映射弹窗
      assert.ok(await cdp.click('.ml-key-choice.is-selected'), '打开 Key 菜单');
      await check(`app._isLibraryKeyBubbleOpen()`, '工具菜单展开');
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*="onLibraryKeyBubbleRequestModelBindings()"]'), '点击按请求名映射');
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate(dialogOpen)) break;
        await sleep(100);
      }
      await check(dialogOpen, '映射弹窗打开');
      await check(`document.querySelectorAll('blora-dialog[open] .ml-request-binding-row').length === 2`, '列出现有两条映射');
      await check(`document.querySelector('blora-dialog[open] #mlRequestBindingSave').textContent.trim().length > 0 && document.querySelector('blora-dialog[open] #mlRequestBindingCancel')`, '底部按钮真实渲染');
      await check(`getComputedStyle(document.querySelector('blora-dialog[open] #mlRequestBindingReset')).display === 'none'`, '未编辑时不显示取消编辑按钮');

      // 新增一条映射（弹窗内按钮直接派发点击，移动端触控已在菜单入口验证）
      await cdp.evaluate(`(() => {
        const d = document.querySelector('blora-dialog[open]');
        d.querySelector('#mlRequestBindingName').value = 'reasoning-fast';
        const target = d.querySelector('#mlRequestBindingTarget');
        target.value = 'deepseek-reasoner';
        target.dispatchEvent(new CustomEvent('blora-change', { bubbles: true, detail: { value: 'deepseek-reasoner' } }));
      })()`);
      await sleep(300);
      const beforeAdd = await cdp.evaluate(`document.querySelectorAll('blora-dialog[open] .ml-request-binding-row').length`);
      await cdp.evaluate(`document.querySelector('blora-dialog[open] #mlRequestBindingApply').click()`);
      await sleep(300);
      await check(`document.querySelectorAll('blora-dialog[open] .ml-request-binding-row').length === ${beforeAdd + 1}`, '新增后列表多一条');
      await check(`document.querySelector('blora-dialog[open]').textContent.includes('reasoning-fast')`, '新规则显示在列表');

      // 编辑态显示「取消编辑」，退出后隐藏
      await cdp.evaluate(`document.querySelector('blora-dialog[open] .ml-request-binding-row:last-child [data-binding-action="edit"]').click()`);
      await sleep(300);
      await check(`getComputedStyle(document.querySelector('blora-dialog[open] #mlRequestBindingReset')).display !== 'none' && document.querySelector('blora-dialog[open] #mlRequestBindingReset').textContent.trim().length > 0`, '编辑态显示取消编辑');
      await check(`document.querySelector('blora-dialog[open] #mlRequestBindingName').value === 'reasoning-fast'`, '编辑态回填请求名');
      await cdp.evaluate(`document.querySelector('blora-dialog[open] #mlRequestBindingReset').click()`);
      await sleep(300);
      await check(`getComputedStyle(document.querySelector('blora-dialog[open] #mlRequestBindingReset')).display === 'none'`, '取消编辑后按钮隐藏');
      await check(`document.querySelector('blora-dialog[open] #mlRequestBindingName').value === ''`, '取消编辑后表单清空');

      // 重复规则应被前端拦截
      await cdp.evaluate(`(() => {
        const d = document.querySelector('blora-dialog[open]');
        d.querySelector('#mlRequestBindingName').value = 'reasoning-fast';
        d.querySelector('#mlRequestBindingTarget').value = 'gpt-4.1';
      })()`);
      await cdp.evaluate(`document.querySelector('blora-dialog[open] #mlRequestBindingApply').click()`);
      await sleep(300);
      await check(`!document.querySelector('blora-dialog[open] #mlRequestBindingError').hidden`, '同名规则给出错误提示');
      await check(`document.querySelectorAll('blora-dialog[open] .ml-request-binding-row').length === ${beforeAdd + 1}`, '重复规则未写入列表');

      // 逐行移除
      await cdp.evaluate(`document.querySelector('blora-dialog[open] .ml-request-binding-row:first-child [data-binding-action="remove"]').click()`);
      await sleep(300);
      await check(`document.querySelectorAll('blora-dialog[open] .ml-request-binding-row').length === ${beforeAdd}`, '移除后列表少一条');

      // 保存并确认请求体
      await cdp.evaluate(`window.__bindingPut = null; (() => { const realFetch = window.fetch; window.fetch = async (...args) => {
        if (args[1]?.method === 'PUT' && String(args[0]).includes('/request-model-bindings')) {
          window.__bindingPut = JSON.parse(args[1].body);
          window.__bindingCsrf = args[1].headers?.['X-CSRF-Token'] || args[1].headers?.get?.('X-CSRF-Token') || null;
        }
        return realFetch(...args);
      }; })()`);
      assert.ok(await cdp.click('blora-dialog[open] #mlRequestBindingSave'), '保存映射');
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate(`!document.querySelector('blora-dialog[open] .ml-request-bindings') || window.__bindingPut`)) break;
        await sleep(100);
      }
      await sleep(600);
      await check(`!!window.__bindingPut`, '保存触发 PUT');
      await check(`window.__bindingPut.bindings.some(b => b.request_model_name === 'reasoning-fast') && window.__bindingPut.bindings.length === ${beforeAdd}`, 'PUT 包含新增规则且已移除第一行');
      await check(`!!window.__bindingCsrf`, '写请求带 CSRF 令牌');
      await check(`!document.querySelector('blora-dialog[open] .ml-request-bindings')`, '保存成功后弹窗关闭');
      await check(`document.querySelector('#modelLibraryBindingSummary') && document.querySelector('#modelLibraryBindingSummary').textContent.length > 0`, '绑定摘要已刷新');
      await check(`JSON.stringify((app._libraryKeys.find(k => String(k.id) === '1') || {}).request_model_bindings || []).includes('reasoning-fast')`, '前端缓存同步新规则');

      // 服务端已持久化
      const saved = await cdp.evaluate(`fetch('/api/user/api-keys/1/request-model-bindings').then(r => r.json()).then(d => d.bindings)`);
      assert.ok(saved.some(binding => binding.request_model_name === 'reasoning-fast'), '服务端已保存新规则');
      assert.ok(!saved.some(binding => binding.request_model_name === 'fast-chat' && !binding.harness), '服务端已移除第一行');

      // 重新打开，验证列表与真实数据一致
      await cdp.evaluate(`app.openLibraryRequestModelBindingDialog()`);
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate(dialogOpen)) break;
        await sleep(100);
      }
      await check(`[...document.querySelectorAll('blora-dialog[open] .ml-request-binding-name')].some(el => el.textContent === 'reasoning-fast')`, '重开显示已保存规则');
      await check(`[...document.querySelectorAll('blora-dialog[open] .ml-request-binding-name')].every(el => el.textContent !== 'fast-chat' || el.closest('.ml-request-binding-row').textContent.includes('Codex'))`, '通用规则已移除，Harness 规则保留');

      // 校验反馈 + 取消
      await cdp.evaluate(`(() => {
        const d = document.querySelector('blora-dialog[open]');
        d.querySelector('#mlRequestBindingName').value = '   ';
      })()`);
      assert.ok(await cdp.click('blora-dialog[open] #mlRequestBindingApply'), '空名提交');
      await check(`document.querySelector('blora-dialog[open] #mlRequestBindingError').textContent.length > 0`, '空名给出错误');
      assert.ok(await cdp.click('blora-dialog[open] #mlRequestBindingCancel'), '取消关闭');
      for (let i = 0; i < 40; i++) {
        if (!(await cdp.evaluate(dialogOpen))) break;
        await sleep(100);
      }
      await check(`!document.querySelector('blora-dialog[open] .ml-request-bindings')`, '取消后弹窗关闭');

      // 移动端不溢出
      await cdp.evaluate(`app.openLibraryRequestModelBindingDialog()`);
      for (let i = 0; i < 60; i++) {
        if (await cdp.evaluate(dialogOpen)) break;
        await sleep(100);
      }
      await check(`(() => {
        const panel = document.querySelector('blora-dialog[open]');
        const rect = panel.getBoundingClientRect();
        return rect.right <= innerWidth + 1 && rect.left >= -1 && document.documentElement.scrollWidth <= innerWidth;
      })()`, '弹窗不产生横向溢出');
      await check(`[...document.querySelectorAll('blora-dialog[open] .ml-request-binding-row')].every(row => row.getBoundingClientRect().right <= innerWidth + 1)`, '列表行不溢出');
      await cdp.evaluate(`document.querySelector('blora-dialog[open] #mlRequestBindingCancel')?.click()`);
      console.log(`PASS ${width}px: 请求名映射弹窗列表、增删、校验、保存与 CSRF、移动端布局`);
    }
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
