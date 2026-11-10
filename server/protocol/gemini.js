'use strict';

const { omitKnown, withPassthrough, safeParseJson } = require('./helpers');
const {
  mediaTypeFromMime,
  fromGeminiSchema,
  geminiFunctionParameters,
  fromGeminiFunctionParameters,
  geminiResponseSchema,
  fromGeminiResponseSchema
} = require('./gemini-schema');

const REQUEST_KEYS = new Set([
  'contents', 'systemInstruction', 'generationConfig', 'tools', 'toolConfig', 'model', 'stream'
]);
const RESPONSE_KEYS = new Set([
  'candidates', 'promptFeedback', 'usageMetadata', 'modelVersion',
  'responseId', 'modelStatus'
]);
const EVENT_KEYS = new Set([
  'candidates', 'promptFeedback', 'usageMetadata', 'modelVersion',
  'responseId', 'modelStatus'
]);

const FINISH_TO_IR = Object.freeze({
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  LANGUAGE: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  IMAGE_SAFETY: 'content_filter',
  IMAGE_PROHIBITED_CONTENT: 'content_filter',
  IMAGE_RECITATION: 'content_filter',
  IMAGE_OTHER: 'content_filter',
  MALFORMED_FUNCTION_CALL: 'error',
  UNEXPECTED_TOOL_CALL: 'error',
  TOO_MANY_TOOL_CALLS: 'error',
  MISSING_THOUGHT_SIGNATURE: 'error',
  MALFORMED_RESPONSE: 'error',
  ESCALATION: 'content_filter',
  PUP_LIMITED_DISABLED: 'content_filter',
  CONTINUATION: 'length',
  FINISH_REASON_UNSPECIFIED: 'stop',
  OTHER: 'stop'
});

const IR_TO_FINISH = Object.freeze({
  stop: 'STOP',
  end_turn: 'STOP',
  stop_sequence: 'STOP',
  tool_calls: 'STOP',
  tool_use: 'STOP',
  function_call: 'STOP',
  length: 'MAX_TOKENS',
  max_tokens: 'MAX_TOKENS',
  content_filter: 'SAFETY',
  refusal: 'SAFETY',
  error: 'OTHER'
});

