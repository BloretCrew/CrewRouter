'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  MAX_MODEL_LENGTH, MAX_FRAME_LENGTH, normalizeModel,
  createModelIdentity, createModelIdentityStream, observeModelResponse,
} = require('../utils/model-identity');

const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
function routeFunctions(overrides = {}) {
  const context = {
    createModelIdentity, observeModelResponse, JSON, AbortSignal,
    ...require('../utils/request-lifecycle'),
    ...require('../utils/upstream-retry-policy'),
    MAX_UPSTREAM_ATTEMPTS: 12,
    Logger: { warn() {} },
    pluginHooks: { hasSubscribers: () => false },
    proxyPool: { proxyFetch: async () => new Response('{}'), getProxyAgent: async () => null },
    isUpstreamTimeoutError: () => false,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function modelIdentityValues('), source.indexOf('function bridgeRequest(')), context);
  vm.runInContext(source.slice(source.indexOf('async function fetchWithProxyRetry('), source.indexOf('/**\n * 是否可对 Key')), context);
  return context;
}

function sse(identity, chunks) {
  const stream = createModelIdentityStream(identity);
  chunks.forEach(chunk => stream.push(chunk));
  stream.finish();
  return identity.snapshot().response_model;
}

for (const [name, value] of [
  ['Chat', { model: ' upstream-v2 ' }],
  ['Anthropic', { type: 'message', model: 'upstream-v2' }],
  ['Responses', { object: 'response', model: 'upstream-v2' }],
]) {
  test(`${name} non-stream raw model survives downstream rewrite`, async () => {
    const identity = createModelIdentity('alias', 'route');
    const response = observeModelResponse(new Response(JSON.stringify(value)), identity);
    const data = await response.json();
    data.model = 'plugin-model';
    identity.observe({ model: 'bridge-model' });
    assert.deepEqual(identity.snapshot(), { requested_model: 'alias', resolved_model: 'route', response_model: 'upstream-v2' });
  });
}

test('normalization rejects malformed, unbounded and control-character models', () => {
  for (const value of [undefined, null, 1, {}, [], true, '', '  ', 'x'.repeat(MAX_MODEL_LENGTH + 1), 'bad\nmodel']) {
    assert.equal(normalizeModel(value), null);
  }
  assert.equal(normalizeModel('  model  '), 'model');
  assert.equal(normalizeModel('x'.repeat(MAX_MODEL_LENGTH)).length, MAX_MODEL_LENGTH);
});

test('protocol field selection ignores arbitrary nested models and errors', () => {
  const identity = createModelIdentity(null, null);
  for (const value of [
    { message: { model: 'fake' } }, { response: { model: 'fake' } },
    { type: 'content_block_delta', model: 'fake' },
    { type: 'error', model: 'fake' }, { model: 'fake', error: {} },
    { type: 'response.failed', response: { model: 'fake' } },
    { type: 'response.completed', response: { error: {}, model: 'fake' } },
  ]) identity.observe(value);
  assert.deepEqual(identity.snapshot(), { requested_model: null, resolved_model: null, response_model: null });
});

test('Chat SSE handles every byte boundary, CRLF, multiple events, UTF-8 and trailing frame', () => {
  const wire = ': comment\r\ndata: {"model":"初始","choices":[]}\r\n\r\ndata: {"model":null}\r\n\r\ndata: damaged\r\n\r\ndata: {"model":"最终"}';
  const bytes = Buffer.from(wire);
  for (let split = 0; split <= bytes.length; split++) {
    assert.equal(sse(createModelIdentity('client', 'route'), [bytes.subarray(0, split), bytes.subarray(split)]), '最终');
  }
  assert.equal(sse(createModelIdentity(), [...bytes].map(byte => Buffer.from([byte]))), '最终');
});

test('Anthropic message_start and stop freeze captured model', () => {
  const wire = 'event: message_start\ndata: {"message":{"model":"claude-upstream"}}\n\n'
    + 'data: {"type":"message_stop"}\n\n'
    + 'data: {"model":"late"}\n\n';
  assert.equal(sse(createModelIdentity(), [wire]), 'claude-upstream');
});

test('Responses terminal model wins, missing terminal preserves earlier model and DONE freezes', () => {
  for (const terminal of ['response.completed', 'response.incomplete']) {
    const wire = 'data: {"type":"response.created","response":{"model":"early"}}\n\n'
      + `event: ${terminal}\ndata: {"response":{"model":"final"}}\n\n`
      + 'data: {"type":"response.created","response":{"model":"late"}}\n\n';
    assert.equal(sse(createModelIdentity(), [wire]), 'final');
  }
  assert.equal(sse(createModelIdentity(), ['data: {"model":"first"}\n\ndata: [DONE]\n\ndata: {"model":"late"}\n\n']), 'first');
  assert.equal(sse(createModelIdentity(), ['data: {"type":"response.created","response":{"model":"early"}}\n\ndata: {"type":"response.completed","response":{}}']), 'early');
});

test('multiline SSE data and oversized frame recover safely', () => {
  assert.equal(sse(createModelIdentity(), ['data: {\ndata: "model": "multiline"}\n\n']), 'multiline');
  assert.equal(sse(createModelIdentity(), ['data: ' + 'x'.repeat(MAX_FRAME_LENGTH), 'x\n\ndata: {"model":"recovered"}\n\n']), 'recovered');
});

test('reader wrapper preserves bytes and collects before plugin/conversion, including stream failure', async () => {
  for (const fail of [false, true]) {
    const bytes = Buffer.from('data: {"model":"raw"}');
    let reads = 0;
    const error = new Error('upstream interrupted');
    const response = {
      ok: true,
      body: { getReader: () => ({ read: async () => {
        if (reads++ === 0) return { done: false, value: bytes };
        if (fail) throw error;
        return { done: true };
      } }) },
    };
    const identity = createModelIdentity('alias', 'route');
    const reader = observeModelResponse(response, identity).body.getReader();
    assert.equal((await reader.read()).value, bytes);
    if (fail) await assert.rejects(reader.read(), error);
    else assert.equal((await reader.read()).done, true);
    assert.equal(identity.snapshot().response_model, 'raw');
  }
});

test('text parser observes before response rewrite, malformed JSON and HTTP errors stay absent', async () => {
  for (const [body, status, expected] of [['{"model":"raw"}', 200, 'raw'], ['not-json', 200, null], ['{"model":"error-model"}', 500, null]]) {
    const identity = createModelIdentity('client', 'route');
    const response = observeModelResponse(new Response(body, { status }), identity);
    assert.equal(await response.text(), body);
    assert.equal(identity.snapshot().response_model, expected);
  }
  const identity = createModelIdentity();
  const response = observeModelResponse(new Response('data: {"model":"error-model"}\n\n', { status: 500 }), identity);
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {}
  assert.equal(identity.snapshot().response_model, null);
});

test('actual fetch helper snapshots encoded/plugin body and isolates overlapping attempts', async () => {
  const pending = [];
  const context = routeFunctions({ proxyPool: { proxyFetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })) } });
  const requestContext = { requestedModel: 'client' };
  const first = context.fetchWithModelIdentity('http://mock', { body: '{"model":"route-a"}', requestContext });
  const firstIdentity = requestContext.modelIdentity;
  const second = context.fetchWithModelIdentity('http://mock', { body: '{"model":"route-b-thinking"}', requestContext });
  pending[1].resolve(new Response('{"model":"upstream-b"}'));
  await (await second).json();
  pending[0].resolve(new Response('{"model":"upstream-a"}'));
  await (await first).json();
  assert.equal(firstIdentity.snapshot().response_model, 'upstream-a');
  assert.deepEqual(requestContext.modelIdentity.snapshot(), { requested_model: 'client', resolved_model: 'route-b-thinking', response_model: 'upstream-b' });
});

