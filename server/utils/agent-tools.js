'use strict';

const TOOL_SPECS = Object.freeze([
  {
    name: 'list_models',
    write: false,
    description: '列出实例中的模型，包含 id、名称、供应商、是否启用和 output_kind。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_providers',
    write: false,
    description: '列出供应商的 id、名称、是否启用和协议。不会返回密钥、代理或地址。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'usage_summary',
    write: false,
    description: '汇总近 7 天的请求数、token 和积分。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_recent_errors',
    write: false,
    description: '查看最近 20 条错误，消息已截断。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_users',
    write: false,
    description: 'Team 版列出用户 id、用户名、是否管理员和积分。Personal 版没有用户管理。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_model_enabled',
    write: true,
    description: '启用或停用一个模型。必须等管理员允许后才执行。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '模型 id' },
        enabled: { type: 'boolean' }
      },
      required: ['id', 'enabled'],
      additionalProperties: false
    }
  },
  {
    name: 'set_model_output_kind',
    write: true,
    description: '把模型标为 chat 或 image。image 会出现在 Imagine，并从 Chat 列表消失。必须等管理员允许后才执行。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '模型 id' },
        output_kind: { type: 'string', enum: ['chat', 'image'] }
      },
      required: ['id', 'output_kind'],
      additionalProperties: false
    }
  },
  {
    name: 'set_provider_enabled',
    write: true,
    description: '启用或停用一个供应商。必须等管理员允许后才执行。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '供应商 id' },
        enabled: { type: 'boolean' }
      },
      required: ['id', 'enabled'],
      additionalProperties: false
    }
  }
]);

const TOOL_NAMES = Object.freeze(TOOL_SPECS.map(spec => spec.name));
const WRITE_TOOLS = new Set(TOOL_SPECS.filter(spec => spec.write).map(spec => spec.name));
const PERSONAL_USER_MESSAGE = '当前版本没有用户管理';

function isKnownTool(name) {
  return TOOL_NAMES.includes(name);
}

function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/api[_-]?key|authorization|password|secret|proxy|token|base_url/i.test(key)) continue;
      out[key] = redactSecrets(item);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.replace(/\b(?:sk|key|tok)-[A-Za-z0-9_\-]{8,}\b/g, '[redacted]');
  }
  return value;
}

function openAiTools() {
  return TOOL_SPECS.map(spec => ({
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters
    }
  }));
}

function anthropicTools() {
  return TOOL_SPECS.map(spec => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters
  }));
}

function systemPrompt() {
  const lines = TOOL_SPECS.map(spec => `- ${spec.name}：${spec.write ? '需管理员允许' : '立即执行'}。${spec.description}`);
  return [
    '你是 CrewRouter 的管理助手，只通过给定工具管理本实例。',
    '只读工具会立即执行。写入工具在管理员点允许之前没有生效，不要声称已经改完。',
    '不要索取、猜测或复述 API Key、密码、代理和上游地址。',
    '可用工具：',
    ...lines
  ].join('\n');
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) { /* 参数不是 JSON */ }
  }
  return {};
}

