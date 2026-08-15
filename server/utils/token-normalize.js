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
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const uncachedInput = usage.input_tokens || 0;

    promptTokens = cacheRead + cacheCreation + uncachedInput;
    completionTokens = usage.output_tokens || 0;
    cachedTokens = cacheRead;
    cacheCreationTokens = cacheCreation;
  } else if (providerFormat === 'gemini') {
    // Gemini: usage_metadata.cached_content_token_count
    promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
    completionTokens = usage.completion_tokens || usage.output_tokens || 0;
    cachedTokens = usage.cached_content_token_count || usage.cached_tokens || 0;
  } else {
    // OpenAI: usage.prompt_tokens_details.cached_tokens
    promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
    completionTokens = usage.completion_tokens || usage.output_tokens || 0;
    cachedTokens = usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0;
  }

  const totalTokens = promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheCreationTokens
  };
}

module.exports = { normalizeUsageTokens };
