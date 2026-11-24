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
        const resourceType = runtime.userAuditResourceType || '';
        const data = await api('/api/user/audit-logs', { query: { page, limit: 50, action, resource_type: resourceType } });
        const items = array(data && data.items);
        return { sections: [{ title: '操作日志', description: `第 ${data.page || page} 页 · 共 ${data.total || 0} 条 · ${action || '全部操作'} · ${resourceType || '全部资源'}`, rows: items.map(item => ({ label: display(formatTime(item.created_at), item.action, item.resource_type), detail: display(item.description, item.status, item.ip_address) })) }], actions: [
          ...[['', '全部操作'], ['api_key', 'API Key'], ['cokey', 'Co-Key'], ['user', '用户'], ['auth', '认证'], ['provider', '供应商'], ['model', '模型']].map(([value, label]) => ({ label, run: async ctx => { runtime.userAuditAction = value; runtime.userAuditPage = 1; await ctx.refresh(); } })),
          ...[['', '全部资源'], ['api_key', 'API Key'], ['user', '用户'], ['provider', '供应商'], ['model', '模型'], ['team', 'Team'], ['policy', '策略']].map(([value, label]) => ({ label: `资源：${label}`, run: async ctx => { runtime.userAuditResourceType = value; runtime.userAuditPage = 1; await ctx.refresh(); } })),
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
              { name: 'email_verified', label: '邮箱已验证', type: 'boolean', value: item.email_verified === true },
              { name: 'isAdmin', label: '管理员', type: 'boolean', value: item.is_admin === true },
              { name: 'balance', label: '余额（留空不修改）', value: '' },
              { name: 'team_id', label: 'Team ID（留空不修改）', value: String(item.team_id || '') },
              { name: 'rate_limit_rpm', label: 'RPM 限额（留空不修改）', value: String(item.rate_limit_rpm || '') },
              { name: 'rate_limit_tpm', label: 'TPM 限额（留空不修改）', value: String(item.rate_limit_tpm || '') },
              { name: 'tags', label: '用户标签（逗号分隔；留空不修改）', value: Array.isArray(item.tags) ? item.tags.join(',') : '' },
            ]);
            if (!values) return;
            const body = { email: values.email, email_verified: values.email_verified, isAdmin: values.isAdmin };
            if (values.balance !== '') body.balance = Number(values.balance);
            if (values.team_id !== '') body.team_id = Number(values.team_id);
            if (values.rate_limit_rpm !== '') body.rate_limit_rpm = Number(values.rate_limit_rpm);
            if (values.rate_limit_tpm !== '') body.rate_limit_tpm = Number(values.rate_limit_tpm);
            if (values.tags !== '') body.tags = values.tags.split(',').map(tag => tag.trim()).filter(Boolean);
            if (!await ctx.confirm('确认更新用户', `${item.username}\n管理员：${body.isAdmin ? '是' : '否'} · 邮箱验证：${body.email_verified ? '是' : '否'}${body.balance !== undefined ? ` · 余额 ${body.balance}` : ''}${body.team_id !== undefined ? ` · Team ${body.team_id}` : ''}`)) return;
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
          { label: '筛选供应商', run: async ctx => { const value = await ctx.ask('供应商名称或 ID（留空全部）', { defaultValue: filters.provider_q || '' }); if (value !== null) { runtime.errorFilters = { ...filters, provider_q: String(value).trim() }; runtime.errorPage = 1; await ctx.refresh(); } } },
          { label: '设置日期范围', run: async ctx => { const values = await ctx.form('错误日志日期范围', [{ name: 'start_date', label: '开始日期（YYYY-MM-DD）', value: filters.start_date || '' }, { name: 'end_date', label: '结束日期（YYYY-MM-DD）', value: filters.end_date || '' }]); if (!values) return; runtime.errorFilters = { ...filters, start_date: values.start_date, end_date: values.end_date }; runtime.errorPage = 1; await ctx.refresh(); } },
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
          { title: '注入提示词', rows: injectedItems.length ? injectedItems.map(item => ({ label: display(item.name, item.enabled === false ? '停用' : '启用', item.bound_key_ids?.length ? `${item.bound_key_ids.length} Key` : '全局生效'), detail: display(item.content && `${String(item.content).length} 字符`, item.content && String(item.content).replace(/\\s+/g, ' ').slice(0, 100)), run: async ctx => {
            const choice = await ctx.choose(`注入提示词 · ${item.name || item.id}`, [{ label: '查看详情', value: 'detail' }, { label: item.enabled === false ? '启用条目' : '停用条目', value: 'toggle' }, { label: '绑定 Key', value: 'keys' }, { label: '删除条目', value: 'delete' }]);
            if (choice === 'detail') await ctx.show(`注入提示词 · ${item.name || item.id}`, JSON.stringify(item, null, 2));
            if (choice === 'toggle') { const enabled = item.enabled === false; if (!await ctx.confirm(enabled ? '启用提示词条目' : '停用提示词条目', `${item.name}\n${enabled ? '此内容将加入匹配 API Key 的系统提示词。' : '此内容将不再注入转发请求。'}`)) return; await api(`/api/user/inject-prompts/${item.id}/toggle`, { method: 'PUT', body: { enabled } }); ctx.notify(`提示词条目已${enabled ? '启用' : '停用'}。`); await ctx.refresh(); }
            if (choice === 'keys') { const keys = itemsOf(await api('/api/user/inject-prompts/my-keys')); const current = array(item.bound_key_ids).map(Number); const input = await ctx.ask('绑定的 Key ID（逗号分隔；留空表示全局生效）', { defaultValue: current.join(','), description: keys.map(key => `${key.id}: ${key.name}${key.key_prefix ? ` (${key.key_prefix})` : ''}`).join(' · ') || '暂无 API Key' }); if (input === null) return; const ids = String(input).split(',').map(value => value.trim()).filter(Boolean).map(Number).filter(id => Number.isInteger(id) && id > 0); if (!ids.length && !await ctx.confirm('设为全局生效', '空 Key 列表意味着该注入提示词对所有 API Key 生效，确认继续？')) return; if (!await ctx.confirm('保存 Key 绑定', `${item.name}\nKey ID：${ids.join(', ') || '全局生效'}`)) return; await api(`/api/user/inject-prompts/${item.id}/keys`, { method: 'PUT', body: { keyIds: ids } }); ctx.notify('提示词 Key 绑定已更新。'); await ctx.refresh(); }
            if (choice === 'delete') { if (!await ctx.confirm('删除提示词条目', `删除「${item.name}」？匹配请求将不再注入此内容。`)) return; await api(`/api/user/inject-prompts/${item.id}`, { method: 'DELETE' }); ctx.notify('提示词条目已删除。'); await ctx.refresh(); }
          } })) : [{ label: injected.status === 'rejected' ? injected.reason.message : '暂无注入提示词。' }] },
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
    adminOnly({
      id: 'admin-plugins', label: '插件管理', description: '查看插件、启停与重载。安装/卸载暂不开放。',
      async load(api) {
        const payload = await api('/api/admin/plugins');
        const plugins = array(payload && payload.plugins);
        return { sections: [{ title: '插件管理', rows: plugins.length ? plugins.map(plugin => ({ label: display(plugin.name, plugin.id, plugin.version, plugin.enabled ? '启用' : '停用'), detail: display(plugin.executionMode || plugin.execution_mode, array(plugin.permissions).join(', '), plugin.description), run: async ctx => {
          const trusted = (plugin.executionMode || plugin.execution_mode) === 'trusted-in-process';
          const actions = [{ label: '查看详情', value: 'detail' }, { label: '重载代码', value: 'reload' }];
          if (!trusted) actions.push({ label: plugin.enabled ? '停用插件' : '启用插件', value: 'toggle' });
          const choice = await ctx.choose(`插件 · ${plugin.name || plugin.id}`, actions, { description: trusted ? '受信任进程插件不会在此处快速启用。' : plugin.description || '' });
          if (choice === 'detail') await ctx.show(`插件详情 · ${plugin.name || plugin.id}`, JSON.stringify(plugin, null, 2));
          if (choice === 'reload') { if (!await ctx.confirm('重载插件代码', `重载 ${plugin.name || plugin.id}？运行中的任务可能受到影响。`)) return; await api(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/reload`, { method: 'POST', body: {} }); ctx.notify('插件已重载。'); await ctx.refresh(); }
          if (choice === 'toggle') { const enabled = !plugin.enabled; if (!await ctx.confirm(enabled ? '启用插件' : '停用插件', `${plugin.name || plugin.id}\n${plugin.description || ''}`)) return; await api(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/toggle`, { method: 'POST', body: {} }); ctx.notify(`插件已${enabled ? '启用' : '停用'}。`); await ctx.refresh(); }
        } })) : [{ label: '暂无插件。' }] }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
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
        const filters = runtime.adminModelFilters || {};
        const data = await api('/api/admin/models', { query: { page: runtime.adminModelPage || 1, limit: 30, q: runtime.adminModelSearch || '', ...filters } });
        const items = array(data && (data.items || data));
        return { sections: [{ title: '模型管理', description: `第 ${data.page || runtime.adminModelPage || 1} 页 · 共 ${data.total || items.length} 个`, rows: items.map(item => ({ label: display(item.name, item.alias, item.id), detail: display(item.provider_name || item.provider, item.enabled === false ? '停用' : '启用', item.description), run: async ctx => {
          const choice = await ctx.choose('模型操作', [{ label: '查看详情', value: 'detail' }, { label: '测试模型', value: 'test' }]);
          if (choice === 'detail') await ctx.show(`模型 · ${item.name || item.id}`, JSON.stringify(item, null, 2));
          if (choice === 'test') { if (!await ctx.confirm('测试模型', `将使用当前模型配置对 ${item.name || item.id} 发起一次真实测试请求。继续？`)) return; const result = await api(`/api/admin/models/${encodeURIComponent(item.id)}/test`, { method: 'POST', body: {} }); await ctx.show('模型测试', JSON.stringify(result, null, 2)); }
        } })) }], actions: [
          { label: '搜索模型', run: async ctx => { runtime.adminModelSearch = String(await ctx.ask('模型搜索', { defaultValue: runtime.adminModelSearch || '' }) || '').trim(); runtime.adminModelPage = 1; await ctx.refresh(); } },
          ...[['provider', '供应商'], ['series', '系列']].map(([key, label]) => ({ label: `筛选${label}`, run: async ctx => { const value = await ctx.ask(`${label} ID（留空清除）`, { defaultValue: filters[key] || '' }); if (value !== null) { runtime.adminModelFilters = { ...filters, [key]: String(value).trim() }; runtime.adminModelPage = 1; await ctx.refresh(); } } })),
          { label: '筛选启用状态', run: async ctx => { const value = await ctx.choose('模型启用状态', [{ label: '全部', value: '' }, { label: '启用', value: 'true' }, { label: '停用', value: 'false' }]); if (value !== null) { runtime.adminModelFilters = { ...filters, enabled: value }; runtime.adminModelPage = 1; await ctx.refresh(); } } },
          { label: '筛选测试状态', run: async ctx => { const value = await ctx.choose('模型测试状态', [{ label: '全部', value: '' }, { label: '通过', value: 'pass' }, { label: '失败', value: 'fail' }, { label: '未测试', value: 'untested' }]); if (value !== null) { runtime.adminModelFilters = { ...filters, test: value }; runtime.adminModelPage = 1; await ctx.refresh(); } } },
          { label: '清除筛选', run: async ctx => { runtime.adminModelFilters = {}; runtime.adminModelPage = 1; await ctx.refresh(); } },
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
          const [members, rules, models] = await Promise.allSettled([
            api(`/api/admin/teams/${encodeURIComponent(team.id)}/members`),
            api(`/api/admin/teams/${encodeURIComponent(team.id)}/rules`),
            api(`/api/admin/teams/${encodeURIComponent(team.id)}/models`),
          ]);
          const memberItems = members.status === 'fulfilled' ? itemsOf(members.value) : [];
          const ruleItems = rules.status === 'fulfilled' ? itemsOf(rules.value) : [];
          const modelItems = models.status === 'fulfilled' ? itemsOf(models.value) : [];
          const modelSearch = String(runtime[`team_${team.id}_modelSearch`] || '').toLowerCase();
          const visibleModels = modelItems.filter(model => !modelSearch || [model.name, model.model_id, model.provider_name, model.provider, model.series].some(value => String(value || '').toLowerCase().includes(modelSearch)));
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
              ...visibleModels.map(model => ({ label: `模型 · ${model.name || model.model_id} · ${model.enabled ? '已启用' : '未授权'}`, detail: display(model.provider_name || model.provider, model.series, model.test_ok === true ? `测试 ${model.test_latency_ms || 0} ms` : model.test_error || ''), run: async ctx => { const enabled = model.enabled !== true; const impact = enabled ? '授权此模型给 Team 成员使用。' : '禁用后，若该成员的 API Key 没有其他 Team 提供此模型，服务端可能清除该 Key 的当前模型绑定。'; if (!await ctx.confirm(enabled ? '启用 Team 模型' : '禁用 Team 模型', `${team.name}\n${model.name || model.model_id}\n${impact}`)) return; const result = await api(`/api/admin/teams/${encodeURIComponent(team.id)}/models/${encodeURIComponent(model.model_id)}`, { method: 'PUT', body: { enabled } }); if (!enabled && result.cleared_keys) ctx.notify(`已禁用；清除了 ${result.cleared_keys} 个 API Key 的当前模型绑定。`); else ctx.notify(`Team 模型已${enabled ? '启用' : '禁用'}。`); await ctx.refresh(); } })),
            ],
            actions: [
              { label: `搜索 ${team.name} 模型`, run: async ctx => { runtime[`team_${team.id}_modelSearch`] = String(await ctx.ask('模型名称、ID 或供应商') || '').trim(); await ctx.refresh(); } },
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
      id: 'admin-updates', label: '版本与更新', description: '检查官方版本与更新任务状态；TUI 不会下载安装或重启服务。',
      async load(api) {
        const [runtimeResult, statusResult] = await Promise.allSettled([api('/api/admin/update/runtime'), api('/api/admin/update/status')]);
        const runtimeData = runtimeResult.status === 'fulfilled' ? runtimeResult.value : {};
        const status = statusResult.status === 'fulfilled' ? statusResult.value : runtimeData.status || {};
        return { sections: [
          { title: '当前版本与运行环境', rows: Object.entries(runtimeData).filter(([key]) => !['status', 'versionUrl', 'packageUrl'].includes(key)).map(([key, value]) => ({ label: `${key}：${typeof value === 'object' ? JSON.stringify(value) : value}` })) },
          { title: '更新任务状态', rows: Object.entries(status || {}).map(([key, value]) => ({ label: `${key}：${typeof value === 'object' ? JSON.stringify(value) : value}` })) },
        ], actions: [
          { label: '检查官方更新', run: async ctx => { if (!await ctx.confirm('检查官方版本', '将向配置的官方版本服务发起只读网络请求，不会自动安装或重启。继续？')) return; const result = await api('/api/admin/update/check'); await ctx.show('版本检查结果', JSON.stringify(result, null, 2)); await ctx.refresh(); } },
          { label: '刷新状态', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-invites', label: '邀请链接', description: '邀请列表不含原始 token；新建一次性凭证请在网页端完成。',
      async load(api) {
        const invites = array(await api('/api/auth-invites'));
        const rows = invites.map(invite => ({ label: display(`#${invite.id}`, invite.team_name || (invite.team_id ? `Team ${invite.team_id}` : '默认 Team'), invite.status, `${invite.used_count || 0}/${invite.max_uses || 1} 次`), detail: display(`创建 ${formatTime(invite.created_at)}`, `到期 ${formatTime(invite.expires_at)}`, invite.created_by_name && `创建者 ${invite.created_by_name}`, invite.used_by_name && `使用者 ${invite.used_by_name}`), run: async ctx => { await ctx.show(`邀请 #${invite.id}`, JSON.stringify(invite, null, 2)); if (invite.status !== 'active') return; if (!await ctx.confirm('撤销邀请链接', `撤销 #${invite.id}？该邀请将立即无法注册，且撤销不可恢复。`)) return; await api(`/api/auth-invites/${encodeURIComponent(invite.id)}/revoke`, { method: 'POST', body: {} }); ctx.notify('邀请链接已撤销。'); await ctx.refresh(); } }));
        return { sections: [{ title: '邀请链接', description: `${invites.length} 条 · 原始邀请 token 不可再次读取`, rows: rows.length ? rows : [{ label: '暂无邀请链接。' }] }], actions: [
          { label: '生成邀请链接', run: async ctx => await ctx.show('邀请链接生成', '生成操作会创建可用于注册的一次性凭证并仅在当次响应显示。为降低误发风险，请在网页管理后台生成。') },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-oauth-clients', label: 'OAuth 客户端', description: '管理客户端只读目录。Secret 不回显；创建、轮换和删除请在网页端完成。',
      async load(api) {
        const payload = await api('/api/admin/oauth-clients');
        const clients = array(payload && payload.clients);
        return { sections: [
          { title: 'OAuth 客户端', description: `${clients.length} 个客户端 · ${array(payload && payload.scopes).length} 种可分配 scope`, rows: clients.map(client => ({ label: display(client.name, client.client_id, client.type === 'confidential' ? 'Confidential' : 'Public', client.enabled ? '启用' : '停用'), detail: display(`Scopes：${array(client.scopes).join(', ') || '默认'}`, `重定向 URI：${array(client.redirect_uris).join(', ') || '无'}`, client.has_secret ? `Secret 已配置 (${client.secret_hint || '隐藏'})` : '无 Secret', client.builtin ? '内置' : '自定义'), run: async ctx => await ctx.show(`OAuth 客户端 · ${client.name}`, JSON.stringify(client, null, 2)) })) },
          { title: '可分配权限', rows: array(payload && payload.scopes).map(scope => ({ label: scope.scope, detail: scope.description })) },
        ], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
    adminOnly({
      id: 'admin-popups', label: '弹窗通知', description: '已发布弹窗的只读状态与内容。TUI 不会修改或重置用户已读状态。',
      async load(api) {
        const data = await api('/api/admin/popup-notices');
        const items = array(data && data.items);
        const rows = items.map(item => ({
          label: display(item.title, item.enabled ? '启用' : '停用', `${item.seenCount || 0} 人已读`, formatTime(item.updatedAt || item.createdAt)),
          detail: `关闭按钮：${item.closeText || '知道了'} · ${String(item.body || '').replace(/\\s+/g, ' ').slice(0, 120)}`,
          run: async ctx => {
            const detail = `状态：${item.enabled ? '启用' : '停用'}\n已读人数：${item.seenCount || 0}\n创建：${formatTime(item.createdAt)}\n更新：${formatTime(item.updatedAt)}\n关闭按钮：${item.closeText || '知道了'}\n\n${item.body || ''}`;
            await ctx.show(`弹窗通知 · ${item.title}`, detail);
          },
        }));
        return { sections: [{ title: '弹窗通知', description: `${items.length} 条通知`, rows: rows.length ? rows : [{ label: '暂无弹窗通知。' }] }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
    adminOnly({
      id: 'admin-retention', label: '数据保留', description: '数据保留规则只读概览；立即压缩/清除任务不在 TUI 快捷执行。',
      async load(api) {
        const data = await api('/api/admin/retention-config');
        return { sections: [{ title: '数据保留配置', rows: Object.entries(data || {}).map(([key, value]) => ({ label: `${key}：${typeof value === 'boolean' ? (value ? '启用' : '关闭') : value}` })) }, { title: '任务状态', rows: [{ label: '任务状态只在网页管理后台启动任务后显示；CLI 不会触发数据清理。' }] }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
    adminOnly({
      id: 'admin-settings', label: '系统设置', description: '常规、请求采集、Agent 资料与认证配置。',
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
          { label: '查看弹窗通知', run: async ctx => { await ctx.navigate('admin-popups'); } },
          { label: '查看数据保留', run: async ctx => { await ctx.navigate('admin-retention'); } },
          { label: '编辑飞书登录', run: async ctx => { const values = await ctx.form('编辑飞书登录', [{ name: 'enabled', label: '启用飞书登录', type: 'boolean', value: feishu.enabled === true }, { name: 'appId', label: 'App ID', value: feishu.appId || '' }, { name: 'appSecret', label: 'App Secret（留空保留现有密钥）', secret: true }, { name: 'tenantKey', label: 'Tenant Key', value: feishu.tenantKey || '' }]); if (!values) return; if (values.enabled && (!values.appId || (!values.appSecret && !feishu.hasAppSecret))) { await ctx.show('配置不完整', '启用飞书登录需要 App ID 与 App Secret。'); return; } if (!await ctx.confirm('保存飞书登录配置', `启用：${values.enabled}\nApp ID：${values.appId}\n密钥不会回显。`)) return; await api('/api/admin/feishu-login', { method: 'PUT', body: values }); ctx.notify('飞书登录配置已保存。'); await ctx.refresh(); } },
          { label: '测试 Agent Web 搜索', run: async ctx => { const query = await ctx.ask('测试查询词'); if (!query) return; const result = await api('/api/admin/agent-web/test', { method: 'POST', body: { query } }); await ctx.show('Agent Web 搜索测试', JSON.stringify(result, null, 2)); } },
          { label: '编辑数据保留配置', run: async ctx => { const numeric = ['provider_quota_days', 'compress_days', 'purge_days', 'compress_size_gb', 'purge_size_gb']; const values = await ctx.form('编辑数据保留配置', numeric.map(name => ({ name, label: name, value: String(retention[name] ?? 0) })).concat([{ name: 'agg_enabled', label: '启用聚合', type: 'boolean', value: retention.agg_enabled === true }])); if (!values) return; const body = Object.fromEntries(numeric.map(name => [name, Number(values[name])]).concat([['agg_enabled', values.agg_enabled]])); if (!await ctx.confirm('保存数据保留配置', JSON.stringify(body))) return; await api('/api/admin/retention-config', { method: 'PUT', body }); ctx.notify('数据保留配置已保存；本操作不会立即清理数据。'); await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-policy-members', label: '策略成员', description: '搜索成员、查看状态并管理暂停/豁免。',
      async load(api) {
        const query = runtime.policyMemberQuery || '';
        const status = runtime.policyMemberStatus || '';
        const page = runtime.policyMemberPage || 1;
        const data = await api('/api/admin/policy-members', { query: { q: query, status, page, limit: 50 } });
        const members = array(data && data.items);
        return { sections: [{ title: '策略成员', description: `第 ${data.page || page} 页 · 共 ${data.total || members.length} 位成员 · ${status || '全部状态'}`, rows: members.map(member => {
          const suspended = Boolean(member.suspended_at && (!member.suspended_until || new Date(member.suspended_until) > new Date()));
          return { label: display(member.username, member.email, member.team_name, suspended ? '暂停中' : '正常', member.policy_bypass ? '豁免' : ''), detail: display(`角色 ${member.team_role || 'member'}`, `${member.policy_count || 0} 条成员策略`, `${member.hits_24h || 0} 次/24h 命中`, member.suspended_until && `暂停至 ${formatTime(member.suspended_until)}`), run: async ctx => {
            const choice = await ctx.choose(`成员 · ${member.username}`, [
              { label: '查看详情', value: 'detail' },
              ...(member.team_id ? [{ label: '修改 Team 角色', value: 'role' }] : []),
              { label: suspended ? '恢复成员' : '暂停成员', value: 'suspension' },
              { label: member.policy_bypass ? '关闭策略豁免' : '开启策略豁免', value: 'bypass' },
              { label: '查看生效策略', value: 'effective' },
            ]);
            if (choice === 'detail') await ctx.show(`成员 · ${member.username}`, JSON.stringify(member, null, 2));
            if (choice === 'role') {
              const role = await ctx.choose('Team 角色', ['owner', 'admin', 'member', 'viewer'].map(value => ({ label: value, value })));
              if (!role || !await ctx.confirm('更新成员角色', `${member.username}\n${member.team_name}: ${role}`)) return;
              await api(`/api/admin/policy-members/${member.id}/role`, { method: 'POST', body: { team_id: member.team_id, role } });
              ctx.notify('Team 角色已更新。'); await ctx.refresh();
            }
            if (choice === 'suspension' && suspended) {
              if (!await ctx.confirm('恢复成员', `恢复 ${member.username} 的访问权限？`)) return;
              await api(`/api/admin/policy-members/${member.id}/resume`, { method: 'POST', body: {} }); ctx.notify('成员已恢复。'); await ctx.refresh();
            } else if (choice === 'suspension') {
              const values = await ctx.form('暂停成员', [{ name: 'duration_seconds', label: '暂停秒数（≥60，留空永久）' }, { name: 'reason', label: '暂停原因' }, { name: 'scope', label: '范围', value: 'all', options: ['all', 'api'] }]);
              if (!values || !await ctx.confirm('确认暂停成员', `${member.username}\n范围 ${values.scope}\n时长 ${values.duration_seconds || '永久'}\n原因 ${values.reason || '未填写'}`)) return;
              await api(`/api/admin/policy-members/${member.id}/suspend`, { method: 'POST', body: { ...(values.duration_seconds ? { duration_seconds: Number(values.duration_seconds) } : {}), reason: values.reason || '', scope: values.scope } }); ctx.notify('成员已暂停。'); await ctx.refresh();
            }
            if (choice === 'bypass') {
              const enabled = !member.policy_bypass;
              if (!await ctx.confirm(enabled ? '开启策略豁免' : '关闭策略豁免', `${member.username}\n${enabled ? '该成员将绕过策略检查。' : '策略检查将恢复。'}`)) return;
              await api(`/api/admin/policy-members/${member.id}/bypass`, { method: 'POST', body: { enabled } }); ctx.notify(enabled ? '策略豁免已开启。' : '策略豁免已关闭。'); await ctx.refresh();
            }
            if (choice === 'effective') { const result = await api('/api/admin/policies/effective', { query: { user_id: member.id } }); await ctx.show(`生效策略 · ${member.username}`, JSON.stringify(result, null, 2)); }
          } };
        }) }], actions: [
          { label: '搜索成员', run: async ctx => { runtime.policyMemberQuery = String(await ctx.ask('用户名或邮箱', { defaultValue: query }) || '').trim(); runtime.policyMemberPage = 1; await ctx.refresh(); } },
          ...[['', '全部状态'], ['active', '正常成员'], ['suspended', '暂停成员']].map(([value, label]) => ({ label, run: async ctx => { runtime.policyMemberStatus = value; runtime.policyMemberPage = 1; await ctx.refresh(); } })),
          { label: '上一页', run: async ctx => { runtime.policyMemberPage = Math.max(1, page - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.policyMemberPage = page + 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-policy-clients', label: '客户端管控', description: '查看近 24 小时客户端请求、Token 与策略命中统计。网页端可创建拦截策略；此操作会立即影响请求。',
      async load(api) {
        const data = await api('/api/admin/policy-clients', { query: { range: '24h' } });
        const items = array(data && data.items);
        return { sections: [{ title: '客户端统计', rows: items.length ? items.map(item => ({ label: display(item.label, item.request_source, `${item.requests || 0} 请求`, `${item.tokens || 0} tokens`), detail: display(`${item.hits || 0} 次命中`, `${item.blocked || 0} 次拦截`) })) : [{ label: '暂无客户端数据。' }] }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }, { label: '禁止客户端策略', run: async ctx => { await ctx.show('高影响操作未开放', '创建客户端禁止规则会立即阻断匹配客户端的请求。为避免误封，此操作请在网页管理后台确认作用域后完成。'); } }] };
      },
    }),
    adminOnly({
      id: 'admin-policy-notifications', label: '策略通知', description: '全局通知渠道和策略告警规则。测试渠道会向配置的外部目标发送通知。',
      async load(api) {
        if (runtime.client.isAdmin !== true) return { sections: [{ title: '策略通知', rows: [{ label: '仅全局管理员可管理通知渠道与告警规则。' }] }], actions: [] };
        const [channelsResult, rulesResult, analyticsResult] = await Promise.allSettled([
          api('/api/admin/policy-channels'), api('/api/admin/policy-alert-rules'), api('/api/admin/policies/analytics', { query: { range: '7d', group_by: 'policy' } }),
        ]);
        const channels = channelsResult.status === 'fulfilled' ? array(channelsResult.value) : [];
        const rules = rulesResult.status === 'fulfilled' ? array(rulesResult.value) : [];
        const analytics = analyticsResult.status === 'fulfilled' ? analyticsResult.value : {};
        return { sections: [
          { title: '7 日策略分析', rows: [{ label: JSON.stringify(analytics.totals || {}) }, ...array(analytics.rows).slice(0, 10).map(item => ({ label: display(item.policy_name || item.group, `${item.hits || 0} 次命中`) }))] },
          { title: '通知渠道', rows: channels.length ? channels.map(channel => ({ label: display(channel.name, channel.type, channel.min_severity, channel.enabled ? '启用' : '停用'), run: async ctx => {
            const choice = await ctx.choose(`通知渠道 · ${channel.name}`, [{ label: '查看详情', value: 'detail' }, { label: '测试渠道（会发送外部通知）', value: 'test' }, { label: '删除渠道', value: 'delete' }]);
            if (choice === 'detail') await ctx.show(`通知渠道 · ${channel.name}`, JSON.stringify(channel, null, 2));
            if (choice === 'test') { if (!await ctx.confirm('发送测试通知', `将向已配置的 ${channel.type} 目标发送测试通知。继续？`)) return; const result = await api(`/api/admin/policy-channels/${channel.id}/test`, { method: 'POST', body: {} }); await ctx.show('渠道测试结果', JSON.stringify(result, null, 2)); }
            if (choice === 'delete') { if (!await ctx.confirm('删除通知渠道', `删除「${channel.name}」？关联规则可能失去该渠道。`)) return; await api(`/api/admin/policy-channels/${channel.id}`, { method: 'DELETE' }); await ctx.refresh(); }
          } })) : [{ label: channelsResult.status === 'rejected' ? channelsResult.reason.message : '暂无通知渠道。' }] },
          { title: '告警规则', rows: rules.length ? rules.map(rule => ({ label: display(rule.name, rule.event_type, rule.severity, rule.enabled ? '启用' : '停用'), detail: display(`渠道 ${array(rule.channel_ids).join(', ') || '无'}`, `静默 ${rule.silence_window_seconds || 0}s`) })) : [{ label: rulesResult.status === 'rejected' ? rulesResult.reason.message : '暂无告警规则。' }] },
        ], actions: [
          { label: '新建通知渠道', run: async ctx => { const values = await ctx.form('新建通知渠道', [
            { name: 'name', label: '名称' }, { name: 'type', label: '类型', value: 'webhook', options: ['webhook', 'feishu', 'wecom', 'dingtalk', 'slack', 'telegram', 'email', 'bark', 'syslog', 'otlp'] },
            { name: 'min_severity', label: '最低级别', value: 'warning', options: ['info', 'warning', 'critical'] }, { name: 'url', label: 'Webhook / 机器人 URL', secret: true }, { name: 'secret', label: 'Secret / Token（可空）', secret: true },
            { name: 'to', label: '邮件收件人（email 类型）' }, { name: 'chat_id', label: 'Telegram chat_id' }, { name: 'host', label: 'Syslog host' }, { name: 'port', label: 'Syslog 端口', value: '514' },
          ]); if (!values || !String(values.name || '').trim()) return; const config = {}; for (const key of ['url', 'secret', 'to', 'chat_id']) if (values[key]) config[key] = values[key]; if (values.host) { config.host = values.host; config.port = Number(values.port) || 514; } if (!await ctx.confirm('创建通知渠道', `${values.name} · ${values.type} · ${values.min_severity}\nSecret 不会回显；URL 需通过服务端 SSRF 校验。`)) return; await api('/api/admin/policy-channels', { method: 'POST', body: { name: values.name, type: values.type, min_severity: values.min_severity, config } }); ctx.notify('通知渠道已创建。'); await ctx.refresh(); } },
          { label: '新建告警规则', run: async ctx => { const values = await ctx.form('新建告警规则', [{ name: 'name', label: '名称', value: '策略告警' }, { name: 'event_type', label: '事件', value: 'hit', options: ['hit', 'block', 'suspend', 'approval', 'appeal', '*'] }, { name: 'severity', label: '级别', value: 'warning', options: ['info', 'warning', 'critical'] }, { name: 'silence_window_seconds', label: '静默秒数', value: '300' }, { name: 'channel_ids', label: `渠道 ID（逗号分隔，可选：${channels.map(channel => `${channel.id}=${channel.name}`).join(', ')}）` }]); if (!values) return; const channelIds = String(values.channel_ids || '').split(',').map(value => Number(value.trim())).filter(Number.isInteger); if (!await ctx.confirm('创建告警规则', `${values.name}\n事件 ${values.event_type} · ${values.severity}\n渠道 ${channelIds.join(', ') || '无'}`)) return; await api('/api/admin/policy-alert-rules', { method: 'POST', body: { name: values.name, event_type: values.event_type, severity: values.severity, silence_window_seconds: Number(values.silence_window_seconds) || 300, channel_ids: channelIds } }); await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-policy-settings', label: '策略设置', description: '管理执行模式、失败模式、命中保留与通知偏好。紧急停止需在网页端操作。',
      async load(api) {
        const data = await api('/api/admin/policy-settings');
        const settings = data.global || {};
        const team = data.team || {};
        return { sections: [
          { title: '策略执行', rows: [
            { label: `作用范围：${runtime.client.isAdmin ? '全局' : `Team #${team.team_id || '未知'}`}` },
            { label: `执行模式：${settings.enforcement_mode || 'enforce'}` },
            { label: `失败模式：${settings.fail_mode || 'open'}` },
            { label: `命中保留：${settings.hit_retention_days || 90} 天` },
            { label: `默认时区：${settings.default_timezone || 'Asia/Shanghai'}` },
            { label: `白名单维度：${array(settings.allowlist_dimensions).join(', ') || '无'}` },
            { label: `通知管理员：${settings.notify_admins !== false ? '开启' : '关闭'} · 通知成员：${settings.notify_member !== false ? '开启' : '关闭'}` },
            { label: `紧急停止：${settings.kill_switch ? '已启用（所有请求放行）' : '未启用'}` },
          ] },
        ], actions: [
          { label: '编辑策略设置', run: async ctx => {
            const dimensions = array(settings.allowlist_dimensions);
            const values = await ctx.form('编辑策略设置', [
              { name: 'enforcement_mode', label: '执行模式', value: settings.enforcement_mode || 'enforce', options: ['enforce', 'shadow'] },
              { name: 'fail_mode', label: '失败模式', value: settings.fail_mode || 'open', options: ['open', 'closed'] },
              { name: 'hit_retention_days', label: '命中保留天数（1-3650）', value: String(settings.hit_retention_days || 90) },
              { name: 'default_timezone', label: '默认时区', value: settings.default_timezone || 'Asia/Shanghai' },
              ...['clients', 'models', 'providers', 'ips', 'protocols'].map(value => ({ name: `dimension_${value}`, label: `白名单维度：${value}`, type: 'boolean', value: dimensions.includes(value) })),
              { name: 'notify_admins', label: '命中时通知管理员', type: 'boolean', value: settings.notify_admins !== false },
              { name: 'notify_member', label: '命中时通知被拦截成员', type: 'boolean', value: settings.notify_member !== false },
            ], { description: '启用白名单维度后，未匹配 allow 规则的请求会被拦截；请谨慎修改。' });
            if (!values) return;
            const retention = Number(values.hit_retention_days);
            if (!Number.isInteger(retention) || retention < 1 || retention > 3650) { await ctx.show('保留天数无效', '请输入 1 到 3650 的整数。'); return; }
            const allowlist_dimensions = ['clients', 'models', 'providers', 'ips', 'protocols'].filter(value => values[`dimension_${value}`]);
            const body = { team_id: runtime.client.isAdmin === true ? null : (team.team_id ?? null), enforcement_mode: values.enforcement_mode, fail_mode: values.fail_mode, hit_retention_days: retention, default_timezone: values.default_timezone || 'Asia/Shanghai', allowlist_dimensions, notify_admins: values.notify_admins, notify_member: values.notify_member };
            if (!await ctx.confirm('保存策略设置', `范围：${body.team_id === null ? '全局' : `Team #${body.team_id}`}\n执行 ${body.enforcement_mode} · 失败 ${body.fail_mode}\n白名单维度：${allowlist_dimensions.join(', ') || '无'}\n注意：未匹配 allow 的请求可能被拦截。`)) return;
            await api('/api/admin/policy-settings', { method: 'PUT', body }); ctx.notify('策略设置已保存。'); await ctx.refresh();
          } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-policy-approvals', label: '策略审批', description: '处理待审批的策略请求。',
      async load(api) {
        const data = await api('/api/admin/policy-approvals', { query: { page: 1, limit: 100, status: runtime.approvalStatus || 'pending' } });
        const items = array(data && data.items);
        return { sections: [{ title: '审批中心', description: `${items.length} 条 · ${runtime.approvalStatus || '全部状态'}`, rows: items.map(item => ({ label: display(item.kind === 'request' ? '运行时放行' : '策略变更', item.policy_name || item.policy_id, item.requested_by_name, item.status), detail: display(item.preview && JSON.stringify(item.preview), formatTime(item.created_at)), run: async ctx => {
          const decision = await ctx.choose(`审批 · #${item.id}`, [{ label: '查看详情', value: 'detail' }, ...(item.status === 'pending' ? [{ label: '通过', value: 'approve' }, { label: '驳回', value: 'reject' }] : [])]);
          if (decision === 'detail') { await ctx.show('审批详情', JSON.stringify(item, null, 2)); return; }
          if (!decision || !await ctx.confirm(decision === 'approve' ? '通过审批' : '驳回审批', `${item.policy_name || item.kind}\n申请人 ${item.requested_by_name || '未知'}\n${JSON.stringify(item.preview || {})}`)) return;
          const note = await ctx.ask('审批备注（可留空）');
          await api(`/api/admin/policy-approvals/${item.id}/decide`, { method: 'POST', body: { decision, note: note || '' } }); ctx.notify(decision === 'approve' ? '审批已通过。' : '审批已驳回。'); await ctx.refresh();
        } })) }], actions: [
          ...[['pending', '待审批'], ['', '全部审批']].map(([value, label]) => ({ label, run: async ctx => { runtime.approvalStatus = value; await ctx.refresh(); } })),
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
