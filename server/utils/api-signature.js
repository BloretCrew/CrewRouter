const { pool } = require('../models/database');
const { getUserQuotaBuffer } = require('./quota-data');
const Logger = require('../logger');
const proxyPool = require('../proxy-pool');

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const DEFAULT_TEMPLATE = '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}';
const SIGNATURE_TEMPLATE_MAX_LENGTH = 2000;

// Keep this list in sync with the placeholders handled by buildSignature().
const SIGNATURE_VARIABLES = [
  'model', 'tokens', 'cache_hit', 'cached_tokens', 'provider', 'cost',
  'username', 'key_name', 'balance', 'quota_info', 'team_name',
  'today_requests', 'today_tokens'
];

/**
 * Format token count for display: >=1000 shows as "12.3k", with " tokens" suffix.
 */
function formatTokens(n) {
  if (!n || n <= 0) return '0 tokens';
  if (n >= 1000) {
    const k = n / 1000;
    return `${k.toFixed(1)}k tokens`;
  }
  return `${n} tokens`;
}

/**
 * Format cost for display (now in points/积分).
 */
function formatCost(n) {
  if (!n || n <= 0) return '0 积分';
  if (n < 0.01) return `${n.toFixed(4)} 积分`;
  return `${n.toFixed(2)} 积分`;
}

function normalizeSignatureTemplate(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function signatureValidationError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function validateSignatureTemplate(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw signatureValidationError('签名模板格式不正确', 'invalid_signature_template');
  }
  const template = value.trim();
  if (template.length > SIGNATURE_TEMPLATE_MAX_LENGTH) {
    throw signatureValidationError(`签名模板不能超过 ${SIGNATURE_TEMPLATE_MAX_LENGTH} 个字符`, 'invalid_signature_template');
  }
  return template;
}

function validateSignatureEnabled(value) {
  if (typeof value !== 'boolean') {
    throw signatureValidationError('签名开关值无效', 'invalid_signature_enabled');
  }
  return value;
}

function validateSignatureTriState(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw signatureValidationError('签名开关值无效', 'invalid_signature_enabled');
  }
  return value;
}

/**
 * Resolve a Key's signature settings against the owning user's defaults.
 * This is the only place that implements the inheritance rules.
 */
function resolveSignatureConfig({ key = {}, user = {} } = {}) {
  const keyEnabled = key.signature_enabled === true ? true
    : key.signature_enabled === false ? false
      : null;
  const userEnabled = user.api_signature_enabled === true;
  const keyTemplate = normalizeSignatureTemplate(key.signature_template);
  const userTemplate = normalizeSignatureTemplate(user.api_signature_template);
  return {
    enabled: keyEnabled === null ? userEnabled : keyEnabled,
    template: keyTemplate || userTemplate,
    source: keyEnabled === null ? 'user' : 'key',
    keyEnabled,
    keyTemplate: keyTemplate || null,
    userEnabled,
    userTemplate
  };
}

/**
 * Fetch user's team name. Tries user_teams first (many-to-many), then falls back to users.team_id.
 */
async function getTeamName(userId) {
  try {
    const r = await pool.query(
      `SELECT t.name FROM user_teams ut
       JOIN teams t ON ut.team_id = t.id
       WHERE ut.user_id = $1 ORDER BY ut.id LIMIT 1`,
      [userId]
    );
    if (r.rows.length > 0) return r.rows[0].name;
    // Fallback: direct team_id on users table
    const r2 = await pool.query(
      `SELECT t.name FROM users u JOIN teams t ON u.team_id = t.id WHERE u.id = $1`,
      [userId]
    );
    return r2.rows[0]?.name || null;
  } catch (err) {
    Logger.warn(`[Signature] 获取 Team 名失败: ${err.message}`);
    return null;
  }
}

/**
 * Fetch today's request count and token usage from usage_records.
 */
