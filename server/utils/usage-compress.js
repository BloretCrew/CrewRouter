/**
 * 数据保留 Phase 2（任务书 .hermes/plans/20260827_phase2_compress.md）：
 * 会话增量压缩（delta 存储）。
 *
 * 原理：同一会话（plugin_meta->'attribution'->>'sessionId'）内客户端每请求重放全量
 * 上下文，messages 是前缀累积。把第 2 条起的记录改写为「相对前一条新增尾部」（delta），
 * 渲染时按序 concat 还原，省 ~99% 体积且保留请求边界。
 *
 * 数据模型（usage_records 新增列，全部 IF NOT EXISTS 单条执行）：
 * - storage_mode：'full'（完整存储，含压缩锚点）| 'delta'（相对前一条的尾部）| NULL（未压缩记录）
 * - delta_seq：会话内序号（第 1 条为 1，delta 依次递增）；展开时保证顺序
 * - orig_ctx_msgs / orig_ctx_bytes：压缩前 messages 数组长度与 messages::text 字节数，
 *   上下文压力曲线直读（Phase 4）；usage_message_analysis 有 usage_id 外键，压缩不动它
 * - plugin_meta->'attribution'.archived=true + compressedAt=now 标记会话已压缩
 *
 * 安全纪律：DDL 全部 IF NOT EXISTS 单条执行；压缩分批 + 批间 sleep（2000ms）+
 * 单会话事务 + isHealthy 健康检查（连续两次失败中止）；绝不在一条事务里处理 >20 个会话；
 * 全程 retention.log。
 */

const { pool } = require('../models/database');
const Logger = require('../logger');
const { logRetention } = require('./retention-log');
const { isHealthy, getRetentionConfig } = require('./usage-agg');

const GB = 1024 * 1024 * 1024;
// 大小阈值模式：压缩到表大小回落到阈值的 90% 以下才算达标
const SIZE_RECOVER_RATIO = 0.9;
// 展开链最长拉取上限（防御性护栏，正常会话远小于此）
const MAX_CHAIN_RECORDS = 2000;
// 手动 runCompressOnce 单次运行的总会话数上限（可被 opts 覆盖）
const DEFAULT_MAX_TOTAL_SESSIONS = 200;

// ---------- DDL（幂等） ----------

/** 加列（任务书 A）：IF NOT EXISTS 单条执行，重复调用无副作用 */
async function ensureUsageCompressColumns() {
  await pool.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS storage_mode text DEFAULT 'full'`);
  await pool.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS delta_seq int`);
  await pool.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS orig_ctx_msgs int`);
  await pool.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS orig_ctx_bytes bigint`);
  await pool.query(`ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS delta_base int`);
}

// ---------- 工具 ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(n) {
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function isArchived(pluginMeta) {
  return Boolean(pluginMeta && pluginMeta.attribution && pluginMeta.attribution.archived === true);
}

