'use strict';

// 执行 api.js 实际 proxyViaBridge、真实 stream writers 与统一签名入口。
// 仅隔离网络、指标与数据库，不依赖应用启动或真实凭据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createStreamWriter } = require('../protocol/stream-writers');
const { createSSEParser } = require('../protocol/sse');
const protocolBridge = require('../protocol/bridge');
const root = path.join(__dirname, '..');
const logger = { info() {}, warn() {}, error() {} };
const moduleContext = { module: { exports: {} }, Buffer, require(id) {
  const mocks = {
    '../models/database': { pool: { query() { throw new Error('不得查询数据库'); } } },
    './quota-data': {}, '../logger': logger, '../proxy-pool': {}
  };
  assert(Object.hasOwn(mocks, id), `未预期依赖 ${id}`);
  return mocks[id];
} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/api-signature.js'), 'utf8'), moduleContext);
const { finalizeStreamSignature } = moduleContext.module.exports;
const source = fs.readFileSync(path.join(root, 'routes/api.js'), 'utf8');
const start = source.indexOf('async function proxyViaBridge(');
const end = source.indexOf('\n}', start);
assert(start >= 0 && end > start, '提取实际 proxyViaBridge 函数');
const declaration = source.slice(start, end + 2);
const usage = { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 };
const text = value => ({ type: 'text', text: value });
const args = { city: '上海', options: { units: 'metric', days: [1, 2] } };
const tool = () => ({ type: 'tool_call', index: 0, id: 'call_weather', name: 'weather', input: structuredClone(args), argumentsText: JSON.stringify(args) });
const irEvent = blocks => ({ delta: { role: 'assistant', blocks } });

async function run(clientDialect, { events = [irEvent([text('ANSWER'), tool()])], header = false, json = false,
  enabled = true, clientAlt } = {}) {
  const wire = [];
  const body = json ? { response_format: { type: 'json_schema' } } : {};
  const req = {
    body, headers: header ? { 'x-crewrouter-signature-mode': 'header' } : {},
    apiUser: { signature: { enabled, template: 'SIG {tokens}' } },
    _signaturePreloadPromise: Promise.resolve({})
  };
  const res = {
    writableEnded: false, destroyed: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    write(value) { wire.push(value); return true; }, end() { this.writableEnded = true; }
  };
  const allEvents = [...structuredClone(events), { usage, finishReason: 'stop' }];
  const context = {
    protocolBridge, createStreamWriter, finalizeStreamSignature, structuredClone, AbortSignal,
    Logger: logger, UPSTREAM_STREAM_TIMEOUT: 300000, UPSTREAM_TIMEOUT: 300000,
    injectPromptIntoIr() {}, scrubPromptFromBlocks() {},
    geminiSignatures: { attachToRequest() {}, rememberBlocks() {} },
    bridgeProxy: {
      async materializeMedia() {}, buildUpstreamPayload: () => ({}),
      buildUpstreamEndpoint: () => ({ url: 'https://mock.invalid/generateContent' }), providerAuthHeaders: () => ({}),
      async *readUpstreamEvents() { for (const event of allEvents) yield event; }
    },
    proxyPool: { getProxyAgent: async () => null }, affinityKeyForRequest: () => 'test',
    buildUpstreamHeaders: () => ({}), combineAbortSignals: () => undefined,
    getRequestMetrics: () => ({ beginAttempt: () => ({ finish: metrics => metrics }) }),
    fetchWithModelIdentity: async () => ({ ok: true, headers: {} }),
    forwardUpstreamHeaders() {}, waitForResponseDrain: async () => {},
    module: { exports: {} }
  };
  vm.runInNewContext(`${declaration}\nmodule.exports = proxyViaBridge;`, context, { filename: 'routes/api.js:proxyViaBridge' });
  const result = await context.module.exports({
    provider: { id: 'mock', name: 'mock', format: 'gemini', api_key: 'test' },
    model: 'gemini-fixture', body, sourceDialect: 'openai', clientDialect,
    stream: true, req, res, options: { clientAlt, clientResponseId: 'bridge_fixture' }
  });
  const raw = wire.join('');
  let data;
  if (clientDialect === 'gemini' && clientAlt === 'json') data = JSON.parse(raw);
  else {
    const parser = createSSEParser();
    data = parser.push(raw).concat(parser.end()).filter(frame => !frame.done).map(frame => JSON.parse(frame.data));
  }
  return { raw, data, result: JSON.parse(JSON.stringify(result)) };
}

function textSegments(dialect, data) {
  if (dialect === 'openai') return data.flatMap(e => typeof e.choices?.[0]?.delta?.content === 'string' ? [e.choices[0].delta.content] : []);
  if (dialect === 'anthropic') return data.filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta').map(e => e.delta.text);
  if (dialect === 'responses') return data.filter(e => e.type === 'response.output_text.delta').map(e => e.delta);
  if (dialect === 'interactions') return data.filter(e => e.event_type === 'step.delta' && e.delta?.type === 'text').map(e => e.delta.text);
  return data.flatMap(e => e.candidates?.[0]?.content?.parts || []).filter(p => typeof p.text === 'string').map(p => p.text);
}
function wireOrder(dialect, data) {
  if (dialect === 'openai') return data.flatMap(e => {
    const delta = e.choices?.[0]?.delta;
    return typeof delta?.content === 'string' ? [delta.content] : delta?.tool_calls?.some(t => t.function?.name) ? ['TOOL'] : [];
  });
  if (dialect === 'anthropic') return data.flatMap(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta' ? [e.delta.text]
    : e.type === 'content_block_start' && e.content_block?.type === 'tool_use' ? ['TOOL'] : []);
  if (dialect === 'responses') return data.flatMap(e => e.type === 'response.output_text.delta' ? [e.delta]
    : e.type === 'response.output_item.added' && e.item?.type === 'function_call' ? ['TOOL'] : []);
  if (dialect === 'interactions') return data.flatMap(e => e.event_type === 'step.delta' && e.delta?.type === 'text' ? [e.delta.text]
    : e.event_type === 'step.start' && e.step?.type === 'function_call' ? ['TOOL'] : []);
  return data.flatMap(e => e.candidates?.[0]?.content?.parts || []).flatMap(p => typeof p.text === 'string' ? [p.text] : p.functionCall ? ['TOOL'] : []);
}
function toolArguments(dialect, data) {
  if (dialect === 'openai') return JSON.parse(data.flatMap(e => e.choices?.[0]?.delta?.tool_calls || []).map(t => t.function?.arguments || '').join(''));
  if (dialect === 'anthropic') return JSON.parse(data.filter(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join(''));
  if (dialect === 'responses') return JSON.parse(data.find(e => e.type === 'response.function_call_arguments.done').arguments);
  if (dialect === 'interactions') return JSON.parse(data.filter(e => e.event_type === 'step.delta' && e.delta?.type === 'arguments_delta').map(e => e.delta.arguments).join(''));
  return data.flatMap(e => e.candidates?.[0]?.content?.parts || []).find(p => p.functionCall).functionCall.args;
}

for (const dialect of ['gemini', 'openai', 'anthropic', 'responses', 'interactions']) {
  test(`Bridge ${dialect}: 同IR[text ANSWER,tool]签名紧随已有正文、tool arguments完整`, async () => {
    const { data, result } = await run(dialect);
    assert.deepEqual(wireOrder(dialect, data), ['ANSWER', '\n\nSIG 10 tokens', 'TOOL']);
    assert.deepEqual(toolArguments(dialect, data), args);
    assert.equal(result.content, 'ANSWER');
    assert.deepEqual([result.promptTokens, result.completionTokens, result.cachedTokens], [7, 3, 2]);
    if (dialect === 'anthropic') assert.equal(data.filter(e => e.type === 'content_block_start' && e.content_block?.type === 'text').length, 1, '不能新建纯签名block');
    if (dialect === 'responses') assert.equal(data.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'message').length, 1);
  });
  for (const [label, events] of [
    ['分IR text→tool→text', [irEvent([text('FIRST')]), irEvent([tool()]), irEvent([text('SECOND')])]],
    ['同IR text→tool→text', [irEvent([text('FIRST'), tool(), text('SECOND')])]]
  ]) {
    test(`Bridge ${dialect}: ${label}保序且签名仅随最后正文`, async () => {
      const { data, result } = await run(dialect, { events });
      assert.deepEqual(wireOrder(dialect, data), ['FIRST', 'TOOL', 'SECOND', '\n\nSIG 10 tokens']);
      assert.deepEqual(toolArguments(dialect, data), args);
      assert.equal(result.content, 'FIRSTSECOND');
    });
  }
  for (const settings of [{ header: true }, { json: true }, { enabled: false }]) {
    test(`Bridge ${dialect}: ${JSON.stringify(settings)}不签名但保留tool`, async () => {
      const { data, result, raw } = await run(dialect, settings);
      assert(!raw.includes('SIG '));
      assert.equal(textSegments(dialect, data).join(''), 'ANSWER');
      assert.deepEqual(toolArguments(dialect, data), args);
      assert.equal(result.content, 'ANSWER');
    });
  }
}

for (const settings of [{ header: true }, { json: true }]) {
  test(`Bridge Gemini 同IR text→tool→text 即使${JSON.stringify(settings)}也必须保序`, async () => {
    const { data, raw } = await run('gemini', { ...settings, events: [irEvent([text('FIRST'), tool(), text('SECOND')])] });
    assert(!raw.includes('SIG '));
    assert.deepEqual(wireOrder('gemini', data), ['FIRST', 'TOOL', 'SECOND']);
    assert.deepEqual(toolArguments('gemini', data), args);
  });
}

test('Bridge Gemini JSON alt数组流有效，签名在tool之前', async () => {
  const { data, result } = await run('gemini', { clientAlt: 'json' });
  assert.deepEqual(wireOrder('gemini', data), ['ANSWER', '\n\nSIG 10 tokens', 'TOOL']);
  assert.deepEqual(toolArguments('gemini', data), args);
  assert.equal(result.content, 'ANSWER');
});

for (const events of [
  [irEvent([text('ANSWER'), tool()])],
  [irEvent([text('FIRST')]), irEvent([tool()]), irEvent([text('SECOND')])],
  [irEvent([text('FIRST'), tool(), text('SECOND')])],
  [irEvent([text('ANSWER')]), irEvent([{ type: 'tool_call', index: 0, id: 'call_weather', name: 'weather', streamDelta: true, argumentsText: '{"city":"上海",' }]),
    irEvent([{ type: 'tool_call_delta', index: 0, id: 'call_weather', argumentsText: '"options":{"units":"metric","days":[1,2]}}' }])]
]) {
  test(`Bridge Interactions history无签名且tool arguments完整: ${events.map(e => e.delta.blocks.map(b => b.type).join('+')).join('→')}`, async () => {
    const { result, raw } = await run('interactions', { events });
    assert(raw.includes('SIG 10 tokens'), '线上输出应包含签名');
    assert(!JSON.stringify(result.interactionSteps).includes('SIG'), '历史不得混入签名');
    assert.deepEqual(result.interactionSteps.find(s => s.type === 'function_call').arguments, args);
    assert.equal(result.interactionSteps.filter(s => s.type === 'model_output').flatMap(s => s.content).map(p => p.text || '').join(''), result.content);
  });
}
