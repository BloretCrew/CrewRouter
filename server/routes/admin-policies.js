'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const Logger = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireTeamEdition } = require('../utils/instance-edition');
const requireTeamAdminEdition = requireTeamEdition(() => require('../utils/instance-edition').loadPersistedEdition(pool));
const { logAction, ACTIONS } = require('../utils/audit-log');
const {
  normalizePolicyInput,
  normalizePolicySettingsInput,
  PolicyValidationError,
} = require('../utils/policy/validation');
const { compilePolicy, matchPolicy } = require('../utils/policy/matcher');
const {
  getPolicySnapshot,
  invalidatePolicyCache,
  resolveSettings,
  applicablePolicies,
  activeExemptions,
  normalizeSettings,
  DEFAULT_SETTINGS,
} = require('../utils/policy/cache');
const { listTemplates, getTemplate } = require('../utils/policy/templates');
const { listVersions, getVersion, diffSnapshots, rollbackToVersion, saveVersion } = require('../utils/policy/versions');
const { detectConflicts } = require('../utils/policy/conflicts');
const { simulatePolicy, simulatePolicyById } = require('../utils/policy/simulations');
const {
  createApproval, listApprovals, decideApproval,
} = require('../utils/policy/approvals');
const channels = require('../utils/policy/channels');
const metrics = require('../utils/policy/metrics');
const { subscribe } = require('../utils/policy/events');
const { invalidateAlertConfigCache } = require('../utils/policy/alerts');
const { suspensionState, suspendUser, resumeUser } = require('../utils/policy/suspension');
const { invalidateSuspensionCache } = require('../middleware/suspension-gate');
const { recordHit } = require('../utils/policy/hit-recorder');
const { sourceLabel } = require('../utils/request-source');

router.use(requireTeamAdminEdition);
router.use(requireAuth);
router.use(requirePolicyAccess);
router.use((req, res, next) => {
  if (req.policyReadOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: '只读角色不能修改策略' });
  }
  next();
});

async function requirePolicyAccess(req, res, next) {
  try {
    const user = req.authUser || {};
    if (user.isAdmin === true) {
      req.policyTeamIds = null;
      req.policyReadOnly = false;
      return next();
    }
    if (!user.id) return res.status(401).json({ error: '请先登录' });
    const result = await pool.query(
      `SELECT team_id, role FROM user_teams WHERE user_id = $1 AND role IN ('owner','admin','viewer')`,
      [user.id]
    );
    const managers = result.rows.filter(row => row.role === 'owner' || row.role === 'admin').map(row => Number(row.team_id));
    const viewers = result.rows.filter(row => row.role === 'viewer').map(row => Number(row.team_id));
    const ids = managers.length ? managers : viewers;
    if (!ids.length) return res.status(403).json({ error: '无策略管理权限' });
    req.policyTeamIds = ids;
    req.policyReadOnly = managers.length === 0;
    return next();
  } catch (error) {
    return res.status(503).json({ error: '权限暂不可用' });
  }
}

function requireGlobalPolicyAdmin(req, res) {
  if (req.policyTeamIds) {
    res.status(403).json({ error: '该操作仅限全局管理员' });
    return false;
  }
  return true;
}

/** 策略作用域可见性：全局策略可读；Team/成员策略按管理 Team 过滤。 */
function policyScopePredicate(alias, req, params) {
  if (!req.policyTeamIds) return '';
  params.push(req.policyTeamIds);
  const n = params.length;
  return `(${alias}.scope_type = 'global' OR (${alias}.scope_type = 'team' AND ${alias}.scope_id = ANY($${n}::int[])) OR (${alias}.scope_type = 'member' AND ${alias}.scope_id IN (SELECT id FROM users WHERE team_id = ANY($${n}::int[]))))`;
}

async function policyTeamId(policy) {
  if (!policy) return null;
  if (policy.scope_type === 'team') return Number(policy.scope_id);
  if (policy.scope_type === 'member') {
    const result = await pool.query('SELECT team_id FROM users WHERE id = $1', [policy.scope_id]);
    return result.rows[0]?.team_id ? Number(result.rows[0].team_id) : null;
  }
  return null;
}

async function canWritePolicy(req, policy) {
  if (!req.policyTeamIds) return true;
  if (policy.scope_type === 'global') return false;
  const teamId = await policyTeamId(policy);
  return teamId != null && req.policyTeamIds.includes(teamId);
}

async function canReadPolicy(req, policy) {
  if (!req.policyTeamIds) return true;
  if (policy.scope_type === 'global') return true;
  const teamId = await policyTeamId(policy);
  return teamId != null && req.policyTeamIds.includes(teamId);
}

async function ensureScopeAllowed(req, scopeType, scopeId, { write = true } = {}) {
  if (!req.policyTeamIds) return true;
  if (scopeType === 'global') return !write;
  if (scopeType === 'team') return req.policyTeamIds.includes(Number(scopeId));
  const result = await pool.query('SELECT team_id FROM users WHERE id = $1', [scopeId]);
  const teamId = result.rows[0]?.team_id;
  return teamId != null && req.policyTeamIds.includes(Number(teamId));
}

async function canAccessSubject(req, subjectType, subjectId) {
  if (!req.policyTeamIds) return true;
  if (subjectType === 'team') return req.policyTeamIds.includes(Number(subjectId));
  if (subjectType === 'user') {
    const result = await pool.query('SELECT team_id FROM users WHERE id = $1', [subjectId]);
    return req.policyTeamIds.includes(Number(result.rows[0]?.team_id));
  }
  if (subjectType === 'api_key') {
    const result = await pool.query(
      `SELECT u.team_id FROM api_keys ak JOIN users u ON u.id = ak.user_id WHERE ak.id = $1`,
      [subjectId]
    );
    return req.policyTeamIds.includes(Number(result.rows[0]?.team_id));
  }
  return false;
}

function actor(req) {
  return req.authUser || req.session?.user || {};
}

function audit(req, action, resourceType, resourceId, description, details) {
  const user = actor(req);
  logAction({
    userId: user.id || null,
    username: user.username || '系统',
    isAdmin: user.isAdmin === true,
    action,
    resourceType,
    resourceId,
    description,
    details,
    ip: req.ip || null,
    userAgent: req.headers?.['user-agent'] || null,
    status: 200,
  });
}

function parsePagination(req, defaultLimit = 20) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function handleError(res, error, scope) {
  if (error instanceof PolicyValidationError) {
    return res.status(400).json({ error: error.message, code: error.code, details: error.details || [] });
  }
  Logger.error(`[策略/${scope}] 错误:`, error);
  return res.status(500).json({ error: '服务器错误' });
}

async function ensureScope(scopeType, scopeId) {
  if (scopeType === 'global') return null;
  if (scopeType === 'team') {
    const result = await pool.query('SELECT id FROM teams WHERE id = $1', [scopeId]);
    if (!result.rows.length) throw new PolicyValidationError('Team 不存在', [{ field: 'scope_id', message: 'Team 不存在' }]);
    return scopeId;
  }
  const result = await pool.query('SELECT id FROM users WHERE id = $1', [scopeId]);
  if (!result.rows.length) throw new PolicyValidationError('成员不存在', [{ field: 'scope_id', message: '成员不存在' }]);
  return scopeId;
}

async function teamPolicyLimit(teamId) {
  const result = await pool.query('SELECT max_policies_per_team FROM policy_settings WHERE team_id = $1', [teamId]);
  return Number(result.rows[0]?.max_policies_per_team || 500);
}

