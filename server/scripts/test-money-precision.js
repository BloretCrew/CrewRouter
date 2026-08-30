'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  addMoney,
  compareMoney,
  moneyToApiNumber,
  moneyToString,
  subtractMoney,
  toMoneyMicros,
} = require('../utils/money');

const migration = fs.readFileSync(path.join(__dirname, '../../scripts/migrate-money-precision.js'), 'utf8');
const requiredTargets = [
  'users.*balance', 'users.*refund_balance', 'users.*alert_balance_threshold', 'users.*alert_daily_usage_threshold',
  'usage_records.*cost', 'quota_data.*quota', 'redemption_codes.*amount', 'products.*price',
  'fusion_usage_records.*total_cost', 'usage_message_analysis.*cost', 'user_code_balances.*amount',
  'balance_preconsumes.*amount', 'balance_preconsumes.*actual_amount',
  'models.*input_price_per_1k_tokens', 'models.*output_price_per_1k_tokens',
  'models.*cached_output_price_per_1k_tokens', 'models.*reference_input_price_per_1k_tokens',
  'models.*reference_output_price_per_1k_tokens', 'models.*reference_cached_output_price_per_1k_tokens',
  'models.*model_price',
];
for (const target of requiredTargets) {
  const [table, column] = target.split('.*');
  assert.ok(migration.includes(`['${table}', '${column}']`), `migration target ${target}`);
}
assert.ok(migration.includes("const BACKUP_TABLE = 'money_precision_backups';"));
assert.ok(migration.includes("没有可回滚的已应用备份记录"));
assert.ok(!migration.includes("oldType: 'NUMERIC(10,6)'"));
assert.ok(!migration.includes('fee_rate'));
assert.ok(migration.includes("['models', 'model_price']"));
assert.ok(migration.includes("old_type_sql"));
assert.strictEqual(moneyToString('0.1234564'), '0.123456');
assert.strictEqual(moneyToString('0.1234565'), '0.123457');
assert.strictEqual(moneyToString('999999999999999999999999.999999'), '999999999999999999999999.999999');
assert.strictEqual(moneyToString('-0.0000005'), '-0.000001');
assert.strictEqual(moneyToString('1e-6'), '0.000001');
assert.strictEqual(moneyToString('1.2e+3'), '1200.000000');

assert.strictEqual(moneyToString(0.1), '0.100000');
assert.strictEqual(toMoneyMicros(0.000001), 1n);
assert.strictEqual(moneyToString(0.0000004), '0.000000');
assert.strictEqual(moneyToString(0.0000005), '0.000001');
assert.strictEqual(moneyToString('999999999999999999.123456'), '999999999999999999.123456');
assert.strictEqual(addMoney('0.1', '0.2'), '0.300000');
assert.strictEqual(subtractMoney('1000000000000.000001', '0.000001'), '1000000000000.000000');
assert.strictEqual(addMoney('1.234567', '0.100001'), '1.334568');
assert.strictEqual(compareMoney('0.300000', 0.1 + 0.2), 0);
assert.strictEqual(moneyToApiNumber('0.100000'), 0.1);
assert.strictEqual(addMoney('0.1', '0.000001'), '0.100001');
assert.strictEqual(subtractMoney('100000000000000000000000.000000', '0.000001'), '99999999999999999999999.999999');
assert.strictEqual(compareMoney('0.000001', 0.000001), 0);

// 退款：预扣 0.3，实际 0.1，应精确退回 0.2。
const refund = subtractMoney('0.300000', '0.100000');
assert.strictEqual(refund, '0.200000');
assert.strictEqual(addMoney('9.700000', refund), '9.900000');

console.log('money precision boundary tests passed');
