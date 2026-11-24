'use strict';

const { getStats, getStatsFilters, getLatencyStats, getMessageStats, getUsageLogs, statsSummary, listSessions, getSessionMessages, searchSessions } = require('../lib/api');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');
const { bar, text } = require('./pages-common');

function usagePage(runtime) {
  if (!runtime.usageDays) runtime.usageDays = runtime.cfg.tui ? runtime.cfg.tui.days : 30;
  if (!runtime.usageTab) runtime.usageTab = 'overview';
  return {
    id: 'usage',
    label: '用量',
    description: '请求数、Token（模型处理的文本单位）、费用、客户端识别率，以及各模型和来源的使用情况。',
    onTabChange(tab) { runtime.usageTab = tab?.id || 'overview'; },
    tabs: [
      { id: 'overview', label: '概览' },
      { id: 'daily', label: '每日' },
      { id: 'models', label: '模型' },
      { id: 'providers', label: '供应商' },
      { id: 'keys', label: 'API Key' },
      { id: 'sources', label: '客户端' },
      { id: 'latency', label: '响应速度' },
      { id: 'messages', label: '消息分析' },
      { id: 'logs', label: '调用记录' },
    ],
    async load(api) {
      const filters = runtime.usageFilters || {};
      const stats = await getStats(runtime.client, runtime.usageDays, filters);
      const summary = statsSummary(stats);
      const maxDaily = Math.max(...summary.daily.map(row => Number(row.tokens) || 0), 1);
      const maxModel = Math.max(...summary.byModel.map(row => Number(row.tokens) || 0), 1);
      const maxKey = Math.max(...summary.byApiKey.map(row => Number(row.tokens) || 0), 1);
      const sections = [{
        title: '汇总',
        description: `最近 ${runtime.usageDays} 天。`,
        cards: [
          { label: '请求', value: summary.requests.toLocaleString(), detail: '总请求数' },
          { label: 'Token 总量', value: formatBigNumber(summary.tokens), detail: `缓存命中 Token ${formatBigNumber(summary.cachedTokens)}` },
          { label: '成本', value: formatCost(summary.cost), detail: '服务端计费合计' },
          { label: '延迟', value: `${Math.round(summary.avgLatency)} ms`, detail: '平均' },
          { label: '客户端识别', value: `${summary.identifiedRate.toFixed(1)}%`, detail: `${formatBigNumber(summary.unknownRequests)} 未识别` },
          { label: '活跃来源', value: summary.activeSources, detail: `${formatBigNumber(summary.knownRequests)} 已识别请求` },
        ],
        rows: [
          { label: `输入 Token：${formatBigNumber(summary.promptTokens)} · 输出 Token：${formatBigNumber(summary.completionTokens)}` },
          ...(summary.bySource.length ? [{ label: `来源：${summary.bySource.slice(0, 5).map(row => `${row.request_source || 'unknown'} ${Number(row.requests || 0)}`).join(' · ')}` }] : []),
        ],
      }];
      if (summary.daily.length) {
        sections.push({
          title: '每日',
          tab: 'daily',
          rows: summary.daily.slice(-30).map(row => ({
            label: `${row.date || '未知日期'} · ${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)}`,
            detail: bar(row.tokens, maxDaily, 26),
          })),
        });
      }
      if (summary.byModel.length) {
        sections.push({
          title: '按模型',
          tab: 'models',
          rows: summary.byModel.slice(0, 30).map(row => ({
            label: `${row.model_name || row.model_id || '未知'} · ${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)}`,
            detail: bar(row.tokens, maxModel, 26),
          })),
        });
      }
      if (summary.byProvider?.length) {
        sections.push({ title: '按供应商', tab: 'providers', rows: summary.byProvider.slice(0, 30).map(row => ({ label: `${row.provider_name || row.provider_id || '未知'} · ${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)}`, detail: bar(row.tokens, Math.max(...summary.byProvider.map(item => Number(item.tokens) || 0), 1), 26) })) });
      }
      if (summary.byApiKey.length) {
        sections.push({ title: '按 API Key', tab: 'keys', rows: summary.byApiKey.slice(0, 30).map(row => ({ label: `${row.key_name || row.key_prefix || '未知 API Key'} · ${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)}`, detail: bar(row.tokens, maxKey, 26) })) });
      }
      if (summary.bySource?.length) {
        sections.push({ title: '按客户端', tab: 'sources', rows: summary.bySource.slice(0, 30).map(row => ({ label: `${row.request_source || '未知来源'} · ${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)}`, detail: bar(row.tokens, Math.max(...summary.bySource.map(item => Number(item.tokens) || 0), 1), 26) })) });
      }
      if (runtime.usageTab === 'latency') {
        const latency = await getLatencyStats(runtime.client, { days: runtime.usageDays, ...filters });
        sections.push({ title: '响应速度与首字延迟', tab: 'latency', cards: [
          { label: '请求中位延迟（P50）', value: text(latency.p50_ms, '—'), detail: '一半请求不超过此耗时 · 毫秒' },
          { label: '请求95%分位延迟（P95）', value: text(latency.p95_ms, '—'), detail: '95% 请求不超过此耗时 · 毫秒' },
          { label: '请求99%分位延迟（P99）', value: text(latency.p99_ms, '—'), detail: '99% 请求不超过此耗时 · 毫秒' },
          { label: '请求总数', value: text(latency.total_requests, '0'), detail: '当前筛选范围' },
        ], rows: (latency.daily || []).map(row => ({ label: `${row.date} · ${row.requests || 0} 次请求 · 95%请求延迟 ${row.p95_ms || 0} 毫秒 · 输出速度 ${row.tokens_per_second || 0} Token/秒` })) });
      }
      if (runtime.usageTab === 'messages') {
        const messageStats = await getMessageStats(runtime.client, { days: runtime.usageDays, ...filters });
        sections.push({ title: '消息结构分析', tab: 'messages', cards: Object.entries(messageStats.summary || {}).slice(0, 6).map(([label, value]) => ({ label, value: typeof value === 'object' ? JSON.stringify(value) : text(value) })), rows: Object.entries(messageStats.blocks || {}).map(([name, count]) => ({ label: `${name} · ${count}` })) });
      }
      if (runtime.usageTab === 'logs') {
        const logs = await getUsageLogs(runtime.client, { page: runtime.usageLogPage || 1, pageSize: 20, days: runtime.usageDays, ...filters });
        const items = Array.isArray(logs.items) ? logs.items : [];
        sections.push({ title: '调用记录', tab: 'logs', description: `第 ${logs.page || runtime.usageLogPage || 1} 页 · 共 ${logs.total || 0} 条`, rows: items.map(item => ({ label: `${formatTime(item.created_at)} · ${item.model_name || item.model_id || '未知'} · ${item.status_code || item.status || ''}`, detail: `${item.tokens_used || item.tokens || 0} tokens · ${formatCost(item.cost)} · ${item.request_source || ''}`, run: async ctx => await ctx.show('调用记录详情', JSON.stringify(item, null, 2)) })) });
      }
      return {
        sections,
        actions: [
          { label: '查看实时活动快照', tab: 'overview', run: async ctx => { const window = await ctx.choose('活动统计窗口', [{ label: '最近 5 分钟', value: 300 }, { label: '最近 30 分钟', value: 1800 }, { label: '最近 1 小时', value: 3600 }]); if (window === null) return; const live = await api('/api/client-events/live', { query: { window } }); const sources = Array.isArray(live.sources) ? live.sources : []; const machines = Object.values(live.machines || {}); const lines = [`窗口 ${Math.round((live.window || window) / 60)} 分钟`, '', '按客户端：', ...sources.map(source => `${source.harness} · ${source.active_sessions || 0} 活跃会话 · ${source.tool_calls || 0} 工具调用 · ${source.failure_count || 0} 错误${source.suspected_offline ? ' · 疑似离线' : ''}`), '', '机器：', ...machines.map(machine => `${machine.name} · ${machine.harness} · ${machine.suspected_offline ? '疑似离线' : '在线'}`)]; if (!sources.length && !machines.length) lines.push('暂无近期客户端事件。'); await ctx.show('实时活动快照（一次性）', lines.join('\\n')); } },
          { label: '时间范围与筛选', tab: 'overview', run: async ctx => { const [filtersData, currentModel, currentProvider, currentSource] = await Promise.all([getStatsFilters(runtime.client), Promise.resolve(filters.model_id || ''), Promise.resolve(filters.provider_id || ''), Promise.resolve(filters.request_source || '')]); const pick = async (title, values, current) => { const value = await ctx.choose(title, [{ label: '全部', value: '' }, ...values.map(item => ({ label: item.name || item.id, value: item.id }))]); return value === null ? current : value; }; const model_id = await pick('模型筛选', filtersData.models || [], currentModel); const provider_id = await pick('供应商筛选', filtersData.providers || [], currentProvider); const request_source = await pick('客户端筛选', filtersData.sources || [], currentSource); runtime.usageFilters = { ...filters, model_id, provider_id, request_source }; await ctx.refresh(); } },
          { label: '搜索调用记录', tab: 'logs', run: async ctx => { runtime.usageFilters = { ...filters, q: String(await ctx.ask('搜索模型或用户') || '').trim() }; runtime.usageLogPage = 1; await ctx.refresh(); } },
          { label: '上一页调用记录', tab: 'logs', run: async ctx => { runtime.usageLogPage = Math.max(1, (runtime.usageLogPage || 1) - 1); await ctx.refresh(); } },
          { label: '下一页调用记录', tab: 'logs', run: async ctx => { runtime.usageLogPage = (runtime.usageLogPage || 1) + 1; await ctx.refresh(); } },
          ...[7, 30, 90, 180, 365].map(days => ({ label: `最近 ${days} 天`, tab: 'overview', run: async ctx => { runtime.usageDays = days; await ctx.refresh(); } })),
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

async function showSessionMessages(ctx, runtime, item) {
  const data = await getSessionMessages(runtime.client, item.sessionKey, { page: 1, pageSize: 30 });
  const records = Array.isArray(data.records) ? data.records : [];
  const lines = [
    `Session Key：${item.sessionKey}`,
    `Harness：${item.harness || 'unknown'}`,
    `请求：${item.requestCount || 0} · Token：${formatBigNumber(item.totalTokens)} · 工具调用：${item.toolCallCount || 0}`,
    `首次：${formatTime(item.firstSeen)} · 最后：${formatTime(item.lastSeen)}`,
    item.summary ? `摘要：${text(item.summary)}` : '摘要：无',
    '',
    `最近 ${records.length} 条记录：`,
  ];
  for (const record of records.slice(0, 20)) {
    lines.push(`${formatTime(record.created_at || record.ts || record.time)} · ${record.model_name || record.model_id || record.resolved_model || '未知模型'} · ${formatBigNumber(record.tokens_used || record.tokens || 0)} tokens`);
    if (record.response_preview) lines.push(`  ${String(record.response_preview).slice(0, 240)}`);
  }
  if (!records.length) lines.push('  （没有可显示的消息记录）');
  await ctx.show('会话详情', lines.join('\n'));
}

function sessionsPage(runtime) {
  if (!runtime.sessionsPageNumber) runtime.sessionsPageNumber = 1;
  return {
    id: 'sessions',
    label: '会话',
    description: '按 Harness 查看最近使用会话与消息摘要。',
    async load(api) {
      const days = runtime.sessionsDays || 30;
      const search = runtime.sessionsSearch || '';
      const data = search
        ? await searchSessions(runtime.client, { q: search, days })
        : await listSessions(runtime.client, { days, page: runtime.sessionsPageNumber, pageSize: 30 });
      const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
      const rows = items.map(item => ({
        label: `${item.sessionKey || '未知会话'} · ${item.harness || 'unknown'} · ${Number(item.requestCount || 0).toLocaleString()} 请求 · ${formatBigNumber(item.totalTokens)} tokens`,
        detail: `${item.lastSeen ? `最后活动 ${formatTime(item.lastSeen)}` : ''}${item.models && item.models.length ? ` · 模型 ${item.models.slice(0, 3).join(', ')}` : ''}${item.summary ? ' · 有摘要' : ''}`,
        run: async ctx => {
          const choice = await ctx.choose(`会话 · ${item.sessionKey}`, [{ label: '查看消息', value: 'messages' }, { label: '查看已缓存摘要', value: 'summary' }]);
          if (choice === 'messages') await showSessionMessages(ctx, runtime, item);
          if (choice === 'summary') { const cached = await runtime.client.get(`/api/user/sessions/${encodeURIComponent(item.sessionKey)}/summary`); if (cached.summary) await ctx.show('会话摘要', `${cached.summary}\n\n更新时间：${formatTime(cached.createdAt)}`); else await ctx.show('暂无会话摘要', '摘要生成需要流式 SSE 和模型调用。请在网页会话详情中生成摘要后回到此处查看。'); }
        },
      }));
      return {
        sections: [{
          title: '会话',
          description: `最近 ${days} 天${search ? ` · 搜索“${search}”` : ` · 第 ${data.page || runtime.sessionsPageNumber} 页`} · 共 ${data.total || items.length} 个`,
          rows: rows.length ? rows : [{ label: '暂无会话记录。' }],
        }],
        actions: [
          { label: search ? '清除搜索' : '搜索会话', run: async ctx => { runtime.sessionsSearch = search ? '' : String(await ctx.ask('搜索会话内容、Harness 或摘要') || '').trim(); runtime.sessionsPageNumber = 1; await ctx.refresh(); } },
          { label: '最近 7 天', run: async ctx => { runtime.sessionsDays = 7; runtime.sessionsPageNumber = 1; await ctx.refresh(); } },
          { label: '最近 30 天', run: async ctx => { runtime.sessionsDays = 30; runtime.sessionsPageNumber = 1; await ctx.refresh(); } },
          { label: '上一页', run: async ctx => { runtime.sessionsPageNumber = Math.max(1, runtime.sessionsPageNumber - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.sessionsPageNumber += 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

module.exports = { usagePage, sessionsPage };
