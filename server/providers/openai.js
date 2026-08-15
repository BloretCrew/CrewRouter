/**
 * OpenAI Provider Adapter
 *
 * 支持 OpenAI Chat Completions API 格式
 */
const BaseProviderAdapter = require('./base');

class OpenAIAdapter extends BaseProviderAdapter {
  getApiFormat() {
    return 'openai';
  }

  /**
   * 构建请求体
   * @param {object} params - 请求参数
   * @returns {object} OpenAI 格式的请求体
   */
  buildRequestBody(params) {
    const body = {
      model: params.model,
      messages: params.messages,
      stream: !!params.stream
    };

    // 可选参数
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.frequency_penalty !== undefined) body.frequency_penalty = params.frequency_penalty;
    if (params.presence_penalty !== undefined) body.presence_penalty = params.presence_penalty;
    if (params.stop !== undefined) body.stop = params.stop;
    if (params.tools !== undefined) body.tools = params.tools;
    if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;
    if (params.response_format !== undefined) body.response_format = params.response_format;
    if (params.n !== undefined) body.n = params.n;

    // 流式选项
    if (params.stream) {
      body.stream_options = { include_usage: true };
    }

    return body;
  }

  /**
   * 解析响应中的 usage 信息
   * @param {object} response - 响应对象
   * @returns {object} 标准化的 usage 信息
   */
  parseUsage(response) {
    const usage = response.usage || {};
    return {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      cachedTokens: usage.cached_tokens || 0
    };
  }

  /**
   * 解析流式响应中的 usage 信息
   * @param {object} chunk - 流式响应块
   * @returns {object|null} usage 信息或 null
   */
  parseStreamUsage(chunk) {
    if (chunk.usage) {
      return this.parseUsage(chunk);
    }
    return null;
  }

  /**
   * 提取流式响应中的内容
   * @param {object} chunk - 流式响应块
   * @returns {object} { content, reasoning, finish }
   */
  extractStreamContent(chunk) {
    const delta = chunk.choices?.[0]?.delta || {};
    return {
      content: delta.content || '',
      reasoning: delta.reasoning_content || null,
      finish: chunk.choices?.[0]?.finish_reason || null
    };
  }
}

module.exports = OpenAIAdapter;
