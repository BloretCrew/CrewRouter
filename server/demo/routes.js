const express = require('express');
const router = express.Router();
const data = require('./data');

// ========== 用户路由 ==========

// 模型列表
router.get('/models', (req, res) => {
  res.json(data.myTeamModels());
});

// API 密钥
router.get('/api-keys', (req, res) => {
  res.json(data.apiKeys());
});

// 创建 API 密钥（演示模式返回成功）
router.post('/api-keys', (req, res) => {
  res.json({ success: true, id: 999, key_prefix: 'sk-demo-new', key_value: 'sk-demo-new-xxxxxxxxxxxx' });
});

// 删除 API 密钥
router.delete('/api-keys/:id', (req, res) => {
  res.json({ success: true });
});

// 更新 API 密钥
router.put('/api-keys/:id', (req, res) => {
  res.json({ success: true });
});

// API 密钥用量
router.get('/api-keys/:id/usage', (req, res) => {
  const key = data.apiKeys().find(k => String(k.id) === String(req.params.id));
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  const stats = data.stats({ days: 14 }).daily;
  const ratio = key.id === 1 ? 0.64 : 0.36;
  res.json(stats.map((item, index) => ({
    date: item.date,
    requests: Math.max(1, Math.floor(item.requests * ratio + (index % 3))),
    tokens: Math.max(1, Math.floor(item.tokens * ratio)),
    cost: parseFloat((item.cost * ratio).toFixed(6)),
    model_name: key.current_model_name || '未绑定模型'
  })));
});

// API 密钥模型绑定（有序队列）
router.get('/api-keys/:id/models', (req, res) => {
  const key = data.apiKeys().find(k => String(k.id) === String(req.params.id));
  const queueIds = Array.isArray(key?.model_queue) && key.model_queue.length
    ? key.model_queue.map(m => String(m.model_id || m.id || m))
    : (key?.current_model_id ? [String(key.current_model_id)] : []);
  const queueSet = new Set(queueIds);
  const models = data.myTeamModels().map(m => ({
    ...m,
    assigned: queueSet.has(String(m.id)),
    sort_order: queueIds.indexOf(String(m.id))
  }));
  const queue = queueIds.map((id, idx) => {
    const found = data.myTeamModels().find(m => String(m.id) === id);
    return {
      model_id: id,
      id,
      name: found?.name || id,
      sort_order: idx
    };
  });
  res.json({ models, queue });
});

// 更新 API 密钥模型绑定（兼容 modelId / modelIds）
router.put('/api-keys/:id/models', (req, res) => {
  const key = data.apiKeys().find(k => String(k.id) === String(req.params.id));
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  let ordered = [];
  if (Array.isArray(req.body?.modelIds)) {
    ordered = req.body.modelIds.map(String).filter(Boolean);
  } else if (req.body?.modelId) {
    ordered = [String(req.body.modelId)];
  }
  key.current_model_id = ordered[0] || null;
  key.current_model_name = ordered[0] || null;
  key.model_queue = ordered.map((id, idx) => ({ model_id: id, name: id, sort_order: idx }));
  res.json({ success: true, modelIds: ordered, current_model_id: ordered[0] || null });
});

// Fusion 配置
router.get('/api-keys/:id/fusion-config', (req, res) => {
  const key = data.apiKeys().find(k => String(k.id) === String(req.params.id));
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  const queueIds = Array.isArray(key.model_queue) ? key.model_queue.map(m => String(m.model_id || m.id || m)) : [];
  const fallbackIds = ['gpt-4.1', 'deepseek-chat', 'claude-sonnet-4-20250514'];
  const validIds = [...new Set([...queueIds, ...fallbackIds])].filter(id => data.myTeamModels().some(m => String(m.id) === id));
  const panelModels = validIds.slice(0, 3);
  return res.json({
    panel_models: panelModels,
    judge_model_id: panelModels[0] || 'gpt-4.1',
    outer_model_id: panelModels[1] || panelModels[0] || 'gpt-4.1',
    fusion_enabled: true
  });
});

router.put('/api-keys/:id/fusion-config', (req, res) => {
  res.json({ success: true });
});

