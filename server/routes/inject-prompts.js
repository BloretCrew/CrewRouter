/**
 * 注入提示词 CRUD（挂载于 /api/user，requireAuth；demo 不挂载）
 *
 * 条目化提示词：全局生效（无 Key 绑定）或按 Key 生效（绑定指定 Key）。
 * 所有写操作校验属主（user_id），锁父条目后原子修改。
 * 提交后失效该用户 Key 缓存；请求侧另外逐次读取提示词。
 */

const express = require('express');
const pool = require('../models/database').pool;
const Logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { invalidateUserApiKeyCache } = require('./api');

const router = express.Router();

const MAX_CONTENT_BYTES = 32 * 1024;
const MAX_NAME_LENGTH = 200;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

async function getBoundKeyIds(client, promptId) {
  const result = await client.query(
    'SELECT api_key_id FROM inject_prompt_key_bindings WHERE prompt_id = $1 ORDER BY api_key_id',
    [promptId]
  );
  return result.rows.map(r => r.api_key_id);
}

async function withOwnedPrompt(userId, id, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A parent lock also serializes replacements of an empty binding set.
    const owned = await client.query('SELECT * FROM inject_prompts WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
    if (!owned.rows[0]) throw Object.assign(new Error('条目不存在'), { status: 404 });
    const result = await work(client, owned.rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function invalidatePromptCaches(userId) {
  // Either side of a global/bound transition may affect every owned Key.
  // Invalidation follows commit and is not the request-time correctness check.
  try { invalidateUserApiKeyCache(userId); }
  catch (error) { Logger.warn('[注入提示词] 提交后缓存失效失败:', error.message); }
}

function respondError(res, error) {
  return res.status(error.status || 500).json({ error: error.status ? error.message : '服务器错误' });
}

function parseKeyIds(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error('keyIds 必须是数组'), { status: 400 });
  const ids = value.map(value => {
    const id = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > 2147483647) {
      throw Object.assign(new Error('keyIds 必须仅包含有效的正整数 Key ID'), { status: 400 });
    }
    return id;
  });
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** 校验并归一化 name/content/enabled 输入；出错时返回 { error } */
function parsePayload(body, { requireName = false, partial = false } = {}) {
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (requireName || body.name !== undefined) {
      if (!name) return { error: '名称不能为空' };
      if (name.length > MAX_NAME_LENGTH) return { error: `名称过长（最多 ${MAX_NAME_LENGTH} 字符）` };
      out.name = name;
    }
  }

  if (!partial || body.content !== undefined) {
    const content = typeof body.content === 'string' ? body.content : '';
    if (requireName || body.content !== undefined) {
      if (!content.trim()) return { error: '内容不能为空' };
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        return { error: '内容超过 32KB 上限' };
      }
      out.content = content;
    }
  }

  if (body.enabled !== undefined) {
    out.enabled = body.enabled === true || body.enabled === 'true';
  }

  if (body.sort_order !== undefined) {
    const n = parseInt(body.sort_order, 10);
    if (Number.isFinite(n)) out.sort_order = n;
  }

  return { fields: out };
}

