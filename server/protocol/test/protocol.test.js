'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('..');
const transforms = require('../../providers/transforms');

const openaiToAnthropic = transforms.getTransform('openai', 'anthropic');
const anthropicToOpenai = transforms.getTransform('anthropic', 'openai');

test('simple request crosses the canonical IR', () => {
  const result = openaiToAnthropic.request({ model: 'm', messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 128, temperature: 0.2 });
  assert.equal(result.messages[0].content[0].text, 'hello');
  assert.equal(result.max_tokens, 128);
  assert.equal(result.temperature, 0.2);
});

test('system and developer messages degrade to Anthropic system', () => {
  const result = openaiToAnthropic.request({ model: 'm', messages: [{ role: 'system', content: 'one' }, { role: 'developer', content: 'two' }, { role: 'user', content: 'go' }] });
  assert.deepEqual(result.system, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
  assert.equal(result.messages.length, 1);
});

test('tools and tool results preserve semantic content', () => {
  const request = openaiToAnthropic.request({
    model: 'm',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"SZ"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
    ],
    tools: [{ type: 'function', function: { name: 'weather', description: 'weather', parameters: { type: 'object' } } }]
  });
  assert.equal(request.messages[0].content[0].type, 'tool_use');
  assert.deepEqual(request.messages[0].content[0].input, { city: 'SZ' });
  assert.equal(request.messages[1].content[0].type, 'tool_result');
  assert.equal(request.tools[0].name, 'weather');
});

test('thinking and reasoning survive response conversion', () => {
  const openai = openaiToAnthropic.response({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'answer' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } });
  assert.equal(openai.choices[0].message.reasoning_content, 'private');
  assert.equal(openai.choices[0].message.content, 'answer');
});

test('stream text, tool and usage events convert without null', () => {
  const text = openaiToAnthropic.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
  assert.equal(text.choices[0].delta.content, 'hi');
  const tool = openaiToAnthropic.stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c', name: 'fn', input: {} } });
  assert.equal(tool.choices[0].delta.tool_calls[0].function.name, 'fn');
  const usage = openaiToAnthropic.stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
  assert.equal(usage.usage.completion_tokens, 4);
});

test('images and cache control are represented in IR', () => {
  const ir = protocol.codecs.anthropic.decodeRequest({ model: 'm', system: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' }, cache_control: { type: 'ephemeral' } }] }] });
  assert.equal(ir.messages[0].blocks[0].cacheControl.type, 'ephemeral');
  assert.equal(ir.messages[1].blocks[0].type, 'image');
});

test('unknown fields pass through only when encoding the same dialect', () => {
  const source = { model: 'm', messages: [{ role: 'user', content: 'hello', vendor_message: 1 }], vendor_top: { enabled: true } };
  const ir = protocol.codecs.openai.decodeRequest(source);
  const roundTrip = protocol.codecs.openai.encodeRequest(ir);
  assert.deepEqual(roundTrip.vendor_top, { enabled: true });
  assert.equal(roundTrip.messages[0].vendor_message, 1);
  const anthropic = protocol.codecs.anthropic.encodeRequest(ir);
  assert.equal(anthropic.vendor_top, undefined);
});

test('Responses codec handles input, output and stream deltas', () => {
  assert.equal(transforms.detectResponseFormat({ output: [] }), 'responses');
  const bridge = transforms.getTransform('responses', 'anthropic');
  assert.equal(bridge.capability.status, protocol.Capability.DEGRADE);
  const request = bridge.request({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], max_output_tokens: 12, vendor_flag: true });
  assert.equal(request.messages[0].content[0].text, 'hi');
  assert.equal(request.max_tokens, 12);
  const response = protocol.codecs.responses.decodeResponse({ id: 'r1', model: 'm', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } });
  assert.equal(response.message.blocks[0].text, 'ok');
  assert.equal(response.usage.inputTokens, 2);
  assert.equal(protocol.codecs.responses.decodeStreamEvent({ type: 'response.output_text.delta', delta: 'x', item_id: 'i' }).delta.blocks[0].text, 'x');
  assert.equal(transforms.hasTransform('responses', 'anthropic'), true);
});

test('Gemini codec maps contents, tools, response and stream chunks', () => {
  assert.equal(transforms.detectResponseFormat({ candidates: [] }), 'gemini');
  const ir = protocol.codecs.gemini.decodeRequest({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { maxOutputTokens: 20 }, unknown: { keep: true } });
  assert.equal(ir.messages[0].blocks[0].text, 'hello');
  assert.equal(ir.parameters.maxTokens, 20);
  const roundTrip = protocol.codecs.gemini.encodeRequest(ir);
  assert.deepEqual(roundTrip.unknown, { keep: true });
  const response = protocol.codecs.gemini.decodeResponse({ responseId: 'g1', modelVersion: 'gemini', candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } });
  assert.equal(response.message.role, 'assistant');
  assert.equal(response.message.blocks[0].text, 'answer');
  assert.equal(protocol.codecs.gemini.decodeStreamEvent({ candidates: [{ content: { role: 'model', parts: [{ text: 'd' }] } }] }).delta.blocks[0].text, 'd');
});

test('phase one feature compatibility excludes the api hot path', () => {
  assert.equal(protocol.featureCompat.scope, 'server/providers/transforms');
  assert.equal(protocol.featureCompat.apiHotPath, false);
  assert.equal(protocol.featureCompat.compatibility.getTransform, true);
  assert.equal(protocol.featureCompat.compatibility.registerTransform, true);
});

test('provider quirks describe covered degradation decisions', () => {
  assert.equal(protocol.ProviderQuirks.anthropic.max_completion_tokens, protocol.Capability.DEGRADE);
  assert.equal(protocol.ProviderQuirks.anthropic.temperature, protocol.Capability.SUPPORTED);
  assert.equal(protocol.ProviderQuirks.anthropic.developer, protocol.Capability.DEGRADE);
  assert.equal(protocol.ProviderQuirks.anthropic.stream_usage, protocol.Capability.DEGRADE);
  assert.equal(protocol.ProviderQuirks.anthropic.reasoning_effort, protocol.Capability.DEGRADE);
});
