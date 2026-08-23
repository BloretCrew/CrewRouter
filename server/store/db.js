/**
 * 插件商店：中央站点真实 PostgreSQL 访问器
 *
 * 中央 demo 站（config.demo === true）的主连接池是 mock（见 models/database.js），
 * 但商店（plugin_store_*）与登录上报（login_reports）需要真实数据库。
 * 此模块统一提供一个真实 pg.Pool 给 store / login-report 共用，避免重复建池。
 * 注意：连接是惰性的，require 不会立即连库，首次 query 才建立连接。
 */

const { Pool } = require('pg');
const config = require('../config-loader');
const Logger = require('../logger');

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
  });
  pool.on('error', (err) => {
    Logger.error('[store-db] 数据库连接错误:', err.message);
  });
  Logger.info('[store-db] 商店真实连接池已就绪');
  return pool;
}

function q(sql, params) {
  return getPool().query(sql, params);
}

module.exports = { getPool, q };
