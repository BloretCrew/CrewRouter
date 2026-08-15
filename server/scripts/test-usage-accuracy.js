/**
 * 调用记录准确性相关单元测试（驱动真实 shipped 模块）
 * 运行: node server/scripts/test-usage-accuracy.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  normalizeRequestType,
  buildUsageLogsFilter,
  buildUserUsageLogsFilter,
  ALLOWED_REQUEST_TYPES
} = require('../utils/usage-logs-filter');
const { calculatePointsToDeduct } = require('../utils/points-deduct');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  PASS', name);
}

async function main() {
  console.log('== usage-logs-filter ==');

  assert.strictEqual(normalizeRequestType('chat'), 'chat');
  assert.strictEqual(normalizeRequestType('PLAYGROUND'), 'playground');
  assert.strictEqual(normalizeRequestType('bogus'), null);
  assert.strictEqual(normalizeRequestType(''), null);
  ok('normalizeRequestType allows only known types');

  const adminNone = buildUsageLogsFilter({});
  assert.ok(!adminNone.where.includes('request_type'), 'no type filter by default');
  assert.strictEqual(adminNone.requestType, null);
  ok('admin filter without request_type is compatible');

  const adminPg = buildUsageLogsFilter({ request_type: 'playground' });
  assert.ok(adminPg.where.includes('u.request_type = $'), adminPg.where);
  assert.ok(adminPg.params.includes('playground'));
  assert.strictEqual(adminPg.requestType, 'playground');
  ok('admin filter request_type=playground');

  const adminChat = buildUsageLogsFilter({ request_type: 'chat', user_id: '1' });
  assert.ok(adminChat.where.includes('u.request_type = $'));
  assert.ok(adminChat.params.includes('chat'));
  assert.ok(adminChat.params.includes('1') || adminChat.params.includes(1));
  ok('admin filter request_type=chat with user_id');

  const adminProvider = buildUsageLogsFilter({ provider_q: 'OpenAI' });
  assert.ok(adminProvider.where.includes('p.name ILIKE'), adminProvider.where);
  assert.ok(adminProvider.params.some(p => String(p).includes('OpenAI')));
  ok('admin filter provider_q');

  const userPg = buildUserUsageLogsFilter(42, { request_type: 'responses' });
  assert.ok(userPg.where.startsWith('WHERE u.user_id = $1'));
  assert.strictEqual(userPg.params[0], 42);
  assert.ok(userPg.where.includes('u.request_type = $'));
  assert.ok(userPg.params.includes('responses'));
  ok('user filter request_type=responses');

  const userNone = buildUserUsageLogsFilter(7, {});
  assert.ok(!userNone.where.includes('request_type'));
  ok('user filter without request_type');

  assert.ok(ALLOWED_REQUEST_TYPES.has('fusion'));
  ok('allowed types include fusion');

  console.log('== points-deduct ==');

  // 无 groupId：直接返回理论积分（不查库）
  const full = await calculatePointsToDeduct({
    userId: 1, groupId: null, weightedTokens: 5000000, pointsCost: 5
  });
  assert.strictEqual(full, 5);
  ok('no groupId → full pointsCost');

  // 配额未耗尽 → 实扣 0
  const free = await calculatePointsToDeduct(
    { userId: 1, groupId: 9, weightedTokens: 1000000, pointsCost: 1 },
    {
      checkQuotaRules: async () => [
        { rule_type: 'tokens', exceeded: false, used: 0, limit: 100, remaining: 100 }
      ]
    }
  );
  assert.strictEqual(free, 0);
  ok('quota remaining → deduct 0');

  // 配额全耗尽 → 按加权 token / 1e6
  const paid = await calculatePointsToDeduct(
    { userId: 1, groupId: 9, weightedTokens: 2500000, pointsCost: 99 },
    {
      checkQuotaRules: async () => [
        { rule_type: 'tokens', exceeded: true, used: 100, limit: 100, remaining: 0 }
      ]
    }
  );
  assert.strictEqual(paid, 2.5);
  ok('quota exhausted → weighted/1e6');

  // 无规则 → 理论积分
  const noRules = await calculatePointsToDeduct(
    { userId: 1, groupId: 9, weightedTokens: 1000, pointsCost: 0.5 },
    { checkQuotaRules: async () => null }
  );
  assert.strictEqual(noRules, 0.5);
  ok('null rules → pointsCost');

  console.log('== static source contracts ==');

  const playgroundSrc = fs.readFileSync(path.join(__dirname, '../routes/playground.js'), 'utf8');
  assert.ok(playgroundSrc.includes("require('../utils/points-deduct')"));
  assert.ok(playgroundSrc.includes('calculatePointsToDeduct'));
  assert.ok(playgroundSrc.includes('SET history_hidden = TRUE'));
  assert.ok(!/DELETE\s+FROM\s+usage_records/i.test(playgroundSrc));
  ok('playground uses points-deduct and soft-hides history');

  const apiSrc = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
  assert.ok(apiSrc.includes("require('../utils/points-deduct')"));
  assert.ok(apiSrc.includes('estimate_method'));
  assert.ok(apiSrc.includes("estimated: true") || apiSrc.includes('estimated: true'));
  assert.ok(apiSrc.includes('recordQuotaData'));
  // 流式透传路径必须 INSERT usage_records
  assert.ok(apiSrc.includes('[Responses/Passthru] 计费/用量记录失败'));
  ok('api responses passthru has estimated + insert path');

  // Fusion 分项汇总
  assert.ok(apiSrc.includes('fusionPromptTokens'));
  assert.ok(apiSrc.includes('accumulateUsage'));
  ok('fusion accumulates prompt/completion separately');

  const adminSrc = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  assert.ok(adminSrc.includes('buildUsageLogsFilter'));
  assert.ok(adminSrc.includes('usage-logs-filter'));
  assert.ok(adminSrc.includes("router.get('/stats/multi'"));
  assert.ok(adminSrc.includes('combinations'));
  assert.ok(adminSrc.includes('relationships'));
  ok('admin exposes multi-dimensional statistics contract');

  const userSrc = fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8');
  assert.ok(userSrc.includes('buildUserUsageLogsFilter'));
  ok('user uses shared filter');

  console.log(`\nAll ${passed} assertions passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
