'use strict';

// 仅验证本次新增的端点指纹行为（不跑完整的孤立 PG 套件，避免 CI 机器上的锁等待忙循环）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeProviderEndpoints } = require('../utils/provider-endpoints');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
const start = source.indexOf("router.post('/providers/:id/sync-models'");
assert(start >= 0);
const end = source.indexOf('\n});', start) + 4;
const slice = source.slice(start, end);

// 提取 fingerprint 表达式并直接求值，确认端点变化会改变指纹
const match = slice.match(/const fingerprint = provider => JSON\.stringify\(\[[\s\S]*?\]\);/);
assert(match, 'fingerprint definition must be discoverable');
const fingerprint = vm.runInNewContext(`(${match[0].replace('const fingerprint = ', '').replace(/;$/, '')})`, {
  normalizeProviderEndpoints,
});

const base = {
  base_url: 'https://api.example.com/v1',
  models_url: '',
  api_key: 'k',
  api_keys: null,
  format: 'openai',
  enabled: true,
  created_by: null,
  endpoints: [],
};
const withEndpoint = { ...base, endpoints: [{ url: 'https://alt.example.com', format: 'anthropic', enabled: true, label: 'Alt' }] };
const toggled = { ...base, endpoints: [{ url: 'https://alt.example.com', format: 'anthropic', enabled: false, label: 'Alt' }] };

assert.notEqual(fingerprint(base), fingerprint(withEndpoint), '新增端点必须改变指纹');
assert.notEqual(fingerprint(withEndpoint), fingerprint(toggled), '停用端点必须改变指纹');
assert.equal(fingerprint(base), fingerprint({ ...base, endpoints: [] }), '空端点不影响指纹');

// 端点、Key、格式写入必须仍从 $38/$39 起（占位符不重排）
const upsertStart = source.indexOf("router.post('/providers',");
assert(upsertStart >= 0, 'POST /providers must exist');
const upsert = source.slice(upsertStart, source.indexOf('\n});', upsertStart) + 4);
assert.match(upsert, /\$38::jsonb/);
assert.match(upsert, /CASE WHEN \$39 THEN EXCLUDED\.endpoints ELSE providers\.endpoints END/);
assert.match(upsert, /finalEndpoints, endpointsProvided\]\);/, 'endpoints params must be last, matching $38/$39');
console.log('PASS endpoint fingerprint + POST /providers $38/$39 placeholders');
