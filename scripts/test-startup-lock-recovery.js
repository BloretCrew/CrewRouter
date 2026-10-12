/**
 * 启动锁自愈（server/utils/startup-lock-recovery.js）行为验证
 *
 * 运行：node scripts/test-startup-lock-recovery.js
 *
 * 用自建探针表模拟"未提交事务持有锁的僵尸会话"，验证：
 * 1. 僵尸 idle in transaction 会话超过阈值后被终止，阻塞的 DDL 随之解除；
 * 2. 健康 idle 会话不受影响；
 * 3. 未超过阈值的 idle in transaction 会话不受影响。
 */
const { Pool, Client } = require('pg');
const config = require('../server/config-loader');
const { recoverStartupLockBlockers } = require('../server/utils/startup-lock-recovery');

const base = {
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
};

let failed = 0;
function check(name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

async function tryDropProbe() {
  const client = new Client(base);
  await client.connect();
  try {
    await client.query("SET lock_timeout = '300ms'");
    await client.query('DROP TABLE IF EXISTS _zz_lock_recovery_probe');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  } finally {
    client.end();
  }
}

async function main() {
  const setup = new Pool(base);

  // 1. 先提交建表，再让僵尸会话锁住它（未提交事务里建的表其他会话不可见）
  await setup.query('DROP TABLE IF EXISTS _zz_lock_recovery_probe');
  await setup.query('CREATE TABLE _zz_lock_recovery_probe (id int)');

  const zombie = new Client(base);
  await zombie.connect();
  await zombie.query('BEGIN');
  await zombie.query('LOCK TABLE _zz_lock_recovery_probe IN ACCESS EXCLUSIVE MODE');

  let drop = await tryDropProbe();
  check('僵尸事务持锁期间 DDL 超时', !drop.ok && drop.code === '55P03', drop.message || '');

  // 2. 自愈应终止僵尸会话
  const result = await recoverStartupLockBlockers({ minWedgeAgeMs: 100 });
  check('自愈报告终止了会话', result.terminated === 1, `terminated=${result.terminated}`);

  let zombieDead = false;
  try {
    await zombie.query('SELECT 1');
  } catch (err) {
    zombieDead = /terminat/i.test(err.message) || err.code === '57P01';
  }
  check('僵尸连接已被服务端断开', zombieDead);
  await zombie.end().catch(() => {});

  drop = await tryDropProbe();
  check('自愈后 DDL 可正常执行', drop.ok, drop.message || '');

  // 3. 健康 idle 会话不应被误杀
  const healthy = new Client(base);
  await healthy.connect();
  await healthy.query('SELECT 1');
  await recoverStartupLockBlockers({ minWedgeAgeMs: 100 });
  let healthyAlive = true;
  try {
    await healthy.query('SELECT 2');
  } catch (err) {
    healthyAlive = false;
  }
  check('健康 idle 会话存活', healthyAlive);
  healthy.end();

  // 4. 未超过阈值的 idle in transaction 会话不应被误杀
  const young = new Client(base);
  await young.connect();
  await young.query('BEGIN');
  await young.query('SELECT 1');
  await recoverStartupLockBlockers({ minWedgeAgeMs: 60000 });
  let youngAlive = true;
  try {
    await young.query('SELECT 2');
  } catch (err) {
    youngAlive = false;
  }
  check('未超阈值的 idle in transaction 会话存活', youngAlive);
  await young.query('ROLLBACK');
  young.end();

  const cleanup = new Pool(base);
  await cleanup.query('DROP TABLE IF EXISTS _zz_lock_recovery_probe');
  await cleanup.end();
  await setup.end().catch(() => {});

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[测试异常]', err);
  process.exit(1);
});
