(function () {
  const dimensions = {
    user: '成员', team: 'Team', project: '项目', source: '客户端', model: '模型', provider: '供应商', key: '平台 API Key', account: '额度账户', kind: '额度类型', unit: '单位', window: '窗口', date: '日期'
  };
  const metrics = { requests: '请求数', tokens: 'Token', cost: '积分', remaining: '剩余额度', used: '已用', total: '总额度', used_percent: '窗口使用率', observed_consumption: '观测消耗', percent_change: '使用率变化（百分点）' };
  const tr = key => window.I18N?.t(key) || key;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const destroy = id => { (instances.get(id) || []).forEach(chart => chart.destroy()); instances.delete(id); };
  const instances = new Map();
  const selections = new WeakMap();
  const sourceKey = value => ({ usage: 'requests', association: 'related', provider_quota: 'quota' })[value] || value || 'requests';
  const checked = el => typeof el.checked === 'boolean' ? el.checked : el.hasAttribute('checked');
  const chosenDimensions = group => [...new Set([...group.querySelectorAll('blora-checkbox')].filter(checked).map(el => el.getAttribute('value')))];
  function activeSelection(root) {
    const state = selections.get(root);
    return chosenDimensions(state.groups.requests);
  }
  function displayLabel(key, value) {
    if (value === '__unknown__') return tr('未识别项目');
    if (key === 'source') return tr(({ grok: 'Grok', codex: 'Codex', claude_code: 'Claude Code', opencode: 'OpenCode', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw', deepseek_harness: 'DeepSeek Harness', unknown: '未知/其他' })[value] || value || '未知/其他');
    if (key === 'kind') return tr(({ balance: '余额', window: '使用率窗口', status: '查询状态' })[value] || value || '未知');
    if (key === 'window') return tr(({ primary: '主窗口', secondary: '次窗口', daily: '每日', weekly: '每周', monthly: '每月', five_hour: '5 小时', seven_day: '7 天', 'account-primary': '账户主要额度', 'account-secondary': '账户次要额度', '5h': '5 小时', '7d': '7 天' })[value] || value || '无窗口');
    if (key === 'unit' && value === 'percent') return '%';
    return value || tr('未知');
  }

  function render(targetId, result) {
    const container = document.getElementById(targetId);
    if (!container) return;
    destroy(targetId);
    const rows = result.rows || [];
    container.innerHTML = '';
    const quota = result.data_source === 'quota';
    if (!rows.length && !result.provider_quota?.accounts?.length) {
      container.innerHTML = '<p class="stats-insight-empty">当前条件下暂无数据</p>';
      return;
    }
    const format = row => { const value = quota ? row.value : row[result.metric]; return value == null ? tr('未知') : Number(value).toLocaleString(undefined, {maximumFractionDigits: quota ? (['used_percent', 'percent_change'].includes(result.metric) ? 0 : 2) : (result.metric === 'cost' ? 4 : 0)}) + (quota ? ' ' + (['used_percent','percent_change'].includes(result.metric) ? (result.metric === 'percent_change' ? tr('百分点') : '%') : row.unit || tr('未知单位')) : ''); };
    const names = rows.map(row => (row.labels || []).map((label, index) => displayLabel(result.dimensions[index], label)).join(' / '));
    container.innerHTML = `<div class="multi-dimension-table-wrap"><table><thead><tr><th>${escape(result.dimensions.map(key => tr(dimensions[key] || key)).join(' / '))}</th><th>${escape(tr(metrics[result.metric]))}</th><th>${escape(tr('数据质量'))}</th></tr></thead><tbody>${rows.map((row,i) => `<tr><td>${escape(names[i])}</td><td>${escape(format(row))}</td><td>${escape(tr(({reset:'周期重置',gap:'采样缺口',backfill:'历史回补',adjustment:'额度调整',initial:'首次观测',window_change:'窗口变化',observed_consumption:'观测消耗',success:'正常',partial:'部分成功',failed:'查询失败'})[row.quality?.last_event || row.quality?.event || row.status] || '—'))}</td></tr>`).join('')}</tbody></table></div>`;
    if (!window.Chart) return;
    const quotaRows = (result.provider_quota?.accounts || []).filter(row => row.kind !== 'status').map(row => {
      const unit = row.unit || tr('未知单位');
      const value = row.kind === 'window' || unit === 'percent' ? row.used_percent : row.remaining;
      return { row, unit, value: value == null || !Number.isFinite(Number(value)) ? null : Number(value) };
    }).filter(item => item.value !== null);
    const units = [...new Set(quotaRows.map(item => item.unit))];
    if (!rows.length && units.length) {
      const empty = document.createElement('p');
      empty.className = 'stats-insight-empty';
      empty.textContent = tr('当前条件下暂无请求用量；下方仅显示供应商额度参照');
      container.prepend(empty);
    }
    const requestPoints = rows.map((row, index) => ({ label: names[index], value: Number(row[quota ? 'value' : result.metric]), source: 'usage' }));
    const quotaPoints = quotaRows.map(({ row, unit, value }) => ({
      label: `${row.provider_name || tr('供应商')} / ${row.label || tr('额度账户')}${row.window_key ? ` / ${displayLabel('window', row.window_key)}` : ''}`,
      value, unit, source: 'quota'
    }));
    const points = [...requestPoints, ...quotaPoints];
    const charts = [];
    const box = document.createElement('div'); box.className = 'multi-dimension-chart-container';
    const canvas = document.createElement('canvas');
    if (quotaPoints.length) canvas.setAttribute('aria-label', `${tr('请求用量与供应商额度参照')}：${tr('额度关联上下文')}；${points.map(point => point.label).join('、')}`);
    box.append(canvas);
    container.append(box);
    const datasets = [
      { label: tr(metrics[result.metric]), data: points.map(point => point.source === 'usage' ? point.value : null), backgroundColor: '#14b8a6', borderRadius: 5, xAxisID: 'xUsage' },
      ...units.map((unit, index) => ({
        label: `${tr(unit === 'percent' ? '供应商窗口使用率' : '供应商剩余额度')} · ${displayLabel('unit', unit)}`,
        data: points.map(point => point.source === 'quota' && point.unit === unit ? point.value : null),
        backgroundColor: ['#a855f7', '#f97316', '#3b82f6', '#eab308'][index % 4], borderRadius: 5, xAxisID: `xQuota${index}`
      }))
    ];
    const scales = { xUsage: { type: 'linear', position: 'bottom', beginAtZero: true, title: { display: true, text: tr(metrics[result.metric]) } }, y: { ticks: { autoSkip: false } } };
    if (!rows.length) scales.y.display = false;
    units.forEach((unit, index) => {
      scales[`xQuota${index}`] = { type: 'linear', position: 'top', beginAtZero: true, display: index === 0, title: { display: index === 0, text: `${tr('供应商额度')} · ${units.map(value => displayLabel('unit', value)).join(' / ')}` } };
    });
    charts.push(new Chart(canvas, {
      type: 'bar', data: { labels: points.map(point => point.label), datasets },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: units.length > 0 }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${Number(context.raw).toLocaleString()}${context.dataset.xAxisID.startsWith('xQuota') ? ` ${displayLabel('unit', points[context.dataIndex]?.unit)}` : ''}` } } },
        scales
      }
    }));
    instances.set(targetId, charts);
  }

  async function load(scope) {
    const prefix = scope === 'admin' ? 'admin' : 'user';
    const root = document.getElementById(`${prefix}MultiDimension`);
    if (!root) return;
    init();
    const status = root.querySelector('.multi-dimension-status');
    const includeQuota = checked(selections.get(root).quotaToggle);
    const source = 'requests';
    const quotaRoot = document.querySelector(`[data-quota-scope="${scope}"][data-quota-context="multi"]`);
    if (quotaRoot) quotaRoot.hidden = true;
    const isQuota = source === 'quota';
    const chosen = activeSelection(root, source);
    const targetId = `${prefix}MultiDimensionResult`;
    const seq = Number(root.dataset.requestSeq || 0) + 1;
    root.dataset.requestSeq = seq;
    destroy(targetId);
    document.getElementById(targetId).replaceChildren();
    if (!chosen.length) {
      status.textContent = '请至少选择一个维度';
      return;
    }
    status.textContent = '正在加载...';
    try {
      const params = new URLSearchParams({
        dimensions: chosen.join(','), metric: root.querySelector(isQuota ? '[name="quota_metric"]' : '[name="metric"]').value, data_source: 'usage', include_quota: String(includeQuota),
        days: scope === 'admin' ? (document.getElementById('adminStatsDays')?.value || '30') : (document.getElementById('statsTimeRange')?.value || '30')
      });
      if (scope === 'user' && params.get('days') === 'custom') {
        const start = document.getElementById('statsStartDate')?.value;
        const end = document.getElementById('statsEndDate')?.value;
        if (!start || !end) {
          status.textContent = '请选择自定义时间范围';
          return;
        }
        params.delete('days');
        params.set('start', start);
        params.set('end', end);
      }
      const filters = scope === 'admin' ? {user_id:'multiStatsUser',team_id:'multiStatsTeam',model_id:'multiStatsModel',provider_id:'multiStatsProvider',request_source:'multiStatsSource',workspace_path:'multiStatsProject'} : {model_id:'statsModelFilter',provider_id:'statsProviderFilter',request_source:'statsSourceFilter'};
      Object.entries(filters).forEach(([key,id]) => {const value=document.getElementById(id)?.value;if(value)params.set(key,value);});
      if (isQuota) {
        const panel = document.querySelector(`[data-quota-scope="${scope}"][data-quota-context="multi"]`);
        ['provider_id','account_id','unit','window_key','status'].forEach(key=>{const value=panel?.querySelector(`[name="${key}"]`)?.value;if(value)params.set(key,value);});
      }
      const response = await fetch(`/api/${scope}/stats/multi-dimension?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载失败');
      if (Number(root.dataset.requestSeq) !== seq) return;
      status.textContent = isQuota ? `展示 ${data.rows.length} 个额度组合` : `展示 ${data.rows.length} 个组合（最多 30 个）${includeQuota ? '，额度按供应商账户作为参照，不分摊到个人' : ''}`;
      render(targetId, data);
    } catch (error) {
      if (Number(root.dataset.requestSeq) === seq) {
        destroy(targetId);
        document.getElementById(targetId).replaceChildren();
        status.textContent = error.message || '加载失败';
      }
    }
  }

  function init() {
    for (const scope of ['admin', 'user']) {
      const root = document.getElementById(`${scope}MultiDimension`);
      if (!root || root.dataset.autoLoadBound) continue;
      root.dataset.autoLoadBound = 'true';
      const quotaRoot = document.querySelector(`[data-quota-scope="${scope}"][data-quota-context="multi"]`);
      if (quotaRoot && quotaRoot.parentElement !== root) root.append(quotaRoot);
      const usageChoices = root.querySelector('.multi-dimension-choices:not(.quota-dimension-choices)');
      usageChoices.dataset.dimensionGroup = 'usage';
      const choices = document.createElement('div'); choices.className = 'quota-dimension-choices multi-dimension-choices'; choices.hidden = true;
      choices.dataset.dimensionGroup = 'quota';
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', tr('额度维度'));
      choices.innerHTML = ['provider','account','kind','unit','window','date'].map(key => `<blora-checkbox value="${key}" label="${escape(tr(dimensions[key]))}" aria-label="${escape(tr(dimensions[key]))}" ${['provider','account'].includes(key)?'checked':''}></blora-checkbox>`).join('');
      usageChoices.after(choices);
      const dimensionRow = document.createElement('div'); dimensionRow.className = 'multi-dimension-row';
      usageChoices.before(dimensionRow); dimensionRow.append(usageChoices);
      const quotaToggle = document.createElement('blora-checkbox');
      quotaToggle.setAttribute('value', 'provider_quota'); quotaToggle.setAttribute('label', tr('供应商额度'));
      quotaToggle.setAttribute('aria-label', tr('供应商额度')); quotaToggle.setAttribute('data-quota-dimension', '');
      dimensionRow.append(quotaToggle);
      const label = document.createElement('label');label.hidden=true;
      label.innerHTML = `${escape(tr('额度指标'))} <blora-select name="quota_metric" value="remaining" aria-label="${escape(tr('额度指标'))}">${['remaining','used','total','used_percent','observed_consumption','percent_change'].map(key=>`<blora-option value="${key}">${escape(tr(metrics[key]))}</blora-option>`).join('')}</blora-select>`;
      const actions = root.querySelector('.multi-dimension-actions');
      actions.querySelector('[name="metric"]').closest('label').after(label);
      dimensionRow.before(actions);
      actions.querySelector('[name="data_source"]').closest('label').hidden = true;
      const heading = document.createElement('p'); heading.textContent = tr('分析维度');
      actions.after(heading);
      usageChoices.querySelectorAll('blora-checkbox').forEach(el => el.setAttribute('aria-label', el.getAttribute('label') || tr(dimensions[el.getAttribute('value')])));
      const usageMetric = actions.querySelector('[name="metric"]');
      const quotaMetric = actions.querySelector('[name="quota_metric"]');
      selections.set(root, {
        quotaToggle,
        source: sourceKey(actions.querySelector('[name="data_source"]').value),
        groups: { requests: usageChoices, related: usageChoices, quota: choices },
        metrics: { requests: usageMetric, related: usageMetric, quota: quotaMetric },
        values: {
          requests: { dimensions: chosenDimensions(usageChoices), metric: usageMetric.value },
          related: { dimensions: chosenDimensions(usageChoices), metric: usageMetric.value },
          quota: { dimensions: chosenDimensions(choices), metric: quotaMetric.value }
        }
      });
      root.addEventListener('change', event => {
        if (event.target.closest('blora-checkbox, blora-select[name="metric"], blora-select[name="data_source"], blora-select[name="quota_metric"]')) load(scope);
      });
    }
  }

  window.CrewRouterMultiDimension = { load, init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
