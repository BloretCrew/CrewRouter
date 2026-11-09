import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';

import { CrewRouter } from '../dist/esm/index.js';

const CASES = JSON.parse(
  fs.readFileSync(new URL('../../contract/conformance/cases.json', import.meta.url), 'utf8'),
);

function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        path: url.pathname,
        query: url.searchParams.toString(),
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

test('shared transport fixtures', async () => {
  for (const fixture of CASES.transport) {
    const { server, requests, baseUrl } = await startServer((req, res) => {
      json(res, fixture.response.status, fixture.response.json, fixture.response.headers);
    });
    try {
      const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', authStyle: fixture.authStyle });
      const response = await client.raw({
        method: fixture.method,
        path: fixture.path,
        query: fixture.query,
        body: fixture.body,
      });
      const recorded = requests[0];
      assert.equal(recorded.method, fixture.method, fixture.name);
      assert.equal(recorded.path, fixture.expect.path, fixture.name);
      assert.equal(recorded.query, fixture.expect.query || '', fixture.name);
      if (fixture.expect.authorization) {
        assert.equal(recorded.headers.authorization, fixture.expect.authorization, fixture.name);
      }
      if (fixture.expect.xApiKey) {
        assert.equal(recorded.headers['x-api-key'], fixture.expect.xApiKey, fixture.name);
        assert.equal(recorded.headers.authorization, undefined, fixture.name);
      }
      if (fixture.expect.contentType) {
        assert.match(String(recorded.headers['content-type']), new RegExp(`^${fixture.expect.contentType}`), fixture.name);
      }
      if (fixture.expect.body) assert.deepEqual(recorded.body, fixture.expect.body, fixture.name);
      if (fixture.response.json) assert.deepEqual(response.data, fixture.response.json, fixture.name);
      if (fixture.expect.requestId) assert.equal(response.requestId, fixture.expect.requestId, fixture.name);
      if (fixture.expect.signature) assert.equal(response.signature, fixture.expect.signature, fixture.name);
    } finally {
      await closeServer(server);
    }
  }
});

test('shared error fixtures', async () => {
  for (const fixture of CASES.errors) {
    const { server, baseUrl } = await startServer((req, res) => {
      json(res, fixture.status, fixture.body, fixture.headers);
    });
    try {
      const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
      await assert.rejects(client.raw({ method: 'GET', path: '/fixture' }), (error) => {
        assert.equal(error.status, fixture.expect.status, fixture.name);
        if (fixture.expect.code) assert.equal(error.code, fixture.expect.code, fixture.name);
        if (fixture.expect.type) assert.equal(error.type, fixture.expect.type, fixture.name);
        if (fixture.expect.permission) assert.equal(error.permission, fixture.expect.permission, fixture.name);
        if (fixture.expect.message) assert.equal(error.message, fixture.expect.message, fixture.name);
        if (fixture.expect.protocol) assert.equal(error.protocol, fixture.expect.protocol, fixture.name);
        if (fixture.expect.requestId) assert.equal(error.requestId, fixture.expect.requestId, fixture.name);
        return true;
      });
    } finally {
      await closeServer(server);
    }
  }
});

test('shared SSE fixtures', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of CASES.sse.chunks) res.write(chunk);
    res.end();
  });
  try {
    const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
    const events = [];
    for await (const event of client.gateway.chat.completions.stream({ messages: [] })) {
      events.push({ event: event.event ?? '', data: event.data, done: event.done });
    }
    assert.deepEqual(events, CASES.sse.expect);
  } finally {
    await closeServer(server);
  }
});

test('shared retry fixtures', async () => {
  for (const fixture of CASES.retry) {
    let attempts = 0;
    const { server, baseUrl } = await startServer((req, res) => {
      const response = fixture.responses[Math.min(attempts, fixture.responses.length - 1)];
      attempts += 1;
      json(res, response.status, response.json, response.headers);
    });
    try {
      const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', maxRetries: fixture.maxRetries });
      if (fixture.expect.status) {
        const response = await client.raw({ method: fixture.method, path: fixture.path, body: fixture.body });
        assert.equal(response.status, fixture.expect.status, fixture.name);
      } else {
        await assert.rejects(
          client.raw({ method: fixture.method, path: fixture.path, body: fixture.body }),
          (error) => {
            assert.equal(error.status, fixture.expect.errorStatus, fixture.name);
            return true;
          },
        );
      }
      assert.equal(attempts, fixture.expect.attempts, fixture.name);
    } finally {
      await closeServer(server);
    }
  }
});
