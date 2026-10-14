#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/js/admin-model-library.js'), 'utf8');

function fixture(teamAdmin = true) {
  const nodes = new Map();
  const node = () => ({ innerHTML: '', textContent: '', hidden: false, dataset: {}, value: '', querySelector: () => null, classList: { add() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, removeEventListener() {} });
  const container = { ...node(), querySelector: selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, querySelectorAll: () => [], contains: () => true, dispatchEvent() {} };
  const app = { _instance: { capabilities: { teamAdmin } } };
  const calls = [];
  const listeners = new Map();
  const document = { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
  const context = { document, window: { location: { hash: '#adminModelLibrary/team/12' }, confirm: async message => { calls.push({ confirm: message }); return true; } }, URLSearchParams, AbortController, setTimeout, clearTimeout, CustomEvent: class {}, fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url === '/api/admin/teams' ? [{ id: 12, name: '研发', member_count: 3, is_default: true, is_frontier: true }] : { items: [], total: 0, stats: {} } }; } };
  vm.runInNewContext(source, context);
  const lib = new context.window.AdminModelLibrary(app);
  const click = (action, data = {}) => lib.onClick({ target: { closest: () => ({ dataset: { action, ...data }, disabled: false }) } });
  return { lib, app, calls, context, container, nodes, click, listeners };
}

test('Personal/Local hides TEAM controls and never calls TEAM APIs', async () => {
  const f = fixture(false);
  f.lib.mount(f.container);
  await f.lib.load({ teamId: 12 });
  await f.click('create-team');
  await f.click('team', { team: '12' });
  await f.lib.openManager('teams', '12');
  assert.equal(f.nodes.get('.aml-scope').hidden, true);
  assert.doesNotMatch(f.container.innerHTML, /data-action="(?:create-team|manage-teams)"/);
  assert.equal(f.lib.teamId, '');
  assert.ok(f.calls.every(call => !call.url?.startsWith('/api/admin/teams')));
  await assert.rejects(f.lib.request('/api/admin/teams/12/models'), /不支持 TEAM/);
  f.lib.destroy();
});

test('mount restores hash, TEAM switch persists hash, load does not abort TEAM request', async () => {
  const f = fixture();
  f.app._parseAdminHash = () => ({ teamId: 12 });
  let hash;
  f.app._writeAdminHash = (page, options) => { hash = { page, teamId: options.teamId }; };
  let resolveTeams;
  let signal;
  f.context.fetch = async (url, options) => {
    if (url === '/api/admin/teams') { signal = options.signal; return new Promise(resolve => { resolveTeams = () => resolve({ ok: true, json: async () => [{ id: 12, name: '研发', member_count: 3, is_frontier: true }] }); }); }
    return { ok: true, json: async () => ({ items: [], total: 0, stats: {} }) };
  };
  f.lib.mount(f.container);
  assert.equal(f.lib.teamId, '12');
  await f.lib.load();
  assert.equal(signal.aborted, false);
  resolveTeams();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.lib.teams.length, 1);
  await f.click('team', { team: '13' });
  assert.deepEqual(hash, { page: 'adminModelLibrary', teamId: '13' });
  f.lib.destroy();
});

test('cards escape content, lock system-disabled TEAM switches and expose shortcuts', () => {
  const { lib } = fixture();
  lib.teamId = '12';
  const html = lib.card({ model_id: 'm', name: '<unsafe>', system_enabled: false, team_enabled: true, test_ok: true });
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /data-system-locked="false"/);
  assert.match(lib.card({ model_id: 'm', system_enabled: false, team_enabled: false }), /disabled data-system-locked="true"/);
  assert.match(html, /data-action="system-enable"/);
  assert.match(html, /data-action="trace-model"/);
  assert.match(html, /data-action="uptime-model"/);
  assert.match(html, /测试成功/);
  assert.match(lib.card({ model_id: 'm', system_enabled: true, team_enabled: false }), /TEAM 未授权/);
});

test('single PUT, batch POST, cleared_keys, cancellation and one notification refresh', async () => {
  const f = fixture();
  f.lib.teamId = '12';
  f.lib.teams = [{ id: 12, name: '研发' }];
  f.lib.groups.set('p', { items: [{ model_id: 'm', system_enabled: true }] });
  let request;
  let loads = 0;
  f.lib.request = async (url, options) => { request = { url, ...options }; return { updated: 1, cleared_keys: 2 }; };
  f.lib.load = async () => { loads++; };
  f.lib.notice = message => { f.message = message; };
  f.app._notifyModelsCatalogChanged = () => f.lib.catalogChanged();
  await f.lib.setEnabled(['m'], false, true);
  assert.equal(request.method, 'PUT');
  assert.equal(request.url, '/api/admin/teams/12/models/m');
  assert.match(f.message, /清理 2 个 Key 绑定/);
  assert.equal(loads, 1);
  assert.match(f.calls[0].confirm, /研发/);
  await f.lib.setEnabled(['m', 'n'], true);
  assert.equal(request.url, '/api/admin/teams/12/models/batch');
  assert.deepEqual(JSON.parse(request.body), { modelIds: ['m', 'n'], enabled: true });
  f.lib.teamId = '';
  await f.lib.setEnabled(['m'], true, true);
  assert.equal(request.url, '/api/admin/models/batch-update');
  assert.deepEqual(JSON.parse(request.body), { ids: ['m'], enabled: true });
  request = null;
  f.context.window.confirm = async () => false;
  await f.lib.setEnabled(['m'], false, true);
  assert.equal(request, null);
});

