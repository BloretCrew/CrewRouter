'use strict';

// 路由级测试：真实 Express 路由 + 隔离 PostgreSQL，验证鉴权中间件后的行为。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { test } = require('node:test');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

/** 用注入的 pool 与透传鉴权加载路由模块，返回 Express 之外的轻量调用器 */
function loadRoute(relative, relativeDeps) {
  const handlers = [];
  const router = {
    get(url, ...fns) { handlers.push({ method: 'GET', url, fns }); },
    post(url, ...fns) { handlers.push({ method: 'POST', url, fns }); },
    put(url, ...fns) { handlers.push({ method: 'PUT', url, fns }); },
    delete(url, ...fns) { handlers.push({ method: 'DELETE', url, fns }); },
  };
  const context = {
    module: { exports: {} },
    console,
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (relativeDeps[name]) return relativeDeps[name];
      throw new Error(`Unexpected fixture dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'routes', relative), 'utf8'), context);
  return async function call(method, url, params, { body, session } = {}) {
    const entry = handlers.find(item => item.method === method && item.url === url);
    if (!entry) throw new Error(`route not found: ${method} ${url}`);
    const req = { params: params || {}, body: body || {}, query: {}, session: session || { user: { id: 1 } } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; this.done = true; return this; },
    };
    for (const fn of entry.fns) {
      let nextCalled = false;
      await fn(req, res, () => { nextCalled = true; });
      if (!nextCalled && res.done) break;
      if (!nextCalled && !res.done) throw new Error('middleware neither called next nor responded');
    }
    return res;
  };
}

test('popup notice routes validate input and isolate users', async () => {
  const cluster = createIsolatedPostgres('popup-routes');
  const pool = new Pool({ ...cluster.connection, max: 4 });
  try {
    await cluster.assertIsolation(pool);
    await pool.query('CREATE TABLE users(id int PRIMARY KEY, is_admin boolean DEFAULT false); INSERT INTO users VALUES (1,true),(2,false)');
    const store = (() => {
      const context = {
        module: { exports: {} }, console,
        require(name) {
          if (name === '../models/database') return { pool };
          if (name === '../logger') return { error() {}, warn() {}, info() {} };
          throw new Error(`Unexpected fixture dependency: ${name}`);
        },
      };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/popup-notices.js'), 'utf8'), context);
      return context.module.exports;
    })();
    await store.ensurePopupNoticeSchema(pool);

    const adminRoute = loadRoute('admin-popup-notices.js', {
      '../middleware/auth': { requireAuth(req, res, next) { return next(); }, requireAdmin(req, res, next) { return next(); } },
      '../logger': { error() {} },
      '../utils/audit-log': { ACTIONS: { ADMIN_POPUP_NOTICE: 'admin.popup_notice' }, auditMiddleware() { return (req, res, next) => next(); } },
      '../utils/popup-notices': store,
    });
    const userRoute = loadRoute('popup-notices.js', {
      '../middleware/auth': { requireAuth(req, res, next) { return next(); } },
      '../logger': { error() {} },
      '../utils/popup-notices': store,
    });

    let response = await adminRoute('POST', '/popup-notices', null, { body: { title: '' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, '标题不能为空');

    response = await adminRoute('POST', '/popup-notices', null, { body: { title: '  升级通知  ', body: '  内容  ', closeText: '  ' } });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(response.body.item.title, '升级通知');
    assert.equal(response.body.item.closeText, '知道了');
    assert.equal(response.body.item.enabled, true);
    const id = response.body.item.id;

    response = await adminRoute('PUT', '/popup-notices/:id', { id: String(id) }, { body: { title: '改标题', body: '', closeText: '收到', enabled: false } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.item.enabled, false);

    response = await userRoute('GET', '/popup-notices');
    assert.deepEqual(response.body, [], '停用后用户不可见');

    await adminRoute('PUT', '/popup-notices/:id/enabled', { id: String(id) }, { body: { enabled: true } });
    response = await userRoute('GET', '/popup-notices', null, { session: { user: { id: 2 } } });
    assert.deepEqual(response.body.map(item => item.title), ['改标题']);

    response = await userRoute('POST', '/popup-notices/seen', null, { body: { ids: [id, 'x'] }, session: { user: { id: 2 } } });
    assert.equal(response.statusCode, 400, '非法 id 返回 400');

    response = await userRoute('POST', '/popup-notices/seen', null, { body: { ids: [id] }, session: { user: { id: 2 } } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.marked, 1);
    assert.deepEqual((await userRoute('GET', '/popup-notices', null, { session: { user: { id: 2 } } })).body, []);
    assert.equal((await userRoute('GET', '/popup-notices', null, { session: { user: { id: 1 } } })).body.length, 1, '其他用户仍可见');

    response = await adminRoute('GET', '/popup-notices');
    assert.equal(response.body.items[0].seenCount, 1);

    response = await adminRoute('POST', '/popup-notices/:id/reset', { id: String(id) });
    assert.equal(response.body.cleared, 1);
    assert.equal((await userRoute('GET', '/popup-notices', null, { session: { user: { id: 2 } } })).body.length, 1, '重置后重新可见');

    response = await adminRoute('DELETE', '/popup-notices/:id', { id: String(id) });
    assert.equal(response.statusCode, 200);
    response = await adminRoute('DELETE', '/popup-notices/:id', { id: String(id) });
    assert.equal(response.statusCode, 404);

    response = await adminRoute('PUT', '/popup-notices/:id/enabled', { id: 'abc' }, { body: { enabled: true } });
    assert.equal(response.statusCode, 400);
  } finally {
    await pool.end();
    cluster.stop();
  }
});
