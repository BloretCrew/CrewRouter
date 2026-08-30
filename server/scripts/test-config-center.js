'use strict';

const assert = require('assert');
const configCenter = require('../config-center');
const legacyConfig = require('../config-loader');

assert.strictEqual(configCenter.get('app.name'), legacyConfig.app.name);
assert.strictEqual(configCenter.has('database.host'), true);
assert.strictEqual(configCenter.get('missing.path', 'fallback'), 'fallback');
assert(Object.isFrozen(configCenter.snapshot));
assert(Object.isFrozen(configCenter.snapshot.app));
assert.throws(() => { configCenter.snapshot.app.name = 'mutated'; }, /Cannot assign|read only/i);
assert.strictEqual(configCenter.snapshot.app.name, legacyConfig.app.name);

console.log('config center tests passed');
