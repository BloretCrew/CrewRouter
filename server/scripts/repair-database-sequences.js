'use strict';

// Re-seed owned serial/identity sequences after importing rows into PostgreSQL.
// Dry-run is read-only. --apply repairs only sequences whose next value collides
// with an existing key. Each affected table is exclusively locked for the short
// max(id)/setval operation; lock_timeout makes busy production tables fail closed.

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const apply = process.argv.includes('--apply');
const configPath = path.resolve(process.argv.find(arg => arg.endsWith('.json')) || process.env.CR_CONFIG_PATH || path.join(__dirname, '../../config.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;

async function main() {
  const client = new Client({
    host: process.env.CR_DB_HOST || config.database?.host,
    port: Number(process.env.CR_DB_PORT || config.database?.port || 5432),
    database: process.env.CR_DB_NAME || config.database?.name,
    user: process.env.CR_DB_USER || config.database?.user,
    password: process.env.CR_DB_PASSWORD || config.database?.password,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    application_name: apply ? 'crewrouter-sequence-repair' : 'crewrouter-sequence-dry-run',
    options: apply ? '-c statement_timeout=10000 -c lock_timeout=2000' : '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000',
  });
  const results = [];
  try {
    await client.connect();
    const owned = await client.query(`
      SELECT sn.nspname AS "sequenceSchema",s.relname AS "sequenceName",
             tn.nspname AS "tableSchema",t.relname AS "tableName",a.attname AS "columnName",
             ps.seqincrement AS "increment",ps.seqmin AS "minimum",ps.seqmax AS "maximum",
             ps.seqcache AS "cacheSize",ps.seqcycle AS "cycle"
      FROM pg_class s JOIN pg_namespace sn ON sn.oid=s.relnamespace
      JOIN pg_sequence ps ON ps.seqrelid=s.oid
      JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
      JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE s.relkind='S' AND tn.nspname='public'
      ORDER BY tn.nspname,t.relname,a.attname
    `);

    for (const item of owned.rows) {
      const table = `${quoteIdentifier(item.tableSchema)}.${quoteIdentifier(item.tableName)}`;
      const sequence = `${quoteIdentifier(item.sequenceSchema)}.${quoteIdentifier(item.sequenceName)}`;
      const column = quoteIdentifier(item.columnName);
      let inTransaction = false;
      try {
        if (apply) {
          await client.query('BEGIN');
          inTransaction = true;
          await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        } else {
          await client.query('BEGIN READ ONLY');
          inTransaction = true;
        }
        const state = (await client.query(`SELECT last_value,is_called FROM ${sequence}`)).rows[0];
        const maximum = (await client.query(`SELECT max(${column})::text AS value FROM ${table}`)).rows[0].value;
        if (maximum === null) {
          results.push({ table: item.tableName, sequence: item.sequenceName, status: 'empty_table_sequence_unchanged' });
        } else {
          const next = BigInt(state.last_value) + (state.is_called ? BigInt(item.increment) : 0n);
          const max = BigInt(maximum);
          if (next > max) {
            results.push({ table: item.tableName, sequence: item.sequenceName, status: 'healthy', next: String(next), maximum });
          } else if (item.cycle || BigInt(item.increment) <= 0n || BigInt(item.maximum) <= max || Number(item.cacheSize) !== 1) {
            results.push({ table: item.tableName, sequence: item.sequenceName, status: 'manual_review_required', next: String(next), maximum, increment: String(item.increment), cacheSize: Number(item.cacheSize), cycle: item.cycle });
          } else if (apply) {
            await client.query('SELECT setval($1::regclass,$2::bigint,true)', [sequence, maximum]);
            await client.query('COMMIT');
            inTransaction = false;
            results.push({ table: item.tableName, sequence: item.sequenceName, status: 'repaired', previousNext: String(next), maximum, newNext: String(max + BigInt(item.increment)) });
            continue;
          } else {
            results.push({ table: item.tableName, sequence: item.sequenceName, status: 'repair_available', next: String(next), maximum, newNext: String(max + BigInt(item.increment)) });
          }
        }
        await client.query(apply ? 'COMMIT' : 'ROLLBACK');
        inTransaction = false;
      } catch (error) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        results.push({ table: item.tableName, sequence: item.sequenceName, status: 'failed', errorCode: error.code || 'unknown' });
      }
    }
    const summary = {
      mode: apply ? 'apply' : 'dry_run',
      readOnly: !apply,
      database: config.database?.name,
      ownedSequences: owned.rowCount,
      repairsAvailable: results.filter(result => result.status === 'repair_available').length,
      repaired: results.filter(result => result.status === 'repaired').length,
      manualReviewRequired: results.filter(result => result.status === 'manual_review_required').length,
      failed: results.filter(result => result.status === 'failed').length,
      results,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.failed || summary.manualReviewRequired) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  process.stderr.write(`Sequence repair failed: ${error.code || error.name || 'unknown error'}\n`);
  process.exitCode = 2;
});
