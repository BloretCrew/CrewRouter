'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');
const { runPagedTui } = require('../tui/engine');
const { terminal, until } = require('./helpers/tty');

function makeRuntime() {
  return { client: {}, cfg: { tui: { days: 30 } }, profileName: 'test' };
}

test('model library TUI renders web sections in binding, quota, filters, stars and directory order', { timeout: 15000 }, async () => {
  const runtime = makeRuntime();
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  const api = async path => {
    if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 1, visible_model_count: 1 }] }], starred_models: [{ team_id: 2, provider: 'p1', model_id: 'star-1', name: 'Starred', alias: 'Starred', provider_name: 'Provider A', test_ok: true, test_latency_ms: 100 }], available_series: [], total_models: 1 };
    if (path === '/api/user/api-keys') return [{ id: 1, name: 'Server CR CLI', current_model_name: 'glm-5.3-flash', current_model_provider_name: 'Blora Router', model_queue: [{ model_id: 'm1', name: 'GLM 5.3 Flash' }], harness_models: [{ harness: 'codex', model_id: 'm2', name: 'Claude Sonnet', provider_name: 'Anthropic' }], request_model_bindings: [{ request_model_name: 'my-sonnet', harness: 'claude_code', model_id: 'm3', name: 'Claude Sonnet 4.5', provider_name: 'Anthropic' }] }];
    if (path === '/api/user/providers/quota') return { providers: [{ id: 'q1', name: 'Quota Provider', quota: { total: 10, remaining: 8 }, status: 'success' }] };
    if (path === '/api/user/provider-tags') return [];
    if (path === '/api/user/api-keys/1/models') return { queue: [{ model_id: 'star-1', name: 'Starred' }] };
    return {};
  };
  const tty = terminal(120, 45);
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api, pages: [page], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('Quota Provider'));
    const screen = tty.screen();
    const positions = ['当前 Key 绑定', '供应商额度', '搜索与筛选', '已收藏模型'].map(value => screen.indexOf(`▸ ${value}`));
    positions.push(screen.lastIndexOf('▸ 供应商'));
    assert.ok(positions.every(value => value >= 0), `missing model-library section: ${positions.join(',')}`);
    assert.ok(positions.every((value, index) => index === 0 || positions[index - 1] < value), `unexpected model-library section order: ${positions.join(',')}`);
    assert.ok(screen.includes('当前 Key：Server CR CLI'));
    assert.ok(screen.includes('供应商：Blora Router · 当前模型：glm-5.3-flash'));
    assert.ok(screen.includes('默认模型队列：1 个'));
    assert.ok(screen.includes('Codex 专属模型'));
    assert.ok(screen.includes('Claude Sonnet 4.5'));
    assert.ok(screen.includes('请求名映射：my-sonnet'));
    assert.ok(screen.includes('选择 API Key'));
    assert.ok(!screen.includes('secret-key-value'));
    assert.ok(screen.includes('刷新供应商额度'));
    assert.ok(!screen.includes('模型库概览'));
  } finally { tty.input.write('q'); await task; }
});

test('user model library exposes key selector and model cards with web-equivalent status details', async () => {
  const runtime = makeRuntime();
  const api = async path => {
    if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 1, visible_model_count: 1 }] }], starred_models: [], available_series: ['S'], total_models: 1 };
    if (path === '/api/user/api-keys') return [{ id: 1, name: 'Main Key', model_queue: [] }];
    if (path === '/api/user/team/2/provider/p1/models') return { models: [{ model_id: 'm1', name: 'Model One', alias: 'Model One Alias', provider: 'p1', team_id: 2, team_name: 'Team A', provider_name: 'Provider A', series: 'S', model_multiplier: 1.2, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, description: 'A useful model', test_ok: true, test_latency_ms: 21, test_tokens_per_second: 18.5, is_starred: true, is_hidden: false, tags: [{ name: 'Featured' }] }], pagination: { page: 1, total: 1, limit: 30, total_pages: 1, has_prev: false, has_next: false } };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  runtime.libraryProvider = { team_id: 2, provider_id: 'p1', provider_name: 'Provider A' };
  const data = await page.load(api);
  assert.equal(data.pageToolbar, true);
  assert.ok(data.actions.some(action => action.label === '选择 API Key'));
  const section = data.sections.find(item => item.title.includes('模型目录'));
  assert.equal(section.columns, undefined);
  assert.equal(section.cards.length, 1);
  const card = section.cards[0];
  assert.equal(card.label, 'Model One Alias');
  assert.equal(card.value, '未加入当前 Key');
  for (const text of ['Team A · Provider A', '系列：S · 倍率：计费倍率 ×1.20', '输入价：0.1 · 输出价：0.2 人民币/千Token', '测试通过 · 21 毫秒', '通过 21毫秒 · 已收藏', 'A useful model', '上游 ID：Model One', 'Featured']) assert.ok(card.detail.includes(text), `model card missing ${text}`);
  assert.equal(typeof card.run, 'function');
});
