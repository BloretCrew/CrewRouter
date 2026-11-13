'use strict';

const { pool } = require('../../models/database');
const { compilePolicy, matchPolicy } = require('./matcher');

function buildContextFromSample(sample = {}) {
  return {
    identity: {
      harness: sample.client || sample.request_source || 'unknown',
      protocol: sample.protocol || 'openai',
      method: sample.method || 'POST',
      path: sample.path || '/v1/messages',
      stream: sample.stream === true,
      userAgent: sample.user_agent || '',
    },
    request: {
      model: sample.model || null,
      modelCandidates: sample.models || [sample.model].filter(Boolean),
      maxTokens: sample.max_tokens ?? null,
      messageCount: sample.message_count ?? 1,
      bodyBytes: sample.body_bytes ?? 0,
      tools: sample.tools || [],
      mcpServers: sample.mcp_servers || [],
      imageCount: sample.image_count ?? 0,
      hasAttachments: sample.has_attachments === true,
      providerId: sample.provider || null,
      providerCandidates: sample.providers || [],
    },
    semantics: { type: sample.semantics || 'primary' },
    session: sample.session || {},
    actor: {
      userId: sample.user_id || 1,
      teamId: sample.team_id || 1,
      keyId: sample.api_key_id || 1,
      keyName: sample.api_key_name || '',
      keyCreatedAt: sample.api_key_created_at || null,
      keyShared: sample.api_key_shared === true,
      isAdmin: sample.admin === true,
      tags: sample.tags || [],
      oauthClientId: sample.oauth_client || null,
    },
    network: { ip: sample.ip || '127.0.0.1', origin: sample.origin || null },
    now: sample.at ? new Date(sample.at) : new Date(),
    getPromptCorpus: () => String(sample.prompt || sample.corpus || ''),
  };
}

function contextFromUsageRow(row) {
  const meta = row.plugin_meta || {};
  const identity = meta.session_identity || {};
  return buildContextFromSample({
    user_id: row.user_id,
    team_id: row.team_id,
    api_key_id: row.api_key_id,
    client: row.request_source,
    protocol: row.request_type === 'gemini' ? 'gemini'
      : row.request_type === 'responses' ? 'responses'
        : row.request_type === 'anthropic' ? 'anthropic' : 'openai',
    model: row.requested_model || row.model_id,
    ip: row.ip_address,
    at: row.created_at,
    semantics: meta.request_semantics?.type || 'primary',
    session: {
      sessionId: identity.sessionId || null,
      parentSessionId: identity.parentSessionId || null,
      subagentId: identity.subagentId || null,
      cwd: identity.cwd || null,
      project: identity.project || null,
      compaction: Boolean(meta.attribution?.isCompaction),
    },
    user_agent: row.user_agent,
    max_tokens: row.request_params?.max_tokens,
  });
}

async function loadUsageSamples(limit = 200, { teamId = null } = {}) {
  const params = [];
  let where = `u.created_at >= NOW() - INTERVAL '30 days'`;
  if (teamId) {
    params.push(teamId);
    where += ` AND uu.team_id = $${params.length}`;
  }
  params.push(Math.min(1000, Math.max(1, limit)));
  const result = await pool.query(
    `SELECT u.id, u.user_id, uu.team_id, u.api_key_id, u.request_source, u.request_type,
            u.requested_model, u.model_id, u.ip_address, u.user_agent, u.plugin_meta,
            u.request_params, u.created_at
       FROM usage_records u
       LEFT JOIN users uu ON uu.id = u.user_id
      WHERE ${where}
      ORDER BY u.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function simulatePolicy(policy, samples, deps = {}) {
  const compiled = compilePolicy(policy);
  const total = samples.length;
  let matched = 0;
  const examples = [];
  for (const sample of samples) {
    const ctx = sample.__usageRow ? contextFromUsageRow(sample.__usageRow) : buildContextFromSample(sample);
    const result = await matchPolicy(compiled, ctx, {
      queryUsage: deps.queryUsage || (async () => 0),
    });
    if (result.match) {
      matched += 1;
      if (examples.length < 10) {
        examples.push({
          user_id: ctx.actor.userId,
          team_id: ctx.actor.teamId,
          client: ctx.identity.harness,
          model: ctx.request.model,
          ip: ctx.network.ip,
          at: ctx.now instanceof Date ? ctx.now.toISOString() : ctx.now,
          reasons: result.reasons,
        });
      }
    }
  }
  return {
    total,
    matched,
    match_rate: total ? Number((matched / total).toFixed(4)) : 0,
    examples,
  };
}

async function simulatePolicyById(policyId, { limit = 200, samples = null, teamId = null } = {}) {
  const result = await pool.query('SELECT * FROM access_policies WHERE id = $1', [policyId]);
  if (!result.rows.length) throw Object.assign(new Error('策略不存在'), { status: 404 });
  const policy = result.rows[0];
  const list = Array.isArray(samples) && samples.length
    ? samples
    : (await loadUsageSamples(limit, { teamId })).map(row => ({ __usageRow: row }));
  return { policy: { id: policy.id, name: policy.name }, ...(await simulatePolicy(policy, list)) };
}

module.exports = {
  buildContextFromSample,
  contextFromUsageRow,
  loadUsageSamples,
  simulatePolicy,
  simulatePolicyById,
};
