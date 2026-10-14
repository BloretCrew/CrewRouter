#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../public/js/admin-library-team-rules.js'), 'utf8');
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.events = {};
    this.value = '';
    this.textContent = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
  querySelectorAll(tag) {
    return this.children.flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag) ]);
  }
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = (data, ok = true) => ({ ok, json: async () => data });
function setup() {
  const calls = [];
  const queue = [];
  const confirmations = [];
  const context = {
    window: {}, document: { createElement: tag => new Element(tag) }, AbortController,
    fetch: (url, options) => {
      calls.push({ url, options });
      const next = queue.shift();
      if (!next) throw new Error('Unexpected request');
      return typeof next === 'function' ? next() : Promise.resolve(next);
    },
    Dialog: { confirm: (...args) => { confirmations.push(args); return Promise.resolve(true); } }
  };
  vm.runInNewContext(source, context);
  const host = new Element('div');
  const instance = new context.window.AdminLibraryTeamRules(host);
  return { instance, host, calls, queue, context, confirmations };
}
async function loaded(rules = []) {
  const fixture = setup();
  fixture.queue.push(response(rules));
  assert.equal(await fixture.instance.load('team/a'), true);
  return fixture;
}
function fill(instance, type = 'tokens', value = '1.5', duration = '0.5') {
  instance.type.value = type;
  instance.value.value = value;
  instance.duration.value = duration;
}

test('mount/load contract, encoded endpoint, native controls and empty state', async () => {
  const f = setup();
  f.queue.push(response([]));
  const instance = f.context.window.AdminLibraryTeamRules.mount(f.host, 'team/a');
  assert.equal(instance, f.instance);
  assert.equal(await instance.ready, true);
  assert.equal(f.calls[0].url, '/api/admin/teams/team%2Fa/rules');
  assert.equal(f.calls[0].options.credentials, 'same-origin');
  assert.equal(instance.list.children[0].textContent, '暂无限额规则');
  assert.deepEqual(instance.type.children.map(node => node.value), ['requests', 'tokens']);
  assert.equal(instance.value.step, 'any');
  assert.ok(instance.form.events.submit);
  assert.doesNotMatch(source, /innerHTML|onclick\s*=/);
});

test('POST uses API fields and finite positive decimals; clears fields only on success', async () => {
  const f = await loaded();
  fill(f.instance);
  f.queue.push(response({ id: 'rule-1', rule_type: 'tokens', rule_value: 1.5, duration_hours: 0.5 }));
  assert.equal(await f.instance.add(), true);
  const call = f.calls[1];
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.options.body), { rule_type: 'tokens', rule_value: 1.5, duration_hours: 0.5 });
  assert.equal(f.instance.value.value, '');
  assert.equal(f.instance.rules.length, 1);
});

test('validation matches API for both rule types and rejects invalid values without requests', async () => {
  const f = await loaded();
  for (const [type, value, duration] of [
    ['request', '1', '1'], ['requests', '', '1'], ['tokens', '0', '1'],
    ['tokens', '-1', '1'], ['tokens', 'Infinity', '1'], ['tokens', 'NaN', '1'],
    ['requests', '1', '0'], ['requests', '1', '-1'], ['requests', '1', 'Infinity']
  ]) {
    fill(f.instance, type, value, duration);
    assert.equal(await f.instance.add(), false);
  }
  assert.equal(f.calls.length, 1);
  fill(f.instance, 'requests', '2', '24');
  f.queue.push(response({ id: 'r', rule_type: 'requests', rule_value: 2, duration_hours: 24 }));
  assert.equal(await f.instance.add(), true);
});

test('failed load can retry, and failed POST retains form for resubmission', async () => {
  const f = setup();
  f.queue.push(response({ error: '暂时不可用' }, false));
  assert.equal(await f.instance.load(1), false);
  assert.equal(f.instance.retry.hidden, false);
  assert.equal(f.instance.addButton.disabled, true);
  f.queue.push(response([]));
  await f.instance.load(1);
  fill(f.instance);
  f.queue.push(response({ error: '添加失败' }, false));
  assert.equal(await f.instance.add(), false);
  assert.equal(f.instance.value.value, '1.5');
  assert.equal(f.instance.duration.value, '0.5');
  assert.equal(f.instance.status.textContent, '添加失败');
  assert.equal(f.instance.addButton.disabled, false);
  f.queue.push(response({ id: 'new' }));
  assert.equal(await f.instance.add(), true);
});

