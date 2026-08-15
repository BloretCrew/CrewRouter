'use strict';

const { pool } = require('../models/database');
const Logger = require('../logger');
const { logAction, ACTIONS } = require('./audit-log');
const { HARNESS_SOURCES, isHarnessSource, sourceLabel, clientMetaFromReq } = require('./request-source');
const { startSession, endSession, getActiveSession, recordEvent } = require('./trace-session');

const TRIGGER_RE = /@(?:crewrouter|cr)\b/i;
const USER_QUERY_RE = /<user_query\b[^>]*>([\s\S]*?)<\/user_query>/i;
const MAX_QUEUE = 10;

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return [value.text, value.content, value.input_text, value.output_text]
      .map(textOf).filter(Boolean).join('\n');
  }
  return String(value);
}

function lastItem(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[list.length - 1];
}

function extractLastInputText(body = {}) {
  let item = null;
  if (Array.isArray(body.messages) && body.messages.length) {
    item = lastItem(body.messages);
  } else if (Array.isArray(body.input) && body.input.length) {
    item = lastItem(body.input);
  } else if (typeof body.input === 'string') {
    item = body.input;
  }
  if (item == null) return '';
  const raw = textOf(item?.content ?? item?.input ?? item);
  const query = raw.match(USER_QUERY_RE);
  return (query ? query[1] : raw).trim();
}

function stripTrigger(text) {
  const match = text.match(TRIGGER_RE);
  if (!match) return null;
  return text.slice(match.index + match[0].length).replace(/^[\s:：,，]+/, '').trim();
}

function normalizeSwitch(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(开启|打开|启用|on|enable|true)/.test(t)) return true;
  if (/^(关闭|禁用|停用|off|disable|false)/.test(t)) return false;
  return null;
}

function parseOnOffAround(rest, keywords) {
  const t = String(rest || '').trim();
  const kw = keywords.join('|');
  const m = t.match(new RegExp(`^(开启|打开|启用|关闭|禁用|on|off|enable|disable)\\s*(?:${kw})\\s*$`, 'i'))
    || t.match(new RegExp(`^(?:${kw})\\s*(开启|打开|启用|关闭|禁用|on|off|enable|disable)\\s*$`, 'i'));
  if (!m) return undefined;
  return normalizeSwitch(m[1]);
}

const COMMANDS = [];

function register(cmd) {
  COMMANDS.push(cmd);
}

function matchCommand(rest) {
  const text = String(rest || '').trim();
  if (!text) return { cmd: COMMANDS.find(c => c.id === 'help'), args: { topic: '' } };
  const ranked = [...COMMANDS].sort((a, b) => {
    const al = Math.max(...a.aliases.map(x => x.length));
    const bl = Math.max(...b.aliases.map(x => x.length));
    return bl - al;
  });
  const lower = text.toLowerCase();
  for (const cmd of ranked) {
    for (const alias of cmd.aliases) {
      const a = alias.toLowerCase();
      if (lower === a || lower.startsWith(`${a} `) || lower.startsWith(`${a}：`) || lower.startsWith(`${a}:`)) {
        const argText = text.slice(alias.length).replace(/^[\s:：]+/, '').trim();
        return { cmd, args: cmd.parse ? cmd.parse(argText, text) : { rest: argText } };
      }
    }
  }
  return { cmd: null, args: { rest: text } };
}

function helpText(topic = '') {
  const t = String(topic || '').trim().toLowerCase();
  const groups = {
    总览: [
      ['帮助', 'help'],
      ['状态', 'status'],
      ['余额', 'balance'],
    ],
    模型: [
      ['当前模型', 'current model'],
      ['模型列表', 'models'],
      ['切换模型 <名称>', 'switch model <name>'],
      ['队列 模型A,模型B', 'queue A,B'],
      ['Grok 用 <模型>', 'grok use <model>'],
      ['DeepSeek 用 <模型>', 'deepseek use <model>'],
      ['取消 Grok 绑定', 'unbind grok'],
      ['取消 DeepSeek 绑定', 'unbind deepseek'],
    ],
    开关: [
      ['开启/关闭吞图', 'enable/disable swallow'],
      ['开启/关闭签名', 'enable/disable signature'],
      ['开启/关闭 Fusion', 'enable/disable fusion'],
      ['开启/关闭定时', 'enable/disable schedule'],
      ['确认停用密钥', 'confirm disable key'],
    ],
    统计: [
      ['统计', 'stats'],
      ['统计 7天', 'stats 7d'],
      ['统计 全部', 'stats all'],
      ['项目统计', 'projects'],
      ['最近调用', 'recent'],
    ],
    跟踪: [
      ['开始记录', 'start trace'],
      ['结束记录', 'end trace'],
    ],
    查询: [
      ['密钥列表', 'keys'],
      ['Fusion 配置', 'fusion config'],
      ['签名配置', 'signature config'],
    ],
  };
  const line = ([zh, en]) => `  @CR ${zh}\n     ${en}`;
  const block = (name, lines) => `${name}\n${lines.map(line).join('\n')}`;
  const topicKey = { 总览: '总览', overview: '总览', 模型: '模型', model: '模型', models: '模型',
    开关: '开关', switch: '开关', 统计: '统计', stats: '统计', 跟踪: '跟踪', trace: '跟踪', 查询: '查询', query: '查询' }[t];
  if (topicKey && groups[topicKey]) return block(topicKey, groups[topicKey]);
  return Object.entries(groups).map(([name, lines]) => block(name, lines)).join('\n\n')
    + '\n\n激活词：@CrewRouter 或 @CR（不区分大小写）\n指定分类：@CR help models';
}

