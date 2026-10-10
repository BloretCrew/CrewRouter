'use strict';

(function () {
  const state = document.getElementById('usageState');
  const content = document.getElementById('usageContent');
  const title = document.getElementById('usageTitle');
  const langToggle = document.getElementById('langToggle');

  function translate(key) {
    return typeof window.t === 'function' ? window.t(key) : key;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBigNumber(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '0';
    if (number >= 1000000000) return `${(number / 1000000000).toFixed(1)}B`;
    if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
    if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
    return number.toLocaleString();
  }

  function setState(kind, html) {
    if (state) {
      state.dataset.bloraState = kind;
      state.hidden = kind === 'success';
      state.innerHTML = html;
    }
    if (content) content.hidden = kind !== 'success';
  }

  function renderUsage(usage) {
    if (!Array.isArray(usage) || usage.length === 0) {
      setState('empty', `<p>${escapeHtml(translate('暂无使用记录'))}</p>`);
      return;
    }

    const byDate = {};
    usage.forEach((item) => {
      const date = String(item.date || '');
      if (!byDate[date]) byDate[date] = { tokens: 0, cost: 0, requests: 0, models: {} };
      const requests = Number.parseInt(item.requests, 10) || 0;
      byDate[date].tokens += Number.parseInt(item.tokens, 10) || 0;
      byDate[date].cost += Number.parseFloat(item.cost) || 0;
      byDate[date].requests += requests;
      const modelName = item.model_name || translate('(已删除)');
      byDate[date].models[modelName] = (byDate[date].models[modelName] || 0) + requests;
    });

    const rows = Object.entries(byDate).map(([date, data]) => `
      <tr>
        <td>${escapeHtml(new Date(date).toLocaleDateString('zh-CN'))}</td>
        <td>${data.requests.toLocaleString()}</td>
        <td title="${data.tokens.toLocaleString()}">${formatBigNumber(data.tokens)}</td>
        <td>${data.cost.toFixed(4)}</td>
        <td><div class="usage-model-list">${Object.entries(data.models).map(([model, count]) => `<span class="usage-model-tag">${escapeHtml(model)} (${count})</span>`).join('')}</div></td>
      </tr>
    `).join('');

    setState('success', '');
    if (content) {
      content.innerHTML = `
        <div class="usage-table-wrap">
          <table class="usage-detail-table">
            <thead><tr><th>${escapeHtml(translate('日期'))}</th><th>${escapeHtml(translate('请求数'))}</th><th>${escapeHtml(translate('Token'))}</th><th>${escapeHtml(translate('费用'))}</th><th>${escapeHtml(translate('模型分布'))}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }
  }

  async function load() {
    const keyId = new URLSearchParams(window.location.search).get('keyId');
    if (!/^\d+$/.test(String(keyId || ''))) {
      setState('error', `<p class="usage-error">${escapeHtml(translate('无效的 API Key'))}</p>`);
      return;
    }

    setState('loading', `<div class="page-loading page-loading-compact"><div class="loading-spinner md" role="status" aria-label="加载中"></div><div class="page-loading-text">${escapeHtml(translate('加载中...'))}</div></div>`);
    try {
      const response = await fetch(`/api/user/api-keys/${encodeURIComponent(keyId)}/usage`, { credentials: 'same-origin' });
      if (response.status === 401 || response.status === 403) {
        window.location.replace(`/console#apiKeys`);
        return;
      }
      if (!response.ok) throw new Error(translate('加载失败'));
      const usage = await response.json();
      renderUsage(usage);
    } catch (error) {
      setState('error', `<p class="usage-error">${escapeHtml(error.message || translate('加载失败'))}</p>`);
    }
  }

  function init() {
    langToggle?.addEventListener('change', () => window.I18N?.load(langToggle.value));
    const keyId = new URLSearchParams(window.location.search).get('keyId');
    if (title && /^\d+$/.test(String(keyId || ''))) title.textContent = `${translate('密钥用量详情')} #${keyId}`;
    window.I18N?.load(window.I18N.current()).then(load).catch(load);
  }

  init();
}());
