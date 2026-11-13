'use strict';

/**
 * 策略平台数据库 schema。
 * 所有时间列使用 TIMESTAMPTZ，API 输出 ISO UTC。
 */

const Logger = require('../../logger');

async function createTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_meta (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      revision BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`INSERT INTO policy_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      color VARCHAR(20) NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_groups_team_name ON policy_groups (COALESCE(team_id, 0), name)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS access_policies (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scope_type VARCHAR(16) NOT NULL CHECK (scope_type IN ('global','team','member')),
      scope_id INTEGER,
      effect VARCHAR(8) NOT NULL CHECK (effect IN ('deny','allow')),
      action VARCHAR(16) NOT NULL DEFAULT 'block'
        CHECK (action IN ('block','warn','shadow','notify','throttle','queue','downgrade','approval','step_up','suspend','revoke_key','custom')),
      action_options JSONB NOT NULL DEFAULT '{}'::jsonb,
      ladder JSONB NOT NULL DEFAULT '[]'::jsonb,
      priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
      category VARCHAR(32) NOT NULL DEFAULT 'combined'
        CHECK (category IN ('client','identity','model','provider','network','time','usage','capacity','content','session','combined')),
      conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(16) NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
      version INTEGER NOT NULL DEFAULT 1,
      group_id INTEGER REFERENCES policy_groups(id) ON DELETE SET NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      rollout_percent INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
      status_code INTEGER NOT NULL DEFAULT 403 CHECK (status_code IN (403,429)),
      message_template TEXT NOT NULL DEFAULT '',
      notify_channels JSONB NOT NULL DEFAULT '{"inapp":true,"webhook":false,"email":false}'::jsonb,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      auto_publish_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      bypass_until TIMESTAMPTZ,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT access_policies_scope_check CHECK (
        (scope_type = 'global' AND scope_id IS NULL)
        OR (scope_type IN ('team','member') AND scope_id IS NOT NULL)
      ),
      CONSTRAINT access_policies_window_check CHECK (
        starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
      )
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_access_policies_global ON access_policies (enabled, priority DESC) WHERE scope_type = 'global'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_access_policies_team ON access_policies (scope_id, enabled, priority DESC) WHERE scope_type = 'team'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_access_policies_member ON access_policies (scope_id, enabled, priority DESC) WHERE scope_type = 'member'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_access_policies_category ON access_policies (category, enabled)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_access_policies_conditions ON access_policies USING GIN (conditions jsonb_path_ops)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_access_policies_name_scope ON access_policies (scope_type, COALESCE(scope_id, 0), name)`);
  await db.query(`ALTER TABLE access_policies ADD COLUMN IF NOT EXISTS auto_publish_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE access_policies ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_versions (
      id BIGSERIAL PRIMARY KEY,
      policy_id INTEGER NOT NULL REFERENCES access_policies(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      snapshot JSONB NOT NULL,
      change_summary TEXT NOT NULL DEFAULT '',
      changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (policy_id, version)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_exemptions (
      id BIGSERIAL PRIMARY KEY,
      policy_id INTEGER REFERENCES access_policies(id) ON DELETE CASCADE,
      subject_type VARCHAR(16) NOT NULL CHECK (subject_type IN ('user','team','api_key')),
      subject_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_exemptions_subject ON policy_exemptions (subject_type, subject_id, status)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_appeals (
      id BIGSERIAL PRIMARY KEY,
      policy_id INTEGER REFERENCES access_policies(id) ON DELETE SET NULL,
      hit_id BIGINT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
      reason TEXT NOT NULL DEFAULT '',
      resolution TEXT NOT NULL DEFAULT '',
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      exemption_id BIGINT REFERENCES policy_exemptions(id) ON DELETE SET NULL,
      sla_due_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_appeals_status ON policy_appeals (status, created_at DESC)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_approvals (
      id BIGSERIAL PRIMARY KEY,
      kind VARCHAR(16) NOT NULL CHECK (kind IN ('change','request')),
      policy_id INTEGER REFERENCES access_policies(id) ON DELETE CASCADE,
      requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      preview JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_hits (
      id BIGSERIAL PRIMARY KEY,
      policy_id INTEGER REFERENCES access_policies(id) ON DELETE SET NULL,
      policy_name TEXT,
      policy_version INTEGER,
      effect VARCHAR(8) NOT NULL,
      action VARCHAR(16) NOT NULL,
      decision VARCHAR(16) NOT NULL,
      scope_type VARCHAR(16),
      scope_id INTEGER,
      team_id INTEGER,
      user_id INTEGER,
      api_key_id INTEGER,
      request_source VARCHAR(32),
      request_semantics VARCHAR(24),
      protocol VARCHAR(16),
      requested_model TEXT,
      resolved_model TEXT,
      provider_id VARCHAR(100),
      ip INET,
      user_agent TEXT,
      method VARCHAR(8),
      path TEXT,
      status_code INTEGER,
      reason TEXT,
      matched_conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_id TEXT,
      eval_ms INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_hits_created ON policy_hits (created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_hits_team_created ON policy_hits (team_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_hits_user_created ON policy_hits (user_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_hits_policy_created ON policy_hits (policy_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_hits_source_created ON policy_hits (request_source, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_policy_hits_request ON policy_hits (request_id)`);
  // 审计记录不依赖策略行存活；删除策略后仍保留命中历史。
  await db.query(`ALTER TABLE policy_hits DROP CONSTRAINT IF EXISTS policy_hits_policy_id_fkey`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_channels (
      id SERIAL PRIMARY KEY,
      type VARCHAR(16) NOT NULL CHECK (type IN ('webhook','feishu','wecom','dingtalk','slack','telegram','email','bark','syslog','otlp')),
      name VARCHAR(80) NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      min_severity VARCHAR(16) NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info','warning','critical')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`ALTER TABLE policy_channels DROP CONSTRAINT IF EXISTS policy_channels_type_check`);
  await db.query(`ALTER TABLE policy_channels ADD CONSTRAINT policy_channels_type_check CHECK (type IN ('webhook','feishu','wecom','dingtalk','slack','telegram','email','bark','syslog','otlp'))`).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_alert_rules (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      severity VARCHAR(16) NOT NULL DEFAULT 'warning',
      channel_ids INTEGER[] NOT NULL DEFAULT '{}',
      aggregate_window_seconds INTEGER NOT NULL DEFAULT 300,
      silence_window_seconds INTEGER NOT NULL DEFAULT 300,
      template TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_runtime_counters (
      key TEXT PRIMARY KEY,
      policy_id INTEGER,
      subject_type TEXT,
      subject_id INTEGER,
      window_start TIMESTAMPTZ NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      last_action VARCHAR(16),
      last_hit_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_metrics_daily (
      day DATE NOT NULL,
      policy_id INTEGER,
      action VARCHAR(16),
      decision VARCHAR(16),
      request_source VARCHAR(32),
      team_id INTEGER,
      hits BIGINT NOT NULL DEFAULT 0,
      blocked BIGINT NOT NULL DEFAULT 0,
      avg_eval_ms NUMERIC(10,3),
      p95_eval_ms NUMERIC(10,3),
      PRIMARY KEY (day, policy_id, action, decision, request_source, team_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS login_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      method VARCHAR(24),
      success BOOLEAN NOT NULL,
      ip INET,
      user_agent TEXT,
      mfa BOOLEAN NOT NULL DEFAULT FALSE,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_login_events_user_created ON login_events (user_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_login_events_ip_created ON login_events (ip, created_at DESC)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_jobs (
      id BIGSERIAL PRIMARY KEY,
      kind VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      params JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_calendars (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      name VARCHAR(80) NOT NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
      dates JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_settings (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      enforcement_mode VARCHAR(16) NOT NULL DEFAULT 'enforce' CHECK (enforcement_mode IN ('enforce','shadow')),
      fail_mode VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (fail_mode IN ('open','closed')),
      kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
      kill_switch_until TIMESTAMPTZ,
      default_timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
      allowlist_dimensions JSONB NOT NULL DEFAULT '[]'::jsonb,
      require_approval_for_publish BOOLEAN NOT NULL DEFAULT FALSE,
      require_approval_for_delete BOOLEAN NOT NULL DEFAULT FALSE,
      notify_admins BOOLEAN NOT NULL DEFAULT TRUE,
      notify_member BOOLEAN NOT NULL DEFAULT TRUE,
      alert_email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      alert_email_to TEXT NOT NULL DEFAULT '',
      hit_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (hit_retention_days BETWEEN 1 AND 3650),
      metrics_retention_days INTEGER NOT NULL DEFAULT 365 CHECK (metrics_retention_days BETWEEN 1 AND 3650),
      max_policies_per_team INTEGER NOT NULL DEFAULT 500 CHECK (max_policies_per_team BETWEEN 1 AND 10000),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_settings_team ON policy_settings (team_id) WHERE team_id IS NOT NULL`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_settings_global ON policy_settings ((1)) WHERE team_id IS NULL`);
  await db.query(`INSERT INTO policy_settings (team_id) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM policy_settings WHERE team_id IS NULL)`);
}

async function ensureUserColumns(db) {
  const columns = [
    ['suspended_at', 'TIMESTAMPTZ'],
    ['suspended_until', 'TIMESTAMPTZ'],
    ['suspended_reason', 'TEXT'],
    ['suspended_scope', "VARCHAR(16) DEFAULT 'all'"],
    ['suspended_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
    ['policy_bypass', 'BOOLEAN DEFAULT FALSE'],
    ['policy_bypass_until', 'TIMESTAMPTZ'],
    ['timezone', 'VARCHAR(64)'],
  ];
  for (const [name, type] of columns) {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
  await db.query(`CREATE INDEX IF NOT EXISTS idx_users_suspended_until ON users (suspended_until) WHERE suspended_until IS NOT NULL`);
  await db.query(`ALTER TABLE user_teams ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'member'`);
  await db.query(`UPDATE user_teams SET role = 'member' WHERE role IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_user_teams_role ON user_teams (team_id, role)`);
}

async function ensureRevisionTriggers(db) {
  await db.query(`
    CREATE OR REPLACE FUNCTION policy_bump_revision() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE policy_meta SET revision = revision + 1, updated_at = NOW() WHERE id = 1;
      RETURN NULL;
    END $$;
  `);
  for (const table of ['access_policies', 'policy_settings', 'policy_exemptions']) {
    await db.query(`DROP TRIGGER IF EXISTS trg_${table}_revision ON ${table}`);
    await db.query(`CREATE TRIGGER trg_${table}_revision AFTER INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION policy_bump_revision()`);
  }
}

async function ensurePolicySchema(db) {
  await createTables(db);
  await ensureUserColumns(db);
  await ensureRevisionTriggers(db);
  Logger.info('[迁移] 策略平台表已就绪');
}

module.exports = { ensurePolicySchema };
