(() => {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const text = (key, vars) => window.AdminLibraryText ? window.AdminLibraryText(key, vars) : String(key).replace(/\{(\w+)\}/g, (match, name) => vars?.[name] ?? match);
  const html = (key, vars) => esc(text(key, vars));
  const bool = value => value === true || value === 'true' || value === 1;
  const button = (action, label, id = '') => `<button type="button" class="blora-button aml-button" data-variant="secondary" data-size="sm" data-action="${action}" data-id="${esc(id)}">${html(label)}</button>`;
  const icon = '<svg class="collapse-icon aml-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function menu(items, label = '更多操作') {
    return `<blora-dropdown class="library-more-menu" align="end"><button slot="trigger" type="button" class="blora-button library-more-trigger" data-variant="outline" data-size="sm" aria-label="${html(label)}">${html(label)}⌄</button>${items.map(([action, name, id = '']) => `<blora-dropdown-item value="admin-library:${esc(encodeURIComponent(JSON.stringify([action, id])))}">${html(name)}</blora-dropdown-item>`).join('')}</blora-dropdown>`;
  }

  function shell(markup, library) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const root = template.content;
    root.querySelector('.aml-header').innerHTML = `<div class="model-library-header-left"><h2>${html('模型库')}</h2><span class="model-library-header-hint">${html('浏览供应商模型，管理系统可用状态与 TEAM 授权。')}</span></div><div class="model-library-header-actions">${button('manage-providers', '供应商管理')}${button('add-provider', '添加供应商')}${menu([['add-model', '添加模型'], ['manage-models', '模型管理'], ...(library.canManageTeams() ? [['create-team', '创建 TEAM'], ['manage-teams', 'TEAM 管理']] : []), ['refresh', '刷新']], '更多')}</div>`;
    root.querySelector('[data-action="add-provider"]').dataset.variant = 'primary';
    root.querySelector('.aml-quota-overview').before(root.querySelector('.aml-scope'));
    root.querySelector('.aml-quota-overview').classList.add('model-quota-section');
    root.querySelector('.aml-quota-heading').classList.add('model-quota-section-header');
    root.querySelector('.aml-quota-heading').insertAdjacentHTML('afterbegin', `<h3>${html('供应商额度')}</h3>`);
    const toolbar = root.querySelector('.aml-toolbar');
    const batch = root.querySelector('.aml-selection');
    for (const control of batch.querySelectorAll('[data-action="select-page"], [data-action="enable-filtered"], [data-action="disable-filtered"]')) control.remove();
    batch.insertAdjacentHTML('beforeend', menu([['select-page', '选择已加载模型'], ['enable-filtered', '启用当前筛选'], ['disable-filtered', '关闭当前筛选']]));
    toolbar.insertAdjacentHTML('beforeend', '<div class="aml-batch-entry">' + menu([['select-page', '选择已加载模型'], ['enable-filtered', '启用当前筛选'], ['disable-filtered', '关闭当前筛选']], '批量操作') + '</div>');
    root.querySelector('.aml-toolbar-context').remove();
    root.querySelector('.aml-scope').insertAdjacentHTML('afterbegin', '<div class="aml-toolbar-context"></div>');
    const search = root.querySelector('input[data-filter="q"]');
    search.outerHTML = `<blora-search class="model-library-search" data-filter="q" label="${html('搜索模型')}" placeholder="${html('搜索模型、别名或供应商')}"></blora-search>`;
    const sort = root.querySelector('[data-filter="sort"]');
    root.querySelector('.aml-filter-panel').prepend(sort);
    for (const select of root.querySelectorAll('select[data-filter]')) {
      const custom = document.createElement('blora-select');
      for (const attribute of select.attributes) custom.setAttribute(attribute.name, attribute.value);
      custom.innerHTML = select.innerHTML;
      select.replaceWith(custom);
    }
    const advanced = root.querySelector('.aml-more-filters');
    advanced.querySelector('summary').className = 'blora-button';
    advanced.querySelector('summary').dataset.variant = 'secondary';
    advanced.querySelector('summary').dataset.size = 'sm';
    toolbar.append(root.querySelector('.aml-selection'));
    return template.innerHTML;
  }

  function provider(library, item) {
    const id = String(item.provider_id ?? item.id ?? item.provider ?? '');
    const expanded = library.expanded.has(id);
    const count = item.model_count ?? item.models_count ?? item.total_models ?? item.total ?? 0;
    const enabled = item.provider_enabled ?? item.enabled;
    const authorized = library.teamId ? item.team_enabled_count : item.system_enabled_count;
    return `<section class="blora-card model-library-provider aml-provider ${expanded ? '' : 'collapsed'}" data-variant="hover" data-provider="${esc(id)}" data-provider-id="${esc(id)}">
      <header class="model-library-provider-header aml-provider-header">
        <button type="button" class="model-library-provider-title aml-provider-toggle" data-action="expand" data-id="${esc(id)}" aria-expanded="${expanded}">
          ${icon}<span><strong>${esc(item.provider_name ?? item.name ?? item.provider ?? text('未命名供应商'))}</strong><small>${esc(item.format ?? item.type ?? '')}</small></span>
          ${(item.tags || []).map(tag => `<span class="blora-tag model-provider-tag-chip" data-variant="neutral">${esc(tag.name)}</span>`).join('')}
          <span class="provider-model-count aml-count">${html('{count} 个模型', { count })}</span>
        </button>
        ${enabled === false ? `<span class="blora-badge aml-badge aml-warning" data-variant="danger">${html('供应商已关闭')}</span>` : ''}
        <span class="aml-provider-summary">${html('{count} {status} · 额度 {quota}', { count: authorized ?? 0, status: text(library.teamId ? '已授权' : '系统启用'), quota: item.quota_remaining ?? item.remaining_quota ?? text('进入管理查看') })}</span>
        <button type="button" role="switch" class="aml-switch" aria-label="${html('供应商全局启用')}" aria-checked="${enabled !== false}" data-action="toggle-provider" data-id="${esc(id)}" data-enabled="${enabled === false}"><span></span></button>
        <div class="model-library-provider-actions">${menu([...(library.teamId ? [['enable-provider', '全部授权', id], ['disable-provider', '全部取消授权', id]] : []), ['quota-provider', '额度 / 刷新', id], ['trace-provider', '模型归因', id], ['edit-provider', '编辑', id], ['sync-provider', '同步模型', id], ['test-provider', '连通性', id], ['provider-manager', '完整管理', id]])}</div>
      </header>
      <div class="model-library-list aml-provider-content" ${expanded ? '' : 'hidden'}><div class="aml-model-grid"></div><div class="aml-model-pages"></div></div>
    </section>`;
  }

  function card(library, model) {
    const id = String(model.model_id ?? model.id ?? '');
    const systemEnabled = bool(model.system_enabled ?? model.enabled);
    const teamEnabled = bool(model.team_enabled ?? model.team_model_enabled ?? false);
    const providerEnabled = model.provider_enabled !== false;
    const enabled = library.teamId ? teamEnabled : systemEnabled;
    const available = systemEnabled && providerEnabled && (!library.teamId || teamEnabled);
    const tested = model.test_status ?? ((model.test_ok ?? model.last_test_ok) === true ? 'ok' : (model.test_ok ?? model.last_test_ok) === false ? 'failed' : 'untested');
    const passed = ['ok', 'success', 'pass'].includes(tested);
    const failed = ['failed', 'error', 'fail'].includes(tested);
    const testLabel = passed ? '测试成功' : failed ? '测试失败' : '未测试';
    const selected = library.selected.has(id);
    const latency = model.test_latency_ms ?? model.last_test_latency_ms;
    const speed = model.test_tokens_per_second ?? model.last_test_tokens_per_second;
    return `<article class="blora-card model-library-item aml-card ${selected ? 'selected is-selected' : ''} ${available ? '' : 'is-unavailable'}" data-variant="hover" data-model="${esc(id)}" data-model-id="${esc(id)}">
      <div class="model-library-item-info">
        <div class="model-library-item-name aml-card-heading">
          <label class="aml-check"><input type="checkbox" data-select="${esc(id)}" ${selected ? 'checked' : ''} ${library.busy ? 'disabled' : ''} aria-label="${html('选择 {name}', { name: model.alias || model.name || model.upstream_model_id })}"></label>
          <div class="aml-model-title"><strong>${esc(model.alias || model.name || model.upstream_model_id || id)}</strong><small>${esc(model.upstream_model_id || model.name || id)}</small></div>
          <button type="button" role="switch" class="aml-switch" aria-checked="${enabled}" aria-label="${html(library.teamId ? 'TEAM 授权 {name}' : '系统启用 {name}', { name: model.alias || model.name || model.upstream_model_id })}" data-action="toggle-model" data-id="${esc(id)}" data-enabled="${!enabled}" ${library.busy || (library.teamId && !systemEnabled && !teamEnabled) ? 'disabled' : ''} data-system-locked="${!!library.teamId && !systemEnabled && !teamEnabled}"><span></span></button>
          <div class="model-item-badges aml-statuses">
            <span class="blora-badge aml-badge ${available ? 'aml-success' : 'aml-warning'}" data-variant="${available ? 'success' : 'warning'}">${html(available ? '可调用' : !providerEnabled ? '供应商已关闭' : !systemEnabled ? '系统已关闭' : 'TEAM 未授权')}</span>
            <span class="blora-badge aml-badge" data-variant="neutral">${html(systemEnabled ? '系统已启用' : '系统已关闭')}</span>
            ${library.teamId ? `<span class="blora-badge aml-badge" data-variant="neutral">${html(teamEnabled ? 'TEAM 已授权' : 'TEAM 未授权')}</span>` : ''}
            <span class="blora-badge model-test-badge aml-badge ${passed ? 'pass' : failed ? 'fail' : ''}" data-variant="${passed ? 'success' : failed ? 'danger' : 'neutral'}" title="${esc(model.last_test_error || model.test_error || '')}">${html(testLabel)}${passed && latency != null ? ` · ${esc(latency)}ms` : ''}${passed && speed != null ? ` · ${esc(speed)} t/s` : ''}</span>
            ${model.series ? `<span class="blora-badge aml-badge" data-variant="neutral">${esc(model.series)}</span>` : ''}
          </div>
        </div>
        ${model.description ? `<div class="model-library-item-desc">${esc(model.description)}</div>` : ''}
        <div class="model-library-item-price aml-card-meta"><span class="model-price-item">${html('输入（每千 Token）{input} / 输出 {output}', { input: model.input_price_per_1k_tokens ?? model.input_price ?? '—', output: model.output_price_per_1k_tokens ?? model.output_price ?? '—' })}</span>${model.model_multiplier != null ? `<span class="model-price-item model-price-value">${html('倍率 {multiplier}', { multiplier: model.model_multiplier })}</span>` : ''}</div>
      </div>
      <footer class="model-library-item-actions aml-card-actions">
        ${library.teamId && !systemEnabled ? button('system-enable', '前往系统启用', id) : button('edit-model', '编辑', id)}${menu([['test-model', '测试', id], ['trace-model', '模型归因', id], ['uptime-model', '在线状态', id], ...(library.teamId && !systemEnabled ? [['edit-model', '编辑', id]] : []), ['model-manager', '高级管理', id]])}
      </footer>
    </article>`;
  }

  window.AdminLibraryConsoleView = { provider, card, shell };
})();
