'use strict';

// 执行实际四条 Fusion 函数和实际统一签名入口；仅隔离网络/数据库/日志。
// node --test server/scripts/test-signature-fusion.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const logger = { info() {}, warn() {}, error() {}, stream() {} };
const root = path.join(__dirname, '..');

function loadActual(file, mocks, extra = '') {
  const context = {
    module: { exports: {} }, console, Buffer, TextDecoder, AbortSignal,
    require(name) {
      assert(Object.hasOwn(mocks, name), `未预期依赖 ${name}`);
      return mocks[name];
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8') + extra, context, { filename: file });
  return context.module.exports;
}

const signatures = loadActual('utils/api-signature.js', {
  '../models/database': { pool: { query() { throw new Error('测试不可访问数据库'); } } },
  './quota-data': {}, '../logger': logger, '../proxy-pool': {}
});
const normalize = loadActual('utils/openai-response-normalize.js', { '../logger': logger });
const names = [
  'streamOpenAISynthesis', 'streamOpenAIToAnthropicSynthesis',
  'streamAnthropicSynthesis', 'streamAnthropicToOpenAISynthesis'
];
const frame = obj => `data: ${JSON.stringify(obj)}\n\n`;
const oaChoice = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const oaUsage = { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } };

function upstream(anthropic, { text = '正文', tool = false, sameFrame = false, stopReason } = {}) {
  if (!anthropic) {
    const delta = tool ? { tool_calls: [{ index: 0, id: 'tool_1', function: { name: 'lookup', arguments: '{}' } }] } : { content: text };
    const reason = stopReason || (tool ? 'tool_calls' : 'stop');
    return (sameFrame ? frame(oaChoice(delta, reason)) : frame(oaChoice(delta)) + frame(oaChoice({}, reason)))
      + frame({ choices: [], usage: oaUsage }) + 'data: [DONE]\n\n';
  }
  const reason = stopReason || (tool ? 'tool_use' : 'end_turn');
  return [
    { type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 2 } } },
    { type: 'content_block_start', index: 1, content_block: tool ? { type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }
  ].map(frame).join('');
}

async function run(name, settings = {}) {
  const anthropic = name.startsWith('streamAnthropic');
  const req = new EventEmitter();
  req.body = settings.body || {};
  req.headers = settings.header ? { 'x-crewrouter-signature-mode': 'header' } : {};
  req.apiUser = { signature: { enabled: settings.enabled !== false, template: 'SIG {tokens} {cached_tokens}' } };
  req._signaturePreloadPromise = Promise.resolve({});
  const writes = [];
  const res = {
    req, writableEnded: false, destroyed: false,
    write(value) {
      assert(!this.writableEnded && !this.destroyed, '不能向关闭响应写入');
      writes.push(value);
      if (settings.disconnectOnWrite) req.emit('close');
      return true;
    },
    end() { this.writableEnded = true; }
  };
  let raw = settings.raw ?? upstream(anthropic, settings);
  if (settings.noFinalNewline) raw = raw.trimEnd();
  const bytes = Buffer.from(raw);
  // 逐字节切片同时验证 UTF-8 解码和 SSE 跨 chunk 残余。
  const parts = settings.fragmented ? Array.from(bytes, b => Buffer.from([b])) : [bytes];
  let reads = 0;
  let cancelled = false;
  let released = false;
  let calls = 0;
  const fn = loadActual('fusion/synthesizer.js', {
    '../logger': logger,
    '../utils/quota-request-context': { quotaFetch: async () => ({
      ok: settings.httpError !== true, status: 500, text: async () => 'upstream unavailable',
      body: { getReader: () => ({
        async read() {
          if (reads < parts.length) return { done: false, value: parts[reads++] };
          if (settings.disconnectAtEOF) req.emit('close');
          if (settings.readError) throw Object.assign(new Error('upstream interrupted'), { name: settings.readError });
          return { done: true };
        },
        async cancel() { cancelled = true; }, releaseLock() { released = true; }
      }) }
    }) },
    '../utils/request-lifecycle': { combineAbortSignals: () => undefined },
    '../utils/request-policy': { buildAuthHeaders: () => ({}) },
    '../utils/url-validator': { upstreamUrl: (base, suffix) => base + suffix },
    '../utils/api-signature': { finalizeStreamSignature: async (...args) => {
      calls++;
      if (settings.disconnectDuringSignature || settings.abortDuringSignature) {
        req._signaturePreloadPromise = Promise.resolve().then(() => {
          if (settings.disconnectDuringSignature) req.emit('close');
          if (settings.abortDuringSignature) settings.options.signalController.abort();
          return {};
        });
      }
      return signatures.finalizeStreamSignature(...args);
    } },
    '../utils/openai-response-normalize': normalize
  }, `\nmodule.exports = { ${names.join(', ')} };`)[name];
  const options = { ...settings.options };
  if (options.signalController) options.signal = options.signalController.signal;
  if (settings.httpError) {
    await assert.rejects(fn('https://mock.invalid', { api_key: 'test' }, 'fusion-test', [], res, options), /上游调用失败/);
    assert.equal(writes.length, 0);
    assert.equal(calls, 0);
    return {};
  }
  const result = await fn('https://mock.invalid', { api_key: 'test' }, 'fusion-test', [], res, options);
  assert(cancelled && released, 'reader 应取消并释放');
  assert.equal(req.listenerCount('close'), 0, '关闭监听器应清理');
  assert(Number.isFinite(result.latency), '返回有限 latency');
  const output = writes.join('');
  const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => {
    const data = line.slice(6);
    return data === '[DONE]' ? data : JSON.parse(data);
  });
  return { output, events, result: JSON.parse(JSON.stringify(result)), calls, res };
}

