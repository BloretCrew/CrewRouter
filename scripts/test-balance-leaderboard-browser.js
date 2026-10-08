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
  const check = async (expression, label) => assert.ok(await cdp.evaluate(expression), label);
  const select = async (id, value) => {
    await cdp.evaluate(`document.getElementById('${id}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(300);
    assert.ok(await cdp.click('#' + id), '打开筛选');
    const point = await cdp.evaluate(`(() => {
      const e = [...document.getElementById('${id}').shadowRoot.querySelectorAll('[part="option"]')].find(e => e.dataset.value === '${value}');
      e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(350);
    await check(`document.getElementById('${id}').value === '${value}'`, '选择生效');
  };

  try {
    await cdp.send('Page.enable');
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/console#balance` });
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`typeof app !== 'undefined' && !!app.user && !!document.querySelector('#personalLimits .limit-card')`)) break;
        await sleep(100);
      }
      await check(`getComputedStyle(document.getElementById('personalLimitsSection')).display !== 'none'`, '个人限额可见');
      await cdp.evaluate(`(() => {
        const original = window.fetch.bind(window);
        window.__limits = { rate_limit_rpm: 0, rate_limit_tpm: 0 };
        window.fetch = async (url, options) => {
          const response = await original(url, options);
          if (String(url) !== '/api/user/balance') return response;
          const data = await response.json();
          return new Response(JSON.stringify({ ...data, ...window.__limits }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
      })()`);
      for (const group of [null, { name: 'Test Team', rules: [] }, { name: 'Test Team', rules: [
        { rule_type: 'requests', rule_value: 100, duration_hours: 24, current: 25 },
        { rule_type: 'tokens', rule_value: 100000, duration_hours: 168, current: 120000 }
      ] }]) {
        await cdp.evaluate(`window.__limits = { group: ${JSON.stringify(group)} }; app.loadBalance()`);
        await check(`document.getElementById('personalLimitsSection').textContent.includes(t('Team 与限额'))`, 'Team限额标题');
        if (group?.rules.length) {
          await check(`document.getElementById('balanceTeamName').textContent === 'Test Team'
            && document.querySelectorAll('#personalLimits .limit-card').length === 2
            && document.getElementById('personalLimits').textContent.includes('25 / 100')
            && [...document.querySelectorAll('#personalLimits blora-progress')].every(e => Number(e.getAttribute('value')) <= 100)`, 'Team名称、窗口规则与超额用量');
        } else {
          await check(`document.getElementById('personalLimits').textContent.includes(t('暂无限额规则'))`, '无Team或无限额状态');
        }
      }
      if (process.env.LIMITS_SCREENSHOT_DIR) {
        const shot = await cdp.send('Page.captureScreenshot');
        require('node:fs').writeFileSync(`${process.env.LIMITS_SCREENSHOT_DIR}/balance-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
      await cdp.evaluate(`app.navigateTo('leaderboard')`);
      await sleep(600);
      await check(`document.getElementById('leaderboardTimeRange').value === '30' && document.getElementById('leaderboardSort').value === 'tokens'`, '默认时间和排序');
      for (const id of ['leaderboardTimeRange', 'leaderboardSort']) {
        await check(`(() => {
          const e = document.getElementById('${id}'), s = getComputedStyle(e), trigger = e.shadowRoot.querySelector('[part="trigger"]');
          return s.borderTopWidth === '0px' && s.backgroundImage === 'none' && trigger.textContent.trim().length > 0
            && trigger.getBoundingClientRect().height >= 40 && !e.classList.contains('select') && !e.classList.contains('blora-select');
        })()`, '排行榜单层外观及默认文字');
      }
      await select('leaderboardTimeRange', '7');
      await select('leaderboardSort', 'requests');
      await select('leaderboardSort', 'tokens');
      await select('leaderboardTimeRange', '30');
      await cdp.evaluate(`app._renderLeaderboard({ leaderboard: [{ rank: 1, username: 'Browser User', isCurrentUser: true, totalRequests: 12, totalTokens: 12345, totalPoints: 2, balance: 99 }], totalUsers: 1, currentUserRank: 1 })`);
      await check(`(() => {
        const badge = document.querySelector('.leaderboard-current-row .blora-badge');
        return badge?.textContent === t('我') && badge.dataset.variant === 'info'
          && parseFloat(getComputedStyle(badge).borderTopLeftRadius) > 0;
      })()`, '当前用户使用圆角Blora徽章');
      if (process.env.LIMITS_SCREENSHOT_DIR) {
        await cdp.evaluate('window.scrollTo(0, 0)');
        await sleep(300);
        const shot = await cdp.send('Page.captureScreenshot');
        require('node:fs').writeFileSync(`${process.env.LIMITS_SCREENSHOT_DIR}/leaderboard-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
      await cdp.evaluate(`app._renderLeaderboard({ leaderboard: [] })`);
      await check(`document.getElementById('leaderboardContent').textContent.includes(t('暂无排行数据'))`, '排行榜空状态');
      console.log(`PASS balance and leaderboard ${width}px`);
    }
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