const RESPONSE_MODALITIES = new Set(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT']);

function normalizeFunctionResponse(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return { result: value };
}

function normalizeGeminiFinishReason(reason, hasTools) {
  if (hasTools) return 'tool_calls';
  return FINISH_TO_IR[String(reason || '')] || 'stop';
}

function geminiFinishReason(finishReason, hasTools) {
  if (hasTools) return 'STOP';
  return IR_TO_FINISH[String(finishReason || '')] || 'STOP';
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isGemini3Plus(model) {
  const match = /gemini-(\d+)/i.exec(String(model || ''));
  return !!match && Number(match[1]) >= 3;
}

function thinkingBudgetFor(effort) {
  return { minimal: 0, low: 1024, medium: 4096, high: 8192 }[String(effort || '').toLowerCase()] ?? 4096;
}

function levelFromThinking(thinking) {
  if (!thinking) return undefined;
  if (thinking.type && thinking.type !== 'enabled') return undefined;
  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget)) return undefined;
  if (budget <= 0) return 'minimal';
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

function thinkingConfigFor(parameters, model) {
  const p = parameters || {};
  if (p.thinkingConfig && typeof p.thinkingConfig === 'object') return p.thinkingConfig;
  const thinking = p.thinking && typeof p.thinking === 'object' ? p.thinking : null;
  if (thinking?.budget_tokens !== undefined) {
    return { thinkingBudget: Number(thinking.budget_tokens) || 0, includeThoughts: thinking.type !== 'disabled' };
  }
  if (thinking?.type === 'disabled') return { thinkingBudget: 0 };
  const effort = p.reasoningEffort || levelFromThinking(thinking);
  if (!effort) return null;
  const level = String(effort).toUpperCase();
  if (!['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level)) return null;
  if (isGemini3Plus(model)) return { thinkingLevel: level, includeThoughts: true };
  return { thinkingBudget: thinkingBudgetFor(effort), includeThoughts: true };
}

function decodeParts(parts) {
  return (Array.isArray(parts) ? parts : []).map(part => {
    if (!part || typeof part !== 'object') return { type: 'raw', value: part };
    const passthrough = { gemini: omitKnown(part, new Set([
      'text', 'thought', 'thoughtSignature', 'inlineData', 'fileData',
      'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult',
      'toolCall', 'toolResponse', 'videoMetadata', 'mediaResolution'
    ])) };

    if (part.text !== undefined) {
      if (part.thought === true) {
        return {
          type: 'thinking',
          thinking: part.text || '',
          signature: part.thoughtSignature,
          passthrough
        };
      }
      return {
        type: 'text',
        text: part.text || '',
        signature: part.thoughtSignature,
        passthrough
      };
    }
    if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || 'application/octet-stream';
      return {
        type: 'media',
        mediaType: mediaTypeFromMime(mimeType),
        mimeType,
        data: part.inlineData.data || '',
        displayName: part.inlineData.displayName,
        passthrough
      };
    }
    if (part.fileData) {
      const mimeType = part.fileData.mimeType || 'application/octet-stream';
      return {
        type: 'media',
        mediaType: mediaTypeFromMime(mimeType),
        mimeType,
        fileUri: part.fileData.fileUri,
        displayName: part.fileData.displayName,
        passthrough
      };
    }
    if (part.functionCall) {
      return {
        type: 'tool_call',
        id: part.functionCall.id || part.functionCall.name,
        name: part.functionCall.name || '',
        input: typeof part.functionCall.args === 'string'
          ? safeParseJson(part.functionCall.args, {})
          : (part.functionCall.args || {}),
        signature: part.thoughtSignature,
        passthrough
      };
    }
    if (part.functionResponse) {
      const response = normalizeFunctionResponse(part.functionResponse.response);
      return {
        type: 'tool_result',
        toolCallId: part.functionResponse.id || part.functionResponse.name,
        name: part.functionResponse.name,
        result: response,
        content: [{ type: 'text', text: typeof response === 'string' ? response : JSON.stringify(response) }],
        isError: !!(response && typeof response === 'object' && response.error),
        passthrough
      };
    }
    return { type: 'raw', value: part, passthrough };
  });
}

function encodeParts(blocks, toolNames) {
  const parts = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    const extra = block.passthrough?.gemini || {};
    if (block.type === 'text') {
      const value = { text: block.text || '' };
      if (block.signature) value.thoughtSignature = block.signature;
      parts.push(withPassthrough(value, extra));
    } else if (block.type === 'thinking') {
      const value = { text: block.thinking || '', thought: true };
      if (block.signature) value.thoughtSignature = block.signature;
      parts.push(withPassthrough(value, extra));
    } else if (block.type === 'media' || block.type === 'image') {
      const media = block.type === 'image'
        ? mediaFromImageSource(block.source)
        : block;
      if (!media) continue;
      const mediaUri = media.fileUri || media.uri;
      if (mediaUri) {
        parts.push(withPassthrough({
          fileData: {
            mimeType: media.mimeType || 'application/octet-stream',
            fileUri: mediaUri,
            ...(media.displayName ? { displayName: media.displayName } : {})
          }
        }, extra));
      } else {
        parts.push(withPassthrough({
          inlineData: {
            mimeType: media.mimeType || 'application/octet-stream',
            data: media.data || '',
            ...(media.displayName ? { displayName: media.displayName } : {})
          }
        }, extra));
      }
    } else if (block.type === 'tool_call') {
      const functionCall = {
        name: block.name || '',
        args: block.input && typeof block.input === 'object' ? block.input : safeParseJson(block.argumentsText, {})
      };
      if (block.id && block.id !== block.name) functionCall.id = block.id;
      const value = { functionCall };
      if (block.signature) value.thoughtSignature = block.signature;
      parts.push(withPassthrough(value, extra));
    } else if (block.type === 'tool_result') {
      const name = block.name || toolNames?.get(block.toolCallId) || block.toolCallId || '';
      const functionResponse = {
        name,
        response: normalizeFunctionResponse(
          block.result !== undefined ? block.result : blocksToText(block.content)
        )
      };
      if (block.toolCallId && block.toolCallId !== name) functionResponse.id = block.toolCallId;
      if (block.isError && !functionResponse.response.error) {
        functionResponse.response = { error: functionResponse.response };
      }
      parts.push(withPassthrough({ functionResponse }, extra));
    } else if (block.type === 'raw') {
      parts.push(block.value);
    }
  }
  return parts;
}

function mediaFromImageSource(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.inlineData) {
    return {
      type: 'media',
      mediaType: 'image',
      mimeType: source.inlineData.mimeType || 'image/png',
      data: source.inlineData.data || ''
    };
  }
  if (source.fileData) {
    return {
      type: 'media',
      mediaType: 'image',
      mimeType: source.fileData.mimeType,
      fileUri: source.fileData.fileUri
    };
  }
  if (source.url || typeof source === 'string') {
    return { type: 'media', mediaType: 'image', mimeType: 'image/png', uri: source.url || source };
  }
  if (source.type === 'base64') {
    return { type: 'media', mediaType: 'image', mimeType: source.media_type || 'image/png', data: source.data || '' };
  }
  if (source.data) {
    return { type: 'media', mediaType: 'image', mimeType: source.media_type || source.mimeType || 'image/png', data: source.data };
  }
  return null;
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return blocks === undefined ? '' : String(blocks);
  return blocks.map(block => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text') return block.text || '';
    return '';
  }).join('');
}