// 签名配置
router.get('/api-keys/:id/signature', (req, res) => {
  const key = data.apiKeys().find(k => String(k.id) === String(req.params.id));
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  res.json({ signature_enabled: key.signature_enabled === true, signature_template: '{model} · {tokens} · 缓存命中 {cache_hit}%' });
});

router.put('/api-keys/:id/signature', (req, res) => {
  res.json({ success: true });
});

// 启用/禁用
router.put('/api-keys/:id/enabled', (req, res) => {
  res.json({ success: true });
});

// 吞图
router.put('/api-keys/:id/swallow-images', (req, res) => {
  res.json({ success: true, swallow_images: !!req.body?.swallow_images });
});

router.put('/api-keys/:id/crewrouter-commands', (req, res) => {
  res.json({ success: true, crewrouter_commands: !!req.body?.crewrouter_commands });
});

// 调度配置
router.get('/api-keys/:id/schedule', (req, res) => {
  const key = data.apiKeys().find(k => String(k.id) === String(req.params.id));
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  res.json({
    schedule_enabled: key.schedule_enabled === true,
    schedule_on_time: key.schedule_on_time || '09:00',
    schedule_off_time: key.schedule_off_time || '18:00',
    schedule_days: key.schedule_days || [1, 2, 3, 4, 5],
    schedule_timezone: key.schedule_timezone || 'Asia/Shanghai'
  });
});

router.put('/api-keys/:id/schedule', (req, res) => {
  res.json({ success: true });
});

// Key 配置
router.get('/api-keys/:id/config', (req, res) => {
  const key = data.apiKeys().find(k => String(k.id) === String(req.params.id));
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  res.json({
    env: {
      ANTHROPIC_BASE_URL: 'https://demo.crewrouter.com/v1',
      ANTHROPIC_AUTH_TOKEN: key.key_value,
      ANTHROPIC_MODEL: key.current_model_id || 'gpt-4.1'
    },
    custom_model_name: key.custom_model_name || '',
    current_model_id: key.current_model_id || null
  });
});

// 使用统计
router.get('/usage', (req, res) => {
  res.json(data.stats({ days: 30 }).daily.map(item => ({
    date: item.date,
    total_tokens: item.tokens,
    total_cost: item.cost,
    total_requests: item.requests
  })));
});

// 项目工作与消息结构统计
router.get('/project-stats', (req, res) => res.json(data.projectStats()));
router.get('/message-stats', (req, res) => res.json(data.messageStats()));

// 详细统计（区分管理后台和用户控制台）
router.get('/stats', (req, res) => {
  if (req.baseUrl === '/api/admin') {
    res.json(data.adminStats());
  } else {
    res.json(data.stats(req.query));
  }
});

// 统计筛选选项
router.get('/stats/filters', (req, res) => {
  res.json(data.statsFilters());
});

router.get('/stats/multi/filters', (req, res) => {
  const filters = data.statsFilters();
  res.json({ users: data.adminUsers().map(u => ({ id: u.id, name: u.username })), teams: data.adminTeams().map(t => ({ id: t.id, name: t.name })), groups: data.adminGroups().map(g => ({ id: g.id, name: g.name })), models: filters.models.map(m => ({ id: m.model_id, name: m.name })), providers: filters.providers.map(p => ({ id: p.provider_id, name: p.name })), sources: ['codex', 'claude_code', 'opencode', 'qwen_code'].map(id => ({ id, name: id })), projects: [{ id: '/workspace/crewrouter', name: '/workspace/crewrouter' }, { id: '/workspace/plugin-lab', name: '/workspace/plugin-lab' }] });
});

router.get('/stats/multi', (req, res) => {
  const stats = data.adminStats();
  res.json({ summary: { requests: 12400, tokens: 5250000, cost: 18.64 }, rows: stats.byModel.map(item => ({ ...item, request_source: 'codex', workspace_path: '/workspace/crewrouter', user_name: 'Demo User', team_name: 'Demo Team', group_name: '标准组' })) });
});

// 余额
router.get('/balance', (req, res) => {
  res.json(data.balance());
});

// 兑换码余额
router.get('/code-balances', (req, res) => {
  res.json(data.codeBalances());
});

