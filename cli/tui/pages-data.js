'use strict';

const { getStats, getStatsFilters, getLatencyStats, getMessageStats, getUsageLogs, statsSummary, listSessions, getSessionMessages, searchSessions } = require('../lib/api');
const { ApiError } = require('../lib/client');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');
const { text } = require('./pages-common');
const fs = require('node:fs/promises');
const path = require('node:path');

const arrayOrEmpty = value => Array.isArray(value) ? value : [];

function usagePage(runtime) {
  if (!runtime.usageDays) runtime.usageDays = runtime.cfg.tui ? runtime.cfg.tui.days : 30;
  if (!runtime.usageTab) runtime.usageTab = 'overview';
  return {
    id: 'usage',
    label: '用量',
    description: '请求数、Token（模型处理的文本单位）、费用、客户端识别率，以及各模型和来源的使用情况。',
    onTabChange(tab) { runtime.usageTab = tab?.id || 'overview'; },
    loadOnTabChange: true,
    tabs: [
      { id: 'overview', label: '概览' },
      { id: 'multi', label: '多维分析' },
      { id: 'daily', label: '每日趋势' },
      { id: 'hourly', label: '时段分布' },
      { id: 'models', label: '模型分析' },
      { id: 'keys', label: '密钥分析' },
      { id: 'sources', label: '客户端' },
      { id: 'latency', label: '延迟与吞吐' },
      { id: 'messages', label: '消息分析' },
      { id: 'logs', label: '调用记录' },
    ],
    async load(api) {
      const filters = runtime.usageFilters || {};
      const customRange = runtime.usageCustomRange || null;
      const dateQuery = customRange ? { start: customRange.start, end: customRange.end } : { days: runtime.usageDays };
      const stats = await getStats(runtime.client, customRange ? undefined : runtime.usageDays, { ...filters, ...dateQuery });
      const periodLabel = customRange ? `${customRange.start} 至 ${customRange.end}` : `最近 ${runtime.usageDays} 天`;
      const summary = statsSummary(stats);
      const dimensionColumns = [
        { key: 'name', label: '名称', ratio: 0.34 }, { key: 'requests', label: '请求数', ratio: 0.18 },
        { key: 'tokens', label: 'Token 用量', ratio: 0.22 }, { key: 'cost', label: '费用', ratio: 0.26 },
      ];
      const dimensionRows = (items, name) => items.map(row => {
        const title = name(row);
        return { label: title, cells: { name: title, requests: `${Number(row.requests || 0).toLocaleString()} 次`, tokens: `${formatBigNumber(row.tokens)} Token`, cost: `${formatCost(row.cost)} 积分` } };
      });
      const topModels = (Array.isArray(summary.byModel) ? summary.byModel : []).slice(0, 3);
      const topHours = (Array.isArray(stats.hourly) ? stats.hourly : []).slice().sort((a, b) => Number(b.requests || 0) - Number(a.requests || 0)).slice(0, 3);
      const sourceRows = (Array.isArray(summary.bySource) ? summary.bySource : []).filter(row => Number(row.requests || 0) > 0);
      const sourceMax = Math.max(1, ...sourceRows.map(row => Number(row.requests || 0)));
      const recentWeekRows = summary.daily.slice(-7);
      const previousWeekRows = summary.daily.slice(-14, -7);
      const recentWeek = recentWeekRows.reduce((sum, row) => sum + Number(row.cost || 0), 0);
      const previousWeek = previousWeekRows.reduce((sum, row) => sum + Number(row.cost || 0), 0);
      const trendPercent = previousWeek > 0 ? (recentWeek - previousWeek) / previousWeek * 100 : null;
      const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const todayInstant = new Date(`${todayDate}T00:00:00Z`);
      todayInstant.setUTCDate(todayInstant.getUTCDate() - 1);
      const yesterdayDate = todayInstant.toISOString().slice(0, 10);
      const todayUsage = summary.daily.find(row => row.date === todayDate) || {};
      const yesterdayUsage = summary.daily.find(row => row.date === yesterdayDate) || {};
      const cacheRate = summary.promptTokens > 0 ? summary.cachedTokens / summary.promptTokens * 100 : 0;
      const progress = value => { const ratio = Math.max(0, Math.min(100, Number(value) || 0)); const filled = Math.round(ratio / 100 * 20); return `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${ratio.toFixed(1)}%`; };
      const dailyMaxCost = Math.max(1, ...summary.daily.map(row => Number(row.cost || 0)));
      const dailyMaxRequests = Math.max(1, ...summary.daily.map(row => Number(row.requests || 0)));
      const weekDelta = previousWeek > 0 ? `${trendPercent >= 0 ? '+' : ''}${trendPercent.toFixed(1)}%` : '前 7 天无数据，无法计算';
      const sections = [{
        title: '统计概览', toolbar: true,
        description: `统计周期：${periodLabel}${Object.keys(filters).length ? ` · 已应用筛选 ${Object.keys(filters).length} 项` : ''}。`,
        cards: [
          { label: '总请求数', value: summary.requests.toLocaleString(), detail: `日均 ${Math.round(summary.requests / Math.max(summary.daily.length, 1)).toLocaleString()} 次` },
          { label: '总 Token 消耗', value: formatBigNumber(summary.tokens), detail: `输入 ${formatBigNumber(summary.promptTokens)} · 输出 ${formatBigNumber(summary.completionTokens)}` },
          { label: '总积分消耗', value: `${formatCost(summary.cost)} 积分`, detail: `日均 ${formatCost(summary.cost / Math.max(summary.daily.length, 1))} 积分` },
          { label: '平均延迟', value: `${Math.round(summary.avgLatency)} 毫秒`, detail: `${summary.requests ? `平均 ${formatBigNumber(Math.round(summary.tokens / summary.requests))} Token/请求` : '暂无请求'}` },
          { label: '客户端识别率', value: `${summary.identifiedRate.toFixed(1)}%`, detail: `${summary.activeSources} 种来源 · ${formatBigNumber(summary.unknownRequests)} 次未识别` },
        ],
      }];
      sections.push({ title: 'Prompt 缓存命中', cards: [{ label: '缓存命中率', value: `${cacheRate.toFixed(1)}%`, detail: progress(cacheRate) }, { label: '缓存命中 Token', value: formatBigNumber(summary.cachedTokens) }, { label: '总输入 Token', value: formatBigNumber(summary.promptTokens) }, { label: '节省 Token', value: formatBigNumber(summary.cachedTokens), detail: '缓存命中的 Token 数' }] });
      sections.push({ title: '今日与昨日对比', cards: [
        { label: `今日请求 · ${todayDate}`, value: Number(todayUsage.requests || 0).toLocaleString(), detail: `${Number(todayUsage.requests || 0) > Number(yesterdayUsage.requests || 0) ? '↑' : Number(todayUsage.requests || 0) < Number(yesterdayUsage.requests || 0) ? '↓' : '→'} 昨日 ${Number(yesterdayUsage.requests || 0).toLocaleString()} 次` },
        { label: '今日 Token', value: formatBigNumber(todayUsage.tokens), detail: `昨日 ${formatBigNumber(yesterdayUsage.tokens)} Token` },
        { label: '今日积分', value: `${formatCost(todayUsage.cost)} 积分`, detail: `昨日 ${formatCost(yesterdayUsage.cost)} 积分` },
      ] });
      sections.push({ title: '最常用模型', rows: topModels.length ? topModels.map((row, index) => ({ label: `${['🥇', '🥈', '🥉'][index]} ${row.model_name || '未知模型'}`, detail: `${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatCost(row.cost)} 积分` })) : [{ label: '暂无模型用量数据。' }] });
      sections.push({ title: '高峰时段', rows: topHours.length ? topHours.map((row, index) => ({ label: `${['🔥', '⚡', '📊'][index]} ${String(row.hour).padStart(2, '0')}:00–${String((Number(row.hour) + 1) % 24).toString().padStart(2, '0')}:00`, detail: `${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token` })) : [{ label: '暂无时段用量数据。' }] });
      sections.push({ title: '积分消耗趋势', description: `最近 7 天 ${formatCost(recentWeek)} 积分 · 前 7 天 ${formatCost(previousWeek)} 积分 · 环比 ${weekDelta}`, tableMinWidth: 92, columns: [{ key: 'date', label: '日期', ratio: 0.25 }, { key: 'requests', label: '请求数', ratio: 0.2 }, { key: 'requests_bar', label: '请求趋势', ratio: 0.25 }, { key: 'cost', label: '积分', ratio: 0.15 }, { key: 'cost_bar', label: '积分趋势', ratio: 0.15 }], rows: summary.daily.slice(-14).map(row => { const requestRatio = Number(row.requests || 0) / dailyMaxRequests; const costRatio = Number(row.cost || 0) / dailyMaxCost; return { label: row.date || '未知日期', cells: { date: row.date || '未知日期', requests: Number(row.requests || 0).toLocaleString(), requests_bar: `[${'█'.repeat(Math.round(requestRatio * 10))}${'░'.repeat(10 - Math.round(requestRatio * 10))}]`, cost: formatCost(row.cost), cost_bar: `[${'█'.repeat(Math.round(costRatio * 10))}${'░'.repeat(10 - Math.round(costRatio * 10))}]` } }; }) });
      sections.push({ title: '关键指标', rows: [
        { label: '平均 Token/请求', detail: `${summary.requests ? formatBigNumber(Math.round(summary.tokens / summary.requests)) : '0'} Token` },
        { label: '日均请求数', detail: `${Math.round(summary.requests / Math.max(summary.daily.length, 1)).toLocaleString()} 次` },
        { label: '日均积分消耗', detail: `${formatCost(summary.cost / Math.max(summary.daily.length, 1))} 积分` },
        { label: '平均响应延迟', detail: `${Math.round(summary.avgLatency)} 毫秒` },
      ] });
      sections.push({ title: '客户端来源', rows: sourceRows.length ? sourceRows.map(row => { const requests = Number(row.requests || 0); const ratio = requests / sourceMax; return { label: `${clientDisplay(row.request_source)} · ${requests.toLocaleString()} 次 · ${(requests / Math.max(summary.requests, 1) * 100).toFixed(1)}%`, detail: `[${'█'.repeat(Math.round(ratio * 20))}${'░'.repeat(20 - Math.round(ratio * 20))}]` }; }) : [{ label: '暂无可识别客户端来源。' }] });
      const pluginRows = (Array.isArray(stats.byPlugin) ? stats.byPlugin : []).filter(row => Number(row.requests || 0) > 0).slice(0, 10).map(row => ({ label: row.plugin_dim || '未知插件', detail: `${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)} 积分` }));
      sections.push({ title: '插件维度', rows: pluginRows.length ? pluginRows : [{ label: '暂无插件维度用量数据。' }] });
      if (runtime.usageTab === 'multi') {
        const query = runtime.usageMultiQuery || null;
        const result = runtime.usageMultiResult || null;
        if (!query || !result) {
          sections.push({ title: '自选维度分析', tab: 'multi', description: '选择一个或多个维度，按请求用量、供应商额度或关联分析汇总。', rows: [{ label: '尚未查询', detail: '选择维度与统计指标后，TUI 会按当前日期范围执行分析。' }] });
        } else if (query.data_source === 'quota') {
          const quotaMetricLabels = { total: '总额度', used: '已用额度', remaining: '剩余额度', used_percent: '窗口使用率', observed_consumption: '观测消耗', percent_change: '使用率变化（百分点）' };
          const dimensionLabels = { provider: '供应商', account: '额度账户', kind: '额度类型', unit: '单位', window: '窗口', date: '日期' };
          const formatQuotaDimension = (dimension, value) => dimension === 'kind' ? ({ balance: '余额额度', window: '周期额度', status: '查询状态' })[value] || value || '未知' : dimension === 'window' ? ({ primary: '主窗口', secondary: '次窗口', daily: '每日', weekly: '每周', monthly: '每月', five_hour: '5 小时', seven_day: '7 天', '5h': '5 小时', '7d': '7 天' })[value] || value || '无窗口' : value || '未知';
          const quotaRows = arrayOrEmpty(result.rows).map(row => ({ label: arrayOrEmpty(row.labels).map((value, index) => formatQuotaDimension(query.dimensions[index], value)).join(' / ') || '未分类', cells: { dimensions: arrayOrEmpty(row.labels).map((value, index) => formatQuotaDimension(query.dimensions[index], value)).join(' / ') || '未分类', metric: `${row.value == null ? '未知' : Number(row.value).toLocaleString(undefined, { maximumFractionDigits: ['used_percent', 'percent_change'].includes(query.metric) ? 1 : 2 })}${['used_percent', 'percent_change'].includes(query.metric) ? (query.metric === 'used_percent' ? '%' : ' 个百分点') : row.unit && row.unit !== 'unknown' ? ` ${row.unit}` : ''}`, quality: ({ reset: '周期重置', gap: '采样缺口', backfill: '历史回补', adjustment: '额度调整', initial: '首次观测', window_change: '周期窗口变更', success: '正常', partial: '部分成功', failed: '查询失败' })[row.quality?.last_event || row.quality?.event || row.status] || '—' } }));
          sections.push({ title: '供应商额度多维分析', tab: 'multi', description: `维度：${query.dimensions.map(value => dimensionLabels[value] || value).join('、')} · 指标：${quotaMetricLabels[query.metric] || query.metric} · ${periodLabel}`, tableMinWidth: 100, columns: [{ key: 'dimensions', label: query.dimensions.map(value => dimensionLabels[value] || value).join(' / '), ratio: 0.52 }, { key: 'metric', label: quotaMetricLabels[query.metric] || '额度指标', ratio: 0.28 }, { key: 'quality', label: '数据质量', ratio: 0.2 }], rows: quotaRows.length ? quotaRows : [{ label: '当前范围没有额度数据。' }] });
        } else {
          const metricLabels = { requests: '请求数', tokens: 'Token', cost: '积分', remaining: '剩余额度', used: '已用额度', total: '总额度', used_percent: '使用率', observed_consumption: '观测消耗', percent_change: '变化率' };
          const dimensionLabels = { key: '密钥', project: '项目', source: '客户端', model: '模型', provider: '供应商', account: '额度账户', kind: '额度类型', unit: '单位', window: '窗口', date: '日期' };
          const formatDimension = (dimension, value) => dimension === 'source' ? clientDisplay(value) : dimension === 'kind' ? ({ balance: '余额额度', window: '周期额度', status: '查询状态' })[value] || value || '未知' : value === '__unknown__' ? '未识别项目' : value || '未知';
          const dataQuality = row => ({ reset: '周期重置', gap: '采样缺口', backfill: '历史回补', adjustment: '额度调整', initial: '首次观测', window_change: '周期窗口变更', observed_consumption: '观测消耗', success: '正常', partial: '部分成功', failed: '查询失败' })[row.quality?.last_event || row.quality?.event || row.status] || '—';
          const metricValue = row => query.metric === 'requests' ? `${Number(row.requests || 0).toLocaleString()} 次` : query.metric === 'tokens' ? `${formatBigNumber(row.tokens)} Token` : query.metric === 'cost' ? `${formatCost(row.cost)} 积分` : row.value == null ? '未知' : `${Number(row.value).toLocaleString(undefined, { maximumFractionDigits: ['used_percent', 'percent_change'].includes(query.metric) ? 1 : 2 })}${['used_percent', 'percent_change'].includes(query.metric) ? (query.metric === 'used_percent' ? '%' : ' 个百分点') : row.unit && row.unit !== 'unknown' ? ` ${row.unit}` : ''}`;
          const multiRows = arrayOrEmpty(result.rows).map(row => ({ label: arrayOrEmpty(row.labels).map((value, index) => formatDimension(query.dimensions[index], value)).join(' / ') || '未分类', cells: { dimensions: arrayOrEmpty(row.labels).map((value, index) => formatDimension(query.dimensions[index], value)).join(' / ') || '未分类', metric: metricValue(row), quality: dataQuality(row) } }));
          sections.push({ title: query.data_source === 'association' ? '多维关联分析' : '自选维度分析', tab: 'multi', description: `维度：${query.dimensions.map(value => dimensionLabels[value] || value).join('、')} · 指标：${metricLabels[query.metric] || query.metric} · ${periodLabel}`, tableMinWidth: 100, columns: [{ key: 'dimensions', label: query.dimensions.map(value => dimensionLabels[value] || value).join(' / '), ratio: 0.52 }, { key: 'metric', label: metricLabels[query.metric] || '统计指标', ratio: 0.28 }, { key: 'quality', label: '数据质量', ratio: 0.2 }], rows: multiRows.length ? multiRows : [{ label: '当前范围没有符合条件的数据。' }] });
          if (query.include_quota && result.provider_quota) sections.push({ title: '供应商额度参照', tab: 'multi', description: '额度是独立上游账户观测值，不应与请求消费金额直接相加。', rows: arrayOrEmpty(result.provider_quota.accounts).slice(0, 30).map(account => ({ label: `${account.provider_name || account.provider_id || '未知供应商'} · ${account.label || account.account_id || '额度账户'}`, detail: `${account.used ?? '未知'} / ${account.total ?? '未知'}${account.unit ? ` ${account.unit}` : ''} · ${account.used_percent == null ? '使用率未知' : `${Number(account.used_percent).toFixed(1)}%`}` })) });
        }
      }
      if (runtime.usageTab === 'daily') sections.push({ title: '每日详细数据', tab: 'daily', toolbar: true, tableMinWidth: 128, columns: [
        { key: 'date', label: '日期', ratio: 0.18 }, { key: 'requests', label: '请求数', ratio: 0.13 }, { key: 'input', label: 'Prompt Token', ratio: 0.15 },
        { key: 'output', label: 'Completion Token', ratio: 0.15 }, { key: 'cached', label: '缓存命中', ratio: 0.14 }, { key: 'cost', label: '积分', ratio: 0.12 }, { key: 'latency', label: '平均延迟', ratio: 0.13 },
      ], description: `每日请求、Token、缓存命中、积分与平均延迟 · ${periodLabel}`, rows: summary.daily.slice(-30).map(row => ({ label: row.date || '未知日期', cells: {
        date: row.date || '未知日期', requests: Number(row.requests || 0).toLocaleString(), input: formatBigNumber(row.prompt_tokens),
        output: formatBigNumber(row.completion_tokens), cached: `${formatBigNumber(row.cached_tokens)} Token`, cost: formatCost(row.cost), latency: `${Math.round(Number(row.avg_latency || 0))} 毫秒`,
      } })) });
      if (runtime.usageTab === 'hourly') {
        const hourly = Array.from({ length: 24 }, (_, hour) => {
          const row = (Array.isArray(stats.hourly) ? stats.hourly : []).find(item => Number(item.hour) === hour) || {};
          return { hour, requests: Number(row.requests || 0), tokens: Number(row.tokens || 0) };
        });
        const peakRequests = [...hourly].sort((a, b) => b.requests - a.requests)[0];
        const peakTokens = [...hourly].sort((a, b) => b.tokens - a.tokens)[0];
        const maxRequests = Math.max(1, ...hourly.map(item => item.requests));
        const maxTokens = Math.max(1, ...hourly.map(item => item.tokens));
        sections.push({ title: '每小时请求分布（24 小时）', tab: 'hourly', toolbar: true, tableMinWidth: 92,
          description: `最近 ${runtime.usageDays} 天 · 请求高峰 ${String(peakRequests.hour).padStart(2, '0')}:00（${peakRequests.requests.toLocaleString()} 次）· Token 高峰 ${String(peakTokens.hour).padStart(2, '0')}:00（${formatBigNumber(peakTokens.tokens)} Token）`,
          columns: [
            { key: 'hour', label: '小时', ratio: 0.16 }, { key: 'requests', label: '请求数', ratio: 0.25 },
            { key: 'requests_bar', label: '请求分布', ratio: 0.29 }, { key: 'tokens', label: 'Token', ratio: 0.16 }, { key: 'tokens_bar', label: 'Token 分布', ratio: 0.14 },
          ], rows: hourly.map(item => { const requestWidth = Math.round(item.requests / maxRequests * 12); const tokenWidth = Math.round(item.tokens / maxTokens * 8); return { label: `${String(item.hour).padStart(2, '0')}:00`, cells: {
            hour: `${String(item.hour).padStart(2, '0')}:00`, requests: item.requests.toLocaleString(), requests_bar: `[${'█'.repeat(requestWidth)}${'░'.repeat(12 - requestWidth)}]`, tokens: formatBigNumber(item.tokens), tokens_bar: `[${'█'.repeat(tokenWidth)}${'░'.repeat(8 - tokenWidth)}]`,
          } }; }) });
      }
      if (runtime.usageTab === 'models') {
        const modelRows = (summary.byModel || []).map(row => {
          const promptTokens = Number(row.prompt_tokens || 0);
          const cachedTokens = Number(row.cached_tokens || 0);
          const cacheRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0.0';
          const modelName = row.model_name || '（已删除）';
          return { label: modelName, cells: {
            model: modelName,
            requests: Number(row.requests || 0).toLocaleString(),
            prompt: formatBigNumber(promptTokens),
            completion: formatBigNumber(row.completion_tokens),
            cached: `${formatBigNumber(cachedTokens)} (${cacheRate}%)`,
            cost: formatCost(row.cost),
            latency: `${Math.round(Number(row.avg_latency || 0))} 毫秒`,
          } };
        });
        sections.push({ title: '模型详细数据', tab: 'models', toolbar: true, tableMinWidth: 126, columns: [
          { key: 'model', label: '模型', ratio: 0.22 }, { key: 'requests', label: '请求数', ratio: 0.12 },
          { key: 'prompt', label: 'Prompt Token', ratio: 0.14 }, { key: 'completion', label: 'Completion Token', ratio: 0.16 },
          { key: 'cached', label: '缓存命中', ratio: 0.14 }, { key: 'cost', label: '积分', ratio: 0.1 }, { key: 'latency', label: '平均延迟', ratio: 0.12 },
        ], description: `共 ${modelRows.length} 个模型 · 按请求数排序 · ${periodLabel}`, rows: modelRows.length ? modelRows : [{ label: '当前范围没有模型用量。' }] });
      }
      if (runtime.usageTab === 'keys') {
        const keyRows = (summary.byApiKey || []).map(row => {
          const tokens = Number(row.tokens || 0);
          const cached = Number(row.cached_tokens || 0);
          const prefix = String(row.key_prefix || '').trim();
          return { label: row.key_name || 'API Key', cells: { name: row.key_name || 'API Key', prefix: prefix ? `${prefix}****` : '—', requests: Number(row.requests || 0).toLocaleString(), tokens: formatBigNumber(tokens), cached: cached > 0 ? formatBigNumber(cached) : '—', cost: Number(row.cost || 0).toFixed(4) } };
        });
        sections.push({ title: 'API Key 详细数据', tab: 'keys', toolbar: true, tableMinWidth: 108, columns: [
          { key: 'name', label: '密钥名称', ratio: 0.22 }, { key: 'prefix', label: '前缀', ratio: 0.16 }, { key: 'requests', label: '请求数', ratio: 0.16 },
          { key: 'tokens', label: 'Token', ratio: 0.16 }, { key: 'cached', label: '缓存命中', ratio: 0.16 }, { key: 'cost', label: '积分', ratio: 0.14 },
        ], description: `${keyRows.length} 个 API Key · ${periodLabel}`, rows: keyRows.length ? keyRows : [{ label: '当前范围没有 API Key 用量。' }] });
      }
      if (runtime.usageTab === 'sources') {
        const rows = arrayOrEmpty(summary.bySource);
        const maxRequests = Math.max(1, ...rows.map(row => Number(row.requests || 0)));
        const bySourceModel = arrayOrEmpty(stats.bySourceModel);
        const sourceColumns = [
          { key: 'client', label: '客户端', ratio: 0.14 }, { key: 'requests', label: '请求数', ratio: 0.09 }, { key: 'share', label: '占比', ratio: 0.1 },
          { key: 'tokens', label: 'Token', ratio: 0.1 }, { key: 'prompt', label: 'Prompt', ratio: 0.1 }, { key: 'completion', label: 'Completion', ratio: 0.1 },
          { key: 'cached', label: '缓存', ratio: 0.1 }, { key: 'cost', label: '积分', ratio: 0.1 }, { key: 'latency', label: '平均延迟', ratio: 0.1 }, { key: 'actions', label: '操作', ratio: 0.07 },
        ];
        const sourceRows = rows.map(row => {
          const requests = Number(row.requests || 0);
          const prompt = Number(row.prompt_tokens || 0);
          const cached = Number(row.cached_tokens || 0);
          const percentage = Number(row.share_requests ?? (requests / Math.max(summary.requests, 1)) * 100);
          const barLength = Math.round(requests / maxRequests * 10);
          const sourceId = String(row.request_source || 'unknown');
          return { label: clientDisplay(sourceId), cells: { client: clientDisplay(sourceId), requests: requests.toLocaleString(), share: `${percentage.toFixed(1)}% [${'█'.repeat(barLength)}${'░'.repeat(10 - barLength)}]`, tokens: formatBigNumber(row.tokens), prompt: formatBigNumber(prompt), completion: formatBigNumber(row.completion_tokens), cached: formatBigNumber(cached), cost: formatCost(row.cost), latency: row.avg_latency == null ? '—' : `${Math.round(Number(row.avg_latency))} 毫秒`, actions: '筛选 / 记录' }, run: async ctx => { const selected = await ctx.choose(`客户端 · ${clientDisplay(sourceId)}`, [{ label: '按此客户端筛选统计', value: 'filter' }, { label: '查看此客户端调用记录', value: 'logs' }]); if (selected === 'filter') { runtime.usageFilters = { ...(runtime.usageFilters || {}), request_source: sourceId }; runtime.usageLogPage = 1; await ctx.refresh(); } if (selected === 'logs') { runtime.usageLogFilters = { ...(runtime.usageLogFilters || {}), request_source: sourceId }; runtime.usageLogPage = 1; runtime.usageTab = 'logs'; await ctx.refresh(); } } };
        });
        const requestMax = Math.max(1, ...bySourceModel.map(row => Number(row.requests || 0)));
        const sourceModelRows = bySourceModel.map(row => { const requests = Number(row.requests || 0); const barLength = Math.round(requests / requestMax * 12); return { label: `${clientDisplay(row.request_source)} / ${row.model_name || row.model_id || '未知模型'}`, cells: { client: clientDisplay(row.request_source), model: row.model_name || row.model_id || '未知模型', requests: requests.toLocaleString(), requests_bar: `[${'█'.repeat(barLength)}${'░'.repeat(12 - barLength)}]`, tokens: formatBigNumber(row.tokens), cost: formatCost(row.cost) } }; });
        const maxCost = Math.max(1, ...rows.map(row => Number(row.cost || 0)));
        const distributionRows = rows.map(row => { const requests = Number(row.requests || 0); const cost = Number(row.cost || 0); const requestLength = Math.round(requests / maxRequests * 20); const costLength = Math.round(cost / maxCost * 20); return { label: clientDisplay(row.request_source), detail: `请求 ${requests.toLocaleString()} 次 [${'█'.repeat(requestLength)}${'░'.repeat(20 - requestLength)}] · 积分 ${formatCost(cost)} [${'█'.repeat(costLength)}${'░'.repeat(20 - costLength)}]` }; });
        sections.push({ title: '客户端分析说明', tab: 'sources', description: '按 harness 客户端汇总用量。识别依赖 User-Agent、专用请求头和提示词指纹。', rows: [{ label: '自定义 system 提示词或历史请求数据可能显示为“未知/其他”。' }] });
        sections.push({ title: '请求数 / 积分分布', tab: 'sources', rows: distributionRows.length ? distributionRows : [{ label: '暂无客户端数据。' }] });
        sections.push({ title: '客户端详细数据', tab: 'sources', toolbar: true, tableMinWidth: 150, columns: sourceColumns, rows: sourceRows.length ? sourceRows : [{ label: '暂无客户端数据。' }] });
        sections.push({ title: '客户端 × 模型', tab: 'sources', toolbar: true, tableMinWidth: 112, columns: [
          { key: 'client', label: '客户端', ratio: 0.18 }, { key: 'model', label: '模型', ratio: 0.28 }, { key: 'requests', label: '请求数', ratio: 0.16 }, { key: 'requests_bar', label: '请求分布', ratio: 0.18 }, { key: 'tokens', label: 'Token', ratio: 0.1 }, { key: 'cost', label: '积分', ratio: 0.1 },
        ], rows: sourceModelRows.length ? sourceModelRows : [{ label: '暂无客户端与模型交叉数据。' }] });
      }
      if (runtime.usageTab === 'latency') {
        const { team_id: _unsupportedLatencyTeamFilter, ...latencyFilters } = filters;
        const latency = await getLatencyStats(runtime.client, { ...dateQuery, ...latencyFilters });
        const latencySummary = latency.summary || {};
        const latencyModelRows = arrayOrEmpty(latency.byModel).map(row => ({ label: row.name || '未知模型', cells: {
          model: row.name || '未知模型', requests: Number(row.requests || 0).toLocaleString(), measured: `${Number(row.measuredRequests || 0).toLocaleString()} (${(Number(row.coverage || 0) * 100).toFixed(1)}%)`,
          ttft50: row.ttft?.p50 == null ? '未采集' : `${row.ttft.p50} 毫秒`, ttft75: row.ttft?.p75 == null ? '未采集' : `${row.ttft.p75} 毫秒`,
          ttft95: row.ttft?.p95 == null ? '未采集' : `${row.ttft.p95} 毫秒`, ttft99: row.ttft?.p99 == null ? '未采集' : `${row.ttft.p99} 毫秒`,
          tpot50: row.tpot?.p50 == null ? '未采集' : `${Number(row.tpot.p50).toFixed(1)} 毫秒`, tps50: row.outputTps?.p50 == null ? '未采集' : `${Number(row.outputTps.p50).toFixed(2)} Token/秒`,
          e2e95: row.e2e?.p95 == null ? '未采集' : `${row.e2e.p95} 毫秒`, cache: row.cacheHitRate == null ? '未采集' : `${(Number(row.cacheHitRate) * 100).toFixed(1)}%`,
        } }));
        const dailyLatencyRows = arrayOrEmpty(latency.daily).map(row => ({ label: row.date || '未知日期', cells: {
          date: row.date || '未知日期', requests: Number(row.requests || 0).toLocaleString(), measured: `${Number(row.measuredRequests || 0).toLocaleString()} (${(Number(row.measuredRequests || 0) / Math.max(Number(row.requests || 0), 1) * 100).toFixed(1)}%)`,
          ttft50: row.ttft?.p50 == null ? '未采集' : `${row.ttft.p50} 毫秒`, ttft95: row.ttft?.p95 == null ? '未采集' : `${row.ttft.p95} 毫秒`,
          tps50: row.outputTps?.p50 == null ? '未采集' : `${Number(row.outputTps.p50).toFixed(2)} Token/秒`, e2e95: row.e2e?.p95 == null ? '未采集' : `${row.e2e.p95} 毫秒`,
        } }));
        const rateLimitRows = arrayOrEmpty(latency.rateLimits).map(row => ({ label: row.providerName || row.providerId || '未知供应商', detail: `采集时间：${row.observedAt ? formatTime(row.observedAt) : '未知'} · 服务层级：${row.serviceTier || '未提供'} · ${row.rateLimit ? Object.entries(row.rateLimit).map(([key, value]) => `${({ requests_remaining: '剩余请求', requests_limit: '请求上限', requests_reset: '请求重置', tokens_remaining: '剩余 Token', tokens_limit: 'Token 上限', tokens_reset: 'Token 重置' })[key] || key.replace(/_/g, ' ')} ${value}`).join(' · ') : '上游未返回限流数据'}` }));
        sections.push(
          { title: '延迟指标说明', tab: 'latency', rows: [{ label: '以下为网关实际采集的首字延迟（TTFT）、每 Token 生成耗时（TPOT）、输出速度和端到端延迟（E2E）。' }, { label: `当前范围：${latency.window?.start || '未知'} 至 ${latency.window?.end || '未知'} · 时区 ${latency.window?.timezone || 'Asia/Shanghai'}` }, { label: `已采集 ${Number(latencySummary.measuredRequests || 0).toLocaleString()} / ${Number(latencySummary.requests || 0).toLocaleString()} 条请求（${(Number(latencySummary.coverage || 0) * 100).toFixed(1)}%）` }, { label: `已应用延迟筛选：${[filters.model_id && '模型', filters.provider_id && '供应商', filters.request_source && '客户端'].filter(Boolean).join('、') || '无额外筛选'}` }, ...(filters.team_id ? [{ label: '注意：Team 筛选不适用于延迟与吞吐统计；此结果未按 Team 限定。' }] : [])] },
          { title: '延迟与吞吐摘要', tab: 'latency', cards: [
            { label: 'TTFT P50', value: latencySummary.ttft?.p50 == null ? '未采集' : `${latencySummary.ttft.p50} 毫秒` },
            { label: 'TTFT P95', value: latencySummary.ttft?.p95 == null ? '未采集' : `${latencySummary.ttft.p95} 毫秒` },
            { label: '输出速度 P50', value: latencySummary.outputTps?.p50 == null ? '未采集' : `${Number(latencySummary.outputTps.p50).toFixed(2)} Token/秒` },
            { label: 'TPOT P50', value: latencySummary.tpot?.p50 == null ? '未采集' : `${Number(latencySummary.tpot.p50).toFixed(1)} 毫秒` },
            { label: 'E2E P95', value: latencySummary.e2e?.p95 == null ? '未采集' : `${latencySummary.e2e.p95} 毫秒` },
            { label: '缓存命中率', value: latencySummary.cacheHitRate == null ? '未采集' : `${(Number(latencySummary.cacheHitRate) * 100).toFixed(1)}%` },
            { label: '上游处理时间均值', value: latencySummary.upstreamProcessingAvg == null ? '未采集' : `${latencySummary.upstreamProcessingAvg} 毫秒` },
            { label: '吞吐达标率', value: ['ge50', 'ge80', 'ge90', 'ge100'].map((key, index) => `≥${[50, 80, 90, 100][index]}：${latencySummary.tpsThresholds?.[key] == null ? '—' : `${(Number(latencySummary.tpsThresholds[key]) * 100).toFixed(1)}%`}`).join(' · '), detail: '输出速度达对应 Token/秒阈值的请求比例' },
          ] },
          { title: '每日首字延迟与输出速度', tab: 'latency', rows: dailyLatencyRows.length ? dailyLatencyRows.map(row => ({ label: `${row.cells.date} · ${row.cells.requests} 次请求 · 已采集 ${row.cells.measured}`, detail: `TTFT P50 ${row.cells.ttft50} · P95 ${row.cells.ttft95} · 输出速度 P50 ${row.cells.tps50} · E2E P95 ${row.cells.e2e95}` })) : [{ label: '当前范围没有每日延迟数据。' }] },
          { title: '模型延迟与吞吐', tab: 'latency', tableMinWidth: 150, columns: [
            { key: 'model', label: '模型', ratio: 0.15 }, { key: 'requests', label: '请求数', ratio: 0.08 }, { key: 'measured', label: '已采集', ratio: 0.1 },
            { key: 'ttft50', label: 'TTFT P50', ratio: 0.09 }, { key: 'ttft75', label: 'TTFT P75', ratio: 0.09 }, { key: 'ttft95', label: 'TTFT P95', ratio: 0.09 },
            { key: 'ttft99', label: 'TTFT P99', ratio: 0.09 }, { key: 'tpot50', label: 'TPOT P50', ratio: 0.08 }, { key: 'tps50', label: '输出 TPS P50', ratio: 0.09 },
            { key: 'e2e95', label: 'E2E P95', ratio: 0.07 }, { key: 'cache', label: '缓存命中', ratio: 0.07 },
          ], rows: latencyModelRows.length ? latencyModelRows : [{ label: '当前范围没有按模型采集到的延迟数据。' }] },
          { title: '最近一次上游限流状态', tab: 'latency', rows: rateLimitRows.length ? rateLimitRows : [{ label: '当前范围没有包含上游限流信息的请求记录。' }] },
        );
      }
      if (runtime.usageTab === 'messages') {
        const messageStats = await getMessageStats(runtime.client, { ...dateQuery, ...filters });
        const analysisStatus = messageStats.summary?.analysis_status || {};
        const summaryLabels = {
          requests: '请求数', analyzed_requests: '已分析请求数', total_messages: '消息总数', total_characters: '字符总数', total_lines: '行数总计',
          sampled: '是否抽样', sample_size: '样本数', metadata_requests: '包含元数据的请求', workspace_requests: '包含工作区信息的请求',
          git_requests: '包含 Git 状态的请求', total_tokens: 'Token 总量', total_cost: '费用（积分）', active_days: '活跃天数',
          first_activity: '首次活动日期', last_activity: '最近活动日期', avg_messages: '平均每次请求消息数', avg_characters: '平均每次请求字符数',
          avg_lines: '平均每次请求行数', avg_daily_requests: '日均请求数', avg_daily_tokens: '日均 Token 用量', metadata_rate: '元数据覆盖率',
          workspace_rate: '工作区信息覆盖率', git_rate: 'Git 状态覆盖率',
        };
        const summary = messageStats.summary || {};
        const pct = value => `${(Number(value || 0) * 100).toFixed(1)}%`;
        const summaryRows = [
          { label: '活跃请求', detail: `${Number(summary.analyzed_requests || 0).toLocaleString()} 条` },
          { label: '项目数', detail: `${arrayOrEmpty(messageStats.by_workspace).length} 个` },
          { label: '活跃天数', detail: `${Number(summary.active_days || 0)} 天` },
          { label: '日均请求', detail: `${Number(summary.avg_daily_requests || 0).toFixed(1)} 次` },
          { label: '总 Token', detail: `${formatBigNumber(summary.total_tokens)} Token` },
          { label: 'Git 状态率', detail: pct(summary.git_rate) },
          ...(Number(analysisStatus.pending_requests || 0) > 0 ? [{ label: `后台待分析：${Number(analysisStatus.pending_requests).toLocaleString()} 个请求`, detail: '这些请求尚未完成消息结构扫描。' }] : []),
        ];
        const blockRows = Array.isArray(messageStats.by_block) ? messageStats.by_block.map(item => ({ label: item.block || '未知区块', cells: { block: item.block || '未知区块', requests: Number(item.requests || 0).toLocaleString(), occurrences: Number(item.occurrences || 0).toLocaleString() } })) : Object.entries(messageStats.blocks || {}).map(([name, count]) => ({ label: name.replace(/_/g, ' '), cells: { block: name.replace(/_/g, ' '), requests: Number(count || 0).toLocaleString(), occurrences: Number(count || 0).toLocaleString() } }));
        const messageSources = Array.isArray(messageStats.by_source) ? messageStats.by_source : [];
        const messageSourceRows = messageSources.map(item => ({ label: clientDisplay(item.request_source), cells: { source: clientDisplay(item.request_source), requests: Number(item.requests || 0).toLocaleString(), avg_messages: (Number(item.messages || 0) / Math.max(Number(item.requests || 0), 1)).toFixed(1), avg_characters: Math.round(Number(item.characters || 0) / Math.max(Number(item.requests || 0), 1)).toLocaleString(), tokens: formatBigNumber(item.tokens) } }));
        const dailyRows = Array.isArray(messageStats.daily) ? messageStats.daily.map(item => ({ label: item.date || '未知日期', detail: `${Number(item.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(item.tokens)} Token · ${Number(item.messages || 0).toLocaleString()} 条消息${item.git_requests != null ? ` · 含 Git 状态 ${item.git_requests} 次` : ''}` })) : [];
        const analysisNote = analysisStatus.enabled === false ? '消息分析功能当前未启用。' : analysisStatus.last_error ? `最近一次后台分析异常：${analysisStatus.last_error}` : '只统计自己实际发送的消息记录。';
        const maxDailyRequests = Math.max(1, ...arrayOrEmpty(messageStats.daily).map(item => Number(item.requests || 0)));
        const maxDailyTokens = Math.max(1, ...arrayOrEmpty(messageStats.daily).map(item => Number(item.tokens || 0)));
        const dailyTrendRows = arrayOrEmpty(messageStats.daily).map(item => { const requestWidth = Math.round(Number(item.requests || 0) / maxDailyRequests * 12); const tokenWidth = Math.round(Number(item.tokens || 0) / maxDailyTokens * 8); return { label: item.date || '未知日期', detail: `请求 ${Number(item.requests || 0).toLocaleString()} 次 [${'█'.repeat(requestWidth)}${'░'.repeat(12 - requestWidth)}] · Token ${formatBigNumber(item.tokens)} [${'█'.repeat(tokenWidth)}${'░'.repeat(8 - tokenWidth)}]` }; });
        const workspaceRows = Array.isArray(messageStats.by_workspace) ? messageStats.by_workspace.slice(0, 50).map(item => ({ label: item.workspace_path || '未识别项目', detail: `${Number(item.requests || 0).toLocaleString()} 次活跃请求 · ${formatBigNumber(item.tokens)} Token · ${formatCost(item.cost)} 积分 · ${Math.round(Number(item.characters || 0)).toLocaleString()} 字符${item.sources ? ` · 客户端 ${Object.keys(item.sources).map(clientDisplay).join('、')}` : ''}` })) : [];
        sections.push(
          { title: '项目活跃趋势', tab: 'messages', description: `按日展示请求数与 Token · ${periodLabel}`, rows: dailyTrendRows.length ? dailyTrendRows : [{ label: '当前范围暂无项目活跃趋势。' }] },
          { title: '消息读取概要', tab: 'messages', description: `${analysisNote}${analysisStatus.enabled === false ? '' : ' · 请求消息由后台异步扫描'}`, rows: summaryRows },
          { title: '项目结构区块', tab: 'messages', tableMinWidth: 88, columns: [{ key: 'block', label: '区块', ratio: 0.48 }, { key: 'requests', label: '请求数', ratio: 0.26 }, { key: 'occurrences', label: '出现次数', ratio: 0.26 }], rows: blockRows.length ? blockRows : [{ label: '暂无项目结构区块。' }] },
          { title: 'Harness 消息结构', tab: 'messages', tableMinWidth: 96, columns: [{ key: 'source', label: 'Harness', ratio: 0.24 }, { key: 'requests', label: '请求数', ratio: 0.18 }, { key: 'avg_messages', label: '平均消息', ratio: 0.18 }, { key: 'avg_characters', label: '平均字符', ratio: 0.2 }, { key: 'tokens', label: 'Token', ratio: 0.2 }], rows: messageSourceRows.length ? messageSourceRows : [{ label: '暂无 Harness 消息结构数据。' }] },
          ...(workspaceRows.length ? [{ title: '工作区明细', tab: 'messages', description: `${workspaceRows.length} 个工作区（最多显示 50 个）`, rows: workspaceRows }] : []),
        );
      }
      if (runtime.usageTab === 'logs') {
        const logs = await getUsageLogs(runtime.client, { page: runtime.usageLogPage || 1, limit: 50, ...(runtime.usageLogFilters || {}) });
        runtime.usageLogTotal = Number(logs.total || 0);
        const items = Array.isArray(logs.logs) ? logs.logs : Array.isArray(logs.items) ? logs.items : [];
        const logPage = Number(logs.page || runtime.usageLogPage || 1);
        const logPages = Math.max(1, Math.ceil(Number(logs.total || 0) / 50));
        sections.push({ title: '调用记录', tab: 'logs', toolbar: true, toolbarLabel: '筛选、导出与分页', tableMinWidth: 124, columns: [
          { key: 'time', label: '时间', ratio: 0.17 }, { key: 'model', label: '模型', ratio: 0.17 }, { key: 'series', label: '系列', ratio: 0.09 },
          { key: 'source', label: '客户端', ratio: 0.13 }, { key: 'key', label: 'API Key', ratio: 0.14 }, { key: 'tokens', label: 'Token', ratio: 0.1 },
          { key: 'cached', label: '缓存命中', ratio: 0.1 }, { key: 'cost', label: '积分', ratio: 0.1 },
        ], description: `第 ${logPage}/${logPages} 页 · 共 ${logs.total || 0} 条 · 每页 50 条${Object.keys(runtime.usageLogFilters || {}).length ? ` · 已应用 ${Object.keys(runtime.usageLogFilters).length} 项筛选` : ''}`, rows: items.map(item => ({ label: formatTime(item.created_at), cells: {
          time: formatTime(item.created_at), model: item.model_name || item.model_id || '未知模型', series: item.series || '无系列',
          source: clientDisplay(item.request_source), key: `${item.key_prefix ? `${item.key_prefix}••••` : '无前缀'}${item.key_name ? `（${item.key_name}）` : ''}`,
          tokens: `${formatBigNumber(item.tokens_used || item.tokens)} Token`, cached: `${formatBigNumber(item.cached_tokens || 0)} Token`, cost: `${formatCost(item.cost)} 积分`,
        }, run: async ctx => {
          const data = item.id != null ? await ctx.api(`/api/user/usage-logs/${encodeURIComponent(item.id)}`) : { log: item };
          const log = data.log || item;
          const promptTokens = Number(log.prompt_tokens || 0);
          const cachedTokens = Number(log.cached_tokens || 0);
          const modelName = log.model_name || log.model_id || '未知模型';
          const lines = [
            `调用时间：${formatTime(log.created_at)}`, `模型：${modelName}`, `上游模型 ID：${log.upstream_model_id || '未知'}`, `系列：${log.series || '无'}`,
            `供应商：${log.provider_name || '未知供应商'}`, `请求类型：${log.request_type || '未知'}`, `客户端：${clientDisplay(log.request_source)}`,
            `API Key：${log.key_prefix ? `${log.key_prefix}****` : '未知'}${log.key_name ? `（${log.key_name}）` : ''}`,
            `总 Token：${formatBigNumber(log.tokens_used || 0)}`, `输入 Token：${formatBigNumber(promptTokens)}`, `输出 Token：${formatBigNumber(log.completion_tokens || 0)}`,
            `缓存命中 Token：${formatBigNumber(cachedTokens)}${promptTokens ? `（${(cachedTokens / promptTokens * 100).toFixed(1)}%）` : ''}`,
            `积分：${Number(log.cost || 0) === 0 && Number(log.tokens_used || 0) > 0 ? '0（配额内）' : formatCost(log.cost)}`,
            `记录延迟（服务端）：${log.latency_ms == null ? '未知' : `${log.latency_ms} 毫秒`}`,
            `请求模式：${log.is_stream == null ? '未知' : log.is_stream ? '流式' : '非流式'}`,
            `首字延迟（TTFT）：${log.ttft_ms == null ? '未知' : `${log.ttft_ms} 毫秒`}`,
            `上游首字节：${log.upstream_first_byte_ms == null ? '未知' : `${log.upstream_first_byte_ms} 毫秒`}`,
            `生成耗时：${log.generation_ms == null ? '未知' : `${log.generation_ms} 毫秒`}`,
            `每输出 Token 耗时（TPOT）：${log.tpot_ms == null ? '未知' : `${Number(log.tpot_ms).toFixed(1)} 毫秒`}`,
            `输出速度：${log.output_tps == null ? '未知' : `${Number(log.output_tps).toFixed(1)} Token/秒`}`,
            `端到端延迟：${log.e2e_ms == null ? '未知' : `${log.e2e_ms} 毫秒`}`,
            `上游处理时间：${log.upstream_processing_ms == null ? '未知' : `${log.upstream_processing_ms} 毫秒`}`,
            `服务层级：${log.service_tier || '未知'}`, `限流状态：${log.rate_limit ? JSON.stringify(log.rate_limit) : '无'}`, `IP 地址：${log.ip_address || '未知'}`,
          ];
          if (log.messages) lines.push('', '请求消息：', typeof log.messages === 'string' ? log.messages : JSON.stringify(log.messages, null, 2));
          if (log.response) lines.push('', 'AI 回复：', String(log.response));
          await ctx.show(`调用记录详情 · ${modelName}`, lines.join('\\n'));
        } })) });
      }
      return {
        sections,
        pageToolbar: true,
        actions: [
          { label: '设置多维分析', tab: 'multi', toolbar: 'page', run: async ctx => {
            const source = await ctx.choose('分析数据源', [
              { label: '请求用量', value: 'usage' }, { label: '供应商额度', value: 'quota' }, { label: '关联分析', value: 'association' },
            ], { description: '请求用量统计请求、Token 与积分；额度为供应商上游账户快照；关联分析汇总旧周期数据。' });
            if (!source) return;
            const usageDimensions = [['key', '密钥'], ['project', '项目'], ['source', '客户端'], ['model', '模型'], ['provider', '供应商']];
            const quotaDimensions = [['provider', '供应商'], ['account', '额度账户'], ['kind', '额度类型'], ['unit', '单位'], ['window', '周期窗口'], ['date', '日期']];
            const choices = source === 'quota' ? quotaDimensions : usageDimensions;
            const selected = new Set((runtime.usageMultiQuery?.data_source === source ? runtime.usageMultiQuery.dimensions : ['model']).filter(value => choices.some(([id]) => id === value)));
            while (true) {
              const value = await ctx.choose('选择统计维度', [
                ...choices.map(([id, label]) => ({ label: `${selected.has(id) ? '☑' : '☐'} ${label}`, value: id })),
              ], { description: `当前已选 ${selected.size} 项：${[...selected].map(id => choices.find(([key]) => key === id)?.[1]).filter(Boolean).join('、') || '无'}。选择一项切换勾选；取消或返回即完成，至少选择一项。` });
              if (value === null) break;
              if (selected.has(value)) selected.delete(value); else selected.add(value);
            }
            if (!selected.size) { await ctx.show('尚未选择维度', '至少选择一个统计维度后才能查询。'); return; }
            const metricOptions = source === 'quota'
              ? [['total', '总额度'], ['used', '已用额度'], ['remaining', '剩余额度'], ['used_percent', '窗口使用率'], ['observed_consumption', '观测消耗'], ['percent_change', '使用率变化（百分点）']]
              : [['requests', '请求数'], ['tokens', 'Token 用量'], ['cost', '积分']];
            const metric = await ctx.choose('统计指标', metricOptions.map(([value, label]) => ({ label, value })), { description: '选择排序与展示的主要统计指标。' });
            if (!metric) return;
            if (source === 'quota' && ['used_percent', 'percent_change'].includes(metric) && !selected.has('account')) { await ctx.show('额度维度无效', '按使用率或变化率分析时，必须同时选择“额度账户”维度，以避免把不同账户的百分比合并。'); return; }
            const quotaFilters = {};
            if (source === 'quota') {
              for (const [key, title, options] of [
                ['provider_id', '供应商筛选', [['', '全部供应商']]],
                ['account_id', '额度账户筛选', [['', '全部账户']]],
                ['kind', '额度类型筛选', [['', '全部类型'], ['balance', '余额额度'], ['window', '周期额度'], ['status', '查询状态']]],
                ['unit', '额度单位筛选', [['', '全部单位']]],
                ['window_key', '额度周期筛选', [['', '全部周期'], ['primary', '主窗口'], ['secondary', '次窗口'], ['daily', '每日'], ['weekly', '每周'], ['monthly', '每月'], ['five_hour', '5 小时'], ['seven_day', '7 天'], ['5h', '5 小时'], ['7d', '7 天']]],
                ['status', '查询状态筛选', [['', '全部状态'], ['success', '正常'], ['partial', '部分成功'], ['failed', '查询失败'], ['stale', '已过期']]],
              ]) {
                const defaults = options.map(([value, label]) => ({ label, value }));
                const quotaSnapshot = key === 'provider_id' || key === 'account_id' || key === 'unit' ? await ctx.api('/api/user/providers/quota') : null;
                const accounts = arrayOrEmpty(quotaSnapshot?.providers).flatMap(provider => arrayOrEmpty(provider.accounts || provider.keys).map(account => ({ ...account, provider_id: account.provider_id || provider.provider_id || provider.id, provider_name: account.provider_name || provider.provider_name || provider.name })));
                const dynamic = key === 'provider_id' ? [...new Map(accounts.map(item => [String(item.provider_id), [item.provider_id, item.provider_name]])).values()] : key === 'account_id' ? accounts.map(item => [item.account_id || item.id, item.label || item.name || item.account_id || item.id]) : key === 'unit' ? [...new Set(accounts.map(item => item.unit).filter(Boolean))].map(value => [value, value]) : [];
                const value = await ctx.choose(title, [...defaults, ...dynamic.filter(([id]) => id != null && !defaults.some(option => String(option.value) === String(id))).map(([value, label]) => ({ label: String(label), value: String(value) }))], { description: '只显示服务端当前快照返回的可选项；空值表示全部。' });
                if (value === null) return;
                if (value) quotaFilters[key] = value;
              }
            }
            let includeQuota = false;
            if (source !== 'quota') includeQuota = await ctx.choose('叠加供应商额度参照？', [{ label: '否，仅展示统计数据', value: false }, { label: '是，增加额度上下文', value: true }], { description: '请求成本与供应商上游账户额度是不同口径，不会相加。' });
            if (includeQuota === null) return;
            const query = { ...dateQuery, dimensions: [...selected].join(','), metric, data_source: source, ...(includeQuota ? { include_quota: 'true' } : {}), ...quotaFilters, ...filters };
            const result = await ctx.api('/api/user/stats/multi-dimension', { query });
            runtime.usageMultiQuery = { data_source: source, dimensions: [...selected], metric, include_quota: includeQuota === true };
            runtime.usageMultiResult = result;
            await ctx.refresh();
          } },
          { label: '清除多维分析结果', tab: 'multi', toolbar: 'page', disabled: !runtime.usageMultiQuery, run: async ctx => { runtime.usageMultiQuery = null; runtime.usageMultiResult = null; await ctx.refresh(); } },
          { label: '统计日期范围', tab: 'multi', toolbar: 'page', run: async ctx => { const value = await ctx.choose('多维分析日期范围', [...[7, 30, 90, 180, 365].map(days => ({ label: days === 365 ? '最近 1 年' : `最近 ${days} 天`, value: days })), { label: '自定义日期', value: 'custom' }]); if (value === null) return; if (value === 'custom') { const current = runtime.usageCustomRange || {}; const dates = await ctx.form('多维分析自定义日期', [{ name: 'start', label: '开始日期（YYYY-MM-DD）', value: current.start || '' }, { name: 'end', label: '结束日期（YYYY-MM-DD）', value: current.end || '' }]); if (!dates) return; const validDate = date => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(date || '')) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date; if (!validDate(dates.start) || !validDate(dates.end) || dates.start > dates.end || (Date.parse(`${dates.end}T00:00:00Z`) - Date.parse(`${dates.start}T00:00:00Z`)) / 86400000 > 364) { await ctx.show('日期范围无效', '请输入有效的起止日期，且开始日期不能晚于结束日期。'); return; } runtime.usageCustomRange = { start: dates.start, end: dates.end }; } else { runtime.usageDays = value; runtime.usageCustomRange = null; } runtime.usageMultiResult = null; await ctx.refresh(); } },
          { label: '查看实时活动快照', tab: 'overview', run: async ctx => { const window = await ctx.choose('活动统计窗口', [{ label: '最近 5 分钟', value: 300 }, { label: '最近 30 分钟', value: 1800 }, { label: '最近 1 小时', value: 3600 }]); if (window === null) return; const live = await api('/api/client-events/live', { query: { window } }); const sources = Array.isArray(live.sources) ? live.sources : []; const machines = Object.values(live.machines || {}); const lines = [`窗口 ${Math.round((live.window || window) / 60)} 分钟`, '', '按客户端：', ...sources.map(source => `${clientDisplay(source.harness)} · ${source.active_sessions || 0} 活跃会话 · ${source.tool_calls || 0} 工具调用 · ${source.failure_count || 0} 错误${source.suspected_offline ? ' · 疑似离线' : ''}`), '', '机器：', ...machines.map(machine => `${machine.name} · ${machine.harness} · ${machine.suspected_offline ? '疑似离线' : '在线'}`)]; if (!sources.length && !machines.length) lines.push('暂无近期客户端事件。'); await ctx.show('实时活动快照（一次性）', lines.join('\\n')); } },
          { label: '自定义日期范围', toolbar: 'page', run: async ctx => {
            const current = runtime.usageCustomRange || {};
            const values = await ctx.form('自定义统计日期', [
              { name: 'start', label: '开始日期（YYYY-MM-DD）', value: current.start || '' },
              { name: 'end', label: '结束日期（YYYY-MM-DD）', value: current.end || '' },
            ]);
            if (!values) return;
            const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
            if (!validDate(values.start) || !validDate(values.end) || values.start > values.end) { await ctx.show('日期范围无效', '请输入真实存在的 YYYY-MM-DD 日期，且开始日期不能晚于结束日期。'); return; }
            runtime.usageCustomRange = { start: values.start, end: values.end };
            runtime.usageLogPage = 1; await ctx.refresh();
          } },
          { label: '重置筛选与日期', toolbar: 'page', run: async ctx => { runtime.usageFilters = {}; runtime.usageCustomRange = null; runtime.usageDays = runtime.cfg.tui?.days || 30; runtime.usageLogPage = 1; await ctx.refresh(); } },
          { label: '时间范围与筛选', toolbar: 'page', run: async ctx => {
            const filtersData = await getStatsFilters(runtime.client);
            const pick = async (title, values, current, idKey = 'id') => {
              const getId = item => item[idKey] ?? item.id;
              const options = [{ label: '全部', value: '' }, ...values.map(item => ({ label: item.name || getId(item), value: getId(item) }))];
              const selected = values.find(item => String(getId(item)) === String(current));
              return ctx.choose(title, options, { description: `当前：${current ? selected?.name || current : '全部'}` });
            };
            const model_id = await pick('模型筛选', filtersData.models || [], filters.model_id || '', 'model_id'); if (model_id === null) return;
            const provider_id = await pick('供应商筛选', filtersData.providers || [], filters.provider_id || '', 'provider_id'); if (provider_id === null) return;
            const teams = Array.isArray(filtersData.teams) ? filtersData.teams : [];
            const team_id = await pick('Team 筛选', teams, filters.team_id || ''); if (team_id === null) return;
            const request_source = await pick('客户端筛选', filtersData.sources || [], filters.request_source || ''); if (request_source === null) return;
            runtime.usageFilters = Object.fromEntries(Object.entries({ model_id, provider_id, team_id, request_source, ...(filters.q ? { q: filters.q } : {}) }).filter(([, value]) => value !== ''));
            runtime.usageLogPage = 1; await ctx.refresh();
          } },
          { label: '筛选调用记录', tab: 'logs', toolbar: 'page', run: async ctx => {
            const current = runtime.usageLogFilters || {};
            const values = await ctx.form('调用记录筛选', [
              { name: 'model_q', label: '模型名称或模型 ID（可空）', value: current.model_q || '' },
              { name: 'request_type', label: '请求类型', value: current.request_type || '', options: [{ value: '', label: '全部类型' }, ...['chat', 'responses', 'fusion', 'playground', 'imagine', 'agent_manage', 'gemini', 'interactions'].map(value => ({ value, label: value }))] },
              { name: 'request_source', label: '客户端来源', value: current.request_source || '', options: [{ value: '', label: '全部客户端' }, ...['grok', 'codex', 'claude_code', 'opencode', 'qwen_code', 'hermes', 'openclaw', 'deepseek_harness', 'unknown'].map(value => ({ value, label: clientDisplay(value) }))] },
              { name: 'start_date', label: '开始日期（留空不筛选）', value: current.start_date || '' },
              { name: 'end_date', label: '结束日期（留空不筛选）', value: current.end_date || '' },
              { name: 'clear_dates', label: '清除日期范围', type: 'boolean', value: false },
            ], { description: '与网页调用记录筛选项相同；开始与结束日期需同时填写或同时留空。勾选“清除日期范围”会保留其他筛选。' });
            if (!values) return;
            if (values.clear_dates === true) { runtime.usageLogFilters = { ...(String(values.model_q || '').trim() ? { model_q: String(values.model_q).trim() } : {}), ...(values.request_type ? { request_type: values.request_type } : {}), ...(values.request_source ? { request_source: values.request_source } : {}) }; runtime.usageLogPage = 1; await ctx.refresh(); return; }
            const startDate = String(values.start_date || '').trim(); const endDate = String(values.end_date || '').trim();
            const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
            if (!!startDate !== !!endDate || (startDate && (!validDate(startDate) || !validDate(endDate) || startDate > endDate))) { await ctx.show('调用记录日期无效', '请输入真实存在的开始和结束日期；两者必须同时填写，且开始日期不得晚于结束日期。'); return; }
            runtime.usageLogFilters = { ...(String(values.model_q || '').trim() ? { model_q: String(values.model_q).trim() } : {}), ...(values.request_type ? { request_type: values.request_type } : {}), ...(values.request_source ? { request_source: values.request_source } : {}), ...(startDate ? { start_date: startDate, end_date: endDate } : {}) };
            runtime.usageLogPage = 1; await ctx.refresh();
          } },
          { label: '清除调用记录筛选', tab: 'logs', toolbar: 'page', disabled: !Object.keys(runtime.usageLogFilters || {}).length, run: async ctx => { runtime.usageLogFilters = {}; runtime.usageLogPage = 1; await ctx.refresh(); } },
          { label: '导出当前筛选 CSV', tab: 'logs', toolbar: 'page', run: async ctx => {
            const destination = String(await ctx.ask('CSV 文件保存路径', { defaultValue: path.resolve(process.cwd(), 'my-usage-logs.csv'), description: '将导出最多 50000 条；请输入绝对路径。若文件已存在，将再次确认后覆盖。' }) || '').trim();
            if (!destination) return;
            if (!path.isAbsolute(destination) || [...destination].some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; })) { await ctx.show('导出路径无效', '请提供不含控制字符的绝对文件路径。'); return; }
            const target = path.resolve(destination);
            let stat = null; try { stat = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (stat && (!stat.isFile() || stat.isSymbolicLink())) { await ctx.show('无法导出到此路径', '目标必须是普通文件；为避免覆盖目录或符号链接，已取消导出。'); return; }
            if (stat && !await ctx.confirm('覆盖已有 CSV 文件', `${target}\n现有文件将被 CSV 内容替换，是否继续？`)) return;
            if (!await ctx.confirm('导出调用记录', `将按当前筛选导出最多 50000 条记录到：\n${target}`)) return;
            const response = await runtime.client.get('/api/user/usage-logs/export', { query: { ...(runtime.usageLogFilters || {}), limit: 50000 }, raw: true, maxBytes: 64 * 1024 * 1024 });
            if (Number(response.statusCode || 0) < 200 || Number(response.statusCode || 0) >= 300) throw new Error(`CSV 导出失败（HTTP ${response.statusCode || '未知'}），未写入文件。`);
            const contentType = String(response.headers?.['content-type'] || '');
            if (!contentType.toLowerCase().includes('text/csv')) throw new Error('服务器未返回 CSV 文件，已取消写入。');
            const csv = String(response.text || '');
            if (!csv || csv.trimStart().startsWith('{')) throw new Error('服务器返回的 CSV 内容无效，已取消写入。');
            if (stat) await fs.writeFile(target, csv, { encoding: 'utf8', flag: 'w', mode: 0o600 });
            else { const handle = await fs.open(target, 'wx', 0o600); try { await handle.writeFile(csv, 'utf8'); } finally { await handle.close(); } }
            await fs.chmod(target, 0o600).catch(() => {});
            ctx.notify(`CSV 已导出到 ${target}`);
          } },

          { label: '搜索调用记录模型', tab: 'logs', toolbar: true, run: async ctx => { const value = await ctx.ask('搜索模型名称或上游模型 ID', { defaultValue: runtime.usageLogFilters?.model_q || '' }); if (value === null) return; runtime.usageLogFilters = { ...(runtime.usageLogFilters || {}), ...(String(value).trim() ? { model_q: String(value).trim() } : {}) }; if (!String(value).trim()) delete runtime.usageLogFilters.model_q; runtime.usageLogPage = 1; await ctx.refresh(); } },
          { label: '上一页调用记录', tab: 'logs', toolbar: 'page', disabled: (runtime.usageLogPage || 1) <= 1, run: async ctx => { runtime.usageLogPage = Math.max(1, (runtime.usageLogPage || 1) - 1); await ctx.refresh(); } },
          { label: '下一页调用记录', tab: 'logs', toolbar: 'page', disabled: (runtime.usageLogPage || 1) >= Math.max(1, Math.ceil(Number(runtime.usageLogTotal || 0) / 50)), run: async ctx => { runtime.usageLogPage = Math.min(Math.max(1, Math.ceil(Number(runtime.usageLogTotal || 0) / 50)), (runtime.usageLogPage || 1) + 1); await ctx.refresh(); } },
          ...[7, 30, 90, 180, 365].map(days => ({ label: `最近 ${days} 天`, toolbar: true, run: async ctx => { runtime.usageDays = days; runtime.usageCustomRange = null; runtime.usageLogPage = 1; await ctx.refresh(); } })),
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

function clientDisplay(value) {
  const key = String(value || '').toLowerCase();
  return ({ claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok', qwen_code: 'Qwen Code', deepseek_harness: 'DeepSeek Harness', unknown: '未知客户端' })[key] || (value || '未知客户端');
}

async function showSessionMessages(ctx, runtime, item) {
  let cursor = null;
  let page = 1;
  while (true) {
    const data = await getSessionMessages(runtime.client, item.sessionKey, { page, pageSize: 40, ...(cursor || {}) });
    const records = Array.isArray(data.records) ? data.records : [];
    const lines = [
      `会话标识：${item.sessionKey}`,
      `客户端类型：${clientDisplay(item.harness)}`,
      `请求数：${item.requestCount || 0} · Token 用量：${formatBigNumber(item.totalTokens)} · 工具调用数：${item.toolCallCount || 0}`,
      `首次活动：${formatTime(item.firstSeen)} · 最近活动：${formatTime(item.lastSeen)}`,
      item.summary ? `已生成摘要：${text(item.summary)}` : '尚未生成会话摘要。',
      '',
      `当前页：${page} · 本页 ${records.length} 条消息 · 共 ${data.total || item.requestCount || 0} 条`,
    ];
    for (const record of records) {
      const recordTime = formatTime(record.ts || record.created_at || record.time);
      const model = record.model || record.model_name || record.model_id || record.resolved_model || '未知模型';
      lines.push('', `${recordTime} · ${model} · ${formatBigNumber(record.tokens || record.tokens_used || 0)} Token${record.cachedTokens ? ` · 缓存 ${formatBigNumber(record.cachedTokens)} Token` : ''}${record.latencyMs != null ? ` · 响应时间 ${record.latencyMs} 毫秒` : ''}`);
      for (const event of Array.isArray(record.events) ? record.events : []) {
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'text' && event.text) {
          lines.push(`${event.role === 'user' ? '用户' : event.role === 'assistant' ? '模型回复' : '系统信息'}：${String(event.text).slice(0, 2000)}`);
          const imageAttachments = arrayOrEmpty(event.attachments).filter(attachment => attachment && attachment.kind === 'image');
          if (imageAttachments.length) lines.push(`包含 ${imageAttachments.length} 个图片附件（终端不可内嵌显示，请在网页会话详情查看）。`);
        } else if (event.type === 'thinking' && event.preview) lines.push(`思考摘要：${String(event.preview).slice(0, 300)}`);
        else if (event.type === 'tool_call') lines.push(`调用工具：${event.name || '未知工具'}${event.argsPreview ? ` · 参数摘要 ${String(event.argsPreview).slice(0, 500)}` : ''}`);
        else if (event.type === 'tool_result') lines.push(`${event.is_error ? '工具执行失败' : '工具返回'}${event.name ? ` · ${event.name}` : ''}：${String(event.resultPreview || '无详细内容').slice(0, 800)}`);
        else if (event.type === 'subagent' || event.type === 'compact' || event.type === 'session_start' || event.type === 'session_end') lines.push(`会话事件：${event.text || event.type}`);
        else if (event.type === 'image') lines.push('包含图片附件（请在网页会话详情中查看）。');
        else if (event.type) lines.push(`其他消息事件：${String(event.type)}`);
      }
      if (record.eventsTruncated) lines.push('本条消息中的旧上下文事件已折叠。');
    }
    if (!records.length) lines.push('没有可显示的消息记录。');
    await ctx.show(`会话时间线 · 第 ${page} 页`, lines.join('\n'));
    if (!data.nextCursor) break;
    const choice = await ctx.choose('会话时间线', [{ label: '查看更早消息', value: 'more' }, { label: '关闭', value: 'close' }], { description: `还有更早消息 · 已读取 ${records.length} 条` });
    if (choice !== 'more') break;
    cursor = data.nextCursor;
    page++;
  }
}

function sessionsPage(runtime) {
  if (!runtime.sessionsPageNumber) runtime.sessionsPageNumber = 1;
  if (!runtime.sessionsDays) runtime.sessionsDays = 7;
  return {
    id: 'sessions',
    label: '会话',
    description: '查看最近 1 天或 7 天的会话列表，可按客户端来源筛选、搜索经过网关的消息与回复。',
    async load(api) {
      const days = runtime.sessionsDays || 7;
      const search = runtime.sessionsSearch || '';
      const source = runtime.sessionsSource || '';
      const data = search
        ? await searchSessions(runtime.client, { q: search, days: 7 })
        : await listSessions(runtime.client, { days, page: runtime.sessionsPageNumber, pageSize: 20, source });
      const items = search
        ? (Array.isArray(data.results) ? data.results : [])
        : (Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []));
      const rows = items.map(item => ({
        label: search
          ? `${clientDisplay(item.harness)} · ${item.sessionKey || '未知会话'} · ${Number(item.matchCount || 0).toLocaleString()} 条匹配消息`
          : `${clientDisplay(item.harness)} · ${item.sessionKey || '未知会话'}`,
        detail: search
          ? [`命中时间：${item.firstSeen ? formatTime(item.firstSeen) : '未知'} 至 ${item.lastSeen ? formatTime(item.lastSeen) : '未知'} · 最多展示 3 条命中摘录`, ...arrayOrEmpty(item.previews).slice(0, 3).map(preview => `${formatTime(preview.ts)} · ${String(preview.excerpt || '').replace(/<<<MARK>>>(.*?)<<<END>>>/g, '【命中：$1】')}`)].join('\\n')
          : [
            item.cwd && `工作区：${item.cwd}`,
            item.summary ? `会话摘要：${String(item.summary).split(/[。.!！？?\\n]/)[0].slice(0, 60)}` : item.lastMessagePreview ? `最近消息：${String(item.lastMessagePreview).split(/[。.!！？?\\n]/)[0].slice(0, 60)}` : '',
            `活动时间：${item.firstSeen ? formatTime(item.firstSeen) : '未知'} 至 ${item.lastSeen ? formatTime(item.lastSeen) : '未知'}`,
            `${Number(item.requestCount || 0).toLocaleString()} 次请求 · ${Number(item.toolCallCount || 0).toLocaleString()} 次工具调用${item.lastToolName ? ` · 最近工具 ${item.lastToolName}` : ''}`,
            `总 Token：${formatBigNumber(item.totalTokens)} · 缓存命中：${formatBigNumber(item.totalCachedTokens)}`,
            item.models?.length ? `模型：${item.models.slice(0, 3).join('、')}` : '',
            item.summaryCreatedAt && `摘要更新：${formatTime(item.summaryCreatedAt)}`,
            item.pressureLevel === 'critical' ? '上下文压力：高（接近容量上限）' : item.pressureLevel === 'warning' ? '上下文压力：注意' : '',
          ].filter(Boolean).join('\\n'),
        run: async ctx => {
          const choice = await ctx.choose(`会话 · ${item.sessionKey}`, [{ label: '查看消息', value: 'messages' }, { label: '查看已缓存摘要', value: 'summary' }]);
          if (choice === 'messages') await showSessionMessages(ctx, runtime, item);
          if (choice === 'summary') { const cached = await runtime.client.get(`/api/user/sessions/${encodeURIComponent(item.sessionKey)}/summary`); if (cached.summary) await ctx.show('会话摘要', `${cached.summary}\n\n更新时间：${formatTime(cached.createdAt)}`); else await ctx.show('暂无会话摘要', '摘要生成需要流式 SSE 和模型调用。请在网页会话详情中生成摘要后回到此处查看。'); }
        },
      }));
      return {
        sections: [{
          title: '会话',
          description: search ? `最近 7 天 · 搜索“${search}” · 共 ${data.totalSessions ?? items.length} 个匹配会话（最多显示 20 个）` : `最近 ${days} 天 · 第 ${data.page || runtime.sessionsPageNumber} / ${Math.ceil(Number(data.total || items.length) / Number(data.pageSize || 20)) || 1} 页 · 共 ${data.total || items.length} 个会话`,
          rows: rows.length ? rows : [{ label: '暂无会话记录。' }],
        }],
        pageToolbar: true,
        actions: [
          { label: search ? '清除搜索' : '搜索会话内容', toolbar: 'page', run: async ctx => { runtime.sessionsSearch = search ? '' : String(await ctx.ask('搜索经由网关的消息全文或模型回复', { defaultValue: runtime.sessionsSearch || '' }) || '').trim(); runtime.sessionsPageNumber = 1; await ctx.refresh(); } },
          ...(!search ? [
            { label: '筛选客户端', toolbar: 'page', run: async ctx => { const value = await ctx.choose('客户端来源', [{ label: '全部客户端', value: '' }, ...['grok', 'codex', 'claude_code', 'opencode', 'qwen_code', 'hermes', 'openclaw', 'deepseek_harness', 'unknown'].map(item => ({ label: clientDisplay(item), value: item }))]); if (value !== null) { runtime.sessionsSource = value; runtime.sessionsPageNumber = 1; await ctx.refresh(); } } },
            ...[1, 7].map(value => ({ label: `最近 ${value} 天`, toolbar: 'page', run: async ctx => { runtime.sessionsDays = value; runtime.sessionsPageNumber = 1; await ctx.refresh(); } })),
            { label: '上一页', toolbar: 'page', disabled: (runtime.sessionsPageNumber || 1) <= 1, run: async ctx => { runtime.sessionsPageNumber = Math.max(1, (runtime.sessionsPageNumber || 1) - 1); await ctx.refresh(); } },
            { label: '下一页', toolbar: 'page', disabled: (runtime.sessionsPageNumber || 1) * 20 >= Number(data.total || 0), run: async ctx => { runtime.sessionsPageNumber = (runtime.sessionsPageNumber || 1) + 1; await ctx.refresh(); } },
          ] : []),
          { label: '刷新', toolbar: true, run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

module.exports = { usagePage, sessionsPage };
