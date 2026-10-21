'use strict';

const USAGE_LATENCY_COLUMNS = [
  { name: 'is_stream', type: 'BOOLEAN' },
  { name: 'ttft_ms', type: 'INTEGER' },
  { name: 'upstream_first_byte_ms', type: 'INTEGER' },
  { name: 'generation_ms', type: 'INTEGER' },
  { name: 'tpot_ms', type: 'NUMERIC(12,3)' },
  { name: 'output_tps', type: 'NUMERIC(12,3)' },
  { name: 'e2e_ms', type: 'INTEGER' },
  { name: 'upstream_processing_ms', type: 'INTEGER' },
  { name: 'service_tier', type: 'VARCHAR(32)' },
  { name: 'rate_limit', type: 'JSONB' },
];

// 调用者持有事务；局部超时不泄漏到连接池的后续请求。
// 新增列不带默认值，PostgreSQL 只更新元数据，不重写大表。
async function ensureUsageLatencyColumns(client) {
  const settings = await client.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
    current_setting('statement_timeout') AS statement_timeout`);
  const previous = settings.rows[0];
  await client.query("SET LOCAL lock_timeout = '15s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  const columns = await client.query(`SELECT attname AS column_name FROM pg_attribute
    WHERE attrelid = 'usage_records'::regclass AND attnum > 0 AND NOT attisdropped`);
  const existing = new Set(columns.rows.map(row => row.column_name));
  const missing = USAGE_LATENCY_COLUMNS.filter(column => !existing.has(column.name));
  if (missing.length) {
    await client.query(
      `ALTER TABLE usage_records ${missing.map(column => `ADD COLUMN IF NOT EXISTS ${column.name} ${column.type}`).join(', ')}`
    );
  }
  await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
    [previous.lock_timeout, previous.statement_timeout]);
}

module.exports = { ensureUsageLatencyColumns, USAGE_LATENCY_COLUMNS };
