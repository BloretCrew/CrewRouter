'use strict';

// 真正注册并调用路由 handler；VM 内的核心模块仅替换外部依赖，不连接数据库。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
function loadCore() {
  const module = { exports: {} };
  vm.runInNewContext(read('../utils/api-signature.js'), {
    module, exports: module.exports, Buffer, process,
    require(name) {
      if (name === '../models/database') return { pool: {} };
      return {};
    }
  });
  return module.exports;
}
const core = loadCore();
const source = read('../routes/user.js');
function declaration(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = source.indexOf('\n}', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 2);
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function fixture({ failWrite = false, failCommit = false, access = true, demo = false } = {}) {
  const handlers = {}, writes = [], events = [], audits = [];
  const owner = { api_signature_enabled: true, api_signature_template: 'owner default' };
  const key = { id: 9, signature_enabled: null, signature_template: null };
  let userSettings = { ...owner };
  let staged;
  const query = async (sql, params) => {
    events.push(sql);
    if (sql === 'BEGIN') { staged = { ...key }; return {}; }
    if (sql === 'COMMIT') {
      if (failCommit) throw new Error('commit failed');
      Object.assign(key, staged); staged = null; return {};
    }
    if (sql === 'ROLLBACK') { staged = null; return {}; }
    if (sql.includes('AS can_manage')) return { rows: access ? [{ can_manage: true, is_owner: false, owner_user_id: 1 }] : [] };
    if (sql.startsWith('UPDATE')) {
      if (failWrite) throw new Error('write failed');
      writes.push({ sql, params: [...params] });
      if (sql.includes('UPDATE api_keys')) {
        Object.assign(staged || key, { signature_enabled: params[0], signature_template: params[1] });
      }
      return { rows: [{ id: 9 }], rowCount: 1 };
    }
    if (sql.includes('FROM api_keys ak')) {
      assert(sql.includes('owner.id = ak.user_id'), '必须读取发起者而非 Co-Key 成员默认');
      return { rows: [{ ...key, ...owner }] };
    }
    if (sql.includes('FROM users')) return { rows: [{ ...owner }] };
    return { rows: [{ id: 9 }] };
  };
  const router = {};
  for (const verb of ['get', 'put', 'post', 'delete', 'patch', 'use', 'all']) {
    router[verb] = (route, ...fns) => { handlers[`${verb} ${route}`] ||= fns; };
  }
  const context = {
    ...core, router, requireAuth() {}, ACTIONS: {},
    auditMiddleware(_action, options) { return (req, res) => { req.auditOptions = options; }; },
    normalizeEmail: value => value?.toLowerCase(), isUniqueViolation: () => false,
    Logger: { error() {}, warn() {}, info() {} },
    pool: { query, async connect() { events.push('CONNECT'); return { query, release() { events.push('RELEASE'); } }; } },
    invalidateUserApiKeyCache(id) { events.push(`user-cache:${id}`); },
    invalidateApiKeyCacheByKeyId(id) { events.push(`key-cache:${id}`); },
  };
  if (demo) {
    context.require = name => {
      if (name === 'express') return { Router: () => router };
      if (name === './data') return {
        apiKeys: () => [key], settings: () => ({ ...userSettings }),
        updateSignatureSettings({ enabled, template }) {
          writes.push({ enabled, template });
          userSettings = { api_signature_enabled: enabled, api_signature_template: template };
        }
      };
      if (name === '../utils/api-signature') return core;
      throw new Error(`unexpected import ${name}`);
    };
    context.module = { exports: {} };
    vm.runInNewContext(read('../demo/routes.js'), context);
  } else {
    const helpers = ['getApiKeyAccess', 'withApiKeyWrite', 'validateSignatureSettings', 'keySignatureResponse', 'saveUserSettings'].map(declaration).join('\n');
    const keyStart = source.indexOf("router.get('/api-keys/:id/signature'");
    const keyEnd = source.indexOf('// 切换 API Key 启用/禁用状态', keyStart);
    const userStart = source.indexOf("router.get('/signature'");
    const userEnd = source.indexOf('// ========== 兑换码', userStart);
    vm.runInNewContext(helpers + '\n' + source.slice(keyStart, keyEnd) + '\n' + source.slice(userStart, userEnd), context);
  }
  return { writes, events, audits, key, owner, async request(route, body, user = { id: 7, ...owner, api_signature_template: 'member default' }) {
    const req = { body, authUser: user, params: { id: 9 } }, res = response();
    const fns = handlers[route];
    assert(fns, route);
    for (const fn of fns.slice(0, -1)) await fn(req, res, () => {});
    await fns.at(-1)(req, res);
    if (res.statusCode < 400 && req.auditOptions) audits.push(req.auditOptions.detailsFrom?.(req));
    return { res, user };
  } };
}

for (const demo of [false, true]) {
  const mode = demo ? 'Demo' : '生产 handler';
  test(`${mode}: new/legacy 完整 Key PUT、三态与 GET 兼容`, async () => {
    for (const enabled of [true, false, null]) {
      for (const body of [{ enabled, template: '  custom  ' }, { signature_enabled: enabled, signature_template: ' custom ' }, { key_signature_enabled: enabled, key_signature_template: 'custom' }]) {
        const f = fixture({ demo });
        const { res } = await f.request('put /api-keys/:id/signature', body);
        assert.equal(res.statusCode, 200);
        assert.equal(f.key.signature_enabled, enabled);
        assert.equal(f.key.signature_template, 'custom');
        assert.equal(res.body.enabled, enabled);
        const get = (await f.request('get /api-keys/:id/signature')).res.body;
        assert.equal(get.key_signature_enabled, enabled);
        assert.equal(get.key_signature_template, 'custom');
        assert.equal(get.inherited.template, 'owner default');
        assert.equal(get.effective.enabled, enabled === null ? true : enabled);
      }
    }
  });
  test(`${mode}: 缺失、非法、冲突或超长输入绝不写入`, async () => {
    for (const route of ['put /signature', 'put /api-keys/:id/signature']) {
      for (const body of [undefined, {}, { enabled: true }, { template: 'x' }, { enabled: 'off', template: '' }, { enabled: true, template: {} }, { enabled: true, template: 'x'.repeat(2001) }, { enabled: true, signature_enabled: false, template: '' }, { enabled: undefined, template: '' }]) {
        const f = fixture({ demo });
        const { res } = await f.request(route, body);
        assert.equal(res.statusCode, 400, JSON.stringify(body));
        assert.equal(f.writes.length, 0);
        assert(!f.events.includes('CONNECT'));
        assert(!f.events.some(event => event.includes('cache:')));
      }
    }
  });
  test(`${mode}: 用户完整 PUT 与旧 settings 部分更新`, async () => {
    const f = fixture({ demo });
    const put = (await f.request('put /signature', { enabled: false, template: '  trimmed  ' })).res;
    assert.equal(put.body.template, 'trimmed');
    assert.equal(put.body.enabled, false);
    await f.request('put /settings', { api_signature_enabled: true });
    if (demo) {
      const get = (await f.request('get /signature')).res.body;
      assert.equal(get.enabled, true);
      assert.equal(get.template, 'trimmed');
    } else {
      assert(f.writes[1].sql.includes('api_signature_enabled'));
      assert(!f.writes[1].sql.includes('api_signature_template'));
      assert.deepEqual(f.events.filter(event => event.startsWith('user-cache:')), ['user-cache:7', 'user-cache:7']);
    }
    assert.equal((await f.request('put /signature', { api_signature_enabled: true, api_signature_template: null })).res.statusCode, 200);
  });
  test(`${mode}: 显式空模板、null 与 2000 字边界`, async () => {
    for (const template of ['', null, '  ', ' ' + 'x'.repeat(2000) + ' ']) {
      const f = fixture({ demo });
      const res = (await f.request('put /api-keys/:id/signature', { enabled: null, template })).res;
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.template, template?.trim() || null);
      assert.equal(res.body.effective.template, template?.trim() || 'owner default');
    }
  });
  test(`${mode}: 旧 settings 非法签名不部分更新`, async () => {
    const f = fixture({ demo });
    const { res } = await f.request('put /settings', { email: 'NEW@EXAMPLE.COM', avatar: 'new', api_signature_template: 42 });
    assert.equal(res.statusCode, 400);
    assert.equal(f.writes.length, 0);
  });
}

