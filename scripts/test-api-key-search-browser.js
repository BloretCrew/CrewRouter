#!/usr/bin/env node
'use strict';
/**
 * 浏览器回归：API Key 页面搜索。
 *
 * 前置：先启动隔离演示服务与无头 Chrome：
 *   node scripts/verify-blora-correction-browser.js --server
 *   node scripts/verify-blora-correction-browser.js --chrome
 *   node scripts/test-api-key-search-browser.js
 *
 * 断言覆盖（1440px 与 390px 各一轮）：
 *  - 主搜索框存在，输入名称/路由模型/标签/成员/密钥片段可过滤卡片
 *  - 多个关键词按 AND 过滤；结果统计显示「显示 n / 总数 个 Key」
 *  - 无匹配时出现空态与「清除筛选」，一键清除恢复完整列表
 *  - 标签筛选与搜索叠加生效，计数芯片与分组显隐同步
 *  - 悬浮顶栏搜索与主搜索框双向同步，清空后恢复
 *  - 搜索栏与悬浮栏在窄屏无横向溢出
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

async function main() {
  let checks = 0;
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(res => res.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const check = async (expression, message) => {
    const ok = await cdp.evaluate(expression);
    assert.ok(ok, message);
    checks++;
  };
  const visibleCards = () => cdp.evaluate(`[...document.querySelectorAll('#apiKeysList .api-key-card')].filter(el => el.getClientRects().length).map(el => el.querySelector('.api-key-name')?.textContent.trim())`);
  // 通过组件内部 input 输入，模拟真实键盘输入（blora-search 的事件由内部输入框发出）
  const setSearch = (id, value) => cdp.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    const input = el?.querySelector('input');
    if (!el || !input) return false;
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  try {
    await cdp.send('Page.enable');
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/console#apiKeys` });
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`typeof app !== 'undefined' && document.querySelectorAll('#apiKeysList .api-key-card').length > 3`)) break;
        await sleep(100);
      }

      // 1) 搜索框可见且为 Blora 搜索组件
      await check(`!!document.querySelector('#apiKeysPage .ak-search-bar:not([hidden]) blora-search#apiKeysSearch')`, `${width}px 搜索栏可见`);
      const allNames = await visibleCards();
      assert.ok(allNames.length >= 5, `${width}px 演示数据应有多张卡片`);
      checks++;

      // 2) 按名称搜索
      await setSearch('apiKeysSearch', '生产环境');
      await sleep(120);
      let names = await visibleCards();
      assert.deepEqual(names, ['生产环境 Key'], `${width}px 按名称过滤`);
      checks++;
      await check(`document.getElementById('apiKeysSearchSummary').hidden === false && /1\\s*\\/\\s*${allNames.length}/.test(document.getElementById('apiKeysSearchSummaryText').textContent)`, `${width}px 显示结果统计`);

      // 3) 按队列模型搜索（仅「多项目共用 Key」队列含 Claude 3.5 Haiku）
      await setSearch('apiKeysSearch', 'haiku');
      await sleep(120);
      names = await visibleCards();
      assert.deepEqual(names, ['多项目共用 Key'], `${width}px 按队列模型搜索命中`);
      checks++;
      // 多关键词按 AND 过滤：名称命中但模型不命中的卡片应被排除
      await setSearch('apiKeysSearch', 'key haiku');
      await sleep(120);
      names = await visibleCards();
      assert.ok(names.every(name => name.includes('Key')), `${width}px 多关键词按 AND 过滤`);
      assert.ok(!names.includes('测试环境 Key'), `${width}px AND 过滤排除不匹配卡片`);
      checks++;

      // 4) 按成员与标签搜索
      await setSearch('apiKeysSearch', 'carol');
      await sleep(120);
      assert.deepEqual(await visibleCards(), ['团队共享 Key'], `${width}px 按成员搜索`);
      checks++;
      await setSearch('apiKeysSearch', '生产');
      await sleep(120);
      names = await visibleCards();
      assert.ok(names.includes('生产环境 Key') && names.includes('多项目共用 Key'), `${width}px 按标签搜索`);
      checks++;

      // 5) 按密钥片段搜索
      await setSearch('apiKeysSearch', 'sk-demo-test');
      await sleep(120);
      assert.deepEqual(await visibleCards(), ['测试环境 Key'], `${width}px 按密钥片段搜索`);
      checks++;

      // 6) 无匹配 → 空态 + 清除恢复
      await setSearch('apiKeysSearch', 'zzz-no-such-key');
      await sleep(120);
      await check(`!document.getElementById('apiKeysFilterEmpty').hidden`, `${width}px 无匹配显示空态`);
      await check(`document.querySelectorAll('#apiKeysList .api-key-card').length > 0 && [...document.querySelectorAll('#apiKeysList .api-key-card')].every(el => !el.getClientRects().length)`, `${width}px 无匹配时卡片全部隐藏`);
      await check(`document.querySelectorAll('#apiKeysList .api-key-group').length > 0 && [...document.querySelectorAll('#apiKeysList .api-key-group')].every(el => el.style.display === 'none')`, `${width}px 无匹配时分组隐藏`);
      assert.ok(await cdp.click('#apiKeysFilterEmpty button'), `${width}px 清除筛选按钮可点击`);
      checks++;
      await sleep(150);
      names = await visibleCards();
      assert.equal(names.length, allNames.length, `${width}px 清除后恢复完整列表`);
      assert.equal(await cdp.evaluate(`document.getElementById('apiKeysSearch').value`), '', `${width}px 清除后输入框为空`);
      checks++;

      // 7) 标签筛选 + 搜索叠加
      const tagClicked = await cdp.evaluate(`(() => {
        const chip = [...document.querySelectorAll('#keyTagChips .key-tag-chip[data-tag-id]')].find(el => el.textContent.includes('生产'));
        if (!chip) return false;
        chip.click();
        return true;
      })()`);
      assert.ok(tagClicked, `${width}px 标签芯片存在`);
      checks++;
      await sleep(120);
      await setSearch('apiKeysSearch', '测试环境');
      await sleep(120);
      await check(`!document.getElementById('apiKeysFilterEmpty').hidden`, `${width}px 标签与搜索叠加后无匹配`);
      await cdp.evaluate(`document.querySelector('#apiKeysFilterEmpty button')?.click()`);
      await sleep(150);
      await check(`document.getElementById('apiKeysList').classList.contains('is-filtering') === false && document.getElementById('apiKeysSearchSummary').hidden`, `${width}px 清除后移除过滤态`);

      // 7b) 真实键盘输入：聚焦主搜索框输入，Esc 清除
      await cdp.evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
      await sleep(300);
      await cdp.evaluate(`document.querySelector('#apiKeysSearch input').focus()`);
      await cdp.send('Input.insertText', { text: 'carol' });
      await sleep(200);
      assert.deepEqual(await visibleCards(), ['团队共享 Key'], `${width}px 真实键盘输入过滤`);
      checks++;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(150);
      assert.equal(await cdp.evaluate(`document.querySelector('#apiKeysSearch input').value`), '', `${width}px Esc 清空输入框`);
      assert.equal((await visibleCards()).length, allNames.length, `${width}px Esc 后恢复完整列表`);
      checks++;

      // 8) 悬浮顶栏搜索与主搜索框同步
      await cdp.evaluate(`window.scrollTo({ top: 900, behavior: 'instant' })`);
      await sleep(400);
      await check(`document.getElementById('apiKeysStickyBar').classList.contains('is-visible')`, `${width}px 滚动后悬浮栏出现`);
      await check(`document.getElementById('apiKeysStickyBar').querySelector('.ak-sticky-search input') !== null`, `${width}px 悬浮栏含搜索框`);
      await setSearch('apiKeysStickySearch', '定时');
      await sleep(150);
      assert.equal(await cdp.evaluate(`document.getElementById('apiKeysSearch').value`), '定时', `${width}px 悬浮栏 -> 主搜索框同步`);
      checks++;
      names = await visibleCards();
      assert.deepEqual(names, ['工作日定时 Key'], `${width}px 悬浮栏搜索生效`);
      checks++;
      await check(`document.getElementById('apiKeysStickyBar').classList.contains('is-visible')`, `${width}px 搜索时悬浮栏保持可见`);
      await cdp.evaluate(`(() => { const input = document.querySelector('#apiKeysStickySearch input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(150);
      assert.equal(await cdp.evaluate(`document.getElementById('apiKeysSearch').value`), '', `${width}px 清空后主搜索框同步为空`);
      checks++;
      assert.equal((await visibleCards()).length, allNames.length, `${width}px 清空后恢复完整列表`);
      checks++;

      // 9) 窄屏无横向溢出
      await cdp.evaluate(`window.scrollTo(0, 0)`);
      await sleep(300);
      await check(`(() => { const bar = document.querySelector('#apiKeysPage .ak-search-bar'); return bar.scrollWidth <= bar.clientWidth + 1 && bar.getBoundingClientRect().right <= innerWidth + 1; })()`, `${width}px 搜索栏无横向溢出`);

      console.log(`PASS API Key search ${width}px`);
    }
    console.log(`PASS API Key search (${checks} assertions)`);
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
