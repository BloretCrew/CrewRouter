'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runPagedTui } = require('../tui/engine');
const { terminal, tick, until } = require('./helpers/tty');

const page = (id, label, load) => ({ id, label, description: '详情', load });

test('mouse clicks switch pages and activate action rows', { timeout: 15000 }, async () => {
  const tty = terminal(80, 20);
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
  tty.input.write('\x1b[<0;3;4M');
  await until(() => tty.screen().includes('修改配置'));
  tty.input.write('\x1b[<0;27;7M');
  await until(() => tty.screen().includes('请核对'));
  tty.input.write('\r');
  await tick();
  assert.equal(executed, 0);
  tty.input.write('q');
  await task;
  assert.equal(tty.input.isRaw, false);
});

test('mouse clicks switch tabs before content hit testing', { timeout: 15000 }, async () => {
  const tty = terminal(100, 20);
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
  tty.input.write('\x1b[<0;27;2M');
  await until(() => tty.screen().includes('网络限制未生效'));
  tty.input.write('\x1b[<0;12;2M');
  await until(() => tty.screen().includes('自动监测状态'));
  tty.input.write('q');
  await task;
});

test('modal form masks password and can be cancelled with a mouse click', { timeout: 15000 }, async () => {
  const tty = terminal(80, 20);
  let received;
  const pages = [page('a', '概览', async () => ({ sections: [], actions: [{ label: '登录', run: async ctx => {
    received = await ctx.form('登录', [
      { name: 'user', label: '账号' },
      { name: 'pass', label: '密码', secret: true },
    ], { submitLabel: '登录' });
  } }] }))];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, authenticate: async () => true });
  await until(() => tty.screen().includes('[登录]'));
  tty.input.write('\t\x1b[B\r');
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
  tty.input.write('\x1b');
  await tick(200);
  tty.input.write('q');
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
  tty.input.write(`\x1b[<0;66;15M`);
  await until(() => loads >= 2);
  tty.input.write(`\x1b[<0;78;15M`);
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
  tty.input.write('\x1b[<0;2;1M');
  await until(() => tty.screen().includes('服务/连接') || tty.screen().includes('设置'));
  tty.input.write('\x1b[<0;3;4M');
  await until(() => tty.screen().includes('窄屏设置项'));
  tty.input.write('q');
  await task;
});