function flag(value) {
  return value ? '开' : '关';
}

function linesOf(pairs) {
  const width = Math.max(0, ...pairs.map(([k]) => String(k).length));
  return pairs.map(([k, v]) => `${String(k).padEnd(width, ' ')}  ${v == null || v === '' ? '-' : v}`).join('\n');
}

async function loadKeySnapshot(apiUser) {
  const keyId = apiUser.keyId;
  const key = await pool.query(
    `SELECT ak.id, ak.name, ak.key_prefix, ak.enabled, ak.swallow_images, ak.signature_enabled,
            ak.fusion_enabled, ak.schedule_enabled, ak.crewrouter_commands, ak.current_model_id, ak.fusion_panel_models,
            ak.fusion_judge_model_id, ak.fusion_outer_model_id,
            m.name AS model_name, p.name AS provider_name,
            u.balance
     FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     LEFT JOIN models m ON m.id = ak.current_model_id
     LEFT JOIN providers p ON p.id = m.provider
     WHERE ak.id = $1`,
    [keyId]
  );
  const row = key.rows[0] || {};
  const queue = await pool.query(
    `SELECT akm.model_id, m.name FROM api_key_models akm
     LEFT JOIN models m ON m.id = akm.model_id
     WHERE akm.api_key_id = $1 ORDER BY akm.sort_order, akm.id`,
    [keyId]
  );
  const harness = await pool.query(
    `SELECT harness, model_id, m.name FROM api_key_harness_models h
     LEFT JOIN models m ON m.id = h.model_id WHERE h.api_key_id = $1 ORDER BY harness`,
    [keyId]
  );
  return { row, queue: queue.rows, harness: harness.rows };
}

function formatFooter(snap) {
  const r = snap.row || {};
  const harness = (snap.harness || [])
    .map(h => `${sourceLabel(h.harness)} → ${h.name || h.model_id}`)
    .join('\n              ') || '无';
  return [
    '当前 Key',
    linesOf([
      ['名称', `${r.name || '-'}  (#${r.id || '-'})`],
      ['模型', r.model_name || r.current_model_id || '未绑定'],
      ['开关', `指令 ${flag(r.crewrouter_commands)} · 吞图 ${flag(r.swallow_images)} · 签名 ${flag(r.signature_enabled)} · Fusion ${flag(r.fusion_enabled !== false)} · 密钥 ${flag(r.enabled !== false)} · 定时 ${flag(r.schedule_enabled)}`],
      ['客户端', harness],
      ['余额', Number(r.balance || 0).toFixed(4)],
    ]),
  ].join('\n');
}

async function composeReply(headline, body, apiUser, options = {}) {
  const parts = [headline];
  if (body) parts.push(String(body).trim());
  if (options.footer !== false) {
    const snap = await loadKeySnapshot(apiUser);
    parts.push(formatFooter(snap));
  }
  return parts.join('\n\n');
}

async function ownerUserId(apiUser) {
  const r = await pool.query('SELECT user_id FROM api_keys WHERE id = $1', [apiUser.keyId]);
  return r.rows[0]?.user_id || apiUser.userId;
}

