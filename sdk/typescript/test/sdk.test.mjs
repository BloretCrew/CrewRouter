import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import {
  CrewRouter,
  CrewRouterAuthenticationError,
  CrewRouterPermissionError,
  CrewRouterRateLimitError,
} from '../dist/esm/index.js';

let server;
let baseUrl;
let requests = [];
let handler = null;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function reset(next) {
  requests = [];
  handler = next;
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

test('gateway chat send bearer auth, JSON body and reads response metadata', async () => {
  reset((req, res) => json(res, 200, { id: 'chatcmpl-1', choices: [] }, {
    'x-crewrouter-request-id': 'req-123',
    'x-crewrouter-signature': 'signed',
  }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const response = await client.gateway.chat.completions.create({
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { id: 'chatcmpl-1', choices: [] });
  assert.equal(response.requestId, 'req-123');
  assert.equal(response.signature, 'signed');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(requests[0].body), {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'hi' }],
  });
});

test('x-api-key auth style is supported', async () => {
  reset((req, res) => json(res, 200, { object: 'list', data: [] }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', authStyle: 'x-api-key' });
  await client.gateway.models.list();
  assert.equal(requests[0].headers['x-api-key'], 'sk-test');
  assert.equal(requests[0].headers.authorization, undefined);
});

test('call() substitutes path params and serializes query arrays', async () => {
  reset((req, res) => json(res, 200, { data: [] }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await client.call('user.apiKeys.byId.models.list', {
    pathParams: { id: 42 },
    query: { days: 7, tag: ['a', 'b'], skip: undefined },
  });
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, '/api/user/api-keys/42/models?days=7&tag=a&tag=b');
});

test('management wrappers preserve their documented response payload shapes', async () => {
  reset((req, res) => {
    if (req.url === '/api/user/api-keys') {
      json(res, 200, [{ id: 7, name: 'CI', key_value: null, permissions: ['keys.read'], tags: [], model_queue: [] }]);
      return;
    }
    if (req.url === '/api/user/usage') {
      json(res, 200, [{ date: '2026-01-01', total_tokens: '12', total_cost: '0.25', total_requests: '2' }]);
      return;
    }
    if (req.url === '/api/user/balance') {
      json(res, 200, { balance: 10, refund_balance: 8, rate_limit_rpm: 60, rate_limit_tpm: 1000, group: null });
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const keys = await client.keys.list();
  const usage = await client.usage.get();
  const balance = await client.balance.get();

  assert.equal(keys.data[0].key_value, null);
  assert.deepEqual(keys.data[0].permissions, ['keys.read']);
  assert.equal(usage.data[0].total_tokens, '12');
  assert.equal(balance.data.refund_balance, 8);
  assert.equal(balance.data.group, null);
});

test('management errors expose code and permission', async () => {
  reset((req, res) => json(res, 403, {
    error: 'API Key 没有该权限: keys.read',
    code: 'permission_denied',
    permission: 'keys.read',
  }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await assert.rejects(client.keys.list(), (error) => {
    assert(error instanceof CrewRouterPermissionError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'permission_denied');
    assert.equal(error.permission, 'keys.read');
    assert.equal(error.protocol, 'management');
    return true;
  });
});

test('anthropic error shape is normalized', async () => {
  reset((req, res) => json(res, 401, {
    type: 'error',
    error: { type: 'authentication_error', message: 'invalid key' },
  }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await assert.rejects(client.gateway.messages.create({ messages: [] }), (error) => {
    assert(error instanceof CrewRouterAuthenticationError);
    assert.equal(error.type, 'authentication_error');
    assert.equal(error.protocol, 'anthropic');
    assert.equal(error.message, 'invalid key');
    return true;
  });
});

test('SSE parser handles split UTF-8, multi-line data and [DONE]', async () => {
  reset((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你');
    res.write('好"}}]}\n\n');
    res.write(': keep-alive\n\n');
    res.write('event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const events = [];
  for await (const event of client.gateway.chat.completions.stream({ messages: [] })) {
    events.push(event);
  }

  assert.equal(events.length, 3);
  assert.deepEqual(events[0].parsed, { choices: [{ delta: { content: '你好' } }] });
  assert.equal(events[0].done, false);
  assert.equal(events[1].event, 'message_delta');
  assert.deepEqual(events[1].parsed, { delta: { stop_reason: 'end_turn' } });
  assert.equal(events[2].done, true);
  assert.equal(events[2].data, '[DONE]');
});

test('stream idle timeout does not limit response header wait time', async () => {
  reset((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"ready":true}\n\n');
      setTimeout(() => res.end(), 10);
    }, 80);
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const events = [];
  for await (const event of client.gateway.chat.completions.stream({ messages: [] }, { idleTimeoutMs: 50 })) events.push(event);
  assert.equal(events[0].data, '{"ready":true}');
});

test('breaking from an SSE iterator cancels the reader and closes the response', async () => {
  let responseClosed = false;
  reset((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"chunk":1}\n\n');
    const interval = setInterval(() => res.write('data: {"chunk":2}\\n\\n'), 20);
    res.on('close', () => {
      responseClosed = true;
      clearInterval(interval);
    });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  for await (const _event of client.gateway.chat.completions.stream({ messages: [] })) break;

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const poll = () => {
      if (responseClosed) return resolve();
      if (Date.now() >= deadline) return reject(new Error('SSE response was not closed after iterator break'));
      setTimeout(poll, 10);
    };
    poll();
  });
});

test('GET retries 429 when maxRetries is enabled and honors Retry-After', async () => {
  let attempts = 0;
  reset((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      json(res, 429, { error: 'slow down' }, { 'retry-after': '0' });
      return;
    }
    json(res, 200, { ok: true });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', maxRetries: 2 });
  const response = await client.gateway.models.list();
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('POST does not retry by default even when maxRetries is enabled', async () => {
  let attempts = 0;
  reset((req, res) => {
    attempts += 1;
    json(res, 429, { error: 'slow down' }, { 'retry-after': '0' });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', maxRetries: 2 });
  await assert.rejects(client.gateway.chat.completions.create({ messages: [] }), (error) => {
    assert(error instanceof CrewRouterRateLimitError);
    return true;
  });
  assert.equal(attempts, 1);
});

test('retryNonIdempotent allows POST retries', async () => {
  let attempts = 0;
  reset((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      json(res, 429, { error: 'slow down' }, { 'retry-after': '0' });
      return;
    }
    json(res, 200, { ok: true });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', maxRetries: 1, retryNonIdempotent: true });
  const response = await client.gateway.chat.completions.create({ messages: [] });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('session-only operations are rejected before sending a request', async () => {
  reset((req, res) => json(res, 200, { ok: true }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await assert.rejects(client.call('2fa.status.list'), /session-only/);
  assert.equal(requests.length, 0);
});
