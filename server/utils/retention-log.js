/**
 * 数据保留与归档任务书（.hermes/plans/20260825_retention_impl_task.md）专用日志。
 * 回填/每日聚合及其后续阶段的压缩/清除任务统一追加写入 .hermes/retention.log。
 */

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '../../.hermes/retention.log');

function logRetention(...args) {
  const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_PATH, `[${ts}] ${line}\n`);
  } catch (err) {
    // 日志写入失败不阻塞主流程
  }
}

module.exports = { logRetention, LOG_PATH };