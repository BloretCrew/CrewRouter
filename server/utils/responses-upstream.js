/**
 * Responses 上游转换
 *
 * 当供应商格式为 responses（原生只支持 OpenAI Responses API）时，
 * 将来自客户端的 OpenAI Chat Completions / Anthropic Messages 请求
 * 转换为 Responses 格式转发到上游 /v1/responses，并把上游的 Responses
 * 响应转换回客户端期望的格式。
 *
 * 本模块只包含纯转换函数，HTTP 请求与流式重发由调用方（routes/api.js）完成。
 */

const Logger = require('../logger');

/**
 * 将 Chat Completions 的 messages 数组转换为 Responses API 的 input。
 * 简单场景（无工具、无图片）返回字符串；复杂场景返回 item 数组。
 * @param {Array} messages - OpenAI chat messages
 * @returns {string|Array} Responses input
 */
/**
 * 检测 reasoning 占位符：部分上游（如 opencode Console Go 的 deepseek-v4-flash）
 * 在 reasoning 项的 encrypted_content 里放 "uuid-index" 占位符而非真实内容，
 * 不应作为 reasoning_content 输出给客户端。
 * @param {string} str
 * @returns {boolean}
 */
function isReasoningPlaceholder(str) {
  if (!str) return false;
  const s = String(str).trim();
  if (s.length > 64) return false; // 真实加密内容通常很长
  // UUID 或 UUID-索引 格式
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-\d+)?$/i.test(s)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.+$/.test(s)
    || /^(rs_)?[0-9a-f]{8,}(-|:)\d+$/.test(s);
}

/**
 * 将 assistant 消息的 reasoning_content 转换为 Responses reasoning input item。
 * 出站时上游 reasoning 的 encrypted_content/summary 被放入 reasoning_content，
 * 这里原样回传为 reasoning item，避免上游报 reasoning_text 必须回传。
 * @param {string} reasoningContent
 * @returns {object|null}
 */
function reasoningToResponsesItem(reasoningContent) {
  if (!reasoningContent) return null;
  const item = {
    type: 'reasoning',
    id: `rs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  };
  // 兼容两种来源：encrypted_content 密文，或 summary 明文文本
  item.encrypted_content = String(reasoningContent);
  return item;
}

function messagesToResponsesInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const items = [];
  // 已发射的 function_call 的 call_id 集合；用于配对 function_call_output，
  // 避免"孤儿输出"（无对应 function_call）导致上游报 No function call found
  const emittedCallIds = new Set();

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    const content = msg.content;

    // 工具调用结果
    if (role === 'tool') {
      const callId = String(msg.tool_call_id || '').trim();
      // 仅发射与已发射 function_call 配对的输出；孤儿输出跳过
      if (!callId || !emittedCallIds.has(callId)) continue;
      items.push({
        type: 'function_call_output',
        call_id: callId,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
      });
      continue;
    }

    // assistant 带 tool_calls
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // 先回传 reasoning（思考模型多轮要求）
      const reasoningItem = reasoningToResponsesItem(msg.reasoning_content);
      if (reasoningItem) items.push(reasoningItem);
      // 再输出纯文本内容（如有）
      if (content) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: contentToResponsesContent(content, 'assistant')
        });
      }
      for (const tc of msg.tool_calls) {
        // 无 name 的 tool_call 对上游无意义，跳过以免上游报 name 非空
        const fnName = String(tc?.function?.name || '').trim();
        if (!fnName) continue;
        const callId = tc.id || `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        emittedCallIds.add(callId);
        items.push({
          type: 'function_call',
          call_id: callId,
          name: fnName,
          arguments: tc.function?.arguments || '{}'
        });
      }
      continue;
    }

    // 普通 user / assistant / system / developer
    const respRole = role === 'system' ? 'developer' : (role === 'user' ? 'user' : 'assistant');
    if (respRole === 'assistant' && msg.reasoning_content) {
      // assistant 历史消息：reasoning + 消息分开输出
      const reasoningItem = reasoningToResponsesItem(msg.reasoning_content);
      if (reasoningItem) items.push(reasoningItem);
      items.push({
        type: 'message',
        role: 'assistant',
        content: contentToResponsesContent(content, 'assistant')
      });
    } else {
      items.push({
        type: 'message',
        role: respRole,
        content: contentToResponsesContent(content, respRole)
      });
    }
  }
  return items;
}