// 管理员查看用户可退款兑换码余额
router.get('/users/:id/code-balances', (req, res) => {
  res.json(data.codeBalances());
});

// 产品
router.get('/products', (req, res) => {
  res.json(data.adminProducts().filter(product => product.is_active));
});

// 头像上传（演示模式返回成功）
router.post('/avatar', (req, res) => {
  res.json({ success: true, avatar: null });
});

// 更新设置
router.put('/settings', (req, res) => {
  res.json({ success: true });
});

// 兑换码
router.post('/redeem', (req, res) => {
  res.json({ success: false, error: '演示模式下无法兑换' });
});

// 文档内容
router.get('/docs-content', (req, res) => {
  res.json({ content: `# CrewRouter 演示站\n\n这是一个用于体验 CrewRouter 多模型路由、API Key 管理和插件商店流程的演示环境。\n\n## 快速开始\n\n1. 在「模型库」查看可用模型并收藏或绑定到 API Key。\n2. 在「API Key 与用量」创建密钥、设置模型队列，并查看每日用量。\n3. 使用兼容 OpenAI Chat Completions 的地址调用已绑定模型。\n\n## API 地址\n\n- Chat Completions：\`/v1/chat/completions\`\n- 模型列表：\`/v1/models\`\n- 用户统计：\`/api/user/stats\`\n\n演示数据为固定样例，不会连接真实上游，也不会产生实际扣费。插件商店中的商品和兑换码仅用于展示购买流程。` });
});

// 模型库
router.get('/model-library', (req, res) => {
  const library = data.modelLibrary();
  res.json({
    ...library,
    available_series: library.available_series || [],
    total_models: library.total_models || 0
  });
});

// 模型库全局搜索（demo）
router.get('/model-library/search', (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10) || 30, 1), 50);
  const q = String(req.query.q || '').trim().toLowerCase();
  const provider = String(req.query.provider || '').trim();
  const series = String(req.query.series || '').trim();
  const test = String(req.query.test || '').trim();
  const tag = String(req.query.tag || '').trim();
  const sort = String(req.query.sort || 'default');
  const library = data.modelLibrary();
  let models = [];
  for (const team of library.teams || []) {
    for (const providerData of team.providers || []) {
      for (const model of providerData.models || []) {
        models.push({
          ...model,
          team_id: team.team_id,
          team_name: team.team_name,
          is_personal: team.is_personal,
          is_default: team.is_default,
          provider_id: providerData.provider_id,
          provider_name: providerData.provider_name,
          provider_enabled: providerData.provider_enabled,
          tags: providerData.tags || []
        });
      }
    }
  }
  if (q) models = models.filter(m => [m.name, m.description, m.alias, m.series, m.upstream_model_id, m.provider_name].some(v => String(v || '').toLowerCase().includes(q)));
  if (provider && provider !== 'all') {
    const normalizedProvider = provider.toLowerCase();
    models = models.filter(m => [m.provider, m.provider_id, m.provider_name]
      .some(value => String(value || '').toLowerCase() === normalizedProvider));
  }
  if (series && series !== 'all') models = models.filter(m => String(m.series) === series);
  if (test === 'pass') models = models.filter(m => m.test_ok === true);
  if (test === 'fail') models = models.filter(m => m.test_ok === false);
  if (test === 'untested') models = models.filter(m => m.test_ok !== true && m.test_ok !== false);
  if (tag && tag !== 'all') {
    const normalizedTag = tag.replace(/^tag:/i, '').trim().toLowerCase();
    models = models.filter(m => (m.tags || []).some(t =>
      String(t.id).toLowerCase() === normalizedTag || String(t.name).toLowerCase() === normalizedTag));
  }
  if (sort === 'name_asc') models.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (sort === 'name_desc') models.sort((a, b) => String(b.name).localeCompare(String(a.name)));
  if (sort === 'price_asc') models.sort((a, b) => (a.input_price_per_1k_tokens || 0) - (b.input_price_per_1k_tokens || 0));
  if (sort === 'price_desc') models.sort((a, b) => (b.input_price_per_1k_tokens || 0) - (a.input_price_per_1k_tokens || 0));
  const total = models.length;
  const offset = (page - 1) * limit;
  const pageModels = models.slice(offset, offset + limit);
  res.json({
    models: pageModels,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) || 1, has_prev: page > 1, has_next: offset + pageModels.length < total }
  });
});

