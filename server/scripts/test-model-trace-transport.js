'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { calculateCost } = require('../utils/billing');

async function main() {
  const originals = new Map();
  function mock(moduleName, exports) {
    const id = require.resolve(moduleName);
    originals.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const validator = require('../utils/url-validator');
  // Only this process permits its own loopback fixture; production validation is unchanged.
  let origin;
  mock('../utils/url-validator', { ...validator, validateUrl: async url => ({ ok: new URL(url).origin === origin }) });
  mock('../models/database', { pool: { query: async () => { throw new Error('Transport test must not query any database'); } } });
  mock('../logger', { info() {}, warn() {}, error() {} });
  const proxyPool = require('../proxy-pool');
  const originalGetProxyAgent = proxyPool.getProxyAgent;
  proxyPool.getProxyAgent = async () => null;
  const { transport, parseResponse } = require('../utils/model-trace-transport');
  const requests = [];
  let reply = {};
  let status = 200;
  let mode = 'json';
  let began;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (began) { began(); began = null; }
    if (mode === 'wait') return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (mode === 'oversize') return res.end('x'.repeat(256 * 1024 + 1));
    if (mode === 'disconnect') { res.write('{'); res.destroy(); return; }
    res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const key = 'fixture-private-credential';
  let marks = 0;
  async function send(protocol = 'openai', signal = AbortSignal.timeout(3000)) {
    return transport({ target: { protocol, upstream_model_id: 'fixed-model', max_output_tokens: 4096 },
      model: { base_url: origin + '/v1', test_user_agent: 'Fixture-UA\r\nunsafe\0' }, key, prompt: 'fixed independent challenge', signal,
      beforeSend: async () => { marks++; return true; } });
  }
  const text = Array(300).fill('123').join(' ');
  const fixtures = {
    openai: { model: 'served-model', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 80 } } },
    anthropic: { model: 'served-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 300, cache_read_input_tokens: 80 } },
    responses: { model: 'served-model', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 300, input_tokens_details: { cached_tokens: 80 } } }
  };
  try {
    for (const protocol of Object.keys(fixtures)) {
      reply = structuredClone(fixtures[protocol]);
      const result = await send(protocol);
      assert.equal(result.text, text);
      assert.equal(result.error, null);
      assert.equal(result.response_model, 'served-model');
      assert.equal(result.usage.promptTokens, 100);
      assert.equal(result.usage.cachedTokens, 80);
      assert.equal(calculateCost({ model_multiplier: 1 }, result.usage).weightedTokens, 328);
      const request = requests.at(-1);
      assert.equal(request.path, '/v1/' + ({ openai: 'chat/completions', anthropic: 'messages', responses: 'responses' })[protocol]);
      assert.equal(request.body.model, 'fixed-model');
      assert.equal(request.headers['user-agent'], 'Fixture-UA  unsafe');
      assert.equal(request.headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization'], protocol === 'anthropic' ? key : `Bearer ${key}`);
      assert.equal(request.body.stream, false);
      assert.equal(request.body.tools, undefined);
      for (const failure of protocol === 'openai' ? ['length', 'content_filter', 'refusal'] : protocol === 'anthropic' ? ['max_tokens', 'refusal'] : ['incomplete', 'refusal']) {
        reply = structuredClone(fixtures[protocol]);
        if (protocol === 'openai') {
          if (failure === 'refusal') reply.choices[0].message.refusal = key;
          else reply.choices[0].finish_reason = failure;
        } else if (protocol === 'anthropic') reply.stop_reason = failure;
        else if (failure === 'refusal') reply.output[0].content.push({ type: 'refusal', refusal: key });
        else { reply.status = 'incomplete'; reply.incomplete_details = { reason: 'max_output_tokens' }; }
        const result = await send(protocol);
        assert.ok(result.error);
        assert.equal(result.text, text);
        assert.equal(result.usage.completionTokens, 300);
        assert.equal(calculateCost({ model_multiplier: 1 }, result.usage).weightedTokens, 328);
        assert.equal(result.error.includes(key), false);
      }
    }
    for (const code of [401, 429, 500]) {
      status = code;
      reply = { ...fixtures.openai, error: { message: key } };
      const count = requests.length;
      const result = await send();
      assert.equal(requests.length, count + 1);
      assert.equal(result.error, `上游 HTTP ${code}`);
      assert.equal(result.text, '');
      assert.equal(result.usage.completionTokens, 300);
      assert.equal(JSON.stringify(result).includes(key), false);
    }
    for (const code of [401, 429, 500]) {
      status = code;
      reply = { error: { message: key } };
      const rejected = await send();
      assert.equal(rejected.definite_rejection, code !== 500);
      assert.equal(rejected.usage, null);
    }
    status = 200;
    reply = { ...fixtures.openai, usage: undefined };
    assert.equal((await send()).usage, null);
    reply = { ...fixtures.responses, model: key };
    assert.equal((await send('responses')).response_model, null);
    for (const name of [key, `x-${key}`, 'sk-private', 'Bearer-token', '<script>', 'a'.repeat(129), 'model\nsecret']) {
      assert.equal(parseResponse({ model: name }, 'openai', [key]).response_model, null);
    }
    reply = { ...fixtures.responses, usage: { input_tokens: 100, output_tokens: 5000 } };
    const exceeded = await send('responses');
    assert.ok(exceeded.error);
    assert.equal(exceeded.usage, null);
    mode = 'oversize';
    const beforeOversize = requests.length;
    await assert.rejects(send(), /体积限制/);
    assert.equal(requests.length, beforeOversize + 1);
    mode = 'wait';
    const controller = new AbortController();
    const started = new Promise(resolve => { began = resolve; });
    const pending = send('responses', controller.signal);
    const canceled = assert.rejects(pending, error => ['AbortError', 'CanceledError'].includes(error.name) || error.code === 'ERR_CANCELED');
    await started;
    const countAtCancel = requests.length;
    controller.abort();
    await canceled;
    assert.equal(requests.length, countAtCancel);
    mode = 'disconnect';
    await assert.rejects(send());
    assert.equal(marks, requests.length);
    assert.equal((await validator.validateUrl(origin, { allowPrivate: false })).ok, false);
    console.log('PASS ModelTrace real loopback HTTP/Axios: three fixed protocols/Key/UA, cached usage, truncation/refusal diagnostics with known billing, redacted bounded model identity, body cap, 401/429/500 single attempts, cancellation and disconnect; no database or real upstream.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    proxyPool.getProxyAgent = originalGetProxyAgent;
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original;
      else delete require.cache[id];
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
