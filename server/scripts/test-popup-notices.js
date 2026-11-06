'use strict';

// 弹窗通知存储层：隔离 PostgreSQL 集群 + 注入 pool 的纯函数测试。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { test } = require('node:test');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

/** 加载 server/utils/popup-notices.js，并把 ../models/database 换成测试 pool */
function loadStore(pool) {
  const context = {
    module: { exports: {} },
    console,
    require(name) {
      if (name === '../models/database') return { pool };
      if (name === '../logger') return { error() {}, warn() {}, info() {} };
      throw new Error(`Unexpected fixture dependency: ${name}`);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../utils/popup-notices.js'), 'utf8'),
    context
  );
  return context.module.exports;
}

test('popup notices storage is user-scoped, idempotent and cascade-safe', async t => {
  const cluster = createIsolatedPostgres('popup-notices');
  const pool = new Pool({ ...cluster.connection, max: 4 });
  const store = loadStore(pool);
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users(id int PRIMARY KEY);
      INSERT INTO users VALUES (1),(2),(3)`);
    await store.ensurePopupNoticeSchema(pool);
    await store.ensurePopupNoticeSchema(pool); // 可重复执行

    const created = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(await store.createNotice({
        title: `通知 ${i + 1}`,
        body: `正文 ${i + 1}`,
        closeText: i === 0 ? '' : `关闭 ${i + 1}`,
        enabled: i !== 1, // 第二条停用
      }, pool));
    }
    assert.deepEqual(created.map(item => item.id), [1, 2, 3]);
    assert.equal(created[0].closeText, '知道了', '关闭文字为空时回落到默认值');
    assert.equal(created[1].enabled, false);

    await t.test('unseen excludes disabled notices and preserves id order', async () => {
      const unseen = await store.listUnseenForUser(1, pool);
      assert.deepEqual(unseen.map(item => item.id), [1, 3]);
      assert.equal(unseen[0].title, '通知 1');
      assert.equal(unseen[0].closeText, '知道了');
      assert.equal(unseen[1].closeText, '关闭 3');
      assert.deepEqual(unseen[0].body, '正文 1');
    });

    await t.test('mark seen is idempotent and isolated per user', async () => {
      assert.equal(await store.markSeenForUser(1, [1], pool), 1);
      assert.equal(await store.markSeenForUser(1, [1], pool), 0, '重复标记不再新增');
      assert.deepEqual((await store.listUnseenForUser(1, pool)).map(item => item.id), [3]);
      assert.deepEqual((await store.listUnseenForUser(2, pool)).map(item => item.id), [1, 3], '其他用户不受影响');
      assert.equal(await store.markSeenForUser(1, [], pool), 0);
    });

    await t.test('invalid ids are rejected before touching the database', async () => {
      assert.throws(() => store.normalizeIds('nope'), /数组/);
      assert.throws(() => store.normalizeIds([0]), /非法/);
      assert.throws(() => store.normalizeIds([-1]), /非法/);
      assert.throws(() => store.normalizeIds([1.5]), /非法/);
      assert.throws(() => store.normalizeIds(Array.from({ length: 101 }, (_, i) => i + 1)), /最多/);
      assert.throws(() => store.normalizeNoticeInput({ title: '   ' }), /标题不能为空/);
      await assert.rejects(() => store.markSeenForUser(1, [0], pool), error => error.statusCode === 400);
    });

    await t.test('duplicate ids in one request are collapsed', async () => {
      assert.equal(await store.markSeenForUser(3, [3, 3, 3], pool), 1);
      assert.deepEqual((await store.listUnseenForUser(3, pool)).map(item => item.id), [1]);
    });

    await t.test('admin list reports seen counts and survives disabled notices', async () => {
      const items = await store.listForAdmin(pool);
      assert.deepEqual(items.map(item => item.id), [1, 2, 3]);
      assert.equal(items[0].seenCount, 1, '用户 1 已读通知 1');
      assert.equal(items[1].seenCount, 0);
      assert.equal(items[2].seenCount, 1, '用户 3 已读通知 3');
      assert.equal(items[1].enabled, false);
    });

    await t.test('editing keeps seen state; reset re-surfaces the notice', async () => {
      const updated = await store.updateNotice(1, { title: '通知 1（改）', body: '新正文', closeText: '关闭', enabled: true }, pool);
      assert.equal(updated.title, '通知 1（改）');
      assert.equal(updated.seenCount, 1, '编辑不清除已读');
      assert.deepEqual((await store.listUnseenForUser(1, pool)).map(item => item.id), [3]);
      assert.equal(await store.resetSeen(1, pool), 1);
      assert.deepEqual((await store.listUnseenForUser(1, pool)).map(item => item.id), [1, 3]);
    });

    await t.test('toggle enabled hides / shows without losing seen rows', async () => {
      const toggled = await store.setNoticeEnabled(3, false, pool);
      assert.equal(toggled.enabled, false);
      assert.deepEqual((await store.listUnseenForUser(2, pool)).map(item => item.id), [1]);
      assert.equal((await store.listForAdmin(pool))[2].seenCount, 1);
      assert.equal(await store.setNoticeEnabled(999, true, pool), null);
    });

    await t.test('deleting a notice removes its views and never breaks the seen insert', async () => {
      assert.equal(await store.deleteNotice(1, pool), true);
      assert.equal(await store.deleteNotice(1, pool), false);
      const rows = await pool.query('SELECT COUNT(*)::int AS n FROM popup_notice_views WHERE notice_id = 1');
      assert.equal(rows.rows[0].n, 0, '外键级联清理已读');
      // 已删除 id 混在批量里不应报外键错误；仍存在的通知照常写入
      assert.equal(await store.markSeenForUser(1, [1, 3], pool), 1);
      assert.equal(await store.updateNotice(1, { title: 'x' }, pool), null);
    });
  } finally {
    await pool.end();
    cluster.stop();
  }
});
