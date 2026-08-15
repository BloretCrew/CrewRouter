'use strict';

const { quotaRequest } = require('./quota-http');

const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const DEFAULT_CLIENT_VERSION = process.env.GROK_CLIENT_VERSION || '0.2.120';
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map();

function toNumber(value, fallback = 0) {
  if (value && typeof value === 'object') {
    if (value.val !== undefined) return toNumber(value.val, fallback);
    if (value.value !== undefined) return toNumber(value.value, fallback);
    if (value.percent !== undefined) return toNumber(value.percent, fallback);
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/%$/, '');
    if (!normalized) return fallback;
    value = normalized;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toPercent(value, fallback = 0) {
  const percent = toNumber(value, fallback);
  // Some billing responses encode 2% as the fraction 0.02 even though the
  // documented field is described as a 0-100 percentage.
  return percent > 0 && percent < 1 ? percent * 100 : percent;
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    const seconds = value.seconds ?? value._seconds ?? value.sec;
    const nanos = value.nanos ?? value.nanoseconds ?? 0;
    if (seconds !== undefined) {
      const secondsNumber = toNumber(seconds, NaN);
      if (Number.isFinite(secondsNumber)) return secondsNumber * 1000 + Math.floor(toNumber(nanos, 0) / 1e6);
    }
  }
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDate(value) {
  const timestamp = toTimestamp(value);
  if (timestamp === null) return value ? String(value) : '';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function normalizeExpiresAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readJwtExpMs(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function tokenNeedsRefresh(provider) {
  const expiresAt = normalizeExpiresAt(provider.oauth_expires_at) || readJwtExpMs(provider.oauth_access_token);
  if (!expiresAt) return false;
  return expiresAt <= Date.now() + 5 * 60 * 1000;
}

function isAuthFailure(response, data) {
  if (response.status === 401 || response.status === 403) return true;
  const detail = `${data?.detail || ''} ${data?.error || ''} ${data?.error_description || ''}`;
  return /invalid or expired credentials|no auth context|unauthenticated|invalid_token/i.test(detail);
}

function parseGrokAuthConfig(config) {
  const direct = config?.access_token || config?.tokens?.access_token || config?.token || config?.key;
  const directUserId = config?.user_id || config?.userid || config?.userId || '';
  const directExpiresAt = config?.expires_at || config?.expiresAt || config?.tokens?.expires_at || null;
  if (direct) return {
    accessToken: direct,
    userId: directUserId,
    refreshToken: config?.refresh_token || config?.tokens?.refresh_token || '',
    issuer: config?.oidc_issuer || config?.issuer || '',
    clientId: config?.oidc_client_id || config?.client_id || '',
    expiresAt: normalizeExpiresAt(directExpiresAt),
  };

  // Grok CLI auth.json is commonly a map of profiles. Each profile stores the
  // bearer token as `key`, not `access_token`.
  const entries = Object.entries(config || {})
    .filter(([, entry]) => entry && typeof entry === 'object' && entry.key)
    .sort(([, a], [, b]) => (normalizeExpiresAt(b.expires_at) || 0) - (normalizeExpiresAt(a.expires_at) || 0));
  const entry = entries[0]?.[1];
  if (!entry) return null;
  return {
    accessToken: entry.key,
    userId: entry.user_id || entry.userid || entry.userId || '',
    refreshToken: entry.refresh_token || '',
    issuer: entry.oidc_issuer || '',
    clientId: entry.oidc_client_id || '',
    expiresAt: normalizeExpiresAt(entry.expires_at),
  };
}

function normalizeGrokPeriod(item, index, fallbackLabel = '用量周期') {
  if (!item || typeof item !== 'object') return null;
  const rawPercent = item.creditUsagePercent ?? item.usagePercent ?? item.percent;
  if (rawPercent === undefined || rawPercent === null) return null;
  const end = item.end || item.endAt || item.end_at || item.resetAt || item.reset_at;
  return {
    key: item.key || item.id || item.periodId || item.type || `period_${index + 1}`,
    label: item.label || item.displayName || item.product || item.name || item.type || fallbackLabel,
    percent: Math.max(0, Math.min(100, toPercent(rawPercent))),
    startsAt: formatDate(item.start || item.startAt || item.start_at),
    resetsAt: formatDate(end),
    resetAfterSeconds: Math.max(0, Math.round((toTimestamp(end) - Date.now()) / 1000)),
    historical: item.historical === true,
  };
}

function unwrapGrokUsage(data) {
  if (!data || typeof data !== 'object') return {};
  const nested = data.config || data.data || data.result || data.usage;
  if (nested && typeof nested === 'object' && (
    nested.creditUsagePercent !== undefined
    || nested.currentPeriod
    || nested.productUsage
    || nested.history
    || nested.prepaidBalance !== undefined
    || nested.onDemandCap !== undefined
    || nested.monthlyLimit !== undefined
  )) {
    return {
      ...nested,
      subscriptionTier: nested.subscriptionTier || data.subscriptionTier || data.subscription_tier,
    };
  }
  return data;
}

function periodTime(item, field) {
  if (!item || typeof item !== 'object') return undefined;
  const nested = item.period || item.currentPeriod;
  return item[field]
    || item[`${field}At`]
    || item[`${field}_at`]
    || nested?.[field]
    || nested?.[`${field}At`]
    || nested?.[`${field}_at`];
}

function normalizeGrokUsage(data) {
  const source = unwrapGrokUsage(data);
  const rawPercent = source.creditUsagePercent ?? source.currentPeriod?.creditUsagePercent ?? source.currentPeriod?.usagePercent ?? source.currentPeriod?.percent;
  const percent = Math.max(0, Math.min(100, toPercent(rawPercent, 0)));
  const current = source.currentPeriod || {};
  const currentPeriod = {
    type: current.type || '',
    label: current.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? '每周共享额度' : (current.type || '当前周期'),
    startsAt: formatDate(periodTime(current, 'start') || periodTime(source, 'start') || data?.resetAt),
    resetsAt: formatDate(periodTime(current, 'end') || periodTime(source, 'end') || data?.resetAt || data?.reset_at),
  };
  const currentEnd = periodTime(current, 'end') || periodTime(source, 'end');
  const periods = [{
    key: 'current_period',
    label: currentPeriod.label,
    percent,
    resetsAt: currentPeriod.resetsAt,
    startsAt: currentPeriod.startsAt,
    resetAfterSeconds: Math.max(0, Math.round((toTimestamp(currentEnd) - Date.now()) / 1000)),
  }];

  const productUsage = source.productUsage;
  if (Array.isArray(productUsage)) {
    productUsage.forEach((item, index) => {
      const itemPercent = item?.creditUsagePercent ?? item?.usagePercent ?? item?.percent;
      if (itemPercent !== undefined) {
        const normalized = normalizeGrokPeriod({ ...item, creditUsagePercent: itemPercent, end: item.currentPeriod?.end || current.end }, index, '产品额度');
        if (normalized) periods.push({ ...normalized, key: item.product || item.name || `product_${index + 1}`, label: item.displayName || item.product || item.name || '产品额度' });
      }
    });
  } else if (productUsage && typeof productUsage === 'object') {
    Object.entries(productUsage).forEach(([key, item]) => {
      const itemPercent = item?.creditUsagePercent ?? item?.usagePercent ?? item?.percent;
      if (itemPercent !== undefined) {
        const normalized = normalizeGrokPeriod({ ...(item || {}), creditUsagePercent: itemPercent, end: item?.currentPeriod?.end || current.end }, 0, '产品额度');
        if (normalized) periods.push({ ...normalized, key, label: item?.displayName || item?.product || key });
      }
    });
  }

  const history = Array.isArray(source.history) ? source.history : [];
  history.forEach((item, index) => {
    const nestedPeriod = item?.period || item?.currentPeriod || {};
    const historicalPercent = item?.creditUsagePercent ?? item?.usagePercent ?? item?.percent ?? nestedPeriod.creditUsagePercent ?? nestedPeriod.usagePercent;
    const normalized = normalizeGrokPeriod({
      ...(item || {}),
      creditUsagePercent: historicalPercent,
      start: periodTime(item, 'start'),
      end: periodTime(item, 'end'),
      historical: true,
    }, index, '历史周期');
    if (normalized) periods.push(normalized);
  });

  const prepaid = toNumber(source.prepaidBalance, 0);
  const onDemandCap = toNumber(source.onDemandCap, 0);
  const onDemandUsed = toNumber(source.onDemandUsed, 0);
  const legacyLimit = toNumber(source.monthlyLimit, 0);
  const legacyUsed = toNumber(source.used, 0);
  const total = legacyLimit || onDemandCap || 100;
  const used = legacyLimit ? legacyUsed : (onDemandCap ? onDemandUsed : percent);

  return {
    planName: source.subscriptionTier || source.subscription_tier || 'SuperGrok',
    unit: 'credits',
    total,
    used,
    remaining: Math.max(0, total - used),
    periods,
    extra: [
      `当前周期 ${percent}%`,
      `Prepaid ${prepaid}`,
      onDemandCap ? `按需额度 ${onDemandUsed}/${onDemandCap}` : '',
      source.isUnifiedBillingUser ? '统一周池' : '',
    ].filter(Boolean).join(' · '),
    prepaidBalance: prepaid,
    onDemandCap,
    onDemandUsed,
    onDemandRemaining: Math.max(0, onDemandCap - onDemandUsed),
    monthlyLimit: legacyLimit,
    monthlyUsed: legacyUsed,
    currentPercent: percent,
    isUnifiedBillingUser: source.isUnifiedBillingUser === true,
    currentPeriod: currentPeriod,
    productUsage: productUsage || [],
    history,
  };
}

async function requestGrokUsage(token, provider) {
  const version = process.env.GROK_CLIENT_VERSION || DEFAULT_CLIENT_VERSION;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-userid': provider.oauth_account_id || '',
    'x-grok-client-version': version,
    'x-grok-client-identifier': 'grok-shell',
    'x-grok-client-mode': 'interactive',
    'User-Agent': `grok/${version}`,
  };
  const response = await quotaRequest(GROK_BILLING_URL, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15000),
  }, provider);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  return { response, data };
}

