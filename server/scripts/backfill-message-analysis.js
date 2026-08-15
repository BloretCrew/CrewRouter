'use strict';

const { pool } = require('../models/database');
const { scanPendingMessageAnalysis } = require('../utils/message-analysis-store');
const Logger = require('../logger');

async function main() {
  const args = process.argv.slice(2);
  const batchIndex = args.indexOf('--batch');
  const batchSize = batchIndex >= 0 ? Number(args[batchIndex + 1]) || 100 : 100;
  let total = 0;
  while (true) {
    const result = await scanPendingMessageAnalysis({ batchSize });
    total += result.scanned || 0;
    if (!result.scanned || result.error) break;
  }
  Logger.info(`[消息分析回填] 完成，共处理 ${total} 条记录`);
  await pool.end();
  process.exit(0);
}

main().catch(async (error) => {
  Logger.error(`[消息分析回填] 失败: ${error.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