test('actual retry helper discards failed attempt and records final encoded body after plugin', async () => {
  const requestContext = { requestedModel: 'client', upstreamAttempts: 0 };
  let calls = 0;
  const context = routeFunctions({
    pluginHooks: { hasSubscribers: () => true, apply: async () => ({ bodyText: '{"model":"plugin-route"}' }) },
    validateBeforeUpstreamRewrite: async (original, out) => ({ override: out }),
    proxyPool: {
      proxyFetch: async () => { if (calls++ === 0) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); return new Response('{"model":"final-upstream"}'); },
      getProxyAgent: async () => null,
    },
  });
  const { response } = await context.fetchWithProxyRetry(() => ({ url: 'http://mock', body: '{"model":"route"}' }), {}, null, 2, 'test', { model: 'route', requestContext });
  await response.text();
  assert.equal(calls, 2);
  assert.deepEqual(requestContext.modelIdentity.snapshot(), { requested_model: 'client', resolved_model: 'plugin-route', response_model: 'final-upstream' });
});

test('all eight existing usage INSERTs append identity with matching placeholders; fusion has no fabricated model', () => {
  const inserts = [...source.matchAll(/usageQuery: `INSERT INTO usage_records \((.*?)\)\s+VALUES \((.*?)\) RETURNING id`, usageValues: \[(.*?)\], userId:/gs)];
  assert.equal(inserts.length, 8);
  for (const [, columns, placeholders, values] of inserts) {
    assert.equal(columns.split(',').length, placeholders.split(',').length);
    assert.ok(columns.endsWith('requested_model, resolved_model, response_model'));
    assert.match(values, /\.\.\.modelIdentityValues\(req(?:, true)?\)$/);
  }
  const context = routeFunctions();
  const req = { _requestedModel: 'fusion', _upstreamAttemptContext: { modelIdentity: createModelIdentity('fusion', 'child') } };
  req._upstreamAttemptContext.modelIdentity.observe({ model: 'child-response' });
  assert.deepEqual(Array.from(context.modelIdentityValues(req, true)), ['fusion', null, null]);
  assert.equal((source.match(/proxyPool\.proxyFetch\(/g) || []).length, 1);
  assert.equal((source.match(/await fetchWithModelIdentity\(/g) || []).length, 6);
});

test('existing error detail retains identity without changing error message or number of records', () => {
  const records = [];
  const context = routeFunctions({ captureRawCallError: (req, detail) => records.push(detail) });
  const req = { _requestedModel: 'client', _upstreamAttemptContext: { modelIdentity: createModelIdentity('client', 'route') } };
  req._upstreamAttemptContext.modelIdentity.observe({ model: 'raw' });
  context.captureCallError(req, { status: 502, body: { error: { message: 'failed', type: 'api_error' } } });
  assert.equal(records.length, 1);
  assert.equal(records[0].body.error.message, 'failed');
  assert.equal(records[0].body.model_identity.response_model, 'raw');
});

function loadProxyMatrix(wire) {
  const bridge = require('../protocol/bridge');
  const logger = Object.fromEntries(['info', 'warn', 'error', 'stream'].map(key => [key, () => {}]));
  const context = routeFunctions({
    Logger: logger, TextDecoder, Date, Map, Set, crypto: require('crypto'),
    UPSTREAM_TIMEOUT: 180000, UPSTREAM_STREAM_TIMEOUT: 300000,
    cleanBaseUrl: value => value, upstreamUrl: (base, endpoint) => base + endpoint,
    buildUpstreamHeaders: (provider, req, headers) => headers,
    affinityKeyForRequest: () => 'test', addFourthCacheBreakpoint: () => {},
    buildSignatureForRequest: async () => null,
    createStreamScrubber: require('../utils/inject-prompt-stream').createStreamScrubber,
    normalizeUsageTokens: require('../utils/token-normalize').normalizeUsageTokens,
    ResponsesUpstream: require('../utils/responses-upstream'), protocolBridge: bridge,
    normalizeMessageRole: role => role,
    convertOpenAIContentToAnthropic: value => value,
    pluginHooks: { hasSubscribers: () => false, applyFinalResponseHeaders: async () => {} },
    proxyPool: {
      proxyFetch: async () => new Response(wire), getProxyAgent: async () => null,
      getProxies: async () => [], markProxySuccess() {},
    },
    ...require('../utils/openai-response-normalize'),
  });
  for (const name of [
    'bridgeRequest', 'respondProxyError', 'safeParseJson',
    'proxyOpenAI', 'proxyChatToResponses', 'proxyAnthropic',
    'convertAnthropicToOpenAI', 'convertOpenAIToAnthropicResponse',
    'proxyAnthropicToAnthropic', 'proxyOpenAIToAnthropic',
    'proxyOpenAIStreamToAnthropic', 'proxyOpenAINonStreamToAnthropic',
    'convertChatCompletionToResponse', 'streamOpenAIAsResponses', 'streamAnthropicAsResponses',
    'proxyOpenAIForResponses', 'proxyAnthropicForResponses',
  ]) {
    const declaration = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(declaration, name);
    const rest = source.slice(declaration.index + declaration[0].length);
    const next = /^(?:(?:async )?function |router\.)/m.exec(rest);
    const end = next ? declaration.index + declaration[0].length + next.index : source.length;
    vm.runInContext(source.slice(declaration.index, end), context);
  }
  return context;
}

const rawFixtures = {
  openai: { id: 'chatcmpl_mock', object: 'chat.completion', model: 'raw-v2', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  anthropic: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'raw-v2', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } },
  responses: { id: 'resp_mock', object: 'response', model: 'raw-v2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
};
const streamFixtures = {
  openai: 'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","model":"raw-v2","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
    + 'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n',
  anthropic: 'data: {"type":"message_start","message":{"id":"msg_mock","model":"raw-v2","usage":{"input_tokens":2}}}\n\n'
    + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
    + 'data: {"type":"content_block_stop","index":0}\n\n'
    + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
    + 'data: {"type":"message_stop"}\n\n',
  responses: 'data: {"type":"response.created","response":{"model":"early"}}\n\n'
    + 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
    + 'data: {"type":"response.completed","response":{"model":"raw-v2","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
};

function mockClient() {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.body = { model: 'client-alias' };
  req.headers = {};
  req.apiUser = {};
  req._upstreamAttemptContext = { requestedModel: 'client-alias', upstreamAttempts: 0 };
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.flushHeaders = () => {};
  res.output = '';
  res.write = value => { res.output += value; return true; };
  res.end = () => { res.writableEnded = true; };
  res.json = value => { res.output = JSON.stringify(value); res.writableEnded = true; };
  return { req, res };
}

for (const [name, dialect] of [
  ['proxyOpenAI', 'openai'], ['proxyChatToResponses', 'responses'],
  ['proxyAnthropic', 'anthropic'], ['proxyAnthropicToAnthropic', 'anthropic'],
  ['proxyOpenAIToAnthropic', 'openai'],
]) {
  for (const stream of [false, true]) {
    test(`actual ${name} ${stream ? 'stream' : 'JSON'} preserves upstream identity through conversion`, async () => {
      const context = loadProxyMatrix(stream ? streamFixtures[dialect] : JSON.stringify(rawFixtures[dialect]));
      const { req, res } = mockClient();
      const result = await context[name]({ id: 'mock', base_url: 'http://mock' }, 'route-model', { model: 'route-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 12 }, stream, res, req);
      assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, 'raw-v2');
      assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().resolved_model, 'route-model');
      assert.ok(res.output.includes('ok'), res.output);
      assert.ok(result && !result.__proxyError);
    });
  }
}

for (const [name, dialect] of [['proxyOpenAIForResponses', 'openai'], ['proxyAnthropicForResponses', 'anthropic']]) {
  test(`actual ${name} collects raw JSON before Responses conversion`, async () => {
    const context = loadProxyMatrix(JSON.stringify(rawFixtures[dialect]));
    const { req, res } = mockClient();
    await context[name]({ id: 'mock', base_url: 'http://mock' }, 'route-model', { model: 'route-model', messages: [{ role: 'user', content: 'hi' }] }, res, req, 'resp_mock', { model: 'client-alias' });
    assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, 'raw-v2');
    assert.ok(res.output.includes('ok'));
  });
}

for (const [name, dialect] of [['streamOpenAIAsResponses', 'openai'], ['streamAnthropicAsResponses', 'anthropic']]) {
  test(`actual ${name} collects original SSE before generated Responses events`, async () => {
    const context = loadProxyMatrix(streamFixtures[dialect]);
    const { req, res } = mockClient();
    const response = await context.fetchWithModelIdentity('http://mock', { body: '{"model":"route-model"}', requestContext: req._upstreamAttemptContext });
    await context[name](response.body.getReader(), new TextDecoder(), res, req, 'resp_mock', 'route-model', {}, value => res.write(value), async () => {});
    assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, 'raw-v2');
    assert.ok(res.output.includes('response.completed'));
    assert.ok(res.output.includes('ok'));
  });
}

