(function () {
  const dimensions = {
    user: '成员', team: 'Team', project: '项目', source: '客户端', model: '模型', provider: '供应商', key: '平台 API Key', account: '额度账户', kind: '额度类型', unit: '单位', window: '窗口', date: '日期'
  };
  const metrics = { requests: '请求数', tokens: 'Token', cost: '积分', remaining: '剩余额度', used: '已用', total: '总额度', used_percent: '窗口使用率', observed_consumption: '观测消耗', percent_change: '使用率变化（百分点）' };
  const tr = key => window.I18N?.t(key) || key;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const destroy = id => { (instances.get(id) || []).forEach(chart => chart.destroy()); instances.delete(id); };
  const instances = new Map();

  function render(targetId, result) {
    const container = document.getElementById(targetId);
    if (!container) return;
    destroy(targetId);
    const rows = result.rows || [];
    if (!rows.length) {
      container.innerHTML = '<p class="stats-insight-empty">当前条件下暂无数据</p>';
      return;
    }
    const quota = result.data_source === 'quota';
    const format = row => { const value = quota ? row.value : row[result.metric]; return value == null ? tr('未知') : Number(value).toLocaleString(undefined, {maximumFractionDigits: 4}) + (quota ? ' ' + (['used_percent','percent_change'].includes(result.metric) ? (result.metric === 'percent_change' ? tr('百分点') : '%') : row.unit || tr('未知单位')) : ''); };
    const names = rows.map(row => (row.labels || []).map(label => label === '__unknown__' ? tr('未识别项目') : label || tr('未知')).join(' / '));
    container.innerHTML = `<div class="multi-dimension-table-wrap"><table><thead><tr><th>${escape(result.dimensions.map(key => tr(dimensions[key] || key)).join(' / '))}</th><th>${escape(tr(metrics[result.metric]))}</th><th>${escape(tr('数据质量'))}</th></tr></thead><tbody>${rows.map((row,i) => `<tr><td>${escape(names[i])}</td><td>${escape(format(row))}</td><td>${escape(row.quality?.last_event || row.quality?.event || row.status || '')}</td></tr>`).join('')}</tbody></table></div>`;
    if (!window.Chart) return;
    const units = [...new Set(rows.map(row => quota ? row.unit || tr('未知单位') : tr(metrics[result.metric])))];
    const charts = [];
    units.forEach(unit => {
      const selected = rows.map((row,i) => ({row,i})).filter(({row}) => !quota || (row.unit || tr('未知单位')) === unit);
      const box = document.createElement('div'); box.className = 'multi-dimension-chart-container';
      const title = document.createElement('h5'); title.textContent = unit; container.append(title,box);
      const canvas = document.createElement('canvas');box.append(canvas);
      charts.push(new Chart(canvas,{type:'bar',data:{labels:selected.map(({i})=>names[i]),datasets:[{label:tr(metrics[result.metric]) + ' / ' + unit,data:selected.map(({row})=>{const value=quota?row.value:row[result.metric];return value==null?null:Number(value);}),backgroundColor:'#14b8a6',borderRadius:5}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true},y:{ticks:{autoSkip:false}}}}}));
    });
    instances.set(targetId, charts);
  }

  async function load(scope) {
    const prefix = scope === 'admin' ? 'admin' : 'user';
    const root = document.getElementById(`${prefix}MultiDimension`);
    if (!root) return;
    const status = root.querySelector('.multi-dimension-status');
    const source = root.querySelector('[name="data_source"]')?.value || 'requests';
    const quotaRoot = document.querySelector(`[data-quota-scope="${scope}"][data-quota-context="multi"]`);
    if (source === 'related') window.CrewRouterQuotaStats?.refresh(scope);
    if (quotaRoot) quotaRoot.hidden = false;
    const isQuota = source === 'quota';
    root.querySelector('.multi-dimension-choices').hidden = isQuota;
    root.querySelector('.quota-dimension-choices').hidden = !isQuota;
    root.querySelector('[name="metric"]').closest('label').hidden = isQuota;
    root.querySelector('[name="quota_metric"]').closest('label').hidden = !isQuota;
    const targetId = `${prefix}MultiDimensionResult`;
    const chosen = [...root.querySelectorAll(`${isQuota ? '.quota-dimension-choices' : '.multi-dimension-choices'} blora-checkbox[checked]`)].map(el => el.getAttribute('value'));
    const seq = Number(root.dataset.requestSeq || 0) + 1;
    root.dataset.requestSeq = seq;
    if (!chosen.length) {
      destroy(targetId);
      document.getElementById(targetId).replaceChildren();
      status.textContent = '请至少选择一个维度';
      return;
    }
    status.textContent = '正在加载...';
    try {
      const params = new URLSearchParams({
        dimensions: chosen.join(','), metric: root.querySelector(isQuota ? '[name="quota_metric"]' : '[name="metric"]').value, data_source: isQuota ? 'quota' : source === 'related' ? 'association' : 'usage',
        days: scope === 'admin' ? (document.getElementById('adminStatsDays')?.value || '30') : (document.getElementById('statsTimeRange')?.value || '30')
      });
      if (scope === 'user' && params.get('days') === 'custom') {
        const start = document.getElementById('statsStartDate')?.value;
        const end = document.getElementById('statsEndDate')?.value;
        if (!start || !end) {
          destroy(targetId);
          document.getElementById(targetId).replaceChildren();
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
      status.textContent = isQuota ? `展示 ${data.rows.length} 个额度组合` : `展示 ${data.rows.length} 个组合（最多 30 个）`;
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
      const choices = document.createElement('div'); choices.className = 'quota-dimension-choices multi-dimension-choices'; choices.hidden = true;
      choices.innerHTML = ['provider','account','kind','unit','window','date'].map(key => `<blora-checkbox value="${key}" label="${escape(tr(dimensions[key]))}" ${['provider','account'].includes(key)?'checked':''}></blora-checkbox>`).join('');
      root.querySelector('.multi-dimension-choices').after(choices);
      const label = document.createElement('label');label.hidden=true;
      label.innerHTML = `${escape(tr('额度指标'))} <blora-select name="quota_metric" value="remaining">${['remaining','used','total','used_percent','observed_consumption','percent_change'].map(key=>`<blora-option value="${key}">${escape(tr(metrics[key]))}</blora-option>`).join('')}</blora-select>`;
      root.querySelector('.multi-dimension-actions').prepend(label);
      root.addEventListener('change', event => {
        if (event.target.closest('blora-checkbox, blora-select[name="metric"], blora-select[name="data_source"], blora-select[name="quota_metric"]')) load(scope);
      });
    }
  }

  window.CrewRouterMultiDimension = { load, init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
