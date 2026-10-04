'use strict';

/**
 * 静态回归：消息分析扫描不得在长事务中持有 usage_records 行锁。
 * 此前 BEGIN + FOR UPDATE 跨 analyzeMessages 会导致 idle in transaction，堵住启动 DDL。
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../utils/message-analysis-store.js'),
  'utf8'
);

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

assert(!/FOR UPDATE OF ur/.test(source), 'scanPendingMessageAnalysis 不应再使用 FOR UPDATE OF ur');
assert(!/await client\.query\('BEGIN'\)/.test(source), 'scanPendingMessageAnalysis 不应再开启长事务 BEGIN');
assert(/ON CONFLICT \(usage_id\) DO NOTHING/.test(source), '仍应使用 ON CONFLICT 消化并发写入');
assert(/analyzeMessages\(row\.messages\)/.test(source), '仍应调用 analyzeMessages');

console.log('All message-analysis-store static assertions passed.');
