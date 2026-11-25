'use strict';

const { getStats, getStatsFilters, getLatencyStats, getMessageStats, getUsageLogs, statsSummary, listSessions, getSessionMessages, searchSessions } = require('../lib/api');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');
const { text } = require('./pages-common');

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
      { id: 'daily', label: '每日' },
      { id: 'hourly', label: '小时' },
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
      if (runtime.usageTab === 'providers') sections.push({ title: '按供应商统计', tab: 'providers', toolbar: true, tableMinWidth: 112, columns: dimensionColumns, rows: dimensionRows(summary.byProvider || [], row => row.provider_name || row.provider_id || '未知供应商') });
      if (runtime.usageTab === 'keys') sections.push({ title: '按 API Key 统计', tab: 'keys', toolbar: true, tableMinWidth: 112, columns: dimensionColumns, rows: dimensionRows(summary.byApiKey || [], row => row.key_name || row.key_prefix || '未知 API Key') });
      if (runtime.usageTab === 'sources') sections.push({ title: '按客户端统计', tab: 'sources', toolbar: true, tableMinWidth: 112, columns: dimensionColumns, rows: dimensionRows(summary.bySource || [], row => clientDisplay(row.request_source)) });
      if (runtime.usageTab === 'latency') {
        const latency = await getLatencyStats(runtime.client, { ...dateQuery, ...filters });
        sections.push({ title: '响应速度与首字延迟', tab: 'latency', toolbar: true, cards: [
          { label: '请求中位延迟（P50）', value: text(latency.p50_ms, '—'), detail: '一半请求不超过此耗时 · 毫秒' },
          { label: '请求95%分位延迟（P95）', value: text(latency.p95_ms, '—'), detail: '95% 请求不超过此耗时 · 毫秒' },
          { label: '请求99%分位延迟（P99）', value: text(latency.p99_ms, '—'), detail: '99% 请求不超过此耗时 · 毫秒' },
          { label: '请求总数', value: text(latency.total_requests, '0'), detail: '当前筛选范围' },
        ], rows: (latency.daily || []).map(row => ({ label: `${row.date} · ${row.requests || 0} 次请求 · 95%请求延迟 ${row.p95_ms || 0} 毫秒 · 输出速度 ${row.tokens_per_second || 0} Token/秒` })) });
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
        const summaryCards = Object.entries(messageStats.summary || {}).filter(([key]) => key !== 'analysis_status').map(([key, value]) => {
          const label = summaryLabels[key] || key.replace(/_/g, ' ');
          if (key === 'peak_day' && value && typeof value === 'object') return { label: '请求最多日期', value: `${value.date || '未知'} · ${value.requests || 0} 次请求` };
          if (key.endsWith('_rate') && Number.isFinite(Number(value))) return { label, value: `${(Number(value) * 100).toFixed(1)}%` };
          if (['total_tokens', 'avg_daily_tokens'].includes(key)) return { label, value: `${formatBigNumber(value)} Token` };
          if (['total_cost'].includes(key)) return { label, value: `${formatCost(value)} 积分` };
          if (['total_characters', 'avg_characters'].includes(key)) return { label, value: `${formatBigNumber(value)} 字符` };
          if (typeof value === 'boolean') return { label, value: value ? '是' : '否' };
          if (typeof value === 'object' && value !== null) return { label, value: JSON.stringify(value) };
          return { label, value: text(value) };
        });
        const blockRows = Array.isArray(messageStats.by_block) ? messageStats.by_block.map(item => ({ label: item.block || '未知区块', detail: `${Number(item.requests || 0).toLocaleString()} 次请求 · 出现 ${Number(item.occurrences || 0).toLocaleString()} 次 · ${formatBigNumber(item.tokens)} Token · ${formatCost(item.cost)} 积分` })) : Object.entries(messageStats.blocks || {}).map(([name, count]) => ({ label: name.replace(/_/g, ' '), detail: `${count} 次` }));
        const sourceRows = Array.isArray(messageStats.by_source) ? messageStats.by_source.map(item => ({ label: clientDisplay(item.request_source), detail: `${Number(item.requests || 0).toLocaleString()} 次请求 · 平均 ${(Number(item.messages || 0) / Math.max(Number(item.requests || 0), 1)).toFixed(1)} 条消息 · 平均 ${Math.round(Number(item.characters || 0) / Math.max(Number(item.requests || 0), 1)).toLocaleString()} 字符 · ${formatBigNumber(item.tokens)} Token` })) : [];
        const workspaceRows = Array.isArray(messageStats.by_workspace) ? messageStats.by_workspace.slice(0, 50).map(item => ({ label: item.workspace_path || '未识别项目', detail: `${Number(item.requests || 0).toLocaleString()} 次活跃请求 · ${formatBigNumber(item.tokens)} Token · ${formatCost(item.cost)} 积分 · ${Math.round(Number(item.characters || 0)).toLocaleString()} 字符${item.sources ? ` · 客户端 ${Object.keys(item.sources).map(clientDisplay).join('、')}` : ''}` })) : [];
        const dailyRows = Array.isArray(messageStats.daily) ? messageStats.daily.map(item => ({ label: `每日活动：${item.date || '未知日期'}`, detail: `${Number(item.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(item.tokens)} Token · ${Number(item.messages || 0).toLocaleString()} 条消息${item.git_requests != null ? ` · 含 Git 状态 ${item.git_requests} 次` : ''}` })) : [];
        const pendingRows = Number(analysisStatus.pending_requests || 0) > 0 ? [{ label: `后台待分析：${Number(analysisStatus.pending_requests).toLocaleString()} 个请求`, detail: '这些请求尚未完成消息结构扫描。' }] : [];
        const analysisNote = analysisStatus.enabled === false ? '消息分析功能当前未启用。' : analysisStatus.last_error ? `最近一次后台分析异常：${analysisStatus.last_error}` : '读取请求中的消息内容进行结构分析，不用于推断未出现的区块。';
        sections.push({ title: '消息结构分析', tab: 'messages', toolbar: true, description: `${summaryCards.length} 项汇总 · 数据按当前时间范围和筛选条件统计 · ${analysisNote}`, cards: summaryCards, rows: [...pendingRows, ...workspaceRows, ...dailyRows, ...blockRows, ...sourceRows] });
      }
      if (runtime.usageTab === 'logs') {
        const logs = await getUsageLogs(runtime.client, { page: runtime.usageLogPage || 1, limit: 20, ...(runtime.usageLogFilters || {}) });
        runtime.usageLogTotal = Number(logs.total || 0);
        const items = Array.isArray(logs.logs) ? logs.logs : Array.isArray(logs.items) ? logs.items : [];
        sections.push({ title: '调用记录', tab: 'logs', toolbar: true, tableMinWidth: 124, columns: [
          { key: 'time', label: '时间', ratio: 0.17 }, { key: 'model', label: '模型', ratio: 0.17 }, { key: 'series', label: '系列', ratio: 0.09 },
          { key: 'source', label: '客户端', ratio: 0.13 }, { key: 'key', label: 'API Key', ratio: 0.14 }, { key: 'tokens', label: 'Token', ratio: 0.1 },
          { key: 'cached', label: '缓存命中', ratio: 0.1 }, { key: 'cost', label: '积分', ratio: 0.1 },
        ], description: `第 ${logs.page || runtime.usageLogPage || 1} 页 · 共 ${logs.total || 0} 条`, rows: items.map(item => ({ label: formatTime(item.created_at), cells: {
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
          { label: '筛选调用记录', tab: 'logs', toolbar: true, run: async ctx => {
            const current = runtime.usageLogFilters || {};
            const model_q = await ctx.ask('模型名称或模型 ID（留空不过滤）', { defaultValue: current.model_q || '' }); if (model_q === null) return;
            const requestType = await ctx.choose('请求类型', [{ label: '全部类型', value: '' }, ...['chat', 'responses', 'fusion', 'playground', 'imagine', 'agent_manage', 'gemini', 'interactions'].map(value => ({ label: value, value }))]); if (requestType === null) return;
            const requestSource = await ctx.choose('客户端来源', [{ label: '全部客户端', value: '' }, ...['grok', 'codex', 'claude_code', 'opencode', 'qwen_code', 'hermes', 'openclaw', 'deepseek_harness', 'unknown'].map(value => ({ label: clientDisplay(value), value }))]); if (requestSource === null) return;
            const dateRange = await ctx.choose('调用记录日期', [{ label: '不限制日期', value: 'keep' }, { label: '设置自定义起止日期', value: 'custom' }, { label: '清除日期筛选', value: 'clear' }]); if (dateRange === null) return;
            const next = { ...(model_q.trim() ? { model_q: model_q.trim() } : {}), ...(requestType ? { request_type: requestType } : {}), ...(requestSource ? { request_source: requestSource } : {}) };
            if (dateRange === 'custom') {
              const values = await ctx.form('调用记录日期范围', [{ name: 'start_date', label: '开始日期（YYYY-MM-DD）', value: current.start_date || '' }, { name: 'end_date', label: '结束日期（YYYY-MM-DD）', value: current.end_date || '' }]);
              if (!values) return;
              const validDate = value => typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
              if (!validDate(values.start_date) || !validDate(values.end_date) || values.start_date > values.end_date) { await ctx.show('调用记录日期无效', '请输入真实存在的日期，且开始日期不得晚于结束日期。'); return; }
              next.start_date = values.start_date; next.end_date = values.end_date;
            } else if (dateRange === 'keep') {
              if (current.start_date) next.start_date = current.start_date;
              if (current.end_date) next.end_date = current.end_date;
            }
            runtime.usageLogFilters = next; runtime.usageLogPage = 1; await ctx.refresh();
          } },
          { label: '搜索调用记录模型', tab: 'logs', toolbar: true, run: async ctx => { const value = await ctx.ask('搜索模型名称或上游模型 ID', { defaultValue: runtime.usageLogFilters?.model_q || '' }); if (value === null) return; runtime.usageLogFilters = { ...(runtime.usageLogFilters || {}), ...(String(value).trim() ? { model_q: String(value).trim() } : {}) }; if (!String(value).trim()) delete runtime.usageLogFilters.model_q; runtime.usageLogPage = 1; await ctx.refresh(); } },
          { label: '上一页调用记录', tab: 'logs', toolbar: true, disabled: (runtime.usageLogPage || 1) <= 1, run: async ctx => { runtime.usageLogPage = Math.max(1, (runtime.usageLogPage || 1) - 1); await ctx.refresh(); } },
          { label: '下一页调用记录', tab: 'logs', toolbar: true, disabled: (runtime.usageLogPage || 1) * 20 >= Number(runtime.usageLogTotal || 0), run: async ctx => { runtime.usageLogPage = (runtime.usageLogPage || 1) + 1; await ctx.refresh(); } },
          { label: '导出当前筛选 CSV', tab: 'logs', toolbar: true, run: async ctx => { await ctx.show('CSV 导出不可用', '网页支持下载 CSV；CLI 当前 API 客户端不支持接收二进制响应并写入文件。请在网页调用记录页使用“导出 CSV”。'); } },
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
          ? [`最近匹配：${item.lastSeen ? formatTime(item.lastSeen) : '未知'} · 最多展示 3 条命中摘录`, ...arrayOrEmpty(item.previews).slice(0, 3).map(preview => `${formatTime(preview.ts)} · ${String(preview.excerpt || '').replace(/<<<MARK>>>(.*?)<<<END>>>/g, '【命中：$1】')}`)].join('\\n')
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
