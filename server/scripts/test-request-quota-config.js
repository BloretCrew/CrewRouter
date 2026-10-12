'use strict';
const assert=require('node:assert/strict');
const {DEFAULTS,normalizeRequestQuotaConfig}=require('../utils/request-quota-config');
assert.deepEqual(normalizeRequestQuotaConfig(),DEFAULTS);
assert.equal(normalizeRequestQuotaConfig({mode:'strict'}).mode,'strict');
assert.equal(normalizeRequestQuotaConfig({enabled:false}).enabled,false);
for(const input of [null,[],{enabled:'false'},{mode:'random'},{unknown:true},{max_tries:0},{batch_size:101},{lease_seconds:29},{reconciliation_seconds:-1},{worker_interval_ms:499},{worker_interval_ms:'2000'}])assert.throws(()=>normalizeRequestQuotaConfig(input));
console.log('PASS request quota config defaults, strict/async, booleans, numeric bounds, field whitelist');
