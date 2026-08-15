/**
 * Anthropic Provider Adapter
 *
 * 支持 Anthropic Messages API 格式
 */
const BaseProviderAdapter = require('./base');

class AnthropicAdapter extends BaseProviderAdapter {
  getApiFormat() {
    return 'anthropic';
  }

  /**
   * 构建请求体
   * @param {object} params - 请求参数
   * @returns {object} Anthropic 格式的请求体
   */
  buildRequestBody(params) {
    const body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.max_tokens ?? 4096
    };

    // 系统提示
    if (params.system) {
      body.system = params.system;
    }

    // 可选参数
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.stop_sequences !== undefined) body.stop_sequences = params.stop_sequences;
    if (params.stream !== undefined) body.stream = params.stream;
    if (params.tools !== undefined) body.tools = params.tools;
    if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;

    // Anthropic 特有参数
    if (params.thinking !== undefined) body.thinking = params.thinking;
    if (params.metadata !== undefined) body.metadata = params.metadata;
    if (params.output_config !== undefined) body.output_config = params.output_config;
    if (params.service_tier !== undefined) body.service_tier = params.service_tier;
    if (params.cache_control !== undefined) body.cache_control = params.cache_control;
    if (params.container !== undefined) body.container = params.container;
    if (params.inference_geo !== undefined) body.inference_geo = params.inference_geo;

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
      promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0,
      totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      cachedTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0
    };
  }

  /**
   * 提取响应中的内容
   * @param {object} response - 响应对象
   * @returns {object} { content, reasoning, finish }
   */
  extractContent(response) {
    const content = response.content || [];
    let textContent = '';
    let reasoningContent = null;

    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'thinking') {
        reasoningContent = block.thinking;
      }
    }

    return {
      content: textContent,
      reasoning: reasoningContent,
      finish: response.stop_reason || null
    };
  }

  /**
   * 提取流式响应中的内容
   * @param {object} event - 流式事件
   * @returns {object} { content, reasoning, finish, type }
   */
  extractStreamContent(event) {
    const result = { content: '', reasoning: null, finish: null, type: event.type };

    switch (event.type) {
      case 'content_block_start':
        break;
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta') {
          result.content = event.delta.text || '';
        } else if (event.delta?.type === 'thinking_delta') {
          result.reasoning = event.delta.thinking || '';
        }
        break;
      case 'message_delta':
        result.finish = event.delta?.stop_reason || null;
        break;
    }

    return result;
  }
}

module.exports = AnthropicAdapter;
