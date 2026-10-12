(function () {
  'use strict';
  const states = new WeakMap();
  const tr = (key, vars) => window.I18N?.t(key, vars) || key;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? tr('未知') : Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const date = value => !value || Number.isNaN(new Date(value).getTime()) ? tr('未知') : new Date(value).toLocaleString(window.I18N?.current() === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const array = value => Array.isArray(value) ? value : [];
  const statuses = { success: '正常', ok: '正常', failed: '查询失败', error: '查询失败', partial: '部分成功', stale: '已过期', unknown: '未知', cached: '缓存' };
  const status = row => tr(statuses[row.status] || '未知') + (row.stale && row.status !== 'stale' ? ' / ' + tr('已过期') : '');
  const button = (action, text, extra = '') => `<button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-quota-action="${action}" ${extra}>${esc(tr(text))}</button>`;
  function select(name, label, options) {
    return `<label>${esc(tr(label))}<blora-select name="${name}" value="" placeholder="${esc(tr(options[0]?.[1] || label))}">${options.map(([value, text]) => `<blora-option value="${esc(value)}">${esc(tr(text))}</blora-option>`).join('')}</blora-select></label>`;
  }
  function mount(root, scope, providerId = '') {
    if (states.has(root)) return;
    const state = { scope, providerId: String(providerId), page: 1, seq: 0, historySeq: 0, chart: null, accounts: [] };
    states.set(root, state);
    root.classList.add('quota-analysis');
    root.innerHTML = `<h4>${esc(tr('供应商额度分析'))}</h4><p class="quota-note">${esc(tr('额度是上游账户观测，可能包含平台外使用；不同单位和窗口不可相加，关联请求不代表真实成本分摊。'))}</p>
      <div class="quota-controls">${select('provider_id', '供应商', [['', '全部供应商']])}${select('account_id', '额度账户', [['', '全部账户']])}${select('unit', '单位', [['', '全部单位']])}${select('window_key', '窗口', [['', '全部窗口']])}${select('status', '状态', [['', '全部状态'], ['success', '正常'], ['partial', '部分成功'], ['failed', '查询失败'], ['stale', '已过期']])}${button('apply', '查询')}${button('reset', '重置')}</div>
      <p class="quota-status" role="status" aria-live="polite"></p><div class="quota-summary"></div><p class="quota-coverage quota-note"></p>
      <div class="quota-trend-controls">${select('trend_metric', '额度趋势', [['remaining', '剩余额度'], ['used_percent', '窗口使用率'], ['observed_consumption', '观测消耗'], ['percent_change', '使用率变化（百分点）'], ['requests', '请求数'], ['tokens', 'Token'], ['cost', '积分']])}</div><div class="quota-trend"></div><div class="quota-events quota-note"></div>
      <h5>${esc(tr('关联账户与请求贡献'))}</h5><div class="quota-table-wrap quota-accounts"></div>
      <details class="quota-history"><summary>${esc(tr('额度历史'))}</summary><p class="quota-note">${esc(tr('历史仅按额度账户筛选，不按请求贡献维度筛选。'))}</p><div class="quota-table-wrap quota-history-rows"></div><div class="quota-pagination">${button('prev', '上一页', 'disabled')}<span class="quota-page"></span>${button('next', '下一页', 'disabled')}</div></details>`;
    root.querySelector('[name="trend_metric"]').value = 'remaining';
    root.addEventListener('click', event => {
      const el = event.target.closest('[data-quota-action]');
      if (!el) return;
      const action = el.dataset.quotaAction;
      if (action === 'history') {
        root.querySelector('[name="provider_id"]').value = el.dataset.provider || '';
        root.querySelector('[name="account_id"]').value = el.dataset.account || '';
        state.page = 1;
        root.querySelector('details').open = true;
        load(root);
        root.querySelector('details').scrollIntoView({ block: 'nearest', behavior: 'instant' });
      } else if (action === 'apply' || action === 'reset') {
        if (action === 'reset') ['provider_id', 'account_id', 'unit', 'window_key', 'status'].forEach(name => { root.querySelector(`[name="${name}"]`).value = name === 'provider_id' ? state.providerId : ''; });
        state.page = 1;
        load(root);
        if (root.dataset.quotaContext === 'multi' && document.getElementById(`${state.scope}MultiDimension`)?.querySelector('[name="data_source"]')?.value === 'quota') window.CrewRouterMultiDimension?.load(state.scope);
      } else {
        state.page += action === 'next' ? 1 : -1;
        history(root);
      }
    });
    root.addEventListener('change', event => {
      if (event.target.name === 'trend_metric') renderTrend(root, state.data || {});
      if (event.target.name === 'provider_id') { root.querySelector('[name="account_id"]').value = ''; options(root, state.accounts); }
    });
    root.querySelector('details').addEventListener('toggle', () => { if (root.querySelector('details').open) history(root); });
  }
  function params(root) {
    const state = states.get(root);
    const result = new URLSearchParams();
    const days = document.getElementById(state.scope === 'admin' ? 'adminStatsDays' : 'statsTimeRange')?.value || '30';
    if (days === 'custom') {
      const start = document.getElementById('statsStartDate')?.value;
      const end = document.getElementById('statsEndDate')?.value;
      if (!start || !end || start > end) throw new Error(tr('请选择有效时间范围'));
      result.set('start', start); result.set('end', end);
    } else result.set('days', days);
    ['provider_id', 'account_id', 'unit', 'window_key', 'status'].forEach(name => {
      const value = root.querySelector(`[name="${name}"]`).value;
      if (value) result.set(name, value);
    });
    if (root.dataset.quotaContext === 'multi') {
      const filters = state.scope === 'admin' ? { user_id: 'multiStatsUser', team_id: 'multiStatsTeam', model_id: 'multiStatsModel', request_source: 'multiStatsSource', workspace_path: 'multiStatsProject' } : { model_id: 'statsModelFilter', request_source: 'statsSourceFilter' };
      Object.entries(filters).forEach(([key, id]) => { const value = document.getElementById(id)?.value; if (value) result.set(key, value); });
    }
    return result;
  }
  async function request(scope, path, query) {
    const response = await fetch(`/api/${scope}/stats/provider-quota${path}?${query}`);
    if (!response.ok) throw new Error(tr(response.status === 403 ? '无权查看额度' : '额度数据加载失败，请重试'));
    return response.json();
  }
  function options(root, accounts) {
    const state = states.get(root);
    for (const name of ['provider_id', 'account_id', 'unit', 'window_key']) {
      const el = root.querySelector(`[name="${name}"]`);
      const selected = el.value || (name === 'provider_id' ? state.providerId : '');
      const provider = root.querySelector('[name="provider_id"]').value;
      const map = new Map();
      accounts.forEach(row => {
        if (name === 'account_id' && provider && String(row.provider_id) !== provider) return;
        const id = row[name];
        if (id != null && String(id) !== '') map.set(String(id), name === 'provider_id' ? row.provider_name : name === 'account_id' ? row.label : row[name]);
      });
      if (selected && !map.has(selected)) map.set(selected, selected === state.providerId ? tr('当前供应商') : tr('当前筛选'));
      const html = `<blora-option value="">${esc(tr(({ provider_id: '全部供应商', account_id: '全部账户', unit: '全部单位', window_key: '全部窗口' })[name]))}</blora-option>` + [...map].map(([id, label]) => `<blora-option value="${esc(id)}">${esc(label || tr('未知'))}</blora-option>`).join('');
      if (el.dataset.quotaOptions !== html) {
        el.innerHTML = html;
        el.dataset.quotaOptions = html;
        el.value = selected;
      }
      if (name === 'provider_id' && state.providerId) el.disabled = true;
    }
  }
  function table(rows, historical) {
    const labels = ['供应商', '额度账户', '类型', '单位', '窗口', '总额度', '已用', '剩余', '窗口使用率', '重置时间', '有效观测时间', '状态', '请求数', 'Token', '积分', '最近尝试时间', '最近尝试状态', '查询时间'];
    return `<table><thead><tr>${labels.map(label => `<th>${esc(tr(label))}</th>`).join('')}${historical ? '' : `<th>${esc(tr('操作'))}</th>`}</tr></thead><tbody>${rows.map(row => `<tr>${[row.provider_name, row.label, row.kind, row.unit || tr('未知单位'), row.window_key || '—', number(row.total), number(row.used), number(row.remaining), row.used_percent == null || row.used_percent === '' || !Number.isFinite(Number(row.used_percent)) ? tr('未知') : number(row.used_percent) + '%', date(row.resets_at), date(row.observed_at), status(row), number(row.requests), number(row.tokens), number(row.cost), date(row.last_attempt_at || row.checked_at), tr(statuses[row.last_attempt_status || row.status] || '未知'), date(row.checked_at)].map(value => `<td>${esc(value ?? tr('未知'))}</td>`).join('')}${historical ? '' : `<td>${button('history', '额度历史', `data-provider="${esc(row.provider_id)}" data-account="${esc(row.account_id)}"`)}</td>`}</tr>`).join('')}</tbody></table>`;
  }
  function renderTrend(root, data) {
    const state = states.get(root);
    (state.charts || []).forEach(chart => chart.destroy()); state.charts = [];
    const metric = root.querySelector('[name="trend_metric"]').value || 'remaining';
    const usage = ['requests','tokens','cost'].includes(metric);
    const rows = array(usage ? data.usage_trend : data.trend);
    const units = [...new Set(rows.map(row => usage ? tr({requests:'请求数',tokens:'Token',cost:'积分'}[metric]) : ['used_percent','percent_change'].includes(metric) ? (metric === 'percent_change' ? tr('百分点') : '%') : row.unit || tr('未知单位')))];
    const target = root.querySelector('.quota-trend');target.replaceChildren();target.hidden=false;target.style.height='auto';
    if (!rows.length) target.textContent=tr('暂无额度趋势，实际查询后开始记录');
    units.forEach(unit => {
      const selected = rows.filter(row => usage || ['used_percent','percent_change'].includes(metric) || (row.unit || tr('未知单位')) === unit);
      const labels = [...new Set(selected.map(row=>row.date || row.observed_at).filter(Boolean))].sort();
      const title=document.createElement('h5');title.textContent=unit;const box=document.createElement('div');box.style.height='280px';const canvas=document.createElement('canvas');box.append(canvas);target.append(title,box);
      const groups=new Map();selected.forEach(row=>{const key=usage?row.provider_id:`${row.label || row.account_id} / ${row.window_key || ''}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);});
      if(window.Chart)state.charts.push(new Chart(canvas,{type:'line',data:{labels,datasets:[...groups].map(([label,values],i)=>({label,data:labels.map(day=>{const row=values.find(r=>(r.date||r.observed_at)===day);return row?.[metric]==null?null:Number(row[metric]);}),borderColor:['#14b8a6','#6366f1','#f59e0b','#ef4444'][i%4],spanGaps:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}},scales:{y:{title:{display:true,text:unit}}}}}));
    });
    root.querySelector('.quota-events').textContent=array(data.trend).map(row => `${row.date || date(row.observed_at)} / ${row.label || row.account_id || ''}: ${tr('观测消耗')} ${number(row.observed_consumption)} ${row.unit || ''} / ${tr('使用率变化（百分点）')} ${number(row.percent_change)} / ${tr('变化事件')} ${tr(row.quality?.last_event || row.quality?.event || '未知')} / ${tr('样本数')} ${number(row.sample_count)} / ${tr('重置时间')} ${date(row.resets_at)}`).join('；');
  }
  async function load(root) {
    const state = states.get(root);
    if (!state) return;
    const seq = ++state.seq;
    ++state.historySeq;
    const message = root.querySelector('.quota-status');
    message.textContent = tr('正在加载...');
    try {
      const data = await request(state.scope, '', params(root));
      if (seq !== state.seq) return;
      state.data = data;
      const accounts = array(data.accounts);
      if (!state.accounts.length || !root.querySelector('[name="provider_id"]').value) state.accounts = accounts;
      options(root, state.accounts);
      message.textContent = accounts.length ? tr('选定区间最后有效额度；失败状态保留有效观测，不代表当前实时余额。') : tr('当前条件下暂无可见额度账户');
      const summary = data.summary || {};
      root.querySelector('.quota-summary').innerHTML = ['providers', 'accounts', 'success', 'low', 'failed', 'stale'].map((key, index) => `<div><span>${esc(tr(['供应商', '额度账户', '正常', '低额度', '查询失败', '已过期'][index]))}</span><strong>${esc(number(summary[key] ?? summary[key + '_count']))}</strong></div>`).join('') + array(data.groups).map(group => `<div><span>${esc(group.unit || tr('未知单位'))}</span><strong>${esc(tr('剩余'))} ${esc(number(group.remaining))}</strong><small>${esc(group.window_key || '')}<br>${esc(tr('总额度'))} ${esc(number(group.total))} / ${esc(tr('已用'))} ${esc(number(group.used))}<br>${esc(tr('观测消耗'))} ${esc(number(group.observed_consumption))}</small></div>`).join('');
      const coverage = data.coverage || {};
      root.querySelector('.quota-coverage').textContent = `${tr('历史记录开始于')} ${date(coverage.started_at || coverage.first_observed_at)} · ${tr('样本数')} ${number(coverage.samples ?? coverage.sample_count)} · ${tr('最后有效观测')} ${date(coverage.last_observed_at || coverage.last_valid_at)} · ${tr('采样缺口')} ${number(coverage.gaps ?? coverage.gap_count)} · ${tr('上海时区；观测消耗不是精确账单，重置、充值及稀疏采样可能影响变化。')} ${tr('请求贡献为供应商范围，同一供应商的账户行不可相加。')} ${coverage.usage_complete === false ? tr('请求关联历史覆盖不完整；已删除明细无法恢复。') : ''}`;
      root.querySelector('.quota-accounts').innerHTML = accounts.length ? table(accounts, false) : `<p>${esc(tr('当前条件下暂无可见额度账户'))}</p>`;
      renderTrend(root, data);
      if (root.querySelector('details').open) history(root);
    } catch (error) {
      if (seq !== state.seq) return;
      (state.charts || []).forEach(chart => chart.destroy()); state.charts = []; state.chart = null;
      state.data = null;
      state.accounts = [];
      root.querySelector('.quota-events').replaceChildren();
      root.querySelector('.quota-trend').replaceChildren();
      const defaults = { provider_id: '全部供应商', account_id: '全部账户', unit: '全部单位', window_key: '全部窗口' };
      Object.entries(defaults).forEach(([name,label]) => {
        const control = root.querySelector(`[name="${name}"]`);
        control.innerHTML = `<blora-option value="">${esc(tr(label))}</blora-option>`;
        control.value = '';
        delete control.dataset.quotaOptions;
      });
      root.querySelector('.quota-page').textContent = '';
      root.querySelector('.quota-summary').replaceChildren();
      root.querySelector('.quota-accounts').replaceChildren();
      root.querySelector('.quota-history-rows').replaceChildren();
      root.querySelector('.quota-coverage').textContent = '';
      root.querySelector('.quota-trend').hidden = true;
      root.querySelector('.quota-trend-empty')?.remove();
      message.textContent = error.message;
      root.querySelectorAll('[data-quota-action="prev"], [data-quota-action="next"]').forEach(el => { el.disabled = true; });
    }
  }
  async function history(root) {
    const state = states.get(root);
    const seq = ++state.historySeq;
    const querySeq = state.seq;
    const target = root.querySelector('.quota-history-rows');
    target.textContent = tr('正在加载...');
    root.querySelectorAll('[data-quota-action="prev"], [data-quota-action="next"]').forEach(el => { el.disabled = true; });
    try {
      const query = params(root); ['user_id','team_id','model_id','request_source','workspace_path','api_key_id','data_source'].forEach(key=>query.delete(key)); query.set('page', state.page); query.set('limit', '20');
      const data = await request(state.scope, '/history', query);
      if (seq !== state.historySeq || querySeq !== state.seq) return;
      const rows = array(data.rows);
      target.innerHTML = rows.length ? table(rows, true) : `<p>${esc(tr('暂无额度历史，实际查询后开始记录'))}</p>`;
      const page = Number(data.page) || state.page;
      const limit = Number(data.limit) || 20;
      const total = Number(data.total) || 0;
      state.page = page;
      root.querySelector('.quota-page').textContent = tr('第 {page} 页，共 {total} 条', { page, total });
      root.querySelector('[data-quota-action="prev"]').disabled = page <= 1;
      root.querySelector('[data-quota-action="next"]').disabled = page * limit >= total;
    } catch (error) { if (seq === state.historySeq && querySeq === state.seq) target.textContent = error.message; }
  }
  function refresh(scope) {
    document.querySelectorAll(`[data-quota-scope="${scope}"]`).forEach(root => {
      mount(root, scope);
      const selectedProvider = document.getElementById(scope === 'admin' ? 'multiStatsProvider' : 'statsProviderFilter')?.value;
      if (root.dataset.quotaContext === 'multi' && selectedProvider !== undefined) {
        root.querySelector('[name="provider_id"]').value = selectedProvider;
      }
      const state = states.get(root);
      try {
        const key = params(root).toString();
        if (state.queryKey !== key) state.page = 1;
        state.queryKey = key;
      } catch (_) { state.page = 1; }
      load(root);
    });
  }
  function open(scope, providerId) {
    let dialog = document.getElementById('quotaHistoryDialog');
    if (!dialog) {
      dialog = document.createElement('blora-dialog'); dialog.id = 'quotaHistoryDialog';
      dialog.innerHTML = `<div class="modal-content"><div class="modal-header"><h3>${esc(tr('额度历史'))}</h3><button type="button" class="modal-close" aria-label="${esc(tr('关闭'))}">&times;</button></div><div class="modal-body"><section></section></div></div>`;
      document.body.append(dialog);
      dialog.querySelector('button').addEventListener('click', () => dialog.close ? dialog.close() : dialog.removeAttribute('open'));
    }
    const oldRoot = dialog.querySelector('section');
    (states.get(oldRoot)?.charts || []).forEach(chart => chart.destroy());
    const root = document.createElement('section'); oldRoot.replaceWith(root);
    mount(root, scope, providerId);
    options(root, []);
    root.querySelector('details').open = true;
    if (dialog.show) dialog.show(); else dialog.setAttribute('open', '');
    load(root);
  }
  async function detail(root, scope, providerId) {
    if (!root) return;
    const seq = Number(root.dataset.quotaSeq || 0) + 1;
    root.dataset.quotaSeq = seq;
    root.classList.add('quota-analysis');
    root.textContent = tr('正在加载最后有效观测...');
    try {
      const data = await request(scope, '', new URLSearchParams({ days: '30', provider_id: providerId }));
      if (Number(root.dataset.quotaSeq) !== seq) return;
      const rows = array(data.accounts);
      root.innerHTML = `<h5>${esc(tr('最后有效观测'))}</h5><p class="quota-note">${esc(tr('最近查询失败时保留有效观测；这不是实时余额。'))}</p><div class="quota-table-wrap">${rows.length ? table(rows, true) : esc(tr('暂无有效额度观测'))}</div>`;
    } catch (error) { if (Number(root.dataset.quotaSeq) === seq) root.textContent = error.message; }
  }
  async function library(root) {
    if (!root) return;
    const seq = Number(root.dataset.quotaSeq || 0) + 1;
    root.dataset.quotaSeq = seq;
    try {
      const data = await request('user', '', new URLSearchParams({ days: '30' }));
      if (Number(root.dataset.quotaSeq) !== seq) return;
      root.querySelectorAll('[data-quota-provider]').forEach(button => {
        const rows = array(data.accounts).filter(row => String(row.provider_id) === button.dataset.quotaProvider);
        if (!rows.length) return;
        const article = button.closest('article');
        let panel = article.querySelector('.quota-library-latest');
        if (!panel) { panel = document.createElement('div'); panel.className = 'quota-library-latest quota-note'; button.before(panel); }
        panel.innerHTML = `<strong>${esc(tr('最后有效观测'))}</strong>` + rows.map(row => `<div>${esc(row.label || tr('额度账户'))} ${esc(row.window_key || row.unit || tr('未知单位'))}: ${esc(row.used_percent != null ? number(row.used_percent) + '%' : number(row.remaining))} · ${esc(status(row))}<br>${esc(date(row.observed_at))}</div>`).join('');
      });
    } catch (_) { /* The cached cards remain available when analytics is unavailable. */ }
  }
  window.CrewRouterQuotaStats = { refresh, open, detail, library };
})();
