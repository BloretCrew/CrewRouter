'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createSSEParser, formatSSE } = require('../protocol/sse');
const normalize = require('../utils/token-normalize');
const scrub = require('../utils/inject-prompt-stream');
const logger = { info() {}, warn() {}, error() {} };
function loadModule(name, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils', name), 'utf8'), {
    module, Buffer, TextDecoder, AbortSignal, require(id) {
      assert(Object.hasOwn(mocks, id), `unexpected dependency ${id}`);
      return mocks[id];
    }
  });
  return module.exports;
}
const signature = loadModule('api-signature.js', {
  '../models/database': { pool: { query() { throw new Error('Unexpected DB query'); } } },
  './quota-data': {}, '../logger': logger, '../proxy-pool': {}
});
const { relaySignatureStream } = loadModule('signature-stream-relay.js', {
  '../protocol/sse': { createSSEParser, formatSSE }, './api-signature': signature,
  './inject-prompt-stream': scrub, './token-normalize': normalize,
  './inject-prompt-scrub': require('../utils/inject-prompt-scrub'), '../logger': logger
});
function responseEvents() {
  return [
    { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hello' },
    { type: 'response.output_text.done', sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, text: 'hello' },
    { type: 'response.content_part.done', sequence_number: 3, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'hello' } },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'hello' }] } },
    { type: 'response.completed', sequence_number: 5, response: { output_text: 'hello', output: [{ id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 3, output_tokens: 2 } } }
  ];
}
function anthropicEvents() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' }
  ];
}
async function fixture(format, { mode = 'both', body = {}, enabled = true, template = '签名 {tokens}', events, fragmented = false } = {}) {
  const list = events || (format === 'responses' ? responseEvents() : anthropicEvents());
  const wire = list.map(data => formatSSE({ event: data.type, data })).join('');
  const bytes = new TextEncoder().encode(wire);
  const chunks = fragmented ? [...bytes].map(byte => Uint8Array.of(byte)) : [bytes];
  let released = false;
  const reader = { async read() { return chunks.length ? { value: chunks.shift(), done: false } : { done: true }; }, async cancel() {}, releaseLock() { released = true; } };
  const req = { headers: { 'x-crewrouter-signature-mode': mode }, body,
    apiUser: { signature: { enabled, template } } };
  const res = { writableEnded: false, destroyed: false };
  const output = [];
  const relay = await relaySignatureStream({ response: { body: { getReader: () => reader } }, req, res, format, model: 'fixture', write: data => { output.push(data); } });
  assert.equal(relay.content, 'hello');
  assert.equal(released, true);
  const before = output.join('');
  await relay.finish();
  const parser = createSSEParser();
  const data = parser.push(output.join('')).concat(parser.end()).filter(frame => !frame.done).map(frame => {
    const event = JSON.parse(frame.data);
    assert.equal(frame.event, event.type, 'named SSE frame must match data.type');
    return event;
  });
  return { data, relay, before };
}
test('relay rewrite: 异步插件可改写/丢弃正文，metrics仍观察原始事件', async () => {
  const observed = [];
  const events = anthropicEvents();
  events.splice(3, 0, { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'DROP_SECRET' } });
  const f = await relayCase('anthropic', {
    events, onEvent: data => { observed.push(data.delta?.text); },
    async rewriteEvent(data) {
      await Promise.resolve();
      if (data.delta?.text === 'DROP_SECRET') return null;
      return data.type === 'content_block_delta' ? { ...data, delta: { ...data.delta, text: 'REDACTED' } } : data;
    }
  });
  await f.relay.finish();
  assert(observed.includes('hello'));
  assert(observed.includes('DROP_SECRET'));
  assert.equal(f.relay.content, 'REDACTED');
  assert(!f.output.join('').includes('DROP_SECRET'));
  assert(!f.output.join('').includes('hello'));
  const text = f.data().filter(e => e.type === 'content_block_delta').map(e => e.delta.text).join('');
  assert.equal(text, 'REDACTED\n\nSIG');
  assert.equal(f.data().at(-1).type, 'message_stop');
});

