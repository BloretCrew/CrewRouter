#!/usr/bin/env node
'use strict';

const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');
if (apply && rollback) throw new Error('--apply 与 --rollback 不能同时使用');

function loadDatabaseConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const config = require(path.join(__dirname, '..', 'config.json'));
  const db = config.database || {};
  return { host: db.host, port: db.port, database: db.name || db.database, user: db.user, password: db.password };
}

// 金额/价格字段；比例、费率和计数列不在此迁移。
const targets = [
  ['users', 'balance'], ['users', 'refund_balance'],
  ['users', 'alert_balance_threshold'], ['users', 'alert_daily_usage_threshold'],
  ['usage_records', 'cost'], ['quota_data', 'quota'],
  ['redemption_codes', 'amount'], ['products', 'price'],
  ['fusion_usage_records', 'total_cost'], ['usage_message_analysis', 'cost'],
  ['user_code_balances', 'amount'], ['balance_preconsumes', 'amount'],
  ['balance_preconsumes', 'actual_amount'],
  ['models', 'input_price_per_1k_tokens'], ['models', 'output_price_per_1k_tokens'],
  ['models', 'cached_output_price_per_1k_tokens'],
  ['models', 'reference_input_price_per_1k_tokens'],
  ['models', 'reference_output_price_per_1k_tokens'],
  ['models', 'reference_cached_output_price_per_1k_tokens'],
  ['models', 'model_price'],
];
const TARGET_TYPE = 'NUMERIC(24,6)';
const BACKUP_TABLE = 'money_precision_backups';

