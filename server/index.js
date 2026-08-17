// 进程时区必须在任何 Date/日志初始化之前固定为上海
require('./utils/timezone').ensureProcessTimezone();

const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config-loader');

// 演示模式：使用内存会话、跳过数据库初始化
const isDemo = config.demo === true;

let PgSession;
if (!isDemo) {
  PgSession = require('connect-pg-simple')(session);
}
const { pool } = require('./models/database');
const Logger = require('./logger');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// 静态资源路径兼容：开发模式下 server/index.js 在 server/ 目录，
// __dirname 为 .../server/，public/ 在上层；
// 构建后 dist/server.js 运行在 .../dist/，public/ 在同级。
const fs = require('fs');
const PUBLIC_DIR = (() => {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '../public'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // fallback：都找不到就用开发模式路径
  return path.join(__dirname, '../public');
})();

// 版本号：开发时读项目根 package.json；构建后读 dist/package.json
const APP_VERSION = (() => {
  const candidates = [
    path.join(__dirname, 'package.json'),
    path.join(__dirname, '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg.version) {
          Logger.info(`[version] 已加载版本 ${pkg.version}（来源: ${p}）`);
          return pkg.version;
        }
      }
    } catch (err) {
      Logger.warn(`[version] 读取 package.json 失败: ${p} — ${err.message}`);
    }
  }
  const fallback = process.env.npm_package_version || config.app?.version || '0.0.0';
  Logger.warn(`[version] 未找到 package.json，使用回退版本: ${fallback}`);
  return fallback;
})();

// 更新包目录：开发时项目根 updates/；构建后 dist/updates/
const UPDATES_DIR = (() => {
  const candidates = [
    path.join(__dirname, 'updates'),
    path.join(__dirname, '..', 'updates'),
    path.join(process.cwd(), 'updates'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      Logger.info(`[updates] 更新包目录: ${dir}`);
      return dir;
    }
  }
  // 默认使用开发路径（即使目录尚未创建，下载接口会返回 404）
  const fallback = path.join(__dirname, '..', 'updates');
  Logger.warn(`[updates] 未找到 updates 目录，默认路径: ${fallback}`);
  return fallback;
})();
const LATEST_UPDATE_ZIP = path.join(UPDATES_DIR, 'latest.zip');

// ========== 自动迁移：确保兑换码表存在 ==========
async function ensureRedemptionCodesTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS redemption_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(32) UNIQUE NOT NULL,
        amount DECIMAL(10, 4) NOT NULL,
        max_uses INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        expires_at TIMESTAMP,
        batch_name VARCHAR(255),
        created_by INTEGER REFERENCES users(id),
        refundable BOOLEAN DEFAULT FALSE,
        fee_rate DECIMAL(5, 4) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migration: add refundable/fee_rate if missing
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'redemption_codes' AND column_name = 'refundable'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE redemption_codes ADD COLUMN refundable BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE redemption_codes ADD COLUMN fee_rate DECIMAL(5, 4) DEFAULT 0`);
    }
  } catch (err) {
    Logger.warn(`[迁移] redemption_codes 表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：用户余额拆分 + 兑换码使用记录 ==========