function decodeContent(content) {
  return {
    role: content.role === 'model' ? 'assistant' : (content.role || 'user'),
    blocks: decodeParts(content.parts),
    passthrough: { gemini: omitKnown(content, new Set(['role', 'parts'])) }
  };
}

function encodeContent(message, toolNames) {
  const blocks = message.blocks || [];
  const role = message.role === 'assistant' ? 'model'
    : (message.role === 'tool' ? 'user' : (message.role || 'user'));
  return withPassthrough({ role, parts: encodeParts(blocks, toolNames) }, message.passthrough?.gemini);
}

function decodeToolChoice(toolConfig) {
  const config = toolConfig?.functionCallingConfig;
  if (!config) return undefined;
  const mode = String(config.mode || '').toUpperCase();
  const allowed = Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames : [];
  if (mode === 'NONE') return 'none';
  if (mode === 'AUTO' || mode === 'MODE_UNSPECIFIED') return 'auto';
  if (allowed.length === 1) return { type: 'function', function: { name: allowed[0] } };
  if (mode === 'ANY' || mode === 'VALIDATED') return 'required';
  return 'auto';
}

function encodeToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (toolChoice === 'auto') return { mode: 'AUTO' };
  if (toolChoice === 'none') return { mode: 'NONE' };
  if (toolChoice === 'required') return { mode: 'ANY' };
  if (toolChoice?.type === 'function') {
    const name = toolChoice.function?.name || toolChoice.name;
    return { mode: 'ANY', allowedFunctionNames: name ? [name] : [] };
  }
  if (toolChoice?.type === 'tool' && toolChoice.name) {
    return { mode: 'ANY', allowedFunctionNames: [toolChoice.name] };
  }
  return null;
}

function decodeTools(tools) {
  const result = [];
  const serverTools = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    for (const declaration of Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : []) {
      result.push({
        name: declaration.name,
        description: declaration.description,
        inputSchema: fromGeminiFunctionParameters(declaration),
        passthrough: {
          gemini: omitKnown(declaration, new Set([
            'name', 'description', 'parameters', 'parametersJsonSchema', 'response', 'responseJsonSchema'
          ]))
        }
      });
    }
    const extras = omitKnown(tool, new Set(['functionDeclarations']));
    if (Object.keys(extras).length) serverTools.push({ raw: tool, passthrough: { gemini: extras } });
  }
  return { tools: result, serverTools };
}