test('Co-Key 成员 GET 使用发起者默认值；无权限 GET/PUT 不写库', async () => {
  const f = fixture();
  const get = (await f.request('get /api-keys/:id/signature')).res.body;
  assert.equal(get.user_signature_template, 'owner default');
  assert.equal(get.effective.template, 'owner default');
  const denied = fixture({ access: false });
  for (const route of ['get /api-keys/:id/signature', 'put /api-keys/:id/signature']) {
    assert.equal((await denied.request(route, { enabled: true, template: '' })).res.statusCode, 404);
  }
  assert.equal(denied.writes.length, 0);
  assert(denied.events.includes('ROLLBACK'));
});

test('Key 事务提交后才失效缓存；写入/提交失败不失效或成功审计', async () => {
  const ok = fixture();
  await ok.request('put /api-keys/:id/signature', { signature_enabled: false, signature_template: null });
  assert(ok.events.indexOf('COMMIT') < ok.events.indexOf('key-cache:9'));
  assert.equal(ok.audits[0].signature_enabled, false);
  for (const options of [{ failWrite: true }, { failCommit: true }]) {
    const f = fixture(options);
    assert.equal((await f.request('put /api-keys/:id/signature', { enabled: false, template: 'new' })).res.statusCode, 500);
    assert.equal(f.key.signature_enabled, null);
    assert(!f.events.some(event => event.startsWith('key-cache:')));
    assert(f.events.includes('ROLLBACK'));
    assert.equal(f.audits.length, 0);
  }
});

