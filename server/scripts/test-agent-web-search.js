'use strict';

const assert = require('node:assert/strict');
const {
  normalizeAgentWebConfig,
  mergeAgentWebConfig,
  maskAgentWebConfig,
  loadAgentWebConfig,
  searchWeb,
  checkRateLimit,
  DEFAULT_CONFIG
} = require('../utils/web-search');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  PASS', name);
}

function fakeDb(value) {
  return {
    async query(sql) {
      if (/FROM settings/i.test(sql)) {
        return { rows: value === undefined ? [] : [{ value: JSON.stringify(value) }] };
      }
      return { rows: [] };
    }
  };
}

async function main() {
  const defaults = normalizeAgentWebConfig(null);
  assert.equal(defaults.search.enabled, false);
  assert.equal(defaults.search.provider, 'tavily');
  assert.equal(defaults.search.maxResults, DEFAULT_CONFIG.search.maxResults);
  assert.equal(defaults.fetch.enabled, true);
  ok('defaults are conservative');

  const masked = maskAgentWebConfig({ search: { enabled: true, provider: 'brave', apiKey: 'secret-key', maxResults: 3, timeoutMs: 8000 }, fetch: { enabled: true } });
  assert.equal(masked.search.apiKey, '[configured]');
  assert.equal(masked.search.hasApiKey, true);
  ok('search keys are masked');

  const merged = mergeAgentWebConfig(defaults, { search: { provider: 'serper', maxResults: 99 }, fetch: { enabled: false } });
  assert.equal(merged.search.provider, 'serper');
  assert.equal(merged.search.maxResults, 8);
  assert.equal(merged.fetch.enabled, false);
  assert.equal(merged.search.apiKey, '');
  ok('updates are clamped and merged');

  assert.throws(
    () => mergeAgentWebConfig(defaults, { search: { provider: 'unknown' } }),
    error => error.code === 'invalid_provider'
  );
  ok('unknown providers are rejected');

  const loaded = await loadAgentWebConfig(fakeDb({
    search: { enabled: true, provider: 'tavily', apiKey: 'key', maxResults: 4 },
    fetch: { enabled: true }
  }));
  assert.equal(loaded.search.enabled, true);
  assert.equal(loaded.search.apiKey, 'key');
  ok('stored configuration loads');

  const unconfigured = await searchWeb(fakeDb(undefined), { query: 'pricing', userId: 1 });
  assert.equal(unconfigured.code, 'web_search_not_configured');
  ok('unconfigured search degrades explicitly');

  const configured = fakeDb({ search: { enabled: true, provider: 'tavily', apiKey: 'key', maxResults: 5 } });
  const invalidQuery = await searchWeb(configured, { query: 'x'.repeat(401), userId: 2 });
  assert.equal(invalidQuery.code, 'invalid_query');
  ok('oversized queries are rejected before network access');

  for (let index = 0; index < 12; index += 1) assert.equal(checkRateLimit('rate-test'), true);
  assert.equal(checkRateLimit('rate-test'), false);
  ok('per-minute search rate limiting works');

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
