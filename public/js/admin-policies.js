'use strict';

/**
 * 团队版策略管理页面控制器。
 * 由 AdminApp 在进入 adminPolicies 页面时惰性实例化。
 */
class AdminPoliciesApp {
  constructor(host) {
    this.host = host;
    this.mounted = false;
    this.root = null;
    this.tab = 'overview';
    this._teams = [];
    this._users = [];
    this._members = [];
    this._settings = null;
    this._filters = { q: '', scope_type: '', effect: '', enabled: '', category: '', group_id: '', tag: '' };
    this._policyPage = 1;
    this._policyPageSize = 50;
    this._selectedPolicies = new Set();
    this._groups = [];
    this._tags = [];
    this._hitFilters = { request_source: '', decision: '', range: '24h', q: '' };
    this._memberFilters = { q: '', status: '' };
    this._selectedMembers = new Set();
  }

  t(key) {
    return this.host?.t ? this.host.t(key) : (window.I18N?.t ? window.I18N.t(key) : key);
  }

  esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  fmt(value) {
    if (!value) return '-';
    return window.CRTime ? window.CRTime.formatTimeHtml(value) : this.esc(new Date(value).toLocaleString());
  }

  toast(message, type = 'success') {
    if (this.host?.showToast) this.host.showToast(message, type);
    else if (window.CrewRouterLiquid?.toast) window.CrewRouterLiquid.toast(message, type);
    else console.log(`[policy] ${type}: ${message}`);
  }

