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
    if (runtime.client.isAdmin === false) {
      return { sections: [{ title: page.label, rows: [{ label: '此管理页面仅对管理员开放。' }] }], actions: [] };
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
    collectionPage({ id: 'projects', label: '项目工作', description: '项目活动与工作区概览。', path: '/api/user/project-stats', pick: payload => array(payload && payload.projects),
      map: { label: item => display(item.workspace_path, item.project, item.name, item.id), detail: item => display(item.requests && `${item.requests} 请求`, item.tokens && `${item.tokens} tokens`, item.cost && `费用 ${item.cost}`, item.last_activity && formatTime(item.last_activity)) } }),
    collectionPage({ id: 'leaderboard', label: '排行榜', description: '公开排行榜。', path: '/api/user/leaderboard', pick: payload => array(payload && payload.leaderboard),
      map: { label: item => display(item.rank && `#${item.rank}`, item.username, item.totalPoints !== undefined && `${item.totalPoints} 积分`), detail: item => display(item.totalRequests && `${item.totalRequests} 请求`, item.totalTokens && `${item.totalTokens} tokens`, item.balance && `余额 ${item.balance}`) } }),
    collectionPage({ id: 'audit-logs', label: '操作日志', description: '当前账号可访问的操作记录。', path: '/api/user/audit-logs', pick: itemsOf,
      map: { label: item => display(formatTime(item.created_at || item.timestamp), item.action || item.event), detail: item => display(item.description, item.resource_type, item.ip_address) } }),
    adminOnly(collectionPage({ id: 'admin-users', label: '用户管理', description: '管理员用户视图。', path: '/api/admin/users', pick: itemsOf,
      map: { label: item => display(item.username, item.email, item.status), detail: item => display(item.role, item.team_name, item.id) } })),

    adminOnly(collectionPage({ id: 'admin-error-logs', label: '调用错误', description: '管理员调用错误记录。', path: '/api/admin/error-logs', pick: payload => array(payload && payload.logs),
      map: { label: item => display(formatTime(item.created_at), item.model_name || item.model_id, item.status_code), detail: item => display(item.error_message, item.provider_name, item.username, item.latency_ms && `${item.latency_ms} ms`) } })),

    adminOnly(collectionPage({ id: 'admin-prompts', label: '提示词', description: '管理员提示词列表。', path: '/api/admin/custom-instructions', pick: payload => array(payload && payload.items),
      map: { label: item => display(item.file, item.source), detail: item => display(item.occurrence_count && `${item.occurrence_count} 次`, item.last_seen && formatTime(item.last_seen), item.fingerprint) } })),
    adminOnly(collectionPage({ id: 'admin-plugins', label: '插件管理', description: '插件管理由 CrewRouter 插件系统托管；此页列出服务端可见插件。', path: '/api/admin/plugins', pick: itemsOf,
      map: { label: item => display(item.name, item.id, item.version), detail: item => display(item.enabled === false ? '停用' : '启用', item.description) } })),

    adminOnly(collectionPage({ id: 'admin-audit-logs', label: '管理员操作日志', description: '系统级管理员操作记录。', path: '/api/admin/audit-logs', pick: payload => itemsOf(payload),
      map: { label: item => display(formatTime(item.created_at), item.action, item.username), detail: item => display(item.description, item.resource_type, item.ip_address) } })),
    adminOnly(collectionPage({ id: 'admin-model-library', label: '模型库管理', description: '管理员模型目录。', path: '/api/admin/models', pick: itemsOf,
      map: { label: item => display(item.name, item.alias, item.id), detail: item => display(item.provider_name, item.enabled === false ? '停用' : '启用', item.description) } })),
    adminOnly(collectionPage({ id: 'admin-teams', label: '团队管理', description: '管理员团队视图。', path: '/api/admin/teams', pick: itemsOf,
      map: { label: item => display(item.name, item.id, item.is_default && '默认'), detail: item => display(item.member_count && `${item.member_count} 成员`, item.description) } })),
    collectionPage({ id: 'blora-agent', label: 'Blora Agent', description: 'Agent 管理会话；管理员可查看线程与运行状态。', path: '/api/agent/manage/threads', pick: itemsOf,
      map: { label: item => display(item.title, item.name, item.id, item.status), detail: item => display(item.model, item.updatedAt || item.updated_at, item.summary) } }),
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
      id: 'settings', label: '用户设置', description: '当前账号的设置状态。',
      async load(api) {
        const [me, balance, providers] = await Promise.allSettled([
          api('/auth/me'), api('/api/user/balance'), api('/api/user/my-providers'),
        ]);
        const results = [['账户', me], ['余额', balance], ['我的上游', providers]];
        return { sections: results.map(([label, result]) => ({ title: label, rows: [{ label: result.status === 'fulfilled' ? JSON.stringify(result.value) : (result.reason.message || '暂不可用') }] })), actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    },
    adminOnly({
      id: 'admin-settings', label: '系统设置', description: '管理员系统配置只读视图。',
      async load(api) {
        const data = await api('/api/admin/settings');
        return { sections: [{ title: '系统设置', rows: Object.entries(data || {}).map(([key, value]) => ({ label: `${key}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}` })) }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
    adminOnly({
      id: 'admin-policies', label: '安全与策略', description: '策略状态与健康信息。',
      async load(api) {
        const [overview, health] = await Promise.allSettled([api('/api/admin/policies/overview'), api('/api/admin/policies/health')]);
        const rows = [];
        for (const [name, result] of [['概览', overview], ['健康状态', health]]) {
          if (result.status === 'fulfilled') rows.push({ label: `${name}：${JSON.stringify(result.value)}` });
          else rows.push({ label: `${name}：${result.reason.message || '读取失败'}` });
        }
        return { sections: [{ title: '安全与策略', rows }], actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
      },
    }),
  ];
}

module.exports = { createAdminPages };