function decodeUsage(usage) {
  if (!usage) return undefined;
  const prompt = numeric(usage.promptTokenCount);
  const candidates = numeric(usage.candidatesTokenCount);
  const thoughts = numeric(usage.thoughtsTokenCount);
  const toolUse = numeric(usage.toolUsePromptTokenCount);
  return {
    inputTokens: prompt,
    outputTokens: candidates + thoughts,
    candidatesTokens: candidates,
    totalTokens: usage.totalTokenCount !== undefined ? numeric(usage.totalTokenCount) : prompt + candidates + thoughts + toolUse,
    cachedInputTokens: numeric(usage.cachedContentTokenCount),
    reasoningTokens: thoughts,
    toolUseInputTokens: toolUse,
    passthrough: { gemini: omitKnown(usage, new Set([
      'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
      'cachedContentTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount'
    ])) }
  };
}

function encodeUsage(usage) {
  if (!usage) return undefined;
  const reasoning = numeric(usage.reasoningTokens);
  const candidates = usage.candidatesTokens !== undefined
    ? numeric(usage.candidatesTokens)
    : Math.max(0, numeric(usage.outputTokens) - reasoning);
  const result = {
    promptTokenCount: numeric(usage.inputTokens),
    candidatesTokenCount: candidates,
    totalTokenCount: usage.totalTokens !== undefined
      ? numeric(usage.totalTokens)
      : numeric(usage.inputTokens) + candidates + reasoning
  };
  if (usage.cachedInputTokens) result.cachedContentTokenCount = numeric(usage.cachedInputTokens);
  if (reasoning) result.thoughtsTokenCount = reasoning;
  if (usage.toolUseInputTokens) result.toolUsePromptTokenCount = numeric(usage.toolUseInputTokens);
  return withPassthrough(result, usage.passthrough?.gemini);
}

function geminiServerTool(tool) {
  const value = tool?.raw || tool;
  if (!value || typeof value !== 'object') return null;
  switch (value.type) {
    case 'code_execution': return { codeExecution: {} };
    case 'google_search': return { googleSearch: value.search_types ? { searchTypes: value.search_types } : {} };
    case 'google_maps': return { googleMaps: {} };
    case 'url_context': return { urlContext: {} };
    case 'computer_use': return { computerUse: {} };
    case 'file_search': return {
      fileSearch: {
        ...(Array.isArray(value.file_search_store_names) ? { fileSearchStoreNames: value.file_search_store_names } : {}),
        ...(value.top_k !== undefined ? { topK: value.top_k } : {})
      }
    };
    case 'mcp_server': return {
      mcpServers: [{
        ...(value.name ? { name: value.name } : {}),
        ...(value.url ? { uri: value.url } : {}),
        ...(value.headers ? { headers: value.headers } : {})
      }]
    };
    default:
      return value;
  }
}

