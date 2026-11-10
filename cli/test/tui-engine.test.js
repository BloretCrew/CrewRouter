'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runPagedTui } = require('../tui/engine');
const { terminal, tick, until, findText, findAnsiText, clickText, clickAnsiText } = require('./helpers/tty');

const page = (id, label, load) => ({ id, label, description: '详情', load });

test('mouse clicks switch pages and activate action rows', { timeout: 15000 }, async () => {
  const tty = terminal(120, 24);
  let executed = 0;
  const pages = [
    page('a', '概览', async () => ({ sections: [{ title: '首页', rows: [{ label: '主机在线' }] }], actions: [] })),
    page('b', '设置', async () => ({
      sections: [{ title: '设置项', rows: [{ label: '修改配置', run: async ctx => { if (await ctx.confirm('确定修改', '请核对')) executed++; } }] }],
      actions: [],
    })),
  ];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, authenticate: async () => true });
  await until(() => tty.screen().includes('主机在线'));
  await clickText(tty, '设置');
  await until(() => tty.screen().includes('修改配置'));
  await clickText(tty, '修改配置');
  await until(() => tty.screen().includes('请核对'));
  tty.input.write('\r');
  await tick();
  assert.equal(executed, 1);
  tty.input.write('q');
  await task;
  assert.equal(tty.input.isRaw, false);
});

test('mouse clicks switch tabs before content hit testing', { timeout: 15000 }, async () => {
  const tty = terminal(120, 24);
  const tabbed = {
    id: 'security',
    label: '系统设置',
    description: '安全控制与网络策略',
    tabs: [{ id: 'controls', label: '安全控制' }, { id: 'network', label: '网络策略' }],
    async load() {
      return {
        sections: [
          { title: '控件状态', tab: 'controls', rows: [{ label: '自动监测状态' }] },
          { title: '网络草案', tab: 'network', rows: [{ label: '网络限制未生效' }] },
        ],
        actions: [],
      };
    },
  };
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages: [tabbed], authenticate: async () => true });
  await until(() => tty.screen().includes('自动监测状态'));
  await clickText(tty, '网络策略');
  await until(() => tty.screen().includes('网络限制未生效'));
  await clickText(tty, '安全控制');
  await until(() => tty.screen().includes('自动监测状态'));
  tty.input.write('q');
  await task;
});

test('modal form masks password and can be cancelled with a mouse click', { timeout: 15000 }, async () => {
  const tty = terminal(120, 24);
  let received;
  const pages = [page('a', '概览', async () => ({ sections: [], actions: [{ label: '打开表单', run: async ctx => {
    received = await ctx.form('登录', [
      { name: 'user', label: '账号' },
      { name: 'pass', label: '密码', secret: true },
    ], { submitLabel: '登录' });
  } }] }))];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, authenticate: async () => true });
  await until(() => findText(tty, '打开表单'));
  await clickText(tty, '打开表单');
  await until(() => tty.screen().includes('账号'));
  tty.input.write('alice\rsecret-password');
  await tick(20);
  assert.ok(!tty.screen().includes('secret-password'));
  tty.input.write('\r');
  await until(() => received !== undefined);
  assert.deepEqual(received, { user: 'alice', pass: 'secret-password' });
  await tick(80);

  tty.input.write('\r');
  await until(() => tty.screen().includes('账号'));
  await clickAnsiText(tty, '取消');
  await tick(300);
  tty.input.write('\x03');
  await task;
});

test('resize keeps a long list navigable', { timeout: 15000 }, async () => {
  const tty = terminal(100, 24);
  const pages = [page('a', '告警', async () => ({
    sections: [{ title: '最新告警', rows: Array.from({ length: 500 }, (_, i) => ({ label: `告警 ${i}` })) }],
    actions: [],
  }))];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, authenticate: async () => true });
  await until(() => tty.screen().includes('告警 0'));
  tty.output.columns = 48;
  tty.output.rows = 12;
  tty.output.emit('resize');
  tty.input.write('\x1b[6~');
  await tick(20);
  assert.ok(!tty.screen().includes('告警 0'));
  tty.input.write('q');
  await task;
});

test('401 clears cached page data and re-authenticates', { timeout: 15000 }, async () => {
  const tty = terminal(100, 24);
  let logins = 0;
  let loads = 0;
  const pages = [page('a', '概览', async () => {
    loads++;
    if (loads === 1) return { sections: [{ title: '数据', rows: [{ label: '旧会话私有内容' }] }], actions: [] };
    if (loads === 2) throw Object.assign(new Error('expired'), { statusCode: 401 });
    return { sections: [{ title: '数据', rows: [{ label: '新会话内容' }] }], actions: [] };
  })];
  const task = runPagedTui({
    ...tty,
    env: { NO_COLOR: '1' },
    api: async () => ({}),
    pages,
    authenticate: async () => { logins++; return true; },
  });
  await until(() => tty.screen().includes('旧会话私有内容'));
  tty.input.write('r');
  await until(() => logins === 2);
  await until(() => tty.screen().includes('新会话内容'));
  assert.ok(!tty.screen().includes('旧会话私有内容'));
  tty.input.write('q');
  await task;
});

test('footer refresh and quit buttons are clickable', { timeout: 15000 }, async () => {
  const tty = terminal(80, 16);
  let loads = 0;
  const pages = [page('a', '概览', async () => { loads++; return { sections: [{ title: `数据 ${loads}`, rows: [] }], actions: [] }; })];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, authenticate: async () => true });
  await until(() => tty.screen().includes('数据 1'));
  await clickText(tty, 'r 刷新');
  await until(() => loads >= 2);
  await clickText(tty, 'q 退出');
  await task;
});

test('compact terminals expose a clickable full-width menu', { timeout: 15000 }, async () => {
  const tty = terminal(60, 16);
  const pages = [
    page('a', '概览', async () => ({ sections: [{ title: '首页', rows: [{ label: '窄屏内容' }] }], actions: [] })),
    page('b', '设置', async () => ({ sections: [{ title: '设置', rows: [{ label: '窄屏设置项' }] }], actions: [] })),
  ];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, authenticate: async () => true });
  await until(() => tty.screen().includes('[菜单]'));
  await clickText(tty, '[菜单]');
  await until(() => findText(tty, '设置'));
  await clickText(tty, '设置');
  await until(() => tty.screen().includes('窄屏设置项'));
  tty.input.write('q');
  await task;
});

test('dialog traffic lights minimize, restore, maximize and close', { timeout: 15000 }, async () => {
  const tty = terminal(120, 24);
  let picked = 'pending';
  const pages = [{ id: 'a', label: '概览', description: '详情', async load() {
    return {
      sections: [],
      actions: [{ label: '选择操作', run: async ctx => { picked = await ctx.choose('选择', [{ label: '选项甲', value: 'a' }, { label: '选项乙', value: 'b' }]); } }],
    };
  } }];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, authenticate: async () => true });
  await clickText(tty, '选择操作');
  await until(() => findAnsiText(tty, '选项甲'));

  await clickAnsiText(tty, '●', 2);
  await tick(80);
  await clickAnsiText(tty, '●', 1);
  await until(() => !findAnsiText(tty, '选项甲'));
  await clickAnsiText(tty, '●', 1);
  await until(() => findAnsiText(tty, '选项甲'));

  await clickAnsiText(tty, '●', 0);
  await tick(100);
  assert.equal(picked, null);
  tty.input.write('q');
  await task;
});
