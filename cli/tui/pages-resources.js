'use strict';

const {
  listProviders, pingProvider, toggleProvider, listModels, testModel,
  listApiKeys, createApiKey, toggleApiKey, renameApiKey, deleteApiKey, getApiKeyConfig,
} = require('../lib/api');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');
const { text, enabledLabel } = require('./pages-common');
const display = (...values) => values.map(value => String(value || '').trim()).filter(Boolean).join(' · ');

function providerDetail(provider) {
  const { api_key, api_keys, ark_secret_key, cpa_management_key, ...safe } = provider || {};
  return {
    ...safe,
    api_key: api_key ? '[已配置]' : '',
    api_keys: Array.isArray(api_keys) ? api_keys.map(entry => ({ ...entry, key: entry.key ? '[已配置]' : '' })) : api_keys,
    ark_secret_key: ark_secret_key ? '[已配置]' : '',
    cpa_management_key: cpa_management_key ? '[已配置]' : '',
  };
}

function providersPage(runtime) {
  return {
    id: 'providers',
    label: '供应商',
    description: '查看供应商状态、筛选目录并检测连通性；管理员可启停。',
    async load() {
      const search = runtime.providerSearch || '';
      const scope = runtime.providerScope || '';
      const enabledFilter = runtime.providerEnabled || '';
      const keyMode = runtime.providerKeyMode || '';
      const data = await listProviders(runtime.client, { search, scope, status: enabledFilter, keyMode, tagId: runtime.providerTagId || '' });
      const stats = data.stats || {};
      const query = String(search).toLowerCase();
      const visibleItems = data.items.filter(item => !query || data.scope === 'admin' || [item.name, item.id, item.base_url, item.format].some(value => String(value || '').toLowerCase().includes(query)));
      const rows = visibleItems.map(item => ({
        label: `${item.name || item.id} · ${item.format || 'unknown'} · ${enabledLabel(item.enabled)}${item.has_api_key === true ? ' · Key 已配置' : ''}`,
        detail: `${item.id}${item.base_url ? ` · ${item.base_url}` : ''}${Array.isArray(item.tags) && item.tags.length ? ` · 标签 ${item.tags.map(tag => tag.name).join('/')}` : ''}`,
        run: async ctx => {
          const actions = [
            { label: '查看详情', value: 'detail' },
            ...(data.scope === 'admin' ? [{ label: '设置供应商标签', value: 'tags' }] : []),
            { label: '检测连通性', value: 'ping' },
            ...(data.scope === 'admin' ? [{ label: item.enabled === false ? '启用供应商' : '停用供应商', value: 'toggle' }] : []),
          ];
          const choice = await ctx.choose('供应商操作', actions, { description: `${item.name || item.id}\n${item.base_url || ''}`.trim() });
          if (choice === 'detail') await ctx.show(`供应商 · ${item.name || item.id}`, JSON.stringify(providerDetail(item), null, 2));
          else if (choice === 'tags') {
            const [allTags, provider] = await Promise.all([runtime.client.get('/api/admin/provider-tags'), runtime.client.get(`/api/admin/providers/${encodeURIComponent(item.id)}`)]);
            const current = new Set((provider.tags || []).map(tag => String(tag.id)));
            const selected = await ctx.choose(`设置标签 · ${item.name || item.id}`, [
              ...allTags.map(tag => ({ label: `${current.has(String(tag.id)) ? '✓ ' : ''}${tag.name}（#${tag.id}）`, value: String(tag.id) })),
              { label: '清空所有标签', value: '__clear__' },
            ]);
            if (selected === null) return;
            const next = selected === '__clear__' ? [] : [...new Set([...current, selected])];
            if (!await ctx.confirm('保存供应商标签', `${item.name || item.id}\n标签 ID：${next.join(', ') || '无'}`)) return;
            await runtime.client.put(`/api/admin/providers/${encodeURIComponent(item.id)}/tags`, { tagIds: next.map(Number) });
            ctx.notify('供应商标签已更新。'); await ctx.refresh();
          } else if (choice === 'ping') {
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
            { label: '供应商标签管理', run: async ctx => ctx.navigate('provider-tags') },
            ...[['', '全部供应商'], ['global', '全局供应商'], ['user', '用户供应商']].map(([value, label]) => ({ label, run: async ctx => { runtime.providerScope = value; await ctx.refresh(); } })),
            ...[['', '全部状态'], ['enabled', '仅启用'], ['disabled', '仅停用']].map(([value, label]) => ({ label, run: async ctx => { runtime.providerEnabled = value; await ctx.refresh(); } })),
            ...[['', '全部密钥模式'], ['fixed', '固定密钥'], ['script', '脚本密钥']].map(([value, label]) => ({ label, run: async ctx => { runtime.providerKeyMode = value; await ctx.refresh(); } })),
            ...(Array.isArray(stats.tags) ? stats.tags.map(tag => ({ label: `标签：${tag.name}`, run: async ctx => { runtime.providerTagId = String(tag.id); await ctx.refresh(); } })) : []),
          ] : []),
          { label: '清除筛选', run: async ctx => { runtime.providerSearch = ''; runtime.providerScope = ''; runtime.providerEnabled = ''; runtime.providerKeyMode = ''; runtime.providerTagId = ''; await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

function myUpstreamPage(runtime) {
  return {
    id: 'my-upstream', label: '我的上游', description: '网页“我的上游”供应商与个人 Team 模型双标签页。',
    tabs: [{ id: 'providers', label: '供应商' }, { id: 'models', label: '模型' }],
    async load() {
      const [providersResult, modelsResult] = await Promise.allSettled([
        runtime.client.get('/api/user/my-providers'), runtime.client.get('/api/user/my-team-models'),
      ]);
      const providers = providersResult.status === 'fulfilled' ? (Array.isArray(providersResult.value) ? providersResult.value : []) : [];
      const models = modelsResult.status === 'fulfilled' ? (Array.isArray(modelsResult.value) ? modelsResult.value : []) : [];
      const providerQuery = String(runtime.myUpstreamProviderSearch || '').toLowerCase();
      const modelQuery = String(runtime.myUpstreamModelSearch || '').toLowerCase();
      const visibleProviders = providers.filter(item => !providerQuery || [item.name, item.id, item.base_url, item.format].some(value => String(value || '').toLowerCase().includes(providerQuery)));
      const visibleModels = models.filter(item => !modelQuery || [item.alias, item.name, item.id, item.upstream_model_id, item.provider_name, item.series].some(value => String(value || '').toLowerCase().includes(modelQuery)));
      return {
        sections: [
          { title: '供应商', tab: 'providers', description: `${visibleProviders.length}/${providers.length} 个供应商 · 搜索 ${providerQuery || '无'}`, rows: visibleProviders.length ? visibleProviders.map(item => ({ label: display(item.name, item.format, item.enabled === false ? '停用' : '启用', `${item.model_count || 0} 个模型`), detail: display(item.id, item.base_url, item.notes), run: async ctx => { const choice = await ctx.choose(`供应商 · ${item.name || item.id}`, [{ label: '查看详情', value: 'detail' }, { label: '检测连通性', value: 'ping' }], { description: item.base_url || '' }); if (choice === 'detail') await ctx.show(`供应商 · ${item.name || item.id}`, JSON.stringify(providerDetail(item), null, 2)); if (choice === 'ping') { const result = await pingProvider(runtime.client, item.id); await ctx.show('连通性检测', JSON.stringify(result, null, 2)); } } })) : [{ label: providersResult.status === 'rejected' ? providersResult.reason.message : '暂无我的上游供应商。' }] },
          { title: '个人 Team 模型', tab: 'models', description: `${visibleModels.length}/${models.length} 个模型 · 搜索 ${modelQuery || '无'}`, rows: visibleModels.length ? visibleModels.map(item => ({ label: display(item.alias || item.name || item.id, item.upstream_model_id || item.name || item.id, item.provider_name || item.provider, item.series || '—'), detail: display(`倍率 ×${Number(item.model_multiplier || 1).toFixed(2)}`, item.enabled === false ? '停用' : '启用', item.description), run: async ctx => await ctx.show(`个人 Team 模型 · ${item.alias || item.name || item.id}`, JSON.stringify(item, null, 2)) })) : [{ label: modelsResult.status === 'rejected' ? modelsResult.reason.message : '暂无个人 Team 模型。' }] },
        ],
        actions: [
          { label: '搜索我的供应商', tab: 'providers', run: async ctx => { runtime.myUpstreamProviderSearch = String(await ctx.ask('供应商名称、ID 或地址', { defaultValue: runtime.myUpstreamProviderSearch || '' }) || '').trim(); await ctx.refresh(); } },
          { label: '搜索个人 Team 模型', tab: 'models', run: async ctx => { runtime.myUpstreamModelSearch = String(await ctx.ask('模型名称、ID、上游 ID、供应商或系列', { defaultValue: runtime.myUpstreamModelSearch || '' }) || '').trim(); await ctx.refresh(); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

function providerTagsPage(runtime) {
  return {
    id: 'provider-tags', label: '供应商标签', description: '管理供应商目录筛选标签。',
    async load(api) {
      const tags = await api('/api/admin/provider-tags');
      return { sections: [{ title: '供应商标签', rows: tags.length ? tags.map(tag => ({ label: `${tag.name} · #${tag.id}`, detail: `颜色 ${tag.color || '默认'} · 顺序 ${tag.sort_order || 0}`, run: async ctx => {
        const choice = await ctx.choose(`标签 · ${tag.name}`, [{ label: '编辑名称/颜色', value: 'edit' }, { label: '删除标签', value: 'delete' }]);
        if (choice === 'edit') {
          const values = await ctx.form('编辑供应商标签', [{ name: 'name', label: '名称', value: tag.name }, { name: 'color', label: '颜色', value: tag.color || '#3b82f6' }]);
          if (!values || !await ctx.confirm('保存供应商标签', `${tag.name} → ${values.name}`)) return;
          await api(`/api/admin/provider-tags/${tag.id}`, { method: 'PUT', body: values }); ctx.notify('标签已更新。'); await ctx.refresh();
        }
        if (choice === 'delete') {
          if (!await ctx.confirm('删除供应商标签', `删除「${tag.name}」？相关供应商标签关联会被级联删除。`)) return;
          await api(`/api/admin/provider-tags/${tag.id}`, { method: 'DELETE' }); ctx.notify('标签已删除。'); await ctx.refresh();
        }
      } })) : [{ label: '暂无标签。' }] }], actions: [
        { label: '新建标签', run: async ctx => { const values = await ctx.form('新建供应商标签', [{ name: 'name', label: '名称' }, { name: 'color', label: '颜色', value: '#3b82f6' }]); if (!values || !String(values.name || '').trim()) return; await api('/api/admin/provider-tags', { method: 'POST', body: values }); ctx.notify('标签已创建。'); await ctx.refresh(); } },
        { label: '返回供应商', run: ctx => ctx.navigate('providers') },
        { label: '刷新', run: ctx => ctx.refresh() },
      ] };
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
    async load() {
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
    async load() {
      const [keysResult, authorizationsResult, tagsResult] = await Promise.allSettled([
        listApiKeys(runtime.client), runtime.client.get('/oauth/authorizations'), runtime.client.get('/api/user/key-tags'),
      ]);
      if (keysResult.status === 'rejected') throw keysResult.reason;
      const allKeys = keysResult.value;
      const tags = tagsResult.status === 'fulfilled' ? (Array.isArray(tagsResult.value) ? tagsResult.value : []) : [];
      const activeTag = runtime.apiKeyTagFilter || '';
      const keys = allKeys.filter(key => !activeTag || (Array.isArray(key.tags) && key.tags.some(tag => String(tag.id) === String(activeTag))));
      const authorizations = authorizationsResult.status === 'fulfilled' && Array.isArray(authorizationsResult.value?.authorizations) ? authorizationsResult.value.authorizations : [];
      const rows = keys.map(key => ({
        label: `${key.name || '未命名'} · ${key.key_prefix || ''} · ${enabledLabel(key.enabled)} · ${key.current_model_name || key.current_model_id || '未绑定模型'}`,
        detail: `${Number(key.total_requests || 0).toLocaleString()} 请求 · ${formatBigNumber(key.total_tokens)} tokens · ${formatCost(key.total_cost)} · 最后使用 ${formatTime(key.last_used_at)}`,
        run: async ctx => {
          const actions = [
            { label: '查看详情', value: 'detail' },
            ...(key.is_owner === true ? [{ label: '设置标签', value: 'tags' }] : []),
            { label: '查看 Claude Code 配置', value: 'config' },
            { label: key.enabled === false ? '启用 Key' : '停用 Key', value: 'toggle' },
            { label: '重命名', value: 'rename' },
            { label: '删除 Key', value: 'delete' },
          ];
          const choice = await ctx.choose('API Key 操作', actions, { description: key.name || key.key_prefix || `Key ${key.id}` });
          if (choice === 'detail') await ctx.show(`API Key · ${key.name || key.id}`, JSON.stringify({
            id: key.id, name: key.name, prefix: key.key_prefix, enabled: key.enabled, tags: key.tags,
            current_model: key.current_model_name || key.current_model_id, permissions: key.permissions,
            total_requests: key.total_requests, total_tokens: key.total_tokens, total_cost: key.total_cost,
            created_at: key.created_at, last_used_at: key.last_used_at, expires_at: key.expires_at,
          }, null, 2));
          else if (choice === 'tags') {
            const current = new Set((key.tags || []).map(tag => Number(tag.id)));
            const value = await ctx.ask('标签 ID（逗号分隔；清空表示移除所有标签）', { defaultValue: [...current].join(','), description: tags.map(tag => `${tag.id}: ${tag.name}`).join(' · ') || '暂无标签，可从页面操作创建。' });
            if (value === null) return;
            const tagIds = String(value).split(',').map(item => item.trim()).filter(Boolean).map(Number).filter(id => Number.isInteger(id) && id > 0);
            if (!await ctx.confirm('保存 API Key 标签', `${key.name || key.key_prefix}\n标签 ID：${tagIds.join(', ') || '无'}`)) return;
            await runtime.client.put(`/api/user/api-keys/${encodeURIComponent(key.id)}/tags`, { tagIds });
            ctx.notify('API Key 标签已更新。'); await ctx.refresh();
          }
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
          title: 'OAuth 授权',
          description: authorizations.length ? `${authorizations.length} 个客户端具有活跃授权。` : (authorizationsResult.status === 'rejected' ? '当前会话无法读取 OAuth 授权列表。' : '暂无活跃授权。'),
          rows: authorizations.map(auth => ({ label: `${auth.client_name || auth.name || 'OAuth 客户端'} · ${auth.client_id || ''}`, detail: `授权时间 ${formatTime(auth.created_at || auth.authorized_at)} · 范围 ${(auth.scopes || []).join(', ') || '默认'}`, run: async ctx => { if (!await ctx.confirm('吊销 OAuth 授权', `${auth.client_name || auth.name || auth.client_id}\n吊销后该客户端的所有访问令牌立即失效。`)) return; await runtime.client.post('/oauth/authorizations/revoke', { id: Number(auth.id) }); ctx.notify('OAuth 授权已吊销。'); await ctx.refresh(); } })),
        }, {
          title: 'API Key',
          description: `只能查看当前账号可见 Key；共享 Key 的原始值受权限限制。显示 ${keys.length}/${allKeys.length}${activeTag ? ` · 标签 ${tags.find(tag => String(tag.id) === String(activeTag))?.name || activeTag}` : ''}`,
          cards: [
            { label: '总数', value: allKeys.length, detail: '当前账号可见' },
            { label: '显示', value: keys.length, detail: '当前筛选' },
            { label: '启用', value: keys.filter(key => key.enabled !== false).length, detail: '可用 Key' },
            { label: '停用', value: keys.filter(key => key.enabled === false).length, detail: '不可调用' },
          ],
          rows: rows.length ? rows : [{ label: '暂无 API Key。' }],
        }],
        actions: [
          ...[['', '全部标签'], ...tags.map(tag => [String(tag.id), `标签：${tag.name}`])].map(([value, label]) => ({ label, run: async ctx => { runtime.apiKeyTagFilter = value; await ctx.refresh(); } })),
          { label: '新建/编辑 Key 标签', run: async ctx => { const choice = await ctx.choose('API Key 标签管理', [{ label: '新建标签', value: 'create' }, ...tags.map(tag => ({ label: `编辑 ${tag.name}`, value: `edit:${tag.id}` })), ...tags.map(tag => ({ label: `删除 ${tag.name}`, value: `delete:${tag.id}` }))]); if (!choice) return; if (choice === 'create') { const values = await ctx.form('新建 Key 标签', [{ name: 'name', label: '名称' }, { name: 'color', label: '颜色', value: '#3b82f6' }]); if (!values || !String(values.name || '').trim()) return; await runtime.client.post('/api/user/key-tags', values); ctx.notify('标签已创建。'); await ctx.refresh(); return; } const [action, id] = choice.split(':'); const tag = tags.find(item => String(item.id) === id); if (action === 'edit') { const values = await ctx.form('编辑 Key 标签', [{ name: 'name', label: '名称', value: tag.name }, { name: 'color', label: '颜色', value: tag.color || '#3b82f6' }]); if (!values) return; await runtime.client.put(`/api/user/key-tags/${id}`, values); ctx.notify('标签已更新。'); await ctx.refresh(); } if (action === 'delete') { if (!await ctx.confirm('删除 Key 标签', `删除「${tag.name}」？关联的 Key 标签会一起移除。`)) return; await runtime.client.delete(`/api/user/key-tags/${id}`); ctx.notify('标签已删除。'); runtime.apiKeyTagFilter = ''; await ctx.refresh(); } } },
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

module.exports = { providersPage, myUpstreamPage, providerTagsPage, modelsPage, keysPage };
