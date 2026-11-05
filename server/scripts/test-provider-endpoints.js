'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeProviderEndpoints,
  countProviderEndpoints,
  endpointCandidatesFor,
  makeEndpointProvider,
  isEndpointRetryableStatus,
  normalizeEndpointsInput,
  normalizeEndpointUrl,
  parseEndpointsRaw,
} = require('../utils/provider-endpoints');

const baseProvider = {
  id: 'p1',
  base_url: 'https://api.example.com/v1',
  format: 'openai',
};

test('空/非法 endpoints 只保留主端点', () => {
  for (const raw of [undefined, null, '', '[]', [], 'not-json', {}, { url: 'x' }]) {
    const list = normalizeProviderEndpoints({ ...baseProvider, endpoints: raw });
    assert.equal(list.length, 1, `raw=${JSON.stringify(raw)}`);
    assert.equal(list[0].url, 'https://api.example.com/v1');
    assert.equal(list[0].format, 'openai');
    assert.equal(list[0].primary, true);
  }
  assert.equal(countProviderEndpoints({ ...baseProvider, endpoints: '[]' }), 0);
});

test('主端点永远第一，附加端点按顺序追加并去尾斜杠', () => {
  const list = normalizeProviderEndpoints({
    ...baseProvider,
    endpoints: [
      { url: 'https://api.example.com/anthropic/', format: 'anthropic', label: 'A' },
      { url: 'https://api.example.com/v1/', format: 'responses' },
    ],
  });
  assert.deepEqual(list.map(e => [e.url, e.format, e.primary]), [
    ['https://api.example.com/v1', 'openai', true],
    ['https://api.example.com/anthropic', 'anthropic', false],
    ['https://api.example.com/v1', 'responses', false],
  ]);
});

test('去重：与主端点相同的附加端点被丢弃（大小写不敏感）', () => {
  const list = normalizeProviderEndpoints({
    ...baseProvider,
    endpoints: [
      { url: 'HTTPS://API.EXAMPLE.COM/v1/', format: 'openai' },
      { url: 'https://api.example.com/v1', format: 'anthropic' },
      { url: 'https://api.example.com/v1', format: 'anthropic' },
    ],
  });
  assert.deepEqual(list.map(e => e.format), ['openai', 'anthropic']);
});

test('gemini 与未知格式被丢弃', () => {
  const list = normalizeProviderEndpoints({
    ...baseProvider,
    endpoints: [
      { url: 'https://a.example.com', format: 'gemini' },
      { url: 'https://b.example.com', format: 'nonsense' },
      { url: 'https://c.example.com', format: 'ANTHROPIC' },
    ],
  });
  assert.deepEqual(list.map(e => [e.url, e.format]), [
    ['https://api.example.com/v1', 'openai'],
    ['https://c.example.com', 'anthropic'],
  ]);
});

test('停用端点保留在展示列表，但不进入请求候选', () => {
  const provider = {
    ...baseProvider,
    endpoints: [{ url: 'https://off.example.com', format: 'anthropic', enabled: false }],
  };
  assert.equal(normalizeProviderEndpoints(provider).length, 2);
  assert.equal(countProviderEndpoints(provider), 0);
  assert.deepEqual(endpointCandidatesFor(provider, 'chat').map(e => e.url), ['https://api.example.com/v1']);
});

test('原生格式优先：/messages 先 Anthropic，chat 先 OpenAI', () => {
  const provider = {
    ...baseProvider,
    endpoints: [{ url: 'https://ant.example.com', format: 'anthropic', label: 'A' }],
  };
  assert.deepEqual(endpointCandidatesFor(provider, 'anthropic').map(e => e.format), ['anthropic', 'openai']);
  assert.deepEqual(endpointCandidatesFor(provider, 'chat').map(e => e.format), ['openai', 'anthropic']);

  // 同格式内部顺序稳定
  const multi = {
    ...baseProvider,
    endpoints: [
      { url: 'https://a.example.com', format: 'anthropic' },
      { url: 'https://b.example.com', format: 'anthropic' },
    ],
  };
  assert.deepEqual(endpointCandidatesFor(multi, 'anthropic').map(e => e.url),
    ['https://a.example.com', 'https://b.example.com', 'https://api.example.com/v1']);
});

