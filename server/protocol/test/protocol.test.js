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


test('redacted data and signed thinking round-trip through requests, responses and stream starts', () => {
  const blocks = [
    { type: 'redacted_thinking', data: 'opaque+/==\u0000payload', vendor: 'keep' },
    { type: 'thinking', thinking: 'private', signature: 'signed+/==' },
    { type: 'text', text: 'answer' }
  ];
  const request = { model: 'm', messages: [{ role: 'assistant', content: blocks }] };
  const anthropic = protocol.codecs.anthropic;
  assert.deepEqual(anthropic.encodeRequest(anthropic.decodeRequest(request)).messages[0].content, blocks);
  const openaiRequest = protocol.convertRequest('anthropic', 'openai', request);
  assert.deepEqual(openaiRequest.messages[0].content, blocks);
  assert.equal(openaiRequest.messages[0].reasoning_content, undefined);
  assert.deepEqual(protocol.convertRequest('openai', 'anthropic', openaiRequest).messages[0].content, blocks);
  const response = { model: 'm', content: blocks, stop_reason: 'end_turn' };
  assert.deepEqual(anthropic.encodeResponse(anthropic.decodeResponse(response)).content, blocks);
  const openaiResponse = protocol.convertResponse('anthropic', 'openai', response);
  assert.deepEqual(protocol.convertResponse('openai', 'anthropic', openaiResponse).content, blocks);
  for (const block of blocks.slice(0, 2)) {
    const event = { type: 'content_block_start', index: 0, content_block: block };
    assert.deepEqual(anthropic.encodeStreamEvent(anthropic.decodeStreamEvent(event)), event);
    const chunk = protocol.convertStreamEvent('anthropic', 'openai', event);
    assert.deepEqual(chunk.choices[0].delta.content, [block]);
  }
});

test('cache TTL survives OpenAI and Anthropic content, nested results, system and tools', () => {
  const cache = { type: 'ephemeral', ttl: '1h' };
  const source = {
    model: 'm', prompt_cache_key: 'sticky-key',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'cached', cache_control: cache }] },
      { role: 'user', content: [{ type: 'text', text: 'question', cache_control: cache }] },
      { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'result', cache_control: cache }] }
    ],
    tools: [{ type: 'function', cache_control: cache, function: { name: 'fn', parameters: { type: 'object' } } }]
  };
  assert.deepEqual(plain(protocol.codecs.openai.encodeRequest(protocol.codecs.openai.decodeRequest(source))), source);
  const converted = protocol.convertRequest('openai', 'anthropic', source);
  assert.deepEqual(converted.system[0].cache_control, cache);
  assert.deepEqual(converted.messages[0].content[0].cache_control, cache);
  assert.deepEqual(converted.messages[1].content[0].content[0].cache_control, cache);
  assert.deepEqual(converted.tools[0].cache_control, cache);
  const roundTrip = protocol.convertRequest('anthropic', 'openai', converted);
  assert.deepEqual(roundTrip.messages[0].content[0].cache_control, cache);
  assert.deepEqual(roundTrip.tools[0].cache_control, cache);
  const imageRequest = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' }, cache_control: cache }] }] };
  assert.deepEqual(protocol.convertRequest('openai', 'anthropic', imageRequest).messages[0].content[0].cache_control, cache);
  const nestedToolCache = { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'fn', parameters: {}, cache_control: cache } }] };
  assert.deepEqual(protocol.convertRequest('openai', 'anthropic', nestedToolCache).tools[0].cache_control, cache);
});

const fs = require('node:fs');
const vm = require('node:vm');
const routeSource = fs.readFileSync(require.resolve('../../routes/api'), 'utf8');

