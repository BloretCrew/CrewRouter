'use strict';

const Logger = require('../logger');
const { pool } = require('../models/database');
const { validateUrl } = require('./url-validator');
const { getPrimaryApiKey, normalizeProviderKeyEntries } = require('./provider-keys');
const { fetchCodexUsage } = require('./codex-usage');
const { fetchGrokUsage } = require('./grok-usage');
const { fetchArkUsage } = require('./volcengine-ark-usage');
const { fetchCommandCodeUsage } = require('./commandcode-usage');
const { fetchNewApiUsage } = require('./newapi-usage');

const QUOTA_SCHEDULE_INTERVALS = Object.freeze([
  { value: 600, label: '每 10 分钟' },
  { value: 1800, label: '每 30 分钟' },
  { value: 3600, label: '每 1 小时' },
  { value: 7200, label: '每 2 小时' },
  { value: 21600, label: '每 6 小时' },
  { value: 43200, label: '每 12 小时' },
  { value: 86400, label: '每 24 小时' }
]);

const ALLOWED_INTERVALS = new Set(QUOTA_SCHEDULE_INTERVALS.map(i => i.value));
const DEFAULT_INTERVAL = 3600;
const SCHEDULER_TICK_MS = 60 * 1000;

let schedulerTimer = null;
let schedulerRunning = false;
const quotaInFlight = new Map();
const perKeyQuotaInFlight = new Map();

function normalizeQuotaScheduleInterval(value) {
  const n = parseInt(value, 10);
  return ALLOWED_INTERVALS.has(n) ? n : DEFAULT_INTERVAL;
}

function generateDefaultQuotaScript(provider) {
  const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
  const cleaned = baseUrl
    .replace(/\/(chat\/completions|completions|messages|responses|embeddings|models)\/?$/, '')
    .replace(/\/+$/, '');
  const apiRoot = /\/v1\/?$/.test(cleaned) ? cleaned : `${cleaned}/v1`;
  const format = provider.format || 'openai';

  if (provider.quota_mode === 'opencode_go') {
    return JSON.stringify({
      request: {
        url: 'https://opencode.ai/zen/go/v1/usage',
        method: 'GET',
        headers: {
          Authorization: 'Bearer {apiKey}'
        }
      },
      extractor: `function(response) {
  if (!response || response.error) return { isValid: false, invalidMessage: (response && response.error && (response.error.message || response.error)) || 'OpenCode Go 额度查询失败' };
  var usage = response.usage || {};
  var periods = ['rolling', 'weekly', 'monthly'];
  var available = periods.filter(function(name) { return usage[name] && typeof usage[name].percent === 'number'; });
  if (!available.length) return { isValid: false, invalidMessage: 'OpenCode Go 响应中没有可用的 usage 数据' };
  var latest = available[0];
  var labels = { rolling: 'Rolling', weekly: 'Weekly', monthly: 'Monthly' };
  var periods = available.map(function(name) {
    var item = usage[name];
    return {
      key: name,
      label: labels[name] || name,
      percent: item.percent,
      resetsAt: item.resetsAt || ''
    };
  });
  return {
    isValid: true,
    planName: 'OpenCode Go',
    unit: 'percent',
    total: 100,
    used: usage[latest].percent,
    remaining: Math.max(0, 100 - usage[latest].percent),
    periods: periods,
    extra: ''
  };
}`
    }, null, 2);
  }

  if (format === 'anthropic') {
    return JSON.stringify({
      request: {
        url: '{apiRoot}/organizations/usage',
        method: 'GET',
        headers: {
          Authorization: 'Bearer {apiKey}',
          'anthropic-version': '2023-06-01'
        }
      },
      extractor: `function(response) {
  if (response.error) return { isValid: false, invalidMessage: response.error.message || JSON.stringify(response.error) };
  return {
    isValid: true,
    planName: "Anthropic",
    unit: "balance",
    total: 0, used: 0, remaining: 0,
    extra: "请根据实际响应格式修改 extractor"
  };
}`
    }, null, 2);
  }

  return JSON.stringify({
    request: {
      url: '{apiRoot}/dashboard/billing/subscription',
      method: 'GET',
      headers: {
        Authorization: 'Bearer {apiKey}'
      }
    },
    extractor: `function(response) {
  if (response.error) return { isValid: false, invalidMessage: response.error.message || JSON.stringify(response.error) };
  var total = response.hard_limit_usd || response.system_hard_limit_usd || 0;
  var remaining = response.has_soft_limit === false ? total : (response.soft_limit_usd || total);
  return {
    isValid: true,
    planName: (response.plan && response.plan.id) || "{providerName}",
    unit: "balance",
    total: total,
    used: total - remaining,
    remaining: remaining,
    extra: "USD"
  };
}`
  }, null, 2);
}

