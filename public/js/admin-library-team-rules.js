/* Team quota rules for the shared admin model library. */
(() => {
  'use strict';

  const mounts = new WeakMap();
  const text = value => typeof window.t === 'function' ? window.t(value) : value;
  const element = (tag, content, className) => {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    return node;
  };
  const button = (label, action, variant = 'secondary') => {
    const node = element('button', text(label), 'blora-button');
    node.type = 'button';
    node.dataset.variant = variant;
    node.dataset.size = 'sm';
    node.addEventListener('click', action);
    return node;
  };

  class AdminLibraryTeamRules {
    constructor(host) {
      this.teamId = null;
      this.version = 0;
      this.rules = [];
      if (host) this.mount(host);
    }

    static mount(host, teamId) {
      const instance = mounts.get(host) || new AdminLibraryTeamRules(host);
      if (teamId !== undefined) instance.ready = instance.load(teamId);
      return instance;
    }

    mount(host, teamId) {
      if (!host || typeof host.replaceChildren !== 'function') throw new TypeError('需要有效的 TEAM 规则容器');
      if (this.host) this.destroy();
      const previous = mounts.get(host);
      if (previous && previous !== this) previous.destroy();
      this.host = host;
      mounts.set(host, this);
      this.build();
      if (teamId !== undefined) this.ready = this.load(teamId);
      return this;
    }

    build() {
      const section = element('section', undefined, 'blora-card');
      section.append(element('h3', text('TEAM 限额规则')));
      section.append(element('p', text('规则作用于 TEAM；多个规则同时生效。时间窗口单位为小时。')));
      this.status = element('p');
      this.status.setAttribute('role', 'status');
      this.status.setAttribute('aria-live', 'polite');
      this.retry = button('重试加载', () => this.load(this.teamId));
      this.retry.hidden = true;
      this.list = element('div');
      this.form = element('form');
      this.type = element('select', undefined, 'blora-select');
      this.type.name = 'rule_type';
      [['requests', '请求次数'], ['tokens', 'Token 数量']].forEach(([value, label]) => {
        const option = element('option', text(label));
        option.value = value;
        this.type.append(option);
      });
      this.type.value = 'requests';
      this.value = element('input', undefined, 'blora-input');
      this.value.name = 'rule_value';
      this.duration = element('input', undefined, 'blora-input');
      this.duration.name = 'duration_hours';
      [this.value, this.duration].forEach(input => {
        input.type = 'number';
        input.step = 'any';
        input.required = true;
      });
      [['规则类型', this.type], ['限额（大于 0）', this.value], ['时间窗口（小时，大于 0）', this.duration]].forEach(([title, input]) => {
        const label = element('label', text(title));
        label.append(input);
        this.form.append(label);
      });
      this.addButton = button('添加规则', () => {}, 'primary');
      this.addButton.type = 'submit';
      this.form.append(this.addButton);
      this.form.addEventListener('submit', event => {
        event.preventDefault();
        this.add();
      });
      section.append(this.status, this.retry, this.list, this.form);
      this.host.replaceChildren(section);
      this.setBusy(false);
    }

    isCurrent(version) {
      return this.host && this.version === version && mounts.get(this.host) === this;
    }

    setBusy(busy) {
      this.busy = busy;
      const disabled = busy || !this.teamId || !this.loaded;
      [this.type, this.value, this.duration, this.addButton].forEach(node => { node.disabled = disabled; });
      this.retry.disabled = busy;
      this.list.querySelectorAll('button').forEach(node => { node.disabled = disabled; });
      this.host.setAttribute('aria-busy', String(busy));
    }

    async request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', ...options });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || text('请求失败，请重试'));
      return data;
    }

    endpoint() {
      return `/api/admin/teams/${encodeURIComponent(this.teamId)}/rules`;
    }

    async load(teamId) {
      if (!this.host) throw new Error('请先 mount TEAM 规则容器');
      const nextId = teamId == null ? null : String(teamId);
      const switched = this.teamId !== nextId;
      this.teamId = nextId;
      const version = ++this.version;
      this.controller?.abort();
      this.controller = new AbortController();
      this.loaded = false;
      this.rules = [];
      this.list.replaceChildren();
      if (switched) {
        this.type.value = 'requests';
        this.value.value = '';
        this.duration.value = '';
      }
      this.retry.hidden = true;
      if (!nextId) {
        this.status.textContent = text('请选择 TEAM');
        this.setBusy(false);
        return false;
      }
      this.status.textContent = text('正在加载限额规则…');
      this.setBusy(true);
      try {
        const rules = await this.request(this.endpoint(), { signal: this.controller.signal });
        if (!this.isCurrent(version)) return false;
        if (!Array.isArray(rules)) throw new Error(text('规则响应无效，请重试'));
        this.rules = rules;
        this.loaded = true;
        this.renderRules();
        this.status.textContent = '';
        return true;
      } catch (error) {
        if (!this.isCurrent(version)) return false;
        this.status.textContent = error.message || text('加载失败，请重试');
        this.retry.hidden = false;
        return false;
      } finally {
        if (this.isCurrent(version)) this.setBusy(false);
      }
    }

    renderRules() {
      this.list.replaceChildren();
      if (!this.rules.length) this.list.append(element('p', text('暂无限额规则')));
      this.rules.forEach(rule => {
        const row = element('div', undefined, 'blora-card');
        const label = rule.rule_type === 'requests' ? text('请求次数') : text('Token 数量');
        row.append(element('p', `${label}：${rule.rule_value} / ${rule.duration_hours} ${text('小时')}`));
        if (rule.description) row.append(element('p', String(rule.description)));
        row.append(button('删除规则', () => this.remove(rule), 'danger'));
        this.list.append(row);
      });
    }

    async add() {
      if (this.busy || !this.loaded || !this.teamId) return false;
      const payload = {
        rule_type: this.type.value,
        rule_value: Number(this.value.value),
        duration_hours: Number(this.duration.value)
      };
      if (!['requests', 'tokens'].includes(payload.rule_type) ||
          !Number.isFinite(payload.rule_value) || payload.rule_value <= 0 ||
          !Number.isFinite(payload.duration_hours) || payload.duration_hours <= 0) {
        this.status.textContent = text('请输入有效的规则类型、限额和时间窗口');
        return false;
      }
      const version = this.version;
      const url = this.endpoint();
      this.setBusy(true);
      this.status.textContent = text('正在添加规则…');
      try {
        const rule = await this.request(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (!this.isCurrent(version)) return false;
        if (!rule?.id) throw new Error(text('规则响应无效，请重试加载'));
        this.rules.push(rule);
        this.renderRules();
        this.value.value = '';
        this.duration.value = '';
        this.status.textContent = text('规则已添加');
        return true;
      } catch (error) {
        if (this.isCurrent(version)) this.status.textContent = error.message || text('添加失败，请重试');
        return false;
      } finally {
        if (this.isCurrent(version)) this.setBusy(false);
      }
    }

    async remove(rule) {
      if (this.busy || !this.loaded || !this.teamId) return false;
      const version = this.version;
      const url = `${this.endpoint()}/${encodeURIComponent(rule.id)}`;
      this.setBusy(true);
      try {
        const confirmed = await Dialog.confirm(text('删除 TEAM 限额规则'), text('确定删除此限额规则吗？删除后该规则将不再限制 TEAM 用量。'), { confirmText: text('删除'), danger: true });
        if (!this.isCurrent(version) || !confirmed) return false;
        const result = await this.request(url, { method: 'DELETE' });
        if (!this.isCurrent(version)) return false;
        if (result?.success !== true) throw new Error(text('删除失败，请重试'));
        this.rules = this.rules.filter(item => item.id !== rule.id);
        this.renderRules();
        this.status.textContent = text('规则已删除');
        return true;
      } catch (error) {
        if (this.isCurrent(version)) this.status.textContent = error.message || text('删除失败，请重试');
        return false;
      } finally {
        if (this.isCurrent(version)) this.setBusy(false);
      }
    }

    destroy() {
      ++this.version;
      this.controller?.abort();
      if (this.host && mounts.get(this.host) === this) {
        mounts.delete(this.host);
        this.host.replaceChildren();
      }
      this.host = null;
      this.teamId = null;
      this.loaded = false;
    }
  }

  window.AdminLibraryTeamRules = AdminLibraryTeamRules;
})();
