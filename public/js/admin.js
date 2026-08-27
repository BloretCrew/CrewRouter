function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDisplayName(format) {
  switch (format) {
    case 'openai': return 'Chat Completions';
    case 'responses': return 'Responses';
    case 'anthropic': return 'Anthropic Messages';
    default: return format || '-';
  }
}

// 管理员控制台应用
class AdminApp {
  constructor() {
    this.user = null;
    this.stats = null;
    this.currentPage = 'adminStats';
    this.selectedModels = new Set();
    this.selectedCodes = new Set();
    this.modelsData = [];
    this.filteredModels = [];
    this.modelsTotal = 0;
    this._modelsServerPaged = true;
    this._modelFilterTimer = null;
    this.providerViewMode = 'card';
    this.modelViewMode = 'library'; // 默认模型库风格（供应商折叠 + 懒加载）
    this.modelPage = 0;
    this.modelPageSize = 50;
    this._adminModelProviderCollapsed = {};
    this._adminModelsAll = []; // 兼容旧批量操作：按需全量拉取
    this._adminProvidersShell = []; // 模型管理：供应商壳列表 {id,name,model_count,enabled_count}
    this._adminProviderModelsCache = new Map(); // providerKey -> { models, page, total, limit, queryKey }
    this._adminProviderLoading = new Set();
    this._adminProviderPageSize = 50; // 每个供应商内部分页大小
    this._adminModelsQueryKey = '';
    this._providerOptionsCache = [];
    // 用户列表（服务端分页，page 从 0 起）
    this._usersData = [];
    this.userPage = 0;
    this.userPageSize = 50;
    this.usersTotal = 0;
    this._userFilterTimer = null;
    // 供应商列表（服务端分页，page 从 0 起）
    this.providersData = [];
    this.providerPage = 0;
    this.providerPageSize = 50;
    this.providersTotal = 0;
    this.providersStats = null;
    this._providersServerPaged = true;
    // 兼容旧字段（卡片/表格分组展示用，不再独立翻页）
    this.globalProviderPage = 0;
    this.userProviderPage = 0;
    this.activeProviderTagId = null; // 标签筛选
    this.selectedProviders = new Set(); // 供应商多选（批量同步等）
    this._providerBatchSyncing = false;
    this._providerFilterTimer = null;
    this._providerMoreMenuOpen = false;
    this._openProviderRowMenuId = null;
    // Team / 用户组 / 成员 / 统计表
    this.teamPage = 0;
    this.teamPageSize = 50;
    this._teamsData = [];
    this.userGroupPage = 0;
    this.userGroupPageSize = 50;
    this._userGroupsData = [];
    this.teamMemberPage = 0;
    this.userGroupMemberPage = 0;
    this.memberPageSize = 50;
    this.teamModelPage = 0;
    this.teamModelPageSize = 50;
    this._teamModelsFlat = [];
    this._teamModelsTeamId = null;
    this._teamModelsStale = false; // 供应商/模型目录变更后标记，返回 Team 详情时强制刷新
    this._teamModelProviderCollapsed = {};
    this.modelStatsPage = 0;
    this.providerStatsPage = 0;
    this.statsTablePageSize = 50;
    this._pendingFetchedModelsRaf = null;
    this._updateInfo = null;
    this._updatePollTimer = null;
    this._adminModelsStickyObserver = null;
    this._adminProvidersStickyObserver = null;
    this._adminTeamsStickyObserver = null;
    this._adminTeamModelsStickyObserver = null;
    this._adminModelsStickyMoreOpen = false;
    this._adminProvidersStickyMoreOpen = false;
    this.init();
  }

  /** 对数组切片并夹紧页码（0-based page） */
  _paginate(list, page, pageSize) {
    const items = Array.isArray(list) ? list : [];
    const size = Math.max(1, pageSize || 50);
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const safePage = Math.min(Math.max(0, page || 0), totalPages - 1);
    const start = safePage * size;
    return {
      page: safePage,
      totalPages,
      total,
      items: items.slice(start, start + size),
      start,
      end: Math.min(start + size, total)
    };
  }

  /** 读取搜索框文本 */
  _searchQ(inputId) {
    return (document.getElementById(inputId)?.value || '').trim().toLowerCase();
  }

  /** 多字段模糊匹配（任意字段包含关键词即命中） */
  _matchSearch(q, ...fields) {
    if (!q) return true;
    return fields.some(f => f != null && String(f).toLowerCase().includes(q));
  }

  /** 防抖后执行搜索回调 */
  _debounceSearch(timerKey, fn, delay = 250) {
    clearTimeout(this[timerKey]);
    this[timerKey] = setTimeout(fn, delay);
  }

  /** 兼容数组或 { items, total } 分页响应 */
  _normalizeListResponse(data) {
    if (Array.isArray(data)) {
      return { items: data, total: data.length, serverPaged: false, stats: null, providers: null };
    }
    return {
      items: data.items || data.logs || [],
      total: data.total ?? (data.items || []).length,
      serverPaged: true,
      page: data.page,
      limit: data.limit,
      stats: data.stats || null,
      providers: data.providers || null
    };
  }

  async init() {
    await this.loadUserInfo();
    if (!this.user) return;
    this.bindEvents();
    this._bindHashRouting();
    // 预加载统计信息刷新间隔（失败则用默认 10s）
    this._statsRefreshIntervalSec = 10;
    this._prefetchStatsRefreshInterval().catch(() => {});
    // 从 URL hash 恢复页面（刷新后保持原位置）
    const restored = this._parseAdminHash(location.hash);
    const startPage = restored.page || 'adminStats';
    await this.navigateTo(startPage, {
      skipHash: true,
      teamId: restored.teamId || null
    });
    // 若无 hash，写入默认 hash，便于复制链接
    if (!restored.page) {
      this._writeAdminHash(startPage, { replaceHash: true });
    }
    // 后台静默检查更新（不打扰；有更新时顶栏提示）
    this.checkUpdateBanner().catch((err) => {
      console.warn(t('[Update] 启动时检查更新失败:'), err);
    });
  }

  /** 支持的管理后台页面 id */
  _adminPageIds() {
    return new Set([
      'adminStats', 'adminUsers', 'adminModels', 'adminProviders',
      'adminSettings', 'adminTeams', 'adminUserGroups',
      'adminErrorLogs',
      'adminAuditLogs'
    ]);
  }

  /**
   * 解析 hash：#adminTeams 或 #adminTeams/12
   * 兼容旧写法 #adminDashboard → adminStats
   */
  _parseAdminHash(hash) {
    const raw = String(hash || '').replace(/^#/, '').trim();
    if (!raw) return { page: null, teamId: null };
    const [pagePart, extra] = raw.split('/');
    let page = pagePart || null;
    if (page === 'adminDashboard') page = 'adminStats';
    if (page && !this._adminPageIds().has(page)) page = null;
    const teamId = (page === 'adminTeams' && extra && /^\d+$/.test(extra))
      ? parseInt(extra, 10)
      : null;
    return { page, teamId };
  }

  _buildAdminHash(page, options = {}) {
    if (page === 'adminTeams' && options.teamId != null) {
      return `#adminTeams/${options.teamId}`;
    }
    return `#${page}`;
  }

  _writeAdminHash(page, options = {}) {
    const next = this._buildAdminHash(page, options);
    if (location.hash === next) return;
    // 统一 replace，避免侧边栏切换堆出大量历史记录
    history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
  }

  _bindHashRouting() {
    if (this._hashRouteBound) return;
    this._hashRouteBound = true;
    window.addEventListener('hashchange', () => {
      if (this._ignoreHashChange) return;
      const restored = this._parseAdminHash(location.hash);
      const page = restored.page || 'adminStats';
      this.navigateTo(page, {
        skipHash: true,
        teamId: restored.teamId || null
      });
    });
  }

  async loadUserInfo() {
    try {
      const response = await fetch('/auth/me', { credentials: 'same-origin' });
      if (response.ok) {
        this.user = await response.json();
        if (this.user.needsPasswordSetup) {
          window.location.replace('/set-password');
          return;
        }
        if (!this.user.isAdmin) {
          window.location.href = '/console';
          return;
        }
        this.updateUserInfo();
      } else {
        window.location.href = '/';
      }
    } catch (error) {
      console.error(t('加载用户信息失败:'), error);
      window.location.href = '/';
    }
  }

  updateUserInfo() {
    const usernameEl = document.getElementById('username');
    const avatarEl = document.getElementById('userAvatar');
    
    if (usernameEl) usernameEl.textContent = this.user.nickname || this.user.display_name || this.user.username;
    if (avatarEl) {
      avatarEl.src = this.user.avatar || '';
      avatarEl.onerror = () => {
        avatarEl.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect fill="%233b82f6" width="32" height="32" rx="16"/><text x="50%" y="50%" font-size="14" fill="white" text-anchor="middle" dy=".3em">${this.user.username.charAt(0).toUpperCase()}</text></svg>`;
      };
    }
  }

  bindEvents() {
    // 导航点击
    const navItems = document.querySelectorAll('.nav-item[data-page]');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        this.navigateTo(page);
      });
    });

    // 登出按钮
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this.logout());
    }

    // 添加模型按钮
    const addModelBtn = document.getElementById('addModelBtn');
    if (addModelBtn) {
      addModelBtn.addEventListener('click', () => this.showAddModelModal());
    }

    // 模型管理：事件委托（避免模型名/ID 含引号时 inline onclick 语法错误）
    this._bindAdminModelsListDelegation();

    // 全局点击关闭下拉菜单
    document.addEventListener('click', () => {
      document.querySelectorAll('.admin-action-dropdown.open').forEach(el => el.classList.remove('open'));
    });

    // 保存用户按钮
    const saveUserBtn = document.getElementById('saveUserBtn');
    if (saveUserBtn) {
      saveUserBtn.addEventListener('click', () => this.saveUser());
    }

    // 保存模型按钮
    const saveModelBtn = document.getElementById('saveModelBtn');
    if (saveModelBtn) {
      saveModelBtn.addEventListener('click', () => this.saveModel());
    }

    // 添加供应商按钮 - 向导式
    const addProviderBtn = document.getElementById('addProviderBtn');
    if (addProviderBtn) {
      addProviderBtn.addEventListener('click', () => this.showAddProviderWizard());
    }

    // 查询供应商信息按钮
    const lookupProviderBtn = document.getElementById('lookupProviderBtn');
    if (lookupProviderBtn) {
      lookupProviderBtn.addEventListener('click', () => this.lookupProviderInfo());
    }

    // 保存供应商按钮
    const saveProviderBtn = document.getElementById('saveProviderBtn');
    if (saveProviderBtn) {
      saveProviderBtn.addEventListener('click', () => this.saveProvider());
    }


    const providerCodexConfigFile = document.getElementById('providerCodexConfigFile');
    if (providerCodexConfigFile) providerCodexConfigFile.addEventListener('change', (event) => this.handleProviderCodexConfigFileUpload(event));
    const bindCodexQuotaBtn = document.getElementById('bindCodexQuotaBtn');
    if (bindCodexQuotaBtn) bindCodexQuotaBtn.addEventListener('click', () => this.bindCodexQuotaToProvider());

    // 导入 OpenCode 配置按钮
    const importOpenCodeBtn = document.getElementById('importOpenCodeBtn');
    if (importOpenCodeBtn) {
      importOpenCodeBtn.addEventListener('click', () => this.showImportOpenCodeModal());
    }

    // 确认导入按钮
    const confirmImportBtn = document.getElementById('confirmImportOpenCodeBtn');
    if (confirmImportBtn) {
      confirmImportBtn.addEventListener('click', () => this.importOpenCodeConfig());
    }

    // 文件上传监听
    const configFile = document.getElementById('openCodeConfigFile');
    if (configFile) {
      configFile.addEventListener('change', (e) => this.handleConfigFileUpload(e));
    }

    // 配置文本框输入预览
    const configText = document.getElementById('openCodeConfigText');
    if (configText) {
      configText.addEventListener('input', (e) => {
        const content = e.target.value.trim();
        if (content) {
          this.previewConfig(content);
        } else {
          document.getElementById('importPreview').style.display = 'none';
        }
      });
    }

    // 数据保留配置与手动任务
    const retentionForm = document.getElementById('retentionConfigForm');
    if (retentionForm) retentionForm.addEventListener('submit', (e) => this.saveRetentionConfig(e));
    document.getElementById('retentionRunCompressPreviewBtn')?.addEventListener('click', () => this.runRetentionTask('compress', true));
    document.getElementById('retentionRunPurgePreviewBtn')?.addEventListener('click', () => this.runRetentionTask('purge', true));
    document.getElementById('retentionRunCompressBtn')?.addEventListener('click', () => this.runRetentionTask('compress', false));
    document.getElementById('retentionRunPurgeBtn')?.addEventListener('click', () => this.runRetentionTask('purge', false));

    // 管理员设置表单
    const adminSettingsForm = document.getElementById('adminSettingsForm');
    if (adminSettingsForm) {
      adminSettingsForm.addEventListener('submit', (e) => this.saveAdminSettings(e));
    }

    // 系统单代理设置表单
    const systemProxyForm = document.getElementById('systemProxyForm');
    if (systemProxyForm) {
      systemProxyForm.addEventListener('submit', (e) => this.saveSystemProxy(e));
    }

    // 全局代理池设置表单
    const globalProxyPoolForm = document.getElementById('globalProxyPoolForm');
    if (globalProxyPoolForm) {
      globalProxyPoolForm.addEventListener('submit', (e) => this.saveGlobalProxyPool(e));
    }

    // 模型列表添加
    const modelListInput = document.getElementById('modelListInput');
    const modelListAddBtn = document.getElementById('modelListAddBtn');
    if (modelListInput && modelListAddBtn) {
      const addModelTag = () => {
        const val = modelListInput.value.trim();
        if (!val) return;
        if (val === 'fusion') {
          alert(t('fusion 是固定模型，无需添加'));
          return;
        }
        if (!this._modelList) this._modelList = [];
        if (this._modelList.includes(val)) {
          alert(t('该模型 ID 已存在'));
          return;
        }
        this._modelList.push(val);
        this.renderModelList();
        modelListInput.value = '';
      };
      modelListAddBtn.addEventListener('click', addModelTag);
      modelListInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addModelTag();
        }
      });
    }

    // 全局订阅地址输入时自动检测
    const globalSubUrlInput = document.getElementById('globalProxySubUrl');
    if (globalSubUrlInput) {
      let timer = null;
      globalSubUrlInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.checkGlobalProxyPoolStatus(), 800);
      });
    }

    // 计费模式切换：显示/隐藏每次请求价格
    document.querySelectorAll('input[name="billingMode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        document.getElementById('ratePriceGroup').style.display = radio.value === 'rate' && radio.checked ? '' : 'none';
      });
    });

    // 模态框关闭按钮
    const modalCloseButtons = document.querySelectorAll('.modal-close');
    modalCloseButtons.forEach(btn => {
      btn.addEventListener('click', () => this.closeModals());
    });

    // 点击遮罩空白处关闭弹窗（点到 .modal 本身，而非 .modal-content）
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModals();
      });
    });

    // 可退款复选框切换手续费率显示
    const codeRefundable = document.getElementById('codeRefundable');
    if (codeRefundable) {
      codeRefundable.addEventListener('change', () => {
        document.getElementById('codeFeeRateGroup').style.display = codeRefundable.checked ? 'block' : 'none';
      });
    }
    const editCodeRefundable = document.getElementById('editCodeRefundable');
    if (editCodeRefundable) {
      editCodeRefundable.addEventListener('change', () => {
        document.getElementById('editCodeFeeRateGroup').style.display = editCodeRefundable.checked ? 'block' : 'none';
      });
    }
    const batchSetRefundable = document.getElementById('batchSetRefundable');
    if (batchSetRefundable) {
      batchSetRefundable.addEventListener('change', () => {
        document.getElementById('batchSetFeeRateGroup').style.display = batchSetRefundable.checked ? 'block' : 'none';
      });
    }
  }

  closeModals() {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.style.display = 'none';
    });
  }

  _formatBigNumber(num) {
    if (!num && num !== 0) return '-';
    const compact = (value, unit, digits) => {
      const text = Number((value / unit).toFixed(digits)).toString();
      return `${text}${unit === 1000000000 ? 'B' : unit === 1000000 ? 'M' : 'K'}`;
    };
    if (num >= 1000000000) return compact(num, 1000000000, 2);
    if (num >= 1000000) return compact(num, 1000000, 2);
    if (num >= 1000) return compact(num, 1000, 1);
    return Number(num).toLocaleString();
  }

  async navigateTo(page, options = {}) {
    // 兼容旧「仪表盘」入口，统一到统计信息
    if (page === 'adminDashboard') page = 'adminStats';

    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

    // 更新页面显示
    document.querySelectorAll('.page').forEach(p => {
      p.classList.remove('active');
    });
    document.getElementById(`${page}Page`)?.classList.add('active');

    // 更新页面标题
    const titles = {
      'adminUsers': t('用户管理'),
      'adminModels': t('模型管理'),
      'adminProviders': t('供应商管理'),
      'adminStats': t('统计信息'),
      'adminErrorLogs': t('调用错误'),
      'adminSettings': t('系统设置'),
      'adminTeams': t('Team 管理'),
      'adminUserGroups': t('用户组管理'),
      'adminAuditLogs': t('操作日志'),
      'adminPrompts': t('提示词'),
      'adminPlugins': t('插件管理')
    };
    const pageTitleEl = document.getElementById('pageTitle');
    if (pageTitleEl) pageTitleEl.textContent = titles[page] || page;
    // 同步移动端顶部标题
    const mobileTitle = document.getElementById('mobilePageTitle');
    if (mobileTitle) mobileTitle.textContent = titles[page] || page;
    // 关闭移动端侧边栏
    document.querySelector('.sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-overlay')?.classList.remove('active');

    this.currentPage = page;

    // 离开对应页时隐藏悬浮顶栏
    if (page !== 'adminModels') this._syncAdminModelsStickyVisibility(false);
    if (page !== 'adminProviders') this._syncAdminProvidersStickyVisibility(false);
    if (page !== 'adminTeams') {
      this._syncAdminTeamsStickyVisibility(false);
      this._syncAdminTeamModelsStickyVisibility(false);
    }

    // 回到 Team 管理时：若详情仍打开，带上 teamId 以便重新拉取模型权限
    // （供应商同步启用/禁用后，内存中的 _teamModelsFlat 会过期）
    if (page === 'adminTeams' && options.teamId == null && this.currentTeamId != null) {
      const panel = document.getElementById('teamDetailPanel');
      if (panel && panel.style.display !== 'none') {
        options = { ...options, teamId: this.currentTeamId };
      }
    }

    // 写入 hash，刷新后可恢复；Team 详情附带 teamId
    if (!options.skipHash) {
      const hashOpts = {
        teamId: options.teamId != null
          ? options.teamId
          : (page === 'adminTeams' ? this.currentTeamId : null)
      };
      if (page !== 'adminTeams') hashOpts.teamId = null;
      this._ignoreHashChange = true;
      this._writeAdminHash(page, hashOpts);
      queueMicrotask(() => { this._ignoreHashChange = false; });
    }

    await this.loadPage(page, options);
  }

  /** 统计信息自动刷新间隔（毫秒），默认 10s，范围 3–300s */
  _getStatsRefreshIntervalMs() {
    const sec = parseInt(this._statsRefreshIntervalSec, 10);
    const clamped = Number.isFinite(sec) ? Math.min(300, Math.max(3, sec)) : 10;
    return clamped * 1000;
  }

  /** 启动时预加载统计刷新间隔（失败则保持默认 10s） */
  async _prefetchStatsRefreshInterval() {
    try {
      const response = await fetch('/api/admin/settings');
      if (!response.ok) return;
      const settings = await response.json();
      let refreshSec = parseInt(settings['stats_refresh_interval_sec'], 10);
      if (!Number.isFinite(refreshSec)) refreshSec = 10;
      refreshSec = Math.min(300, Math.max(3, refreshSec));
      this._statsRefreshIntervalSec = refreshSec;
      // 若已在统计页，按最新间隔重启轮询
      if (this.currentPage === 'adminStats') {
        this._startStatsRefreshTimer();
      }
    } catch (e) {
      // 保持构造时的默认值
    }
  }

  _startStatsRefreshTimer() {
    if (this._statsRefreshTimer) {
      clearInterval(this._statsRefreshTimer);
      this._statsRefreshTimer = null;
    }
    if (this.currentPage !== 'adminStats') return;
    const ms = this._getStatsRefreshIntervalMs();
    this._statsRefreshTimer = setInterval(() => {
      this.loadStats();
    }, ms);
  }

    async loadPage(page, options = {}) {
    // 清除自动刷新定时器
    if (this._statsRefreshTimer) {
      clearInterval(this._statsRefreshTimer);
      this._statsRefreshTimer = null;
    }

    switch (page) {
      case 'adminStats':
        await this.loadStats();
        this.loadUsageLogs(1);
        // 启动自动刷新（间隔来自系统设置，默认 10s）
        this._startStatsRefreshTimer();
        break;
      case 'adminUsers':
        this.userPage = 0;
        await this.loadUsers();
        break;
      case 'adminModels':
        await this.loadModels({ resetPage: true, clearSelection: true });
        this._initAdminModelsStickyBar();
        break;
      case 'adminProviders':
        this.providerPage = 0;
        this.globalProviderPage = 0;
        this.userProviderPage = 0;
        await this.loadProviders({ resetPage: true });
        this._initAdminProvidersStickyBar();
        break;
      case 'adminSettings':
        await this.loadSettings();
        await this.loadUpdatePanel();
        break;
      case 'adminTeams':
        await this.loadTeams();
        if (options.teamId) {
          await this.showTeamDetail(options.teamId);
        } else if (this._teamModelsStale && this.currentTeamId) {
          // 模型目录已变但详情仍挂着旧 DOM：强制重开详情刷新
          const panel = document.getElementById('teamDetailPanel');
          if (panel && panel.style.display !== 'none') {
            await this.showTeamDetail(this.currentTeamId);
          } else {
            this._initAdminTeamsStickyBar();
            this._syncAdminTeamModelsStickyVisibility(false);
          }
        } else {
          this._initAdminTeamsStickyBar();
          this._syncAdminTeamModelsStickyVisibility(false);
        }
        break;
      case 'adminUserGroups':
        await this.loadUserGroups();
        break;
      case 'adminErrorLogs':
        await this.loadErrorLogs(1);
        break;
      case 'adminAuditLogs':
        await this.loadAdminAuditLogs(1);
        break;
      case 'adminPrompts':
        await this.loadAdminCustomPrompts(1);
        break;
    }
  }

  async loadUsers() {
    const listEl = document.getElementById('usersList');
    if (listEl && !(this._usersData || []).length) setHTML(listEl, pageLoadingHtml(t('加载用户...')));
    try {
      const q = (document.getElementById('userSearchInput')?.value || '').trim();
      const params = new URLSearchParams({
        page: String(this.userPage + 1),
        limit: String(this.userPageSize)
      });
      if (q) params.set('q', q);

      const response = await fetch(`/api/admin/users?${params}`);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || t('加载失败'));
      }
      const raw = await response.json();
      const { items, total, stats } = this._normalizeListResponse(raw);

      this._usersData = items;
      this.usersTotal = total;

      const totalUsers = total;
      const adminCount = stats?.adminCount ?? items.filter(u => u.is_admin).length;
      const verifiedCount = stats?.verifiedCount ?? items.filter(u => u.email_verified).length;
      const totalBalance = stats?.totalBalance ?? items.reduce((sum, u) => sum + parseFloat(u.balance || 0), 0);

      const statsContainer = document.getElementById('userStatsCards');
      if (statsContainer) {
        setHTML(statsContainer, `
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon blue">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">${totalUsers}</span>
              <span class="admin-stat-card-label">总用户数</span>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon purple">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">${adminCount}</span>
              <span class="admin-stat-card-label">管理员</span>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon green">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">${verifiedCount}</span>
              <span class="admin-stat-card-label">已验证</span>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon amber">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">${Number(totalBalance).toFixed(0)}</span>
              <span class="admin-stat-card-label">总积分</span>
            </div>
          </div>
        `);
      }

      this._renderUsersTable();
    } catch (error) {
      console.error(t('加载用户列表失败:'), error);
      setHTML(document.getElementById('usersList'), `<p style="text-align:center;color:var(--destructive);padding:20px;">${escapeHtml(error.message || t('加载用户列表失败'))}</p>`);
    }
  }

  _renderUsersTable() {
    const container = document.getElementById('usersList');
    const users = this._usersData || [];
    const total = this.usersTotal || 0;
    const totalPages = Math.max(1, Math.ceil(total / this.userPageSize));
    if (this.userPage >= totalPages) this.userPage = Math.max(0, totalPages - 1);

    if (users.length === 0) {
      setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:40px;">' + t('未找到匹配的用户') + '</p>');
      return;
    }
    setHTML(container, `
      <table>
        <thead>
          <tr>
            <th>用户名</th>
            <th>邮箱</th>
            <th>验证状态</th>
            <th>积分</th>
            <th>角色</th>
            <th>速率限制</th>
            <th>注册时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(user => `
            <tr>
              <td><strong>${escapeHtml(user.nickname || user.display_name || user.username)}</strong></td>
              <td style="color:var(--muted-foreground);font-size:12px;">${escapeHtml(user.email) || '-'}</td>
              <td>${user.email_verified ? '<span style="color:#16a34a;font-size:12px;">' + t('✓ 已验证') + '</span>' : '<span style="color:var(--muted-foreground);font-size:12px;">' + t('✗ 未验证') + '</span>'}</td>
              <td style="font-variant-numeric:tabular-nums;">${parseFloat(user.balance || 0).toFixed(0)}</td>
              <td>${user.is_admin ? '<span style="background:rgba(139,92,246,0.1);color:var(--purple);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:500;">' + t('管理员') + '</span>' : '<span style="color:var(--muted-foreground);font-size:12px;">' + t('普通用户') + '</span>'}</td>
              <td style="font-size:12px;">${this.formatRateLimit(user.rate_limit_rpm, user.rate_limit_tpm)}</td>
              <td style="color:var(--muted-foreground);font-size:12px;">${new Date(user.created_at).toLocaleDateString('zh-CN')}</td>
              <td>
                <button class="btn btn-icon" title="${t('编辑')}" onclick="adminApp.editUserById(${user.id})">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${totalPages > 1 ? this._renderPagination('user', this.userPage, totalPages, total) : ''}
    `);
  }

  userPageGo(page) {
    this.userPage = page;
    this.loadUsers();
  }

  filterUsers(query) {
    clearTimeout(this._userFilterTimer);
    this._userFilterTimer = setTimeout(() => {
      this.userPage = 0;
      this.loadUsers();
    }, 300);
  }

  editUserById(userId) {
    const user = (this._usersData || []).find(u => u.id === userId);
    if (!user) { alert(t('用户不存在，请刷新后重试')); return; }
    this.editUser(user);
  }

  editUser(user) {
    document.getElementById('editUserId').value = user.id;
    document.getElementById('editUserEmail').value = user.email || '';
    document.getElementById('editUserEmailVerified').value = user.email_verified ? 'true' : 'false';
    document.getElementById('editUserAdmin').value = (user.is_admin || false).toString();
    document.getElementById('editUserBalance').value = user.balance || 0;
    document.getElementById('editUserTags').value = (user.tags || []).join(', ');
    document.getElementById('editUserRateLimitRpm').value = user.rate_limit_rpm || 0;
    document.getElementById('editUserRateLimitTpm').value = user.rate_limit_tpm || 0;

    // 加载用户组列表
    this.loadUserGroupsForSelect(user.group_id);

    document.getElementById('editUserModal').style.display = 'flex';
    document.getElementById('editUserModal').classList.add('active');
  }

  async loadUserGroupsForSelect(selectedGroupId) {
    try {
      const response = await fetch('/api/admin/user-groups');
      if (!response.ok) return;
      const groups = await response.json();
      const select = document.getElementById('editUserGroup');
      setHTML(select, '<option value="">' + t('无用户组') + '</option>' +
        groups.map(g => `<option value="${g.id}" ${g.id === selectedGroupId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join(''));
    } catch (error) {
      console.error(t('加载用户组列表失败:'), error);
    }
  }

  async loadUserCodeBalances(userId) {
    const container = document.getElementById('editUserCodeBalances');
    try {
      const response = await fetch(`/api/admin/users/${userId}/code-balances`);
      if (!response.ok) throw new Error(t('加载失败'));
      const balances = await response.json();
      
      if (balances.length === 0) {
        setHTML(container, '<span style="color:var(--muted-foreground)">' + t('无可退款余额') + '</span>');
        return;
      }
      
      setHTML(container, balances.map(b => {
        const feePercent = (parseFloat(b.fee_rate) * 100).toFixed(0);
        const feeLabel = parseFloat(b.fee_rate) > 0 ? `${t('(费率')}${feePercent}%)` : '';
        const netAmount = parseFloat(b.net_amount || 0).toFixed(2);
        return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
          <span><code style="font-size:11px;">${b.code}</code>${feeLabel}</span>
          <span style="font-weight:600;">¥${netAmount}</span>
        </div>`;
      }).join(''));
    } catch (error) {
      setHTML(container, '<span style="color:var(--destructive)">' + t('加载失败') + '</span>');
    }
  }

  async refundUser() {
    const userId = document.getElementById('editUserId').value;
    const refundAmount = parseFloat(document.getElementById('editUserRefundAmount').value);
    
    if (isNaN(refundAmount) || refundAmount <= 0) {
      alert(t('请输入有效的退款金额'));
      return;
    }
    
    if (!await confirm(`${t('确认为该用户退款 ¥')}${refundAmount.toFixed(2)}${t('？系统将按手续费从高到低扣除。')}`)) {
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/users/${userId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refundAmount })
      });
      
      const result = await response.json();
      
      if (response.ok && result.success) {
        alert(`${t('退款成功！实际扣除 ¥')}${result.deductions.reduce((s, d) => s + d.deducted, 0).toFixed(2)}${t('，新可退款余额 ¥')}${result.newRefundBalance.toFixed(2)}`);
        document.getElementById('editUserRefundAmount').value = '';
        document.getElementById('refundPreview').textContent = '';
        this.loadUserCodeBalances(userId);
        this.loadUsers();
      } else {
        alert(result.error || t('退款失败'));
      }
    } catch (error) {
      console.error(t('退款失败:'), error);
      alert(t('退款失败'));
    }
  }

  async saveUser() {
    const userId = document.getElementById('editUserId').value;
    const email = document.getElementById('editUserEmail').value.trim();
    const email_verified = document.getElementById('editUserEmailVerified').value === 'true';
    const isAdmin = document.getElementById('editUserAdmin').value === 'true';
    const balance = parseFloat(document.getElementById('editUserBalance').value);
    const group_id = document.getElementById('editUserGroup').value || null;
    const tagsStr = document.getElementById('editUserTags').value;
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : [];
    const rate_limit_rpm = parseInt(document.getElementById('editUserRateLimitRpm').value) || 0;
    const rate_limit_tpm = parseInt(document.getElementById('editUserRateLimitTpm').value) || 0;

    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, email_verified, isAdmin, balance, group_id, tags, rate_limit_rpm, rate_limit_tpm })
      });

      if (response.ok) {
        this.closeModals();
        this.loadUsers();
      } else {
        const result = await response.json().catch(() => ({}));
        alert(result.error || t('保存失败'));
      }
    } catch (error) {
      console.error(t('保存用户失败:'), error);
      alert(t('保存失败'));
    }
  }

  /**
   * 转义后用于：双引号 HTML 属性里的单引号 JS 字符串
   * 注意：HTML 属性中 \" 并不能阻止 " 截断属性，含用户数据的交互应优先用 data-* + 事件委托
   */
  _adminModelJsString(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');
  }

  /** 模型管理列表事件委托（只绑定一次） */
  _bindAdminModelsListDelegation() {
    if (this._adminModelsListDelegated) return;
    const root = document.getElementById('adminModelsList');
    if (!root) return;
    this._adminModelsListDelegated = true;

    root.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;

      // 可用率
      const uptimeEl = t.closest('.model-uptime');
      if (uptimeEl && root.contains(uptimeEl)) {
        e.stopPropagation();
        this.showModelUptimeDetailFromEl(uptimeEl);
        return;
      }

      // 操作按钮
      const actionBtn = t.closest('[data-admin-model-action]');
      if (actionBtn && root.contains(actionBtn)) {
        e.stopPropagation();
        e.preventDefault();
        const action = actionBtn.getAttribute('data-admin-model-action');
        const modelId = actionBtn.getAttribute('data-model-id') || '';
        const providerKey = actionBtn.getAttribute('data-provider-key') || '';
        const page = parseInt(actionBtn.getAttribute('data-page'), 10);
        if (action === 'test' && modelId) this.testModel(modelId, actionBtn);
        else if (action === 'edit' && modelId) this.editModelById(modelId);
        else if (action === 'delete' && modelId) this.deleteModel(modelId);
        else if (action === 'test-provider' && providerKey) this.testAdminProviderModels(providerKey);
        else if (action === 'provider-page' && providerKey && page > 0) this.loadAdminProviderModelsPage(providerKey, page);
        else if (action === 'retry-provider' && providerKey) {
          this.loadAdminProviderModelsPage(providerKey, page > 0 ? page : 1);
        }
        return;
      }

      // 供应商展开/折叠
      const providerHeader = t.closest('.model-library-provider-header');
      if (providerHeader && root.contains(providerHeader)) {
        // 头部内操作区不触发折叠
        if (t.closest('.model-library-provider-actions')) return;
        const providerEl = providerHeader.closest('.model-library-provider');
        const key = providerEl?.getAttribute('data-admin-provider-key');
        if (key) this.toggleAdminModelProvider(key);
        return;
      }

      // 卡片选择
      const card = t.closest('.admin-models-library-item[data-model-id]');
      if (card && root.contains(card)) {
        if (t.closest('.model-library-item-actions')) return;
        const modelId = card.getAttribute('data-model-id');
        if (modelId) this.toggleAdminModelCard(modelId);
      }
    });

    root.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || t.type !== 'checkbox') return;
      if (t.classList.contains('admin-models-provider-select-all')) {
        const providerKey = t.getAttribute('data-provider-key') || '';
        if (providerKey) this.toggleAdminModelProviderSelectAll(providerKey, t.checked);
      }
    });
  }

  _adminModelProviderKey(m) {
    return String(m.provider || m.provider_id || m.provider_name || 'unknown');
  }

  _adminModelProviderLabel(m) {
    return (m.provider_name && String(m.provider_name).trim())
      || (m.provider && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(m.provider) ? m.provider : '')
      || t('未知供应商');
  }

  _adminModelDisplayName(m) {
    return (m.upstream_model_id && String(m.upstream_model_id).trim())
      || (m.name && String(m.name).trim())
      || (m.alias && String(m.alias).trim())
      || m.id
      || t('未命名模型');
  }

  _groupAdminModelsByProvider(models) {
    const groups = new Map();
    (models || []).forEach(m => {
      const key = this._adminModelProviderKey(m);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: this._adminModelProviderLabel(m),
          models: []
        });
      }
      groups.get(key).models.push(m);
    });
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }

  /** 当前模型筛选条件（不含 page/limit/provider，provider 单独处理） */
  _buildAdminModelsFilterParams(extra = {}) {
    const params = new URLSearchParams();
    const q = (document.getElementById('modelSearchInput')?.value || '').trim();
    const provider = (document.getElementById('modelProviderFilter')?.value || '').trim();
    const status = document.getElementById('modelStatusFilter')?.value || '';
    const series = document.getElementById('modelSeriesFilter')?.value || '';
    const test = document.getElementById('modelTestFilter')?.value || '';
    if (q) params.set('q', q);
    if (provider) params.set('provider', provider);
    if (status === 'enabled') params.set('enabled', 'true');
    else if (status === 'disabled') params.set('enabled', 'false');
    if (series) params.set('series', series);
    if (test) params.set('test', test);
    Object.entries(extra || {}).forEach(([k, v]) => {
      if (v != null && v !== '') params.set(k, String(v));
    });
    return params;
  }

  _getAdminModelsQueryKey() {
    const p = this._buildAdminModelsFilterParams();
    // provider 筛选参与 key；展开某供应商时也会带 provider
    return p.toString();
  }

  _hasActiveAdminModelFilters() {
    const search = (document.getElementById('modelSearchInput')?.value || '').trim();
    const providerFilter = document.getElementById('modelProviderFilter')?.value || '';
    const statusFilter = document.getElementById('modelStatusFilter')?.value || '';
    const seriesFilter = document.getElementById('modelSeriesFilter')?.value || '';
    const testFilter = document.getElementById('modelTestFilter')?.value || '';
    return !!(search || providerFilter || statusFilter || seriesFilter || testFilter);
  }

  /** 清空供应商模型分页缓存（删除/启用禁用等变更后必须调用） */
  _invalidateAdminProviderModelsCache() {
    this._adminProviderModelsCache = new Map();
    this._adminModelsAll = [];
    this.modelsData = [];
    this.filteredModels = [];
  }

  /**
   * 全局模型目录变更后调用（供应商同步启用/禁用、批量启停、删除、清理下架等）。
   * Team 模型权限依赖「模型管理中已启用的全集」；不刷新会导致切页后仍显示旧列表。
   */
  _notifyModelsCatalogChanged() {
    this._teamModelsStale = true;
    const teamId = this.currentTeamId || this._teamModelsTeamId;
    const panel = document.getElementById('teamDetailPanel');
    // 用 style.display 判断（页面可能隐藏，offsetParent 会为 null）
    const detailOpen = !!(panel && panel.style.display !== 'none' && teamId);
    if (detailOpen) {
      this.loadTeamModels(teamId)
        .then(() => { this._teamModelsStale = false; })
        .catch(() => {});
    } else {
      // 清空本地缓存，下次打开详情会重新拉取
      this._teamModelsFlat = [];
    }
  }

  async loadModels(options = {}) {
    try {
      const modelsListEl = document.getElementById('adminModelsList');
      if (modelsListEl) setHTML(modelsListEl, pageLoadingHtml(t('加载模型...')));
      const resetPage = options.resetPage === true;
      if (resetPage) this.modelPage = 0;
      if (options.clearSelection) this.selectedModels.clear();

      const queryKey = this._getAdminModelsQueryKey();
      const prevQueryKey = this._adminModelsQueryKey;
      // 默认使缓存失效：删除/编辑/批量操作后列表必须重新拉取
      // keepCache=true 仅用于纯 UI 刷新（极少用）
      const invalidateCache = options.keepCache !== true;
      if (invalidateCache || prevQueryKey !== queryKey) {
        this._invalidateAdminProviderModelsCache();
        this._adminModelsQueryKey = queryKey;
        // 筛选条件变化时重置折叠状态
        if (!options.keepCollapse && prevQueryKey !== queryKey) {
          this._adminModelProviderCollapsed = {};
        }
      }

      // 轻量请求：只取统计 + 供应商壳（含数量），不拉全量模型
      const params = this._buildAdminModelsFilterParams({ page: 1, limit: 1 });
      const response = await fetch(`/api/admin/models?${params}`);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || t('加载失败'));
      }
      const raw = await response.json();
      const { total, stats, providers, series } = this._normalizeListResponse(raw);
      const providerList = Array.isArray(raw.providers) ? raw.providers : (providers || []);

      this.modelsTotal = total || 0;
      this._modelsServerPaged = true;
      let shell = providerList.map(p => ({
        id: p.id || p.provider,
        name: p.name || p.provider_name || p.id || p.provider,
        model_count: p.model_count ?? p.count ?? 0,
        enabled_count: p.enabled_count ?? 0
      }));
      // 下拉选了具体供应商时，壳列表只显示该供应商
      const providerFilter = (document.getElementById('modelProviderFilter')?.value || '').trim();
      if (providerFilter) {
        shell = shell.filter(p => String(p.id) === providerFilter);
        // 若筛选下拉有但聚合结果暂无（极少见），补一项
        if (!shell.length) {
          const opt = document.querySelector(`#modelProviderFilter option[value="${CSS.escape(providerFilter)}"]`);
          shell = [{
            id: providerFilter,
            name: opt?.textContent || providerFilter,
            model_count: total || 0,
            enabled_count: stats?.enabledCount ?? 0
          }];
        }
      }
      this._adminProvidersShell = shell;
      this._rebuildModelsDataFromCache();
      this.updateBatchButtons();

      const enabledCount = stats?.enabledCount ?? 0;
      const providerCount = stats?.providerCount ?? this._adminProvidersShell.length;
      const avgInputPrice = stats?.avgInputPrice ?? 0;

      const statsContainer = document.getElementById('modelStatsCards');
      if (statsContainer) {
        setHTML(statsContainer, `
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon blue">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">${this.modelsTotal}</span>
              <span class="admin-stat-card-label">总模型数</span>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon green">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">${enabledCount}</span>
              <span class="admin-stat-card-label">已启用</span>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon purple">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">${providerCount}</span>
              <span class="admin-stat-card-label">供应商数</span>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-card-icon amber">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div class="admin-stat-card-info">
              <span class="admin-stat-card-value">¥${Number(avgInputPrice).toFixed(4)}</span>
              <span class="admin-stat-card-label">平均输入价</span>
            </div>
          </div>
        `);
      }

      this.updateProviderFilter(this._adminProvidersShell);
      this.updateSeriesFilter(Array.isArray(raw.series) ? raw.series : series, []);
      this.renderModels();

      // 有筛选时自动展开并加载匹配供应商
      // 无筛选时：重新加载此前已展开的供应商，避免缓存清空后仍显示旧列表
      const toReload = [];
      if (this._hasActiveAdminModelFilters()) {
        const autoLoad = this._adminProvidersShell.slice(0, 8);
        for (const p of autoLoad) {
          this._adminModelProviderCollapsed[String(p.id)] = false;
          toReload.push(String(p.id));
        }
        this.renderModels();
      } else {
        for (const p of this._adminProvidersShell || []) {
          const key = String(p.id);
          if (this._adminModelProviderCollapsed[key] === false) toReload.push(key);
        }
      }
      for (const key of toReload.slice(0, 12)) {
        this.loadAdminProviderModels(key, 1, { force: true }).catch(() => {});
      }
    } catch (error) {
      console.error(t('加载模型列表失败:'), error);
      setHTML(document.getElementById('adminModelsList'), `<p style="text-align:center;color:var(--destructive);padding:20px;">${escapeHtml(error.message || t('加载模型列表失败'))}</p>`);
    }
  }

  _rebuildModelsDataFromCache() {
    const all = [];
    for (const cache of (this._adminProviderModelsCache || new Map()).values()) {
      if (cache && Array.isArray(cache.models)) all.push(...cache.models);
    }
    this.modelsData = all;
    this.filteredModels = all;
  }

  _findAdminModelById(modelId) {
    const id = String(modelId);
    for (const cache of (this._adminProviderModelsCache || new Map()).values()) {
      const m = (cache.models || []).find(x => String(x.id) === id);
      if (m) return m;
    }
    return (this.modelsData || []).find(m => String(m.id) === id) || null;
  }

  updateProviderFilter(providersOrModels) {
    const selects = [
      document.getElementById('modelProviderFilter'),
      document.getElementById('adminModelsStickyProvider')
    ].filter(Boolean);
    if (!selects.length) return;

    const providerMap = {};
    (providersOrModels || []).forEach(item => {
      // 服务端 providers: { id, name }；或模型行: { provider, provider_name }
      const id = item.id || item.provider;
      const name = item.name || item.provider_name || id;
      if (id && !providerMap[id]) providerMap[id] = name;
    });
    const providers = Object.keys(providerMap).sort((a, b) => (providerMap[a] || '').localeCompare(providerMap[b] || '', 'zh-CN'));
    const currentValue = selects[0].value;
    const optionsHtml = '<option value="">' + t('全部供应商') + '</option>' + providers.map(p =>
      `<option value="${escapeHtml(p)}">${escapeHtml(providerMap[p])}</option>`
    ).join('');

    selects.forEach(select => {
      setHTML(select, optionsHtml);
      select.value = currentValue;
    });
  }

  updateSeriesFilter(seriesList, models) {
    const selects = [
      document.getElementById('modelSeriesFilter'),
      document.getElementById('adminModelsStickySeries')
    ].filter(Boolean);
    if (!selects.length) return;
    const current = selects[0].value;
    let series = Array.isArray(seriesList) ? seriesList.filter(Boolean) : [];
    if (!series.length) {
      const set = new Set();
      (models || []).forEach(m => { if (m.series) set.add(m.series); });
      series = [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } else {
      series = [...series].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    }
    const optionsHtml = '<option value="">' + t('全部系列') + '</option>' + series.map(s =>
      `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
    ).join('');
    selects.forEach(select => {
      setHTML(select, optionsHtml);
      if (current && series.includes(current)) select.value = current;
    });
  }

  filterModels() {
    clearTimeout(this._modelFilterTimer);
    this._modelFilterTimer = setTimeout(() => {
      this.modelPage = 0;
      this.loadModels({ resetPage: true });
    }, 300);
  }

  /** 主栏 / 悬浮顶栏双向同步后触发筛选 */
  onAdminModelFilterInput(field, value, source) {
    const pairs = {
      search: ['modelSearchInput', 'adminModelsStickySearch'],
      provider: ['modelProviderFilter', 'adminModelsStickyProvider'],
      status: ['modelStatusFilter', 'adminModelsStickyStatus'],
      series: ['modelSeriesFilter', 'adminModelsStickySeries'],
      test: ['modelTestFilter', 'adminModelsStickyTest']
    };
    const [mainId, stickyId] = pairs[field] || [];
    if (mainId) this._syncPairedControl(mainId, stickyId, value, source);
    this._updateAdminModelsStickyMoreBtn();
    this.filterModels();
  }

  clearModelFilters() {
    const ids = [
      'modelSearchInput', 'adminModelsStickySearch',
      'modelProviderFilter', 'adminModelsStickyProvider',
      'modelStatusFilter', 'adminModelsStickyStatus',
      'modelSeriesFilter', 'adminModelsStickySeries',
      'modelTestFilter', 'adminModelsStickyTest'
    ];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this._updateAdminModelsStickyMoreBtn();
    this.modelPage = 0;
    this.loadModels({ resetPage: true, clearSelection: true });
  }

  // ===== 模型管理悬浮顶栏 =====

  _syncPairedControl(mainId, stickyId, value, source) {
    const mainEl = document.getElementById(mainId);
    const stickyEl = stickyId ? document.getElementById(stickyId) : null;
    if (source !== 'main' && mainEl && mainEl.value !== value) mainEl.value = value;
    if (source !== 'sticky' && stickyEl && stickyEl.value !== value) stickyEl.value = value;
  }

  _initAdminModelsStickyBar() {
    const sentinel = document.getElementById('adminModelsStickySentinel');
    if (!sentinel) return;

    if (this._adminModelsStickyObserver) {
      this._adminModelsStickyObserver.disconnect();
      this._adminModelsStickyObserver = null;
    }

    this._adminModelsStickyObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // 仅当筛选哨兵滚过视口顶部才显示（在下方未进入视口时不显示）
      const show = this._isStickySentinelPastTop(entry) && this.currentPage === 'adminModels';
      this._syncAdminModelsStickyVisibility(show);
    }, { root: null, threshold: [0, 0.01, 1], rootMargin: '0px' });

    this._adminModelsStickyObserver.observe(sentinel);
    this._syncAdminModelsStickyVisibility(
      this._isStickySentinelPastTop(sentinel) && this.currentPage === 'adminModels'
    );
    this._syncAdminModelsStickyControlsFromMain();
  }

  /** 哨兵是否已完全滚出视口顶部（bottom < 0）；在下方未进入视口时为 false */
  _isStickySentinelPastTop(entryOrEl) {
    const rect = entryOrEl?.boundingClientRect || entryOrEl?.getBoundingClientRect?.();
    return !!(rect && rect.bottom < 0);
  }

  _syncAdminModelsStickyVisibility(visible) {
    const bar = document.getElementById('adminModelsStickyBar');
    if (!bar) return;
    const shouldShow = !!visible && this.currentPage === 'adminModels';
    const wasVisible = bar.classList.contains('is-visible');
    if (shouldShow === wasVisible) return;
    bar.classList.toggle('is-visible', shouldShow);
    bar.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    if (!shouldShow) this._setAdminModelsStickyMoreOpen(false);
  }

  _syncAdminModelsStickyControlsFromMain() {
    const pairs = [
      ['modelSearchInput', 'adminModelsStickySearch'],
      ['modelProviderFilter', 'adminModelsStickyProvider'],
      ['modelStatusFilter', 'adminModelsStickyStatus'],
      ['modelSeriesFilter', 'adminModelsStickySeries'],
      ['modelTestFilter', 'adminModelsStickyTest']
    ];
    for (const [mainId, stickyId] of pairs) {
      const mainEl = document.getElementById(mainId);
      const stickyEl = document.getElementById(stickyId);
      if (mainEl && stickyEl && stickyEl.value !== mainEl.value) stickyEl.value = mainEl.value;
    }
    const count = document.getElementById('modelCount')?.textContent || '';
    const stickyCount = document.getElementById('adminModelsStickyCount');
    if (stickyCount) stickyCount.textContent = count;
    this._updateAdminModelsStickyMoreBtn();
  }

  toggleAdminModelsStickyMore() {
    this._setAdminModelsStickyMoreOpen(!this._adminModelsStickyMoreOpen);
  }

  _setAdminModelsStickyMoreOpen(open) {
    this._adminModelsStickyMoreOpen = !!open;
    const panel = document.getElementById('adminModelsStickyAdvanced');
    if (panel) {
      panel.style.display = open ? 'flex' : 'none';
      panel.classList.toggle('is-open', open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    this._updateAdminModelsStickyMoreBtn();
  }

  _updateAdminModelsStickyMoreBtn() {
    const btn = document.getElementById('adminModelsStickyMoreBtn');
    if (!btn) return;
    const hasAdvanced = !!(
      document.getElementById('modelSeriesFilter')?.value ||
      document.getElementById('modelTestFilter')?.value
    );
    const open = !!this._adminModelsStickyMoreOpen;
    btn.classList.toggle('library-more-filters-active', open || hasAdvanced);
    btn.textContent = open ? t('收起筛选') : t('更多筛选');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  _renderAdminModelLibraryItem(model) {
    const modelId = model.id;
    const selected = this.selectedModels.has(modelId);
    const displayName = this._adminModelDisplayName(model);
    const modelMult = parseFloat(model.model_multiplier || 1.0);
    const isDisabled = !model.enabled;
    const rpm = parseInt(model.rate_limit_rpm) || 0;
    const tpm = parseInt(model.rate_limit_tpm) || 0;
    const idAttr = escapeHtml(modelId);

    let testBadgeHtml = '';
    if (model.test_ok === true) {
      const tpsText = model.test_tokens_per_second ? ` · ${model.test_tokens_per_second} t/s` : '';
      testBadgeHtml = `<span class="model-test-badge pass" title="${escapeHtml(this._formatTestTooltip(model.test_tested_at))}">${model.test_latency_ms}ms${tpsText}</span>`;
    } else if (model.test_ok === false) {
      testBadgeHtml = `<span class="model-test-badge fail" title="${escapeHtml((model.test_error || t('失败')) + ' · ' + this._formatTestTooltip(model.test_tested_at))}">${t('失败')}</span>`;
    }

    return `
      <div class="model-library-item admin-models-library-item ${selected ? 'selected' : ''} ${isDisabled ? 'is-disabled' : ''}"
           data-model-id="${idAttr}"
           style="cursor:pointer;${isDisabled ? 'opacity:0.72;' : ''}">
        <div class="model-library-item-info">
          <div class="model-library-item-name">
            <span class="admin-add-model-check ${selected ? 'checked' : ''}" aria-hidden="true">
              ${selected
                ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
                : ''}
            </span>
            ${model.icon_url ? `<img src="${escapeHtml(model.icon_url)}" onerror="this.style.display='none'" alt="">` : ''}
            <span title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
            ${testBadgeHtml}
            <div class="model-item-badges">
              ${model.series ? `<span class="model-item-badge series">${escapeHtml(model.series)}</span>` : ''}
              ${isDisabled
                ? '<span class="model-item-badge" style="background:rgba(239,68,68,0.1);color:var(--destructive);">' + t('已禁用') + '</span>'
                : '<span class="model-item-badge" style="background:rgba(16,185,129,0.1);color:var(--success);">' + t('启用') + '</span>'}
              ${selected ? '<span class="model-item-badge owner">' + t('已选') + '</span>' : ''}
            </div>
          </div>
          ${model.alias && model.alias !== displayName ? `<div class="model-library-item-desc">${escapeHtml(model.alias)}</div>` : ''}
          ${model.description ? `<div class="model-library-item-desc">${escapeHtml(model.description)}</div>` : ''}
          <div class="model-library-item-price">
            <span class="model-price-item">
              <span class="model-price-label">倍率</span>
              <span class="model-price-value">×${modelMult.toFixed(2)}</span>
            </span>
            <span class="model-price-item">
              <span class="model-price-label">输入</span>
              <span class="model-price-value">¥${parseFloat(model.input_price_per_1k_tokens || 0).toFixed(4)}</span>
            </span>
            <span class="model-price-item">
              <span class="model-price-label">输出</span>
              <span class="model-price-value">¥${parseFloat(model.output_price_per_1k_tokens || 0).toFixed(4)}</span>
            </span>
            ${(rpm > 0 || tpm > 0) ? `
              <span class="model-price-item">
                <span class="model-price-label">速率</span>
                <span class="model-price-value">${rpm > 0 ? rpm + 'RPM' : ''}${rpm > 0 && tpm > 0 ? '/' : ''}${tpm > 0 ? tpm.toLocaleString() + 'TPM' : ''}</span>
              </span>` : ''}
          </div>
          ${this._renderModelUptimeSlot(modelId, displayName)}
        </div>
        <div class="model-library-item-actions" style="margin-left:0;margin-top:10px;justify-content:flex-end;">
          <button type="button" class="btn btn-sm btn-secondary model-test-btn" title="${t('测试')}"
            data-admin-model-action="test" data-model-id="${idAttr}">测试</button>
          <button type="button" class="btn btn-sm btn-secondary"
            data-admin-model-action="edit" data-model-id="${idAttr}">编辑</button>
          <button type="button" class="btn btn-sm btn-secondary" style="color:var(--destructive);"
            data-admin-model-action="delete" data-model-id="${idAttr}">删除</button>
        </div>
      </div>
    `;
  }

  // 模型状态：近 24 小时、每 15 分钟一槽（96 根）；前端缓存最多 15 分钟
  _uptimeDays = 1;
  _uptimeSlotCount = 96;
  _uptimeCacheTtlMs = 15 * 60 * 1000;

  _formatUptimeSlotLabel(dateStr, granularity) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return String(dateStr);
      if (granularity === '15m' || granularity === 'hour') {
        return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString('zh-CN');
    } catch (_) {
      return String(dateStr);
    }
  }

  _isUptimeTimeGranularity(granularity, slotLen) {
    return granularity === '15m' || granularity === 'hour' || (slotLen != null && slotLen > 31);
  }

  _purgeStaleUptimeCache() {
    if (!this._uptimeCacheFetchedAt) return;
    if (Date.now() - this._uptimeCacheFetchedAt > this._uptimeCacheTtlMs) {
      this._uptimeCache = {};
      this._uptimeCacheFetchedAt = 0;
    }
  }

  _renderModelUptimeSlot(modelId, modelName) {
    this._purgeStaleUptimeCache();
    const cached = this._uptimeCache && this._uptimeCache[modelId];
    if (cached) return this._renderModelUptimeCompact(modelId, modelName, cached);
    const idAttr = escapeHtml(modelId || '');
    const nameAttr = escapeHtml(modelName || modelId || '');
    const n = this._uptimeSlotCount || 96;
    // 名称可能含引号/中文特殊字符：只写 data-*，点击时从元素读取，避免 inline JS 语法错误
    return `<div class="model-uptime" data-uptime-model="${idAttr}" data-uptime-name="${nameAttr}" title="${t('加载调用状态...')}" role="button" tabindex="0">
      <div class="model-uptime-spark">${Array(n).fill('<span class="model-uptime-bar none"></span>').join('')}</div>
      <span class="model-uptime-pct">—</span>
    </div>`;
  }

  _renderModelUptimeCompact(modelId, modelName, summary) {
    const spark = Array.isArray(summary?.spark) ? summary.spark : [];
    // 近 24 小时：固定 96 根柱（每 15 分钟）
    const n = this._uptimeSlotCount || 96;
    const bars = spark.length ? spark.slice(-n) : Array(n).fill('none');
    const barHtml = bars
      .map(s => `<span class="model-uptime-bar ${escapeHtml(s || 'none')}"></span>`)
      .join('');
    const pct = summary?.uptime_pct == null ? '—' : `${Number(summary.uptime_pct).toFixed(2)}%`;
    const label = summary?.label || 'No data';
    let checkClass = 'muted';
    if (label === 'Normal') checkClass = '';
    else if (label === 'Degraded') checkClass = 'warn';
    else if (label === 'Outage') checkClass = 'bad';
    const checkSvg = label === 'No data'
      ? ''
      : `<span class="model-uptime-check ${checkClass}" title="${escapeHtml(label)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>`;
    return `<div class="model-uptime" data-uptime-model="${escapeHtml(modelId)}" data-uptime-name="${escapeHtml(modelName || modelId || '')}" title="${t('近 24 小时调用可用率（每 15 分钟）· 点击查看详情')}" role="button" tabindex="0">
      <div class="model-uptime-spark">${barHtml}</div>
      <span class="model-uptime-pct">${escapeHtml(pct)}</span>
      ${checkSvg}
    </div>`;
  }

  showModelUptimeDetailFromEl(el) {
    if (!el) return;
    const modelId = el.getAttribute('data-uptime-model') || '';
    const modelName = el.getAttribute('data-uptime-name') || modelId;
    return this.showModelUptimeDetail(modelId, modelName);
  }

  async _loadModelUptimeForIds(modelIds) {
    const ids = [...new Set((modelIds || []).filter(Boolean).map(String))];
    if (!ids.length) return;
    this._purgeStaleUptimeCache();
    if (!this._uptimeCache) this._uptimeCache = {};
    const missing = ids.filter(id => !this._uptimeCache[id]);
    if (!missing.length) {
      this._applyUptimeCacheToDom(ids);
      return;
    }
    const batchSize = 50;
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      try {
        const res = await fetch(`/api/admin/models/uptime?ids=${encodeURIComponent(batch.join(','))}&days=${this._uptimeDays}`);
        if (!res.ok) continue;
        const data = await res.json();
        const items = data.items || {};
        for (const id of batch) {
          this._uptimeCache[id] = items[id] || {
            uptime_pct: null, label: 'No data', total_success: 0, total_fail: 0, spark: []
          };
        }
        this._uptimeCacheFetchedAt = Date.now();
      } catch (e) {
        console.warn(t('[uptime] 批量加载失败'), e);
      }
    }
    this._applyUptimeCacheToDom(ids);
  }

  _applyUptimeCacheToDom(modelIds) {
    if (!this._uptimeCache) return;
    const ids = modelIds || Object.keys(this._uptimeCache);
    for (const id of ids) {
      const summary = this._uptimeCache[id];
      if (!summary) continue;
      document.querySelectorAll(`.model-uptime[data-uptime-model="${CSS.escape(String(id))}"]`).forEach(el => {
        const name = el.getAttribute('data-uptime-name') || id;
        const wrap = document.createElement('div');
        setHTML(wrap, this._renderModelUptimeCompact(id, name, summary));
        const next = wrap.firstElementChild;
        if (next) el.replaceWith(next);
      });
    }
  }

  async showModelUptimeDetail(modelId, modelName) {
    const modal = document.getElementById('modelUptimeModal');
    const title = document.getElementById('modelUptimeModalTitle');
    const body = document.getElementById('modelUptimeModalBody');
    if (!body || !modal) return;
    if (title) title.textContent = `${modelName || modelId}${t('· 调用状态（近 24 小时）')}`;
    setHTML(body, pageLoadingHtml(t('加载中...'), { compact: true }));
    modal.style.display = 'flex';
    try {
      const res = await fetch(`/api/admin/models/${encodeURIComponent(modelId)}/uptime?days=${this._uptimeDays}`);
      if (!res.ok) throw new Error(t('加载失败'));
      const data = await res.json();
      if (!this._uptimeCache) this._uptimeCache = {};
      this._uptimeCache[modelId] = {
        uptime_pct: data.uptime_pct,
        label: data.label,
        total_success: data.total_success,
        total_fail: data.total_fail,
        spark: (data.days || []).map(d => d.status)
      };
      this._uptimeCacheFetchedAt = Date.now();
      this._applyUptimeCacheToDom([modelId]);
      setHTML(body, this._renderModelUptimeDetailHtml(data, modelName || modelId));
    } catch (e) {
      setHTML(body, `${'<div class="empty-state"><p style="color:var(--destructive);">' + t('加载失败：')}${escapeHtml(e.message || e)}</p></div>`);
    }
  }

  _renderModelUptimeDetailHtml(data, modelName) {
    const days = data.days || [];
    const granularity = data.granularity || (days.length > 31 ? '15m' : (days.length <= 24 ? 'hour' : 'day'));
    const timeMode = this._isUptimeTimeGranularity(granularity, days.length);
    const bars = days.map(d => {
      const label = this._formatUptimeSlotLabel(d.date, granularity);
      const tip = `${label}${t('· 成功')}${d.success || 0}${t('/ 失败')}${d.fail || 0}`;
      return `<span class="model-uptime-bar ${escapeHtml(d.status || 'none')}" title="${escapeHtml(tip)}"></span>`;
    }).join('');
    const pct = data.uptime_pct == null ? '—' : `${Number(data.uptime_pct).toFixed(2)}% uptime`;
    const label = data.label || 'No data';
    let checkClass = 'muted';
    if (label === 'Normal') checkClass = '';
    else if (label === 'Degraded') checkClass = 'warn';
    else if (label === 'Outage') checkClass = 'bad';
    const check = label === 'No data'
      ? ''
      : `<span class="model-uptime-check ${checkClass}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>`;
    const rangeLeft = timeMode ? t('24 小时前') : t('开始');
    const rangeRight = timeMode ? t('现在') : t('今天');
    return `
      <div class="model-uptime-detail">
        <div class="model-uptime-detail-header">
          <div class="model-uptime-detail-title">
            <span>${escapeHtml(modelName || data.model_id || t('模型'))}</span>
            <span class="model-uptime-detail-help" title="${t('基于近 24 小时真实代理调用成功/失败统计（每 15 分钟聚合）。鉴权失败、本端限流与参数错误不计入。数据约每 15 分钟刷新。')}">?</span>
          </div>
          ${check}
        </div>
        <div class="model-uptime-detail-spark">${bars || '<span class="model-uptime-bar none"></span>'}</div>
        <div class="model-uptime-detail-meta">
          <span>${rangeLeft}</span>
          <span class="uptime-center">${escapeHtml(pct)}</span>
          <span>${rangeRight}</span>
        </div>
        <div class="model-uptime-detail-label">${escapeHtml(label === 'No data' ? t('暂无调用数据') : label)}</div>
        <div class="model-uptime-detail-legend">
          <span><i class="ok"></i>正常 (&lt;1% 失败)</span>
          <span><i class="degraded"></i>降级 (1–5%)</span>
          <span><i class="outage"></i>异常 (≥5%)</span>
          <span><i class="none"></i>无流量</span>
        </div>
      </div>`;
  }

  renderModels() {
    const container = document.getElementById('adminModelsList');
    if (!container) return;
    const countEl = document.getElementById('modelCount');
    const shell = this._adminProvidersShell || [];
    this._adminModelProviderCollapsed = this._adminModelProviderCollapsed || {};
    this._adminProviderModelsCache = this._adminProviderModelsCache || new Map();

    if (countEl) {
      const providerN = shell.length;
      countEl.textContent = this.modelsTotal === 0
        ? t('共 0 个模型')
        : `${t('共')}${this.modelsTotal}${t('个模型 ·')}${providerN}${t('个供应商（展开后加载）')}`;
    }
    const stickyCount = document.getElementById('adminModelsStickyCount');
    if (stickyCount) stickyCount.textContent = countEl?.textContent || '';

    if (!shell.length) {
      setHTML(container, `
        <div class="empty-state model-library-empty" style="padding:48px 20px;text-align:center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" style="margin-bottom:16px;opacity:0.5;">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
          <p style="font-size:15px;color:var(--muted-foreground);margin:0;">暂无匹配的模型</p>
          <p style="font-size:13px;color:var(--muted-foreground);margin:8px 0 0;opacity:0.7;">可调整筛选条件，或点击「添加模型」</p>
        </div>`);
      return;
    }

    const hasActiveFilter = this._hasActiveAdminModelFilters();
    const queryKey = this._getAdminModelsQueryKey();

    setHTML(container, `
      <div class="model-library-team">
        <div class="model-library-team-content">
          ${shell.map(p => {
            const key = String(p.id);
            let collapsed = this._adminModelProviderCollapsed[key];
            if (collapsed === undefined) {
              collapsed = !hasActiveFilter;
              this._adminModelProviderCollapsed[key] = collapsed;
            }
            const cache = this._adminProviderModelsCache.get(key);
            const cacheOk = cache && cache.queryKey === queryKey;
            const models = cacheOk ? (cache.models || []) : [];
            const totalCount = cacheOk ? (cache.total ?? p.model_count) : (p.model_count || 0);
            const enabledCount = p.enabled_count ?? models.filter(m => m.enabled).length;
            const selectedCount = models.filter(m => this.selectedModels.has(m.id)).length;
            const allSelected = models.length > 0 && selectedCount === models.length;
            const keyAttr = escapeHtml(key);
            const loading = this._adminProviderLoading?.has(key);
            let listHtml;
            if (collapsed) {
              listHtml = `<div class="model-library-placeholder"><span class="placeholder-text">${t('点击展开以加载模型')}</span></div>`;
            } else if (loading && !cacheOk) {
              listHtml = `<div class="model-library-placeholder">${inlineLoadingHtml(t('正在加载模型...'), 'sm')}</div>`;
            } else if (cacheOk) {
              listHtml = this._renderAdminProviderModelsListHtml(key, cache);
            } else {
              listHtml = `<div class="model-library-placeholder"><span class="placeholder-text">${t('点击展开以加载模型')}</span></div>`;
            }

            return `
              <div class="model-library-provider ${collapsed ? 'collapsed' : ''}"
                   data-admin-provider-key="${keyAttr}">
                <div class="model-library-provider-header" style="cursor:pointer;">
                  <div class="model-library-provider-title">
                    <svg class="collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                    <span class="provider-name">${escapeHtml(p.name || key)}</span>
                    ${selectedCount > 0 ? `${'<span class="model-item-badge owner">' + t('已选')}${selectedCount}</span>` : ''}
                  </div>
                  <div class="model-library-provider-actions">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:400;cursor:pointer;color:var(--muted-foreground);">
                      <input type="checkbox" class="admin-models-provider-select-all"
                        data-provider-key="${keyAttr}"
                        ${allSelected ? 'checked' : ''}>
                      全选本页
                    </label>
                    <button type="button" class="btn btn-sm btn-secondary model-test-btn" style="padding:4px 8px;font-size:11px;"
                      title="${t('测试此供应商下当前筛选模型')}"
                      data-admin-model-action="test-provider" data-provider-key="${keyAttr}">测试</button>
                    <span class="provider-model-count">${totalCount} 个模型${enabledCount != null && enabledCount !== totalCount ? ` · ${enabledCount}${t('启用')}` : ''}</span>
                  </div>
                </div>
                <div class="model-library-list" data-admin-provider-list="${keyAttr}">
                  ${listHtml}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `);

    // 已加载的模型补 uptime
    const loadedIds = [];
    for (const cache of this._adminProviderModelsCache.values()) {
      if (cache?.queryKey === queryKey) {
        (cache.models || []).forEach(m => loadedIds.push(m.id));
      }
    }
    if (loadedIds.length) this._loadModelUptimeForIds(loadedIds);
  }

  _renderAdminProviderModelsListHtml(providerKey, cache) {
    const models = cache?.models || [];
    if (!models.length) {
      return `<div class="model-library-placeholder"><span class="placeholder-text">${this._hasActiveAdminModelFilters() ? t('没有符合筛选条件的模型') : t('该供应商下暂无模型')}</span></div>`;
    }
    return models.map(m => this._renderAdminModelLibraryItem(m)).join('')
      + this._renderAdminProviderPagination(providerKey, cache);
  }

  _renderAdminProviderPagination(providerKey, cache) {
    const total = cache?.total || 0;
    const limit = cache?.limit || this._adminProviderPageSize || 50;
    const page = cache?.page || 1; // 1-based from API
    if (total <= limit) return '';
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const keyAttr = escapeHtml(providerKey);
    const pages = [];
    const addPage = (p) => {
      if (p >= 1 && p <= totalPages && !pages.includes(p)) pages.push(p);
    };
    addPage(1);
    addPage(page - 1);
    addPage(page);
    addPage(page + 1);
    addPage(totalPages);
    pages.sort((a, b) => a - b);
    let lastPage = 0;
    const pageButtons = pages.map(p => {
      const gap = p - lastPage > 1 ? '<span class="model-library-page-ellipsis">...</span>' : '';
      lastPage = p;
      return `${gap}<button type="button" class="model-library-page-btn ${p === page ? 'active' : ''}" ${p === page ? 'disabled' : ''}
        data-admin-model-action="provider-page" data-provider-key="${keyAttr}" data-page="${p}">${p}</button>`;
    }).join('');
    return `
      <div class="model-library-pagination">
        <button type="button" class="model-library-page-btn" ${page > 1 ? '' : 'disabled'}
          data-admin-model-action="provider-page" data-provider-key="${keyAttr}" data-page="${page - 1}">上一页</button>
        ${pageButtons}
        <button type="button" class="model-library-page-btn" ${page < totalPages ? '' : 'disabled'}
          data-admin-model-action="provider-page" data-provider-key="${keyAttr}" data-page="${page + 1}">下一页</button>
        <span class="model-library-page-summary">共 ${total} 个</span>
      </div>
    `;
  }

  async toggleAdminModelProvider(providerKey) {
    this._adminModelProviderCollapsed = this._adminModelProviderCollapsed || {};
    const nextCollapsed = !this._adminModelProviderCollapsed[providerKey];
    this._adminModelProviderCollapsed[providerKey] = nextCollapsed;
    const el = document.querySelector(`#adminModelsList .model-library-provider[data-admin-provider-key="${CSS.escape(providerKey)}"]`);
    if (el) el.classList.toggle('collapsed', nextCollapsed);
    if (!nextCollapsed) {
      await this.loadAdminProviderModels(providerKey, 1);
    }
  }

  loadAdminProviderModelsPage(providerKey, page) {
    return this.loadAdminProviderModels(providerKey, page, { force: true });
  }

  async loadAdminProviderModels(providerKey, page = 1, options = {}) {
    const key = String(providerKey);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const queryKey = this._getAdminModelsQueryKey();
    const cache = this._adminProviderModelsCache.get(key);
    if (!options.force && cache && cache.queryKey === queryKey && cache.page === pageNum) {
      this._paintAdminProviderList(key);
      return;
    }
    if (this._adminProviderLoading.has(key)) return;

    this._adminProviderLoading.add(key);
    const listEl = document.querySelector(`#adminModelsList [data-admin-provider-list="${CSS.escape(key)}"]`)
      || document.querySelector(`#adminModelsList .model-library-provider[data-admin-provider-key="${CSS.escape(key)}"] .model-library-list`);
    if (listEl) setHTML(listEl, `<div class="model-library-placeholder">${inlineLoadingHtml(t('正在加载模型...'), 'sm')}</div>`);

    try {
      const params = this._buildAdminModelsFilterParams({
        page: pageNum,
        limit: this._adminProviderPageSize || 50,
        provider: key
      });
      const res = await fetch(`/api/admin/models?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${t('加载失败 (')}${res.status})`);
      }
      const data = await res.json();
      const items = data.items || data.logs || (Array.isArray(data) ? data : []);
      this._adminProviderModelsCache.set(key, {
        models: items,
        page: data.page || pageNum,
        total: data.total ?? items.length,
        limit: data.limit || this._adminProviderPageSize || 50,
        queryKey
      });
      // 更新壳上的数量（若筛选变化）
      const shell = (this._adminProvidersShell || []).find(p => String(p.id) === key);
      if (shell && data.total != null) shell.model_count = data.total;

      this._adminModelProviderCollapsed[key] = false;
      this._rebuildModelsDataFromCache();
      this._paintAdminProviderList(key);
      this._loadModelUptimeForIds(items.map(m => m.id));
    } catch (e) {
      console.error(t('[模型管理] 加载供应商模型失败:'), key, e);
      if (listEl) {
        setHTML(listEl, `<div class="model-library-placeholder"><span class="placeholder-text" style="color:var(--destructive);">加载失败，<a href="#" data-admin-model-action="retry-provider" data-provider-key="${escapeHtml(key)}" data-page="${pageNum}">${t('重试')}</a></span></div>`);
      }
    } finally {
      this._adminProviderLoading.delete(key);
    }
  }

  _paintAdminProviderList(providerKey) {
    const key = String(providerKey);
    const el = document.querySelector(`#adminModelsList .model-library-provider[data-admin-provider-key="${CSS.escape(key)}"]`);
    if (!el) return;
    el.classList.remove('collapsed');
    const listEl = el.querySelector('.model-library-list');
    const cache = this._adminProviderModelsCache.get(key);
    const queryKey = this._getAdminModelsQueryKey();
    if (!listEl) return;
    if (!cache || cache.queryKey !== queryKey) {
      setHTML(listEl, `<div class="model-library-placeholder"><span class="placeholder-text">${t('点击展开以加载模型')}</span></div>`);
      return;
    }
    setHTML(listEl, this._renderAdminProviderModelsListHtml(key, cache));

    // 更新计数与全选状态
    const countEl = el.querySelector('.provider-model-count');
    if (countEl) {
      const shell = (this._adminProvidersShell || []).find(p => String(p.id) === key);
      const total = cache.total ?? shell?.model_count ?? cache.models.length;
      const enabled = shell?.enabled_count;
      countEl.textContent = `${total}${t('个模型')}${enabled != null && enabled !== total ? ` · ${enabled} ${t('启用')}` : ''}`;
    }
    const models = cache.models || [];
    const selectedCount = models.filter(m => this.selectedModels.has(m.id)).length;
    const selectAll = el.querySelector('.admin-models-provider-select-all');
    if (selectAll) {
      selectAll.checked = models.length > 0 && selectedCount === models.length;
      selectAll.indeterminate = !selectAll.checked && selectedCount > 0;
    }
    const title = el.querySelector('.model-library-provider-title');
    if (title) {
      let badge = title.querySelector('.model-item-badge.owner');
      if (selectedCount > 0) {
        if (!badge) title.insertAdjacentHTML('beforeend', `${'<span class="model-item-badge owner">' + t('已选')}${selectedCount}</span>`);
        else badge.textContent = `${t('已选')}${selectedCount}`;
      } else if (badge) badge.remove();
    }
  }

  expandAllAdminModelProviders() {
    this._adminModelProviderCollapsed = this._adminModelProviderCollapsed || {};
    const keys = (this._adminProvidersShell || []).map(p => String(p.id));
    keys.forEach(key => {
      this._adminModelProviderCollapsed[key] = false;
    });
    this.renderModels();
    // 仅自动加载前 12 个，避免瞬间打爆接口
    keys.slice(0, 12).forEach(key => {
      this.loadAdminProviderModels(key, 1).catch(() => {});
    });
  }

  collapseAllAdminModelProviders() {
    this._adminModelProviderCollapsed = this._adminModelProviderCollapsed || {};
    (this._adminProvidersShell || []).forEach(p => {
      this._adminModelProviderCollapsed[String(p.id)] = true;
    });
    document.querySelectorAll('#adminModelsList .model-library-provider').forEach(el => {
      el.classList.add('collapsed');
    });
  }

  toggleAdminModelCard(modelId) {
    if (this.selectedModels.has(modelId)) this.selectedModels.delete(modelId);
    else this.selectedModels.add(modelId);
    this._syncAdminModelCardSelection(modelId);
    this.updateBatchButtons();
  }

  _syncAdminModelCardSelection(modelId) {
    const selected = this.selectedModels.has(modelId);
    const card = document.querySelector(`#adminModelsList .admin-models-library-item[data-model-id="${CSS.escape(String(modelId))}"]`);
    if (card) {
      card.classList.toggle('selected', selected);
      const check = card.querySelector('.admin-add-model-check');
      if (check) {
        check.classList.toggle('checked', selected);
        setHTML(check, selected
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
          : '');
      }
      const badges = card.querySelector('.model-item-badges');
      if (badges) {
        const existing = badges.querySelector('.model-item-badge.owner');
        if (selected && !existing) {
          badges.insertAdjacentHTML('beforeend', '<span class="model-item-badge owner">' + t('已选') + '</span>');
        } else if (!selected && existing) {
          existing.remove();
        }
      }
    }

    // 更新供应商头部「已选 N」与全选勾（仅当前页）
    const model = this._findAdminModelById(modelId);
    if (!model) return;
    const providerKey = this._adminModelProviderKey(model);
    this._paintAdminProviderList(providerKey);
  }

  toggleAdminModelProviderSelectAll(providerKey, checked) {
    const key = String(providerKey);
    const cache = this._adminProviderModelsCache.get(key);
    const models = (cache?.models || []).filter(m => this._adminModelProviderKey(m) === key);
    // 若尚未加载，先加载再全选本页
    if (!cache || cache.queryKey !== this._getAdminModelsQueryKey()) {
      this.loadAdminProviderModels(key, 1).then(() => {
        this.toggleAdminModelProviderSelectAll(key, checked);
      });
      return;
    }
    models.forEach(m => {
      if (checked) this.selectedModels.add(m.id);
      else this.selectedModels.delete(m.id);
    });
    this._paintAdminProviderList(key);
    this.updateBatchButtons();
  }

  async testAdminProviderModels(providerKey) {
    const key = String(providerKey);
    // 拉取该供应商在当前筛选下的全部模型 ID（分页遍历）
    const ids = await this._fetchAllAdminProviderModelIds(key);
    if (!ids.length) { alert(t('该供应商下暂无模型')); return; }
    if (ids.length > 100 && !await confirm(`${t('将测试')}${ids.length}${t('个模型，可能较久，是否继续？')}`)) return;
    await this._runBatchTest(ids, `${t('正在测试')}${ids.length}${t('个模型...')}`);
  }

  async _fetchAllAdminProviderModelIds(providerKey) {
    const key = String(providerKey);
    const limit = 200;
    let page = 1;
    let total = Infinity;
    const ids = [];
    while ((page - 1) * limit < total) {
      const params = this._buildAdminModelsFilterParams({ page, limit, provider: key });
      const res = await fetch(`/api/admin/models?${params}`);
      if (!res.ok) break;
      const data = await res.json();
      const items = data.items || [];
      total = data.total ?? items.length;
      items.forEach(m => ids.push(m.id));
      if (!items.length) break;
      page++;
      if (page > 100) break;
    }
    return ids;
  }

  _renderPagination(prefix, currentPage, totalPages, totalItems) {
    const btnStyle = 'padding:4px 10px;border:1px solid var(--border);background:var(--background);color:var(--foreground);border-radius:4px;cursor:pointer;font-size:12px;';
    const activeStyle = btnStyle + 'background:var(--primary);color:var(--primary-foreground);font-weight:600;';
    const disabledStyle = btnStyle + 'opacity:0.4;cursor:not-allowed;';

    let pages = [];
    const maxVisible = 7;
    let startPage = Math.max(0, currentPage - 3);
    let endPage = Math.min(totalPages - 1, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) startPage = Math.max(0, endPage - maxVisible + 1);

    if (startPage > 0) {
      pages.push(`<button style="${btnStyle}" onclick="adminApp.${prefix}PageGo(0)">1</button>`);
      if (startPage > 1) pages.push(`<span style="color:var(--muted-foreground);font-size:12px;">…</span>`);
    }
    for (let i = startPage; i <= endPage; i++) {
      pages.push(`<button style="${i === currentPage ? activeStyle : btnStyle}" onclick="adminApp.${prefix}PageGo(${i})">${i + 1}</button>`);
    }
    if (endPage < totalPages - 1) {
      if (endPage < totalPages - 2) pages.push(`<span style="color:var(--muted-foreground);font-size:12px;">…</span>`);
      pages.push(`<button style="${btnStyle}" onclick="adminApp.${prefix}PageGo(${totalPages - 1})">${totalPages}</button>`);
    }

    return `
      <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-top:16px;padding:12px 0;">
        <button style="${currentPage === 0 ? disabledStyle : btnStyle}" onclick="adminApp.${prefix}PageGo(${currentPage - 1})" ${currentPage === 0 ? 'disabled' : ''}>上一页</button>
        ${pages.join('')}
        <button style="${currentPage >= totalPages - 1 ? disabledStyle : btnStyle}" onclick="adminApp.${prefix}PageGo(${currentPage + 1})" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>下一页</button>
        <span style="margin-left:12px;color:var(--muted-foreground);font-size:12px;">共 ${totalItems} 项，${totalPages} 页</span>
      </div>
    `;
  }

  modelPageGo(page) {
    this.modelPage = page;
    this.loadModels();
  }

  editModelById(modelId) {
    const model = this._findAdminModelById(modelId);
    if (!model) { alert(t('模型不存在，请先展开所属供应商后再试')); return; }
    this.editModel(model);
  }

  _renderModelCards(container, models) {
    const list = models || this.modelsData || [];
    const total = this.modelsTotal ?? list.length;
    const modelNameMap = {};
    for (const m of list) {
      modelNameMap[m.id] = m.name || m.upstream_model_id || m.id;
    }

    if (list.length === 0) {
      setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:40px;">' + t('暂无匹配的模型') + '</p>');
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / this.modelPageSize));
    if (this.modelPage >= totalPages) this.modelPage = Math.max(0, totalPages - 1);
    const pageModels = list;

    setHTML(container, `<div class="admin-card-grid">${pageModels.map(model => {
      const inputPrice = parseFloat(model.input_price_per_1k_tokens || 0);
      const outputPrice = parseFloat(model.output_price_per_1k_tokens || 0);
      const multiplier = parseFloat(model.model_multiplier || 1.0);
      const rpm = parseInt(model.rate_limit_rpm) || 0;
      const tpm = parseInt(model.rate_limit_tpm) || 0;
      const thinkingName = model.thinking_model_id ? (modelNameMap[model.thinking_model_id] || t('(未知)')) : null;
      const nonThinkingName = model.non_thinking_model_id ? (modelNameMap[model.non_thinking_model_id] || t('(未知)')) : null;

      return `
        <div class="admin-card">
          <div class="admin-card-header">
            <div style="flex:1;min-width:0;">
              <div class="admin-card-title" title="${escapeHtml(model.upstream_model_id || model.name || '')}">${escapeHtml(model.upstream_model_id || model.name || model.id)}</div>
              ${model.name && model.name !== model.upstream_model_id ? `<div class="admin-card-subtitle">${escapeHtml(model.name)}</div>` : ''}
            </div>
            <span class="admin-card-badge ${model.enabled ? 'green' : 'red'}">${model.enabled ? t('启用') : t('禁用')}</span>
          </div>
          <div class="admin-card-body">
            <div class="admin-card-row">
              <span class="admin-card-row-label">供应商</span>
              <span class="admin-card-row-value">${escapeHtml(model.provider_name || model.provider || '-')}</span>
            </div>
            ${model.alias ? `${'<div class="admin-card-row"><span class="admin-card-row-label">' + t('别名')}</span><span class="admin-card-row-value">${escapeHtml(model.alias)}</span></div>` : ''}
            ${model.series ? `${'<div class="admin-card-row"><span class="admin-card-row-label">' + t('系列')}</span><span class="admin-card-row-value"><span class="series-badge">${escapeHtml(model.series)}</span></span></div>` : ''}
            ${model.description ? `<div style="font-size:12px;color:var(--muted-foreground);margin-top:6px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;" title="${escapeHtml(model.description)}">${escapeHtml(model.description)}</div>` : ''}
            <div style="margin-top:8px;display:flex;gap:12px;">
              <div>
                <div style="font-size:11px;color:var(--muted-foreground);">输入价</div>
                <div style="font-size:13px;font-weight:500;color:var(--brand-blue);">¥${inputPrice.toFixed(6)}</div>
              </div>
              <div>
                <div style="font-size:11px;color:var(--muted-foreground);">输出价</div>
                <div style="font-size:13px;font-weight:500;color:var(--brand-blue);">¥${outputPrice.toFixed(6)}</div>
              </div>
              <div>
                <div style="font-size:11px;color:var(--muted-foreground);">倍率</div>
                <div style="font-size:13px;font-weight:500;">${multiplier.toFixed(2)}×</div>
              </div>
            </div>
            ${(thinkingName || nonThinkingName) ? `
              <div style="margin-top:6px;font-size:12px;color:var(--muted-foreground);">
                ${thinkingName ? `<span title="${model.thinking_model_id}">${t('思考:')}${escapeHtml(thinkingName)}</span>` : ''}
                ${thinkingName && nonThinkingName ? ' / ' : ''}
                ${nonThinkingName ? `<span title="${model.non_thinking_model_id}">${t('非思考:')}${escapeHtml(nonThinkingName)}</span>` : ''}
              </div>
            ` : ''}
            ${(rpm > 0 || tpm > 0) ? `
              <div style="margin-top:4px;font-size:12px;color:var(--muted-foreground);">
                速率: ${rpm > 0 ? rpm + ' RPM' : ''}${rpm > 0 && tpm > 0 ? ' / ' : ''}${tpm > 0 ? tpm.toLocaleString() + ' TPM' : ''}
              </div>
            ` : ''}
            ${model.test_ok === true ? `
              <div style="margin-top:4px;font-size:12px;">
                <span class="model-test-indicator pass" title="${escapeHtml(this._formatTestTooltip(model.test_tested_at))}">${model.test_latency_ms}ms${model.test_tokens_per_second ? ' · ' + model.test_tokens_per_second + ' t/s' : ''}</span>
              </div>
            ` : model.test_ok === false ? `
              <div style="margin-top:4px;font-size:12px;">
                <span class="model-test-indicator fail" title="${escapeHtml((model.test_error || t('失败')) + ' · ' + this._formatTestTooltip(model.test_tested_at))}">失败</span>
              </div>
            ` : ''}
          </div>
          <div class="admin-card-footer">
            <button type="button" class="btn btn-sm btn-secondary model-test-btn" data-admin-model-action="test" data-model-id="${escapeHtml(model.id)}">测试</button>
            <button type="button" class="btn btn-sm btn-secondary" data-admin-model-action="edit" data-model-id="${escapeHtml(model.id)}">编辑</button>
            <button type="button" class="btn btn-sm btn-secondary" style="color:var(--destructive);" data-admin-model-action="delete" data-model-id="${escapeHtml(model.id)}">删除</button>
          </div>
        </div>
      `;
    }).join('')}</div>
      ${totalPages > 1 ? this._renderPagination('model', this.modelPage, totalPages, total) : ''}
    `);
  }

  formatRateLimit(rpm, tpm) {
    rpm = parseInt(rpm) || 0;
    tpm = parseInt(tpm) || 0;
    if (rpm === 0 && tpm === 0) return '<span style="color:var(--muted-foreground)">' + t('不限制') + '</span>';
    const parts = [];
    if (rpm > 0) parts.push(`${rpm} RPM`);
    if (tpm > 0) parts.push(`${tpm.toLocaleString()} TPM`);
    return parts.join('<br>');
  }

  toggleSelectAll(checked) {
    // 库视图：对已加载（已展开）的模型当前页全选/取消
    const list = this.modelsData || [];
    if (list.length) {
      list.forEach(m => {
        if (checked) this.selectedModels.add(m.id);
        else this.selectedModels.delete(m.id);
      });
      this.renderModels();
    } else {
      document.querySelectorAll('#adminModelsList tbody input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
        if (checked) this.selectedModels.add(cb.value);
        else this.selectedModels.delete(cb.value);
      });
    }
    this.updateBatchButtons();
  }

  toggleModelSelection(id, checked) {
    if (checked) this.selectedModels.add(id);
    else this.selectedModels.delete(id);
    this._syncAdminModelCardSelection(id);
    this.updateBatchButtons();
  }

  updateBatchButtons() {
    const count = this.selectedModels.size;
    const group = document.getElementById('batchActionsGroup');
    if (group) {
      group.style.display = count > 0 ? 'inline-block' : 'none';
    }
  }

  toggleBatchDropdown(event) {
    event.stopPropagation();
    const group = document.getElementById('batchActionsGroup');
    if (group) group.classList.toggle('open');
  }

  async batchDeleteModels() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;
    if (!await confirm(`${t('确定要删除选中的')}${ids.length}${t('个模型吗？此操作不可撤销。')}`)) return;

    try {
      const response = await fetch('/api/admin/models/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (response.ok) {
        this.selectedModels.clear();
        this._invalidateAdminProviderModelsCache();
        this._notifyModelsCatalogChanged();
        await this.loadModels({ clearSelection: true });
        this.showToast?.(t('已删除选中模型'), 'success');
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || t('批量删除失败'));
      }
    } catch (error) {
      console.error(t('批量删除模型失败:'), error);
      alert(t('批量删除失败'));
    }
  }

  async batchUpdateModels(enabled) {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;
    const action = enabled ? t('启用') : t('禁用');
    if (!await confirm(`${t('确定要')}${action}${t('选中的')}${ids.length}${t('个模型吗？')}`)) return;

    try {
      const response = await fetch('/api/admin/models/batch-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, enabled })
      });
      if (response.ok) {
        this._invalidateAdminProviderModelsCache();
        this._notifyModelsCatalogChanged();
        await this.loadModels();
        this.showToast?.(`${t('已')}${action}${t('选中模型')}`, 'success');
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || `${t('批量')}${action}${t('失败')}`);
      }
    } catch (error) {
      console.error(`${t('批量')}${action}${t('模型失败:')}`, error);
      alert(`${t('批量')}${action}${t('失败')}`);
    }
  }

  showAddModelModal() {
    document.getElementById('modelId').value = '';
    document.getElementById('upstreamModelId').value = '';
    document.getElementById('upstreamModelId').disabled = false;
    document.getElementById('modelAlias').value = '';
    document.getElementById('modelDescription').value = '';
    document.getElementById('modelRateLimitRpm').value = '0';
    document.getElementById('modelRateLimitTpm').value = '0';
    document.getElementById('modelMultiplier').value = '1.0';
    document.getElementById('modelEnabled').value = 'true';
    const freEl = document.getElementById('modelForwardReasoningEffort');
    if (freEl) freEl.value = 'false';
    const testUaEl = document.getElementById('modelTestUserAgent');
    if (testUaEl) testUaEl.value = '';
    
    this.loadProviderOptions().then(() => {
      document.getElementById('modelProvider').value = '';
      this.onModelProviderChange();
      document.getElementById('addModelModal').style.display = 'flex';
      document.getElementById('addModelModal').classList.add('active');
    });
  }

  editModel(model) {
    document.getElementById('modelId').value = model.id;
    document.getElementById('upstreamModelId').value = model.upstream_model_id || '';
    document.getElementById('upstreamModelId').disabled = false;
    document.getElementById('modelAlias').value = model.alias || '';
    document.getElementById('modelSeries').value = model.series || '';
    document.getElementById('modelDescription').value = model.description || '';
    document.getElementById('modelRateLimitRpm').value = model.rate_limit_rpm || 0;
    document.getElementById('modelRateLimitTpm').value = model.rate_limit_tpm || 0;
    document.getElementById('modelMultiplier').value = model.model_multiplier || 1.0;
    document.getElementById('modelEnabled').value = model.enabled.toString();
    const freEl = document.getElementById('modelForwardReasoningEffort');
    if (freEl) freEl.value = (model.forward_reasoning_effort === true).toString();
    const testUaEl = document.getElementById('modelTestUserAgent');
    if (testUaEl) testUaEl.value = model.provider_test_user_agent || '';
    
    this.loadProviderOptions().then(() => {
      document.getElementById('modelProvider').value = model.provider;
      const cachedUa = this._getProviderTestUserAgent(model.provider);
      if (testUaEl && (cachedUa || !testUaEl.value)) testUaEl.value = cachedUa;
      this.loadModelOptions().then(() => {
        document.getElementById('modelThinkingModel').value = model.thinking_model_id || '';
        document.getElementById('modelNonThinkingModel').value = model.non_thinking_model_id || '';
        document.getElementById('addModelModal').style.display = 'flex';
        document.getElementById('addModelModal').classList.add('active');
      });
    });
  }

  async loadModelOptions() {
    try {
      const response = await fetch('/api/admin/models');
      if (!response.ok) return;
      const models = await response.json();
      const options = models.map(m => {
        const label = m.name || m.upstream_model_id || m.id;
        const extra = m.alias && m.alias !== m.name ? ` (${m.alias})` : '';
        return `<option value="${m.id}">${label}${extra}</option>`;
      }).join('');
      setHTML(document.getElementById('modelThinkingModel'), '<option value="">' + t('不设置（使用自身）') + '</option>' + options);
      setHTML(document.getElementById('modelNonThinkingModel'), '<option value="">' + t('不设置（使用自身）') + '</option>' + options);
    } catch (error) {
      console.error(t('加载模型选项失败:'), error);
    }
  }

  async loadProviderOptions() {
    try {
      const response = await fetch('/api/admin/providers');
      if (!response.ok) return;
      const providers = await response.json();
      this._providerOptionsCache = Array.isArray(providers) ? providers : [];
      const select = document.getElementById('modelProvider');
      setHTML(select, this._providerOptionsCache.map(p =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
      ).join(''));
    } catch (error) {
      console.error(t('加载供应商选项失败:'), error);
    }
  }

  _getProviderTestUserAgent(providerId) {
    if (!providerId) return '';
    const p = (this._providerOptionsCache || []).find(x => String(x.id) === String(providerId));
    return (p && p.test_user_agent) || '';
  }

  onModelProviderChange() {
    const providerId = document.getElementById('modelProvider')?.value || '';
    const el = document.getElementById('modelTestUserAgent');
    if (el) el.value = this._getProviderTestUserAgent(providerId);
  }

  applyTestUserAgentPreset(inputId, value) {
    const el = document.getElementById(inputId);
    if (el) {
      el.value = value || '';
      el.focus();
    }
  }

  async saveModel() {
    const id = document.getElementById('modelId').value;
    const upstream_model_id = document.getElementById('upstreamModelId').value.trim();
    const alias = document.getElementById('modelAlias').value;
    const provider = document.getElementById('modelProvider').value;
    const series = document.getElementById('modelSeries').value;
    const description = document.getElementById('modelDescription').value;
    const rate_limit_rpm = parseInt(document.getElementById('modelRateLimitRpm').value);
    const rate_limit_tpm = parseInt(document.getElementById('modelRateLimitTpm').value);
    const model_multiplier = parseFloat(document.getElementById('modelMultiplier').value) || 1.0;
    const enabled = document.getElementById('modelEnabled').value === 'true';
    const thinking_model_id = document.getElementById('modelThinkingModel').value;
    const non_thinking_model_id = document.getElementById('modelNonThinkingModel').value;
    const forward_reasoning_effort = document.getElementById('modelForwardReasoningEffort')?.value === 'true';
    const test_user_agent = document.getElementById('modelTestUserAgent')?.value || '';

    if (!upstream_model_id || !provider) {
      alert(t('请填写上游模型ID和提供商'));
      return;
    }

    try {
      const response = await fetch('/api/admin/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, upstream_model_id, alias, provider, series, description, input_price_per_1k_tokens: 1.0, output_price_per_1k_tokens: 1.0, rate_limit_rpm, rate_limit_tpm, enabled, model_multiplier, thinking_model_id, non_thinking_model_id, forward_reasoning_effort, test_user_agent })
      });

      if (response.ok) {
        const cached = (this._providerOptionsCache || []).find(p => String(p.id) === String(provider));
        if (cached) cached.test_user_agent = test_user_agent;
        this.closeModals();
        this._invalidateAdminProviderModelsCache();
        this._notifyModelsCatalogChanged();
        this.loadModels();
      } else {
        alert(t('保存失败'));
      }
    } catch (error) {
      console.error(t('保存模型失败:'), error);
      alert(t('保存失败'));
    }
  }

  async deleteModel(id) {
    if (!await confirm(t('确定要删除此模型吗？'))) return;

    try {
      const response = await fetch(`/api/admin/models/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        this.selectedModels.delete(id);
        this._invalidateAdminProviderModelsCache();
        this._notifyModelsCatalogChanged();
        await this.loadModels({ clearSelection: false });
        this.showToast?.(t('模型已删除'), 'success');
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || t('删除失败'));
      }
    } catch (error) {
      console.error(t('删除模型失败:'), error);
      alert(t('删除失败'));
    }
  }

  // 供应商管理
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'admin-toast admin-toast-' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.classList.add('admin-toast-show'); });
    setTimeout(() => {
      toast.classList.remove('admin-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  toggleProviderMoreMenu(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('providerMoreDropdown');
    const btn = document.getElementById('providerMoreMenuBtn');
    if (!dropdown) return;
    const open = dropdown.style.display !== 'none';
    if (open) {
      this.hideProviderMoreMenu();
    } else {
      dropdown.style.display = 'block';
      if (btn) btn.setAttribute('aria-expanded', 'true');
      this._providerMoreMenuOpen = true;
      setTimeout(() => {
        const handler = (ev) => {
          if (!document.getElementById('providerMoreMenu')?.contains(ev.target)) {
            this.hideProviderMoreMenu();
            document.removeEventListener('click', handler);
          }
        };
        document.addEventListener('click', handler);
      }, 0);
    }
  }

  hideProviderMoreMenu() {
    const dropdown = document.getElementById('providerMoreDropdown');
    const btn = document.getElementById('providerMoreMenuBtn');
    if (dropdown) dropdown.style.display = 'none';
    if (btn) btn.setAttribute('aria-expanded', 'false');
    this._providerMoreMenuOpen = false;
  }

  toggleProviderRowMenu(providerId, e) {
    if (e) e.stopPropagation();
    const menuId = `provider-row-menu-${providerId}`;
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const wasOpen = menu.style.display === 'block';
    document.querySelectorAll('.provider-row-dropdown').forEach(el => { el.style.display = 'none'; });
    this._openProviderRowMenuId = null;
    if (!wasOpen) {
      menu.style.display = 'block';
      this._openProviderRowMenuId = providerId;
      setTimeout(() => {
        const handler = (ev) => {
          if (!menu.contains(ev.target) && !ev.target.closest(`[data-row-menu-btn="${providerId}"]`)) {
            menu.style.display = 'none';
            this._openProviderRowMenuId = null;
            document.removeEventListener('click', handler);
          }
        };
        document.addEventListener('click', handler);
      }, 0);
    }
  }

  _buildProviderListParams(pageOverride) {
    const page = pageOverride != null ? pageOverride : this.providerPage;
    const params = new URLSearchParams({
      page: String(page + 1),
      limit: String(this.providerPageSize)
    });
    const q = (document.getElementById('providerSearchInput')?.value || '').trim();
    const status = document.getElementById('providerStatusFilter')?.value || '';
    const scope = document.getElementById('providerScopeFilter')?.value || '';
    const keyMode = document.getElementById('providerKeyModeFilter')?.value || '';
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (scope) params.set('scope', scope);
    if (keyMode) params.set('key_mode', keyMode);
    if (this.activeProviderTagId != null) params.set('tag_id', String(this.activeProviderTagId));
    return params;
  }

  async loadProviders(options = {}) {
    try {
      if (options.resetPage) {
        this.providerPage = 0;
        this.globalProviderPage = 0;
        this.userProviderPage = 0;
      }
      const listEl = document.getElementById('adminProvidersList');
      if (listEl) setHTML(listEl, pageLoadingHtml(t('加载供应商...')));
      await this.loadProviderTags();

      const params = this._buildProviderListParams();
      const response = await fetch(`/api/admin/providers?${params}`);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || t('加载失败'));
      }
      const raw = await response.json();
      const { items, total, stats, serverPaged } = this._normalizeListResponse(raw);
      this.providersData = items;
      this.providersTotal = total;
      this.providersStats = stats || null;
      this._providersServerPaged = serverPaged !== false;

      // 页码越界时回退到最后一页
      const totalPages = Math.max(1, Math.ceil((this.providersTotal || 0) / this.providerPageSize));
      if (this.providerPage >= totalPages && totalPages > 0) {
        this.providerPage = Math.max(0, totalPages - 1);
        if (this.providersTotal > 0 && items.length === 0) {
          return this.loadProviders();
        }
      }

      this.renderProviders();
    } catch (error) {
      console.error(t('加载供应商列表失败:'), error);
      setHTML(document.getElementById('adminProvidersList'), `
        <div class="admin-empty-state">
          <p style="color:var(--destructive);">${escapeHtml(error.message || t('加载供应商列表失败'))}</p>
          <button class="btn btn-secondary btn-sm" style="margin-top:12px;" onclick="adminApp.loadProviders()">重试</button>
        </div>`);
    }
  }

  filterProviders() {
    this._debounceSearch('_providerFilterTimer', () => {
      this.loadProviders({ resetPage: true });
    });
  }

  /** 主栏 / 悬浮顶栏双向同步后触发供应商筛选 */
  onAdminProviderFilterInput(field, value, source) {
    const pairs = {
      search: ['providerSearchInput', 'adminProvidersStickySearch'],
      status: ['providerStatusFilter', 'adminProvidersStickyStatus'],
      scope: ['providerScopeFilter', 'adminProvidersStickyScope'],
      keyMode: ['providerKeyModeFilter', 'adminProvidersStickyKeyMode']
    };
    const [mainId, stickyId] = pairs[field] || [];
    if (mainId) this._syncPairedControl(mainId, stickyId, value, source);
    this._updateAdminProvidersStickyMoreBtn();
    this.filterProviders();
  }

  _hasActiveProviderFilters() {
    const q = this._searchQ('providerSearchInput');
    const status = document.getElementById('providerStatusFilter')?.value || '';
    const scope = document.getElementById('providerScopeFilter')?.value || '';
    const keyMode = document.getElementById('providerKeyModeFilter')?.value || '';
    return !!(q || status || scope || keyMode || this.activeProviderTagId);
  }

  clearProviderFilters() {
    const ids = [
      'providerSearchInput', 'adminProvidersStickySearch',
      'providerStatusFilter', 'adminProvidersStickyStatus',
      'providerScopeFilter', 'adminProvidersStickyScope',
      'providerKeyModeFilter', 'adminProvidersStickyKeyMode'
    ];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this.activeProviderTagId = null;
    this._updateAdminProvidersStickyMoreBtn();
    this.renderProviderTagBar();
    this.loadProviders({ resetPage: true });
  }

  // ===== 供应商管理悬浮顶栏 =====

  _initAdminProvidersStickyBar() {
    const sentinel = document.getElementById('adminProvidersStickySentinel');
    if (!sentinel) return;

    if (this._adminProvidersStickyObserver) {
      this._adminProvidersStickyObserver.disconnect();
      this._adminProvidersStickyObserver = null;
    }

    this._adminProvidersStickyObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const show = this._isStickySentinelPastTop(entry) && this.currentPage === 'adminProviders';
      this._syncAdminProvidersStickyVisibility(show);
    }, { root: null, threshold: [0, 0.01, 1], rootMargin: '0px' });

    this._adminProvidersStickyObserver.observe(sentinel);
    this._syncAdminProvidersStickyVisibility(
      this._isStickySentinelPastTop(sentinel) && this.currentPage === 'adminProviders'
    );
    this._syncAdminProvidersStickyControlsFromMain();
  }

  _syncAdminProvidersStickyVisibility(visible) {
    const bar = document.getElementById('adminProvidersStickyBar');
    if (!bar) return;
    const shouldShow = !!visible && this.currentPage === 'adminProviders';
    const wasVisible = bar.classList.contains('is-visible');
    if (shouldShow === wasVisible) return;
    bar.classList.toggle('is-visible', shouldShow);
    bar.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    if (!shouldShow) this._setAdminProvidersStickyMoreOpen(false);
  }

  _syncAdminProvidersStickyControlsFromMain() {
    const pairs = [
      ['providerSearchInput', 'adminProvidersStickySearch'],
      ['providerStatusFilter', 'adminProvidersStickyStatus'],
      ['providerScopeFilter', 'adminProvidersStickyScope'],
      ['providerKeyModeFilter', 'adminProvidersStickyKeyMode']
    ];
    for (const [mainId, stickyId] of pairs) {
      const mainEl = document.getElementById(mainId);
      const stickyEl = document.getElementById(stickyId);
      if (mainEl && stickyEl && stickyEl.value !== mainEl.value) stickyEl.value = mainEl.value;
    }
    const count = document.getElementById('providerCount')?.textContent || '';
    const stickyCount = document.getElementById('adminProvidersStickyCount');
    if (stickyCount) stickyCount.textContent = count;
    const hasFilter = this._hasActiveProviderFilters();
    const clearMain = document.getElementById('clearProviderFiltersBtn');
    const clearSticky = document.getElementById('adminProvidersStickyClearBtn');
    if (clearMain) clearMain.style.display = hasFilter ? '' : 'none';
    if (clearSticky) clearSticky.style.display = hasFilter ? '' : 'none';
    this._updateAdminProvidersStickyMoreBtn();
  }

  toggleAdminProvidersStickyMore() {
    this._setAdminProvidersStickyMoreOpen(!this._adminProvidersStickyMoreOpen);
  }

  _setAdminProvidersStickyMoreOpen(open) {
    this._adminProvidersStickyMoreOpen = !!open;
    const panel = document.getElementById('adminProvidersStickyAdvanced');
    if (panel) {
      panel.style.display = open ? 'flex' : 'none';
      panel.classList.toggle('is-open', open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    this._updateAdminProvidersStickyMoreBtn();
  }

  _updateAdminProvidersStickyMoreBtn() {
    const btn = document.getElementById('adminProvidersStickyMoreBtn');
    if (!btn) return;
    // 标签已常驻顶栏，高级区仅密钥模式等
    const hasAdvanced = !!document.getElementById('providerKeyModeFilter')?.value;
    const open = !!this._adminProvidersStickyMoreOpen;
    btn.classList.toggle('library-more-filters-active', open || hasAdvanced);
    btn.textContent = open ? t('收起筛选') : t('更多筛选');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  applyProviderStatFilter(type) {
    const status = document.getElementById('providerStatusFilter');
    const scope = document.getElementById('providerScopeFilter');
    const keyMode = document.getElementById('providerKeyModeFilter');
    // 先重置再应用
    if (status) status.value = '';
    if (scope) scope.value = '';
    if (keyMode) keyMode.value = '';
    this.activeProviderTagId = null;
    if (type === 'global' && scope) scope.value = 'global';
    else if (type === 'user' && scope) scope.value = 'user';
    else if (type === 'enabled' && status) status.value = 'enabled';
    else if (type === 'script' && keyMode) keyMode.value = 'script';
    this._syncAdminProvidersStickyControlsFromMain();
    this.renderProviderTagBar();
    this.loadProviders({ resetPage: true });
  }

  filterProvidersByTag(tagId) {
    const id = tagId == null ? null : Number(tagId);
    this.activeProviderTagId = (this.activeProviderTagId === id) ? null : id;
    this._updateAdminProvidersStickyMoreBtn();
    this.renderProviderTagBar();
    this.loadProviders({ resetPage: true });
  }

  /** 当前页数据（服务端已筛选分页）；兼容旧调用 */
  _getFilteredProviders() {
    return this.providersData || [];
  }

  _providerEmptyStateHtml() {
    return `
      <div class="admin-empty-state provider-empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
        </svg>
        <p class="provider-empty-title">还没有供应商</p>
        <p class="provider-empty-desc">连接上游 API，导入模型后即可在模型管理中启用。</p>
        <ol class="provider-empty-steps">
          <li>选择或自定义供应商</li>
          <li>填写 API Key</li>
          <li>同步模型列表</li>
        </ol>
        <div class="provider-empty-actions">
          <button class="btn btn-primary" onclick="adminApp.showAddProviderWizard()">添加供应商</button>
          <button class="btn btn-secondary" onclick="document.getElementById('importOpenCodeBtn')?.click()">导入配置</button>
        </div>
      </div>`;
  }

  _providerNoMatchHtml() {
    return `
      <div class="admin-empty-state">
        <p>未找到匹配的供应商</p>
        <button class="btn btn-sm btn-secondary" style="margin-top:12px;" onclick="adminApp.clearProviderFilters()">清除筛选</button>
      </div>`;
  }

  renderProviders() {
    const providers = this.providersData || [];
    const total = this.providersTotal || 0;
    const stats = this.providersStats || {};
    const container = document.getElementById('adminProvidersList');
    if (!container) return;

    const hasFilter = this._hasActiveProviderFilters();
    const totalPages = Math.max(1, Math.ceil(total / this.providerPageSize));
    if (this.providerPage >= totalPages) this.providerPage = Math.max(0, totalPages - 1);

    const countText = !hasFilter
      ? `${t('共')}${total}${t('个')}`
      : `${t('匹配')}${total}${t('个 · 本页')}${providers.length}`;
    const countEl = document.getElementById('providerCount');
    if (countEl) countEl.textContent = countText;
    const stickyCount = document.getElementById('adminProvidersStickyCount');
    if (stickyCount) stickyCount.textContent = countText;
    const clearBtn = document.getElementById('clearProviderFiltersBtn');
    if (clearBtn) clearBtn.style.display = hasFilter ? '' : 'none';
    const stickyClear = document.getElementById('adminProvidersStickyClearBtn');
    if (stickyClear) stickyClear.style.display = hasFilter ? '' : 'none';
    this._updateAdminProvidersStickyMoreBtn();

    // 统计卡片基于全库（服务端 stats），避免分页导致数字失真
    const globalCount = stats.globalCount ?? 0;
    const userCount = stats.userCount ?? 0;
    const enabledCount = stats.enabledCount ?? 0;
    const scriptCount = stats.scriptCount ?? 0;
    const allTotal = stats.total ?? total;
    const scopeVal = document.getElementById('providerScopeFilter')?.value || '';
    const statusVal = document.getElementById('providerStatusFilter')?.value || '';
    const keyModeVal = document.getElementById('providerKeyModeFilter')?.value || '';

    const statsContainer = document.getElementById('providerStatsCards');
    if (statsContainer) {
      setHTML(statsContainer, `
        <div class="admin-stat-card admin-stat-card-clickable ${scopeVal === 'global' ? 'active' : ''}" onclick="adminApp.applyProviderStatFilter('global')" title="${t('筛选全局供应商')}">
          <div class="admin-stat-card-icon blue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${globalCount}</span>
            <span class="admin-stat-card-label">全局供应商</span>
          </div>
        </div>
        <div class="admin-stat-card admin-stat-card-clickable ${scopeVal === 'user' ? 'active' : ''}" onclick="adminApp.applyProviderStatFilter('user')" title="${t('筛选用户供应商')}">
          <div class="admin-stat-card-icon purple">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${userCount}</span>
            <span class="admin-stat-card-label">用户供应商</span>
          </div>
        </div>
        <div class="admin-stat-card admin-stat-card-clickable ${statusVal === 'enabled' ? 'active' : ''}" onclick="adminApp.applyProviderStatFilter('enabled')" title="${t('筛选已启用')}">
          <div class="admin-stat-card-icon green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${enabledCount}</span>
            <span class="admin-stat-card-label">已启用</span>
          </div>
        </div>
        <div class="admin-stat-card admin-stat-card-clickable ${keyModeVal === 'script' ? 'active' : ''}" onclick="adminApp.applyProviderStatFilter('script')" title="${t('筛选脚本模式')}">
          <div class="admin-stat-card-icon amber">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${scriptCount}</span>
            <span class="admin-stat-card-label">脚本模式</span>
          </div>
        </div>
      `);
    }

    // 全库为空
    if (allTotal === 0 && !hasFilter) {
      setHTML(container, this._providerEmptyStateHtml());
      return;
    }

    // 筛选后无结果
    if (providers.length === 0) {
      setHTML(container, this._providerNoMatchHtml());
      return;
    }

    // 当前页内按全局/用户分组展示（数据已是本页）
    const globalProviders = providers.filter(p => !p.created_by);
    const userProviders = providers.filter(p => p.created_by);
    const globalPage = {
      items: globalProviders,
      total: globalProviders.length,
      page: 0,
      totalPages: 1
    };
    const userPage = {
      items: userProviders,
      total: userProviders.length,
      page: 0,
      totalPages: 1
    };

    const tableBtn = document.getElementById('providerViewTableBtn');
    const cardBtn = document.getElementById('providerViewCardBtn');
    if (tableBtn) tableBtn.className = this.providerViewMode === 'table' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary';
    if (cardBtn) cardBtn.className = this.providerViewMode === 'card' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary';

    const paginationHtml = totalPages > 1
      ? this._renderPagination('provider', this.providerPage, totalPages, total)
      : '';

    const pageIds = providers.map(p => p.id);
    const allPageSelected = pageIds.length > 0 && pageIds.every(id => this.selectedProviders.has(id));
    const selectAllBar = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:13px;">
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
          <input type="checkbox" class="checkbox" id="providerSelectAllPage" ${allPageSelected ? 'checked' : ''}
            onchange="adminApp.toggleSelectAllProvidersOnPage(this.checked)">
          <span>全选本页</span>
        </label>
        <span style="color:var(--muted-foreground);">勾选后可批量同步模型</span>
      </div>`;

    if (this.providerViewMode === 'card') {
      this._renderProviderCards(container, globalPage, userPage, paginationHtml, selectAllBar);
    } else {
      setHTML(container, `
        ${selectAllBar}
        ${globalProviders.length > 0 ? `
          <div style="margin-bottom:24px;">
            <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">${t('全局供应商')} <span style="font-weight:400;color:var(--muted-foreground);font-size:13px;">(本页 ${globalProviders.length})</span></h3>
            ${this._renderProviderTable(globalProviders)}
          </div>
        ` : ''}
        ${userProviders.length > 0 ? `
          <div>
            <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">${t('用户供应商')} <span style="font-weight:400;color:var(--muted-foreground);font-size:13px;">(本页 ${userProviders.length})</span></h3>
            ${this._renderProviderTable(userProviders, true)}
          </div>
        ` : ''}
        ${paginationHtml}
      `);
    }
    this.updateProviderBatchBar();
    // 额度改为按需查询（更多菜单 / 手动刷新），打开页不自动外呼
  }

  refreshPageQuotas() {
    const visible = (this.providersData || []).filter(p => p.quota_enabled);
    if (visible.length === 0) {
      this.showToast(t('当前页没有启用额度查询的供应商'), 'info');
      return;
    }
    this.showToast(`${t('正在查询')}${visible.length}${t('个供应商额度…')}`, 'info');
    for (const p of visible) {
      this.loadProviderQuotaInline(p.id);
    }
  }

  _renderProviderRowActions(provider, { isCard = false } = {}) {
    const pid = provider.id;
    const quotaEnabled = !!provider.quota_enabled;
    const isScriptKey = (provider.key_mode || 'fixed') === 'script';
    const pingBtnId = isCard ? `ping-btn-card-${pid}` : `ping-btn-${pid}`;
    return `
      <div class="provider-row-actions">
        <label class="toggle-switch" title="${provider.enabled ? t('禁用供应商') : t('启用供应商')}" style="transform:scale(0.8);">
          <input type="checkbox" ${provider.enabled ? 'checked' : ''} onchange="adminApp.toggleProviderEnabled('${pid}', this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <button class="btn btn-sm btn-secondary" title="${t('同步模型')}" onclick="adminApp.fetchProviderModels('${pid}')">同步模型</button>
        <button class="btn btn-sm btn-secondary" title="${t('编辑')}" onclick="adminApp.editProviderById('${pid}')">编辑</button>
        <div class="provider-row-more-wrap">
          <button type="button" class="btn btn-sm btn-secondary" data-row-menu-btn="${pid}" title="${t('更多操作')}" onclick="adminApp.toggleProviderRowMenu('${pid}', event)">更多 ▾</button>
          <div class="provider-row-dropdown" id="provider-row-menu-${pid}" style="display:none;" role="menu">
            <button type="button" class="provider-more-item" id="${pingBtnId}" onclick="adminApp.pingProvider('${pid}');adminApp.toggleProviderRowMenu('${pid}', event);" role="menuitem">检测连通性</button>
            ${isScriptKey ? `<button type="button" class="provider-more-item" style="color:var(--warning);" onclick="adminApp.refreshProviderKey('${pid}');adminApp.toggleProviderRowMenu('${pid}\', event);" role="menuitem">${t('刷新密钥')}</button>` : ''}
            <div class="provider-more-item provider-more-item-toggle" role="menuitem">
              <span>额度查询</span>
              <label class="toggle-switch" style="transform:scale(0.75);" onclick="event.stopPropagation()">
                <input type="checkbox" ${quotaEnabled ? 'checked' : ''} onchange="adminApp.toggleProviderQuota('${pid}', this.checked)">
                <span class="toggle-slider"></span>
              </label>
            </div>
            <button type="button" class="provider-more-item" id="quota-btn-${pid}" onclick="adminApp.checkProviderQuota('${pid}');adminApp.toggleProviderRowMenu('${pid}', event);" ${!quotaEnabled ? 'disabled style="opacity:0.45;"' : ''} role="menuitem">查询额度</button>
            <button type="button" class="provider-more-item provider-more-item-danger" onclick="adminApp.deleteProvider('${pid}');adminApp.toggleProviderRowMenu('${pid}', event);" role="menuitem">删除</button>
          </div>
        </div>
      </div>`;
  }

  _renderProviderTable(providerList, showOwner = false) {
    if (providerList.length === 0) return '<p style="text-align:center;color:var(--muted-foreground);padding:12px;font-size:13px;">' + t('暂无') + '</p>';

    return `
      <table>
        <thead>
          <tr>
            <th class="provider-select-cell"></th>
            <th>名称</th>
            ${showOwner ? '<th>' + t('创建者') + '</th>' : ''}
            <th>标签</th>
            <th>密钥</th>
            <th>代理</th>
            <th>额度</th>
            <th>延迟</th>
            <th>格式</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${providerList.map(provider => {
            const pid = provider.id;
            const selected = this.selectedProviders.has(pid);
            const quotaEnabled = provider.quota_enabled;
            const isScriptKey = (provider.key_mode || 'fixed') === 'script';
            const lastError = provider.key_last_error;
            const hasError = isScriptKey && lastError && lastError.trim();
            const errorIcon = hasError
              ? ` <span style="color:var(--destructive);cursor:pointer;font-size:11px;" title="${escapeHtml(lastError).replace(/"/g, '&quot;')}">⚠️</span>`
              : '';
            const keyCount = provider.api_key_count || 0;
            const keyModeDisplay = isScriptKey
              ? `<span style="color:var(--warning);font-size:12px;" title="${t('脚本刷新模式')}${hasError ? '\n上次错误: ' + escapeHtml(lastError) : ''}">⚡ ${t('脚本')}${errorIcon}</span>`
              : (keyCount > 1
                ? `<span style="font-size:12px;" title="${provider.api_key_select_mode === 'weight' ? t('权重模式') : t('顺序模式')}">${t('固定 ·')}${keyCount} Key${provider.api_key_select_mode === 'weight' ? t(' · 权重') : ''}</span>`
                : '<span style="color:var(--muted-foreground);font-size:12px;">' + t('固定') + '</span>');
            let proxyDisplay = this._formatProviderProxyDisplay(provider);
            const statusPill = provider.enabled
              ? '<span class="status-pill status-pill-on">' + t('启用') + '</span>'
              : '<span class="status-pill status-pill-off">' + t('禁用') + '</span>';
            const safePid = String(pid).replace(/'/g, "\\'");
            return `
            <tr class="provider-drop-target"
                data-provider-id="${escapeHtml(pid)}"
                ondragover="adminApp.handleProviderDragOver(event)"
                ondragleave="adminApp.handleProviderDragLeave(event)"
                ondrop="adminApp.handleProviderDrop(event, '${safePid}')">
              <td class="provider-select-cell">
                <input type="checkbox" class="checkbox provider-select-cb" data-provider-id="${escapeHtml(pid)}"
                  ${selected ? 'checked' : ''}
                  onchange="adminApp.toggleProviderSelection('${safePid}', this.checked)">
              </td>
              <td>
                <div class="provider-row-name">${escapeHtml(provider.name)}</div>
                <div class="provider-row-url" title="${escapeHtml(provider.base_url || '')}">${escapeHtml(provider.base_url || '')}</div>
              </td>
              ${showOwner ? `<td style="font-size:12px;color:var(--muted-foreground);">${escapeHtml(provider.nickname || provider.display_name || provider.username || t('未知'))}</td>` : ''}
              <td class="provider-tags-cell">${this._renderProviderTagChips(provider.tags, pid)}</td>
              <td>${keyModeDisplay}</td>
              <td>${proxyDisplay}</td>
              <td>
                <div id="quota-display-${provider.id}" style="min-width:100px;">
                  ${quotaEnabled
                    ? '<span style="color:var(--muted-foreground);font-size:12px;" title="' + t('在「更多」中查询或使用顶部「刷新本页额度」') + '">' + t('已启用') + '</span>'
                    : '<span style="color:var(--muted-foreground);font-size:12px;">' + t('未启用') + '</span>'}
                </div>
              </td>
              <td>
                <div id="ping-display-${provider.id}" style="min-width:80px;font-size:12px;color:var(--muted-foreground);">-</div>
              </td>
              <td>${escapeHtml(formatDisplayName(provider.format))}</td>
              <td>${statusPill}</td>
              <td>${this._renderProviderRowActions(provider)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  providerPageGo(page) {
    this.providerPage = Math.max(0, page);
    this.loadProviders();
  }

  // 兼容旧分页回调
  globalProviderPageGo(page) {
    this.providerPageGo(page);
  }

  userProviderPageGo(page) {
    this.providerPageGo(page);
  }

  async editProviderById(providerId) {
    try {
      const res = await fetch(`/api/admin/providers/${encodeURIComponent(providerId)}`);
      if (res.ok) {
        const provider = await res.json();
        this.editProvider(provider);
        return;
      }
    } catch (e) {
      console.warn(t('加载供应商详情失败，回退列表数据'), e);
    }
    const provider = (this.providersData || []).find(p => p.id === providerId);
    if (!provider) { this.showToast(t('供应商不存在，请刷新后重试'), 'error'); return; }
    this.editProvider(provider);
  }

  // ========== 供应商多 API Key 编辑 ==========
  _getProviderKeySelectMode() {
    const checked = document.querySelector('input[name="providerKeySelectMode"]:checked');
    return checked?.value === 'weight' ? 'weight' : 'order';
  }

  _setProviderKeySelectMode(mode) {
    const m = mode === 'weight' ? 'weight' : 'order';
    document.querySelectorAll('input[name="providerKeySelectMode"]').forEach(el => {
      el.checked = el.value === m;
    });
    this.onProviderKeySelectModeChange();
  }

  onProviderKeySelectModeChange() {
    const list = document.getElementById('providerApiKeysList');
    if (!list) return;
    const weight = this._getProviderKeySelectMode() === 'weight';
    list.classList.toggle('is-weight-mode', weight);
  }

  _syncProviderFixedKeysVisibility() {
    const mode = document.getElementById('providerKeyMode')?.value || 'fixed';
    const section = document.getElementById('providerFixedKeysSection');
    if (section) {
      // 脚本模式仍展示，但说明主 Key 仅作缓存；多 Key 选择仅对固定模式生效
      section.style.opacity = mode === 'script' ? '0.65' : '1';
    }
  }

  /**
   * @param {{ key?: string, weight?: number, enabled?: boolean }[]} [entries]
   */
  renderProviderApiKeysEditor(entries) {
    const list = document.getElementById('providerApiKeysList');
    if (!list) return;
    let items = Array.isArray(entries) ? entries.map(e => ({
      key: e?.key || e?.api_key || '',
      weight: e?.weight > 0 ? e.weight : 1,
      enabled: e?.enabled !== false
    })) : [];
    if (items.length === 0) items = [{ key: '', weight: 1, enabled: true }];
    this._providerApiKeyEditorItems = items;
    this._renderProviderApiKeyRows();
  }

  _renderProviderApiKeyRows() {
    const list = document.getElementById('providerApiKeysList');
    if (!list) return;
    const items = this._providerApiKeyEditorItems || [{ key: '', weight: 1 }];
    const multi = items.length > 1;
    list.classList.toggle('is-weight-mode', this._getProviderKeySelectMode() === 'weight');

    const primaryIdx = items.findIndex((i) => i.enabled !== false);
    const hasEnabled = primaryIdx >= 0;

    setHTML(list, items.map((item, index) => {
      const enabled = item.enabled !== false;
      const isPrimary = hasEnabled && index === primaryIdx;
      const mainBadge = isPrimary
        ? `<span class="provider-api-key-main-badge" title="${t('主 Key：获取模型列表 / 连通性 / 额度')}">${t('主 Key')}</span>`
        : `<button type="button" class="provider-api-key-make-primary" data-key-index="${index}"
             onclick="adminApp.setProviderPrimaryKey(${index})" title="${t('设为主 Key')}">设为主</button>`;
      const disableBtn = `<button type="button" class="provider-api-key-disable ${enabled ? '' : 'is-on'}" data-key-index="${index}"
             onclick="adminApp.toggleProviderApiKeyEnabled(${index})" title="${enabled ? t('禁用此 Key') : t('启用此 Key')}">
             ${enabled ? t('禁用') : t('已禁用')}</button>`;
      return `
        <div class="provider-api-key-row${enabled ? '' : ' is-disabled'}" data-key-index="${index}" draggable="${multi && enabled ? 'true' : 'false'}">
          <span class="provider-api-key-drag" title="${multi ? t('拖动排序') : t('仅 1 个 Key 时无需排序')}" aria-hidden="true">⋮⋮</span>
          <div class="provider-api-key-input-wrap">
            <input type="password" class="input provider-api-key-input" data-key-index="${index}"
              value="${escapeHtml(item.key || '')}"
              placeholder="${item.key ? (enabled ? t('已配置，可修改') : t('已禁用')) : 'API Key'}"
              autocomplete="off" spellcheck="false"
              oninput="adminApp.onProviderApiKeyInput(${index}, this.value)">
            <button type="button" class="provider-api-key-toggle" data-key-index="${index}"
              onclick="adminApp.toggleProviderApiKeyVisibility(${index}, this)"
              title="${t('显示 Key')}" aria-label="${t('显示 Key')}">
              <svg class="provider-api-key-eye-show" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg class="provider-api-key-eye-hide" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="display:none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
          <div class="provider-api-key-main-badge-wrap">${mainBadge}</div>
          <div class="provider-api-key-weight-wrap">
            <label>权重</label>
            <input type="number" class="input" min="1" step="1" value="${Number(item.weight) > 0 ? Number(item.weight) : 1}"
              oninput="adminApp.onProviderApiKeyWeightInput(${index}, this.value)">
          </div>
          ${disableBtn}
          <button type="button" class="btn btn-sm btn-secondary provider-api-key-remove"
            style="${multi ? '' : 'visibility:hidden;'}"
            onclick="adminApp.removeProviderApiKeyRow(${index})" title="${t('删除')}">删除</button>
        </div>`;
    }).join(''));

    this._bindProviderApiKeyDrag(list);
    // 同步隐藏兼容字段
    const hidden = document.getElementById('providerApiKey');
    if (hidden) hidden.value = items.find((i) => i.enabled !== false)?.key || items[0]?.key || '';
  }

  onProviderApiKeyInput(index, value) {
    if (!this._providerApiKeyEditorItems) this._providerApiKeyEditorItems = [];
    if (!this._providerApiKeyEditorItems[index]) this._providerApiKeyEditorItems[index] = { key: '', weight: 1 };
    this._providerApiKeyEditorItems[index].key = value;
    const hidden = document.getElementById('providerApiKey');
    if (hidden && index === 0) hidden.value = value;
  }

  /** 切换 API Key 输入框明文/密文显示 */
  toggleProviderApiKeyVisibility(index, btn) {
    const list = document.getElementById('providerApiKeysList');
    const input = list?.querySelector(`.provider-api-key-input[data-key-index="${index}"]`);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    if (btn) {
      btn.title = show ? t('隐藏 Key') : t('显示 Key');
      btn.setAttribute('aria-label', show ? t('隐藏 Key') : t('显示 Key'));
      btn.classList.toggle('is-visible', show);
      const eyeShow = btn.querySelector('.provider-api-key-eye-show');
      const eyeHide = btn.querySelector('.provider-api-key-eye-hide');
      if (eyeShow) eyeShow.style.display = show ? 'none' : '';
      if (eyeHide) eyeHide.style.display = show ? '' : 'none';
    }
  }

  onProviderApiKeyWeightInput(index, value) {
    if (!this._providerApiKeyEditorItems) this._providerApiKeyEditorItems = [];
    if (!this._providerApiKeyEditorItems[index]) this._providerApiKeyEditorItems[index] = { key: '', weight: 1 };
    const n = parseFloat(value);
    this._providerApiKeyEditorItems[index].weight = Number.isFinite(n) && n > 0 ? n : 1;
  }

  addProviderApiKeyRow() {
    if (!this._providerApiKeyEditorItems) this._providerApiKeyEditorItems = [{ key: '', weight: 1, enabled: true }];
    this._providerApiKeyEditorItems.push({ key: '', weight: 1, enabled: true });
    this._renderProviderApiKeyRows();
  }

  removeProviderApiKeyRow(index) {
    if (!this._providerApiKeyEditorItems || this._providerApiKeyEditorItems.length <= 1) return;
    this._providerApiKeyEditorItems.splice(index, 1);
    this._renderProviderApiKeyRows();
  }

  /** 将指定 Key 设为主 Key（移动到列表首位） */
  setProviderPrimaryKey(index) {
    const items = this._providerApiKeyEditorItems;
    if (!items || index < 0 || index >= items.length) return;
    const [moved] = items.splice(index, 1);
    items.unshift(moved);
    this._providerApiKeyEditorItems = items;
    this._renderProviderApiKeyRows();
  }

  /** 禁用 / 启用指定 Key */
  toggleProviderApiKeyEnabled(index) {
    const items = this._providerApiKeyEditorItems;
    if (!items || index < 0 || index >= items.length) return;
    const it = items[index];
    if (!it) return;
    it.enabled = it.enabled === false;
    this._renderProviderApiKeyRows();
  }

  _bindProviderApiKeyDrag(list) {
    let dragIndex = null;
    list.querySelectorAll('.provider-api-key-row').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        if ((this._providerApiKeyEditorItems || []).length <= 1) {
          e.preventDefault();
          return;
        }
        dragIndex = parseInt(row.dataset.keyIndex, 10);
        row.classList.add('provider-key-dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(dragIndex));
        } catch (_) {}
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('provider-key-dragging');
        list.querySelectorAll('.provider-key-drag-over').forEach(el => el.classList.remove('provider-key-drag-over'));
        dragIndex = null;
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('provider-key-drag-over');
        try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      });
      row.addEventListener('dragleave', () => row.classList.remove('provider-key-drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('provider-key-drag-over');
        const to = parseInt(row.dataset.keyIndex, 10);
        let from = dragIndex;
        try {
          const d = e.dataTransfer.getData('text/plain');
          if (d !== '') from = parseInt(d, 10);
        } catch (_) {}
        if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
        const items = this._providerApiKeyEditorItems || [];
        if (from < 0 || from >= items.length || to < 0 || to >= items.length) return;
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        this._providerApiKeyEditorItems = items;
        this._renderProviderApiKeyRows();
      });
    });
  }

  /** 收集表单中的 Key 列表（过滤空 Key） */
  _collectProviderApiKeysFromForm() {
    // 从 DOM 再读一遍，防止输入未同步
    const rows = document.querySelectorAll('#providerApiKeysList .provider-api-key-row');
    const items = [];
    rows.forEach((row, index) => {
      const keyInput = row.querySelector('.provider-api-key-input');
      const weightInput = row.querySelector('.provider-api-key-weight-wrap input');
      const key = (keyInput?.value || '').trim();
      const weight = parseFloat(weightInput?.value);
      if (!key) return;
      items.push({
        key,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        enabled: !row.classList.contains('is-disabled')
      });
    });
    // 若 DOM 为空但内存有值
    if (items.length === 0 && Array.isArray(this._providerApiKeyEditorItems)) {
      for (const e of this._providerApiKeyEditorItems) {
        const key = String(e?.key || '').trim();
        if (!key) continue;
        items.push({ key, weight: e.weight > 0 ? e.weight : 1, enabled: e.enabled !== false });
      }
    }
    return items;
  }

  setProviderView(mode) {
    this.providerViewMode = mode;
    document.getElementById('providerViewTableBtn').className = mode === 'table' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary';
    document.getElementById('providerViewCardBtn').className = mode === 'card' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary';
    this.renderProviders();
  }

  _renderProviderCards(container, globalPage, userPage, paginationHtml = '', selectAllBar = '') {
    const renderCardList = (providers) => {
      if (providers.length === 0) return '<p style="text-align:center;color:var(--muted-foreground);padding:12px;font-size:13px;">' + t('暂无') + '</p>';
      return `<div class="admin-card-grid">${providers.map(provider => {
        const pid = provider.id;
        const selected = this.selectedProviders.has(pid);
        const isScriptKey = (provider.key_mode || 'fixed') === 'script';
        const lastError = provider.key_last_error;
        const hasError = isScriptKey && lastError && lastError.trim();
        const safePid = String(pid).replace(/'/g, "\\'");

        const hasTags = Array.isArray(provider.tags) && provider.tags.length > 0;
        return `
          <div class="admin-card has-provider-select provider-drop-target"
               data-provider-id="${escapeHtml(pid)}"
               ondragover="adminApp.handleProviderDragOver(event)"
               ondragleave="adminApp.handleProviderDragLeave(event)"
               ondrop="adminApp.handleProviderDrop(event, '${safePid}')">
            <label class="provider-card-select" title="${t('选择')}" onclick="event.stopPropagation()">
              <input type="checkbox" class="checkbox provider-select-cb" data-provider-id="${escapeHtml(pid)}"
                ${selected ? 'checked' : ''}
                onchange="adminApp.toggleProviderSelection('${safePid}', this.checked)">
            </label>
            <div class="admin-card-header">
              <div style="flex:1;min-width:0;">
                <div class="admin-card-title-row">
                  <div class="admin-card-title">${escapeHtml(provider.name)}</div>
                  <span class="admin-card-badge ${provider.enabled ? 'green' : 'red'}">${provider.enabled ? t('启用') : t('禁用')}</span>
                </div>
                <div class="admin-card-subtitle" title="${escapeHtml(provider.base_url || '')}">${escapeHtml(provider.base_url || '-')}</div>
                <div class="admin-card-header-tags ${hasTags ? 'has-tags' : ''}" title="${t('拖拽标签到卡片可分配')}">
                  ${this._renderProviderTagChips(provider.tags, pid)}
                </div>
              </div>
            </div>
            <div class="admin-card-body">
              <div class="admin-card-row">
                <span class="admin-card-row-label">密钥模式</span>
                <span class="admin-card-row-value">
                  ${isScriptKey
                    ? `${'<span style="color:var(--warning);">' + t('⚡ 脚本')}${hasError ? ` <span style="color:var(--destructive);cursor:pointer;font-size:11px;" title="${escapeHtml(lastError).replace(/"/g, '&quot;')}">⚠️</span>` : ''}</span>`
                    : ((provider.api_key_count || 0) > 1
                      ? `${'<span>' + t('固定 ·')}${provider.api_key_count} Key${provider.api_key_select_mode === 'weight' ? t(' · 权重') : ''}</span>`
                      : '<span style="color:var(--muted-foreground);">' + t('固定') + '</span>')}
                </span>
              </div>
              <div class="admin-card-row">
                <span class="admin-card-row-label">代理</span>
                <span class="admin-card-row-value">${this._formatProviderProxyDisplay(provider)}</span>
              </div>
              <div class="admin-card-row">
                <span class="admin-card-row-label">额度查询</span>
                <span class="admin-card-row-value" id="quota-display-card-${provider.id}">${provider.quota_enabled ? '<span style="color:var(--success);">' + t('已启用') + '</span>' : '<span style="color:var(--muted-foreground);">' + t('未启用') + '</span>'}</span>
              </div>
              <div class="admin-card-row">
                <span class="admin-card-row-label">格式</span>
                <span class="admin-card-row-value">${escapeHtml(formatDisplayName(provider.format))}</span>
              </div>
              <div id="ping-display-card-${provider.id}" class="admin-card-ping" style="margin-top:6px;font-size:12px;color:var(--muted-foreground);">延迟: -</div>
            </div>
            <div class="admin-card-footer">
              ${this._renderProviderRowActions(provider, { isCard: true })}
            </div>
          </div>
        `;
      }).join('')}</div>`;
    };

    setHTML(container, `
      ${selectAllBar || ''}
      ${globalPage.total > 0 ? `
        <div style="margin-bottom:24px;">
          <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">${t('全局供应商')} <span style="font-weight:400;color:var(--muted-foreground);font-size:13px;">(本页 ${globalPage.total})</span></h3>
          ${renderCardList(globalPage.items)}
        </div>
      ` : ''}
      ${userPage.total > 0 ? `
        <div>
          <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">${t('用户供应商')} <span style="font-weight:400;color:var(--muted-foreground);font-size:13px;">(本页 ${userPage.total})</span></h3>
          ${renderCardList(userPage.items)}
        </div>
      ` : ''}
      ${paginationHtml || ''}
    `);
  }

  // ========== 供应商多选 / 批量同步模型 ==========

  toggleProviderSelection(providerId, checked) {
    const id = String(providerId);
    if (!this._selectedProviderNames) this._selectedProviderNames = new Map();
    if (checked) {
      this.selectedProviders.add(id);
      const p = (this.providersData || []).find(x => String(x.id) === id);
      if (p) this._selectedProviderNames.set(id, p.name || id);
    } else {
      this.selectedProviders.delete(id);
      this._selectedProviderNames.delete(id);
    }
    this.updateProviderBatchBar();
    // 同步全选本页复选框
    const pageIds = (this.providersData || []).map(p => String(p.id));
    const allPageSelected = pageIds.length > 0 && pageIds.every(pid => this.selectedProviders.has(pid));
    const selectAll = document.getElementById('providerSelectAllPage');
    if (selectAll) selectAll.checked = allPageSelected;
  }

  toggleSelectAllProvidersOnPage(checked) {
    if (!this._selectedProviderNames) this._selectedProviderNames = new Map();
    const pageIds = (this.providersData || []).map(p => String(p.id));
    for (const p of (this.providersData || [])) {
      const id = String(p.id);
      if (checked) {
        this.selectedProviders.add(id);
        this._selectedProviderNames.set(id, p.name || id);
      } else {
        this.selectedProviders.delete(id);
        this._selectedProviderNames.delete(id);
      }
    }
    document.querySelectorAll('.provider-select-cb').forEach(cb => {
      cb.checked = !!checked;
    });
    this.updateProviderBatchBar();
  }

  clearProviderSelection() {
    this.selectedProviders.clear();
    if (this._selectedProviderNames) this._selectedProviderNames.clear();
    document.querySelectorAll('.provider-select-cb').forEach(cb => { cb.checked = false; });
    const selectAll = document.getElementById('providerSelectAllPage');
    if (selectAll) selectAll.checked = false;
    this.updateProviderBatchBar();
  }

  updateProviderBatchBar() {
    const bar = document.getElementById('providerBatchBar');
    const countEl = document.getElementById('providerSelectedCount');
    const n = this.selectedProviders.size;
    if (countEl) countEl.textContent = `${t('已选')}${n}${t('个')}`;
    if (bar) bar.style.display = n > 0 ? 'inline-flex' : 'none';
  }

  /**
   * 根据上游列表与本地状态，计算批量同步的启用模型 ID 列表
   * @param {{ models: Array, existingById: object, existingModels: Array }} data
   * @param {{ enableNew?: boolean, disableStale?: boolean }} options
   */
  _computeBatchSyncEnabledIds(data, options = {}) {
    const enableNew = options.enableNew !== false;
    const disableStale = options.disableStale === true;
    const models = data.models || [];
    const existingById = data.existingById || {};
    const existingModels = data.existingModels || [];
    const upstreamIds = new Set(models.map(m => m.id));
    const enabled = new Set();

    for (const m of models) {
      const ex = existingById[m.id];
      if (ex?.enabled) {
        enabled.add(m.id);
      } else if (!ex && enableNew) {
        // 上游新模型 → 默认启用
        enabled.add(m.id);
      }
      // 本地已禁用的保持禁用（不加入）
    }

    // 上游已下架但仍启用的：默认保留启用，避免批量误伤
    if (!disableStale) {
      for (const em of existingModels) {
        if (em.enabled && !upstreamIds.has(em.id)) {
          enabled.add(em.id);
        }
      }
    }

    return [...enabled];
  }

  batchSyncPageProviders() {
    const ids = (this.providersData || []).map(p => String(p.id));
    if (!ids.length) {
      this.showToast(t('当前页没有供应商'), 'info');
      return;
    }
    this._startBatchSyncProviders(ids, t('本页'));
  }

  batchSyncSelectedProviders() {
    const ids = [...this.selectedProviders];
    if (!ids.length) {
      // 无选中时退化为同步本页
      this.batchSyncPageProviders();
      return;
    }
    this._startBatchSyncProviders(ids, t('选中'));
  }

  async _startBatchSyncProviders(providerIds, scopeLabel = t('选中')) {
    if (this._providerBatchSyncing) {
      this.showToast(t('已有批量同步任务进行中'), 'info');
      return;
    }
    if (!providerIds.length) return;

    const providersById = new Map((this.providersData || []).map(p => [String(p.id), p]));
    const nameCache = this._selectedProviderNames || new Map();
    // 选中的可能跨页：当前页名 → 选择时缓存名 → id
    const items = providerIds.map(id => ({
      id,
      name: providersById.get(id)?.name || nameCache.get(id) || id
    }));

    const content = `
      <p style="margin:0 0 8px;font-size:13px;color:var(--muted-foreground);">
        将依次从上游拉取模型列表并同步到本地，共 <strong>${items.length}</strong> 个${scopeLabel}供应商。
      </p>
      <div class="batch-sync-options">
        <label>
          <input type="checkbox" id="batchSyncEnableNew" class="checkbox" checked>
          <span>新增上游模型默认<strong>启用</strong></span>
        </label>
        <label>
          <input type="checkbox" id="batchSyncDisableStale" class="checkbox">
          <span>上游已下架的模型自动<strong>禁用</strong>（默认保留）</span>
        </label>
      </div>
      <div id="batchSyncProgressMeta" style="font-size:13px;color:var(--muted-foreground);margin-top:4px;">准备就绪，点击开始</div>
      <div style="margin-top:8px;height:6px;background:var(--muted);border-radius:3px;overflow:hidden;">
        <div id="batchSyncProgressBar" style="height:100%;width:0%;background:var(--brand-blue,#1456f0);transition:width .25s;"></div>
      </div>
      <div class="batch-sync-progress-list" id="batchSyncProgressList">
        ${items.map((it, i) => `
          <div class="batch-sync-row" data-batch-sync-id="${escapeHtml(it.id)}">
            <span style="color:var(--muted-foreground);width:28px;">${i + 1}.</span>
            <span class="batch-sync-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
            <span class="batch-sync-status" data-status>等待</span>
          </div>
        `).join('')}
      </div>
    `;

    const footer = `
      <button type="button" class="dialog-btn dialog-btn-cancel" id="batchSyncCancelBtn">关闭</button>
      <button type="button" class="dialog-btn dialog-btn-primary" id="batchSyncStartBtn">开始同步</button>
    `;

    const modal = Dialog.showModal({
      title: t('批量同步模型'),
      content,
      footer,
      width: 520
    });

    const startBtn = document.getElementById('batchSyncStartBtn');
    const cancelBtn = document.getElementById('batchSyncCancelBtn');
    cancelBtn?.addEventListener('click', () => {
      if (this._providerBatchSyncing) {
        this._providerBatchSyncAbort = true;
        if (cancelBtn) cancelBtn.textContent = t('正在停止…');
      } else {
        modal?.close?.();
      }
    });

    startBtn?.addEventListener('click', async () => {
      if (this._providerBatchSyncing) return;
      const enableNew = !!document.getElementById('batchSyncEnableNew')?.checked;
      const disableStale = !!document.getElementById('batchSyncDisableStale')?.checked;
      // 锁定选项
      ['batchSyncEnableNew', 'batchSyncDisableStale'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
      });
      if (startBtn) {
        startBtn.disabled = true;
        setHTML(startBtn, inlineLoadingHtml(t('同步中...'), 'sm'));
      }
      await this._runBatchSyncProviders(items, { enableNew, disableStale });
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = t('再次同步');
      }
      if (cancelBtn) cancelBtn.textContent = t('关闭');
    });
  }

  async _runBatchSyncProviders(items, options = {}) {
    this._providerBatchSyncing = true;
    this._providerBatchSyncAbort = false;
    const meta = document.getElementById('batchSyncProgressMeta');
    const bar = document.getElementById('batchSyncProgressBar');
    let ok = 0;
    let fail = 0;
    let totalAdded = 0;
    let totalEnabled = 0;
    let totalDisabled = 0;

    const setRow = (id, text, cls) => {
      const row = document.querySelector(`.batch-sync-row[data-batch-sync-id="${CSS.escape(id)}"] [data-status]`);
      if (!row) return;
      row.textContent = text;
      row.className = `batch-sync-status ${cls || ''}`;
    };

    for (let i = 0; i < items.length; i++) {
      if (this._providerBatchSyncAbort) {
        if (meta) meta.textContent = `${t('已停止 · 成功')}${ok}${t('· 失败')}${fail}${t('· 剩余未处理')}${items.length - i}`;
        break;
      }
      const it = items[i];
      setRow(it.id, t('同步中…'), 'run');
      if (meta) meta.textContent = `${t('正在同步')}${i + 1}/${items.length}：${it.name}`;
      if (bar) bar.style.width = `${Math.round((i / items.length) * 100)}%`;

      try {
        const result = await this._syncOneProviderModels(it.id, options);
        totalAdded += result.added || 0;
        totalEnabled += result.enabled || 0;
        totalDisabled += result.disabled || 0;
        const parts = [];
        if (result.added) parts.push(`+${result.added}`);
        if (result.enabled) parts.push(`${t('启')}${result.enabled}`);
        if (result.disabled) parts.push(`${t('禁')}${result.disabled}`);
        if (result.upstreamCount != null) parts.push(`${t('上游')}${result.upstreamCount}`);
        setRow(it.id, parts.length ? parts.join(' · ') : t('无变化'), 'ok');
        ok++;
      } catch (e) {
        console.error(t('[批量同步] 失败'), it.id, e);
        setRow(it.id, e.message || t('失败'), 'fail');
        fail++;
      }

      if (bar) bar.style.width = `${Math.round(((i + 1) / items.length) * 100)}%`;
    }

    this._providerBatchSyncing = false;
    const summary = `${t('完成 · 成功')}${ok}${t('· 失败')}${fail}${t('· 新增')}${totalAdded}${t('· 启用')}${totalEnabled}${t('· 禁用')}${totalDisabled}`;
    if (meta) meta.textContent = summary;
    this.showToast(summary, fail ? 'info' : 'success');
    // 刷新模型列表缓存（若已打开过）
    if (typeof this.loadModels === 'function' && ok > 0) {
      this.loadModels({ resetPage: false }).catch(() => {});
    }
  }

  /**
   * 单个供应商：拉取上游模型并 sync-models
   */
  async _syncOneProviderModels(providerId, options = {}) {
    const fetchRes = await fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/fetch-models`);
    const fetchData = await fetchRes.json().catch(() => ({}));
    if (!fetchRes.ok) {
      throw new Error(fetchData.error || `${t('获取模型失败 (')}${fetchRes.status})`);
    }
    const models = fetchData.models || [];
    if (!models.length) {
      // 上游无模型：若勾选下架禁用，则把全部现有启用模型禁用
      if (options.disableStale) {
        const syncRes = await fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/sync-models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabledModelIds: [] })
        });
        const syncData = await syncRes.json().catch(() => ({}));
        if (!syncRes.ok) throw new Error(syncData.error || t('同步失败'));
        return { ...syncData, upstreamCount: 0 };
      }
      return { added: 0, enabled: 0, disabled: 0, upstreamCount: 0 };
    }

    const enabledModelIds = this._computeBatchSyncEnabledIds(fetchData, options);
    const syncRes = await fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/sync-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledModelIds })
    });
    const syncData = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok) throw new Error(syncData.error || `${t('同步失败 (')}${syncRes.status})`);
    return { ...syncData, upstreamCount: models.length };
  }

  setModelView(mode) {
    // 已统一为模型库风格，保留方法避免旧调用报错
    this.modelViewMode = mode || 'library';
    this.renderModels();
  }

  async pingProvider(providerId) {
    const display = document.getElementById(`ping-display-${providerId}`);
    const cardDisplay = document.getElementById(`ping-display-card-${providerId}`);
    const btn = document.getElementById(`ping-btn-${providerId}`);
    const cardBtn = document.getElementById(`ping-btn-card-${providerId}`);
    const pingHtml = inlineLoadingHtml(t('检测中...'), 'sm');
    if (display) setHTML(display, pingHtml);
    if (cardDisplay) setHTML(cardDisplay, pingHtml);
    if (btn) btn.disabled = true;
    if (cardBtn) cardBtn.disabled = true;

    try {
      const resp = await fetch(`/api/admin/providers/${providerId}/ping`);
      const data = await resp.json();
      const resultHtml = data.ok
        ? `<span style="color:${data.latency_ms <= 300 ? 'var(--success)' : data.latency_ms <= 1000 ? 'var(--warning)' : 'var(--destructive)'};font-weight:500;">${data.latency_ms}ms</span>`
        : `<span style="color:var(--destructive);" title="${escapeHtml(data.error || '')}">${t('失败')}</span>`;
      if (display) setHTML(display, resultHtml);
      if (cardDisplay) setHTML(cardDisplay, resultHtml);
    } catch (e) {
      const errHtml = '<span style="color:var(--destructive);">' + t('错误') + '</span>';
      if (display) setHTML(display, errHtml);
      if (cardDisplay) setHTML(cardDisplay, errHtml);
    } finally {
      if (btn) btn.disabled = false;
      if (cardBtn) cardBtn.disabled = false;
    }
  }

  async pingAllProviders() {
    const btn = document.getElementById('pingAllProvidersBtn');
    if (btn) {
      btn.disabled = true;
      setHTML(btn, inlineLoadingHtml(t('检测中...'), 'sm'));
    }

    // 收集所有供应商 ID（兼容表格和卡片视图）
    const pingBtns = document.querySelectorAll('#adminProvidersList [id^="ping-btn-"]');
    const providerIds = [...new Set(Array.from(pingBtns).map(btn => {
      // ping-btn-{id} 或 ping-btn-card-{id}
      return btn.id.replace('ping-btn-card-', '').replace('ping-btn-', '');
    }))];

    // 并发检测所有供应商
    await Promise.allSettled(providerIds.map(id => this.pingProvider(id)));

    if (btn) {
      btn.disabled = false;
      setHTML(btn, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 检测本页连通性');
    }
  }

  async showAddProviderWizard() {
    const self = this;
    // Step 1: 显示供应商选择列表
    const modal = Dialog.showModal({
      title: t('添加供应商'),
      content: `
        <p style="color:var(--muted-foreground);font-size:13px;margin:0 0 8px;">从常用列表选择，或自定义添加。完成后可立即同步模型。</p>
        <input type="text" class="wizard-search" id="wizardSearch" placeholder="${t('搜索供应商名称或 Base URL...')}">
        <div class="wizard-provider-list" id="wizardProviderList">
          <div class="wizard-empty"><div class="page-loading page-loading-compact" style="min-height:100px;padding:20px 12px;"><div class="loading-spinner md" role="status" aria-label="${t('加载中')}"></div><div class="page-loading-text">正在加载供应商列表...</div></div></div>
        </div>
      `,
      width: 480
    });

    const searchInput = document.getElementById('wizardSearch');
    const listContainer = document.getElementById('wizardProviderList');

    let allProviders = [];
    let loadError = null;
    // 按名称 / Base URL 判断是否已添加（DB 多为 UUID，无法与 models.dev id 直接比对）
    const existingNames = new Set((self.providersData || []).map(p => (p.name || '').trim().toLowerCase()).filter(Boolean));
    const existingUrls = new Set((self.providersData || []).map(p => (p.base_url || '').replace(/\/+$/, '').toLowerCase()).filter(Boolean));

    function isAlreadyAdded(p) {
      const name = (p.name || '').trim().toLowerCase();
      const url = (p.base_url || '').replace(/\/+$/, '').toLowerCase();
      return (name && existingNames.has(name)) || (url && existingUrls.has(url));
    }

    async function loadIndex() {
      loadError = null;
      setHTML(listContainer, '<div class="wizard-empty">' + pageLoadingHtml(t('正在加载供应商列表...'), { size: 'md', compact: true }) + '</div>');
      try {
        const resp = await fetch('/api/admin/providers/lookup-index');
        if (resp.ok) {
          const data = await resp.json();
          allProviders = data.providers || [];
        } else {
          loadError = t('加载失败');
        }
      } catch (e) {
        console.error(t('加载供应商索引失败:'), e);
        loadError = e.message || t('网络错误');
      }
      renderList(searchInput?.value?.trim() || '');
    }

    function renderList(filter = '') {
      if (loadError) {
        setHTML(listContainer, `
          <div class="wizard-empty">
            <p style="color:var(--destructive);margin-bottom:8px;">${escapeHtml(loadError)}</p>
            <button type="button" class="btn btn-sm btn-secondary" id="wizardRetryBtn">重试</button>
          </div>`);
        document.getElementById('wizardRetryBtn')?.addEventListener('click', () => loadIndex());
        return;
      }

      const kw = filter.toLowerCase();
      const filtered = kw
        ? allProviders.filter(p =>
            (p.id || '').toLowerCase().includes(kw) ||
            (p.name || '').toLowerCase().includes(kw) ||
            (p.base_url || '').toLowerCase().includes(kw))
        : allProviders;

      let html = `
        <div class="wizard-provider-item not-in-list" data-action="manual">
          <div class="wizard-provider-icon">+</div>
          <div class="wizard-provider-info">
            <div class="wizard-provider-name">自定义添加（列表中没有）</div>
            <div class="wizard-provider-id">手动填写名称、Base URL 和密钥</div>
          </div>
        </div>
      `;

      if (filtered.length === 0 && kw) {
        html += '<div class="wizard-empty">' + t('未找到匹配的供应商') + '</div>';
      } else {
        for (const p of filtered) {
          const initial = (p.name || '?').charAt(0).toUpperCase();
          const already = isAlreadyAdded(p);
          html += `
            <div class="wizard-provider-item" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" data-url="${escapeHtml(p.base_url || '')}" data-format="${escapeHtml(p.format || 'openai')}">
              <div class="wizard-provider-icon">${escapeHtml(initial)}</div>
              <div class="wizard-provider-info">
                <div class="wizard-provider-name">${escapeHtml(p.name)}</div>
                <div class="wizard-provider-id">${escapeHtml(p.base_url || '')}</div>
              </div>
              ${already ? '<span class="wizard-provider-badge">' + t('已添加') + '</span>' : ''}
            </div>
          `;
        }
      }
      setHTML(listContainer, html);

      listContainer.querySelectorAll('.wizard-provider-item').forEach(item => {
        item.addEventListener('click', () => {
          const action = item.dataset.action;
          if (action === 'manual') {
            modal.close();
            self.showAddProviderModal();
            return;
          }
          const provider = {
            id: item.dataset.id,
            name: item.dataset.name,
            base_url: item.dataset.url,
            format: item.dataset.format
          };
          modal.close();
          self.showWizardStep2(provider);
        });
      });
    }

    await loadIndex();

    searchInput.addEventListener('input', () => {
      renderList(searchInput.value.trim());
    });
    setTimeout(() => searchInput.focus(), 100);
  }

  showWizardStep2(provider) {
    const self = this;
    const modal = Dialog.showModal({
      title: `${t('配置')}${provider.name}`,
      content: `
        <p style="color:var(--muted-foreground);font-size:13px;margin-bottom:12px;">
          供应商: <strong>${escapeHtml(provider.name)}</strong><br>
          API 地址: ${escapeHtml(provider.base_url || '')}
        </p>
        <label style="font-size:13px;font-weight:500;display:block;margin-bottom:6px;">API Key <span style="font-weight:400;color:var(--muted-foreground);">（可稍后填写）</span></label>
        <input type="password" class="wizard-apikey-input" id="wizardApiKey" placeholder="${t('输入 API Key，可留空稍后编辑补全')}">
      `,
      footer: `
        <button class="wizard-back-btn" id="wizardBackBtn">← 返回</button>
        <div style="flex:1"></div>
        <button class="dialog-btn dialog-btn-primary" id="wizardSaveBtn">添加</button>
      `,
      width: 420
    });

    const apiKeyInput = document.getElementById('wizardApiKey');
    setTimeout(() => apiKeyInput.focus(), 100);

    document.getElementById('wizardBackBtn').addEventListener('click', () => {
      modal.close();
      self.showAddProviderWizard();
    });

    document.getElementById('wizardSaveBtn').addEventListener('click', async () => {
      const saveBtn = document.getElementById('wizardSaveBtn');
      setButtonLoading(saveBtn, t('添加中...'));

      try {
        const body = {
          name: provider.name,
          base_url: provider.base_url,
          format: provider.format,
          enabled: true
        };
        const apiKey = apiKeyInput.value.trim();
        if (apiKey) body.api_key = apiKey;

        const resp = await fetch('/api/admin/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (resp.ok) {
          const data = await resp.json().catch(() => ({}));
          const newId = data.id || data.provider?.id;
          modal.close();
          if (!apiKey) {
            self.showToast(t('已添加（未填 API Key，可稍后在编辑中补全）'), 'info');
          }
          await self.loadProviders();
          self.showProviderAddedSuccess(newId, provider.name);
        } else {
          const err = await resp.json().catch(() => ({}));
          clearButtonLoading(saveBtn, t('添加'));
          self.showToast(err.error || t('添加失败'), 'error');
        }
      } catch (e) {
        clearButtonLoading(saveBtn, t('添加'));
        self.showToast(t('添加失败: ') + e.message, 'error');
      }
    });

    apiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('wizardSaveBtn').click();
      }
    });
  }

  showProviderAddedSuccess(providerId, providerName) {
    const self = this;
    const name = providerName || t('供应商');
    const modal = Dialog.showModal({
      title: t('供应商已添加'),
      content: `
        <p style="font-size:14px;margin:0 0 8px;"><strong>${escapeHtml(name)}</strong> 已创建成功。</p>
        <p style="color:var(--muted-foreground);font-size:13px;margin:0;">建议下一步同步模型列表，导入后即可在模型管理中启用。</p>
      `,
      footer: `
        <button class="dialog-btn dialog-btn-cancel" id="providerSuccessLater">稍后再说</button>
        <button class="dialog-btn dialog-btn-cancel" id="providerSuccessPing" ${providerId ? '' : 'disabled'}>检测连通性</button>
        <button class="dialog-btn dialog-btn-primary" id="providerSuccessSync" ${providerId ? '' : 'disabled'}>同步模型</button>
      `,
      width: 440
    });

    document.getElementById('providerSuccessLater')?.addEventListener('click', () => modal.close());
    document.getElementById('providerSuccessPing')?.addEventListener('click', () => {
      modal.close();
      if (providerId) self.pingProvider(providerId);
    });
    document.getElementById('providerSuccessSync')?.addEventListener('click', () => {
      modal.close();
      if (providerId) self.fetchProviderModels(providerId);
    });
  }

  _setProviderFormSectionsOpen({ keyMode = false, modelsQuota = false, proxy = false, headers = false, tags = false, test = false } = {}) {
    const map = {
      providerSectionKeyMode: keyMode,
      providerSectionModelsQuota: modelsQuota,
      providerSectionProxy: proxy,
      providerSectionHeaders: headers,
      providerSectionTags: tags,
      providerSectionTest: test
    };
    Object.entries(map).forEach(([id, open]) => {
      const el = document.getElementById(id);
      if (el) el.open = !!open;
    });
    const doc = document.getElementById('keyScriptDocDetails');
    if (doc) doc.open = false;
  }

  showAddProviderModal() {
    document.getElementById('providerModalTitle').textContent = t('添加供应商');
    document.getElementById('providerId').value = '';
    document.getElementById('providerName').value = '';
    document.getElementById('providerBaseUrl').value = '';
    document.getElementById('providerApiKey').value = '';
    document.getElementById('providerModelsUrl').value = '';
    document.getElementById('providerFormat').value = 'openai';
    document.getElementById('providerEnabled').value = 'true';
    const quotaEl = document.getElementById('providerQuotaEnabled');
    if (quotaEl) quotaEl.value = 'false';
    const quotaModeEl = document.getElementById('providerQuotaMode');
    if (quotaModeEl) quotaModeEl.value = 'script';
    const scheduleEl = document.getElementById('providerQuotaScheduleEnabled');
    if (scheduleEl) scheduleEl.value = 'false';
    const scheduleIntervalEl = document.getElementById('providerQuotaScheduleInterval');
    if (scheduleIntervalEl) scheduleIntervalEl.value = '3600';
    this._setProviderQuotaScheduleMeta(null);
    this.toggleQuotaScheduleFields();
    this.toggleArkQuotaConfig();
    const arkAccessEl = document.getElementById('providerArkAccessKey');
    if (arkAccessEl) arkAccessEl.value = '';
    const arkSecretEl = document.getElementById('providerArkSecretKey');
    if (arkSecretEl) arkSecretEl.value = '';
    const arkRegionEl = document.getElementById('providerArkRegion');
    if (arkRegionEl) arkRegionEl.value = 'cn-north-1';
    const arkServiceEl = document.getElementById('providerArkService');
    if (arkServiceEl) arkServiceEl.value = 'ark';
    const arkActionEl = document.getElementById('providerArkAction');
    if (arkActionEl) arkActionEl.value = 'GetInferenceUsage';
    const arkParamsEl = document.getElementById('providerArkParams');
    if (arkParamsEl) arkParamsEl.value = '{}';
    const codexConfigText = document.getElementById('providerCodexConfigText');
    if (codexConfigText) codexConfigText.value = '';
    const codexConfigFile = document.getElementById('providerCodexConfigFile');
    if (codexConfigFile) codexConfigFile.value = '';
    const codexImportSection = document.getElementById('codexQuotaImportSection');
    if (codexImportSection) codexImportSection.style.display = 'none';
    const notesEl = document.getElementById('providerNotes');
    if (notesEl) notesEl.value = '';
    const keyModeEl = document.getElementById('providerKeyMode');
    if (keyModeEl) keyModeEl.value = 'fixed';
    const keyScriptEl = document.getElementById('providerKeyScript');
    if (keyScriptEl) keyScriptEl.value = '';
    const keyIntervalEl = document.getElementById('providerKeyRefreshInterval');
    if (keyIntervalEl) keyIntervalEl.value = '3600';
    this._setProviderKeySelectMode('order');
    this.renderProviderApiKeysEditor([{ key: '', weight: 1 }]);
    this.toggleKeyMode();

    this._setProviderProxyForm({
      proxy_enabled: false,
      proxy_mode: 'single',
      proxy_url: '',
      proxy_use_system: false
    });

    const ctModeEl = document.getElementById('providerContentTypeMode');
    if (ctModeEl) ctModeEl.value = 'hardcoded';
    const fwdHeadersEl = document.getElementById('providerForwardHeaders');
    if (fwdHeadersEl) fwdHeadersEl.value = 'true';
    const testUaEl = document.getElementById('providerTestUserAgent');
    if (testUaEl) testUaEl.value = '';

    // 新建时初始化标签分配，避免脏状态
    this.renderProviderTagAssignment([]);
    this._setProviderFormSectionsOpen({});

    document.getElementById('addProviderModal').style.display = 'flex';
    document.getElementById('addProviderModal').classList.add('active');
  }

  async lookupProviderInfo() {
    const providerName = document.getElementById('providerName').value.trim();
    if (!providerName) {
      this.showToast(t('请先输入供应商名称，再点击查询'), 'error');
      return;
    }

    try {
      const response = await fetch(`/api/admin/providers/lookup/${encodeURIComponent(providerName)}`);
      if (response.ok) {
        const info = await response.json();
        document.getElementById('providerName').value = info.name || providerName;
        if (info.base_url) document.getElementById('providerBaseUrl').value = info.base_url;
        document.getElementById('providerFormat').value = info.format || 'openai';
        this.showToast(t('已填充供应商信息'), 'success');
      } else {
        this.showToast(t('未在 models.dev 中找到该供应商，可手动填写'), 'info');
      }
    } catch (error) {
      console.error(t('查询供应商信息失败:'), error);
      this.showToast(t('查询失败'), 'error');
    }
  }

  editProvider(provider) {
    document.getElementById('providerModalTitle').textContent = t('编辑供应商');
    document.getElementById('providerId').value = provider.id;
    document.getElementById('providerName').value = provider.name;
    document.getElementById('providerBaseUrl').value = provider.base_url;
    document.getElementById('providerApiKey').value = '';
    document.getElementById('providerModelsUrl').value = provider.models_url || '';
    document.getElementById('providerFormat').value = provider.format;
    document.getElementById('providerEnabled').value = provider.enabled.toString();
    const quotaEl = document.getElementById('providerQuotaEnabled');
    if (quotaEl) quotaEl.value = (provider.quota_enabled || false).toString();
    const quotaModeEl = document.getElementById('providerQuotaMode');
    if (quotaModeEl) quotaModeEl.value = provider.quota_mode || 'script';
    const scheduleEl = document.getElementById('providerQuotaScheduleEnabled');
    if (scheduleEl) scheduleEl.value = (provider.quota_schedule_enabled || false).toString();
    const scheduleIntervalEl = document.getElementById('providerQuotaScheduleInterval');
    if (scheduleIntervalEl) scheduleIntervalEl.value = String(provider.quota_schedule_interval || 3600);
    this._setProviderQuotaScheduleMeta(provider);
    this.toggleQuotaScheduleFields();
    const arkAccessEl = document.getElementById('providerArkAccessKey');
    if (arkAccessEl) arkAccessEl.value = provider.ark_access_key || '';
    const arkSecretEl = document.getElementById('providerArkSecretKey');
    if (arkSecretEl) arkSecretEl.value = '';
    const arkRegionEl = document.getElementById('providerArkRegion');
    if (arkRegionEl) arkRegionEl.value = provider.ark_region || 'cn-north-1';
    const arkServiceEl = document.getElementById('providerArkService');
    if (arkServiceEl) arkServiceEl.value = provider.ark_service || 'ark';
    const arkActionEl = document.getElementById('providerArkAction');
    if (arkActionEl) arkActionEl.value = provider.ark_usage_action || (provider.quota_mode === 'ark_afp' ? 'GetAFPUsage' : 'GetInferenceUsage');
    const arkParamsEl = document.getElementById('providerArkParams');
    if (arkParamsEl) arkParamsEl.value = typeof provider.ark_usage_params === 'string' ? provider.ark_usage_params : JSON.stringify(provider.ark_usage_params || {}, null, 2);
    this.toggleArkQuotaConfig();
    this.toggleCodexQuotaImport();
    const notesEl = document.getElementById('providerNotes');
    if (notesEl) notesEl.value = provider.notes || '';

    const keyModeEl = document.getElementById('providerKeyMode');
    if (keyModeEl) keyModeEl.value = provider.key_mode || 'fixed';
    const keyScriptEl = document.getElementById('providerKeyScript');
    if (keyScriptEl) keyScriptEl.value = provider.key_script || '';
    const keyIntervalEl = document.getElementById('providerKeyRefreshInterval');
    if (keyIntervalEl) keyIntervalEl.value = provider.key_refresh_interval || 3600;

    // 多 Key：详情接口返回完整列表；列表回退时只有 has_api_key
    this._setProviderKeySelectMode(provider.api_key_select_mode || 'order');
    let keyEntries = Array.isArray(provider.api_keys) ? provider.api_keys : null;
    if (!keyEntries || keyEntries.length === 0) {
      if (provider.api_key) {
        keyEntries = [{ key: provider.api_key, weight: 1 }];
      } else if (provider.has_api_key) {
        // 无明文时放空占位，保存时若不填则后端保留原值
        keyEntries = [{ key: '', weight: 1 }];
      } else {
        keyEntries = [{ key: '', weight: 1 }];
      }
    }
    this.renderProviderApiKeysEditor(keyEntries);
    this.toggleKeyMode();

    this._setProviderProxyForm(provider);

    const ctModeEl = document.getElementById('providerContentTypeMode');
    if (ctModeEl) ctModeEl.value = provider.content_type_mode || 'hardcoded';
    const fwdHeadersEl = document.getElementById('providerForwardHeaders');
    if (fwdHeadersEl) fwdHeadersEl.value = (provider.forward_headers !== false).toString();
    const testUaEl = document.getElementById('providerTestUserAgent');
    if (testUaEl) testUaEl.value = provider.test_user_agent || '';

    this.renderProviderTagAssignment(provider.tags || []);
    this._setProviderFormSectionsOpen({});

    document.getElementById('addProviderModal').style.display = 'flex';
    document.getElementById('addProviderModal').classList.add('active');
  }

  async saveProvider() {
    const idField = document.getElementById('providerId');
    const id = idField.value.trim();
    const name = document.getElementById('providerName').value;
    const base_url = document.getElementById('providerBaseUrl').value;
    const models_url = document.getElementById('providerModelsUrl').value;
    const format = document.getElementById('providerFormat').value;
    const enabled = document.getElementById('providerEnabled').value === 'true';
    const quota_enabled = document.getElementById('providerQuotaEnabled')?.value === 'true';
    const quota_mode = document.getElementById('providerQuotaMode')?.value || 'script';
    const quota_schedule_enabled = document.getElementById('providerQuotaScheduleEnabled')?.value === 'true';
    const quota_schedule_interval = parseInt(document.getElementById('providerQuotaScheduleInterval')?.value, 10) || 3600;
    const notes = document.getElementById('providerNotes')?.value || '';
    const key_mode = document.getElementById('providerKeyMode')?.value || 'fixed';
    const key_script = document.getElementById('providerKeyScript')?.value || '';
    const key_refresh_interval = parseInt(document.getElementById('providerKeyRefreshInterval')?.value) || 3600;
    const proxyFields = this._collectProviderProxyFromForm();
    const content_type_mode = document.getElementById('providerContentTypeMode')?.value || 'hardcoded';
    const forward_headers = document.getElementById('providerForwardHeaders')?.value !== 'false';
    const test_user_agent = document.getElementById('providerTestUserAgent')?.value || '';
    const api_key_select_mode = this._getProviderKeySelectMode();
    const collectedKeys = this._collectProviderApiKeysFromForm();
    const isCreate = !id;

    if (!name || !base_url) {
      this.showToast(t('请填写供应商名称和 API 地址'), 'error');
      return;
    }

    if (key_mode === 'script' && !key_script.trim()) {
      this.showToast(t('脚本模式下必须填写密钥刷新脚本'), 'error');
      this._setProviderFormSectionsOpen({ keyMode: true });
      return;
    }

    if (proxyFields.proxy_enabled && proxyFields.proxy_mode === 'single'
        && !proxyFields.proxy_use_system && !proxyFields.proxy_url) {
      this.showToast(t('代理模式下请填写自定义代理地址，或勾选使用系统代理'), 'error');
      this._setProviderFormSectionsOpen({ proxy: true });
      return;
    }

    try {
      const body = {
        name, base_url, format, enabled, quota_enabled, quota_mode, notes, key_mode, key_script,
        key_refresh_interval, content_type_mode, forward_headers, test_user_agent,
        quota_schedule_enabled, quota_schedule_interval,
        api_key_select_mode,
        ark_access_key: document.getElementById('providerArkAccessKey')?.value.trim() || '',
        ark_secret_key: document.getElementById('providerArkSecretKey')?.value || '',
        ark_region: document.getElementById('providerArkRegion')?.value.trim() || 'cn-north-1',
        ark_service: document.getElementById('providerArkService')?.value.trim() || 'ark',
        ark_usage_action: document.getElementById('providerArkAction')?.value.trim() || (quota_mode === 'ark_afp' ? 'GetAFPUsage' : 'GetInferenceUsage'),
        ark_usage_params: document.getElementById('providerArkParams')?.value.trim() || '{}',
        ...proxyFields
      };
      if (id) body.id = id;
      body.models_url = models_url || '';

      if (collectedKeys.length > 0) {
        body.api_keys = collectedKeys;
        body.api_key = collectedKeys[0].key;
      }
      // 编辑时若全部 Key 留空：不传 api_keys，后端保留原密钥

      const response = await fetch('/api/admin/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const providerId = id || data.id;
        if (providerId) {
          const tagIds = this._getSelectedProviderTagIds();
          try { await fetch(`/api/admin/providers/${providerId}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tagIds }) }); } catch (_) {}
        }
        const cached = (this._providerOptionsCache || []).find(p => String(p.id) === String(providerId));
        if (cached) cached.test_user_agent = test_user_agent;
        this.closeModals();
        await this.loadProviders();
        if (isCreate) {
          this.showProviderAddedSuccess(providerId, name);
        } else {
          this.showToast(t('供应商已保存'), 'success');
        }
      } else {
        const err = await response.json().catch(() => ({}));
        this.showToast(err.error || t('保存失败'), 'error');
      }
    } catch (error) {
      console.error(t('保存供应商失败:'), error);
      this.showToast(t('保存失败'), 'error');
    }
  }

  // 切换密钥模式显示/隐藏
  toggleKeyMode() {
    const mode = document.getElementById('providerKeyMode')?.value || 'fixed';
    const section = document.getElementById('keyScriptSection');
    if (section) {
      section.style.display = mode === 'script' ? 'block' : 'none';
    }
    this._syncProviderFixedKeysVisibility();
  }

  // 供应商代理表单：填充
  _setProviderProxyForm(provider = {}) {
    const enabled = !!(provider.proxy_enabled);
    // 历史数据仅有 proxy_enabled 时默认 pool；新建默认 single
    const mode = (provider.proxy_mode || (provider.proxy_enabled ? 'pool' : 'single')).toLowerCase() === 'pool'
      ? 'pool' : 'single';
    const useSystem = !!(provider.proxy_use_system);
    const url = provider.proxy_url || '';

    const proxyEnabledEl = document.getElementById('providerProxyEnabled');
    if (proxyEnabledEl) proxyEnabledEl.checked = enabled;

    document.querySelectorAll('input[name="providerProxyMode"]').forEach(r => {
      r.checked = r.value === mode;
    });

    const useSystemEl = document.getElementById('providerProxyUseSystem');
    if (useSystemEl) useSystemEl.checked = useSystem;

    const urlEl = document.getElementById('providerProxyUrl');
    if (urlEl) urlEl.value = url;

    this.toggleProviderProxyOptions();
  }

  // 供应商代理表单：收集
  _collectProviderProxyFromForm() {
    const proxy_enabled = document.getElementById('providerProxyEnabled')?.checked || false;
    const modeRadio = document.querySelector('input[name="providerProxyMode"]:checked');
    const proxy_mode = modeRadio?.value === 'pool' ? 'pool' : 'single';
    const proxy_use_system = document.getElementById('providerProxyUseSystem')?.checked || false;
    const proxy_url = document.getElementById('providerProxyUrl')?.value?.trim() || '';
    return { proxy_enabled, proxy_mode, proxy_use_system, proxy_url };
  }

  toggleProviderProxyOptions() {
    const enabled = document.getElementById('providerProxyEnabled')?.checked || false;
    const opts = document.getElementById('providerProxyOptions');
    if (opts) opts.style.display = enabled ? 'block' : 'none';
    if (enabled) this.toggleProviderProxyMode();
  }

  toggleProviderProxyMode() {
    const modeRadio = document.querySelector('input[name="providerProxyMode"]:checked');
    const mode = modeRadio?.value === 'pool' ? 'pool' : 'single';
    const single = document.getElementById('providerProxySingleOptions');
    const poolHint = document.getElementById('providerProxyPoolHint');
    if (single) single.style.display = mode === 'single' ? 'block' : 'none';
    if (poolHint) poolHint.style.display = mode === 'pool' ? 'block' : 'none';
    if (mode === 'single') this.toggleProviderProxyUseSystem();
  }

  toggleProviderProxyUseSystem() {
    const useSystem = document.getElementById('providerProxyUseSystem')?.checked || false;
    const urlGroup = document.getElementById('providerProxyUrlGroup');
    if (urlGroup) urlGroup.style.display = useSystem ? 'none' : 'block';
  }

  // 列表/卡片：代理状态展示
  _formatProviderProxyDisplay(provider) {
    if (!provider.proxy_enabled) {
      return '<span style="color:var(--muted-foreground);font-size:12px;">' + t('关闭') + '</span>';
    }
    const mode = (provider.proxy_mode || 'pool').toLowerCase();
    if (mode === 'single') {
      if (provider.proxy_use_system) {
        return '<span style="font-size:12px;color:var(--purple);" title="' + t('使用系统设置中的代理') + '">' + t('🌐 系统代理') + '</span>';
      }
      const url = (provider.proxy_url || '').trim();
      if (!url) {
        return '<span style="color:var(--muted-foreground);font-size:12px;">' + t('未配置') + '</span>';
      }
      const short = url.length > 28 ? url.slice(0, 25) + '…' : url;
      return `<span style="font-size:12px;" title="${escapeHtml(url)}">🔗 ${escapeHtml(short)}</span>`;
    }
    // 代理池
    const proxyPool = this.parseProxyPool(provider.proxy_pool);
    const hasSubscription = !!(provider.proxy_subscription_url || '').trim();
    if (proxyPool.length === 0 && !hasSubscription) {
      return '<span style="font-size:12px;color:var(--info);" title="' + t('使用系统全局代理池') + '">' + t('🔄 全局池') + '</span>';
    }
    const tags = [];
    if (proxyPool.length > 0) {
      const healthyCount = proxyPool.filter(p => p.healthy !== false).length;
      tags.push(`${'<span title="' + t('手动添加的代理') + '">' + t('🔄')}${healthyCount}/${proxyPool.length}</span>`);
    }
    if (hasSubscription) {
      tags.push(`<span style="color:var(--info);" title="${escapeHtml(provider.proxy_subscription_url)}">${t('📡 订阅')}</span>`);
    }
    return `<span style="font-size:12px;">${tags.join(' ')}</span>`;
  }

  // 解析代理池 JSON
  parseProxyPool(proxyPool) {
    try {
      if (Array.isArray(proxyPool)) return proxyPool;
      if (typeof proxyPool === 'string') return JSON.parse(proxyPool);
      return [];
    } catch {
      return [];
    }
  }

  // ========== 系统代理 / 全局代理池管理 ==========

  async saveSystemProxy(e) {
    e.preventDefault();
    const applyAll = document.getElementById('systemProxyEnabled')?.checked || false;
    const url = document.getElementById('systemProxyUrl')?.value?.trim() || '';
    if (applyAll && !url) {
      alert(t('开启「为所有连接使用代理」时请填写代理地址'));
      return;
    }
    if (url && !/^(https?|socks4|socks5h?):\/\//i.test(url)) {
      alert(t('代理地址需以 http://、https://、socks4://、socks5:// 或 socks5h:// 开头'));
      return;
    }
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 语义：为所有连接使用代理（非「是否允许使用系统代理地址」）
          system_proxy_enabled: applyAll,
          system_proxy_url: url
        })
      });
      if (res.ok) {
        alert(t('代理设置已保存'));
      } else {
        alert(t('保存失败'));
      }
    } catch (err) {
      console.error(t('保存系统代理失败:'), err);
      alert(t('保存失败'));
    }
  }

  // 加载全局代理池设置
  async loadGlobalProxyPool() {
    try {
      const res = await fetch('/api/admin/settings');
      if (!res.ok) return;
      const settings = await res.json();

      const subUrl = settings['proxy_pool_subscription_url'] || '';
      const manualProxies = settings['proxy_pool_manual_proxies'] || [];

      document.getElementById('globalProxySubUrl').value = subUrl;
      this._globalProxyPool = manualProxies;
      this.renderGlobalProxyPoolList();
      this.checkGlobalProxyPoolStatus();

      // 系统单代理
      const sysEnabledEl = document.getElementById('systemProxyEnabled');
      if (sysEnabledEl) sysEnabledEl.checked = !!settings['system_proxy_enabled'];
      const sysUrlEl = document.getElementById('systemProxyUrl');
      if (sysUrlEl) sysUrlEl.value = settings['system_proxy_url'] || '';
    } catch (e) {
      console.error(t('加载全局代理池设置失败:'), e);
    }
  }

  // 保存全局代理池设置
  async saveGlobalProxyPool(e) {
    e.preventDefault();
    const subUrl = document.getElementById('globalProxySubUrl')?.value?.trim() || '';
    const manualProxies = this._globalProxyPool || [];

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'proxy_pool_subscription_url': subUrl,
          'proxy_pool_manual_proxies': manualProxies
        })
      });
      if (res.ok) {
        alert(t('代理池设置已保存'));
        this.checkGlobalProxyPoolStatus();
      } else {
        alert(t('保存失败'));
      }
    } catch (e) {
      console.error(t('保存全局代理池设置失败:'), e);
      alert(t('保存失败'));
    }
  }

  // 渲染全局手动代理列表
  renderGlobalProxyPoolList() {
    const container = document.getElementById('globalProxyPoolList');
    if (!container) return;

    const proxies = this._globalProxyPool || [];
    if (proxies.length === 0) {
      setHTML(container, '<div style="color:var(--muted-foreground);font-size:13px;padding:8px 0;">' + t('暂无手动代理') + '</div>');
      return;
    }

    const VISIBLE_LIMIT = 200;
    const visible = proxies.slice(0, VISIBLE_LIMIT);
    const hiddenCount = proxies.length - visible.length;

    const fragment = document.createDocumentFragment();
    for (const p of visible) {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--card);border:1px solid var(--border);border-radius:6px;margin-bottom:4px;font-size:13px;';
      setHTML(div, `
        <code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.url.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>
        <button type="button" class="btn btn-icon" title="${t('删除')}" style="font-size:14px;color:var(--destructive);">🗑️</button>`);
      div.querySelector('button').onclick = () => this.removeGlobalProxy(p.id);
      fragment.appendChild(div);
    }

    clearChildren(container);
    container.appendChild(fragment);

    if (hiddenCount > 0) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:var(--muted-foreground);font-size:12px;padding:4px 0;';
      hint.textContent = `${t('还有')}${hiddenCount}${t('个代理未显示（共')}${proxies.length}${t('个）')}`;
      container.appendChild(hint);
    }
  }

  // 添加全局代理
  addGlobalProxy() {
    const input = document.getElementById('globalNewProxyUrl');
    const url = input?.value?.trim();
    if (!url) { alert(t('请输入代理 URL')); return; }
    if (!url.match(/^(https?|socks[45]?h?):\/\//i)) {
      alert(t('代理 URL 格式不正确，支持 http://, https://, socks4://, socks5://'));
      return;
    }
    if (!this._globalProxyPool) this._globalProxyPool = [];
    if (this._globalProxyPool.some(p => p.url === url)) {
      alert(t('该代理已存在'));
      return;
    }
    this._globalProxyPool.push({ id: crypto.randomUUID(), url, enabled: true });
    input.value = '';
    this.renderGlobalProxyPoolList();
  }

  // 从 URL 导入全局代理
  async importGlobalProxies() {
    const urlInput = document.getElementById('globalImportProxyUrl');
    const url = urlInput?.value?.trim();
    if (!url) { alert(t('请输入代理列表 URL')); return; }

    try {
      const res = await fetch('/api/admin/fetch-proxies-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) { alert(t('获取失败: ') + (data.error || t('未知错误'))); return; }
      if (data.count === 0) { alert(t('代理列表为空')); return; }

      if (!this._globalProxyPool) this._globalProxyPool = [];
      const existingUrls = new Set(this._globalProxyPool.map(p => p.url));
      let added = 0;
      for (const proxyUrl of data.proxies) {
        if (!existingUrls.has(proxyUrl)) {
          this._globalProxyPool.push({ id: crypto.randomUUID(), url: proxyUrl, enabled: true });
          existingUrls.add(proxyUrl);
          added++;
        }
      }
      urlInput.value = '';
      this.renderGlobalProxyPoolList();
      alert(`${t('✅ 成功导入')}${added}${t('个代理')}`);
    } catch (err) {
      alert(t('导入失败: ') + err.message);
    }
  }

  // 批量添加全局代理
  batchAddGlobalProxies() {
    const input = document.getElementById('globalBatchProxyInput');
    const text = input?.value?.trim();
    if (!text) { alert(t('请输入代理地址')); return; }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!this._globalProxyPool) this._globalProxyPool = [];
    const existingUrls = new Set(this._globalProxyPool.map(p => p.url));
    let added = 0;
    for (const proxyUrl of lines) {
      if (proxyUrl.match(/^(https?|socks[45]?h?):\/\//i) && !existingUrls.has(proxyUrl)) {
        this._globalProxyPool.push({ id: crypto.randomUUID(), url: proxyUrl, enabled: true });
        existingUrls.add(proxyUrl);
        added++;
      }
    }
    input.value = '';
    this.renderGlobalProxyPoolList();
    alert(`${t('✅ 成功添加')}${added}${t('个代理')}`);
  }

  // 删除全局代理
  removeGlobalProxy(proxyId) {
    if (!this._globalProxyPool) return;
    this._globalProxyPool = this._globalProxyPool.filter(p => p.id !== proxyId);
    this.renderGlobalProxyPoolList();
  }

  // 检测全局代理池状态
  async checkGlobalProxyPoolStatus() {
    const statusPanel = document.getElementById('globalProxyPoolStatus');
    const statusContent = document.getElementById('globalProxyPoolStatusContent');
    if (!statusPanel || !statusContent) return;

    const subUrl = document.getElementById('globalProxySubUrl')?.value?.trim() || '';
    const manualCount = (this._globalProxyPool || []).length;

    statusPanel.style.display = 'block';
    const lines = [];

    if (manualCount > 0) {
      lines.push(`<span style="color:var(--success);">✓</span> ${t('手动代理:')} <b>${manualCount}${'</b>' + t('个')}`);
    } else {
      lines.push(`${'<span style="color:var(--muted-foreground);">' + '-' + '</span>' + t('手动代理: 0 个')}`);
    }

    if (subUrl) {
      lines.push(inlineLoadingHtml(t('订阅地址: 检测中...'), 'sm'));
      setHTML(statusContent, lines.join('<br>'));

      try {
        const res = await fetch('/api/admin/fetch-proxies-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: subUrl })
        });
        const data = await res.json();
        lines.pop();
        if (res.ok && data.count > 0) {
          lines.push(`<span style="color:var(--success);">✓</span> ${t('订阅地址:')} <b>${data.count}${'</b>' + t('个代理可用')}`);
        } else if (res.ok && data.count === 0) {
          lines.push(`${'<span style="color:var(--warning);">' + '⚠' + '</span>' + t('订阅地址: 返回内容中未找到有效代理')}`);
        } else {
          lines.push(`${'<span style="color:var(--destructive);">' + '✗' + '</span>' + t('订阅地址:')}${data.error || t('请求失败')}`);
        }
      } catch (e) {
        lines.pop();
        lines.push(`${'<span style="color:var(--destructive);">' + '✗' + '</span>' + t('订阅地址:')}${e.message}`);
      }
    } else {
      lines.push(`${'<span style="color:var(--muted-foreground);">' + '-' + '</span>' + t('订阅地址: 未配置')}`);
    }

    setHTML(statusContent, lines.join('<br>'));
  }

  // 手动刷新供应商密钥
  async refreshProviderKey(providerId) {
    try {
      const res = await fetch(`/api/admin/providers/${providerId}/refresh-key`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(t('✅ 密钥刷新成功') + (data.expiresAt ? '\n' + t('过期时间: ') + new Date(data.expiresAt).toLocaleString('zh-CN') : ''));
        this.loadProviders();
      } else {
        const errMsg = data.error || t('未知错误');
        console.error(t('[密钥刷新失败]'), providerId, errMsg);
        this._showScriptErrorDialog(providerId, errMsg);
      }
    } catch (error) {
      alert(t('❌ 请求失败: ') + error.message);
      console.error(t('[密钥刷新请求失败]'), providerId, error);
    }
  }

  // ---------- 脚本 AI 辅助：独立模型选择 ----------
  _SCRIPT_AI_MODEL_STORAGE_KEY = 'crewrouter_admin_script_ai_model';

  _getScriptAiModel() {
    try {
      const raw = localStorage.getItem(this._SCRIPT_AI_MODEL_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.id) return parsed;
    } catch (e) { /* ignore */ }
    return null;
  }

  _setScriptAiModel(model) {
    if (!model || !model.id) {
      localStorage.removeItem(this._SCRIPT_AI_MODEL_STORAGE_KEY);
      this._scriptAiModel = null;
      return;
    }
    const value = {
      id: String(model.id),
      name: model.name || model.id,
      provider_name: model.provider_name || model.provider || ''
    };
    localStorage.setItem(this._SCRIPT_AI_MODEL_STORAGE_KEY, JSON.stringify(value));
    this._scriptAiModel = value;
  }

  _formatScriptAiModelLabel(model) {
    if (!model || !model.id) return t('自动选择（按系统可用模型）');
    const name = model.name || model.id;
    return model.provider_name ? `${model.provider_name} → ${name}` : name;
  }

  _updateScriptAiModelLabel() {
    const el = document.getElementById('scriptAiModelLabel');
    if (!el) return;
    el.textContent = this._formatScriptAiModelLabel(this._scriptAiModel || this._getScriptAiModel());
  }

  /**
   * 打开独立模型选择浮层（挂到 body，避免 Dialog 单容器被覆盖）
   * @param {(model: {id,name,provider_name}|null) => void} onSelect
   */
  async _openScriptAiModelPicker(onSelect) {
    // 移除已有选择器
    document.getElementById('scriptAiModelPickerOverlay')?.remove();

    const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const selected = this._scriptAiModel || this._getScriptAiModel();

    const overlay = document.createElement('div');
    overlay.id = 'scriptAiModelPickerOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
      <div role="dialog" aria-label="${t('选择 AI 辅助模型')}" style="background:var(--card,#fff);color:var(--foreground);border:1px solid var(--border);border-radius:14px;width:min(560px,100%);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,0.25);">
        <div style="padding:16px 18px 10px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-weight:600;font-size:15px;">选择 AI 辅助模型</div>
            <div style="font-size:12px;color:var(--muted-foreground);margin-top:2px;">仅用于密钥脚本的分析/修复</div>
          </div>
          <button type="button" id="scriptAiModelPickerClose" class="btn btn-sm btn-secondary" style="min-width:auto;">关闭</button>
        </div>
        <div style="padding:12px 18px;">
          <input type="search" id="scriptAiModelSearch" class="input" placeholder="${t('搜索模型名称 / ID / 供应商...')}" style="width:100%;">
        </div>
        <div id="scriptAiModelList" style="padding:0 10px 12px;overflow-y:auto;flex:1;min-height:200px;max-height:50vh;">
          ${pageLoadingHtml(t('加载中...'), { size: 'md', compact: true })}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-secondary btn-sm" id="scriptAiModelClear">使用自动选择</button>
          <span style="font-size:12px;color:var(--muted-foreground);align-self:center;">当前：${escHtml(this._formatScriptAiModelLabel(selected))}</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('scriptAiModelPickerClose').onclick = close;
    document.getElementById('scriptAiModelClear').onclick = () => {
      this._setScriptAiModel(null);
      onSelect?.(null);
      close();
    };

    const listEl = document.getElementById('scriptAiModelList');
    const searchEl = document.getElementById('scriptAiModelSearch');
    let models = [];

    const render = (filter = '') => {
      const q = filter.trim().toLowerCase();
      const filtered = !q ? models : models.filter(m => {
        const hay = `${m.name || ''} ${m.id || ''} ${m.provider_name || ''} ${m.upstream_model_id || ''}`.toLowerCase();
        return hay.includes(q);
      });
      if (!filtered.length) {
        listEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted-foreground);font-size:13px;">${models.length ? t('无匹配模型') : t('暂无可用模型（需启用且供应商已配置 API Key）')}</div>`;
        return;
      }
      const selectedId = selected?.id ? String(selected.id) : '';
      listEl.innerHTML = filtered.map(m => {
        const isActive = selectedId && String(m.id) === selectedId;
        const title = escHtml(m.name || m.id);
        const sub = escHtml([m.provider_name, m.upstream_model_id || m.id].filter(Boolean).join(' · '));
        return `
          <button type="button" class="script-ai-model-item" data-model-id="${escHtml(m.id)}"
            style="display:block;width:100%;text-align:left;padding:10px 12px;margin:4px 0;border-radius:10px;border:1px solid ${isActive ? 'var(--primary,var(--info))' : 'var(--border)'};background:${isActive ? 'rgba(59,130,246,0.08)' : 'transparent'};cursor:pointer;color:inherit;">
            <div style="font-weight:600;font-size:13px;">${title}${isActive ? ' <span style="color:var(--primary,var(--info));font-size:11px;">' + t('当前') + '</span>' : ''}</div>
            <div style="font-size:12px;color:var(--muted-foreground);margin-top:2px;">${sub}</div>
          </button>
        `;
      }).join('');

      listEl.querySelectorAll('.script-ai-model-item').forEach(btn => {
        btn.onclick = () => {
          const id = btn.getAttribute('data-model-id');
          const m = models.find(x => String(x.id) === String(id));
          if (!m) return;
          const value = { id: m.id, name: m.name || m.id, provider_name: m.provider_name || '' };
          this._setScriptAiModel(value);
          onSelect?.(value);
          close();
        };
      });
    };

    searchEl.addEventListener('input', () => render(searchEl.value));

    try {
      const res = await fetch('/api/admin/models');
      if (!res.ok) throw new Error(t('加载模型列表失败'));
      const all = await res.json();
      // 仅展示已启用模型；供应商 Key 是否可用由后端 tryAiRequest 再校验
      models = (Array.isArray(all) ? all : [])
        .filter(m => m && m.enabled !== false)
        .map(m => ({
          id: m.id,
          name: m.name || m.alias || m.id,
          provider_name: m.provider_name || m.provider || '',
          upstream_model_id: m.upstream_model_id || ''
        }))
        .sort((a, b) => {
          const pa = (a.provider_name || '').localeCompare(b.provider_name || '', 'zh');
          if (pa !== 0) return pa;
          return (a.name || '').localeCompare(b.name || '', 'zh');
        });
      render();
      searchEl.focus();
    } catch (e) {
      listEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--destructive);font-size:13px;">${escHtml(e.message || t('加载失败'))}</div>`;
    }
  }

  // 显示脚本错误对话框（含 AI 分析和修复功能）
  async _showScriptErrorDialog(providerId, errMsg) {
    // 获取当前脚本内容
    let currentScript = '';
    try {
      const provRes = await fetch('/api/admin/providers');
      const providers = await provRes.json();
      const p = providers.find(pr => pr.id === providerId);
      currentScript = p?.key_script || '';
    } catch (e) { /* ignore */ }

    this._scriptAiModel = this._getScriptAiModel();
    const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const content = `
      <div style="max-height:60vh;overflow-y:auto;">
        <div style="background:var(--destructive-bg,rgba(239,68,68,0.08));border:1px solid var(--destructive,var(--danger));border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="font-weight:600;color:var(--destructive,var(--danger));margin-bottom:8px;">❌ 密钥刷新失败</div>
          <pre style="white-space:pre-wrap;word-break:break-all;font-size:13px;margin:0;max-height:200px;overflow-y:auto;color:var(--foreground);">${escHtml(errMsg)}</pre>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;border:1px solid var(--border);border-radius:8px;background:var(--card);">
          <div style="min-width:0;flex:1;">
            <div style="font-size:12px;color:var(--muted-foreground);margin-bottom:2px;">AI 辅助模型</div>
            <div id="scriptAiModelLabel" style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(this._formatScriptAiModelLabel(this._scriptAiModel))}</div>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="scriptAiSelectModelBtn">选择模型</button>
        </div>
        <div id="aiAnalysisSection" style="display:none;">
          <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
            <span>🤖</span> AI 分析结果
          </div>
          <div id="aiAnalysisContent" style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:300px;overflow-y:auto;"></div>
        </div>
        <div id="aiFixSection" style="display:none;margin-top:12px;">
          <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
            <span>🔧</span> AI 修复代码
          </div>
          <div id="aiFixContent" style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:300px;overflow-y:auto;font-family:monospace;"></div>
        </div>
      </div>
    `;

    const modal = Dialog.showModal({
      title: t('脚本执行错误'),
      content: content,
      width: 600,
      footer: `
        <button class="btn btn-primary" id="aiAnalyzeBtn">🤖 让 AI 分析错误并给出修改建议</button>
        <button class="btn btn-success" id="aiFixBtn" style="display:none;">🔧 让 AI 修复错误</button>
        <button class="btn btn-primary" id="aiApplyBtn" style="display:none;">✅ 应用修复代码</button>
      `
    });

    const getSelectedModelId = () => {
      const m = this._scriptAiModel || this._getScriptAiModel();
      return m?.id || null;
    };

    document.getElementById('scriptAiSelectModelBtn').onclick = () => {
      this._openScriptAiModelPicker((model) => {
        this._scriptAiModel = model;
        this._updateScriptAiModelLabel();
      });
    };

    // AI 分析按钮
    document.getElementById('aiAnalyzeBtn').onclick = async () => {
      const btn = document.getElementById('aiAnalyzeBtn');
      btn.disabled = true;
      setButtonLoading(btn, t('AI 分析中...'));

      const section = document.getElementById('aiAnalysisSection');
      const contentEl = document.getElementById('aiAnalysisContent');
      section.style.display = 'block';
      setHTML(contentEl, '<span style="color:var(--muted-foreground);">' + t('正在分析，请稍候...') + '</span>');

      let fullText = '';

      try {
        const res = await fetch(`/api/admin/providers/${providerId}/analyze-script-error`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script: currentScript,
            error: errMsg,
            modelId: getSelectedModelId()
          })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: t('请求失败') }));
          setHTML(contentEl, `<span style="color:var(--destructive);">${escHtml(err.error || t('AI 分析失败'))}</span>`);
          clearButtonLoading(btn, t('🤖 让 AI 分析错误并给出修改建议'));
          btn.disabled = false;
          return;
        }

        clearChildren(contentEl);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.done) break;
              if (parsed.content) {
                fullText += parsed.content;
                contentEl.textContent = fullText;
                contentEl.scrollTop = contentEl.scrollHeight;
              }
            } catch (e) { /* ignore */ }
          }
        }

        clearButtonLoading(btn, t('✅ 分析完成'));
        // 显示修复按钮
        const fixBtn = document.getElementById('aiFixBtn');
        if (fixBtn) fixBtn.style.display = '';
      } catch (e) {
        setHTML(contentEl, `${'<span style="color:var(--destructive);">' + t('请求失败:')}${escHtml(e.message)}</span>`);
        clearButtonLoading(btn, t('🤖 让 AI 分析错误并给出修改建议'));
        btn.disabled = false;
      }

      // 存储分析结果供修复使用
      this._lastAnalysis = fullText;
    };

    // AI 修复按钮
    document.getElementById('aiFixBtn').onclick = async () => {
      const fixBtn = document.getElementById('aiFixBtn');
      fixBtn.disabled = true;
      setButtonLoading(fixBtn, t('AI 修复中...'));

      // 显示修复输出区域
      const fixSection = document.getElementById('aiFixSection');
      const fixContent = document.getElementById('aiFixContent');
      if (fixSection) fixSection.style.display = 'block';
      if (fixContent) {
        setHTML(fixContent, '<span style="color:var(--muted-foreground);">' + t('正在生成修复代码，请稍候...') + '</span>');
      }

      let fullText = '';

      try {
        const res = await fetch(`/api/admin/providers/${providerId}/fix-script`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script: currentScript,
            error: errMsg,
            analysis: this._lastAnalysis || '',
            modelId: getSelectedModelId()
          })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: t('请求失败') }));
          if (fixContent) setHTML(fixContent, `<span style="color:var(--destructive);">${escHtml(err.error || t('AI 修复失败'))}</span>`);
          clearButtonLoading(fixBtn, t('🔧 让 AI 修复错误'));
          fixBtn.disabled = false;
          return;
        }

        if (fixContent) clearChildren(fixContent);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fixedScript = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.done) {
                fixedScript = parsed.fixedScript || fullText;
                break;
              }
              if (parsed.content) {
                fullText += parsed.content;
                if (fixContent) {
                  fixContent.textContent = fullText;
                  fixContent.scrollTop = fixContent.scrollHeight;
                }
              }
            } catch (e) { /* ignore */ }
          }
          if (fixedScript) break;
        }

        // 清理 markdown 代码块标记
        if (!fixedScript) {
          fixedScript = fullText.replace(/^```(?:javascript|js)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
        }

        clearButtonLoading(fixBtn, t('✅ 修复完成'));

        if (fixedScript) {
          // 显示应用按钮
          const applyBtn = document.getElementById('aiApplyBtn');
          if (applyBtn) {
            applyBtn.style.display = '';
            applyBtn.onclick = () => {
              modal.close();
              const scriptTextarea = document.getElementById('providerKeyScript');
              if (scriptTextarea) {
                scriptTextarea.value = fixedScript;
                scriptTextarea.dispatchEvent(new Event('input', { bubbles: true }));
              }
              alert(t('✅ AI 已修复脚本，请检查后保存'));
            };
          }
        } else {
          if (fixContent) appendHTML(fixContent, '<br><span style="color:var(--destructive);">' + t('⚠️ AI 未能生成修复代码') + '</span>');
          clearButtonLoading(fixBtn, t('🔧 让 AI 修复错误'));
          fixBtn.disabled = false;
        }
      } catch (e) {
        if (fixContent) setHTML(fixContent, `${'<span style="color:var(--destructive);">' + t('请求失败:')}${escHtml(e.message)}</span>`);
        clearButtonLoading(fixBtn, t('🔧 让 AI 修复错误'));
        fixBtn.disabled = false;
      }
    };
  }

  // 密钥脚本示例模板
  _keyScriptExamples = {
    oauth2: `// OAuth2 Client Credentials 模式获取 Token
// 适用于：标准 OAuth2 供应商（如 Azure OpenAI、企业 API 网关）
async function(ctx) {
  const resp = await ctx.fetch('https://auth.example.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'YOUR_CLIENT_ID',
      client_secret: 'YOUR_CLIENT_SECRET',
      scope: 'api.access'
    })
  });

  if (!resp.ok) {
    throw new Error(t('Token 请求失败: ') + resp.status + ' ' + await resp.text());
  }

  const data = await resp.json();
  // 返回密钥和过期时间（秒）
  return { key: data.access_token, expiresIn: data.expires_in };
}`,

    jwt: `// JWT 签名获取 Bearer Token
// 适用于：需要 JWT 签名认证的供应商
async function(ctx) {
  // --- 你需要填入自己的 JWT 组件 ---
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'YOUR_CLIENT_ID',
    sub: 'YOUR_SERVICE_ACCOUNT',
    aud: 'https://auth.example.com',
    iat: now,
    exp: now + 3600
  };

  // 注意：服务端环境无 crypto.subtle，需用第三方库
  // 此处仅为示意，实际请用 jsonwebtoken 等库
  // const jwt = require('jsonwebtoken'); // 如已安装
  // const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

  // 简化示例：直接用预生成的长期 JWT 换取短期 Token
  const resp = await ctx.fetch(ctx.baseUrl + '/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'jwt', assertion: 'YOUR_JWT_HERE' })
  });

  const data = await resp.json();
  return { key: data.access_token, expiresIn: data.expires_in };
}`,

    login: `// 账密登录获取 Token
// 适用于：通过用户名密码登录获取 API Key 的供应商
async function(ctx) {
  const resp = await ctx.fetch(ctx.baseUrl + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    })
  });

  if (!resp.ok) {
    throw new Error(t('登录失败: ') + resp.status + ' ' + await resp.text());
  }

  const data = await resp.json();
  // 根据实际响应字段调整
  return {
    key: data.token || data.api_key || data.access_token,
    expiresIn: data.expires_in || data.ttl || 7200
  };
}`,

    custom: `// 自定义 HTTP 请求获取密钥
// 模板：根据实际 API 响应格式调整
async function(ctx) {
  // 第 1 步：发送请求获取密钥
  const resp = await ctx.fetch('https://api.example.com/key/rotate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ctx.currentKey  // 用旧密钥换新密钥
    },
    body: JSON.stringify({ /* 请求参数 */ })
  });

  // 第 2 步：检查响应状态
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(t('密钥获取失败: HTTP ') + resp.status + ' - ' + errText);
  }

  // 第 3 步：解析响应并返回
  const data = await resp.json();

  // ---- 根据实际响应格式修改以下字段 ----
  return {
    key: data.api_key,           // 密钥字段名
    expiresIn: data.ttl_seconds  // 过期时间（秒），可省略
  };
}`
  };

  // 填充脚本示例
  fillKeyScriptExample(type) {
    const example = this._keyScriptExamples[type];
    if (!example) return;
    const textarea = document.getElementById('providerKeyScript');
    if (textarea) {
      textarea.value = example;
      textarea.focus();
    }
  }

  // 复制脚本文档
  copyKeyScriptDoc() {
    const doc = `CrewRouter 密钥刷新脚本开发文档
================================

【执行方式】
脚本被包装为 async function(ctx) 执行，支持 await。

【上下文变量 ctx】
  ctx.baseUrl       — 供应商 Base URL（已去除尾部 /）
  ctx.providerId     — 供应商 ID
  ctx.providerName   — 供应商名称
  ctx.currentKey     — 当前缓存的密钥（首次刷新时为空字符串）
  ctx.fetch          — 全局 fetch 函数，可直接发 HTTP 请求

【返回值】
  方式一：直接返回密钥字符串
    return 'sk-xxx'

  方式二：返回对象（可指定过期时间）
    return { key: 'sk-xxx', expiresIn: 3600 }

  expiresIn 单位为秒，会覆盖「刷新间隔」设置。
  支持的别名：access_token / token / expires_in

【错误处理】
  脚本抛出异常时，系统保留旧密钥并在 60 秒后重试。
  建议用 try/catch 包裹请求并抛出有意义的错误信息。

【示例 1：OAuth2 Client Credentials】
async function(ctx) {
  const resp = await ctx.fetch('https://auth.example.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'YOUR_CLIENT_ID',
      client_secret: 'YOUR_CLIENT_SECRET',
      scope: 'api.access'
    })
  });
  if (!resp.ok) throw new Error(t('Token 请求失败: ') + resp.status);
  const data = await resp.json();
  return { key: data.access_token, expiresIn: data.expires_in };
}

【示例 2：账密登录获取 Token】
async function(ctx) {
  const resp = await ctx.fetch(ctx.baseUrl + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'user', password: 'pass' })
  });
  if (!resp.ok) throw new Error(t('登录失败: ') + resp.status);
  const data = await resp.json();
  return { key: data.token, expiresIn: data.expires_in || 7200 };
}

【示例 3：旧密钥换新密钥】
async function(ctx) {
  const resp = await ctx.fetch(ctx.baseUrl + '/key/rotate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ctx.currentKey
    }
  });
  if (!resp.ok) throw new Error(t('轮换失败: ') + resp.status);
  const data = await resp.json();
  return { key: data.api_key, expiresIn: data.ttl };
}

【示例 4：AWS STS 临时凭证】
async function(ctx) {
  // 需要 AWS SDK 或手动签名，此处用简化示例
  const resp = await ctx.fetch('https://sts.amazonaws.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'Action=GetCallerIdentity&Version=2011-06-15'
  });
  // 实际需根据 AWS 响应格式解析
  const data = await resp.json();
  return { key: data.Credentials.AccessKeyId, expiresIn: 3600 };
}`;

    const doCopy = async () => {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(doc);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = doc;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    };

    doCopy().then(ok => {
      if (ok) alert(t('文档已复制到剪贴板'));
    }).catch(() => alert(t('复制失败')));
  }

  // 切换供应商额度查询开关
  async toggleProviderQuota(providerId, enabled) {
    try {
      const res = await fetch(`/api/admin/providers/${providerId}/toggle-quota`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.error || t('操作失败'), 'error');
        this.loadProviders();
        return;
      }
      const p = (this.providersData || []).find(x => x.id === providerId);
      if (p) p.quota_enabled = enabled;
      this.showToast(enabled ? t('已开启额度查询') : t('已关闭额度查询'), 'success');
      if (enabled) {
        this.loadProviderQuotaInline(providerId);
      } else {
        const empty = '<span style="color:var(--muted-foreground);font-size:12px;">' + t('未启用') + '</span>';
        const el = document.getElementById(`quota-display-${providerId}`);
        const cardEl = document.getElementById(`quota-display-card-${providerId}`);
        if (el) setHTML(el, empty);
        if (cardEl) setHTML(cardEl, empty);
      }
      this.loadProviders();
    } catch (e) {
      this.showToast(t('操作失败: ') + e.message, 'error');
    }
  }

  async toggleProviderEnabled(providerId, enabled) {
    try {
      const res = await fetch(`/api/admin/providers/${providerId}/toggle-enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.error || t('操作失败'), 'error');
      } else {
        this.showToast(enabled ? t('已启用') : t('已禁用'), 'success');
        const p = (this.providersData || []).find(x => x.id === providerId);
        if (p) p.enabled = enabled;
        // 供应商启停影响 Team 模型权限里的「供应商禁用」标记
        this._notifyModelsCatalogChanged();
      }
      this.loadProviders();
    } catch (e) {
      this.showToast(t('操作失败: ') + e.message, 'error');
    }
  }

  // 内联加载供应商额度（表格 / 卡片）
  async loadProviderQuotaInline(providerId) {
    const els = [
      document.getElementById(`quota-display-${providerId}`),
      document.getElementById(`quota-display-card-${providerId}`)
    ].filter(Boolean);
    if (!els.length) return;

    const loading = inlineLoadingHtml(t('查询中...'), 'sm');
    els.forEach(el => setHTML(el, loading));
    const quotaButton = document.getElementById(`quota-btn-${providerId}`);
    if (quotaButton) {
      quotaButton.disabled = true;
      setHTML(quotaButton, loading);
    }

    try {
      const res = await fetch(`/api/admin/providers/${providerId}/check-quota`);
      const data = await res.json();

      if (!res.ok || !data.success) {
        const errHtml = `<span style="color:var(--destructive);font-size:12px;" title="${escapeHtml(data.error || '查询失败')}">${t('查询失败')}</span>`;
        els.forEach(el => setHTML(el, errHtml));
        return;
      }

      const q = data.quota;
      const total = parseFloat(q.total) || 0;
      const pct = total > 0 ? Math.round((parseFloat(q.used) || 0) / total * 100) : 0;

      let barColor = 'var(--brand-blue)';
      if (pct >= 90) barColor = 'var(--destructive)';
      else if (pct >= 70) barColor = 'var(--warning)';

      const html = `
        <div style="font-size:13px;font-weight:600;">${escapeHtml(String(q.remaining ?? ''))}</div>
        <div style="height:3px;background:var(--border);border-radius:2px;margin:3px 0;width:80px;">
          <div style="height:100%;width:${Math.min(pct, 100)}%;background:${barColor};border-radius:2px;"></div>
        </div>
        <div style="font-size:10px;color:var(--muted-foreground);">${escapeHtml(q.extra || q.planName || '')}</div>
      `;
      els.forEach(el => setHTML(el, html));
    } catch (e) {
      els.forEach(el => setHTML(el, `<span style="color:var(--destructive);font-size:12px;">${t('网络错误')}</span>`));
    } finally {
      if (quotaButton) {
        quotaButton.disabled = false;
        setHTML(quotaButton, t('查询额度'));
      }
    }
  }

  async deleteProvider(id) {
    const ok = await Dialog.confirm(
      t('删除供应商'),
       t('确定要删除此供应商吗？') + '<br><br><strong style="color:var(--destructive);">' + t('将同时删除该供应商下的全部模型') + '</strong>' + t('，并清理 Team 绑定、API Key 模型绑定等关联数据。此操作不可撤销。'),
      { confirmText: t('确认删除'), danger: true }
    );
    if (!ok) return;

    try {
      const response = await fetch(`/api/admin/providers/${id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        const n = result.deletedModels || 0;
        this.showToast(n > 0 ? `${t('供应商已删除，并清理了')}${n}${t('个关联模型')}` : t('供应商已删除'), 'success');
        this._invalidateAdminProviderModelsCache();
        this._notifyModelsCatalogChanged();
        this.loadProviders();
        if (typeof this.loadModels === 'function') this.loadModels();
      } else {
        const err = await response.json().catch(() => ({}));
        this.showToast(err.error || t('删除失败'), 'error');
      }
    } catch (error) {
      console.error(t('删除供应商失败:'), error);
      this.showToast(t('删除失败'), 'error');
    }
  }

  // 获取供应商模型列表
  async fetchProviderModels(providerId) {
    this.currentFetchProviderId = providerId;
    this.fetchedModels = [];
    this.fetchedExistingModels = [];
    this.fetchedExistingById = {};
    this.fetchedExistingIds = new Set();

    // 显示对话框
    document.getElementById('fetchModelsTitle').textContent = t('获取模型列表');
    document.getElementById('fetchModelsLoading').style.display = 'block';
    document.getElementById('fetchModelsError').style.display = 'none';
    document.getElementById('fetchModelsContent').style.display = 'none';
    document.getElementById('saveFetchedModelsBtn').style.display = 'none';
    const cleanupBtn = document.getElementById('cleanupStaleModelsBtn');
    if (cleanupBtn) cleanupBtn.style.display = 'none';
    document.getElementById('selectAllFetchedModels').checked = false;

    document.getElementById('fetchModelsModal').style.display = 'flex';
    document.getElementById('fetchModelsModal').classList.add('active');

    try {
      const url = `/api/admin/providers/${providerId}/fetch-models`;
      console.log(`${t('[获取模型] 请求: GET')}${url}`);
      const response = await fetch(url);
      const data = await response.json();
      console.log(`${t('[获取模型] 响应: status=')}${response.status}`, data);

      // 输出详细的调试信息到控制台
      if (data.debug?.attempts) {
        console.group(t('[获取模型] 请求尝试详情'));
        data.debug.attempts.forEach((a, i) => {
          console.log(`${t('尝试')}${i + 1}: ${a.url}`);
          console.log(`${t('状态:')}${a.status || 'N/A'}`);
          console.log(`  Content-Type: ${a.contentType || 'N/A'}`);
          if (a.error) console.log(`${t('错误:')}${a.error}`);
          if (a.bodyPreview) console.log(`${t('响应预览:')}${a.bodyPreview}`);
          if (a.success) console.log(`${t('成功! 模型数:')}${a.modelCount}`);
        });
        if (data.debug.succeededUrl) console.log(`${t('成功路径:')}${data.debug.succeededUrl}`);
        console.groupEnd();
      }

      if (!response.ok) {
        document.getElementById('fetchModelsLoading').style.display = 'none';
        document.getElementById('fetchModelsError').style.display = 'block';
        let errorMsg = data.error || t('获取失败');
        if (data.debug?.attempts) {
          errorMsg += '\n\n' + t('尝试过的路径:') + '\n';
          data.debug.attempts.forEach(a => {
            errorMsg += `  ${a.url}: ${a.error || `HTTP ${a.status}`}\n`;
          });
        }
        document.getElementById('fetchModelsError').textContent = errorMsg;
        document.getElementById('fetchModelsError').style.whiteSpace = 'pre-wrap';
        console.error(`${t('[获取模型] 失败:')}`, data);
        return;
      }

      const models = Array.isArray(data.models) ? data.models : [];
      const existingModels = Array.isArray(data.existingModels) ? data.existingModels : [];
      // 上游为空但本地仍有模型时，仍展示列表（便于清理已下架）
      if (models.length === 0 && existingModels.length === 0) {
        document.getElementById('fetchModelsLoading').style.display = 'none';
        document.getElementById('fetchModelsError').style.display = 'block';
        document.getElementById('fetchModelsError').style.color = 'var(--muted-foreground)';
        document.getElementById('fetchModelsError').textContent = data.message || t('未获取到模型');
        return;
      }

      this.fetchedModels = models;
      this.fetchedExistingIds = new Set(data.existingIds || []);
      this.fetchedExistingModels = existingModels;
      this.fetchedExistingById = data.existingById || {};
      this.fetchedModelsFilter = 'all';
      this.renderFetchedModels(data.provider_name, models);
    } catch (error) {
      console.error(t('获取供应商模型失败:'), error);
      document.getElementById('fetchModelsLoading').style.display = 'none';
      document.getElementById('fetchModelsError').style.display = 'block';
      document.getElementById('fetchModelsError').textContent = t('网络错误: ') + error.message;
    }
  }

  renderFetchedModels(providerName, models) {
    document.getElementById('fetchModelsLoading').style.display = 'none';
    const contentEl = document.getElementById('fetchModelsContent');
    if (contentEl) contentEl.style.display = 'flex';
    document.getElementById('saveFetchedModelsBtn').style.display = 'inline-flex';
    document.getElementById('fetchedModelsSearch').value = '';

    this._renderFetchedModelsList(models);
    this._updateFetchedModelsFilterTabs();
    this._updateCleanupStaleModelsBtn();
  }

  /** 同步弹窗：根据当前已下架数量显示/隐藏清理按钮 */
  _updateCleanupStaleModelsBtn() {
    const btn = document.getElementById('cleanupStaleModelsBtn');
    if (!btn) return;
    const models = this.fetchedModels || [];
    const existingModels = this.fetchedExistingModels || [];
    const upstreamIds = new Set(models.map(m => m.id));
    const staleCount = existingModels.filter(m => !upstreamIds.has(m.id)).length;
    btn.style.display = staleCount > 0 ? 'inline-flex' : 'none';
    btn.textContent = staleCount > 0 ? `${t('清理已下架模型 (')}${staleCount})` : t('清理已下架模型');
    btn.disabled = false;
  }

  /**
   * 同步弹窗：清理当前供应商已下架模型记录
   */
  async cleanupStaleModelsInFetchModal() {
    const providerId = this.currentFetchProviderId;
    if (!providerId) return;

    const models = this.fetchedModels || [];
    const existingModels = this.fetchedExistingModels || [];
    const upstreamIds = new Set(models.map(m => m.id));
    const staleModels = existingModels.filter(m => !upstreamIds.has(m.id));
    if (staleModels.length === 0) {
      this.showToast(t('没有可清理的已下架模型'), 'info');
      this._updateCleanupStaleModelsBtn();
      return;
    }

    const preview = staleModels.slice(0, 8).map(m => escapeHtml(m.name || m.id)).join('、');
    const more = staleModels.length > 8 ? `${t('等')}${staleModels.length}${t('个')}` : '';
    const ok = await Dialog.confirm(
      t('清理已下架模型'),
      `${t('将')}<strong style="color:var(--destructive);">${t('永久删除')}</strong>${t('本供应商下')} <strong>${staleModels.length}${'</strong>' + t('个上游已不存在的本地模型记录（含 Team / API Key 绑定等关联数据）。此操作不可撤销。')}<br><br>` +
        `${'<span style="font-size:13px;color:var(--muted-foreground);">' + t('预览：')}${preview}${more}</span>`,
      { confirmText: t('确认清理'), danger: true }
    );
    if (!ok) return;

    const btn = document.getElementById('cleanupStaleModelsBtn');
    if (btn) {
      btn.disabled = true;
      setButtonLoading(btn, t('清理中...'));
    }

    try {
      const response = await fetch(
        `/api/admin/providers/${encodeURIComponent(providerId)}/cleanup-stale-models`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelIds: staleModels.map(m => m.systemId).filter(Boolean) })
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.showToast(result.error || t('清理失败'), 'error');
        return;
      }

      const deleted = result.deleted || 0;
      this.showToast(
        deleted > 0 ? `${t('已清理')}${deleted}${t('个已下架模型')}` : (result.message || t('没有可清理的已下架模型')),
        deleted > 0 ? 'success' : 'info'
      );

      // 从本地缓存移除已删除项并刷新列表
      const deletedSet = new Set(result.deletedIds || staleModels.map(m => m.systemId));
      this.fetchedExistingModels = (this.fetchedExistingModels || []).filter(
        m => !deletedSet.has(m.systemId)
      );
      this.fetchedExistingIds = new Set((this.fetchedExistingModels || []).map(m => m.id));
      const byId = { ...(this.fetchedExistingById || {}) };
      for (const m of staleModels) {
        if (deletedSet.has(m.systemId)) delete byId[m.id];
      }
      this.fetchedExistingById = byId;

      this._renderFetchedModelsList(this.fetchedModels || []);
      this._updateFetchedModelsFilterTabs();
      this._updateCleanupStaleModelsBtn();
      this._invalidateAdminProviderModelsCache?.();
      this._notifyModelsCatalogChanged();
      if (typeof this.loadModels === 'function') {
        this.loadModels({ resetPage: false }).catch(() => {});
      }
    } catch (error) {
      console.error(t('清理已下架模型失败:'), error);
      this.showToast(t('清理失败: ') + error.message, 'error');
    } finally {
      if (btn) {
        clearButtonLoading(btn, btn.textContent || t('清理已下架模型'));
        btn.disabled = false;
        this._updateCleanupStaleModelsBtn();
      }
    }
  }

  /**
   * 供应商管理：对比所有供应商上游列表，清理全部已下架模型
   */
  async cleanupAllStaleModels() {
    if (this._cleanupAllStaleRunning) {
      this.showToast(t('清理任务进行中，请稍候'), 'info');
      return;
    }

    const ok = await Dialog.confirm(
      t('清理所有已下架模型'),
       t('将依次从') + '<strong>' + t('每个供应商') + '</strong>' + t('拉取上游模型列表，对比后') + '<strong style="color:var(--destructive);">' + t('永久删除') + '</strong>' + t('本地已下架的模型记录（含 Team / API Key 绑定等关联数据）。') +
        '<br><br>' + t('拉取失败的供应商会') + '<strong>' + t('跳过') + '</strong>' + t('（不会误删）。此操作可能耗时较长，且不可撤销。') + ',',
      { confirmText: t('开始清理'), danger: true }
    );
    if (!ok) return;

    this._cleanupAllStaleRunning = true;
    const toolbarBtn = document.getElementById('cleanupAllStaleModelsBtn');
    if (toolbarBtn) {
      toolbarBtn.disabled = true;
      setButtonLoading(toolbarBtn, t('清理中...'));
    }

    try {
      const response = await fetch('/api/admin/providers/cleanup-stale-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.showToast(result.error || t('清理失败'), 'error');
        return;
      }

      const deleted = result.deleted || 0;
      const skipped = result.skippedProviders || 0;
      const successN = result.successProviders || 0;
      const parts = [
        `${t('删除')}${deleted}${t('个已下架模型')}`,
        `${t('成功对比')}${successN}${t('个供应商')}`
      ];
      if (skipped > 0) parts.push(`${t('跳过')}${skipped}${t('个（拉取失败）')}`);
      this.showToast(parts.join(' · '), deleted > 0 || skipped === 0 ? 'success' : 'info');

      // 若同步弹窗打开且属于某一供应商，刷新该列表
      if (this.currentFetchProviderId && document.getElementById('fetchModelsModal')?.classList.contains('active')) {
        this.fetchProviderModels(this.currentFetchProviderId).catch(() => {});
      }
      this._invalidateAdminProviderModelsCache?.();
      this._notifyModelsCatalogChanged();
      if (typeof this.loadModels === 'function') {
        this.loadModels({ resetPage: false }).catch(() => {});
      }
      if (typeof this.loadProviders === 'function') {
        this.loadProviders({ resetPage: false }).catch(() => {});
      }
    } catch (error) {
      console.error(t('清理全部已下架模型失败:'), error);
      this.showToast(t('清理失败: ') + error.message, 'error');
    } finally {
      this._cleanupAllStaleRunning = false;
      if (toolbarBtn) {
        clearButtonLoading(toolbarBtn, t('清理所有已下架模型'));
        toolbarBtn.disabled = false;
      }
    }
  }

  _renderFetchedModelsList(models) {
    const existingById = this.fetchedExistingById || {};
    const existingModels = this.fetchedExistingModels || [];
    const fetchedModelIds = new Set(models.map(m => m.id));
    // 已不在上游列表中的已添加模型
    const staleModels = existingModels.filter(m => !fetchedModelIds.has(m.id));
    document.getElementById('selectAllFetchedModels').checked = false;

    const container = document.getElementById('fetchedModelsList');

    // 取消之前的渐进渲染任务
    if (this._pendingFetchedModelsRaf) {
      cancelAnimationFrame(this._pendingFetchedModelsRaf);
      this._pendingFetchedModelsRaf = null;
    }

    const _buildItemHtml = (model, index, extraAttrs) => {
      const existing = existingById[model.id];
      const isInSystem = !!existing;
      const isEnabled = existing?.enabled === true;
      const isStale = extraAttrs?.stale;
      const statusClass = isStale ? 'stale' : (isEnabled ? 'enabled' : 'disabled');

      return `
        <div class="model-check-item" data-model-id="${model.id}" data-model-name="${model.name || ''}" data-status="${statusClass}"${extraAttrs?.attrs || ''}>
          <input type="checkbox" class="checkbox" id="fetchedModel_${index}" value="${model.id}" ${isEnabled ? 'checked' : ''} onchange="adminApp.updateFetchedModelsCount()">
          <label for="fetchedModel_${index}">
            <span class="model-name">${model.name || model.id}</span>
            ${model.name && model.name !== model.id ? `<span class="model-id">${model.id}</span>` : ''}
            ${isStale ? '<span class="status-badge stale-badge">' + t('已失效') + '</span>' : (isInSystem ? (isEnabled ? '<span class="status-badge enabled-badge">' + t('已启用') + '</span>' : '<span class="status-badge disabled-badge">' + t('已禁用') + '</span>') : '<span class="status-badge new-badge">' + t('新模型') + '</span>')}
          </label>
        </div>
      `;
    };

    const INITIAL_BATCH = 50;
    const CHUNK_SIZE = 100;

    // 先渲染第一批（快速显示）
    const initialModels = models.slice(0, INITIAL_BATCH);
    let html = initialModels.map((model, i) => _buildItemHtml(model, i)).join('');

    // 已下架的模型（之前添加过但已不在上游列表）
    const staleHtml = staleModels.map((model, i) => _buildItemHtml(model, i + models.length, {
      stale: true,
      attrs: ' data-system-id="' + model.systemId + '" style="border-left:3px solid var(--destructive);opacity:0.6;"'
    })).join('');

    setHTML(container, html + staleHtml);
    this._applyFetchedModelsFilter();

    // 如果模型数量不多，直接返回
    if (models.length <= INITIAL_BATCH) return;

    // 渐进渲染剩余模型
    let currentIndex = INITIAL_BATCH;
    const remainingModels = models.slice(INITIAL_BATCH);

    const renderChunk = () => {
      const end = Math.min(currentIndex + CHUNK_SIZE, models.length);
      const chunk = models.slice(currentIndex, end);
      const chunkHtml = chunk.map((model, i) =>
        _buildItemHtml(model, currentIndex + i)
      ).join('');

      const temp = document.createElement('div');
      setHTML(temp, chunkHtml);
      while (temp.firstChild) {
        container.appendChild(temp.firstChild);
      }

      currentIndex = end;
      this._applyFetchedModelsFilter();

      if (currentIndex < models.length) {
        this._pendingFetchedModelsRaf = requestAnimationFrame(renderChunk);
      } else {
        this._pendingFetchedModelsRaf = null;
      }
    };

    this._pendingFetchedModelsRaf = requestAnimationFrame(renderChunk);
  }

  setFetchedModelsFilter(filter) {
    this.fetchedModelsFilter = filter;
    this._updateFetchedModelsFilterTabs();
    this._applyFetchedModelsFilter();
  }

  _updateFetchedModelsFilterTabs() {
    const tabs = document.querySelectorAll('#fetchedModelsTabs button');
    tabs.forEach(tab => {
      const isActive = tab.dataset.filter === (this.fetchedModelsFilter || 'all');
      tab.className = isActive ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary';
    });
  }

  _applyFetchedModelsFilter() {
    const keyword = (document.getElementById('fetchedModelsSearch').value || '').trim().toLowerCase();
    const filter = this.fetchedModelsFilter || 'all';
    const items = document.querySelectorAll('#fetchedModelsList .model-check-item');
    let visibleCount = 0;
    items.forEach(item => {
      const id = (item.dataset.modelId || '').toLowerCase();
      const name = (item.dataset.modelName || '').toLowerCase();
      const status = item.dataset.status;
      const matchSearch = !keyword || id.includes(keyword) || name.includes(keyword);
      let matchFilter = true;
      if (filter === 'enabled') matchFilter = status === 'enabled';
      else if (filter === 'disabled') matchFilter = status === 'disabled';
      else if (filter === 'stale') matchFilter = status === 'stale';
      const visible = matchSearch && matchFilter;
      item.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;
    });
    const enabledCount = document.querySelectorAll('#fetchedModelsList .model-check-item[data-status="enabled"]').length;
    const disabledCount = document.querySelectorAll('#fetchedModelsList .model-check-item[data-status="disabled"]').length;
    const staleCount = document.querySelectorAll('#fetchedModelsList .model-check-item[data-status="stale"]').length;
    const newCount = document.querySelectorAll('#fetchedModelsList .model-check-item[data-status="new"]').length;
    let label = '';
    if (filter === 'enabled') label = `${t('已启用')}${enabledCount}${t('个')}`;
    else if (filter === 'disabled') label = `${t('未启用')}${disabledCount}${t('个')}`;
    else if (filter === 'stale') label = `${t('已失效')}${staleCount}${t('个')}`;
    else label = `${t('共')}${enabledCount + disabledCount + staleCount + newCount}${t('个（已启用')}${enabledCount}${t('，未启用')}${disabledCount}${t('，新模型')}${newCount}${staleCount > 0 ? `${t('，已失效')} ${staleCount}` : ''}）`;
    if (keyword) label += `${t('，匹配')}${visibleCount}${t('个')}`;
    document.getElementById('fetchedModelsCount').textContent = label;
  }

  filterFetchedModels() {
    this._applyFetchedModelsFilter();
  }

  toggleSelectAllFetchedModels(checked) {
    const filter = this.fetchedModelsFilter || 'all';
    const items = document.querySelectorAll('#fetchedModelsList .model-check-item');
    items.forEach(item => {
      if (item.style.display !== 'none') {
        const cb = item.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = checked;
      }
    });
    this.updateFetchedModelsCount();
  }

  updateFetchedModelsCount() {
    const checked = document.querySelectorAll('#fetchedModelsList input[type="checkbox"]:checked').length;
    const total = document.querySelectorAll('#fetchedModelsList input[type="checkbox"]').length;
    document.getElementById('selectAllFetchedModels').checked = checked > 0 && checked === total;
  }

  async saveFetchedModels() {
    const providerId = this.currentFetchProviderId;
    const checkboxes = document.querySelectorAll('#fetchedModelsList input[type="checkbox"]');
    const enabledModelIds = [];
    checkboxes.forEach(cb => {
      if (cb.checked) {
        enabledModelIds.push(cb.value);
      }
    });

    if (enabledModelIds.length === 0) {
      const ok = await Dialog.confirm(
        t('禁用全部模型？'),
         t('当前') + '<strong>' + t('没有任何模型被勾选') + '</strong>' + t('。保存后将') + '<strong style="color:var(--destructive);">' + t('禁用该供应商下所有已有模型') + '</strong>' + t('。确定继续吗？') + ',',
        { confirmText: t('确认禁用全部'), danger: true }
      );
      if (!ok) return;
    }

    // 禁用按钮防止重复提交
    const saveBtn = document.getElementById('saveFetchedModelsBtn');
    if (saveBtn) {
      setButtonLoading(saveBtn, t('保存中...'));
    }

    try {
      const response = await fetch(`/api/admin/providers/${providerId}/sync-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModelIds })
      });

      if (response.ok) {
        const result = await response.json();
        const parts = [];
        if (result.added > 0) parts.push(`${t('新增')}${result.added}${t('个')}`);
        if (result.enabled > 0) parts.push(`${t('启用')}${result.enabled}${t('个')}`);
        if (result.disabled > 0) parts.push(`${t('禁用')}${result.disabled}${t('个')}`);
        this.showToast(t('保存成功：') + (parts.join('，') || t('无变化')), 'success');
        this.closeModals();
        // 模型目录变更：使 Team 模型权限等跨页缓存失效并尽量即时刷新
        this._invalidateAdminProviderModelsCache();
        this._notifyModelsCatalogChanged();
        this.loadModels();
        if (typeof this.loadProviders === 'function' && this.currentPage === 'adminProviders') {
          this.loadProviders({ resetPage: false }).catch(() => {});
        }
      } else {
        const err = await response.json().catch(() => ({}));
        this.showToast(err.error || t('保存失败'), 'error');
      }
    } catch (error) {
      console.error(t('保存模型失败:'), error);
      this.showToast(t('保存失败: ') + error.message, 'error');
    } finally {
      if (saveBtn) {
        clearButtonLoading(saveBtn, t('保存'));
      }
    }
  }

  // 查询供应商额度
  async checkProviderQuota(providerId) {
    this._quotaProviderId = providerId;
    const quotaButton = document.getElementById(`quota-btn-${providerId}`);
    const previousQuotaButtonHtml = quotaButton?.innerHTML;
    if (quotaButton) {
      quotaButton.disabled = true;
      setHTML(quotaButton, inlineLoadingHtml(t('查询中...'), 'sm'));
    }
    const modal = document.getElementById('providerQuotaModal');
    const loading = document.getElementById('quotaLoading');
    const error = document.getElementById('quotaError');
    const content = document.getElementById('quotaContent');
    const editor = document.getElementById('quotaScriptEditor');

    loading.style.display = 'block';
    document.getElementById('quotaLoadingText').textContent = t('正在查询供应商额度，请稍候...');
    error.style.display = 'none';
    content.style.display = 'none';
    editor.style.display = 'none';
    modal.style.display = 'flex';
    modal.classList.add('active');

    // 切换按钮：显示结果模式
    document.getElementById('quotaEditBtn').style.display = '';
        document.getElementById('quotaSaveBtn').style.display = 'none';
    document.getElementById('quotaCancelEditBtn').style.display = 'none';

    try {
      const response = await fetch(`/api/admin/providers/${providerId}/check-quota`);
      const data = await response.json();

      loading.style.display = 'none';

      if (!response.ok) {
        error.style.display = 'block';
        error.textContent = data.error || t('查询失败');
        error.style.whiteSpace = 'pre-wrap';
        return;
      }

      // 显示结果
      const q = data.quota;
      const isGrok = q.providerType === 'grok' || q.planName?.toLowerCase().includes('grok');
      const currentPercent = Number(q.currentPercent ?? q.periods?.find(period => period.key === 'current_period')?.percent);
      const hasCurrentPercent = isGrok && Number.isFinite(currentPercent);
      const total = parseFloat(q.total) || 0;
      const used = parseFloat(q.used) || 0;
      const remaining = parseFloat(q.remaining) || 0;
      const pct = hasCurrentPercent
        ? Math.round(currentPercent)
        : (total > 0 ? Math.round(used / total * 100) : 0);

      document.getElementById('quotaProviderName').textContent = data.provider.name;
      document.getElementById('quotaPlanName').textContent = q.planName || data.provider.name;
      const periods = Array.isArray(q.periods) ? q.periods : [];
      const credits = q.credits || {};
      const resetCredits = q.rateLimitResetCredits?.available_count;
      const detailParts = periods.map(period => `${period.label || period.key}: ${period.percent}%${period.resetsAt ? `${t('，重置于')} ${period.resetsAt}` : ''}${period.resetAfterSeconds > 0 ? `${t('（约')} ${Math.ceil(period.resetAfterSeconds / 3600)} ${t('小时后）')}` : ''}`);
      if (credits.hasCredits || credits.unlimited || credits.balance !== undefined) {
        detailParts.push(`Credits: ${credits.unlimited ? t('无限') : credits.balance ?? '0'}`);
      }
      if (resetCredits !== undefined) detailParts.push(`${t('可手动重置:')}${resetCredits}${t('次')}`);
      document.getElementById('quotaExtra').textContent = detailParts.length ? detailParts.join(' | ') : (q.extra || '');

      this.renderGrokQuotaDetails(q, isGrok);

      document.getElementById('quotaTotal').textContent = q.total;
      document.getElementById('quotaUsed').textContent = q.used;
      document.getElementById('quotaRemaining').textContent = q.remaining;

      const bar = document.getElementById('quotaBar');
      bar.style.width = `${Math.min(pct, 100)}%`;

      // 根据使用率设置颜色
      if (pct >= 90) {
        bar.style.background = 'var(--destructive, var(--danger))';
      } else if (pct >= 70) {
        bar.style.background = 'var(--warning)';
      } else {
        bar.style.background = 'var(--brand-blue, #1456f0)';
      }

      document.getElementById('quotaPct').textContent = `${pct}%`;
      const periodDetails = document.getElementById('quotaPeriodDetails');
      if (periodDetails) {
        setHTML(periodDetails, periods.map(period => `
          <div style="padding:10px 12px;background:var(--muted);border-radius:8px;">
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;font-weight:600;">
              <span>${escapeHtml(period.label || period.key)}</span><span>${escapeHtml(String(period.percent))}%</span>
            </div>
            ${period.startsAt ? `${'<div style="margin-top:4px;font-size:11px;color:var(--muted-foreground);">' + t('周期：')}${escapeHtml(period.startsAt)}${t('至')}${escapeHtml(period.resetsAt || t('未知'))}</div>` : (period.resetsAt ? `${'<div style="margin-top:4px;font-size:11px;color:var(--muted-foreground);">' + t('重置于')}${escapeHtml(period.resetsAt)}</div>` : '')}
            ${period.resetAfterSeconds > 0 ? `${'<div style="margin-top:2px;font-size:11px;color:var(--muted-foreground);">' + t('约')}${escapeHtml(String(Math.ceil(period.resetAfterSeconds / 3600)))}${t('小时后重置')}</div>` : ''}
          </div>`).join(''));
      }
      const creditsDetails = document.getElementById('quotaCreditsDetails');
      if (creditsDetails) {
        const resetCount = q.rateLimitResetCredits?.available_count;
        setHTML(creditsDetails, `<div>Credits：${escapeHtml(credits.unlimited ? t('无限') : String(credits.balance ?? '0'))}</div>${resetCount !== undefined ? `<div>${t('可手动重置：')}${escapeHtml(String(resetCount))} ${t('次')}</div>` : ''}`);
      }
      content.style.display = 'block';
    } catch (err) {
      loading.style.display = 'none';
      error.style.display = 'block';
      error.textContent = t('网络错误: ') + err.message;
    } finally {
      if (quotaButton) {
        quotaButton.disabled = false;
        setHTML(quotaButton, previousQuotaButtonHtml || t('查询额度'));
      }
    }
  }

  renderGrokQuotaDetails(q, isGrok) {
    const billing = document.getElementById('quotaBillingDetails');
    const products = document.getElementById('quotaProductDetails');
    const history = document.getElementById('quotaHistoryDetails');
    [billing, products, history].forEach(el => { if (el) { el.style.display = 'none'; setHTML(el, ''); } });
    if (!isGrok) return;

    const card = (label, value, hint = '') => `<div style="padding:12px;background:var(--muted);border-radius:10px;min-width:140px;flex:1;"><div style="font-size:11px;color:var(--muted-foreground);margin-bottom:5px;">${escapeHtml(label)}</div><div style="font-size:16px;font-weight:600;">${escapeHtml(String(value))}</div>${hint ? `<div style="font-size:11px;color:var(--muted-foreground);margin-top:4px;">${escapeHtml(hint)}</div>` : ''}</div>`;
    const formatNumber = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '-';
    const current = q.currentPeriod || {};
    if (billing) {
      billing.style.display = 'block';
      setHTML(billing, `<div style="font-size:13px;font-weight:600;margin-bottom:8px;">${t('SuperGrok 计费信息')}</div><div style="display:flex;gap:8px;flex-wrap:wrap;">${card(t('当前周期'), current.label || current.type || t('当前周期'), current.startsAt && current.resetsAt ? `${current.startsAt} ${t('至')} ${current.resetsAt}` : '')}${card(t('按需额度上限'), formatNumber(q.onDemandCap), 'onDemandCap')}${card(t('按需已使用'), formatNumber(q.onDemandUsed), `剩余 ${formatNumber(q.onDemandRemaining)}`)}${card('Prepaid Credits', formatNumber(q.prepaidBalance), q.isUnifiedBillingUser ? t('统一周池计费') : t('额外购买余额'))}${q.monthlyLimit ? card(t('旧版月额度'), formatNumber(q.monthlyLimit), `已使用 ${formatNumber(q.monthlyUsed)} 美分`) : ''}</div>`);
    }

    const productPeriods = (q.periods || []).filter(period => !period.historical && period.key !== 'current_period');
    if (products && productPeriods.length) {
      products.style.display = 'block';
      setHTML(products, `<div style="font-size:13px;font-weight:600;margin-bottom:8px;">${t('按产品用量')}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;">${productPeriods.map(period => `<div style="padding:10px 12px;background:var(--muted);border-radius:8px;"><div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;"><span>${escapeHtml(period.label || period.key)}</span><span>${escapeHtml(String(period.percent))}%</span></div><div style="height:5px;background:var(--border);border-radius:4px;overflow:hidden;margin-top:8px;"><div style="height:100%;width:${Math.min(100, Math.max(0, Number(period.percent) || 0))}%;background:var(--brand-blue);border-radius:4px;"></div></div></div>`).join('')}</div>`);
    }

    const historyPeriods = (q.periods || []).filter(period => period.historical);
    if (history && historyPeriods.length) {
      const formatCents = cents => Number.isFinite(Number(cents)) ? `$${(Number(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-';
      history.style.display = 'block';
      setHTML(history, `<div style="font-size:13px;font-weight:600;margin-bottom:8px;">${t('历史周期')}</div><div style="overflow:auto;"><table style="width:100%;font-size:12px;"><thead><tr><th style="text-align:left;padding:6px 8px;">周期</th><th style="text-align:right;padding:6px 8px;">使用率</th><th style="text-align:right;padding:6px 8px;">用量</th><th style="text-align:right;padding:6px 8px;">时间</th></tr></thead><tbody>${historyPeriods.map(period => { const percent = Number.isFinite(Number(period.percent)) ? `${Number(period.percent)}%` : '-'; const amount = period.amountCents ? formatCents(period.amountCents.total) : '-'; return `<tr><td style="padding:6px 8px;">${escapeHtml(period.label || period.key)}</td><td style="padding:6px 8px;text-align:right;">${escapeHtml(percent)}</td><td style="padding:6px 8px;text-align:right;">${escapeHtml(amount)}</td><td style="padding:6px 8px;text-align:right;color:var(--muted-foreground);">${escapeHtml([period.startsAt, period.resetsAt].filter(Boolean).join(t(' 至 ')) || '-')}</td></tr>`; }).join('')}</tbody></table></div>`);
    }
  }

  // 打开脚本编辑器
  async editQuotaScript() {
    const providerId = this._quotaProviderId;
    if (!providerId) return;

    const content = document.getElementById('quotaContent');
    const editor = document.getElementById('quotaScriptEditor');
    const textarea = document.getElementById('quotaScriptText');

    content.style.display = 'none';
    editor.style.display = 'block';
    textarea.value = t('加载中...');

    // 切换按钮：显示编辑模式
    document.getElementById('quotaEditBtn').style.display = 'none';
        document.getElementById('quotaSaveBtn').style.display = '';
    document.getElementById('quotaCancelEditBtn').style.display = '';

    try {
      const res = await fetch(`/api/admin/providers/${providerId}/default-quota-script`);
      const data = await res.json();
      textarea.value = data.script || '';
    } catch (e) {
      textarea.value = '// 获取默认脚本失败: ' + e.message;
    }
  }

  // 保存自定义脚本
  async saveQuotaScript() {
    const providerId = this._quotaProviderId;
    if (!providerId) return;

    const textarea = document.getElementById('quotaScriptText');
    const script = textarea.value.trim();

    try {
      const res = await fetch(`/api/admin/providers/${providerId}/quota-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script })
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || t('保存失败'));
        return;
      }

      // 保存成功，重新查询
      this.checkProviderQuota(providerId);
    } catch (e) {
      alert(t('保存失败: ') + e.message);
    }
  }

  // 重置为默认脚本
  async resetQuotaScript() {
    const providerId = this._quotaProviderId;
    if (!providerId) return;

    try {
      await fetch(`/api/admin/providers/${providerId}/quota-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: '' })
      });
      // 重新加载默认脚本
      this.editQuotaScript();
    } catch (e) {
      alert(t('重置失败: ') + e.message);
    }
  }

  toggleArkQuotaConfig() {
    const mode = document.getElementById('providerQuotaMode')?.value;
    const section = document.getElementById('arkQuotaConfigSection');
    if (section) section.style.display = mode === 'ark_inference' || mode === 'ark_afp' ? 'block' : 'none';
  }

  toggleCodexQuotaImport() {
    const mode = document.getElementById('providerQuotaMode')?.value;
    const section = document.getElementById('codexQuotaImportSection');
    const hint = document.getElementById('providerQuotaModeHint');
    const label = document.getElementById('providerQuotaAuthLabel');
    const authHint = document.getElementById('providerQuotaAuthHint');
    const textarea = document.getElementById('providerCodexConfigText');
    const isCodex = mode === 'codex_wham';
    const isGrok = mode === 'grok_billing';
    if (section) section.style.display = isCodex || isGrok ? 'block' : 'none';
    if (hint) hint.textContent = isGrok
      ? t('SuperGrok 使用 ~/.grok/auth.json 查询订阅周池、按需额度和 prepaid credits，接口为非公开接口，字段可能变化')
      : t('Codex WHAM 使用导入的 OAuth Token 查询 ChatGPT Codex 的 5 小时与 7 天窗口，接口为非公开接口，字段可能变化');
    if (label) label.textContent = isGrok ? 'SuperGrok auth.json' : 'Codex auth.json';
    if (authHint) authHint.innerHTML = isGrok
      ? t('文件通常位于') + ' <code>~/.grok/auth.json</code>' + t('，即 Linux/macOS 下的') + '<code>' + t('/home/你的用户名/.grok/auth.json') + '</code>' + t('。Token 会保存到当前供应商，请勿上传给第三方。')
      : t('文件通常位于') + ' <code>~/.codex/auth.json</code>' + t('，即 Linux/macOS 下的') + '<code>' + t('/home/你的用户名/.codex/auth.json') + '</code>' + t('。Token 会保存到当前供应商，请勿上传给第三方。');
    if (textarea) textarea.placeholder = isGrok ? '{"access_token":"...","user_id":"..."}' : '{"tokens":{"access_token":"...","refresh_token":"..."}}';
  }

  toggleQuotaScheduleFields() {
    const quotaOn = document.getElementById('providerQuotaEnabled')?.value === 'true';
    const scheduleOn = document.getElementById('providerQuotaScheduleEnabled')?.value === 'true';
    const scheduleGroup = document.getElementById('providerQuotaScheduleGroup');
    const intervalGroup = document.getElementById('providerQuotaScheduleIntervalGroup');
    const meta = document.getElementById('providerQuotaScheduleMeta');
    if (scheduleGroup) scheduleGroup.style.display = quotaOn ? 'block' : 'none';
    if (intervalGroup) intervalGroup.style.display = quotaOn && scheduleOn ? 'block' : 'none';
    if (meta) meta.style.display = quotaOn && meta.dataset.hasMeta === '1' ? 'block' : 'none';
  }

  _setProviderQuotaScheduleMeta(provider) {
    const meta = document.getElementById('providerQuotaScheduleMeta');
    if (!meta) return;
    if (!provider || !provider.quota_last_checked_at) {
      meta.textContent = '';
      meta.dataset.hasMeta = '';
      meta.style.display = 'none';
      return;
    }
    const checkedAt = new Date(provider.quota_last_checked_at);
    const timeText = Number.isNaN(checkedAt.getTime())
      ? String(provider.quota_last_checked_at)
      : checkedAt.toLocaleString('zh-CN');
    if (provider.quota_last_ok) {
      const remaining = provider.quota_last_result?.remaining;
      meta.textContent = remaining != null
        ? `${t('上次定时查询：')}${timeText}${t('，剩余')}${remaining}`
        : `${t('上次定时查询：')}${timeText}${t('，成功')}`;
    } else {
      meta.textContent = `${t('上次定时查询：')}${timeText}${t('，失败')}${provider.quota_last_error ? ' — ' + provider.quota_last_error : ''}`;
    }
    meta.dataset.hasMeta = '1';
  }

  handleProviderCodexConfigFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { document.getElementById('providerCodexConfigText').value = e.target.result; };
    reader.readAsText(file);
  }

  async bindCodexQuotaToProvider() {
    const providerId = document.getElementById('providerId')?.value.trim();
    const text = document.getElementById('providerCodexConfigText')?.value.trim();
    const mode = document.getElementById('providerQuotaMode')?.value;
    const isGrok = mode === 'grok_billing';
    if (!providerId) { alert(`${t('请先保存供应商，再绑定')}${isGrok ? 'SuperGrok' : 'Codex'} OAuth`); return; }
    if (!text) { alert(t('请输入或上传 auth.json')); return; }
    let config;
    try { config = JSON.parse(text); } catch (error) { alert(t('JSON 格式错误: ') + error.message); return; }
    try {
      const response = await fetch(isGrok ? '/api/admin/import-grok' : '/api/admin/import-codex', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, config })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { alert(result.error || t('绑定失败')); return; }
      alert(`${isGrok ? 'SuperGrok' : 'Codex'}${t('OAuth 已绑定到当前供应商')}`);
      document.getElementById('providerCodexConfigText').value = '';
      document.getElementById('providerCodexConfigFile').value = '';
    } catch (error) { alert(t('绑定失败: ') + error.message); }
  }

  // OpenCode 配置导入
  showImportOpenCodeModal() {
    document.getElementById('openCodeConfigText').value = '';
    document.getElementById('openCodeConfigFile').value = '';
    document.getElementById('importPreview').style.display = 'none';
    clearChildren(document.getElementById('importPreviewContent'));
    
    document.getElementById('importOpenCodeModal').style.display = 'flex';
    document.getElementById('importOpenCodeModal').classList.add('active');
  }

  handleConfigFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      document.getElementById('openCodeConfigText').value = content;
      this.previewConfig(content);
    };
    reader.readAsText(file);
  }

  previewConfig(content) {
    try {
      const config = JSON.parse(content);
      const preview = document.getElementById('importPreview');
      const previewContent = document.getElementById('importPreviewContent');
      
      let html = '';
      
      // Claude Code 格式（有 env 字段）
      if (config.env && typeof config.env === 'object') {
        const env = config.env;
        const key = env.ANTHROPIC_AUTH_TOKEN;
        const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
        
        html += `<p style="color: var(--foreground); margin-bottom: 8px;"><strong>${t('Claude Code 配置')}</strong></p>`;
        html += `<div style="margin-left: 12px; margin-bottom: 4px;">
          <span style="color: var(--success);">anthropic</span>
          <span style="color: var(--muted-foreground);"> — ${baseUrl}</span>
          ${key ? `<span style="color: var(--success);"> (${key.substring(0, 8)}****)</span>` : '<span style="color: var(--destructive);">' + t('(无 Key)') + '</span>'}
        </div>`;
        
        // 显示模型
        const modelKeys = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
        const modelNames = [t('默认'), 'Haiku', 'Sonnet', 'Opus'];
        for (let i = 0; i < modelKeys.length; i++) {
          const modelId = env[modelKeys[i]];
          if (modelId) {
            html += `<div style="margin-left: 24px; color: var(--muted-foreground); font-size: 12px;">→ ${modelId} (${modelNames[i]})</div>`;
          }
        }
      } else {
        // OpenCode auth.json 格式
        html += '<p style="color: var(--foreground); margin-bottom: 8px;"><strong>OpenCode auth.json</strong></p>';
        let count = 0;
        for (const [id, entry] of Object.entries(config)) {
          if (entry && entry.key) {
            const masked = entry.key.substring(0, 8) + '****';
            html += `<div style="margin-left: 12px; margin-bottom: 4px;">
              <span style="color: var(--success);">${id}</span>
              <span style="color: var(--muted-foreground);"> — ${masked}</span>
            </div>`;
            count++;
          }
        }
        if (count === 0) {
          html += '<p style="color: var(--muted-foreground); margin-left: 12px;">' + t('未找到有效的 API Key') + '</p>';
        }
      }
      
      setHTML(previewContent, html);
      preview.style.display = 'block';
    } catch (error) {
      document.getElementById('importPreview').style.display = 'none';
    }
  }

  async importOpenCodeConfig() {
    const providerName = document.getElementById('importProviderName').value.trim();
    const text = document.getElementById('openCodeConfigText').value.trim();

    if (!providerName) { alert(t('请输入供应商名称')); return; }
    if (!text) { alert(t('请输入或上传配置内容')); return; }

    let config;
    try {
      config = JSON.parse(text);
    } catch (error) {
      alert(t('JSON 格式错误: ') + error.message);
      return;
    }

    // 验证格式
    const isClaudeCode = config.env && typeof config.env === 'object';
    const isOpenCode = Object.values(config).some(e => e && e.key);

    if (!isClaudeCode && !isOpenCode) {
      alert(t('未识别的配置格式'));
      return;
    }

    try {
      const response = await fetch('/api/admin/import-opencode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerName, config })
      });

      if (response.ok) {
        const result = await response.json();
        const { created, updated, models } = result.imported;
        let msg = `${t('导入成功!')}`;
        if (created > 0) msg += `${t('\\n新增:')}${created}${t('个供应商')}`;
        if (updated > 0) msg += `${t('\\n更新:')}${updated}${t('个供应商')}`;
        if (models > 0) msg += `${t('\\n模型:')}${models}${t('个')}`;
        alert(msg);
        this.closeModals();
        this.loadProviders();
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || t('导入失败'));
      }
    } catch (error) {
      console.error(t('导入 OpenCode 配置失败:'), error);
      alert(t('导入失败'));
    }
  }

  _multiStatsFiltersLoaded = false;
  _multiStatsData = null;

  async loadMultiStatsFilters() {
    if (this._multiStatsFiltersLoaded) return;
    const res = await fetch('/api/admin/stats/multi/filters');
    if (!res.ok) throw new Error(t('多维统计筛选项加载失败'));
    const data = await res.json();
    const configs = [
      ['multiStatsUser', data.users, t('全部成员')], ['multiStatsTeam', data.teams, t('全部 Team')],
      ['multiStatsGroup', data.groups, t('全部用户组')], ['multiStatsModel', data.models, t('全部模型')],
      ['multiStatsProvider', data.providers, t('全部供应商')], ['multiStatsSource', data.sources, t('全部客户端')],
      ['multiStatsProject', data.projects, t('全部项目')]
    ];
    configs.forEach(([id, rows, placeholder]) => {
      const el = document.getElementById(id);
      if (!el) return;
      setHTML(el, `<option value="">${placeholder}</option>${(rows || []).map(row => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name || row.id)}</option>`).join('')}`);
    });
    this._multiStatsFiltersLoaded = true;
  }

  _multiStatsParams() {
    const params = new URLSearchParams({ days: document.getElementById('adminStatsDays')?.value || '30' });
    [['user_id', 'multiStatsUser'], ['team_id', 'multiStatsTeam'], ['group_id', 'multiStatsGroup'], ['model_id', 'multiStatsModel'], ['provider_id', 'multiStatsProvider'], ['request_source', 'multiStatsSource'], ['workspace_path', 'multiStatsProject']].forEach(([key, id]) => {
      const value = document.getElementById(id)?.value || '';
      if (value) params.set(key, value);
    });
    return params;
  }

  async loadMultiStats() {
    const seq = (this._multiStatsLoadSeq = (this._multiStatsLoadSeq || 0) + 1);
    try {
      await this.loadMultiStatsFilters();
      const res = await fetch(`/api/admin/stats/multi?${this._multiStatsParams()}`);
      if (!res.ok) throw new Error(t('多维统计加载失败'));
      const data = await res.json();
      if (seq !== this._multiStatsLoadSeq) return;
      this._multiStatsData = data;
      this.renderMultiStats();
    } catch (error) {
      if (seq !== this._multiStatsLoadSeq) return;
      const el = document.getElementById('adminStatsMultiSummary');
      if (el) setHTML(el, `<p style="color:var(--destructive);">${escapeHtml(error.message)}</p>`);
    }
  }

  resetMultiStatsFilters() {
    ['multiStatsUser', 'multiStatsTeam', 'multiStatsGroup', 'multiStatsModel', 'multiStatsProvider', 'multiStatsSource', 'multiStatsProject'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    this.loadMultiStats();
  }

  _multiStatsDrill(key, value) {
    const map = { user_id: 'multiStatsUser', team_id: 'multiStatsTeam', group_id: 'multiStatsGroup', model_id: 'multiStatsModel', provider_id: 'multiStatsProvider', request_source: 'multiStatsSource', workspace_path: 'multiStatsProject' };
    const el = document.getElementById(map[key]);
    if (el) { el.value = String(value); this.loadMultiStats(); }
  }

  renderMultiStats() {
    const data = this._multiStatsData;
    if (!data) return;
    const s = data.summary || {};
    const cards = [
      [t('总请求'), Number(s.requests || 0).toLocaleString()], [t('总 Token'), this._formatBigNumber(Number(s.tokens || 0))],
      [t('总积分'), Number(s.cost || 0).toFixed(4)], [t('活跃成员'), s.active_users || 0],
      [t('活跃项目'), s.active_projects || 0], [t('模型 / 供应商'), `${s.active_models || 0} / ${s.active_providers || 0}`],
      [t('客户端'), s.active_sources || 0], [t('平均延迟'), s.avg_latency == null ? '-' : `${Math.round(Number(s.avg_latency))}ms`]
    ];
    const summaryEl = document.getElementById('adminStatsMultiSummary');
    if (summaryEl) setHTML(summaryEl, cards.map(([label, value]) => `<div class="stats-overview-card" style="background:linear-gradient(135deg,#0f766e,#115e59);"><div class="stats-overview-content"><span class="stats-overview-label">${label}</span><span class="stats-overview-value">${value}</span></div></div>`).join(''));
    this.renderMultiStatsChart(data.dimensions || {});
    const relation = data.relationships || {};
    const relationLabel = (item) => `${escapeHtml(item.left || t('未知'))} → ${escapeHtml(item.right || t('未知'))} <strong>${Number(item.requests || 0).toLocaleString()}</strong>`;
    const list = (items, empty = t('暂无关联数据')) => items?.length ? `<div class="stats-relation-items">${items.slice(0, 8).map(item => `<div class="stats-relation-item"><span>${relationLabel(item)}</span><b>${this._formatBigNumber(Number(item.tokens || 0))} Token</b></div>`).join('')}</div>` : `<p class="stats-insight-empty">${empty}</p>`;
    setHTML(document.getElementById('adminStatsRelationOverview'), list(relation.user_project, {}));
    setHTML(document.getElementById('adminStatsUserModel'), list(relation.user_model));
    setHTML(document.getElementById('adminStatsOrgMember'), list(relation.team_model));
    setHTML(document.getElementById('adminStatsProjectSource'), list(relation.project_source));
    setHTML(document.getElementById('adminStatsModelProvider'), list(relation.model_provider));
    const caveats = document.getElementById('adminStatsMultiCaveats');
    if (caveats) caveats.textContent = (data.caveats || []).join(' ');
    this.renderMultiStatsTable(data.combinations || []);
  }

  renderMultiStatsChart(dimensions) {
    if (typeof Chart === 'undefined') return;
    const rows = (dimensions.models || []).slice(0, 20);
    const labels = rows.map(row => row.name || t('未知模型'));
    const values = rows.map(row => Number(row.requests || 0));
    const style = getComputedStyle(document.documentElement);
    const textSecondary = style.getPropertyValue('--muted-foreground').trim() || '#94a3b8';
    this._upsertChart('_multiDimensionChart', document.getElementById('multiDimensionChart'), 'bar', {
      labels,
      datasets: [{ label: t('请求数'), data: values, backgroundColor: '#14b8a6', borderRadius: 6, barThickness: 16 }]
    }, {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { color: textSecondary } },
        y: { ticks: { color: textSecondary, autoSkip: false, font: { size: 11 } }, grid: { display: false } }
      }
    });
  }

  renderMultiStatsTable(rows) {
    const el = document.getElementById('adminStatsCombinationTable');
    if (!el) return;
    if (!rows.length) { setHTML(el, '<p class="stats-insight-empty">' + t('当前筛选条件下暂无组合数据') + '</p>'); return; }
    const sourceLabel = (source) => this._usageRequestSourceMeta(source).label;
    setHTML(el, `<div style="overflow:auto;"><table><thead><tr><th>${t('成员')}</th><th>Team</th><th>用户组</th><th>项目</th><th>客户端</th><th>模型</th><th>供应商</th><th>请求</th><th>Token</th><th>积分</th><th>平均延迟</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.user_name || t('未知成员'))}</td><td>${escapeHtml(row.team_name || t('未分配 Team'))}</td><td>${escapeHtml(row.group_name || t('未分配用户组'))}</td><td>${escapeHtml(row.workspace_path === '__unknown__' ? t('未识别项目') : (row.workspace_path || t('未识别项目')))}</td><td>${escapeHtml(sourceLabel(row.request_source))}</td><td>${escapeHtml(row.model_name || t('未知模型'))}</td><td>${escapeHtml(row.provider_name || t('未知供应商'))}</td><td>${Number(row.requests || 0).toLocaleString()}</td><td title="${Number(row.tokens || 0).toLocaleString()}">${this._formatBigNumber(Number(row.tokens || 0))}</td><td>${Number(row.cost || 0).toFixed(4)}</td><td>${row.avg_latency == null ? '-' : `${Math.round(Number(row.avg_latency))}ms`}</td></tr>`).join('')}</tbody></table></div>`);
  }

  async loadStats() {
    // 防止 3s 轮询与手动切换叠加时的乱序覆盖
    const seq = (this._statsLoadSeq = (this._statsLoadSeq || 0) + 1);
    try {
      const days = document.getElementById('adminStatsDays')?.value || '30';
      const response = await fetch(`/api/admin/stats?days=${encodeURIComponent(days)}`);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || t('加载失败'));
      }
      if (seq !== this._statsLoadSeq) return; // 过期响应丢弃
      this.stats = await response.json();
      
      this.renderStatsOverview();
      this.renderCharts();
      this.renderDailyBarCharts();
      this.renderModelCharts();
      this.renderProviderCharts();
      this.renderSourceCharts();
      this.renderMemberStatsCharts();
      this.renderMemberStatsTables();
      
      const container = document.getElementById('detailedStats');
      if (!container) return;
      if (!this.stats.daily || this.stats.daily.length === 0) {
        setHTML(container, '<p style="text-align: center; color: var(--muted-foreground); padding: 20px;">' + t('暂无使用数据') + '</p>');
        this._statsDailyTableSig = '';
        this.renderModelStatsTable();
        this.renderProviderStatsTable();
        this.renderSourceStatsTable();
        this.renderSourceModelStatsTable();
        this.renderMemberStatsCharts();
        this.renderMemberStatsTables();
        return;
      }

      // 表格内容未变时不重写 DOM，避免滚动位置跳动
      const tableSig = JSON.stringify(this.stats.daily.map(u => [
        u.date, u.requests, u.tokens, u.cached_tokens, u.cost
      ]));
      if (tableSig !== this._statsDailyTableSig) {
        this._statsDailyTableSig = tableSig;
        setHTML(container, `
          <div style="background:var(--muted);border-radius:12px;padding:20px;">
            <h3 style="margin:0 0 16px 0;font-size:14px;">每日详细统计</h3>
            <div style="overflow-x:auto;">
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>请求数</th>
                    <th>Token使用量</th>
                    <th>缓存命中</th>
                    <th>积分</th>
                    <th>平均Token/请求</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.stats.daily.map(usage => {
                    const avgTokens = usage.requests > 0 ? Math.round(usage.tokens / usage.requests) : 0;
                    const cachedTokens = parseInt(usage.cached_tokens || 0);
                    const totalTokens = parseInt(usage.tokens || 0);
                    const cacheRate = totalTokens > 0 ? (cachedTokens / totalTokens * 100).toFixed(1) : '0.0';
                    const cacheDisplay = cachedTokens > 0
                      ? `<span style="color:var(--success);" title="${cachedTokens.toLocaleString()}">${this._formatBigNumber(cachedTokens)}</span> <span style="font-size:11px;color:var(--muted-foreground);">(${cacheRate}%)</span>`
                      : '<span style="color:var(--muted-foreground);">-</span>';
                    return `
                    <tr>
                      <td>${new Date(usage.date).toLocaleDateString('zh-CN')}</td>
                      <td>${(usage.requests || 0).toLocaleString()}</td>
                      <td title="${Number(usage.tokens || 0).toLocaleString()}">${this._formatBigNumber(Number(usage.tokens || 0))}</td>
                      <td>${cacheDisplay}</td>
                      <td>¥${parseFloat(usage.cost || 0).toFixed(4)}</td>
                      <td title="${avgTokens.toLocaleString()}">${this._formatBigNumber(avgTokens)}</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `);
      }

      this.renderModelStatsTable();
      this.renderProviderStatsTable();
      this.renderSourceStatsTable();
      this.renderSourceModelStatsTable();
    } catch (error) {
      if (seq !== this._statsLoadSeq) return;
      console.error(t('加载统计数据失败:'), error);
      const el = document.getElementById('detailedStats');
      if (el) setHTML(el, `<p style="text-align:center;color:var(--destructive);padding:20px;">${escapeHtml(error.message || t('加载统计数据失败'))}</p>`);
    }
  }

  renderStatsOverview() {
    if (!this.stats || !this.stats.daily) return;

    const daily = [...this.stats.daily].reverse();
    const totalRequests = daily.reduce((sum, d) => sum + parseInt(d.requests || 0, 10), 0);
    const totalTokens = daily.reduce((sum, d) => sum + parseInt(d.tokens || 0, 10), 0);
    const totalCost = daily.reduce((sum, d) => sum + parseFloat(d.cost || 0), 0);
    const dayCount = daily.length || 1;
    const activeModels = this.stats.byModel ? this.stats.byModel.length : 0;
    const activeProviders = this.stats.byProvider ? this.stats.byProvider.length : 0;

    document.getElementById('statsTotalRequests').textContent = totalRequests.toLocaleString();
    document.getElementById('statsTotalTokens').textContent = this._formatBigNumber(totalTokens);
    document.getElementById('statsTotalCost').textContent = totalCost.toFixed(2) + t(' 积分');
    document.getElementById('statsAvgDailyRequests').textContent = t('日均 ') + Math.round(totalRequests / dayCount).toLocaleString();
    document.getElementById('statsAvgDailyTokens').textContent = t('日均 ') + this._formatBigNumber(Math.round(totalTokens / dayCount));
    document.getElementById('statsAvgDailyCost').textContent = t('日均 ¥') + (totalCost / dayCount).toFixed(2);
    document.getElementById('statsActiveModels').textContent = activeModels;
    document.getElementById('statsTotalProviders').textContent = t('供应商 ') + activeProviders;

    const ss = this.stats.sourceSummary || {};
    const rateEl = document.getElementById('statsIdentifiedRate');
    const srcEl = document.getElementById('statsActiveSources');
    if (rateEl) rateEl.textContent = ((ss.identified_rate || 0) * 100).toFixed(1) + '%';
    if (srcEl) {
      srcEl.textContent = `${t('活跃')}${ss.active_sources || 0}${t('种 · 未知')}${(ss.unknown_requests || 0).toLocaleString()}${t('次')}`;
    }
    const sumCards = document.getElementById('adminSourceSummaryCards');
    if (sumCards) {
      setHTML(sumCards, `
        <div class="stats-overview-card" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);">
          <div class="stats-overview-content">
            <span class="stats-overview-label">识别率</span>
            <span class="stats-overview-value">${((ss.identified_rate || 0) * 100).toFixed(1)}%</span>
            <span class="stats-overview-sub">已知 ${(ss.known_requests || 0).toLocaleString()} / 共 ${(ss.total_requests || 0).toLocaleString()}</span>
          </div>
        </div>
        <div class="stats-overview-card" style="background:linear-gradient(135deg,#a855f7,#7c3aed);">
          <div class="stats-overview-content">
            <span class="stats-overview-label">活跃客户端</span>
            <span class="stats-overview-value">${ss.active_sources || 0}</span>
            <span class="stats-overview-sub">不含未知/其他</span>
          </div>
        </div>
        <div class="stats-overview-card" style="background:linear-gradient(135deg,#64748b,#475569);">
          <div class="stats-overview-content">
            <span class="stats-overview-label">未知请求</span>
            <span class="stats-overview-value">${(ss.unknown_requests || 0).toLocaleString()}</span>
            <span class="stats-overview-sub">历史或未识别</span>
          </div>
        </div>
      `);
    }

    const now = new Date();
    // 与后端一致：按 Asia/Shanghai 日历日匹配「今日/昨日」
    const shDay = (date) => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    const today = shDay(now);
    const yesterday = shDay(new Date(now.getTime() - 86400000));
    const todayData = daily.find(d => d.date === today);
    const yesterdayData = daily.find(d => d.date === yesterday);

    const todayReqs = todayData ? parseInt(todayData.requests || 0, 10) : 0;
    const todayToks = todayData ? parseInt(todayData.tokens || 0, 10) : 0;
    const todayCst = todayData ? parseFloat(todayData.cost || 0) : 0;
    const yestReqs = yesterdayData ? parseInt(yesterdayData.requests || 0, 10) : 0;
    const yestToks = yesterdayData ? parseInt(yesterdayData.tokens || 0, 10) : 0;
    const yestCst = yesterdayData ? parseFloat(yesterdayData.cost || 0) : 0;

    document.getElementById('todayRequests').textContent = todayReqs.toLocaleString();
    document.getElementById('todayTokens').textContent = this._formatBigNumber(todayToks);
    document.getElementById('todayCost').textContent = todayCst.toFixed(2) + t(' 积分');
    document.getElementById('yesterdayRequests').textContent = yestReqs.toLocaleString();
    document.getElementById('yesterdayTokens').textContent = this._formatBigNumber(yestToks);
    document.getElementById('yesterdayCost').textContent = yestCst.toFixed(2) + t(' 积分');

    // 计算趋势
    this._renderAdminTrend('todayRequestsTrend', todayReqs, yestReqs);
    this._renderAdminTrend('todayTokensTrend', todayToks, yestToks);
    this._renderAdminTrend('todayCostTrend', todayCst, yestCst);
  }

  _renderAdminTrend(elementId, current, previous) {
    const element = document.getElementById(elementId);
    if (!element) return;

    if (previous === 0) {
      setHTML(element, current > 0 ? '<span class="trend-up">' + t('新增') + '</span>' : '');
      return;
    }

    const change = ((current - previous) / previous * 100).toFixed(1);
    const isUp = current > previous;
    const isNeutral = current === previous;

    if (isNeutral) {
      setHTML(element, '<span class="trend-neutral">' + t('持平') + '</span>');
    } else {
      const arrow = isUp ? '↑' : '↓';
      const colorClass = isUp ? 'trend-up' : 'trend-down';
      setHTML(element, `<span class="${colorClass}">${arrow} ${Math.abs(change)}%</span>`);
    }
  }

  switchStatsTab(tab) {
    document.querySelectorAll('.stats-tab-bar button, .stats-tab').forEach(btn => {
      btn.classList.remove('active');
    });
    document.querySelectorAll('.stats-tab-content').forEach(content => {
      content.style.display = 'none';
    });

    const activeBtn = document.querySelector(`.stats-tab-bar button[onclick*="${tab}"], .stats-tab[onclick*="${tab}"]`);
    if (activeBtn) {
      activeBtn.classList.add('active');
    }

    const tabContent = document.getElementById('statsTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (tabContent) {
      tabContent.style.display = 'block';
    }

    if (tab === 'multi') {
      this.loadMultiStats();
    }
    if (tab === 'messages') {
      this.loadMessageStats();
    }
    if (tab === 'logs' && !this._usageLogsLoaded) {
      this.loadUsageLogs(1);
      this._usageLogsLoaded = true;
    }

    // 切换到供应商或组织分析 tab 时重新渲染图表（Chart.js 需要 canvas 可见才能正确计算尺寸）
    if (tab === 'members' && this.stats) {
      setTimeout(() => {
        this.renderMemberStatsCharts();
        this.renderMemberStatsTables();
      }, 50);
    }

    // 切换到供应商分析 tab 时重新渲染图表（Chart.js 需要 canvas 可见才能正确计算尺寸）
    if (tab === 'providers' && this.stats) {
      setTimeout(() => {
        this.renderProviderCharts();
        this.renderProviderStatsTable();
      }, 50);
    }
  }


  async loadMessageStats() {
    const summaryEl = document.getElementById('messageStatsSummary');
    const sourceEl = document.getElementById('messageStatsSourceTable');
    const blockEl = document.getElementById('messageStatsBlockTable');
    const workspaceEl = document.getElementById('messageStatsWorkspaceTable');
    const loading = pageLoadingHtml(t('正在读取项目活动...'), { compact: true });
    [summaryEl, sourceEl, blockEl, workspaceEl].forEach((el) => { if (el) setHTML(el, loading); });
    const days = document.getElementById('adminStatsDays')?.value || '30';
    const source = document.getElementById('messageStatsSourceFilter')?.value || '';
    const workspace = document.getElementById('messageStatsWorkspaceFilter')?.value || '';
    const block = document.getElementById('messageStatsBlockFilter')?.value || '';
    const params = new URLSearchParams({ days });
    if (source) params.set('request_source', source);
    if (workspace) params.set('workspace_path', workspace);
    if (block) params.set('block', block);
    try {
      const res = await fetch(`/api/admin/message-stats?${params}`);
      if (!res.ok) throw new Error(t('消息统计加载失败'));
      const data = await res.json();
      const s = data.summary || {};
      if (!data || data.error) throw new Error(data.error || t('消息统计返回数据为空'));
      if (!(data.by_workspace || []).length && !(data.daily || []).length) {
        const empty = '<div class="empty-state" style="padding:28px;text-align:center;color:var(--muted-foreground);">' + t('所选时间范围内暂无可分析的项目消息记录') + '</div>';
        [summaryEl, sourceEl, blockEl, workspaceEl].forEach((el) => { if (el) setHTML(el, empty); });
        return;
      }
      const card = (label, value) => `<div class="stats-overview-card" style="background:var(--muted);color:var(--foreground);"><div class="stats-overview-content"><span class="stats-overview-label">${label}</span><span class="stats-overview-value">${value}</span></div></div>`;
      const analysisStatus = s.analysis_status || {};
      const pendingLabel = analysisStatus.pending_requests ? card(t('后台待分析'), analysisStatus.pending_requests.toLocaleString()) : '';
      setHTML(document.getElementById('messageStatsSummary'), [card(t('活跃请求'), s.analyzed_requests || 0), card(t('活跃项目'), (data.by_workspace || []).length), card(t('活跃天数'), s.active_days || 0), card(t('日均请求'), Number(s.avg_daily_requests || 0).toFixed(1)), card(t('总 Token'), this._formatBigNumber(Number(s.total_tokens || 0))), card(t('Git 状态率'), `${((s.git_rate || 0) * 100).toFixed(1)}%`), pendingLabel].join(''));
      const table = (headers, rows) => `<div style="overflow:auto;"><table class="stats-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:18px;color:var(--muted-foreground);">' + t('暂无数据') + '</td></tr>'}</tbody></table></div>`;
      setHTML(document.getElementById('messageStatsSourceTable'), table(['Harness', t('请求数'), t('平均消息'), t('平均字符'), 'Token', t('Git率')], (data.by_source || []).map(r => { const n = Number(r.tokens || 0); return `<tr><td>${escapeHtml(r.request_source)}</td><td>${r.requests}</td><td>${(r.messages / Math.max(r.requests, 1)).toFixed(1)}</td><td>${Math.round(r.characters / Math.max(r.requests, 1)).toLocaleString()}</td><td title="${n.toLocaleString()}">${this._formatBigNumber(n)}</td><td>${(r.git_requests / Math.max(r.requests, 1) * 100).toFixed(1)}%</td></tr>`; }).join('')));
      setHTML(document.getElementById('messageStatsBlockTable'), table([t('区块'), t('请求数'), t('出现次数')], (data.by_block || []).map(r => `<tr><td><code>${escapeHtml(r.block)}</code></td><td>${r.requests}</td><td>${r.occurrences}</td></tr>`).join('')));
      setHTML(document.getElementById('messageStatsWorkspaceTable'), table([t('项目/工作区'), t('请求数'), 'Token', t('积分'), t('来源')], (data.by_workspace || []).map(r => { const n = Number(r.tokens || 0); return `<tr><td><code>${escapeHtml(r.workspace_path)}</code></td><td>${r.requests}</td><td title="${n.toLocaleString()}">${this._formatBigNumber(n)}</td><td>${Number(r.cost || 0).toFixed(4)}</td><td>${escapeHtml(Object.entries(r.sources || {}).map(([k, v]) => `${k}: ${v}`).join(', '))}</td></tr>`; }).join('')));
      if (typeof Chart !== 'undefined') {
        this._upsertChart('_messageStatsDailyChart', document.getElementById('messageStatsDailyChart'), 'line', { labels: (data.daily || []).map(r => r.date), datasets: [{ label: t('请求数'), data: (data.daily || []).map(r => r.requests), borderColor: 'var(--info)', backgroundColor: 'rgba(59,130,246,.15)', fill: true, tension: .25 }, { label: 'Token', data: (data.daily || []).map(r => r.tokens), borderColor: 'var(--purple)', backgroundColor: 'rgba(139,92,246,.08)', fill: false, tension: .25 }] }, { responsive: true, maintainAspectRatio: false });
      }
    } catch (error) {
      console.error(error);
      setHTML(document.getElementById('messageStatsSummary'), `<p style="color:var(--destructive);">${escapeHtml(error.message)}</p>`);
    }
  }

  /**
   * 创建或更新 Chart.js 实例。
   * 刷新时复用旧实例并 update()，从上一状态过渡到新数据，
   * 避免 destroy+new 导致每次从 0 重播入场动画。
   */
  _upsertChart(storeKey, canvasEl, type, data, options) {
    if (!canvasEl || typeof Chart === 'undefined') return null;
    const existing = this[storeKey];
    if (existing) {
      try {
        existing.data.labels = data.labels || [];
        const nextDatasets = data.datasets || [];
        // 同步 dataset 数量与数据
        while (existing.data.datasets.length < nextDatasets.length) {
          existing.data.datasets.push({ data: [] });
        }
        if (existing.data.datasets.length > nextDatasets.length) {
          existing.data.datasets.length = nextDatasets.length;
        }
        nextDatasets.forEach((ds, i) => {
          const cur = existing.data.datasets[i];
          cur.data = Array.isArray(ds.data) ? ds.data : [];
          if (ds.label != null) cur.label = ds.label;
          if (ds.borderColor != null) cur.borderColor = ds.borderColor;
          if (ds.backgroundColor != null) cur.backgroundColor = ds.backgroundColor;
          if (ds.fill != null) cur.fill = ds.fill;
          if (ds.tension != null) cur.tension = ds.tension;
          if (ds.pointRadius != null) cur.pointRadius = ds.pointRadius;
          if (ds.pointHoverRadius != null) cur.pointHoverRadius = ds.pointHoverRadius;
          if (ds.borderWidth != null) cur.borderWidth = ds.borderWidth;
          if (ds.borderRadius != null) cur.borderRadius = ds.borderRadius;
        });
        // 默认从旧值过渡到新值（非从 0 入场）
        existing.update();
        return existing;
      } catch (e) {
        console.warn(t('[Chart] update 失败，回退重建:'), e);
        try { existing.destroy(); } catch (_) {}
        this[storeKey] = null;
      }
    }
    this[storeKey] = new Chart(canvasEl, { type, data, options });
    return this[storeKey];
  }

  renderCharts() {
    if (!this.stats || !this.stats.daily || this.stats.daily.length === 0) return;
    if (typeof Chart === 'undefined') return;

    const usage = [...this.stats.daily].reverse();
    const labels = usage.map(u => new Date(u.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }));
    const requests = usage.map(u => parseInt(u.requests || 0, 10));
    const tokens = usage.map(u => parseInt(u.tokens || 0, 10));
    const costs = usage.map(u => parseFloat(u.cost || 0));
    const avgTokens = usage.map(u => {
      const req = parseInt(u.requests || 0, 10);
      const tok = parseInt(u.tokens || 0, 10);
      return req > 0 ? Math.round(tok / req) : 0;
    });
    const anomalyPoints = usage.map(u => u.suspected_compaction_boundary ? 6 : 0);

    const style = getComputedStyle(document.documentElement);
    const textSecondary = style.getPropertyValue('--muted-foreground').trim() || '#94a3b8';
    const borderSubtle = style.getPropertyValue('--border').trim() || 'rgba(148,163,184,0.1)';

    const commonOptions = () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { ticks: { color: textSecondary, font: { size: 10 }, maxTicksLimit: 15 }, grid: { display: false } },
        y: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { color: borderSubtle } }
      },
      interaction: { mode: 'nearest', axis: 'x', intersect: false }
    });

    this._upsertChart('_dailyChart', document.getElementById('dailyRequestsChart'), 'line', {
      labels,
      datasets: [{
        label: t('请求数'),
        data: requests,
        borderColor: 'var(--info)',
        backgroundColor: 'rgba(59,130,246,0.15)',
        fill: true,
        tension: 0.4,
        pointRadius: anomalyPoints,
        pointHoverRadius: 6,
        pointBackgroundColor: usage.map(u => u.suspected_compaction_boundary ? 'var(--danger)' : 'var(--info)'),
        pointBorderColor: usage.map(u => u.suspected_compaction_boundary ? 'var(--danger)' : 'var(--info)')
      }]
    }, commonOptions());

    this._upsertChart('_dailyTokensChart', document.getElementById('dailyTokensChart'), 'line', {
      labels,
      datasets: [{
        label: 'Token',
        data: tokens,
        borderColor: 'var(--purple)',
        backgroundColor: 'rgba(139,92,246,0.15)',
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      }]
    }, commonOptions());

    this._upsertChart('_dailyCostChart', document.getElementById('dailyCostChart'), 'line', {
      labels,
      datasets: [{
        label: t('积分'),
        data: costs,
        borderColor: 'var(--success)',
        backgroundColor: 'rgba(16,185,129,0.15)',
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      }]
    }, commonOptions());

    this._upsertChart('_dailyAvgChart', document.getElementById('dailyAvgTokensChart'), 'line', {
      labels,
      datasets: [{
        label: t('平均Token/请求'),
        data: avgTokens,
        borderColor: 'var(--warning)',
        backgroundColor: 'rgba(245,158,11,0.15)',
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6
      }]
    }, commonOptions());
  }

  renderDailyBarCharts() {
    if (!this.stats || !this.stats.daily || this.stats.daily.length === 0) return;
    if (typeof Chart === 'undefined') return;

    const usage = [...this.stats.daily].reverse();
    const labels = usage.map(u => new Date(u.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }));
    const requests = usage.map(u => parseInt(u.requests || 0, 10));
    const costs = usage.map(u => parseFloat(u.cost || 0));
    const anomalyPoints = usage.map(u => u.suspected_compaction_boundary ? 6 : 0);

    const style = getComputedStyle(document.documentElement);
    const textSecondary = style.getPropertyValue('--muted-foreground').trim() || '#94a3b8';
    const borderSubtle = style.getPropertyValue('--border').trim() || 'rgba(148,163,184,0.1)';

    const barOptions = () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textSecondary, font: { size: 10 }, maxTicksLimit: 15 }, grid: { display: false } },
        y: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { color: borderSubtle } }
      }
    });

    this._upsertChart('_barReqChart', document.getElementById('dailyBarRequestsChart'), 'bar', {
      labels,
      datasets: [{
        label: t('请求数'),
        data: requests,
        backgroundColor: 'rgba(59,130,246,0.7)',
        borderColor: 'var(--info)',
        borderWidth: 1,
        borderRadius: 4
      }]
    }, barOptions());

    this._upsertChart('_barCostChart', document.getElementById('dailyBarCostChart'), 'bar', {
      labels,
      datasets: [{
        label: t('积分'),
        data: costs,
        backgroundColor: 'rgba(16,185,129,0.7)',
        borderColor: 'var(--success)',
        borderWidth: 1,
        borderRadius: 4
      }]
    }, barOptions());
  }

  renderModelCharts() {
    if (!this.stats || !this.stats.byModel || this.stats.byModel.length === 0) return;
    if (typeof Chart === 'undefined') return;

    const style = getComputedStyle(document.documentElement);
    const textSecondary = style.getPropertyValue('--muted-foreground').trim() || '#94a3b8';

    const topModels = this.stats.byModel.slice(0, 8);
    const modelLabels = topModels.map(m => {
      return m.model_name || t('(已删除)');
    });
    const modelRequests = topModels.map(m => parseInt(m.requests || 0, 10));
    const modelTokens = topModels.map(m => parseInt(m.tokens || 0, 10));
    const modelCosts = topModels.map(m => parseFloat(m.cost || 0));
    const modelAvgTokens = topModels.map(m => {
      const req = parseInt(m.requests || 0, 10);
      const tok = parseInt(m.tokens || 0, 10);
      return req > 0 ? Math.round(tok / req) : 0;
    });

    const colors = ['var(--info)', 'var(--purple)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--cyan)', 'var(--pink)', '#14b8a6'];

    const doughnutOptions = () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: textSecondary, font: { size: 11 }, padding: 10, usePointStyle: true } }
      },
      cutout: '50%'
    });

    const barOptions = () => ({
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { display: false } }
      }
    });

    this._upsertChart('_modelReqChart', document.getElementById('modelRequestsChart'), 'doughnut', {
      labels: modelLabels,
      datasets: [{ data: modelRequests, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOptions());

    this._upsertChart('_modelTokChart', document.getElementById('modelTokensChart'), 'doughnut', {
      labels: modelLabels,
      datasets: [{ data: modelTokens, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOptions());

    this._upsertChart('_modelCostChart', document.getElementById('modelCostChart'), 'doughnut', {
      labels: modelLabels,
      datasets: [{ data: modelCosts, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOptions());

    this._upsertChart('_modelAvgChart', document.getElementById('modelAvgTokensChart'), 'bar', {
      labels: modelLabels,
      datasets: [{
        data: modelAvgTokens,
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 4
      }]
    }, barOptions());
  }

  renderProviderCharts() {
    if (!this.stats || !this.stats.byProvider || this.stats.byProvider.length === 0) return;
    if (typeof Chart === 'undefined') return;

    const style = getComputedStyle(document.documentElement);
    const textSecondary = style.getPropertyValue('--muted-foreground').trim() || '#94a3b8';

    const providers = this.stats.byProvider.slice(0, 8);
    const providerLabels = providers.map(p => p.provider || t('未知'));
    const providerRequests = providers.map(p => parseInt(p.requests || 0, 10));
    const providerTokens = providers.map(p => parseInt(p.tokens || 0, 10));
    const providerCosts = providers.map(p => parseFloat(p.cost || 0));
    const providerAvgTokens = providers.map(p => {
      const req = parseInt(p.requests || 0, 10);
      const tok = parseInt(p.tokens || 0, 10);
      return req > 0 ? Math.round(tok / req) : 0;
    });

    const colors = ['var(--info)', 'var(--purple)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--cyan)', 'var(--pink)', '#14b8a6'];

    const doughnutOptions = () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: textSecondary, font: { size: 11 }, padding: 10, usePointStyle: true } }
      },
      cutout: '50%'
    });

    const barOptions = () => ({
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { display: false } }
      }
    });

    this._upsertChart('_providerReqChart', document.getElementById('providerRequestsChart'), 'doughnut', {
      labels: providerLabels,
      datasets: [{ data: providerRequests, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOptions());

    this._upsertChart('_providerTokChart', document.getElementById('providerTokensChart'), 'doughnut', {
      labels: providerLabels,
      datasets: [{ data: providerTokens, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOptions());

    this._upsertChart('_providerCostChart', document.getElementById('providerCostChart'), 'doughnut', {
      labels: providerLabels,
      datasets: [{ data: providerCosts, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOptions());

    this._upsertChart('_providerAvgChart', document.getElementById('providerAvgTokensChart'), 'bar', {
      labels: providerLabels,
      datasets: [{
        data: providerAvgTokens,
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 4
      }]
    }, barOptions());
  }

  filterModelStatsTable() {
    this._debounceSearch('_modelStatsFilterTimer', () => {
      this.modelStatsPage = 0;
      this.renderModelStatsTable();
    });
  }

  renderModelStatsTable() {
    const container = document.getElementById('modelStatsTable');
    if (!container || !this.stats || !this.stats.byModel) return;

    if (this.stats.byModel.length === 0) {
      setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:20px;">' + t('暂无模型使用数据') + '</p>');
      return;
    }

    const q = this._searchQ('modelStatsSearchInput');
    const rows = q
      ? this.stats.byModel.filter(m => this._matchSearch(q, m.model_name, m.model_id))
      : this.stats.byModel;
    if (!rows.length) {
      setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:20px;">' + t('未找到匹配的模型') + '</p>');
      return;
    }

    const totalRequests = rows.reduce((sum, m) => sum + (m.requests || 0), 0);
    const totalTokens = rows.reduce((sum, m) => sum + (m.tokens || 0), 0);
    const totalCached = rows.reduce((sum, m) => sum + parseInt(m.cached_tokens || 0), 0);
    const totalCost = rows.reduce((sum, m) => sum + parseFloat(m.cost || 0), 0);
    const modelPg = this._paginate(rows, this.modelStatsPage, this.statsTablePageSize);
    this.modelStatsPage = modelPg.page;

    setHTML(container, `
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>请求数</th>
              <th>请求占比</th>
              <th>Token消耗</th>
              <th>缓存命中</th>
              <th>积分</th>
              <th>积分占比</th>
              <th>平均Token/请求</th>
            </tr>
          </thead>
          <tbody>
            ${modelPg.items.map(m => {
              const reqPercent = totalRequests > 0 ? ((m.requests / totalRequests) * 100).toFixed(1) : '0';
              const costPercent = totalCost > 0 ? (parseFloat(m.cost || 0) / totalCost * 100).toFixed(1) : '0';
              const avgTokens = m.requests > 0 ? Math.round(m.tokens / m.requests) : 0;
              const cachedTokens = parseInt(m.cached_tokens || 0);
              const cacheRate = m.tokens > 0 ? (cachedTokens / m.tokens * 100).toFixed(1) : '0.0';
              const cacheDisplay = cachedTokens > 0
                ? `<span style="color:var(--success);" title="${cachedTokens.toLocaleString()}">${this._formatBigNumber(cachedTokens)}</span> <span style="font-size:11px;color:var(--muted-foreground);">(${cacheRate}%)</span>`
                : '-';
              return `
                <tr>
                  <td>${escapeHtml(m.model_name || t('(已删除)'))}</td>
                  <td>${(m.requests || 0).toLocaleString()}</td>
                  <td>${reqPercent}%</td>
                  <td title="${(m.tokens || 0).toLocaleString()}">${this._formatBigNumber(m.tokens || 0)}</td>
                  <td>${cacheDisplay}</td>
                  <td>¥${parseFloat(m.cost || 0).toFixed(4)}</td>
                  <td>${costPercent}%</td>
                  <td title="${avgTokens.toLocaleString()}">${this._formatBigNumber(avgTokens)}</td>
                </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr style="font-weight:600;background:var(--background);">
              <td>' + t('合计') + '</td>
              <td>${totalRequests.toLocaleString()}</td>
              <td>100%</td>
              <td title="${totalTokens.toLocaleString()}">${this._formatBigNumber(totalTokens)}</td>
              <td>${totalCached > 0 ? '<span style="color:var(--success);" title="' + totalCached.toLocaleString() + '">' + this._formatBigNumber(totalCached) + '</span>' : '-'}</td>
              <td>¥${totalCost.toFixed(4)}</td>
              <td>100%</td>
              <td>${totalRequests > 0 ? this._formatBigNumber(Math.round(totalTokens / totalRequests)) : '-'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      ${modelPg.totalPages > 1 ? this._renderPagination('modelStats', modelPg.page, modelPg.totalPages, modelPg.total) : ''}
    `);
  }

  modelStatsPageGo(page) {
    this.modelStatsPage = page;
    this.renderModelStatsTable();
  }

  filterProviderStatsTable() {
    this._debounceSearch('_providerStatsFilterTimer', () => {
      this.providerStatsPage = 0;
      this.renderProviderStatsTable();
    });
  }

  renderProviderStatsTable() {
    const container = document.getElementById('providerStatsTable');
    if (!container || !this.stats || !this.stats.byProvider) return;

    if (this.stats.byProvider.length === 0) {
      setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:20px;">' + t('暂无供应商使用数据') + '</p>');
      return;
    }

    const q = this._searchQ('providerStatsSearchInput');
    const rows = q
      ? this.stats.byProvider.filter(p => this._matchSearch(q, p.provider, p.provider_name, p.provider_id))
      : this.stats.byProvider;
    if (!rows.length) {
      setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:20px;">' + t('未找到匹配的供应商') + '</p>');
      return;
    }

    const totalRequests = rows.reduce((sum, p) => sum + (p.requests || 0), 0);
    const totalTokens = rows.reduce((sum, p) => sum + (p.tokens || 0), 0);
    const totalCached = rows.reduce((sum, p) => sum + parseInt(p.cached_tokens || 0), 0);
    const totalCost = rows.reduce((sum, p) => sum + parseFloat(p.cost || 0), 0);
    const providerPg = this._paginate(rows, this.providerStatsPage, this.statsTablePageSize);
    this.providerStatsPage = providerPg.page;

    setHTML(container, `
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>供应商</th>
              <th>请求数</th>
              <th>请求占比</th>
              <th>Token消耗</th>
              <th>缓存命中</th>
              <th>积分</th>
              <th>积分占比</th>
              <th>平均Token/请求</th>
            </tr>
          </thead>
          <tbody>
            ${providerPg.items.map(p => {
              const reqPercent = totalRequests > 0 ? ((p.requests / totalRequests) * 100).toFixed(1) : '0';
              const costPercent = totalCost > 0 ? (parseFloat(p.cost || 0) / totalCost * 100).toFixed(1) : '0';
              const avgTokens = p.requests > 0 ? Math.round(p.tokens / p.requests) : 0;
              const cachedTokens = parseInt(p.cached_tokens || 0);
              const cacheRate = p.tokens > 0 ? (cachedTokens / p.tokens * 100).toFixed(1) : '0.0';
              const cacheDisplay = cachedTokens > 0
                ? `<span style="color:var(--success);" title="${cachedTokens.toLocaleString()}">${this._formatBigNumber(cachedTokens)}</span> <span style="font-size:11px;color:var(--muted-foreground);">(${cacheRate}%)</span>`
                : '-';
              return `
                <tr>
                  <td style="font-size:13px;">${escapeHtml(p.provider || t('未知'))}</td>
                  <td>${(p.requests || 0).toLocaleString()}</td>
                  <td>${reqPercent}%</td>
                  <td title="${(p.tokens || 0).toLocaleString()}">${this._formatBigNumber(p.tokens || 0)}</td>
                  <td>${cacheDisplay}</td>
                  <td>¥${parseFloat(p.cost || 0).toFixed(4)}</td>
                  <td>${costPercent}%</td>
                  <td title="${avgTokens.toLocaleString()}">${this._formatBigNumber(avgTokens)}</td>
                </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr style="font-weight:600;background:var(--background);">
              <td>' + t('合计') + '</td>
              <td>${totalRequests.toLocaleString()}</td>
              <td>100%</td>
              <td title="${totalTokens.toLocaleString()}">${this._formatBigNumber(totalTokens)}</td>
              <td>${totalCached > 0 ? '<span style="color:var(--success);" title="' + totalCached.toLocaleString() + '">' + this._formatBigNumber(totalCached) + '</span>' : '-'}</td>
              <td>¥${totalCost.toFixed(4)}</td>
              <td>100%</td>
              <td>${totalRequests > 0 ? this._formatBigNumber(Math.round(totalTokens / totalRequests)) : '-'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      ${providerPg.totalPages > 1 ? this._renderPagination('providerStats', providerPg.page, providerPg.totalPages, providerPg.total) : ''}
    `);
  }

  renderSourceCharts() {
    if (!this.stats || typeof Chart === 'undefined') return;
    const rows = (this.stats.bySource || []).filter((s) => parseInt(s.requests || 0, 10) > 0);
    const labels = rows.map((s) => this._usageRequestSourceMeta(s.request_source).label);
    const colors = rows.map((s) => this._usageRequestSourceMeta(s.request_source).color);
    const reqs = rows.map((s) => parseInt(s.requests || 0, 10));
    const costs = rows.map((s) => parseFloat(s.cost || 0));
    const pieOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } }
      }
    };
    const reqCanvas = document.getElementById('adminSourceRequestsChart');
    if (reqCanvas) {
      this._upsertChart('_adminSourceReqChart', reqCanvas, 'doughnut', {
        labels, datasets: [{ data: reqs, backgroundColor: colors, borderWidth: 0 }]
      }, pieOpts);
    }
    const costCanvas = document.getElementById('adminSourceCostChart');
    if (costCanvas) {
      this._upsertChart('_adminSourceCostChart', costCanvas, 'doughnut', {
        labels, datasets: [{ data: costs, backgroundColor: colors, borderWidth: 0 }]
      }, pieOpts);
    }
    const dailyCanvas = document.getElementById('adminSourceDailyChart');
    if (dailyCanvas) {
      const series = this.stats.dailyBySource || [];
      const dates = [...new Set(series.map((r) => r.date))].sort();
      const sourceIds = [...new Set(series.map((r) => r.request_source || 'unknown'))];
      if (!dates.length) {
        this._destroyChart?.('_adminSourceDailyChart');
      } else {
        const datasets = sourceIds.map((sid) => {
          const meta = this._usageRequestSourceMeta(sid);
          const byDate = {};
          series.filter((r) => (r.request_source || 'unknown') === sid).forEach((r) => {
            byDate[r.date] = parseInt(r.requests || 0, 10);
          });
          return {
            label: meta.label,
            data: dates.map((dt) => byDate[dt] || 0),
            backgroundColor: meta.color,
            borderColor: meta.color,
            fill: true,
            tension: 0.25,
            pointRadius: 0,
            stack: 'src'
          };
        });
        this._upsertChart('_adminSourceDailyChart', dailyCanvas, 'line', { labels: dates, datasets }, {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
          scales: {
            x: { stacked: true, ticks: { maxTicksLimit: 12 } },
            y: { stacked: true }
          }
        });
      }
    }
  }

  renderMemberStatsCharts() {
    if (!this.stats || typeof Chart === 'undefined') return;
    const groups = [
      { key: 'byUser', label: t('成员'), requests: 'memberRequestsChart', cost: 'memberCostChart', reqStore: '_memberReqChart', costStore: '_memberCostChart', name: 'user_name' },
      { key: 'byTeam', label: 'Team', requests: 'teamRequestsChart', reqStore: '_teamReqChart', name: 'team_name' },
      { key: 'byGroup', label: t('用户组'), requests: 'groupRequestsChart', reqStore: '_groupReqChart', name: 'group_name' }
    ];
    const colors = ['var(--info)', 'var(--purple)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--cyan)', 'var(--pink)', '#14b8a6', '#f97316', '#64748b'];
    const style = getComputedStyle(document.documentElement);
    const textSecondary = style.getPropertyValue('--muted-foreground').trim() || '#94a3b8';
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${Number(ctx.raw || 0).toLocaleString()}` } } },
      scales: {
        x: { beginAtZero: true, ticks: { color: textSecondary, font: { size: 10 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { ticks: { color: textSecondary, font: { size: 10 } }, grid: { display: false } }
      }
    };
    groups.forEach((group) => {
      const rows = (this.stats[group.key] || []).slice(0, 10);
      const labels = rows.map(row => row[group.name] || t('未分配'));
      const requests = rows.map(row => Number(row.requests || 0));
      const requestCanvas = document.getElementById(group.requests);
      if (requestCanvas) {
        this._upsertChart(group.reqStore, requestCanvas, 'bar', { labels, datasets: [{ label: t('请求数'), data: requests, backgroundColor: colors, borderRadius: 5, borderWidth: 0 }] }, options);
      }
      if (group.cost) {
        const costs = rows.map(row => Number(row.cost || 0));
        const costCanvas = document.getElementById(group.cost);
        if (costCanvas) {
          this._upsertChart(group.costStore, costCanvas, 'bar', { labels, datasets: [{ label: t('积分'), data: costs, backgroundColor: 'var(--success)', borderRadius: 5, borderWidth: 0 }] }, options);
        }
      }
    });
  }

  renderMemberStatsTables() {
    if (!this.stats) return;
    const render = (containerId, rows, labelKey, emptyText) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      if (!rows || rows.length === 0) {
        setHTML(container, `<p style="text-align:center;color:var(--muted-foreground);padding:20px;">${emptyText}</p>`);
        return;
      }
      const totalRequests = rows.reduce((sum, row) => sum + Number(row.requests || 0), 0);
      const totalCost = rows.reduce((sum, row) => sum + Number(row.cost || 0), 0);
      setHTML(container, `<div style="overflow-x:auto;"><table><thead><tr><th>${labelKey === 'user_name' ? t('成员') : labelKey === 'team_name' ? 'Team' : t('用户组')}</th><th>请求数</th><th>占比</th><th>Token</th><th>积分</th><th>平均延迟</th></tr></thead><tbody>${rows.map(row => {
        const requests = Number(row.requests || 0);
        const cost = Number(row.cost || 0);
        return `<tr><td>${escapeHtml(row[labelKey] || t('未分配'))}</td><td>${requests.toLocaleString()}</td><td>${totalRequests ? (requests / totalRequests * 100).toFixed(1) : '0.0'}%</td><td title="${Number(row.tokens || 0).toLocaleString()}">${this._formatBigNumber(Number(row.tokens || 0))}</td><td>${cost.toFixed(4)}</td><td>${row.avg_latency == null ? '-' : `${Math.round(Number(row.avg_latency))}ms`}</td></tr>`;
      }).join('')}</tbody><tfoot><tr style="font-weight:600;background:var(--background);"><td>' + t('合计') + '</td><td>${totalRequests.toLocaleString()}</td><td>100%</td><td title="${rows.reduce((sum, row) => sum + Number(row.tokens || 0), 0).toLocaleString()}">${this._formatBigNumber(rows.reduce((sum, row) => sum + Number(row.tokens || 0), 0))}</td><td>${totalCost.toFixed(4)}</td><td>-</td></tr></tfoot></table></div>`);
    };
    const summaryRows = [
      [t('成员'), this.stats.byUser || [], 'user_name'],
      ['Team', this.stats.byTeam || [], 'team_name'],
      [t('用户组'), this.stats.byGroup || [], 'group_name']
    ];
    const summary = summaryRows.map(([label, rows]) => {
      const requests = rows.reduce((sum, row) => sum + Number(row.requests || 0), 0);
      const tokens = rows.reduce((sum, row) => sum + Number(row.tokens || 0), 0);
      const cost = rows.reduce((sum, row) => sum + Number(row.cost || 0), 0);
      return `<div class="stats-overview-card" style="background:linear-gradient(135deg,#334155,#1e293b);"><div class="stats-overview-content"><span class="stats-overview-label">${label}${t('数量')}</span><span class="stats-overview-value">${rows.length}</span><span class="stats-overview-sub">${requests.toLocaleString()}${t('次 ·')}${this._formatBigNumber(tokens)} Token · ${cost.toFixed(2)}${t('积分')}</span></div></div>`;
    }).join('');
    const summaryEl = document.getElementById('memberStatsSummary');
    if (summaryEl) setHTML(summaryEl, summary);
    render('memberStatsTable', this.stats.byUser, 'user_name', t('暂无成员用量数据'));
    render('teamStatsTable', this.stats.byTeam, 'team_name', t('暂无 Team 用量数据'));
    render('groupStatsTable', this.stats.byGroup, 'group_name', t('暂无用户组用量数据'));
  }

  renderSourceStatsTable() {
    const container = document.getElementById('sourceStatsTable');
    if (!container || !this.stats) return;
    const rows = this.stats.bySource || [];
    if (rows.length === 0) {
      setHTML(container, '<p style="color:var(--muted-foreground);font-size:13px;">' + t('暂无来源数据（历史记录在功能上线前均为「未知/其他」）') + '</p>');
      return;
    }
    setHTML(container, `
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>客户端</th>
              <th style="text-align:right;">请求数</th>
              <th style="text-align:right;">占比</th>
              <th style="text-align:right;">Token</th>
              <th style="text-align:right;">Prompt</th>
              <th style="text-align:right;">Completion</th>
              <th style="text-align:right;">缓存</th>
              <th style="text-align:right;">积分</th>
              <th style="text-align:right;">平均延迟</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const reqs = parseInt(r.requests || 0, 10);
              const share = ((r.share_requests || 0) * 100).toFixed(1);
              const tokens = parseInt(r.tokens || 0, 10);
              const cached = parseInt(r.cached_tokens || 0, 10);
              const cost = parseFloat(r.cost || 0);
              const latency = r.avg_latency != null ? `${Math.round(parseFloat(r.avg_latency))}ms` : '-';
              return `<tr>
                <td>${this._usageRequestSourceBadge(r.request_source)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;">${reqs.toLocaleString()}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;">${share}%</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;" title="${tokens.toLocaleString()}">${this._formatBigNumber(tokens)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;" title="${parseInt(r.prompt_tokens || 0, 10).toLocaleString()}">${this._formatBigNumber(parseInt(r.prompt_tokens || 0, 10))}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;" title="${parseInt(r.completion_tokens || 0, 10).toLocaleString()}">${this._formatBigNumber(parseInt(r.completion_tokens || 0, 10))}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;">${cached > 0 ? `<span title="${cached.toLocaleString()}">${this._formatBigNumber(cached)}</span>` : '-'}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;">${cost.toFixed(4)}</td>
                <td style="text-align:right;">${latency}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `);
  }

  renderSourceModelStatsTable() {
    const container = document.getElementById('sourceModelStatsTable');
    if (!container || !this.stats) return;
    const rows = this.stats.bySourceModel || [];
    if (rows.length === 0) {
      setHTML(container, '<p style="color:var(--muted-foreground);font-size:13px;">' + t('暂无交叉数据') + '</p>');
      return;
    }
    setHTML(container, `
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>客户端</th>
              <th>模型</th>
              <th style="text-align:right;">请求数</th>
              <th style="text-align:right;">Token</th>
              <th style="text-align:right;">积分</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const modelLabel = r.model_name || r.model_id || t('(未知)');
              return `<tr>
                <td>${this._usageRequestSourceBadge(r.request_source)}</td>
                <td>${escapeHtml(String(modelLabel))}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;">${parseInt(r.requests || 0, 10).toLocaleString()}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;" title="${parseInt(r.tokens || 0, 10).toLocaleString()}">${this._formatBigNumber(parseInt(r.tokens || 0, 10))}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;">${parseFloat(r.cost || 0).toFixed(4)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `);
  }

  providerStatsPageGo(page) {
    this.providerStatsPage = page;
    this.renderProviderStatsTable();
  }

  // ========== API 调用错误记录 ==========
  errorLogPage = 1;
  errorLogTotal = 0;
  errorLogLimit = 50;
  _errorLogCache = [];

  _buildErrorLogFilterParams() {
    const userQ = (document.getElementById('errorLogUserFilter')?.value || '').trim();
    const modelQ = (document.getElementById('errorLogModelFilter')?.value || '').trim();
    const providerQ = (document.getElementById('errorLogProviderFilter')?.value || '').trim();
    const statusCode = (document.getElementById('errorLogStatusFilter')?.value || '').trim();
    const errorType = (document.getElementById('errorLogTypeFilter')?.value || '').trim();
    const startDate = document.getElementById('errorLogStartDate')?.value || '';
    const endDate = document.getElementById('errorLogEndDate')?.value || '';
    const finalOnly = document.getElementById('errorLogFinalOnly')?.checked;

    const params = new URLSearchParams();
    if (userQ) {
      if (/^\d+$/.test(userQ)) params.append('user_id', userQ);
      else params.append('user_q', userQ);
    }
    if (modelQ) params.append('model_q', modelQ);
    if (providerQ) params.append('provider_q', providerQ);
    if (statusCode) params.append('status_code', statusCode);
    if (errorType) params.append('error_type', errorType);
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (finalOnly) params.append('final_only', '1');
    return params;
  }

  async loadErrorLogs(page = 1) {
    this.errorLogPage = page;
    const errListEl = document.getElementById('errorLogsList');
    if (errListEl) setHTML(errListEl, pageLoadingHtml(t('加载错误记录...'), { compact: true }));
    const params = this._buildErrorLogFilterParams();
    params.set('page', String(this.errorLogPage));
    params.set('limit', String(this.errorLogLimit));

    try {
      const response = await fetch(`/api/admin/error-logs?${params}`);
      if (!response.ok) throw new Error(t('加载失败'));
      const data = await response.json();

      this.errorLogTotal = data.total;
      this._errorLogCache = data.logs || [];
      const container = document.getElementById('errorLogsList');
      const countEl = document.getElementById('errorLogCount');
      const pageInfoEl = document.getElementById('errorLogPageInfo');
      const prevBtn = document.getElementById('errorLogPrevBtn');
      const nextBtn = document.getElementById('errorLogNextBtn');
      const retentionEl = document.getElementById('errorLogRetentionHint');

      const totalPages = Math.ceil(data.total / this.errorLogLimit) || 1;
      if (countEl) countEl.textContent = `${t('共')}${data.total}${t('条记录')}`;
      if (pageInfoEl) pageInfoEl.textContent = `${t('第')}${data.page} / ${totalPages}${t('页')}`;
      if (prevBtn) prevBtn.disabled = data.page <= 1;
      if (nextBtn) nextBtn.disabled = data.page >= totalPages;
      if (retentionEl) {
        const days = data.retention_days || 14;
        retentionEl.textContent = `${t('默认保留近')}${days}${t('天的错误记录，中间失败（队列回退）与最终返回客户端的错误均可筛选。')}`;
      }

      if (!data.logs || data.logs.length === 0) {
        setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:40px;">' + t('暂无错误记录') + '</p>');
        return;
      }

      const statusBadge = (code) => {
        if (code == null) return '<span style="color:var(--muted-foreground);">-</span>';
        const c = parseInt(code, 10);
        let color = 'var(--muted-foreground)';
        if (c >= 500) color = 'var(--destructive)';
        else if (c >= 400) color = 'var(--warning)';
        return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;background:color-mix(in srgb, ${color} 15%, transparent);color:${color};">${c}</span>`;
      };

      setHTML(container, `
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>用户</th>
              <th>模型</th>
              <th>供应商</th>
              <th>状态码</th>
              <th>类型</th>
              <th>错误信息</th>
              <th>延迟</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${data.logs.map((log, idx) => {
              const msg = (log.error_message || '').replace(/\s+/g, ' ').trim();
              const shortMsg = msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
              const finalTag = log.is_final
                ? ''
                : '<span style="margin-left:4px;font-size:10px;padding:1px 5px;border-radius:4px;background:var(--muted);color:var(--muted-foreground);">' + t('重试') + '</span>';
              return `
              <tr style="cursor:pointer;" onclick="adminApp.showErrorDetail(${idx})">
                <td style="white-space:nowrap;">${new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td>
                <td>${escapeHtml(log.username || String(log.user_id || '-'))}</td>
                <td>${escapeHtml(log.model_name || log.model_id || '-')}${finalTag}</td>
                <td>${escapeHtml(log.provider_name || log.provider_id || '-')}</td>
                <td>${statusBadge(log.status_code)}</td>
                <td style="font-size:12px;">${escapeHtml(log.error_type || '-')}</td>
                <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(msg)}">${escapeHtml(shortMsg || '-')}</td>
                <td style="white-space:nowrap;">${log.latency_ms != null ? log.latency_ms + 'ms' : '-'}</td>
                <td><button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();adminApp.showErrorDetail(${idx})">详情</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `);
    } catch (error) {
      console.error(t('加载错误记录失败:'), error);
      setHTML(document.getElementById('errorLogsList'), `<p style="text-align:center;color:var(--destructive);padding:40px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  clearErrorLogFilters() {
    const ids = [
      'errorLogUserFilter', 'errorLogModelFilter', 'errorLogProviderFilter',
      'errorLogStatusFilter', 'errorLogTypeFilter', 'errorLogStartDate', 'errorLogEndDate'
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    const finalOnly = document.getElementById('errorLogFinalOnly');
    if (finalOnly) finalOnly.checked = true;
    this.loadErrorLogs(1);
  }

  showErrorDetail(idx) {
    const log = this._errorLogCache[idx];
    if (!log) return;

    const rows = [
      [t('时间'), new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })],
      [t('用户'), escapeHtml(log.username || (log.user_id != null ? `ID: ${log.user_id}` : '-'))],
      [t('模型'), escapeHtml(log.model_name || log.model_id || '-')],
      [t('系列'), escapeHtml(log.series || '-')],
      [t('上游模型 ID'), escapeHtml(log.upstream_model_id || log.model_id || '-')],
      [t('供应商'), escapeHtml(log.provider_name || log.provider_id || '-')],
      [t('请求类型'), escapeHtml(log.request_type || '-')],
      [t('状态码'), log.status_code != null ? String(log.status_code) : '-'],
      [t('错误类型'), escapeHtml(log.error_type || '-')],
      [t('是否最终错误'), log.is_final ? t('是（返回客户端）') : t('否（队列回退中间失败）')],
      [t('延迟'), log.latency_ms != null ? `${log.latency_ms}ms` : '-'],
      [t('IP 地址'), escapeHtml(log.ip_address || '-')],
      ['API Key', log.key_prefix
        ? `<code style="font-size:12px;">${escapeHtml(log.key_prefix)}****</code>${log.key_name ? ` <span style="color:var(--muted-foreground);font-size:11px;">(${escapeHtml(log.key_name)})</span>` : ''}`
        : '-'],
    ];

    let bodyHtml = '';
    if (log.error_message) {
      bodyHtml += `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('错误信息')}</span><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:200px;overflow-y:auto;color:var(--destructive);">${escapeHtml(log.error_message)}</pre></div>`;
    }
    if (log.error_body) {
      let pretty = log.error_body;
      try {
        pretty = JSON.stringify(JSON.parse(log.error_body), null, 2);
      } catch { /* keep raw */ }
      bodyHtml += `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('原始响应')}</span><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:360px;overflow-y:auto;">${escapeHtml(pretty)}</pre></div>`;
    }

    const content = document.getElementById('errorDetailContent');
    setHTML(content, rows.map(([label, value]) => `
      <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--muted-foreground);font-size:13px;">${label}</span>
        <span style="font-size:14px;">${value}</span>
      </div>
    `).join('') + bodyHtml);

    const modal = document.getElementById('errorDetailModal');
    if (modal) {
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  }

  closeErrorDetailModal() {
    const modal = document.getElementById('errorDetailModal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('active');
    }
  }

  // ========== API 调用记录 ==========
  usageLogPage = 1;
  usageLogTotal = 0;
  usageLogLimit = 50;

  _usageRequestTypeMeta(type) {
    const t = String(type || '').toLowerCase();
    const map = {
      chat: { label: 'Chat', color: 'var(--info)' },
      responses: { label: 'Responses', color: 'var(--purple)' },
      fusion: { label: 'Fusion', color: 'var(--warning)' },
      playground: { label: 'Playground', color: 'var(--success)' }
    };
    return map[t] || (t ? { label: type, color: 'var(--muted-foreground)' } : { label: '-', color: 'var(--muted-foreground)' });
  }

  _usageRequestTypeBadge(type) {
    const meta = this._usageRequestTypeMeta(type);
    if (meta.label === '-') return '<span style="color:var(--muted-foreground);">-</span>';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;background:color-mix(in srgb, ${meta.color} 15%, transparent);color:${meta.color};">${escapeHtml(meta.label)}</span>`;
  }

  _usageRequestSourceMeta(source) {
    const s = String(source || 'unknown').toLowerCase();
    const map = {
      grok: { label: 'Grok', color: '#a855f7' },
      codex: { label: 'Codex', color: 'var(--success)' },
      claude_code: { label: 'Claude Code', color: 'var(--warning)' },
      opencode: { label: 'OpenCode', color: 'var(--info)' },
      qwen_code: { label: 'Qwen Code', color: '#6366f1' },
      hermes: { label: 'Hermes', color: 'var(--pink)' },
      openclaw: { label: 'OpenClaw', color: '#0ea5e9' },
      deepseek_harness: { label: 'DeepSeek Harness', color: '#4d6bfe' },
      unknown: { label: t('未知/其他'), color: 'var(--muted-foreground)' }
    };
    return map[s] || map.unknown;
  }

  _usageRequestSourceBadge(source) {
    const meta = this._usageRequestSourceMeta(source);
    return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;background:color-mix(in srgb, ${meta.color} 15%, transparent);color:${meta.color};">${escapeHtml(meta.label)}</span>`;
  }

  /** 列表「命中自定义提示词文件」徽标：📄 N（N 为文件数） */
  _customInstructionsBadge(count) {
    const n = parseInt(count || 0, 10);
    if (!(n > 0)) return '';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;margin-left:6px;background:color-mix(in srgb, var(--success) 15%, transparent);color:#16a34a;" title="${n} ${t('个自定义提示词文件')}">📄 ${n}</span>`;
  }

  /** 详情「自定义提示词」区块 HTML（从 log.plugin_meta.customInstructions 渲染） */
  _customInstructionsSectionHtml(log) {
    const ci = log && log.plugin_meta && log.plugin_meta.customInstructions;
    if (!ci) return '';
    // 超大输入被跳过提取的情形
    if (!Array.isArray(ci)) {
      if (ci && ci.skipped === 'size') {
        return `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('自定义提示词')}</span><span style="font-size:13px;color:var(--muted-foreground);">${t('请求过大，已跳过提取')}</span></div>`;
      }
      return '';
    }
    if (!ci.length) return '';
    const blocks = ci.map((item, idx) => {
      const file = escapeHtml(String(item && item.file || t('未知')));
      const sourceLabel = this._customInstructionSourceLabel(item && item.source);
      const chars = parseInt(item && item.chars || 0, 10);
      const truncated = !!(item && item.truncated);
      const truncNote = truncated ? ` <span style="color:var(--warning);font-size:12px;">(${t('已截断')})</span>` : '';
      const detail = `<span style="font-size:12px;color:var(--muted-foreground);">${sourceLabel}</span> <span style="font-size:12px;color:var(--muted-foreground);">${chars.toLocaleString()} ${t('字符')}</span>${truncNote}`;
      const contentPre = `<pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:8px 0 0;max-height:220px;overflow-y:auto;${truncated ? 'display:none;' : ''}" data-custom-inst-content="${idx}">${escapeHtml(String(item && item.content || ''))}</pre>`;
      const toggleBtn = truncated ? `<button type="button" class="btn btn-sm btn-secondary" data-custom-inst-toggle="${idx}" style="margin-top:8px;">${t('查看全部')}</button>` : '';
      return `<div style="margin:10px 0;padding:10px;border:1px solid var(--border);border-radius:8px;">
        <div style="font-size:13px;font-weight:600;word-break:break-all;">📄 ${file}</div>
        <div style="margin-top:2px;">${detail}</div>
        ${contentPre}${toggleBtn}
      </div>`;
    }).join('');
    return `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('自定义提示词')}</span><div>${blocks || t('无')}</div></div>`;
  }

  _customInstructionSourceLabel(source) {
    return ({
      claude_md: 'CLAUDE.md',
      agents_md: 'AGENTS.md',
      cursorrules: '.cursorrules',
      qwen_md: 'QWEN.md',
      soul_md: 'SOUL.md',
      other: t('其他'),
    })[source] || t('其他');
  }

  _formatUsageModelLabel(log) {
    return log.model_name
      || (log.request_type === 'fusion' ? 'Fusion' : null)
      || (log.model_id ? String(log.model_id) : null)
      || t('(未知)');
  }

  _formatUsageProviderLabel(log) {
    return log.provider_name || log.provider_id || '-';
  }

  async loadUsageLogs(page = 1) {
    this.usageLogPage = Math.max(1, page || 1);
    const usageListEl = document.getElementById('usageLogsList');
    if (usageListEl) setHTML(usageListEl, pageLoadingHtml(t('加载调用记录...'), { compact: true }));

    const params = this._buildUsageLogFilterParams();
    params.set('page', String(this.usageLogPage));
    params.set('limit', String(this.usageLogLimit));

    try {
      const response = await fetch(`/api/admin/usage-logs?${params}`);
      if (!response.ok) throw new Error(t('加载失败'));
      const data = await response.json();

      this.usageLogTotal = data.total;
      this._usageLogCache = data.logs || [];
      const container = document.getElementById('usageLogsList');
      const countEl = document.getElementById('usageLogCount');
      const pageInfoEl = document.getElementById('usageLogPageInfo');
      const prevBtn = document.getElementById('usageLogPrevBtn');
      const nextBtn = document.getElementById('usageLogNextBtn');
      const totalPages = Math.ceil(data.total / this.usageLogLimit) || 1;

      if (countEl) countEl.textContent = `${t('共')}${data.total}${t('条记录')}`;
      if (pageInfoEl) pageInfoEl.textContent = `${t('第')}${data.page} / ${totalPages}${t('页')}`;
      if (prevBtn) prevBtn.disabled = data.page <= 1;
      if (nextBtn) nextBtn.disabled = data.page >= totalPages;

      if (!data.logs || data.logs.length === 0) {
        setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:40px;">' + t('暂无调用记录') + '</p>');
        return;
      }

      setHTML(container, `
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>用户</th>
              <th>模型</th>
              <th>供应商</th>
              <th>类型</th>
              <th>客户端</th>
              <th>Token</th>
              <th>积分</th>
              <th>延迟</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${data.logs.map((log, idx) => {
              const promptTokens = parseInt(log.prompt_tokens || 0, 10);
              const completionTokens = parseInt(log.completion_tokens || 0, 10);
              const cachedTokens = parseInt(log.cached_tokens || 0, 10);
              const totalTokens = parseInt(log.tokens_used || 0, 10);
              const cacheRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0.0';
              const modelLabel = this._formatUsageModelLabel(log);
              const providerLabel = this._formatUsageProviderLabel(log);
              const costVal = parseFloat(log.cost || 0);
              const costDisplay = (costVal === 0 && totalTokens > 0)
                ? '<span title="' + t('配额内免费') + '">0</span><span style="font-size:11px;color:var(--muted-foreground);margin-left:2px;">' + t('配额内') + '</span>'
                : costVal.toFixed(6);
              const seriesLine = log.series
                ? `<div style="font-size:11px;color:var(--muted-foreground);margin-top:2px;">${escapeHtml(log.series)}</div>`
                : '';
              const keyHint = log.key_prefix
                ? `<div style="font-size:11px;color:var(--muted-foreground);margin-top:2px;"><code style="font-size:11px;">${escapeHtml(log.key_prefix)}****</code>${log.key_name ? ` ${escapeHtml(log.key_name)}` : ''}</div>`
                : '';
              const tokenSub = [
                `${t('入')}${this._formatBigNumber(promptTokens)}`,
                `${t('出')}${this._formatBigNumber(completionTokens)}`,
                cachedTokens > 0 ? `${t('缓存')}${this._formatBigNumber(cachedTokens)} (${cacheRate}%)` : null
              ].filter(Boolean).join(' · ');
              return `
              <tr style="cursor:pointer;" data-usage-log-idx="${idx}" title="${t('点击查看详情')}">
                <td style="white-space:nowrap;">${escapeHtml(new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
                <td class="cell-clip-sm" title="${escapeHtml(log.username || String(log.user_id || ''))}">${escapeHtml(log.username || String(log.user_id || '-'))}</td>
                <td class="cell-clip" title="${escapeHtml(modelLabel)}">
                  <div style="font-weight:500;">${escapeHtml(modelLabel)}</div>
                  ${seriesLine}
                  ${keyHint}
                </td>
                <td class="cell-clip-sm" title="${escapeHtml(providerLabel)}">
                  <span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;background:var(--muted);color:var(--foreground);">${escapeHtml(providerLabel)}</span>
                </td>
                <td>${this._usageRequestTypeBadge(log.request_type)}</td>
                <td>${this._usageRequestSourceBadge(log.request_source)}${this._customInstructionsBadge(log.custom_instruction_count)}</td>
                <td style="white-space:nowrap;">
                  <div style="font-variant-numeric:tabular-nums;" title="${totalTokens.toLocaleString()}">${this._formatBigNumber(totalTokens)}</div>
                  <div style="font-size:11px;color:var(--muted-foreground);margin-top:2px;">${tokenSub}</div>
                </td>
                <td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${costDisplay}</td>
                <td style="white-space:nowrap;">${log.latency_ms != null ? `${log.latency_ms}ms` : '<span style="color:var(--muted-foreground);">-</span>'}</td>
                <td class="cell-actions"><button type="button" class="btn btn-sm btn-secondary" data-usage-detail-idx="${idx}">详情</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `);
      // 行点击 / 详情按钮查看详情（仅用数字 idx，避免 JSON 塞进 onclick）
      container.querySelectorAll('tr[data-usage-log-idx]').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          const i = parseInt(tr.getAttribute('data-usage-log-idx'), 10);
          const log = this._usageLogCache[i];
          if (log) this.showUsageDetail(log);
        });
      });
      container.querySelectorAll('button[data-usage-detail-idx]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const i = parseInt(btn.getAttribute('data-usage-detail-idx'), 10);
          const log = this._usageLogCache[i];
          if (log) this.showUsageDetail(log);
        });
      });
    } catch (error) {
      console.error(t('加载调用记录失败:'), error);
      setHTML(document.getElementById('usageLogsList'), `<p style="text-align:center;color:var(--destructive);padding:40px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  clearUsageLogFilters() {
    const ids = [
      'usageLogUserFilter', 'usageLogModelFilter', 'usageLogProviderFilter',
      'usageLogRequestTypeFilter', 'usageLogRequestSourceFilter',
      'usageLogStartDate', 'usageLogEndDate'
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    this.loadUsageLogs(1);
  }

  _buildUsageLogFilterParams() {
    const userQ = (document.getElementById('usageLogUserFilter')?.value || '').trim();
    const modelQ = (document.getElementById('usageLogModelFilter')?.value || '').trim();
    const providerQ = (document.getElementById('usageLogProviderFilter')?.value || '').trim();
    const requestType = (document.getElementById('usageLogRequestTypeFilter')?.value || '').trim();
    const requestSource = (document.getElementById('usageLogRequestSourceFilter')?.value || '').trim();
    const startDate = document.getElementById('usageLogStartDate')?.value || '';
    const endDate = document.getElementById('usageLogEndDate')?.value || '';
    const params = new URLSearchParams();
    if (userQ) {
      if (/^\d+$/.test(userQ)) params.append('user_id', userQ);
      else params.append('user_q', userQ);
    }
    if (modelQ) params.append('model_q', modelQ);
    if (providerQ) params.append('provider_q', providerQ);
    if (requestType) params.append('request_type', requestType);
    if (requestSource) params.append('request_source', requestSource);
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    return params;
  }

  async exportUsageLogs() {
    const btn = document.getElementById('usageLogExportBtn');
    try {
      if (btn) setButtonLoading(btn, t('导出中...'));
      const params = this._buildUsageLogFilterParams();
      const res = await fetch(`/api/admin/usage-logs/export?${params.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${t('导出失败 (')}${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const match = cd.match(/filename="?([^"]+)"?/i);
      const filename = match ? match[1] : `usage-logs-${Date.now()}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.showToast?.(t('导出成功'), 'success');
    } catch (error) {
      console.error(t('导出调用记录失败:'), error);
      alert(error.message || t('导出失败'));
    } finally {
      if (btn) clearButtonLoading(btn, t('导出 CSV'));
    }
  }

  async showUsageDetail(log) {
    // 列表接口不再携带 messages / response 大字段，点开详情时按 id 拉取
    if (log && log.id != null && (log.messages === undefined && log.response === undefined)) {
      try {
        const modal = document.getElementById('usageDetailModal');
        const content = document.getElementById('usageDetailContent');
        if (modal && content) {
          setHTML(content, pageLoadingHtml(t('加载详情...'), { compact: true }));
          modal.style.display = 'flex';
          modal.classList.add('active');
        }
        const res = await fetch(`/api/admin/usage-logs/${log.id}`);
        if (!res.ok) throw new Error(`${t('加载详情失败 (')}${res.status})`);
        const data = await res.json();
        if (data.log) log = data.log;
      } catch (error) {
        console.error(t('加载用量详情失败:'), error);
        const content = document.getElementById('usageDetailContent');
        if (content) setHTML(content, `<p style="text-align:center;color:var(--destructive);padding:20px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
        return;
      }
    }

    const promptTokens = parseInt(log.prompt_tokens || 0, 10);
    const cachedTokens = parseInt(log.cached_tokens || 0, 10);
    const cacheRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0.0';
    const cacheDisplay = cachedTokens > 0
      ? `<span title="${cachedTokens.toLocaleString()}">${this._formatBigNumber(cachedTokens)}</span> <span style="color:var(--success);font-size:12px;">(${cacheRate}${t('% 命中)')}</span>`
      : '0';

    const modelLabel = this._formatUsageModelLabel(log);
    const providerLabel = this._formatUsageProviderLabel(log);
    const typeMeta = this._usageRequestTypeMeta(log.request_type);
    const costVal = parseFloat(log.cost || 0);
    const tokensVal = parseInt(log.tokens_used || 0, 10);
    const costDisplay = (costVal === 0 && tokensVal > 0)
      ? t('0（配额内）')
      : costVal.toFixed(6);
    const rows = [
      [t('调用时间'), escapeHtml(new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))],
      [t('用户'), escapeHtml(log.username || (log.user_id != null ? `ID: ${log.user_id}` : '-'))],
      [t('模型'), escapeHtml(modelLabel)],
      [t('系列'), escapeHtml(log.series || '-')],
      [t('上游模型 ID'), escapeHtml(log.upstream_model_id || log.model_id || '-')],
      [t('供应商'), escapeHtml(providerLabel)],
      [t('请求类型'), this._usageRequestTypeBadge(log.request_type) + (typeMeta.label !== '-' && log.request_type ? ` <span style="color:var(--muted-foreground);font-size:12px;">(${escapeHtml(String(log.request_type))})</span>` : '')],
      [t('客户端'), this._usageRequestSourceBadge(log.request_source) + (log.user_agent ? ` <span style="color:var(--muted-foreground);font-size:11px;word-break:break-all;">${escapeHtml(String(log.user_agent).slice(0, 120))}</span>` : '')],
      ['API Key', log.key_prefix
        ? `<code style="font-size:12px;">${escapeHtml(log.key_prefix)}****</code>${log.key_name ? ` <span style="color:var(--muted-foreground);font-size:11px;">(${escapeHtml(log.key_name)})</span>` : ''}`
        : '-'],
      [t('总 Token'), this._formatBigNumber(tokensVal)],
      [t('输入 Token'), this._formatBigNumber(promptTokens)],
      [t('输出 Token'), this._formatBigNumber(parseInt(log.completion_tokens || 0, 10))],
      [t('缓存命中 Token'), cacheDisplay],
      [t('积分'), costDisplay],
      [t('延迟'), log.latency_ms != null ? `${log.latency_ms}ms` : '-'],
      [t('IP 地址'), escapeHtml(log.ip_address || '-')],
    ];

    let messagesHtml = '';
    const analysis = log.message_analysis;
    if (analysis) {
      const observed = analysis.observed_fields || {};
      const values = analysis.values || {};
      const fieldRows = [
        [t('消息数量'), analysis.message_count],
        [t('元数据消息索引'), (analysis.metadata_message_indexes || []).join(', ') || '-'],
        [t('工作区路径'), values.workspace_path],
        [t('操作系统'), values.os_version],
        ['Shell', values.shell],
        [t('日期'), values.date],
        [t('Git/JJ 状态'), observed.git_status ? t('已读取') : t('未出现')],
        [t('项目布局'), observed.project_layout ? t('已读取') : t('未出现')],
      ];
      const blockRows = Object.entries(analysis.block_counts || {}).map(([name, count]) => `${escapeHtml(name)} × ${count}`).join('、') || '-';
      messagesHtml += `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('消息读取统计')}${'</span><div><div style="font-size:12px;margin-bottom:6px;">' + t('区块：')}${blockRows}</div>${fieldRows.map(([label, value]) => `<div style="display:flex;gap:8px;margin:3px 0;font-size:12px;"><span style="width:90px;color:var(--muted-foreground);">${escapeHtml(label)}</span><code style="white-space:pre-wrap;word-break:break-all;">${escapeHtml(value == null ? '-' : String(value))}</code></div>`).join('')}</div></div>`;
    }
    if (log.messages) {
      try {
        const msgs = typeof log.messages === 'string' ? JSON.parse(log.messages) : log.messages;
        const formatted = msgs.map(m => {
          const role = m.role === 'system' ? '🔧 System' : m.role === 'user' ? '👤 User' : '🤖 Assistant';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
          return `<div style="margin-bottom:8px;"><div style="font-size:11px;color:var(--muted-foreground);margin-bottom:2px;">${role}</div><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:200px;overflow-y:auto;">${escapeHtml(content)}</pre></div>`;
        }).join('');
        messagesHtml += `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('请求消息')}</span><div style="max-height:400px;overflow-y:auto;">${formatted}</div></div>`;
      } catch {
        messagesHtml = `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('请求消息')}</span><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:400px;overflow-y:auto;">${escapeHtml(String(log.messages))}</pre></div>`;
      }
    }

    let responseHtml = '';
    if (log.response) {
      responseHtml = `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('AI 回复')}</span><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:400px;overflow-y:auto;">${escapeHtml(log.response)}</pre></div>`;
    }

    const content = document.getElementById('usageDetailContent');
    setHTML(content, rows.map(([label, value]) => `
      <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--muted-foreground);font-size:13px;">${label}</span>
        <span style="font-size:14px;">${value}</span>
      </div>
    `).join('') + this._customInstructionsSectionHtml(log) + messagesHtml + responseHtml);

    // 截断文件「查看全部」展开/收起
    const customRoot = document.getElementById('usageDetailContent');
    if (customRoot) {
      customRoot.querySelectorAll('button[data-custom-inst-toggle]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-custom-inst-toggle'), 10);
          const pre = customRoot.querySelector(`pre[data-custom-inst-content="${idx}"]`);
          if (!pre) return;
          const hidden = pre.style.display === 'none';
          pre.style.display = hidden ? '' : 'none';
          btn.textContent = hidden ? t('收起') : t('查看全部');
        });
      });
    }

    document.getElementById('usageDetailModal').style.display = 'flex';
    document.getElementById('usageDetailModal').classList.add('active');
  }

  async saveAdminSettings(e) {
    e.preventDefault();

    const billingMode = document.querySelector('input[name="billingMode"]:checked')?.value || 'token';
    let refreshSec = parseInt(document.getElementById('statsRefreshInterval')?.value, 10);
    if (!Number.isFinite(refreshSec)) refreshSec = 10;
    refreshSec = Math.min(300, Math.max(3, refreshSec));
    // 收集模型列表
    const modelTags = document.querySelectorAll('#modelListTags .model-tag');
    const modelList = [];
    modelTags.forEach(tag => {
      modelList.push(tag.dataset.model);
    });
    const settings = {
      'app.name': document.getElementById('systemName').value,
      'defaultBalance': parseFloat(document.getElementById('defaultBalance').value),
      'defaultKeyExpiry': parseInt(document.getElementById('apiKeyExpiry').value),
      'billing_mode': billingMode,
      'rate_price_per_request': parseFloat(document.getElementById('ratePricePerRequest').value) || 0,
      'stats_refresh_interval_sec': refreshSec,
      'model_list': modelList
    };

    // 登录状态上报开关（默认开启）
    const loginReportEl = document.getElementById('loginReportEnabled');
    if (loginReportEl) settings['login_report_enabled'] = loginReportEl.checked;

    // 统计信息上报开关（默认开启）+ 上报粒度（默认 detailed）
    const statsReportEl = document.getElementById('statsReportEnabled');
    if (statsReportEl) settings['stats_report_enabled'] = statsReportEl.checked;
    const statsGranularityEl = document.getElementById('statsReportGranularity');
    if (statsGranularityEl) settings['stats_report_granularity'] = statsGranularityEl.value;

    try {
      const response = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      if (response.ok) {
        this._statsRefreshIntervalSec = refreshSec;
        // 若当前在统计信息页，按新间隔重启轮询
        this._startStatsRefreshTimer();
        const input = document.getElementById('statsRefreshInterval');
        if (input) input.value = String(refreshSec);
        alert(t('设置已保存'));
      } else {
        alert(t('保存失败'));
      }
    } catch (error) {
      console.error(t('保存设置失败:'), error);
      alert(t('保存失败'));
    }
  }

  async saveRetentionConfig(e) {
    e.preventDefault();
    const fields = ['CompressDays', 'CompressSizeGb', 'PurgeDays', 'PurgeSizeGb'];
    const values = {};
    for (const field of fields) {
      const value = Number(document.getElementById(`retention${field}`)?.value);
      if (!Number.isInteger(value) || value < 0) {
        alert(t('数据保留配置必须是非负整数'));
        return;
      }
      values[field] = value;
    }
    if (values.CompressDays && values.PurgeDays && values.CompressDays >= values.PurgeDays) {
      alert(t('压缩天数必须小于删除天数'));
      return;
    }
    if (values.CompressSizeGb && values.PurgeSizeGb && values.CompressSizeGb >= values.PurgeSizeGb) {
      alert(t('压缩大小必须小于删除大小'));
      return;
    }
    const btn = document.getElementById('retentionSaveBtn');
    if (btn) btn.disabled = true;
    try {
      const response = await fetch('/api/admin/retention-config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          compress_days: values.CompressDays, compress_size_gb: values.CompressSizeGb,
          purge_days: values.PurgeDays, purge_size_gb: values.PurgeSizeGb,
          agg_enabled: document.getElementById('retentionAggEnabled')?.checked === true,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const message = document.getElementById('retentionConfigMessage');
      if (!response.ok) throw new Error(t(data.code || '') || data.error || t('保存失败'));
      if (message) { message.textContent = t('数据保留配置已保存'); message.style.color = 'var(--success, #16a34a)'; }
    } catch (error) {
      const message = document.getElementById('retentionConfigMessage');
      if (message) { message.textContent = error.message; message.style.color = 'var(--destructive, #dc2626)'; }
    } finally { if (btn) btn.disabled = false; }
  }

  async runRetentionTask(kind, dryRun = false) {
    const suffix = kind === 'compress' ? 'Compress' : 'Purge';
    const button = document.getElementById(`retentionRun${dryRun ? suffix + 'Preview' : suffix}Btn`);
    if (!dryRun && !confirm(t('确认立即执行数据保留任务？'))) return;
    if (button) button.disabled = true;
    try {
      const response = await fetch(`/api/admin/retention/run-${kind}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dry_run: dryRun }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(t(data.code || '') || data.error || t('执行失败'));
      if (data.taskId) await this.pollRetentionTask(data.taskId);
    } catch (error) { alert(error.message); }
    finally { if (button) button.disabled = false; }
  }

  async pollRetentionTask(taskId) {
    for (let i = 0; i < 600; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await fetch(`/api/admin/retention/tasks/${encodeURIComponent(taskId)}`);
      const task = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(task.error || t('任务状态获取失败'));
      if (task.status === 'completed') { alert(`${t('任务完成')}\n${JSON.stringify(task.result || {}, null, 2)}`); return; }
      if (task.status === 'failed') throw new Error(t(task.error?.code || '') || task.error?.message || t('执行失败'));
    }
    throw new Error(t('任务执行超时'));
  }

  async loadSettings() {
    try {
      const response = await fetch('/api/admin/settings');
      if (!response.ok) return;
      const settings = await response.json();

      if (settings['app.name']) {
        document.getElementById('systemName').value = settings['app.name'];
      }
      if (settings['defaultBalance'] !== undefined) {
        document.getElementById('defaultBalance').value = settings['defaultBalance'];
      }
      if (settings['defaultKeyExpiry'] !== undefined) {
        document.getElementById('apiKeyExpiry').value = settings['defaultKeyExpiry'];
      }
      // 计费模式
      const billingMode = settings['billing_mode'] || 'token';
      const radio = document.querySelector(`input[name="billingMode"][value="${billingMode}"]`);
      if (radio) radio.checked = true;
      document.getElementById('ratePricePerRequest').value = settings['rate_price_per_request'] || 0.01;
      document.getElementById('ratePriceGroup').style.display = billingMode === 'rate' ? '' : 'none';

      // 统计信息刷新间隔
      let refreshSec = parseInt(settings['stats_refresh_interval_sec'], 10);
      if (!Number.isFinite(refreshSec)) refreshSec = 10;
      refreshSec = Math.min(300, Math.max(3, refreshSec));
      this._statsRefreshIntervalSec = refreshSec;
      const refreshInput = document.getElementById('statsRefreshInterval');
      if (refreshInput) refreshInput.value = String(refreshSec);
      // 若已在统计页，应用最新间隔
      this._startStatsRefreshTimer();

      // 数据保留配置
      const retentionResponse = await fetch('/api/admin/retention-config');
      if (retentionResponse.ok) {
        const retention = await retentionResponse.json();
        document.getElementById('retentionCompressDays').value = retention.compress_days;
        document.getElementById('retentionCompressSizeGb').value = retention.compress_size_gb;
        document.getElementById('retentionPurgeDays').value = retention.purge_days;
        document.getElementById('retentionPurgeSizeGb').value = retention.purge_size_gb;
        document.getElementById('retentionAggEnabled').checked = retention.agg_enabled !== false;
      }

      // 系统单代理
      const sysEnabledEl = document.getElementById('systemProxyEnabled');
      if (sysEnabledEl) sysEnabledEl.checked = !!settings['system_proxy_enabled'];
      const sysUrlEl = document.getElementById('systemProxyUrl');
      if (sysUrlEl) sysUrlEl.value = settings['system_proxy_url'] || '';

      // 登录状态上报开关（默认开启）
      const loginReportEl = document.getElementById('loginReportEnabled');
      if (loginReportEl) loginReportEl.checked = settings['login_report_enabled'] !== false;

      // 统计信息上报开关（默认开启）+ 上报粒度（默认 detailed）
      const statsReportEl = document.getElementById('statsReportEnabled');
      if (statsReportEl) statsReportEl.checked = settings['stats_report_enabled'] !== false;
      const statsGranularityEl = document.getElementById('statsReportGranularity');
      if (statsGranularityEl) statsGranularityEl.value = settings['stats_report_granularity'] || 'detailed';

      // 全局代理池设置
      const subEl = document.getElementById('globalProxySubUrl');
      if (subEl) subEl.value = settings['proxy_pool_subscription_url'] || '';
      this._globalProxyPool = settings['proxy_pool_manual_proxies'] || [];
      this.renderGlobalProxyPoolList();

      // 可用模型列表
      this._modelList = settings['model_list'] || ['claude-fable-5', 'crew-router'];
      this.renderModelList();

      // 飞书登录配置
      await this.loadFeishuLoginSettings();
    } catch (error) {
      console.error(t('加载设置失败:'), error);
    }
  }

  async loadFeishuLoginSettings() {
    try {
      console.log(t('[飞书配置] 正在加载…'));
      const response = await fetch('/api/admin/feishu-login');
      if (!response.ok) {
        console.warn(t('[飞书配置] 加载失败, status='), response.status);
        return;
      }
      const data = await response.json();
      console.log(t('[飞书配置] 加载成功:'), {
        enabled: data.enabled,
        hasAppId: !!data.appId,
        hasAppSecret: data.hasAppSecret,
        source: data.source,
        redirectUri: data.redirectUri,
      });

      const enabledEl = document.getElementById('feishuEnabled');
      const appIdEl = document.getElementById('feishuAppId');
      const secretEl = document.getElementById('feishuAppSecret');
      const tenantEl = document.getElementById('feishuTenantKey');
      const redirectEl = document.getElementById('feishuRedirectUri');
      const secretHint = document.getElementById('feishuSecretHint');
      const sourceEl = document.getElementById('feishuConfigSource');

      if (enabledEl) enabledEl.checked = !!data.enabled;
      if (appIdEl) appIdEl.value = data.appId || '';
      if (secretEl) secretEl.value = '';
      if (tenantEl) tenantEl.value = data.tenantKey || '';
      if (redirectEl) redirectEl.value = data.redirectUri || '';
      if (secretHint) secretHint.style.display = data.hasAppSecret ? 'block' : 'none';
      if (sourceEl) {
        const sourceLabel = data.source === 'config' ? t('配置文件/环境变量（尚未在后台保存）') : t('数据库设置');
        sourceEl.textContent = `${t('当前配置来源：')}${sourceLabel}`;
      }
      this._feishuHasSecret = !!data.hasAppSecret;
    } catch (error) {
      console.error(t('[飞书配置] 加载异常:'), error);
    }
  }

  // 渲染可用模型列表标签
  renderModelList() {
    const container = document.getElementById('modelListTags');
    if (!container) return;
    const modelList = this._modelList || [];
    container.innerHTML = modelList.map(m => `
      <span class="model-tag" data-model="${escapeHtml(m)}" style="display:inline-flex;align-items:center;gap:4px;background:var(--primary);color:#fff;padding:2px 10px;border-radius:12px;font-size:12px;">
        ${escapeHtml(m)}
        ${m !== 'fusion' ? '<span class="model-tag-remove" style="cursor:pointer;margin-left:2px;opacity:0.7;" title="删除">&times;</span>' : ''}
      </span>
    `).join('');

    // 绑定删除事件
    container.querySelectorAll('.model-tag-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.closest('.model-tag');
        const model = tag.dataset.model;
        this._modelList = this._modelList.filter(m => m !== model);
        this.renderModelList();
      });
    });
  }

  async saveFeishuLoginSettings() {
    const enabled = document.getElementById('feishuEnabled')?.checked === true;
    const appId = (document.getElementById('feishuAppId')?.value || '').trim();
    const appSecret = (document.getElementById('feishuAppSecret')?.value || '').trim();
    const tenantKey = (document.getElementById('feishuTenantKey')?.value || '').trim();
    const btn = document.getElementById('feishuSaveBtn');

    if (enabled && !appId) {
      alert(t('启用飞书登录时必须填写 App ID'));
      return;
    }
    if (enabled && !appSecret && !this._feishuHasSecret) {
      alert(t('启用飞书登录时必须填写 App Secret'));
      return;
    }

    const payload = {
      enabled,
      appId,
      appSecret: appSecret || undefined,
      tenantKey,
    };
    console.log(t('[飞书配置] 正在保存…'), {
      enabled,
      appId: appId ? appId.slice(0, 8) + '…' : '',
      secretProvided: !!appSecret,
      tenantKey: tenantKey ? t('已设置') : t('未设置'),
    });

    if (btn) {
      btn.disabled = true;
      setButtonLoading(btn, t('保存中…'));
    }

    try {
      const response = await fetch('/api/admin/feishu-login', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error(t('[飞书配置] 保存失败:'), data);
        alert(data.error || t('保存失败'));
        return;
      }
      console.log(t('[飞书配置] 保存成功:'), data);
      alert(t('飞书登录配置已保存'));
      await this.loadFeishuLoginSettings();
    } catch (error) {
      console.error(t('[飞书配置] 保存异常:'), error);
      alert(t('保存失败'));
    } finally {
      if (btn) {
        btn.disabled = false;
        clearButtonLoading(btn, t('保存飞书配置'));
      }
    }
  }

  async copyFeishuRedirectUri() {
    const el = document.getElementById('feishuRedirectUri');
    const value = el?.value || '';
    if (!value) {
      alert(t('回调地址为空'));
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      console.log(t('[飞书配置] 已复制回调地址:'), value);
      alert(t('回调地址已复制'));
    } catch (err) {
      console.warn(t('[飞书配置] 剪贴板复制失败，尝试选中输入框'), err);
      el.select();
      document.execCommand('copy');
      alert(t('回调地址已复制'));
    }
  }

  // 批量设置固定价格
  showBatchSetPricesModal() {
    const count = this.selectedModels.size;
    if (count === 0) return;
    document.getElementById('batchSetPricesCount').textContent = count;
    document.getElementById('batchSetInputPrice').value = '0.01';
    document.getElementById('batchSetOutputPrice').value = '0.01';
    document.getElementById('batchSetCachedOutputPrice').value = '0';
    document.getElementById('batchSetPricesModal').style.display = 'flex';
    document.getElementById('batchSetPricesModal').classList.add('active');
  }

  async executeBatchSetPrices() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;

    const input_price = parseFloat(document.getElementById('batchSetInputPrice').value);
    const output_price = parseFloat(document.getElementById('batchSetOutputPrice').value);

    if (isNaN(input_price) || isNaN(output_price)) {
      alert(t('请输入有效的价格'));
      return;
    }

    try {
      const response = await fetch('/api/admin/models/batch-update-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          mode: 'set',
          input_price_per_1k_tokens: input_price,
          output_price_per_1k_tokens: output_price
        })
      });

      if (response.ok) {
        this.closeModals();
        this.loadModels();
        alert(t('价格设置成功'));
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || t('设置失败'));
      }
    } catch (error) {
      console.error(t('批量设置价格失败:'), error);
      alert(t('设置失败'));
    }
  }

  // JSON 批量定价
  showBatchJsonPricesModal() {
    document.getElementById('batchJsonPricesInput').value = '';
    document.getElementById('batchJsonPricesResult').style.display = 'none';
    document.getElementById('batchJsonPricesModal').style.display = 'flex';
    document.getElementById('batchJsonPricesModal').classList.add('active');
  }

  async exportModelsCsv() {
    let data = [];
    try {
      if (this.selectedModels && this.selectedModels.size > 0) {
        // 导出选中项：从当前页 + 必要时全量筛选列表中匹配
        const selected = this.selectedModels;
        const fromPage = (this.modelsData || []).filter(m => selected.has(m.id));
        if (fromPage.length === selected.size) {
          data = fromPage;
        } else {
          // 选中跨页：拉取筛选全集再过滤
          data = await this._fetchAllFilteredModels();
          data = data.filter(m => selected.has(m.id));
        }
      } else {
        data = await this._fetchAllFilteredModels();
      }
    } catch (e) {
      alert(e.message || t('导出失败'));
      return;
    }

    if (!data || data.length === 0) {
      alert(t('暂无模型数据'));
      return;
    }

    const headers = [t('上游模型ID'), t('名称'), t('别名'), t('供应商'), t('系列'), t('描述'), t('输入价/百万Token'), t('输出价/百万Token'), t('速率限制RPM'), t('速率限制TPM'), t('状态')];
    const rows = data.map(m => [
      m.upstream_model_id || '',
      m.name || '',
      m.alias || '',
      m.provider_name || m.provider || '',
      m.series || '',
      (m.description || '').replace(/"/g, '""'),
      m.input_price_per_1k_tokens || 0,
      m.output_price_per_1k_tokens || 0,
      m.rate_limit_rpm || 0,
      m.rate_limit_tpm || 0,
      m.enabled ? t('启用') : t('禁用')
    ]);

    const csvContent = '\uFEFF' + [headers, ...rows].map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `models_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * 导出供应商配置为 CSV（基于当前筛选结果）
   */
  async exportProvidersCsv() {
    // 按当前筛选条件分页拉取全量后导出（不加载到界面）
    let providers = [];
    try {
      this.showToast(t('正在导出…'), 'info');
      const pageSize = 200;
      let page = 1;
      let total = Infinity;
      while ((page - 1) * pageSize < total) {
        const params = this._buildProviderListParams(page - 1);
        params.set('page', String(page));
        params.set('limit', String(pageSize));
        const res = await fetch(`/api/admin/providers?${params}`);
        if (!res.ok) throw new Error(t('导出失败'));
        const raw = await res.json();
        const { items, total: t } = this._normalizeListResponse(raw);
        total = t;
        providers = providers.concat(items);
        if (!items.length) break;
        page++;
        if (page > 500) break;
      }
    } catch (e) {
      this.showToast(e.message || t('导出失败'), 'error');
      return;
    }

    if (!providers.length) {
      this.showToast(t('暂无供应商数据可导出'), 'info');
      return;
    }

    const headers = [t('名称'), 'Base URL', t('格式'), t('密钥模式'), t('备注'), t('分组'),
                     t('模型同步地址'), t('额度查询'), t('代理'), t('状态'), t('创建者'), t('创建时间')];
    const rows = providers.map(p => {
      const isScriptKey = (p.key_mode || 'fixed') === 'script';
      let proxyEnabled = t('关闭');
      if (p.proxy_enabled) {
        if ((p.proxy_mode || 'pool') === 'single') {
          proxyEnabled = p.proxy_use_system ? t('系统代理') : (p.proxy_url ? t('单代理') : t('未配置'));
        } else {
          proxyEnabled = t('代理池');
        }
      }
      // 列表接口已脱敏，仅展示是否已配置 / 多 Key 数量 / 脚本模式
      const keyCount = p.api_key_count || 0;
      const keyDisplay = isScriptKey
        ? t('脚本刷新')
        : (keyCount > 1
          ? `${t('已配置')}${keyCount}${t('个')}${p.api_key_select_mode === 'weight' ? t('·权重') : t('·顺序')}`
          : (p.has_api_key || p.api_key || keyCount > 0 ? t('已配置') : t('未配置')));
      return [
        p.name || '',
        p.base_url || '',
        p.format || 'openai',
        keyDisplay,
        (p.notes || '').replace(/"/g, '""'),
        p.grp || '',
        p.models_url || '',
        p.quota_enabled ? t('启用') : t('关闭'),
        proxyEnabled,
        p.enabled ? t('启用') : t('禁用'),
        p.username || (p.created_by ? t('用户') : t('系统')) || '',
        p.created_at ? new Date(p.created_at).toLocaleString('zh-CN') : ''
      ];
    });

    const csvContent = '\uFEFF' + [headers, ...rows].map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `providers_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    this.showToast(`${t('已导出')}${providers.length}${t('条')}`, 'success');
  }

  async executeBatchJsonPrices() {
    const input = document.getElementById('batchJsonPricesInput').value.trim();
    const resultEl = document.getElementById('batchJsonPricesResult');

    if (!input) {
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('请输入 JSON 数据');
      return;
    }

    let prices;
    try {
      prices = JSON.parse(input);
    } catch (e) {
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('JSON 格式错误: ') + e.message;
      return;
    }

    if (typeof prices !== 'object' || Array.isArray(prices) || Object.keys(prices).length === 0) {
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('JSON 格式不正确，需要是 { "model-id": {"in": 价格, "out": 价格} } 的对象');
      return;
    }

    try {
      const response = await fetch('/api/admin/models/batch-set-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices })
      });

      const data = await response.json();
      if (response.ok) {
        let msg = `${t('已更新')}${data.updated}${t('个模型的价格')}`;
        if (data.notFound && data.notFound.length > 0) {
          msg += `${t('\\n未找到的模型:')}${data.notFound.join(', ')}`;
        }
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--success)';
        resultEl.textContent = msg;
        this.loadModels();
        setTimeout(() => this.closeModals(), 1500);
      } else {
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--destructive)';
        resultEl.textContent = data.error || t('设置失败');
      }
    } catch (error) {
      console.error(t('JSON 批量定价失败:'), error);
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('请求失败: ') + error.message;
    }
  }

  // JSON 批量定参考价
  showBatchJsonRefPricesModal() {
    document.getElementById('batchJsonRefPricesInput').value = '';
    document.getElementById('batchJsonRefPricesResult').style.display = 'none';
    document.getElementById('batchJsonRefPricesModal').style.display = 'flex';
    document.getElementById('batchJsonRefPricesModal').classList.add('active');
  }

  async executeBatchJsonRefPrices() {
    const input = document.getElementById('batchJsonRefPricesInput').value.trim();
    const resultEl = document.getElementById('batchJsonRefPricesResult');

    if (!input) {
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('请输入 JSON 数据');
      return;
    }

    let prices;
    try {
      prices = JSON.parse(input);
    } catch (e) {
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('JSON 格式错误: ') + e.message;
      return;
    }

    if (typeof prices !== 'object' || Array.isArray(prices) || Object.keys(prices).length === 0) {
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('JSON 格式不正确，需要是 { "model-id": {"in": 价格, "out": 价格} } 的对象');
      return;
    }

    try {
      const response = await fetch('/api/admin/models/batch-set-reference-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices })
      });

      const data = await response.json();
      if (response.ok) {
        let msg = `${t('已更新')}${data.updated}${t('个模型的参考价')}`;
        if (data.notFound && data.notFound.length > 0) {
          msg += `${t('\\n未找到的模型:')}${data.notFound.join(', ')}`;
        }
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--success)';
        resultEl.textContent = msg;
        this.loadModels();
        setTimeout(() => this.closeModals(), 1500);
      } else {
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--destructive)';
        resultEl.textContent = data.error || t('设置失败');
      }
    } catch (error) {
      console.error(t('JSON 批量定参考价失败:'), error);
      resultEl.style.display = 'block';
      resultEl.style.color = 'var(--destructive)';
      resultEl.textContent = t('请求失败: ') + error.message;
    }
  }

  // 批量按比例调整价格
  showBatchAdjustPricesModal() {
    const count = this.selectedModels.size;
    if (count === 0) return;
    document.getElementById('batchAdjustPricesCount').textContent = count;
    document.getElementById('batchAdjustPercentage').value = '10';
    document.getElementById('batchAdjustPricesModal').style.display = 'flex';
    document.getElementById('batchAdjustPricesModal').classList.add('active');
  }

  async executeBatchAdjustPrices() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;

    const percentage = parseFloat(document.getElementById('batchAdjustPercentage').value);
    if (isNaN(percentage)) {
      alert(t('请输入有效的百分比'));
      return;
    }

    if (!await confirm(`${t('确定要将选中')}${ids.length}${t('个模型的价格')}${percentage >= 0 ? t('上涨') : t('下降')} ${Math.abs(percentage)}${t('% 吗？')}`)) {
      return;
    }

    try {
      const response = await fetch('/api/admin/models/batch-update-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          mode: 'multiply',
          percentage
        })
      });

      if (response.ok) {
        this.closeModals();
        this.loadModels();
        alert(t('价格调整成功'));
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || t('调整失败'));
      }
    } catch (error) {
      console.error(t('批量调整价格失败:'), error);
      alert(t('调整失败'));
    }
  }

  // 批量设置速率限制
  showBatchSetRateLimitModal() {
    const count = this.selectedModels.size;
    if (count === 0) return;
    document.getElementById('batchSetRateLimitCount').textContent = count;
    document.getElementById('batchRateLimitRpm').value = '0';
    document.getElementById('batchRateLimitTpm').value = '0';
    document.getElementById('batchSetRateLimitModal').style.display = 'flex';
    document.getElementById('batchSetRateLimitModal').classList.add('active');
  }

  async executeBatchSetRateLimit() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;

    const rate_limit_rpm = parseInt(document.getElementById('batchRateLimitRpm').value) || 0;
    const rate_limit_tpm = parseInt(document.getElementById('batchRateLimitTpm').value) || 0;

    try {
      const response = await fetch('/api/admin/models/batch-update-ratelimit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          rate_limit_rpm,
          rate_limit_tpm
        })
      });

      if (response.ok) {
        this.closeModals();
        this.loadModels();
        alert(t('速率限制设置成功'));
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || t('设置失败'));
      }
    } catch (error) {
      console.error(t('批量设置速率限制失败:'), error);
      alert(t('设置失败'));
    }
  }

  // ========== 批量修改模型说明 ==========

  showBatchEditDescModal() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;
    
    document.getElementById('batchEditDescCount').textContent = ids.length;
    
    // 显示选中的模型列表
    const listEl = document.getElementById('batchEditDescModelsList');
    const selectedModels = this.modelsData.filter(m => ids.includes(m.id));
    setHTML(listEl, selectedModels.map(m => `
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
        <span>${escapeHtml(m.upstream_model_id || m.name || m.id)}</span>
        <span style="color:var(--muted-foreground);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.description || '-')}</span>
      </div>
    `).join(''));
    
    document.getElementById('batchDescMode').value = 'replace';
    document.getElementById('batchDescValue').value = '';
    document.getElementById('batchEditDescStatus').style.display = 'none';
    document.getElementById('batchDescValue').placeholder = t('输入新的模型说明...');
    
    document.getElementById('batchEditDescModal').style.display = 'flex';
    document.getElementById('batchEditDescModal').classList.add('active');
  }

  toggleBatchDescMode() {
    const mode = document.getElementById('batchDescMode').value;
    const textarea = document.getElementById('batchDescValue');
    
    switch (mode) {
      case 'replace':
        textarea.placeholder = t('输入新的模型说明...');
        break;
      case 'append':
        textarea.placeholder = t('输入要追加的内容...');
        break;
      case 'prepend':
        textarea.placeholder = t('输入要前置的内容...');
        break;
    }
  }

  async executeBatchEditDesc() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;
    
    const mode = document.getElementById('batchDescMode').value;
    const value = document.getElementById('batchDescValue').value.trim();
    const statusEl = document.getElementById('batchEditDescStatus');
    
    if (!value) {
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(239,68,68,0.1)';
      statusEl.style.color = 'var(--destructive)';
      statusEl.textContent = t('请输入说明内容');
      return;
    }
    
    // 根据模式构建更新数据
    const updates = {};
    if (mode === 'replace') {
      updates.description = value;
    } else {
      // 对于追加/前置模式，需要获取现有说明
      updates.description = value;
      updates._mode = mode;
    }
    
    try {
      const response = await fetch('/api/admin/models/batch-update-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          description: value,
          mode
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(34,197,94,0.1)';
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = `${t('成功更新')}${result.updated || ids.length}${t('个模型的说明')}`;
        setTimeout(() => {
          this.closeModals();
          this.loadModels();
        }, 1500);
      } else {
        const err = await response.json().catch(() => ({}));
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(239,68,68,0.1)';
        statusEl.style.color = 'var(--destructive)';
        statusEl.textContent = err.error || t('更新失败');
      }
    } catch (error) {
      console.error(t('批量修改说明失败:'), error);
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(239,68,68,0.1)';
      statusEl.style.color = 'var(--destructive)';
      statusEl.textContent = t('网络错误: ') + error.message;
    }
  }

  showBatchSetSeriesModal() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;
    
    document.getElementById('batchSetSeriesCount').textContent = ids.length;
    
    const listEl = document.getElementById('batchSetSeriesModelsList');
    const selectedModels = this.modelsData.filter(m => ids.includes(m.id));
    setHTML(listEl, selectedModels.map(m => `
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
        <span>${escapeHtml(m.upstream_model_id || m.name || m.id)}</span>
        <span style="color:var(--muted-foreground);">当前系列: ${escapeHtml(m.series || t('无'))}</span>
      </div>
    `).join(''));
    
    document.getElementById('batchSeriesValue').value = '';
    document.getElementById('batchSetSeriesStatus').style.display = 'none';
    
    document.getElementById('batchSetSeriesModal').style.display = 'flex';
    document.getElementById('batchSetSeriesModal').classList.add('active');
  }

  async executeBatchSetSeries() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;
    
    const series = document.getElementById('batchSeriesValue').value.trim();
    const statusEl = document.getElementById('batchSetSeriesStatus');
    
    try {
      const response = await fetch('/api/admin/models/batch-update-series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, series })
      });
      
      if (response.ok) {
        const result = await response.json();
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(34,197,94,0.1)';
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = `${t('成功设置')}${result.updated || ids.length}${t('个模型的系列')}`;
        setTimeout(() => {
          this.closeModals();
          this.loadModels();
        }, 1500);
      } else {
        const err = await response.json().catch(() => ({}));
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(239,68,68,0.1)';
        statusEl.style.color = 'var(--destructive)';
        statusEl.textContent = err.error || t('设置失败');
      }
    } catch (error) {
      console.error(t('批量设置系列失败:'), error);
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(239,68,68,0.1)';
      statusEl.style.color = 'var(--destructive)';
      statusEl.textContent = t('网络错误: ') + error.message;
    }
  }

  // 系列图标管理
  async showSeriesIconsModal() {
    document.getElementById('seriesIconsModal').style.display = 'flex';
    document.getElementById('seriesIconsModal').classList.add('active');
    await this.loadSeriesNames();
    await this.loadSeriesIcons();
  }

  async loadSeriesNames() {
    try {
      const select = document.getElementById('newSeriesName');
      setHTML(select, '<option value="">' + t('选择系列...') + '</option>');
      const seriesSet = new Set();
      this.modelsData.forEach(m => {
        if (m.series) seriesSet.add(m.series);
      });
      Array.from(seriesSet).sort().forEach(name => {
        appendHTML(select, `<option value="${name}">${name}</option>`);
      });
    } catch (error) {
      console.error(t('加载系列列表失败:'), error);
    }
  }

  async loadSeriesIcons() {
    try {
      const response = await fetch('/api/admin/series-icons');
      if (!response.ok) return;
      const icons = await response.json();
      const listEl = document.getElementById('seriesIconsList');
      if (icons.length === 0) {
        setHTML(listEl, '<div style="text-align:center;color:var(--muted-foreground);padding:20px;">' + t('暂无系列图标') + '</div>');
        return;
      }
      setHTML(listEl, icons.map(icon => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
          ${icon.icon_url ? `<img src="${icon.icon_url}" style="width:32px;height:32px;object-fit:contain;border-radius:4px;" onerror="this.style.display='none'">` : '<div style="width:32px;height:32px;background:var(--muted);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted-foreground);">' + t('无') + '</div>'}
          <div style="flex:1;">
            <div style="font-weight:500;">${icon.name}</div>
            <div style="font-size:12px;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${icon.icon_url || t('未设置图标')}</div>
          </div>
          <button class="btn btn-icon" title="${t('编辑')}" onclick="adminApp.editSeriesIcon('${icon.name}', '${icon.icon_url || ''}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn btn-icon" title="${t('删除')}" onclick="adminApp.deleteSeriesIcon('${icon.name}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      `).join(''));
    } catch (error) {
      console.error(t('加载系列图标失败:'), error);
    }
  }

  async addSeriesIcon() {
    const name = document.getElementById('newSeriesName').value.trim();
    const icon_url = document.getElementById('newSeriesIconUrl').value.trim();
    if (!name) {
      alert(t('请输入系列名称'));
      return;
    }
    try {
      const response = await fetch('/api/admin/series-icons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, icon_url })
      });
      if (response.ok) {
        document.getElementById('newSeriesName').value = '';
        document.getElementById('newSeriesIconUrl').value = '';
        await this.loadSeriesIcons();
      } else {
        alert(t('添加失败'));
      }
    } catch (error) {
      alert(t('网络错误: ') + error.message);
    }
  }

  editSeriesIcon(name, currentUrl) {
    const newUrl = prompt(`${t('设置 "')}${name}${t('" 的图标 URL:')}`, currentUrl);
    if (newUrl === null) return;
    fetch('/api/admin/series-icons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon_url: newUrl })
    }).then(() => this.loadSeriesIcons());
  }

  async deleteSeriesIcon(name) {
    if (!await confirm(`${t('确定要删除系列 "')}${name}${t('" 的图标配置吗？')}`)) return;
    try {
      await fetch(`/api/admin/series-icons/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await this.loadSeriesIcons();
    } catch (error) {
      alert(t('删除失败: ') + error.message);
    }
  }

  // 按参考价百分比批量设置价格
  showBatchAdjustByRefModal() {
    const count = this.selectedModels.size;
    if (count === 0) return;
    document.getElementById('batchAdjustByRefCount').textContent = count;
    document.getElementById('batchRefInputPct').value = '100';
    document.getElementById('batchRefOutputPct').value = '100';
    document.getElementById('batchAdjustByRefPreview').style.display = 'none';
    clearChildren(document.getElementById('batchAdjustByRefPreviewBody'));
    document.getElementById('batchAdjustByRefStatus').style.display = 'none';
    document.getElementById('batchAdjustByRefConfirmBtn').style.display = 'none';
    document.getElementById('batchAdjustByRefModal').style.display = 'flex';
    document.getElementById('batchAdjustByRefModal').classList.add('active');
  }

  async previewBatchAdjustByRef() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;

    const inputPct = parseFloat(document.getElementById('batchRefInputPct').value);
    const outputPct = parseFloat(document.getElementById('batchRefOutputPct').value);

    if (isNaN(inputPct) || isNaN(outputPct)) {
      alert(t('请输入有效的百分比'));
      return;
    }

    try {
      const response = await fetch('/api/admin/models/batch-adjust-by-reference-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, input_pct: inputPct, output_pct: outputPct })
      });

      if (response.ok) {
        const data = await response.json();
        const tbody = document.getElementById('batchAdjustByRefPreviewBody');
        setHTML(tbody, data.preview.map(m => `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);">${m.name || m.id}</td>
            <td style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);">¥${m.current_input.toFixed(4)}</td>
            <td style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--muted-foreground);">${m.ref_input > 0 ? '¥' + m.ref_input.toFixed(4) : '-'}</td>
            <td style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);font-weight:600;color:var(--brand-blue);">${m.new_input != null ? '¥' + m.new_input.toFixed(4) : '-'}</td>
            <td style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);">¥${m.current_output.toFixed(4)}</td>
            <td style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--muted-foreground);">${m.ref_output > 0 ? '¥' + m.ref_output.toFixed(4) : '-'}</td>
            <td style="padding:6px 8px;text-align:right;border-bottom:1px solid var(--border);font-weight:600;color:var(--brand-blue);">${m.new_output != null ? '¥' + m.new_output.toFixed(4) : '-'}</td>
          </tr>
        `).join(''));
        document.getElementById('batchAdjustByRefPreview').style.display = 'block';
        document.getElementById('batchAdjustByRefConfirmBtn').style.display = 'inline-flex';
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || t('预览失败'));
      }
    } catch (error) {
      console.error(t('预览失败:'), error);
      alert(t('预览失败: ') + error.message);
    }
  }

  async executeBatchAdjustByRef() {
    const ids = [...this.selectedModels];
    if (ids.length === 0) return;

    const inputPct = parseFloat(document.getElementById('batchRefInputPct').value);
    const outputPct = parseFloat(document.getElementById('batchRefOutputPct').value);

    if (isNaN(inputPct) || isNaN(outputPct)) {
      alert(t('请输入有效的百分比'));
      return;
    }

    if (!await confirm(`${t('确定要将选中的')}${ids.length}${t('个模型的价格设置为参考价的')}${inputPct}%/${outputPct}${t('% 吗？')}`)) {
      return;
    }

    const statusEl = document.getElementById('batchAdjustByRefStatus');
    try {
      const response = await fetch('/api/admin/models/batch-adjust-by-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, input_pct: inputPct, output_pct: outputPct })
      });

      if (response.ok) {
        const result = await response.json();
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = `${t('成功设置')}${result.updated || ids.length}${t('个模型的价格')}`;
        this.loadModels();
        setTimeout(() => this.closeModals(), 1500);
      } else {
        const err = await response.json().catch(() => ({}));
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--destructive)';
        statusEl.textContent = err.error || t('设置失败');
      }
    } catch (error) {
      console.error(t('按参考价设置价格失败:'), error);
      statusEl.style.display = 'block';
      statusEl.style.color = 'var(--destructive)';
      statusEl.textContent = t('设置失败: ') + error.message;
    }
  }

  // ==================== 用户组管理 ====================

  userGroupPageGo(page) {
    this.userGroupPage = page;
    this.renderUserGroupsList(this._userGroupsData || []);
  }

  async loadUserGroups() {
    console.log(t('[用户组] 开始加载用户组列表'));
    const listEl = document.getElementById('userGroupsList') || document.getElementById('adminUserGroupsList');
    if (listEl) setHTML(listEl, pageLoadingHtml(t('加载用户组...')));
    try {
      const response = await fetch('/api/admin/user-groups');
      console.log(t('[用户组] API 响应状态:'), response.status);
      if (!response.ok) throw new Error(t('加载失败'));
      const groups = await response.json();
      console.log(t('[用户组] 获取到用户组数据:'), groups);
      this.renderUserGroupsList(groups);
    } catch (error) {
      console.error(t('[用户组] 加载用户组列表失败:'), error);
    }
  }

  filterUserGroups() {
    this._debounceSearch('_userGroupFilterTimer', () => {
      this.userGroupPage = 0;
      this.renderUserGroupsList(this._userGroupsData || []);
    });
  }

  renderUserGroupsList(groups) {
    console.log(t('[用户组] 渲染用户组列表, 数量:'), groups.length);
    this._userGroupsData = groups || [];
    const all = this._userGroupsData;
    const q = this._searchQ('userGroupSearchInput');
    const filtered = q
      ? all.filter(g => this._matchSearch(q, g.name, g.description))
      : all;

    // 统计卡片基于全量
    const defaultCount = all.filter(g => g.is_default).length;
    const totalRules = all.reduce((s, g) => s + (parseInt(g.rule_count) || 0), 0);
    const totalMembers = all.reduce((s, g) => s + (parseInt(g.member_count) || 0), 0);

    const statsContainer = document.getElementById('userGroupStatsCards');
    if (statsContainer) {
      setHTML(statsContainer, `
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon blue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${all.length}</span>
            <span class="admin-stat-card-label">用户组数</span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${defaultCount}</span>
            <span class="admin-stat-card-label">默认组</span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon amber">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${totalRules}</span>
            <span class="admin-stat-card-label">速率规则</span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon purple">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${totalMembers}</span>
            <span class="admin-stat-card-label">总成员数</span>
          </div>
        </div>
      `);
    }

    const container = document.getElementById('userGroupsList');
    if (!container) {
      console.error(t('[用户组] 找不到 userGroupsList 容器'));
      return;
    }

    const countEl = document.getElementById('userGroupCount');
    if (countEl) {
      countEl.textContent = filtered.length === all.length
        ? `${t('共')}${all.length}${t('个')}`
        : `${t('显示')}${filtered.length} / ${all.length}`;
    }

    if (!all.length) {
      setHTML(container, '<div class="empty-state">' + t('暂无用户组，点击右上角创建') + '</div>');
    } else if (!filtered.length) {
      setHTML(container, '<div class="empty-state">' + t('未找到匹配的用户组') + '</div>');
    } else {
      const pg = this._paginate(filtered, this.userGroupPage, this.userGroupPageSize);
      this.userGroupPage = pg.page;
      setHTML(container, `<table class="data-table"><thead><tr>
        <th>名称</th><th>描述</th><th>成员数</th><th>规则数</th><th>默认</th><th>创建时间</th><th>操作</th>
      </tr></thead><tbody>${pg.items.map(g => `<tr>
        <td>${escapeHtml(g.name)}</td>
        <td>${escapeHtml(g.description || '-')}</td>
        <td>${g.member_count}</td>
        <td>${g.rule_count}</td>
        <td>${g.is_default ? '<span style="background:rgba(34,197,94,0.1);color:var(--success);padding:2px 10px;border-radius:12px;font-size:12px;font-weight:500;">' + t('默认') + '</span>' : '-'}</td>
        <td>${new Date(g.created_at).toLocaleDateString()}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          ${g.is_default
            ? '<button class="btn btn-sm btn-secondary" disabled style="opacity:0.5;">' + t('✓ 默认') + '</button>'
            : `<button class="btn btn-sm btn-secondary" onclick="adminApp.setDefaultGroup(${g.id})">${t('设为默认')}</button>`}
          <button class="btn btn-sm btn-primary" onclick="adminApp.showUserGroupDetail(${g.id})">管理</button>
        </td>
      </tr>`).join('')}</tbody></table>
      ${pg.totalPages > 1 ? this._renderPagination('userGroup', pg.page, pg.totalPages, pg.total) : ''}`);
    }

    // 绑定创建按钮事件
    const createBtn = document.getElementById('createUserGroupBtn');
    console.log(t('[用户组] 创建按钮元素:'), createBtn);
    if (createBtn) {
      createBtn.onclick = () => {
        console.log(t('[用户组] 创建按钮被点击'));
        this.showCreateUserGroupModal();
      };
      console.log(t('[用户组] 创建按钮事件已绑定'));
    } else {
      console.error(t('[用户组] 找不到 createUserGroupBtn 按钮'));
    }
  }

  async setDefaultGroup(groupId) {
    try {
      const res = await fetch(`/api/admin/user-groups/${groupId}/set-default`, { method: 'PUT' });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || t('设置失败'));
        return;
      }
      this.loadUserGroups();
    } catch (e) {
      alert(t('设置失败: ') + e.message);
    }
  }

  showCreateUserGroupModal() {
    console.log(t('[用户组] 打开创建用户组弹窗'));

    const content = `
      <div style="display:grid;gap:12px;">
        <div class="form-group">
          <label>用户组名称</label>
          <input type="text" id="userGroupNameInput" class="form-input" placeholder="${t('例如：VIP用户')}">
        </div>
        <div class="form-group">
          <label>描述</label>
          <textarea id="userGroupDescInput" class="form-input" rows="3" placeholder="${t('可选描述')}"></textarea>
        </div>
      </div>
    `;

    const modal = Dialog.showModal({
      title: t('创建用户组'),
      content: content,
      footer: `<button class="btn btn-primary" id="confirmCreateUserGroup">${t('创建')}</button>`
    });
    console.log(t('[用户组] 弹窗已显示:'), modal);

    const confirmBtn = document.getElementById('confirmCreateUserGroup');
    console.log(t('[用户组] 确认按钮:'), confirmBtn);

    if (confirmBtn) {
      confirmBtn.onclick = async () => {
        console.log(t('[用户组] 确认创建按钮被点击'));
        const name = document.getElementById('userGroupNameInput').value.trim();
        const description = document.getElementById('userGroupDescInput').value.trim();
        console.log(t('[用户组] 输入数据:'), { name, description });
        if (!name) { alert(t('名称不能为空')); return; }
        try {
          console.log(t('[用户组] 发送创建请求...'));
          const res = await fetch('/api/admin/user-groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
          });
          console.log(t('[用户组] 创建响应状态:'), res.status);
          if (!res.ok) {
            const err = await res.json();
            console.error(t('[用户组] 创建失败:'), err);
            alert(err.error || t('创建失败'));
            return;
          }
          console.log(t('[用户组] 创建成功'));
          modal.close();
          this.loadUserGroups();
        } catch (e) {
          console.error(t('[用户组] 创建请求异常:'), e);
          alert(t('创建失败'));
        }
      };
    }
  }

  async showUserGroupDetail(groupId) {
    this.currentGroupId = groupId;
    document.getElementById('userGroupDetailPanel').style.display = 'block';

    // 加载用户组规则
    this.loadUserGroupRules(groupId);
    // 加载用户组成员
    this.loadUserGroupMembers(groupId);

    // 绑定按钮事件
    document.getElementById('editUserGroupBtn').onclick = () => this.showEditUserGroupModal(groupId);
    document.getElementById('deleteUserGroupBtn').onclick = () => this.deleteUserGroup(groupId);
    document.getElementById('addUserGroupMemberBtn').onclick = () => this.showAddUserGroupMemberModal(groupId);
  }

  async loadUserGroupRules(groupId) {
    try {
      const response = await fetch(`/api/admin/user-groups/${groupId}/rules`);
      if (!response.ok) throw new Error(t('加载失败'));
      const rules = await response.json();
      this.renderUserGroupRules(groupId, rules);
    } catch (error) {
      console.error(t('加载用户组规则失败:'), error);
    }
  }

  renderUserGroupRules(groupId, rules) {
    const container = document.getElementById('userGroupRulesList');

    const durationPresets = [
      { hours: 1, label: t('1 小时') },
      { hours: 5, label: t('5 小时') },
      { hours: 24, label: t('1 天') },
      { hours: 168, label: t('1 周') },
    ];

    // 渲染已有规则列表
    let html = '';
    if (rules.length > 0) {
      html += '<div class="rules-list">';
      rules.forEach(r => {
        const unit = r.rule_type === 'requests' ? t('次请求') : 'tokens';
        const durationLabel = this.formatDuration(r.duration_hours);
        html += `
          <div class="rule-row" data-rule-id="${r.id}">
            <div class="rule-row-main">
              <span class="rule-row-type">${r.rule_type === 'requests' ? t('请求次数') : t('Token 用量')}</span>
              <span class="rule-row-value">每 ${durationLabel} 最多 <strong>${Number(r.rule_value).toLocaleString()}</strong> ${unit}</span>
            </div>
            <button class="btn btn-danger btn-sm" onclick="adminApp.deleteUserGroupRule(${groupId}, ${r.id})">删除</button>
          </div>`;
      });
      html += '</div>';
    }

    // 添加新规则表单
    html += `
      <div class="rule-add-form" id="ruleAddForm">
        <div class="rule-add-row">
          <select id="ruleNewType" class="form-input" style="width:auto;">
            <option value="requests">请求次数</option>
            <option value="tokens">Token 用量</option>
          </select>
          <span class="rule-add-label">每</span>
          <input type="number" id="ruleNewDuration" class="form-input" style="width:100px;" min="1" placeholder="${t('小时数')}">
          <span class="rule-add-label">小时</span>
          <span class="rule-add-label">最多</span>
          <input type="number" id="ruleNewValue" class="form-input" style="width:120px;" min="1" placeholder="${t('限额')}">
          <span class="rule-add-label" id="ruleNewUnit">次请求</span>
          <button class="btn btn-primary btn-sm" onclick="adminApp.addGroupRule(${groupId})">添加</button>
        </div>
        <div class="rule-presets">
          快捷设置：
          ${durationPresets.map(p => `<button class="btn btn-ghost btn-sm" onclick="document.getElementById('ruleNewDuration').value=${p.hours}">${p.label}</button>`).join('')}
        </div>
      </div>`;

    setHTML(container, html);

    // 切换单位显示
    const typeSelect = document.getElementById('ruleNewType');
    const unitLabel = document.getElementById('ruleNewUnit');
    typeSelect.addEventListener('change', () => {
      unitLabel.textContent = typeSelect.value === 'requests' ? t('次请求') : 'tokens';
    });
  }

  formatDuration(hours) {
    if (!hours) return t('永久');
    if (hours < 24) return `${hours}${t('小时')}`;
    if (hours === 24) return t('1 天');
    if (hours % 24 === 0) {
      const days = hours / 24;
      if (days === 7) return t('1 周');
      if (days === 30) return t('1 月');
      return `${days}${t('天')}`;
    }
    return `${hours}${t('小时')}`;
  }

  async deleteUserGroupRule(groupId, ruleId) {
    if (!await confirm(t('确定删除此规则？'))) return;
    try {
      await fetch(`/api/admin/user-group-rules/${ruleId}`, { method: 'DELETE' });
      this.loadUserGroupRules(groupId);
    } catch (e) { alert(t('删除失败')); }
  }

  async addGroupRule(groupId) {
    const rule_type = document.getElementById('ruleNewType').value;
    const rule_value = parseInt(document.getElementById('ruleNewValue').value);
    const duration_hours = parseInt(document.getElementById('ruleNewDuration').value);

    if (!duration_hours || duration_hours <= 0) {
      alert(t('请输入有效的小时数'));
      document.getElementById('ruleNewDuration').focus();
      return;
    }
    if (!rule_value || rule_value <= 0) {
      alert(t('请输入有效的限额'));
      document.getElementById('ruleNewValue').focus();
      return;
    }

    try {
      await fetch(`/api/admin/user-groups/${groupId}/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule_type, rule_value, duration_hours })
      });
      this.loadUserGroupRules(groupId);
    } catch (e) {
      alert(t('添加失败'));
    }
  }

  async loadUserGroupMembers(groupId) {
    try {
      const [membersRes, usersRes] = await Promise.all([
        fetch('/api/admin/users'),
        fetch('/api/admin/users')
      ]);
      const users = await usersRes.json();
      const members = users.filter(u => u.group_id === groupId);
      this.renderUserGroupMembers(groupId, members, users);
    } catch (error) {
      console.error(t('加载用户组成员失败:'), error);
    }
  }

  filterUserGroupMembers() {
    this._debounceSearch('_userGroupMemberFilterTimer', () => {
      this.userGroupMemberPage = 0;
      const c = this._userGroupMembersCache;
      if (c) this.renderUserGroupMembers(c.groupId, c.members, c.allUsers);
    });
  }

  renderUserGroupMembers(groupId, members, allUsers) {
    const container = document.getElementById('userGroupMembersList');
    this._userGroupMembersCache = { groupId, members, allUsers };
    if (!members.length) {
      setHTML(container, '<div class="empty-state">' + t('暂无成员') + '</div>');
      return;
    }
    const q = this._searchQ('userGroupMemberSearchInput');
    const filtered = q
      ? members.filter(m => this._matchSearch(q, m.username, m.email))
      : members;
    if (!filtered.length) {
      setHTML(container, '<div class="empty-state">' + t('未找到匹配的成员') + '</div>');
      return;
    }
    const pg = this._paginate(filtered, this.userGroupMemberPage, this.memberPageSize);
    this.userGroupMemberPage = pg.page;
    setHTML(container, `<table class="data-table"><thead><tr>
      <th>用户名</th><th>邮箱</th><th>积分</th><th>操作</th>
    </tr></thead><tbody>${pg.items.map(m => `<tr>
      <td>${escapeHtml(m.nickname || m.display_name || m.username)}</td>
      <td>${escapeHtml(m.email || '-')}</td>
      <td>${parseFloat(m.balance || 0).toFixed(0)}</td>
      <td><button class="btn btn-sm btn-danger" onclick="adminApp.removeUserGroupMember(${groupId}, ${m.id})">移除</button></td>
    </tr>`).join('')}</tbody></table>
    ${pg.totalPages > 1 ? this._renderPagination('userGroupMember', pg.page, pg.totalPages, pg.total) : ''}`);
  }

  userGroupMemberPageGo(page) {
    this.userGroupMemberPage = page;
    const c = this._userGroupMembersCache;
    if (c) this.renderUserGroupMembers(c.groupId, c.members, c.allUsers);
  }

  async removeUserGroupMember(groupId, userId) {
    if (!await confirm(t('确定移除此成员？'))) return;
    try {
      await fetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: null })
      });
      this.loadUserGroupMembers(groupId);
      this.loadUserGroups();
    } catch (e) { alert(t('移除失败')); }
  }

  async showAddUserGroupMemberModal(groupId) {
    try {
      const usersRes = await fetch('/api/admin/users');
      const users = await usersRes.json();
      const available = users.filter(u => u.group_id !== groupId);

      const content = available.length
        ? `<div style="display:grid;gap:10px;">
            <input type="text" id="addGroupMemberSearch" class="form-input" placeholder="${t('搜索用户名或邮箱...')}" style="width:100%;box-sizing:border-box;">
            <div id="addGroupMemberList" style="max-height:360px;overflow-y:auto;"></div>
          </div>`
        : '<div class="empty-state">' + t('所有用户都已在此用户组中') + '</div>';

      const modal = Dialog.showModal({
        title: t('添加成员'),
        content: content,
        footer: `<button class="btn btn-primary" id="confirmAddGroupMembers">${t('添加')}</button>`
      });

      if (available.length) {
        const listEl = document.getElementById('addGroupMemberList');
        const selected = new Set();
        const render = (q = '') => {
          const kw = (q || '').trim().toLowerCase();
          const rows = kw
            ? available.filter(u => this._matchSearch(kw, u.username, u.email))
            : available;
          setHTML(listEl, rows.map(u => `
            <label style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border);">
              <input type="checkbox" value="${u.id}" class="group-member-checkbox" ${selected.has(u.id) ? 'checked' : ''}>
              <span>${escapeHtml(u.nickname || u.display_name || u.username)}</span>
              <span class="text-muted">${escapeHtml(u.email || '')}</span>
            </label>`).join('') || '<div class="empty-state" style="padding:20px;">' + t('无匹配用户') + '</div>');
          listEl.querySelectorAll('.group-member-checkbox').forEach(cb => {
            cb.onchange = () => {
              if (cb.checked) selected.add(parseInt(cb.value));
              else selected.delete(parseInt(cb.value));
            };
          });
        };
        render();
        document.getElementById('addGroupMemberSearch').oninput = (e) => render(e.target.value);

        document.getElementById('confirmAddGroupMembers').onclick = async () => {
          const checked = Array.from(selected);
          if (!checked.length) { alert(t('请选择用户')); return; }
          try {
            for (const userId of checked) {
              await fetch(`/api/admin/users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: groupId })
              });
            }
            modal.close();
            this.loadUserGroupMembers(groupId);
            this.loadUserGroups();
          } catch (e) { alert(t('添加失败')); }
        };
      }
    } catch (e) { alert(t('加载用户列表失败')); }
  }

  async showEditUserGroupModal(groupId) {
    try {
      const res = await fetch('/api/admin/user-groups');
      const groups = await res.json();
      const group = groups.find(g => g.id === groupId);
      if (!group) { alert(t('用户组不存在')); return; }

      const content = `
        <div style="display:grid;gap:12px;">
          <div class="form-group">
            <label>用户组名称</label>
            <input type="text" id="editGroupNameInput" class="form-input" value="${escapeHtml(group.name)}">
          </div>
          <div class="form-group">
            <label>描述</label>
            <textarea id="editGroupDescInput" class="form-input" rows="3">${escapeHtml(group.description || '')}</textarea>
          </div>
        </div>
      `;
      const modal = Dialog.showModal({
        title: t('编辑用户组'),
        content: content,
        footer: `<button class="btn btn-primary" id="confirmEditGroup">${t('保存')}</button>`
      });
      document.getElementById('confirmEditGroup').onclick = async () => {
        const name = document.getElementById('editGroupNameInput').value.trim();
        const description = document.getElementById('editGroupDescInput').value.trim();
        if (!name) { alert(t('名称不能为空')); return; }
        try {
          await fetch(`/api/admin/user-groups/${groupId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
          });
          modal.close();
          this.loadUserGroups();
          this.showUserGroupDetail(groupId);
        } catch (e) { alert(t('保存失败')); }
      };
    } catch (e) { alert(t('加载用户组信息失败')); }
  }

  async deleteUserGroup(groupId) {
    if (!await confirm(t('确定删除此用户组？成员将被移除但不会被删除。'))) return;
    try {
      await fetch(`/api/admin/user-groups/${groupId}`, { method: 'DELETE' });
      document.getElementById('userGroupDetailPanel').style.display = 'none';
      this.loadUserGroups();
    } catch (e) { alert(t('删除失败')); }
  }

  // ==================== CrewRouter Team 管理 ====================

  async loadTeams() {
    const listEl = document.getElementById('teamsList') || document.getElementById('adminTeamsList');
    if (listEl) setHTML(listEl, pageLoadingHtml(t('加载 Team...')));
    try {
      const response = await fetch('/api/admin/teams');
      if (!response.ok) throw new Error(t('加载失败'));
      const teams = await response.json();
      this.renderTeamsList(teams);
    } catch (error) {
      console.error(t('加载 Team 列表失败:'), error);
      if (listEl) setHTML(listEl, `<p style="text-align:center;color:var(--destructive);padding:20px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  filterTeams() {
    this._debounceSearch('_teamFilterTimer', () => {
      this.teamPage = 0;
      this.renderTeamsList(this._teamsData || []);
    });
  }

  onAdminTeamFilterInput(value, source) {
    this._syncPairedControl('teamSearchInput', 'adminTeamsStickySearch', value, source);
    this.filterTeams();
  }

  // ===== Team 管理悬浮顶栏（列表） =====

  _isTeamDetailOpen() {
    const panel = document.getElementById('teamDetailPanel');
    return !!(panel && panel.style.display !== 'none' && panel.offsetParent !== null);
  }

  _initAdminTeamsStickyBar() {
    const sentinel = document.getElementById('adminTeamsStickySentinel');
    if (!sentinel) return;

    if (this._adminTeamsStickyObserver) {
      this._adminTeamsStickyObserver.disconnect();
      this._adminTeamsStickyObserver = null;
    }

    this._adminTeamsStickyObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // 详情打开时用模型权限顶栏；仅当列表筛选已滚出顶部才显示
      const show = this._isStickySentinelPastTop(entry)
        && this.currentPage === 'adminTeams'
        && !this._isTeamDetailOpen();
      this._syncAdminTeamsStickyVisibility(show);
    }, { root: null, threshold: [0, 0.01, 1], rootMargin: '0px' });

    this._adminTeamsStickyObserver.observe(sentinel);
    this._syncAdminTeamsStickyVisibility(
      this._isStickySentinelPastTop(sentinel)
        && this.currentPage === 'adminTeams'
        && !this._isTeamDetailOpen()
    );
    this._syncAdminTeamsStickyControlsFromMain();
  }

  _syncAdminTeamsStickyVisibility(visible) {
    const bar = document.getElementById('adminTeamsStickyBar');
    if (!bar) return;
    const shouldShow = !!visible
      && this.currentPage === 'adminTeams'
      && !this._isTeamDetailOpen();
    const wasVisible = bar.classList.contains('is-visible');
    if (shouldShow === wasVisible) return;
    bar.classList.toggle('is-visible', shouldShow);
    bar.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  }

  _syncAdminTeamsStickyControlsFromMain() {
    const main = document.getElementById('teamSearchInput');
    const sticky = document.getElementById('adminTeamsStickySearch');
    if (main && sticky && sticky.value !== main.value) sticky.value = main.value;
    const count = document.getElementById('teamCount')?.textContent || '';
    const stickyCount = document.getElementById('adminTeamsStickyCount');
    if (stickyCount) stickyCount.textContent = count;
  }

  // ===== Team 详情 · 模型权限悬浮顶栏 =====

  _initAdminTeamModelsStickyBar() {
    const sentinel = document.getElementById('adminTeamModelsStickySentinel');
    if (!sentinel) return;

    if (this._adminTeamModelsStickyObserver) {
      this._adminTeamModelsStickyObserver.disconnect();
      this._adminTeamModelsStickyObserver = null;
    }

    this._adminTeamModelsStickyObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // 仅当模型筛选区已滚出视口顶部才显示（详情页靠下的筛选未进入视口时不显示）
      const show = this._isStickySentinelPastTop(entry)
        && this.currentPage === 'adminTeams'
        && this._isTeamDetailOpen();
      this._syncAdminTeamModelsStickyVisibility(show);
    }, { root: null, threshold: [0, 0.01, 1], rootMargin: '0px' });

    this._adminTeamModelsStickyObserver.observe(sentinel);
    this._syncAdminTeamModelsStickyVisibility(
      this._isStickySentinelPastTop(sentinel)
        && this.currentPage === 'adminTeams'
        && this._isTeamDetailOpen()
    );
    this._syncAdminTeamModelsStickyControlsFromMain();
  }

  _syncAdminTeamModelsStickyVisibility(visible) {
    const bar = document.getElementById('adminTeamModelsStickyBar');
    if (!bar) return;
    const shouldShow = !!visible
      && this.currentPage === 'adminTeams'
      && this._isTeamDetailOpen();
    const wasVisible = bar.classList.contains('is-visible');
    if (shouldShow === wasVisible) return;
    bar.classList.toggle('is-visible', shouldShow);
    bar.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  }

  _syncAdminTeamModelsStickyControlsFromMain() {
    const pairs = [
      ['teamModelListSearchInput', 'adminTeamModelsStickySearch'],
      ['teamModelProviderFilter', 'adminTeamModelsStickyProvider'],
      ['teamModelStatusFilter', 'adminTeamModelsStickyStatus']
    ];
    for (const [mainId, stickyId] of pairs) {
      const mainEl = document.getElementById(mainId);
      const stickyEl = document.getElementById(stickyId);
      if (mainEl && stickyEl && stickyEl.value !== mainEl.value) stickyEl.value = mainEl.value;
    }
    const count = document.getElementById('teamModelListCount')?.textContent || '';
    const stickyCount = document.getElementById('adminTeamModelsStickyCount');
    if (stickyCount) stickyCount.textContent = count;
  }

  onAdminTeamModelFilterInput(field, value, source) {
    const pairs = {
      search: ['teamModelListSearchInput', 'adminTeamModelsStickySearch'],
      provider: ['teamModelProviderFilter', 'adminTeamModelsStickyProvider'],
      status: ['teamModelStatusFilter', 'adminTeamModelsStickyStatus']
    };
    const [mainId, stickyId] = pairs[field] || [];
    if (mainId) this._syncPairedControl(mainId, stickyId, value, source);
    this.filterTeamModelsList();
  }

  renderTeamsList(teams) {
    this._teamsData = teams || [];
    const all = this._teamsData;
    const q = this._searchQ('teamSearchInput');
    const filtered = q
      ? all.filter(t => this._matchSearch(q, t.name, t.description))
      : all;

    // 统计卡片基于全量
    const defaultCount = all.filter(t => t.is_default).length;
    const frontierCount = all.filter(t => t.is_frontier).length;
    const totalMembers = all.reduce((s, t) => s + (parseInt(t.member_count) || 0), 0);

    const statsContainer = document.getElementById('teamStatsCards');
    if (statsContainer) {
      setHTML(statsContainer, `
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon blue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${all.length}</span>
            <span class="admin-stat-card-label">团队总数</span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon amber">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${defaultCount}</span>
            <span class="admin-stat-card-label">默认团队</span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon purple">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${frontierCount}</span>
            <span class="admin-stat-card-label">前沿团队</span>
          </div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-card-icon green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
          </div>
          <div class="admin-stat-card-info">
            <span class="admin-stat-card-value">${totalMembers}</span>
            <span class="admin-stat-card-label">总成员数</span>
          </div>
        </div>
      `);
    }

    const container = document.getElementById('teamsList');
    const countText = filtered.length === all.length
      ? `${t('共')}${all.length}${t('个')}`
      : `${t('显示')}${filtered.length} / ${all.length}`;
    const countEl = document.getElementById('teamCount');
    if (countEl) countEl.textContent = countText;
    const stickyCount = document.getElementById('adminTeamsStickyCount');
    if (stickyCount) stickyCount.textContent = countText;
    this._syncAdminTeamsStickyControlsFromMain();

    if (!all.length) {
      setHTML(container, '<div class="empty-state">' + t('暂无 Team，点击右上角创建') + '</div>');
      return;
    }
    if (!filtered.length) {
      setHTML(container, '<div class="empty-state">' + t('未找到匹配的 Team') + '</div>');
      return;
    }
    const pg = this._paginate(filtered, this.teamPage, this.teamPageSize);
    this.teamPage = pg.page;
    const renderTeamCard = (team) => `
      <div class="team-card" data-team-id="${team.id}">
        <div class="team-card-header">
          <h3>${escapeHtml(team.name)}${team.is_default ? ' <span class="badge badge-warning">' + t('默认') + '</span>' : ''}${team.is_frontier ? ' <span style="background:rgba(139,92,246,0.1);color:var(--purple);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:500;">' + t('前沿') + '</span>' : ''}${team.is_personal ? ' <span style="background:rgba(59,130,246,0.1);color:var(--info);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:500;">' + t('个人') + '</span>' : ''}</h3>
          <span class="badge">${team.member_count} 成员</span>
        </div>
        <p class="team-description">${escapeHtml(team.description || t('暂无描述'))}</p>
        <div class="team-card-footer">
          <span class="text-muted">${new Date(team.created_at).toLocaleDateString()}</span>
          <button class="btn btn-sm btn-primary" onclick="adminApp.showTeamDetail(${team.id})">管理</button>
        </div>
      </div>
    `;

    // 个人 Team 数量可能很多：默认折叠；搜索个人 Team 时自动展开，避免隐藏匹配结果。
    const normalTeams = pg.items.filter(team => !team.is_personal);
    const personalTeams = pg.items.filter(team => team.is_personal);
    const personalCollapsed = !q && !this._personalTeamsExpanded;
    const personalSection = personalTeams.length ? `
      <div class="content-section" style="grid-column:1 / -1;margin-top:8px;padding:0;overflow:hidden;">
        <button type="button" class="section-header" style="width:100%;border:0;background:transparent;padding:16px;cursor:pointer;text-align:left;"
          onclick="adminApp.togglePersonalTeams()" aria-expanded="${(!personalCollapsed).toString()}">
          <h3 style="margin:0;display:flex;align-items:center;gap:8px;">
            <svg class="collapse-icon" style="transition:transform .2s;transform:rotate(${personalCollapsed ? '-90deg' : '0deg'});" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
            个人 Team
            <span class="badge">${personalTeams.length}</span>
          </h3>
          <span class="text-muted" style="font-size:12px;">${personalCollapsed ? t('点击展开') : t('点击折叠')}</span>
        </button>
        <div class="teams-grid" style="display:${personalCollapsed ? 'none' : 'grid'};padding:0 16px 16px;">
          ${personalTeams.map(renderTeamCard).join('')}
        </div>
      </div>` : '';

    setHTML(container, normalTeams.map(renderTeamCard).join('') + personalSection
      + (pg.totalPages > 1 ? this._renderPagination('team', pg.page, pg.totalPages, pg.total) : ''));

    // 绑定创建 Team 按钮
    document.getElementById('createTeamBtn').onclick = () => this.showCreateTeamModal();
  }

  togglePersonalTeams() {
    this._personalTeamsExpanded = !this._personalTeamsExpanded;
    this.renderTeamsList(this._teamsData || []);
  }

  teamPageGo(page) {
    this.teamPage = page;
    this.renderTeamsList(this._teamsData || []);
  }

  showCreateTeamModal() {
    const content = `
      <div style="display:grid;gap:12px;">
        <div class="form-group">
          <label>Team 名称</label>
          <input type="text" id="teamNameInput" class="form-input" placeholder="${t('例如：研发组')}">
        </div>
        <div class="form-group">
          <label>描述</label>
          <textarea id="teamDescInput" class="form-input" rows="3" placeholder="${t('可选描述')}"></textarea>
        </div>
      </div>
    `;
    const modal = Dialog.showModal({
      title: t('创建 Team'),
      content: content,
      footer: `<button class="btn btn-primary" id="confirmCreateTeam">${t('创建')}</button>`
    });
    document.getElementById('confirmCreateTeam').onclick = async () => {
      const name = document.getElementById('teamNameInput').value.trim();
      const description = document.getElementById('teamDescInput').value.trim();
      if (!name) { alert(t('名称不能为空')); return; }
      try {
        const res = await fetch('/api/admin/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description })
        });
        if (!res.ok) {
          const err = await res.json();
          alert(err.error || t('创建失败'));
          return;
        }
        modal.close();
        this.loadTeams();
      } catch (e) { alert(t('创建失败')); }
    };
  }

  /**
   * Team 详情：折叠/展开「成员管理」「模型权限」
   * @param {'members'|'models'} section
   */
  toggleTeamDetailSection(section) {
    const id = section === 'models' ? 'teamModelsSection' : 'teamMembersSection';
    const el = document.getElementById(id);
    if (!el) return;
    const collapsed = el.classList.toggle('collapsed');
    const header = el.querySelector('.team-detail-section-header');
    if (header) header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

    // 模型权限折叠时隐藏悬浮顶栏；展开后重新绑定哨兵
    if (section === 'models') {
      if (collapsed) {
        this._syncAdminTeamModelsStickyVisibility(false);
      } else {
        this._initAdminTeamModelsStickyBar();
      }
    }
  }

  /** 打开 Team 详情时应用默认折叠状态：成员折叠、模型权限展开 */
  _resetTeamDetailSectionCollapse() {
    const members = document.getElementById('teamMembersSection');
    const models = document.getElementById('teamModelsSection');
    if (members) {
      members.classList.add('collapsed');
      members.querySelector('.team-detail-section-header')?.setAttribute('aria-expanded', 'false');
    }
    if (models) {
      models.classList.remove('collapsed');
      models.querySelector('.team-detail-section-header')?.setAttribute('aria-expanded', 'true');
    }
  }

  async showTeamDetail(teamId) {
    this.currentTeamId = teamId;
    // 刷新后可回到该 Team 详情
    if (this.currentPage === 'adminTeams') {
      this._ignoreHashChange = true;
      this._writeAdminHash('adminTeams', { teamId });
      queueMicrotask(() => { this._ignoreHashChange = false; });
    }
    document.getElementById('teamDetailPanel').style.display = 'block';
    // 每次进入详情：成员默认折叠，模型权限默认展开
    this._resetTeamDetailSectionCollapse();
    // 详情模式：隐藏列表顶栏，启用模型权限顶栏
    this._syncAdminTeamsStickyVisibility(false);
    this._initAdminTeamModelsStickyBar();

    // 获取 Team 信息以判断是否为个人账户
    let isPersonal = false;
    try {
      const teamsRes = await fetch('/api/admin/teams');
      const teams = await teamsRes.json();
      const team = teams.find(t => t.id === teamId);
      isPersonal = team?.is_personal || false;
    } catch (e) { /* ignore */ }
    this.currentTeamIsPersonal = isPersonal;

    // 加载 Team 成员
    this.loadTeamMembers(teamId);
    // 切换 Team 时重置模型筛选，避免沿用上一 Team 条件
    const teamModelIds = [
      'teamModelListSearchInput', 'adminTeamModelsStickySearch',
      'teamModelProviderFilter', 'adminTeamModelsStickyProvider',
      'teamModelStatusFilter', 'adminTeamModelsStickyStatus'
    ];
    teamModelIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    // 加载 Team 模型
    this.loadTeamModels(teamId);
    // 更新默认 Team 按钮状态
    this.updateDefaultTeamBtn(teamId);
    this.updateFrontierTeamBtn(teamId);

    // 绑定按钮事件
    document.getElementById('editTeamBtn').onclick = () => this.showEditTeamModal(teamId);
    document.getElementById('deleteTeamBtn').onclick = () => this.deleteTeam(teamId);
    // stopPropagation：避免点「添加成员」时触发区块折叠
    document.getElementById('addTeamMemberBtn').onclick = (e) => {
      e.stopPropagation();
      this.showAddTeamMemberModal(teamId);
    };
    document.getElementById('setDefaultTeamBtn').onclick = () => this.toggleDefaultTeam(teamId);
    document.getElementById('setFrontierTeamBtn').onclick = () => this.toggleFrontierTeam(teamId);

    // 个人账户 Team：隐藏删除按钮和添加成员按钮
    const deleteBtn = document.getElementById('deleteTeamBtn');
    const addMemberBtn = document.getElementById('addTeamMemberBtn');
    if (deleteBtn) deleteBtn.style.display = isPersonal ? 'none' : '';
    if (addMemberBtn) addMemberBtn.style.display = isPersonal ? 'none' : '';
  }

  async updateDefaultTeamBtn(teamId) {
    try {
      const res = await fetch('/api/admin/teams');
      const teams = await res.json();
      const team = teams.find(t => t.id === teamId);
      const btn = document.getElementById('setDefaultTeamBtn');
      if (team && team.is_default) {
        btn.textContent = t('取消默认');
        btn.className = 'btn btn-sm btn-secondary';
      } else {
        btn.textContent = t('设为默认');
        btn.className = 'btn btn-sm btn-warning';
      }
    } catch (e) {
      console.error(t('更新默认按钮状态失败:'), e);
    }
  }

  async toggleDefaultTeam(teamId) {
    try {
      const res = await fetch('/api/admin/teams');
      const teams = await res.json();
      const team = teams.find(t => t.id === teamId);
      if (!team) return;

      const newDefault = !team.is_default;
      await fetch(`/api/admin/teams/${teamId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: newDefault })
      });
      this.loadTeams();
      this.updateDefaultTeamBtn(teamId);
    } catch (e) { alert(t('操作失败')); }
  }

  async updateFrontierTeamBtn(teamId) {
    try {
      const res = await fetch('/api/admin/teams');
      const teams = await res.json();
      const team = teams.find(t => t.id === teamId);
      const btn = document.getElementById('setFrontierTeamBtn');
      if (team && team.is_frontier) {
        btn.textContent = t('取消前沿');
        btn.style.background = 'var(--purple)';
        btn.style.color = 'white';
        btn.style.borderColor = 'var(--purple)';
      } else {
        btn.textContent = t('设为前沿');
        btn.style.background = '';
        btn.style.color = 'var(--purple)';
        btn.style.borderColor = 'var(--purple)';
      }
    } catch (e) {
      console.error(t('更新前沿按钮状态失败:'), e);
    }
  }

  async toggleFrontierTeam(teamId) {
    try {
      const res = await fetch('/api/admin/teams');
      const teams = await res.json();
      const team = teams.find(t => t.id === teamId);
      if (!team) return;

      if (team.is_frontier) {
        await fetch(`/api/admin/teams/${teamId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_frontier: false })
        });
      } else {
        await fetch(`/api/admin/teams/${teamId}/set-frontier`, { method: 'PUT' });
      }
      this.loadTeams();
      this.updateFrontierTeamBtn(teamId);
    } catch (e) { alert(t('操作失败')); }
  }

  async loadTeamMembers(teamId) {
    try {
      const [membersRes, usersRes] = await Promise.all([
        fetch(`/api/admin/teams/${teamId}/members`),
        fetch('/api/admin/users')
      ]);
      const members = await membersRes.json();
      const users = await usersRes.json();
      this.renderTeamMembers(teamId, members, users);
    } catch (error) {
      console.error(t('加载 Team 成员失败:'), error);
    }
  }

  filterTeamMembers() {
    this._debounceSearch('_teamMemberFilterTimer', () => {
      this.teamMemberPage = 0;
      const c = this._teamMembersCache;
      if (c) this.renderTeamMembers(c.teamId, c.members, c.allUsers);
    });
  }

  renderTeamMembers(teamId, members, allUsers) {
    const container = document.getElementById('teamMembersList');
    this._teamMembersCache = { teamId, members, allUsers };
    if (!members.length) {
      setHTML(container, '<div class="empty-state">' + t('暂无成员') + '</div>');
      return;
    }
    const q = this._searchQ('teamMemberSearchInput');
    const filtered = q
      ? members.filter(m => this._matchSearch(q, m.username, m.email))
      : members;
    if (!filtered.length) {
      setHTML(container, '<div class="empty-state">' + t('未找到匹配的成员') + '</div>');
      return;
    }
    const isPersonal = this.currentTeamIsPersonal;
    const pg = this._paginate(filtered, this.teamMemberPage, this.memberPageSize);
    this.teamMemberPage = pg.page;
    setHTML(container, `<table class="data-table"><thead><tr>
      <th>用户名</th><th>邮箱</th><th>加入时间</th>${isPersonal ? '' : '<th>' + t('操作') + '</th>'}
    </tr></thead><tbody>${pg.items.map(m => `<tr>
      <td>${escapeHtml(m.nickname || m.display_name || m.username)}</td>
      <td>${escapeHtml(m.email || '-')}</td>
      <td>${new Date(m.created_at).toLocaleDateString()}</td>
      ${isPersonal ? '' : `<td><button class="btn btn-sm btn-danger" onclick="adminApp.removeTeamMember(${teamId}, ${m.id})">${t('移除')}</button></td>`}
    </tr>`).join('')}</tbody></table>
    ${pg.totalPages > 1 ? this._renderPagination('teamMember', pg.page, pg.totalPages, pg.total) : ''}`);
  }

  teamMemberPageGo(page) {
    this.teamMemberPage = page;
    const c = this._teamMembersCache;
    if (c) this.renderTeamMembers(c.teamId, c.members, c.allUsers);
  }

  async removeTeamMember(teamId, userId) {
    if (!await confirm(t('确定移除此成员？'))) return;
    try {
      await fetch(`/api/admin/teams/${teamId}/members/${userId}`, { method: 'DELETE' });
      this.loadTeamMembers(teamId);
      this.loadTeams(); // 刷新成员数
    } catch (e) { alert(t('移除失败')); }
  }

  async showAddTeamMemberModal(teamId) {
    try {
      const [membersRes, usersRes] = await Promise.all([
        fetch(`/api/admin/teams/${teamId}/members`),
        fetch('/api/admin/users')
      ]);
      if (!membersRes.ok) {
        const err = await membersRes.json().catch(() => ({}));
        throw new Error(err.error || t('获取成员列表失败'));
      }
      if (!usersRes.ok) {
        const err = await usersRes.json().catch(() => ({}));
        throw new Error(err.error || t('获取用户列表失败'));
      }
      const members = await membersRes.json();
      const users = await usersRes.json();
      const memberIds = new Set(members.map(m => m.id));
      const available = users.filter(u => !memberIds.has(u.id));

      const content = available.length
        ? `<div style="display:grid;gap:10px;">
            <input type="text" id="addTeamMemberSearch" class="form-input" placeholder="${t('搜索用户名或邮箱...')}" style="width:100%;box-sizing:border-box;">
            <div id="addTeamMemberList" style="max-height:360px;overflow-y:auto;"></div>
          </div>`
        : '<div class="empty-state">' + t('所有用户都已在此 Team 中') + '</div>';

      const modal = Dialog.showModal({
        title: t('添加成员'),
        content: content,
        footer: `<button class="btn btn-primary" id="confirmAddMembers">${t('添加')}</button>`
      });

      if (available.length) {
        const listEl = document.getElementById('addTeamMemberList');
        const selected = new Set();
        const render = (q = '') => {
          const kw = (q || '').trim().toLowerCase();
          const rows = kw
            ? available.filter(u => this._matchSearch(kw, u.username, u.email, u.team_name))
            : available;
          setHTML(listEl, rows.map(u => `
            <label style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border);">
              <input type="checkbox" value="${u.id}" class="team-member-checkbox" ${selected.has(u.id) ? 'checked' : ''}>
              <span>${escapeHtml(u.nickname || u.display_name || u.username)}</span>
              <span class="text-muted">${escapeHtml(u.email || '')}</span>
              ${u.team_name ? `<span class="badge">${escapeHtml(u.team_name)}</span>` : ''}
            </label>`).join('') || '<div class="empty-state" style="padding:20px;">' + t('无匹配用户') + '</div>');
          listEl.querySelectorAll('.team-member-checkbox').forEach(cb => {
            cb.onchange = () => {
              if (cb.checked) selected.add(parseInt(cb.value));
              else selected.delete(parseInt(cb.value));
            };
          });
        };
        render();
        document.getElementById('addTeamMemberSearch').oninput = (e) => render(e.target.value);

        document.getElementById('confirmAddMembers').onclick = async () => {
          const checked = Array.from(selected);
          if (!checked.length) { alert(t('请选择用户')); return; }
          try {
            await fetch(`/api/admin/teams/${teamId}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userIds: checked })
            });
            modal.close();
            this.loadTeamMembers(teamId);
            this.loadTeams();
          } catch (e) { alert(t('添加失败')); }
        };
      }
    } catch (e) {
      console.error(t('加载用户列表失败:'), e);
      alert(t('加载用户列表失败: ') + e.message);
    }
  }

  async loadTeamModels(teamId) {
    try {
      const teamModelsRes = await fetch(`/api/admin/teams/${teamId}/models`);
      if (!teamModelsRes.ok) {
        const err = await teamModelsRes.json().catch(() => ({}));
        throw new Error(err.error || t('加载失败'));
      }
      const teamModels = await teamModelsRes.json();
      this._teamModelProviderCollapsed = this._teamModelProviderCollapsed || {};
      this._teamModelsStale = false;
      this.renderTeamModels(teamId, teamModels);
    } catch (error) {
      console.error(t('加载 Team 模型失败:'), error);
      const container = document.getElementById('teamModelsList');
      if (container) {
        setHTML(container, `${'<div class="empty-state"><p style="color:var(--destructive);">' + t('加载失败：')}${escapeHtml(error.message || t('未知错误'))}</p></div>`);
      }
    }
  }

  filterTeamModelsList() {
    this._debounceSearch('_teamModelListFilterTimer', () => {
      this.renderTeamModels(this._teamModelsTeamId, this._teamModelsFlat);
    });
  }

  clearTeamModelFilters() {
    const ids = [
      'teamModelListSearchInput', 'adminTeamModelsStickySearch',
      'teamModelProviderFilter', 'adminTeamModelsStickyProvider',
      'teamModelStatusFilter', 'adminTeamModelsStickyStatus'
    ];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this.renderTeamModels(this._teamModelsTeamId, this._teamModelsFlat);
  }

  _updateTeamModelProviderFilter(models) {
    const selects = [
      document.getElementById('teamModelProviderFilter'),
      document.getElementById('adminTeamModelsStickyProvider')
    ].filter(Boolean);
    if (!selects.length) return;
    const current = selects[0].value;
    const map = {};
    (models || []).forEach(m => {
      const id = m.provider_id || m.provider || '';
      const name = (m.provider_name && String(m.provider_name).trim())
        || (m.provider && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(m.provider) ? m.provider : '')
        || t('未知供应商');
      const key = id || name;
      if (key && !map[key]) map[key] = name;
    });
    const keys = Object.keys(map).sort((a, b) => (map[a] || '').localeCompare(map[b] || '', 'zh-CN'));
    const optionsHtml = '<option value="">' + t('全部供应商') + '</option>' + keys.map(k =>
      `<option value="${escapeHtml(k)}">${escapeHtml(map[k])}</option>`
    ).join('');
    selects.forEach(select => {
      setHTML(select, optionsHtml);
      if (current && map[current]) select.value = current;
    });
  }

  _teamModelProviderKey(m) {
    return String(m.provider_id || m.provider || m.provider_name || 'unknown');
  }

  _teamModelProviderLabel(m) {
    return (m.provider_name && String(m.provider_name).trim())
      || (m.provider && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(m.provider) ? m.provider : '')
      || t('未知供应商');
  }

  _teamModelDisplayName(m) {
    return (m.upstream_model_id && String(m.upstream_model_id).trim())
      || (m.name && String(m.name).trim())
      || (m.alias && String(m.alias).trim())
      || t('未命名模型');
  }

  _groupTeamModelsByProvider(models) {
    const groups = new Map();
    (models || []).forEach(m => {
      const key = this._teamModelProviderKey(m);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: this._teamModelProviderLabel(m),
          providerId: m.provider_id || m.provider || '',
          providerEnabled: m.provider_enabled !== false,
          models: []
        });
      }
      groups.get(key).models.push(m);
    });
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }

  _renderTeamModelLibraryItem(teamId, m) {
    const displayName = this._teamModelDisplayName(m);
    const modelId = m.model_id;
    const modelMult = parseFloat(m.model_multiplier || 1.0);
    const isDisabled = !m.enabled;
    const isProviderDisabled = m.provider_enabled === false;


    const safeModelId = String(modelId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    return `
      <div class="model-library-item admin-team-model-item ${isDisabled ? 'is-disabled' : ''}" data-model-id="${escapeHtml(modelId)}" style="cursor:default;${isDisabled ? 'opacity:0.72;' : ''}">
        <div class="model-library-item-info">
          <div class="model-library-item-name">
            ${m.icon_url ? `<img src="${escapeHtml(m.icon_url)}" onerror="this.style.display='none'" alt="">` : ''}
            <span title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
                        <div class="model-item-badges">
              ${m.series ? `<span class="model-item-badge series">${escapeHtml(m.series)}</span>` : ''}
              ${isDisabled ? '<span class="model-item-badge" style="background:rgba(148,163,184,0.15);color:var(--muted-foreground);">' + t('未启用') + '</span>' : '<span class="model-item-badge" style="background:rgba(16,185,129,0.1);color:var(--success);">' + t('已启用') + '</span>'}
              ${isProviderDisabled ? '<span class="model-item-badge" style="background:rgba(239,68,68,0.1);color:var(--destructive);">' + t('供应商禁用') + '</span>' : ''}
            </div>
          </div>
          ${m.alias && m.alias !== displayName ? `<div class="model-library-item-desc">${escapeHtml(m.alias)}</div>` : ''}
          ${m.description ? `<div class="model-library-item-desc">${escapeHtml(m.description)}</div>` : ''}
          <div class="model-library-item-price">
            <span class="model-price-item">
              <span class="model-price-label">倍率</span>
              <span class="model-price-value">×${modelMult.toFixed(2)}</span>
            </span>
            ${m.input_price_per_1k_tokens != null ? `
              <span class="model-price-item">
                <span class="model-price-label">输入</span>
                <span class="model-price-value">¥${parseFloat(m.input_price_per_1k_tokens || 0).toFixed(4)}</span>
              </span>` : ''}
            ${m.output_price_per_1k_tokens != null ? `
              <span class="model-price-item">
                <span class="model-price-label">输出</span>
                <span class="model-price-value">¥${parseFloat(m.output_price_per_1k_tokens || 0).toFixed(4)}</span>
              </span>` : ''}
          </div>
        </div>
        <div class="model-library-item-actions" style="margin-left:0;margin-top:10px;justify-content:flex-end;">
          <button class="btn btn-sm ${m.enabled ? 'btn-secondary' : 'btn-primary'}"
            onclick="adminApp.toggleTeamModel(${teamId}, '${safeModelId}', ${!m.enabled})">
            ${m.enabled ? t('禁用') : t('启用')}
          </button>
        </div>
      </div>
    `;
  }

  renderTeamModels(teamId, teamModels) {
    const container = document.getElementById('teamModelsList');
    if (!container) return;

    this._teamModelsTeamId = teamId;
    this._teamModelsFlat = Array.isArray(teamModels) ? teamModels : (this._teamModelsFlat || []);
    this._teamModelProviderCollapsed = this._teamModelProviderCollapsed || {};

    const all = this._teamModelsFlat;
    this._updateTeamModelProviderFilter(all);

    if (!all.length) {
      setHTML(container, `
        <div class="empty-state model-library-empty" style="padding:48px 20px;text-align:center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" style="margin-bottom:16px;opacity:0.5;">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
          <p style="font-size:15px;color:var(--muted-foreground);margin:0;">暂无已启用模型</p>
          <p style="font-size:13px;color:var(--muted-foreground);margin:8px 0 0;opacity:0.7;">请先在「模型管理」中启用模型</p>
        </div>`);
      const countEl = document.getElementById('teamModelListCount');
      if (countEl) countEl.textContent = '';
      const stickyCount = document.getElementById('adminTeamModelsStickyCount');
      if (stickyCount) stickyCount.textContent = '';
      return;
    }

    const q = this._searchQ('teamModelListSearchInput');
    const providerFilter = document.getElementById('teamModelProviderFilter')?.value || '';
    const statusFilter = document.getElementById('teamModelStatusFilter')?.value || '';

    let filtered = all;
    if (providerFilter) {
      filtered = filtered.filter(m => this._teamModelProviderKey(m) === providerFilter);
    }
    if (statusFilter === 'enabled') {
      filtered = filtered.filter(m => m.enabled);
    } else if (statusFilter === 'disabled') {
      filtered = filtered.filter(m => !m.enabled);
    }
    if (q) {
      filtered = filtered.filter(m => this._matchSearch(
        q,
        m.upstream_model_id,
        m.name,
        m.alias,
        m.provider_name,
        m.provider,
        m.series,
        m.description
      ));
    }

    const enabledTotal = all.filter(m => m.enabled).length;
    const enabledFiltered = filtered.filter(m => m.enabled).length;
    const countText = filtered.length === all.length
      ? `${t('共')}${all.length}${t('个 · 本 Team 已启用')}${enabledTotal}`
      : `${t('显示')}${filtered.length} / ${all.length}${t('· 已启用')}${enabledFiltered}`;
    const countEl = document.getElementById('teamModelListCount');
    if (countEl) countEl.textContent = countText;
    const stickyCount = document.getElementById('adminTeamModelsStickyCount');
    if (stickyCount) stickyCount.textContent = countText;
    this._syncAdminTeamModelsStickyControlsFromMain();

    if (!filtered.length) {
      setHTML(container, '<div class="empty-state" style="padding:40px;text-align:center;"><p style="color:var(--muted-foreground);margin:0;">' + t('未找到匹配的模型') + '</p></div>');
      return;
    }

    const groups = this._groupTeamModelsByProvider(filtered);
    const hasActiveFilter = !!(q || providerFilter || statusFilter);

    // 有筛选时默认展开匹配供应商；无筛选时保持折叠状态（首次默认折叠）
    setHTML(container, `
      <div class="model-library-team" data-team-id="${teamId}">
        <div class="model-library-team-content">
          ${groups.map((group) => {
            const collapsedKey = `${teamId}::${group.key}`;
            let collapsed = this._teamModelProviderCollapsed[collapsedKey];
            if (collapsed === undefined) {
              collapsed = !hasActiveFilter;
              this._teamModelProviderCollapsed[collapsedKey] = collapsed;
            } else if (hasActiveFilter) {
              collapsed = false;
            }
            const totalCount = group.models.length;
            const enabledCount = group.models.filter(m => m.enabled).length;
            // 全启用绿 / 全未启用红 / 半启用黄
            const countColor = totalCount === 0
              ? 'var(--muted-foreground)'
              : (enabledCount === 0
                ? 'var(--destructive, var(--danger))'
                : (enabledCount === totalCount ? 'var(--success)' : 'var(--warning)'));
            const countTitle = enabledCount === 0
              ? t('本供应商模型均未启用')
              : (enabledCount === totalCount ? t('本供应商模型已全部启用') : t('本供应商模型部分启用'));
            const safeCollapsedKey = String(collapsedKey).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const safeProviderKey = String(group.key).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return `
              <div class="model-library-provider ${collapsed ? 'collapsed' : ''} ${group.providerEnabled ? '' : 'provider-disabled'}"
                   data-team-provider-key="${escapeHtml(collapsedKey)}"
                   data-provider-key="${escapeHtml(group.key)}">
                <div class="model-library-provider-header" onclick="adminApp.toggleTeamModelProvider('${safeCollapsedKey}')">
                  <div class="model-library-provider-title">
                    <svg class="collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                    <span class="provider-name">${escapeHtml(group.label)}</span>
                    ${!group.providerEnabled ? '<span style="color:var(--destructive);font-size:11px;font-weight:500;">' + t('供应商已禁用') + '</span>' : ''}
                  </div>
                  <div class="model-library-provider-actions" onclick="event.stopPropagation()">
                    <button type="button" class="btn btn-sm btn-primary" style="padding:3px 8px;font-size:11px;"
                      title="${t('一键启用该供应商下全部模型')}"
                      onclick="adminApp.batchToggleTeamModelsByProvider('${safeProviderKey}', true)">全部启用</button>
                    <button type="button" class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:11px;"
                      title="${t('一键禁用该供应商下全部模型')}"
                      onclick="adminApp.batchToggleTeamModelsByProvider('${safeProviderKey}', false)">全部禁用</button>
                    <span class="provider-model-count" title="${countTitle}"
                      style="color:${countColor};font-weight:600;">${totalCount} 个模型 · ${enabledCount} 启用</span>
                  </div>
                </div>
                <div class="model-library-list">
                  ${group.models.map(m => this._renderTeamModelLibraryItem(teamId, m)).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `);
  }

  toggleTeamModelProvider(collapsedKey) {
    this._teamModelProviderCollapsed = this._teamModelProviderCollapsed || {};
    const next = !this._teamModelProviderCollapsed[collapsedKey];
    this._teamModelProviderCollapsed[collapsedKey] = next;
    const el = document.querySelector(`.model-library-provider[data-team-provider-key="${CSS.escape(collapsedKey)}"]`);
    if (el) el.classList.toggle('collapsed', next);
  }

  expandAllTeamModelProviders() {
    const teamId = this._teamModelsTeamId;
    if (!teamId) return;
    this._teamModelProviderCollapsed = this._teamModelProviderCollapsed || {};
    document.querySelectorAll('#teamModelsList .model-library-provider').forEach(el => {
      const key = el.getAttribute('data-team-provider-key');
      if (key) this._teamModelProviderCollapsed[key] = false;
      el.classList.remove('collapsed');
    });
  }

  collapseAllTeamModelProviders() {
    const teamId = this._teamModelsTeamId;
    if (!teamId) return;
    this._teamModelProviderCollapsed = this._teamModelProviderCollapsed || {};
    document.querySelectorAll('#teamModelsList .model-library-provider').forEach(el => {
      const key = el.getAttribute('data-team-provider-key');
      if (key) this._teamModelProviderCollapsed[key] = true;
      el.classList.add('collapsed');
    });
  }

  async toggleTeamModel(teamId, modelId, enabled) {
    try {
      const res = await fetch(`/api/admin/teams/${teamId}/models/${modelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t('操作失败'));
      }
      // 本地更新状态，避免整表刷新丢失折叠状态
      const row = (this._teamModelsFlat || []).find(m => String(m.model_id) === String(modelId));
      if (row) row.enabled = enabled;
      this.renderTeamModels(teamId, this._teamModelsFlat);
    } catch (e) { alert(e.message || t('操作失败')); }
  }

  /** 当前筛选条件下的 Team 模型列表（与 render 逻辑一致） */
  _getFilteredTeamModels() {
    const all = this._teamModelsFlat || [];
    const q = this._searchQ('teamModelListSearchInput');
    const providerFilter = document.getElementById('teamModelProviderFilter')?.value || '';
    const statusFilter = document.getElementById('teamModelStatusFilter')?.value || '';

    let filtered = all;
    if (providerFilter) {
      filtered = filtered.filter(m => this._teamModelProviderKey(m) === providerFilter);
    }
    if (statusFilter === 'enabled') {
      filtered = filtered.filter(m => m.enabled);
    } else if (statusFilter === 'disabled') {
      filtered = filtered.filter(m => !m.enabled);
    }
    if (q) {
      filtered = filtered.filter(m => this._matchSearch(
        q, m.upstream_model_id, m.name, m.alias, m.provider_name, m.provider, m.series, m.description
      ));
    }
    return filtered;
  }

  /**
   * 调用 Team 模型批量启用/禁用 API，并同步本地列表
   * @param {{enabled:boolean, modelIds?:string[], provider?:string, namePattern?:string}} body
   */
  async _batchToggleTeamModels(body, confirmMsg) {
    const teamId = this._teamModelsTeamId;
    if (!teamId) { alert(t('请先选择 Team')); return; }
    if (confirmMsg && !await confirm(confirmMsg)) return;

    try {
      const res = await fetch(`/api/admin/teams/${teamId}/models/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('批量操作失败'));

      const updatedIds = new Set((data.modelIds || []).map(String));
      const nextEnabled = !!body.enabled;
      (this._teamModelsFlat || []).forEach(m => {
        if (updatedIds.has(String(m.model_id))) m.enabled = nextEnabled;
      });
      this.renderTeamModels(teamId, this._teamModelsFlat);

      const action = nextEnabled ? t('启用') : t('禁用');
      const cleared = data.cleared_keys ? `${t('，清理')}${data.cleared_keys}${t('个 Key 绑定')}` : '';
      alert(`${t('已')}${action} ${data.updated || 0}${t('个模型')}${cleared}`);
      return data;
    } catch (e) {
      alert(e.message || t('批量操作失败'));
    }
  }

  /** 供应商一键启用/禁用该供应商下全部模型 */
  async batchToggleTeamModelsByProvider(providerKey, enabled) {
    if (!providerKey) return;
    const models = (this._teamModelsFlat || []).filter(m => this._teamModelProviderKey(m) === providerKey);
    if (!models.length) { alert(t('该供应商下没有可操作的模型')); return; }
    const label = this._teamModelProviderLabel(models[0]) || providerKey;
    const action = enabled ? t('启用') : t('禁用');
    // 优先用 provider 字段（服务端按 provider id / 名称匹配）
    const providerParam = models[0].provider_id || models[0].provider || providerKey;
    await this._batchToggleTeamModels(
      { enabled, provider: providerParam },
      `${t('确定对本 Team')}${action}${t('供应商「')}${label}${t('」下的')}${models.length}${t('个模型？')}`
    );
  }

  /** 启用/禁用当前筛选结果 */
  async batchToggleFilteredTeamModels(enabled) {
    const filtered = this._getFilteredTeamModels();
    if (!filtered.length) { alert(t('当前筛选结果为空')); return; }
    const action = enabled ? t('启用') : t('禁用');
    const modelIds = filtered.map(m => m.model_id);
    await this._batchToggleTeamModels(
      { enabled, modelIds },
      `${t('确定对本 Team')}${action}${t('当前筛选的')}${modelIds.length}${t('个模型？')}`
    );
  }

  /** 按名称关键字批量启用（弹窗输入） */
  async batchEnableTeamModelsByName() {
    const teamId = this._teamModelsTeamId;
    if (!teamId) { alert(t('请先选择 Team')); return; }

    const content = `
      <div style="display:grid;gap:12px;">
        <p style="margin:0;font-size:13px;color:var(--muted-foreground);line-height:1.5;">
          按关键字匹配模型的上游 ID、名称、别名或系列（不区分大小写），对本 Team 批量启用。
        </p>
        <div class="form-group" style="margin:0;">
          <label>名称关键字</label>
          <input type="text" id="teamModelBatchNameInput" class="form-input" placeholder="${t('例如：claude、gpt-4、gemini')}" autofocus>
        </div>
        <div class="form-group" style="margin:0;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="teamModelBatchNameDisable" >
            <span>改为批量禁用（取消勾选则为启用）</span>
          </label>
        </div>
      </div>
    `;
    const modal = Dialog.showModal({
      title: t('按名称批量启用/禁用'),
      content,
      footer: `<button class="btn btn-primary" id="confirmTeamModelBatchName">${t('执行')}</button>`
    });

    const input = document.getElementById('teamModelBatchNameInput');
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('confirmTeamModelBatchName')?.click();
      });
    }

    document.getElementById('confirmTeamModelBatchName').onclick = async () => {
      const namePattern = (document.getElementById('teamModelBatchNameInput')?.value || '').trim();
      if (!namePattern) { alert(t('请输入名称关键字')); return; }
      const enabled = !document.getElementById('teamModelBatchNameDisable')?.checked;
      const action = enabled ? t('启用') : t('禁用');
      // 预估匹配数（本地）
      const q = namePattern.toLowerCase();
      const preview = (this._teamModelsFlat || []).filter(m =>
        [m.upstream_model_id, m.name, m.alias, m.series].some(v => v && String(v).toLowerCase().includes(q))
      );
      if (!preview.length) { alert(t('没有匹配的模型')); return; }
      if (!await confirm(`${t('将对本 Team')}${action}${t('约')}${preview.length}${t('个匹配「')}${namePattern}${t('」的模型，是否继续？')}`)) return;
      modal.close();
      await this._batchToggleTeamModels({ enabled, namePattern });
    };
  }


  async showEditTeamModal(teamId) {
    try {
      const res = await fetch('/api/admin/teams');
      const teams = await res.json();
      const team = teams.find(t => t.id === teamId);
      if (!team) { alert(t('Team 不存在')); return; }

      const content = `
        <div style="display:grid;gap:12px;">
          <div class="form-group">
            <label>Team 名称</label>
            <input type="text" id="editTeamNameInput" class="form-input" value="${escapeHtml(team.name)}">
          </div>
          <div class="form-group">
            <label>描述</label>
            <textarea id="editTeamDescInput" class="form-input" rows="3">${escapeHtml(team.description || '')}</textarea>
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="editTeamDefaultInput" ${team.is_default ? 'checked' : ''}>
              <span>设为默认 Team（新用户自动加入）</span>
            </label>
          </div>
        </div>
      `;
      const modal = Dialog.showModal({
        title: t('编辑 Team'),
        content: content,
        footer: `<button class="btn btn-primary" id="confirmEditTeam">${t('保存')}</button>`
      });
      document.getElementById('confirmEditTeam').onclick = async () => {
        const name = document.getElementById('editTeamNameInput').value.trim();
        const description = document.getElementById('editTeamDescInput').value.trim();
        const is_default = document.getElementById('editTeamDefaultInput').checked;
        if (!name) { alert(t('名称不能为空')); return; }
        try {
          await fetch(`/api/admin/teams/${teamId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, is_default })
          });
          modal.close();
          this.loadTeams();
          this.showTeamDetail(teamId);
        } catch (e) { alert(t('保存失败')); }
      };
    } catch (e) { alert(t('加载 Team 信息失败')); }
  }

  async deleteTeam(teamId) {
    if (!await confirm(t('确定删除此 Team？成员将被移除但不会被删除。'))) return;
    try {
      await fetch(`/api/admin/teams/${teamId}`, { method: 'DELETE' });
      document.getElementById('teamDetailPanel').style.display = 'none';
      this.currentTeamId = null;
      this._syncAdminTeamModelsStickyVisibility(false);
      await this.loadTeams();
      this._initAdminTeamsStickyBar();
    } catch (e) { alert(t('删除失败')); }
  }

  // ==================== 模型测试 ====================

  toggleTestDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('adminTestDropdownMenu');
    if (!menu) return;
    const isVisible = menu.style.display === 'block';
    menu.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      const close = (e) => {
        const dropdown = document.getElementById('adminTestDropdown');
        if (dropdown && !dropdown.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  closeTestResultModal() {
    document.getElementById('adminTestResultModal').style.display = 'none';
  }

  async testModel(modelId, buttonEl) {
    if (!modelId) { console.error(t('[模型测试] modelId 为空')); alert(t('模型 ID 为空')); return; }
    if (!this._confirmTest()) return;

    // 查找本地数据验证
    let foundModel = null;
    if (this.modelsData) {
      foundModel = this.modelsData.find(m => m.id === modelId);
    }
    if (foundModel) {
      console.log(`${t('[模型测试] 本地查找: modelId=')}${modelId} name=${foundModel.name || foundModel.upstream_model_id} provider=${foundModel.provider_name}`);
    } else {
      console.warn(`${t('[模型测试] 本地未找到 modelId=')}${modelId}`);
    }

    if (buttonEl) {
      buttonEl.disabled = true;
      setHTML(buttonEl, loadingSpinnerHtml('sm'));
    }

    try {
      const res = await fetch(`/api/admin/models/${modelId}/test`, { method: 'POST' });
      const data = await res.json();
      this._updateModelTestResult(modelId, data);
      this._showTestResult([{ modelId, ...data }]);
    } catch (e) {
      this._showTestResult([{ modelId, ok: false, error: e.message || t('请求失败') }]);
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        const isTableBtn = buttonEl.classList.contains('btn-icon');
        if (isTableBtn) {
          setHTML(buttonEl, '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>');
        } else {
          buttonEl.textContent = t('测试');
        }
      }
    }
  }

  _confirmTest() {
    return confirm(t('模型测试将发送一条真实请求（"Hi"，max_tokens=5）到该模型，\n并按照正常用量扣除积分。是否继续？'));
  }

  _formatTestTooltip(testedAt) {
    if (!testedAt) return '';
    const diff = Date.now() - new Date(testedAt).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return t('刚刚测试');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}${t('分钟前测试')}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}${t('小时前测试')}`;
    const days = Math.floor(hours / 24);
    return `${days}${t('天前测试')}`;
  }

  _updateModelTestResult(modelId, result) {
    if (!this.modelsData) return;
    const model = this._findAdminModelById(modelId);
    if (model) {
      model.test_ok = result.ok;
      model.test_latency_ms = result.latency_ms || null;
      model.test_tokens_per_second = result.tokens_per_second || null;
      model.test_total_tokens = result.total_tokens || null;
      model.test_error = result.error || null;
      model.test_tested_at = (result.ok ? new Date().toISOString() : null);
      const providerKey = this._adminModelProviderKey(model);
      this._paintAdminProviderList(providerKey);
    }
  }

  _currentModelFilterParams(page, limit) {
    const search = (document.getElementById('modelSearchInput')?.value || '').trim();
    const provider = document.getElementById('modelProviderFilter')?.value || '';
    const status = document.getElementById('modelStatusFilter')?.value || '';
    const series = document.getElementById('modelSeriesFilter')?.value || '';
    const test = document.getElementById('modelTestFilter')?.value || '';
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('q', search);
    if (provider) params.set('provider', provider);
    if (status === 'enabled') params.set('enabled', 'true');
    else if (status === 'disabled') params.set('enabled', 'false');
    if (series) params.set('series', series);
    if (test) params.set('test', test);
    return params;
  }

  /** 按当前筛选条件拉取全部模型（分页遍历，每页最多 200），并带回 stats/providers/series */
  async _fetchAllFilteredModelsWithMeta() {
    const models = [];
    let page = 1;
    let total = Infinity;
    let stats = null;
    let providers = null;
    let series = null;
    while (models.length < total) {
      const res = await fetch(`/api/admin/models?${this._currentModelFilterParams(page, 200)}`);
      if (!res.ok) throw new Error(t('加载模型列表失败'));
      const raw = await res.json();
      const normalized = this._normalizeListResponse(raw);
      const { items, total: t } = normalized;
      total = t;
      if (page === 1) {
        stats = normalized.stats;
        providers = normalized.providers;
        series = raw.series || null;
      }
      models.push(...items);
      if (!items.length) break;
      page++;
      if (page > 500) break;
    }
    return { models, total: total === Infinity ? models.length : total, stats, providers, series };
  }

  /** 按当前筛选条件拉取全部模型（分页遍历，每页最多 200） */
  async _fetchAllFilteredModels() {
    const { models } = await this._fetchAllFilteredModelsWithMeta();
    return models;
  }

  async _fetchAllFilteredModelIds() {
    const models = await this._fetchAllFilteredModels();
    return models.map(m => m.id);
  }

  async testAllFilteredModels() {
    this._closeTestDropdown();
    try {
      const modelIds = await this._fetchAllFilteredModelIds();
      if (modelIds.length === 0) { alert(t('当前筛选结果为空')); return; }
      if (modelIds.length > 200 && !await confirm(`${t('将测试')}${modelIds.length}${t('个模型，可能较久，是否继续？')}`)) return;
      await this._runBatchTest(modelIds, `${t('正在测试')}${modelIds.length}${t('个模型...')}`);
    } catch (e) {
      alert(e.message || t('获取模型列表失败'));
    }
  }

  async testSelectedModels() {
    this._closeTestDropdown();
    const modelIds = [...this.selectedModels];
    if (modelIds.length === 0) { alert(t('请先选择要测试的模型')); return; }
    await this._runBatchTest(modelIds, `${t('正在测试')}${modelIds.length}${t('个模型...')}`);
  }

  _closeTestDropdown() {
    const menu = document.getElementById('adminTestDropdownMenu');
    if (menu) menu.style.display = 'none';
  }

  async _runBatchTest(modelIds, loadingMsg) {
    const modal = document.getElementById('adminTestResultModal');
    const body = document.getElementById('adminTestResultBody');
    if (!modal || !body) return;
    modal.style.display = 'flex';
    setHTML(body, pageLoadingHtml(loadingMsg, { compact: true }));

    try {
      const res = await fetch('/api/admin/models/test-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds })
      });
      const data = await res.json();
      const results = data.results || [];
      for (const r of results) {
        if (r.modelId) this._updateModelTestResult(r.modelId, r);
      }
      this._showTestResult(results);
    } catch (e) {
      setHTML(body, `${'<div class="empty-state"><p style="color:var(--destructive);">' + t('测试失败:')}${escapeHtml(e.message)}</p></div>`);
    }
  }

  _showTestResult(results) {
    const body = document.getElementById('adminTestResultBody');
    if (!body) return;

    const total = results.length;
    const passed = results.filter(r => r.ok).length;
    const failed = total - passed;

    const summaryHtml = `
      <div class="model-test-summary">
        <div class="model-test-summary-item">
          <div class="model-test-summary-value" style="color:var(--success);">${passed}</div>
          <div class="model-test-summary-label">通过</div>
        </div>
        ${failed > 0 ? `
        <div class="model-test-summary-item">
          <div class="model-test-summary-value" style="color:var(--destructive);">${failed}</div>
          <div class="model-test-summary-label">失败</div>
        </div>` : ''}
        <div class="model-test-summary-item">
          <div class="model-test-summary-value">${total}</div>
          <div class="model-test-summary-label">总计</div>
        </div>
      </div>
    `;

    const rowsHtml = results.map(r => {
      if (r.ok) {
        const providerLabel = r.provider_url
          ? `${escapeHtml(r.provider)} <span style="font-size:10px;color:var(--muted-foreground);">(${escapeHtml(r.provider_url)})</span>`
          : escapeHtml(r.provider || '');
        return `
          <div class="model-test-row">
            <div class="model-test-row-icon model-test-result-pass">&#10003;</div>
            <div class="model-test-row-model">
              ${escapeHtml(r.model)}
              <div style="font-size:11px;color:var(--muted-foreground);margin-top:1px;">${providerLabel}</div>
            </div>
            <div class="model-test-row-stats">
              <div class="model-test-stat">
                <div class="model-test-stat-value">${r.latency_ms}ms</div>
                <div class="model-test-stat-label">延迟</div>
              </div>
              <div class="model-test-stat">
                <div class="model-test-stat-value">${r.tokens_per_second.toFixed(1)}</div>
                <div class="model-test-stat-label">t/s</div>
              </div>
              <div class="model-test-stat">
                <div class="model-test-stat-value">${r.total_tokens}</div>
                <div class="model-test-stat-label">tokens</div>
              </div>
            </div>
          </div>
        `;
      } else {
        const modelLabel = r.model || r.modelId || t('未知模型');
        const providerLabel = r.provider
          ? `<div style="font-size:11px;color:var(--muted-foreground);margin-top:1px;">${escapeHtml(r.provider)}${r.provider_url ? ' (' + escapeHtml(r.provider_url) + ')' : ''}</div>`
          : '';
        return `
          <div class="model-test-row">
            <div class="model-test-row-icon model-test-result-fail">&#10007;</div>
            <div class="model-test-row-model">${escapeHtml(modelLabel)}${providerLabel}</div>
            <div class="model-test-row-error" title="${escapeHtml(r.error || '')}">${escapeHtml(r.error || t('失败'))}</div>
          </div>
        `;
      }
    }).join('');

    setHTML(body, summaryHtml + rowsHtml);
  }

  // ========== 供应商标签管理（对齐控制台 Key 标签：拖拽分配） ==========

  _providerTags = [];
  _providerTagColor = 'var(--info)';
  _providerTagDragActive = false;
  _providerTagDragId = null;

  async loadProviderTags() {
    try {
      const resp = await fetch('/api/admin/provider-tags');
      if (resp.ok) this._providerTags = await resp.json();
      else this._providerTags = [];
      this.renderProviderTagBar();
    } catch (_) {
      this._providerTags = [];
      this.renderProviderTagBar();
    }
  }

  renderProviderTagBar() {
    const bar = document.getElementById('providerTagBar');
    const chips = document.getElementById('providerTagChips');
    const stickyChips = document.getElementById('adminProvidersStickyTags');
    if (!chips && !stickyChips) return;
    if (bar) bar.style.display = 'flex';
    const activeId = this.activeProviderTagId;
    const html = this._providerTags.map(tag => {
      const selected = Number(activeId) === Number(tag.id);
      const color = tag.color || 'var(--info)';
      return `<div class="key-tag-chip provider-tag-chip ${selected ? 'active' : ''}"
           style="border-color:${color};${selected ? `background:${color};color:#fff;` : ''}"
           draggable="true"
           data-tag-id="${tag.id}"
           ondragstart="adminApp.handleProviderTagDragStart(event, ${tag.id})"
           ondragend="adminApp.handleProviderTagDragEnd(event)"
           onclick="adminApp.filterProvidersByTag(${tag.id})"
           title="${t('点击筛选 · 拖拽到供应商分配 · 铅笔编辑')}">
        <span style="color:${selected ? '#fff' : color};">●</span>
        ${escapeHtml(tag.name)}
        <span class="edit-tag-def" onclick="event.stopPropagation();adminApp.showEditProviderTagPopover(${tag.id}, this)" title="${t('编辑标签')}">✎</span>
        <span class="remove-tag-def" onclick="event.stopPropagation();adminApp.deleteProviderTag(${tag.id})" title="${t('删除标签')}">&times;</span>
      </div>`;
    }).join('') + `${'<div class="key-tag-chip key-tag-add-btn" onclick="adminApp.showCreateProviderTagPopover(this)" title="' + t('添加标签') + '">' + '+'}</div>`;
    if (chips) setHTML(chips, html);
    if (stickyChips) setHTML(stickyChips, html);
    this._updateAdminProvidersStickyMoreBtn();
  }

  /** 供应商实体上的可交互标签（可移除 + 添加） */
  _renderProviderTagChips(tags, providerId) {
    const list = Array.isArray(tags) ? tags : [];
    const safePid = String(providerId || '').replace(/'/g, "\\'");
    const chips = list.map(tag => {
      const color = tag.color || 'var(--info)';
      return `<span class="key-tag-chip-sm" data-tag-id="${tag.id}"
        style="border-color:${color};color:${color};background:${color}18;">
        ${escapeHtml(tag.name)}
        <span class="remove-tag" title="${t('移除')}"
          onclick="event.stopPropagation();adminApp.removeTagFromProvider('${safePid}',${tag.id})">&times;</span>
      </span>`;
    }).join('');
    const addBtn = providerId != null
      ? `<span class="key-tag-chip-sm key-tag-add-tag-btn provider-tag-add-btn"
           onclick="event.stopPropagation();adminApp.showProviderTagAssignDropdown('${safePid}', this)"
           title="${t('管理标签')}">+</span>`
      : '';
    if (!list.length && !addBtn) {
      return '<span class="provider-tag-empty">-</span>';
    }
    return `<div class="provider-entity-tags">${chips}${addBtn}</div>`;
  }

  /** 从 dataTransfer 读取标签 ID（兼容自定义 MIME / text/plain / 内存兜底） */
  _readDraggedProviderTagId(event) {
    let raw = '';
    try { raw = event?.dataTransfer?.getData('text/tag-id') || ''; } catch (_) { /* ignore */ }
    if (!raw) {
      try { raw = event?.dataTransfer?.getData('text/plain') || ''; } catch (_) { /* ignore */ }
    }
    let tagId = parseInt(raw, 10);
    if (!Number.isFinite(tagId) || tagId <= 0) {
      tagId = Number(this._providerTagDragId);
    }
    return Number.isFinite(tagId) && tagId > 0 ? tagId : null;
  }

  handleProviderTagDragStart(event, tagId) {
    const tid = Number(tagId);
    this._providerTagDragActive = true;
    this._providerTagDragId = Number.isFinite(tid) ? tid : null;
    try {
      // 同时写入 text/plain：部分浏览器 drop 时读不到自定义 MIME
      event.dataTransfer.setData('text/tag-id', String(tid));
      event.dataTransfer.setData('text/plain', String(tid));
      event.dataTransfer.effectAllowed = 'copy';
    } catch (_) { /* ignore */ }
    document.getElementById('adminProvidersList')?.classList.add('providers-compact-drag');
    // 悬浮顶栏内拖拽时，提示列表可投放
    document.getElementById('adminProvidersPage')?.classList.add('is-tag-dragging');
  }

  handleProviderTagDragEnd() {
    this._providerTagDragActive = false;
    this._providerTagDragId = null;
    document.getElementById('adminProvidersList')?.classList.remove('providers-compact-drag');
    document.getElementById('adminProvidersPage')?.classList.remove('is-tag-dragging');
    document.querySelectorAll('.provider-drag-over').forEach(el => el.classList.remove('provider-drag-over'));
  }

  handleProviderDragOver(event) {
    const types = event.dataTransfer?.types;
    const hasTagType = types && (
      (typeof types.includes === 'function' && (types.includes('text/tag-id') || types.includes('text/plain')))
      || (typeof types.contains === 'function' && (types.contains('text/tag-id') || types.contains('text/plain')))
      || Array.from(types || []).some(t => t === 'text/tag-id' || t === 'text/plain')
    );
    if (!hasTagType && !this._providerTagDragActive) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'copy'; } catch (_) { /* ignore */ }
    const target = event.currentTarget;
    if (target) target.classList.add('provider-drag-over');
  }

  handleProviderDragLeave(event) {
    const target = event.currentTarget;
    if (!target) return;
    // 仅在真正离开目标时去掉高亮
    if (target.contains(event.relatedTarget)) return;
    target.classList.remove('provider-drag-over');
  }

  handleProviderDrop(event, providerId) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.classList.remove('provider-drag-over');
    document.getElementById('adminProvidersList')?.classList.remove('providers-compact-drag');
    document.getElementById('adminProvidersPage')?.classList.remove('is-tag-dragging');
    const tagId = this._readDraggedProviderTagId(event);
    const wasDragging = this._providerTagDragActive || this._providerTagDragId != null;
    this._providerTagDragActive = false;
    this._providerTagDragId = null;
    if (!tagId || !providerId) {
      if (wasDragging) this.showToast(t('未能识别拖拽的标签，请重试'), 'error');
      return;
    }
    this.toggleProviderTag(providerId, tagId);
  }

  async toggleProviderTag(providerId, tagId) {
    const pid = String(providerId);
    const tid = Number(tagId);
    if (!pid || !Number.isFinite(tid) || tid <= 0) return;
    try {
      const provider = (this.providersData || []).find(p => String(p.id) === pid);
      // 内存无数据时从 DOM 兜底，避免覆盖已有标签
      let existing = Array.isArray(provider?.tags) ? provider.tags.map(t => Number(t.id)).filter(n => Number.isFinite(n)) : [];
      if (!provider || !Array.isArray(provider.tags)) {
        const card = document.querySelector(`.provider-drop-target[data-provider-id="${CSS.escape(pid)}"]`);
        if (card) {
          existing = [...card.querySelectorAll('.key-tag-chip-sm[data-tag-id]')]
            .map(el => parseInt(el.getAttribute('data-tag-id'), 10))
            .filter(n => Number.isFinite(n) && n > 0);
        }
      }
      const hasTag = existing.includes(tid);
      const newTagIds = hasTag ? existing.filter(id => id !== tid) : [...existing, tid];

      const res = await fetch(`/api/admin/providers/${encodeURIComponent(pid)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: newTagIds })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.error || t('操作失败'), 'error');
        return;
      }
      const data = await res.json().catch(() => ({}));
      const tags = data.tags || (this._providerTags || []).filter(t => newTagIds.includes(Number(t.id)));
      if (provider) {
        provider.tags = tags;
      } else if (Array.isArray(this.providersData)) {
        // 列表尚未命中时仍刷新 UI
        const idx = this.providersData.findIndex(p => String(p.id) === pid);
        if (idx >= 0) this.providersData[idx].tags = tags;
      }
      this.renderProviders();
      this.showToast(hasTag ? t('标签已移除') : t('标签已添加'), 'success');
    } catch (e) {
      console.error(t('[供应商标签] toggle 失败:'), e);
      this.showToast(t('操作失败'), 'error');
    }
  }

  async removeTagFromProvider(providerId, tagId) {
    await this.toggleProviderTag(providerId, tagId);
  }

  showProviderTagAssignDropdown(providerId, btnEl) {
    const existing = document.getElementById('providerTagAssignDropdown');
    if (existing) existing.remove();

    const pid = String(providerId);
    const provider = (this.providersData || []).find(p => String(p.id) === pid);
    const currentTagIds = new Set((provider?.tags || []).map(t => Number(t.id)));
    const safePid = pid.replace(/'/g, "\\'");

    const dropdown = document.createElement('div');
    dropdown.id = 'providerTagAssignDropdown';
    dropdown.className = 'provider-tag-assign-dropdown';

    const rect = btnEl.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = Math.max(8, rect.left) + 'px';

    if (!this._providerTags.length) {
      setHTML(dropdown, '<div class="provider-tag-assign-empty">' + t('暂无标签，请先在上方创建') + '</div>');
    } else {
      setHTML(dropdown, this._providerTags.map(tag => {
        const has = currentTagIds.has(Number(tag.id));
        const color = tag.color || 'var(--info)';
        return `<div class="provider-tag-assign-item ${has ? 'is-on' : ''}"
                     onclick="adminApp.toggleProviderTagFromDropdown('${safePid}',${tag.id})">
          <span style="color:${color};">${has ? '✓' : '○'}</span>
          <span>${escapeHtml(tag.name)}</span>
        </div>`;
      }).join(''));
    }

    document.body.appendChild(dropdown);
    const closer = (e) => {
      if (!dropdown.contains(e.target) && e.target !== btnEl) {
        dropdown.remove();
        document.removeEventListener('click', closer);
      }
    };
    setTimeout(() => document.addEventListener('click', closer), 0);
  }

  async toggleProviderTagFromDropdown(providerId, tagId) {
    await this.toggleProviderTag(providerId, tagId);
    const dropdown = document.getElementById('providerTagAssignDropdown');
    if (dropdown) {
      const btnEl = document.querySelector(
        `.provider-entity-tags .provider-tag-add-btn[onclick*="${String(providerId).replace(/"/g, '')}"]`
      ) || document.querySelector(`.provider-drop-target[data-provider-id="${CSS.escape(String(providerId))}"] .provider-tag-add-btn`);
      dropdown.remove();
      if (btnEl) this.showProviderTagAssignDropdown(providerId, btnEl);
    }
  }

  _openProviderTagPopover(btnEl, { title, name, color, submitLabel }) {
    const popover = document.getElementById('createProviderTagPopover');
    if (!popover || !btnEl) return;
    const titleEl = document.getElementById('providerTagPopoverTitle');
    const submitBtn = document.getElementById('providerTagPopoverSubmit');
    if (titleEl) titleEl.textContent = title || t('创建标签');
    if (submitBtn) submitBtn.textContent = submitLabel || t('创建');
    const rect = btnEl.getBoundingClientRect();
    popover.style.display = 'block';
    popover.style.left = Math.max(8, rect.left) + 'px';
    popover.style.top = (rect.bottom + 4) + 'px';
    const nameInput = document.getElementById('newProviderTagName');
    if (nameInput) {
      nameInput.value = name || '';
      nameInput.focus();
    }
    const pickColor = color || 'var(--info)';
    this._providerTagColor = pickColor;
    document.querySelectorAll('#providerTagColorPicker .provider-tag-color-dot').forEach(d => {
      d.style.borderColor = d.dataset.color === pickColor ? 'var(--foreground)' : 'transparent';
    });
    setTimeout(() => {
      const handler = (e) => {
        if (!popover.contains(e.target) && e.target !== btnEl && !e.target.closest?.('.edit-tag-def')) {
          this.hideCreateProviderTagPopover();
          document.removeEventListener('click', handler);
        }
      };
      document.addEventListener('click', handler);
    }, 0);
  }

  showCreateProviderTagPopover(btnEl) {
    this._editingProviderTagId = null;
    this._openProviderTagPopover(btnEl, {
      title: t('创建标签'),
      name: '',
      color: 'var(--info)',
      submitLabel: t('创建')
    });
  }

  showEditProviderTagPopover(tagId, btnEl) {
    const tag = (this._providerTags || []).find(t => Number(t.id) === Number(tagId));
    if (!tag) return;
    this._editingProviderTagId = Number(tagId);
    this._openProviderTagPopover(btnEl, {
      title: t('编辑标签'),
      name: tag.name || '',
      color: tag.color || 'var(--info)',
      submitLabel: t('保存')
    });
  }

  hideCreateProviderTagPopover() {
    this._editingProviderTagId = null;
    const popover = document.getElementById('createProviderTagPopover');
    if (popover) popover.style.display = 'none';
  }

  selectProviderTagColor(el) {
    document.querySelectorAll('#providerTagColorPicker .provider-tag-color-dot').forEach(d => d.style.borderColor = 'transparent');
    if (el) { el.style.borderColor = 'var(--foreground)'; this._providerTagColor = el.dataset.color; }
  }

  async saveProviderTag() {
    const nameInput = document.getElementById('newProviderTagName');
    if (!nameInput || !nameInput.value.trim()) { this.showToast(t('请输入标签名称'), 'error'); return; }
    const name = nameInput.value.trim();
    const color = this._providerTagColor || 'var(--info)';
    const editingId = this._editingProviderTagId;
    try {
      const resp = editingId
        ? await fetch(`/api/admin/provider-tags/${editingId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color })
          })
        : await fetch('/api/admin/provider-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color })
          });
      const data = await resp.json();
      if (!resp.ok) { this.showToast(data.error || (editingId ? t('保存失败') : t('创建失败')), 'error'); return; }
      if (editingId) {
        const idx = this._providerTags.findIndex(t => Number(t.id) === Number(editingId));
        if (idx >= 0) this._providerTags[idx] = { ...this._providerTags[idx], ...data };
        // 同步列表中供应商实体上的标签展示
        for (const p of (this.providersData || [])) {
          if (!Array.isArray(p.tags)) continue;
          p.tags = p.tags.map(t => Number(t.id) === Number(editingId) ? { ...t, name: data.name || name, color: data.color || color } : t);
        }
        this.renderProviders();
      } else {
        this._providerTags.push(data);
      }
      this.renderProviderTagBar();
      this.hideCreateProviderTagPopover();
      this.showToast(editingId ? t('标签已更新') : t('标签已创建'), 'success');
    } catch (e) {
      this.showToast(t('网络错误'), 'error');
    }
  }

  /** @deprecated 使用 saveProviderTag */
  async createProviderTag() {
    return this.saveProviderTag();
  }

  async deleteProviderTag(tagId) {
    const ok = await Dialog.confirm(t('删除标签'), t('确定删除此标签？供应商上已有的该标签也会被移除。'), { confirmText: t('删除'), danger: true });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/provider-tags/${tagId}`, { method: 'DELETE' });
      if (!res.ok) { this.showToast(t('删除失败'), 'error'); return; }
      this._providerTags = this._providerTags.filter(t => t.id !== tagId);
      if (Number(this.activeProviderTagId) === Number(tagId)) this.activeProviderTagId = null;
      // 同步本地供应商数据
      for (const p of (this.providersData || [])) {
        if (Array.isArray(p.tags)) p.tags = p.tags.filter(t => Number(t.id) !== Number(tagId));
      }
      this.renderProviderTagBar();
      this.renderProviders();
      this.showToast(t('标签已删除'), 'success');
    } catch (e) { this.showToast(t('删除失败'), 'error'); }
  }

  renderProviderTagAssignment(selectedTags) {
    const container = document.getElementById('providerTagAssignment');
    if (!container) return;
    const selectedIds = new Set((selectedTags || []).map(t => t.id));
    setHTML(container, this._providerTags.map(t => {
      const selected = selectedIds.has(t.id);
      const color = t.color || 'var(--info)';
      return `<span data-tag-id="${t.id}" class="provider-modal-tag ${selected ? 'is-on' : ''}"
        style="--tag-color:${color};"
        onclick="this.dataset.selected=this.dataset.selected==='1'?'0':'1';this.classList.toggle('is-on',this.dataset.selected==='1')"
        data-selected="${selected ? '1' : '0'}">${escapeHtml(t.name)}</span>`;
    }).join('') || '<span style="font-size:12px;color:var(--muted-foreground);">' + t('暂无标签，请先在列表上方创建') + '</span>');
  }

  _getSelectedProviderTagIds() {
    const container = document.getElementById('providerTagAssignment');
    if (!container) return [];
    return [...container.querySelectorAll('[data-tag-id][data-selected="1"]')].map(el => parseInt(el.dataset.tagId, 10));
  }

  formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return '';
    const diff = Math.max(0, Date.now() - date.getTime());
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return t('刚刚');
    if (minutes < 60) return `${minutes}${t('分钟前')}`;
    if (hours < 24) return `${hours}${t('小时前')}`;
    if (days < 30) return `${days}${t('天前')}`;
    return date.toLocaleDateString('zh-CN');
  }

  // ========== 操作日志 ==========

  _adminAuditLogPage = 1;

  async loadAdminAuditLogs(page = 1) {
    this._adminAuditLogPage = page;
    const listEl = document.getElementById('adminAuditLogsList');
    const paginationEl = document.getElementById('adminAuditLogsPagination');
    if (!listEl) return;
    setHTML(listEl, pageLoadingHtml(t('加载操作日志...'), { compact: true }));
    try {
      const q = (document.getElementById('adminAuditLogSearch')?.value || '').trim();
      const resourceType = document.getElementById('adminAuditLogResourceFilter')?.value || '';
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (q) params.set('q', q);
      if (resourceType) params.set('resource_type', resourceType);
      const res = await fetch(`/api/admin/audit-logs?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('加载失败'));
      const { items, total, limit } = data;
      if (!items.length) {
        setHTML(listEl, '<p class="api-key-sub-muted" style="text-align:center;padding:24px;">' + t('暂无操作日志') + '</p>');
        setHTML(paginationEl, '');
        return;
      }
      setHTML(listEl, items.map(log => `
        <div class="audit-log-row" style="display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
              <span style="font-size:12px;padding:2px 8px;border-radius:4px;background:var(--brand-blue);color:#fff;font-weight:500;">${escapeHtml(log.action)}</span>
              ${log.is_admin ? '<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--destructive);color:#fff;">' + t('管理员') + '</span>' : ''}
              <strong style="font-size:13px;">${escapeHtml(log.username || '-')}</strong>
              <span style="font-size:13px;color:var(--foreground);">${escapeHtml(log.description || '')}</span>
            </div>
            <div class="api-key-sub-muted" style="font-size:12px;">
              ${escapeHtml(log.resource_type || '-')}${log.resource_id ? ` #${escapeHtml(String(log.resource_id))}` : ''}
              ${log.ip_address ? ` · IP ${escapeHtml(log.ip_address)}` : ''}
              ${log.status ? ` · HTTP ${log.status}` : ''}
              ${log.duration_ms != null ? ` · ${log.duration_ms}ms` : ''}
            </div>
            ${log.details ? `<details style="margin-top:4px;"><summary style="font-size:12px;color:var(--muted-foreground);cursor:pointer;">详情</summary><pre style="font-size:12px;margin:4px 0 0;white-space:pre-wrap;word-break:break-all;">${escapeHtml(typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2))}</pre></details>` : ''}
          </div>
          <div style="font-size:12px;color:var(--muted-foreground);white-space:nowrap;" title="${escapeHtml(new Date(log.created_at).toLocaleString('zh-CN'))}">${escapeHtml(this.formatRelativeTime(log.created_at))}</div>
        </div>`).join(''));

      const totalPages = Math.ceil(total / limit);
      if (totalPages > 1) {
        setHTML(paginationEl, `
          <button class="btn btn-sm btn-secondary" ${page <= 1 ? 'disabled' : ''} onclick="adminApp.loadAdminAuditLogs(${page - 1})">上一页</button>
          <span style="padding:0 8px;font-size:13px;">${page} / ${totalPages}</span>
          <button class="btn btn-sm btn-secondary" ${page >= totalPages ? 'disabled' : ''} onclick="adminApp.loadAdminAuditLogs(${page + 1})">下一页</button>`);
      } else {
        setHTML(paginationEl, '');
      }
    } catch (error) {
      setHTML(listEl, `<p style="color:var(--destructive);">${escapeHtml(error.message)}</p>`);
      setHTML(paginationEl, '');
    }
  }

  // ========== 提示词（历史自定义提示词，重复合并） ==========

  /** 列表：GET /api/admin/custom-instructions */
  async loadAdminCustomPrompts(page = 1) {
    this.promptPage = Math.max(parseInt(page, 10) || 1, 1);
    const container = document.getElementById('adminPromptsList');
    if (!container) return;
    setHTML(container, pageLoadingHtml(t('加载提示词...'), { compact: true }));

    const search = (document.getElementById('adminPromptSearchInput')?.value || '').trim();
    const source = (document.getElementById('adminPromptSourceFilter')?.value || '').trim();
    const sort = (document.getElementById('adminPromptSortSelect')?.value || 'count').trim();
    const params = new URLSearchParams({ page: String(this.promptPage), pageSize: '20' });
    if (search) params.set('search', search);
    if (source) params.set('source', source);
    if (sort) params.set('sort', sort);

    try {
      const res = await fetch(`/api/admin/custom-instructions?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));

      const countEl = document.getElementById('adminPromptCount');
      const pageInfoEl = document.getElementById('adminPromptPageInfo');
      const prevBtn = document.getElementById('adminPromptPrevBtn');
      const nextBtn = document.getElementById('adminPromptNextBtn');
      const totalPages = Math.ceil((data.total || 0) / 20) || 1;

      if (countEl) countEl.textContent = `${t('共')}${data.total || 0}${t('条去重结果')}`;
      if (pageInfoEl) pageInfoEl.textContent = `${t('第')}${data.page} / ${totalPages}${t('页')}`;
      if (prevBtn) prevBtn.disabled = data.page <= 1;
      if (nextBtn) nextBtn.disabled = data.page >= totalPages;

      if (!data.items || data.items.length === 0) {
        setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:40px;">' + t('暂无提示词记录') + '</p>');
        return;
      }
      this._promptsCache = data.items;

      setHTML(container, `
        <table>
          <thead>
            <tr>
              <th>${t('文件名')}</th>
              <th>${t('来源')}</th>
              <th>${t('字符数')}</th>
              <th>${t('出现次数')}</th>
              <th>${t('关联用户')}</th>
              <th>${t('首次出现')}</th>
              <th>${t('最近出现')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${data.items.map((item, idx) => `
              <tr style="cursor:pointer;" data-admin-prompt-idx="${idx}" title="${t('点击查看详情')}">
                <td class="cell-clip" style="max-width:280px;">
                  <div style="font-weight:500;display:flex;align-items:center;gap:6px;">📄 ${escapeHtml(item.file || t('(未知文件)'))}${item.truncated ? `<span style="font-size:11px;color:var(--muted-foreground);">(${t('截断存储')})</span>` : ''}</div>
                  <div style="font-size:11px;color:var(--muted-foreground);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.preview || '')}</div>
                </td>
                <td>${this._usageRequestSourceBadge(item.source)}</td>
                <td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${(parseInt(item.chars, 10) || 0).toLocaleString()}</td>
                <td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${(parseInt(item.occurrence_count, 10) || 0).toLocaleString()}</td>
                <td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${(parseInt(item.user_count, 10) || 0).toLocaleString()}</td>
                <td style="white-space:nowrap;font-size:12px;">${escapeHtml(new Date(item.first_seen).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
                <td style="white-space:nowrap;font-size:12px;">${escapeHtml(new Date(item.last_seen).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
                <td class="cell-actions"><button type="button" class="btn btn-sm btn-secondary" data-admin-prompt-view-idx="${idx}">${t('查看内容')}</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `);

      container.querySelectorAll('tr[data-admin-prompt-idx]').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          const item = this._promptsCache[parseInt(tr.getAttribute('data-admin-prompt-idx'), 10)];
          if (item) this.showAdminPromptDetail(item.fingerprint);
        });
      });
      container.querySelectorAll('button[data-admin-prompt-view-idx]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const item = this._promptsCache[parseInt(btn.getAttribute('data-admin-prompt-view-idx'), 10)];
          if (item) this.showAdminPromptDetail(item.fingerprint);
        });
      });
    } catch (error) {
      console.error(t('加载提示词失败:'), error);
      setHTML(container, `<p style="text-align:center;color:var(--destructive);padding:40px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  clearAdminPromptFilters() {
    for (const id of ['adminPromptSearchInput', 'adminPromptSourceFilter']) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    const sortEl = document.getElementById('adminPromptSortSelect');
    if (sortEl) sortEl.value = 'count';
    this.loadAdminCustomPrompts(1);
  }

  /** 详情弹窗：完整内容 + 最近引用记录 */
  async showAdminPromptDetail(fingerprint) {
    const modal = document.getElementById('adminPromptDetailModal');
    const body = document.getElementById('adminPromptDetailBody');
    if (!modal || !body) return;
    body.innerHTML = pageLoadingHtml(t('加载详情...'), { compact: true });
    modal.style.display = 'flex';
    modal.classList.add('active');

    try {
      const res = await fetch(`/api/admin/custom-instructions/${encodeURIComponent(fingerprint)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));

      const titleEl = document.getElementById('adminPromptDetailTitle');
      if (titleEl) titleEl.textContent = `${t('提示词详情')} · ${data.file || t('(未知文件)')}`;

      const fmtTime = (v) => v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
      const rows = [
        [t('文件名'), escapeHtml(data.file || t('(未知文件)'))],
        [t('客户端'), this._usageRequestSourceBadge(data.source)],
        [t('字符数'), (parseInt(data.chars, 10) || 0).toLocaleString()],
        [t('出现次数'), `${(parseInt(data.occurrence_count, 10) || 0).toLocaleString()}${data.truncated ? ` <span style="font-size:11px;color:var(--muted-foreground);">(${t('截断存储')})</span>` : ''}`],
        [t('关联用户'), (parseInt(data.user_count, 10) || 0).toLocaleString()],
        [t('注入位置'), (data.positions || []).length ? escapeHtml(data.positions.join(', ')) : '-'],
        [t('首次出现'), escapeHtml(fmtTime(data.first_seen))],
        [t('最近出现'), escapeHtml(fmtTime(data.last_seen))],
      ];

      let refsHtml = '';
      if (Array.isArray(data.recent_refs) && data.recent_refs.length) {
        refsHtml = `
          <h4 style="margin:16px 0 8px;font-size:14px;">${t('最近引用记录')}（${t('最近')} ${data.recent_refs.length} ${t('条')}）</h4>
          <div style="overflow-x:auto;">
            <table>
              <thead><tr><th>${t('记录 ID')}</th><th>${t('时间')}</th><th>${t('用户')}</th><th>${t('模型')}</th><th>${t('客户端')}</th></tr></thead>
              <tbody>
                ${data.recent_refs.map(r => `
                  <tr>
                    <td><code style="font-size:12px;">${escapeHtml(String(r.record_id))}</code></td>
                    <td style="white-space:nowrap;font-size:12px;">${escapeHtml(fmtTime(r.created_at))}</td>
                    <td>${escapeHtml(r.username || String(r.user_id ?? '-'))}</td>
                    <td class="cell-clip" style="max-width:220px;">${escapeHtml(r.model_id || '-')}</td>
                    <td>${this._usageRequestSourceBadge(r.request_source)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>`;
      }

      setHTML(body, `
        ${rows.map(([label, value]) => `
          <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="color:var(--muted-foreground);font-size:13px;">${label}</span>
            <span style="font-size:14px;">${value}</span>
          </div>
        `).join('')}
        <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:12px 0 0;border-bottom:1px solid var(--border);">
          <span style="color:var(--muted-foreground);font-size:13px;">${t('完整内容')}</span>
          <pre id="adminPromptFullContent" style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:360px;overflow-y:auto;">${escapeHtml(data.content || '')}</pre>
        </div>
        <div style="padding:8px 0;"><button type="button" class="btn btn-sm btn-secondary" onclick="adminApp.copyAdminPromptContent(this)">⧉ ${t('复制内容')}</button></div>
        ${refsHtml}
      `);
    } catch (error) {
      console.error(t('加载提示词详情失败:'), error);
      setHTML(body, `<p style="text-align:center;color:var(--destructive);padding:20px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  copyAdminPromptContent(btn) {
    const text = document.getElementById('adminPromptFullContent')?.textContent || '';
    const done = () => {
      if (!btn) return;
      const original = btn.innerHTML;
      btn.innerHTML = `✓ ${t('已复制')}`;
      setTimeout(() => { btn.innerHTML = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch { /* 忽略 */ }
      document.body.removeChild(ta);
    }
  }

  // ========== 自动更新 ==========

  /**
   * 启动时静默检查，有更新则顶栏 banner
   */
  async checkUpdateBanner() {
    try {
      console.log(t('[Update] 静默检查官方版本…'));
      const resp = await fetch('/api/admin/update/check', { credentials: 'same-origin' });
      if (!resp.ok) {
        console.warn(t('[Update] 检查失败 HTTP'), resp.status);
        return;
      }
      const data = await resp.json();
      this._updateInfo = data;
      console.log(t('[Update] 检查结果:'), data);
      this.renderUpdateBanner(data);
      this.renderUpdatePanel(data);
    } catch (err) {
      console.warn(t('[Update] checkUpdateBanner 异常:'), err);
    }
  }

  renderUpdateBanner(data) {
    let banner = document.getElementById('updateAvailableBanner');
    if (!data || !data.hasUpdate) {
      if (banner) banner.style.display = 'none';
      return;
    }

    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'updateAvailableBanner';
      banner.style.cssText =
        'background:#eff6ff;color:#1e40af;padding:10px 16px;font-size:13px;border-bottom:1px solid #93c5fd;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;';
      const main = document.querySelector('.main-content') || document.body;
      const header = main.querySelector('.content-header');
      if (header && header.nextSibling) {
        main.insertBefore(banner, header.nextSibling);
      } else {
        main.insertBefore(banner, main.firstChild);
      }
    }

    const cur = escapeHtml(data.currentVersion || '?');
    const lat = escapeHtml(data.latestVersion || '?');
    setHTML(banner, `
      <span>发现新版本 <strong>v${lat}</strong>（当前 v${cur}）。建议在系统设置中一键更新。</span>
      <span style="display:flex;gap:8px;">
        <button type="button" class="btn btn-sm btn-secondary" onclick="adminApp.navigateTo('adminSettings')">查看详情</button>
        <button type="button" class="btn btn-sm btn-primary" id="bannerUpdateApplyBtn" onclick="adminApp.applyUpdate()">一键更新</button>
      </span>
    `);
    banner.style.display = 'flex';

    // Docker 等不可 apply 时禁用
    const applyBtn = document.getElementById('bannerUpdateApplyBtn');
    if (applyBtn && data.canApply === false) {
      applyBtn.disabled = true;
      applyBtn.title = data.reason || t('当前环境不支持一键更新');
    }
  }

  async loadUpdatePanel() {
    // 优先用缓存；进入设置页时也拉一次 runtime 状态
    try {
      const statusResp = await fetch('/api/admin/update/status', { credentials: 'same-origin' });
      if (statusResp.ok) {
        const st = await statusResp.json();
        if (st.currentVersion || st.latestVersion) {
          this.renderUpdatePanel({
            currentVersion: st.currentVersion,
            latestVersion: st.latestVersion,
            hasUpdate: st.hasUpdate,
            canApply: st.canApply,
            reason: st.reason,
            lastCheckedAt: st.lastCheckedAt,
            phase: st.phase,
            message: st.message,
            progress: st.progress,
            error: st.error,
          });
        }
      }
      // 若从未检查过，自动检查一次
      if (!this._updateInfo) {
        await this.checkForUpdate(false);
      } else {
        this.renderUpdatePanel(this._updateInfo);
      }
    } catch (err) {
      console.error(t('[Update] loadUpdatePanel 失败:'), err);
    }
  }

  /**
   * @param {boolean} interactive 是否弹窗提示结果
   */
  async checkForUpdate(interactive = true) {
    const checkBtn = document.getElementById('updateCheckBtn');
    if (checkBtn) {
      checkBtn.disabled = true;
      setButtonLoading(checkBtn, t('检查中…'));
    }
    this.setUpdateProgress(true, t('正在检查更新…'), 10);

    try {
      console.log(t('[Update] 请求 /api/admin/update/check'));
      const resp = await fetch('/api/admin/update/check', { credentials: 'same-origin' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || `${t('检查失败 (')}${resp.status})`);
      }
      this._updateInfo = data;
      console.log(t('[Update] 结果:'), data);
      this.renderUpdateBanner(data);
      this.renderUpdatePanel(data);
      this.setUpdateProgress(false);

      if (interactive) {
        if (data.hasUpdate) {
          if (typeof Dialog !== 'undefined') {
            await Dialog.alert(
              t('发现新版本'),
              `${t('最新版本 ')}<strong>v${escapeHtml(data.latestVersion)}${'</strong>' + t('，当前 v')}${escapeHtml(data.currentVersion)}${t('。可点击「一键更新」安装。')}`
            );
          } else {
            alert(`${t('发现新版本 v')}${data.latestVersion}${t('（当前 v')}${data.currentVersion}）`);
          }
        } else {
          if (typeof Dialog !== 'undefined') {
            await Dialog.alert(t('已是最新'), `${t('当前版本 v')}${escapeHtml(data.currentVersion)}${t('已是最新。')}`);
          } else {
            alert(`${t('已是最新版本 v')}${data.currentVersion}`);
          }
        }
      }
      return data;
    } catch (err) {
      console.error(t('[Update] 检查更新失败:'), err);
      this.setUpdateProgress(true, err.message || t('检查失败'), 0);
      if (interactive) {
        if (typeof Dialog !== 'undefined') {
          await Dialog.alert(t('检查失败'), escapeHtml(err.message || t('网络错误')));
        } else {
          alert(err.message || t('检查更新失败'));
        }
      }
      return null;
    } finally {
      if (checkBtn) {
        checkBtn.disabled = false;
        clearButtonLoading(checkBtn, t('检查更新'));
      }
    }
  }

  renderUpdatePanel(data) {
    if (!data) return;
    const curEl = document.getElementById('updateCurrentVersion');
    const latEl = document.getElementById('updateLatestVersion');
    const statusEl = document.getElementById('updateStatusLabel');
    const checkedEl = document.getElementById('updateLastChecked');
    const hintEl = document.getElementById('updateCanApplyHint');
    const applyBtn = document.getElementById('updateApplyBtn');

    if (curEl) curEl.textContent = data.currentVersion ? `v${data.currentVersion}` : '-';
    if (latEl) {
      latEl.textContent = data.latestVersion ? `v${data.latestVersion}` : '-';
      latEl.style.color = data.hasUpdate ? '#2563eb' : '';
    }
    if (statusEl) {
      if (data.phase === 'error') {
        statusEl.textContent = t('更新失败');
        statusEl.style.color = 'var(--danger)';
      } else if (data.hasUpdate) {
        statusEl.textContent = t('有可用更新');
        statusEl.style.color = '#2563eb';
      } else if (data.latestVersion) {
        statusEl.textContent = t('已是最新');
        statusEl.style.color = '#16a34a';
      } else {
        statusEl.textContent = t('未检查');
        statusEl.style.color = '';
      }
    }
    if (checkedEl) {
      checkedEl.textContent = data.lastCheckedAt
        ? new Date(data.lastCheckedAt).toLocaleString('zh-CN')
        : '-';
    }
    if (hintEl) {
      if (data.canApply === false && data.reason) {
        hintEl.style.display = 'block';
        hintEl.textContent = data.reason;
      } else {
        hintEl.style.display = 'none';
        hintEl.textContent = '';
      }
    }
    if (applyBtn) {
      applyBtn.disabled = !(data.hasUpdate && data.canApply !== false);
    }
  }

  setUpdateProgress(show, text, progress) {
    const box = document.getElementById('updateProgressBox');
    const textEl = document.getElementById('updateProgressText');
    const bar = document.getElementById('updateProgressBar');
    if (!box) return;
    box.style.display = show ? 'block' : 'none';
    if (textEl && text != null) textEl.textContent = text;
    if (bar && progress != null) bar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    // 错误样式
    if (show && progress === 0 && text && /失败|错误/.test(text)) {
      box.style.background = '#fef2f2';
      box.style.color = '#991b1b';
      box.style.borderColor = '#fecaca';
    } else if (show) {
      box.style.background = '#eff6ff';
      box.style.color = '#1e40af';
      box.style.borderColor = '#bfdbfe';
    }
  }

  async applyUpdate() {
    const info = this._updateInfo;
    if (!info || !info.hasUpdate) {
      const fresh = await this.checkForUpdate(false);
      if (!fresh || !fresh.hasUpdate) {
        if (typeof Dialog !== 'undefined') {
          await Dialog.alert(t('无需更新'), t('当前已是最新版本。'));
        } else {
          alert(t('当前已是最新版本'));
        }
        return;
      }
    }

    if (this._updateInfo && this._updateInfo.canApply === false) {
      const msg = this._updateInfo.reason || t('当前环境不支持一键更新');
      if (typeof Dialog !== 'undefined') {
        await Dialog.alert(t('无法更新'), escapeHtml(msg));
      } else {
        alert(msg);
      }
      return;
    }

    const toVer = (this._updateInfo && this._updateInfo.latestVersion) || t('最新版');
    let confirmed = true;
    if (typeof Dialog !== 'undefined') {
      confirmed = await Dialog.confirm(
        t('确认一键更新'),
        `${t('将下载并安装 ')}<strong>v${escapeHtml(toVer)}</strong>${t('，服务会短暂中断并自动重启。')}${'<br><br>' + t('配置文件 config.json 与数据库不会被覆盖。是否继续？')}`,
        { confirmText: t('开始更新'), cancelText: t('取消') }
      );
    } else {
      confirmed = confirm(`${t('确认更新到 v')}${toVer}${t('？服务将短暂中断并自动重启。')}`);
    }
    if (!confirmed) {
      console.log(t('[Update] 用户取消更新'));
      return;
    }

    const applyBtn = document.getElementById('updateApplyBtn');
    const checkBtn = document.getElementById('updateCheckBtn');
    const bannerBtn = document.getElementById('bannerUpdateApplyBtn');
    if (applyBtn) {
      applyBtn.disabled = true;
      setButtonLoading(applyBtn, t('更新中…'));
    }
    if (checkBtn) checkBtn.disabled = true;
    if (bannerBtn) bannerBtn.disabled = true;

    this.setUpdateProgress(true, t('开始下载安装…'), 5);
    this._startUpdateStatusPoll();

    try {
      console.log('[Update] POST /api/admin/update/apply');
      const resp = await fetch('/api/admin/update/apply', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json().catch(() => ({}));
      console.log(t('[Update] apply 响应:'), resp.status, data);

      if (!resp.ok) {
        throw new Error(data.error || `${t('更新失败 (')}${resp.status})`);
      }

      this.setUpdateProgress(true, data.message || t('安装完成，正在重启…'), 95);
      await this._waitForServerRestart(data.toVersion || toVer);
    } catch (err) {
      // 重启过程中 fetch 可能被中断，当作重启中处理
      const msg = err.message || String(err);
      console.warn(t('[Update] apply 请求结束:'), msg);
      if (/Failed to fetch|NetworkError|network|fetch|ECONNRESET|aborted/i.test(msg)) {
        this.setUpdateProgress(true, t('连接已断开，等待服务重启…'), 90);
        await this._waitForServerRestart(toVer);
      } else {
        this._stopUpdateStatusPoll();
        this.setUpdateProgress(true, msg, 0);
        if (typeof Dialog !== 'undefined') {
          await Dialog.alert(t('更新失败'), escapeHtml(msg));
        } else {
          alert(msg);
        }
        if (applyBtn) {
          applyBtn.disabled = false;
          clearButtonLoading(applyBtn, t('一键更新'));
        }
        if (checkBtn) checkBtn.disabled = false;
        if (bannerBtn) bannerBtn.disabled = false;
      }
    }
  }

  _startUpdateStatusPoll() {
    this._stopUpdateStatusPoll();
    this._updatePollTimer = setInterval(async () => {
      try {
        const resp = await fetch('/api/admin/update/status', { credentials: 'same-origin' });
        if (!resp.ok) return;
        const st = await resp.json();
        console.log(t('[Update] 状态轮询:'), st.phase, st.progress, st.message);
        if (st.message != null) {
          this.setUpdateProgress(true, st.message, st.progress != null ? st.progress : 50);
        }
        if (st.phase === 'error') {
          this._stopUpdateStatusPoll();
          this.setUpdateProgress(true, st.error || st.message || t('更新失败'), 0);
        }
      } catch (_) {
        // 重启中可能失败，忽略
      }
    }, 1000);
  }

  _stopUpdateStatusPoll() {
    if (this._updatePollTimer) {
      clearInterval(this._updatePollTimer);
      this._updatePollTimer = null;
    }
  }

  /**
   * 重启后探测服务恢复
   */
  async _waitForServerRestart(expectedVersion) {
    this._stopUpdateStatusPoll();
    this.setUpdateProgress(true, t('服务正在重启，请稍候…'), 96);
    console.log(t('[Update] 等待服务恢复，期望版本:'), expectedVersion);

    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const resp = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' });
        if (!resp.ok) continue;
        const data = await resp.json();
        console.log(t('[Update] 重启探测 /api/version:'), data);
        if (data && data.version) {
          this.setUpdateProgress(true, `${t('服务已恢复（v')}${data.version}）`, 100);
          if (typeof Dialog !== 'undefined') {
            await Dialog.alert(
              t('更新完成'),
              `${t('服务已重启。当前版本：')}<strong>v${escapeHtml(data.version)}</strong>`
            );
          } else {
            alert(`${t('更新完成，当前版本 v')}${data.version}`);
          }
          window.location.reload();
          return;
        }
      } catch (e) {
        console.log(t('[Update] 等待中…'), i + 1, e.message);
      }
      this.setUpdateProgress(
        true,
        `${t('等待服务恢复… (')}${i + 1}/${maxAttempts})`,
        96 + Math.min(3, Math.floor(i / 20))
      );
    }

    this.setUpdateProgress(true, t('等待超时：请手动刷新页面或检查服务是否已启动'), 0);
    if (typeof Dialog !== 'undefined') {
      await Dialog.alert(
        t('请手动确认'),
        t('服务可能已更新并重启，但页面未能自动连上。请刷新页面或检查进程状态。')
      );
    } else {
      alert(t('请手动刷新页面确认更新结果'));
    }
    const applyBtn = document.getElementById('updateApplyBtn');
    const checkBtn = document.getElementById('updateCheckBtn');
    if (applyBtn) {
      applyBtn.disabled = false;
      clearButtonLoading(applyBtn, t('一键更新'));
    }
    if (checkBtn) checkBtn.disabled = false;
  }
}

// 初始化应用
let adminApp;
document.addEventListener('DOMContentLoaded', () => {
  adminApp = new AdminApp();
});
