'use strict';

/**
 * 请求名 → 模型映射的输入校验与命令解析回归。
 *
 * 关键点：
 * - 控制字符检测必须用真实 Unicode 范围，普通模型名（fast-chat、gpt-4o）不能被误拒；
 * - 名称统一 trim + 小写入库，空串 / 超长 / fusion 保留名一律拒绝；
 * - 命令里的 Harness 前缀只在整段确实是 Harness 名称时才消费，
 *   避免把 "claude code fast-chat 用 gpt-4.1" 解析成请求名 "code fast-chat"。
 */

const assert = require('assert');
const { HARNESS_SOURCES, isHarnessSource } = require('../utils/request-source');
const {
  MAX_REQUEST_MODEL_NAME_LENGTH,
  normalizeRequestModelName,
  normalizeRequestModelBindings,
} = require('../utils/request-model-bindings');
const { matchCommand } = require('../utils/crewrouter-command');

const harnessOptions = { isHarnessSource, harnessSources: HARNESS_SOURCES };

for (const name of ['fast-chat', 'gpt-4o', 'claude-3-5-sonnet', 'deepseek-chat', 'a', 'Model Name']) {
  assert.ok(normalizeRequestModelName(name).requestModelName, `普通模型名应通过: ${name}`);
}
assert.strictEqual(normalizeRequestModelName('  FAST-Chat  ').requestModelName, 'fast-chat', '请求名应 trim 并小写');
assert.ok(normalizeRequestModelName('').error, '空请求名应拒绝');
assert.ok(normalizeRequestModelName('   ').error, '仅空白请求名应拒绝');
assert.ok(normalizeRequestModelName('a'.repeat(MAX_REQUEST_MODEL_NAME_LENGTH + 1)).error, '超长请求名应拒绝');
for (const name of ['fast\nchat', 'fast\tchat', 'fast\u0000chat', 'fast\u007fchat']) {
  assert.ok(normalizeRequestModelName(name).error, `控制字符应拒绝: ${JSON.stringify(name)}`);
}
for (const name of ['fusion', 'fusion:pro', 'fusion/panel', 'FUSION']) {
  assert.ok(normalizeRequestModelName(name).error, `Fusion 保留名应拒绝: ${name}`);
}

const ok = normalizeRequestModelBindings([
  { request_model_name: 'Fast-Chat', harness: '', model_id: 'gpt-4o' },
  { requestModelName: 'Fast-Chat', harness: 'codex', modelId: 'deepseek-chat' },
], harnessOptions);
assert.deepStrictEqual(ok.bindings, [
  { requestModelName: 'fast-chat', harness: null, modelId: 'gpt-4o' },
  { requestModelName: 'fast-chat', harness: 'codex', modelId: 'deepseek-chat' },
], '通用与 Harness 专属同名规则可共存，并统一小写');

assert.ok(normalizeRequestModelBindings([
  { request_model_name: 'fast-chat', model_id: 'gpt-4o' },
  { request_model_name: 'FAST-CHAT', model_id: 'deepseek-chat' },
], harnessOptions).error, '同一作用范围重复请求名应拒绝');
assert.ok(normalizeRequestModelBindings([{ request_model_name: 'x', harness: 'unknown', model_id: 'gpt-4o' }], harnessOptions).error, 'unknown 不是可绑定 Harness');
assert.ok(normalizeRequestModelBindings([{ request_model_name: 'x', harness: 'nope', model_id: 'gpt-4o' }], harnessOptions).error, '未知 Harness 应拒绝');
assert.ok(normalizeRequestModelBindings([{ request_model_name: 'x', model_id: '' }], harnessOptions).error, '缺少目标模型应拒绝');
assert.ok(normalizeRequestModelBindings('nope', harnessOptions).error, 'bindings 必须是数组');
assert.ok(normalizeRequestModelBindings(Array.from({ length: 101 }, (_, i) => ({ request_model_name: `m${i}`, model_id: 'x' })), harnessOptions).error, '超过 100 条应拒绝');

const cases = [
  ['请求名映射 claude code fast-chat 用 gpt-4.1', { harnessText: 'claude code', requestModelName: 'fast-chat', modelQuery: 'gpt-4.1' }],
  ['请求名映射 fast-chat 用 gpt-4.1', { harnessText: '', requestModelName: 'fast-chat', modelQuery: 'gpt-4.1' }],
  ['请求名映射 codex reasoning 映射到 deepseek-chat', { harnessText: 'codex', requestModelName: 'reasoning', modelQuery: 'deepseek-chat' }],
  ['请求名映射 deepseek harness long-ctx 用 x', { harnessText: 'deepseek harness', requestModelName: 'long-ctx', modelQuery: 'x' }],
];
for (const [text, expected] of cases) {
  const { cmd, args } = matchCommand(text);
  assert.strictEqual(cmd?.id, 'request_model_binding', `应命中映射命令: ${text}`);
  assert.deepStrictEqual(args, expected, `解析结果不符: ${text}`);
}

// 仅写 Harness、没有请求名时不应把 Harness 的第二个词当成请求名。
assert.strictEqual(matchCommand('请求名映射 claude code 用 x').args.requestModelName, '', '缺少请求名时不应吞掉 Harness 名称');

console.log('PASS request model binding validation and command parsing');