async function ensureBalanceAndRedemptionUseTable() {
  try {
    // Add refund_balance to users
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'refund_balance'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN refund_balance DECIMAL(10, 4) DEFAULT 0`);
      Logger.info('[迁移] 已为 users 表添加 refund_balance 列');
    }

    // Create redemption_code_uses table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS redemption_code_uses (
        id SERIAL PRIMARY KEY,
        code_id INTEGER NOT NULL REFERENCES redemption_codes(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(code_id, user_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rcu_code_user ON redemption_code_uses(code_id, user_id)`);
  } catch (err) {
    Logger.warn(`[迁移] balance/refund 表迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：用户兑换码余额明细表 ==========
async function ensureUserCodeBalancesTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_code_balances (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_id INTEGER NOT NULL REFERENCES redemption_codes(id) ON DELETE CASCADE,
        amount DECIMAL(10, 4) NOT NULL DEFAULT 0,
        fee_rate DECIMAL(5, 4) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, code_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ucb_user ON user_code_balances(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ucb_user_code ON user_code_balances(user_id, code_id)`);

    // 迁移：将已有的 refund_balance 按 redemption_code_uses 拆分到 user_code_balances
    const hasData = await pool.query(`SELECT 1 FROM user_code_balances LIMIT 1`);
    if (hasData.rows.length === 0) {
      // 查找有 refund_balance 的用户
      const usersWithRefund = await pool.query(
        `SELECT id, refund_balance FROM users WHERE refund_balance > 0`
      );
      for (const user of usersWithRefund.rows) {
        // 查找该用户使用过的可退款兑换码（按 fee_rate 降序）
        const usedCodes = await pool.query(
          `SELECT rcu.code_id, rc.amount, rc.fee_rate
           FROM redemption_code_uses rcu
           JOIN redemption_codes rc ON rc.id = rcu.code_id
           WHERE rcu.user_id = $1 AND rc.refundable = TRUE
           ORDER BY rc.fee_rate DESC`,
          [user.id]
        );
        let remaining = parseFloat(user.refund_balance);
        for (const code of usedCodes.rows) {
          if (remaining <= 0) break;
          const codeAmount = parseFloat(code.amount);
          const deduct = Math.min(remaining, codeAmount);
          await pool.query(
            `INSERT INTO user_code_balances (user_id, code_id, amount, fee_rate)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, code_id) DO UPDATE SET amount = EXCLUDED.amount`,
            [user.id, code.code_id, deduct, code.fee_rate]
          );
          remaining -= deduct;
        }
        // 如果还有剩余（没有对应兑换码记录），用 fee_rate=0 兜底
        if (remaining > 0) {
          // 找一个可退款的兑换码兜底，或跳过
          Logger.warn(`[迁移] 用户 ${user.id} 有 ¥${remaining.toFixed(4)} 退款余额无法匹配兑换码`);
        }
      }
      Logger.info('[迁移] 已将 refund_balance 拆分到 user_code_balances');
    }
  } catch (err) {
    Logger.warn(`[迁移] user_code_balances 表迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：创建对话历史表 ==========
async function ensureConversationsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) DEFAULT '新对话',
        model VARCHAR(100),
        system_prompt TEXT DEFAULT '',
        temperature REAL DEFAULT 1.0,
        max_tokens INTEGER DEFAULT 4096,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        reasoning TEXT,
        meta JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id)`);

    // 兼容旧表：添加 reasoning 和 meta 列
    const msgCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'conversation_messages'`);
    const msgColNames = msgCols.rows.map(r => r.column_name);
    if (!msgColNames.includes('reasoning')) {
      await pool.query(`ALTER TABLE conversation_messages ADD COLUMN reasoning TEXT`);
      Logger.info('[迁移] 已为 conversation_messages 表添加 reasoning 列');
    }
    if (!msgColNames.includes('meta')) {
      await pool.query(`ALTER TABLE conversation_messages ADD COLUMN meta JSONB`);
      Logger.info('[迁移] 已为 conversation_messages 表添加 meta 列');
    }
  } catch (err) {
    Logger.warn(`[迁移] conversations 表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 providers 添加 grp 列 ==========
async function ensureProvidersGrpColumn() {
  try {
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'providers' AND column_name = 'grp'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE providers ADD COLUMN grp VARCHAR(100) DEFAULT ''`);
      Logger.info('[迁移] 已为 providers 表添加 grp 列');
    }
  } catch (err) {
    Logger.warn(`[迁移] providers.grp 列添加跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 providers 添加 models_url 列 ==========
async function ensureProvidersModelsUrlColumn() {
  try {
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'providers' AND column_name = 'models_url'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE providers ADD COLUMN models_url VARCHAR(500) DEFAULT ''`);
      Logger.info('[迁移] 已为 providers 表添加 models_url 列');
    }
  } catch (err) {
    Logger.warn(`[迁移] providers.models_url 列添加跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 models 添加 series 列 ==========
async function ensureModelsSeriesColumn() {
  try {
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'series'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE models ADD COLUMN series VARCHAR(100) DEFAULT ''`);
      Logger.info('[迁移] 已为 models 表添加 series 列');
    }
  } catch (err) {
    Logger.warn(`[迁移] models.series 列添加跳过: ${err.message}`);
  }
}

// ========== 自动迁移：创建 series 表（系列图标管理） ==========
async function ensureSeriesTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS series (
        name VARCHAR(100) PRIMARY KEY,
        icon_url VARCHAR(500) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[迁移] series 表已就绪');
  } catch (err) {
    Logger.warn(`[迁移] series 表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 models 添加 alias 列 ==========
async function ensureModelsAliasColumn() {
  try {
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'alias'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE models ADD COLUMN alias VARCHAR(100) DEFAULT ''`);
      Logger.info('[迁移] 已为 models 表添加 alias 列');
    }
  } catch (err) {
    Logger.warn(`[迁移] models.alias 列添加跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 models 添加多维定价字段 ==========
async function ensureModelsPricingFields() {
  try {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'models'`);
    const colNames = cols.rows.map(r => r.column_name);
    if (!colNames.includes('completion_ratio')) {
      await pool.query(`ALTER TABLE models ADD COLUMN completion_ratio REAL DEFAULT 1.0`);
      await pool.query(`ALTER TABLE models ADD COLUMN image_ratio REAL DEFAULT 0.0`);
      await pool.query(`ALTER TABLE models ADD COLUMN audio_ratio REAL DEFAULT 0.0`);
      await pool.query(`ALTER TABLE models ADD COLUMN model_price REAL DEFAULT 0`);
      await pool.query(`ALTER TABLE models ADD COLUMN billing_mode VARCHAR(20) DEFAULT 'ratio'`);
      Logger.info('[迁移] 已为 models 表添加多维定价字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] models 多维定价字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 models 添加思考模式路由字段 ==========
async function ensureModelsThinkingFields() {
  try {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'models'`);
    const colNames = cols.rows.map(r => r.column_name);
    if (!colNames.includes('thinking_model_id')) {
      await pool.query(`ALTER TABLE models ADD COLUMN thinking_model_id VARCHAR(100) DEFAULT ''`);
      await pool.query(`ALTER TABLE models ADD COLUMN non_thinking_model_id VARCHAR(100) DEFAULT ''`);
      Logger.info('[迁移] 已为 models 表添加思考模式路由字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] models 思考模式路由字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 models 添加 reasoning_effort 透传开关 ==========
async function ensureModelsForwardReasoningEffort() {
  try {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'models'`);
    const colNames = cols.rows.map(r => r.column_name);
    if (!colNames.includes('forward_reasoning_effort')) {
      await pool.query(`ALTER TABLE models ADD COLUMN forward_reasoning_effort BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 models 表添加 forward_reasoning_effort 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] models forward_reasoning_effort 字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 models 添加 upstream_model_id 列（支持同名模型来自不同供应商） ==========
async function ensureModelsUpstreamIdColumn() {
  try {
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'upstream_model_id'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE models ADD COLUMN upstream_model_id VARCHAR(255) DEFAULT ''`);
      await pool.query(`UPDATE models SET upstream_model_id = id WHERE upstream_model_id = ''`);
      Logger.info('[迁移] 已为 models 表添加 upstream_model_id 列并迁移数据');
    }
  } catch (err) {
    Logger.warn(`[迁移] models.upstream_model_id 列添加跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 users 添加 2FA、GitHub、PassKey 字段 ==========
async function ensureAuthEnhancements() {
  try {
    // 添加 2FA 相关字段
    const twoFactorCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'two_factor_enabled'
    `);
    if (twoFactorCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN two_factor_enabled BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE users ADD COLUMN totp_secret JSONB`);
      await pool.query(`ALTER TABLE users ADD COLUMN temp_totp_secret JSONB`);
      Logger.info('[迁移] 已为 users 表添加 2FA 相关字段');
    }

    // 添加 GitHub ID 字段
    const githubCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'github_id'
    `);
    if (githubCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN github_id VARCHAR(255)`);
      Logger.info('[迁移] 已为 users 表添加 github_id 字段');
    }

    // 添加飞书 Open ID 字段
    const feishuCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'feishu_open_id'
    `);
    if (feishuCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN feishu_open_id VARCHAR(255)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_feishu_open_id ON users(feishu_open_id)`);
      Logger.info('[迁移] 已为 users 表添加 feishu_open_id 字段');
    }

    // 添加 PassKeys 字段
    const passkeysCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'passkeys'
    `);
    if (passkeysCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN passkeys JSONB DEFAULT '[]'`);
      Logger.info('[迁移] 已为 users 表添加 passkeys 字段');
    }

    // 清除历史「默认密码 123456」：视为未设置，强制用户自行设密
    await clearDefaultPasswords123456();
  } catch (err) {
    Logger.warn(`[迁移] 2FA/GitHub/PassKey 字段迁移跳过: ${err.message}`);
  }
}

/**
 * 历史 usage_records.model_id 误存了上游模型名（upstream_model_id），
 * 导致 JOIN models.id 串到其它供应商的同名模型。
 * 按 provider_id + upstream_model_id 回填为本地 models.id（幂等）。
 */
async function migrateUsageModelIdToLocalId() {
  const key = 'migration_usage_model_id_to_local_id_v1';
  try {
    const flag = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (flag.rows.length > 0) return;

    const r = await pool.query(`
      WITH resolved AS (
        SELECT DISTINCT ON (u.id)
          u.id AS usage_id,
          m.id AS local_id
        FROM usage_records u
        JOIN models m
          ON m.provider = u.provider_id
         AND m.upstream_model_id = u.model_id
        WHERE u.model_id IS NOT NULL
          AND u.provider_id IS NOT NULL
          AND m.id IS DISTINCT FROM u.model_id
        ORDER BY u.id, m.id
      )
      UPDATE usage_records u
      SET model_id = r.local_id
      FROM resolved r
      WHERE u.id = r.usage_id
    `);

    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify({ updated: r.rowCount, at: new Date().toISOString() })]
    );
    Logger.info(`[迁移] usage_records.model_id 上游名 → 本地 id，更新 ${r.rowCount} 行`);
  } catch (err) {
    Logger.warn(`[迁移] usage model_id 回填跳过: ${err.message}`);
  }
}

/**
 * 历史连接默认 TimeZone=UTC，usage_records.created_at 等 TIMESTAMP
 * （无时区）按 UTC 墙钟写入；进程/展示按上海解析后会慢 8 小时。
 * 在会话已切到 Asia/Shanghai 后，将相关表墙钟 +8h 对齐上海时间（幂等）。
 */
async function migrateUtcWallTimestampsToShanghai() {
  const key = 'migration_utc_wall_timestamps_to_shanghai_v1';
  try {
    const flag = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (flag.rows.length > 0) return;

    // 仅迁移「默认 CURRENT_TIMESTAMP、由 DB 会话墙钟写入」的表；
    // quota_data.created_at 由 Node Date 按进程本地小时写入，不在此列。
    const tables = [
      'usage_records',
      'fusion_usage_records'
    ];
    const results = {};
    for (const table of tables) {
      const exists = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      if (exists.rows.length === 0) {
        results[table] = 'skip-missing';
        continue;
      }
      const col = await pool.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'created_at'`,
        [table]
      );
      if (col.rows.length === 0) {
        results[table] = 'skip-no-created_at';
        continue;
      }
      // timestamp without time zone only
      if (col.rows[0].data_type !== 'timestamp without time zone') {
        results[table] = `skip-type:${col.rows[0].data_type}`;
        continue;
      }
      const r = await pool.query(
        `UPDATE ${table} SET created_at = created_at + INTERVAL '8 hours'`
      );
      results[table] = r.rowCount;
      Logger.info(`[迁移] ${table}.created_at UTC墙钟 → 上海墙钟，更新 ${r.rowCount} 行`);
    }

    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify({ results, at: new Date().toISOString() })]
    );
    Logger.info('[迁移] UTC 墙钟时间对齐上海完成');
  } catch (err) {
    Logger.warn(`[迁移] UTC 墙钟对齐跳过: ${err.message}`);
  }
}

/**
 * 历史 init-db 会给无密码用户写入 bcrypt(123456)。
 * 这会导致飞书用户 needsPasswordSetup 永远为 false。
 * 一次性将这些哈希清空（幂等：用 settings 标记完成）。
 */
async function clearDefaultPasswords123456() {
  try {
    const flag = await pool.query(
      "SELECT value FROM settings WHERE key = 'migration_clear_default_password_123456'"
    );
    if (flag.rows.length > 0) return;

    const bcrypt = require('bcryptjs');
    const users = await pool.query(
      `SELECT id, username, password_hash, feishu_open_id
       FROM users
       WHERE password_hash IS NOT NULL AND password_hash <> ''`
    );

    let cleared = 0;
    for (const u of users.rows) {
      try {
        const isDefault = await bcrypt.compare('123456', u.password_hash);
        if (isDefault) {
          await pool.query('UPDATE users SET password_hash = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [u.id]);
          cleared++;
          Logger.info(`[迁移] 已清除用户 ${u.username}(id=${u.id}) 的默认密码 123456${u.feishu_open_id ? ' [飞书]' : ''}`);
        }
      } catch (e) {
        // 单个用户失败不影响整体
      }
    }

    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['migration_clear_default_password_123456', JSON.stringify({ cleared, at: new Date().toISOString() })]
    );
    Logger.info(`[迁移] 默认密码 123456 清理完成，共 ${cleared} 个账号`);
  } catch (err) {
    Logger.warn(`[迁移] 清理默认密码跳过: ${err.message}`);
  }
}

// ========== 自动迁移：邮箱验证状态字段 ==========
async function ensureEmailVerification() {
  try {
    const emailVerifiedCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'email_verified'
    `);
    if (emailVerifiedCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT TRUE`);
      Logger.info('[迁移] 已为 users 表添加 email_verified 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] 邮箱验证字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：Bark 通知与用户通知 ==========
async function ensureNotificationSettings() {
  try {
    const columns = [
      ['bark_enabled', 'BOOLEAN DEFAULT FALSE'],
      ['bark_server_key', 'TEXT'],
      ['bark_endpoint', "VARCHAR(500) DEFAULT 'https://api.day.app'"],
      ['notify_quota_enabled', 'BOOLEAN DEFAULT TRUE'],
      ['notify_error_enabled', 'BOOLEAN DEFAULT TRUE'],
    ];
    for (const [name, definition] of columns) {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${definition}`);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created ON user_notifications(user_id, created_at DESC)');
    Logger.info('[迁移] Bark 通知与用户通知表已就绪');
  } catch (err) {
    Logger.warn(`[迁移] Bark 通知迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：额度预警相关字段 ==========
async function ensureBalanceAlertSettings() {
  try {
    // 添加预警设置字段到 users 表
    const alertEnabledCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'alert_enabled'
    `);
    if (alertEnabledCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN alert_enabled BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE users ADD COLUMN alert_balance_threshold DECIMAL(10, 4) DEFAULT 5`);
      await pool.query(`ALTER TABLE users ADD COLUMN alert_daily_usage_threshold DECIMAL(10, 4) DEFAULT 50`);
      Logger.info('[迁移] 已为 users 表添加预警设置字段');
    }

    // 创建预警记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS balance_alerts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        alert_type VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_balance_alerts_user ON balance_alerts(user_id, alert_type, sent_at)`);
    Logger.info('[迁移] 表 balance_alerts 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] 额度预警字段迁移跳过: ${err.message}`);
  }
}

// 添加 usage_records 扩展字段
async function ensureTraceSessionTables() {
  try {
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS active_trace_session_id INTEGER`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trace_sessions (
        id SERIAL PRIMARY KEY,
        public_id VARCHAR(32) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
        request_source VARCHAR(32) DEFAULT 'unknown',
        user_agent VARCHAR(500),
        status VARCHAR(20) NOT NULL DEFAULT 'recording',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        viewed_at TIMESTAMP,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id BIGSERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES trace_sessions(id) ON DELETE CASCADE,
        usage_record_id INTEGER REFERENCES usage_records(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ok BOOLEAN NOT NULL DEFAULT TRUE,
        http_status INTEGER,
        error TEXT,
        request_type VARCHAR(50), request_source VARCHAR(32), user_agent VARCHAR(500), ip_address VARCHAR(45),
        model_id VARCHAR(255), provider_id VARCHAR(100),
        tokens_used BIGINT DEFAULT 0, prompt_tokens BIGINT DEFAULT 0, completion_tokens BIGINT DEFAULT 0,
        cached_tokens BIGINT DEFAULT 0, weighted_tokens BIGINT DEFAULT 0, cost NUMERIC(18,6) DEFAULT 0,
        latency_ms INTEGER, messages JSONB, response TEXT, reasoning_content TEXT, request_params JSONB, finish_reason VARCHAR(50)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trace_sessions_user ON trace_sessions(user_id, started_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trace_events_session ON trace_events(session_id, created_at)`);
    Logger.info('[迁移] 跟踪记录表已就绪');
  } catch (err) { Logger.warn(`[迁移] 跟踪记录表迁移跳过: ${err.message}`); }
}

// 添加 usage_records 扩展字段
async function ensureUsageRecordsFields() {
  try {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_records'`);
    const colNames = cols.rows.map(r => r.column_name);
    if (!colNames.includes('prompt_tokens')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN prompt_tokens INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN completion_tokens INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN provider_id VARCHAR(100)`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN request_type VARCHAR(50)`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN latency_ms INTEGER`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN ip_address VARCHAR(45)`);
      Logger.info('[迁移] 已为 usage_records 表添加扩展字段');
    }
    if (!colNames.includes('messages')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN messages JSONB`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN response TEXT`);
      Logger.info('[迁移] 已为 usage_records 表添加 messages/response 字段');
    }
    if (!colNames.includes('reasoning_content')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN reasoning_content TEXT`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN request_params JSONB`);
      await pool.query(`ALTER TABLE usage_records ADD COLUMN finish_reason VARCHAR(50)`);
      Logger.info('[迁移] 已为 usage_records 表添加 reasoning_content/request_params/finish_reason 字段');
    }
    if (!colNames.includes('cached_tokens')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN cached_tokens INTEGER DEFAULT 0`);
      Logger.info('[迁移] 已为 usage_records 表添加 cached_tokens 字段');
    }
    // Playground 历史软删标记：隐藏历史列表但不删除用量明细
    if (!colNames.includes('history_hidden')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN history_hidden BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 usage_records 表添加 history_hidden 字段');
    }
    // Harness 客户端来源（Grok / Codex / Claude Code / OpenCode）
    if (!colNames.includes('request_source')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN request_source VARCHAR(32) DEFAULT 'unknown'`);
      Logger.info('[迁移] 已为 usage_records 表添加 request_source 字段');
    }
    if (!colNames.includes('user_agent')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN user_agent VARCHAR(500)`);
      Logger.info('[迁移] 已为 usage_records 表添加 user_agent 字段');
    }
    // 常用查询索引
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_user_created ON usage_records (user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_created ON usage_records (created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_request_type_created ON usage_records (request_type, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_records_request_source_created ON usage_records (request_source, created_at DESC)`);
  } catch (err) {
    Logger.warn(`[迁移] usage_records 扩展字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：消息结构分析持久化表 ==========
async function ensureUsageMessageAnalysisTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usage_message_analysis (
        id SERIAL PRIMARY KEY,
        usage_id INTEGER NOT NULL REFERENCES usage_records(id) ON DELETE CASCADE UNIQUE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL,
        analyzed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        request_source VARCHAR(32) NOT NULL DEFAULT 'unknown',
        workspace_path TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        total_characters INTEGER NOT NULL DEFAULT 0,
        total_lines INTEGER NOT NULL DEFAULT 0,
        metadata_message_count INTEGER NOT NULL DEFAULT 0,
        has_workspace_path BOOLEAN NOT NULL DEFAULT FALSE,
        has_git_status BOOLEAN NOT NULL DEFAULT FALSE,
        has_project_layout BOOLEAN NOT NULL DEFAULT FALSE,
        has_environment_context BOOLEAN NOT NULL DEFAULT FALSE,
        block_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
        observed_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        "values" JSONB NOT NULL DEFAULT '{}'::jsonb,
        tokens_used BIGINT NOT NULL DEFAULT 0,
        cost DECIMAL(20, 8) NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_uma_created ON usage_message_analysis(created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_uma_user_created ON usage_message_analysis(user_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_uma_source_created ON usage_message_analysis(request_source, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_uma_workspace ON usage_message_analysis(workspace_path)`);
    Logger.info('[迁移] 表 usage_message_analysis 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] usage_message_analysis 表迁移跳过: ${err.message}`);
  }
}

async function backfillUsageRecords() {
  try {
    const result = await pool.query(
      `UPDATE usage_records
       SET prompt_tokens = tokens_used
       WHERE prompt_tokens = 0 AND tokens_used > 0`
    );
    if (result.rowCount > 0) {
      Logger.info(`[迁移] 已回填 ${result.rowCount} 条历史记录的 prompt_tokens`);
    }
  } catch (err) {
    Logger.warn(`[迁移] usage_records 回填跳过: ${err.message}`);
  }
}

// ========== 自动迁移：商品表 ==========
async function ensureProductsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 4) DEFAULT 0,
        image_url TEXT,
        link TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migration: add link if missing
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products' AND column_name = 'link'
    `);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE products ADD COLUMN link TEXT`);
      Logger.info('[迁移] 已为 products 表添加 link 列');
    }
    Logger.info('[迁移] 表 products 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] products 表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：按小时聚合使用数据表 ==========
async function ensureQuotaDataTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quota_data (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        token_used INTEGER DEFAULT 0,
        count INTEGER DEFAULT 0,
        quota DECIMAL(10, 4) DEFAULT 0
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_quota_data_user ON quota_data(user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_quota_data_model ON quota_data(model_name, created_at DESC)`);
    // 添加唯一约束以支持 ON CONFLICT
    try {
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_data_unique ON quota_data(user_id, model_name, created_at)`);
    } catch (e) {
      // 索引可能已存在，忽略
    }
    Logger.info('[迁移] 表 quota_data 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] quota_data 表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：CrewRouter Team 系统 ==========
async function ensureTeamsTables() {
  try {
    // 创建 teams 表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[迁移] 表 teams 已就绪');

    // 为 teams 添加 is_default 字段（默认 Team 功能）
    const isDefaultCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'teams' AND column_name = 'is_default'
    `);
    if (isDefaultCol.rows.length === 0) {
      await pool.query(`ALTER TABLE teams ADD COLUMN is_default BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 teams 表添加 is_default 字段');
    }

    // 为 teams 添加 is_frontier 字段（前沿 team，新模型自动添加）
    const isFrontierCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'teams' AND column_name = 'is_frontier'
    `);
    if (isFrontierCol.rows.length === 0) {
      await pool.query(`ALTER TABLE teams ADD COLUMN is_frontier BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 teams 表添加 is_frontier 字段');
    }

    // 为 users 添加 team_id 字段（保留兼容）
    const teamIdCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'team_id'
    `);
    if (teamIdCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL`);
      Logger.info('[迁移] 已为 users 表添加 team_id 字段');
    }

    // 创建 user_teams 表（用户与 Team 多对多关系）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_teams (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, team_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_teams_user ON user_teams(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_teams_team ON user_teams(team_id)`);
    Logger.info('[迁移] 表 user_teams 已就绪');

    // 迁移旧数据：将 users.team_id 复制到 user_teams
    try {
      const hasOldData = await pool.query(`
        SELECT 1 FROM users WHERE team_id IS NOT NULL LIMIT 1
      `);
      if (hasOldData.rows.length > 0) {
        await pool.query(`
          INSERT INTO user_teams (user_id, team_id)
          SELECT id, team_id FROM users WHERE team_id IS NOT NULL
          ON CONFLICT (user_id, team_id) DO NOTHING
        `);
        Logger.info('[迁移] 已将 users.team_id 数据迁移到 user_teams');
      }
    } catch (e) {
      // 忽略迁移错误
    }

    // 创建 team_models 表（Team 可用的模型映射）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_models (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        enabled BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(team_id, model_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_team_models_team ON team_models(team_id)`);
    Logger.info('[迁移] 表 team_models 已就绪');

    // 为 api_keys 添加 CrewRouter 字段
    const customNameCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'api_keys' AND column_name = 'custom_model_name'
    `);
    if (customNameCol.rows.length === 0) {
      await pool.query(`ALTER TABLE api_keys ADD COLUMN custom_model_name VARCHAR(200) DEFAULT 'claude-fable-5'`);
      await pool.query(`ALTER TABLE api_keys ADD COLUMN current_model_id VARCHAR(100)`);
      Logger.info('[迁移] 已为 api_keys 表添加 custom_model_name 和 current_model_id 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] CrewRouter Team 系统迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：用户模型库排序 ==========
async function ensureUserModelLibraryOrderTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_team_orders (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_provider_orders (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        provider_id VARCHAR(100) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id, provider_id)
      )
    `);
    await pool.query(`
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_mlo_team_user_order ON user_model_library_team_orders(user_id, sort_order)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_mlo_provider_user_team_order ON user_model_library_provider_orders(user_id, team_id, sort_order)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_mlo_model_user_team_provider_order ON user_model_library_model_orders(user_id, team_id, provider_id, sort_order)`);
    Logger.info('[迁移] 用户模型库排序表已就绪');
  } catch (err) {
    Logger.warn(`[迁移] 用户模型库排序表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：用户模型库隐藏偏好 ==========
async function ensureUserModelLibraryHiddenTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_hidden_providers (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        provider_id VARCHAR(100) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id, provider_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_hidden_models (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        provider_id VARCHAR(100) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id, provider_id, model_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_mlh_provider_user_team ON user_model_library_hidden_providers(user_id, team_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_mlh_model_user_team_provider ON user_model_library_hidden_models(user_id, team_id, provider_id)`);
    Logger.info('[迁移] 用户模型库隐藏偏好表已就绪');
  } catch (err) {
    Logger.warn(`[迁移] 用户模型库隐藏偏好表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：用户模型库星标 ==========
async function ensureUserModelLibraryStarredTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_model_library_starred_models (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        provider_id VARCHAR(100) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, team_id, provider_id, model_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_mls_user_created ON user_model_library_starred_models(user_id, created_at DESC)`);
    Logger.info('[迁移] 用户模型库星标表已就绪');
  } catch (err) {
    Logger.warn(`[迁移] 用户模型库星标表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：API Key 模型映射 ==========
async function ensureApiKeyModelsTable() {
  try {
    // 创建 api_key_models 表（API Key 可用的模型映射 / 有序队列）
    await pool.query(`
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
    await pool.query(`ALTER TABLE api_key_models ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_akm_api_key ON api_key_models(api_key_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_akm_key_order ON api_key_models(api_key_id, sort_order)`);
    Logger.info('[迁移] 表 api_key_models 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] API Key 模型映射迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：API Key 按 Harness 单独绑定模型 ==========
async function ensureApiKeyHarnessModelsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_key_harness_models (
        id SERIAL PRIMARY KEY,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        harness VARCHAR(32) NOT NULL,
        model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(api_key_id, harness)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_akhm_api_key ON api_key_harness_models(api_key_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_akhm_model ON api_key_harness_models(model_id)`);
    Logger.info('[迁移] 表 api_key_harness_models 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] API Key Harness 模型绑定迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：Co-Key 成员 ==========
async function ensureApiKeyMembersTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_key_members (
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key_id, user_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_key_members_user ON api_key_members(user_id, api_key_id)`);
    Logger.info('[迁移] 表 api_key_members 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] Co-Key 成员表迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：操作日志 ==========
async function ensureOperationLogsTable() {
  try {
    await pool.query(`
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_user_created ON operation_logs(user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_created ON operation_logs(created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_action ON operation_logs(action)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_op_logs_resource ON operation_logs(resource_type, resource_id)`);
    Logger.info('[迁移] 表 operation_logs 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] 操作日志表迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：API Key 标签系统 ==========
async function ensureKeyTagsTables() {
  try {
    // 创建 key_tags 表（标签定义，按用户隔离）
    await pool.query(`
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_key_tags_user ON key_tags(user_id, sort_order)`);
    Logger.info('[迁移] 表 key_tags 已就绪');

    // 创建 api_key_tags 表（Key↔标签多对多关联）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_key_tags (
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES key_tags(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key_id, tag_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_key_tags_tag ON api_key_tags(tag_id)`);
    Logger.info('[迁移] 表 api_key_tags 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] API Key 标签系统迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：用户组系统 ==========
async function ensureUserGroupsTables() {
  try {
    // 创建 user_groups 表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[迁移] 表 user_groups 已就绪');

    // 创建 user_group_rules 表（用户组规则）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_group_rules (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        rule_type VARCHAR(50) NOT NULL,
        rule_value BIGINT NOT NULL DEFAULT 0,
        duration_hours INTEGER,
        description TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ugr_group ON user_group_rules(group_id)`);
    Logger.info('[迁移] 表 user_group_rules 已就绪');

    // 为 users 添加 group_id 字段
    const groupIdCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'group_id'
    `);
    if (groupIdCol.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES user_groups(id) ON DELETE SET NULL`);
      Logger.info('[迁移] 已为 users 表添加 group_id 字段');
    }

    // 为 user_groups 添加 is_default 字段
    await pool.query(`ALTER TABLE user_groups ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE`);
    Logger.info('[迁移] user_groups.is_default 字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] 用户组系统迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：兼容字段 + 个人账户 Team ==========
// 默认 API Key 仅在用户注册/OOBE 时创建，与普通 Key 相同、可删除；启动时不再强制补建。
async function ensureReservedResources() {
  try {
    // 为 api_keys 添加 is_system 字段（历史兼容，不再赋予特殊语义）
    const isSystemCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'api_keys' AND column_name = 'is_system'
    `);
    if (isSystemCol.rows.length === 0) {
      await pool.query(`ALTER TABLE api_keys ADD COLUMN is_system BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 api_keys 表添加 is_system 字段');
    }

    // 清除历史「系统保留」标记，全部按普通 Key 处理
    try {
      const cleared = await pool.query(
        `UPDATE api_keys SET is_system = FALSE WHERE is_system = TRUE`
      );
      if (cleared.rowCount > 0) {
        Logger.info(`[迁移] 已将 ${cleared.rowCount} 个系统保留 Key 降为普通 Key（可删除）`);
      }
    } catch (e) {
      Logger.warn(`[迁移] 清除 is_system 标记跳过: ${e.message}`);
    }

    // 为 teams 添加 is_personal 字段
    const isPersonalCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'teams' AND column_name = 'is_personal'
    `);
    if (isPersonalCol.rows.length === 0) {
      await pool.query(`ALTER TABLE teams ADD COLUMN is_personal BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 teams 表添加 is_personal 字段');
    }

    // 为现有用户补建个人账户 Team
    const usersWithoutTeam = await pool.query(`
      SELECT u.id, u.username FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM user_teams ut JOIN teams t ON ut.team_id = t.id
        WHERE ut.user_id = u.id AND t.is_personal = TRUE
      )
    `);
    for (const user of usersWithoutTeam.rows) {
      const teamName = `${user.username} 的个人账户`;
      try {
        const teamResult = await pool.query(
          'INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id',
          [teamName, '个人账户，系统自动创建']
        );
        const teamId = teamResult.rows[0].id;
        await pool.query(
          'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [user.id, teamId]
        );
        Logger.info(`[迁移] 已为用户 ${user.username} 创建个人账户 Team`);
      } catch (e) {
        // 名称冲突等错误忽略
        Logger.warn(`[迁移] 为用户 ${user.username} 创建个人账户 Team 跳过: ${e.message}`);
      }
    }
    if (usersWithoutTeam.rows.length > 0) {
      Logger.info(`[迁移] 共为 ${usersWithoutTeam.rows.length} 个用户补建了个人账户 Team`);
    }
  } catch (err) {
    Logger.warn(`[迁移] 个人账户/兼容字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加 quota_script 字段（额度查询脚本）
async function ensureProviderQuotaScript() {
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'providers' AND column_name = 'quota_script'
    `);
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE providers ADD COLUMN quota_script TEXT DEFAULT ''`);
      Logger.info('[迁移] 已为 providers 表添加 quota_script 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] quota_script 字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加 Grok OIDC 刷新字段
async function ensureProviderGrokOAuthColumns() {
  try {
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS oauth_issuer VARCHAR(500)`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS oauth_client_id VARCHAR(200)`);
    Logger.info('[迁移] providers Grok OIDC 字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] providers Grok OIDC 字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加 quota_mode 字段（额度查询方式）
async function ensureProviderQuotaMode() {
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'providers' AND column_name = 'quota_mode'
    `);
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE providers ADD COLUMN quota_mode VARCHAR(32) DEFAULT 'script'`);
      Logger.info('[迁移] 已为 providers 表添加 quota_mode 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] quota_mode 字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加 quota_enabled 字段（额度查询开关）
async function ensureProviderQuotaEnabled() {
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'providers' AND column_name = 'quota_enabled'
    `);
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE providers ADD COLUMN quota_enabled BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 providers 表添加 quota_enabled 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] quota_enabled 字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加火山方舟查询凭据与参数字段
async function ensureProviderArkUsageColumns() {
  try {
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_access_key TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_secret_key TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_region VARCHAR(64) DEFAULT 'cn-north-1'`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_service VARCHAR(64) DEFAULT 'ark'`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_usage_action VARCHAR(64) DEFAULT 'GetInferenceUsage'`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_usage_params JSONB DEFAULT '{}'::jsonb`);
    Logger.info('[迁移] providers 火山方舟额度字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] 火山方舟额度字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加 notes 字段（供应商备注）
async function ensureProviderNotes() {
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'providers' AND column_name = 'notes'
    `);
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE providers ADD COLUMN notes TEXT DEFAULT ''`);
      Logger.info('[迁移] 已为 providers 表添加 notes 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] notes 字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加测试配置：模型测试时使用的 User-Agent
async function ensureProviderTestUserAgent() {
  try {
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS test_user_agent TEXT DEFAULT ''`);
    Logger.info('[迁移] providers.test_user_agent 字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] providers.test_user_agent 字段迁移跳过: ${err.message}`);
  }
}

// 为 providers 添加额度定时查询字段
async function ensureProviderQuotaSchedule() {
  try {
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_schedule_enabled BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_schedule_interval INTEGER DEFAULT 3600`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_checked_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_ok BOOLEAN`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_result JSONB`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_error TEXT`);
    Logger.info('[迁移] providers 额度定时查询字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] providers 额度定时查询字段迁移跳过: ${err.message}`);
  }
}

// 为 models 添加 created_by 字段（标记用户自建模型）
async function ensureModelCreatedBy() {
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'models' AND column_name = 'created_by'
    `);
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE models ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
      Logger.info('[迁移] 已为 models 表添加 created_by 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] created_by 字段迁移跳过: ${err.message}`);
  }
}

// 扩大 providers.api_key 字段长度（VARCHAR(500) → TEXT，兼容长密钥）
async function ensureProviderApiKeyLength() {
  try {
    const col = await pool.query(`
      SELECT data_type, character_maximum_length FROM information_schema.columns
      WHERE table_name = 'providers' AND column_name = 'api_key'
    `);
    if (col.rows.length > 0 && col.rows[0].data_type === 'character varying') {
      await pool.query(`ALTER TABLE providers ALTER COLUMN api_key TYPE TEXT`);
      Logger.info('[迁移] 已将 providers.api_key 字段类型扩展为 TEXT');
    }
  } catch (err) {
    Logger.warn(`[迁移] providers.api_key 字段类型扩展跳过: ${err.message}`);
  }
}

// 为 providers 添加动态密钥相关字段
async function ensureProviderKeyScript() {
  const columns = [
    { name: 'key_mode', type: "VARCHAR(20) DEFAULT 'fixed'" },
    { name: 'key_script', type: "TEXT DEFAULT ''" },
    { name: 'key_refresh_interval', type: 'INTEGER DEFAULT 3600' },
    { name: 'key_expires_at', type: 'TIMESTAMP' },
    { name: 'key_last_refresh_at', type: 'TIMESTAMP' },
    { name: 'key_last_error', type: 'TEXT' }
  ];
  for (const col of columns) {
    try {
      const existing = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'providers' AND column_name = $1
      `, [col.name]);
      if (existing.rows.length === 0) {
        await pool.query(`ALTER TABLE providers ADD COLUMN ${col.name} ${col.type}`);
        Logger.info(`[迁移] 已为 providers 表添加 ${col.name} 字段`);
      }
    } catch (err) {
      Logger.warn(`[迁移] ${col.name} 字段迁移跳过: ${err.message}`);
    }
  }
}

// ========== 自动迁移：为 api_keys 添加 Fusion 配置字段 ==========
async function ensureApiKeyFusionConfig() {
  try {
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'api_keys' AND column_name = 'fusion_panel_models'
    `);
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE api_keys ADD COLUMN fusion_panel_models JSONB DEFAULT '[]'::jsonb`);
      await pool.query(`ALTER TABLE api_keys ADD COLUMN fusion_judge_model_id VARCHAR(100) DEFAULT ''`);
      await pool.query(`ALTER TABLE api_keys ADD COLUMN fusion_outer_model_id VARCHAR(100) DEFAULT ''`);
      Logger.info('[迁移] 已为 api_keys 表添加 Fusion 配置字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] api_keys Fusion 字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 api_keys 添加 fusion_enabled 字段 ==========
async function ensureApiKeyFusionEnabled() {
  try {
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS fusion_enabled BOOLEAN DEFAULT TRUE`);
    Logger.info('[迁移] api_keys 表 fusion_enabled 字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] api_keys fusion_enabled 字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：创建 Fusion 配置表 ==========
async function ensureFusionTables() {
  try {
    // Fusion 配置表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fusion_configs (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        panel_models JSONB NOT NULL DEFAULT '[]',
        judge_model_id VARCHAR(100) NOT NULL DEFAULT '',
        outer_model_id VARCHAR(100) NOT NULL DEFAULT '',
        enabled BOOLEAN DEFAULT TRUE,
        is_default BOOLEAN DEFAULT FALSE,
        max_panel_count INTEGER DEFAULT 8,
        temperature REAL DEFAULT 0.7,
        max_tokens INTEGER DEFAULT 4096,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[迁移] 表 fusion_configs 已就绪');

    // Fusion 用量记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fusion_usage_records (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
        config_id INTEGER REFERENCES fusion_configs(id) ON DELETE SET NULL,
        panel_results JSONB NOT NULL DEFAULT '[]',
        judge_result JSONB,
        final_content TEXT,
        total_tokens INTEGER DEFAULT 0,
        total_cost DECIMAL(10, 4) DEFAULT 0,
        latency_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fusion_usage_user ON fusion_usage_records(user_id, created_at)`);
    Logger.info('[迁移] 表 fusion_usage_records 已就绪');

    // 插入默认 Fusion 配置（如果不存在或配置无效）
    const defaultConfig = await pool.query(`SELECT id, panel_models, judge_model_id FROM fusion_configs WHERE is_default = TRUE LIMIT 1`);
    let needInsert = defaultConfig.rows.length === 0;

    // 检查现有配置是否有效（panel_models 是否是有效的模型）
    if (!needInsert && defaultConfig.rows[0]) {
      const config = defaultConfig.rows[0];
      const panelModels = config.panel_models || [];
      // 检查第一个 panel 模型是否存在
      if (panelModels.length > 0) {
        const firstModel = await pool.query("SELECT id FROM models WHERE (id = $1 OR upstream_model_id = $1 OR alias = $1) AND enabled = TRUE", [panelModels[0]]);
        if (firstModel.rows.length === 0) {
          // 模型不存在，删除旧配置
          await pool.query('DELETE FROM fusion_configs WHERE id = $1', [config.id]);
          needInsert = true;
          Logger.info('[迁移] 旧 Fusion 配置无效，将重新创建');
        }
      }
    }

    if (needInsert) {
      // 查找可用的模型 ID
      const claudeSonnet = await pool.query("SELECT upstream_model_id FROM models WHERE upstream_model_id LIKE 'claude-sonnet%' AND enabled = TRUE LIMIT 1");
      const gptModel = await pool.query("SELECT upstream_model_id FROM models WHERE upstream_model_id LIKE 'gpt%' AND enabled = TRUE LIMIT 1");
      const geminiModel = await pool.query("SELECT upstream_model_id FROM models WHERE upstream_model_id LIKE 'gemini%' AND enabled = TRUE LIMIT 1");

      const panelModels = [
        claudeSonnet.rows[0]?.upstream_model_id || 'claude-sonnet-4-20250514',
        gptModel.rows[0]?.upstream_model_id || 'gpt-5.5',
        geminiModel.rows[0]?.upstream_model_id || 'gemini-2.5-pro'
      ];
      const judgeModel = claudeSonnet.rows[0]?.upstream_model_id || 'claude-sonnet-4-20250514';

      await pool.query(`
        INSERT INTO fusion_configs (name, description, panel_models, judge_model_id, outer_model_id, is_default, enabled)
        VALUES ('general', '通用 Fusion 配置', $1::jsonb, $2, $2, TRUE, TRUE)
      `, [JSON.stringify(panelModels), judgeModel]);
      Logger.info('[迁移] 已插入默认 Fusion 配置');
    }
  } catch (err) {
    Logger.warn(`[迁移] Fusion 表迁移跳过: ${err.message}`);
  }
}
// ========== 自动迁移：为 users 添加 API 签名设置字段 ==========
async function ensureApiSignatureColumns() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_signature_enabled BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ALTER COLUMN api_signature_enabled SET DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_signature_template TEXT DEFAULT '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}'`);
    Logger.info('[迁移] users 表 API 签名字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] users API 签名字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 api_keys 添加独立签名设置字段 ==========
async function ensureApiKeySignatureColumns() {
  try {
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS signature_enabled BOOLEAN DEFAULT NULL`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS signature_template TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS quota_warning_enabled BOOLEAN DEFAULT TRUE`);
    await pool.query(`ALTER TABLE api_keys ALTER COLUMN quota_warning_enabled SET DEFAULT TRUE`);
    const migrationKey = 'migration_enable_quota_warning_for_all_api_keys_v1';
    const migration = await pool.query('SELECT 1 FROM settings WHERE key = $1', [migrationKey]);
    if (migration.rows.length === 0) {
      const updated = await pool.query('UPDATE api_keys SET quota_warning_enabled = TRUE');
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [migrationKey, JSON.stringify({ updated: updated.rowCount, at: new Date().toISOString() })]
      );
      Logger.info(`[迁移] 已为现有全部 API Key 启用额度预警，共 ${updated.rowCount} 个`);
    }
    Logger.info('[迁移] api_keys 表独立签名字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] api_keys 签名字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：供应商多 API Key（固定密钥列表 + 选择模式） ==========
async function ensureProviderMultiApiKeyColumns() {
  try {
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS api_keys JSONB DEFAULT NULL`);
    await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS api_key_select_mode VARCHAR(20) DEFAULT 'order'`);
    // 将仅有单 api_key、尚无 api_keys 的供应商回填为数组，便于统一读取
    await pool.query(`
      UPDATE providers
      SET api_keys = jsonb_build_array(jsonb_build_object('key', api_key, 'weight', 1))
      WHERE (api_keys IS NULL OR api_keys = 'null'::jsonb OR api_keys = '[]'::jsonb)
        AND api_key IS NOT NULL
        AND TRIM(api_key) <> ''
    `);
    Logger.info('[迁移] providers 多 API Key 字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] providers 多 API Key 字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 api_keys 添加启用/调度字段 ==========
async function ensureApiKeyEnabledColumns() {
  try {
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS schedule_on_time TIME`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS schedule_off_time TIME`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS schedule_days INTEGER[] DEFAULT '{0,1,2,3,4,5,6}'`);
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS schedule_timezone VARCHAR(50) DEFAULT 'Asia/Shanghai'`);
    Logger.info('[迁移] api_keys 表启用/调度字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] api_keys 启用/调度字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 api_keys 添加吞图字段 ==========
async function ensureApiKeySwallowImages() {
  try {
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS swallow_images BOOLEAN DEFAULT FALSE`);
    Logger.info('[迁移] api_keys 表 swallow_images 字段已就绪');
  } catch (err) {
    Logger.warn(`[迁移] api_keys swallow_images 字段迁移跳过: ${err.message}`);
  }
}

async function ensureApiKeyCrewRouterCommands() {
  try {
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS crewrouter_commands BOOLEAN DEFAULT TRUE`);
    await pool.query(`ALTER TABLE api_keys ALTER COLUMN crewrouter_commands SET DEFAULT TRUE`);
    Logger.info('[迁移] api_keys 表 crewrouter_commands 字段已就绪（默认开启，新建 Key 默认允许）');
  } catch (err) {
    Logger.warn(`[迁移] api_keys crewrouter_commands 字段迁移跳过: ${err.message}`);
  }
}

// 用量记录保留，删除 API Key 时将 api_key_id 置空（否则有用量的密钥无法删除）
async function ensureUsageRecordsApiKeyOnDeleteSetNull() {
  try {
    const { rows } = await pool.query(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'usage_records'
        AND c.contype = 'f'
        AND pg_get_constraintdef(c.oid) LIKE '%api_key_id%'
    `);
    const needsFix = rows.some((r) => r.def && !/ON DELETE SET NULL/i.test(r.def));
    if (!needsFix && rows.length > 0) {
      Logger.info('[迁移] usage_records.api_key_id ON DELETE SET NULL 已就绪');
      return;
    }
    for (const r of rows) {
      await pool.query(`ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS ${r.conname}`);
    }
    await pool.query(`
      ALTER TABLE usage_records
      ADD CONSTRAINT usage_records_api_key_id_fkey
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
    `);
    Logger.info('[迁移] usage_records.api_key_id 已改为 ON DELETE SET NULL');
  } catch (err) {
    Logger.warn(`[迁移] usage_records api_key_id 外键迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 providers 添加代理池字段 ==========
async function ensureProviderProxyPool() {
  try {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'providers'`);
    const colNames = cols.rows.map(r => r.column_name);
    if (!colNames.includes('proxy_pool')) {
      await pool.query(`ALTER TABLE providers ADD COLUMN proxy_pool TEXT DEFAULT '[]'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN proxy_enabled BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 providers 表添加代理池字段');
    }
    if (!colNames.includes('proxy_subscription_url')) {
      await pool.query(`ALTER TABLE providers ADD COLUMN proxy_subscription_url TEXT DEFAULT ''`);
      Logger.info('[迁移] 已为 providers 表添加代理池订阅地址字段');
    }
    if (!colNames.includes('proxy_mode')) {
      await pool.query(`ALTER TABLE providers ADD COLUMN proxy_mode VARCHAR(20) DEFAULT 'pool'`);
      Logger.info('[迁移] 已为 providers 表添加 proxy_mode 字段');
    }
    if (!colNames.includes('proxy_url')) {
      await pool.query(`ALTER TABLE providers ADD COLUMN proxy_url TEXT DEFAULT ''`);
      Logger.info('[迁移] 已为 providers 表添加 proxy_url 字段');
    }
    if (!colNames.includes('proxy_use_system')) {
      await pool.query(`ALTER TABLE providers ADD COLUMN proxy_use_system BOOLEAN DEFAULT FALSE`);
      Logger.info('[迁移] 已为 providers 表添加 proxy_use_system 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] providers 代理池字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：为 providers 添加 header 转发相关字段 ==========
async function ensureProviderHeaderFields() {
  try {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'providers'`);
    const colNames = cols.rows.map(r => r.column_name);
    if (!colNames.includes('content_type_mode')) {
      await pool.query(`ALTER TABLE providers ADD COLUMN content_type_mode VARCHAR(20) DEFAULT 'hardcoded'`);
      Logger.info('[迁移] 已为 providers 表添加 content_type_mode 字段');
    }
    if (!colNames.includes('forward_headers')) {
      await pool.query(`ALTER TABLE providers ADD COLUMN forward_headers BOOLEAN DEFAULT TRUE`);
      Logger.info('[迁移] 已为 providers 表添加 forward_headers 字段');
    }
  } catch (err) {
    Logger.warn(`[迁移] providers header 转发字段迁移跳过: ${err.message}`);
  }
}

// ========== API Key 定时调度引擎 ==========
async function runApiKeyScheduler() {
  const { invalidateApiKeyCacheByKeyId: invalidateKey } = require('./routes/api');
  try {
    const result = await pool.query(
      `SELECT id, user_id, enabled, schedule_on_time, schedule_off_time, schedule_days, schedule_timezone
       FROM api_keys WHERE schedule_enabled = TRUE
         AND schedule_on_time IS NOT NULL
         AND schedule_off_time IS NOT NULL`
    );

    for (const key of result.rows) {
      try {
        const tz = key.schedule_timezone || 'Asia/Shanghai';
        const now = new Date();

        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          weekday: 'short'
        });
        const parts = formatter.formatToParts(now);
        const hour = parseInt(parts.find(p => p.type === 'hour').value);
        const minute = parseInt(parts.find(p => p.type === 'minute').value);
        const weekdayStr = parts.find(p => p.type === 'weekday').value;
        const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const currentDay = weekdayMap[weekdayStr];
        const currentMinutes = hour * 60 + minute;

        const parseTime = (t) => {
          const [h, m] = t.split(':').map(Number);
          return h * 60 + m;
        };

        const scheduledDays = key.schedule_days || [0, 1, 2, 3, 4, 5, 6];
        if (!scheduledDays.includes(currentDay)) continue;

        const onTime = parseTime(key.schedule_on_time);
        const offTime = parseTime(key.schedule_off_time);

        let shouldBeEnabled;
        if (onTime < offTime) {
          shouldBeEnabled = currentMinutes >= onTime && currentMinutes < offTime;
        } else {
          shouldBeEnabled = currentMinutes >= onTime || currentMinutes < offTime;
        }

        if (shouldBeEnabled && !key.enabled) {
          await pool.query('UPDATE api_keys SET enabled = TRUE WHERE id = $1', [key.id]);
          const { invalidateApiKeyCacheByKeyId: invalidateKey } = require('./routes/api');
          invalidateKey(key.id);
          Logger.info(`[调度器] 自动启用密钥 ${key.id} (user ${key.user_id})`);
        } else if (!shouldBeEnabled && key.enabled) {
          await pool.query('UPDATE api_keys SET enabled = FALSE WHERE id = $1', [key.id]);
          const { invalidateApiKeyCacheByKeyId: invalidateKey } = require('./routes/api');
          invalidateKey(key.id);
          Logger.info(`[调度器] 自动禁用密钥 ${key.id} (user ${key.user_id})`);
        }
      } catch (err) {
        Logger.warn(`[调度器] 处理密钥 ${key.id} 失败: ${err.message}`);
      }
    }
  } catch (err) {
    Logger.error('[调度器] 执行失败:', err.message);
  }
}
// ========== 自动迁移：定价改倍率相关字段 ==========
async function ensureWeightedTokensColumns() {
  try {
    // 1. 为 usage_records 添加 weighted_tokens 列
    const usageCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_records'`);
    const usageNames = usageCols.rows.map(r => r.column_name);
    if (!usageNames.includes('weighted_tokens')) {
      await pool.query(`ALTER TABLE usage_records ADD COLUMN weighted_tokens BIGINT DEFAULT 0`);
      Logger.info('[迁移] 已为 usage_records 表添加 weighted_tokens 字段');
    }

    // 2. 为 quota_data 添加 weighted_tokens 列
    const quotaCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'quota_data'`);
    const quotaNames = quotaCols.rows.map(r => r.column_name);
    if (!quotaNames.includes('weighted_tokens')) {
      await pool.query(`ALTER TABLE quota_data ADD COLUMN weighted_tokens BIGINT DEFAULT 0`);
      Logger.info('[迁移] 已为 quota_data 表添加 weighted_tokens 字段');
    }

    // 3. 将现有模型价格统一设为 1.0（倍率模式下基础价格固定）
    await pool.query(`
      UPDATE models
      SET input_price_per_1k_tokens = 1.0,
          output_price_per_1k_tokens = 1.0,
          cached_output_price_per_1k_tokens = 1.0
      WHERE input_price_per_1k_tokens != 1.0
         OR output_price_per_1k_tokens != 1.0
    `);
    Logger.info('[迁移] 已将模型基础价格统一设为 1.0（倍率模式）');
  } catch (err) {
    Logger.warn(`[迁移] weighted_tokens 字段迁移跳过: ${err.message}`);
  }
}

// ========== 自动迁移：模型测试结果表 ==========
async function ensureModelTestResultsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_test_results (
        model_id VARCHAR(255) PRIMARY KEY,
        ok BOOLEAN NOT NULL,
        latency_ms INTEGER,
        tokens_per_second DECIMAL(10,2),
        total_tokens INTEGER,
        error TEXT,
        tested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    Logger.info('[迁移] 表 model_test_results 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] model_test_results 表创建跳过: ${err.message}`);
  }
}

// ========== 自动迁移：模型调用可用率日/15 分钟槽聚合 ==========
async function ensureModelUptimeDailyTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_uptime_daily (
        model_id VARCHAR(255) NOT NULL,
        day DATE NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        fail INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model_id, day)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_model_uptime_day ON model_uptime_daily(day)`);
    Logger.info('[迁移] 表 model_uptime_daily 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] model_uptime_daily 表创建跳过: ${err.message}`);
  }

  try {
    // hour 列存 15 分钟槽起点（TIMESTAMPTZ）；表名历史兼容保留 hourly
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_uptime_hourly (
        model_id VARCHAR(255) NOT NULL,
        hour TIMESTAMPTZ NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        fail INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model_id, hour)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_model_uptime_hour ON model_uptime_hourly(hour)`);
    Logger.info('[迁移] 表 model_uptime_hourly 已就绪（15 分钟槽，保留 24h）');
  } catch (err) {
    Logger.warn(`[迁移] model_uptime_hourly 表创建跳过: ${err.message}`);
  }

  try {
    const { startUptimeCleanup } = require('./utils/model-uptime');
    startUptimeCleanup();
  } catch (err) {
    Logger.warn(`[迁移] model uptime 清理任务启动跳过: ${err.message}`);
  }
}

// ========== 自动迁移：API 调用错误记录 ==========
async function ensureApiErrorRecordsTable() {
  const { ensureApiErrorRecordsTable: ensure, startErrorRecordsCleanup } = require('./utils/error-records');
  await ensure();
  startErrorRecordsCleanup();
}

const app = express();

// 信任反向代理（Nginx/Cloudflare等）
app.set('trust proxy', 1);

// 中间件 — 请求体大小限制设为 50MB（兼容多文件/图片/长文档的请求）
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 会话配置
if (isDemo) {
  // 演示模式：使用内存会话存储
  app.use(session({
    secret: config.app.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 1天
      httpOnly: true,
      sameSite: 'lax',
      path: '/'
    }
  }));
} else {
  app.use(session({
    store: new PgSession({
      pool: pool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    }),
    secret: config.app.sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30天
      httpOnly: true,
      secure: 'auto', // 仅在 HTTPS 下启用
      sameSite: 'lax',
      path: '/'
    }
  }));
}

// 演示模式：自动填充 session 用户
if (isDemo) {
  const { getUser } = require('./demo/data');
  app.use((req, res, next) => {
    if (!req.session.user) {
      req.session.user = getUser();
    }
    next();
  });
}

// 请求日志中间件
const apiKeyUserCache = new Map(); // key -> { username, ts }
const KEY_CACHE_TTL = 60_000; // 1 分钟缓存

// 解析 API Key 对应的用户名（带缓存）
async function resolveApiKeyUser(apiKey) {
  if (isDemo) return 'Demo User';
  const cached = apiKeyUserCache.get(apiKey);
  if (cached && Date.now() - cached.ts < KEY_CACHE_TTL) {
    return cached.username;
  }
  try {
    const r = await pool.query(
      'SELECT u.username FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.key_value = $1',
      [apiKey]
    );
    const name = r.rows[0]?.username || 'Unknown';
    apiKeyUserCache.set(apiKey, { username: name, ts: Date.now() });
    return name;
  } catch {
    return null;
  }
}

app.use((req, res, next) => {
  const start = Date.now();

  // 拦截 res.json 捕获错误响应体
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    res._logBody = body;
    return originalJson(body);
  };

  res.on('finish', async () => {
    const duration = Date.now() - start;
    const ip = req.ip || req.connection?.remoteAddress || '-';

    // 识别请求来源：API Key > Session > Guest
    let user = 'Guest';
    if (req.apiUser) {
      user = req.apiUser.username;
    } else if (req.session?.user?.username) {
      user = req.session.user.username;
    } else {
      let apiKey = req.headers['x-api-key'] || req.query?.api_key;
      if (!apiKey && req.headers.authorization?.startsWith('Bearer ')) {
        apiKey = req.headers.authorization.slice(7);
      }
      if (apiKey) {
        const resolved = await resolveApiKeyUser(apiKey);
        user = resolved || `Key:${apiKey.slice(0, 8)}…`;
      }
    }

    // 非 2xx 响应，附加错误信息
    let errorMsg = '';
    if (res.statusCode >= 400 && res._logBody?.error) {
      errorMsg = typeof res._logBody.error === 'string'
        ? ` — ${res._logBody.error}`
        : ` — ${res._logBody.error.message || JSON.stringify(res._logBody.error)}`;
    }

    Logger.request(req.method, req.originalUrl, res.statusCode, user, duration, ip, errorMsg);
  });
  next();
});

// 静态文件（开发环境禁用强缓存）
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));

// 版本号接口（无需认证）
app.get('/api/version', (req, res) => {
  const payload = {
    name: config.app?.name || 'CrewRouter',
    version: APP_VERSION,
  };
  Logger.info(`[version] 返回当前版本: ${payload.version}`);
  res.json(payload);
});

// 最新更新包下载（返回 updates/latest.zip；无需认证）
app.get('/api/updates/latest', (req, res) => {
  try {
    if (!fs.existsSync(LATEST_UPDATE_ZIP)) {
      Logger.warn(`[updates] 请求 latest.zip 但文件不存在: ${LATEST_UPDATE_ZIP}`);
      return res.status(404).json({
        error: {
          message: '更新包不存在：updates/latest.zip',
          type: 'not_found',
        },
      });
    }

    const stat = fs.statSync(LATEST_UPDATE_ZIP);
    if (!stat.isFile()) {
      Logger.warn(`[updates] latest.zip 不是文件: ${LATEST_UPDATE_ZIP}`);
      return res.status(404).json({
        error: {
          message: '更新包不存在：updates/latest.zip',
          type: 'not_found',
        },
      });
    }

    Logger.info(
      `[updates] 下载 latest.zip: path=${LATEST_UPDATE_ZIP}, size=${stat.size}, ip=${req.ip || '-'}`
    );
    res.download(LATEST_UPDATE_ZIP, 'latest.zip', (err) => {
      if (err) {
        if (res.headersSent) {
          Logger.error(`[updates] 传输 latest.zip 中断: ${err.message}`);
          return;
        }
        Logger.error(`[updates] 发送 latest.zip 失败: ${err.message}`);
        res.status(500).json({
          error: {
            message: '发送更新包失败',
            type: 'server_error',
          },
        });
      } else {
        Logger.success(`[updates] latest.zip 发送完成: size=${stat.size}`);
      }
    });
  } catch (err) {
    Logger.error(`[updates] 处理 latest.zip 请求异常: ${err.message}`);
    res.status(500).json({
      error: {
        message: '读取更新包失败',
        type: 'server_error',
      },
    });
  }
});

// 页面路由
app.get('/', (req, res) => {
  if (isDemo) {
    return res.sendFile(path.join(PUBLIC_DIR, 'pages/showcase.html'));
  }
  res.sendFile(path.join(PUBLIC_DIR, 'pages/index.html'));
});

app.get('/console', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages/console.html'));
});

app.get('/purchase', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages/purchase.html'));
});

app.get('/feishu-bind', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages/feishu-bind.html'));
});

app.get('/set-password', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages/set-password.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages/admin.html'));
});

app.get('/playground', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages/playground.html'));
});

app.get('/setup', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages/setup.html'));
});

// 路由
if (isDemo) {
  // 演示模式：挂载演示路由，拦截所有 API 和认证请求
  app.use('/api/user', require('./demo/routes'));
  app.use('/api/admin', require('./demo/routes'));
  app.use('/auth', require('./demo/auth'));
  app.use('/api/setup', (req, res, next) => {
    if (req.path === '/status' || req.originalUrl === '/api/setup/status') {
      return res.json({ needsSetup: false });
    }
    next();
  });
  // 演示模式下禁用 /v1 API 代理
  app.use('/v1', (req, res) => {
    res.status(403).json({
      error: { message: '演示模式下 API 访问已禁用', type: 'demo_mode_restricted' }
    });
  });
} else {
  app.use('/api', require('./routes/setup'));
  app.use('/auth', require('./routes/auth'));
  app.use('/auth', require('./routes/feishu'));
  app.use('/api', require('./routes/api'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/admin/update', require('./routes/update'));
  app.use('/api/admin', require('./routes/teams'));
  app.use('/api/user', require('./routes/user'));
  app.use('/api/user', require('./routes/balance-alert'));
  app.use('/api/user', require('./routes/notifications'));
  app.use('/api/playground', require('./routes/playground'));
  app.use('/api/conversations', require('./routes/conversations'));
  app.use('/api/2fa', require('./routes/two-factor'));
  app.use('/api/passkey', require('./routes/passkey'));

  // OpenAI 兼容路由（根路径，供 SDK 直接使用）
  const apiRoutes = require('./routes/api');
  app.use('/v1', apiRoutes);
}

// /v1 路由 404 诊断
app.use('/v1', (req, res) => {
  const hints = [];
  const url = req.originalUrl;

  // 检测双路径：/v1/v1/xxx
  if (url.startsWith('/v1/v1/')) {
    hints.push(`检测到重复路径前缀：${url} → 应为 ${url.replace('/v1/v1/', '/v1/')}`);
  }

  // 检测常见拼写
  const validPaths = ['/v1/chat/completions', '/v1/messages', '/v1/models', '/v1/responses'];
  const cleanPath = url.split('?')[0];
  if (!validPaths.includes(cleanPath)) {
    const suggest = validPaths.find(p => {
      const seg1 = p.split('/').pop();
      const seg2 = cleanPath.split('/').pop();
      return seg1 && seg2 && seg1.startsWith(seg2.slice(0, 3));
    });
    if (suggest) hints.push(`你是否想请求：${suggest}`);
  }

  const hintMsg = hints.length ? ` | ${hints.join(' | ')}` : '';
  Logger.warn(`[404] ${req.method} ${url} — 未匹配路由${hintMsg}`);

  res.status(404).json({
    error: {
      message: `No route found: ${req.method} ${cleanPath}`,
      type: 'invalid_request_error',
      ...(hints.length ? { hint: hints } : {})
    }
  });
});

// 全局 404 处理
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
});

// 启动服务器
const PORT = config.app.port || 20002;

// 首次启动自动建表：连接新数据库时自动创建所有表和默认数据
// 已有表则跳过（init-db.js 内部用 CREATE TABLE IF NOT EXISTS）
// 所有 ensure* 迁移：必须在 initDatabase() 建表之后执行，避免空库竞态
async function runPendingMigrations() {
  Logger.info('[启动] 开始执行数据库迁移...');
  const migrations = [
    ensureRedemptionCodesTable,
    ensureBalanceAndRedemptionUseTable,
    ensureUserCodeBalancesTable,
    ensureConversationsTable,
    ensureProvidersGrpColumn,
    ensureProvidersModelsUrlColumn,
    ensureModelsSeriesColumn,
    ensureSeriesTable,
    ensureModelsAliasColumn,
    ensureModelsPricingFields,
    ensureModelsThinkingFields,
    ensureModelsForwardReasoningEffort,
    ensureModelsUpstreamIdColumn,
    ensureAuthEnhancements,
    ensureEmailVerification,
    ensureUsageRecordsFields,
    ensureTraceSessionTables,
    ensureUsageMessageAnalysisTable,
    backfillUsageRecords,
    ensureBalanceAlertSettings,
    ensureNotificationSettings,
    ensureProductsTable,
    ensureQuotaDataTable,
    ensureTeamsTables,
    ensureUserModelLibraryOrderTables,
    ensureUserModelLibraryHiddenTables,
    ensureUserModelLibraryStarredTables,
    ensureApiKeyModelsTable,
    ensureApiKeyHarnessModelsTable,
    ensureApiKeyMembersTable,
    ensureOperationLogsTable,
    ensureKeyTagsTables,
    ensureUserGroupsTables,
    ensureReservedResources,
    ensureProviderQuotaScript,
    ensureProviderGrokOAuthColumns,
    ensureProviderQuotaMode,
    ensureProviderQuotaEnabled,
    ensureProviderArkUsageColumns,
    ensureProviderNotes,
    ensureProviderTestUserAgent,
    ensureProviderQuotaSchedule,
    ensureModelCreatedBy,
    ensureProviderApiKeyLength,
    ensureProviderKeyScript,
    ensureFusionTables,
    ensureApiKeyFusionConfig,
    ensureApiKeyFusionEnabled,
    ensureApiSignatureColumns,
    ensureApiKeySignatureColumns,
    ensureProviderMultiApiKeyColumns,
    ensureApiKeyEnabledColumns,
    ensureApiKeySwallowImages,
    ensureApiKeyCrewRouterCommands,
    ensureUsageRecordsApiKeyOnDeleteSetNull,
    ensureProviderProxyPool,
    ensureWeightedTokensColumns,
    ensureModelTestResultsTable,
    ensureModelUptimeDailyTable,
    ensureProviderHeaderFields,
    ensureApiErrorRecordsTable,
    // 须在 usage/fusion 表就绪后执行：UTC 墙钟 → 上海墙钟
    migrateUtcWallTimestampsToShanghai,
    // 须在 models / usage_records 就绪后：上游 model_id → 本地 models.id
    migrateUsageModelIdToLocalId,
  ];

  // 顺序执行，避免并行 DDL 争用；各 ensure 内部已 try/catch
  for (const fn of migrations) {
    try {
      await fn();
    } catch (err) {
      Logger.warn(`[启动] 迁移 ${fn.name} 异常: ${err.message}`);
    }
  }

  // 清理历史上「供应商已删、模型残留」的孤立数据
  try {
    const adminRoutes = require('./routes/admin');
    if (typeof adminRoutes.cleanupOrphanedModels === 'function') {
      const n = await adminRoutes.cleanupOrphanedModels();
      if (n > 0) {
        Logger.info(`[启动] 已清理 ${n} 个孤立模型（所属供应商不存在）`);
      }
    }
  } catch (err) {
    Logger.warn(`[启动] 孤立模型清理跳过: ${err.message}`);
  }

  Logger.info('[启动] 数据库迁移完成');
}

async function startServer() {
  if (!isDemo) {
    // 首次运行必须先完成建表 + 迁移，再对外提供服务（含 OOBE）
    try {
      Logger.info('[启动] 首次/启动时数据库初始化…');
      const { initDatabase } = require('./scripts/init-db');
      await initDatabase();
      await runPendingMigrations();
      Logger.success('[启动] 数据库已就绪，可以接受请求');
    } catch (err) {
      Logger.error(`[启动] 数据库初始化/迁移失败: ${err.message}`);
      Logger.error('[启动] 拒绝启动 HTTP 服务，请检查数据库配置后重试');
      process.exit(1);
    }

    // schema 就绪后再启动依赖表结构的后台任务
    try {
      const keyRefresher = require('./key-refresher');
      await keyRefresher.initAll();
    } catch (err) {
      Logger.error(`[KeyRefresher] 启动失败: ${err.message}`);
    }
    setInterval(runApiKeyScheduler, 60000);
    setTimeout(runApiKeyScheduler, 5000);
    try {
      const { startQuotaScheduler } = require('./utils/provider-quota');
      startQuotaScheduler();
    } catch (err) {
      Logger.warn(`[额度定时查询] 调度器启动失败: ${err.message}`);
    }
    try {
      const { startMessageAnalysisWorker } = require('./utils/message-analysis-store');
      startMessageAnalysisWorker({ intervalMs: 5000, batchSize: 50 });
    } catch (err) {
      Logger.warn(`[消息分析] 后台扫描器启动失败: ${err.message}`);
    }
  }

  app.listen(PORT, () => {
    Logger.success(`${config.app.name} API 服务运行于 http://localhost:${PORT}`);
  });
}

startServer();

module.exports = app;
