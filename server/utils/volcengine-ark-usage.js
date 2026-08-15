'use strict';

const crypto = require('crypto');

const HOST = 'open.volcengineapi.com';
const SERVICE = 'ark';
const REGION = 'cn-north-1';
const VERSION = '2024-01-01';

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params) {
  return Object.keys(params || {})
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map(key => `${encodeRfc3986(key)}=${encodeRfc3986(params[key])}`)
    .join('&');
}

function signRequest({ accessKey, secretKey, action, body = {}, region = REGION, service = SERVICE, version = VERSION, now = new Date() }) {
  if (!accessKey || !secretKey) throw new Error('未配置火山方舟 Access Key / Secret Key');
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const query = canonicalQuery({ Action: action, Version: version });
  const payload = new URLSearchParams(body).toString();
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Host: HOST,
    'X-Content-Sha256': sha256(payload),
    'X-Date': amzDate,
  };
  const canonicalHeaders = `content-type:${headers['Content-Type'].toLowerCase()}\nhost:${HOST}\nx-content-sha256:${headers['X-Content-Sha256']}\nx-date:${amzDate}\n`;
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, headers['X-Content-Sha256']].join('\n');
  const credentialScope = `${date}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(secretKey, date), region), service), 'request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  headers.Authorization = `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, body: payload, query };
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return '';
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function findNumber(object, names) {
  for (const name of names) {
    const parts = name.split('.');
    let value = object;
    for (const part of parts) value = value?.[part];
    if (value !== undefined && value !== null && value !== '') return number(value);
  }
  return null;
}

function normalizePeriod(item, index) {
  if (!item || typeof item !== 'object') return null;
  const used = findNumber(item, ['used', 'usage', 'usedCount', 'Used', 'Usage']);
  const total = findNumber(item, ['total', 'limit', 'quota', 'totalCount', 'Limit', 'Quota']);
  const percentValue = findNumber(item, ['percent', 'usagePercent', 'usedPercent', 'UsagePercent']);
  if (used === null && total === null && percentValue === null) return null;
  const percent = percentValue ?? (total > 0 ? used / total * 100 : 0);
  return {
    key: item.key || item.name || item.type || `period_${index + 1}`,
    label: item.label || item.name || item.type || `用量周期 ${index + 1}`,
    percent: Math.max(0, Math.min(100, percent)),
    startsAt: timestamp(item.start || item.startTime || item.StartTime),
    resetsAt: timestamp(item.resetAt || item.end || item.endTime || item.ResetTime),
  };
}

function normalizeArkUsage(data, action) {
  const root = data?.Result || data?.result || data?.Data || data?.data || data;
  const candidates = Array.isArray(root?.periods) ? root.periods
    : Array.isArray(root?.Periods) ? root.Periods
      : Array.isArray(root?.usages) ? root.usages
        : Array.isArray(root?.Usages) ? root.Usages : [];
  const periods = candidates.map(normalizePeriod).filter(Boolean);
  const total = findNumber(root, ['total', 'Total', 'quota', 'Quota', 'limit', 'Limit', 'totalCount']);
  const used = findNumber(root, ['used', 'Used', 'usage', 'Usage', 'usedCount']);
  const remaining = findNumber(root, ['remaining', 'Remaining', 'available', 'Available', 'remainingCount']);
  if (!periods.length) {
    const normalized = normalizePeriod(root, 0);
    if (normalized) periods.push(normalized);
  }
  const primary = periods[0];
  const primaryTotal = primary ? findNumber(root, ['total', 'limit']) : null;
  const resolvedTotal = total ?? primaryTotal ?? 100;
  const resolvedUsed = used ?? (primary ? resolvedTotal * primary.percent / 100 : 0);
  return {
    planName: root?.planName || root?.PlanName || action,
    unit: root?.unit || root?.Unit || (action === 'GetAFPUsage' ? 'AFP' : 'requests'),
    total: resolvedTotal,
    used: resolvedUsed,
    remaining: remaining ?? Math.max(0, resolvedTotal - resolvedUsed),
    periods,
    extra: root?.message || root?.Message || '',
    raw: data,
  };
}

async function fetchArkUsage(provider) {
  const action = provider.ark_usage_action || (provider.quota_mode === 'ark_afp' ? 'GetAFPUsage' : 'GetInferenceUsage');
  let body = {};
  try { body = provider.ark_usage_params ? JSON.parse(provider.ark_usage_params) : {}; } catch (_) { throw new Error('火山方舟查询参数不是有效 JSON'); }
  const signed = signRequest({
    accessKey: provider.ark_access_key || provider.api_key,
    secretKey: provider.ark_secret_key,
    action,
    body,
    region: provider.ark_region || REGION,
    service: provider.ark_service || SERVICE,
  });
  const response = await fetch(`https://${HOST}/?${signed.query}`, {
    method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text.slice(0, 500) }; }
  if (!response.ok || data.ResponseMetadata?.Error) {
    const error = data.ResponseMetadata?.Error?.Message || data.message || data.Message || `HTTP ${response.status}`;
    throw new Error(`火山方舟 ${action} 查询失败（${error}）`);
  }
  return normalizeArkUsage(data, action);
}

module.exports = { fetchArkUsage, normalizeArkUsage, signRequest, canonicalQuery };
