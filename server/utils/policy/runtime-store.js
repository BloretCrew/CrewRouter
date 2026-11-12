'use strict';

/**
 * ladder 计数与自动动作状态。
 * P0 使用进程内计数（单实例精确、多实例近似）；命中明细仍落库。
 */

const counters = new Map();
const MAX_ENTRIES = 10000;

function subjectKey(policyId, subject = {}) {
  if (subject.type === 'api_key') return `k:${subject.id}`;
  if (subject.type === 'team') return `t:${subject.id}`;
  if (subject.type === 'model') return `m:${subject.id}`;
  if (subject.type === 'client') return `c:${subject.id}`;
  return `u:${subject.id}`;
}

function makeKey(policyId, subject, windowSeconds) {
  const window = Math.max(1, Number(windowSeconds) || 300);
  const start = Math.floor(Date.now() / (window * 1000)) * window * 1000;
  return `${policyId}:${subjectKey(policyId, subject)}:${window}:${start}`;
}

function record(policyId, subject, windowSeconds = 300) {
  const key = makeKey(policyId, subject, windowSeconds);
  const entry = counters.get(key) || { hits: 0, at: Date.now(), windowSeconds };
  entry.hits += 1;
  entry.at = Date.now();
  counters.set(key, entry);
  if (counters.size > MAX_ENTRIES) {
    const cutoff = Date.now() - 3600_000;
    for (const [k, value] of counters) if (value.at < cutoff) counters.delete(k);
  }
  return entry.hits;
}

function count(policyId, subject, windowSeconds = 300) {
  return counters.get(makeKey(policyId, subject, windowSeconds))?.hits || 0;
}

function ladderAction(ladder, hits) {
  if (!Array.isArray(ladder) || !ladder.length) return null;
  let selected = null;
  for (const tier of ladder) {
    if (hits >= Number(tier.after_hits || 0)) selected = tier;
  }
  return selected;
}

function reset() {
  counters.clear();
}

module.exports = { record, count, ladderAction, subjectKey, reset };
