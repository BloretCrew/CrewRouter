'use strict';
const assert = require('node:assert/strict');
const events = require('../plugins/events');

(async () => {
  const delivered = [];
  const fn = value => delivered.push(value);
  events.subscribePluginEvents('plugin-a', 'model.health.changed.v1', fn, ['events:subscribe', 'models:read']);
  assert.throws(() => events.subscribePluginEvents('plugin-b', 'model.health.changed.v1', fn, ['events:subscribe']), /需要权限/);
  const emitted = events.publish('model.health.changed.v1', {
    modelId: 'model-1', health: 'degraded', statusCode: 503,
    observedAt: '2026-11-23T00:00:00Z', secret: 'must-not-escape', messages: 'must-not-escape',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.deepEqual(Object.keys(emitted.payload).sort(), ['health', 'modelId', 'observedAt', 'statusCode']);
  assert.equal(emitted.schemaVersion, 1);
  assert.equal(emitted.event, 'model.health.changed.v1');
  assert.throws(() => events.publish('unknown.event.v1', {}), /未知插件事件/);
  assert.throws(() => events.publish('quota.threshold.v1', []), /必须是对象/);
  assert.equal(events.publish('quota.threshold.v1', { scope: 'tokens:24', remaining: 5, threshold: 10 }), null,
    'first observation establishes the baseline');
  const crossed = events.publish('quota.threshold.v1', { scope: 'tokens:24', remaining: 20, threshold: 10 });
  assert.ok(crossed, 'crossing threshold state publishes');
  assert.equal(events.publish('quota.threshold.v1', { scope: 'tokens:24', remaining: 25, threshold: 10 }), null,
    'stable state does not duplicate notifications');
  assert.throws(() => events.subscribePluginEvents('x', 'unknown.event.v1', fn), /未知插件事件/);
  events.unsubscribePluginEvents('plugin-a');
  const recovery = events.publish('model.health.changed.v1', { modelId: 'model-1', health: 'healthy' });
  assert.ok(recovery, 'health state transition should publish');
  const duplicate = events.publish('model.health.changed.v1', { modelId: 'model-1', health: 'healthy' });
  assert.equal(duplicate, null, 'unchanged health state is suppressed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 1, 'unloaded plugin receives no later events');
  console.log('PASS versioned plugin event schemas, field allowlists, limits and unsubscribe');
})().catch(error => { console.error(error); process.exitCode = 1; });
