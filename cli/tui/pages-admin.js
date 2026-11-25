'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { text } = require('./pages-common');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');

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
const modelMultiplierLabel = value => `计费倍率 ×${Number(value || 1).toFixed(2)}`;
const clientSourceLabel = value => ({ claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw', deepseek_harness: 'DeepSeek Harness', unknown: '未知客户端' })[String(value || '').toLowerCase()] || value || '未知客户端';
const itemsOf = payload => Array.isArray(payload) ? payload : array(payload && (payload.items || payload.records || payload.data));
const display = (...values) => values.map(value => String(value || '').trim()).filter(Boolean).join(' · ');

async function editOAuthClient(ctx, api, client, scopeOptions) {
  const currentScopes = new Set(array(client?.scopes).length ? array(client.scopes) : ['gateway:invoke']);
  const scopes = array(scopeOptions);
  while (true) {
    const selected = await ctx.choose('选择 OAuth 权限', [
      ...scopes.map(item => ({ label: `${currentScopes.has(item.scope) ? '☑' : '☐'} ${item.scope} · ${item.description || ''}`, value: item.scope })),
      { label: `完成选择（${currentScopes.size} 项）`, value: '__done__' },
    ], { description: '至少选择一个可分配权限。' });
    if (selected === null) return;
    if (selected === '__done__') break;
    if (currentScopes.has(selected)) currentScopes.delete(selected); else currentScopes.add(selected);
  }
  if (!currentScopes.size) { await ctx.show('权限无效', '至少选择一个 OAuth 权限。'); return; }
  const formFields = [
    { name: 'name', label: '应用名称', value: client?.name || '' },
    ...(!client ? [{ name: 'clientId', label: '客户端 ID（留空自动生成）', value: '' }] : []),
    { name: 'type', label: '客户端类型', value: client?.type || 'public', options: [{ value: 'public', label: '公共客户端（原生应用 / CLI / SPA，无密钥，强制 PKCE）' }, { value: 'confidential', label: '机密客户端（服务端应用，需要密钥）' }] },
    { name: 'redirects', label: '回调地址（每行一个）', value: array(client?.redirect_uris).join('\n') },
    { name: 'allowLoopbackAnyPath', label: '允许任意回环路径', type: 'boolean', value: client?.allow_loopback_any_path === true },
    { name: 'description', label: '说明', value: client?.description || '' },
    { name: 'enabled', label: '启用该应用', type: 'boolean', value: client ? client.enabled === true : true },
    ...(client ? [{ name: 'rotateSecret', label: '同时轮换客户端密钥', type: 'boolean', value: false }] : []),
  ];
  const values = await ctx.form(client ? `编辑 OAuth 应用 · ${client.name}` : '新建 OAuth 应用', formFields, { description: 'HTTPS 回调地址需精确匹配；回环地址忽略端口；自定义 scheme 仅限公共客户端。' });
  if (!values) return;
  const name = String(values.name || '').trim();
  const redirectUris = String(values.redirects || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!name || (!redirectUris.length && values.allowLoopbackAnyPath !== true)) { await ctx.show('应用信息无效', '名称不能为空；至少填写一个回调地址，或明确启用任意回环路径。'); return; }
  const payload = { name, type: values.type, redirectUris, allowLoopbackAnyPath: values.allowLoopbackAnyPath === true, scopes: [...currentScopes], description: String(values.description || '').trim(), enabled: values.enabled === true, rotateSecret: values.rotateSecret === true };
  if (!client && String(values.clientId || '').trim()) payload.clientId = String(values.clientId).trim();
  if (!await ctx.confirm(client ? '保存 OAuth 应用' : '创建 OAuth 应用', `${name}\n类型：${payload.type === 'confidential' ? '机密客户端' : '公共客户端'}\n权限：${payload.scopes.join('、')}\n回调：${redirectUris.length} 个${payload.allowLoopbackAnyPath ? ' · 允许任意回环路径' : ''}${payload.rotateSecret ? '\n同时轮换密钥，旧密钥及令牌会失效。' : ''}`)) return;
  const path = client ? `/api/admin/oauth-clients/${encodeURIComponent(client.client_id)}` : '/api/admin/oauth-clients';
  const result = await api(path, { method: client ? 'PUT' : 'POST', body: payload });
  if (result.client_secret) await ctx.show('客户端密钥（仅显示一次）', `${result.warning || '请立即安全保存此密钥。'}\n\n${result.client_secret}`);
  if (result.revokedTokens) await ctx.show('已撤销授权令牌', `有 ${result.revokedTokens} 个旧令牌已立即失效。`);
  ctx.notify(client ? 'OAuth 应用已更新。' : 'OAuth 应用已创建。');
  await ctx.refresh();
}

async function runRetentionTask(api, ctx, kind, dryRun) {
  const label = kind === 'compress' ? '压缩' : '清除';
  if (!dryRun && !await ctx.confirm(`立即执行数据${label}`, '此操作将启动后台任务；清除会删除符合阈值的旧数据，且不可撤销。确认启动？')) return;
  const started = await api(`/api/admin/retention/run-${kind}`, { method: 'POST', body: { dry_run: dryRun } });
  if (!started?.taskId) { await ctx.show('任务未启动', '服务端未返回任务编号。'); return; }
  const initialStatus = started.status === 'queued' ? '排队中' : started.status || '已启动';
  await ctx.show(dryRun ? `数据${label}预览已启动` : `数据${label}任务已启动`, `任务编号：${started.taskId}\n状态：${initialStatus}\n${dryRun ? '这是 dry-run 预览，不会修改或删除数据。' : '任务将在后台执行；同一实例不允许同时运行多个保留任务。'}`);
  const resultLabels = { compressed: '已压缩', deleted: '已清除', purged: '已删除', scanned: '已检查', skipped: '已跳过', tables: '涉及表数', rows: '记录数', bytes: '字节数', dryRun: '预览模式' };
  for (let attempt = 0; attempt < 600; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const task = await api(`/api/admin/retention/tasks/${encodeURIComponent(started.taskId)}`);
    if (task.status === 'completed') {
      const result = task.result || {};
      const details = Object.entries(result).map(([key, value]) => `${resultLabels[key] || key.replace(/_/g, ' ')}：${typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n');
      await ctx.show(dryRun ? `数据${label}预览完成（dry-run）` : `数据${label}任务完成`, `任务编号：${started.taskId}${dryRun ? '\n预览模式：未修改或删除数据' : ''}${details ? `\n${details}` : '\n任务已完成。'}`); return;
    }
    if (task.status === 'failed') { await ctx.show(`数据${label}任务失败`, `任务编号：${started.taskId}\n${task.error?.message || task.error?.code || '未知错误'}`); return; }
  }
  await ctx.show('任务仍在执行', `任务编号：${started.taskId}\n超过 10 分钟未完成；可稍后刷新状态。`);
}

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
          { label: 'Token 用量', value: formatBigNumber(summary.total_tokens) },
          { label: '费用（积分）', value: `${formatCost(summary.total_cost)} 积分` },
          { label: '平均响应时间', value: `${Math.round(Number(summary.avg_latency || 0))} 毫秒` },
        ], rows: [{ label: '最近 30 天的账户用量与模型统计。' }] }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    },
    {
      id: 'projects', label: '项目工作', description: '按工作区查看 AI 请求次数、Token 用量和费用。',
      async load(api) {
        const days = runtime.projectDays || 30;
        const source = runtime.projectSource || '';
        const clientLabels = { claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw', deepseek_harness: 'DeepSeek Harness', unknown: '未知/其他' };
        const customRange = runtime.projectCustomRange || null;
        const rangeLabel = customRange ? `${customRange.start} 至 ${customRange.end}` : `最近 ${days} 天`;
        const query = customRange ? { start: customRange.start, end: customRange.end, ...(source ? { request_source: source } : {}) } : { days, ...(source ? { request_source: source } : {}) };
        const data = await api('/api/user/project-stats', { query });
        const summary = data.summary || {};
        const projects = array(data.projects);
        const analysisStatus = summary.analysis_status || {};
        const selectedClient = source ? (clientLabels[source] || source) : '';
        const formatClients = sources => Object.keys(sources || {}).map(client => clientLabels[client] || client).join('、') || '未标记客户端';
        const syncDescription = analysisStatus.enabled === false ? '后台项目整理功能未启用' : analysisStatus.last_error ? `最近一次整理失败：${analysisStatus.last_error}` : Number(analysisStatus.pending_requests || 0) ? `后台还有 ${Number(analysisStatus.pending_requests).toLocaleString()} 条记录待整理` : `已同步 · 最近更新 ${analysisStatus.last_scanned_at ? formatTime(analysisStatus.last_scanned_at) : '时间未知'}`;
        return { sections: [
          { title: '项目工作摘要', toolbar: true, description: `时间范围：${rangeLabel}${selectedClient ? ` · 客户端 ${selectedClient}` : ''}`, cards: [
            { label: '活跃项目', value: text(summary.projects, '0') }, { label: '活跃天数', value: text(summary.active_days, '0') },
            { label: 'AI 请求次数', value: text(summary.requests, '0') }, { label: 'Token 用量', value: formatBigNumber(summary.tokens) },
            { label: '最近活动', value: summary.last_activity ? formatTime(summary.last_activity) : '—' },
          ], rows: [{ label: syncDescription }] },
          { title: '每日活动', description: '按日期查看 AI 请求和活跃工作区数量。', tableMinWidth: 84, columns: [{ key: 'date', label: '日期', ratio: 0.45 }, { key: 'requests', label: '请求数', ratio: 0.3 }, { key: 'projects', label: '活跃项目数', ratio: 0.25 }], rows: array(data.daily).slice(-30).map(item => ({ label: item.date || '未知日期', cells: { date: item.date || '未知日期', requests: `${Number(item.requests || 0).toLocaleString()} 次`, projects: `${Number(item.projects || 0)} 个` } })) },
          { title: '最近活跃项目', description: '按最近活动排序。选择项目可查看安全引用的切换目录命令。', rows: projects.slice(0, 4).map((item, index) => ({ label: display(`#${index + 1}`, item.workspace_path), detail: display(`${Number(item.requests || 0).toLocaleString()} 次请求`, `${formatBigNumber(item.tokens)} Token`, item.last_activity && formatTime(item.last_activity)), run: async ctx => {
            const workspace = String(item.workspace_path || '');
            if (!workspace) { await ctx.show('工作区路径不可用', '此项目没有记录工作区路径。'); return; }
            const shellPath = `'${workspace.replace(/'/g, `'\\''`)}'`;
            await ctx.show('工作区路径', `项目：${workspace}\n切换目录命令：cd -- ${shellPath}\n\n请使用终端的复制快捷键复制命令或路径；CLI 不会调用系统剪贴板。`);
          } })) },
          { title: '项目工作台', tableMinWidth: 150, columns: [
            { key: 'workspace', label: '工作区', ratio: 0.3 }, { key: 'requests', label: '请求', ratio: 0.13 }, { key: 'tokens', label: 'Token', ratio: 0.14 },
            { key: 'active_days', label: '活跃天数', ratio: 0.12 }, { key: 'last_activity', label: '最近活动', ratio: 0.13 }, { key: 'sources', label: '客户端', ratio: 0.1 }, { key: 'cost', label: '费用（积分）', ratio: 0.08 },
          ], rows: projects.length ? projects.map(item => ({ label: item.workspace_path || '未知工作区', cells: {
            workspace: item.workspace_path || '未知工作区', requests: `${Number(item.requests || 0).toLocaleString()} 次`, tokens: `${formatBigNumber(item.tokens)} Token`,
            active_days: `${Number(item.active_days || 0)} 天`, last_activity: item.last_activity ? formatTime(item.last_activity) : '—', sources: formatClients(item.sources), cost: `${formatCost(item.cost)} 积分`,
          } })) : [{ label: '暂无项目活动。' }] },
        ], pageToolbar: true, actions: [
          { label: '选择时间范围', toolbar: 'page', run: async ctx => { const range = await ctx.choose('项目统计时间范围', [...[7, 30, 90, 180, 365].map(value => ({ label: value === 365 ? '最近 1 年' : `最近 ${value} 天`, value })), { label: '自定义日期范围', value: 'custom' }]); if (range === null) return; if (range !== 'custom') { runtime.projectDays = range; runtime.projectCustomRange = null; await ctx.refresh(); return; } const dates = await ctx.form('自定义日期范围', [{ name: 'start', label: '开始日期（YYYY-MM-DD）' }, { name: 'end', label: '结束日期（YYYY-MM-DD）' }]); if (!dates) return; const validDate = value => { const valueText = String(value || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return false; const parsed = new Date(`${valueText}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === valueText; }; if (!validDate(dates.start) || !validDate(dates.end) || dates.start > dates.end) { await ctx.show('日期范围无效', '请输入有效日期，并确认结束日期不早于开始日期。'); return; } runtime.projectCustomRange = { start: dates.start, end: dates.end }; await ctx.refresh(); } },
          { label: '筛选客户端', toolbar: 'page', run: async ctx => { const options = [['', '全部客户端'], ['claude_code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['grok', 'Grok'], ['qwen_code', 'Qwen Code'], ['hermes', 'Hermes'], ['openclaw', 'OpenClaw'], ['deepseek_harness', 'DeepSeek Harness'], ['unknown', '未知/其他']]; const value = await ctx.choose('客户端来源', options.map(([id, label]) => ({ label, value: id }))); if (value !== null) { runtime.projectSource = value; await ctx.refresh(); } } },
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
        const sortLabels = { tokens: 'Token 数', requests: '请求数', points: '消耗积分', cache: '缓存命中率', balance: '当前余额' };
        const currentUserRank = Number(data && data.currentUserRank) || 0;
        const totalUsers = Number(data && data.totalUsers) || items.length;
        return { sections: [
          { title: '排行榜', toolbar: true, tableMinWidth: 114, columns: [
            { key: 'rank', label: '排名', ratio: 0.1 }, { key: 'username', label: '用户', ratio: 0.21 }, { key: 'requests', label: '请求数', ratio: 0.16 },
            { key: 'tokens', label: 'Token 数', ratio: 0.18 }, { key: 'points', label: '消耗积分', ratio: 0.14 }, { key: 'cache', label: '缓存命中率', ratio: 0.11 }, { key: 'balance', label: '当前余额', ratio: 0.1 },
          ], description: `最近 ${days} 天 · 按 ${sortLabels[sort] || sortLabels.tokens} 排序`, rows: items.length ? items.map((item, index) => {
            const rank = Number(item.rank) > 0 ? Number(item.rank) : index + 1;
            return { label: item.username || '未知用户', cells: {
              rank: `#${rank}`, username: `${item.username || '未知用户'}${item.isCurrentUser ? ' · 我' : ''}`, requests: Number(item.totalRequests || 0).toLocaleString(),
              tokens: formatBigNumber(item.totalTokens), points: Number(item.totalPoints || 0).toFixed(2), cache: `${Number(item.cacheHitRate || 0).toFixed(1)}%`, balance: Number(item.balance || 0).toFixed(2),
            } };
          }) : [{ label: '暂无排行数据。' }] },
          { title: '排行榜汇总', rows: [
            { label: `共 ${totalUsers.toLocaleString()} 名活跃用户` },
            ...(currentUserRank > 0 ? [{ label: `您的排名：第 ${currentUserRank} 名` }] : []),
          ] },
        ], actions: [
          ...[7, 30, 90, 365].map(value => ({ label: value === 365 ? '最近 1 年' : `最近 ${value} 天`, toolbar: true, run: async ctx => { runtime.leaderboardDays = value; await ctx.refresh(); } })),
          ...[['tokens', '按 Token 用量排序'], ['requests', '按请求次数排序'], ['points', '按消费积分排序'], ['cache', '按缓存命中率排序'], ['balance', '按余额积分排序']].map(([value, label]) => ({ label, toolbar: true, run: async ctx => { runtime.leaderboardSort = value; await ctx.refresh(); } })),
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    {
      id: 'audit-logs', label: '操作日志', description: '查看当前账号的操作记录。',
      async load(api) {
        const page = runtime.userAuditPage || 1;
        const resourceType = runtime.userAuditResourceType || '';
        const data = await api('/api/user/audit-logs', { query: { page, limit: 50, resource_type: resourceType } });
        const items = array(data && data.items);
        const total = Number(data.total || 0);
        const currentPage = Number(data.page || page);
        const totalPages = Math.max(1, Math.ceil(total / Number(data.limit || 50)));
        const actionLabel = value => ({ api_key: 'API Key 操作', 'api_key.create': '创建 API Key', 'api_key.update': '更新 API Key', 'api_key.delete': '删除 API Key', 'api_key.toggle': '启用/停用 API Key', 'api_key.models': '更新模型绑定', 'api_key.signature': '更新签名', 'auth.login': '登录', 'auth.login_2fa': '双重验证登录', 'auth.logout': '退出登录', 'user.settings': '更新个人设置', 'user.avatar': '更新头像', 'user.redeem': '兑换充值码', 'user.provider_create': '创建供应商', 'user.provider_update': '更新供应商', 'user.provider_delete': '删除供应商', 'user.model_create': '创建模型', 'user.model_update': '更新模型', 'user.model_delete': '删除模型' })[value] || String(value || '未知操作').replace(/[._]/g, ' ');
        const resourceLabel = value => ({ api_key: 'API Key', auth: '认证', user: '账户', provider: '供应商', model: '模型', team: '团队', policy: '策略' })[value] || (value ? String(value) : '全部资源');
        const rows = items.map(item => {
          const detailLines = [
            item.description && `说明：${item.description}`,
            item.resource_type && `目标：${resourceLabel(item.resource_type)}${item.resource_id ? ` #${item.resource_id}` : ''}`,
            item.status != null && `结果：HTTP ${item.status}`,
            item.duration_ms != null && `耗时：${item.duration_ms} 毫秒`,
            item.ip_address && `IP 地址：${item.ip_address}`,
            item.details && `详细信息：${typeof item.details === 'string' ? item.details : Object.entries(item.details).map(([key, value]) => `${key.replace(/_/g, ' ')}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ')}`,
          ].filter(Boolean);
          return { label: display(formatTime(item.created_at), actionLabel(item.action)), detail: detailLines.join('\n') || '没有额外说明。' };
        });
        const filters = `操作：${resourceLabel(resourceType)}`;
        return { sections: [{ title: '操作日志', description: `第 ${currentPage}/${totalPages} 页 · 共 ${total} 条 · ${filters}`, rows: rows.length ? rows : [{ label: '暂无操作日志。' }] }], actions: [
          { label: '筛选操作', toolbar: true, run: async ctx => { const options = [['', '全部操作'], ['api_key', 'API Key'], ['cokey', 'Co-Key'], ['user', '用户'], ['auth', '认证'], ['provider', '供应商'], ['model', '模型']]; const value = await ctx.choose('操作类型', options.map(([id, label]) => ({ label, value: id })), { description: `当前：${resourceLabel(resourceType)}` }); if (value !== null) { runtime.userAuditResourceType = value; runtime.userAuditPage = 1; await ctx.refresh(); } } },
          { label: '上一页', toolbar: true, disabled: currentPage <= 1, run: async ctx => { runtime.userAuditPage = Math.max(1, currentPage - 1); await ctx.refresh(); } },
          { label: '下一页', toolbar: true, disabled: currentPage >= totalPages, run: async ctx => { runtime.userAuditPage = Math.min(totalPages, currentPage + 1); await ctx.refresh(); } },
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
        const total = Number(data.total ?? items.length);
        const currentPage = Number(data.page || page);
        const pageSize = Number(data.limit || 30);
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const stats = data.stats || {};
        const adminCount = Number(stats.adminCount ?? items.filter(item => item.is_admin === true).length);
        const verifiedCount = Number(stats.verifiedCount ?? items.filter(item => item.email_verified === true).length);
        const totalBalance = Number(stats.totalBalance ?? items.reduce((sum, item) => sum + Number(item.balance || 0), 0));
        return { sections: [
          { title: '用户概览', cards: [{ label: '总用户数', value: total.toLocaleString() }, { label: '管理员', value: adminCount.toLocaleString() }, { label: '邮箱已验证', value: verifiedCount.toLocaleString() }, { label: '总积分', value: Math.round(totalBalance).toLocaleString() }] },
          { title: '用户列表', toolbar: true, description: `第 ${currentPage}/${totalPages} 页 · 共 ${total} 位用户${search ? ` · 搜索“${search}”` : ''}`, tableMinWidth: 120, columns: [
            { key: 'username', label: '用户名', ratio: 0.15 }, { key: 'email', label: '邮箱', ratio: 0.2 }, { key: 'verified', label: '验证状态', ratio: 0.12 },
            { key: 'balance', label: '积分', ratio: 0.1 }, { key: 'role', label: '角色', ratio: 0.1 }, { key: 'rate', label: '速率限制', ratio: 0.15 },
            { key: 'created', label: '注册时间', ratio: 0.1 }, { key: 'actions', label: '操作', ratio: 0.08 },
          ], rows: items.length ? items.map(item => ({ label: item.username || `用户 ${item.id}`, cells: {
            username: item.username || `用户 ${item.id}`, email: item.email || '—', verified: item.email_verified ? '已验证' : '未验证',
            balance: `${Math.round(Number(item.balance || 0))} 积分`, role: item.is_admin ? '管理员' : '普通用户',
            rate: `${item.rate_limit_rpm || item.rate_limit_tpm ? `${item.rate_limit_rpm || '不限'} 次/分 · ${item.rate_limit_tpm || '不限'} Token/分` : '不限制'}`,
            created: item.created_at ? formatTime(item.created_at) : '—', actions: 'Enter 管理',
          }, detail: `邮箱：${item.email || '未设置'} · 验证：${item.email_verified ? '已验证' : '未验证'} · 积分：${Math.round(Number(item.balance || 0))} · 角色：${item.is_admin ? '管理员' : '普通用户'} · Team：${item.team_name || '未分配'}`, run: async ctx => {
          const choice = await ctx.choose(`用户 · ${item.username || item.id}`, [
            { label: '查看详情', value: 'detail' }, { label: '修改用户', value: 'edit' }, { label: '查看余额记录', value: 'balance' }, { label: '退款', value: 'refund' },
          ]);
          if (choice === 'detail') await ctx.show(`用户详情 · ${item.username || item.id}`, [
            `用户编号：${item.id}`, `用户名：${item.username || '未设置'}`, `邮箱：${item.email || '未设置'}`, `邮箱验证：${item.email_verified ? '已验证' : '未验证'}`,
            `角色：${item.is_admin ? '管理员' : '普通用户'}`, `Team：${item.team_name || (item.team_id ? `Team ${item.team_id}` : '未分配')}`,
            `积分：${Math.round(Number(item.balance || 0))}`, `注册时间：${item.created_at ? formatTime(item.created_at) : '未知'}`,
            `速率限制：${item.rate_limit_rpm || item.rate_limit_tpm ? `${item.rate_limit_rpm || '不限'} 次/分 · ${item.rate_limit_tpm || '不限'} Token/分` : '不限制'}`,
            `标签：${array(item.tags).join('、') || '无'}`,
          ].join('\n'));
          if (choice === 'edit') {
            const [teamsResult, balancesResult] = await Promise.allSettled([api('/api/admin/teams'), api(`/api/admin/users/${encodeURIComponent(item.id)}/code-balances`)]);
            if (teamsResult.status === 'rejected') { await ctx.show('Team 列表暂不可用', teamsResult.reason.message || '无法读取 Team 列表，未打开编辑表单。'); return; }
            const teams = itemsOf(teamsResult.value);
            const codeBalances = balancesResult.status === 'fulfilled' ? array(balancesResult.value) : [];
            const availableRefund = codeBalances.reduce((sum, entry) => sum + Number(entry.net_amount || 0), 0);
            const values = await ctx.form('修改用户', [
              { name: 'email', label: '邮箱', value: item.email || '' },
              { name: 'email_verified', label: '邮箱验证状态', value: item.email_verified === true, options: [{ value: true, label: '已验证' }, { value: false, label: '未验证' }] },
              { name: 'isAdmin', label: '管理员权限', value: item.is_admin === true, options: [{ value: false, label: '普通用户' }, { value: true, label: '管理员' }] },
              { name: 'balance', label: '积分余额（留空不修改）', value: '' },
              { name: 'team_id', label: '所属 Team', value: item.team_id == null ? '' : String(item.team_id), options: [{ value: '', label: '未指定 Team' }, ...teams.map(team => ({ value: String(team.id), label: team.name }))] },
              { name: 'refund_info', label: '可退款余额（只读）', value: `${availableRefund.toFixed(2)} 积分 · ${codeBalances.length} 条兑换记录`, disabled: true },
              { name: 'rate_limit_rpm', label: '每分钟请求数限额（0 表示不限制；留空不修改）', value: '' },
              { name: 'rate_limit_tpm', label: '每分钟 Token 数限额（0 表示不限制；留空不修改）', value: '' },
              { name: 'tags', label: '用户标签（逗号分隔）', value: Array.isArray(item.tags) ? item.tags.join(', ') : '' },
            ], { description: 'Team 从名称列表中选择；留空表示不修改现有积分和速率限额。' });
            if (!values) return;
            const body = { email: values.email, email_verified: values.email_verified === true, isAdmin: values.isAdmin === true, tags: String(values.tags || '').split(',').map(tag => tag.trim()).filter(Boolean) };
            if (String(values.balance ?? '') !== '') body.balance = Number(values.balance);
            if (String(values.team_id ?? '') !== '') body.team_id = Number(values.team_id); else if (values.team_id === '') body.team_id = null;
            if (String(values.rate_limit_rpm ?? '') !== '') body.rate_limit_rpm = Number(values.rate_limit_rpm);
            if (String(values.rate_limit_tpm ?? '') !== '') body.rate_limit_tpm = Number(values.rate_limit_tpm);
            if (body.balance !== undefined && (!Number.isFinite(body.balance) || body.balance < 0 || body.balance >= 1000000)) { await ctx.show('积分余额无效', '积分余额必须是 0 到 999999.9999 之间的数字。'); return; }
            for (const field of ['rate_limit_rpm', 'rate_limit_tpm']) if (body[field] !== undefined && (!Number.isInteger(body[field]) || body[field] < 0)) { await ctx.show('速率限额无效', 'RPM 和 TPM 必须是非负整数；0 表示不限制。'); return; }
            if (!await ctx.confirm('确认更新用户', `${item.username}\n角色：${body.isAdmin ? '管理员' : '普通用户'} · 邮箱：${body.email_verified ? '已验证' : '未验证'} · Team：${teams.find(team => String(team.id) === String(body.team_id))?.name || (body.team_id == null ? '未指定' : `Team ${body.team_id}`)}${body.balance !== undefined ? ` · 积分 ${body.balance}` : ''}`)) return;
            await api(`/api/admin/users/${encodeURIComponent(item.id)}`, { method: 'PUT', body });
            ctx.notify('用户已更新。'); await ctx.refresh();
          }
          if (choice === 'balance') {
            const balances = array(await api(`/api/admin/users/${encodeURIComponent(item.id)}/code-balances`));
            const rows = balances.map(balance => { const amount = Number(balance.amount || 0); const feeRate = Number(balance.fee_rate || 0); const net = Number(balance.net_amount ?? amount / (1 + feeRate)); const code = String(balance.code || '未知兑换码'); const masked = code.length > 8 ? `${code.slice(0, 3)}…${code.slice(-3)}` : '已隐藏'; return `${masked} · 原余额 ${amount.toFixed(2)} · 可退净额 ${net.toFixed(2)} 积分 · 手续费 ${(feeRate * 100).toFixed(1)}%`; });
            await ctx.show(`可退款余额 · ${item.username}`, rows.length ? rows.join('\n') : '无可退款兑换码余额。');
          }
          if (choice === 'refund') {
            const balances = array(await api(`/api/admin/users/${encodeURIComponent(item.id)}/code-balances`));
            const available = balances.reduce((sum, balance) => sum + Number(balance.net_amount ?? Number(balance.amount || 0) / (1 + Number(balance.fee_rate || 0))), 0);
            if (available <= 0) { await ctx.show('无可退款余额', `${item.username} 当前没有可退兑换码余额。`); return; }
            const amountText = String(await ctx.ask('退款金额（可退净额）', { description: `最多可退 ${available.toFixed(2)}；服务端将按手续费率从高到低扣除。` }) || '').trim();
            if (!amountText) return;
            const amount = Number(amountText);
            if (!Number.isFinite(amount) || amount <= 0 || amount >= 1000000 || !/^\d+(?:\.\d{1,2})?$/.test(amountText) || amount > available + 0.000001) { await ctx.show('退款金额无效', `请输入最多两位小数且不超过可退净额 ${available.toFixed(2)} 的正数。`); return; }
            if (!await ctx.confirm('确认退款', `用户：${item.username}\n退款净额：${amount.toFixed(2)}\n可退余额：${available.toFixed(2)}\n服务器将按手续费率从高到低扣除。`)) return;
            const result = await api(`/api/admin/users/${encodeURIComponent(item.id)}/refund`, { method: 'POST', body: { refundAmount: amount } });
            await ctx.show('退款结果', `实际退款：${Number(result.actualRefundAmount ?? amount).toFixed(2)}\n总余额扣除：${Number(result.grossDeducted || 0).toFixed(2)}\n剩余可退款余额：${Number(result.newRefundBalance || 0).toFixed(2)}`); await ctx.refresh();
          }
        } })) : [{ label: '暂无用户', detail: '未找到符合条件的用户。' }] }], actions: [
          { label: '搜索用户', run: async ctx => { runtime.adminUsersSearch = String(await ctx.ask('用户名或邮箱') || '').trim(); runtime.adminUsersPage = 1; await ctx.refresh(); } },
          { label: '上一页', toolbar: true, disabled: currentPage <= 1, run: async ctx => { runtime.adminUsersPage = Math.max(1, currentPage - 1); await ctx.refresh(); } },
          { label: '下一页', toolbar: true, disabled: currentPage >= totalPages, run: async ctx => { runtime.adminUsersPage = Math.min(totalPages, currentPage + 1); await ctx.refresh(); } },
          { label: '生成邀请链接', run: async ctx => { await ctx.navigate('admin-invites'); } },
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
        return { sections: [{ title: '调用错误', description: `第 ${data.page || page} 页 · 共 ${data.total || 0} 条 · 保留 ${data.retention_days || '—'} 天`, rows: items.map(item => ({ label: display(formatTime(item.created_at), item.model_name || item.model_id || '未知模型', item.provider_name || '未知供应商', item.status_code ? `状态码 ${item.status_code}` : '无状态码', item.is_final === false ? '仍在回退' : '最终错误'), detail: display(item.error_message, item.username || (item.user_id ? `用户编号 ${item.user_id}` : ''), item.latency_ms != null && `响应时间 ${item.latency_ms} 毫秒`), run: async ctx => {
          const choice = await ctx.choose('错误详情', [{ label: '基本信息', value: 'overview' }, { label: '错误信息', value: 'message' }, { label: '原始响应', value: 'response' }], { description: `${item.model_name || item.model_id || '未知模型'} · ${item.provider_name || item.provider_id || '未知供应商'}` });
          if (choice === 'overview') {
            const rows = [
              `时间：${formatTime(item.created_at)}`, `用户：${item.username || (item.user_id ? `用户编号 ${item.user_id}` : '未知')}`,
              `模型：${item.model_name || item.model_id || '未知模型'}`, item.series && `模型系列：${item.series}`,
              `上游模型 ID：${item.upstream_model_id || item.model_id || '未知'}`, `供应商：${item.provider_name || item.provider_id || '未知供应商'}`,
              `请求状态码：${item.status_code ?? '未知'}`, `错误类别：${item.error_type || '未分类'}`,
              `请求结果：${item.is_final ? '最终失败（已返回客户端）' : '中间失败（系统仍在尝试备用模型）'}`,
              `响应时间：${item.latency_ms != null ? `${item.latency_ms} 毫秒` : '未知'}`, `请求来源地址：${item.ip_address || '未知'}`,
              `调用密钥：${item.key_prefix ? `${item.key_prefix}••••${item.key_name ? ` · ${item.key_name}` : ''}` : '未知'}`,
            ].filter(Boolean).join('\n');
            await ctx.show('错误详情 · 基本信息', rows);
          } else if (choice === 'message') await ctx.show('错误信息', item.error_message || '此记录没有详细错误信息。');
          else if (choice === 'response') {
            let body = String(item.error_body || '').trim();
            try { if (body) body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
            await ctx.show('原始响应', body || '此记录没有原始响应。');
          }
        } })) }], actions: [
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
        const historyPage = Number(historyData.page || page);
        const historyPageSize = Number(historyData.pageSize || historyData.page_size || 20);
        const historyTotal = Number(historyData.total || 0);
        const historyPages = Math.max(1, Math.ceil(historyTotal / historyPageSize));
        return { sections: [
          { title: '注入提示词', description: '启用的条目会追加到匹配 API Key 的 system 提示词末尾。', rows: injectedItems.length ? injectedItems.map(item => ({ label: display(item.name, item.enabled === false ? '停用' : '启用', item.bound_key_ids?.length ? `绑定 ${item.bound_key_ids.length} 个 API Key` : '对所有 API Key 生效'), detail: display(item.content && `${String(item.content).length} 字符`, item.content && String(item.content).replace(/\s+/g, ' ').slice(0, 100)), run: async ctx => {
            const choice = await ctx.choose(`注入提示词 · ${item.name || item.id}`, [{ label: '查看详情', value: 'detail' }, { label: '编辑名称和内容', value: 'edit' }, { label: item.enabled === false ? '启用条目' : '停用条目', value: 'toggle' }, { label: '绑定 Key', value: 'keys' }, { label: '删除条目', value: 'delete' }]);
            if (choice === 'detail') { const keys = array(item.bound_keys); const details = [
              `名称：${item.name || '未命名'}`, `状态：${item.enabled === false ? '已停用' : '已启用'}`,
              `生效范围：${keys.length ? `绑定到 ${keys.length} 个 Key` : '全局（当前用户的所有 Key）'}`,
              `字符数：${String(item.content || '').length}`, `创建时间：${formatTime(item.created_at)}`, `最近更新时间：${formatTime(item.updated_at)}`,
              keys.length ? `绑定的 API Key：${keys.map(key => `${key.name || '未命名'}${key.key_prefix ? ` (${key.key_prefix}••••)` : ''}`).join('、')}` : '', '', '注入内容：', String(item.content || '（内容为空）'),
            ].filter(Boolean).join('\n'); await ctx.show(`注入提示词 · ${item.name || item.id}`, details); }
            if (choice === 'edit') { const values = await ctx.form('编辑注入提示词', [{ name: 'name', label: '名称', value: item.name || '' }, { name: 'content', label: '内容（UTF-8 不超过 32KB）', value: item.content || '' }]); if (!values) return; const name = String(values.name || '').trim(); const content = String(values.content || ''); if (!name || !content.trim()) { await ctx.show('内容无效', '名称和内容均不能为空。'); return; } if (Buffer.byteLength(content, 'utf8') > 32 * 1024) { await ctx.show('内容超出限制', '注入提示词内容不能超过 32KB（UTF-8 字节）。'); return; } if (!await ctx.confirm('保存注入提示词', `名称：${name}\n内容：${content.length} 字符\n现有 Key 绑定保持不变。`)) return; await api(`/api/user/inject-prompts/${item.id}`, { method: 'PUT', body: { name, content } }); ctx.notify('注入提示词已更新。'); await ctx.refresh(); }
            if (choice === 'toggle') { const enabled = item.enabled === false; if (!await ctx.confirm(enabled ? '启用提示词条目' : '停用提示词条目', `${item.name}\n${enabled ? '此内容将加入匹配 API Key 的系统提示词。' : '此内容将不再注入转发请求。'}`)) return; await api(`/api/user/inject-prompts/${item.id}/toggle`, { method: 'PUT', body: { enabled } }); ctx.notify(`提示词条目已${enabled ? '启用' : '停用'}。`); await ctx.refresh(); }
            if (choice === 'keys') { const keys = itemsOf(await api('/api/user/inject-prompts/my-keys')); const current = array(item.bound_key_ids).map(Number); const input = await ctx.ask('绑定的 Key ID（逗号分隔；留空表示全局生效）', { defaultValue: current.join(','), description: keys.map(key => `${key.id}: ${key.name}${key.key_prefix ? ` (${key.key_prefix})` : ''}`).join(' · ') || '暂无 API Key' }); if (input === null) return; const ids = String(input).split(',').map(value => value.trim()).filter(Boolean).map(Number).filter(id => Number.isInteger(id) && id > 0); if (!ids.length && !await ctx.confirm('设为全局生效', '空 Key 列表意味着该注入提示词对所有 API Key 生效，确认继续？')) return; if (!await ctx.confirm('保存 Key 绑定', `${item.name}\nKey ID：${ids.join(', ') || '全局生效'}`)) return; await api(`/api/user/inject-prompts/${item.id}/keys`, { method: 'PUT', body: { keyIds: ids } }); ctx.notify('提示词 Key 绑定已更新。'); await ctx.refresh(); }
            if (choice === 'delete') { if (!await ctx.confirm('删除提示词条目', `删除「${item.name}」？匹配请求将不再注入此内容。`)) return; await api(`/api/user/inject-prompts/${item.id}`, { method: 'DELETE' }); ctx.notify('提示词条目已删除。'); await ctx.refresh(); }
          } })) : [{ label: injected.status === 'rejected' ? injected.reason.message : '暂无注入提示词。' }], actions: [
            { label: '新建注入条目', run: async ctx => { const values = await ctx.form('新建注入提示词', [{ name: 'name', label: '名称（最多 200 字符）' }, { name: 'content', label: '内容（UTF-8 不超过 32KB）' }], { description: '创建后默认停用；可在条目操作中启用并设置 Key 范围。' }); if (!values) return; const name = String(values.name || '').trim(); const content = String(values.content || ''); if (!name || [...name].length > 200 || !content.trim()) { await ctx.show('内容无效', '名称需为 1–200 个字符，且内容不能为空。'); return; } if (Buffer.byteLength(content, 'utf8') > 32 * 1024) { await ctx.show('内容超出限制', '提示词内容不能超过 32KB（UTF-8 字节）。'); return; } if (!await ctx.confirm('创建注入提示词', `名称：${name}\n内容：${content.length} 字符\n创建后默认停用，不会立即影响请求。`)) return; await api('/api/user/inject-prompts', { method: 'POST', body: { name, content } }); ctx.notify('注入提示词已创建。'); await ctx.refresh(); } },
          ] },
          { title: '提示词', toolbar: true, description: `历史收集到的自定义提示词文件；相同内容自动合并显示。第 ${historyPage}/${historyPages} 页 · 共 ${historyTotal} 条`, rows: promptItems.length ? promptItems.map(item => ({ label: display(item.file, clientSourceLabel(item.source), `${item.chars || 0} 字符`, `${item.occurrence_count || 0} 次`), detail: display(item.preview, formatTime(item.first_seen), formatTime(item.last_seen)), run: async ctx => { const detail = await api(`/api/user/custom-instructions/${encodeURIComponent(item.fingerprint)}`); const source = clientSourceLabel; const lines = [`文件：${detail.file || '未知文件'}`, `客户端来源：${source(detail.source)}`, `出现次数：${detail.occurrence_count || 0} 次`, `首次出现：${formatTime(detail.first_seen)}`, `最近出现：${formatTime(detail.last_seen)}`, `字符数：${detail.chars || 0}${detail.truncated ? '（内容已截断）' : ''}`, '','提示词内容：',String(detail.content || '（没有可显示的内容）'), '', `最近 ${array(detail.recent_refs).length} 条调用：`, ...array(detail.recent_refs).map(ref => `${formatTime(ref.created_at)} · ${ref.model_id || '未知模型'} · ${source(ref.request_source)}`)]; await ctx.show(`提示词 · ${detail.file || '未知文件'}`, lines.join('\\n')); } })) : [{ label: history.status === 'rejected' ? history.reason.message : '暂无历史提示词。' }] },
        ], actions: [
          { label: '搜索历史提示词', toolbar: true, run: async ctx => { runtime.promptSearch = String(await ctx.ask('搜索文件名或内容', { defaultValue: runtime.promptSearch || '' }) || '').trim(); runtime.promptPage = 1; await ctx.refresh(); } },
          { label: '筛选客户端来源', toolbar: true, run: async ctx => { const value = await ctx.choose('客户端来源', [{ label: '全部客户端', value: '' }, ...[['claude_code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['grok', 'Grok'], ['qwen_code', 'Qwen Code'], ['hermes', 'Hermes'], ['openclaw', 'OpenClaw'], ['deepseek_harness', 'DeepSeek Harness'], ['unknown', '未知/其他']].map(([id, name]) => ({ label: name, value: id }))]); if (value !== null) { runtime.promptSource = value; runtime.promptPage = 1; await ctx.refresh(); } } },
          ...[['count', '按出现次数排序'], ['last_seen', '按最近出现排序'], ['first_seen', '按首次出现排序']].map(([value, label]) => ({ label, toolbar: true, run: async ctx => { runtime.promptSort = value; runtime.promptPage = 1; await ctx.refresh(); } })),
          { label: '清除提示词筛选', toolbar: true, run: async ctx => { runtime.promptSearch = ''; runtime.promptSource = ''; runtime.promptSort = 'count'; runtime.promptPage = 1; await ctx.refresh(); } },
          { label: '上一页', toolbar: true, disabled: historyPage <= 1, run: async ctx => { runtime.promptPage = Math.max(1, historyPage - 1); await ctx.refresh(); } },
          { label: '下一页', toolbar: true, disabled: historyPage >= historyPages, run: async ctx => { runtime.promptPage = Math.min(historyPages, historyPage + 1); await ctx.refresh(); } },
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
        const page = runtime.adminModelPage || 1;
        const data = await api('/api/admin/models', { query: { page, limit: 30, q: runtime.adminModelSearch || '', ...filters } });
        const items = array(data && (data.items || data));
        const providers = array(data && data.providers);
        const seriesOptions = array(data && data.series);
        const selectedIds = new Set(runtime.adminModelSelectedIds || []);
        const modelRows = items.map(item => {
          const input = item.input_price_per_1k_tokens;
          const output = item.output_price_per_1k_tokens;
          const cached = item.cached_output_price_per_1k_tokens;
          const testState = item.test_ok === true ? `通过 · ${Math.round(Number(item.test_latency_ms) || 0)} 毫秒${item.test_tokens_per_second != null ? ` · ${Number(item.test_tokens_per_second).toFixed(2)} Token/秒` : ''}` : item.test_ok === false ? `失败${item.test_error ? ` · ${String(item.test_error).replace(/\\s+/g, ' ').slice(0, 48)}` : ''}` : '未测试';
          const details = [
            `上游模型 ID：${item.upstream_model_id || item.name || item.id}`, `系列：${item.series || '无'}`, `供应商：${item.provider_name || item.provider || '未知供应商'}`,
            `输入价格：${input ?? '—'} 元/千 Token`, `输出价格：${output ?? '—'} 元/千 Token`, `缓存输出价格：${cached ?? '—'} 元/千 Token`,
            `参考输入/输出价：${item.reference_input_price_per_1k_tokens ?? '—'} / ${item.reference_output_price_per_1k_tokens ?? '—'} 元/千 Token`,
            item.reference_cached_output_price_per_1k_tokens != null && `参考缓存输出价：${item.reference_cached_output_price_per_1k_tokens} 元/千 Token`,
            `计费倍率：${Number(item.model_multiplier ?? 1).toFixed(2)} · 输出倍率 ${Number(item.completion_multiplier ?? 1).toFixed(2)}`,
            `速率限制：${Number(item.rate_limit_rpm || 0) || '不限'} 次/分钟 · ${Number(item.rate_limit_tpm || 0) || '不限'} Token/分钟`,
            `状态：${item.enabled === false ? '已停用' : '已启用'}`, `接口测试：${testState}`,
            item.test_error && `测试错误：${String(item.test_error).replace(/\s+/g, ' ').slice(0, 240)}`, item.description && `模型说明：${item.description}`,
          ].filter(Boolean).join('\n');
          return { label: display(item.alias || item.name, item.name !== item.alias ? item.name : '', item.id), cells: {
            name: item.alias || item.name || item.id, provider: item.provider_name || item.provider || '未知', series: item.series || '无',
            multiplier: `×${Number(item.model_multiplier ?? 1).toFixed(2)}`, input: `${input ?? '—'} 元`, output: `${output ?? '—'} 元`, cached: `${cached ?? '—'} 元`,
            limits: `${Number(item.rate_limit_rpm || 0) || '不限'} 次/分 · ${Number(item.rate_limit_tpm || 0) || '不限'} Token/分`,
            state: `${item.enabled === false ? '已停用' : '已启用'} · ${testState}`,
          }, detail: `${selectedIds.has(String(item.id)) ? '已选中 · ' : ''}${details}`, run: async ctx => {
            const choice = await ctx.choose('模型操作', [{ label: selectedIds.has(String(item.id)) ? '取消选择' : '加入批量选择', value: 'select' }, { label: '查看详情', value: 'detail' }, { label: '编辑模型', value: 'edit' }, { label: '测试模型', value: 'test' }, { label: '删除模型', value: 'delete' }]);
            if (choice === 'select') { if (selectedIds.has(String(item.id))) selectedIds.delete(String(item.id)); else selectedIds.add(String(item.id)); runtime.adminModelSelectedIds = [...selectedIds]; await ctx.refresh(); }
            if (choice === 'detail') await ctx.show(`模型详情 · ${item.alias || item.name || item.id}`, details);
            if (choice === 'edit') {
              const values = await ctx.form('编辑模型', [
                { name: 'upstream_model_id', label: '上游模型 ID', value: item.upstream_model_id || item.name || item.id },
                { name: 'alias', label: '显示名称', value: item.alias || '' },
                { name: 'provider', label: '供应商', value: item.provider, options: [{ label: providers.find(provider => String(provider.id) === String(item.provider))?.name || item.provider, value: item.provider }, ...providers.filter(provider => String(provider.id) !== String(item.provider)).map(provider => ({ label: provider.name, value: provider.id }))] },
                { name: 'series', label: '模型系列', value: item.series || '' }, { name: 'description', label: '模型说明', value: item.description || '' },
                { name: 'enabled', label: '启用模型', type: 'boolean', value: item.enabled !== false },
                { name: 'forward_reasoning_effort', label: '透传思考强度参数', type: 'boolean', value: item.forward_reasoning_effort === true },
                ...[['input_price_per_1k_tokens', '输入价格（元/千 Token）'], ['output_price_per_1k_tokens', '输出价格（元/千 Token）'], ['cached_output_price_per_1k_tokens', '缓存输出价格（元/千 Token）'], ['reference_input_price_per_1k_tokens', '参考输入价格（元/千 Token）'], ['reference_output_price_per_1k_tokens', '参考输出价格（元/千 Token）'], ['reference_cached_output_price_per_1k_tokens', '参考缓存输出价格（元/千 Token）'], ['rate_limit_rpm', '每分钟最大请求数（不限制填 0）'], ['rate_limit_tpm', '每分钟最大 Token 数（不限制填 0）'], ['model_multiplier', '计费倍率'], ['completion_multiplier', '输出倍率']].map(([name, label]) => ({ name, label, value: String(item[name] ?? (name.includes('multiplier') ? 1 : 0)) })),
                { name: 'thinking_model_id', label: '思考模式模型 ID', value: item.thinking_model_id || '', options: [{ label: '使用自身', value: '' }, ...items.map(model => ({ label: model.alias || model.name || model.id, value: model.id }))] }, { name: 'non_thinking_model_id', label: '非思考模式模型 ID', value: item.non_thinking_model_id || '', options: [{ label: '使用自身', value: '' }, ...items.map(model => ({ label: model.alias || model.name || model.id, value: model.id }))] },
              ]);
              if (!values || !String(values.provider || '').trim()) return;
              if (!await ctx.confirm('保存模型修改', `${values.alias || values.upstream_model_id}\n供应商：${providers.find(provider => String(provider.id) === String(values.provider))?.name || values.provider}\n将覆盖该模型的价格、倍率和限额设置。`)) return;
              const numberFields = ['input_price_per_1k_tokens', 'output_price_per_1k_tokens', 'cached_output_price_per_1k_tokens', 'reference_input_price_per_1k_tokens', 'reference_output_price_per_1k_tokens', 'reference_cached_output_price_per_1k_tokens', 'rate_limit_rpm', 'rate_limit_tpm', 'model_multiplier', 'completion_multiplier'];
              const body = { id: item.id, ...values };
              for (const field of numberFields) body[field] = Number(values[field] || 0);
              await api('/api/admin/models', { method: 'POST', body });
              ctx.notify('模型已更新。'); await ctx.refresh();
            }
            if (choice === 'delete') {
              if (!await ctx.confirm('删除模型并清理关联', `将删除「${item.alias || item.name || item.id}」及其团队授权、API Key 绑定等关联数据。此操作不可撤销。`)) return;
              await api(`/api/admin/models/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
              ctx.notify('模型及其关联已删除。'); await ctx.refresh();
            }
            if (choice === 'test') {
              if (!await ctx.confirm('测试模型', `将使用当前模型配置对 ${item.alias || item.name || item.id} 发起一次真实测试请求。继续？`)) return;
              const result = await api(`/api/admin/models/${encodeURIComponent(item.id)}/test`, { method: 'POST', body: {} });
              const output = [`结果：${result.ok === false ? '失败' : '完成'}`, result.latency_ms != null && `响应时间：${Math.round(Number(result.latency_ms))} 毫秒`, result.tokens_per_second != null && `输出速度：${Number(result.tokens_per_second).toFixed(1)} Token/秒`, result.error && `错误：${String(result.error).replace(/\s+/g, ' ').slice(0, 400)}`, result.message && `说明：${result.message}`].filter(Boolean).join('\n');
              await ctx.show(`模型测试 · ${item.alias || item.name || item.id}`, output || '测试请求已完成。');
            }
          } };
        });
        const stats = data.stats || {};
        const sections = [{ title: '模型管理', description: `第 ${data.page || page} 页 · 共 ${data.total || items.length} 个模型`, cards: [
          { label: '当前筛选模型', value: `${data.total || items.length} 个` },
          { label: '已启用', value: `${stats.enabledCount ?? items.filter(item => item.enabled !== false).length} 个` },
          { label: '供应商数', value: `${stats.providerCount ?? new Set(items.map(item => item.provider)).size} 个` },
          { label: '平均输入价', value: `${Number(stats.avgInputPrice || 0).toFixed(4)} 元/千 Token` },
        ], tableMinWidth: 170, columns: [
          { key: 'name', label: '模型名称', ratio: 0.16 }, { key: 'provider', label: '供应商', ratio: 0.11 }, { key: 'series', label: '系列', ratio: 0.07 },
          { key: 'input', label: '输入价/千Token', ratio: 0.1 }, { key: 'output', label: '输出价/千Token', ratio: 0.1 }, { key: 'multiplier', label: '倍率', ratio: 0.06 },
          { key: 'cached', label: '缓存输出价', ratio: 0.09 }, { key: 'limits', label: '请求/Token限额', ratio: 0.13 }, { key: 'state', label: '状态/测试', ratio: 0.18 },
        ], rows: modelRows.length ? modelRows : [{ label: '没有符合条件的模型。' }] }];
        return { sections, pageToolbar: true, actions: [
          { label: '添加模型', toolbar: 'page', run: async ctx => {
            const values = await ctx.form('添加模型', [
              { name: 'upstream_model_id', label: '上游模型 ID（必填）' }, { name: 'alias', label: '显示名称（可空）' },
              { name: 'provider', label: '供应商', options: providers.map(provider => ({ label: provider.name, value: provider.id })) },
              { name: 'series', label: '模型系列' }, { name: 'description', label: '模型说明' }, { name: 'enabled', label: '启用模型', type: 'boolean', value: true },
              ...[['input_price_per_1k_tokens', '输入价格（元/千 Token）'], ['output_price_per_1k_tokens', '输出价格（元/千 Token）'], ['cached_output_price_per_1k_tokens', '缓存输出价格（元/千 Token）'], ['reference_input_price_per_1k_tokens', '参考输入价格（元/千 Token）'], ['reference_output_price_per_1k_tokens', '参考输出价格（元/千 Token）'], ['reference_cached_output_price_per_1k_tokens', '参考缓存输出价格（元/千 Token）'], ['rate_limit_rpm', '每分钟最大请求数（不限制填 0）'], ['rate_limit_tpm', '每分钟最大 Token 数（不限制填 0）'], ['model_multiplier', '计费倍率'], ['completion_multiplier', '输出倍率']].map(([name, label]) => ({ name, label, value: name.includes('multiplier') ? '1' : '0' })),
              { name: 'thinking_model_id', label: '思考模式模型 ID（可空）' }, { name: 'non_thinking_model_id', label: '非思考模式模型 ID（可空）' },
            ]);
            if (!values || !String(values.upstream_model_id || '').trim() || !String(values.provider || '').trim()) return;
            if (!await ctx.confirm('创建模型', `${values.alias || values.upstream_model_id}\n供应商：${providers.find(provider => String(provider.id) === String(values.provider))?.name || values.provider}\n该模型将自动加入适用的前沿团队。`)) return;
            const numberFields = ['input_price_per_1k_tokens', 'output_price_per_1k_tokens', 'cached_output_price_per_1k_tokens', 'reference_input_price_per_1k_tokens', 'reference_output_price_per_1k_tokens', 'reference_cached_output_price_per_1k_tokens', 'rate_limit_rpm', 'rate_limit_tpm', 'model_multiplier', 'completion_multiplier'];
            const body = { ...values };
            for (const field of numberFields) body[field] = Number(values[field] || 0);
            await api('/api/admin/models', { method: 'POST', body });
            runtime.adminModelPage = 1; ctx.notify('模型已创建。'); await ctx.refresh();
          } },
          { label: `批量管理${selectedIds.size ? `（已选 ${selectedIds.size}）` : ''}`, toolbar: 'page', run: async ctx => {
            if (!selectedIds.size) { await ctx.show('批量管理模型', '先在模型列表中打开模型操作菜单，选择“加入批量选择”。'); return; }
            const operation = await ctx.choose('批量管理模型', [{ label: '启用所选模型', value: 'enable' }, { label: '禁用所选模型', value: 'disable' }, { label: '设置所选模型价格', value: 'prices' }, { label: '设置所选模型参考价格', value: 'reference-prices' }, { label: '同步缓存价格为输出价格', value: 'sync-cached' }, { label: '设置所选模型速率限制', value: 'limits' }, { label: '修改所选模型说明', value: 'description' }, { label: '设置所选模型系列', value: 'series' }, { label: '删除所选模型', value: 'delete' }, { label: '清空所选', value: 'clear' }]);
            if (!operation) return;
            const ids = [...selectedIds];
            if (operation === 'clear') { runtime.adminModelSelectedIds = []; await ctx.refresh(); return; }
            if (operation === 'enable' || operation === 'disable') {
              const enabled = operation === 'enable';
              if (!await ctx.confirm(enabled ? '批量启用模型' : '批量禁用模型', `将${enabled ? '启用' : '禁用'} ${ids.length} 个模型。禁用时可能清除没有其他团队授权的 API Key 当前模型绑定。`)) return;
              const result = await api('/api/admin/models/batch-update', { method: 'POST', body: { ids, enabled } });
              runtime.adminModelSelectedIds = []; ctx.notify(`已更新 ${result.updated || ids.length} 个模型${result.cleared_keys ? `；清除了 ${result.cleared_keys} 个 Key 当前模型绑定` : ''}。`); await ctx.refresh(); return;
            }
            if (operation === 'prices') {
              const mode = await ctx.choose('批量改价方式', [{ label: '设置为指定价格', value: 'set' }, { label: '按百分比调整现有价格', value: 'multiply' }]);
              if (!mode) return;
              if (mode === 'multiply') {
                const percentage = await ctx.ask('价格调整百分比（例如 10 表示上调 10%，-10 表示下调 10%）', { defaultValue: '0' });
                if (percentage === null || !Number.isFinite(Number(percentage)) || Number(percentage) <= -100) return;
                if (!await ctx.confirm('确认按比例调整价格', `将对 ${ids.length} 个模型的输入、输出与缓存输出价格分别${Number(percentage) >= 0 ? '上调' : '下调'} ${Math.abs(Number(percentage))}%。`)) return;
                const result = await api('/api/admin/models/batch-update-prices', { method: 'POST', body: { ids, mode: 'multiply', percentage: Number(percentage) } });
                runtime.adminModelSelectedIds = []; ctx.notify(`已按比例调整 ${result.updated || ids.length} 个模型价格。`); await ctx.refresh(); return;
              }
              const values = await ctx.form('批量设置模型价格', [['input_price', '输入价格（元/千 Token）'], ['output_price', '输出价格（元/千 Token）'], ['cached_output_price', '缓存输出价格（元/千 Token）']].map(([name, label]) => ({ name, label })));
              if (!values || !await ctx.confirm('确认批量改价', `将覆盖 ${ids.length} 个模型的输入、输出和缓存输出价格。`)) return;
              for (const key of Object.keys(values)) values[key] = Number(values[key] || 0);
              const result = await api('/api/admin/models/batch-update-prices', { method: 'POST', body: { ids, mode: 'set', ...values } });
              runtime.adminModelSelectedIds = []; ctx.notify(`已更新 ${result.updated || ids.length} 个模型价格。`); await ctx.refresh(); return;
            }
            if (operation === 'reference-prices') {
              const values = await ctx.form('批量设置模型参考价格', [['in', '参考输入价格（元/千 Token）'], ['out', '参考输出价格（元/千 Token）']].map(([name, label]) => ({ name, label })));
              if (!values || (!String(values.in || '').trim() && !String(values.out || '').trim())) return;
              if (!await ctx.confirm('确认更新参考价格', `将更新所选 ${ids.length} 个模型中已填写的参考价格；留空项保持原值。`)) return;
              const prices = Object.fromEntries(ids.map(id => [id, { ...(String(values.in || '').trim() ? { in: Number(values.in) } : {}), ...(String(values.out || '').trim() ? { out: Number(values.out) } : {}) }]));
              await api('/api/admin/models/batch-set-reference-prices', { method: 'POST', body: { prices } });
              runtime.adminModelSelectedIds = []; ctx.notify('参考价格已更新。'); await ctx.refresh(); return;
            }
            if (operation === 'sync-cached') {
              if (!await ctx.confirm('同步缓存输出价格', `将把 ${ids.length} 个模型的缓存输出价设置为其当前输出价，覆盖既有缓存价格。`)) return;
              const result = await api('/api/admin/models/batch-sync-cached-price', { method: 'POST', body: { ids } });
              runtime.adminModelSelectedIds = []; ctx.notify(`已同步 ${result.updated || ids.length} 个模型的缓存输出价格。`); await ctx.refresh(); return;
            }
            if (operation === 'limits') {
              const values = await ctx.form('批量设置模型速率限制', [{ name: 'rate_limit_rpm', label: '每分钟最大请求数（0 表示不限）' }, { name: 'rate_limit_tpm', label: '每分钟最大 Token 数（0 表示不限）' }]);
              if (!values || !await ctx.confirm('确认批量修改限额', `将修改 ${ids.length} 个模型的每分钟请求与 Token 限额。`)) return;
              await api('/api/admin/models/batch-update-ratelimit', { method: 'POST', body: { ids, rate_limit_rpm: Number(values.rate_limit_rpm || 0), rate_limit_tpm: Number(values.rate_limit_tpm || 0) } });
              runtime.adminModelSelectedIds = []; ctx.notify('模型限额已更新。'); await ctx.refresh(); return;
            }
            if (operation === 'description' || operation === 'series') {
              const field = operation === 'description' ? 'description' : 'series';
              const value = await ctx.ask(operation === 'description' ? '新的模型说明' : '新的模型系列');
              if (value === null || !await ctx.confirm(operation === 'description' ? '确认修改模型说明' : '确认修改模型系列', `将更新 ${ids.length} 个模型。`)) return;
              await api(operation === 'description' ? '/api/admin/models/batch-update-description' : '/api/admin/models/batch-update-series', { method: 'POST', body: { ids, [field]: value } });
              runtime.adminModelSelectedIds = []; ctx.notify('所选模型已更新。'); await ctx.refresh(); return;
            }
            if (operation === 'delete') {
              if (!await ctx.confirm('批量删除模型并清理关联', `将永久删除 ${ids.length} 个模型及其团队授权、API Key 绑定等关联数据。此操作不可撤销。`)) return;
              const result = await api('/api/admin/models/batch-delete', { method: 'POST', body: { ids } });
              runtime.adminModelSelectedIds = []; ctx.notify(`已删除 ${result.deleted || ids.length} 个模型及其关联。`); await ctx.refresh();
            }
          } },
          { label: '搜索模型', toolbar: 'page', run: async ctx => { runtime.adminModelSearch = String(await ctx.ask('模型名称、别名、上游 ID、系列或说明', { defaultValue: runtime.adminModelSearch || '' }) || '').trim(); runtime.adminModelPage = 1; await ctx.refresh(); } },
          { label: '筛选供应商', toolbar: 'page', run: async ctx => { const value = await ctx.choose('供应商', [{ label: '全部供应商', value: '' }, ...providers.map(item => ({ label: `${item.name} · ${item.model_count} 个模型`, value: item.id }))]); if (value !== null) { runtime.adminModelFilters = { ...filters, provider: value }; runtime.adminModelPage = 1; await ctx.refresh(); } } },
          { label: '筛选系列', toolbar: 'page', run: async ctx => { const value = await ctx.choose('模型系列', [{ label: '全部系列', value: '' }, ...seriesOptions.map(item => ({ label: item, value: item }))]); if (value !== null) { runtime.adminModelFilters = { ...filters, series: value }; runtime.adminModelPage = 1; await ctx.refresh(); } } },
          { label: '筛选启用状态', toolbar: 'page', run: async ctx => { const value = await ctx.choose('模型启用状态', [{ label: '全部', value: '' }, { label: '已启用', value: 'true' }, { label: '已禁用', value: 'false' }]); if (value !== null) { runtime.adminModelFilters = { ...filters, enabled: value }; runtime.adminModelPage = 1; await ctx.refresh(); } } },
          { label: '筛选测试状态', toolbar: 'page', run: async ctx => { const value = await ctx.choose('模型测试状态', [{ label: '全部', value: '' }, { label: '测试通过', value: 'pass' }, { label: '测试失败', value: 'fail' }, { label: '未测试', value: 'untested' }]); if (value !== null) { runtime.adminModelFilters = { ...filters, test: value }; runtime.adminModelPage = 1; await ctx.refresh(); } } },
          { label: '清除筛选', toolbar: 'page', run: async ctx => { runtime.adminModelFilters = {}; runtime.adminModelPage = 1; await ctx.refresh(); } },
          { label: '测试当前筛选模型', toolbar: 'page', run: async ctx => {
            const total = Number(data.total || items.length);
            if (!total) { await ctx.show('批量测试模型', '当前筛选结果没有模型。'); return; }
            if (!await ctx.confirm('测试当前筛选模型', `将逐个对当前筛选的 ${total} 个模型发起真实测试请求；每个测试都可能调用上游服务。继续？`)) return;
            let completed = 0; let testPage = 1;
            while (true) {
              const result = await api('/api/admin/models', { query: { page: testPage, limit: 200, q: runtime.adminModelSearch || '', ...filters } });
              const pageItems = array(result.items || result);
              for (const item of pageItems) { await api(`/api/admin/models/${encodeURIComponent(item.id)}/test`, { method: 'POST', body: {} }); completed++; }
              if (!pageItems.length || completed >= total || pageItems.length < 200) break;
              testPage++;
            }
            ctx.notify(`已完成 ${completed} 个筛选模型的测试。`); await ctx.refresh();
          } },
          { label: '导出当前筛选 CSV', toolbar: 'page', run: async ctx => {
            const all = []; let exportPage = 1;
            while (true) {
              const result = await api('/api/admin/models', { query: { page: exportPage, limit: 200, q: runtime.adminModelSearch || '', ...filters } });
              const pageItems = array(result.items || result); all.push(...pageItems);
              if (pageItems.length < 200 || all.length >= Number(result.total || pageItems.length)) break;
              exportPage++;
            }
            const columns = [['名称', 'name'], ['别名', 'alias'], ['模型 ID', 'id'], ['上游模型 ID', 'upstream_model_id'], ['供应商', 'provider_name'], ['系列', 'series'], ['输入价（元/千Token）', 'input_price_per_1k_tokens'], ['输出价（元/千Token）', 'output_price_per_1k_tokens'], ['缓存输出价（元/千Token）', 'cached_output_price_per_1k_tokens'], ['请求/分钟', 'rate_limit_rpm'], ['Token/分钟', 'rate_limit_tpm'], ['状态', 'enabled']];
            const csv = [columns.map(([label]) => label), ...all.map(item => columns.map(([, key]) => String(key === 'provider_name' ? item.provider_name || item.provider || '' : key === 'enabled' ? (item.enabled === false ? '停用' : '启用') : item[key] ?? '').replace(/"/g, '""')))].map(row => row.map(value => `"${value}"`).join(',')).join('\r\n');
            const destination = String(await ctx.ask('CSV 文件保存路径', { defaultValue: path.join(process.cwd(), 'models-export.csv'), description: '如果文件已存在，将覆盖该路径的文件。' }) || '').trim();
            if (!destination) return;
            if (!path.isAbsolute(destination)) { await ctx.show('导出失败', '请填写绝对路径，避免文件保存位置不明确。'); return; }
            const absolutePath = path.resolve(destination);
            if (await fs.access(absolutePath).then(() => true).catch(() => false)) {
              if (!await ctx.confirm('覆盖已有文件', `${absolutePath} 已存在，是否覆盖？`)) return;
            }
            await fs.writeFile(absolutePath, `﻿${csv}`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
            await fs.chmod(absolutePath, 0o600);
            ctx.notify(`已导出 ${all.length} 个模型：${absolutePath}`);
          } },
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
        const [libraryResult, keysResult, tagsResult, quotaResult] = await Promise.allSettled([
          api('/api/user/model-library'), api('/api/user/api-keys'), api('/api/user/provider-tags'), api('/api/user/providers/quota'),
        ]);
        const library = libraryResult.status === 'fulfilled' ? libraryResult.value : {};
        const showHidden = runtime.libraryShowHidden === true;
        const teams = array(library && library.teams);
        const stars = array(library && library.starred_models).filter(item => showHidden || item.is_hidden !== true);
        const tags = tagsResult.status === 'fulfilled' ? itemsOf(tagsResult.value) : [];
        const keys = keysResult.status === 'fulfilled' ? itemsOf(keysResult.value) : [];
        const quotaProviders = quotaResult.status === 'fulfilled' ? array(quotaResult.value?.providers) : [];
        const keyId = runtime.libraryKeyId || (keys[0] && keys[0].id);
        const assignedResult = keyId ? await Promise.allSettled([api(`/api/user/api-keys/${encodeURIComponent(keyId)}/models`)]) : [];
        const assignedData = assignedResult[0]?.status === 'fulfilled' ? assignedResult[0].value : {};
        const assignedIds = new Set(array(assignedData.queue).map(item => String(item.model_id || item.id)));
        const selectedProvider = runtime.libraryProvider || null;
        const canSaveLibraryOrder = !selectedProvider && !runtime.librarySearch && (!runtime.libraryTag || runtime.libraryTag === 'all') && (!runtime.librarySeries || runtime.librarySeries === 'all') && (!runtime.libraryTest || runtime.libraryTest === 'all') && (!runtime.librarySort || runtime.librarySort === 'default');
        let searchData = null;
        let searchedModels = [];
        if (selectedProvider) {
          searchData = await api(`/api/user/team/${encodeURIComponent(selectedProvider.team_id)}/provider/${encodeURIComponent(selectedProvider.provider_id)}/models`, { query: {
            page: runtime.libraryPage || 1, limit: 30, search: runtime.librarySearch || '', include_hidden: showHidden ? '1' : '',
            series: runtime.librarySeries || 'all', test: runtime.libraryTest || 'all', sort: runtime.librarySort || 'default',
          } });
          searchedModels = array(searchData.models || searchData.items);
        }
        const providerEntries = [];
        for (const team of teams) for (const provider of array(team.providers)) {
          if (provider.is_hidden && !showHidden) continue;
          const matchSearch = !runtime.librarySearch || [provider.provider_name, provider.provider_id, provider.provider_notes].some(value => String(value || '').toLowerCase().includes(runtime.librarySearch.toLowerCase()));
          const matchTag = !runtime.libraryTag || runtime.libraryTag === 'all' || array(provider.tags).some(tag => String(tag.id) === String(runtime.libraryTag));
          if (!matchSearch || !matchTag) continue;
          providerEntries.push({ team, provider });
        }
        const formatLatency = value => Number(value) >= 1000 ? `平均 ${(Number(value) / 1000).toFixed(1)} 秒` : Number(value) > 0 ? `平均 ${Math.round(Number(value))} 毫秒` : '';
        const providerCards = providerEntries.map(({ team, provider }) => ({
          label: provider.provider_name || provider.provider_id,
          value: `${provider.visible_model_count || 0}/${provider.model_count || 0}`,
          detail: display(team.team_name, `${provider.test_summary?.success || 0}/${provider.test_summary?.tested || 0} 项测试通过`, formatLatency(provider.test_summary?.avg_latency_ms), provider.is_hidden ? '已隐藏' : ''),
        }));
        const quotaRows = quotaProviders.map(provider => {
          const quota = provider.latest_valid_quota || provider.last_valid_quota || provider.latest_valid?.quota || provider.quota || {};
          const periods = array(quota.periods);
          const currentPercent = quota.currentPercent ?? periods.find(period => period.key === 'current_period')?.percent;
          const total = quota.total ?? provider.aggregated?.total;
          const remaining = quota.remaining ?? provider.aggregated?.remaining;
          const keys = array(provider.keys).filter(key => key && (key.ok || key.error || key.quota));
          const state = provider.error || ['failed', 'error'].includes(provider.status) ? (quota.total != null ? '最近查询失败，保留上次有效值' : '查询失败') : provider.status === 'stale' ? '额度数据已过期' : provider.status === 'partial' ? '部分 Key 查询成功' : '';
          const progress = percent => { const value = Math.max(0, Math.min(100, Number(percent) || 0)); const filled = Math.round(value / 100 * 20); return `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${Math.round(value)}%`; };
          const periodLabel = period => ({ current_period: '当前周期', five_hour: '5 小时窗口', seven_day: '7 天窗口', daily: '每日', weekly: '每周', monthly: '每月', primary: '主要额度窗口', secondary: '次要额度窗口' })[period] || String(period || '额度周期').replace(/_/g, ' ');
          const resetText = value => { if (!value) return ''; const timestamp = new Date(value).getTime(); if (!Number.isFinite(timestamp)) return `重置时间 ${value}`; const minutes = Math.max(0, Math.floor((timestamp - Date.now()) / 60000)); if (!minutes) return '即将重置'; const days = Math.floor(minutes / 1440); const hours = Math.floor(minutes % 1440 / 60); const remainder = minutes % 60; return days ? `${days} 天 ${hours} 小时后重置` : hours ? `${hours} 小时 ${remainder} 分钟后重置` : `${Math.max(1, remainder)} 分钟后重置`; };
          const detailLines = [
            quota.planName && `方案：${quota.planName}`,
            ...periods.map(period => `${periodLabel(period.key || period.label)}：${period.percent == null ? '使用率未知' : progress(period.percent)}${resetText(period.resetsAt) ? ` · ${resetText(period.resetsAt)}` : ''}`),
            !periods.length && (currentPercent != null ? `当前额度：${progress(currentPercent)}` : `剩余额度：${remaining ?? '未知'} / ${total ?? '未知'}`),
            quota.credits && `Credits：${quota.credits.unlimited ? '无限' : quota.credits.balance ?? '0'}${quota.rateLimitResetCredits?.available_count != null ? ` · 可手动重置 ${quota.rateLimitResetCredits.available_count} 次` : ''}`,
            ...keys.map((key, index) => { const keyQuota = key.quota || {}; const keyPercent = keyQuota.currentPercent ?? (Number(keyQuota.total) > 0 && keyQuota.used != null ? Number(keyQuota.used) / Number(keyQuota.total) * 100 : null); const keyState = !key.ok ? (key.quota ? '最近查询失败，显示上次有效值' : key.error || '查询失败') : ''; return `${key.label || key.masked_key || `Key ${index + 1}`}：${keyPercent == null ? keyQuota.total != null ? `剩余 ${keyQuota.remaining ?? '未知'} / ${keyQuota.total}` : '额度未知' : progress(keyPercent)}${keyState ? ` · ${keyState}` : ''}`; }),
            state,
            provider.last_valid_at && `最后有效观测：${formatTime(provider.last_valid_at)}`,
          ].filter(Boolean);
          const headline = periods.length ? `${periodLabel(periods.find(period => period.key === 'current_period')?.key || periods[0].key || periods[0].label)} · ${currentPercent == null ? '使用率未知' : `已用 ${Math.round(Number(currentPercent))}%`}` : total != null ? `剩余 ${remaining ?? '未知'} / ${total}` : '额度未知';
          return { label: provider.name || '未知供应商', detail: [quota.planName, headline, state, provider.last_valid_at && `最后有效观测 ${formatTime(provider.last_valid_at)}`].filter(Boolean).join(' · '), run: async ctx => await ctx.show(`供应商额度 · ${provider.name || '未知'}`, detailLines.join('\n')) };
        });
        const shortError = (value, max = 72) => { const normalized = String(value || '').replace(/\s+/g, ' ').trim(); return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized; };
        const modelRows = searchedModels.map(item => {
          const id = String(item.model_id || item.id);
          const testLabel = item.test_ok === true ? `测试通过 · ${item.test_latency_ms || 0} 毫秒` : item.test_ok === false ? `测试失败 · ${shortError(item.test_error)}` : '尚未测试';
          const name = item.alias || item.name || id;
          const assigned = assignedIds.has(id);
          const stateLabel = [item.test_ok === true ? `通过 ${item.test_latency_ms || 0}毫秒` : item.test_ok === false ? '测试失败' : '未测试', item.is_starred ? '已收藏' : '', item.is_hidden ? '已隐藏' : ''].filter(Boolean).join(' · ');
          return { label: name, cells: { name, series: item.series || '—', multiplier: modelMultiplierLabel(item.model_multiplier), test: stateLabel, description: shortError(item.description, 54) || '—', queue: assigned ? '已加入' : '未加入', actions: 'Enter 管理' }, detail: display(`上游模型 ID：${item.upstream_model_id || item.name || id}`, `供应商：${item.provider_name || item.provider || '—'}`, `输入 ${item.input_price_per_1k_tokens ?? '—'} 人民币/千Token`, `输出 ${item.output_price_per_1k_tokens ?? '—'} 人民币/千Token`, `测试吞吐：${item.test_tokens_per_second == null ? '未采集' : `${Number(item.test_tokens_per_second).toFixed(2)} Token/秒`}`, item.description, array(item.tags).map(tag => tag.name).join('、')), run: async ctx => {
            const choice = await ctx.choose(`模型 · ${name}`, [
              { label: '查看详情', value: 'detail' },
              { label: item.is_starred ? '取消星标' : '加入星标', value: 'star' },
              { label: item.is_hidden ? '显示模型' : '隐藏模型', value: 'hide' },
              { label: assignedIds.has(id) ? '从当前 Key 队列移除' : '加入当前 Key 队列', value: 'bind' },
            ], { description: `${item.team_name || `团队 ${item.team_id}`} · ${item.provider_name || item.provider}` });
            if (!choice) return;
            if (choice === 'detail') {
              const details = [
                `名称：${name}`, `内部模型编号：${item.model_id || item.id}`, `上游模型 ID：${item.upstream_model_id || item.name || id}`,
                `供应商：${item.provider_name || item.provider || '未知'}`, `模型系列：${item.series || '无'}`,
                `输入价格：${item.input_price_per_1k_tokens ?? '—'} 人民币/千Token`, `输出价格：${item.output_price_per_1k_tokens ?? '—'} 人民币/千Token`,
                `计费倍率：${modelMultiplierLabel(item.model_multiplier)}`, `Key 队列：${assignedIds.has(String(item.model_id || item.id)) ? '已加入当前 Key' : '未加入当前 Key'}${item.is_hidden ? ' · 已隐藏' : ''}`,
                `测试状态：${item.test_ok === true ? `通过 · 响应时间 ${item.test_latency_ms || 0} 毫秒` : item.test_ok === false ? '测试失败' : '尚未测试'}`,
                item.test_error && `测试失败原因：${shortError(item.test_error, 500)}`, item.description && `模型说明：${item.description}`,
              ].filter(Boolean).join('\n');
              await ctx.show(`模型详情 · ${name}`, details);
            }
            if (choice === 'star') {
              const starred = item.is_starred !== true;
              if (!await ctx.confirm(starred ? '星标模型' : '取消模型星标', `${item.team_name || `团队 ${item.team_id}`} · ${item.alias || item.name || id}`)) return;
              await api('/api/user/model-library/star', { method: 'PUT', body: { teamId: item.team_id, providerId: item.provider, modelId: id, starred } });
            }
            if (choice === 'hide') {
              const hidden = item.is_hidden !== true;
              if (!await ctx.confirm(hidden ? '隐藏模型' : '显示模型', `${item.team_name || `团队 ${item.team_id}`} · ${item.alias || item.name || id}`)) return;
              await api('/api/user/model-library/hidden', { method: 'PUT', body: { scope: 'model', teamId: item.team_id, providerId: item.provider, modelId: id, hidden } });
            }
            if (choice === 'bind') {
              if (!keyId) { await ctx.show('模型绑定', '请先创建 API Key。'); return; }
              const willBind = !assignedIds.has(id);
              const next = new Set(assignedIds); if (willBind) next.add(id); else next.delete(id);
              if (!await ctx.confirm(willBind ? '绑定模型' : '解绑模型', `${keys.find(key => String(key.id) === String(keyId))?.name || keyId}\n${item.alias || item.name || id}`)) return;
              await api(`/api/user/api-keys/${encodeURIComponent(keyId)}/models`, { method: 'PUT', body: { modelIds: [...next] } });
            }
            ctx.notify('模型库设置已更新。'); await ctx.refresh();
          } };
        });
        const hiddenItems = teams.flatMap(team => array(team.providers)).reduce((count, provider) => count + Number(provider.is_hidden === true) + Number(provider.hidden_model_count || 0), 0);
        const selectedKey = keys.find(key => String(key.id) === String(keyId));
        const harnessLabels = { claude_code: 'Claude Code', codex: 'Codex', grok: 'Grok', opencode: 'OpenCode', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw', deepseek_harness: 'DeepSeek Harness' };
        const bindingRows = [
          { label: `当前 Key：${selectedKey?.name || selectedKey?.key_prefix || (keyId ? `Key ${keyId}` : '未选择')}`, detail: `${selectedKey?.current_model_provider_name ? `供应商：${selectedKey.current_model_provider_name}` : '供应商：未选择'} · 当前模型：${selectedKey?.current_model_name || selectedKey?.current_model_id || '未选择'}` },
          { label: `默认模型队列：${array(assignedData.queue).length} 个`, detail: array(assignedData.queue).length ? array(assignedData.queue).map((item, index) => `${index + 1}. ${item.name || item.model_id || '未知模型'}`).join(' · ') : '未设置模型队列' },
          ...array(selectedKey?.harness_models).map(item => ({ label: `${harnessLabels[item.harness] || item.harness || '未知客户端'} 专属模型`, detail: `${item.name || item.model_id || '未指定'}${item.provider_name ? ` · ${item.provider_name}` : ''}` })),
          ...array(selectedKey?.request_model_bindings).map(item => ({ label: `请求名映射：${item.request_model_name || '未命名'}${item.harness ? ` · ${harnessLabels[item.harness] || item.harness}` : ''}`, detail: `${item.name || item.model_id || '未指定'}${item.provider_name ? ` · ${item.provider_name}` : ''}` })),
        ];
        const keySelectAction = { label: '选择 API Key', run: async ctx => { if (!keys.length) { await ctx.show('选择 API Key', '当前账户还没有 API Key。'); return; } const choice = await ctx.choose('选择 API Key', keys.map(key => ({ label: `${key.name || key.key_prefix || key.id} · ${key.current_model_name || key.current_model_id || '未绑定模型'} · 默认队列 ${array(key.model_queue).length} 个${array(key.harness_models).length ? ` · Harness 专属 ${array(key.harness_models).length} 个` : ''}`, value: key.id }))); if (choice !== null) { runtime.libraryKeyId = choice; await ctx.refresh(); } } };
        const quotaRefreshAction = { label: '刷新供应商额度', run: async ctx => { const result = await api('/api/user/providers/quota/refresh', { method: 'POST' }); ctx.notify(`已刷新 ${array(result.providers).length} 个供应商额度。`); await ctx.refresh(); } };
        const filterControls = [
          ...(providerEntries.length ? [{ label: '选择供应商展开模型', run: async ctx => { const choice = await ctx.choose('选择团队供应商', providerEntries.map(({ team, provider }, index) => ({ label: `${team.team_name} · ${provider.provider_name} · ${provider.visible_model_count || 0}/${provider.model_count || 0} 个模型`, value: index }))); if (choice === null) return; const entry = providerEntries[choice]; runtime.libraryProvider = { team_id: entry.team.team_id, provider_id: entry.provider.provider_id, provider_name: entry.provider.provider_name }; runtime.libraryPage = 1; await ctx.refresh(); } }] : []),
          { label: '搜索模型/供应商', toolbar: true, run: async ctx => { runtime.librarySearch = String(await ctx.ask('搜索模型、供应商或上游 ID', { defaultValue: runtime.librarySearch || '' }) || '').trim(); runtime.libraryPage = 1; await ctx.refresh(); } },
          { label: showHidden ? '隐藏已显示的项目' : '显示已隐藏的项目', toolbar: true, run: async ctx => { runtime.libraryShowHidden = !showHidden; runtime.libraryPage = 1; await ctx.refresh(); } },
          ...(showHidden && hiddenItems > 0 ? [{ label: '清除所有隐藏偏好', toolbar: true, run: async ctx => { if (!await ctx.confirm('恢复所有已隐藏项目', `清除 ${hiddenItems} 个供应商/模型的隐藏偏好？这会让全部项目重新显示，且不能撤销这次筛选状态。`)) return; await api('/api/user/model-library/hidden', { method: 'DELETE', query: { scope: 'all' } }); runtime.libraryShowHidden = false; runtime.libraryPage = 1; runtime.libraryProvider = null; ctx.notify('已恢复显示所有隐藏供应商和模型。'); await ctx.refresh(); } }] : []),
          ...(canSaveLibraryOrder ? [{ label: '排序模式：保存测试结果排序', toolbar: true, run: async ctx => { const sort = await ctx.choose('选择全库模型排序', [
            { label: '测试通过优先 · 响应时间由快到慢', value: 'test_latency_asc' }, { label: '测试通过优先 · 响应时间由慢到快', value: 'test_latency_desc' }, { label: '测试通过优先 · 输出速度由高到低', value: 'test_tps_desc' },
          ], { description: '与网页“排序模式”操作相同，将重写你当前账号的全部团队、供应商及模型自定义顺序。' }); if (!sort) return; if (!await ctx.confirm('确认保存全库排序', '此操作会重写所有团队、供应商和模型的自定义顺序，不会修改模型价格或状态。')) return; const result = await api('/api/user/model-library/order/by-test', { method: 'PUT', body: { sort } }); ctx.notify(`排序已保存：${result.teams || 0} 个团队、${result.providers || 0} 个供应商、${result.models || 0} 个模型。`); await ctx.refresh(); } }] : []),
          ...tags.map(tag => ({ label: `标签：${tag.name}`, run: async ctx => { runtime.libraryTag = String(tag.id); await ctx.refresh(); } })),
          { label: '清除标签筛选', run: async ctx => { runtime.libraryTag = 'all'; await ctx.refresh(); } },
        ];
        const sections = [
          { title: '当前 Key 绑定', rows: bindingRows, actions: [keySelectAction] },
          ...(quotaProviders.length ? [{ title: '供应商额度', description: '显示上次刷新（定时 / 手动）的结果。', rows: quotaRows, actions: [quotaRefreshAction] }] : quotaResult.status === 'rejected' ? [{ title: '供应商额度', rows: [{ label: `额度缓存暂不可用：${quotaResult.reason.message || '请求失败'}` }], actions: [quotaRefreshAction] }] : []),
          { title: '搜索与筛选', description: '按供应商、模型、Team、系列、标签和测试状态筛选。', toolbar: true, actions: filterControls, rows: [{ label: '按名称筛选供应商与模型；选择供应商后可继续查看并筛选其模型。' }] },
          ...(stars.length ? [{ title: '已收藏模型', rows: stars.slice(0, 20).map(item => ({ label: display(item.alias || item.name || item.model_id, item.provider_name, item.series), detail: display(item.is_hidden ? '已隐藏' : '可用', item.test_ok === true ? `测试通过 · 响应时间 ${item.test_latency_ms || 0} 毫秒` : item.test_ok === false ? `测试失败 · ${shortError(item.test_error)}` : '尚未测试'), run: async ctx => { const choice = await ctx.choose(`收藏模型 · ${item.alias || item.name || item.model_id}`, [{ label: '查看详情', value: 'detail' }, { label: '取消收藏', value: 'unstar' }]); if (choice === 'detail') { const starId = String(item.model_id || item.id); const details = [
              `模型名称：${item.alias || item.name || starId}`, `上游模型 ID：${item.upstream_model_id || item.name || starId}`,
              `供应商：${item.provider_name || item.provider || '未知'}`, `模型系列：${item.series || '无'}`,
              `状态：${item.is_hidden ? '已隐藏' : '可用'} · ${assignedIds.has(starId) ? '已加入当前 Key' : '未加入当前 Key'}`,
              `输入价格：${item.input_price_per_1k_tokens ?? '—'} 人民币/千Token`, `输出价格：${item.output_price_per_1k_tokens ?? '—'} 人民币/千Token`,
              `接口测试：${item.test_ok === true ? `通过 · 响应时间 ${item.test_latency_ms || 0} 毫秒` : item.test_ok === false ? '失败' : '尚未测试'}`,
              item.test_error && `测试失败原因：${shortError(item.test_error, 500)}`, item.description && `模型说明：${item.description}`,
            ].filter(Boolean).join('\n'); await ctx.show(`模型详情 · ${item.alias || item.name || item.model_id}`, details); } if (choice === 'unstar') { if (!await ctx.confirm('取消模型收藏', `${item.alias || item.name || item.model_id}\n${item.provider_name || ''}`)) return; await api('/api/user/model-library/star', { method: 'PUT', body: { teamId: item.team_id, providerId: item.provider, modelId: item.model_id, starred: false } }); ctx.notify('模型收藏已取消。'); await ctx.refresh(); } } })) }] : []),
          { title: '供应商', description: `${providerCards.length} 个供应商 · 选择“搜索与筛选”中的供应商可展开模型目录`, cards: providerCards, rows: providerCards.length ? [] : [{ label: libraryResult.status === 'rejected' ? libraryResult.reason.message : '暂无可用供应商。' }] },
          ...(selectedProvider ? [{ title: `${selectedProvider.provider_name} · 模型目录`, tableMinWidth: 150, columns: [
            { key: 'name', label: '模型名称', ratio: 0.2 }, { key: 'series', label: '系列', ratio: 0.1 }, { key: 'multiplier', label: '倍率', ratio: 0.1 },
            { key: 'test', label: '测试状态', ratio: 0.17 }, { key: 'description', label: '模型说明', ratio: 0.2 }, { key: 'queue', label: 'Key 队列', ratio: 0.1 }, { key: 'actions', label: '操作', ratio: 0.13 },
          ], description: `第 ${searchData.pagination?.page || runtime.libraryPage || 1}/${searchData.pagination?.total_pages || 1} 页 · 共 ${searchData.pagination?.total ?? searchData.total ?? searchedModels.length} 个模型`, rows: modelRows.length ? modelRows : [{ label: '没有符合筛选条件的模型。' }] }] : []),
          ...(libraryResult.status === 'rejected' ? [{ title: '加载失败', rows: [{ label: libraryResult.reason.message || '模型目录不可用' }] }] : []),
        ];
        return { sections, actions: [
          ...(selectedProvider ? [
            { label: '筛选模型系列', run: async ctx => { const value = await ctx.choose('模型系列', [{ label: '全部', value: 'all' }, ...array(library.available_series).map(series => ({ label: series, value: series }))]); if (value !== null) { runtime.librarySeries = value; runtime.libraryPage = 1; await ctx.refresh(); } } },
            { label: '筛选测试状态', run: async ctx => { const value = await ctx.choose('测试状态', [{ label: '全部', value: 'all' }, { label: '通过', value: 'pass' }, { label: '失败', value: 'fail' }, { label: '未测试', value: 'untested' }]); if (value !== null) { runtime.libraryTest = value; runtime.libraryPage = 1; await ctx.refresh(); } } },
            { label: '排序模型结果', run: async ctx => { const value = await ctx.choose('模型排序', [{ label: '默认', value: 'default' }, { label: '价格升序', value: 'price_asc' }, { label: '价格降序', value: 'price_desc' }, { label: '名称升序', value: 'name_asc' }, { label: '名称降序', value: 'name_desc' }, { label: '测试延迟升序', value: 'test_latency_asc' }, { label: '测试延迟降序', value: 'test_latency_desc' }, { label: '测试速度降序', value: 'test_tps_desc' }]); if (value !== null) { runtime.librarySort = value; runtime.libraryPage = 1; await ctx.refresh(); } } },
            { label: '搜索结果上一页', disabled: searchData?.pagination ? !searchData.pagination.has_prev : (runtime.libraryPage || 1) <= 1, run: async ctx => { runtime.libraryPage = Math.max(1, (runtime.libraryPage || 1) - 1); await ctx.refresh(); } },
            { label: '搜索结果下一页', disabled: searchData?.pagination ? !searchData.pagination.has_next : searchedModels.length < 30, run: async ctx => { runtime.libraryPage = (runtime.libraryPage || 1) + 1; await ctx.refresh(); } },
            { label: '返回团队供应商', run: async ctx => { runtime.libraryProvider = null; await ctx.refresh(); } },
          ] : []),
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    adminOnly(collectionPage({ id: 'admin-model-library', label: '模型库管理', description: '管理员模型库视图。', path: '/api/admin/model-library', pick: itemsOf,
      map: { label: item => display(item.name, item.id, item.provider_name), detail: item => display(item.series, item.enabled === false ? '停用' : '启用', item.description) } })),
    adminOnly({
      id: 'admin-teams', label: '团队管理', description: '管理团队、成员与请求限额规则。',
      async load(api) {
        const teams = itemsOf(await api('/api/admin/teams'));
        const search = String(runtime.adminTeamSearch || '').trim().toLowerCase();
        const filteredTeams = teams.filter(team => !search || [team.name, team.description].some(value => String(value || '').toLowerCase().includes(search)));
        const selectedTeamId = runtime.adminSelectedTeamId;
        if (selectedTeamId == null) {
          const defaultCount = teams.filter(team => team.is_default === true).length;
          const frontierCount = teams.filter(team => team.is_frontier === true).length;
          const totalMembers = teams.reduce((sum, team) => sum + Number(team.member_count || 0), 0);
          const listRows = filteredTeams.map(team => ({
            label: team.name || `Team ${team.id}`,
            detail: [team.is_default && '默认', team.is_frontier && '前沿', team.is_personal && '个人', `${Number(team.member_count || 0)} 位成员`, team.description || '暂无描述', `创建于 ${team.created_at ? formatTime(team.created_at) : '时间未知'}`].filter(Boolean).join(' · '),
            run: async ctx => { runtime.adminSelectedTeamId = team.id; await ctx.refresh(); },
          }));
          return { sections: [{ title: 'Team 管理', cards: [
            { label: '团队总数', value: teams.length }, { label: '默认团队', value: defaultCount }, { label: '前沿团队', value: frontierCount }, { label: '总成员数', value: totalMembers },
          ], description: `${search ? `搜索“${runtime.adminTeamSearch}” · 显示 ${filteredTeams.length}/${teams.length}` : `共 ${teams.length} 个 Team`} · 选择 Team 查看成员、模型授权和限额规则`, rows: listRows.length ? listRows : [{ label: teams.length ? '未找到匹配的 Team。' : '暂无 Team，使用“创建团队”开始。' }] }], actions: [
            { label: search ? '清除 Team 搜索' : '搜索 Team', toolbar: true, run: async ctx => { runtime.adminTeamSearch = search ? '' : String(await ctx.ask('搜索 Team 名称或描述', { defaultValue: runtime.adminTeamSearch || '' }) || '').trim(); await ctx.refresh(); } },
            { label: '创建团队', toolbar: true, run: async ctx => { const values = await ctx.form('创建团队', [{ name: 'name', label: 'Team 名称' }, { name: 'description', label: '描述（可选）' }]); if (!values || !String(values.name || '').trim()) return; if (!await ctx.confirm('创建 Team', `${values.name.trim()}${values.description ? `\\n${values.description}` : ''}`)) return; await api('/api/admin/teams', { method: 'POST', body: { name: values.name.trim(), description: String(values.description || '').trim() } }); ctx.notify('Team 已创建。'); await ctx.refresh(); } },
            { label: '刷新', run: ctx => ctx.refresh() },
          ] };
        }
        const team = teams.find(item => String(item.id) === String(selectedTeamId));
        if (!team) { runtime.adminSelectedTeamId = null; await ctx.refresh(); return; }
        const sections = await Promise.all([team].map(async team => {
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
          const memberSearch = String(runtime[`team_${team.id}_memberSearch`] || '').trim().toLowerCase();
          const visibleMembers = memberItems.filter(member => !memberSearch || [member.username, member.email].some(value => String(value || '').toLowerCase().includes(memberSearch)));
          const memberRows = visibleMembers.map(member => ({ label: member.username || `用户 ${member.id}`, detail: display(member.email, member.created_at && formatTime(member.created_at)), run: async ctx => {
            if (!await ctx.confirm('移除团队成员', `将 ${member.username} 从 ${team.name} 移出？`)) return;
            await api(`/api/admin/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
            ctx.notify('成员已移出团队。'); await ctx.refresh();
          } }));
          const modelRows = visibleModels.map(model => ({ label: `${model.name || model.model_id} · ${model.enabled ? '已启用' : '未授权'}`, detail: display(model.provider_name || model.provider, model.series, model.test_ok === true ? `测试通过 ${model.test_latency_ms || 0} 毫秒` : model.test_error || ''), run: async ctx => { const enabled = model.enabled !== true; const impact = enabled ? '授权此模型给团队成员使用。' : '如果没有其他团队继续向该成员提供此模型，服务端可能清除相关 Key 的当前模型绑定。'; if (!await ctx.confirm(enabled ? '启用团队模型' : '停用团队模型', `${team.name}\n${model.name || model.model_id}\n${impact}`)) return; const result = await api(`/api/admin/teams/${encodeURIComponent(team.id)}/models/${encodeURIComponent(model.model_id)}`, { method: 'PUT', body: { enabled } }); if (!enabled && result.cleared_keys) ctx.notify(`已禁用；清除了 ${result.cleared_keys} 个 API Key 的当前模型绑定。`); else ctx.notify(`团队模型已${enabled ? '启用' : '禁用'}。`); await ctx.refresh(); } }));
          const ruleRows = ruleItems.map(rule => ({ label: `${rule.rule_type} ${rule.rule_value} / ${rule.duration_hours} 小时`, detail: rule.description || rule.id, run: async ctx => { if (!await ctx.confirm('删除限额规则', `${team.name} · ${rule.rule_type} ${rule.rule_value}`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' }); await ctx.refresh(); } }));
          return {
            title: `${team.name} · 团队编号 ${team.id}`,
            description: display(team.is_default && '默认团队', team.is_frontier && '前沿团队', team.is_personal && '个人 Team', `${team.member_count ?? memberItems.length} 位成员`, team.description || '暂无描述'),
            cards: [{ label: '成员', value: team.member_count ?? memberItems.length }, { label: '模型授权', value: modelItems.filter(model => model.enabled).length }, { label: '限额规则', value: ruleItems.length }],
            rows: [
              { label: `成员管理 · 显示 ${memberRows.length}/${memberItems.length} 人`, detail: memberRows.length ? '选择成员可移除；添加成员请使用页面操作。' : memberItems.length ? '没有匹配的成员。' : '暂无成员。' },
              ...memberRows.map(row => ({ ...row, label: `成员 · ${row.label}` })),
              { label: `模型授权 · ${modelRows.length} 个模型`, detail: '单模型启停；禁用可能清除无其他团队授权的Key当前模型绑定' },
              ...modelRows.map(row => ({ ...row, label: `模型 · ${row.label}` })),
              { label: `限额规则 · ${ruleRows.length} 条` },
              ...ruleRows.map(row => ({ ...row, label: `限额 · ${row.label}` })),
            ],
            actions: [
              { label: '返回 Team 列表', toolbar: true, run: async ctx => { runtime.adminSelectedTeamId = null; await ctx.refresh(); } },
              { label: memberSearch ? '清除成员搜索' : '搜索 Team 成员', run: async ctx => { runtime[`team_${team.id}_memberSearch`] = memberSearch ? '' : String(await ctx.ask('搜索成员用户名或邮箱', { defaultValue: runtime[`team_${team.id}_memberSearch`] || '' }) || '').trim(); await ctx.refresh(); } },
              { label: `搜索 ${team.name} 模型`, run: async ctx => { runtime[`team_${team.id}_modelSearch`] = String(await ctx.ask('模型名称、ID 或供应商') || '').trim(); await ctx.refresh(); } },
              { label: `编辑 ${team.name}`, run: async ctx => { const values = await ctx.form('编辑团队', [{ name: 'name', label: '名称', value: team.name }, { name: 'description', label: '说明', value: team.description || '' }, { name: 'is_default', label: '默认团队', type: 'boolean', value: team.is_default === true }, { name: 'is_frontier', label: '前沿团队', type: 'boolean', value: team.is_frontier === true }]); if (!values) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}`, { method: 'PUT', body: values }); ctx.notify('团队已更新。'); await ctx.refresh(); } },
              { label: `添加成员到团队 ${team.name}`, run: async ctx => { const input = await ctx.ask('用户 ID（多个以逗号分隔）'); if (!input) return; const userIds = String(input).split(',').map(value => Number(value.trim())).filter(Number.isInteger); if (!userIds.length || !await ctx.confirm('添加团队成员', `团队：${team.name}\n用户编号：${userIds.join(', ')}`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}/members`, { method: 'POST', body: { userIds } }); ctx.notify('成员已添加。'); await ctx.refresh(); } },
              { label: `新增 ${team.name} 限额规则`, run: async ctx => { const values = await ctx.form('新增团队限额规则', [{ name: 'rule_type', label: '类型', value: 'requests', options: ['requests', 'tokens'] }, { name: 'rule_value', label: '限额值' }, { name: 'duration_hours', label: '时间窗口小时数', value: '24' }, { name: 'description', label: '说明' }]); if (!values) return; if (!await ctx.confirm('添加团队限额', `${team.name}\n${values.rule_type} ${values.rule_value} / ${values.duration_hours} 小时`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}/rules`, { method: 'POST', body: { ...values, rule_value: Number(values.rule_value), duration_hours: Number(values.duration_hours) } }); await ctx.refresh(); } },
              { label: `删除 ${team.name}`, run: async ctx => { if (!await ctx.confirm('删除团队', `删除「${team.name}」？若仍有关联成员，服务端会拒绝。`)) return; await api(`/api/admin/teams/${encodeURIComponent(team.id)}`, { method: 'DELETE' }); ctx.notify('团队已删除。'); await ctx.refresh(); } },
            ],
          };
        }));
        return { sections: sections.length ? sections : [{ title: '团队管理', rows: [{ label: '暂无团队。' }] }], actions: [
          { label: '创建团队', run: async ctx => { const values = await ctx.form('创建团队', [{ name: 'name', label: '名称' }, { name: 'description', label: '说明' }]); if (!values || !String(values.name || '').trim()) return; if (!await ctx.confirm('创建团队', values.name)) return; await api('/api/admin/teams', { method: 'POST', body: values }); ctx.notify('团队已创建。'); await ctx.refresh(); } },
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
      id: 'admin-stats', label: '统计信息', description: '管理员全局请求、成本与模型分析。',
      onTabChange(tab) { runtime.adminStatsTab = tab?.id || 'overview'; },
      loadOnTabChange: true,
      tabs: [
        { id: 'overview', label: '总览' }, { id: 'latency', label: '延迟与吞吐' }, { id: 'multi', label: '多维分析' },
        { id: 'daily', label: '每日统计' }, { id: 'models', label: '模型分析' }, { id: 'providers', label: '供应商分析' },
        { id: 'clients', label: '客户端' }, { id: 'members', label: '成员 / Team' }, { id: 'messages', label: '消息分析' }, { id: 'logs', label: '调用记录' },
      ],
      async load(api) {
        const days = runtime.adminStatsDays || 30;
        const data = await api('/api/admin/stats', { query: { days, ...(runtime.adminStatsFilters || {}) } });
        const daily = array(data && data.daily);
        const totalRequests = daily.reduce((sum, item) => sum + Number(item.requests || 0), 0);
        const totalTokens = daily.reduce((sum, item) => sum + Number(item.tokens || 0), 0);
        const totalCost = daily.reduce((sum, item) => sum + Number(item.cost || 0), 0);
        const dayCount = daily.length || 1;
        const activeModels = array(data && data.byModel).length;
        const activeProviders = array(data && data.byProvider).length;
        const summaryCards = [
          { label: '总请求数', value: totalRequests.toLocaleString(), detail: `日均 ${Math.round(totalRequests / dayCount).toLocaleString()} 次` },
          { label: '总 Token 消耗', value: formatBigNumber(totalTokens), detail: `日均 ${formatBigNumber(Math.round(totalTokens / dayCount))} Token` },
          { label: '总积分消耗', value: `${totalCost.toFixed(2)} 积分`, detail: `日均 ${ (totalCost / dayCount).toFixed(2)} 积分` },
          { label: '活跃模型', value: activeModels.toLocaleString(), detail: `供应商 ${activeProviders}` },
        ];
        const nameColumns = [
          { key: 'name', label: '名称', ratio: 0.34 }, { key: 'requests', label: '请求数', ratio: 0.16 },
          { key: 'tokens', label: 'Token 用量', ratio: 0.18 }, { key: 'cost', label: '费用（积分）', ratio: 0.16 }, { key: 'latency', label: '平均响应时间', ratio: 0.16 },
        ];
        const byRows = (items, name) => array(items).slice(0, 50).map(item => {
          const title = name(item);
          return { label: title, cells: {
            name: title, requests: `${Number(item.requests || 0).toLocaleString()} 次`, tokens: `${formatBigNumber(item.tokens)} Token`,
            cost: `${formatCost(item.cost)} 积分`, latency: item.avg_latency ? `${Math.round(item.avg_latency)} 毫秒` : '—',
          }, detail: item.cached_tokens ? `缓存命中 ${formatBigNumber(item.cached_tokens)} Token` : '' };
        });
        const tab = runtime.adminStatsTab || 'overview';
        const logPage = runtime.adminStatsLogPage || 1;
        let logTotal = 0;
        const sections = [];
        if (tab === 'overview') sections.push({ title: '统计概览', toolbar: true, cards: summaryCards, rows: [{ label: '切换上方页签查看每日、模型、供应商、客户端、用户、团队及响应速度明细。' }] });
        if (tab === 'daily') sections.push({ title: '每日用量', toolbar: true, tableMinWidth: 118, columns: [
          { key: 'date', label: '日期', ratio: 0.18 }, { key: 'requests', label: '请求数', ratio: 0.14 }, { key: 'input', label: '输入 Token', ratio: 0.16 },
          { key: 'output', label: '输出 Token', ratio: 0.16 }, { key: 'tokens', label: '总 Token', ratio: 0.17 }, { key: 'cost', label: '费用（积分）', ratio: 0.19 },
        ], rows: daily.slice(-30).map(item => ({ label: item.date || '未知日期', cells: {
          date: item.date || '未知日期', requests: `${Number(item.requests || 0).toLocaleString()} 次`, input: `${formatBigNumber(item.prompt_tokens)} Token`,
          output: `${formatBigNumber(item.completion_tokens)} Token`, tokens: `${formatBigNumber(item.tokens)} Token`, cost: `${formatCost(item.cost)} 积分`,
        } })) });
        if (tab === 'models') sections.push({ title: '按模型', toolbar: true, tableMinWidth: 118, columns: nameColumns, rows: byRows(data.byModel, item => item.model_name || item.model_id || '未知模型') });
        if (tab === 'providers') sections.push({ title: '按供应商', toolbar: true, tableMinWidth: 118, columns: nameColumns, rows: byRows(data.byProvider, item => item.provider_name || item.provider_id || '未知供应商') });
        if (tab === 'clients') sections.push({ title: '按客户端来源', toolbar: true, tableMinWidth: 118, columns: nameColumns, rows: byRows(data.bySource, item => item.request_source || '未知来源') });
        if (tab === 'users') sections.push({ title: '按用户', toolbar: true, tableMinWidth: 118, columns: nameColumns, rows: byRows(data.byUser, item => item.user_name || item.username || `用户 ${item.user_id}`) });
        if (tab === 'teams' || tab === 'members') sections.push({ title: '按成员与 Team', toolbar: true, tableMinWidth: 118, columns: [
          { key: 'name', label: '成员', ratio: 0.27 }, { key: 'team', label: 'Team', ratio: 0.2 }, { key: 'requests', label: '请求数', ratio: 0.16 },
          { key: 'tokens', label: 'Token 用量', ratio: 0.17 }, { key: 'cost', label: '费用（积分）', ratio: 0.2 },
        ], rows: [...array(data.byUser).slice(0, 50).map(item => ({ label: item.username || item.user_name || `用户 ${item.user_id}`, cells: { name: item.username || item.user_name || `用户 ${item.user_id}`, team: item.team_name || '未分配 Team', requests: `${Number(item.requests || 0).toLocaleString()} 次`, tokens: `${formatBigNumber(item.tokens)} Token`, cost: `${formatCost(item.cost)} 积分` } })), ...array(data.byTeam).slice(0, 50).map(item => ({ label: `Team · ${item.team_name || item.team_id}`, cells: { name: '—', team: item.team_name || `Team ${item.team_id}`, requests: `${Number(item.requests || 0).toLocaleString()} 次`, tokens: `${formatBigNumber(item.tokens)} Token`, cost: `${formatCost(item.cost)} 积分` } }))] });
        if (tab === 'multi') {
          const quotaQuery = runtime.adminStatsQuotaQuery || null;
          const multi = await api('/api/admin/stats/multi', { query: quotaQuery ? { days, ...quotaQuery, data_source: 'quota' } : { days, data_source: 'association', ...(runtime.adminStatsMultiFilters || {}) } });
          const relations = multi.relationships || {};
          const summary = multi.summary || {};
          const quotaMode = multi.data_source === 'quota' || Boolean(quotaQuery);
          const multiDimensionQuery = runtime.adminStatsDimensionQuery || null;
          let multiDimensionResult = null;
          let multiDimensionError = '';
          if (multiDimensionQuery) {
            try { multiDimensionResult = await api('/api/admin/stats/multi-dimension', { query: multiDimensionQuery }); }
            catch (error) { multiDimensionError = error.message || '当前实例暂不支持此维度分析'; }
          }
          const relationRows = ['user_project', 'user_model', 'team_model', 'project_source', 'model_provider'].flatMap(key => array(relations[key]).slice(0, 20).map(item => ({
            label: `${key.replace(/_/g, ' → ')} · ${item.left || '未知'} → ${item.right || '未知'}`,
            detail: `${Number(item.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(item.tokens)} Token · ${formatCost(item.cost)} 积分`,
          })));
          if (quotaMode) {
            const quotaRows = array(multi.rows).map(row => {
              const amount = row.value == null ? '未知' : `${Number(row.value).toLocaleString('zh-CN', { maximumFractionDigits: 6 })}${row.unit && row.unit !== 'unknown' ? ` ${row.unit}` : ''}`;
              const dimensionLabel = array(row.labels).filter(Boolean).join(' · ') || '未分类';
              const dimensionKeys = Array.isArray(multi.dimensions) ? multi.dimensions : String(quotaQuery?.dimensions || 'provider').split(',');
              const dimensionValue = key => { const index = dimensionKeys.indexOf(key); return index >= 0 ? row.values?.[index] : undefined; };
              const snapshot = array(multi.provider_quota?.accounts).find(account =>
                (dimensionValue('provider') === undefined || String(dimensionValue('provider')) === String(account.provider_id)) &&
                (dimensionValue('account') === undefined || String(dimensionValue('account')) === String(account.account_id)) &&
                (dimensionValue('kind') === undefined || String(dimensionValue('kind')) === String(account.kind)) &&
                (dimensionValue('unit') === undefined || String(dimensionValue('unit')) === String(account.unit)) &&
                (dimensionValue('window') === undefined || String(dimensionValue('window')) === String(account.window_key))
              );
              const kindLabel = row.kind === 'balance' ? '余额额度' : row.kind === 'window' ? '周期额度' : row.kind === 'status' ? '状态额度' : row.kind || '额度';
              const referenceTotal = row.total ?? snapshot?.total;
              const referenceUsed = row.used ?? snapshot?.used;
              const referenceRemaining = row.remaining ?? snapshot?.remaining;
              const percent = row.kind === 'window' || row.unit === 'percent' ? Number(row.value) : Number(referenceTotal) > 0 && referenceUsed != null ? Number(referenceUsed) / Number(referenceTotal) * 100 : null;
              const bar = Number.isFinite(percent) ? `使用率 ${Math.max(0, Math.min(100, percent)).toFixed(1)}% [${'█'.repeat(Math.round(Math.max(0, Math.min(100, percent)) / 10))}${'░'.repeat(10 - Math.round(Math.max(0, Math.min(100, percent)) / 10))}]` : '';
              const reference = referenceTotal != null || referenceUsed != null || referenceRemaining != null ? `已用 ${referenceUsed == null ? '未知' : Number(referenceUsed).toLocaleString('zh-CN', { maximumFractionDigits: 4 })} / 总额 ${referenceTotal == null ? '未知' : Number(referenceTotal).toLocaleString('zh-CN', { maximumFractionDigits: 4 })} / 剩余 ${referenceRemaining == null ? '未知' : Number(referenceRemaining).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}${row.unit && row.unit !== 'unknown' ? ` ${row.unit}` : snapshot?.unit ? ` ${snapshot.unit}` : ''}` : '';
              return { label: `${dimensionLabel} · ${kindLabel}${row.window_key ? ` · ${row.window_key}` : ''}`, detail: [
                `指标：${amount}`, reference, bar, row.status && `查询状态：${row.status}`, row.observed_at && `观测时间：${formatTime(row.observed_at)}`,
                row.quality?.cached && '使用缓存快照', row.quality?.legacy && '旧格式数据', row.quality?.precision && `精度：${row.quality.precision}`,
                row.account_ids?.length > 1 && `${row.account_ids.length} 个账户`, row.coverage?.start && row.coverage?.end && `覆盖：${row.coverage.start} 至 ${row.coverage.end}`,
              ].filter(Boolean).join(' · ') };
            });
            const coverage = multi.coverage || multi.provider_quota?.coverage || {};
            const caveats = array(coverage.caveats);
            const quotaSnapshots = array(multi.provider_quota?.accounts).filter(account => account.kind !== 'status');
            const snapshotRows = quotaSnapshots.map(account => {
              const windowQuota = account.kind === 'window' || account.unit === 'percent';
              const percent = windowQuota ? Number(account.used_percent) : Number(account.total) > 0 && account.used != null ? Number(account.used) / Number(account.total) * 100 : null;
              const clamped = percent == null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent));
              const bar = clamped == null ? '使用率未知' : `使用率 ${clamped.toFixed(1)}% [${'█'.repeat(Math.round(clamped / 10))}${'░'.repeat(10 - Math.round(clamped / 10))}]`;
              return { label: `${account.provider_name || account.provider_id || '未知供应商'} · ${account.label || `账户 ${account.account_id}`} · ${windowQuota ? '周期额度' : '余额额度'}${account.window_key ? ` · ${account.window_key}` : ''}`, detail: [
                `${windowQuota ? '周期使用率' : '额度余额'}：${account.remaining == null ? '未知' : Number(account.remaining).toLocaleString('zh-CN', { maximumFractionDigits: 6 })} / ${account.total == null ? '未知' : Number(account.total).toLocaleString('zh-CN', { maximumFractionDigits: 6 })}${account.unit && account.unit !== 'unknown' ? ` ${account.unit}` : ''}`,
                windowQuota && account.used_percent != null && `已用百分比：${Number(account.used_percent).toFixed(1)}%`, bar,
                `查询状态：${account.status || '未知'}`, account.observed_at && `最后观测：${formatTime(account.observed_at)}`,
                account.quality?.cached && '使用缓存快照', account.quality?.precision && `精度：${account.quality.precision}`,
              ].filter(Boolean).join(' · ') };
            });
            sections.push({ title: '供应商额度多维分析', cards: [
              { label: '供应商账户数', value: Number(multi.provider_quota?.summary?.accounts || 0) },
              { label: '数据覆盖', value: coverage.start && coverage.end ? `${coverage.start} 至 ${coverage.end}` : '未知' },
              { label: '历史采样', value: `${Number(coverage.samples || 0)} 条` },
            ], rows: [
              { label: `额度维度：${multi.dimensions || quotaQuery?.dimensions || 'provider'} · 指标：${multi.metric || quotaQuery?.metric || 'remaining'}` },
              ...quotaRows,
              { label: `账户额度参照：${snapshotRows.length} 个可用额度账户` },
              ...snapshotRows,
              ...caveats.map(caveat => ({ label: `统计说明：${caveat}` })),
              ...(multiDimensionResult ? array(multiDimensionResult.rows).map(row => ({ label: array(row.labels).join(' · ') || '未分类', detail: `${row.value ?? '未知'}${row.unit ? ` ${row.unit}` : ''} · ${row.status || '未知状态'}` })) : []),
              ...(!quotaRows.length ? [{ label: '当前条件下暂无额度观测数据。' }] : []),
            ] });
          } else {
            sections.push({ title: '多维关联分析', cards: [
              { label: '总请求', value: Number(summary.requests || 0).toLocaleString() }, { label: '总 Token', value: `${formatBigNumber(summary.tokens)} Token` },
              { label: '总积分', value: `${formatCost(summary.cost)} 积分` }, { label: '活跃成员', value: summary.active_users || 0 },
              { label: '活跃项目', value: summary.active_projects || 0 }, { label: '模型 / 供应商', value: `${summary.active_models || 0} / ${summary.active_providers || 0}` },
            ], rows: [
              { label: multiDimensionQuery ? `自选维度：${multiDimensionQuery.dimensions} · 指标：${multiDimensionQuery.metric} · 数据源：${multiDimensionQuery.data_source}` : '可另选统计维度、指标与数据源，查看自定义组合。' },
              ...(multiDimensionError ? [{ label: `自选维度分析不可用：${multiDimensionError}` }] : multiDimensionResult ? [
                ...(() => {
                  const resultRows = array(multiDimensionResult.rows).slice(0, 30);
                  const metricValue = row => multiDimensionQuery.metric === 'requests' ? Number(row.requests || 0) : multiDimensionQuery.metric === 'tokens' ? Number(row.tokens || 0) : Number(row.cost || 0);
                  const maxValue = Math.max(0, ...resultRows.map(metricValue));
                  return resultRows.map(row => {
                    const value = metricValue(row);
                    const bar = maxValue > 0 ? `[${'█'.repeat(Math.round(value / maxValue * 16))}${'░'.repeat(16 - Math.round(value / maxValue * 16))}]` : '[░░░░░░░░░░░░░░░░]';
                    const amount = multiDimensionQuery.metric === 'requests' ? `${value.toLocaleString()} 次请求` : multiDimensionQuery.metric === 'tokens' ? `${formatBigNumber(value)} Token` : `${formatCost(value)} 积分`;
                    return { label: `${array(row.labels).join(' · ') || '未分类'} · ${amount}`, detail: `${bar} · ${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)} 积分` };
                  });
                })(),
                ...(multiDimensionResult.quota_mode === 'member_estimate' ? [
                  { label: `成员额度估算：${array(multiDimensionResult.quota_estimates).length} 条 · 按同一供应商下的 ${multiDimensionQuery.metric} 占比估算，不是实际个人账单。` },
                  ...array(multiDimensionResult.quota_estimates).slice(0, 50).map(estimate => {
                    const pct = Math.max(0, Math.min(100, Number(estimate.estimated_percent || 0)));
                    const bar = `[${'█'.repeat(Math.round(pct / 10))}${'░'.repeat(10 - Math.round(pct / 10))}]`;
                    return {
                      label: `${array(estimate.category_labels).join(' · ') || estimate.user_name || '未知成员'} · ${estimate.provider_name || '未知供应商'} · ${estimate.kind === 'window' ? '周期额度' : '余额额度'}${estimate.window_key ? ` · ${estimate.window_key}` : ''}`,
                      detail: `估算使用 ${Number(estimate.estimated_value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 })} ${estimate.unit || '未知单位'} · ${pct.toFixed(1)}% ${bar} · 实际额度仅为供应商级参照`,
                    };
                  }),
                  ...(multiDimensionResult.quota_estimate_caveat ? [{ label: `估算范围说明：${multiDimensionResult.quota_estimate_caveat}` }] : []),
                ] : []),
              ] : relationRows.length ? relationRows : [{ label: '当前筛选范围内暂无关联数据。' }]),
              ...array(multi.caveats).map(caveat => ({ label: `统计说明：${caveat}` })),
            ] });
          }
        }
        if (tab === 'messages') {
          const messageStats = await api('/api/admin/message-stats', { query: { days } });
          const summary = messageStats.summary || {};
          const messageCards = [
            ['requests', '请求数', ' 次'], ['analyzed_requests', '已分析请求数', ' 次'], ['total_messages', '消息总数', ' 条'],
            ['total_characters', '字符总数', ' 字符'], ['total_lines', '行数总计', ' 行'], ['total_tokens', 'Token 总量', ' Token'],
            ['total_cost', '费用', ' 积分'], ['active_days', '活跃天数', ' 天'], ['metadata_rate', '元数据覆盖率', '%'],
            ['workspace_rate', '工作区信息覆盖率', '%'], ['git_rate', 'Git 状态覆盖率', '%'],
          ].filter(([key]) => summary[key] != null).map(([key, label, suffix]) => ({ label, value: key.endsWith('_rate') ? `${(Number(summary[key]) * 100).toFixed(1)}%` : `${key === 'total_tokens' || key === 'total_characters' ? formatBigNumber(summary[key]) : Number(summary[key]).toLocaleString()}${suffix}` }));
          const messageRows = array(messageStats.by_block).map(item => ({ label: `区块：${String(item.block || '未知').replace(/_/g, ' ')}`, detail: `${Number(item.requests || 0).toLocaleString()} 次请求 · 出现 ${Number(item.occurrences || 0).toLocaleString()} 次 · ${formatBigNumber(item.tokens)} Token · ${formatCost(item.cost)} 积分` }));
          messageRows.push(...array(messageStats.by_source).map(item => ({ label: `客户端：${item.request_source || '未知'}`, detail: `${Number(item.requests || 0).toLocaleString()} 次请求 · ${Number(item.messages || 0).toLocaleString()} 条消息 · ${formatBigNumber(item.tokens)} Token` })));
          sections.push({ title: '消息分析', cards: messageCards, rows: messageRows.length ? messageRows : [{ label: '当前时间范围没有已分析的消息。' }] });
        }
        if (tab === 'logs') {
          const filters = runtime.adminStatsLogFilters || {};
          const logs = await api('/api/admin/usage-logs', { query: { page: logPage, limit: 30, ...filters } });
          logTotal = Number(logs.total || 0);
          const logItems = array(logs.logs);
          const logColumns = [
            { key: 'time', label: '时间', ratio: 0.16 }, { key: 'user', label: '用户', ratio: 0.1 }, { key: 'model', label: '模型', ratio: 0.16 },
            { key: 'provider', label: '供应商', ratio: 0.12 }, { key: 'source', label: '客户端', ratio: 0.11 }, { key: 'tokens', label: 'Token', ratio: 0.12 },
            { key: 'cost', label: '积分', ratio: 0.1 }, { key: 'latency', label: '延迟', ratio: 0.08 }, { key: 'detail', label: '详情', ratio: 0.05 },
          ];
          sections.push({ title: '管理员调用记录', tableMinWidth: 135, columns: logColumns, description: `第 ${logs.page || logPage} 页 · 共 ${logs.total || 0} 条`, rows: logItems.length ? logItems.map(item => ({ label: formatTime(item.created_at), cells: {
            time: formatTime(item.created_at), user: item.username || `用户 ${item.user_id}`, model: item.model_name || item.model_id || '未知模型', provider: item.provider_name || '未知', source: item.request_source || '未知',
            tokens: `${formatBigNumber(item.tokens_used)} Token`, cost: `${formatCost(item.cost)} 积分`, latency: item.latency_ms == null ? '—' : `${Math.round(Number(item.latency_ms))} 毫秒`, detail: 'Enter 查看',
          }, run: async ctx => {
            const response = await api(`/api/admin/usage-logs/${encodeURIComponent(item.id)}`);
            const log = response.log || item;
            const prompt = Number(log.prompt_tokens || 0); const cached = Number(log.cached_tokens || 0);
            const details = [
              `时间：${formatTime(log.created_at)}`, `用户：${log.username || `用户 ${log.user_id}`}`, `模型：${log.model_name || log.model_id || '未知'}`,
              `上游模型 ID：${log.upstream_model_id || '未知'}`, `供应商：${log.provider_name || '未知'}`, `请求类型：${log.request_type || '未知'}`, `客户端：${log.request_source || '未知'}`,
              `API Key：${log.key_prefix ? `${log.key_prefix}****` : '未知'}${log.key_name ? `（${log.key_name}）` : ''}`,
              `总 Token：${formatBigNumber(log.tokens_used)}`, `输入 Token：${formatBigNumber(prompt)}`, `输出 Token：${formatBigNumber(log.completion_tokens)}`,
              `缓存命中：${formatBigNumber(cached)}${prompt ? `（${(cached / prompt * 100).toFixed(1)}%）` : ''}`, `积分：${formatCost(log.cost)}`,
              `记录延迟：${log.latency_ms == null ? '未知' : `${Math.round(Number(log.latency_ms))} 毫秒`}`, `请求模式：${log.is_stream == null ? '未知' : log.is_stream ? '流式' : '非流式'}`,
              `首字延迟：${log.ttft_ms == null ? '未知' : `${Math.round(Number(log.ttft_ms))} 毫秒`}`, `每输出 Token 耗时：${log.tpot_ms == null ? '未知' : `${Number(log.tpot_ms).toFixed(1)} 毫秒`}`,
              `输出速度：${log.output_tps == null ? '未知' : `${Number(log.output_tps).toFixed(1)} Token/秒`}`, `端到端延迟：${log.e2e_ms == null ? '未知' : `${Math.round(Number(log.e2e_ms))} 毫秒`}`,
              `服务层级：${log.service_tier || '未知'}`, `限流状态：${log.rate_limit ? JSON.stringify(log.rate_limit) : '无'}`, `IP 地址：${log.ip_address || '未知'}`,
            ];
            const analysis = log.message_analysis;
            if (analysis) {
              details.push('', `消息分析：${Number(analysis.message_count || 0)} 条消息`);
              const values = analysis.values || {};
              for (const [key, label] of [['workspace_path', '工作区路径'], ['os_version', '操作系统版本'], ['shell', 'Shell 类型'], ['date', '客户端日期']]) if (values[key]) details.push(`${label}：${values[key]}`);
              const observed = analysis.observed_fields || {};
              if (observed.git_status) details.push('Git 状态：请求包含此区块');
              if (observed.project_layout) details.push('项目结构：请求包含此区块');
              if (analysis.block_counts && Object.keys(analysis.block_counts).length) details.push(`消息区块：${Object.entries(analysis.block_counts).map(([key, count]) => `${key.replace(/_/g, ' ')} ${count} 次`).join('、')}`);
            }
            if (log.messages) details.push('', '请求消息：', typeof log.messages === 'string' ? log.messages : JSON.stringify(log.messages, null, 2));
            if (log.response) details.push('', 'AI 回复：', String(log.response));
            await ctx.show(`调用记录 · ${log.model_name || log.model_id || log.id}`, details.join('\n'));
          } })) : [{ label: '当前筛选范围暂无调用记录。' }] });
        }
        if (tab === 'latency') {
          const latency = await api('/api/admin/stats/latency', { query: { days, ...(runtime.adminStatsFilters || {}) } });
          const summary = latency.summary || {};
          const percentile = (group, key) => group && group[key] != null ? Math.round(Number(group[key])) : null;
          sections.push({ title: '响应速度与首字延迟', toolbar: true, cards: [
            { label: '完整响应中位延迟（P50）', value: text(percentile(summary.e2e, 'p50'), '—'), detail: '一半请求不超过此耗时 · 毫秒' },
            { label: '完整响应95%分位延迟（P95）', value: text(percentile(summary.e2e, 'p95'), '—'), detail: '95% 请求不超过此耗时 · 毫秒' },
            { label: '首字延迟95%分位（P95）', value: text(percentile(summary.ttft, 'p95'), '—'), detail: '95% 请求不超过此耗时 · 毫秒' },
            { label: '已测量请求数', value: text(summary.measuredRequests, '0'), detail: `数据覆盖 ${(Number(summary.coverage || 0) * 100).toFixed(1)}% 的请求` },
          ], rows: array(latency.daily).map(item => ({ label: display(item.date, `${item.requests || 0} 次请求`, `完整响应95%分位 ${percentile(item.e2e, 'p95') ?? '—'} 毫秒`, `首字延迟95%分位 ${percentile(item.ttft, 'p95') ?? '—'} 毫秒`, `输出速度中位数 ${percentile(item.outputTps, 'p50') ?? '—'} Token/秒`) })) });
        }
        return { sections, pageToolbar: true, actions: [
          ...[7, 30, 90, 180, 365].map(value => ({ label: value === 365 ? '最近 1 年' : `最近 ${value} 天`, toolbar: true, run: async ctx => { runtime.adminStatsDays = value; if (runtime.adminStatsQuotaQuery) runtime.adminStatsQuotaQuery = { ...runtime.adminStatsQuotaQuery, days: value }; if (runtime.adminStatsDimensionQuery) runtime.adminStatsDimensionQuery = { ...runtime.adminStatsDimensionQuery, days: value }; await ctx.refresh(); } })),
          ...(tab === 'multi' ? [{ label: '筛选额度统计', toolbar: 'page', disabled: !runtime.adminStatsQuotaQuery, run: async ctx => {
            const current = runtime.adminStatsQuotaFilters || {};
            const options = await api('/api/admin/stats/multi/filters');
            const filters = [
              ['provider_id', '供应商', [...new Map(array(options.providers).map(item => [String(item.id), item])).values()]],
              ['user_id', '成员', array(options.users)], ['team_id', 'Team', array(options.teams)], ['model_id', '模型', array(options.models)],
              ['request_source', '客户端', array(options.sources)], ['workspace_path', '项目', array(options.projects)],
            ];
            const key = await ctx.choose('选择额度筛选条件', [
              ...filters.map(([field, label]) => ({ label: `${label}${current[field] ? ' · 已筛选' : ''}`, value: field })),
              ...[['account_id', '账户编号'], ['kind', '额度类型'], ['unit', '计量单位'], ['window_key', '周期窗口'], ['status', '查询状态']].map(([field, label]) => ({ label: `${label}${current[field] ? ' · 已筛选' : ''}`, value: field })),
              { label: '清除额度筛选', value: '__clear__' },
            ]);
            if (!key) return;
            if (key === '__clear__') { runtime.adminStatsQuotaFilters = {}; if (runtime.adminStatsQuotaQuery) { runtime.adminStatsQuotaQuery = { dimensions: runtime.adminStatsQuotaQuery.dimensions, metric: runtime.adminStatsQuotaQuery.metric, data_source: 'quota', days }; } await ctx.refresh(); return; }
            const source = filters.find(([field]) => field === key);
            let value;
            if (source) {
              const [, label, rows] = source;
              value = await ctx.choose(label, [{ label: `全部${label}`, value: '' }, ...rows.map(item => ({ label: item.name || item.label || String(item.id), value: item.id }))]);
            } else {
              const choices = key === 'kind' ? [{ label: '余额额度', value: 'balance' }, { label: '周期额度', value: 'window' }, { label: '状态额度', value: 'status' }]
                : key === 'status' ? ['success', 'partial', 'failed', 'stale'].map(item => ({ label: item, value: item }))
                  : key === 'unit' ? ['requests', 'tokens', 'credits', 'percent', 'USD', 'unknown'].map(item => ({ label: item, value: item }))
                    : null;
              value = choices ? await ctx.choose('额度筛选值', [{ label: '全部', value: '' }, ...choices]) : await ctx.ask({ account_id: '额度账户 ID', window_key: '周期窗口名称' }[key] || '筛选值', { defaultValue: current[key] || '' });
            }
            if (value === null) return;
            const next = { ...current };
            if (value) next[key] = String(value); else delete next[key];
            runtime.adminStatsQuotaFilters = next;
            if (runtime.adminStatsQuotaQuery) runtime.adminStatsQuotaQuery = { ...runtime.adminStatsQuotaQuery, ...next, days };
            await ctx.refresh();
          } }, { label: '查询供应商额度维度', toolbar: 'page', run: async ctx => {
            const dimensionOptions = [['provider', '供应商'], ['account', '额度账户'], ['kind', '额度类型'], ['unit', '计量单位'], ['window', '周期窗口'], ['date', '日期']];
            const dimensions = [];
            while (dimensions.length < dimensionOptions.length) {
              const remaining = dimensionOptions.filter(([value]) => !dimensions.includes(value));
              const selected = await ctx.choose(`额度维度（已选 ${dimensions.length} 项）`, [...remaining.map(([value, label]) => ({ label: `添加：${label}`, value })), { label: '完成维度选择', value: '__done__' }]);
              if (!selected || selected === '__done__') break;
              dimensions.push(selected);
            }
            if (!dimensions.length) return;
            const metricOptions = [
              ['total', '总额度'], ['used', '已用额度'], ['remaining', '剩余额度'], ['used_percent', '已用百分比'],
              ['observed_consumption', '观测到的消耗'], ['percent_change', '相对变化百分比'],
            ];
            const metric = await ctx.choose('额度统计指标', metricOptions.map(([value, label]) => ({ label, value })));
            if (!metric) return;
            if (['used_percent', 'percent_change'].includes(metric) && !dimensions.includes('account')) { await ctx.show('维度组合无效', '使用率和相对变化指标必须包含“额度账户”维度。'); return; }
            const confirmed = await ctx.confirm('查询供应商额度维度', `维度：${dimensions.map(value => dimensionOptions.find(([key]) => key === value)?.[1] || value).join('、')}\n指标：${metricOptions.find(([value]) => value === metric)?.[1] || metric}\n范围：最近 ${days} 天\n额度是独立上游账户观测值，不应与请求消费金额直接相加。`);
            if (!confirmed) return;
            const query = { dimensions: dimensions.join(','), metric, data_source: 'quota', days, ...(runtime.adminStatsQuotaFilters || {}) };
            runtime.adminStatsQuotaQuery = query;
            runtime.adminStatsDimensionQuery = null;
            await ctx.refresh();
          } }, { label: '退出额度统计', toolbar: 'page', run: async ctx => { runtime.adminStatsQuotaQuery = null; runtime.adminStatsQuotaFilters = {}; await ctx.refresh(); } }, { label: '选择维度与指标', toolbar: 'page', run: async ctx => {
            const dimensionOptions = [
              { label: '成员', value: 'user' }, { label: 'Team', value: 'team' }, { label: '项目', value: 'project' },
              { label: '客户端', value: 'source' }, { label: '模型', value: 'model' }, { label: '供应商', value: 'provider' }, { label: 'API Key', value: 'key' },
            ];
            const dimensions = [];
            while (dimensions.length < dimensionOptions.length) {
              const remaining = dimensionOptions.filter(option => !dimensions.includes(option.value));
              const selected = await ctx.choose(`统计维度（已选 ${dimensions.length} 项）`, [...remaining.map(option => ({ ...option, label: `添加：${option.label}` })), { label: '完成维度选择', value: '__done__' }]);
              if (!selected || selected === '__done__') break;
              dimensions.push(selected);
            }
            if (!dimensions.length) return;
            const source = await ctx.choose('分析数据源', [{ label: '请求用量', value: 'usage' }, { label: '关联分析', value: 'association' }, { label: '供应商额度（将另选额度维度）', value: 'quota' }], { description: '请求用量与关联分析使用上方所选维度；额度数据源会改为选择额度账户、单位和窗口等专属维度。' });
            if (!source) return;
            if (source === 'quota') {
              const quotaDimensionOptions = [['provider', '供应商'], ['account', '额度账户'], ['kind', '额度类型'], ['unit', '单位'], ['window', '额度窗口'], ['date', '日期']];
              const quotaDimensions = [];
              while (quotaDimensions.length < quotaDimensionOptions.length) {
                const remaining = quotaDimensionOptions.filter(([value]) => !quotaDimensions.includes(value));
                const selected = await ctx.choose(`额度维度（已选 ${quotaDimensions.length} 项）`, [...remaining.map(([value, label]) => ({ label: `添加：${label}`, value })), { label: '完成维度选择', value: '__done__' }]);
                if (!selected || selected === '__done__') break;
                quotaDimensions.push(selected);
              }
              if (!quotaDimensions.length) return;
              const metricOptions = [['total', '总额度'], ['used', '已用额度'], ['remaining', '剩余额度'], ['used_percent', '已用百分比'], ['observed_consumption', '观测消耗'], ['percent_change', '使用率变化（百分点）']];
              const metric = await ctx.choose('额度统计指标', metricOptions.map(([value, label]) => ({ label, value })));
              if (!metric) return;
              if (['used_percent', 'percent_change'].includes(metric) && !quotaDimensions.includes('account')) { await ctx.show('维度组合无效', '使用率和变化率指标必须包含额度账户维度。'); return; }
              runtime.adminStatsQuotaQuery = { dimensions: quotaDimensions.join(','), metric, data_source: 'quota', days, ...(runtime.adminStatsQuotaFilters || {}) };
              runtime.adminStatsDimensionQuery = null;
              await ctx.refresh();
              return;
            }
            const metric = await ctx.choose('统计指标', [{ label: '请求数', value: 'requests' }, { label: 'Token 用量', value: 'tokens' }, { label: '消费积分', value: 'cost' }]);
            if (!metric) return;
            const includeQuota = await ctx.choose('是否叠加供应商额度参照', [{ label: '否，仅展示请求统计', value: false }, { label: '是，叠加供应商额度上下文', value: true }]);
            if (includeQuota === null) return;
            const quotaMode = includeQuota && dimensions.includes('user')
              ? await ctx.choose('成员额度展示方式', [{ label: '仅展示供应商级额度参照', value: 'reference' }, { label: '按供应商内成员请求占比估算', value: 'member_estimate' }])
              : 'reference';
            if (quotaMode === null) return;
            runtime.adminStatsDimensionQuery = { dimensions: dimensions.join(','), metric, data_source: source, days, ...(includeQuota ? { include_quota: 'true' } : {}), ...(quotaMode === 'member_estimate' ? { quota_mode: 'member_estimate' } : {}) };
            runtime.adminStatsQuotaQuery = null;
            await ctx.refresh();
          } }, { label: '清除自选维度', toolbar: 'page', run: async ctx => { runtime.adminStatsDimensionQuery = null; await ctx.refresh(); } }, { label: '筛选关联分析', toolbar: 'page', run: async ctx => {
            const options = await api('/api/admin/stats/multi/filters');
            const filters = runtime.adminStatsMultiFilters || {};
            const dimensions = [['user_id', '成员', 'users'], ['team_id', 'Team', 'teams'], ['model_id', '模型', 'models'], ['provider_id', '供应商', 'providers'], ['request_source', '客户端', 'sources'], ['workspace_path', '项目', 'projects']];
            const dimension = await ctx.choose('选择筛选条件', dimensions.map(([key, label]) => ({ label: `${label}${filters[key] ? ' · 已筛选' : ''}`, value: key })));
            if (!dimension) return;
            const [key, label, optionKey] = dimensions.find(([candidate]) => candidate === dimension);
            const rows = array(options[optionKey]);
            const value = await ctx.choose(`${label}筛选`, [{ label: `全部${label}`, value: '' }, ...rows.map(row => ({ label: row.name || row.id, value: row.id }))]);
            if (value === null) return;
            const next = { ...filters };
            if (value) next[key] = value; else delete next[key];
            runtime.adminStatsMultiFilters = next; await ctx.refresh();
          } }, { label: '清除关联筛选', toolbar: 'page', run: async ctx => { runtime.adminStatsMultiFilters = {}; await ctx.refresh(); } }] : []),
          ...(tab === 'logs' ? [
            { label: '筛选调用记录', toolbar: 'page', run: async ctx => {
              const current = runtime.adminStatsLogFilters || {};
              const model = await ctx.ask('模型名称或 ID（留空不过滤）', { defaultValue: current.model_q || '' }); if (model === null) return;
              const user = await ctx.ask('用户名或用户 ID（留空不过滤）', { defaultValue: current.user_q || '' }); if (user === null) return;
              const provider = await ctx.ask('供应商名称或 ID（留空不过滤）', { defaultValue: current.provider_q || '' }); if (provider === null) return;
              const requestType = await ctx.choose('请求类型', [{ label: '全部', value: '' }, ...['chat', 'responses', 'fusion', 'playground', 'imagine', 'agent_manage', 'gemini', 'interactions'].map(value => ({ label: value, value }))]); if (requestType === null) return;
              const source = await ctx.choose('客户端', [{ label: '全部', value: '' }, ...['grok', 'codex', 'claude_code', 'opencode', 'qwen_code', 'hermes', 'openclaw', 'deepseek_harness', 'unknown'].map(value => ({ label: value, value }))]); if (source === null) return;
              const next = { ...(model ? { model_q: String(model).trim() } : {}), ...(user ? { user_q: String(user).trim() } : {}), ...(provider ? { provider_q: String(provider).trim() } : {}), ...(requestType ? { request_type: requestType } : {}), ...(source ? { request_source: source } : {}) };
              runtime.adminStatsLogFilters = next; runtime.adminStatsLogPage = 1; await ctx.refresh();
            } },
            { label: '搜索调用记录日期', toolbar: 'page', run: async ctx => {
              const values = await ctx.form('调用记录日期范围', [{ name: 'start_date', label: '开始日期（YYYY-MM-DD）', value: runtime.adminStatsLogFilters?.start_date || '' }, { name: 'end_date', label: '结束日期（YYYY-MM-DD）', value: runtime.adminStatsLogFilters?.end_date || '' }]);
              if (!values) return;
              const next = { ...(runtime.adminStatsLogFilters || {}) };
              if (values.start_date) next.start_date = values.start_date; else delete next.start_date;
              if (values.end_date) next.end_date = values.end_date; else delete next.end_date;
              const validDate = value => !value || (typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
              if (!validDate(next.start_date) || !validDate(next.end_date) || next.start_date && next.end_date && next.start_date > next.end_date) { await ctx.show('日期范围无效', '请使用真实存在的 YYYY-MM-DD 日期，且结束日期不能早于开始日期。'); return; }
              runtime.adminStatsLogFilters = next; runtime.adminStatsLogPage = 1; await ctx.refresh();
            } },
            { label: '清除调用记录筛选', toolbar: 'page', run: async ctx => { runtime.adminStatsLogFilters = {}; runtime.adminStatsLogPage = 1; await ctx.refresh(); } },
            { label: '调用记录上一页', toolbar: 'page', disabled: (runtime.adminStatsLogPage || 1) <= 1, run: async ctx => { runtime.adminStatsLogPage = Math.max(1, (runtime.adminStatsLogPage || 1) - 1); await ctx.refresh(); } },
            { label: '调用记录下一页', toolbar: 'page', disabled: logPage * 30 >= logTotal, run: async ctx => { runtime.adminStatsLogPage = logPage + 1; await ctx.refresh(); } },
          ] : []),
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    {
      id: 'balance', label: '积分', description: '当前积分、可退款余额、所属团队与个人请求限额。',
      async load(api) {
        const data = await api('/api/user/balance');
        const group = data && data.group || {};
        const rules = array(group.rules);
        return { sections: [
          { title: '当前积分', cards: [{ label: '积分', value: text(data && data.balance, '0') }, { label: '可退款', value: text(data && data.refund_balance, '0') }] },
          { title: '所属团队与个人限额', rows: [
            { label: `所属团队：${text(group.name, '未分配')}` },
            { label: `个人速率限制：每分钟 ${Number(data && data.rate_limit_rpm || 0)} 次请求、${Number(data && data.rate_limit_tpm || 0)} Token` },
            ...rules.map(rule => ({ label: `${rule.rule_type === 'requests' ? '请求次数上限' : 'Token 用量上限'}：${rule.rule_value} / ${rule.duration_hours || 24} 小时`, detail: `当前用量 ${rule.current || 0}${rule.rule_type === 'requests' ? ' 次请求' : ' Token'}${rule.description ? ` · ${rule.description}` : ''}` })),
          ] },
        ], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    },
    {
      id: 'settings', label: '设置', description: '个人资料、API 签名及网页专属设置状态。',
      async load(api) {
        const [signature, profile, pluginOptinResult, hookResult, notificationResult, notificationsResult] = await Promise.allSettled([api('/api/user/signature'), api('/auth/me'), api('/api/user/plugin-pref-optin'), api('/api/user/hook-notify-rules'), api('/api/user/notification-settings'), api('/api/user/notifications', { query: { limit: 50 } })]);
        const signatureData = signature.status === 'fulfilled' ? signature.value : {};
        const user = profile.status === 'fulfilled' ? profile.value : {};
        const pluginOptedIn = pluginOptinResult.status === 'fulfilled' && pluginOptinResult.value?.optedIn === true;
        const hookSettings = hookResult.status === 'fulfilled' ? hookResult.value : {};
        const hookSelection = hookSettings.selection || { harnesses: [], eventTypes: [] };
        const notificationSettings = notificationResult.status === 'fulfilled' ? notificationResult.value : {};
        const notifications = notificationsResult.status === 'fulfilled' ? array(notificationsResult.value) : [];
        const unreadNotifications = notifications.filter(item => !item.read_at).length;
        const harnessNames = { claude_code: 'Claude Code', codex: 'Codex', grok: 'Grok', opencode: 'OpenCode', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw', deepseek_harness: 'DeepSeek Harness' };
        const hookEventNames = { session_start: '会话开始', session_end: '会话结束', tool_use: '工具调用' };
        return { sections: [
          { title: '个人资料', rows: [
            { label: `用户名：${text(user.username, '未知')}` },
            { label: `邮箱：${text(user.email, '未设置')}` },
            { label: `头像：${user.avatar ? '已设置' : '未设置'}`, detail: '头像上传需要网页文件选择器。' },
            ...(profile.status === 'rejected' ? [{ label: profile.reason.message || '账户资料暂不可用' }] : []),
          ] },
          { title: '通知', description: '网页端支持 Bark 推送设置和站内通知管理。', rows: [
            { label: `Bark 通知：${notificationSettings.barkEnabled === true ? '已开启' : '已关闭'}`, detail: `Server Key：${notificationSettings.barkServerKey ? '已配置（不显示密钥）' : '未配置'} · 服务地址：${notificationSettings.barkEndpoint || 'https://api.day.app'}` },
            { label: `通知偏好：额度不足${notificationSettings.notifyQuota === false ? '关闭' : '开启'} · 请求异常${notificationSettings.notifyErrors === false ? '关闭' : '开启'}` },
            { label: `站内通知：${notifications.length} 条（未读 ${unreadNotifications} 条）`, detail: notificationsResult.status === 'rejected' ? `通知列表读取失败：${notificationsResult.reason.message || '未知错误'}` : '当前仅汇总最近 50 条。' },
            ...(notificationResult.status === 'rejected' ? [{ label: `通知设置读取失败：${notificationResult.reason.message || '未知错误'}` }] : []),
          ] },
          { title: '我的通知', rows: notifications.length ? notifications.map(item => ({ label: `${item.read_at ? '已读' : '未读'} · ${item.title || '通知'}`, detail: `${item.body || ''}${item.created_at ? ` · ${formatTime(item.created_at)}` : ''}` })) : [{ label: notificationsResult.status === 'rejected' ? '站内通知暂不可用。' : '暂无通知。' }] },
          { title: 'API 签名', description: '签名会按用户设置注入 AI 回复；API Key 可单独继承或覆盖。', rows: [
            { label: `AI 回复签名：${signatureData.enabled ? '已启用' : '已关闭'}` },
            { label: '签名模板', detail: text(signatureData.template, '未设置模板') },
            ...(Array.isArray(signatureData.defaults?.variables) ? [{ label: `可用变量：${signatureData.defaults.variables.map(item => typeof item === 'string' ? item : item.name || item.key).join('、')}` }] : []),
            ...(signature.status === 'rejected' ? [{ label: signature.reason.message || '签名设置暂不可用' }] : []),
          ] },
          { title: '插件授权', description: '控制已安装插件可读取的个人数据范围。', rows: [
            { label: `允许插件读取我的偏好：${pluginOptedIn ? '已授权' : '未授权'}`, detail: '开启后，声明 preferences:read 权限的插件可通过接口读取你的界面偏好；关闭后立即失效。' },
            ...(pluginOptinResult.status === 'rejected' ? [{ label: `授权状态读取失败：${pluginOptinResult.reason.message || '未知错误'}` }] : []),
          ] },
          { title: '事件通知', description: '客户端上报的事件可推送到站内通知与 Bark。', rows: [
            { label: `事件推送总开关：${hookSettings.pushEnabled === true ? '已开启' : '已关闭'}` },
            { label: `客户端：${(hookSelection.harnesses || []).length ? hookSelection.harnesses.map(value => harnessNames[value] || value).join('、') : '全部客户端'}` },
            { label: `事件：${(hookSelection.eventTypes || []).length ? hookSelection.eventTypes.map(value => hookEventNames[value] || value).join('、') : '全部支持事件'}`, detail: 'TUI 当前支持配置：会话开始、会话结束、工具调用；留空表示全部。' },
            ...(hookResult.status === 'rejected' ? [{ label: `事件通知设置读取失败：${hookResult.reason.message || '未知错误'}` }] : []),
          ] },
          { title: '网页专属设置', rows: [
            { label: '全局代理池（网页网络设置）', detail: '在管理员网页「设置 → 网络」配置订阅地址或手动代理；只有供应商选择“代理池”模式并启用后才生效，遇到 IP 限速时可自动切换代理。此处不读取或修改代理地址。' },
            { label: '界面背景与主题', detail: '壁纸上传及主题插件选择需要浏览器图形界面。' },
            { label: 'API 签名预览', detail: 'TUI 显示签名模板；依赖网页即时预览的变量渲染在此不支持。' },
          ] },
        ], actions: [
          { label: pluginOptedIn ? '关闭插件偏好授权' : '允许插件读取我的偏好', disabled: pluginOptinResult.status === 'rejected', run: async ctx => { if (pluginOptinResult.status === 'rejected') return; const enabled = !pluginOptedIn; if (!await ctx.confirm(enabled ? '允许插件读取偏好' : '撤销插件偏好授权', enabled ? '拥有 preferences:read 权限的已安装插件将可以读取你的界面偏好。' : '插件将立即失去读取界面偏好的权限。')) return; await api('/api/user/plugin-pref-optin', { method: 'PUT', body: { enabled } }); ctx.notify(enabled ? '插件偏好读取已授权。' : '插件偏好授权已撤销。'); await ctx.refresh(); } },
          { label: hookSettings.pushEnabled ? '关闭事件推送' : '开启事件推送', disabled: hookResult.status === 'rejected', run: async ctx => { if (hookResult.status === 'rejected') return; const enabled = hookSettings.pushEnabled !== true; if (!await ctx.confirm(enabled ? '开启事件推送' : '关闭事件推送', enabled ? '已选择的客户端事件将推送到站内通知；Bark 推送还需配置并开启 Bark。' : '客户端上报事件将不再触发通知。')) return; await api('/api/user/hook-notify-rules/push-enabled', { method: 'PUT', body: { enabled } }); ctx.notify(enabled ? '事件推送已开启。' : '事件推送已关闭。'); await ctx.refresh(); } },
          { label: '选择事件推送范围', disabled: hookResult.status === 'rejected', run: async ctx => { if (hookResult.status === 'rejected') return; const harnesses = ['claude_code', 'codex', 'grok', 'opencode', 'qwen_code', 'hermes', 'openclaw', 'deepseek_harness']; const events = ['session_start', 'session_end', 'tool_use']; const selectedHarnesses = new Set(hookSelection.harnesses || []); const selectedEvents = new Set(hookSelection.eventTypes || []); const selectSet = async (title, values, selected, labels) => { while (true) { const value = await ctx.choose(title, [...values.map(id => ({ label: `${selected.has(id) ? '☑' : '☐'} ${labels[id] || id}`, value: id })), { label: `完成选择（${selected.size} 项）`, value: '__done__' }], { description: '不选择任何项表示全部。' }); if (value === null) return false; if (value === '__done__') return true; if (selected.has(value)) selected.delete(value); else selected.add(value); } }; if (!await selectSet('选择接收事件的客户端', harnesses, selectedHarnesses, harnessNames)) return; if (!await selectSet('选择要推送的事件', events, selectedEvents, hookEventNames)) return; const nextHarnesses = [...selectedHarnesses]; const nextEvents = [...selectedEvents]; if (!await ctx.confirm('保存事件推送范围', `客户端：${nextHarnesses.length ? nextHarnesses.map(value => harnessNames[value]).join('、') : '全部'}\n事件：${nextEvents.length ? nextEvents.map(value => hookEventNames[value]).join('、') : '全部支持事件'}`)) return; await api('/api/user/hook-notify-rules/selection', { method: 'PUT', body: { harnesses: nextHarnesses, eventTypes: nextEvents } }); ctx.notify('事件推送范围已保存。'); await ctx.refresh(); } },
          { label: notificationResult.status === 'rejected' ? '编辑通知设置（不可用）' : '编辑通知设置', disabled: notificationResult.status === 'rejected', run: async ctx => {
            const values = await ctx.form('编辑通知设置', [
              { name: 'barkEnabled', label: '启用 Bark 通知', type: 'boolean', value: notificationSettings.barkEnabled === true },
              { name: 'barkServerKey', label: 'Bark Server Key（留空保持现有）', secret: true, value: '' },
              { name: 'barkEndpoint', label: 'Bark 服务地址', value: notificationSettings.barkEndpoint || 'https://api.day.app' },
              { name: 'notifyQuota', label: '额度不足通知', type: 'boolean', value: notificationSettings.notifyQuota !== false },
              { name: 'notifyErrors', label: '请求异常通知', type: 'boolean', value: notificationSettings.notifyErrors !== false },
            ], { description: `${notificationSettings.barkServerKey ? 'Server Key 已配置；留空会保留现有密钥。' : '尚未配置 Server Key。'}站内通知开关与 Bark 开关分别生效。` });
            if (!values) return;
            if (!await ctx.confirm('保存通知设置', `Bark：${values.barkEnabled ? '开启' : '关闭'} · 额度通知：${values.notifyQuota ? '开启' : '关闭'} · 异常通知：${values.notifyErrors ? '开启' : '关闭'}\nServer Key：${values.barkServerKey ? '将更新' : '保持现状'}`)) return;
            await api('/api/user/notification-settings', { method: 'PUT', body: { barkEnabled: values.barkEnabled === true, ...(values.barkServerKey ? { barkServerKey: values.barkServerKey } : {}), barkEndpoint: values.barkEndpoint, notifyQuota: values.notifyQuota === true, notifyErrors: values.notifyErrors === true } });
            ctx.notify('通知设置已保存。'); await ctx.refresh();
          } },
          { label: '发送测试 Bark 通知', disabled: notificationResult.status === 'rejected' || notificationSettings.barkEnabled !== true || !notificationSettings.barkServerKey, run: async ctx => { if (!await ctx.confirm('发送测试 Bark 通知', `将通过已配置的 Bark 服务发送一条测试消息到设备。\n服务地址：${notificationSettings.barkEndpoint || 'https://api.day.app'}`)) return; const result = await api('/api/user/notification-settings/test', { method: 'POST' }); await ctx.show('测试 Bark 通知', result.message || '测试通知已发送。'); } },
          { label: '清空站内通知', disabled: notifications.length === 0 || notificationsResult.status === 'rejected', run: async ctx => { if (!await ctx.confirm('清空站内通知', `将删除服务器保存的站内通知（当前最近 50 条中 ${notifications.length} 条）。此操作不可恢复。`)) return; await api('/api/user/notifications', { method: 'DELETE' }); ctx.notify('站内通知已清空。'); await ctx.refresh(); } },
          { label: '编辑 API 签名', run: async ctx => {
            const values = await ctx.form('编辑 API 签名', [
              { name: 'enabled', label: '启用 AI 回复签名', type: 'boolean', value: signatureData.enabled === true },
              { name: 'template', label: '签名模板（最多 2000 字符）', value: signatureData.template || '' },
            ], { description: '关闭总开关会使所有 API Key 不注入用户级签名。API Key 的单独覆盖仍由 Key 设置控制。' });
            if (!values) return;
            if (String(values.template || '').length > 2000) { await ctx.show('签名模板过长', '签名模板最多 2000 个字符。'); return; }
            if (!await ctx.confirm('保存 API 签名', `总开关：${values.enabled ? '开启' : '关闭'}\n模板长度：${String(values.template || '').length} 个字符`)) return;
            await api('/api/user/signature', { method: 'PUT', body: { enabled: values.enabled === true, template: String(values.template || '') } });
            ctx.notify('API 签名设置已保存。'); await ctx.refresh();
          } },
          { label: '修改邮箱', run: async ctx => { const email = await ctx.ask('新邮箱地址', { defaultValue: user.email || '' }); if (email === null) return; await api('/api/user/settings', { method: 'PUT', body: { email } }); ctx.notify('邮箱设置已更新。'); await ctx.refresh(); } },
          { label: '在浏览器打开完整设置', run: async ctx => { const url = `${runtime.client.baseUrl}/console#settings`; const opened = require('../lib/context').openBrowser(url); ctx.notify(opened ? '已在浏览器打开完整设置。' : `请在浏览器访问：${url}`); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    },
    adminOnly({
      id: 'admin-updates', label: '版本与更新', description: '检查官方版本与更新任务状态；TUI 不会下载安装或重启服务。',
      async load(api) {
        const [runtimeResult, statusResult] = await Promise.allSettled([api('/api/admin/update/runtime'), api('/api/admin/update/status')]);
        const runtimeData = runtimeResult.status === 'fulfilled' ? runtimeResult.value || {} : {};
        const status = statusResult.status === 'fulfilled' ? statusResult.value || {} : runtimeData.status || {};
        const labels = { currentVersion: '当前版本', latestVersion: '最新版本', latestName: '版本名称', hasUpdate: '存在可用更新', canApply: '支持自动更新', isDocker: 'Docker 环境', isDistLayout: '已构建发行版目录', fromSource: '源码运行模式', lastCheckedAt: '上次检查', phase: '任务阶段', state: '任务状态', message: '状态说明', progress: '更新进度', error: '错误信息', reason: '无法自动更新原因', appRoot: '应用目录', platform: '运行平台', arch: '系统架构' };
        const readable = (key, value) => {
          if (value == null || value === '') return '—';
          if (key === 'hasUpdate' || key === 'canApply' || key === 'isDocker' || key === 'isDistLayout' || key === 'fromSource') return value ? '是' : '否';
          if (key === 'lastCheckedAt') return formatTime(value);
          if (key === 'progress') return `${Number(value)}%`;
          if (typeof value === 'object') return Array.isArray(value) ? `${value.length} 项` : '有详细信息';
          return String(value);
        };
        const phaseLabels = { idle: '空闲', checking: '正在检查', up_to_date: '已是最新', downloading: '正在下载', extracting: '正在解压', backing_up: '正在备份', applying: '正在安装', restarting: '正在重启', completed: '已完成', error: '失败' };
        const phase = status.phase || status.state || runtimeData.phase || 'idle';
        const currentVersion = runtimeData.currentVersion || status.currentVersion;
        const latestVersion = status.latestVersion || runtimeData.latestVersion;
        const hasUpdate = status.hasUpdate ?? runtimeData.hasUpdate;
        const updateState = status.error || status.phase === 'error' ? '检查或更新失败' : hasUpdate === true ? '发现新版本' : latestVersion ? '已是最新' : status.phase === 'checking' ? '正在检查' : '尚未检查';
        const applyReason = status.reason || runtimeData.reason;
        const runtimeRows = [
          { label: `运行方式：${runtimeData.isDocker ? 'Docker' : runtimeData.fromSource ? '源码开发' : runtimeData.isDistLayout ? '构建后直接运行' : '未识别'}` },
          { label: `自动更新：${runtimeData.canApply === true ? '支持' : '不支持'}`, detail: applyReason || '此页面仅检查版本；TUI 不会下载文件、替换程序或重启服务。' },
          ...Object.entries(runtimeData).filter(([key, value]) => !['status', 'versionUrl', 'packageUrl', 'currentVersion', 'canApply', 'reason', 'isDocker', 'isDistLayout', 'fromSource', 'appRoot'].includes(key) && value != null && typeof value !== 'object').map(([key, value]) => ({ label: `${labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase())}：${readable(key, value)}` })),
        ];
        const statusRows = [
          { label: `任务阶段：${phaseLabels[phase] || phase}` },
          { label: `状态：${status.message || updateState}`, detail: status.error || '' },
          ...(status.progress != null ? [{ label: `更新进度：${readable('progress', status.progress)}` }] : []),
          ...(status.lastCheckedAt || runtimeData.lastCheckedAt ? [{ label: `上次检查：${readable('lastCheckedAt', status.lastCheckedAt || runtimeData.lastCheckedAt)}` }] : []),
          ...Object.entries(status).filter(([key, value]) => !['phase', 'state', 'message', 'progress', 'error', 'lastCheckedAt', 'currentVersion', 'latestVersion', 'hasUpdate', 'canApply', 'reason'].includes(key) && value != null && typeof value !== 'object').map(([key, value]) => ({ label: `${labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase())}：${readable(key, value)}` })),
        ];
        return { sections: [
          { title: '版本概览', cards: [
            { label: '当前版本', value: currentVersion ? `v${currentVersion}` : '—' },
            { label: '最新版本', value: latestVersion ? `v${latestVersion}` : '未检查' },
            { label: '更新状态', value: updateState },
            { label: '上次检查', value: readable('lastCheckedAt', status.lastCheckedAt || runtimeData.lastCheckedAt) },
          ], rows: [...(runtimeResult.status === 'rejected' ? [{ label: `运行环境读取失败：${runtimeResult.reason.message || '未知错误'}` }] : []), ...(statusResult.status === 'rejected' ? [{ label: `更新状态读取失败：${statusResult.reason.message || '未知错误'}` }] : [])] },
          { title: '运行环境与更新限制', rows: runtimeRows },
          { title: '更新任务', rows: statusRows },
        ], actions: [
          { label: '检查官方更新', toolbar: true, run: async ctx => { if (!await ctx.confirm('检查官方版本', '将向配置的官方版本服务发起只读 HTTPS 请求；此操作不会安装更新或重启服务。继续？')) return; const result = await api('/api/admin/update/check'); await ctx.show('版本检查结果', [`当前版本：${result.currentVersion ? `v${result.currentVersion}` : '未知'}`, `最新版本：${result.latestVersion ? `v${result.latestVersion}` : '未返回'}`, `更新状态：${result.hasUpdate ? '发现新版本' : '已是最新'}`, `自动更新：${result.canApply ? '支持' : '不支持'}`, result.reason && `原因：${result.reason}`, result.lastCheckedAt && `检查时间：${formatTime(result.lastCheckedAt)}`].filter(Boolean).join('\\n')); await ctx.refresh(); } },
          { label: '刷新状态', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-invites', label: '邀请链接', description: '创建一次性注册链接；原始链接与 token 仅在生成时显示一次。',
      async load(api) {
        const invites = array(await api('/api/auth-invites'));
        const rows = invites.map(invite => {
          const status = { active: '有效', used: '已用完', expired: '已过期', revoked: '已撤销' }[invite.status] || '未知状态';
          return { label: `邀请 #${invite.id} · ${status}`, cells: {
            id: `#${invite.id}`, status, usage: `${Number(invite.used_count || 0)} / ${Number(invite.max_uses || 1)}`, expires: invite.expires_at ? formatTime(invite.expires_at) : '—',
            team: invite.team_name || '未指定', creator: invite.created_by_name || '未知', created: invite.created_at ? formatTime(invite.created_at) : '—',
            last_used: invite.used_at ? `${invite.used_by_name || '用户'} · ${formatTime(invite.used_at)}` : '尚未使用', actions: invite.status === 'active' ? 'Enter 管理' : '查看详情',
          }, detail: `${invite.team_name ? `Team：${invite.team_name}` : '未指定 Team'} · 使用 ${Number(invite.used_count || 0)}/${Number(invite.max_uses || 1)} 次 · ${invite.expires_at ? `到期 ${formatTime(invite.expires_at)}` : '无到期时间'}`, run: async ctx => {
            const details = [
              `邀请编号：${invite.id}`, `状态：${status}`, `使用情况：${Number(invite.used_count || 0)} / ${Number(invite.max_uses || 1)} 次`,
              `有效期至：${formatTime(invite.expires_at)}`, `加入 Team：${invite.team_name || '未指定'}`,
              `创建人：${invite.created_by_name || '未知'}`, `创建时间：${formatTime(invite.created_at)}`,
              `最近使用者：${invite.used_by_name || '尚未使用'}`, invite.used_at && `使用时间：${formatTime(invite.used_at)}`,
              '原始 token 只在创建响应中出现；列表不会回显。',
            ].filter(Boolean).join('\\n');
            const actions = [{ label: '查看详情', value: 'detail' }, ...(invite.status === 'active' ? [{ label: '撤销邀请', value: 'revoke' }] : [])];
            const choice = await ctx.choose(`邀请链接 · #${invite.id}`, actions);
            if (choice === 'detail') await ctx.show(`邀请链接详情 · #${invite.id}`, details);
            if (choice === 'revoke') { if (!await ctx.confirm('撤销邀请链接', `撤销 #${invite.id}？该链接将立即无法注册，且此操作不可撤销。`)) return; await api(`/api/auth-invites/${encodeURIComponent(invite.id)}/revoke`, { method: 'POST', body: {} }); ctx.notify('邀请链接已撤销。'); await ctx.refresh(); }
          } };
        });
        return { sections: [{ title: '邀请链接', tableMinWidth: 136, description: `${invites.length} 条 · 列表不含原始 token`, columns: [
          { key: 'id', label: '编号', ratio: 0.06 }, { key: 'status', label: '状态', ratio: 0.1 }, { key: 'usage', label: '使用人数', ratio: 0.1 },
          { key: 'expires', label: '有效期', ratio: 0.15 }, { key: 'team', label: 'Team', ratio: 0.12 }, { key: 'creator', label: '创建人', ratio: 0.1 },
          { key: 'created', label: '创建时间', ratio: 0.13 }, { key: 'last_used', label: '最近使用', ratio: 0.16 }, { key: 'actions', label: '操作', ratio: 0.08 },
        ], rows: rows.length ? rows : [{ label: '暂无邀请链接。' }] }], actions: [
          { label: '生成邀请链接', toolbar: true, run: async ctx => {
            const teams = array(await api('/api/admin/teams'));
            const values = await ctx.form('生成邀请链接', [
              { name: 'maxUses', label: '使用人数（1-10000）', value: '1' },
              { name: 'days', label: '有效天数（1-365）', value: '7' },
              { name: 'teamId', label: '加入 Team', value: '', options: [{ label: '不指定 Team', value: '' }, ...teams.map(team => ({ label: team.name, value: String(team.id) }))] },
            ], { description: '链接和 token 只在本次生成结果显示，请及时保存。' });
            if (!values) return;
            const maxUses = Number(values.maxUses); const days = Number(values.days);
            if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000 || !Number.isInteger(days) || days < 1 || days > 365) { await ctx.show('邀请参数无效', '使用人数须为 1 到 10000；有效天数须为 1 到 365。'); return; }
            const team = teams.find(item => String(item.id) === String(values.teamId));
            if (!await ctx.confirm('确认生成邀请链接', `使用人数：${maxUses}\n有效天数：${days}\n加入 Team：${team?.name || '不指定'}\n该链接可用于创建新账户。`)) return;
            const result = await api('/api/auth-invites', { method: 'POST', body: { maxUses, days, teamId: values.teamId || '' } });
            const content = [`邀请链接：${result.url || '服务器未返回链接'}`, `一次性 token：${result.token || '服务器未返回 token'}`, `使用人数：${result.max_uses ?? maxUses}`, `有效期至：${formatTime(result.expires_at)}`, `加入 Team：${result.team_name || '不指定'}`, '', '请立即保存链接与 token；关闭后无法再次从列表读取。'].join('\\n');
            await ctx.show('邀请链接已生成', content);
            ctx.notify('邀请链接已生成；请从当前结果复制并安全发送。'); await ctx.refresh();
          } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-oauth-clients', label: 'OAuth 客户端', description: '供 OAuth 2.0 + PKCE 客户端使用；内置客户端和配置文件客户端只读。',
      async load(api) {
        const payload = await api('/api/admin/oauth-clients');
        const clients = array(payload && payload.clients);
        const scopes = array(payload && payload.scopes);
        const renderClient = client => {
          const source = ({ builtin: '内置', config: '配置文件', database: '数据库' })[client.source] || '未知来源';
          const type = client.type === 'confidential' ? '机密客户端' : '公共客户端';
          const redirects = client.allow_loopback_any_path ? '允许任意回环路径' : `${array(client.redirect_uris).length} 个回调地址`;
          return {
            label: display(client.name, type, source, client.enabled ? '启用' : '停用'),
            detail: display(`客户端 ID：${client.client_id}`, `权限：${array(client.scopes).join('、') || '无'}`, redirects, client.has_secret ? `密钥：已设置（前缀 ${client.secret_hint || '隐藏'}…）` : '密钥：不使用', client.description || '无说明'),
            run: async ctx => {
              const options = [{ label: '查看详情', value: 'detail' }];
              if (client.editable) options.push({ label: '编辑', value: 'edit' }, { label: '删除', value: 'delete' });
              if (client.editable && client.type === 'confidential') options.push({ label: '轮换密钥', value: 'rotate' });
              const choice = await ctx.choose(`OAuth 应用 · ${client.name}`, options);
              if (choice === 'detail') await ctx.show(`OAuth 应用 · ${client.name}`, `${type}\n来源：${source}\n客户端 ID：${client.client_id}\n权限：${array(client.scopes).join('、') || '无'}\n回调地址：${client.allow_loopback_any_path ? '任意回环路径' : array(client.redirect_uris).join('\n') || '无'}\n密钥：${client.has_secret ? `已设置（前缀 ${client.secret_hint || '隐藏'}…）` : '不使用'}\n启用：${client.enabled ? '是' : '否'}\n说明：${client.description || '无'}`);
              if (choice === 'edit') await editOAuthClient(ctx, api, client, scopes);
              if (choice === 'delete') { if (!await ctx.confirm('删除 OAuth 应用', `${client.name}（${client.client_id}）\n关联授权码与全部令牌将立即失效。此操作不可撤销。`)) return; const result = await api(`/api/admin/oauth-clients/${encodeURIComponent(client.client_id)}`, { method: 'DELETE' }); ctx.notify(`OAuth 应用已删除；${result.revokedTokens || 0} 个令牌已失效。`); await ctx.refresh(); }
              if (choice === 'rotate') { if (!await ctx.confirm('轮换客户端密钥', `${client.name}\n旧密钥及关联令牌将立即失效，新密钥只显示一次。`)) return; const result = await api(`/api/admin/oauth-clients/${encodeURIComponent(client.client_id)}/rotate-secret`, { method: 'POST', body: {} }); await ctx.show('客户端密钥（仅显示一次）', `${result.warning || '请立即安全保存此密钥。'}\n\n${result.client_secret || ''}\n\n已失效令牌：${result.revokedTokens || 0}`); await ctx.refresh(); }
            },
          };
        };
        return { sections: [
          { title: 'OAuth 应用', description: `${clients.length} 个客户端 · ${scopes.length} 种可分配权限`, columns: [{ key: 'name', label: '应用' }, { key: 'type', label: '类型' }, { key: 'scopes', label: '权限 / 回调' }, { key: 'secret', label: '客户端密钥' }, { key: 'status', label: '状态' }, { key: 'actions', label: '操作' }], rows: clients.map(client => ({ ...renderClient(client), cells: { name: display(client.name, client.client_id), type: `${client.type === 'confidential' ? '机密客户端' : '公共客户端'} · ${({ builtin: '内置', config: '配置文件', database: '数据库' })[client.source] || '未知来源'}`, scopes: `${array(client.scopes).join(', ') || '无'} · ${client.allow_loopback_any_path ? '任意回环路径' : `${array(client.redirect_uris).length} 个回调`}`, secret: client.has_secret ? `已设置 ${client.secret_hint || ''}…` : '不使用', status: client.enabled ? '启用' : '停用', actions: client.editable ? '管理' : '只读' } })) },
          { title: '可分配权限', rows: scopes.map(scope => ({ label: scope.scope, detail: scope.description })) },
        ], actions: [
          { label: '新建 OAuth 应用', toolbar: true, run: ctx => editOAuthClient(ctx, api, null, scopes) },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-popups', label: '弹窗通知', description: '管理用户打开控制台时展示的一次性弹窗。',
      async load(api) {
        const data = await api('/api/admin/popup-notices');
        const items = array(data && data.items);
        const rows = items.map(item => ({
          label: `${item.title || '未命名通知'} · ${item.enabled ? '已启用' : '已停用'}`,
          cells: { title: item.title || '未命名通知', status: item.enabled ? '已启用' : '已停用', seen: `${Number(item.seenCount || 0).toLocaleString()} 人已读`, close: item.closeText || '知道了', updated: formatTime(item.updatedAt || item.createdAt), actions: 'Enter 管理' },
          detail: String(item.body || '').replace(/\\s+/g, ' ').slice(0, 160) || '无正文',
          run: async ctx => {
            const choice = await ctx.choose(`弹窗通知 · ${item.title || item.id}`, [
              { label: '预览通知', value: 'preview' }, { label: '编辑通知', value: 'edit' },
              { label: item.enabled ? '停用通知' : '启用通知', value: 'toggle' }, { label: '重置已读记录', value: 'reset' }, { label: '删除通知', value: 'delete' },
            ]);
            if (!choice) return;
            if (choice === 'preview') { await ctx.show(`弹窗预览 · ${item.title}`, `${item.body || '（无正文）'}\n\n关闭按钮：${item.closeText || '知道了'}\n当前：${item.enabled ? '已启用' : '已停用'} · ${Number(item.seenCount || 0)} 人已读`); return; }
            if (choice === 'edit') {
              const values = await ctx.form('编辑弹窗通知', [
                { name: 'title', label: '标题（必填，最多 200 字符）', value: item.title || '' },
                { name: 'body', label: '正文（最多 4000 字符）', value: item.body || '' },
                { name: 'closeText', label: '关闭按钮文字（最多 40 字符）', value: item.closeText || '知道了' },
                { name: 'enabled', label: '启用通知', type: 'boolean', value: item.enabled === true },
              ]);
              if (!values) return;
              if (!String(values.title || '').trim() || [...String(values.title)].length > 200 || [...String(values.body || '')].length > 4000 || [...String(values.closeText || '')].length > 40) { await ctx.show('弹窗通知内容无效', '标题必填且最多 200 字符；正文最多 4000 字符；关闭按钮文字最多 40 字符。'); return; }
              if (!await ctx.confirm('保存弹窗通知', `${values.title.trim()}\n状态：${values.enabled ? '启用' : '停用'}\n修改正文不会自动重置用户的已读记录。`)) return;
              await api(`/api/admin/popup-notices/${encodeURIComponent(item.id)}`, { method: 'PUT', body: { title: values.title.trim(), body: String(values.body || '').trim(), closeText: String(values.closeText || '').trim(), enabled: values.enabled === true } });
              ctx.notify('弹窗通知已更新。'); await ctx.refresh(); return;
            }
            if (choice === 'toggle') {
              const enabled = item.enabled !== true;
              if (!await ctx.confirm(enabled ? '启用弹窗通知' : '停用弹窗通知', `${item.title}\n${enabled ? '启用后将向尚未读过的用户展示。' : '停用后用户将不再看到此通知。'}`)) return;
              await api(`/api/admin/popup-notices/${encodeURIComponent(item.id)}/enabled`, { method: 'PUT', body: { enabled } });
              ctx.notify(`弹窗通知已${enabled ? '启用' : '停用'}。`); await ctx.refresh(); return;
            }
            if (choice === 'reset') {
              if (!await ctx.confirm('重置已读记录', `将清除「${item.title}」的 ${Number(item.seenCount || 0)} 条已读记录；已启用的通知会再次展示给这些用户。`)) return;
              const result = await api(`/api/admin/popup-notices/${encodeURIComponent(item.id)}/reset`, { method: 'POST' });
              ctx.notify(`已重置已读记录${result.cleared != null ? `：${result.cleared} 人` : ''}。`); await ctx.refresh(); return;
            }
            if (choice === 'delete') {
              if (!await ctx.confirm('删除弹窗通知', `确定删除「${item.title}」？${Number(item.seenCount || 0)} 条已读记录会一并清除，此操作不可撤销。`)) return;
              await api(`/api/admin/popup-notices/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
              ctx.notify('弹窗通知及已读记录已删除。'); await ctx.refresh();
            }
          },
        }));
        return { sections: [{ title: '弹窗通知', tableMinWidth: 100, description: `${items.length} 条通知 · 用户打开控制台时显示一次，支持预览、启停、重置已读和删除。`, columns: [
          { key: 'title', label: '标题', ratio: 0.27 }, { key: 'status', label: '状态', ratio: 0.12 }, { key: 'seen', label: '已读人数', ratio: 0.14 },
          { key: 'close', label: '关闭按钮', ratio: 0.14 }, { key: 'updated', label: '更新时间', ratio: 0.2 }, { key: 'actions', label: '操作', ratio: 0.13 },
        ], rows: rows.length ? rows : [{ label: '暂无弹窗通知。' }] }], actions: [
          { label: '新建弹窗通知', toolbar: true, run: async ctx => {
            const values = await ctx.form('新建弹窗通知', [
              { name: 'title', label: '标题（必填，最多 200 字符）' }, { name: 'body', label: '正文（最多 4000 字符）' },
              { name: 'closeText', label: '关闭按钮文字（最多 40 字符）', value: '知道了' }, { name: 'enabled', label: '立即启用', type: 'boolean', value: true },
            ]);
            if (!values) return;
            if (!String(values.title || '').trim() || [...String(values.title)].length > 200 || [...String(values.body || '')].length > 4000 || [...String(values.closeText || '')].length > 40) { await ctx.show('弹窗通知内容无效', '标题必填且最多 200 字符；正文最多 4000 字符；关闭按钮文字最多 40 字符。'); return; }
            if (!await ctx.confirm('创建弹窗通知', `${values.title.trim()}\n状态：${values.enabled ? '启用' : '停用'}\n启用时会向尚未读过的用户展示。`)) return;
            await api('/api/admin/popup-notices', { method: 'POST', body: { title: values.title.trim(), body: String(values.body || '').trim(), closeText: String(values.closeText || '').trim(), enabled: values.enabled === true } });
            ctx.notify('弹窗通知已创建。'); await ctx.refresh();
          } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-retention', label: '数据保留', description: '配置数据压缩、清除与聚合，并可预览或启动保留任务。',
      async load(api) {
        const data = await api('/api/admin/retention-config');
        const values = data || {};
        const fields = [
          ['compress_days', '压缩天数'], ['compress_size_gb', '压缩大小（GB）'],
          ['purge_days', '清除天数'], ['purge_size_gb', '清除大小（GB）'],
          ['provider_quota_days', '供应商额度明细保留天数'],
        ];
        const describe = (key, value) => key === 'agg_enabled' ? (value ? '启用' : '关闭') : `${value}${key.endsWith('_gb') ? ' GB' : ' 天'}`;
        return { sections: [
          { title: '压缩阈值', description: '后台按时间或表大小任一条件达到时触发；压缩保留记录但回收存储空间。输入 0 表示禁用对应条件。', rows: [{ label: `按时间：${describe('compress_days', values.compress_days)}` }, { label: `按表大小：${describe('compress_size_gb', values.compress_size_gb)}` }] },
          { title: '清除阈值', description: '后台按时间或表大小任一条件达到时删除历史数据；删除阈值为 0 表示不自动删除。', rows: [{ label: `按时间：${describe('purge_days', values.purge_days)}` }, { label: `按表大小：${describe('purge_size_gb', values.purge_size_gb)}` }] },
          { title: '其他保留配置', rows: [{ label: `${fields[4][1]}：${describe('provider_quota_days', values.provider_quota_days)}`, detail: '供应商额度历史明细保留天数；每日额度聚合数据长期保留。' }, { label: `每日聚合：${describe('agg_enabled', values.agg_enabled)}` }] },
          { title: '任务状态', rows: [{ label: '压缩/清除任务在后台运行；可先用 dry-run 预览（不会修改或删除数据），完成后显示影响记录数。', detail: '同一实例已有保留任务运行时，服务器会拒绝启动新任务。' }] },
        ], actions: [
          { label: '编辑保留配置', run: async ctx => {
            const formFields = fields.map(([name, label]) => ({ name, label, value: String(values[name] ?? 0) }));
            formFields.push({ name: 'agg_enabled', label: '启用每日聚合', type: 'boolean', value: values.agg_enabled === true });
            const form = await ctx.form('编辑数据保留配置', formFields, { description: '压缩/清除按时间或表大小任一条件触发；0 可禁用条件。' });
            if (!form) return;
            const parsed = {};
            for (const [name, label] of fields) { const value = Number(form[name]); if (!Number.isInteger(value) || value < 0 || value > 3650 && name !== 'compress_size_gb' && name !== 'purge_size_gb' || (name.endsWith('_gb') && value > 1024)) { await ctx.show('配置无效', `${label} 必须是允许范围内的非负整数。`); return; } parsed[name] = value; }
            if (parsed.compress_days && parsed.purge_days && parsed.compress_days >= parsed.purge_days) { await ctx.show('配置无效', '压缩天数必须小于清除天数。'); return; }
            if (parsed.compress_size_gb && parsed.purge_size_gb && parsed.compress_size_gb >= parsed.purge_size_gb) { await ctx.show('配置无效', '压缩大小必须小于清除大小。'); return; }
            parsed.agg_enabled = form.agg_enabled === true;
            if (!await ctx.confirm('保存数据保留配置', `压缩：${parsed.compress_days} 天 / ${parsed.compress_size_gb} GB\n清除：${parsed.purge_days} 天 / ${parsed.purge_size_gb} GB\n供应商额度明细：${parsed.provider_quota_days} 天\n每日聚合：${parsed.agg_enabled ? '启用' : '关闭'}`)) return;
            await api('/api/admin/retention-config', { method: 'PUT', body: parsed }); ctx.notify('数据保留配置已保存。'); await ctx.refresh();
          } },
          ...[['compress', '压缩'], ['purge', '清除']].flatMap(([kind, label]) => [
            { label: `预览${label}（dry-run）`, run: ctx => runRetentionTask(api, ctx, kind, true) },
            { label: `立即执行${label}`, run: ctx => runRetentionTask(api, ctx, kind, false) },
          ]),
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
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
        const maskProxyUrl = value => { const raw = String(value || '').trim(); if (!raw) return ''; try { const url = new URL(raw); const auth = url.username || url.password ? '•••:•••@' : ''; const query = [...url.searchParams.entries()].map(([key, item]) => `${encodeURIComponent(key)}=${/token|key|secret|auth|password/i.test(key) ? '•••' : encodeURIComponent(item)}`).join('&'); return `${url.protocol}//${auth}${url.host}${url.pathname}${query ? `?${query}` : ''}${url.hash}`; } catch (_) { return '[已配置，地址无法解析]'; } };
        const parseProxyEntries = value => { if (Array.isArray(value)) return value; if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; } } return []; };
        const subscriptionUrl = String(general.proxy_pool_subscription_url || '');
        const proxyEntries = runtime.adminProxyPoolDraft || parseProxyEntries(general.proxy_pool_manual_proxies);
        const agent = agentResult.status === 'fulfilled' ? agentResult.value : {};
        const retention = retentionResult.status === 'fulfilled' ? retentionResult.value : {};
        const feishu = feishuResult.status === 'fulfilled' ? feishuResult.value : {};
        const toRows = (object, error) => error ? [{ label: error.message || '读取失败' }] : Object.entries(object || {}).map(([key, value]) => ({ label: `${key}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}` }));
        const quotaDefaults = { enabled: true, mode: 'async', reconciliation_seconds: 60, max_tries: 5, worker_interval_ms: 2000, batch_size: 10, lease_seconds: 120 };
        const quotaValues = { ...quotaDefaults, ...quota };
        const loginReportEnabled = general.login_report_enabled !== false;
        const statsReportEnabled = general.stats_report_enabled !== false;
        const statsGranularity = general.stats_report_granularity === 'counts' ? 'counts' : 'detailed';
        const modelList = Array.isArray(general.model_list) ? general.model_list : [];
        return { sections: [
          { title: '网络与代理池', description: '全局代理仅供选择“代理池”模式且已启用的供应商使用；IP 限速时可自动切换。订阅 URL 和代理凭证在界面中脱敏。', rows: [
            { label: `订阅地址：${subscriptionUrl ? maskProxyUrl(subscriptionUrl) : '未配置'}`, detail: '网页设置每 5 分钟拉取一次订阅内容。' },
            ...proxyEntries.map((entry, index) => ({ label: `手动代理 ${index + 1}：${maskProxyUrl(entry.url) || '地址无效'}`, detail: entry.enabled === false ? '已停用' : '已启用', run: async ctx => { const choice = await ctx.choose(`手动代理 ${index + 1}`, [{ label: '查看脱敏地址', value: 'detail' }, { label: '删除代理', value: 'delete' }]); if (choice === 'detail') await ctx.show('代理地址（已脱敏）', maskProxyUrl(entry.url)); if (choice === 'delete') { if (!await ctx.confirm('删除手动代理', `删除代理 ${index + 1}（${maskProxyUrl(entry.url)}）？保存前不会影响当前生效配置。`)) return; runtime.adminProxyPoolDraft = proxyEntries.filter((_, itemIndex) => itemIndex !== index); await ctx.refresh(); } } })),
            ...(generalResult.status === 'rejected' ? [{ label: `代理设置读取失败：${generalResult.reason.message || '未知错误'}` }] : []),
          ] },
          { title: '常规设置', description: '管理站点默认值、计费方式、后台刷新与匿名上报。', cards: [
            { label: '系统名称', value: general.site_name || '未设置' }, { label: '默认新用户积分', value: general.defaultBalance ?? '默认值' },
            { label: '默认 Key 有效期', value: general.defaultKeyExpiry == null ? '未设置' : `${general.defaultKeyExpiry} 天` },
            { label: '统计刷新间隔', value: `${Number(general.stats_refresh_interval_sec || 10)} 秒` },
          ], rows: [
            { label: `计费模式：${general.billing_mode === 'rate' ? `按请求计费 · ${Number(general.rate_price_per_request ?? 0.01).toFixed(4)} 积分/次` : '按 Token 用量计费'}` },
            { label: `登录状态上报：${loginReportEnabled ? '开启' : '关闭'}`, detail: '仅向官方上报匿名登录/退出事件。' },
            { label: `匿名统计上报：${statsReportEnabled ? '开启' : '关闭'}`, detail: `上报粒度：${statsGranularity === 'counts' ? '仅聚合计数（不含模型/供应商）' : '含模型与供应商明细'}` },
            { label: `可用模型：${modelList.length} 个`, detail: modelList.join('、') || '未配置模型列表' },
            ...(generalResult.status === 'rejected' ? [{ label: `系统设置读取失败：${generalResult.reason.message || '未知错误'}` }] : []),
          ] },
          { title: '请求额度采集', description: '控制请求额度的异步整理和采集精度；修改后即时更新采集配置。', cards: [
            { label: '采集状态', value: quotaValues.enabled ? '已启用' : '已关闭' },
            { label: '采集模式', value: quotaValues.mode === 'strict' ? '请求前后精细采集' : '异步持久采集' },
            { label: '最大尝试次数', value: quotaValues.max_tries },
          ], rows: [
            { label: `对账等待：${quotaValues.reconciliation_seconds} 秒` },
            { label: `队列处理间隔：${quotaValues.worker_interval_ms} 毫秒` },
            { label: `每批任务数：${quotaValues.batch_size} 个` },
            { label: `任务租约：${quotaValues.lease_seconds} 秒`, detail: '工作进程处理任务时的锁定时长，超时后任务可重新领取。' },
            ...(quotaResult.status === 'rejected' ? [{ label: `请求额度采集配置读取失败：${quotaResult.reason.message || '未知错误'}` }] : []),
          ] },
          { title: 'Agent Web 资料设置', cards: [
            { label: '联网搜索', value: agent.search?.enabled === true ? '已启用' : '已关闭', detail: `服务：${({ brave: 'Brave Search', tavily: 'Tavily', exa: 'Exa', firecrawl: 'Firecrawl', serper: 'Serper' })[agent.search?.provider] || agent.search?.provider || 'Tavily'} · API Key：${agent.search?.hasApiKey || agent.search?.apiKey === '[configured]' ? '已配置（不显示密钥）' : '未配置'}` },
            { label: '搜索结果数', value: `${Number(agent.search?.maxResults ?? 5)} 条` },
            { label: '搜索超时', value: `${Number(agent.search?.timeoutMs ?? 8000)} 毫秒` },
            { label: '链接抓取', value: agent.fetch?.enabled === false ? '已关闭' : '已启用' },
          ], rows: [
            { label: `抓取内容上限：${Math.round(Number(agent.fetch?.maxBytes ?? 1048576) / 1024)} KB` },
            { label: `链接抓取超时：${Number(agent.fetch?.timeoutMs ?? 10000)} 毫秒` },
            ...(agentResult.status === 'rejected' ? [{ label: `Agent Web 配置读取失败：${agentResult.reason.message || '未知错误'}` }] : []),
          ] },
          { title: '数据保留', rows: toRows(retention, retentionResult.status === 'rejected' ? retentionResult.reason : null) },
          { title: '飞书登录', description: '使用飞书企业账号登录；App Secret 不会在 TUI 中回显。', cards: [
            { label: '飞书登录', value: feishu.enabled === true ? '已启用' : '已关闭' },
            { label: 'App ID', value: feishu.appId || '未配置' },
            { label: 'App Secret', value: feishu.hasAppSecret ? '已配置（隐藏）' : '未配置' },
            { label: '企业限制', value: feishu.tenantKey ? '仅允许指定企业' : '不限制企业' },
          ], rows: [
            { label: `配置来源：${feishu.source === 'config' ? '配置文件/环境变量（尚未保存到后台）' : feishu.source === 'settings' ? '后台数据库设置' : '未知'}` },
            { label: 'OAuth 回调地址', detail: feishu.redirectUri || '未生成', run: async ctx => { if (!feishu.redirectUri) return; await ctx.show('飞书 OAuth 回调地址', `${feishu.redirectUri}\n请将此地址配置到飞书开放平台应用的重定向 URL 中；TUI 不访问系统剪贴板。`); } },
            ...(feishuResult.status === 'rejected' ? [{ label: `飞书配置读取失败：${feishuResult.reason.message || '未知错误'}` }] : []),
          ] },
        ], actions: [
          { label: generalResult.status === 'rejected' ? '编辑代理池（设置读取失败）' : '编辑代理池', disabled: generalResult.status === 'rejected', run: async ctx => { const values = await ctx.form('编辑代理池', [
            { name: 'subscriptionUrl', label: '订阅地址（留空表示不使用订阅）', value: subscriptionUrl },
            { name: 'manualProxyLines', label: '手动代理地址（每行一个）', value: (runtime.adminProxyPoolDraft || proxyEntries).map(entry => entry.url).filter(Boolean).join('\\n') },
          ], { description: '支持 http://、https://、socks4://、socks5://、socks5h://。地址可能含凭证；列表与确认摘要会脱敏。只有供应商启用代理池模式后才生效。' }); if (!values) return; const urls = String(values.manualProxyLines || '').split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#')); const validProxy = value => /^(https?|socks4|socks5h?):\/\//i.test(value) && (() => { try { const url = new URL(value); return Boolean(url.hostname); } catch (_) { return false; } })(); const invalid = urls.filter(value => !validProxy(value)); if (invalid.length) { await ctx.show('代理地址格式无效', `有 ${invalid.length} 行格式无效。每行需以 http://、https://、socks4://、socks5:// 或 socks5h:// 开头。`); return; } const unique = [...new Set(urls)]; if (unique.length !== urls.length) { await ctx.show('代理地址重复', '手动代理列表包含重复地址，请去重后再保存。'); return; } runtime.adminProxyPoolDraft = unique.map((url, index) => ({ id: `draft-${index + 1}`, url, enabled: true })); runtime.adminProxyPoolSubscriptionDraft = String(values.subscriptionUrl || '').trim(); const entries = runtime.adminProxyPoolDraft; const subUrl = runtime.adminProxyPoolSubscriptionDraft; if (!await ctx.confirm('保存代理池设置', `订阅地址：${subUrl ? maskProxyUrl(subUrl) : '未配置'}\n手动代理：${entries.length} 个\n此全局配置只在供应商选择代理池模式并启用后生效。`)) return; await api('/api/admin/settings', { method: 'PUT', body: { proxy_pool_subscription_url: subUrl, proxy_pool_manual_proxies: entries } }); runtime.adminProxyPoolDraft = null; runtime.adminProxyPoolSubscriptionDraft = null; ctx.notify('代理池设置已保存。'); await ctx.refresh(); } },
          { label: '添加手动代理', run: async ctx => { const value = String(await ctx.ask('代理地址', { description: '支持 http://、https://、socks4://、socks5://、socks5h://；地址可能包含凭证。' }) || '').trim(); if (!value) return; if (!/^(https?|socks4|socks5h?):\/\//i.test(value)) { await ctx.show('代理地址格式无效', '代理地址需以 http://、https://、socks4://、socks5:// 或 socks5h:// 开头。'); return; } try { if (!new URL(value).hostname) throw new Error('missing host'); } catch (_) { await ctx.show('代理地址格式无效', '请输入包含主机名的完整代理 URL。'); return; } const entries = runtime.adminProxyPoolDraft || proxyEntries; if (entries.some(entry => entry.url === value)) { await ctx.show('代理已存在', '手动代理列表中已包含该地址。'); return; } runtime.adminProxyPoolDraft = [...entries, { id: `draft-${Date.now()}`, url: value, enabled: true }]; await ctx.refresh(); } },
          { label: '从公网 URL 导入代理列表', run: async ctx => { const url = String(await ctx.ask('代理列表 URL', { description: '服务器将访问此公网地址；仅允许通过服务端 SSRF 校验的 URL，响应最多 1MB。' }) || '').trim(); if (!url) return; if (!await ctx.confirm('确认服务器访问代理列表 URL', `服务器将向该地址发起请求并读取代理列表：\\n${maskProxyUrl(url)}\\n请确认这是你信任的公网地址。`)) return; const result = await api('/api/admin/fetch-proxies-url', { method: 'POST', body: { url } }); const entries = runtime.adminProxyPoolDraft || proxyEntries; const seen = new Set(entries.map(entry => entry.url)); const imported = array(result.proxies).filter(value => !seen.has(value)); runtime.adminProxyPoolDraft = [...entries, ...imported.map((proxyUrl, index) => ({ id: `import-${Date.now()}-${index}`, url: proxyUrl, enabled: true }))]; await ctx.show('代理列表导入结果', `获取 ${Number(result.count || 0)} 个代理；新增 ${imported.length} 个，重复项已跳过。\n当前草稿共 ${runtime.adminProxyPoolDraft.length} 个。`); await ctx.refresh(); } },
          { label: '检测订阅地址', disabled: !subscriptionUrl && !runtime.adminProxyPoolSubscriptionDraft, run: async ctx => { const url = runtime.adminProxyPoolSubscriptionDraft ?? subscriptionUrl; if (!url) { await ctx.show('尚未配置订阅地址', '先编辑代理池并填写订阅地址。'); return; } if (!await ctx.confirm('确认检测订阅地址', `服务器将访问该地址以检查订阅是否返回代理：\\n${maskProxyUrl(url)}`)) return; const result = await api('/api/admin/fetch-proxies-url', { method: 'POST', body: { url } }); await ctx.show('订阅检测结果', result.count > 0 ? `订阅可用：检测到 ${result.count} 个代理。` : '订阅请求成功，但未找到有效代理。'); } },
          { label: '保存代理池设置', toolbar: true, disabled: generalResult.status === 'rejected', run: async ctx => { const entries = runtime.adminProxyPoolDraft || proxyEntries; const subUrl = runtime.adminProxyPoolSubscriptionDraft ?? subscriptionUrl; if (!await ctx.confirm('保存代理池设置', `订阅地址：${subUrl ? maskProxyUrl(subUrl) : '未配置'}\\n手动代理：${entries.length} 个\\n此全局配置只在供应商选择代理池模式并启用后生效。`)) return; await api('/api/admin/settings', { method: 'PUT', body: { proxy_pool_subscription_url: subUrl, proxy_pool_manual_proxies: entries } }); runtime.adminProxyPoolDraft = null; runtime.adminProxyPoolSubscriptionDraft = null; ctx.notify('代理池设置已保存。'); await ctx.refresh(); } },
          { label: generalResult.status === 'rejected' ? '编辑常规设置（不可用）' : '编辑常规设置', disabled: generalResult.status === 'rejected', run: async ctx => {
            const values = await ctx.form('编辑常规设置', [
              { name: 'site_name', label: '系统名称', value: String(general.site_name || '') },
              { name: 'defaultBalance', label: '默认新用户积分', value: String(general.defaultBalance ?? 1000) },
              { name: 'defaultKeyExpiry', label: '默认 API Key 有效期（天）', value: String(general.defaultKeyExpiry ?? 30) },
              { name: 'billing_mode', label: '计费模式', value: general.billing_mode || 'token', options: [{ value: 'token', label: '按 Token 用量计费' }, { value: 'rate', label: '按请求计费' }] },
              { name: 'rate_price_per_request', label: '每次请求价格（积分，仅按请求计费时使用）', value: String(general.rate_price_per_request ?? 0.01) },
              { name: 'stats_refresh_interval_sec', label: '统计自动刷新间隔（3-300 秒）', value: String(general.stats_refresh_interval_sec ?? 10) },
              { name: 'login_report_enabled', label: '匿名登录状态上报', type: 'boolean', value: loginReportEnabled },
              { name: 'stats_report_enabled', label: '匿名使用统计上报', type: 'boolean', value: statsReportEnabled },
              { name: 'stats_report_granularity', label: '匿名上报粒度', value: statsGranularity, options: [{ value: 'detailed', label: '含模型与供应商明细' }, { value: 'counts', label: '仅聚合计数' }] },
              { name: 'model_list', label: '可用模型 ID（每行一个；fusion 固定保留）', value: modelList.filter(value => value !== 'fusion').join('\n') },
            ], { description: '登录/统计上报仅发送匿名数据；仅聚合计数不会包含模型和供应商名称。默认积分须为非负数；有效期填 0 表示不设默认到期时间。' });
            if (!values) return;
            const seconds = Number(values.stats_refresh_interval_sec), defaultBalance = Number(values.defaultBalance), defaultKeyExpiry = Number(values.defaultKeyExpiry), ratePrice = Number(values.rate_price_per_request);
            if (!Number.isInteger(seconds) || seconds < 3 || seconds > 300 || !Number.isFinite(defaultBalance) || defaultBalance < 0 || !Number.isInteger(defaultKeyExpiry) || defaultKeyExpiry < 0 || !Number.isFinite(ratePrice) || ratePrice < 0) { await ctx.show('系统设置无效', '刷新间隔须为 3–300 秒整数；默认积分和请求价格须为非负数；Key 有效期须为非负整数。'); return; }
            const models = [...new Set(String(values.model_list || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
            if (models.some(value => value.toLowerCase() === 'fusion')) { await ctx.show('模型列表无效', 'fusion 为固定模型，无需填写；请删除该行后再保存。'); return; }
            if (!models.length) { await ctx.show('模型列表无效', '至少保留一个非 Fusion 模型 ID。'); return; }
            const body = { site_name: String(values.site_name || '').trim(), defaultBalance, defaultKeyExpiry, billing_mode: values.billing_mode === 'rate' ? 'rate' : 'token', rate_price_per_request: ratePrice, stats_refresh_interval_sec: seconds, login_report_enabled: values.login_report_enabled === true, stats_report_enabled: values.stats_report_enabled === true, stats_report_granularity: values.stats_report_granularity === 'counts' ? 'counts' : 'detailed', model_list: ['fusion', ...models] };
            if (!await ctx.confirm('保存常规设置', `系统名称：${body.site_name || '未设置'}\n默认积分：${defaultBalance} · Key 有效期：${defaultKeyExpiry || '不设默认到期'} 天\n计费方式：${body.billing_mode === 'rate' ? `每请求 ${ratePrice} 积分` : '按 Token'}\n统计刷新：${seconds} 秒 · 可用模型 ${models.length} 个\n登录上报：${body.login_report_enabled ? '开启' : '关闭'} · 统计上报：${body.stats_report_enabled ? '开启' : '关闭'}（${body.stats_report_granularity === 'counts' ? '仅计数' : '含模型/供应商'}）`)) return;
            await api('/api/admin/settings', { method: 'PUT', body }); ctx.notify('常规设置已保存。'); await ctx.refresh();
          } },
          { label: quotaResult.status === 'rejected' ? '编辑请求额度采集（不可用）' : '编辑请求额度采集', disabled: quotaResult.status === 'rejected', run: async ctx => {
            const values = await ctx.form('编辑请求额度采集', [
              { name: 'enabled', label: '启用逐请求额度采集', type: 'boolean', value: quotaValues.enabled === true },
              { name: 'mode', label: '采集模式', value: quotaValues.mode, options: [{ value: 'async', label: '异步持久采集（请求返回更快）' }, { value: 'strict', label: '请求前后精细采集（增加查询延迟）' }] },
              { name: 'reconciliation_seconds', label: '对账等待（秒，0-86400）', value: String(quotaValues.reconciliation_seconds) },
              { name: 'max_tries', label: '最大采集尝试次数（1-20）', value: String(quotaValues.max_tries) },
              { name: 'worker_interval_ms', label: '队列处理间隔（毫秒，500-60000）', value: String(quotaValues.worker_interval_ms) },
              { name: 'batch_size', label: '每批任务数（1-100）', value: String(quotaValues.batch_size) },
              { name: 'lease_seconds', label: '任务占用时长（秒，30-3600）', value: String(quotaValues.lease_seconds) },
            ], { description: '异步模式将采集任务放入后台队列；精细模式会在请求前后采集，可能增加请求延迟。' });
            if (!values) return;
            const body = { enabled: values.enabled === true, mode: values.mode === 'strict' ? 'strict' : 'async', reconciliation_seconds: Number(values.reconciliation_seconds), max_tries: Number(values.max_tries), worker_interval_ms: Number(values.worker_interval_ms), batch_size: Number(values.batch_size), lease_seconds: Number(values.lease_seconds) };
            const bounds = [['reconciliation_seconds', 0, 86400], ['max_tries', 1, 20], ['worker_interval_ms', 500, 60000], ['batch_size', 1, 100], ['lease_seconds', 30, 3600]];
            const invalid = bounds.find(([key, min, max]) => !Number.isInteger(body[key]) || body[key] < min || body[key] > max);
            if (invalid) { await ctx.show('请求采集配置无效', `${invalid[0]} 的有效范围为 ${invalid[1]}–${invalid[2]}，且必须为整数。`); return; }
            if (!await ctx.confirm('保存请求额度采集', `状态：${body.enabled ? '启用' : '关闭'} · 模式：${body.mode === 'async' ? '异步持久采集' : '请求前后精细采集'}\n对账等待 ${body.reconciliation_seconds} 秒 · 最多尝试 ${body.max_tries} 次\n队列间隔 ${body.worker_interval_ms} 毫秒 · 每批 ${body.batch_size} 个任务 · 占用 ${body.lease_seconds} 秒`)) return;
            await api('/api/admin/request-quota-config', { method: 'PUT', body }); ctx.notify('请求额度采集配置已保存。'); await ctx.refresh();
          } },
          { label: agentResult.status === 'rejected' ? '编辑 Agent Web 设置（不可用）' : '编辑 Agent Web 设置', disabled: agentResult.status === 'rejected', run: async ctx => { const search = agent.search || {}; const fetch = agent.fetch || {}; const values = await ctx.form('编辑 Agent Web 设置', [
            { name: 'search_enabled', label: '启用联网搜索', type: 'boolean', value: search.enabled === true },
            { name: 'provider', label: '搜索服务', value: search.provider || 'tavily', options: [{ value: 'tavily', label: 'Tavily' }, { value: 'brave', label: 'Brave Search' }, { value: 'serper', label: 'Serper' }] },
            { name: 'apiKey', label: `搜索服务 API Key（${search.hasApiKey || search.apiKey === '[configured]' ? '留空保留现有密钥' : '未配置'}）`, secret: true },
            { name: 'clearApiKey', label: '删除已保存的搜索服务 API Key', type: 'boolean', value: false },
            { name: 'maxResults', label: '最多搜索结果数（1-8）', value: String(search.maxResults ?? 5) },
            { name: 'searchTimeoutMs', label: '搜索超时（1000-15000 毫秒）', value: String(search.timeoutMs ?? 8000) },
            { name: 'fetch_enabled', label: '允许抓取链接', type: 'boolean', value: fetch.enabled !== false },
            { name: 'maxBytes', label: '单页抓取内容上限（65536-8388608 字节）', value: String(fetch.maxBytes ?? 1048576) },
            { name: 'fetchTimeoutMs', label: '链接抓取超时（1000-30000 毫秒）', value: String(fetch.timeoutMs ?? 10000) },
          ], { description: '密钥只在输入时发送，界面不会回显。已配置密钥留空表示保留；只有明确勾选“删除密钥”才会移除。' }); if (!values) return; const maxResults = Number(values.maxResults), searchTimeoutMs = Number(values.searchTimeoutMs), maxBytes = Number(values.maxBytes), fetchTimeoutMs = Number(values.fetchTimeoutMs); if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 8 || !Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 1000 || searchTimeoutMs > 15000 || !Number.isInteger(maxBytes) || maxBytes < 65536 || maxBytes > 8388608 || !Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs < 1000 || fetchTimeoutMs > 30000) { await ctx.show('Agent Web 参数无效', '搜索结果数须为 1-8；搜索超时为 1000-15000 毫秒；抓取上限为 65536-8388608 字节；抓取超时为 1000-30000 毫秒。'); return; } if (values.search_enabled && !(values.apiKey || search.hasApiKey || search.apiKey === '[configured]') && !values.clearApiKey) { await ctx.show('缺少搜索 API Key', '启用联网搜索前必须配置所选服务的 API Key。'); return; } if (values.clearApiKey && values.apiKey) { await ctx.show('密钥操作冲突', '请勿同时填写新密钥并勾选删除密钥。'); return; } if (!await ctx.confirm('保存 Agent Web 设置', `联网搜索：${values.search_enabled ? '开启' : '关闭'} · 服务：${values.provider}\n搜索结果：${maxResults} 条 · 搜索超时：${searchTimeoutMs} 毫秒\n链接抓取：${values.fetch_enabled ? '开启' : '关闭'} · 内容上限：${Math.round(maxBytes / 1024)} KB · 超时：${fetchTimeoutMs} 毫秒\nAPI Key：${values.clearApiKey ? '删除已保存密钥' : values.apiKey ? '更新密钥' : '保持现状'}`)) return; await api('/api/admin/agent-web', { method: 'PUT', body: { search: { enabled: values.search_enabled === true, provider: values.provider, maxResults, timeoutMs: searchTimeoutMs, ...(values.apiKey ? { apiKey: values.apiKey } : {}), ...(values.clearApiKey ? { clearApiKey: true } : {}) }, fetch: { enabled: values.fetch_enabled === true, maxBytes, timeoutMs: fetchTimeoutMs } } }); ctx.notify('Agent Web 设置已保存。'); await ctx.refresh(); } },
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
              ...(member.team_id ? [{ label: '修改 团队 角色', value: 'role' }] : []),
              { label: suspended ? '恢复成员' : '暂停成员', value: 'suspension' },
              { label: member.policy_bypass ? '关闭策略豁免' : '开启策略豁免', value: 'bypass' },
              { label: '查看生效策略', value: 'effective' },
            ]);
            if (choice === 'detail') await ctx.show(`成员详情 · ${member.username}`, [
              `用户名：${member.username || '未知'}`, `邮箱：${member.email || '未知'}`, `Team：${member.team_name || (member.team_id ? `Team ${member.team_id}` : '未分配')}`,
              `管理员：${member.is_admin ? '是' : '否'}`, `团队角色：${member.team_role || 'member'}`, `成员策略数：${Number(member.policy_count || 0)} 条`,
              `近 24 小时策略命中：${Number(member.hits_24h || 0)} 次`, `最后一次命中：${member.last_hit_at ? formatTime(member.last_hit_at) : '无记录'}`,
              `策略豁免：${member.policy_bypass ? '已开启' : '未开启'}`, member.policy_bypass_until && `豁免到期：${formatTime(member.policy_bypass_until)}`,
              `账号状态：${suspended ? `暂停中${member.suspended_reason ? ` · ${member.suspended_reason}` : ''}` : '正常'}`, member.suspended_until && `暂停至：${formatTime(member.suspended_until)}`,
            ].filter(Boolean).join('\n'));
            if (choice === 'role') {
              const role = await ctx.choose('团队 角色', ['owner', 'admin', 'member', 'viewer'].map(value => ({ label: value, value })));
              if (!role || !await ctx.confirm('更新成员角色', `${member.username}\n${member.team_name}: ${role}`)) return;
              await api(`/api/admin/policy-members/${member.id}/role`, { method: 'POST', body: { team_id: member.team_id, role } });
              ctx.notify('团队 角色已更新。'); await ctx.refresh();
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
            if (choice === 'effective') {
              const result = await api('/api/admin/policies/effective', { query: { user_id: member.id } });
              const effective = array(result.policies || result.items);
              await ctx.show(`生效策略 · ${member.username}`, [
                `执行模式：${result.settings?.enforcement_mode || result.enforcement_mode || '未知'}`,
                `当前暂停：${result.suspension?.suspended ? '是' : '否'}`,
                `生效策略：${effective.length} 条`,
                ...effective.map(policy => `${policy.name || `策略 ${policy.id}`} · ${policy.effect || '未知效果'} / ${policy.action || '未知动作'} · ${policy.enabled === false ? '停用' : '启用'}${policy.description ? `\n  ${policy.description}` : ''}`),
                ...array(result.exemptions).map(exemption => `豁免：${exemption.policy_name || '所有策略'} · ${exemption.status || '有效'} · ${exemption.ends_at ? `到期 ${formatTime(exemption.ends_at)}` : '无到期时间'}`),
              ].join('\n'));
            }
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
      id: 'admin-policy-hits', label: '命中记录', description: '搜索成员或策略、按客户端/决策/时间范围查看最近命中记录。最多显示最近 100 条。',
      async load(api) {
        const filters = runtime.policyHitFilters || { range: '24h' };
        runtime.policyHitFilters = filters;
        const rangeHours = { '24h': 24, '7d': 168, '30d': 720 }[filters.range];
        const query = { limit: 100, ...(filters.q ? { q: filters.q } : {}), ...(filters.request_source ? { request_source: filters.request_source } : {}), ...(filters.decision ? { decision: filters.decision } : {}), ...(rangeHours ? { from: new Date(Date.now() - rangeHours * 3600000).toISOString() } : {}) };
        const [data, clientData] = await Promise.all([
          api('/api/admin/policy-hits', { query }),
          api('/api/admin/policy-clients', { query: { range: '7d' } }).catch(() => ({ items: [] })),
        ]);
        const items = array(data.items);
        const clients = array(clientData.items);
        const rows = items.map(item => ({ label: display(`#${item.id}`, item.policy_name || (item.reason === 'member_suspended' ? '成员暂停' : `策略 ${item.policy_id}`), item.username || `用户 ${item.user_id || '未知'}`, item.request_source || '未知客户端', item.requested_model || '未知模型'), detail: display(`时间：${formatTime(item.created_at)}`, `IP：${item.ip || '未知'}`, `动作：${item.action || '未知'} · 结果：${item.decision === 'block' ? '拦截' : '放行'}`, item.reason && `原因：${item.reason}`), run: async ctx => {
          const choice = await ctx.choose(`策略命中 · #${item.id}`, [{ label: '查看详情', value: 'detail' }]);
          if (choice === 'detail') {
            const details = [`命中编号：${item.id}`, `时间：${formatTime(item.created_at)}`, `成员：${item.username || item.user_id || '未知'}`, `策略：${item.policy_name || (item.reason === 'member_suspended' ? '成员暂停' : item.policy_id || '未知')}`, `客户端：${item.request_source || '未知'}`, `模型：${item.requested_model || '未知'}`, `IP 地址：${item.ip || '未知'}`, `执行动作：${item.action || '未知'}`, `决策结果：${item.decision === 'block' ? '拦截' : item.decision === 'allow' ? '放行' : item.decision || '未知'}`, `原因：${item.reason || '未提供'}`].join('\\n');
            await ctx.show(`策略命中详情 · #${item.id}`, details);
          }
        } }));
        return { pageToolbar: true, sections: [{ title: '策略命中记录', description: `第 ${data.page || page} 页 · 共 ${data.total || items.length} 条`, rows: rows.length ? rows : [{ label: '没有匹配的策略命中记录。' }] }], actions: [
          { label: `搜索成员或策略${filters.q ? `：${filters.q}` : ''}`, toolbar: 'page', run: async ctx => { const value = await ctx.ask('搜索成员用户名或策略名称', { defaultValue: filters.q || '' }); if (value === null) return; runtime.policyHitFilters = { ...runtime.policyHitFilters, q: String(value).trim() }; await ctx.refresh(); } },
          { label: '筛选客户端', toolbar: 'page', run: async ctx => { const value = await ctx.choose('客户端', [{ label: '全部客户端', value: '' }, ...clients.map(item => ({ label: item.label || item.request_source, value: item.request_source }))]); if (value !== null) { runtime.policyHitFilters = { ...runtime.policyHitFilters, request_source: value }; await ctx.refresh(); } } },
          { label: '筛选拦截/放行', toolbar: 'page', run: async ctx => { const value = await ctx.choose('命中结果', [{ label: '全部结果', value: '' }, { label: '拦截', value: 'block' }, { label: '放行/观察', value: 'allow' }]); if (value !== null) { runtime.policyHitFilters = { ...runtime.policyHitFilters, decision: value }; await ctx.refresh(); } } },
          { label: '筛选时间范围', toolbar: 'page', run: async ctx => { const value = await ctx.choose('时间范围', [{ label: '最近 24 小时', value: '24h' }, { label: '最近 7 天', value: '7d' }, { label: '最近 30 天', value: '30d' }, { label: '全部', value: 'all' }]); if (value !== null) { runtime.policyHitFilters = { ...runtime.policyHitFilters, range: value }; await ctx.refresh(); } } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ] };
      },
    }),
    adminOnly({
      id: 'admin-policy-exceptions', label: '策略例外与申诉', description: '查看并撤销策略豁免，审核成员策略申诉。批准申诉将自动创建 24 小时豁免。',
      async load(api) {
        const [exemptions, appeals] = await Promise.all([
          api('/api/admin/policy-exemptions', { query: { limit: 100 } }),
          api('/api/admin/policy-appeals', { query: { limit: 100 } }),
        ]);
        const exceptionRows = array(exemptions.items).map(item => ({ label: display(`#${item.id}`, item.policy_name || (item.policy_id ? `策略 ${item.policy_id}` : '所有策略'), item.username || `${item.subject_type} ${item.subject_id}`, item.status), detail: display(`原因：${item.reason || '未填写'}`, `到期：${item.ends_at ? formatTime(item.ends_at) : '不自动到期'}`, `已用/上限：${item.used_count || 0}/${item.max_uses || '不限'}`, `创建：${formatTime(item.created_at)}`), run: async ctx => {
          if (item.status !== 'active') { await ctx.show(`豁免详情 · #${item.id}`, `状态：${item.status}\\n主体：${item.username || `${item.subject_type} ${item.subject_id}`}\\n原因：${item.reason || '未填写'}\\n到期：${item.ends_at ? formatTime(item.ends_at) : '不自动到期'}`); return; }
          if (!await ctx.confirm('撤销策略豁免', `撤销 #${item.id}？主体将恢复接受相关策略检查。\\n${item.username || `${item.subject_type} ${item.subject_id}`} · ${item.policy_name || '所有策略'}`)) return;
          await api(`/api/admin/policy-exemptions/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); ctx.notify('策略豁免已撤销。'); await ctx.refresh();
        } }));
        const appealRows = array(appeals.items).map(item => ({ label: display(`#${item.id}`, item.username || `用户 ${item.user_id}`, item.policy_name || `策略 ${item.policy_id || '未指定'}`, item.status), detail: display(`申诉原因：${item.reason || '未填写'}`, item.hit_reason && `命中原因：${item.hit_reason}`, item.hit_action && `命中动作：${item.hit_action}`, `提交时间：${formatTime(item.created_at)}`), run: async ctx => {
          const choice = await ctx.choose(`策略申诉 · #${item.id}`, [{ label: '查看详情', value: 'detail' }, ...(item.status === 'pending' ? [{ label: '批准并创建 24 小时豁免', value: 'approve' }, { label: '驳回申诉', value: 'reject' }] : [])]);
          if (choice === 'detail') { await ctx.show(`申诉详情 · #${item.id}`, [`成员：${item.username || `用户 ${item.user_id}`}`, `策略：${item.policy_name || `策略 ${item.policy_id || '未指定'}`}`, `状态：${item.status}`, `申诉原因：${item.reason || '未填写'}`, `命中原因：${item.hit_reason || '无'}`, `处理结果：${item.resolution || '尚未处理'}`, `提交时间：${formatTime(item.created_at)}`, item.resolved_at && `处理时间：${formatTime(item.resolved_at)}`].filter(Boolean).join('\\n')); return; }
          if (!choice) return;
          if (!await ctx.confirm(choice === 'approve' ? '批准申诉并创建豁免' : '驳回申诉', `${item.username || `用户 ${item.user_id}`} · ${item.policy_name || '策略申诉'}\\n${choice === 'approve' ? '网页默认会自动创建 24 小时豁免。' : '驳回后成员仍受原策略约束。'}`)) return;
          await api(`/api/admin/policy-appeals/${encodeURIComponent(item.id)}/decide`, { method: 'POST', body: { decision: choice } });
          ctx.notify(choice === 'approve' ? '申诉已批准并创建限期豁免。' : '申诉已驳回。'); await ctx.refresh();
        } }));
        return { pageToolbar: true, sections: [
          { title: '策略例外', description: `${exceptionRows.length} 条 · 网页列表最多显示最近 100 条`, rows: exceptionRows.length ? exceptionRows : [{ label: '暂无策略豁免。' }] },
          { title: '成员申诉', description: `${appealRows.length} 条 · 网页列表最多显示最近 100 条`, rows: appealRows.length ? appealRows : [{ label: '暂无成员申诉。' }] },
        ], actions: [
          { label: '创建策略豁免', toolbar: 'page', run: async ctx => {
            const values = await ctx.form('创建策略豁免', [
              { name: 'subject_type', label: '主体类型', value: 'user', options: [{ label: '成员', value: 'user' }, { label: 'Team', value: 'team' }, { label: 'API Key', value: 'api_key' }] },
              { name: 'subject_id', label: '主体编号（必填）' },
              { name: 'policy_id', label: '策略编号（留空表示所有策略）' },
              { name: 'hours', label: '有效小时数（留空表示永久）' },
              { name: 'max_uses', label: '最大使用次数（留空表示不限）' },
              { name: 'reason', label: '豁免原因' },
            ]);
            if (!values || !String(values.subject_id || '').trim()) return;
            const subjectId = Number(values.subject_id);
            const hours = values.hours ? Number(values.hours) : null;
            const maxUses = values.max_uses ? Number(values.max_uses) : null;
            if (!Number.isInteger(subjectId) || subjectId < 1 || hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 87600) || maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) { await ctx.show('豁免参数无效', '主体编号须为正整数；时长须为 1 到 87600 小时；使用次数须为正整数。'); return; }
            const subjectLabel = { user: '成员', team: 'Team', api_key: 'API Key' }[values.subject_type];
            const policyId = values.policy_id ? Number(values.policy_id) : null;
            if (policyId !== null && (!Number.isInteger(policyId) || policyId < 1)) { await ctx.show('策略编号无效', '策略编号须为正整数，留空表示豁免所有策略。'); return; }
            if (!await ctx.confirm('确认创建策略豁免', `${subjectLabel} #${subjectId}\n策略编号：${policyId || '所有策略'}\n时长：${hours ? `${hours} 小时` : '永久'}\n最大使用次数：${maxUses || '不限'}\n原因：${values.reason || '未填写'}\n豁免生效期间将绕过匹配策略。`)) return;
            const body = { subject_type: values.subject_type, subject_id: subjectId, policy_id: policyId, ends_at: hours ? new Date(Date.now() + hours * 3600000).toISOString() : null, max_uses: maxUses, reason: values.reason || '' };
            await api('/api/admin/policy-exemptions', { method: 'POST', body });
            ctx.notify('策略豁免已创建。'); await ctx.refresh();
          } },
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
          { title: '7 日策略分析', cards: [
            { label: '命中总数', value: Number(analytics.totals?.hits || 0) }, { label: '拦截数', value: Number(analytics.totals?.blocked || 0) },
            { label: '涉及成员', value: Number(analytics.totals?.members || 0) }, { label: '平均评估耗时', value: `${Math.round(Number(analytics.totals?.avg_eval_ms || 0))} 毫秒` },
          ], rows: array(analytics.rows).slice(0, 10).map(item => ({ label: display(item.policy_name || item.group || '未知分组', `${Number(item.hits || 0)} 次命中`), detail: `${Number(item.blocked || 0)} 次拦截 · 涉及 ${Number(item.members || 0)} 位成员` })) },
          { title: '通知渠道', rows: channels.length ? channels.map(channel => ({ label: display(channel.name, channel.type, channel.min_severity, channel.enabled ? '启用' : '停用'), run: async ctx => {
            const choice = await ctx.choose(`通知渠道 · ${channel.name}`, [{ label: '查看详情', value: 'detail' }, { label: '测试渠道（会发送外部通知）', value: 'test' }, { label: '删除渠道', value: 'delete' }]);
            if (choice === 'detail') await ctx.show(`通知渠道 · ${channel.name}`, [`名称：${channel.name}`, `类型：${channel.type}`, `最低告警级别：${channel.min_severity || 'warning'}`, `状态：${channel.enabled ? '启用' : '停用'}`, `Secret：${channel.has_secret ? '已配置（不显示密钥）' : '未配置'}`, `配置键：${Object.keys(channel.config || {}).filter(key => !/secret|token|key/i.test(key)).join('、') || '无非敏感配置'}`, `创建时间：${formatTime(channel.created_at)}`, `更新时间：${formatTime(channel.updated_at)}`].join('\n'));
            if (choice === 'test') { if (!await ctx.confirm('发送测试通知', `将向已配置的 ${channel.type} 目标发送测试通知。继续？`)) return; const result = await api(`/api/admin/policy-channels/${channel.id}/test`, { method: 'POST', body: {} }); await ctx.show('渠道测试结果', [`结果：${result.success === false || result.ok === false ? '失败' : '完成'}`, result.status && `状态：${result.status}`, result.message && `说明：${result.message}`, result.error && `错误：${String(result.error).replace(/\s+/g, ' ').slice(0, 300)}`].filter(Boolean).join('\n') || '测试请求已完成。'); }
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
            { label: `作用范围：${runtime.client.isAdmin ? '全局' : `团队 #${team.team_id || '未知'}`}` },
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
            if (!await ctx.confirm('保存策略设置', `范围：${body.team_id === null ? '全局' : `团队 #${body.team_id}`}\n执行 ${body.enforcement_mode} · 失败 ${body.fail_mode}\n白名单维度：${allowlist_dimensions.join(', ') || '无'}\n注意：未匹配 allow 的请求可能被拦截。`)) return;
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
        return { sections: [{ title: '审批中心', description: `${items.length} 条 · ${runtime.approvalStatus || '全部状态'}`, rows: items.map(item => ({ label: display(item.kind === 'request' ? '运行时放行' : '策略变更', item.policy_name || item.policy_id, item.requested_by_name, item.status), detail: display(item.preview?.model && `模型：${item.preview.model}`, item.preview?.provider && `供应商：${item.preview.provider}`, item.preview?.reason && `原因：${item.preview.reason}`, item.preview?.action && `请求动作：${item.preview.action}`, formatTime(item.created_at)), run: async ctx => {
          const decision = await ctx.choose(`审批 · #${item.id}`, [{ label: '查看详情', value: 'detail' }, ...(item.status === 'pending' ? [{ label: '通过', value: 'approve' }, { label: '驳回', value: 'reject' }] : [])]);
          const preview = item.preview || {};
          if (decision === 'detail') { await ctx.show(`审批详情 · #${item.id}`, [
            `审批编号：${item.id}`, `申请类型：${item.kind === 'request' ? '运行时访问申请' : '策略变更申请'}`, `策略：${item.policy_name || `策略 ${item.policy_id || '未指定'}`}`,
            `申请人：${item.requested_by_name || '未知'}`, `状态：${item.status || '未知'}`, `申请时间：${formatTime(item.created_at)}`,
            preview.model && `模型：${preview.model}`, preview.provider && `供应商：${preview.provider}`, preview.reason && `申请原因：${preview.reason}`, preview.action && `请求动作：${preview.action}`,
            preview.team_id && `Team 编号：${preview.team_id}`, preview.user_id && `成员编号：${preview.user_id}`,
          ].filter(Boolean).join('\\n')); return; }
          if (!decision) return;
          if (!await ctx.confirm(decision === 'approve' ? '通过审批' : '驳回审批', `${item.policy_name || item.kind}\n申请人 ${item.requested_by_name || '未知'}\n申请原因：${preview.reason || '未提供'}`)) return;
          await api(`/api/admin/policy-approvals/${item.id}/decide`, { method: 'POST', body: { decision } }); ctx.notify(decision === 'approve' ? '审批已通过。' : '审批已驳回。'); await ctx.refresh();
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
          { title: '策略概览', cards: [
            { label: '策略总数', value: Number(overviewData.policies?.total || 0) }, { label: '已启用', value: Number(overviewData.policies?.enabled || 0) },
            { label: '阻止策略', value: Number(overviewData.policies?.deny || 0) }, { label: '允许策略', value: Number(overviewData.policies?.allow || 0) },
            { label: '近 24 小时命中', value: Number(overviewData.hits?.last_24h || 0) }, { label: '近 24 小时拦截', value: Number(overviewData.hits?.blocked_24h || 0) },
            { label: '待处理审批', value: Number(overviewData.pending?.approvals || 0) }, { label: '待处理申诉', value: Number(overviewData.pending?.appeals || 0) },
          ], rows: [...array(overviewData.top_policies).map(item => ({ label: `高频策略：${item.policy_name || `策略 ${item.policy_id}`}`, detail: `近 24 小时 ${Number(item.hits || 0)} 次命中` })), ...array(overviewData.top_clients).map(item => ({ label: `高频客户端：${item.label || item.request_source || '未知'}`, detail: `近 24 小时 ${Number(item.hits || 0)} 次命中` })), ...array(healthData.items?.expiring).map(item => ({ label: `即将到期：${item.name || `策略 ${item.id}`}`, detail: `到期：${formatTime(item.ends_at)}` })), ...array(healthData.items?.zero_hits).map(item => ({ label: `近 30 天无命中：${item.name || `策略 ${item.id}`}`, detail: `${item.scope_type || '未知作用域'} · ${item.enabled ? '已启用' : '已停用'}` })), ...array(healthData.items?.orphans).map(item => ({ label: `失效作用域：${item.name || `策略 ${item.id}`}`, detail: item.orphan_team ? '关联 Team 不存在' : item.orphan_member ? '关联成员不存在' : '作用域异常' })), ...(overview.status === 'rejected' ? [{ label: `概览暂不可用：${overview.reason.message}` }] : []), ...(health.status === 'rejected' ? [{ label: `策略健康暂不可用：${health.reason.message}` }] : [])] },
          { title: '策略列表', description: `第 ${result.page || runtime.adminPolicyPage || 1} 页 · 共 ${result.total || 0} 条`, rows: items.map(item => ({ label: display(item.name, item.scope_type, item.effect, item.action, item.enabled ? '启用' : '停用'), detail: display(item.description, `优先级 ${item.priority}`, `24小时命中 ${item.hits_24h || 0}`), run: async ctx => { const detail = await api(`/api/admin/policies/${item.id}`); const policy = detail.policy || detail; await ctx.show(`策略详情 · ${item.name}`, [`策略名称：${policy.name || item.name}`, `说明：${policy.description || '无'}`, `作用域：${policy.scope_type || item.scope_type}${policy.scope_id ? ` · 对象编号 ${policy.scope_id}` : ''}`, `效果与动作：${policy.effect || item.effect || '未知'} / ${policy.action || item.action || '未知'}`, `状态：${policy.status || '未知'} · ${policy.enabled === false ? '已停用' : '已启用'}`, `优先级：${policy.priority ?? '未设置'}`, `近 24 小时命中：${policy.hits_24h ?? item.hits_24h ?? 0} 次`, `条件摘要：${Object.entries(policy.conditions || {}).map(([key, value]) => `${key.replace(/_/g, ' ')}：${Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join('；') || '无额外条件'}`, policy.starts_at && `开始时间：${formatTime(policy.starts_at)}`, policy.ends_at && `结束时间：${formatTime(policy.ends_at)}`, policy.message_template && `命中提示：${policy.message_template}`].filter(Boolean).join('\n')); } })) },
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
        const policyName = item => item.name || item.policy_name || item.action || `策略 ${item.id || ''}`;
        const effectLabel = value => ({ deny: '阻止', allow: '允许', shadow: '观察' })[value] || value || '未设置';
        const actionLabel = value => ({ block: '拦截请求', warn: '警告', shadow: '仅记录', throttle: '限速', queue: '排队', downgrade: '降级', suspend: '暂停账号', notify: '发送通知' })[value] || value || '未设置';
        const policyClientLabel = value => ({ claude_code: 'Claude Code', codex: 'Codex', grok: 'Grok', opencode: 'OpenCode', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw', deepseek_harness: 'DeepSeek Harness', unknown: '未知/其他' })[value] || value || '未知客户端';
        const exemptionRows = array(mine.exemptions).map(item => ({ label: policyName(item), cells: { policy: item.policy_id ? policyName(item) : '全部策略', reason: item.reason || '—', expires: item.ends_at ? formatTime(item.ends_at) : '永久', uses: `${Number(item.used_count || 0)}${item.max_uses ? ` / ${item.max_uses}` : ' / 不限'}` } }));
        const blockRows = array(data['最近拦截']).map(item => ({ label: formatTime(item.created_at), cells: { time: formatTime(item.created_at), policy: policyName(item), client: policyClientLabel(item.request_source), model: item.requested_model || '未知模型', reason: item.reason || '未提供原因', action: 'Enter 申诉' }, run: async ctx => { const policyId = item.policy_id ? Number(item.policy_id) : null; const values = await ctx.form('提交策略申诉', [{ name: 'reason', label: '申诉原因' }], { description: `拦截记录 #${item.id}${policyId ? ` · ${policyId}` : ''}。每个策略 24 小时内仅允许一个待处理申诉。` }); if (!values || !String(values.reason || '').trim()) return; if (!await ctx.confirm('提交策略申诉', `${policyName(item)}\n${String(values.reason).trim()}`)) return; await api('/api/user/policy-appeals', { method: 'POST', body: { hit_id: Number(item.id), ...(policyId ? { policy_id: policyId } : {}), reason: String(values.reason).trim() } }); ctx.notify('策略申诉已提交。'); await ctx.refresh(); } }));
        const appealStatus = value => ({ pending: '处理中', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' })[value] || value || '未知状态';
        const appealRows = array(data['我的申诉']).map(item => ({ label: formatTime(item.created_at), cells: { time: formatTime(item.created_at), policy: item.policy_name || (item.policy_id ? `策略 ${item.policy_id}` : '全部策略'), reason: item.reason || '无', status: appealStatus(item.status), resolution: item.resolution || '尚未处理' } }));
        const policyRows = array(mine.policies).map(item => ({ label: `${policyName(item)} · ${effectLabel(item.effect)} / ${actionLabel(item.action)}`, detail: `作用范围：${({ global: '全局', team: '团队', member: '个人' })[item.scope_type] || item.scope_type || '未知'} · 分类：${item.category || '未分类'} · 优先级：${Number(item.priority || 0)}\n生效时间：${item.starts_at ? formatTime(item.starts_at) : '立即'} 至 ${item.ends_at ? formatTime(item.ends_at) : '长期'}\n策略说明：${item.description || '无'}${item.conditions ? `\n触发条件：${Object.entries(item.conditions).map(([key, value]) => `${key.replace(/_/g, ' ')} ${Array.isArray(value) ? value.join('、') : value}`).join('；')}` : ''}` }));
        const suspension = mine.suspension || {};
        const bypass = mine.bypass === true;
        const blocks = array(data['最近拦截']);
        const sections = [
          { title: '策略状态', cards: [
            { label: '账号状态', value: suspension.suspended ? '已暂停' : '正常', detail: suspension.suspended ? (suspension.reason || '请联系管理员') : '可正常使用' },
            { label: '生效策略', value: `${array(mine.policies).length} 条`, detail: `执行模式：${({ enforce: '强制执行', shadow: '仅观察' })[mine.settings?.enforcement_mode] || mine.settings?.enforcement_mode || '未知'}` },
            { label: '临时豁免', value: `${array(mine.exemptions).length} 条`, detail: bypass ? `账号豁免已开启${mine.bypass_until ? ` · 截止 ${formatTime(mine.bypass_until)}` : ''}` : '账号级豁免未开启' },
            { label: '最近拦截', value: `${blocks.length} 条`, detail: '当前列表最多显示 50 条' },
          ], rows: suspension.suspended ? [{ label: `暂停原因：${suspension.reason || '请联系管理员'}`, detail: `暂停范围：${({ all: '全部请求', api: 'API 请求' })[suspension.scope] || suspension.scope || '未说明'} · ${suspension.until ? `截止 ${formatTime(suspension.until)}` : '未设置恢复时间'}` }] : [] },
          { title: '我的生效策略', description: `${policyRows.length} 条适用于你的策略 · 允许名单维度：${array(mine.settings?.allowlist_dimensions).join('、') || '无'}`, tableMinWidth: 110, columns: [{ key: 'policy', label: '名称', ratio: 0.2 }, { key: 'scope', label: '作用域', ratio: 0.12 }, { key: 'effect', label: '效果', ratio: 0.11 }, { key: 'action', label: '动作', ratio: 0.16 }, { key: 'category', label: '分类', ratio: 0.12 }, { key: 'validity', label: '有效期', ratio: 0.29 }], rows: policyRows.length ? policyRows.map(row => { const item = mine.policies.find(policy => `${policyName(policy)} · ${effectLabel(policy.effect)} / ${actionLabel(policy.action)}` === row.label) || {}; return { ...row, cells: { policy: policyName(item), scope: ({ global: '全局', team: '团队', member: '个人' })[item.scope_type] || item.scope_type || '未知', effect: effectLabel(item.effect), action: actionLabel(item.action), category: item.category || '未分类', validity: `${item.starts_at ? formatTime(item.starts_at) : '立即'} 至 ${item.ends_at ? formatTime(item.ends_at) : '长期'}` } }; }) : [{ label: '当前没有适用于你的策略。' }] },
          { title: '临时豁免', tableMinWidth: 100, columns: [{ key: 'policy', label: '策略', ratio: 0.22 }, { key: 'reason', label: '原因', ratio: 0.38 }, { key: 'expires', label: '到期', ratio: 0.22 }, { key: 'uses', label: '次数', ratio: 0.18 }], rows: exemptionRows.length ? exemptionRows : [{ label: bypass ? '账号级临时豁免已开启，当前没有单独的策略豁免记录。' : '当前没有临时豁免。' }] },
          { title: '最近拦截', description: '仅显示触发阻止动作的请求记录。选择记录可以提交针对该拦截的申诉。', tableMinWidth: 112, columns: [{ key: 'time', label: '时间', ratio: 0.18 }, { key: 'policy', label: '策略', ratio: 0.16 }, { key: 'client', label: '客户端', ratio: 0.13 }, { key: 'model', label: '模型', ratio: 0.15 }, { key: 'reason', label: '原因', ratio: 0.25 }, { key: 'action', label: '操作', ratio: 0.13 }], rows: blockRows.length ? blockRows : [{ label: '暂无拦截记录。' }] },
          { title: '我的申诉', tableMinWidth: 110, columns: [{ key: 'time', label: '时间', ratio: 0.18 }, { key: 'policy', label: '策略', ratio: 0.18 }, { key: 'reason', label: '原因', ratio: 0.3 }, { key: 'status', label: '状态', ratio: 0.14 }, { key: 'resolution', label: '处理结果', ratio: 0.2 }], rows: appealRows.length ? appealRows : [{ label: '暂无策略申诉。' }] },
          ...(isAdmin ? [
            { title: '管理概览', rows: ['策略概览', '策略健康'].map(name => ({ label: `${name}：${data[name] ? JSON.stringify(data[name]) : '暂不可用'}` })) },
            { title: '策略管理', description: `第 ${adminList.page || policyPage} 页 · 共 ${adminList.total || 0} 条`, rows: policyItems.map(item => ({ label: display(item.name, item.scope_type, item.effect, item.action, item.enabled ? '启用' : '停用'), detail: display(item.description, `优先级 ${item.priority}`, `近24小时 ${item.hits_24h || 0} 次命中`) })) },
          ] : []),
        ];
        const actions = [
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
