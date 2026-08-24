/**
 * 注入提示词 CRUD（挂载于 /api/user，requireAuth；demo 不挂载）
 *
 * 条目化提示词：全局生效（无 Key 绑定）或按 Key 生效（绑定指定 Key）。
 * 所有写操作校验属主（user_id）；变更后失效相关 API Key 缓存：
 * - 有绑定的条目 → 仅失效被绑定的 Key 缓存
 * - 无绑定（全局）条目 → 失效该用户全部 Key 缓存
 */

const express = require('express');
const pool = require('../models/database').pool;
const Logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const {
  invalidateUserApiKeyCache,
  invalidateApiKeyCacheByKeyId,
} = require('./api');

const router = express.Router();

const MAX_CONTENT_BYTES = 32 * 1024;
const MAX_NAME_LENGTH = 200;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

async function getOwnedPrompt(id, userId) {
  const result = await pool.query(
    'SELECT * FROM inject_prompts WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0] || null;
}

async function getBoundKeyIds(promptId) {
  const result = await pool.query(
    'SELECT api_key_id FROM inject_prompt_key_bindings WHERE prompt_id = $1 ORDER BY api_key_id',
    [promptId]
  );
  return result.rows.map(r => r.api_key_id);
}

/** 按拼接语义精确失效：绑定条目失效被绑 Key，全局条目失效全用户 Key */
async function invalidateCachesFor(userId, promptId) {
  const boundKeyIds = await getBoundKeyIds(promptId);
  if (boundKeyIds.length > 0) {
    for (const keyId of boundKeyIds) invalidateApiKeyCacheByKeyId(keyId);
  } else {
    invalidateUserApiKeyCache(userId);
  }
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
    invalidateUserApiKeyCache(userId);
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
    const prompt = await getOwnedPrompt(id, userId);
    if (!prompt) return res.status(404).json({ error: '条目不存在' });

    const parsed = parsePayload(req.body || {}, { partial: true });
    if (parsed.error) return badRequest(res, parsed.error);
    const fields = parsed.fields;
    if (Object.keys(fields).length === 0) return badRequest(res, '没有需要更新的字段');

    const merged = {
      name: fields.name !== undefined ? fields.name : prompt.name,
      content: fields.content !== undefined ? fields.content : prompt.content,
      enabled: fields.enabled !== undefined ? fields.enabled : prompt.enabled === true,
      sort_order: fields.sort_order !== undefined ? fields.sort_order : prompt.sort_order,
    };

    const result = await pool.query(
      `UPDATE inject_prompts
          SET name = $2, content = $3, enabled = $4, sort_order = $5, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $6
       RETURNING id, name, content, enabled, sort_order, created_at, updated_at`,
      [id, merged.name, merged.content, merged.enabled, merged.sort_order, userId]
    );

    await invalidateCachesFor(userId, id);
    const boundKeyIds = await getBoundKeyIds(id);
    res.json({ item: { ...result.rows[0], bound_key_ids: boundKeyIds } });
  } catch (error) {
    Logger.error('[注入提示词] 更新错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 删除 ----------
router.delete('/inject-prompts/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const prompt = await getOwnedPrompt(id, userId);
    if (!prompt) return res.status(404).json({ error: '条目不存在' });

    // 先按删除前的绑定关系失效缓存，再删行（绑定表级联删除）
    await invalidateCachesFor(userId, id);
    await pool.query('DELETE FROM inject_prompts WHERE id = $1 AND user_id = $2', [id, userId]);
    res.json({ ok: true });
  } catch (error) {
    Logger.error('[注入提示词] 删除错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 绑定 Key（空数组 = 全局） ----------
router.put('/inject-prompts/:id(\\d+)/keys', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const prompt = await getOwnedPrompt(id, userId);
    if (!prompt) return res.status(404).json({ error: '条目不存在' });

    const keyIds = Array.isArray(req.body?.keyIds) ? req.body.keyIds : null;
    if (keyIds === null) return badRequest(res, 'keyIds 必须是数组');
    const ids = [...new Set(keyIds.map(v => parseInt(v, 10)).filter(Number.isFinite))];

    if (ids.length > 0) {
      // 只允许绑定自己的 Key（Co-Key 共享的他人 Key 不可绑定）
      const owned = await pool.query(
        `SELECT id FROM api_keys WHERE id = ANY($1::int[]) AND user_id = $2`,
        [ids, userId]
      );
      const ownedIds = new Set(owned.rows.map(r => r.id));
      const illegal = ids.filter(i => !ownedIds.has(i));
      if (illegal.length > 0) {
        return res.status(403).json({ error: '存在不属于当前用户的 Key，无法绑定' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT api_key_id FROM inject_prompt_key_bindings WHERE prompt_id = $1', [id]);
      await client.query('DELETE FROM inject_prompt_key_bindings WHERE prompt_id = $1', [id]);
      for (const keyId of ids) {
        await client.query(
          'INSERT INTO inject_prompt_key_bindings (prompt_id, api_key_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, keyId]
        );
      }
      await client.query('UPDATE inject_prompts SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      await client.query('COMMIT');

      // 变更前后的绑定 Key 都可能缓存了旧拼接结果，一并失效；从未绑定且现为空则走用户级
      const beforeIds = before.rows.map(r => r.api_key_id);
      const affected = [...new Set([...beforeIds, ...ids])];
      if (affected.length > 0) {
        for (const keyId of affected) invalidateApiKeyCacheByKeyId(keyId);
      } else {
        invalidateUserApiKeyCache(userId);
      }

      res.json({ ok: true, bound_key_ids: ids.slice().sort((a, b) => a - b) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    Logger.error('[注入提示词] 绑定 Key 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 快捷开关 ----------
router.put('/inject-prompts/:id(\\d+)/toggle', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const prompt = await getOwnedPrompt(id, userId);
    if (!prompt) return res.status(404).json({ error: '条目不存在' });

    const nextEnabled = req.body?.enabled !== undefined
      ? (req.body.enabled === true || req.body.enabled === 'true')
      : !(prompt.enabled === true);

    const result = await pool.query(
      `UPDATE inject_prompts SET enabled = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $3
       RETURNING id, name, content, enabled, sort_order, created_at, updated_at`,
      [id, nextEnabled, userId]
    );

    await invalidateCachesFor(userId, id);
    const boundKeyIds = await getBoundKeyIds(id);
    res.json({ item: { ...result.rows[0], bound_key_ids: boundKeyIds } });
  } catch (error) {
    Logger.error('[注入提示词] 开关切换错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