test('429 response is returned without proxy regeneration', async () => {
  const requestContext = { requestedModel: 'client', upstreamAttempts: 0 };
  let calls = 0;
  const context = routeFunctions({ proxyPool: {
    proxyFetch: async () => { calls++; return new Response('{"model":"rejected"}', { status: 429 }); },
    getProxyAgent: async () => ({ proxyId: 'next' }), markProxy429() {},
  } });
  const { response } = await context.fetchWithProxyRetry(() => ({ url: 'http://mock', body: '{"model":"route"}' }), {}, { proxyId: 'first' }, 2, 'test', { requestContext });
  assert.equal(response.status, 429);
  await response.json();
  assert.equal(calls, 1);
  assert.equal(requestContext.modelIdentity.snapshot().response_model, null);
});

test('provider key fallback creates a fresh identity for the successful key', async () => {
  let calls = 0;
  const context = routeFunctions({
    resolveApiKeyAttempts: async () => ['first', 'second'],
    isProxyErrorResult: result => result?.__proxyError === true,
    proxyPool: { proxyFetch: async () => new Response(calls++ === 0 ? '{"model":"first-response"}' : '{}') },
  });
  const start = source.indexOf('async function runWithProviderKeyFallback(');
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
  const { req, res } = mockClient();
  res.req = req;
  await context.runWithProviderKeyFallback({}, res, true, async provider => {
    const response = await context.fetchWithModelIdentity('http://mock', { body: '{"model":"route"}', requestContext: provider._requestContext });
    await response.json();
    return provider.api_key === 'first' ? { __proxyError: true, retryable: true } : { content: 'ok' };
  });
  assert.equal(calls, 2);
  assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, null);
});