/**
 * 将 chat 的 content（字符串或内容块数组）转换为 Responses 内容块数组。
 * Responses 规范：user/developer 消息用 input_text，assistant 历史消息用 output_text。
 * @param {*} content
 * @param {string} [role='user'] - 'assistant' 用 output_text，其余用 input_text
 * @returns {Array}
 */
function contentToResponsesContent(content, role = 'user') {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') {
    if (content === '') return [];
    return [{ type: textType, text: content }];
  }
  if (Array.isArray(content)) {
    const blocks = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') {
        const t = c.text || '';
        if (t === '') continue;
        blocks.push({ type: textType, text: t });
      } else if (c.type === 'image_url' && c.image_url?.url) {
        blocks.push({ type: 'input_image', image_url: c.image_url.url });
      } else if (c.type === 'input_image' && c.image_url) {
        blocks.push({ type: 'input_image', image_url: c.image_url });
      }
    }
    return blocks;
  }
  return [];
}

/**
 * 将 Chat Completions 的 tools 转换为 Responses API 的 tools。
 * @param {Array} tools
 * @returns {Array|undefined}
 */
function chatToolsToResponsesTools(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function') {
      const name = String(t.function?.name || '').trim();
      // 过滤掉空 name 的工具，避免上游报 name 非空
      if (!name) continue;
      out.push({
        type: 'function',
        name,
        description: t.function?.description || '',
        parameters: t.function?.parameters || { type: 'object', properties: {} },
        strict: !!t.function?.strict
      });
    } else {
      // 非 function 工具：若显式带有空 name 字段则跳过，避免上游报 name 非空
      if (t.name !== undefined && String(t.name || '').trim() === '') continue;
      out.push(t);
    }
  }
  return out.length ? out : undefined;
}

/**
 * 从 Chat Completions 请求体构造 Responses 上游请求体。
 * @param {object} chatBody - 客户端的 chat 请求体（含 messages 等）
 * @param {string} model - 上游模型 id
 * @returns {object} Responses 请求体
 */
function chatToResponsesBody(chatBody, model) {
  const stream = !!chatBody.stream;
  const body = {
    model: model || chatBody.model,
    stream,
    input: messagesToResponsesInput(chatBody.messages)
  };

  if (chatBody.temperature !== undefined) body.temperature = chatBody.temperature;
  if (chatBody.top_p !== undefined) body.top_p = chatBody.top_p;
  if (chatBody.max_tokens !== undefined) body.max_output_tokens = chatBody.max_tokens;
  else if (chatBody.max_completion_tokens !== undefined) body.max_output_tokens = chatBody.max_completion_tokens;
  if (chatBody.stop !== undefined) {
    const stops = Array.isArray(chatBody.stop) ? chatBody.stop : [chatBody.stop];
    if (stops.length) body.stop = stops;
  }
  if (chatBody.seed !== undefined) body.seed = chatBody.seed;

  const tools = chatToolsToResponsesTools(chatBody.tools);
  if (tools) body.tools = tools;
  // 上游（如 opencode Console Go）仅支持 tool_choice: "auto"（默认值），
  // none/required/指定函数名均不被接受；不传 tool_choice 即使用默认 auto，故省略。

  if (chatBody.response_format) {
    const rf = chatBody.response_format;
    if (rf.type === 'json_object') body.text = { format: { type: 'json_object' } };
    else if (rf.type === 'json_schema' && rf.json_schema) {
      body.text = { format: { type: 'json_schema', name: rf.json_schema.name || 'schema', schema: rf.json_schema.schema || {}, strict: !!rf.json_schema.strict } };
    }
  }

  if (chatBody.reasoning_effort !== undefined) body.reasoning = { effort: chatBody.reasoning_effort };
  return body;
}

/**
 * 从 Responses 响应中提取纯文本（拼接 output_text）。
 * @param {object} data - Responses 响应体
 * @returns {string}
 */
function extractResponsesText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (!Array.isArray(data?.output)) return '';
  let text = '';
  for (const item of data.output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text') text += c.text || '';
      }
    } else if (item?.type === 'output_text') {
      text += item.text || '';
    }
  }
  return text;
}

