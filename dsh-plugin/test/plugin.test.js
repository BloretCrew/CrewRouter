import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeBaseUrl, apply } from '../index.js';
import { readFileSync } from 'node:fs';

// Resolve Host-owned packages from DSH's installation in the real profile and in CI.
const dshRoot = process.env.DSH_INSTALL_ROOT || '/opt/dsh/dsh';
const dshManifest = JSON.parse(readFileSync(`${dshRoot}/package.json`, 'utf8'));
const hostRequire = createRequire(`${dshRoot}/package.json`);
const hostVersion = dshManifest.version;
const { credentialKey } = hostRequire('@deepseek-ai/dsh-credentials');

function fakeToolHost({ credential = 'sk-secret', fetchImpl } = {}) {
  const tools = new Map();
  const keys = [];
  const ctx = {
    credentials: { async resolve(key) { keys.push(key); return credential ? { value: credential, source: 'test' } : undefined; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  };
  const originalFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  apply(ctx, { baseUrl: 'http://localhost:20003' });
  return { tools, keys, restore() { globalThis.fetch = originalFetch; } };
}

const exec = (signal = new AbortController().signal) => ({ signal });
const response = ({ status = 200, body = '{}', headers = {} } = {}) => new Response(body, { status, headers });

test('credential record key matches DSH key grammar and DSH is the installation version', () => {
  assert.equal(credentialKey('bloret-crew-dsh-crewrouter', 'default'), 'bloret-crew-dsh-crewrouter/default');
  assert.equal(hostVersion, dshManifest.version);
  assert.ok(hostRequire.resolve('@deepseek-ai/dsh-tools'));
  assert.ok(hostRequire.resolve('@deepseek-ai/dsh-credentials'));
  assert.ok(hostRequire.resolve('@deepseek-ai/schemastery'));
});

test('normalizes a root URL and allows loopback HTTP only', () => {
  assert.equal(normalizeBaseUrl('https://router.example/'), 'https://router.example');
  assert.equal(normalizeBaseUrl('http://localhost:20003/v1'), 'http://localhost:20003');
  for (const value of ['http://router.example', 'ftp://router.example', 'https://user:pass@router.example', 'https://router.example/path', 'https://router.example/?x=1', 'https://router.example/#frag']) assert.throws(() => normalizeBaseUrl(value));
});

test('registers exactly the read-only operations with bounded queries', async () => {
  const calls = [];
  const host = fakeToolHost({ fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return response({ body: '{"ok":true}' }); } });
  try {
    assert.deepEqual([...host.tools.keys()].sort(), ['crewrouter_models', 'crewrouter_overview', 'crewrouter_sessions']);
    await host.tools.get('crewrouter_overview').execute({ days: 900 }, exec());
    await host.tools.get('crewrouter_sessions').execute({ days: 7, page: 10000 }, exec());
    await host.tools.get('crewrouter_models').execute({}, exec());
    assert.equal(calls[0].url.pathname, '/api/user/stats');
    assert.equal(calls[0].url.searchParams.get('days'), '90');
    assert.equal(calls[1].url.pathname, '/api/user/sessions');
    assert.equal(calls[1].url.searchParams.get('page'), '100');
    assert.equal(calls[1].url.searchParams.get('pageSize'), '20');
    assert.equal(calls[2].url.pathname, '/api/user/models');
    for (const call of calls) {
      assert.equal(call.init.method, 'GET');
      assert.equal(call.init.redirect, 'error');
      assert.equal(call.init.headers.authorization, 'Bearer sk-secret');
    }
    assert.ok(host.keys.every(key => key === 'bloret-crew-dsh-crewrouter/default'));
  } finally { host.restore(); }
});

test('re-reads credentials per call and does not echo the secret', async () => {
  let reads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({ body: '{"safe":"ok"}' });
  const tools = new Map();
  const ctx = {
    credentials: { async resolve() { reads++; return { value: 'sk-do-not-leak', source: 'test' }; } },
    tools: { register(tool) { tools.set(tool.name, tool); } },
  };
  try {
    apply(ctx, { baseUrl: 'http://127.0.0.1:20003' });
    const result = await tools.get('crewrouter_models').execute({}, exec());
    assert.equal(reads, 1);
    assert.match(result, /safe/);
    assert.doesNotMatch(result, /sk-do-not-leak/);
  } finally { globalThis.fetch = originalFetch; }
});

test('rejects missing credentials without making a request', async () => {
  let requests = 0;
  const host = fakeToolHost({ credential: '', fetchImpl: async () => { requests++; return response(); } });
  try {
    await assert.rejects(host.tools.get('crewrouter_models').execute({}, exec()), /尚未配置 CrewRouter API Key/);
    assert.equal(requests, 0);
  } finally { host.restore(); }
});

test('maps 401 and 403 without echoing response bodies', async () => {
  for (const [status, expected] of [[401, /API Key 无效/], [403, /授予此只读 API 所需的权限/]]) {
    const host = fakeToolHost({ fetchImpl: async () => response({ status, body: 'sk-leaked-secret server-internal-detail' }) });
    try {
      await assert.rejects(host.tools.get('crewrouter_models').execute({}, exec()), error => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /sk-leaked-secret|server-internal-detail/);
        return true;
      });
    } finally { host.restore(); }
  }
});

test('rejects redirects and unreadable JSON without returning server details', async () => {
  const host = fakeToolHost({ fetchImpl: async () => response({ status: 302, headers: { location: 'https://attacker.invalid' }, body: 'redirect body secret' }) });
  try {
    await assert.rejects(host.tools.get('crewrouter_models').execute({}, exec()), error => {
      assert.doesNotMatch(error.message, /attacker.invalid|redirect body/);
      return true;
    });
  } finally { host.restore(); }
});

test('bounds response bytes before parsing and bounds model-facing text', async () => {
  const tooLarge = fakeToolHost({ fetchImpl: async () => response({ body: ' '.repeat(256 * 1024 + 5) }) });
  try { await assert.rejects(tooLarge.tools.get('crewrouter_models').execute({}, exec()), /超过大小上限/); }
  finally { tooLarge.restore(); }
  const bounded = fakeToolHost({ fetchImpl: async () => response({ body: JSON.stringify({ data: 'x'.repeat(15000) }) }) });
  try {
    const result = await bounded.tools.get('crewrouter_models').execute({}, exec());
    assert.ok(result.length <= 12100);
    assert.match(result, /结果已截断/);
  } finally { bounded.restore(); }
});

test('honors cancellation during requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  const host = fakeToolHost();
  const controller = new AbortController();
  try {
    const pending = host.tools.get('crewrouter_models').execute({}, exec(controller.signal));
    setImmediate(() => controller.abort());
    await assert.rejects(pending, /已取消或超时/);
  } finally { globalThis.fetch = originalFetch; }
});
