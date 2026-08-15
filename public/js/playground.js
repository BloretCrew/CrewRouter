class PlaygroundApp {
  constructor() {
    this.messages = [];
    this.models = [];
    this.streaming = false;
    this.abortController = null;
    this.totalCost = 0;
    this.totalTokens = 0;
    this.conversations = [];
    this.activeConvId = null;
    this.contextMenuTarget = null;
    this.replyTo = null;
    this.thinkingCapabilities = {};
    this.init();
  }

  async init() {
    await this.loadUserInfo();
    await this.loadModels();
    await this.loadThinkingCapabilities();
    await this.loadBalance();
    await this.loadConversations();
    this.bindEvents();
    this.initContextMenu();
  }

  // ========== User Info ==========

  async loadUserInfo() {
    try {
      const res = await fetch('/auth/me');
      if (res.ok) {
        const data = await res.json();
        this.userInfo = data;
      }
    } catch {}
  }

  // ========== Models & Balance ==========

  async loadModels() {
    try {
      const res = await fetch('/api/user/models');
      if (!res.ok) throw new Error('请求失败');
      const data = await res.json();
      this.models = Array.isArray(data) ? data : [];
      const select = document.getElementById('pgModel');
      if (this.models.length === 0) {
        setHTML(select, '<option value="" disabled selected>暂无可用模型</option>');
        return;
      }
      const grouped = {};
      this.models.forEach(m => {
        if (!grouped[m.provider]) grouped[m.provider] = [];
        grouped[m.provider].push(m);
      });
      let html = '';
      for (const [provider, models] of Object.entries(grouped)) {
        html += `<optgroup label="${provider}">`;
        models.forEach(m => {
          const mult = Number(m.model_multiplier || 1.0);
          html += `<option value="${m.id}">${m.name} (×${mult.toFixed(2)})</option>`;
        });
        html += '</optgroup>';
      }
      setHTML(select, html);

      // Store model pricing and info for cost calculation
      this.modelPricing = {};
      this.modelInfo = {};
      this.models.forEach(m => {
        this.modelPricing[m.id] = {
          multiplier: Number(m.model_multiplier || 1.0)
        };
        this.modelInfo[m.id] = {
          name: m.name,
          series: m.series || '',
          seriesIconUrl: m.series_icon_url || '',
          iconUrl: m.icon_url || ''
        };
      });

      // Add model change handler
      select.addEventListener('change', () => this.updateThinkingControls());
      this.updateThinkingControls();
    } catch (error) {
      console.error('加载模型失败:', error);
      const select = document.getElementById('pgModel');
      if (select) setHTML(select, '<option value="" disabled selected>加载失败</option>');
    }
  }

  async loadThinkingCapabilities() {
    try {
      const res = await fetch('/api/playground/thinking-capabilities');
      if (res.ok) {
        this.thinkingCapabilities = await res.json();
      }
    } catch {}
  }

  updateThinkingControls() {
    const model = document.getElementById('pgModel').value;
    const caps = this.thinkingCapabilities[model] || {};
    const thinkingToggle = document.getElementById('pgThinkingToggle');
    const thinkingLabel = document.getElementById('pgThinkingLabel');
    const budgetGroup = document.getElementById('pgThinkingBudgetGroup');
    const reasoningGroup = document.getElementById('pgReasoningEffortGroup');

    if (caps.supportsThinking) {
      thinkingToggle.disabled = false;
      thinkingLabel.textContent = thinkingToggle.checked ? '已启用' : '已禁用';
    } else {
      thinkingToggle.checked = true;
      thinkingToggle.disabled = true;
      thinkingLabel.textContent = '不支持';
    }

    budgetGroup.style.display = caps.supportsThinkingBudget ? '' : 'none';
    reasoningGroup.style.display = (caps.supportsThinkingBudget && /^(o1|o3|o4)/.test(model)) ? '' : 'none';
  }

  async loadBalance() {
    try {
      const res = await fetch('/api/user/balance');
      const data = await res.json();
      const balance = Number(data.balance || 0);
      document.getElementById('pgBalanceBadge').textContent = `${balance.toFixed(0)} 积分`;
    } catch {}
  }

  // ========== Conversations ==========

  async loadConversations() {
    const list = document.getElementById('pgHistoryList');
    if (list && !(this.conversations || []).length) {
      if (typeof pageLoadingHtml === 'function') {
        setHTML(list, pageLoadingHtml('加载对话...', { size: 'md', compact: true, minHeight: '120px' }));
      } else {
        setHTML(list, '<div class="page-loading page-loading-compact"><div class="loading-spinner md"></div><div class="page-loading-text">加载对话...</div></div>');
      }
    }
    try {
      const res = await fetch('/api/conversations');
      if (res.ok) {
        const data = await res.json();
        this.conversations = Array.isArray(data) ? data : [];
        this.renderHistoryList();
      } else {
        console.error('加载对话历史失败:', res.status, await res.text());
        this.conversations = [];
        this.renderHistoryList();
      }
    } catch (err) {
      console.error('加载对话历史异常:', err);
      this.conversations = [];
      this.renderHistoryList();
    }
  }

  renderHistoryList() {
    const list = document.getElementById('pgHistoryList');
    if (this.conversations.length === 0) {
      setHTML(list, `
        <div class="pg-history-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3;margin-bottom:8px;">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span>暂无对话记录</span>
        </div>`);
      return;
    }

    setHTML(list, this.conversations.map(conv => {
      const date = new Date(conv.updated_at);
      const dateStr = `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const isActive = conv.id === this.activeConvId;
      return `
        <div class="pg-history-item${isActive ? ' active' : ''}" data-id="${conv.id}">
          <div class="pg-history-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="pg-history-item-info">
            <div class="pg-history-item-title">${this.escapeHtml(conv.title)}</div>
            <div class="pg-history-item-date">${dateStr}</div>
          </div>
          <div class="pg-history-item-actions">
            <button class="rename-btn" data-id="${conv.id}" title="重命名">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </button>
            <button class="delete-btn" data-id="${conv.id}" title="删除">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>`;
    }).join(''));

    list.querySelectorAll('.pg-history-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.pg-history-item-actions')) return;
        this.loadConversation(parseInt(el.dataset.id));
      });
    });

    list.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteConversation(parseInt(btn.dataset.id));
      });
    });

    list.querySelectorAll('.rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.startRename(parseInt(btn.dataset.id));
      });
    });
  }

  generateTitle(text) {
    const clean = text.replace(/\n/g, ' ').trim();
    return clean.length > 30 ? clean.substring(0, 30) + '...' : clean;
  }

  async createConversation() {
    try {
      const model = document.getElementById('pgModel').value;
      const firstUserMsg = this.messages.find(m => m.role === 'user');
      const title = firstUserMsg ? this.generateTitle(firstUserMsg.content) : '新对话';
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          model,
          system_prompt: document.getElementById('pgSystemPrompt').value,
          temperature: parseFloat(document.getElementById('pgTemperature').value),
          max_tokens: parseInt(document.getElementById('pgMaxTokens').value) || 4096,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        this.activeConvId = data.id;
        await this.loadConversations();
        return data.id;
      } else {
        console.error('创建对话失败:', res.status, await res.text());
      }
    } catch (err) {
      console.error('创建对话异常:', err);
    }
    return null;
  }

  async updateConversationTitle(convId, title) {
    try {
      await fetch(`/api/conversations/${convId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    } catch {}
  }

  async saveMessagesToConv(convId) {
    try {
      const res = await fetch(`/api/conversations/${convId}/messages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.messages }),
      });
      if (!res.ok) {
        console.error('保存消息失败:', res.status, await res.text());
      } else {
        await this.loadConversations();
      }
    } catch (err) {
      console.error('保存消息异常:', err);
    }
  }

  async loadConversation(convId) {
    try {
      const res = await fetch(`/api/conversations/${convId}`);
      if (res.ok) {
        const data = await res.json();
        this.activeConvId = convId;
        this.messages = data.messages || [];
        if (data.model) document.getElementById('pgModel').value = data.model;
        if (data.system_prompt !== undefined) document.getElementById('pgSystemPrompt').value = data.system_prompt;
        if (data.temperature !== undefined) {
          document.getElementById('pgTemperature').value = data.temperature;
          document.getElementById('pgTempVal').textContent = data.temperature;
        }
        if (data.max_tokens !== undefined) document.getElementById('pgMaxTokens').value = data.max_tokens;
        this.totalCost = 0;
        this.totalTokens = 0;
        document.getElementById('pgTokens').textContent = '0';
        document.getElementById('pgCost').textContent = '0 积分';
        this.replyTo = null;
        this.hideReplyBar();
        this.renderMessages();
        this.renderHistoryList();
      }
    } catch {}
  }

  async deleteConversation(convId) {
    if (!confirm('确定删除这个对话？')) return;
    try {
      await fetch(`/api/conversations/${convId}`, { method: 'DELETE' });
      if (this.activeConvId === convId) {
        this.activeConvId = null;
        this.messages = [];
        this.renderMessages();
      }
      await this.loadConversations();
    } catch {}
  }

  async forkConversation(convId) {
    try {
      const res = await fetch(`/api/conversations/${convId}/fork`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        await this.loadConversations();
        this.loadConversation(data.id);
      }
    } catch {}
  }

  startRename(convId) {
    const item = document.querySelector(`.pg-history-item[data-id="${convId}"]`);
    if (!item) return;
    const titleEl = item.querySelector('.pg-history-item-title');
    const conv = this.conversations.find(c => c.id === convId);
    if (!conv) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pg-rename-input';
    input.value = conv.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const doConfirm = async () => {
      const newTitle = input.value.trim() || conv.title;
      try {
        await fetch(`/api/conversations/${convId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
        await this.loadConversations();
      } catch {}
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doConfirm();
      if (e.key === 'Escape') this.renderHistoryList();
    });
    input.addEventListener('blur', doConfirm);
  }

  newChat() {
    this.activeConvId = null;
    this.messages = [];
    this.totalCost = 0;
    this.totalTokens = 0;
    this.replyTo = null;
    this.hideReplyBar();
    document.getElementById('pgTokens').textContent = '0';
    document.getElementById('pgCost').textContent = '0 积分';
    this.renderMessages();
    this.renderHistoryList();
  }

  // ========== Reply ==========

  setReplyTo(msgIndex) {
    if (msgIndex < 0 || msgIndex >= this.messages.length) return;
    this.replyTo = msgIndex;
    const msg = this.messages[msgIndex];
    const bar = document.getElementById('pgReplyBar');
    const preview = document.getElementById('pgReplyPreview');
    preview.textContent = (msg.role === 'user' ? '你: ' : '助手: ') + msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : '');
    bar.style.display = 'flex';
    document.getElementById('pgInput').focus();
  }

  hideReplyBar() {
    const bar = document.getElementById('pgReplyBar');
    if (bar) bar.style.display = 'none';
  }

  cancelReply() {
    this.replyTo = null;
    this.hideReplyBar();
  }

  // ========== Chat ==========

  async send() {
    if (this.streaming) return;

    const input = document.getElementById('pgInput');
    const text = input.value.trim();
    if (!text) return;

    const model = document.getElementById('pgModel').value;
    const systemPrompt = document.getElementById('pgSystemPrompt').value.trim();
    const temperature = parseFloat(document.getElementById('pgTemperature').value);
    const maxTokens = parseInt(document.getElementById('pgMaxTokens').value) || 4096;
    const thinking = document.getElementById('pgThinkingToggle').checked;
    const thinkingBudget = parseInt(document.getElementById('pgThinkingBudget').value) || 4096;
    const reasoningEffort = document.getElementById('pgReasoningEffort').value;

    if (!model) {
      alert('请先选择模型');
      return;
    }

    // If replying, build context: messages up to reply point + the replied message
    if (this.replyTo !== null && this.replyTo < this.messages.length) {
      const contextMessages = this.messages.slice(0, this.replyTo + 1);
      const userMsg = { role: 'user', content: text };
      this.messages = [...contextMessages, userMsg];
      this.replyTo = null;
      this.hideReplyBar();
    } else {
      this.messages.push({ role: 'user', content: text });
    }

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }
    apiMessages.push(...this.messages);

    input.value = '';
    input.style.height = 'auto';

    this.removeWelcome();
    this.renderMessages();

    const currentModel = document.getElementById('pgModel').value;
    const modelInfo = this.modelInfo?.[currentModel];
    const meta = {
      model: currentModel,
      modelDisplayName: modelInfo?.name || currentModel
    };
    const assistantEl = this.appendMessage('assistant', '', undefined, meta);
    const contentEl = assistantEl.querySelector('.pg-msg-content');
    setHTML(contentEl, '<div class="pg-typing"><span></span><span></span><span></span></div>');

    this.setStreaming(true);

    let convId = this.activeConvId;
    if (!convId) {
      convId = await this.createConversation();
    }

    try {
      this.abortController = new AbortController();

      const res = await fetch('/api/playground/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: apiMessages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          thinking,
          thinking_budget: thinkingBudget,
          reasoning_effort: reasoningEffort
        }),
        signal: this.abortController.signal
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `请求失败 (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let reasoningContent = '';
      let thinkingStarted = false;
      let promptTokens = 0;
      let completionTokens = 0;

      clearChildren(contentEl);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            const reasoning = delta.reasoning_content || '';
            if (reasoning) {
              reasoningContent += reasoning;
              if (!thinkingStarted) {
                thinkingStarted = true;
                setHTML(contentEl, this.renderThinking(reasoningContent));
              } else {
                this.updateThinkingContent(contentEl, reasoningContent);
              }
              this.scrollToBottom();
            }

            const chunk = delta.content || '';
            if (chunk) {
              fullContent += chunk;
              completionTokens++;
              this.updateResponseContent(contentEl, reasoningContent, fullContent);
              this.scrollToBottom();
            }

            // Capture usage if present in any chunk
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens || 0;
              completionTokens = parsed.usage.completion_tokens || 0;
            }
          } catch {}
        }
      }

      // Try to parse usage from remaining buffer
      try {
        const remaining = buffer.split('\n');
        for (const line of remaining) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens || promptTokens;
            completionTokens = parsed.usage.completion_tokens || completionTokens;
          }
        }
      } catch {}

      // Update token counts
      const totalNewTokens = promptTokens + completionTokens;
      if (totalNewTokens > 0) {
        this.totalTokens += totalNewTokens;
        document.getElementById('pgTokens').textContent = this.totalTokens.toLocaleString();
      } else {
        // Fallback: estimate tokens from content length (~4 chars per token)
        const estCompletion = Math.ceil(fullContent.length / 4);
        const estPrompt = Math.ceil(apiMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / 4);
        const estTotal = estCompletion + estPrompt;
        if (estTotal > 0) {
          this.totalTokens += estTotal;
          document.getElementById('pgTokens').textContent = this.totalTokens.toLocaleString();
          const pricing = this.modelPricing?.[model];
          const multiplier = pricing?.multiplier || 1.0;
          if (multiplier > 0) {
            const weightedTokens = Math.round((estPrompt + estCompletion) * multiplier);
            const cost = weightedTokens / 1000000;
            this.totalCost += cost;
            document.getElementById('pgCost').textContent = `${this.totalCost.toFixed(4)} 积分`;
          }
        }
      }

      // Calculate cost (if usage was reported)
      if (totalNewTokens > 0) {
        const pricing = this.modelPricing?.[model];
        const multiplier = pricing?.multiplier || 1.0;
        if (multiplier > 0) {
          const weightedTokens = Math.round((promptTokens + (cachedTokens || 0) * 0.1 + completionTokens) * multiplier);
          const cost = weightedTokens / 1000000;
          this.totalCost += cost;
          document.getElementById('pgCost').textContent = `${this.totalCost.toFixed(4)} 积分`;
        }
      }

      const msg = { role: 'assistant', content: fullContent };
      if (reasoningContent) {
        msg.reasoning = reasoningContent;
      }
      const totalTokensForMsg = promptTokens + completionTokens;
      const pricing = this.modelPricing?.[model];
      const inputPrice = pricing?.input || 0;
      const outputPrice = pricing?.output || 0;
      const msgCost = (promptTokens / 1000) * inputPrice + (completionTokens / 1000) * outputPrice;
      msg.meta = {
        model: model,
        modelDisplayName: document.getElementById('pgModel').selectedOptions[0]?.text?.split(' (')[0] || model,
        tokens: totalTokensForMsg,
        cost: msgCost
      };
      this.messages.push(msg);

      if (convId) {
        // Update title if this was the first user message
        if (this.messages.filter(m => m.role === 'user').length === 1) {
          const firstUser = this.messages.find(m => m.role === 'user');
          if (firstUser) {
            const autoTitle = this.generateTitle(firstUser.content);
            await this.updateConversationTitle(convId, autoTitle);
          }
        }
        await this.saveMessagesToConv(convId);
      }

      await this.updateCost();
    } catch (error) {
      if (error.name === 'AbortError') {
        setHTML(contentEl, this.renderMarkdown(contentEl.textContent || '') + '\n\n*[已停止]*');
      } else {
        setHTML(contentEl, `<div class="pg-msg-error">${escapeHtml(error.message || "")}</div>`);
      }
    } finally {
      this.setStreaming(false);
      this.abortController = null;
    }
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  clear() {
    this.newChat();
  }

  // ========== Rendering ==========

  renderMessages() {
    const container = document.getElementById('pgMessages');
    if (this.messages.length === 0) {
      setHTML(container, `
        <div class="pg-welcome">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--brand-blue)" stroke-width="1.5" style="margin-bottom:16px;opacity:0.6;">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <h2>Crant AI Playground</h2>
          <p>选择模型，开始对话。按 Enter 发送，Shift+Enter 换行。</p>
        </div>`);
      return;
    }

    clearChildren(container);
    this.messages.forEach((msg, idx) => {
      this.appendMessage(msg.role, msg.content, idx);
    });
    this.scrollToBottom();
  }

  appendMessage(role, content, msgIndex, extraMeta) {
    const container = document.getElementById('pgMessages');
    const el = document.createElement('div');
    el.className = `pg-msg ${role}`;
    if (msgIndex !== undefined) el.dataset.msgIndex = msgIndex;

    const msg = msgIndex !== undefined ? this.messages[msgIndex] : null;
    const meta = msg?.meta || extraMeta;

    // 用户信息
    const userName = this.userInfo?.username || '你';
    const userAvatar = this.userInfo?.avatar || '';

    // 模型信息
    let modelName = '助手';
    let modelIconHtml = '';
    if (role === 'assistant' && meta) {
      modelName = meta.modelDisplayName || meta.model || '助手';
      const modelInfo = this.modelInfo?.[meta.model];
      if (modelInfo?.seriesIconUrl) {
        modelIconHtml = `<img src="${modelInfo.seriesIconUrl}" alt="" class="pg-msg-avatar-icon">`;
      }
    }

    const avatarHtml = role === 'user'
      ? (userAvatar ? `<img src="${userAvatar}" alt="" class="pg-msg-avatar-icon">` : 'U')
      : (modelIconHtml || 'AI');

    let thinkingHtml = '';
    if (msg?.reasoning) {
      thinkingHtml = `
        <div class="pg-thinking pg-thinking-collapsed">
          <div class="pg-thinking-toggle" onclick="this.parentElement.classList.toggle('pg-thinking-expanded')">
            <svg class="pg-thinking-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
            <span>思考过程</span>
            <span class="pg-thinking-status">已完成</span>
          </div>
          <div class="pg-thinking-content">${this.renderMarkdown(msg.reasoning)}</div>
        </div>`;
    }

    let metaFooter = '';
    if (role === 'assistant' && meta) {
      const m = meta;
      const tokenStr = m.tokens ? `${m.tokens.toLocaleString()} tokens` : '';
      const costStr = m.cost ? `${m.cost.toFixed(4)} 积分` : '';
      const parts = [m.modelDisplayName || m.model, tokenStr, costStr].filter(Boolean);
      metaFooter = `<div class="pg-msg-meta">${this.escapeHtml(parts.join(' · '))} · AI 也可能犯错，请核实重要信息。</div>`;
    }

    setHTML(el, `
      <div class="pg-msg-avatar">${avatarHtml}</div>
      <div class="pg-msg-body">
        <div class="pg-msg-role">${role === 'user' ? userName : modelName}</div>
        ${thinkingHtml}
        <div class="pg-msg-content">${content ? this.renderMarkdown(content) : ''}</div>
        ${metaFooter}
      </div>`);
    container.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  removeWelcome() {
    const welcome = document.querySelector('.pg-welcome');
    if (welcome) welcome.remove();
  }

  scrollToBottom() {
    const el = document.getElementById('pgMessages');
    el.scrollTop = el.scrollHeight;
  }

  setStreaming(val) {
    this.streaming = val;
    const sendBtn = document.getElementById('pgSendBtn');
    const stopBtn = document.getElementById('pgStopBtn');
    const input = document.getElementById('pgInput');

    sendBtn.style.display = val ? 'none' : 'flex';
    stopBtn.style.display = val ? 'flex' : 'none';
    input.disabled = val;
  }

  async updateCost() {
    try {
      const res = await fetch('/api/user/balance');
      const data = await res.json();
      const balance = Number(data.balance || 0);
      document.getElementById('pgBalanceBadge').textContent = `${balance.toFixed(0)} 积分`;
    } catch {}
  }

  // ========== Markdown Rendering ==========

  renderMarkdown(text) {
    if (!text) return '';
    let html = text;

    // Escape HTML (but preserve newlines for processing)
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`;
    });

    // Inline code: `...`
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Headers: ### / ## / #
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold: **...**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic: *...*
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

    // Strikethrough: ~~...~~
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Blockquote: > ...
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge adjacent blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Unordered list: - ... or * ...
    html = html.replace(/^[\-\*] (.+)$/gm, '<li class="pg-list-ul">$1</li>');

    // Ordered list: 1. ... 2. ...
    html = html.replace(/^\d+\. (.+)$/gm, '<li class="pg-list-ol">$1</li>');

    // Wrap consecutive <li> in <ul> or <ol>
    html = html.replace(/((?:<li class="pg-list-ul">.*<\/li>\n?)+)/g, (match) => {
      return '<ul>' + match.replace(/<li class="pg-list-ul">/g, '<li>').trim() + '</ul>';
    });
    html = html.replace(/((?:<li class="pg-list-ol">.*<\/li>\n?)+)/g, (match) => {
      return '<ol>' + match.replace(/<li class="pg-list-ol">/g, '<li>').trim() + '</ol>';
    });

    // Horizontal rule: --- or ***
    html = html.replace(/^[\-\*]{3,}$/gm, '<hr>');

    // Links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Paragraphs: split by double newlines
    html = html.split(/\n{2,}/).map(block => {
      block = block.trim();
      if (!block) return '';
      if (/^<(h[1-6]|ul|ol|li|pre|blockquote|hr|div)/.test(block)) return block;
      // Wrap in paragraph, converting single newlines to <br>
      return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');

    // Single newlines inside paragraphs -> <br> (already handled above)

    return html;
  }

  renderThinking(reasoning) {
    return `
      <div class="pg-thinking pg-thinking-expanded">
        <div class="pg-thinking-toggle" onclick="this.parentElement.classList.toggle('pg-thinking-expanded')">
          <svg class="pg-thinking-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span>思考过程</span>
          <span class="pg-thinking-status">思考中...</span>
        </div>
        <div class="pg-thinking-content">${this.renderMarkdown(reasoning)}</div>
      </div>
      <div class="pg-response-content"></div>
    `;
  }

  updateThinkingContent(contentEl, reasoning) {
    const thinkingContent = contentEl.querySelector('.pg-thinking-content');
    if (thinkingContent) {
      setHTML(thinkingContent, this.renderMarkdown(reasoning));
    }
  }

  updateResponseContent(contentEl, reasoning, response) {
    let thinkingEl = contentEl.querySelector('.pg-thinking');
    let responseEl = contentEl.querySelector('.pg-response-content');

    if (reasoning && !thinkingEl) {
      setHTML(contentEl, this.renderThinking(reasoning));
      thinkingEl = contentEl.querySelector('.pg-thinking');
      responseEl = contentEl.querySelector('.pg-response-content');
    }

    if (thinkingEl) {
      const statusEl = thinkingEl.querySelector('.pg-thinking-status');
      if (statusEl && response) {
        statusEl.textContent = '已完成';
        thinkingEl.classList.remove('pg-thinking-expanded');
      }
    }

    if (responseEl) {
      setHTML(responseEl, this.renderMarkdown(response));
    } else if (!reasoning) {
      setHTML(contentEl, this.renderMarkdown(response));
    }
  }

  // ========== Context Menu ==========

  initContextMenu() {
    // Create context menu element
    const menu = document.createElement('div');
    menu.id = 'pgContextMenu';
    menu.className = 'pg-context-menu';
    setHTML(menu, `
      <div class="pg-context-menu-item" data-action="copy-text">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        复制纯文本
      </div>
      <div class="pg-context-menu-item" data-action="copy-rich">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        复制富文本
      </div>
      <div class="pg-context-menu-item" data-action="copy-md">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        复制 Markdown
      </div>
      <div class="pg-context-menu-separator"></div>
      <div class="pg-context-menu-item" data-action="reply">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
        回复
      </div>
      <div class="pg-context-menu-item" data-action="fork">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>
        Fork 对话
      </div>
      <div class="pg-context-menu-separator"></div>
      <div class="pg-context-menu-item pg-context-menu-danger" data-action="delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        删除消息
      </div>
    `);
    document.body.appendChild(menu);

    // Right-click on messages
    document.getElementById('pgMessages').addEventListener('contextmenu', (e) => {
      const msgEl = e.target.closest('.pg-msg');
      if (!msgEl) return;
      e.preventDefault();

      const msgIndex = parseInt(msgEl.dataset.msgIndex);
      if (isNaN(msgIndex)) return;

      this.contextMenuTarget = { el: msgEl, index: msgIndex, role: this.messages[msgIndex]?.role };
      this.showContextMenu(e.clientX, e.clientY);
    });

    // Close on click outside
    document.addEventListener('click', () => this.hideContextMenu());
    document.addEventListener('scroll', () => this.hideContextMenu(), true);

    // Menu item actions
    menu.querySelectorAll('.pg-context-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        this.handleContextAction(action);
      });
    });
  }

  showContextMenu(x, y) {
    const menu = document.getElementById('pgContextMenu');
    menu.style.display = 'block';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Adjust if goes off screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  }

  hideContextMenu() {
    const menu = document.getElementById('pgContextMenu');
    if (menu) menu.style.display = 'none';
  }

  handleContextAction(action) {
    this.hideContextMenu();
    if (!this.contextMenuTarget) return;
    const { index } = this.contextMenuTarget;
    const msg = this.messages[index];
    if (!msg) return;

    switch (action) {
      case 'copy-text':
        this.copyToClipboard(msg.content, 'text');
        break;
      case 'copy-rich':
        this.copyToClipboard(this.renderMarkdown(msg.content), 'html');
        break;
      case 'copy-md':
        this.copyToClipboard(msg.content, 'markdown');
        break;
      case 'reply':
        this.setReplyTo(index);
        break;
      case 'fork':
        if (this.activeConvId) {
          this.forkConversation(this.activeConvId);
        } else {
          alert('请先发送消息创建对话后再 Fork');
        }
        break;
      case 'delete':
        this.deleteMessage(index);
        break;
    }
  }

  async copyToClipboard(text, type) {
    try {
      if (type === 'html') {
        const blob = new Blob([text], { type: 'text/html' });
        const plainBlob = new Blob([text], { type: 'text/plain' });
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': blob,
            'text/plain': plainBlob
          })
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      this.showToast(type === 'html' ? '已复制富文本' : type === 'markdown' ? '已复制 Markdown' : '已复制纯文本');
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = type === 'html' ? text : text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.showToast('已复制');
    }
  }

  async deleteMessage(index) {
    if (index < 0 || index >= this.messages.length) return;
    // Remove from local array
    this.messages.splice(index, 1);
    // If in a conversation, save the updated messages
    if (this.activeConvId) {
      await this.saveMessagesToConv(this.activeConvId);
    }
    this.renderMessages();
  }

  showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'pg-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 1500);
  }

  // ========== Utils ==========

  escapeHtml(value) {
    return Dom.escapeHtml(value);
  }

  // ========== Events ==========

  bindEvents() {
    const input = document.getElementById('pgInput');
    const sendBtn = document.getElementById('pgSendBtn');
    const stopBtn = document.getElementById('pgStopBtn');
    const clearBtn = document.getElementById('pgClearBtn');
    const tempSlider = document.getElementById('pgTemperature');
    const newChatBtn = document.getElementById('pgNewChatBtn');
    const toggleBtn = document.getElementById('pgToggleSidebar');
    const overlay = document.getElementById('pgOverlay');
    const historyPanel = document.getElementById('pgHistoryPanel');
    const thinkingToggle = document.getElementById('pgThinkingToggle');
    const thinkingBudget = document.getElementById('pgThinkingBudget');

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });

    sendBtn.addEventListener('click', () => this.send());
    stopBtn.addEventListener('click', () => this.stop());
    clearBtn.addEventListener('click', () => this.clear());
    newChatBtn.addEventListener('click', () => this.newChat());

    tempSlider.addEventListener('input', () => {
      document.getElementById('pgTempVal').textContent = tempSlider.value;
    });

    // Thinking toggle
    thinkingToggle.addEventListener('change', () => {
      document.getElementById('pgThinkingLabel').textContent = thinkingToggle.checked ? '已启用' : '已禁用';
    });

    // Thinking budget slider
    thinkingBudget.addEventListener('input', () => {
      document.getElementById('pgThinkingBudgetVal').textContent = thinkingBudget.value;
    });

    // Reply bar cancel
    const cancelReplyBtn = document.getElementById('pgCancelReply');
    if (cancelReplyBtn) {
      cancelReplyBtn.addEventListener('click', () => this.cancelReply());
    }

    // Mobile sidebar toggle
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        historyPanel.classList.add('open');
        overlay.classList.add('active');
      });
    }
    if (overlay) {
      overlay.addEventListener('click', () => {
        historyPanel.classList.remove('open');
        overlay.classList.remove('active');
      });
    }

    // History panel toggle
    const historyToggleBtn = document.getElementById('pgHistoryToggleBtn');
    const historyDetailPanel = document.getElementById('pgHistoryDetailPanel');
    const settingsPanel = document.getElementById('pgSettingsPanel');
    const historyBackBtn = document.getElementById('pgHistoryBackBtn');

    if (historyToggleBtn) {
      historyToggleBtn.addEventListener('click', () => {
        settingsPanel.style.display = 'none';
        historyDetailPanel.style.display = 'flex';
        this.loadHistory();
      });
    }

    if (historyBackBtn) {
      historyBackBtn.addEventListener('click', () => {
        historyDetailPanel.style.display = 'none';
        settingsPanel.style.display = 'flex';
      });
    }

    // History modal close
    const modalClose = document.getElementById('pgHistoryModalClose');
    const modalOverlay = document.getElementById('pgHistoryModalOverlay');
    const modal = document.getElementById('pgHistoryModal');

    if (modalClose) modalClose.addEventListener('click', () => { modal.style.display = 'none'; });
    if (modalOverlay) modalOverlay.addEventListener('click', () => { modal.style.display = 'none'; });
  }

  // ========== History ==========

  async loadHistory() {
    try {
      const res = await fetch('/api/playground/history?limit=50');
      if (!res.ok) throw new Error('请求失败');
      const data = await res.json();
      this.renderHistoryDetailList(data.records || []);
    } catch (error) {
      console.error('加载历史失败:', error);
      const list = document.getElementById('pgHistoryDetailList');
      if (list) setHTML(list, '<div class="pg-history-detail-empty"><span>加载失败</span></div>');
    }
  }

  renderHistoryDetailList(records) {
    const list = document.getElementById('pgHistoryDetailList');
    if (!list) return;

    if (records.length === 0) {
      setHTML(list, '<div class="pg-history-detail-empty"><img src="https://img.bloret.net/SF/clock?color=white" alt="" width="32" height="32" class="sf-icon" data-sf-name="clock" style="display:inline-block;vertical-align:middle;opacity:0.3;margin-bottom:8px;"><span>暂无历史记录</span></div>');
      return;
    }

    setHTML(list, records.map(r => {
      const time = new Date(r.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const hasThinking = r.requestParams?.thinking !== false && r.reasoningContent;
      const preview = r.messages?.[0]?.content?.substring(0, 50) || '';
      return `<div class="pg-history-item" data-id="${r.id}">
        <div class="pg-history-item-header">
          <span class="pg-history-item-model">${r.model}${hasThinking ? '<span class="pg-history-item-thinking-badge">思考</span>' : ''}</span>
          <span class="pg-history-item-time">${time}</span>
        </div>
        <div class="pg-history-item-stats">
          <span>📝 ${r.totalTokens?.toLocaleString() || 0} tokens</span>
          <span>💰 ${r.cost?.toFixed(4) || '0.0000'} 积分</span>
        </div>
        <div class="pg-history-item-preview">${this.escapeHtml(preview)}</div>
      </div>`;
    }).join(''));

    list.querySelectorAll('.pg-history-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        this.showHistoryDetail(id);
      });
    });
  }

  async showHistoryDetail(id) {
    try {
      const res = await fetch(`/api/playground/history/${id}`);
      if (!res.ok) throw new Error('请求失败');
      const r = await res.json();
      this.renderHistoryModal(r);
    } catch (error) {
      console.error('加载详情失败:', error);
    }
  }

  renderHistoryModal(r) {
    const modal = document.getElementById('pgHistoryModal');
    const title = document.getElementById('pgHistoryModalTitle');
    const body = document.getElementById('pgHistoryModalBody');
    if (!modal || !title || !body) return;

    const time = new Date(r.createdAt).toLocaleString('zh-CN');
    title.textContent = `${r.model} - ${time}`;

    let html = '';

    // Stats section
    html += '<div class="pg-detail-section">';
    html += '<div class="pg-detail-section-title">统计信息</div>';
    html += '<div class="pg-detail-stats">';
    html += `<div class="pg-detail-stat"><div class="pg-detail-stat-label">输入 Tokens</div><div class="pg-detail-stat-value">${r.promptTokens?.toLocaleString() || 0}</div></div>`;
    html += `<div class="pg-detail-stat"><div class="pg-detail-stat-label">输出 Tokens</div><div class="pg-detail-stat-value">${r.completionTokens?.toLocaleString() || 0}</div></div>`;
    html += `<div class="pg-detail-stat"><div class="pg-detail-stat-label">总计 Tokens</div><div class="pg-detail-stat-value">${r.totalTokens?.toLocaleString() || 0}</div></div>`;
    html += `<div class="pg-detail-stat"><div class="pg-detail-stat-label">积分</div><div class="pg-detail-stat-value">${r.cost?.toFixed(4) || '0.0000'}</div></div>`;
    if (r.finishReason) {
      html += `<div class="pg-detail-stat"><div class="pg-detail-stat-label">结束原因</div><div class="pg-detail-stat-value">${r.finishReason}</div></div>`;
    }
    html += '</div></div>';

    // Request params section
    if (r.requestParams) {
      html += '<div class="pg-detail-section">';
      html += '<div class="pg-detail-section-title">请求参数</div>';
      html += '<div class="pg-detail-params">';
      const params = r.requestParams;
      if (params.temperature !== undefined) html += `<span class="pg-detail-param"><span class="pg-detail-param-label">temp:</span> ${params.temperature}</span>`;
      if (params.max_tokens) html += `<span class="pg-detail-param"><span class="pg-detail-param-label">max:</span> ${params.max_tokens}</span>`;
      if (params.top_p !== undefined) html += `<span class="pg-detail-param"><span class="pg-detail-param-label">top_p:</span> ${params.top_p}</span>`;
      if (params.thinking !== undefined) html += `<span class="pg-detail-param"><span class="pg-detail-param-label">thinking:</span> ${params.thinking ? 'on' : 'off'}</span>`;
      if (params.thinking_budget) html += `<span class="pg-detail-param"><span class="pg-detail-param-label">budget:</span> ${params.thinking_budget}</span>`;
      if (params.reasoning_effort) html += `<span class="pg-detail-param"><span class="pg-detail-param-label">effort:</span> ${params.reasoning_effort}</span>`;
      html += '</div></div>';
    }

    // Messages section
    html += '<div class="pg-detail-section">';
    html += '<div class="pg-detail-section-title">对话内容</div>';
    html += '<div class="pg-detail-messages">';

    if (r.messages && Array.isArray(r.messages)) {
      r.messages.forEach(msg => {
        if (msg.role === 'system') return;
        html += `<div class="pg-detail-msg ${msg.role}">`;
        html += `<div class="pg-detail-msg-role">${msg.role === 'user' ? '👤 用户' : '🤖 助手'}</div>`;
        html += `<div class="pg-detail-msg-content">${this.escapeHtml(msg.content || '')}</div>`;
        html += '</div>';
      });
    }

    // Reasoning content
    if (r.reasoningContent) {
      html += '<div class="pg-detail-msg reasoning">';
      html += '<div class="pg-detail-msg-role">💭 思考过程</div>';
      html += `<div class="pg-detail-msg-content">${this.escapeHtml(r.reasoningContent)}</div>`;
      html += '</div>';
    }

    html += '</div></div>';

    setHTML(body, html);
    modal.style.display = 'flex';
  }

  escapeHtml(value) {
    return Dom.escapeHtml(value);
  }
}

let pgApp;
document.addEventListener('DOMContentLoaded', () => {
  pgApp = new PlaygroundApp();
});