function jsonBytes(value) {
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function tableSizeBytes() {
  const r = await pool.query(`SELECT pg_total_relation_size('usage_records') AS bytes`);
  return Number((r.rows[0] && r.rows[0].bytes) || 0);
}

/** 会话全部记录（created_at,id 排序），压缩与展开共用 */
async function loadSessionRecords(sessionId) {
  const r = await pool.query(`
    SELECT id, created_at, messages, storage_mode, delta_seq, plugin_meta
    FROM usage_records
    WHERE plugin_meta->'attribution'->>'sessionId' = $1
    ORDER BY created_at ASC, id ASC
  `, [sessionId]);
  return r.rows;
}

// ---------- 公共前缀（数组元素级，JSON 序列化 hash 比对） ----------

/** 每条消息取一次 JSON 序列化 hash，前缀比对复用，避免重复 stringify 大对象 */
function elementHashes(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  return arr.map((m) => JSON.stringify(m));
}

/** 两个 hash 数组的最长公共前缀长度（元素级相同则前缀继续，直到不同） */
function commonPrefixLen(prevHashes, curHashes) {
  const n = Math.min(prevHashes.length, curHashes.length);
  let L = 0;
  while (L < n && prevHashes[L] === curHashes[L]) L++;
  return L;
}

// ---------- 压缩计划（纯函数，dry-run 与真实压缩共用） ----------

/**
 * 生成会话压缩计划（不落库）：
 * - 第 1 条保持 full（delta_seq=1，orig_ctx_* 记录原值）
 * - 第 i 条(i>=2)：公共前缀 L >= max(1, 原长度一半) → messages=原.slice(L)，
 *   storage_mode='delta', delta_seq=i；否则视为异常保持 full
 * - 每条都记 orig_ctx_msgs / orig_ctx_bytes（原 messages::text 字节数）
 * @param {Array<object>} records loadSessionRecords 输出（created_at,id 有序）
 * @returns {Array<{id, storage_mode, delta_seq, orig_ctx_msgs, orig_ctx_bytes, messages}>}
 */
function buildCompressionPlan(records) {
  const plan = [];
  let prevHashes = null;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const msgs = Array.isArray(rec.messages) ? rec.messages : [];
    const curHashes = elementHashes(msgs);
    let newMessages = msgs;
    let mode = 'full';
    let seq = null;
    let base = null;
    if (i === 0) {
      seq = 1;
    } else if (prevHashes) {
      const L = commonPrefixLen(prevHashes, curHashes);
      if (L >= Math.max(1, Math.ceil(msgs.length / 2))) {
        newMessages = msgs.slice(L);
        mode = 'delta';
        seq = i + 1;
        base = L;
      }
    }
    plan.push({
      id: rec.id,
      storage_mode: mode,
      delta_seq: seq,
      delta_base: typeof base === 'undefined' ? null : base,
      orig_ctx_msgs: msgs.length,
      orig_ctx_bytes: jsonBytes(rec.messages),
      messages: newMessages,
    });
    prevHashes = curHashes;
  }
  return plan;
}

// ---------- 导出 1：可压缩会话清单 ----------

/**
 * 返回超过 limitDays 天、未压缩（attribution.archived 非 true）的会话 sessionId 清单，
 * 按最老优先（会话首个记录 created_at ASC）。limitDays<=0 表示不限年龄（手动触发用）。
 * @param {number} limitDays 年龄门槛（天）
 * @param {number} batchSize 单批会话数上限（默认 20，安全纪律：单事务 ≤20 会话）
 */
async function findCompressibleSessions(limitDays = 14, batchSize = 20) {
  const params = [];
  let having = '';
  if (limitDays > 0) {
    params.push(limitDays);
    having = `HAVING MIN(u.created_at) < NOW() - ($${params.length}::int * INTERVAL '1 day')`;
  }
  const r = await pool.query(`
    SELECT s.session_id, s.first_ts, s.record_count FROM (
      SELECT
        plugin_meta->'attribution'->>'sessionId' AS session_id,
        MIN(created_at) AS first_ts,
        COUNT(*)::int AS record_count
      FROM usage_records u
      WHERE COALESCE(plugin_meta->'attribution'->>'sessionId', '') <> ''
        AND (plugin_meta->'attribution'->>'archived') IS DISTINCT FROM 'true'
      GROUP BY 1
      ${having}
    ) s
    WHERE s.record_count >= 2
    ORDER BY s.first_ts ASC
    LIMIT $${params.length + 1}
  `, [...params, batchSize]);
  return r.rows.map((row) => ({
    sessionId: row.session_id,
    firstTs: row.first_ts,
    recordCount: Number(row.record_count || 0),
  }));
}

// ---------- 导出 2：压缩单个会话（单会话事务） ----------

/**
 * 压缩一个会话的全部记录。dryRun=true 只计算不写库（供首次 dry-run 校验）。
 * 已压缩（archived=true）的会话直接跳过，避免对已有 delta 链二次压缩。
 * @returns {Promise<{sessionId, recordCount, compressedCount, originalBytes,
 *   deltaBytes, savedBytes, skipped?: string, records?: Array}>}
 */