async function persistOauthTokens(providerId, { accessToken, refreshToken, expiresAt }) {
  await pool.query(
    'UPDATE providers SET oauth_access_token = $1, oauth_refresh_token = $2, oauth_expires_at = $3 WHERE id = $4',
    [accessToken, refreshToken, expiresAt, providerId]
  );
}

/**
 * @returns {{ ok: boolean, status: number, error?: string, quota?: object, provider?: object }}
 */
async function queryProviderQuotaInternal(provider) {
  const meta = { id: provider.id, name: provider.name };

  if (provider.quota_mode === 'ark_inference' || provider.quota_mode === 'ark_afp') {
    if (!(provider.ark_secret_key && (provider.ark_access_key || provider.api_key))) {
      return { ok: false, status: 400, error: '未配置火山方舟 Access Key / Secret Key', provider: meta };
    }
    try {
      const quota = await fetchArkUsage(provider);
      return { ok: true, status: 200, provider: meta, quota };
    } catch (error) {
      Logger.warn(`[查询火山方舟额度] ${provider.id} 失败: ${error.message}`);
      return { ok: false, status: 502, error: error.message, provider: meta };
    }
  }

  if (provider.quota_mode === 'codex_wham' || provider.quota_mode === 'grok_billing') {
    if (!provider.oauth_access_token) {
      return {
        ok: false,
        status: 400,
        error: provider.quota_mode === 'grok_billing'
          ? '未配置 SuperGrok access_token，请导入 auth.json'
          : '未配置 Codex OAuth Token，请导入 auth.json',
        provider: meta
      };
    }
    try {
      const quota = provider.quota_mode === 'grok_billing'
        ? await fetchGrokUsage(provider, { saveTokens: (tokens) => persistOauthTokens(provider.id, tokens) })
        : await fetchCodexUsage(provider, { saveTokens: (tokens) => persistOauthTokens(provider.id, tokens) });
      const normalizedQuota = provider.quota_mode === 'grok_billing'
        ? { ...quota, providerType: 'grok', currentPercent: quota.currentPercent ?? quota.periods?.[0]?.percent ?? 0 }
        : quota;
      return {
        ok: true,
        status: 200,
        provider: { ...meta, ...(provider.quota_mode === 'grok_billing' ? { type: 'grok' } : {}) },
        quota: normalizedQuota
      };
    } catch (error) {
      Logger.warn(`[查询 OAuth 额度] ${provider.id} 失败: ${error.message}`);
      return { ok: false, status: 502, error: error.message, provider: meta };
    }
  }

  if (provider.quota_mode === 'commandcode') {
    try {
      const quota = await fetchCommandCodeUsage(provider);
      return {
        ok: true,
        status: 200,
        provider: { ...meta, type: 'commandcode' },
        quota: { ...quota, providerType: 'commandcode', currentPercent: quota.periods?.[0]?.percent ?? 0 }
      };
    } catch (error) {
      Logger.warn(`[查询 Command Code 额度] ${provider.id} 失败: ${error.message}`);
      return { ok: false, status: 502, error: error.message, provider: meta };
    }
  }

  if (provider.quota_mode === 'newapi') {
    try {
      const quota = await fetchNewApiUsage(provider);
      return {
        ok: true,
        status: 200,
        provider: { ...meta, type: 'newapi' },
        quota
      };
    } catch (error) {
      Logger.warn(`[查询 new-api 额度] ${provider.id} 失败: ${error.message}`);
      return { ok: false, status: 502, error: error.message, provider: meta };
    }
  }

  const baseUrl = provider.base_url?.replace(/\/+$/, '');
  const apiKey = getPrimaryApiKey(provider);
  if (!baseUrl) return { ok: false, status: 400, error: '供应商未配置 Base URL', provider: meta };
  if (!apiKey) return { ok: false, status: 400, error: '供应商未配置 API Key', provider: meta };

  let scriptText = provider.quota_script?.trim();
  if (!scriptText) scriptText = generateDefaultQuotaScript(provider);

  const cleaned = baseUrl
    .replace(/\/(chat\/completions|completions|messages|responses|embeddings|models)\/?$/, '')
    .replace(/\/+$/, '');
  const apiRoot = /\/v1\/?$/.test(cleaned) ? cleaned : `${cleaned}/v1`;

  scriptText = scriptText
    .replace(/\{baseUrl\}/g, baseUrl)
    .replace(/\{apiRoot\}/g, apiRoot)
    .replace(/\{apiKey\}/g, apiKey)
    .replace(/\{providerId\}/g, provider.id)
    .replace(/\{providerName\}/g, provider.name);

  let script;
  try {
    script = JSON.parse(scriptText);
  } catch (e) {
    return { ok: false, status: 400, error: '脚本 JSON 解析失败: ' + e.message, provider: meta };
  }
  if (!script.request || !script.extractor) {
    return { ok: false, status: 400, error: '脚本必须包含 request 和 extractor 字段', provider: meta };
  }

  const reqConfig = script.request;
  const fetchOptions = {
    method: reqConfig.method || 'GET',
    headers: reqConfig.headers || {},
    signal: AbortSignal.timeout(15000)
  };

  Logger.info(`[查询供应商额度] ${provider.id}: ${fetchOptions.method} ${reqConfig.url}`);

  const urlCheck = await validateUrl(reqConfig.url);
  if (!urlCheck.ok) {
    return { ok: false, status: 400, error: `URL 校验失败: ${urlCheck.error}`, provider: meta };
  }

  let responseData;
  try {
    const response = await fetch(reqConfig.url, fetchOptions);
    const text = await response.text();
    if (!response.ok) {
      try { responseData = JSON.parse(text); } catch { responseData = { _status: response.status, _body: text.substring(0, 500) }; }
      if (!script.extractor) {
        return { ok: false, status: 502, error: `HTTP ${response.status}`, provider: meta };
      }
    } else {
      try {
        responseData = JSON.parse(text);
      } catch {
        return { ok: false, status: 502, error: '响应非 JSON 格式', provider: meta };
      }
    }
  } catch (fetchError) {
    return { ok: false, status: 502, error: '请求失败: ' + fetchError.message, provider: meta };
  }

  try {
    const { safeEval } = require('./sandbox');
    const result = await safeEval(`(${script.extractor})(response)`, { response: responseData }, {
      timeout: 5000,
      filename: `extractor-${provider.id}.js`
    });
    if (!result || typeof result !== 'object') {
      return { ok: false, status: 502, error: 'extractor 返回无效结果', provider: meta };
    }
    if (result.isValid === false) {
      return { ok: false, status: 502, error: result.invalidMessage || '查询失败', provider: meta };
    }
    Logger.info(`[查询供应商额度] 成功: ${provider.id}`);
    return {
      ok: true,
      status: 200,
      provider: meta,
      quota: {
        planName: result.planName || provider.name,
        unit: result.unit || 'balance',
        total: result.total ?? 0,
        used: result.used ?? 0,
        remaining: result.remaining ?? 0,
        periods: Array.isArray(result.periods) ? result.periods : [],
        extra: result.extra || ''
      }
    };
  } catch (execError) {
    Logger.error(`[查询供应商额度] extractor 执行失败: ${execError.message}`);
    return { ok: false, status: 500, error: 'extractor 执行失败: ' + execError.message, provider: meta };
  }
}

