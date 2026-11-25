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

test('console and admin are top-level tabs whose sidebars swap after verified admin auth', { timeout: 15000 }, async () => {
  const tty = terminal(120, 28);
  let isAdmin = null;
  let authenticated;
  const authReady = new Promise(resolve => { authenticated = resolve; });
  const pages = [
    page('admin-last', '最后管理页', async () => ({ sections: [{ title: '最后管理内容', rows: [] }], actions: [] })),
    page('console-home', '控制台首页', async () => ({ sections: [{ title: '控制台内容', rows: [] }], actions: [] })),
    page('admin-home', '后台首页', async () => ({ sections: [{ title: '后台内容', rows: [] }], actions: [] })),
  ];
  const navGroups = [
    { id: 'console', label: '控制台', pages: ['console-home'] },
    { id: 'admin', label: '管理后台', pages: ['admin-home'] },
    { id: 'admin-subpages', label: '管理子页面', pages: ['admin-last'] },
  ];
  const navAreas = [
    { id: 'console', label: '控制台', groups: ['console'] },
    { id: 'admin', label: '管理后台', groups: ['admin', 'admin-subpages'], adminOnly: true },
  ];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, navGroups, navAreas, canEnterAdmin: () => isAdmin === true, authenticate: async () => { await authReady; return true; } });
  try {
    await until(() => tty.screen().includes('[控制台]'));
    assert.ok(!tty.screen().includes('管理后台'));
    isAdmin = true;
    authenticated();
    await until(() => tty.screen().includes('管理后台') && tty.screen().includes('控制台首页'));
    assert.ok(!tty.screen().includes('后台首页'), 'admin children stay hidden while console tab is selected');
    await clickText(tty, '管理后台');
    await until(() => tty.screen().includes('[管理后台]') && tty.screen().includes('后台内容'));
    assert.ok(tty.screen().includes('后台首页'));
    assert.ok(tty.screen().includes('管理子页面'));
    assert.ok(!tty.screen().includes('控制台首页'), 'admin tab replaces console children');
    await clickText(tty, '控制台');
    await until(() => tty.screen().includes('[控制台]') && tty.screen().includes('控制台内容'));
    assert.ok(!tty.screen().includes('后台首页'));
  } finally { tty.input.write('q'); await task; }
});

test('non-admins cannot display or switch to the admin top-level tab', { timeout: 15000 }, async () => {
  const tty = terminal(120, 28);
  const pages = [
    page('console-home', '控制台首页', async () => ({ sections: [{ title: '用户控制台数据', rows: [] }], actions: [] })),
    page('admin-home', '后台首页', async () => ({ sections: [{ title: '管理员数据', rows: [] }], actions: [] })),
  ];
  const navGroups = [{ id: 'console', pages: ['console-home'] }, { id: 'admin', pages: ['admin-home'] }];
  const navAreas = [{ id: 'console', label: '控制台', groups: ['console'] }, { id: 'admin', label: '管理后台', groups: ['admin'], adminOnly: true }];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, navGroups, navAreas, canEnterAdmin: () => false, authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('用户控制台数据'));
    assert.ok(tty.screen().includes('[控制台]'));
    assert.ok(!tty.screen().includes('管理后台'));
    assert.ok(!tty.screen().includes('管理员数据'));
  } finally { tty.input.write('q'); await task; }
});

test('compact menu allows switching top-level areas and their children', { timeout: 15000 }, async () => {
  const tty = terminal(60, 18);
  const pages = [
    page('console-home', '控制台首页', async () => ({ sections: [{ title: '用户控制台数据', rows: [] }], actions: [] })),
    page('admin-home', '后台首页', async () => ({ sections: [{ title: '管理员后台数据', rows: [] }], actions: [] })),
  ];
  const navGroups = [{ id: 'console', label: '控制台', pages: ['console-home'] }, { id: 'admin', label: '管理后台', pages: ['admin-home'] }];
  const navAreas = [{ id: 'console', label: '控制台', groups: ['console'] }, { id: 'admin', label: '管理后台', groups: ['admin'], adminOnly: true }];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, navGroups, navAreas, canEnterAdmin: () => true, authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('用户控制台数据'));
    await clickText(tty, '[菜单]');
    await until(() => tty.screen().includes('管理后台'));
    await clickText(tty, '管理后台');
    await until(() => tty.screen().includes('管理员后台数据'));
  } finally { tty.input.write('q'); await task; }
});

test('vertical navigation follows the displayed navigation groups rather than page registration order', { timeout: 15000 }, async () => {
  const tty = terminal(100, 24);
  const pages = [
    page('last', '第三页', async () => ({ sections: [{ title: '页面内容', rows: [{ label: '第三页内容' }] }], actions: [] })),
    page('first', '第一页', async () => ({ sections: [{ title: '页面内容', rows: [{ label: '第一页内容' }] }], actions: [] })),
    page('middle', '第二页', async () => ({ sections: [{ title: '页面内容', rows: [{ label: '第二页内容' }] }], actions: [] })),
  ];
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages, navGroups: [{ id: 'ordered', label: '菜单顺序', pages: ['first', 'middle', 'last'] }], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('第三页内容'));
    tty.input.write('\x1b[A');
    await until(() => tty.screen().includes('第二页内容'));
    assert.ok(tty.screen().includes('✦ CrewRouter  ·  第二页'));
    tty.input.write('\x1b[B');
    await until(() => tty.screen().includes('第三页内容'));
    assert.ok(tty.screen().includes('✦ CrewRouter  ·  第三页'));
  } finally { tty.input.write('q'); await task; }
});

test('pages marked loadOnTabChange reload data for the selected web view', { timeout: 15000 }, async () => {
  const tty = terminal(120, 24);
  const calls = [];
  const tabbed = {
    id: 'stats', label: '统计信息', loadOnTabChange: true,
    tabs: [{ id: 'overview', label: '概览' }, { id: 'models', label: '模型' }],
    tab: 'overview',
    onTabChange(tab) { this.tab = tab.id; },
    async load() { calls.push(this.tab); return { sections: [{ title: this.tab === 'models' ? '模型分布' : '统计概览', rows: [] }] }; },
  };
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages: [tabbed], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('统计概览'));
    await clickText(tty, '模型');
    await until(() => tty.screen().includes('模型分布'));
    assert.deepEqual(calls, ['overview', 'models']);
  } finally { tty.input.write('q'); await task; }
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
