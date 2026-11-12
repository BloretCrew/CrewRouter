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
    this._filters = { q: '', scope_type: '', effect: '', enabled: '', category: '' };
    this._hitFilters = { request_source: '', decision: '', range: '24h', q: '' };
    this._memberFilters = { q: '', status: '' };
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

  async mount(root) {
    if (!root) return;
    this.root = root;
    if (!this.mounted) {
      this.mounted = true;
      this._bindTabs();
      await Promise.all([this.loadTeams(), this.loadUsers()]).catch(() => {});
      await this.loadOverview();
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
    const data = await this._request('/api/admin/teams');
    this._teams = Array.isArray(data) ? data.filter(team => !team.is_personal) : [];
  }

  async loadUsers() {
    const data = await this._request('/api/admin/users?page=1&limit=200');
    this._users = Array.isArray(data) ? data : (data.items || []);
  }

  async loadOverview() {
    const pane = this.pane('Overview');
    if (!pane) return;
    this.loading(pane);
    try {
      const [overview, settings] = await Promise.all([
        this._request('/api/admin/policies/overview'),
        this._request('/api/admin/policy-settings'),
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
        <div class="policy-quick-actions">
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-action="templates">从模板创建</button>
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-action="simulate">策略模拟</button>
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-action="kill">${settings.global?.kill_switch ? '解除紧急停止' : '紧急停止全部策略'}</button>
        </div>
      `;
      pane.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', () => {
          const action = button.dataset.action;
          if (action === 'templates') this.openTemplatePicker();
          if (action === 'simulate') this.openSimulator();
          if (action === 'kill') this.toggleKillSwitch();
        });
      });
    } catch (error) {
      this.error(pane, error);
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
    this.loading(pane);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(this._filters)) if (value) params.set(key, value);
      params.set('limit', '100');
      const data = await this._request(`/api/admin/policies?${params.toString()}`);
      const items = data.items || [];
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
          <button type="button" class="blora-button" data-variant="primary" data-size="sm" id="policyCreateBtn">新建策略</button>
          <button type="button" class="blora-button" data-variant="secondary" data-size="sm" id="policyTemplateBtn">从模板创建</button>
        </div>
        <div class="blora-table-wrap">
          <table class="blora-table">
            <thead><tr>
              <th>名称</th><th>作用域</th><th>分类</th><th>效果 / 动作</th><th>优先级</th><th>状态</th><th>24h 命中</th><th>操作</th>
            </tr></thead>
            <tbody>
              ${items.map(policy => this._policyRow(policy)).join('') || `<tr><td colspan="8" class="policy-empty">${this.esc(this.t('暂无策略'))}</td></tr>`}
            </tbody>
          </table>
        </div>
        <p class="policy-summary">共 ${data.total || 0} 条策略</p>
      `;
      this._bindPolicyFilters(pane);
      pane.querySelectorAll('[data-policy-action]').forEach(button => {
        button.addEventListener('click', () => this._handlePolicyAction(button.dataset.policyAction, Number(button.dataset.id)));
      });
    } catch (error) {
      this.error(pane, error);
    }
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
    return `<tr>
      <td><strong>${this.esc(policy.name)}</strong>${policy.description ? `<div class="policy-desc">${this.esc(policy.description)}</div>` : ''}</td>
      <td>${this.esc(this._scopeLabel(policy))}</td>
      <td>${this.esc(policy.category)}</td>
      <td><span class="blora-badge" data-variant="${policy.effect === 'deny' ? 'danger' : 'success'}">${policy.effect === 'deny' ? '禁止' : '允许'}</span> ${this.esc(actionLabels[policy.action] || policy.action)}</td>
      <td>${policy.priority}</td>
      <td>${policy.enabled ? '<span class="blora-badge" data-variant="success">启用</span>' : '<span class="blora-badge" data-variant="neutral">停用</span>'} ${policy.status !== 'published' ? `<span class="blora-badge" data-variant="warning">${this.esc(policy.status)}</span>` : ''}</td>
      <td>${policy.hits_24h || 0}</td>
      <td class="policy-row-actions">
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="edit" data-id="${policy.id}">编辑</button>
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-policy-action="toggle" data-id="${policy.id}">${policy.enabled ? '停用' : '启用'}</button>
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
      timer = setTimeout(() => { this._filters.q = search.value.trim(); this.loadPolicies(); }, 300);
    });
    pane.querySelector('#policyScopeFilter')?.addEventListener('change', event => { this._filters.scope_type = event.target.value; this.loadPolicies(); });
    pane.querySelector('#policyEffectFilter')?.addEventListener('change', event => { this._filters.effect = event.target.value; this.loadPolicies(); });
    pane.querySelector('#policyEnabledFilter')?.addEventListener('change', event => { this._filters.enabled = event.target.value; this.loadPolicies(); });
    pane.querySelector('#policyCreateBtn')?.addEventListener('click', () => this.openEditor());
    pane.querySelector('#policyTemplateBtn')?.addEventListener('click', () => this.openTemplatePicker());
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

  // ==================== 编辑器 ====================

  openEditor(policy = null) {
    const draft = policy || {
      name: '', description: '', scope_type: 'team', scope_id: this._teams[0]?.id || '',
      effect: 'deny', action: 'block', priority: 100, category: 'combined',
      conditions: {}, action_options: {}, ladder: [], status_code: 403,
      notify_channels: { inapp: true, webhook: false, email: false }, enabled: true,
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
          <label class="blora-field"><span class="blora-field__label">条件 JSON</span>
            <textarea class="blora-textarea" id="peConditions" rows="10" spellcheck="false">${this.esc(JSON.stringify(draft.conditions || {}, null, 2))}</textarea>
          </label>
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
      action_options: parseJson('#peOptions', {}),
      ladder: parseJson('#peLadder', []),
      notify_channels: { inapp: true, webhook: el.querySelector('#peWebhook').checked, email: false },
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      enabled: el.querySelector('#peEnabled').checked,
    };
    if (forSave) payload.status = 'published';
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
        </div>
        <div class="blora-table-wrap">
          <table class="blora-table">
            <thead><tr><th>成员</th><th>Team</th><th>状态</th><th>暂停至</th><th>生效策略</th><th>24h 命中</th><th>最近命中</th><th>操作</th></tr></thead>
            <tbody>
              ${this._members.map(member => this._memberRow(member)).join('') || `<tr><td colspan="8" class="policy-empty">${this.esc(this.t('暂无成员'))}</td></tr>`}
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
    return `<tr>
      <td><strong>${this.esc(member.username)}</strong>${member.is_admin ? ' <span class="blora-badge" data-variant="info">管理员</span>' : ''}<div class="policy-desc">${this.esc(member.email || '')}</div></td>
      <td>${this.esc(member.team_name || member.team_id || '-')}</td>
      <td>${suspended ? '<span class="blora-badge" data-variant="danger">暂停中</span>' : '<span class="blora-badge" data-variant="success">正常</span>'}${member.policy_bypass ? ' <span class="blora-badge" data-variant="warning">策略豁免</span>' : ''}</td>
      <td>${until ? this.fmt(until) : (suspended ? '永久' : '-')}</td>
      <td>${member.policy_count || 0}</td>
      <td>${member.hits_24h || 0}</td>
      <td>${member.last_hit_at ? this.fmt(member.last_hit_at) : '-'}</td>
      <td class="policy-row-actions">
        ${suspended
          ? `<button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="resume" data-id="${member.id}" data-name="${this.esc(member.username)}">恢复</button>`
          : `<button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="suspend" data-id="${member.id}" data-name="${this.esc(member.username)}">暂停</button>`}
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="effective" data-id="${member.id}" data-name="${this.esc(member.username)}">生效策略</button>
        <button type="button" class="blora-button" data-variant="outline" data-size="sm" data-member-action="bypass" data-id="${member.id}" data-name="${this.esc(member.username)}">${member.policy_bypass ? '关闭豁免' : '策略豁免'}</button>
      </td>
    </tr>`;
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
          <button type="button" class="blora-button" data-variant="outline" id="psKillBtn">${settings.kill_switch ? '解除紧急停止' : '紧急停止全部策略'}</button>
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
              team_id: null,
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
