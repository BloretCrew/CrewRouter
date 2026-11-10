'use strict';

const { createContext, ensureAuthenticated } = require('../context');
const {
  listProviders, pingProvider, toggleProvider, listModels, testModel,
  listApiKeys, createApiKey, toggleApiKey, renameApiKey, deleteApiKey, getApiKeyConfig,
} = require('../api');
const { printJson, success } = require('../output');
const {
  bold, dim, green, yellow, red, formatBigNumber, formatCost, formatTime, table,
} = require('../format');

async function providersCommand(args, { json = false } = {}) {
  const context = createContext(args);
  await ensureAuthenticated(context);
  const sub = args._[1];
  if (sub === 'ping') {
    const id = args._[2];
    if (!id) throw Object.assign(new Error('请提供供应商 ID：cr providers ping <ID>'), { code: 'PARSE_ERROR' });
    const result = await pingProvider(context.client, id);
    if (json) { printJson(success(context.profileName, result)); return result && result.ok ? 0 : 1; }
    if (result && result.ok) console.log(green(`连通：${result.latency_ms !== null && result.latency_ms !== undefined ? `${result.latency_ms} ms` : '成功'}`));
    else console.log(red(`失败：${result && result.error ? result.error : '未知错误'}`));
    if (result && result.note) console.log(dim(result.note));
    return result && result.ok ? 0 : 1;
  }
  if (sub === 'toggle') {
    const id = args._[2];
    if (!id) throw Object.assign(new Error('请提供供应商 ID：cr providers toggle <ID> --enabled|--disabled'), { code: 'PARSE_ERROR' });
    const enabled = args.enabled === true ? true : args.disabled === true ? false : null;
    if (enabled === null) throw Object.assign(new Error('必须指定 --enabled 或 --disabled'), { code: 'PARSE_ERROR' });
    const result = await toggleProvider(context.client, id, enabled);
    if (json) { printJson(success(context.profileName, result)); return 0; }
    console.log(green(`供应商 ${id} 已${enabled ? '启用' : '停用'}。`));
    return 0;
  }
  const data = await listProviders(context.client);
  if (json) { printJson(success(context.profileName, data)); return 0; }
  const stats = data.stats || {};
  console.log(bold(`供应商（${data.scope === 'admin' ? '管理员' : '可见'}）`));
  if (data.scope === 'admin') {
    console.log(`总数 ${stats.total ?? data.total} · 启用 ${stats.enabledCount ?? '未知'} · 全局 ${stats.globalCount ?? '未知'} · 用户 ${stats.userCount ?? '未知'}`);
  } else {
    console.log(`共 ${data.total} 个`);
  }
  if (!data.items.length) { console.log(dim('暂无供应商。')); return 0; }
  const rows = data.items.slice(0, 100).map(item => ({
    id: item.id,
    name: item.name,
    format: item.format || '',
    enabled: item.enabled === false ? '停用' : '启用',
    key: item.has_api_key === true ? '已配置' : item.has_api_key === false ? '无' : '',
    url: item.base_url || '',
  }));
  console.log(table(rows, [
    { label: 'ID', key: 'id', width: 14 },
    { label: '名称', key: 'name', width: 18 },
    { label: '格式', key: 'format', width: 8 },
    { label: '状态', key: 'enabled', width: 6 },
    { label: 'Key', key: 'key', width: 6 },
    { label: 'Base URL', key: 'url', width: 32 },
  ], { maxWidth: process.stdout.columns || 110 }));
  if (data.total > 100) console.log(dim(`仅显示前 100 个，共 ${data.total} 个。`));
  return 0;
}

async function modelsCommand(args, { json = false } = {}) {
  const context = createContext(args);
  await ensureAuthenticated(context);
  const sub = args._[1];
  if (sub === 'test') {
    const id = args._[2];
    if (!id) throw Object.assign(new Error('请提供模型 ID：cr models test <ID>'), { code: 'PARSE_ERROR' });
    if (!json) console.log(dim(`正在测试 ${id}…`));
    const result = await testModel(context.client, id);
    if (json) { printJson(success(context.profileName, result)); return result && result.ok ? 0 : 1; }
    if (result && result.ok) console.log(green(`测试通过 · ${result.latency_ms || 0} ms`));
    else console.log(red(`测试失败：${result && result.error ? result.error : '未知错误'}`));
    return result && result.ok ? 0 : 1;
  }
  const search = args.search || '';
  const data = await listModels(context.client, { search, page: Number(args.page) || 1, limit: 100 });
  if (json) { printJson(success(context.profileName, data)); return 0; }
  console.log(bold(`模型（${data.scope === 'admin' ? '管理员' : '当前 Team 可见'}）`));
  console.log(`共 ${data.total} 个${search ? ` · 搜索：${search}` : ''}`);
  if (!data.items.length) { console.log(dim('暂无模型。')); return 0; }
  const rows = data.items.slice(0, 100).map(item => ({
    id: item.id,
    name: item.name || item.alias || item.id,
    provider: item.provider_name || item.provider || '',
    enabled: item.enabled === false ? '停用' : '启用',
    input: Number(item.input_price_per_1k_tokens || 0).toFixed(4),
    output: Number(item.output_price_per_1k_tokens || 0).toFixed(4),
  }));
  console.log(table(rows, [
    { label: 'ID', key: 'id', width: 24 },
    { label: '名称', key: 'name', width: 20 },
    { label: '供应商', key: 'provider', width: 16 },
    { label: '状态', key: 'enabled', width: 6 },
    { label: '输入/1K', key: 'input', width: 10, align: 'right' },
    { label: '输出/1K', key: 'output', width: 10, align: 'right' },
  ], { maxWidth: process.stdout.columns || 110 }));
  if (data.total > 100) console.log(dim(`仅显示前 100 个，共 ${data.total} 个；可用 --search 缩小范围。`));
  return 0;
}

