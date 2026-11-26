'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');
const { runPagedTui } = require('../tui/engine');
const { terminal, until } = require('./helpers/tty');

function makeRuntime() { return { client: {}, cfg: { tui: { days: 30 } }, profileName: 'test' }; }
function fixtureApi(calls = []) {
  return async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 2, visible_model_count: 2, test_summary: { tested: 2, success: 1, avg_latency_ms: 42 } }] }], starred_models: [], available_series: ['S'], total_models: 2 };
    if (path === '/api/user/api-keys') return [{ id: 1, name: 'Main Key', current_model_name: 'Bound Model', model_queue: [] }];
    if (path === '/api/user/team/2/provider/p1/models') return { models: [{ model_id: 'm1', name: 'Model One', alias: 'Model One Alias', provider: 'p1', team_id: 2, team_name: 'Team A', provider_name: 'Provider A', series: 'S', model_multiplier: 1.2, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, description: 'A useful model', test_ok: true, test_latency_ms: 21, is_starred: true, tags: [{ name: 'Featured' }] }, { model_id: 'm2', name: 'Model Two', provider: 'p1', team_id: 2, team_name: 'Team A', provider_name: 'Provider A', test_ok: false, test_error: 'Unavailable' }], pagination: { page: 1, total: 2, limit: 30, total_pages: 1, has_prev: false, has_next: false } };
    return {};
  };
}

test('model library renders framed model cards, key selector and status in a real terminal', { timeout: 15000 }, async () => {
  const runtime = makeRuntime();
  runtime.libraryProvider = { team_id: 2, provider_id: 'p1', provider_name: 'Provider A' };
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  const tty = terminal(160, 42);
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: fixtureApi(), pages: [page], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('Provider A'));
    const initialScreen = tty.screen();
    assert.ok(initialScreen.includes('选择 API Key'), `key selector missing:\n${initialScreen}`);
    assert.ok(initialScreen.includes('Key：Main Key'), `status bar missing key state:\n${initialScreen}`);
    const initial = await page.load(fixtureApi());
    const provider = initial.sections.find(section => section.title === '供应商').cards[0];
    assert.equal(typeof provider.run, 'function', 'provider card is the model directory entry point');
    await provider.run({ refresh: async () => {} });
    assert.equal(runtime.libraryProvider.provider_id, 'p1');
    await until(() => tty.screen().includes('Model One Alias'));
    const screen = tty.screen();
    for (const text of ['┌', '┐', '│  Model One Alias', '│  输入价：0.1', '│  测试通过']) assert.ok(screen.includes(text), `terminal missing ${text}:\n${screen}`);
    const modelSection = (await page.load(fixtureApi())).sections.find(section => section.title.includes('模型目录'));
    assert.equal(modelSection.cards.length, 2);
    assert.ok(modelSection.cards.every(card => typeof card.run === 'function'));
  } finally { tty.input.write('q'); await task; }
});

test('model card testing requires pricing confirmation', async () => {
  const calls = [];
  const runtime = makeRuntime();
  runtime.libraryProvider = { team_id: 2, provider_id: 'p1', provider_name: 'Provider A' };
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  const section = (await page.load(fixtureApi(calls))).sections.find(item => item.title.includes('模型目录'));
  let confirmMessage = '';
  await section.cards[0].run({ choose: async (_title, options) => { assert.ok(options.some(option => option.value === 'test')); return 'test'; }, confirm: async (_title, message) => { confirmMessage = message; return false; } });
  assert.match(confirmMessage, /真实测试请求/);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});