test('relay rewrite: 全部正文被drop不追加签名，插件异常不得成功结束', async () => {
  const f = await relayCase('anthropic', {
    events: anthropicEvents(), rewriteEvent: async data => data.type === 'content_block_delta' ? null : data,
  });
  await f.relay.finish();
  assert.equal(f.relay.content, '');
  assert(!f.output.join('').includes('SIG'));
  assert.equal(f.data().at(-1).type, 'message_stop');
  await assert.rejects(relayCase('anthropic', { events: anthropicEvents(), rewriteEvent: async () => { throw new Error('plugin failed'); } }), /plugin failed/);
});

for (const source of ['item', 'terminal']) {
  test(`relay snapshot-only ${source}: 恢复正文delta和生命周期，签名不污染历史与usage`, async () => {
    const one = textItem('msg_1', ['first']);
    const two = textItem('msg_2', ['second']);
    const terminal = { ...completed([one, two]), sequence_number: 8 };
    terminal.response.output_text = 'firstsecond';
    const events = source === 'item' ? [
      { type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: { id: 'msg_1', type: 'message', content: [] } },
      { type: 'response.content_part.added', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: one },
      { type: 'response.output_item.done', sequence_number: 3, output_index: 1, item: two }, terminal,
    ] : [terminal];
    const f = await relayCase('responses', { events });
    assert.equal(f.relay.content, 'firstsecond');
    await f.relay.finish();
    const data = f.data();
    const deltas = data.filter(e => e.type === 'response.output_text.delta');
    assert.equal(deltas.map(e => e.delta).join(''), 'firstsecond\n\nSIG');
    const out = data.at(-1).response;
    assert.equal(out.output_text, 'firstsecond\n\nSIG');
    assert.equal(out.output[0].content[0].text, 'first');
    assert.equal(out.output[1].content[0].text, 'second\n\nSIG');
    assert.equal(out.usage.input_tokens, 3);
    assert.equal(out.usage.output_tokens, 2);
    assert.equal(f.relay.content, 'firstsecond');
    for (const id of ['msg_1', 'msg_2']) {
      assert.equal(data.filter(e => e.type === 'response.output_item.added' && e.item.id === id).length, 1);
      assert.equal(data.filter(e => e.type === 'response.output_item.done' && e.item.id === id).length, 1);
      const start = data.findIndex(e => e.type === 'response.content_part.added' && e.item_id === id);
      const delta = data.findIndex(e => e.type === 'response.output_text.delta' && e.item_id === id);
      const done = data.findIndex(e => e.type === 'response.output_text.done' && e.item_id === id);
      assert(start < delta && delta < done);
    }
    const seq = data.map(e => e.sequence_number);
    assert(seq.every((value, index) => index === 0 || value > seq[index - 1]));
  });
}

test('relay snapshot-only: 净化快照且关闭签名不清空正文', async () => {
  const secret = '<system-reminder>PRIVATE_NOTE</system-reminder>';
  const item = textItem('msg_1', [secret + '\nhello']);
  const terminal = completed([item]);
  terminal.response.output_text = secret + '\nhello';
  const f = await relayCase('responses', { enabled: false, injectPrompt: secret, events: [terminal] });
  await f.relay.finish();
  assert.match(f.relay.content, /hello/);
  assert(!f.output.join('').includes('PRIVATE_NOTE'));
  assert(!f.output.join('').includes('SIG'));
  assert.equal(f.data().at(-1).response.output_text, f.relay.content);
});

test('relay snapshot-only: 没有可恢复message时保留output_text而非强制清空', async () => {
  const event = { type: 'response.completed', response: { output: [], output_text: 'snapshot', usage: { output_tokens: 1 } } };
  const f = await relayCase('responses', { events: [event] });
  await f.relay.finish();
  assert.equal(f.data().at(-1).response.output_text, 'snapshot');
  assert(!f.output.join('').includes('SIG'));
});