async function executeTool(db, call, ctx = {}) {
  const name = call?.name;
  const args = asObject(call?.arguments);
  if (!isKnownTool(name)) return { error: '未知工具' };
  if (name === 'list_models') {
    const result = await db.query(
      `SELECT id, name, provider, enabled, COALESCE(output_kind, 'chat') AS output_kind
       FROM models ORDER BY name`
    );
    return { models: redactSecrets(result.rows) };
  }
  if (name === 'list_providers') {
    const result = await db.query(
      `SELECT id, name, enabled, format FROM providers ORDER BY name`
    );
    return {
      providers: result.rows.map(row => redactSecrets({
        id: row.id,
        name: row.name,
        enabled: row.enabled === true,
        format: row.format || 'openai'
      }))
    };
  }
  if (name === 'usage_summary') {
    const result = await db.query(
      `SELECT COUNT(*)::int AS requests,
              COALESCE(SUM(tokens_used), 0)::bigint AS tokens,
              COALESCE(SUM(cost), 0) AS points
       FROM usage_records
       WHERE created_at >= NOW() - INTERVAL '7 days'`
    );
    const row = result.rows[0] || {};
    return {
      days: 7,
      requests: Number(row.requests || 0),
      tokens: Number(row.tokens || 0),
      points: Number(row.points || 0)
    };
  }
  if (name === 'list_recent_errors') {
    try {
      const result = await db.query(
        `SELECT id, model_id, status_code, error_type, LEFT(COALESCE(error_message, ''), 180) AS error_message, created_at
         FROM api_error_records
         ORDER BY created_at DESC
         LIMIT 20`
      );
      return { errors: redactSecrets(result.rows) };
    } catch (err) {
      return { errors: [], message: '错误记录暂不可用' };
    }
  }
  if (name === 'list_users') {
    if (ctx.edition !== 'team') return { message: PERSONAL_USER_MESSAGE };
    const result = await db.query(
      `SELECT id, username, is_admin, balance FROM users ORDER BY id LIMIT 100`
    );
    return {
      users: result.rows.map(row => ({
        id: row.id,
        username: row.username,
        is_admin: row.is_admin === true,
        points: Number(row.balance || 0)
      }))
    };
  }
  if (name === 'set_model_enabled') {
    const id = String(args.id || '').slice(0, 100);
    if (!id || typeof args.enabled !== 'boolean') return { error: '缺少模型 id 或 enabled' };
    const result = await db.query(
      `UPDATE models SET enabled = $2 WHERE id = $1 RETURNING id, enabled`,
      [id, args.enabled]
    );
    if (!result.rows[0]) return { error: '模型不存在' };
    return { id: result.rows[0].id, enabled: result.rows[0].enabled === true };
  }
  if (name === 'set_model_output_kind') {
    const id = String(args.id || '').slice(0, 100);
    const outputKind = args.output_kind === 'image' ? 'image' : (args.output_kind === 'chat' ? 'chat' : '');
    if (!id || !outputKind) return { error: 'output_kind 只能是 chat 或 image' };
    const result = await db.query(
      `UPDATE models SET output_kind = $2 WHERE id = $1 RETURNING id, output_kind`,
      [id, outputKind]
    );
    if (!result.rows[0]) return { error: '模型不存在' };
    return { id: result.rows[0].id, output_kind: result.rows[0].output_kind };
  }
  if (name === 'set_provider_enabled') {
    const id = String(args.id || '').slice(0, 100);
    if (!id || typeof args.enabled !== 'boolean') return { error: '缺少供应商 id 或 enabled' };
    const result = await db.query(
      `UPDATE providers SET enabled = $2 WHERE id = $1 RETURNING id, enabled`,
      [id, args.enabled]
    );
    if (!result.rows[0]) return { error: '供应商不存在' };
    return { id: result.rows[0].id, enabled: result.rows[0].enabled === true };
  }
  return { error: '未知工具' };
}

/**
 * 未批准的写入只返回待审批，不访问数据库。
 */
async function runToolCall(db, call, ctx = {}) {
  if (!isKnownTool(call?.name)) return { error: '未知工具' };
  if (isWriteTool(call.name) && ctx.approved !== true) {
    return { status: 'pending', name: call.name, arguments: asObject(call.arguments) };
  }
  return executeTool(db, call, ctx);
}

async function resolveToolDecision(db, call, decision, ctx = {}) {
  if (decision === 'deny') return { denied: true };
  if (decision !== 'allow') return { error: '无效决定' };
  return executeTool(db, call, ctx);
}

module.exports = {
  TOOL_SPECS,
  TOOL_NAMES,
  WRITE_TOOLS,
  PERSONAL_USER_MESSAGE,
  isKnownTool,
  isWriteTool,
  redactSecrets,
  openAiTools,
  anthropicTools,
  systemPrompt,
  asObject,
  executeTool,
  runToolCall,
  resolveToolDecision
};