test('旧 settings 邮箱/头像/签名只用一条原子 UPDATE；失败不污染会话及缓存', async () => {
  const f = fixture();
  const { res, user } = await f.request('put /settings', { email: 'NEW@EXAMPLE.COM', avatar: 'new', api_signature_enabled: false, api_signature_template: ' t ' });
  assert.equal(res.statusCode, 200);
  assert.equal(f.writes.length, 1);
  assert.equal(user.email, 'new@example.com');
  assert.equal(user.api_signature_template, 't');
  const failed = fixture({ failWrite: true });
  const result = await failed.request('put /settings', { email: 'new', avatar: 'new', api_signature_enabled: false });
  assert.equal(result.res.statusCode, 500);
  assert.equal(result.user.api_signature_enabled, true);
  assert.equal(result.user.email, undefined);
  assert(!failed.events.some(event => event.includes('cache:')));
  const unrelated = fixture();
  await unrelated.request('put /settings', { avatar: 'new' });
  assert(!unrelated.events.some(event => event.includes('cache:')));
});

test('独立用户 PUT 失败不更新会话/缓存；null 开关非法且旧别名正确审计', async () => {
  const f = fixture({ failWrite: true });
  const result = await f.request('put /signature', { enabled: false, template: '' });
  assert.equal(result.res.statusCode, 500);
  assert.equal(result.user.api_signature_enabled, true);
  assert(!f.events.some(event => event.includes('cache:')));
  assert.equal(f.audits.length, 0);
  for (const demo of [false, true]) {
    const invalid = fixture({ demo });
    assert.equal((await invalid.request('put /signature', { enabled: null, template: '' })).res.statusCode, 400);
    assert.equal(invalid.writes.length, 0);
  }
  const legacy = fixture();
  await legacy.request('put /signature', { api_signature_enabled: true, api_signature_template: ' t ' });
  assert.equal(legacy.audits[0].api_signature_enabled, true);
});

test('加载演示路由/默认数据不加载签名核心及生产连接', () => {
  const module = { exports: {} };
  vm.runInNewContext(read('../demo/data.js'), {
    module, require(name) { throw new Error(`演示数据不应加载外部依赖 ${name}`); },
    Date, Math,
  });
  assert.equal(typeof module.exports.settings, 'function');
  const router = new Proxy({}, { get: () => () => {} });
  vm.runInNewContext(read('../demo/routes.js'), {
    module: { exports: {} },
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === './data') return module.exports;
      throw new Error(`演示路由初始化不应加载 ${name}`);
    }
  });
});

test('独立用户 GET 从数据库读取；新端点权限绑定资料读写而非默认网关权限', async () => {
  const f = fixture();
  const body = (await f.request('get /signature')).res.body;
  assert.equal(body.template, 'owner default');
  const permissions = require('../utils/api-key-permissions');
  assert.equal(permissions.matchPermission('GET', '/api/user/signature/?v=1').id, 'account.profile.read');
  assert.equal(permissions.matchPermission('PUT', '/api/user/signature').id, 'account.profile.write');
  assert.equal(permissions.matchPermission('PATCH', '/api/user/signature'), null);
});