async function queryProviderQuota(provider) {
  const providerId = provider?.id;
  if (!providerId) return queryProviderQuotaInternal(provider);
  const current = quotaInFlight.get(providerId);
  if (current) return current;
  const promise = queryProviderQuotaInternal(provider);
  quotaInFlight.set(providerId, promise);
  try {
    return await promise;
  } finally {
    if (quotaInFlight.get(providerId) === promise) quotaInFlight.delete(providerId);
  }
}

// 按 Key 独立计费的上游模式：多 Key 供应商应逐 Key 查询额度
const PER_KEY_QUOTA_MODES = new Set(['script', 'opencode_go', 'commandcode', 'newapi']);

/** Key 脱敏展示：前 6 位 + **** + 后 4 位，不足 10 位全部掩码 */
function maskApiKey(key) {
  const text = String(key || '');
  if (text.length < 10) return '****';
  return `${text.slice(0, 6)}****${text.slice(-4)}`;
}

function maskKeyEntry(entry, index) {
  const key = entry?.key || '';
  return {
    index,
    label: entry?.label || `Key ${index + 1}`,
    masked_key: maskApiKey(key),
    weight: entry?.weight || 1,
    enabled: entry?.enabled !== false,
  };
}

/**
 * 多 Key 供应商逐 Key 查询额度：
 * - 每个 Key 用独立 provider 克隆（api_key/api_keys 仅含该 Key）走同一查询链路
 * - 结果数组顺序与 Key 列表一致；单 Key 失败不影响其他 Key
 * - balance 单位的结果做聚合汇总（percent 单位无聚合意义，置空顶层）
 * @returns {{ ok: boolean, status: number, keys: Array, aggregated: object|null, provider: object }}
 */
