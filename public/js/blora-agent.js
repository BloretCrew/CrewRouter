(function () {
  'use strict';

  const page = {
    mode: 'chat',
    admin: false,
    models: [],
    thinking: {},
    conversations: [],
    images: [],
    threads: [],
    messages: [],
    activeId: null,
    pendingApproval: null,
    streaming: false,
    abort: null,
    bound: false,

    async open(mode) {
      this.admin = window.app?.user?.isAdmin === true;
      const requested = mode === 'imagine' || mode === 'manage' || mode === 'chat' ? mode : 'chat';
      this.mode = requested === 'manage' && !this.admin ? 'chat' : requested;
      if (!this.admin && /\/manage$/.test(location.hash) && window.app?._writeConsoleHash) {
        window.app._writeConsoleHash('bloraAgent', { agentMode: 'chat' });
      }
      this.bind();
      this.renderModeSwitch();
      this.applyModeChrome();
      await Promise.all([this.loadModels(), this.loadBalance(), this.loadThinking()]);
      await this.loadHistory();
      if (this.mode === 'chat' && this.activeId) await this.loadConversation(this.activeId);
      else if (this.mode === 'manage' && this.activeId) await this.loadThread(this.activeId);
      else this.renderThread();
    },

    bind() {
      if (this.bound) return;
      this.bound = true;
      document.getElementById('baComposer')?.addEventListener('submit', (event) => {
        event.preventDefault();
        this.send();
      });
      document.getElementById('baInput')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.send();
        }
      });
      document.getElementById('baStop')?.addEventListener('click', () => this.abort?.abort());
      document.getElementById('baNew')?.addEventListener('click', () => this.startNew());
      document.getElementById('baHistoryToggle')?.addEventListener('click', () => this.toggleHistory(true));
      document.getElementById('baOverlay')?.addEventListener('click', () => this.toggleHistory(false));
      document.getElementById('baTemperature')?.addEventListener('input', (event) => {
        const label = document.getElementById('baTempVal');
        if (label) label.textContent = Number(event.target.value).toFixed(1);
      });
      document.getElementById('baModel')?.addEventListener('change', () => this.applyThinkingControls());
      document.getElementById('baThread')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-decision]');
        if (!button || !this.pendingApproval) return;
        this.decide(this.pendingApproval.approval_id, button.dataset.decision);
      });
    },

    renderModeSwitch() {
      const host = document.getElementById('baModeSwitch');
      if (!host) return;
      const modes = this.admin ? ['chat', 'imagine', 'manage'] : ['chat', 'imagine'];
      const labels = { chat: 'Chat', imagine: 'Imagine', manage: 'Manage' };
      const control = document.createElement('blora-segmented');
      control.setAttribute('value', this.mode);
      modes.forEach((mode) => {
        const segment = document.createElement('blora-segment');
        segment.setAttribute('value', mode);
        segment.setAttribute('label', labels[mode]);
        if (mode === this.mode) segment.setAttribute('selected', '');
        segment.textContent = labels[mode];
        control.appendChild(segment);
      });
      host.replaceChildren(control);
      control.addEventListener('blora-change', (event) => {
        const value = event.detail?.value;
        if (!value || value === this.mode) return;
        window.app?.navigateTo('bloraAgent', { agentMode: value });
      });
    },

    applyModeChrome() {
      const chatOptions = document.getElementById('baChatOptions');
      const size = document.getElementById('baImageSize');
      const input = document.getElementById('baInput');
      const title = document.getElementById('baHistoryTitle');
      if (chatOptions) chatOptions.hidden = this.mode !== 'chat';
      if (size) size.hidden = this.mode !== 'imagine';
      if (input) {
        input.placeholder = this.mode === 'imagine' ? '描述要生成的图片' : '输入消息，Enter 发送，Shift+Enter 换行';
      }
      if (title) title.textContent = this.mode === 'imagine' ? '图片历史' : '对话历史';
      this.activeId = null;
      this.messages = [];
      this.pendingApproval = null;
    },

    async loadModels() {
      try {
        const response = await fetch('/api/user/models', { credentials: 'same-origin' });
        if (response.status === 404) {
          this.showUnavailable();
          return;
        }
        const data = response.ok ? await response.json() : [];
        this.models = Array.isArray(data) ? data : [];
      } catch (_) {
        this.models = [];
      }
      this.renderModelSelect();
    },

    modelsForMode() {
      if (this.mode === 'imagine') return this.models.filter(model => model.output_kind === 'image');
      return this.models.filter(model => model.output_kind !== 'image');
    },

    renderModelSelect() {
      const select = document.getElementById('baModel');
      if (!select) return;
      const models = this.modelsForMode();
      if (!models.length) {
        setHTML(select, `<blora-option value="" disabled selected>${Dom.escapeHtml(this.mode === 'imagine' ? '还没有图像模型' : '暂无可用模型')}</blora-option>`);
        return;
      }
      setHTML(select, models.map(model => {
        const id = Dom.escapeHtml(model.id);
        const name = Dom.escapeHtml(model.name || model.id);
        return `<blora-option value="${id}">${name}</blora-option>`;
      }).join(''));
      select.value = models[0].id;
      this.applyThinkingControls();
    },

    async loadThinking() {
      try {
        const response = await fetch('/api/playground/thinking-capabilities', { credentials: 'same-origin' });
        this.thinking = response.ok ? await response.json() : {};
      } catch (_) {
        this.thinking = {};
      }
      this.applyThinkingControls();
    },

    applyThinkingControls() {
      const modelId = document.getElementById('baModel')?.value || '';
      const caps = this.thinking[modelId] || {};
      const thinking = document.getElementById('baThinkingWrap');
      const reasoning = document.getElementById('baReasoningWrap');
      if (thinking) thinking.hidden = this.mode !== 'chat' || !caps.supportsThinking;
      if (reasoning) reasoning.hidden = this.mode !== 'chat' || !caps.supportsThinkingBudget;
    },

    async loadBalance() {
      try {
        const response = await fetch('/api/user/balance', { credentials: 'same-origin' });
        const data = response.ok ? await response.json() : {};
        const label = document.getElementById('baBalance');
        if (label) label.textContent = `${Number(data.balance || 0).toFixed(0)} 积分`;
      } catch (_) { /* 余额显示保持上次的值 */ }
    },

    async loadHistory() {
      const list = document.getElementById('baHistoryList');
      if (!list) return;
      try {
        if (this.mode === 'chat') {
          const response = await fetch('/api/conversations', { credentials: 'same-origin' });
          this.conversations = response.ok ? await response.json() : [];
          this.renderHistory(this.conversations, item => item.title || '新对话', item => item.model || '');
        } else if (this.mode === 'imagine') {
          const response = await fetch('/api/agent/images', { credentials: 'same-origin' });
          if (response.status === 404) return this.showUnavailable();
          this.images = response.ok ? await response.json() : [];
          this.renderHistory(this.images, item => (item.prompt || '图片').slice(0, 42), item => item.model_id || '');
        } else {
          const response = await fetch('/api/agent/manage/threads', { credentials: 'same-origin' });
          if (response.status === 403) return this.showUnavailable();
          if (response.status === 404) return this.showUnavailable();
          this.threads = response.ok ? await response.json() : [];
          this.renderHistory(this.threads, item => item.title || '新对话', item => item.model_id || '');
        }
      } catch (_) {
        setHTML(list, `<blora-empty title="历史加载失败" description="请稍后重试。"></blora-empty>`);
      }
    },

    renderHistory(items, titleOf, metaOf) {
      const list = document.getElementById('baHistoryList');
      if (!items.length) {
        const description = this.mode === 'imagine'
          ? '管理员可以在 Manage 里把模型标成图像。'
          : '发送后会保存在这里。';
        setHTML(list, `<blora-empty title="${Dom.escapeHtml(this.mode === 'imagine' ? '还没有图片' : '还没有对话')}" description="${Dom.escapeHtml(description)}"></blora-empty>`);
        return;
      }
      setHTML(list, items.map(item => `
        <button type="button" class="ba-history__item${Number(item.id) === Number(this.activeId) ? ' is-active' : ''}" data-id="${Number(item.id)}">
          ${Dom.escapeHtml(titleOf(item))}
          <small>${Dom.escapeHtml(metaOf(item))}</small>
        </button>
      `).join(''));
      list.querySelectorAll('[data-id]').forEach(button => {
        button.addEventListener('click', () => {
          this.toggleHistory(false);
          const id = Number(button.dataset.id);
          if (this.mode === 'chat') this.loadConversation(id);
          else if (this.mode === 'imagine') this.showImage(id);
          else this.loadThread(id);
        });
      });
    },

    async loadConversation(id) {
      const response = await fetch(`/api/conversations/${id}`, { credentials: 'same-origin' });
      if (!response.ok) return;
      const data = await response.json();
      this.activeId = data.id;
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      if (data.model) {
        const select = document.getElementById('baModel');
        if (select) select.value = data.model;
      }
      const system = document.getElementById('baSystem');
      if (system && data.system_prompt) system.value = data.system_prompt;
      this.renderThread();
      this.loadHistory();
    },

    showImage(id) {
      const image = this.images.find(item => Number(item.id) === Number(id));
      if (!image) return;
      this.activeId = image.id;
      const thread = document.getElementById('baThread');
      setHTML(thread, `
        <img class="ba-image" alt="" src="${Dom.escapeHtml(image.url)}">
        <div class="ba-bubble ba-bubble--user">${this.renderRich(image.prompt || '')}</div>
      `);
      this.loadHistory();
    },

    async loadThread(id) {
      const response = await fetch(`/api/agent/manage/threads/${id}`, { credentials: 'same-origin' });
      if (response.status === 404) return this.showUnavailable();
      if (!response.ok) return;
      const data = await response.json();
      this.activeId = data.id;
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.pendingApproval = data.approval && data.approval.status === 'pending' ? {
        approval_id: data.approval.id,
        id: data.approval.tool_call_id,
        name: data.approval.tool_name,
        arguments: data.approval.arguments || {}
      } : null;
      if (data.model_id) {
        const select = document.getElementById('baModel');
        if (select) select.value = data.model_id;
      }
      this.renderThread();
      this.loadHistory();
    },

    startNew() {
      this.activeId = null;
      this.messages = [];
      this.pendingApproval = null;
      this.renderThread();
      this.loadHistory();
    },

    renderThread() {
      const thread = document.getElementById('baThread');
      if (!thread) return;
      if (!this.messages.length) {
        const title = this.mode === 'imagine' ? 'Imagine' : (this.mode === 'manage' ? 'Manage' : 'Chat');
        const description = this.mode === 'imagine'
          ? '选择图像模型，描述想要的画面。'
          : (this.mode === 'manage' ? '用对话管理实例。写入操作需要你点允许。' : '选择模型，开始对话。');
        setHTML(thread, `<blora-empty title="${title}" description="${Dom.escapeHtml(description)}"></blora-empty>`);
        return;
      }
      let html = this.messages.map(message => this.bubbleHtml(message)).join('');
      if (this.pendingApproval && !this.messages.some(message => message.tool_call_id === this.pendingApproval.id)) {
        html += this.toolCard(this.pendingApproval.name, JSON.stringify(this.pendingApproval.arguments || {}, null, 2), true);
      }
      setHTML(thread, html);
      thread.scrollTop = thread.scrollHeight;
    },

    bubbleHtml(message) {
      if (message.role === 'tool') {
        const pending = this.pendingApproval && this.pendingApproval.id === message.tool_call_id;
        return this.toolCard(message.tool_name || 'tool', message.content, pending);
      }
      const role = message.role === 'user' ? 'user' : 'assistant';
      const reasoning = message.reasoning ? `<div class="ba-thinking">${this.renderRich(message.reasoning)}</div>` : '';
      return `<div class="ba-bubble ba-bubble--${role}">${reasoning}${this.renderRich(message.content || '')}</div>`;
    },

    toolCard(name, body, pending) {
      const actions = pending ? `<div class="ba-card__actions"><button type="button" class="blora-button" data-variant="primary" data-size="sm" data-decision="allow">允许</button><button type="button" class="blora-button" data-variant="outline" data-size="sm" data-decision="deny">拒绝</button></div>` : '';
      return `<article class="ba-card"><header><span>${Dom.escapeHtml(name || 'tool')}</span></header><pre>${Dom.escapeHtml(typeof body === 'string' ? body : JSON.stringify(body || {}, null, 2))}</pre>${actions}</article>`;
    },

    renderRich(text) {
      const blocks = [];
      let html = Dom.escapeHtml(text || '');
      html = html.replace(/```([\s\S]*?)```/g, (_, code) => {
        blocks.push(`<pre><code>${code.trim()}</code></pre>`);
        return `%%BLOCK${blocks.length - 1}%%`;
      });
      html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\n/g, '<br>');
      return html.replace(/%%BLOCK(\d+)%%/g, (_, index) => blocks[index]);
    },

    selectedModel() {
      return document.getElementById('baModel')?.value || '';
    },

    async send() {
      if (this.streaming || this.pendingApproval) return;
      const input = document.getElementById('baInput');
      const text = input?.value.trim() || '';
      if (!text) return;
      const model = this.selectedModel();
      if (!model) {
        this.appendError(this.mode === 'imagine' ? '还没有图像模型。管理员可以在 Manage 里把模型标成图像。' : '请先选择模型');
        return;
      }
      input.value = '';
      if (this.mode === 'imagine') return this.sendImage(text, model);
      if (this.mode === 'manage') return this.sendManage(text, model);
      return this.sendChat(text, model);
    },

    setStreaming(active) {
      this.streaming = active;
      const send = document.getElementById('baSend');
      const stop = document.getElementById('baStop');
      if (send) send.hidden = active;
      if (stop) stop.hidden = !active;
    },

    appendError(message) {
      const thread = document.getElementById('baThread');
      const empty = thread?.querySelector('blora-empty');
      if (empty) empty.remove();
      const node = document.createElement('div');
      node.className = 'ba-bubble ba-bubble--assistant';
      node.textContent = message;
      thread?.appendChild(node);
    },

    async sendChat(text, model) {
      const system = document.getElementById('baSystem')?.value || '';
      const temperature = Number(document.getElementById('baTemperature')?.value || 1);
      const maxTokens = Number(document.getElementById('baMaxTokens')?.value || 4096);
      const thinking = document.getElementById('baThinking')?.checked !== false;
      const reasoningEffort = document.getElementById('baReasoning')?.value || 'medium';
      this.messages.push({ role: 'user', content: text });
      this.messages.push({ role: 'assistant', content: '', reasoning: '' });
      this.renderThread();
      this.setStreaming(true);
      this.abort = new AbortController();
      let full = '';
      let reasoning = '';
      try {
        const apiMessages = [];
        if (system) apiMessages.push({ role: 'system', content: system });
        this.messages.slice(0, -1).forEach(message => {
          if (message.role === 'user' || message.role === 'assistant') apiMessages.push({ role: message.role, content: message.content || '' });
        });
        const response = await fetch('/api/playground/chat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: apiMessages,
            temperature,
            max_tokens: maxTokens,
            stream: true,
            thinking,
            reasoning_effort: reasoningEffort
          }),
          signal: this.abort.signal
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `请求失败 (${response.status})`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            let parsed;
            try { parsed = JSON.parse(data); } catch (_) { continue; }
            if (parsed.error) throw new Error(parsed.error.message || '上游流式响应失败');
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.reasoning_content) reasoning += delta.reasoning_content;
            if (delta?.content) full += delta.content;
            const last = this.messages[this.messages.length - 1];
            last.content = full;
            last.reasoning = reasoning;
            this.renderThread();
          }
        }
        await this.persistChat(model, system, temperature, maxTokens);
      } catch (err) {
        const last = this.messages[this.messages.length - 1];
        if (err.name === 'AbortError') {
          if (last && last.role === 'assistant' && !last.content && !last.reasoning) this.messages.pop();
        } else if (last && last.role === 'assistant' && !last.content && !last.reasoning) {
          last.content = err.message || '请求失败';
        } else {
          this.messages.push({ role: 'assistant', content: err.message || '请求失败' });
        }
        this.renderThread();
      } finally {
        this.setStreaming(false);
        this.abort = null;
        this.loadBalance();
      }
    },

    async persistChat(model, system, temperature, maxTokens) {
      const payload = this.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({
        role: message.role,
        content: message.content || '',
        reasoning: message.reasoning || null
      }));
      if (!this.activeId) {
        const created = await fetch('/api/conversations', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: (payload.find(message => message.role === 'user')?.content || '新对话').slice(0, 40),
            model,
            system_prompt: system,
            temperature,
            max_tokens: maxTokens,
            messages: payload
          })
        });
        const data = await created.json().catch(() => ({}));
        if (created.ok) this.activeId = data.id;
      } else {
        await fetch(`/api/conversations/${this.activeId}/messages`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: payload })
        });
      }
      this.loadHistory();
    },

    async sendImage(text, model) {
      this.setStreaming(true);
      this.abort = new AbortController();
      try {
        const response = await fetch('/api/agent/images', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: text,
            size: document.getElementById('baImageSize')?.value || '1024x1024'
          }),
          signal: this.abort.signal
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 404 && !data.error) return this.showUnavailable();
        if (!response.ok) throw new Error(data.error || `生成失败 (${response.status})`);
        this.images.unshift(data);
        this.showImage(data.id);
      } catch (err) {
        if (err.name !== 'AbortError') this.appendError(err.message || '生成失败');
      } finally {
        this.setStreaming(false);
        this.abort = null;
        this.loadBalance();
      }
    },

    async sendManage(text, model) {
      this.messages.push({ role: 'user', content: text });
      this.renderThread();
      await this.readManageStream('/api/agent/manage/runs', { thread_id: this.activeId, model, text });
    },

    async decide(approvalId, decision) {
      if (!approvalId || this.streaming) return;
      this.pendingApproval = null;
      const model = this.selectedModel();
      await this.readManageStream(`/api/agent/manage/approvals/${approvalId}`, { decision, model });
    },

    async readManageStream(url, body) {
      this.setStreaming(true);
      this.abort = new AbortController();
      let assistant = '';
      let failure = '';
      try {
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: this.abort.signal
        });
        if (response.status === 404) return this.showUnavailable();
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `请求失败 (${response.status})`);
        }
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || '当前模式不可用');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            const line = part.split('\n').find(item => item.startsWith('data: '));
            if (!line) continue;
            const event = JSON.parse(line.slice(6));
            if (event.type === 'run.started' && event.payload?.thread_id) this.activeId = event.payload.thread_id;
            if (event.type === 'assistant.delta') {
              assistant += event.payload?.text || '';
              this.upsertAssistant(assistant);
            }
            if (event.type === 'tool.requested') assistant = '';
            if (event.type === 'tool.completed') {
              this.messages.push({ role: 'tool', tool_name: event.payload.name, tool_call_id: event.payload.id, content: JSON.stringify(event.payload.output || {}, null, 2) });
              this.renderThread();
            }
            if (event.type === 'approval.required') {
              this.pendingApproval = event.payload;
              this.renderThread();
            }
            if (event.type === 'run.failed') failure = event.payload?.error || '管理对话失败';
            if (event.type === 'run.completed') assistant = '';
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') failure = err.message || '请求失败';
      } finally {
        this.setStreaming(false);
        this.abort = null;
        this.loadBalance();
        if (this.activeId) await this.loadThread(this.activeId);
        if (failure) this.appendError(failure);
      }
    },

    upsertAssistant(text) {
      const last = this.messages[this.messages.length - 1];
      if (!last || last.role !== 'assistant' || last.tool_calls) this.messages.push({ role: 'assistant', content: text });
      else last.content = text;
      this.renderThread();
    },

    showUnavailable() {
      const thread = document.getElementById('baThread');
      setHTML(thread, `<blora-empty title="当前模式不可用" description="这个实例没有开放对应接口。"></blora-empty>`);
    },

    toggleHistory(open) {
      document.getElementById('baHistory')?.classList.toggle('is-open', open);
      document.getElementById('baOverlay')?.classList.toggle('is-open', open);
    }
  };

  window.BloraAgentPage = page;
}());
