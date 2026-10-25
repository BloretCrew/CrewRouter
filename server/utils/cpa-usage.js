'use strict';

const { quotaSignal } = require('./quota-http');
const { decryptSecret } = require('./secret-crypto');
const { validateUrl, normalizeAllowlistOrigin } = require('./url-validator');
const axios = require('axios');
const { createPinnedHttpAgents } = require('./pinned-http-agents');

function cpaPrivateOriginAllowlist() {
  return String(process.env.CR_CPA_PRIVATE_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
}

function isExplicitlyAllowedPrivateOrigin(url) {
  return cpaPrivateOriginAllowlist().some(value => normalizeAllowlistOrigin(value) === url.origin.toLowerCase());
}

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

function codexWindowLabel(window, minutes) {
  const duration = Number(minutes);
  if (duration === 300) return '5 小时窗口';
  if (duration === 10080) return '7 天窗口';
  if (duration > 0) return `${duration / 60} 小时窗口`;
  return window === 'primary' ? '主额度窗口' : '次额度窗口';
}

function normalizeCodexUsage(data) {
  const periods = [];
  const limits = data?.rate_limit || data?.rate_limits;
  const append = (limit, name = '') => {
    for (const window of ['primary', 'secondary']) {
      const value = limit?.[`${window}_window`] || limit?.[window];
      if (!value || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent) || value.used_percent < 0) continue;
      const minutes = value.limit_window_seconds ? value.limit_window_seconds / 60 : value.window_minutes;
      const date = typeof value.reset_at === 'number' ? new Date(value.reset_at * 1000) : null;
      periods.push({ key: `${name || 'account'}-${window}`, label: [name, codexWindowLabel(window, minutes)].filter(Boolean).join(' · '),
        percent: value.used_percent, resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : '' });
    }
  };
  append(limits);
  const additional = data?.additional_rate_limits || limits?.additional_rate_limits;
  if (Array.isArray(additional)) additional.forEach(item => append(item.rate_limit || item, item.limit_name || item.name || '额外额度'));
  else if (additional && typeof additional === 'object') Object.entries(additional).forEach(([name, item]) => append(item.rate_limit || item, name));
  const legacy = require('./codex-usage').normalizeWhamUsage(data);
  return { ...legacy, ...quotaFromPeriods(periods, data?.plan_type || 'ChatGPT', legacy.extra) };
}

function normalizePassiveQuota(credential) {
  const snapshots = [credential.quota, ...Object.values(credential.model_quotas || {})].filter(snapshot => snapshot && snapshot.signals);
  // 模型记录是同一账号在不同请求时的快照；选择最新有效快照，避免累计旧窗口。
  snapshots.sort((a, b) => (Date.parse(b.observed_at) || 0) - (Date.parse(a.observed_at) || 0));
  for (const observation of snapshots) {
    const periods = [];
    const signals = Object.fromEntries(Object.entries(observation.signals).map(([key, value]) => [key.toLowerCase(), value]));
    for (const [key, raw] of Object.entries(signals)) {
      const codex = key.startsWith('x-codex-') && key.endsWith('-used-percent');
      const claude = key.startsWith('anthropic-ratelimit-unified-') && key.endsWith('-utilization');
      if ((!codex && !claude) || typeof raw !== 'string' || !raw.trim()) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      const prefix = key.slice(0, -(codex ? 'used-percent'.length : 'utilization'.length));
      const reset = signals[`${prefix}${codex ? 'reset-at' : 'reset'}`];
      const date = reset && Number.isFinite(Number(reset)) ? new Date(Number(reset) * 1000) : null;
      let label;
      if (codex) {
        const match = prefix.match(/^x-codex-(?:(.*)-)?(primary|secondary)-$/);
        if (!match) continue;
        const name = signals[`${prefix.replace(/(primary|secondary)-$/, '')}limit-name`] || match[1];
        label = [name, codexWindowLabel(match[2], signals[`${prefix}window-minutes`])].filter(Boolean).join(' · ');
      } else label = prefix.includes('-5h-') ? '5 小时窗口' : prefix.includes('-7d-') ? '7 天窗口' : prefix.replace('anthropic-ratelimit-unified-', '').replace(/-$/, '');
      periods.push({ key: prefix, label, percent: claude ? value * 100 : value,
        resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : '' });
    }
    if (!periods.length) continue;
    const observedAt = typeof observation.observed_at === 'string' ? observation.observed_at : '';
    const plan = signals['x-codex-plan-type'] || credential.provider || credential.type || 'CPA';
    return { ...quotaFromPeriods(periods.map(period => ({ ...period, label: `${period.label}（缓存）` })), plan, observedAt ? `最近请求采集：${observedAt}` : '最近请求采集的额度信息'), source: 'passive', observedAt };
  }
  throw new Error('CPA 响应中没有可用额度数据');
}