async function countTeamPolicies(teamId) {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM access_policies WHERE scope_type = 'team' AND scope_id = $1) +
       (SELECT COUNT(*) FROM access_policies p JOIN users u ON u.id = p.scope_id
         WHERE p.scope_type = 'member' AND u.team_id = $1) AS total`,
    [teamId]
  );
  return Number(result.rows[0]?.total || 0);
}

function policyMessage(policy) {
  return policy.message_template || `请求被团队策略「${policy.name}」拦截`;
}

// 未使用的辅助函数保留位置，便于后续导出功能复用。
void policyMessage;

// ==================== 策略范围选择 ====================

router.get('/policy-teams', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.policyTeamIds) {
      params.push(req.policyTeamIds);
      where = 'WHERE id = ANY($1::int[])';
    }
    const result = await pool.query(`SELECT id, name, is_personal FROM teams ${where} ORDER BY id ASC`, params);
    res.json(result.rows);
  } catch (error) {
    handleError(res, error, 'policy-teams');
  }
});

router.get('/policy-users', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.policyTeamIds) {
      params.push(req.policyTeamIds);
      where.push(`team_id = ANY($${params.length}::int[])`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(username ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }
    params.push(Math.min(500, Math.max(1, Number(req.query.limit) || 200)));
    const result = await pool.query(
      `SELECT id, username, email, is_admin, team_id FROM users
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id ASC LIMIT $${params.length}`,
      params
    );
    res.json({ items: result.rows, total: result.rows.length });
  } catch (error) {
    handleError(res, error, 'policy-users');
  }
});

// ==================== 概览 ====================

router.get('/policies/overview', async (req, res) => {
  try {
    const teams = req.policyTeamIds;
    const scopeParams = [];
    const scope = policyScopePredicate('p', req, scopeParams);
    const teamWhere = teams ? 'WHERE team_id = ANY($1::int[])' : '';
    const teamAnd = teams ? 'AND team_id = ANY($1::int[])' : '';
    const params = teams ? [teams] : [];
    const [policies, members, hits, topPolicies, topClients, pending] = await Promise.all([
      pool.query(`SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE enabled)::int AS enabled,
          COUNT(*) FILTER (WHERE effect = 'deny')::int AS deny,
          COUNT(*) FILTER (WHERE effect = 'allow')::int AS allow,
          COUNT(*) FILTER (WHERE effect = 'allow' AND action = 'warn')::int AS allowlist
        FROM access_policies p ${scope ? `WHERE ${scope}` : ''}`, scopeParams),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE suspended_at IS NOT NULL AND (suspended_until IS NULL OR suspended_until > NOW()))::int AS suspended,
          COUNT(*) FILTER (WHERE suspended_at IS NOT NULL AND suspended_until > NOW() AND suspended_until <= NOW() + INTERVAL '24 hours')::int AS suspended_24h,
          COUNT(*) FILTER (WHERE policy_bypass AND (policy_bypass_until IS NULL OR policy_bypass_until > NOW()))::int AS bypassed
        FROM users ${teamWhere}`, params),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last_7d,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours' AND decision = 'block')::int AS blocked_24h,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours' AND action IN ('shadow','warn','notify'))::int AS observed_24h
        FROM policy_hits ${teamWhere}`, params),
      pool.query(`SELECT policy_id, policy_name, COUNT(*)::int AS hits
        FROM policy_hits WHERE created_at >= NOW() - INTERVAL '24 hours' AND policy_id IS NOT NULL ${teamAnd}
        GROUP BY policy_id, policy_name ORDER BY hits DESC LIMIT 5`, params),
      pool.query(`SELECT request_source, COUNT(*)::int AS hits
        FROM policy_hits WHERE created_at >= NOW() - INTERVAL '24 hours' ${teamAnd}
        GROUP BY request_source ORDER BY hits DESC LIMIT 8`, params),
      pool.query(`SELECT
          (SELECT COUNT(*) FROM policy_approvals a WHERE a.status = 'pending' ${teams ? "AND (a.payload->>'team_id')::int = ANY($1::int[])" : ''})::int AS approvals,
          (SELECT COUNT(*) FROM policy_appeals a LEFT JOIN users u ON u.id = a.user_id WHERE a.status = 'pending' ${teams ? 'AND u.team_id = ANY($1::int[])' : ''})::int AS appeals`,
        params),
    ]);
    res.json({
      policies: policies.rows[0],
      members: members.rows[0],
      hits: hits.rows[0],
      top_policies: topPolicies.rows,
      top_clients: topClients.rows.map(row => ({ ...row, label: sourceLabel(row.request_source) })),
      pending: pending.rows[0],
    });
  } catch (error) {
    handleError(res, error, 'overview');
  }
});

// ==================== 策略列表 ====================

router.get('/policies', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const params = [];
    const where = [];
    const scope = policyScopePredicate('p', req, params);
    if (scope) where.push(scope);
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (req.query.scope_type) add('p.scope_type = ?', req.query.scope_type);
    if (req.query.category) add('p.category = ?', req.query.category);
    if (req.query.effect) add('p.effect = ?', req.query.effect);
    if (req.query.status) add('p.status = ?', req.query.status);
    if (req.query.enabled === 'true' || req.query.enabled === 'false') add('p.enabled = ?', req.query.enabled === 'true');
    if (req.query.group_id) add('p.group_id = ?', Number(req.query.group_id));
    if (req.query.q) {
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
      where.push(`(p.name ILIKE $${params.length - 1} OR p.description ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      pool.query(`SELECT p.*, g.name AS group_name,
          COALESCE(h.hits, 0)::int AS hits_24h,
          COALESCE(h.blocked, 0)::int AS blocked_24h
        FROM access_policies p
        LEFT JOIN policy_groups g ON g.id = p.group_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS hits,
                 COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked
          FROM policy_hits ph
          WHERE ph.policy_id = p.id AND ph.created_at >= NOW() - INTERVAL '24 hours'
        ) h ON TRUE
        ${whereSql}
        ORDER BY p.priority DESC, p.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS total FROM access_policies p ${whereSql}`, params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].total, page, limit });
  } catch (error) {
    handleError(res, error, 'list');
  }
});

router.get('/policies/templates', async (req, res) => {
  res.json(listTemplates());
});

router.get('/policies/effective', async (req, res) => {
  try {
    const userId = Number(req.query.user_id);
    if (!userId) return res.status(400).json({ error: '缺少 user_id' });
    const snapshot = await getPolicySnapshot();
    const user = await pool.query('SELECT id, team_id FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) return res.status(404).json({ error: '成员不存在' });
    const teamId = user.rows[0].team_id;
    const settings = resolveSettings(snapshot, teamId);
    const policies = applicablePolicies(snapshot, { userId, teamId }).map(({ _compiled, ...policy }) => policy);
    const exemptions = activeExemptions(snapshot, { userId, teamId });
    res.json({
      settings,
      policies,
      exemptions,
    });
  } catch (error) {
    handleError(res, error, 'effective');
  }
});

router.get('/policies/health', async (req, res) => {
  try {
    const result = await pool.query(`SELECT
        (SELECT COUNT(*) FROM access_policies WHERE ends_at IS NOT NULL AND ends_at <= NOW() + INTERVAL '7 days' AND ends_at > NOW())::int AS expiring_soon,
        (SELECT COUNT(*) FROM access_policies WHERE enabled AND NOT EXISTS (
          SELECT 1 FROM policy_hits h WHERE h.policy_id = access_policies.id AND h.created_at >= NOW() - INTERVAL '30 days'
        ))::int AS zero_hits_30d,
        (SELECT COUNT(*) FROM access_policies p WHERE p.scope_type = 'team' AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = p.scope_id))::int AS orphan_teams,
        (SELECT COUNT(*) FROM access_policies p WHERE p.scope_type = 'member' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.scope_id))::int AS orphan_members,
        (SELECT COUNT(*) FROM policy_exemptions WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= NOW())::int AS expired_exemptions`);
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'health');
  }
});

// ==================== 生命周期、冲突与模拟 ====================

router.get('/policies/conflicts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM access_policies WHERE enabled = TRUE AND status = 'published' ORDER BY priority DESC, id ASC`
    );
    res.json(detectConflicts(result.rows));
  } catch (error) {
    handleError(res, error, 'conflicts');
  }
});

router.post('/policies/simulate', async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.body?.limit) || 200));
    const teamId = req.body?.team_id ? Number(req.body.team_id) : null;
    if (req.body?.policy_id) {
      const result = await simulatePolicyById(Number(req.body.policy_id), {
        limit,
        samples: Array.isArray(req.body.samples) ? req.body.samples : null,
        teamId,
      });
      return res.json(result);
    }
    if (!req.body?.policy) return res.status(400).json({ error: '缺少策略或策略 ID' });
    const input = normalizePolicyInput({ ...req.body.policy, name: req.body.policy.name || '模拟策略' });
    const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
    if (!samples.length) return res.status(400).json({ error: '缺少模拟样本' });
    res.json({ ...(await simulatePolicy(input, samples)), total: samples.length });
  } catch (error) {
    handleError(res, error, 'simulate');
  }
});

router.post('/policies/output-scan', async (req, res) => {
  if (!requireGlobalPolicyAdmin(req, res)) return;
  try {
    const { scanOutputPolicies } = require('../utils/policy/output-scan');
    res.json(await scanOutputPolicies({
      limit: Number(req.body?.limit) || 200,
      sinceMinutes: Number(req.body?.since_minutes) || 60,
    }));
  } catch (error) {
    handleError(res, error, 'output-scan');
  }
});

router.get('/policies/export', async (req, res) => {
  try {
    const params = [];
    const scope = policyScopePredicate('p', req, params);
    const result = await pool.query(
      `SELECT * FROM access_policies p ${scope ? `WHERE ${scope}` : ''} ORDER BY p.id ASC`,
      params
    );
    const policies = result.rows.map(row => {
      const { id, created_by, updated_by, created_at, updated_at, archived_at, version, ...rest } = row;
      return rest;
    });
    res.json({ version: 1, exported_at: new Date().toISOString(), policies });
  } catch (error) {
    handleError(res, error, 'export');
  }
});

router.get('/policies/schema', (req, res) => {
  res.json({
    version: 1,
    description: 'CrewRouter policy export/import schema',
    required: ['name', 'scope_type', 'effect', 'action', 'conditions'],
    enums: {
      scope_type: ['global', 'team', 'member'],
      effect: ['deny', 'allow'],
      action: ['block', 'warn', 'shadow', 'notify', 'throttle', 'queue', 'downgrade', 'approval', 'step_up', 'suspend', 'revoke_key', 'custom'],
      category: ['client', 'identity', 'model', 'provider', 'network', 'time', 'usage', 'capacity', 'content', 'session', 'combined'],
      status: ['draft', 'published', 'archived'],
    },
    condition_keys: [
      'clients', 'protocols', 'endpoints', 'semantics', 'models', 'providers', 'tools',
      'mcp_servers', 'ips', 'countries', 'countries_deny', 'asn', 'tags', 'identities',
      'api_keys', 'oauth_clients', 'session', 'prompt', 'output', 'media', 'limits',
      'schedule', 'usage', 'budget', 'concurrency', 'login', 'all', 'any', 'not',
    ],
  });
});