function cacheRouteContext() {
  const context = vm.createContext({
    config: { gateway: {} }, Logger: { debug() {}, info() {}, warn() {} },
    cleanBaseUrl: value => value, upstreamUrl: (base, endpoint) => base + endpoint,
    buildUpstreamHeaders: () => ({}), affinityKeyForRequest: () => 'test',
    proxyPool: { getProxyAgent: async () => null, getProxies: async () => [] },
    MAX_UPSTREAM_ATTEMPTS: 1, UPSTREAM_TIMEOUT: 1000, UPSTREAM_STREAM_TIMEOUT: 1000,
    AbortSignal,
  });
  for (const name of ['addFourthCacheBreakpoint', 'convertOpenAIContentToAnthropic', 'normalizeMessageRole']) {
    const start = routeSource.indexOf(`function ${name}(`);
    const rest = routeSource.slice(start + 1);
    const next = /^(?:(?:async )?function |router\.)/m.exec(rest);
    vm.runInContext(routeSource.slice(start, start + 1 + next.index), context);
  }
  return context;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('fourth breakpoint counts tools and never overwrites TTL or annotates thinking', () => {
  const context = cacheRouteContext();
  const makeBody = () => ({
    tools: [{ name: 'fn', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: Array.from({ length: 6 }, (_, i) => ({ role: i === 5 ? 'user' : 'assistant', content: [{ type: 'text', text: 'hi' }] }))
  });
  const body = makeBody();
  assert.equal(context.addFourthCacheBreakpoint(body, undefined, true), true);
  assert.deepEqual(body.messages[5].content[0].cache_control.type, 'ephemeral');
  assert.equal(context.addFourthCacheBreakpoint(makeBody(), undefined, false), false);
  for (const tail of [
    { type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'thinking', thinking: 'private' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'unknown', text: 'unsupported' },
  ]) {
    const protectedBody = makeBody();
    protectedBody.messages[5].content = [tail];
    const before = plain(protectedBody);
    assert.equal(context.addFourthCacheBreakpoint(protectedBody, undefined, true), false);
    assert.deepEqual(plain(protectedBody), before);
  }
  const full = makeBody();
  full.tools = Array.from({ length: 4 }, () => full.tools[0]);
  assert.equal(context.addFourthCacheBreakpoint(full, undefined, true), false);
  const mixed = makeBody();
  mixed.system = [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }];
  mixed.messages[0].content[0].cache_control = { type: 'ephemeral' };
  mixed.messages[1].content[0].cache_control = { type: 'ephemeral' };
  assert.equal(context.addFourthCacheBreakpoint(mixed, undefined, true), false);
});

test('route conversion keeps cached single text and image metadata', () => {
  const context = cacheRouteContext();
  const cache = { type: 'ephemeral', ttl: '1h' };
  const text = [{ type: 'text', text: 'cached', cache_control: cache }];
  assert.deepEqual(plain(context.convertOpenAIContentToAnthropic(text)), text);
  assert.equal(context.convertOpenAIContentToAnthropic([{ type: 'text', text: 'plain' }]), 'plain');
  for (const url of ['data:image/png;base64,AA==', 'https://example.invalid/image']) {
    const image = context.convertOpenAIContentToAnthropic([{ type: 'image_url', image_url: { url }, cache_control: cache }]);
    assert.deepEqual(plain(image[0].cache_control), cache);
  }
});

test('actual proxy request builders preserve system/tools caches and opaque assistant blocks', async () => {
  for (const name of ['proxyAnthropic', 'proxyAnthropicForResponses', 'proxyOpenAI']) {
    const context = cacheRouteContext();
    const start = routeSource.indexOf(`async function ${name}(`);
    const end = routeSource.indexOf('  const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(', start);
    assert.ok(end > start);
    vm.runInContext(routeSource.slice(start, end) + '\nreturn upstreamBody;\n' + (name === 'proxyOpenAI' || name === 'proxyAnthropic' ? '}\n}' : '}'), context);
    const cache = { type: 'ephemeral', ttl: '1h' };
    const thinking = { type: 'redacted_thinking', data: 'opaque+/==' };
    const body = {
      prompt_cache_key: 'sticky-key',
      messages: [
        { role: 'developer', content: [{ type: 'text', text: 'system', cache_control: cache }] },
        { role: 'assistant', content: [thinking], tool_calls: [] },
        { role: 'user', content: [{ type: 'text', text: 'question', cache_control: cache }] }
      ],
      tools: [{ type: 'function', cache_control: cache, function: { name: 'fn', parameters: {} } }]
    };
    const before = plain(body);
    const req = { apiUser: {}, body, headers: {} };
    const result = name === 'proxyAnthropicForResponses'
      ? await context[name]({ base_url: 'https://example.invalid' }, 'm', body, {}, req, 'r', {})
      : await context[name]({ base_url: 'https://example.invalid' }, 'm', body, true, {}, req);
    if (name === 'proxyOpenAI') assert.equal(result.prompt_cache_key, 'sticky-key');
    else {
      assert.deepEqual(plain(result.system[0].cache_control), cache);
      assert.deepEqual(plain(result.tools[0].cache_control), cache);
      assert.deepEqual(plain(result.messages[0].content), [thinking]);
      assert.deepEqual(plain(result.messages[1].content[0].cache_control), cache);
    }
    assert.deepEqual(plain(body), before);
  }
});
