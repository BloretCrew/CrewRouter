'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../routes/playground.js'), 'utf8');
const start = source.indexOf('    const userResult = await pool.query(');
const end = source.indexOf('    let modelResult', start);
assert(start > 0 && end > start);
function pointsPolicy(rules) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/points-deduct.js'), 'utf8'), {
    module, require(id) {
      if (id === '../models/database') return { pool: {} };
      if (id === './quota-data') return { getUserQuotaBuffer: () => [] };
      if (id === './money') return require('../utils/money');
      throw new Error('Unexpected fixture dependency: ' + id);
    },
  });
  return args => module.exports.canConsumePoints(args, { checkQuotaRules: async () => rules });
}
test('Playground preflight uses the same points/quota policy as gateway and settlement', async () => {
  for (const [account, rules, allowed] of [
    [{ balance: 0, refund_balance: 100, team_id: 1 }, [{ exceeded: true }, { exceeded: false }], true],
    [{ balance: 0, refund_balance: 100, team_id: 1 }, [{ exceeded: true }], false],
    [{ balance: '0.000001', team_id: null }, null, true],
    [{ balance: 0, team_id: null }, null, false],
    [{ balance: -1, team_id: 1 }, [], false],
    [null, null, false],
  ]) {
    let rejected = false;
    const context = vm.createContext({ userId: 7,
      pool: { query: async (sql, args) => {
        assert.equal(sql, 'SELECT balance, team_id FROM users WHERE id = $1');
        assert.equal(args[0], 7);
        return { rows: account ? [account] : [] };
      } },
      canConsumePoints: pointsPolicy(rules), notifyUser: async () => {}, NOTIFICATION_TYPES: {},
      res: { status(code) { assert.equal(code, 402); rejected = true; return this; }, json(value) { assert.equal(value.error, '配额已用尽且积分不足'); } },
    });
    const result = await vm.runInContext(`(async () => {${source.slice(start, end)} return 'allowed';})()`, context);
    assert.equal(result === 'allowed', allowed, JSON.stringify({ account, rules }));
    assert.equal(rejected, !allowed);
  }
});
