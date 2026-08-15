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
  res.json([]);
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
  res.json({ enabled: false, panels: [] });
});

router.put('/api-keys/:id/fusion-config', (req, res) => {
  res.json({ success: true });
});

// 签名配置
router.get('/api-keys/:id/signature', (req, res) => {
  res.json({ signature_enabled: false, signature_template: '' });
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
  res.json({ schedule_enabled: false, schedule_on_time: null, schedule_off_time: null, schedule_days: null, schedule_timezone: null });
});

router.put('/api-keys/:id/schedule', (req, res) => {
  res.json({ success: true });
});

// Key 配置
router.get('/api-keys/:id/config', (req, res) => {
  res.json({ custom_model_name: '', current_model_id: null });
});

// 使用统计
router.get('/usage', (req, res) => {
  res.json([]);
});

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

// 余额
router.get('/balance', (req, res) => {
  res.json(data.balance());
});

// 兑换码余额
router.get('/code-balances', (req, res) => {
  res.json([]);
});

// 产品
router.get('/products', (req, res) => {
  res.json([]);
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
  res.json({ content: '' });
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
  res.json({
    models: [],
    pagination: { page: 1, limit: 30, total: 0, total_pages: 1, has_prev: false, has_next: false }
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

// 模型测试（演示模式返回成功）
router.post('/models/:id/test', (req, res) => {
  res.json({ success: true, latency_ms: 250, tokens_per_second: 42.5 });
});

router.post('/models/test-batch', (req, res) => {
  res.json({ success: true, results: [] });
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
  res.json(data.adminStats());
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
