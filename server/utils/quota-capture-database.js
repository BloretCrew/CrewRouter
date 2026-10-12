'use strict';
const config = require('../config-loader');
let capturePool;
function getQuotaCapturePool() {
  if (config.demo === true) return require('../models/database').pool;
  if (!capturePool) {
    const { Pool } = require('pg');
    capturePool = new Pool({
      host: config.database.host, port: config.database.port, database: config.database.name,
      user: config.database.user, password: config.database.password,
      max: 4, connectionTimeoutMillis: 1000, query_timeout: 5000,
      options: '-c timezone=Asia/Shanghai -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000'
    });
    capturePool.on('error', () => require('../logger').warn('[请求额度] 采集数据库连接不可用'));
  }
  return capturePool;
}
async function closeQuotaCapturePool() {
  const current = capturePool; capturePool = null;
  if (current) await current.end();
}
module.exports = { getQuotaCapturePool, closeQuotaCapturePool };