for (const name of names) {
  const anthropic = name.startsWith('streamAnthropic');
  const outputAnthropic = name === 'streamAnthropicSynthesis' || name === 'streamOpenAIToAnthropicSynthesis';
  test(`${name}: 正文后签名先于终止，返回正文及 usage 无污染（含分片与 EOF 残余）`, async () => {
    const { events, result, calls } = await run(name, { fragmented: true, noFinalNewline: true, sameFrame: true });
    assert.equal(result.content, '正文');
    assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 3, cachedTokens: 2 });
    assert.equal(calls, 1);
    const sig = events.findIndex(e => (e.delta?.text || e.choices?.[0]?.delta?.content || '').includes('SIG 10 tokens 2'));
    assert(sig > 0, '签名须在正文之后');
    if (outputAnthropic) {
      assert(!events.some(e => e.type === 'content_block_start'), '不能新建纯签名块');
      assert(events.filter(e => e.type === 'content_block_delta').every(e => e.index === 0));
      assert(sig < events.findIndex(e => e.type === 'content_block_stop'));
      assert(sig < events.findIndex(e => e.type === 'message_delta'));
      assert.equal(events.at(-1).type, 'message_stop');
      assert.equal(events.find(e => e.type === 'message_delta').usage.output_tokens, 3);
    } else {
      assert(sig < events.findIndex(e => e.choices?.[0]?.finish_reason != null));
      assert(sig < events.indexOf('[DONE]'));
      assert.equal(events.at(-1), '[DONE]');
      assert.equal(events.filter(e => e === '[DONE]').length, 1);
      assert.equal(events.findLast(e => e.usage)?.usage.completion_tokens, 3);
      assert.equal(events.filter(e => e.usage).length, 1, 'usage 只能发一次，不能把签名计入');
    }
  });
  for (const [label, settings] of [
    ['header', { header: true }], ['关闭', { enabled: false }],
    ['空正文', { text: '' }], ['tool-only', { tool: true }],
    ['json_object', { body: { response_format: { type: 'json_object' } } }],
    ['json_schema 选项', { options: { response_format: { type: 'json_schema' } } }],
    ['Responses JSON 设置', { body: { text: { format: { type: 'json_schema' } } } }]
  ]) {
    test(`${name}: ${label} 不追加签名`, async () => {
      const { output, result } = await run(name, settings);
      assert(!output.includes('SIG '));
      assert(!result.content.includes('SIG '));
    });
  }
  for (const [label, settings] of [
    ['读取异常', { readError: 'Error' }], ['上游超时', { readError: 'TimeoutError' }],
    ['上游 abort', { readError: 'AbortError' }], ['客户端断开', { disconnectAtEOF: true }],
    ['正文写出后断开', { disconnectOnWrite: true }], ['签名生成时断开', { disconnectDuringSignature: true }],
    ['签名生成时取消', { abortDuringSignature: true, options: { signalController: new AbortController() } }]
  ]) {
    test(`${name}: ${label} 不追加签名`, async () => {
      const { output } = await run(name, settings);
      assert(!output.includes('SIG '));
      assert(!output.includes('[DONE]') && !output.includes('message_stop'), '中断不得伪装正常结束');
    });
  }
  const raw = upstream(anthropic);
  for (const [label, bad] of [
    ['无终止事件 EOF', anthropic ? raw.slice(0, raw.indexOf('data: {"type":"message_delta"')) : frame(oaChoice({ content: '正文' }))],
    ['错误事件', raw + (anthropic ? 'event: error\ndata: {"type":"error","error":{"message":"failed"}}\n\n' : frame({ error: { message: 'failed' } }))],
    ['破损残余', raw + 'data: {"broken"'],
    ['无 data 的 SSE 错误', raw + 'event: error\n\n'],
    ['未识别原始残片', raw + 'unexpected raw fragment'],
    ['终止后的非法正文', raw + (anthropic ? frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'bad' } }) : frame(oaChoice({ content: 'bad' })))]
  ]) {
    test(`${name}: ${label} 不签名、不透传原始残片`, async () => {
      const { output, calls } = await run(name, { raw: bad });
      assert(!output.includes('SIG '));
      assert(!output.includes('broken'));
      assert.equal(calls, 0);
    });
  }
  test(`${name}: CRLF、多行 data 与注释正常解析`, async () => {
    const raw = upstream(anthropic).replace('data: {', ': heartbeat\nretry: 1000\ndata: {\ndata: ').replace(/\n/g, '\r\n');
    const { output, result } = await run(name, { raw });
    assert(output.includes('SIG 10 tokens 2'));
    assert.equal(result.content, '正文');
  });
  test(`${name}: HTTP 错误不签名`, async () => { await run(name, { httpError: true }); });
}