router.post('/policies/import', async (req, res) => {
  const list = Array.isArray(req.body?.policies) ? req.body.policies : [];
  const dryRun = req.body?.dry_run === true;
  if (!list.length) return res.status(400).json({ error: 'policies 不能为空' });
  if (list.length > 200) return res.status(400).json({ error: '单次最多导入 200 条策略' });
  const results = [];
  const client = dryRun ? null : await pool.connect();
  try {
    if (client) await client.query('BEGIN');
    for (let index = 0; index < list.length; index += 1) {
      const raw = list[index];
      try {
        const input = normalizePolicyInput({ ...raw, name: raw?.name || `导入策略 ${index + 1}` });
        await ensureScope(input.scope_type, input.scope_id);
        if (!await ensureScopeAllowed(req, input.scope_type, input.scope_id, { write: true })) {
          throw Object.assign(new Error('无权在该作用域导入策略'), { code: 'policy_forbidden' });
        }
        if (dryRun) {
          results.push({ index, name: input.name, ok: true });
          continue;
        }
        const result = await client.query(
          `INSERT INTO access_policies (
            name, description, scope_type, scope_id, effect, action, action_options, ladder,
            priority, category, conditions, status, version, group_id, tags, rollout_percent,
            status_code, message_template, notify_channels, starts_at, ends_at, auto_publish_at,
            bypass_until, enabled, created_by, updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,1,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24,$24)
          ON CONFLICT (scope_type, COALESCE(scope_id, 0), name) DO NOTHING
          RETURNING *`,
          [
            input.name, input.description, input.scope_type, input.scope_id, input.effect, input.action,
            JSON.stringify(input.action_options || {}), JSON.stringify(input.ladder || []),
            input.priority, input.category, JSON.stringify(input.conditions || {}), input.status || 'draft',
            input.group_id || null, input.tags || [], input.rollout_percent, input.status_code,
            input.message_template, JSON.stringify(input.notify_channels || {}), input.starts_at,
            input.ends_at, input.auto_publish_at || null, input.bypass_until, input.enabled,
            actor(req).id || null,
          ]
        );
        if (result.rows.length) {
          await saveVersion(client, result.rows[0], '导入策略', actor(req).id);
          results.push({ index, name: input.name, ok: true, id: result.rows[0].id });
        } else {
          results.push({ index, name: input.name, ok: false, skipped: true, error: '同作用域同名策略已存在' });
        }
      } catch (error) {
        results.push({ index, name: raw?.name || `导入策略 ${index + 1}`, ok: false, error: error.message, details: error.details || [] });
      }
    }
    if (client) await client.query('COMMIT');
    if (!dryRun) invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_IMPORT, 'policy', null, dryRun ? '预览导入策略' : '导入策略', { count: list.length, results });
    res.json({ dry_run: dryRun, results });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    handleError(res, error, 'import');
  } finally {
    client?.release();
  }
});

router.get('/policies/report', async (req, res) => {
  try {
    const range = String(req.query.range || '30d');
    const hours = range === '24h' ? 24 : range === '7d' ? 168 : range === '30d' ? 720 : 168;
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const teams = req.policyTeamIds;
    const params = [since, ...(teams ? [teams] : [])];
    const teamFilter = teams ? 'AND team_id = ANY($2::int[])' : '';
    const [summary, topPolicies, topClients, exemptions, appeals, approvals, logins] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS hits, COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked,
                COUNT(DISTINCT user_id)::int AS members, COUNT(DISTINCT policy_id)::int AS policies
           FROM policy_hits WHERE created_at >= $1 ${teamFilter}`,
        params
      ),
      pool.query(
        `SELECT policy_id, policy_name, COUNT(*)::int AS hits,
                COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked
           FROM policy_hits WHERE created_at >= $1 ${teamFilter}
           GROUP BY policy_id, policy_name ORDER BY hits DESC LIMIT 20`,
        params
      ),
      pool.query(
        `SELECT request_source, COUNT(*)::int AS hits
           FROM policy_hits WHERE created_at >= $1 ${teamFilter}
           GROUP BY request_source ORDER BY hits DESC LIMIT 20`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS active FROM policy_exemptions e WHERE e.status = 'active'
          ${teams ? `AND (((e.subject_type = 'user' AND e.subject_id IN (SELECT id FROM users WHERE team_id = ANY($1::int[]))) OR (e.subject_type = 'team' AND e.subject_id = ANY($1::int[])) OR (e.subject_type = 'api_key' AND e.subject_id IN (SELECT ak.id FROM api_keys ak JOIN users au ON au.id = ak.user_id WHERE au.team_id = ANY($1::int[])))))` : ''}`,
        teams ? [teams] : []
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count FROM policy_appeals a
          ${teams ? 'LEFT JOIN users u ON u.id = a.user_id' : ''}
          ${teams ? 'WHERE u.team_id = ANY($1::int[])' : ''}
          GROUP BY status`,
        teams ? [teams] : []
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count FROM policy_approvals a
          ${teams ? "WHERE (a.payload->>'team_id')::int = ANY($1::int[])" : ''}
          GROUP BY status`,
        teams ? [teams] : []
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE success)::int AS success,
                COUNT(*) FILTER (WHERE NOT success)::int AS failed
           FROM login_events e
           ${teams
             ? 'WHERE e.user_id IN (SELECT id FROM users WHERE team_id = ANY($1::int[])) AND e.created_at >= $2'
             : 'WHERE e.created_at >= $1'}`,
        teams ? [teams, since] : [since]
      ),
    ]);
    const report = {
      generated_at: new Date().toISOString(),
      range: { from: since.toISOString(), to: new Date().toISOString() },
      summary: summary.rows[0],
      top_policies: topPolicies.rows,
      top_clients: topClients.rows.map(row => ({ ...row, label: sourceLabel(row.request_source) })),
      exemptions: exemptions.rows[0],
      appeals: appeals.rows,
      approvals: approvals.rows,
      logins: logins.rows[0],
    };
    if (req.query.format === 'csv') {
      const lines = [
        'metric,value',
        `generated_at,${report.generated_at}`,
        `hits,${report.summary.hits || 0}`,
        `blocked,${report.summary.blocked || 0}`,
        `members,${report.summary.members || 0}`,
        `policies,${report.summary.policies || 0}`,
        `active_exemptions,${report.exemptions.active || 0}`,
        `login_total,${report.logins.total || 0}`,
        `login_failed,${report.logins.failed || 0}`,
      ];
      res.type('text/csv').send(lines.join('\n'));
      return;
    }
    res.json(report);
  } catch (error) {
    handleError(res, error, 'report');
  }
});

router.get('/policies/analytics', async (req, res) => {
  try {
    const range = String(req.query.range || '7d');
    const hours = range === '24h' ? 24 : range === '30d' ? 720 : 168;
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - hours * 3600 * 1000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const result = await metrics.analytics({
      from, to, groupBy: String(req.query.group_by || 'policy'),
      limit: Number(req.query.limit) || 50,
      teamIds: req.policyTeamIds,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 'analytics');
  }
});

router.get('/policies/metrics', async (req, res) => {
  if (!requireGlobalPolicyAdmin(req, res)) return;
  try {
    res.type('text/plain; version=0.0.4').send(await metrics.prometheusText());
  } catch (error) {
    handleError(res, error, 'metrics');
  }
});

router.post('/policies/:id/publish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = await pool.query('SELECT * FROM access_policies WHERE id = $1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: '策略不存在' });
    if (!await canWritePolicy(req, current.rows[0])) return res.status(403).json({ error: '无权发布该策略' });
    let teamId = null;
    if (current.rows[0].scope_type === 'team') teamId = current.rows[0].scope_id;
    if (current.rows[0].scope_type === 'member') {
      const member = await pool.query('SELECT team_id FROM users WHERE id = $1', [current.rows[0].scope_id]);
      teamId = member.rows[0]?.team_id || null;
    }
    const settings = resolveSettings(await getPolicySnapshot(), teamId);
    if (settings.require_approval_for_publish) {
      const approval = await createApproval(pool, {
        kind: 'change', policyId: id, requestedBy: actor(req).id || null,
        payload: { action: 'publish', policy_id: id, team_id: teamId },
        preview: { name: current.rows[0].name, status: current.rows[0].status },
      });
      audit(req, ACTIONS.POLICY_PUBLISH, 'policy', id, `提交发布审批「${current.rows[0].name}」`, { approval_id: approval.id });
      return res.status(202).json({ pending_approval: true, approval_id: approval.id });
    }
    const result = await pool.query(
      `UPDATE access_policies SET status = 'published', archived_at = NULL, updated_by = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, actor(req).id || null]
    );
    await saveVersion(pool, result.rows[0], '发布策略', actor(req).id);
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_PUBLISH, 'policy', id, `发布策略「${result.rows[0].name}」`);
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'publish');
  }
});

router.post('/policies/:id/unpublish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM access_policies WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: '策略不存在' });
    if (!await canWritePolicy(req, existing.rows[0])) return res.status(403).json({ error: '无权修改该策略' });
    const result = await pool.query(
      `UPDATE access_policies SET status = 'draft', updated_by = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, actor(req).id || null]
    );
    if (!result.rows.length) return res.status(404).json({ error: '策略不存在' });
    await saveVersion(pool, result.rows[0], '转为草稿', actor(req).id);
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_UPDATE, 'policy', id, `策略转为草稿「${result.rows[0].name}」`);
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'unpublish');
  }
});

router.post('/policies/:id/archive', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM access_policies WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: '策略不存在' });
    if (!await canWritePolicy(req, existing.rows[0])) return res.status(403).json({ error: '无权归档该策略' });
    const result = await pool.query(
      `UPDATE access_policies SET status = 'archived', archived_at = NOW(), updated_by = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, actor(req).id || null]
    );
    if (!result.rows.length) return res.status(404).json({ error: '策略不存在' });
    await saveVersion(pool, result.rows[0], '归档策略', actor(req).id);
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_UPDATE, 'policy', id, `归档策略「${result.rows[0].name}」`);
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'archive');
  }
});

