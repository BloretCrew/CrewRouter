'use strict';

const subscriptions = new Map();
const MAX_EVENT_BYTES = 32 * 1024;
const lastHealthState = new Map();
const lastQuotaThreshold = new Map();
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
}

function resetEventStateForTests() {
  lastHealthState.clear();
  lastQuotaThreshold.clear();
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
      Promise.resolve().then(() => handler(normalizedEvent)).catch(error => {
        console.warn(`[plugins] event handler failed (${eventName}): ${String(error?.message || error).slice(0, 300)}`);
      });
    }
  }
  return normalizedEvent;
}

module.exports = { EVENT_DEFINITIONS, subscribePluginEvents, unsubscribePluginEvents, publish, sanitize, resetEventStateForTests, MAX_EVENT_BYTES };
