const { compressSession, expandSessionMessages } = require('/data/CrewRouter/server/utils/usage-compress');
const pool = require('/data/CrewRouter/server/models/database').pool;

(async () => {
  // 抽 10 个多记录会话（>5 条）做 dry-run
  const candidates = await pool.query(`
    SELECT plugin_meta->'attribution'->>'sessionId' sk, COUNT(*) n
    FROM usage_records
    WHERE plugin_meta->'attribution'->>'sessionId' IS NOT NULL
      AND (plugin_meta->'attribution'->>'archived') IS DISTINCT FROM 'true'
    GROUP BY 1 HAVING COUNT(*) > 5 AND SUM(LENGTH(messages::text)) < 200000000
    ORDER BY n DESC LIMIT 10
  `);
  console.log('candidates:', candidates.rows.length);
  let pass = 0;
  for (const row of candidates.rows) {
    const sk = row.sk;
    const recs = await pool.query(
      `SELECT id, messages, created_at, storage_mode, delta_seq FROM usage_records
       WHERE plugin_meta->'attribution'->>'sessionId' = $1 ORDER BY created_at, id`,
      [sk]
    );
    // 原始完整序列（按顺序 messages 数组；存储都是 full 时应等于各自 messages，列序保留）
    const origSeq = recs.rows;
    const dr = await compressSession(sk, { dryRun: true });
    // plan 元素形状：{id, storage_mode, delta_seq, messages, orig_ctx_*}
    const planMap = new Map((dr.records || []).map(p => [p.id, p]));
    const simulatedRows = recs.rows.map(r => {
      const p = planMap.get(r.id);
      return p ? { id: r.id, created_at: r.created_at, storage_mode: p.storage_mode, delta_seq: p.delta_seq, delta_base: p.delta_base, messages: p.messages } : r;
    });
    // 还原校验：expandSessionMessages(simulatedRows) 应与 "逐条累积" 的原始序列一致：
    // 原始第 i 条 messages = 前 i 条累积；还原后第 i 条也应展开到同样内容
    const expanded = expandSessionMessages(simulatedRows);
    // 展开后按记录数分组：expand 返回 [{id, messages}] 或 [{messages}]？先打印看结构
    let ok = false;
    if (Array.isArray(expanded) && expanded.length === recs.rows.length) {
      ok = expanded.every((e, idx) => {
        const orig = origSeq[idx].messages;
        return JSON.stringify(e) === JSON.stringify(orig);
      });
    } else {
      // 可能 expand 返回整个会话单数组——那比对第一条 full + 后续
      console.log('  expanded shape:', Array.isArray(expanded) ? `len=${expanded.length}` : typeof expanded);
    }
    pass += ok ? 1 : 0;
    console.log(`${ok ? 'PASS' : 'CHECK'} ${String(sk).slice(0,16)} n=${recs.rows.length} savedBytes=${dr.savedBytes}`);
  }
  console.log(`result: pass=${pass}/${candidates.rows.length}`);
  process.exit(pass === candidates.rows.length ? 0 : 1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });