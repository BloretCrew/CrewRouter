'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  TOOL_NAMES,
  runToolCall,
  resolveToolDecision,
  PERSONAL_USER_MESSAGE
} = require('../utils/agent-tools');
const { noteRepeat, runManageLoop, replyAsTestModel, parseModelResponse } = require('../utils/agent-loop');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  PASS', name);
}

function memoryDb() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push(sql);
      if (sql.includes('FROM models')) {
        return { rows: [{ id: 'm1', name: 'M', provider: 'p', enabled: true, output_kind: 'chat', api_key: 'sk-supersecretvalue' }] };
      }
      if (sql.includes('UPDATE models SET enabled')) return { rows: [{ id: params[0], enabled: params[1] }] };
      if (sql.includes('UPDATE models SET output_kind')) return { rows: [{ id: params[0], output_kind: params[1] }] };
      if (sql.includes('FROM providers')) return { rows: [{ id: 'p', name: 'P', enabled: true, format: 'openai', api_key: 'sk-supersecretvalue' }] };
      return { rows: [] };
    }
  };
}

async function main() {
  assert.deepStrictEqual(TOOL_NAMES, [
    'list_models', 'list_providers', 'usage_summary', 'list_recent_errors', 'list_users',
    'set_model_enabled', 'set_model_output_kind', 'set_provider_enabled'
  ]);
  assert.ok(!TOOL_NAMES.includes('shell'));
  ok('tool catalog is closed');

  const db = memoryDb();
  const pending = await runToolCall(db, { name: 'set_model_enabled', arguments: { id: 'm1', enabled: false } }, { approved: false });
  assert.strictEqual(pending.status, 'pending');
  assert.ok(!db.queries.some(sql => sql.includes('UPDATE')));
  ok('writes do not touch the database before approval');

  const denied = await resolveToolDecision(db, { name: 'set_model_enabled', arguments: { id: 'm1', enabled: false } }, 'deny');
  assert.deepStrictEqual(denied, { denied: true });
  assert.ok(!db.queries.some(sql => sql.includes('UPDATE')));
  ok('deny does not change the database');

  const listed = await runToolCall(db, { name: 'list_models', arguments: {} }, { edition: 'team' });
  assert.ok(!JSON.stringify(listed).includes('sk-supersecretvalue'));
  const providers = await runToolCall(db, { name: 'list_providers', arguments: {} }, {});
  assert.ok(!JSON.stringify(providers).includes('api_key'));
  assert.ok(!JSON.stringify(providers).includes('sk-supersecretvalue'));
  ok('tool results omit secrets');

  const users = await runToolCall(db, { name: 'list_users', arguments: {} }, { edition: 'personal' });
  assert.strictEqual(users.message, PERSONAL_USER_MESSAGE);
  assert.ok(!db.queries.some(sql => /FROM users/i.test(sql)));
  ok('personal edition list_users does not throw');

  const shell = await runToolCall(db, { name: 'shell', arguments: { command: 'rm -rf /' } }, {});
  assert.ok(shell.error);
  ok('unknown tools are rejected');

  const repeat = { sig: '', count: 0 };
  const call = { name: 'list_models', arguments: {} };
  assert.strictEqual(noteRepeat(repeat, call), false);
  assert.strictEqual(noteRepeat(repeat, call), false);
  assert.strictEqual(noteRepeat(repeat, call), true);
  ok('the same tool call stops on the third repeat');

  const messages = [{ role: 'user', content: '管理模型' }];
  const loopDb = memoryDb();
  const result = await runManageLoop({
    messages,
    modelCaller: async (current) => replyAsTestModel(current),
    onEvent: async () => {},
    executeRead: (name, args) => runToolCall(loopDb, { name, arguments: args }, { edition: 'personal' })
  });
  assert.strictEqual(result.status, 'waiting_approval');
  assert.strictEqual(result.approval.tool_name, 'set_model_output_kind');
  assert.ok(!loopDb.queries.some(sql => sql.includes('UPDATE')));
  ok('manage loop asks before marking a model as image');

  const openai = parseModelResponse('openai', {
    choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', function: { name: 'list_models', arguments: '{}' } }] } }]
  });
  assert.strictEqual(openai.toolCalls[0].name, 'list_models');
  const anthropic = parseModelResponse('anthropic', {
    content: [{ type: 'tool_use', id: 'c2', name: 'list_providers', input: {} }]
  });
  assert.strictEqual(anthropic.toolCalls[0].name, 'list_providers');
  ok('openai and anthropic tool calls both parse');

  const router = require('../routes/agent');
  function handles(routePath, method) {
    const layer = router.stack.find(item => item.route && item.route.path === routePath && item.route.methods[method]);
    assert.ok(layer, `${method} ${routePath} missing`);
    return layer.route.stack.map(item => item.handle.name);
  }
  assert.ok(handles('/manage/runs', 'post').includes('requireAdmin'));
  assert.ok(handles('/manage/approvals/:id', 'post').includes('requireAdmin'));
  assert.ok(!handles('/images', 'post').includes('requireAdmin'));
  assert.ok(handles('/images', 'post').includes('requireAuth'));
  ok('manage routes require an admin and image routes do not');

  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const playground = index.indexOf("app.use('/api/playground', require('./routes/playground'));");
  const agent = index.indexOf("app.use('/api/agent', require('./routes/agent'));");
  assert.ok(playground > 0 && agent > playground);
  ok('agent API is mounted beside playground outside demo mode');

  console.log(`\n${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
