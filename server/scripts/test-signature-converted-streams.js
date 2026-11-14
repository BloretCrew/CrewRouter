'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
const core = { exports: {} };
const Logger = { info() {}, warn() {}, error() {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/api-signature.js'), 'utf8'), {
  module: core, Buffer, require(id) {
    if (id === '../models/database') return { pool: {} };
    if (id === '../logger') return Logger;
    return {};
  }
});
function load(name) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, {
    Date, TextDecoder, Logger,
    finalizeStreamSignature: core.exports.finalizeStreamSignature,
    normalizeUsageTokens: require('../utils/token-normalize').normalizeUsageTokens,
    wireShapes: require('../protocol/wire-shapes'),
    pluginHooks: { hasSubscribers() { return false; } },
    markActiveToken() {}, markActiveFirstByte() {},
    mediaPlaceholder() { return '[image]'; }
  });
}
function upstreamEvents(format, tool) {
  if (format === 'openai') {
    const events = [{ choices: [{ delta: { content: 'hello' } }] }];
    if (tool) events.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool_1', function: { name: 'lookup', arguments: '{}' } }] } }] });
    events.push({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    return events;
  }
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 }
  ];
  if (tool) events.push(
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 1 }
  );
  events.push({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
  return events;
}
for (const [format, name] of [['openai', 'streamOpenAIAsResponses'], ['anthropic', 'streamAnthropicAsResponses']]) {
  for (const tool of [false, true]) {
    for (const mode of ['both', 'header']) {
      test(`${name}: tool=${tool}, mode=${mode} 正文与结束快照一致且入库不含签名`, async () => {
        const wire = upstreamEvents(format, tool).map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + (format === 'openai' ? 'data: [DONE]\n\n' : '');
        let sent = false;
        const reader = { async read() { if (sent) return { done: true }; sent = true; return { value: new TextEncoder().encode(wire), done: false }; }, async cancel() {}, releaseLock() {} };
        const output = [];
        const req = { body: {}, headers: { 'x-crewrouter-signature-mode': mode }, apiUser: { signature: { enabled: true, template: '签名 {tokens}' } } };
        const result = await load(name)(reader, new TextDecoder(), { once() {} }, req, 'resp_test', 'model', req.body, async data => output.push(data), async () => {});
        assert.equal(result.content, 'hello');
        assert.equal(result.completionTokens, 2);
        const frames = output.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        const doneIndex = frames.findIndex(e => e.type === 'response.output_text.done');
        const expected = mode === 'both' ? 'hello\n\n签名 5 tokens' : 'hello';
        assert.equal(frames[doneIndex].text, expected);
        assert.equal(frames.at(-1).response.output_text, expected);
        assert.equal(frames.at(-1).response.output.find(o => o.type === 'message').content[0].text, expected);
        if (mode === 'both') {
          const sigIndex = frames.findIndex(e => e.type === 'response.output_text.delta' && e.delta.includes('签名'));
          assert(sigIndex >= 0 && sigIndex < doneIndex);
        }
      });
    }
  }
}
