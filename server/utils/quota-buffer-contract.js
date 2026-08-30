'use strict';

/**
 * Quota buffer persistence contract. Production quota writes remain unchanged;
 * callers may inject a store in tests or during a future persistence rollout.
 *
 * A store implements load(), save(entries), and clear(). load/save may be async.
 */
function createQuotaBufferStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('quota buffer store must implement load() and save(entries)');
  }
  return {
    async load() {
      const entries = await store.load();
      return Array.isArray(entries) ? entries : [];
    },
    async save(entries) {
      if (!Array.isArray(entries)) throw new TypeError('quota buffer entries must be an array');
      return store.save(entries);
    },
    async clear() {
      if (typeof store.clear === 'function') return store.clear();
      return undefined;
    },
  };
}

async function saveQuotaBufferWithRetry(store, entries, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await store.save(entries);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

module.exports = { createQuotaBufferStore, saveQuotaBufferWithRetry };
