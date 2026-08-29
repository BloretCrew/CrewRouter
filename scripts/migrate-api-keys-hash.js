#!/usr/bin/env node
const { pool } = require('../server/models/database');
const { sha256Hex } = require('../server/utils/key-hash');

const dryRun = !process.argv.includes('--apply');

async function main() {
  console.log('请先确认已备份 /root/backup/api_keys_*.sql');
  const result = await pool.query('SELECT id, name, key_prefix, key_value, key_hash FROM api_keys ORDER BY id');
  const rows = result.rows.filter(row => row.key_value);
  for (const row of rows) {
    const hash = sha256Hex(row.key_value);
    if (dryRun) {
      console.log(`${row.id}\t${row.name || ''}\t${row.key_prefix || ''}\t${String(row.key_hash || '').slice(0, 8)} -> ${hash.slice(0, 8)}`);
    } else {
      await pool.query('UPDATE api_keys SET key_hash = $1, key_value = NULL WHERE id = $2', [hash, row.id]);
    }
  }
  console.log(dryRun ? `dry-run: ${rows.length} 行待迁移` : `已迁移 ${rows.length} 行`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end().catch(() => {}));