test('actual upstream response plugin rewrites the client model but not collected evidence', async () => {
  const context = loadProxyMatrix(JSON.stringify(rawFixtures.openai));
  context.pluginHooks = {
    hasSubscribers: name => name === 'gateway:upstreamResponse',
    apply: async (name, payload) => ({ ...payload, body: { ...payload.body, model: 'plugin-rewrite' } }),
    applyFinalResponseHeaders: async () => {},
  };
  const { req, res } = mockClient();
  await context.proxyOpenAI({ id: 'mock', base_url: 'http://mock' }, 'route-model', { messages: [] }, false, res, req);
  assert.equal(JSON.parse(res.output).model, 'plugin-rewrite');
  assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, 'raw-v2');
});

test('actual response chunk plugin sees the model only after raw collection', async () => {
  const context = loadProxyMatrix(streamFixtures.openai);
  const { req, res } = mockClient();
  let rewritten = 0;
  context.pluginHooks = {
    hasSubscribers: name => name === 'gateway:responseChunk',
    maybeRewriteChunk: async chunk => {
      assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, 'raw-v2');
      rewritten++;
      return chunk.replace('raw-v2', 'plugin-rewrite');
    },
  };
  await context.proxyOpenAI({ id: 'mock', base_url: 'http://mock' }, 'route-model', { messages: [] }, true, res, req);
  assert.ok(rewritten > 0);
  assert.ok(res.output.includes('plugin-rewrite'));
  assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, 'raw-v2');
});

