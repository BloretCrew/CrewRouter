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
  return {
    host: db.host,
    port: db.port,
    database: db.name || db.database,
    user: db.user,
    password: db.password,
  };
}

const targets = [
  ['users', 'balance'],
  ['users', 'refund_balance'],
  ['usage_records', 'cost'],
  ['quota_data', 'quota'],
  ['user_code_balances', 'amount'],
  ['balance_preconsumes', 'amount'],
  ['balance_preconsumes', 'actual_amount'],
];

async function inspect(client) {
  const values = [];
  const clauses = targets.map(([table, column], index) => {
    values.push(table, column);
    const base = index * 2;
    return `(table_name = $${base + 1} AND column_name = $${base + 2})`;
  });
  const result = await client.query(`
    SELECT table_schema, table_name, column_name, data_type, udt_name,
           numeric_precision, numeric_scale, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND (${clauses.join(' OR ')})
    ORDER BY table_name, ordinal_position
  `, values);
  return result.rows;
}

async function rangeFor(client, table, column) {
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS rows, MIN(${column})::text AS min, MAX(${column})::text AS max,
            COUNT(*) FILTER (WHERE ${column} IS NOT NULL AND ROUND(${column}::numeric, 6) <> ${column}::numeric)::bigint AS beyond_scale
       FROM ${table}`
  );
  return result.rows[0];
}

async function main() {
  const pool = new Pool(loadDatabaseConfig());
  const client = await pool.connect();
  try {
    const columns = await inspect(client);
    console.log(`[money-precision] mode=${rollback ? 'rollback' : apply ? 'apply' : 'dry-run'}`);
    const found = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
    for (const row of columns) {
      const range = await rangeFor(client, row.table_name, row.column_name);
      console.log(JSON.stringify({ ...row, ...range }));
    }
    for (const [table, column] of targets) {
      if (!found.has(`${table}.${column}`)) console.log(JSON.stringify({ table_name: table, column_name: column, missing: true }));
    }

    const incompatible = columns.filter(row => Number(row.numeric_scale || 0) > 6 || Number(row.numeric_precision || 0) > 24);
    if (incompatible.length) {
      throw new Error(`发现不能无损缩窄到 NUMERIC(24,6) 的列: ${incompatible.map(r => `${r.table_name}.${r.column_name}`).join(', ')}`);
    }
    if (!apply && !rollback) {
      console.log('[money-precision] dry-run 完成；未执行 DDL。使用 --apply 才会写库。');
      return;
    }

    await client.query('BEGIN');
    if (rollback) {
      const rollbackTargets = [
        ['users', 'balance', 'NUMERIC(10,4)'],
        ['users', 'refund_balance', 'NUMERIC(10,4)'],
        ['usage_records', 'cost', 'NUMERIC(10,6)'],
        ['quota_data', 'quota', 'NUMERIC(10,4)'],
        ['user_code_balances', 'amount', 'NUMERIC(10,4)'],
        ['balance_preconsumes', 'amount', 'NUMERIC(12,4)'],
        ['balance_preconsumes', 'actual_amount', 'NUMERIC(12,4)'],
      ];
      for (const [table, column, type] of rollbackTargets) {
        if (!found.has(`${table}.${column}`)) continue;
        const range = await rangeFor(client, table, column);
        if (Number(range.beyond_scale) > 0) throw new Error(`${table}.${column} 含超过 4 位小数的数据，拒绝回滚缩窄`);
        await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type} USING ${column}::${type}`);
      }
    } else {
      for (const [table, column] of targets) {
        if (!found.has(`${table}.${column}`)) continue;
        await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE NUMERIC(24,6) USING ${column}::NUMERIC(24,6)`);
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
