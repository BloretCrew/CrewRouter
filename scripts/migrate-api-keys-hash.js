#!/usr/bin/env node
const { pool } = require('../server/models/database');
const { sha256Hex } = require('../server/utils/key-hash');

const dryRun = !process.argv.includes('--apply');

async function main() {
  console.log('请先确认已备份 /root/backup/api_keys_*.sql');
  const result = await pool.query('SELECT id, name, key_prefix, key_value, key_hash FROM api_keys ORDER BY id');
  const rows = result.rows.filter(row => row.key_value);
  const hashes = new Map();
  for (const row of rows) {
    const hash = sha256Hex(row.key_value);
    if (hashes.has(hash)) throw new Error(`重复 key_hash: api_key ${hashes.get(hash)} 与 ${row.id}`);
    hashes.set(hash, row.id);
    if (row.key_hash && row.key_hash === hash && !row.key_value) continue;
    if (dryRun) {
      console.log(`${row.id}\t${row.name || ''}\t${row.key_prefix || ''}\t${String(row.key_hash || '').slice(0, 8)} -> ${hash.slice(0, 8)}`);
    }
  }
  if (dryRun) {
    console.log(`dry-run: ${rows.length} 行待迁移`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, key_value FROM api_keys WHERE key_value IS NOT NULL ORDER BY id FOR UPDATE');
    const seen = new Set();
    for (const row of current.rows) {
      const hash = sha256Hex(row.key_value);
      if (seen.has(hash)) throw new Error(`迁移时发现重复 key_hash: ${hash.slice(0, 8)}`);
      seen.add(hash);
      await client.query('UPDATE api_keys SET key_hash = $1, key_value = NULL WHERE id = $2 AND key_value IS NOT NULL', [hash, row.id]);
    }
    await client.query('COMMIT');
    console.log(`已迁移 ${current.rows.length} 行`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end().catch(() => {}));
