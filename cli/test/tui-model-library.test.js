'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');
const { runPagedTui } = require('../tui/engine');
const { terminal, until } = require('./helpers/tty');

function makeRuntime() {
  return { client: {}, cfg: { tui: { days: 30 } }, profileName: 'test' };
}

test('model library renders a key selector, wrapped model cards and key status in the real terminal', { timeout: 15000 }, async () => {
  const runtime = makeRuntime();
  runtime.libraryProvider = { team_id: 2, provider_id: 'p1', provider_name: 'Provider A' };
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  const api = async path => {
    if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 1, visible_model_count: 1 }] }], starred_models: [], available_series: ['S'], total_models: 1 };
    if (path === '/api/user/api-keys') return [{ id: 1, name: 'Main Key', current_model_name: 'Bound Model', model_queue: [] }];
    if (path === '/api/user/team/2/provider/p1/models') return { models: [{ model_id: 'm1', name: 'Model One', alias: 'Model One Alias', provider: 'p1', team_id: 2, team_name: 'Team A', provider_name: 'Provider A', series: 'S', model_multiplier: 1.2, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, description: 'A useful model with details that wrap across the card lines', test_ok: true, test_latency_ms: 21, test_tokens_per_second: 18.5, is_starred: true, is_hidden: false, tags: [{ name: 'Featured' }] }], pagination: { page: 1, total: 1, limit: 30, total_pages: 1, has_prev: false, has_next: false } };
    return {};
  };
  const tty = terminal(100, 42);
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api, pages: [page], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('Model One Alias'));
    const screen = tty.screen();
    for (const text of ['选择 API Key', '┌', '┐', '│ Model One Alias', 'Team A · Provider A', '倍率：计费倍率 ×1.20', '输入价：0.1', '测试通过 · 21 毫秒', 'Key：Main Key · 当前模型：Bound Model']) assert.ok(screen.includes(text), `terminal is missing ${text}:\n${screen}`);
  } finally { tty.input.write('q'); await task; }
});

test('model card actions remain reachable from the card and request pricing confirmation before model testing', async () => {
  const runtime = makeRuntime();
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 1, visible_model_count: 1 }] }], starred_models: [], available_series: [], total_models: 1 };
    if (path === '/api/user/api-keys') return [{ id: 1, name: 'Main Key', model_queue: [] }];
    if (path === '/api/user/team/2/provider/p1/models') return { models: [{ model_id: 'm1', name: 'Model One', provider: 'p1', team_id: 2, team_name: 'Team A', provider_name: 'Provider A' }], pagination: { page: 1, total: 1, limit: 30, total_pages: 1, has_prev: false, has_next: false } };
    return {};
  };
  runtime.libraryProvider = { team_id: 2, provider_id: 'p1', provider_name: 'Provider A' };
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  const section = (await page.load(api)).sections.find(item => item.title.includes('模型目录'));
  assert.equal(section.cards.length, 1);
  let confirmMessage = '';
  await section.cards[0].run({ choose: async (_title, options) => { assert.ok(options.some(option => option.value === 'test')); return 'test'; }, confirm: async (_title, message) => { confirmMessage = message; return false; } });
  assert.match(confirmMessage, /真实测试请求/);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});
