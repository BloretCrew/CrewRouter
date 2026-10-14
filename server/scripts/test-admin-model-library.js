'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const logger = { error() {}, warn() {}, info() {} };
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } });

function library({ personal = false, admin = true, edition = 'team', missingTeam = false, fail = false } = {}) {
  const calls = [];
  const routes = [];
  const providerRows = [
    { id: 'empty', name: 'Empty', provider_enabled: true, model_count: 0, system_enabled_count: 0, team_enabled_count: null, available_count: 0 },
    { id: 'system', name: 'System', provider_enabled: false, model_count: 2, system_enabled_count: 1, team_enabled_count: 1, available_count: 0 },
  ];
  const modelRows = [{ model_id: 'disabled', provider_id: 'system', system_enabled: false, provider_enabled: false, team_enabled: true }];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (fail) throw new Error('offline');
    if (sql.startsWith('SELECT id, name FROM teams')) return { rows: missingTeam ? [] : [{ id: 1, name: 'Team' }] };
    if (sql.includes('SELECT DISTINCT series')) return { rows: [{ series: 'Claude' }] };
    if (sql.includes('SELECT COUNT(*)::int AS model_count')) return { rows: [{ model_count: 2, system_enabled_count: 1, team_enabled_count: 1, available_count: 0 }] };
    if (sql.includes('SELECT * FROM provider_stats')) return { rows: sql.includes('LIMIT') ? providerRows.slice(0, 1) : providerRows };
    if (sql.includes('SELECT * FROM filtered_models')) return { rows: modelRows };
    throw new Error(sql);
  } };
  const context = { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => ({ get(route, ...handlers) { routes.push({ route, handlers }); } }) };
    if (name === '../models/database') return { pool };
    if (name === '../logger') return logger;
    if (name === '../middleware/auth') return {
      requireAuth(req, res, next) { return req.session?.user ? next() : res.status(401).json({ error: 'auth' }); },
      requireProviderManager(req, res, next) { req.personalProviderManager = personal; return personal || admin ? next() : res.status(403).json({ error: 'admin' }); },
      requireAdmin(req, res, next) { return admin ? next() : res.status(403).json({ error: 'admin' }); },
    };
    if (name === '../utils/instance-edition') return {
      loadPersistedEdition: async () => edition,
      requireTeamEdition: getter => async (req, res, next) => await getter() === 'team' ? next() : res.status(403).json({ type: 'team_edition_required' }),
    };
    throw new Error(name);
  } };
  vm.runInNewContext(read('routes/admin-model-library.js'), context);
  return { ...context.module.exports, calls, async request(query = {}, loggedIn = true) {
    const res = response();
    const req = { query, session: loggedIn ? { user: { id: 7 } } : {} };
    const handlers = routes[0].handlers;
    const run = index => handlers[index] ? handlers[index](req, res, () => run(index + 1)) : undefined;
    await run(0);
    return res;
  } };
}

function writeHandler(file, method, route, pool, extra = {}) {
  const source = read(file);
  const start = source.indexOf(`router.${method}('${route}',`);
  assert(start >= 0);
  const end = source.indexOf('\n});', start) + 4;
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    router: { [method](_route, ...handlers) { handler = handlers.at(-1); } },
    requireAuth() {}, requireAdmin() {}, requireProviderManager() {},
    auditMiddleware: () => () => {}, ACTIONS: {}, pool, Logger: logger,
    ...extra,
  });
  return handler;
}