async function getTodayStats(userId) {
  try {
    // usage_records 在请求成功时同步写入，不需要再叠加 quota buffer
    // （buffer 对应的是 quota_data 刷盘延迟，若叠加会双重计数）
    // 会话时区为 Asia/Shanghai，CURRENT_DATE 即上海日历日
    const r = await pool.query(
      `SELECT COALESCE(SUM(tokens_used), 0) AS tokens,
              COALESCE(COUNT(*), 0) AS requests
       FROM usage_records
       WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
      [userId]
    );
    return {
      tokens: parseInt(r.rows[0].tokens, 10) || 0,
      requests: parseInt(r.rows[0].requests, 10) || 0
    };
  } catch (err) {
    Logger.warn(`[Signature] 获取今日统计失败: ${err.message}`);
    return { tokens: 0, requests: 0 };
  }
}

async function getOpenCodeGoQuotaWarning(provider, enabled = false) {
  if (!enabled || provider?.quota_mode !== 'opencode_go' || !provider?.api_key) return '';
  try {
    const response = await proxyPool.pinnedFetch(OPENCODE_GO_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${provider.api_key}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual'
    });
    if (!response.ok) return '';
    const data = await response.json();
    const usage = data?.usage || {};
    const periods = ['rolling', 'weekly', 'monthly']
      .map(key => ({ key, ...(usage[key] || {}) }))
      .filter(period => Number.isFinite(Number(period.percent)));
    try {
      for (const period of periods) {
        require('../plugins/events').publish('quota.threshold.v1', {
          scope: `opencode_go:${period.key}`,
          remaining: Math.max(0, 100 - Number(period.percent)),
          threshold: 10,
          observedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      Logger.warn(`[Signature] 配额事件发布失败: ${err.message}`);
    }
    const warningPeriods = periods.filter(period => Number(period.percent) >= 90);
    if (warningPeriods.length === 0) return '';
    const labels = { rolling: 'Rolling', weekly: 'Weekly', monthly: 'Monthly' };
    const details = warningPeriods.map(period => {
      const remaining = Math.max(0, 100 - Number(period.percent));
      const reset = period.resetsAt ? `，重置于 ${period.resetsAt}` : '';
      return `${labels[period.key] || period.key} 剩余 ${remaining}%${reset}`;
    }).join('；');
    return `⚠️ OpenCode Go 额度提醒：${details}`;
  } catch (err) {
    Logger.warn(`[Signature] 获取 OpenCode Go 额度预警失败: ${err.message}`);
    return '';
  }
}

async function getQuotaInfo(userId) {
  try {
    const userRes = await pool.query('SELECT team_id FROM users WHERE id = $1', [userId]);
    const teamId = userRes.rows[0]?.team_id;
    if (!teamId) return null;

    const rulesRes = await pool.query('SELECT quota_rules FROM teams WHERE id = $1', [teamId]);
    let rules = rulesRes.rows[0]?.quota_rules || [];
    if (typeof rules === 'string') rules = JSON.parse(rules || '[]');
    if (!Array.isArray(rules) || rules.length === 0) return null;

    const parts = [];
    for (const rule of rules) {
      const { rule_type, rule_value, duration_hours } = rule;
      if (!rule_value || rule_value <= 0) continue;

      const since = new Date(Date.now() - (duration_hours || 0) * 3600 * 1000);
      const aggregate = rule_type === 'requests' ? 'COUNT(*)' : 'COALESCE(SUM(weighted_tokens), 0)';
      const r = await pool.query(
        `SELECT ${aggregate} AS total FROM usage_records WHERE user_id = $1 AND created_at >= $2`,
        [userId, since]
      );
      let used = parseInt(r.rows[0].total);

      // Add in-memory buffered usage not yet flushed (using user index for performance)
      const userBuffer = getUserQuotaBuffer(userId);
      for (const entry of userBuffer) {
        if (entry.created_at >= since) {
          used += rule_type === 'requests' ? entry.count : (entry.weighted_tokens || entry.token_used);
        }
      }

      const pct = Math.min(100, Math.round((used / rule_value) * 100));
      const windowLabel = duration_hours >= 24
        ? `${duration_hours / 24}天限额`
        : `${duration_hours}小时限额`;
      parts.push(`${windowLabel} ${pct}%`);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
  } catch (err) {
    Logger.warn(`[Signature] 获取限额信息失败: ${err.message}`);
    return null;
  }
}

/**
 * Preload only the DB-backed values the effective template actually uses.
 * Returns {} when signature is off or the template is empty.
 */
async function preloadSignatureData(apiUser) {
  const config = apiUser?.signature;
  if (!config?.enabled || !config.template) return {};

  const template = config.template;
  const needsQuota = /\{quota_info\}/.test(template);
  const needsTeam = /\{team_name\}/.test(template) || /\{group_name\}/.test(template);
  const needsToday = /\{today_requests\}/.test(template) || /\{today_tokens\}/.test(template);
  if (!needsQuota && !needsTeam && !needsToday) return {};

  const userId = apiUser.userId;
  const [quotaInfo, teamName, todayStats] = await Promise.all([
    needsQuota ? getQuotaInfo(userId) : undefined,
    needsTeam ? getTeamName(userId) : undefined,
    needsToday ? getTodayStats(userId) : undefined,
  ]);

  const preloaded = {};
  if (needsQuota) preloaded.quotaInfo = quotaInfo;
  if (needsTeam) preloaded.teamName = teamName;
  if (needsToday) preloaded.todayStats = todayStats;
  return preloaded;
}

/**
 * Request-scoped memoized preload. The promise is created once per request.
 */
async function ensureSignaturePreload(req) {
  if (!req) return {};
  if (!req._signaturePreloadPromise) {
    req._signaturePreloadPromise = preloadSignatureData(req.apiUser);
  }
  return req._signaturePreloadPromise;
}

/**
 * Build the signature string by applying template variable substitution.
 *
 * Supported variables (no DB query needed):
 *   {model}, {tokens}, {cache_hit}, {cached_tokens}, {provider},
 *   {cost}, {username}, {key_name}, {balance}
 *
 * Supported variables (require DB query unless preloaded):
 *   {quota_info}, {team_name}, {today_requests}, {today_tokens}
 *   {group_name} is a legacy alias of {team_name}.
 *
 * An empty template means "no signature" — there is no default-template fallback.
 */
async function buildSignature({ template, meta = {}, userId, preloaded = {} }) {
  const tmpl = normalizeSignatureTemplate(template);
  if (!tmpl) return '';

  const totalTokens = (meta.promptTokens || 0) + (meta.completionTokens || 0);
  const cacheHit = meta.promptTokens > 0
    ? Math.min(100, Math.max(0, Math.round(((meta.cachedTokens || 0) / meta.promptTokens) * 100)))
    : 0;

  // Fast replacements — no DB queries
  let result = tmpl
    .replace(/\{model\}/g, meta.modelDisplayName || meta.model || '')
    .replace(/\{tokens\}/g, formatTokens(totalTokens))
    .replace(/\{cache_hit\}/g, String(cacheHit))
    .replace(/\{cached_tokens\}/g, (meta.cachedTokens || 0).toLocaleString())
    .replace(/\{provider\}/g, meta.providerName || '')
    .replace(/\{cost\}/g, formatCost(meta.cost))
    .replace(/\{username\}/g, meta.username || '')
    .replace(/\{key_name\}/g, meta.keyName || '')
    .replace(/\{balance\}/g, (meta.balance ?? '').toString());

  // Lazy DB queries — only if the template actually uses these variables
  const needsQuota = /\{quota_info\}/.test(tmpl);
  const needsTeam = /\{team_name\}/.test(tmpl) || /\{group_name\}/.test(tmpl);
  const needsToday = /\{today_requests\}/.test(tmpl) || /\{today_tokens\}/.test(tmpl);

  if (needsQuota) {
    let quotaInfo;
    if (preloaded && preloaded.quotaInfo !== undefined) {
      quotaInfo = preloaded.quotaInfo;
    } else {
      quotaInfo = userId ? await getQuotaInfo(userId) : null;
    }
    result = result.replace(/\{quota_info\}/g, quotaInfo || '');
  }

  if (needsTeam) {
    let teamName;
    if (preloaded && preloaded.teamName !== undefined) {
      teamName = preloaded.teamName;
    } else {
      teamName = userId ? await getTeamName(userId) : null;
    }
    result = result
      .replace(/\{team_name\}/g, teamName || '')
      .replace(/\{group_name\}/g, teamName || '');
  }

  if (needsToday) {
    let stats;
    if (preloaded && preloaded.todayStats !== undefined) {
      stats = preloaded.todayStats;
    } else {
      stats = userId ? await getTodayStats(userId) : { tokens: 0, requests: 0 };
    }
    result = result
      .replace(/\{today_requests\}/g, stats.requests.toLocaleString())
      .replace(/\{today_tokens\}/g, formatTokens(stats.tokens));
  }

  // Clean up dangling separators if any variable was empty
  result = result.replace(/\s*[·•]\s*[·•]\s*/g, ' · ').replace(/^\s*[·•]\s*/, '').replace(/\s*[·•]\s*$/, '');

  return result.trim();
}

// ---------- 双通道注入 + 智能跳过 ----------

const SIGNATURE_HEADER = 'X-CrewRouter-Signature';
const SIGNATURE_HEADER_B64 = 'X-CrewRouter-Signature-B64';
const SIGNATURE_MODE_HEADER = 'x-crewrouter-signature-mode';

/**
 * 解析客户端强制投放模式。
 * - header: 仅响应头，不改 content
 * - content: 仅 content（仍可能因智能跳过而不写 content）
 * - both / 缺省: 头 + content（智能跳过时仅头）
 */
function resolveSignatureMode(req) {
  const raw = (req?.headers?.[SIGNATURE_MODE_HEADER]
    || req?.headers?.['X-CrewRouter-Signature-Mode']
    || '').toString().trim().toLowerCase();
  if (raw === 'header' || raw === 'content' || raw === 'both') return raw;
  return 'both';
}

/**
 * HTTP 头是否适合直接放入（无 CR/LF 等）
 */
function isHeaderSafe(text) {
  if (!text) return false;
  return /^[\x20-\x7e]*$/.test(text) && text.length <= 2048;
}

/**
 * 设置签名相关响应头；并暴露给 CORS 浏览器端。
 * 若 headers 已发送则静默跳过。
 */
function setSignatureHeaders(res, signature) {
  if (!signature || !res || res.headersSent) {
    return false;
  }
  try {
    if (isHeaderSafe(signature)) {
      res.setHeader(SIGNATURE_HEADER, signature);
    } else {
      res.setHeader(SIGNATURE_HEADER_B64, Buffer.from(signature, 'utf8').toString('base64'));
    }
    const expose = res.getHeader('Access-Control-Expose-Headers');
    const needed = `${SIGNATURE_HEADER}, ${SIGNATURE_HEADER_B64}`;
    if (!expose) {
      res.setHeader('Access-Control-Expose-Headers', needed);
    } else {
      const cur = String(expose);
      const parts = new Set(cur.split(',').map(s => s.trim()).filter(Boolean));
      parts.add(SIGNATURE_HEADER);
      parts.add(SIGNATURE_HEADER_B64);
      res.setHeader('Access-Control-Expose-Headers', [...parts].join(', '));
    }
    return true;
  } catch (err) {
    Logger.warn(`[Signature] 设置响应头失败: ${err.message}`);
    return false;
  }
}

function isStructuredOutputRequest(requestBody = {}) {
  const rf = requestBody.response_format?.type || requestBody.text?.format?.type;
  if (rf === 'json_object' || rf === 'json_schema') return true;
  const config = requestBody.generationConfig;
  const gemini = requestBody.passthrough?.gemini?.generationConfigExtras
    || requestBody.ir?.passthrough?.gemini?.generationConfigExtras;
  return [config, gemini].some(value => value && (
    /^(?:application\/json|text\/x\.enum)(?:\s*;|$)/i.test(value.responseMimeType || '')
    || value.responseSchema != null || value.responseJsonSchema != null
  )) || requestBody.response_format?.type === 'json';
}

/**
 * 判断是否应把签名追加进 content。
 * 只追加到已存在的正文结构，绝不新建 message/text block。
 */
function shouldAppendSignatureToContent(opts = {}) {
  const mode = opts.mode || 'both';
  if (mode === 'header') {
    return { append: false, reason: 'mode_header' };
  }
  if (isStructuredOutputRequest(opts.requestBody)) {
    return { append: false, reason: 'json_response_format' };
  }

  const format = opts.format || 'openai';

  if (format === 'openai') {
    const msg = opts.responseShape?.choices?.[0]?.message
      || opts.responseShape?.message
      || null;
    const finishReason = opts.finishReason
      ?? opts.responseShape?.choices?.[0]?.finish_reason
      ?? null;
    const hasTools = opts.hasToolCalls
      ?? !!(msg?.tool_calls && msg.tool_calls.length > 0);
    let hasText = opts.hasTextContent;
    if (hasText === undefined) {
      const content = msg?.content;
      hasText = typeof content === 'string'
        ? content.length > 0
        : Array.isArray(content) && content.some(part => typeof part?.text === 'string' && part.text.length > 0);
    }

    if (hasTools && !hasText) {
      return { append: false, reason: 'tool_calls_only' };
    }
    if (finishReason === 'tool_calls' && !hasText) {
      return { append: false, reason: 'finish_tool_calls_no_text' };
    }
    if (!hasText) {
      return { append: false, reason: 'no_text_content' };
    }
    return { append: true, reason: 'ok' };
  }

  if (format === 'anthropic') {
    const content = opts.responseShape?.content;
    let hasText = opts.hasTextContent;
    if (hasText === undefined) {
      hasText = Array.isArray(content)
        && content.some(b => b.type === 'text' && (b.text || '').length > 0);
    }
    if (!hasText) {
      return { append: false, reason: 'no_text_content' };
    }
    return { append: true, reason: 'ok' };
  }

  if (format === 'responses') {
    const output = opts.responseShape?.output || [];
    const hasMessageText = output.some(o =>
      o.type === 'message'
      && Array.isArray(o.content)
      && o.content.some(c => (c.text || '').length > 0)
    );
    if (!hasMessageText) {
      return { append: false, reason: 'no_text_content' };
    }
    return { append: true, reason: 'ok' };
  }

  if (format === 'ir') {
    const blocks = opts.responseShape?.message?.blocks;
    const hasText = opts.hasTextContent
      ?? (Array.isArray(blocks) && blocks.some(b => b?.type === 'text' && (b.text || '').length > 0));
    if (!hasText) {
      return { append: false, reason: 'no_text_content' };
    }
    return { append: true, reason: 'ok' };
  }

  return { append: true, reason: 'ok' };
}

/**
 * 流式场景：根据已观测状态决定是否在流末追加 content 签名。
 * 注意：headers 通常已 flush，无法再设响应头。
 */
function planStreamSignatureInjection({
  mode = 'both',
  requestBody,
  hasTextContent = false,
  hasToolCalls = false,
  finishReason = null,
  stopReason = null,
  format = 'openai'
} = {}) {
  if (mode === 'header') {
    return { appendContent: false, reason: 'mode_header', note: 'stream_headers_already_flushed' };
  }
  const decision = shouldAppendSignatureToContent({
    format,
    mode,
    requestBody,
    hasTextContent,
    hasToolCalls,
    finishReason,
    stopReason,
    responseShape: format === 'openai'
      ? {
          choices: [{
            finish_reason: finishReason,
            message: {
              content: hasTextContent ? 'x' : null,
              tool_calls: hasToolCalls ? [{}] : undefined
            }
          }]
        }
      : format === 'anthropic'
        ? {
            stop_reason: stopReason,
            content: [
              ...(hasTextContent ? [{ type: 'text', text: 'x' }] : []),
              ...(hasToolCalls ? [{ type: 'tool_use' }] : [])
            ]
          }
        : format === 'ir'
          ? {
              message: {
                blocks: [
                  ...(hasTextContent ? [{ type: 'text', text: 'x' }] : []),
                  ...(hasToolCalls ? [{ type: 'tool_use' }] : [])
                ]
              }
            }
          : {
              output: [
                ...(hasTextContent ? [{ type: 'message', content: [{ text: 'x' }] }] : []),
                ...(hasToolCalls ? [{ type: 'function_call' }] : [])
              ]
            }
  });
  return {
    appendContent: decision.append,
    reason: decision.reason,
    note: 'stream_no_late_headers'
  };
}

function appendSignatureText(existing, signature) {
  if (!signature) return existing;
  if (existing == null || existing === '') return signature;
  return `${existing}\n\n${signature}`;
}

function appendToOpenAIMessage(message, signature) {
  if (!message) return false;
  const content = message.content;
  if (typeof content === 'string') {
    if (!content) return false;
    message.content = appendSignatureText(content, signature);
    return true;
  }
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i];
      if (part && typeof part.text === 'string' && part.text.length > 0) {
        part.text = appendSignatureText(part.text, signature);
        return true;
      }
    }
  }
  return false;
}

function appendToAnthropicContent(blocks, signature) {
  if (!Array.isArray(blocks)) return false;
  const block = [...blocks].reverse().find(b => b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0);
  if (!block) return false;
  block.text = appendSignatureText(block.text, signature);
  return true;
}

function appendToResponsesPayload(payload, signature) {
  const output = payload?.output || [];
  const message = [...output].reverse().find(o => o?.type === 'message' && o.content?.some(c =>
    (c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string' && c.text.length > 0));
  const part = message?.content?.slice().reverse().find(c =>
    (c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string' && c.text.length > 0
  );
  if (!part) return false;
  part.text = appendSignatureText(part.text, signature);
  if (typeof payload.output_text === 'string') {
    payload.output_text = appendSignatureText(payload.output_text, signature);
  }
  return true;
}

function appendToIrPayload(payload, signature) {
  const blocks = payload?.message?.blocks;
  if (!Array.isArray(blocks)) return false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      block.text = appendSignatureText(block.text, signature);
      return true;
    }
  }
  return false;
}

/**
 * 非流式统一投放。
 * @param {'openai'|'anthropic'|'responses'|'ir'} format
 * @returns {{ header: boolean, appendContent: boolean, reason: string }}
 */
function applySignatureToJson(res, format, payload, signature, opts = {}) {
  if (!signature) return { header: false, appendContent: false, reason: 'empty' };

  const mode = opts.mode || 'both';
  const header = (mode === 'header' || mode === 'both')
    ? setSignatureHeaders(res, signature)
    : false;

  const decision = shouldAppendSignatureToContent({
    format,
    mode,
    requestBody: opts.requestBody,
    responseShape: payload
  });

  let appendContent = false;
  if (decision.append && mode !== 'header') {
    if (format === 'openai') {
      appendContent = appendToOpenAIMessage(payload?.choices?.[0]?.message, signature)
        || appendToOpenAIMessage(payload?.message, signature);
    } else if (format === 'anthropic') {
      appendContent = appendToAnthropicContent(payload?.content, signature);
    } else if (format === 'responses') {
      appendContent = appendToResponsesPayload(payload, signature);
    } else if (format === 'ir') {
      appendContent = appendToIrPayload(payload, signature);
    }
  }

  Logger.info(`[Signature] ${format} inject: header=${header}, appendContent=${appendContent}, reason=${decision.reason}, mode=${mode}`);
  return { header, appendContent, reason: decision.reason };
}

/**
 * 从 apiUser.signature 构建签名（减少路由层重复）。
 * 关闭或空模板时返回空串；此时也不会追加 OpenCode Go 额度预警。
 */
async function buildSignatureForRequest(req, {
  model,
  normalized,
  providerName,
  provider
} = {}) {
  const config = req?.apiUser?.signature;
  if (!config?.enabled || !config.template) return '';

  const promptTokens = normalized?.promptTokens || 0;
  const completionTokens = normalized?.completionTokens || 0;
  const preloaded = await ensureSignaturePreload(req);
  const signature = await buildSignature({
    template: config.template,
    meta: {
      model,
      modelDisplayName: model,
      promptTokens,
      completionTokens,
      cachedTokens: normalized?.cachedTokens || 0,
      providerName: providerName || '',
      username: req.apiUser.username,
      keyName: req.apiUser.keyName,
      balance: req.apiUser.balance,
      teamId: req.apiUser.teamId,
      cost: (promptTokens / 1000) * (req.apiUser._inputPrice || 0)
        + (completionTokens / 1000) * (req.apiUser._outputPrice || 0)
    },
    userId: req.apiUser.userId,
    preloaded
  });

  if (!signature) return '';
  const quotaWarning = await getOpenCodeGoQuotaWarning(provider, req.apiUser.quotaWarningEnabled === true);
  return [signature, quotaWarning].filter(Boolean).join('\n\n');
}

/**
 * 非流式路由统一入口：构建 + 投放。
 */
async function finalizeJsonSignature(req, res, format, payload, meta = {}) {
  const signature = await buildSignatureForRequest(req, meta);
  if (!signature) return { header: false, appendContent: false, reason: 'empty' };
  return applySignatureToJson(res, format, payload, signature, {
    mode: resolveSignatureMode(req),
    requestBody: req.body
  });
}

/**
 * 流式路由统一入口：决定是否在流末追加正文。
 * state.emitText(text) 由各协议路径提供；header 模式下不投任何内容（流式无法设头）。
 */
async function finalizeStreamSignature(req, meta = {}, state = {}) {
  const plan = planStreamSignatureInjection({
    mode: state.mode || resolveSignatureMode(req),
    requestBody: state.requestBody || req.body,
    hasTextContent: state.hasTextContent === true,
    hasToolCalls: state.hasToolCalls === true,
    finishReason: state.finishReason,
    stopReason: state.stopReason,
    format: state.format || 'openai'
  });

  if (!plan.appendContent || typeof state.emitText !== 'function') {
    return { appended: false, reason: plan.reason };
  }
  if (req?._requestLifecycle?.signal?.aborted || req?.res?.destroyed || req?.res?.writableEnded) {
    return { appended: false, reason: 'disconnected' };
  }
  const signature = await buildSignatureForRequest(req, meta);
  if (!signature) return { appended: false, reason: 'empty' };
  if (req?._requestLifecycle?.signal?.aborted || req?.res?.destroyed || req?.res?.writableEnded) {
    return { appended: false, reason: 'disconnected' };
  }
  await state.emitText(`\n\n${signature}`);
  return { appended: true, reason: plan.reason, signature };
}

module.exports = {
  buildSignature,
  getQuotaInfo,
  getTeamName,
  getTodayStats,
  formatTokens,
  formatCost,
  DEFAULT_TEMPLATE,
  SIGNATURE_VARIABLES,
  SIGNATURE_TEMPLATE_MAX_LENGTH,
  getOpenCodeGoQuotaWarning,
  normalizeSignatureTemplate,
  validateSignatureTemplate,
  validateSignatureEnabled,
  validateSignatureTriState,
  resolveSignatureConfig,
  preloadSignatureData,
  ensureSignaturePreload,
  // 双通道注入
  SIGNATURE_HEADER,
  SIGNATURE_HEADER_B64,
  resolveSignatureMode,
  setSignatureHeaders,
  shouldAppendSignatureToContent,
  planStreamSignatureInjection,
  appendSignatureText,
  applySignatureToJson,
  buildSignatureForRequest,
  finalizeJsonSignature,
  finalizeStreamSignature
};
