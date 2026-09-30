'use strict';

const { pool } = require('../models/database');
const Logger = require('../logger');

/**
 * Blora Agent 用到的列和表。可重复执行。
 * @param {{ query: Function }} [db]
 */
async function ensureAgentSchema(db = pool) {
  const column = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'models' AND column_name = 'output_kind'`
  );
  if (column.rows.length === 0) {
    await db.query(`ALTER TABLE models ADD COLUMN output_kind VARCHAR(16) NOT NULL DEFAULT 'chat'`);
    Logger.info('[数据库初始化] 已为 models 表添加 output_kind 列');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_images (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_id VARCHAR(100) NOT NULL,
      prompt TEXT NOT NULL,
      size VARCHAR(32) NOT NULL,
      mime VARCHAR(64) NOT NULL DEFAULT 'image/png',
      bytes BYTEA NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_images_user_created ON agent_images (user_id, created_at DESC)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_threads (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode VARCHAR(16) NOT NULL DEFAULT 'manage',
      title VARCHAR(200) NOT NULL DEFAULT '新对话',
      model_id VARCHAR(100) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_threads_user_updated ON agent_threads (user_id, updated_at DESC)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL,
      content TEXT,
      tool_calls JSONB,
      tool_call_id VARCHAR(100),
      tool_name VARCHAR(80),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages (thread_id, id)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      tool_call_id VARCHAR(100) NOT NULL,
      tool_name VARCHAR(80) NOT NULL,
      arguments JSONB NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_approvals_thread_status ON agent_approvals (thread_id, status)`);
}

module.exports = { ensureAgentSchema };
