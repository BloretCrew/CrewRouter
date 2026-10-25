const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validText(value) {
  return typeof value === 'string' && !value.includes('\0')
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

// Both current clients persist plain text, matching conversation_messages.content
// TEXT. Validate the whole batch before deleting history or starting any writes.
function normalizeMessages(value, optional = false) {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('messages 必须是消息数组');
  return value.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || typeof message.role !== 'string' || !message.role || [...message.role].length > 20
        || !validText(message.role) || !validText(message.content)
        || (message.reasoning != null && !validText(message.reasoning))) {
      throw invalid('消息格式无效');
    }
    let meta = null;
    if (message.meta != null) {
      try {
        meta = JSON.stringify(message.meta);
        if (typeof meta !== 'string') throw new Error();
        JSON.parse(meta, (key, value) => {
          if (!validText(key) || (typeof value === 'string' && !validText(value))) throw new Error();
          return value;
        });
      } catch (_) { throw invalid('消息 meta 必须是有效 JSON'); }
    }
    return { role: message.role, content: message.content, reasoning: message.reasoning || null, meta };
  });
}

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function ownedConversation(client, req, share = false) {
  const result = await client.query(
    `SELECT * FROM conversations WHERE id = $1 AND user_id = $2 FOR ${share ? 'SHARE' : 'UPDATE'}`,
    [req.params.id, req.session.user.id]
  );
  if (!result.rows.length) throw invalid('对话不存在', 404);
  return result.rows[0];
}

async function insertMessages(client, conversationId, messages) {
  for (const message of messages) {
    await client.query(
      `INSERT INTO conversation_messages (conversation_id, role, content, reasoning, meta)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, message.role, message.content, message.reasoning, message.meta]
    );
  }
}

function respondError(res, error, fallback) {
  return res.status(error.status || 500).json({ error: error.status ? error.message : fallback });
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, model, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (error) { respondError(res, error, '获取对话列表失败'); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, model, system_prompt, temperature, max_tokens } = req.body;
    const messages = normalizeMessages(req.body.messages, true);
    const id = await transaction(async client => {
      const result = await client.query(
        `INSERT INTO conversations (user_id, title, model, system_prompt, temperature, max_tokens)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.session.user.id, title || '新对话', model || '', system_prompt || '', temperature ?? 1.0, max_tokens ?? 4096]
      );
      const conversationId = result.rows[0].id;
      await insertMessages(client, conversationId, messages);
      return conversationId;
    });
    res.json({ id });
  } catch (error) { respondError(res, error, '创建对话失败'); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await transaction(async client => {
      const conversation = await ownedConversation(client, req, true);
      const messages = await client.query(
        'SELECT role, content, reasoning, meta FROM conversation_messages WHERE conversation_id = $1 ORDER BY id ASC',
        [conversation.id]
      );
      return { ...conversation, messages: messages.rows };
    });
    res.json(result);
  } catch (error) { respondError(res, error, '获取对话失败'); }
});

router.put('/:id', requireAuth, async (req, res) => {
  const { title, model, system_prompt, temperature, max_tokens } = req.body;
  try {
    const result = await pool.query(
      `UPDATE conversations SET
        title = COALESCE($1, title), model = COALESCE($2, model),
        system_prompt = COALESCE($3, system_prompt), temperature = COALESCE($4, temperature),
        max_tokens = COALESCE($5, max_tokens), updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND user_id = $7 RETURNING id`,
      [title, model, system_prompt, temperature, max_tokens, req.params.id, req.session.user.id]
    );
    if (!result.rows.length) throw invalid('对话不存在', 404);
    res.json({ ok: true });
  } catch (error) { respondError(res, error, '更新对话失败'); }
});

function saveMessages(replace) {
  return async (req, res) => {
    try {
      const messages = normalizeMessages(req.body.messages);
      await transaction(async client => {
        const conversation = await ownedConversation(client, req);
        if (replace) await client.query('DELETE FROM conversation_messages WHERE conversation_id = $1', [conversation.id]);
        await insertMessages(client, conversation.id, messages);
        await client.query('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2', [conversation.id, req.session.user.id]);
      });
      res.json({ ok: true });
    } catch (error) { respondError(res, error, '保存消息失败'); }
  };
}
router.post('/:id/messages', requireAuth, saveMessages(false));
router.put('/:id/messages', requireAuth, saveMessages(true));

router.post('/:id/fork', requireAuth, async (req, res) => {
  try {
    const id = await transaction(async client => {
      const original = await ownedConversation(client, req, true);
      const result = await client.query(
        `INSERT INTO conversations (user_id, title, model, system_prompt, temperature, max_tokens)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.session.user.id, original.title + ' (副本)', original.model, original.system_prompt, original.temperature, original.max_tokens]
      );
      const newId = result.rows[0].id;
      await client.query(
        `INSERT INTO conversation_messages (conversation_id, role, content, reasoning, meta)
         SELECT $1, role, content, reasoning, meta FROM conversation_messages WHERE conversation_id = $2 ORDER BY id ASC`,
        [newId, original.id]
      );
      return newId;
    });
    res.json({ id });
  } catch (error) { respondError(res, error, 'Fork 对话失败'); }
});

router.delete('/:id/messages/:msgIndex', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.msgIndex) || !Number.isSafeInteger(Number(req.params.msgIndex))) throw invalid('消息索引无效');
    const index = Number(req.params.msgIndex);
    await transaction(async client => {
      const conversation = await ownedConversation(client, req);
      const messages = await client.query('SELECT id FROM conversation_messages WHERE conversation_id = $1 ORDER BY id ASC', [conversation.id]);
      if (index >= messages.rows.length) throw invalid('消息索引无效');
      await client.query('DELETE FROM conversation_messages WHERE id = $1 AND conversation_id = $2', [messages.rows[index].id, conversation.id]);
      await client.query('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2', [conversation.id, req.session.user.id]);
    });
    res.json({ ok: true });
  } catch (error) { respondError(res, error, '删除消息失败'); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.session.user.id]);
    if (!result.rows.length) throw invalid('对话不存在', 404);
    res.json({ ok: true });
  } catch (error) { respondError(res, error, '删除对话失败'); }
});

module.exports = router;