function managementBase(provider) {
  let base;
  try { base = new URL(provider.cpa_management_url || ''); } catch { throw new Error('CPA 管理地址无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('CPA 管理地址必须为 HTTP(S) 地址');
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v[08]\/management$/, '') + '/v8/management';
  return base;
}

async function validateCpaTargetUrl(urlValue) {
  let url;
  try { url = new URL(urlValue); } catch { return { ok: false, error: 'CPA 管理地址无效' }; }
  if (url.protocol === 'http:' && !isExplicitlyAllowedPrivateOrigin(url)) {
    return { ok: false, error: '外部 CPA 管理地址必须使用 HTTPS' };
  }
  return validateUrl(url.toString(), { allowedPrivateOrigins: cpaPrivateOriginAllowlist() });
}

async function validateCpaManagementUrl(value) {
  let base;
  try { base = managementBase({ cpa_management_url: value }); } catch { return { ok: false, error: 'CPA 管理地址必须为不含凭据、查询参数或片段的 HTTP(S) 地址' }; }
  return validateCpaTargetUrl(base.toString());
}

function cpaRequest(provider) {
  const key = decryptSecret(provider.cpa_management_key || '');
  if (!key) throw new Error('供应商未配置 CPA 管理密钥');
  const base = managementBase(provider);
  return async function request(path, body) {
    const url = new URL(base);
    url.pathname += path.split('?')[0];
    url.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    // 每次请求都复核数据库中的目标；内网 CPA 仅允许精确主机列表中的地址。
    const urlCheck = await validateCpaTargetUrl(url.toString());
    if (!urlCheck.ok) throw new Error(`CPA 管理地址安全校验失败: ${urlCheck.error}`);
    // 禁止重定向，避免把管理密钥发送到另一个目标。
    const agents = createPinnedHttpAgents(urlCheck);
    try {
      const response = await axios.request({ url: urlCheck.url.toString(), method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { data: JSON.stringify(body) } : {}), responseType: 'text', maxRedirects: 0, proxy: false,
        httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent, validateStatus: () => true,
        signal: quotaSignal(AbortSignal.timeout(15000)) });
      if (response.status < 200 || response.status >= 300) throw new Error(`CPA 管理接口请求失败（HTTP ${response.status}）`);
      try { return JSON.parse(response.data); } catch { throw new Error('CPA 额度响应不是有效 JSON'); }
    } finally {
      agents.destroy();
    }
  };
}

async function listCpaAccounts(provider) {
  const data = await cpaRequest(provider)('/credentials');
  const files = Array.isArray(data?.files) ? data.files : Array.isArray(data) ? data : null;
  if (!files) throw new Error('CPA 账号列表响应无效');
  return files.filter(file => file && typeof file.auth_index === 'string' && file.auth_index.trim()).map(file => ({
    auth_index: file.auth_index,
    provider: typeof (file.provider || file.type) === 'string' ? (file.provider || file.type) : '',
    label: typeof file.email === 'string' && file.email ? file.email : typeof file.label === 'string' && file.label ? file.label : typeof file.name === 'string' ? file.name : file.auth_index,
    disabled: file.disabled === true
  }));
}

async function fetchCpaUsage(provider) {
  const { pluginId, authIndex } = parseCpaQuotaConfig(provider.quota_script);
  const request = cpaRequest(provider);
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
      if (type === 'codex') {
        headers['User-Agent'] = 'codex_cli_rs/0.101.0';
        headers.originator = 'codex_cli_rs';
      }
      if (type === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
      const accountId = credential.id_token?.chatgpt_account_id;
      if (type === 'codex' && typeof accountId === 'string' && accountId) headers['ChatGPT-Account-Id'] = accountId;
      const result = await request('/requests/api-call', { auth_index: authIndex, method: 'GET',
        url: type === 'codex' ? 'https://chatgpt.com/backend-api/wham/usage' : 'https://api.anthropic.com/api/oauth/usage', header: headers });
      if (result.status_code !== 200) throw new Error(`CPA 上游额度接口失败（HTTP ${result.status_code}）`);
      const data = JSON.parse(result.body);
      if (type === 'claude') return { ...normalizeClaudeUsage(data), source: 'active' };
      return { ...normalizeCodexUsage(data), source: 'active' };
    } catch (error) { activeError = error; }
  }
  try { return normalizePassiveQuota(credential); } catch {
    throw new Error(activeError?.message || `CPA ${type || '该账号'} 暂无可用额度信息，请先发起模型请求或配置额度插件`);
  }
}

module.exports = { parseCpaQuotaConfig, normalizeCpaQuota, normalizeClaudeUsage, normalizeCodexUsage, normalizePassiveQuota, validateCpaManagementUrl, fetchCpaUsage, listCpaAccounts };