test('默认供应商分页保留零模型供应商且不暴露密钥', async () => {
  const fixture = library();
  const res = await fixture.request({ limit: '1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.view, 'providers');
  assert.equal(res.data.total, 2);
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.providers[0].model_count, 0);
  assert.equal(res.data.stats.model_count, 2);
  assert(!JSON.stringify(res.data).includes('api_key'));
  assert.match(fixture.calls[0].sql, /LEFT JOIN filtered_models/);
  assert(!fixture.calls[0].sql.includes('p.created_by IS NULL'));
  assert(!/p\.\*|m\.\*|base_url|oauth|key_script|api_key/.test(fixture.calls[0].sql));
});

test('模型分页明确区分三层状态和数据库模型 ID', async () => {
  const fixture = library();
  const res = await fixture.request({ view: 'models', teamId: '1', provider: 'system', page: '2', limit: '1' });
  assert.equal(res.data.total, 2);
  assert.equal(res.data.team_id, 1);
  assert.equal(res.data.items[0].model_id, 'disabled');
  assert.equal(res.data.items[0].system_enabled, false);
  assert.equal(res.data.items[0].provider_enabled, false);
  assert.equal(res.data.items[0].team_enabled, true);
  assert.deepEqual(Array.from(fixture.calls.find(call => call.sql.includes('SELECT * FROM filtered_models')).params.slice(-2)), [1, 1]);
});

test('所有筛选值参数化，排序白名单，保留无 Team 的 null 语义', () => {
  const fixture = library();
  const parsed = fixture.parseQuery({ view: 'models', teamId: '1', q: "%' OR TRUE--", provider: 'p', series: 's', tag: '2', test: 'fail', systemEnabled: 'false', teamEnabled: 'true', sort: 'test_speed' });
  const query = fixture.buildLibraryQuery(parsed);
  assert(!query.cte.includes("OR TRUE--"));
  assert.match(query.cte, /provider_tag_assignments/);
  assert.match(query.cte, /mtr.ok IS FALSE/);
  assert.match(query.cte, /COALESCE\(tm.enabled, FALSE\) = \$/);
  assert(query.params.includes(false));
  assert(query.params.includes(true));
  assert.match(query.cte, /THEN NULL ELSE COALESCE\(tm.enabled, FALSE\)/);
  const personalQuery = fixture.buildLibraryQuery(fixture.parseQuery({}));
  assert(!personalQuery.cte.includes('created_by IS NULL'));
});

test('非法参数返回 400 且不访问模型数据库', async () => {
  for (const query of [{ enabled: 'maybe', systemEnabled: '1' }, { teamEnabled: 'true' }, { test: 'bad' }, { sort: 'name; DROP TABLE models' }, { page: '0' }, { limit: '201' }, { q: ['a'] }, { provider: {} }, { view: 'bad' }, { teamId: '2147483648' }, { tag: '-1' }]) {
    const fixture = library();
    assert.equal((await fixture.request(query)).statusCode, 400);
    assert.equal(fixture.calls.length, 0);
  }
});

test('未登录、非管理员和具体 Team 的 edition 权限边界', async () => {
  assert.equal((await library().request({}, false)).statusCode, 401);
  assert.equal((await library({ admin: false }).request()).statusCode, 403);
  assert.equal((await library({ personal: true, admin: false, edition: 'personal' }).request()).statusCode, 200);
  assert.equal((await library({ personal: true, edition: 'personal' }).request({ teamId: '1' })).data.type, 'team_edition_required');
  assert.equal((await library({ personal: true, admin: false }).request({ teamId: '1' })).statusCode, 403);
  assert.equal((await library({ missingTeam: true }).request({ teamId: '1' })).statusCode, 404);
  assert.equal((await library({ fail: true }).request()).statusCode, 500);
});

test('系统和 Team 单模型开关拒绝非布尔值', async () => {
  for (const value of [undefined, null, 'false', 0, 1, {}, []]) {
    for (const [file, method, route, body] of [
      ['routes/admin.js', 'post', '/models/batch-update', { ids: ['m'], enabled: value }],
      ...(value === undefined ? [] : [['routes/admin.js', 'post', '/models', { provider: 'p', enabled: value }]]),
      ['routes/teams.js', 'put', '/teams/:id/models/:modelId', { enabled: value }],
    ]) {
      const res = response();
      const handler = writeHandler(file, method, route, { query() { throw new Error('must not query'); } });
      await handler({ body, params: { id: 1, modelId: 'm' } }, res);
      assert.equal(res.statusCode, 400);
    }
  }
});

test('系统批量禁用事务提交后清理缓存，失败回滚，管理员可管理私有供应商', async () => {
  for (const mode of ['success', 'private', 'missing', 'failure']) {
    const events = [];
    const client = { async query(sql) {
      events.push(sql);
      if (sql.includes('SELECT m.id')) return { rows: mode === 'missing' ? [] : [{ id: 'm', created_by: mode === 'private' ? 99 : null }] };
      return { rows: [] };
    }, release() { events.push('release'); } };
    const handler = writeHandler('routes/admin.js', 'post', '/models/batch-update', { connect: async () => client }, {
      clearDisabledModelBindings: async () => { events.push('cleanup'); if (mode === 'failure') throw new Error('cleanup'); return [42]; },
      invalidateModelKeyCaches: ids => { events.push(`invalidate:${ids.join(',')}`); },
      addModelsToFrontierTeams: async () => {},
    });
    const res = response();
    await handler({ body: { ids: ['m', 'm'], enabled: false }, personalProviderManager: false }, res);
    assert.equal(res.statusCode, ['success', 'private'].includes(mode) ? 200 : mode === 'failure' ? 500 : 403);
    if (['success', 'private'].includes(mode)) {
      assert.equal(res.data.updated, 1);
      assert.equal(res.data.cleared_keys, 1);
      assert(events.indexOf('COMMIT') < events.indexOf('release'));
      assert(events.indexOf('release') < events.indexOf('invalidate:42'));
    } else assert(events.includes('ROLLBACK'));
    assert.equal(events.filter(event => event === 'release').length, 1);
  }
});

test('系统禁用覆盖 Harness/Fusion/队列且保留 Team 映射', async () => {
  const { clearDisabledModelBindings } = require('../utils/model-access-cleanup');
  const calls = [];
  const ids = await clearDisabledModelBindings({ async query(sql, params) {
    calls.push({ sql, params });
    return { rows: sql.startsWith('SELECT') ? [{ id: 42 }] : [] };
  } }, ['m']);
  assert.deepEqual(ids, [42]);
  assert.match(calls[0].sql, /api_key_harness_models/);
  assert.match(calls[0].sql, /fusion_panel_models/);
  assert.match(calls.at(-1).sql, /ORDER BY sort_order, id LIMIT 1/);
  assert(!calls.some(call => /DELETE FROM team_models/.test(call.sql)));
});

test('Team 禁用允许系统已禁用模型，私有模型不可授权，缓存包含 Harness-only Key', async () => {
  const queries = [];
  const handler = writeHandler('routes/teams.js', 'put', '/teams/:id/models/:modelId', { async query(sql, params) {
    queries.push({ sql, params }); return { rows: [{ id: 1 }] };
  } }, { teamModelTransaction: async (_teamId, work) => work({ async query(sql, params) { queries.push({ sql, params }); return { rows: [{ id: 1 }] }; } }), clearApiKeysForUnavailableTeamModel: async () => ({ cleared: 1 }) });
  const res = response();
  await handler({ body: { enabled: false }, params: { id: 1, modelId: 'm' } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(queries[1].sql, /p.created_by IS NULL/);
  assert.equal(queries[1].params[1], false);
  const source = read('utils/team-model-access.js');
  assert.match(source, /api_key_harness_models ahm/);
  assert.match(source, /JOIN models m ON m.id = tm.model_id AND m.enabled = TRUE/);
  assert.match(source, /JOIN providers p ON p.id = m.provider AND p.enabled = TRUE/);
  assert.match(source, /await client.query\('COMMIT'\)/);
});

test('模型库先于全局 Team router 挂载', () => {
  const admin = read('routes/admin.js');
  assert(admin.indexOf("router.use(require('./admin-model-library'))") < admin.indexOf('router.use([\'/users'));
  const index = read('index.js');
  assert(index.indexOf("require('./routes/admin')") < index.indexOf("require('./routes/teams')"));
});

test('新增读取字段和系列列表，价格排序按输入价、输出价、模型 ID 稳定排序', async () => {
  for (const sort of ['price_asc', 'price_desc']) {
    const fixture = library();
    const res = await fixture.request({ view: 'models', sort, series: 'GPT' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Array.from(res.data.series), ['Claude']);
    const sql = fixture.calls.find(call => call.sql.includes('SELECT * FROM filtered_models')).sql;
    const direction = sort === 'price_asc' ? 'ASC' : 'DESC';
    assert(sql.includes(`ORDER BY input_price_per_1k_tokens ${direction} NULLS LAST, output_price_per_1k_tokens ${direction} NULLS LAST, model_id`));
    for (const field of ['p.format', 'AS tags', 'm.rate_limit_rpm', 'm.rate_limit_tpm', 'AS effective_available']) assert(sql.includes(field));
    const series = fixture.calls.find(call => call.sql.includes('SELECT DISTINCT series'));
    assert(!series.params.includes('GPT'));
  }
});

test('指定 Team 仅系统供应商，无 Team 管理员保留全部供应商', () => {
  const fixture = library();
  assert(!fixture.buildLibraryQuery(fixture.parseQuery({})).cte.includes('created_by IS NULL'));
  assert.match(fixture.buildLibraryQuery(fixture.parseQuery({ teamId: '1' })).cte, /p.created_by IS NULL/);
});

test('模型筛选移除无匹配供应商，搜索仅允许名字匹配的真实零模型供应商', () => {
  const fixture = library();
  const query = options => fixture.buildLibraryQuery(fixture.parseQuery(options)).cte;
  assert(!query({}).includes('HAVING'));
  for (const options of [{ series: 'x' }, { test: 'pass' }, { systemEnabled: 'false' }, { teamId: '1', teamEnabled: 'false' }]) {
    assert.match(query(options), /HAVING COUNT\(m.model_id\) > 0/);
    assert(!query(options).includes('all_models'));
  }
  assert.match(query({ q: 'Empty' }), /OR \(p.name ILIKE \$\d+ AND NOT EXISTS \(SELECT 1 FROM models all_models/);
  assert(!query({ q: 'Empty', series: 'Claude' }).includes('all_models'));
});

test('单保存缺省 enabled 新增默认启用，编辑保留旧开关，管理员可保存私有模型', async () => {
  const calls = [];
  const handler = writeHandler('routes/admin.js', 'post', '/models', { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } }, {
    crypto: { randomUUID: () => 'new' }, addModelsToFrontierTeams: async () => {},
  });
  for (const id of [undefined, 'private']) {
    const res = response();
    await handler({ body: { id, provider: 'private-provider' }, personalProviderManager: false }, res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.params[5], null);
    assert.match(call.sql, /COALESCE\(\$6::boolean, TRUE\)/);
    assert.match(call.sql, /enabled = COALESCE\(\$6::boolean, models.enabled\)/);
  }
});

test('Team 事务工具可注入，清理失败、COMMIT 失败回滚且不失效缓存，连接总会释放', async () => {
  const { createTeamModelTransaction, clearApiKeysForUnavailableTeamModel } = require('../utils/team-model-access');
  for (const failure of [null, 'cleanup', 'commit']) {
    const events = [];
    const client = { async query(sql) {
      events.push(sql);
      if (failure === 'cleanup' && sql.startsWith('DELETE FROM api_key_harness_models')) throw new Error('cleanup');
      if (failure === 'commit' && sql === 'COMMIT') throw new Error('commit');
      if (sql.includes('SELECT DISTINCT ak.id, ak.user_id')) return { rows: [{ id: 42, user_id: 7 }] };
      if (sql.includes('SELECT DISTINCT ut.user_id')) return { rows: [] };
      if (sql.includes('SELECT DISTINCT ak.id')) return { rows: [{ id: 42 }] };
      return { rows: [] };
    }, release() { events.push('release'); } };
    const transaction = createTeamModelTransaction({ pool: { connect: async () => client }, invalidateApiKeyCacheByKeyId: id => events.push(`invalidate:${id}`) });
    const run = () => transaction(1, async injected => {
      assert.equal(injected, client);
      await injected.query('UPDATE team_models SET enabled = FALSE');
      return clearApiKeysForUnavailableTeamModel(injected, 1, 'harness-only');
    });
    if (failure) {
      await assert.rejects(run);
      assert(events.includes('ROLLBACK'));
      assert(!events.includes('invalidate:42'));
    } else {
      assert.equal((await run()).cleared, 1);
      assert(events.indexOf('COMMIT') < events.indexOf('invalidate:42'));
      assert(events.some(sql => sql.includes('api_key_harness_models ahm')));
      assert(events.some(sql => sql.startsWith('DELETE FROM api_key_harness_models')));
      assert(events.some(sql => sql.includes('fusion_panel_models')));
    }
    assert(events.includes('release'));
  }
});

test('Team 其它可用授权保留绑定，单个与批量均用事务 client 完成清理', async () => {
  const { clearApiKeysForUnavailableTeamModel } = require('../utils/team-model-access');
  const queries = [];
  const result = await clearApiKeysForUnavailableTeamModel({ async query(sql) {
    queries.push(sql);
    return { rows: sql.includes('ak.user_id') ? [{ id: 42, user_id: 7 }] : [{ user_id: 7 }] };
  } }, 1, 'm');
  assert.equal(result.cleared, 0);
  assert(!queries.some(sql => sql.startsWith('DELETE')));
  const source = read('routes/teams.js');
  for (const [method, route] of [['put', '/teams/:id/models/:modelId'], ['post', '/teams/:id/models/batch'], ['delete', '/teams/:id/models/:modelId']]) {
    const start = source.indexOf(`router.${method}('${route}',`);
    const part = source.slice(start, source.indexOf('\n});', start));
    assert.match(part, /await teamModelTransaction/);
    assert.match(part, /clearApiKeysForUnavailableTeamModel\(client,/);
    assert(!part.includes('pool.query'));
  }
});

test('实际 Team 单个与批量禁用路由清理失败整体回滚，成功提交后才失效缓存', async () => {
  const { createTeamModelTransaction } = require('../utils/team-model-access');
  for (const [method, route, body] of [
    ['put', '/teams/:id/models/:modelId', { enabled: false }],
    ['post', '/teams/:id/models/batch', { enabled: false, modelIds: ['m'] }],
  ]) {
    for (const fail of [false, true]) {
      const events = [];
      const client = { async query(sql) {
        events.push(sql);
        if (sql.includes('SELECT DISTINCT ak.id')) return { rows: [{ id: 42 }] };
        return { rows: [{ id: 'm' }], rowCount: 1 };
      }, release() { events.push('release'); } };
      const transaction = createTeamModelTransaction({ pool: { connect: async () => client }, invalidateApiKeyCacheByKeyId: () => events.push('invalidate') });
      const handler = writeHandler('routes/teams.js', method, route, { query() { throw new Error('pool query forbidden'); } }, {
        teamModelTransaction: transaction,
        clearApiKeysForUnavailableTeamModel: async injected => {
          assert.equal(injected, client);
          events.push('cleanup');
          if (fail) throw new Error('cleanup failed');
          return { cleared: 1 };
        },
      });
      const res = response();
      await handler({ params: { id: 1, modelId: 'm' }, body }, res);
      assert.equal(res.statusCode, fail ? 500 : 200);
      assert(events.includes('cleanup'));
      if (fail) {
        assert(events.includes('ROLLBACK'));
        assert(!events.includes('COMMIT'));
        assert(!events.includes('invalidate'));
      } else {
        assert(events.indexOf('COMMIT') < events.indexOf('invalidate'));
        assert.equal(res.data.cleared_keys, 1);
      }
    }
  }
});

test('恢复管理员管理私有模型不会将私有或禁用模型自动授权给 Frontier Team', () => {
  const source = read('utils/frontier-auto-add.js');
  assert.match(source, /JOIN models m ON m.id = x.model_id AND m.enabled = TRUE/);
  assert.match(source, /JOIN providers p ON p.id = m.provider AND p.created_by IS NULL/);
});

test('纯事务工具 require 后自然退出，不加载数据库或持有后台连接', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../utils/team-model-access.js'))}); if (Object.keys(require.cache).some(p => p.endsWith('/models/database.js'))) throw new Error('database loaded');`], { timeout: 2000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

test('满容量并发系统启用在 Frontier pool 查询前释放事务连接', async () => {
  for (const max of [1, 2, 4]) {
    let active = 0;
    let acquired = 0;
    let frontierCount = 0;
    const waiters = [];
    let openGate;
    const gate = new Promise(resolve => { openGate = resolve; });
    const pool = { async connect() {
      if (active === max) await new Promise(resolve => waiters.push(resolve));
      active++;
      acquired++;
      if (acquired === max) openGate();
      let released = false;
      return { async query(sql) {
        if (sql === 'BEGIN') await gate;
        if (sql.includes('SELECT m.id')) {
          assert.match(sql, /ORDER BY m.id FOR NO KEY UPDATE OF m/);
          return { rows: [{ id: 'm', created_by: null }] };
        }
        return { rows: [] };
      }, release() {
        assert.equal(released, false, '每个连接只释放一次');
        released = true;
        active--;
        const next = waiters.shift();
        if (next) next();
      } };
    }, async query(sql) {
      const client = await this.connect();
      try { return await client.query(sql); } finally { client.release(); }
    } };
    const handler = writeHandler('routes/admin.js', 'post', '/models/batch-update', pool, {
      clearDisabledModelBindings: async () => { throw new Error('启用不清理'); },
      invalidateModelKeyCaches() {},
      addModelsToFrontierTeams: async () => { await pool.query('frontier'); frontierCount++; },
    });
    const responses = Array.from({ length: max }, () => response());
    let timer;
    try {
      await Promise.race([
        Promise.all(responses.map(res => handler({ body: { ids: ['m'], enabled: true } }, res))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`pool max=${max} 耗尽`)), 1500); }),
      ]);
    } finally { clearTimeout(timer); }
    assert.equal(frontierCount, max);
    assert.equal(active, 0);
    assert.equal(waiters.length, 0);
    for (const res of responses) assert.equal(res.statusCode, 200);
  }
});

test('提交后 Frontier 失败不回滚或二次释放已交还的连接', async () => {
  const events = [];
  const handler = writeHandler('routes/admin.js', 'post', '/models/batch-update', {
    async connect() { return {
      async query(sql) { events.push(sql); return { rows: sql.includes('SELECT m.id') ? [{ id: 'm' }] : [] }; },
      release() { events.push('release'); },
    }; },
  }, {
    invalidateModelKeyCaches() {},
    addModelsToFrontierTeams: async () => { events.push('frontier'); throw new Error('frontier unavailable'); },
  });
  const res = response();
  await handler({ body: { ids: ['m'], enabled: true } }, res);
  assert.equal(res.statusCode, 200);
  assert(events.indexOf('release') < events.indexOf('frontier'));
  assert.equal(events.filter(event => event === 'release').length, 1);
  assert(!events.includes('ROLLBACK'));
});
