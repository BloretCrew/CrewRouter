'use strict';

const { clientMetaFromReq, extractPromptCorpus } = require('../request-source');
const { classifyRequestSemantics } = require('../request-semantics');
const { extractAttribution } = require('../attribution');
const { extractRequestIdentity } = require('../session-identity');
const { countImageBlocks } = require('../billing');
const { clientIp } = require('../error-records');

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(' ') : String(value || '');
}

function detectProtocol(req) {
  const base = String(req.baseUrl || req.originalUrl || '');
  const path = String(req.path || req.url || '').split('?')[0];
  if (base.includes('/v1beta') || path.startsWith('/interactions')) return 'interactions';
  if (path.startsWith('/models/')) return 'gemini';
  if (path === '/models' || path.endsWith('/models')) return 'models';
  if (path.includes('/messages')) return 'anthropic';
  if (path.includes('/responses')) return 'responses';
  if (path.includes('/chat/completions')) return 'openai';
  return 'openai';
}

function parseClientVersion(userAgent, harness) {
  const ua = String(userAgent || '');
  const byHarness = {
    claude_code: /claude-(?:cli|code)\/([\d.]+)/i,
    codex: /codex_cli_rs\/([\d.]+)/i,
    opencode: /opencode\/([\d.]+)/i,
    qwen_code: /QwenCode\/([\d.]+)/i,
    hermes: /hermes-cli\/([\d.]+)/i,
    openclaw: /openclaw\/([\d.]+)/i,
    grok: /grok-(?:shell|tui|web|pager|build)\/([\d.]+)/i,
  };
  const re = byHarness[harness];
  if (re) {
    const match = ua.match(re);
    if (match) return match[1];
  }
  const generic = ua.match(/([A-Za-z0-9_.-]+)\/([\d]+(?:\.[\d]+)*)/);
  return generic ? generic[2] : null;
}

function extractTools(body) {
  const names = new Set();
  const list = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of list) {
    if (!tool || typeof tool !== 'object') {
      if (typeof tool === 'string') names.add(tool);
      continue;
    }
    if (typeof tool.name === 'string') names.add(tool.name);
    if (typeof tool.function?.name === 'string') names.add(tool.function.name);
    if (Array.isArray(tool.functionDeclarations)) {
      for (const declaration of tool.functionDeclarations) {
        if (declaration?.name) names.add(declaration.name);
      }
    }
  }
  return [...names];
}

function mcpServersFromTools(tools) {
  const servers = new Set();
  for (const name of tools) {
    const parts = String(name).split('__');
    if (parts.length >= 3 && parts[0] === 'mcp' && parts[1]) servers.add(parts[1]);
  }
  return [...servers];
}

