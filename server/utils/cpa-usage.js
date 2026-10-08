'use strict';

const { decryptSecret } = require('./secret-crypto');

function parseCpaQuotaConfig(text) {
  let config;
  try { config = JSON.parse(text || '{}'); } catch { throw new Error('CPA 额度配置必须是 JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('CPA 额度配置必须是 JSON 对象');
  if (config.plugin_id !== undefined && typeof config.plugin_id !== 'string') throw new Error('CPA plugin_id 必须为字符串');
  const pluginId = typeof config.plugin_id === 'string' ? config.plugin_id.trim() : '';
  const authIndex = typeof config.auth_index === 'string' ? config.auth_index.trim() : '';
  if (!authIndex) throw new Error('CPA 额度配置需要 auth_index');
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

function quotaFromPeriods(periods, planName, extra = '') {
  if (!periods.length) throw new Error('CPA 响应中没有可用额度数据');
  const used = Math.max(...periods.map(period => period.percent));
  return { planName, unit: 'percent', total: 100, used, remaining: Math.max(0, 100 - used), currentPercent: used, periods, extra };
}

function normalizeClaudeUsage(data) {
  const periods = Object.entries(data || {}).flatMap(([key, value]) => {
    if (!value || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization) || value.utilization < 0) return [];
    return [{ key, label: key === 'five_hour' ? '5 小时窗口' : key === 'seven_day' ? '7 天窗口' : key,
      percent: value.utilization, resetsAt: typeof value.resets_at === 'string' ? value.resets_at : '' }];
  });
  return quotaFromPeriods(periods, 'Claude');
}

function normalizePassiveQuota(credential) {
  const periods = [];
  const observations = [['账号', credential.quota], ...Object.entries(credential.model_quotas || {})];
  let observedAt = '';
  for (const [label, observation] of observations) {
    const signals = Object.fromEntries(Object.entries(observation?.signals || {}).map(([key, value]) => [key.toLowerCase(), value]));
    for (const [key, raw] of Object.entries(signals)) {
      const codex = key.startsWith('x-codex-') && key.endsWith('-used-percent');
      const claude = key.startsWith('anthropic-ratelimit-unified-') && key.endsWith('-utilization');
      if (!codex && !claude) continue;
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      const prefix = key.slice(0, -(codex ? 'used-percent'.length : 'utilization'.length));
      const reset = signals[`${prefix}${codex ? 'reset-at' : 'reset'}`];
      const date = reset && Number.isFinite(Number(reset)) ? new Date(Number(reset) * 1000) : null;
      periods.push({ key: `${label}-${key}`, label: `${label} · ${prefix.replace(/-$/, '')}`, percent: claude ? value * 100 : value,
        resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : '' });
    }
    if (observation?.observed_at && (!observedAt || observation.observed_at > observedAt)) observedAt = observation.observed_at;
  }
  const observedLabel = observedAt ? `最近请求观察（${observedAt}）` : '最近请求观察';
  const labeledPeriods = periods.map(period => ({ ...period, label: `${observedLabel} · ${period.label}` }));
  return { ...quotaFromPeriods(labeledPeriods, credential.provider || credential.type || 'CPA', observedLabel), source: 'passive', observedAt };
}

function managementBase(provider) {
  let base;
  try { base = new URL(provider.cpa_management_url || ''); } catch { throw new Error('CPA 管理地址无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('CPA 管理地址必须为 HTTP(S) 地址');
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v[08]\/management$/, '') + '/v8/management';
  return base;
}

async function fetchCpaUsage(provider) {
  const { pluginId, authIndex } = parseCpaQuotaConfig(provider.quota_script);
  const key = decryptSecret(provider.cpa_management_key || '');
  if (!key) throw new Error('供应商未配置 CPA 管理密钥');
  const base = managementBase(provider);
  async function request(path, body) {
    const url = new URL(base);
    url.pathname += path.split('?')[0];
    url.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    // 管理员指定可信地址；禁止重定向泄露管理密钥。
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`CPA 额度查询失败（HTTP ${response.status}）`);
    try { return await response.json(); } catch { throw new Error('CPA 额度响应不是有效 JSON'); }
  }
  if (pluginId) return normalizeCpaQuota(await request(`/plugins/${encodeURIComponent(pluginId)}/quota?auth_index=${encodeURIComponent(authIndex)}`));
  const credentials = await request('/credentials');
  const files = Array.isArray(credentials.files) ? credentials.files : Array.isArray(credentials) ? credentials : [];
  const credential = files.find(file => String(file.auth_index) === authIndex);
  if (!credential) throw new Error('CPA 中找不到该账号凭据索引');
  if (credential.disabled) throw new Error('CPA 账号已禁用');
  const type = String(credential.provider || credential.type || '').toLowerCase();
  let activeError;
  if (type === 'codex' || type === 'claude') {
    try {
      const headers = { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' };
      if (type === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
      const accountId = credential.id_token?.chatgpt_account_id;
      if (type === 'codex' && typeof accountId === 'string' && accountId) headers['ChatGPT-Account-Id'] = accountId;
      const result = await request('/requests/api-call', { auth_index: authIndex, method: 'GET',
        url: type === 'codex' ? 'https://chatgpt.com/backend-api/wham/usage' : 'https://api.anthropic.com/api/oauth/usage', header: headers });
      if (result.status_code !== 200) throw new Error(`CPA 上游额度接口失败（HTTP ${result.status_code}）`);
      const data = JSON.parse(result.body);
      if (type === 'claude') return { ...normalizeClaudeUsage(data), source: 'active' };
      const quota = require('./codex-usage').normalizeWhamUsage(data);
      const periods = quota.periods.filter(period => {
        const window = data.rate_limit?.[period.key];
        return window && typeof window.used_percent === 'number' && Number.isFinite(window.used_percent) && window.used_percent >= 0;
      });
      return { ...quota, ...quotaFromPeriods(periods, quota.planName, quota.extra), source: 'active' };
    } catch (error) { activeError = error; }
  }
  try { return normalizePassiveQuota(credential); } catch {
    throw new Error(activeError?.message || `CPA ${type || '该账号'} 暂无可用额度信息，请先发起模型请求或配置额度插件`);
  }
}

module.exports = { parseCpaQuotaConfig, normalizeCpaQuota, normalizeClaudeUsage, normalizePassiveQuota, fetchCpaUsage };
