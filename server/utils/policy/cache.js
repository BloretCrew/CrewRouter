'use strict';

const { pool } = require('../../models/database');
const Logger = require('../../logger');
const { compilePolicy } = require('./matcher');

const SNAPSHOT_TTL_MS = 10_000;

const DEFAULT_SETTINGS = Object.freeze({
  enforcement_mode: 'enforce',
  fail_mode: 'open',
  kill_switch: false,
  kill_switch_until: null,
  default_timezone: 'Asia/Shanghai',
  allowlist_dimensions: [],
  require_approval_for_publish: false,
  require_approval_for_delete: false,
  notify_admins: true,
  notify_member: true,
  alert_email_enabled: false,
  alert_email_to: '',
  hit_retention_days: 90,
  metrics_retention_days: 365,
  max_policies_per_team: 500,
});

let cached = null;
let cachedRevision = null;
let cachedAt = 0;

function normalizeSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
  }
  if (!Array.isArray(out.allowlist_dimensions)) out.allowlist_dimensions = [];
  return out;
}

function isWithinValidity(policy, now) {
  if (!policy.enabled) return false;
  if (policy.status !== 'published') return false;
  const time = now instanceof Date ? now.getTime() : Date.now();
  if (policy.starts_at && new Date(policy.starts_at).getTime() > time) return false;
  if (policy.ends_at && new Date(policy.ends_at).getTime() <= time) return false;
  if (policy.bypass_until && new Date(policy.bypass_until).getTime() > time) return false;
  return true;
}

async function loadSnapshot() {
  const [policies, settings, exemptions, meta] = await Promise.all([
    pool.query(`SELECT * FROM access_policies WHERE enabled = TRUE AND status = 'published' ORDER BY priority DESC, id ASC`),
    pool.query('SELECT * FROM policy_settings'),
    pool.query(`
      SELECT * FROM policy_exemptions
      WHERE status = 'active'
        AND starts_at <= NOW()
        AND (ends_at IS NULL OR ends_at > NOW())
        AND (max_uses IS NULL OR used_count < max_uses)
      ORDER BY id ASC
    `),
    pool.query('SELECT revision FROM policy_meta WHERE id = 1'),
  ]);
  const settingsByTeam = new Map();
  let globalSettings = { ...DEFAULT_SETTINGS };
  for (const row of settings.rows) {
    if (row.team_id == null) globalSettings = normalizeSettings(row);
    else settingsByTeam.set(Number(row.team_id), normalizeSettings(row));
  }
  const compiled = policies.rows.map(row => compilePolicy(row));
  return {
    revision: Number(meta.rows[0]?.revision || 0),
    loadedAt: Date.now(),
    policies: compiled,
    globalSettings,
    teamSettings: settingsByTeam,
    exemptions: exemptions.rows,
  };
}

async function getPolicySnapshot({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < SNAPSHOT_TTL_MS) return cached;
  try {
    const snapshot = await loadSnapshot();
    if (!force && cached && snapshot.revision === cachedRevision && now - cachedAt < SNAPSHOT_TTL_MS * 6) {
      cached.loadedAt = now;
      cachedAt = now;
      return cached;
    }
    cached = snapshot;
    cachedRevision = snapshot.revision;
    cachedAt = now;
    return cached;
  } catch (error) {
    Logger.warn(`[策略] 加载策略快照失败: ${error.message}`);
    if (cached) return cached;
    return {
      revision: 0,
      loadedAt: now,
      policies: [],
      globalSettings: { ...DEFAULT_SETTINGS },
      teamSettings: new Map(),
      exemptions: [],
    };
  }
}

function invalidatePolicyCache() {
  cached = null;
  cachedRevision = null;
  cachedAt = 0;
}

function resolveSettings(snapshot, teamId) {
  const team = teamId != null ? snapshot.teamSettings.get(Number(teamId)) : null;
  if (!team) return snapshot.globalSettings;
  return { ...snapshot.globalSettings, ...team };
}

function isKillSwitchActive(settings) {
  if (!settings?.kill_switch) return false;
  if (!settings.kill_switch_until) return true;
  return new Date(settings.kill_switch_until).getTime() > Date.now();
}

function applicablePolicies(snapshot, { userId, teamId, now = new Date() }) {
  return snapshot.policies.filter(policy => {
    if (!isWithinValidity(policy, now)) return false;
    if (policy.scope_type === 'global') return true;
    if (policy.scope_type === 'team') return Number(policy.scope_id) === Number(teamId);
    if (policy.scope_type === 'member') return Number(policy.scope_id) === Number(userId);
    return false;
  });
}

function activeExemptions(snapshot, { userId, teamId, keyId, now = new Date() }) {
  const time = now.getTime();
  return snapshot.exemptions.filter(exemption => {
    if (exemption.starts_at && new Date(exemption.starts_at).getTime() > time) return false;
    if (exemption.ends_at && new Date(exemption.ends_at).getTime() <= time) return false;
    if (exemption.max_uses != null && Number(exemption.used_count) >= Number(exemption.max_uses)) return false;
    if (exemption.subject_type === 'user') return Number(exemption.subject_id) === Number(userId);
    if (exemption.subject_type === 'team') return Number(exemption.subject_id) === Number(teamId);
    if (exemption.subject_type === 'api_key') return Number(exemption.subject_id) === Number(keyId);
    return false;
  });
}

module.exports = {
  DEFAULT_SETTINGS,
  getPolicySnapshot,
  invalidatePolicyCache,
  resolveSettings,
  isKillSwitchActive,
  applicablePolicies,
  activeExemptions,
  normalizeSettings,
  isWithinValidity,
};
