const { pool } = require('../models/database');
const { getUserQuotaBuffer } = require('./quota-data');
const Logger = require('../logger');

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const DEFAULT_TEMPLATE = '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}';

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

/**
 * Fetch user's group name from user_groups table.
 */
async function getGroupName(groupId) {
  if (!groupId) return null;
  try {
    const r = await pool.query('SELECT name FROM user_groups WHERE id = $1', [groupId]);
    return r.rows[0]?.name || null;
  } catch (err) {
    Logger.warn(`[Signature] 获取用户组名失败: ${err.message}`);
    return null;
  }
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

/**
 * Compute a user's quota usage percentages from user_group_rules.
 *
 * @param {number} userId
 * @returns {Promise<string|null>} - Quota string, or null if no rules.
 */
async function getOpenCodeGoQuotaWarning(provider, enabled = false) {
  if (!enabled || provider?.quota_mode !== 'opencode_go' || !provider?.api_key) return '';
  try {
    const response = await fetch(OPENCODE_GO_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${provider.api_key}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return '';
    const data = await response.json();
    const usage = data?.usage || {};
    const periods = ['rolling', 'weekly', 'monthly']
      .map(key => ({ key, ...(usage[key] || {}) }))
      .filter(period => Number.isFinite(Number(period.percent)) && Number(period.percent) >= 90);
    if (periods.length === 0) return '';
    const labels = { rolling: 'Rolling', weekly: 'Weekly', monthly: 'Monthly' };
    const details = periods.map(period => {
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
    const userRes = await pool.query('SELECT group_id FROM users WHERE id = $1', [userId]);
    const groupId = userRes.rows[0]?.group_id;
    if (!groupId) return null;

    const rulesRes = await pool.query(
      'SELECT rule_type, rule_value, duration_hours FROM user_group_rules WHERE group_id = $1',
      [groupId]
    );
    if (rulesRes.rows.length === 0) return null;

    const parts = [];
    for (const rule of rulesRes.rows) {
      const { rule_type, rule_value, duration_hours } = rule;
      if (!rule_value || rule_value <= 0) continue;

      const since = new Date(Date.now() - (duration_hours || 0) * 3600 * 1000);
      const col = rule_type === 'requests' ? 'count' : 'token_used';
      const r = await pool.query(
        `SELECT COALESCE(SUM(${col}), 0) AS total FROM quota_data WHERE user_id = $1 AND created_at >= $2`,
        [userId, since]
      );
      let used = parseInt(r.rows[0].total);

      // Add in-memory buffered usage not yet flushed (using user index for performance)
      const userBuffer = getUserQuotaBuffer(userId);
      for (const entry of userBuffer) {
        if (entry.created_at >= since) {
          used += rule_type === 'requests' ? entry.count : entry.token_used;
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
 * Build the signature string by applying template variable substitution.
 * Only queries the database for variables that are actually used in the template.
 *
 * Supported variables (no DB query needed):
 *   {model}, {tokens}, {cache_hit}, {cached_tokens}, {provider},
 *   {cost}, {username}, {key_name}, {balance}
 *
 * Supported variables (require DB query, loaded lazily):
 *   {quota_info}, {group_name}, {team_name}, {today_requests}, {today_tokens}
 *
 * @param {object} opts
 * @param {boolean} opts.enabled
 * @param {string} opts.template
 * @param {object} opts.meta - See below for fields.
 * @param {number} opts.userId
 * @param {object} [opts.preloaded] - Preloaded data to avoid DB queries
 * @param {string} [opts.preloaded.quotaInfo] - Preloaded quota info
 * @param {string} [opts.preloaded.groupName] - Preloaded group name
 * @param {string} [opts.preloaded.teamName] - Preloaded team name
 * @param {object} [opts.preloaded.todayStats] - Preloaded today stats {tokens, requests}
 * @returns {Promise<string>}
 */
async function buildSignature({ enabled, template, meta, userId, preloaded }) {
  if (enabled === false) return '';
  const tmpl = template || DEFAULT_TEMPLATE;
  if (!tmpl.trim()) return '';

  const totalTokens = (meta.promptTokens || 0) + (meta.completionTokens || 0);
  const cacheHit = meta.promptTokens > 0
    ? Math.round((meta.cachedTokens / meta.promptTokens) * 100)
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
  // Use preloaded data if available, otherwise query the database
  const needsQuota = /\{quota_info\}/.test(tmpl);
  const needsGroupName = /\{group_name\}/.test(tmpl);
  const needsTeamName = /\{team_name\}/.test(tmpl);
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

  if (needsGroupName) {
    let groupName;
    if (preloaded && preloaded.groupName !== undefined) {
      groupName = preloaded.groupName;
    } else {
      groupName = meta.groupId ? await getGroupName(meta.groupId) : null;
    }
    result = result.replace(/\{group_name\}/g, groupName || '');
  }

  if (needsTeamName) {
    let teamName;
    if (preloaded && preloaded.teamName !== undefined) {
      teamName = preloaded.teamName;
    } else {
      teamName = userId ? await getTeamName(userId) : null;
    }
    result = result.replace(/\{team_name\}/g, teamName || '');
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

// ---------- 双通道注入 + 智能跳过（Phase 1）----------

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
  return !/[\r\n]/.test(text) && text.length <= 2048;
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

/**
 * 判断是否应把签名追加进 content。
 *
 * @param {object} opts
 * @param {'openai'|'anthropic'|'responses'} opts.format
 * @param {object} [opts.requestBody]
 * @param {object} [opts.responseShape] - 依 format 不同
 * @param {string} [opts.mode] - both|header|content
 * @param {boolean} [opts.hasTextContent]
 * @param {boolean} [opts.hasToolCalls]
 * @param {string} [opts.finishReason] - openai finish_reason
 * @param {string} [opts.stopReason] - anthropic stop_reason
 * @returns {{ append: boolean, reason: string }}
 */
function shouldAppendSignatureToContent(opts = {}) {
  const mode = opts.mode || 'both';
  if (mode === 'header') {
    return { append: false, reason: 'mode_header' };
  }

  const body = opts.requestBody || {};
  const rf = body.response_format?.type || body.text?.format?.type;
  if (rf === 'json_object' || rf === 'json_schema') {
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
    const text = msg?.content;
    const hasText = opts.hasTextContent
      ?? (text != null && String(text).length > 0);

    if (hasTools && !hasText) {
      return { append: false, reason: 'tool_calls_only' };
    }
    if (finishReason === 'tool_calls' && !hasText) {
      return { append: false, reason: 'finish_tool_calls_no_text' };
    }
    return { append: true, reason: 'ok' };
  }

  if (format === 'anthropic') {
    const content = opts.responseShape?.content;
    const stopReason = opts.stopReason ?? opts.responseShape?.stop_reason ?? null;
    let hasText = opts.hasTextContent;
    if (hasText === undefined) {
      if (Array.isArray(content)) {
        hasText = content.some(b => b.type === 'text' && (b.text || '').length > 0);
      } else {
        hasText = false;
      }
    }
    const hasTools = opts.hasToolCalls
      ?? (Array.isArray(content) && content.some(b => b.type === 'tool_use'));

    if ((stopReason === 'tool_use' || hasTools) && !hasText) {
      return { append: false, reason: 'anthropic_tool_use_no_text' };
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
    const hasFc = output.some(o => o.type === 'function_call');
    if (hasFc && !hasMessageText) {
      return { append: false, reason: 'responses_function_call_only' };
    }
    if (!hasMessageText && opts.hasTextContent === false) {
      return { append: false, reason: 'responses_no_text' };
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

/**
 * 非流式 OpenAI chat.completion 响应：设头 + 按需改 content
 * @returns {{ header: boolean, appendContent: boolean, reason: string }}
 */
function injectSignatureIntoOpenAIResponse(res, data, signature, opts = {}) {
  if (!signature) return { header: false, appendContent: false, reason: 'empty' };

  const mode = opts.mode || 'both';
  const header = (mode === 'header' || mode === 'both' || mode === 'content')
    ? setSignatureHeaders(res, signature)
    : false;

  // mode content 也设头（Phase 1：头始终尽量设置，便于自动化）
  // 若 mode 为 content，仍设头；仅 append 决策不同
  const decision = shouldAppendSignatureToContent({
    format: 'openai',
    mode: mode === 'header' ? 'header' : 'both',
    requestBody: opts.requestBody,
    responseShape: data
  });

  let appendContent = false;
  if (decision.append && mode !== 'header' && data?.choices?.[0]?.message) {
    const msg = data.choices[0].message;
    if (msg.content != null) {
      msg.content = appendSignatureText(msg.content || '', signature);
      appendContent = true;
    } else if (!msg.tool_calls) {
      msg.content = signature;
      appendContent = true;
    }
  }

  Logger.info(`[Signature] openai inject: header=${header}, appendContent=${appendContent}, reason=${decision.reason}, mode=${mode}`);
  return { header, appendContent, reason: decision.reason };
}

/**
 * 非流式 Anthropic message 响应
 */
function injectSignatureIntoAnthropicResponse(res, data, signature, opts = {}) {
  if (!signature) return { header: false, appendContent: false, reason: 'empty' };

  const mode = opts.mode || 'both';
  const header = setSignatureHeaders(res, signature);
  const decision = shouldAppendSignatureToContent({
    format: 'anthropic',
    mode: mode === 'header' ? 'header' : 'both',
    requestBody: opts.requestBody,
    responseShape: data
  });

  let appendContent = false;
  if (decision.append && mode !== 'header') {
    data.content = data.content || [];
    const textBlock = data.content.find(b => b.type === 'text');
    if (textBlock) {
      textBlock.text = appendSignatureText(textBlock.text || '', signature);
      appendContent = true;
    } else {
      // 无 text 且 decision 允许时（罕见）追加 text 块到末尾
      data.content.push({ type: 'text', text: signature });
      appendContent = true;
    }
  }

  Logger.info(`[Signature] anthropic inject: header=${header}, appendContent=${appendContent}, reason=${decision.reason}, mode=${mode}`);
  return { header, appendContent, reason: decision.reason };
}

/**
 * 非流式 Responses API 响应
 */
function injectSignatureIntoResponsesBody(res, result, signature, opts = {}) {
  if (!signature) return { header: false, appendContent: false, reason: 'empty' };

  const mode = opts.mode || 'both';
  const header = setSignatureHeaders(res, signature);
  const decision = shouldAppendSignatureToContent({
    format: 'responses',
    mode: mode === 'header' ? 'header' : 'both',
    requestBody: opts.requestBody,
    responseShape: result
  });

  let appendContent = false;
  if (decision.append && mode !== 'header') {
    const textItem = (result.output || []).find(o => o.type === 'message');
    if (textItem?.content?.[0]) {
      textItem.content[0].text = appendSignatureText(textItem.content[0].text || '', signature);
      result.output_text = appendSignatureText(result.output_text || '', signature);
      appendContent = true;
    }
  }

  Logger.info(`[Signature] responses inject: header=${header}, appendContent=${appendContent}, reason=${decision.reason}, mode=${mode}`);
  return { header, appendContent, reason: decision.reason };
}

/**
 * 从 apiUser + usage 构建签名（减少路由层重复）
 */
async function buildSignatureForRequest(req, {
  model,
  normalized,
  providerName,
  provider,
  preloaded
} = {}) {
  if (!req?.apiUser) return '';
  const promptTokens = normalized?.promptTokens || 0;
  const completionTokens = normalized?.completionTokens || 0;
  const quotaWarning = await getOpenCodeGoQuotaWarning(provider, req.apiUser.quotaWarningEnabled === true);
  const signature = await buildSignature({
    enabled: req.apiUser.signatureEnabled,
    template: req.apiUser.signatureTemplate,
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
      groupId: req.apiUser.groupId,
      cost: (promptTokens / 1000) * (req.apiUser._inputPrice || 0)
        + (completionTokens / 1000) * (req.apiUser._outputPrice || 0)
    },
    userId: req.apiUser.userId,
    preloaded: preloaded || {}
  });
  return [signature, quotaWarning].filter(Boolean).join('\n\n');
}

module.exports = {
  buildSignature,
  getQuotaInfo,
  getGroupName,
  getTeamName,
  getTodayStats,
  formatTokens,
  formatCost,
  DEFAULT_TEMPLATE,
  // 双通道注入
  SIGNATURE_HEADER,
  SIGNATURE_HEADER_B64,
  resolveSignatureMode,
  setSignatureHeaders,
  shouldAppendSignatureToContent,
  planStreamSignatureInjection,
  appendSignatureText,
  injectSignatureIntoOpenAIResponse,
  injectSignatureIntoAnthropicResponse,
  injectSignatureIntoResponsesBody,
  buildSignatureForRequest
};
