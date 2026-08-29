const { Pool } = require('pg');
const config = require('../config-loader');
const Logger = require('../logger');

async function ensureDatabase() {
  const adminPool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: 'postgres',
    user: config.database.user,
    password: config.database.password,
  });

  const client = await adminPool.connect();
  try {
    const dbCheck = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [config.database.name]
    );
    if (dbCheck.rows.length === 0) {
      await client.query(`CREATE DATABASE ${config.database.name}`);
      Logger.info(`[数据库初始化] 数据库 "${config.database.name}" 已创建`);
    } else {
      Logger.info(`[数据库初始化] 数据库 "${config.database.name}" 已存在`);
    }

    const userCheck = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [config.database.user]
    );
    if (userCheck.rows.length === 0) {
      await client.query(`CREATE USER ${config.database.user} WITH PASSWORD '${config.database.password}'`);
      Logger.info(`[数据库初始化] 用户 "${config.database.user}" 已创建`);
    }
    await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${config.database.name} TO ${config.database.user}`);
    await client.query(`ALTER DATABASE ${config.database.name} OWNER TO ${config.database.user}`);
  } finally {
    client.release();
    await adminPool.end();
  }
}

async function initDatabase() {
  Logger.info('[数据库初始化] 正在检查数据库...');
  await ensureDatabase();

  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
  });

  const client = await pool.connect();
  Logger.info('[数据库初始化] 已连接到目标数据库，开始创建表...');

  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE,
        password_hash VARCHAR(255),
        avatar VARCHAR(500),
        balance DECIMAL(10, 4) DEFAULT 10,
        is_admin BOOLEAN DEFAULT FALSE,
        email_verified BOOLEAN DEFAULT TRUE,
        tags TEXT[],
        rate_limit_rpm INTEGER DEFAULT 0,
        rate_limit_tpm BIGINT DEFAULT 0,
        group_id INTEGER,
        team_id INTEGER,
        api_signature_enabled BOOLEAN DEFAULT FALSE,
        api_signature_template TEXT DEFAULT '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[数据库初始化] 表 users 已就绪');

    // 兼容旧表：OOBE / 注册路径依赖的 users 列
    const userCoreCols = [
      { name: 'email_verified', type: 'BOOLEAN DEFAULT TRUE' },
      { name: 'group_id', type: 'INTEGER' },
      { name: 'team_id', type: 'INTEGER' },
      { name: 'refund_balance', type: 'DECIMAL(10, 4) DEFAULT 0' },
      { name: 'api_signature_enabled', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'api_signature_template', type: "TEXT DEFAULT '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}'" },
    ];
    for (const col of userCoreCols) {
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = $1
      `, [col.name]);
      if (colCheck.rows.length === 0) {
        await client.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        Logger.info(`[数据库初始化] 已为 users 表添加 ${col.name} 列`);
      }
    }
    await client.query('ALTER TABLE users ALTER COLUMN api_signature_enabled SET DEFAULT FALSE');

    // 兼容旧表：为 users 添加密码列
    const userPasswordColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'password_hash'
    `);
    if (userPasswordColCheck.rows.length === 0) {
      await client.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)`);
      Logger.info('[数据库初始化] 已为 users 表添加 password_hash 列');
    }

    // 注意：不要再给无密码用户批量写入默认密码 123456。
    // 飞书注册用户应保持 password_hash 为空，登录后强制走 /set-password。

    // 兼容旧表：确保 email 列有 UNIQUE 约束
    const emailUniqueCheck = await client.query(`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'users' AND kcu.column_name = 'email' AND tc.constraint_type = 'UNIQUE'
    `);
    if (emailUniqueCheck.rows.length === 0) {
      // 先清理重复的 email（保留第一个）
      await client.query(`
        UPDATE users SET email = NULL
        WHERE id NOT IN (
          SELECT MIN(id) FROM users WHERE email IS NOT NULL GROUP BY email
        ) AND email IS NOT NULL
      `);
      await client.query(`ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email)`);
      Logger.info('[数据库初始化] 已为 users 表 email 列添加 UNIQUE 约束');
    }

    // 兼容旧表：为 users 添加速率限制列
    const userRateColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'rate_limit_rpm'
    `);
    if (userRateColCheck.rows.length === 0) {
      await client.query(`ALTER TABLE users ADD COLUMN rate_limit_rpm INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE users ADD COLUMN rate_limit_tpm BIGINT DEFAULT 0`);
      Logger.info('[数据库初始化] 已为 users 表添加速率限制列');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL,
        PRIMARY KEY (sid)
      )
    `);
    Logger.info('[数据库初始化] 表 user_sessions 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS models (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        provider VARCHAR(100) NOT NULL,
        series VARCHAR(100) DEFAULT '',
        description TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        input_price_per_1k_tokens DECIMAL(10, 6) DEFAULT 0,
        output_price_per_1k_tokens DECIMAL(10, 6) DEFAULT 0,
        cached_output_price_per_1k_tokens DECIMAL(10, 6) DEFAULT 0,
        model_multiplier DECIMAL(10, 4) DEFAULT 1.0,
        completion_multiplier DECIMAL(10, 4) DEFAULT 1.0,
        rate_limit_rpm INTEGER DEFAULT 0,
        rate_limit_tpm BIGINT DEFAULT 0,
        icon_url VARCHAR(500) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[数据库初始化] 表 models 已就绪');

    // 兼容旧表：迁移 price_per_1k_tokens 到新的两列
    const priceColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'input_price_per_1k_tokens'
    `);
    if (priceColCheck.rows.length === 0) {
      // 添加新列
      await client.query(`ALTER TABLE models ADD COLUMN input_price_per_1k_tokens DECIMAL(10, 6) DEFAULT 0`);
      await client.query(`ALTER TABLE models ADD COLUMN output_price_per_1k_tokens DECIMAL(10, 6) DEFAULT 0`);
      await client.query(`ALTER TABLE models ADD COLUMN rate_limit_rpm INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE models ADD COLUMN rate_limit_tpm BIGINT DEFAULT 0`);
      Logger.info('[数据库初始化] 已为 models 表添加价格和速率限制列');

      // 迁移旧数据
      const oldPriceCol = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'models' AND column_name = 'price_per_1k_tokens'
      `);
      if (oldPriceCol.rows.length > 0) {
        await client.query(`UPDATE models SET input_price_per_1k_tokens = price_per_1k_tokens, output_price_per_1k_tokens = price_per_1k_tokens`);
        await client.query(`ALTER TABLE models DROP COLUMN price_per_1k_tokens`);
        Logger.info('[数据库初始化] 已迁移旧价格数据到新列');
      }
    }

    // 兼容旧表：为 models 添加 series 列
    const seriesColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'series'
    `);
    if (seriesColCheck.rows.length === 0) {
      await client.query(`ALTER TABLE models ADD COLUMN series VARCHAR(100) DEFAULT ''`);
      Logger.info('[数据库初始化] 已为 models 表添加 series 列');
    }

    // 兼容旧表：为 models 添加 icon_url 列
    const iconUrlColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'icon_url'
    `);
    if (iconUrlColCheck.rows.length === 0) {
      await client.query(`ALTER TABLE models ADD COLUMN icon_url VARCHAR(500) DEFAULT ''`);
      Logger.info('[数据库初始化] 已为 models 表添加 icon_url 列');
    }

    // 兼容旧表：为 models 添加 alias 列
    const aliasColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'alias'
    `);
    if (aliasColCheck.rows.length === 0) {
      await client.query(`ALTER TABLE models ADD COLUMN alias VARCHAR(100) DEFAULT ''`);
      Logger.info('[数据库初始化] 已为 models 表添加 alias 列');
    }

    // 删除 cached_input_price_per_1k_tokens 列（如果存在）
    const cachedPriceColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'cached_input_price_per_1k_tokens'
    `);
    if (cachedPriceColCheck.rows.length > 0) {
      await client.query(`ALTER TABLE models DROP COLUMN cached_input_price_per_1k_tokens`);
      Logger.info('[数据库初始化] 已删除 models 表的 cached_input_price_per_1k_tokens 列');
    }

    // 添加 cached_output_price_per_1k_tokens 列（如果不存在）
    const cachedOutputPriceColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'cached_output_price_per_1k_tokens'
    `);
    if (cachedOutputPriceColCheck.rows.length === 0) {
      await client.query(`ALTER TABLE models ADD COLUMN cached_output_price_per_1k_tokens DECIMAL(10, 6) DEFAULT 0`);
      Logger.info('[数据库初始化] 已为 models 表添加 cached_output_price_per_1k_tokens 列');
    }

    // 添加参考价字段（如果不存在）
    const refPriceCols = [
      'reference_input_price_per_1k_tokens',
      'reference_output_price_per_1k_tokens',
      'reference_cached_output_price_per_1k_tokens'
    ];
    for (const col of refPriceCols) {
      const refColCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'models' AND column_name = $1
      `, [col]);
      if (refColCheck.rows.length === 0) {
        await client.query(`ALTER TABLE models ADD COLUMN ${col} DECIMAL(10, 6) DEFAULT 0`);
        Logger.info(`[数据库初始化] 已为 models 表添加 ${col} 列`);
      }
    }

    // 添加倍率字段（如果不存在）
    const multiplierCols = [
      { name: 'model_multiplier', type: 'DECIMAL(10, 4) DEFAULT 1.0' },
      { name: 'completion_multiplier', type: 'DECIMAL(10, 4) DEFAULT 1.0' }
    ];
    for (const col of multiplierCols) {
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'models' AND column_name = $1
      `, [col.name]);
      if (colCheck.rows.length === 0) {
        await client.query(`ALTER TABLE models ADD COLUMN ${col.name} ${col.type}`);
        Logger.info(`[数据库初始化] 已为 models 表添加 ${col.name} 列`);
      }
    }

    // 兼容旧表：为 models 添加 upstream_model_id 列（支持同名模型来自不同供应商）
    const upstreamIdColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'upstream_model_id'
    `);
    if (upstreamIdColCheck.rows.length === 0) {
      await client.query(`ALTER TABLE models ADD COLUMN upstream_model_id VARCHAR(255) DEFAULT ''`);
      // 迁移已有数据：将 id 复制到 upstream_model_id
      await client.query(`UPDATE models SET upstream_model_id = id WHERE upstream_model_id = ''`);
      Logger.info('[数据库初始化] 已为 models 表添加 upstream_model_id 列并迁移数据');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        base_url VARCHAR(500) NOT NULL,
        api_key VARCHAR(500) DEFAULT '',
        format VARCHAR(50) DEFAULT 'openai',
        enabled BOOLEAN DEFAULT TRUE,
        key_mode VARCHAR(20) DEFAULT 'fixed',
        key_script TEXT DEFAULT '',
        key_refresh_interval INTEGER DEFAULT 3600,
        key_expires_at TIMESTAMP,
        key_last_refresh_at TIMESTAMP,
        key_last_error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建 series 表（系列图标管理）
    await client.query(`
      CREATE TABLE IF NOT EXISTS series (
        name VARCHAR(100) PRIMARY KEY,
        icon_url VARCHAR(500) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 兼容旧表：为 providers 添加 OAuth 字段
    const oauthCols = [
      { name: 'oauth_refresh_token', type: 'TEXT' },
      { name: 'oauth_access_token', type: 'TEXT' },
      { name: 'oauth_expires_at', type: 'BIGINT' },
      { name: 'oauth_account_id', type: 'VARCHAR(100)' },
      { name: 'oauth_issuer', type: 'VARCHAR(500)' },
      { name: 'oauth_client_id', type: 'VARCHAR(200)' },
      { name: 'grp', type: 'VARCHAR(100)' },
      { name: 'models_url', type: 'VARCHAR(500)' },
      { name: 'notes', type: 'TEXT' },
      { name: 'created_by', type: 'INTEGER REFERENCES users(id)' },
      { name: 'api_keys', type: 'JSONB DEFAULT NULL' },
      { name: 'api_key_select_mode', type: "VARCHAR(20) DEFAULT 'order'" },
      { name: 'test_user_agent', type: "TEXT DEFAULT ''" },
      { name: 'quota_schedule_enabled', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'quota_schedule_interval', type: 'INTEGER DEFAULT 3600' },
      { name: 'quota_last_checked_at', type: 'TIMESTAMPTZ' },
      { name: 'quota_last_ok', type: 'BOOLEAN' },
      { name: 'quota_last_result', type: 'JSONB' },
      { name: 'quota_last_error', type: 'TEXT' }
    ];
    for (const col of oauthCols) {
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'providers' AND column_name = $1
      `, [col.name]);
      if (colCheck.rows.length === 0) {
        await client.query(`ALTER TABLE providers ADD COLUMN ${col.name} ${col.type}`);
        Logger.info(`[数据库初始化] 已为 providers 表添加 ${col.name} 列`);
      }
    }

    // CrewRouter Team 系统表
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        is_default BOOLEAN DEFAULT FALSE,
        is_frontier BOOLEAN DEFAULT FALSE,
        is_personal BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_frontier BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_personal BOOLEAN DEFAULT FALSE`);
    Logger.info('[数据库初始化] 表 teams 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_teams (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, team_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_teams_user ON user_teams(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_teams_team ON user_teams(team_id)`);
    Logger.info('[数据库初始化] 表 user_teams 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_models (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        enabled BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(team_id, model_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_models_team ON team_models(team_id)`);
    Logger.info('[数据库初始化] 表 team_models 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_team_orders (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_provider_orders (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        provider_id VARCHAR(100) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id, provider_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_model_orders (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        provider_id VARCHAR(100) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id, provider_id, model_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_mlo_team_user_order ON user_model_library_team_orders(user_id, sort_order)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_mlo_provider_user_team_order ON user_model_library_provider_orders(user_id, team_id, sort_order)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_mlo_model_user_team_provider_order ON user_model_library_model_orders(user_id, team_id, provider_id, sort_order)`);
    Logger.info('[数据库初始化] 用户模型库排序表已就绪');

    // api_keys：完整列定义，避免空库仅靠后续 ensure* 补列时的竞态缺口
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        key_value VARCHAR(255) UNIQUE,
        key_hash VARCHAR(255) NOT NULL UNIQUE,
        key_prefix VARCHAR(20),
        name VARCHAR(255),
        last_used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        is_system BOOLEAN DEFAULT FALSE,
        enabled BOOLEAN DEFAULT TRUE,
        custom_model_name VARCHAR(200) DEFAULT 'claude-fable-5',
        current_model_id VARCHAR(100),
        schedule_enabled BOOLEAN DEFAULT FALSE,
        schedule_on_time TIME,
        schedule_off_time TIME,
        schedule_days INTEGER[] DEFAULT '{0,1,2,3,4,5,6}',
        schedule_timezone VARCHAR(50) DEFAULT 'Asia/Shanghai',
        fusion_enabled BOOLEAN DEFAULT TRUE,
        fusion_panel_models JSONB DEFAULT '[]'::jsonb,
        fusion_judge_model_id VARCHAR(100) DEFAULT '',
        fusion_outer_model_id VARCHAR(100) DEFAULT '',
        signature_enabled BOOLEAN DEFAULT NULL,
        signature_template TEXT DEFAULT NULL,
        swallow_images BOOLEAN DEFAULT FALSE,
        crewrouter_commands BOOLEAN DEFAULT TRUE
      )
    `);

    // 兼容旧表：补齐缺失列（CREATE IF NOT EXISTS 不会改已有表结构）
    const apiKeyColumns = [
      { name: 'key_value', type: 'VARCHAR(255) UNIQUE' },
      { name: 'key_prefix', type: 'VARCHAR(20)' },
      { name: 'is_system', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'enabled', type: 'BOOLEAN DEFAULT TRUE' },
      { name: 'custom_model_name', type: "VARCHAR(200) DEFAULT 'claude-fable-5'" },
      { name: 'current_model_id', type: 'VARCHAR(100)' },
      { name: 'schedule_enabled', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'schedule_on_time', type: 'TIME' },
      { name: 'schedule_off_time', type: 'TIME' },
      { name: 'schedule_days', type: "INTEGER[] DEFAULT '{0,1,2,3,4,5,6}'" },
      { name: 'schedule_timezone', type: "VARCHAR(50) DEFAULT 'Asia/Shanghai'" },
      { name: 'fusion_enabled', type: 'BOOLEAN DEFAULT TRUE' },
      { name: 'fusion_panel_models', type: "JSONB DEFAULT '[]'::jsonb" },
      { name: 'fusion_judge_model_id', type: "VARCHAR(100) DEFAULT ''" },
      { name: 'fusion_outer_model_id', type: "VARCHAR(100) DEFAULT ''" },
      { name: 'signature_enabled', type: 'BOOLEAN DEFAULT NULL' },
      { name: 'signature_template', type: 'TEXT DEFAULT NULL' },
      { name: 'quota_warning_enabled', type: 'BOOLEAN DEFAULT TRUE' },
      { name: 'swallow_images', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'crewrouter_commands', type: 'BOOLEAN DEFAULT TRUE' }
    ];
    for (const col of apiKeyColumns) {
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'api_keys' AND column_name = $1
      `, [col.name]);
      if (colCheck.rows.length === 0) {
        await client.query(`ALTER TABLE api_keys ADD COLUMN ${col.name} ${col.type}`);
        Logger.info(`[数据库初始化] 已为 api_keys 表添加 ${col.name} 列`);
      }
    }
    Logger.info('[数据库初始化] 表 api_keys 已就绪');

    // Co-Key 成员：api_keys.user_id 始终是发起者及计费归属
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_key_members (
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_key_members_user ON api_key_members(user_id, api_key_id)`);
    Logger.info('[数据库初始化] 表 api_key_members 已就绪');

    // 操作日志：记录用户/管理员在系统中的每一次写操作
    await client.query(`
      CREATE TABLE IF NOT EXISTS operation_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username VARCHAR(255) NOT NULL DEFAULT '系统',
        is_admin BOOLEAN DEFAULT FALSE,
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(50) DEFAULT '',
        resource_id VARCHAR(100),
        description VARCHAR(500) DEFAULT '',
        details JSONB,
        ip_address VARCHAR(45),
        user_agent VARCHAR(500),
        status INTEGER,
        duration_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_user_created ON operation_logs(user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_created ON operation_logs(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_action ON operation_logs(action)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_resource ON operation_logs(resource_type, resource_id)`);
    Logger.info('[数据库初始化] 表 operation_logs 已就绪');


    // API Key 模型队列（有序失败回退）
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_key_models (
        id SERIAL PRIMARY KEY,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        enabled BOOLEAN DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(api_key_id, model_id)
      )
    `);
    await client.query(`ALTER TABLE api_key_models ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_akm_api_key ON api_key_models(api_key_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_akm_key_order ON api_key_models(api_key_id, sort_order)`);
    Logger.info('[数据库初始化] 表 api_key_models 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS trace_sessions (
        id SERIAL PRIMARY KEY,
        public_id VARCHAR(32) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
        request_source VARCHAR(32) DEFAULT 'unknown', user_agent VARCHAR(500),
        status VARCHAR(20) NOT NULL DEFAULT 'recording', started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP, viewed_at TIMESTAMP, summary JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE IF NOT EXISTS trace_events (
        id BIGSERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES trace_sessions(id) ON DELETE CASCADE,
        usage_record_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, ok BOOLEAN NOT NULL DEFAULT TRUE,
        http_status INTEGER, error TEXT, request_type VARCHAR(50), request_source VARCHAR(32), user_agent VARCHAR(500), ip_address VARCHAR(45),
        model_id VARCHAR(255), provider_id VARCHAR(100), tokens_used BIGINT DEFAULT 0, prompt_tokens BIGINT DEFAULT 0,
        completion_tokens BIGINT DEFAULT 0, cached_tokens BIGINT DEFAULT 0, weighted_tokens BIGINT DEFAULT 0, cost NUMERIC(18,6) DEFAULT 0,
        latency_ms INTEGER, messages JSONB, response TEXT, reasoning_content TEXT, request_params JSONB, finish_reason VARCHAR(50)
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        model_id VARCHAR(100) REFERENCES models(id),
        api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
        tokens_used INTEGER DEFAULT 0,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        provider_id VARCHAR(100),
        request_type VARCHAR(50) DEFAULT 'chat',
        request_source VARCHAR(32) DEFAULT 'unknown',
        user_agent VARCHAR(500),
        latency_ms INTEGER,
        ip_address VARCHAR(45),
        messages JSONB,
        response TEXT,
        cost DECIMAL(10, 6) DEFAULT 0,
        history_hidden BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS active_trace_session_id INTEGER`);
    await client.query(`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS usage_record_id INTEGER`);
    await client.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS request_source VARCHAR(32) DEFAULT 'unknown'`);
    await client.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS user_agent VARCHAR(500)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_user_created ON usage_records (user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_created ON usage_records (created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_request_type_created ON usage_records (request_type, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_request_source_created ON usage_records (request_source, created_at DESC)`);
    Logger.info('[数据库初始化] 表 usage_records 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_error_records (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        api_key_id INTEGER,
        model_id VARCHAR(255),
        provider_id VARCHAR(100),
        request_type VARCHAR(50) DEFAULT 'chat',
        status_code INTEGER,
        error_type VARCHAR(100),
        error_message TEXT,
        error_body TEXT,
        latency_ms INTEGER,
        ip_address VARCHAR(45),
        is_final BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_error_records_created ON api_error_records (created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_error_records_user ON api_error_records (user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_error_records_provider ON api_error_records (provider_id, created_at DESC)`);
    Logger.info('[数据库初始化] 表 api_error_records 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS model_uptime_daily (
        model_id VARCHAR(255) NOT NULL,
        day DATE NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        fail INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model_id, day)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_model_uptime_day ON model_uptime_daily(day)`);
    Logger.info('[数据库初始化] 表 model_uptime_daily 已就绪');

    await client.query(`
      CREATE TABLE IF NOT EXISTS model_uptime_hourly (
        model_id VARCHAR(255) NOT NULL,
        hour TIMESTAMPTZ NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        fail INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model_id, hour)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_model_uptime_hour ON model_uptime_hourly(hour)`);
    Logger.info('[数据库初始化] 表 model_uptime_hourly 已就绪（15 分钟槽）');

    // 创建 API Key 标签系统
    await client.query(`
      CREATE TABLE IF NOT EXISTS key_tags (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        color VARCHAR(20) NOT NULL DEFAULT '#3b82f6',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_key_tags_user ON key_tags(user_id, sort_order)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_key_tags (
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES key_tags(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key_id, tag_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_key_tags_tag ON api_key_tags(tag_id)`);
    Logger.info('[数据库初始化] API Key 标签系统表已就绪');

    // 创建供应商标签系统（全局标签，管理员管理）
    await client.query(`
      CREATE TABLE IF NOT EXISTS provider_tags (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        color VARCHAR(20) NOT NULL DEFAULT '#3b82f6',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_provider_tags_sort ON provider_tags(sort_order)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS provider_tag_assignments (
        provider_id VARCHAR(100) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES provider_tags(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, tag_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_provider_tag_assignments_tag ON provider_tag_assignments(tag_id)`);
    Logger.info('[数据库初始化] 供应商标签系统表已就绪');

    // 为 usage_records 表添加可能缺失的列（兼容旧数据库）
    const usageColumnsToAdd = [
      { name: 'prompt_tokens', type: 'INTEGER DEFAULT 0' },
      { name: 'completion_tokens', type: 'INTEGER DEFAULT 0' },
      { name: 'cached_tokens', type: 'INTEGER DEFAULT 0' },
      { name: 'provider_id', type: 'VARCHAR(100)' },
      { name: 'request_type', type: "VARCHAR(50) DEFAULT 'chat'" },
      { name: 'latency_ms', type: 'INTEGER' },
      { name: 'ip_address', type: 'VARCHAR(45)' },
      { name: 'messages', type: 'JSONB' },
      { name: 'response', type: 'TEXT' },
      { name: 'history_hidden', type: 'BOOLEAN DEFAULT FALSE' }
    ];
    // 注意: 不能靠 try/catch 吞 42701 —— 事务内任何语句报错都会使整个事务进入
    // aborted 状态，后续语句全部报 25P02。必须用 IF NOT EXISTS 避免报错。
    for (const col of usageColumnsToAdd) {
      const res = await client.query(
        `ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`
      );
      if (res && res.command) {
        Logger.info(`[数据库初始化] 已为 usage_records 表添加 ${col.name} 列`);
      }
    }

    // 创建应用配置表
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[数据库初始化] 表 settings 已就绪');

    // DeepSeek 账号表
    await client.query(`
      CREATE TABLE IF NOT EXISTS deepseek_accounts (
        id SERIAL PRIMARY KEY,
        identifier VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255),
        mobile VARCHAR(50),
        password VARCHAR(500) NOT NULL,
        name VARCHAR(255),
        remark TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        synced BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[数据库初始化] 表 deepseek_accounts 已就绪');

    // 兑换码表
    await client.query(`
      CREATE TABLE IF NOT EXISTS redemption_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(32) UNIQUE NOT NULL,
        amount DECIMAL(10, 4) NOT NULL,
        max_uses INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        expires_at TIMESTAMP,
        batch_name VARCHAR(255),
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[数据库初始化] 表 redemption_codes 已就绪');

    // 同步 config.json 中的应用配置到数据库（仅首次，不覆盖已有值）
    const appSettings = {
      'app.name': config.app.name,
      'stats_refresh_interval_sec': 10,
      'defaultBalance': 10,
      'defaultKeyExpiry': 30
    };
    for (const [key, value] of Object.entries(appSettings)) {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, JSON.stringify(value)]
      );
    }
    Logger.info('[数据库初始化] 应用配置已同步');

    // 同步 config.json 中的供应商到数据库（仅首次）
    for (const provider of config.initialProviders || []) {
      await client.query(`
        INSERT INTO providers (id, name, base_url, api_key, format, enabled)
        VALUES ($1, $2, $3, $4, $5, TRUE)
        ON CONFLICT (id) DO NOTHING
      `, [provider.id, provider.name, provider.baseUrl, provider.apiKey || '', provider.format || 'openai']);
    }
    Logger.info('[数据库初始化] 供应商数据已同步');

    // 同步 config.json 中的模型到数据库（仅首次）
    for (const model of config.initialModels || []) {
      const inputPrice = model.input_price_per_1k_tokens || model.price_per_1k_tokens || 0;
      const outputPrice = model.output_price_per_1k_tokens || model.price_per_1k_tokens || 0;
      await client.query(`
        INSERT INTO models (id, name, provider, series, description, enabled, input_price_per_1k_tokens, output_price_per_1k_tokens)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING
      `, [model.id, model.name, model.provider, model.series || '', model.description, model.enabled, inputPrice, outputPrice]);
    }
    Logger.info('[数据库初始化] 模型数据已同步');

    await client.query('COMMIT');
    Logger.success('[数据库初始化] 完成!');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    Logger.error('[数据库初始化] 错误:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  initDatabase();
}

module.exports = { initDatabase };