function keyRows(keys) {
  return keys.slice(0, 200).map(key => ({
    id: key.id,
    name: key.name || '',
    prefix: key.key_prefix || '',
    enabled: key.enabled === false ? '停用' : '启用',
    current: key.current_model_name || key.current_model_id || '',
    tokens: formatBigNumber(key.total_tokens),
    cost: formatCost(key.total_cost),
    last: formatTime(key.last_used_at),
  }));
}

async function keysCommand(args, { json = false } = {}) {
  const context = createContext(args);
  await ensureAuthenticated(context);
  const sub = args._[1] || 'list';
  if (sub === 'list') {
    const keys = await listApiKeys(context.client);
    if (json) { printJson(success(context.profileName, keys)); return 0; }
    console.log(bold(`API Key（${keys.length}）`));
    if (!keys.length) { console.log(dim('暂无 API Key。')); return 0; }
    console.log(table(keyRows(keys), [
      { label: 'ID', key: 'id', width: 5 },
      { label: '名称', key: 'name', width: 20 },
      { label: '前缀', key: 'prefix', width: 14 },
      { label: '状态', key: 'enabled', width: 6 },
      { label: '当前模型', key: 'current', width: 20 },
      { label: 'Token', key: 'tokens', width: 8, align: 'right' },
      { label: '费用', key: 'cost', width: 10, align: 'right' },
      { label: '最后使用', key: 'last', width: 20 },
    ], { maxWidth: process.stdout.columns || 120 }));
    return 0;
  }
  if (sub === 'create') {
    const name = args._[2] || args.name;
    if (!name) throw Object.assign(new Error('请提供 Key 名称：cr keys create <名称>'), { code: 'PARSE_ERROR' });
    const result = await createApiKey(context.client, {
      name,
      expiresIn: args['expires-in'] || args.expiresIn,
      customModelName: args.model,
    });
    if (json) { printJson(success(context.profileName, result)); return 0; }
    console.log(green(`API Key 已创建：${result.name || name}`));
    console.log(`ID：${result.id || '未知'}`);
    console.log(`Key：${result.key || result.key_value || '（响应未返回原始 Key）'}`);
    console.log(yellow('原始 Key 只显示这一次，请立即保存。'));
    return 0;
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = args._[2];
    if (!id) throw Object.assign(new Error(`请提供 Key ID：cr keys ${sub} <ID>`), { code: 'PARSE_ERROR' });
    const result = await toggleApiKey(context.client, id, sub === 'enable');
    if (json) { printJson(success(context.profileName, result)); return 0; }
    console.log(green(`Key ${id} 已${sub === 'enable' ? '启用' : '停用'}。`));
    return 0;
  }
  if (sub === 'rename') {
    const id = args._[2];
    const name = args._[3] || args.name;
    if (!id || !name) throw Object.assign(new Error('用法：cr keys rename <ID> <新名称>'), { code: 'PARSE_ERROR' });
    const result = await renameApiKey(context.client, id, name);
    if (json) { printJson(success(context.profileName, result)); return 0; }
    console.log(green(`Key ${id} 已重命名为「${name}」。`));
    return 0;
  }
  if (sub === 'delete') {
    const id = args._[2];
    if (!id) throw Object.assign(new Error('请提供 Key ID：cr keys delete <ID> --yes'), { code: 'PARSE_ERROR' });
    if (!args.yes) throw Object.assign(new Error('删除 API Key 需要 --yes 确认'), { code: 'PARSE_ERROR' });
    const result = await deleteApiKey(context.client, id);
    if (json) { printJson(success(context.profileName, result)); return 0; }
    console.log(green(`Key ${id} 已删除。`));
    return 0;
  }
  if (sub === 'config') {
    const id = args._[2];
    if (!id) throw Object.assign(new Error('请提供 Key ID：cr keys config <ID>'), { code: 'PARSE_ERROR' });
    const result = await getApiKeyConfig(context.client, id);
    if (json) { printJson(success(context.profileName, result)); return 0; }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  throw Object.assign(new Error(`未知 keys 子命令：${sub}`), { code: 'PARSE_ERROR' });
}

module.exports = { providersCommand, modelsCommand, keysCommand };
