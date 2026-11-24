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

const requestNameBindings = {
  ...selectedKey,
  modelQueue: ['model-default', 'model-general', 'model-reasoning', 'model-codex-special'],
  requestModelBindings: [
    { requestModelName: 'fast-chat', harness: null, modelId: 'model-general' },
    { requestModelName: 'fast-chat', harness: 'codex', modelId: 'model-codex-special' },
    { requestModelName: 'reasoning', harness: null, modelId: 'model-reasoning' },
  ],
  modelAuthorization: {
    deniedModelIds: [],
    deniedRequestModelBindings: [],
    requestModelIds: ['model-general', 'model-codex-special', 'model-reasoning'],
    requestModelConfigByBinding: [
      [JSON.stringify([null, 'fast-chat']), { id: 'model-general' }],
      [JSON.stringify(['codex', 'fast-chat']), { id: 'model-codex-special' }],
      [JSON.stringify([null, 'reasoning']), { id: 'model-reasoning' }],
    ],
  },
};
assert.deepStrictEqual(
  resolveModelQueueForRequest(requestNameBindings, { headers: { 'x-crewrouter-client': 'codex' }, body: { model: 'FAST-CHAT' } }),
  { queue: ['model-codex-special'], requestSource: 'codex', harnessOverride: false, requestModelOverride: true, requestModelName: 'FAST-CHAT', mappingDenied: false },
  'Harness 专属请求名映射应覆盖通用映射且名称比较不区分大小写'
);
assert.deepStrictEqual(
  resolveModelQueueForRequest(requestNameBindings, { headers: { 'x-crewrouter-client': 'claude_code' }, body: { model: 'fast-chat' } }),
  { queue: ['model-general'], requestSource: 'claude_code', harnessOverride: false, requestModelOverride: true, requestModelName: 'fast-chat', mappingDenied: false },
  '通用映射应适用于未设置专属映射的 Harness'
);
assert.deepStrictEqual(
  resolveModelQueueForRequest({ ...requestNameBindings, modelQueue: ['model-default'] }, { headers: {}, body: { model: 'unmapped-name' } }),
  { queue: ['model-default'], requestSource: 'unknown', harnessOverride: false },
  '未配置请求名映射时应保持旧默认队列回退'
);
assert.deepStrictEqual(
  resolveModelQueueForRequest({ ...requestNameBindings, harnessModels: { codex: 'model-harness' } }, { headers: { 'x-crewrouter-client': 'codex' }, body: { model: 'unmapped-name' } }),
  { queue: ['model-harness'], requestSource: 'codex', harnessOverride: true },
  '未映射请求名应继续使用 Harness 默认绑定'
);
assert.deepStrictEqual(
  resolveModelQueueForRequest(requestNameBindings, { headers: { 'x-crewrouter-client': 'codex' }, body: { model: 'fast-chat' }, policyDecision: { modelQueueOverride: ['model-policy'] } }),
  { queue: ['model-policy'], requestSource: 'codex', harnessOverride: false, policyOverride: true, requestedModelName: 'fast-chat' },
  '策略覆盖必须仍高于请求名和 Harness 绑定'
);
assert.equal(
  resolveModelQueueForRequest({ ...requestNameBindings, modelAuthorization: { deniedModelIds: [], deniedRequestModelBindings: [JSON.stringify(['codex', 'fast-chat'])], requestModelIds: ['model-general', 'model-reasoning'], requestModelConfigByBinding: [[JSON.stringify([null, 'fast-chat']), { id: 'model-general' }], [JSON.stringify([null, 'reasoning']), { id: 'model-reasoning' }]] } }, { headers: { 'x-crewrouter-client': 'codex' }, body: { model: 'fast-chat' } }).mappingDenied,
  true,
  '已配置映射目标失去授权时必须标记拒绝而不是回退'
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
assert.match(sessionsViewSource, /resolveSummaryTarget\(uid, recRes\.rows\)/);
assert.match(sessionsViewSource, /model: modelId/);
assert.match(sessionsViewSource, /\[uid, sessionKey, summary, summaryModelId\]/);
// 内部调用必须屏蔽签名注入（仅头模式），避免空正文时签名被当成总结落库
assert.match(sessionsViewSource, /'X-CrewRouter-Signature-Mode': 'header'/);

console.log('PASS session summary model selection regression');