test('bridge synthesized model never fills missing upstream response model', async () => {
  const raw = { ...rawFixtures.responses };
  delete raw.model;
  const context = loadProxyMatrix(JSON.stringify(raw));
  const { req, res } = mockClient();
  await context.proxyChatToResponses({ id: 'mock', base_url: 'http://mock' }, 'route-model', { messages: [] }, false, res, req);
  assert.equal(JSON.parse(res.output).model, 'route-model');
  assert.equal(req._upstreamAttemptContext.modelIdentity.snapshot().response_model, null);
});


test('failed terminal events freeze prior valid identity', () => {
  for (const terminal of [{ type: 'response.failed' }, { type: 'error' }, { type: 'response.completed', response: { error: {}, model: 'invalid' } }]) {
    const identity = createModelIdentity('client', 'route');
    identity.observe({ type: 'response.created', response: { model: 'initial' } });
    identity.observe(terminal);
    identity.observe({ type: 'response.created', response: { model: 'late' } });
    assert.equal(identity.snapshot().response_model, 'initial');
  }
});

test('real transport and retry helper count each network attempt once', async () => {
  const transportSource = fs.readFileSync(path.join(__dirname, '../proxy-pool.js'), 'utf8');
  const begin = transportSource.indexOf('async function proxyFetch(');
  const end = transportSource.indexOf('\n/**', begin);
  let networkCalls = 0;
  const transport = { ...require('../utils/request-lifecycle'), Logger: { info() {} }, axios: async () => { networkCalls++; throw Object.assign(new Error('mock refused'), { code: 'ECONNREFUSED' }); } };
  vm.createContext(transport);
  vm.runInContext(transportSource.slice(begin, end), transport);
  const context = routeFunctions({ proxyPool: { proxyFetch: transport.proxyFetch, getProxyAgent: async () => null } });
  const requestContext = { requestedModel: 'client', upstreamAttempts: 0 };
  await assert.rejects(context.fetchWithProxyRetry(() => ({ url: 'http://mock', body: '{"model":"route"}' }), {}, null, 12, 'test', { requestContext }));
  assert.equal(networkCalls, 12);
  assert.equal(requestContext.upstreamAttempts, 12);
});