for (const format of ['anthropic', 'responses']) {
  test(`${format}: 签名先于文本/消息终态，返回正文与用量保持干净`, async () => {
    const { data, relay, before } = await fixture(format, { fragmented: true });
    assert.equal(relay.content, 'hello');
    assert(!before.includes('签名'));
    const sigIndex = data.findIndex(event => JSON.stringify(event).includes('签名'));
    assert(sigIndex >= 0);
    if (format === 'anthropic') {
      assert(data.findIndex(e => e.type === 'content_block_stop') > sigIndex);
      assert(data.findIndex(e => e.type === 'message_delta') > sigIndex);
      assert.equal(data.filter(e => e.type === 'content_block_start').length, 1);
    } else {
      assert(data.findIndex(e => e.type === 'response.output_text.done') >= sigIndex);
      assert.equal(data.find(e => e.type === 'response.output_text.done').text, 'hello\n\n签名 5 tokens');
      assert.equal(data.at(-1).response.output[0].content[0].text, 'hello\n\n签名 5 tokens');
      assert.equal(data.at(-1).response.usage.output_tokens, 2);
      const numbers = data.map(e => e.sequence_number).filter(Number.isInteger);
      assert(numbers.every((n, i) => i === 0 || n > numbers[i - 1]));
    }
  });
  for (const scenario of [
    { mode: 'header' }, { enabled: false }, { template: '' },
    { body: { response_format: { type: 'json_schema' } } }
  ]) {
    test(`${format}: ${JSON.stringify(scenario)} 不追加签名`, async () => {
      const { data } = await fixture(format, scenario);
      assert(!JSON.stringify(data).includes('签名'));
    });
  }
  test(`${format}: 没有上游终态则报错且不追加`, async () => {
    const events = format === 'anthropic' ? anthropicEvents().slice(0, -1) : responseEvents().slice(0, -1);
    await assert.rejects(fixture(format, { events }), error => error.code === 'upstream_stream_incomplete');
  });
}

// 回归直接执行实际 relay、签名入口与净化器，仅隔离网络/数据库。
async function relayCase(format, { events = [], rawTail = '', injectPrompt, enabled = true, onWrite, onRead, preload, signal, rewriteEvent, onEvent } = {}) {
  const req = Object.assign(new EventEmitter(), {
    headers: {}, body: {}, apiUser: { signature: { enabled, template: 'SIG' }, injectPrompt },
    _signaturePreloadPromise: preload || Promise.resolve({})
  });
  if (signal) req._requestLifecycle = { signal };
  const res = { writableEnded: false, destroyed: false };
  const output = [];
  const wire = events.map(data => formatSSE({ event: data.type, data })).join('') + rawTail;
  let delivered = false;
  const reader = {
    async read() {
      await onRead?.({ req, res, delivered });
      if (delivered) return { done: true };
      delivered = true;
      return { done: false, value: new TextEncoder().encode(wire) };
    },
    async cancel() {}, releaseLock() {}
  };
  const relay = await relaySignatureStream({
    response: { body: { getReader: () => reader } }, req, res, format, model: 'fixture', rewriteEvent, onEvent,
    write: async chunk => { output.push(chunk); await onWrite?.({ req, res, output, chunk }); }
  });
  return {
    relay, req, res, output,
    data() {
      const parser = createSSEParser();
      return parser.push(output.join('')).concat(parser.end()).map(f => f.done ? '[DONE]' : JSON.parse(f.data));
    }
  };
}
const textItem = (id, texts) => ({ id, type: 'message', content: texts.map(text => ({ type: 'output_text', text })) });
function responsePart(id, outputIndex, contentIndex, text) {
  return [
    { type: 'response.output_text.delta', item_id: id, output_index: outputIndex, content_index: contentIndex, delta: text },
    { type: 'response.output_text.done', item_id: id, output_index: outputIndex, content_index: contentIndex, text },
    { type: 'response.content_part.done', item_id: id, output_index: outputIndex, content_index: contentIndex, part: { type: 'output_text', text } }
  ];
}
const completed = output => ({ type: 'response.completed', response: { output, usage: { input_tokens: 3, output_tokens: 2 } } });
const anthBlock = (index, text) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index }
];
const anthEnd = () => [
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' }
];