test('TEAM disabled system model cannot call authorization endpoint', async () => {
  const { lib } = fixture();
  lib.teamId = '12';
  lib.groups.set('p', { items: [{ model_id: 'm', system_enabled: false }] });
  lib.request = async () => { throw new Error('must not request'); };
  lib.notice = () => {};
  await lib.setEnabled(['m'], true, true);
});

test('TEAM can revoke existing authorization while the system model is disabled', async () => {
  const { lib } = fixture();
  lib.teamId = '12';
  lib.groups.set('p', { items: [{ model_id: 'm', system_enabled: false, team_enabled: true }] });
  let write;
  lib.request = async (url, options) => { write = { url, body: JSON.parse(options.body) }; return { cleared_keys: 1 }; };
  lib.load = async () => {};
  lib.notice = () => {};
  await lib.setEnabled(['m'], false, true);
  assert.equal(write.url, '/api/admin/teams/12/models/m');
  assert.deepEqual(write.body, { enabled: false });
});

test('batch ranges collect all server pages and provider range clears filters', async () => {
  const { lib } = fixture();
  lib.teamId = '12';
  lib.filters.q = 'gpt';
  lib.filters.series = 'GPT';
  const queries = [];
  lib.request = async url => {
    const query = new URL(url, 'http://test').searchParams;
    queries.push(query);
    return { items: [{ model_id: `m${query.get('page')}` }], total: 3, limit: 1 };
  };
  assert.deepEqual(Array.from(await lib.collectModelIds()), ['m1', 'm2', 'm3']);
  assert.equal(queries.length, 3);
  assert.equal(queries[0].get('q'), 'gpt');
  queries.length = 0;
  await lib.collectModelIds('p');
  assert.equal(queries[0].get('provider'), 'p');
  assert.equal(queries[0].get('q'), null);
  assert.equal(queries[0].get('teamId'), '12');
  lib.request = async () => { lib.filters.q = 'changed'; return { items: [], total: 0 }; };
  await assert.rejects(lib.collectModelIds(), /范围已变更/);
});

test('concurrent catalog notifications coalesce into one load', async () => {
  const { lib } = fixture();
  let resolve;
  let loads = 0;
  lib.load = () => { loads++; return new Promise(done => { resolve = done; }); };
  const first = lib.catalogChanged();
  const second = lib.catalogChanged();
  assert.equal(loads, 1);
  resolve();
  await Promise.all([first, second]);
});

test('header, provider statistics and price sorting preserve existing selectors', async () => {
  const f = fixture();
  f.lib.mount(f.container);
  assert.match(f.container.innerHTML, /data-action="add-provider"/);
  assert.match(f.container.innerHTML, /data-action="add-model"/);
  assert.match(f.container.innerHTML, /data-action="create-team"/);
  assert.match(f.container.innerHTML, /value="price_asc"/);
  assert.match(f.container.innerHTML, /value="price_desc"/);
  f.lib.teamId = '12';
  f.lib.providers = [{ id: 'p', name: '供应商', model_count: 0, team_enabled_count: 2 }];
  f.lib.total = 1;
  f.lib.renderDirectory();
  const html = f.nodes.get('.aml-directory').innerHTML;
  assert.match(html, /2 已授权/);
  for (const action of ['toggle-provider', 'quota-provider', 'trace-provider', 'enable-provider', 'disable-provider']) assert.match(html, new RegExp(`data-action="${action}"`));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.nodes.get('.aml-team-tabs').innerHTML, /3 成员.*默认.*前沿/);
  f.lib.destroy();
});

test('AdminLibraryText translates buttons, parameterized cards and preserves caller names', async () => {
  const f = fixture();
  const english = JSON.parse(fs.readFileSync(path.join(__dirname, '../lang/en.json'), 'utf8'));
  f.context.window.t = (key, vars) => String(english[key] || key).replace(/\{(\w+)\}/g, (match, name) => vars?.[name] ?? match);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/admin-library-i18n.js'), 'utf8'), f.context);
  f.lib.mount(f.container);
  assert.match(f.container.innerHTML, /Create TEAM/);
  assert.match(f.container.innerHTML, /Search TEAM names/);
  const card = f.lib.card({ model_id: 'm', name: '测试成功', system_enabled: true, test_ok: true, model_multiplier: 2 });
  assert.match(card, /<strong>测试成功<\/strong>/);
  assert.match(card, /Test passed/);
  assert.match(card, /Multiplier 2/);
  assert.match(f.lib.pagination(2, 10, 30, 'model-page'), /Page 2 \/ 3, 30 total/);
  assert.equal(f.listeners.get('i18n:ready'), f.lib._language);
  f.lib.destroy();
  assert.equal(f.listeners.has('i18n:ready'), false);
});