function hasAttachments(body) {
  let found = false;
  const seen = new Set();
  function visit(value, depth) {
    if (found || depth > 12 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const type = String(value.type || '');
    if (['input_file', 'file', 'document', 'image', 'image_url', 'input_image', 'media'].includes(type)) {
      found = true;
      return;
    }
    if (value.inlineData || value.fileData) {
      found = true;
      return;
    }
    for (const item of Object.values(value)) visit(item, depth + 1);
  }
  visit(body, 0);
  return found;
}

function messageCount(body) {
  if (Array.isArray(body?.messages)) return body.messages.length;
  if (Array.isArray(body?.input)) return body.input.length;
  if (typeof body?.input === 'string') return 1;
  if (Array.isArray(body?.contents)) return body.contents.length;
  return 0;
}

function bodyBytes(req, body) {
  const length = Number(req.headers?.['content-length']);
  if (Number.isFinite(length) && length >= 0) return length;
  try {
    return Buffer.byteLength(JSON.stringify(body || {}), 'utf8');
  } catch (_) {
    return 0;
  }
}

/**
 * 构建请求期策略信号。结果缓存在 req._policySignals。
 */
function buildPolicySignals(req) {
  if (req._policySignals) return req._policySignals;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const meta = req._clientMetaSnapshot || clientMetaFromReq(req);
  const harness = meta.requestSource || 'unknown';
  const userAgent = meta.userAgent || headerValue(req.headers, 'user-agent') || '';
  const attribution = extractAttribution(req);
  const identity = extractRequestIdentity(req, { attribution, requestSource: harness });
  const semantics = classifyRequestSemantics({
    body,
    headers: req.headers,
    requestSource: harness,
    url: req.originalUrl || req.url || '',
  });
  const tools = extractTools(body);
  const mcpServers = mcpServersFromTools(tools);
  const apiUser = req.apiUser || {};
  const modelCandidates = new Set();
  if (body.model) modelCandidates.add(String(body.model));
  for (const id of apiUser.modelQueue || []) if (id) modelCandidates.add(String(id));
  for (const id of Object.values(apiUser.harnessModels || {})) if (id) modelCandidates.add(String(id));
  if (apiUser.currentModelId) modelCandidates.add(String(apiUser.currentModelId));
  if (apiUser.customModelName) modelCandidates.add(String(apiUser.customModelName));

  const signals = {
    body,
    now: new Date(),
    identity: {
      harness,
      userAgent,
      clientVersion: parseClientVersion(userAgent, harness),
      protocol: detectProtocol(req),
      path: req.path || req.url || '',
      method: req.method || '',
      stream: body.stream === true || String(req.path || '').includes(':streamGenerateContent'),
    },
    request: {
      model: body.model || null,
      modelCandidates: [...modelCandidates],
      maxTokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens
        ?? body.generationConfig?.maxOutputTokens ?? null,
      messageCount: messageCount(body),
      bodyBytes: bodyBytes(req, body),
      hasTools: tools.length > 0,
      tools,
      mcpServers,
      imageCount: countImageBlocks(body),
      hasAttachments: hasAttachments(body),
    },
    semantics: {
      type: semantics.type,
      confidence: semantics.confidence,
      reasonCodes: semantics.reason_codes || [],
    },
    session: {
      sessionId: identity.sessionId || null,
      parentSessionId: identity.parentSessionId || null,
      subagentId: identity.subagentId || null,
      cwd: identity.cwd || null,
      project: identity.project || null,
      logicalSessionKey: identity.logicalSessionKey || null,
      compaction: Boolean(attribution.isCompaction) || semantics.type === 'compaction',
    },
    actor: {
      userId: apiUser.userId ?? null,
      username: apiUser.username || null,
      teamId: apiUser.teamId ?? null,
      keyId: apiUser.keyId ?? null,
      keyName: apiUser.keyName || '',
      keyCreatedAt: apiUser.keyCreatedAt || null,
      keyShared: Boolean(apiUser.keyShared),
      isAdmin: apiUser.isAdmin === true,
      tags: Array.isArray(apiUser.tags) ? apiUser.tags : [],
      timezone: apiUser.timezone || null,
      oauthClientId: apiUser.oauthClientId || null,
      oauthScope: apiUser.oauthScope || null,
      permissions: Array.isArray(apiUser.permissions) ? apiUser.permissions : [],
      balance: apiUser.balance ?? null,
      modelQueue: apiUser.modelQueue || [],
      harnessModels: apiUser.harnessModels || {},
      currentModelId: apiUser.currentModelId || null,
      customModelName: apiUser.customModelName || null,
      policyBypass: apiUser.policyBypass === true,
      policyBypassUntil: apiUser.policyBypassUntil || null,
    },
    network: {
      ip: clientIp(req) || req.ip || null,
      forwardedFor: headerValue(req.headers, 'x-forwarded-for') || null,
      origin: req.headers?.origin || null,
      referer: req.headers?.referer || null,
    },
    history: {},
    _promptCorpus: null,
  };
  signals.getPromptCorpus = () => {
    if (signals._promptCorpus == null) {
      signals._promptCorpus = extractPromptCorpus(body, { client: harness });
    }
    return signals._promptCorpus;
  };
  req._policySignals = signals;
  return signals;
}

module.exports = { buildPolicySignals, extractTools, mcpServersFromTools, detectProtocol };
