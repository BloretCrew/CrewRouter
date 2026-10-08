'use strict';

const { decryptSecret } = require('./secret-crypto');

function parseCpaQuotaConfig(text) {
  let config;
  try { config = JSON.parse(text || '{}'); } catch { throw new Error('CPA 额度配置必须是 JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('CPA 额度配置必须是 JSON 对象');
  const pluginId = typeof config.plugin_id === 'string' ? config.plugin_id.trim() : '';
  const authIndex = typeof config.auth_index === 'string' ? config.auth_index.trim() : '';
  if (!pluginId || !authIndex) throw new Error('CPA 额度配置需要 plugin_id 和 auth_index');
  if (pluginId === '.' || pluginId === '..') throw new Error('CPA plugin_id 无效');
  return { pluginId, authIndex };
}

function normalizeCpaQuota(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('CPA 返回无效额度数据');
  const periods = [];
  for (const group of Array.isArray(data.groups) ? data.groups : []) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const fraction = bucket?.remainingFraction ?? bucket?.remaining_fraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const percent = (1 - fraction) * 100;
      const window = typeof bucket.window === 'string' ? bucket.window : '';
      periods.push({
        key: `cpa-${periods.length}`,
        label: [group.displayName || group.display_name, window].filter(v => typeof v === 'string' && v).join(' · ') || 'CPA 额度',
        percent,
        resetsAt: typeof (bucket.resetTime ?? bucket.reset_time) === 'string' ? (bucket.resetTime ?? bucket.reset_time) : '',
        exceeded: fraction === 0
      });
    }
  }
  const summary = (Array.isArray(data.summary) ? data.summary : []).filter(metric =>
    metric && typeof metric.label === 'string' && typeof metric.value === 'number' && Number.isFinite(metric.value));
  if (!periods.length && !summary.length) throw new Error('CPA 响应中没有可用额度数据');
  const plan = data.subscription?.plan || data.subscription?.tierName || data.subscription?.tier_name;
  const extra = summary.map(metric => `${metric.label}: ${metric.value}${typeof metric.currency === 'string' ? ` ${metric.currency}` : typeof metric.unit === 'string' ? ` ${metric.unit}` : ''}`).join(' · ');
  if (!periods.length) {
    const balance = summary.find(metric => metric.key === 'balance' || metric.key === 'remaining');
    if (!balance) throw new Error('CPA 仅返回数值摘要，缺少可展示的 balance 或 remaining 额度');
    return { planName: typeof plan === 'string' ? plan : 'CPA', unit: 'balance', total: 0, used: 0, remaining: balance.value, periods, extra };
  }
  // 独立窗口保持独立；主展示采用剩余额度最少的窗口。
  const used = Math.max(...periods.map(period => period.percent));
  return { planName: typeof plan === 'string' ? plan : 'CPA', unit: 'percent', total: 100, used, remaining: 100 - used, currentPercent: used, periods, extra };
}

async function fetchCpaUsage(provider) {
  const { pluginId, authIndex } = parseCpaQuotaConfig(provider.quota_script);
  const key = decryptSecret(provider.cpa_management_key || '');
  if (!key) throw new Error('供应商未配置 CPA 管理密钥');
  let base;
  try { base = new URL(provider.cpa_management_url || ''); } catch { throw new Error('CPA 管理地址无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('CPA 管理地址必须为 HTTP(S) 地址');
  const root = base.pathname.replace(/\/+$/, '').replace(/\/v[08]\/management$/, '');
  base.pathname = `${root}/v8/management/plugins/${encodeURIComponent(pluginId)}/quota`;
  base.searchParams.set('auth_index', authIndex);
  // 地址由管理员配置，允许本地 CPA；禁止重定向泄露管理密钥。
  const response = await fetch(base, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const hints = { 401: '管理密钥无效', 403: '管理接口访问被拒绝', 404: '账号、插件或 v8 额度接口不存在', 502: '插件查询上游失败' };
    throw new Error(`CPA 额度查询失败（HTTP ${response.status}）${hints[response.status] ? `：${hints[response.status]}` : ''}`);
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('CPA 额度响应不是有效 JSON'); }
  return normalizeCpaQuota(data);
}

module.exports = { parseCpaQuotaConfig, normalizeCpaQuota, fetchCpaUsage };
