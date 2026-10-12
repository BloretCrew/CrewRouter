(function () {
  'use strict';
  const tr = (key, vars) => window.I18N?.t(key, vars) || key.replace(/\{(\w+)\}/g, (_, name) => vars?.[name] ?? `{${name}}`);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const rows = value => Array.isArray(value) ? value : [];
  const num = value => value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(window.I18N?.lang === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 });
  const date = value => !value || Number.isNaN(new Date(value).getTime()) ? '—' : new Date(value).toLocaleString(window.I18N?.lang === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const statusLabels = { complete: '完整周期', partial: '部分周期', pending: '待对账', pending_reconciliation: '待对账', open: '进行中', active: '进行中', exhausted_pending_reconciliation: '待对账', reset_before_exhaustion: '重置前未耗尽', adjusted: '额度调整', invalidated: '报告失效', adjustment: '额度调整', topup: '充值', unchanged: '额度未变化', unknown: '状态未提供', cancelled: '已取消', rate_limited: '采集限流', unsupported: '不支持采集', running: '进行中', certain: '确定关联', candidate: '候选关联', reset: '重置', exhausted: '额度耗尽', increase: '额度增加', consumption: '观测消耗', initial: '首次观测', correction: '观测修订', gap: '采样缺口', success: '正常', failed: '查询失败', error: '查询失败' };
  const windowLabel = value => tr(({ monthly: '每月', weekly: '每周', daily: '每日', primary: '主要窗口', secondary: '次要窗口', seven_day: '7 天', five_hour: '5 小时', percent: '使用率' })[value] || value || '—');
  const label = value => tr(statusLabels[value] || '状态未提供');
  const button = (action, text, attrs = '') => `<button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-cycle-action="${action}" ${attrs}>${esc(tr(text))}</button>`;
  const badge = cycle => `<span class="cycle-badge" data-state="${esc(cycle.state || cycle.status || 'partial')}">${esc(label(cycle.state || cycle.status))}</span>`;
  function table(headings, values) {
    if (!values.length) return `<p class="quota-note">${esc(tr('当前条件下暂无周期数据'))}</p>`;
    return `<div class="cycle-table-wrap"><table><thead><tr>${headings.map(h => `<th scope="col">${esc(tr(h))}</th>`).join('')}</tr></thead><tbody>${values.map(cells => `<tr>${cells.map((cell, i) => `<td data-label="${esc(tr(headings[i]))}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function metrics(values) { return `<dl class="cycle-metrics">${values.map(([key, value]) => `<div><dt>${esc(tr(key))}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`; }
  function pager(kind, data) {
    const page = Number(data.page) || 1, limit = Number(data.limit) || 20, total = Number(data.total) || 0;
    return `<div class="cycle-pagination">${button(kind + '-prev', '上一页', page <= 1 ? 'disabled' : '')}<span>${esc(tr('第 {page} 页，共 {total} 条', { page, total }))}</span>${button(kind + '-next', '下一页', page * limit >= total ? 'disabled' : '')}</div>`;
  }
  let active;
  function clear(state) {
    ++state.seq; state.controller?.abort();
    state.cycle = null;
    state.accounts = []; state.dimensions = {}; state.report = null; state.attemptRows = [];
    state.root.querySelector('.cycle-list').replaceChildren();
    state.root.querySelector('.cycle-report').replaceChildren();
    state.root.querySelector('.cycle-filters').replaceChildren();
  }
  async function request(state, path, query, signal) {
    const response = await fetch(`/api/${state.scope}/stats/provider-quota/cycles${path}?${query}`, { signal });
    if (!response.ok) {
      const error = new Error(tr(response.status === 403 ? '无权查看额度' : '额度数据加载失败，请重试'));
      error.denied = response.status === 403;
      throw error;
    }
    return response.json();
  }
  function query(state) {
    const result = new URLSearchParams(state.query);
    ['user_id', 'team_id', 'model_id', 'request_source', 'workspace_path', 'api_key_id', 'data_source', 'status', 'page', 'limit'].forEach(key => result.delete(key));
    state.root.querySelectorAll('.cycle-filters blora-select').forEach(el => { const name = el.getAttribute('name'); if (el.value) result.set(name, el.value); else result.delete(name); });
    return result;
  }
  async function run(state, work) {
    state.controller?.abort();
    const seq = ++state.seq;
    state.root.querySelector('.cycle-status').textContent = tr('正在加载...');
    try {
      const apply = await work();
      if (active !== state || seq !== state.seq) return;
      apply();
      state.root.querySelector('.cycle-status').textContent = '';
    } catch (error) {
      if (active !== state || seq !== state.seq) return;
      if (error.denied) clear(state);
      state.root.querySelector('.cycle-status').textContent = error.message;
    }
  }
  function list(state) {
    state.cycle = null; state.report = null; state.dimensions = {}; state.attemptRows = [];
    state.root.querySelector('.cycle-report').replaceChildren();
    state.root.querySelector('.cycle-list').replaceChildren();
    return run(state, async () => {
      const q = query(state); q.set('page', state.page); q.set('limit', '20');
      const data = await request(state, '', q);
      return () => {
        state.page = Number(data.page) || state.page;
        state.root.querySelector('.cycle-list').innerHTML = table(['供应商 / 账户', '窗口', '周期范围', '周期状态', '详情'], rows(data.rows).map(c => [esc(c.provider_name || state.accounts.find(r => String(r.account_id) === String(c.account_id))?.provider_name || tr('供应商名称未提供')) + `<small>${esc(c.account_label || c.label || state.accounts.find(r => String(r.account_id) === String(c.account_id))?.label || c.account_id)}</small>`, esc(windowLabel(c.window_key || c.unit)), `${esc(date(c.started_at))}<small>${esc(date(c.ended_at))}</small>`, badge(c), button('report', '查看周期报告', `data-id="${esc(c.id)}"`)])) + pager('list', data);
      };
    });
  }
  function renderReport(state, data, intervals) {
    const c = data.cycle || {}, s = data.summary || {}, coverage = data.coverage || {};
    const samples = rows(data.samples).length ? data.samples : [...new Map([c.initial_snapshot, ...rows(intervals.rows).flatMap(r => [r.before_snapshot, r.after_snapshot]), c.final_snapshot].filter(Boolean).map(r => [r.observed_at, r])).values()];
    state.dimensions = data.dimensions || {}; state.dimension = 'user'; state.rank = 'attempts';
    const account = state.accounts.find(r => String(r.account_id) === String(c.account_id));
    state.report = data; state.cycle = c; state.intervalPage = Number(intervals.page) || 1;
    state.root.querySelector('.cycle-report').innerHTML = `<header class="cycle-report-heading"><h4>${esc(tr('周期报告'))}</h4>${badge(c)}${button('export', '导出 JSON')}</header><div class="cycle-export-status" role="status"></div>
      <p class="quota-note">${esc(account?.provider_name || c.provider_name || tr('供应商'))} / ${esc(account?.label || c.account_id)} · ${esc(date(c.started_at))} – ${esc(date(c.ended_at))} · ${esc(tr('报告版本'))} ${esc(num(data.report_version || c.report_version || c.version))}</p>
      <p class="cycle-disclaimer">${esc(tr('观测额度变化不是精确请求成本；平台外使用、采样缺口与重置会影响归因。'))}</p>
      ${metrics([['观测消耗', num(s.observed_consumption ?? data.quota?.observed_consumption)], ['相关请求', num(s.requests ?? s.attempt_count ?? s.attempts)], ['Token', num(s.tokens ?? s.total_tokens)], ['积分', num(s.cost ?? s.points)], ['样本', num(coverage.sample_count ?? coverage.samples ?? c.quality?.samples ?? samples.length)], ['采样缺口', num(coverage.gap_count ?? coverage.gaps ?? c.quality?.gaps)]])}<details class="cycle-report-statistics"><summary>${esc(tr('详尽统计与覆盖质量'))}</summary>${metrics([['逻辑请求', num(s.logical_requests)], ['成功', num(s.success)], ['失败', num(s.failed)], ['已取消', num(s.cancelled)], ['重试', num(s.retries)], ['流式', num(s.streaming)], ['确定关联', num(s.certain)], ['候选关联', num(s.candidate)], ['待对账', num(s.pending)], ['输入 Token', num(s.input_tokens)], ['输出 Token', num(s.output_tokens)], ['缓存读取 Token', num(s.cache_read_tokens)], ['缓存创建 Token', num(s.cache_creation_tokens)], ['加权 Token', num(s.weighted_tokens)], ['未知用量', num(s.unknown_usage)], ['估算用量', num(s.estimated_usage)], ['P50 / P95 / P99（毫秒）', [s.latency_ms?.p50, s.latency_ms?.p95, s.latency_ms?.p99].map(num).join(' / ')], ['每秒请求', num(s.throughput_per_second)], ['首次请求', date(s.first_request_at)], ['末次请求', date(s.last_request_at)], ['使用率变化（百分点）', num(data.quota?.percent_change)], ['失败采样', num(coverage.failed_samples)], ['不支持采样', num(coverage.unsupported_samples)], ['缺失采样', num(coverage.missing_samples)], ['缓存采样', num(coverage.cached_samples)], ['请求后补采基线', num(coverage.post_start_baselines)], ['期初使用率', c.start_percent == null ? '—' : num(c.start_percent) + '%'], ['期末使用率', c.end_percent == null ? '—' : num(c.end_percent) + '%'], ['耗尽时间', date(c.exhausted_at)], ['对账确认时间', date(c.confirmed_at)]])}</details>
      <p class="quota-note">${esc(tr(coverage.platform_requests_complete ? '平台请求覆盖完整' : '平台请求覆盖未确认'))} · ${esc(tr(c.inferred ? '推断周期边界' : '观测周期边界'))}</p><section><h5>${esc(tr('变化时间线'))}</h5><div class="cycle-intervals">${timeline(intervals)}</div></section>
      <section><h5>${esc(tr('用户贡献'))}</h5><div class="cycle-contribution-controls"><label>${esc(tr('贡献维度'))}<blora-select name="contribution_dimension">${Object.entries({ user: '用户', team: 'Team', model: '模型', project: '项目', client: '客户端', key: '平台 Key', session: '会话' }).map(([key, text]) => `<blora-option value="${key}">${esc(tr(text))}</blora-option>`).join('')}</blora-select></label><label>${esc(tr('排序指标'))}<blora-select name="contribution_rank"><blora-option value="attempts">${esc(tr('相关请求'))}</blora-option><blora-option value="total_tokens">Token</blora-option><blora-option value="points">${esc(tr('积分'))}</blora-option></blora-select></label></div><div class="cycle-contributors"></div></section>
      <section><h5>${esc(tr('请求尝试明细'))}</h5><div class="cycle-requests"></div></section>
      <details class="cycle-samples"><summary>${esc(tr('观测样本'))}</summary>${table(['有效观测时间', '状态', '已用', '剩余', '使用率'], samples.map(r => [esc(date(r.observed_at)), esc(label(r.status)), esc(num(r.used)), esc(num(r.remaining)), r.used_percent == null ? '—' : esc(num(r.used_percent)) + '%']))}</details>`;
  }
  function renderContributors(state) {
    const names = { user: '用户', team: 'Team', model: '模型', project: '项目', client: '客户端', key: '平台 Key', session: '会话' };
    const entries = rows(state.dimensions[state.dimension]).slice().sort((a, b) => Number(b[state.rank] || 0) - Number(a[state.rank] || 0));
    state.root.querySelector('.cycle-contributors').innerHTML = table([names[state.dimension], '相关请求', 'Token', '积分', '请求占比', 'Token 占比', '积分占比'], entries.map(r => [esc(r.key ?? '—'), esc(num(r.attempts)), esc(num(r.total_tokens)), esc(num(r.points)), ...['request_share', 'token_share', 'points_share'].map(key => r[key] == null ? '—' : esc(num(r[key] * 100)) + '%')]));
  }
  function requestSamples(state, attemptId) {
    const row = state.attemptRows.find(r => String(r.attempt_id || r.snapshot?.id) === attemptId);
    if (!row) return;
    const sampleRows = rows(row.samples).flatMap(sample => {
      const snap = sample.normalized_snapshot || sample.snapshot || {};
      return (rows(snap.items).length ? snap.items : [snap]).map(item => [esc(tr(sample.phase === 'terminal' ? '请求后' : '请求前')), esc(label(sample.status || sample.quality?.status || snap.status)), esc(date(snap.observed_at)), esc(windowLabel(item.window_key || item.unit)), esc(num(item.used)), esc(num(item.remaining)), item.used_percent == null ? '—' : esc(num(item.used_percent)) + '%', esc(num(sample.sample_age_ms)), esc(sample.reused ? tr('缓存') : tr('实际观测'))]);
    });
    state.root.querySelector('.cycle-attempt-samples').innerHTML = `<h5>${esc(tr('请求前后样本'))} · ${esc(attemptId)}</h5>${table(['采集阶段', '状态', '有效观测时间', '窗口', '已用', '剩余', '使用率', '样本年龄（毫秒）', '来源'], sampleRows)}`;
    state.root.querySelector('.cycle-attempt-samples').scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  async function exportAll(state) {
    state.controller?.abort();
    const controller = state.controller = new AbortController(), seq = ++state.seq, id = state.id;
    const target = state.root.querySelector('.cycle-export-status');
    const valid = () => active === state && seq === state.seq && !controller.signal.aborted;
    target.innerHTML = button('cancel-export', '取消导出');
    try {
      const q = query(state); q.set('limit', '200'); q.set('page', '1');
      const payload = await request(state, '/' + encodeURIComponent(id), q, controller.signal);
      const first = await request(state, '/' + encodeURIComponent(id) + '/requests', q, controller.signal);
      if (!valid()) return;
      const total = Number(first.total), limit = Number(first.limit) || 200;
      if (!Number.isSafeInteger(total) || total < 0 || limit < 1 || limit > 200 || Math.ceil(total / limit) > 200) throw new Error(tr('导出超过安全范围，请缩小日期范围'));
      const collected = rows(first.rows).slice();
      for (let page = 2; collected.length < total; page++) {
        if (!valid()) return;
        q.set('page', page);
        const data = await request(state, '/' + encodeURIComponent(id) + '/requests', q, controller.signal);
        if (!valid()) return;
        if (Number(data.total) !== total || Number(data.page) !== page || !rows(data.rows).length || page > 200) throw new Error(tr('导出期间数据发生变化，请重试'));
        collected.push(...data.rows);
        target.innerHTML = `<span>${esc(tr('正在导出 {count} / {total}', { count: collected.length, total }))}</span>${button('cancel-export', '取消导出')}`;
      }
      const ids = new Set(collected.map(r => r.attempt_id || r.snapshot?.id));
      if (collected.length !== total || ids.size !== total || ids.has(undefined)) throw new Error(tr('导出期间数据发生变化，请重试'));
      const finalReport = await request(state, '/' + encodeURIComponent(id), q, controller.signal);
      if (!valid()) return;
      if ((finalReport.report_version || finalReport.cycle?.version) !== (payload.report_version || payload.cycle?.version)) throw new Error(tr('导出期间数据发生变化，请重试'));
      const complete = { ...payload, requests: { rows: collected, total, page: 1, limit: total }, export_paged: false, export_complete: true };
      const url = URL.createObjectURL(new Blob([JSON.stringify(complete, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `quota-cycle-${id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      target.textContent = tr('已导出全部 {total} 条请求', { total });
    } catch (error) {
      if (!valid()) return;
      if (error.denied) clear(state);
      else target.textContent = error.message;
      state.root.querySelector('.cycle-status').textContent = error.message;
    }
  }
  function timeline(data) {
    return `<ol class="cycle-timeline">${rows(data.rows).map(r => `<li><time>${esc(date(r.started_at))} – ${esc(date(r.ended_at))}</time><strong>${esc(label(r.event || r.kind || r.status))}</strong><span>${esc(tr('观测消耗'))} ${esc(num(r.observed_consumption))} · ${esc(tr('相关请求'))} ${esc(num(r.requests ?? r.attempt_count ?? r.summary?.attempts))}</span></li>`).join('') || `<li>${esc(tr('当前条件下暂无周期数据'))}</li>`}</ol>${pager('intervals', data)}`;
  }
  function intervals(state) {
    state.root.querySelector('.cycle-intervals').replaceChildren();
    return run(state, async () => {
      const q = query(state); q.set('page', state.intervalPage); q.set('limit', '20');
      const data = await request(state, '/' + encodeURIComponent(state.id) + '/intervals', q);
      return () => { state.intervalPage = Number(data.page) || state.intervalPage; state.root.querySelector('.cycle-intervals').innerHTML = timeline(data); };
    });
  }
  function report(state, id) {
    state.id = id; state.requestPage = 1;
    state.root.querySelector('.cycle-report').replaceChildren();
    return run(state, async () => {
      const q = query(state), path = '/' + encodeURIComponent(id);
      const [data, intervals, attempts] = await Promise.all([request(state, path, q), request(state, path + '/intervals', q), request(state, path + '/requests', new URLSearchParams([...q, ['page', '1'], ['limit', '20']]))]);
      return () => { renderReport(state, data, intervals); state.root.querySelector('[name="contribution_dimension"]').value = 'user'; state.root.querySelector('[name="contribution_rank"]').value = 'attempts'; renderContributors(state); renderRequests(state, attempts); state.root.querySelector('.cycle-report').scrollIntoView({ block: 'start', behavior: 'instant' }); };
    });
  }
  function renderRequests(state, data) {
    state.requestPage = Number(data.page) || state.requestPage; state.attemptRows = rows(data.rows);
    state.root.querySelector('.cycle-requests').innerHTML = table(['请求时间', '尝试 / 关联', '用户', '模型', '状态', 'Token', '积分', '详情'], rows(data.rows).map(row => { const r = { ...row, ...row.snapshot }; return [esc(date(r.started_at || r.created_at)), esc(r.attempt_id || r.id || '—') + `<small>${esc(label(r.relation))}</small>`, esc(r.user_name || r.username || r.user_id || r.key || '—'), esc(r.model_name || r.model || r.model_id || '—'), esc(label(r.status)), esc(num(r.total_tokens ?? r.tokens)), esc(num(r.cost ?? r.points)), button('attempt-samples', '请求前后样本', `data-attempt="${esc(row.attempt_id || row.snapshot?.id)}"`)]; })) + pager('requests', data) + '<div class="cycle-attempt-samples"></div>';
  }
  function requests(state) {
    state.root.querySelector('.cycle-requests').replaceChildren();
    return run(state, async () => {
      const q = query(state); q.set('page', state.requestPage); q.set('limit', '20');
      const data = await request(state, '/' + encodeURIComponent(state.id) + '/requests', q);
      return () => renderRequests(state, data);
    });
  }
  function open(scope, initial = {}, accounts = []) {
    let dialog = document.getElementById('quotaCycleDialog');
    if (!dialog) {
      dialog = document.createElement('blora-dialog'); dialog.id = 'quotaCycleDialog'; document.body.append(dialog);
      dialog.addEventListener('click', event => {
        const el = event.target.closest('[data-cycle-action]'); if (!el || !active) return;
        const state = active, action = el.dataset.cycleAction;
        if (action === 'close') { state.controller?.abort(); ++state.seq; dialog.close(); }
        else if (action === 'apply') { state.page = 1; list(state); }
        else if (action === 'report') report(state, el.dataset.id);
        else if (action.startsWith('list-')) { state.page = Math.max(1, state.page + (action.endsWith('next') ? 1 : -1)); list(state); }
        else if (action.startsWith('intervals-')) { state.intervalPage = Math.max(1, state.intervalPage + (action.endsWith('next') ? 1 : -1)); intervals(state); }
        else if (action.startsWith('requests-')) { state.requestPage = Math.max(1, state.requestPage + (action.endsWith('next') ? 1 : -1)); requests(state); }
        else if (action === 'attempt-samples') requestSamples(state, el.dataset.attempt);
        else if (action === 'export') exportAll(state);
        else if (action === 'cancel-export') { ++state.seq; state.controller?.abort(); state.root.querySelector('.cycle-export-status').textContent = tr('导出已取消'); }
      });
      dialog.addEventListener('close', () => { if (active) { active.controller?.abort(); ++active.seq; } });
    }
    if (active) { active.controller?.abort(); ++active.seq; }
    dialog.innerHTML = `<div class="modal-content"><div class="modal-header"><h3>${esc(tr('账户额度周期'))}</h3>${button('close', '关闭')}</div><div class="modal-body quota-cycle"><p class="quota-note">${esc(tr('仅按额度筛选，不受请求维度影响。时间为上海时区。'))}</p><div class="cycle-filters"></div><p class="cycle-status" role="status" aria-live="polite"></p><div class="cycle-list"></div><div class="cycle-report"></div></div></div>`;
    const state = active = { intervalPage: 1, scope, query: new URLSearchParams(initial), accounts, root: dialog.querySelector('.quota-cycle'), page: 1, requestPage: 1, seq: 0 };
    state.root.querySelector('.cycle-filters').innerHTML = [['provider_id', '供应商', '全部供应商'], ['account_id', '额度账户', '全部账户'], ['window_key', '窗口', '全部窗口']].map(([name, title, all]) => {
      const values = new Map(); accounts.forEach(r => { if (r[name]) values.set(String(r[name]), name === 'provider_id' ? r.provider_name : name === 'account_id' ? r.label : windowLabel(r.window_key)); });
      const selected = state.query.get(name) || ''; if (selected && !values.has(selected)) values.set(selected, tr('当前筛选'));
      return `<label>${esc(tr(title))}<blora-select name="${name}"><blora-option value="">${esc(tr(all))}</blora-option>${[...values].map(([value, text]) => `<blora-option value="${esc(value)}">${esc(text)}</blora-option>`).join('')}</blora-select></label>`;
    }).join('') + button('apply', '查询');
    state.root.querySelectorAll('blora-select').forEach(el => { el.value = state.query.get(el.getAttribute('name')) || ''; });
    state.root.addEventListener('change', event => {
      if (event.target.getAttribute('name') === 'contribution_dimension') { state.dimension = event.target.value; renderContributors(state); return; }
      if (event.target.getAttribute('name') === 'contribution_rank') { state.rank = event.target.value; renderContributors(state); return; }
      if (event.target.getAttribute('name') !== 'provider_id') return;
      const provider = event.target.value, el = state.root.querySelector('[name="account_id"]');
      el.value = '';
      const values = new Map(state.accounts.filter(r => !provider || String(r.provider_id) === provider).map(r => [String(r.account_id), r.label]));
      el.innerHTML = `<blora-option value="">${esc(tr('全部账户'))}</blora-option>` + [...values].map(([value, text]) => `<blora-option value="${esc(value)}">${esc(text)}</blora-option>`).join('');
    });
    dialog.show(); list(state);
  }
  window.CrewRouterQuotaCycleReport = { open };
})();
