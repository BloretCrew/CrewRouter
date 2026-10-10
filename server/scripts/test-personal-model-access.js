'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const config = {};
const configPath = require.resolve('../config-loader');
const previousConfigModule = require.cache[configPath];
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: config };
const { addModelsToPersonalTeams } = require('../utils/personal-model-access');
const { addModelsToFrontierTeams } = require('../utils/frontier-auto-add');
if (previousConfigModule) require.cache[configPath] = previousConfigModule;
else delete require.cache[configPath];

function createDb(edition = 'personal') {
  const state = {
    edition,
    users: [1, 2, 3],
    teams: [
      { id: 10, personal: true },
      { id: 20, personal: true },
      { id: 30, personal: true },
      { id: 40, personal: false },
    ],
    memberships: [{ user: 1, team: 10 }, { user: 2, team: 20 }, { user: 1, team: 40 }],
    providers: [{ id: 'p1', enabled: true }, { id: 'p2', enabled: false }],
    models: [
      { id: 'm1', provider: 'p1', enabled: true },
      { id: 'm2', provider: 'p1', enabled: true },
      { id: 'disabled-model', provider: 'p1', enabled: false },
      { id: 'disabled-provider', provider: 'p2', enabled: true },
    ],
    mappings: [{ team: 10, model: 'm2', enabled: false }],
    calls: [],
  };
  return Object.assign(state, {
    async query(sql, params) {
      state.calls.push({ sql, params });
      if (sql.startsWith('SELECT edition FROM instance_settings')) {
        return { rows: state.edition == null ? [] : [{ edition: state.edition }] };
      }
      if (sql.startsWith('SELECT id FROM teams')) return { rows: [] };
      if (sql.includes('INSERT INTO team_models')) {
        assert.match(sql, /t\.is_personal = TRUE/);
        assert.match(sql, /m\.enabled = TRUE/);
        assert.match(sql, /p\.enabled = TRUE/);
        assert.match(sql, /m\.id = ANY\(\$1::text\[\]\)/);
        assert.match(sql, /EXISTS \([\s\S]*FROM user_teams ut[\s\S]*JOIN users u ON u\.id = ut\.user_id[\s\S]*ut\.team_id = t\.id/);
        assert.match(sql, /ON CONFLICT \(team_id, model_id\) DO NOTHING/);
        let rowCount = 0;
        for (const team of state.teams) {
          if (!team.personal || !state.memberships.some(ut => ut.team === team.id && state.users.includes(ut.user))) continue;
          for (const model of state.models) {
            if (!params[0].includes(model.id) || !model.enabled || !state.providers.some(p => p.id === model.provider && p.enabled)) continue;
            if (state.mappings.some(tm => tm.team === team.id && tm.model === model.id)) continue;
            state.mappings.push({ team: team.id, model: model.id, enabled: true });
            rowCount++;
          }
        }
        return { rowCount };
      }
      if (sql.includes('SELECT DISTINCT m.id')) {
        assert.match(sql, /JOIN providers p ON m\.provider = p\.id AND p\.enabled = TRUE/);
        assert.match(sql, /JOIN team_models tm ON tm\.model_id = m\.id AND tm\.enabled = TRUE/);
        assert.match(sql, /JOIN user_teams ut ON ut\.team_id = tm\.team_id AND ut\.user_id = \$1/);
        assert.match(sql, /WHERE m\.enabled = TRUE/);
        return { rows: state.models.filter(m => m.enabled
          && state.providers.some(p => p.id === m.provider && p.enabled)
          && state.mappings.some(tm => tm.model === m.id && tm.enabled
            && state.memberships.some(ut => ut.team === tm.team && ut.user === params[0]))) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  });
}

function loadModelsHandler(db) {
  const source = fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8');
  const start = source.indexOf("router.get('/models', requireAuth, async (req, res) => {");
  assert(start >= 0);
  const end = source.indexOf('\n});', start);
  let handler;
  vm.runInNewContext(source.slice(start, end + 4), {
    router: { get(route, auth, callback) { handler = callback; } },
    requireAuth() {},
    pool: db,
    Logger: { error() {} },
  });
  return async userId => {
    let body;
    await handler({ session: { user: { id: userId } } }, {
      json(value) { body = value; },
      status(code) { throw new Error(`models endpoint returned ${code}`); },
    });
    return body.map(model => model.id);
  };
}

(async () => {
  const previous = { edition: config.edition, personal: config.personal, runtime: config.runtime };
  try {
    for (const boundary of [
      { persisted: 'personal', configured: undefined, expected: true },
      { persisted: 'personal', configured: 'team', expected: true },
      { persisted: 'team', configured: 'personal', personal: true, expected: false },
      { persisted: 'team', runtime: 'desktop-local', expected: false },
      { persisted: null, configured: 'personal', expected: true },
      { persisted: null, personal: true, expected: true },
      { persisted: null, configured: 'team', expected: false },
      { persisted: null, runtime: 'desktop-local', expected: false },
      { persisted: null, expected: false },
    ]) {
      config.edition = boundary.configured;
      config.personal = boundary.personal;
      config.runtime = boundary.runtime;
      const db = createDb(boundary.persisted);
      assert.strictEqual(await addModelsToPersonalTeams(db, 'm1'), boundary.expected ? 2 : 0, JSON.stringify(boundary));
      assert.strictEqual(db.calls.length, boundary.expected ? 2 : 1);
    }

    config.edition = 'personal';
    await assert.rejects(addModelsToPersonalTeams(createDb('invalid'), 'm1'), { code: 'EDITION_PERSISTED_INVALID' });
    const unavailable = createDb();
    unavailable.query = async () => { throw new Error('database unavailable'); };
    await assert.rejects(addModelsToPersonalTeams(unavailable, 'm1'), /database unavailable/);

    const db = createDb();
    const models = loadModelsHandler(db);
    assert.deepStrictEqual(await models(1), []);
    assert.strictEqual(await addModelsToFrontierTeams(db, ['m1', 'm1', 'm2', 'disabled-model', 'disabled-provider', 'missing', null]), 3);
    assert.deepStrictEqual(await models(1), ['m1']);
    assert.deepStrictEqual(await models(2), ['m1', 'm2']);
    assert.deepStrictEqual(await models(3), []);
    assert.strictEqual(db.mappings.find(tm => tm.team === 10 && tm.model === 'm2').enabled, false);
    assert(!db.mappings.some(tm => tm.team === 30 || tm.team === 40));
    assert.strictEqual(db.teams.length, 4, '不在模型写入路径补建个人 Team');
    assert.strictEqual(await addModelsToFrontierTeams(db, ['m1', 'm2']), 0);

    db.models.push({ id: 'just-created', provider: 'p1', enabled: true });
    assert.strictEqual(await addModelsToFrontierTeams(db, 'just-created'), 2);
    assert.deepStrictEqual(await models(1), ['m1', 'just-created'], '无需重新登录即可查询新增模型');
    db.models.find(m => m.id === 'disabled-model').enabled = true;
    assert.strictEqual(await addModelsToFrontierTeams(db, 'disabled-model'), 2);
    assert((await models(2)).includes('disabled-model'));
    db.providers[0].enabled = false;
    assert.deepStrictEqual(await models(1), [], '查询时禁用供应商立即隐藏模型');

    const empty = createDb();
    assert.strictEqual(await addModelsToPersonalTeams(empty, []), 0);
    assert.strictEqual(await addModelsToFrontierTeams(empty, null), 0);
    assert.strictEqual(empty.calls.length, 0);

    const refreshed = createDb('team');
    assert.strictEqual(await addModelsToFrontierTeams(refreshed, 'm1'), 0);
    refreshed.edition = 'personal';
    assert.strictEqual(await addModelsToFrontierTeams(refreshed, 'm1'), 2, 'edition 每次查询，不缓存旧判定');
    console.log('personal model edition boundaries, enabled filtering, memberships, idempotence and immediate models query passed');
  } finally {
    Object.assign(config, previous);
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
