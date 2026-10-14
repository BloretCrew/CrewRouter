(() => {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const tr = (key, vars) => window.AdminLibraryText ? window.AdminLibraryText(key, vars) : String(key).replace(/\{(\w+)\}/g, (match, name) => vars?.[name] ?? match);
  const html = (key, vars) => esc(tr(key, vars));
  const bool = value => value === true || value === 'true' || value === 1;
  const modelId = model => String(model.model_id ?? model.id ?? '');
  const providerId = provider => String(provider.provider_id ?? provider.id ?? provider.provider ?? '');
  const button = (action, label, attrs = '', raw = false) => `<button type="button" class="aml-button" data-action="${action}" ${attrs}>${raw ? label : html(label)}</button>`;

  class AdminModelLibrary {
    constructor(adminApp) {
      this.app = adminApp;
      this.teamId = '';
      this.filters = { q: '', provider: '', series: '', tag: '', test: '', systemEnabled: '', teamEnabled: '', sort: 'name' };
      this.providers = [];
      this.teams = [];
      this.selected = new Set();
      this.groups = new Map();
      this.expanded = new Set();
      this.page = 1;
      this.limit = 20;
      this.modelLimit = 24;
      this.generation = 0;
      this.busy = false;
      this.controllers = new Set();
      this._click = event => this.onClick(event);
      this._change = event => this.onChange(event);
      this._input = event => this.onInput(event);
      this._language = () => this.renderLanguage();
    }

    async loadQuotaOverview() {
      const host = this.container?.querySelector('.aml-quota-host');
      if (!host) return;
      const widget = window.CrewRouterProviderQuotaStats;
      try {
        if (widget?.mount && widget?.load) {
          widget.mount(host, 'admin');
          await widget.load(host);
        } else if (window.CrewRouterQuotaStats?.refresh) {
          await window.CrewRouterQuotaStats.refresh('admin');
        } else host.textContent = tr('进入管理查看');
      } catch (error) {
        if (this.container?.querySelector('.aml-quota-host') === host) host.textContent = error.message;
      }
    }

    renderLanguage() {
      if (!this.container || !this.shell) return;
      const template = document.createElement('template');
      template.innerHTML = this.shell();
      const focused = this.container.contains(document.activeElement) ? document.activeElement : null;
      const focusFilter = focused?.dataset?.filter;
      const selection = focused?.selectionStart;
      const open = this.container.querySelector('.aml-more-filters').open;
      for (const selector of ['.aml-header', '.aml-toolbar', '.aml-quota-heading']) {
        this.container.querySelector(selector).replaceWith(template.content.querySelector(selector));
      }
      const more = this.container.querySelector('.aml-team-more');
      more.querySelector('summary').textContent = tr('更多 TEAM');
      const search = this.container.querySelector('[data-team-search]');
      search.placeholder = tr('搜索 TEAM 名称');
      search.setAttribute('aria-label', tr('搜索更多 TEAM'));
      this.container.querySelector('.aml-scope').setAttribute('aria-label', tr('模型范围'));
      this.container.querySelector('.aml-team-tabs').setAttribute('aria-label', tr('选择 TEAM'));
      this.container.querySelector('.aml-more-filters').open = open;
      this.renderTeams();
      if (this.optionData) this.updateOptions(this.optionData);
      else this.syncControls();
      if (this.total != null) {
        this.container.querySelector('.aml-summary').textContent = tr('{providers} 个供应商，{models} 个模型 · 模型按供应商展开加载', { providers: this.total, models: this.stats?.model_count ?? '—' });
        this.renderDirectory();
        for (const [id, group] of this.groups) {
          if (group.error) {
            const grid = this.providerElement(id)?.querySelector('.aml-model-grid');
            if (grid) grid.innerHTML = `<div class="aml-empty"><p>${html('模型加载失败：{error}', { error: group.error })}</p>${button('retry-provider', '重试', `data-id="${esc(id)}"`)}</div>`;
          } else if (group.items && !group.loading) this.renderProvider(id);
          else {
            const grid = this.providerElement(id)?.querySelector('.aml-model-grid');
            if (grid) grid.innerHTML = `<div class="aml-empty" role="status">${html('正在加载模型…')}</div>`;
          }
        }
      }
      this.renderSelection();
      if (focusFilter) {
        const control = this.container.querySelector(`[data-filter="${focusFilter}"]`);
        control?.focus();
        if (typeof selection === 'number') control?.setSelectionRange?.(selection, selection);
      }
    }

    canManageTeams() {
      return this.app._instance?.capabilities?.teamAdmin !== false;
    }

    mount(container) {
      if (typeof container === 'string') container = document.querySelector(container);
      if (!container) throw new Error(tr('模型库挂载容器不存在'));
      this.destroy();
      this.container = container;
      const restored = this.app._parseAdminHash?.(window.location?.hash || '');
      this.teamId = this.canManageTeams() ? String(restored?.teamId ?? this.teamId ?? '') : '';
      container.classList.add('admin-model-library');
      this.shell = () => `<header class="aml-header"><div><h2>${html('模型库')}</h2><p>${html('浏览供应商模型，管理系统可用状态与 TEAM 授权。')}</p></div><div class="aml-actions">${button('add-provider', '添加供应商')}${button('add-model', '添加模型')}${this.canManageTeams() ? button('create-team', '创建 TEAM') : ''}${button('manage-providers', '供应商管理')}${button('manage-models', '模型管理')}${this.canManageTeams() ? button('manage-teams', 'TEAM 管理') : ''}${button('refresh', '刷新')}</div></header>
        <section class="aml-quota-overview"><div class="aml-quota-heading"><span>${html('最后有效观测，非实时余额；查询失败时可能保留旧值。')}</span>${button('refresh-quotas', '刷新额度')}</div><div class="aml-quota-host" data-quota-scope="admin" data-quota-context="overview"></div></section>
        <section class="aml-scope" aria-label="${html('模型范围')}"><div class="aml-team-tabs" role="group" aria-label="${html('选择 TEAM')}"></div><details class="aml-team-more"><summary>${html('更多 TEAM')}</summary><div class="aml-team-panel"><input type="search" data-team-search placeholder="${html('搜索 TEAM 名称')}" aria-label="${html('搜索更多 TEAM')}"><div class="aml-team-results"></div></div></details><span class="aml-team-error" role="status"></span></section>
        <div class="aml-toolbar"><div class="aml-toolbar-context"></div><div class="aml-filter-row"><input type="search" data-filter="q" placeholder="${html('搜索模型、别名或供应商')}" aria-label="${html('搜索模型')}"><select data-filter="provider" aria-label="${html('供应商')}"><option value="">${html('全部供应商')}</option></select><select data-filter="sort" aria-label="${html('排序')}"><option value="name">${html('名称排序')}</option><option value="newest">${html('最新添加')}</option><option value="price_asc">${html('价格从低到高')}</option><option value="price_desc">${html('价格从高到低')}</option><option value="name_desc">${html('名称倒序')}</option><option value="test_latency">${html('测试延迟')}</option><option value="test_speed">${html('测试速度')}</option></select><details class="aml-more-filters"><summary>${html('更多筛选')}</summary><div class="aml-filter-panel"><label>${html('系列')}<select data-filter="series"><option value="">${html('全部系列')}</option></select></label><label>${html('供应商标签')}<select data-filter="tag"><option value="">${html('全部标签')}</option></select></label><label>${html('测试结果')}<select data-filter="test"><option value="">${html('全部结果')}</option><option value="untested">${html('未测试')}</option><option value="pass">${html('测试成功')}</option><option value="fail">${html('测试失败')}</option></select></label><label>${html('系统状态')}<select data-filter="systemEnabled"><option value="">${html('全部状态')}</option><option value="true">${html('系统已启用')}</option><option value="false">${html('系统已关闭')}</option></select></label><label class="aml-team-filter">${html('TEAM 授权')}<select data-filter="teamEnabled"><option value="">${html('全部授权')}</option><option value="true">${html('已授权')}</option><option value="false">${html('未授权')}</option></select></label>${button('reset', '清空筛选')}</div></details></div><div class="aml-selection"><span data-selection-count>${html('未选择模型')}</span>${button('select-page', '选择已加载模型')}${button('clear-selection', '清空选择')}${button('enable', '启用选中', 'data-batch')}${button('disable', '关闭选中', 'data-batch')}${button('test-selected', '测试选中', 'data-batch')}${button('enable-filtered', '启用当前筛选')}${button('disable-filtered', '关闭当前筛选')}<span class="aml-selection-hint">${html('勾选只用于批量操作，不改变开关')}</span></div></div>
        <div class="aml-notice" role="status" aria-live="polite" hidden></div><div class="aml-summary" aria-live="polite"></div><div class="aml-directory" aria-busy="false"></div><div class="aml-directory-pages"></div>`;
      container.innerHTML = this.shell();
      container.addEventListener('click', this._click);
      container.addEventListener('change', this._change);
      container.addEventListener('input', this._input);
      document.addEventListener?.('i18n:ready', this._language);
      this.renderTeams();
      this.syncControls();
      this.loadQuotaOverview();
      this.loadTeams();
      return this;
    }

    destroy() {
      clearTimeout(this.inputTimer);
      document.removeEventListener?.('i18n:ready', this._language);
      this.generation++;
      this.teamGeneration = (this.teamGeneration || 0) + 1;
      this.controllers.forEach(controller => controller.abort());
      this.controllers.clear();
      if (this.container) {
        this.container.removeEventListener('click', this._click);
        this.container.removeEventListener('change', this._change);
        this.container.removeEventListener('input', this._input);
      }
      this.container = null;
      this.groups.clear();
    }

    async request(url, options = {}) {
      if (!this.canManageTeams() && /^\/api\/admin\/teams(?:\/|\?|$)/.test(url)) throw new Error(tr('当前版本不支持 TEAM 管理'));
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) throw new Error(data.error || data.message || tr('请求失败 ({status})', { status: response.status }));
        return data;
      } finally {
        this.controllers.delete(controller);
      }
    }

    async loadTeams() {
      if (!this.canManageTeams()) { this.teams = []; this.teamId = ''; return; }
      const generation = (this.teamGeneration || 0) + 1;
      this.teamGeneration = generation;
      try {
        const data = await this.request('/api/admin/teams');
        if (generation !== this.teamGeneration) return;
        this.teams = Array.isArray(data) ? data : data.items || data.teams || [];
        if (this.container) {
          this.renderTeams();
          this.container.querySelector('.aml-team-error').textContent = '';
        }
      } catch (error) {
        if (error.name !== 'AbortError' && this.container) this.container.querySelector('.aml-team-error').innerHTML = `${html('TEAM 加载失败：{error}', { error: error.message })} ${button('retry-teams', '重试')}`;
      }
    }

    renderTeams(query = '') {
      if (!this.container) return;
      this.container.querySelector('.aml-scope').hidden = !this.canManageTeams();
      const teamLabel = team => `${esc(team.name ?? team.team_name)} <small>${html('{count} 成员', { count: team.member_count ?? 0 })}${team.is_default ? html(' · 默认') : ''}${team.is_frontier ? html(' · 前沿') : ''}${team.model_count != null || team.enabled_model_count != null ? ` · ${html('{count} 授权', { count: team.enabled_model_count ?? team.model_count })}` : ''}</small>`;
      const chip = (id, name) => button('team', name, `data-team="${esc(id)}" aria-pressed="${String(id) === this.teamId}"`, true);
      const current = this.teams.find(team => String(team.id ?? team.team_id) === this.teamId);
      const visible = this.teams.filter(team => !team.is_personal).slice(0, 5);
      if (current && !visible.includes(current)) visible.push(current);
      this.container.querySelector('.aml-team-tabs').innerHTML = chip('', html('全部模型')) + visible.map(team => chip(String(team.id ?? team.team_id), teamLabel(team))).join('');
      const search = this.container.querySelector('[data-team-search]');
      query = query || search.value || '';
      const matches = this.teams.filter(team => `${team.name ?? team.team_name ?? ''} ${team.description || ''}`.toLowerCase().includes(query.toLowerCase()));
      const chips = teams => teams.map(team => chip(String(team.id ?? team.team_id), teamLabel(team))).join('');
      const personal = matches.filter(team => team.is_personal);
      const results = this.container.querySelector('.aml-team-results');
      const personalOpen = results.querySelector?.('.aml-personal-teams')?.open || false;
      results.innerHTML = chips(matches.filter(team => !team.is_personal)) + (personal.length ? `<details class="aml-personal-teams" ${query || personalOpen ? 'open' : ''}><summary>${html('个人')} TEAM (${personal.length})</summary>${chips(personal)}</details>` : '') || `<p>${html('没有匹配的 TEAM')}</p>`;
      const context = this.container.querySelector('.aml-toolbar-context');
      context.innerHTML = this.teamId ? `<strong>${esc(current?.name ?? current?.team_name ?? tr('当前 TEAM'))}</strong><span class="aml-team-stats">${html('{count} 成员', { count: current?.member_count ?? 0 })}${current?.is_default ? html(' · 默认') : ''}${current?.is_frontier ? html(' · 前沿') : ''} · ${html('{count} 个筛选内授权', { count: this.stats?.team_enabled_count ?? current?.enabled_model_count ?? current?.model_count ?? '—' })}</span><span>${html('开关控制 TEAM 授权；系统或供应商关闭时仍不可调用。')}</span>${button('manage-teams', '管理此 TEAM')}` : `<strong>${html('全部模型')}</strong><span>${html('开关控制系统启用状态，影响所有 TEAM。')}</span>`;
      this.container.querySelector('.aml-team-filter').hidden = !this.teamId || !this.canManageTeams();
    }

    syncControls() {
      if (!this.container) return;
      this.container.querySelectorAll('[data-filter]').forEach(control => { control.value = this.filters[control.dataset.filter] || ''; });
      this.renderSelection();
    }

    query(mode, extra = {}) {
      const params = new URLSearchParams({ mode, view: mode, page: String(this.page), limit: String(this.limit), ...this.filters, ...extra });
      if (this.teamId && this.canManageTeams()) params.set('teamId', this.teamId);
      else { params.delete('teamId'); params.delete('teamEnabled'); }
      for (const [key, value] of [...params]) if (value === '') params.delete(key);
      return `/api/admin/model-library?${params}`;
    }

    async load(options = {}) {
      if (Object.prototype.hasOwnProperty.call(options, 'teamId')) {
        const next = this.canManageTeams() ? String(options.teamId ?? '') : '';
        if (next !== this.teamId) {
          this.teamId = next;
          this.selected.clear();
          this.expanded.clear();
          this.filters.teamEnabled = '';
          this.stats = {};
          this.page = 1;
        }
      }
      if (!this.canManageTeams()) { this.teamId = ''; this.filters.teamEnabled = ''; }
      if (!this.container) return;
      clearTimeout(this.inputTimer);
      const generation = ++this.generation;
      this.groups.clear();
      this.renderTeams();
      this.syncControls();
      const directory = this.container.querySelector('.aml-directory');
      directory.setAttribute('aria-busy', 'true');
      directory.innerHTML = `<div class="aml-empty" role="status">${html('正在加载供应商目录…')}</div>`;
      this.container.querySelector('.aml-directory-pages').innerHTML = '';
      try {
        const data = await this.request(this.query('providers'));
        if (generation !== this.generation || !this.container) return;
        this.providers = data.items || data.providers || [];
        this.total = Number(data.total ?? this.providers.length);
        this.page = Number(data.page || this.page);
        this.stats = data.stats || {};
        this.renderTeams();
        this.updateOptions(data);
        this.container.querySelector('.aml-summary').textContent = tr('{providers} 个供应商，{models} 个模型 · 模型按供应商展开加载', { providers: this.total, models: this.stats.model_count ?? this.stats.total_models ?? this.stats.models ?? '—' });
        this.renderDirectory();
        await Promise.all(this.providers.filter(provider => this.expanded.has(providerId(provider))).map(provider => this.loadProvider(providerId(provider))));
      } catch (error) {
        if (generation !== this.generation || error.name === 'AbortError' || !this.container) return;
        directory.innerHTML = `<div class="aml-empty"><strong>${html('供应商目录加载失败')}</strong><p>${esc(error.message)}</p>${button('refresh', '重试')}${button('manage-providers', '进入供应商管理')}</div>`;
      } finally {
        if (generation === this.generation && this.container) directory.setAttribute('aria-busy', 'false');
      }
    }

    updateOptions(data) {
      const select = this.container.querySelector('[data-filter="provider"]');
      this.optionData = data;
      const providers = data.provider_options || data.providers || this.providers;
      select.innerHTML = `<option value="">${html('全部供应商')}</option>` + providers.map(provider => `<option value="${esc(providerId(provider))}">${esc(provider.provider_name ?? provider.name ?? provider.provider)}</option>`).join('');
      if (this.filters.provider && ![...select.options].some(option => option.value === this.filters.provider)) select.add(new Option(this.filters.provider, this.filters.provider));
      const series = this.container.querySelector('[data-filter="series"]');
      series.innerHTML = `<option value="">${html('全部系列')}</option>` + (data.series || []).map(item => {
        const name = typeof item === 'string' ? item : item.name ?? item.series;
        return `<option value="${esc(name)}">${esc(name)}</option>`;
      }).join('');
      if (this.filters.series && ![...series.options].some(option => option.value === this.filters.series)) series.add(new Option(this.filters.series, this.filters.series));
      const tags = new Map();
      providers.forEach(provider => (provider.tags || []).forEach(tag => tags.set(String(tag.id), tag.name)));
      const tagSelect = this.container.querySelector('[data-filter="tag"]');
      tagSelect.innerHTML = `<option value="">${html('全部标签')}</option>` + [...tags].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      if (this.filters.tag && !tags.has(this.filters.tag)) tagSelect.add(new Option(this.filters.tag, this.filters.tag));
      this.syncControls();
    }

    renderDirectory() {
      const directory = this.container.querySelector('.aml-directory');
      directory.innerHTML = this.providers.map(provider => {
        const id = providerId(provider);
        const expanded = this.expanded.has(id);
        const count = provider.model_count ?? provider.models_count ?? provider.total_models ?? provider.total ?? 0;
        const enabled = provider.provider_enabled ?? provider.enabled;
        const quota = provider.quota_remaining ?? provider.remaining_quota;
        const authorized = this.teamId ? provider.team_enabled_count : provider.system_enabled_count;
        return `<section class="aml-provider" data-provider="${esc(id)}"><header class="aml-provider-header"><button type="button" class="aml-provider-toggle" data-action="expand" data-id="${esc(id)}" aria-expanded="${expanded}"><span class="aml-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span><span><strong>${esc(provider.provider_name ?? provider.name ?? provider.provider ?? tr('未命名供应商'))}</strong><small>${esc(provider.format ?? provider.type ?? '')}</small></span><span class="aml-count">${html('{count} 个模型', { count })}</span></button>${enabled === false ? `<span class="aml-badge aml-warning">${html('供应商已关闭')}</span>` : ''}<span class="aml-provider-summary">${html('{count} {status} · 额度 {quota}', { count: authorized ?? 0, status: tr(this.teamId ? '已授权' : '系统启用'), quota: quota ?? tr('进入管理查看') })}</span><button type="button" role="switch" class="aml-switch" aria-label="${html('供应商全局启用')}" aria-checked="${enabled !== false}" data-action="toggle-provider" data-id="${esc(id)}" data-enabled="${enabled === false}"><span></span></button><div class="aml-actions">${this.teamId ? button('enable-provider', '全部授权', `data-id="${esc(id)}"`) + button('disable-provider', '全部取消授权', `data-id="${esc(id)}"`) : ''}${button('quota-provider', '额度 / 刷新', `data-id="${esc(id)}"`)}${button('trace-provider', '模型归因', `data-id="${esc(id)}"`)}${button('edit-provider', '编辑', `data-id="${esc(id)}"`)}${button('sync-provider', '同步模型', `data-id="${esc(id)}"`)}${button('test-provider', '连通性', `data-id="${esc(id)}"`)}${button('provider-manager', '完整管理', `data-id="${esc(id)}"`)}</div></header><div class="aml-provider-content" ${expanded ? '' : 'hidden'}><div class="aml-model-grid"></div><div class="aml-model-pages"></div></div></section>`;
      }).join('') || `<div class="aml-empty"><strong>${html('没有符合条件的供应商')}</strong><p>${html('清空筛选，或进入供应商管理添加供应商。')}</p>${button('reset', '清空筛选')}${button('manage-providers', '供应商管理')}</div>`;
      this.container.querySelector('.aml-directory-pages').innerHTML = this.pagination(this.page, this.limit, this.total, 'directory-page');
    }

    providerElement(id) {
      return [...(this.container?.querySelectorAll('.aml-provider') || [])].find(element => element.dataset.provider === String(id));
    }

    pagination(page, limit, total, action, id = '') {
      const pages = Math.max(1, Math.ceil(total / limit));
      if (pages <= 1) return '';
      return `<div class="aml-pagination">${button(action, '上一页', `data-page="${page - 1}" data-id="${esc(id)}" ${page <= 1 ? 'disabled' : ''}`)}<span>${html('第 {page} / {pages} 页，共 {total} 个', { page, pages, total })}</span>${button(action, '下一页', `data-page="${page + 1}" data-id="${esc(id)}" ${page >= pages ? 'disabled' : ''}`)}</div>`;
    }

    async loadProvider(id, page = 1) {
      const generation = this.generation;
      const token = {};
      const previous = this.groups.get(id);
      this.groups.set(id, { ...previous, token, loading: true });
      const element = this.providerElement(id);
      if (!element) return;
      element.querySelector('.aml-model-grid').innerHTML = `<div class="aml-empty" role="status">${html('正在加载模型…')}</div>`;
      element.querySelector('.aml-model-pages').innerHTML = '';
      try {
        const data = await this.request(this.query('models', { provider: id, page: String(page), limit: String(this.modelLimit) }));
        if (generation !== this.generation || this.groups.get(id)?.token !== token || !this.container) return;
        this.groups.set(id, { items: data.items || [], page: Number(data.page || page), limit: Number(data.limit || this.modelLimit), total: Number(data.total ?? data.items?.length ?? 0), token });
        this.renderProvider(id);
      } catch (error) {
        if (generation !== this.generation || this.groups.get(id)?.token !== token || error.name === 'AbortError') return;
        this.groups.set(id, { token, items: [], error: error.message });
        const current = this.providerElement(id);
        if (current) current.querySelector('.aml-model-grid').innerHTML = `<div class="aml-empty"><p>${html('模型加载失败：{error}', { error: error.message })}</p>${button('retry-provider', '重试', `data-id="${esc(id)}"`)}</div>`;
      }
    }

    renderProvider(id) {
      const group = this.groups.get(id);
      const element = this.providerElement(id);
      if (!group || !element) return;
      element.querySelector('.aml-model-grid').innerHTML = group.items.map(model => this.card(model)).join('') || `<div class="aml-empty">${html('该供应商下暂无符合条件的模型。可清空筛选或通过「同步模型」添加。')}</div>`;
      element.querySelector('.aml-model-pages').innerHTML = this.pagination(group.page, group.limit, group.total, 'model-page', id);
      this.renderSelection();
    }

    card(model) {
      const id = modelId(model);
      const systemEnabled = bool(model.system_enabled ?? model.enabled);
      const teamEnabled = bool(model.team_enabled ?? model.team_model_enabled ?? false);
      const providerEnabled = model.provider_enabled !== false;
      const enabled = this.teamId ? teamEnabled : systemEnabled;
      const available = systemEnabled && providerEnabled && (!this.teamId || teamEnabled);
      const tested = model.test_status ?? ((model.test_ok ?? model.last_test_ok) === true ? 'ok' : (model.test_ok ?? model.last_test_ok) === false ? 'failed' : 'untested');
      const testLabel = tested === 'ok' || tested === 'success' || tested === 'pass' ? '测试成功' : tested === 'failed' || tested === 'error' || tested === 'fail' ? '测试失败' : '未测试';
      const selected = this.selected.has(id);
      return `<article class="aml-card ${selected ? 'is-selected' : ''} ${available ? '' : 'is-unavailable'}" data-model="${esc(id)}"><div class="aml-card-heading"><label class="aml-check"><input type="checkbox" data-select="${esc(id)}" ${selected ? 'checked' : ''} ${this.busy ? 'disabled' : ''} aria-label="${html('选择 {name}', { name: model.alias || model.name || model.upstream_model_id })}"></label><div class="aml-model-title"><strong>${esc(model.alias || model.name || model.upstream_model_id || id)}</strong><small>${esc(model.upstream_model_id || model.name || id)}</small></div><button type="button" role="switch" class="aml-switch" aria-checked="${enabled}" aria-label="${html(this.teamId ? 'TEAM 授权 {name}' : '系统启用 {name}', { name: model.alias || model.name || model.upstream_model_id })}" data-action="toggle-model" data-id="${esc(id)}" data-enabled="${!enabled}" ${this.busy || (this.teamId && !systemEnabled && !teamEnabled) ? 'disabled' : ''} data-system-locked="${!!this.teamId && !systemEnabled && !teamEnabled}"><span></span></button></div><div class="aml-statuses"><span class="aml-badge ${available ? 'aml-success' : 'aml-warning'}">${html(available ? '可调用' : !providerEnabled ? '供应商已关闭' : !systemEnabled ? '系统已关闭' : 'TEAM 未授权')}</span><span class="aml-badge">${html(systemEnabled ? '系统已启用' : '系统已关闭')}</span>${this.teamId ? `<span class="aml-badge">${html(teamEnabled ? 'TEAM 已授权' : 'TEAM 未授权')}</span>` : ''}<span class="aml-badge" title="${esc(model.last_test_error || model.test_error || '')}">${html(testLabel)}</span>${model.series ? `<span class="aml-badge">${esc(model.series)}</span>` : ''}</div><p class="aml-description">${esc(model.description || tr('暂无描述'))}</p><div class="aml-card-meta"><span>${html('输入（每千 Token）{input} / 输出 {output}', { input: model.input_price_per_1k_tokens ?? model.input_price ?? '—', output: model.output_price_per_1k_tokens ?? model.output_price ?? '—' })}</span>${model.model_multiplier != null ? `<span>${html('倍率 {multiplier}', { multiplier: model.model_multiplier })}</span>` : ''}</div><footer class="aml-card-actions">${this.teamId && !systemEnabled ? button('system-enable', '前往系统启用', `data-id="${esc(id)}"`) : ''}${button('trace-model', '模型归因', `data-id="${esc(id)}"`)}${button('uptime-model', '在线状态', `data-id="${esc(id)}"`)}${button('edit-model', '编辑', `data-id="${esc(id)}"`)}${button('test-model', '测试', `data-id="${esc(id)}"`)}${button('model-manager', '高级管理', `data-id="${esc(id)}"`)}</footer></article>`;
    }

    renderSelection() {
      if (!this.container) return;
      this.container.querySelector('[data-selection-count]').textContent = this.selected.size ? tr('已选择 {count} 个模型（含其他页）', { count: this.selected.size }) : tr('未选择模型');
      this.container.querySelectorAll('[data-batch]').forEach(control => { control.disabled = !this.selected.size || this.busy; });
      this.container.querySelectorAll('[data-select]').forEach(control => {
        control.checked = this.selected.has(control.dataset.select);
        control.disabled = this.busy;
        control.closest('.aml-card').classList.toggle('is-selected', control.checked);
      });
      this.container.querySelectorAll('[data-action="toggle-model"]').forEach(control => { control.disabled = this.busy || control.dataset.systemLocked === 'true'; });
      this.container.querySelectorAll('[data-action="team"], [data-action="select-page"], [data-action="clear-selection"]').forEach(control => { control.disabled = this.busy; });
    }

    notice(message, error = false) {
      if (!this.container) return;
      const notice = this.container.querySelector('.aml-notice');
      notice.hidden = false;
      notice.classList.toggle('is-error', error);
      notice.textContent = message;
    }

    findModel(id) {
      for (const group of this.groups.values()) {
        const model = group.items?.find(item => modelId(item) === String(id));
        if (model) return model;
      }
      return null;
    }

    async setEnabled(ids, enabled, single = false, range = tr('选中模型')) {
      if (!ids.length || this.busy) return;
      ids = [...new Set(ids)];
      const generation = this.generation;
      const teamId = this.canManageTeams() ? this.teamId : '';
      if (teamId && enabled && single && !bool(this.findModel(ids[0])?.system_enabled ?? this.findModel(ids[0])?.enabled)) { this.notice(tr('系统模型已关闭，请先前往系统启用。'), true); return; }
      const team = this.teams.find(item => String(item.id ?? item.team_id) === teamId);
      const scope = teamId ? tr('TEAM「{name}」模型授权', { name: team?.name ?? team?.team_name ?? teamId }) : tr('系统模型状态（影响所有 TEAM）');
      if ((!enabled || !single) && !await window.confirm(tr('{action}{scope}？\n范围：{range}；数量：{count} 个模型。{warning}', { action: tr(enabled ? '启用' : '关闭'), scope, range, count: ids.length, warning: !enabled && teamId ? tr('\n关闭后相关 API Key 模型绑定将被清理。') : '' }))) return;
      if (generation !== this.generation || teamId !== (this.canManageTeams() ? this.teamId : '')) { this.notice(tr('范围已变更，请重新执行操作。'), true); return; }
      this.busy = true;
      this.mutating = true;
      this.renderSelection();
      let result;
      try {
        let url = '/api/admin/models/batch-update';
        let method = 'POST';
        let body = { ids, enabled };
        if (teamId) {
          url = `/api/admin/teams/${encodeURIComponent(teamId)}/models/${single ? encodeURIComponent(ids[0]) : 'batch'}`;
          method = single ? 'PUT' : 'POST';
          body = single ? { enabled } : { modelIds: ids, enabled };
        }
        result = await this.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        this.app._invalidateAdminProviderModelsCache?.();
        this.app._notifyModelsCatalogChanged?.();
        this.container?.dispatchEvent(new CustomEvent('admin-model-library:changed', { bubbles: true, detail: { teamId: teamId || null, modelIds: ids, enabled, result } }));
      } catch (error) {
        this.notice(tr('操作失败：{error}，请刷新确认状态后重试。', { error: error.message }), true);
      } finally {
        this.busy = false;
        this.mutating = false;
        this.renderSelection();
      }
      if (result) {
        await this.load();
        this.notice(tr(result.cleared_keys ? '已{action} {count} 个模型，清理 {keys} 个 Key 绑定。' : '已{action} {count} 个模型。', { action: tr(enabled ? '启用' : '关闭'), count: result.updated ?? ids.length, keys: result.cleared_keys }));
      }
    }

    async collectModelIds(provider = null) {
      const generation = this.generation;
      const ids = new Set();
      const signature = JSON.stringify({ teamId: this.teamId, filters: this.filters });
      const extra = provider ? { provider, q: '', series: '', tag: '', test: '', systemEnabled: '', teamEnabled: '' } : {};
      for (let page = 1; ; page++) {
        const data = await this.request(this.query('models', { ...extra, page: String(page), limit: '200' }));
        if (generation !== this.generation || signature !== JSON.stringify({ teamId: this.teamId, filters: this.filters })) throw new Error(tr('范围已变更，请重新执行批量操作'));
        const items = data.items || [];
        items.forEach(model => ids.add(modelId(model)));
        if (page * Number(data.limit || 200) >= Number(data.total || 0)) break;
        if (!items.length) throw new Error(tr('分页返回不完整，未执行批量操作'));
      }
      return [...ids];
    }

    async batchRange(enabled, provider) {
      if (this.busy || this.collecting || (provider && (!this.teamId || !this.canManageTeams()))) return;
      this.collecting = true;
      let ids;
      try { ids = await this.collectModelIds(provider); } finally { this.collecting = false; }
      if (!ids.length) { this.notice(tr('该范围没有模型可操作。')); return; }
      const item = this.providers.find(item => providerId(item) === provider);
      const range = provider ? tr('供应商「{name}」全部模型（不受当前筛选限制）', { name: item?.name ?? item?.provider_name ?? provider }) : tr('当前筛选匹配的全部模型（跨所有分页）：{filters}', { filters: Object.entries(this.filters).filter(([key, value]) => value && key !== 'sort').map(([key, value]) => `${key}=${value}`).join(', ') || tr('无筛选') });
      await this.setEnabled(ids, enabled, false, range);
    }

    async openManager(kind, id) {
      if (kind === 'teams' && !this.canManageTeams()) return;
      if (typeof this.app.openLibraryManager !== 'function') throw new Error(tr('管理面板尚未接入，请联系管理员'));
      await this.app.openLibraryManager(kind, id || undefined);
    }

    async catalogChanged(options = {}) {
      if (this.mutating) return;
      if (this.catalogPromise) return this.catalogPromise;
      this.catalogPromise = this.refreshCatalog(options).finally(() => { this.catalogPromise = null; });
      return this.catalogPromise;
    }

    async refreshCatalog(options) {
      if (options.teams) await this.loadTeams();
      if (options.clearSelection) this.selected.clear();
      await this.load();
      await this.loadQuotaOverview();
    }

    onInput(event) {
      const target = event.target;
      if (target.matches('[data-team-search]')) {
        this.renderTeams(target.value.trim());
        return;
      }
      if (!target.matches('input[data-filter]')) return;
      this.filters[target.dataset.filter] = target.value.trim();
      clearTimeout(this.inputTimer);
      this.inputTimer = setTimeout(() => { this.page = 1; this.load(); }, 250);
    }

    onChange(event) {
      const target = event.target;
      if (target.matches('[data-select]')) {
        if (target.checked) this.selected.add(target.dataset.select);
        else this.selected.delete(target.dataset.select);
        this.renderSelection();
      } else if (target.matches('select[data-filter]')) {
        this.filters[target.dataset.filter] = target.value;
        this.page = 1;
        this.load();
      }
    }

    async onClick(event) {
      const control = event.target.closest('[data-action]');
      if (!control || !this.container?.contains(control) || control.disabled) return;
      const action = control.dataset.action;
      const id = control.dataset.id;
      try {
        if (action === 'team') {
          if (this.busy || !this.canManageTeams()) return;
          this.app._writeAdminHash?.('adminModelLibrary', { teamId: control.dataset.team || null });
          this.container.querySelector('.aml-team-more').open = false;
          await this.load({ teamId: control.dataset.team });
        } else if (action === 'add-provider') { await this.openManager('providers'); await this.app.showAddProviderWizard(); }
        else if (action === 'add-model') { await this.openManager('models'); this.app.showAddModelModal(); }
        else if (action === 'create-team') { if (!this.canManageTeams()) return; await this.openManager('teams'); this.app.showCreateTeamModal(); }
        else if (action === 'system-enable') { this.filters.q = id; this.filters.provider = ''; this.filters.series = ''; this.filters.tag = ''; this.filters.test = ''; this.filters.systemEnabled = ''; this.app._writeAdminHash?.('adminModelLibrary', { teamId: null }); await this.load({ teamId: null }); this.notice(tr('已切换全部模型，请启用系统模型后返回 TEAM 配置。')); }
        else if (action === 'trace-model') window.ModelTrace?.open(id);
        else if (action === 'trace-provider') window.ModelTrace?.open(null, { providerId: id });
        else if (action === 'uptime-model') await this.app.showModelUptimeDetail(id, this.findModel(id)?.name || id);
        else if (action === 'refresh-quotas') {
          if (this.refreshingQuotas) return;
          this.refreshingQuotas = true;
          control.disabled = true;
          try { await this.openManager('providers'); await this.app.refreshPageQuotas(); }
          finally { this.refreshingQuotas = false; control.disabled = false; }
        }
        else if (action === 'quota-provider') { await this.openManager('providers', id); await this.app.checkProviderQuota(id); }
        else if (action === 'toggle-provider') {
          const enabled = control.dataset.enabled === 'true';
          if (!enabled && !await window.confirm(tr('关闭此供应商？将影响所有 TEAM 的调用。'))) return;
          this.mutating = true;
          try { await this.openManager('providers', id); await this.app.toggleProviderEnabled(id, enabled); } finally { this.mutating = false; }
          await this.load();
        } else if (['enable-provider', 'disable-provider', 'enable-filtered', 'disable-filtered'].includes(action)) {
          await this.batchRange(action.startsWith('enable'), action.endsWith('provider') ? id : null);
        } else if (action === 'refresh') await this.load();
        else if (action === 'retry-teams') await this.loadTeams();
        else if (action === 'reset') {
          Object.keys(this.filters).forEach(key => { this.filters[key] = key === 'sort' ? 'name' : ''; });
          this.page = 1;
          this.syncControls();
          await this.load();
        } else if (action === 'expand') {
          const element = this.providerElement(id);
          const expanded = !this.expanded.has(id);
          if (expanded) this.expanded.add(id); else this.expanded.delete(id);
          control.setAttribute('aria-expanded', String(expanded));
          control.querySelector('.aml-chevron').textContent = expanded ? '▾' : '▸';
          element.querySelector('.aml-provider-content').hidden = !expanded;
          if (expanded && !this.groups.has(id)) await this.loadProvider(id);
        } else if (action === 'model-page' || action === 'retry-provider') await this.loadProvider(id, Number(control.dataset.page || 1));
        else if (action === 'directory-page') { this.page = Number(control.dataset.page); await this.load(); }
        else if (action === 'select-page') {
          for (const provider of this.providers) {
            const key = providerId(provider);
            if (this.expanded.has(key)) this.groups.get(key)?.items?.forEach(model => this.selected.add(modelId(model)));
          }
          this.renderSelection();
        } else if (action === 'clear-selection') { this.selected.clear(); this.renderSelection(); }
        else if (action === 'toggle-model') await this.setEnabled([id], control.dataset.enabled === 'true', true);
        else if (action === 'enable' || action === 'disable') await this.setEnabled([...this.selected], action === 'enable');
        else if (action === 'manage-providers' || action === 'provider-manager') await this.openManager('providers', id);
        else if (action === 'manage-models' || action === 'model-manager') await this.openManager('models', id);
        else if (action === 'manage-teams') await this.openManager('teams', this.teamId);
        else if (action === 'edit-provider') { await this.openManager('providers', id); await this.app.editProviderById(id); }
        else if (action === 'sync-provider') { await this.openManager('providers', id); await this.app.fetchProviderModels(id); }
        else if (action === 'test-provider') { await this.openManager('providers', id); await this.app.pingProvider(id); }
        else if (action === 'edit-model') {
          await this.openManager('models', id);
          const summary = this.findModel(id);
          const params = new URLSearchParams({ page: '1', limit: '200', q: id });
          if (summary?.provider_id) params.set('provider', summary.provider_id);
          const data = await this.request(`/api/admin/models?${params}`);
          const model = (Array.isArray(data) ? data : data.items || []).find(item => String(item.id) === id);
          if (!model) throw new Error(tr('模型不存在，请刷新后重试'));
          this.app.editModel(model);
        } else if (action === 'test-model') {
          await this.app.testModel(id, control);
          await this.load();
        } else if (action === 'test-selected') {
          const ids = [...this.selected];
          if (!ids.length || !await window.confirm(tr('测试选中的 {count} 个模型？测试会发送真实请求并正常扣除积分。', { count: ids.length }))) return;
          await this.app._runBatchTest(ids, tr('正在测试选中的模型…'));
          await this.load();
        }
      } catch (error) {
        if (error.name !== 'AbortError') this.notice(error.message || tr('操作失败，请重试。'), true);
      }
    }
  }

  window.AdminModelLibrary = AdminModelLibrary;
})();
