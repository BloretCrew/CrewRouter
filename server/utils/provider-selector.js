'use strict';

const cursors = new Map();

function selectHealthyWeighted(candidates, key = 'default') {
  const items = (Array.isArray(candidates) ? candidates : [])
    .filter(item => item && item.enabled !== false);
  if (!items.length) return null;
  const healthy = items.filter(item => !item.cooldownUntil || item.cooldownUntil <= Date.now());
  const pool = healthy.length ? healthy : items;
  const totalWeight = pool.reduce((sum, item) => sum + Math.max(1, Number(item.weight || 1)), 0);
  let cursor = cursors.get(key) || 0;
  cursor %= totalWeight;
  cursors.set(key, (cursor + 1) % totalWeight);
  for (const item of pool) {
    const weight = Math.max(1, Number(item.weight || 1));
    if (cursor < weight) return item;
    cursor -= weight;
  }
  return pool[pool.length - 1];
}

function resetProviderSelector() { cursors.clear(); }
module.exports = { selectHealthyWeighted, resetProviderSelector };
