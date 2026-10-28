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
      cacheCreationTokens: 0
    };
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cacheCreationTokens = 0;

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
    // Gemini: usage_metadata.cached_content_token_count
    promptTokens = normalizeTokenCount(usage.prompt_tokens ?? usage.input_tokens, 'prompt_tokens');
    completionTokens = normalizeTokenCount(usage.completion_tokens ?? usage.output_tokens, 'completion_tokens');
    cachedTokens = normalizeTokenCount(usage.cached_content_token_count ?? usage.cached_tokens, 'cached_tokens');
  } else {
    // OpenAI: usage.prompt_tokens_details.cached_tokens
    promptTokens = normalizeTokenCount(usage.prompt_tokens ?? usage.input_tokens, 'prompt_tokens');
    completionTokens = normalizeTokenCount(usage.completion_tokens ?? usage.output_tokens, 'completion_tokens');
    cachedTokens = normalizeTokenCount(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens, 'cached_tokens');
  }

  const totalTokens = normalizeTokenCount(promptTokens + completionTokens, 'totalTokens');

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheCreationTokens
  };
}

module.exports = { normalizeUsageTokens };
