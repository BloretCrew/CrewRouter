'use strict';

const assert = require('assert');
const { resolveModelQueueForRequest } = require('../routes/api');
const { resolveSummaryApiKeyId } = require('../utils/model-selection');

// 隔离 fixture：模拟内部 OAuth 总结请求与普通 API Key 使用同一模型绑定。
const summaryRequest = { headers: {}, body: {} };
const selectedKey = {
  userId: 101,
  keyId: 501,
  currentModelId: 'model-default',
  modelQueue: ['model-default'],
  harnessModels: {},
};

assert.deepStrictEqual(
  resolveModelQueueForRequest(selectedKey, summaryRequest),
  { queue: ['model-default'], requestSource: 'unknown', harnessOverride: false },
  'API Key 已选择默认模型时，会话总结不应提示未选择模型'
);

assert.deepStrictEqual(
  resolveModelQueueForRequest({
    ...selectedKey,
    harnessModels: { codex: 'model-codex' },
  }, { headers: { 'x-crewrouter-client': 'codex' }, body: {} }),
  { queue: ['model-codex'], requestSource: 'codex', harnessOverride: true },
  '明确客户端绑定应优先于默认模型'
);

assert.deepStrictEqual(
  resolveModelQueueForRequest({ userId: 101, keyId: 501, modelQueue: [], currentModelId: null, harnessModels: {} }, summaryRequest),
  { queue: [], requestSource: 'unknown', harnessOverride: false },
  '没有任何模型绑定时才应返回空队列'
);

assert.strictEqual(
  resolveSummaryApiKeyId([
    { api_key_id: 700, created_at: '2026-09-02T10:00:00Z' },
    { api_key_id: 501, created_at: '2026-09-02T10:01:00Z' },
  ]),
  501,
  '会话总结应使用该会话最后一条记录所属的 API Key'
);
assert.strictEqual(
  resolveSummaryApiKeyId([{ api_key_id: 999 }, { api_key_id: null }]),
  999,
  '记录缺失当前 API Key 时应回退到最近一条有效 API Key'
);
assert.strictEqual(
  resolveSummaryApiKeyId([{ api_key_id: null }]),
  null,
  '没有可用 API Key 时应明确返回空值'
);

const sessionsViewSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'sessions-view.js'), 'utf8');
assert.match(sessionsViewSource, /resolveSummaryModelId\(summaryApiKeyId\)/);
assert.match(sessionsViewSource, /model: modelId/);
assert.match(sessionsViewSource, /\[uid, sessionKey, summary, summaryModelId\]/);

console.log('PASS session summary model selection regression');