for (const format of ['anthropic', 'responses']) {
  test(`relay regression ${format}: 终态后的正文不得重排成成功响应`, async () => {
    const events = format === 'anthropic'
      ? [...anthropicEvents(), { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'late' } }]
      : [...responseEvents(), { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'late' }];
    await assert.rejects(async () => { const f = await relayCase(format, { events }); await f.relay.finish(); });
  });
  test(`relay regression ${format}: 终态后的破损 JSON 不能忽略并签名`, async () => {
    await assert.rejects(async () => {
      const f = await relayCase(format, { events: format === 'anthropic' ? anthropicEvents() : responseEvents(), rawTail: 'data: {"broken"' });
      await f.relay.finish();
    });
  });
  test(`relay regression ${format}: 无 data 的 error SSE 也应拒绝`, async () => {
    await assert.rejects(async () => {
      const f = await relayCase(format, { events: format === 'anthropic' ? anthropicEvents() : responseEvents(), rawTail: 'event: error\n\n' });
      await f.relay.finish();
    });
  });
  for (const state of ['close', 'aborted']) {
    test(`relay regression ${format}: req ${state} 后不再写入签名或终态`, async () => {
      const f = await relayCase(format, { events: format === 'anthropic' ? anthropicEvents() : responseEvents() });
      const before = f.output.length;
      if (state === 'close') f.req.emit('close');
      else f.req.aborted = true;
      try { await f.relay.finish(); } catch { /* 拒绝 finish 同样可接受 */ }
      assert.equal(f.output.length, before, 'res.destroyed 尚未更新时也不能继续写');
    });
  }
}

test('relay regression anthropic: 最后一文本块为空不能生成纯签名块', async () => {
  const f = await relayCase('anthropic', { events: [...anthBlock(0, 'first'), ...anthBlock(1, ''), ...anthEnd()] });
  await f.relay.finish();
  const sig = f.data().find(e => e.type === 'content_block_delta' && e.delta?.text.includes('SIG'));
  assert(!sig || sig.index === 0, '全局 content 非空不能给空块签名');
});

test('relay regression anthropic: text→tool 仍应在正文 stop 之前签名', async () => {
  const f = await relayCase('anthropic', { events: [
    ...anthBlock(0, 'hello'),
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } },
    { type: 'content_block_stop', index: 1 }, ...anthEnd()
  ] });
  await f.relay.finish();
  const events = f.data();
  const sig = events.findIndex(e => e.type === 'content_block_delta' && e.delta?.text?.includes('SIG'));
  assert(sig >= 0 && sig < events.findIndex(e => e.type === 'content_block_stop' && e.index === 0));
});

test('relay regression anthropic: 净化缓冲不能丢弃 text→tool 的正常正文', async () => {
  const f = await relayCase('anthropic', { enabled: false, injectPrompt: 'configured', events: [
    ...anthBlock(0, 'hello'),
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } },
    { type: 'content_block_stop', index: 1 }, ...anthEnd()
  ] });
  await f.relay.finish();
  assert.equal(f.relay.content, 'hello');
  assert.equal(f.data().filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), 'hello');
});

test('relay regression anthropic: 净化残余须保留各文本块归属', async () => {
  const f = await relayCase('anthropic', { enabled: false, injectPrompt: 'configured', events: [
    ...anthBlock(0, 'first'), ...anthBlock(1, 'second'), ...anthEnd()
  ] });
  await f.relay.finish();
  const text = index => f.data().filter(e => e.type === 'content_block_delta' && e.index === index).map(e => e.delta.text || '').join('');
  assert.equal(text(0), 'first');
  assert.equal(text(1), 'second');
});