function decodeRequest(body) {
  const request = body && typeof body === 'object' ? body : {};
  const generationConfig = request.generationConfig || {};
  const { tools, serverTools } = decodeTools(request.tools);
  const messages = [];

  if (request.systemInstruction) {
    const systemContent = typeof request.systemInstruction === 'string'
      ? { parts: [{ text: request.systemInstruction }] }
      : request.systemInstruction;
    messages.push({
      role: 'system',
      blocks: decodeParts(systemContent.parts),
      passthrough: { gemini: omitKnown(systemContent, new Set(['role', 'parts'])) }
    });
  }
  for (const content of Array.isArray(request.contents) ? request.contents : []) {
    if (content && typeof content === 'object') messages.push(decodeContent(content));
  }

  const thinking = generationConfig.thinkingConfig;
  const parameters = {
    maxTokens: generationConfig.maxOutputTokens,
    maxTokensField: 'maxOutputTokens',
    temperature: generationConfig.temperature,
    topP: generationConfig.topP,
    topK: generationConfig.topK,
    stop: generationConfig.stopSequences,
    stream: request.stream,
    n: generationConfig.candidateCount,
    seed: generationConfig.seed,
    presencePenalty: generationConfig.presencePenalty,
    frequencyPenalty: generationConfig.frequencyPenalty,
    responseMimeType: generationConfig.responseMimeType,
    responseSchema: fromGeminiResponseSchema(request),
    reasoningEffort: thinking ? (thinking.thinkingLevel
      ? String(thinking.thinkingLevel).toLowerCase()
      : (() => {
        const budget = Number(thinking.thinkingBudget);
        if (!Number.isFinite(budget)) return undefined;
        if (budget <= 0) return 'minimal';
        if (budget <= 2048) return 'low';
        if (budget <= 8192) return 'medium';
        return 'high';
      })()) : undefined,
    thinkingConfig: thinking,
    thinking: thinking && thinking.thinkingBudget !== undefined
      ? { type: 'enabled', budget_tokens: thinking.thinkingBudget, level: thinking.thinkingLevel, includeThoughts: thinking.includeThoughts }
      : undefined
  };
  if (parameters.stream === undefined && request.stream !== undefined) parameters.stream = request.stream;

  const mappedGenerationKeys = new Set([
    'maxOutputTokens', 'temperature', 'topP', 'topK', 'stopSequences',
    'candidateCount', 'seed', 'presencePenalty', 'frequencyPenalty',
    'responseMimeType', 'responseSchema', 'responseJsonSchema', 'thinkingConfig'
  ]);
  const passthrough = omitKnown(request, REQUEST_KEYS);
  const generationExtras = omitKnown(generationConfig, mappedGenerationKeys);
  if (Object.keys(generationExtras).length) passthrough.generationConfigExtras = generationExtras;
  const toolConfigExtras = omitKnown(request.toolConfig, new Set(['functionCallingConfig']));
  if (Object.keys(toolConfigExtras).length) passthrough.toolConfigExtras = toolConfigExtras;
  if (serverTools.length) passthrough.serverTools = serverTools;
  if (request.systemInstruction && typeof request.systemInstruction === 'object' && request.systemInstruction.role) {
    passthrough.systemInstructionRole = request.systemInstruction.role;
  }

  return {
    kind: 'request',
    sourceDialect: 'gemini',
    model: request.model,
    messages,
    tools,
    toolChoice: decodeToolChoice(request.toolConfig),
    parameters,
    passthrough: { gemini: passthrough }
  };
}

function encodeRequest(ir) {
  const request = { contents: [] };
  const messages = ir.messages || [];
  const toolNames = new Map();
  for (const message of messages) {
    for (const block of message.blocks || []) {
      if (block?.type === 'tool_call' && block.id && block.name) toolNames.set(block.id, block.name);
    }
  }
  const systemBlocks = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      systemBlocks.push(...(message.blocks || []));
      continue;
    }
    request.contents.push(encodeContent(message, toolNames));
  }
  if (systemBlocks.length) {
    request.systemInstruction = { parts: encodeParts(systemBlocks) };
    const role = ir.passthrough?.gemini?.systemInstructionRole;
    if (role) request.systemInstruction.role = role;
  }

  const p = ir.parameters || {};
  const generationConfig = {};
  const extras = ir.passthrough?.gemini?.generationConfigExtras;
  if (extras && typeof extras === 'object') Object.assign(generationConfig, extras);
  if (p.maxTokens !== undefined) generationConfig.maxOutputTokens = p.maxTokens;
  if (p.temperature !== undefined) generationConfig.temperature = p.temperature;
  if (p.topP !== undefined) generationConfig.topP = p.topP;
  if (p.topK !== undefined) generationConfig.topK = p.topK;
  if (p.stop !== undefined) {
    const stop = Array.isArray(p.stop) ? p.stop : [p.stop];
    generationConfig.stopSequences = stop.filter(value => typeof value === 'string').slice(0, 5);
  }
  if (p.n !== undefined) generationConfig.candidateCount = p.n;
  if (p.seed !== undefined) generationConfig.seed = p.seed;
  if (p.presencePenalty !== undefined) generationConfig.presencePenalty = p.presencePenalty;
  if (p.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = p.frequencyPenalty;

  const responseSchema = p.responseSchema
    || (p.responseFormat?.json_schema?.schema)
    || (p.responseFormat?.schema);
  if (responseSchema) {
    generationConfig.responseMimeType = p.responseMimeType || 'application/json';
    Object.assign(generationConfig, geminiResponseSchema(responseSchema));
  } else if (p.responseMimeType) {
    generationConfig.responseMimeType = p.responseMimeType;
    if (p.responseMimeType === 'application/json') generationConfig.responseMimeType = 'application/json';
  } else if (p.responseFormat?.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  }

  const thinkingConfig = thinkingConfigFor(p, ir.model);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  if (ir.tools?.length) {
    request.tools = [{
      functionDeclarations: ir.tools.map(tool => {
        const declaration = {
          name: tool.name,
          description: tool.description,
          ...geminiFunctionParameters(tool.inputSchema || {})
        };
        return withPassthrough(declaration, tool.passthrough?.gemini);
      })
    }];
  }
  const serverTools = ir.passthrough?.gemini?.serverTools;
  if (Array.isArray(serverTools) && serverTools.length) {
    request.tools = request.tools || [];
    for (const tool of serverTools) {
      const normalized = geminiServerTool(tool);
      if (normalized) request.tools.push(withPassthrough(normalized, tool.passthrough?.gemini));
    }
  }

  const functionCallingConfig = encodeToolChoice(ir.toolChoice);
  const toolConfigExtras = ir.passthrough?.gemini?.toolConfigExtras;
  if (functionCallingConfig || toolConfigExtras) {
    request.toolConfig = { ...(toolConfigExtras || {}) };
    if (functionCallingConfig) request.toolConfig.functionCallingConfig = functionCallingConfig;
  }

  const topLevel = ir.passthrough?.gemini ? { ...ir.passthrough.gemini } : {};
  for (const key of [
    'generationConfigExtras', 'toolConfigExtras', 'serverTools',
    'systemInstructionRole', 'candidate'
  ]) delete topLevel[key];
  return withPassthrough(request, topLevel);
}

