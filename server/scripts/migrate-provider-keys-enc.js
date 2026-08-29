const { Pool } = require('pg');
const config = require('../config-loader');
const { encryptSecret, isEncrypted } = require('../utils/secret-crypto');

async function main() {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT id, api_key, api_keys FROM providers FOR UPDATE');
    let updated = 0;
    for (const row of result.rows) {
      const apiKey = row.api_key && !isEncrypted(row.api_key) ? encryptSecret(row.api_key) : row.api_key;
      let apiKeys = row.api_keys;
      if (Array.isArray(apiKeys)) {
        apiKeys = apiKeys.map((entry) => {
          if (typeof entry === 'string') return encryptSecret(entry);
          if (!entry || typeof entry !== 'object') return entry;
          return { ...entry, key: entry.key ? encryptSecret(entry.key) : entry.key };
        });
      }
      const apiKeysJson = apiKeys == null ? null : JSON.stringify(apiKeys);
      if (apiKey !== row.api_key || apiKeysJson !== (row.api_keys == null ? null : JSON.stringify(row.api_keys))) {
        await client.query('UPDATE providers SET api_key = $1, api_keys = $2::jsonb WHERE id = $3', [apiKey, apiKeysJson, row.id]);
        updated++;
      }
    }
    await client.query('COMMIT');
    console.log(`已加密 ${updated} 个供应商的 API Key`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`供应商 API Key 加密迁移失败: ${err.message}`);
  process.exitCode = 1;
});