// 供应商标签
router.get('/provider-tags', (req, res) => {
  res.json(data.providerTags());
});

// 供应商额度
router.get('/providers/quota', (req, res) => {
  res.json(data.providersQuota());
});

// 当前模型
router.get('/current-model', (req, res) => {
  res.json(data.currentModel());
});

router.put('/current-model', (req, res) => {
  res.json({ success: true });
});

// 用户供应商
router.get('/my-providers', (req, res) => {
  res.json(data.myProviders());
});

// 用户 Team 模型
router.get('/my-team-models', (req, res) => {
  res.json(data.myTeamModels());
});

// 批量操作
router.post('/my-team-models/batch-delete', (req, res) => {
  res.json({ success: true });
});

router.post('/my-team-models/batch-update', (req, res) => {
  res.json({ success: true });
});

// 排行榜
router.get('/leaderboard', (req, res) => {
  res.json(data.leaderboard());
});

// Key 标签
router.get('/key-tags', (req, res) => {
  res.json(data.keyTags());
});

router.post('/key-tags', (req, res) => {
  res.json({ success: true, id: 999 });
});

router.put('/key-tags/:id', (req, res) => {
  res.json({ success: true });
});

router.delete('/key-tags/:id', (req, res) => {
  res.json({ success: true });
});

router.put('/key-tags/reorder', (req, res) => {
  res.json({ success: true });
});

// 供应商列表（用户级别）
router.get('/providers', (req, res) => {
  res.json(data.adminProviders());
});

// 一键按测试结果写入自定义排序（demo：仅成功响应）
router.put('/model-library/star', (req, res) => {
  const { teamId, providerId, modelId, starred } = req.body || {};
  if (teamId == null || !providerId || !modelId || typeof starred !== 'boolean') {
    return res.status(400).json({ error: '请提供 teamId、providerId、modelId 和 starred' });
  }
  const stars = data.DEMO_STARRED || [];
  res.json({ success: true, teamId, providerId, modelId, starred, count: stars.length });
});

router.put('/model-library/order/by-test', (req, res) => {
  const sort = String((req.body && req.body.sort) || 'test_latency_asc');
  const allowed = new Set(['test_latency_asc', 'test_latency_desc', 'test_tps_desc']);
  if (!allowed.has(sort)) {
    return res.status(400).json({ error: '无效的测试排序方式' });
  }
  res.json({ success: true, sort, teams: 1, providers: 2, models: 8 });
});

// 按需加载供应商下的模型明细（展开供应商时调用）
router.get('/team/:teamId/provider/:providerId/models', (req, res) => {
  const { providerId } = req.params;
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const requestedLimit = parseInt(req.query.limit || '50', 10) || 50;
  const limit = Math.min(Math.max(requestedLimit, 1), 50);
  const offset = (page - 1) * limit;
  const search = String(req.query.search || '').trim().toLowerCase();
  const series = String(req.query.series || 'all');
  const testFilter = String(req.query.test || 'all');
  const sort = String(req.query.sort || 'default');
  const library = data.modelLibrary();
  for (const team of library.teams || []) {
    for (const provider of team.providers || []) {
      if (String(provider.provider_id) === String(providerId)) {
        let models = provider.models || [];
        if (search) {
          models = models.filter(m =>
            String(m.name || '').toLowerCase().includes(search) ||
            String(m.description || '').toLowerCase().includes(search) ||
            String(m.alias || '').toLowerCase().includes(search) ||
            String(m.series || '').toLowerCase().includes(search)
          );
        }
        if (series !== 'all') models = models.filter(m => m.series === series);
        if (testFilter === 'pass') models = models.filter(m => m.test_ok === true);
        if (testFilter === 'fail') models = models.filter(m => m.test_ok === false);
        if (testFilter === 'untested') models = models.filter(m => m.test_ok !== true && m.test_ok !== false);
        if (sort === 'name_asc') models = [...models].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        if (sort === 'name_desc') models = [...models].sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
        if (sort === 'price_asc') models = [...models].sort((a, b) => (a.input_price_per_1k_tokens || 0) - (b.input_price_per_1k_tokens || 0));
        if (sort === 'price_desc') models = [...models].sort((a, b) => (b.input_price_per_1k_tokens || 0) - (a.input_price_per_1k_tokens || 0));
        const total = models.length;
        const pageModels = models.slice(offset, offset + limit);
        return res.json({
          models: pageModels,
          pagination: {
            page,
            limit,
            total,
            total_pages: Math.ceil(total / limit) || 1,
            has_prev: page > 1,
            has_next: offset + pageModels.length < total
          }
        });
      }
    }
  }
  res.json({
    models: [],
    pagination: { page, limit, total: 0, total_pages: 1, has_prev: false, has_next: false }
  });
});