async function resolveGrokTokenUrl(issuer, provider) {
  const base = issuer.replace(/\/+$/, '');
  const cached = discoveryCache.get(base);
  if (cached && cached.expiresAt > Date.now()) return cached.tokenUrl;
  try {
    const response = await quotaRequest(`${base}/.well-known/openid-configuration`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }, provider);
    const data = await response.json();
    if (response.ok && data?.token_endpoint) {
      discoveryCache.set(base, { tokenUrl: data.token_endpoint, expiresAt: Date.now() + DISCOVERY_TTL_MS });
      return data.token_endpoint;
    }
  } catch (_) { /* fall through to oauth2 */ }
  const fallback = `${base}/oauth2/token`;
  discoveryCache.set(base, { tokenUrl: fallback, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return fallback;
}

async function refreshGrokToken(provider) {
  if (!provider.oauth_refresh_token || !provider.oauth_issuer || !provider.oauth_client_id) return null;
  const issuer = provider.oauth_issuer.replace(/\/+$/, '');
  const tokenUrl = await resolveGrokTokenUrl(issuer, provider);
  const response = await quotaRequest(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: provider.oauth_refresh_token,
      client_id: provider.oauth_client_id,
    }),
    signal: AbortSignal.timeout(15000),
  }, provider);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!response.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`SuperGrok Token 刷新失败（${detail}）`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || provider.oauth_refresh_token,
    expiresAt: Date.now() + toNumber(data.expires_in, 3600) * 1000,
  };
}

