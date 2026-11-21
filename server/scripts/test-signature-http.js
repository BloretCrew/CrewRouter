'use strict';

// node server/scripts/test-signature-http.js
// Real Express routes + real api-signature, loopback HTTP upstream only.
// DB/auth/billing/storage are isolated fixtures, not production integration acceptance.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');
const axios = require('axios');
const realUrlValidator = require('../utils/url-validator');
const noop = () => {};
const asyncNoop = async () => {};
const mocks = new Map();
const mock = (file, value) => mocks.set(path.resolve(__dirname, '..', file), value);
const state = { queue: ['route-primary'], provider: null, ports: new Set(), received: [], usage: [], errors: [], shape: 'text', user: {}, key: {} };
const intervals = new Set();
const logger = { info: noop, warn: noop, error: (...args) => state.errors.push(args.join(' ')), debug: noop, stream: noop };
const pool = { async query(sql, values = []) {
  if (/SELECT DISTINCT m\.id/.test(sql)) return { rows: state.queue.filter(id => values[0].includes(id)).map(id => ({ id })) };
  if (/SELECT m\.id FROM models m/.test(sql)) return { rows: state.queue.includes(values[0]) ? [{ id: values[0] }] : [] };
  if (/SELECT DISTINCT p\.format/.test(sql)) return { rows: [{ format: state.provider.format }] };
  if (/FROM api_key_harness_models/.test(sql)) return { rows: [] };
  if (/FROM api_key_models/.test(sql)) return { rows: state.queue.map(model_id => ({ model_id })) };
  if (/SELECT ak\.current_model_id/.test(sql)) return { rows: [{ current_model_id: state.queue[0], enabled: true, expires_at: null, ...state.user, ...state.key }] };
  if (/SELECT \* FROM models WHERE id/.test(sql)) return { rows: [{ id: values[0], upstream_model_id: 'upstream-route-primary', provider: 'local-provider', enabled: true }] };
  if (/SELECT \* FROM providers WHERE id/.test(sql)) return { rows: [{ ...state.provider }] };
  if (/FROM settings/.test(sql)) return { rows: [] };
  throw new Error(`Unexpected isolated DB query: ${sql}`);
} };
mock('models/database.js', { pool });
mock('logger.js', logger);
mock('config-loader.js', { gateway: { fourth_cache_breakpoint: false } });
mock('provider-lookup.js', { getCacheStatus: () => ({}), resetCacheStats: noop });
mock('middleware/auth.js', { requireAuth: (_req, _res, next) => next(), requireAdmin: (_req, _res, next) => next() });
mock('middleware/oauth-bearer.js', { oauthBearer(req, _res, next) {
  assert.equal(req.headers.authorization, 'Bearer isolated-signature-client');
  req.apiUser = { userId: 1, keyId: 1, username: 'isolated', keyName: 'isolated-key', balance: 100,
    signature: require('../utils/api-signature').resolveSignatureConfig({ user: state.user, key: state.key }),
    injectPrompt: '', fusionEnabled: false };
  next();
} });
mock('utils/trace-session.js', { recordEvent: asyncNoop });
mock('utils/billing.js', { calculateCost: () => ({ weightedTokens: 5, pointsCost: 1 }) });
mock('utils/quota-data.js', { recordQuotaData: noop, getUserQuotaBuffer: () => [] });
mock('utils/model-uptime.js', { recordModelCall: noop });
mock('utils/model-test.js', { recordLiveCallTest: noop });
mock('utils/error-records.js', { captureCallError: noop, clientIp: () => '127.0.0.1' });
mock('utils/notifications.js', { notifyUser: asyncNoop, NOTIFICATION_TYPES: {} });
mock('utils/points-deduct.js', { checkQuotaRules: async () => [], calculatePointsToDeduct: async () => 1 });
mock('utils/balance.js', { recordUsageAndDeduct: async record => {
  assert.match(record.usageQuery, /INSERT INTO usage_records/);
  const columns = record.usageQuery.match(/usage_records\s*\(([^)]+)\)/)[1].split(',').map(s => s.trim());
  state.usage.push(Object.fromEntries(columns.map((column, i) => [column, record.usageValues[i]])));
  return { ok: true, id: state.usage.length };
} });
// Deliberately DO NOT mock utils/api-signature.js or any of its finalizers.
mock('key-refresher.js', { ensureFreshKey: async () => 'isolated-upstream-key' });
mock('plugins/hooks.js', { hasSubscribers: () => false, apply: async () => ({}), applyStatsRecord: async () => ({}), applyFinalResponseHeaders: asyncNoop });
mock('fusion.js', { processFusion: async () => { throw new Error('Fusion outside fixture'); } });
mock('utils/secret-crypto.js', { decryptSecret: value => value });
mock('utils/crewrouter-command.js', { tryHandleCrewRouterCommand: async () => false });
mock('store/gemini-interactions.js', { RETENTION_DAYS: 55, newInteractionId: () => 'v1_signature_local', ensureInteractionTables: asyncNoop,
  createInteraction: async record => record.id, updateInteraction: asyncNoop, cleanupExpired: async () => 0,
  getInteraction: async () => null, deleteInteraction: async () => false, abortActive: () => false,
  isActive: () => false, registerActive: () => noop });
