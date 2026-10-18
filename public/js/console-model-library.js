(() => {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const text = key => window.AdminLibraryText ? window.AdminLibraryText(key) : key;
  const action = (name, label, id = '') => `<button type="button" class="aml-button" data-action="${name}" data-id="${esc(id)}">${esc(text(label))}</button>`;

  class ConsoleModelLibrary extends window.AdminModelLibrary {
    canManageTeams() { return true; }

    mount(container) {
      super.mount(container);
      container = this.container;
      const originalShell = this.shell;
      this.shell = () => {
        const template = document.createElement('template');
        template.innerHTML = originalShell();
        template.content.querySelector('.aml-header p').textContent = text('浏览已授权模型，绑定到当前 API Key。');
        template.content.querySelector('.aml-header .aml-actions').innerHTML = action('my-upstream', '我的上游') + action('refresh', '刷新');
        template.content.querySelector('.aml-selection').remove();
        template.content.querySelector('.aml-quota-host').dataset.quotaScope = 'user';
        template.content.querySelectorAll('.aml-team-filter, [data-filter="systemEnabled"]').forEach(control => control.closest('label').remove());
        template.content.querySelector('[data-filter="sort"] option[value="newest"]').remove();
        return template.innerHTML;
      };
      container.innerHTML = this.shell();
      container.classList.add('console-model-library');
      this.renderTeams();
      this.loadQuotaOverview();
      return this;
    }

    async loadQuotaOverview() {
      const host = this.container?.querySelector('.aml-quota-host');
      if (!host) return;
      try {
        window.CrewRouterProviderQuotaStats?.mount(host, 'user');
        await window.CrewRouterProviderQuotaStats?.load(host);
      } catch (error) { host.textContent = error.message; }
    }

    async loadTeams() {}

    renderTeams(query = '') {
      if (!this.container) return;
      const chip = (id, label) => `<button type="button" class="aml-button" data-action="team" data-team="${esc(id)}" aria-pressed="${String(id) === this.teamId}">${esc(label)}</button>`;
      const teams = this.teams.filter(team => (team.team_name || '').toLowerCase().includes(query.toLowerCase()));
      const visible = this.teams.slice(0, 5);
      const active = this.teams.find(team => String(team.team_id) === this.teamId);
      if (active && !visible.includes(active)) visible.push(active);
      this.container.querySelector('.aml-team-tabs').innerHTML = chip('', text('全部模型')) + visible.map(team => chip(team.team_id, team.team_name)).join('');
      this.container.querySelector('.aml-team-results').innerHTML = teams.map(team => chip(team.team_id, team.team_name)).join('');
      const current = this.teams.find(team => String(team.team_id) === this.teamId);
      this.container.querySelector('.aml-toolbar-context').textContent = current?.team_name || text('全部模型');
      this.container.querySelector('.aml-team-more').hidden = this.teams.length <= 5;
    }

    renderSelection() {}

    async request(url, options = {}) {
      const parsed = new URL(url, window.location.origin);
      if (parsed.pathname !== '/api/admin/model-library') {
        if (!parsed.pathname.startsWith('/api/user/')) throw new Error(text('操作不可用'));
        return super.request(url, options);
      }
      const params = parsed.searchParams;
      if (params.get('mode') === 'models') {
        const provider = this.providers.find(item => String(item.provider_id) === params.get('provider'));
        const sort = { name: 'name_asc', test_latency: 'test_latency_asc', test_speed: 'test_tps_desc' };
        const search = new URLSearchParams({ page: params.get('page'), limit: params.get('limit'), provider_id: provider.provider_id, sort: sort[this.filters.sort] || this.filters.sort });
        for (const key of ['q', 'series', 'test', 'tag']) if (this.filters[key]) search.set(key, this.filters[key]);
        if (this.teamId) search.set('team_id', this.teamId);
        const data = await super.request(`/api/user/model-library/search?${search}`);
        const pagination = data.pagination || {};
        return { items: data.models, page: pagination.page, limit: pagination.limit, total: pagination.total };
      }
      const data = await super.request('/api/user/model-library');
      this.app._libraryData = data;
      this.teams = data.teams || [];
      const providers = new Map();
      for (const team of this.teams) {
        if (this.teamId && String(team.team_id) !== this.teamId) continue;
        for (const provider of team.providers || []) {
          if (provider.is_hidden) continue;
          const id = String(provider.provider_id);
          if (!providers.has(id)) providers.set(id, { ...provider, model_count: 0 });
          providers.get(id).model_count += provider.visible_model_count ?? provider.model_count;
        }
      }
      const all = [...providers.values()];
      let items = all.filter(provider => (!this.filters.provider || String(provider.provider_id) === this.filters.provider) && (!this.filters.tag || provider.tags?.some(tag => String(tag.id) === this.filters.tag)));
      items.sort((first, second) => first.provider_name.localeCompare(second.provider_name));
      const total = items.length;
      const page = Math.min(this.page, Math.max(1, Math.ceil(total / this.limit)));
      items = items.slice((page - 1) * this.limit, page * this.limit);
      return { items, total, page, provider_options: all, series: data.available_series || [], stats: { model_count: data.total_models } };
    }

    renderDirectory() {
      super.renderDirectory();
      this.container.querySelectorAll('.aml-provider-header').forEach(header => {
        header.querySelectorAll('.aml-switch, .aml-provider-summary, .aml-actions').forEach(control => control.remove());
      });
      const empty = this.container.querySelector('.aml-directory > .aml-empty');
      if (empty) empty.textContent = text('暂无可用模型，请联系管理员授权或添加自己的供应商。');
      this.container.querySelector('.aml-summary').textContent = `${this.total} ${text('个供应商')} · ${text('展开供应商查看符合筛选的模型')}`;
    }

    renderProvider(id) {
      super.renderProvider(id);
      const empty = this.providerElement(id)?.querySelector('.aml-model-grid > .aml-empty');
      if (empty && !this.groups.get(id)?.error) empty.textContent = text('该供应商下暂无符合条件的模型，请调整筛选。');
    }

    card(model) {
      const template = document.createElement('template');
      template.innerHTML = super.card({ ...model, team_enabled: true });
      template.content.querySelectorAll('.aml-check, .aml-switch').forEach(control => control.remove());
      const bound = String(this.app._getSelectedLibraryKey()?.current_model_id) === String(model.model_id);
      template.content.querySelector('.aml-card').classList.toggle('is-selected', bound);
      template.content.querySelector('.aml-card-actions').innerHTML = action('bind-model', bound ? '重新绑定' : '绑定到当前 Key', model.model_id);
      return template.innerHTML;
    }

    async onClick(event) {
      const control = event.target.closest('[data-action]');
      if (!control || !this.container?.contains(control) || control.disabled) return;
      const name = control.dataset.action;
      if (name === 'team') return this.load({ teamId: control.dataset.team });
      if (name === 'my-upstream') return this.app.navigateTo('myUpstream');
      if (name === 'refresh-quotas') return this.loadQuotaOverview();
      if (name === 'bind-model') {
        control.disabled = true;
        try { await this.app.selectModel(control.dataset.id); }
        finally { control.disabled = false; }
        for (const id of this.groups.keys()) this.renderProvider(id);
        return;
      }
      if (['refresh', 'reset', 'expand', 'model-page', 'retry-provider', 'directory-page'].includes(name)) return super.onClick(event);
    }
  }

  window.ConsoleModelLibrary = ConsoleModelLibrary;
})();