async function queryProviderQuotaPerKey(provider) {
  const providerId = provider?.id;
  if (!providerId) return queryProviderQuotaPerKeyInternal(provider);
  const current = perKeyQuotaInFlight.get(providerId);
  if (current) return current;
  const promise = queryProviderQuotaPerKeyInternal(provider);
  perKeyQuotaInFlight.set(providerId, promise);
  try {
    return await promise;
  } finally {
    if (perKeyQuotaInFlight.get(providerId) === promise) perKeyQuotaInFlight.delete(providerId);
  }
}

async function queryProviderQuotaPerKeyInternal(provider) {
  const meta = { id: provider.id, name: provider.name };
  const entries = normalizeProviderKeyEntries(provider).filter((e) => e.enabled !== false);
  if (entries.length <= 1) {
    const result = await queryProviderQuota(provider);
    const single = result.ok && result.quota ? [{ ...maskKeyEntry(entries[0] || { key: getPrimaryApiKey(provider) }, 0), ok: true, quota: result.quota }] : [];
    return {
      ...result,
      keys: single,
      keyCount: Math.max(entries.length, 1),
      aggregated: result.ok && result.quota?.unit === 'balance' ? result.quota : null,
    };
  }

  // 各 Key 用独立克隆并发查询；必须绕过 queryProviderQuota 的 providerId
  // 在途去重——同一 provider 的不同 Key 克隆应各自请求上游
  const keyResults = await Promise.all(entries.map(async (entry, index) => {
    const singleKeyProvider = {
      ...provider,
      api_key: entry.key,
      api_keys: [{ key: entry.key, weight: entry.weight || 1, enabled: true }],
    };
    try {
      const result = await queryProviderQuotaInternal(singleKeyProvider);
      if (result.ok) {
        return { ...maskKeyEntry(entry, index), ok: true, quota: result.quota };
      }
      return { ...maskKeyEntry(entry, index), ok: false, error: result.error || '查询失败' };
    } catch (err) {
      return { ...maskKeyEntry(entry, index), ok: false, error: err.message || '查询失败' };
    }
  }));

  const balanceResults = keyResults.filter((r) => r.ok && r.quota?.unit === 'balance'
    && Number.isFinite(Number(r.quota.total)) && Number(r.quota.total) > 0);
  let aggregated = null;
  if (balanceResults.length > 0) {
    const sum = (field) => balanceResults.reduce((s, r) => s + (Number(r.quota[field]) || 0), 0);
    const total = sum('total');
    const used = sum('used');
    aggregated = {
      planName: provider.name,
      unit: 'balance',
      total,
      used,
      remaining: sum('remaining'),
      periods: [],
      extra: `共 ${balanceResults.length} 个 Key 有效`,
    };
    if (total > 0) aggregated.currentPercent = Math.round(used / total * 100);
  }

  const anyOk = keyResults.some((r) => r.ok);
  return {
    ok: anyOk,
    status: anyOk ? 200 : 502,
    error: anyOk ? undefined : keyResults.find((r) => r.error)?.error,
    provider: meta,
    keys: keyResults,
    keyCount: entries.length,
    aggregated,
  };
}