test('DELETE confirmation, encoded rule id, failure preserves rule and successful retry removes it', async () => {
  const rule = { id: 'r/<script>', rule_type: 'requests', rule_value: 2, duration_hours: 1, description: '<img onerror=alert(1)>' };
  const f = await loaded([rule]);
  assert.equal(f.instance.list.children[0].children[1].textContent, rule.description);
  f.context.Dialog.confirm = async () => false;
  assert.equal(await f.instance.remove(rule), false);
  assert.equal(f.calls.length, 1);
  f.context.Dialog.confirm = async (...args) => { f.confirmations.push(args); return true; };
  f.queue.push(response({ error: '删除失败' }, false));
  assert.equal(await f.instance.remove(rule), false);
  assert.equal(f.instance.rules.length, 1);
  assert.equal(f.instance.list.querySelectorAll('button')[0].disabled, false);
  f.queue.push(response({ success: true }));
  assert.equal(await f.instance.remove(rule), true);
  assert.equal(f.calls[2].url, '/api/admin/teams/team%2Fa/rules/r%2F%3Cscript%3E');
  assert.equal(f.calls[2].options.method, 'DELETE');
  assert.equal(f.confirmations[0][2].danger, true);
  assert.equal(f.instance.rules.length, 0);
});

test('out-of-order loads cannot replace current TEAM rules or status', async () => {
  const f = setup();
  const pending = deferred();
  f.queue.push(() => pending.promise, response([{ id: 'b' }]));
  const oldLoad = f.instance.load('a');
  const oldSignal = f.calls[0].options.signal;
  await f.instance.load('b');
  assert.equal(oldSignal.aborted, true);
  pending.resolve(response([{ id: 'a' }]));
  assert.equal(await oldLoad, false);
  assert.equal(f.instance.rules[0].id, 'b');
  assert.equal(f.instance.busy, false);
});

test('switching TEAM during POST ignores stale result and preserves new TEAM draft', async () => {
  const f = await loaded();
  const pending = deferred();
  fill(f.instance);
  f.queue.push(() => pending.promise, response([{ id: 'b' }]));
  const adding = f.instance.add();
  assert.equal(await f.instance.add(), false);
  await f.instance.load('b');
  fill(f.instance, 'requests', '12', '24');
  pending.resolve(response({ id: 'old' }));
  assert.equal(await adding, false);
  assert.equal(f.instance.rules[0].id, 'b');
  assert.equal(f.instance.value.value, '12');
});

test('switching TEAM while confirmation is open never sends stale DELETE', async () => {
  const rule = { id: 'r' };
  const f = await loaded([rule]);
  const pending = deferred();
  f.context.Dialog.confirm = () => pending.promise;
  const removing = f.instance.remove(rule);
  f.queue.push(response([]));
  await f.instance.load('b');
  pending.resolve(true);
  assert.equal(await removing, false);
  assert.equal(f.calls.length, 2);
});

test('late DELETE success and failures cannot mutate new TEAM', async () => {
  for (const ok of [true, false]) {
    const rule = { id: 'r' };
    const f = await loaded([rule]);
    const pending = deferred();
    f.queue.push(() => pending.promise);
    const deleting = f.instance.remove(rule);
    await new Promise(resolve => setImmediate(resolve));
    f.queue.push(response([{ id: 'r' }]));
    await f.instance.load('b');
    pending.resolve(response(ok ? { success: true } : { error: '旧错误' }, ok));
    assert.equal(await deleting, false);
    assert.equal(f.instance.rules.length, 1);
    assert.equal(f.instance.status.textContent, '');
  }
});

test('destroy and remount invalidate outstanding requests; no TEAM disables form', async () => {
  const f = setup();
  const pending = deferred();
  f.queue.push(() => pending.promise);
  const loading = f.instance.load(1);
  const replacement = new f.context.window.AdminLibraryTeamRules(f.host);
  pending.resolve(response([{ id: 'stale' }]));
  assert.equal(await loading, false);
  assert.equal(f.instance.host, null);
  assert.equal(await replacement.load(null), false);
  assert.equal(replacement.addButton.disabled, true);
  assert.equal(replacement.status.textContent, '请选择 TEAM');
  replacement.destroy();
  assert.equal(f.host.children.length, 0);
});

test('malformed successful GET is reported and retryable', async () => {
  const f = setup();
  f.queue.push(response({ rules: [] }));
  assert.equal(await f.instance.load(1), false);
  assert.equal(f.instance.retry.hidden, false);
  assert.equal(f.instance.loaded, false);
});
