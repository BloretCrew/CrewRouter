'use strict';

const {
  listProviders, pingProvider, toggleProvider, listModels, testModel,
  listApiKeys, createApiKey, toggleApiKey, renameApiKey, deleteApiKey, getApiKeyConfig,
} = require('../lib/api');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');
const { text, enabledLabel } = require('./pages-common');

function providerDetail(provider) {
  return {
    id: provider.id,
    name: provider.name,
    format: provider.format,
    base_url: provider.base_url,
    enabled: provider.enabled,
    has_api_key: provider.has_api_key,
    api_key_count: provider.api_key_count,
    endpoint_count: provider.endpoint_count,
    created_by: provider.created_by,
    tags: provider.tags,
  };
}

function providersPage(runtime) {
  return {
    id: 'providers',
    label: '供应商',
    description: '查看供应商状态，检测连通性；管理员可启停。',
    async load(api) {
      const data = await listProviders(runtime.client);
      const stats = data.stats || {};
      const query = String(runtime.providerSearch || '').toLowerCase();
      const scope = runtime.providerScope || 'all';
      const enabledFilter = runtime.providerEnabled || 'all';
      const visibleItems = data.items.filter(item => {
        const matchQuery = !query || [item.name, item.id, item.base_url, item.format].some(value => String(value || '').toLowerCase().includes(query));
        const matchScope = scope === 'all' || (scope === 'global' ? item.created_by == null : item.created_by != null);
        const matchEnabled = enabledFilter === 'all' || (enabledFilter === 'enabled' ? item.enabled !== false : item.enabled === false);
        return matchQuery && matchScope && matchEnabled;
      });
      const rows = visibleItems.map(item => ({
        label: `${item.name || item.id} · ${item.format || 'unknown'} · ${enabledLabel(item.enabled)}${item.has_api_key === true ? ' · Key 已配置' : ''}`,
        detail: `${item.id}${item.base_url ? ` · ${item.base_url}` : ''}${Array.isArray(item.tags) && item.tags.length ? ` · 标签 ${item.tags.map(tag => tag.name).join('/')}` : ''}`,
        run: async ctx => {
          const actions = [
            { label: '查看详情', value: 'detail' },
            { label: '检测连通性', value: 'ping' },
            ...(data.scope === 'admin' ? [{ label: item.enabled === false ? '启用供应商' : '停用供应商', value: 'toggle' }] : []),
          ];
          const choice = await ctx.choose('供应商操作', actions, { description: `${item.name || item.id}\n${item.base_url || ''}`.trim() });
          if (choice === 'detail') await ctx.show(`供应商 · ${item.name || item.id}`, JSON.stringify(providerDetail(item), null, 2));
          else if (choice === 'ping') {
            ctx.notify('正在检测连通性…');
            const result = await pingProvider(runtime.client, item.id);
            await ctx.show('连通性检测', result && result.ok
              ? `成功 · ${result.latency_ms !== null && result.latency_ms !== undefined ? `${result.latency_ms} ms` : ''}${result.note ? `\n${result.note}` : ''}`
              : `失败：${result && result.error ? result.error : '未知错误'}`);
          } else if (choice === 'toggle') {
            const enabled = item.enabled === false;
            if (!await ctx.confirm(enabled ? '启用供应商' : '停用供应商', `${item.name || item.id}\n停用后相关模型可能不可用。`)) return;
            await toggleProvider(runtime.client, item.id, enabled);
            ctx.notify(`供应商已${enabled ? '启用' : '停用'}。`);
            await ctx.refresh();
          }
        },
      }));
      return {
        sections: [{
          title: '供应商',
          description: `${data.scope === 'admin' ? '管理员视图，包含全局与用户供应商。' : '当前账号可见的供应商。'} · ${visibleItems.length}/${data.total} 项${query ? ` · 搜索 ${query}` : ''}`,
          cards: data.scope === 'admin' ? [
            { label: '总数', value: text(stats.total, data.total), detail: '全部供应商' },
            { label: '启用', value: text(stats.enabledCount), detail: '当前启用' },
            { label: '全局', value: text(stats.globalCount), detail: '管理员创建' },
            { label: '用户', value: text(stats.userCount), detail: '用户创建' },
          ] : [{ label: '可见', value: data.total, detail: '当前账号' }],
          rows: rows.length ? rows : [{ label: '暂无供应商。' }],
        }],
        actions: [
          { label: '搜索供应商', run: async ctx => { runtime.providerSearch = String(await ctx.ask('供应商名称、ID 或地址', { defaultValue: runtime.providerSearch || '' }) || '').trim(); await ctx.refresh(); } },
          ...(data.scope === 'admin' ? [
            ...[['all', '全部供应商'], ['global', '全局供应商'], ['user', '用户供应商']].map(([value, label]) => ({ label, run: async ctx => { runtime.providerScope = value; await ctx.refresh(); } })),
            ...[['all', '全部状态'], ['enabled', '仅启用'], ['disabled', '仅停用']].map(([value, label]) => ({ label, run: async ctx => { runtime.providerEnabled = value; await ctx.refresh(); } })),
          ] : []),
          { label: '清除筛选', run: async ctx => { runtime.providerSearch = ''; runtime.providerScope = 'all'; runtime.providerEnabled = 'all'; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

function modelsPage(runtime) {
  if (runtime.modelSearch === undefined) runtime.modelSearch = '';
  if (runtime.modelPage === undefined) runtime.modelPage = 1;
  return {
    id: 'models',
    label: '模型',
    description: '浏览模型、测试连通性并切换当前模型。',
    async load(api) {
      const data = await listModels(runtime.client, { search: runtime.modelSearch, page: runtime.modelPage, limit: 100 });
      const rows = data.items.map(item => ({
        label: `${item.name || item.alias || item.id} · ${item.provider_name || item.provider || '未知供应商'} · ${enabledLabel(item.enabled)}`,
        detail: `${item.id} · 输入 ${Number(item.input_price_per_1k_tokens || item.input_price || 0).toFixed(4)} / 1K · 输出 ${Number(item.output_price_per_1k_tokens || item.output_price || 0).toFixed(4)} / 1K`,
        run: async ctx => {
          const actions = [
            { label: '查看详情', value: 'detail' },
            { label: '测试模型', value: 'test' },
            { label: '设为当前模型', value: 'current' },
          ];
          const choice = await ctx.choose('模型操作', actions, { description: `${item.name || item.id}\n${item.provider_name || item.provider || ''}`.trim() });
          if (choice === 'detail') await ctx.show(`模型 · ${item.name || item.id}`, JSON.stringify(item, null, 2));
          else if (choice === 'test') {
            ctx.notify('正在测试模型…');
            const result = await testModel(runtime.client, item.id);
            await ctx.show('模型测试', result && result.ok ? `通过 · ${result.latency_ms || 0} ms` : `失败：${result && result.error ? result.error : '未知错误'}`);
          } else if (choice === 'current') {
            if (!await ctx.confirm('设为当前模型', `将当前 API Key 的默认模型切换为 ${item.name || item.id}。`)) return;
            await runtime.client.put('/api/user/current-model', { modelId: item.id });
            ctx.notify('当前模型已更新。');
            await ctx.refresh();
          }
        },
      }));
      return {
        sections: [{
          title: '模型',
          description: `来源：${data.scope === 'admin' ? '管理员全量' : '当前 Team 可见'}${runtime.modelSearch ? ` · 搜索：${runtime.modelSearch}` : ''} · 第 ${data.page || runtime.modelPage} 页`,
          cards: [
            { label: '总数', value: data.total, detail: '匹配结果' },
            { label: '显示', value: rows.length, detail: '本页' },
            ...(data.stats ? [{ label: '启用', value: text(data.stats.enabledCount), detail: '管理员统计' }] : []),
          ],
          rows: rows.length ? rows : [{ label: '暂无模型。' }],
        }],
        actions: [
          { label: '搜索模型', run: async ctx => { const value = await ctx.ask('模型搜索关键词', { description: '按 ID、名称、供应商或上游模型筛选。' }); if (value !== null) { runtime.modelSearch = String(value).trim(); runtime.modelPage = 1; await ctx.refresh(); } } },
          { label: '清除搜索', run: async ctx => { runtime.modelSearch = ''; runtime.modelPage = 1; await ctx.refresh(); } },
          { label: '上一页', run: async ctx => { runtime.modelPage = Math.max(1, runtime.modelPage - 1); await ctx.refresh(); } },
          { label: '下一页', run: async ctx => { runtime.modelPage += 1; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

function keysPage(runtime) {
  return {
    id: 'keys',
    label: 'API Key',
    description: '管理 API Key；原始 Key 只在创建时显示一次。',
    async load(api) {
      const keys = await listApiKeys(runtime.client);
      const rows = keys.map(key => ({
        label: `${key.name || '未命名'} · ${key.key_prefix || ''} · ${enabledLabel(key.enabled)} · ${key.current_model_name || key.current_model_id || '未绑定模型'}`,
        detail: `${Number(key.total_requests || 0).toLocaleString()} 请求 · ${formatBigNumber(key.total_tokens)} tokens · ${formatCost(key.total_cost)} · 最后使用 ${formatTime(key.last_used_at)}`,
        run: async ctx => {
          const actions = [
            { label: '查看详情', value: 'detail' },
            { label: '查看 Claude Code 配置', value: 'config' },
            { label: key.enabled === false ? '启用 Key' : '停用 Key', value: 'toggle' },
            { label: '重命名', value: 'rename' },
            { label: '删除 Key', value: 'delete' },
          ];
          const choice = await ctx.choose('API Key 操作', actions, { description: key.name || key.key_prefix || `Key ${key.id}` });
          if (choice === 'detail') await ctx.show(`API Key · ${key.name || key.id}`, JSON.stringify({
            id: key.id, name: key.name, prefix: key.key_prefix, enabled: key.enabled,
            current_model: key.current_model_name || key.current_model_id, permissions: key.permissions,
            total_requests: key.total_requests, total_tokens: key.total_tokens, total_cost: key.total_cost,
            created_at: key.created_at, last_used_at: key.last_used_at, expires_at: key.expires_at,
          }, null, 2));
          else if (choice === 'config') {
            const config = await getApiKeyConfig(runtime.client, key.id);
            await ctx.show('Claude Code 配置', JSON.stringify(config, null, 2));
          } else if (choice === 'toggle') {
            const enabled = key.enabled === false;
            if (!await ctx.confirm(enabled ? '启用 API Key' : '停用 API Key', `${key.name || key.key_prefix}\n停用后使用该 Key 的客户端将无法调用。`)) return;
            await toggleApiKey(runtime.client, key.id, enabled);
            ctx.notify(`API Key 已${enabled ? '启用' : '停用'}。`);
            await ctx.refresh();
          } else if (choice === 'rename') {
            const name = await ctx.ask('新的 Key 名称', { defaultValue: key.name || '' });
            if (!name) return;
            await renameApiKey(runtime.client, key.id, name);
            ctx.notify('API Key 已重命名。');
            await ctx.refresh();
          } else if (choice === 'delete') {
            if (!await ctx.confirm('删除 API Key', `确认删除「${key.name || key.key_prefix}」？此操作不可恢复。`)) return;
            await deleteApiKey(runtime.client, key.id);
            ctx.notify('API Key 已删除。');
            await ctx.refresh();
          }
        },
      }));
      return {
        sections: [{
          title: 'API Key',
          description: '只能查看自己的 Key；共享 Key 的原始值受权限限制。',
          cards: [
            { label: '总数', value: keys.length, detail: '当前账号可见' },
            { label: '启用', value: keys.filter(key => key.enabled !== false).length, detail: '可用 Key' },
            { label: '停用', value: keys.filter(key => key.enabled === false).length, detail: '不可调用' },
          ],
          rows: rows.length ? rows : [{ label: '暂无 API Key。' }],
        }],
        actions: [
          { label: '新建 API Key', run: async ctx => {
            const values = await ctx.form('新建 API Key', [
              { name: 'name', label: '名称', value: 'CrewRouter CLI' },
              { name: 'expiresIn', label: '有效小时数（留空永久）', value: '' },
              { name: 'customModelName', label: '自定义模型名（可选）', value: '' },
            ], { description: '创建后原始 Key 只显示一次。', submitLabel: '创建' });
            if (!values) return;
            const result = await createApiKey(runtime.client, {
              name: values.name || 'CrewRouter CLI',
              expiresIn: values.expiresIn ? Number(values.expiresIn) : undefined,
              customModelName: values.customModelName || undefined,
            });
            await ctx.show('API Key 已创建', `${result.name || values.name}\n\n${result.key || result.key_value || '响应未返回原始 Key'}\n\n请立即保存；关闭后无法再次查看。`);
            await ctx.refresh();
          } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

module.exports = { providersPage, modelsPage, keysPage };