test('Anthropic 两路径签名不依赖 output_tokens 非零，且计入 text block 初始正文', async () => {
  for (const name of ['streamAnthropicSynthesis', 'streamAnthropicToOpenAISynthesis']) {
    const raw = upstream(true, { text: '' })
      .replace('"content_block":{"type":"text","text":""}', '"content_block":{"type":"text","text":"初始正文"}')
      .replace('"output_tokens":3', '"output_tokens":0');
    const { output, result } = await run(name, { raw });
    assert.equal(result.content, '初始正文');
    assert.equal(result.usage.completionTokens, 0);
    assert(output.includes('SIG 7 tokens 2'));
  }
});

test('Anthropic 两路径拒绝未闭合或错 index 的 block，即使收到 message_stop', async () => {
  for (const name of ['streamAnthropicSynthesis', 'streamAnthropicToOpenAISynthesis']) {
    for (const raw of [
      upstream(true).replace(frame({ type: 'content_block_stop', index: 1 }), ''),
      upstream(true).replace('"type":"content_block_stop","index":1', '"type":"content_block_stop","index":2')
    ]) {
      const { output, calls } = await run(name, { raw });
      assert(!output.includes('SIG '));
      assert.equal(calls, 0);
    }
  }
});

test('OpenAI 两路径仅 finish_reason 正常 EOF 也签名，但 finish 后错误不得签名', async () => {
  for (const name of ['streamOpenAISynthesis', 'streamOpenAIToAnthropicSynthesis']) {
    const raw = upstream(false).replace('data: [DONE]\n\n', '');
    assert((await run(name, { raw })).output.includes('SIG 10 tokens 2'));
    assert(!(await run(name, { raw: raw + frame({ error: { message: 'failed' } }) })).output.includes('SIG '));
  }
});

test('Anthropic 两路径保留 max_tokens stop reason 而非由 usage 猜测', async () => {
  for (const name of ['streamAnthropicSynthesis', 'streamAnthropicToOpenAISynthesis']) {
    const { events } = await run(name, { stopReason: 'max_tokens' });
    if (name === 'streamAnthropicSynthesis') assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'max_tokens');
    else assert.equal(events.find(e => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'length');
  }
});
