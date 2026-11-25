'use strict';

const {
  listProviders, pingProvider, toggleProvider, listModels, testModel,
  listApiKeys, createApiKey, toggleApiKey, renameApiKey, deleteApiKey, getApiKeyConfig,
} = require('../lib/api');
const { formatBigNumber, formatCost, formatTime } = require('../lib/format');
const { text, enabledLabel } = require('./pages-common');
const display = (...values) => values.map(value => String(value || '').trim()).filter(Boolean).join(' · ');
const API_FORMATS = [
  { value: 'openai', label: 'OpenAI 兼容格式' }, { value: 'anthropic', label: 'Anthropic Messages 格式' },
  { value: 'responses', label: 'OpenAI Responses 格式' }, { value: 'gemini', label: 'Gemini 格式' },
];
const apiFormatLabel = value => API_FORMATS.find(item => item.value === String(value || '').toLowerCase())?.label || '未指定格式';

function providerDetail(provider) {
  const item = provider || {};
  const format = ({ openai: 'OpenAI 兼容格式', anthropic: 'Anthropic Messages 格式', responses: 'Responses 格式', gemini: 'Gemini 格式' })[item.format] || item.format || '未指定';
  return [
    `名称：${item.name || '未命名'}`, `状态：${item.enabled === false ? '已停用' : '已启用'}`, `接口格式：${format}`,
    `Base URL：${item.base_url || '未设置'}`, item.models_url && `模型列表地址：${item.models_url}`,
    item.model_count !== undefined && `已配置模型：${item.model_count} 个`,
    item.has_api_key !== undefined && `API Key：${item.has_api_key ? '已配置（不显示密钥）' : '未配置'}`,
    Array.isArray(item.endpoints) && item.endpoints.length ? `附加接口：${item.endpoints.map(endpoint => `${endpoint.label || endpoint.url}（${endpoint.format || format}，${endpoint.enabled === false ? '已停用' : '已启用'}）`).join('\n  ')}` : '',
    item.notes && `备注：${item.notes}`, item.id && `内部编号：${item.id}`,
  ].filter(Boolean).join('\n');
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
        label: `${item.name || item.id} · ${apiFormatLabel(item.format)} · ${enabledLabel(item.enabled)}${item.has_api_key === true ? ' · API Key 已配置' : ''}`,
        detail: `${item.id}${item.base_url ? ` · ${item.base_url}` : ''}${Array.isArray(item.tags) && item.tags.length ? ` · 标签 ${item.tags.map(tag => tag.name).join('/')}` : ''}`,
        run: async ctx => {
          const actions = [
            { label: '查看详情', value: 'detail' },
            ...(data.scope === 'admin' ? [{ label: '设置供应商标签', value: 'tags' }] : []),
            { label: '检测连通性', value: 'ping' },
            ...(data.scope === 'admin' ? [{ label: item.enabled === false ? '启用供应商' : '停用供应商', value: 'toggle' }] : []),
          ];
          const choice = await ctx.choose('供应商操作', actions, { description: `${item.name || item.id}\n${item.base_url || ''}`.trim() });
          if (choice === 'detail') await ctx.show(`供应商 · ${item.name || item.id}`, providerDetail(item));
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
              ? `成功 · 响应时间 ${result.latency_ms !== null && result.latency_ms !== undefined ? `${result.latency_ms} 毫秒` : '未知'}${result.note ? `\n${result.note}` : ''}`
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

function personalModelDetail(model) {
  const item = model || {};
  const price = value => `${value == null ? '—' : value} 人民币/千Token`;
  return [
    `显示名称：${item.alias || item.name || '未命名'}`, `上游模型ID：${item.upstream_model_id || item.name || item.id || '—'}`,
    `所属供应商：${item.provider_name || item.provider || '未知'}`, `模型系列：${item.series || '无'}`,
    `状态：${item.enabled === false ? '已停用' : '已启用'}`, `计费倍率：×${Number(item.model_multiplier || 1).toFixed(2)}`,
    `回复内容倍率：×${Number(item.completion_multiplier || 1).toFixed(2)}`,
    `输入价格：${price(item.input_price_per_1k_tokens)}`, `输出价格：${price(item.output_price_per_1k_tokens)}`,
    `缓存输出价格：${price(item.cached_output_price_per_1k_tokens)}`,
    `参考输入价格：${price(item.reference_input_price_per_1k_tokens)}`, `参考输出价格：${price(item.reference_output_price_per_1k_tokens)}`,
    `每分钟最大请求数：${item.rate_limit_rpm || 0}`, `每分钟最大 Token 数：${item.rate_limit_tpm || 0}`,
    item.thinking_model_id && `思考模式模型：${item.thinking_model_id}`, item.non_thinking_model_id && `普通模式模型：${item.non_thinking_model_id}`,
    item.description && `模型说明：${item.description}`,
  ].filter(Boolean).join('\n');
}

function myUpstreamPage(runtime) {
  const updateLabels = { enabled: '启用状态', input_price_per_1k_tokens: '输入价格（人民币/1,000 Token）', output_price_per_1k_tokens: '输出价格（人民币/1,000 Token）', cached_output_price_per_1k_tokens: '缓存输出价格（人民币/1,000 Token）', series: '模型系列', description: '模型说明', alias: '显示名称/别名' };
  const modelMultiplierLabel = value => `计费倍率 ×${Number(value || 1).toFixed(2)}`;
  const describeUpdates = updates => Object.entries(updates).map(([name, value]) => `${updateLabels[name] || name}：${name === 'enabled' ? (value ? '启用' : '停用') : value}`).join('\n');
  return {
    id: 'my-upstream', label: '我的上游', description: '管理自有供应商及其模型。',
    tabs: [{ id: 'providers', label: '供应商' }, { id: 'models', label: '模型' }],
    onTabChange() { runtime.myUpstreamProviderSearch = ''; runtime.myUpstreamModelSearch = ''; runtime.myUpstreamSelectedModels = []; },
    async load() {
      const [providersResult, modelsResult] = await Promise.allSettled([
        runtime.client.get('/api/user/my-providers'), runtime.client.get('/api/user/my-team-models'),
      ]);
      const providers = providersResult.status === 'fulfilled' ? (Array.isArray(providersResult.value) ? providersResult.value : []) : [];
      const models = modelsResult.status === 'fulfilled' ? (Array.isArray(modelsResult.value) ? modelsResult.value : []) : [];
      const providerQuery = String(runtime.myUpstreamProviderSearch || '').toLowerCase();
      const modelQuery = String(runtime.myUpstreamModelSearch || '').toLowerCase();
      const providerStatus = runtime.myUpstreamProviderStatus || 'all';
      const visibleProviders = providers.filter(item => (!providerQuery || [item.name, item.id, item.base_url, item.format].some(value => String(value || '').toLowerCase().includes(providerQuery))) && (providerStatus === 'all' || (providerStatus === 'enabled') === (item.enabled !== false)));
      const visibleModels = models.filter(item => !modelQuery || [item.alias, item.name, item.id, item.upstream_model_id, item.provider_name, item.series].some(value => String(value || '').toLowerCase().includes(modelQuery)));
      const selectModels = async ctx => {
        const available = new Map(visibleModels.map(item => [String(item.id), item]));
        const selected = new Set((runtime.myUpstreamSelectedModels || []).filter(id => available.has(String(id))).map(String));
        while (true) {
          const options = [
            ...visibleModels.map(item => ({ label: `${selected.has(String(item.id)) ? '☑' : '☐'} ${item.alias || item.name || item.id} · ${item.provider_name || item.provider || '未知供应商'}`, value: String(item.id) })),
            { label: `全选当前筛选的 ${visibleModels.length} 个模型`, value: '__all__' }, { label: '清空选择', value: '__clear__' }, { label: `完成选择（${selected.size} 个）`, value: '__done__' },
          ];
          const value = await ctx.choose('选择我的模型', options, { description: '重复选择模型可取消勾选；按“完成选择”继续批量操作。' });
          if (value === null) return [];
          if (value === '__done__') break;
          if (value === '__all__') { visibleModels.forEach(item => selected.add(String(item.id))); continue; }
          if (value === '__clear__') { selected.clear(); continue; }
          if (selected.has(value)) selected.delete(value); else selected.add(value);
        }
        runtime.myUpstreamSelectedModels = [...selected];
        return [...selected];
      };
      const manageProviderEndpoints = async (ctx, provider) => {
        let endpoints = (Array.isArray(provider.endpoints) ? provider.endpoints : []).map(endpoint => ({ url: String(endpoint.url || '').trim(), format: String(endpoint.format || 'openai'), label: String(endpoint.label || ''), enabled: endpoint.enabled !== false }));
        while (true) {
          const options = [
            ...endpoints.flatMap((endpoint, index) => [
              { label: `${endpoint.enabled ? '已启用' : '已停用'} · ${endpoint.label || `附加接口 ${index + 1}`} · ${endpoint.url} · ${apiFormatLabel(endpoint.format)}`, value: `edit:${index}` },
              { label: `${endpoint.enabled ? '停用' : '启用'} ${endpoint.label || `附加接口 ${index + 1}`}`, value: `toggle:${index}` },
              { label: `删除 ${endpoint.label || `附加接口 ${index + 1}`}`, value: `delete:${index}` },
            ]),
            { label: '新增附加接口', value: 'add' }, ...(endpoints.length ? [{ label: '删除所有附加接口', value: 'clear' }] : []), { label: '完成修改并继续保存', value: 'done' },
          ];
          const action = await ctx.choose(`备用接口 · ${provider.name}`, options, { description: '主接口地址和当前 API Key 不变；备用接口会在请求失败时按顺序尝试。最多可添加 16 个接口。' });
          if (action === null) return;
          if (action === 'done') break;
          if (action === 'clear') { if (await ctx.confirm('删除全部备用接口', `移除 ${endpoints.length} 个备用接口？主接口 Base URL 保留。`)) endpoints = []; continue; }
          if (action.startsWith('toggle:')) {
            const index = Number(action.slice(7));
            if (endpoints[index]) endpoints[index] = { ...endpoints[index], enabled: endpoints[index].enabled === false };
            continue;
          }
          if (action.startsWith('delete:')) {
            const index = Number(action.slice(7));
            const endpoint = endpoints[index];
            if (endpoint && await ctx.confirm('删除备用接口', `确定删除「${endpoint.label || endpoint.url}」？主接口不变。`)) endpoints.splice(index, 1);
            continue;
          }
          const editing = action.startsWith('edit:');
          if (!editing && endpoints.length >= 16) { await ctx.show('已达到接口数量上限', '每个供应商最多可配置 16 个附加接口。'); continue; }
          const index = editing ? Number(action.slice(5)) : -1;
          const current = index >= 0 ? endpoints[index] : { url: '', format: provider.format || 'openai', label: '', enabled: true };
          const values = await ctx.form(editing ? `编辑备用接口 ${current.label || index + 1}` : '新增备用接口', [
            { name: 'url', label: '接口地址（http://或https://）', value: current.url },
            { name: 'format', label: 'API 格式', value: current.format, options: API_FORMATS },
            { name: 'label', label: '接口名称（可空）', value: current.label },
            { name: 'enabled', label: '启用此接口', type: 'boolean', value: current.enabled },
          ]);
          if (!values) continue;
          const url = String(values.url || '').trim().replace(/\/+$/, '');
          if (!/^https?:\/\//i.test(url) || url.length > 500 || /[\x00-\x1f\x7f]/.test(url)) { await ctx.show('接口地址无效', '请输入不超过 500 字的 HTTP 或 HTTPS 地址。'); continue; }
          const format = String(values.format || '').trim().toLowerCase();
          if (!API_FORMATS.some(option => option.value === format)) { await ctx.show('接口格式无效', '请选择 OpenAI 兼容、Anthropic Messages、OpenAI Responses 或 Gemini 格式。'); continue; }
          const duplicateKey = `${url.toLowerCase()}\0${format}`;
          const duplicate = (url.toLowerCase() === String(provider.base_url || '').trim().replace(/\/+$/, '').toLowerCase() && format === String(provider.format || 'openai').toLowerCase()) || endpoints.some((endpoint, endpointIndex) => endpointIndex !== index && `${endpoint.url.toLowerCase().replace(/\/+$/, '')}\0${String(endpoint.format).toLowerCase()}` === duplicateKey);
          if (duplicate) { await ctx.show('接口已重复', '附加接口不得与主接口或其他附加接口使用相同地址和格式。'); continue; }
          const next = { url, format, label: String(values.label || '').trim().slice(0, 50), enabled: values.enabled !== false };
          if (editing) endpoints[index] = next; else endpoints.push(next);
        }
        if (!await ctx.confirm('保存备用接口配置', `${provider.name}\n主接口不变：${provider.base_url || '未设置'}\n${endpoints.length ? endpoints.map((endpoint, index) => `${index + 1}. ${endpoint.label || '未命名接口'} · ${endpoint.url} · ${apiFormatLabel(endpoint.format)} · ${endpoint.enabled ? '启用' : '停用'}`).join('\n') : '不使用备用接口'}\n该列表会完整替换当前备用接口。`)) return;
        await runtime.client.put(`/api/user/providers/${encodeURIComponent(provider.id)}`, { endpoints });
        ctx.notify('备用接口配置已保存。'); await ctx.refresh();
      };
      const manageProviderModels = async (ctx, provider) => {
        const modelItems = await runtime.client.get(`/api/user/providers/${encodeURIComponent(provider.id)}/models`);
        const selected = new Set();
        while (true) {
          const options = [
            ...modelItems.map(model => ({ label: `${selected.has(String(model.id)) ? '☑' : '☐'} ${model.alias || model.name || model.id} · ${model.series || '无系列'} · ${model.enabled === false ? '已停用' : '已启用'}`, value: String(model.id) })),
            { label: `全选 ${modelItems.length} 个模型`, value: '__all__' }, { label: '清空选择', value: '__clear__' }, { label: `完成选择（${selected.size} 个）`, value: '__done__' },
          ];
          const value = await ctx.choose(`管理模型 · ${provider.name}`, options, { description: `${modelItems.length} 个供应商模型；与网页模型管理对话框相同，支持批量启停、调价和删除。` });
          if (value === null) return;
          if (value === '__done__') break;
          if (value === '__all__') { modelItems.forEach(model => selected.add(String(model.id))); continue; }
          if (value === '__clear__') { selected.clear(); continue; }
          if (selected.has(value)) selected.delete(value); else selected.add(value);
        }
        const modelIds = [...selected];
        if (!modelIds.length) return;
        const action = await ctx.choose('批量管理供应商模型', [{ label: '批量启用', value: 'enable' }, { label: '批量停用', value: 'disable' }, { label: '批量更新字段/价格', value: 'edit' }, { label: '批量删除', value: 'delete' }], { description: `${provider.name} · 已选择 ${modelIds.length} 个模型` });
        if (!action) return;
        if (action === 'delete') {
          if (!await ctx.confirm('删除供应商模型', `删除 ${modelIds.length} 个模型？关联团队和 API Key 模型授权也会被清除，且不可恢复。`)) return;
          const result = await runtime.client.post(`/api/user/providers/${encodeURIComponent(provider.id)}/models/batch-delete`, { modelIds });
          ctx.notify(`已删除 ${result.deleted || 0} 个供应商模型。`); await ctx.refresh(); return;
        }
        const updates = {};
        if (action === 'enable' || action === 'disable') updates.enabled = action === 'enable';
        else {
          const fieldOptions = [
            { label: '启用状态', value: 'enabled' }, { label: '输入价格（人民币/1,000 Token）', value: 'input_price_per_1k_tokens' }, { label: '输出价格（人民币/1,000 Token）', value: 'output_price_per_1k_tokens' },
            { label: '缓存输出价格（人民币/1,000 Token）', value: 'cached_output_price_per_1k_tokens' }, { label: '系列', value: 'series' }, { label: '说明', value: 'description' }, { label: '显示名称/别名', value: 'alias' }, { label: '完成字段选择', value: '__done__' },
          ];
          while (true) {
            const field = await ctx.choose('选择供应商模型更新字段', fieldOptions, { description: '可添加多个字段；未选择字段保持不变。' });
            if (!field || field === '__done__') break;
            if (field === 'enabled') { const value = await ctx.choose('设置模型状态', [{ label: '启用', value: true }, { label: '停用', value: false }]); if (value !== null) updates.enabled = value; continue; }
            const labels = { input_price_per_1k_tokens: '输入价格（人民币/1,000 Token）', output_price_per_1k_tokens: '输出价格（人民币/1,000 Token）', cached_output_price_per_1k_tokens: '缓存输出价格（人民币/1,000 Token）', series: '系列名称', description: '模型说明', alias: '显示名称/别名' };
            const value = await ctx.ask(labels[field], { description: field.endsWith('_price_per_1k_tokens') ? '请输入大于或等于 0 的数字。' : '留空会清除此字段。' });
            if (value === null) continue;
            if (field.endsWith('_price_per_1k_tokens')) { if (!String(value).trim() || !Number.isFinite(Number(value)) || Number(value) < 0) { await ctx.show('价格无效', '请输入大于或等于 0 的数字。'); continue; } updates[field] = Number(value); }
            else updates[field] = String(value);
          }
          if (!Object.keys(updates).length) return;
        }
        if (!await ctx.confirm('更新供应商模型', `${provider.name}\n${modelIds.length} 个模型\n${describeUpdates(updates)}\n价格变更会影响计费。`)) return;
        const result = await runtime.client.post(`/api/user/providers/${encodeURIComponent(provider.id)}/models/batch-update`, { modelIds, updates });
        ctx.notify(`已更新 ${result.updated || 0} 个供应商模型。`); await ctx.refresh();
      };
      const addPersonalModel = async ctx => {
        const [providersResult, modelsResult] = await Promise.allSettled([
          runtime.client.get('/api/user/providers'), runtime.client.get('/api/user/models'),
        ]);
        const providers = providersResult.status === 'fulfilled' ? (Array.isArray(providersResult.value) ? providersResult.value : []) : [];
        const models = modelsResult.status === 'fulfilled' ? (Array.isArray(modelsResult.value) ? modelsResult.value : []) : [];
        if (!providers.length) { await ctx.show('无法添加模型', '当前账号没有可用的自有供应商。请先在“供应商”页签添加供应商。'); return; }
        const modelOptions = [{ label: '不指定（使用此模型本身）', value: '' }, ...models.map(model => ({ label: `${model.alias || model.name || model.id} · ${model.provider_name || model.provider}`, value: String(model.id) }))];
        const values = await ctx.form('添加个人模型', [
          { name: 'upstream_model_id', label: '上游模型 ID（必填）', value: '' }, { name: 'alias', label: '模型显示名称（可空）', value: '' },
          { name: 'provider', label: '所属供应商', value: providers[0].id, options: providers.map(provider => ({ label: provider.name, value: String(provider.id) })) },
          { name: 'series', label: '模型系列（可空）', value: '' }, { name: 'enabled', label: '启用此模型', type: 'boolean', value: true },
          { name: 'input_price_per_1k_tokens', label: '输入价格（人民币/千 Token）', value: '0.01' },
          { name: 'output_price_per_1k_tokens', label: '输出价格（人民币/千 Token）', value: '0.01' },
          { name: 'cached_output_price_per_1k_tokens', label: '缓存输出价格（人民币/千 Token）', value: '0' },
          { name: 'reference_input_price_per_1k_tokens', label: '参考输入价格（人民币/千 Token）', value: '0' },
          { name: 'reference_output_price_per_1k_tokens', label: '参考输出价格（人民币/千 Token）', value: '0' },
          { name: 'description', label: '模型说明（可空）', value: '' },
          { name: 'thinking_model_id', label: '思考模式模型（可选）', value: '', options: modelOptions },
          { name: 'non_thinking_model_id', label: '普通模式模型（可选）', value: '', options: modelOptions },
          { name: 'rate_limit_rpm', label: '每分钟最大请求数（不限制填 0）', value: '0' },
          { name: 'rate_limit_tpm', label: '每分钟最大 Token 数（不限制填 0）', value: '0' },
        ]);
        if (!values) return;
        if (!String(values.upstream_model_id || '').trim()) { await ctx.show('缺少上游模型 ID', '请填写供应商提供的模型 ID。'); return; }
        const numberFields = ['input_price_per_1k_tokens', 'output_price_per_1k_tokens', 'cached_output_price_per_1k_tokens', 'reference_input_price_per_1k_tokens', 'reference_output_price_per_1k_tokens', 'rate_limit_rpm', 'rate_limit_tpm'];
        const body = { ...values };
        for (const key of numberFields) {
          const value = Number(values[key]);
          if (!Number.isFinite(value) || value < 0) { await ctx.show('数字格式无效', '价格和速率上限必须为大于或等于 0 的数字。'); return; }
          body[key] = value;
        }
        body.provider = String(values.provider || '');
        const provider = providers.find(item => String(item.id) === body.provider);
        if (!provider) { await ctx.show('供应商无效', '请选择当前账号可用的自有供应商。'); return; }
        body.upstream_model_id = String(values.upstream_model_id).trim();
        const priceSummary = `${body.input_price_per_1k_tokens} 输入 / ${body.output_price_per_1k_tokens} 输出 · 网页表单单位为人民币/千 Token`;
        if (!await ctx.confirm('确认添加模型', `名称：${values.alias || body.upstream_model_id}\n供应商：${provider.name}\n上游模型 ID：${body.upstream_model_id}\n状态：${body.enabled ? '启用' : '停用'}\n价格：${priceSummary}\n创建后模型会加入个人团队，可供你的 Key 选择。`)) return;
        const result = await runtime.client.post('/api/user/models', body);
        ctx.notify(`模型已添加${result.model_id ? `：${result.model_id}` : ''}。`); await ctx.refresh();
      };
      const batchAction = async ctx => {
        const modelIds = await selectModels(ctx);
        if (!modelIds.length) return;
        const action = await ctx.choose('批量管理个人模型', [{ label: '全部启用', value: 'enable' }, { label: '全部停用', value: 'disable' }, { label: '批量编辑字段', value: 'edit' }, { label: '批量删除', value: 'delete' }], { description: `已选择 ${modelIds.length} 个模型` });
        if (!action) return;
        if (action === 'enable' || action === 'disable') {
          const enabled = action === 'enable';
          if (!await ctx.confirm(enabled ? '批量启用模型' : '批量停用模型', `将${enabled ? '启用' : '停用'} ${modelIds.length} 个我的模型。`)) return;
          const result = await runtime.client.post('/api/user/my-team-models/batch-update', { modelIds, updates: { enabled } });
          ctx.notify(`已更新 ${result.updated || 0} 个模型。`); await ctx.refresh(); return;
        }
        if (action === 'delete') {
          if (!await ctx.confirm('批量删除个人模型', `删除 ${modelIds.length} 个模型？关联团队和 API Key 模型授权也会清除，且不可恢复。`)) return;
          const result = await runtime.client.post('/api/user/my-team-models/batch-delete', { modelIds });
          ctx.notify(`已删除 ${result.deleted || 0} 个模型。`); await ctx.refresh(); return;
        }
        const fieldOptions = [
          { label: '设置启用状态', value: 'enabled' }, { label: '设置系列', value: 'series' }, { label: '设置说明', value: 'description' },
          { label: '设置显示名称/别名', value: 'alias' }, { label: '设置输入价格（人民币/千Token）', value: 'input_price_per_1k_tokens' }, { label: '设置输出价格（人民币/千Token）', value: 'output_price_per_1k_tokens' },
          { label: '完成字段选择', value: '__done__' },
        ];
        const updates = {};
        while (true) {
          const field = await ctx.choose('选择要批量修改的字段', fieldOptions, { description: '可连续选择多个字段；未选择的字段保持不变。' });
          if (!field || field === '__done__') break;
          if (field === 'enabled') {
            const enabled = await ctx.choose('模型启用状态', [{ label: '启用', value: true }, { label: '停用', value: false }]);
            if (enabled !== null) updates.enabled = enabled;
          } else {
            const labels = { series: '系列名称', description: '模型说明', alias: '显示名称/别名', input_price_per_1k_tokens: '输入价格（人民币/1,000 Token）', output_price_per_1k_tokens: '输出价格（人民币/1,000 Token）' };
            const value = await ctx.ask(labels[field], { description: '留空将清空此字段（价格除外）。' });
            if (value === null) continue;
            if (field.endsWith('_price_per_1k_tokens')) {
              if (!String(value).trim() || !Number.isFinite(Number(value)) || Number(value) < 0) { await ctx.show('价格无效', '请输入大于或等于 0 的数字。'); continue; }
              updates[field] = Number(value);
            } else updates[field] = String(value);
          }
        }
        if (!Object.keys(updates).length) return;
        if (!await ctx.confirm('批量更新个人模型', `更新 ${modelIds.length} 个模型：\n${describeUpdates(updates)}\n价格修改会影响计费。`)) return;
        const result = await runtime.client.post('/api/user/my-team-models/batch-update', { modelIds, updates });
        ctx.notify(`已更新 ${result.updated || 0} 个模型。`); await ctx.refresh();
      };
      return {
        sections: [
          { title: '供应商', tab: 'providers', toolbar: true, toolbarLabel: '搜索、筛选与操作', tableMinWidth: 112, columns: [
            { key: 'name', label: '名称', ratio: 0.16 }, { key: 'base_url', label: 'Base URL', ratio: 0.24 }, { key: 'format', label: '格式', ratio: 0.12 },
            { key: 'status', label: '状态', ratio: 0.1 }, { key: 'ping', label: '延迟', ratio: 0.1 }, { key: 'model_count', label: '模型数', ratio: 0.1 }, { key: 'actions', label: '操作', ratio: 0.18 },
          ], description: `${visibleProviders.length}/${providers.length} 个供应商 · 状态：${providerStatus === 'all' ? '全部' : providerStatus === 'enabled' ? '已启用' : '已禁用'}${providerQuery ? ` · 搜索 ${providerQuery}` : ''}`, cards: [
            { label: '我的供应商', value: `${providers.length} 个` }, { label: '已启用', value: `${providers.filter(item => item.enabled !== false).length} 个` },
            { label: '已配置模型', value: `${providers.reduce((sum, item) => sum + Number(item.model_count || 0), 0)} 个` },
            { label: '连通性已测', value: `${providers.filter(item => Object.hasOwn(runtime.myUpstreamPing || {}, String(item.id))).length}/${providers.length}` },
          ], rows: visibleProviders.length ? visibleProviders.map(item => ({ label: item.name || item.id, cells: { name: item.name || item.id, base_url: item.base_url || '—', format: ({ openai: 'OpenAI 兼容', anthropic: 'Anthropic', responses: 'Responses', gemini: 'Gemini' })[item.format] || item.format || '未指定', status: item.enabled === false ? '已禁用' : '已启用', ping: runtime.myUpstreamPing?.[String(item.id)]?.ok ? `${runtime.myUpstreamPing[String(item.id)].latency_ms ?? '—'} 毫秒` : '未检测', model_count: `${item.model_count || 0} 个`, actions: 'Enter 管理' }, detail: display(item.id, item.notes), run: async ctx => { const choice = await ctx.choose(`供应商 · ${item.name || item.id}`, [{ label: '查看详情', value: 'detail' }, { label: '管理供应商模型', value: 'models' }, { label: '管理附加接口', value: 'endpoints' }, { label: '编辑供应商', value: 'edit' }, { label: '同步模型', value: 'sync' }, { label: '检测连通性', value: 'ping' }, { label: '删除供应商', value: 'delete' }], { description: item.base_url || '' }); if (choice === 'detail') await ctx.show(`供应商 · ${item.name || item.id}`, providerDetail(item)); if (choice === 'models') await manageProviderModels(ctx, item); if (choice === 'endpoints') await manageProviderEndpoints(ctx, item); if (choice === 'edit') { const values = await ctx.form('编辑我的上游供应商', [
            { name: 'name', label: '供应商名称', value: item.name || '' }, { name: 'base_url', label: 'Base URL', value: item.base_url || '' },
            { name: 'format', label: 'API 格式', value: item.format || 'openai', options: API_FORMATS },
            { name: 'notes', label: '备注', value: item.notes || '' }, { name: 'enabled', label: '启用', type: 'boolean', value: item.enabled !== false },
            { name: 'models_url', label: '模型列表 URL（可空）', value: item.models_url || '' }, { name: 'test_user_agent', label: '测试 User-Agent（可空）', value: item.test_user_agent || '' },
            { name: 'forward_headers', label: '转发请求头', type: 'boolean', value: item.forward_headers !== false }, { name: 'api_key', label: 'API Key（留空保持现有）', secret: true },
          ]); if (!values) return; if (!String(values.name || '').trim() || !String(values.base_url || '').trim()) { await ctx.show('供应商信息不完整', '供应商名称和 Base URL 为必填项。'); return; } if (!await ctx.confirm('保存上游供应商', `${values.name}\n${values.base_url}\n${values.enabled ? '启用' : '停用'} · ${apiFormatLabel(values.format)}\nAPI Key 留空表示保留现有密钥。`)) return; const body = { name: values.name, base_url: values.base_url, format: values.format, notes: values.notes, enabled: values.enabled, models_url: values.models_url, test_user_agent: values.test_user_agent, forward_headers: values.forward_headers, ...(values.api_key ? { api_key: values.api_key } : {}) }; await runtime.client.put(`/api/user/providers/${encodeURIComponent(item.id)}`, body); ctx.notify('供应商已更新。'); await ctx.refresh(); } if (choice === 'sync') { if (!await ctx.confirm('同步供应商模型', `${item.name || item.id}\n从上游获取模型并导入你的团队（最多 100 个新模型）。`)) return; const result = await runtime.client.post(`/api/user/providers/${encodeURIComponent(item.id)}/refresh-models`, {}); await ctx.show('模型同步完成', `新导入 ${result.added || 0} 个模型；上游返回 ${result.total || 0} 个模型。`); await ctx.refresh(); } if (choice === 'delete') { if (!await ctx.confirm('删除我的上游供应商', `删除「${item.name || item.id}」及其全部 ${item.model_count || 0} 个模型？此操作不可撤销。`)) return; await runtime.client.delete(`/api/user/providers/${encodeURIComponent(item.id)}`); ctx.notify('供应商及关联模型已删除。'); await ctx.refresh(); } if (choice === 'ping') { const result = await pingProvider(runtime.client, item.id); runtime.myUpstreamPing = { ...(runtime.myUpstreamPing || {}), [String(item.id)]: result }; await ctx.show('连通性检测', result?.ok ? `连接成功 · 响应时间 ${result.latency_ms ?? '—'} 毫秒${result.note ? `\n${result.note}` : ''}` : `连接失败 · ${result?.error || '未知错误'}`); } } })) : [{ label: providersResult.status === 'rejected' ? providersResult.reason.message : '暂无我的上游供应商。' }] },
          { title: '我的模型', tab: 'models', toolbar: true, tableMinWidth: 120, columns: [
            { key: 'name', label: '模型名称', ratio: 0.17 }, { key: 'upstream_id', label: '上游模型 ID', ratio: 0.16 }, { key: 'provider', label: '供应商', ratio: 0.13 },
            { key: 'series', label: '系列', ratio: 0.08 }, { key: 'multiplier', label: '倍率', ratio: 0.08 }, { key: 'status', label: '状态', ratio: 0.08 }, { key: 'description', label: '说明', ratio: 0.15 }, { key: 'actions', label: '操作', ratio: 0.15 },
          ], description: `${visibleModels.length}/${models.length} 个模型${modelQuery ? ` · 搜索 ${modelQuery}` : ''}`, rows: visibleModels.length ? visibleModels.map(item => ({
            label: item.alias || item.name || item.id,
            cells: { name: item.alias || item.name || item.id, upstream_id: item.upstream_model_id || item.name || item.id, provider: item.provider_name || item.provider || '—', series: item.series || '—', multiplier: `×${Number(item.model_multiplier || 1).toFixed(2)}`, status: item.enabled === false ? '已停用' : '已启用', description: item.description || '—', actions: '编辑 / 删除' },
            detail: item.description,
            run: async ctx => {
            const choice = await ctx.choose(`模型 · ${item.alias || item.name || item.id}`, [{ label: '查看详情', value: 'detail' }, { label: '编辑模型', value: 'edit' }, { label: '删除模型', value: 'delete' }]);
            if (choice === 'detail') await ctx.show(`模型详情 · ${item.alias || item.name || item.id}`, personalModelDetail(item));
            if (choice === 'edit') {
              const values = await ctx.form('编辑个人模型', [
                { name: 'upstream_model_id', label: '上游模型 ID', value: item.upstream_model_id || item.name || item.id },
                { name: 'alias', label: '显示名称/别名', value: item.alias || '' }, { name: 'description', label: '说明', value: item.description || '' },
                { name: 'series', label: '系列', value: item.series || '' }, { name: 'enabled', label: '启用模型', type: 'boolean', value: item.enabled !== false },
                { name: 'input_price_per_1k_tokens', label: '输入价格（人民币/1,000 Token）', value: String(item.input_price_per_1k_tokens || 0) },
                { name: 'output_price_per_1k_tokens', label: '输出价格（人民币/1,000 Token）', value: String(item.output_price_per_1k_tokens || 0) },
                { name: 'cached_output_price_per_1k_tokens', label: '缓存输出价格（人民币/1,000 Token）', value: String(item.cached_output_price_per_1k_tokens || 0) },
                { name: 'reference_input_price_per_1k_tokens', label: '参考输入价格（人民币/1,000 Token）', value: String(item.reference_input_price_per_1k_tokens || 0) },
                { name: 'reference_output_price_per_1k_tokens', label: '参考输出价格（人民币/1,000 Token）', value: String(item.reference_output_price_per_1k_tokens || 0) },
                { name: 'rate_limit_rpm', label: '每分钟最大请求数（不限制填 0）', value: String(item.rate_limit_rpm || 0) }, { name: 'rate_limit_tpm', label: '每分钟最大 Token 数（不限制填 0）', value: String(item.rate_limit_tpm || 0) },
                { name: 'model_multiplier', label: '计费倍率', value: String(item.model_multiplier || 1) }, { name: 'completion_multiplier', label: '补全倍率', value: String(item.completion_multiplier || 1) },
                { name: 'thinking_model_id', label: '思考模式模型 ID（可空）', value: item.thinking_model_id || '' }, { name: 'non_thinking_model_id', label: '普通模式模型 ID（可空）', value: item.non_thinking_model_id || '' },
              ]);
              if (!values) return;
              const numeric = ['input_price_per_1k_tokens', 'output_price_per_1k_tokens', 'cached_output_price_per_1k_tokens', 'reference_input_price_per_1k_tokens', 'reference_output_price_per_1k_tokens', 'rate_limit_rpm', 'rate_limit_tpm', 'model_multiplier', 'completion_multiplier'];
              const body = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, numeric.includes(name) ? (Number(value) || 0) : value]));
              const rateLabels = ['输入价格', '输出价格', '缓存输出价格', '参考输入价格', '参考输出价格'];
              const rates = numeric.slice(0, 5).map((name, index) => `${rateLabels[index]}：${body[name]} 人民币/1,000 个 Token`).join('\n');
              if (!await ctx.confirm('保存个人模型更改', `${item.alias || item.name || item.id}\n${body.enabled ? '启用' : '停用'} · 系列 ${body.series || '无'} · ${modelMultiplierLabel(body.model_multiplier)}\n${rates}\n停用或改价可能影响 API Key 用户及计费。`)) return;
              await runtime.client.put(`/api/user/models/${encodeURIComponent(item.id)}`, body);
              ctx.notify('个人模型已更新。'); await ctx.refresh();
            }
            if (choice === 'delete') {
              if (!await ctx.confirm('删除个人模型', `确定删除「${item.alias || item.name || item.id}」？删除会同步清除关联团队和 API Key 模型授权，且不可恢复。`)) return;
              await runtime.client.delete(`/api/user/models/${encodeURIComponent(item.id)}`);
              ctx.notify('个人模型已删除。'); await ctx.refresh();
            }
          } })) : [{ label: modelsResult.status === 'rejected' ? modelsResult.reason.message : '暂无我的模型。' }] },
        ],
        actions: [
          { label: '搜索我的供应商', toolbar: true, tab: 'providers', run: async ctx => { runtime.myUpstreamProviderSearch = String(await ctx.ask('供应商名称、ID 或地址', { defaultValue: runtime.myUpstreamProviderSearch || '' }) || '').trim(); await ctx.refresh(); } },
          { label: '筛选供应商状态', toolbar: true, tab: 'providers', run: async ctx => { const value = await ctx.choose('供应商状态', [{ label: '全部状态', value: 'all' }, { label: '仅已启用', value: 'enabled' }, { label: '仅已禁用', value: 'disabled' }]); if (value !== null) { runtime.myUpstreamProviderStatus = value; await ctx.refresh(); } } },
          { label: '添加供应商', toolbar: true, tab: 'providers', run: async ctx => { let directory = []; try { directory = await runtime.client.get('/api/user/providers/lookup-index'); } catch (_) {} const selected = await ctx.choose('选择供应商类型', [{ label: '手动填写自定义供应商', value: '__custom__' }, ...directory.map(item => ({ label: `${item.name} · ${item.base_url}`, value: item.id }))]); if (selected === null) return; const preset = directory.find(item => item.id === selected); const values = await ctx.form(preset ? `添加供应商 · ${preset.name}` : '添加自定义供应商', [
            { name: 'name', label: '供应商名称', value: preset?.name || '' }, { name: 'base_url', label: 'Base URL', value: preset?.base_url || '' },
            { name: 'format', label: 'API 格式', value: String(selected).includes('anthropic') ? 'anthropic' : 'openai', options: API_FORMATS },
            { name: 'api_key', label: 'API Key（可选）', secret: true }, { name: 'models_url', label: '模型列表 URL（可选）' }, { name: 'notes', label: '备注（可选）' },
          ]); if (!values) return; if (!String(values.name || '').trim() || !String(values.base_url || '').trim()) { await ctx.show('供应商信息不完整', '名称和 Base URL 为必填项。'); return; } if (!await ctx.confirm('添加上游供应商', `名称：${values.name}\n地址：${values.base_url}\n接口格式：${apiFormatLabel(values.format)}\n服务器可能会自动导入最多 50 个模型。`)) return; const body = { name: values.name, base_url: values.base_url, format: values.format, ...(values.api_key ? { api_key: values.api_key } : {}), ...(values.models_url ? { models_url: values.models_url } : {}), ...(values.notes ? { notes: values.notes } : {}) }; const result = await runtime.client.post('/api/user/providers', body); ctx.notify(`供应商已添加${result.provider_id ? `：${result.provider_id}` : ''}。`); await ctx.refresh(); } },
          { label: '检测本页供应商', toolbar: true, tab: 'providers', run: async ctx => { const targets = visibleProviders.filter(item => item.enabled !== false); if (!targets.length) { await ctx.show('供应商连通性检测', '当前筛选中没有已启用的供应商。'); return; } const results = await Promise.allSettled(targets.map(item => pingProvider(runtime.client, item.id))); const current = { ...(runtime.myUpstreamPing || {}) }; results.forEach((result, index) => { current[String(targets[index].id)] = result.status === 'fulfilled' ? result.value : { ok: false, error: result.reason?.message || '检测失败' }; }); runtime.myUpstreamPing = current; await ctx.show('供应商连通性结果', targets.map(item => { const result = current[String(item.id)]; return `${item.name} · ${result?.ok ? `连接成功 · 响应时间 ${result.latency_ms ?? '—'} 毫秒` : `连接失败 ${result?.error || '未知错误'}`}`; }).join('\n')); await ctx.refresh(); } },
          { label: '批量管理供应商', toolbar: true, tab: 'providers', run: async ctx => { const selectedIds = new Set(); while (true) { const choices = await ctx.choose('选择我的上游供应商', [...visibleProviders.map(item => ({ label: `${selectedIds.has(String(item.id)) ? '☑' : '☐'} ${item.name} · ${item.model_count || 0} 个模型`, value: String(item.id) })), { label: `全选当前筛选的 ${visibleProviders.length} 个`, value: '__all__' }, { label: '清空选择', value: '__clear__' }, { label: `完成选择（${selectedIds.size} 个）`, value: '__done__' }]); if (choices === null) return; if (choices === '__done__') break; if (choices === '__all__') visibleProviders.forEach(item => selectedIds.add(String(item.id))); else if (choices === '__clear__') selectedIds.clear(); else if (selectedIds.has(choices)) selectedIds.delete(choices); else selectedIds.add(choices); } const targets = visibleProviders.filter(item => selectedIds.has(String(item.id))); if (!targets.length) return; const operation = await ctx.choose('批量供应商操作', [{ label: '批量同步模型', value: 'sync' }, { label: '批量删除供应商', value: 'delete' }], { description: `已选择 ${targets.length} 个供应商` }); if (!operation) return; if (operation === 'sync') { if (!await ctx.confirm('批量同步模型', `从 ${targets.length} 个上游获取模型并导入你的团队。`)) return; let succeeded = 0; for (const item of targets) { try { await runtime.client.post(`/api/user/providers/${encodeURIComponent(item.id)}/refresh-models`, {}); succeeded++; } catch (_) {} } ctx.notify(`模型同步完成：${succeeded}/${targets.length} 个供应商成功。`); await ctx.refresh(); } else { if (!await ctx.confirm('批量删除供应商', `删除 ${targets.length} 个供应商及其所有关联模型？此操作不可撤销。`)) return; let succeeded = 0; for (const item of targets) { try { await runtime.client.delete(`/api/user/providers/${encodeURIComponent(item.id)}`); succeeded++; } catch (_) {} } ctx.notify(`删除完成：${succeeded}/${targets.length} 个供应商。`); await ctx.refresh(); } } },
          { label: '添加模型', toolbar: true, tab: 'models', run: addPersonalModel },
          { label: '搜索我的模型', toolbar: true, tab: 'models', run: async ctx => { runtime.myUpstreamModelSearch = String(await ctx.ask('模型名称、ID、上游 ID、供应商或系列', { defaultValue: runtime.myUpstreamModelSearch || '' }) || '').trim(); await ctx.refresh(); } },
          { label: '批量管理个人模型', toolbar: true, tab: 'models', run: batchAction },
          { label: '清除模型搜索', toolbar: true, tab: 'models', run: async ctx => { runtime.myUpstreamModelSearch = ''; await ctx.refresh(); } },
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
        detail: `${item.id} · 输入 ${Number(item.input_price_per_1k_tokens || item.input_price || 0).toFixed(4)} 人民币/千Token · 输出 ${Number(item.output_price_per_1k_tokens || item.output_price || 0).toFixed(4)} 人民币/千Token`,
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
            await ctx.show('模型测试', result && result.ok ? `通过 · 响应时间 ${result.latency_ms || 0} 毫秒` : `失败：${result && result.error ? result.error : '未知错误'}`);
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
          description: `来源：${data.scope === 'admin' ? '管理员全量' : '当前团队可见'}${runtime.modelSearch ? ` · 搜索：${runtime.modelSearch}` : ''} · 第 ${data.page || runtime.modelPage} 页`,
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

async function loadPermissionCatalog(runtime) {
  const catalog = await runtime.client.get('/js/api-key-permissions.json?v=1');
  if (!catalog || !Array.isArray(catalog.groups)) throw new Error('服务器未提供 API Key 权限目录');
  return {
    groups: catalog.groups.filter(group => group && Array.isArray(group.permissions)).map(group => ({
      id: group.id, name: group.name || group.id, description: group.description || '',
      permissions: group.permissions.filter(permission => permission && permission.id).map(permission => ({ ...permission, adminOnly: permission.adminOnly === true })),
    })),
    defaultPermissions: catalog.groups.filter(group => group.id === 'gateway').flatMap(group => arrayOrEmpty(group.permissions).map(permission => permission.id)),
  };
}

function arrayOrEmpty(value) { return Array.isArray(value) ? value : []; }

async function chooseApiKeyPermissions(ctx, catalog, currentPermissions = []) {
  const all = catalog.groups.flatMap(group => group.permissions.map(permission => ({ ...permission, groupName: group.name })));
  const enabled = new Set(currentPermissions);
  for (;;) {
    const options = [
      ...catalog.groups.map(group => ({ label: `分类：${group.name}（${group.permissions.filter(permission => enabled.has(permission.id)).length}/${group.permissions.length} 已选）`, value: `group:${group.id}` })),
      { label: `查看已选权限（${enabled.size}）`, value: '__selected__' },
      { label: '完成权限选择', value: '__done__' },
    ];
    const selected = await ctx.choose('API Key 权限目录', options, { description: '按网页权限目录分类，选择分类后逐项切换；新建 Key 默认启用模型网关权限。' });
    if (!selected || selected === '__done__') break;
    if (selected === '__selected__') {
      const chosen = all.filter(permission => enabled.has(permission.id));
      await ctx.show('已选权限', chosen.length ? chosen.map(permission => `${permission.groupName} · ${permission.name}（${permission.id}）`).join('\\n') : '当前没有显式授权项。');
      continue;
    }
    const group = catalog.groups.find(item => selected === `group:${item.id}`);
    if (!group) continue;
    for (;;) {
      const permissionChoices = group.permissions.map(permission => ({
        label: `${enabled.has(permission.id) ? '✓' : '○'} ${permission.name}${permission.adminOnly ? ' · 仅管理员' : ''}`,
        value: permission.id,
      }));
      permissionChoices.push({ label: '返回权限分类', value: '__back__' });
      const permissionId = await ctx.choose(`权限分类 · ${group.name}`, permissionChoices, { description: group.description || '选择权限项以切换授权状态；操作只修改本地待保存选择。' });
      if (!permissionId || permissionId === '__back__') break;
      if (enabled.has(permissionId)) enabled.delete(permissionId); else enabled.add(permissionId);
    }
  }
  return [...enabled];
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
      const keySearch = String(runtime.apiKeySearch || '').toLowerCase();
      const keys = allKeys.filter(key => {
        const matchTag = !activeTag || (Array.isArray(key.tags) && key.tags.some(tag => String(tag.id) === String(activeTag)));
        const matchSearch = !keySearch || [key.name, key.key_prefix, key.current_model_name, key.current_model_id, key.owner?.username, ...(key.tags || []).map(tag => tag.name), ...(key.members || []).map(member => member.username)].some(value => String(value || '').toLowerCase().includes(keySearch));
        return matchTag && matchSearch;
      });
      const authorizations = authorizationsResult.status === 'fulfilled' && Array.isArray(authorizationsResult.value?.authorizations) ? authorizationsResult.value.authorizations : [];
      const rows = keys.map(key => {
        const expired = key.expires_at && new Date(key.expires_at).getTime() <= Date.now();
        const daysLeft = key.expires_at ? Math.ceil((new Date(key.expires_at).getTime() - Date.now()) / 86400000) : null;
        const status = key.enabled === false ? '已停用' : expired ? '已过期' : daysLeft !== null && daysLeft <= 7 ? `${Math.max(daysLeft, 0)} 天后过期` : '有效';
        return {
        label: key.name || '未命名',
        cells: {
          name: key.name || '未命名', masked_key: key.key_prefix ? `${key.key_prefix}••••` : (key.is_owner === false ? '仅创建者可查看' : '未返回密钥前缀'),
          status, model: key.current_model_name || key.current_model_id || '未绑定模型',
          requests: `${Number(key.total_requests || 0).toLocaleString()} 次`, tokens: `${formatBigNumber(key.total_tokens)} Token`,
          points: `${formatCost(key.total_cost)} 积分`, expires: key.expires_at ? formatTime(key.expires_at) : '永不过期',
          actions: key.is_owner === true ? 'Enter 管理' : 'Enter 查看',
        },
        detail: `创建于 ${formatTime(key.created_at)} · 最后使用 ${formatTime(key.last_used_at)}${key.is_owner === false ? ' · 共同使用的 Key' : ''}${Array.isArray(key.members) && key.members.length ? ` · ${key.members.length} 位共同成员` : ''}${Array.isArray(key.tags) && key.tags.length ? ` · 标签 ${key.tags.map(tag => tag.name).join('、')}` : ''}`,
        run: async ctx => {
          const actions = [
            { label: '查看详情', value: 'detail' },
            ...(key.is_owner === true ? [{ label: '设置标签', value: 'tags' }, { label: `管理共同成员（${Array.isArray(key.members) ? key.members.length : 0}）`, value: 'members' }, { label: '管理 API Key 权限', value: 'permissions' }] : []),
            ...(key.is_owner === true ? [{ label: '查看 Claude Code 配置（包含 Key 明文）', value: 'config' }] : []),
            { label: 'API Key 附加选项', value: 'options' },
            { label: 'API Key 签名设置', value: 'signature' },
            { label: key.enabled === false ? '启用 Key' : '停用 Key', value: 'toggle' },
            { label: '重命名', value: 'rename' },
            { label: '删除 Key', value: 'delete' },
          ];
          const choice = await ctx.choose('API Key 操作', actions, { description: key.name || key.key_prefix || `Key ${key.id}` });
          if (choice === 'detail') {
            const permissions = key.permissions;
            const permissionSummary = Array.isArray(permissions) ? permissions.join('、') : permissions && typeof permissions === 'object' ? Object.entries(permissions).filter(([, enabled]) => enabled === true).map(([name]) => name).join('、') : '';
            const memberList = Array.isArray(key.members) ? key.members : [];
            await ctx.show(`API Key 详情 · ${key.name || key.id}`, [
              `名称：${key.name || '未命名'}`, `Key 掩码：${key.key_prefix ? `${key.key_prefix}••••` : key.is_owner === false ? '仅创建者可查看' : '未返回前缀'}`,
              `状态：${key.enabled === false ? '已停用' : '已启用'}`, `身份：${key.is_owner === false ? '共同成员访问' : 'Key 发起者'}`,
              `当前模型：${key.current_model_name || key.current_model_id || '未绑定模型'}`, `权限范围：${permissionSummary || '使用默认权限'}`,
              `调用次数：${Number(key.total_requests || 0).toLocaleString()} 次`, `Token 消耗：${formatBigNumber(key.total_tokens)} Token`, `积分消耗：${formatCost(key.total_cost)} 积分`,
              `创建时间：${formatTime(key.created_at)}`, `最后使用：${formatTime(key.last_used_at)}`, `有效期：${key.expires_at ? formatTime(key.expires_at) : '永不过期'}`,
              `标签：${Array.isArray(key.tags) && key.tags.length ? key.tags.map(tag => tag.name).join('、') : '无'}`,
              key.is_owner === true && `共同成员：${memberList.length ? memberList.map(member => `${member.username || '未知'}（${member.email || '无邮箱'}）`).join('、') : '无'}`,
            ].filter(Boolean).join('\\n'));
          }
          else if (choice === 'permissions') {
            if (key.is_owner !== true) { await ctx.show('权限不可修改', '只有 API Key 发起者可以修改权限。'); return; }
            let catalog;
            try { catalog = await loadPermissionCatalog(runtime); }
            catch (error) { await ctx.show('权限目录不可用', `无法加载服务器提供的权限目录：${error.message}`); return; }
            const permissions = await chooseApiKeyPermissions(ctx, catalog, Array.isArray(key.permissions) ? key.permissions : []);
            if (!await ctx.confirm('保存 API Key 权限', `${key.name || key.key_prefix}\n显式授权 ${permissions.length} 项；关闭全部权限后，此 Key 将无法调用任何接口。`)) return;
            await runtime.client.put(`/api/user/api-keys/${encodeURIComponent(key.id)}`, { permissions });
            ctx.notify('API Key 权限已保存。'); await ctx.refresh();
          } else if (choice === 'options') {
            const quotaResult = await runtime.client.get(`/api/user/api-keys/${encodeURIComponent(key.id)}/quota-warning`).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
            const current = {
              quota_warning_enabled: quotaResult.status === 'fulfilled' ? quotaResult.value.quota_warning_enabled === true : key.quota_warning_enabled === true,
              swallow_images: key.swallow_images === true, crewrouter_commands: key.crewrouter_commands === true,
            };
            const fields = [
              { name: 'quota_warning_enabled', label: '额度预警', type: 'boolean', value: current.quota_warning_enabled },
              { name: 'swallow_images', label: '吞图（不向上游转发图片）', type: 'boolean', value: current.swallow_images },
              { name: 'crewrouter_commands', label: '允许 @CrewRouter 指令', type: 'boolean', value: current.crewrouter_commands },
            ];
            const values = await ctx.form('API Key 附加选项', fields, { description: '修改只影响此 API Key。' });
            if (!values) return;
            const changed = fields.filter(field => values[field.name] !== current[field.name]);
            if (!changed.length) { await ctx.show('API Key 选项', '选项未发生变化。'); return; }
            if (!await ctx.confirm('保存 API Key 选项', `${changed.map(field => `${field.label}：${values[field.name] ? '开启' : '关闭'}`).join('\\n')}\\n以上选项将立即影响此 Key 的请求处理。`)) return;
            const endpoints = { quota_warning_enabled: 'quota-warning', swallow_images: 'swallow-images', crewrouter_commands: 'crewrouter-commands' };
            for (const field of changed) await runtime.client.put(`/api/user/api-keys/${encodeURIComponent(key.id)}/${endpoints[field.name]}`, { [field.name]: values[field.name] });
            ctx.notify('API Key 选项已更新。'); await ctx.refresh();
          } else if (choice === 'signature') {
            let signature;
            try { signature = await runtime.client.get(`/api/user/api-keys/${encodeURIComponent(key.id)}/signature`); }
            catch (error) { await ctx.show('签名配置读取失败', error.message || '无法读取此 API Key 的签名配置。'); return; }
            if (!signature.inherited || !signature.effective) { await ctx.show('签名配置异常', '服务器未返回完整的签名继承配置，为防止覆盖现有设置，未开放保存。'); return; }
            const modeValue = signature.enabled == null ? 'inherit' : signature.enabled ? 'enable' : 'disable';
            const mode = await ctx.choose('签名模式', [
              { label: `继承用户默认${signature.user_signature_enabled ? '（当前默认开启）' : '（当前默认关闭）'}`, value: 'inherit' },
              { label: '强制启用', value: 'enable' }, { label: '强制禁用', value: 'disable' },
            ], { description: '启用状态和模板分别继承；模板留空表示使用用户默认模板。' });
            if (mode === null) return;
            const template = await ctx.ask('自定义签名模板（留空使用用户模板）', { defaultValue: signature.template || '', description: '最多 2000 个字符；签名可能被追加到转发请求。' });
            if (template === null) return;
            if ([...template].length > 2000) { await ctx.show('签名模板过长', '签名模板最多 2000 个字符。'); return; }
            const enabled = mode === 'inherit' ? null : mode === 'enable';
            if (!await ctx.confirm('保存 API Key 签名设置', `模式：${mode === 'inherit' ? '继承用户默认' : mode === 'enable' ? '强制启用' : '强制禁用'}\\n模板：${template.trim() || '使用用户默认模板'}`)) return;
            await runtime.client.put(`/api/user/api-keys/${encodeURIComponent(key.id)}/signature`, { enabled, template: template.trim() || null });
            ctx.notify('API Key 签名设置已保存。'); await ctx.refresh();
          } else if (choice === 'members') {
            let membersResult = await runtime.client.get(`/api/user/api-keys/${encodeURIComponent(key.id)}/members`);
            for (;;) {
              const members = Array.isArray(membersResult.members) ? membersResult.members : [];
              const memberChoices = [
                { label: '查看成员列表', value: 'list' },
                { label: '添加共同成员', value: 'add' },
                ...(members.length ? [{ label: '移除共同成员', value: 'remove' }] : []),
                { label: '完成', value: 'done' },
              ];
              const memberAction = await ctx.choose(`共同成员 · ${key.name || key.key_prefix}`, memberChoices, { description: members.length ? `${members.length} 位成员：${members.map(member => member.username).join('、')}` : '目前没有共同成员。只有 Key 发起者可以添加或移除成员。' });
              if (!memberAction || memberAction === 'done') break;
              if (memberAction === 'list') {
                await ctx.show('共同成员列表', members.length ? members.map((member, index) => `${index + 1}. ${member.username || '未知用户'} · ${member.email || '无邮箱'} · ${formatTime(member.created_at)}`).join('\n') : '暂无共同成员。');
              } else if (memberAction === 'add') {
                const identity = String(await ctx.ask('完整用户名或邮箱') || '').trim();
                if (!identity || !await ctx.confirm('添加共同成员', `${key.name || key.key_prefix}\n成员：${identity}\n该成员将能查看并使用此 Key。`)) continue;
                await runtime.client.post(`/api/user/api-keys/${encodeURIComponent(key.id)}/members`, { identity });
                ctx.notify('共同成员已添加。');
                membersResult = await runtime.client.get(`/api/user/api-keys/${encodeURIComponent(key.id)}/members`);
                await ctx.refresh();
              } else if (memberAction === 'remove') {
                const selected = await ctx.choose('选择要移除的共同成员', members.map(member => ({ label: `${member.username || '未知用户'} · ${member.email || '无邮箱'}`, value: member.id })));
                if (selected === null) continue;
                const target = members.find(member => String(member.id) === String(selected));
                if (!target || !await ctx.confirm('移除共同成员', `移除 ${target.username || target.id} 后，其对该 API Key 的访问将立即失效。`)) continue;
                await runtime.client.delete(`/api/user/api-keys/${encodeURIComponent(key.id)}/members/${encodeURIComponent(selected)}`);
                ctx.notify('共同成员已移除。');
                membersResult = await runtime.client.get(`/api/user/api-keys/${encodeURIComponent(key.id)}/members`);
                await ctx.refresh();
              }
            }
          }
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
            if (key.is_owner !== true) { await ctx.show('配置不可查看', '只有 API Key 发起者可读取包含密钥明文的配置。'); return; }
            if (!await ctx.confirm('显示 Claude Code 配置', '即将显示包含 API Key 明文的环境变量。请确保周围没有其他人查看终端。')) return;
            const config = await getApiKeyConfig(runtime.client, key.id);
            const env = config.env || {};
            const lines = [
              `API 基础地址：${env.ANTHROPIC_BASE_URL || '未知'}`,
              `API Key 明文：${env.ANTHROPIC_AUTH_TOKEN || '服务器未返回'}`,
              `默认模型：${env.ANTHROPIC_MODEL || config.model || '未知'}`,
              `Haiku 模型：${env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '未设置'}`,
              `Sonnet 模型：${env.ANTHROPIC_DEFAULT_SONNET_MODEL || '未设置'}`,
              `Opus 模型：${env.ANTHROPIC_DEFAULT_OPUS_MODEL || '未设置'}`,
              `思考强度：${config.effortLevel || '未设置'}`,
            ];
            await ctx.show('Claude Code 环境变量（含密钥）', lines.join('\\n'));
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
      };
      });
      const totalRequests = allKeys.reduce((sum, key) => sum + Number(key.total_requests || 0), 0);
      const totalTokens = allKeys.reduce((sum, key) => sum + Number(key.total_tokens || 0), 0);
      const totalCost = allKeys.reduce((sum, key) => sum + Number(key.total_cost || 0), 0);
      const tagRows = [{ label: `${activeTag ? '✓ ' : ''}全部标签`, run: async ctx => { runtime.apiKeyTagFilter = ''; await ctx.refresh(); } }, ...tags.map(tag => ({ label: `${String(tag.id) === String(activeTag) ? '✓ ' : ''}${tag.name}`, detail: `颜色 ${tag.color || '默认'}`, run: async ctx => { runtime.apiKeyTagFilter = String(tag.id); await ctx.refresh(); } }))];
      return {
        sections: [
          { title: '我的 Key 用量概览', cards: [
            { label: '调用次数', value: totalRequests.toLocaleString() },
            { label: 'Token 消耗', value: formatBigNumber(totalTokens) },
            { label: '成本', value: formatCost(totalCost) },
          ] },
          { title: '标签筛选', rows: tagRows },
          {
            title: 'API Key',
            toolbar: true,
            tableMinWidth: 128,
            columns: [
              { key: 'name', label: '名称', ratio: 0.12 }, { key: 'masked_key', label: 'Key 掩码', ratio: 0.13 }, { key: 'status', label: '状态', ratio: 0.1 },
              { key: 'model', label: '当前模型', ratio: 0.14 }, { key: 'requests', label: '请求数', ratio: 0.09 }, { key: 'tokens', label: 'Token 消耗', ratio: 0.1 },
              { key: 'points', label: '积分消耗', ratio: 0.1 }, { key: 'expires', label: '有效期', ratio: 0.11 }, { key: 'actions', label: '操作', ratio: 0.11 },
            ],
            description: `可搜索名称、模型、标签和成员；共享 Key 的原始值受权限限制。显示 ${keys.length}/${allKeys.length}${activeTag ? ` · 标签 ${tags.find(tag => String(tag.id) === String(activeTag))?.name || activeTag}` : ''}${keySearch ? ` · 搜索 ${keySearch}` : ''}`,
            cards: [
              { label: '总数', value: allKeys.length, detail: '当前账号可见' },
              { label: '显示', value: keys.length, detail: '当前筛选' },
              { label: '启用', value: keys.filter(key => key.enabled !== false).length, detail: '可用 Key' },
              { label: '停用', value: keys.filter(key => key.enabled === false).length, detail: '不可调用' },
            ],
            rows: rows.length ? rows : [{ label: '暂无 API Key。' }],
          },
          {
            title: 'OAuth 授权',
            description: authorizations.length ? `${authorizations.length} 个客户端具有活跃授权。` : (authorizationsResult.status === 'rejected' ? '当前会话无法读取 OAuth 授权列表。' : '暂无活跃授权。'),
            rows: authorizations.map(auth => ({ label: `${auth.client_name || auth.name || 'OAuth 客户端'} · ${auth.client_id || ''}`, detail: `授权时间 ${formatTime(auth.created_at || auth.authorized_at)} · 范围 ${(auth.scopes || []).join(', ') || '默认'}`, run: async ctx => { if (!await ctx.confirm('吊销 OAuth 授权', `${auth.client_name || auth.name || auth.client_id}\n吊销后该客户端的所有访问令牌立即失效。`)) return; await runtime.client.post('/oauth/authorizations/revoke', { id: Number(auth.id) }); ctx.notify('OAuth 授权已吊销。'); await ctx.refresh(); } })),
          },
        ],
        actions: [
          { label: keySearch ? '清除 Key 搜索' : '搜索 API Key', toolbar: true, run: async ctx => { runtime.apiKeySearch = keySearch ? '' : String(await ctx.ask('搜索 Key 名称、模型、标签或成员', { defaultValue: runtime.apiKeySearch || '' }) || '').trim(); await ctx.refresh(); } },
          { label: '新建/编辑 Key 标签', run: async ctx => { const choice = await ctx.choose('API Key 标签管理', [{ label: '新建标签', value: 'create' }, ...tags.map(tag => ({ label: `编辑 ${tag.name}`, value: `edit:${tag.id}` })), ...tags.map(tag => ({ label: `删除 ${tag.name}`, value: `delete:${tag.id}` }))]); if (!choice) return; if (choice === 'create') { const values = await ctx.form('新建 Key 标签', [{ name: 'name', label: '名称' }, { name: 'color', label: '颜色', value: '#3b82f6' }]); if (!values || !String(values.name || '').trim()) return; await runtime.client.post('/api/user/key-tags', values); ctx.notify('标签已创建。'); await ctx.refresh(); return; } const [action, id] = choice.split(':'); const tag = tags.find(item => String(item.id) === id); if (action === 'edit') { const values = await ctx.form('编辑 Key 标签', [{ name: 'name', label: '名称', value: tag.name }, { name: 'color', label: '颜色', value: tag.color || '#3b82f6' }]); if (!values) return; await runtime.client.put(`/api/user/key-tags/${id}`, values); ctx.notify('标签已更新。'); await ctx.refresh(); } if (action === 'delete') { if (!await ctx.confirm('删除 Key 标签', `删除「${tag.name}」？关联的 Key 标签会一起移除。`)) return; await runtime.client.delete(`/api/user/key-tags/${id}`); ctx.notify('标签已删除。'); runtime.apiKeyTagFilter = ''; await ctx.refresh(); } } },
          { label: '新建 API Key', toolbar: true, run: async ctx => {
            const values = await ctx.form('新建 API Key', [
              { name: 'name', label: '名称', value: 'CrewRouter CLI' },
              { name: 'expiresIn', label: '有效小时数（留空永久）', value: '' },
              { name: 'customModelName', label: '自定义模型名（可选）', value: '' },
            ], { description: '创建后原始 Key 只显示一次。默认权限与服务器一致，仅开放模型网关调用。', submitLabel: '继续' });
            if (!values) return;
            let permissions;
            try {
              const catalog = await loadPermissionCatalog(runtime);
              permissions = await chooseApiKeyPermissions(ctx, catalog, catalog.defaultPermissions);
            } catch (error) { await ctx.show('API Key 权限目录不可用', `无法安全读取服务器权限目录，未创建 Key：${error.message}`); return; }
            if (!await ctx.confirm('确认创建 API Key', `名称：${values.name || 'CrewRouter CLI'}\\n有效期：${values.expiresIn ? `${values.expiresIn} 小时` : '永久'}\\n权限：${permissions.length} 项。原始 Key 只会显示一次，请安全保存。`)) return;
            const result = await runtime.client.post('/api/user/api-keys', {
              name: values.name || 'CrewRouter CLI',
              ...(values.expiresIn ? { expiresIn: Number(values.expiresIn) } : {}),
              ...(values.customModelName ? { customModelName: values.customModelName } : {}),
              permissions,
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