/**
 * 将 Responses 响应转换为 OpenAI Chat Completions 响应。
 * @param {object} data - 上游 Responses 响应体
 * @param {object} opts - { model?, id?, created? }
 * @returns {object} chat.completion
 */
function responsesToChatCompletion(data, opts = {}) {
  const text = extractResponsesText(data);
  const usage = data?.usage || {};
  const toolCalls = (Array.isArray(data?.output) ? data.output : [])
    .filter((i) => i?.type === 'function_call' && i?.name)
    .map((fc) => ({
      id: fc.call_id || fc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: {
        name: fc.name,
        arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments ?? {})
      }
    }));

  // 保留 reasoning：stateless 模式为 encrypted_content，否则取 summary 文本；
  // 放入 assistant 消息的 reasoning_content，供客户端多轮时原样回传。
  // 注意：部分上游的 encrypted_content 是 "uuid-index" 占位符（非真实内容），需跳过。
  let reasoningContent = null;
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item?.type === 'reasoning') {
        if (item.encrypted_content && !isReasoningPlaceholder(item.encrypted_content)) {
          reasoningContent = item.encrypted_content;
        } else if (Array.isArray(item.summary) && item.summary.length > 0) {
          reasoningContent = item.summary.map((s) => s?.text || s?.summary_text || '').join('\n');
        } else if (item.content && Array.isArray(item.content) && item.content.length) {
          reasoningContent = item.content.map((c) => c?.text || c?.thinking || '').join('');
        }
        if (reasoningContent) break;
      }
    }
  }

  const message = { role: 'assistant', content: toolCalls.length ? null : (text || null) };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoningContent) message.reasoning_content = reasoningContent;

  const completion = {
    id: opts.id || `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: opts.created != null ? opts.created : Math.floor(Date.now() / 1000),
    model: opts.model || data.model || 'unknown',
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : (data.status === 'completed' ? 'stop' : data.status) }]
  };

  if (usage && (usage.input_tokens != null || usage.output_tokens != null || usage.total_tokens != null)) {
    completion.usage = {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: usage.total_tokens != null ? usage.total_tokens : ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
      prompt_tokens_details: { cached_tokens: usage.cached_tokens || 0 }
    };
  }
  return completion;
}

/**
 * 将 Responses API 的 SSE 事件流重发为 OpenAI Chat Completions 的 chunk SSE。
 * @param {object} upstreamStream - 上游响应体（web stream）
 * @param {object} res - Express 响应
 * @param {object} opts - { model?, id?, created?, logPrefix? }
 * @returns {Promise<{ content: string, usage: object|null }>}
 */
async function streamResponsesAsChatCompletion(upstreamStream, res, opts = {}) {
  const id = opts.id || `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = opts.created != null ? opts.created : Math.floor(Date.now() / 1000);
  const model = opts.model || 'unknown';
  const logPrefix = opts.logPrefix || 'ResponsesUpstream';

  const reader = upstreamStream.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let content = '';
  let reasoning = '';
  // 正在组装的 function_call（流式按 name + arguments.delta 增量）
  let currentToolCallId = null;
  let currentToolName = null;
  let currentToolArguments = '';
  let openedTools = new Map(); // id -> { index }
  let streamUsage = null;
  let sawContentDelta = false;
  let sawReasoningDelta = false;
  let sawToolCall = false;
  let activeItemId = null;

  const sendChunk = (delta, extra = {}) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta,
        finish_reason: null
      }]
    };
    if (Object.keys(extra).length) Object.assign(chunk, extra);
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  // 处理单个解析后的 SSE data 对象
  const handleEvent = (obj) => {
    if (!obj || typeof obj !== 'object' || obj.type === 'response.output_text.done') return;
    switch (obj.type) {
      case 'response.output_text.delta': {
        const original = obj.delta || '';
        const d = opts.scrubber ? opts.scrubber.feed(original) : original;
        if (d) { content += d; sawContentDelta = true; sawReasoningDelta = false; }
        if (d) sendChunk({ content: d });
        break;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const d = obj.delta || '';
        if (d) { reasoning += d; sawReasoningDelta = true; }
        sendChunk({ reasoning_content: d || '' });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const d = obj.delta || '';
        currentToolArguments += d;
        const callId = currentToolCallId || obj.call_id || `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        if (!currentToolCallId) {
          currentToolCallId = callId;
          if (!openedTools.has(callId)) {
            const index = openedTools.size;
            openedTools.set(callId, index);
            sendChunk({
              tool_calls: [{
                index,
                id: obj.call_id || callId,
                type: 'function',
                function: { name: currentToolName || '', arguments: '' }
              }]
            });
          }
        }
        if (openedTools.has(callId)) {
          sendChunk({
            tool_calls: [{
              index: openedTools.get(callId),
              function: { arguments: d }
            }]
          });
        }
        break;
      }
      case 'response.output_item.added': {
        const item = obj.item;
        if (!item) break;
        if (item.type === 'function_call') {
          // 立即发出初始 tool_calls chunk，避免无参调用（不发 arguments delta）时漏发
          sawToolCall = true;
          currentToolName = item.name || currentToolName;
          activeItemId = item.id || null;
          const callId = item.call_id || item.id || currentToolCallId || `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          currentToolCallId = callId;
          if (!openedTools.has(callId)) {
            const index = openedTools.size;
            openedTools.set(callId, index);
            sendChunk({
              tool_calls: [{
                index,
                id: item.call_id || item.id || callId,
                type: 'function',
                function: { name: item.name || currentToolName || '', arguments: '' }
              }]
            });
          }
          if (item.arguments) {
            const argsStr = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? '');
            currentToolArguments = argsStr;
            sendChunk({
              tool_calls: [{
                index: openedTools.get(callId),
                function: { arguments: argsStr }
              }]
            });
          }
        } else if (item.type === 'reasoning') {
          // reasoning 项出现：真正的思考文本由 response.reasoning_text.delta 事件流式发出，
          // 此处不发送 encrypted_content（部分上游为 uuid 占位符，非真实内容）。
          sawReasoningDelta = true;
        }
        break;
      }
      case 'response.output_item.done': {
        // function_call 结束或 message 结束
        if (obj.item?.type === 'function_call') {
          const fc = obj.item;
          const callId = fc.call_id || currentToolCallId || `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          currentToolCallId = null;
          currentToolName = null;
          currentToolArguments = '';
          activeItemId = null;
        } else if (obj.item?.type === 'message') {
          activeItemId = null;
        }
        break;
      }
      case 'response.completed':
        if (obj.response?.error) {
          Logger.warn(`[${logPrefix}] 上游响应含 error: ${JSON.stringify(obj.response.error)}`);
        }
        streamUsage = obj.response?.usage || obj.response?.usage || null;
        break;
      default:
        break;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          handleEvent(JSON.parse(payload));
        } catch { /* ignore parse errors */ }
      }
    }
  } catch (err) {
    Logger.warn(`[${logPrefix}] 上游流读取异常: ${err.message}`);
    if (!res.writableEnded) res.end();
    return {
      content: sawContentDelta ? content : (sawReasoningDelta ? '' : content),
      reasoning,
      usage: streamUsage
    };
  }

  const residual = opts.scrubber ? opts.scrubber.flush() : '';
  if (residual) {
    content += residual;
    sendChunk({ content: residual });
  }

  // 流结束：发送带 finish_reason 的收尾 chunk + usage（须在 res.end() 之前）
  const finishChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : 'stop' }]
  };
  if (streamUsage && (streamUsage.input_tokens != null || streamUsage.output_tokens != null || streamUsage.total_tokens != null)) {
    finishChunk.usage = {
      prompt_tokens: streamUsage.input_tokens || 0,
      completion_tokens: streamUsage.output_tokens || 0,
      total_tokens: streamUsage.total_tokens != null ? streamUsage.total_tokens : ((streamUsage.input_tokens || 0) + (streamUsage.output_tokens || 0)),
      prompt_tokens_details: { cached_tokens: streamUsage.cached_tokens || 0 }
    };
  }
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  return {
    content: sawContentDelta ? content : (sawReasoningDelta ? '' : content),
    reasoning,
    usage: streamUsage
  };
}

module.exports = {
  messagesToResponsesInput,
  contentToResponsesContent,
  chatToolsToResponsesTools,
  chatToResponsesBody,
  extractResponsesText,
  responsesToChatCompletion,
  streamResponsesAsChatCompletion,
  reasoningToResponsesItem,
  isReasoningPlaceholder
};