test('relay regression responses: 多 part 的 message done 不得被最后 part 覆盖', async () => {
  const item = textItem('msg_1', ['first', 'second']);
  const f = await relayCase('responses', { events: [
    ...responsePart('msg_1', 0, 0, 'first'), ...responsePart('msg_1', 0, 1, 'second'),
    { type: 'response.output_item.done', output_index: 0, item }, completed([item])
  ] });
  await f.relay.finish();
  const events = f.data();
  assert.deepEqual(events.find(e => e.type === 'response.output_item.done').item.content.map(p => p.text), ['first', 'second\n\nSIG']);
  assert.deepEqual(events.at(-1).response.output[0].content.map(p => p.text), ['first', 'second\n\nSIG']);
});

test('relay regression responses: 前一 message 的 done 不得被后一 message 文本覆盖', async () => {
  const one = textItem('msg_1', ['first']);
  const two = textItem('msg_2', ['second']);
  const f = await relayCase('responses', { events: [
    ...responsePart('msg_1', 0, 0, 'first'), { type: 'response.output_item.done', output_index: 0, item: one },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_2', type: 'message', content: [] } },
    ...responsePart('msg_2', 1, 0, 'second'), { type: 'response.output_item.done', output_index: 1, item: two }, completed([one, two])
  ] });
  await f.relay.finish();
  const done = f.data().filter(e => e.type === 'response.output_item.done');
  assert.equal(done[0].item.content[0].text, 'first');
  assert.equal(done[1].item.content[0].text, 'second\n\nSIG');
});

test('relay regression responses: content_part.added 不得越过前一 part 的 pending done', async () => {
  const item = textItem('msg_1', ['first', 'second']);
  const f = await relayCase('responses', { events: [
    ...responsePart('msg_1', 0, 0, 'first'),
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 1, part: { type: 'output_text', text: '' } },
    ...responsePart('msg_1', 0, 1, 'second'), { type: 'response.output_item.done', output_index: 0, item }, completed([item])
  ] });
  await f.relay.finish();
  const events = f.data();
  assert(events.findIndex(e => e.type === 'response.content_part.done' && e.content_index === 0)
    < events.findIndex(e => e.type === 'response.content_part.added' && e.content_index === 1));
});

test('relay regression responses: 净化不能泄露之前 message 的 output_item.done 回显', async () => {
  const secret = '<system-reminder>\n# claudeMd\nPRIVATE_NOTE\n</system-reminder>';
  const one = textItem('msg_1', [secret + '\nfirst']);
  const two = textItem('msg_2', ['second']);
  const f = await relayCase('responses', { injectPrompt: secret, events: [
    ...responsePart('msg_1', 0, 0, secret + '\nfirst'), { type: 'response.output_item.done', output_index: 0, item: one },
    ...responsePart('msg_2', 1, 0, 'second'), { type: 'response.output_item.done', output_index: 1, item: two }, completed([one, two])
  ] });
  await f.relay.finish();
  assert(!f.output.join('').includes('PRIVATE_NOTE'), '所有 done 载荷均须净化，不只 terminal 或最后 text part');
});