router.post('/policies/:id/rollback/:version', async (req, res) => {
  try {
    const current = await pool.query('SELECT * FROM access_policies WHERE id = $1', [Number(req.params.id)]);
    if (!current.rows.length) return res.status(404).json({ error: '策略不存在' });
    if (!await canWritePolicy(req, current.rows[0])) return res.status(403).json({ error: '无权回滚该策略' });
    const policy = await rollbackToVersion({
      policyId: Number(req.params.id),
      version: Number(req.params.version),
      userId: actor(req).id || null,
      changeSummary: `回滚到版本 ${req.params.version}`,
    });
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_ROLLBACK, 'policy', policy.id, `回滚策略「${policy.name}」`, { version: req.params.version });
    res.json(policy);
  } catch (error) {
    handleError(res, error, 'rollback');
  }
});

router.get('/policies/:id/versions', async (req, res) => {
  try {
    res.json(await listVersions(pool, Number(req.params.id)));
  } catch (error) {
    handleError(res, error, 'versions');
  }
});

router.get('/policies/:id/diff', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const policy = await pool.query('SELECT * FROM access_policies WHERE id = $1', [id]);
    if (!policy.rows.length) return res.status(404).json({ error: '策略不存在' });
    const toVersion = Number(req.query.to) || Number(policy.rows[0].version);
    const fromVersion = Number(req.query.from);
    const from = fromVersion ? (await getVersion(pool, id, fromVersion))?.snapshot : null;
    const to = toVersion === Number(policy.rows[0].version)
      ? policy.rows[0]
      : (await getVersion(pool, id, toVersion))?.snapshot;
    if (!to) return res.status(404).json({ error: '版本不存在' });
    res.json({ from: fromVersion || null, to: toVersion, diff: diffSnapshots(from, to) });
  } catch (error) {
    handleError(res, error, 'diff');
  }
});

// ==================== 策略 CRUD ====================

router.post('/policies/preview', async (req, res) => {
  try {
    const draft = normalizePolicyInput({ ...(req.body?.policy || {}), name: req.body?.policy?.name || '预览策略' });
    const sample = req.body?.sample || {};
    const compiled = compilePolicy({ ...draft, id: 0, _compiled: null });
    const now = sample.at ? new Date(sample.at) : new Date();
    const ctx = {
      identity: {
        harness: sample.client || 'claude_code',
        protocol: sample.protocol || 'anthropic',
        method: sample.method || 'POST',
        path: sample.path || '/v1/messages',
        stream: sample.stream === true,
        userAgent: sample.user_agent || '',
      },
      request: {
        model: sample.model || 'claude-fable-5',
        modelCandidates: sample.models || [sample.model || 'claude-fable-5'],
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
      network: { ip: sample.ip || '127.0.0.1' },
      now,
      getPromptCorpus: () => String(sample.prompt || ''),
    };
    const result = await matchPolicy(compiled, ctx, {
      queryUsage: async () => Number(sample.usage_value || 0),
    });
    res.json({ match: result.match, reasons: result.reasons, decision: draft });
  } catch (error) {
    handleError(res, error, 'preview');
  }
});

router.get('/policies/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [policy, versions, hits] = await Promise.all([
      pool.query('SELECT * FROM access_policies WHERE id = $1', [id]),
      pool.query('SELECT id, version, change_summary, changed_by, created_at FROM policy_versions WHERE policy_id = $1 ORDER BY version DESC LIMIT 50', [id]),
      pool.query(`SELECT h.*, u.username FROM policy_hits h LEFT JOIN users u ON u.id = h.user_id
        WHERE h.policy_id = $1 ORDER BY h.created_at DESC LIMIT 50`, [id]),
    ]);
    if (!policy.rows.length) return res.status(404).json({ error: '策略不存在' });
    if (!await canReadPolicy(req, policy.rows[0])) return res.status(403).json({ error: '无权访问该策略' });
    res.json({ policy: policy.rows[0], versions: versions.rows, recent_hits: hits.rows });
  } catch (error) {
    handleError(res, error, 'detail');
  }
});

router.post('/policies', async (req, res) => {
  const client = await pool.connect();
  try {
    const input = normalizePolicyInput(req.body || {});
    await ensureScope(input.scope_type, input.scope_id);
    if (!await ensureScopeAllowed(req, input.scope_type, input.scope_id, { write: true })) {
      return res.status(403).json({ error: '无权在该作用域创建策略' });
    }
    if (input.scope_type !== 'global') {
      const teamId = input.scope_type === 'team'
        ? input.scope_id
        : (await pool.query('SELECT team_id FROM users WHERE id = $1', [input.scope_id])).rows[0]?.team_id;
      if (teamId) {
        const [limit, count] = await Promise.all([teamPolicyLimit(teamId), countTeamPolicies(teamId)]);
        if (count >= limit) return res.status(409).json({ error: `该 Team 策略数量已达上限 ${limit}`, code: 'policy_limit_exceeded' });
      }
    }
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO access_policies (
        name, description, scope_type, scope_id, effect, action, action_options, ladder,
        priority, category, conditions, status, version, group_id, tags, rollout_percent,
        status_code, message_template, notify_channels, starts_at, ends_at, bypass_until, enabled,
        created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$24)
      RETURNING *`,
      [
        input.name, input.description, input.scope_type, input.scope_id, input.effect, input.action,
        JSON.stringify(input.action_options || {}), JSON.stringify(input.ladder || []),
        input.priority, input.category, JSON.stringify(input.conditions || {}), input.status,
        input.version || 1, input.group_id || null, input.tags || [], input.rollout_percent,
        input.status_code, input.message_template, JSON.stringify(input.notify_channels || {}),
        input.starts_at, input.ends_at, input.bypass_until, input.enabled,
        actor(req).id || null,
      ]
    );
    const policy = result.rows[0];
    if (input.auto_publish_at !== undefined) {
      await client.query('UPDATE access_policies SET auto_publish_at = $2 WHERE id = $1', [policy.id, input.auto_publish_at]);
      policy.auto_publish_at = input.auto_publish_at;
    }
    await saveVersion(client, policy, '创建策略', actor(req).id);
    await client.query('COMMIT');
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_CREATE, 'policy', policy.id, `创建策略「${policy.name}」`, { policy });
    res.json(policy);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    handleError(res, error, 'create');
  } finally {
    client.release();
  }
});

router.put('/policies/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const existing = await client.query('SELECT * FROM access_policies WHERE id = $1 FOR UPDATE', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: '策略不存在' });
    const current = existing.rows[0];
    if (!await canWritePolicy(req, current)) return res.status(403).json({ error: '无权修改该策略' });
    const merged = {
      ...current,
      ...req.body,
      conditions: req.body.conditions !== undefined ? req.body.conditions : current.conditions,
      scope_type: req.body.scope_type !== undefined ? req.body.scope_type : current.scope_type,
      scope_id: req.body.scope_id !== undefined ? req.body.scope_id : current.scope_id,
    };
    const input = normalizePolicyInput(merged);
    await ensureScope(input.scope_type, input.scope_id);
    if (!await ensureScopeAllowed(req, input.scope_type, input.scope_id, { write: true })) {
      return res.status(403).json({ error: '无权在该作用域修改策略' });
    }
    const nextVersion = Number(current.version) + 1;
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE access_policies SET
        name=$1, description=$2, scope_type=$3, scope_id=$4, effect=$5, action=$6,
        action_options=$7::jsonb, ladder=$8::jsonb, priority=$9, category=$10,
        conditions=$11::jsonb, status=$12, version=$13, group_id=$14, tags=$15,
        rollout_percent=$16, status_code=$17, message_template=$18, notify_channels=$19::jsonb,
        starts_at=$20, ends_at=$21, bypass_until=$22, enabled=$23, updated_by=$24,
        updated_at=NOW()
       WHERE id=$25 RETURNING *`,
      [
        input.name, input.description, input.scope_type, input.scope_id, input.effect, input.action,
        JSON.stringify(input.action_options || {}), JSON.stringify(input.ladder || []),
        input.priority, input.category, JSON.stringify(input.conditions || {}), input.status,
        nextVersion, input.group_id || null, input.tags || [], input.rollout_percent,
        input.status_code, input.message_template, JSON.stringify(input.notify_channels || {}),
        input.starts_at, input.ends_at, input.bypass_until, input.enabled, actor(req).id || null, id,
      ]
    );
    const policy = result.rows[0];
    if (input.auto_publish_at !== undefined) {
      await client.query('UPDATE access_policies SET auto_publish_at = $2 WHERE id = $1', [policy.id, input.auto_publish_at]);
      policy.auto_publish_at = input.auto_publish_at;
    }
    await saveVersion(client, policy, '更新策略', actor(req).id);
    await client.query('COMMIT');
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_UPDATE, 'policy', id, `更新策略「${policy.name}」`, { policy, before: current });
    res.json(policy);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    handleError(res, error, 'update');
  } finally {
    client.release();
  }
});