// ---------- 当前用户的 Key 列表（绑定选择器用；仅自己的 Key，Co-Key 成员不可见他人 Key） ----------
router.get('/inject-prompts/my-keys', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      `SELECT id, COALESCE(NULLIF(name, ''), 'API Key') AS name, key_prefix
         FROM api_keys
        WHERE user_id = $1 AND enabled <> FALSE
        ORDER BY created_at ASC, id ASC`,
      [userId]
    );
    res.json({
      items: result.rows.map(r => ({ id: r.id, name: r.name, key_prefix: r.key_prefix })),
    });
  } catch (error) {
    Logger.error('[注入提示词] my-keys 查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 列表 ----------
router.get('/inject-prompts', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      `SELECT p.id, p.name, p.content, p.enabled, p.sort_order, p.created_at, p.updated_at,
              b.api_key_id, k.name AS key_name
         FROM inject_prompts p
         LEFT JOIN inject_prompt_key_bindings b ON b.prompt_id = p.id
         LEFT JOIN api_keys k ON k.id = b.api_key_id
        WHERE p.user_id = $1
        ORDER BY p.sort_order ASC, p.id ASC`,
      [userId]
    );

    const byId = new Map();
    for (const row of result.rows) {
      let item = byId.get(row.id);
      if (!item) {
        item = {
          id: row.id,
          name: row.name,
          content: row.content,
          enabled: row.enabled === true,
          sort_order: row.sort_order,
          created_at: row.created_at,
          updated_at: row.updated_at,
          bound_key_ids: [],
          bound_keys: [],
        };
        byId.set(row.id, item);
      }
      if (row.api_key_id != null) {
        item.bound_key_ids.push(row.api_key_id);
        item.bound_keys.push({ id: row.api_key_id, name: row.key_name || '' });
      }
    }

    res.json({ items: [...byId.values()] });
  } catch (error) {
    Logger.error('[注入提示词] 列表查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 新建 ----------
router.post('/inject-prompts', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const parsed = parsePayload(req.body || {}, { requireName: true });
    if (parsed.error) return badRequest(res, parsed.error);

    const { name, content, enabled = true, sort_order = 0 } = parsed.fields;
    const result = await pool.query(
      `INSERT INTO inject_prompts (user_id, name, content, enabled, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, content, enabled, sort_order, created_at, updated_at`,
      [userId, name, content, enabled === true, sort_order]
    );

    // 新建即生效：全局语义，失效该用户全部 Key 缓存
    invalidatePromptCaches(userId);
    res.json({ item: { ...result.rows[0], bound_key_ids: [], bound_keys: [] } });
  } catch (error) {
    Logger.error('[注入提示词] 新建错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 修改（名称/内容/启用） ----------
router.put('/inject-prompts/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const parsed = parsePayload(req.body || {}, { partial: true });
    if (parsed.error) return badRequest(res, parsed.error);
    const fields = parsed.fields;
    if (Object.keys(fields).length === 0) return badRequest(res, '没有需要更新的字段');

    const item = await withOwnedPrompt(userId, id, async (client, prompt) => {
      const merged = {
        name: fields.name !== undefined ? fields.name : prompt.name,
        content: fields.content !== undefined ? fields.content : prompt.content,
        enabled: fields.enabled !== undefined ? fields.enabled : prompt.enabled === true,
        sort_order: fields.sort_order !== undefined ? fields.sort_order : prompt.sort_order,
      };

      const result = await client.query(
        `UPDATE inject_prompts
          SET name = $2, content = $3, enabled = $4, sort_order = $5, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $6
       RETURNING id, name, content, enabled, sort_order, created_at, updated_at`,
        [id, merged.name, merged.content, merged.enabled, merged.sort_order, userId]
      );

      return { ...result.rows[0], bound_key_ids: await getBoundKeyIds(client, id) };
    });
    invalidatePromptCaches(userId);
    res.json({ item });
  } catch (error) {
    Logger.error('[注入提示词] 更新错误:', error);
    respondError(res, error);
  }
});

// ---------- 删除 ----------
router.delete('/inject-prompts/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    await withOwnedPrompt(userId, id, client =>
      client.query('DELETE FROM inject_prompts WHERE id = $1 AND user_id = $2', [id, userId]));
    invalidatePromptCaches(userId);
    res.json({ ok: true });
  } catch (error) {
    Logger.error('[注入提示词] 删除错误:', error);
    respondError(res, error);
  }
});

// ---------- 绑定 Key（空数组 = 全局） ----------
router.put('/inject-prompts/:id(\\d+)/keys', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const ids = parseKeyIds(req.body?.keyIds);
    await withOwnedPrompt(userId, id, async client => {
      if (ids.length) {
        // Keep owned keys stable until binding commit. Sorted lock order makes
        // overlapping key sets deterministic; Co-Key membership is not ownership.
        const owned = await client.query(
          'SELECT id FROM api_keys WHERE id = ANY($1::int[]) AND user_id = $2 ORDER BY id FOR SHARE', [ids, userId]);
        if (owned.rows.length !== ids.length) throw Object.assign(new Error('存在不属于当前用户的 Key，无法绑定'), { status: 403 });
      }
      await client.query('DELETE FROM inject_prompt_key_bindings WHERE prompt_id = $1', [id]);
      for (const keyId of ids) {
        await client.query(
          'INSERT INTO inject_prompt_key_bindings (prompt_id, api_key_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, keyId]
        );
      }
      await client.query('UPDATE inject_prompts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2', [id, userId]);
    });
    invalidatePromptCaches(userId);
    res.json({ ok: true, bound_key_ids: ids });
  } catch (error) {
    Logger.error('[注入提示词] 绑定 Key 错误:', error);
    respondError(res, error);
  }
});

// ---------- 快捷开关 ----------
router.put('/inject-prompts/:id(\\d+)/toggle', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const item = await withOwnedPrompt(userId, id, async (client, prompt) => {
      const nextEnabled = req.body?.enabled !== undefined
        ? (req.body.enabled === true || req.body.enabled === 'true')
        : !(prompt.enabled === true);

      const result = await client.query(
        `UPDATE inject_prompts SET enabled = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $3
       RETURNING id, name, content, enabled, sort_order, created_at, updated_at`,
        [id, nextEnabled, userId]
      );

      return { ...result.rows[0], bound_key_ids: await getBoundKeyIds(client, id) };
    });
    invalidatePromptCaches(userId);
    res.json({ item });
  } catch (error) {
    Logger.error('[注入提示词] 开关切换错误:', error);
    respondError(res, error);
  }
});

module.exports = router;
