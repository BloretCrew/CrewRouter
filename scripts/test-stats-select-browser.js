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
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const ids = ['statsTimeRange', 'statsModelFilter', 'statsProviderFilter', 'statsTeamFilter', 'statsSourceFilter'];
  const check = async (expression, label) => assert.ok(await cdp.evaluate(expression), label);
  try {
    await cdp.send('Page.enable');
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/console#stats` });
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`typeof app !== 'undefined' && app._statsFiltersLoaded`)) break;
        await sleep(100);
      }
      await check(`app._statsFiltersLoaded`, '统计筛选加载');
      // 重新导航会保留当前标签；恢复概览以验证该区块。
      await cdp.evaluate(`app.switchStatsTab('overview')`);
      await check(`document.getElementById('statsTimeRange').value === '30'`, '默认最近30天');
      for (const id of ids) {
        await check(`(() => {
          const e = document.getElementById('${id}'), s = getComputedStyle(e);
          const trigger = e.shadowRoot.querySelector('[part="trigger"]');
          return !e.classList.contains('select') && !e.classList.contains('blora-select')
            && s.borderTopWidth === '0px' && s.backgroundImage === 'none'
            && trigger.textContent.trim().length > 0 && trigger.getBoundingClientRect().height >= 40;
        })()`, `${id} 单层外观、标签可见、统一高度`);
        await cdp.evaluate(`document.getElementById('${id}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
        await sleep(350);
        assert.ok(await cdp.click('#' + id), id + ' 点击打开筛选');
        await check(`document.getElementById('${id}').shadowRoot.querySelector('[part="trigger"]').getAttribute('aria-expanded') === 'true'`, '筛选弹出');
        const point = await cdp.evaluate(`(() => {
          const e = document.getElementById('${id}').shadowRoot.querySelectorAll('[part="option"]')[1];
          if (!e) return null;
          e.scrollIntoView({ block: 'nearest' });
          const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`);
        assert.ok(point, id + ' 有具体选项');
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        await sleep(350);
        await check(`document.getElementById('${id}').value !== ''`, id + ' 实际选择筛选选项');
      }
      assert.ok(await cdp.click('#statsPage button[onclick="app.resetStatsFilters()"]'), '点击重置');
      await sleep(500);
      await check(`document.getElementById('statsTimeRange').value === '30' && ${JSON.stringify(ids.slice(1))}.every(id => document.getElementById(id).value === '')`, '恢复默认筛选');
      await check(`document.getElementById('statsModelFilter').shadowRoot.querySelector('[part="trigger"]').textContent.includes(t('全部模型'))`, '重置后全部模型标签');
      await check(`(() => {
        const cards = [...document.querySelectorAll('#statsTabOverview .stats-insight-card')];
        return cards.every(card => {
          const list = card.querySelector('.stats-insight-list');
          const style = getComputedStyle(card);
          return card.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom
            <= parseFloat(style.paddingBottom) + 2;
        });
      })()`, '概览卡片高度随内容收缩');
      await check(`(() => {
        const overview = document.getElementById('statsTabOverview').getBoundingClientRect();
        const daily = document.getElementById('statsTabDaily').getBoundingClientRect();
        return parseFloat(getComputedStyle(document.getElementById('statsTabOverview')).marginBottom) >= 16
          && (getComputedStyle(document.getElementById('statsTabDaily')).display === 'none' || daily.top - overview.bottom >= 16);
      })()`, '概览与图表至少间隔16像素');
      if (process.env.STATS_SCREENSHOT_DIR) {
        await cdp.evaluate(`document.getElementById('statsTabOverview').scrollIntoView({ block: 'start', behavior: 'instant' })`);
        await sleep(350);
        const shot = await cdp.send('Page.captureScreenshot');
        require('node:fs').writeFileSync(`${process.env.STATS_SCREENSHOT_DIR}/stats-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
      assert.ok(await cdp.click('#statsPage button[onclick="app.switchStatsTab(\'multi\')"]'), '打开多维分析');
      await check(`document.getElementById('statsTabMulti').style.display === 'block'`, '多维分析仍可用');
      assert.ok(await cdp.click('#statsPage button[onclick="app.switchStatsTab(\'daily\')"]'), '切换每日趋势');
      await check(`document.getElementById('statsTabOverview').style.display === 'none' && document.getElementById('statsTabDaily').style.display === 'block'`, '每日趋势独立展示');
      assert.ok(await cdp.click('#statsPage button[onclick="app.switchStatsTab(\'overview\')"]'), '切回概览');
      await check(`document.getElementById('statsTabOverview').style.display === 'block'`, '概览恢复');
      await cdp.evaluate(`document.getElementById('topModelsList').innerHTML = '<div class="stats-insight-empty">' + t('暂无数据') + '</div>'`);
      await check(`(() => {
        const card = document.querySelector('#statsTabOverview .stats-insight-card');
        const list = card.querySelector('.stats-insight-list');
        return card.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom <= parseFloat(getComputedStyle(card).paddingBottom) + 2;
      })()`, '空数据卡片保持紧凑');
      console.log(`PASS stats selects and overview layout ${width}px`);

    }
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
