const TOOL_SUMMARY_RULES = [
  [/^(bash|run_terminal_command|terminal|shell)$/i, (a) => String(a.command || a.cmd || '').split('\n')[0].slice(0, 100)],
  [/^read$/i, (a) => String(a.file_path || a.path || '')],
  [/^(write|edit|multiedit|notebookedit)$/i, (a) => {
    const p = String(a.file_path || a.path || '');
    const lines = typeof a.content === 'string' ? a.content.split('\n').length : '';
    return lines ? `${p} (+${lines})` : p;
  }],
  [/^grep$/i, (a) => `"${String(a.pattern || '').slice(0, 60)}"${a.path ? ' in ' + a.path : ''}`],
  [/^(websearch|web_fetch|fetch)$/i, (a) => `"${String(a.query || a.url || '').slice(0, 80)}"`],
  [/^(todowrite|todo_write)$/i, (a) => `${Array.isArray(a.todos) ? a.todos.length + ' items' : ''}`.trim()],
  [/^(glob|ls)$/i, (a) => String(a.pattern || a.path || '')],
];

function summarizeToolCall(name, argsObj, argsPreview) {
  let args = argsObj && typeof argsObj === 'object' ? argsObj : null;
  if (!args && argsPreview) { try { args = JSON.parse(argsPreview); } catch (_) {} }
  if (!args || typeof args !== 'object') return '';
  for (const [re, fn] of TOOL_SUMMARY_RULES) {
    if (re.test(name)) {
      try { return String(fn(args) || ''); } catch (_) { break; }
    }
  }
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (typeof v === 'string' || typeof v === 'number') return `${k}: ${String(v).slice(0, 90)}`;
  }
  return '';
}


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

// 用户控制台应用
class ConsoleApp {
  constructor() {
    this.user = null;
    this.currentPage = 'modelLibrary';
    this._libraryData = null;
    this._libraryCurrentModel = null;
    this._libraryLoadingProviders = new Set(); // 正在加载模型明细的供应商 key
    this._libraryLoadingProviderPromises = new Map();
    this.librarySearch = '';
    this.libraryProviderFilter = 'all';
    this.librarySeriesFilter = 'all';
    this.libraryTestFilter = 'all';
    this.libraryProviderTagFilter = 'all';
    this.librarySort = 'default';
    this._libraryProviderPageSize = 50;
    this.libraryReorderMode = false;
    this._librarySavingOrder = false;
    this._libraryApplyingTestOrder = false;
    this.libraryShowHidden = false;
    this._librarySavingHidden = false;
    this._librarySavingStar = false;
    this._librarySelectedKeyId = null;
    this._libraryKeys = [];
    /** 模型库绑定目标：'default' | harness id（如 claude_code） */
    this._libraryBindTarget = 'default';
    this._libraryKeyBubbleCloser = null;
    this._libraryKeyBubbleCloseTimer = null;
    this._keyModelPicker = null;
    this._libraryGlobalSearchSeq = 0;
    this._libraryGlobalSearchTimer = null;
    this._libraryGlobalSearchMode = false;
    this._libraryGlobalSearchResults = null;
    this._libraryStickyObserver = null;
    this._libraryStickyEventsBound = false;
    this._libraryStickyKeyMenuCloser = null;
    this._apiKeysStickyObserver = null;
    this._myUpstreamTab = 'providers';
    this._pendingUpstreamTab = null;
    this._ccsStyle = 'compact';
    this._providersIndex = [];
    this._selectedProvider = null;
    this._currentManageProviderId = null;
    this._currentManageModels = [];
    this._keyTags = [];
    this._pendingProviderRenderRaf = null;
    this._hashRouteBound = false;
    this._ignoreHashChange = false;
    // 会话总结状态（后台生成任务与切换会话隔离）
    this._summaryPending = false;
    this._summaryPendingKeys = new Set();
    this._sessionSummaryText = '';
    this._summaryDoneFor = null;
    this._summaryError = null;
    this._summarySeq = 0;
    // per-session 总结缓存命中状态：cachedKeys 记录「已有缓存」的会话，checkedKeys 记录「已查过」的会话，避免重复查询
    this._summaryCachedKeys = new Set();
    this._summaryCheckedKeys = new Set();
    this._summaryCacheTextMap = {};   // sessionKey -> 已确认的缓存文案，供顶部内联展示复用
    this._summaryCacheTimeMap = {};   // sessionKey -> 缓存生成时间
    this._summaryTaskSessionKey = null;
    this._summaryTaskText = '';
    this._summaryPhaseMap = Object.create(null);
    this._detailCursor = null;
    this._detailRequestSeq = 0;
    this.init();
  }

  /** 控制台可路由页面 id */
  _consolePageIds() {
    return new Set([
      'modelLibrary', 'myUpstream', 'apiKeys', 'stats', 'projectWork',
      'leaderboard', 'docs', 'balance', 'settings'
    ]);
  }

  /**
   * 解析 hash：#modelLibrary、#myUpstream/models、#docs/chat
   * 兼容旧写法 #dashboard / #myProviders / #myTeamModels
   */
  _parseConsoleHash(hash) {
    const raw = String(hash || '').replace(/^#/, '').trim();
    if (!raw) return { page: null, upstreamTab: null, docPage: null };

    const [pagePart, extra] = raw.split('/');
    let page = pagePart || null;
    let upstreamTab = null;
    let docPage = null;

    // 旧入口兼容
    if (page === 'dashboard') page = 'modelLibrary';
    if (page === 'myProviders') {
      page = 'myUpstream';
      upstreamTab = 'providers';
    } else if (page === 'myTeamModels') {
      page = 'myUpstream';
      upstreamTab = 'models';
    }

    if (page && !this._consolePageIds().has(page)) page = null;

    if (page === 'myUpstream' && extra) {
      if (extra === 'models' || extra === 'providers') upstreamTab = extra;
    }
    if (page === 'docs' && extra) {
      const validDocs = new Set([
        'overview', 'chat', 'models', 'anthropic', 'user-api', 'conversations', 'errors'
      ]);
      if (validDocs.has(extra)) docPage = extra;
    }

    return { page, upstreamTab, docPage };
  }

  _buildConsoleHash(page, options = {}) {
    if (page === 'myUpstream') {
      const tab = options.upstreamTab === 'models' ? 'models' : 'providers';
      return `#myUpstream/${tab}`;
    }
    if (page === 'docs' && options.docPage && options.docPage !== 'overview') {
      return `#docs/${options.docPage}`;
    }
    return `#${page}`;
  }

  _writeConsoleHash(page, options = {}) {
    const next = this._buildConsoleHash(page, options);
    if (location.hash === next) return;
    // 统一 replace，避免侧边栏切换堆出大量历史记录
    history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
  }

  _bindHashRouting() {
    if (this._hashRouteBound) return;
    this._hashRouteBound = true;
    window.addEventListener('hashchange', () => {
      if (this._ignoreHashChange) return;
      const restored = this._parseConsoleHash(location.hash);
      const page = restored.page || 'modelLibrary';
      this.navigateTo(page, {
        skipHash: true,
        upstreamTab: restored.upstreamTab,
        docPage: restored.docPage
      });
    });
  }

  async init() {
    await this.loadUserInfo();
    if (!this.user) return;
    this.bindEvents();
    this._bindHashRouting();
    // 从 URL hash 恢复页面（刷新后保持原位置）
    const restored = this._parseConsoleHash(location.hash);
    const startPage = restored.page || 'modelLibrary';
    await this.navigateTo(startPage, {
      skipHash: true,
      upstreamTab: restored.upstreamTab,
      docPage: restored.docPage
    });
    // 若无 hash，写入默认 hash，便于复制链接
    if (!restored.page) {
      this._writeConsoleHash(startPage, {
        upstreamTab: startPage === 'myUpstream' ? (restored.upstreamTab || 'providers') : null,
        docPage: restored.docPage || null
      });
    }
    this.checkAdminStatus();
    this._maybeShowStatsConsent();
  }

  async loadUserInfo() {
    try {
      const response = await fetch('/auth/me', { credentials: 'same-origin' });
      if (response.ok) {
        this.user = await response.json();
        // 飞书等无密码账号：强制前往设置密码
        if (this.user.needsPasswordSetup) {
          window.location.replace('/set-password');
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
    if (usernameEl) usernameEl.textContent = this.user.username;
    if (avatarEl) {
      avatarEl.src = this.user.avatar || '';
      avatarEl.onerror = () => {
        avatarEl.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect fill="%233b82f6" width="32" height="32" rx="16"/><text x="50%" y="50%" font-size="14" fill="white" text-anchor="middle" dy=".3em">${this.user.username.charAt(0).toUpperCase()}</text></svg>`;
      };
    }
  }

  checkAdminStatus() {
    const adminLink = document.getElementById('adminLink');
    if (adminLink && this.user.isAdmin) {
      adminLink.style.display = 'flex';
      adminLink.onclick = () => window.location.href = '/admin';
    }
    // 「提示词」页读取全局聚合数据（/api/admin/*），仅对管理员显示入口
    const promptsNav = document.getElementById('promptsNav');
    if (promptsNav && this.user.isAdmin) {
      promptsNav.style.display = 'flex';
    }
  }

  // 统计上报授权：仅管理员首次进入控制台时，且从未做过决定（stats_report_enabled 未设置）时弹窗
  async _maybeShowStatsConsent() {
    if (!this.user?.isAdmin) return;
    try {
      // 演示模式（demo: true）下不询问、不上报
      const cfgRes = await fetch('/api/config', { credentials: 'same-origin' });
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (cfg.demo) return;
      }
      const res = await fetch('/api/admin/settings', { credentials: 'same-origin' });
      if (!res.ok) return;
      const settings = await res.json();
      if (settings['stats_report_enabled'] !== undefined) return;
      this.showModal('statsConsentModal');
    } catch (error) {
      console.warn(t('检查统计上报授权失败:'), error);
    }
  }

  async _setStatsConsent(allow) {
    this.closeModals();
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats_report_enabled: !!allow, stats_report_granularity: 'detailed' })
      });
      if (!res.ok) {
        console.warn(t('保存统计上报授权失败:'), res.status);
      }
    } catch (error) {
      console.warn(t('保存统计上报授权失败:'), error);
    }
  }

  bindEvents() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => this.navigateTo(item.dataset.page));
    });

    document.querySelectorAll('[data-settings-category]').forEach(item => {
      item.addEventListener('click', () => this.showSettingsCategory(item.dataset.settingsCategory));
    });
    document.getElementById('settingsBackButton')?.addEventListener('click', () => this.showSettingsOverview());

    document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());
    document.getElementById('createApiKeyBtn')?.addEventListener('click', () => this.showModal('createApiKeyModal'));
    document.getElementById('confirmCreateApiKey')?.addEventListener('click', () => this.createApiKey());
    document.getElementById('confirmAddEditModel')?.addEventListener('click', () => this.submitAddEditModel());


    // Avatar upload
    document.getElementById('avatarFileInput')?.addEventListener('change', (e) => this.uploadAvatar(e));

    // Change password
    document.getElementById('changePasswordBtn')?.addEventListener('click', () => this.changePassword());

    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => this.closeModals());
    });

    // 统计上报授权弹窗按钮（首次进入控制台，仅管理员可见）
    document.getElementById('statsConsentAllow')?.addEventListener('click', () => this._setStatsConsent(true));
    document.getElementById('statsConsentReject')?.addEventListener('click', () => this._setStatsConsent(false));

    // 点击遮罩空白处关闭弹窗（点到 .modal 本身，而非 .modal-content）
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModals();
      });
    });

    // Model library filters
    this._ensureLibraryReorderControls();
    this._initLibraryDragDrop();
    document.getElementById('librarySearchInput')?.addEventListener('input', (e) => {
      this._onLibrarySearchInput(e.target.value, 'main');
    });
    document.getElementById('libraryProviderFilter')?.addEventListener('change', (e) => {
      this._onLibraryProviderFilterChange(e.target.value, 'main');
    });
    document.getElementById('librarySeriesFilter')?.addEventListener('change', (e) => {
      this._onLibrarySeriesFilterChange(e.target.value, 'main');
    });
    document.getElementById('libraryTestFilter')?.addEventListener('change', (e) => {
      this._onLibraryTestFilterChange(e.target.value, 'main');
    });
    document.getElementById('libraryProviderTagFilter')?.addEventListener('change', (e) => {
      this._onLibraryProviderTagFilterChange(e.target.value, 'main');
    });
    document.getElementById('librarySort')?.addEventListener('change', (e) => {
      this._onLibrarySortChange(e.target.value, 'main');
    });

    // 模型测试徽章悬停动态时间提示
    document.getElementById('modelLibraryContent')?.addEventListener('mouseover', (e) => {
      const badge = e.target.closest('.model-test-badge');
      if (!badge) return;
      const testedAt = badge.getAttribute('data-tested-at');
      if (!testedAt || badge.getAttribute('title')) return;
      badge.setAttribute('title', this._formatTestTooltip(testedAt));
    });
    document.getElementById('keyModelsContent')?.addEventListener('mouseover', (e) => {
      const badge = e.target.closest('.model-test-badge');
      if (!badge) return;
      const testedAt = badge.getAttribute('data-tested-at');
      if (!testedAt || badge.getAttribute('title')) return;
      badge.setAttribute('title', this._formatTestTooltip(testedAt));
    });

    // Stats custom date range toggle
    document.getElementById('statsTimeRange')?.addEventListener('change', (e) => {
      const custom = document.getElementById('statsCustomDateRange');
      if (custom) custom.style.display = e.target.value === 'custom' ? 'flex' : 'none';
    });
    document.getElementById('projectWorkTimeRange')?.addEventListener('change', (e) => {
      const custom = document.getElementById('projectWorkCustomRange');
      if (custom) custom.style.display = e.target.value === 'custom' ? 'flex' : 'none';
    });
  }

  async navigateTo(page, options = {}) {
    // 旧入口重定向到合并页
    let targetPage = page;
    let upstreamTab = options.upstreamTab || null;
    const docPage = options.docPage || null;
    if (page === 'myProviders') {
      targetPage = 'myUpstream';
      upstreamTab = upstreamTab || 'providers';
    } else if (page === 'myTeamModels') {
      targetPage = 'myUpstream';
      upstreamTab = upstreamTab || 'models';
    }

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${targetPage}"]`)?.classList.add('active');

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`${targetPage}Page`)?.classList.add('active');

    const titles = {
      'dashboard': t('控制台'), 'modelLibrary': t('模型库'), 'myUpstream': t('我的上游'),
      'myProviders': t('我的上游'), 'myTeamModels': t('我的上游'),
      'apiKeys': t('API Key 与用量'), 'stats': t('统计信息'), 'projectWork': t('项目工作'), 'leaderboard': t('排行榜'), 'docs': t('接口文档'),
      'balance': t('积分'), 'settings': t('用户设置'), 'auditLogs': t('操作日志'), 'prompts': t('提示词')
    };
    const pageTitleEl = document.getElementById('pageTitle');
    if (pageTitleEl) pageTitleEl.textContent = titles[targetPage] || targetPage;
    // 同步移动端顶部标题
    const mobileTitle = document.getElementById('mobilePageTitle');
    if (mobileTitle) mobileTitle.textContent = titles[targetPage] || targetPage;
    // 关闭移动端侧边栏
    document.querySelector('.sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-overlay')?.classList.remove('active');
    this.currentPage = targetPage;
    this._pendingUpstreamTab = upstreamTab;
    if (targetPage !== 'modelLibrary') {
      this._syncLibraryStickyVisibility(false);
      this.closeLibraryStickyKeyMenu();
    }
    if (targetPage !== 'apiKeys') {
      this._syncApiKeysStickyVisibility(false);
    }

    // 写入 hash，刷新后可恢复；我的上游附带页签，文档附带子页
    if (!options.skipHash) {
      this._ignoreHashChange = true;
      this._writeConsoleHash(targetPage, {
        upstreamTab: targetPage === 'myUpstream'
          ? (upstreamTab || this._myUpstreamTab || 'providers')
          : null,
        docPage: targetPage === 'docs'
          ? (docPage || (typeof currentDocPage !== 'undefined' ? currentDocPage : 'overview'))
          : null
      });
      queueMicrotask(() => { this._ignoreHashChange = false; });
    }

    await this.loadPage(targetPage);

    // 恢复文档子页（showDocPage 定义在 console.html）
    if (targetPage === 'docs' && docPage && typeof showDocPage === 'function') {
      showDocPage(docPage, { skipHash: true });
    }
  }

  async loadPage(page) {
    // 清除统计页面的自动刷新定时器
    if (this._statsRefreshTimer) {
      clearInterval(this._statsRefreshTimer);
      this._statsRefreshTimer = null;
    }

    switch (page) {
      case 'dashboard':
      case 'modelLibrary': await this.loadModelLibrary(); break;
      case 'myUpstream':
      case 'myProviders':
      case 'myTeamModels':
        await this.loadMyUpstreamPage();
        break;
      case 'apiKeys':
        await this.loadApiKeys();
        this.loadAuthorizations();
        this._initApiKeysStickyBar();
        break;
      case 'stats':
        await this.loadStats();
        await this.loadLiveActivity();
        await this.loadTaskGroups();
        if (this._liveActivityTimer) clearInterval(this._liveActivityTimer);
        this._liveActivityTimer = setInterval(() => {
          this.loadLiveActivity();
        }, 30000);
        break;
      case 'projectWork':
        await this.loadProjectWorkStats();
        if (this._statsRefreshTimer) clearInterval(this._statsRefreshTimer);
        this._statsRefreshTimer = setInterval(() => {
          this.loadProjectWorkStats();
        }, 30000);
        break;
      case 'leaderboard': await this.loadLeaderboard(); break;
      case 'docs': await this.loadDocsModels(); break;
      case 'balance': await this.loadBalance(); break;
      case 'settings': this.loadSettings(); break;
      case 'auditLogs': await this.loadAuditLogs(1); break;
      case 'prompts': await Promise.all([this.loadInjectPrompts(), this.loadCustomPrompts(1)]); break;
      case 'sessions': await this.loadSessions(this._sessionsPage || 1); break;
    }
  }

  formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
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

  getKeyStatus(key) {
    if (key.expires_at) {
      const expireDate = new Date(key.expires_at);
      const now = new Date();
      if (expireDate < now) return { class: 'expired', text: t('已过期') };
      const daysLeft = Math.ceil((expireDate - now) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 7) return { class: 'expiring', text: `${daysLeft}${t('天后过期')}` };
    }
    return { class: 'active', text: t('有效') };
  }

  getSFIcon(name, size) {
    const color = (window.themeManager?.resolvedTheme || 'dark') === 'dark' ? 'white' : 'black';
    return `<img src="https://img.bloret.net/SF/${name}?color=${color}" alt="" width="${size || 18}" height="${size || 18}" class="sf-icon" data-sf-name="${name}" style="display:inline-block;vertical-align:middle;">`;
  }

  async loadApiKeys() {
    const container = document.getElementById('apiKeysList');
    if (container && !(this._lastApiKeys || []).length) {
      setHTML(container, pageLoadingHtml(t('加载 API 密钥...')));
    }
    await this.loadKeyTags();
    try {
      const res = await fetch('/api/user/api-keys');
      if (!res.ok) return;
      const apiKeys = await res.json();
      if (!Array.isArray(apiKeys)) return;
      this._lastApiKeys = apiKeys;

      // 计费和用量归发起者；成员仅能查看共享 Key，不能将其消费计入个人概览。
      let totalReqs = 0, totalTokens = 0, totalCost = 0;
      apiKeys.filter(k => k.is_owner !== false).forEach(k => {
        totalReqs += parseInt(k.total_requests) || 0;
        totalTokens += parseInt(k.total_tokens) || 0;
        totalCost += parseFloat(k.total_cost) || 0;
      });

      const overview = document.getElementById('usageOverview');
      if (apiKeys.length > 0) {
        overview.style.display = 'flex';
        document.getElementById('totalRequests').textContent = totalReqs.toLocaleString();
        document.getElementById('totalTokens').textContent = this._formatBigNumber(totalTokens);
        document.getElementById('totalCost').textContent = `${totalCost.toFixed(4)}${t('积分')}`;
      } else {
        overview.style.display = 'none';
      }

      if (apiKeys.length === 0) {
        setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:40px;">' + t('暂无 API 密钥，点击上方按钮一键创建') + '</p>');
        return;
      }

      const normalKeys = apiKeys.filter(key => key.key_type === 'normal');
      const coKeys = apiKeys.filter(key => key.key_type === 'co_key');
      const renderGroup = (title, hint, keys, groupClass) => !keys.length ? '' : `
        <section class="api-key-group ${groupClass}">
          <div class="api-key-group-header">
            <div>
              <h3 class="api-key-group-title">${title}</h3>
              <p class="api-key-group-hint">${hint}</p>
            </div>
            <span class="api-key-group-count">${keys.length}</span>
          </div>
          <div class="api-keys-list">${keys.map(key => this._renderApiKeyCard(key)).join('')}</div>
        </section>`;
      setHTML(container, `<div class="api-key-groups">
        ${renderGroup(t('普通 API Key'), t('仅自己管理的密钥'), normalKeys, 'api-key-group-normal')}
        ${renderGroup('Co-Key', t('已共享给成员，或由其他用户共享给您'), coKeys, 'api-key-group-cokey')}
      </div>`);
      // 等布局完成后再计算标签溢出
      requestAnimationFrame(() => this._fitAllApiKeyTags());
      this._bindApiKeyTagsResizeObserver();
    } catch (error) {
      console.error(t('加载API密钥失败:'), error);
      if (container) setHTML(container, '<p style="text-align:center;color:var(--destructive);padding:40px;">' + t('加载失败，请刷新重试') + '</p>');
    }
  }

  // ===== OAuth 授权管理（自有 OAuth 服务，与 Passport 无关） =====

  async loadAuthorizations() {
    const container = document.getElementById('oauthAuthorizationsList');
    if (!container) return;
    try {
      const res = await fetch('/oauth/authorizations');
      if (res.status === 401) return;
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data?.authorizations) ? data.authorizations : [];
      this._lastAuthorizations = list;
      if (list.length === 0) {
        setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:24px;">' + t('暂无活跃授权') + '</p>');
        return;
      }
      setHTML(container, `<div class="api-key-groups">${list.map(a => this._renderAuthorizationCard(a)).join('')}</div>`);
    } catch (error) {
      console.error(t('加载授权列表失败:'), error);
    }
  }

  async revokeAuthorization(id) {
    if (!await confirm(t('确定吊销该客户端的全部授权？其所有令牌将立即失效。'))) return;
    try {
      const res = await fetch('/oauth/authorizations/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        this.showToast(data.error || t('吊销失败'), 'error');
        return;
      }
      this.showToast(t('授权已吊销'), 'success');
      await this.loadAuthorizations();
    } catch (error) {
      console.error(t('吊销失败:'), error);
      this.showToast(t('吊销失败'), 'error');
    }
  }

  _formatOAuthTime(v, emptyText) {
    if (!v) return emptyText;
    const d = new Date(v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }

  _renderAuthorizationCard(a) {
    const statusChip = a.expired
      ? this._renderApiKeyChip(t('已过期'), 'danger')
      : this._renderApiKeyChip(t('有效'), 'ok');
    const scopeChips = String(a.scope || '').split(/\s+/).filter(Boolean)
      .map(s => this._renderApiKeyChip(s, 'info')).join('');
    return `
      <section class="api-key-group api-key-group-normal">
        <div class="api-key-group-header">
          <div>
            <h3 class="api-key-group-title">${escapeHtml(a.client_name || a.client_id)}</h3>
            <p class="api-key-group-hint"><code>${escapeHtml(a.client_id)}</code></p>
          </div>
          <button class="btn btn-danger btn-sm" onclick="app.revokeAuthorization(${Number(a.id)})">${t('吊销')}</button>
        </div>
        <div style="padding:12px 16px;">
          ${statusChip} ${scopeChips}
          <div style="margin-top:10px;font-size:12px;color:var(--muted-foreground);line-height:1.9;">
            <div>${t('绑定密钥')}：${escapeHtml(a.api_key_name || (a.api_key_id ? '#' + a.api_key_id : t('未知')))}</div>
            <div>${t('最后使用')}：${escapeHtml(this._formatOAuthTime(a.last_used_at, t('从未使用')))}</div>
            <div>${t('过期时间')}：${escapeHtml(this._formatOAuthTime(a.expires_at))}</div>
          </div>
        </div>
      </section>`;
  }

  // ===== API Key 卡片渲染（清晰简明） =====

  _formatKeyScheduleSummary(key) {
    if (!key?.schedule_enabled) return '';
    const dayNames = [t('日'), t('一'), t('二'), t('三'), t('四'), t('五'), t('六')];
    const days = key.schedule_days;
    let dayLabel = t('每天');
    if (days && days.length && days.length < 7) {
      const sorted = [...days].sort((a, b) => a - b);
      if (sorted.length === 5 && sorted.join(',') === '1,2,3,4,5') dayLabel = t('工作日');
      else if (sorted.length === 2 && sorted.join(',') === '0,6') dayLabel = t('周末');
      else dayLabel = sorted.map(d => dayNames[d]).join('');
    }
    const on = key.schedule_on_time ? String(key.schedule_on_time).substring(0, 5) : '?';
    const off = key.schedule_off_time ? String(key.schedule_off_time).substring(0, 5) : '?';
    return `${on}–${off} · ${dayLabel}`;
  }

  _renderApiKeyChip(text, kind = 'muted') {
    return `<span class="api-key-chip api-key-chip-${kind}">${escapeHtml(text)}</span>`;
  }

  _renderApiKeyCard(key) {
    const status = this.getKeyStatus(key);
    const reqs = parseInt(key.total_requests) || 0;
    const tokens = parseInt(key.total_tokens) || 0;
    const cost = parseFloat(key.total_cost) || 0;
    const tokenDisplay = tokens >= 1000000
      ? (tokens / 1000000).toFixed(1) + 'M'
      : tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : String(tokens);
    const fullKey = key.key_value || '';
    const maskedKey = fullKey
      ? (fullKey.length > 16 ? fullKey.slice(0, 10) + ' ··· ' + fullKey.slice(-4) : fullKey.slice(0, 12) + '····')
      : '—';
    const modelDisplay = key.current_model_name || '';
    const queue = Array.isArray(key.model_queue) ? key.model_queue : [];
    const queueLen = queue.length;
    const isEnabled = key.enabled !== false;
    const hasSchedule = !!key.schedule_enabled;
    const scheduleText = this._formatKeyScheduleSummary(key);

    const sigExplicit = key.signature_enabled !== null && key.signature_enabled !== undefined;
    const sigOn = sigExplicit
      ? !!key.signature_enabled
      : (this.user?.api_signature_enabled === true);
    const sigLabel = sigExplicit ? (sigOn ? t('签名开') : t('签名关')) : t('签名继承');
    const sigKind = sigExplicit ? (sigOn ? 'ok' : 'off') : 'muted';
    const swallowOn = key.swallow_images === true;
    const quotaWarningOn = key.quota_warning_enabled !== false;
    const crewrouterOn = key.crewrouter_commands !== false;

    const chips = [
      this._renderApiKeyChip(status.text, status.class === 'active' ? 'ok' : status.class === 'expiring' ? 'warn' : status.class === 'expired' ? 'danger' : 'muted'),
      key.key_type === 'co_key' ? this._renderApiKeyChip('Co-Key', 'info') : '',
      !isEnabled ? this._renderApiKeyChip(t('已禁用'), 'danger') : '',
      this._renderApiKeyChip(sigLabel, sigKind),
      swallowOn ? this._renderApiKeyChip(t('吞图'), 'warn') : '',
      quotaWarningOn ? this._renderApiKeyChip(t('额度预警'), 'warn') : '',
      crewrouterOn ? this._renderApiKeyChip('@CrewRouter', 'ok') : '',
      hasSchedule ? this._renderApiKeyChip(t('定时'), 'info') : ''
    ].filter(Boolean).join('');

    const safeName = this._jsString(key.name || 'API Key');
    const displayName = key.name || 'API Key';
    const isOwner = key.is_owner !== false;
    const ownerName = key.owner?.username || '';
    const memberCount = Array.isArray(key.members) ? key.members.length : 0;
    const coKeyMeta = key.is_co_key
      ? `${'<span class="api-key-dot">·</span><span class="api-key-sub-muted">' + t('由')}${escapeHtml(ownerName)}${t('发起')}</span>`
      : (memberCount ? `<span class="api-key-dot">·</span><span class="api-key-sub-muted">Co-Key · ${memberCount}${t('位成员')}</span>` : '');
    const moreItems = [
      { label: t('客户端配置'), onClick: `app.generateClaudeConfig(${key.id})` },
      { label: t('额度脚本'), onClick: `app.generateUsageScript(${key.id})` },
      { label: t('Fusion 配置'), onClick: `app.showKeyFusionConfig(${key.id})` },
      { label: t('选项'), onClick: `app.showKeyOptions(${key.id})` },
      { label: t('签名设置'), onClick: `app.showKeySignature(${key.id})` },
      { label: t('用量详情'), onClick: `app.showKeyUsage(${key.id}, '${safeName}')` },
      ...(isOwner ? [
        { label: t('成员管理'), onClick: `app.showKeyMembers(${key.id})` },
        ...(/^crewrouter$/i.test(String(key.name || '')) ? [] : [
          { type: 'divider' },
          { label: t('删除密钥'), className: 'danger', onClick: `app.deleteApiKey(${key.id})` }
        ])
      ] : (key.is_co_key ? [
        { type: 'divider' },
        { label: t('退出 Co-Key'), className: 'danger', onClick: `app.leaveCoKey(${key.id})` }
      ] : []))
    ];

    return `
      <div class="api-key-card ${isEnabled ? '' : 'key-disabled'}" data-key-id="${key.id}"
           ondragover="app.handleApiKeyDragOver(event);app.handleApiKeySortOver(event)" ondragleave="app.handleApiKeyDragLeave(event);app.handleApiKeySortLeave(event)" ondrop="app.handleApiKeyDrop(event, ${key.id});app.handleApiKeySortDrop(event, ${key.id})">
        <div class="api-key-header">
          <div class="api-key-title">
            <span class="api-key-drag-handle" draggable="true" title="${t('拖拽调整顺序')}" aria-hidden="true"
              ondragstart="app.handleApiKeySortStart(event, this)" ondragend="app.handleApiKeySortEnd(event)">⠿</span>
            ${/^crewrouter$/i.test(String(key.name || '')) ? '' : `
            <label class="pg-toggle api-key-enable-toggle" title="${isEnabled ? t('点击禁用') : t('点击启用')}">
              <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="event.stopPropagation(); app.toggleKeyEnabled(${key.id}, this.checked)">
              <span class="pg-toggle-slider"></span>
            </label>`}
            <div class="api-key-title-text">
              <div class="api-key-name-row">
                <span class="api-key-name" data-key-id="${key.id}">${escapeHtml(displayName)}</span>
                ${/^crewrouter$/i.test(String(key.name || '')) ? '<span class="key-system-badge" title="' + t('系统依赖密钥，不可删除/改名/启停') + '">' + t('系统') + '</span>' : ''}
                <div class="api-key-chips">${chips}</div>
                <span class="api-key-meta-divider" aria-hidden="true"></span>
                ${this.renderApiKeyTags(key)}
              </div>
              <div class="api-key-subline">
                ${key.last_used_at
                  ? `${'<span>' + t('最近')}${escapeHtml(this.formatRelativeTime(key.last_used_at))}</span>`
                  : '<span class="api-key-sub-muted">' + t('尚未使用') + '</span>'}
                <span class="api-key-dot">·</span>
                <span class="api-key-sub-muted">创建于 ${new Date(key.created_at).toLocaleDateString('zh-CN')}</span>
                ${hasSchedule ? `<span class="api-key-dot">·</span><span class="api-key-sub-muted" title="${t('定时开关')}">${escapeHtml(scheduleText)}</span>` : ''}
                ${coKeyMeta}
                <span class="api-key-dot">·</span>
                <span class="api-key-metrics">
                  <span class="api-key-metric"><b>${reqs.toLocaleString()}</b> 次</span>
                  <span class="api-key-metric"><b>${escapeHtml(tokenDisplay)}</b> Token</span>
                  <span class="api-key-metric"><b>${cost.toFixed(4)}</b> 积分</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="api-key-prefix">
          <code class="api-key-value" data-visible="false" data-fullkey="${escapeHtml(fullKey)}"
                onclick="app.toggleKeyVisibility(this)" title="${t('点击显示/隐藏完整密钥')}">${escapeHtml(maskedKey)}</code>
          <div class="api-key-secret-actions">
            <button type="button" class="copy-btn" onclick="app.toggleKeyVisibility(this.closest('.api-key-prefix').querySelector('.api-key-value'))" title="${t('显示/隐藏')}">
              ${this.getSFIcon('eye', 14)}
            </button>
            <button type="button" class="copy-btn" onclick="app.copyFullKey(this.closest('.api-key-prefix').querySelector('.api-key-value').dataset.fullkey, this)" title="${t('复制密钥')}">
              ${this.getSFIcon('document.on.document', 14)}
              <span>复制</span>
            </button>
          </div>
        </div>

        <div class="api-key-footer">
          ${this._renderApiKeyRoutePill(key, modelDisplay, queueLen)}
          <div class="api-key-actions">
            <button type="button" class="btn btn-sm btn-primary" onclick="app.showKeyModels(${key.id})">模型队列</button>
            ${this._renderApiKeyMoreMenu(key.id, moreItems)}
          </div>
        </div>
      </div>`;
  }

  /**
   * 底部左侧：与「模型队列」按钮同高的空心路由框
   * 队列长度 > 1 时悬停展示完整队列
   */
  _renderApiKeyRoutePill(key, modelDisplay, queueLen) {
    const hasModel = !!modelDisplay;
    const hasQueue = queueLen > 1;
    const label = hasModel ? modelDisplay : t('未绑定模型');
    const hoverAttrs = hasQueue
      ? ` onmouseenter="app.showApiKeyRouteQueueTip(event, ${key.id})" onmouseleave="app.hideApiKeyRouteQueueTip(event)"`
      : '';
    const title = hasQueue
      ? `${t('模型队列共')}${queueLen}${t('个，悬停查看 · 失败时按顺序回退')}`
      : (hasModel ? modelDisplay : t('尚未绑定模型，可点击「模型队列」配置'));

    return `
      <div class="api-key-route-pill-wrap">
        <button type="button"
          class="api-key-route-pill${!hasModel ? ' is-empty' : ''}${hasQueue ? ' has-queue' : ''}"
          title="${escapeHtml(title)}"
          onclick="app.showKeyModels(${key.id})"
          ${hoverAttrs}>
          <span class="api-key-route-pill-label">路由</span>
          <span class="api-key-route-pill-model">${escapeHtml(label)}</span>
          ${hasQueue ? `<span class="api-key-route-pill-count">${queueLen}</span>` : ''}
        </button>
      </div>`;
  }

  showApiKeyRouteQueueTip(event, keyId) {
    if (this._routeQueueTipLeaveTimer) {
      clearTimeout(this._routeQueueTipLeaveTimer);
      this._routeQueueTipLeaveTimer = null;
    }
    const existing = document.getElementById('apiKeyRouteQueueTip');
    if (existing && Number(existing.dataset.keyId) === Number(keyId)) return;

    this.hideApiKeyRouteQueueTip({ force: true });

    const key = this._lastApiKeys?.find(k => Number(k.id) === Number(keyId));
    const queue = Array.isArray(key?.model_queue) ? key.model_queue : [];
    if (queue.length <= 1) return;

    const anchor = event.currentTarget;
    const tip = document.createElement('div');
    tip.id = 'apiKeyRouteQueueTip';
    tip.dataset.keyId = String(keyId);
    tip.className = 'api-key-route-queue-tip';
    tip.innerHTML = `
      <div class="api-key-route-queue-tip-title">模型队列 · 按序回退</div>
      <ol class="api-key-route-queue-tip-list">
        ${queue.map((item, i) => {
          const name = item.name || item.model_id || item.id || t('未知模型');
          const isPrimary = i === 0;
          return `<li class="api-key-route-queue-tip-item${isPrimary ? ' is-primary' : ''}">
            <span class="api-key-route-queue-tip-order">${i + 1}</span>
            <span class="api-key-route-queue-tip-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            ${isPrimary ? '<span class="api-key-route-queue-tip-badge">' + t('首选') + '</span>' : ''}
          </li>`;
        }).join('')}
      </ol>
    `;

    tip.addEventListener('mouseenter', () => {
      if (this._routeQueueTipLeaveTimer) {
        clearTimeout(this._routeQueueTipLeaveTimer);
        this._routeQueueTipLeaveTimer = null;
      }
    });
    tip.addEventListener('mouseleave', () => {
      this._routeQueueTipLeaveTimer = setTimeout(() => this.hideApiKeyRouteQueueTip({ force: true }), 120);
    });

    document.body.appendChild(tip);
    const rect = anchor.getBoundingClientRect();
    const tipW = tip.offsetWidth || 240;
    const tipH = tip.offsetHeight || 120;
    let left = rect.left;
    if (left + tipW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - tipW - 8);
    let top = rect.top - tipH - 8;
    if (top < 8) top = rect.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  hideApiKeyRouteQueueTip(eventOrOpts) {
    const force = eventOrOpts && eventOrOpts.force === true;
    if (!force && eventOrOpts && eventOrOpts.relatedTarget) {
      const tip = document.getElementById('apiKeyRouteQueueTip');
      if (tip && tip.contains(eventOrOpts.relatedTarget)) return;
    }
    if (!force && eventOrOpts && eventOrOpts.type === 'mouseleave') {
      this._routeQueueTipLeaveTimer = setTimeout(() => {
        const tip = document.getElementById('apiKeyRouteQueueTip');
        if (tip && tip.matches(':hover')) return;
        tip?.remove();
      }, 140);
      return;
    }
    if (this._routeQueueTipLeaveTimer) {
      clearTimeout(this._routeQueueTipLeaveTimer);
      this._routeQueueTipLeaveTimer = null;
    }
    document.getElementById('apiKeyRouteQueueTip')?.remove();
  }

  _renderApiKeyMoreMenu(keyId, items) {
    const menuId = `keyMoreMenu-${keyId}`;
    const itemsHtml = (items || []).map(item => {
      if (item.type === 'divider') return '<div class="api-key-more-divider"></div>';
      const cls = item.className === 'danger' ? 'api-key-more-item danger' : 'api-key-more-item';
      return `<button type="button" class="${cls}" onclick="event.stopPropagation();app.closeApiKeyMoreMenus();${item.onClick}">${escapeHtml(item.label)}</button>`;
    }).join('');
    return `
      <div class="api-key-more">
        <button type="button" class="btn btn-sm btn-secondary" onclick="event.stopPropagation();app.toggleApiKeyMoreMenu(${keyId})">更多</button>
        <div id="${menuId}" class="api-key-more-menu" style="display:none;" onclick="event.stopPropagation()">
          ${itemsHtml}
        </div>
      </div>`;
  }

  toggleApiKeyMoreMenu(keyId) {
    const menu = document.getElementById(`keyMoreMenu-${keyId}`);
    if (!menu) return;
    const open = menu.style.display !== 'none';
    this.closeApiKeyMoreMenus();
    if (!open) {
      menu.style.display = 'block';
      // 点击外部关闭
      const closer = (e) => {
        if (!menu.contains(e.target) && !e.target.closest?.('.api-key-more')) {
          menu.style.display = 'none';
          document.removeEventListener('click', closer, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closer, true), 0);
    }
  }

  closeApiKeyMoreMenus() {
    document.querySelectorAll('.api-key-more-menu').forEach(el => { el.style.display = 'none'; });
  }

  // ===== API Key 标签系统 =====

  async loadKeyTags() {
    try {
      const res = await fetch('/api/user/key-tags');
      if (!res.ok) { this._keyTags = []; this.renderKeyTagBar(); return; }
      const tags = await res.json();
      this._keyTags = Array.isArray(tags) ? tags : [];
    } catch (e) {
      console.warn(t('[标签] 加载失败:'), e);
      this._keyTags = [];
    }
    this.renderKeyTagBar();
  }

  _renderKeyTagChipsHtml() {
    return (this._keyTags || []).map(tag => `
      <div class="key-tag-chip"
           style="border-color:${tag.color};"
           draggable="true"
           data-tag-id="${tag.id}"
           ondragstart="app.handleKeyTagDragStart(event, ${tag.id})"
           ondragend="app.handleKeyTagDragEnd(event)"
           title="${t('拖拽到 Key 卡片来分配 · 点击铅笔编辑')}">
        <span style="color:${tag.color};">●</span>
        ${escapeHtml(tag.name)}
        <span class="edit-tag-def" onclick="event.stopPropagation();app.showEditKeyTagPopover(${tag.id}, this)" title="${t('编辑标签')}">✎</span>
        <span class="remove-tag-def" onclick="event.stopPropagation();app.deleteKeyTag(${tag.id})" title="${t('删除此标签')}">&times;</span>
      </div>`
    ).join('') + `<div class="key-tag-chip key-tag-add-btn" onclick="app.showCreateKeyTagPopover(this)" title="${t('创建标签')}">+</div>`;
  }

  renderKeyTagBar() {
    const container = document.getElementById('keyTagBar');
    const chips = document.getElementById('keyTagChips');
    const stickyChips = document.getElementById('apiKeysStickyTags');
    if (!container && !chips && !stickyChips) return;

    // 始终显示标签栏（至少显示 + 按钮）
    if (container) container.style.display = 'flex';
    const html = this._renderKeyTagChipsHtml();
    if (chips) setHTML(chips, html);
    if (stickyChips) setHTML(stickyChips, html);
  }

  handleKeyTagDragStart(event, tagId) {
    this._keyTagDragActive = true;
    try {
      event.dataTransfer.setData('text/tag-id', String(tagId));
      event.dataTransfer.effectAllowed = 'copy';
    } catch (_) { /* ignore */ }
    document.getElementById('apiKeysList')?.classList.add('api-keys-compact-drag');
    // 悬浮顶栏内拖拽时，提高列表接收区可见性
    document.getElementById('apiKeysPage')?.classList.add('is-tag-dragging');
  }

  handleKeyTagDragEnd() {
    this._keyTagDragActive = false;
    document.getElementById('apiKeysList')?.classList.remove('api-keys-compact-drag');
    document.getElementById('apiKeysPage')?.classList.remove('is-tag-dragging');
    document.querySelectorAll('.api-key-drag-over').forEach(el => el.classList.remove('api-key-drag-over'));
  }

  // ===== API 密钥悬浮顶栏 =====

  _initApiKeysStickyBar() {
    const sentinel = document.getElementById('apiKeysStickySentinel');
    if (!sentinel) return;

    if (this._apiKeysStickyObserver) {
      this._apiKeysStickyObserver.disconnect();
      this._apiKeysStickyObserver = null;
    }

    this._apiKeysStickyObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // 仅当哨兵滚过视口顶部（筛选区已离开屏幕上方）才显示
      const show = this._isStickySentinelPastTop(entry) && this.currentPage === 'apiKeys';
      this._syncApiKeysStickyVisibility(show);
    }, { root: null, threshold: [0, 0.01, 1], rootMargin: '0px' });

    this._apiKeysStickyObserver.observe(sentinel);
    this._syncApiKeysStickyVisibility(
      this._isStickySentinelPastTop(sentinel) && this.currentPage === 'apiKeys'
    );
  }

  /** 哨兵是否已完全滚出视口顶部（bottom < 0）；在下方未进入视口时为 false */
  _isStickySentinelPastTop(entryOrEl) {
    const rect = entryOrEl?.boundingClientRect || entryOrEl?.getBoundingClientRect?.();
    return !!(rect && rect.bottom < 0);
  }

  _syncApiKeysStickyVisibility(visible) {
    const bar = document.getElementById('apiKeysStickyBar');
    if (!bar) return;
    const shouldShow = !!visible && this.currentPage === 'apiKeys';
    const wasVisible = bar.classList.contains('is-visible');
    if (shouldShow === wasVisible) return;
    bar.classList.toggle('is-visible', shouldShow);
    bar.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  }

  selectKeyTag(tagId) {
    // 拖拽模式下无需点击选中，保留为 noop
  }

  _openKeyTagPopover(btnEl, { title, name, color, submitLabel, onSubmit }) {
    const pop = document.getElementById('createKeyTagPopover');
    if (!pop) return;
    const titleEl = document.getElementById('keyTagPopoverTitle');
    const submitBtn = document.getElementById('keyTagPopoverSubmit');
    if (titleEl) titleEl.textContent = title || t('创建标签');
    if (submitBtn) {
      submitBtn.textContent = submitLabel || t('创建');
      submitBtn.onclick = onSubmit;
    }
    document.getElementById('createKeyTagName').value = name || '';
    document.querySelectorAll('#createKeyTagColors .color-dot').forEach(d => {
      d.classList.toggle('selected', d.dataset.color === (color || 'var(--info)'));
    });
    if (!document.querySelector('#createKeyTagColors .color-dot.selected')) {
      document.querySelector('#createKeyTagColors .color-dot')?.classList.add('selected');
    }
    const rect = btnEl.getBoundingClientRect();
    pop.style.top = (rect.bottom + 8) + 'px';
    pop.style.left = Math.max(8, rect.left - 80) + 'px';
    pop.style.display = 'block';
    setTimeout(() => document.getElementById('createKeyTagName').focus(), 100);
  }

  showCreateKeyTagPopover(btnEl) {
    this._editingKeyTagId = null;
    this._openKeyTagPopover(btnEl, {
      title: t('创建标签'),
      name: '',
      color: 'var(--info)',
      submitLabel: t('创建'),
      onSubmit: () => app.saveKeyTag()
    });
  }

  showEditKeyTagPopover(tagId, btnEl) {
    const tag = (this._keyTags || []).find(t => Number(t.id) === Number(tagId));
    if (!tag) return;
    this._editingKeyTagId = Number(tagId);
    this._openKeyTagPopover(btnEl, {
      title: t('编辑标签'),
      name: tag.name || '',
      color: tag.color || 'var(--info)',
      submitLabel: t('保存'),
      onSubmit: () => app.saveKeyTag()
    });
  }

  hideCreateKeyTagPopover() {
    this._editingKeyTagId = null;
    const pop = document.getElementById('createKeyTagPopover');
    if (pop) pop.style.display = 'none';
  }

  selectTagColor(el) {
    document.querySelectorAll('#createKeyTagColors .color-dot').forEach(d => d.classList.remove('selected'));
    el.classList.add('selected');
  }

  async saveKeyTag() {
    const name = document.getElementById('createKeyTagName').value.trim();
    if (!name) { this.showToast(t('请输入标签名称'), 'error'); return; }
    const colorEl = document.querySelector('#createKeyTagColors .color-dot.selected');
    const color = colorEl ? colorEl.dataset.color : 'var(--info)';
    const editingId = this._editingKeyTagId;
    try {
      const res = editingId
        ? await fetch('/api/user/key-tags/' + editingId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color })
          })
        : await fetch('/api/user/key-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color })
          });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.error || (editingId ? t('保存失败') : t('创建失败')), 'error');
        return;
      }
      const data = await res.json();
      if (editingId) {
        const idx = this._keyTags.findIndex(t => Number(t.id) === Number(editingId));
        if (idx >= 0) this._keyTags[idx] = { ...this._keyTags[idx], ...data };
        await this.loadApiKeys();
      } else {
        this._keyTags.push(data);
      }
      this.renderKeyTagBar();
      this.hideCreateKeyTagPopover();
      this.showToast(editingId ? t('标签已更新') : t('标签已创建'), 'success');
    } catch (e) {
      this.showToast(editingId ? t('保存标签失败') : t('创建标签失败'), 'error');
    }
  }

  /** @deprecated 使用 saveKeyTag */
  async createKeyTag() {
    return this.saveKeyTag();
  }

  async deleteKeyTag(tagId) {
    if (!await confirm(t('确定删除此标签？将从所有 API Key 上移除。'))) return;
    try {
      const res = await fetch('/api/user/key-tags/' + tagId, { method: 'DELETE' });
      if (!res.ok) { this.showToast(t('删除失败'), 'error'); return; }
      this._keyTags = this._keyTags.filter(t => t.id !== tagId);
      this.renderKeyTagBar();
      await this.loadApiKeys();
      this.showToast(t('标签已删除'), 'success');
    } catch (e) {
      this.showToast(t('删除标签失败'), 'error');
    }
  }

  renderApiKeyTags(key) {
    const tags = key.tags || [];
    const isOwner = key.is_owner !== false;
    return `<div class="api-key-inline-tags" data-key-id="${key.id}">
      <div class="api-key-inline-tags-track">
        ${tags.map(tag => `
          <span class="key-tag-chip-sm" data-tag-id="${tag.id}" style="border-color:${tag.color};color:${tag.color};background:${tag.color}10;">
            ${escapeHtml(tag.name)}
            ${isOwner ? `<span class="remove-tag" onclick="event.stopPropagation();app.removeTagFromKey(${key.id},${tag.id})" title="${t('移除')}">&times;</span>` : ''}
          </span>`).join('')}
      </div>
      <button type="button" class="api-key-tags-more" style="display:none;"
        data-key-id="${key.id}"
        title="${t('查看更多标签')}"
        onmouseenter="app.onApiKeyTagsMoreEnter(event, ${key.id})"
        onmouseleave="app.onApiKeyTagsMoreLeave(event)"
        onclick="event.stopPropagation();app.toggleApiKeyTagsOverflow(${key.id}, this)">…</button>
      ${isOwner ? `<span class="key-tag-chip-sm key-tag-add-tag-btn" onclick="event.stopPropagation();app.showTagAssignDropdown(${key.id}, this)" title="${t('管理标签')}">+</span>` : ''}
    </div>`;
  }

  /** 读取某 API Key 当前已绑定的标签 ID（优先内存数据，DOM 作兜底） */
  _getKeyTagIds(keyId) {
    const fromData = this._lastApiKeys?.find(k => Number(k.id) === Number(keyId));
    if (fromData && Array.isArray(fromData.tags)) {
      return fromData.tags.map(t => Number(t.id)).filter(n => Number.isFinite(n));
    }
    const card = document.querySelector(`.api-key-card[data-key-id="${keyId}"]`);
    if (!card) return [];
    return [...card.querySelectorAll('.key-tag-chip-sm[data-tag-id]')]
      .map(el => parseInt(el.getAttribute('data-tag-id'), 10))
      .filter(n => Number.isFinite(n));
  }

  _bindApiKeyTagsResizeObserver() {
    const list = document.getElementById('apiKeysList');
    if (!list) return;
    if (this._apiKeyTagsResizeObserver) {
      this._apiKeyTagsResizeObserver.disconnect();
    }
    if (typeof ResizeObserver === 'undefined') {
      if (!this._apiKeyTagsResizeBound) {
        this._apiKeyTagsResizeBound = true;
        window.addEventListener('resize', () => this._fitAllApiKeyTags());
      }
      return;
    }
    let timer = null;
    this._apiKeyTagsResizeObserver = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => this._fitAllApiKeyTags(), 50);
    });
    this._apiKeyTagsResizeObserver.observe(list);
  }

  _fitAllApiKeyTags() {
    document.querySelectorAll('.api-key-inline-tags').forEach(wrap => this._fitApiKeyTags(wrap));
  }

  /**
   * 单行显示标签：超出宽度时隐藏多余项，显示 … / +N
   */
  _fitApiKeyTags(wrap) {
    if (!wrap) return;
    const track = wrap.querySelector('.api-key-inline-tags-track');
    const moreBtn = wrap.querySelector('.api-key-tags-more');
    const addBtn = wrap.querySelector('.key-tag-add-tag-btn');
    if (!track || !moreBtn || !addBtn) return;

    const chips = [...track.querySelectorAll('.key-tag-chip-sm[data-tag-id]')];
    chips.forEach(c => { c.hidden = false; c.style.display = ''; });
    moreBtn.style.display = 'none';
    moreBtn.textContent = '…';
    delete moreBtn.dataset.hiddenCount;

    if (!chips.length) return;

    // 先全部显示测量
    const wrapStyle = getComputedStyle(wrap);
    const gap = parseFloat(wrapStyle.columnGap || wrapStyle.gap) || 4;
    const addW = addBtn.offsetWidth;
    const wrapW = wrap.clientWidth;
    if (wrapW <= 0) return;

    // 测量 more 按钮宽度（临时显示）
    moreBtn.style.display = 'inline-flex';
    moreBtn.textContent = `+${chips.length}`;
    const moreW = moreBtn.offsetWidth || 28;
    moreBtn.style.display = 'none';
    moreBtn.textContent = '…';

    // 不需要 more 时的可用宽度
    let avail = wrapW - addW - gap;
    let used = 0;
    let overflowFrom = chips.length;
    for (let i = 0; i < chips.length; i++) {
      const w = chips[i].offsetWidth + (i > 0 ? gap : 0);
      if (used + w <= avail + 0.5) {
        used += w;
      } else {
        overflowFrom = i;
        break;
      }
    }

    if (overflowFrom >= chips.length) {
      // 全部放得下
      chips.forEach(c => { c.hidden = false; });
      moreBtn.style.display = 'none';
      return;
    }

    // 需要 more：预留 more 按钮空间重新计算
    avail = wrapW - addW - moreW - gap * 2;
    used = 0;
    overflowFrom = chips.length;
    for (let i = 0; i < chips.length; i++) {
      const w = chips[i].offsetWidth + (i > 0 ? gap : 0);
      if (used + w <= avail + 0.5) {
        used += w;
      } else {
        overflowFrom = i;
        break;
      }
    }
    // 至少一个 more 可见时，确保至少显示 0 个 tag 也能露出 more
    if (overflowFrom === 0 && chips.length > 0) {
      // 若连 1 个都放不下，仍隐藏全部，只显示 more
      overflowFrom = 0;
    }

    chips.forEach((c, i) => {
      c.hidden = i >= overflowFrom;
      c.style.display = i >= overflowFrom ? 'none' : '';
    });
    const hiddenCount = chips.length - overflowFrom;
    moreBtn.style.display = 'inline-flex';
    moreBtn.textContent = hiddenCount > 0 ? `+${hiddenCount}` : '…';
    moreBtn.dataset.hiddenCount = String(hiddenCount);
    moreBtn.title = `${t('还有')}${hiddenCount}${t('个标签，点击或悬停查看')}`;
  }

  _closeApiKeyTagsOverflow() {
    const el = document.getElementById('apiKeyTagsOverflowPopover');
    if (el) el.remove();
    if (this._apiKeyTagsOverflowCloser) {
      document.removeEventListener('click', this._apiKeyTagsOverflowCloser, true);
      this._apiKeyTagsOverflowCloser = null;
    }
    if (this._apiKeyTagsOverflowLeaveTimer) {
      clearTimeout(this._apiKeyTagsOverflowLeaveTimer);
      this._apiKeyTagsOverflowLeaveTimer = null;
    }
  }

  onApiKeyTagsMoreEnter(event, keyId) {
    if (this._apiKeyTagsOverflowLeaveTimer) {
      clearTimeout(this._apiKeyTagsOverflowLeaveTimer);
      this._apiKeyTagsOverflowLeaveTimer = null;
    }
    this.showApiKeyTagsOverflow(keyId, event.currentTarget, { fromHover: true });
  }

  onApiKeyTagsMoreLeave(event) {
    // 若移入浮层则不关
    const related = event.relatedTarget;
    const pop = document.getElementById('apiKeyTagsOverflowPopover');
    if (pop && related && pop.contains(related)) return;
    this._apiKeyTagsOverflowLeaveTimer = setTimeout(() => {
      const p = document.getElementById('apiKeyTagsOverflowPopover');
      if (p && p.matches(':hover')) return;
      // 仅关闭 hover 打开的（带 data-hover）
      if (p && p.dataset.mode === 'hover') this._closeApiKeyTagsOverflow();
    }, 180);
  }

  toggleApiKeyTagsOverflow(keyId, btnEl) {
    const existing = document.getElementById('apiKeyTagsOverflowPopover');
    if (existing && Number(existing.dataset.keyId) === Number(keyId)) {
      this._closeApiKeyTagsOverflow();
      return;
    }
    this.showApiKeyTagsOverflow(keyId, btnEl, { fromHover: false });
  }

  showApiKeyTagsOverflow(keyId, anchorEl, options = {}) {
    const fromHover = !!options.fromHover;
    const existing = document.getElementById('apiKeyTagsOverflowPopover');
    if (existing && Number(existing.dataset.keyId) === Number(keyId)) {
      // 点击升级为 sticky
      if (!fromHover) existing.dataset.mode = 'click';
      return;
    }
    this._closeApiKeyTagsOverflow();

    const key = this._lastApiKeys?.find(k => Number(k.id) === Number(keyId));
    const tags = key?.tags || [];
    const isOwner = key?.is_owner !== false;
    const pop = document.createElement('div');
    pop.id = 'apiKeyTagsOverflowPopover';
    pop.dataset.keyId = String(keyId);
    pop.dataset.mode = fromHover ? 'hover' : 'click';
    pop.className = 'api-key-tags-overflow-popover';

    const listHtml = tags.length
      ? tags.map(tag => `
          <div class="api-key-tags-overflow-item" data-tag-id="${tag.id}">
            <span class="key-tag-chip-sm" style="border-color:${escapeHtml(tag.color)};color:${escapeHtml(tag.color)};background:${escapeHtml(tag.color)}10;">
              ${escapeHtml(tag.name)}
            </span>
            ${isOwner ? `<button type="button" class="api-key-tags-overflow-remove" title="${t('移除标签')}"
              onclick="event.stopPropagation();app.removeTagFromKey(${keyId},${tag.id})">${t('移除')}</button>` : ''}
          </div>`).join('')
      : '<div class="api-key-tags-overflow-empty">' + t('暂无标签') + '</div>';

    setHTML(pop, `
      <div class="api-key-tags-overflow-title">已绑定标签（${tags.length}）</div>
      <div class="api-key-tags-overflow-list">${listHtml}</div>
      ${isOwner ? '<button type="button" class="btn btn-sm btn-secondary api-key-tags-overflow-manage">' + t('管理全部标签') + '</button>' : ''}
    `);

    pop.querySelector('.api-key-tags-overflow-manage')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeApiKeyTagsOverflow();
      const b = document.querySelector(`.api-key-card[data-key-id="${keyId}"] .key-tag-add-tag-btn`);
      if (b) this.showTagAssignDropdown(keyId, b);
    });

    pop.addEventListener('mouseenter', () => {
      if (this._apiKeyTagsOverflowLeaveTimer) {
        clearTimeout(this._apiKeyTagsOverflowLeaveTimer);
        this._apiKeyTagsOverflowLeaveTimer = null;
      }
    });
    pop.addEventListener('mouseleave', () => {
      if (pop.dataset.mode === 'hover') {
        this._apiKeyTagsOverflowLeaveTimer = setTimeout(() => this._closeApiKeyTagsOverflow(), 120);
      }
    });

    document.body.appendChild(pop);
    const rect = anchorEl.getBoundingClientRect();
    const popW = pop.offsetWidth || 220;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - popW - 8);
    let top = rect.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - pop.offsetHeight - 6);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    this._apiKeyTagsOverflowCloser = (e) => {
      if (pop.contains(e.target) || anchorEl.contains?.(e.target) || e.target === anchorEl) return;
      this._closeApiKeyTagsOverflow();
    };
    setTimeout(() => document.addEventListener('click', this._apiKeyTagsOverflowCloser, true), 0);
  }

  showTagAssignDropdown(keyId, btnEl) {
    // 先关闭已有浮层
    const existing = document.getElementById('tagAssignDropdown');
    if (existing) existing.remove();
    this._closeApiKeyTagsOverflow();

    const key = this._lastApiKeys?.find(k => Number(k.id) === Number(keyId));
    const currentTagIds = new Set((key?.tags || []).map(t => Number(t.id)));

    const dropdown = document.createElement('div');
    dropdown.id = 'tagAssignDropdown';
    dropdown.className = 'api-key-tag-assign-dropdown';

    const rect = btnEl.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = Math.max(8, rect.left) + 'px';

    if (this._keyTags.length === 0) {
      setHTML(dropdown, '<div class="api-key-tag-assign-empty">' + t('暂无标签，请先在上方创建') + '</div>');
    } else {
      setHTML(dropdown, this._keyTags.map(tag => {
        const has = currentTagIds.has(Number(tag.id));
        return `<div class="api-key-tag-assign-item${has ? ' is-on' : ''}"
                     onclick="app.toggleTagInDropdown(${keyId},${tag.id})">
          <span style="color:${escapeHtml(tag.color)};">${has ? '✓' : '○'}</span>
          <span>${escapeHtml(tag.name)}</span>
        </div>`;
      }).join(''));
    }

    document.body.appendChild(dropdown);

    // 点击外部关闭
    const closer = (e) => {
      if (!dropdown.contains(e.target) && e.target !== btnEl) {
        dropdown.remove();
        document.removeEventListener('click', closer);
      }
    };
    setTimeout(() => document.addEventListener('click', closer), 0);
  }

  async toggleTagInDropdown(keyId, tagId) {
    await this.toggleKeyTag(keyId, tagId);
    // loadApiKeys 已刷新；若浮层还在则重开
    const dropdown = document.getElementById('tagAssignDropdown');
    if (dropdown) {
      const btnEl = document.querySelector(`.api-key-card[data-key-id="${keyId}"] .key-tag-add-tag-btn`);
      if (btnEl) {
        dropdown.remove();
        this.showTagAssignDropdown(keyId, btnEl);
      }
    }
  }

  handleApiKeyDragOver(event) {
    if (!event.dataTransfer?.types?.includes('text/tag-id') && !this._keyTagDragActive) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'copy'; } catch (_) { /* ignore */ }
    event.currentTarget.closest('.api-key-card')?.classList.add('api-key-drag-over');
  }

  handleApiKeyDragLeave(event) {
    const card = event.currentTarget.closest('.api-key-card');
    if (!card) return;
    if (card.contains(event.relatedTarget)) return;
    card.classList.remove('api-key-drag-over');
  }

  handleApiKeyDrop(event, keyId) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.closest('.api-key-card')?.classList.remove('api-key-drag-over');
    const tagId = parseInt(event.dataTransfer.getData('text/tag-id'));
    if (!tagId) return;
    this.toggleKeyTag(keyId, tagId);
  }

  // ===== API Key 卡片拖拽排序 =====

  handleApiKeySortStart(event, handleEl) {
    const card = handleEl.closest('.api-key-card');
    if (!card) return;
    // 与标签拖拽（text/tag-id）区分
    try {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/key-sort', card.dataset.keyId);
    } catch (_) { /* ignore */ }
    this._keySortDragId = Number(card.dataset.keyId);
    card.classList.add('api-key-sort-dragging');
  }

  handleApiKeySortEnd() {
    this._keySortDragId = null;
    document.querySelectorAll('.api-key-card.api-key-sort-dragging, .api-key-card.api-key-sort-over-top, .api-key-card.api-key-sort-over-bottom')
      .forEach(el => el.classList.remove('api-key-sort-dragging', 'api-key-sort-over-top', 'api-key-sort-over-bottom'));
  }

  _isApiKeySortDrag(event) {
    return this._keySortDragId != null || (event.dataTransfer?.types || []).includes('text/key-sort');
  }

  handleApiKeySortOver(event) {
    if (!this._isApiKeySortDrag(event)) return;
    const card = event.currentTarget.closest('.api-key-card');
    if (!card || Number(card.dataset.keyId) === this._keySortDragId) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ }
    const rect = card.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    this._keySortDropBefore = before;
    card.classList.toggle('api-key-sort-over-top', before);
    card.classList.toggle('api-key-sort-over-bottom', !before);
  }

  handleApiKeySortLeave(event) {
    if (!this._isApiKeySortDrag(event)) return;
    const card = event.currentTarget.closest('.api-key-card');
    if (!card || card.contains(event.relatedTarget)) return;
    card.classList.remove('api-key-sort-over-top', 'api-key-sort-over-bottom');
  }

  async handleApiKeySortDrop(event, targetKeyId) {
    if (!this._isApiKeySortDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const fromId = this._keySortDragId ?? Number(event.dataTransfer.getData('text/key-sort'));
    this.handleApiKeySortEnd();
    const toId = Number(targetKeyId);
    if (!fromId || !toId || fromId === toId) return;

    const list = document.querySelectorAll('#apiKeysList .api-key-card');
    const idsInOrder = Array.from(list).map(el => Number(el.dataset.keyId)).filter(Boolean);
    const fromIdx = idsInOrder.indexOf(fromId);
    const toIdx = idsInOrder.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    idsInOrder.splice(fromIdx, 1);
    const before = this._keySortDropBefore !== false;
    let insertIdx = idsInOrder.indexOf(toId);
    if (!before) insertIdx += 1;
    idsInOrder.splice(insertIdx, 0, fromId);

    try {
      const res = await fetch('/api/user/api-keys/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: idsInOrder })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('保存失败'));
      this.showToast(t('顺序已保存'), 'success');
    } catch (e) {
      this.showToast(e.message || t('保存顺序失败'), 'error');
    }
    await this.loadApiKeys();
  }

  async toggleKeyTag(keyId, tagId) {
    try {
      const tid = Number(tagId);
      const existingIds = this._getKeyTagIds(keyId);
      const hasTag = existingIds.includes(tid);
      const newTagIds = hasTag ? existingIds.filter(id => id !== tid) : [...existingIds, tid];

      const res = await fetch('/api/user/api-keys/' + keyId + '/tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: newTagIds })
      });
      if (!res.ok) { this.showToast(t('操作失败'), 'error'); return; }
      this.showToast(hasTag ? t('标签已移除') : t('标签已添加'), 'success');
      await this.loadApiKeys();
    } catch (e) {
      this.showToast(t('操作失败'), 'error');
    }
  }

  async removeTagFromKey(keyId, tagId) {
    if (!await confirm(t('确定移除此标签？'))) return;
    try {
      const tid = Number(tagId);
      const newTagIds = this._getKeyTagIds(keyId).filter(id => id !== tid);
      const res = await fetch('/api/user/api-keys/' + keyId + '/tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: newTagIds })
      });
      if (!res.ok) { this.showToast(t('移除标签失败'), 'error'); return; }
      this.showToast(t('标签已移除'), 'success');
      await this.loadApiKeys();
    } catch (e) {
      this.showToast(t('移除标签失败'), 'error');
    }
  }

  copyKeyPrefix(prefix, btnEl) {
    if (!prefix) return;
    const doCopy = async () => {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(prefix);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = prefix;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    };
    doCopy().then(ok => {
      if (ok) {
        const btn = btnEl || event?.target?.closest('.copy-btn');
        if (btn) {
          btn.classList.add('copied');
          setHTML(btn, `${this.getSFIcon('checkmark', 14)}${t('已复制')}`);
          setTimeout(() => {
            btn.classList.remove('copied');
            setHTML(btn, `${this.getSFIcon('document.on.document', 14)}${t('复制')}`);
          }, 2000);
        }
        this.showToast(t('已复制到剪贴板'), 'success');
      }
    }).catch(() => {
      this.showToast(t('复制失败，请手动复制'), 'error');
    });
  }

  _maskApiKey(fullKey) {
    if (!fullKey) return '—';
    if (fullKey.length > 16) return fullKey.slice(0, 10) + ' ··· ' + fullKey.slice(-4);
    return fullKey.slice(0, 12) + '····';
  }

  toggleKeyVisibility(el) {
    if (!el) return;
    const isVisible = el.dataset.visible === 'true';
    if (isVisible) {
      el.textContent = this._maskApiKey(el.dataset.fullkey || '');
      el.dataset.visible = 'false';
    } else {
      el.dataset.visible = 'true';
      el.textContent = el.dataset.fullkey || el.textContent;
    }
    // 更新同区域的眼睛按钮图标状态
    const prefix = el.closest('.api-key-prefix');
    if (prefix) {
      const eyeBtn = prefix.querySelector('.copy-btn[title="显示/隐藏"], .copy-btn[data-i18n-title="显示/隐藏"]');
      if (eyeBtn) {
        const iconName = el.dataset.visible === 'true' ? 'eye.slash' : 'eye';
        setHTML(eyeBtn, this.getSFIcon(iconName, 14));
      }
    }
  }

  copyFullKey(key, btnEl) {
    if (!key) return;
    const doCopy = async () => {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(key);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = key;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    };
    doCopy().then(ok => {
      if (ok) {
        const btn = btnEl || event?.target?.closest('.copy-btn');
        if (btn) {
          const origChildren = [...btn.childNodes].map(node => node.cloneNode(true));
          setHTML(btn, raw(`${this.getSFIcon('checkmark', 14)}${t('已复制')}`));
          setTimeout(() => {
            clearChildren(btn);
            origChildren.forEach(node => btn.appendChild(node.cloneNode(true)));
          }, 2000);
        }
        this.showToast(t('已复制到剪贴板'), 'success');
      }
    }).catch(() => {
      this.showToast(t('复制失败，请手动复制'), 'error');
    });
  }

  async showKeyModels(keyId) {
    const container = document.getElementById('keyModelsContent');
    this._configureKeyModelsModal({
      title: t('模型队列（失败按顺序回退）'),
      picker: true,
      saveVisible: true,
      saveText: t('保存队列'),
      cancelText: t('关闭')
    });
    this._editingKeyModelsId = keyId;
    this._saveKeyModelsOverride = null;
    this._keyModelPicker = null;
    setHTML(container, pageLoadingHtml(t('加载中...')));
    this.showModal('keyModelsModal');

    try {
      const [libraryRes, assignedRes, tagsRes] = await Promise.all([
        fetch('/api/user/model-library'),
        fetch(`/api/user/api-keys/${keyId}/models`),
        fetch('/api/user/provider-tags').catch(() => null)
      ]);
      if (!libraryRes.ok || !assignedRes.ok) {
        setHTML(container, '<p style="color:var(--destructive);text-align:center;padding:32px;">' + t('加载失败') + '</p>');
        return;
      }

      const libraryData = await libraryRes.json();
      const assignedPayload = await assignedRes.json();
      const assignedModels = this._normalizeKeyModelsPayload(assignedPayload);
      const queue = this._normalizeKeyModelQueue(assignedPayload);
      const selectedModel = queue[0] || assignedModels.find(m => m.assigned);
      const tags = tagsRes && tagsRes.ok ? await tagsRes.json().catch(() => []) : [];

      this._keyModelPicker = {
        keyId,
        data: libraryData,
        queue: queue.map(m => ({
          id: String(m.model_id || m.id),
          name: m.name || m.model_id || m.id
        })),
        currentModel: selectedModel
          ? { id: selectedModel.id || selectedModel.model_id, name: selectedModel.name || selectedModel.id || selectedModel.model_id }
          : null,
        assignedModelIds: new Set(queue.map(m => String(m.model_id || m.id))),
        providerTags: Array.isArray(tags) ? tags : [],
        search: '',
        providerFilter: 'all',
        seriesFilter: 'all',
        testFilter: 'all',
        providerTagFilter: 'all',
        sort: 'default',
        loadingProviders: new Set(),
        loadingPromises: new Map(),
        searchRafPending: false
      };

      this._renderKeyModelPickerShell();
      this._populateKeyModelPickerFilters();
      this.filterAndRenderKeyModelPicker();
    } catch (error) {
      console.error(t('加载密钥模型列表失败:'), error);
      setHTML(container, '<p style="color:var(--destructive);text-align:center;padding:32px;">' + t('加载失败') + '</p>');
    }
  }

  async saveKeyModels() {
    // Fusion 配置有独立的保存逻辑
    if (this._saveKeyModelsOverride) {
      await this._saveKeyModelsOverride();
      return;
    }

    const keyId = this._editingKeyModelsId;
    if (!keyId) return;

    // 有序模型队列
    if (this._keyModelPicker?.keyId) {
      const modelIds = (this._keyModelPicker.queue || []).map(m => m.id);
      try {
        const res = await fetch(`/api/user/api-keys/${keyId}/models`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelIds })
        });
        if (res.ok) {
          this.closeModals();
          await this.loadApiKeys();
          this.showToast(modelIds.length ? `${t('已保存模型队列（')}${modelIds.length}${t('个）')}` : t('已清空模型绑定'), 'success');
        } else {
          const err = await res.json().catch(() => ({}));
          this.showToast(err.error || t('保存失败'), 'error');
        }
      } catch (error) {
        console.error(t('保存密钥模型队列失败:'), error);
        this.showToast(t('保存失败'), 'error');
      }
      return;
    }

    const selected = document.querySelector('input[name="keyModelRadio"]:checked');
    const modelId = selected ? selected.value : null;

    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId })
      });
      if (res.ok) {
        this.closeModals();
        this.loadApiKeys();
      } else {
        alert(t('保存失败'));
      }
    } catch (error) {
      console.error(t('保存密钥模型失败:'), error);
      alert(t('保存失败'));
    }
  }

  _normalizeKeyModelsPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (!Array.isArray(payload?.models)) return [];
    return payload.models.map(item => {
      if (item && typeof item === 'object') return item;
      return { id: item, model_id: item, name: item, assigned: true };
    });
  }

  _normalizeKeyModelQueue(payload) {
    const pickName = (item, id) => {
      const n = item?.name || item?.alias || item?.upstream_model_id || '';
      if (n && String(n).trim() && String(n) !== String(id)) return String(n).trim();
      return String(id);
    };
    if (Array.isArray(payload?.queue) && payload.queue.length) {
      return payload.queue.map((item, idx) => {
        const id = item.model_id || item.id;
        return {
          model_id: id,
          id,
          name: pickName(item, id),
          sort_order: item.sort_order != null ? item.sort_order : idx
        };
      });
    }
    // 兼容旧数组响应：用 assigned 项作为队列
    const models = this._normalizeKeyModelsPayload(payload);
    const assigned = models.filter(m => m.assigned);
    assigned.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    return assigned.map((m, idx) => {
      const id = m.model_id || m.id;
      return {
        model_id: id,
        id,
        name: pickName(m, id),
        sort_order: m.sort_order != null ? m.sort_order : idx
      };
    });
  }

  _configureKeyModelsModal({ title, picker = false, saveVisible = true, saveText = t('保存'), cancelText = t('取消') }) {
    const modalContent = document.getElementById('keyModelsModalContent');
    const titleEl = document.getElementById('keyModelsTitle');
    const saveBtn = document.getElementById('keyModelsSaveBtn');
    if (modalContent) {
      modalContent.classList.toggle('key-model-picker-modal', picker);
      modalContent.classList.toggle('model-picker-modal', picker);
    }
    if (titleEl) titleEl.textContent = title || t('管理可用模型');
    if (saveBtn) {
      saveBtn.style.display = saveVisible ? '' : 'none';
      saveBtn.textContent = saveText;
    }
  }

  /** 用于双引号 HTML 属性内的单引号 JS 字符串，防 " 截断属性导致 SyntaxError */
  _jsString(value) {
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

  _renderKeyModelPickerShell() {
    const container = document.getElementById('keyModelsContent');
    if (!container) return;
    setHTML(container, `
      <div class="model-picker key-model-picker">
        <div class="key-model-queue-panel">
          <div class="key-model-queue-header">
            <strong>请求队列</strong>
            <span class="key-model-queue-hint">拖拽排序 · 从上到下依次尝试，失败自动回退（最多 10 个）</span>
          </div>
          <div id="keyModelQueueList" class="key-model-queue-list"></div>
        </div>
        <div class="model-filter-bar">
          <div class="model-search-box">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input type="text" id="keyModelPickerSearch" placeholder="${t('搜索模型、供应商、Team...')}" class="model-search-input">
          </div>
          <div class="model-filter-selects">
            <select id="keyModelPickerProvider" class="select"><option value="all">全部供应商</option></select>
            <select id="keyModelPickerSeries" class="select"><option value="all">全部系列</option></select>
            <select id="keyModelPickerProviderTag" class="select"><option value="all">全部标签</option></select>
            <select id="keyModelPickerTest" class="select">
              <option value="all">全部状态</option>
              <option value="pass">测试通过</option>
              <option value="fail">测试失败</option>
              <option value="untested">未测试</option>
            </select>
            <select id="keyModelPickerSort" class="select">
              <option value="default">默认排序</option>
              <option value="price_asc">价格低→高</option>
              <option value="price_desc">价格高→低</option>
              <option value="name_asc">名称 A-Z</option>
              <option value="name_desc">名称 Z-A</option>
              <option value="test_latency_asc">测试最快</option>
              <option value="test_latency_desc">测试最慢</option>
              <option value="test_tps_desc">吞吐最高</option>
            </select>
          </div>
        </div>
        <div id="keyModelPickerCount" class="model-picker-count key-model-picker-count" style="display:none;"></div>
        <div id="keyModelPickerContent" class="model-library-grid model-picker-scroll key-model-picker-grid"></div>
      </div>
    `);
    this._renderKeyModelQueueList();
    this._ensureKeyModelQueueDragBound();

    document.getElementById('keyModelPickerSearch')?.addEventListener('input', (e) => {
      if (!this._keyModelPicker) return;
      this._keyModelPicker.search = e.target.value;
      if (this._keyModelPicker.searchTimer) clearTimeout(this._keyModelPicker.searchTimer);
      this._keyModelPicker.searchTimer = setTimeout(() => this.filterAndRenderKeyModelPicker(), 280);
    });
    document.getElementById('keyModelPickerProvider')?.addEventListener('change', (e) => {
      if (!this._keyModelPicker) return;
      this._keyModelPicker.providerFilter = e.target.value;
      this.filterAndRenderKeyModelPicker();
    });
    document.getElementById('keyModelPickerSeries')?.addEventListener('change', (e) => {
      if (!this._keyModelPicker) return;
      this._keyModelPicker.seriesFilter = e.target.value;
      this.filterAndRenderKeyModelPicker();
    });
    document.getElementById('keyModelPickerProviderTag')?.addEventListener('change', (e) => {
      if (!this._keyModelPicker) return;
      this._keyModelPicker.providerTagFilter = e.target.value;
      this.filterAndRenderKeyModelPicker();
    });
    document.getElementById('keyModelPickerTest')?.addEventListener('change', (e) => {
      if (!this._keyModelPicker) return;
      this._keyModelPicker.testFilter = e.target.value;
      this.filterAndRenderKeyModelPicker();
    });
    document.getElementById('keyModelPickerSort')?.addEventListener('change', (e) => {
      if (!this._keyModelPicker) return;
      this._keyModelPicker.sort = e.target.value;
      this.filterAndRenderKeyModelPicker();
    });
  }

  _populateKeyModelPickerFilters() {
    const ctx = this._keyModelPicker;
    if (!ctx?.data?.teams) return;
    const providers = new Set();
    for (const team of ctx.data.teams || []) {
      for (const provider of team.providers || []) providers.add(provider.provider_name);
    }
    const providerSelect = document.getElementById('keyModelPickerProvider');
    if (providerSelect) {
      setHTML(providerSelect, '<option value="all">' + t('全部供应商') + '</option>' +
        [...providers].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join(''));
      providerSelect.value = providers.has(ctx.providerFilter) ? ctx.providerFilter : 'all';
      ctx.providerFilter = providerSelect.value;
    }

    const tagSelect = document.getElementById('keyModelPickerProviderTag');
    if (tagSelect) {
      const tags = ctx.providerTags || [];
      setHTML(tagSelect, '<option value="all">' + t('全部标签') + '</option>' +
        tags.map(t => `<option value="tag:${t.id}">${escapeHtml(t.name)}</option>`).join(''));
      const values = ['all', ...tags.map(t => `tag:${t.id}`)];
      tagSelect.value = values.includes(ctx.providerTagFilter) ? ctx.providerTagFilter : 'all';
      ctx.providerTagFilter = tagSelect.value;
    }

    this._rebuildKeyModelPickerSeriesFilter();
  }

  _rebuildKeyModelPickerSeriesFilter() {
    const ctx = this._keyModelPicker;
    const series = new Set();
    if (ctx?.data) {
      for (const team of ctx.data.teams || []) {
        for (const provider of team.providers || []) {
          if (!provider.models_loaded) continue;
          for (const model of provider.models || []) {
            if (model.series) series.add(model.series);
          }
        }
      }
    }
    const select = document.getElementById('keyModelPickerSeries');
    if (!select) return;
    const prev = ctx?.seriesFilter || 'all';
    setHTML(select, '<option value="all">' + t('全部系列') + '</option>' +
      [...series].sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
    select.value = prev === 'all' || series.has(prev) ? prev : 'all';
    if (ctx) ctx.seriesFilter = select.value;
  }

  _shouldUseKeyPickerGlobalSearch(ctx) {
    return !!(ctx.search || '').trim() ||
      (ctx.seriesFilter && ctx.seriesFilter !== 'all') ||
      (ctx.testFilter && ctx.testFilter !== 'all');
  }

  async filterAndRenderKeyModelPicker() {
    const ctx = this._keyModelPicker;
    if (!ctx?.data) return;
    const search = (ctx.search || '').toLowerCase();
    const providerFilter = ctx.providerFilter;
    const seriesFilter = ctx.seriesFilter;
    const testFilter = ctx.testFilter;
    const tagFilter = ctx.providerTagFilter;
    const sort = ctx.sort;

    // 搜索/系列/测试状态：服务端全局搜索（与模型库同接口）
    if (this._shouldUseKeyPickerGlobalSearch(ctx)) {
      await this._runKeyPickerGlobalSearch(ctx);
      return;
    }

    if (providerFilter !== 'all') this._ensureKeyPickerProviderModelsLoadedByName(providerFilter);

    const filtered = {
      ...ctx.data,
      teams: (ctx.data.teams || []).map(team => ({
        ...team,
        providers: (team.providers || [])
          .filter(provider => {
            if (providerFilter !== 'all' && provider.provider_name !== providerFilter) return false;
            if (tagFilter !== 'all' && tagFilter.startsWith('tag:')) {
              const filterTagId = parseInt(tagFilter.replace('tag:', ''), 10);
              if (!(provider.tags || []).some(t => t.id === filterTagId)) return false;
            }
            return true;
          })
          .map(provider => ({
            ...provider,
            models: provider.models_loaded ? (provider.models || []) : []
          }))
      })).filter(team => team.providers && team.providers.length > 0)
    };

    if (sort !== 'default') {
      filtered.teams.forEach(team => {
        this._sortKeyPickerProviders(team.providers, sort);
        team.providers.forEach(provider => this._sortKeyPickerModels(provider.models, sort));
      });
    }

    const countEl = document.getElementById('keyModelPickerCount');
    if (countEl) {
      const hasFilter = providerFilter !== 'all' || tagFilter !== 'all';
      countEl.style.display = hasFilter ? 'block' : 'none';
      if (hasFilter) {
        let totalModels = 0;
        filtered.teams.forEach(team => team.providers.forEach(provider => {
          totalModels += provider.model_count ?? provider.models?.length ?? 0;
        }));
        countEl.textContent = `${t('共')}${totalModels}${t('个模型（骨架统计）')}`;
      }
    }

    const expandedState = this._captureKeyPickerExpandedState();
    this._renderKeyModelPickerLibrary(filtered);
    this._restoreKeyPickerExpandedState(expandedState);
  }

  async _runKeyPickerGlobalSearch(ctx) {
    const seq = (ctx.globalSearchSeq = (ctx.globalSearchSeq || 0) + 1);
    const container = document.getElementById('keyModelPickerContent');
    const countEl = document.getElementById('keyModelPickerCount');
    if (container) {
      setHTML(container, '<div class="empty-state" style="padding:32px 16px;text-align:center;"><p style="color:var(--muted-foreground);margin:0;">' + t('搜索中...') + '</p></div>');
    }
    try {
      const params = new URLSearchParams();
      params.set('page', '1');
      params.set('limit', '40');
      const q = (ctx.search || '').trim();
      if (q) params.set('q', q);
      if (ctx.providerFilter && ctx.providerFilter !== 'all') params.set('provider', ctx.providerFilter);
      if (ctx.seriesFilter && ctx.seriesFilter !== 'all') params.set('series', ctx.seriesFilter);
      if (ctx.testFilter && ctx.testFilter !== 'all') params.set('test', ctx.testFilter);
      if (ctx.providerTagFilter && ctx.providerTagFilter !== 'all') params.set('tag', ctx.providerTagFilter);
      if (ctx.sort && ctx.sort !== 'default') params.set('sort', ctx.sort);

      const res = await fetch(`/api/user/model-library/search?${params.toString()}`);
      if (!res.ok) throw new Error(t('搜索失败'));
      const data = await res.json();
      if (seq !== ctx.globalSearchSeq || this._keyModelPicker !== ctx) return;
      if (!this._shouldUseKeyPickerGlobalSearch(ctx)) return;

      const models = data.models || [];
      // 缓存搜索结果，供加入队列时解析展示名
      ctx._globalSearchModels = models;
      if (countEl) {
        countEl.style.display = 'block';
        countEl.textContent = `${t('找到')}${data.pagination?.total ?? models.length}${t('个模型')}`;
      }
      if (!models.length) {
        if (container) {
          setHTML(container, '<div class="empty-state" style="padding:32px 16px;text-align:center;"><p style="color:var(--muted-foreground);margin:0;">' + t('没有符合条件的模型') + '</p></div>');
        }
        return;
      }

      // 扁平结果：按 team 分组后直接列模型（不走供应商展开）
      const teamMap = new Map();
      for (const model of models) {
        const tid = model.team_id;
        if (!teamMap.has(tid)) {
          teamMap.set(tid, {
            team_id: tid,
            team_name: model.team_name || 'Team',
            is_personal: model.is_personal,
            is_default: model.is_default,
            models: []
          });
        }
        teamMap.get(tid).models.push(model);
      }

      if (!container) return;
      setHTML(container, [...teamMap.values()].map(team => `
        <div class="model-library-team model-search-team">
          <div class="model-library-team-header" style="cursor:default;">
            <h3>${escapeHtml(team.team_name)}</h3>
            ${team.is_personal ? '<span class="team-badge">' + t('个人') + '</span>' : ''}
          </div>
          <div class="model-library-list model-search-list">
            ${team.models.map(model => this._renderModelLibraryItem(model, team, ctx.currentModel, model.provider_enabled === false, {
              mode: 'keyPicker',
              onClick: `app.selectKeyModelFromPicker('${this._jsString(model.model_id || model.id)}','${this._jsString(model.name || model.alias || model.upstream_model_id || '')}')`,
              subtitle: model.provider_name
                ? `<span class="model-search-provider-tag">${escapeHtml(model.provider_name)}</span>`
                : ''
            })).join('')}
          </div>
        </div>
      `).join(''));
    } catch (e) {
      if (seq !== ctx.globalSearchSeq) return;
      console.warn(t('[API Key 模型选择] 全局搜索失败:'), e);
      if (container) {
        setHTML(container, '<div class="empty-state" style="padding:32px 16px;text-align:center;"><p style="color:var(--destructive);margin:0;">' + t('搜索失败，请重试') + '</p></div>');
      }
    }
  }

  _modelMatchesKeyPickerSearch(model, search) {
    return (model.name || '').toLowerCase().includes(search) ||
      (model.description || '').toLowerCase().includes(search) ||
      (model.alias || '').toLowerCase().includes(search) ||
      (model.series || '').toLowerCase().includes(search) ||
      (model.upstream_model_id || '').toLowerCase().includes(search);
  }

  _sortKeyPickerProviders(providers, sort) {
    if (!providers || providers.length < 2) return;
    if (sort === 'name_asc') providers.sort((a, b) => (a.provider_name || '').localeCompare(b.provider_name || ''));
    else if (sort === 'name_desc') providers.sort((a, b) => (b.provider_name || '').localeCompare(a.provider_name || ''));
    else if (sort === 'price_asc' || sort === 'price_desc') {
      const minPrice = provider => {
        const prices = (provider.models || []).map(model => model.input_price_per_1k_tokens ?? Infinity);
        return prices.length ? Math.min(...prices) : Infinity;
      };
      providers.sort((a, b) => sort === 'price_asc' ? minPrice(a) - minPrice(b) : minPrice(b) - minPrice(a));
    }
  }

  _sortKeyPickerModels(models, sort) {
    if (!models || models.length < 2) return;
    if (sort === 'price_asc') models.sort((a, b) => (a.input_price_per_1k_tokens || 0) - (b.input_price_per_1k_tokens || 0));
    else if (sort === 'price_desc') models.sort((a, b) => (b.input_price_per_1k_tokens || 0) - (a.input_price_per_1k_tokens || 0));
    else if (sort === 'name_asc') models.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sort === 'name_desc') models.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    else if (sort === 'test_latency_asc') this._sortTestModels(models, 'latency', 'asc');
    else if (sort === 'test_latency_desc') this._sortTestModels(models, 'latency', 'desc');
    else if (sort === 'test_tps_desc') this._sortTestModels(models, 'tps');
  }

  _renderKeyModelPickerLibrary(libraryData) {
    const container = document.getElementById('keyModelPickerContent');
    if (!container) return;
    if (!libraryData.teams || libraryData.teams.length === 0) {
      setHTML(container, '<div class="empty-state" style="padding:48px 20px;text-align:center;"><p style="font-size:15px;color:var(--muted-foreground);margin:0;">' + t('暂无可用模型') + '</p></div>');
      return;
    }

    const hasProviders = libraryData.teams.some(team => team.providers && team.providers.length > 0);
    if (!hasProviders) {
      setHTML(container, '<div class="empty-state" style="padding:48px 20px;text-align:center;"><p style="font-size:15px;color:var(--muted-foreground);margin:0;">' + t('请尝试调整筛选条件') + '</p></div>');
      return;
    }

    setHTML(container, libraryData.teams.map((team, teamIndex) => {
      if (!team.providers || team.providers.length === 0) return '';
      return `
        <div class="model-library-team" data-picker-team-index="${teamIndex}" data-team-id="${escapeHtml(team.team_id)}">
          <div class="model-library-team-header" onclick="app.toggleKeyModelPickerTeam(${teamIndex})">
            <svg class="collapse-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
            <h3>${escapeHtml(team.team_name)}</h3>
            ${team.is_personal ? '<span class="team-badge">' + t('个人') + '</span>' : ''}
            ${team.is_default ? '<span class="team-badge default">' + t('默认') + '</span>' : ''}
          </div>
          <div class="model-library-team-content">
            ${team.providers.map((provider, providerIndex) => this._renderKeyPickerProvider(team, provider, teamIndex, providerIndex)).join('')}
          </div>
        </div>
      `;
    }).join(''));
  }

  _renderKeyPickerProvider(team, provider, teamIndex, providerIndex) {
    const isProviderDisabled = provider.provider_enabled === false;
    const providerKey = this._keyPickerProviderKey(team, provider);
    const hasModels = provider.models_loaded && provider.models && provider.models.length > 0;
    const totalCount = provider.model_count != null ? provider.model_count : (provider.pagination?.total ?? (provider.models ? provider.models.length : 0));
    return `
      <div class="model-library-provider collapsed ${isProviderDisabled ? 'provider-disabled' : ''}"
           data-picker-provider-index="${teamIndex}-${providerIndex}"
           data-team-id="${escapeHtml(team.team_id)}"
           data-provider-id="${escapeHtml(provider.provider_id)}"
           style="${isProviderDisabled ? 'position:relative;' : ''}">
        ${isProviderDisabled ? '<div class="provider-disabled-overlay"></div>' : ''}
        <div class="model-library-provider-header" onclick="app.toggleKeyModelPickerProvider(${teamIndex}, ${providerIndex})">
          <div class="model-library-provider-title">
            <svg class="collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
            <span class="provider-name">${escapeHtml(provider.provider_name)}</span>
            ${this._renderProviderTestSummary(provider)}
            ${(provider.tags || []).map(t =>
              `<span class="model-item-badge" style="background:${t.color}18;color:${t.color};border:1px solid ${t.color}44;">${escapeHtml(t.name)}</span>`
            ).join('')}
            ${isProviderDisabled ? '<span style="color:var(--destructive);font-size:11px;font-weight:500;">' + t('已禁用') + '</span>' : ''}
          </div>
          <div class="model-library-provider-actions">
            <span class="provider-model-count">${totalCount} 个模型</span>
          </div>
        </div>
        <div class="model-library-list">
          ${hasModels
            ? `<div class="model-library-placeholder" data-placeholder="${escapeHtml(providerKey)}"><span class="placeholder-text">${provider.models.length}${t('个模型')}</span></div>`
            : `<div class="model-library-placeholder" data-placeholder="${escapeHtml(providerKey)}"><span class="placeholder-text">${provider.models_loaded ? t('该供应商下暂无模型') : t('点击展开以加载模型')}</span></div>`}
        </div>
      </div>
    `;
  }

  toggleKeyModelPickerTeam(teamIndex) {
    const root = document.getElementById('keyModelPickerContent');
    const teamEl = root?.querySelector(`[data-picker-team-index="${teamIndex}"]`);
    if (teamEl) teamEl.classList.toggle('collapsed');
  }

  async toggleKeyModelPickerProvider(teamIndex, providerIndex) {
    const root = document.getElementById('keyModelPickerContent');
    const providerEl = root?.querySelector(`[data-picker-provider-index="${teamIndex}-${providerIndex}"]`);
    if (!providerEl) return;
    if (!providerEl.classList.contains('collapsed')) {
      providerEl.classList.add('collapsed');
      return;
    }

    const teamId = providerEl.getAttribute('data-team-id');
    const providerId = providerEl.getAttribute('data-provider-id');
    const { team, provider } = this._findKeyPickerTeamProvider(teamId, providerId);
    if (!team || !provider) return;
    providerEl.classList.remove('collapsed');
    if (!provider.models_loaded || provider.models_query_key !== this._getKeyPickerProviderModelsQueryKey(team, provider)) {
      await this._loadKeyPickerProviderModels(team, provider, providerEl, { page: 1, force: true });
    } else {
      this._renderKeyPickerProviderModelsInto(providerEl, provider, team);
    }
  }

  _findKeyPickerTeamProvider(teamId, providerId) {
    const team = (this._keyModelPicker?.data?.teams || []).find(t => String(t.team_id) === String(teamId));
    const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
    return { team, provider };
  }

  _keyPickerProviderKey(team, provider) {
    return `keyPicker::${team.team_id}::${provider.provider_id}`;
  }

  _getKeyPickerProviderModelsQuery(team, provider, page = 1) {
    const ctx = this._keyModelPicker || {};
    const rawSearch = (ctx.search || '').trim();
    const normalizedSearch = rawSearch.toLowerCase();
    const teamMatch = normalizedSearch && (team.team_name || '').toLowerCase().includes(normalizedSearch);
    const providerMatch = normalizedSearch && (provider.provider_name || '').toLowerCase().includes(normalizedSearch);
    return {
      page: Math.max(parseInt(page, 10) || 1, 1),
      limit: this._libraryProviderPageSize,
      search: teamMatch || providerMatch ? '' : rawSearch,
      series: ctx.seriesFilter || 'all',
      test: ctx.testFilter || 'all',
      sort: ctx.sort || 'default'
    };
  }

  _getKeyPickerProviderModelsQueryKey(team, provider) {
    const query = this._getKeyPickerProviderModelsQuery(team, provider, 1);
    return JSON.stringify({
      search: query.search,
      series: query.series,
      test: query.test,
      sort: query.sort
    });
  }

  _buildKeyPickerProviderModelsUrl(team, provider, page) {
    const query = this._getKeyPickerProviderModelsQuery(team, provider, page);
    const params = new URLSearchParams();
    params.set('page', query.page);
    params.set('limit', query.limit);
    if (query.search) params.set('search', query.search);
    if (query.series && query.series !== 'all') params.set('series', query.series);
    if (query.test && query.test !== 'all') params.set('test', query.test);
    if (query.sort && query.sort !== 'default') params.set('sort', query.sort);
    return `/api/user/team/${encodeURIComponent(team.team_id)}/provider/${encodeURIComponent(provider.provider_id)}/models?${params.toString()}`;
  }

  async _loadKeyPickerProviderModels(team, provider, providerEl, options = {}) {
    const ctx = this._keyModelPicker;
    if (!ctx) return;
    const providerKey = this._keyPickerProviderKey(team, provider);
    const page = Math.max(parseInt(options.page || provider.models_page || 1, 10) || 1, 1);
    const queryKey = this._getKeyPickerProviderModelsQueryKey(team, provider);
    if (!options.force && provider.models_loaded && provider.models_page === page && provider.models_query_key === queryKey) return;
    const existingLoad = ctx.loadingPromises.get(providerKey);
    if (existingLoad) {
      await existingLoad.catch(() => {});
      if (provider.models_loaded && provider.models_page === page && provider.models_query_key === queryKey) {
        const freshEl = providerEl
          ? document.getElementById('keyModelPickerContent')?.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(provider.provider_id))}"]`) || providerEl
          : null;
        if (freshEl) {
          freshEl.classList.remove('collapsed');
          this._renderKeyPickerProviderModelsInto(freshEl, provider, team);
        }
        return;
      }
      if (ctx.loadingProviders.has(providerKey)) return;
    }

    ctx.loadingProviders.add(providerKey);
    let resolveLoad;
    const loadPromise = new Promise(resolve => { resolveLoad = resolve; });
    ctx.loadingPromises.set(providerKey, loadPromise);
    if (providerEl) {
      const list = providerEl.querySelector('.model-library-list');
      if (list) setHTML(list, `<div class="model-library-placeholder" data-placeholder="${escapeHtml(providerKey)}">${inlineLoadingHtml(t('正在加载模型...'), 'sm')}</div>`);
    }

    try {
      const res = await fetch(this._buildKeyPickerProviderModelsUrl(team, provider, page));
      if (!res.ok) {
        let detail = '';
        try { const b = await res.json(); detail = b?.error || ''; } catch (_) { /* ignore */ }
        throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
      }
      const data = await res.json();
      provider.models = Array.isArray(data.models) ? data.models : [];
      provider.models_loaded = true;
      provider.models_page = data.pagination?.page || page;
      provider.models_query_key = queryKey;
      provider.pagination = data.pagination || {
        page,
        limit: this._libraryProviderPageSize,
        total: provider.models.length,
        total_pages: 1,
        has_prev: false,
        has_next: false
      };
      if (!ctx.search && ctx.seriesFilter === 'all' && ctx.testFilter === 'all') {
        provider.model_count = data.pagination?.total ?? provider.model_count ?? provider.models.length;
      }

      const freshEl = document.getElementById('keyModelPickerContent')?.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(provider.provider_id))}"]`)
        || (providerEl && providerEl.isConnected ? providerEl : null);
      // 不依赖原始 providerEl 是否仍有效，否则成功后不渲染
      if (freshEl) {
        freshEl.classList.remove('collapsed');
        try {
          this._renderKeyPickerProviderModelsInto(freshEl, provider, team);
        } catch (renderErr) {
          console.warn(t('[API Key 模型选择] 渲染失败:'), renderErr?.message || renderErr);
        }
      }
      try { this._refreshKeyPickerProviderTestSummary(team, provider); } catch (_) { /* ignore */ }
      try { this._rebuildKeyModelPickerSeriesFilter(); } catch (_) { /* ignore */ }
    } catch (e) {
      console.warn(t('[API Key 模型选择] 加载供应商模型失败:'), {
        teamId: team.team_id,
        providerId: provider.provider_id,
        page,
        error: e?.message || String(e)
      });
      const failEl = document.getElementById('keyModelPickerContent')?.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(provider.provider_id))}"]`)
        || (providerEl && providerEl.isConnected ? providerEl : null);
      if (failEl) {
        const listEl = failEl.querySelector('.model-library-list');
        if (listEl) setHTML(listEl, `<div class="model-library-placeholder"><span class="placeholder-text" style="color:var(--destructive);">${t('加载失败，')}<a href="#" onclick="event.preventDefault();app.retryKeyModelPickerProviderModels('${this._jsString(team.team_id)}','${this._jsString(provider.provider_id)}\')">${t('重试')}</a></span></div>`);
      }
    } finally {
      ctx.loadingProviders.delete(providerKey);
      if (ctx.loadingPromises.get(providerKey) === loadPromise) ctx.loadingPromises.delete(providerKey);
      resolveLoad();
      if (ctx.search && !ctx.searchRafPending) {
        ctx.searchRafPending = true;
        requestAnimationFrame(() => {
          if (!this._keyModelPicker) return;
          this._keyModelPicker.searchRafPending = false;
          if (this._keyModelPicker.search) this.filterAndRenderKeyModelPicker();
        });
      }
    }
  }

  async retryKeyModelPickerProviderModels(teamId, providerId) {
    const providerEl = document.getElementById('keyModelPickerContent')?.querySelector(`.model-library-provider[data-team-id="${CSS.escape(teamId)}"][data-provider-id="${CSS.escape(providerId)}"]`);
    if (!providerEl) return;
    const { team, provider } = this._findKeyPickerTeamProvider(teamId, providerId);
    if (!team || !provider) return;
    provider.models_loaded = false;
    await this._loadKeyPickerProviderModels(team, provider, providerEl, { page: 1, force: true });
  }

  _renderKeyPickerProviderModelsInto(providerEl, provider, team) {
    const listEl = providerEl.querySelector('.model-library-list');
    const ctx = this._keyModelPicker;
    if (!listEl || !ctx) return;
    const queryKey = this._getKeyPickerProviderModelsQueryKey(team, provider);
    if (!provider.models_loaded || provider.models_query_key !== queryKey) {
      this._loadKeyPickerProviderModels(team, provider, providerEl, { page: 1, force: true });
      return;
    }
    if (!provider.models || provider.models.length === 0) {
      const hasActiveFilter = ctx.search || ctx.seriesFilter !== 'all' || ctx.testFilter !== 'all';
      setHTML(listEl, `<div class="model-library-placeholder"><span class="placeholder-text">${hasActiveFilter ? t('没有符合筛选条件的模型') : t('该供应商下暂无模型')}</span></div>`);
      return;
    }

    const isProviderDisabled = provider.provider_enabled === false;
    setHTML(listEl, provider.models.map(model => this._renderModelLibraryItem(model, team, ctx.currentModel, isProviderDisabled, {
      mode: 'keyPicker',
      onClick: `app.selectKeyModelFromPicker('${this._jsString(model.model_id || model.id)}','${this._jsString(model.name || model.alias || model.upstream_model_id || '')}')`
    })).join('') + this._renderKeyPickerProviderPagination(team, provider));
    this._loadModelUptimeForIds(provider.models.map(m => m.model_id || m.id));
    const countEl = providerEl.querySelector('.provider-model-count');
    if (countEl) countEl.textContent = `${provider.model_count ?? provider.pagination?.total ?? provider.models.length}${t('个模型')}`;
  }

  _renderKeyPickerProviderPagination(team, provider) {
    const pagination = provider.pagination;
    if (!pagination || pagination.total <= pagination.limit) return '';
    const current = pagination.page || 1;
    const totalPages = pagination.total_pages || 1;
    const pages = [];
    const addPage = (p) => {
      if (p >= 1 && p <= totalPages && !pages.includes(p)) pages.push(p);
    };
    addPage(1);
    addPage(current - 1);
    addPage(current);
    addPage(current + 1);
    addPage(totalPages);
    pages.sort((a, b) => a - b);
    let lastPage = 0;
    const pageButtons = pages.map(p => {
      const gap = p - lastPage > 1 ? '<span class="model-library-page-ellipsis">...</span>' : '';
      lastPage = p;
      return `${gap}<button class="model-library-page-btn ${p === current ? 'active' : ''}" ${p === current ? 'disabled' : ''} onclick="event.stopPropagation();app.loadKeyModelPickerProviderPage('${this._jsString(team.team_id)}','${this._jsString(provider.provider_id)}',${p})">${p}</button>`;
    }).join('');
    return `
      <div class="model-library-pagination">
        <button class="model-library-page-btn" ${pagination.has_prev ? '' : 'disabled'} onclick="event.stopPropagation();app.loadKeyModelPickerProviderPage('${this._jsString(team.team_id)}','${this._jsString(provider.provider_id)}',${current - 1})">上一页</button>
        ${pageButtons}
        <button class="model-library-page-btn" ${pagination.has_next ? '' : 'disabled'} onclick="event.stopPropagation();app.loadKeyModelPickerProviderPage('${this._jsString(team.team_id)}','${this._jsString(provider.provider_id)}',${current + 1})">下一页</button>
        <span class="model-library-page-summary">共 ${pagination.total} 个</span>
      </div>
    `;
  }

  _refreshKeyPickerProviderTestSummary(team, provider) {
    if (!team || !provider) return;
    const root = document.getElementById('keyModelPickerContent');
    const providerEl = root?.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(provider.provider_id))}"]`);
    const summaryEl = providerEl?.querySelector('.provider-test-summary');
    if (!summaryEl) return;
    const summary = this._computeProviderTestSummary(provider);
    const formatted = this._formatProviderTestSummary(summary);
    summaryEl.className = `provider-test-summary ${formatted.className}`;
    summaryEl.title = formatted.title;
    summaryEl.textContent = formatted.text;
  }

  async loadKeyModelPickerProviderPage(teamId, providerId, page) {
    const { team, provider } = this._findKeyPickerTeamProvider(teamId, providerId);
    if (!team || !provider) return;
    const providerEl = document.getElementById('keyModelPickerContent')?.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(teamId))}"][data-provider-id="${CSS.escape(String(providerId))}"]`);
    if (!providerEl) return;
    providerEl.classList.remove('collapsed');
    await this._loadKeyPickerProviderModels(team, provider, providerEl, { page, force: true });
  }

  _ensureKeyPickerProviderModelsLoadedByName(providerName) {
    const ctx = this._keyModelPicker;
    if (!ctx?.data) return;
    for (const team of ctx.data.teams || []) {
      for (const provider of team.providers || []) {
        if (provider.provider_name !== providerName) continue;
        if (provider.models_loaded && provider.models_query_key === this._getKeyPickerProviderModelsQueryKey(team, provider)) continue;
        const providerEl = document.getElementById('keyModelPickerContent')?.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(provider.provider_id))}"]`);
        if (providerEl) {
          providerEl.classList.remove('collapsed');
          this._loadKeyPickerProviderModels(team, provider, providerEl, { page: 1, force: true });
        }
      }
    }
  }

  _captureKeyPickerExpandedState() {
    const root = document.getElementById('keyModelPickerContent');
    return {
      collapsedTeams: new Set([...(root?.querySelectorAll('.model-library-team.collapsed') || [])].map(el => String(el.getAttribute('data-team-id')))),
      expandedProviders: new Set([...(root?.querySelectorAll('.model-library-provider:not(.collapsed)') || [])].map(el => `${el.getAttribute('data-team-id')}::${el.getAttribute('data-provider-id')}`))
    };
  }

  _restoreKeyPickerExpandedState(state) {
    if (!state) return;
    const root = document.getElementById('keyModelPickerContent');
    if (!root) return;
    root.querySelectorAll('.model-library-team').forEach(el => {
      if (state.collapsedTeams?.has(String(el.getAttribute('data-team-id')))) el.classList.add('collapsed');
    });
    root.querySelectorAll('.model-library-provider').forEach(el => {
      const key = `${el.getAttribute('data-team-id')}::${el.getAttribute('data-provider-id')}`;
      if (!state.expandedProviders?.has(key)) return;
      el.classList.remove('collapsed');
      const { team, provider } = this._findKeyPickerTeamProvider(el.getAttribute('data-team-id'), el.getAttribute('data-provider-id'));
      // 同主库：未加载时让渲染函数触发按需加载，避免展开卡片空白
      if (team && provider) this._renderKeyPickerProviderModelsInto(el, provider, team);
    });
  }

  _renderKeyModelQueueList() {
    const listEl = document.getElementById('keyModelQueueList');
    const ctx = this._keyModelPicker;
    if (!listEl || !ctx) return;
    const queue = ctx.queue || [];
    if (!queue.length) {
      setHTML(listEl, '<div class="key-model-queue-empty">' + t('点击下方模型加入队列；拖拽调整顺序，第一项为首选') + '</div>');
      return;
    }
    // 渲染前尽量把「只显示了 id」的项解析成可读名称
    for (const item of queue) {
      if (!item) continue;
      if (!item.name || this._looksLikeBareModelId(item.name, item.id)) {
        const resolved = this._resolveKeyPickerModelName(item.id, item.name);
        if (resolved) item.name = resolved;
      }
    }
    setHTML(listEl, queue.map((item, index) => {
      const displayName = item.name || item.id;
      return `
      <div class="key-model-queue-item" draggable="true" data-model-id="${escapeHtml(item.id)}">
        <span class="key-model-queue-handle" title="${t('拖拽排序')}" aria-hidden="true">⠿</span>
        <span class="key-model-queue-order">${index + 1}</span>
        <span class="key-model-queue-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}${index === 0 ? ' <em class="key-model-queue-primary">' + t('首选') + '</em>' : ''}</span>
        <div class="key-model-queue-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();app.removeKeyModelFromQueue('${this._jsString(item.id)}')" title="${t('移除')}">×</button>
        </div>
      </div>`;
    }).join(''));
  }

  /** 模型队列拖拽排序（事件委托，绑定一次） */
  _ensureKeyModelQueueDragBound() {
    const listEl = document.getElementById('keyModelQueueList');
    if (!listEl || listEl.dataset.dragBound === '1') return;
    listEl.dataset.dragBound = '1';

    listEl.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.key-model-queue-item');
      if (!item || !listEl.contains(item)) return;
      // 点在移除按钮上不启动拖拽
      if (e.target.closest('button, a, input')) {
        e.preventDefault();
        return;
      }
      const modelId = item.getAttribute('data-model-id');
      if (!modelId) return;
      this._keyQueueDragId = modelId;
      this._keyQueueDropTargetId = null;
      this._keyQueueDropBefore = true;
      item.classList.add('key-model-queue-dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', modelId);
        // 半透明拖拽预览
        if (e.dataTransfer.setDragImage) {
          e.dataTransfer.setDragImage(item, 24, 16);
        }
      } catch (_) { /* ignore */ }
    });

    listEl.addEventListener('dragover', (e) => {
      if (!this._keyQueueDragId) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ }
      const target = e.target.closest('.key-model-queue-item');
      listEl.querySelectorAll('.key-model-queue-drag-over, .key-model-queue-drag-before, .key-model-queue-drag-after')
        .forEach(el => el.classList.remove('key-model-queue-drag-over', 'key-model-queue-drag-before', 'key-model-queue-drag-after'));
      if (!target || target.classList.contains('key-model-queue-dragging')) return;
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.classList.add('key-model-queue-drag-over', before ? 'key-model-queue-drag-before' : 'key-model-queue-drag-after');
      this._keyQueueDropTargetId = target.getAttribute('data-model-id');
      this._keyQueueDropBefore = before;
    });

    listEl.addEventListener('dragleave', (e) => {
      // 仅在真正离开列表时清理高亮
      if (!listEl.contains(e.relatedTarget)) {
        listEl.querySelectorAll('.key-model-queue-drag-over, .key-model-queue-drag-before, .key-model-queue-drag-after')
          .forEach(el => el.classList.remove('key-model-queue-drag-over', 'key-model-queue-drag-before', 'key-model-queue-drag-after'));
      }
    });

    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fromId = this._keyQueueDragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      const toId = this._keyQueueDropTargetId;
      const before = this._keyQueueDropBefore !== false;
      if (fromId && toId && String(fromId) !== String(toId)) {
        this.reorderKeyModelQueue(fromId, toId, before);
      } else {
        this._cleanupKeyQueueDrag();
      }
    });

    listEl.addEventListener('dragend', () => {
      this._cleanupKeyQueueDrag();
    });
  }

  _cleanupKeyQueueDrag() {
    this._keyQueueDragId = null;
    this._keyQueueDropTargetId = null;
    this._keyQueueDropBefore = true;
    const listEl = document.getElementById('keyModelQueueList');
    if (!listEl) return;
    listEl.querySelectorAll('.key-model-queue-dragging, .key-model-queue-drag-over, .key-model-queue-drag-before, .key-model-queue-drag-after')
      .forEach(el => el.classList.remove('key-model-queue-dragging', 'key-model-queue-drag-over', 'key-model-queue-drag-before', 'key-model-queue-drag-after'));
  }

  /**
   * 将 fromId 移动到 toId 之前或之后
   * @param {string} fromId
   * @param {string} toId
   * @param {boolean} before
   */
  reorderKeyModelQueue(fromId, toId, before = true) {
    const ctx = this._keyModelPicker;
    if (!ctx?.queue?.length) return;
    const fromIdx = ctx.queue.findIndex(m => String(m.id) === String(fromId));
    if (fromIdx < 0) return;
    const [item] = ctx.queue.splice(fromIdx, 1);
    let insertIdx = ctx.queue.findIndex(m => String(m.id) === String(toId));
    if (insertIdx < 0) {
      ctx.queue.push(item);
    } else {
      if (!before) insertIdx += 1;
      ctx.queue.splice(insertIdx, 0, item);
    }
    this._syncKeyModelPickerQueueState();
  }

  _syncKeyModelPickerQueueState() {
    const ctx = this._keyModelPicker;
    if (!ctx) return;
    ctx.assignedModelIds = new Set((ctx.queue || []).map(m => String(m.id)));
    ctx.currentModel = ctx.queue?.[0]
      ? { id: ctx.queue[0].id, name: ctx.queue[0].name }
      : null;
    this._renderKeyModelQueueList();
    this.filterAndRenderKeyModelPicker();
  }

  /** @deprecated 保留兼容；优先使用拖拽 reorderKeyModelQueue */
  moveKeyModelQueueItem(modelId, delta) {
    const ctx = this._keyModelPicker;
    if (!ctx?.queue) return;
    const idx = ctx.queue.findIndex(m => String(m.id) === String(modelId));
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= ctx.queue.length) return;
    const [item] = ctx.queue.splice(idx, 1);
    ctx.queue.splice(next, 0, item);
    this._syncKeyModelPickerQueueState();
  }

  removeKeyModelFromQueue(modelId) {
    const ctx = this._keyModelPicker;
    if (!ctx?.queue) return;
    ctx.queue = ctx.queue.filter(m => String(m.id) !== String(modelId));
    this._syncKeyModelPickerQueueState();
  }

  selectKeyModelFromPicker(modelId, modelName) {
    const ctx = this._keyModelPicker;
    if (!ctx?.keyId || !modelId) return;
    const id = String(modelId);
    const existingIdx = (ctx.queue || []).findIndex(m => String(m.id) === id);
    if (existingIdx >= 0) {
      // 再次点击已在队列中的模型：移除
      ctx.queue.splice(existingIdx, 1);
      this._syncKeyModelPickerQueueState();
      return;
    }
    if ((ctx.queue || []).length >= 10) {
      this.showToast(t('模型队列最多 10 个'), 'error');
      return;
    }
    const resolvedName = this._resolveKeyPickerModelName(modelId, modelName);
    if (!ctx.queue) ctx.queue = [];
    ctx.queue.push({ id, name: resolvedName });
    this._syncKeyModelPickerQueueState();
  }

  /** 解析队列展示名：优先入参，再查已加载/搜索结果 */
  _resolveKeyPickerModelName(modelId, hintName) {
    const hint = (hintName != null && String(hintName).trim()) ? String(hintName).trim() : '';
    // 提示名若不像裸 UUID/长 id，优先使用
    if (hint && hint !== String(modelId) && !this._looksLikeBareModelId(hint, modelId)) {
      return hint;
    }
    const model = this._findModelInKeyPicker(modelId);
    const fromModel = model?.name || model?.alias || model?.upstream_model_id || '';
    if (fromModel && String(fromModel).trim()) return String(fromModel).trim();
    return hint || String(modelId);
  }

  _looksLikeBareModelId(name, modelId) {
    if (!name) return true;
    if (String(name) === String(modelId)) return true;
    // 常见 UUID
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(name));
  }

  _findModelInKeyPicker(modelId) {
    const ctx = this._keyModelPicker;
    if (!ctx || modelId == null) return null;
    const want = String(modelId);

    const matchInList = (list) => {
      if (!Array.isArray(list)) return null;
      return list.find(m => String(m?.model_id || m?.id) === want) || null;
    };

    // 1) 已加载的供应商模型明细
    for (const team of ctx.data?.teams || []) {
      for (const provider of team.providers || []) {
        const found = matchInList(provider.models);
        if (found) return found;
      }
    }

    // 2) 全局搜索结果（按需搜索时模型不在 provider.models 里）
    if (ctx._globalSearchModels) {
      const found = matchInList(ctx._globalSearchModels);
      if (found) return found;
    }

    // 3) 主模型库缓存（若用户已在模型库页加载过）
    for (const team of this._libraryData?.teams || []) {
      for (const provider of team.providers || []) {
        const found = matchInList(provider.models);
        if (found) return found;
      }
    }

    return null;
  }

  async showKeyFusionConfig(keyId) {
    const container = document.getElementById('keyModelsContent');
    this._configureKeyModelsModal({
      title: t('Fusion 配置'),
      picker: false,
      saveVisible: true,
      saveText: t('保存'),
      cancelText: t('取消')
    });
    this._keyModelPicker = null;
    setHTML(container, pageLoadingHtml(t('加载中...'), { compact: true }));
    this.showModal('keyModelsModal');

    try {
      // 并行加载当前配置和所有模型
      const [configRes, modelsRes] = await Promise.all([
        fetch(`/api/user/api-keys/${keyId}/fusion-config`),
        fetch('/api/user/api-keys/' + keyId + '/models')
      ]);
      if (!configRes.ok) { setHTML(container, '<p style="color:var(--destructive);text-align:center;padding:20px;">' + t('加载失败') + '</p>'); return; }
      const config = await configRes.json();
      const modelsPayload = modelsRes.ok ? await modelsRes.json() : [];
      const models = this._normalizeKeyModelsPayload(modelsPayload);

      const selectedPanels = new Set(config.panel_models || []);
      const currentJudge = config.judge_model_id || '';
      const currentOuter = config.outer_model_id || '';
      const fusionEnabled = config.fusion_enabled !== false;

      // 按供应商分组
      const byProvider = {};
      models.forEach(m => {
        const p = m.provider || t('其他');
        if (!byProvider[p]) byProvider[p] = [];
        byProvider[p].push(m);
      });
      const providerEntries = Object.entries(byProvider);

      setHTML(container, `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding:10px 12px;background:var(--secondary);border-radius:8px;">
          <div>
            <div style="font-size:14px;font-weight:500;">启用 Fusion</div>
            <div style="font-size:12px;color:var(--muted-foreground);">禁用后，请求 fusion 模型将回退到当前绑定模型</div>
          </div>
          <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;">
            <input type="checkbox" id="fusionEnabledToggle" ${fusionEnabled ? 'checked' : ''} style="opacity:0;width:0;height:0;">
            <span style="position:absolute;inset:0;background:${fusionEnabled ? 'var(--primary)' : 'var(--border)'};border-radius:12px;transition:background 0.2s;"></span>
            <span style="position:absolute;top:2px;${fusionEnabled ? 'right:2px' : 'left:2px'};width:20px;height:20px;background:white;border-radius:50%;transition:left 0.2s,right 0.2s;box-shadow:0 1px 3px rgba(0,0,0,.2);"></span>
          </label>
        </div>

        <div id="fusionConfigBody" style="${fusionEnabled ? '' : 'opacity:0.4;pointer-events:none;'}">
        <div style="margin-bottom:16px;">
          <div style="font-size:13px;color:var(--muted-foreground);margin-bottom:8px;">Panel 模型（多选，并行调用）</div>
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <input type="text" id="fusionPanelSearch" class="input" placeholder="${t('搜索模型...')}" style="flex:1;font-size:13px;" oninput="app._filterFusionPanelModels()">
            <button class="btn btn-sm btn-secondary" onclick="app._toggleAllFusionPanels()">全选/取消</button>
          </div>
          <div id="fusionPanelList" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;">
            ${providerEntries.map(([provider, pModels]) => `
              <div class="fusion-provider-group" style="margin-bottom:8px;">
                <div style="font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;margin-bottom:4px;">${provider}</div>
                ${pModels.map(m => {
                  const label = m.name || m.upstream_model_id || m.id;
                  const checked = selectedPanels.has(m.id) ? 'checked' : '';
                  return `
                    <label class="fusion-panel-item" data-search="${(label + ' ' + m.id).toLowerCase()}" style="display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:4px;font-size:13px;">
                      <input type="checkbox" class="fusion-panel-cb" value="${m.id}" ${checked}>
                      <span>${label}</span>
                    </label>
                  `;
                }).join('')}
              </div>
            `).join('')}
          </div>
          <div id="fusionPanelCount" style="font-size:12px;color:var(--muted-foreground);margin-top:4px;">${selectedPanels.size} 个模型已选</div>
        </div>

        <div style="display:flex;gap:12px;margin-bottom:16px;">
          <div style="flex:1;">
            <div style="font-size:13px;color:var(--muted-foreground);margin-bottom:6px;">Judge 模型</div>
            <select id="fusionJudgeSelect" class="input" style="font-size:13px;">
              ${models.map(m => `<option value="${m.id}" ${currentJudge === m.id ? 'selected' : ''}>${m.name || m.id}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1;">
            <div style="font-size:13px;color:var(--muted-foreground);margin-bottom:6px;">合成模型</div>
            <select id="fusionOuterSelect" class="input" style="font-size:13px;">
              ${models.map(m => `<option value="${m.id}" ${currentOuter === m.id ? 'selected' : ''}>${m.name || m.id}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="font-size:12px;color:var(--muted-foreground);background:var(--secondary);padding:10px;border-radius:8px;">
          💡 <strong>Fusion</strong> 会将请求同时发送给多个 Panel 模型，由 Judge 模型分析差异后，由合成模型生成最终回答。留空则使用系统默认配置。
        </div>
        </div>
      `);

      // 绑定 Fusion 启用开关
      const toggleEl = document.getElementById('fusionEnabledToggle');
      if (toggleEl) {
        toggleEl.addEventListener('change', () => {
          const on = toggleEl.checked;
          const body = document.getElementById('fusionConfigBody');
          if (body) { body.style.opacity = on ? '' : '0.4'; body.style.pointerEvents = on ? '' : 'none'; }
          // 更新滑块外观
          const track = toggleEl.nextElementSibling;
          const knob = track?.nextElementSibling;
          if (track) track.style.background = on ? 'var(--primary)' : 'var(--border)';
          if (knob) { knob.style.left = on ? '' : '2px'; knob.style.right = on ? '2px' : ''; }
        });
      }

      // 绑定 panel checkbox 变化事件
      container.querySelectorAll('.fusion-panel-cb').forEach(cb => {
        cb.addEventListener('change', () => {
          const count = container.querySelectorAll('.fusion-panel-cb:checked').length;
          document.getElementById('fusionPanelCount').textContent = `${count}${t('个模型已选')}`;
        });
      });

      // 存储 keyId 并重写保存逻辑
      this._editingKeyModelsId = keyId;
      this._saveKeyModelsOverride = async () => {
        const panelModels = Array.from(container.querySelectorAll('.fusion-panel-cb:checked')).map(cb => cb.value);
        const judgeModelId = document.getElementById('fusionJudgeSelect').value;
        const outerModelId = document.getElementById('fusionOuterSelect').value;

        try {
          const saveRes = await fetch(`/api/user/api-keys/${keyId}/fusion-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ panel_models: panelModels, judge_model_id: judgeModelId, outer_model_id: outerModelId, fusion_enabled: document.getElementById('fusionEnabledToggle')?.checked ?? true })
          });
          if (saveRes.ok) {
            this.closeModals();
            this._saveKeyModelsOverride = null;
            this.loadApiKeys();
          } else {
            alert(t('保存失败'));
          }
        } catch (e) {
          console.error(t('保存 Fusion 配置失败:'), e);
          alert(t('保存失败'));
        }
      };
    } catch (error) {
      console.error(t('加载 Fusion 配置失败:'), error);
      setHTML(container, '<p style="color:var(--destructive);text-align:center;padding:20px;">' + t('加载失败') + '</p>');
    }
  }

  _filterFusionPanelModels() {
    const keyword = (document.getElementById('fusionPanelSearch')?.value || '').toLowerCase();
    document.querySelectorAll('#fusionPanelList .fusion-panel-item').forEach(item => {
      item.style.display = item.dataset.search.includes(keyword) ? '' : 'none';
    });
  }

  _toggleAllFusionPanels() {
    const visible = document.querySelectorAll('#fusionPanelList .fusion-panel-item:not([style*="display: none"]) .fusion-panel-cb');
    const allChecked = Array.from(visible).every(cb => cb.checked);
    visible.forEach(cb => cb.checked = !allChecked);
    const count = document.querySelectorAll('#fusionPanelList .fusion-panel-cb:checked').length;
    document.getElementById('fusionPanelCount').textContent = `${count}${t('个模型已选')}`;
  }

  // 签名设置相关函数
  _currentSignatureKeyId = null;

  async showKeySignature(keyId) {
    this._currentSignatureKeyId = keyId;
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/signature`);
      if (!res.ok) {
        alert(t('加载签名配置失败'));
        return;
      }
      const data = await res.json();

      const mode = document.getElementById('keySignatureMode');
      const template = document.getElementById('keySignatureTemplate');
      const preview = document.getElementById('keySignaturePreview');

      // 设置模式
      if (data.key_signature_enabled === null) {
        mode.value = 'inherit';
      } else if (data.key_signature_enabled) {
        mode.value = 'enable';
      } else {
        mode.value = 'disable';
      }

      // 设置模板
      template.value = data.key_signature_template || '';

      // 更新 UI 状态
      this.toggleKeySignatureMode();
      this._updateKeySignaturePreview();

      // 绑定预览更新事件
      template.oninput = () => this._updateKeySignaturePreview();

      this.showModal('keySignatureModal');
    } catch (error) {
      console.error(t('加载签名配置失败:'), error);
      alert(t('加载签名配置失败'));
    }
  }

  toggleKeySignatureMode() {
    const mode = document.getElementById('keySignatureMode').value;
    const templateGroup = document.getElementById('keySignatureTemplateGroup');
    templateGroup.style.display = mode === 'inherit' ? 'none' : '';
    this._updateKeySignaturePreview();
  }

  _updateKeySignaturePreview() {
    const preview = document.getElementById('keySignaturePreview');
    if (!preview) return;

    const mode = document.getElementById('keySignatureMode').value;
    if (mode === 'inherit') {
      preview.textContent = t('预览：将使用用户默认签名设置');
      return;
    }

    if (mode === 'disable') {
      preview.textContent = t('预览：此 API Key 的回复将不包含签名');
      return;
    }

    const tpl = document.getElementById('keySignatureTemplate').value || t('{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}');
    const example = tpl
      .replace(/\{model\}/g, 'gpt-4o')
      .replace(/\{tokens\}/g, '12.3k tokens')
      .replace(/\{cache_hit\}/g, '78%')
      .replace(/\{cached_tokens\}/g, '8,400')
      .replace(/\{provider\}/g, 'OpenAI')
      .replace(/\{cost\}/g, t('0.0123 积分'))
      .replace(/\{username\}/g, 'demo')
      .replace(/\{key_name\}/g, t('生产环境'))
      .replace(/\{balance\}/g, '9999')
      .replace(/\{group_name\}/g, t('默认组'))
      .replace(/\{team_name\}/g, t('我的团队'))
      .replace(/\{quota_info\}/g, t('5小时限额 35% · 周限额 12%'))
      .replace(/\{today_requests\}/g, '128')
      .replace(/\{today_tokens\}/g, '50.2k tokens');
    preview.textContent = example ? `${t('预览：')}${example}` : t('(空模板，不显示签名)');
  }

  async saveKeySignature() {
    const mode = document.getElementById('keySignatureMode').value;
    const template = document.getElementById('keySignatureTemplate').value;

    let signature_enabled = null;
    if (mode === 'enable') signature_enabled = true;
    else if (mode === 'disable') signature_enabled = false;

    try {
      const res = await fetch(`/api/user/api-keys/${this._currentSignatureKeyId}/signature`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature_enabled,
          signature_template: template || null
        })
      });

      if (res.ok) {
        this.closeModals();
        this.loadApiKeys();  // 刷新列表显示新的签名状态
      } else {
        alert(t('保存失败'));
      }
    } catch (error) {
      console.error(t('保存签名配置失败:'), error);
      alert(t('保存失败'));
    }
  }

  async toggleKeySwallowImages(keyId, swallowImages) {
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/swallow-images`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swallow_images: !!swallowImages })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('操作失败'));
      }
      this.showToast(
        swallowImages
          ? t('已启用吞图：请求中的图片不会转发给上游供应商')
          : t('已关闭吞图'),
        'success'
      );
      await this.loadApiKeys();
    } catch (err) {
      console.error(t('切换吞图失败:'), err);
      this.showToast(err.message || t('切换吞图失败'), 'error');
    }
  }

  showKeyOptions(keyId) {
    const key = (this._lastApiKeys || []).find(item => Number(item.id) === Number(keyId));
    if (!key) return;
    this._currentOptionsKeyId = keyId;
    const warning = document.getElementById('keyOptionQuotaWarning');
    const swallow = document.getElementById('keyOptionSwallowImages');
    const commands = document.getElementById('keyOptionCrewRouterCommands');
    if (warning) warning.checked = key.quota_warning_enabled !== false;
    if (swallow) swallow.checked = key.swallow_images === true;
    if (commands) commands.checked = key.crewrouter_commands !== false;
    this.showModal('keyOptionsModal');
  }

  async saveKeyOptions() {
    const keyId = this._currentOptionsKeyId;
    if (!keyId) return;
    const settings = [
      ['quota-warning', 'quota_warning_enabled', document.getElementById('keyOptionQuotaWarning')?.checked !== false],
      ['swallow-images', 'swallow_images', document.getElementById('keyOptionSwallowImages')?.checked === true],
      ['crewrouter-commands', 'crewrouter_commands', document.getElementById('keyOptionCrewRouterCommands')?.checked !== false]
    ];
    try {
      for (const [endpoint, field, value] of settings) {
        const res = await fetch(`/api/user/api-keys/${keyId}/${endpoint}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || t('保存失败'));
        }
      }
      this.closeModals();
      this.showToast(t('API Key 选项已保存'), 'success');
      await this.loadApiKeys();
    } catch (err) {
      this.showToast(err.message || t('保存 API Key 选项失败'), 'error');
    }
  }

  async toggleKeyQuotaWarning(keyId, enabled) {
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/quota-warning`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quota_warning_enabled: !!enabled })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('操作失败'));
      }
      this.showToast(enabled ? t('已启用额度预警') : t('已关闭额度预警'), 'success');
      await this.loadApiKeys();
    } catch (err) {
      console.error(t('切换额度预警失败:'), err);
      this.showToast(err.message || t('切换额度预警失败'), 'error');
    }
  }

  async toggleKeyCrewRouterCommands(keyId, enabled) {
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/crewrouter-commands`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewrouter_commands: !!enabled })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('操作失败'));
      }
      this.showToast(
        enabled
          ? t('已允许此 Key 使用 @CrewRouter 指令')
          : t('已禁止此 Key 使用 @CrewRouter 指令'),
        'success'
      );
      await this.loadApiKeys();
    } catch (err) {
      console.error(t('切换 CrewRouter 指令失败:'), err);
      this.showToast(err.message || t('切换失败'), 'error');
    }
  }

  async toggleKeyEnabled(keyId, enabled) {
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('操作失败'));
      }
      await this.loadApiKeys();
    } catch (err) {
      alert(t('更新失败: ') + err.message);
      await this.loadApiKeys();
    }
  }

  async showKeySchedule(keyId) {
    this._currentScheduleKeyId = keyId;
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/schedule`);
      if (!res.ok) {
        alert(t('加载定时配置失败'));
        return;
      }
      const data = await res.json();

      document.getElementById('scheduleEnabled').checked = data.schedule_enabled || false;
      document.getElementById('scheduleOnTime').value = data.schedule_on_time ? data.schedule_on_time.substring(0, 5) : '09:00';
      document.getElementById('scheduleOffTime').value = data.schedule_off_time ? data.schedule_off_time.substring(0, 5) : '18:00';
      document.getElementById('scheduleTimezone').value = data.schedule_timezone || 'Asia/Shanghai';

      const days = data.schedule_days || [0, 1, 2, 3, 4, 5, 6];
      document.querySelectorAll('.schedule-day').forEach(cb => {
        cb.checked = days.includes(parseInt(cb.value));
      });

      this._toggleScheduleFields();
      document.getElementById('scheduleEnabled').onchange = () => this._toggleScheduleFields();
      this.showModal('keyScheduleModal');
    } catch (error) {
      console.error(t('加载定时配置失败:'), error);
      alert(t('加载定时配置失败'));
    }
  }

  _toggleScheduleFields() {
    const enabled = document.getElementById('scheduleEnabled').checked;
    document.getElementById('scheduleFields').style.display = enabled ? '' : 'none';
  }

  async saveKeySchedule() {
    const schedule_enabled = document.getElementById('scheduleEnabled').checked;
    const schedule_on_time = document.getElementById('scheduleOnTime').value;
    const schedule_off_time = document.getElementById('scheduleOffTime').value;
    const schedule_timezone = document.getElementById('scheduleTimezone').value;
    const schedule_days = Array.from(document.querySelectorAll('.schedule-day:checked')).map(cb => parseInt(cb.value));

    if (schedule_enabled && (!schedule_on_time || !schedule_off_time)) {
      alert(t('请设置开启和关闭时间'));
      return;
    }
    if (schedule_enabled && schedule_days.length === 0) {
      alert(t('请至少选择一天'));
      return;
    }

    try {
      const res = await fetch(`/api/user/api-keys/${this._currentScheduleKeyId}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule_enabled,
          schedule_on_time: schedule_on_time || null,
          schedule_off_time: schedule_off_time || null,
          schedule_days: schedule_days.length > 0 ? schedule_days : [0, 1, 2, 3, 4, 5, 6],
          schedule_timezone
        })
      });

      if (res.ok) {
        this.closeModals();
        this.loadApiKeys();
      } else {
        const data = await res.json();
        alert(t('保存失败: ') + (data.error || t('未知错误')));
      }
    } catch (error) {
      console.error(t('保存定时配置失败:'), error);
      alert(t('保存失败'));
    }
  }

  async showKeyUsage(keyId, keyName) {
    document.getElementById('keyUsageTitle').textContent = `${keyName}${t('- 用量详情')}`;
    const container = document.getElementById('keyUsageContent');
    setHTML(container, pageLoadingHtml(t('加载中...'), { compact: true }));
    this.showModal('keyUsageModal');

    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/usage`);
      if (!res.ok) { setHTML(container, '<p style="color:var(--destructive);text-align:center;padding:20px;">' + t('加载失败') + '</p>'); return; }
      const usage = await res.json();
      if (!Array.isArray(usage) || usage.length === 0) {
        setHTML(container, '<p style="text-align:center;color:var(--muted-foreground);padding:20px;">' + t('暂无使用记录') + '</p>');
        return;
      }

      const byDate = {};
      usage.forEach(u => {
        if (!byDate[u.date]) byDate[u.date] = { tokens: 0, cost: 0, requests: 0, models: {} };
        byDate[u.date].tokens += parseInt(u.tokens) || 0;
        byDate[u.date].cost += parseFloat(u.cost) || 0;
        byDate[u.date].requests += parseInt(u.requests) || 0;
        const modelName = u.model_name || t('(已删除)');
        byDate[u.date].models[modelName] = (byDate[u.date].models[modelName] || 0) + parseInt(u.requests);
      });

      setHTML(container, `
        <table class="usage-detail-table">
          <thead>
            <tr><th>日期</th><th>请求数</th><th>Token</th><th>费用</th><th>模型分布</th></tr>
          </thead>
          <tbody>
            ${Object.entries(byDate).map(([date, d]) => `
              <tr>
                <td>${new Date(date).toLocaleDateString('zh-CN')}</td>
                <td>${d.requests}</td>
                <td title="${d.tokens.toLocaleString()}">${this._formatBigNumber(d.tokens)}</td>
                <td>${Number(d.cost).toFixed(4)}</td>
                <td>${Object.entries(d.models).map(([m, c]) => `<span class="model-tag">${m} (${c})</span>`).join(' ')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `);
    } catch (error) {
      setHTML(container, '<p style="color:var(--destructive);">' + t('加载失败') + '</p>');
    }
  }

  async loadDocsModels() {
    try {
      const res = await fetch('/api/user/models');
      if (!res.ok) return;
      const models = await res.json();
      if (!Array.isArray(models)) return;
      setHTML(document.getElementById('docsModelsList'), `
        <table class="docs-table">
          <thead><tr><th>模型名称</th><th>服务商</th><th>输入价/百万Token</th><th>输出价/百万Token</th></tr></thead>
          <tbody>
            ${models.map(m => `
              <tr>
                <td><code>${escapeHtml(m.alias || m.upstream_model_id || m.name || m.id)}</code></td>
                <td>${escapeHtml(m.provider_name || m.provider || '-')}</td>
                <td>¥${Number(m.input_price_per_1k_tokens || 0).toFixed(4)}</td>
                <td>¥${Number(m.output_price_per_1k_tokens || 0).toFixed(4)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `);
    } catch (error) {
      console.error(t('加载文档模型列表失败:'), error);
    }
  }

  async loadProjectWorkStats() {
    const range = document.getElementById('projectWorkTimeRange')?.value || document.getElementById('statsTimeRange')?.value || '30';
    const source = document.getElementById('projectWorkSourceFilter')?.value || document.getElementById('statsSourceFilter')?.value || '';
    const statusEl = document.getElementById('projectWorkStatus');
    const summaryEl = document.getElementById('projectWorkSummary');
    const recentEl = document.getElementById('projectWorkRecent');
    const projectsEl = document.getElementById('projectWorkProjects');
    [summaryEl, recentEl, projectsEl].forEach((el) => { if (el) setHTML(el, '<div class="project-work-loading">' + t('正在读取项目活动...') + '</div>'); });
    try {
      const params = new URLSearchParams();
      if (range === 'custom') {
        const start = document.getElementById('projectWorkStartDate')?.value || document.getElementById('statsStartDate')?.value || '';
        const end = document.getElementById('projectWorkEndDate')?.value || document.getElementById('statsEndDate')?.value || '';
        if (!start || !end) return;
        params.set('start', start);
        params.set('end', end);
      } else {
        params.set('days', range);
      }
      if (source) params.set('request_source', source);
      const res = await fetch(`/api/user/project-stats?${params}`);
      if (!res.ok) throw new Error(t('项目工作统计加载失败'));
      const data = await res.json();
      const summary = data.summary || {};
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const fmt = (value) => Number(value || 0).toLocaleString();
      const fmtTok = (value) => { const n = Number(value || 0); return `<span title="${n.toLocaleString()}">${this._formatBigNumber(n)}</span>`; };
      const money = (value) => Number(value || 0).toFixed(2);
      const date = (value) => value ? new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '-';
      const status = summary.analysis_status || {};
      if (statusEl) statusEl.textContent = status.pending_requests ? `${t('后台还有')}${fmt(status.pending_requests)}${t('条记录待整理')}` : `${t('已同步 · 最近更新')}${date(status.last_scanned_at)}`;
        if (!projects.length) {
        const empty = '<div class="project-work-empty"><strong>' + t('还没有项目活动') + '</strong><span>' + t('当你的 Harness 请求包含工作区信息后，这里会自动形成项目工作记录。') + '</span></div>';
        [summaryEl, recentEl, projectsEl].forEach((el) => { if (el) setHTML(el, empty); });
        return;
      }
      const cards = [
        [t('活跃项目'), fmt(summary.projects), t('个工作区')],
        [t('活跃天数'), fmt(summary.active_days), t('天')],
        [t('AI 请求'), fmt(summary.requests), t('次调用')],
        ['Token', fmtTok(summary.tokens), t('总投入')],
        [t('最近活动'), date(summary.last_activity), t('最后一次工作')],
      ];
      setHTML(summaryEl, cards.map(([label, value, sub]) => `<div class="project-work-stat"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`).join(''));
      setHTML(recentEl, projects.slice(0, 4).map((p, i) => `<button class="project-work-recent-item" type="button" onclick="app.copyProjectPath(${JSON.stringify(p.workspace_path)})"><span class="project-work-rank">0${i + 1}</span><span class="project-work-recent-main"><strong>${escapeHtml(this.projectDisplayName(p.workspace_path))}</strong><small>${fmt(p.requests)}${t('次 ·')}${fmtTok(p.tokens)}${t('Token · 最近')}${date(p.last_activity)}</small></span><span class="project-work-arrow">→</span></button>`).join(''));
      setHTML(projectsEl, projects.map((p) => `<article class="project-work-project-card"><div class="project-work-project-top"><div class="project-work-project-icon">${escapeHtml(this.projectProjectMark(p.workspace_path))}</div><div class="project-work-project-title"><h4>${escapeHtml(this.projectDisplayName(p.workspace_path))}</h4><button type="button" onclick="app.copyProjectPath(${JSON.stringify(p.workspace_path)}${t(')" title="' + t('复制工作区路径') + '">')}${escapeHtml(p.workspace_path)}${'</button></div></div><div class="project-work-project-metrics"><div><span>' + t('请求')}</span><strong>${fmt(p.requests)}</strong></div><div><span>Token</span><strong>${fmtTok(p.tokens)}${'</strong></div><div><span>' + t('活跃')}</span><strong>${fmt(p.active_days)}${t('天')}</strong></div><div><span>最近</span><strong>${date(p.last_activity)}</strong></div></div><div class="project-work-project-footer"><span>${Object.keys(p.sources || {}).map(escapeHtml).join(' · ') || t('未标记客户端')}</span><span>${money(p.cost)}${t('积分')}</span></div></article>`).join(''));
      if (typeof Chart !== 'undefined') this._upsertChart('_userProjectDailyChart', document.getElementById('userProjectDailyChart'), 'line', { labels: (data.daily || []).map(r => r.date), datasets: [{ label: t('AI 请求'), data: (data.daily || []).map(r => r.requests), borderColor: readCssVar('--chart-6', '#0f766e'), backgroundColor: 'rgba(15,118,110,.14)', fill: true, tension: .3 }, { label: t('活跃项目'), data: (data.daily || []).map(r => r.projects), borderColor: 'var(--warning)', backgroundColor: 'transparent', fill: false, tension: .3, yAxisID: 'projects' }] }, { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true }, projects: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } });
    } catch (error) {
      console.error(error);
      if (statusEl) statusEl.textContent = t('同步失败');
      const message = `<div class="project-work-empty project-work-error"><strong>${t('项目统计暂时不可用')}</strong><span>${escapeHtml(error.message)}</span></div>`;
      [summaryEl, recentEl, projectsEl].forEach((el) => { if (el) setHTML(el, message); });
    }
  }

  projectDisplayName(path) {
    const value = String(path || '').replace(/[\\/]+$/, '');
    return value.split(/[\\/]/).pop() || value || t('未命名项目');
  }

  projectProjectMark(path) {
    const name = this.projectDisplayName(path).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    return (name.slice(0, 2) || 'AI').toUpperCase();
  }

  async copyProjectPath(path) {
    try {
      await navigator.clipboard.writeText(String(path || ''));
      this.showToast(t('工作区路径已复制'), 'success');
    } catch (_) {
      this.showToast(t('复制失败，请手动选择路径'), 'error');
    }
  }

  async loadMessageStats() {
    const summaryEl = document.getElementById('userMessageStatsSummary');
    const blockEl = document.getElementById('userMessageStatsBlockTable');
    const sourceEl = document.getElementById('userMessageStatsSourceTable');
    const loading = pageLoadingHtml(t('正在读取项目活动...'), { compact: true });
    [summaryEl, blockEl, sourceEl].forEach((el) => { if (el) setHTML(el, loading); });
    try {
      const params = new URLSearchParams({ days: document.getElementById('statsTimeRange')?.value || '30' });
      const source = document.getElementById('statsSourceFilter')?.value || '';
      if (source) params.set('request_source', source);
      const res = await fetch(`/api/user/message-stats?${params}`);
      if (!res.ok) throw new Error(t('消息统计加载失败'));
      const data = await res.json();
      const s = data.summary || {};
      if (!data || data.error) throw new Error(data.error || t('消息统计返回数据为空'));
      if (!(data.by_workspace || []).length && !(data.daily || []).length) {
        const empty = '<div class="empty-state" style="padding:28px;text-align:center;color:var(--muted-foreground);">' + t('所选时间范围内暂无可分析的项目消息记录') + '</div>';
        [summaryEl, blockEl, sourceEl].forEach((el) => { if (el) setHTML(el, empty); });
        return;
      }
      const row = (label, value) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);">${label}</span><strong>${value}</strong></div>`;
      const analysisStatus = s.analysis_status || {};
      const pendingLabel = analysisStatus.pending_requests ? row(t('后台待分析'), analysisStatus.pending_requests.toLocaleString()) : '';
      const fmtTok = (v) => { const n = Number(v || 0); return `<span title="${n.toLocaleString()}">${this._formatBigNumber(n)}</span>`; };
      setHTML(document.getElementById('userMessageStatsSummary'), [row(t('活跃请求'), s.analyzed_requests || 0), row(t('项目数'), (data.by_workspace || []).length), row(t('活跃天数'), s.active_days || 0), row(t('日均请求'), Number(s.avg_daily_requests || 0).toFixed(1)), row(t('总 Token'), fmtTok(s.total_tokens)), row(t('Git 状态率'), `${((s.git_rate || 0) * 100).toFixed(1)}%`), pendingLabel].join(''));
      const table = (headers, rows) => `<div style="overflow:auto;"><table class="stats-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || ('<tr><td colspan="4" style="text-align:center;padding:18px;color:var(--muted-foreground);">' + t('暂无数据') + '</td></tr>')}</tbody></table></div>`;
      setHTML(document.getElementById('userMessageStatsBlockTable'), table([t('区块'), t('请求数'), t('出现次数')], (data.by_block || []).map(r => `<tr><td><code>${escapeHtml(r.block)}</code></td><td>${r.requests}</td><td>${r.occurrences}</td></tr>`).join('')));
      setHTML(document.getElementById('userMessageStatsSourceTable'), table(['Harness', t('请求数'), t('平均消息'), t('平均字符'), 'Token'], (data.by_source || []).map(r => { const n = Number(r.tokens || 0); return `<tr><td>${escapeHtml(r.request_source)}</td><td>${r.requests}</td><td>${(r.messages / Math.max(r.requests, 1)).toFixed(1)}</td><td>${Math.round(r.characters / Math.max(r.requests, 1)).toLocaleString()}</td><td title="${n.toLocaleString()}">${this._formatBigNumber(n)}</td></tr>`; }).join('')));
      if (typeof Chart !== 'undefined') this._upsertChart('_userMessageStatsDailyChart', document.getElementById('userMessageStatsDailyChart'), 'line', { labels: (data.daily || []).map(r => r.date), datasets: [{ label: t('请求数'), data: (data.daily || []).map(r => r.requests), borderColor: 'var(--info)', backgroundColor: 'rgba(59,130,246,.15)', fill: true, tension: .25 }, { label: 'Token', data: (data.daily || []).map(r => r.tokens), borderColor: 'var(--purple)', fill: false, tension: .25 }] }, { responsive: true, maintainAspectRatio: false });
    } catch (error) {
      console.error(error);
      setHTML(document.getElementById('userMessageStatsSummary'), `<p style="color:var(--destructive);">${escapeHtml(error.message)}</p>`);
    }
  }

  // ========== 统计信息 ==========
  _statsData = null;

  // 任务是否包含可展开的子代理明细：有子代理会话，或拆分出多个子节点时展开
  _taskTreeExpandable(tree) {
    const children = (tree.children || []);
    return children.some(c => c.subagent) || children.length > 1;
  }

  // 渲染任务树单棵；无子代理明细的任务渲染为不可展开的普通行
  _renderTaskTree(tree) {
    const totals = tree.totals || {};
    const rootName = String(tree.taskKey || '');
    const summary = `<span class="stats-insight-name" title="${escapeHtml(rootName)}">${escapeHtml(rootName.slice(0, 36))}</span>
      <span>${Number(totals.requests || 0).toLocaleString()} ${t('请求')} · ${this._formatBigNumber(Number(totals.tokens || 0))} Token</span>
      <span class="task-tree-label" title="${escapeHtml(String(tree.rootLabel || ''))}">${escapeHtml(String(tree.rootLabel || '').slice(0, 40))}</span>`;
    if (!this._taskTreeExpandable(tree)) {
      return `<div class="stats-insight-item" style="padding:12px 0;border-bottom:1px solid var(--border);">${summary}</div>`;
    }
    const childRows = (tree.children || []).map(c => `
      <div class="task-tree-child">
        <code title="${escapeHtml(c.sessionId)}">${escapeHtml(String(c.sessionId || '').slice(0, 24))}</code>
        ${c.subagent ? `<span class="task-tree-subagent">${escapeHtml(c.subagent)}</span>` : `<span class="task-tree-subagent muted">${t('主任务会话')}</span>`}
        <span>${Number(c.requestCount || 0).toLocaleString()} ${t('请求')}</span>
        <span title="${Number(c.totalTokens || 0).toLocaleString()}">${this._formatBigNumber(Number(c.totalTokens || 0))} Token</span>
      </div>`).join('');
    return `<details class="task-tree-root stats-insight-item" style="padding:12px 0;border-bottom:1px solid var(--border);">
      <summary>${summary}<span class="task-tree-chevron">▾</span></summary>
      <div class="task-tree-children">${childRows}</div>
    </details>`;
  }

  async loadTaskGroups() {
    const section = document.getElementById('taskGroupsSection');
    const list = document.getElementById('taskGroupsList');
    if (!section || !list) return;
    try {
      const res = await fetch(`/api/user/task-tree?days=${encodeURIComponent(document.getElementById('statsTimeRange')?.value || '30')}`);
      if (!res.ok) throw new Error(t('逻辑任务加载失败'));
      const data = await res.json();
      const trees = Array.isArray(data.taskTree) ? data.taskTree : [];
      section.style.display = trees.length ? 'block' : 'none';
      setHTML(list, trees.map(t => this._renderTaskTree(t)).join(''));
    } catch (error) { section.style.display = 'none'; console.warn(error); }
  }

  /** 实时活动看板：各客户端 hook 上报的最近事件（30s 轮询） */
  async loadLiveActivity() {
    const wrap = document.getElementById('liveActivitySection');
    if (!wrap) return;
    try {
      const res = await fetch('/api/client-events/live?window=300');
      if (!res.ok) throw new Error('live activity failed');
      const data = await res.json();
      const sources = Array.isArray(data.sources) ? data.sources : [];
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      // 无任何数据（还没客户端上报过）就隐藏整块
      const totalEvents = sources.reduce((a, s) => a + (Number(s.total_events) || 0), 0);
      if (totalEvents === 0) {
        wrap.style.display = 'none';
        return;
      }
      wrap.style.display = '';
      const byHarness = {};
      sources.forEach((s) => { byHarness[s.harness] = s; });
      const rows = this._libraryHarnessList()
        .filter((h) => byHarness[h.id])
        .map((h) => {
          const s = byHarness[h.id];
          const meta = this._usageRequestSourceMeta(h.id);
          const last = s.last_event_at ? this.formatRelativeTime(s.last_event_at) : '-';
          return `<div class="live-activity-row">
            <span class="live-activity-harness">${this._harnessIconHtml(h.id, 16)} ${escapeHtml(meta.label)}</span>
            <span class="live-activity-num" title="${Number(s.active_sessions) || 0} ${t('个活跃会话')}">${this._formatBigNumber(Number(s.active_sessions) || 0)} ${t('个活跃会话')}</span>
            <span class="live-activity-num" title="${Number(s.tool_calls) || 0} ${t('次工具调用')} / 5 ${t('分钟')}">${this._formatBigNumber(Number(s.tool_calls) || 0)} ${t('次工具调用')}</span>
            <span class="live-activity-last">${escapeHtml(last)}</span>
          </div>`;
        });
      const sessLines = sessions.slice(0, 8).map((sess) => {
        const meta = this._usageRequestSourceMeta(sess.harness);
        const dir = (sess.cwd || '').split('/').filter(Boolean).pop() || sess.cwd || '-';
        const when = sess.ts ? this.formatRelativeTime(sess.ts) : '-';
        return `<div class="live-activity-sess">
          <span class="live-activity-harness">${this._harnessIconHtml(sess.harness, 14)} ${escapeHtml(meta.label)}</span>
          <span class="live-activity-cwd" title="${escapeHtml(sess.cwd || '')}">${escapeHtml(dir)}</span>
          ${sess.tool_name ? `<span class="live-activity-tool">${escapeHtml(sess.tool_name)}</span>` : ''}
          <span class="live-activity-last">${escapeHtml(when)}</span>
        </div>`;
      });
      setHTML(document.getElementById('liveActivityRows'), rows.join(''));
      setHTML(document.getElementById('liveActivitySessions'),
        sessLines.join('') || `<div class="live-activity-empty">${t('最近 5 分钟没有活跃会话')}</div>`);
    } catch (_e) {
      // 看板加载失败不打扰主流程，静默保留旧内容
    }
  }

  async loadStats() {
    const rangeSelect = document.getElementById('statsTimeRange');
    const customRange = document.getElementById('statsCustomDateRange');
    const range = rangeSelect.value;
    if (customRange) customRange.style.display = range === 'custom' ? 'flex' : 'none';

    // 加载筛选选项（仅首次）
    if (!this._statsFiltersLoaded) {
      await this._loadStatsFilters();
    }

    const modelId = document.getElementById('statsModelFilter')?.value || '';
    const providerId = document.getElementById('statsProviderFilter')?.value || '';
    const teamId = document.getElementById('statsTeamFilter')?.value || '';
    const sourceId = document.getElementById('statsSourceFilter')?.value || '';
    const filterParams = [
      modelId && `model_id=${encodeURIComponent(modelId)}`,
      providerId && `provider_id=${encodeURIComponent(providerId)}`,
      teamId && `team_id=${encodeURIComponent(teamId)}`,
      sourceId && `request_source=${encodeURIComponent(sourceId)}`
    ].filter(Boolean).join('&');

    if (range === 'custom') {
      customRange.style.display = 'flex';
      const start = document.getElementById('statsStartDate').value;
      const end = document.getElementById('statsEndDate').value;
      if (!start || !end) return;
      await this._fetchStats(`start=${start}&end=${end}${filterParams ? '&' + filterParams : ''}`);
    } else {
      customRange.style.display = 'none';
      await this._fetchStats(`days=${range}${filterParams ? '&' + filterParams : ''}`);
    }
  }

  async _loadStatsFilters() {
    try {
      const res = await fetch('/api/user/stats/filters');
      if (!res.ok) return;
      const data = await res.json();

      const modelSelect = document.getElementById('statsModelFilter');
      const providerSelect = document.getElementById('statsProviderFilter');
      const teamSelect = document.getElementById('statsTeamFilter');

      if (modelSelect && data.models) {
        setHTML(modelSelect, '<option value="">' + t('全部模型') + '</option>' +
          data.models.map(m => `<option value="${escapeHtml(m.model_id)}">${escapeHtml(m.name)}</option>`).join(''));
      }
      if (providerSelect && data.providers) {
        setHTML(providerSelect, '<option value="">' + t('全部供应商') + '</option>' +
          data.providers.map(p => `<option value="${escapeHtml(p.provider_id)}">${escapeHtml(p.name)}</option>`).join(''));
      }
      if (teamSelect && data.teams) {
        setHTML(teamSelect, '<option value="">' + t('全部 Team') + '</option>' +
          data.teams.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join(''));
      }

      this._statsFiltersLoaded = true;
    } catch (e) {
      console.error(t('加载统计筛选选项失败:'), e);
    }
  }

  resetStatsFilters() {
    document.getElementById('statsTimeRange').value = '30';
    document.getElementById('statsModelFilter').value = '';
    document.getElementById('statsProviderFilter').value = '';
    document.getElementById('statsTeamFilter').value = '';
    const sourceEl = document.getElementById('statsSourceFilter');
    if (sourceEl) sourceEl.value = '';
    document.getElementById('statsCustomDateRange').style.display = 'none';
    this.loadStats();
  }

  filterStatsBySource(sourceId) {
    const el = document.getElementById('statsSourceFilter');
    if (el) el.value = sourceId || '';
    this.loadStats();
  }

  jumpToUsageLogsBySource(sourceId) {
    const statsSource = document.getElementById('statsSourceFilter');
    if (statsSource) statsSource.value = sourceId || '';
    const logSource = document.getElementById('usageLogRequestSourceFilter');
    if (logSource) logSource.value = sourceId || '';
    this.switchStatsTab('logs');
    this.loadUsageLogs(1);
  }

  async loadLeaderboard() {
    try {
      const days = document.getElementById('leaderboardTimeRange').value;
      const sort = document.getElementById('leaderboardSort').value;
      const res = await fetch(`/api/user/leaderboard?days=${days}&sort=${sort}`);
      if (!res.ok) return;
      const data = await res.json();
      this._renderLeaderboard(data);
    } catch (error) {
      console.error(t('加载排行榜失败:'), error);
      const container = document.getElementById('leaderboardContent');
      if (container) {
        setHTML(container, '<div class="empty-state"><p style="color:var(--destructive);">' + t('加载失败，请稍后重试') + '</p></div>');
      }
    }
  }

  _renderLeaderboard(data) {
    const container = document.getElementById('leaderboardContent');
    if (!container) return;

    if (!data.leaderboard || data.leaderboard.length === 0) {
      setHTML(container, '<div class="empty-state"><p>' + t('暂无排行数据') + '</p></div>');
      return;
    }

    const rows = data.leaderboard.map(u => {
      const rank = u.rank;
      const isCurrent = u.isCurrentUser;
      const cacheRate = u.cacheHitRate !== undefined && u.cacheHitRate !== null
        ? u.cacheHitRate.toFixed(1) : '0.0';

      // 生成排名徽章
      let rankHtml;
      if (rank === 1) {
        rankHtml = '<span class="rank-badge rank-1">🥇</span>';
      } else if (rank === 2) {
        rankHtml = '<span class="rank-badge rank-2">🥈</span>';
      } else if (rank === 3) {
        rankHtml = '<span class="rank-badge rank-3">🥉</span>';
      } else {
        rankHtml = `<span class="rank-num">${rank}</span>`;
      }

      // 用户头像
      const avatarHtml = u.avatar
        ? `<img src="${escapeHtml(u.avatar)}" class="leaderboard-avatar" onerror="this.style.display='none'">`
        : `<div class="leaderboard-avatar-placeholder">${escapeHtml((u.username || '?').charAt(0).toUpperCase())}</div>`;

      return `<tr class="${isCurrent ? 'leaderboard-current-row' : ''}">
        <td class="leaderboard-rank-cell">${rankHtml}</td>
        <td>
          <div class="leaderboard-user-cell">
            ${avatarHtml}
            <span class="leaderboard-username">${escapeHtml(u.username)}</span>
            ${isCurrent ? '<span class="badge badge-info" style="margin-left:6px;font-size:11px;">' + t('我') + '</span>' : ''}
          </div>
        </td>
        <td class="leaderboard-stat-cell">${u.totalRequests.toLocaleString()}</td>
        <td class="leaderboard-stat-cell">${this._formatBigNumber(u.totalTokens)}</td>
        <td class="leaderboard-stat-cell">${u.totalPoints.toFixed(2)}</td>
        <td class="leaderboard-stat-cell">${cacheRate}%</td>
        <td class="leaderboard-stat-cell">${u.balance.toFixed(2)}</td>
      </tr>`;
    }).join('');

    setHTML(container, `
      <div class="table-wrapper">
        <table class="table leaderboard-table">
          <thead>
            <tr>
              <th style="width:60px;text-align:center;">排名</th>
              <th>用户</th>
              <th style="text-align:right;">请求数</th>
              <th style="text-align:right;">Token 数</th>
              <th style="text-align:right;">消耗积分</th>
              <th style="text-align:right;">缓存命中率</th>
              <th style="text-align:right;">当前余额</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="leaderboard-footer">
        共 ${data.totalUsers} 名活跃用户
        ${data.currentUserRank > 0 ? `${t('· 您的排名：第 ')}<strong>${data.currentUserRank}${'</strong>' + t('名')}` : ''}
      </div>
    `);
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

  // ==================== 模型测试 ====================

  toggleTestDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('modelTestDropdownMenu');
    if (!menu) return;
    const isVisible = menu.style.display === 'block';
    menu.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      const close = (e) => {
        const dropdown = document.getElementById('modelTestDropdown');
        if (dropdown && !dropdown.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  closeModelTestModal() {
    document.getElementById('modelTestModal').style.display = 'none';
  }

  async testModel(modelId, buttonEl) {
    if (!modelId) { alert(t('模型 ID 为空，请刷新重试')); return; }

    if (!await this._confirmTest()) return;

    if (buttonEl) {
      buttonEl.disabled = true;
      setHTML(buttonEl, loadingSpinnerHtml('sm'));
    }

    try {
      const res = await fetch(`/api/user/models/${modelId}/test`, { method: 'POST' });
      const data = await res.json();
      this._updateModelTestResult(modelId, data);
      this._showModelTestResult(modelId, data);
    } catch (e) {
      this._showModelTestResult(modelId, { ok: false, error: e.message || t('请求失败') });
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        setHTML(buttonEl, '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> 测试');
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

  _formatTestTps(value) {
    if (value == null || value === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const rounded = Math.round(num * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  _renderTestCapsule(model) {
    if (!model) return '';
    const testOk = model.current_model_test_ok;
    const latency = model.current_model_test_latency_ms;
    const tps = model.current_model_test_tokens_per_second;
    const testedAt = model.current_model_test_tested_at;
    if (testOk === true) {
      const tpsText = this._formatTestTps(tps);
      const title = testedAt ? this._formatTestTooltip(testedAt) : '';
      return `<span class="test-capsule pass"${title ? ` title="${escapeHtml(title)}"` : ''}>${latency != null ? latency + 'ms' : ''}${tpsText ? ` · ${tpsText} t/s` : ''}</span>`;
    }
    if (testOk === false) {
      const title = testedAt ? this._formatTestTooltip(testedAt) : '';
      return `<span class="test-capsule fail"${title ? ` title="${escapeHtml(title)}"` : ''}>${t('测试失败')}</span>`;
    }
    return '';
  }

  _averageMetric(values) {
    const nums = values.map(v => Number(v)).filter(v => Number.isFinite(v));
    if (nums.length === 0) return null;
    return nums.reduce((sum, v) => sum + v, 0) / nums.length;
  }

  _computeProviderTestSummary(provider) {
    if (!provider) return { total: 0, tested: 0, success: 0, failed: 0, untested: 0, avg_latency_ms: null, avg_tokens_per_second: null, latest_tested_at: null };

    if (provider.models_loaded && Array.isArray(provider.models)) {
      const models = provider.models;
      const testedModels = models.filter(m => m.test_ok === true || m.test_ok === false);
      const successModels = testedModels.filter(m => m.test_ok === true);
      const failedModels = testedModels.filter(m => m.test_ok === false);
      const latestTestedAt = testedModels
        .map(m => m.test_tested_at)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
      const avgLatency = this._averageMetric(successModels.map(m => m.test_latency_ms));
      const avgTps = this._averageMetric(successModels.map(m => m.test_tokens_per_second));
      const summary = {
        total: models.length,
        tested: testedModels.length,
        success: successModels.length,
        failed: failedModels.length,
        untested: Math.max(models.length - testedModels.length, 0),
        avg_latency_ms: avgLatency == null ? null : Math.round(avgLatency),
        avg_tokens_per_second: avgTps == null ? null : Math.round(avgTps * 10) / 10,
        latest_tested_at: latestTestedAt
      };
      provider.test_summary = summary;
      return summary;
    }

    const summary = provider.test_summary || {};
    const total = Number(summary.total ?? provider.model_count ?? 0) || 0;
    const tested = Number(summary.tested ?? 0) || 0;
    const success = Number(summary.success ?? 0) || 0;
    const failed = Number(summary.failed ?? 0) || 0;
    return {
      total,
      tested,
      success,
      failed,
      untested: Number(summary.untested ?? Math.max(total - tested, 0)) || 0,
      avg_latency_ms: summary.avg_latency_ms == null ? null : Number(summary.avg_latency_ms),
      avg_tokens_per_second: summary.avg_tokens_per_second == null ? null : Number(summary.avg_tokens_per_second),
      latest_tested_at: summary.latest_tested_at || null
    };
  }

  _formatProviderTestSummary(summary) {
    const total = Number(summary?.total || 0);
    const tested = Number(summary?.tested || 0);
    const success = Number(summary?.success || 0);
    const failed = Number(summary?.failed || 0);
    const untested = Math.max(Number(summary?.untested ?? (total - tested)) || 0, 0);

    if (tested === 0) {
      return {
        text: t('未测试'),
        className: 'untested',
        title: total > 0 ? `${t('共')}${total}${t('个模型，暂无测试结果')}` : t('暂无模型')
      };
    }

    let text;
    let className = 'mixed';
    if (success > 0 && failed === 0 && untested === 0) {
      text = t('全部成功');
      className = 'pass';
    } else if (success === 0 && failed > 0 && untested === 0) {
      text = t('全部失败');
      className = 'fail';
    } else {
      const parts = [];
      if (success > 0) parts.push(`${success}${t('个成功')}`);
      if (failed > 0) parts.push(`${failed}${t('个失败')}`);
      if (untested > 0) parts.push(`${untested}${t('个未测试')}`);
      text = parts.join('，') || t('未测试');
      className = success > 0 ? 'mixed' : 'fail';
    }

    const metricParts = [];
    if (success > 0 && Number.isFinite(Number(summary.avg_latency_ms))) {
      metricParts.push(`${t('平均')}${Math.round(Number(summary.avg_latency_ms))}ms`);
    }
    const tpsText = success > 0 ? this._formatTestTps(summary.avg_tokens_per_second) : null;
    if (tpsText) metricParts.push(`${tpsText} t/s`);
    if (metricParts.length > 0) text += ` - ${metricParts.join(' - ')}`;

    const titleParts = [`${t('共')}${total}${t('个模型')}`, `${t('已测试')}${tested}${t('个')}`, `${t('成功')}${success}${t('个')}`, `${t('失败')}${failed}${t('个')}`];
    if (untested > 0) titleParts.push(`${t('未测试')}${untested}${t('个')}`);
    const testedAtText = this._formatTestTooltip(summary.latest_tested_at);
    if (testedAtText) titleParts.push(testedAtText);
    return { text, className, title: titleParts.join('，') };
  }

  _renderProviderTestSummary(provider) {
    const summary = this._computeProviderTestSummary(provider);
    const formatted = this._formatProviderTestSummary(summary);
    return `<span class="provider-test-summary ${formatted.className}" title="${escapeHtml(formatted.title)}">${escapeHtml(formatted.text)}</span>`;
  }

  _refreshProviderTestSummary(team, provider) {
    if (!team || !provider) return;
    const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(provider.provider_id))}"]`);
    const summaryEl = providerEl?.querySelector('.provider-test-summary');
    if (!summaryEl) return;
    const summary = this._computeProviderTestSummary(provider);
    const formatted = this._formatProviderTestSummary(summary);
    summaryEl.className = `provider-test-summary ${formatted.className}`;
    summaryEl.title = formatted.title;
    summaryEl.textContent = formatted.text;
  }

  _updateModelTestResult(modelId, result, options = {}) {
    if (!this._libraryData) return;
    const refreshLists = options.refreshLists !== false;
    const affectedProviders = [];
    for (const team of this._libraryData.teams || []) {
      for (const provider of team.providers || []) {
        const model = (provider.models || []).find(m => m.model_id === modelId);
        if (model) {
          model.test_ok = result.ok;
          model.test_latency_ms = result.latency_ms ?? null;
          model.test_tokens_per_second = result.tokens_per_second ?? null;
          model.test_total_tokens = result.total_tokens ?? null;
          model.test_error = result.error || null;
          model.test_tested_at = new Date().toISOString();
          affectedProviders.push({ team, provider });
        }
      }
    }

    for (const { team, provider } of affectedProviders) {
      provider.test_summary = this._computeProviderTestSummary(provider);
      this._refreshProviderTestSummary(team, provider);
    }

    if (refreshLists && affectedProviders.length > 0) {
      // 仅刷新已展开的 DOM，避免触发整库重渲染/重载
      this._refreshExpandedProviderLists();
    }
  }

  async testAllModels() {
    this._closeTestDropdown();
    // 测试全部需要先加载所有供应商的模型明细
    await this._ensureAllProviderModelsLoaded();
    const modelIds = [];
    if (this._libraryData) {
      for (const team of this._libraryData.teams || []) {
        for (const provider of team.providers || []) {
          for (const model of provider.models || []) {
            if (model.model_id) modelIds.push(model.model_id);
          }
        }
      }
    }
    if (modelIds.length === 0) { alert(t('暂无可测试的模型')); return; }
    await this._runBatchTest(modelIds, `${t('正在测试全部')}${modelIds.length}${t('个模型...')}`);
  }

  async testAllCurrentTeamModels() {
    this._closeTestDropdown();
    if (!this._libraryData || !this._libraryData.teams || this._libraryData.teams.length === 0) return;
    const firstTeam = this._libraryData.teams[0];
    // 先加载该 Team 下所有供应商的模型明细
    await this._ensureTeamProviderModelsLoaded(firstTeam);
    const modelIds = [];
    for (const provider of firstTeam.providers || []) {
      for (const model of provider.models || []) {
        if (model.model_id) modelIds.push(model.model_id);
      }
    }
    if (modelIds.length === 0) { alert(t('当前 Team 无可测试的模型')); return; }
    await this._runBatchTest(modelIds, `${t('正在测试当前 Team')}${modelIds.length}${t('个模型...')}`);
  }

  async testAllCurrentProviderModels() {
    this._closeTestDropdown();
    const providerFilter = document.getElementById('libraryProviderFilter');
    const selectedProvider = providerFilter ? providerFilter.value : 'all';
    // 若选定具体供应商但模型明细未加载，先加载
    if (selectedProvider !== 'all') {
      await this._ensureProviderModelsLoadedByNameAndAwait(selectedProvider);
    }
    const modelIds = [];
    if (this._libraryData) {
      for (const team of this._libraryData.teams || []) {
        for (const provider of team.providers || []) {
          if (selectedProvider !== 'all' && provider.provider_id != selectedProvider) continue;
          for (const model of provider.models || []) {
            if (model.model_id) modelIds.push(model.model_id);
          }
        }
      }
    }
    if (modelIds.length === 0) { alert(t('当前供应商无可测试的模型')); return; }
    await this._runBatchTest(modelIds, `${t('正在测试')}${modelIds.length}${t('个模型...')}`);
  }

  // 按供应商名称查找并确保其模型明细已加载完成（await 版本，用于批量测试前置）
  async _ensureProviderModelsLoadedByNameAndAwait(providerName) {
    if (!this._libraryData) return;
    const tasks = [];
    for (const team of this._libraryData.teams || []) {
      for (const p of team.providers || []) {
        if (p.provider_name === providerName && !p.models_loaded) {
          const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(p.provider_id))}"]`);
          if (providerEl) {
            providerEl.classList.remove('collapsed');
            tasks.push(this._loadProviderModels(team, p, providerEl));
          }
        }
      }
    }
    if (tasks.length) await Promise.all(tasks);
  }

  async testTeamModels(teamId) {
    const team = (this._libraryData?.teams || []).find(t => t.team_id == teamId);
    if (!team) return;
    const modelIds = [];
    for (const provider of team.providers || []) {
      for (const model of provider.models || []) {
        if (model.model_id) modelIds.push(model.model_id);
      }
    }
    if (modelIds.length === 0) { alert(t('此 Team 下没有可测试的模型')); return; }
    await this._runBatchTest(modelIds, `${t('正在测试 Team「')}${escapeHtml(team.team_name)}」${modelIds.length}${t('个模型...')}`);
  }

  async testProviderModels(teamId, providerId) {
    const team = (this._libraryData?.teams || []).find(t => t.team_id == teamId);
    const provider = team?.providers?.find(p => p.provider_id == providerId);
    if (!provider) return;
    // 若该供应商模型明细尚未加载，先按需加载再测试
    if (!provider.models_loaded) {
      const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(teamId))}"][data-provider-id="${CSS.escape(String(providerId))}"]`);
      if (providerEl) {
        providerEl.classList.remove('collapsed');
        await this._loadProviderModels(team, provider, providerEl);
      }
    }
    const modelIds = [];
    for (const model of provider.models || []) {
      if (model.model_id) modelIds.push(model.model_id);
    }
    if (modelIds.length === 0) { alert(t('此供应商下没有可测试的模型')); return; }
    await this._runBatchTest(modelIds, `${t('正在测试供应商「')}${escapeHtml(provider.provider_name)}」${modelIds.length}${t('个模型...')}`);
  }

  _closeTestDropdown() {
    const menu = document.getElementById('modelTestDropdownMenu');
    if (menu) menu.style.display = 'none';
  }

  async _runBatchTest(modelIds, loadingMsg) {
    const modal = document.getElementById('modelTestModal');
    const body = document.getElementById('modelTestModalBody');
    modal.style.display = 'flex';
    setHTML(body, `
      <div style="text-align:center;padding:40px 20px;">
        <div style="display:inline-block;width:36px;height:36px;border:3px solid #222;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:20px;"></div>
        <p style="font-size:15px;color:var(--foreground);margin:0 0 8px;font-weight:500;">${loadingMsg}</p>
        <p style="font-size:13px;color:var(--muted-foreground);margin:0;" id="modelTestProgressCount">正在测试中...</p>
      </div>
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    `);

    const countEl = document.getElementById('modelTestProgressCount');

    try {
      const res = await fetch('/api/user/models/test-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds })
      });
      const data = await res.json();
      const results = data.results || [];

      for (const r of results) {
        if (r.modelId) this._updateModelTestResult(r.modelId, r, { refreshLists: false });
      }
      this._refreshExpandedProviderLists();
      this._renderTestResults(results, modelIds.length);
    } catch (e) {
      cancelAnimationFrame(animId);
      setHTML(body, `${'<div class="empty-state"><p style="color:var(--destructive);">' + t('测试失败:')}${escapeHtml(e.message)}</p></div>`);
    }
  }

  _showModelTestResult(modelId, result) {
    const modal = document.getElementById('modelTestModal');
    const body = document.getElementById('modelTestModalBody');
    const title = modal?.querySelector('.modal-header h3');
    if (title) title.textContent = `${t('测试结果 [')}${result.model || t('模型测试')}]`;
    modal.style.display = 'flex';
    this._renderTestResults([{ modelId, ...result }]);
  }

  _renderTestResults(results, totalCount) {
    const body = document.getElementById('modelTestModalBody');
    if (!body) return;

    totalCount = totalCount || results.length;
    const total = results.length;
    const passed = results.filter(r => r.ok).length;
    const failed = total - passed;
    const passPct = total > 0 ? Math.round(passed / total * 100) : 0;

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
          <div class="model-test-summary-label">/ ${totalCount}</div>
        </div>
      </div>
      <div class="model-test-summary-bar">
        <div class="model-test-summary-bar-fill" style="width:${passPct}%;${failed > 0 ? 'background:linear-gradient(90deg,var(--success),' + (passPct > 50 ? 'var(--status-warn)' : 'var(--destructive)') + ')' : ''}"></div>
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
                <div class="model-test-stat-value" title="${Number(r.total_tokens || 0).toLocaleString()}">${this._formatBigNumber(Number(r.total_tokens || 0))}</div>
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

  async _fetchStats(params) {
    const seq = (this._statsLoadSeq = (this._statsLoadSeq || 0) + 1);
    try {
      const res = await fetch(`/api/user/stats?${params}`);
      if (!res.ok) throw new Error(t('加载失败'));
      if (seq !== this._statsLoadSeq) return; // 丢弃过期响应
      this._statsData = await res.json();
      this._renderStatsOverview();
      this._renderOverviewInsights();
      this._renderDailyCharts();
      this._renderHourlyChart();
      this._renderModelCharts();
      this._renderApiKeyChart();
      this._renderSourceCharts();
      this._renderDailyTable();
      this._renderModelTable();
      this._renderApiKeyTable();
      this._renderSourceTable();
      this._renderSourceModelTable();
    } catch (error) {
      if (seq !== this._statsLoadSeq) return;
      console.error(t('加载统计数据失败:'), error);
    }
  }

  _renderStatsOverview() {
    const d = this._statsData;
    if (!d) return;
    const s = d.summary || {};
    const totalReqs = parseInt(s.total_requests || 0);
    const totalTokens = parseInt(s.total_tokens || 0);
    const totalPrompt = parseInt(s.total_prompt_tokens || 0);
    const totalCompletion = parseInt(s.total_completion_tokens || 0);
    const totalCached = parseInt(s.total_cached_tokens || 0);
    const totalCost = parseFloat(s.total_cost || 0);
    const avgLatency = parseFloat(s.avg_latency || 0);
    const days = d.daily ? d.daily.length : 1;

    document.getElementById('statsTotalRequests').textContent = totalReqs.toLocaleString();
    document.getElementById('statsTotalTokens').textContent = this._formatBigNumber(totalTokens);
    document.getElementById('statsTotalCost').textContent = totalCost.toFixed(4) + t(' 积分');
    document.getElementById('statsAvgLatency').textContent = Math.round(avgLatency) + 'ms';
    document.getElementById('statsAvgDailyRequests').textContent = t('日均 ') + Math.round(totalReqs / days).toLocaleString();
    document.getElementById('statsAvgDailyCost').textContent = t('日均 ') + (totalCost / days).toFixed(4) + t(' 积分');

    document.getElementById('statsTokenBreakdown').textContent = `${t('输入')}${this._formatBigNumber(totalPrompt)}${t('/ 输出')}${this._formatBigNumber(totalCompletion)}`;
    document.getElementById('statsAvgTokensPerReq').textContent = t('平均 ') + (totalReqs > 0 ? this._formatBigNumber(Math.round(totalTokens / totalReqs)) : 0) + t(' Token/请求');

    const identifiedRate = parseFloat(s.identified_rate != null ? s.identified_rate : (d.sourceSummary?.identified_rate || 0));
    const activeSources = parseInt(s.active_sources != null ? s.active_sources : (d.sourceSummary?.active_sources || 0), 10);
    const unknownReqs = parseInt(s.unknown_requests != null ? s.unknown_requests : (d.sourceSummary?.unknown_requests || 0), 10);
    const rateEl = document.getElementById('statsIdentifiedRate');
    const activeEl = document.getElementById('statsActiveSources');
    if (rateEl) rateEl.textContent = (identifiedRate * 100).toFixed(1) + '%';
    if (activeEl) {
      activeEl.textContent = `${t('活跃')}${activeSources}${t('种 · 未知')}${unknownReqs.toLocaleString()}${t('次')}`;
    }

    // 缓存命中率进度条
    const cacheSection = document.getElementById('cacheHitSection');
    if (totalCached > 0 || totalPrompt > 0) {
      const cacheHitRate = totalPrompt > 0 ? (totalCached / totalPrompt * 100) : 0;
      const savedTokens = totalCached; // 缓存命中的 token 本应按原价计费，命中后节省了 90%
      document.getElementById('cacheHitPercent').textContent = cacheHitRate.toFixed(1) + '%';
      document.getElementById('cacheHitBar').style.width = Math.min(cacheHitRate, 100) + '%';
      document.getElementById('cacheHitTokens').textContent = this._formatBigNumber(totalCached);
      document.getElementById('cacheTotalPrompt').textContent = this._formatBigNumber(totalPrompt);
      document.getElementById('cacheSavedTokens').textContent = this._formatBigNumber(savedTokens);
      cacheSection.style.display = 'block';
    } else {
      cacheSection.style.display = 'none';
    }

    // 与后端一致：按 Asia/Shanghai 日历日匹配「今日/昨日」
    const shParts = (date) => {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      });
      return fmt.format(date); // YYYY-MM-DD
    };
    const today = shParts(new Date());
    const yesterday = shParts(new Date(Date.now() - 86400000));
    const todayData = d.daily.find(r => r.date === today);
    const yesterdayData = d.daily.find(r => r.date === yesterday);

    document.getElementById('todayRequests').textContent = todayData ? parseInt(todayData.requests).toLocaleString() : '0';
    document.getElementById('todayTokens').textContent = todayData ? this._formatBigNumber(parseInt(todayData.tokens)) : '0';
    document.getElementById('todayCost').textContent = todayData ? parseFloat(todayData.cost).toFixed(4) + t(' 积分') : t('0 积分');
    document.getElementById('yesterdayRequests').textContent = yesterdayData ? parseInt(yesterdayData.requests).toLocaleString() : '0';
    document.getElementById('yesterdayTokens').textContent = yesterdayData ? this._formatBigNumber(parseInt(yesterdayData.tokens)) : '0';
    document.getElementById('yesterdayCost').textContent = yesterdayData ? parseFloat(yesterdayData.cost).toFixed(4) + t(' 积分') : t('0 积分');

    // 计算趋势
    this._renderTrend('todayRequestsTrend', todayData ? parseInt(todayData.requests) : 0, yesterdayData ? parseInt(yesterdayData.requests) : 0);
    this._renderTrend('todayTokensTrend', todayData ? parseInt(todayData.tokens) : 0, yesterdayData ? parseInt(yesterdayData.tokens) : 0);
    this._renderTrend('todayCostTrend', todayData ? parseFloat(todayData.cost) : 0, yesterdayData ? parseFloat(yesterdayData.cost) : 0);
  }

  _renderTrend(elementId, current, previous) {
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

  _renderOverviewInsights() {
    const d = this._statsData;
    if (!d) return;

    // 最常用模型 Top 3
    const topModelsContainer = document.getElementById('topModelsList');
    if (topModelsContainer && d.byModel && d.byModel.length > 0) {
      const top3 = d.byModel.slice(0, 3);
      setHTML(topModelsContainer, top3.map((m, i) => {
        const modelName = m.model_name || t('(已删除)');
        const requests = parseInt(m.requests || 0);
        const cost = parseFloat(m.cost || 0);
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
        return `<div class="stats-insight-item">
          <span class="stats-insight-rank">${medal}</span>
          <span class="stats-insight-name">${modelName}</span>
          <span class="stats-insight-value">${requests.toLocaleString()} 次</span>
        </div>`;
      }).join(''));
    }

    // 高峰时段
    const peakHoursContainer = document.getElementById('peakHoursList');
    if (peakHoursContainer && d.hourly && d.hourly.length > 0) {
      const sortedHours = [...d.hourly].sort((a, b) => parseInt(b.requests || 0) - parseInt(a.requests || 0));
      const top3Hours = sortedHours.slice(0, 3);
      setHTML(peakHoursContainer, top3Hours.map((h, i) => {
        const hour = parseInt(h.hour);
        const requests = parseInt(h.requests || 0);
        const timeRange = `${hour}:00 - ${hour + 1}:00`;
        return `<div class="stats-insight-item">
          <span class="stats-insight-rank">${i === 0 ? '🔥' : i === 1 ? '⚡' : '📊'}</span>
          <span class="stats-insight-name">${timeRange}</span>
          <span class="stats-insight-value">${requests.toLocaleString()} 次</span>
        </div>`;
      }).join(''));
    }

    // 客户端来源（有数据的全部列出 + 占比条）
    const topClientsContainer = document.getElementById('topClientsList');
    if (topClientsContainer) {
      const rows = (d.bySource || []).filter((s) => parseInt(s.requests || 0, 10) > 0);
      if (rows.length > 0) {
        const maxReq = Math.max(...rows.map((s) => parseInt(s.requests || 0, 10)), 1);
        setHTML(topClientsContainer, rows.map((s) => {
          const meta = this._usageRequestSourceMeta(s.request_source);
          const requests = parseInt(s.requests || 0, 10);
          const share = s.share_requests != null ? s.share_requests : (requests / maxReq);
          const pct = ((s.share_requests != null ? s.share_requests : requests / Math.max(parseInt(d.summary?.total_requests || 0, 10), 1)) * 100).toFixed(1);
          const barW = Math.max(4, Math.round((requests / maxReq) * 100));
          const sid = escapeHtml(String(s.request_source || 'unknown'));
          return `<div class="stats-insight-item" style="flex-direction:column;align-items:stretch;gap:4px;cursor:pointer;" onclick="app.filterStatsBySource('${sid}')" title="${t('点击筛选此客户端')}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span class="stats-insight-name">${this._usageRequestSourceBadge(s.request_source)}</span>
              <span class="stats-insight-value">${requests.toLocaleString()} · ${pct}%</span>
            </div>
            <div style="height:4px;background:var(--muted);border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${barW}%;background:${meta.color};border-radius:2px;"></div>
            </div>
          </div>`;
        }).join(''));
      } else {
        setHTML(topClientsContainer, '<div class="stats-insight-empty">' + t('暂无数据') + '</div>');
      }
    }

    // 插件维度（stats:record 写入的 plugin_meta 维度键）
    const topPluginsContainer = document.getElementById('topPluginsList');
    if (topPluginsContainer) {
      const rows = (d.byPlugin || []).filter((s) => parseInt(s.requests || 0, 10) > 0).slice(0, 5);
      if (rows.length > 0) {
        const maxReq = Math.max(...rows.map((s) => parseInt(s.requests || 0, 10)), 1);
        setHTML(topPluginsContainer, rows.map((s) => {
          const requests = parseInt(s.requests || 0, 10);
          const barW = Math.max(4, Math.round((requests / maxReq) * 100));
          const dim = escapeHtml(String(s.plugin_dim || 'plugin'));
          return `<div class="stats-insight-item" style="flex-direction:column;align-items:stretch;gap:4px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span class="stats-insight-name">🧩 ${dim}</span>
              <span class="stats-insight-value">${requests.toLocaleString()}</span>
            </div>
            <div style="height:4px;background:var(--muted);border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${barW}%;background:var(--cyan);border-radius:2px;"></div>
            </div>
          </div>`;
        }).join(''));
      } else {
        setHTML(topPluginsContainer, '<div class="stats-insight-empty">' + t('暂无数据') + '</div>');
      }
    }

    // 费用趋势（最近 7 天 vs 前 7 天）
    const costTrendContainer = document.getElementById('costTrendList');
    if (costTrendContainer && d.daily && d.daily.length >= 14) {
      const recent7 = d.daily.slice(-7);
      const prev7 = d.daily.slice(-14, -7);
      const recent7Cost = recent7.reduce((sum, r) => sum + parseFloat(r.cost || 0), 0);
      const prev7Cost = prev7.reduce((sum, r) => sum + parseFloat(r.cost || 0), 0);
      const change = prev7Cost > 0 ? ((recent7Cost - prev7Cost) / prev7Cost * 100).toFixed(1) : 0;
      const isUp = recent7Cost > prev7Cost;

      setHTML(costTrendContainer, `
        <div class="stats-insight-item">
          <span class="stats-insight-rank">💰</span>
          <span class="stats-insight-name">最近 7 天</span>
          <span class="stats-insight-value">${recent7Cost.toFixed(4)} 积分</span>
        </div>
        <div class="stats-insight-item">
          <span class="stats-insight-rank">📅</span>
          <span class="stats-insight-name">前 7 天</span>
          <span class="stats-insight-value">${prev7Cost.toFixed(4)} 积分</span>
        </div>
        <div class="stats-insight-item">
          <span class="stats-insight-rank">${isUp ? '📈' : '📉'}</span>
          <span class="stats-insight-name">环比变化</span>
          <span class="stats-insight-value ${isUp ? 'trend-up-text' : 'trend-down-text'}">${isUp ? '+' : ''}${change}%</span>
        </div>`);
    }

    // 关键指标
    const keyMetricsContainer = document.getElementById('keyMetricsList');
    if (keyMetricsContainer) {
      const s = d.summary || {};
      const totalReqs = parseInt(s.total_requests || 0);
      const totalTokens = parseInt(s.total_tokens || 0);
      const totalCost = parseFloat(s.total_cost || 0);
      const avgLatency = parseFloat(s.avg_latency || 0);
      const days = d.daily ? d.daily.length : 1;

      setHTML(keyMetricsContainer, `
        <div class="stats-insight-item">
          <span class="stats-insight-rank">📊</span>
          <span class="stats-insight-name">日均请求</span>
          <span class="stats-insight-value">${Math.round(totalReqs / days).toLocaleString()}</span>
        </div>
        <div class="stats-insight-item">
          <span class="stats-insight-rank">🎯</span>
          <span class="stats-insight-name">平均 Token/请求</span>
          <span class="stats-insight-value">${totalReqs > 0 ? this._formatBigNumber(Math.round(totalTokens / totalReqs)) : 0}</span>
        </div>
        <div class="stats-insight-item">
          <span class="stats-insight-rank">💵</span>
          <span class="stats-insight-name">日均积分</span>
          <span class="stats-insight-value">${(totalCost / days).toFixed(4)} 积分</span>
        </div>
        <div class="stats-insight-item">
          <span class="stats-insight-rank">⏱️</span>
          <span class="stats-insight-name">平均延迟</span>
          <span class="stats-insight-value">${Math.round(avgLatency)}ms</span>
        </div>`);
    }
  }

  _getChartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue('--muted-foreground').trim() || readCssVar('--text-muted-soft', '#94a3b8'),
      border: style.getPropertyValue('--border').trim() || 'rgba(148,163,184,0.1)'
    };
  }

  _destroyChart(name) {
    if (this[name]) { this[name].destroy(); this[name] = null; }
  }

  /**
   * 复用 Chart 实例更新数据，避免定时刷新时 destroy+new 从 0 重播动画。
   */
  _upsertChart(storeKey, canvasEl, type, data, options) {
    if (!canvasEl || typeof Chart === 'undefined') return null;
    const existing = this[storeKey];
    if (existing) {
      try {
        existing.data.labels = data.labels || [];
        const nextDatasets = data.datasets || [];
        while (existing.data.datasets.length < nextDatasets.length) {
          existing.data.datasets.push({ data: [] });
        }
        if (existing.data.datasets.length > nextDatasets.length) {
          existing.data.datasets.length = nextDatasets.length;
        }
        nextDatasets.forEach((ds, i) => {
          const cur = existing.data.datasets[i];
          Object.keys(ds).forEach(k => {
            cur[k] = ds[k];
          });
        });
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

  _lineChartOpts(yLabel) {
    const c = this._getChartColors();
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { ticks: { color: c.text, font: { size: 10 }, maxTicksLimit: 15 }, grid: { display: false } },
        y: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border }, title: { display: !!yLabel, text: yLabel || '', color: c.text } }
      },
      interaction: { mode: 'nearest', axis: 'x', intersect: false }
    };
  }

  _renderDailyCharts() {
    const d = this._statsData;
    if (!d || !d.daily || d.daily.length === 0 || typeof Chart === 'undefined') return;
    const rows = d.daily;
    const labels = rows.map(r => new Date(r.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }));
    const requests = rows.map(r => parseInt(r.requests || 0));
    const tokens = rows.map(r => parseInt(r.tokens || 0));
    const costs = rows.map(r => parseFloat(r.cost || 0));
    const latencies = rows.map(r => Math.round(parseFloat(r.avg_latency || 0)));

    this._upsertChart('_uDailyReqChart', document.getElementById('userDailyRequestsChart'), 'line', {
      labels, datasets: [{ label: t('请求数'), data: requests, borderColor: 'var(--info)', backgroundColor: 'rgba(59,130,246,0.15)', fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 6 }]
    }, this._lineChartOpts());

    this._upsertChart('_uDailyTokChart', document.getElementById('userDailyTokensChart'), 'line', {
      labels, datasets: [{ label: 'Token', data: tokens, borderColor: 'var(--purple)', backgroundColor: 'rgba(139,92,246,0.15)', fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 6 }]
    }, this._lineChartOpts());

    this._upsertChart('_uDailyCostChart', document.getElementById('userDailyCostChart'), 'line', {
      labels, datasets: [{ label: t('积分'), data: costs, borderColor: 'var(--success)', backgroundColor: 'rgba(16,185,129,0.15)', fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 6 }]
    }, this._lineChartOpts());

    this._upsertChart('_uDailyLatChart', document.getElementById('userDailyLatencyChart'), 'line', {
      labels, datasets: [{ label: t('延迟(ms)'), data: latencies, borderColor: 'var(--warning)', backgroundColor: 'rgba(245,158,11,0.15)', fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 6 }]
    }, this._lineChartOpts('ms'));
  }

  _renderHourlyChart() {
    const d = this._statsData;
    if (!d || !d.hourly || typeof Chart === 'undefined') return;
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const map = {};
    d.hourly.forEach(r => { map[r.hour] = r; });
    const labels = hours.map(h => `${h}:00`);
    const requests = hours.map(h => parseInt((map[h] || {}).requests || 0));
    const tokens = hours.map(h => parseInt((map[h] || {}).tokens || 0));
    const c = this._getChartColors();
    this._upsertChart('_uHourlyChart', document.getElementById('userHourlyChart'), 'bar', {
      labels,
      datasets: [
        { label: t('请求数'), data: requests, backgroundColor: 'rgba(59,130,246,0.7)', borderColor: 'var(--info)', borderWidth: 1, borderRadius: 4, yAxisID: 'y' },
        { label: 'Token', data: tokens, backgroundColor: 'rgba(139,92,246,0.5)', borderColor: 'var(--purple)', borderWidth: 1, borderRadius: 4, yAxisID: 'y1' }
      ]
    }, {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: c.text, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: c.text, font: { size: 10 } }, grid: { display: false } },
        y: { type: 'linear', position: 'left', ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border }, title: { display: true, text: t('请求数'), color: c.text } },
        y1: { type: 'linear', position: 'right', ticks: { color: c.text, font: { size: 10 } }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Token', color: c.text } }
      }
    });
  }

  _renderModelCharts() {
    const d = this._statsData;
    if (!d || !d.byModel || d.byModel.length === 0 || typeof Chart === 'undefined') return;
    const top = d.byModel.slice(0, 8);
    const labels = top.map(m => {
      return m.model_name || t('(已删除)');
    });
    const requests = top.map(m => parseInt(m.requests || 0));
    const costs = top.map(m => parseFloat(m.cost || 0));
    const colors = [readCssVar('--status-info', '#2563eb'), readCssVar('--chart-2', '#a855f7'), readCssVar('--status-success', '#16a34a'), readCssVar('--status-warn', '#d97706'), readCssVar('--status-danger', '#dc2626'), readCssVar('--cyan', '#06b6d4'), readCssVar('--pink', '#ec4899'), readCssVar('--chart-8', '#14b8a6')];
    const c = this._getChartColors();
    const doughnutOpts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: c.text, font: { size: 11 }, padding: 10, usePointStyle: true } } },
      cutout: '50%'
    };

    this._upsertChart('_uModelReqChart', document.getElementById('userModelRequestsChart'), 'doughnut', {
      labels, datasets: [{ data: requests, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOpts);

    this._upsertChart('_uModelCostChart', document.getElementById('userModelCostChart'), 'doughnut', {
      labels, datasets: [{ data: costs, backgroundColor: colors, borderWidth: 0 }]
    }, doughnutOpts);
  }

  _renderApiKeyChart() {
    const d = this._statsData;
    if (!d || !d.byApiKey || d.byApiKey.length === 0 || typeof Chart === 'undefined') return;
    const labels = d.byApiKey.map(k => k.key_name || k.key_prefix || 'Key');
    const requests = d.byApiKey.map(k => parseInt(k.requests || 0));
    const colors = [readCssVar('--status-info', '#2563eb'), readCssVar('--chart-2', '#a855f7'), readCssVar('--status-success', '#16a34a'), readCssVar('--status-warn', '#d97706'), readCssVar('--status-danger', '#dc2626'), readCssVar('--cyan', '#06b6d4'), readCssVar('--pink', '#ec4899'), readCssVar('--chart-8', '#14b8a6')];
    const c = this._getChartColors();

    this._upsertChart('_uApiKeyChart', document.getElementById('userApiKeyChart'), 'bar', {
      labels,
      datasets: [{ label: t('请求数'), data: requests, backgroundColor: colors.map(co => co + 'cc'), borderColor: colors, borderWidth: 1, borderRadius: 4 }]
    }, {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border } },
        y: { ticks: { color: c.text, font: { size: 11 } }, grid: { display: false } }
      }
    });
  }

  _renderDailyTable() {
    const d = this._statsData;
    const tbody = document.getElementById('statsDailyTableBody');
    if (!d || !d.daily || !tbody) return;
    setHTML(tbody, d.daily.map(r => {
      const promptTokens = parseInt(r.prompt_tokens || 0);
      const cachedTokens = parseInt(r.cached_tokens || 0);
      const cacheRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0.0';
      const cacheColor = cachedTokens > 0 ? 'var(--success)' : 'var(--muted-foreground)';
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid var(--border);">${new Date(r.date).toLocaleDateString('zh-CN')}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${parseInt(r.requests).toLocaleString()}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);" title="${promptTokens.toLocaleString()}">${this._formatBigNumber(promptTokens)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);" title="${parseInt(r.completion_tokens || 0).toLocaleString()}">${this._formatBigNumber(parseInt(r.completion_tokens || 0))}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);"><span style="color:${cacheColor};" title="${cachedTokens.toLocaleString()}">${this._formatBigNumber(cachedTokens)}</span> <span style="font-size:11px;color:var(--muted-foreground);">(${cacheRate}%)</span></td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${parseFloat(r.cost).toFixed(4)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${Math.round(parseFloat(r.avg_latency || 0))}ms</td>
      </tr>`;
    }).join(''));
  }

  _renderModelTable() {
    const d = this._statsData;
    const tbody = document.getElementById('statsModelTableBody');
    if (!d || !d.byModel || !tbody) return;
    setHTML(tbody, d.byModel.map(m => {
      const promptTokens = parseInt(m.prompt_tokens || 0);
      const cachedTokens = parseInt(m.cached_tokens || 0);
      const cacheRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0.0';
      const cacheColor = cachedTokens > 0 ? 'var(--success)' : 'var(--muted-foreground)';
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid var(--border);font-size:12px;">${m.model_name || t('(已删除)')}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${parseInt(m.requests).toLocaleString()}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);" title="${promptTokens.toLocaleString()}">${this._formatBigNumber(promptTokens)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);" title="${parseInt(m.completion_tokens || 0).toLocaleString()}">${this._formatBigNumber(parseInt(m.completion_tokens || 0))}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);"><span style="color:${cacheColor};" title="${cachedTokens.toLocaleString()}">${this._formatBigNumber(cachedTokens)}</span> <span style="font-size:11px;color:var(--muted-foreground);">(${cacheRate}%)</span></td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">¥${parseFloat(m.cost).toFixed(4)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${Math.round(parseFloat(m.avg_latency || 0))}ms</td>
      </tr>`;
    }).join(''));
  }

  _renderApiKeyTable() {
    const d = this._statsData;
    const tbody = document.getElementById('statsApiKeyTableBody');
    if (!d || !d.byApiKey || !tbody) return;
    setHTML(tbody, d.byApiKey.map(k => {
      const cachedTokens = parseInt(k.cached_tokens || 0);
      const kTokens = parseInt(k.tokens || 0);
      return `<tr>
      <td style="padding:8px;border-bottom:1px solid var(--border);">${k.key_name || 'API Key'}</td>
      <td style="padding:8px;border-bottom:1px solid var(--border);font-family:monospace;">${k.key_prefix || ''}****</td>
      <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${parseInt(k.requests).toLocaleString()}</td>
      <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);" title="${kTokens.toLocaleString()}">${this._formatBigNumber(kTokens)}</td>
      <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${cachedTokens > 0 ? '<span style="color:var(--success);" title="' + cachedTokens.toLocaleString() + '">' + this._formatBigNumber(cachedTokens) + '</span>' : '-'}</td>
      <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">¥${parseFloat(k.cost).toFixed(4)}</td>
    </tr>`;
    }).join(''));

    // 初始化表格排序
    this._initTableSort();
  }

  _renderSourceCharts() {
    const d = this._statsData;
    if (!d || typeof Chart === 'undefined') return;
    const rows = (d.bySource || []).filter((s) => parseInt(s.requests || 0, 10) > 0);
    const labels = rows.map((s) => this._usageRequestSourceMeta(s.request_source).label);
    const colors = rows.map((s) => this._usageRequestSourceMeta(s.request_source).color);
    const reqs = rows.map((s) => parseInt(s.requests || 0, 10));
    const costs = rows.map((s) => parseFloat(s.cost || 0));

    const pieOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed || 0;
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0) || 1;
              return `${ctx.label}: ${typeof v === 'number' && ctx.dataset.label === t('积分') ? v.toFixed(4) : v.toLocaleString()} (${((v / total) * 100).toFixed(1)}%)`;
            }
          }
        }
      }
    };

    const reqCanvas = document.getElementById('userSourceRequestsChart');
    if (reqCanvas) {
      if (rows.length === 0) {
        this._destroyChart('_userSourceReqChart');
      } else {
        this._upsertChart('_userSourceReqChart', reqCanvas, 'doughnut', {
          labels,
          datasets: [{ data: reqs, backgroundColor: colors, borderWidth: 0 }]
        }, pieOpts);
      }
    }
    const costCanvas = document.getElementById('userSourceCostChart');
    if (costCanvas) {
      if (rows.length === 0) {
        this._destroyChart('_userSourceCostChart');
      } else {
        this._upsertChart('_userSourceCostChart', costCanvas, 'doughnut', {
          labels,
          datasets: [{ label: t('积分'), data: costs, backgroundColor: colors, borderWidth: 0 }]
        }, pieOpts);
      }
    }

    // 每日按客户端堆叠
    const dailyCanvas = document.getElementById('userSourceDailyChart');
    if (dailyCanvas) {
      const series = d.dailyBySource || [];
      const dates = [...new Set(series.map((r) => r.date))].sort();
      const sourceIds = [...new Set(series.map((r) => r.request_source || 'unknown'))];
      if (dates.length === 0 || sourceIds.length === 0) {
        this._destroyChart('_userSourceDailyChart');
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
        const c = this._getChartColors();
        this._upsertChart('_userSourceDailyChart', dailyCanvas, 'line', {
          labels: dates,
          datasets
        }, {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
          scales: {
            x: { stacked: true, ticks: { color: c.text, font: { size: 10 }, maxTicksLimit: 12 }, grid: { display: false } },
            y: { stacked: true, ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border } }
          }
        });
      }
    }
  }

  _renderSourceTable() {
    const d = this._statsData;
    const tbody = document.getElementById('statsSourceTableBody');
    if (!tbody) return;
    if (!d || !d.bySource || d.bySource.length === 0) {
      setHTML(tbody, '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--muted-foreground);">' + t('暂无客户端数据') + '</td></tr>');
      return;
    }
    setHTML(tbody, d.bySource.map((s) => {
      const reqs = parseInt(s.requests || 0, 10);
      const share = ((s.share_requests || 0) * 100).toFixed(1);
      const sid = String(s.request_source || 'unknown');
      const latency = s.avg_latency != null ? `${Math.round(parseFloat(s.avg_latency))}ms` : '-';
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid var(--border);">${this._usageRequestSourceBadge(sid)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;">${reqs.toLocaleString()}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">
          <div style="display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;">
            <span style="font-variant-numeric:tabular-nums;">${share}%</span>
            <span style="display:inline-block;width:48px;height:4px;background:var(--muted);border-radius:2px;overflow:hidden;vertical-align:middle;">
              <span style="display:block;height:100%;width:${Math.min(100, share)}%;background:${this._usageRequestSourceMeta(sid).color};"></span>
            </span>
          </div>
        </td>
        ${(() => { const t = parseInt(s.tokens || 0, 10), p = parseInt(s.prompt_tokens || 0, 10), c = parseInt(s.completion_tokens || 0, 10), cc = parseInt(s.cached_tokens || 0, 10); return `
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;" title="${t.toLocaleString()}">${this._formatBigNumber(t)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;" title="${p.toLocaleString()}">${this._formatBigNumber(p)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;" title="${c.toLocaleString()}">${this._formatBigNumber(c)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;" title="${cc.toLocaleString()}">${this._formatBigNumber(cc)}</td>`; })()}
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;">${parseFloat(s.cost || 0).toFixed(4)}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);">${latency}</td>
        <td style="padding:8px;border-bottom:1px solid var(--border);white-space:nowrap;">
          <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;" onclick="app.filterStatsBySource('${escapeHtml(sid)}')">筛选</button>
          <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 8px;margin-left:4px;" onclick="app.jumpToUsageLogsBySource('${escapeHtml(sid)}')">记录</button>
        </td>
      </tr>`;
    }).join(''));
  }

  _renderSourceModelTable() {
    const d = this._statsData;
    const tbody = document.getElementById('statsSourceModelTableBody');
    if (!tbody) return;
    const rows = d?.bySourceModel || [];
    if (rows.length === 0) {
      setHTML(tbody, '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted-foreground);">' + t('暂无交叉数据') + '</td></tr>');
      return;
    }
    setHTML(tbody, rows.map((r) => {
      const modelLabel = r.model_name || r.model_id || t('(未知)');
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid var(--border);">${this._usageRequestSourceBadge(r.request_source)}</td>
        <td style="padding:8px;border-bottom:1px solid var(--border);">${escapeHtml(String(modelLabel))}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;">${parseInt(r.requests || 0, 10).toLocaleString()}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;" title="${parseInt(r.tokens || 0, 10).toLocaleString()}">${this._formatBigNumber(parseInt(r.tokens || 0, 10))}</td>
        <td style="text-align:right;padding:8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;">${parseFloat(r.cost || 0).toFixed(4)}</td>
      </tr>`;
    }).join(''));
  }

  _initTableSort() {
    document.querySelectorAll('.stats-table .sortable').forEach(th => {
      th.onclick = () => {
        const table = th.closest('table');
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const sortKey = th.dataset.sort;
        const colIndex = Array.from(th.parentNode.children).indexOf(th);
        const isAsc = th.classList.contains('sort-asc');

        // 移除其他列的排序状态
        table.querySelectorAll('.sortable').forEach(h => {
          h.classList.remove('sort-asc', 'sort-desc');
        });

        // 设置新的排序状态
        th.classList.add(isAsc ? 'sort-desc' : 'sort-asc');

        // 排序行
        rows.sort((a, b) => {
          let aVal = a.children[colIndex]?.textContent?.trim() || '';
          let bVal = b.children[colIndex]?.textContent?.trim() || '';

          // 尝试解析为数字
          const aNum = parseFloat(aVal.replace(/[¥,]/g, ''));
          const bNum = parseFloat(bVal.replace(/[¥,]/g, ''));

          if (!isNaN(aNum) && !isNaN(bNum)) {
            return isAsc ? bNum - aNum : aNum - bNum;
          }

          // 字符串排序
          return isAsc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
        });

        // 重新插入排序后的行
        rows.forEach(row => tbody.appendChild(row));
      };
    });
  }

  switchStatsTab(tab) {
    document.querySelectorAll('.stats-tab-bar button, .stats-tab').forEach(btn => {
      btn.classList.remove('active');
    });
    document.querySelectorAll('.stats-tab-content').forEach(c => { c.style.display = 'none'; });

    const activeBtn = document.querySelector(`.stats-tab-bar button[onclick*="${tab}"], .stats-tab[onclick*="${tab}"]`);
    if (activeBtn) {
      activeBtn.classList.add('active');
    }
    const tabContent = document.getElementById('statsTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (tabContent) tabContent.style.display = 'block';

    if (tab === 'messages') {
      this.loadMessageStats();
    }
    if (tab === 'logs') {
      this.loadUsageLogs(this.usageLogPage || 1);
    }
  }

  // ========== 调用记录 ==========
  usageLogPage = 1;
  usageLogTotal = 0;
  usageLogLimit = 50;
  _usageLogsCache = [];

  _usageRequestSourceMeta(source) {
    const s = String(source || 'unknown').toLowerCase();
    // 图标与 showcase / 客户端配置弹窗保持一致（img.bloret.net）
    const map = {
      grok: {
        label: 'Grok',
        color: 'var(--chart-2)',
        icon: 'https://img.bloret.net/img/1783646659585/b5f2e4758d401fa16e43dd9d58278c5c'
      },
      codex: {
        label: 'Codex',
        color: 'var(--success)',
        icon: 'https://img.bloret.net/img/1781951439833/5dd31c41da3d9ba8d8c63c41ba899d52'
      },
      claude_code: {
        label: 'Claude Code',
        color: 'var(--warning)',
        icon: 'https://img.bloret.net/img/1781951398824/8e0b0a829f4bc5d09a90eeaf37adccf1'
      },
      opencode: {
        label: 'OpenCode',
        color: 'var(--info)',
        icon: 'https://img.bloret.net/img/1781951398735/6d800bec66c4599b4f8e8e42bb9331d6'
      },
      qwen_code: {
        label: 'Qwen Code',
        color: 'var(--chart-2)',
        icon: 'https://img.bloret.net/img/1783300468869/0e65783456053817af53fe8e72836b5d'
      },
      hermes: {
        label: 'Hermes',
        color: 'var(--pink)',
        icon: 'https://img.bloret.net/img/1783300640677/085bcecf994f63347ce29dcdadffdb9f'
      },
      openclaw: {
        label: 'OpenClaw',
        color: 'var(--chart-1)',
        icon: 'https://img.bloret.net/img/1783300468566/b085d548a9a6683cc47d4dc104e93d7a'
      },
      deepseek_harness: {
        label: 'DeepSeek Harness',
        color: 'var(--brand-blue)',
        icon: 'https://img.bloret.net/img/1786632261665/ef60a8b9b5a3da93259ffb7b024fd80f'
      },
      unknown: { label: t('未知/其他'), color: 'var(--muted-foreground)', icon: '' }
    };
    return map[s] || map.unknown;
  }

  /** 可单独绑定模型的 harness 列表（与服务端 HARNESS_SOURCES 对齐） */
  _libraryHarnessList() {
    return [
      { id: 'claude_code', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'grok', label: 'Grok' },
      { id: 'opencode', label: 'OpenCode' },
      { id: 'qwen_code', label: 'Qwen Code' },
      { id: 'hermes', label: 'Hermes' },
      { id: 'openclaw', label: 'OpenClaw' },
      { id: 'deepseek_harness', label: 'DeepSeek Harness' },
    ];
  }

  _harnessLabel(harnessId) {
    if (!harnessId || harnessId === 'default') return t('全部工具（默认）');
    return this._usageRequestSourceMeta(harnessId).label;
  }

  /** harness 工具图标 HTML（showcase / 配置弹窗同款） */
  _harnessIconHtml(source, size = 14) {
    const meta = this._usageRequestSourceMeta(source);
    if (!meta.icon) {
      return `<span class="library-key-bubble-dot" style="background:${meta.color};width:${Math.max(6, size / 2)}px;height:${Math.max(6, size / 2)}px;"></span>`;
    }
    const s = Number(size) || 14;
    return `<img class="harness-tool-icon" src="${meta.icon}" alt="" width="${s}" height="${s}" loading="lazy" decoding="async">`;
  }

  _getKeyHarnessBinding(key, harnessId) {
    if (!key || !harnessId) return null;
    const list = Array.isArray(key.harness_models) ? key.harness_models : [];
    return list.find(h => String(h.harness) === String(harnessId)) || null;
  }

  _usageRequestSourceBadge(source) {
    const meta = this._usageRequestSourceMeta(source);
    return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;background:color-mix(in srgb, ${meta.color} 15%, transparent);color:${meta.color};">${escapeHtml(meta.label)}</span>`;
  }

  // ==================== 会话 Tab（经网关的客户端会话聚合，只读） ====================

  /** 会话列表（服务端已按归因 sessionId / 小时窗分桶聚合，仅当前用户自己的数据） */
  async loadSessions(page = 1) {
    this._sessionsPage = Math.max(parseInt(page, 10) || 1, 1);
    const container = document.getElementById('sessionsList');
    if (!container) return;
    // 正常列表加载时退出内容搜索视图（清空搜索框 = 恢复列表）
    const searchWrap = document.getElementById('sessionsSearchResultsWrap');
    if (searchWrap) {
      searchWrap.style.display = 'none';
      const input = document.getElementById('sessionsSearchInput');
      if (input) input.value = '';
    }
    setHTML(container, pageLoadingHtml(t('加载会话...'), { compact: true }));

    const days = (document.getElementById('sessionDaysFilter')?.value || '7').trim();
    const source = (document.getElementById('sessionSourceFilter')?.value || '').trim();
    const params = new URLSearchParams({ days, page: String(this._sessionsPage), pageSize: '20' });
    if (source) params.set('source', source);

    try {
      const res = await fetch(`/api/user/sessions?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));

      const total = Number(data.total || 0);
      const totalPages = Math.ceil(total / (data.pageSize || 20)) || 1;
      const countEl = document.getElementById('sessionsCountInfo');
      if (countEl) countEl.textContent = `${t('共')} ${total} ${t('个会话')}`;
      const prevBtn = document.getElementById('sessionsPrevBtn');
      const nextBtn = document.getElementById('sessionsNextBtn');
      if (prevBtn) { prevBtn.disabled = this._sessionsPage <= 1; }
      if (nextBtn) { nextBtn.disabled = this._sessionsPage >= totalPages; }
      const pageInfoEl = document.getElementById('sessionsPageInfo');
      if (pageInfoEl) pageInfoEl.textContent = `${t('第')}${this._sessionsPage} / ${totalPages}${t('页')}`;

      if (!data.items || !data.items.length) {
        setHTML(container, `<div class="model-library-item" style="grid-column:1/-1;cursor:default;"><div class="model-library-item-info"><div class="model-library-item-desc" style="text-align:center;">${t('所选时间范围内暂无会话')}</div></div></div>`);
        return;
      }
      setHTML(container, data.items.map(item => this.renderSessionCard(item)).join(''));
    } catch (error) {
      setHTML(container, `<div class="model-library-item" style="grid-column:1/-1;cursor:default;"><div class="model-library-item-info"><div class="model-library-item-desc">${escapeHtml(error.message || t('会话加载失败'))}<div style="margin-top:10px;"><button class="btn btn-secondary btn-sm" onclick="app.loadSessions(${this._sessionsPage || 1})">${t('重试')}</button></div></div></div></div>`);
    }
  }

  renderSessionCard(item) {
    const key = String(item.sessionKey || '');
    const keyAttr = key.replace(/'/g, '\\&#39;');
    const harnessMeta = this._usageRequestSourceMeta(item.harness);
    const cached = Number(item.totalCachedTokens || 0);
    const summaryBadge = item.summaryCreatedAt
      ? `<span class="session-badge cached" title="${t('最近更新')} ${escapeHtml(new Date(item.summaryCreatedAt).toLocaleString())}">${t('缓存摘要')} · ${escapeHtml(this.formatRelativeTime(item.summaryCreatedAt))}</span>`
      : '';
    const previewSource = item.summary || item.lastMessagePreview || '';
    const previewText = String(previewSource).split(/[。.!！？?\n]/)[0].slice(0, 60);
    const preview = previewText ? `<div class="session-card-preview" title="${escapeHtml(previewSource)}">${escapeHtml(previewText)}</div>` : '';
    const pressureBadge = item.pressureLevel === 'critical'
      ? `<span class="session-badge pressure-critical" title="${t('上下文压力')}">${t('高压')}</span>`
      : item.pressureLevel === 'warning'
        ? `<span class="session-badge pressure-warning" title="${t('上下文压力')}">${t('注意')}</span>`
        : '';
    const range = `${this.formatRelativeTime(item.firstSeen)} → ${this.formatRelativeTime(item.lastSeen)}`;
    const cwdText = item.cwd ? `<div class="model-library-item-desc" style="-webkit-line-clamp:1;" title="${escapeHtml(item.cwd)}">${this._sfIcon('folder.fill', '9ca3af')} ${escapeHtml(String(item.cwd).slice(-80))}</div>` : '';
    const lastTool = item.lastToolName ? ` · ${t('最近')}: ${item.lastToolName}` : '';
    return `
      <div class="model-library-item" data-session-key="${escapeHtml(key)}" onclick="app.showSessionDetail('${keyAttr}')">
        <div class="model-library-item-info">
          <div class="model-library-item-name">
            ${this._harnessIconHtml(item.harness, 16)}
            <span>${escapeHtml(harnessMeta.label)}</span>
            <span style="font-weight:400;color:var(--muted-foreground);font-size:12px;" title="${escapeHtml(key)}">${escapeHtml(key.slice(0, 18))}…</span>
          </div>
          ${cwdText}
          ${preview}
          <div class="session-card-meta">
            <span>${escapeHtml(range)}</span>
            <span>${Number(item.requestCount || 0)} ${t('次请求')} · ${Number(item.toolCallCount || 0)} ${t('工具调用')}${escapeHtml(lastTool)}</span>
          </div>
        </div>
        <div class="model-library-item-actions model-item-badges">
          <span class="model-item-badge" title="${t('总 Token')}">${this._formatBigNumber(Number(item.totalTokens || 0))}</span>
          ${cached ? `<span class="model-item-badge series session-badge-cached" style="background:rgba(16,185,129,.12);color:var(--success);" title="${t('缓存命中 Token')}">${t('缓存')} ${this._formatBigNumber(cached)}</span>` : ''}
          ${summaryBadge}
          ${pressureBadge}
        </div>
      </div>`;
  }

  /** 会话内容搜索：调 /search 端点，按会话聚合渲染结果卡片（复用列表卡片样式） */
  async runSessionsSearch() {
    const container = document.getElementById('sessionsSearchResults');
    const wrap = document.getElementById('sessionsSearchResultsWrap');
    const listEl = document.getElementById('sessionsList');
    if (!container || !wrap) return;
    const q = (document.getElementById('sessionsSearchInput')?.value || '').trim();
    // 空关键词 = 清空搜索，恢复列表
    if (!q) { this.clearSessionsSearch(); return; }

    const days = (document.getElementById('sessionDaysFilter')?.value || '7').trim();
    wrap.style.display = '';
    if (listEl) {
      listEl.style.display = 'none';
      const pager = listEl.nextElementSibling;
      if (pager && pager.querySelector('#sessionsPrevBtn')) pager.style.display = 'none';
    }
    setHTML(container, pageLoadingHtml(t('搜索中...'), { compact: true }));
    const infoEl = document.getElementById('sessionsSearchInfo');

    try {
      const params = new URLSearchParams({ q, days });
      const res = await fetch(`/api/user/sessions/search?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));
      const results = Array.isArray(data.results) ? data.results : [];
      if (infoEl) infoEl.textContent = `${t('共')} ${Number(data.totalSessions || 0)} ${t('个匹配会话')}`;
      if (!results.length) {
        setHTML(container, `<div class="model-library-item" style="grid-column:1/-1;cursor:default;"><div class="model-library-item-info"><div class="model-library-item-desc" style="text-align:center;">${t('无匹配结果')}</div></div></div>`);
        return;
      }
      setHTML(container, results.map(item => this.renderSessionSearchResult(item)).join(''));
    } catch (error) {
      setHTML(container, `<div class="model-library-item" style="grid-column:1/-1;cursor:default;"><div class="model-library-item-info"><div class="model-library-item-desc">${escapeHtml(error.message || t('搜索失败'))}</div></div></div>`);
    }
  }

  /** 搜索结果摘录：<<<MARK>>>/<<<END>>> 替换为高亮 <mark>（其余内容已 escapeHtml） */
  _renderSearchExcerpt(excerpt) {
    return escapeHtml(String(excerpt || ''))
      .replace(/&lt;&lt;&lt;MARK&gt;&gt;&gt;/g, '<mark class="search-hit">')
      .replace(/&lt;&lt;&lt;END&gt;&gt;&gt;/g, '</mark>');
  }

  /** 渲染单条搜索结果卡片：会话信息 + matchCount 徽标 + 最多 3 条命中摘录 */
  renderSessionSearchResult(item) {
    const key = String(item.sessionKey || '');
    const keyAttr = key.replace(/'/g, '\\&#39;');
    const harnessMeta = this._usageRequestSourceMeta(item.harness);
    const range = `${this.formatRelativeTime(item.firstSeen)} → ${this.formatRelativeTime(item.lastSeen)}`;
    const previews = (Array.isArray(item.previews) ? item.previews : [])
      .map(p => `
        <div class="session-search-excerpt">
          <span style="color:var(--muted-foreground);opacity:.75;">${escapeHtml(new Date(p.ts).toLocaleString())} · </span>${this._renderSearchExcerpt(p.excerpt)}
        </div>`).join('');
    return `
      <div class="model-library-item" data-session-key="${escapeHtml(key)}" onclick="app.showSessionDetail('${keyAttr}')">
        <div class="model-library-item-info">
          <div class="model-library-item-name">
            ${this._harnessIconHtml(item.harness, 16)}
            <span>${escapeHtml(harnessMeta.label)}</span>
            <span style="font-weight:400;color:var(--muted-foreground);font-size:12px;" title="${escapeHtml(key)}">${escapeHtml(key.slice(0, 18))}…</span>
          </div>
          <div class="session-card-meta">
            <span>${escapeHtml(range)}</span>
          </div>
          ${previews}
        </div>
        <div class="model-library-item-actions model-item-badges">
          <span class="model-item-badge session-badge-cached" style="background:rgba(245,158,11,.14);color:var(--warning);" title="${t('命中请求数')}">${Number(item.matchCount || 0)} ${t('条命中')}</span>
        </div>
      </div>`;
  }

  /** 清空搜索：恢复正常会话列表视图 */
  clearSessionsSearch() {
    const input = document.getElementById('sessionsSearchInput');
    if (input) input.value = '';
    const wrap = document.getElementById('sessionsSearchResultsWrap');
    if (wrap) wrap.style.display = 'none';
    const listEl = document.getElementById('sessionsList');
    if (listEl) {
      listEl.style.display = '';
      const pager = listEl.nextElementSibling;
      if (pager && pager.querySelector('#sessionsPrevBtn')) pager.style.display = '';
    }
    this.loadSessions(this._sessionsPage || 1);
  }

  /** 进入会话详情：切换视图并加载第一页消息时间线 */
  showSessionDetail(sessionKey) {
    this._detailRequestSeq = (this._detailRequestSeq || 0) + 1;
    this._detailLoading = false;
    this._detailSessionKey = String(sessionKey || '');
    this._ensureSessionAutoLoad();
    this._detailMsgPage = 0;
    this._detailLoaded = 0;
    this._detailTotal = 0;
    // 切换会话时的状态隔离：清空上一会话的总结状态与分页指纹，避免串会话
    this._summaryPending = false;
    this._sessionSummaryText = '';
    this._summaryDoneFor = null;
    this._summaryModalSessionKey = null;
    this._summaryError = null;
    this._detailCursor = null;
    this._setSummaryRegenDisabled(false);
    // 清空上一会话的顶部内联总结容器，避免串会话
    const inlineEl = document.getElementById('sessionSummaryInline');
    if (inlineEl) { inlineEl.innerHTML = ''; inlineEl.style.display = 'none'; delete inlineEl.dataset.built; }
    // 总结按钮缓存状态：已知命中直接置为「查看总结」，否则异步探测一次避免重复查询
    this._applySummaryBtnText(this._detailSessionKey, this._summaryCachedKeys.has(this._detailSessionKey));
    this._renderInlineCachedSummary(this._detailSessionKey);
    this._probeSessionSummaryCache(this._detailSessionKey);
    const listWrap = document.getElementById('sessionsListWrap');
    const detailWrap = document.getElementById('sessionDetailWrap');
    if (!listWrap || !detailWrap) return;
    listWrap.style.display = 'none';
    detailWrap.style.display = '';
    setHTML(document.getElementById('sessionTimeline'), '');
    setHTML(document.getElementById('sessionDetailMetaBar'), pageLoadingHtml(t('加载会话...'), { compact: true }));
    const moreBtn = document.getElementById('sessionMoreBtn');
    this._updateSessionMoreButton(moreBtn, 'more');
    window.scrollTo({ top: 0 });
    this.loadSessionMessages(this._detailSessionKey, 1);
  }

  /** 会话消息时间线（按请求 ASC 分页；翻页时追加渲染） */
  async loadSessionMessages(sessionKey, page = 1) {
    const timeline = document.getElementById('sessionTimeline');
    const metaBar = document.getElementById('sessionDetailMetaBar');
    const requestSeq = this._detailRequestSeq;
    if (!timeline || !sessionKey || this._detailLoading || sessionKey !== this._detailSessionKey) return;
    const cursor = page > 1 ? this._detailCursor : null;
    this._detailLoading = true;
    const moreBtn = document.getElementById('sessionMoreBtn');
    const previousHeight = page > 1 ? document.documentElement.scrollHeight : 0;
    const previousScrollY = page > 1 ? window.scrollY : 0;
    let requestSucceeded = false;
    if (page === 1) {
      setHTML(timeline, `<li class="session-detail-skeleton"><div class="skeleton-bar" style="width:65%"></div><div class="skeleton-bar" style="width:90%"></div><div class="skeleton-bar" style="width:78%"></div></li>`);
    } else if (moreBtn) {
      this._updateSessionMoreButton(moreBtn, 'loading');
    }

    try {
      if (page > 1 && !cursor) return;
      const cursorParams = cursor
        ? `&beforeCreatedAt=${encodeURIComponent(cursor.beforeCreatedAt)}&beforeId=${encodeURIComponent(cursor.beforeId)}`
        : '';
      const res = await fetch(`/api/user/sessions/${encodeURIComponent(sessionKey)}/messages?page=${encodeURIComponent(page)}&pageSize=40${cursorParams}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));

      if (requestSeq !== this._detailRequestSeq || sessionKey !== this._detailSessionKey) return;
      this._detailMsgPage = page;
      this._detailTotal = Number(data.total || 0);

      if (page === 1) {
        // 详情元信息条（首条与末条记录覆盖时间范围）
        const records = Array.isArray(data.records) ? data.records : [];
        let totalTokens = 0, totalCached = 0;
        const models = new Set();
        for (const r of records) { totalTokens += Number(r.tokens || 0); totalCached += Number(r.cachedTokens || 0); models.add(r.model); }
        const harnessMeta = this._usageRequestSourceMeta(records[0]?.harness || 'unknown');
        setHTML(metaBar, `
          <span>${this._harnessIconHtml(records[0]?.harness || 'unknown', 14)} ${escapeHtml(harnessMeta.label)}</span>
          <span class="session-badge">${records[0]?.model ? escapeHtml(String(records[0].model).slice(0, 24)) : t('未知模型')}</span>
          <span>${this._detailTotal} ${t('次请求')}</span>
          <span class="session-badge" title="${t('本页 Token 合计')}">${t('Token')} ${this._formatBigNumber(totalTokens)}</span>
          ${totalCached ? `<span class="session-badge cached">${t('缓存')} ${this._formatBigNumber(totalCached)}</span>` : ''}
          <span>${escapeHtml(records.length ? `${new Date(records[0].ts).toLocaleString()} → ${new Date(records[records.length - 1].ts).toLocaleString()}` : '')}</span>
        `);
        setHTML(timeline, '');
        // refresh / 首次加载都从空白时间线开始。
        this._detailCursor = null;
        this._detailFirstRecordEvents = null;
      }

      const records = Array.isArray(data.records) ? data.records : [];
      // buildDetailRecords 只在当前页内按相邻记录去除上下文前缀；游标保证记录不重复。
      // 跨页只检查旧页首记录与已渲染首记录这一条边界：旧页上下文是新页上下文的前缀。
      if (page > 1 && records.length && Array.isArray(this._detailFirstRecordEvents) && this._detailFirstRecordEvents.length) {
        const boundary = this._detailFirstRecordEvents.map(event => JSON.stringify(event));
        const boundaryRecord = records[0];
        const incoming = Array.isArray(boundaryRecord.events) ? boundaryRecord.events : [];
        const incomingSigs = incoming.map(event => JSON.stringify(event));
        let overlap = 0;
        while (overlap < incomingSigs.length && overlap < boundary.length && incomingSigs[overlap] === boundary[overlap]) overlap++;
        if (overlap >= Math.ceil(incomingSigs.length / 2)) boundaryRecord.events = incoming.slice(overlap);
      }
      if (records.length) {
        const firstEvents = Array.isArray(records[0].events) ? records[0].events : [];
        this._detailFirstRecordEvents = firstEvents.slice();
      }
      const frag = records.map(record => {
        const evts = Array.isArray(record.events) ? record.events : [];

        // eventsCount 为原始事件数；被抑制的重放数 = 原始数 - 实际渲染数
        const suppressed = Math.max(Number(record.eventsCount || 0) - evts.length, 0);
        // 连续工具折叠：≥3 个连续工具事件合并为客户端风格摘要行（可展开明细）
        const groups = groupToolRuns(evts);
        const eventsHtml = groups.map(g => {
          if (g.type === 'single') return this.renderTimelineEvent(g.event);
          if (g.type === 'thinking_summary') return this.renderThinkingSummaryRow(g);
          return this.renderToolSummaryRow(g);
        }).join('');
        return `
          <li>
            <div class="timeline-record-head">
              <span title="${escapeHtml(new Date(record.ts).toISOString())}">${escapeHtml(new Date(record.ts).toLocaleTimeString())}</span>
              <span>${this._sfIcon('text.bubble', '10b981')} ${escapeHtml(record.model ? String(record.model).slice(0, 20) : '-')}</span>
              <span>${this._formatBigNumber(Number(record.tokens || 0))} Token</span>
              ${Number(record.cachedTokens || 0) ? `<span style="color:var(--success);">${t('缓存')} ${this._formatBigNumber(Number(record.cachedTokens || 0))}</span>` : ''}
              ${record.latencyMs != null ? `<span>${(record.latencyMs / 1000).toFixed(1)}s</span>` : ''}
              ${record.eventsTruncated ? `<span class="merged-tag">${t('已折叠 {count} 个旧事件', { count: suppressed })}</span>` : suppressed > 0 ? `<span class="merged-tag">${t('上下文重放')} +${suppressed}</span>` : `${evts.length} ${t('个事件')}`}${Number(record.repeatCount || 0) > 1 ? ` · <span class="merged-tag">${t('重复')} ×${record.repeatCount}</span>` : ''}
            </div>
            ${eventsHtml}
          </li>`;
      }).join('');
      if (page === 1) timeline.insertAdjacentHTML('beforeend', frag);
      else if (frag) timeline.insertAdjacentHTML('afterbegin', frag);
      this._removeDetailLoadError();
      requestSucceeded = true;

      this._detailLoaded += records.length;
      this._detailCursor = data.nextCursor || null;
      const moreBtn = document.getElementById('sessionMoreBtn');
      this._updateSessionMoreButton(moreBtn, data.nextCursor ? 'more' : 'done');
      if (page > 1) {
        const heightDelta = document.documentElement.scrollHeight - previousHeight;
        window.scrollTo({ top: previousScrollY + heightDelta });
      }

      if (page === 1 && !records.length) {
        setHTML(timeline, `<li><div class="timeline-event-text" style="text-align:center;color:var(--muted-foreground);padding:24px;">${t('该会话暂无消息明细')}</div></li>`);
      }
    } catch (error) {
      if (requestSeq !== this._detailRequestSeq || sessionKey !== this._detailSessionKey) return;
      const retry = `<button class="btn btn-secondary btn-sm" onclick="app.loadSessionMessages('${this._jsString(sessionKey)}', ${page})">${t('重试')}</button>`;
      if (page > 1 && timeline.children.length) {
        this._removeDetailLoadError();
        timeline.insertAdjacentHTML('beforeend', `<li class="session-detail-load-error"><div class="timeline-event-text" style="text-align:center;color:var(--destructive);padding:16px;">${escapeHtml(error.message || t('会话详情加载失败'))}<div style="margin-top:8px;">${retry}</div></div></li>`);
      } else {
        setHTML(timeline, `<li><div class="timeline-event-text" style="text-align:center;color:var(--muted-foreground);padding:24px;">${escapeHtml(error.message || t('会话详情加载失败'))}<div style="margin-top:8px;">${retry}</div></div></li>`);
      }
    } finally {
      if (requestSeq === this._detailRequestSeq) this._detailLoading = false;
      if (requestSeq === this._detailRequestSeq && moreBtn) {
        if (requestSucceeded) {
          moreBtn.disabled = false;
          if (!this._detailCursor) this._updateSessionMoreButton(moreBtn, 'done');
        } else {
          this._updateSessionMoreButton(moreBtn, 'more');
        }
      }
      if (requestSucceeded && requestSeq === this._detailRequestSeq && page >= 1 && this._detailSessionKey === sessionKey && this._detailCursor && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240) {
        queueMicrotask(() => this.loadSessionMessages(sessionKey, page + 1));
      }
    }
  }

  _updateSessionMoreButton(button, state) {
    if (!button) return;
    button.style.display = '';
    button.disabled = state === 'loading' || state === 'done';
    button.querySelector('[data-i18n]')?.replaceChildren(document.createTextNode(t(
      state === 'loading' ? '加载中...' : state === 'done' ? '已到最早消息' : '加载更多（向上翻更早）'
    )));
    button.title = t(state === 'done' ? '已到最早消息' : '加载更多（向上翻更早）');
    button.classList.toggle('session-more-done', state === 'done');
  }

  /** 时间线内联 SF 小图标（12px，随文基线对齐） */
  _sfIcon(name, color) {
    return `<img src="https://img.bloret.net/SF/${encodeURIComponent(name)}?color=${encodeURIComponent(color)}" alt="" class="sf-icon" data-sf-name="${escapeHtml(name)}" style="display:inline-block;vertical-align:-2px;width:12px;height:12px;">`;
  }

  /** 时间线单事件：文本 / 工具调用 / 工具结果 / 思考 */
  renderToolSummaryRow(group) {
    const sentence = summarySentence(group.groups, group.hashes, t, group.thinkingCount || 0);
    const count = (group.events || []).length;
    return `
      <li class="timeline-event type-tool_summary">
        <details class="tool-block">
          <summary class="tool-call-line"><span class="tool-dot" style="color:var(--info);">⏺</span> <span class="tool-summary-text">${sentence}</span><span class="tool-args">${count} ${t('次操作')}</span></summary>
          ${group.events.map(e => this.renderTimelineEvent(e)).join('')}
        </details>
      </li>`;
  }

  /** 连续 thinking 段折叠摘要行：点击展开全部思考内容（复用 thinking-block 样式） */
  renderThinkingSummaryRow(group) {
    const count = (group.events || []).length;
    return `
      <li class="timeline-event type-thinking_summary">
        <details class="thinking-block">
          <summary title="${t('点击展开全部')}" aria-label="${t('点击展开全部')}">${this._sfIcon('brain.head.profile', 'ec4899')} ${t('已深度思考')}<span class="tool-args">${count} ${t('段思考')} · ${t('展开全部')}</span></summary>
          ${group.events.map(e => this.renderTimelineEvent(e)).join('')}
        </details>
      </li>`;
  }

  renderTimelineEvent(evt) {
    if (!evt || typeof evt !== 'object') return '';
    // —— 工具调用：Claude Code 终端风格一行式 ⏺ Tool(args 摘要) + 可折叠参数/结果 ——
    if (evt.type === 'tool_call') {
      const name = evt.name || 'unknown';
      let argsLine = '';
      try {
        const argsObj = (evt.argsObj && typeof evt.argsObj === 'object') ? evt.argsObj : null;
        argsLine = summarizeToolCall(name, argsObj, evt.argsPreview || '');
      } catch (_) { /* 摘要失败时保持空 */ }
      return `
        <li class="timeline-event type-tool_call">
          <details class="tool-block">
            <summary class="tool-call-line"><span class="tool-dot">${this._sfIcon('hammer.fill', 'f59e0b')}</span> <span class="tool-name">${escapeHtml(name)}</span><span class="tool-args">${escapeHtml(argsLine)}</span></summary>
            ${evt.argsPreview ? `<pre class="tool-args-full">${escapeHtml(evt.argsPreview)}${evt.truncated ? '\n…' : ''}</pre>` : ''}
          </details>
        </li>`;
    }
    // —— 工具结果：缩进折叠块，错误红标 ——
    if (evt.type === 'tool_result') {
      const errCls = evt.is_error ? ' tool-result-error' : '';
      const errTag = evt.is_error ? `<span class="tool-error-tag">${t('错误')}</span>` : '';
      return `
        <li class="timeline-event type-tool_result${errCls}">
          <details class="tool-block tool-result-block" ${evt.is_error ? 'open' : ''}>
            <summary class="tool-result-line"><span class="tool-result-icon">${this._sfIcon('arrow.turn.down.right', '8b5cf6')}</span> ${errTag}<span class="tool-result-owner">${escapeHtml(evt.name || t('工具结果'))}</span></summary>
            ${evt.resultPreview ? `<pre class="tool-result-text">${escapeHtml(evt.resultPreview)}${evt.resultPreview.length >= 800 ? '\n…' : ''}</pre>` : ''}
          </details>
        </li>`;
    }
    // —— thinking：斜体灰字，默认折叠 ——
    if (evt.type === 'thinking') {
      return `
        <li class="timeline-event type-thinking">
          <details class="thinking-block">
            <summary>${this._sfIcon('brain.head.profile', 'ec4899')} ${t('思考')}</summary>
            <div class="timeline-event-text thinking-text">${escapeHtml(evt.preview || '')}${evt.truncated ? '\n…' : ''}</div>
          </details>
        </li>`;
    }
    // —— 正文：user 高亮气泡 / assistant 常规 / system 弱化 ——
    const roleMap = {
      user: { label: `${this._sfIcon('person.crop.circle', '3b82f6')} ${t('用户')}`, color: 'var(--info)' },
      assistant: { label: `${this._sfIcon('text.bubble', '10b981')} ${t('助手')}`, color: 'var(--success)' },
      system: { label: `${this._sfIcon('gearshape.fill', '9ca3af')} ${t('系统')}`, color: 'var(--muted-foreground)' },
    };
    const meta = roleMap[evt.role] || roleMap.system;
    // assistant 正文渲染 Markdown（白名单清洗）；user/system 保持纯文本
    let bodyHtml;
    if (evt.role === 'assistant' && typeof marked !== 'undefined') {
      bodyHtml = this._renderSafeMarkdown(String(evt.text || '')) + (evt.truncated ? '\n…' : '');
    } else {
      bodyHtml = escapeHtml(evt.text || '') + (evt.truncated ? '\n…' : '');
    }
    return `
      <li class="timeline-event role-${escapeHtml(evt.role || 'system')}">
        <span class="timeline-event-tag" style="color:${meta.color};">${meta.label}</span>
        <div class="timeline-event-text timeline-md-body role-${escapeHtml(evt.role || 'system')}-text">${bodyHtml}</div>
      </li>`;
  }

  /** Markdown 安全渲染：marked.parse + 白名单清洗 */
  _renderSafeMarkdown(text) {
    try {
      const raw = marked.parse(text);
      const tpl = document.createElement('template');
      tpl.innerHTML = raw;
      const ALLOWED = new Set(['P','H1','H2','H3','H4','H5','H6','UL','OL','LI','CODE','PRE','BLOCKQUOTE','STRONG','EM','DEL','S','A','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','BR','HR','SPAN']);
      const walk = (node) => {
        [...node.children].forEach(child => {
          if (!ALLOWED.has(child.tagName)) { child.remove(); return; }
          [...child.attributes].forEach(attr => {
            const n = attr.name.toLowerCase();
            if (n.startsWith('on') || !['href', 'title', 'target', 'rel'].includes(n)) child.removeAttribute(attr.name);
            else if (n === 'href' && !/^https?:\/\//i.test(attr.value)) child.removeAttribute(attr.name);
          });
          if (child.tagName === 'A') {
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer nofollow');
          }
          walk(child);
        });
      };
      walk(tpl.content);
      return tpl.innerHTML;
    } catch (_) {
      return escapeHtml(text);
    }
  }

  /** 返回会话列表 */
  _ensureSessionAutoLoad() {
    if (this._sessionAutoLoadBound) return;
    this._sessionAutoLoadBound = true;
    window.addEventListener('scroll', () => {
      if (this.currentPage !== 'sessions' || !this._detailSessionKey || this._detailLoading) return;
      const moreBtn = document.getElementById('sessionMoreBtn');
      if (moreBtn?.style.display === 'none') return;
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240 && this._detailCursor) {
        this.loadSessionMessages(this._detailSessionKey, (this._detailMsgPage || 1) + 1);
      }
    }, { passive: true });
  }

  _removeDetailLoadError() {
    document.querySelectorAll('#sessionTimeline .session-detail-load-error').forEach(el => el.remove());
  }

  closeSessionDetail() {
    this._detailRequestSeq = (this._detailRequestSeq || 0) + 1;
    this._detailLoading = false;
    this._detailCursor = null;
    this._detailMsgPage = 0;
    this._detailLoaded = 0;
    this._detailTotal = 0;
    this._summaryPending = false;
    this._summaryModalSessionKey = null;
    this._summaryTaskSessionKey = null;
    const listWrap = document.getElementById('sessionsListWrap');
    const detailWrap = document.getElementById('sessionDetailWrap');
    if (listWrap) listWrap.style.display = '';
    if (detailWrap) detailWrap.style.display = 'none';
    this._detailSessionKey = null;
  }

  /** 「提示词」页：历史自定义提示词列表（去重合并，仅当前用户自己的，/api/user/custom-instructions） */
  async loadCustomPrompts(page = 1) {
    this.promptPage = Math.max(parseInt(page, 10) || 1, 1);
    const container = document.getElementById('promptsList');
    if (!container) return;
    setHTML(container, pageLoadingHtml(t('加载提示词...'), { compact: true }));

    const search = (document.getElementById('promptSearchInput')?.value || '').trim();
    const source = (document.getElementById('promptSourceFilter')?.value || '').trim();
    const sort = (document.getElementById('promptSortSelect')?.value || 'count').trim();
    const params = new URLSearchParams({ page: String(this.promptPage), pageSize: '20' });
    if (search) params.set('search', search);
    if (source) params.set('source', source);
    if (sort) params.set('sort', sort);

    try {
      const res = await fetch(`/api/user/custom-instructions?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));

      const countEl = document.getElementById('promptCount');
      const pageInfoEl = document.getElementById('promptPageInfo');
      const prevBtn = document.getElementById('promptPrevBtn');
      const nextBtn = document.getElementById('promptNextBtn');
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
              <th>${t('首次出现')}</th>
              <th>${t('最近出现')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${data.items.map((item, idx) => `
              <tr style="cursor:pointer;" data-prompt-idx="${idx}" title="${t('点击查看详情')}">
                <td class="cell-clip" style="max-width:280px;">
                  <div style="font-weight:500;display:flex;align-items:center;gap:6px;">📄 ${escapeHtml(item.file || t('(未知文件)'))}${item.truncated ? `<span style="font-size:11px;color:var(--muted-foreground);">(${t('截断存储')})</span>` : ''}</div>
                  <div style="font-size:11px;color:var(--muted-foreground);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.preview || '')}</div>
                </td>
                <td>${this._usageRequestSourceBadge(item.source)}</td>
                <td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${(parseInt(item.chars, 10) || 0).toLocaleString()}</td>
                <td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${(parseInt(item.occurrence_count, 10) || 0).toLocaleString()}</td>
                <td style="white-space:nowrap;font-size:12px;">${escapeHtml(new Date(item.first_seen).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
                <td style="white-space:nowrap;font-size:12px;">${escapeHtml(new Date(item.last_seen).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
                <td class="cell-actions"><button type="button" class="btn btn-sm btn-secondary" data-prompt-view-idx="${idx}">${t('查看内容')}</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `);

      container.querySelectorAll('tr[data-prompt-idx]').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          const item = this._promptsCache[parseInt(tr.getAttribute('data-prompt-idx'), 10)];
          if (item) this.showCustomPromptDetail(item.fingerprint);
        });
      });
      container.querySelectorAll('button[data-prompt-view-idx]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const item = this._promptsCache[parseInt(btn.getAttribute('data-prompt-view-idx'), 10)];
          if (item) this.showCustomPromptDetail(item.fingerprint);
        });
      });
    } catch (error) {
      console.error(t('加载提示词失败:'), error);
      setHTML(container, `<p style="text-align:center;color:var(--destructive);padding:40px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  clearPromptFilters() {
    for (const id of ['promptSearchInput', 'promptSourceFilter']) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    const sortEl = document.getElementById('promptSortSelect');
    if (sortEl) sortEl.value = 'count';
    this.loadCustomPrompts(1);
  }

  /** 「提示词」详情弹窗：完整内容 + 最近引用记录 */
  async showCustomPromptDetail(fingerprint) {
    const modal = document.getElementById('promptDetailModal');
    const content = document.getElementById('promptDetailContent');
    if (!modal || !content) return;
    setHTML(content, pageLoadingHtml(t('加载详情...'), { compact: true }));
    modal.style.display = 'flex';
    modal.classList.add('active');

    try {
      const res = await fetch(`/api/user/custom-instructions/${encodeURIComponent(fingerprint)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));
      this._promptDetailData = data;

      const titleEl = document.getElementById('promptDetailTitle');
      if (titleEl) titleEl.textContent = `${t('提示词详情')} · ${data.file || t('(未知文件)')}`;

      const fmtTime = (v) => v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
      const rows = [
        [t('文件名'), escapeHtml(data.file || t('(未知文件)'))],
        [t('客户端'), this._usageRequestSourceBadge(data.source)],
        [t('字符数'), (parseInt(data.chars, 10) || 0).toLocaleString()],
        [t('出现次数'), `${(parseInt(data.occurrence_count, 10) || 0).toLocaleString()}${data.truncated ? ` <span style="font-size:11px;color:var(--muted-foreground);">(${t('截断存储')})</span>` : ''}`],
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
                    <td class="cell-clip" style="max-width:220px;">${escapeHtml(r.model_id || '-')}</td>
                    <td>${this._usageRequestSourceBadge(r.request_source)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>`;
      }

      setHTML(content, `
        ${rows.map(([label, value]) => `
          <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="color:var(--muted-foreground);font-size:13px;">${label}</span>
            <span style="font-size:14px;">${value}</span>
          </div>
        `).join('')}
        <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:12px 0 0;border-bottom:1px solid var(--border);">
          <span style="color:var(--muted-foreground);font-size:13px;">${t('完整内容')}</span>
          <pre id="promptFullContent" style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:360px;overflow-y:auto;">${escapeHtml(data.content || '')}</pre>
        </div>
        <div style="padding:8px 0;"><button type="button" class="btn btn-sm btn-secondary" onclick="app.copyPromptContent(this)">⧉ ${t('复制内容')}</button></div>
        ${refsHtml}
      `);
    } catch (error) {
      console.error(t('加载提示词详情失败:'), error);
      setHTML(content, `<p style="text-align:center;color:var(--destructive);padding:20px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  // ================= 注入提示词（请求侧 system 注入，模型库同款卡片风格） =================

  async loadInjectPrompts() {
    const container = document.getElementById('injectPromptsList');
    if (!container) return;
    try {
      const res = await fetch('/api/user/inject-prompts');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));
      this._injectPrompts = data.items || [];
      setHTML(container, this._injectPrompts.length
        ? this._injectPrompts.map(item => this.renderInjectPromptCard(item)).join('')
        : `<div class="model-library-item" style="grid-column:1/-1;cursor:default;"><div class="model-library-item-info"><div class="model-library-item-desc" style="text-align:center;">${t('暂无注入条目，点击右上角「新建条目」创建')}</div></div></div>`);
    } catch (error) {
      setHTML(container, `<div class="model-library-item" style="grid-column:1/-1;cursor:default;"><div class="model-library-item-info"><div class="model-library-item-desc">${escapeHtml(error.message || t('加载失败'))}</div></div></div>`);
    }
  }

  renderInjectPromptCard(item) {
    if (!item) return '';
    const preview = String(item.content || '').replace(/\s+/g, ' ').trim();
    const boundCount = (item.bound_key_ids || []).length;
    const scopeBadge = !item.enabled
      ? ''
      : (boundCount > 0
        ? `<span class="model-item-badge" style="background:rgba(59,130,246,.12);color:var(--primary);">${t('{n} 个 Key', { n: boundCount })}</span>`
        : `<span class="model-item-badge" style="background:rgba(34,197,94,.12);color:var(--status-success);">${t('全局生效')}</span>`);
    const disabledBadge = item.enabled ? '' : `<span class="model-item-badge series">${t('已停用')}</span>`;
    return `
    <div class="model-library-item ${item.enabled ? '' : 'model-hidden'}" data-inject-id="${escapeHtml(item.id)}" style="cursor:default;">
      <div class="model-library-item-info">
        <div class="model-library-item-name">
          <span>${escapeHtml(item.name)}</span>
          <div class="model-item-badges">${scopeBadge}${disabledBadge}</div>
        </div>
        <div class="model-library-item-desc" style="-webkit-line-clamp:1;">${escapeHtml(preview)}</div>
      </div>
      <div class="model-library-item-actions">
        <label class="toggle-switch" onclick="event.stopPropagation()" title="${item.enabled ? t('点击停用') : t('点击启用')}">
          <input type="checkbox" ${item.enabled ? 'checked' : ''} onchange="app.toggleInjectPrompt(${parseInt(item.id, 10)}, this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <button type="button" class="btn btn-sm btn-secondary" onclick="app.showInjectPromptModal(${parseInt(item.id, 10)})">${t('编辑')}</button>
        <button type="button" class="btn btn-sm btn-secondary" onclick="app.deleteInjectPrompt(${parseInt(item.id, 10)})">${t('删除')}</button>
      </div>
    </div>`;
  }

  async showInjectPromptModal(id = null) {
    const modal = document.getElementById('injectPromptModal');
    if (!modal) return;
    this._editingInjectId = id ? parseInt(id, 10) : null;
    const item = this._editingInjectId ? (this._injectPrompts || []).find(p => parseInt(p.id, 10) === this._editingInjectId) : null;

    const titleEl = document.getElementById('injectPromptModalTitle');
    if (titleEl) titleEl.textContent = item ? `${t('编辑注入条目')} · ${item.name}` : t('新建条目');
    document.getElementById('injectPromptName').value = item?.name || '';
    document.getElementById('injectPromptContent').value = item?.content || '';

    // Key 绑定多选：每次打开拉取最新列表；不勾选任何 Key = 对所有 Key 全局生效
    const keyListEl = document.getElementById('injectPromptKeyList');
    setHTML(keyListEl, pageLoadingHtml(t('加载中...'), { compact: true }));
    let keys = [];
    try {
      const res = await fetch('/api/user/inject-prompts/my-keys');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('加载失败'));
      keys = data.items || [];
    } catch (error) {
      setHTML(keyListEl, `<p style="font-size:13px;color:var(--destructive);margin:0;">${escapeHtml(error.message || t('加载失败'))}</p>`);
      modal.style.display = 'flex';
      modal.classList.add('active');
      return;
    }

    const bound = new Set((item?.bound_key_ids || []).map(v => String(v)));
    if (!keys.length) {
      setHTML(keyListEl, `<p style="font-size:13px;color:var(--muted-foreground);margin:0;">${t('暂无可用 Key，保存后将对所有 Key 全局生效')}</p>`);
    } else {
      setHTML(keyListEl, `
        <p style="font-size:12px;color:var(--muted-foreground);margin:0 0 4px;">${t('不勾选任何 Key 时对所有 Key 全局生效；勾选后仅对所选 Key 生效')}</p>
        ${keys.map(k => `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--border);">
            <input type="checkbox" class="inject-key-check" value="${escapeHtml(k.id)}" ${bound.has(String(k.id)) ? 'checked' : ''}>
            <span>${escapeHtml(k.name)}${k.key_prefix ? `&nbsp;<code style="font-size:11px;color:var(--muted-foreground);">${escapeHtml(k.key_prefix)}…</code>` : ''}</span>
          </label>`).join('')}
      `);
    }

    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  /** 保存条目本体（新建或修改），返回条目 id */
  async saveInjectPrompt() {
    const id = this._editingInjectId;
    const name = (document.getElementById('injectPromptName')?.value || '').trim();
    const content = document.getElementById('injectPromptContent')?.value || '';
    if (!name) { alert(t('名称不能为空')); return; }
    if (!content.trim()) { alert(t('内容不能为空')); return; }
    if (new TextEncoder().encode(content).length > 32 * 1024) { alert(t('内容超过 32KB 上限')); return; }

    try {
      const res = await fetch(id ? `/api/user/inject-prompts/${id}` : '/api/user/inject-prompts', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('保存失败'));

      // 绑定选择随条目一起保存
      const keyIds = [...document.querySelectorAll('#injectPromptKeyList .inject-key-check:checked')].map(cb => parseInt(cb.value, 10));
      await this.saveInjectPromptKeys(data.item?.id || id, keyIds);

      this.closeModals();
      this.showToast(t('已保存'), 'success');
      await this.loadInjectPrompts();
    } catch (error) {
      alert(error.message || t('保存失败'));
    }
  }

  /** 设置条目的 Key 绑定（空数组 = 全局） */
  async saveInjectPromptKeys(promptId, keyIds) {
    if (promptId == null) return;
    const res = await fetch(`/api/user/inject-prompts/${promptId}/keys`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyIds: Array.isArray(keyIds) ? keyIds : [] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('保存失败'));
  }

  async deleteInjectPrompt(id) {
    if (!confirm(t('确认删除此注入条目？删除后转发的请求不再包含该条内容'))) return;
    try {
      const res = await fetch(`/api/user/inject-prompts/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('删除失败'));
      this.showToast(t('已删除'), 'success');
      await this.loadInjectPrompts();
    } catch (error) {
      alert(error.message || t('删除失败'));
    }
  }

  async toggleInjectPrompt(id, enabled) {
    try {
      const res = await fetch(`/api/user/inject-prompts/${id}/toggle`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!enabled })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('操作失败'));
      await this.loadInjectPrompts();
    } catch (error) {
      alert(error.message || t('操作失败'));
      await this.loadInjectPrompts();
    }
  }

  copyPromptContent(btn) {
    const text = document.getElementById('promptFullContent')?.textContent || '';
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

  _buildUsageLogFilterParams() {
    const modelQ = (document.getElementById('usageLogModelFilter')?.value || '').trim();
    const requestType = (document.getElementById('usageLogRequestTypeFilter')?.value || '').trim();
    const requestSource = (document.getElementById('usageLogRequestSourceFilter')?.value || '').trim();
    const startDate = document.getElementById('usageLogStartDate')?.value || '';
    const endDate = document.getElementById('usageLogEndDate')?.value || '';
    const params = new URLSearchParams();
    if (modelQ) params.append('model_q', modelQ);
    if (requestType) params.append('request_type', requestType);
    if (requestSource) params.append('request_source', requestSource);
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    return params;
  }

  async loadUsageLogs(page = 1) {
    this.usageLogPage = Math.max(1, page || 1);
    const params = this._buildUsageLogFilterParams();
    params.set('page', String(this.usageLogPage));
    params.set('limit', String(this.usageLogLimit));

    const container = document.getElementById('usageLogsList');
    if (!container) return;

    try {
      const response = await fetch(`/api/user/usage-logs?${params}`);
      if (!response.ok) throw new Error(t('加载失败'));
      const data = await response.json();

      this.usageLogTotal = data.total;
      this._usageLogsCache = data.logs || [];
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
              <th>模型</th>
              <th>系列</th>
              <th>客户端</th>
              <th>API Key</th>
              <th>Token</th>
              <th>缓存命中</th>
              <th>积分</th>
            </tr>
          </thead>
          <tbody>
            ${data.logs.map((log, idx) => {
              const promptTokens = parseInt(log.prompt_tokens || 0, 10);
              const cachedTokens = parseInt(log.cached_tokens || 0, 10);
              const cacheRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0.0';
              const cacheDisplay = cachedTokens > 0
                ? `<span style="color:var(--success);" title="${cachedTokens.toLocaleString()}">${this._formatBigNumber(cachedTokens)}</span> <span style="font-size:11px;color:var(--muted-foreground);">(${cacheRate}%)</span>`
                : '<span style="color:var(--muted-foreground);">-</span>';
              const modelLabel = log.model_name
                || (log.request_type === 'fusion' ? 'Fusion' : null)
                || (log.model_id ? String(log.model_id) : null)
                || t('(未知)');
              const costVal = parseFloat(log.cost || 0);
              const tokensVal = parseInt(log.tokens_used || 0, 10);
              const costDisplay = (costVal === 0 && tokensVal > 0)
                ? t('0（配额内）')
                : costVal.toFixed(6);
              return `
              <tr style="cursor:pointer;" onclick="app.showUsageDetail(${idx})">
                <td style="white-space:nowrap;">${escapeHtml(new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
                <td>${escapeHtml(modelLabel)}</td>
                <td>${escapeHtml(log.series || '-')}</td>
                <td>${this._usageRequestSourceBadge(log.request_source)}</td>
                <td><code style="font-size:12px;">${escapeHtml(log.key_prefix || '-')}****</code> ${log.key_name ? `<span style="color:var(--muted-foreground);font-size:11px;">(${escapeHtml(log.key_name)})</span>` : ''}</td>
                <td title="${(log.tokens_used || 0).toLocaleString()}">${this._formatBigNumber(parseInt(log.tokens_used || 0, 10))}</td>
                <td>${cacheDisplay}</td>
                <td>${costDisplay}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `);
    } catch (error) {
      console.error(t('加载调用记录失败:'), error);
      setHTML(container, `<p style="text-align:center;color:var(--destructive);padding:40px;">${escapeHtml(error.message || t('加载失败'))}</p>`);
    }
  }

  clearUsageLogFilters() {
    const modelEl = document.getElementById('usageLogModelFilter');
    const typeEl = document.getElementById('usageLogRequestTypeFilter');
    const sourceEl = document.getElementById('usageLogRequestSourceFilter');
    const startEl = document.getElementById('usageLogStartDate');
    const endEl = document.getElementById('usageLogEndDate');
    if (modelEl) modelEl.value = '';
    if (typeEl) typeEl.value = '';
    if (sourceEl) sourceEl.value = '';
    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';
    this.loadUsageLogs(1);
  }

  async exportUsageLogs() {
    const btn = document.getElementById('usageLogExportBtn');
    try {
      if (btn) setButtonLoading(btn, t('导出中...'));
      const params = this._buildUsageLogFilterParams();
      const res = await fetch(`/api/user/usage-logs/export?${params.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${t('导出失败 (')}${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const match = cd.match(/filename="?([^"]+)"?/i);
      const filename = match ? match[1] : `my-usage-logs-${Date.now()}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.showToast(t('导出成功'), 'success');
    } catch (error) {
      console.error(t('导出调用记录失败:'), error);
      this.showToast(error.message || t('导出失败'), 'error');
    } finally {
      if (btn) clearButtonLoading(btn, t('导出 CSV'));
    }
  }

  async showUsageDetail(idx) {
    let log = this._usageLogsCache[idx];
    if (!log) return;

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
        const res = await fetch(`/api/user/usage-logs/${log.id}`);
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

    const modelLabel = log.model_name
      || (log.request_type === 'fusion' ? 'Fusion' : null)
      || (log.model_id ? String(log.model_id) : null)
      || t('(未知)');
    const costVal = parseFloat(log.cost || 0);
    const tokensVal = parseInt(log.tokens_used || 0, 10);
    const costDisplay = (costVal === 0 && tokensVal > 0)
      ? t('0（配额内）')
      : costVal.toFixed(6);
    const rows = [
      [t('调用时间'), escapeHtml(new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))],
      [t('模型'), escapeHtml(modelLabel)],
      [t('系列'), escapeHtml(log.series || '-')],
      [t('供应商'), escapeHtml(log.provider_name || '-')],
      [t('请求类型'), escapeHtml(log.request_type || '-')],
      [t('客户端'), this._usageRequestSourceBadge(log.request_source) + (log.user_agent ? ` <span style="color:var(--muted-foreground);font-size:11px;word-break:break-all;">${escapeHtml(String(log.user_agent).slice(0, 120))}</span>` : '')],
      ['API Key', `<code style="font-size:12px;">${escapeHtml(log.key_prefix || '-')}****</code>${log.key_name ? ` <span style="color:var(--muted-foreground);font-size:11px;">(${escapeHtml(log.key_name)})</span>` : ''}`],
      [t('总 Token'), this._formatBigNumber(parseInt(log.tokens_used || 0, 10))],
      [t('输入 Token'), this._formatBigNumber(promptTokens)],
      [t('输出 Token'), this._formatBigNumber(parseInt(log.completion_tokens || 0, 10))],
      [t('缓存命中 Token'), cacheDisplay],
      [t('积分'), costDisplay],
      [t('延迟'), log.latency_ms != null ? `${log.latency_ms}ms` : '-'],
      [t('IP 地址'), escapeHtml(log.ip_address || '-')],
    ];

    let messagesHtml = '';
    if (log.messages) {
      try {
        const msgs = typeof log.messages === 'string' ? JSON.parse(log.messages) : log.messages;
        const formatted = (Array.isArray(msgs) ? msgs : [msgs]).map(m => {
          const role = m.role === 'system' ? '🔧 System' : m.role === 'user' ? '👤 User' : '🤖 Assistant';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
          return `<div style="margin-bottom:8px;"><div style="font-size:11px;color:var(--muted-foreground);margin-bottom:2px;">${role}</div><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:200px;overflow-y:auto;">${escapeHtml(content)}</pre></div>`;
        }).join('');
        messagesHtml = `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('请求消息')}</span><div style="max-height:400px;overflow-y:auto;">${formatted}</div></div>`;
      } catch {
        messagesHtml = `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('请求消息')}</span><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:400px;overflow-y:auto;">${escapeHtml(String(log.messages))}</pre></div>`;
      }
    }

    let responseHtml = '';
    if (log.response) {
      responseHtml = `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted-foreground);font-size:13px;">${t('AI 回复')}</span><pre style="background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:400px;overflow-y:auto;">${escapeHtml(log.response)}</pre></div>`;
    }

    const content = document.getElementById('usageDetailContent');
    if (!content) return;
    setHTML(content, rows.map(([label, value]) => `
      <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--muted-foreground);font-size:13px;">${label}</span>
        <span style="font-size:14px;">${value}</span>
      </div>
    `).join('') + messagesHtml + responseHtml);

    const modal = document.getElementById('usageDetailModal');
    if (modal) {
      modal.style.display = 'flex';
      modal.classList.add('active');
    }
  }

  formatRuleDuration(hours) {
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

  async loadBalance() {
    try {
      const balanceRes = await fetch('/api/user/balance');
      const data = await balanceRes.json();

      document.getElementById('balanceDisplay').textContent = Number(data.balance || 0).toFixed(0);

      // 用户组信息
      const groupSection = document.getElementById('groupInfoSection');
      if (data.group) {
        document.getElementById('groupName').textContent = data.group.name;
        document.getElementById('groupDesc').textContent = data.group.description || '';

        const rulesContainer = document.getElementById('groupRules');
        if (data.group.rules && data.group.rules.length > 0) {
          setHTML(rulesContainer, data.group.rules.map(rule => {
            const limit = Number(rule.rule_value);
            const current = Number(rule.current || 0);
            const pct = limit > 0 ? Math.min(100, (current / limit) * 100) : 0;
            const isWarning = pct >= 80;
            const isOver = pct >= 100;
            const barColor = isOver ? 'var(--destructive, var(--danger))' : isWarning ? 'var(--warning)' : 'var(--brand-blue, var(--info))';
            const isRequests = rule.rule_type === 'requests';
            const unit = isRequests ? t('次') : 'tokens';
            const typeLabel = isRequests ? t('请求次数') : t('Token 用量');
            const duration = this.formatRuleDuration(rule.duration_hours);
            return `
              <div class="rule-item">
                <div class="rule-top">
                  <span class="rule-label">${typeLabel} · 每 ${duration}</span>
                  <span class="rule-value">${isRequests ? `${current.toLocaleString()} / ${limit.toLocaleString()}` : `${this._formatBigNumber(current)} / ${this._formatBigNumber(limit)}`} ${unit}</span>
                </div>
                <div class="rule-bar-bg">
                  <div class="rule-bar-fill" style="width:${pct}%;background:${barColor}"></div>
                </div>
              </div>`;
          }).join(''));
        } else {
          setHTML(rulesContainer, '<div class="rule-item"><span class="rule-label" style="color:var(--muted-foreground)">' + t('暂无限额规则') + '</span></div>');
        }
        groupSection.style.display = 'block';
      } else {
        groupSection.style.display = 'none';
      }

      // 个人限额
      const personalSection = document.getElementById('personalLimitsSection');
      const personalContainer = document.getElementById('personalLimits');
      const rpm = data.rate_limit_rpm || 0;
      const tpm = data.rate_limit_tpm || 0;
      if (rpm > 0 || tpm > 0) {
        setHTML(personalContainer, `
          ${rpm > 0 ? `${'<div class="limit-card"><span class="limit-label">' + t('每分钟请求数 (RPM)')}</span><span class="limit-value">${rpm.toLocaleString()}</span></div>` : ''}
          ${tpm > 0 ? `${'<div class="limit-card"><span class="limit-label">' + t('每分钟 Token 数 (TPM)')}</span><span class="limit-value">${this._formatBigNumber(tpm)}</span></div>` : ''}
        `);
        personalSection.style.display = 'block';
      } else {
        personalSection.style.display = 'none';
      }
    } catch (error) {
      console.error(t('加载积分信息失败:'), error);
    }
  }

  showSettingsOverview() {
    const overview = document.getElementById('settingsOverview');
    const detail = document.getElementById('settingsDetail');
    if (overview) overview.hidden = false;
    if (detail) detail.hidden = true;
    document.querySelectorAll('.settings-section').forEach(section => { section.hidden = true; });
  }

  showSettingsCategory(category) {
    const overview = document.getElementById('settingsOverview');
    const detail = document.getElementById('settingsDetail');
    const title = document.getElementById('settingsDetailTitle');
    const sections = [...document.querySelectorAll(`.settings-category-${category}`)];
    if (!sections.length) return;
    if (overview) overview.hidden = true;
    if (detail) detail.hidden = false;
    if (title) title.textContent = document.querySelector(`[data-settings-category="${category}"] strong`)?.textContent || '';
    document.querySelectorAll('.settings-section').forEach(item => { item.hidden = !sections.includes(item); });
    sections[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async loadSettings() {
    this.showSettingsOverview();
    const version = document.getElementById('settingsVersionLabel');
    if (version) {
      try {
        const response = await fetch('/api/version');
        const data = await response.json();
        version.textContent = data.version ? `v${data.version}` : '-';
      } catch (_) { version.textContent = '-'; }
    }
    if (this.user) {
      document.getElementById('settingsAvatar').value = this.user.avatar || '';
      const preview = document.getElementById('settingsAvatarPreview');
      if (preview) {
        preview.src = this.user.avatar || '';
        preview.onerror = () => {
          preview.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect fill="%233b82f6" width="64" height="64" rx="32"/><text x="50%" y="50%" font-size="24" fill="white" text-anchor="middle" dy=".3em">${(this.user.username || '?').charAt(0).toUpperCase()}</text></svg>`;
        };
      }
      // 加载安全设置
      this.load2FAStatus();
      this.loadPasskeys();
      // 加载签名设置与通知
      this.loadSignatureSettings();
      this.loadNotificationSettings();
      this.loadHookNotifySettings();
      this.loadNotifications();
      this.loadPluginPrefOptin();
    }
  }

  // 插件偏好授权（preferences:read opt-in）
  async loadPluginPrefOptin() {
    const toggle = document.getElementById('pluginPrefOptin');
    if (!toggle) return;
    try {
      const res = await fetch('/api/user/plugin-pref-optin');
      if (!res.ok) return;
      const data = await res.json();
      toggle.checked = data.optedIn === true;
    } catch (error) { console.error(t('加载插件授权状态失败:'), error); }
  }

  async togglePluginPrefOptin(enabled) {
    const status = document.getElementById('pluginPrefOptinStatus');
    try {
      const res = await fetch('/api/user/plugin-pref-optin', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!enabled })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('保存失败'));
      if (status) { status.textContent = enabled ? t('已开启') : t('已关闭'); status.style.color = 'var(--success)'; }
    } catch (error) {
      const toggle = document.getElementById('pluginPrefOptin');
      if (toggle) toggle.checked = !enabled;
      if (status) { status.textContent = error.message || t('保存失败'); status.style.color = 'var(--destructive)'; }
    }
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
  }

  async loadNotificationSettings() {
    try {
      const res = await fetch('/api/user/notification-settings');
      if (!res.ok) return;
      const data = await res.json();
      const enabled = document.getElementById('barkEnabled');
      if (enabled) enabled.checked = !!data.barkEnabled;
      const key = document.getElementById('barkServerKey');
      if (key) key.value = data.barkServerKey || '';
      const endpoint = document.getElementById('barkEndpoint');
      if (endpoint) endpoint.value = data.barkEndpoint || 'https://api.day.app';
      const quota = document.getElementById('notifyQuota');
      if (quota) quota.checked = data.notifyQuota !== false;
      const errors = document.getElementById('notifyErrors');
      if (errors) errors.checked = data.notifyErrors !== false;
    } catch (error) { console.error(t('加载通知设置失败:'), error); }
  }

  async saveNotificationSettings() {
    const status = document.getElementById('notificationSettingsStatus');
    if (status) { status.textContent = t('保存中...'); status.style.color = 'var(--muted-foreground)'; }
    try {
      const res = await fetch('/api/user/notification-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          barkEnabled: document.getElementById('barkEnabled')?.checked,
          barkServerKey: document.getElementById('barkServerKey')?.value,
          barkEndpoint: document.getElementById('barkEndpoint')?.value,
          notifyQuota: document.getElementById('notifyQuota')?.checked,
          notifyErrors: document.getElementById('notifyErrors')?.checked,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('保存失败'));
      if (status) { status.textContent = t('保存成功'); status.style.color = 'var(--success)'; }
    } catch (error) {
      if (status) { status.textContent = error.message || t('保存失败'); status.style.color = 'var(--destructive)'; }
    }
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
  }

  async testBarkNotification() {
    const status = document.getElementById('notificationSettingsStatus');
    try {
      const res = await fetch('/api/user/notification-settings/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('发送失败'));
      if (status) { status.textContent = t('测试通知已发送'); status.style.color = 'var(--success)'; }
    } catch (error) {
      if (status) { status.textContent = error.message || t('发送失败'); status.style.color = 'var(--destructive)'; }
    }
  }

  async loadNotifications() {
    const list = document.getElementById('notificationsList');
    if (!list) return;
    try {
      const res = await fetch('/api/user/notifications?limit=50');
      if (!res.ok) throw new Error(t('加载失败'));
      const items = await res.json();
      if (!items.length) { list.innerHTML = '<div style="color:var(--muted-foreground);font-size:13px;padding:12px 0;">' + t('暂无通知') + '</div>'; return; }
      list.innerHTML = items.map(item => `<div style="padding:14px 0;border-bottom:1px solid var(--border);${item.read_at ? '' : 'background:color-mix(in srgb, var(--primary) 5%, transparent);'}"><div style="display:flex;gap:8px;align-items:center;"><strong>${escapeHtml(item.title)}</strong><span style="font-size:12px;color:var(--muted-foreground);">${this.formatRelativeTime(item.created_at)}</span><button class="btn btn-secondary" style="margin-left:auto;padding:4px 8px;font-size:12px;" onclick="app.deleteNotification(${item.id})">${t('删除')}</button></div><div style="margin-top:6px;font-size:13px;color:var(--muted-foreground);white-space:pre-wrap;">${escapeHtml(item.body)}</div>${item.read_at ? '' : `<button class="btn btn-secondary" style="margin-top:8px;padding:4px 8px;font-size:12px;" onclick="app.markNotificationRead(${item.id})">标记已读</button>`}</div>`).join('');
    } catch (error) { list.innerHTML = '<div style="color:var(--destructive);font-size:13px;">' + t('通知加载失败') + '</div>'; }
  }

  async markNotificationRead(id) { await fetch(`/api/user/notifications/${id}/read`, { method: 'PUT' }); await this.loadNotifications(); }
  async deleteNotification(id) { await fetch(`/api/user/notifications/${id}`, { method: 'DELETE' }); await this.loadNotifications(); }
  async clearNotifications() { await fetch('/api/user/notifications', { method: 'DELETE' }); await this.loadNotifications(); }

  // ========== 事件通知（简化：仅总开关） ==========
  async loadHookNotifySettings() {
    const toggle = document.getElementById('hookNotifyPushEnabled');
    if (!toggle) return;
    try {
      const res = await fetch('/api/user/hook-notify-rules');
      const data = await res.json();
      toggle.checked = data.pushEnabled === true;
      this._hookNotifySelection = data.selection || { harnesses: [], eventTypes: [] };
    } catch (error) {
      toggle.checked = false;
      this._hookNotifySelection = { harnesses: [], eventTypes: [] };
    }
  }

  showHookNotifySelection() {
    const harnesses = ['claude_code', 'codex', 'grok', 'qwen_code', 'opencode', 'openclaw', 'deepseek_harness', 'hermes'];
    const events = [['session_start', '会话开始'], ['session_end', '会话结束'], ['prompt_submit', '用户提问'], ['tool_use', '工具调用'], ['notification', '客户端通知'], ['response_stop', '回复完成'], ['subagent_stop', '子代理结束'], ['pre_compact', '即将压缩']];
    const sel = this._hookNotifySelection || { harnesses: [], eventTypes: [] };
    const hWrap = document.getElementById('hookNotifyHarnessChecks');
    const eWrap = document.getElementById('hookNotifyEventChecks');
    if (!hWrap || !eWrap) return;
    hWrap.innerHTML = harnesses.map(h => {
      const on = sel.harnesses.includes(h) ? ' checked' : '';
      return `<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;"><input type="checkbox" class="hn-harness" value="${h}"${on}> ${h}</label>`;
    }).join('');
    eWrap.innerHTML = events.map(([v, label]) => {
      const on = sel.eventTypes.includes(v) ? ' checked' : '';
      return `<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;"><input type="checkbox" class="hn-event" value="${v}"${on}> ${t(label)}</label>`;
    }).join('');
    this.showModal('hookNotifySelectModal');
  }

  async saveHookNotifySelection() {
    try {
      const harnesses = [...document.querySelectorAll('#hookNotifyHarnessChecks .hn-harness:checked')].map(c => c.value);
      const eventTypes = [...document.querySelectorAll('#hookNotifyEventChecks .hn-event:checked')].map(c => c.value);
      const res = await fetch('/api/user/hook-notify-rules/selection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harnesses, eventTypes })
      });
      if (!res.ok) throw new Error(t('保存失败'));
      this._hookNotifySelection = { harnesses, eventTypes };
      this.closeModal('hookNotifySelectModal');
      this.showToast(t('事件通知偏好已保存'), 'success');
    } catch (error) {
      this.showToast(error.message || t('保存失败'), 'error');
    }
  }

  // ========== 会话总结 ==========
  /** 后台生成中禁用「重新生成」按钮，避免并发重复请求 */
  _setSummaryRegenDisabled(disabled) {
    const btn = document.getElementById('sessionSummaryRegenBtn');
    const topBtn = document.getElementById('sessionSummaryRegenTopBtn');
    if (btn) btn.disabled = !!disabled;
    if (topBtn) topBtn.disabled = !!disabled;
  }

  async generateSessionSummary(force = false, sessionKey = '') {
    const key = String(sessionKey || this._detailSessionKey || '');
    if (!key) return;
    const bodyEl = document.getElementById('sessionSummaryBody');

    // 后台任务进行中：按会话恢复弹窗目标、已收增量与当前阶段，不重复发起
    if (this._summaryPendingKeys.has(key)) {
      const text = this._summaryCacheTextMap[key] || '';
      const phase = this._summaryPhaseMap[key] || 'reading';
      this._summaryModalSessionKey = key;
      this._summaryDoneFor = key;
      this._applySummaryModalMeta(key, this._summaryCacheTimeMap[key]);
      if (key === this._detailSessionKey) this._sessionSummaryText = text;
      this._renderSummaryLoading(bodyEl, phase, text);
      this.showModal('sessionSummaryModal');
      return;
    }

    // 非强制时先读缓存，命中直接展示
    if (!force) {
      try {
        const cached = await fetch(`/api/user/sessions/${encodeURIComponent(key)}/summary`);
        if (!cached.ok) throw new Error(t('总结缓存读取失败'));
        const cj = await cached.json();
        if (cj.summary) {
          this._summaryCachedKeys.add(key);
          this._summaryCacheTextMap[key] = cj.summary;
          this._summaryCacheTimeMap[key] = cj.createdAt || null;
          if (bodyEl) setHTML(bodyEl, this._renderSafeMarkdown(cj.summary));
          this._sessionSummaryText = cj.summary;
          this._summaryDoneFor = key;
          this._applySummaryModalMeta(key, cj.createdAt);
          this._renderSessionSummaryInline(key, cj.summary, 'done', null, cj.createdAt);
          this._applySummaryBtnText(key, true);
          this.showModal('sessionSummaryModal');
          return;
        }
      } catch (_) { /* 缓存读取失败则直接生成 */ }
    }

    // 记录本次请求归属：会话 key + 请求序号，供切换会话后的状态隔离与回调校验
    const reqKey = key;
    const reqSeq = ++this._summarySeq;
    // 弹窗显示加载提示；用户可关闭弹窗让任务在后台继续
    this._summaryModalSessionKey = reqKey;
    this._renderSummaryLoading(bodyEl);
    this.showModal('sessionSummaryModal');
    this._summaryPending = true;
    this._summaryPendingKeys.add(reqKey);
    this._setSummaryRegenDisabled(true);
    // 模型库顶部任务条：进入后台生成即亮出加载环（与弹窗是否开着无关，用户可能已切走）
    this._updateTaskBar('loading', { sessionKey: reqKey });

    // 后台执行：SSE 流式读取，实时渲染；await 不阻塞用户浏览
    try {
      const res = await fetch(`/api/user/sessions/${encodeURIComponent(key)}/summary?stream=1`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(()=>({}));
        throw new Error(j.error || t('总结生成失败'));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      let buf = '';
      let summaryPhase = 'reading';
      this._summaryPhaseMap[reqKey] = summaryPhase;
      const renderSummaryPhase = (phase) => {
        if (this._summarySeq !== reqSeq || this._summaryModalSessionKey !== reqKey) return;
        const liveBody = document.getElementById('sessionSummaryBody');
        if (liveBody && document.getElementById('sessionSummaryModal')?.style.display !== 'none') {
          this._renderSummaryLoading(liveBody, phase);
        }
      };
      let dataLines = [];
      const handleEvent = (data) => {
        if (!data) return;
        const obj = JSON.parse(data);
        if (obj.type === 'delta' && obj.text) {
          if (summaryPhase !== 'generating') {
            summaryPhase = 'generating';
            this._summaryPhaseMap[reqKey] = summaryPhase;
            renderSummaryPhase(summaryPhase);
          }
          acc += obj.text;
          renderAcc();
        }
        else if (obj.type === 'done') { if (obj.summary) acc = obj.summary; if (obj.createdAt) createdAt = obj.createdAt; renderAcc(); }
        else if (obj.type === 'error') throw new Error(obj.error || t('总结生成失败'));
      };
      let createdAt = null;
      const renderAcc = () => {
        this._summaryCacheTextMap[reqKey] = acc;
        if (this._detailSessionKey === reqKey) this._renderSessionSummaryInline(reqKey, acc, 'loading');
        const liveBody = document.getElementById('sessionSummaryBody');
        if (this._summarySeq === reqSeq && this._summaryModalSessionKey === reqKey && liveBody && document.getElementById('sessionSummaryModal')?.style.display !== 'none') {
          setHTML(liveBody, this._renderSafeMarkdown(acc));
          liveBody.scrollTop = liveBody.scrollHeight;
        }
        if (this._summarySeq === reqSeq) this._updateTaskBar('loading', { chars: acc.length, sessionKey: reqKey });
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (line === '') {
            if (!dataLines.length) continue;
            handleEvent(dataLines.join('\n').trim());
            dataLines = [];
          } else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      buf += decoder.decode();
      if (buf) {
        const tail = buf.replace(/\r$/, '');
        if (tail.startsWith('data:')) dataLines.push(tail.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length) handleEvent(dataLines.join('\n').trim());
      renderAcc();
      this._summaryCachedKeys.add(reqKey);
      this._summaryCacheTextMap[reqKey] = acc;
      this._summaryCacheTimeMap[reqKey] = createdAt || new Date().toISOString();
      if (this._detailSessionKey === reqKey) {
        this._summaryDoneFor = reqKey;
        this._sessionSummaryText = acc;
        this._setSummaryRegenDisabled(false);
        this._applySummaryBtnText(reqKey, true);
      }
      if (this._summarySeq === reqSeq) {
        this._summaryTaskSessionKey = reqKey;
        this._summaryTaskText = acc;
        this._setSummaryRegenDisabled(false);
      }
      if (this._detailSessionKey === reqKey) {
        this._renderSessionSummaryInline(reqKey, acc, 'done', null, this._summaryCacheTimeMap[reqKey]);
      }
      this.showToast(t('总结已生成'), 'success');
      if (this._summarySeq === reqSeq) this._updateTaskBar('done', { summary: acc, sessionKey: reqKey });
      return;
    } catch (error) {
      const summaryError = error.message || t('总结生成失败');
      if (this._summarySeq === reqSeq) this._summaryError = summaryError;
      if (this._detailSessionKey === reqKey) {
        this._renderSessionSummaryInline(reqKey, '', 'error', summaryError);

        const live = document.getElementById('sessionSummaryBody');
        if (live && document.getElementById('sessionSummaryModal')?.style.display !== 'none') {
          setHTML(live, `<span style="color:var(--danger);">${escapeHtml(summaryError)}</span>`);
        }
      }
      // 生成失败时收起加载条，避免留下无限旋转的进行中提示
      if (this._summarySeq === reqSeq) this._updateTaskBar('hidden');
      this.showToast(t('总结生成失败'), 'error');
    } finally {
      this._summaryPendingKeys.delete(reqKey);
      if (this._summarySeq === reqSeq) {
        this._summaryPending = false;
        this._setSummaryRegenDisabled(false);
      }
    }
  }

  /** 模型库顶部任务条：后台总结任务的进行中/完成状态 */
  _updateTaskBar(state, payload = {}) {
    const bar = document.getElementById('modelLibraryTaskBar');
    if (!bar) return;
    if (state === 'hidden') { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    if (state === 'loading') {
      bar.style.display = '';
      if (payload.sessionKey) this._summaryTaskSessionKey = payload.sessionKey;
      const sessionKey = String(payload.sessionKey || this._summaryTaskSessionKey || '');
      if (sessionKey) this._summaryTaskSessionKey = sessionKey;
      setHTML(bar, `
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border:1px solid var(--border);border-radius:12px;background:var(--card);">
          <div class="summary-spinner"></div>
          <span style="font-size:13px;color:var(--muted-foreground);">${t('正在生成会话总结...')}<small style="margin-left:6px;opacity:.7;">${t('可离开此页，完成后在此查看')}</small></span>
          ${sessionKey ? `<button type="button" class="btn btn-sm btn-secondary" onclick="app.openSessionSummaryModal('${this._jsString(sessionKey)}')">${t('查看总结')}</button>` : ''}
        </div>`);
      return;
    }
    if (state === 'done') {
      const text = String(payload.summary || '');
      const sessionKey = String(payload.sessionKey || this._summaryTaskSessionKey || '');
      this._summaryTaskSessionKey = sessionKey;
      this._summaryTaskText = text;
      bar.dataset.sessionKey = sessionKey;
      bar.style.display = '';
      setHTML(bar, `
        <div style="padding:14px 16px;border:1px solid var(--border);border-left:3px solid var(--success);border-radius:12px;background:var(--card);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong style="font-size:13px;">${t('会话总结已生成')}</strong>
            <button type="button" class="btn btn-sm btn-secondary" onclick="app.dismissModelLibraryTaskBar()" title="${t('关闭')}" style="padding:2px 8px;">✕</button>
          </div>
          <div class="session-summary-md" style="max-height:180px;overflow-y:auto;">${this._renderSafeMarkdown(text)}</div>
          <div style="margin-top:10px;display:flex;gap:8px;">
            <button type="button" class="btn btn-sm btn-primary" onclick="app.openSessionSummaryModal('${this._jsString(sessionKey)}')">${t('查看总结')}</button>
            <button type="button" class="btn btn-sm btn-secondary" onclick="app.showSessionDetail('${this._jsString(sessionKey)}')">${t('跳到该会话')}</button>
            <button type="button" class="btn btn-sm btn-secondary" onclick="app.copySessionSummary('${this._jsString(sessionKey)}')">${t('复制')}</button>
          </div>
        </div>`);
      return;
    }
  }

  dismissModelLibraryTaskBar() { this._updateTaskBar('hidden'); }
  openSessionSummaryModal(sessionKey = '') {
    const key = String(sessionKey || '');
    if (!key) return;
    this._summaryModalSessionKey = key;
    const text = this._summaryCacheTextMap[key] || (key === this._summaryTaskSessionKey ? this._summaryTaskText : '');
    const bodyEl = document.getElementById('sessionSummaryBody');
    if (this._summaryPendingKeys.has(key)) {
      this._summaryDoneFor = key;
      this._applySummaryModalMeta(key, this._summaryCacheTimeMap[key]);
      if (key === this._detailSessionKey) this._sessionSummaryText = text;
      this._renderSummaryLoading(bodyEl, this._summaryPhaseMap[key] || 'reading', text);
    } else {
      if (bodyEl) setHTML(bodyEl, text ? this._renderSafeMarkdown(text) : '');
      if (key === this._detailSessionKey) this._sessionSummaryText = text;
      this._summaryDoneFor = key;
      this._applySummaryModalMeta(key, this._summaryCacheTimeMap[key]);
    }
    this.showModal('sessionSummaryModal');
    this._updateTaskBar('hidden');
  }

  _renderSummaryLoading(bodyEl, phase = 'reading', text = '') {
    if (!bodyEl) return;
    const content = text ? `<div class="session-summary-md" style="margin-top:12px;">${this._renderSafeMarkdown(text)}</div>` : '';
    setHTML(bodyEl, `
      <div class="summary-loading">
        <div class="summary-spinner"></div>
        <span class="summary-loading-stage">${t(phase === 'generating' ? '正在生成...' : '正在阅读会话...')}</span>
      </div>${content}`);
  }

  async regenerateSessionSummary() {
    const key = String(this._summaryModalSessionKey || this._detailSessionKey || '');
    if (!key) return;
    // 防重：目标会话后台任务进行中忽略点击，避免并发重复请求
    if (this._summaryPendingKeys.has(key)) {
      const bodyEl = document.getElementById('sessionSummaryBody');
      this._renderSummaryLoading(bodyEl);
      this.showModal('sessionSummaryModal');
      return;
    }
    await this.generateSessionSummary(true, key);
  }

  _summaryPlainText(text) {
    const box = document.createElement('div');
    box.innerHTML = this._renderSafeMarkdown(String(text || ''));
    return String(box.textContent || box.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  async copySessionSummary(sessionKey = '') {
    const key = String(sessionKey || this._summaryModalSessionKey || this._detailSessionKey || '');
    if (!key) return;
    const text = this._summaryCacheTextMap[key] || (key === this._summaryTaskSessionKey ? this._summaryTaskText : '');
    try {
      await navigator.clipboard.writeText(this._summaryPlainText(text));
      this.showToast(t('已复制到剪贴板'), 'success');
    } catch (_) {
      this.showToast(t('复制失败'), 'error');
    }
  }

  /** 把当前详情页两个总结按钮文字切为「生成总结」/「查看总结」（仅作用于当前展示的会话） */
  _applySummaryBtnText(sessionKey, hasCache) {
    if (sessionKey !== this._detailSessionKey) return;
    const label = hasCache ? t('查看总结') : t('生成总结');
    document.querySelectorAll('#sessionDetailWrap [data-i18n]').forEach(el => {
      if (el.dataset.i18n === '生成总结' || el.dataset.i18n === '查看总结') {
        el.textContent = label;
        el.dataset.i18n = hasCache ? '查看总结' : '生成总结';
      }
    });
  }

  /** 异步探测当前会话的 GET summary 缓存，命中则把按钮置为「查看总结」并在顶部展示；同一会话只探测一次 */
  async _probeSessionSummaryCache(sessionKey) {
    if (!sessionKey || this._summaryCheckedKeys.has(sessionKey)) return;
    this._summaryCheckedKeys.add(sessionKey);
    try {
      const res = await fetch(`/api/user/sessions/${encodeURIComponent(sessionKey)}/summary`);
      if (!res.ok) throw new Error(t('总结缓存读取失败'));
      const data = await res.json().catch(() => ({}));
      if (data && data.summary) {
        this._summaryCachedKeys.add(sessionKey);
        this._summaryCacheTextMap[sessionKey] = data.summary;
        this._summaryCacheTimeMap[sessionKey] = data.createdAt || null;
        if (sessionKey === this._detailSessionKey) {
          this._applySummaryBtnText(sessionKey, true);
          this._renderSessionSummaryInline(sessionKey, data.summary, 'done', null, data.createdAt);
        }
      }
    } catch (_) { /* 探测失败保持「生成总结」 */ }
  }

  /** 会话页顶部内联容器：已知缓存直接按完成态渲染，否则清空隐藏 */
  _renderInlineCachedSummary(sessionKey) {
    if (sessionKey !== this._detailSessionKey) return;
    const text = this._summaryCacheTextMap[sessionKey];
    if (text) {
      this._renderSessionSummaryInline(sessionKey, text, 'done', null, this._summaryCacheTimeMap[sessionKey]);
    } else {
      const el = document.getElementById('sessionSummaryInline');
      if (el) { el.innerHTML = ''; el.style.display = 'none'; delete el.dataset.built; }
    }
  }

  _applySummaryModalMeta(sessionKey, createdAt) {
    const title = document.getElementById('sessionSummaryTitle');
    const keyEl = document.getElementById('sessionSummaryKey');
    const timeEl = document.getElementById('sessionSummaryTime');
    if (title) title.textContent = t('会话总结');
    if (keyEl) keyEl.textContent = sessionKey ? String(sessionKey).slice(0, 18) + (String(sessionKey).length > 18 ? '…' : '') : '';
    if (timeEl) timeEl.textContent = createdAt ? `${t('最近更新')} ${this.formatRelativeTime(createdAt)}` : '';
  }

  /** 会话页顶部内联总结：流式/完成/错误三态可视化（复用一个 details 结构，流式时只更新文本节点） */
  _renderSessionSummaryInline(sessionKey, text, state, errMsg, createdAt) {
    if (sessionKey !== this._detailSessionKey) return;
    const el = document.getElementById('sessionSummaryInline');
    if (!el) return;
    el.style.display = '';
    if (!el.dataset.built) {
      el.dataset.built = '1';
      const details = document.createElement('details');
      details.className = 'session-summary-inline';
      details.open = true;
      const summary = document.createElement('summary');
      const spinner = document.createElement('span');
      spinner.className = 'summary-spinner';
      spinner.style.cssText = 'width:16px;height:16px;border-width:2px;flex:none;';
      const label = document.createElement('span');
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'btn btn-secondary btn-sm';
      refresh.textContent = t('重新生成');
      refresh.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.generateSessionSummary(true); });
      const body = document.createElement('div');
      body.className = 'summary-inline-body session-summary-md';
      const time = document.createElement('small');
      time.className = 'summary-inline-time';
      summary.append(spinner, label, refresh);
      details.append(summary, time, body);
      el.append(details);
      el._details = details;
      el._spinner = spinner;
      el._label = label;
      el._refresh = refresh;
      el._time = time;
      el._body = body;
    }
    if (state === 'error') {
      el._label.textContent = t('总结生成失败');
      el._spinner.style.display = 'none';
      el._body.textContent = errMsg || t('总结生成失败');
      el._details.open = true;
      return;
    }
    el._label.textContent = state === 'done' ? t('会话总结') : t('正在生成会话总结...');
    el._spinner.style.display = state === 'done' ? 'none' : '';
    el._refresh.style.display = state === 'done' ? '' : 'none';
    el._time.textContent = state === 'done' && createdAt ? `${t('最近更新')} ${this.formatRelativeTime(createdAt)}` : '';
    if (state === 'done') setHTML(el._body, this._renderSafeMarkdown(text || ''));
    else el._body.textContent = text || '';
    el._details.open = true;
  }

  async toggleHookNotifyPush(enabled) {
    try {
      const res = await fetch('/api/user/hook-notify-rules/push-enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!enabled })
      });
      if (!res.ok) throw new Error(t('保存失败'));
      this.showToast(enabled ? t('事件通知已开启') : t('事件通知已关闭'), 'success');
    } catch (error) {
      const toggle = document.getElementById('hookNotifyPushEnabled');
      if (toggle) toggle.checked = !enabled;
      this.showToast(error.message || t('保存失败'), 'error');
    }
  }

  loadSignatureSettings() {
    const toggle = document.getElementById('apiSignatureToggle');
    const template = document.getElementById('apiSignatureTemplate');
    const group = document.getElementById('signatureTemplateGroup');
    if (!toggle || !template) return;

    const DEFAULT_TEMPLATE = t('{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}');
    const enabled = this.user.api_signature_enabled === true;
    const tpl = this.user.api_signature_template || DEFAULT_TEMPLATE;

    toggle.checked = enabled;
    template.value = tpl;
    group.style.display = enabled ? '' : 'none';

    toggle.onchange = () => {
      group.style.display = toggle.checked ? '' : 'none';
      this._updateSignaturePreview();
    };
    template.oninput = () => this._updateSignaturePreview();
    this._updateSignaturePreview();
  }

  _updateSignaturePreview() {
    const preview = document.getElementById('signaturePreview');
    if (!preview) return;
    const tpl = document.getElementById('apiSignatureTemplate')?.value || '';
    const example = tpl
      .replace(/\{model\}/g, 'gpt-4o')
      .replace(/\{tokens\}/g, '12.3k tokens')
      .replace(/\{cache_hit\}/g, '78%')
      .replace(/\{cached_tokens\}/g, '8,400')
      .replace(/\{provider\}/g, 'OpenAI')
      .replace(/\{cost\}/g, t('0.0123 积分'))
      .replace(/\{username\}/g, 'demo')
      .replace(/\{key_name\}/g, t('生产环境'))
      .replace(/\{balance\}/g, '9999')
      .replace(/\{group_name\}/g, t('默认组'))
      .replace(/\{team_name\}/g, t('我的团队'))
      .replace(/\{quota_info\}/g, t('5小时限额 35% · 周限额 12%'))
      .replace(/\{today_requests\}/g, '128')
      .replace(/\{today_tokens\}/g, '50.2k tokens');
    preview.textContent = example ? `${t('预览：')}${example}` : t('(空模板，不显示签名)');
  }

  async saveSignatureSettings() {
    const toggle = document.getElementById('apiSignatureToggle');
    const template = document.getElementById('apiSignatureTemplate');
    const status = document.getElementById('signatureSaveStatus');
    if (!toggle || !template) return;

    setHTML(status, inlineLoadingHtml(t('保存中...'), 'sm'));
    status.style.color = 'var(--muted-foreground)';

    try {
      const res = await fetch('/api/user/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_signature_enabled: toggle.checked,
          api_signature_template: template.value
        })
      });
      const data = await res.json();
      if (data.success) {
        this.user.api_signature_enabled = toggle.checked;
        this.user.api_signature_template = template.value;
        status.textContent = t('保存成功');
        status.style.color = 'var(--success)';
      } else {
        status.textContent = data.error || t('保存失败');
        status.style.color = 'var(--destructive)';
      }
    } catch {
      status.textContent = t('保存失败，请稍后重试');
      status.style.color = 'var(--destructive)';
    }
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
  }

  resetSignatureTemplate() {
    const DEFAULT_TEMPLATE = t('{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}');
    const template = document.getElementById('apiSignatureTemplate');
    const toggle = document.getElementById('apiSignatureToggle');
    if (template) template.value = DEFAULT_TEMPLATE;
    if (toggle) { toggle.checked = true; toggle.dispatchEvent(new Event('change')); }
    this._updateSignaturePreview();
  }

  async uploadAvatar(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const statusEl = document.getElementById('avatarUploadStatus');
    setHTML(statusEl, inlineLoadingHtml(t('上传中...'), 'sm'));
    statusEl.style.color = 'var(--muted-foreground)';

    const formData = new FormData();
    formData.append('image', file);

    try {
      const res = await fetch('/api/user/avatar', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();

      if (data.success && data.url) {
        document.getElementById('settingsAvatar').value = data.url;
        document.getElementById('settingsAvatarPreview').src = data.url;
        this.user.avatar = data.url;
        this.updateUserInfo();
        statusEl.textContent = t('上传成功');
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = data.error || t('上传失败');
        statusEl.style.color = 'var(--destructive)';
      }
    } catch (err) {
      statusEl.textContent = t('上传失败，请稍后重试');
      statusEl.style.color = 'var(--destructive)';
    } finally {
      e.target.value = '';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  }

  async changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmNewPassword').value;
    const statusEl = document.getElementById('changePasswordStatus');

    if (!newPassword || !confirmPassword) {
      statusEl.textContent = t('请填写新密码并确认');
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    if (newPassword.length < 6) {
      statusEl.textContent = t('新密码长度至少6位');
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    if (newPassword !== confirmPassword) {
      statusEl.textContent = t('两次输入的新密码不一致');
      statusEl.style.color = 'var(--destructive)';
      return;
    }

    try {
      const res = await fetch('/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ oldPassword: currentPassword || undefined, newPassword })
      });
      const data = await res.json();
      if (res.ok) {
        statusEl.textContent = data.message || t('密码修改成功');
        statusEl.style.color = 'var(--success)';
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmNewPassword').value = '';
      } else {
        statusEl.textContent = data.error || t('修改密码失败');
        statusEl.style.color = 'var(--destructive)';
      }
    } catch (err) {
      statusEl.textContent = t('修改密码失败，请稍后重试');
      statusEl.style.color = 'var(--destructive)';
    }
  }

  async createApiKey() {
    const name = document.getElementById('apiKeyName').value;
    const expiresIn = document.getElementById('apiKeyExpiry').value;
    try {
      const res = await fetch('/api/user/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, expiresIn: expiresIn ? parseInt(expiresIn) : null })
      });
      const data = await res.json();
      if (res.ok) {
        this.closeModals();
        this.loadApiKeys();
      } else {
        alert(t('创建失败: ') + (data.error || t('未知错误')));
      }
    } catch (error) {
      alert(t('创建失败'));
    }
  }

  async showKeyMembers(keyId) {
    this._currentMembersKeyId = keyId;
    this.showModal('keyMembersModal');
    await this.loadKeyMembers();
  }

  async loadKeyMembers() {
    const list = document.getElementById('keyMembersList');
    if (!list || !this._currentMembersKeyId) return;
    setHTML(list, pageLoadingHtml(t('加载成员...')));
    try {
      const res = await fetch(`/api/user/api-keys/${this._currentMembersKeyId}/members`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('加载失败'));
      const members = Array.isArray(data.members) ? data.members : [];
      setHTML(list, members.length ? members.map(member => `
        <div class="co-key-member-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;">
          <div><strong>${escapeHtml(member.username || '')}</strong><div class="api-key-sub-muted">${escapeHtml(member.email || '')}</div></div>
          <button type="button" class="btn btn-sm btn-secondary" onclick="app.removeKeyMember(${member.id})">移除</button>
        </div>`).join('') : '<p class="api-key-sub-muted" style="text-align:center;padding:18px;">' + t('暂无共同成员') + '</p>');
    } catch (error) {
      setHTML(list, `<p style="color:var(--destructive);">${escapeHtml(error.message)}</p>`);
    }
  }

  async addKeyMember() {
    const input = document.getElementById('keyMemberIdentity');
    const identity = input?.value?.trim();
    if (!identity || !this._currentMembersKeyId) return this.showToast(t('请输入完整用户名或邮箱'), 'error');
    try {
      const res = await fetch(`/api/user/api-keys/${this._currentMembersKeyId}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('添加失败'));
      input.value = '';
      this.showToast(t('共同成员已添加'), 'success');
      await Promise.all([this.loadKeyMembers(), this.loadApiKeys()]);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  async removeKeyMember(userId) {
    if (!await confirm(t('确定移除此共同成员？'))) return;
    try {
      const res = await fetch(`/api/user/api-keys/${this._currentMembersKeyId}/members/${userId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('移除失败'));
      this.showToast(t('共同成员已移除'), 'success');
      await Promise.all([this.loadKeyMembers(), this.loadApiKeys()]);
    } catch (error) { this.showToast(error.message, 'error'); }
  }

  _auditLogPage = 1;

  async loadAuditLogs(page = 1) {
    this._auditLogPage = page;
    const listEl = document.getElementById('auditLogsList');
    const paginationEl = document.getElementById('auditLogsPagination');
    if (!listEl) return;
    setHTML(listEl, pageLoadingHtml(t('加载操作日志...')));
    try {
      const resourceType = document.getElementById('auditLogActionFilter')?.value || '';
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (resourceType) params.set('resource_type', resourceType);
      const res = await fetch(`/api/user/audit-logs?${params}`);
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
              <span class="audit-log-action" style="font-size:12px;padding:2px 8px;border-radius:4px;background:var(--brand-blue);color:#fff;font-weight:500;">${escapeHtml(log.action)}</span>
              <span style="font-size:13px;color:var(--foreground);">${escapeHtml(log.description || '')}</span>
            </div>
            <div class="api-key-sub-muted" style="font-size:12px;">
              ${escapeHtml(log.resource_type || '-')}${log.resource_id ? ` #${escapeHtml(String(log.resource_id))}` : ''}
              ${log.ip_address ? ` · IP ${escapeHtml(log.ip_address)}` : ''}
              ${log.status ? ` · HTTP ${log.status}` : ''}
              ${log.duration_ms != null ? ` · ${log.duration_ms}ms` : ''}
            </div>
            ${log.details ? `<details style="margin-top:4px;"><summary style="font-size:12px;color:var(--muted-foreground);cursor:pointer;">${t('详情')}</summary><pre style="font-size:12px;margin:4px 0 0;white-space:pre-wrap;word-break:break-all;">${escapeHtml(typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2))}</pre></details>` : ''}
          </div>
          <div style="font-size:12px;color:var(--muted-foreground);white-space:nowrap;" title="${escapeHtml(new Date(log.created_at).toLocaleString('zh-CN'))}">${escapeHtml(this.formatRelativeTime(log.created_at))}</div>
        </div>`).join(''));

      const totalPages = Math.ceil(total / limit);
      if (totalPages > 1) {
        setHTML(paginationEl, `
          <button class="btn btn-sm btn-secondary" ${page <= 1 ? 'disabled' : ''} onclick="app.loadAuditLogs(${page - 1})">上一页</button>
          <span style="padding:0 8px;font-size:13px;">${page} / ${totalPages}</span>
          <button class="btn btn-sm btn-secondary" ${page >= totalPages ? 'disabled' : ''} onclick="app.loadAuditLogs(${page + 1})">下一页</button>`);
      } else {
        setHTML(paginationEl, '');
      }
    } catch (error) {
      setHTML(listEl, `<p style="color:var(--destructive);">${escapeHtml(error.message)}</p>`);
      setHTML(paginationEl, '');
    }
  }

  async leaveCoKey(keyId) {
    const confirmed = await confirm(t('退出后将立即失去此 Co-Key 的查看、复制和配置权限。若要重新加入，必须由发起者再次邀请。确定退出吗？'));
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/members/me`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      // owner 并发移除时，成员实际上已无权访问；刷新列表给出一致结果。
      if (res.status === 404) {
        this.showToast(t('您已退出或已被移除 Co-Key'), 'success');
        this.closeApiKeyMoreMenus();
        await this.loadApiKeys();
        return;
      }
      if (!res.ok) throw new Error(data.error || t('退出失败'));
      this.showToast(t('已退出 Co-Key'), 'success');
      this.closeApiKeyMoreMenus();
      this.hideModal('keyMembersModal');
      await this.loadApiKeys();
    } catch (error) {
      this.showToast(error.message || t('退出失败'), 'error');
    }
  }

  async deleteApiKey(id) {
    if (!await confirm(t('确定要删除此 API 密钥吗？此操作不可撤销。'))) return;
    try {
      const res = await fetch(`/api/user/api-keys/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('删除失败'));
      this.showToast(t('密钥已删除'), 'success');
      this.closeApiKeyMoreMenus?.();
      await this.loadApiKeys();
    } catch (error) {
      this.showToast(error.message || t('删除失败'), 'error');
    }
  }

  /**
   * 点击密钥名称 → 就地输入框重命名
   * Enter 保存，Esc 取消，失焦保存
   */
  startApiKeyInlineRename(keyId, nameEl) {
    if (!nameEl || nameEl.dataset.editing === '1') return;
    // 若已有其它编辑中的名称，先取消
    if (this._inlineRename && this._inlineRename.input) {
      this._cancelApiKeyInlineRename(false);
    }

    const key = this._lastApiKeys?.find(k => Number(k.id) === Number(keyId));
    const current = (key?.name || nameEl.textContent || 'API Key').trim() || 'API Key';

    nameEl.dataset.editing = '1';
    nameEl.classList.add('is-editing');
    nameEl.removeAttribute('title');
    nameEl.setAttribute('aria-hidden', 'true');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'api-key-name-input';
    input.maxLength = 100;
    input.value = current;
    input.setAttribute('aria-label', t('重命名 API Key'));
    input.placeholder = t('输入名称');
    // 用当前显示宽度作起点，避免布局跳动过大
    const w = Math.max(nameEl.offsetWidth || 0, 96);
    input.style.width = Math.min(Math.max(w + 16, 96), 240) + 'px';

    nameEl.replaceWith(input);
    this._inlineRename = {
      keyId: Number(keyId),
      input,
      original: current,
      finished: false
    };

    const finish = (save) => this._finishApiKeyInlineRename(save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    // mousedown 选中文字时 blur 会误触发：延迟一帧再绑 blur
    setTimeout(() => {
      if (this._inlineRename?.input !== input) return;
      input.addEventListener('blur', () => finish(true));
    }, 0);

    input.focus();
    input.select();
  }

  _cancelApiKeyInlineRename(restoreUi = true) {
    const state = this._inlineRename;
    if (!state) return;
    state.finished = true;
    this._inlineRename = null;
    if (restoreUi) {
      // 重新渲染列表恢复文案
      this.loadApiKeys().catch(() => {});
    }
  }

  async _finishApiKeyInlineRename(save) {
    const state = this._inlineRename;
    if (!state || state.finished) return;
    state.finished = true;
    this._inlineRename = null;

    const { keyId, input, original } = state;
    const name = (input?.value || '').trim();

    if (!save) {
      await this.loadApiKeys();
      return;
    }
    if (!name) {
      this.showToast(t('名称不能为空'), 'error');
      await this.loadApiKeys();
      return;
    }
    if (name === original) {
      await this.loadApiKeys();
      return;
    }

    if (input) input.disabled = true;
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.showToast(data.error || t('重命名失败'), 'error');
        await this.loadApiKeys();
        return;
      }
      // 同步本地缓存，避免闪一下旧名
      const key = this._lastApiKeys?.find(k => Number(k.id) === Number(keyId));
      if (key) key.name = name;
      this.showToast(t('重命名成功'), 'success');
      await this.loadApiKeys();
    } catch (e) {
      this.showToast(t('重命名失败'), 'error');
      await this.loadApiKeys();
    }
  }

  /** @deprecated 兼容旧调用，改为就地编辑 */
  renameApiKey(id) {
    const el = document.querySelector(`.api-key-card[data-key-id="${id}"] .api-key-name-editable`);
    if (el) this.startApiKeyInlineRename(id, el);
  }

  async generateClaudeConfig(keyId) {
    this._configKey = { id: keyId };
    this.showModal('configToolSelectModal');
  }

  async generateToolConfig(tool) {
    const keyId = this._configKey?.id;
    if (!keyId) return;
    this.closeModals();

    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/config`);
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || t('生成配置失败'));
        return;
      }
      const data = await res.json();
      const baseUrl = data.env.ANTHROPIC_BASE_URL;
      const apiKey = data.env.ANTHROPIC_AUTH_TOKEN;

      let title, desc, content;

      if (tool === 'claude') {
        title = t('Claude Code 配置');
        desc = t('将以下 JSON 写入') + ' <code>~/.claude/settings.json</code> ' + t('即可使用 CrewRouter 作为 API 代理');
        content = JSON.stringify(data, null, 2);
      } else if (tool === 'codex') {
        title = t('Codex 配置');
        desc = t('将以下内容写入') + ' <code>~/.codex/config.toml</code>' + t('，然后重启 Codex CLI');
        content = `# ~/.codex/config.toml
model = "claude-fable-5"
provider = "custom"

[providers.custom]
base_url = "${baseUrl}"
api_key = "${apiKey}"
wire_api = "openai"`;
      } else if (tool === 'opencode') {
        title = t('OpenCode 配置');
        desc = t('将以下 JSON 写入项目根目录的') + ' <code>opencode.json</code> ' + t('中');
        const ocConfig = {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: baseUrl + '/v1',
            apiKey: apiKey
          },
          models: {
            "claude-fable-5": {
              name: "Claude Fable 5"
            }
          }
        };
        content = JSON.stringify(ocConfig, null, 2);
      } else if (tool === 'grok') {
        title = t('Grok Build 配置');
        desc = t('将以下内容写入') + ' <code>~/.grok/config.toml</code>' + t('，然后重启 Grok Build');
        content = `[cli]
installer = "internal"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"

[ui]
max_thoughts_width = 120
fork_secondary_model = "grok-build"
yolo = false
compact_mode = false
permission_mode = "always-approve"

[model.bloret-router]
model = "claude-fable-5"
base_url = "${baseUrl}/v1"
name = "CrewRouter"
api_key = "${apiKey}"
context_window = 200000
description = "CrewRouter"

[models]
default = "claude-fable-5"
default_reasoning_effort = "high"`;
      } else if (tool === 'deepseek') {
        title = t('DeepSeek Harness 配置');
        desc = t('将以下内容写入') + ' <code>~/.dsh/settings.yaml</code>' + t('，并设置环境变量') + '<code>DEEPSEEK_API_KEY</code>' + t('，然后重启') + '<code>dsh</code>';
        content = `# ~/.dsh/settings.yaml
# DeepSeek Harness (dsh) → CrewRouter
# 适配器请求 \${baseURL}/chat/completions，因此 baseURL 需指向 /v1
llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  baseURL: ${baseUrl.replace(/\/$/, '')}/v1

# 同时导出密钥（或在 dsh 模型设置页写入同一凭证）：
# export DEEPSEEK_API_KEY="${apiKey}"
# export DEEPSEEK_BASE_URL="${baseUrl.replace(/\/$/, '')}/v1"
`;
      } else if (tool === 'qwen_code') {
        title = t('Qwen Code 配置');
        desc = t('将以下 JSON 写入') + ' <code>~/.qwen/settings.json</code>' + t('（或对应 OpenAI 兼容配置），然后重启 Qwen Code');
        content = JSON.stringify({
          general: { model: 'claude-fable-5' },
          providers: { crewrouter: { baseUrl: baseUrl.replace(/\/$/, '') + '/v1', apiKey, model: 'claude-fable-5' } }
        }, null, 2);
      } else if (tool === 'hermes') {
        title = t('Hermes 配置');
        desc = '设置环境变量 <code>OPENAI_BASE_URL / OPENAI_API_KEY</code>' + t('，或写入') + '<code>~/.hermes/config.json</code> 的 OpenAI 兼容段';
        content = `${t('# Hermes (OpenAI 兼容) → CrewRouter\\nOPENAI_BASE_URL=')}${baseUrl.replace(/\/$/, '')}/v1\nOPENAI_API_KEY=${apiKey}${t('\\n# model: claude-fable-5\\n# 也可写入 ~/.hermes/config.json:\\n# { \\"providers\\": { \\"crewrouter\\": { \\"baseUrl\\": \\"')}${baseUrl.replace(/\/$/, '')}/v1\", \"apiKey\": \"${apiKey}\" } } }`;
      } else if (tool === 'openclaw') {
        title = t('OpenClaw 配置');
        desc = t('将以下 JSON 合并到') + ' <code>~/.openclaw/openclaw.json</code> ' + t('的 providers 段');
        content = JSON.stringify({ providers: { crewrouter: { baseUrl: baseUrl.replace(/\/$/, '') + '/v1', apiKey, model: 'claude-fable-5' } } }, null, 2);
      }

      document.getElementById('configOutputTitle').textContent = title;
      if (!title || !content) {
        alert(t('未知工具类型: ') + tool);
        return;
      }
      setHTML(document.getElementById('configOutputDesc'), desc);
      document.getElementById('configOutputContent').value = content;
      this.showModal('configOutputModal');
    } catch (e) {
      alert(t('生成配置失败: ') + e.message);
    }
  }

  showCcSwitchSubmenu() {
    this.closeModals();
    this.showModal('ccSwitchSubmenuModal');
  }

  async generateCcSwitchLink(app) {
    const keyId = this._configKey?.id;
    if (!keyId) return;
    this.closeModals();

    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/config`);
      if (!res.ok) { alert(t('获取配置失败')); return; }
      const data = await res.json();
      const baseUrl = data.env.ANTHROPIC_BASE_URL;
      const apiKey = data.env.ANTHROPIC_AUTH_TOKEN;

      let config;
      const name = 'CrewRouter';

      if (app === 'claude') {
        config = { env: { ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: 'claude-fable-5' } };
      } else if (app === 'codex') {
        config = {
          auth: { OPENAI_API_KEY: apiKey },
          config: `[model_providers.openai]\nbase_url = "${baseUrl}"\n\n[general]\nmodel = "gpt-5.1"`
        };
      } else if (app === 'gemini') {
        config = { GEMINI_API_KEY: apiKey, GEMINI_BASE_URL: baseUrl + '/v1beta', GEMINI_MODEL: 'gemini-3-pro-preview' };
      }

      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
      const deepLink = `ccswitch://v1/import?resource=provider&app=${app}&name=${encodeURIComponent(name)}&configFormat=json&config=${encoded}`;

      // 直接跳转
      window.location.href = deepLink;
      this.showToast(t('正在调起 CC Switch...'), 'info');
    } catch (e) {
      alert(t('生成链接失败: ') + e.message);
    }
  }

  copyCcSwitchLink() {
    const text = document.getElementById('ccSwitchResultLink').value;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      this.showToast(t('已复制到剪贴板'), 'success');
    }).catch(() => {
      document.getElementById('ccSwitchResultLink').select();
      document.execCommand('copy');
      this.showToast(t('已复制到剪贴板'), 'success');
    });
  }

  copyConfigOutput() {
    const text = document.getElementById('configOutputContent').value;
    if (!text) return;

    const doCopy = async () => {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    };

    doCopy().then(ok => {
      if (ok) {
        const btn = event.target;
        const orig = btn.textContent;
        btn.textContent = t('已复制 ✓');
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    }).catch(() => {});
  }

  async generateUsageScript(keyId) {
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/config`);
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || t('生成脚本失败'));
        return;
      }
      const config = await res.json();
      this._ccsBaseUrl = config.env.ANTHROPIC_BASE_URL;
      this._ccsApiKey = config.env.ANTHROPIC_AUTH_TOKEN;

      // 重置选项
      document.getElementById('ccsShowBalance').checked = true;
      document.getElementById('ccsShowGroupRules').checked = true;
      document.getElementById('ccsShowTotalUsage').checked = true;
      document.getElementById('ccsShowUsername').checked = true;
      this._setCcsStyle('compact');

      this.rebuildUsageScript();
      this.showModal('usageScriptModal');
    } catch (e) {
      alert(t('生成脚本失败: ') + e.message);
    }
  }

  _setCcsStyle(style) {
    this._ccsStyle = style;
    document.querySelectorAll('#ccsStyleSegment .ccs-segment-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === style);
    });
    document.getElementById('ccsBarOptions').style.display = style === 'bar' ? 'block' : 'none';
    this.rebuildUsageScript();
  }

  rebuildUsageScript() {
    if (!this._ccsBaseUrl || !this._ccsApiKey) return;

    const showBalance = document.getElementById('ccsShowBalance').checked;
    const showGroupRules = document.getElementById('ccsShowGroupRules').checked;
    const showTotalUsage = document.getElementById('ccsShowTotalUsage').checked;
    const showUsername = document.getElementById('ccsShowUsername').checked;
    const isBarStyle = (this._ccsStyle || 'compact') === 'bar';
    const barLen = parseInt(document.getElementById('ccsBarLength')?.value) || 12;

    const baseUrl = this._ccsBaseUrl;
    const apiKey = this._ccsApiKey;

    // 构建 extractor 函数体
    let extractorLines = [];
    extractorLines.push('    if (response.error) {');
    extractorLines.push('      return { isValid: false, invalidMessage: response.error };');
    extractorLines.push('    }');
    extractorLines.push('');
    extractorLines.push('    var result = {');
    extractorLines.push('      isValid: true,');
    if (showUsername) {
      extractorLines.push('      planName: response.username || "CrewRouter",');
    } else {
      extractorLines.push('      planName: "CrewRouter",');
    }
    extractorLines.push('      unit: "balance"');
    extractorLines.push('    };');
    extractorLines.push('');
    extractorLines.push('    var parts = [];');

    // 用户组额度规则
    if (showGroupRules) {
      extractorLines.push('');
      extractorLines.push(t('    // 用户组额度规则'));
      extractorLines.push('    if (response.group && response.group.rules && response.group.rules.length > 0) {');
      extractorLines.push('      var primary = response.group.rules[0];');
      extractorLines.push('      result.total = primary.limit;');
      extractorLines.push('      result.used = primary.used;');
      extractorLines.push('      result.remaining = primary.remaining;');
      extractorLines.push('      for (var i = 1; i < response.group.rules.length; i++) {');
      extractorLines.push('        var rule = response.group.rules[i];');
      extractorLines.push('        var t = rule.type === "requests" ? "R" : "T";');
      if (isBarStyle) {
        extractorLines.push('        var pct = rule.limit > 0 ? Math.round(rule.used / rule.limit * 100) : 0;');
        extractorLines.push('        var filled = Math.round(pct / 100 * ' + barLen + ');');
        extractorLines.push('        var bar = "";');
        extractorLines.push('        for (var j = 0; j < ' + barLen + '; j++) {');
        extractorLines.push('          bar += j < filled ? "█" : "░";');
        extractorLines.push('        }');
        extractorLines.push('        parts.push(t + " " + bar + " " + rule.remaining.toLocaleString() + "/" + rule.limit.toLocaleString());');
      } else {
        extractorLines.push('        parts.push(t + " " + rule.remaining.toLocaleString() + "/" + rule.limit.toLocaleString());');
      }
      extractorLines.push('      }');
      extractorLines.push('    }');
    }

    // 总用量统计
    if (showTotalUsage) {
      extractorLines.push('');
      extractorLines.push(t('    // 总用量统计'));
      extractorLines.push('    if (response.total_requests !== undefined) {');
      extractorLines.push('      parts.push("Req " + response.total_requests.toLocaleString() + " Tok " + response.total_tokens.toLocaleString());');
      extractorLines.push('    }');
    }

    // 余额
    if (showBalance) {
      extractorLines.push('');
      extractorLines.push(t('    // 余额'));
      extractorLines.push('    if (response.balance !== undefined) {');
      extractorLines.push('      parts.push("$" + response.balance.toFixed(2));');
      extractorLines.push('    }');
    }

    extractorLines.push('');
    extractorLines.push('    if (parts.length > 0) result.extra = parts.join(" | ");');
    extractorLines.push('    return result;');

    const extractorBody = extractorLines.join('\n');

    const script = `// cc-switch 用量查询脚本
// 将此内容粘贴到 cc-switch 的「自定义查询脚本」中即可
({
  request: {
    url: "${baseUrl}/api/user/usage",
    method: "POST",
    headers: {
      "Authorization": "Bearer ${apiKey}",
      "User-Agent": "cc-switch/1.0"
    }
  },
  extractor: function(response) {
${extractorBody}
  }
})`;

    const ta = document.getElementById('usageScriptOutput');
    ta.value = script;
    // 更新行数显示
    const lineCount = script.split('\n').length;
    document.getElementById('ccsLineCount').textContent = `${lineCount}${t('行')}`;

    // 生成预览
    this._renderCcsPreview(showUsername, showGroupRules, showTotalUsage, showBalance, isBarStyle, barLen);
  }

  _renderCcsPreview(showUsername, showGroupRules, showTotalUsage, showBalance, isBarStyle, barLen) {
    const previewEl = document.getElementById('ccsPreview');
    if (!previewEl) return;

    // 模拟数据
    const mockRules = [
      { type: 'requests', limit: 9000, used: 0, remaining: 9000, window: t('1天') },
      { type: 'tokens', limit: 5000000, used: 1870000, remaining: 3130000, window: t('1天') }
    ];

    const parts = [];

    // extra：从第 2 个规则开始（第 1 个已由主显示展示）
    if (showGroupRules) {
      for (let i = 1; i < mockRules.length; i++) {
        const rule = mockRules[i];
        const t = rule.type === 'requests' ? 'R' : 'T';
        if (isBarStyle) {
          const pct = rule.limit > 0 ? Math.round(rule.used / rule.limit * 100) : 0;
          const filled = Math.round(pct / 100 * barLen);
          let bar = '';
          for (let j = 0; j < barLen; j++) {
            bar += j < filled ? '█' : '░';
          }
          parts.push(`${t} ${bar} ${rule.remaining.toLocaleString()}/${rule.limit.toLocaleString()}`);
        } else {
          parts.push(`${t} ${rule.remaining.toLocaleString()}/${rule.limit.toLocaleString()}`);
        }
      }
    }

    if (showTotalUsage) {
      parts.push('Req 12,847 Tok 8,234,561');
    }

    if (showBalance) {
      parts.push('$18.55');
    }

    // cc-switch 实际显示格式
    const previewLines = [];

    // 主规则（第一个）通过 total/used/remaining 展示
    if (showGroupRules) {
      const primary = mockRules[0];
      previewLines.push(t('已使用：'));
      previewLines.push(primary.used.toFixed(2));
      previewLines.push(t('剩余：'));
      previewLines.push(primary.remaining.toFixed(2));
    }

    previewLines.push('balance');

    // extra 单行
    if (parts.length > 0) {
      previewLines.push(parts.join(' | '));
    }

    previewEl.textContent = previewLines.join('\n');
  }

  copyUsageScript() {
    const text = document.getElementById('usageScriptOutput').value;
    if (!text) return;
    const doCopy = async () => {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    };
    doCopy().then(ok => {
      if (ok) {
        const btn = event.target;
        const orig = btn.textContent;
        btn.textContent = t('已复制 ✓');
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    }).catch(() => {});
  }

  showModal(id) {
    const modal = document.getElementById(id);
    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  closeModals() {
    document.querySelectorAll('.modal').forEach(m => {
      m.style.display = 'none';
      m.classList.remove('active');
    });
    this._summaryModalSessionKey = null;
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;top:20px;right:20px;z-index:10000;padding:12px 20px;border-radius:8px;font-size:14px;color:white;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:opacity 0.3s;opacity:0;`;
    toast.style.background = type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--info)';
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  async logout() {
    try {
      await fetch('/auth/logout');
    } catch (e) {}
    window.location.href = '/';
  }

  // ========== 2FA 管理 ==========
  async load2FAStatus() {
    try {
      const res = await fetch('/api/2fa/status', { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('获取 2FA 状态失败'));

      const statusBadge = document.getElementById('twoFactorStatus');
      const setupDiv = document.getElementById('twoFactorSetup');
      const disableDiv = document.getElementById('twoFactorDisable');
      const startBtn = document.getElementById('tfaStartBtn');

      if (!statusBadge) return;

      if (data.enabled) {
        statusBadge.textContent = t('已启用');
        statusBadge.style.background = 'rgba(34,197,94,0.1)';
        statusBadge.style.color = 'var(--success)';
        if (setupDiv) setupDiv.style.display = 'none';
        if (disableDiv) disableDiv.style.display = 'block';
        if (startBtn) startBtn.style.display = 'none';
      } else {
        statusBadge.textContent = t('未启用');
        statusBadge.style.background = 'rgba(239,68,68,0.1)';
        statusBadge.style.color = 'var(--destructive)';
        // 未在引导流程中时隐藏 setup；保留用户已打开的 setup 区域
        if (setupDiv && setupDiv.dataset.active !== '1') {
          setupDiv.style.display = 'none';
        }
        if (disableDiv) disableDiv.style.display = 'none';
        if (startBtn) {
          startBtn.style.display = setupDiv?.dataset.active === '1' ? 'none' : '';
        }
      }
    } catch (error) {
      console.error(t('加载 2FA 状态失败:'), error);
    }
  }

  async generate2FA() {
    const statusEl = document.getElementById('tfaSetupStatus');
    const startBtn = document.getElementById('tfaStartBtn');
    const setupDiv = document.getElementById('twoFactorSetup');

    try {
      if (startBtn) {
        startBtn.disabled = true;
        setButtonLoading(startBtn, t('生成中…'));
      }
      if (statusEl) {
        statusEl.textContent = '';
      }

      const res = await fetch('/api/2fa/generate', { credentials: 'same-origin' });
      const data = await res.json();

      if (!res.ok || !data.qrcode) {
        throw new Error(data.error || t('生成二维码失败'));
      }

      const qr = document.getElementById('twoFactorQR');
      const secretEl = document.getElementById('twoFactorSecret');
      if (qr) qr.src = data.qrcode;
      if (secretEl) secretEl.textContent = data.secret;
      if (setupDiv) {
        setupDiv.style.display = 'block';
        setupDiv.dataset.active = '1';
      }
      if (startBtn) startBtn.style.display = 'none';

      const codeInput = document.getElementById('tfaVerifyCode');
      if (codeInput) {
        codeInput.value = '';
        codeInput.focus();
      }
    } catch (error) {
      console.error(t('生成 2FA 失败:'), error);
      if (statusEl) {
        statusEl.textContent = error.message || t('生成 2FA 失败');
        statusEl.style.color = 'var(--destructive)';
      } else {
        alert(t('生成 2FA 失败: ') + (error.message || t('未知错误')));
      }
      // 确保 setup 区域可见以显示错误
      if (setupDiv) {
        setupDiv.style.display = 'block';
        setupDiv.dataset.active = '1';
      }
    } finally {
      if (startBtn) {
        startBtn.disabled = false;
        clearButtonLoading(startBtn, t('启用 2FA'));
      }
    }
  }

  cancel2FASetup() {
    const setupDiv = document.getElementById('twoFactorSetup');
    const startBtn = document.getElementById('tfaStartBtn');
    const statusEl = document.getElementById('tfaSetupStatus');
    const codeInput = document.getElementById('tfaVerifyCode');
    if (setupDiv) {
      setupDiv.style.display = 'none';
      setupDiv.dataset.active = '0';
    }
    if (startBtn) startBtn.style.display = '';
    if (statusEl) statusEl.textContent = '';
    if (codeInput) codeInput.value = '';
  }

  async enable2FA() {
    const codeInput = document.getElementById('tfaVerifyCode');
    const code = (codeInput?.value || '').replace(/\s/g, '');
    const statusEl = document.getElementById('tfaSetupStatus');
    const enableBtn = document.getElementById('tfaEnableBtn');

    if (!code || !/^\d{6}$/.test(code)) {
      if (statusEl) {
        statusEl.textContent = t('请输入6位验证码');
        statusEl.style.color = 'var(--destructive)';
      }
      return;
    }

    try {
      if (enableBtn) enableBtn.disabled = true;
      const res = await fetch('/api/2fa/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token: code }),
      });
      const data = await res.json();

      if (data.success) {
        if (statusEl) {
          statusEl.textContent = t('2FA 已成功启用');
          statusEl.style.color = 'var(--success)';
        }
        const setupDiv = document.getElementById('twoFactorSetup');
        if (setupDiv) setupDiv.dataset.active = '0';
        setTimeout(() => this.load2FAStatus(), 600);
      } else {
        if (statusEl) {
          statusEl.textContent = data.error || t('验证失败');
          statusEl.style.color = 'var(--destructive)';
        }
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = t('请求失败');
        statusEl.style.color = 'var(--destructive)';
      }
    } finally {
      if (enableBtn) enableBtn.disabled = false;
    }
  }

  async disable2FA() {
    const password = document.getElementById('tfaDisablePassword')?.value || '';
    const statusEl = document.getElementById('tfaDisableStatus');

    if (!password) {
      if (statusEl) {
        statusEl.textContent = t('请输入密码');
        statusEl.style.color = 'var(--destructive)';
      }
      return;
    }

    if (!await confirm(t('确定要关闭双重认证吗？'))) return;

    try {
      const res = await fetch('/api/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (data.success) {
        if (statusEl) {
          statusEl.textContent = t('2FA 已关闭');
          statusEl.style.color = 'var(--success)';
        }
        const pwdInput = document.getElementById('tfaDisablePassword');
        if (pwdInput) pwdInput.value = '';
        setTimeout(() => this.load2FAStatus(), 600);
      } else {
        if (statusEl) {
          statusEl.textContent = data.error || t('关闭失败');
          statusEl.style.color = 'var(--destructive)';
        }
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = t('请求失败');
        statusEl.style.color = 'var(--destructive)';
      }
    }
  }

  // ========== PassKey 管理 ==========

  // base64url 转 ArrayBuffer
  base64urlToBuffer(base64url) {
    if (!base64url) return new ArrayBuffer(0);

    let base64 = String(base64url)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const pad = base64.length % 4;
    if (pad) {
      base64 += '='.repeat(4 - pad);
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // ArrayBuffer 转 base64url
  bufferToBase64url(buffer) {
    if (!buffer) return '';
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  // 将服务端 PublicKey*OptionsJSON 转为 WebAuthn API 所需的 ArrayBuffer 字段
  preparePublicKeyOptions(options) {
    if (!options) return options;

    const result = { ...options };

    if (result.challenge && typeof result.challenge === 'string') {
      result.challenge = this.base64urlToBuffer(result.challenge);
    }

    if (result.user && result.user.id && typeof result.user.id === 'string') {
      result.user = {
        ...result.user,
        id: this.base64urlToBuffer(result.user.id),
      };
    }

    if (result.allowCredentials && Array.isArray(result.allowCredentials)) {
      result.allowCredentials = result.allowCredentials.map(cred => ({
        ...cred,
        id: typeof cred.id === 'string' ? this.base64urlToBuffer(cred.id) : cred.id,
      }));
    }

    if (result.excludeCredentials && Array.isArray(result.excludeCredentials)) {
      result.excludeCredentials = result.excludeCredentials.map(cred => ({
        ...cred,
        id: typeof cred.id === 'string' ? this.base64urlToBuffer(cred.id) : cred.id,
      }));
    }

    return result;
  }

  /**
   * 将浏览器 Credential 转为可 JSON 序列化的 Registration/AuthenticationResponseJSON
   * @param {PublicKeyCredential} credential
   * @param {'registration'|'authentication'} kind
   */
  preparePublicKeyResponse(credential, kind = 'registration') {
    if (!credential) return credential;

    const rawIdBase64url = this.bufferToBase64url(credential.rawId);
    const clientExtensionResults =
      typeof credential.getClientExtensionResults === 'function'
        ? credential.getClientExtensionResults()
        : {};

    const response = {
      clientDataJSON: this.bufferToBase64url(credential.response.clientDataJSON),
    };

    if (kind === 'registration') {
      response.attestationObject = this.bufferToBase64url(credential.response.attestationObject);
      if (typeof credential.response.getTransports === 'function') {
        try {
          response.transports = credential.response.getTransports();
        } catch (_) {
          /* ignore */
        }
      }
    } else {
      response.authenticatorData = this.bufferToBase64url(credential.response.authenticatorData);
      response.signature = this.bufferToBase64url(credential.response.signature);
      if (credential.response.userHandle) {
        response.userHandle = this.bufferToBase64url(credential.response.userHandle);
      }
    }

    return {
      id: rawIdBase64url,
      rawId: rawIdBase64url,
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults,
      response,
    };
  }

  async loadPasskeys() {
    try {
      const res = await fetch('/api/passkey/list', { credentials: 'same-origin' });
      if (!res.ok) return;
      const passkeys = await res.json();
      if (!Array.isArray(passkeys)) return;

      const container = document.getElementById('passkeyList');
      if (!container) return;

      if (passkeys.length === 0) {
        setHTML(container, '<li style="color:var(--muted-foreground);text-align:center;padding:20px;font-size:14px;">' + t('暂无绑定的通行密钥') + '</li>');
        return;
      }

      setHTML(container, passkeys.map(pk => {
        const safeId = (pk.credentialID || '').replace(/'/g, "\\'");
        const deviceLabel = pk.deviceType === 'multiDevice' ? t('同步通行密钥') : t('本机通行密钥');
        return `
        <li style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-weight:500;">${deviceLabel}</div>
            <div style="font-size:12px;color:var(--muted-foreground);font-family:monospace;">
              ID: ${pk.credentialID ? pk.credentialID.substring(0, 12) + '...' : 'Unknown'}
            </div>
            <div style="font-size:12px;color:var(--muted-foreground);">
              创建于: ${pk.createdAt ? new Date(pk.createdAt).toLocaleDateString('zh-CN') : t('未知')}
            </div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="app.deletePasskey('${safeId}')">删除</button>
        </li>`;
      }).join(''));
    } catch (error) {
      console.error(t('加载 PassKey 列表失败:'), error);
    }
  }

  async registerPasskey() {
    const statusEl = document.getElementById('passkeyStatus');
    const setStatus = (msg, ok) => {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.style.color = ok ? 'var(--success)' : 'var(--destructive)';
    };

    if (!window.PublicKeyCredential) {
      setStatus(t('当前浏览器不支持通行密钥'), false);
      alert(t('当前浏览器不支持通行密钥（WebAuthn）'));
      return;
    }

    try {
      setStatus(t('正在获取注册选项…'), true);
      const res = await fetch('/api/passkey/register/options', { credentials: 'same-origin' });
      const options = await res.json();
      if (!res.ok) {
        throw new Error(options.error || t('获取注册选项失败'));
      }

      const publicKeyOptions = this.preparePublicKeyOptions(options);
      setStatus(t('请在系统提示中完成验证…'), true);

      const credential = await navigator.credentials.create({
        publicKey: publicKeyOptions,
      });

      if (!credential) {
        throw new Error(t('用户取消了通行密钥创建'));
      }

      const serializedCredential = this.preparePublicKeyResponse(credential, 'registration');

      const verifyRes = await fetch('/api/passkey/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(serializedCredential),
      });

      const verifyData = await verifyRes.json();
      if (verifyData.success) {
        setStatus(t('通行密钥注册成功'), true);
        alert(t('PassKey 注册成功'));
        this.loadPasskeys();
      } else {
        throw new Error(verifyData.error || t('未知错误'));
      }
    } catch (error) {
      console.error(t('PassKey 注册失败:'), error);
      const msg = error.name === 'NotAllowedError'
        ? t('操作已取消或超时')
        : (error.message || t('注册失败'));
      setStatus(msg, false);
      alert(t('PassKey 注册失败: ') + msg);
    }
  }

  async deletePasskey(credentialID) {
    if (!await confirm(t('确定要删除此通行密钥吗？'))) return;

    try {
      const res = await fetch(`/api/passkey/${encodeURIComponent(credentialID)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (res.ok) {
        alert(t('PassKey 已删除'));
        this.loadPasskeys();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(t('删除失败: ') + (data.error || t('未知错误')));
      }
    } catch (error) {
      alert(t('删除失败'));
    }
  }

  // ==================== CrewRouter 模型库 ====================

  async loadModelLibrary() {
    try {
      const libraryRes = await fetch('/api/user/model-library');
      if (!libraryRes.ok) throw new Error(t('模型库接口异常'));
      const libraryData = await libraryRes.json();

      let currentModel = null;
      try {
        const currentModelRes = await fetch('/api/user/current-model');
        if (currentModelRes.ok) {
          const currentModelData = await currentModelRes.json();
          currentModel = currentModelData.currentModel;
        }
      } catch (e) {
        console.warn(t('加载当前模型失败:'), e);
      }

      // 存储原始数据用于筛选
      this._libraryData = libraryData;
      this._libraryCurrentModel = currentModel;

      // 加载用户的 API Keys 并渲染 Key 选择器
      await this._loadLibraryKeys();

      // 填充供应商筛选下拉框
      this._populateProviderFilter(libraryData);

      // 加载供应商标签（用于筛选下拉）
      try {
        const tagsRes = await fetch('/api/user/provider-tags');
        if (tagsRes.ok) this._providerTags = await tagsRes.json();
        else this._providerTags = [];
      } catch (_) { this._providerTags = []; }
      this._populateProviderTagFilter();
      this.loadTraceReports().catch(() => {});

      // 显示筛选控件
      const hasModels = libraryData.teams && libraryData.teams.some(t => t.providers && t.providers.length > 0);
      const filtersEl = document.getElementById('modelLibraryFilters');
      if (filtersEl) filtersEl.style.display = hasModels ? 'flex' : 'none';

      this.filterAndRenderModelLibrary();
      this._updateLibraryHiddenButtons();
      this._updateLibraryBindingBar();
      this._initLibraryStickyBar();
      this._syncLibraryStickyControlsFromState();

      // 渲染供应商额度（失败不影响模型库主体）：先展示缓存，后台刷新最新
      await this.loadProviderQuota();
      this._startQuotaBackgroundRefresh();
    } catch (error) {
      console.error(t('加载模型库失败:'), error);
      setHTML(document.getElementById('modelLibraryContent'), '<div class="empty-state"><p>' + t('加载失败，请刷新重试') + '</p></div>');
      this._updateLibraryBindingBar();
      this._syncLibraryStickyVisibility(false);
    }
  }

  async loadTraceReports() {
    const box = document.getElementById('traceReportsBanner');
    if (!box) return;
    const res = await fetch('/api/user/trace-sessions?unviewed=1');
    if (!res.ok) return;
    const reports = await res.json();
    if (!reports.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    box.innerHTML = `<div class="trace-reports-title">${t('未查看的跟踪报告')}</div><div class="trace-reports-list">${reports.map(r => `<button class="trace-report-chip" onclick="app.openTraceReport('${escapeHtml(r.public_id)}')"><strong>${escapeHtml(r.public_id)}</strong><span>${escapeHtml(r.api_key_name || t('已删除 Key'))}</span><span>${Number(r.summary?.requests || 0)} 项请求</span></button>`).join('')}</div>`;
  }

  async openTraceReport(publicId) {
    const res = await fetch(`/api/user/trace-sessions/${encodeURIComponent(publicId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const session = data.session || {};
    const events = data.events || [];
    const semanticsMeta = {
      primary: { label: '主对话', color: 'var(--muted-foreground)' },
      subagent: { label: '子代理', color: 'var(--primary)' },
      title: { label: '标题', color: 'var(--purple)' },
      compaction: { label: '压缩', color: 'var(--warning)' },
      retry: { label: '重试', color: 'var(--status-warn)' },
      plan: { label: '计划', color: 'var(--status-success)' },
      review: { label: '评审', color: 'var(--status-danger)' },
      heartbeat: { label: '心跳', color: 'var(--muted-foreground)' },
      other_automation: { label: '其他自动', color: 'var(--text-muted-soft)' },
      unknown: { label: '未知', color: 'var(--muted-foreground)' },
    };
    const renderSemantics = semantics => {
      const type = semantics?.type || 'unknown';
      const meta = semanticsMeta[type] || semanticsMeta.unknown;
      const reasonCodes = Array.isArray(semantics?.reason_codes) ? semantics.reason_codes : [];
      const title = reasonCodes.length ? ` title="${escapeHtml(reasonCodes.join(', '))}"` : '';
      return `<span class="badge"${title} style="color:${meta.color};border:1px solid ${meta.color};">${escapeHtml(meta.label)}</span>`;
    };
    const rows = events.map(e => `<tr><td>${escapeHtml(new Date(e.created_at).toLocaleString('zh-CN', { hour12: false }))}</td><td>${escapeHtml(e.request_type || '-')}</td><td>${renderSemantics(e.semantics)}</td><td>${escapeHtml(e.model_id || '-')}</td><td>${e.ok ? t('成功') : t('失败')}</td><td title="${Number(e.tokens_used || 0).toLocaleString()}">${this._formatBigNumber(Number(e.tokens_used || 0))}</td><td>${e.latency_ms == null ? '-' : `${e.latency_ms} ms`}</td></tr>`).join('');
    const detail = document.createElement('div');
    detail.className = 'trace-report-modal';
    detail.innerHTML = `${'<div class="trace-report-dialog"><div class="trace-report-dialog-head"><h3>' + t('跟踪报告')}${escapeHtml(session.public_id)}${'</h3><button class="btn btn-secondary btn-sm" onclick="this.closest(\'.trace-report-modal\').remove()">' + t('关闭')}</button></div><p>请求${Number(session.summary?.requests || events.length)}${t('项 · 成功')}${Number(session.summary?.succeeded || 0)}${t('· 失败')}${Number(session.summary?.failed || 0)} · ${this._formatBigNumber(Number(session.summary?.tokens || 0))} tokens</p><div class="trace-report-actions"><a class="btn btn-secondary btn-sm" href="/api/user/trace-sessions/${encodeURIComponent(publicId)}/export?format=json">${t('下载 JSON')}</a><a class="btn btn-secondary btn-sm" href="/api/user/trace-sessions/${encodeURIComponent(publicId)}/export?format=csv">下载 CSV</a></div><div class="trace-report-table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>${t('语义')}</th><th>模型</th><th>状态</th><th>Tokens</th><th>延迟</th></tr></thead><tbody>${rows || '<tr><td colspan="7">暂无事件</td></tr>'}</tbody></table></div></div>`;
    document.body.appendChild(detail);
    detail.addEventListener('click', e => { if (e.target === detail) detail.remove(); });
    this.loadTraceReports().catch(() => {});
  }

  async loadMyProvidersPage() {
    try {
      const res = await fetch('/api/user/my-providers');
      if (!res.ok) return;
      const providers = await res.json();

      const container = document.getElementById('myProvidersTable');
      if (!providers.length) {
        setHTML(container, `
          <div class="empty-state" style="padding:60px 20px;text-align:center;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" style="margin-bottom:16px;opacity:0.5;">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
            </svg>
            <p style="font-size:15px;color:var(--muted-foreground);margin:0;">暂无供应商</p>
            <p style="font-size:13px;color:var(--muted-foreground);margin:8px 0 0;opacity:0.7;">点击上方${t('添加供应商')}按钮开始</p>
          </div>
        `);
        return;
      }

      setHTML(container, `
        <table>
          <thead>
            <tr>
              <th style="width:40px;"><input type="checkbox" onchange="app.toggleSelectAllProviders(this.checked)"></th>
              <th>名称</th>
              <th>Base URL</th>
              <th>格式</th>
              <th>延迟</th>
              <th>模型数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${providers.map(p => `
              <tr data-provider-id="${escapeHtml(p.id)}">
                <td><input type="checkbox" class="provider-checkbox" value="${escapeHtml(p.id)}" onchange="app.updateBatchButtons()"></td>
                <td>
                  <div style="font-weight:500;">${escapeHtml(p.name)}</div>
                  <div style="font-size:11px;color:var(--muted-foreground);font-family:monospace;">${escapeHtml(p.id)}</div>
                </td>
                <td>
                  <div style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(p.base_url)}">${escapeHtml(p.base_url)}</div>
                </td>
                <td><span style="font-size:12px;">${escapeHtml(formatDisplayName(p.format))}</span></td>
                <td>
                  <div id="user-ping-page-${p.id}" style="min-width:60px;font-size:12px;color:var(--muted-foreground);">-</div>
                </td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="app.showManageModelsModal('${escapeHtml(p.id)}')" title="${t('管理模型')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>
                    模型
                  </button>
                </td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-secondary" onclick="app.pingUserProvider('${escapeHtml(p.id)}')" title="${t('检测连通性')}">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="app.editMyProvider('${escapeHtml(p.id)}')">编辑</button>
                    <button class="btn btn-sm" style="color:var(--destructive);background:transparent;border:1px solid var(--border);" onclick="app.deleteMyProvider('${escapeHtml(p.id)}')">删除</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `);
    } catch (error) {
      console.error(t('加载供应商页面失败:'), error);
    }
  }

  toggleSelectAllProviders(checked) {
    document.querySelectorAll('.provider-checkbox').forEach(cb => {
      cb.checked = checked;
    });
    this.updateBatchButtons();
  }

  updateBatchButtons() {
    const checked = document.querySelectorAll('.provider-checkbox:checked');
    const batchBtn = document.getElementById('batchDeleteBtn');
    if (batchBtn) {
      batchBtn.style.display = checked.length > 0 ? 'inline-flex' : 'none';
    }
  }

  async batchDeleteProviders() {
    const checked = document.querySelectorAll('.provider-checkbox:checked');
    const ids = Array.from(checked).map(cb => cb.value);

    if (!ids.length) return;
    if (!await confirm(`${t('确定要删除选中的')}${ids.length}${t('个供应商吗？关联的模型也会被删除。')}`)) return;

    let successCount = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`/api/user/providers/${id}`, { method: 'DELETE' });
        if (res.ok) successCount++;
      } catch (e) {
        console.error(`${t('删除供应商')}${id}${t('失败:')}`, e);
      }
    }

    this.showToast(`${t('已删除')}${successCount}${t('个供应商')}`, 'success');
    await this.loadMyProvidersPage();
  }

  toggleMyProviders() {
    // 模型库页内嵌区块已移除，保留方法避免旧调用报错
    this.navigateTo('myUpstream');
  }

  async loadMyUpstreamPage() {
    const tab = this._pendingUpstreamTab || this._myUpstreamTab || 'providers';
    this._pendingUpstreamTab = null;
    this.switchMyUpstreamTab(tab, { skipLoad: true });
    if (tab === 'models') {
      await this.loadMyTeamModels();
    } else {
      await this.loadMyProvidersPage();
    }
  }

  switchMyUpstreamTab(tab, options = {}) {
    const next = tab === 'models' ? 'models' : 'providers';
    this._myUpstreamTab = next;

    document.querySelectorAll('.my-upstream-tab').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-upstream-tab') === next);
    });

    const providersPane = document.getElementById('myUpstreamProvidersPane');
    const modelsPane = document.getElementById('myUpstreamModelsPane');
    const providerActions = document.getElementById('myUpstreamProviderActions');
    const modelActions = document.getElementById('myUpstreamModelActions');
    const hint = document.getElementById('myUpstreamHint');

    if (providersPane) providersPane.style.display = next === 'providers' ? 'block' : 'none';
    if (modelsPane) modelsPane.style.display = next === 'models' ? 'block' : 'none';
    if (providerActions) providerActions.style.display = next === 'providers' ? 'flex' : 'none';
    if (modelActions) modelActions.style.display = next === 'models' ? 'flex' : 'none';
    if (hint) {
      hint.textContent = next === 'models'
        ? t('管理个人 Team 下的模型（启用、价格、别名等）。也可从「供应商」页签刷新导入。')
        : t('管理自有上游供应商；导入的模型会出现在「模型」页签，也可在模型库中绑定到 API Key。');
    }

    // 页签切换同步到 URL hash，便于刷新/分享
    if (!options.skipHash && this.currentPage === 'myUpstream') {
      this._ignoreHashChange = true;
      this._writeConsoleHash('myUpstream', { upstreamTab: next });
      queueMicrotask(() => { this._ignoreHashChange = false; });
    }

    if (!options.skipLoad && this.currentPage === 'myUpstream') {
      if (next === 'models') this.loadMyTeamModels();
      else this.loadMyProvidersPage();
    }
  }

  async editMyProvider(providerId) {
    try {
      // 获取供应商信息
      const res = await fetch('/api/user/my-providers');
      if (!res.ok) return;
      const providers = await res.json();
      const provider = providers.find(p => p.id === providerId);
      if (!provider) {
        alert(t('未找到供应商信息'));
        return;
      }

      // 填充编辑表单
      document.getElementById('editProviderId').value = provider.id;
      document.getElementById('editProviderName').textContent = provider.name;
      document.getElementById('editProviderBaseUrl').value = provider.base_url || '';
      document.getElementById('editProviderApiKey').value = '';
      document.getElementById('editProviderFormat').value = provider.format || 'openai';
      document.getElementById('editProviderError').style.display = 'none';

      this.showModal('editProviderModal');
    } catch (error) {
      console.error(t('获取供应商信息失败:'), error);
      alert(t('获取供应商信息失败'));
    }
  }

  async updateProvider() {
    const errorEl = document.getElementById('editProviderError');
    errorEl.style.display = 'none';

    const providerId = document.getElementById('editProviderId').value;
    const baseUrl = document.getElementById('editProviderBaseUrl').value.trim();
    const apiKey = document.getElementById('editProviderApiKey').value.trim();
    const format = document.getElementById('editProviderFormat').value;

    if (!baseUrl) {
      errorEl.textContent = t('请输入 Base URL');
      errorEl.style.display = 'block';
      return;
    }

    try {
      const body = { base_url: baseUrl, format };
      if (apiKey) body.api_key = apiKey;

      const res = await fetch(`/api/user/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || t('保存失败');
        errorEl.style.display = 'block';
        return;
      }

      this.closeModals();
      this.showToast(t('供应商已更新'), 'success');
      await this.loadModelLibrary();
    } catch (error) {
      errorEl.textContent = t('网络错误，请重试');
      errorEl.style.display = 'block';
    }
  }

  async pingUserProvider(providerId) {
    const display = document.getElementById(`user-ping-${providerId}`);
    const pageDisplay = document.getElementById(`user-ping-page-${providerId}`);
    const libDisplays = document.querySelectorAll(`.lib-ping[data-provider-id="${providerId}"]`);
    const pingHtml = inlineLoadingHtml(t('检测中...'), 'sm');
    if (display) setHTML(display, pingHtml);
    if (pageDisplay) setHTML(pageDisplay, pingHtml);
    libDisplays.forEach(el => setHTML(el, pingHtml));

    try {
      const resp = await fetch(`/api/user/providers/${providerId}/ping`);
      const data = await resp.json();
      const resultHtml = data.ok
        ? `<span style="color:${data.latency_ms <= 300 ? 'var(--success)' : data.latency_ms <= 1000 ? 'var(--warning)' : 'var(--destructive)'};font-weight:500;">${data.latency_ms}ms</span>`
        : `<span style="color:var(--destructive);" title="${escapeHtml(data.error || '')}">${t('失败')}</span>`;
      if (display) setHTML(display, resultHtml);
      if (pageDisplay) setHTML(pageDisplay, resultHtml);
      libDisplays.forEach(el => setHTML(el, resultHtml));
    } catch (e) {
      const errHtml = '<span style="color:var(--destructive);">' + t('错误') + '</span>';
      if (display) setHTML(display, errHtml);
      if (pageDisplay) setHTML(pageDisplay, errHtml);
      libDisplays.forEach(el => setHTML(el, errHtml));
    }
  }

  pingLibraryProvider(providerId) {
    this.pingUserProvider(providerId);
  }

  async pingAllLibraryProviders() {
    const item = document.getElementById('pingAllLibProvidersBtn');
    const prevText = item?.textContent;
    if (item) setHTML(item, inlineLoadingHtml(t('检测中...'), 'sm'));

    const pingBtns = document.querySelectorAll('.lib-ping[data-provider-id]');
    const providerIds = [...new Set(Array.from(pingBtns).map(el => el.dataset.providerId))];

    if (!providerIds.length) {
      this.showToast(t('暂无可检测的供应商，请先展开列表'), 'info');
    } else {
      await Promise.allSettled(providerIds.map(id => this.pingUserProvider(id)));
      this.showToast(`${t('已检测')}${providerIds.length}${t('个供应商')}`, 'success');
    }

    if (item) item.textContent = prevText || t('一键检测连通性');
  }

  async deleteMyProvider(providerId) {
    if (!await confirm(t('确定要删除此供应商吗？关联的模型也会被删除。'))) return;

    try {
      const res = await fetch(`/api/user/providers/${providerId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('删除失败'));
        return;
      }
      this.showToast(t('供应商已删除'), 'success');
      await this.loadModelLibrary();
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  async refreshProviderModels(providerId) {
    try {
      this.showToast(t('正在获取模型列表...'), 'info');
      const res = await fetch(`/api/user/providers/${providerId}/refresh-models`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('刷新失败'));
        return;
      }
      this.showToast(`${t('已添加')}${data.added}${t('个新模型（共')}${data.total}${t('个）')}`, 'success');
      await this.loadModelLibrary();
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  // 管理模型功能
  async showManageModelsModal(providerId) {
    this._currentManageProviderId = providerId;
    this._currentManageModels = [];

    // 显示模态框
    document.getElementById('manageModelsTitle').textContent = t('管理模型');
    document.getElementById('manageModelsLoading').style.display = 'block';
    document.getElementById('manageModelsError').style.display = 'none';
    document.getElementById('manageModelsContent').style.display = 'none';
    document.getElementById('manageModelsFooter').style.display = 'none';
    this.showModal('manageModelsModal');

    try {
      const res = await fetch(`/api/user/providers/${providerId}/models`);
      if (!res.ok) throw new Error(t('获取模型列表失败'));
      const models = await res.json();

      this._currentManageModels = models;
      this.renderManageModels(models);
    } catch (error) {
      document.getElementById('manageModelsLoading').style.display = 'none';
      document.getElementById('manageModelsError').style.display = 'block';
      document.getElementById('manageModelsError').textContent = error.message;
    }
  }

  renderManageModels(models) {
    document.getElementById('manageModelsLoading').style.display = 'none';
    document.getElementById('manageModelsContent').style.display = 'block';
    document.getElementById('manageModelsFooter').style.display = 'flex';
    document.getElementById('manageModelsSearch').value = '';

    this._renderManageModelsList(models);
  }

  _renderManageModelsList(models) {
    const container = document.getElementById('manageModelsList');
    const countEl = document.getElementById('manageModelsCount');
    document.getElementById('selectAllManageModels').checked = false;

    countEl.textContent = `${t('共')}${models.length}${t('个模型')}`;

    if (models.length === 0) {
      setHTML(container, `
        <div style="text-align:center;padding:40px;color:var(--muted-foreground);">
          <p>暂无模型</p>
          <p style="font-size:13px;">点击${t('刷新列表')}从供应商获取模型</p>
        </div>
      `);
      return;
    }

    setHTML(container, models.map((model, index) => `
      <div class="model-check-item" data-model-id="${model.id}" data-model-name="${model.name || ''}">
        <input type="checkbox" class="manage-model-checkbox" id="manageModel_${index}" value="${model.id}" onchange="app._updateManageModelsBatchBar()">
        <label for="manageModel_${index}" style="flex:1;cursor:pointer;">
          <span style="font-weight:500;">${escapeHtml(model.name || model.id)}</span>
          ${model.name && model.name !== model.id ? `<span style="font-size:12px;color:var(--muted-foreground);margin-left:8px;">${escapeHtml(model.id)}</span>` : ''}
          ${model.series ? `<span style="font-size:11px;background:var(--muted);padding:2px 6px;border-radius:4px;margin-left:8px;">${escapeHtml(model.series)}</span>` : ''}
          ${model.enabled === false ? '<span style="font-size:11px;color:var(--destructive);margin-left:8px;">' + t('已禁用') + '</span>' : ''}
        </label>
      </div>
    `).join(''));

    this._updateManageModelsBatchBar();
  }

  filterManageModels(keyword) {
    const kw = keyword.toLowerCase();
    const filtered = this._currentManageModels.filter(m =>
      (m.name || '').toLowerCase().includes(kw) ||
      (m.id || '').toLowerCase().includes(kw) ||
      (m.series || '').toLowerCase().includes(kw)
    );
    this._renderManageModelsList(filtered);
  }

  toggleSelectAllManageModels(checked) {
    document.querySelectorAll('.manage-model-checkbox').forEach(cb => {
      cb.checked = checked;
    });
    this._updateManageModelsBatchBar();
  }

  async refreshProviderModelsForManage() {
    const providerId = this._currentManageProviderId;
    if (!providerId) return;

    try {
      this.showToast(t('正在刷新模型列表...'), 'info');
      const res = await fetch(`/api/user/providers/${providerId}/refresh-models`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('刷新失败'));
        return;
      }
      this.showToast(`${t('已添加')}${data.added}${t('个新模型')}`, 'success');
      // 重新加载模型列表
      await this.showManageModelsModal(providerId);
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  async saveManagedModels() {
    const checked = document.querySelectorAll('.manage-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);

    if (!modelIds.length) {
      this.closeModals();
      return;
    }

    if (!await confirm(`${t('确定要删除选中的')}${modelIds.length}${t('个模型吗？')}`)) return;

    const providerId = this._currentManageProviderId;
    try {
      const res = await fetch(`/api/user/providers/${providerId}/models/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('删除失败'));
        return;
      }

      this.showToast(`${t('已删除')}${data.deleted}${t('个模型')}`, 'success');
      this.closeModals();
      await this.loadMyProvidersPage();
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  // 批量操作函数
  _updateManageModelsBatchBar() {
    const checked = document.querySelectorAll('.manage-model-checkbox:checked');
    const count = checked.length;
    const batchBar = document.getElementById('manageModelsBatchBar');
    const countEl = document.getElementById('manageModelsSelectedCount');

    if (batchBar) {
      batchBar.style.display = count > 0 ? 'flex' : 'none';
    }
    if (countEl) {
      countEl.textContent = count;
    }
  }

  async batchEnableModels(enabled) {
    const checked = document.querySelectorAll('.manage-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);

    if (!modelIds.length) return;

    const action = enabled ? t('启用') : t('禁用');
    if (!await confirm(`${t('确定要')}${action}${t('选中的')}${modelIds.length}${t('个模型吗？')}`)) return;

    const providerId = this._currentManageProviderId;
    try {
      const res = await fetch(`/api/user/providers/${providerId}/models/batch-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds, updates: { enabled } })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || `${action}${t('失败')}`);
        return;
      }

      this.showToast(`${t('已')}${action} ${data.updated}${t('个模型')}`, 'success');
      await this.showManageModelsModal(providerId);
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  async batchDeleteManagedModels() {
    const checked = document.querySelectorAll('.manage-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);

    if (!modelIds.length) return;
    if (!await confirm(`${t('确定要删除选中的')}${modelIds.length}${t('个模型吗？')}`)) return;

    const providerId = this._currentManageProviderId;
    try {
      const res = await fetch(`/api/user/providers/${providerId}/models/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('删除失败'));
        return;
      }

      this.showToast(`${t('已删除')}${data.deleted}${t('个模型')}`, 'success');
      await this.showManageModelsModal(providerId);
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  showBatchPriceDialog() {
    document.getElementById('batchInputPrice').value = '';
    document.getElementById('batchOutputPrice').value = '';
    document.getElementById('batchCachedPrice').value = '';
    this.showModal('batchPriceModal');
  }

  async executeBatchSetPrices() {
    const checked = document.querySelectorAll('.manage-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);

    if (!modelIds.length) return;

    const inputPrice = document.getElementById('batchInputPrice').value;
    const outputPrice = document.getElementById('batchOutputPrice').value;
    const cachedPrice = document.getElementById('batchCachedPrice').value;

    const updates = {};
    if (inputPrice !== '') updates.input_price_per_1k_tokens = parseFloat(inputPrice);
    if (outputPrice !== '') updates.output_price_per_1k_tokens = parseFloat(outputPrice);
    if (cachedPrice !== '') updates.cached_output_price_per_1k_tokens = parseFloat(cachedPrice);

    if (Object.keys(updates).length === 0) {
      alert(t('请至少填写一项价格'));
      return;
    }

    const providerId = this._currentManageProviderId;
    try {
      const res = await fetch(`/api/user/providers/${providerId}/models/batch-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds, updates })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('设置失败'));
        return;
      }

      this.showToast(`${t('已更新')}${data.updated}${t('个模型的价格')}`, 'success');
      this.closeModals();
      await this.showManageModelsModal(providerId);
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  // ==================== 我的模型（个人 Team 模型管理）====================

  _myTeamModels = [];
  _myTeamModelsFiltered = [];

  async loadMyTeamModels() {
    try {
      const res = await fetch('/api/user/my-team-models');
      if (!res.ok) throw new Error(t('获取模型列表失败'));
      this._myTeamModels = await res.json();
      this._myTeamModelsFiltered = [...this._myTeamModels];
      this._renderMyTeamModels(this._myTeamModelsFiltered);
    } catch (error) {
      console.error(t('加载个人Team模型失败:'), error);
      setHTML(document.getElementById('myTeamModelsTable'), '<div class="empty-state"><p>' + t('加载失败，请刷新重试') + '</p></div>');
    }
  }

  _renderMyTeamModels(models) {
    const container = document.getElementById('myTeamModelsTable');
    const countEl = document.getElementById('myTeamModelsCount');
    countEl.textContent = `${t('共')}${models.length}${t('个模型')}`;

    // 更新批量按钮显示
    this.updateMyModelsBatchButtons();

    if (models.length === 0) {
      setHTML(container, `
        <div class="empty-state" style="padding:60px 20px;text-align:center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" style="margin-bottom:16px;opacity:0.5;">
            <rect x="2" y="2" width="20" height="20" rx="2" ry="2"/>
            <path d="M7 7h10M7 12h10M7 17h6"/>
          </svg>
          <p style="font-size:15px;color:var(--muted-foreground);margin:0;">暂无模型</p>
          <p style="font-size:13px;color:var(--muted-foreground);margin:8px 0 0;opacity:0.7;">通过供应商刷新导入模型后会自动出现在这里</p>
        </div>
      `);
      return;
    }

    setHTML(container, `
      <table>
        <thead>
          <tr>
            <th style="width:40px;"><input type="checkbox" onchange="app.toggleSelectAllMyTeamModels(this.checked)"></th>
            <th>模型名称</th>
            <th>上游模型ID</th>
            <th>供应商</th>
            <th>系列</th>
            <th>倍率</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${models.map(m => `
            <tr data-model-id="${escapeHtml(m.id)}">
              <td><input type="checkbox" class="my-team-model-checkbox" value="${escapeHtml(m.id)}" onchange="app.updateMyModelsBatchButtons()"></td>
              <td>
                <div style="font-weight:500;">${escapeHtml(m.alias || m.name || m.id)}</div>
                ${m.description ? `<div style="font-size:11px;color:var(--muted-foreground);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(m.description)}">${escapeHtml(m.description)}</div>` : ''}
              </td>
              <td><code style="font-size:12px;color:var(--muted-foreground);">${escapeHtml(m.upstream_model_id || m.name || m.id)}</code></td>
              <td><span style="font-size:13px;">${escapeHtml(m.provider_name || m.provider || '-')}</span></td>
              <td>${m.series ? `<span style="font-size:11px;background:var(--muted);padding:2px 6px;border-radius:4px;">${escapeHtml(m.series)}</span>` : '<span style="color:var(--muted-foreground);font-size:12px;">-</span>'}</td>
              <td style="font-size:13px;">×${parseFloat(m.model_multiplier || 1.0).toFixed(2)}</td>
              <td>${m.enabled !== false
                ? '<span style="font-size:11px;color:var(--success,var(--brand-green,var(--success)));">' + t('● 启用') + '</span>'
                : '<span style="font-size:11px;color:var(--destructive);">' + t('● 禁用') + '</span>'
              }</td>
              <td>
                <div style="display:flex;gap:4px;">
                  <button class="btn btn-sm btn-secondary" onclick="app.editMyTeamModel('${escapeHtml(m.id)}')">编辑</button>
                  <button class="btn btn-sm" style="color:var(--destructive);background:transparent;border:1px solid var(--border);" onclick="app.deleteMyTeamModel('${escapeHtml(m.id)}')">删除</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `);
  }

  filterMyTeamModels(keyword) {
    const kw = keyword.toLowerCase();
    this._myTeamModelsFiltered = this._myTeamModels.filter(m =>
      (m.name || '').toLowerCase().includes(kw) ||
      (m.alias || '').toLowerCase().includes(kw) ||
      (m.id || '').toLowerCase().includes(kw) ||
      (m.provider || '').toLowerCase().includes(kw) ||
      (m.provider_name || '').toLowerCase().includes(kw) ||
      (m.series || '').toLowerCase().includes(kw)
    );
    this._renderMyTeamModels(this._myTeamModelsFiltered);
  }

  toggleSelectAllMyTeamModels(checked) {
    document.querySelectorAll('.my-team-model-checkbox').forEach(cb => {
      cb.checked = checked;
    });
    this.updateMyModelsBatchButtons();
  }

  updateMyModelsBatchButtons() {
    const checked = document.querySelectorAll('.my-team-model-checkbox:checked');
    const count = checked.length;
    const ids = ['batchEnableMyModelsBtn', 'batchDisableMyModelsBtn', 'batchEditMyModelsBtn', 'batchDeleteMyModelsBtn'];
    ids.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = count > 0 ? 'inline-flex' : 'none';
    });
  }

  async batchDeleteMyTeamModels() {
    const checked = document.querySelectorAll('.my-team-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);
    if (!modelIds.length) return;
    if (!await confirm(`${t('确定要删除选中的')}${modelIds.length}${t('个模型吗？此操作不可撤销。')}`)) return;

    try {
      const res = await fetch('/api/user/my-team-models/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('删除失败'));
        return;
      }
      this.showToast(`${t('已删除')}${data.deleted}${t('个模型')}`, 'success');
      await this.loadMyTeamModels();
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  async batchEnableMyTeamModels() {
    await this._batchUpdateMyTeamModels({ enabled: true }, t('启用'));
  }

  async batchDisableMyTeamModels() {
    await this._batchUpdateMyTeamModels({ enabled: false }, t('禁用'));
  }

  async _batchUpdateMyTeamModels(updates, action) {
    const checked = document.querySelectorAll('.my-team-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);
    if (!modelIds.length) return;
    if (!await confirm(`${t('确定要')}${action}${t('选中的')}${modelIds.length}${t('个模型吗？')}`)) return;

    try {
      const res = await fetch('/api/user/my-team-models/batch-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds, updates })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || `${action}${t('失败')}`);
        return;
      }
      this.showToast(`${t('已')}${action} ${data.updated}${t('个模型')}`, 'success');
      await this.loadMyTeamModels();
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  showBatchEditMyModelsModal() {
    const checked = document.querySelectorAll('.my-team-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);
    if (!modelIds.length) return;

    document.getElementById('batchEditMyModelsInfo').textContent = `${t('已选择')}${modelIds.length}${t('个模型')}`;

    // 重置所有 checkbox 和字段
    ['Enabled', 'Series', 'Desc', 'Alias', 'InputPrice', 'OutputPrice'].forEach(field => {
      const check = document.getElementById(`batchEditMyModels${field}Check`);
      const input = document.getElementById(`batchEditMyModels${field}`);
      if (check) check.checked = false;
      if (input) { input.value = ''; input.disabled = true; }
    });

    this.showModal('batchEditMyModelsModal');

    // 绑定 checkbox 切换事件
    ['Enabled', 'Series', 'Desc', 'Alias', 'InputPrice', 'OutputPrice'].forEach(field => {
      const check = document.getElementById(`batchEditMyModels${field}Check`);
      const input = document.getElementById(`batchEditMyModels${field}`);
      if (check && input) {
        check.onchange = () => { input.disabled = !check.checked; };
      }
    });
  }

  async saveBatchEditMyModels() {
    const checked = document.querySelectorAll('.my-team-model-checkbox:checked');
    const modelIds = Array.from(checked).map(cb => cb.value);
    if (!modelIds.length) return;

    const updates = {};

    const enabledCheck = document.getElementById('batchEditMyModelsEnabledCheck');
    if (enabledCheck.checked) {
      updates.enabled = document.getElementById('batchEditMyModelsEnabled').value === 'true';
    }
    const seriesCheck = document.getElementById('batchEditMyModelsSeriesCheck');
    if (seriesCheck.checked) {
      updates.series = document.getElementById('batchEditMyModelsSeries').value.trim();
    }
    const descCheck = document.getElementById('batchEditMyModelsDescCheck');
    if (descCheck.checked) {
      updates.description = document.getElementById('batchEditMyModelsDesc').value.trim();
    }
    const aliasCheck = document.getElementById('batchEditMyModelsAliasCheck');
    if (aliasCheck.checked) {
      updates.alias = document.getElementById('batchEditMyModelsAlias').value.trim();
    }
    const inputPriceCheck = document.getElementById('batchEditMyModelsInputPriceCheck');
    if (inputPriceCheck.checked) {
      const val = document.getElementById('batchEditMyModelsInputPrice').value;
      if (val !== '') updates.input_price_per_1k_tokens = parseFloat(val);
    }
    const outputPriceCheck = document.getElementById('batchEditMyModelsOutputPriceCheck');
    if (outputPriceCheck.checked) {
      const val = document.getElementById('batchEditMyModelsOutputPrice').value;
      if (val !== '') updates.output_price_per_1k_tokens = parseFloat(val);
    }

    if (Object.keys(updates).length === 0) {
      alert(t('请至少勾选一项进行编辑'));
      return;
    }

    try {
      const res = await fetch('/api/user/my-team-models/batch-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds, updates })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('更新失败'));
        return;
      }
      this.showToast(`${t('已更新')}${data.updated}${t('个模型')}`, 'success');
      this.closeModals();
      await this.loadMyTeamModels();
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  async editMyTeamModel(modelId) {
    const model = this._myTeamModels.find(m => m.id === modelId);
    if (!model) { alert(t('模型不存在')); return; }

    // 复用已有的编辑模态框
    this._editingModelId = modelId;
    document.getElementById('addEditModelTitle').textContent = t('编辑模型');
    document.getElementById('confirmAddEditModel').textContent = t('保存');
    document.getElementById('addEditModelError').style.display = 'none';

    // 从 _myTeamModels 数据填充表单
    document.getElementById('editModelId').value = modelId;
    setHTML(document.getElementById('modelFormProvider'), `<option value="${escapeHtml(model.provider)}" selected>${escapeHtml(model.provider_name || model.provider)}</option>`);
    document.getElementById('modelFormProvider').disabled = true;
    document.getElementById('modelFormId').value = modelId;
    document.getElementById('modelFormUpstreamId').value = model.upstream_model_id || '';
    document.getElementById('modelFormAlias').value = model.alias || '';
    document.getElementById('modelFormDescription').value = model.description || '';
    document.getElementById('modelFormSeries').value = model.series || '';
    document.getElementById('modelFormInputPrice').value = model.input_price_per_1k_tokens || 0;
    document.getElementById('modelFormOutputPrice').value = model.output_price_per_1k_tokens || 0;
    document.getElementById('modelFormCachedPrice').value = model.cached_output_price_per_1k_tokens || 0;
    document.getElementById('modelFormRefInputPrice').value = model.reference_input_price_per_1k_tokens || 0;
    document.getElementById('modelFormRefOutputPrice').value = model.reference_output_price_per_1k_tokens || 0;
    document.getElementById('modelFormThinkingModel').value = model.thinking_model_id || '';
    document.getElementById('modelFormNonThinkingModel').value = model.non_thinking_model_id || '';
    document.getElementById('modelFormRateLimitRpm').value = model.rate_limit_rpm || 0;
    document.getElementById('modelFormRateLimitTpm').value = model.rate_limit_tpm || 0;
    document.getElementById('modelFormEnabled').value = (model.enabled !== false).toString();

    this.showModal('addEditModelModal');

    // 编辑完成后刷新列表
    this._onEditModelCallback = async () => {
      await this.loadMyTeamModels();
    };
  }

  async deleteMyTeamModel(modelId) {
    if (!await confirm(t('确定要删除此模型吗？此操作不可撤销。'))) return;

    try {
      const res = await fetch(`/api/user/models/${modelId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('删除失败'));
        return;
      }
      this.showToast(t('模型已删除'), 'success');
      await this.loadMyTeamModels();
    } catch (error) {
      alert(t('网络错误，请重试'));
    }
  }

  _populateProviderFilter(libraryData) {
    const providerSelect = document.getElementById('libraryProviderFilter');
    const stickyProviderSelect = document.getElementById('libraryStickyProviderFilter');
    const seriesSelect = document.getElementById('librarySeriesFilter');
    if (!libraryData.teams) return;

    const providers = new Set();
    const series = new Set(libraryData.available_series || []);

    libraryData.teams.forEach(team => {
      (team.providers || []).forEach(p => {
        // 默认不在筛选下拉中展示已隐藏供应商（显示已隐藏模式下仍包含）
        if (!this.libraryShowHidden && p.is_hidden) return;
        providers.add(p.provider_name);
        (p.models || []).forEach(m => {
          if (!this.libraryShowHidden && m.is_hidden) return;
          if (m.series) series.add(m.series);
        });
      });
    });

    // 填充供应商筛选器（主栏 + 悬浮栏）
    const optionsHtml = '<option value="all">' + t('全部供应商') + '</option>' +
      [...providers].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    const keepValue = [...providers].includes(this.libraryProviderFilter) || this.libraryProviderFilter === 'all'
      ? this.libraryProviderFilter
      : 'all';
    this.libraryProviderFilter = keepValue;
    for (const select of [providerSelect, stickyProviderSelect]) {
      if (!select) continue;
      setHTML(select, optionsHtml);
      select.value = keepValue;
    }

    // 填充系列筛选器（主栏 + 悬浮栏，优先用服务端 available_series）
    this._renderSeriesFilter(seriesSelect, series);
    this._renderSeriesFilter(document.getElementById('libraryStickySeriesFilter'), series);
  }

  _populateProviderTagFilter() {
    const tags = this._providerTags || [];
    const prev = this.libraryProviderTagFilter;
    const optionsHtml = '<option value="all">' + t('全部标签') + '</option>' +
      tags.map(t => `<option value="tag:${t.id}">${escapeHtml(t.name)}</option>`).join('');
    const values = ['all', ...tags.map(t => `tag:${t.id}`)];
    const keepValue = values.includes(prev) ? prev : 'all';
    this.libraryProviderTagFilter = keepValue;
    for (const id of ['libraryProviderTagFilter', 'libraryStickyProviderTagFilter']) {
      const tagSelect = document.getElementById(id);
      if (!tagSelect) continue;
      setHTML(tagSelect, optionsHtml);
      tagSelect.value = keepValue;
    }
  }

  // 根据 seriesSet 重建系列筛选下拉，保留当前选中值
  _renderSeriesFilter(seriesSelect, seriesSet) {
    if (!seriesSelect) return;
    const prev = this.librarySeriesFilter;
    setHTML(seriesSelect, '<option value="all">' + t('全部系列') + '</option>' +
      [...seriesSet].sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
    if ([...seriesSet].includes(prev) || prev === 'all') {
      seriesSelect.value = prev;
    } else {
      seriesSelect.value = 'all';
    }
  }

  // 模型明细加载后，合并所有已加载供应商的系列，刷新系列筛选器
  _rebuildSeriesFilter() {
    const series = new Set(this._libraryData?.available_series || []);
    if (this._libraryData) {
      for (const team of this._libraryData.teams || []) {
        for (const p of team.providers || []) {
          if (p.models_loaded) {
            for (const m of p.models || []) {
              if (m.series) series.add(m.series);
            }
          }
        }
      }
    }
    this._renderSeriesFilter(document.getElementById('librarySeriesFilter'), series);
    this._renderSeriesFilter(document.getElementById('libraryStickySeriesFilter'), series);
  }

  /** 搜索 / 系列 / 测试状态等模型级筛选走服务端全局搜索，避免前端拉全量 */
  _shouldUseLibraryGlobalSearch() {
    return !!(this.librarySearch || '').trim() ||
      this.librarySeriesFilter !== 'all' ||
      this.libraryTestFilter !== 'all';
  }

  _buildLibraryGlobalSearchParams(page = 1) {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', '30');
    const q = (this.librarySearch || '').trim();
    if (q) params.set('q', q);
    if (this.libraryProviderFilter && this.libraryProviderFilter !== 'all') {
      params.set('provider', this.libraryProviderFilter);
    }
    if (this.librarySeriesFilter && this.librarySeriesFilter !== 'all') {
      params.set('series', this.librarySeriesFilter);
    }
    if (this.libraryTestFilter && this.libraryTestFilter !== 'all') {
      params.set('test', this.libraryTestFilter);
    }
    if (this.libraryProviderTagFilter && this.libraryProviderTagFilter !== 'all') {
      params.set('tag', this.libraryProviderTagFilter);
    }
    if (this.librarySort && this.librarySort !== 'default') {
      params.set('sort', this.librarySort);
    }
    if (this.libraryShowHidden) params.set('include_hidden', '1');
    return params;
  }

  async _runLibraryGlobalSearch(page = 1) {
    const seq = ++this._libraryGlobalSearchSeq;
    const container = document.getElementById('modelLibraryContent');
    const countEl = document.getElementById('modelLibraryCount');
    if (container && page === 1) {
      setHTML(container, '<div class="empty-state" style="padding:40px 20px;text-align:center;"><p style="color:var(--muted-foreground);margin:0;">' + t('搜索中...') + '</p></div>');
    }
    try {
      const res = await fetch(`/api/user/model-library/search?${this._buildLibraryGlobalSearchParams(page).toString()}`);
      if (!res.ok) throw new Error(t('搜索失败'));
      const data = await res.json();
      if (seq !== this._libraryGlobalSearchSeq) return; // 过期响应
      if (!this._shouldUseLibraryGlobalSearch()) return;

      this._libraryGlobalSearchMode = true;
      this._libraryGlobalSearchResults = data;
      this._renderLibraryGlobalSearchResults(data);
      if (countEl) {
        countEl.style.display = 'block';
        countEl.textContent = `${t('找到')}${data.pagination?.total ?? (data.models || []).length}${t('个模型')}`;
      }
    } catch (e) {
      if (seq !== this._libraryGlobalSearchSeq) return;
      console.warn(t('[模型库] 全局搜索失败:'), e);
      if (container) {
        setHTML(container, '<div class="empty-state" style="padding:40px 20px;text-align:center;"><p style="color:var(--destructive);margin:0;">' + t('搜索失败，请重试') + '</p></div>');
      }
    }
  }

  _renderLibraryGlobalSearchResults(data) {
    const container = document.getElementById('modelLibraryContent');
    if (!container) return;
    const models = data.models || [];
    const pagination = data.pagination || {};
    const currentModel = this._libraryCurrentModel;

    if (!models.length) {
      setHTML(container, `
        <div class="empty-state model-library-empty" style="padding:48px 20px;text-align:center;">
          <p style="font-size:15px;color:var(--muted-foreground);margin:0;">没有符合条件的模型</p>
          <p style="font-size:13px;color:var(--muted-foreground);margin:8px 0 0;opacity:0.7;">试试缩短关键词，或清空系列/测试筛选</p>
        </div>`);
      return;
    }

    // 按 Team 分组展示，仍是扁平搜索结果
    const teamMap = new Map();
    for (const model of models) {
      const tid = model.team_id;
      if (!teamMap.has(tid)) {
        teamMap.set(tid, {
          team_id: tid,
          team_name: model.team_name || 'Team',
          is_personal: model.is_personal,
          is_default: model.is_default,
          models: []
        });
      }
      teamMap.get(tid).models.push(model);
    }

    const groupsHtml = [...teamMap.values()].map(team => {
      const items = team.models.map(model => {
        const isDisabled = model.provider_enabled === false;
        return this._renderModelLibraryItem(model, team, currentModel, isDisabled, {
          subtitle: model.provider_name
            ? `<span class="model-search-provider-tag">${escapeHtml(model.provider_name)}</span>`
            : ''
        });
      }).join('');
      return `
        <div class="model-library-team model-search-team">
          <div class="model-library-team-header" style="cursor:default;">
            <h3>${escapeHtml(team.team_name)}</h3>
            ${team.is_personal ? '<span class="team-badge">' + t('个人') + '</span>' : ''}
            ${team.is_default ? '<span class="team-badge default">' + t('默认') + '</span>' : ''}
            <div style="flex:1;"></div>
            <span class="provider-model-count">${team.models.length} 个结果</span>
          </div>
          <div class="model-library-list model-search-list">${items}</div>
        </div>`;
    }).join('');

    let paginationHtml = '';
    if (pagination.total_pages > 1) {
      const page = pagination.page || 1;
      paginationHtml = `
        <div class="model-library-pagination" style="margin-top:12px;">
          <button class="model-library-page-btn" ${pagination.has_prev ? '' : 'disabled'}
            onclick="app.loadLibraryGlobalSearchPage(${page - 1})">上一页</button>
          <span class="model-library-page-summary">第 ${page} / ${pagination.total_pages} 页 · 共 ${pagination.total} 个</span>
          <button class="model-library-page-btn" ${pagination.has_next ? '' : 'disabled'}
            onclick="app.loadLibraryGlobalSearchPage(${page + 1})">下一页</button>
        </div>`;
    }

    setHTML(container, groupsHtml + paginationHtml);
  }

  loadLibraryGlobalSearchPage(page) {
    if (!this._shouldUseLibraryGlobalSearch()) return;
    this._runLibraryGlobalSearch(Math.max(1, parseInt(page, 10) || 1));
  }

  filterAndRenderModelLibrary() {
    if (!this._libraryData) return;
    if (this.libraryReorderMode && !this._canUseLibraryReorderMode()) {
      this.libraryReorderMode = false;
      this._updateLibraryReorderButtons();
    }

    // 模型级筛选：走服务端全局搜索（不再前端展开全部供应商）
    if (this._shouldUseLibraryGlobalSearch()) {
      this._runLibraryGlobalSearch(1);
      return;
    }

    this._libraryGlobalSearchMode = false;
    this._libraryGlobalSearchResults = null;

    const data = this._libraryData;
    const currentModel = this._libraryCurrentModel;
    const provider = this.libraryProviderFilter;
    const tagFilter = this.libraryProviderTagFilter;
    const sort = this.librarySort;
    const showHidden = this.libraryShowHidden;

    // 供应商筛选：若选定了具体供应商，则自动展开并加载该供应商的模型
    if (provider !== 'all') {
      this._ensureProviderModelsLoadedByName(provider);
    }

    // 过滤每个 team → provider（供应商层级，模型明细按需加载）
    const filtered = {
      ...data,
      starred_models: (data.starred_models || []).filter(m => {
        if (!showHidden && m.is_hidden) return false;
        if (provider !== 'all' && m.provider_name !== provider) return false;
        if (tagFilter !== 'all' && tagFilter.startsWith('tag:')) {
          const filterTagId = parseInt(tagFilter.replace('tag:', ''), 10);
          const tags = m.tags || [];
          if (tags.length && !tags.some(t => t.id === filterTagId)) return false;
        }
        return true;
      }),
      teams: (data.teams || []).map(team => ({
        ...team,
        providers: (team.providers || [])
          .filter(p => {
            if (!showHidden && p.is_hidden) return false;
            if (provider !== 'all' && p.provider_name !== provider) return false;
            if (tagFilter !== 'all' && tagFilter.startsWith('tag:')) {
              const filterTagId = parseInt(tagFilter.replace('tag:', ''));
              if (!(p.tags || []).some(t => t.id === filterTagId)) return false;
            }
            return true;
          })
          .map(p => ({
            ...p,
            models: p.models_loaded
              ? (p.models || []).filter(m => !(!showHidden && m.is_hidden))
              : []
          }))
      })).filter(t => t.providers && t.providers.length > 0)
    };

    // 排序（仅对已加载模型明细的供应商生效）
    if (sort !== 'default') {
      filtered.teams.forEach(team => {
        this._sortProviders(team.providers, sort, team.team_id);
        team.providers.forEach(p => {
          if (!p.models) return;
          if (sort === 'price_asc')
            p.models.sort((a, b) => (a.input_price_per_1k_tokens || 0) - (b.input_price_per_1k_tokens || 0));
          else if (sort === 'price_desc')
            p.models.sort((a, b) => (b.input_price_per_1k_tokens || 0) - (a.input_price_per_1k_tokens || 0));
          else if (sort === 'name_asc')
            p.models.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          else if (sort === 'name_desc')
            p.models.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
          else if (sort === 'test_latency_asc')
            this._sortTestModels(p.models, 'latency', 'asc');
          else if (sort === 'test_latency_desc')
            this._sortTestModels(p.models, 'latency', 'desc');
          else if (sort === 'test_tps_desc')
            this._sortTestModels(p.models, 'tps');
        });
      });
    }

    const countEl = document.getElementById('modelLibraryCount');
    if (countEl) {
      if (provider !== 'all' || tagFilter !== 'all') {
        let totalModels = 0;
        filtered.teams.forEach(t => t.providers.forEach(p => {
          totalModels += p.model_count ?? p.visible_model_count ?? (p.models?.length || 0);
        }));
        countEl.style.display = 'block';
        countEl.textContent = `${t('共')}${totalModels}${t('个模型（骨架统计）')}`;
      } else {
        countEl.style.display = 'none';
      }
    }

    const expandedState = this._captureLibraryExpandedState();
    this.renderModelLibrary(filtered, currentModel);
    this._restoreLibraryExpandedState(expandedState);
  }

  // 按供应商名称找到对应 provider 并触发加载（用于供应商筛选下拉框）
  _ensureProviderModelsLoadedByName(providerName) {
    if (!this._libraryData) return;
    for (const team of this._libraryData.teams || []) {
      for (const p of team.providers || []) {
        if (p.provider_name === providerName && (!p.models_loaded || p.models_query_key !== this._getProviderModelsQueryKey(team, p))) {
          const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(p.provider_id))}"]`);
          if (providerEl) {
            providerEl.classList.remove('collapsed');
            this._loadProviderModels(team, p, providerEl, { page: 1, force: true });
          }
        }
      }
    }
  }

  // 刷新当前已展开供应商的模型列表 DOM（筛选/排序变更后）
  _refreshExpandedProviderLists() {
    const expanded = document.querySelectorAll('.model-library-provider:not(.collapsed)');
    for (const providerEl of expanded) {
      const teamId = providerEl.getAttribute('data-team-id');
      const providerId = providerEl.getAttribute('data-provider-id');
      if (!teamId || !providerId) continue;
      const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
      const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
      if (provider && provider.models_loaded) {
        this._renderProviderModelsInto(providerEl, provider, team);
      }
    }
  }

  _sortTestModels(list, sortField, direction) {
    if (!list || list.length < 2) return;
    const ok = m => m && (m.test_ok === true || m.test_ok === 'true');
    list.sort((a, b) => {
      const aOk = ok(a), bOk = ok(b);
      if (!aOk && !bOk) return 0;
      if (!aOk) return 1;
      if (!bOk) return -1;
      let va, vb;
      if (sortField === 'latency') {
        va = a.test_latency_ms != null ? a.test_latency_ms : Infinity;
        vb = b.test_latency_ms != null ? b.test_latency_ms : Infinity;
        return direction === 'asc' ? va - vb : vb - va;
      }
      if (sortField === 'tps') {
        va = a.test_tokens_per_second != null ? a.test_tokens_per_second : 0;
        vb = b.test_tokens_per_second != null ? b.test_tokens_per_second : 0;
        return vb - va;
      }
      return 0;
    });
  }

  // 按模型维度对供应商排序
  _sortProviders(providers, sort, teamId) {
    if (!providers || providers.length < 2) return;
    if (sort === 'name_asc')
      providers.sort((a, b) => (a.provider_name || '').localeCompare(b.provider_name || ''));
    else if (sort === 'name_desc')
      providers.sort((a, b) => (b.provider_name || '').localeCompare(a.provider_name || ''));
    else if (sort === 'price_asc' || sort === 'price_desc') {
      const getMinPrice = p => {
        const orig = this._getOriginalProvider(p, teamId);
        if (!orig || !orig.models_loaded || !orig.models?.length) return Infinity;
        return Math.min(...orig.models.map(m => m.input_price_per_1k_tokens ?? Infinity));
      };
      providers.sort((a, b) => sort === 'price_asc' ? getMinPrice(a) - getMinPrice(b) : getMinPrice(b) - getMinPrice(a));
    } else if (sort === 'test_latency_asc' || sort === 'test_latency_desc' || sort === 'test_tps_desc') {
      const getMetric = p => {
        const orig = this._getOriginalProvider(p, teamId);
        if (!orig || !orig.models_loaded) return Infinity;
        const ok = orig.models.filter(m => m.test_ok === true);
        if (!ok.length) return Infinity;
        return sort === 'test_tps_desc'
          ? Math.max(...ok.map(m => m.test_tokens_per_second ?? 0))
          : Math.min(...ok.map(m => m.test_latency_ms ?? Infinity));
      };
      providers.sort((a, b) => {
        const aM = getMetric(a), bM = getMetric(b);
        if (aM === Infinity && bM === Infinity) return 0;
        if (aM === Infinity) return 1;
        if (bM === Infinity) return -1;
        return sort === 'test_latency_asc' ? aM - bM : sort === 'test_latency_desc' ? bM - aM : bM - aM;
      });
    }
  }

  _getOriginalProvider(filteredProvider, teamId) {
    if (!this._libraryData || !filteredProvider) return null;
    const team = (this._libraryData.teams || []).find(t => String(t.team_id) === String(teamId));
    return team?.providers?.find(p => String(p.provider_id) === String(filteredProvider.provider_id)) || null;
  }

  _canUseLibraryReorderMode() {
    return !this.librarySearch &&
      this.libraryProviderFilter === 'all' &&
      this.librarySeriesFilter === 'all' &&
      this.libraryTestFilter === 'all' &&
      this.librarySort === 'default';
  }

  _ensureLibraryReorderControls() {
    // 排序/隐藏控件已放入「更多」菜单（console.html），此处仅同步状态
    const sortSelect = document.getElementById('librarySort');
    const defaultOption = sortSelect?.querySelector('option[value="default"]');
    if (defaultOption) defaultOption.textContent = t('默认 / 自定义排序');
    this._updateLibraryHiddenButtons();
    this._updateLibraryReorderButtons();
  }

  toggleLibraryMoreDropdown(event) {
    event?.stopPropagation();
    const menu = document.getElementById('libraryMoreDropdownMenu');
    if (!menu) return;
    const isVisible = menu.style.display === 'block';
    menu.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      const close = (e) => {
        const dropdown = document.getElementById('libraryMoreDropdown');
        if (dropdown && !dropdown.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  closeLibraryMoreDropdown() {
    const menu = document.getElementById('libraryMoreDropdownMenu');
    if (menu) menu.style.display = 'none';
  }

  toggleLibraryMoreFilters() {
    const panel = document.getElementById('libraryAdvancedFilters');
    const stickyPanel = document.getElementById('libraryStickyAdvancedFilters');
    // 以主面板当前状态为准（若缺失则看悬浮栏）
    const currentlyOpen = panel
      ? panel.style.display !== 'none'
      : (stickyPanel?.classList.contains('is-open') || stickyPanel?.style.display === 'flex');
    this._setLibraryMoreFiltersOpen(!currentlyOpen);
  }

  _setLibraryMoreFiltersOpen(open) {
    const shouldOpen = !!open;
    const panel = document.getElementById('libraryAdvancedFilters');
    const stickyPanel = document.getElementById('libraryStickyAdvancedFilters');
    if (panel) panel.style.display = shouldOpen ? 'flex' : 'none';
    if (stickyPanel) {
      stickyPanel.style.display = shouldOpen ? 'flex' : 'none';
      stickyPanel.classList.toggle('is-open', shouldOpen);
      stickyPanel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
    }
    for (const id of ['libraryMoreFiltersBtn', 'libraryStickyMoreFiltersBtn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.classList.toggle('library-more-filters-active', shouldOpen || this._hasLibraryAdvancedFiltersActive());
      btn.textContent = shouldOpen ? t('收起筛选') : t('更多筛选');
      btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    }
  }

  _hasLibraryAdvancedFiltersActive() {
    return (this.librarySeriesFilter && this.librarySeriesFilter !== 'all')
      || (this.libraryTestFilter && this.libraryTestFilter !== 'all')
      || (this.libraryProviderTagFilter && this.libraryProviderTagFilter !== 'all')
      || (this.librarySort && this.librarySort !== 'default');
  }

  _updateLibraryMoreFiltersButtons() {
    const open = document.getElementById('libraryAdvancedFilters')?.style.display !== 'none'
      || document.getElementById('libraryStickyAdvancedFilters')?.classList.contains('is-open');
    for (const id of ['libraryMoreFiltersBtn', 'libraryStickyMoreFiltersBtn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      const highlight = open || this._hasLibraryAdvancedFiltersActive();
      btn.classList.toggle('library-more-filters-active', highlight);
      if (!open) btn.textContent = t('更多筛选');
    }
  }

  _countLibraryHidden() {
    let providers = 0;
    let models = 0;
    for (const team of this._libraryData?.teams || []) {
      for (const p of team.providers || []) {
        if (p.is_hidden) providers++;
        if (p.hidden_model_count != null) models += p.hidden_model_count;
        else if (p.models_loaded) models += (p.models || []).filter(m => m.is_hidden).length;
      }
    }
    return { providers, models, total: providers + models };
  }

  _updateLibraryHiddenButtons() {
    const showBtn = document.getElementById('libraryShowHiddenBtn');
    if (showBtn) {
      showBtn.classList.toggle('library-show-hidden-active', this.libraryShowHidden);
      const text = showBtn.querySelector('.library-show-hidden-text');
      if (text) text.textContent = this.libraryShowHidden ? t('隐藏已隐藏项') : t('显示已隐藏');
    }
    const clearBtn = document.getElementById('libraryClearHiddenBtn');
    if (clearBtn) {
      const counts = this._countLibraryHidden();
      clearBtn.style.display = (this.libraryShowHidden && counts.total > 0) ? 'block' : 'none';
      if (counts.total > 0) {
        clearBtn.title = `${t('清除全部隐藏偏好（供应商')}${counts.providers}${t('/ 模型')}${counts.models}）`;
      }
    }
  }

  toggleLibraryShowHidden() {
    this.libraryShowHidden = !this.libraryShowHidden;
    this._updateLibraryHiddenButtons();
    // 切换后已加载供应商的查询键变化，需要强制重载模型列表
    for (const team of this._libraryData?.teams || []) {
      for (const p of team.providers || []) {
        if (p.models_loaded) {
          p.models_loaded = false;
          p.models_query_key = null;
        }
      }
    }
    this.filterAndRenderModelLibrary();
  }

  async clearLibraryHidden() {
    if (!await confirm(t('确定清除全部隐藏偏好吗？已隐藏的供应商和模型将全部恢复显示。'))) return;
    try {
      const res = await fetch('/api/user/model-library/hidden?scope=all', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('清除失败'));
      this.libraryShowHidden = false;
      await this.loadModelLibrary();
      this.showToast(t('已清除全部隐藏偏好'), 'success');
    } catch (e) {
      this.showToast(e.message || t('清除失败'), 'error');
    }
  }

  async _setLibraryHidden(scope, payload) {
    const res = await fetch('/api/user/model-library/hidden', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, ...payload })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('操作失败'));
    return data;
  }

  async hideLibraryProvider(teamId, providerId, hidden = true) {
    if (this._librarySavingHidden) return;
    const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
    const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
    if (!provider) return;

    const prevHidden = !!provider.is_hidden;
    provider.is_hidden = !!hidden;
    this._librarySavingHidden = true;
    this.filterAndRenderModelLibrary();
    this._updateLibraryHiddenButtons();
    try {
      await this._setLibraryHidden('provider', { teamId, providerId, hidden: !!hidden });
      this.showToast(hidden ? `${t('已隐藏供应商「')}${provider.provider_name}」` : `${t('已显示供应商「')}${provider.provider_name}」`, 'success');
    } catch (e) {
      provider.is_hidden = prevHidden;
      this.filterAndRenderModelLibrary();
      this._updateLibraryHiddenButtons();
      this.showToast(e.message || t('操作失败'), 'error');
    } finally {
      this._librarySavingHidden = false;
    }
  }

  async hideLibraryModel(teamId, providerId, modelId, hidden = true) {
    if (this._librarySavingHidden) return;

    // 全局搜索结果中的模型可能尚未进入树状缓存
    let team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
    let provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
    let model = provider?.models?.find(m => String(m.model_id || m.id) === String(modelId));
    if (!model && this._libraryGlobalSearchResults?.models) {
      model = this._libraryGlobalSearchResults.models.find(m => String(m.model_id || m.id) === String(modelId));
    }
    // 树状缓存未命中时，直接调接口（搜索结果场景）
    if (!provider || !model) {
      this._librarySavingHidden = true;
      try {
        await this._setLibraryHidden('model', { teamId, providerId, modelId, hidden: !!hidden });
        const name = model?.name || modelId;
        this.showToast(hidden ? `${t('已隐藏模型「')}${name}」` : `${t('已显示模型「')}${name}」`, 'success');
        this.filterAndRenderModelLibrary();
        this._updateLibraryHiddenButtons();
      } catch (e) {
        this.showToast(e.message || t('操作失败'), 'error');
      } finally {
        this._librarySavingHidden = false;
      }
      return;
    }

    const prevHidden = !!model.is_hidden;
    const prevHiddenCount = provider.hidden_model_count || 0;
    const prevVisibleCount = provider.visible_model_count != null
      ? provider.visible_model_count
      : Math.max((provider.model_count || 0) - prevHiddenCount, 0);

    model.is_hidden = !!hidden;
    if (hidden && !prevHidden) {
      provider.hidden_model_count = prevHiddenCount + 1;
      provider.visible_model_count = Math.max(prevVisibleCount - 1, 0);
    } else if (!hidden && prevHidden) {
      provider.hidden_model_count = Math.max(prevHiddenCount - 1, 0);
      provider.visible_model_count = prevVisibleCount + 1;
    }

    this._librarySavingHidden = true;
    this.filterAndRenderModelLibrary();
    this._updateLibraryHiddenButtons();
    try {
      await this._setLibraryHidden('model', { teamId, providerId, modelId, hidden: !!hidden });
      this.showToast(hidden ? `${t('已隐藏模型「')}${model.name}」` : `${t('已显示模型「')}${model.name}」`, 'success');
    } catch (e) {
      model.is_hidden = prevHidden;
      provider.hidden_model_count = prevHiddenCount;
      provider.visible_model_count = prevVisibleCount;
      this.filterAndRenderModelLibrary();
      this._updateLibraryHiddenButtons();
      this.showToast(e.message || t('操作失败'), 'error');
    } finally {
      this._librarySavingHidden = false;
    }
  }

  _starredModelKey(teamId, providerId, modelId) {
    return `${teamId}::${providerId}::${modelId}`;
  }

  _applyLibraryStarState(teamId, providerId, modelId, starred, snapshot = null) {
    const match = (m) => String(m.model_id || m.id) === String(modelId)
      && String(m.provider_id || m.provider || providerId) === String(providerId)
      && String(m.team_id || teamId) === String(teamId);

    for (const team of this._libraryData?.teams || []) {
      if (String(team.team_id) !== String(teamId)) continue;
      for (const provider of team.providers || []) {
        if (String(provider.provider_id) !== String(providerId)) continue;
        for (const m of provider.models || []) {
          if (String(m.model_id || m.id) === String(modelId)) m.is_starred = !!starred;
        }
      }
    }

    if (this._libraryGlobalSearchResults?.models) {
      for (const m of this._libraryGlobalSearchResults.models) {
        if (match(m) || String(m.model_id || m.id) === String(modelId)) {
          if (String(m.team_id || teamId) === String(teamId)) m.is_starred = !!starred;
        }
      }
    }

    if (!this._libraryData) return;
    const list = Array.isArray(this._libraryData.starred_models) ? this._libraryData.starred_models : [];
    const key = this._starredModelKey(teamId, providerId, modelId);
    const next = list.filter(m => this._starredModelKey(m.team_id, m.provider_id || m.provider, m.model_id || m.id) !== key);
    if (starred) {
      const src = snapshot || list.find(m => this._starredModelKey(m.team_id, m.provider_id || m.provider, m.model_id || m.id) === key) || {};
      next.unshift({
        ...src,
        model_id: src.model_id || modelId,
        team_id: src.team_id || teamId,
        provider_id: src.provider_id || src.provider || providerId,
        is_starred: true
      });
    }
    this._libraryData.starred_models = next;
  }

  async toggleLibraryStar(teamId, providerId, modelId, starred) {
    if (this._librarySavingStar) return;
    const wantStar = !!starred;

    let snapshot = null;
    const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
    const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
    const cached = provider?.models?.find(m => String(m.model_id || m.id) === String(modelId));
    const searched = this._libraryGlobalSearchResults?.models?.find(m =>
      String(m.model_id || m.id) === String(modelId)
      && String(m.team_id || teamId) === String(teamId)
    );
    const existingStar = (this._libraryData?.starred_models || []).find(m =>
      this._starredModelKey(m.team_id, m.provider_id || m.provider, m.model_id || m.id)
      === this._starredModelKey(teamId, providerId, modelId)
    );
    snapshot = cached || searched || existingStar || null;

    this._applyLibraryStarState(teamId, providerId, modelId, wantStar, snapshot ? {
      ...snapshot,
      team_id: teamId,
      team_name: snapshot.team_name || team?.team_name,
      provider_id: providerId,
      provider_name: snapshot.provider_name || provider?.provider_name
    } : {
      model_id: modelId,
      name: modelId,
      team_id: teamId,
      team_name: team?.team_name,
      provider_id: providerId,
      provider_name: provider?.provider_name
    });

    this._librarySavingStar = true;
    this.filterAndRenderModelLibrary();
    try {
      const res = await fetch('/api/user/model-library/star', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, providerId, modelId, starred: wantStar })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('操作失败'));
      const name = snapshot?.name || modelId;
      this.showToast(wantStar ? `${t('已星标「')}${name}」` : `${t('已取消星标「')}${name}」`, 'success');
    } catch (e) {
      this._applyLibraryStarState(teamId, providerId, modelId, !wantStar, snapshot);
      this.filterAndRenderModelLibrary();
      this.showToast(e.message || t('操作失败'), 'error');
    } finally {
      this._librarySavingStar = false;
    }
  }

  _renderStarredModelsSection(starredModels, currentModel) {
    if (!starredModels || !starredModels.length) return '';
    const items = starredModels.map(model => {
      const team = {
        team_id: model.team_id,
        team_name: model.team_name,
        is_personal: model.is_personal
      };
      const isDisabled = model.provider_enabled === false;
      const subtitle = [
        model.team_name ? `<span class="model-search-provider-tag">${escapeHtml(model.team_name)}</span>` : '',
        model.provider_name ? `<span class="model-search-provider-tag">${escapeHtml(model.provider_name)}</span>` : ''
      ].join('');
      return this._renderModelLibraryItem(model, team, currentModel, isDisabled, { subtitle });
    }).join('');

    return `
      <div class="model-library-team model-library-starred" data-starred-section="1">
        <div class="model-library-team-header" style="cursor:default;">
          <svg class="model-star-heading-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <h3>星标</h3>
          <div style="flex:1;"></div>
          <span class="provider-model-count">${starredModels.length} 个模型</span>
        </div>
        <div class="model-library-list model-search-list">${items}</div>
      </div>`;
  }

  _updateLibraryReorderButtons() {
    const reorderBtn = document.getElementById('libraryReorderBtn');
    if (reorderBtn) {
      reorderBtn.classList.toggle('library-reorder-mode-active', this.libraryReorderMode);
      const text = reorderBtn.querySelector('.library-reorder-text');
      if (text) text.textContent = this.libraryReorderMode ? t('退出排序') : t('排序模式');
    }
    const resetBtn = document.getElementById('libraryResetOrderBtn');
    if (resetBtn) resetBtn.style.display = this.libraryReorderMode ? 'block' : 'none';
    const toolbar = document.getElementById('libraryReorderToolbar');
    if (toolbar) toolbar.style.display = this.libraryReorderMode ? 'flex' : 'none';
    this._setLibraryReorderToolbarBusy(!!this._librarySavingOrder || !!this._libraryApplyingTestOrder);
  }

  _setLibraryReorderToolbarBusy(busy) {
    const toolbar = document.getElementById('libraryReorderToolbar');
    if (!toolbar) return;
    toolbar.querySelectorAll('button').forEach(btn => {
      btn.disabled = !!busy;
    });
  }

  toggleLibraryReorderMode() {
    if (!this.libraryReorderMode && !this._canUseLibraryReorderMode()) {
      this.showToast(t('请先清空搜索和筛选，并选择“默认 / 自定义排序”后再调整排序'), 'error');
      return;
    }
    this.libraryReorderMode = !this.libraryReorderMode;
    this._updateLibraryReorderButtons();
    this.filterAndRenderModelLibrary();
  }

  /**
   * 排序模式下：一键按模型测试结果写入自定义排序（供应商 + 模型）
   * @param {'test_latency_asc'|'test_latency_desc'|'test_tps_desc'} sort
   */
  async applyLibraryOrderByTest(sort = 'test_latency_asc') {
    if (!this.libraryReorderMode) {
      this.showToast(t('请先进入排序模式'), 'error');
      return;
    }
    if (!this._canUseLibraryReorderMode()) {
      this.showToast(t('请先清空搜索和筛选，并选择“默认 / 自定义排序”'), 'error');
      return;
    }
    if (this._librarySavingOrder || this._libraryApplyingTestOrder) return;

    const sortLabels = {
      test_latency_asc: t('测试延迟（快→慢）'),
      test_latency_desc: t('测试延迟（慢→快）'),
      test_tps_desc: t('测试吞吐（高→低）')
    };
    if (!sortLabels[sort]) {
      this.showToast(t('无效的排序方式'), 'error');
      return;
    }

    const confirmed = await confirm(
      `${t('将按「')}${sortLabels[sort]}${t('」重写当前账号的模型库自定义排序：\\n')}` +
      `${t('• 各 Team 内供应商顺序\\n')}` +
      `${t('• 各供应商内模型顺序\\n\\n')}` +
      `${t('通过测试的优先，未测试/失败靠后。是否继续？')}`
    );
    if (!confirmed) return;

    this._libraryApplyingTestOrder = true;
    this._librarySavingOrder = true;
    this._setLibraryReorderToolbarBusy(true);
    try {
      const res = await fetch('/api/user/model-library/order/by-test', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sort })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('按测试结果排序失败'));

      const expandedState = this._captureLibraryExpandedState();
      await this.loadModelLibrary();
      // loadModelLibrary 会重绘，需保持排序模式并恢复展开状态
      this.libraryReorderMode = true;
      this._updateLibraryReorderButtons();
      this.filterAndRenderModelLibrary();
      this._restoreLibraryExpandedState(expandedState);

      const modelN = data.models ?? 0;
      const providerN = data.providers ?? 0;
      this.showToast(`${t('已按')}${sortLabels[sort]}${t('排序（')}${providerN}${t('个供应商，')}${modelN}${t('个模型）')}`, 'success');
    } catch (e) {
      this.showToast(e.message || t('按测试结果排序失败'), 'error');
    } finally {
      this._libraryApplyingTestOrder = false;
      this._librarySavingOrder = false;
      this._setLibraryReorderToolbarBusy(false);
    }
  }

  _captureLibraryExpandedState() {
    return {
      collapsedTeams: new Set([...document.querySelectorAll('.model-library-team.collapsed')].map(el => String(el.getAttribute('data-team-id')))),
      expandedProviders: new Set([...document.querySelectorAll('.model-library-provider:not(.collapsed)')].map(el => `${el.getAttribute('data-team-id')}::${el.getAttribute('data-provider-id')}`))
    };
  }

  _restoreLibraryExpandedState(state) {
    if (!state) return;
    document.querySelectorAll('.model-library-team').forEach(el => {
      if (state.collapsedTeams?.has(String(el.getAttribute('data-team-id')))) el.classList.add('collapsed');
    });
    document.querySelectorAll('.model-library-provider').forEach(el => {
      const key = `${el.getAttribute('data-team-id')}::${el.getAttribute('data-provider-id')}`;
      if (!state.expandedProviders?.has(key)) return;
      el.classList.remove('collapsed');
      const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(el.getAttribute('data-team-id')));
      const provider = team?.providers?.find(p => String(p.provider_id) === String(el.getAttribute('data-provider-id')));
      // 未加载（或加载中/上次失败）也要走渲染函数：它会对未加载供应商触发按需加载，
      // 否则重建后卡片停留在「点击展开以加载模型」，必须折叠再展开才能出内容
      if (team && provider) this._renderProviderModelsInto(el, provider, team);
    });
  }

  _renderLibraryMoveControls(type, id1, id2) {
    if (!this.libraryReorderMode) return '';
    const draggableAttr = `draggable="true" data-drag-type="${type}"`;
    if (type === 'team') {
      return `<span class="library-drag-handle" ${draggableAttr} data-team-id="${escapeHtml(String(id1))}" onclick="event.stopPropagation()">⠿</span>`;
    }
    if (type === 'provider') {
      return `<span class="library-drag-handle" ${draggableAttr} data-team-id="${escapeHtml(String(id1))}" data-provider-id="${escapeHtml(String(id2))}" onclick="event.stopPropagation()">⠿</span>`;
    }
    if (type === 'model') {
      return `<span class="library-drag-handle" ${draggableAttr} data-team-id="${escapeHtml(String(id1))}" data-provider-id="${escapeHtml(String(id2))}" onclick="event.stopPropagation()">⠿</span>`;
    }
    return '';
  }

  _moveArrayItem(list, index, direction) {
    const targetIndex = index + direction;
    if (!Array.isArray(list) || index < 0 || targetIndex < 0 || targetIndex >= list.length) return false;
    const [item] = list.splice(index, 1);
    list.splice(targetIndex, 0, item);
    return true;
  }

  async _saveLibraryOrder(scope, payload) {
    const res = await fetch('/api/user/model-library/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, ...payload })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('保存排序失败'));
    return data;
  }

  async moveLibraryTeam(teamId, direction) {
    if (!this._canUseLibraryReorderMode() || this._librarySavingOrder) return;
    const teams = this._libraryData?.teams || [];
    const index = teams.findIndex(t => String(t.team_id) === String(teamId));
    const state = this._captureLibraryExpandedState();
    if (!this._moveArrayItem(teams, index, direction)) return;
    this._librarySavingOrder = true;
    this.filterAndRenderModelLibrary();
    this._restoreLibraryExpandedState(state);
    try {
      await this._saveLibraryOrder('team', { orderedIds: teams.map(t => t.team_id) });
    } catch (e) {
      this._moveArrayItem(teams, index + direction, -direction);
      this.filterAndRenderModelLibrary();
      this._restoreLibraryExpandedState(state);
      this.showToast(e.message || t('保存排序失败'), 'error');
    } finally {
      this._librarySavingOrder = false;
    }
  }

  async moveLibraryProvider(teamId, providerId, direction) {
    if (!this._canUseLibraryReorderMode() || this._librarySavingOrder) return;
    const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
    const providers = team?.providers || [];
    const index = providers.findIndex(p => String(p.provider_id) === String(providerId));
    const state = this._captureLibraryExpandedState();
    if (!this._moveArrayItem(providers, index, direction)) return;
    this._librarySavingOrder = true;
    this.filterAndRenderModelLibrary();
    this._restoreLibraryExpandedState(state);
    try {
      await this._saveLibraryOrder('provider', { teamId, orderedIds: providers.map(p => p.provider_id) });
    } catch (e) {
      this._moveArrayItem(providers, index + direction, -direction);
      this.filterAndRenderModelLibrary();
      this._restoreLibraryExpandedState(state);
      this.showToast(e.message || t('保存排序失败'), 'error');
    } finally {
      this._librarySavingOrder = false;
    }
  }

  async moveLibraryModel(teamId, providerId, modelId, direction) {
    if (!this._canUseLibraryReorderMode() || this._librarySavingOrder) return;
    const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
    const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
    const models = provider?.models || [];
    if (provider?.pagination && provider.pagination.total > models.length) {
      this.showToast(t('分页加载时暂不支持调整模型顺序'), 'error');
      return;
    }
    const index = models.findIndex(m => String(m.model_id) === String(modelId));
    const state = this._captureLibraryExpandedState();
    if (!this._moveArrayItem(models, index, direction)) return;
    this._librarySavingOrder = true;
    this.filterAndRenderModelLibrary();
    this._restoreLibraryExpandedState(state);
    try {
      await this._saveLibraryOrder('model', { teamId, providerId, orderedIds: models.map(m => m.model_id) });
    } catch (e) {
      this._moveArrayItem(models, index + direction, -direction);
      this.filterAndRenderModelLibrary();
      this._restoreLibraryExpandedState(state);
      this.showToast(e.message || t('保存排序失败'), 'error');
    } finally {
      this._librarySavingOrder = false;
    }
  }

  _initLibraryDragDrop() {
    if (this._libraryDragInited) return;
    this._libraryDragInited = true;
    const container = document.getElementById('modelLibraryContent');
    if (!container) return;

    container.addEventListener('dragstart', (e) => {
      const handle = e.target.closest('.library-drag-handle');
      if (!handle || !this.libraryReorderMode) { e.preventDefault(); return; }
      const type = handle.getAttribute('data-drag-type');
      const teamId = handle.getAttribute('data-team-id');
      const providerId = handle.getAttribute('data-provider-id');
      this._dragData = { type, teamId, providerId };

      // 让被拖动项高亮
      const item = type === 'team'
        ? handle.closest('.model-library-team')
        : type === 'provider'
          ? handle.closest('.model-library-provider')
          : handle.closest('.model-library-item');
      if (item) item.classList.add('library-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    container.addEventListener('dragover', (e) => {
      if (!this._dragData || this._librarySavingOrder) return;
      const target = e.target.closest('.model-library-team, .model-library-provider, .model-library-item');
      if (!target || target.classList.contains('library-dragging')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // 清除其他高亮
      container.querySelectorAll('.library-drag-over').forEach(el => el.classList.remove('library-drag-over'));
      target.classList.add('library-drag-over');
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!this._dragData || !this._canUseLibraryReorderMode() || this._librarySavingOrder) return;
      container.querySelectorAll('.library-drag-over').forEach(el => el.classList.remove('library-drag-over'));

      const target = e.target.closest('.model-library-team, .model-library-provider, .model-library-item');
      const src = document.querySelector('.library-dragging');
      if (!target || !src || target === src) return;

      const type = this._dragData.type;
      const { teamId, providerId } = this._dragData;
      const state = this._captureLibraryExpandedState();

      let list;
      let getKey;
      let scope;
      let payload;

      if (type === 'team') {
        list = this._libraryData?.teams;
        getKey = item => String(item.team_id);
        scope = 'team';
        payload = { orderedIds: null };
      } else if (type === 'provider') {
        const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
        list = team?.providers;
        getKey = item => String(item.provider_id);
        scope = 'provider';
        payload = { teamId };
      } else if (type === 'model') {
        const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
        const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
        list = provider?.models;
        if (provider?.pagination && provider.pagination.total > (provider.models || []).length) {
          this.showToast(t('分页加载时暂不支持调整模型顺序'), 'error');
          this._cleanupDragDrop();
          return;
        }
        getKey = item => String(item.model_id);
        scope = 'model';
        payload = { teamId, providerId };
      } else {
        this._cleanupDragDrop();
        return;
      }

      if (!Array.isArray(list)) { this._cleanupDragDrop(); return; }

      // 确定源索引和目标索引
      const srcKey = src.getAttribute('data-' + (type === 'team' ? 'team-id' : type === 'provider' ? 'provider-id' : type === 'model' ? 'model-id' : ''));
      const tgtKey = type === 'team' ? target.getAttribute('data-team-id')
        : type === 'provider' ? target.getAttribute('data-provider-id')
        : target.getAttribute('data-model-id');

      const fromIdx = list.findIndex(item => getKey(item) === srcKey);
      let toIdx = list.findIndex(item => getKey(item) === tgtKey);
      if (fromIdx < 0 || toIdx < 0) { this._cleanupDragDrop(); return; }

      // 判断 drop 到目标的上方还是下方
      const rect = target.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY > mid) toIdx++;

      if (fromIdx === toIdx || fromIdx === toIdx - 1) { this._cleanupDragDrop(); return; }

      // 执行移动
      const [item] = list.splice(fromIdx, 1);
      const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
      list.splice(insertAt, 0, item);
      payload.orderedIds = list.map(getKey);

      this._librarySavingOrder = true;
      this.filterAndRenderModelLibrary();
      this._restoreLibraryExpandedState(state);

      this._saveLibraryOrder(scope, payload)
        .then(() => { /* 成功，不弹 toast */ })
        .catch(e => {
          // 回滚
          const [lost] = list.splice(insertAt, 1);
          const rollbackIdx = list.findIndex(item => getKey(item) === srcKey);
          list.splice(rollbackIdx >= 0 ? rollbackIdx : fromIdx, 0, lost);
          this.filterAndRenderModelLibrary();
          this._restoreLibraryExpandedState(state);
          this.showToast(e.message || t('保存排序失败'), 'error');
        })
        .finally(() => { this._librarySavingOrder = false; });
    });

    container.addEventListener('dragend', () => this._cleanupDragDrop());
  }

  _cleanupDragDrop() {
    this._dragData = null;
    document.querySelectorAll('.library-dragging, .library-drag-over').forEach(el => {
      el.classList.remove('library-dragging', 'library-drag-over');
    });
  }

  async resetLibraryOrder() {
    if (!await confirm(t('确定恢复模型库默认排序吗？这会清除当前账号的 Team、供应商和模型自定义排序。'))) return;
    try {
      const res = await fetch('/api/user/model-library/order?scope=all', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('重置排序失败'));
      this.libraryReorderMode = false;
      this._updateLibraryReorderButtons();
      await this.loadModelLibrary();
      this.showToast(t('已恢复默认排序'), 'success');
    } catch (e) {
      this.showToast(e.message || t('重置排序失败'), 'error');
    }
  }

  async loadProviderQuota() {
    const grid = document.getElementById('providerQuotaGrid');
    if (grid && !(this._providerQuotaLoadedOnce)) {
      setHTML(grid, '<div class="model-quota-loading" role="status"><span class="loading-spinner sm"></span><span>' + t('正在加载供应商额度缓存...') + '</span></div>');
    }
    const section = document.getElementById('providerQuotaSection');
    if (section && !(this._providerQuotaLoadedOnce)) section.style.display = 'block';
    try {
      const quotaRes = await fetch('/api/user/providers/quota');
      if (!quotaRes.ok) throw new Error(`${t('额度接口异常 (')}${quotaRes.status})`);
      const quotaData = await quotaRes.json();
      this._providerQuotaLoadedOnce = true;
      this.renderProviderQuota(quotaData.providers || []);
    } catch (e) {
      console.warn(t('加载供应商额度失败:'), e);
    }
  }

  async refreshProviderQuota() {
    const refreshButton = document.getElementById('providerQuotaRefreshBtn');
    if (refreshButton) {
      refreshButton.classList.add('is-loading');
      refreshButton.disabled = true;
    }
    const grid = document.getElementById('providerQuotaGrid');
    if (grid) {
      setHTML(grid, '<div class="model-quota-loading" role="status"><span class="loading-spinner sm"></span><span>' + t('正在刷新供应商额度，请稍候...') + '</span></div>');
    }
    const section = document.getElementById('providerQuotaSection');
    if (section) section.style.display = 'block';
    try {
      const quotaRes = await fetch('/api/user/providers/quota/refresh', { method: 'POST' });
      if (!quotaRes.ok) throw new Error(`${t('额度接口异常 (')}${quotaRes.status})`);
      const quotaData = await quotaRes.json();
      this._providerQuotaLoadedOnce = true;
      this.renderProviderQuota(quotaData.providers || []);
    } catch (e) {
      console.warn(t('刷新供应商额度失败:'), e);
    } finally {
      if (refreshButton) {
        refreshButton.classList.remove('is-loading');
        refreshButton.disabled = false;
      }
    }
  }

  _setQuotaRefreshNotice(text) {
    const grid = document.getElementById('providerQuotaGrid');
    if (!grid || !text) return null;
    const prev = document.getElementById('providerQuotaRefreshNotice');
    if (prev) prev.remove();
    const el = document.createElement('div');
    el.id = 'providerQuotaRefreshNotice';
    el.className = 'model-quota-loading';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="loading-spinner sm"></span><span></span>';
    el.lastElementChild.textContent = text;
    grid.prepend(el);
    return el;
  }

  _clearQuotaRefreshNotice() {
    document.getElementById('providerQuotaRefreshNotice')?.remove();
  }

  _startQuotaBackgroundRefresh() {
    if (this._quotaRefreshPromise) return this._quotaRefreshPromise;
    const grid = document.getElementById('providerQuotaGrid');
    if (!grid) return null;
    const hasContent = grid.querySelector('.model-quota-card, .model-quota-loading');
    // 已有缓存卡片时，才需要“后台刷新”提示；首屏尚无内容时由 loadProviderQuota 负责骨架
    if (!hasContent || grid.querySelector('.model-quota-card')) {
      this._setQuotaRefreshNotice(t('正在后台刷新供应商额度...'));
    }
    const refreshBtn = document.getElementById('providerQuotaRefreshBtn');
    if (refreshBtn) { refreshBtn.classList.add('is-loading'); refreshBtn.disabled = true; }
    this._quotaRefreshPromise = fetch('/api/user/providers/quota/refresh', { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        this._providerQuotaLoadedOnce = true;
        this.renderProviderQuota(data.providers || []);
      })
      .catch((e) => { console.warn(t('后台刷新供应商额度失败:'), e); })
      .finally(() => {
        this._clearQuotaRefreshNotice();
        if (refreshBtn) { refreshBtn.classList.remove('is-loading'); refreshBtn.disabled = false; }
        this._quotaRefreshPromise = null;
      });
    return this._quotaRefreshPromise;
  }

  formatQuotaResetTime(resetAt) {
    if (!resetAt) return '';
    const target = new Date(resetAt);
    if (Number.isNaN(target.getTime())) return `${t('重置于')}${resetAt}`;
    const diff = target.getTime() - Date.now();
    if (diff <= 0) return t('即将重置');
    const minutes = Math.floor(diff / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const restMinutes = minutes % 60;
    if (days > 0) return `${days}${t('天')}${hours}${t('小时后重置')}`;
    if (hours > 0) return `${hours}${t('小时')}${restMinutes}${t('分钟后重置')}`;
    return `${Math.max(1, restMinutes)}${t('分钟后重置')}`;
  }

  renderProviderQuota(providers) {
    const section = document.getElementById('providerQuotaSection');
    const grid = document.getElementById('providerQuotaGrid');
    if (!section || !grid) return;

    if (!providers.length) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    setHTML(grid, providers.map(p => {
      if (p.error) {
        return `
          <div class="model-quota-card error">
            <div class="model-quota-name">${escapeHtml(p.name)}</div>
            <div style="font-size:12px;color:var(--destructive);">查询失败</div>
          </div>`;
      }

      const q = p.quota;
      const total = parseFloat(q.total) || 0;
      const used = parseFloat(q.used) || 0;
      const periods = Array.isArray(q.periods) ? q.periods : [];
      const currentPercent = Number(q.currentPercent ?? periods.find(period => period.key === 'current_period')?.percent);
      const pct = Number.isFinite(currentPercent)
        ? Math.round(currentPercent)
        : (total > 0 ? Math.round(used / total * 100) : 0);

      let barColor = 'var(--primary)';
      if (pct >= 90) barColor = 'var(--destructive)';
      else if (pct >= 70) barColor = 'var(--warning)';

      const credits = q.credits || {};
      const resetCredits = q.rateLimitResetCredits?.available_count;
      const creditsHtml = (credits.hasCredits || credits.unlimited || credits.balance !== undefined || resetCredits !== undefined) ? `
        <div class="model-quota-credits">
          <span>Credits：${escapeHtml(credits.unlimited ? t('无限') : String(credits.balance ?? '0'))}</span>
          ${resetCredits !== undefined ? `${'<span>' + t('可手动重置：')}${escapeHtml(String(resetCredits))}${t('次')}</span>` : ''}
        </div>` : '';

      const periodHtml = periods.length ? `
        <div class="model-quota-periods">
          ${periods.map(period => {
            const periodPct = Math.max(0, Math.min(100, Number(period.percent) || 0));
            let periodColor = 'var(--primary)';
            if (periodPct >= 90) periodColor = 'var(--destructive)';
            else if (periodPct >= 70) periodColor = 'var(--warning)';
            const resetText = period.resetsAt ? this.formatQuotaResetTime(period.resetsAt) : '';
            const resetTitle = period.resetsAt ? new Date(period.resetsAt).toLocaleString('zh-CN', { hour12: false }) : '';
            const periodRange = period.startsAt || period.resetsAt
              ? `${period.startsAt ? this.formatQuotaResetTime(period.startsAt) : ''}${period.startsAt && period.resetsAt ? t(' 至 ') : ''}${period.resetsAt ? this.formatQuotaResetTime(period.resetsAt) : t('未知')}`
              : '';
            return `
              <div class="model-quota-period">
                <div class="model-quota-period-header">
                  <span>${escapeHtml(period.label || period.key || t('额度'))}</span>
                  <span>已用 ${periodPct}%</span>
                </div>
                <div class="model-quota-bar">
                  <div class="model-quota-bar-fill" style="width:${periodPct}%;background:${periodColor};"></div>
                </div>
                ${periodRange ? `<div class="model-quota-period-reset" title="${escapeHtml(resetTitle)}">${t('周期：')}${escapeHtml(periodRange)}</div>` : ''}
              </div>`;
          }).join('')}
        </div>` : `
        <div class="model-quota-bar">
          <div class="model-quota-bar-fill" style="width:${Math.min(pct, 100)}%;background:${barColor};"></div>
        </div>
        <div class="model-quota-pct">已用 ${pct}%</div>`;

      return `
        <div class="model-quota-card">
          <div class="model-quota-header">
            <span class="model-quota-name">${escapeHtml(p.name)}</span>
            <span class="model-quota-plan">${escapeHtml(q.planName || '')}</span>
          </div>
          ${periods.length ? periodHtml : `
          <div class="model-quota-numbers">
            <span class="model-quota-remaining">${escapeHtml(String(q.remaining ?? 0))}</span>
            <span class="model-quota-total">/ ${escapeHtml(String(q.total ?? 0))}</span>
          </div>
          ${periodHtml}`}
          ${creditsHtml}
          ${p.checked_at ? `${'<div class="model-quota-updated">' + t('更新于')}${escapeHtml(this._formatQuotaCheckedAt(p.checked_at))}</div>` : ''}
        </div>`;
    }).join(''));
  }

  _formatQuotaCheckedAt(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  renderModelLibrary(libraryData, currentModel) {
    const container = document.getElementById('modelLibraryContent');

    // 无 API Key 时优先引导创建（仍展示模型列表时在绑定栏提示）
    const noKeys = !this._libraryKeys || this._libraryKeys.length === 0;

    const starredModels = libraryData.starred_models || [];
    const starredHtml = this._renderStarredModelsSection(starredModels, currentModel);

    // 检查是否有 Team
    if ((!libraryData.teams || libraryData.teams.length === 0) && !starredModels.length) {
      setHTML(container, `
        <div class="empty-state model-library-empty" style="padding:60px 20px;text-align:center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" style="margin-bottom:16px;opacity:0.5;">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <p style="font-size:15px;color:var(--muted-foreground);margin:0;">暂无可用模型</p>
          <p style="font-size:13px;color:var(--muted-foreground);margin:8px 0 16px;opacity:0.7;">请联系管理员添加模型或加入 Team，也可添加自己的供应商</p>
          <div class="model-library-empty-actions">
            ${noKeys ? '<button class="btn btn-primary btn-sm" onclick="app.navigateTo(\'apiKeys\')">' + t('创建 API Key') + '</button>' : ''}
            <button class="btn btn-secondary btn-sm" onclick="app.showAddProviderModal()">添加供应商</button>
            <button class="btn btn-secondary btn-sm" onclick="app.navigateTo(\'myUpstream\')">管理我的上游</button>
          </div>
        </div>
      `);
      return;
    }

    // 检查是否有模型
    const hasModels = (libraryData.teams || []).some(t => t.providers && t.providers.length > 0);
    if (!hasModels && !starredModels.length) {
      setHTML(container, `
        <div class="empty-state model-library-empty" style="padding:60px 20px;text-align:center;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" style="margin-bottom:16px;opacity:0.5;">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
          <p style="font-size:15px;color:var(--muted-foreground);margin:0;">暂无可用模型</p>
          <p style="font-size:13px;color:var(--muted-foreground);margin:8px 0 16px;opacity:0.7;">可调整筛选，或添加自己的上游供应商导入模型</p>
          <div class="model-library-empty-actions">
            ${noKeys ? '<button class="btn btn-primary btn-sm" onclick="app.navigateTo(\'apiKeys\')">' + t('创建 API Key') + '</button>' : ''}
            <button class="btn btn-secondary btn-sm" onclick="app.showAddProviderModal()">添加供应商</button>
          </div>
        </div>
      `);
      return;
    }

    // 渲染 Team/Provider/Model 层级结构
    // 默认折叠所有供应商，模型明细在展开供应商时按需加载
    setHTML(container, starredHtml + (libraryData.teams || []).map((team, teamIndex) => {
      if (!team.providers || team.providers.length === 0) {
        return '';
      }

      return `
        <div class="model-library-team" data-team-index="${teamIndex}" data-team-id="${escapeHtml(team.team_id)}">
          <div class="model-library-team-header" onclick="app.toggleTeam(${teamIndex})">
            <svg class="collapse-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
            <h3>${escapeHtml(team.team_name)}</h3>
            ${team.is_personal ? '<span class="team-badge">' + t('个人') + '</span>' : ''}
            ${team.is_default ? '<span class="team-badge default">' + t('默认') + '</span>' : ''}
            ${this._renderLibraryMoveControls('team', team.team_id)}
            <div style="flex:1;"></div>
            <button class="btn btn-sm btn-secondary model-test-btn" style="padding:4px 8px;font-size:11px;" onclick="event.stopPropagation();app.testTeamModels('${team.team_id}')" title="${t('测试此 Team 下所有模型')}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              测试全部
            </button>
          </div>

          <div class="model-library-team-content">
          ${team.providers.map((provider, providerIndex) => {
            const isProviderDisabled = provider.provider_enabled === false;
            const isProviderHidden = !!provider.is_hidden;
            const providerKey = `${team.team_id}::${provider.provider_id}`;
            const hasModels = provider.models_loaded && provider.models && provider.models.length > 0;
            const displayCount = this.libraryShowHidden
              ? (provider.model_count != null ? provider.model_count : (provider.models ? provider.models.length : 0))
              : (provider.visible_model_count != null ? provider.visible_model_count
                : (provider.model_count != null
                  ? Math.max((provider.model_count || 0) - (provider.hidden_model_count || 0), 0)
                  : (provider.models ? provider.models.length : 0)));
            const providerMoreItems = [
              {
                label: isProviderHidden ? t('取消隐藏') : t('隐藏此供应商'),
                icon: isProviderHidden ? 'eye' : 'eye-off',
                onClick: `app.hideLibraryProvider('${this._jsString(team.team_id)}', '${this._jsString(provider.provider_id)}', ${isProviderHidden ? 'false' : 'true'})`
              }
            ];
            return `
            <div class="model-library-provider collapsed ${isProviderDisabled ? 'provider-disabled' : ''} ${isProviderHidden ? 'provider-hidden' : ''}" data-provider-index="${teamIndex}-${providerIndex}" data-team-id="${escapeHtml(team.team_id)}" data-provider-id="${escapeHtml(provider.provider_id)}" style="${isProviderDisabled ? 'position:relative;' : ''}">
              ${isProviderDisabled ? '<div class="provider-disabled-overlay"></div>' : ''}
              <div class="model-library-provider-header" onclick="app.toggleProvider(${teamIndex}, ${providerIndex})">
                <div class="model-library-provider-title">
                  <svg class="collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                  <span class="provider-name">${escapeHtml(provider.provider_name)}</span>
                  ${this._renderProviderTestSummary(provider)}
                  ${(provider.tags || []).map(t =>
                    `<span class="model-item-badge" style="background:${t.color}18;color:${t.color};border:1px solid ${t.color}44;">${escapeHtml(t.name)}</span>`
                  ).join('')}
                  ${this._renderLibraryMoveControls('provider', team.team_id, provider.provider_id)}
                  ${isProviderDisabled ? '<span style="color:var(--destructive);font-size:11px;font-weight:500;">' + t('已禁用') + '</span>' : ''}
                  ${isProviderHidden ? '<span class="library-hidden-badge">' + t('已隐藏') + '</span>' : ''}
                </div>
                <div class="model-library-provider-actions">
                  <span class="lib-ping" data-provider-id="${provider.provider_id}" style="font-size:12px;color:var(--muted-foreground);"></span>
                  <button class="btn btn-sm btn-secondary model-test-btn" style="padding:4px 6px;" title="${t('测试此供应商下所有模型')}" onclick="event.stopPropagation();app.testProviderModels('${team.team_id}', '${provider.provider_id}')">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    测试
                  </button>
                  <button class="btn btn-sm btn-secondary" style="padding:4px 6px;" title="${t('检测连通性')}" onclick="event.stopPropagation();app.pingLibraryProvider('${provider.provider_id}')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  </button>
                  ${this._renderLibraryMoreMenu(providerMoreItems)}
                  <span class="provider-model-count">${displayCount} 个模型</span>
                </div>
              </div>
              <div class="model-library-list">
                  ${hasModels
                    ? `<div class="model-library-placeholder" data-placeholder="${escapeHtml(providerKey)}">
                        <span class="placeholder-text">${provider.models.length} 个模型</span>
                      </div>`
                    : `<div class="model-library-placeholder" data-placeholder="${escapeHtml(providerKey)}">
                        <span class="placeholder-text">${provider.models_loaded ? t('该供应商下暂无模型') : t('点击展开以加载模型')}</span>
                      </div>`}
              </div>
            </div>
          `;}).join('')}
          </div>
        </div>
      `;
    }).join(''));
  }

  // 渲染单个模型库条目（供 renderModelLibrary 与按需加载复用）
  _renderModelLibraryItem(model, team, currentModel, isProviderDisabled, options = {}) {
    if (!model) return '';
    const isOwner = !!(team?.is_personal && this.user && model.created_by === this.user.id);
    const modelId = model.model_id || model.id;
    if (modelId == null || modelId === '') return '';
    const isKeyPicker = options.mode === 'keyPicker';
    let queueIndex = -1;
    let inQueue = false;
    if (isKeyPicker && this._keyModelPicker) {
      const assigned = this._keyModelPicker.assignedModelIds;
      if (assigned && typeof assigned.has === 'function') {
        inQueue = assigned.has(String(modelId));
      }
      if (Array.isArray(this._keyModelPicker.queue)) {
        queueIndex = this._keyModelPicker.queue.findIndex(m => String(m?.id) === String(modelId));
        if (queueIndex >= 0) inQueue = true;
      }
    }
    const isCurrent = (currentModel && String(currentModel.id) === String(modelId)) || inQueue;
    const modelMult = parseFloat(model.model_multiplier || 1.0);
    const isModelHidden = !!model.is_hidden;
    const isStarred = !!model.is_starred;
    const providerId = model.provider_id || model.provider || '';
    const teamId = team?.team_id || model.team_id || '';
    const onClick = options.onClick || `app.selectModel('${this._jsString(modelId)}')`;
    const subtitleHtml = options.subtitle || '';

    const testOk = model.test_ok;
    const testLatency = model.test_latency_ms;
    const testTps = model.test_tokens_per_second;
    const testTestedAt = model.test_tested_at;

    const testTpsText = this._formatTestTps(testTps);

    let testBadgeHtml = '';
    if (testOk === true) {
      const tpsText = testTpsText ? ` - ${testTpsText} t/s` : '';
      testBadgeHtml = `<span class="model-test-badge pass" data-tested-at="${escapeHtml(testTestedAt || '')}">${testLatency}ms${tpsText}</span>`;
    } else if (testOk === false) {
      testBadgeHtml = `<span class="model-test-badge fail" data-tested-at="${escapeHtml(testTestedAt || '')}">${t('失败')}</span>`;
    }

    const modelMoreItems = isKeyPicker ? [] : [
      {
        label: isStarred ? t('取消星标') : t('星标此模型'),
        icon: isStarred ? 'star' : 'star-off',
        onClick: `app.toggleLibraryStar('${this._jsString(teamId)}', '${this._jsString(providerId)}', '${this._jsString(modelId)}', ${isStarred ? 'false' : 'true'})`
      },
      {
        label: isModelHidden ? t('取消隐藏') : t('隐藏此模型'),
        icon: isModelHidden ? 'eye' : 'eye-off',
        onClick: `app.hideLibraryModel('${this._jsString(teamId)}', '${this._jsString(providerId)}', '${this._jsString(modelId)}', ${isModelHidden ? 'false' : 'true'})`
      },
      ...(isOwner ? [
        { type: 'divider' },
        {
          label: t('编辑'),
          onClick: `app.showEditModelModal('${this._jsString(modelId)}')`
        },
        {
          label: t('发布'),
          onClick: `app.publishModel('${this._jsString(modelId)}')`
        },
        {
          label: t('删除'),
          className: 'danger',
          onClick: `app.deleteUserModel('${this._jsString(modelId)}')`
        }
      ] : [])
    ];

    return `
    <div class="model-library-item ${isCurrent ? 'selected' : ''} ${isProviderDisabled ? 'model-disabled' : ''} ${isModelHidden ? 'model-hidden' : ''} ${isStarred ? 'model-starred' : ''}" data-model-id="${escapeHtml(modelId)}" data-team-id="${escapeHtml(teamId)}" data-provider-id="${escapeHtml(providerId)}" ${isProviderDisabled ? '' : `onclick="${onClick}"`}>
      <div class="model-library-item-info">
        <div class="model-library-item-name">
          ${isKeyPicker ? '' : `<button type="button" class="model-star-btn ${isStarred ? 'starred' : ''}" title="${isStarred ? t('取消星标') : t('星标此模型')}" aria-pressed="${isStarred ? 'true' : 'false'}" onclick="event.stopPropagation();app.toggleLibraryStar('${this._jsString(teamId)}', '${this._jsString(providerId)}', '${this._jsString(modelId)}', ${isStarred ? 'false' : 'true'})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${isStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </button>`}
          ${model.series_icon_url ? `<img src="${model.series_icon_url}" onerror="this.style.display='none'">` : ''}
          <span>${escapeHtml(model.name)}</span>
          ${testBadgeHtml}
          <div class="model-item-badges">
            ${subtitleHtml}
            ${model.series ? `<span class="model-item-badge series">${escapeHtml(model.series)}</span>` : ''}
            ${isOwner ? '<span class="model-item-badge owner">' + t('我的') + '</span>' : ''}
            ${isStarred ? '<span class="library-star-badge">' + t('星标') + '</span>' : ''}
            ${isModelHidden ? '<span class="library-hidden-badge">' + t('已隐藏') + '</span>' : ''}
          </div>
        </div>
        ${model.description ? `<div class="model-library-item-desc">${escapeHtml(model.description)}</div>` : ''}
        <div class="model-library-item-price">
          <span class="model-price-item">
            <span class="model-price-label">倍率</span>
            <span class="model-price-value">×${modelMult.toFixed(2)}</span>
          </span>
        </div>
        ${this._renderModelUptimeSlot(modelId, model.name)}
      </div>
      <div class="model-library-item-actions">
        ${isKeyPicker ? '' : this._renderLibraryMoveControls('model', team.team_id, providerId)}
        ${isProviderDisabled
          ? '<button class="btn btn-sm btn-secondary" disabled style="opacity:0.5;">' + t('供应商已禁用') + '</button>'
          : isKeyPicker
            ? (queueIndex >= 0
              ? `<button class="btn btn-sm btn-secondary" title="${t('再次点击可移出队列')}">${t('队列 #')}${queueIndex + 1}</button>`
              : '<button class="btn btn-sm btn-primary">' + t('加入队列') + '</button>')
          : `
             <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();app.testModel('${this._jsString(modelId)}', this)" title="${t('测试模型连通性')}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              测试
            </button>
            ${isOwner
              ? ''
              : isCurrent
                ? '<button class="btn btn-sm btn-secondary" disabled>' + t('已绑定') + '</button>'
                : '<button class="btn btn-sm btn-primary">' + t('绑定') + '</button>'}
          `}
        ${isKeyPicker ? '' : this._renderLibraryMoreMenu(modelMoreItems)}
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
    const nameAttr = escapeHtml(modelName || modelId || '');
    const idAttr = escapeHtml(modelId || '');
    if (cached) {
      return this._renderModelUptimeCompact(modelId, modelName, cached);
    }
    const n = this._uptimeSlotCount || 96;
    return `<div class="model-uptime" data-uptime-model="${idAttr}" data-uptime-name="${nameAttr}" title="${t('加载调用状态...')}" onclick="event.stopPropagation();app.showModelUptimeDetailFromEl(this)">
      <div class="model-uptime-spark">${Array(n).fill('<span class="model-uptime-bar none"></span>').join('')}</div>
      <span class="model-uptime-pct">—</span>
    </div>`;
  }

  _renderModelUptimeCompact(modelId, modelName, summary) {
    const spark = Array.isArray(summary?.spark) ? summary.spark : [];
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
    return `<div class="model-uptime" data-uptime-model="${escapeHtml(modelId)}" data-uptime-name="${escapeHtml(modelName || modelId || '')}" title="${t('近 24 小时调用可用率（每 15 分钟）· 点击查看详情')}" onclick="event.stopPropagation();app.showModelUptimeDetailFromEl(this)">
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
        const res = await fetch(`/api/user/models/uptime?ids=${encodeURIComponent(batch.join(','))}&days=${this._uptimeDays}`);
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
    const title = document.getElementById('modelUptimeModalTitle');
    const body = document.getElementById('modelUptimeModalBody');
    if (!body) return;
    if (title) title.textContent = `${modelName || modelId}${t('· 调用状态（近 24 小时）')}`;
    setHTML(body, pageLoadingHtml(t('加载中...'), { compact: true }));
    this.showModal('modelUptimeModal');
    try {
      const res = await fetch(`/api/user/models/${encodeURIComponent(modelId)}/uptime?days=${this._uptimeDays}`);
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

  _libraryMoreMenuIcon(name) {
    if (name === 'eye') {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    }
    if (name === 'eye-off') {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    }
    if (name === 'star' || name === 'star-off') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="${name === 'star' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    }
    return '';
  }

  // 渲染模型库「⋯」更多菜单
  _renderLibraryMoreMenu(items = []) {
    if (!items || !items.length) return '';
    const menuItems = items.map(item => {
      if (item.type === 'divider') return '<div class="library-more-menu-divider"></div>';
      const icon = item.icon ? this._libraryMoreMenuIcon(item.icon) : '';
      const cls = item.className ? ` ${item.className}` : '';
      return `<button type="button" class="library-more-menu-item${cls}" onclick="event.stopPropagation();app.closeLibraryMoreMenus();${item.onClick}">${icon}<span>${escapeHtml(item.label)}</span></button>`;
    }).join('');

    return `
      <div class="library-more-menu" onclick="event.stopPropagation()">
        <button type="button" class="btn btn-sm btn-secondary library-more-btn" title="${t('更多操作')}" onclick="event.stopPropagation();app.toggleLibraryMoreMenu(event, this)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>
          </svg>
        </button>
        <div class="library-more-menu-panel" style="display:none;">
          ${menuItems}
        </div>
      </div>`;
  }

  closeLibraryMoreMenus(exceptEl = null) {
    document.querySelectorAll('.library-more-menu.open').forEach(menu => {
      if (exceptEl && menu === exceptEl) return;
      menu.classList.remove('open');
      const panel = menu.querySelector('.library-more-menu-panel');
      if (panel) panel.style.display = 'none';
    });
  }

  toggleLibraryMoreMenu(event, btn) {
    event.stopPropagation();
    const menu = btn?.closest('.library-more-menu');
    if (!menu) return;
    const panel = menu.querySelector('.library-more-menu-panel');
    if (!panel) return;
    const willOpen = !menu.classList.contains('open');
    this.closeLibraryMoreMenus(willOpen ? menu : null);
    if (willOpen) {
      menu.classList.add('open');
      panel.style.display = 'block';
      // 靠近底部时向上弹出，避免被裁切
      const rect = panel.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 8) {
        panel.classList.add('drop-up');
      } else {
        panel.classList.remove('drop-up');
      }
      const close = (e) => {
        if (!menu.contains(e.target)) {
          this.closeLibraryMoreMenus();
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    } else {
      menu.classList.remove('open');
      panel.style.display = 'none';
    }
  }

  toggleTeam(teamIndex) {
    const teamEl = document.querySelector(`[data-team-index="${teamIndex}"]`);
    if (teamEl) {
      teamEl.classList.toggle('collapsed');
    }
  }

  _findLibraryTeamProvider(teamId, providerId) {
    const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
    const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
    return { team, provider };
  }

  async toggleProvider(teamIndex, providerIndex) {
    const providerEl = document.querySelector(`[data-provider-index="${teamIndex}-${providerIndex}"]`);
    if (!providerEl) return;

    // 折叠状态：仅切换 class，不加载
    if (!providerEl.classList.contains('collapsed')) {
      providerEl.classList.add('collapsed');
      return;
    }

    // 展开状态：若尚未加载模型明细，则按需加载
    const teamId = providerEl.getAttribute('data-team-id');
    const providerId = providerEl.getAttribute('data-provider-id');
    const { team, provider } = this._findLibraryTeamProvider(teamId, providerId);
    if (!team || !provider) return;

    providerEl.classList.remove('collapsed');

    if (!provider.models_loaded || provider.models_query_key !== this._getProviderModelsQueryKey(team, provider)) {
      await this._loadProviderModels(team, provider, providerEl, { page: 1, force: true });
    } else {
      this._renderProviderModelsInto(providerEl, provider, team);
    }
  }

  _getProviderModelsQuery(team, provider, page = 1) {
    const rawSearch = (this.librarySearch || '').trim();
    const normalizedSearch = rawSearch.toLowerCase();
    const teamMatch = normalizedSearch && (team.team_name || '').toLowerCase().includes(normalizedSearch);
    const providerMatch = normalizedSearch && (provider.provider_name || '').toLowerCase().includes(normalizedSearch);

    return {
      page: Math.max(parseInt(page, 10) || 1, 1),
      limit: this._libraryProviderPageSize,
      search: teamMatch || providerMatch ? '' : rawSearch,
      series: this.librarySeriesFilter || 'all',
      test: this.libraryTestFilter || 'all',
      sort: this.librarySort || 'default',
      includeHidden: !!this.libraryShowHidden
    };
  }

  _getProviderModelsQueryKey(team, provider) {
    const query = this._getProviderModelsQuery(team, provider, 1);
    return JSON.stringify({
      search: query.search,
      series: query.series,
      test: query.test,
      sort: query.sort,
      includeHidden: query.includeHidden
    });
  }

  _buildProviderModelsUrl(team, provider, page) {
    const query = this._getProviderModelsQuery(team, provider, page);
    const params = new URLSearchParams();
    params.set('page', query.page);
    params.set('limit', query.limit);
    if (query.search) params.set('search', query.search);
    if (query.series && query.series !== 'all') params.set('series', query.series);
    if (query.test && query.test !== 'all') params.set('test', query.test);
    if (query.sort && query.sort !== 'default') params.set('sort', query.sort);
    if (query.includeHidden) params.set('include_hidden', '1');
    return `/api/user/team/${encodeURIComponent(team.team_id)}/provider/${encodeURIComponent(provider.provider_id)}/models?${params.toString()}`;
  }

  _findProviderEl(teamId, providerId, preferredEl = null) {
    try {
      const sel = `.model-library-provider[data-team-id="${CSS.escape(String(teamId))}"][data-provider-id="${CSS.escape(String(providerId))}"]`;
      const found = document.querySelector(sel);
      if (found) return found;
    } catch (_) { /* CSS.escape 异常时回退 */ }
    if (preferredEl && preferredEl.isConnected) return preferredEl;
    return null;
  }

  // 按需加载指定供应商下的模型明细
  async _loadProviderModels(team, provider, providerEl, options = {}) {
    if (!team || !provider || provider.provider_id == null || provider.provider_id === '') {
      console.warn(t('[模型库] 加载跳过：缺少 team/provider'), { team, provider });
      return;
    }
    let providerKey = options.providerKey;
    if (!providerKey) providerKey = `${team.team_id}::${provider.provider_id}`;
    const page = Math.max(parseInt(options.page || provider.models_page || 1, 10) || 1, 1);
    const queryKey = this._getProviderModelsQueryKey(team, provider);
    if (!options.force && provider.models_loaded && provider.models_page === page && provider.models_query_key === queryKey) return;
    const existingLoad = this._libraryLoadingProviderPromises.get(providerKey);
    if (existingLoad) {
      await existingLoad.catch(() => {});
      if (provider.models_loaded && provider.models_page === page && provider.models_query_key === queryKey) {
        const freshEl = this._findProviderEl(team.team_id, provider.provider_id, providerEl);
        if (freshEl) {
          freshEl.classList.remove('collapsed');
          try { this._renderProviderModelsInto(freshEl, provider, team); } catch (renderErr) {
            console.warn(t('[模型库] 渲染已加载模型失败:'), renderErr);
          }
        }
        return;
      }
      if (this._libraryLoadingProviders.has(providerKey)) return;
    }
    this._libraryLoadingProviders.add(providerKey);
    let resolveLoad;
    const loadPromise = new Promise(resolve => { resolveLoad = resolve; });
    this._libraryLoadingProviderPromises.set(providerKey, loadPromise);

    // 仅在 DOM 元素存在时显示加载状态
    const loadingEl = this._findProviderEl(team.team_id, provider.provider_id, providerEl);
    if (loadingEl) {
      const list = loadingEl.querySelector('.model-library-list');
      if (list) setHTML(list, `<div class="model-library-placeholder" data-placeholder="${escapeHtml(providerKey)}">${inlineLoadingHtml(t('正在加载模型...'), 'sm')}</div>`);
    }

    try {
      const url = this._buildProviderModelsUrl(team, provider, page);
      const res = await fetch(url);
      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.json();
          detail = errBody?.error || errBody?.message || '';
        } catch (_) {
          try { detail = (await res.text()).slice(0, 200); } catch (__) { /* ignore */ }
        }
        throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
      }
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(t('响应不是合法 JSON: ') + (parseErr?.message || parseErr));
      }

      provider.models = Array.isArray(data.models) ? data.models : [];
      provider.models_loaded = true;
      provider.models_page = data.pagination?.page || page;
      provider.models_query_key = queryKey;
      provider.pagination = data.pagination || {
        page,
        limit: this._libraryProviderPageSize,
        total: provider.models.length,
        total_pages: 1,
        has_prev: false,
        has_next: false
      };
      if (!this.librarySearch && this.librarySeriesFilter === 'all' && this.libraryTestFilter === 'all') {
        const pageTotal = data.pagination?.total ?? provider.models.length;
        if (this.libraryShowHidden) {
          provider.model_count = pageTotal;
        } else {
          // 未包含隐藏项时，接口 total 仅为可见模型数
          provider.visible_model_count = pageTotal;
          if (provider.model_count == null) {
            provider.model_count = pageTotal + (provider.hidden_model_count || 0);
          }
        }
      }

      // fetch 完成后 DOM 可能已被 renderModelLibrary 重建，重新查询当前元素
      // 注意：不要要求原始 providerEl 仍有效，否则成功加载后不渲染
      const freshEl = this._findProviderEl(team.team_id, provider.provider_id, providerEl);
      if (freshEl) {
        freshEl.classList.remove('collapsed');
        try {
          this._renderProviderModelsInto(freshEl, provider, team);
        } catch (renderErr) {
          console.warn(t('[模型库] 渲染供应商模型失败:'), {
            teamId: team.team_id,
            providerId: provider.provider_id,
            error: renderErr?.message || String(renderErr),
            stack: renderErr?.stack
          });
          const listEl = freshEl.querySelector('.model-library-list');
          if (listEl) {
            setHTML(listEl, `<div class="model-library-placeholder"><span class="placeholder-text" style="color:var(--destructive);">渲染失败，<a href="#" onclick="event.preventDefault();app._retryLoadProviderModels('${escapeHtml(String(team.team_id))}','${escapeHtml(String(provider.provider_id))}\')">${t('重试')}</a></span></div>`);
          }
        }
      }
      try { this._refreshProviderTestSummary(team, provider); } catch (_) { /* ignore */ }
      try { this._rebuildSeriesFilter(); } catch (_) { /* ignore */ }
    } catch (e) {
      // 导航/刷新导致的中断不作为失败提示
      const msg = e?.message || String(e);
      const aborted = e?.name === 'AbortError' || /abort|failed to fetch|networkerror|load failed/i.test(msg);
      console.warn(t('[模型库] 加载供应商模型失败:'), {
        teamId: team?.team_id,
        providerId: provider?.provider_id,
        page,
        error: msg
      });
      const failEl = this._findProviderEl(team.team_id, provider.provider_id, providerEl);
      if (failEl && !aborted) {
        const listEl = failEl.querySelector('.model-library-list');
        if (listEl) setHTML(listEl, `<div class="model-library-placeholder"><span class="placeholder-text" style="color:var(--destructive);">加载失败，<a href="#" onclick="event.preventDefault();app._retryLoadProviderModels('${escapeHtml(String(team.team_id))}','${escapeHtml(String(provider.provider_id))}\')">${t('重试')}</a></span></div>`);
      }
    } finally {
      this._libraryLoadingProviders.delete(providerKey);
      if (this._libraryLoadingProviderPromises.get(providerKey) === loadPromise) {
        this._libraryLoadingProviderPromises.delete(providerKey);
      }
      resolveLoad();
      // 搜索后台加载完成后，用 rAF 合并多个加载完成事件，一次性重新筛选
      if (this.librarySearch && !this._librarySearchRafPending) {
        this._librarySearchRafPending = true;
        requestAnimationFrame(() => {
          this._librarySearchRafPending = false;
          if (this.librarySearch) this.filterAndRenderModelLibrary();
        });
      }
    }
  }

  // 重试加载某个供应商的模型（按 teamId/providerId 查找 DOM 与数据）
  async _retryLoadProviderModels(teamId, providerId) {
    const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(teamId)}"][data-provider-id="${CSS.escape(providerId)}"]`);
    if (!providerEl) return;
    const { team, provider } = this._findLibraryTeamProvider(teamId, providerId);
    if (!team || !provider) return;
    provider.models_loaded = false;
    await this._loadProviderModels(team, provider, providerEl);
  }

  // 将已加载的模型渲染进指定供应商的 .model-library-list
  _renderProviderModelsInto(providerEl, provider, team) {
    const listEl = providerEl.querySelector('.model-library-list');
    if (!listEl) return;
    const isProviderDisabled = provider.provider_enabled === false;
    const currentModel = this._libraryCurrentModel;
    const queryKey = this._getProviderModelsQueryKey(team, provider);

    // 取消之前的渐进渲染任务
    if (this._pendingProviderRenderRaf) {
      cancelAnimationFrame(this._pendingProviderRenderRaf);
      this._pendingProviderRenderRaf = null;
    }

    if (!provider.models_loaded || provider.models_query_key !== queryKey) {
      this._loadProviderModels(team, provider, providerEl, { page: 1, force: true });
      return;
    }

    if (!provider.models || provider.models.length === 0) {
      const hasActiveFilter = this.librarySearch || this.librarySeriesFilter !== 'all' || this.libraryTestFilter !== 'all';
      setHTML(listEl, `<div class="model-library-placeholder"><span class="placeholder-text">${hasActiveFilter ? t('没有符合筛选条件的模型') : t('该供应商下暂无模型')}</span></div>`);
      return;
    }

    const _buildItem = (m) => this._renderModelLibraryItem(m, team, currentModel, isProviderDisabled);
    setHTML(listEl, provider.models.map(m => _buildItem(m)).join('') + this._renderProviderPagination(team, provider));
    this._loadModelUptimeForIds(provider.models.map(m => m.model_id || m.id));

    // 更新计数显示
    const countEl = providerEl.querySelector('.provider-model-count');
    if (countEl) {
      const displayCount = this.libraryShowHidden
        ? (provider.model_count ?? provider.pagination?.total ?? provider.models.length)
        : (provider.visible_model_count != null
          ? provider.visible_model_count
          : (provider.pagination?.total ?? provider.models.length));
      countEl.textContent = `${displayCount}${t('个模型')}`;
    }
  }

  _renderProviderPagination(team, provider) {
    const pagination = provider.pagination;
    if (!pagination || pagination.total <= pagination.limit) return '';

    const current = pagination.page || 1;
    const totalPages = pagination.total_pages || 1;
    const pages = [];
    const addPage = (p) => {
      if (p >= 1 && p <= totalPages && !pages.includes(p)) pages.push(p);
    };

    addPage(1);
    addPage(current - 1);
    addPage(current);
    addPage(current + 1);
    addPage(totalPages);
    pages.sort((a, b) => a - b);

    let lastPage = 0;
    const pageButtons = pages.map(p => {
      const gap = p - lastPage > 1 ? '<span class="model-library-page-ellipsis">...</span>' : '';
      lastPage = p;
      return `${gap}<button class="model-library-page-btn ${p === current ? 'active' : ''}" ${p === current ? 'disabled' : ''} onclick="event.stopPropagation();app.loadProviderModelsPage('${escapeHtml(team.team_id)}','${escapeHtml(provider.provider_id)}',${p})">${p}</button>`;
    }).join('');

    return `
      <div class="model-library-pagination">
        <button class="model-library-page-btn" ${pagination.has_prev ? '' : 'disabled'} onclick="event.stopPropagation();app.loadProviderModelsPage('${escapeHtml(team.team_id)}','${escapeHtml(provider.provider_id)}',${current - 1})">上一页</button>
        ${pageButtons}
        <button class="model-library-page-btn" ${pagination.has_next ? '' : 'disabled'} onclick="event.stopPropagation();app.loadProviderModelsPage('${escapeHtml(team.team_id)}','${escapeHtml(provider.provider_id)}',${current + 1})">下一页</button>
        <span class="model-library-page-summary">共 ${pagination.total} 个</span>
      </div>
    `;
  }

  async loadProviderModelsPage(teamId, providerId, page) {
    const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
    const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
    if (!team || !provider) return;
    const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(teamId))}"][data-provider-id="${CSS.escape(String(providerId))}"]`);
    if (!providerEl) return;
    providerEl.classList.remove('collapsed');
    await this._loadProviderModels(team, provider, providerEl, { page, force: true });
  }

  // 加载所有供应商的模型明细（用于"测试全部模型"前置加载）
  async _ensureAllProviderModelsLoaded() {
    if (!this._libraryData) return;
    const tasks = [];
    for (const team of this._libraryData.teams || []) {
      for (const p of team.providers || []) {
        if (!p.models_loaded) {
          const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(p.provider_id))}"]`);
          if (providerEl) tasks.push(this._loadProviderModels(team, p, providerEl));
        }
      }
    }
    if (tasks.length) await Promise.all(tasks);
  }

  // 加载指定 Team 下所有供应商的模型明细
  async _ensureTeamProviderModelsLoaded(team) {
    if (!team) return;
    const tasks = [];
    for (const p of team.providers || []) {
      if (!p.models_loaded) {
        const providerEl = document.querySelector(`.model-library-provider[data-team-id="${CSS.escape(String(team.team_id))}"][data-provider-id="${CSS.escape(String(p.provider_id))}"]`);
        if (providerEl) tasks.push(this._loadProviderModels(team, p, providerEl));
      }
    }
    if (tasks.length) await Promise.all(tasks);
  }

  // 对单个供应商下的模型应用搜索/系列/测试状态/排序筛选（与 filterAndRenderModelLibrary 同口径）
  _filterProviderModels(provider) {
    const search = this.librarySearch.toLowerCase();
    const series = this.librarySeriesFilter;
    const testFilter = this.libraryTestFilter;
    const sort = this.librarySort;
    const providerName = (provider.provider_name || '').toLowerCase();

    // 搜索若匹配供应商名称，则显示该供应商全部模型
    const providerMatch = search && providerName.includes(search);

    let list = (provider.models || []).filter(m => {
      if (testFilter !== 'all') {
        if (testFilter === 'pass' && m.test_ok !== true) return false;
        if (testFilter === 'fail' && m.test_ok !== false) return false;
        if (testFilter === 'untested' && (m.test_ok === true || m.test_ok === false)) return false;
      }
      if (series !== 'all' && m.series !== series) return false;
      if (!search || providerMatch) return true;
      return m.name.toLowerCase().includes(search) ||
        (m.description || '').toLowerCase().includes(search) ||
        (m.alias || '').toLowerCase().includes(search) ||
        (m.series || '').toLowerCase().includes(search);
    });

    if (sort !== 'default') {
      list = [...list];
      if (sort === 'price_asc')
        list.sort((a, b) => (a.input_price_per_1k_tokens || 0) - (b.input_price_per_1k_tokens || 0));
      else if (sort === 'price_desc')
        list.sort((a, b) => (b.input_price_per_1k_tokens || 0) - (a.input_price_per_1k_tokens || 0));
      else if (sort === 'name_asc')
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      else if (sort === 'name_desc')
        list.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
      else if (sort === 'test_latency_asc')
        this._sortTestModels(list, 'latency', 'asc');
      else if (sort === 'test_latency_desc')
        this._sortTestModels(list, 'latency', 'desc');
      else if (sort === 'test_tps_desc')
        this._sortTestModels(list, 'tps');
    }
    return list;
  }

  // ==================== 展开/折叠全部 ====================

  toggleExpandDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('expandDropdownMenu');
    if (!menu) return;
    const isVisible = menu.style.display === 'block';
    menu.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      // 点击其他地方关闭
      const close = (e) => {
        const dropdown = document.getElementById('expandDropdown');
        if (dropdown && !dropdown.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  expandAllTeams() {
    document.querySelectorAll('.model-library-team').forEach(el => el.classList.remove('collapsed'));
    this.closeLibraryMoreDropdown();
  }

  collapseAllTeams() {
    document.querySelectorAll('.model-library-team').forEach(el => el.classList.add('collapsed'));
    this.closeLibraryMoreDropdown();
  }

  async expandAllProviders() {
    this.closeLibraryMoreDropdown();
    // 展开全部供应商，并按需加载未加载明细的供应商
    const tasks = [];
    document.querySelectorAll('.model-library-provider').forEach(el => {
      el.classList.remove('collapsed');
      if (el.classList.contains('provider-disabled')) return;
      const teamId = el.getAttribute('data-team-id');
      const providerId = el.getAttribute('data-provider-id');
      const team = (this._libraryData?.teams || []).find(t => String(t.team_id) === String(teamId));
      const provider = team?.providers?.find(p => String(p.provider_id) === String(providerId));
      if (provider && !provider.models_loaded) {
        tasks.push(this._loadProviderModels(team, provider, el));
      }
    });
    if (tasks.length) await Promise.all(tasks);
  }

  collapseAllProviders() {
    document.querySelectorAll('.model-library-provider').forEach(el => el.classList.add('collapsed'));
    this.closeLibraryMoreDropdown();
  }

  // ===== 模型库 Key 选择器 =====

  async _loadLibraryKeys() {
    const prevSelected = this._librarySelectedKeyId;
    this._libraryKeys = [];
    try {
      const res = await fetch('/api/user/api-keys');
      if (!res.ok) {
        this._librarySelectedKeyId = null;
        this._renderLibraryKeySelector();
        this._updateLibraryBindingBar();
        return;
      }
      const keys = await res.json();
      if (!Array.isArray(keys) || keys.length === 0) {
        this._librarySelectedKeyId = null;
        this._renderLibraryKeySelector();
        this._updateLibraryBindingBar();
        return;
      }
      this._libraryKeys = keys;

      // 优先保留用户已选 Key；否则选绑定了当前模型的 Key；否则选第一个
      const prevStillValid = prevSelected && keys.some(k => k.id === prevSelected);
      if (prevStillValid) {
        this._librarySelectedKeyId = prevSelected;
      } else if (this._libraryCurrentModel) {
        const activeKey = keys.find(k => String(k.current_model_id) === String(this._libraryCurrentModel.id));
        this._librarySelectedKeyId = activeKey ? activeKey.id : keys[0].id;
      } else {
        this._librarySelectedKeyId = keys[0].id;
      }

      this._renderLibraryKeySelector();
      this._updateLibraryBindingBar();
    } catch (e) {
      console.warn(t('[模型库] 加载 API Keys 失败:'), e);
      this._updateLibraryBindingBar();
    }
  }

  _getSelectedLibraryKey() {
    if (!this._librarySelectedKeyId) return null;
    return (this._libraryKeys || []).find(k => k.id === this._librarySelectedKeyId) || null;
  }

  _updateLibraryBindingBar() {
    const summary = document.getElementById('modelLibraryBindingSummary');
    if (!summary) return;

    const keys = this._libraryKeys || [];
    if (!keys.length) {
      setHTML(summary, `
        <div class="binding-empty">
          <span>还没有 API Key，创建后才能绑定模型</span>
          <button class="btn btn-primary btn-sm" onclick="app.navigateTo('apiKeys')">去创建 API Key</button>
        </div>`);
      this._renderLibraryStickyKeyBtn();
      return;
    }

    const key = this._getSelectedLibraryKey() || keys[0];
    const keyName = escapeHtml(key.name || 'API Key');
    const bindTarget = this._libraryBindTarget || 'default';
    const isHarnessMode = bindTarget !== 'default';
    const harnessMeta = isHarnessMode ? this._usageRequestSourceMeta(bindTarget) : null;
    const harnessBinding = isHarnessMode ? this._getKeyHarnessBinding(key, bindTarget) : null;

    // Harness 绑定模式：引导用户点选模型
    if (isHarnessMode) {
      const boundName = harnessBinding?.name || '';
      const iconHtml = this._harnessIconHtml(bindTarget, 16);
      setHTML(summary, `
        <div class="binding-active binding-harness-mode">
          <div class="binding-mode-banner">
            ${iconHtml}
            <span>正在为 <strong>${escapeHtml(harnessMeta.label)}</strong> 选择模型</span>
            <button type="button" class="btn btn-sm btn-secondary binding-mode-exit" onclick="app.exitLibraryHarnessBindMode()">退出</button>
          </div>
          <div class="binding-key-row">
            <span class="binding-key-name">${keyName}</span>
            <span class="binding-arrow">→</span>
            <span class="binding-harness-tag" style="color:${harnessMeta.color};border-color:${harnessMeta.color};">
              ${this._harnessIconHtml(bindTarget, 12)}
              ${escapeHtml(harnessMeta.label)}
            </span>
            <span class="binding-arrow">→</span>
            ${boundName
              ? `<span class="binding-model-name">${escapeHtml(boundName)}</span>`
              : `<span class="binding-model-unset">${t('跟随默认 · 点击下方模型单独绑定')}</span>`}
          </div>
          <div class="binding-hint">点击列表中的模型，仅影响 ${escapeHtml(harnessMeta.label)}；其它工具仍用默认绑定</div>
        </div>`);
      this._renderLibraryStickyKeyBtn();
      return;
    }

    const currentMatchesKey = this._libraryCurrentModel
      && String(this._libraryCurrentModel.id) === String(key.current_model_id || this._libraryCurrentModel.id);
    const modelName = key.current_model_name
      || (currentMatchesKey ? this._libraryCurrentModel.name : '')
      || '';

    const harnessList = Array.isArray(key.harness_models) ? key.harness_models : [];
    const harnessChips = harnessList.length
      ? `<div class="binding-harness-chips">${harnessList.map(h => {
          const meta = this._usageRequestSourceMeta(h.harness);
          return `<button type="button" class="binding-harness-chip" style="--h-color:${meta.color};"
            title="${escapeHtml(meta.label)} → ${escapeHtml(h.name || h.model_id || '')}"
            onclick="event.stopPropagation();app.enterLibraryHarnessBindMode('${escapeHtml(h.harness)}')">
            ${this._harnessIconHtml(h.harness, 12)}
            <span class="binding-harness-chip-label">${escapeHtml(meta.label)}</span>
            <span class="binding-harness-chip-model">${escapeHtml(h.name || h.model_id || '')}</span>
          </button>`;
        }).join('')}</div>`
      : '';

    // 无绑定模型时显示简洁提示
    if (!modelName) {
      setHTML(summary, `
        <div class="binding-active">
          <div class="binding-key-row">
            <button type="button" class="binding-key-name binding-key-trigger"
              data-key-id="${key.id}"
              onclick="app.selectLibraryKey(${key.id}, event)"
              title="${t('再次点击打开菜单')}">${keyName}</button>
            <span class="binding-arrow">→</span>
            <span class="binding-model-unset">尚未绑定模型</span>
          </div>
          ${harnessChips}
          <div class="binding-hint">在下方列表中点击一个模型即可绑定 · 再次点击 Key 可打开工具菜单</div>
        </div>`);
      this._renderLibraryStickyKeyBtn();
      return;
    }

    const providerName = key.current_model_provider_name
      || (currentMatchesKey ? (this._libraryCurrentModel.provider_name || '') : '')
      || '';
    const testCapsule = this._renderTestCapsule(key);
    const modelId = key.current_model_id || '';
    const uptimeHtml = modelId
      ? `<div class="binding-uptime">${this._renderModelUptimeSlot(String(modelId), modelName)}</div>`
      : '';

    setHTML(summary, `
      <div class="binding-active">
        <div class="binding-key-row">
          <button type="button" class="binding-key-name binding-key-trigger"
            data-key-id="${key.id}"
            onclick="app.selectLibraryKey(${key.id}, event)"
            title="${t('再次点击打开菜单')}">${keyName}</button>
          <span class="binding-arrow">→</span>
          ${providerName ? `<span class="binding-provider-name">${escapeHtml(providerName)}</span><span class="binding-arrow">→</span>` : ''}
          <span class="binding-model-name">${escapeHtml(modelName)}</span>
          ${testCapsule}
        </div>
        ${uptimeHtml}
        ${harnessChips}
        <div class="binding-hint">默认请求路由到此模型 · 再次点击 Key 可为 Claude Code / Codex 等单独绑定</div>
      </div>`);

    if (modelId) {
      this._loadModelUptimeForIds([String(modelId)]);
    }
    this._renderLibraryStickyKeyBtn();
  }

  _renderLibraryKeySelector() {
    const container = document.getElementById('modelLibraryKeySelector');
    const chipsContainer = document.getElementById('libraryKeyChips');
    if (!container || !chipsContainer) return;

    if (this._libraryKeys.length === 0) {
      container.style.display = 'none';
      this._renderLibraryStickyKeyBtn();
      return;
    }

    // 仅一个 Key 时仍展示芯片，以便二次点击打开气泡菜单
    container.style.display = 'block';

    // Key 过多时折叠：默认只显示前 5 个，第 6 个位置为「展开全部」按钮；≤7 个则全量展示
    const KEY_COLLAPSE_THRESHOLD = 7;
    const KEY_VISIBLE_COUNT = 5;
    const keys = this._libraryKeys;
    const collapsed = keys.length > KEY_COLLAPSE_THRESHOLD && !this._libraryKeysExpanded;

    const renderChip = (key) => {
      const isActive = key.id === this._librarySelectedKeyId;
      const name = key.name || 'API Key';
      const modelName = key.current_model_name || '';
      const tags = key.tags || [];
      const harnessCount = Array.isArray(key.harness_models) ? key.harness_models.length : 0;
      const tip = isActive
        ? `${name}${modelName ? ' → ' + modelName : ''}${t('（再次点击打开工具菜单）')}`
        : `${name}${modelName ? ' → ' + modelName : ''}`;
      return `
        <div class="model-library-key-chip ${isActive ? 'active' : ''}"
             data-key-id="${key.id}"
             onclick="app.selectLibraryKey(${key.id}, event)"
             title="${escapeHtml(tip)}">
          <span class="key-name">${escapeHtml(name)}</span>
          ${tags.map(t => `<span class="key-tag-dot" style="background:${t.color};" title="${escapeHtml(t.name)}"></span>`).join('')}
          ${modelName ? `<span class="key-model-badge">${escapeHtml(modelName)}</span>` : ''}
          ${harnessCount ? `<span class="key-harness-count" title="${harnessCount}${t('个工具单独绑定">')}${harnessCount}</span>` : ''}
        </div>
      `;
    };

    let html = '';
    if (collapsed) {
      // 折叠时：若选中 Key 在隐藏区，自动补显该 Key，保证当前选择始终可见
      const visibleKeys = keys.slice(0, KEY_VISIBLE_COUNT);
      const selectedKey = this._getSelectedLibraryKey();
      const selectedVisible = selectedKey && visibleKeys.some(k => k.id === selectedKey.id);
      html = visibleKeys.map(renderChip).join('');
      if (selectedKey && !selectedVisible) {
        html += `<div class="model-library-key-chip-ellipsis">…</div>${renderChip(selectedKey)}`;
      }
      const hiddenCount = keys.length - KEY_VISIBLE_COUNT - (selectedKey && !selectedVisible ? 1 : 0);
      html += `
        <button type="button" class="model-library-key-chip model-library-key-expand"
                onclick="app.toggleLibraryKeysExpand()"
                title="' + t('展开余下的') + ' ${hiddenCount} ' + t('个key') + '">
          <span class="key-name">展开余下的 ${hiddenCount} 个key</span>
        </button>`;
    } else {
      html = keys.map(renderChip).join('');
      // 展开态：Key 数仍超阈值时，末尾提供「收起」
      if (keys.length > KEY_COLLAPSE_THRESHOLD) {
        html += `
          <button type="button" class="model-library-key-chip model-library-key-expand"
                  onclick="app.toggleLibraryKeysExpand()"
                  title="${t('收起')}">
            <span class="key-name">收起</span>
          </button>`;
      }
    }
    setHTML(chipsContainer, html);
    this._renderLibraryStickyKeyBtn();
  }

  toggleLibraryKeysExpand() {
    this._libraryKeysExpanded = !this._libraryKeysExpanded;
    this._renderLibraryKeySelector();
  }

  selectLibraryKey(keyId, event, options = {}) {
    event?.stopPropagation?.();
    const id = Number(keyId);
    const forceSelect = options.forceSelect === true;
    const isReselect = this._librarySelectedKeyId === id;

    // 再次点击同一 Key：切换气泡菜单（除非强制仅选中）
    if (isReselect && !forceSelect) {
      if (this._isLibraryKeyBubbleOpen()) {
        this.closeLibraryKeyBubble();
      } else {
        this._openLibraryKeyBubble(id, event?.currentTarget || event?.target);
      }
      return;
    }

    // 首次点击 / 切换 Key：选中并退出 harness 绑定模式
    this.closeLibraryKeyBubble();
    this._librarySelectedKeyId = id;
    this._libraryBindTarget = 'default';
    this._renderLibraryKeySelector();
    this._updateLibraryBindingBar();
    this.closeLibraryStickyKeyMenu();

    // 同步高亮：用该 Key 默认绑定的模型作为「当前模型」展示
    const key = this._getSelectedLibraryKey();
    if (key?.current_model_id) {
      this._libraryCurrentModel = {
        id: key.current_model_id,
        name: key.current_model_name || key.current_model_id,
        provider_name: key.current_model_provider_name || ''
      };
      this._refreshExpandedProviderLists();
    } else {
      this._libraryCurrentModel = null;
      this._refreshExpandedProviderLists();
    }
  }

  _ensureLibraryKeyBubbleEl() {
    let menu = document.getElementById('libraryKeyBubbleMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'libraryKeyBubbleMenu';
    menu.className = 'library-key-bubble-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-hidden', 'true');
    menu.hidden = true;
    menu.style.position = 'fixed';
    menu.style.zIndex = '1200';
    document.body.appendChild(menu);
    return menu;
  }

  _isLibraryKeyBubbleOpen() {
    const menu = document.getElementById('libraryKeyBubbleMenu');
    return !!(menu && menu.classList.contains('is-open') && !menu.classList.contains('is-closing'));
  }

  _openLibraryKeyBubble(keyId, anchorEl) {
    const key = (this._libraryKeys || []).find(k => k.id === keyId);
    if (!key) return;

    // 取消进行中的关闭动画
    if (this._libraryKeyBubbleCloseTimer) {
      clearTimeout(this._libraryKeyBubbleCloseTimer);
      this._libraryKeyBubbleCloseTimer = null;
    }

    const menu = this._ensureLibraryKeyBubbleEl();
    const defaultModel = key.current_model_name || t('未绑定');
    const harnessItems = this._libraryHarnessList().map(h => {
      const bound = this._getKeyHarnessBinding(key, h.id);
      const modelText = bound?.name || t('跟随默认');
      const hasOverride = !!bound;
      return `
        <button type="button" class="library-key-bubble-item" role="menuitem"
                onclick="app.onLibraryKeyBubbleHarness('${h.id}')">
          <span class="library-key-bubble-item-main">
            ${this._harnessIconHtml(h.id, 14)}
            <span>${escapeHtml(h.label)}</span>
          </span>
          <span class="library-key-bubble-item-meta ${hasOverride ? 'is-override' : ''}">${escapeHtml(modelText)}</span>
        </button>`;
    }).join('');

    setHTML(menu, `
      <button type="button" class="library-key-bubble-item" role="menuitem"
              onclick="app.onLibraryKeyBubbleLocate()">
        <span class="library-key-bubble-item-main">跳转到绑定模型</span>
        <span class="library-key-bubble-item-meta">${escapeHtml(defaultModel)}</span>
      </button>
      <div class="expand-dropdown-divider"></div>
      <button type="button" class="library-key-bubble-item ${this._libraryBindTarget === 'default' ? 'active' : ''}" role="menuitem"
              onclick="app.onLibraryKeyBubbleDefault()">
        <span class="library-key-bubble-item-main">默认绑定</span>
        <span class="library-key-bubble-item-meta">${escapeHtml(defaultModel)}</span>
      </button>
      <div class="library-key-bubble-section-label">按工具绑定</div>
      ${harnessItems}
      <div class="expand-dropdown-divider"></div>
      <button type="button" class="library-key-bubble-item" role="menuitem"
              onclick="app.onLibraryKeyBubbleExportConfig()">
        <span class="library-key-bubble-item-main">导出客户端配置</span>
      </button>
    `);

    const anchor = anchorEl?.closest?.('.model-library-key-chip, .binding-key-trigger, .model-library-sticky-key-btn')
      || anchorEl
      || document.querySelector(`.model-library-key-chip[data-key-id="${keyId}"]`)
      || document.querySelector('.binding-key-trigger');

    // 先以收起态显示，测量尺寸后再定位并播放打开动画
    menu.hidden = false;
    menu.classList.remove('is-open', 'is-closing', 'origin-top-right');
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';

    const rect = anchor?.getBoundingClientRect?.();
    const menuW = Math.max(menu.offsetWidth || 200, 200);
    const menuH = Math.max(menu.offsetHeight || 200, 120);
    let left = 16;
    let top = 80;
    let originRight = false;
    if (rect) {
      left = rect.left;
      top = rect.bottom + 4;
      if (left + menuW > window.innerWidth - 8) {
        left = Math.max(8, rect.right - menuW);
        originRight = true;
      }
      if (top + menuH > window.innerHeight - 8) {
        top = Math.max(8, rect.top - 4 - menuH);
      }
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.classList.toggle('origin-top-right', originRight);
    menu.style.visibility = '';
    menu.setAttribute('aria-hidden', 'false');

    // 强制 reflow，确保从收起态过渡到打开态
    void menu.offsetWidth;
    menu.classList.add('is-open');

    if (this._libraryKeyBubbleCloser) {
      document.removeEventListener('click', this._libraryKeyBubbleCloser);
      this._libraryKeyBubbleCloser = null;
    }
    const closer = (e) => {
      if (menu.contains(e.target)) return;
      if (anchor && anchor.contains?.(e.target)) return;
      this.closeLibraryKeyBubble();
    };
    this._libraryKeyBubbleCloser = closer;
    setTimeout(() => document.addEventListener('click', closer), 0);
  }

  closeLibraryKeyBubble() {
    const menu = document.getElementById('libraryKeyBubbleMenu');
    if (this._libraryKeyBubbleCloser) {
      document.removeEventListener('click', this._libraryKeyBubbleCloser);
      this._libraryKeyBubbleCloser = null;
    }
    if (!menu || menu.hidden) return;

    // 已在关闭中则不重复
    if (menu.classList.contains('is-closing')) return;

    menu.classList.remove('is-open');
    menu.classList.add('is-closing');
    menu.setAttribute('aria-hidden', 'true');

    if (this._libraryKeyBubbleCloseTimer) {
      clearTimeout(this._libraryKeyBubbleCloseTimer);
    }
    this._libraryKeyBubbleCloseTimer = setTimeout(() => {
      this._libraryKeyBubbleCloseTimer = null;
      menu.classList.remove('is-closing', 'is-open', 'origin-top-right');
      menu.hidden = true;
    }, 160);
  }

  onLibraryKeyBubbleLocate() {
    this.closeLibraryKeyBubble();
    const keyId = this._librarySelectedKeyId;
    if (keyId) this._expandProviderForSelectedKey(keyId);
  }

  onLibraryKeyBubbleDefault() {
    this.closeLibraryKeyBubble();
    this._libraryBindTarget = 'default';
    this._updateLibraryBindingBar();
    this.showToast(t('已切换为默认绑定：点击模型将绑定到全部工具'), 'info');
  }

  onLibraryKeyBubbleHarness(harnessId) {
    this.closeLibraryKeyBubble();
    this.enterLibraryHarnessBindMode(harnessId);
  }

  onLibraryKeyBubbleExportConfig() {
    this.closeLibraryKeyBubble();
    const keyId = this._librarySelectedKeyId;
    if (keyId) this.generateClaudeConfig(keyId);
  }

  enterLibraryHarnessBindMode(harnessId) {
    if (!harnessId || harnessId === 'default') {
      this._libraryBindTarget = 'default';
    } else {
      this._libraryBindTarget = harnessId;
    }
    this._updateLibraryBindingBar();
    const label = this._harnessLabel(this._libraryBindTarget);
    if (this._libraryBindTarget !== 'default') {
      this.showToast(`${t('请选择模型，将单独绑定到')}${label}`, 'info');
    }
  }

  exitLibraryHarnessBindMode() {
    this._libraryBindTarget = 'default';
    this._updateLibraryBindingBar();
  }

  async clearLibraryHarnessBinding(harnessId) {
    const keyId = this._librarySelectedKeyId;
    if (!keyId || !harnessId) return;
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/harness-models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: harnessId, modelId: null })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.error || t('清除失败'), 'error');
        return;
      }
      const keyObj = this._libraryKeys.find(k => k.id === keyId);
      if (keyObj && Array.isArray(keyObj.harness_models)) {
        keyObj.harness_models = keyObj.harness_models.filter(h => h.harness !== harnessId);
      }
      this.showToast(`${t('已清除')}${this._harnessLabel(harnessId)}${t('的单独绑定，将跟随默认')}`, 'success');
      this._renderLibraryKeySelector();
      this._updateLibraryBindingBar();
    } catch (e) {
      this.showToast(t('清除失败'), 'error');
    }
  }

  // ===== 模型库悬浮顶栏 =====

  _onLibrarySearchInput(value, source) {
    this.librarySearch = value;
    const mainInput = document.getElementById('librarySearchInput');
    const stickyInput = document.getElementById('libraryStickySearchInput');
    if (source !== 'main' && mainInput && mainInput.value !== value) mainInput.value = value;
    if (source !== 'sticky' && stickyInput && stickyInput.value !== value) stickyInput.value = value;
    if (this._libraryGlobalSearchTimer) clearTimeout(this._libraryGlobalSearchTimer);
    this._libraryGlobalSearchTimer = setTimeout(() => this.filterAndRenderModelLibrary(), 280);
  }

  _onLibraryProviderFilterChange(value, source) {
    this.libraryProviderFilter = value;
    const mainSelect = document.getElementById('libraryProviderFilter');
    const stickySelect = document.getElementById('libraryStickyProviderFilter');
    if (source !== 'main' && mainSelect && mainSelect.value !== value) mainSelect.value = value;
    if (source !== 'sticky' && stickySelect && stickySelect.value !== value) stickySelect.value = value;
    this.filterAndRenderModelLibrary();
  }

  _syncPairedSelects(mainId, stickyId, value, source) {
    const mainSelect = document.getElementById(mainId);
    const stickySelect = document.getElementById(stickyId);
    if (source !== 'main' && mainSelect && mainSelect.value !== value) mainSelect.value = value;
    if (source !== 'sticky' && stickySelect && stickySelect.value !== value) stickySelect.value = value;
  }

  _onLibrarySeriesFilterChange(value, source) {
    this.librarySeriesFilter = value;
    this._syncPairedSelects('librarySeriesFilter', 'libraryStickySeriesFilter', value, source);
    this._updateLibraryMoreFiltersButtons();
    this.filterAndRenderModelLibrary();
  }

  _onLibraryTestFilterChange(value, source) {
    this.libraryTestFilter = value;
    this._syncPairedSelects('libraryTestFilter', 'libraryStickyTestFilter', value, source);
    this._updateLibraryMoreFiltersButtons();
    this.filterAndRenderModelLibrary();
  }

  _onLibraryProviderTagFilterChange(value, source) {
    this.libraryProviderTagFilter = value;
    this._syncPairedSelects('libraryProviderTagFilter', 'libraryStickyProviderTagFilter', value, source);
    this._updateLibraryMoreFiltersButtons();
    this.filterAndRenderModelLibrary();
  }

  _onLibrarySortChange(value, source) {
    this.librarySort = value;
    this._syncPairedSelects('librarySort', 'libraryStickySort', value, source);
    if (this.librarySort !== 'default' && this.libraryReorderMode) {
      this.libraryReorderMode = false;
      this._updateLibraryReorderButtons();
    }
    this._updateLibraryMoreFiltersButtons();
    this.filterAndRenderModelLibrary();
  }

  _initLibraryStickyBar() {
    const sentinel = document.getElementById('modelLibraryStickySentinel');
    if (!sentinel) return;

    if (!this._libraryStickyEventsBound) {
      this._libraryStickyEventsBound = true;
      document.getElementById('libraryStickySearchInput')?.addEventListener('input', (e) => {
        this._onLibrarySearchInput(e.target.value, 'sticky');
      });
      document.getElementById('libraryStickyProviderFilter')?.addEventListener('change', (e) => {
        this._onLibraryProviderFilterChange(e.target.value, 'sticky');
      });
      document.getElementById('libraryStickySeriesFilter')?.addEventListener('change', (e) => {
        this._onLibrarySeriesFilterChange(e.target.value, 'sticky');
      });
      document.getElementById('libraryStickyTestFilter')?.addEventListener('change', (e) => {
        this._onLibraryTestFilterChange(e.target.value, 'sticky');
      });
      document.getElementById('libraryStickyProviderTagFilter')?.addEventListener('change', (e) => {
        this._onLibraryProviderTagFilterChange(e.target.value, 'sticky');
      });
      document.getElementById('libraryStickySort')?.addEventListener('change', (e) => {
        this._onLibrarySortChange(e.target.value, 'sticky');
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.closeLibraryStickyKeyMenu();
          this.closeLibraryKeyBubble();
        }
      });
    }

    if (this._libraryStickyObserver) {
      this._libraryStickyObserver.disconnect();
      this._libraryStickyObserver = null;
    }

    this._libraryStickyObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // 仅当筛选哨兵滚过视口顶部才显示（下方未进入视口时不显示）
      const show = this._isStickySentinelPastTop(entry) && this.currentPage === 'modelLibrary';
      this._syncLibraryStickyVisibility(show);
    }, { root: null, threshold: [0, 0.01, 1], rootMargin: '0px' });

    this._libraryStickyObserver.observe(sentinel);
    // 初始化时根据当前滚动位置同步一次
    this._syncLibraryStickyVisibility(
      this._isStickySentinelPastTop(sentinel) && this.currentPage === 'modelLibrary'
    );
    this._renderLibraryStickyKeyBtn();
  }

  _syncLibraryStickyVisibility(visible) {
    const bar = document.getElementById('modelLibraryStickyBar');
    if (!bar) return;
    const shouldShow = !!visible && this.currentPage === 'modelLibrary';
    const wasVisible = bar.classList.contains('is-visible');
    if (shouldShow === wasVisible) return;
    bar.classList.toggle('is-visible', shouldShow);
    bar.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    if (!shouldShow) this.closeLibraryStickyKeyMenu();
  }

  _syncLibraryStickyControlsFromState() {
    const stickySearch = document.getElementById('libraryStickySearchInput');
    const mainSearch = document.getElementById('librarySearchInput');
    const value = this.librarySearch || '';
    if (stickySearch && stickySearch.value !== value) stickySearch.value = value;
    if (mainSearch && mainSearch.value !== value) mainSearch.value = value;

    const pairs = [
      ['libraryProviderFilter', 'libraryStickyProviderFilter', this.libraryProviderFilter || 'all'],
      ['librarySeriesFilter', 'libraryStickySeriesFilter', this.librarySeriesFilter || 'all'],
      ['libraryProviderTagFilter', 'libraryStickyProviderTagFilter', this.libraryProviderTagFilter || 'all'],
      ['libraryTestFilter', 'libraryStickyTestFilter', this.libraryTestFilter || 'all'],
      ['librarySort', 'libraryStickySort', this.librarySort || 'default'],
    ];
    for (const [mainId, stickyId, val] of pairs) {
      const mainEl = document.getElementById(mainId);
      const stickyEl = document.getElementById(stickyId);
      if (mainEl) mainEl.value = val;
      if (stickyEl) stickyEl.value = val;
    }

    // 保持「更多筛选」展开态与按钮高亮一致
    const mainOpen = document.getElementById('libraryAdvancedFilters')?.style.display !== 'none';
    if (mainOpen) this._setLibraryMoreFiltersOpen(true);
    else this._updateLibraryMoreFiltersButtons();

    this._renderLibraryStickyKeyBtn();
  }

  _renderLibraryStickyKeyBtn() {
    const wrap = document.getElementById('libraryStickyKeyWrap');
    const btn = document.getElementById('libraryStickyKeyBtn');
    if (!wrap || !btn) return;

    const keys = this._libraryKeys || [];
    if (!keys.length) {
      wrap.style.display = 'none';
      this.closeLibraryStickyKeyMenu();
      return;
    }

    wrap.style.display = '';
    const key = this._getSelectedLibraryKey() || keys[0];
    const keyName = escapeHtml(key.name || 'API Key');
    const bindTarget = this._libraryBindTarget || 'default';
    const harnessBinding = bindTarget !== 'default' ? this._getKeyHarnessBinding(key, bindTarget) : null;
    const modelName = bindTarget !== 'default'
      ? (harnessBinding?.name || t('跟随默认'))
      : (key.current_model_name
        || (this._libraryCurrentModel && String(this._libraryCurrentModel.id) === String(key.current_model_id)
          ? this._libraryCurrentModel.name
          : '')
        || '');
    // 始终可点：打开 Key 工具气泡（含切换/定位/harness）
    const tip = bindTarget !== 'default'
      ? `${key.name || 'API Key'} · ${this._harnessLabel(bindTarget)}${modelName ? ' → ' + modelName : ''}${t('（点击打开菜单）')}`
      : `${key.name || 'API Key'}${modelName ? ' → ' + modelName : ''}${t('（点击打开菜单）')}`;

    btn.disabled = false;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.title = tip;
    btn.onclick = (e) => this.toggleLibraryStickyKeyOrBubble(e);
    setHTML(btn, `
      <span class="sticky-key-name">${keyName}</span>
      ${bindTarget !== 'default'
        ? `<span class="sticky-key-harness-capsule">${this._harnessIconHtml(bindTarget, 12)} ${escapeHtml(this._harnessLabel(bindTarget))}</span>`
        : ''}
      ${modelName
        ? `<span class="sticky-key-model-capsule">${escapeHtml(modelName)}</span>`
        : `<span class="sticky-key-model-unset">${t('未绑定')}</span>`}
      <svg class="sticky-key-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    `);
  }

  toggleLibraryStickyKeyOrBubble(event) {
    event?.stopPropagation();
    event?.preventDefault();
    // 多 Key 时仍可用原切换菜单；优先打开工具气泡（含 harness）
    const keyId = this._librarySelectedKeyId || this._libraryKeys?.[0]?.id;
    if (!keyId) return;
    this.closeLibraryStickyKeyMenu();
    this._openLibraryKeyBubble(keyId, event?.currentTarget || document.getElementById('libraryStickyKeyBtn'));
  }

  _renderLibraryStickyKeyMenu() {
    const menu = document.getElementById('libraryStickyKeyMenu');
    if (!menu) return;
    const keys = this._libraryKeys || [];
    const otherKeys = keys.filter(k => k.id !== this._librarySelectedKeyId);

    if (!otherKeys.length) {
      setHTML(menu, `<div class="expand-dropdown-item" style="cursor:default;opacity:0.7;">${t('没有其他 Key')}</div>`);
      return;
    }

    setHTML(menu, otherKeys.map(key => {
      const name = key.name || 'API Key';
      const modelName = key.current_model_name || '';
      const tags = key.tags || [];
      return `
        <div class="expand-dropdown-item" role="menuitem"
             data-key-id="${key.id}"
             onclick="app.selectLibraryKeyFromSticky(${key.id})"
             title="${escapeHtml(name)}${modelName ? ' → ' + escapeHtml(modelName) : ''}">
          <span class="sticky-menu-key-name">${escapeHtml(name)}</span>
          ${tags.map(t => `<span class="key-tag-dot" style="background:${t.color};" title="${escapeHtml(t.name)}"></span>`).join('')}
          ${modelName ? `<span class="sticky-menu-model-capsule">${escapeHtml(modelName)}</span>` : ''}
        </div>
      `;
    }).join(''));
  }

  toggleLibraryStickyKeyMenu(event) {
    event?.stopPropagation();
    event?.preventDefault();
    const menu = document.getElementById('libraryStickyKeyMenu');
    const wrap = document.getElementById('libraryStickyKeyWrap');
    const btn = document.getElementById('libraryStickyKeyBtn');
    if (!menu || !wrap || !btn || btn.disabled) return;

    const isOpen = menu.style.display === 'block';
    if (isOpen) {
      this.closeLibraryStickyKeyMenu();
      return;
    }

    this._renderLibraryStickyKeyMenu();
    menu.style.display = 'block';
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');

    if (this._libraryStickyKeyMenuCloser) {
      document.removeEventListener('click', this._libraryStickyKeyMenuCloser);
      this._libraryStickyKeyMenuCloser = null;
    }
    const closer = (e) => {
      if (wrap.contains(e.target)) return;
      this.closeLibraryStickyKeyMenu();
    };
    this._libraryStickyKeyMenuCloser = closer;
    setTimeout(() => document.addEventListener('click', closer), 0);
  }

  closeLibraryStickyKeyMenu() {
    const menu = document.getElementById('libraryStickyKeyMenu');
    const wrap = document.getElementById('libraryStickyKeyWrap');
    const btn = document.getElementById('libraryStickyKeyBtn');
    if (menu) menu.style.display = 'none';
    if (wrap) wrap.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (this._libraryStickyKeyMenuCloser) {
      document.removeEventListener('click', this._libraryStickyKeyMenuCloser);
      this._libraryStickyKeyMenuCloser = null;
    }
  }

  selectLibraryKeyFromSticky(keyId) {
    this.closeLibraryStickyKeyMenu();
    this.closeLibraryKeyBubble();
    // 从 sticky 切换菜单选 Key：只选中，不立刻弹气泡
    this.selectLibraryKey(keyId, null, { forceSelect: true });
  }

  async _expandProviderForSelectedKey(keyId) {
    const key = this._libraryKeys.find(k => k.id === keyId);
    if (!key || !key.current_model_id || !this._libraryData?.teams) return;
    if (this._libraryLocatingModel) return;

    const modelId = key.current_model_id;
    this._libraryLocatingModel = true;
    try {
      // 1) 已加载明细的供应商：直接定位，绝不批量加载
      for (const team of this._libraryData.teams) {
        for (const provider of team.providers || []) {
          if (!provider.models_loaded) continue;
          const found = (provider.models || []).find(m => String(m.model_id || m.id) === String(modelId));
          if (found) {
            await this._revealModelInProvider(team, provider, modelId);
            return;
          }
        }
      }

      // 2) 通过模型信息拿到 provider_id，只展开对应的那一个供应商
      let providerId = null;
      try {
        const res = await fetch(`/api/user/models/${encodeURIComponent(modelId)}/info`);
        if (res.ok) {
          const info = await res.json();
          providerId = info.provider_id || info.provider || null;
        }
      } catch (_) { /* ignore */ }

      if (!providerId) {
        this.showToast(t('无法定位该 Key 绑定的模型'), 'error');
        return;
      }

      // 优先个人 Team / 默认 Team，再找第一个包含该供应商的 Team
      const candidates = [];
      for (const team of this._libraryData.teams) {
        const provider = (team.providers || []).find(p => String(p.provider_id) === String(providerId));
        if (provider) candidates.push({ team, provider });
      }
      if (!candidates.length) {
        this.showToast(t('绑定模型所在供应商当前不可见（可能已隐藏）'), 'info');
        return;
      }
      candidates.sort((a, b) => {
        const score = (t) => (t.is_personal ? 2 : 0) + (t.is_default ? 1 : 0);
        return score(b.team) - score(a.team);
      });

      const { team, provider } = candidates[0];
      await this._revealModelInProvider(team, provider, modelId);
    } finally {
      this._libraryLocatingModel = false;
    }
  }

  /** 仅展开指定 Team/供应商并滚动到模型，不触碰其他供应商 */
  async _revealModelInProvider(team, provider, modelId) {
    const teamId = team.team_id;
    const providerId = provider.provider_id;
    const selector = `.model-library-provider[data-team-id="${CSS.escape(String(teamId))}"][data-provider-id="${CSS.escape(String(providerId))}"]`;

    let providerEl = document.querySelector(selector);
    if (!providerEl) return;

    // 展开所属 Team
    const teamEl = providerEl.closest('.model-library-team');
    if (teamEl) teamEl.classList.remove('collapsed');

    providerEl.classList.remove('collapsed');

    // 按需加载该供应商（仅此一个）
    if (!provider.models_loaded || provider.models_query_key !== this._getProviderModelsQueryKey(team, provider)) {
      await this._loadProviderModels(team, provider, providerEl, { page: 1, force: true });
      providerEl = document.querySelector(selector) || providerEl;
      providerEl.classList.remove('collapsed');
    }

    // 当前页找不到时，用模型名搜索该供应商分页
    let found = (provider.models || []).find(m => String(m.model_id || m.id) === String(modelId));
    if (!found) {
      const prevSearch = this.librarySearch;
      // 临时带 search 拉该供应商（不影响全局搜索模式：直接用 provider models API）
      try {
        const params = new URLSearchParams({
          page: '1',
          limit: String(this._libraryProviderPageSize || 50),
          search: String(modelId)
        });
        const res = await fetch(
          `/api/user/team/${encodeURIComponent(teamId)}/provider/${encodeURIComponent(providerId)}/models?${params}`
        );
        if (res.ok) {
          const data = await res.json();
          const hit = (data.models || []).find(m => String(m.model_id || m.id) === String(modelId));
          if (hit) {
            // 合并进当前列表以便渲染
            provider.models = data.models || [];
            provider.models_loaded = true;
            provider.models_page = data.pagination?.page || 1;
            provider.pagination = data.pagination;
            provider.models_query_key = null; // 标记为定位临时结果，避免污染默认缓存键
            this._renderProviderModelsInto(providerEl, provider, team);
            found = hit;
          }
        }
      } catch (_) { /* ignore */ }
      this.librarySearch = prevSearch;
    } else {
      this._renderProviderModelsInto(providerEl, provider, team);
    }

    // 滚动到模型
    requestAnimationFrame(() => {
      setTimeout(() => {
        const modelEl = document.querySelector(
          `.model-library-provider[data-team-id="${CSS.escape(String(teamId))}"][data-provider-id="${CSS.escape(String(providerId))}"] .model-library-item[data-model-id="${CSS.escape(String(modelId))}"]`
        ) || document.querySelector(`.model-library-item[data-model-id="${CSS.escape(String(modelId))}"]`);
        if (modelEl) modelEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    });
  }

  async selectModel(modelId) {
    // 确保有可用 Key；优先使用顶部当前 Key，避免二次弹窗
    if (!this._libraryKeys?.length) {
      await this._loadLibraryKeys();
    }

    if (!this._libraryKeys?.length) {
      this.showToast(t('请先创建 API Key'), 'error');
      this.navigateTo('apiKeys');
      return;
    }

    let keyId = this._librarySelectedKeyId;
    if (!keyId || !this._libraryKeys.some(k => k.id === keyId)) {
      keyId = this._libraryKeys[0].id;
      this._librarySelectedKeyId = keyId;
      this._renderLibraryKeySelector();
      this._updateLibraryBindingBar();
    }

    await this.applyModelToKey(keyId, modelId);
  }

  async applyModelToKey(keyId, modelId) {
    const bindTarget = this._libraryBindTarget || 'default';
    if (bindTarget !== 'default') {
      return this.applyHarnessModelToKey(keyId, bindTarget, modelId);
    }

    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId })
      });
      if (res.ok) {
        await this._setCurrentModelLocally(modelId, { toastLabel: null });

        // 更新本地 Key 数据的当前模型/供应商，让顶部信息卡片与芯片同步更新
        const current = this._libraryCurrentModel || {};
        const modelName = current.name || '';
        const keyObj = this._libraryKeys.find(k => k.id === keyId);
        if (keyObj) {
          keyObj.current_model_name = modelName;
          keyObj.current_model_id = modelId;
          keyObj.current_model_provider_name = current.provider_name || '';
          keyObj.current_model_test_ok = current.test_ok ?? null;
          keyObj.current_model_test_latency_ms = current.test_latency_ms ?? null;
          keyObj.current_model_test_tokens_per_second = current.test_tokens_per_second ?? null;
          keyObj.current_model_test_tested_at = current.test_tested_at ?? null;
        }
        // 绑定后保持该 Key 为当前选中
        this._librarySelectedKeyId = keyId;
        this._renderLibraryKeySelector();
        this._updateLibraryBindingBar();
        this.showToast(`${t('已绑定：')}${modelName || modelId}`, 'success');
      } else {
        const err = await res.json().catch(() => ({}));
        console.error(t('[模型库] 应用模型失败:'), err);
        this.showToast(err.error || t('设置失败'), 'error');
      }
    } catch (error) {
      console.error(t('[模型库] 设置模型异常:'), error);
      this.showToast(t('设置失败'), 'error');
    }
  }

  async applyHarnessModelToKey(keyId, harnessId, modelId) {
    try {
      const res = await fetch(`/api/user/api-keys/${keyId}/harness-models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: harnessId, modelId })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(t('[模型库] Harness 绑定失败:'), err);
        this.showToast(err.error || t('设置失败'), 'error');
        return;
      }
      const data = await res.json().catch(() => ({}));
      const modelInfo = await this._resolveLibraryModelInfo(modelId);
      const keyObj = this._libraryKeys.find(k => k.id === keyId);
      if (keyObj) {
        if (!Array.isArray(keyObj.harness_models)) keyObj.harness_models = [];
        const entry = {
          harness: harnessId,
          model_id: modelId,
          name: data.name || modelInfo.name || modelId,
          provider_name: data.provider_name || modelInfo.provider_name || ''
        };
        const idx = keyObj.harness_models.findIndex(h => h.harness === harnessId);
        if (idx >= 0) keyObj.harness_models[idx] = entry;
        else keyObj.harness_models.push(entry);
      }
      this._librarySelectedKeyId = keyId;
      // 保持 harness 绑定模式，方便连续调整
      this._renderLibraryKeySelector();
      this._updateLibraryBindingBar();
      this.showToast(`${t('已为')}${this._harnessLabel(harnessId)}${t('绑定：')}${data.name || modelInfo.name || modelId}`, 'success');
    } catch (error) {
      console.error(t('[模型库] Harness 绑定异常:'), error);
      this.showToast(t('设置失败'), 'error');
    }
  }

  async _resolveLibraryModelInfo(modelId) {
    let selectedModel = null;
    let providerName = '';
    if (this._libraryGlobalSearchResults?.models) {
      selectedModel = this._libraryGlobalSearchResults.models.find(
        m => String(m.model_id || m.id) === String(modelId)
      );
      if (selectedModel) providerName = selectedModel.provider_name || '';
    }
    if (!selectedModel && this._libraryData) {
      for (const team of this._libraryData.teams || []) {
        for (const provider of team.providers || []) {
          selectedModel = (provider.models || []).find(m => String(m.model_id) === String(modelId));
          if (selectedModel) {
            providerName = selectedModel.provider_name || provider.provider_name || '';
            break;
          }
        }
        if (selectedModel) break;
      }
    }
    if (!selectedModel) {
      try {
        const res = await fetch(`/api/user/models/${encodeURIComponent(modelId)}/info`);
        if (res.ok) {
          selectedModel = await res.json();
          providerName = selectedModel.provider_name || '';
        }
      } catch (e) { /* ignore */ }
    } else if (!providerName) {
      providerName = selectedModel.provider_name || '';
    }
    return selectedModel
      ? {
          id: selectedModel.model_id || selectedModel.id || modelId,
          name: selectedModel.name || modelId,
          provider_name: providerName || selectedModel.provider_name || '',
          test_ok: selectedModel.test_ok ?? null,
          test_latency_ms: selectedModel.test_latency_ms ?? null,
          test_tokens_per_second: selectedModel.test_tokens_per_second ?? null,
          test_tested_at: selectedModel.test_tested_at ?? null
        }
      : { id: modelId, name: modelId, provider_name: '' };
  }

  async _setCurrentModelLocally(modelId, options = {}) {
    const info = await this._resolveLibraryModelInfo(modelId);
    this._libraryCurrentModel = info;
    this._refreshExpandedProviderLists();
    this._updateLibraryBindingBar();
    if (options.toastLabel !== null) {
      this.showToast(`${t('已绑定：')}${info.name}`, 'success');
    }
  }

  async confirmSelectKey() {
    console.log(t('[模型库] 确认选择 Key'));
    const selected = document.querySelector('input[name="selectKeyRadio"]:checked');
    console.log(t('[模型库] 选中的 Key:'), selected);
    if (!selected) { alert(t('请选择一个 API Key')); return; }

    const keyId = parseInt(selected.value);
    const modelId = this._selectingModelId;
    console.log(t('[模型库] 准备应用模型:'), { keyId, modelId });

    await this.applyModelToKey(keyId, modelId);
    this.closeModals();
  }

  // ===== 用户模型管理 =====

  async loadProviders() {
    try {
      const res = await fetch('/api/user/providers');
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      console.error(t('加载供应商列表失败:'), e);
      return [];
    }
  }

  async loadModelOptions() {
    try {
      const res = await fetch('/api/user/models');
      if (!res.ok) return;
      const models = await res.json();
      const options = models.map(m => {
        const label = m.alias || m.name || m.upstream_model_id || m.id;
        const extra = m.alias && m.alias !== m.upstream_model_id ? ` (${m.upstream_model_id})` : '';
        return `<option value="${escapeHtml(m.id)}">${escapeHtml(label)}${escapeHtml(extra)}</option>`;
      }).join('');
      setHTML(document.getElementById('modelFormThinkingModel'), '<option value="">' + t('不设置（使用自身）') + '</option>' + options);
      setHTML(document.getElementById('modelFormNonThinkingModel'), '<option value="">' + t('不设置（使用自身）') + '</option>' + options);
    } catch (error) {
      console.error(t('加载模型选项失败:'), error);
    }
  }

  // 供应商管理 - 向导式添加
  async showAddProviderModal() {
    this._selectedProvider = null;
    document.getElementById('addProviderError').style.display = 'none';
    document.getElementById('providerApiKey').value = '';
    document.getElementById('providerBaseUrl').value = '';
    document.getElementById('providerFormat').value = 'openai';
    document.getElementById('providerSearchInput').value = '';

    // 显示第一步
    this.showProviderStep(1);
    this.showModal('addProviderModal');

    // 加载供应商列表
    await this.loadProvidersIndex();
  }

  async loadProvidersIndex() {
    const container = document.getElementById('providerListContainer');
    setHTML(container, pageLoadingHtml(t('加载中...'), { compact: true }));

    try {
      const res = await fetch('/api/user/providers/lookup-index');
      if (!res.ok) throw new Error(t('加载失败'));
      this._providersIndex = await res.json();
      this.renderProviderList(this._providersIndex);
    } catch (error) {
      setHTML(container, '<div style="text-align:center;padding:20px;color:var(--destructive);">' + t('加载失败，请重试') + '</div>');
    }
  }

  renderProviderList(providers) {
    const container = document.getElementById('providerListContainer');
    setHTML(container, `
      <div class="provider-list-item custom" onclick="app.selectProvider('custom')">
        <span class="provider-list-name">列表中没有我想要添加的供应商</span>
        <span class="provider-list-url">手动填写 →</span>
      </div>
      ${providers.map(p => `
        <div class="provider-list-item" onclick="app.selectProvider('${escapeHtml(p.id)}')">
          <span class="provider-list-name">${escapeHtml(p.name)}</span>
          <span class="provider-list-url">${escapeHtml(p.base_url)}</span>
        </div>
      `).join('')}
    `);
  }

  filterProviderList(keyword) {
    if (!keyword) {
      this.renderProviderList(this._providersIndex);
      return;
    }
    const kw = keyword.toLowerCase();
    const filtered = this._providersIndex.filter(p =>
      p.name.toLowerCase().includes(kw) || p.id.toLowerCase().includes(kw)
    );
    this.renderProviderList(filtered);
  }

  showProviderStep(step) {
    document.getElementById('providerStep1').style.display = step === 1 ? 'block' : 'none';
    document.getElementById('providerStep2').style.display = step === 2 ? 'block' : 'none';
    document.getElementById('addProviderError').style.display = 'none';
  }

  selectProvider(providerId) {
    this._selectedProvider = providerId;
    const displayEl = document.getElementById('selectedProviderDisplay');
    const customFields = document.getElementById('customProviderFields');

    if (providerId === 'custom') {
      displayEl.textContent = t('自定义供应商');
      customFields.style.display = 'block';
      document.getElementById('providerBaseUrl').value = '';
      document.getElementById('providerFormat').value = 'openai';
    } else {
      const provider = this._providersIndex.find(p => p.id === providerId);
      if (provider) {
        displayEl.textContent = `${provider.name} (${provider.base_url})`;
      }
      customFields.style.display = 'none';
    }

    this.showProviderStep(2);
    document.getElementById('providerApiKey').focus();
  }

  async saveProvider() {
    const errorEl = document.getElementById('addProviderError');
    errorEl.style.display = 'none';

    const providerId = this._selectedProvider;
    const apiKey = document.getElementById('providerApiKey').value.trim();

    let name, baseUrl, format;
    if (providerId === 'custom') {
      name = t('自定义供应商');
      baseUrl = document.getElementById('providerBaseUrl').value.trim();
      format = document.getElementById('providerFormat').value;
      if (!baseUrl) {
        errorEl.textContent = t('请输入 Base URL');
        errorEl.style.display = 'block';
        return;
      }
    } else {
      const provider = this._providersIndex.find(p => p.id === providerId);
      if (!provider) {
        errorEl.textContent = t('请选择供应商');
        errorEl.style.display = 'block';
        return;
      }
      name = provider.name;
      baseUrl = provider.base_url;
      // 推断格式
      format = providerId.includes('anthropic') ? 'anthropic' : 'openai';
    }

    try {
      const saveBtn = document.querySelector('#providerStep2 .btn-primary');
      setButtonLoading(saveBtn, t('添加中...'));

      const body = { name, base_url: baseUrl, format };
      if (apiKey) body.api_key = apiKey;
      const res = await fetch('/api/user/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || t('保存失败');
        errorEl.style.display = 'block';
        clearButtonLoading(saveBtn, t('添加'));
        return;
      }

      this.closeModals();
      this.showToast(`${name}${t('已添加')}`, 'success');
      await this.loadModelLibrary();
    } catch (e) {
      errorEl.textContent = t('网络错误，请重试');
      errorEl.style.display = 'block';
      const saveBtn = document.querySelector('#providerStep2 .btn-primary');
      clearButtonLoading(saveBtn, t('添加'));
    }
  }

  async showAddModelModal() {
    this._editingModelId = null;
    // 如果从"我的模型"页面调用，保存后刷新该页面
    if (this.currentPage === 'myTeamModels') {
      this._onEditModelCallback = async () => { await this.loadMyTeamModels(); };
    }
    document.getElementById('addEditModelTitle').textContent = t('添加模型');
    document.getElementById('confirmAddEditModel').textContent = t('添加');
    document.getElementById('addEditModelError').style.display = 'none';
    document.getElementById('editModelId').value = '';
    document.getElementById('modelFormId').value = '';
    document.getElementById('modelFormUpstreamId').value = '';
    document.getElementById('modelFormUpstreamId').disabled = false;
    document.getElementById('modelFormAlias').value = '';
    document.getElementById('modelFormDescription').value = '';
    document.getElementById('modelFormSeries').value = '';
    document.getElementById('modelFormInputPrice').value = '0.01';
    document.getElementById('modelFormOutputPrice').value = '0.01';
    document.getElementById('modelFormCachedPrice').value = '0';
    document.getElementById('modelFormRefInputPrice').value = '0';
    document.getElementById('modelFormRefOutputPrice').value = '0';
    document.getElementById('modelFormRateLimitRpm').value = '0';
    document.getElementById('modelFormRateLimitTpm').value = '0';
    document.getElementById('modelFormEnabled').value = 'true';

    // 加载供应商列表
    const providers = await this.loadProviders();
    const select = document.getElementById('modelFormProvider');
    setHTML(select, '<option value="">' + t('请选择供应商') + '</option>' +
      providers.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join(''));

    // 加载模型选项（用于思考模式路由）
    await this.loadModelOptions();

    this.showModal('addEditModelModal');
  }

  async showEditModelModal(modelId) {
    this._editingModelId = modelId;
    document.getElementById('addEditModelTitle').textContent = t('编辑模型');
    document.getElementById('confirmAddEditModel').textContent = t('保存');
    document.getElementById('addEditModelError').style.display = 'none';

    // 加载供应商列表
    const providers = await this.loadProviders();
    const select = document.getElementById('modelFormProvider');
    setHTML(select, '<option value="">' + t('请选择供应商') + '</option>' +
      providers.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join(''));

    // 加载模型选项（用于思考模式路由）
    await this.loadModelOptions();

    // 从模型库数据中获取模型信息（按需加载场景下，模型仅在所属供应商已展开加载时存在于内存）
    let modelData = null;
    if (this._libraryData && this._libraryData.teams) {
      for (const team of this._libraryData.teams) {
        if (!team.providers) continue;
        for (const provider of team.providers) {
          const found = (provider.models || []).find(m => m.model_id === modelId);
          if (found) {
            modelData = { ...found, provider_id: provider.provider_id };
            break;
          }
        }
        if (modelData) break;
      }
    }

    // 若模型明细尚未加载（供应商未展开），从后端单独获取该模型信息
    if (!modelData) {
      try {
        const res = await fetch(`/api/user/models/${encodeURIComponent(modelId)}/info`);
        if (res.ok) {
          modelData = await res.json();
        }
      } catch (e) { /* 忽略，下面按未找到处理 */ }
    }

    if (!modelData) {
      document.getElementById('addEditModelError').textContent = t('未找到模型信息');
      document.getElementById('addEditModelError').style.display = 'block';
      return;
    }

    document.getElementById('editModelId').value = modelId;
    document.getElementById('modelFormProvider').value = modelData.provider_id || '';
    document.getElementById('modelFormId').value = modelId;
    document.getElementById('modelFormUpstreamId').value = modelData.upstream_model_id || '';
    document.getElementById('modelFormUpstreamId').disabled = false;
    document.getElementById('modelFormAlias').value = modelData.alias || '';
    document.getElementById('modelFormDescription').value = modelData.description || '';
    document.getElementById('modelFormSeries').value = modelData.series || '';
    document.getElementById('modelFormInputPrice').value = modelData.input_price_per_1k_tokens || 0;
    document.getElementById('modelFormOutputPrice').value = modelData.output_price_per_1k_tokens || 0;
    document.getElementById('modelFormCachedPrice').value = modelData.cached_output_price_per_1k_tokens || 0;
    document.getElementById('modelFormRefInputPrice').value = modelData.reference_input_price_per_1k_tokens || 0;
    document.getElementById('modelFormRefOutputPrice').value = modelData.reference_output_price_per_1k_tokens || 0;
    document.getElementById('modelFormThinkingModel').value = modelData.thinking_model_id || '';
    document.getElementById('modelFormNonThinkingModel').value = modelData.non_thinking_model_id || '';
    document.getElementById('modelFormRateLimitRpm').value = modelData.rate_limit_rpm || 0;
    document.getElementById('modelFormRateLimitTpm').value = modelData.rate_limit_tpm || 0;
    document.getElementById('modelFormEnabled').value = (modelData.enabled !== false).toString();

    this.showModal('addEditModelModal');
  }

  async submitAddEditModel() {
    const errorEl = document.getElementById('addEditModelError');
    errorEl.style.display = 'none';

    const isEdit = !!this._editingModelId;
    const provider = document.getElementById('modelFormProvider').value;
    const upstreamModelId = document.getElementById('modelFormUpstreamId').value.trim();
    const alias = document.getElementById('modelFormAlias').value.trim();
    const description = document.getElementById('modelFormDescription').value.trim();
    const series = document.getElementById('modelFormSeries').value.trim();
    const inputPrice = parseFloat(document.getElementById('modelFormInputPrice').value) || 0;
    const outputPrice = parseFloat(document.getElementById('modelFormOutputPrice').value) || 0;
    const cachedPrice = parseFloat(document.getElementById('modelFormCachedPrice').value) || 0;
    const refInputPrice = parseFloat(document.getElementById('modelFormRefInputPrice').value) || 0;
    const refOutputPrice = parseFloat(document.getElementById('modelFormRefOutputPrice').value) || 0;
    const thinkingModel = document.getElementById('modelFormThinkingModel').value;
    const nonThinkingModel = document.getElementById('modelFormNonThinkingModel').value;
    const rateLimitRpm = parseInt(document.getElementById('modelFormRateLimitRpm').value) || 0;
    const rateLimitTpm = parseInt(document.getElementById('modelFormRateLimitTpm').value) || 0;
    const enabled = document.getElementById('modelFormEnabled').value === 'true';

    if (!provider) {
      errorEl.textContent = t('请选择供应商');
      errorEl.style.display = 'block';
      return;
    }
    if (!upstreamModelId) {
      errorEl.textContent = t('请填写上游模型ID');
      errorEl.style.display = 'block';
      return;
    }

    const body = {
      provider,
      upstream_model_id: upstreamModelId,
      alias,
      description,
      series,
      input_price_per_1k_tokens: inputPrice,
      output_price_per_1k_tokens: outputPrice,
      cached_output_price_per_1k_tokens: cachedPrice,
      reference_input_price_per_1k_tokens: refInputPrice,
      reference_output_price_per_1k_tokens: refOutputPrice,
      thinking_model_id: thinkingModel,
      non_thinking_model_id: nonThinkingModel,
      rate_limit_rpm: rateLimitRpm,
      rate_limit_tpm: rateLimitTpm,
      enabled
    };

    // 编辑模式下传递模型ID
    if (isEdit) {
      body.id = this._editingModelId;
    }

    try {
      const url = isEdit ? `/api/user/models/${this._editingModelId}` : '/api/user/models';
      const method = isEdit ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || t('操作失败');
        errorEl.style.display = 'block';
        return;
      }

      this.closeModals();
      this.showToast(isEdit ? t('模型已更新') : t('模型已添加'), 'success');
      // 如果有回调（如从"我的模型"页面调用），执行回调
      if (this._onEditModelCallback) {
        await this._onEditModelCallback();
        this._onEditModelCallback = null;
      } else {
        await this.loadModelLibrary();
      }
    } catch (e) {
      errorEl.textContent = t('网络错误，请重试');
      errorEl.style.display = 'block';
    }
  }

  async deleteUserModel(modelId) {
    if (!await confirm(t('确定要删除此模型吗？此操作不可撤销。'))) return;

    try {
      const res = await fetch(`/api/user/models/${modelId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('删除失败'));
        return;
      }
      this.showToast(t('模型已删除'), 'success');
      await this.loadModelLibrary();
    } catch (e) {
      alert(t('网络错误，请重试'));
    }
  }

  async publishModel(modelId) {
    if (!await confirm(t('发布模型到默认 Team 后，您将失去对此模型的管理权限。确定要发布吗？'))) return;

    try {
      const res = await fetch(`/api/user/models/${modelId}/publish`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t('发布失败'));
        return;
      }
      this.showToast(t('模型已发布到默认 Team'), 'success');
      await this.loadModelLibrary();
    } catch (e) {
      alert(t('网络错误，请重试'));
    }
  }
}

const app = new ConsoleApp();
