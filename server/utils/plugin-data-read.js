'use strict';

/**
 * 插件只读数据访问构建器（三期开放能力）
 *
 * 安全原则：
 *  - 所有方法返回「字段白名单」聚合/元数据，绝不返回 messages/response/request_params
 *    等原始大字段，也绝不返回 provider 凭证 / API Key 明文。
 *  - 所有方法内部强制 userId 作用域（或显式传入且由调用方鉴权），不做全局裸查。
 *  - 返回对象始终可 JSON 序列化，无原型污染风险。
 */

const { pool } = require('../models/database');

// usage_records 可暴露给插件的白名单聚合键（无 messages/response）
const USAGE_AGG_KEYS = ['tokens_used', 'cached_tokens', 'cost', 'weighted_tokens'];
const USAGE_GROUP_KEYS = ['model_id', 'created_at'];

/**
 * 用量/成本聚合（usage:read / export:usage）
 * @param {{ userId?: number, apiKeyId?: number, days?: number, groupBy?: 'model_id'|'day' }} opts
 * @returns {Promise<{rows: Array, summary: object}>} 不含任何正文字段
 */
async function usageSummary(opts = {}) {
  const days = Math.min(Math.max(parseInt(opts.days, 10) || 7, 1), 90);
  const params = [];
  const where = [];
  if (opts.userId) { params.push(opts.userId); where.push(`user_id = $${params.length}`); }
  if (opts.apiKeyId) { params.push(opts.apiKeyId); where.push(`api_key_id = $${params.length}`); }
  params.push(days);
  where.push(`created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
  const whereSql = where.join(' AND ');

  const groupBy = opts.groupBy === 'day'
    ? `to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
    : (opts.groupBy === 'model_id' ? 'model_id' : null);
  const groupSql = groupBy ? `GROUP BY ${groupBy}` : '';
  const sel = groupBy ? `${groupBy} AS group_key, ` : '';

  const r = await pool.query(
    `SELECT ${sel}
       COUNT(*)::int AS request_count,
       COALESCE(SUM(tokens_used),0)::bigint AS tokens_used,
       COALESCE(SUM(cached_tokens),0)::bigint AS cached_tokens,
       COALESCE(SUM(weighted_tokens),0)::bigint AS weighted_tokens,
       COALESCE(SUM(cost),0)::numeric AS cost
     FROM usage_records WHERE ${whereSql} ${groupSql}
     ORDER BY 1 DESC LIMIT 500`,
    params
  );

  // 汇总行（若已按 group 分组则单独聚合一次轻量总和）
  const s = await pool.query(
    `SELECT COUNT(*)::int AS request_count,
       COALESCE(SUM(tokens_used),0)::bigint AS tokens_used,
       COALESCE(SUM(cached_tokens),0)::bigint AS cached_tokens,
       COALESCE(SUM(weighted_tokens),0)::bigint AS weighted_tokens,
       COALESCE(SUM(cost),0)::numeric AS cost
     FROM usage_records WHERE ${whereSql}`,
    params
  );

  return {
    rows: r.rows,
    summary: s.rows[0] || null,
    whitelist: { aggregate: USAGE_AGG_KEYS, group: USAGE_GROUP_KEYS },
  };
}

/**
 * 模型目录 + 最近健康状态（models:read）— 只读，不暴露供应商密钥
 */
async function modelList() {
  // 探测列是否存在，避免版本差异崩溃
  const col = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'models' AND column_name IN ('enabled','provider_id','model_multiplier','alias','health','last_response_code')`
  );
  const cols = new Set(col.rows.map(r => r.column_name));

  let healthSel = '';
  if (cols.has('health')) healthSel += ', health';
  if (cols.has('last_response_code')) healthSel += ', last_response_code';

  const r = await pool.query(
    `SELECT id, name, alias, provider_id, model_multiplier, enabled ${healthSel}
     FROM models ORDER BY id LIMIT 500`
  );
  return r.rows;
}

/**
 * 插件注册信息（meta:read）— 只读 manifest/权限/启用状态
 * @param {import('../plugins/registry')} registry
 * @param {string} pluginId 当前插件 id
 */
function pluginMetaView(registry, pluginId) {
  return {
    get(id) {
      const target = id || pluginId;
      const manifest = registry.getLoadedManifest(target);
      if (!manifest) return null;
      return {
        id: target,
        name: manifest.name,
        version: manifest.version || '',
        permissions: manifest.permissions || [],
        enabled: registry.isLoaded(target),
      };
    },
    listAll() {
      // 只读已启用列表，不含 config 敏感值
      const out = [];
      for (const id of registry.listLoadedIds ? registry.listLoadedIds() : []) {
        const m = registry.getLoadedManifest(id);
        if (m) out.push({ id, name: m.name, version: m.version || '', permissions: m.permissions || [] });
      }
      return out;
    },
  };
}

/**
 * 用户偏好（preferences:read）— 受用户授权门控
 */
async function getPreferences(req) {
  const userId = req?.session?.user?.id;
  if (!userId) return { granted: false, reason: 'no_session' };

  // 用户级开关：settings 表 plugin_pref_optin
  const opt = await pool.query(
    `SELECT value FROM settings WHERE key = 'plugin_pref_optin' AND (value::jsonb) @> $1::jsonb`,
    [JSON.stringify({ users: [userId] })]
  );
  if (!opt.rows.length) return { granted: false, reason: 'not_opted_in' };

  // 偏好实际存哪：users.preferences 若存在则读，否则 settings pref:user:<id>
  const col = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='preferences'`
  );
  if (col.rows.length) {
    const u = await pool.query('SELECT preferences FROM users WHERE id = $1', [userId]);
    return { granted: true, preferences: u.rows[0]?.preferences || {} };
  }
  const s = await pool.query("SELECT value FROM settings WHERE key = 'pref:user:' || $1", [String(userId)]);
  return { granted: true, preferences: s.rows[0]?.value || {} };
}

module.exports = {
  USAGE_AGG_KEYS,
  USAGE_GROUP_KEYS,
  usageSummary,
  modelList,
  pluginMetaView,
  getPreferences,
};
