'use strict';

const BaseProviderAdapter = require('./base');

/** Google Gemini generateContent provider adapter. */
class GeminiAdapter extends BaseProviderAdapter {
  getApiFormat() {
    return 'gemini';
  }

  buildRequestBody(params) {
    // The canonical protocol codec performs the actual OpenAI/Anthropic ->
    // Gemini conversion. This legacy adapter surface passes params through.
    return params && typeof params === 'object' ? params : {};
  }

  parseUsage(response) {
    const usage = response?.usageMetadata || {};
    const candidates = Number(usage.candidatesTokenCount || 0);
    const thoughts = Number(usage.thoughtsTokenCount || 0);
    return {
      promptTokens: Number(usage.promptTokenCount || 0),
      completionTokens: candidates + thoughts,
      totalTokens: Number(usage.totalTokenCount || 0),
      cachedTokens: Number(usage.cachedContentTokenCount || 0),
      reasoningTokens: thoughts
    };
  }

  parseStreamUsage(chunk) {
    return chunk?.usageMetadata ? this.parseUsage(chunk) : null;
  }

  extractStreamContent(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts || [];
    let content = '';
    let reasoning = null;
    for (const part of parts) {
      if (part.thought && part.text) reasoning = (reasoning || '') + part.text;
      else if (part.text) content += part.text;
    }
    return {
      content,
      reasoning,
      finish: chunk?.candidates?.[0]?.finishReason || null
    };
  }
}

module.exports = GeminiAdapter;