function decodeResponse(body) {
  const response = body && typeof body === 'object' ? body : {};
  const candidate = Array.isArray(response.candidates) ? response.candidates[0] : null;
  const content = candidate?.content ? decodeContent(candidate.content) : null;
  const blocks = content?.blocks || [];
  const hasTools = blocks.some(block => block.type === 'tool_call');
  const blockReason = response.promptFeedback?.blockReason;
  const finishReason = hasTools
    ? 'tool_calls'
    : (candidate?.finishReason
      ? normalizeGeminiFinishReason(candidate.finishReason, false)
      : (blockReason ? 'content_filter' : 'stop'));

  let message = null;
  if (content) {
    message = {
      role: 'assistant',
      blocks,
      passthrough: content.passthrough
    };
  }

  const passthrough = omitKnown(response, RESPONSE_KEYS);
  if (candidate) {
    const candidateExtras = omitKnown(candidate, new Set([
      'content', 'finishReason', 'finishMessage', 'index', 'safetyRatings',
      'citationMetadata', 'groundingMetadata', 'avgLogprobs', 'tokenCount',
      'logprobsResult', 'urlContextMetadata', 'groundingAttributions'
    ]));
    const detail = {
      index: candidate.index,
      safetyRatings: candidate.safetyRatings,
      citationMetadata: candidate.citationMetadata,
      groundingMetadata: candidate.groundingMetadata,
      avgLogprobs: candidate.avgLogprobs,
      tokenCount: candidate.tokenCount,
      ...candidateExtras
    };
    if (Object.values(detail).some(value => value !== undefined)) passthrough.candidate = detail;
  }

  return {
    kind: 'response',
    sourceDialect: 'gemini',
    id: response.responseId,
    model: response.modelVersion,
    message,
    finishReason,
    usage: decodeUsage(response.usageMetadata),
    passthrough: { gemini: passthrough }
  };
}