router.delete('/policies/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM access_policies WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: '策略不存在' });
    const policy = existing.rows[0];
    if (!await canWritePolicy(req, policy)) return res.status(403).json({ error: '无权删除该策略' });
    let teamId = null;
    if (policy.scope_type === 'team') teamId = policy.scope_id;
    if (policy.scope_type === 'member') {
      const member = await pool.query('SELECT team_id FROM users WHERE id = $1', [policy.scope_id]);
      teamId = member.rows[0]?.team_id || null;
    }
    const settings = resolveSettings(await getPolicySnapshot(), teamId);
    if (settings.require_approval_for_delete) {
      const approval = await createApproval(pool, {
        kind: 'change', policyId: id, requestedBy: actor(req).id || null,
        payload: { action: 'delete', policy_id: id, team_id: teamId },
        preview: { name: policy.name, scope_type: policy.scope_type },
      });
      audit(req, ACTIONS.POLICY_DELETE, 'policy', id, `提交删除审批「${policy.name}」`, { approval_id: approval.id });
      return res.status(202).json({ pending_approval: true, approval_id: approval.id });
    }
    const result = await pool.query('DELETE FROM access_policies WHERE id = $1 RETURNING *', [id]);
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_DELETE, 'policy', id, `删除策略「${result.rows[0].name}」`, { policy: result.rows[0] });
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'delete');
  }
});

router.post('/policies/bulk', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    const operation = String(req.body?.operation || '');
    if (!ids.length) return res.status(400).json({ error: '缺少策略 ID' });
    if (req.policyTeamIds) {
      const targets = await pool.query('SELECT * FROM access_policies WHERE id = ANY($1)', [ids]);
      for (const target of targets.rows) {
        if (!await canWritePolicy(req, target)) return res.status(403).json({ error: `无权操作策略「${target.name}」` });
      }
    }
    let result;
    if (operation === 'enable' || operation === 'disable') {
      result = await pool.query('UPDATE access_policies SET enabled = $1, updated_at = NOW() WHERE id = ANY($2) RETURNING id', [operation === 'enable', ids]);
    } else if (operation === 'delete') {
      result = await pool.query('DELETE FROM access_policies WHERE id = ANY($1) RETURNING id', [ids]);
    } else if (operation === 'priority') {
      const priority = Math.min(1000, Math.max(0, Number(req.body?.priority) || 100));
      result = await pool.query('UPDATE access_policies SET priority = $1, updated_at = NOW() WHERE id = ANY($2) RETURNING id', [priority, ids]);
    } else {
      return res.status(400).json({ error: '不支持的操作' });
    }
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_BULK, 'policy', null, `批量${operation}策略`, { ids, operation });
    res.json({ success: true, affected: result.rowCount });
  } catch (error) {
    handleError(res, error, 'bulk');
  }
});

router.post('/policies/:id/duplicate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const source = await pool.query('SELECT * FROM access_policies WHERE id = $1', [id]);
    if (!source.rows.length) return res.status(404).json({ error: '策略不存在' });
    const row = source.rows[0];
    if (!await canWritePolicy(req, row)) return res.status(403).json({ error: '无权复制该策略' });
    const result = await pool.query(
      `INSERT INTO access_policies (
        name, description, scope_type, scope_id, effect, action, action_options, ladder,
        priority, category, conditions, status, version, group_id, tags, rollout_percent,
        status_code, message_template, notify_channels, starts_at, ends_at, enabled, created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,1,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$22)
      RETURNING *`,
      [
        `${row.name}（副本）`, row.description, row.scope_type, row.scope_id, row.effect, row.action,
        JSON.stringify(row.action_options || {}), JSON.stringify(row.ladder || []), row.priority,
        row.category, JSON.stringify(row.conditions || {}), 'draft', row.group_id, row.tags,
        row.rollout_percent, row.status_code, row.message_template, JSON.stringify(row.notify_channels || {}),
        row.starts_at, row.ends_at, false, actor(req).id || null,
      ]
    );
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_CREATE, 'policy', result.rows[0].id, `复制策略「${row.name}」`, { source_id: id });
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'duplicate');
  }
});

router.post('/policies/from-template', async (req, res) => {
  try {
    const template = getTemplate(String(req.body?.key || ''));
    if (!template) return res.status(404).json({ error: '模板不存在' });
    const scopeType = req.body?.scope_type || template.scope_type || 'team';
    const scopeId = scopeType === 'global' ? null : Number(req.body?.scope_id);
    if (scopeType !== 'global' && !scopeId) return res.status(400).json({ error: '请选择 Team 或成员' });
    const input = normalizePolicyInput({
      ...template,
      name: String(req.body?.name || template.name).slice(0, 120),
      scope_type: scopeType,
      scope_id: scopeId,
      status: 'published',
      enabled: true,
    });
    await ensureScope(input.scope_type, input.scope_id);
    if (!await ensureScopeAllowed(req, input.scope_type, input.scope_id, { write: true })) {
      return res.status(403).json({ error: '无权在该作用域创建策略' });
    }
    const result = await pool.query(
      `INSERT INTO access_policies (
        name, description, scope_type, scope_id, effect, action, action_options, ladder,
        priority, category, conditions, status, version, tags, rollout_percent,
        status_code, message_template, notify_channels, enabled, created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,1,$13,$14,$15,$16,$17::jsonb,$18,$19,$19)
      RETURNING *`,
      [
        input.name, input.description, input.scope_type, input.scope_id, input.effect, input.action,
        JSON.stringify(input.action_options || {}), JSON.stringify(input.ladder || []),
        input.priority, input.category, JSON.stringify(input.conditions || {}), input.status,
        input.tags || [], input.rollout_percent, input.status_code, input.message_template,
        JSON.stringify(input.notify_channels || {}), input.enabled, actor(req).id || null,
      ]
    );
    if (template.settings?.allowlist_dimensions && input.scope_type === 'team') {
      const current = await pool.query('SELECT allowlist_dimensions FROM policy_settings WHERE team_id = $1', [input.scope_id]);
      const dimensions = new Set([...(current.rows[0]?.allowlist_dimensions || []), ...template.settings.allowlist_dimensions]);
      await upsertSettings(input.scope_id, { allowlist_dimensions: [...dimensions] });
    }
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_CREATE, 'policy', result.rows[0].id, `从模板创建策略「${result.rows[0].name}」`, { template: template.key });
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'from-template');
  }
});

// ==================== 命中记录 ====================

router.get('/policy-hits', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req, 50);
    const params = [];
    const where = [];
    if (req.policyTeamIds) {
      params.push(req.policyTeamIds);
      where.push(`h.team_id = ANY($${params.length}::int[])`);
    }
    const add = (column, value) => { params.push(value); where.push(`${column} = $${params.length}`); };
    if (req.query.policy_id) add('h.policy_id', Number(req.query.policy_id));
    if (req.query.user_id) add('h.user_id', Number(req.query.user_id));
    if (req.query.team_id) add('h.team_id', Number(req.query.team_id));
    if (req.query.request_source) add('h.request_source', req.query.request_source);
    if (req.query.action) add('h.action', req.query.action);
    if (req.query.effect) add('h.effect', req.query.effect);
    if (req.query.decision) add('h.decision', req.query.decision);
    if (req.query.from) { params.push(new Date(req.query.from)); where.push(`h.created_at >= $${params.length}`); }
    if (req.query.to) { params.push(new Date(req.query.to)); where.push(`h.created_at <= $${params.length}`); }
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(u.username ILIKE $${params.length} OR h.policy_name ILIKE $${params.length})`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      pool.query(`SELECT h.*, u.username, t.name AS team_name
        FROM policy_hits h
        LEFT JOIN users u ON u.id = h.user_id
        LEFT JOIN teams t ON t.id = h.team_id
        ${whereSql}
        ORDER BY h.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS total FROM policy_hits h LEFT JOIN users u ON u.id = h.user_id ${whereSql}`, params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].total, page, limit });
  } catch (error) {
    handleError(res, error, 'hits');
  }
});

router.get('/policy-hits/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  const unsubscribe = subscribe(event => {
    if (req.policyTeamIds && !req.policyTeamIds.includes(Number(event.team_id))) return;
    try { res.write(`event: hit\ndata: ${JSON.stringify(event)}\n\n`); } catch (_) { /* ignore */ }
  });
  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (_) { /* ignore */ }
  }, 25000);
  keepAlive.unref?.();
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});

router.get('/policy-hits/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT h.*, u.username FROM policy_hits h LEFT JOIN users u ON u.id = h.user_id WHERE h.id = $1`, [Number(req.params.id)]);
    if (!result.rows.length) return res.status(404).json({ error: '记录不存在' });
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'hit-detail');
  }
});

// ==================== 成员 ====================

router.get('/policy-members', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req, 50);
    const params = [];
    const where = [];
    if (req.policyTeamIds) {
      params.push(req.policyTeamIds);
      where.push(`u.team_id = ANY($${params.length}::int[])`);
    }
    if (req.query.team_id) { params.push(Number(req.query.team_id)); where.push(`u.team_id = $${params.length}`); }
    if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
    if (req.query.status === 'suspended') where.push(`u.suspended_at IS NOT NULL AND (u.suspended_until IS NULL OR u.suspended_until > NOW())`);
    if (req.query.status === 'active') where.push(`(u.suspended_at IS NULL OR (u.suspended_until IS NOT NULL AND u.suspended_until <= NOW()))`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      pool.query(`SELECT u.id, u.username, u.email, u.team_id, u.is_admin, u.tags,
          u.suspended_at, u.suspended_until, u.suspended_reason, u.suspended_scope,
          u.policy_bypass, u.policy_bypass_until,
          t.name AS team_name,
          (SELECT role FROM user_teams ut WHERE ut.user_id = u.id AND ut.team_id = u.team_id LIMIT 1) AS team_role,
          (SELECT COUNT(*) FROM access_policies p WHERE p.scope_type = 'member' AND p.scope_id = u.id AND p.enabled)::int AS policy_count,
          (SELECT COUNT(*) FROM policy_hits h WHERE h.user_id = u.id AND h.created_at >= NOW() - INTERVAL '24 hours')::int AS hits_24h,
          (SELECT MAX(h.created_at) FROM policy_hits h WHERE h.user_id = u.id) AS last_hit_at
        FROM users u
        LEFT JOIN teams t ON t.id = u.team_id
        ${whereSql}
        ORDER BY u.suspended_at DESC NULLS LAST, u.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS total FROM users u ${whereSql}`, params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].total, page, limit });
  } catch (error) {
    handleError(res, error, 'members');
  }
});

