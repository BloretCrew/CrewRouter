(function () {
  'use strict';
  const states = new WeakMap();
  const tr = (key, vars) => window.I18N?.t(key, vars) || key.replace(/\{(\w+)\}/g, (_, name) => vars?.[name] ?? `{${name}}`);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const finite = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
  const number = (value, digits = 0) => finite(value) ? Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
  const date = value => !value || Number.isNaN(new Date(value).getTime()) ? '—' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const array = value => Array.isArray(value) ? value : [];
  const labels = { monthly: '每月', weekly: '每周', daily: '每日', primary: '主要窗口', secondary: '次要窗口', 'account-primary': '账户主要额度', 'account-secondary': '账户次要额度', seven_day: '7 天', five_hour: '5 小时', seven_day_opus: 'Opus · 7 天', seven_day_sonnet: 'Sonnet · 7 天', USD: '美元', CNY: '人民币', EUR: '欧元', GBP: '英镑', tokens: 'Token', credits: '积分', requests: '请求次数', balance: '余额', window: '使用窗口', percent: '使用率', unknown: '单位未提供' };
  const friendly = value => value ? tr(labels[value] || String(value).replace(/seven[_-]day/g, '7 天').replace(/five[_-]hour/g, '5 小时').replace(/[_-]/g, ' ')) : '—';
  const statuses = { success: '正常', ok: '正常', failed: '查询失败', error: '查询失败', partial: '部分成功', stale: '已过期', unknown: '状态未提供', cached: '缓存' };
  const status = row => tr(statuses[row.status] || '状态未提供') + (row.stale && row.status !== 'stale' ? ' / ' + tr('已过期') : '');
  const isWindow = row => row.kind === 'window' || row.unit === 'percent';
  const percent = value => finite(value) ? `${number(value)}%` : '—';
  const button = (action, text, extra = '') => `<button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-quota-action="${action}" ${extra}>${esc(tr(text))}</button>`;
  function select(name, label, choices) {
    return `<label>${esc(tr(label))}<blora-select name="${name}" value="" placeholder="${esc(tr(choices[0]?.[1] || label))}">${choices.map(([value, text]) => `<blora-option value="${esc(value)}">${esc(tr(text))}</blora-option>`).join('')}</blora-select></label>`;
  }
  function destroyCharts(state) {
    (state.charts || []).forEach(chart => chart.destroy());
    state.charts = [];
  }
  function mount(root, scope, providerId = '') {
    const context = root.dataset.quotaContext || 'overview';
    const previous = states.get(root);
    if (previous?.context === context && previous.scope === scope) return;
    if (previous) { ++previous.seq; ++previous.historySeq; destroyCharts(previous); previous.dispose(); }
    const state = { scope, context, providerId: String(providerId || ''), page: 1, seq: 0, historySeq: 0, accounts: [], charts: [], expanded: false };
    states.set(root, state);
    root.classList.add('quota-analysis');
    root.dataset.quotaView = context;
    const controls = `<div class="quota-controls">${select('provider_id', '供应商', [['', '全部供应商']])}${select('account_id', '额度账户', [['', '全部账户']])}${select('unit', '单位', [['', '全部单位']])}${select('window_key', '窗口', [['', '全部窗口']])}${select('status', '状态', [['', '全部状态'], ['success', '正常'], ['partial', '部分成功'], ['failed', '查询失败'], ['stale', '已过期']])}${button('apply', '查询')}${button('reset', '重置')}</div>`;
    const pagination = `<div class="quota-pagination">${button('prev', '上一页', 'disabled')}<span class="quota-page"></span>${button('next', '下一页', 'disabled')}</div>`;
    root.innerHTML = `<div class="quota-heading"><h4>${esc(tr(context === 'multi' ? '相关供应商额度' : context === 'dialog' ? '额度查询记录' : '供应商额度'))}</h4>${context === 'dialog' ? '' : button('history', '额度历史')}</div>
      ${context === 'dialog' ? controls : context === 'multi' ? `<details class="quota-filter-details"><summary>${esc(tr('额度筛选'))}</summary>${controls}</details>` : `<div hidden>${controls}</div>`}
      <p class="quota-status" role="status" aria-live="polite"></p>
      ${context === 'overview' ? '<div class="quota-summary"></div><details class="quota-cycle-summary"><summary></summary><div></div></details>' : ''}
      ${context !== 'dialog' ? '<div class="quota-accounts quota-provider-grid"></div><div class="quota-more"></div>' : `<div class="quota-history"><p class="quota-note">${esc(tr('仅按额度筛选，不受请求维度影响。时间为上海时区。'))}</p><div class="quota-history-visual"></div><details class="quota-history-table-details"><summary>${esc(tr('查看原始观测记录'))}</summary><div class="quota-table-wrap quota-history-rows"></div>${pagination}</details></div>`}
      ${context === 'overview' ? `<details class="quota-trend-details"><summary>${esc(tr('查看额度趋势'))}</summary><p class="quota-note quota-coverage"></p><div class="quota-trend-controls">${select('trend_metric', '趋势指标', [['remaining', '剩余额度'], ['used_percent', '窗口已用率'], ['observed_consumption', '观测消耗'], ['percent_change', '已用率变化（百分点）']])}</div><div class="quota-trend"></div><div class="quota-events quota-note"></div></details>` : ''}`;
    const click = event => {
      const el = event.target.closest('[data-quota-action]');
      if (!el || !root.contains(el)) return;
      const action = el.dataset.quotaAction;
      if (action === 'history') open(state.scope, el.dataset.provider || '', el.dataset.account || '');
      else if (action === 'cycles') openCycles(root, el.dataset.provider || '', el.dataset.account || '');
      else if (action === 'more') { state.expanded = !state.expanded; renderCards(root); }
      else if (action === 'apply' || action === 'reset') {
        if (action === 'reset') ['provider_id', 'account_id', 'unit', 'window_key', 'status'].forEach(name => { root.querySelector(`[name="${name}"]`).value = name === 'provider_id' ? state.providerId : ''; });
        state.page = 1;
        load(root);
        if (state.context === 'multi' && document.getElementById(`${state.scope}MultiDimension`)?.querySelector('[name="data_source"]')?.value === 'quota') window.CrewRouterMultiDimension?.load(state.scope);
      } else if (action === 'prev' || action === 'next') { state.page = Math.max(1, state.page + (action === 'next' ? 1 : -1)); history(root); }
    };
    const change = event => {
      if (event.target.name === 'trend_metric') renderTrend(root, state.data || {});
      if (event.target.name === 'provider_id') { root.querySelector('[name="account_id"]').value = ''; options(root, state.accounts); }
    };
    const trend = root.querySelector('.quota-trend-details');
    const toggle = () => { if (trend.open) renderTrend(root, state.data || {}); else destroyCharts(state); };
    root.addEventListener('click', click);
    root.addEventListener('change', change);
    trend?.addEventListener('toggle', toggle);
    state.dispose = () => { root.removeEventListener('click', click); root.removeEventListener('change', change); trend?.removeEventListener('toggle', toggle); };
    if (trend) root.querySelector('[name="trend_metric"]').value = 'remaining';
    options(root, []);
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
      const filters = state.scope === 'admin' ? { user_id: 'multiStatsUser', team_id: 'multiStatsTeam', model_id: 'multiStatsModel', request_source: 'multiStatsSource', workspace_path: 'multiStatsProject' } : { team_id: 'statsTeamFilter', model_id: 'statsModelFilter', request_source: 'statsSourceFilter' };
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
        if (id != null && String(id) !== '') map.set(String(id), name === 'provider_id' ? row.provider_name : name === 'account_id' ? friendly(row.label) : friendly(row[name]));
      });
      if (selected && !map.has(selected)) map.set(selected, selected === state.providerId ? tr('当前供应商') : tr('当前筛选'));
      const html = `<blora-option value="">${esc(tr(({ provider_id: '全部供应商', account_id: '全部账户', unit: '全部单位', window_key: '全部窗口' })[name]))}</blora-option>` + [...map].map(([id, label]) => `<blora-option value="${esc(id)}">${esc(label || tr('名称未提供'))}</blora-option>`).join('');
      if (el.dataset.quotaOptions !== html) {
        el.innerHTML = html;
        el.dataset.quotaOptions = html;
        el.value = selected;
      }
      if (name === 'provider_id' && state.providerId) el.disabled = true;
    }
  }
  function metric(row, compact = false) {
    if (isWindow(row)) return `<span class="quota-metric-label">${esc(friendly(row.window_key) === '—' ? tr('使用窗口') : friendly(row.window_key))}</span><strong>${esc(percent(row.used_percent))}</strong><span class="quota-note">${esc(tr('已用'))} · ${esc(tr('重置'))} ${esc(date(row.resets_at))}</span>`;
    if (row.kind === 'status' || (!row.kind && ![row.total, row.used, row.remaining].some(finite))) return `<span class="quota-note">${esc(tr('本次未取得有效额度；请查看查询状态。'))}</span>`;
    const unit = row.unit && row.unit !== 'unknown' ? friendly(row.unit) : tr('单位未提供');
    return `<span class="quota-metric-label">${esc(tr('余额'))} · ${esc(unit)}</span><strong>${esc(number(row.remaining, 2))}</strong><span class="quota-note">${esc(tr('剩余'))}${compact ? '' : ` · ${esc(tr('已用'))} ${esc(number(row.used, 2))} / ${esc(tr('总额'))} ${esc(number(row.total, 2))}`}</span>${row.quality?.unknown_used ? `<small class="quota-note">${esc(tr('上游未提供已用和剩余数据'))}</small>` : ''}`;
  }
  function groups(rows) {
    const providers = new Map();
    rows.forEach(row => {
      const key = String(row.provider_id);
      if (!providers.has(key)) providers.set(key, []);
      providers.get(key).push(row);
    });
    return [...providers];
  }
  function providerCards(rows, scope, multi = false, usage = []) {
    return groups(rows).map(([id, accounts]) => {
      const contribution = usage.filter(row => String(row.provider_id) === id);
      const total = key => contribution.length ? contribution.reduce((sum, row) => sum + (finite(row[key]) ? Number(row[key]) : 0), 0) : accounts[0][key];
      // Account rows repeat provider-wide contribution; never sum those rows.
      const related = multi ? `<p class="quota-contribution">${esc(tr('相关请求'))} <strong>${esc(number(total('requests')))}</strong> · Token ${esc(number(total('tokens')))} · ${esc(tr('积分'))} ${esc(number(total('cost'), 2))}</p>` : '';
      const item = row => `<div class="quota-account-item"><div class="quota-account-heading"><span>${esc(friendly(row.label) === '—' ? tr('额度账户') : friendly(row.label))}</span><span class="quota-state" data-state="${esc(row.status || 'unknown')}">${esc(status(row))}</span></div><div class="quota-metric">${metric(row, true)}</div></div>`;
      return `<article class="quota-provider-card" data-quota-provider-id="${esc(id)}"><header><h5>${esc(accounts[0].provider_name || tr('供应商名称未提供'))}</h5><div class="quota-card-actions">${button('history', '历史', `data-provider="${esc(id)}"`)}${button('cycles', '查看周期', `data-provider="${esc(id)}"`)}</div></header>${accounts.slice(0, 3).map(item).join('')}${accounts.length > 3 ? `<details class="quota-account-more"><summary>${esc(tr('更多账户 / 窗口'))} (${accounts.length - 3})</summary>${accounts.slice(3).map(item).join('')}</details>` : ''}${related}</article>`;
    }).join('');
  }
  function renderCards(root) {
    const state = states.get(root);
    const data = state.data || {};
    const rows = array(data.accounts);
    const providers = groups(rows);
    const limit = window.innerWidth <= 640 ? 3 : 6;
    const visible = new Set((state.expanded ? providers : providers.slice(0, limit)).map(([id]) => id));
    root.querySelector('.quota-accounts').innerHTML = rows.length ? providerCards(rows.filter(row => visible.has(String(row.provider_id))), state.scope, state.context === 'multi', array(data.usage_trend)) : `<p class="quota-note">${esc(tr('当前条件下暂无可见额度账户'))}</p>`;
    root.querySelector('.quota-more').innerHTML = providers.length > limit ? button('more', state.expanded ? '收起供应商' : '展开更多供应商', `aria-expanded="${state.expanded}"`) : '';
  }
  function historyTable(rows) {
    const headings = ['供应商 / 账户', '额度 / 窗口', '重置时间', '查询时间', '状态', '详情'];
    return `<table><thead><tr>${headings.map(label => `<th scope="col">${esc(tr(label))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => {
      const detail = [['有效观测时间', date(row.observed_at)], ['最近尝试时间', date(row.last_attempt_at || row.checked_at)], ['最近尝试状态', tr(statuses[row.last_attempt_status || row.status] || '状态未提供')]];
      if (!isWindow(row) && row.kind === 'balance') detail.push(['总额度', number(row.total, 2)], ['已用', number(row.used, 2)], ['剩余', number(row.remaining, 2)]);
      return `<tr><td data-label="${esc(tr(headings[0]))}"><strong>${esc(row.provider_name || tr('供应商名称未提供'))}</strong><span class="quota-cell-sub">${esc(friendly(row.label) === '—' ? tr('额度账户') : friendly(row.label))}</span></td><td data-label="${esc(tr(headings[1]))}"><div class="quota-metric">${metric(row)}</div></td><td data-label="${esc(tr(headings[2]))}">${esc(date(row.resets_at))}</td><td data-label="${esc(tr(headings[3]))}">${esc(date(row.checked_at))}</td><td data-label="${esc(tr(headings[4]))}"><span class="quota-state" data-state="${esc(row.status || 'unknown')}">${esc(status(row))}</span></td><td data-label="${esc(tr(headings[5]))}"><details class="quota-row-detail"><summary>${esc(tr('展开'))}</summary><dl>${detail.map(([label, value]) => `<dt>${esc(tr(label))}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details></td></tr>`;
    }).join('')}</tbody></table>`;
  }
  function renderHistoryVisual(root, rows, total) {
    const target = root.querySelector('.quota-history-visual');
    if (!target) return;
    target.replaceChildren();
    const snapshots = array(rows).filter(row => {
      const key = String(row.status || '').toLowerCase();
      return ['success', 'partial', 'ok', 'completed'].includes(key);
    });
    if (!snapshots.length) {
      target.innerHTML = `<p class="quota-history-empty">${esc(tr('当前筛选没有可绘制的成功观测；可展开原始记录查看查询状态。'))}</p>`;
      return;
    }
    const groups = new Map();
    snapshots.forEach(row => {
      const window = isWindow(row);
      const metricKey = window ? 'used_percent' : 'remaining';
      if (!finite(row[metricKey])) return;
      const key = JSON.stringify([row.provider_id, row.account_id, row.kind, row.unit, row.window_key || '']);
      if (!groups.has(key)) groups.set(key, { label: `${row.provider_name || tr('供应商')} / ${row.label || tr('额度账户')}${row.window_key ? ` / ${friendly(row.window_key)}` : ''}`, kind: window ? 'window' : 'balance', unit: window ? '%' : row.unit || 'unknown', rows: [] });
      groups.get(key).rows.push({ date: row.checked_at || row.observed_at, value: Number(row[metricKey]), row });
    });
    const series = [...groups.values()].filter(group => group.rows.length);
    if (!series.length || !window.Chart) {
      target.innerHTML = `<p class="quota-history-empty">${esc(series.length ? tr('图表组件暂不可用，请展开原始记录查看。') : tr('当前页记录没有可绘制的额度数值。'))}</p>`;
      return;
    }
    series.forEach(group => group.rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)));
    const timeKey = value => {
      const time = Date.parse(value || '');
      return Number.isFinite(time) ? new Date(time).toISOString() : '';
    };
    const labels = [...new Set(series.flatMap(group => group.rows.map(item => timeKey(item.date)).filter(Boolean)))].sort((a, b) => Date.parse(a) - Date.parse(b));
    const unitText = [...new Set(series.map(group => group.unit))].join(' / ');
    const section = document.createElement('section');
    section.className = 'quota-history-chart-card';
    const heading = document.createElement('div');
    heading.className = 'quota-history-chart-heading';
    heading.innerHTML = `<strong>${esc(tr('额度变化趋势'))}</strong><span>${esc(tr('当前页 {count} 条观测 · 共 {total} 条记录', { count: rows.length, total }))}</span>`;
    const hint = document.createElement('p');
    hint.className = 'quota-note';
    hint.textContent = tr('余额曲线显示剩余额度；窗口曲线显示已用百分比。成功观测按时间连接，查询失败不补值。');
    const chartBox = document.createElement('div');
    chartBox.className = 'quota-history-chart-box';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', tr('供应商额度历史趋势图'));
    chartBox.append(canvas);
    const legend = document.createElement('div');
    legend.className = 'quota-history-series-list';
    legend.innerHTML = series.map(group => `<span><i class="${group.kind === 'window' ? 'is-window' : 'is-balance'}"></i>${esc(group.label)} · ${esc(group.kind === 'window' ? tr('窗口已用') : tr('余额剩余'))}</span>`).join('');
    section.append(heading, hint, chartBox, legend);
    target.append(section);
    const colors = ['#0f766e', '#6366f1', '#d97706', '#dc2626', '#0891b2', '#7c3aed', '#16a34a', '#be123c'];
    const datasets = series.map((group, index) => ({
      label: `${group.label} · ${group.kind === 'window' ? tr('窗口已用') : tr('余额剩余')} (${group.unit})`,
      data: labels.map(label => {
        const point = group.rows.find(item => timeKey(item.date) === label);
        return point ? point.value : null;
      }),
      borderColor: colors[index % colors.length],
      backgroundColor: colors[index % colors.length],
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 5,
      tension: 0.18,
      spanGaps: false,
      yAxisID: group.kind === 'window' ? 'yPercent' : 'yAmount'
    }));
    const state = states.get(root);
    state.charts.push(new window.Chart(canvas, {
      type: 'line',
      data: { labels: labels.map(value => date(value)), datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: context => `${context.dataset.label}: ${Number(context.raw).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` } }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 7, maxRotation: 0, minRotation: 0 } },
          yAmount: { type: 'linear', position: 'left', beginAtZero: true, display: series.some(group => group.kind === 'balance'), title: { display: series.some(group => group.kind === 'balance'), text: unitText }, ticks: { callback: value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) } },
          yPercent: { type: 'linear', position: 'right', beginAtZero: true, max: 100, display: series.some(group => group.kind === 'window'), title: { display: series.some(group => group.kind === 'window'), text: tr('窗口已用（%）') }, grid: { drawOnChartArea: false }, ticks: { callback: value => `${value}%` } }
        }
      }
    }));
  }

  function renderTrend(root, data) {
    const state = states.get(root);
    const disclosure = root.querySelector('.quota-trend-details');
    if (!disclosure?.open) return;
    destroyCharts(state);
    const metric = root.querySelector('[name="trend_metric"]').value || 'remaining';
    const percentage = ['used_percent', 'percent_change'].includes(metric);
    const rows = array(data.trend).filter(row => finite(row[metric]) && (percentage ? isWindow(row) : !isWindow(row)));
    const target = root.querySelector('.quota-trend');
    target.replaceChildren();
    if (!rows.length || !window.Chart) { target.textContent = tr(rows.length ? '图表暂不可用，请查看额度历史。' : '暂无适用的额度趋势，实际查询后开始记录'); return; }
    const units = [...new Set(rows.map(row => percentage ? (metric === 'percent_change' ? tr('百分点') : '%') : row.unit || 'unknown'))];
    units.forEach(unit => {
      const selected = rows.filter(row => percentage || (row.unit || 'unknown') === unit);
      const days = [...new Set(selected.map(row => row.date || row.observed_at).filter(Boolean))].sort();
      const series = new Map();
      selected.forEach(row => {
        const key = JSON.stringify([row.provider_id, row.account_id, row.kind, row.window_key]);
        if (!series.has(key)) series.set(key, []);
        series.get(key).push(row);
      });
      const title = document.createElement('h5'); title.textContent = friendly(unit);
      const box = document.createElement('div'); box.className = 'quota-chart-box';
      const canvas = document.createElement('canvas'); box.append(canvas); target.append(title, box);
      state.charts.push(new window.Chart(canvas, { type: 'line', data: { labels: days, datasets: [...series.values()].map((values, index) => ({ label: `${values[0].provider_name || tr('供应商')} / ${friendly(values[0].label || tr('额度账户'))}${values[0].window_key ? ' / ' + friendly(values[0].window_key) : ''}`, data: days.map(day => { const row = values.find(item => (item.date || item.observed_at) === day); return finite(row?.[metric]) ? Number(row[metric]) : null; }), borderColor: ['#14b8a6', '#6366f1', '#f59e0b', '#ef4444'][index % 4], spanGaps: false })) }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { title: { display: true, text: friendly(unit) } } } } }));
    });
    const coverage = data.coverage || {};
    root.querySelector('.quota-coverage').textContent = `${tr('历史始于')} ${date(coverage.started_at || coverage.first_observed_at)} · ${tr('样本')} ${number(coverage.samples ?? coverage.sample_count)} · ${tr('采样缺口')} ${number(coverage.gaps ?? coverage.gap_count)}`;
    root.querySelector('.quota-events').textContent = tr('额度为上游观测，可能包含平台外使用。不同单位和窗口不可相加；重置、充值和稀疏采样会影响变化。');
  }
  function clear(root) {
    const state = states.get(root);
    destroyCharts(state);
    state.data = null;
    state.accounts = [];
    state.page = 1;
    ['.quota-summary', '.quota-cycle-summary > div', '.quota-cycle-summary > summary', '.quota-accounts', '.quota-more', '.quota-trend', '.quota-events', '.quota-coverage', '.quota-history-rows', '.quota-page'].forEach(selector => root.querySelector(selector)?.replaceChildren());
    ['provider_id', 'account_id', 'unit', 'window_key', 'status'].forEach(name => {
      const control = root.querySelector(`[name="${name}"]`);
      control.value = '';
      delete control.dataset.quotaOptions;
    });
    options(root, []);
    root.querySelectorAll('[data-quota-action="prev"], [data-quota-action="next"]').forEach(el => { el.disabled = true; });
  }
  async function load(root) {
    const state = states.get(root);
    if (!state) return;
    const seq = ++state.seq;
    ++state.historySeq;
    const message = root.querySelector('.quota-status');
    message.textContent = tr('正在加载...');
    if (state.context === 'dialog') root.querySelector('.quota-history-rows').replaceChildren();
    try {
      const data = await request(state.scope, '', params(root));
      if (seq !== state.seq) return;
      state.data = data;
      const accounts = array(data.accounts).filter(row => state.context !== 'multi' || (finite(row.requests) && Number(row.requests) > 0) || array(data.usage_trend).some(item => String(item.provider_id) === String(row.provider_id) && Number(item.requests) > 0));
      state.data = { ...data, accounts };
      if (!state.accounts.length || !root.querySelector('[name="provider_id"]').value) state.accounts = accounts;
      options(root, state.accounts);
      message.textContent = tr(state.context === 'dialog' ? '查询记录不等同于实时余额；未适用或未提供的数据以破折号显示。' : state.context === 'multi' ? '选定请求的供应商额度上下文，不代表请求成本分摊；贡献按供应商计一次。' : '最后有效观测，非实时余额；查询失败时可能保留旧值。');
      if (state.context === 'dialog') { await history(root); return; }
      if (state.context === 'overview') {
        const summary = data.summary || {};
        root.querySelector('.quota-summary').innerHTML = [['success', '正常'], ['low', '低额度'], ['failed', '查询失败'], ['stale', '已过期']].map(([key, label]) => `<div><span>${esc(tr(label))}</span><strong>${esc(number(summary[key] ?? summary[key + '_count']))}</strong></div>`).join('');
      }
      renderCards(root);
      renderTrend(root, data);
      if (state.context === 'overview') cycleSummary(root, seq);
    } catch (error) {
      if (seq !== state.seq) return;
      clear(root);
      message.textContent = error.message;
    }
  }
  async function history(root) {
    const state = states.get(root);
    if (state.context !== 'dialog') return;
    const seq = ++state.historySeq;
    const querySeq = state.seq;
    const target = root.querySelector('.quota-history-rows');
    root.querySelector('.quota-history-visual')?.replaceChildren();
    target.textContent = tr('正在加载...');
    root.querySelector('.quota-page').textContent = '';
    root.querySelectorAll('[data-quota-action="prev"], [data-quota-action="next"]').forEach(el => { el.disabled = true; });
    try {
      const query = params(root);
      ['user_id', 'team_id', 'model_id', 'request_source', 'workspace_path', 'api_key_id', 'data_source'].forEach(key => query.delete(key));
      query.set('page', state.page); query.set('limit', '20');
      const data = await request(state.scope, '/history', query);
      if (seq !== state.historySeq || querySeq !== state.seq) return;
      const rows = array(data.rows);
      renderHistoryVisual(root, rows, Number(data.total) || 0);
      target.innerHTML = rows.length ? historyTable(rows) : `<p class="quota-note">${esc(tr('暂无额度历史，实际查询后开始记录'))}</p>`;
      const tableDetails = root.querySelector('.quota-history-table-details');
      if (tableDetails) tableDetails.open = rows.length > 0;
      const page = Number(data.page) || state.page;
      const limit = Number(data.limit) || 20;
      const total = Number(data.total) || 0;
      state.page = page;
      root.querySelector('.quota-page').textContent = tr('第 {page} 页，共 {total} 条', { page, total });
      root.querySelector('[data-quota-action="prev"]').disabled = page <= 1;
      root.querySelector('[data-quota-action="next"]').disabled = page * limit >= total;
    } catch (error) {
      if (seq !== state.historySeq || querySeq !== state.seq) return;
      clear(root);
      target.textContent = error.message;
      root.querySelector('.quota-status').textContent = error.message;
    }
  }
  function openCycles(root, providerId = '', accountId = '') {
    const state = states.get(root);
    try {
      const query = params(root);
      if (providerId) query.set('provider_id', providerId);
      if (accountId) query.set('account_id', accountId);
      window.CrewRouterQuotaCycleReport?.open(state.scope, query, state.accounts);
    } catch (error) { root.querySelector('.quota-status').textContent = error.message; }
  }
  async function cycleSummary(root, seq) {
    const state = states.get(root), target = root.querySelector('.quota-cycle-summary');
    target.querySelector('summary').textContent = tr('周期状态');
    target.querySelector('div').replaceChildren();
    try {
      const query = params(root);
      ['user_id', 'team_id', 'model_id', 'request_source', 'workspace_path', 'api_key_id', 'data_source', 'status'].forEach(key => query.delete(key));
      query.set('page', '1'); query.set('limit', '20');
      const data = await request(state.scope, '/cycles', query);
      if (seq !== state.seq) return;
      const labels = { complete: '完整周期', partial: '部分周期', pending_reconciliation: '待对账', pending: '待对账', open: '进行中', active: '进行中', exhausted_pending_reconciliation: '待对账', reset_before_exhaustion: '重置前未耗尽', adjusted: '额度调整', invalidated: '报告失效' };
      target.querySelector('summary').textContent = tr('周期状态') + ' · ' + number(data.total);
      target.querySelector('div').innerHTML = array(data.rows).map(row => `<p class="quota-note">${esc(row.provider_name || state.accounts.find(r => String(r.account_id) === String(row.account_id))?.provider_name || tr('供应商'))} / ${esc(row.account_label || row.label || state.accounts.find(r => String(r.account_id) === String(row.account_id))?.label || tr('额度账户'))} · ${esc(tr(labels[row.state || row.status] || '状态未提供'))}</p>`).join('') + button('cycles', '查看周期');
    } catch (error) {
      if (seq !== state.seq) return;
      target.querySelector('div').textContent = error.message;
      if (error.message === tr('无权查看额度')) { clear(root); root.querySelector('.quota-status').textContent = error.message; }
    }
  }
  function refresh(scope) {
    document.querySelectorAll(`[data-quota-scope="${scope}"]`).forEach(root => {
      mount(root, scope);
      const state = states.get(root);
      const selectedProvider = document.getElementById(scope === 'admin' ? 'multiStatsProvider' : 'statsProviderFilter')?.value;
      if (state.context !== 'dialog' && selectedProvider !== undefined && state.externalProvider !== selectedProvider) {
        root.querySelector('[name="provider_id"]').value = selectedProvider;
        root.querySelector('[name="account_id"]').value = '';
        state.externalProvider = selectedProvider;
      }
      try {
        const key = params(root).toString();
        if (state.queryKey !== key) { state.page = 1; state.expanded = false; }
        state.queryKey = key;
      } catch (_) { state.page = 1; }
      load(root);
    });
  }
  function open(scope, providerId = '', accountId = '') {
    let dialog = document.getElementById('quotaHistoryDialog');
    if (!dialog) {
      dialog = document.createElement('blora-dialog'); dialog.id = 'quotaHistoryDialog';
      dialog.innerHTML = `<div class="modal-content"><div class="modal-header"><h3>${esc(tr('额度历史'))}</h3><button type="button" class="modal-close" aria-label="${esc(tr('关闭'))}">&times;</button></div><div class="modal-body"><section></section></div></div>`;
      document.body.append(dialog);
      dialog.querySelector('button').addEventListener('click', () => dialog.close ? dialog.close() : dialog.removeAttribute('open'));
    }
    const oldRoot = dialog.querySelector('section');
    const oldState = states.get(oldRoot);
    if (oldState) { ++oldState.seq; ++oldState.historySeq; destroyCharts(oldState); oldState.dispose(); }
    const root = document.createElement('section'); root.dataset.quotaContext = 'dialog'; oldRoot.replaceWith(root);
    mount(root, scope, providerId);
    root.querySelector('[name="account_id"]').value = String(accountId || '');
    options(root, []);
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
      root.innerHTML = `<h5>${esc(tr('最后有效观测'))}</h5><p class="quota-note">${esc(tr('最近查询失败时保留有效观测；这不是实时余额。'))}</p><div class="quota-provider-grid">${rows.length ? providerCards(rows, scope) : esc(tr('暂无有效额度观测'))}</div>`;
      root.querySelectorAll('[data-quota-action="history"]').forEach(el => el.addEventListener('click', () => open(scope, el.dataset.provider)));
      root.querySelectorAll('[data-quota-action="cycles"]').forEach(el => el.addEventListener('click', () => window.CrewRouterQuotaCycleReport?.open(scope, new URLSearchParams({ days: '30', provider_id: el.dataset.provider }), rows)));
    } catch (error) { if (Number(root.dataset.quotaSeq) === seq) root.textContent = error.message; }
  }
  async function library(root) {
    if (!root) return;
    const seq = Number(root.dataset.quotaSeq || 0) + 1;
    root.dataset.quotaSeq = seq;
    root.querySelectorAll('.quota-library-latest').forEach(panel => panel.remove());
    try {
      const data = await request('user', '', new URLSearchParams({ days: '30' }));
      if (Number(root.dataset.quotaSeq) !== seq) return;
      root.querySelectorAll('[data-quota-provider]').forEach(button => {
        const rows = array(data.accounts).filter(row => String(row.provider_id) === button.dataset.quotaProvider);
        if (!rows.length || !button.closest('article')) return;
        const panel = document.createElement('div'); panel.className = 'quota-library-latest quota-note';
        panel.innerHTML = `<strong>${esc(tr('最后有效观测'))}</strong>` + rows.map(row => `<div class="quota-account-item"><span>${esc(friendly(row.label) === '—' ? tr('额度账户') : friendly(row.label))} · ${esc(status(row))}</span><div class="quota-metric">${metric(row, true)}</div><small>${esc(date(row.observed_at))}</small></div>`).join('');
        button.before(panel);
      });
    } catch (_) {
      if (Number(root.dataset.quotaSeq) === seq) root.querySelectorAll('.quota-library-latest').forEach(panel => panel.remove());
    }
  }
  window.CrewRouterQuotaStats = { refresh, open, detail, library };
})();
