const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');

// 获取用户所有对话列表
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, model, created_at, updated_at
       FROM conversations WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: '获取对话列表失败' });
  }
});

// 创建新对话
router.post('/', requireAuth, async (req, res) => {
  const { title, model, system_prompt, temperature, max_tokens, messages } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO conversations (user_id, title, model, system_prompt, temperature, max_tokens)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.session.user.id, title || '新对话', model || '', system_prompt || '', temperature || 1.0, max_tokens || 4096]
    );
    const conversationId = result.rows[0].id;

    if (messages && Array.isArray(messages) && messages.length > 0) {
      for (const msg of messages) {
        await pool.query(
          `INSERT INTO conversation_messages (conversation_id, role, content, reasoning, meta)
           VALUES ($1, $2, $3, $4, $5)`,
          [conversationId, msg.role, msg.content, msg.reasoning || null, msg.meta ? JSON.stringify(msg.meta) : null]
        );
      }
    }

    res.json({ id: conversationId });
  } catch (err) {
    res.status(500).json({ error: '创建对话失败' });
  }
});

// 获取单个对话详情（含消息）
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const convResult = await pool.query(
      `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.user.id]
    );
    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: '对话不存在' });
    }

    const messagesResult = await pool.query(
      `SELECT role, content, reasoning, meta FROM conversation_messages
       WHERE conversation_id = $1 ORDER BY id ASC`,
      [req.params.id]
    );

    res.json({
      ...convResult.rows[0],
      messages: messagesResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: '获取对话失败' });
  }
});

// 更新对话（标题、参数等）
router.put('/:id', requireAuth, async (req, res) => {
  const { title, model, system_prompt, temperature, max_tokens } = req.body;
  try {
    await pool.query(
      `UPDATE conversations SET
        title = COALESCE($1, title),
        model = COALESCE($2, model),
        system_prompt = COALESCE($3, system_prompt),
        temperature = COALESCE($4, temperature),
        max_tokens = COALESCE($5, max_tokens),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND user_id = $7`,
      [title, model, system_prompt, temperature, max_tokens, req.params.id, req.session.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '更新对话失败' });
  }
});

// 保存消息（追加到对话）
router.post('/:id/messages', requireAuth, async (req, res) => {
  const { messages } = req.body;
  try {
    const convCheck = await pool.query(
      `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.user.id]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: '对话不存在' });
    }

    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        await pool.query(
          `INSERT INTO conversation_messages (conversation_id, role, content, reasoning, meta)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, msg.role, msg.content, msg.reasoning || null, msg.meta ? JSON.stringify(msg.meta) : null]
        );
      }
    }

    await pool.query(
      `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '保存消息失败' });
  }
});

// 替换对话所有消息
router.put('/:id/messages', requireAuth, async (req, res) => {
  const { messages } = req.body;
  try {
    const convCheck = await pool.query(
      `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.user.id]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: '对话不存在' });
    }

    await pool.query(
      `DELETE FROM conversation_messages WHERE conversation_id = $1`,
      [req.params.id]
    );

    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        await pool.query(
          `INSERT INTO conversation_messages (conversation_id, role, content, reasoning, meta)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, msg.role, msg.content, msg.reasoning || null, msg.meta ? JSON.stringify(msg.meta) : null]
        );
      }
    }

    await pool.query(
      `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '保存消息失败' });
  }
});

// Fork 对话（复制为新对话）
router.post('/:id/fork', requireAuth, async (req, res) => {
  try {
    const convCheck = await pool.query(
      `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.user.id]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: '对话不存在' });
    }
    const orig = convCheck.rows[0];

    const result = await pool.query(
      `INSERT INTO conversations (user_id, title, model, system_prompt, temperature, max_tokens)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.session.user.id, orig.title + ' (副本)', orig.model, orig.system_prompt, orig.temperature, orig.max_tokens]
    );
    const newId = result.rows[0].id;

    await pool.query(
      `INSERT INTO conversation_messages (conversation_id, role, content, reasoning, meta)
       SELECT $1, role, content, reasoning, meta FROM conversation_messages WHERE conversation_id = $2`,
      [newId, req.params.id]
    );

    res.json({ id: newId });
  } catch (err) {
    res.status(500).json({ error: 'Fork 对话失败' });
  }
});

// 删除单条消息
router.delete('/:id/messages/:msgIndex', requireAuth, async (req, res) => {
  try {
    const convCheck = await pool.query(
      `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.user.id]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: '对话不存在' });
    }

    const msgResult = await pool.query(
      `SELECT id FROM conversation_messages WHERE conversation_id = $1 ORDER BY id ASC`,
      [req.params.id]
    );
    const idx = parseInt(req.params.msgIndex);
    if (idx < 0 || idx >= msgResult.rows.length) {
      return res.status(400).json({ error: '消息索引无效' });
    }

    await pool.query(
      `DELETE FROM conversation_messages WHERE id = $1`,
      [msgResult.rows[idx].id]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '删除消息失败' });
  }
});

// 删除对话
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM conversations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '删除对话失败' });
  }
});

module.exports = router;
