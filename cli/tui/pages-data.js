'use strict';

const { getStats, statsSummary, listSessions, getSessionMessages } = require('../lib/api');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');
const { bar, text } = require('./pages-common');

function usagePage(runtime) {
  if (!runtime.usageDays) runtime.usageDays = runtime.cfg.tui ? runtime.cfg.tui.days : 30;
  return {
    id: 'usage',
    label: '用量',
    description: '请求、Token、费用与模型/Key 分布。',
    tabs: [
      { id: 'overview', label: '概览' },
      { id: 'daily', label: '每日' },
      { id: 'models', label: '模型' },
      { id: 'keys', label: 'API Key' },
    ],
    async load(api) {
      const stats = await getStats(runtime.client, runtime.usageDays);
      const summary = statsSummary(stats);
      const maxDaily = Math.max(...summary.daily.map(row => Number(row.tokens) || 0), 1);
      const maxModel = Math.max(...summary.byModel.map(row => Number(row.tokens) || 0), 1);
      const maxKey = Math.max(...summary.byApiKey.map(row => Number(row.tokens) || 0), 1);
      const sections = [{
        title: '汇总',
        description: `最近 ${runtime.usageDays} 天。`,
        cards: [
          { label: '请求', value: summary.requests.toLocaleString(), detail: '总请求数' },
          { label: 'Token', value: formatBigNumber(summary.tokens), detail: `缓存 ${formatBigNumber(summary.cachedTokens)}` },
          { label: '费用', value: formatCost(summary.cost), detail: '计费合计' },
          { label: '延迟', value: `${Math.round(summary.avgLatency)} ms`, detail: '平均' },
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
            label: `${row.date || '未知日期'} · ${Number(row.requests || 0).toLocaleString()} 请求 · ${formatBigNumber(row.tokens)} tokens · ${formatCost(row.cost)}`,
            detail: bar(row.tokens, maxDaily, 26),
          })),
        });
      }
      if (summary.byModel.length) {
        sections.push({
          title: '按模型',
          tab: 'models',
          rows: summary.byModel.slice(0, 30).map(row => ({
            label: `${row.model_name || row.model_id || '未知'} · ${Number(row.requests || 0).toLocaleString()} 请求 · ${formatBigNumber(row.tokens)} tokens · ${formatCost(row.cost)}`,
            detail: bar(row.tokens, maxModel, 26),
          })),
        });
      }
      if (summary.byApiKey.length) {
        sections.push({
          title: '按 API Key',
          tab: 'keys',
          rows: summary.byApiKey.slice(0, 30).map(row => ({
            label: `${row.key_name || row.key_prefix || '未知 Key'} · ${Number(row.requests || 0).toLocaleString()} 请求 · ${formatBigNumber(row.tokens)} tokens · ${formatCost(row.cost)}`,
            detail: bar(row.tokens, maxKey, 26),
          })),
        });
      }
      return {
        sections,
        actions: [
          { label: '最近 7 天', run: async ctx => { runtime.usageDays = 7; await ctx.refresh(); } },
          { label: '最近 30 天', run: async ctx => { runtime.usageDays = 30; await ctx.refresh(); } },
          { label: '最近 90 天', run: async ctx => { runtime.usageDays = 90; await ctx.refresh(); } },
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
      const data = await listSessions(runtime.client, {
        days: runtime.sessionsDays || 30,
        page: runtime.sessionsPageNumber,
        pageSize: 30,
      });
      const items = Array.isArray(data.items) ? data.items : [];
      const rows = items.map(item => ({
        label: `${item.sessionKey || '未知会话'} · ${item.harness || 'unknown'} · ${Number(item.requestCount || 0).toLocaleString()} 请求 · ${formatBigNumber(item.totalTokens)} tokens`,
        detail: `${item.lastSeen ? `最后活动 ${formatTime(item.lastSeen)}` : ''}${item.models && item.models.length ? ` · 模型 ${item.models.slice(0, 3).join(', ')}` : ''}${item.summary ? ' · 有摘要' : ''}`,
        run: async ctx => { await showSessionMessages(ctx, runtime, item); },
      }));
      return {
        sections: [{
          title: '会话',
          description: `最近 ${runtime.sessionsDays || 30} 天 · 第 ${data.page || runtime.sessionsPageNumber} 页 · 共 ${data.total || items.length} 个`,
          rows: rows.length ? rows : [{ label: '暂无会话记录。' }],
        }],
        actions: [
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
