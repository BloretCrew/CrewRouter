'use strict';

// 命中率异常阈值：前一点骤降超过 40%，且下一点回升。
const CACHE_HIT_DROP_THRESHOLD = 0.4;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cacheHitRate(row) {
  const prompt = number(row?.prompt_tokens);
  const cached = number(row?.cached_tokens);
  return prompt > 0 ? cached / prompt : 0;
}

/**
 * 为按时间升序的缓存命中率序列增加展示标记。
 * 标记落在骤降点，不参与任何统计或计费。
 */
function markCompactionBoundaries(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const next = rows[index + 1];
    const currentRate = cacheHitRate(row);
    const previousRate = cacheHitRate(previous);
    const nextRate = cacheHitRate(next);
    const drop = previousRate > 0 ? (previousRate - currentRate) / previousRate : 0;
    const recovered = nextRate > currentRate;
    return {
      ...row,
      suspected_compaction_boundary: Boolean(previous && next && drop > CACHE_HIT_DROP_THRESHOLD && recovered),
    };
  });
}

module.exports = { CACHE_HIT_DROP_THRESHOLD, cacheHitRate, markCompactionBoundaries };
