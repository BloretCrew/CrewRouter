'use strict';

const DIMENSIONS = ['clients', 'models', 'providers', 'ips', 'protocols'];

function overlaps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return false;
  const set = new Set(a.map(String));
  return b.some(value => {
    const text = String(value);
    if (set.has(text)) return true;
    if (text === '*' || set.has('*')) return true;
    // 简单 glob 相交：前缀相同的 * 规则视为重叠。
    return [...set].some(item => {
      const prefix = item.replace(/\*.*$/, '');
      const otherPrefix = text.replace(/\*.*$/, '');
      return prefix && otherPrefix && (prefix.startsWith(otherPrefix) || otherPrefix.startsWith(prefix));
    });
  });
}

function sameScope(a, b) {
  return a.scope_type === b.scope_type && Number(a.scope_id || 0) === Number(b.scope_id || 0);
}

function detectConflicts(policies) {
  const list = (policies || []).filter(policy => policy.enabled && policy.status === 'published');
  const conflicts = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (!sameScope(a, b)) continue;
      if (a.effect === b.effect) continue;
      const shared = DIMENSIONS.filter(dimension => overlaps(a.conditions?.[dimension], b.conditions?.[dimension]));
      if (!shared.length) continue;
      conflicts.push({
        severity: 'warning',
        type: 'deny_allow_overlap',
        dimension: shared,
        a: { id: a.id, name: a.name, effect: a.effect, action: a.action, priority: a.priority },
        b: { id: b.id, name: b.name, effect: b.effect, action: b.action, priority: b.priority },
        message: '同一作用域下存在重叠的禁止/允许规则；允许规则不能抵消禁止规则。',
      });
    }
  }
  return conflicts;
}

module.exports = { detectConflicts, overlaps, DIMENSIONS };