router.post('/policy-members/:userId/suspend', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const me = actor(req);
    if (userId === Number(me.id)) return res.status(400).json({ error: '不能暂停自己' });
    const target = await pool.query('SELECT id, username, email, team_id, is_admin FROM users WHERE id = $1', [userId]);
    if (!target.rows.length) return res.status(404).json({ error: '成员不存在' });
    if (!await canAccessSubject(req, 'user', userId)) return res.status(403).json({ error: '无权操作该成员' });
    if (target.rows[0].is_admin && process.env.CR_ALLOW_SUSPEND_ADMIN !== 'true') {
      return res.status(400).json({ error: '默认不允许暂停管理员；如需允许请设置 CR_ALLOW_SUSPEND_ADMIN=true' });
    }
    const durationSeconds = req.body?.duration_seconds != null ? Number(req.body.duration_seconds) : null;
    let until = req.body?.until ? new Date(req.body.until) : null;
    if (durationSeconds != null) {
      if (!Number.isFinite(durationSeconds) || durationSeconds < 60 || durationSeconds > 315360000) {
        return res.status(400).json({ error: '暂停时长需在 1 分钟到 10 年之间' });
      }
      until = new Date(Date.now() + durationSeconds * 1000);
    }
    if (until && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) {
      return res.status(400).json({ error: '暂停截止时间必须在未来' });
    }
    const scope = req.body?.scope === 'api' ? 'api' : 'all';
    await suspendUser(pool, {
      userId,
      until,
      reason: String(req.body?.reason || '').slice(0, 2000),
      scope,
      by: me.id || null,
    });
    invalidateSuspensionCache(userId);
    invalidateUserKeyCache(userId);
    recordHit({
      policy_id: null, policy_name: '成员暂停', policy_version: null,
      effect: 'deny', action: 'block', decision: 'block', scope_type: 'member', scope_id: userId,
      team_id: target.rows[0].team_id, user_id: userId, api_key_id: null,
      request_source: null, request_semantics: null, protocol: null,
      requested_model: null, resolved_model: null, provider_id: null, ip: null,
      user_agent: null, method: null, path: null, status_code: 403,
      reason: 'member_suspended', matched_conditions: '{}', request_id: null, eval_ms: null,
      metadata: JSON.stringify({ suspended_by: me.id || null, until: until?.toISOString() || null }),
    });
    if (req.body?.notify !== false) notifyMemberAsync(userId, '账号已被暂停', `原因：${req.body?.reason || '未填写'}`);
    audit(req, ACTIONS.POLICY_MEMBER_SUSPEND, 'user', userId, `暂停成员「${target.rows[0].username}」`, { until, reason: req.body?.reason, scope });
    const state = suspensionState({ suspended_at: new Date(), suspended_until: until, suspended_reason: req.body?.reason, suspended_scope: scope });
    res.json({ success: true, state });
  } catch (error) {
    handleError(res, error, 'suspend');
  }
});

router.post('/policy-members/:userId/resume', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!await canAccessSubject(req, 'user', userId)) return res.status(403).json({ error: '无权操作该成员' });
    await resumeUser(pool, userId);
    invalidateSuspensionCache(userId);
    invalidateUserKeyCache(userId);
    if (req.body?.notify !== false) notifyMemberAsync(userId, '账号已恢复', '你的访问已由管理员恢复。');
    audit(req, ACTIONS.POLICY_MEMBER_RESUME, 'user', userId, `恢复成员 #${userId}`);
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'resume');
  }
});

router.post('/policy-members/:userId/bypass', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!await canAccessSubject(req, 'user', userId)) return res.status(403).json({ error: '无权操作该成员' });
    const enabled = req.body?.enabled !== false;
    const until = req.body?.until ? new Date(req.body.until) : null;
    await pool.query(
      `UPDATE users SET policy_bypass = $2, policy_bypass_until = $3, updated_at = NOW() WHERE id = $1`,
      [userId, enabled, until]
    );
    invalidateUserKeyCache(userId);
    audit(req, ACTIONS.POLICY_MEMBER_BYPASS, 'user', userId, `${enabled ? '开启' : '关闭'}成员策略豁免`, { until });
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'bypass');
  }
});

router.get('/policy-login-events', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.policyTeamIds) {
      params.push(req.policyTeamIds);
      where.push(`user_id IN (SELECT id FROM users WHERE team_id = ANY($${params.length}::int[]))`);
    }
    if (req.query.user_id) { params.push(Number(req.query.user_id)); where.push(`user_id = $${params.length}`); }
    if (req.query.success === 'true' || req.query.success === 'false') { params.push(req.query.success === 'true'); where.push(`success = $${params.length}`); }
    params.push(Math.min(500, Math.max(1, Number(req.query.limit) || 100)));
    const result = await pool.query(
      `SELECT e.*, u.username FROM login_events e LEFT JOIN users u ON u.id = e.user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    handleError(res, error, 'login-events');
  }
});

// ==================== 例外与豁免 ====================

router.get('/policy-exemptions', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req, 50);
    const params = [];
    const where = [];
    if (req.policyTeamIds) {
      params.push(req.policyTeamIds);
      where.push(`(((e.subject_type = 'user' AND e.subject_id IN (SELECT id FROM users WHERE team_id = ANY($${params.length}::int[]))) OR (e.subject_type = 'team' AND e.subject_id = ANY($${params.length}::int[])) OR (e.subject_type = 'api_key' AND e.subject_id IN (SELECT ak.id FROM api_keys ak JOIN users au ON au.id = ak.user_id WHERE au.team_id = ANY($${params.length}::int[])))))`);
    }
    if (req.query.policy_id) { params.push(Number(req.query.policy_id)); where.push(`e.policy_id = $${params.length}`); }
    if (req.query.user_id) { params.push(Number(req.query.user_id)); where.push(`(e.subject_type = 'user' AND e.subject_id = $${params.length})`); }
    if (req.query.status) { params.push(req.query.status); where.push(`e.status = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      pool.query(
        `SELECT e.*, p.name AS policy_name,
                CASE WHEN e.subject_type = 'user' THEN u.username ELSE NULL END AS username,
                g.username AS granted_by_name
           FROM policy_exemptions e
           LEFT JOIN access_policies p ON p.id = e.policy_id
           LEFT JOIN users u ON u.id = e.subject_id AND e.subject_type = 'user'
           LEFT JOIN users g ON g.id = e.granted_by
           ${whereSql}
           ORDER BY e.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM policy_exemptions e ${whereSql}`, params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].total, page, limit });
  } catch (error) {
    handleError(res, error, 'exemptions');
  }
});

router.post('/policy-exemptions', async (req, res) => {
  try {
    const subjectType = String(req.body?.subject_type || 'user');
    if (!['user', 'team', 'api_key'].includes(subjectType)) return res.status(400).json({ error: '不支持的主体类型' });
    const subjectId = Number(req.body?.subject_id);
    if (!subjectId) return res.status(400).json({ error: '缺少主体 ID' });
    const policyId = req.body?.policy_id ? Number(req.body.policy_id) : null;
    if (!await canAccessSubject(req, subjectType, subjectId)) return res.status(403).json({ error: '无权为该主体创建豁免' });
    if (policyId) {
      const target = await pool.query('SELECT * FROM access_policies WHERE id = $1', [policyId]);
      if (!target.rows.length) return res.status(404).json({ error: '策略不存在' });
      if (!await canWritePolicy(req, target.rows[0])) return res.status(403).json({ error: '无权为该策略创建豁免' });
    }
    const endsAt = req.body?.ends_at ? new Date(req.body.ends_at) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) return res.status(400).json({ error: '结束时间无效' });
    const result = await pool.query(
      `INSERT INTO policy_exemptions (policy_id, subject_type, subject_id, reason, status, ends_at, max_uses, granted_by)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7) RETURNING *`,
      [policyId, subjectType, subjectId, String(req.body?.reason || '').slice(0, 2000), endsAt,
        req.body?.max_uses ? Number(req.body.max_uses) : null, actor(req).id || null]
    );
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_EXEMPTION_CREATE, 'policy_exemption', result.rows[0].id, `创建策略豁免`, result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'exemption-create');
  }
});

router.delete('/policy-exemptions/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM policy_exemptions WHERE id = $1', [Number(req.params.id)]);
    if (!existing.rows.length) return res.status(404).json({ error: '豁免不存在' });
    const exemption = existing.rows[0];
    if (!await canAccessSubject(req, exemption.subject_type, exemption.subject_id)) {
      return res.status(403).json({ error: '无权撤销该豁免' });
    }
    const result = await pool.query(
      `UPDATE policy_exemptions SET status = 'revoked' WHERE id = $1 RETURNING *`,
      [Number(req.params.id)]
    );
    if (!result.rows.length) return res.status(404).json({ error: '豁免不存在' });
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_EXEMPTION_REVOKE, 'policy_exemption', req.params.id, '撤销策略豁免');
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'exemption-revoke');
  }
});

