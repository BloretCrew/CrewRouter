const PERSONAL_CAPABILITIES = Object.freeze({
  // Personal keeps the individual AI workspace available; only collaboration is edition-gated.
  ai: true,
  modelLibrary: true,
  models: true,
  providers: true,
  personalProviders: true,
  playground: true,
  apiKeys: true,
  usage: true,
  adminStats: false,
  multiUser: false,
  teamMembers: false,
  teamAdmin: false,
  sharedApiKeys: false,
  projects: true,
  auditLogs: true,
  teamProjects: false,
  teamAuditLogs: false,
});
const TEAM_ONLY_CAPABILITIES = Object.freeze({
  ai: true,
  modelLibrary: true,
  models: true,
  providers: true,
  personalProviders: true,
  playground: true,
  apiKeys: true,
  usage: true,
  adminStats: true,
  multiUser: true,
  teamMembers: true,
  teamAdmin: true,
  sharedApiKeys: true,
  projects: true,
  auditLogs: true,
  teamProjects: true,
  teamAuditLogs: true,
});

function normalizeEdition(value) {
  if (typeof value !== 'string') return null;
  const edition = value.trim().toLowerCase();
  return edition === 'personal' || edition === 'team' ? edition : null;
}

function normalizeRuntime(value) {
  if (typeof value !== 'string' || !value.trim()) return 'server';
  const runtime = value.trim().toLowerCase();
  return runtime === 'server' || runtime === 'desktop-local' ? runtime : null;
}

function editionError(message, code = 'EDITION_INVALID') {
  return Object.assign(new Error(message), { code });
}

function getCapabilities(edition) {
  const normalized = normalizeEdition(edition);
  if (!normalized) throw editionError('实例 edition 未初始化或无效，请在首次设置中选择 personal 或 team');
  return { ...((normalized === 'team') ? TEAM_ONLY_CAPABILITIES : PERSONAL_CAPABILITIES) };
}

function metadata(edition, options = {}) {
  const normalized = normalizeEdition(edition);
  if (!normalized) throw editionError('实例 edition 未初始化或无效，请先完成首次设置');
  const runtime = normalizeRuntime(options.runtime);
  if (!runtime) throw editionError('实例 runtime 无效');
  const authMode = options.authMode === 'passport' ? 'passport' : 'feishu';
  const auth = runtime === 'desktop-local'
    ? { required: false, methods: ['local'] }
    : normalized === 'personal'
      ? { required: true, methods: ['passport'] }
      : { required: true, methods: ['password', authMode] };
  return { runtime, edition: normalized, auth, capabilities: getCapabilities(normalized) };
}

async function loadPersistedEdition(db) {
  const result = await db.query('SELECT edition FROM instance_settings WHERE singleton_key = $1', ['instance']);
  if (!result.rows.length) return null;
  const edition = normalizeEdition(result.rows[0].edition);
  if (!edition) throw editionError('数据库中的实例 edition 无效，请修复 instance_settings 后重试', 'EDITION_PERSISTED_INVALID');
  return edition;
}

async function inspectLegacyData(db) {
  const result = await db.query(`SELECT
    (SELECT COUNT(*)::int FROM users) AS users,
    (SELECT COUNT(*)::int FROM teams) AS teams,
    (SELECT COUNT(*)::int FROM user_teams) AS memberships,
    (SELECT COUNT(*)::int FROM api_key_members) AS shared_key_members,
    (SELECT COUNT(*)::int FROM auth_invites) AS invites`);
  const row = result.rows[0] || {};
  const signals = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
  return { ...signals, hasLegacyData: Object.values(signals).some((value) => value > 0) };
}

async function initializeEdition(db, requested, options = {}) {
  const candidate = normalizeEdition(requested);
  if (!candidate) throw editionError('edition 只能是 personal 或 team');
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const owned = client !== db;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [918273]);
    const current = await loadPersistedEdition(client);
    if (current && current !== candidate) throw editionError(`实例已固定为 ${current}，不能改为 ${candidate}`, 'EDITION_CONFLICT');
    if (!current) {
      const legacy = await inspectLegacyData(client);
      if (legacy.hasLegacyData && options.confirmLegacy !== true) throw editionError('检测到历史安装数据，不能自动选择 edition；请由已认证管理员通过迁移流程明确确认', 'EDITION_LEGACY_CONFIRMATION_REQUIRED');
      await client.query(`INSERT INTO instance_settings (singleton_key, edition) VALUES ('instance', $1) ON CONFLICT (singleton_key) DO NOTHING`, [candidate]);
      const persisted = await loadPersistedEdition(client);
      if (persisted !== candidate) throw editionError('实例 edition 初始化发生并发冲突，请重试', 'EDITION_CONFLICT');
    }
    await client.query('COMMIT');
    return current || candidate;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally { if (owned) client.release(); }
}

async function resolveEdition(db, configuredEdition) {
  const persisted = await loadPersistedEdition(db);
  const configured = configuredEdition == null || configuredEdition === '' ? null : normalizeEdition(configuredEdition);
  if (configuredEdition != null && configuredEdition !== '' && !configured) throw editionError('CR_EDITION 只能是 personal 或 team');
  if (persisted && configured && persisted !== configured) throw editionError(`CR_EDITION=${configured} 与已持久化 edition=${persisted} 冲突`, 'EDITION_CONFLICT');
  return persisted || configured || null;
}

function requireTeamEdition(getEdition) {
  return async function teamEditionGuard(req, res, next) {
    try {
      const edition = typeof getEdition === 'function' ? await getEdition(req) : getEdition;
      if (edition !== 'team') {
        if (!req.session?.user) return next();
        return res.status(403).json({ error: '此功能仅适用于 Team Edition', type: 'team_edition_required' });
      }
      next();
    } catch (error) { res.status(503).json({ error: '实例 edition 尚未初始化', type: 'edition_unavailable' }); }
  };
}

module.exports = { normalizeEdition, normalizeRuntime, getCapabilities, metadata, loadPersistedEdition, initializeEdition, resolveEdition, inspectLegacyData, requireTeamEdition };
