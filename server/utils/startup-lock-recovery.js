/**
 * 启动期数据库锁阻塞自愈
 *
 * 主机异常重启或进程被强杀后，PostgreSQL 服务端的半开连接会继续持有未提交事务的锁
 * （典型症状：会话停在 Client/ClientRead，事务已挂起很久）。此时 init-db 的
 * ALTER TABLE 等 DDL 拿不到锁，启动重试会全部超时。
 *
 * 这里只清理两类明确的卡死会话，让下一次重试能拿到锁：
 * 1. idle in transaction 且持续超过阈值（业务连接池自身设了 30s 空闲事务超时，
 *    正常会话不可能触发）；
 * 2. 当前查询在等待客户端读取（wait = Client/ClientRead）且事务已打开超过阈值，
 *    即客户端已停止消费响应的卡死流。
 *
 * 不处理普通长查询/长事务，避免误伤正常业务；仅在启动重试锁等待时调用。
 */
const { Pool } = require('pg');
const config = require('../config-loader');
const Logger = require('../logger');

async function recoverStartupLockBlockers({ minWedgeAgeMs = 60000 } = {}) {
  if (config.demo === true) {
    return { terminated: 0 };
  }

  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
  });

  try {
    const { rows: victims } = await pool.query(`
      SELECT pid, usename, state,
             wait_event_type, wait_event,
             floor(extract(epoch FROM (now() - xact_start)))::int AS xact_age_secs,
             left(regexp_replace(query, E'[\\n\\r\\t]+', ' ', 'g'), 120) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND backend_type = 'client backend'
        AND pid <> pg_backend_pid()
        AND (
          (
            state IN ('idle in transaction', 'idle in transaction (aborted)')
            AND state_change < now() - make_interval(secs => $1 / 1000.0)
          ) OR (
            state = 'active'
            AND wait_event_type = 'Client'
            AND wait_event = 'ClientRead'
            AND xact_start IS NOT NULL
            AND state_change < now() - make_interval(secs => $1 / 1000.0)
          )
        )
    `, [minWedgeAgeMs]);

    if (victims.length === 0) {
      Logger.info('[启动锁自愈] 未发现卡死的阻塞会话');
      return { terminated: 0 };
    }

    let terminated = 0;
    for (const victim of victims) {
      try {
        await pool.query('SELECT pg_terminate_backend($1)', [victim.pid]);
        terminated += 1;
        Logger.warn(
          `[启动锁自愈] 已终止疑似僵尸会话 pid=${victim.pid} user=${victim.usename} ` +
          `state=${victim.state} wait=${victim.wait_event_type}/${victim.wait_event || ''} ` +
          `事务时长=${victim.xact_age_secs == null ? 'N/A' : `${victim.xact_age_secs}s`} ` +
          `最近语句=${victim.query}`
        );
      } catch (err) {
        Logger.warn(`[启动锁自愈] 终止 pid=${victim.pid} 失败: ${err.message}`);
      }
    }
    return { terminated };
  } finally {
    await pool.end().catch(() => {});
  }
}

module.exports = { recoverStartupLockBlockers };
