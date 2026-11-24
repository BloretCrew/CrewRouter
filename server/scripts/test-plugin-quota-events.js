'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const events = require('../plugins/events');
let fetchCalls = 0;
const published = [];
const warnings = [];
const source = fs.readFileSync(path.resolve(__dirname, '../utils/api-signature.js'), 'utf8');
const filename = path.resolve(__dirname, '../utils/api-signature.js');
const fixtureModule = { exports: {} };
vm.runInNewContext(source, {
  module: fixtureModule, exports: fixtureModule.exports, __dirname: path.dirname(filename),
  Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Promise, Date, Math, Number, String, Object, Array, Set, Map, RegExp, JSON, console,
  require(id) {
    if (id === '../models/database') return { pool: { async query() { return { rows: [] }; } } };
    if (id === './quota-data') return { getUserQuotaBuffer: () => [] };
    if (id === '../logger') return { warn(message) { warnings.push(message); }, error() {}, info() {} };
    if (id === '../proxy-pool') return { async pinnedFetch() { fetchCalls++; return { ok: true, async json() { return { usage: { rolling: { percent: 95 }, weekly: { percent: 40 } } }; } }; } };
    if (id === '../plugins/events') return { publish(name, payload) { published.push({ name, payload }); return { event: name, payload }; } };
    throw new Error(`Unexpected dependency ${id}`);
  },
});
(async () => {
  const api = fixtureModule.exports;
  assert.equal(await api.getOpenCodeGoQuotaWarning({ quota_mode: 'opencode_go', api_key: 'secret' }, false), '');
  assert.equal(fetchCalls, 0, 'disabled Key must not query upstream quota');
  const warning = await api.getOpenCodeGoQuotaWarning({ quota_mode: 'opencode_go', api_key: 'secret' }, true);
  assert.match(warning, /剩余 5%/, JSON.stringify({ published, warnings, fetchCalls }));
  assert.equal(fetchCalls, 1);
  assert.deepEqual(published.map(event => event.name), ['quota.threshold.v1', 'quota.threshold.v1']);
  assert.equal(published[0].payload.scope, 'opencode_go:rolling');
  assert.equal(published[0].payload.remaining, 5);
  assert.equal('userId' in published[0].payload, false);
  assert.equal('keyId' in published[0].payload, false);
  console.log('PASS quota threshold event is Key-opt-in gated and contains no user/key identifier');
})().catch(error => { console.error(error); process.exitCode = 1; });
