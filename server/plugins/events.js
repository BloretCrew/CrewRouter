'use strict';

const subscriptions = new Map();
const MAX_EVENT_BYTES = 32 * 1024;
const lastHealthState = new Map();
const lastQuotaThreshold = new Map();
const deliveryQueue = [];
let deliveryTimer = null;
const MAX_PENDING_DELIVERIES = 1000;
const HANDLER_TIMEOUT_MS = 1000;
const EVENT_DEFINITIONS = Object.freeze({
  'plugin.lifecycle.v1': { permissions: ['events:subscribe'], fields: ['pluginId', 'action', 'version'] },
  'model.health.changed.v1': { permissions: ['events:subscribe', 'models:read'], fields: ['modelId', 'health', 'statusCode', 'observedAt'] },
  'quota.threshold.v1': { permissions: ['events:subscribe', 'usage:read'], fields: ['scope', 'remaining', 'threshold', 'observedAt'] },
});

function sanitize(eventName, value) {
  const definition = EVENT_DEFINITIONS[eventName];
  if (!definition) throw new Error(`未知插件事件: ${eventName}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件事件 payload 必须是对象');
  const payload = {};
  for (const field of definition.fields) {
    const item = value[field];
    if (item === undefined || item === null) continue;
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') continue;
    payload[field] = typeof item === 'string' ? item.slice(0, 256) : item;
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_EVENT_BYTES) throw new Error('插件事件 payload 超过大小限制');
  return Object.freeze({ schemaVersion: 1, event: eventName, occurredAt: new Date().toISOString(), payload });
}

function subscribePluginEvents(pluginId, eventName, handler, permissions = []) {
  const definition = EVENT_DEFINITIONS[eventName];
  if (!definition) throw new Error(`未知插件事件: ${eventName}`);
  if (!definition.permissions.every(permission => permissions.includes(permission))) throw new Error(`订阅 ${eventName} 需要权限: ${definition.permissions.join(', ')}`);
  const key = `${pluginId}:${eventName}`;
  const set = subscriptions.get(key) || new Set();
  set.add(handler);
  subscriptions.set(key, set);
}

function unsubscribePluginEvents(pluginId) {
  for (const key of subscriptions.keys()) if (key.startsWith(`${pluginId}:`)) subscriptions.delete(key);
  for (let index = deliveryQueue.length - 1; index >= 0; index--) {
    if (deliveryQueue[index].pluginId === pluginId) deliveryQueue.splice(index, 1);
  }
}

function resetEventStateForTests() {
  lastHealthState.clear();
  lastQuotaThreshold.clear();
  deliveryQueue.length = 0;
}

function drainDeliveryQueue() {
  deliveryTimer = null;
  const batch = deliveryQueue.splice(0, 100);
  for (const { handler, event } of batch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('插件事件处理超时')), HANDLER_TIMEOUT_MS);
    Promise.resolve().then(() => handler(event, { signal: controller.signal })).catch(error => {
      console.warn(`[plugins] event handler failed (${event.event}): ${String(error?.message || error).slice(0, 300)}`);
    }).finally(() => clearTimeout(timer));
  }
  if (deliveryQueue.length) scheduleDelivery();
}

function scheduleDelivery() {
  if (deliveryTimer) return;
  deliveryTimer = setImmediate(drainDeliveryQueue);
  deliveryTimer.unref?.();
}

function publish(eventName, value) {
  const event = sanitize(eventName, value);
  const payload = event.payload;
  if (eventName === 'model.health.changed.v1') {
    const key = String(payload.modelId || '');
    const next = String(payload.health || 'unknown');
    if (!key || lastHealthState.get(key) === next) return null;
    lastHealthState.set(key, next);
  }
  if (eventName === 'quota.threshold.v1') {
    const key = String(payload.scope || '');
    const threshold = Number(payload.threshold);
    const remaining = Number(payload.remaining);
    if (!key || !Number.isFinite(threshold) || !Number.isFinite(remaining)) return null;
    const next = remaining <= threshold;
    if (!lastQuotaThreshold.has(key)) {
      lastQuotaThreshold.set(key, next);
      return null;
    }
    if (lastQuotaThreshold.get(key) === next) return null;
    lastQuotaThreshold.set(key, next);
  }
  const normalizedEvent = Object.freeze({ ...event, payload });
  for (const [key, handlers] of subscriptions) {
    if (!key.endsWith(`:${eventName}`)) continue;
    for (const handler of handlers) {
      if (deliveryQueue.length >= MAX_PENDING_DELIVERIES) {
        console.warn(`[plugins] event delivery queue full; dropping ${eventName}`);
        continue;
      }
      deliveryQueue.push({ pluginId: key.slice(0, key.indexOf(':')), handler, event: normalizedEvent });
    }
  }
  scheduleDelivery();
  return normalizedEvent;
}

module.exports = { EVENT_DEFINITIONS, subscribePluginEvents, unsubscribePluginEvents, publish, sanitize, resetEventStateForTests, MAX_EVENT_BYTES };