router.post('/policy-exemptions/from-hit/:hitId', async (req, res) => {
  try {
    const hit = await pool.query('SELECT * FROM policy_hits WHERE id = $1', [Number(req.params.hitId)]);
    if (!hit.rows.length) return res.status(404).json({ error: '命中记录不存在' });
    const row = hit.rows[0];
    if (!row.user_id) return res.status(400).json({ error: '命中记录缺少成员' });
    if (!await canAccessSubject(req, 'user', row.user_id)) return res.status(403).json({ error: '无权为该成员创建豁免' });
    const hours = Math.min(720, Math.max(1, Number(req.body?.hours) || 24));
    const result = await pool.query(
      `INSERT INTO policy_exemptions (policy_id, subject_type, subject_id, reason, status, ends_at, max_uses, granted_by)
       VALUES ($1, 'user', $2, $3, 'active', NOW() + ($4::int * INTERVAL '1 hour'), $5, $6) RETURNING *`,
      [row.policy_id, row.user_id, `从命中记录 #${row.id} 一键豁免`, hours,
        req.body?.max_uses ? Number(req.body.max_uses) : null, actor(req).id || null]
    );
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_EXEMPTION_CREATE, 'policy_exemption', result.rows[0].id, '从命中记录创建豁免', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'exemption-from-hit');
  }
});

// ==================== 申诉 ====================

router.get('/policy-appeals', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req, 50);
    const params = [];
    const where = [];
    if (req.policyTeamIds) {
      params.push(req.policyTeamIds);
      where.push(`a.user_id IN (SELECT id FROM users WHERE team_id = ANY($${params.length}::int[]))`);
    }
    if (req.query.status) { params.push(req.query.status); where.push(`a.status = $${params.length}`); }
    if (req.query.user_id) { params.push(Number(req.query.user_id)); where.push(`a.user_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      pool.query(
        `SELECT a.*, p.name AS policy_name, u.username, h.reason AS hit_reason, h.action AS hit_action
           FROM policy_appeals a
           LEFT JOIN access_policies p ON p.id = a.policy_id
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN policy_hits h ON h.id = a.hit_id
           ${whereSql}
           ORDER BY a.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM policy_appeals a ${whereSql}`, params),
    ]);
    res.json({ items: items.rows, total: total.rows[0].total, page, limit });
  } catch (error) {
    handleError(res, error, 'appeals');
  }
});

router.post('/policy-appeals/:id/decide', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const decision = String(req.body?.decision || '');
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision 必须是 approve 或 reject' });
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM policy_appeals WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rows.length) throw Object.assign(new Error('申诉不存在'), { status: 404 });
    const appeal = current.rows[0];
    if (appeal.status !== 'pending') throw Object.assign(new Error(`申诉已处理：${appeal.status}`), { status: 409 });
    if (!await canAccessSubject(req, 'user', appeal.user_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '无权处理该申诉' });
    }
    let exemptionId = null;
    if (decision === 'approve') {
      const hours = Math.min(720, Math.max(1, Number(req.body?.hours) || 24));
      const exemption = await client.query(
        `INSERT INTO policy_exemptions (policy_id, subject_type, subject_id, reason, status, ends_at, max_uses, granted_by)
         VALUES ($1, 'user', $2, $3, 'active', NOW() + ($4::int * INTERVAL '1 hour'), NULL, $5) RETURNING *`,
        [appeal.policy_id, appeal.user_id, `申诉 #${id} 通过：${String(req.body?.resolution || '').slice(0, 500)}`, hours, actor(req).id || null]
      );
      exemptionId = exemption.rows[0].id;
    }
    const updated = await client.query(
      `UPDATE policy_appeals SET status = $2, resolution = $3, assigned_to = $4, exemption_id = $5, resolved_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, decision === 'approve' ? 'approved' : 'rejected', String(req.body?.resolution || '').slice(0, 2000),
        actor(req).id || null, exemptionId]
    );
    await client.query('COMMIT');
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_APPEAL_DECIDE, 'policy_appeal', id, `申诉${decision === 'approve' ? '通过' : '驳回'}`, { exemption_id: exemptionId });
    res.json(updated.rows[0]);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    handleError(res, error, 'appeal-decide');
  } finally {
    client.release();
  }
});

// ==================== 审批中心 ====================

router.get('/policy-approvals', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req, 50);
    const result = await listApprovals(pool, {
      status: req.query.status || null,
      kind: req.query.kind || null,
      limit,
      offset,
    });
    if (req.policyTeamIds) {
      result.items = result.items.filter(item => req.policyTeamIds.includes(Number(item.payload?.team_id)));
      result.total = result.items.length;
    }
    res.json({ ...result, page, limit });
  } catch (error) {
    handleError(res, error, 'approvals');
  }
});

router.post('/policy-approvals/:id/decide', async (req, res) => {
  try {
    const decision = String(req.body?.decision || '');
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision 必须是 approve 或 reject' });
    if (req.policyTeamIds) {
      const approval = await pool.query('SELECT payload FROM policy_approvals WHERE id = $1', [Number(req.params.id)]);
      if (!approval.rows.length) return res.status(404).json({ error: '审批不存在' });
      if (!req.policyTeamIds.includes(Number(approval.rows[0].payload?.team_id))) {
        return res.status(403).json({ error: '无权处理该审批' });
      }
    }
    const result = await decideApproval({
      id: Number(req.params.id),
      approverId: actor(req).id || null,
      decision,
      note: req.body?.note || '',
    });
    audit(req, ACTIONS.POLICY_APPROVAL_DECIDE, 'policy_approval', req.params.id, `审批${decision === 'approve' ? '通过' : '驳回'}`, { applied: result.applied });
    res.json(result);
  } catch (error) {
    handleError(res, error, 'approval-decide');
  }
});

// ==================== 通知渠道与告警规则 ====================

router.use(['/policy-channels', '/policy-alert-rules'], (req, res, next) => {
  if (!requireGlobalPolicyAdmin(req, res)) return;
  next();
});

router.get('/policy-channels', async (req, res) => {
  try {
    res.json(await channels.listChannels(pool));
  } catch (error) {
    handleError(res, error, 'channels');
  }
});

router.post('/policy-channels', async (req, res) => {
  try {
    const channel = await channels.createChannel(pool, req.body || {}, actor(req).id);
    invalidateAlertConfigCache();
    audit(req, ACTIONS.POLICY_CHANNEL_UPDATE, 'policy_channel', channel.id, `创建告警渠道「${channel.name}」`);
    res.json(channel);
  } catch (error) {
    handleError(res, error, 'channel-create');
  }
});

router.put('/policy-channels/:id', async (req, res) => {
  try {
    const channel = await channels.updateChannel(pool, Number(req.params.id), req.body || {});
    invalidateAlertConfigCache();
    audit(req, ACTIONS.POLICY_CHANNEL_UPDATE, 'policy_channel', channel.id, `更新告警渠道「${channel.name}」`);
    res.json(channel);
  } catch (error) {
    handleError(res, error, 'channel-update');
  }
});

router.delete('/policy-channels/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM policy_channels WHERE id = $1', [Number(req.params.id)]);
    invalidateAlertConfigCache();
    audit(req, ACTIONS.POLICY_CHANNEL_UPDATE, 'policy_channel', req.params.id, '删除告警渠道');
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'channel-delete');
  }
});

router.post('/policy-channels/:id/test', async (req, res) => {
  try {
    res.json(await channels.testChannel(pool, Number(req.params.id)));
  } catch (error) {
    handleError(res, error, 'channel-test');
  }
});

router.get('/policy-alert-rules', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM policy_alert_rules ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    handleError(res, error, 'alert-rules');
  }
});

router.post('/policy-alert-rules', async (req, res) => {
  try {
    const input = req.body || {};
    const result = await pool.query(
      `INSERT INTO policy_alert_rules (name, event_type, severity, channel_ids, aggregate_window_seconds, silence_window_seconds, template, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        String(input.name || '告警规则').slice(0, 80),
        String(input.event_type || 'hit').slice(0, 32),
        ['info', 'warning', 'critical'].includes(input.severity) ? input.severity : 'warning',
        Array.isArray(input.channel_ids) ? input.channel_ids.map(Number).filter(Number.isInteger) : [],
        Math.max(30, Number(input.aggregate_window_seconds) || 300),
        Math.max(30, Number(input.silence_window_seconds) || 300),
        String(input.template || '').slice(0, 2000),
        input.enabled !== false,
        actor(req).id || null,
      ]
    );
    invalidateAlertConfigCache();
    audit(req, ACTIONS.POLICY_CHANNEL_UPDATE, 'policy_alert_rule', result.rows[0].id, `创建告警规则「${result.rows[0].name}」`);
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'alert-rule-create');
  }
});

router.put('/policy-alert-rules/:id', async (req, res) => {
  try {
    const input = req.body || {};
    const result = await pool.query(
      `UPDATE policy_alert_rules SET name = COALESCE($2, name), event_type = COALESCE($3, event_type),
         severity = COALESCE($4, severity), channel_ids = COALESCE($5, channel_ids),
         aggregate_window_seconds = COALESCE($6, aggregate_window_seconds),
         silence_window_seconds = COALESCE($7, silence_window_seconds),
         template = COALESCE($8, template), enabled = COALESCE($9, enabled)
       WHERE id = $1 RETURNING *`,
      [
        Number(req.params.id), input.name, input.event_type, input.severity,
        Array.isArray(input.channel_ids) ? input.channel_ids.map(Number).filter(Number.isInteger) : null,
        input.aggregate_window_seconds != null ? Math.max(30, Number(input.aggregate_window_seconds)) : null,
        input.silence_window_seconds != null ? Math.max(30, Number(input.silence_window_seconds)) : null,
        input.template, input.enabled != null ? input.enabled !== false : null,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: '规则不存在' });
    invalidateAlertConfigCache();
    res.json(result.rows[0]);
  } catch (error) {
    handleError(res, error, 'alert-rule-update');
  }
});