test('relay regression responses: tool 不能越过之前文本 done', async () => {
  const one = textItem('msg_1', ['hello']);
  const call = { id: 'fc_1', type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{}' };
  const f = await relayCase('responses', { events: [
    ...responsePart('msg_1', 0, 0, 'hello'), { type: 'response.output_item.done', output_index: 0, item: one },
    { type: 'response.output_item.added', output_index: 1, item: call },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{}' },
    { type: 'response.output_item.done', output_index: 1, item: call }, completed([one, call])
  ] });
  await f.relay.finish();
  const events = f.data();
  assert(events.findIndex(e => e.type === 'response.output_item.done' && e.output_index === 0)
    < events.findIndex(e => e.type === 'response.output_item.added' && e.output_index === 1));
});

test('relay regression responses: 混合 tool 后的 sequence_number 必须递增', async () => {
  const one = textItem('msg_1', ['hello']);
  const call = { id: 'fc_1', type: 'function_call', name: 'lookup', arguments: '{}' };
  const events = [
    ...responsePart('msg_1', 0, 0, 'hello'), { type: 'response.output_item.done', output_index: 0, item: one },
    { type: 'response.output_item.added', output_index: 1, item: call },
    { type: 'response.output_item.done', output_index: 1, item: call }, completed([one, call])
  ].map((e, i) => ({ ...e, sequence_number: i + 1 }));
  const f = await relayCase('responses', { events });
  await f.relay.finish();
  const numbers = f.data().map(e => e.sequence_number);
  assert(numbers.every((n, i) => i === 0 || n > numbers[i - 1]), JSON.stringify(numbers));
});

test('relay regression responses: 写 DONE 前必须再次检查断开', async () => {
  const f = await relayCase('responses', {
    events: responseEvents(), rawTail: 'data: [DONE]\n\n',
    onWrite({ res, chunk }) { if (chunk.includes('event: response.completed')) res.destroyed = true; }
  });
  try { await f.relay.finish(); } catch { /* 终态后关闭应阻止 DONE */ }
  assert(!f.output.join('').includes('[DONE]'));
});

test('relay regression responses: 净化后的多个 part 不得全部残余落到最后 part', async () => {
  const item = textItem('msg_1', ['first', 'second']);
  const f = await relayCase('responses', { enabled: false, injectPrompt: 'configured', events: [
    ...responsePart('msg_1', 0, 0, 'first'), ...responsePart('msg_1', 0, 1, 'second'),
    { type: 'response.output_item.done', output_index: 0, item }, completed([item])
  ] });
  await f.relay.finish();
  const texts = index => f.data().filter(e => e.type === 'response.output_text.delta' && e.content_index === index).map(e => e.delta).join('');
  assert.equal(texts(0), 'first');
  assert.equal(texts(1), 'second');
  assert.equal(f.relay.content, 'firstsecond');
});

test('relay regression responses: 空的最终 part 不能生成纯签名', async () => {
  const item = textItem('msg_1', ['first', '']);
  const f = await relayCase('responses', { events: [
    ...responsePart('msg_1', 0, 0, 'first'), ...responsePart('msg_1', 0, 1, ''),
    { type: 'response.output_item.done', output_index: 0, item }, completed([item])
  ] });
  await f.relay.finish();
  const sig = f.data().find(e => e.type === 'response.output_text.delta' && e.delta.includes('SIG'));
  assert(!sig || sig.content_index === 0, '不能给空 part 写纯签名');
});

test('relay regression responses: content_part.added 初始文本也必须净化', async () => {
  const secret = '<system-reminder>\n# claudeMd\nPRIVATE_NOTE\n</system-reminder>';
  const item = textItem('msg_1', [secret + '\nhello']);
  const f = await relayCase('responses', { injectPrompt: secret, events: [
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: secret } },
    ...responsePart('msg_1', 0, 0, secret + '\nhello'),
    { type: 'response.output_item.done', output_index: 0, item }, completed([item])
  ] });
  await f.relay.finish();
  assert(!f.output.join('').includes('PRIVATE_NOTE'));
});

test('relay regression anthropic: delta 无对应开启 text block 时不得签名', async () => {
  await assert.rejects(async () => {
    const f = await relayCase('anthropic', { events: [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_delta', index: 99, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 99 }, ...anthEnd()
    ] });
    await f.relay.finish();
  });
});

test('relay regression responses: [DONE] 后正文无效', async () => {
  await assert.rejects(async () => {
    const f = await relayCase('responses', { events: responseEvents(), rawTail:
      'data: [DONE]\n\n' + formatSSE({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'late' } }) });
    await f.relay.finish();
  });
});