test('/v1/messages 不使用 responses 端点，chat/responses 三种都可用', () => {
  const provider = {
    ...baseProvider,
    endpoints: [{ url: 'https://r.example.com', format: 'responses' }],
  };
  assert.equal(endpointCandidatesFor(provider, 'anthropic').some(e => e.format === 'responses'), false);
  assert.equal(endpointCandidatesFor(provider, 'chat').length, 2);
  assert.deepEqual(endpointCandidatesFor(provider, 'responses').map(e => e.format), ['responses', 'openai']);
});

test('makeEndpointProvider 投影响应为 base_url/format，并保留其余字段', () => {
  const endpoint = { url: 'https://x.example.com', format: 'anthropic' };
  const clone = makeEndpointProvider(baseProvider, endpoint);
  assert.equal(clone.base_url, 'https://x.example.com');
  assert.equal(clone.format, 'anthropic');
  assert.equal(clone.id, 'p1');
  assert.equal(clone._endpoint, endpoint);
});

test('isEndpointRetryableStatus：408/429/5xx 可回退，其余不可', () => {
  for (const s of [408, 429, 500, 502, 503, 504]) assert.equal(isEndpointRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 402, 403, 404, 413, 422, 200, null, undefined, 'abc']) {
    assert.equal(isEndpointRetryableStatus(s), false, String(s));
  }
});

test('normalizeEndpointsInput 通过合法配置', () => {
  const result = normalizeEndpointsInput([
    { url: 'https://a.example.com/v1/', format: 'anthropic', label: 'Claude' },
    { url: 'https://b.example.com', format: 'openai', enabled: false },
  ], { baseUrl: 'https://primary.example.com', format: 'openai' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.endpoints, [
    { url: 'https://a.example.com/v1', format: 'anthropic', enabled: true, label: 'Claude' },
    { url: 'https://b.example.com', format: 'openai', enabled: false, label: 'Endpoint 2' },
  ]);
});

test('normalizeEndpointsInput 拒绝非数组、超长、非法 URL 与格式', () => {
  assert.equal(normalizeEndpointsInput('x').ok, false);
  assert.equal(normalizeEndpointsInput(Array.from({ length: 17 }, (_, i) => ({ url: `https://e${i}.example.com`, format: 'openai' }))).ok, false);

  const badUrl = normalizeEndpointsInput([{ url: 'ftp://a.example.com', format: 'openai' }]);
  assert.equal(badUrl.ok, false);
  assert.deepEqual(badUrl.errors[0], { index: 0, field: 'url', message: '端点 URL 需以 http:// 或 https:// 开头' });

  const badFormat = normalizeEndpointsInput([{ url: 'https://a.example.com', format: 'gemini' }]);
  assert.deepEqual(badFormat.errors[0], { index: 0, field: 'format', message: '端点格式仅支持 openai / anthropic / responses' });

  const tooLong = normalizeEndpointsInput([{ url: `https://a.example.com/${'x'.repeat(600)}`, format: 'openai' }]);
  assert.equal(tooLong.ok, false);
});

test('normalizeEndpointsInput 检测与主端点/其他端点重复', () => {
  const dupPrimary = normalizeEndpointsInput(
    [{ url: 'https://primary.example.com', format: 'openai' }],
    { baseUrl: 'https://primary.example.com/', format: 'openai' }
  );
  assert.equal(dupPrimary.ok, false);
  assert.equal(dupPrimary.errors[0].index, 0);

  const dupSelf = normalizeEndpointsInput([
    { url: 'https://a.example.com', format: 'anthropic' },
    { url: 'https://a.example.com/', format: 'anthropic' },
  ]);
  assert.equal(dupSelf.ok, false);
  assert.equal(dupSelf.errors[0].index, 1);
});

test('parseEndpointsRaw 处理 pg 已解析数组与字符串', () => {
  assert.deepEqual(parseEndpointsRaw([{ url: 'x' }]), [{ url: 'x' }]);
  assert.deepEqual(parseEndpointsRaw('[{"url":"x"}]'), [{ url: 'x' }]);
  assert.deepEqual(parseEndpointsRaw('null'), []);
  assert.deepEqual(parseEndpointsRaw(undefined), []);
});

test('normalizeEndpointUrl 只去尾部斜杠', () => {
  assert.equal(normalizeEndpointUrl(' https://a.example.com/v1// '), 'https://a.example.com/v1');
  assert.equal(normalizeEndpointUrl(''), '');
  assert.equal(normalizeEndpointUrl(null), '');
});
