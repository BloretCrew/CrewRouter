function normalizeTokenCount(value, field) {
  if (value == null) return 0;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) {
    throw new TypeError(`Invalid token count: ${field}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 2147483647) {
    throw new RangeError(`Invalid token count: ${field}`);
  }
  return count;
}

function optionalTokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Normalize token usage from different provider response formats.
 * Supports: OpenAI standard, Claude, Gemini.
 *
 * @param {object} usage - Raw usage object from upstream response
 * @param {string} providerFormat - 'openai' | 'anthropic' | 'gemini'
 * @returns {object} Normalized token breakdown
 */
function normalizeUsageTokens(usage, providerFormat = 'openai') {
  if (!usage) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      imageTokens: 0
    };
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cacheCreationTokens = 0;
  let imageTokens = 0;

  if (providerFormat === 'anthropic') {
    // Anthropic: input_tokens 只是未缓存的部分
    // 总输入 = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
    const cacheRead = normalizeTokenCount(usage.cache_read_input_tokens, 'cache_read_input_tokens');
    const cacheCreation = normalizeTokenCount(usage.cache_creation_input_tokens, 'cache_creation_input_tokens');
    const uncachedInput = normalizeTokenCount(usage.input_tokens, 'input_tokens');

    promptTokens = normalizeTokenCount(cacheRead + cacheCreation + uncachedInput, 'promptTokens');
    completionTokens = normalizeTokenCount(usage.output_tokens, 'output_tokens');
    cachedTokens = cacheRead;
    cacheCreationTokens = cacheCreation;
  } else if (providerFormat === 'gemini') {
    // Gemini: usageMetadata uses camelCase; some adapters expose snake_case.
    promptTokens = normalizeTokenCount(
      usage.promptTokenCount ?? usage.prompt_tokens ?? usage.input_tokens, 'prompt_tokens'
    );
    const candidates = usage.candidatesTokenCount ?? usage.completion_tokens;
    const thoughts = usage.thoughtsTokenCount ?? 0;
    completionTokens = normalizeTokenCount(
      candidates == null ? (usage.output_tokens ?? 0) : normalizeTokenCount(candidates, 'candidatesTokenCount') + normalizeTokenCount(thoughts, 'thoughtsTokenCount'),
      'completion_tokens'
    );
    cachedTokens = normalizeTokenCount(
      usage.cachedContentTokenCount ?? usage.cached_content_token_count ?? usage.cached_tokens, 'cached_tokens'
    );
    const details = Array.isArray(usage.promptTokensDetails) ? usage.promptTokensDetails : [];
    imageTokens = details
      .filter(detail => /image/i.test(String(detail?.modality || '')))
      .reduce((sum, detail) => sum + optionalTokenCount(detail?.tokenCount), 0);
    imageTokens = optionalTokenCount(usage.image_tokens ?? usage.imageTokens) || imageTokens;
  } else {
    // OpenAI: usage.prompt_tokens_details.cached_tokens
    promptTokens = normalizeTokenCount(usage.prompt_tokens ?? usage.input_tokens, 'prompt_tokens');
    completionTokens = normalizeTokenCount(usage.completion_tokens ?? usage.output_tokens, 'completion_tokens');
    cachedTokens = normalizeTokenCount(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens, 'cached_tokens');
    imageTokens = optionalTokenCount(
      usage.image_tokens
      ?? usage.imageTokens
      ?? usage.prompt_tokens_details?.image_tokens
      ?? usage.input_tokens_details?.image_tokens
    );
  }

  // Anthropic 通常不单列图片 token；部分代理会用 image_tokens 暴露。
  if (providerFormat === 'anthropic') {
    imageTokens = optionalTokenCount(usage.image_tokens ?? usage.imageTokens);
  }

  const totalTokens = normalizeTokenCount(promptTokens + completionTokens, 'totalTokens');

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheCreationTokens,
    imageTokens
  };
}

module.exports = { normalizeUsageTokens };
