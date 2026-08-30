#!/usr/bin/env node
'use strict';

const path = require('path');
const { Pool } = require('pg');

const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');
if (apply && rollback) throw new Error('--apply 与 --rollback 不能同时使用');

function loadDatabaseConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const configPath = path.join(__dirname, '..', 'config.json');
  const config = require(configPath);
  const db = config.database || {};
  return { host: db.host, port: db.port, database: db.name || db.database, user: db.user, password: db.password };
}

// These are the money-bearing columns created by the current schema. Missing entries are optional legacy columns.
const targets = [
  { table: 'users', column: 'balance', oldType: 'NUMERIC(10,4)' },
  { table: 'users', column: 'refund_balance', oldType: 'NUMERIC(10,4)' },
  { table: 'usage_records', column: 'cost', oldType: 'NUMERIC(10,6)' },
  { table: 'quota_data', column: 'quota', oldType: 'NUMERIC(10,4)' },
  { table: 'redemption_codes', column: 'amount', oldType: 'NUMERIC(10,4)' },
  { table: 'fusion_usage_records', column: 'total_cost', oldType: 'NUMERIC(10,4)' },
  { table: 'usage_message_analysis', column: 'cost', oldType: 'NUMERIC(20,8)' },
  { table: 'user_code_balances', column: 'amount', oldType: 'NUMERIC(10,4)' },
  { table: 'balance_preconsumes', column: 'amount', oldType: 'NUMERIC(12,4)' },
  { table: 'balance_preconsumes', column: 'actual_amount', oldType: 'NUMERIC(12,4)' },
];
const TARGET_TYPE = 'NUMERIC(24,6)';

async function inspect(client) {
  const values = [];
  const clauses = targets.map(({ table, column }, index) => {
    values.push(table, column);
    const base = index * 2;
    return `(table_schema = current_schema() AND table_name = $${base + 1} AND column_name = $${base + 2})`;
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

function targetFor(table, column) {
  return targets.find(target => target.table === table && target.column === column);
}

async function rangeFor(client, row) {
  const { table_name: table, column_name: column } = row;
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS rows,
            MIN(${column})::text AS min,
            MAX(${column})::text AS max,
            COUNT(*) FILTER (WHERE ${column} IS NOT NULL AND ${column}::numeric <> ROUND(${column}::numeric, 6))::bigint AS beyond_target_scale
       FROM ${table}`
  );
  return result.rows[0];
}

async function assertRollbackSafe(client, row) {
  const target = targetFor(row.table_name, row.column_name);
  const oldPrecision = Number(String(target.oldType).match(/NUMERIC\((\d+),(\d+)\)/i)[1]);
  const oldScale = Number(String(target.oldType).match(/NUMERIC\((\d+),(\d+)\)/i)[2]);
  const integerDigits = oldPrecision - oldScale;
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS unsafe
       FROM ${row.table_name}
      WHERE ${row.column_name} IS NOT NULL
        AND (${row.column_name}::numeric <> ROUND(${row.column_name}::numeric, $1)
             OR ABS(${row.column_name}::numeric) >= POWER(10::numeric, $2))`,
    [oldScale, integerDigits]
  );
  if (Number(result.rows[0].unsafe) > 0) {
    throw new Error(`${row.table_name}.${row.column_name} 含超过 ${oldScale} 位小数或旧精度范围的数据，拒绝回滚缩窄`);
  }
}

async function main() {
  const pool = new Pool(loadDatabaseConfig());
  const client = await pool.connect();
  try {
    const columns = await inspect(client);
    const mode = rollback ? 'rollback' : apply ? 'apply' : 'dry-run';
    console.log(`[money-precision] mode=${mode}`);
    const found = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
    const ranges = new Map();
    for (const row of columns) {
      const range = await rangeFor(client, row);
      ranges.set(`${row.table_name}.${row.column_name}`, range);
      console.log(JSON.stringify({ ...row, ...range, target_type: rollback ? targetFor(row.table_name, row.column_name).oldType : TARGET_TYPE }));
    }
    for (const target of targets) {
      if (!found.has(`${target.table}.${target.column}`)) {
        console.log(JSON.stringify({ table_name: target.table, column_name: target.column, missing: true, skipped: true }));
      }
    }

    if (!apply && !rollback) {
      console.log('[money-precision] dry-run 完成；未执行 DDL。使用 --apply 才会写库。');
      return;
    }

    console.log(`[money-precision] ${rollback ? '将恢复各列原始类型' : `将修改 ${columns.length} 个已存在列为 ${TARGET_TYPE}`}；范围已在上方输出。`);
    if (!rollback) {
      const beyondTargetScale = columns.filter(row => Number(ranges.get(`${row.table_name}.${row.column_name}`).beyond_target_scale) > 0);
      if (beyondTargetScale.length) {
        throw new Error(`发现超过 6 位小数的数据，拒绝迁移以避免缩窄: ${beyondTargetScale.map(row => `${row.table_name}.${row.column_name}`).join(', ')}`);
      }
    }
    await client.query('BEGIN');
    if (rollback) {
      for (const row of columns) {
        await assertRollbackSafe(client, row);
        await client.query(`ALTER TABLE ${row.table_name} ALTER COLUMN ${row.column_name} TYPE ${targetFor(row.table_name, row.column_name).oldType} USING ${row.column_name}::${targetFor(row.table_name, row.column_name).oldType}`);
      }
    } else {
      for (const row of columns) {
        await client.query(`ALTER TABLE ${row.table_name} ALTER COLUMN ${row.column_name} TYPE ${TARGET_TYPE} USING ${row.column_name}::${TARGET_TYPE}`);
      }
    }
    await client.query('COMMIT');
    console.log(`[money-precision] ${rollback ? 'rollback' : 'apply'} 完成。`);
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
