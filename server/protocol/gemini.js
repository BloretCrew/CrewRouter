'use strict';

const { omitKnown, withPassthrough, safeParseJson } = require('./helpers');
const REQUEST_KEYS = new Set(['contents', 'systemInstruction', 'generationConfig', 'safetySettings', 'tools', 'toolConfig', 'cachedContent']);
const RESPONSE_KEYS = new Set(['candidates', 'promptFeedback', 'usageMetadata', 'modelVersion', 'responseId']);
const EVENT_KEYS = new Set(['candidates', 'promptFeedback', 'usageMetadata', 'modelVersion', 'responseId']);

function decodeParts(parts) {
  return (Array.isArray(parts) ? parts : []).map(part => {
    if (part.text !== undefined) return { type: 'text', text: part.text, passthrough: { gemini: omitKnown(part, new Set(['text'])) } };
    if (part.functionCall) return { type: 'tool_call', id: part.functionCall.name, name: part.functionCall.name, input: part.functionCall.args || {}, passthrough: { gemini: omitKnown(part, new Set(['functionCall'])) } };
    if (part.functionResponse) return { type: 'tool_result', toolCallId: part.functionResponse.name, content: decodeParts([{ text: JSON.stringify(part.functionResponse.response || {}) }]), passthrough: { gemini: omitKnown(part, new Set(['functionResponse'])) } };
    if (part.inlineData || part.fileData) return { type: 'image', source: part.inlineData || part.fileData, passthrough: { gemini: omitKnown(part, new Set(['inlineData', 'fileData'])) } };
    return { type: 'raw', value: part };
  });
}
function encodeParts(blocks) {
  return (blocks || []).map(block => {
    if (block.type === 'text') return withPassthrough({ text: block.text || '' }, block.passthrough?.gemini);
    if (block.type === 'tool_call') return withPassthrough({ functionCall: { name: block.name, args: block.input || safeParseJson(block.argumentsText, {}) } }, block.passthrough?.gemini);
    if (block.type === 'tool_result') return withPassthrough({ functionResponse: { name: block.toolCallId, response: JSON.parse(JSON.stringify(block.content || [])) } }, block.passthrough?.gemini);
    if (block.type === 'image') return withPassthrough(block.source?.inlineData ? { inlineData: block.source.inlineData } : { inlineData: block.source }, block.passthrough?.gemini);
    if (block.type === 'raw') return block.value;
    return null;
  }).filter(Boolean);
}
function decodeContent(content) { return { role: content.role === 'model' ? 'assistant' : content.role || 'user', blocks: decodeParts(content.parts), passthrough: { gemini: omitKnown(content, new Set(['role', 'parts'])) } }; }
function encodeMessage(message) { return { role: message.role === 'assistant' ? 'model' : 'user', parts: encodeParts(message.blocks) }; }
function decodeRequest(body) {
  return { kind: 'request', sourceDialect: 'gemini', model: body.model, messages: (body.contents || []).map(decodeContent), tools: (body.tools || []).flatMap(t => (t.functionDeclarations || []).map(f => ({ name: f.name, description: f.description, inputSchema: f.parameters || {}, passthrough: { gemini: omitKnown(f, new Set(['name', 'description', 'parameters'])) } }))), parameters: { maxTokens: body.generationConfig?.maxOutputTokens, maxTokensField: 'maxOutputTokens', temperature: body.generationConfig?.temperature, topP: body.generationConfig?.topP, topK: body.generationConfig?.topK, stop: body.generationConfig?.stopSequences, stream: body.stream }, passthrough: { gemini: omitKnown(body, REQUEST_KEYS) } };
}
function encodeRequest(ir) {
  const body = { contents: (ir.messages || []).filter(m => m.role !== 'system' && m.role !== 'developer').map(encodeMessage) };
  const system = (ir.messages || []).filter(m => m.role === 'system' || m.role === 'developer');
  if (system.length) body.systemInstruction = { role: 'user', parts: system.flatMap(m => encodeParts(m.blocks)) };
  const p = ir.parameters || {}; const generationConfig = {};
  if (p.maxTokens !== undefined) generationConfig.maxOutputTokens = p.maxTokens;
  if (p.temperature !== undefined) generationConfig.temperature = p.temperature;
  if (p.topP !== undefined) generationConfig.topP = p.topP;
  if (p.topK !== undefined) generationConfig.topK = p.topK;
  if (p.stop !== undefined) generationConfig.stopSequences = Array.isArray(p.stop) ? p.stop : [p.stop];
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (ir.tools?.length) body.tools = [{ functionDeclarations: ir.tools.map(t => withPassthrough({ name: t.name, description: t.description, parameters: t.inputSchema || {} }, t.passthrough?.gemini)) }];
  return withPassthrough(body, ir.passthrough?.gemini);
}
function decodeUsage(u) { return u ? { inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, totalTokens: u.totalTokenCount, cachedInputTokens: u.cachedContentTokenCount || 0, passthrough: { gemini: omitKnown(u, new Set(['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'cachedContentTokenCount'])) } } : undefined; }
function encodeUsage(u) { return u ? withPassthrough({ promptTokenCount: u.inputTokens || 0, candidatesTokenCount: u.outputTokens || 0, totalTokenCount: u.totalTokens ?? ((u.inputTokens || 0) + (u.outputTokens || 0)) }, u.passthrough?.gemini) : undefined; }
function decodeResponse(body) { const candidate = body.candidates?.[0] || {}; return { kind: 'response', sourceDialect: 'gemini', id: body.responseId, model: body.modelVersion, message: candidate.content ? decodeContent(candidate.content) : null, finishReason: candidate.finishReason, usage: decodeUsage(body.usageMetadata), passthrough: { gemini: omitKnown(body, RESPONSE_KEYS) } }; }
function encodeResponse(ir) { const body = { candidates: [{ content: { role: 'model', parts: encodeParts(ir.message?.blocks || []) }, finishReason: ir.finishReason || 'STOP' }], usageMetadata: encodeUsage(ir.usage) }; return withPassthrough(body, ir.passthrough?.gemini); }
function decodeStreamEvent(event) { const result = decodeResponse(event); return { kind: 'stream_event', sourceDialect: 'gemini', id: result.id, model: result.model, eventType: 'chunk', delta: result.message, finishReason: result.finishReason, usage: result.usage, passthrough: { gemini: omitKnown(event, EVENT_KEYS) } }; }
function encodeStreamEvent(ir) { const event = encodeResponse(ir); return withPassthrough(event, ir.passthrough?.gemini); }
module.exports = { decodeRequest, encodeRequest, decodeResponse, encodeResponse, decodeStreamEvent, encodeStreamEvent };
