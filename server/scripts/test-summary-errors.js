'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatSummaryError } = require('../utils/summary-error');

const upstreamError = { error: { message: 'Provider returned error', code: 429, metadata: {
  raw: 'stealth/union-alpha is temporarily rate-limited upstream. Please retry shortly.',
  provider_name: 'Stealth', limit_source: 'upstream_provider_shared_pool',
} } };
const expected = formatSummaryError(upstreamError, 429);
assert.match(expected, /HTTP 429/);
assert.match(expected, /stealth\/union-alpha/);
assert.match(expected, /共享额度池/);
assert.match(expected, /CrewRouter Key/);
assert.match(formatSummaryError({ error: 'invalid key' }, 401), /invalid key/);
assert.match(formatSummaryError({}, 502), /未提供具体错误说明/);
assert.match(formatSummaryError({ error: { metadata: { raw: JSON.stringify({ error: { message: 'context too long' } }) } } }, 400), /context too long/);
const sanitized = formatSummaryError({ error: { message: 'Bearer secret-value sk-example api_key=private-value https://example.com/?token=private <script>alert(1)</script>', metadata: { headers: { authorization: 'private-header' } } } }, 403);
for (const secret of ['secret-value', 'sk-example', 'private-value', 'private-header', 'https://', '<script>']) assert(!sanitized.includes(secret));
assert(formatSummaryError({ error: { message: 'x'.repeat(10000) } }, 500).length < 1000);

const routes = new Map();
let writes = 0;
const router = { get() {}, post(url, ...handlers) { routes.set(url, handlers.at(-1)); } };
const pool = { async query(sql) {
  if (sql.includes('COUNT(*)::int AS n')) return { rows: [{ n: 1 }] };
  if (sql.includes('SELECT id, api_key_id, messages')) return { rows: [{ api_key_id: 5, messages: [{ role: 'user', content: '请总结本次修改' }] }] };
  if (sql.includes('queued_model_id')) return { rows: [{ id: 5, queued_model_id: 'model' }] };
  if (sql.includes('INSERT INTO session_summaries')) { writes++; return { rows: [] }; }
  if (sql.includes('SELECT created_at')) return { rows: [{ created_at: '2026-09-17' }] };
  throw Error(`Unexpected query: ${sql}`);
} };
let upstream;
const context = {
  require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../models/database') return { pool };
    if (name === '../middleware/auth') return { requireAuth() {} };
    if (name === '../logger') return { error() {} };
    if (name === '../config-loader') return { app: { port: 20003 } };
    if (name === '../utils/usage-compress') return {};
    if (name === '../utils/internal-oauth') return { getInternalAccessToken: async () => 'fixture' };
    if (name === '../utils/model-selection') return {};
    if (name === '../utils/summary-error') return { formatSummaryError };
    return require(name);
  },
  module: { exports: {} }, TextDecoder, AbortSignal,
  fetch: async () => upstream,
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/sessions-view.js'), 'utf8'), context);
async function invoke(stream) {
  let text = ''; let json; let status = 200;
  const res = {
    status(value) { status = value; return this; }, json(value) { json = value; return this; },
    setHeader() {}, flushHeaders() {}, write(value) { text += value; }, end() { this.writableEnded = true; },
  };
  await routes.get('/sessions/:sessionKey/summary')({ session: { user: { id: 1 } }, params: { sessionKey: 'fixture' }, query: stream ? { stream: '1' } : {}, headers: {} }, res);
  return { text, json, status };
}
async function main() {
  upstream = new Response(JSON.stringify(upstreamError), { status: 429 });
  const plain = await invoke(false);
  assert.equal(plain.status, 502);
  assert.equal(plain.json.error, expected);
  upstream = new Response(JSON.stringify(upstreamError), { status: 429 });
  const streamed = await invoke(true);
  assert.equal(JSON.parse(streamed.text.slice(6)).error, expected);
  upstream = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分正文' } }] })}\n\ndata: ${JSON.stringify(upstreamError)}\n\n`);
  const partial = await invoke(true);
  assert.match(partial.text, /部分正文/);
  assert.match(partial.text, /HTTP 429/);
  assert(!partial.text.includes('"type":"done"'));
  assert.equal(writes, 0, '失败时不得缓存总结');
  upstream = new Response('data: {"choices":[{"delta":{"content":"总结正文"}}]}\n\ndata: [DONE]\n\n');
  assert.match((await invoke(true)).text, /"type":"done"/);
  assert.equal(writes, 1);
  console.log('PASS summary error formatting, HTTP/SSE propagation, no error persistence and successful retry');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