test('quota overview mounts and loads historical widget without real quota checks', async () => {
  const f = fixture();
  const actions = [];
  f.context.window.CrewRouterProviderQuotaStats = { mount: (host, scope) => actions.push(['mount', scope]), load: async () => actions.push(['load']) };
  f.app.checkProviderQuota = () => { throw new Error('must not check quota automatically'); };
  f.app.refreshPageQuotas = () => { throw new Error('must not refresh quota automatically'); };
  f.lib.mount(f.container);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, [['mount', 'admin'], ['load']]);
  assert.match(f.container.innerHTML, /class="aml-quota-host"/);
  f.lib.destroy();
});

test('legacy quota widget is supported and real refresh requires explicit action', async () => {
  const f = fixture();
  let reads = 0;
  const actions = [];
  f.context.window.CrewRouterQuotaStats = { refresh: scope => { assert.equal(scope, 'admin'); reads++; } };
  f.app.openLibraryManager = async kind => actions.push(kind);
  f.app.refreshPageQuotas = () => actions.push('refresh');
  f.app.pingProvider = () => actions.push('ping');
  f.lib.mount(f.container);
  assert.equal(reads, 1);
  assert.deepEqual(actions, []);
  await f.click('refresh-quotas');
  assert.deepEqual(actions, ['providers', 'refresh']);
  await f.click('test-provider', { id: 'p' });
  assert.deepEqual(actions.slice(-2), ['providers', 'ping']);
  f.lib.destroy();
});

test('provider tags are selectable names, deduplicated and escaped', () => {
  const f = fixture();
  f.lib.container = f.container;
  f.lib.updateOptions({ providers: [
    { id: 'p', name: 'P', tags: [{ id: 3, name: '<tag>' }] },
    { id: 'q', name: 'Q', tags: [{ id: 3, name: '<tag>' }, { id: 4, name: 'second' }] }
  ], series: [] });
  const html = f.nodes.get('[data-filter="tag"]').innerHTML;
  assert.match(html, /value="3">&lt;tag&gt;/);
  assert.equal((html.match(/value="3"/g) || []).length, 1);
  assert.match(html, /value="4">second/);
});

test('personal TEAMs are grouped and collapsed by default, search opens matches', () => {
  const f = fixture();
  f.lib.container = f.container;
  f.lib.teams = [{ id: 1, name: 'Shared' }, { id: 2, name: 'Private', is_personal: true }];
  f.lib.renderTeams();
  assert.doesNotMatch(f.nodes.get('.aml-team-tabs').innerHTML, /Private/);
  assert.match(f.nodes.get('.aml-team-results').innerHTML, /class="aml-personal-teams" ><summary>/);
  f.lib.renderTeams('Private');
  assert.match(f.nodes.get('.aml-team-results').innerHTML, /class="aml-personal-teams" open/);
});

test('i18n ready locally redraws while preserving pages, filters, selection and model data without requests', async () => {
  const f = fixture();
  f.lib.mount(f.container);
  await new Promise(resolve => setImmediate(resolve));
  f.lib.total = 2;
  f.lib.page = 3;
  f.lib.filters.q = 'typing';
  f.lib.selected.add('m');
  f.lib.expanded.add('p');
  const group = { items: [{ model_id: 'm', name: 'original', system_enabled: true }], page: 2, total: 30, limit: 24 };
  f.lib.groups.set('p', group);
  f.lib.container.querySelector('.aml-more-filters').open = true;
  f.context.document.createElement = () => ({ innerHTML: '', content: { querySelector: selector => ({ selector }) } });
  for (const selector of ['.aml-header', '.aml-toolbar', '.aml-quota-heading']) f.nodes.get(selector) || f.container.querySelector(selector);
  for (const selector of ['.aml-header', '.aml-toolbar', '.aml-quota-heading']) f.nodes.get(selector).replaceWith = () => {};
  f.container.querySelector('.aml-team-more').querySelector = () => ({ textContent: '' });
  let renders = 0;
  f.lib.providerElement = () => null;
  f.lib.renderProvider = id => { assert.equal(id, 'p'); renders++; };
  const calls = f.calls.length;
  f.listeners.get('i18n:ready')();
  assert.equal(f.calls.length, calls);
  assert.equal(f.lib.page, 3);
  assert.equal(f.lib.filters.q, 'typing');
  assert.equal(f.lib.selected.has('m'), true);
  assert.equal(f.lib.expanded.has('p'), true);
  assert.equal(f.lib.groups.get('p'), group);
  assert.equal(group.page, 2);
  assert.equal(renders, 1);
  assert.equal(f.nodes.get('.aml-more-filters').open, true);
  f.lib.destroy();
});