// 自定义供应商模型
router.get('/providers/:providerId/models', (req, res) => {
  const provider = data.myProviders().find(p => String(p.id) === String(req.params.providerId));
  if (!provider) return res.status(404).json({ error: '供应商不存在' });
  const models = data.myTeamModels().filter(model =>
    (provider.id === 'team-openai' && model.provider === 'openai') ||
    (provider.id === 'local-gateway' && ['deepseek', 'openai'].includes(model.provider))
  ).slice(0, provider.model_count);
  res.json(models.map(model => ({ ...model, provider: provider.id, provider_name: provider.name })));
});

// 模型测试（演示模式返回成功）
router.post('/models/:id/test', (req, res) => {
  res.json({ success: true, latency_ms: 250, tokens_per_second: 42.5 });
});

router.post('/models/test-batch', (req, res) => {
  res.json({ success: true, results: [] });
});

// Playground 与对话在 demo 中使用固定响应，既可展示历史，也可完成基本交互
router.get('/thinking-capabilities', (req, res) => {
  const capabilities = {};
  for (const model of data.myTeamModels()) {
    capabilities[model.id] = { supportsThinking: /^(deepseek-|claude-|o4)/.test(model.id), supportsThinkingBudget: /^(claude-|o4)/.test(model.id) };
  }
  res.json(capabilities);
});

router.get('/history', (req, res) => {
  const records = data.usageLogs(1, 50).logs.slice(0, 8).map(log => ({ id: log.id, model: log.model_id, promptTokens: log.prompt_tokens, completionTokens: log.completion_tokens, totalTokens: log.tokens_used, cost: log.cost, reasoningContent: '演示思考过程：先拆解问题，再给出清晰答案。', requestParams: { temperature: 0.7, thinking: true }, finishReason: 'stop', response: `这是 Playground 的演示回复 #${log.id}。`, messages: [{ role: 'user', content: `演示问题 #${log.id}` }], createdAt: log.created_at }));
  res.json({ total: records.length, limit: records.length, offset: 0, records });
});

router.get('/history/:id', (req, res) => {
  const log = data.usageLogDetail(parseInt(req.params.id, 10));
  if (!log) return res.status(404).json({ error: '记录不存在' });
  res.json({ id: log.id, model: log.model_id, promptTokens: log.prompt_tokens, completionTokens: log.completion_tokens, totalTokens: log.tokens_used, cost: log.cost, reasoningContent: '演示思考过程：先拆解问题，再给出清晰答案。', requestParams: { temperature: 0.7, thinking: true }, finishReason: 'stop', response: `这是 Playground 的演示回复 #${log.id}。`, messages: [{ role: 'user', content: `演示问题 #${log.id}` }], createdAt: log.created_at });
});

// 演示：模型调用可用率（默认近 24 小时按 15 分钟；days>1 按日）
const DEMO_SLOT_MS = 15 * 60 * 1000;
const DEMO_SLOT_COUNT = 96; // 24h / 15m