  async _request(url, options = {}) {
    const csrf = await fetch('/api/csrf-token', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    const headers = { ...(options.headers || {}) };
    if (csrf.token) headers['X-CSRF-Token'] = csrf.token;
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  isReadOnly() {
    return this.host?._policyReadOnly === true;
  }

  _applyReadOnly() {
    if (!this.isReadOnly() || !this.root) return;
    this.root.querySelectorAll('button').forEach(button => {
      const text = (button.textContent || '').trim();
      if (!text) return;
      if (/查看|导出|测试|刷新|关闭|取消|登录事件|下载审计报告/.test(text)) return;
      if (/新建|创建|编辑|删除|发布|停用|启用|复制|撤销|通过|驳回|暂停|恢复|豁免|导入|扫描|保存|紧急|回滚|设置/.test(text)) {
        button.style.display = 'none';
      }
    });
  }

  async mount(root) {
    if (!root) return;
    this.root = root;
    if (!this.mounted) {
      this.mounted = true;
      this._bindTabs();
      if (this.isReadOnly() && typeof MutationObserver !== 'undefined') {
        this._readOnlyObserver = new MutationObserver(() => this._applyReadOnly());
        this._readOnlyObserver.observe(root, { childList: true, subtree: true });
      }
      await Promise.all([this.loadTeams(), this.loadUsers()]).catch(() => {});
      await this.loadOverview();
      this._applyReadOnly();
    }
  }

  onHide() {
    // 当前无轮询；保留钩子。
  }

  _bindTabs() {
    const tabs = this.root?.querySelector('#policyTabs');
    if (!tabs || tabs.dataset.bound) return;
    tabs.dataset.bound = '1';
    tabs.addEventListener('blora-change', event => {
      const value = event.detail?.value || tabs.getAttribute('value') || 'overview';
      this.switchTab(value);
    });
    const initial = tabs.getAttribute('value') || 'overview';
    this.switchTab(initial);
  }

  async switchTab(tab) {
    this.tab = tab;
    const tabs = this.root?.querySelector('#policyTabs');
    if (tabs && tabs.getAttribute('value') !== tab) tabs.setAttribute('value', tab);
    if (tab === 'overview') await this.loadOverview();
    if (tab === 'policies') await this.loadPolicies();
    if (tab === 'members') await this.loadMembers();
    if (tab === 'clients') await this.loadClients();
    if (tab === 'hits') await this.loadHits();
    if (tab === 'exemptions') await this.loadExemptions();
    if (tab === 'approvals') await this.loadApprovals();
    if (tab === 'analytics') await this.loadAnalytics();
    if (tab === 'settings') await this.loadSettings();
  }

  pane(id) {
    return this.root?.querySelector(`#policy${id}Pane`);
  }

  loading(el, text = '加载中...') {
    if (el) el.innerHTML = `<p class="policy-loading">${this.esc(this.t(text))}</p>`;
  }

  error(el, error) {
    if (el) el.innerHTML = `<p class="policy-error">${this.esc(error.message || String(error))}</p>`;
  }

  // ==================== 数据加载 ====================

  async loadTeams() {
    const data = await this._request('/api/admin/policy-teams');
    this._teams = Array.isArray(data) ? data.filter(team => !team.is_personal) : [];
  }

  async loadUsers() {
    const data = await this._request('/api/admin/policy-users?limit=500');
    this._users = Array.isArray(data) ? data : (data.items || []);
  }

  async loadOverview() {
    const pane = this.pane('Overview');
    if (!pane) return;
    this.loading(pane);
    try {
      const [overview, settings, health] = await Promise.all([
        this._request('/api/admin/policies/overview'),
        this._request('/api/admin/policy-settings'),
        this._request('/api/admin/policies/health').catch(() => null),
      ]);
      this._settings = settings;
      const mode = settings.global?.kill_switch ? 'kill' : (settings.global?.enforcement_mode || 'enforce');
      const badge = document.getElementById('policyModeBadge');
      if (badge) {
        badge.textContent = mode === 'kill' ? '紧急停止' : mode === 'shadow' ? '观察模式' : '强制执行';
        badge.dataset.variant = mode === 'kill' ? 'danger' : mode === 'shadow' ? 'warning' : 'success';
      }
      const p = overview.policies || {};
      const h = overview.hits || {};
      const m = overview.members || {};
      const pending = overview.pending || {};
      pane.innerHTML = `
        <div class="policy-stat-grid">
          ${this._statCard('启用策略', `${p.enabled || 0} / ${p.total || 0}`, '已发布并生效')}
          ${this._statCard('24h 命中', h.last_24h || 0, `拦截 ${h.blocked_24h || 0} · 观察 ${h.observed_24h || 0}`)}
          ${this._statCard('7d 命中', h.last_7d || 0, '含拦截、告警与观察')}
          ${this._statCard('暂停成员', m.suspended || 0, `24h 内到期 ${m.suspended_24h || 0} · 豁免 ${m.bypassed || 0}`)}
          ${this._statCard('待处理', (pending.approvals || 0) + (pending.appeals || 0), `审批 ${pending.approvals || 0} · 申诉 ${pending.appeals || 0}`)}
        </div>
        <div class="policy-overview-columns">
          <section class="policy-card">
            <h3>Top 策略（24h）</h3>
            ${this._simpleTable(
              ['策略', '命中'],
              (overview.top_policies || []).map(row => [row.policy_name || `#${row.policy_id}`, row.hits]),
              '暂无命中记录'
            )}
          </section>
          <section class="policy-card">
            <h3>Top 客户端（24h）</h3>
            ${this._simpleTable(
              ['客户端', '命中'],
              (overview.top_clients || []).map(row => [row.label || row.request_source || 'unknown', row.hits]),
              '暂无命中记录'
            )}
          </section>
        </div>
        ${health ? `<section class="policy-card">
          <div class="policy-card-head"><h3>健康检查</h3>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-action="health-refresh">刷新</button>
          </div>
          <div class="policy-health-grid">
            <span>7 天内到期：<strong>${health.expiring_soon || 0}</strong></span>
            <span>30 天零命中：<strong>${health.zero_hits_30d || 0}</strong></span>
            <span>孤立作用域：<strong>${(health.orphan_teams || 0) + (health.orphan_members || 0)}</strong></span>
            <span>过期豁免：<strong>${health.expired_exemptions || 0}</strong></span>
          </div>
          ${(health.items?.expiring || []).length ? `<p class="policy-hint">即将到期：${health.items.expiring.map(policy => this.esc(policy.name)).join('、')}</p>` : ''}
          ${(health.items?.zero_hits || []).length ? `<p class="policy-hint">30 天未命中：${health.items.zero_hits.map(policy => this.esc(policy.name)).join('、')}</p>` : ''}
          ${(health.items?.orphans || []).length ? `<p class="policy-hint">孤立作用域：${health.items.orphans.map(policy => this.esc(policy.name)).join('、')}</p>` : ''}
        </section>` : ''}
        <div class="policy-quick-actions">
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-action="templates">从模板创建</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-action="quick-block-claude">一键禁止 Claude Code</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-action="quick-allow-claude">仅允许 Claude Code</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-action="quick-workhours">工作时段限制</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-action="quick-daily">每日 500 请求</button>
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-action="simulate">策略模拟</button>
          ${this.host?.user?.isAdmin === true ? `<button type="button" class="blora-button" data-variant="outline" data-size="sm" data-action="kill">${settings.global?.kill_switch ? '解除紧急停止' : '紧急停止全部策略'}</button>` : ''}
        </div>
      `;
      pane.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', () => {
          const action = button.dataset.action;
          if (action === 'templates') this.openTemplatePicker();
          if (action === 'simulate') this.openSimulator();
          if (action === 'kill') this.toggleKillSwitch();
          if (action === 'health-refresh') this.loadOverview();
          const quickTemplates = {
            'quick-block-claude': 'block-claude-code',
            'quick-allow-claude': 'allow-supported-clients',
            'quick-workhours': 'work-hours-block',
            'quick-daily': 'daily-request-cap',
          };
          if (quickTemplates[action]) this.quickCreateTemplate(quickTemplates[action]);
        });
      });
    } catch (error) {
      this.error(pane, error);
    }
  }

  async quickCreateTemplate(key) {
    const team = this._teams[0];
    if (!team) {
      this.toast('请先创建 Team 后再使用一键策略', 'error');
      return;
    }
    try {
      await this._request('/api/admin/policies/from-template', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, scope_type: 'team', scope_id: team.id }),
      });
      this.toast(`已为「${team.name}」创建策略`);
      await this.loadOverview();
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  _statCard(label, value, hint) {
    return `<div class="policy-stat-card">
      <span class="policy-stat-value">${this.esc(value)}</span>
      <span class="policy-stat-label">${this.esc(label)}</span>
      <span class="policy-stat-hint">${this.esc(hint)}</span>
    </div>`;
  }

  _simpleTable(headers, rows, emptyText) {
    if (!rows.length) return `<p class="policy-empty">${this.esc(this.t(emptyText))}</p>`;
    return `<div class="blora-table-wrap"><table class="blora-table">
      <thead><tr>${headers.map(h => `<th>${this.esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${this.esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }

  async loadPolicies() {
    const pane = this.pane('Policies');
    if (!pane) return;
    const seq = this._policiesLoadSeq = (this._policiesLoadSeq || 0) + 1;
    this.loading(pane);
    try {
      const [groups, tags] = await Promise.all([
        this._request('/api/admin/policy-groups').catch(() => []),
        this._request('/api/admin/policy-tags').catch(() => []),
      ]);
      this._groups = Array.isArray(groups) ? groups : [];
      this._tags = Array.isArray(tags) ? tags : [];
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(this._filters)) if (value) params.set(key, value);
      params.set('page', String(this._policyPage));
      params.set('limit', String(this._policyPageSize));
      const data = await this._request(`/api/admin/policies?${params.toString()}`);
      if (seq !== this._policiesLoadSeq) return;
      const items = data.items || [];
      const total = data.total || 0;
      const totalPages = Math.max(1, Math.ceil(total / this._policyPageSize));
      if (this._policyPage > totalPages) {
        this._policyPage = totalPages;
        return this.loadPolicies();
      }
      const selectedCount = this._selectedPolicies.size;
      pane.innerHTML = `
        <div class="policy-filter-bar">
          <input type="search" class="blora-input" id="policySearch" placeholder="搜索策略名称或描述" value="${this.esc(this._filters.q)}">
          <select class="blora-select" id="policyScopeFilter">
            <option value="">全部作用域</option>
            <option value="global" ${this._filters.scope_type === 'global' ? 'selected' : ''}>全局</option>
            <option value="team" ${this._filters.scope_type === 'team' ? 'selected' : ''}>Team</option>
            <option value="member" ${this._filters.scope_type === 'member' ? 'selected' : ''}>成员</option>
          </select>
          <select class="blora-select" id="policyEffectFilter">
            <option value="">全部效果</option>
            <option value="deny" ${this._filters.effect === 'deny' ? 'selected' : ''}>禁止</option>
            <option value="allow" ${this._filters.effect === 'allow' ? 'selected' : ''}>允许（白名单）</option>
          </select>
          <select class="blora-select" id="policyEnabledFilter">
            <option value="">全部状态</option>
            <option value="true" ${this._filters.enabled === 'true' ? 'selected' : ''}>启用</option>
            <option value="false" ${this._filters.enabled === 'false' ? 'selected' : ''}>停用</option>
          </select>
          <select class="blora-select" id="policyGroupFilter">
            <option value="">全部分组</option>
            ${this._groups.map(group => `<option value="${group.id}" ${String(this._filters.group_id) === String(group.id) ? 'selected' : ''}>${this.esc(group.name)}（${group.policy_count || 0}）</option>`).join('')}
          </select>
          <select class="blora-select" id="policyTagFilter">
            <option value="">全部标签</option>
            ${this._tags.map(item => `<option value="${this.esc(item.tag)}" ${this._filters.tag === item.tag ? 'selected' : ''}>${this.esc(item.tag)}（${item.count}）</option>`).join('')}
          </select>
          <button type="button" class="blora-button" data-variant="primary" data-size="sm" id="policyCreateBtn">新建策略</button>
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="policyTemplateBtn">从模板创建</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" id="policyGroupBtn">管理分组</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" id="policyExportBtn">导出</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" id="policyImportBtn">导入</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" id="policyScanBtn">输出扫描</button>
        </div>
        <div class="policy-bulk-bar" ${selectedCount ? '' : 'hidden'}>
          <span>已选 <strong id="policySelectedCount">${selectedCount}</strong> 条</span>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-bulk-op="enable">启用</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-bulk-op="disable">停用</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-bulk-op="priority">设为优先级 500</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-bulk-op="delete">删除</button>
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="policyClearSelection">清除选择</button>
        </div>
        <div class="blora-table-wrap">
          <table class="blora-table">
            <thead><tr>
              <th class="policy-select-col"><input type="checkbox" id="policySelectAll" aria-label="全选"></th>
              <th>名称</th><th>分组 / 标签</th><th>作用域</th><th>条件摘要</th><th>效果 / 动作</th><th>优先级</th><th>状态</th><th>24h 命中</th><th>操作</th>
            </tr></thead>
            <tbody>
              ${items.map(policy => this._policyRow(policy)).join('') || `<tr><td colspan="10" class="policy-empty">${this.esc(this.t('暂无策略'))}</td></tr>`}
            </tbody>
          </table>
        </div>
        <div class="policy-pagination">
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-page="prev" ${this._policyPage <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${this._policyPage} / ${totalPages} 页 · 共 ${total} 条</span>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-page="next" ${this._policyPage >= totalPages ? 'disabled' : ''}>下一页</button>
        </div>
      `;
      this._bindPolicyFilters(pane);
      this._bindPolicySelection(pane, items);
      pane.querySelector('#policyGroupBtn')?.addEventListener('click', () => this.openGroupManager());
      pane.querySelectorAll('[data-policy-page]').forEach(button => {
        button.addEventListener('click', () => {
          this._policyPage += button.dataset.policyPage === 'next' ? 1 : -1;
          this._selectedPolicies.clear();
          this.loadPolicies();
        });
      });
      pane.querySelectorAll('[data-policy-action]').forEach(button => {
        button.addEventListener('click', () => this._handlePolicyAction(button.dataset.policyAction, Number(button.dataset.id)));
      });
      pane.querySelectorAll('[data-bulk-op]').forEach(button => {
        button.addEventListener('click', () => this.bulkPolicyAction(button.dataset.bulkOp));
      });
      pane.querySelector('#policyClearSelection')?.addEventListener('click', () => {
        this._selectedPolicies.clear();
        this.loadPolicies();
      });
    } catch (error) {
      if (seq !== this._policiesLoadSeq) return;
      this.error(pane, error);
    }
  }

  _bindPolicySelection(pane, items) {
    const selectAll = pane.querySelector('#policySelectAll');
    const sync = () => {
      const count = this._selectedPolicies.size;
      const bar = pane.querySelector('.policy-bulk-bar');
      const label = pane.querySelector('#policySelectedCount');
      if (bar) bar.hidden = count === 0;
      if (label) label.textContent = String(count);
      if (selectAll) selectAll.checked = items.length > 0 && items.every(item => this._selectedPolicies.has(Number(item.id)));
    };
    pane.querySelectorAll('[data-policy-select]').forEach(checkbox => {
      checkbox.checked = this._selectedPolicies.has(Number(checkbox.dataset.policySelect));
      checkbox.addEventListener('change', () => {
        const id = Number(checkbox.dataset.policySelect);
        if (checkbox.checked) this._selectedPolicies.add(id);
        else this._selectedPolicies.delete(id);
        sync();
      });
    });
    selectAll?.addEventListener('change', () => {
      for (const item of items) {
        if (selectAll.checked) this._selectedPolicies.add(Number(item.id));
        else this._selectedPolicies.delete(Number(item.id));
      }
      pane.querySelectorAll('[data-policy-select]').forEach(checkbox => {
        checkbox.checked = selectAll.checked;
      });
      sync();
    });
    sync();
  }

  async bulkPolicyAction(operation) {
    const ids = [...this._selectedPolicies];
    if (!ids.length) return;
    if (operation === 'delete' && !window.confirm(`删除已选 ${ids.length} 条策略？`)) return;
    try {
      await this._request('/api/admin/policies/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, operation, priority: 500 }),
      });
      this.toast(`批量操作完成（${ids.length} 条）`);
      this._selectedPolicies.clear();
      await this.loadPolicies();
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async openGroupManager() {
    const groups = await this._request('/api/admin/policy-groups').catch(() => []);
    const dialog = Dialog.showModal({
      title: '策略分组',
      width: 'min(620px, 96vw)',
      content: `
        <div class="policy-editor-grid">
          <label class="blora-field"><span class="blora-field__label">新分组名称</span><input class="blora-input" id="groupName"></label>
          <label class="blora-field"><span class="blora-field__label">描述</span><input class="blora-input" id="groupDesc"></label>
        </div>
        <button type="button" class="blora-button" data-variant="primary" data-size="sm" id="groupCreateBtn">创建分组</button>
        <div class="blora-table-wrap" style="margin-top:12px;"><table class="blora-table">
          <thead><tr><th>名称</th><th>策略数</th><th>操作</th></tr></thead>
          <tbody>${(groups || []).map(group => `<tr>
            <td>${this.esc(group.name)}${group.description ? `<div class="policy-desc">${this.esc(group.description)}</div>` : ''}</td>
            <td>${group.policy_count || 0}</td>
            <td><button type="button" class="blora-button" data-variant="outline" data-size="sm" data-group-delete="${group.id}">删除</button></td>
          </tr>`).join('') || '<tr><td colspan="3" class="policy-empty">暂无分组</td></tr>'}</tbody>
        </table></div>
      `,
      footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>',
    });
    dialog.element.querySelector('#groupCreateBtn')?.addEventListener('click', async () => {
      try {
        await this._request('/api/admin/policy-groups', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: dialog.element.querySelector('#groupName').value,
            description: dialog.element.querySelector('#groupDesc').value,
            team_id: this.host?.user?.isAdmin === true ? null : (this._teams[0]?.id || null),
          }),
        });
        this.toast('分组已创建');
        dialog.close('created');
        await this.loadPolicies();
      } catch (error) { this.toast(error.message, 'error'); }
    });
    dialog.element.querySelectorAll('[data-group-delete]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!window.confirm('删除该分组？策略会保留但取消分组。')) return;
        try {
          await this._request(`/api/admin/policy-groups/${button.dataset.groupDelete}`, { method: 'DELETE' });
          this.toast('分组已删除');
          dialog.close('deleted');
          await this.loadPolicies();
        } catch (error) { this.toast(error.message, 'error'); }
      });
    });
  }

  _conditionSummary(conditions = {}) {
    const parts = [];
    const clients = { claude_code: 'Claude Code', codex: 'Codex', grok: 'Grok', opencode: 'OpenCode', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw', deepseek_harness: 'DeepSeek', unknown: '未知客户端' };
    if (conditions.clients?.length) parts.push(`客户端: ${conditions.clients.map(c => clients[c] || c).join('/')}`);
    if (conditions.models?.length) parts.push(`模型: ${conditions.models.join('/')}`);
    if (conditions.ips?.length) parts.push(`IP: ${conditions.ips.join('/')}`);
    if (conditions.schedule?.weekly) {
      const days = Object.entries(conditions.schedule.weekly).filter(([, ranges]) => ranges?.length);
      parts.push(`时间: ${days.length} 天日程`);
    }
    if (conditions.login) parts.push(`登录${conditions.login.require_mfa ? '需 MFA' : ''}${conditions.login.methods?.length ? `: ${conditions.login.methods.join('/')}` : ''}`);
    if (conditions.usage) parts.push(`用量: ${conditions.usage.metric} ≥ ${conditions.usage.gte}`);
    if (conditions.budget) parts.push(`预算: ${conditions.budget.metric} ≥ ${conditions.budget.gte}`);
    if (conditions.tools?.names?.length) parts.push(`工具: ${conditions.tools.names.join('/')}`);
    if (conditions.prompt?.contains?.length) parts.push(`提示词: ${conditions.prompt.contains.join('/')}`);
    if (conditions.output?.contains?.length) parts.push(`输出: ${conditions.output.contains.join('/')}`);
    if (conditions.media) parts.push('媒体限制');
    if (conditions.countries?.length) parts.push(`国家: ${conditions.countries.join('/')}`);
    if (conditions.asn?.length) parts.push(`ASN: ${conditions.asn.join('/')}`);
    return parts.join(' · ') || '—';
  }

  _scopeLabel(policy) {
    if (policy.scope_type === 'global') return '全局';
    if (policy.scope_type === 'team') {
      const team = this._teams.find(t => Number(t.id) === Number(policy.scope_id));
      return `Team · ${team?.name || policy.scope_id}`;
    }
    const user = this._users.find(u => Number(u.id) === Number(policy.scope_id));
    return `成员 · ${user?.username || policy.scope_id}`;
  }

  _policyRow(policy) {
    const actionLabels = {
      block: '拦截', warn: '告警', shadow: '观察', notify: '通知', throttle: '限速',
      queue: '排队', downgrade: '降级', approval: '审批', step_up: '二次认证',
      suspend: '暂停', revoke_key: '吊销 Key', custom: '自定义',
    };
    const group = (this._groups || []).find(item => Number(item.id) === Number(policy.group_id));
    const tags = Array.isArray(policy.tags) ? policy.tags : [];
    return `<tr>
      <td class="policy-select-col"><input type="checkbox" data-policy-select="${policy.id}" aria-label="选择策略"></td>
      <td><strong>${this.esc(policy.name)}</strong>${policy.description ? `<div class="policy-desc">${this.esc(policy.description)}</div>` : ''}</td>
      <td>${group ? `<span class="blora-badge" data-variant="info">${this.esc(group.name)}</span>` : '<span class="policy-muted">-</span>'}
        ${tags.length ? `<div class="policy-tags">${tags.slice(0, 4).map(tag => `<span class="blora-tag">${this.esc(tag)}</span>`).join('')}</div>` : ''}</td>
      <td>${this.esc(this._scopeLabel(policy))}</td>
      <td class="policy-condition-summary" title="${this.esc(JSON.stringify(policy.conditions || {}))}">${this.esc(this._conditionSummary(policy.conditions || {}))}</td>
      <td><span class="blora-badge" data-variant="${policy.effect === 'deny' ? 'danger' : 'success'}">${policy.effect === 'deny' ? '禁止' : '允许'}</span> ${this.esc(actionLabels[policy.action] || policy.action)}</td>
      <td>${policy.priority}</td>
      <td>${policy.enabled ? '<span class="blora-badge" data-variant="success">启用</span>' : '<span class="blora-badge" data-variant="neutral">停用</span>'} ${policy.status !== 'published' ? `<span class="blora-badge" data-variant="warning">${this.esc(policy.status)}</span>` : ''}</td>
      <td>${policy.hits_24h || 0}</td>
      <td class="policy-row-actions">
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="edit" data-id="${policy.id}">编辑</button>
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="toggle" data-id="${policy.id}">${policy.enabled ? '停用' : '启用'}</button>
        ${policy.status !== 'published' ? `<button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="publish" data-id="${policy.id}">发布</button>` : ''}
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="versions" data-id="${policy.id}">版本</button>
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="duplicate" data-id="${policy.id}">复制</button>
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="delete" data-id="${policy.id}">删除</button>
      </td>
    </tr>`;
  }

  _bindPolicyFilters(pane) {
    const search = pane.querySelector('#policySearch');
    let timer = null;
    search?.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { this._filters.q = search.value.trim(); this._policyPage = 1; this.loadPolicies(); }, 300);
    });
    const change = (key) => (event) => { this._filters[key] = event.target.value; this._policyPage = 1; this._selectedPolicies.clear(); this.loadPolicies(); };
    pane.querySelector('#policyScopeFilter')?.addEventListener('change', change('scope_type'));
    pane.querySelector('#policyEffectFilter')?.addEventListener('change', change('effect'));
    pane.querySelector('#policyEnabledFilter')?.addEventListener('change', change('enabled'));
    pane.querySelector('#policyGroupFilter')?.addEventListener('change', change('group_id'));
    pane.querySelector('#policyTagFilter')?.addEventListener('change', change('tag'));
    pane.querySelector('#policyCreateBtn')?.addEventListener('click', () => this.openEditor());
    pane.querySelector('#policyTemplateBtn')?.addEventListener('click', () => this.openTemplatePicker());
    pane.querySelector('#policyExportBtn')?.addEventListener('click', () => this.exportPolicies());
    pane.querySelector('#policyImportBtn')?.addEventListener('click', () => this.importPolicies());
    pane.querySelector('#policyScanBtn')?.addEventListener('click', () => this.runOutputScan());
  }

  async _handlePolicyAction(action, id) {
    try {
      if (action === 'edit') {
        const data = await this._request(`/api/admin/policies/${id}`);
        this.openEditor(data.policy);
        return;
      }
      if (action === 'toggle') {
        const data = await this._request(`/api/admin/policies/${id}`);
        const policy = data.policy;
        await this._request(`/api/admin/policies/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !policy.enabled, conditions: policy.conditions, name: policy.name }),
        });
        this.toast(policy.enabled ? '策略已停用' : '策略已启用');
        await this.loadPolicies();
        return;
      }
      if (action === 'duplicate') {
        await this._request(`/api/admin/policies/${id}/duplicate`, { method: 'POST' });
        this.toast('策略已复制');
        await this.loadPolicies();
        return;
      }
      if (action === 'publish') {
        const result = await this._request(`/api/admin/policies/${id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        this.toast(result.pending_approval ? '已提交发布审批' : '策略已发布');
        await this.loadPolicies();
        return;
      }
      if (action === 'versions') {
        await this.openVersions(id);
        return;
      }
      if (action === 'delete') {
        if (!window.confirm('确定删除该策略？')) return;
        await this._request(`/api/admin/policies/${id}`, { method: 'DELETE' });
        this.toast('策略已删除');
        await this.loadPolicies();
      }
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async exportPolicies() {
    try {
      const data = await this._request('/api/admin/policies/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `crewrouter-policies-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.toast(`已导出 ${(data.policies || []).length} 条策略`);
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async importPolicies() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const policies = Array.isArray(payload) ? payload : payload.policies;
        if (!Array.isArray(policies) || !policies.length) throw new Error('文件中没有策略');
        const preview = await this._request('/api/admin/policies/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policies, dry_run: true }),
        });
        const ok = (preview.results || []).filter(item => item.ok).length;
        if (!window.confirm(`校验通过 ${ok} / ${policies.length} 条，是否导入？`)) return;
        const result = await this._request('/api/admin/policies/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policies, dry_run: false }),
        });
        const imported = (result.results || []).filter(item => item.ok && !item.skipped).length;
        const skipped = (result.results || []).filter(item => item.skipped).length;
        this.toast(`已导入 ${imported} 条，跳过 ${skipped} 条`, imported ? 'success' : 'warning');
        await this.loadPolicies();
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });
    input.click();
  }

  async runOutputScan() {
    try {
      const result = await this._request('/api/admin/policies/output-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since_minutes: 60, limit: 200 }),
      });
      this.toast(`扫描 ${result.scanned || 0} 条响应，命中 ${result.matched || 0} 次`, result.matched ? 'warning' : 'success');
      await this.loadHits();
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  // ==================== 编辑器 ====================

  openEditor(policy = null) {
    const draft = policy || {
      name: '', description: '', scope_type: 'team', scope_id: this._teams[0]?.id || '',
      effect: 'deny', action: 'block', priority: 100, category: 'combined',
      conditions: {}, action_options: {}, ladder: [], status_code: 403,
      notify_channels: { inapp: true, webhook: false, email: false }, enabled: true,
      status: 'published', auto_publish_at: null,
    };
    const dialog = Dialog.showModal({
      title: policy ? '编辑策略' : '新建策略',
      width: 'min(960px, 96vw)',
      content: `
        <div class="policy-editor">
          <div class="policy-editor-grid">
            <label class="blora-field"><span class="blora-field__label">名称</span>
              <input class="blora-input" id="peName" maxlength="120" value="${this.esc(draft.name)}">
            </label>
            <label class="blora-field"><span class="blora-field__label">分类</span>
              <select class="blora-select" id="peCategory">
                ${['client','identity','model','provider','network','time','usage','capacity','content','session','combined']
                  .map(value => `<option value="${value}" ${draft.category === value ? 'selected' : ''}>${value}</option>`).join('')}
              </select>
            </label>
            <label class="blora-field"><span class="blora-field__label">作用域</span>
              <select class="blora-select" id="peScopeType">
                <option value="global" ${draft.scope_type === 'global' ? 'selected' : ''}>全局</option>
                <option value="team" ${draft.scope_type === 'team' ? 'selected' : ''}>Team</option>
                <option value="member" ${draft.scope_type === 'member' ? 'selected' : ''}>成员</option>
              </select>
            </label>
            <label class="blora-field"><span class="blora-field__label">作用对象</span>
              <select class="blora-select" id="peScopeId"></select>
            </label>
            <label class="blora-field"><span class="blora-field__label">效果</span>
              <select class="blora-select" id="peEffect">
                <option value="deny" ${draft.effect === 'deny' ? 'selected' : ''}>禁止</option>
                <option value="allow" ${draft.effect === 'allow' ? 'selected' : ''}>允许（白名单）</option>
              </select>
            </label>
            <label class="blora-field"><span class="blora-field__label">动作</span>
              <select class="blora-select" id="peAction">
                ${['block','warn','shadow','notify','throttle','queue','downgrade','approval','suspend','revoke_key','custom']
                  .map(value => `<option value="${value}" ${draft.action === value ? 'selected' : ''}>${value}</option>`).join('')}
              </select>
            </label>
            <label class="blora-field"><span class="blora-field__label">优先级（越大越优先）</span>
              <input class="blora-input" type="number" id="pePriority" min="0" max="1000" value="${draft.priority}">
            </label>
            <label class="blora-field"><span class="blora-field__label">状态码</span>
              <select class="blora-select" id="peStatusCode">
                <option value="403" ${Number(draft.status_code) === 403 ? 'selected' : ''}>403 Forbidden</option>
                <option value="429" ${Number(draft.status_code) === 429 ? 'selected' : ''}>429 Too Many Requests</option>
              </select>
            </label>
          </div>
          <label class="blora-field"><span class="blora-field__label">描述</span>
            <input class="blora-input" id="peDescription" maxlength="4000" value="${this.esc(draft.description || '')}">
          </label>
          <div class="policy-quick-conditions">
            <span>快速添加：</span>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="client">客户端</button>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="model">模型</button>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="ip">IP</button>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="time">工作时间</button>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="usage">每日用量</button>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="tools">MCP 工具</button>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="login">登录 MFA</button>
            <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-quick-condition="output">输出关键词</button>
          </div>
          <label class="blora-field"><span class="blora-field__label">条件 JSON</span>
            <textarea class="blora-textarea" id="peConditions" rows="10" spellcheck="false">${this.esc(JSON.stringify(draft.conditions || {}, null, 2))}</textarea>
          </label>
          <div class="policy-editor-grid">
            <label class="blora-field"><span class="blora-field__label">分组</span>
              <select class="blora-select" id="peGroup">
                <option value="">无分组</option>
                ${(this._groups || []).map(group => `<option value="${group.id}" ${Number(draft.group_id) === Number(group.id) ? 'selected' : ''}>${this.esc(group.name)}</option>`).join('')}
              </select>
            </label>
            <label class="blora-field"><span class="blora-field__label">标签（逗号分隔）</span>
              <input class="blora-input" id="peTags" value="${this.esc((draft.tags || []).join(', '))}">
            </label>
          </div>
          <div class="policy-editor-grid">
            <label class="blora-field"><span class="blora-field__label">状态</span>
              <select class="blora-select" id="peStatus">
                <option value="draft" ${draft.status === 'draft' ? 'selected' : ''}>草稿</option>
                <option value="published" ${draft.status === 'published' || !draft.status ? 'selected' : ''}>已发布</option>
                <option value="archived" ${draft.status === 'archived' ? 'selected' : ''}>已归档</option>
              </select>
            </label>
            <label class="blora-field"><span class="blora-field__label">定时发布（本地）</span>
              <input class="blora-input" type="datetime-local" id="peAutoPublish" value="${this._localInput(draft.auto_publish_at)}">
            </label>
          </div>
          <div class="policy-editor-grid">
            <label class="blora-field"><span class="blora-field__label">限速毫秒</span>
              <input class="blora-input" type="number" id="peThrottleMs" value="${draft.action_options?.throttle_ms ?? ''}">
            </label>
            <label class="blora-field"><span class="blora-field__label">排队等待毫秒</span>
              <input class="blora-input" type="number" id="peQueueWaitMs" value="${draft.action_options?.queue_wait_ms ?? ''}">
            </label>
            <label class="blora-field"><span class="blora-field__label">并发上限</span>
              <input class="blora-input" type="number" id="peQueueMax" value="${draft.action_options?.queue_max ?? ''}">
            </label>
            <label class="blora-field"><span class="blora-field__label">降级模型</span>
              <input class="blora-input" id="peDowngradeTo" value="${this.esc(draft.action_options?.downgrade_to || '')}">
            </label>
            <label class="blora-field"><span class="blora-field__label">暂停秒数</span>
              <input class="blora-input" type="number" id="peSuspendSeconds" value="${draft.action_options?.suspend_seconds ?? ''}">
            </label>
            <label class="blora-field"><span class="blora-field__label">策略 RPM</span>
              <input class="blora-input" type="number" id="peRpm" value="${draft.action_options?.rpm ?? ''}">
            </label>
            <label class="blora-field"><span class="blora-field__label">策略 TPM</span>
              <input class="blora-input" type="number" id="peTpm" value="${draft.action_options?.tpm ?? ''}">
            </label>
            <label class="blora-field"><span class="blora-field__label">自定义消息</span>
              <input class="blora-input" id="peCustomMessage" value="${this.esc(draft.action_options?.custom_message || '')}">
            </label>
          </div>
          <div class="policy-editor-grid">
            <label class="blora-field"><span class="blora-field__label">动作参数 JSON</span>
              <textarea class="blora-textarea" id="peOptions" rows="5" spellcheck="false">${this.esc(JSON.stringify(draft.action_options || {}, null, 2))}</textarea>
            </label>
            <label class="blora-field"><span class="blora-field__label">阶梯 JSON（可选）</span>
              <textarea class="blora-textarea" id="peLadder" rows="5" spellcheck="false">${this.esc(JSON.stringify(draft.ladder || [], null, 2))}</textarea>
            </label>
          </div>
          <div class="policy-editor-grid">
            <label class="blora-field"><span class="blora-field__label">开始时间（本地）</span>
              <input class="blora-input" type="datetime-local" id="peStartsAt" value="${this._localInput(draft.starts_at)}">
            </label>
            <label class="blora-field"><span class="blora-field__label">结束时间（本地）</span>
              <input class="blora-input" type="datetime-local" id="peEndsAt" value="${this._localInput(draft.ends_at)}">
            </label>
          </div>
          <label class="policy-check"><input type="checkbox" id="peEnabled" ${draft.enabled !== false ? 'checked' : ''}> 启用策略</label>
          <label class="policy-check"><input type="checkbox" id="peWebhook" ${draft.notify_channels?.webhook ? 'checked' : ''}> 命中时发送 Webhook/告警渠道</label>
          <div class="policy-preview">
            <h4>模拟预览</h4>
            <div class="policy-preview-grid">
              <input class="blora-input" id="peSampleClient" value="claude_code" aria-label="客户端">
              <input class="blora-input" id="peSampleModel" value="claude-fable-5" aria-label="模型">
              <input class="blora-input" id="peSampleIp" value="203.0.113.9" aria-label="IP">
              <input class="blora-input" id="peSampleTime" type="datetime-local" value="${this._localInput(new Date())}" aria-label="时间">
            </div>
            <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="pePreviewBtn">运行预览</button>
            <pre class="policy-preview-result" id="pePreviewResult"></pre>
          </div>
        </div>
      `,
      footer: `
        <button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>取消</button>
        <button type="button" class="blora-button" data-variant="primary" id="peSaveBtn">${policy ? '保存' : '创建'}</button>
      `,
    });

    const el = dialog.element;
    const scopeType = el.querySelector('#peScopeType');
    const scopeId = el.querySelector('#peScopeId');
    const refreshScope = () => {
      const type = scopeType.value;
      if (type === 'global') {
        scopeId.innerHTML = '<option value="">全局（所有团队）</option>';
        scopeId.disabled = true;
        return;
      }
      scopeId.disabled = false;
      const list = type === 'team' ? this._teams : this._users;
      scopeId.innerHTML = list.map(item => `<option value="${item.id}" ${Number(item.id) === Number(draft.scope_id) ? 'selected' : ''}>${this.esc(item.name || item.username)}</option>`).join('');
    };
    scopeType.addEventListener('change', refreshScope);
    refreshScope();

    const quickSnippets = {
      client: { clients: ['claude_code'] },
      model: { models: ['claude-*'] },
      ip: { ips: ['10.0.0.0/8'] },
      time: {
        schedule: {
          timezone: 'Asia/Shanghai',
          weekly: {
            mon: [['09:00', '18:00']], tue: [['09:00', '18:00']],
            wed: [['09:00', '18:00']], thu: [['09:00', '18:00']],
            fri: [['09:00', '18:00']], sat: [], sun: [],
          },
          dates: [], exclude_dates: [],
        },
      },
      usage: { usage: { metric: 'requests', window: 'day', aggregate: 'member', gte: 100 } },
      tools: { tools: { names: ['mcp__github__*'] } },
      login: { login: { require_mfa: true } },
      output: { output: { contains: ['secret'] } },
    };
    el.querySelectorAll('[data-quick-condition]').forEach(button => {
      button.addEventListener('click', () => {
        const textarea = el.querySelector('#peConditions');
        try {
          const current = JSON.parse(textarea.value || '{}');
          Object.assign(current, quickSnippets[button.dataset.quickCondition] || {});
          textarea.value = JSON.stringify(current, null, 2);
        } catch (_) {
          this.toast('当前条件 JSON 无效，请先修正', 'error');
        }
      });
    });

    el.querySelector('#pePreviewBtn')?.addEventListener('click', async () => {
      const resultEl = el.querySelector('#pePreviewResult');
      try {
        const payload = {
          policy: this._collectEditor(el, false),
          sample: {
            client: el.querySelector('#peSampleClient').value,
            model: el.querySelector('#peSampleModel').value,
            ip: el.querySelector('#peSampleIp').value,
            at: el.querySelector('#peSampleTime').value ? new Date(el.querySelector('#peSampleTime').value).toISOString() : new Date().toISOString(),
            semantics: 'primary',
          },
        };
        const result = await this._request('/api/admin/policies/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        resultEl.textContent = JSON.stringify(result, null, 2);
      } catch (error) {
        resultEl.textContent = error.message;
      }
    });

    el.querySelector('#peSaveBtn')?.addEventListener('click', async () => {
      const button = el.querySelector('#peSaveBtn');
      try {
        if (button.disabled) return;
        button.disabled = true;
        const payload = this._collectEditor(el, true);
        if (policy) {
          await this._request(`/api/admin/policies/${policy.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          });
          this.toast('策略已保存');
        } else {
          await this._request('/api/admin/policies', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          });
          this.toast('策略已创建');
        }
        dialog.close('saved');
        await this.loadPolicies();
      } catch (error) {
        this.toast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  _localInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = num => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  _collectEditor(el, forSave) {
    const parseJson = (id, fallback) => {
      const raw = el.querySelector(id)?.value?.trim();
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch (_) {
        throw new Error(`${id} 不是合法 JSON`);
      }
    };
    const scopeType = el.querySelector('#peScopeType').value;
    const scopeIdValue = el.querySelector('#peScopeId').value;
    const startsAt = el.querySelector('#peStartsAt').value;
    const endsAt = el.querySelector('#peEndsAt').value;
    const autoPublish = el.querySelector('#peAutoPublish').value;
    const actionOptions = parseJson('#peOptions', {});
    const numberField = (id) => {
      const raw = el.querySelector(id)?.value;
      if (raw === '' || raw == null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    for (const [id, key] of [
      ['#peThrottleMs', 'throttle_ms'], ['#peQueueWaitMs', 'queue_wait_ms'],
      ['#peQueueMax', 'queue_max'], ['#peSuspendSeconds', 'suspend_seconds'],
      ['#peRpm', 'rpm'], ['#peTpm', 'tpm'],
    ]) {
      const value = numberField(id);
      if (value != null) actionOptions[key] = value;
    }
    const downgradeTo = el.querySelector('#peDowngradeTo')?.value?.trim();
    if (downgradeTo) actionOptions.downgrade_to = downgradeTo;
    const customMessage = el.querySelector('#peCustomMessage')?.value?.trim();
    if (customMessage) actionOptions.custom_message = customMessage;
    const payload = {
      name: el.querySelector('#peName').value.trim(),
      description: el.querySelector('#peDescription').value,
      scope_type: scopeType,
      scope_id: scopeType === 'global' ? null : Number(scopeIdValue),
      effect: el.querySelector('#peEffect').value,
      action: el.querySelector('#peAction').value,
      priority: Number(el.querySelector('#pePriority').value),
      category: el.querySelector('#peCategory').value,
      status_code: Number(el.querySelector('#peStatusCode').value),
      conditions: parseJson('#peConditions', {}),
      action_options: actionOptions,
      ladder: parseJson('#peLadder', []),
      notify_channels: { inapp: true, webhook: el.querySelector('#peWebhook').checked, email: false },
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      auto_publish_at: autoPublish ? new Date(autoPublish).toISOString() : null,
      status: el.querySelector('#peStatus')?.value || (forSave ? 'published' : 'draft'),
      group_id: el.querySelector('#peGroup')?.value ? Number(el.querySelector('#peGroup').value) : null,
      tags: (el.querySelector('#peTags')?.value || '').split(',').map(item => item.trim()).filter(Boolean).slice(0, 50),
      enabled: el.querySelector('#peEnabled').checked,
    };
    return payload;
  }

  // ==================== 模板 ====================

  async openTemplatePicker() {
    try {
      const templates = await this._request('/api/admin/policies/templates');
      const dialog = Dialog.showModal({
        title: '从模板创建策略',
        width: 'min(820px, 96vw)',
        content: `
          <div class="policy-template-toolbar">
            <label class="blora-field"><span class="blora-field__label">作用域</span>
              <select class="blora-select" id="tplScopeType">
                <option value="team">Team</option><option value="global">全局</option><option value="member">成员</option>
              </select>
            </label>
            <label class="blora-field"><span class="blora-field__label">作用对象</span>
              <select class="blora-select" id="tplScopeId"></select>
            </label>
          </div>
          <div class="policy-template-grid">
            ${templates.map(template => `<button type="button" class="policy-template-card" data-template="${this.esc(template.key)}">
              <strong>${this.esc(template.name)}</strong>
              <small>${this.esc(template.description)}</small>
              <span class="blora-badge" data-variant="info">${this.esc(template.category)}</span>
            </button>`).join('')}
          </div>
        `,
        footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>',
      });
      const el = dialog.element;
      const type = el.querySelector('#tplScopeType');
      const scope = el.querySelector('#tplScopeId');
      const refresh = () => {
        if (type.value === 'global') {
          scope.innerHTML = '<option value="">全局</option>';
          scope.disabled = true;
          return;
        }
        scope.disabled = false;
        const list = type.value === 'team' ? this._teams : this._users;
        scope.innerHTML = list.map(item => `<option value="${item.id}">${this.esc(item.name || item.username)}</option>`).join('');
      };
      type.addEventListener('change', refresh);
      refresh();
      el.querySelectorAll('[data-template]').forEach(card => {
        card.addEventListener('click', async () => {
          try {
            await this._request('/api/admin/policies/from-template', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                key: card.dataset.template,
                scope_type: type.value,
                scope_id: type.value === 'global' ? null : Number(scope.value),
              }),
            });
            this.toast('已从模板创建策略');
            dialog.close('created');
            await this.loadPolicies();
            await this.switchTab('policies');
          } catch (error) {
            this.toast(error.message, 'error');
          }
        });
      });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  // ==================== 成员 ====================

  async loadMembers() {
    const pane = this.pane('Members');
    if (!pane) return;
    this.loading(pane);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (this._memberFilters.q) params.set('q', this._memberFilters.q);
      if (this._memberFilters.status) params.set('status', this._memberFilters.status);
      const data = await this._request(`/api/admin/policy-members?${params.toString()}`);
      this._members = data.items || [];
      pane.innerHTML = `
        <div class="policy-filter-bar">
          <input type="search" class="blora-input" id="memberSearch" placeholder="搜索成员" value="${this.esc(this._memberFilters.q)}">
          <select class="blora-select" id="memberStatusFilter">
            <option value="">全部状态</option>
            <option value="active" ${this._memberFilters.status === 'active' ? 'selected' : ''}>正常</option>
            <option value="suspended" ${this._memberFilters.status === 'suspended' ? 'selected' : ''}>暂停中</option>
          </select>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" id="loginEventsBtn">登录事件</button>
        </div>
        <div class="policy-bulk-bar" hidden>
          <span>已选 <strong id="memberSelectedCount">0</strong> 位成员</span>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-bulk="suspend">暂停 24 小时</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-bulk="resume">恢复</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-bulk="offboard">离岗停用</button>
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="memberClearSelection">清除选择</button>
        </div>
        <div class="blora-table-wrap">
          <table class="blora-table">
            <thead><tr><th class="policy-select-col"><input type="checkbox" id="memberSelectAll" aria-label="全选成员"></th><th>成员</th><th>Team</th><th>Team 角色</th><th>状态</th><th>暂停至</th><th>生效策略</th><th>24h 命中</th><th>操作</th></tr></thead>
            <tbody>
              ${this._members.map(member => this._memberRow(member)).join('') || `<tr><td colspan="9" class="policy-empty">${this.esc(this.t('暂无成员'))}</td></tr>`}
            </tbody>
          </table>
        </div>
        <p class="policy-summary">共 ${data.total || 0} 位成员</p>
      `;
      let timer = null;
      pane.querySelector('#memberSearch')?.addEventListener('input', event => {
        clearTimeout(timer);
        timer = setTimeout(() => { this._memberFilters.q = event.target.value.trim(); this.loadMembers(); }, 300);
      });
      pane.querySelector('#memberStatusFilter')?.addEventListener('change', event => {
        this._memberFilters.status = event.target.value;
        this.loadMembers();
      });
      pane.querySelector('#loginEventsBtn')?.addEventListener('click', () => this.openLoginEvents());
      this._bindMemberSelection(pane);
      pane.querySelectorAll('[data-member-bulk]').forEach(button => {
        button.addEventListener('click', () => this.bulkMemberAction(button.dataset.memberBulk));
      });
      pane.querySelector('#memberClearSelection')?.addEventListener('click', () => {
        this._selectedMembers.clear();
        this.loadMembers();
      });
      pane.querySelectorAll('[data-member-role]').forEach(select => {
        select.addEventListener('change', async () => {
          const member = (this._members || []).find(item => Number(item.id) === Number(select.dataset.memberRole));
          try {
            await this._request(`/api/admin/policy-members/${select.dataset.memberRole}/role`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ team_id: member?.team_id, role: select.value }),
            });
            this.toast('角色已更新');
          } catch (error) {
            this.toast(error.message, 'error');
            await this.loadMembers();
          }
        });
      });
      pane.querySelectorAll('[data-member-action]').forEach(button => {
        button.addEventListener('click', () => this._handleMemberAction(button.dataset.memberAction, Number(button.dataset.id), button.dataset.name));
      });
    } catch (error) {
      this.error(pane, error);
    }
  }

  _memberRow(member) {
    const until = member.suspended_until;
    const suspended = member.suspended_at && (!until || new Date(until) > new Date());
    const role = member.team_role || 'member';
    return `<tr>
      <td class="policy-select-col"><input type="checkbox" data-member-select="${member.id}" aria-label="选择成员"></td>
      <td><strong>${this.esc(member.username)}</strong>${member.is_admin ? ' <span class="blora-badge" data-variant="info">管理员</span>' : ''}<div class="policy-desc">${this.esc(member.email || '')}</div></td>
      <td>${this.esc(member.team_name || member.team_id || '-')}</td>
      <td>${member.team_id ? `<select class="blora-select" data-member-role="${member.id}" aria-label="Team 角色">
        ${['owner','admin','member','viewer'].map(value => `<option value="${value}" ${role === value ? 'selected' : ''}>${value}</option>`).join('')}
      </select>` : '-'}</td>
      <td>${suspended ? '<span class="blora-badge" data-variant="danger">暂停中</span>' : '<span class="blora-badge" data-variant="success">正常</span>'}${member.policy_bypass ? ' <span class="blora-badge" data-variant="warning">策略豁免</span>' : ''}</td>
      <td>${until ? this.fmt(until) : (suspended ? '永久' : '-')}</td>
      <td>${member.policy_count || 0}</td>
      <td>${member.hits_24h || 0}</td>
      <td class="policy-row-actions">
        ${suspended
          ? `<button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="resume" data-id="${member.id}" data-name="${this.esc(member.username)}">恢复</button>`
          : `<button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="suspend" data-id="${member.id}" data-name="${this.esc(member.username)}">暂停</button>`}
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="detail" data-id="${member.id}" data-name="${this.esc(member.username)}">详情</button>
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="effective" data-id="${member.id}" data-name="${this.esc(member.username)}">生效策略</button>
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="bypass" data-id="${member.id}" data-name="${this.esc(member.username)}">${member.policy_bypass ? '关闭豁免' : '策略豁免'}</button>
      </td>
    </tr>`;
  }

  _bindMemberSelection(pane) {
    const selectAll = pane.querySelector('#memberSelectAll');
    const sync = () => {
      const count = this._selectedMembers.size;
      const bar = pane.querySelector('.policy-bulk-bar');
      const label = pane.querySelector('#memberSelectedCount');
      if (bar) bar.hidden = count === 0;
      if (label) label.textContent = String(count);
      if (selectAll) selectAll.checked = this._members.length > 0 && this._members.every(member => this._selectedMembers.has(Number(member.id)));
    };
    pane.querySelectorAll('[data-member-select]').forEach(checkbox => {
      checkbox.checked = this._selectedMembers.has(Number(checkbox.dataset.memberSelect));
      checkbox.addEventListener('change', () => {
        const id = Number(checkbox.dataset.memberSelect);
        if (checkbox.checked) this._selectedMembers.add(id);
        else this._selectedMembers.delete(id);
        sync();
      });
    });
    selectAll?.addEventListener('change', () => {
      for (const member of this._members) {
        if (selectAll.checked) this._selectedMembers.add(Number(member.id));
        else this._selectedMembers.delete(Number(member.id));
      }
      pane.querySelectorAll('[data-member-select]').forEach(checkbox => { checkbox.checked = selectAll.checked; });
      sync();
    });
    sync();
  }

  async bulkMemberAction(operation) {
    const ids = [...this._selectedMembers];
    if (!ids.length) return;
    if (operation === 'offboard' && !window.confirm(`离岗停用已选 ${ids.length} 位成员？将永久暂停并禁用其全部 Key。`)) return;
    try {
      const result = await this._request('/api/admin/policy-members/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, operation, duration_seconds: operation === 'suspend' ? 86400 : undefined, reason: '批量操作' }),
      });
      const failed = (result.results || []).filter(item => !item.ok);
      this.toast(failed.length ? `完成，${failed.length} 位失败` : `已处理 ${ids.length} 位成员`, failed.length ? 'warning' : 'success');
      this._selectedMembers.clear();
      await this.loadMembers();
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async _handleMemberAction(action, userId, name) {
    try {
      if (action === 'resume') {
        await this._request(`/api/admin/policy-members/${userId}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        this.toast('成员已恢复');
        await this.loadMembers();
        return;
      }
      if (action === 'bypass') {
        const row = (this._members || []).find(item => Number(item.id) === userId);
        await this._request(`/api/admin/policy-members/${userId}/bypass`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !row?.policy_bypass }),
        });
        this.toast(row?.policy_bypass ? '已关闭策略豁免' : '已开启策略豁免');
        await this.loadMembers();
        return;
      }
      if (action === 'suspend') this.openSuspendDialog(userId, name);
      if (action === 'effective') this.openEffectiveDialog(userId, name);
      if (action === 'detail') this.openMemberDetail(userId, name);
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  openSuspendDialog(userId, name) {
    const dialog = Dialog.showModal({
      title: `暂停成员「${name}」`,
      width: 'min(560px, 96vw)',
      content: `
        <div class="policy-editor-grid">
          <label class="blora-field"><span class="blora-field__label">暂停时长</span>
            <select class="blora-select" id="suspendDuration">
              <option value="3600">1 小时</option>
              <option value="86400" selected>24 小时</option>
              <option value="604800">7 天</option>
              <option value="2592000">30 天</option>
              <option value="0">永久</option>
            </select>
          </label>
          <label class="blora-field"><span class="blora-field__label">范围</span>
            <select class="blora-select" id="suspendScope">
              <option value="all">网关 + 控制台</option>
              <option value="api">仅网关 API</option>
            </select>
          </label>
        </div>
        <label class="blora-field"><span class="blora-field__label">原因</span>
          <textarea class="blora-textarea" id="suspendReason" rows="3" placeholder="例如：违反团队客户端使用规范"></textarea>
        </label>
        <label class="policy-check"><input type="checkbox" id="suspendNotify" checked> 通知该成员</label>
      `,
      footer: `
        <button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>取消</button>
        <button type="button" class="blora-button" data-variant="danger" id="suspendConfirm">确认暂停</button>
      `,
    });
    dialog.element.querySelector('#suspendConfirm')?.addEventListener('click', async () => {
      try {
        const seconds = Number(dialog.element.querySelector('#suspendDuration').value);
        await this._request(`/api/admin/policy-members/${userId}/suspend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            duration_seconds: seconds > 0 ? seconds : undefined,
            reason: dialog.element.querySelector('#suspendReason').value,
            scope: dialog.element.querySelector('#suspendScope').value,
            notify: dialog.element.querySelector('#suspendNotify').checked,
          }),
        });
        this.toast('成员已暂停');
        dialog.close('suspended');
        await this.loadMembers();
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });
  }

  async openMemberDetail(userId, name) {
    try {
      const [effective, logins] = await Promise.all([
        this._request(`/api/admin/policies/effective?user_id=${userId}`),
        this._request(`/api/admin/policy-login-events?user_id=${userId}&limit=30`).catch(() => []),
      ]);
      const dialog = Dialog.showModal({
        title: `成员详情「${name}」`,
        width: 'min(900px, 96vw)',
        content: `
          <div class="policy-effective">
            <p class="policy-summary">执行模式：${this.esc(effective.settings?.enforcement_mode || 'enforce')} · 生效策略 ${(effective.policies || []).length} 条 · 豁免 ${(effective.exemptions || []).length} 条</p>
            <h4>生效策略</h4>
            <div class="blora-table-wrap"><table class="blora-table">
              <thead><tr><th>名称</th><th>作用域</th><th>效果</th><th>动作</th><th>条件</th></tr></thead>
              <tbody>${(effective.policies || []).map(policy => `<tr><td>${this.esc(policy.name)}</td><td>${this.esc(policy.scope_type)}</td><td>${this.esc(policy.effect)}</td><td>${this.esc(policy.action)}</td><td>${this.esc(this._conditionSummary(policy.conditions || {}))}</td></tr>`).join('') || '<tr><td colspan="5" class="policy-empty">无</td></tr>'}</tbody>
            </table></div>
            <h4>最近登录</h4>
            <div class="blora-table-wrap"><table class="blora-table">
              <thead><tr><th>时间</th><th>方式</th><th>结果</th><th>MFA</th><th>IP</th><th>原因</th></tr></thead>
              <tbody>${(logins || []).map(event => `<tr><td>${this.fmt(event.created_at)}</td><td>${this.esc(event.method || '-')}</td><td>${event.success ? '成功' : '失败'}</td><td>${event.mfa ? '是' : '否'}</td><td>${this.esc(event.ip || '-')}</td><td>${this.esc(event.reason || '-')}</td></tr>`).join('') || '<tr><td colspan="6" class="policy-empty">暂无登录事件</td></tr>'}</tbody>
            </table></div>
          </div>
        `,
        footer: `
          <button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>
          <button type="button" class="blora-button" data-variant="danger" id="memberOffboardBtn">离岗停用</button>
        `,
      });
      dialog.element.querySelector('#memberOffboardBtn')?.addEventListener('click', async () => {
        if (!window.confirm(`离岗停用「${name}」？将永久暂停并禁用其全部 Key。`)) return;
        try {
          await this._request(`/api/admin/policy-members/${userId}/offboard`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '管理员离岗停用' }),
          });
          this.toast('成员已离岗停用');
          dialog.close('offboarded');
          await this.loadMembers();
        } catch (error) { this.toast(error.message, 'error'); }
      });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async openEffectiveDialog(userId, name) {
    try {
      const data = await this._request(`/api/admin/policies/effective?user_id=${userId}`);
      const policies = data.policies || [];
      Dialog.showModal({
        title: `「${name}」的生效策略`,
        width: 'min(820px, 96vw)',
        content: `
          <div class="policy-effective">
            <p class="policy-summary">执行模式：${this.esc(data.settings?.enforcement_mode || 'enforce')} · 白名单维度：${this.esc((data.settings?.allowlist_dimensions || []).join(', ') || '无')}</p>
            <h4>生效豁免</h4>
            ${(data.exemptions || []).length ? `<ul>${data.exemptions.map(e => `<li>#${e.id} 策略 ${e.policy_id || '全部'}，至 ${this.fmt(e.ends_at) || '永久'}</li>`).join('')}</ul>` : '<p class="policy-empty">无</p>'}
            <h4>策略</h4>
            <div class="blora-table-wrap"><table class="blora-table">
              <thead><tr><th>名称</th><th>作用域</th><th>效果</th><th>动作</th><th>条件</th></tr></thead>
              <tbody>${policies.map(p => `<tr><td>${this.esc(p.name)}</td><td>${this.esc(p.scope_type)}</td><td>${this.esc(p.effect)}</td><td>${this.esc(p.action)}</td><td><code>${this.esc(JSON.stringify(p.conditions))}</code></td></tr>`).join('') || '<tr><td colspan="5">无</td></tr>'}</tbody>
            </table></div>
          </div>
        `,
        footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>',
      });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async openVersions(policyId) {
    try {
      const versions = await this._request(`/api/admin/policies/${policyId}/versions`);
      const dialog = Dialog.showModal({
        title: '策略版本',
        width: 'min(760px, 96vw)',
        content: `
          <div class="blora-table-wrap"><table class="blora-table">
            <thead><tr><th>版本</th><th>变更说明</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>${(versions || []).map(version => `<tr>
              <td>v${version.version}</td>
              <td>${this.esc(version.change_summary || '-')}</td>
              <td>${this.fmt(version.created_at)}</td>
              <td><button type="button" class="blora-button" data-variant="outline" data-size="sm" data-rollback="${version.version}">回滚</button></td>
            </tr>`).join('') || '<tr><td colspan="4" class="policy-empty">暂无版本</td></tr>'}</tbody>
          </table></div>
        `,
        footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>',
      });
      dialog.element.querySelectorAll('[data-rollback]').forEach(button => {
        button.addEventListener('click', async () => {
          if (!window.confirm(`回滚到 v${button.dataset.rollback}？`)) return;
          try {
            await this._request(`/api/admin/policies/${policyId}/rollback/${button.dataset.rollback}`, { method: 'POST' });
            this.toast('已回滚');
            dialog.close('rolledback');
            await this.loadPolicies();
          } catch (error) {
            this.toast(error.message, 'error');
          }
        });
      });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  // ==================== 例外与申诉 ====================

  async loadExemptions() {
    const pane = this.pane('Exemptions');
    if (!pane) return;
    this.loading(pane);
    try {
      const [exemptions, appeals] = await Promise.all([
        this._request('/api/admin/policy-exemptions?limit=100'),
        this._request('/api/admin/policy-appeals?limit=100'),
      ]);
      pane.innerHTML = `
        <section class="policy-card">
          <div class="policy-card-head"><h3>临时豁免</h3>
            <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="createExemptionBtn">新建豁免</button>
          </div>
          <div class="blora-table-wrap"><table class="blora-table">
            <thead><tr><th>主体</th><th>策略</th><th>原因</th><th>到期</th><th>次数</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${(exemptions.items || []).map(item => `<tr>
              <td>${this.esc(item.subject_type)} · ${this.esc(item.username || item.subject_id)}</td>
              <td>${this.esc(item.policy_name || '全部策略')}</td>
              <td>${this.esc(item.reason || '-')}</td>
              <td>${item.ends_at ? this.fmt(item.ends_at) : '永久'}</td>
              <td>${item.used_count || 0}${item.max_uses ? ` / ${item.max_uses}` : ''}</td>
              <td>${item.status === 'active' ? '<span class="blora-badge" data-variant="success">生效</span>' : `<span class="blora-badge" data-variant="neutral">${this.esc(item.status)}</span>`}</td>
              <td>${item.status === 'active' ? `<button type="button" class="blora-button" data-variant="outline" data-size="sm" data-exemption-revoke="${item.id}">撤销</button>` : '-'}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="policy-empty">暂无豁免</td></tr>'}</tbody>
          </table></div>
        </section>
        <section class="policy-card">
          <div class="policy-card-head"><h3>成员申诉</h3></div>
          <div class="blora-table-wrap"><table class="blora-table">
            <thead><tr><th>成员</th><th>策略</th><th>原因</th><th>SLA</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${(appeals.items || []).map(item => `<tr>
              <td>${this.esc(item.username || item.user_id)}</td>
              <td>${this.esc(item.policy_name || '-')}</td>
              <td>${this.esc(item.reason || '-')}</td>
              <td>${item.sla_due_at ? this.fmt(item.sla_due_at) : '-'}</td>
              <td>${item.status === 'pending' ? '<span class="blora-badge" data-variant="warning">待处理</span>' : `<span class="blora-badge" data-variant="neutral">${this.esc(item.status)}</span>`}</td>
              <td class="policy-row-actions">${item.status === 'pending' ? `
                <button type="button" class="blora-button" data-variant="primary" data-size="sm" data-appeal-decide="approve" data-id="${item.id}">通过</button>
                <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-appeal-decide="reject" data-id="${item.id}">驳回</button>` : '-'}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="policy-empty">暂无申诉</td></tr>'}</tbody>
          </table></div>
        </section>
      `;
      pane.querySelector('#createExemptionBtn')?.addEventListener('click', () => this.openExemptionDialog());
      pane.querySelectorAll('[data-exemption-revoke]').forEach(button => {
        button.addEventListener('click', async () => {
          try {
            await this._request(`/api/admin/policy-exemptions/${button.dataset.exemptionRevoke}`, { method: 'DELETE' });
            this.toast('豁免已撤销');
            await this.loadExemptions();
          } catch (error) { this.toast(error.message, 'error'); }
        });
      });
      pane.querySelectorAll('[data-appeal-decide]').forEach(button => {
        button.addEventListener('click', async () => {
          try {
            await this._request(`/api/admin/policy-appeals/${button.dataset.id}/decide`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: button.dataset.appealDecide }),
            });
            this.toast(button.dataset.appealDecide === 'approve' ? '申诉已通过并生成豁免' : '申诉已驳回');
            await this.loadExemptions();
          } catch (error) { this.toast(error.message, 'error'); }
        });
      });
    } catch (error) {
      this.error(pane, error);
    }
  }

  openExemptionDialog() {
    const dialog = Dialog.showModal({
      title: '新建策略豁免',
      width: 'min(560px, 96vw)',
      content: `
        <div class="policy-editor-grid">
          <label class="blora-field"><span class="blora-field__label">主体类型</span>
            <select class="blora-select" id="exSubjectType"><option value="user">成员</option><option value="team">Team</option><option value="api_key">API Key</option></select>
          </label>
          <label class="blora-field"><span class="blora-field__label">主体 ID</span><input class="blora-input" type="number" id="exSubjectId"></label>
          <label class="blora-field"><span class="blora-field__label">策略 ID（留空=全部）</span><input class="blora-input" type="number" id="exPolicyId"></label>
          <label class="blora-field"><span class="blora-field__label">有效小时数（留空=永久）</span><input class="blora-input" type="number" id="exHours" value="24"></label>
          <label class="blora-field"><span class="blora-field__label">最大使用次数（留空=不限）</span><input class="blora-input" type="number" id="exMaxUses"></label>
        </div>
        <label class="blora-field"><span class="blora-field__label">原因</span><textarea class="blora-textarea" id="exReason" rows="3"></textarea></label>
      `,
      footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>取消</button><button type="button" class="blora-button" data-variant="primary" id="exCreate">创建</button>',
    });
    dialog.element.querySelector('#exCreate')?.addEventListener('click', async () => {
      try {
        const hours = Number(dialog.element.querySelector('#exHours').value);
        await this._request('/api/admin/policy-exemptions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject_type: dialog.element.querySelector('#exSubjectType').value,
            subject_id: Number(dialog.element.querySelector('#exSubjectId').value),
            policy_id: dialog.element.querySelector('#exPolicyId').value ? Number(dialog.element.querySelector('#exPolicyId').value) : null,
            ends_at: hours > 0 ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null,
            max_uses: dialog.element.querySelector('#exMaxUses').value ? Number(dialog.element.querySelector('#exMaxUses').value) : null,
            reason: dialog.element.querySelector('#exReason').value,
          }),
        });
        this.toast('豁免已创建');
        dialog.close('created');
        await this.loadExemptions();
      } catch (error) { this.toast(error.message, 'error'); }
    });
  }

  // ==================== 审批中心 ====================

  async loadApprovals() {
    const pane = this.pane('Approvals');
    if (!pane) return;
    this.loading(pane);
    try {
      const data = await this._request('/api/admin/policy-approvals?limit=100');
      pane.innerHTML = `
        <div class="blora-table-wrap"><table class="blora-table">
          <thead><tr><th>类型</th><th>策略</th><th>申请人</th><th>预览</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>${(data.items || []).map(item => `<tr>
            <td>${item.kind === 'request' ? '运行时放行' : '策略变更'}</td>
            <td>${this.esc(item.policy_name || item.policy_id || '-')}</td>
            <td>${this.esc(item.requested_by_name || '-')}</td>
            <td><code class="policy-desc">${this.esc(JSON.stringify(item.preview || {}))}</code></td>
            <td>${item.status === 'pending' ? '<span class="blora-badge" data-variant="warning">待审批</span>' : `<span class="blora-badge" data-variant="neutral">${this.esc(item.status)}</span>`}</td>
            <td>${this.fmt(item.created_at)}</td>
            <td class="policy-row-actions">${item.status === 'pending' ? `
              <button type="button" class="blora-button" data-variant="primary" data-size="sm" data-approval="approve" data-id="${item.id}">通过</button>
              <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-approval="reject" data-id="${item.id}">驳回</button>` : '-'}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="policy-empty">暂无审批</td></tr>'}</tbody>
        </table></div>
        <p class="policy-summary">共 ${data.total || 0} 条</p>
      `;
      pane.querySelectorAll('[data-approval]').forEach(button => {
        button.addEventListener('click', async () => {
          try {
            await this._request(`/api/admin/policy-approvals/${button.dataset.id}/decide`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: button.dataset.approval }),
            });
            this.toast(button.dataset.approval === 'approve' ? '审批已通过' : '审批已驳回');
            await this.loadApprovals();
          } catch (error) { this.toast(error.message, 'error'); }
        });
      });
    } catch (error) {
      this.error(pane, error);
    }
  }

  // ==================== 通知与分析 ====================

  async loadAnalytics() {
    const pane = this.pane('Analytics');
    if (!pane) return;
    this.loading(pane);
    try {
      const isGlobalAdmin = this.host?.user?.isAdmin === true;
      const [analytics, channels, rules] = await Promise.all([
        this._request('/api/admin/policies/analytics?range=7d&group_by=policy'),
        isGlobalAdmin ? this._request('/api/admin/policy-channels') : Promise.resolve([]),
        isGlobalAdmin ? this._request('/api/admin/policy-alert-rules') : Promise.resolve([]),
      ]);
      const totals = analytics.totals || {};
      const maxHits = Math.max(1, ...(analytics.rows || []).map(row => Number(row.hits) || 0));
      pane.innerHTML = `
        <div class="policy-quick-actions" style="margin-bottom:12px;">
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" id="policyReportBtn">下载审计报告</button>
        </div>
        <div class="policy-stat-grid">
          ${this._statCard('7d 命中', totals.hits || 0, '策略命中总数')}
          ${this._statCard('7d 拦截', totals.blocked || 0, 'decision=block')}
          ${this._statCard('涉及成员', totals.members || 0, '去重成员数')}
          ${this._statCard('平均耗时', `${Number(totals.avg_eval_ms || 0).toFixed(2)} ms`, '策略评估耗时')}
        </div>
        <section class="policy-card">
          <h3>Top 策略</h3>
          ${(analytics.rows || []).map(row => `<div class="policy-bar-row">
            <span>${this.esc(row.policy_name || row.group || '-')}</span>
            <div class="policy-bar"><span style="width:${Math.round((Number(row.hits) || 0) / maxHits * 100)}%"></span></div>
            <strong>${row.hits}</strong>
          </div>`).join('') || '<p class="policy-empty">暂无数据</p>'}
        </section>
        <section class="policy-card">
          <div class="policy-card-head"><h3>通知渠道</h3>
            <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="addChannelBtn">新建渠道</button>
          </div>
          <div class="blora-table-wrap"><table class="blora-table">
            <thead><tr><th>名称</th><th>类型</th><th>最低级别</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${(channels || []).map(channel => `<tr>
              <td>${this.esc(channel.name)}</td><td>${this.esc(channel.type)}</td>
              <td>${this.esc(channel.min_severity)}</td>
              <td>${channel.enabled ? '<span class="blora-badge" data-variant="success">启用</span>' : '<span class="blora-badge" data-variant="neutral">停用</span>'}</td>
              <td class="policy-row-actions">
                <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-channel-test="${channel.id}">测试</button>
                <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-channel-delete="${channel.id}">删除</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="5" class="policy-empty">暂无渠道</td></tr>'}</tbody>
          </table></div>
        </section>
        <section class="policy-card">
          <div class="policy-card-head"><h3>告警规则</h3>
            <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="addRuleBtn">新建规则</button>
          </div>
          <div class="blora-table-wrap"><table class="blora-table">
            <thead><tr><th>名称</th><th>事件</th><th>级别</th><th>渠道</th><th>静默</th><th>操作</th></tr></thead>
            <tbody>${(rules || []).map(rule => `<tr>
              <td>${this.esc(rule.name)}</td><td>${this.esc(rule.event_type)}</td><td>${this.esc(rule.severity)}</td>
              <td>${(rule.channel_ids || []).join(', ') || '-'}</td><td>${rule.silence_window_seconds}s</td>
              <td><button type="button" class="blora-button" data-variant="outline" data-size="sm" data-rule-delete="${rule.id}">删除</button></td>
            </tr>`).join('') || '<tr><td colspan="6" class="policy-empty">暂无规则</td></tr>'}</tbody>
          </table></div>
        </section>
      `;
      if (!isGlobalAdmin) {
        pane.querySelectorAll('.policy-card').forEach(card => {
          const title = card.querySelector('h3')?.textContent || '';
          if (title.includes('通知渠道') || title.includes('告警规则')) card.style.display = 'none';
        });
      }
      pane.querySelector('#addChannelBtn')?.addEventListener('click', () => this.openChannelDialog());
      pane.querySelector('#policyReportBtn')?.addEventListener('click', async () => {
        try {
          const report = await this._request('/api/admin/policies/report?range=30d');
          const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `crewrouter-policy-report-${new Date().toISOString().slice(0, 10)}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { this.toast(error.message, 'error'); }
      });
      pane.querySelector('#addRuleBtn')?.addEventListener('click', () => this.openRuleDialog(channels || []));
      pane.querySelectorAll('[data-channel-test]').forEach(button => {
        button.addEventListener('click', async () => {
          try {
            const result = await this._request(`/api/admin/policy-channels/${button.dataset.channelTest}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            this.toast(result.ok ? `测试成功（${result.latency_ms}ms）` : `测试失败：${result.error}`, result.ok ? 'success' : 'error');
          } catch (error) { this.toast(error.message, 'error'); }
        });
      });
      pane.querySelectorAll('[data-channel-delete]').forEach(button => {
        button.addEventListener('click', async () => {
          if (!window.confirm('删除该渠道？')) return;
          try {
            await this._request(`/api/admin/policy-channels/${button.dataset.channelDelete}`, { method: 'DELETE' });
            await this.loadAnalytics();
          } catch (error) { this.toast(error.message, 'error'); }
        });
      });
      pane.querySelectorAll('[data-rule-delete]').forEach(button => {
        button.addEventListener('click', async () => {
          try {
            await this._request(`/api/admin/policy-alert-rules/${button.dataset.ruleDelete}`, { method: 'DELETE' });
            await this.loadAnalytics();
          } catch (error) { this.toast(error.message, 'error'); }
        });
      });
    } catch (error) {
      this.error(pane, error);
    }
  }

  openChannelDialog() {
    const dialog = Dialog.showModal({
      title: '新建通知渠道',
      width: 'min(600px, 96vw)',
      content: `
        <div class="policy-editor-grid">
          <label class="blora-field"><span class="blora-field__label">名称</span><input class="blora-input" id="chName"></label>
          <label class="blora-field"><span class="blora-field__label">类型</span>
            <select class="blora-select" id="chType">
              ${['webhook','feishu','wecom','dingtalk','slack','telegram','email','bark','syslog','otlp'].map(value => `<option value="${value}">${value}</option>`).join('')}
            </select>
          </label>
          <label class="blora-field"><span class="blora-field__label">最低级别</span>
            <select class="blora-select" id="chSeverity"><option value="info">info</option><option value="warning" selected>warning</option><option value="critical">critical</option></select>
          </label>
        </div>
        <label class="blora-field"><span class="blora-field__label">Webhook / 机器人 URL</span><input class="blora-input" id="chUrl" placeholder="https://..."></label>
        <div class="policy-editor-grid">
          <label class="blora-field"><span class="blora-field__label">Secret / Token / Key</span><input class="blora-input" id="chSecret"></label>
          <label class="blora-field"><span class="blora-field__label">邮件收件人</span><input class="blora-input" id="chTo"></label>
          <label class="blora-field"><span class="blora-field__label">Telegram chat_id</span><input class="blora-input" id="chChat"></label>
          <label class="blora-field"><span class="blora-field__label">Syslog host</span><input class="blora-input" id="chHost"></label>
          <label class="blora-field"><span class="blora-field__label">Syslog 端口</span><input class="blora-input" type="number" id="chPort" value="514"></label>
        </div>
        <p class="policy-hint">Secret 会加密存储；URL 必须通过 SSRF 校验。</p>
      `,
      footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>取消</button><button type="button" class="blora-button" data-variant="primary" id="chCreate">创建</button>',
    });
    dialog.element.querySelector('#chCreate')?.addEventListener('click', async () => {
      try {
        const config = {};
        const url = dialog.element.querySelector('#chUrl').value.trim();
        const secret = dialog.element.querySelector('#chSecret').value.trim();
        const to = dialog.element.querySelector('#chTo').value.trim();
        const chat = dialog.element.querySelector('#chChat').value.trim();
        if (url) config.url = url;
        if (secret) config.secret = secret;
        if (to) config.to = to;
        if (chat) config.chat_id = chat;
        const host = dialog.element.querySelector('#chHost').value.trim();
        const port = Number(dialog.element.querySelector('#chPort').value) || 514;
        if (host) { config.host = host; config.port = port; }
        await this._request('/api/admin/policy-channels', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: dialog.element.querySelector('#chName').value,
            type: dialog.element.querySelector('#chType').value,
            min_severity: dialog.element.querySelector('#chSeverity').value,
            config,
          }),
        });
        this.toast('渠道已创建');
        dialog.close('created');
        await this.loadAnalytics();
      } catch (error) { this.toast(error.message, 'error'); }
    });
  }

  openRuleDialog(channels) {
    const dialog = Dialog.showModal({
      title: '新建告警规则',
      width: 'min(600px, 96vw)',
      content: `
        <div class="policy-editor-grid">
          <label class="blora-field"><span class="blora-field__label">名称</span><input class="blora-input" id="ruleName" value="策略告警"></label>
          <label class="blora-field"><span class="blora-field__label">事件</span>
            <select class="blora-select" id="ruleEvent"><option value="hit">hit</option><option value="block">block</option><option value="suspend">suspend</option><option value="approval">approval</option><option value="appeal">appeal</option><option value="*">全部</option></select>
          </label>
          <label class="blora-field"><span class="blora-field__label">级别</span>
            <select class="blora-select" id="ruleSeverity"><option value="info">info</option><option value="warning" selected>warning</option><option value="critical">critical</option></select>
          </label>
          <label class="blora-field"><span class="blora-field__label">静默秒数</span><input class="blora-input" type="number" id="ruleSilence" value="300"></label>
        </div>
        <fieldset class="policy-dimensions"><legend>发送渠道</legend>
          ${(channels || []).map(channel => `<label class="policy-check"><input type="checkbox" data-rule-channel="${channel.id}"> ${this.esc(channel.name)}（${this.esc(channel.type)}）</label>`).join('') || '<p class="policy-hint">请先创建渠道</p>'}
        </fieldset>
      `,
      footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>取消</button><button type="button" class="blora-button" data-variant="primary" id="ruleCreate">创建</button>',
    });
    dialog.element.querySelector('#ruleCreate')?.addEventListener('click', async () => {
      try {
        const channelIds = [...dialog.element.querySelectorAll('[data-rule-channel]')].filter(input => input.checked).map(input => Number(input.dataset.ruleChannel));
        await this._request('/api/admin/policy-alert-rules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: dialog.element.querySelector('#ruleName').value,
            event_type: dialog.element.querySelector('#ruleEvent').value,
            severity: dialog.element.querySelector('#ruleSeverity').value,
            silence_window_seconds: Number(dialog.element.querySelector('#ruleSilence').value),
            channel_ids: channelIds,
          }),
        });
        this.toast('规则已创建');
        dialog.close('created');
        await this.loadAnalytics();
      } catch (error) { this.toast(error.message, 'error'); }
    });
  }

  async openLoginEvents() {
    try {
      const events = await this._request('/api/admin/policy-login-events?limit=100');
      Dialog.showModal({
        title: '登录事件',
        width: 'min(820px, 96vw)',
        content: `<div class="blora-table-wrap"><table class="blora-table">
          <thead><tr><th>时间</th><th>成员</th><th>方式</th><th>结果</th><th>MFA</th><th>IP</th><th>原因</th></tr></thead>
          <tbody>${(events || []).map(event => `<tr>
            <td>${this.fmt(event.created_at)}</td>
            <td>${this.esc(event.username || event.user_id || '-')}</td>
            <td>${this.esc(event.method || '-')}</td>
            <td>${event.success ? '<span class="blora-badge" data-variant="success">成功</span>' : '<span class="blora-badge" data-variant="danger">失败</span>'}</td>
            <td>${event.mfa ? '是' : '否'}</td>
            <td>${this.esc(event.ip || '-')}</td>
            <td>${this.esc(event.reason || '-')}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="policy-empty">暂无登录事件</td></tr>'}</tbody>
        </table></div>`,
        footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>',
      });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  // ==================== 客户端 ====================

  async loadClients() {
    const pane = this.pane('Clients');
    if (!pane) return;
    this.loading(pane);
    try {
      const data = await this._request('/api/admin/policy-clients?range=24h');
      pane.innerHTML = `
        <p class="policy-hint">客户端识别依赖请求头与提示词指纹；自定义提示词或 UA 可能被识别为 unknown。建议先观察再禁止。</p>
        <div class="blora-table-wrap">
          <table class="blora-table">
            <thead><tr><th>客户端</th><th>24h 请求</th><th>Token</th><th>命中</th><th>拦截</th><th>操作</th></tr></thead>
            <tbody>${(data.items || []).map(item => `<tr>
              <td><strong>${this.esc(item.label)}</strong><div class="policy-desc">${this.esc(item.request_source)}</div></td>
              <td>${item.requests || 0}</td><td>${item.tokens || 0}</td><td>${item.hits || 0}</td><td>${item.blocked || 0}</td>
              <td><button type="button" class="blora-button" data-variant="outline" data-size="sm" data-client-block="${this.esc(item.request_source)}">禁止该客户端</button></td>
            </tr>`).join('') || `<tr><td colspan="6" class="policy-empty">${this.esc(this.t('暂无客户端数据'))}</td></tr>`}</tbody>
          </table>
        </div>
      `;
      pane.querySelectorAll('[data-client-block]').forEach(button => {
        button.addEventListener('click', () => this.openClientBlockDialog(button.dataset.clientBlock));
      });
    } catch (error) {
      this.error(pane, error);
    }
  }

  openClientBlockDialog(source) {
    const dialog = Dialog.showModal({
      title: `禁止客户端「${source}」`,
      width: 'min(560px, 96vw)',
      content: `
        <label class="blora-field"><span class="blora-field__label">作用域</span>
          <select class="blora-select" id="cbScopeType">
            <option value="team">Team</option><option value="global">全局</option><option value="member">成员</option>
          </select>
        </label>
        <label class="blora-field"><span class="blora-field__label">作用对象</span>
          <select class="blora-select" id="cbScopeId"></select>
        </label>
        <p class="policy-hint">条件：{"clients":["${this.esc(source)}"]}</p>
      `,
      footer: `
        <button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>取消</button>
        <button type="button" class="blora-button" data-variant="danger" id="cbConfirm">创建禁止策略</button>
      `,
    });
    const el = dialog.element;
    const type = el.querySelector('#cbScopeType');
    const scope = el.querySelector('#cbScopeId');
    const refresh = () => {
      if (type.value === 'global') { scope.innerHTML = '<option value="">全局</option>'; scope.disabled = true; return; }
      scope.disabled = false;
      const list = type.value === 'team' ? this._teams : this._users;
      scope.innerHTML = list.map(item => `<option value="${item.id}">${this.esc(item.name || item.username)}</option>`).join('');
    };
    type.addEventListener('change', refresh);
    refresh();
    el.querySelector('#cbConfirm')?.addEventListener('click', async () => {
      try {
        await this._request('/api/admin/policies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `禁止使用 ${source}`,
            description: `由客户端管控一键创建：禁止 ${source} 客户端请求。`,
            scope_type: type.value,
            scope_id: type.value === 'global' ? null : Number(scope.value),
            effect: 'deny', action: 'block', priority: 900, category: 'client',
            status_code: 403, conditions: { clients: [source] }, enabled: true, status: 'published',
          }),
        });
        this.toast('禁止策略已创建');
        dialog.close('created');
        await this.loadPolicies();
        await this.switchTab('policies');
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });
  }

  // ==================== 命中记录 ====================

  async loadHits() {
    const pane = this.pane('Hits');
    if (!pane) return;
    this.loading(pane);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (this._hitFilters.request_source) params.set('request_source', this._hitFilters.request_source);
      if (this._hitFilters.decision) params.set('decision', this._hitFilters.decision);
      if (this._hitFilters.q) params.set('q', this._hitFilters.q);
      if (this._hitFilters.range !== 'all') {
        const hours = this._hitFilters.range === '7d' ? 168 : this._hitFilters.range === '30d' ? 720 : 24;
        params.set('from', new Date(Date.now() - hours * 3600 * 1000).toISOString());
      }
      const [data, clients] = await Promise.all([
        this._request(`/api/admin/policy-hits?${params.toString()}`),
        this._request('/api/admin/policy-clients?range=7d').catch(() => ({ items: [] })),
      ]);
      pane.innerHTML = `
        <div class="policy-filter-bar">
          <input type="search" class="blora-input" id="hitSearch" placeholder="搜索成员或策略" value="${this.esc(this._hitFilters.q)}">
          <select class="blora-select" id="hitSourceFilter">
            <option value="">全部客户端</option>
            ${(clients.items || []).map(item => `<option value="${this.esc(item.request_source)}" ${this._hitFilters.request_source === item.request_source ? 'selected' : ''}>${this.esc(item.label)}</option>`).join('')}
          </select>
          <select class="blora-select" id="hitDecisionFilter">
            <option value="">全部结果</option>
            <option value="block" ${this._hitFilters.decision === 'block' ? 'selected' : ''}>拦截</option>
            <option value="allow" ${this._hitFilters.decision === 'allow' ? 'selected' : ''}>放行/观察</option>
          </select>
          <select class="blora-select" id="hitRangeFilter">
            <option value="24h" ${this._hitFilters.range === '24h' ? 'selected' : ''}>最近 24 小时</option>
            <option value="7d" ${this._hitFilters.range === '7d' ? 'selected' : ''}>最近 7 天</option>
            <option value="30d" ${this._hitFilters.range === '30d' ? 'selected' : ''}>最近 30 天</option>
            <option value="all" ${this._hitFilters.range === 'all' ? 'selected' : ''}>全部</option>
          </select>
        </div>
        <div class="blora-table-wrap">
          <table class="blora-table">
            <thead><tr><th>时间</th><th>策略</th><th>成员</th><th>客户端</th><th>模型</th><th>IP</th><th>动作</th><th>结果</th><th>详情</th></tr></thead>
            <tbody>${(data.items || []).map(hit => `<tr>
              <td>${this.fmt(hit.created_at)}</td>
              <td>${this.esc(hit.policy_name || (hit.reason === 'member_suspended' ? '成员暂停' : '-'))}</td>
              <td>${this.esc(hit.username || hit.user_id || '-')}</td>
              <td>${this.esc(hit.request_source || '-')}</td>
              <td>${this.esc(hit.requested_model || '-')}</td>
              <td>${this.esc(hit.ip || '-')}</td>
              <td>${this.esc(hit.action)}</td>
              <td>${hit.decision === 'block' ? '<span class="blora-badge" data-variant="danger">拦截</span>' : '<span class="blora-badge" data-variant="neutral">放行</span>'}</td>
              <td><button type="button" class="blora-button" data-variant="outline" data-size="sm" data-hit-detail="${hit.id}">查看</button></td>
            </tr>`).join('') || `<tr><td colspan="9" class="policy-empty">${this.esc(this.t('暂无命中记录'))}</td></tr>`}</tbody>
          </table>
        </div>
        <p class="policy-summary">共 ${data.total || 0} 条记录</p>
      `;
      let timer = null;
      pane.querySelector('#hitSearch')?.addEventListener('input', event => {
        clearTimeout(timer);
        timer = setTimeout(() => { this._hitFilters.q = event.target.value.trim(); this.loadHits(); }, 300);
      });
      pane.querySelector('#hitSourceFilter')?.addEventListener('change', event => { this._hitFilters.request_source = event.target.value; this.loadHits(); });
      pane.querySelector('#hitDecisionFilter')?.addEventListener('change', event => { this._hitFilters.decision = event.target.value; this.loadHits(); });
      pane.querySelector('#hitRangeFilter')?.addEventListener('change', event => { this._hitFilters.range = event.target.value; this.loadHits(); });
      pane.querySelectorAll('[data-hit-detail]').forEach(button => {
        button.addEventListener('click', async () => {
          try {
            const hit = await this._request(`/api/admin/policy-hits/${button.dataset.hitDetail}`);
            Dialog.showModal({
              title: '命中详情',
              width: 'min(760px, 96vw)',
              content: `<pre class="policy-json">${this.esc(JSON.stringify(hit, null, 2))}</pre>`,
              footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>',
            });
          } catch (error) {
            this.toast(error.message, 'error');
          }
        });
      });
    } catch (error) {
      this.error(pane, error);
    }
  }

  // ==================== 设置 ====================

  async loadSettings() {
    const pane = this.pane('Settings');
    if (!pane) return;
    this.loading(pane);
    try {
      const data = await this._request('/api/admin/policy-settings');
      const settings = data.global || {};
      this._settings = data;
      const dimensions = new Set(settings.allowlist_dimensions || []);
      pane.innerHTML = `
        <div class="policy-settings-grid">
          <label class="blora-field"><span class="blora-field__label">执行模式</span>
            <select class="blora-select" id="psMode">
              <option value="enforce" ${settings.enforcement_mode !== 'shadow' ? 'selected' : ''}>强制执行</option>
              <option value="shadow" ${settings.enforcement_mode === 'shadow' ? 'selected' : ''}>观察模式（只记录）</option>
            </select>
          </label>
          <label class="blora-field"><span class="blora-field__label">失败模式</span>
            <select class="blora-select" id="psFailMode">
              <option value="open" ${settings.fail_mode !== 'closed' ? 'selected' : ''}>失败放行（open）</option>
              <option value="closed" ${settings.fail_mode === 'closed' ? 'selected' : ''}>失败拒绝（closed）</option>
            </select>
          </label>
          <label class="blora-field"><span class="blora-field__label">命中保留天数</span>
            <input class="blora-input" type="number" id="psRetention" min="1" max="3650" value="${settings.hit_retention_days || 90}">
          </label>
          <label class="blora-field"><span class="blora-field__label">默认时区</span>
            <input class="blora-input" id="psTimezone" value="${this.esc(settings.default_timezone || 'Asia/Shanghai')}">
          </label>
        </div>
        <fieldset class="policy-dimensions">
          <legend>白名单维度（开启后，未匹配到 allow 规则的请求会被拦截）</legend>
          ${['clients','models','providers','ips','protocols'].map(value => `<label class="policy-check"><input type="checkbox" data-dimension="${value}" ${dimensions.has(value) ? 'checked' : ''}> ${value}</label>`).join('')}
        </fieldset>
        <div class="policy-settings-grid">
          <label class="policy-check"><input type="checkbox" id="psNotifyAdmins" ${settings.notify_admins !== false ? 'checked' : ''}> 命中时通知管理员</label>
          <label class="policy-check"><input type="checkbox" id="psNotifyMember" ${settings.notify_member !== false ? 'checked' : ''}> 命中时通知被拦截成员</label>
        </div>
        <div class="policy-quick-actions">
          <button type="button" class="blora-button" data-variant="primary" id="psSaveBtn">保存设置</button>
          ${this.host?.user?.isAdmin === true ? `<button type="button" class="blora-button" data-variant="outline" id="psKillBtn">${settings.kill_switch ? '解除紧急停止' : '紧急停止全部策略'}</button>` : ''}
        </div>
        <p class="policy-hint">紧急停止会立即放行所有请求；恢复后策略重新生效。多进程实例最多 10 秒内感知。</p>
      `;
      pane.querySelector('#psSaveBtn')?.addEventListener('click', async () => {
        try {
          const allowlist = [...pane.querySelectorAll('[data-dimension]')].filter(input => input.checked).map(input => input.dataset.dimension);
          await this._request('/api/admin/policy-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              team_id: this.host?.user?.isAdmin === true ? null : (this._settings?.team?.team_id ?? null),
              enforcement_mode: pane.querySelector('#psMode').value,
              fail_mode: pane.querySelector('#psFailMode').value,
              hit_retention_days: Number(pane.querySelector('#psRetention').value),
              default_timezone: pane.querySelector('#psTimezone').value.trim() || 'Asia/Shanghai',
              allowlist_dimensions: allowlist,
              notify_admins: pane.querySelector('#psNotifyAdmins').checked,
              notify_member: pane.querySelector('#psNotifyMember').checked,
            }),
          });
          this.toast('策略设置已保存');
          await this.loadSettings();
        } catch (error) {
          this.toast(error.message, 'error');
        }
      });
      pane.querySelector('#psKillBtn')?.addEventListener('click', () => this.toggleKillSwitch(settings.kill_switch));
    } catch (error) {
      this.error(pane, error);
    }
  }

  async toggleKillSwitch(current) {
    try {
      const enabled = current === undefined ? !(this._settings?.global?.kill_switch) : !current;
      if (enabled && !window.confirm('紧急停止会立即放行所有请求，确定继续？')) return;
      await this._request('/api/admin/policy-settings/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      this.toast(enabled ? '已紧急停止全部策略' : '已恢复策略执行');
      await this.loadOverview();
      if (this.tab === 'settings') await this.loadSettings();
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  // ==================== 模拟器 ====================

  openSimulator() {
    const dialog = Dialog.showModal({
      title: '策略模拟器',
      width: 'min(720px, 96vw)',
      content: `
        <p class="policy-hint">对单条策略草稿进行匹配预览，不会写入命中记录。</p>
        <label class="blora-field"><span class="blora-field__label">策略条件 JSON</span>
          <textarea class="blora-textarea" id="simConditions" rows="10" spellcheck="false">${this.esc(JSON.stringify({ clients: ['claude_code'] }, null, 2))}</textarea>
        </label>
        <div class="policy-editor-grid">
          <input class="blora-input" id="simClient" value="claude_code" aria-label="客户端">
          <input class="blora-input" id="simModel" value="claude-fable-5" aria-label="模型">
          <input class="blora-input" id="simIp" value="203.0.113.9" aria-label="IP">
          <input class="blora-input" id="simPrompt" value="" placeholder="提示词（可选）" aria-label="提示词">
        </div>
        <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="simRun">运行</button>
        <pre class="policy-preview-result" id="simResult"></pre>
      `,
      footer: '<button type="button" class="blora-button" data-variant="secondary" data-dialog-cancel>关闭</button>',
    });
    const root = dialog.element;
    root.querySelector('#simRun')?.addEventListener('click', async () => {
      const resultEl = root.querySelector('#simResult');
      try {
        const conditions = JSON.parse(root.querySelector('#simConditions').value || '{}');
        const result = await this._request('/api/admin/policies/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            policy: { name: '模拟策略', scope_type: 'team', scope_id: this._teams[0]?.id || 1, effect: 'deny', action: 'block', conditions },
            sample: {
              client: root.querySelector('#simClient').value,
              model: root.querySelector('#simModel').value,
              ip: root.querySelector('#simIp').value,
              prompt: root.querySelector('#simPrompt').value,
              at: new Date().toISOString(),
            },
          }),
        });
        resultEl.textContent = JSON.stringify(result, null, 2);
      } catch (error) {
        resultEl.textContent = error.message;
      }
    });
  }
}

window.AdminPoliciesApp = AdminPoliciesApp;
