'use strict';

const assert = require('assert');
const {
  addMoney,
  compareMoney,
  moneyToApiNumber,
  moneyToString,
  subtractMoney,
  toMoneyMicros,
} = require('../utils/money');

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

// 退款：预扣 0.3，实际 0.1，应精确退回 0.2。
const refund = subtractMoney('0.300000', '0.100000');
assert.strictEqual(refund, '0.200000');
assert.strictEqual(addMoney('9.700000', refund), '9.900000');

console.log('money precision boundary tests passed');