test('relay hardened anthropic: message_stop必须有stop_reason且匹配所有block关闭', async () => {
  for (const events of [
    anthropicEvents().filter(e => e.type !== 'content_block_stop'),
    anthropicEvents().map(e => e.type === 'message_delta' ? { ...e, delta: {} } : e),
    [...anthropicEvents().slice(0, -1), { type: 'content_block_start', index: 9, content_block: { type: 'text', text: '' } }, { type: 'message_stop' }]
  ]) await assert.rejects(relayCase('anthropic', { events }));
});

test('relay hardened responses: incomplete保留终态且签名只进最后非空part', async () => {
  const events = responseEvents();
  events.at(-1).type = 'response.incomplete';
  events.at(-1).response.status = 'incomplete';
  const f = await relayCase('responses', { events });
  await f.relay.finish();
  assert.equal(f.data().at(-1).type, 'response.incomplete');
  assert.equal(f.relay.content, 'hello');
  assert.equal(f.relay.usage.output_tokens, 2);
  assert.equal(f.data().at(-1).response.output[0].content[0].text, 'hello\n\nSIG');
});

test('relay hardened responses: 净化后末part完全为空时签在前一非空part', async () => {
  const secret = '<system-reminder>\n# claudeMd\nPRIVATE_NOTE\n</system-reminder>';
  const item = textItem('msg_1', ['hello', secret]);
  const f = await relayCase('responses', { injectPrompt: secret, events: [
    ...responsePart('msg_1', 0, 0, 'hello'), ...responsePart('msg_1', 0, 1, secret),
    { type: 'response.output_item.done', output_index: 0, item }, completed([item])
  ] });
  await f.relay.finish();
  assert.equal(f.relay.content, 'hello');
  assert.deepEqual(f.data().at(-1).response.output[0].content.map(p => p.text), ['hello\n\nSIG', '']);
  assert(!f.output.join('').includes('PRIVATE_NOTE'));
});

for (const format of ['anthropic', 'responses']) {
  test(`relay hardened ${format}: 签名异步生成期间断开禁止后续写`, async () => {
    let resolvePreload;
    const preload = new Promise(resolve => { resolvePreload = resolve; });
    const f = await relayCase(format, { events: format === 'anthropic' ? anthropicEvents() : responseEvents(), preload });
    const before = f.output.length;
    const finishing = f.relay.finish();
    f.req.emit('close');
    resolvePreload({});
    await assert.rejects(finishing, /Client disconnected/);
    assert.equal(f.output.length, before);
    assert.equal(f.req.listenerCount('close'), 0);
  });
  test(`relay hardened ${format}: signal取消或上游读取异常不签名`, async () => {
    const signal = AbortSignal.abort();
    await assert.rejects(relayCase(format, { signal }), /Client disconnected/);
    await assert.rejects(relayCase(format, {
      events: format === 'anthropic' ? anthropicEvents() : responseEvents(),
      onRead({ delivered }) { if (delivered) throw new Error('socket reset'); }
    }), /socket reset/);
  });
  test(`relay hardened ${format}: finish不可重复且关闭监听器被清理`, async () => {
    const f = await relayCase(format, { events: format === 'anthropic' ? anthropicEvents() : responseEvents() });
    await f.relay.finish();
    const before = f.output.length;
    await assert.rejects(f.relay.finish(), /already finished/);
    assert.equal(f.output.length, before);
    assert.equal(f.req.listenerCount('close'), 0);
  });
  test(`relay hardened ${format}: tool-only空正文不生成签名`, async () => {
    const call = { id: 'fc_1', type: 'function_call', name: 'lookup', arguments: '{}' };
    const events = format === 'anthropic' ? [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} } },
      { type: 'content_block_stop', index: 0 }, ...anthEnd()
    ] : [{ type: 'response.output_item.added', output_index: 0, item: call }, { type: 'response.output_item.done', output_index: 0, item: call }, completed([call])];
    const f = await relayCase(format, { events });
    await f.relay.finish();
    assert.equal(f.relay.content, '');
    assert(!f.output.join('').includes('SIG'));
  });
}