function demoUptimeForId(modelId, days = 1) {
  const dayCount = Math.min(Math.max(parseInt(days, 10) || 1, 1), 365);
  const slotMode = dayCount <= 1;
  const slotCount = slotMode ? DEMO_SLOT_COUNT : dayCount;
  const spark = [];
  const daysOut = [];
  let totalSuccess = 0;
  let totalFail = 0;
  const now = new Date();
  const endSlot = Math.floor(now.getTime() / DEMO_SLOT_MS) * DEMO_SLOT_MS;
  for (let i = slotCount - 1; i >= 0; i--) {
    let date;
    if (slotMode) {
      date = new Date(endSlot - i * DEMO_SLOT_MS).toISOString();
    } else {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - i);
      date = d.toISOString().slice(0, 10);
    }
    let h = 0;
    const seed = String(modelId) + date;
    for (let c = 0; c < seed.length; c++) h = ((h << 5) - h + seed.charCodeAt(c)) | 0;
    const r = Math.abs(h) % 1000;
    let success = 80 + (r % 40);
    let fail = 0;
    let status = 'ok';
    if (r % 97 === 0) {
      fail = 12;
      success = 40;
      status = 'outage';
    } else if (r % 41 === 0) {
      fail = 3;
      success = 100;
      status = 'degraded';
    } else if (r % 23 === 0) {
      success = 0;
      fail = 0;
      status = 'none';
    }
    totalSuccess += success;
    totalFail += fail;
    spark.push(status);
    daysOut.push({ date, status, success, fail });
  }
  const total = totalSuccess + totalFail;
  const uptime_pct = total === 0 ? null : Math.round((totalSuccess / total) * 10000) / 100;
  let label = 'No data';
  if (uptime_pct != null) {
    if (uptime_pct >= 99) label = 'Normal';
    else if (uptime_pct >= 95) label = 'Degraded';
    else label = 'Outage';
  }
  return {
    uptime_pct,
    label,
    total_success: totalSuccess,
    total_fail: totalFail,
    spark,
    days: daysOut,
    model_id: modelId,
    granularity: slotMode ? '15m' : 'day',
    hours: slotMode ? 24 : undefined,
    slots: slotMode ? DEMO_SLOT_COUNT : undefined
  };
}

router.get('/models/uptime', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  const days = parseInt(req.query.days, 10) || 1;
  const items = {};
  for (const id of ids) {
    const u = demoUptimeForId(id, days);
    items[id] = {
      uptime_pct: u.uptime_pct,
      label: u.label,
      total_success: u.total_success,
      total_fail: u.total_fail,
      spark: u.spark
    };
  }
  const slotMode = days <= 1;
  res.json({
    days,
    hours: slotMode ? 24 : undefined,
    slots: slotMode ? DEMO_SLOT_COUNT : undefined,
    granularity: slotMode ? '15m' : 'day',
    items
  });
});

router.get('/models/:id/uptime', (req, res) => {
  const days = parseInt(req.query.days, 10) || 1;
  res.json(demoUptimeForId(req.params.id, days));
});

// 全局使用记录
router.get('/usage-logs', (req, res) => res.json(data.usageLogs(parseInt(req.query.page, 10) || 1, parseInt(req.query.limit, 10) || 50)));
router.get('/usage-logs/:id', (req, res) => {
  const log = data.usageLogDetail(parseInt(req.params.id, 10));
  if (!log) return res.status(404).json({ error: '记录不存在' });
  res.json({ log });
});
router.get('/error-logs', (req, res) => res.json({ logs: data.usageLogs(1, 12).logs.map((log, i) => ({ ...log, status_code: i % 4 === 0 ? 429 : 500, error_type: i % 4 === 0 ? 'rate_limit' : 'upstream_error', error_message: i % 4 === 0 ? '演示：上游限流，已切换备用 Key' : '演示：上游服务短暂不可用', is_final: i % 4 !== 0 })), total: 12, page: 1, limit: 50, retention_days: 14 }));
router.get('/audit-logs', (req, res) => res.json({ logs: [{ id: 1, action: 'api_key.create', description: '创建了「生产环境 Key」', username: 'Demo User', created_at: new Date(Date.now() - 3600000).toISOString() }, { id: 2, action: 'model.test', description: '测试模型 GPT-4.1 成功', username: 'Demo User', created_at: new Date(Date.now() - 7200000).toISOString() }], total: 2, page: 1, limit: 50 }));

