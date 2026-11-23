'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(file, deps) {
  const filename = path.resolve(__dirname, '..', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, __dirname: path.dirname(filename), URL, process: { cwd: () => path.resolve(__dirname, '../..') },
    require(id) { assert.ok(Object.hasOwn(deps, id), `Unexpected dependency: ${id}`); return deps[id]; },
  }, { filename });
  return module.exports;
}
let queries = 0, calls = 0, failure = false, deleted = false, admin = false, dispatch;
const pool = { async query(sql, args) {
  queries++;
  assert.match(sql, /^SELECT (id, )?is_admin FROM users WHERE id = \$1$/);
  assert.equal(args[0], 7);
  if (failure) throw new Error('isolated database failure');
  return { rows: deleted ? [] : [{ id: 7, is_admin: admin }] };
} };
const auth = load('middleware/auth.js', { '../models/database': { pool }, '../config-loader': {}, '../utils/instance-edition': {} });
const permissions = load('utils/api-key-permissions.js', { 'node:fs': fs, 'node:path': path });
const { PUBLIC_PREFIXES } = load('constants/route-access.js', {});
const { requireApiKeyPermission } = load('middleware/api-key-permissions.js', {
  '../utils/api-key-permissions': permissions, './request-auth': { PUBLIC_PREFIXES },
});
const registry = {
  isLoaded: () => true,
  getLoadedManifest: () => ({ routes: [
    ...['admin', 'user', 'none', 'default', 'unexpected'].map(auth => ({ method: 'get', path: '/' + auth, auth: auth === 'unexpected' ? 'invalid' : (auth === 'default' ? undefined : auth) })),
    { method: 'post', path: '/user', auth: 'user' },
  ] }),
  findHandler: () => async (req, res) => { calls++; res.json({ id: req.authUser?.id, isAdmin: req.authUser?.isAdmin }); },
};
const router = () => ({ use() {}, get() {}, post() {}, put() {}, delete() {}, all(route, handler) { dispatch = handler; } });
load('routes/plugins.js', { express: { Router: router }, path, fs, os: {}, '../models/database': { pool },
  '../middleware/auth': auth, '../utils/audit-log': {}, '../plugins/zip': {}, '../plugins/store-client': {},
  '../proxy-pool': {}, '../logger': { error() {} }, '../plugins/registry': registry,
}).createPluginsRoutes();
function session(isAdmin = true) {
  const user = { id: 7, isAdmin };
  return { session: { user }, authUser: user, authActor: { type: 'session', user } };
}
function key(isAdmin, permissions) {
  const user = { id: 99, isAdmin };
  return { ...session(), authUser: user, authActor: { type: 'api_key', user, key: { permissions } } };
}
async function check(route, req = {}, status = 200, method = 'GET') {
  Object.assign(req, { method, params: { pluginId: 'fixture', 0: route }, originalUrl: '/api/plugins/fixture/' + route });
  const before = calls;
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; this.headersSent = true; } };
  await requireApiKeyPermission(req, res, () => dispatch(req, res));
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  assert.equal(calls - before, status === 200 ? 1 : 0);
  return res.body;
}
(async () => {
  const stale = session();
  await check('admin', stale, 403);
  assert.equal(stale.session.user.isAdmin, false);
  for (const route of ['user', 'default']) assert.equal((await check(route, session())).isAdmin, false);
  await check('unexpected', session(), 403);
  console.log('PASS stale administrator demotion and refreshed user/default/unknown auth identity');
  deleted = true;
  for (const route of ['admin', 'user', 'default']) {
    await check(route, session(), 401);
    await check(route, {}, 401);
    await check(route, { authUser: { id: 7, isAdmin: true } }, 401);
  }
  console.log('PASS deleted users, anonymous and authUser-only identities rejected before handlers');
  deleted = false; failure = true;
  for (const route of ['admin', 'user', 'default']) assert.equal((await check(route, session(), 503)).error, '权限暂不可用');
  const beforeNone = queries;
  await check('none'); await check('none', session());
  assert.equal(queries, beforeNone);
  console.log('PASS database errors fail closed with 503; none stays public without identity queries');
  failure = false; admin = true;
  assert.equal((await check('admin', session(false))).isAdmin, true);
  admin = false;
  assert.equal((await check('user', session(false))).id, 7);
  console.log('PASS normal administrator/user sessions and newly promoted administrator');
  const beforeKeys = queries;
  failure = true;
  for (const route of ['admin', 'user', 'default', 'none']) assert.equal((await check(route, key(true, ['plugins.read']))).id, 99);
  await check('admin', key(false, ['plugins.read']), 403);
  await check('user', key(false, ['plugins.read']));
  await check('user', key(false, ['plugins.write']), 200, 'POST');
  for (const route of ['admin', 'user', 'none']) assert.equal((await check(route, key(true, []), 403)).code, 'permission_denied');
  assert.equal((await check('user', key(true, ['plugins.read']), 403, 'POST')).permission, 'plugins.write');
  assert.equal(queries, beforeKeys);
  console.log('PASS API Key actor/admin/read/write/none permissions unchanged; no session database refresh');
  console.log('PASS VM dependency allowlists: no real configuration, database, network or plugin execution');
})().catch(error => { console.error(error); process.exitCode = 1; });
