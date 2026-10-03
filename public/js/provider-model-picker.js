/* Shared system-provider model picker for the admin page and console quick-add. */
const ProviderModelPicker = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let active = null;

  async function open({ providerId, providerName = '', onChanged, showToast }) {
    await Promise.all(['blora-dialog', 'blora-checkbox', 'blora-field'].map(tag => customElements.whenDefined(tag)));
    active?.close();
    const modal = Dialog.showModal({
      title: escape(t('获取模型列表')),
      content: `<div class="provider-model-picker model-picker">
        <div class="model-picker-toolbar">
          <div data-provider-name></div>
          <blora-field label="${escape(t('搜索模型名称...'))}"><input class="blora-input" type="search" data-model-search placeholder="${escape(t('搜索模型名称...'))}"></blora-field>
          <div class="provider-model-picker-tabs">${[['all', '全部'], ['enabled', '已启用'], ['disabled', '未启用'], ['stale', '已失效']].map(([filter, label]) => `<button type="button" class="blora-button" data-size="sm" data-filter="${filter}" data-variant="outline">${escape(t(label))}</button>`).join('')}</div>
          <div class="provider-model-picker-summary"><blora-checkbox data-select-all>${escape(t('全选'))}</blora-checkbox><span class="model-picker-count" data-model-count></span></div>
        </div>
        <div role="status" data-model-status></div>
        <div class="model-picker-scroll model-picker-flat" data-model-list></div>
      </div>`,
      footer: `<div class="provider-model-picker-footer"><button type="button" class="blora-button" data-variant="outline" data-cleanup hidden>${escape(t('清理已下架模型'))}</button><div><button type="button" class="blora-button" data-variant="outline" data-retry>${escape(t('重新获取'))}</button><button type="button" class="blora-button" data-variant="primary" data-save disabled>${escape(t('保存'))}</button></div></div>`,
      width: 1120
    });
    const root = modal.element;
    // Let the official close event finish portal restoration before removal.
    const close = () => root.close('api');
    root.classList.add('provider-model-picker-dialog');
    const find = selector => root.querySelector(selector);
    const list = find('[data-model-list]');
    const status = find('[data-model-status]');
    const search = find('[data-model-search]');
    const all = find('[data-select-all]');
    const save = find('[data-save]');
    const retry = find('[data-retry]');
    const cleanup = find('[data-cleanup]');
    let rows = [], selected = new Set(), filter = 'all', busy = false, loaded = false;
    const controller = new AbortController();
    active = { providerId, root, close, reload: () => load() };
    modal.promise.finally(() => { controller.abort(); if (active?.root === root) active = null; });

    function visibleRows() {
      const keyword = search.value.trim().toLowerCase();
      return rows.filter(row => (!keyword || `${row.id} ${row.name || ''}`.toLowerCase().includes(keyword)) &&
        (filter === 'all' || (filter === 'disabled' ? row.status === 'disabled' || row.status === 'new' : row.status === filter)));
    }
    function updateSelection() {
      const visible = visibleRows();
      all.checked = visible.length > 0 && visible.every(row => selected.has(row.id));
      all.toggleAttribute('disabled', busy || !visible.length);
      all.toggleAttribute('indeterminate', !all.checked && visible.some(row => selected.has(row.id)));
      save.disabled = busy || !loaded || rows.length === 0;
    }
    function render() {
      const visible = visibleRows();
      const visibleIds = new Set(visible.map(row => row.id));
      list.replaceChildren();
      rows.forEach((row, index) => {
        const item = document.createElement('div');
        item.className = 'model-check-item';
        item.hidden = !visibleIds.has(row.id);
        item.dataset.modelId = row.id;
        item.dataset.status = row.status;
        const labels = { enabled: ['success', '已启用'], disabled: ['neutral', '已禁用'], new: ['info', '新模型'], stale: ['warning', '已失效'] };
        const [variant, label] = labels[row.status];
        item.innerHTML = `<blora-checkbox value="${escape(row.id)}" id="${root.id}-model-${index}" ${selected.has(row.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}></blora-checkbox><label for="${root.id}-model-${index}"><span class="model-name">${escape(row.name || row.id)}</span>${row.name && row.name !== row.id ? `<span class="model-id">${escape(row.id)}</span>` : ''}<span class="blora-badge" data-variant="${variant}">${escape(t(label))}</span></label>`;
        list.append(item);
      });
      root.querySelectorAll('[data-filter]').forEach(button => {
        button.dataset.variant = button.dataset.filter === filter ? 'primary' : 'outline';
        button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
        button.disabled = busy;
      });
      const count = type => rows.filter(row => row.status === type).length;
      find('[data-model-count]').textContent = `${t('共')}${rows.length}${t('个')} · ${t('已启用')}${count('enabled')} · ${t('未启用')}${count('disabled')} · ${t('新模型')}${count('new')} · ${t('已失效')}${count('stale')}${search.value.trim() || filter !== 'all' ? ` · ${t('匹配')}${visible.length}${t('个')}` : ''}`;
      cleanup.hidden = count('stale') === 0;
      cleanup.textContent = `${t('清理已下架模型')} (${count('stale')})`;
      cleanup.disabled = busy;
      retry.disabled = busy;
      search.disabled = busy || !loaded;
      updateSelection();
    }
    async function request(suffix, options = {}) {
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/${suffix}`, { credentials: 'same-origin', signal: controller.signal, ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const attempts = data.debug?.attempts;
        throw new Error((data.error || t('请求失败')) + (attempts?.length ? '\n' + attempts.map(attempt => `${attempt.url}: ${attempt.error || `HTTP ${attempt.status}`}`).join('\n') : ''));
      }
      return data;
    }
    async function notifyChanged() {
      try { await onChanged?.(); } catch (error) { showToast?.(t('模型列表刷新失败') + ': ' + error.message, 'error'); }
    }
    async function load() {
      if (busy) return;
      busy = true; loaded = false; rows = []; selected.clear(); render();
      status.textContent = t('正在获取模型列表...');
      try {
        const data = await request('fetch-models');
        const models = Array.isArray(data.models) ? data.models : [];
        const existing = Array.isArray(data.existingModels) ? data.existingModels : [];
        const byId = new Map(existing.map(model => [String(model.id), model]));
        Object.entries(data.existingById || {}).forEach(([id, model]) => byId.set(id, model));
        const upstream = new Set();
        rows = models.filter(model => {
          const id = String(model.id || '');
          if (!id || upstream.has(id)) return false;
          upstream.add(id);
          return true;
        }).map(model => ({ ...model, id: String(model.id), status: byId.has(String(model.id)) ? (byId.get(String(model.id)).enabled ? 'enabled' : 'disabled') : 'new' }));
        rows.push(...existing.filter(model => !upstream.has(String(model.id))).map(model => ({ ...model, id: String(model.id), status: 'stale' })));
        selected = new Set([...byId].filter(([, model]) => model.enabled).map(([id]) => id));
        loaded = true;
        find('[data-provider-name]').textContent = data.provider_name || providerName;
        status.textContent = rows.length ? '' : (data.message || t('未获取到模型，可检查供应商配置后重试'));
        filter = 'all'; search.value = '';
      } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
      finally { busy = false; render(); }
    }
    async function persist() {
      if (busy || !loaded) return;
      const enabledModelIds = rows.filter(row => selected.has(row.id)).map(row => row.id);
      if (!enabledModelIds.length && !await Dialog.confirm(t('禁用全部模型？'), t('保存后将禁用该供应商下所有已有模型。确定继续吗？'), { confirmText: t('确认禁用全部'), danger: true })) return;
      if (!root.isConnected || busy) return;
      busy = true; render(); status.textContent = t('保存中...');
      try {
        await request('sync-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabledModelIds }) });
        showToast?.(t('模型列表已保存'), 'success');
        close(); await notifyChanged();
      } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
      finally { busy = false; if (root.isConnected) render(); }
    }
    async function clean() {
      if (busy) return;
      const stale = rows.filter(row => row.status === 'stale');
      if (!stale.length || !await Dialog.confirm(t('清理已下架模型'), `${t('将永久删除上游已不存在的本地模型记录（含 Team / API Key 绑定等关联数据）。此操作不可撤销。')}<br>${stale.slice(0, 8).map(row => escape(row.name || row.id)).join('、')}`, { confirmText: t('确认清理'), danger: true })) return;
      if (!root.isConnected || busy) return;
      busy = true; render(); status.textContent = t('清理中...');
      try {
        await request('cleanup-stale-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelIds: stale.map(row => row.systemId).filter(Boolean) }) });
        await notifyChanged(); busy = false; await load();
      } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
      finally { busy = false; if (root.isConnected) render(); }
    }
    root.addEventListener('change', event => {
      const checkbox = event.target.closest?.('blora-checkbox');
      if (!checkbox || busy) return;
      if (checkbox === all) {
        visibleRows().forEach(row => checkbox.checked ? selected.add(row.id) : selected.delete(row.id));
        render();
      } else {
        const id = checkbox.getAttribute('value');
        checkbox.checked ? selected.add(id) : selected.delete(id);
        updateSelection();
      }
    });
    list.addEventListener('click', event => {
      const label = event.target.closest('label');
      if (!label || !label.parentElement.matches('.model-check-item') || busy) return;
      event.preventDefault();
      const checkbox = label.parentElement.querySelector('blora-checkbox');
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    root.addEventListener('click', event => {
      const tab = event.target.closest('[data-filter]');
      if (tab && !busy) { filter = tab.dataset.filter; render(); }
    });
    search.addEventListener('input', render);
    retry.addEventListener('click', load);
    save.addEventListener('click', persist);
    cleanup.addEventListener('click', clean);
    await load();
    return modal;
  }
  return { open, reload: providerId => active?.providerId === providerId && active.reload() };
})();
