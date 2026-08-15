'use strict';

/**
 * 回填 usage_records.request_source
 * 对 unknown/空 记录，用已存 messages + user_agent 重新跑检测器。
 *
 * 用法：
 *   node server/scripts/backfill-request-source.js
 *   node server/scripts/backfill-request-source.js --dry-run
 *   node server/scripts/backfill-request-source.js --days 30 --batch 200
 */

const path = require('path');
// 保证从仓库根加载
process.chdir(path.join(__dirname, '../..'));

const { pool } = require('../models/database');
const { detectRequestSource } = require('../utils/request-source');

function parseArgs(argv) {
  const opts = { dryRun: false, days: 90, batch: 150, limit: 0, reclassify: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--reclassify') opts.reclassify = true; // 重算所有有 messages 的行（纠正误标）
    else if (a === '--days') opts.days = parseInt(argv[++i], 10) || 90;
    else if (a === '--batch') opts.batch = Math.min(parseInt(argv[++i], 10) || 150, 500);
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10) || 0;
  }
  return opts;
}

function normalizeMessages(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('[backfill-request-source]', opts);

  let updated = 0;
  let scanned = 0;
  let lastId = 0;
  const counts = Object.create(null);

  for (;;) {
    if (opts.limit && scanned >= opts.limit) break;
    const take = opts.limit ? Math.min(opts.batch, opts.limit - scanned) : opts.batch;

    const filterSql = opts.reclassify
      ? 'AND messages IS NOT NULL'
      : `AND COALESCE(NULLIF(request_source, ''), 'unknown') = 'unknown' AND messages IS NOT NULL`;

    const { rows } = await pool.query(
      `
      SELECT id, user_agent, messages, request_source
      FROM usage_records
      WHERE id > $1
        AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
        ${filterSql}
      ORDER BY id ASC
      LIMIT $3
      `,
      [lastId, opts.days, take]
    );

    if (!rows.length) break;

    for (const row of rows) {
      scanned += 1;
      lastId = row.id;
      const messages = normalizeMessages(row.messages);
      if (!messages) continue;

      const body = Array.isArray(messages) ? { messages } : messages;
      const headers = {};
      if (row.user_agent) headers['user-agent'] = row.user_agent;

      const src = detectRequestSource(headers, {}, body);
      counts[src] = (counts[src] || 0) + 1;
      const prev = row.request_source || 'unknown';
      if (src === prev) continue;
      // 非 reclassify 模式不覆盖已有非 unknown 标签
      if (!opts.reclassify && prev !== 'unknown' && prev !== '') continue;

      if (!opts.dryRun) {
        await pool.query(`UPDATE usage_records SET request_source = $1 WHERE id = $2`, [src, row.id]);
      }
      updated += 1;
      if (updated <= 20 || updated % 200 === 0) {
        console.log(`  #${updated} id=${row.id} ${prev} -> ${src}`);
      }
    }

    console.log(`progress scanned=${scanned} updated=${updated} lastId=${lastId}`);
  }

  console.log('[backfill-request-source] done', {
    scanned,
    updated,
    dryRun: opts.dryRun,
    breakdown: counts,
  });

  // 打印回填后近 30 天识别率
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE request_source IS NOT NULL AND request_source NOT IN ('','unknown'))::int AS known
      FROM usage_records
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);
    const total = r.rows[0].total || 0;
    const known = r.rows[0].known || 0;
    console.log(
      `[backfill-request-source] 30d identified_rate=${total ? ((known / total) * 100).toFixed(1) : 0}% (${known}/${total})`
    );
  } catch (e) {
    console.warn('rate query failed:', e.message);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
