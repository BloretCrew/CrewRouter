(function () {
  'use strict';
  const tr = key => window.I18N?.t(key) || key;
  const numeric = ['reconciliation_seconds','max_tries','worker_interval_ms','batch_size','lease_seconds'];
  async function load() {
    const form = document.getElementById('requestQuotaConfigForm');
    if (!form) return;
    const message = form.querySelector('[role="status"]');
    const save = form.querySelector('[type="submit"]');
    save.disabled = true;
    try {
      const response = await fetch('/api/admin/request-quota-config');
      if (!response.ok) throw new Error(tr('请求额度配置加载失败'));
      const config = await response.json();
      form.querySelector('[name="enabled"]').checked = config.enabled;
      form.querySelector('[name="mode"]').value = config.mode;
      numeric.forEach(key => { form.querySelector(`[name="${key}"]`).value = config[key]; });
      save.disabled = false; message.textContent = '';
    } catch (error) { message.textContent = error.message; }
  }
  function init() {
    const form = document.getElementById('requestQuotaConfigForm');
    if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const save = form.querySelector('[type="submit"]');
      const message = form.querySelector('[role="status"]');
      const config = { enabled: form.querySelector('[name="enabled"]').checked, mode: form.querySelector('[name="mode"]').value };
      numeric.forEach(key => { config[key] = Number(form.querySelector(`[name="${key}"]`).value); });
      save.disabled = true;
      try {
        const response = await fetch('/api/admin/request-quota-config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || tr('请求额度配置保存失败'));
        message.textContent = tr('请求额度配置已保存');
      } catch (error) { message.textContent = error.message; }
      finally { save.disabled = false; }
    });
    load();
  }
  window.CrewRouterRequestQuotaConfig = { load };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
