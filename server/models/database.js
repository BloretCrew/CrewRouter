const config = require('../config-loader');
const Logger = require('../logger');
const { APP_TIMEZONE, ensureProcessTimezone } = require('../utils/timezone');

// 进程与数据库会话统一使用上海时区，保证 TIMESTAMP 墙钟与业务日历日一致
ensureProcessTimezone();

const isDemo = config.demo === true;

let pool;

if (isDemo) {
  // 演示模式：导出模拟 pool，不连接数据库
  pool = {
    query: () => Promise.resolve({ rows: [], rowCount: 0, command: 'SELECT', fields: [] }),
    end: () => Promise.resolve(),
    on: () => {},
  };
  Logger.info('[数据库] 演示模式，跳过数据库连接');
} else {
  const { Pool } = require('pg');
  pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    // 每个后端连接默认时区（比 SET 更早生效）
    // idle_in_transaction_session_timeout：防止未提交事务长期占锁，堵住启动期 DDL
    // lock_timeout：避免启动迁移/业务查询在锁上无限等待（导致 HTTP 端口迟迟不监听）
    options: `-c timezone=${APP_TIMEZONE} -c idle_in_transaction_session_timeout=30000 -c lock_timeout=30000`
  });

  pool.on('error', (err) => {
    Logger.error('[数据库] 连接错误:', err);
  });

  Logger.info(`[数据库] 会话时区: ${APP_TIMEZONE}`);
}

module.exports = { pool };
