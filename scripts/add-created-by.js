const { pool } = require('../server/models/database');
const Logger = require('../server/logger');

async function main() {
  const client = await pool.connect();
  try {
    // 检查 providers 表是否有 created_by 列
    const colCheck = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    
    if (colCheck.rows.length === 0) {
      console.log('providers 表没有 created_by 列，正在添加...');
      await client.query('ALTER TABLE providers ADD COLUMN created_by INTEGER REFERENCES users(id)');
      console.log('已添加 created_by 列');
    } else {
      console.log('providers 表已有 created_by 列');
    }

    // 检查 models_url 和 notes 列
    const modelsUrlCheck = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'models_url'"
    );
    if (modelsUrlCheck.rows.length === 0) {
      console.log('providers 表没有 models_url 列，正在添加...');
      await client.query('ALTER TABLE providers ADD COLUMN models_url VARCHAR(500)');
      console.log('已添加 models_url 列');
    }

    const notesCheck = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'notes'"
    );
    if (notesCheck.rows.length === 0) {
      console.log('providers 表没有 notes 列，正在添加...');
      await client.query('ALTER TABLE providers ADD COLUMN notes TEXT');
      console.log('已添加 notes 列');
    }

    // 列出所有供应商
    const result = await client.query('SELECT id, name, created_by FROM providers ORDER BY created_by NULLS FIRST');
    console.log('\n当前供应商列表:');
    for (const row of result.rows) {
      console.log(`  ${row.id}: ${row.name} (created_by: ${row.created_by || 'NULL'})`);
    }

  } catch (error) {
    console.error('错误:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
