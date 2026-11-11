(function () {
  'use strict';

  const tr = key => window.I18N?.t(key) || key;

  async function csrfHeaders(extra = {}) {
    try {
      const response = await fetch('/api/csrf-token', { credentials: 'same-origin' });
      const data = response.ok ? await response.json() : {};
      if (data.token) return { ...extra, 'X-CSRF-Token': data.token };
    } catch (_) { /* 交给同源 Origin 校验 */ }
    return extra;
  }

  function status(text, isError) {
    const node = document.getElementById('agentWebStatus');
    if (!node) return;
    node.textContent = text || '';
    node.style.color = isError ? 'var(--destructive)' : 'var(--muted-foreground)';
  }

  function formEls() {
    const form = document.getElementById('agentWebConfigForm');
    if (!form) return null;
    return {
      form,
      searchEnabled: form.querySelector('[name="searchEnabled"]'),
      provider: form.querySelector('[name="provider"]'),
      apiKey: document.getElementById('agentWebApiKey'),
      maxResults: document.getElementById('agentWebMaxResults'),
      timeout: document.getElementById('agentWebTimeout'),
      fetchEnabled: form.querySelector('[name="fetchEnabled"]'),
      testQuery: document.getElementById('agentWebTestQuery'),
      testButton: document.getElementById('agentWebTestBtn'),
      save: form.querySelector('[type="submit"]')
    };
  }

  async function load() {
    const els = formEls();
    if (!els) return;
    els.save.disabled = true;
    try {
      const response = await fetch('/api/admin/agent-web', { credentials: 'same-origin' });
      if (response.status === 404) {
        status(tr('当前实例不支持 Agent 资料设置'), true);
        els.form.querySelectorAll('input, blora-checkbox, blora-select, button').forEach(node => { node.disabled = true; });
        return;
      }
      const config = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(config.error || tr('资料设置加载失败'));
      const search = config.search || {};
      const fetchConfig = config.fetch || {};
      els.searchEnabled.checked = search.enabled === true;
      els.provider.value = search.provider || 'tavily';
      els.apiKey.value = '';
      els.apiKey.placeholder = search.hasApiKey ? tr('已配置（留空保留）') : tr('未配置');
      els.maxResults.value = search.maxResults || 5;
      els.timeout.value = search.timeoutMs || 8000;
      els.fetchEnabled.checked = fetchConfig.enabled !== false;
      els.save.disabled = false;
      status('');
    } catch (error) {
      status(error.message || tr('资料设置加载失败'), true);
    }
  }

  async function save(event) {
    event.preventDefault();
    const els = formEls();
    if (!els) return;
    els.save.disabled = true;
    status('');
    const search = {
      enabled: els.searchEnabled.checked,
      provider: els.provider.value,
      maxResults: Number(els.maxResults.value) || 5,
      timeoutMs: Number(els.timeout.value) || 8000
    };
    const apiKey = els.apiKey.value.trim();
    if (apiKey) search.apiKey = apiKey;
    try {
      const response = await fetch('/api/admin/agent-web', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: await csrfHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          search,
          fetch: { enabled: els.fetchEnabled.checked }
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || tr('资料设置保存失败'));
      els.apiKey.value = '';
      els.apiKey.placeholder = result.search?.hasApiKey ? tr('已配置（留空保留）') : tr('未配置');
      status(tr('资料设置已保存'));
    } catch (error) {
      status(error.message || tr('资料设置保存失败'), true);
    } finally {
      els.save.disabled = false;
    }
  }

  async function test() {
    const els = formEls();
    if (!els) return;
    const query = (els.testQuery?.value || '').trim();
    if (!query) { status(tr('请输入测试查询词'), true); return; }
    els.testButton.disabled = true;
    status(tr('正在测试搜索...'));
    try {
      const response = await fetch('/api/admin/agent-web/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || result.message || tr('搜索测试失败'));
      const lines = (result.results || []).slice(0, 3).map((item, index) => {
        const title = String(item.title || '').trim() || tr('无标题');
        const url = String(item.url || '').trim();
        return `${index + 1}. ${title}${url ? ` — ${url}` : ''}`;
      });
      status([`${tr('搜索服务')}: ${result.provider || '-'}`, ...lines].join('\n'));
    } catch (error) {
      status(error.message || tr('搜索测试失败'), true);
    } finally {
      els.testButton.disabled = false;
    }
  }

  function init() {
    const els = formEls();
    if (!els) return;
    els.form.addEventListener('submit', save);
    els.testButton?.addEventListener('click', test);
    load();
  }

  window.CrewRouterAgentWebConfig = { load };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