async function applyRefreshedTokens(provider, refreshed, saveTokens) {
  provider.oauth_access_token = refreshed.accessToken;
  provider.oauth_refresh_token = refreshed.refreshToken;
  provider.oauth_expires_at = refreshed.expiresAt;
  if (saveTokens) await saveTokens(refreshed);
}

async function fetchGrokUsage(provider, { saveTokens } = {}) {
  if (!provider.oauth_access_token) throw new Error('未配置 SuperGrok access_token');

  if (tokenNeedsRefresh(provider) && provider.oauth_refresh_token) {
    const refreshed = await refreshGrokToken(provider);
    if (refreshed) await applyRefreshedTokens(provider, refreshed, saveTokens);
  }

  let result = await requestGrokUsage(provider.oauth_access_token, provider);
  if (isAuthFailure(result.response, result.data) && provider.oauth_refresh_token) {
    const refreshed = await refreshGrokToken(provider);
    if (refreshed) {
      await applyRefreshedTokens(provider, refreshed, saveTokens);
      result = await requestGrokUsage(provider.oauth_access_token, provider);
    }
  }
  if (!result.response.ok) {
    const suffix = result.data?.detail || result.data?.error || result.data?.error_description || `HTTP ${result.response.status}`;
    throw new Error(`SuperGrok 额度查询失败（${suffix}）`);
  }
  const normalized = normalizeGrokUsage(result.data);
  const source = unwrapGrokUsage(result.data);
  normalized.rawPercent = source.creditUsagePercent ?? null;
  return normalized;
}

module.exports = {
  fetchGrokUsage,
  parseGrokAuthConfig,
  normalizeGrokUsage,
  normalizeGrokPeriod,
  unwrapGrokUsage,
  normalizeExpiresAt,
};
