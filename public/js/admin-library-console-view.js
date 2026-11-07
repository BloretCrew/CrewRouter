(() => {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const text = (key, vars) => window.AdminLibraryText ? window.AdminLibraryText(key, vars) : String(key).replace(/\{(\w+)\}/g, (match, name) => vars?.[name] ?? match);
  const html = (key, vars) => esc(text(key, vars));
  const bool = value => value === true || value === 'true' || value === 1;
  const button = (action, label, id = '') => `<button type="button" class="blora-button aml-button" data-variant="secondary" data-size="sm" data-action="${action}" data-id="${esc(id)}">${html(label)}</button>`;
  const icon = '<span class="ml-collapse-icon aml-chevron" aria-hidden="true"><svg class="collapse-icon" width="14" height="14" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const formatLabel = format => ({ openai: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic' }[String(format || '').toLowerCase()] || format || '');

  function menu(items, label = '更多操作') {
    return `<blora-dropdown class="library-more-menu" align="end"><button slot="trigger" type="button" class="blora-button library-more-trigger ml-library-more-trigger" data-variant="outline" data-size="sm" aria-label="${html(label)}">${html(label)}⌄</button>${items.map(([action, name, id = '']) => `<blora-dropdown-item value="admin-library:${esc(encodeURIComponent(JSON.stringify([action, id])))}">${html(name)}</blora-dropdown-item>`).join('')}</blora-dropdown>`;
  }

  function upgradeFilters(root) {
    for (const search of root.querySelectorAll('input[data-filter="q"]')) {
      const sticky = search.hasAttribute('data-sticky');
      search.outerHTML = `<blora-search class="model-library-search${sticky ? ' model-library-sticky-search' : ''}" data-filter="q"${sticky ? ' data-sticky' : ''} id="${esc(search.id || '')}" label="${html('搜索模型')}" placeholder="${html('搜索模型、别名或供应商')}"></blora-search>`;
    }
    for (const select of root.querySelectorAll('select[data-filter]')) {
      const custom = document.createElement('blora-select');
      for (const attribute of select.attributes) custom.setAttribute(attribute.name, attribute.value);
      custom.innerHTML = select.innerHTML;
      select.replaceWith(custom);
    }
    const advanced = root.querySelector('.aml-more-filters');
    if (advanced) {
      const summary = advanced.querySelector('summary');
      if (summary) {
        summary.className = 'blora-button';
        summary.dataset.variant = 'secondary';
        summary.dataset.size = 'sm';
      }
    }
  }

  function shell(markup, library) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const root = template.content;
    const header = root.querySelector('.aml-header');
    if (header) {
      header.innerHTML = `<div class="model-library-header-left"><h2 class="ml-visually-hidden">${html('模型库')}</h2><span class="model-library-header-hint">${html('浏览供应商模型，管理系统可用状态与 TEAM 授权。')}</span></div><div class="model-library-header-actions">${button('manage-providers', '供应商管理')}${button('add-provider', '添加供应商')}${menu([['add-model', '添加模型'], ['manage-models', '模型管理'], ...(library.canManageTeams() ? [['create-team', '创建 TEAM'], ['manage-teams', 'TEAM 管理']] : []), ['refresh', '刷新']], '更多')}</div>`;
      const add = header.querySelector('[data-action="add-provider"]');
      const manage = header.querySelector('[data-action="manage-providers"]');
      if (add) add.dataset.variant = 'primary';
      if (manage) manage.dataset.variant = 'secondary';
    }

    const batchEntry = root.querySelector('.aml-batch-entry');
    if (batchEntry) batchEntry.innerHTML = menu([['select-page', '选择已加载模型'], ['enable-filtered', '启用当前筛选'], ['disable-filtered', '关闭当前筛选']], '批量操作');

    upgradeFilters(root);
    return template.innerHTML;
  }

  function provider(library, item) {
    const id = String(item.provider_id ?? item.id ?? item.provider ?? '');
    const expanded = library.expanded.has(id);
    const count = item.model_count ?? item.models_count ?? item.total_models ?? item.total ?? 0;
    const enabled = item.provider_enabled ?? item.enabled;
    const authorized = library.teamId ? item.team_enabled_count : item.system_enabled_count;
    const quota = item.quota_remaining ?? item.remaining_quota;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const locked = enabled === false;
    return `<section class="blora-card model-library-provider aml-provider ${expanded ? '' : 'collapsed'} ${locked ? 'provider-disabled' : ''}" data-variant="hover" data-provider="${esc(id)}" data-provider-id="${esc(id)}">
      ${locked ? '<div class="provider-disabled-overlay"></div>' : ''}
      <div class="model-library-provider-header aml-provider-header">
        <button type="button" class="model-library-provider-title aml-provider-toggle" data-action="expand" data-id="${esc(id)}" aria-expanded="${expanded}">
          ${icon}<span class="aml-provider-name"><strong>${esc(item.provider_name ?? item.name ?? item.provider ?? text('未命名供应商'))}</strong>${formatLabel(item.format ?? item.type) ? `<small>${esc(formatLabel(item.format ?? item.type))}</small>` : ''}</span>
        </button>
        ${tags.length ? `<div class="aml-provider-tags">${tags.slice(0, 4).map(tag => `<span class="blora-tag" data-variant="info">${esc(tag.name)}</span>`).join('')}${tags.length > 4 ? `<span class="aml-provider-tag-more">+${tags.length - 4}</span>` : ''}</div>` : ''}
        ${locked ? `<span class="blora-tag" data-variant="danger">${html('供应商已关闭')}</span>` : ''}
        <div class="model-library-provider-actions">
          <span class="provider-model-count ml-provider-model-count aml-count">${html('{count} 个模型', { count })}</span>
          <span class="aml-provider-auth">${html('{count} {status}', { count: authorized ?? 0, status: text(library.teamId ? '已授权' : '系统启用') })}</span>
          ${quota != null ? `<span class="aml-provider-quota">${html('额度')} ${esc(quota)}</span>` : ''}
          <blora-switch role="switch" class="aml-provider-switch" aria-label="${html('供应商全局启用（影响所有 TEAM）')}" title="${html('供应商全局启用（影响所有 TEAM）')}" aria-checked="${enabled !== false}" ${enabled !== false ? 'checked' : ''} data-action="toggle-provider" data-id="${esc(id)}" data-enabled="${enabled === false}"></blora-switch>
          ${menu([['edit-provider', '编辑', id], ['sync-provider', '同步模型', id], ['test-provider', '连通性', id], ['quota-provider', '额度 / 刷新', id], ['trace-provider', '模型归因', id], ...(library.teamId ? [['enable-provider', '全部授权', id], ['disable-provider', '全部取消授权', id]] : []), ['provider-manager', '完整管理', id]])}
        </div>
      </div>
      <div class="aml-provider-content" ${expanded ? '' : 'hidden'}>
        <div class="model-library-list aml-model-grid"></div>
        <div class="aml-model-pages"></div>
      </div>
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
    const input = model.input_price_per_1k_tokens ?? model.input_price;
    const output = model.output_price_per_1k_tokens ?? model.output_price;
    const hasPrice = input != null || output != null;
    const unavailableLabel = !providerEnabled ? '供应商已关闭' : !systemEnabled ? '系统已关闭' : library.teamId && !teamEnabled ? 'TEAM 未授权' : '不可用';
    const locked = !!library.teamId && !systemEnabled && !teamEnabled;
    const switchDisabled = library.busy || locked;
    const name = model.alias || model.name || model.upstream_model_id || id;
    const testBadge = passed
      ? `<span class="blora-tag ml-model-test-badge pass" data-variant="neutral">${esc(latency != null ? `${latency}ms` : text(testLabel))}${speed != null ? ` · ${esc(speed)} t/s` : ''}</span>`
      : failed
        ? `<span class="blora-tag ml-model-test-badge fail" data-variant="danger" title="${esc(model.last_test_error || model.test_error || '')}">${html('失败')}</span>`
        : `<span class="blora-badge model-test-badge aml-badge" data-variant="neutral">${html(testLabel)}</span>`;
    return `<article class="blora-card model-library-item aml-card ${selected ? 'selected is-selected' : ''} ${available ? '' : 'is-unavailable model-disabled'}" data-variant="hover" data-model="${esc(id)}" data-model-id="${esc(id)}">
      <div class="model-library-item-info">
        <div class="model-library-item-name aml-card-heading">
          <label class="aml-check"><input type="checkbox" data-select="${esc(id)}" ${selected ? 'checked' : ''} ${library.busy ? 'disabled' : ''} aria-label="${html('选择 {name}', { name })}"></label>
          <span class="ml-model-name aml-model-title"><strong>${esc(name)}</strong>${model.upstream_model_id && model.upstream_model_id !== name ? `<small>${esc(model.upstream_model_id)}</small>` : ''}</span>
        </div>
        <div class="ml-model-item-badges model-item-badges aml-statuses">
          <span class="blora-badge aml-badge ${available ? 'aml-success' : 'aml-warning'}" data-variant="${available ? 'success' : 'warning'}">${html(available ? '可调用' : unavailableLabel)}</span>
          ${testBadge}
          ${model.series ? `<span class="blora-tag" data-variant="neutral">${esc(model.series)}</span>` : ''}
        </div>
        ${model.description ? `<div class="model-library-item-desc">${esc(model.description)}</div>` : ''}
        <div class="model-library-item-price aml-card-meta">${hasPrice ? `<span class="model-price-item ml-model-price-item">${html('输入价/百万Token')} ${input == null ? '—' : `¥${esc(input)}`} · ${html('输出价/百万Token')} ${output == null ? '—' : `¥${esc(output)}`}</span>` : `<span class="model-price-item ml-model-price-item">${html('价格未设置')}</span>`}${model.model_multiplier != null ? `<span class="model-price-item model-price-value ml-model-price-value">${html('倍率 {multiplier}', { multiplier: model.model_multiplier })}</span>` : ''}</div>
      </div>
      <div class="model-library-item-actions aml-card-actions">
        <blora-switch role="switch" class="aml-model-switch" aria-checked="${enabled}" ${enabled ? 'checked' : ''} aria-label="${html(library.teamId ? 'TEAM 授权 {name}' : '系统启用 {name}', { name })}" data-action="toggle-model" data-id="${esc(id)}" data-enabled="${!enabled}" ${switchDisabled ? 'disabled' : ''} data-system-locked="${locked}"></blora-switch>
        ${library.teamId && !systemEnabled ? button('system-enable', '前往系统启用', id) : button('edit-model', '编辑', id)}${menu([['test-model', '测试', id], ['trace-model', '模型归因', id], ['uptime-model', '在线状态', id], ...(library.teamId && !systemEnabled ? [['edit-model', '编辑', id]] : []), ['model-manager', '高级管理', id]])}
      </div>
    </article>`;
  }

  window.AdminLibraryConsoleView = { provider, card, shell };
})();
