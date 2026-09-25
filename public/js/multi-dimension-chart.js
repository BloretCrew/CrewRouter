(function () {
  const dimensions = {
    user: '成员', team: 'Team', project: '项目', source: '客户端', model: '模型', provider: '供应商', key: '密钥'
  };
  const metrics = { requests: '请求数', tokens: 'Token', cost: '积分' };
  const instances = new Map();

  function render(targetId, result) {
    const container = document.getElementById(targetId);
    if (!container) return;
    instances.get(targetId)?.destroy();
    instances.delete(targetId);
    const rows = result.rows || [];
    if (!rows.length) {
      container.innerHTML = '<p class="stats-insight-empty">当前条件下暂无数据</p>';
      return;
    }
    container.innerHTML = '<div class="multi-dimension-chart-container"><canvas></canvas></div><div class="multi-dimension-table-wrap"></div>';
    const format = value => result.metric === 'cost' ? Number(value).toFixed(4) : Number(value).toLocaleString();
    const names = rows.map(row => row.labels.map((label, index) => {
      if (result.dimensions[index] === 'source') return ({ grok: 'Grok', codex: 'Codex', claude_code: 'Claude Code', opencode: 'OpenCode', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw' })[label] || label || '未知客户端';
      return label === '__unknown__' ? '未识别项目' : (label || '未知');
    }).join(' / '));
    const values = rows.map(row => Number(row[result.metric]) || 0);
    const table = container.querySelector('.multi-dimension-table-wrap');
    table.innerHTML = `<table><thead><tr><th>${result.dimensions.map(key => dimensions[key]).join(' / ')}</th><th>${metrics[result.metric]}</th></tr></thead><tbody>${rows.map(row => `<tr><td></td><td>${format(row[result.metric])}</td></tr>`).join('')}</tbody></table>`;
    table.querySelectorAll('tbody tr td:first-child').forEach((cell, index) => { cell.textContent = names[index]; });
    if (typeof Chart !== 'undefined') {
      instances.set(targetId, new Chart(container.querySelector('canvas'), {
        type: 'bar',
        data: { labels: names, datasets: [{ label: metrics[result.metric], data: values, backgroundColor: '#14b8a6', borderRadius: 5 }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false } } } }
      }));
    }
  }

  async function load(scope) {
    const prefix = scope === 'admin' ? 'admin' : 'user';
    const root = document.getElementById(`${prefix}MultiDimension`);
    if (!root) return;
    const status = root.querySelector('.multi-dimension-status');
    const targetId = `${prefix}MultiDimensionResult`;
    const chosen = [...root.querySelectorAll('blora-checkbox[checked]')].map(el => el.getAttribute('value'));
    const seq = Number(root.dataset.requestSeq || 0) + 1;
    root.dataset.requestSeq = seq;
    if (!chosen.length) {
      instances.get(targetId)?.destroy();
      instances.delete(targetId);
      document.getElementById(targetId).replaceChildren();
      status.textContent = '请至少选择一个维度';
      return;
    }
    status.textContent = '正在加载...';
    try {
      const params = new URLSearchParams({
        dimensions: chosen.join(','), metric: root.querySelector('[name="metric"]').value,
        days: scope === 'admin' ? (document.getElementById('adminStatsDays')?.value || '30') : (document.getElementById('statsTimeRange')?.value || '30')
      });
      if (scope === 'user' && params.get('days') === 'custom') {
        const start = document.getElementById('statsStartDate')?.value;
        const end = document.getElementById('statsEndDate')?.value;
        if (!start || !end) {
          instances.get(targetId)?.destroy();
          instances.delete(targetId);
          document.getElementById(targetId).replaceChildren();
          status.textContent = '请选择自定义时间范围';
          return;
        }
        params.delete('days');
        params.set('start', start);
        params.set('end', end);
      }
      const response = await fetch(`/api/${scope}/stats/multi-dimension?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '加载失败');
      if (Number(root.dataset.requestSeq) !== seq) return;
      status.textContent = `展示 ${data.rows.length} 个组合（最多 30 个）`;
      render(targetId, data);
    } catch (error) {
      if (Number(root.dataset.requestSeq) === seq) status.textContent = error.message || '加载失败';
    }
  }

  function init() {
    for (const scope of ['admin', 'user']) {
      const root = document.getElementById(`${scope}MultiDimension`);
      if (!root || root.dataset.autoLoadBound) continue;
      root.dataset.autoLoadBound = 'true';
      root.addEventListener('change', event => {
        if (event.target.closest('blora-checkbox, blora-select[name="metric"]')) load(scope);
      });
    }
  }

  window.CrewRouterMultiDimension = { load, init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
