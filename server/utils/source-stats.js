'use strict';

/**
 * 客户端维度统计：固定全集、占比、识别率
 */

const ALL_REQUEST_SOURCES = Object.freeze([
  'grok',
  'codex',
  'claude_code',
  'opencode',
  'qwen_code',
  'hermes',
  'openclaw',
  'deepseek_harness',
  'unknown',
]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Array<object>} rows - SQL 聚合行
 * @returns {{ bySource: Array, sourceSummary: object }}
 */
function buildSourceStats(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const id = String(r.request_source || 'unknown').toLowerCase() || 'unknown';
    map.set(id, {
      request_source: id,
      requests: num(r.requests),
      tokens: num(r.tokens),
      prompt_tokens: num(r.prompt_tokens),
      completion_tokens: num(r.completion_tokens),
      cached_tokens: num(r.cached_tokens),
      cost: num(r.cost),
      avg_latency: r.avg_latency != null ? num(r.avg_latency) : null,
    });
  }

  let totalRequests = 0;
  let totalTokens = 0;
  let totalCost = 0;
  for (const row of map.values()) {
    totalRequests += row.requests;
    totalTokens += row.tokens;
    totalCost += row.cost;
  }

  const bySource = ALL_REQUEST_SOURCES.map((id) => {
    const row = map.get(id) || {
      request_source: id,
      requests: 0,
      tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      cost: 0,
      avg_latency: null,
    };
    return {
      ...row,
      share_requests: totalRequests > 0 ? row.requests / totalRequests : 0,
      share_tokens: totalTokens > 0 ? row.tokens / totalTokens : 0,
      share_cost: totalCost > 0 ? row.cost / totalCost : 0,
    };
  }).sort((a, b) => b.requests - a.requests || a.request_source.localeCompare(b.request_source));

  // 把 map 中不在白名单的意外 id 也带上（兼容）
  for (const [id, row] of map.entries()) {
    if (!ALL_REQUEST_SOURCES.includes(id)) {
      bySource.push({
        ...row,
        share_requests: totalRequests > 0 ? row.requests / totalRequests : 0,
        share_tokens: totalTokens > 0 ? row.tokens / totalTokens : 0,
        share_cost: totalCost > 0 ? row.cost / totalCost : 0,
      });
    }
  }

  const unknownRequests = num(map.get('unknown')?.requests);
  const knownRequests = Math.max(0, totalRequests - unknownRequests);
  const activeSources = bySource.filter((r) => r.requests > 0 && r.request_source !== 'unknown').length;

  return {
    bySource,
    sourceSummary: {
      total_requests: totalRequests,
      known_requests: knownRequests,
      unknown_requests: unknownRequests,
      identified_rate: totalRequests > 0 ? knownRequests / totalRequests : 0,
      active_sources: activeSources,
    },
  };
}

module.exports = {
  ALL_REQUEST_SOURCES,
  buildSourceStats,
};
