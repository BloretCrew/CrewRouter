'use strict';

const { pool } = require('../models/database');
const Logger = require('../logger');
const { analyzeMessages } = require('./message-analysis');

let workerTimer = null;
let scanRunning = false;

async function ensureMessageAnalysisTable() {
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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_uma_created ON usage_message_analysis(created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_uma_user_created ON usage_message_analysis(user_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_uma_source_created ON usage_message_analysis(request_source, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_uma_workspace ON usage_message_analysis(workspace_path)');
}

async function scanPendingMessageAnalysis(options = {}) {
  if (scanRunning) return { scanned: 0, skipped: true };
  scanRunning = true;
  const batchSize = Math.min(Math.max(Number(options.batchSize) || 50, 1), 500);
  let client;
  try {
    await ensureMessageAnalysisTable();
    client = await pool.connect();
    await client.query('BEGIN');
    const pending = await client.query(
      `SELECT ur.id, ur.user_id, ur.created_at, ur.request_source, ur.messages,
              ur.tokens_used, ur.cost
       FROM usage_records ur
       LEFT JOIN usage_message_analysis uma ON uma.usage_id = ur.id
       WHERE ur.messages IS NOT NULL AND uma.usage_id IS NULL
       ORDER BY ur.id ASC
       LIMIT $1
       FOR UPDATE OF ur SKIP LOCKED`,
      [batchSize]
    );

    for (const row of pending.rows) {
      const analysis = analyzeMessages(row.messages);
      await client.query(
        `INSERT INTO usage_message_analysis (
           usage_id, user_id, created_at, request_source, workspace_path,
           message_count, total_characters, total_lines, metadata_message_count,
           has_workspace_path, has_git_status, has_project_layout,
           has_environment_context, block_counts, observed_fields, "values",
           tokens_used, cost
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (usage_id) DO NOTHING`,
        [
          row.id, row.user_id, row.created_at, String(row.request_source || 'unknown').toLowerCase(),
          analysis.values.workspace_path, analysis.message_count, analysis.total_characters,
          analysis.total_lines, analysis.metadata_message_indexes.length,
          !!analysis.values.workspace_path, !!analysis.values.git_status,
          !!analysis.values.project_layout, !!analysis.values.environment_context,
          JSON.stringify(analysis.block_counts), JSON.stringify(analysis.observed_fields),
          JSON.stringify(analysis.values), Number(row.tokens_used) || 0, Number(row.cost) || 0
        ]
      );
    }
    await client.query('COMMIT');
    if (pending.rows.length) Logger.info(`[消息分析] 已持久化 ${pending.rows.length} 条请求的结构化标记`);
    return { scanned: pending.rows.length, skipped: false };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    Logger.warn(`[消息分析] 后台扫描失败: ${error.message}`);
    return { scanned: 0, error: error.message };
  } finally {
    client?.release();
    scanRunning = false;
  }
}

function startMessageAnalysisWorker(options = {}) {
  if (workerTimer) return;
  const intervalMs = Math.max(Number(options.intervalMs) || 5000, 1000);
  const run = () => scanPendingMessageAnalysis({ batchSize: options.batchSize || 50 }).catch(() => {});
  run();
  workerTimer = setInterval(run, intervalMs);
  workerTimer.unref?.();
  Logger.info(`[消息分析] 后台扫描器已启动（每 ${intervalMs}ms 扫描一次）`);
}

async function getMessageAnalysisStatus(userId = null) {
  const params = userId == null ? [] : [userId];
  const userWhere = userId == null ? '' : ' WHERE user_id = $1';
  const totalWhere = userId == null ? ' WHERE messages IS NOT NULL' : ' WHERE user_id = $1 AND messages IS NOT NULL';
  const pendingFilter = userId == null
    ? 'ur.messages IS NOT NULL AND uma.usage_id IS NULL'
    : 'ur.user_id = $1 AND ur.messages IS NOT NULL AND uma.usage_id IS NULL';
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM usage_records${totalWhere}) AS total_requests,
      (SELECT COUNT(*)::int FROM usage_message_analysis${userWhere}) AS analyzed_requests,
      (SELECT COUNT(*)::int FROM usage_records ur
       LEFT JOIN usage_message_analysis uma ON uma.usage_id = ur.id
       WHERE ${pendingFilter}) AS pending_requests,
      (SELECT MAX(analyzed_at) FROM usage_message_analysis${userWhere}) AS last_scanned_at
  `, params);
  const row = result.rows[0] || {};
  return {
    total_requests: Number(row.total_requests || 0),
    analyzed_requests: Number(row.analyzed_requests || 0),
    pending_requests: Number(row.pending_requests || 0),
    last_scanned_at: row.last_scanned_at || null,
  };
}

module.exports = { scanPendingMessageAnalysis, startMessageAnalysisWorker, getMessageAnalysisStatus };
