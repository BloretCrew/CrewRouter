// 演示数据模块 — 提供所有控制台和管理后台的模拟数据

// 确定性伪随机（基于种子，保证每次请求结果一致）
function seededRand(seed) {
  let x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

// ========== 基础数据 ==========

const DEMO_USER = {
  id: 1,
  username: 'Demo User',
  email: 'demo@crewrouter.com',
  avatar: null,
  isAdmin: true,
  balance: 9999,
  refund_balance: 0,
  api_signature_enabled: false,
  api_signature_template: '',
  email_verified: true,
  group_id: 1,
  team_id: 1,
  rate_limit_rpm: 0,
  rate_limit_tpm: 0,
  tags: '',
  created_at: '2025-01-01T00:00:00Z'
};

// 用户组
const DEMO_GROUPS = [
  { id: 1, name: '标准组', description: '标准用户组，适用于日常开发使用', is_default: true, created_at: '2025-01-01T00:00:00Z' },
  { id: 2, name: '高级组', description: '高级用户组，适用于重度使用场景', is_default: false, created_at: '2025-01-15T00:00:00Z' },
];

// 用户组规则
const DEMO_GROUP_RULES = [
  { id: 1, group_id: 1, rule_type: 'requests', rule_value: 5000, duration_hours: 24, description: '每日请求次数上限', created_at: '2025-01-01T00:00:00Z' },
  { id: 2, group_id: 1, rule_type: 'tokens', rule_value: 5000000, duration_hours: 24, description: '每日 Token 用量上限', created_at: '2025-01-01T00:00:00Z' },
  { id: 3, group_id: 1, rule_type: 'requests', rule_value: 100000, duration_hours: 720, description: '每月请求次数上限', created_at: '2025-01-01T00:00:00Z' },
  { id: 4, group_id: 2, rule_type: 'requests', rule_value: 20000, duration_hours: 24, description: '每日请求次数上限', created_at: '2025-01-15T00:00:00Z' },
  { id: 5, group_id: 2, rule_type: 'tokens', rule_value: 20000000, duration_hours: 24, description: '每日 Token 用量上限', created_at: '2025-01-15T00:00:00Z' },
  { id: 6, group_id: 2, rule_type: 'requests', rule_value: 500000, duration_hours: 720, description: '每月请求次数上限', created_at: '2025-01-15T00:00:00Z' },
];

const DEMO_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', format: 'openai', enabled: true, created_by: null, notes: '', created_at: '2025-01-01T00:00:00Z' },
  { id: 'anthropic', name: 'Anthropic', base_url: 'https://api.anthropic.com', format: 'anthropic', enabled: true, created_by: null, notes: '', created_at: '2025-01-01T00:00:00Z' },
  { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', format: 'openai', enabled: true, created_by: null, notes: '', created_at: '2025-03-01T00:00:00Z' },
];

const DEMO_MODELS = [
  // OpenAI
  { id: 'gpt-4.1', name: 'GPT-4.1', alias: '', series: 'GPT', description: 'OpenAI 2025 旗舰模型，百万级上下文', enabled: true, provider: 'openai', provider_name: 'OpenAI', upstream_model_id: 'gpt-4.1', input_price_per_1k_tokens: 0.002, output_price_per_1k_tokens: 0.008, cached_output_price_per_1k_tokens: 0.0005, model_multiplier: 0.8, completion_multiplier: 0.8, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-04-01T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', alias: '', series: 'GPT', description: 'GPT-4.1 轻量版，速度与成本平衡', enabled: true, provider: 'openai', provider_name: 'OpenAI', upstream_model_id: 'gpt-4.1-mini', input_price_per_1k_tokens: 0.0004, output_price_per_1k_tokens: 0.0016, cached_output_price_per_1k_tokens: 0.0001, model_multiplier: 0.15, completion_multiplier: 0.15, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-04-01T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
  { id: 'o4-mini', name: 'o4-mini', alias: '', series: 'o', description: 'OpenAI 推理模型，擅长复杂逻辑和代码', enabled: true, provider: 'openai', provider_name: 'OpenAI', upstream_model_id: 'o4-mini', input_price_per_1k_tokens: 0.0011, output_price_per_1k_tokens: 0.0044, cached_output_price_per_1k_tokens: 0.000275, model_multiplier: 0.5, completion_multiplier: 0.5, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-05-01T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
  // Anthropic
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', alias: '', series: 'Claude', description: 'Anthropic 最强模型，深度推理与创作', enabled: true, provider: 'anthropic', provider_name: 'Anthropic', upstream_model_id: 'claude-opus-4-20250514', input_price_per_1k_tokens: 0.015, output_price_per_1k_tokens: 0.075, cached_output_price_per_1k_tokens: 0.0015, model_multiplier: 5.0, completion_multiplier: 5.0, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-05-14T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', alias: '', series: 'Claude', description: 'Anthropic 高性能模型，速度与能力兼备', enabled: true, provider: 'anthropic', provider_name: 'Anthropic', upstream_model_id: 'claude-sonnet-4-20250514', input_price_per_1k_tokens: 0.003, output_price_per_1k_tokens: 0.015, cached_output_price_per_1k_tokens: 0.0003, model_multiplier: 1.2, completion_multiplier: 1.2, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-05-14T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', alias: '', series: 'Claude', description: 'Anthropic 快速轻量模型，极致性价比', enabled: true, provider: 'anthropic', provider_name: 'Anthropic', upstream_model_id: 'claude-3-5-haiku-20241022', input_price_per_1k_tokens: 0.0008, output_price_per_1k_tokens: 0.004, cached_output_price_per_1k_tokens: 0.00008, model_multiplier: 0.3, completion_multiplier: 0.3, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-01-01T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
  // DeepSeek
  { id: 'deepseek-chat', name: 'DeepSeek V3', alias: '', series: 'DeepSeek', description: 'DeepSeek 旗舰 MoE 模型，671B 参数', enabled: true, provider: 'deepseek', provider_name: 'DeepSeek', upstream_model_id: 'deepseek-chat', input_price_per_1k_tokens: 0.00014, output_price_per_1k_tokens: 0.00028, cached_output_price_per_1k_tokens: 0.000014, model_multiplier: 0.05, completion_multiplier: 0.05, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-03-01T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', alias: '', series: 'DeepSeek', description: 'DeepSeek 推理模型，强化学习驱动的思维链', enabled: true, provider: 'deepseek', provider_name: 'DeepSeek', upstream_model_id: 'deepseek-reasoner', input_price_per_1k_tokens: 0.00055, output_price_per_1k_tokens: 0.00219, cached_output_price_per_1k_tokens: 0.00014, model_multiplier: 0.2, completion_multiplier: 0.2, billing_mode: 'token', rate_limit_rpm: 0, rate_limit_tpm: 0, icon_url: '', series_icon_url: '', created_at: '2025-03-01T00:00:00Z', thinking_model_id: null, non_thinking_model_id: null },
];

const DEMO_TEAMS = [
  { id: 1, name: 'Demo Team', description: '演示团队', is_personal: true, is_default: true, created_at: '2025-01-01T00:00:00Z' }
];

const DEMO_API_KEYS = [
  {
    id: 1, name: '生产环境 Key', key_prefix: 'sk-demo-prod', key_value: 'sk-demo-prod-xxxxxxxxxxxx', custom_model_name: '', current_model_id: 'gpt-4.1', current_model_name: 'GPT-4.1',
    model_queue: [
      { model_id: 'gpt-4.1', name: 'GPT-4.1', sort_order: 0 },
      { model_id: 'deepseek-chat', name: 'DeepSeek V3', sort_order: 1 }
    ],
    current_model_provider_name: 'OpenAI',
    current_model_test_ok: true, current_model_test_latency_ms: 320, current_model_test_tokens_per_second: 45.2, current_model_test_tested_at: '2025-06-28T12:00:00Z',
    is_system: false, enabled: true, created_at: '2025-01-15T10:00:00Z', last_used_at: '2025-06-28T14:30:00Z', expires_at: null,
    signature_enabled: false, signature_template: '', swallow_images: false, crewrouter_commands: true, schedule_enabled: false, schedule_on_time: null, schedule_off_time: null, schedule_days: null, schedule_timezone: null,
    total_tokens: 1250000, total_cost: 4.85, total_requests: 3200,
    tags: [{ id: 1, name: '生产', color: '#22c55e' }]
  },
  {
    id: 2, name: '测试环境 Key', key_prefix: 'sk-demo-test', key_value: 'sk-demo-test-xxxxxxxxxxxx', custom_model_name: '', current_model_id: 'deepseek-chat', current_model_name: 'DeepSeek V3',
    current_model_provider_name: 'DeepSeek',
    current_model_test_ok: true, current_model_test_latency_ms: 210, current_model_test_tokens_per_second: 78.5, current_model_test_tested_at: '2025-06-27T16:00:00Z',
    is_system: false, enabled: true, created_at: '2025-02-01T08:00:00Z', last_used_at: '2025-06-27T18:00:00Z', expires_at: null,
    signature_enabled: false, signature_template: '', swallow_images: false, crewrouter_commands: true, schedule_enabled: false, schedule_on_time: null, schedule_off_time: null, schedule_days: null, schedule_timezone: null,
    total_tokens: 450000, total_cost: 0.92, total_requests: 1500,
    tags: [{ id: 2, name: '测试', color: '#3b82f6' }]
  }
];

const DEMO_KEY_TAGS = [
  { id: 1, name: '生产', color: '#22c55e', sort_order: 0 },
  { id: 2, name: '测试', color: '#3b82f6', sort_order: 1 }
];

const DEMO_PROVIDER_TAGS = [
  { id: 1, name: '主力', color: '#22c55e', sort_order: 0 },
  { id: 2, name: '备用', color: '#f59e0b', sort_order: 1 },
];

// ========== 生成统计数据 ==========

function generateDemoStats(days, startDate, endDate) {
  const daily = [];
  let totalRequests = 0, totalTokens = 0, totalPrompt = 0, totalCompletion = 0, totalCached = 0, totalCost = 0;

  // 预定义每日数据（固定，不依赖 Math.random）
  const dailyPattern = [
    { r: 135, t: 480 }, { r: 142, t: 510 }, { r: 98, t: 350 }, { r: 110, t: 400 }, { r: 65, t: 220 },
    { r: 55, t: 180 }, { r: 78, t: 270 }, { r: 148, t: 530 }, { r: 155, t: 560 }, { r: 130, t: 460 },
    { r: 120, t: 430 }, { r: 105, t: 380 }, { r: 60, t: 200 }, { r: 50, t: 170 }, { r: 140, t: 500 },
    { r: 160, t: 580 }, { r: 125, t: 450 }, { r: 115, t: 410 }, { r: 100, t: 360 }, { r: 70, t: 240 },
    { r: 58, t: 195 }, { r: 145, t: 520 }, { r: 150, t: 540 }, { r: 138, t: 490 }, { r: 118, t: 420 },
    { r: 108, t: 390 }, { r: 62, t: 210 }, { r: 52, t: 175 }, { r: 132, t: 470 }, { r: 128, t: 460 },
  ];
  const today = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const pat = dailyPattern[i % dailyPattern.length];
    const requests = pat.r;
    const tokens = pat.t * requests;
    const prompt = Math.floor(tokens * (0.55 + seededRand(i * 7) * 0.15));
    const completion = tokens - prompt;
    const cached = Math.floor(prompt * (0.15 + seededRand(i * 13) * 0.2));
    const cost = parseFloat((tokens * 0.0000035).toFixed(6));
    const latency = 180 + Math.floor(seededRand(i * 19) * 350);

    daily.push({ date: dateStr, requests, tokens, prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached, cost, avg_latency: latency });
    totalRequests += requests;
    totalTokens += tokens;
    totalPrompt += prompt;
    totalCompletion += completion;
    totalCached += cached;
    totalCost += cost;
  }

  // 每个模型使用不同比例，确保数据各不相同
  const modelDefs = [
    { id: 'gpt-4.1', name: 'GPT-4.1', reqPct: 0.22, tokPct: 0.28, costPct: 0.32, lat: 268, cachePct: 0.35 },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', reqPct: 0.18, tokPct: 0.18, costPct: 0.22, lat: 342, cachePct: 0.28 },
    { id: 'deepseek-chat', name: 'DeepSeek V3', reqPct: 0.25, tokPct: 0.22, costPct: 0.08, lat: 195, cachePct: 0.42 },
    { id: 'deepseek-reasoner', name: 'DeepSeek R1', reqPct: 0.10, tokPct: 0.12, costPct: 0.12, lat: 580, cachePct: 0.18 },
    { id: 'o4-mini', name: 'o4-mini', reqPct: 0.15, tokPct: 0.14, costPct: 0.18, lat: 380, cachePct: 0.25 },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', reqPct: 0.10, tokPct: 0.06, costPct: 0.05, lat: 155, cachePct: 0.32 },
  ];

  return {
    daily,
    byModel: modelDefs.map(m => ({
      model_id: m.id, model_name: m.name,
      requests: Math.floor(totalRequests * m.reqPct),
      tokens: Math.floor(totalTokens * m.tokPct),
      prompt_tokens: Math.floor(totalPrompt * m.tokPct),
      completion_tokens: Math.floor(totalCompletion * m.tokPct),
      cached_tokens: Math.floor(totalCached * m.cachePct),
      cost: parseFloat((totalCost * m.costPct).toFixed(6)),
      avg_latency: m.lat
    })),
    hourly: Array.from({ length: 24 }, (_, h) => {
      const peak = h >= 9 && h <= 22;
      const base = peak ? 70 : 8;
      return {
        hour: h,
        requests: base + Math.floor(seededRand(h * 31) * 50),
        tokens: (base * 350) + Math.floor(seededRand(h * 37) * 10000),
        cached_tokens: Math.floor(seededRand(h * 41) * 4000),
        cost: parseFloat((seededRand(h * 43) * 0.08).toFixed(6))
      };
    }),
    byApiKey: DEMO_API_KEYS.map(k => ({
      key_id: k.id, key_name: k.name, key_prefix: k.key_prefix,
      requests: k.total_requests, tokens: k.total_tokens,
      cached_tokens: Math.floor(k.total_tokens * 0.2),
      cost: k.total_cost
    })),
    summary: {
      total_requests: totalRequests,
      total_tokens: totalTokens,
      total_prompt_tokens: totalPrompt,
      total_completion_tokens: totalCompletion,
      total_cached_tokens: totalCached,
      total_cost: parseFloat(totalCost.toFixed(6)),
      avg_latency: 260,
      first_request: daily[0]?.date || null,
      last_request: daily[daily.length - 1]?.date || null
    }
  };
}

const DEMO_LEADERBOARD = {
  leaderboard: [
    { rank: 1, username: 'Alice Zhang', avatar: null, totalRequests: 58200, totalTokens: 28500000, totalPoints: 85.5, cacheHitRate: 42.3, balance: 1200, isCurrentUser: false },
    { rank: 2, username: 'Bob Wang', avatar: null, totalRequests: 42100, totalTokens: 19800000, totalPoints: 62.4, cacheHitRate: 38.1, balance: 890, isCurrentUser: false },
    { rank: 3, username: 'Demo User', avatar: null, totalRequests: 35600, totalTokens: 15200000, totalPoints: 48.2, cacheHitRate: 35.7, balance: 9999, isCurrentUser: true },
    { rank: 4, username: 'Carol Li', avatar: null, totalRequests: 28900, totalTokens: 12100000, totalPoints: 38.9, cacheHitRate: 31.2, balance: 560, isCurrentUser: false },
    { rank: 5, username: 'David Chen', avatar: null, totalRequests: 21500, totalTokens: 8900000, totalPoints: 28.1, cacheHitRate: 28.5, balance: 340, isCurrentUser: false },
    { rank: 6, username: 'Eva Liu', avatar: null, totalRequests: 15800, totalTokens: 6200000, totalPoints: 19.8, cacheHitRate: 25.3, balance: 210, isCurrentUser: false },
    { rank: 7, username: 'Frank Wu', avatar: null, totalRequests: 9200, totalTokens: 3100000, totalPoints: 10.2, cacheHitRate: 22.1, balance: 150, isCurrentUser: false },
    { rank: 8, username: 'Grace Zhao', avatar: null, totalRequests: 4500, totalTokens: 1200000, totalPoints: 5.1, cacheHitRate: 18.9, balance: 80, isCurrentUser: false },
  ],
  totalUsers: 8,
  currentUserRank: 3
};

const DEMO_STARRED = [
  { model_id: 'gpt-4.1', team_id: 1 },
  { model_id: 'deepseek-chat', team_id: 1 },
];

const DEMO_PRODUCTS = [
  { id: 1, name: '积分充值包 · 1000', description: '适合个人开发者的基础额度', points: 1000, price: 9.9, enabled: true, created_at: '2025-05-01T00:00:00Z' },
  { id: 2, name: '积分充值包 · 10000', description: '适合团队和持续集成场景', points: 10000, price: 79, enabled: true, created_at: '2025-05-01T00:00:00Z' },
];

const DEMO_CODE_BALANCES = [
  { id: 1, code: 'DEMO-1000-ABCD', amount: 1000, used_amount: 250, remaining_amount: 750, status: 'active', created_at: '2025-05-12T09:00:00Z' },
  { id: 2, code: 'DEMO-5000-EFGH', amount: 5000, used_amount: 5000, remaining_amount: 0, status: 'used', created_at: '2025-04-18T09:00:00Z' },
];

// ========== 导出方法 ==========

module.exports = {
  getUser() {
    return DEMO_USER;
  },

  modelLibrary() {
    return {
      starred_models: DEMO_STARRED.slice(),
      teams: DEMO_TEAMS.map(team => ({
        team_id: team.id,
        team_name: team.name,
        is_personal: team.is_personal,
        is_default: team.is_default,
        description: team.description,
        custom_sort_order: null,
        providers: DEMO_PROVIDERS.filter(p => p.enabled).map(provider => {
          const models = DEMO_MODELS.filter(m => m.provider === provider.id);
          return {
            provider_id: provider.id,
            provider_name: provider.name,
            provider_notes: provider.notes || '',
            provider_enabled: provider.enabled,
            model_count: models.length,
            series_count: [...new Set(models.map(m => m.series).filter(Boolean))].length,
            test_tested_count: models.length,
            test_success_count: models.length,
            test_failed_count: 0,
            test_avg_latency_ms: 250,
            test_avg_tokens_per_second: 45.2,
            test_latest_tested_at: '2025-06-25T10:00:00Z',
            custom_sort_order: null,
            models_loaded: true,
            models: models.map((m, idx) => ({
              ...m,
              model_id: m.id,
              is_starred: DEMO_STARRED.some(s => String(s.model_id) === String(m.id) && String(s.team_id) === String(team.id)),
              custom_sort_order: null,
              test_ok: true,
              test_latency_ms: [245, 182, 310, 156, 278, 198, 142, 335][idx % 8],
              test_tokens_per_second: [42.1, 55.3, 31.8, 62.5, 38.2, 48.7, 71.2, 28.4][idx % 8],
              test_total_tokens: 1000,
              test_error: null,
              test_tested_at: '2025-06-25T10:00:00Z'
            }))
          };
        })
      }))
    };
  },

  myProviders() {
    return [
      { id: 'demo-local', name: '本地演示上游', base_url: 'https://api.example.com/v1', format: 'openai', enabled: true, models: DEMO_MODELS.slice(0, 2), created_at: '2025-04-12T10:00:00Z' },
    ];
  },

  myTeamModels() {
    return DEMO_MODELS;
  },

  apiKeys() {
    return DEMO_API_KEYS;
  },

  stats(params) {
    const days = parseInt(params?.days) || 30;
    return generateDemoStats(days, params?.start, params?.end);
  },

  projectStats() {
    const now = new Date();
    const projects = [
      { workspace_path: '/workspace/crewrouter', requests: 1280, tokens: 3850000, cost: 12.4, active_days: 18, last_activity: now.toISOString(), sources: { codex: 540, claude_code: 420, opencode: 320 } },
      { workspace_path: '/workspace/plugin-lab', requests: 760, tokens: 2140000, cost: 6.8, active_days: 12, last_activity: new Date(now - 86400000).toISOString(), sources: { qwen_code: 410, codex: 350 } },
      { workspace_path: '/workspace/analytics-dashboard', requests: 430, tokens: 980000, cost: 3.1, active_days: 8, last_activity: new Date(now - 3 * 86400000).toISOString(), sources: { hermes: 240, openclaw: 190 } },
    ];
    return { summary: { requests: 2470, tokens: 6970000, cost: 22.3, projects: 3, active_days: 24, last_activity: now.toISOString(), analysis_status: { pending_requests: 0, last_scanned_at: now.toISOString() } }, projects, daily: Array.from({ length: 14 }, (_, i) => ({ date: new Date(now - (13 - i) * 86400000).toISOString().slice(0, 10), requests: 100 + i * 17, tokens: 250000 + i * 21000, cost: 0.8 + i * 0.07, projects: 2 + (i % 2) })) };
  },

  messageStats() {
    return { summary: { analyzed_requests: 36, active_days: 12, avg_daily_requests: 3, total_tokens: 1260000, git_rate: 0.72, analysis_status: { pending_requests: 0 } }, by_workspace: [{ workspace_path: '/workspace/crewrouter', requests: 24 }], by_block: [{ block: 'workspace', requests: 19, occurrences: 32 }, { block: 'git', requests: 15, occurrences: 21 }], by_source: [{ request_source: 'codex', requests: 16, messages: 64, characters: 18500, tokens: 680000 }, { request_source: 'claude_code', requests: 12, messages: 48, characters: 14200, tokens: 420000 }, { request_source: 'opencode', requests: 8, messages: 32, characters: 9600, tokens: 160000 }], daily: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10), requests: 1 + i, tokens: 50000 + i * 7000 })) };
  },

  statsFilters() {
    return {
      models: DEMO_MODELS.map(m => ({ model_id: m.id, name: m.name })),
      providers: DEMO_PROVIDERS.map(p => ({ provider_id: p.id, name: p.name })),
      teams: DEMO_TEAMS.map(t => ({ id: t.id, name: t.name }))
    };
  },

  leaderboard() {
    return DEMO_LEADERBOARD;
  },

  balance() {
    const group = DEMO_GROUPS.find(g => g.id === DEMO_USER.group_id);
    const rules = DEMO_GROUP_RULES.filter(r => r.group_id === group?.id).map(r => ({
      ...r,
      current: r.rule_type === 'requests' ? Math.floor(r.rule_value * 0.35) : Math.floor(r.rule_value * 0.28)
    }));
    return {
      balance: 9999,
      refund_balance: 0,
      rate_limit_rpm: 0,
      rate_limit_tpm: 0,
      group: group ? { ...group, rules } : null
    };
  },

  currentModel() {
    return { currentModel: 'gpt-4.1' };
  },

  providerTags() {
    return DEMO_PROVIDER_TAGS;
  },

  providersQuota() {
    return {
      providers: [
        { id: 'openai', name: 'OpenAI', quota: { used: 312.7, total: 500, remaining: 187.3, unit: 'USD', planName: 'Pro 计划' }, enabled: true },
        { id: 'anthropic', name: 'Anthropic', quota: { used: 87.2, total: 200, remaining: 112.8, unit: 'USD', planName: 'Scale 计划' }, enabled: true },
        { id: 'deepseek', name: 'DeepSeek', quota: { used: 28.3, total: 100, remaining: 71.7, unit: 'USD', planName: '按量计费' }, enabled: true },
      ]
    };
  },

  keyTags() {
    return DEMO_KEY_TAGS;
  },

  settings() {
    return {
      api_signature_enabled: false,
      api_signature_template: '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}'
    };
  },

  // ========== 管理后台数据 ==========
  adminUsers() {
    return [
      { ...DEMO_USER, team_name: 'Demo Team', group_name: '标准组', tags: '' },
      { id: 2, username: 'Alice Zhang', email: 'alice@example.com', email_verified: true, avatar: null, balance: 1200, refund_balance: 0, is_admin: false, tags: '', rate_limit_rpm: 0, rate_limit_tpm: 0, created_at: '2025-01-10T00:00:00Z', team_id: 2, team_name: 'Alice Team', group_id: 1, group_name: '标准组' },
      { id: 3, username: 'Bob Wang', email: 'bob@example.com', email_verified: true, avatar: null, balance: 890, refund_balance: 0, is_admin: false, tags: '', rate_limit_rpm: 0, rate_limit_tpm: 0, created_at: '2025-01-15T00:00:00Z', team_id: 3, team_name: 'Bob Team', group_id: 2, group_name: '高级组' },
      { id: 4, username: 'Carol Li', email: 'carol@example.com', email_verified: true, avatar: null, balance: 560, refund_balance: 0, is_admin: false, tags: '', rate_limit_rpm: 0, rate_limit_tpm: 0, created_at: '2025-02-01T00:00:00Z', team_id: 4, team_name: 'Carol Team', group_id: null, group_name: null },
    ];
  },

  adminProviders() {
    return DEMO_PROVIDERS;
  },

  adminModels() {
    return DEMO_MODELS;
  },

  adminTeams() {
    return DEMO_TEAMS;
  },

  adminStats() {
    // 生成与真实 /api/admin/stats 一致的结构
    const daily = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const pat = [135,142,98,110,65,55,78,148,155,130,120,105,60,50,140,160,125,115,100,70,58,145,150,138,118,108,62,52,132,128][i % 30];
      const tok = pat * (380 + Math.floor(seededRand(i * 11) * 140));
      daily.push({ date: dateStr, requests: pat, tokens: tok, cached_tokens: Math.floor(tok * 0.25), cost: parseFloat((tok * 0.0000035).toFixed(6)) });
    }
    return {
      users: 4,
      models: DEMO_MODELS.length,
      apiKeys: 2,
      daily,
      byModel: [
        { model_id: 'gpt-4.1', model_name: 'GPT-4.1', requests: 3800, tokens: 1900000, cached_tokens: 380000, cost: 6.65 },
        { model_id: 'claude-sonnet-4-20250514', model_name: 'Claude Sonnet 4', requests: 2600, tokens: 1300000, cached_tokens: 260000, cost: 4.55 },
        { model_id: 'deepseek-chat', model_name: 'DeepSeek V3', requests: 3500, tokens: 1050000, cached_tokens: 350000, cost: 0.73 },
        { model_id: 'o4-mini', model_name: 'o4-mini', requests: 2200, tokens: 880000, cached_tokens: 180000, cost: 1.76 },
        { model_id: 'deepseek-reasoner', model_name: 'DeepSeek R1', requests: 1200, tokens: 720000, cached_tokens: 100000, cost: 1.98 },
        { model_id: 'gpt-4.1-mini', model_name: 'GPT-4.1 Mini', requests: 1500, tokens: 450000, cached_tokens: 120000, cost: 0.36 },
      ],
      byProvider: [
        { provider: 'OpenAI', requests: 3800, tokens: 1900000, cached_tokens: 380000, cost: 6.65 },
        { provider: 'Anthropic', requests: 2600, tokens: 1300000, cached_tokens: 260000, cost: 4.55 },
        { provider: 'DeepSeek', requests: 4700, tokens: 1770000, cached_tokens: 450000, cost: 2.71 },
      ],
      byUser: [
        { user_id: 2, user_name: 'Alice Zhang', requests: 3800, tokens: 1900000, cached_tokens: 380000, cost: 6.65, avg_latency: 420 },
        { user_id: 3, user_name: 'Bob Wang', requests: 2600, tokens: 1300000, cached_tokens: 260000, cost: 4.55, avg_latency: 510 },
        { user_id: 4, user_name: 'Carol Li', requests: 2200, tokens: 880000, cached_tokens: 180000, cost: 1.76, avg_latency: 360 },
      ],
      byTeam: [
        { team_id: 2, team_name: 'Alice Team', requests: 3800, tokens: 1900000, cached_tokens: 380000, cost: 6.65, avg_latency: 420 },
        { team_id: 3, team_name: 'Bob Team', requests: 2600, tokens: 1300000, cached_tokens: 260000, cost: 4.55, avg_latency: 510 },
        { team_id: 4, team_name: 'Carol Team', requests: 2200, tokens: 880000, cached_tokens: 180000, cost: 1.76, avg_latency: 360 },
      ],
      byGroup: [
        { group_id: 1, group_name: '标准组', requests: 3800, tokens: 1900000, cached_tokens: 380000, cost: 6.65, avg_latency: 420 },
        { group_id: 2, group_name: '高级组', requests: 2600, tokens: 1300000, cached_tokens: 260000, cost: 4.55, avg_latency: 510 },
        { group_id: null, group_name: '未分配用户组', requests: 2200, tokens: 880000, cached_tokens: 180000, cost: 1.76, avg_latency: 360 },
      ]
    };
  },

  docsContent() {
    return {
      overview: 'CrewRouter 演示接口文档：使用 /v1/chat/completions 兼容 OpenAI API。',
      examples: 'curl http://demo.local/v1/chat/completions -H "Authorization: Bearer sk-demo-prod"',
      notes: '演示模式返回固定数据，不会调用真实上游。'
    };
  },

  adminSettings() {
    return {
      'app.name': 'CrewRouter',
      'defaultBalance': 100,
      'defaultKeyExpiry': '',
      'billing_mode': 'token',
      'rate_price_per_request': 0.01,
      'proxy_pool_subscription_url': '',
      'proxy_pool_manual_proxies': [],
      'system_proxy_enabled': false,
      'system_proxy_url': '',
      'registration_enabled': true
    };
  },

  feishuLoginConfig() {
    return {
      enabled: false,
      appId: '',
      appSecret: '',
      hasAppSecret: false,
      tenantKey: '',
      redirectUri: 'https://example.com/auth/feishu/callback',
      source: 'settings',
    };
  },

  adminGroups() {
    return DEMO_GROUPS.map(g => ({
      ...g,
      member_count: g.id === 1 ? 3 : 1,
      rule_count: DEMO_GROUP_RULES.filter(r => r.group_id === g.id).length
    }));
  },

  adminGroupRules(groupId) {
    return DEMO_GROUP_RULES.filter(r => r.group_id === parseInt(groupId));
  },

  products() {
    return DEMO_PRODUCTS;
  },

  codeBalances() {
    return DEMO_CODE_BALANCES;
  },

  adminProducts() {
    return DEMO_PRODUCTS;
  },

  adminRedemptionCodes() {
    return DEMO_CODE_BALANCES.map((item, index) => ({ ...item, id: index + 1, value: item.amount, used: item.status === 'used', expires_at: null }));
  },

  usageLogs(page, limit) {
    // 生成 50 条模拟调用记录
    const allLogs = [];
    const now = Date.now();
    const models = [
      { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', provider_name: 'OpenAI', series: 'GPT' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', provider_name: 'Anthropic', series: 'Claude' },
      { id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'deepseek', provider_name: 'DeepSeek', series: 'DeepSeek' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'deepseek', provider_name: 'DeepSeek', series: 'DeepSeek' },
      { id: 'o4-mini', name: 'o4-mini', provider: 'openai', provider_name: 'OpenAI', series: 'o' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai', provider_name: 'OpenAI', series: 'GPT' },
    ];
    const users = [
      { id: 1, username: 'Demo User' },
      { id: 2, username: 'Alice Zhang' },
      { id: 3, username: 'Bob Wang' },
    ];
    const keys = [
      { id: 1, key_prefix: 'sk-demo-prod', name: '生产环境 Key' },
      { id: 2, key_prefix: 'sk-demo-test', name: '测试环境 Key' },
    ];

    for (let i = 0; i < 50; i++) {
      const m = models[i % models.length];
      const u = users[i % users.length];
      const k = keys[i % keys.length];
      const prompt = 800 + Math.floor(seededRand(i * 53) * 2000);
      const completion = 200 + Math.floor(seededRand(i * 59) * 1500);
      const cached = Math.floor(prompt * seededRand(i * 61));
      const tokens = prompt + completion;
      const ts = new Date(now - i * 3600000 * (1 + seededRand(i * 67) * 3));

      allLogs.push({
        id: i + 1,
        user_id: u.id,
        model_id: m.id,
        api_key_id: k.id,
        tokens_used: tokens,
        prompt_tokens: prompt,
        completion_tokens: completion,
        cached_tokens: cached,
        provider_id: m.provider,
        request_type: 'chat_completions',
        latency_ms: 150 + Math.floor(seededRand(i * 71) * 400),
        ip_address: '192.168.1.' + (10 + (i % 50)),
        cost: parseFloat((tokens * 0.0000035).toFixed(6)),
        created_at: ts.toISOString(),
        username: u.username,
        key_prefix: k.key_prefix,
        key_name: k.name,
        series: m.series,
        model_name: m.name,
        provider_name: m.provider_name
      });
    }

    const total = allLogs.length;
    const p = page || 1;
    const l = limit || 50;
    const start = (p - 1) * l;
    const logs = allLogs.slice(start, start + l);

    return { logs, total, page: p, limit: l };
  },

  usageLogDetail(id) {
    const list = this.usageLogs(1, 1000);
    const base = list.logs.find(l => l.id === id);
    if (!base) return null;
    // demo 模式补全 messages / response 大字段（真实模式下由详情接口返回）
    return Object.assign({}, base, {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: `演示请求 #${id}` }
      ],
      response: `演示响应：这是调用记录 #${id} 的 AI 回复内容。`
    });
  }
};
