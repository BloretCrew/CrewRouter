'use strict';

const { text } = require('./pages-common');
const { formatTime } = require('../lib/format');

function asRows(items, label, detail = () => '') {
  return items.map(item => ({
    label: label(item),
    detail: detail(item),
    run: async ctx => ctx.show('详情', JSON.stringify(item, null, 2)),
  }));
}

function collectionPage({ id, label, description, path, pick, map, actions = [] }) {
  return {
    id, label, description,
    async load(api) {
      const payload = await api(path);
      const items = pick(payload);
      return {
        sections: [{
          title: label,
          description: `${items.length} 项 · 选择条目查看详情。`,
          rows: items.length ? asRows(items, map.label, map.detail) : [{ label: `暂无${label}数据。` }],
        }],
        actions: [{ label: '刷新', run: ctx => ctx.refresh() }, ...actions],
      };
    },
  };
}

const array = value => Array.isArray(value) ? value : [];
const itemsOf = payload => Array.isArray(payload) ? payload : array(payload && (payload.items || payload.records || payload.data));
const display = (...values) => values.map(value => String(value || '').trim()).filter(Boolean).join(' · ');

function createAdminPages(runtime) {
  const adminOnly = page => ({ ...page, async load(api) {
    if (runtime.client.isAdmin !== true) {
      return { sections: [{ title: page.label, rows: [{ label: '需要已验证的管理员会话。请使用管理员密码登录并重新打开此页面。' }] }], actions: [] };
    }
    return page.load(api);
  } });

  return [
    {
      id: 'home', label: '首页', description: '控制台首页摘要。',
      async load(api) {
        const data = await api('/api/user/stats', { query: { days: 30 } });
        const summary = data && data.summary || {};
        return { sections: [{ title: '统计摘要', cards: [
          { label: '请求', value: text(summary.total_requests, '0') },
          { label: 'Token', value: text(summary.total_tokens, '0') },
          { label: '费用', value: text(summary.total_cost, '0') },
          { label: '平均延迟', value: `${Math.round(Number(summary.avg_latency || 0))} ms` },
        ], rows: [{ label: '最近 30 天的账户用量与模型统计。' }] }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    },
    {
      id: 'projects', label: '项目工作', description: '按项目查看 AI 工作活动、活跃天数和 Token 投入。',
      async load(api) {
        const days = runtime.projectDays || 30;
        const source = runtime.projectSource || '';
        const data = await api('/api/user/project-stats', { query: { days, ...(source ? { request_source: source } : {}) } });
        const summary = data.summary || {};
        const projects = array(data.projects);
        return { sections: [
          { title: '项目工作摘要', cards: [
            { label: '活跃项目', value: text(summary.projects, '0') }, { label: '活跃天数', value: text(summary.active_days, '0') },
            { label: 'AI 请求', value: text(summary.requests, '0') }, { label: 'Token', value: text(summary.tokens, '0') },
            { label: '最近活动', value: summary.last_activity ? formatTime(summary.last_activity) : '—' },
          ], rows: summary.analysis_status ? [{ label: `待整理请求：${summary.analysis_status.pending_requests || 0}` }] : [] },
          { title: '最近活跃项目', rows: projects.slice(0, 4).map((item, index) => ({ label: display(`#${index + 1}`, item.workspace_path), detail: display(`${item.requests || 0} 请求`, `${item.tokens || 0} tokens`, item.last_activity && formatTime(item.last_activity)) })) },
          { title: '项目工作台', rows: projects.length ? projects.map(item => ({ label: item.workspace_path || '未知工作区', detail: display(`${item.requests || 0} 请求`, `${item.tokens || 0} tokens`, `${item.active_days || 0} 活跃天`, `积分 ${item.cost || 0}`, Object.keys(item.sources || {}).join(', ')) })) : [{ label: '暂无项目活动。' }] },
          { title: '每日活动', rows: array(data.daily).slice(-30).map(item => ({ label: display(item.date, `${item.requests || 0} 请求`, `${item.projects || 0} 项目`) })) },
        ], actions: [
          ...[7, 30, 90, 180, 365].map(value => ({ label: `最近 ${value} 天`, run: async ctx => { runtime.projectDays = value; await ctx.refresh(); } })),
          ...['', 'claude_code', 'codex', 'opencode', 'grok', 'qwen_code'].map(value => ({ label: value ? `客户端：${value}` : '全部客户端', run: async ctx => { runtime.projectSource = value; await ctx.refresh(); } })),
          { label: '自定义日期范围', run: async ctx => { const dates = await ctx.form('自定义日期范围', [{ name: 'start', label: '开始日期（YYYY-MM-DD）' }, { name: 'end', label: '结束日期（YYYY-MM-DD）' }]); if (!dates) return; const result = await api('/api/user/project-stats', { query: { start: dates.start, end: dates.end, ...(source ? { request_source: source } : {}) } }); runtime.projectResult = result; ctx.notify('日期范围查询完成；刷新可恢复预设范围。'); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    {
      id: 'leaderboard', label: '排行榜', description: '查看全站用户使用数据排行。',
      async load(api) {
        const days = runtime.leaderboardDays || 30;
        const sort = runtime.leaderboardSort || 'tokens';
        const data = await api('/api/user/leaderboard', { query: { days, sort } });
        const items = array(data && data.leaderboard);
        return { sections: [{ title: '排行榜', description: `最近 ${days} 天 · 按 ${sort} 排序`, rows: items.length ? items.map((item, index) => ({ label: display(`#${index + 1}`, item.username, `${Number(item.totalRequests || 0).toLocaleString()} 请求`, `${item.totalTokens || 0} tokens`), detail: display(`${Number(item.totalPoints || 0).toFixed(2)} 积分`, `${item.cacheHitRate || 0}% 缓存命中`, `余额 ${item.balance || 0}`) })) : [{ label: '暂无排行数据。' }] }], actions: [
          ...[7, 30, 90, 365].map(value => ({ label: `最近 ${value} 天`, run: async ctx => { runtime.leaderboardDays = value; await ctx.refresh(); } })),
          ...[['tokens', '按 Token 排序'], ['requests', '按请求排序'], ['points', '按积分排序'], ['cache', '按缓存命中率排序'], ['balance', '按余额排序']].map(([value, label]) => ({ label, run: async ctx => { runtime.leaderboardSort = value; await ctx.refresh(); } })),
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    {
      id: 'audit-logs', label: '操作日志', description: '查看当前账号的操作记录。',
      async load(api) {
        const page = runtime.userAuditPage || 1;
        const action = runtime.userAuditAction || '';
        const data = await api('/api/user/audit-logs', { query: { page, limit: 50, action } });
        const items = array(data && data.items);
        return { sections: [{ title: '操作日志', description: `第 ${data.page || page} 页 · 共 ${data.total || 0} 条 · ${action || '全部操作'}`, rows: items.map(item => ({ label: display(formatTime(item.created_at), item.action, item.resource_type), detail: display(item.description, item.status, item.ip_address) })) }], actions: [
          ...[['', '全部操作'], ['api_key', 'API Key'], ['cokey', 'Co-Key'], ['user', '用户'], ['auth', '认证'], ['provider', '供应商'], ['model', '模型']].map(([value, label]) => ({ label, run: async ctx => { runtime.userAuditAction = value; runtime.userAuditPage = 1; await ctx.refresh(); } })),
          { label: '上一页', run: async ctx => { runtime.userAuditPage = Math.max(1, page - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.userAuditPage = page + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    adminOnly({
      id: 'admin-users', label: '用户管理', description: '管理员用户列表与基础账户管理。',
      async load(api) {
        const page = runtime.adminUsersPage || 1;
        const search = runtime.adminUsersSearch || '';
        const data = await api('/api/admin/users', { query: { page, limit: 30, q: search } });
        const items = array(data && (data.items || data));
        return { sections: [{ title: '用户管理', description: `第 ${data.page || page} 页 · 共 ${data.total || items.length} 个用户`, rows: items.map(item => ({ label: display(item.username, item.email, item.is_admin ? '管理员' : '用户'), detail: display(item.team_name || item.team_id, item.enabled === false ? '禁用' : '启用', `余额 ${item.balance ?? '—'}`), run: async ctx => {
          const choice = await ctx.choose(`用户 · ${item.username || item.id}`, [
            { label: '查看详情', value: 'detail' }, { label: '修改用户', value: 'edit' }, { label: '查看余额记录', value: 'balance' }, { label: '退款', value: 'refund' },
          ]);
          if (choice === 'detail') await ctx.show('用户详情', JSON.stringify(item, null, 2));
          if (choice === 'edit') {
            const values = await ctx.form('修改用户', [
              { name: 'email', label: '邮箱', value: item.email || '' },
              { name: 'isAdmin', label: '管理员', type: 'boolean', value: item.is_admin === true },
              { name: 'balance', label: '余额（留空不修改）', value: '' },
              { name: 'team_id', label: 'Team ID（留空不修改）', value: '' },
            ]);
            if (!values) return;
            const body = { email: values.email, isAdmin: values.isAdmin };
            if (values.balance !== '') body.balance = Number(values.balance);
            if (values.team_id !== '') body.team_id = Number(values.team_id);
            await api(`/api/admin/users/${encodeURIComponent(item.id)}`, { method: 'PUT', body });
            ctx.notify('用户已更新。'); await ctx.refresh();
          }
          if (choice === 'balance') { const balances = await api(`/api/admin/users/${encodeURIComponent(item.id)}/code-balances`); await ctx.show('余额记录', JSON.stringify(balances, null, 2)); }
          if (choice === 'refund') { const amount = await ctx.ask('退款金额', { description: '请确认金额和目标用户。' }); if (!amount || !await ctx.confirm('确认退款', `向 ${item.username} 退款 ${amount}？`)) return; const result = await api(`/api/admin/users/${encodeURIComponent(item.id)}/refund`, { method: 'POST', body: { amount: Number(amount) } }); await ctx.show('退款结果', JSON.stringify(result, null, 2)); await ctx.refresh(); }
        } })) }], actions: [
          { label: '搜索用户', run: async ctx => { runtime.adminUsersSearch = String(await ctx.ask('用户名或邮箱') || '').trim(); runtime.adminUsersPage = 1; await ctx.refresh(); } },
          { label: '上一页', run: async ctx => { runtime.adminUsersPage = Math.max(1, page - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.adminUsersPage = page + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),

    adminOnly({
      id: 'admin-error-logs', label: '调用错误', description: '管理员错误记录，支持筛选、分页和查看详情。',
      async load(api) {
        const page = runtime.errorPage || 1;
        const filters = runtime.errorFilters || {};
        const data = await api('/api/admin/error-logs', { query: { page, limit: 30, ...filters } });
        const items = array(data && data.logs);
        return { sections: [{ title: '调用错误', description: `第 ${data.page || page} 页 · 共 ${data.total || 0} 条 · 保留 ${data.retention_days || '—'} 天`, rows: items.map(item => ({ label: display(formatTime(item.created_at), item.model_name || item.model_id, item.provider_name, `${item.status_code || ''} ${item.error_type || ''}`), detail: display(item.error_message, item.username, item.latency_ms && `${item.latency_ms} ms`), run: async ctx => await ctx.show('错误详情', JSON.stringify(item, null, 2)) })) }], actions: [
          { label: '筛选错误类型', run: async ctx => { const value = await ctx.ask('错误类型（留空全部）', { defaultValue: filters.error_type || '' }); if (value !== null) { runtime.errorFilters = { ...filters, error_type: String(value).trim() }; runtime.errorPage = 1; await ctx.refresh(); } } },
          { label: '仅最终错误', run: async ctx => { runtime.errorFilters = { ...filters, final_only: filters.final_only === '1' ? '' : '1' }; runtime.errorPage = 1; await ctx.refresh(); } },
          { label: '筛选状态码', run: async ctx => { const value = await ctx.ask('HTTP 状态码（留空全部）', { defaultValue: filters.status_code || '' }); if (value !== null) { runtime.errorFilters = { ...filters, status_code: String(value).trim() }; runtime.errorPage = 1; await ctx.refresh(); } } },
          { label: '筛选模型', run: async ctx => { const value = await ctx.ask('模型名称或 ID（留空全部）', { defaultValue: filters.model_q || '' }); if (value !== null) { runtime.errorFilters = { ...filters, model_q: String(value).trim() }; runtime.errorPage = 1; await ctx.refresh(); } } },
          { label: '筛选用户', run: async ctx => { const value = await ctx.ask('用户名或用户 ID（留空全部）', { defaultValue: filters.user_q || '' }); if (value !== null) { runtime.errorFilters = { ...filters, user_q: String(value).trim() }; runtime.errorPage = 1; await ctx.refresh(); } } },
          { label: '清除筛选', run: async ctx => { runtime.errorFilters = {}; runtime.errorPage = 1; await ctx.refresh(); } },
          { label: '上一页', run: async ctx => { runtime.errorPage = Math.max(1, page - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.errorPage = page + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),

    {
      id: 'prompts', label: '提示词', description: '历史提示词与注入提示词。',
      async load(api) {
        const page = runtime.promptPage || 1;
        const search = runtime.promptSearch || '';
        const source = runtime.promptSource || '';
        const sort = runtime.promptSort || 'count';
        const [history, injected] = await Promise.allSettled([
          api('/api/user/custom-instructions', { query: { page, pageSize: 20, search, source, sort } }),
          api('/api/user/inject-prompts'),
        ]);
        const historyData = history.status === 'fulfilled' ? history.value : {};
        const promptItems = array(historyData.items);
        const injectedItems = injected.status === 'fulfilled' ? itemsOf(injected.value) : [];
        return { sections: [
          { title: '历史提示词', description: `共 ${historyData.total || 0} 条 · 第 ${historyData.page || page} 页`, rows: promptItems.length ? promptItems.map(item => ({ label: display(item.file, item.source, `${item.chars || 0} 字符`, `${item.occurrence_count || 0} 次`), detail: display(item.preview, formatTime(item.first_seen), formatTime(item.last_seen)), run: async ctx => { const detail = await api(`/api/user/custom-instructions/${encodeURIComponent(item.fingerprint)}`); await ctx.show(`提示词 · ${item.file || '未知文件'}`, JSON.stringify(detail, null, 2)); } })) : [{ label: history.status === 'rejected' ? history.reason.message : '暂无历史提示词。' }] },
          { title: '注入提示词', rows: injectedItems.length ? injectedItems.map(item => ({ label: display(item.name, item.enabled === false ? '停用' : '启用'), detail: display(item.description, item.content && `${String(item.content).length} 字符`), run: async ctx => await ctx.show(`注入提示词 · ${item.name || item.id}`, JSON.stringify(item, null, 2)) })) : [{ label: injected.status === 'rejected' ? injected.reason.message : '暂无注入提示词。' }] },
        ], actions: [
          { label: '搜索历史提示词', run: async ctx => { runtime.promptSearch = String(await ctx.ask('搜索文件或内容', { defaultValue: search }) || '').trim(); runtime.promptPage = 1; await ctx.refresh(); } },
          { label: '筛选客户端来源', run: async ctx => { const value = await ctx.choose('客户端来源', [{ label: '全部', value: '' }, ...['claude_code', 'codex', 'opencode', 'grok', 'qwen_code', 'unknown'].map(item => ({ label: item, value: item }))]); if (value !== null) { runtime.promptSource = value; runtime.promptPage = 1; await ctx.refresh(); } } },
          ...[['count', '按出现次数'], ['last_seen', '按最近出现'], ['first_seen', '按首次出现']].map(([value, label]) => ({ label, run: async ctx => { runtime.promptSort = value; await ctx.refresh(); } })),
          { label: '上一页', run: async ctx => { runtime.promptPage = Math.max(1, page - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.promptPage = page + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    adminOnly(collectionPage({ id: 'admin-plugins', label: '插件管理', description: '插件管理由 CrewRouter 插件系统托管；此页列出服务端可见插件。', path: '/api/admin/plugins', pick: itemsOf,
      map: { label: item => display(item.name, item.id, item.version), detail: item => display(item.enabled === false ? '停用' : '启用', item.description) } })),
    adminOnly({
      id: 'admin-prompts', label: '管理员提示词', description: '管理员可查看全局历史提示词。',
      async load(api) {
        const page = runtime.adminPromptPage || 1;
        const search = runtime.adminPromptSearch || '';
        const source = runtime.adminPromptSource || '';
        const sort = runtime.adminPromptSort || 'count';
        const data = await api('/api/admin/custom-instructions', { query: { page, pageSize: 20, search, source, sort } });
        const items = array(data && data.items);
        return { sections: [{ title: '管理员提示词', description: `共 ${data.total || 0} 条 · 第 ${data.page || page} 页`, rows: items.map(item => ({ label: display(item.file, item.source, `${item.chars || 0} 字符`, `${item.occurrence_count || 0} 次`), detail: display(item.preview, item.first_seen && formatTime(item.first_seen), item.last_seen && formatTime(item.last_seen)), run: async ctx => { const detail = await api(`/api/admin/custom-instructions/${encodeURIComponent(item.fingerprint)}`); await ctx.show(`提示词 · ${item.file || '未知文件'}`, JSON.stringify(detail, null, 2)); } })) }], actions: [
          { label: '搜索提示词', run: async ctx => { runtime.adminPromptSearch = String(await ctx.ask('搜索文件或内容', { defaultValue: search }) || '').trim(); runtime.adminPromptPage = 1; await ctx.refresh(); } },
          ...[['count', '按出现次数'], ['last_seen', '按最近出现'], ['first_seen', '按首次出现']].map(([value, label]) => ({ label, run: async ctx => { runtime.adminPromptSort = value; await ctx.refresh(); } })),
          { label: '上一页', run: async ctx => { runtime.adminPromptPage = Math.max(1, page - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.adminPromptPage = page + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-models', label: '模型管理', description: '管理员模型的独立管理视图。',
      async load(api) {
        const data = await api('/api/admin/models', { query: { page: runtime.adminModelPage || 1, limit: 30, q: runtime.adminModelSearch || '' } });
        const items = array(data && (data.items || data));
        return { sections: [{ title: '模型管理', description: `第 ${data.page || runtime.adminModelPage || 1} 页 · 共 ${data.total || items.length} 个`, rows: items.map(item => ({ label: display(item.name, item.alias, item.id), detail: display(item.provider_name || item.provider, item.enabled === false ? '停用' : '启用', item.description), run: async ctx => {
          const choice = await ctx.choose('模型操作', [{ label: '查看详情', value: 'detail' }, { label: '测试模型', value: 'test' }, { label: item.enabled === false ? '启用' : '停用', value: 'toggle' }]);
          if (choice === 'detail') await ctx.show(`模型 · ${item.name || item.id}`, JSON.stringify(item, null, 2));
          if (choice === 'test') { const result = await api(`/api/admin/models/${encodeURIComponent(item.id)}/test`, { method: 'POST', body: {} }); await ctx.show('模型测试', JSON.stringify(result, null, 2)); }
          if (choice === 'toggle') { const enabled = item.enabled === false; if (!await ctx.confirm(enabled ? '启用模型' : '停用模型', item.name || item.id)) return; await api('/api/admin/models/batch-update', { method: 'POST', body: { ids: [item.id], enabled } }); await ctx.refresh(); }
        } })) }], actions: [
          { label: '搜索模型', run: async ctx => { runtime.adminModelSearch = String(await ctx.ask('模型搜索', { defaultValue: runtime.adminModelSearch || '' }) || '').trim(); runtime.adminModelPage = 1; await ctx.refresh(); } },
          { label: '上一页', run: async ctx => { runtime.adminModelPage = Math.max(1, (runtime.adminModelPage || 1) - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.adminModelPage = (runtime.adminModelPage || 1) + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),

    adminOnly({
      id: 'admin-audit-logs', label: '管理员操作日志', description: '管理员全局操作记录。',
      async load(api) {
        const page = runtime.adminAuditPage || 1;
        const search = runtime.adminAuditSearch || '';
        const resourceType = runtime.adminAuditResourceType || '';
        const data = await api('/api/admin/audit-logs', { query: { page, limit: 50, q: search, resource_type: resourceType } });
        const items = array(data && data.items);
        return { sections: [{ title: '管理员操作日志', description: `第 ${data.page || page} 页 · 共 ${data.total || 0} 条`, rows: items.map(item => ({ label: display(formatTime(item.created_at), item.username, item.action, item.resource_type), detail: display(item.description, item.status, item.ip_address) })) }], actions: [
          { label: '搜索日志', run: async ctx => { runtime.adminAuditSearch = String(await ctx.ask('用户名或操作说明', { defaultValue: search }) || '').trim(); runtime.adminAuditPage = 1; await ctx.refresh(); } },
          { label: '筛选资源类型', run: async ctx => { const value = await ctx.choose('资源类型', [{ label: '全部', value: '' }, ...['api_key', 'user', 'provider', 'model', 'team', 'policy', 'plugin'].map(item => ({ label: item, value: item }))]); if (value !== null) { runtime.adminAuditResourceType = value; runtime.adminAuditPage = 1; await ctx.refresh(); } } },
          { label: '上一页', run: async ctx => { runtime.adminAuditPage = Math.max(1, page - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.adminAuditPage = page + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    {
      id: 'model-library', label: '模型库', description: '网页模型库：搜索、查看供应商标签，并管理当前 API Key 的模型队列。',
      async load(api) {
        const [libraryResult, keysResult, tagsResult] = await Promise.allSettled([
          api('/api/user/model-library'), api('/api/user/api-keys'), api('/api/user/provider-tags'),
        ]);
        const library = libraryResult.status === 'fulfilled' ? libraryResult.value : {};
        const models = array(library && (library.models || library.items || library));
        const keys = keysResult.status === 'fulfilled' ? itemsOf(keysResult.value) : [];
        const tags = tagsResult.status === 'fulfilled' ? itemsOf(tagsResult.value) : [];
        const keyId = runtime.libraryKeyId || (keys[0] && keys[0].id);
        const assignedResult = keyId ? await Promise.allSettled([api(`/api/user/api-keys/${encodeURIComponent(keyId)}/models`)]) : [];
        const assignedData = assignedResult[0]?.status === 'fulfilled' ? assignedResult[0].value : {};
        const assignedIds = new Set(array(assignedData.queue).map(item => String(item.model_id || item.id)));
        let visible = models;
        if (runtime.librarySearch) {
          const q = runtime.librarySearch.toLowerCase();
          visible = visible.filter(item => [item.name, item.id, item.model_id, item.series, item.provider, item.provider_name].some(value => String(value || '').toLowerCase().includes(q)));
        }
        if (runtime.libraryTag && runtime.libraryTag !== 'all') visible = visible.filter(item => String(item.provider_tag_id || item.tag_id || item.series || '') === String(runtime.libraryTag));
        const sections = [
          { title: '当前 Key 模型队列', description: keys.length ? `当前 Key：${keys.find(key => String(key.id) === String(keyId))?.name || keyId}` : '先创建 API Key 后可编辑模型队列。', rows: array(assignedData.queue).map((item, index) => ({ label: display(`${index + 1}.`, item.name, item.provider, item.series), detail: item.model_id || item.id })) },
          { title: '模型目录', description: `显示 ${visible.length} / ${models.length} 个 · 标签 ${tags.length} 个`, rows: visible.map(item => ({ label: display(item.name, item.series, item.provider_name || item.provider, assignedIds.has(String(item.model_id || item.id)) ? '已绑定' : '未绑定'), detail: display(item.model_id || item.id, item.description, item.input_price_per_1k_tokens && `输入价 ${item.input_price_per_1k_tokens}`, item.output_price_per_1k_tokens && `输出价 ${item.output_price_per_1k_tokens}`), run: async ctx => {
            if (!keyId) { await ctx.show('模型绑定', '请先创建 API Key。'); return; }
            const id = String(item.model_id || item.id);
            const next = new Set(assignedIds);
            if (next.has(id)) next.delete(id); else next.add(id);
            const ordered = [...next];
            if (!await ctx.confirm(next.has(id) ? '绑定模型' : '解绑模型', `${keys.find(key => String(key.id) === String(keyId))?.name || keyId}\n${item.name || id}`)) return;
            await api(`/api/user/api-keys/${encodeURIComponent(keyId)}/models`, { method: 'PUT', body: { modelIds: ordered } });
            ctx.notify('模型队列已保存。'); await ctx.refresh();
          } })) },
          ...(libraryResult.status === 'rejected' ? [{ title: '加载失败', rows: [{ label: libraryResult.reason.message || '模型目录不可用' }] }] : []),
        ];
        return { sections, actions: [
          { label: '搜索模型', run: async ctx => { runtime.librarySearch = String(await ctx.ask('搜索模型、系列或供应商', { defaultValue: runtime.librarySearch || '' }) || '').trim(); await ctx.refresh(); } },
          { label: '选择 API Key', run: async ctx => { if (!keys.length) { await ctx.show('选择 API Key', '当前账户还没有 API Key。'); return; } const choice = await ctx.choose('选择 API Key', keys.map(key => ({ label: `${key.name || key.key_prefix || key.id} · ${key.current_model_name || key.current_model_id || '未绑定'}`, value: key.id }))); if (choice !== null) { runtime.libraryKeyId = choice; await ctx.refresh(); } } },
          ...tags.slice(0, 15).map(tag => ({ label: `标签：${tag.name || tag.id}`, run: async ctx => { runtime.libraryTag = tag.id || tag.name; await ctx.refresh(); } })),
          { label: '清除标签筛选', run: async ctx => { runtime.libraryTag = 'all'; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    adminOnly(collectionPage({ id: 'admin-model-library', label: '模型库管理', description: '管理员模型库视图。', path: '/api/admin/model-library', pick: itemsOf,
      map: { label: item => display(item.name, item.id, item.provider_name), detail: item => display(item.series, item.enabled === false ? '停用' : '启用', item.description) } })),
    adminOnly({
      id: 'admin-teams', label: '团队管理', description: '管理 Team、成员与请求限额规则。',
      async load(api) {
        const teams = itemsOf(await api('/api/admin/teams'));
        const sections = await Promise.all(teams.map(async team => {
          const [members, rules] = await Promise.allSettled([
            api(`/api/admin/teams/${encodeURIComponent(team.id)}/members`),
            api(`/api/admin/teams/${encodeURIComponent(team.id)}/rules`),
          ]);
          const memberItems = members.status === 'fulfilled' ? itemsOf(members.value) : [];
          const ruleItems = rules.status === 'fulfilled' ? itemsOf(rules.value) : [];
          return {
            title: `${team.name} · Team #${team.id}`,
            description: display(team.is_default && '默认 Team', team.is_frontier && '前沿 Team', `${team.member_count || memberItems.length} 成员`, team.description),
            rows: [
              ...memberItems.map(member => ({ label: `成员 · ${member.username}`, detail: display(member.email, member.created_at && formatTime(member.created_at)), run: async ctx => {
                if (!await ctx.confirm('移除 Team 成员', `将 ${member.username} 从 ${team.name} 移出？`)) return;
                await api(`/api/admin/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
                ctx.notify('成员已移出 Team。'); await ctx.refresh();
              } })),
              ...ruleItems.map(rule => ({ label: `限额 · ${rule.rule_type} ${rule.rule_value} / ${rule.duration_hours} 小时`, detail: rule.description || rule.id, run: async ctx => { if (!await ctx.confirm('删除限额规则', `${team.name} · ${rule.rule_type} ${rule.rule_value}`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' }); await ctx.refresh(); } })),
            ],
            actions: [
              { label: `编辑 ${team.name}`, run: async ctx => { const values = await ctx.form('编辑 Team', [{ name: 'name', label: '名称', value: team.name }, { name: 'description', label: '说明', value: team.description || '' }, { name: 'is_default', label: '默认 Team', type: 'boolean', value: team.is_default === true }, { name: 'is_frontier', label: '前沿 Team', type: 'boolean', value: team.is_frontier === true }]); if (!values) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}`, { method: 'PUT', body: values }); ctx.notify('Team 已更新。'); await ctx.refresh(); } },
              { label: `添加成员到 ${team.name}`, run: async ctx => { const input = await ctx.ask('用户 ID（多个以逗号分隔）'); if (!input) return; const userIds = String(input).split(',').map(value => Number(value.trim())).filter(Number.isInteger); if (!userIds.length || !await ctx.confirm('添加 Team 成员', `Team：${team.name}\n用户 ID：${userIds.join(', ')}`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}/members`, { method: 'POST', body: { userIds } }); ctx.notify('成员已添加。'); await ctx.refresh(); } },
              { label: `新增 ${team.name} 限额规则`, run: async ctx => { const values = await ctx.form('新增 Team 限额规则', [{ name: 'rule_type', label: '类型', value: 'requests', options: ['requests', 'tokens'] }, { name: 'rule_value', label: '限额值' }, { name: 'duration_hours', label: '时间窗口小时数', value: '24' }, { name: 'description', label: '说明' }]); if (!values) return; if (!await ctx.confirm('添加 Team 限额', `${team.name}\n${values.rule_type} ${values.rule_value} / ${values.duration_hours} 小时`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}/rules`, { method: 'POST', body: { ...values, rule_value: Number(values.rule_value), duration_hours: Number(values.duration_hours) } }); await ctx.refresh(); } },
              { label: `删除 ${team.name}`, run: async ctx => { if (!await ctx.confirm('删除 Team', `删除「${team.name}」？若仍有关联成员，服务端会拒绝。`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}`, { method: 'DELETE' }); ctx.notify('Team 已删除。'); await ctx.refresh(); } },
            ],
          };
        }));
        return { sections: sections.length ? sections : [{ title: '团队管理', rows: [{ label: '暂无 Team。' }] }], actions: [
          { label: '创建 Team', run: async ctx => { const values = await ctx.form('创建 Team', [{ name: 'name', label: '名称' }, { name: 'description', label: '说明' }]); if (!values || !String(values.name || '').trim()) return; if (!await ctx.confirm('创建 Team', values.name)) return; await api('/api/admin/teams', { method: 'POST', body: values }); ctx.notify('Team 已创建。'); await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),

    adminOnly({
      id: 'blora-agent', label: 'Blora Agent', description: '管理员对话与运行记录。',
      async load(api) {
        const threads = await api('/api/agent/manage/threads');
        const items = array(threads);
        return { sections: [{ title: '管理对话', rows: items.length ? items.map(item => ({ label: display(item.title || `对话 #${item.id}`, item.model_id), detail: display(formatTime(item.updated_at), formatTime(item.created_at)), run: async ctx => { const detail = await api(`/api/agent/manage/threads/${encodeURIComponent(item.id)}`); const messages = array(detail.messages).map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`).join('\\n\\n'); await ctx.show(`Blora Agent · ${item.title || item.id}`, messages || '暂无消息。'); } })) : [{ label: '暂无管理对话。' }] }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
    adminOnly({
      id: 'admin-stats', label: '管理统计', description: '全局请求与用量统计。',
      async load(api) {
        const data = await api('/api/admin/stats', { query: { days: 30 } });
        const daily = array(data && data.daily);
        const cards = [
          { label: '用户', value: text(data && data.users, '0') },
          { label: '模型', value: text(data && data.models, '0') },
          { label: 'API Key', value: text(data && data.apiKeys, '0') },
          { label: '周期', value: `${text(data && data.days, '自定义')} 天` },
        ];
        return { sections: [
          { title: '统计概览', cards },
          { title: '每日用量', rows: daily.slice(-30).map(item => ({ label: display(item.date, `${item.requests || 0} 请求`, `${item.tokens || 0} tokens`, `费用 ${item.cost || 0}`) })) },
          { title: '按模型', rows: array(data && data.byModel).slice(0, 30).map(item => ({ label: display(item.model_name || item.model_id, `${item.requests || 0} 请求`, `${item.tokens || 0} tokens`, `费用 ${item.cost || 0}`) })) },
          { title: '按用户', rows: array(data && data.byUser).slice(0, 30).map(item => ({ label: display(item.user_name, `${item.requests || 0} 请求`, `${item.tokens || 0} tokens`) })) },
          { title: '按 Team', rows: array(data && data.byTeam).slice(0, 30).map(item => ({ label: display(item.team_name, `${item.requests || 0} 请求`, `${item.tokens || 0} tokens`) })) },
        ], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
    {
      id: 'balance', label: '积分', description: '当前积分、可退款余额、Team 与个人限额。',
      async load(api) {
        const data = await api('/api/user/balance');
        const group = data && data.group || {};
        const rules = array(group.rules);
        return { sections: [
          { title: '当前积分', cards: [{ label: '积分', value: text(data && data.balance, '0') }, { label: '可退款', value: text(data && data.refund_balance, '0') }] },
          { title: 'Team 与个人限额', rows: [
            { label: `Team：${text(group.name, '未分配')}` },
            { label: `个人速率限制：${Number(data && data.rate_limit_rpm || 0)} RPM · ${Number(data && data.rate_limit_tpm || 0)} TPM` },
            ...rules.map(rule => ({ label: `${rule.rule_type === 'requests' ? '请求' : 'Token'} 限额：${rule.rule_value} / ${rule.duration_hours || 24} 小时`, detail: `当前用量 ${rule.current || 0}${rule.rule_type === 'requests' ? ' 请求' : ' tokens'}${rule.description ? ` · ${rule.description}` : ''}` })),
          ] },
        ], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    },
    {
      id: 'settings', label: '用户设置', description: '网页个人设置页面。',
      async load(api) {
        const [signature, profile] = await Promise.allSettled([api('/api/user/signature'), api('/auth/me')]);
        const signatureData = signature.status === 'fulfilled' ? signature.value : {};
        const user = profile.status === 'fulfilled' ? profile.value : {};
        return { sections: [
          { title: '账户资料', rows: [{ label: `用户名：${text(user.username)}` }, { label: `邮箱：${text(user.email)}` }, ...(profile.status === 'rejected' ? [{ label: profile.reason.message || '账户资料暂不可用' }] : [])] },
          { title: 'API 签名', rows: [{ label: `状态：${signatureData.enabled ? '已启用' : '未启用'}` }, { label: `模板：${text(signatureData.template, '默认模板')}` }, ...(signature.status === 'rejected' ? [{ label: signature.reason.message || '签名设置暂不可用' }] : [])] },
        ], actions: [
          { label: signatureData.enabled ? '关闭 API 签名' : '开启 API 签名', run: async ctx => { await api('/api/user/signature', { method: 'PUT', body: { enabled: !signatureData.enabled, template: signatureData.template } }); ctx.notify('签名设置已更新。'); await ctx.refresh(); } },
          { label: '修改邮箱', run: async ctx => { const email = await ctx.ask('新邮箱地址', { defaultValue: user.email || '' }); if (email === null) return; await api('/api/user/settings', { method: 'PUT', body: { email } }); ctx.notify('邮箱设置已更新。'); await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    adminOnly({
      id: 'admin-settings', label: '系统设置', description: '常规、请求采集、Agent 资料与数据保留配置。',
      async load(api) {
        const [generalResult, quotaResult, agentResult, retentionResult, feishuResult] = await Promise.allSettled([
          api('/api/admin/settings'), api('/api/admin/request-quota-config'), api('/api/admin/agent-web'), api('/api/admin/retention-config'), api('/api/admin/feishu-login'),
        ]);
        const general = generalResult.status === 'fulfilled' ? generalResult.value : {};
        const quota = quotaResult.status === 'fulfilled' ? quotaResult.value : {};
        const agent = agentResult.status === 'fulfilled' ? agentResult.value : {};
        const retention = retentionResult.status === 'fulfilled' ? retentionResult.value : {};
        const feishu = feishuResult.status === 'fulfilled' ? feishuResult.value : {};
        const toRows = (object, error) => error ? [{ label: error.message || '读取失败' }] : Object.entries(object || {}).map(([key, value]) => ({ label: `${key}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}` }));
        return { sections: [
          { title: '常规设置', rows: toRows({ stats_refresh_interval_sec: general.stats_refresh_interval_sec, model_list: general.model_list, site_name: general.site_name, default_quota: general.default_quota }, generalResult.status === 'rejected' ? generalResult.reason : null) },
          { title: '请求采集', rows: toRows(quota, quotaResult.status === 'rejected' ? quotaResult.reason : null) },
          { title: 'Agent Web（密钥已脱敏）', rows: toRows(agent, agentResult.status === 'rejected' ? agentResult.reason : null) },
          { title: '数据保留', rows: toRows(retention, retentionResult.status === 'rejected' ? retentionResult.reason : null) },
          { title: '飞书登录（密钥已脱敏）', rows: toRows(feishu, feishuResult.status === 'rejected' ? feishuResult.reason : null) },
        ], actions: [
          { label: '编辑常规设置', run: async ctx => { const values = await ctx.form('编辑常规设置', [
            { name: 'stats_refresh_interval_sec', label: '统计刷新间隔秒数（3-300）', value: String(general.stats_refresh_interval_sec || 10) },
            { name: 'site_name', label: '系统名称', value: String(general.site_name || '') },
            { name: 'model_list', label: '模型 ID 列表（逗号分隔）', value: Array.isArray(general.model_list) ? general.model_list.join(',') : '' },
          ]); if (!values) return; const seconds = Number(values.stats_refresh_interval_sec); if (!Number.isInteger(seconds) || seconds < 3 || seconds > 300) { await ctx.show('刷新间隔无效', '刷新间隔需为 3 到 300 秒的整数。'); return; } const models = values.model_list.split(',').map(value => value.trim()).filter(Boolean); if (models.length && models.every(value => value === 'fusion')) { await ctx.show('模型列表无效', '至少保留一个非 Fusion 模型。'); return; } if (!await ctx.confirm('保存常规设置', `间隔 ${seconds} 秒\n系统名称：${values.site_name || '(空)'}\n模型数：${models.length}`)) return; await api('/api/admin/settings', { method: 'PUT', body: { stats_refresh_interval_sec: seconds, ...(values.site_name ? { site_name: values.site_name } : {}), model_list: models } }); ctx.notify('系统设置已保存。'); await ctx.refresh(); } },
          { label: '编辑请求采集配置', run: async ctx => { const numericFields = new Set(['reconciliation_seconds', 'max_tries', 'worker_interval_ms', 'batch_size', 'lease_seconds']); const values = await ctx.form('编辑请求采集配置', Object.entries(quota).map(([name, value]) => ({ name, label: name, value: typeof value === 'boolean' ? value : String(value ?? ''), ...(typeof value === 'boolean' ? { type: 'boolean' } : {}) }))); if (!values) return; const body = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, numericFields.has(key) ? Number(value) : value])); if (!await ctx.confirm('保存请求采集配置', JSON.stringify(body))) return; await api('/api/admin/request-quota-config', { method: 'PUT', body }); ctx.notify('请求采集配置已保存。'); await ctx.refresh(); } },
          { label: '编辑 Agent Web 配置', run: async ctx => { const search = agent.search || {}; const fetch = agent.fetch || {}; const values = await ctx.form('编辑 Agent Web 配置', [
            { name: 'search_enabled', label: '启用联网搜索', type: 'boolean', value: search.enabled === true },
            { name: 'provider', label: '搜索提供方', value: search.provider || '', options: ['brave', 'tavily', 'exa', 'firecrawl'] },
            { name: 'apiKey', label: 'API Key（已设密钥留空可保留）', secret: true },
            { name: 'fetch_enabled', label: '启用链接抓取', type: 'boolean', value: fetch.enabled !== false },
          ]); if (!values) return; if (!await ctx.confirm('保存 Agent Web 配置', `联网搜索 ${values.search_enabled ? '开启' : '关闭'}\n提供方 ${values.provider}\n链接抓取 ${values.fetch_enabled ? '开启' : '关闭'}\n密钥不会在界面回显。`)) return; await api('/api/admin/agent-web', { method: 'PUT', body: { search: { enabled: values.search_enabled, provider: values.provider, ...(values.apiKey ? { apiKey: values.apiKey } : {}) }, fetch: { enabled: values.fetch_enabled } } }); ctx.notify('Agent Web 配置已保存。'); await ctx.refresh(); } },
          { label: '编辑飞书登录', run: async ctx => { const values = await ctx.form('编辑飞书登录', [{ name: 'enabled', label: '启用飞书登录', type: 'boolean', value: feishu.enabled === true }, { name: 'appId', label: 'App ID', value: feishu.appId || '' }, { name: 'appSecret', label: 'App Secret（留空保留现有密钥）', secret: true }, { name: 'tenantKey', label: 'Tenant Key', value: feishu.tenantKey || '' }]); if (!values) return; if (values.enabled && (!values.appId || (!values.appSecret && !feishu.hasAppSecret))) { await ctx.show('配置不完整', '启用飞书登录需要 App ID 与 App Secret。'); return; } if (!await ctx.confirm('保存飞书登录配置', `启用：${values.enabled}\nApp ID：${values.appId}\n密钥不会回显。`)) return; await api('/api/admin/feishu-login', { method: 'PUT', body: values }); ctx.notify('飞书登录配置已保存。'); await ctx.refresh(); } },
          { label: '测试 Agent Web 搜索', run: async ctx => { const query = await ctx.ask('测试查询词'); if (!query) return; const result = await api('/api/admin/agent-web/test', { method: 'POST', body: { query } }); await ctx.show('Agent Web 搜索测试', JSON.stringify(result, null, 2)); } },
          { label: '编辑数据保留配置', run: async ctx => { const numeric = ['provider_quota_days', 'compress_days', 'purge_days', 'compress_size_gb', 'purge_size_gb']; const values = await ctx.form('编辑数据保留配置', numeric.map(name => ({ name, label: name, value: String(retention[name] ?? 0) })).concat([{ name: 'agg_enabled', label: '启用聚合', type: 'boolean', value: retention.agg_enabled === true }])); if (!values) return; const body = Object.fromEntries(numeric.map(name => [name, Number(values[name])]).concat([['agg_enabled', values.agg_enabled]])); if (!await ctx.confirm('保存数据保留配置', JSON.stringify(body))) return; await api('/api/admin/retention-config', { method: 'PUT', body }); ctx.notify('数据保留配置已保存；本操作不会立即清理数据。'); await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-policies', label: '策略管理', description: '管理员策略概览和策略列表。',
      async load(api) {
        const [overview, health, list] = await Promise.allSettled([
          api('/api/admin/policies/overview'), api('/api/admin/policies/health'),
          api('/api/admin/policies', { query: { page: runtime.adminPolicyPage || 1, limit: 30, ...(runtime.adminPolicyFilters || {}) } }),
        ]);
        const overviewData = overview.status === 'fulfilled' ? overview.value : {};
        const healthData = health.status === 'fulfilled' ? health.value : {};
        const result = list.status === 'fulfilled' ? list.value : {};
        const items = array(result.items);
        return { sections: [
          { title: '策略概览', rows: [{ label: JSON.stringify(overviewData) }, { label: JSON.stringify(healthData) }] },
          { title: '策略列表', description: `第 ${result.page || runtime.adminPolicyPage || 1} 页 · 共 ${result.total || 0} 条`, rows: items.map(item => ({ label: display(item.name, item.scope_type, item.effect, item.action, item.enabled ? '启用' : '停用'), detail: display(item.description, `优先级 ${item.priority}`, `24小时命中 ${item.hits_24h || 0}`), run: async ctx => { const detail = await api(`/api/admin/policies/${item.id}`); await ctx.show(`策略详情 · ${item.name}`, JSON.stringify(detail, null, 2)); } })) },
        ], actions: [
          { label: '搜索策略', run: async ctx => { runtime.adminPolicyFilters = { ...(runtime.adminPolicyFilters || {}), q: String(await ctx.ask('策略名称或说明') || '').trim() }; runtime.adminPolicyPage = 1; await ctx.refresh(); } },
          { label: '上一页', run: async ctx => { runtime.adminPolicyPage = Math.max(1, (runtime.adminPolicyPage || 1) - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.adminPolicyPage = (runtime.adminPolicyPage || 1) + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    {
      id: 'policy-center', label: '安全与策略', description: '生效策略、豁免、拦截与申诉。',
      async load(api) {
        const isAdmin = runtime.client.isAdmin === true;
        const requests = [['我的生效策略', '/api/user/policies/mine'], ['最近拦截', '/api/user/policies/blocks'], ['我的申诉', '/api/user/policy-appeals']];
        if (isAdmin) requests.push(['策略概览', '/api/admin/policies/overview'], ['策略健康', '/api/admin/policies/health']);
        const settled = await Promise.allSettled(requests.map(([, path]) => api(path)));
        const data = Object.fromEntries(requests.map(([name], index) => [name, settled[index].status === 'fulfilled' ? settled[index].value : null]));
        const policyPage = runtime.adminPolicyPage || 1;
        const policyFilters = runtime.adminPolicyFilters || { q: '', scope_type: '', effect: '', status: '', enabled: '' };
        const adminList = isAdmin ? await api('/api/admin/policies', { query: { page: policyPage, limit: 30, ...policyFilters } }) : null;
        const policyItems = array(adminList && adminList.items);
        const mine = data['我的生效策略'] || {};
        const rows = (value, label) => array(value).map(item => ({ label: display(item.name || item.policy_name || item.action || `#${item.id}`, item.effect, item.decision || item.status), detail: display(item.description || item.reason, item.requested_model, item.created_at && formatTime(item.created_at)) }));
        const sections = [
          { title: '策略状态', rows: [{ label: mine.suspension?.suspended ? `账号受限：${mine.suspension.reason || '请联系管理员'}` : '账号未处于暂停状态' }, { label: `策略执行模式：${mine.settings?.enforcement_mode || '未知'}` }, ...rows(mine.policies, '策略')] },
          { title: '临时豁免', rows: rows(mine.exemptions, '豁免') },
          { title: '最近拦截', rows: rows(data['最近拦截'], '拦截') },
          { title: '我的申诉', rows: rows(data['我的申诉'], '申诉') },
          ...(isAdmin ? [
            { title: '管理概览', rows: ['策略概览', '策略健康'].map(name => ({ label: `${name}：${data[name] ? JSON.stringify(data[name]) : '暂不可用'}` })) },
            { title: '策略管理', description: `第 ${adminList.page || policyPage} 页 · 共 ${adminList.total || 0} 条`, rows: policyItems.map(item => ({ label: display(item.name, item.scope_type, item.effect, item.action, item.enabled ? '启用' : '停用'), detail: display(item.description, `优先级 ${item.priority}`, `近24小时 ${item.hits_24h || 0} 次命中`) })) },
          ] : []),
        ];
        const actions = [
          { label: '提交策略申诉', run: async ctx => { const values = await ctx.form('提交策略申诉', [{ name: 'policy_id', label: '策略 ID（可空）' }, { name: 'hit_id', label: '拦截记录 ID（可空）' }, { name: 'reason', label: '申诉原因' }], { description: '每个策略 24 小时内仅允许一个待处理申诉。' }); if (!values || !String(values.reason || '').trim()) return; const body = { reason: values.reason }; if (values.policy_id) body.policy_id = Number(values.policy_id); if (values.hit_id) body.hit_id = Number(values.hit_id); await api('/api/user/policy-appeals', { method: 'POST', body }); ctx.notify('申诉已提交。'); await ctx.refresh(); } },
          ...(isAdmin ? [
            { label: '搜索管理策略', run: async ctx => { policyFilters.q = String(await ctx.ask('名称或说明') || '').trim(); runtime.adminPolicyFilters = policyFilters; runtime.adminPolicyPage = 1; await ctx.refresh(); } },
            { label: '筛选策略效果', run: async ctx => { const value = await ctx.choose('效果', [{ label: '全部', value: '' }, { label: '阻止', value: 'deny' }, { label: '允许', value: 'allow' }]); if (value !== null) { policyFilters.effect = value; runtime.adminPolicyFilters = policyFilters; runtime.adminPolicyPage = 1; await ctx.refresh(); } } },
            { label: '上一页策略', run: async ctx => { runtime.adminPolicyPage = Math.max(1, policyPage - 1); await ctx.refresh(); } },
            { label: '下一页策略', run: async ctx => { runtime.adminPolicyPage = policyPage + 1; await ctx.refresh(); } },
            { label: '新建策略', run: async ctx => { const values = await ctx.form('新建策略', [
              { name: 'name', label: '名称' }, { name: 'description', label: '说明' }, { name: 'scope_type', label: '作用域', value: 'team', options: ['team', 'member', 'global'] }, { name: 'scope_id', label: '作用对象 ID（全局留空）' },
              { name: 'effect', label: '效果', value: 'deny', options: ['deny', 'allow'] }, { name: 'action', label: '动作', value: 'block', options: ['block', 'warn', 'shadow', 'throttle', 'queue', 'downgrade', 'suspend', 'notify'] },
              { name: 'priority', label: '优先级', value: '100' }, { name: 'category', label: '分类', value: 'custom' }, { name: 'conditions', label: '条件 JSON', value: '{}' }, { name: 'enabled', label: '启用', type: 'boolean', value: true },
            ], { description: '策略会立即影响匹配的请求；请仔细确认作用域与条件。' }); if (!values) return; let conditions; try { conditions = JSON.parse(values.conditions || '{}'); } catch (_) { await ctx.show('条件 JSON 无效', '请提供合法 JSON。'); return; } const body = { ...values, scope_id: values.scope_type === 'global' || !values.scope_id ? null : Number(values.scope_id), priority: Number(values.priority) || 0, status: 'draft', status_code: 403, conditions, action_options: {}, ladder: [], notify_channels: {}, tags: [] }; if (!await ctx.confirm('创建策略草稿', `${body.name}\n作用域：${body.scope_type} ${body.scope_id || ''}\n效果：${body.effect} / ${body.action}\n条件：${JSON.stringify(conditions)}`)) return; await api('/api/admin/policies', { method: 'POST', body }); ctx.notify('策略草稿已创建。'); await ctx.refresh(); } },
          ] : []),
          { label: '刷新', run: ctx => ctx.refresh() },
        ];
        return { sections, actions };
      },
    },
  ];
}

module.exports = { createAdminPages };
