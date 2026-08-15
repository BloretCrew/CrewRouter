const { pool } = require('../server/models/database');

async function main() {
  const client = await pool.connect();
  try {
    // 检查最近添加的供应商
    const result = await client.query(
      "SELECT id, name, created_by, created_at FROM providers ORDER BY created_at DESC LIMIT 5"
    );
    console.log('最近添加的供应商:');
    for (const row of result.rows) {
      console.log(`  ${row.id}: ${row.name} (created_by: ${row.created_by}, created_at: ${row.created_at})`);
    }
  } catch (error) {
    console.error('错误:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