async function saveQuotaSnapshot(providerId, result) {
  if (!providerId) return;
  try {
    await pool.query(
      `UPDATE providers SET
         quota_last_checked_at = NOW(),
         quota_last_ok = $2,
         quota_last_result = $3::jsonb,
         quota_last_error = $4
       WHERE id = $1`,
      [
        providerId,
        !!result.ok,
        result.ok ? JSON.stringify(serializeQuotaResult(result)) : null,
        result.ok ? null : String(result.error || '查询失败').slice(0, 1000)
      ]
    );
  } catch (err) {
    Logger.warn(`[额度快照] 保存失败 ${providerId}: ${err.message}`);
  }
}

/** 快照序列化：保留顶层 quota 与逐 Key 明细（keys 仅含脱敏标识与额度/错误） */
function serializeQuotaResult(result) {
  const quota = result.quota || {};
  const payload = {
    planName: quota.planName || '',
    unit: quota.unit || 'balance',
    total: quota.total ?? 0,
    used: quota.used ?? 0,
    remaining: quota.remaining ?? 0,
    periods: Array.isArray(quota.periods) ? quota.periods : [],
    extra: quota.extra || ''
  };
  if (quota.currentPercent !== undefined) payload.currentPercent = quota.currentPercent;
  if (quota.providerType) payload.providerType = quota.providerType;
  if (Array.isArray(result.keys)) {
    payload.keys = result.keys.map((entry) => ({
      index: entry.index,
      masked_key: entry.masked_key,
      label: entry.label || '',
      enabled: entry.enabled !== false,
      ok: !!entry.ok,
      error: entry.ok ? undefined : String(entry.error || '查询失败').slice(0, 500),
      quota: entry.ok ? entry.quota : undefined
    }));
  }
  if (result.aggregated) payload.aggregated = result.aggregated;
  return payload;
}

async function runDueQuotaSchedules() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const due = await pool.query(`
      SELECT *
      FROM providers
      WHERE quota_enabled = TRUE
        AND quota_schedule_enabled = TRUE
        AND (
          quota_last_checked_at IS NULL
          OR quota_last_checked_at <= NOW() - (GREATEST(COALESCE(quota_schedule_interval, $1), 600) * INTERVAL '1 second')
        )
      ORDER BY quota_last_checked_at NULLS FIRST
      LIMIT 20
    `, [DEFAULT_INTERVAL]);

    for (const provider of due.rows) {
      try {
        const result = await queryProviderQuotaPerKey(provider);
        await saveQuotaSnapshot(provider.id, result);
        if (!result.ok) {
          Logger.warn(`[额度定时查询] ${provider.name}(${provider.id}) 失败: ${result.error}`);
        } else {
          Logger.info(`[额度定时查询] ${provider.name}(${provider.id}) 成功`);
        }
      } catch (err) {
        Logger.warn(`[额度定时查询] ${provider.id} 异常: ${err.message}`);
        await saveQuotaSnapshot(provider.id, { ok: false, error: err.message });
      }
    }
  } catch (err) {
    Logger.warn(`[额度定时查询] 调度失败: ${err.message}`);
  } finally {
    schedulerRunning = false;
  }
}

function startQuotaScheduler() {
  if (schedulerTimer) return;
  const tick = () => {
    runDueQuotaSchedules().catch(err => {
      Logger.warn(`[额度定时查询] tick 失败: ${err.message}`);
    });
  };
  schedulerTimer = setInterval(tick, SCHEDULER_TICK_MS);
  setTimeout(tick, 8000);
  Logger.info('[额度定时查询] 调度器已启动');
}

module.exports = {
  QUOTA_SCHEDULE_INTERVALS,
  DEFAULT_INTERVAL,
  normalizeQuotaScheduleInterval,
  generateDefaultQuotaScript,
  queryProviderQuota,
  queryProviderQuotaPerKey,
  saveQuotaSnapshot,
  runDueQuotaSchedules,
  startQuotaScheduler,
  maskApiKey
};