function encodeResponse(ir) {
  const response = {};
  const candidateExtras = ir.passthrough?.gemini?.candidate || {};
  const parts = ir.message ? encodeParts(ir.message.blocks) : [];
  const hasTools = (ir.message?.blocks || []).some(block => block.type === 'tool_call');
  if (parts.length || hasTools) {
    const candidate = {
      content: { role: 'model', parts },
      ...(candidateExtras.index !== undefined ? { index: candidateExtras.index } : { index: 0 }),
      finishReason: geminiFinishReason(ir.finishReason, hasTools)
    };
    for (const [key, value] of Object.entries(candidateExtras)) {
      if (key === 'index') continue;
      if (value !== undefined) candidate[key] = value;
    }
    response.candidates = [candidate];
  } else if (ir.finishReason === 'content_filter') {
    response.promptFeedback = ir.passthrough?.gemini?.promptFeedback
      || { blockReason: 'SAFETY' };
  } else {
    response.candidates = [{
      content: { role: 'model', parts: [] },
      ...(candidateExtras.index !== undefined ? { index: candidateExtras.index } : { index: 0 }),
      finishReason: geminiFinishReason(ir.finishReason, false)
    }];
    for (const [key, value] of Object.entries(candidateExtras)) {
      if (key === 'index' || response.candidates[0][key] !== undefined) continue;
      if (value !== undefined) response.candidates[0][key] = value;
    }
  }
  if (ir.usage) response.usageMetadata = encodeUsage(ir.usage);
  if (ir.id) response.responseId = ir.id;
  if (ir.model) response.modelVersion = ir.model;
  const topLevel = ir.passthrough?.gemini ? { ...ir.passthrough.gemini } : {};
  delete topLevel.candidate;
  return withPassthrough(response, topLevel);
}

function decodeStreamEvent(event) {
  const decoded = decodeResponse(event);
  const passthrough = omitKnown(event, EVENT_KEYS);
  const candidate = event.candidates?.[0];
  if (candidate) {
    const extras = omitKnown(candidate, new Set([
      'content', 'finishReason', 'finishMessage', 'index', 'safetyRatings',
      'citationMetadata', 'groundingMetadata', 'avgLogprobs', 'tokenCount',
      'logprobsResult', 'urlContextMetadata', 'groundingAttributions'
    ]));
    if (candidate.safetyRatings || candidate.citationMetadata || candidate.groundingMetadata || Object.keys(extras).length) {
      passthrough.candidate = {
        ...(candidate.safetyRatings ? { safetyRatings: candidate.safetyRatings } : {}),
        ...(candidate.citationMetadata ? { citationMetadata: candidate.citationMetadata } : {}),
        ...(candidate.groundingMetadata ? { groundingMetadata: candidate.groundingMetadata } : {}),
        ...extras
      };
    }
  }
  return {
    kind: 'stream_event',
    sourceDialect: 'gemini',
    id: decoded.id,
    model: decoded.model,
    eventType: 'chunk',
    index: 0,
    delta: decoded.message,
    finishReason: decoded.finishReason && event.candidates?.[0]?.finishReason !== undefined
      ? decoded.finishReason
      : undefined,
    usage: decoded.usage,
    passthrough: { gemini: passthrough }
  };
}

function encodeStreamEvent(ir) {
  const event = {};
  const blocks = ir.delta?.blocks || [];
  if (blocks.length) {
    event.candidates = [{
      content: { role: 'model', parts: encodeParts(blocks) },
      index: ir.index || 0
    }];
  }
  const hasTools = blocks.some(block => block.type === 'tool_call');
  if (ir.finishReason) {
    event.candidates = event.candidates || [{
      content: { role: 'model', parts: [] },
      index: ir.index || 0
    }];
    event.candidates[0].finishReason = geminiFinishReason(ir.finishReason, hasTools);
  }
  if (ir.usage) event.usageMetadata = encodeUsage(ir.usage);
  if (ir.id) event.responseId = ir.id;
  if (ir.model) event.modelVersion = ir.model;
  const topLevel = ir.passthrough?.gemini ? { ...ir.passthrough.gemini } : {};
  const candidateExtras = topLevel.candidate;
  delete topLevel.candidate;
  if (candidateExtras && event.candidates?.[0]) Object.assign(event.candidates[0], candidateExtras);
  return withPassthrough(event, topLevel);
}

module.exports = {
  decodeRequest,
  encodeRequest,
  decodeResponse,
  encodeResponse,
  decodeStreamEvent,
  encodeStreamEvent,
  // Exported for stream writers / tests.
  decodeUsage,
  encodeUsage,
  normalizeGeminiFinishReason,
  geminiFinishReason,
  normalizeFunctionResponse,
  thinkingConfigFor,
  RESPONSE_MODALITIES
};
