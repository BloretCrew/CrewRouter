'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parseSelection, queryMultiDimensionStats, queryQuotaDimensions } = require('../server/utils/multi-dimension-stats');
const base = path.resolve(__dirname, '..');

class Element {
  constructor(tag) { this.tag = tag; this.attributes = {}; this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = false; this.textContent = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'checked') this.checked = true; }
  getAttribute(key) { return key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? this.attributes[key] ?? null : this.attributes[key] ?? null; }
  hasAttribute(key) { return this.getAttribute(key) !== null; }
  toggleAttribute(key, on) { if (on) this.setAttribute(key, ''); else { delete this.attributes[key]; if (key === 'checked') this.checked = false; } }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get value() { return this.getAttribute('value') || ''; }
  set value(value) { this.setAttribute('value', value); }
  append(...nodes) { for (const node of nodes) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; this.children.push(node); } }
  before(node) { const parent = this.parent; if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
  after(node) { const parent = this.parent; if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  replaceChildren(...nodes) { this.children = []; this._html = ''; this.append(...nodes); }
  set innerHTML(html) {
    this.replaceChildren(); this._html = html;
    const stack = [this];
    for (const match of html.matchAll(/<\/?([\w-]+)([^>]*)>/g)) {
      if (match[0].startsWith('</')) { stack.pop(); continue; }
      const node = new Element(match[1]);
      for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1).append(node); stack.push(node);
    }
  }
  get innerHTML() { return this._html || ''; }
  matches(selector) {
    const not = selector.match(/:not\(([^)]+)\)/);
    if (not) { if (this.matches(not[1])) return false; selector = selector.replace(not[0], ''); }
    const tag = selector.match(/^[\w-]+/); if (tag && tag[0] !== this.tag) return false;
    for (const cls of selector.matchAll(/\.([\w-]+)/g)) if (!this.className.split(' ').includes(cls[1])) return false;
    for (const attr of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (!this.hasAttribute(attr[1]) || attr[2] !== undefined && this.getAttribute(attr[1]) !== attr[2]) return false;
    return true;
  }
  querySelectorAll(selector) {
    const parts = selector.split(' '); const last = parts.pop(); const result = [];
    const visit = node => { for (const child of node.children) {
      if (child.matches(last) && (!parts.length || child.parent.closest(parts.join(' ')))) result.push(child);
      visit(child);
    } }; visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return selector.split(',').some(part => this.matches(part.trim())) ? this : this.parent?.closest(selector) || null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

function setup(scope) {
  const html = fs.readFileSync(path.join(base, 'public/pages', scope === 'admin' ? 'admin.html' : 'console.html'), 'utf8');
  const section = html.match(new RegExp(`<section id="${scope}MultiDimension"[\\s\\S]*?</section>`))[0];
  const document = new Element('document'); document.innerHTML = section; document.readyState = 'complete';
  document.createElement = tag => new Element(tag);
  document.getElementById = id => document.querySelector(`[id="${id}"]`);
  const panel = new Element('section'); panel.setAttribute('data-quota-scope', scope); panel.setAttribute('data-quota-context', 'multi');
  panel.innerHTML = '<blora-select name="account_id" value="quota-only"></blora-select>';
  document.append(panel);
  const requests = []; let pending = null;
  const window = { CrewRouterQuotaStats: { refresh() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'public/js/multi-dimension-chart.js'), 'utf8'), {
    window, document, URLSearchParams,
    fetch: async url => {
      const params = new URL(url, 'http://local').searchParams; requests.push(params);
      if (pending) { const next = pending; pending = null; return next; }
      return { ok: true, json: async () => ({ dimensions: params.get('dimensions').split(','), metric: params.get('metric'), data_source: params.get('data_source'), rows: [{ labels: params.get('dimensions').split(',').map(key => key === 'source' ? 'claude_code' : key), tokens: 123, requests: 2, value: 10 }] }) };
    }
  });
  const root = document.getElementById(`${scope}MultiDimension`);
  return { root, panel, requests, document, load: () => window.CrewRouterMultiDimension.load(scope), defer: promise => { pending = promise; } };
}
function select(group, values) { group.querySelectorAll('blora-checkbox').forEach(el => el.toggleAttribute('checked', values.includes(el.value))); }

for (const scope of ['user', 'admin']) test(`${scope}: actual page + VM isolate source/model Token and source state`, async () => {
  const app = setup(scope); const { root } = app;
  const usage = root.querySelector('[data-dimension-group="usage"]');
  const quota = root.querySelector('[data-dimension-group="quota"]');
  const source = root.querySelector('[name="data_source"]'); const metric = root.querySelector('[name="metric"]');
  select(usage, ['source', 'model']); metric.value = 'tokens';
  await app.load();
  const query = Object.fromEntries(app.requests.at(-1));
  assert.equal(query.dimensions, 'source,model'); assert.equal(query.metric, 'tokens'); assert.equal(query.data_source, 'usage');
  assert.deepEqual(parseSelection(query, scope).dimensions, ['source', 'model']);
  assert.equal(app.panel.hidden, true); assert.equal(quota.hidden, true);
  assert.match(app.document.getElementById(`${scope}MultiDimensionResult`).innerHTML, /Claude Code/);
  assert.ok(root.children.indexOf(root.querySelector('.multi-dimension-actions')) < root.children.indexOf(usage));
  assert.equal(quota.getAttribute('role'), 'group');
  quota.querySelectorAll('blora-checkbox').forEach(el => assert.equal(el.getAttribute('aria-label'), el.getAttribute('label')));
  assert.equal(root.querySelector('[name="quota_metric"]').getAttribute('aria-label'), '额度指标');
  source.value = 'quota'; await app.load(); assert.equal(app.requests.at(-1).get('dimensions'), 'provider,account'); assert.equal(app.panel.hidden, false);
  select(quota, ['account', 'window']); root.querySelector('[name="quota_metric"]').value = 'used_percent'; await app.load();
  source.value = 'related'; await app.load(); assert.equal(app.requests.at(-1).get('dimensions'), 'model');
  select(usage, ['project']); metric.value = 'cost'; await app.load(); assert.equal(app.requests.at(-1).get('data_source'), 'association');
  assert.equal(app.requests.at(-1).has('account_id'), false);
  source.value = 'requests'; await app.load(); assert.equal(app.requests.at(-1).get('dimensions'), 'source,model'); assert.equal(metric.value, 'tokens');
  source.value = 'quota'; await app.load(); assert.equal(app.requests.at(-1).get('dimensions'), 'account,window'); assert.equal(app.requests.at(-1).get('metric'), 'used_percent');
  source.value = 'related'; await app.load(); assert.equal(app.requests.at(-1).get('dimensions'), 'project'); assert.equal(metric.value, 'cost');
  source.value = 'requests'; await app.load();
  const model = usage.querySelector('[value="model"]'); model.checked = false;
  assert.equal(model.hasAttribute('checked'), true); await app.load(); assert.equal(app.requests.at(-1).get('dimensions'), 'source');
  select(usage, ['source', 'model', 'provider']); await app.load();
  assert.equal(app.requests.at(-1).get('dimensions'), 'source,model,provider');
  assert.equal(new Set(app.requests.at(-1).get('dimensions').split(',')).size, 3);
});

test('stale requests cannot overwrite empty selection, loading or error', async () => {
  const app = setup('user'); let resolve;
  app.defer(new Promise(done => { resolve = done; })); const first = app.load();
  assert.equal(app.document.getElementById('userMultiDimensionResult').innerHTML, '');
  select(app.root.querySelector('[data-dimension-group="usage"]'), []); await app.load();
  resolve({ ok: true, json: async () => ({ dimensions: ['model'], metric: 'requests', rows: [{ labels: ['OLD'], requests: 99 }] }) }); await first;
  assert.equal(app.document.getElementById('userMultiDimensionResult').innerHTML, '');
  assert.equal(app.root.querySelector('.multi-dimension-status').textContent, '请至少选择一个维度');
  select(app.root.querySelector('[data-dimension-group="usage"]'), ['model']); await app.load();
  app.defer(Promise.resolve({ ok: false, json: async () => ({ error: '测试失败' }) })); await app.load();
  assert.equal(app.document.getElementById('userMultiDimensionResult').innerHTML, '');
  assert.equal(app.root.querySelector('.multi-dimension-status').textContent, '测试失败');
});

test('backend accepts client + model Token and rejects polluted or non-string dimensions', async () => {
  for (const scope of ['admin', 'user']) {
    const calls = []; const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await queryMultiDimensionStats(pool, { dimensions: 'source,model', metric: 'tokens', data_source: 'usage', days: '7' }, scope, 42);
    assert.match(calls[0].sql, /u\.request_source/); assert.match(calls[0].sql, /SUM\(u\.tokens_used\)/);
    assert.deepEqual(calls[0].params, scope === 'user' ? [7, 42] : [7]);
    for (const dimensions of ['source,model,provider,account', 'source,model,provider,provider']) assert.throws(() => parseSelection({ dimensions, metric: 'tokens' }, scope), /有效且不同/);
    await assert.rejects(queryQuotaDimensions(pool, { dimensions: ['provider', 'account'] }, scope, 42), /有效且不同/);
  }
});

test('a newer successful response wins over an older response', async () => {
  const app = setup('user'); let resolve;
  app.defer(new Promise(done => { resolve = done; })); const first = app.load();
  select(app.root.querySelector('[data-dimension-group="usage"]'), ['source']);
  await app.load();
  const result = app.document.getElementById('userMultiDimensionResult').innerHTML;
  resolve({ ok: true, json: async () => ({ dimensions: ['model'], metric: 'requests', rows: [{ labels: ['OLD'], requests: 99 }] }) });
  await first;
  assert.equal(app.document.getElementById('userMultiDimensionResult').innerHTML, result);
  assert.doesNotMatch(result, /OLD/);
});
