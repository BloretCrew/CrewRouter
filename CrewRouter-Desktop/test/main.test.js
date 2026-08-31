'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const main = require('../src/main');

test('main module can be required without Electron installed', () => {
  assert.equal(typeof main.allowedNavigation, 'function');
  assert.equal(typeof main.createDemoState, 'function');
  assert.equal(main.allowedNavigation('file:///tmp/other.html'), false);
});

test('main status exposes an explicit connect state', () => {
  assert.deepEqual(main.currentStatus(), {
    mode: 'connect',
    target: null,
    edition: null,
    capabilities: {},
    protocolVersion: null,
    profile: null,
  });
});