test('trace snapshots remain available when finish precedes usage insertion', () => {
  let onFinish;
  let captured;
  const identity = createModelIdentity('client', 'route');
  identity.observe({ model: 'served' });
  const req = { body: { model: 'client' }, path: '/chat/completions', _requestedModel: 'client', _upstreamAttemptContext: { modelIdentity: identity }, apiUser: { keyId: 1 } };
  const middleware = { router: { use(fn) { fn(req, { statusCode: 200, once(event, fn) { if (event === 'finish' && !onFinish) onFinish = fn; } }, () => {}); } },
    recordEvent: async (_req, payload) => { captured = payload; }, clientMetaFromReq: () => ({}), createRequestLifecycle: () => ({ signal: null, dispose() {} }), Date, crypto: require('crypto'),
    require: () => ({ normalizeModel }) };
  vm.createContext(middleware);
  vm.runInContext(source.slice(source.indexOf('router.use('), source.indexOf("const { pool }")), middleware);
  req._upstreamAttemptContext.modelIdentity = identity;
  onFinish();
  req._usageRecordId = 42;
  assert.equal(captured.usageRecordId, null);
  assert.equal(captured.requestParams.model_identity.response_model, 'served');
  const userSource = fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8');
  assert.equal((userSource.match(/te\.request_params->'model_identity'->>'response_model'/g) || []).length, 2);
});
