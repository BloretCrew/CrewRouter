#!/usr/bin/env node
'use strict';

// 前置：verify-blora-correction-browser.js --server / --chrome。
// 验证 Manage 附件区与倍率审批表格在真实浏览器中的 DOM 行为。
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
    const response = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description || ''));
    }
    return response.result.value;
  }
}

async function main() {
  const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
  const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const check = async (expression, label) => {
    const value = await cdp.evaluate(expression);
    assert.ok(value, label);
    return value;
  };
  try {
    await cdp.send('Page.enable');
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: width === 390
      });
      await cdp.send('Page.navigate', { url: `${base}/console#bloraAgent/manage` });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await cdp.evaluate('typeof app !== "undefined" && !!window.BloraAgentPage')) break;
        await sleep(100);
      }
      await cdp.evaluate(`(() => {
        BloraAgentPage.mode = 'manage';
        BloraAgentPage.applyModeChrome();
        BloraAgentPage.messages = [];
        BloraAgentPage.pendingApproval = null;
        BloraAgentPage.draftAttachments = [{
          id: 12, kind: 'document', filename: 'prices.csv', mime: 'text/csv',
          bytes: 2048, chars: 120, truncated: false, source: 'upload'
        }];
        BloraAgentPage.renderAttachments();
      })()`);
      await check(`!document.getElementById('baAttachBtn').hidden && !document.getElementById('baLinkBtn').hidden`, 'Manage 显示附件与链接按钮');
      await check(`!document.getElementById('baAttachments').hidden && document.getElementById('baAttachments').textContent.includes('prices.csv')`, '附件 chip 渲染');
      await check(`document.getElementById('baInput').placeholder.includes('PDF')`, 'Manage 输入框提示资料格式');

      await cdp.evaluate(`(() => {
        BloraAgentPage.draftAttachments = [];
        BloraAgentPage.renderAttachments();
        BloraAgentPage.messages = [{
          role: 'user', content: '请按资料调整', attachments: [{
            id: 12, kind: 'document', filename: 'prices.csv', mime: 'text/csv',
            byte_size: 2048, source: 'upload'
          }]
        }];
        BloraAgentPage.renderThread();
      })()`);
      await check(`!!document.querySelector('[data-reference-attachment="12"]')`, '历史消息提供重新引用');

      await cdp.evaluate(`(() => {
        BloraAgentPage.messages = [{ role: 'user', content: '请按资料调整倍率' }];
        BloraAgentPage.pendingApproval = {
          approval_id: 7, id: 'call-7', name: 'batch_set_model_multipliers',
          arguments: { basis: 'input' },
          preview: {
            type: 'model_multiplier_batch',
            basis: 'input', currency: 'USD', points_currency: 'CNY', fx_rate: 7.2, markup: 1.2,
            summary: { count: 2, changed: 2, unchanged: 0, stale: 0, unmatched: 0 },
            rows: [{
              model_id: 'm1', name: '<img src=x onerror=alert(1)>', upstream_model_id: 'gpt-4.1',
              provider: 'openai', provider_name: 'OpenAI', current_multiplier: 1, proposed_multiplier: 2.4,
              delta_pct: 140, source_price: 2, price_unit: 'per_1m', source_currency: 'USD',
              fx_rate: 7.2, markup: 1.2, risk_flags: ['large_change'], reason: 'test'
            }, {
              model_id: 'm2', name: 'Claude', upstream_model_id: 'claude-opus-4',
              provider: 'anthropic', provider_name: 'Anthropic', current_multiplier: 2, proposed_multiplier: 1.8,
              delta_pct: -10, source_price: 2, price_unit: 'per_1m', source_currency: 'USD',
              fx_rate: 7.2, markup: 1.2, risk_flags: [], reason: 'test'
            }],
            unmatched: [{ model_ref: 'GPT-5', reason: 'model_not_found' }],
            errors: [], warnings: [],
            sources: [{ id: 12, filename: 'prices.csv', source: 'upload', url: null }]
          }
        };
        BloraAgentPage.renderThread();
      })()`);
      await check(`!!document.querySelector('.ba-approval__table')`, '审批卡渲染表格');
      await check(`document.querySelectorAll('.ba-approval__table tbody tr').length === 2`, '审批卡渲染两行');
      await check(`document.querySelector('.ba-approval').textContent.includes('prices.csv')`, '审批卡显示来源资料');
      await check(`document.querySelector('.ba-approval').textContent.includes('未匹配')`, '审批卡显示未匹配项');
      await check(`!!document.querySelector('[data-decision="allow"]') && !!document.querySelector('[data-decision="deny"]')`, '审批按钮存在');
      await check(`!document.querySelector('.ba-approval img[src="x"]') && document.querySelector('.ba-approval').textContent.includes('<img src=x')`, '模型名称被转义');
      await check(`document.documentElement.scrollWidth <= innerWidth + 1`, '页面无横向溢出');
      const tableOverflow = await cdp.evaluate(`(() => {
        const wrap = document.querySelector('.ba-approval__table-wrap');
        return wrap ? wrap.scrollWidth >= wrap.clientWidth : false;
      })()`);
      assert.equal(tableOverflow, true, '审批表格容器可横向滚动');
      console.log(`PASS agent pricing UI ${width}px`);
    }
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
