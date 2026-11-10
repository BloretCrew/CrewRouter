'use strict';

const { createContext, ensureAuthenticated } = require('../context');
const { getStats, statsSummary, listSessions, getSessionMessages } = require('../api');
const { printJson, success } = require('../output');
const {
  bold, dim, formatBigNumber, formatCost, formatTime, table,
} = require('../format');

function bar(value, max, width = 20) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, Number(value) / max)) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

async function usageCommand(args, { json = false } = {}) {
  const context = createContext(args);
  await ensureAuthenticated(context);
  const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
  const stats = await getStats(context.client, days);
  const summary = statsSummary(stats);
  if (json) { printJson(success(context.profileName, { days, summary })); return 0; }
  console.log(bold(`用量统计 · 最近 ${days} 天`));
  console.log(`请求 ${summary.requests.toLocaleString()} · Token ${formatBigNumber(summary.tokens)} · 费用 ${formatCost(summary.cost)} · 平均延迟 ${Math.round(summary.avgLatency)} ms`);
  if (summary.daily.length) {
    const max = Math.max(...summary.daily.map(row => Number(row.tokens) || 0), 1);
    console.log('');
    console.log(bold('每日'));
    console.log(table(summary.daily.slice(-30).map(row => ({
      date: row.date,
      tokens: formatBigNumber(row.tokens),
      requests: Number(row.requests || 0).toLocaleString(),
      cost: formatCost(row.cost),
      bar: bar(Number(row.tokens) || 0, max, 18),
    })), [
      { label: '日期', key: 'date', width: 12 },
      { label: 'Token', key: 'tokens', width: 8, align: 'right' },
      { label: '请求', key: 'requests', width: 8, align: 'right' },
      { label: '费用', key: 'cost', width: 10, align: 'right' },
      { label: '分布', key: 'bar', width: 18 },
    ], { maxWidth: process.stdout.columns || 110 }));
  }
  if (summary.byModel.length) {
    const max = Math.max(...summary.byModel.map(row => Number(row.tokens) || 0), 1);
    console.log('');
    console.log(bold('按模型'));
    console.log(table(summary.byModel.slice(0, 15).map(row => ({
      model: row.model_name || row.model_id || '未知',
      tokens: formatBigNumber(row.tokens),
      requests: Number(row.requests || 0).toLocaleString(),
      cost: formatCost(row.cost),
      bar: bar(Number(row.tokens) || 0, max, 18),
    })), [
      { label: '模型', key: 'model', width: 28 },
      { label: 'Token', key: 'tokens', width: 8, align: 'right' },
      { label: '请求', key: 'requests', width: 8, align: 'right' },
      { label: '费用', key: 'cost', width: 10, align: 'right' },
      { label: '分布', key: 'bar', width: 18 },
    ], { maxWidth: process.stdout.columns || 110 }));
  }
  return 0;
}

async function sessionsCommand(args, { json = false } = {}) {
  const context = createContext(args);
  await ensureAuthenticated(context);
  const sub = args._[1];
  if (sub === 'messages') {
    const key = args._[2];
    if (!key) throw Object.assign(new Error('请提供 sessionKey：cr sessions messages <KEY>'), { code: 'PARSE_ERROR' });
    const data = await getSessionMessages(context.client, key, { page: Number(args.page) || 1, pageSize: Number(args['page-size']) || 20 });
    if (json) { printJson(success(context.profileName, data)); return 0; }
    console.log(bold(`会话 ${key}`));
    const records = Array.isArray(data.records) ? data.records : [];
    if (!records.length) { console.log(dim('没有记录。')); return 0; }
    for (const record of records) {
      const at = formatTime(record.created_at || record.ts || record.time);
      const model = record.model_name || record.model_id || record.resolved_model || '';
      const tokens = formatBigNumber(record.tokens_used || record.tokens || 0);
      console.log(`${at} · ${model} · ${tokens} tokens`);
      if (record.response_preview) console.log(dim(`  ${String(record.response_preview).slice(0, 300)}`));
    }
    return 0;
  }
  const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
  const page = Math.max(Number(args.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(args['page-size']) || 30, 1), 200);
  const data = await listSessions(context.client, { days, page, pageSize });
  if (json) { printJson(success(context.profileName, data)); return 0; }
  const items = Array.isArray(data.items) ? data.items : [];
  console.log(bold(`会话 · 最近 ${days} 天 · 第 ${data.page || page} 页 / 共 ${data.total || items.length} 个`));
  if (!items.length) { console.log(dim('暂无会话。')); return 0; }
  console.log(table(items.slice(0, 100).map(item => ({
    key: item.sessionKey || '',
    harness: item.harness || 'unknown',
    requests: Number(item.requestCount || 0).toLocaleString(),
    tokens: formatBigNumber(item.totalTokens),
    models: Array.isArray(item.models) ? item.models.length : 0,
    last: formatTime(item.lastSeen),
    summary: item.summary ? '有摘要' : '',
  })), [
    { label: 'Session Key', key: 'key', width: 26 },
    { label: 'Harness', key: 'harness', width: 12 },
    { label: '请求', key: 'requests', width: 8, align: 'right' },
    { label: 'Token', key: 'tokens', width: 8, align: 'right' },
    { label: '模型', key: 'models', width: 5, align: 'right' },
    { label: '最后活动', key: 'last', width: 20 },
    { label: '摘要', key: 'summary', width: 6 },
  ], { maxWidth: process.stdout.columns || 120 }));
  return 0;
}

module.exports = { usageCommand, sessionsCommand };
