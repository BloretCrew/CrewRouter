const { pool } = require('../server/models/database');

async function main() {
  const client = await pool.connect();
  try {
    // 查找 ID 以 user_ 开头的供应商
    const result = await client.query(
      "SELECT id, name, created_by FROM providers WHERE id LIKE 'user_%'"
    );
    console.log('用户添加的供应商 (ID 以 user_ 开头):');
    for (const row of result.rows) {
      console.log(`  ${row.id}: ${row.name} (created_by: ${row.created_by})`);
      
      // 如果 created_by 为空，尝试从 ID 中提取用户 ID
      if (!row.created_by) {
        const match = row.id.match(/^user_(\d+)_/);
        if (match) {
          const userId = parseInt(match[1]);
          console.log(`    -> 设置 created_by = ${userId}`);
          await client.query(
            'UPDATE providers SET created_by = $1 WHERE id = $2',
            [userId, row.id]
          );
        }
      }
    }

    console.log('\n修复完成');
  } catch (error) {
    console.error('错误:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
