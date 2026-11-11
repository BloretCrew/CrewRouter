#!/usr/bin/env node
'use strict';

// Lightweight DOM-free UI regression for the multiplier approval card.
// The page module is loaded in a VM with the few globals it touches.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const source = fs.readFileSync(path.join(__dirname, '../public/js/blora-agent.js'), 'utf8');
const context = {
  window: {},
  document: { getElementById: () => null, createElement: () => ({}) },
  customElements: { whenDefined: () => Promise.resolve() },
  location: { hash: '' },
  Dom: {
    escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
  },
  setHTML() {},
  t: key => key,
  fetch: async () => ({ ok: false })
};
vm.runInNewContext(source, context);
const page = context.window.BloraAgentPage;
assert.ok(page, 'BloraAgentPage must be registered');

const preview = {
  type: 'model_multiplier_batch',
  basis: 'input',
  currency: 'USD',
  points_currency: 'CNY',
  fx_rate: 7.2,
  markup: 1.2,
  summary: { count: 1, changed: 1, unchanged: 0, stale: 0, unmatched: 0 },
  rows: [{
    model_id: 'm1',
    name: '<img src=x onerror=alert(1)>',
    upstream_model_id: 'gpt-4.1',
    provider: 'openai',
    provider_name: 'OpenAI',
    current_multiplier: 1,
    proposed_multiplier: 2.4,
    delta_pct: 140,
    source_price: 2,
    price_unit: 'per_1m',
    source_currency: 'USD',
    fx_rate: 7.2,
    markup: 1.2,
    risk_flags: ['large_change'],
    reason: 'synthetic'
  }],
  unmatched: [],
  errors: [],
  warnings: [],
  sources: [{ id: 1, filename: 'prices.csv', source: 'upload', url: null }]
};

const html = page.approvalCard(preview);
assert.match(html, /ba-approval__table/);
assert.match(html, /1\.0000/);
assert.match(html, /2\.4000/);
assert.match(html, /prices\.csv/);
assert.match(html, /data-decision="allow"/);
assert.match(html, /data-decision="deny"/);
assert.ok(!html.includes('<img src=x'), 'model names must be escaped');
assert.match(html, /&lt;img src=x/);
assert.match(page.toolCard('batch_set_model_multipliers', '{}', true, preview), /ba-approval__table/);
assert.doesNotMatch(page.toolCard('other_tool', '{"a":1}', true, null), /ba-approval__table/);

console.log('Multiplier approval card renders a table, risks, sources and escaped text.');
