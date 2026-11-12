'use strict';

const assert = require('node:assert/strict');
const { fetchUrlAsAttachment, readBody, FetchError } = require('../utils/agent-fetch');
const { executeTool } = require('../utils/agent-tools');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  PASS', name);
}

async function main() {
  await assert.rejects(
    fetchUrlAsAttachment({}, { url: 'http://127.0.0.1/secret', userId: 1, threadId: 1 }),
    error => error instanceof FetchError && error.code === 'fetch_blocked'
  );
  await assert.rejects(
    fetchUrlAsAttachment({}, { url: 'http://localhost/secret', userId: 1, threadId: 1 }),
    error => error instanceof FetchError && error.code === 'fetch_blocked'
  );
  await assert.rejects(
    fetchUrlAsAttachment({}, { url: 'http://169.254.169.254/latest/meta-data', userId: 1, threadId: 1 }),
    error => error instanceof FetchError && error.code === 'fetch_blocked'
  );
  ok('private, loopback and metadata addresses are blocked');

  await assert.rejects(
    fetchUrlAsAttachment({}, { url: 'file:///etc/passwd', userId: 1, threadId: 1 }),
    error => error instanceof FetchError && error.code === 'fetch_blocked'
  );
  ok('non-http protocols are blocked');

  await assert.rejects(
    fetchUrlAsAttachment({}, { url: 'https://example.com:8443/', userId: 1, threadId: 1 }),
    error => error instanceof FetchError && error.code === 'fetch_blocked'
  );
  ok('unexpected ports are blocked');

  const batch = await executeTool({}, {
    name: 'fetch_urls',
    arguments: { urls: ['http://127.0.0.1/a', 'http://localhost/b'] }
  }, { userId: 1, threadId: 1 });
  assert.equal(batch.results.length, 2);
  assert.ok(batch.results.every(item => item.code === 'fetch_blocked'));
  ok('fetch_urls reports per-URL failures without aborting the batch');

  const small = await readBody(new Response(Buffer.from('hello')));
  assert.equal(small.toString('utf8'), 'hello');
  ok('small response bodies are read');

  const large = new Uint8Array(9 * 1024 * 1024);
  await assert.rejects(
    readBody(new Response(large)),
    error => error instanceof FetchError && error.code === 'fetch_too_large'
  );
  ok('oversized response bodies are rejected');

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
