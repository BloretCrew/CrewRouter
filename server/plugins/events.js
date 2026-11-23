'use strict';

const subscriptions = new Map();
const MAX_EVENT_BYTES = 32 * 1024;
const EVENT_DEFINITIONS = Object.freeze({
  'plugin.lifecycle.v1': { permissions: ['events:subscribe'], fields: ['pluginId', 'action', 'version'] },
  'model.health.changed.v1': { permissions: ['events:subscribe'], fields: ['modelId', 'health', 'statusCode', 'observedAt'] },
  'quota.threshold.v1': { permissions: ['events:subscribe'], fields: ['scope', 'remaining', 'threshold', 'observedAt'] },
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

function subscribePluginEvents(pluginId, eventName, handler) {
  if (!EVENT_DEFINITIONS[eventName]) throw new Error(`未知插件事件: ${eventName}`);
  const key = `${pluginId}:${eventName}`;
  const set = subscriptions.get(key) || new Set();
  set.add(handler);
  subscriptions.set(key, set);
}

function unsubscribePluginEvents(pluginId) {
  for (const key of subscriptions.keys()) if (key.startsWith(`${pluginId}:`)) subscriptions.delete(key);
}

function publish(eventName, value) {
  const event = sanitize(eventName, value);
  for (const [key, handlers] of subscriptions) {
    if (!key.endsWith(`:${eventName}`)) continue;
    for (const handler of handlers) {
      Promise.resolve().then(() => handler(event)).catch(error => {
        console.warn(`[plugins] event handler failed (${eventName}): ${String(error?.message || error).slice(0, 300)}`);
      });
    }
  }
  return event;
}

module.exports = { EVENT_DEFINITIONS, subscribePluginEvents, unsubscribePluginEvents, publish, sanitize, MAX_EVENT_BYTES };