mock('utils/url-validator.js', { ...realUrlValidator, async validateUrl(input, options) {
  const url = new URL(input);
  assert.equal(url.origin, `http://127.0.0.1:${state.upstreamPort}`);
  return realUrlValidator.validateUrl(input, { ...options, allowedPrivateOrigins: [url.origin] });
} });
const originalLoad = Module._load;
const originalInterval = global.setInterval;
const originalConnect = net.Socket.prototype.connect;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return mocks.has(resolved) ? mocks.get(resolved) : originalLoad.call(this, request, parent, isMain);
};
global.setInterval = (...args) => { const timer = originalInterval(...args); intervals.add(timer); return timer; };
// Enforce at socket boundary as well as Axios, so fetch/proxy helpers cannot escape.
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const port = Number(typeof options === 'object' ? options.port : options);
  const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  assert.ok(state.ports.has(port) && ['127.0.0.1', 'localhost', undefined].includes(host), `Forbidden network ${host}:${port}`);
  return originalConnect.apply(this, args);
};
const interceptor = axios.interceptors.request.use(options => {
  const url = new URL(options.url);
  assert.equal(url.origin, `http://127.0.0.1:${state.upstreamPort}`);
  options.proxy = false;
  return options;
});
const frame = (value, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
function upstreamPayload(format) {
  const text = state.shape === 'empty' || state.shape === 'tool' ? '' : state.shape === 'json' ? '{"answer":1}' : 'ORIGINAL_BODY';
  if (format === 'anthropic') return { id: 'msg_local', type: 'message', role: 'assistant', model: 'local', content: state.shape === 'tool' ? [{ type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} }] : text ? [{ type: 'text', text }] : [], stop_reason: state.shape === 'tool' ? 'tool_use' : 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } };
  if (format === 'responses') return { id: 'resp_local', object: 'response', status: 'completed', model: 'local', output: state.shape === 'tool' ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' }] : text ? [{ type: 'message', id: 'msg_local', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] : [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
  if (format === 'gemini') return { responseId: 'gemini_local', candidates: [{ content: { role: 'model', parts: text ? [{ text }] : [] }, index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } };
  return { id: 'chat_local', object: 'chat.completion', model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(state.shape === 'tool' ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } : {}) }, finish_reason: state.shape === 'tool' ? 'tool_calls' : 'stop' }], usage };
}
function upstreamFrames(format, payload) {
  if (format === 'responses' && state.snapshotOnly) {
    const terminal = { ...payload, output_text: payload.output[0]?.content?.[0]?.text || '' };
    return (state.snapshotOnly === 'item' ? frame({ type: 'response.output_item.done', output_index: 0, item: payload.output[0] }, 'response.output_item.done') : '')
      + frame({ type: 'response.completed', response: terminal }, 'response.completed');
  }
  if (format === 'responses') return frame({ type: 'response.created', response: { ...payload, output: [], status: 'in_progress' } }, 'response.created')
    + frame({ type: 'response.output_item.added', output_index: 0, item: { ...payload.output[0], content: [] } }, 'response.output_item.added')
    + frame({ type: 'response.content_part.added', item_id: 'msg_local', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, 'response.content_part.added')
    + frame({ type: 'response.output_text.delta', item_id: 'msg_local', output_index: 0, content_index: 0, delta: payload.output[0]?.content?.[0]?.text || '' }, 'response.output_text.delta')
    + frame({ type: 'response.output_text.done', item_id: 'msg_local', output_index: 0, content_index: 0, text: payload.output[0]?.content?.[0]?.text || '' }, 'response.output_text.done')
    + frame({ type: 'response.output_item.done', output_index: 0, item: payload.output[0] }, 'response.output_item.done')
    + frame({ type: 'response.completed', response: payload }, 'response.completed');
  if (format === 'anthropic') return frame({ type: 'message_start', message: { ...payload, content: [], usage: { input_tokens: 2, output_tokens: 0 } } }, 'message_start')
    + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start')
    + frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: payload.content[0]?.text || '' } }, 'content_block_delta')
    + frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
    + frame({ type: 'message_delta', delta: { stop_reason: payload.stop_reason }, usage: { output_tokens: 3 } }, 'message_delta')
    + frame({ type: 'message_stop' }, 'message_stop');
  if (format === 'gemini') return frame({ ...payload, usageMetadata: undefined, candidates: payload.candidates.map(c => ({ ...c, finishReason: undefined })) })
    + frame({ ...payload, candidates: payload.candidates.map(c => ({ ...c, content: { role: 'model', parts: [] } })) });
  return frame({ id: 'chat_local', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: payload.choices[0].message.content, ...(payload.choices[0].message.tool_calls ? { tool_calls: payload.choices[0].message.tool_calls.map((tool, index) => ({ index, ...tool })) } : {}) }, finish_reason: null }] })
    + frame({ id: 'chat_local', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: payload.choices[0].finish_reason }], usage }) + 'data: [DONE]\n\n';
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; state.ports.add(port); return port; }
async function close(server) { if (!server?.listening) return; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
async function post(port, route, body, mode) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { Authorization: 'Bearer isolated-signature-client', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'x-crewrouter-signature-mode': mode } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers })); res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP fixture timed out'))); req.on('error', reject); req.end(raw);
  });
}
function requestBody(route, stream) {
  if (route.includes('/models/')) return { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
  if (route.includes('/interactions')) return { model: 'route-primary', input: 'hello', stream, store: false };
  if (route.endsWith('/responses')) return { model: 'route-primary', input: 'hello', stream };
  return { model: 'route-primary', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream };
}
async function main() {
  let gateway, upstream, passed = 0, failed = 0;
  try {
    const signature = require('../utils/api-signature');
    assert.equal(require.cache[require.resolve('../utils/api-signature')].exports, signature);
    assert.equal(mocks.has(require.resolve('../utils/api-signature')), false);
    const router = require('../routes/api');
    const gemini = require('../routes/gemini');
    global.setInterval = originalInterval;
    upstream = http.createServer((req, res) => {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        const body = JSON.parse(raw); state.received.push({ path: req.url, body });
        const format = req.url.includes('/responses') ? 'responses' : req.url.includes('/messages') ? 'anthropic' : req.url.includes('GenerateContent') || req.url.includes('generateContent') ? 'gemini' : 'openai';
        const payload = upstreamPayload(format), stream = body.stream || req.url.includes('streamGenerateContent');
        res.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
        res.end(stream ? upstreamFrames(format, payload) : JSON.stringify(payload));
      });
    });
    state.upstreamPort = await listen(upstream);
    const app = express(); app.use(express.json()); app.use('/v1', router); app.use('/v1beta', gemini);
    app.use((err, _req, res, _next) => res.headersSent ? res.destroy(err) : res.status(500).json({ error: err.message }));
    gateway = http.createServer(app); const port = await listen(gateway);
    async function run(name, { format = 'openai', route = '/v1/chat/completions', stream = false, mode = 'both', enabled = true, template = 'SIGNATURE_SENTINEL {tokens}', keyEnabled = null, keyTemplate = null, shape = 'text', structured = false, snapshotOnly = false } = {}) {
      try {
        state.user = { api_signature_enabled: enabled, api_signature_template: template };
        state.key = { signature_enabled: keyEnabled, signature_template: keyTemplate };
        state.provider = { id: 'local-provider', name: 'isolated', enabled: true, format, base_url: `http://127.0.0.1:${state.upstreamPort}${format === 'gemini' ? '/v1beta' : '/v1'}`, api_key: 'isolated-upstream-key', api_keys: ['isolated-upstream-key'], proxy_enabled: false };
        state.shape = shape; state.snapshotOnly = snapshotOnly; state.usage = []; state.errors = [];
        const body = requestBody(route, stream);
        if (structured) {
          if (route.includes('/models/')) body.generationConfig = { responseMimeType: 'application/json' };
          else if (route.endsWith('/responses')) body.text = { format: { type: 'json_object' } };
          else body.response_format = { type: 'json_object' };
        }
        const out = await post(port, route, body, mode);
        assert.equal(out.status, 200, `${out.text}\n${state.errors.join('\n')}`);
        // Body text is checked on the wire, not through mocked finalizer calls.
        const effective = signature.resolveSignatureConfig({ key: state.key, user: state.user });
        const expected = await signature.buildSignature({ template: effective.template, meta: { promptTokens: 2, completionTokens: 3 } });
        const inject = effective.enabled && !!expected;
        const append = inject && mode !== 'header' && !structured && shape === 'text';
        assert.equal(out.text.includes('SIGNATURE_SENTINEL') || out.text.includes('中文签名'), append, `${name}: content mode/skip mismatch: ${out.text}`);
        if (append) assert.ok(out.text.includes(expected), `${name}: rendered signature values must match original usage`);
        if (shape === 'text') assert.match(out.text, /ORIGINAL_BODY/, `${name}: keep original upstream content`);
        const header = out.headers['x-crewrouter-signature'] || (out.headers['x-crewrouter-signature-b64'] && Buffer.from(out.headers['x-crewrouter-signature-b64'], 'base64').toString('utf8'));
        assert.equal(!!header, !stream && inject && mode !== 'content', `${name}: header mismatch ${JSON.stringify(out.headers)}`);
        if (header) { assert.equal(header, expected); assert.match(out.headers['access-control-expose-headers'], /X-CrewRouter-Signature/); }
        if (!stream && template.startsWith('中文') && mode !== 'content') assert.ok(out.headers['x-crewrouter-signature-b64']);
        assert.ok(state.usage.length, `${name}: must record billing, errors: ${state.errors.join('\n')}`);
        for (const record of state.usage) {
          assert.equal(record.tokens_used, 5, `${name}: original token accounting`);
          assert.equal(record.prompt_tokens, 2); assert.equal(record.completion_tokens, 3);
          assert.doesNotMatch(JSON.stringify(record), /SIGNATURE_SENTINEL|中文签名/, `${name}: signature leaked into usage_records`);
        }
        if (snapshotOnly) {
          const events = out.text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
          const terminal = events.find(event => event.type === 'response.completed').response;
          const expectedText = `ORIGINAL_BODY${append ? `\n\n${expected}` : ''}`;
          assert.equal(terminal.output_text, expectedText);
          assert.equal(terminal.output[0].content[0].text, expectedText);
          assert.equal(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), expectedText);
          assert(state.usage.some(record => record.response === 'ORIGINAL_BODY'), 'snapshot text must enter clean history');
        }
        passed++; console.log(`PASS ${name}`);
      } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
    const paths = [
      ['Chat OpenAI', 'openai', '/v1/chat/completions'],
      ['Chat Anthropic upstream', 'anthropic', '/v1/chat/completions'],
      ['Messages OpenAI upstream', 'openai', '/v1/messages'],
      ['Messages Anthropic', 'anthropic', '/v1/messages'],
      ['Responses native', 'responses', '/v1/responses'],
      ['Responses converted OpenAI', 'openai', '/v1/responses'],
      ['Responses converted Anthropic', 'anthropic', '/v1/responses'],
      ['Gemini native', 'gemini', '/v1beta/models/route-primary:generateContent'],
      ['Gemini Bridge OpenAI', 'openai', '/v1beta/models/route-primary:generateContent'],
      ['Interactions Bridge', 'openai', '/v1beta/interactions']
    ];
    for (const [name, format, endpoint] of paths) for (const stream of [false, true]) for (const mode of ['header', 'content', 'both']) {
      const route = stream ? endpoint.replace(':generateContent', ':streamGenerateContent?alt=sse') : endpoint;
      await run(`${name} stream=${stream} mode=${mode}`, { format, route, stream, mode });
    }
    for (const stream of [false, true]) {
      await run(`default disabled stream=${stream}`, { stream, enabled: false });
      await run(`user empty stream=${stream}`, { stream, template: '' });
      await run(`Key force off stream=${stream}`, { stream, keyEnabled: false });
      await run(`Key force on stream=${stream}`, { stream, enabled: false, keyEnabled: true }); // Legacy per-Key force-on is suppressed by the user master switch.
      await run(`Key inherit switch custom template stream=${stream}`, { stream, keyTemplate: 'SIGNATURE_SENTINEL Key {tokens}' });
      await run(`Chinese base64 stream=${stream}`, { stream, template: '中文签名 {tokens}' });
      await run(`JSON structured skip stream=${stream}`, { stream, shape: 'json', structured: true });
      await run(`tool-only skip stream=${stream}`, { stream, shape: 'tool' });
      await run(`empty-body skip stream=${stream}`, { stream, shape: 'empty' });
      await run(`Key empty template inherits user stream=${stream}`, { stream, keyTemplate: '' });
      await run(`Key inherits disabled switch despite override stream=${stream}`, { stream, enabled: false, keyTemplate: 'SIGNATURE_SENTINEL Key {tokens}' });
    }
    for (const snapshotOnly of ['item', 'terminal']) for (const enabled of [true, false]) {
      await run(`Responses snapshot-only ${snapshotOnly} enabled=${enabled}`, {
        format: 'responses', route: '/v1/responses', stream: true, snapshotOnly, enabled,
      });
    }
    console.log(`Signature HTTP: ${passed} passed, ${failed} failed. Real api.js/gemini routes and signature module; isolated auth/DB/billing/upstream.`);
    if (failed) process.exitCode = 1;
  } finally {
    await Promise.all([close(gateway), close(upstream)]);
    for (const timer of intervals) clearInterval(timer);
    axios.interceptors.request.eject(interceptor);
    Module._load = originalLoad; global.setInterval = originalInterval; net.Socket.prototype.connect = originalConnect;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
