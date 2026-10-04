'use strict';

const MODEL_IDENTITY_COLUMNS = ['requested_model', 'resolved_model', 'response_model'];

// 调用者持有事务；局部超时不泄漏到连接池的后续请求。
async function ensureUsageModelIdentityColumns(client) {
  const settings = await client.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
    current_setting('statement_timeout') AS statement_timeout`);
  const previous = settings.rows[0];
  await client.query("SET LOCAL lock_timeout = '15s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  const columns = await client.query(`SELECT attname AS column_name FROM pg_attribute
    WHERE attrelid = 'usage_records'::regclass AND attnum > 0 AND NOT attisdropped`);
  const existing = new Set(columns.rows.map(row => row.column_name));
  const missing = MODEL_IDENTITY_COLUMNS.filter(name => !existing.has(name));
  if (missing.length) {
    await client.query(`ALTER TABLE usage_records ${missing.map(name => `ADD COLUMN IF NOT EXISTS ${name} TEXT`).join(', ')}`);
  }
  await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
    [previous.lock_timeout, previous.statement_timeout]);
}

module.exports = { ensureUsageModelIdentityColumns, MODEL_IDENTITY_COLUMNS };