async function assertOwnerCanUseModel(modelId, ownerId) {
  const modelCheck = await pool.query(
    `SELECT m.id, m.name, p.enabled AS provider_enabled, p.name AS provider_name,
            EXISTS (
              SELECT 1 FROM team_models tm
              JOIN user_teams ut ON ut.team_id = tm.team_id
              WHERE tm.model_id = m.id AND tm.enabled = TRUE AND ut.user_id = $2
            ) AS owner_can_use
     FROM models m JOIN providers p ON m.provider = p.id
     WHERE m.id = $1`,
    [modelId, ownerId]
  );
  if (!modelCheck.rows[0]) return { error: `模型不存在: ${modelId}` };
  if (modelCheck.rows[0].provider_enabled === false) return { error: `供应商已禁用: ${modelId}` };
  if (!modelCheck.rows[0].owner_can_use) return { error: `无权使用模型: ${modelId}` };
  return { row: modelCheck.rows[0] };
}

async function searchModels(query, ownerId) {
  const q = String(query || '').trim();
  if (!q) return [];
  const result = await pool.query(
    `SELECT m.id, m.name, m.alias, m.upstream_model_id, p.name AS provider_name
     FROM models m
     JOIN providers p ON p.id = m.provider
     WHERE m.enabled = TRUE AND p.enabled = TRUE
       AND EXISTS (
         SELECT 1 FROM team_models tm
         JOIN user_teams ut ON ut.team_id = tm.team_id
         WHERE tm.model_id = m.id AND tm.enabled = TRUE AND ut.user_id = $2
       )
       AND (
         m.id = $1 OR LOWER(COALESCE(m.alias,'')) = LOWER($1) OR LOWER(m.name) = LOWER($1)
         OR LOWER(COALESCE(m.upstream_model_id,'')) = LOWER($1)
         OR m.id ILIKE $3 OR m.name ILIKE $3 OR COALESCE(m.alias,'') ILIKE $3
         OR COALESCE(m.upstream_model_id,'') ILIKE $3
       )
     ORDER BY
       CASE WHEN m.id = $1 THEN 0
            WHEN LOWER(COALESCE(m.alias,'')) = LOWER($1) THEN 1
            WHEN LOWER(m.name) = LOWER($1) THEN 2
            ELSE 3 END,
       m.name
     LIMIT 8`,
    [q, ownerId, `%${q}%`]
  );
  return result.rows;
}