router.delete('/policy-alert-rules/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM policy_alert_rules WHERE id = $1', [Number(req.params.id)]);
    invalidateAlertConfigCache();
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'alert-rule-delete');
  }
});

// ==================== 成员角色 ====================

router.post('/policy-members/:userId/offboard', async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.userId);
    if (!await canAccessSubject(req, 'user', userId)) return res.status(403).json({ error: '无权操作该成员' });
    const target = await client.query('SELECT id, username, is_admin FROM users WHERE id = $1', [userId]);
    if (!target.rows.length) return res.status(404).json({ error: '成员不存在' });
    if (target.rows[0].is_admin && process.env.CR_ALLOW_SUSPEND_ADMIN !== 'true') {
      return res.status(400).json({ error: '默认不允许停用管理员' });
    }
    await client.query('BEGIN');
    await suspendUser(client, {
      userId,
      until: null,
      reason: String(req.body?.reason || '离岗/离职停用').slice(0, 2000),
      scope: 'all',
      by: actor(req).id || null,
    });
    const keys = await client.query('UPDATE api_keys SET enabled = FALSE WHERE user_id = $1 RETURNING id', [userId]);
    await client.query('UPDATE oauth_tokens SET revoked = TRUE WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('COMMIT');
    invalidateSuspensionCache(userId);
    invalidateUserKeyCache(userId);
    audit(req, ACTIONS.POLICY_MEMBER_SUSPEND, 'user', userId, `停用离岗成员「${target.rows[0].username}」`, { keys: keys.rowCount });
    res.json({ success: true, disabled_keys: keys.rowCount });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    handleError(res, error, 'offboard');
  } finally {
    client.release();
  }
});

router.post('/policy-members/:userId/role', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const teamId = Number(req.body?.team_id);
    const role = String(req.body?.role || '');
    if (!teamId) return res.status(400).json({ error: '缺少 team_id' });
    if (req.policyTeamIds && !req.policyTeamIds.includes(teamId)) return res.status(403).json({ error: '无权设置该 Team 角色' });
    if (!await canAccessSubject(req, 'user', userId)) return res.status(403).json({ error: '无权操作该成员' });
    if (!['owner', 'admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: '角色无效' });
    await pool.query(
      `INSERT INTO user_teams (user_id, team_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
      [userId, teamId, role]
    );
    audit(req, ACTIONS.POLICY_MEMBER_BYPASS, 'user', userId, `设置成员 Team 角色为 ${role}`, { team_id: teamId, role });
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'member-role');
  }
});

// ==================== 设置 ====================

router.get('/policy-settings', async (req, res) => {
  try {
    let teamId = req.query.team_id != null ? Number(req.query.team_id) : null;
    if (req.policyTeamIds) {
      if (teamId == null) teamId = req.policyTeamIds[0] || null;
      else if (!req.policyTeamIds.includes(teamId)) return res.status(403).json({ error: '无权访问该 Team 设置' });
    }
    const result = await pool.query(
      `SELECT * FROM policy_settings WHERE ${teamId == null ? 'team_id IS NULL' : 'team_id = $1'}`,
      teamId == null ? [] : [teamId]
    );
    const global = await pool.query('SELECT * FROM policy_settings WHERE team_id IS NULL');
    res.json({
      global: normalizeSettings(global.rows[0]),
      team: result.rows[0] ? { ...normalizeSettings(result.rows[0]), team_id: result.rows[0].team_id } : null,
    });
  } catch (error) {
    handleError(res, error, 'settings');
  }
});

router.put('/policy-settings', async (req, res) => {
  try {
    const teamId = req.body?.team_id != null ? Number(req.body.team_id) : null;
    if (req.policyTeamIds) {
      if (teamId == null) return res.status(403).json({ error: 'Team 管理员只能修改所属 Team 设置' });
      if (!req.policyTeamIds.includes(teamId)) return res.status(403).json({ error: '无权修改该 Team 设置' });
    }
    const input = normalizePolicySettingsInput(req.body || {});
    // 局部保存：未提交的字段保持原值，避免把紧急开关/审批开关等重置。
    for (const key of ['kill_switch', 'kill_switch_until', 'require_approval_for_publish', 'require_approval_for_delete', 'alert_email_enabled', 'alert_email_to', 'metrics_retention_days', 'max_policies_per_team']) {
      if (req.body?.[key] === undefined) delete input[key];
    }
    await upsertSettings(teamId, input, actor(req).id);
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_SETTINGS, 'policy_settings', teamId, '更新策略设置', input);
    res.json({ success: true, settings: { ...DEFAULT_SETTINGS, ...input } });
  } catch (error) {
    handleError(res, error, 'settings-update');
  }
});

router.post('/policy-settings/kill-switch', async (req, res) => {
  if (!requireGlobalPolicyAdmin(req, res)) return;
  try {
    const enabled = req.body?.enabled !== false;
    const until = req.body?.until ? new Date(req.body.until) : null;
    await upsertSettings(null, { kill_switch: enabled, kill_switch_until: until }, actor(req).id);
    invalidatePolicyCache();
    audit(req, ACTIONS.POLICY_KILL_SWITCH, 'policy_settings', null, `${enabled ? '开启' : '关闭'}策略紧急开关`, { until });
    res.json({ success: true, kill_switch: enabled, kill_switch_until: until });
  } catch (error) {
    handleError(res, error, 'kill-switch');
  }
});

// ==================== 客户端统计 ====================

router.get('/policy-clients', async (req, res) => {
  try {
    const range = req.query.range === '7d' ? '7 days' : '24 hours';
    const teams = req.policyTeamIds;
    const usageParams = [range];
    const hitParams = [range];
    let usageTeam = '';
    let hitTeam = '';
    if (teams) {
      usageParams.push(teams);
      hitParams.push(teams);
      usageTeam = 'AND uu.team_id = ANY($2::int[])';
      hitTeam = 'AND team_id = ANY($2::int[])';
    }
    const [usage, hits] = await Promise.all([
      pool.query(`SELECT u.request_source, COUNT(*)::int AS requests, SUM(u.tokens_used)::bigint AS tokens
        FROM usage_records u LEFT JOIN users uu ON uu.id = u.user_id
        WHERE u.created_at >= NOW() - $1::interval ${usageTeam}
        GROUP BY u.request_source`, usageParams),
      pool.query(`SELECT request_source, COUNT(*)::int AS hits,
          COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked
        FROM policy_hits WHERE created_at >= NOW() - $1::interval ${hitTeam}
        GROUP BY request_source`, hitParams),
    ]);
    const map = new Map();
    for (const row of usage.rows) {
      map.set(row.request_source || 'unknown', { request_source: row.request_source || 'unknown', requests: Number(row.requests), tokens: Number(row.tokens || 0), hits: 0, blocked: 0 });
    }
    for (const row of hits.rows) {
      const key = row.request_source || 'unknown';
      const entry = map.get(key) || { request_source: key, requests: 0, tokens: 0, hits: 0, blocked: 0 };
      entry.hits = Number(row.hits);
      entry.blocked = Number(row.blocked);
      map.set(key, entry);
    }
    const items = [...map.values()].map(row => ({ ...row, label: sourceLabel(row.request_source) }));
    items.sort((a, b) => b.requests - a.requests);
    res.json({ items });
  } catch (error) {
    handleError(res, error, 'clients');
  }
});

// ==================== helpers ====================

async function upsertSettings(teamId, input, by) {
  const columns = [
    'enforcement_mode', 'fail_mode', 'kill_switch', 'kill_switch_until', 'default_timezone',
    'allowlist_dimensions', 'require_approval_for_publish', 'require_approval_for_delete',
    'notify_admins', 'notify_member', 'alert_email_enabled', 'alert_email_to',
    'hit_retention_days', 'metrics_retention_days', 'max_policies_per_team'
  ];
  const existing = await pool.query(
    `SELECT id FROM policy_settings WHERE ${teamId == null ? 'team_id IS NULL' : 'team_id = $1'} LIMIT 1`,
    teamId == null ? [] : [teamId]
  );
  if (existing.rows.length) {
    const sets = [];
    const params = [];
    for (const column of columns) {
      if (input[column] === undefined) continue;
      params.push(column === 'allowlist_dimensions' ? JSON.stringify(input[column]) : input[column]);
      sets.push(`${column} = $${params.length}${column === 'allowlist_dimensions' ? '::jsonb' : ''}`);
    }
    params.push(by || null);
    sets.push(`updated_by = $${params.length}`);
    params.push(existing.rows[0].id);
    await pool.query(`UPDATE policy_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
  } else {
    const params = [teamId];
    const cols = ['team_id'];
    for (const column of columns) {
      if (input[column] === undefined) continue;
      params.push(column === 'allowlist_dimensions' ? JSON.stringify(input[column]) : input[column]);
      cols.push(`${column}${column === 'allowlist_dimensions' ? '::jsonb' : ''}`);
    }
    params.push(by || null);
    cols.push('updated_by');
    await pool.query(
      `INSERT INTO policy_settings (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      params
    );
  }
}

function invalidateUserKeyCache(userId) {
  try {
    const { invalidateUserApiKeyCache } = require('./api');
    invalidateUserApiKeyCache(userId);
  } catch (_) { /* ignore */ }
}

function notifyMemberAsync(userId, title, body) {
  try {
    const { createNotification } = require('../utils/notifications');
    createNotification(userId, 'policy_notice', title, body, {}).catch(() => {});
  } catch (_) { /* ignore */ }
}

module.exports = router;
