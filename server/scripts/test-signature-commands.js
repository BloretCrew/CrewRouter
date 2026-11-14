'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
function fixture({ fail = false, empty = false, userEnabled = true, missing = false } = {}) {
  const events = [], audits = [];
  const row = { id: 9, signature_enabled: null, signature_template: null, api_signature_enabled: userEnabled, api_signature_template: empty ? '' : 'private template' };
  const coreModule = { exports: {} };
  vm.runInNewContext(read('../utils/api-signature.js'), { module: coreModule, require: () => ({}), Buffer, process });
  const module = { exports: {} };
  vm.runInNewContext(read('../utils/crewrouter-command.js'), {
    module, Buffer, process,
    require(name) {
      if (name === '../models/database') return { pool: { async query(sql, params) {
        if (sql.startsWith('UPDATE api_keys')) {
          events.push('WRITE');
          if (fail) throw new Error('database rejected write');
          if (missing) return { rows: [] };
          row.signature_enabled = params[0];
          return { rows: [{ id: 9 }] };
        }
        if (sql.includes('FROM api_keys ak')) return { rows: [{ ...row }] };
        return { rows: [] };
      } } };
      if (name === './api-signature') return coreModule.exports;
      if (name === './audit-log') return { ACTIONS: { API_KEY_SIGNATURE: 'api_key.signature' }, async logAction(event) { events.push('AUDIT'); audits.push(event); } };
      if (name === '../routes/api') return { async invalidateApiKeyCacheByKeyId(id) { events.push(`CACHE:${id}`); } };
      if (name === '../logger') return { warn() {} };
      if (name === './request-source') return { HARNESS_SOURCES: [], sourceLabel: x => x };
      return {};
    }
  });
  const apiUser = { userId: 1, keyId: 9, username: 'test', signature: { userEnabled: !userEnabled } };
  return { events, audits, row, parse(command) { return module.exports.parseRequest({ messages: [{ role: 'user', content: `@CrewRouter ${command}` }] }); },
    async run(command) {
      const parsed = this.parse(command);
      assert.equal(parsed.cmd?.id, command.includes('config') || command.includes('配置') ? 'signature_config' : 'signature');
      return parsed.cmd.run({ req: { ip: '127.0.0.1' }, apiUser, args: parsed.args });
    }
  };
}

test('英文和中文前后置 on/off/inherit 解析及实际命令写入', async () => {
  for (const [expected, commands] of [
    [true, ['signature on', 'on signature', 'signature enable', 'enable signature', '开启签名', '签名开启', '启用签名', 'signature true']],
    [false, ['signature off', 'off signature', 'signature disable', 'disable signature', '关闭签名', '签名关闭', '禁用签名', 'signature false']],
    [null, ['signature inherit', 'inherit signature', '签名继承', '继承签名', '跟随用户默认签名', '签名跟随默认']]
  ]) {
    for (const command of commands) {
      const f = fixture();
      const reply = await f.run(command);
      assert.equal(f.row.signature_enabled, expected, command);
      assert.equal(f.events[0], 'WRITE');
      assert.equal(f.events[1], 'CACHE:9');
      assert.equal(f.audits[0].details.signature_enabled, expected);
      assert.equal(f.audits[0].resourceId, '9');
      assert(reply.includes(expected === null ? '继承用户默认' : expected ? '已开启签名' : '已关闭签名'));
      assert(!reply.includes('private template'));
    }
  }
});

test('不合法命令不能误识别 inherit/off 前缀并写库', async () => {
  for (const command of ['signature', 'signature offset', 'signature inherit nonsense', 'signature on off', 'signature inherited']) {
    const f = fixture();
    const reply = await f.run(command);
    assert(reply.includes('用法不对'), command);
    assert.equal(f.events.length, 0, command);
    assert.equal(f.audits.length, 0);
  }
});

test('命令继承状态读取实时发起者默认值而非请求旧缓存', async () => {
  for (const userEnabled of [true, false]) {
    const f = fixture({ userEnabled });
    const reply = await f.run('signature inherit');
    assert(reply.includes(`当前：${userEnabled ? '开' : '关'}`));
    assert(reply.includes('模板已配置'));
  }
});

test('命令与签名配置说明空模板不会附加内容且不回显敏感模板', async () => {
  const f = fixture({ empty: true });
  assert((await f.run('signature on')).includes('模板为空，不附加签名'));
  const config = await f.run('signature config');
  assert(config.includes('模板为空，不附加签名'));
  assert((await fixture().run('签名配置')).includes('模板内容不在指令中回显'));
});

test('数据库失败/密钥不存在不失效缓存或写成功审计', async () => {
  for (const options of [{ fail: true }, { missing: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run('signature off'));
    assert.deepEqual(f.events, ['WRITE']);
    assert.equal(f.audits.length, 0);
  }
});
