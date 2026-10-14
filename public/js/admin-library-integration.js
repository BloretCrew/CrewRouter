/* Keep mature management editors available inside the unified library. */
(() => {
  const proto = AdminApp.prototype;
  const navigate = proto.navigateTo;
  const parseHash = proto._parseAdminHash;
  const buildHash = proto._buildAdminHash;
  const writeHash = proto._writeAdminHash;
  proto._writeAdminHash = function (page, options = {}) {
    const next = this._buildAdminHash(page, options);
    if (page === 'adminModelLibrary' && location.hash.startsWith('#adminModelLibrary') && location.hash !== next && !options.replaceHash) {
      history.pushState(null, '', `${location.pathname}${location.search}${next}`);
      return;
    }
    return writeHash.call(this, page, options);
  };
  const loadPage = proto.loadPage;
  const showTeam = proto.showTeamDetail;
  const catalogChanged = proto._notifyModelsCatalogChanged;
  const loadTeams = proto.loadTeams;
  proto.loadTeams = async function (...args) {
    const result = await loadTeams.apply(this, args);
    if (this.modelLibrary) {
      await this.modelLibrary.loadTeams();
      if (this.modelLibrary.teamId && !this.modelLibrary.teams.some(team => String(team.id) === this.modelLibrary.teamId)) {
        await this.modelLibrary.load({ teamId: null });
        this._writeAdminHash('adminModelLibrary');
      }
    }
    return result;
  };
  proto.deleteTeam = async function (teamId) {
    if (!await confirm(t('确定删除此 Team？成员将被移除但不会被删除。'))) return;
    try {
      const response = await fetch(`/api/admin/teams/${teamId}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('删除失败'));
      document.getElementById('teamDetailPanel').style.display = 'none';
      this.currentTeamId = null;
      await this.loadTeams();
    } catch (error) { alert(error.message || t('删除失败')); }
  };

  proto._adminPageIds = function () {
    return new Set(['adminModelLibrary', 'adminStats', 'adminUsers', 'adminModels', 'adminProviders', 'adminSettings', 'adminTeams', 'adminUserGroups', 'adminErrorLogs', 'adminAuditLogs', 'adminPrompts', 'adminPlugins']);
  };
  proto._parseAdminHash = function (hash) {
    const parts = String(hash || '').replace(/^#/, '').split('/');
    if (parts[0] === 'adminModelLibrary') {
      return { page: 'adminModelLibrary', teamId: parts[1] === 'team' && /^\d+$/.test(parts[2] || '') ? Number(parts[2]) : null };
    }
    return parseHash.call(this, hash);
  };
  proto._buildAdminHash = function (page, options = {}) {
    if (page === 'adminModelLibrary' && options.teamId != null) return `#adminModelLibrary/team/${options.teamId}`;
    return buildHash.call(this, page, options);
  };
  proto.navigateTo = async function (page, options = {}) {
    const oldPages = { adminProviders: 'providers', adminModels: 'models', adminTeams: 'teams', adminUserGroups: 'teams' };
    const manager = oldPages[page];
    if (manager) {
      await this.navigateTo('adminModelLibrary', { ...options, skipHash: true });
      this._writeAdminHash('adminModelLibrary', { teamId: options.teamId });
      if (manager !== 'teams' || !options.teamId) await this.openLibraryManager(manager);
      return;
    }
    if (this._unifiedProviders && ['adminStats', 'adminUsers', 'adminTeams', 'adminUserGroups', 'adminAuditLogs'].includes(page)) page = 'adminModelLibrary';
    if (document.documentElement.classList.contains('embedded-provider-manager')) page = 'adminModelLibrary';
    this.closeLibraryManager(false);
    this._libraryMemberSeq = (this._libraryMemberSeq || 0) + 1;
    // Legacy navigation guards accept the library through this explicit path.
    if (page === 'adminModelLibrary') {
      document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
      document.querySelectorAll('.main-content > .page').forEach(el => el.classList.toggle('active', el.id === 'adminModelLibraryPage'));
      this.currentPage = page;
      for (const id of ['pageTitle', 'mobilePageTitle']) {
        const el = document.getElementById(id);
        if (el) el.textContent = t('模型库');
      }
      document.querySelector('.sidebar')?.classList.remove('open');
      document.querySelector('.sidebar-overlay')?.classList.remove('active');
      this._syncAdminModelsStickyVisibility(false);
      this._syncAdminProvidersStickyVisibility(false);
      this._syncAdminTeamsStickyVisibility(false);
      this._syncAdminTeamModelsStickyVisibility(false);
      if (!options.skipHash) this._writeAdminHash(page, { teamId: options.teamId });
      await this.loadPage(page, options);
      return;
    }
    return navigate.call(this, page, options);
  };
  proto.loadPage = async function (page, options = {}) {
    if (page !== 'adminModelLibrary') return loadPage.call(this, page, options);
    if (this._statsRefreshTimer) { clearInterval(this._statsRefreshTimer); this._statsRefreshTimer = null; }
    if (this._instance?.capabilities?.teamAdmin === false && options.teamId != null) {
      options = { ...options, teamId: null };
      this._writeAdminHash(page);
    }
    if (!this.modelLibrary) {
      this.modelLibrary = new window.AdminModelLibrary(this);
      this.modelLibrary.mount(document.getElementById('adminModelLibraryPage'));
    }
    await this.modelLibrary.load({ teamId: options.teamId ?? null });
  };

  proto.openLibraryManager = async function (kind, id) {
    if (!['providers', 'models', 'teams'].includes(kind)) return;
    if (kind === 'teams' && this._instance?.capabilities?.teamAdmin === false) return;
    this.closeLibraryManager(false);
    const dialog = document.getElementById('adminLibraryManager');
    const page = document.getElementById(`admin${kind[0].toUpperCase() + kind.slice(1)}Page`);
    if (!dialog || !page) return;
    if (!this._libraryManagerPages) this._libraryManagerPages = new Map();
    if (!this._libraryManagerPages.has(kind)) this._libraryManagerPages.set(kind, { page, parent: page.parentNode, next: page.nextSibling });
    document.getElementById('adminLibraryManagerBody').append(page);
    page.classList.add('active');
    this._libraryManagerKind = kind;
    this._libraryManagerFocus = document.activeElement;
    document.getElementById('adminLibraryManagerTitle').textContent = t({ providers: '供应商配置', models: '模型配置', teams: 'TEAM 设置与成员' }[kind]);
    dialog.hidden = false;
    document.body.classList.add('admin-library-manager-open');
    document.querySelector('.app-container')?.setAttribute('inert', '');
    document.getElementById('adminLibraryManagerClose').focus();
    this._libraryManagerKeydown = event => {
      if (document.querySelector('blora-dialog[open]')) return;
      if (event.key === 'Escape') { event.preventDefault(); this.closeLibraryManager(); }
      if (event.key === 'Tab') {
        const targets = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    dialog.addEventListener('keydown', this._libraryManagerKeydown);
    try {
      if (kind === 'providers') await this.loadProviders({ resetPage: true });
      if (kind === 'models') await this.loadModels({ resetPage: true, clearSelection: false });
      if (kind === 'teams') {
        await this.loadTeams();
        if (id) await this.showTeamDetail(id);
        else document.getElementById('teamDetailPanel').style.display = 'none';
      }
    } catch (error) { alert(error.message || t('加载失败')); }
  };
  proto.closeLibraryManager = function (refresh = true) {
    const dialog = document.getElementById('adminLibraryManager');
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    dialog.removeEventListener('keydown', this._libraryManagerKeydown);
    document.body.classList.remove('admin-library-manager-open');
    document.querySelector('.app-container')?.removeAttribute('inert');
    const saved = this._libraryManagerPages?.get(this._libraryManagerKind);
    if (saved) {
      saved.page.classList.remove('active');
      saved.parent.insertBefore(saved.page, saved.next?.parentNode === saved.parent ? saved.next : null);
    }
    this._libraryManagerFocus?.focus();
    this._libraryManagerKind = null;
    if (refresh) this.modelLibrary?.catalogChanged({ teams: true });
  };
  const loadTeamModels = proto.loadTeamModels;
  proto.loadTeamModels = function (teamId) {
    if (this.currentPage === 'adminModelLibrary') return Promise.resolve();
    return loadTeamModels.call(this, teamId);
  };
  proto.showEditTeamModal = async function (teamId) {
    const response = await fetch('/api/admin/teams');
    const teams = await response.json();
    if (!response.ok) { alert(t('加载 Team 信息失败')); return; }
    const team = teams.find(item => Number(item.id) === Number(teamId));
    if (!team) { alert(t('Team 不存在')); return; }
    const modal = Dialog.showModal({
      title: t('编辑 Team'),
      content: `<div class="form-group"><label for="editTeamNameInput">${t('Team 名称')}</label><input id="editTeamNameInput" class="form-input" value="${escapeHtml(team.name)}" maxlength="100" required></div><div class="form-group"><label for="editTeamDescInput">${t('描述')}</label><textarea id="editTeamDescInput" class="form-input" rows="3">${escapeHtml(team.description || '')}</textarea></div><label><input type="checkbox" id="editTeamDefaultInput" ${team.is_default ? 'checked' : ''}>${t('设为默认 Team（新用户自动加入）')}</label><label><input type="checkbox" id="editTeamHideQuotaInput" ${team.hide_provider_quota ? 'checked' : ''}>${t('隐藏供应商额度（本 Team 成员在模型库不显示供应商额度区块）')}</label>`,
      footer: `<button type="button" id="confirmEditTeam" class="blora-button" data-variant="primary">${t('保存')}</button>`
    });
    const save = document.getElementById('confirmEditTeam');
    save.onclick = async () => {
      const name = document.getElementById('editTeamNameInput').value.trim();
      if (!name) { alert(t('名称不能为空')); return; }
      save.disabled = true;
      try {
        const result = await fetch(`/api/admin/teams/${teamId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: document.getElementById('editTeamDescInput').value.trim(), is_default: document.getElementById('editTeamDefaultInput').checked, hide_provider_quota: document.getElementById('editTeamHideQuotaInput').checked }) });
        const data = await result.json().catch(() => ({}));
        if (!result.ok) throw new Error(data.error || t('保存失败'));
        await this.loadTeams();
        await this.showTeamDetail(teamId);
        modal.close();
      } catch (error) { alert(error.message || t('保存失败')); }
      finally { if (save.isConnected) save.disabled = false; }
    };
  };
  proto.loadTeamMembers = async function (teamId) {
    const sequence = (this._libraryMemberSeq || 0) + 1;
    this._libraryMemberSeq = sequence;
    try {
      const [membersRes, usersRes] = await Promise.all([fetch(`/api/admin/teams/${teamId}/members`), fetch('/api/admin/users')]);
      const [members, users] = await Promise.all([membersRes.json(), usersRes.json()]);
      if (!membersRes.ok || !usersRes.ok) throw new Error(members.error || users.error || t('加载失败'));
      if (sequence !== this._libraryMemberSeq || Number(this.currentTeamId) !== Number(teamId)) return;
      this.renderTeamMembers(teamId, Array.isArray(members) ? members : members.items || [], Array.isArray(users) ? users : users.items || []);
    } catch (error) {
      if (sequence !== this._libraryMemberSeq) return;
      const target = document.getElementById('teamMembersList');
      if (target) target.textContent = error.message || t('加载失败');
    }
  };
  proto.showTeamDetail = async function (teamId) {
    if (this._libraryTeamRules?.host) this._libraryTeamRules.setBusy(true);
    await showTeam.call(this, teamId);
    if (this.currentPage === 'adminModelLibrary') {
      document.getElementById('teamModelsSection').hidden = true;
      let link = document.getElementById('adminLibraryTeamModelsLink');
      if (!link) {
        link = document.createElement('button');
        link.id = 'adminLibraryTeamModelsLink';
        link.className = 'blora-button';
        link.textContent = t('在模型库配置此 TEAM 的模型授权');
        document.getElementById('teamDetailPanel').prepend(link);
      }
      link.onclick = () => this.navigateTo('adminModelLibrary', { teamId });
    }
    let host = document.getElementById('adminLibraryTeamRules');
    if (!host) {
      host = document.createElement('section');
      host.id = 'adminLibraryTeamRules';
      host.className = 'content-section';
      document.getElementById('teamDetailPanel').append(host);
    }
    if (window.AdminLibraryTeamRules) {
      if (!this._libraryTeamRules) this._libraryTeamRules = new window.AdminLibraryTeamRules(host);
      await this._libraryTeamRules.load(teamId);
    }
  };
  proto._notifyModelsCatalogChanged = function () {
    catalogChanged.call(this);
    this.modelLibrary?.catalogChanged();
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('adminLibraryManagerClose')?.addEventListener('click', () => adminApp.closeLibraryManager());
    document.getElementById('adminLibraryManager')?.addEventListener('click', event => {
      if (event.target.id === 'adminLibraryManager') adminApp.closeLibraryManager();
    });
  });
})();