router.post('/usage', (req, res) => {
  res.json({ success: true });
});

// ========== 管理后台路由 ==========

// 用户列表
router.get('/users', (req, res) => {
  res.json(data.adminUsers());
});

// 更新用户
router.put('/users/:id', (req, res) => {
  res.json({ success: true });
});

// 模型列表
router.get('/models', (req, res) => {
  res.json(data.adminModels());
});

// 创建模型
router.post('/models', (req, res) => {
  res.json({ success: true, id: 'new-model' });
});

// 删除模型
router.delete('/models/:id', (req, res) => {
  res.json({ success: true });
});

// 供应商列表
router.get('/providers', (req, res) => {
  res.json(data.adminProviders());
});

// 创建供应商
router.post('/providers', (req, res) => {
  res.json({ success: true, id: 'new-provider' });
});

// 删除供应商
router.delete('/providers/:id', (req, res) => {
  res.json({ success: true });
});

// 统计
router.get('/stats', (req, res) => {
  res.json(req.baseUrl === '/api/admin' ? data.adminStats() : data.stats(req.query));
});

// 设置
router.get('/settings', (req, res) => {
  res.json(data.adminSettings());
});

router.put('/settings', (req, res) => {
  res.json({ success: true });
});

// 飞书登录配置（演示模式）
router.get('/feishu-login', (req, res) => {
  res.json(data.feishuLoginConfig());
});

router.put('/feishu-login', (req, res) => {
  res.json({ success: true, ...data.feishuLoginConfig(), enabled: !!req.body?.enabled });
});

// 团队
router.get('/teams', (req, res) => {
  res.json(data.adminTeams());
});

// 用户组
router.get('/user-groups', (req, res) => {
  res.json(data.adminGroups());
});

router.post('/user-groups', (req, res) => {
  res.json({ success: true, id: 99 });
});

router.put('/user-groups/:id', (req, res) => {
  res.json({ success: true });
});

router.delete('/user-groups/:id', (req, res) => {
  res.json({ success: true });
});

router.put('/user-groups/:id/set-default', (req, res) => {
  res.json({ success: true });
});

// 用户组规则
router.get('/user-groups/:id/rules', (req, res) => {
  res.json(data.adminGroupRules(req.params.id));
});

router.post('/user-groups/:id/rules', (req, res) => {
  res.json({ success: true, id: 99 });
});

router.put('/user-group-rules/:id', (req, res) => {
  res.json({ success: true });
});

router.delete('/user-group-rules/:id', (req, res) => {
  res.json({ success: true });
});

router.post('/user-groups', (req, res) => {
  res.json({ success: true, id: 99 });
});

router.put('/user-groups/:id', (req, res) => {
  res.json({ success: true });
});

router.delete('/user-groups/:id', (req, res) => {
  res.json({ success: true });
});

router.put('/user-groups/:id/set-default', (req, res) => {
  res.json({ success: true });
});

// 用户组规则
router.get('/user-groups/:id/rules', (req, res) => {
  res.json(data.adminGroupRules(req.params.id));
});

router.post('/user-groups/:id/rules', (req, res) => {
  res.json({ success: true, id: 99 });
});

router.put('/user-group-rules/:id', (req, res) => {
  res.json({ success: true });
});

router.delete('/user-group-rules/:id', (req, res) => {
  res.json({ success: true });
});

// 产品
router.get('/products', (req, res) => {
  res.json(data.adminProducts());
});

// 兑换码
router.get('/redemption-codes', (req, res) => {
  res.json(data.adminRedemptionCodes());
});

// 使用日志
router.get('/usage-logs', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  res.json(data.usageLogs(page, limit));
});

// 使用日志详情（demo 模式补全大字段）
router.get('/usage-logs/:id', (req, res) => {
  const log = data.usageLogDetail(parseInt(req.params.id, 10));
  if (!log) return res.status(404).json({ error: '记录不存在' });
  res.json({ log });
});

// 通配：所有未匹配的 GET/POST/PUT/DELETE 返回成功
router.all('*', (req, res) => {
  if (req.method === 'GET') {
    res.json([]);
  } else {
    res.json({ success: true });
  }
});

module.exports = router;