async function compressSession(sessionId, { dryRun = false } = {}) {
  await ensureUsageCompressColumns();
  const rows = await loadSessionRecords(sessionId);
  const recordCount = rows.length;
  if (!recordCount) {
    logRetention(`[压缩] 会话 ${sessionId} 无记录，跳过`);
    return { sessionId, recordCount: 0, compressedCount: 0, originalBytes: 0, deltaBytes: 0, savedBytes: 0, skipped: 'no-records' };
  }
  if (rows.some((r) => isArchived(r.plugin_meta))) {
    logRetention(`[压缩] 会话 ${sessionId} 已压缩（archived=true），跳过避免二次压缩`);
    return { sessionId, recordCount, compressedCount: 0, originalBytes: 0, deltaBytes: 0, savedBytes: 0, skipped: 'already-archived' };
  }

  const plan = buildCompressionPlan(rows);
  const compressedCount = plan.filter((p) => p.storage_mode === 'delta').length;
  const originalBytes = rows.reduce((sum, r) => sum + jsonBytes(r.messages), 0);
  const deltaBytes = plan.reduce((sum, p) => sum + jsonBytes(p.messages), 0);
  const savedBytes = originalBytes - deltaBytes;

  if (dryRun) {
    return { sessionId, recordCount, compressedCount, originalBytes, deltaBytes, savedBytes, records: plan };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query(`
        UPDATE usage_records
        SET messages = $2::jsonb,
            storage_mode = $3,
            delta_seq = $4,
            delta_base = $5,
            orig_ctx_msgs = $6,
            orig_ctx_bytes = $7,
            plugin_meta = jsonb_set(
              jsonb_set(COALESCE(plugin_meta, '{}'::jsonb), '{attribution,compressedAt}', $8::jsonb),
              '{attribution,archived}', 'true'::jsonb)
        WHERE id = $1
      `, [p.id, JSON.stringify(p.messages), p.storage_mode, p.delta_seq, p.delta_base, p.orig_ctx_msgs, p.orig_ctx_bytes, JSON.stringify(new Date().toISOString())]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    Logger.error(`[压缩] 会话 ${sessionId} 事务回滚: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }

  logRetention(`[压缩] 会话 ${sessionId}：${recordCount} 条记录，压缩 ${compressedCount} 行，节省 ${formatBytes(savedBytes)}`);
  return { sessionId, recordCount, compressedCount, originalBytes, deltaBytes, savedBytes };
}

// ---------- 导出 3：批量压缩（分批 + sleep + 健康检查） ----------

/**
 * 批量压缩：循环 findCompressibleSessions → compressSession，累计统计。
 * 批间 sleep 2000ms；每批前 isHealthy() 检查，连续两次失败中止。
 * dryRun 只统计不写库。sizeGb>0 时每批后检查表大小，回落到阈值 90% 以下即停。
 * @returns {Promise<{sessions, records, savedBytes, batches, aborted, dryRun}>}
 */
async function compressBatch(limitDays = 14, { maxSessions = 20, dryRun = false, sizeGb = 0, maxTotalSessions = 0 } = {}) {
  await ensureUsageCompressColumns();
  let totalSessions = 0;
  let totalRecords = 0;
  let totalSaved = 0;
  let batches = 0;
  let aborted = false;
  let consecutiveFailures = 0;

  while (true) {
    if (!(await isHealthy())) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        aborted = true;
        logRetention('[压缩] 中止：连续两次健康检查失败');
        break;
      }
    } else {
      consecutiveFailures = 0;
    }

    const sessions = await findCompressibleSessions(limitDays, maxSessions);
    if (!sessions.length) break;

    let batchRecords = 0;
    let batchSaved = 0;
    for (const s of sessions) {
      const r = await compressSession(s.sessionId, { dryRun });
      if (r.skipped) continue;
      totalRecords += r.compressedCount || 0;
      batchRecords += r.compressedCount || 0;
      totalSaved += r.savedBytes || 0;
      batchSaved += r.savedBytes || 0;
      totalSessions++;
    }
    batches++;
    logRetention(`[压缩]${dryRun ? '[dry-run]' : ''} 第 ${batches} 批：会话 ${sessions.length} 个，压缩行 ${batchRecords}，节省 ${formatBytes(batchSaved)}`);

    if (sizeGb > 0) {
      const sizeBytes = await tableSizeBytes();
      if (sizeBytes <= sizeGb * GB * SIZE_RECOVER_RATIO) {
        logRetention(`[压缩] 表大小已回落至阈值 90% 以下（${formatBytes(sizeBytes)}），停止`);
        break;
      }
    }
    if (maxTotalSessions > 0 && totalSessions >= maxTotalSessions) {
      logRetention(`[压缩] 达到单次运行会话数上限（${maxTotalSessions}），停止`);
      break;
    }
    await sleep(2000);
  }

  logRetention(`[压缩] ${aborted ? '中止' : '完成'}：共处理会话 ${totalSessions} 个，压缩行 ${totalRecords}，节省 ${formatBytes(totalSaved)}${dryRun ? '（dry-run，未写库）' : ''}`);
  return { sessions: totalSessions, records: totalRecords, savedBytes: totalSaved, batches, aborted, dryRun };
}

// ---------- 导出 4：展开还原 ----------

/**
 * 把会话记录展开为「截至每条时的完整消息数组」（按输入顺序，逐条对齐）。
 * - full 记录（或未压缩/NULL 记录）自带完整上下文（客户端重放），直接取自身 messages 并重新锚定
 * - delta 记录按序 concat 到锚点上（保持消息顺序）
 * 所有记录均为 full 时逐条返回自身 messages（兼容未压缩会话；需要整段拼接时
 * 消费方自行 [].concat(...result)，与原渲染等价）。
 * @param {Array<object>} records create_at,id 有序的原始行（需含 messages/storage_mode/delta_seq）
 * @returns {Array<Array>} 与输入对齐的完整消息数组列表
 */
function expandSessionMessages(records) {
  const out = [];
  let acc = null;
  for (const rec of records || []) {
    const msgs = Array.isArray(rec && rec.messages) ? rec.messages : [];
    const isDelta = String(rec && rec.storage_mode || '') === 'delta' && rec.delta_seq != null;
    if (isDelta && acc) {
      // 替换语义：delta 从公共前缀 delta_base 之后覆盖（兼容尾部替换/删改）
      const base = Number(rec && rec.delta_base) || 0;
      acc = acc.slice(0, base).concat(msgs);
    } else {
      acc = msgs;
    }
    out.push(acc);
  }
  return out;
}

// ---------- 导出 5：手动触发（Phase 4 /admin 界面接入点） ----------

/**
 * 手动触发一次压缩（Phase 4 /admin 界面只用这个函数，界面本任务不做）。
 * 配置联动：limitDays=retention.compress_days（默认 14）；
 * sizeGb=retention.compress_size_gb（默认 0=关）：表大小 > X GB 时按最老会话压缩
 * 直到回落到阈值 90% 以下。opts 可临时覆盖（手动/验证用）。
 */
async function runCompressOnce(opts = {}) {
  const cfg = await getRetentionConfig({ fresh: true });
  const limitDays = opts.limitDays !== undefined ? opts.limitDays : cfg.compressDays;
  const sizeGb = opts.sizeGb !== undefined ? opts.sizeGb : cfg.compressSizeGb;
  const maxSessions = opts.maxSessions || 20;
  const dryRun = Boolean(opts.dryRun);
  const maxTotalSessions = opts.maxTotalSessions !== undefined ? opts.maxTotalSessions : DEFAULT_MAX_TOTAL_SESSIONS;

  if (sizeGb > 0) {
    const sizeBytes = await tableSizeBytes();
    if (sizeBytes <= sizeGb * GB) {
      logRetention(`[压缩] 跳过：表大小 ${formatBytes(sizeBytes)} 未超过阈值 ${sizeGb} GB（compressDays=${limitDays}）`);
      return { skipped: 'size-under-threshold', sizeBytes, sessions: 0, records: 0, savedBytes: 0 };
    }
    logRetention(`[压缩] 大小触发：表大小 ${formatBytes(sizeBytes)} > ${sizeGb} GB，按最老会话压缩至阈值 90% 以下`);
    return compressBatch(limitDays, { maxSessions, dryRun, sizeGb, maxTotalSessions });
  }
  logRetention(`[压缩] 年龄触发：compressDays=${limitDays} 天`);
  return compressBatch(limitDays, { maxSessions, dryRun, maxTotalSessions });
}

module.exports = {
  ensureUsageCompressColumns,
  findCompressibleSessions,
  compressSession,
  compressBatch,
  expandSessionMessages,
  runCompressOnce,
  buildCompressionPlan,
};