function qident(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function key(table, column) { return `${table}.${column}`; }

async function ensureBackupTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${qident(BACKUP_TABLE)} (
      batch_id VARCHAR(64) NOT NULL,
      table_schema VARCHAR(255) NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      column_name VARCHAR(255) NOT NULL,
      data_type VARCHAR(128) NOT NULL,
      udt_name VARCHAR(128),
      numeric_precision INTEGER,
      numeric_scale INTEGER,
      is_nullable VARCHAR(3) NOT NULL,
      column_default TEXT,
      old_type_sql VARCHAR(255) NOT NULL,
      target_type_sql VARCHAR(255) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'applied',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (batch_id, table_schema, table_name, column_name)
    )
  `);
}

async function inspect(client) {
  const values = [];
  const clauses = targets.map(([table, column], index) => {
    values.push(table, column);
    return `(table_schema = current_schema() AND table_name = $${index * 2 + 1} AND column_name = $${index * 2 + 2})`;
  });
  const result = await client.query(`
    SELECT table_schema, table_name, column_name, data_type, udt_name,
           numeric_precision, numeric_scale, is_nullable, column_default
      FROM information_schema.columns
     WHERE ${clauses.join(' OR ')}
     ORDER BY table_name, ordinal_position
  `, values);
  return result.rows;
}

function oldTypeSql(row) {
  if (row.numeric_precision != null && row.numeric_scale != null) {
    return `NUMERIC(${row.numeric_precision},${row.numeric_scale})`;
  }
  const allowed = new Set(['real', 'double precision', 'money', 'integer', 'bigint']);
  if (!allowed.has(row.data_type)) throw new Error(`不支持安全回滚的字段类型: ${row.table_name}.${row.column_name} (${row.data_type})`);
  return row.data_type.toUpperCase();
}

async function rangeFor(client, row) {
  const table = qident(row.table_name);
  const column = qident(row.column_name);
  return (await client.query(`
    SELECT COUNT(*)::bigint AS rows, MIN(${column})::text AS min, MAX(${column})::text AS max,
           COUNT(*) FILTER (WHERE ${column} IS NOT NULL AND ${column}::numeric <> ROUND(${column}::numeric, 6))::bigint AS beyond_target_scale
      FROM ${table}
  `)).rows[0];
}

async function assertRollbackSafe(client, row) {
  const table = qident(row.table_name);
  const column = qident(row.column_name);
  if (row.numeric_precision != null && row.numeric_scale != null) {
    const integerDigits = Number(row.numeric_precision) - Number(row.numeric_scale);
    const result = await client.query(`
      SELECT COUNT(*)::bigint AS unsafe FROM ${table}
       WHERE ${column} IS NOT NULL
         AND (${column}::numeric <> ROUND(${column}::numeric, $1)
              OR ABS(${column}::numeric) >= POWER(10::numeric, $2))
    `, [Number(row.numeric_scale), integerDigits]);
    if (Number(result.rows[0].unsafe) > 0) {
      throw new Error(`${row.table_name}.${row.column_name} 含超过原始精度范围的数据，拒绝回滚缩窄`);
    }
    return;
  }
  if (row.data_type === 'real' || row.data_type === 'double precision') {
    const castType = row.data_type === 'real' ? 'real' : 'double precision';
    const result = await client.query(`
      SELECT COUNT(*)::bigint AS unsafe FROM ${table}
       WHERE ${column} IS NOT NULL
         AND (${column}::numeric <> (${column}::${castType})::numeric)
    `);
    if (Number(result.rows[0].unsafe) > 0) {
      throw new Error(`${row.table_name}.${row.column_name} 含无法无损恢复为 ${castType} 的数据，拒绝回滚缩窄`);
    }
  }
}

async function latestAppliedBatch(client) {
  const result = await client.query(`
    SELECT batch_id FROM ${qident(BACKUP_TABLE)}
     WHERE status = 'applied'
     GROUP BY batch_id
     ORDER BY MAX(recorded_at) DESC
     LIMIT 1
  `);
  return result.rows[0]?.batch_id || null;
}

async function main() {
  const pool = new Pool(loadDatabaseConfig());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureBackupTable(client);
    const columns = await inspect(client);
    const found = new Set(columns.map(row => key(row.table_name, row.column_name)));
    const ranges = new Map();
    for (const row of columns) {
      const range = await rangeFor(client, row);
      ranges.set(key(row.table_name, row.column_name), range);
      console.log(JSON.stringify({ ...row, ...range, target_type: rollback ? 'recorded_backup_type' : TARGET_TYPE }));
    }
    for (const [table, column] of targets) {
      if (!found.has(key(table, column))) console.log(JSON.stringify({ table_name: table, column_name: column, missing: true, skipped: true }));
    }

    const mode = rollback ? 'rollback' : apply ? 'apply' : 'dry-run';
    console.log(`[money-precision] mode=${mode}`);
    if (!apply && !rollback) {
      await client.query('ROLLBACK');
      console.log('[money-precision] dry-run 完成；未执行 DDL。使用 --apply 才会写库。');
      return;
    }

    if (rollback) {
      const batchId = await latestAppliedBatch(client);
      if (!batchId) throw new Error('没有可回滚的已应用备份记录；拒绝按猜测类型缩窄字段');
      const backup = await client.query(`SELECT * FROM ${qident(BACKUP_TABLE)} WHERE batch_id = $1 AND status = 'applied' ORDER BY table_name, column_name`, [batchId]);
      const expected = new Set(columns.map(row => key(row.table_name, row.column_name)));
      const recorded = new Set(backup.rows.map(row => key(row.table_name, row.column_name)));
      for (const target of expected) {
        if (!recorded.has(target)) throw new Error(`回滚批次缺少字段记录: ${target}；拒绝不完整回滚`);
      }
      for (const row of backup.rows) {
        if (!expected.has(key(row.table_name, row.column_name))) throw new Error(`回滚批次字段当前不存在: ${key(row.table_name, row.column_name)}`);
        await assertRollbackSafe(client, row);
      }
      for (const row of backup.rows) {
        const table = qident(row.table_name);
        const column = qident(row.column_name);
        await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${row.old_type_sql} USING ${column}::${row.old_type_sql}`);
      }
      await client.query(`UPDATE ${qident(BACKUP_TABLE)} SET status = 'rolled_back' WHERE batch_id = $1`, [batchId]);
      await client.query('COMMIT');
      console.log(`[money-precision] rollback 完成，恢复批次 ${batchId}。`);
      return;
    }

    const beyondTargetScale = columns.filter(row => Number(ranges.get(key(row.table_name, row.column_name)).beyond_target_scale) > 0);
    if (beyondTargetScale.length) throw new Error(`发现超过 6 位小数的数据，拒绝迁移以避免缩窄: ${beyondTargetScale.map(row => key(row.table_name, row.column_name)).join(', ')}`);
    const batchId = `money_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    for (const row of columns) {
      await client.query(`INSERT INTO ${qident(BACKUP_TABLE)}
        (batch_id, table_schema, table_name, column_name, data_type, udt_name, numeric_precision, numeric_scale, is_nullable, column_default, old_type_sql, target_type_sql)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [batchId, row.table_schema, row.table_name, row.column_name, row.data_type, row.udt_name,
        row.numeric_precision, row.numeric_scale, row.is_nullable, row.column_default, oldTypeSql(row), TARGET_TYPE]);
      const table = qident(row.table_name);
      const column = qident(row.column_name);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${TARGET_TYPE} USING ${column}::${TARGET_TYPE}`);
    }
    await client.query('COMMIT');
    console.log(`[money-precision] apply 完成，已记录可逆批次 ${batchId}。`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`[money-precision] ${error.message}`);
  process.exitCode = 1;
});