async function setModelQueue(apiUser, orderedIds) {
  const ownerId = await ownerUserId(apiUser);
  if (orderedIds.length > MAX_QUEUE) return { error: `模型队列最多 ${MAX_QUEUE} 个` };
  for (const mid of orderedIds) {
    const check = await assertOwnerCanUseModel(mid, ownerId);
    if (check.error) return check;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM api_key_models WHERE api_key_id = $1', [apiUser.keyId]);
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'INSERT INTO api_key_models (api_key_id, model_id, sort_order) VALUES ($1, $2, $3)',
        [apiUser.keyId, orderedIds[i], i]
      );
    }
    await client.query('UPDATE api_keys SET current_model_id = $1 WHERE id = $2', [orderedIds[0] || null, apiUser.keyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { invalidateApiKeyCacheByKeyId } = require('../routes/api');
  invalidateApiKeyCacheByKeyId(apiUser.keyId);
  return { ok: true, ids: orderedIds };
}

function parseModelTokens(text) {
  return String(text || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
}

const HARNESS_ALIAS = {
  grok: 'grok', grokbuild: 'grok', 'grok build': 'grok',
  codex: 'codex',
  claude: 'claude_code', claudecode: 'claude_code', 'claude code': 'claude_code',
  opencode: 'opencode',
  qwen: 'qwen_code', qwencode: 'qwen_code', 'qwen code': 'qwen_code',
  hermes: 'hermes',
  openclaw: 'openclaw',
  deepseek: 'deepseek_harness',
  'deepseek harness': 'deepseek_harness',
  dsh: 'deepseek_harness',
};

function parseHarnessName(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return HARNESS_ALIAS[t] || (isHarnessSource(t) ? t : null);
}

register({
  id: 'start_trace',
  aliases: ['开始记录', '开始跟踪', 'start recording', 'start trace'],
  async run({ req, apiUser }) {
    const meta = clientMetaFromReq(req);
    const session = await startSession({ userId: apiUser.userId, keyId: apiUser.keyId, source: meta.requestSource, userAgent: meta.userAgent });
    return composeReply(`开始跟踪记录，ID: ${session.public_id}`, '跟踪记录仅对当前 Key 生效。结束记录后，请打开控制台模型库查看报告。', apiUser);
  },
});

register({
  id: 'end_trace',
  aliases: ['结束记录', '停止记录', '结束跟踪', 'stop recording', 'end trace'],
  async run({ req, apiUser }) {
    const session = await endSession(apiUser.keyId);
    if (!session) return composeReply('当前没有进行中的跟踪记录', '请先发送：@CrewRouter 开始记录', apiUser);
    const summary = session.summary || {};
    return composeReply(`跟踪记录完成，ID: ${session.public_id}`, `共记录 ${summary.requests || 0} 项请求，消耗 ${summary.tokens || 0} tokens。请打开控制台查看报告。`, apiUser);
  },
});

register({
  id: 'help',
  aliases: ['帮助', 'help', '指令'],
  parse: (rest) => ({ topic: rest }),
  async run({ apiUser, args }) {
    return composeReply('可用指令', helpText(args.topic), apiUser, { footer: false });
  },
});

register({
  id: 'status',
  aliases: ['状态', 'status', '概况'],
  async run({ apiUser }) {
    const snap = await loadKeySnapshot(apiUser);
    const queue = snap.queue.map((m, i) => `${i + 1}. ${m.name || m.model_id}`).join('\n') || '（空）';
    return composeReply('当前状态', `模型队列\n${queue}`, apiUser);
  },
});

register({
  id: 'balance',
  aliases: ['余额', '积分', 'balance'],
  async run({ apiUser }) {
    const r = await pool.query(
      `SELECT u.balance,
              COALESCE((SELECT SUM(amount / (1 + fee_rate)) FROM user_code_balances WHERE user_id = u.id AND amount > 0), 0) AS refundable
       FROM users u WHERE u.id = $1`,
      [apiUser.userId]
    );
    const row = r.rows[0] || {};
    return composeReply('余额', linesOf([
      ['可用积分', Number(row.balance || 0).toFixed(4)],
      ['可退款约', Number(row.refundable || 0).toFixed(4)],
    ]), apiUser);
  },
});

register({
  id: 'current_model',
  aliases: ['当前模型', 'current model'],
  async run({ apiUser }) {
    const snap = await loadKeySnapshot(apiUser);
    const r = snap.row;
    return composeReply('当前模型', linesOf([
      ['名称', r.model_name || r.current_model_id || '未绑定'],
      ['ID', r.current_model_id || '-'],
      ['供应商', r.provider_name || '-'],
    ]), apiUser);
  },
});

register({
  id: 'model_list',
  aliases: ['模型列表', '队列列表', 'models'],
  async run({ apiUser }) {
    const snap = await loadKeySnapshot(apiUser);
    const lines = snap.queue.slice(0, 20).map((m, i) => `${i + 1}. ${m.name || m.model_id}  (${m.model_id})`);
    const extra = snap.queue.length > 20 ? `\n…共 ${snap.queue.length} 个` : '';
    return composeReply('模型队列', (lines.join('\n') || '（空）') + extra, apiUser);
  },
});

register({
  id: 'switch_model',
  aliases: ['切换模型', '绑定模型', '用模型', '使用模型', '换模型', 'switch model', 'use model'],
  parse: (rest) => ({ query: rest }),
  async run({ req, apiUser, args }) {
    if (!args.query) return composeReply('缺少模型名', '用法：@CrewRouter 切换模型 <名称或ID>', apiUser);
    const ownerId = await ownerUserId(apiUser);
    const hits = await searchModels(args.query, ownerId);
    if (!hits.length) return composeReply('未找到模型', `没有匹配「${args.query}」的可用模型。`, apiUser);
    const exact = hits.filter(h =>
      h.id === args.query || (h.alias && h.alias.toLowerCase() === args.query.toLowerCase())
      || (h.name && h.name.toLowerCase() === args.query.toLowerCase())
      || (h.upstream_model_id && h.upstream_model_id.toLowerCase() === args.query.toLowerCase())
    );
    const chosen = exact.length === 1 ? exact[0] : (hits.length === 1 ? hits[0] : null);
    if (!chosen) {
      return composeReply('匹配到多个模型', hits.map(h => `· ${h.name} (${h.id}) ${h.provider_name || ''}`).join('\n'), apiUser);
    }
    const snap = await loadKeySnapshot(apiUser);
    const rest = snap.queue.map(q => q.model_id).filter(id => id !== chosen.id);
    const result = await setModelQueue(apiUser, [chosen.id, ...rest]);
    if (result.error) return composeReply('切换失败', result.error, apiUser);
    await logAction({
      userId: apiUser.userId, username: apiUser.username, action: ACTIONS.API_KEY_MODELS,
      resourceType: 'api_key', resourceId: String(apiUser.keyId),
      description: `指令切换模型 → ${chosen.id}`, details: { model_id: chosen.id },
      ip: req.ip, userAgent: req.get?.('user-agent'),
    });
    return composeReply(`已切换到 ${chosen.name}`, linesOf([
      ['ID', chosen.id],
      ['供应商', chosen.provider_name || '-'],
    ]), apiUser);
  },
});

register({
  id: 'queue',
  aliases: ['队列', '设置队列', '模型队列', 'queue'],
  parse: (rest) => ({ tokens: parseModelTokens(rest) }),
  async run({ req, apiUser, args }) {
    if (!args.tokens.length) return composeReply('缺少队列', '用法：@CrewRouter 队列 模型A,模型B', apiUser);
    const ownerId = await ownerUserId(apiUser);
    const ids = [];
    for (const token of args.tokens) {
      const hits = await searchModels(token, ownerId);
      const exact = hits.filter(h => h.id === token || (h.name && h.name.toLowerCase() === token.toLowerCase()));
      const chosen = exact[0] || (hits.length === 1 ? hits[0] : null);
      if (!chosen) return composeReply('队列未写完', `无法唯一匹配：${token}`, apiUser);
      if (!ids.includes(chosen.id)) ids.push(chosen.id);
    }
    const result = await setModelQueue(apiUser, ids);
    if (result.error) return composeReply('设置失败', result.error, apiUser);
    await logAction({
      userId: apiUser.userId, username: apiUser.username, action: ACTIONS.API_KEY_MODELS,
      resourceType: 'api_key', resourceId: String(apiUser.keyId),
      description: '指令更新模型队列', details: { model_ids: ids },
      ip: req.ip, userAgent: req.get?.('user-agent'),
    });
    return composeReply('队列已更新', ids.map((id, i) => `${i + 1}. ${id}`).join('\n'), apiUser);
  },
});

register({
  id: 'harness_bind',
  aliases: ['grok 用', 'codex 用', 'claude 用', 'claude code 用', 'opencode 用', 'qwen 用', 'qwen code 用', 'hermes 用', 'openclaw 用', 'deepseek 用', 'dsh 用',
    'grok use', 'codex use', 'claude use', 'claude code use', 'opencode use', 'qwen use', 'qwen code use', 'hermes use', 'openclaw use', 'deepseek use', 'dsh use'],
  parse: (rest, full) => {
    const m = String(full || '').match(/^(.+?)\s*(?:用|use)\s+(.+)$/i);
    return { harnessText: m?.[1], query: m?.[2] || rest };
  },
  async run({ req, apiUser, args }) {
    const harness = parseHarnessName(args.harnessText);
    if (!harness || harness === 'unknown') return composeReply('无效客户端', `无法识别：${args.harnessText}`, apiUser);
    if (!args.query) return composeReply('缺少模型', `用法：@CrewRouter ${sourceLabel(harness)} 用 <模型>`, apiUser);
    const ownerId = await ownerUserId(apiUser);
    const hits = await searchModels(args.query, ownerId);
    const chosen = hits.length === 1 ? hits[0] : hits.find(h => h.id === args.query);
    if (!chosen) return composeReply('未唯一匹配模型', hits.map(h => `· ${h.name} (${h.id})`).join('\n') || '无结果', apiUser);
    await pool.query(
      `INSERT INTO api_key_harness_models (api_key_id, harness, model_id, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (api_key_id, harness) DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = CURRENT_TIMESTAMP`,
      [apiUser.keyId, harness, chosen.id]
    );
    require('../routes/api').invalidateApiKeyCacheByKeyId(apiUser.keyId);
    await logAction({
      userId: apiUser.userId, username: apiUser.username, action: ACTIONS.API_KEY_MODELS,
      resourceType: 'api_key', resourceId: String(apiUser.keyId),
      description: `指令绑定 ${harness} → ${chosen.id}`,
      details: { harness, model_id: chosen.id }, ip: req.ip,
    });
    return composeReply(`已为 ${sourceLabel(harness)} 绑定 ${chosen.name}`, `ID：${chosen.id}`, apiUser);
  },
});

register({
  id: 'harness_clear',
  aliases: ['取消 grok 绑定', '取消 codex 绑定', '取消 claude 绑定', '取消 claude code 绑定', '取消 opencode 绑定', '取消 qwen 绑定', '取消 hermes 绑定', '取消 openclaw 绑定', '取消 deepseek 绑定', '取消 dsh 绑定',
    'unbind grok', 'unbind codex', 'unbind claude', 'unbind claude code', 'unbind opencode', 'unbind qwen', 'unbind hermes', 'unbind openclaw', 'unbind deepseek', 'unbind dsh'],
  parse: (_rest, full) => ({ full }),
  async run({ req, apiUser, args }) {
    const m = String(args.full || '').match(/取消\s*(.+?)\s*绑定/i)
      || String(args.full || '').match(/unbind\s+(.+)/i);
    const harness = parseHarnessName(m?.[1]);
    if (!harness) return composeReply('无效客户端', '用法：@CrewRouter 取消 Grok 绑定', apiUser);
    await pool.query('DELETE FROM api_key_harness_models WHERE api_key_id = $1 AND harness = $2', [apiUser.keyId, harness]);
    require('../routes/api').invalidateApiKeyCacheByKeyId(apiUser.keyId);
    await logAction({
      userId: apiUser.userId, username: apiUser.username, action: ACTIONS.API_KEY_MODELS,
      resourceType: 'api_key', resourceId: String(apiUser.keyId),
      description: `指令清除 ${harness} 绑定`, details: { harness }, ip: req.ip,
    });
    return composeReply(`已取消 ${sourceLabel(harness)} 单独绑定`, '该客户端将回退到默认模型队列。', apiUser);
  },
});

function switchCommand(id, aliases, keywords, column, action, yes, no) {
  register({
    id,
    aliases,
    parse: (rest, full) => ({ on: parseOnOffAround(full, keywords) }),
    async run({ req, apiUser, args }) {
      if (args.on == null) return composeReply('用法不对', `请使用：@CrewRouter 开启${keywords[0]} 或 关闭${keywords[0]}`, apiUser);
      await pool.query(`UPDATE api_keys SET ${column} = $1 WHERE id = $2`, [args.on, apiUser.keyId]);
      require('../routes/api').invalidateApiKeyCacheByKeyId(apiUser.keyId);
      await logAction({
        userId: apiUser.userId, username: apiUser.username, action,
        resourceType: 'api_key', resourceId: String(apiUser.keyId),
        description: `${args.on ? yes : no}（指令）`, details: { [column]: args.on }, ip: req.ip,
      });
      return composeReply(args.on ? yes : no, '', apiUser);
    },
  });
}

switchCommand('swallow', ['开启吞图', '关闭吞图', '打开吞图', '禁用吞图', '启用吞图', '吞图', 'enable swallow', 'disable swallow', 'swallow'],
  ['吞图', 'swallow'], 'swallow_images', ACTIONS.API_KEY_SWALLOW_IMAGES, '已开启吞图', '已关闭吞图');
switchCommand('signature', ['开启签名', '关闭签名', '启用签名', '禁用签名', '签名', 'enable signature', 'disable signature', 'signature'],
  ['签名', 'signature'], 'signature_enabled', ACTIONS.API_KEY_SIGNATURE, '已开启签名', '已关闭签名');
switchCommand('fusion', ['开启 fusion', '关闭 fusion', '启用 fusion', '禁用 fusion', 'fusion', 'enable fusion', 'disable fusion'],
  ['fusion'], 'fusion_enabled', ACTIONS.API_KEY_FUSION, '已开启 Fusion', '已关闭 Fusion');
switchCommand('schedule', ['开启定时', '关闭定时', '启用定时', '禁用定时', '定时', 'enable schedule', 'disable schedule', 'schedule'],
  ['定时', 'schedule'], 'schedule_enabled', ACTIONS.API_KEY_SCHEDULE, '已开启定时', '已关闭定时');

register({
  id: 'disable_key',
  aliases: ['确认停用密钥', '确认禁用密钥', 'confirm disable key'],
  async run({ req, apiUser }) {
    await pool.query('UPDATE api_keys SET enabled = FALSE WHERE id = $1', [apiUser.keyId]);
    require('../routes/api').invalidateApiKeyCacheByKeyId(apiUser.keyId);
    await logAction({
      userId: apiUser.userId, username: apiUser.username, action: ACTIONS.API_KEY_TOGGLE,
      resourceType: 'api_key', resourceId: String(apiUser.keyId),
      description: '指令确认停用密钥', details: { enabled: false }, ip: req.ip,
    });
    return composeReply('密钥已停用', '之后普通请求会被拒绝。无法再用本 Key 发指令重新开启，请到控制台启用。', apiUser);
  },
});

register({
  id: 'disable_key_hint',
  aliases: ['停用密钥', '禁用密钥'],
  async run({ apiUser }) {
    return composeReply('需要确认', '停用后本 Key 将无法再发指令。若确定，请发送：@CrewRouter 确认停用密钥', apiUser);
  },
});

register({
  id: 'enable_key',
  aliases: ['启用密钥', '开启密钥'],
  async run({ req, apiUser }) {
    await pool.query('UPDATE api_keys SET enabled = TRUE WHERE id = $1', [apiUser.keyId]);
    require('../routes/api').invalidateApiKeyCacheByKeyId(apiUser.keyId);
    await logAction({
      userId: apiUser.userId, username: apiUser.username, action: ACTIONS.API_KEY_TOGGLE,
      resourceType: 'api_key', resourceId: String(apiUser.keyId),
      description: '指令启用密钥', details: { enabled: true }, ip: req.ip,
    });
    return composeReply('密钥已启用', '', apiUser);
  },
});

register({
  id: 'stats',
  aliases: ['统计', '今日统计', '用量统计', 'stats'],
  parse: (rest, full) => {
    const all = /全部|\ball\b/i.test(full);
    const dayMatch = String(full).match(/(\d+)\s*(?:天|d\b)/i);
    const days = /今日|今天|today/i.test(full) ? 1 : (dayMatch ? Math.min(Math.max(parseInt(dayMatch[1], 10), 1), 365) : 1);
    return { days, all };
  },
  async run({ apiUser, args }) {
    const params = [apiUser.userId, args.days];
    let extra = '';
    if (!args.all) {
      extra = ' AND api_key_id = $3';
      params.push(apiUser.keyId);
    }
    const r = await pool.query(
      `SELECT COUNT(*)::int AS requests,
              COALESCE(SUM(tokens_used),0)::bigint AS tokens,
              COALESCE(SUM(cost),0)::numeric AS cost
       FROM usage_records
       WHERE user_id = $1 AND created_at >= NOW() - ($2::int * INTERVAL '1 day') ${extra}`,
      params
    );
    const row = r.rows[0] || {};
    const scope = args.all ? '全部 Key' : '当前 Key';
    return composeReply(`${scope} · 近 ${args.days} 天`, linesOf([
      ['请求', row.requests],
      ['Token', Number(row.tokens).toLocaleString()],
      ['积分', Number(row.cost).toFixed(4)],
    ]), apiUser);
  },
});

register({
  id: 'project_stats',
  aliases: ['项目', '项目统计', '工作区', 'projects', 'project'],
  async run({ apiUser }) {
    const r = await pool.query(
      `SELECT workspace_path, COUNT(*)::int AS requests, MAX(created_at) AS last_activity
       FROM usage_message_analysis
       WHERE user_id = $1 AND NULLIF(TRIM(workspace_path),'') IS NOT NULL
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY workspace_path
       ORDER BY requests DESC, last_activity DESC
       LIMIT 5`,
      [apiUser.userId]
    );
    const n = await pool.query(
      `SELECT COUNT(DISTINCT workspace_path)::int AS projects
       FROM usage_message_analysis
       WHERE user_id = $1 AND NULLIF(TRIM(workspace_path),'') IS NOT NULL
         AND created_at >= NOW() - INTERVAL '30 days'`,
      [apiUser.userId]
    );
    const lines = r.rows.map((p, i) => {
      const name = String(p.workspace_path).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      return `${i + 1}. ${name} · ${p.requests} 次`;
    });
    return composeReply(`近 30 天 ${n.rows[0]?.projects || 0} 个项目`, lines.join('\n') || '暂无项目活动', apiUser);
  },
});

register({
  id: 'recent',
  aliases: ['最近调用', '调用记录', 'recent'],
  async run({ apiUser }) {
    const r = await pool.query(
      `SELECT created_at, model_id, request_source, tokens_used, cost
       FROM usage_records WHERE user_id = $1 AND api_key_id = $2
       ORDER BY created_at DESC LIMIT 5`,
      [apiUser.userId, apiUser.keyId]
    );
    const lines = r.rows.map(row => {
      const t = new Date(row.created_at).toLocaleString('zh-CN', { hour12: false });
      return `· ${t}  ${row.model_id || '-'}  ${row.request_source || '-'}  ${row.tokens_used || 0} tok`;
    });
    return composeReply('最近 5 条调用', lines.join('\n') || '暂无记录', apiUser);
  },
});

register({
  id: 'keys',
  aliases: ['密钥列表', 'key列表', 'keys'],
  async run({ apiUser }) {
    const r = await pool.query(
      'SELECT id, name, key_prefix, enabled FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [apiUser.userId]
    );
    const lines = r.rows.map(k => `${k.id === apiUser.keyId ? '▶' : '·'} ${k.name} (${k.key_prefix}…) ${k.enabled === false ? '停用' : '启用'}`);
    return composeReply('我的密钥', lines.join('\n') || '无', apiUser);
  },
});

register({
  id: 'fusion_config',
  aliases: ['fusion 配置', 'fusion配置', 'fusion config'],
  async run({ apiUser }) {
    const snap = await loadKeySnapshot(apiUser);
    const r = snap.row;
    return composeReply('Fusion 配置', linesOf([
      ['开关', flag(r.fusion_enabled !== false)],
      ['Judge', r.fusion_judge_model_id || '-'],
      ['Outer', r.fusion_outer_model_id || '-'],
      ['Panel', `${Array.isArray(r.fusion_panel_models) ? r.fusion_panel_models.length : 0} 个`],
    ]), apiUser);
  },
});

register({
  id: 'signature_config',
  aliases: ['签名配置', 'signature config'],
  async run({ apiUser }) {
    const snap = await loadKeySnapshot(apiUser);
    return composeReply('签名配置', `${linesOf([['签名', flag(snap.row.signature_enabled)]])}\n模板内容不在指令中回显。`, apiUser);
  },
});

function detectProtocol(req) {
  const path = String(req.path || req.originalUrl || '');
  if (path.includes('/responses')) return 'responses';
  if (path.includes('/messages') && !path.includes('chat')) return 'anthropic';
  return 'openai';
}

function sendLocalSuccess(req, res, text) {
  const protocol = detectProtocol(req);
  const stream = !!req.body?.stream;
  const model = req.body?.model || req.apiUser?.customModelName || 'crewrouter';
  const created = Math.floor(Date.now() / 1000);
  const id = `crewrouter-${Date.now().toString(36)}`;

  if (protocol === 'anthropic') {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      return;
    }
    return res.json({
      id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  if (protocol === 'responses') {
    const body = {
      id, object: 'response', created_at: created, status: 'completed', error: null,
      model, output: [{ type: 'message', id: `msg_${id}`, role: 'assistant', content: [{ type: 'output_text', text }] }],
      output_text: text,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n`);
      res.end();
      return;
    }
    return res.json(body);
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  return res.json({
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function recordCommandUsage(req, text) {
  try {
    const last = extractLastInputText(req.body || {});
    await pool.query(
      `INSERT INTO usage_records (user_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
         request_type, messages, response, cost, request_source, user_agent)
       VALUES ($1, $2, 0, 0, 0, 'crewrouter_command', $3, $4, 0, $5, $6)`,
      [
        req.apiUser.userId, req.apiUser.keyId,
        JSON.stringify([{ role: 'user', content: last.slice(0, 2000) }]),
        String(text).slice(0, 4000),
        require('./request-source').clientMetaFromReq(req).requestSource,
        require('./request-source').clientMetaFromReq(req).userAgent,
      ]
    );
  } catch (err) {
    Logger.warn(`[CrewRouter指令] 写用量失败: ${err.message}`);
  }
}

function parseRequest(body) {
  const lastText = extractLastInputText(body || {});
  const rest = stripTrigger(lastText);
  if (rest == null) return { hit: false, lastText };
  const matched = matchCommand(rest);
  if (!matched.cmd) {
    const loose = String(rest).match(/^(开启|打开|启用|关闭|禁用|on|off|enable|disable)\s*(吞图|签名|fusion|定时|swallow|signature|schedule)$/i);
    if (loose) {
      const retry = matchCommand(`${loose[1]}${loose[2]}`);
      if (retry.cmd) return { hit: true, lastText, rest, ...retry };
    }
  }
  return { hit: true, lastText, rest, ...matched };
}

async function tryHandleCrewRouterCommand(req, res) {
  const parsed = parseRequest(req.body || {});
  if (!parsed.hit) return false;
  if (!req.apiUser?.crewrouterCommands) return false;
  let text;
  try {
    if (!parsed.cmd) {
      text = await composeReply(`未识别「${parsed.rest}」`, helpText(), req.apiUser, { footer: false });
    } else {
      text = await parsed.cmd.run({ req, apiUser: req.apiUser, args: parsed.args || {} });
    }
  } catch (err) {
    Logger.warn(`[CrewRouter指令] 执行失败: ${err.message}`);
    text = `CrewRouter：执行失败\n\n${err.message}\n\n可用指令：@CrewRouter 帮助`;
  }
  sendLocalSuccess(req, res, text);
  recordCommandUsage(req, text).catch(() => {});
  return true;
}

module.exports = {
  extractLastInputText,
  stripTrigger,
  parseRequest,
  matchCommand,
  tryHandleCrewRouterCommand,
  sendLocalSuccess,
  COMMANDS,
};
