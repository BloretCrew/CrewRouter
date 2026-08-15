'use strict';

const { quotaRequest } = require('./quota-http');

const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_USER_AGENT = process.env.CODEX_USER_AGENT || 'codex_cli_rs';

function getToken(provider) {
  return provider.oauth_access_token || '';
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatResetAt(timestamp) {
  const seconds = toNumber(timestamp, 0);
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

function normalizeWindow(key, window, label) {
  if (!window || typeof window !== 'object') return null;
  const percent = toNumber(window.used_percent, 0);
  return {
    key,
    label: label || (key === 'primary_window' ? '5 小时窗口' : key === 'secondary_window' ? '7 天窗口' : key),
    percent,
    resetsAt: formatResetAt(window.reset_at),
    resetAfterSeconds: toNumber(window.reset_after_seconds, 0),
    limitWindowSeconds: toNumber(window.limit_window_seconds, 0),
  };
}

function normalizeWhamUsage(data) {
  const rateLimit = data?.rate_limit || {};
  const windows = [
    normalizeWindow('primary_window', rateLimit.primary_window, '5 小时窗口'),
    normalizeWindow('secondary_window', rateLimit.secondary_window, '7 天窗口'),
  ].filter(Boolean);
  const additional = rateLimit.additional_rate_limits;
  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      const key = item?.key || item?.name || `additional_${index + 1}`;
      const window = item?.window || item;
      const normalized = normalizeWindow(key, window, item?.label || item?.name || key);
      if (normalized) windows.push(normalized);
    });
  } else if (additional && typeof additional === 'object') {
    Object.entries(additional).forEach(([key, value]) => {
      const window = value?.window || value;
      const normalized = normalizeWindow(key, window, value?.label || value?.name || key);
      if (normalized) windows.push(normalized);
    });
  }
  const primary = windows[0];
  const credits = data?.credits || {};
  const availableCredits = toNumber(credits.balance, 0);
  const extra = [
    credits.has_credits ? `Credits ${availableCredits}` : '',
    rateLimit.limit_reached ? '已达到限额' : '',
    credits.overage_limit_reached ? '已达到超额限额' : '',
  ].filter(Boolean).join(' · ');

  return {
    planName: data?.plan_type || 'ChatGPT',
    unit: 'percent',
    total: 100,
    used: primary?.percent || 0,
    remaining: Math.max(0, 100 - (primary?.percent || 0)),
    periods: windows,
    extra: extra || (rateLimit.allowed === false ? '当前不可用' : ''),
    allowed: rateLimit.allowed !== false,
    limitReached: rateLimit.limit_reached === true,
    credits: {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: credits.balance ?? '0',
      overageLimitReached: credits.overage_limit_reached === true,
    },
    rateLimitResetCredits: data?.rate_limit_reset_credits || null,
    spendControl: data?.spend_control || null,
  };
}

function usageHeaders(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    'User-Agent': CODEX_USER_AGENT,
    originator: 'codex_cli_rs',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

async function requestUsage(accessToken, accountId, provider) {
  const response = await quotaRequest(WHAM_USAGE_URL, {
    method: 'GET',
    headers: usageHeaders(accessToken, accountId),
    signal: AbortSignal.timeout(15000),
  }, provider);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  return { response, data };
}

async function refreshAccessToken(refreshToken, provider) {
  const response = await quotaRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(15000),
  }, provider);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!response.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`Codex Token 刷新失败（${detail}）`);
  }
  return data;
}

async function fetchCodexUsage(provider, { saveTokens } = {}) {
  let accessToken = getToken(provider);
  if (!accessToken) throw new Error('未配置 Codex OAuth access_token');
  let result = await requestUsage(accessToken, provider.oauth_account_id, provider);

  if (result.response.status === 401 && provider.oauth_refresh_token) {
    const refreshed = await refreshAccessToken(provider.oauth_refresh_token, provider);
    accessToken = refreshed.access_token;
    const updated = {
      accessToken,
      refreshToken: refreshed.refresh_token || provider.oauth_refresh_token,
      expiresAt: Date.now() + toNumber(refreshed.expires_in, 3600) * 1000,
    };
    provider.oauth_access_token = updated.accessToken;
    provider.oauth_refresh_token = updated.refreshToken;
    provider.oauth_expires_at = updated.expiresAt;
    if (saveTokens) await saveTokens(updated);
    result = await requestUsage(accessToken, provider.oauth_account_id, provider);
  }

  if (!result.response.ok) {
    const suffix = result.data?.detail || result.data?.error || result.data?.error_description || `HTTP ${result.response.status}`;
    throw new Error(`Codex 用量查询失败（${suffix}）`);
  }
  return normalizeWhamUsage(result.data);
}

function parseCodexAuthConfig(config) {
  const tokens = config?.tokens && typeof config.tokens === 'object' ? config.tokens : config || {};
  const accessToken = tokens.access_token || config?.access_token || '';
  const refreshToken = tokens.refresh_token || config?.refresh_token || '';
  const accountId = tokens.account_id || config?.account_id || config?.chatgpt_account_id || '';
  if (!accessToken && !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    accountId,
    expiresAt: tokens.expires_at || config?.expires_at || null,
  };
}

module.exports = { fetchCodexUsage, parseCodexAuthConfig, normalizeWhamUsage };
