'use strict';

const { Client } = require('pg');

// AGNT: shared by every run and approval for this thread. A dedicated connection
// avoids borrowing another pool slot while a long model call holds the claim.
const THREAD_LOCK_NAMESPACE = 0x41474e54;

async function claimThread(pool, threadId, userId) {
  const client = new Client(pool.options);
  try {
    // A dropped dedicated session releases its advisory lock. Consume its
    // error event; all managed writes use this same connection and then fail.
    client.on('error', () => {});
    await client.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [THREAD_LOCK_NAMESPACE, threadId]);
    if (!lock.rows[0].locked) { await client.end(); return null; }
    const thread = await client.query("SELECT id FROM agent_threads WHERE id=$1 AND user_id=$2 AND mode='manage'", [threadId, userId]);
    if (!thread.rows[0]) { await client.end(); return null; }
    return { client, async release() {
      try { await client.query('SELECT pg_advisory_unlock($1, $2)', [THREAD_LOCK_NAMESPACE, threadId]); }
      finally { await client.end(); }
    } };
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

// A supplied idle claim client keeps the claim and all writes on the same
// session: losing the session releases the claim and also aborts its writes.
async function decideApproval(pool, { threadId, approvalId, userId, decision, edition, transactionClient }, resolveToolDecision) {
  const client = transactionClient || await pool.connect();
  try {
    await client.query('BEGIN');
    // Fixed order: thread, approval, then the principal and tool target.
    const thread = await client.query("SELECT id FROM agent_threads WHERE id=$1 AND user_id=$2 AND mode='manage' FOR UPDATE", [threadId, userId]);
    if (!thread.rows[0]) throw new Error('对话不存在');
    const pending = await client.query("SELECT * FROM agent_approvals WHERE id=$1 AND thread_id=$2 AND user_id=$3 AND status='pending' FOR UPDATE", [approvalId, threadId, userId]);
    const approval = pending.rows[0];
    if (!approval) { await client.query('ROLLBACK'); return null; }
    const principal = await client.query('SELECT is_admin FROM users WHERE id=$1 FOR SHARE', [userId]);
    if (principal.rows[0]?.is_admin !== true) throw new Error('管理员权限已撤销');
    const output = await resolveToolDecision(client, { name: approval.tool_name, arguments: approval.arguments }, decision, { edition, approved: true });
    if (output?.error) throw new Error(output.error);
    await client.query('UPDATE agent_approvals SET status=$1, resolved_at=CURRENT_TIMESTAMP WHERE id=$2', [decision === 'allow' ? 'approved' : 'denied', approval.id]);
    await client.query(`INSERT INTO agent_messages(thread_id,role,content,tool_call_id,tool_name)
      VALUES($1,'tool',$2,$3,$4)`, [threadId, JSON.stringify(output), approval.tool_call_id, approval.tool_name]);
    await client.query('COMMIT');
    return { approval, output };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (!transactionClient) client.release(); }
}

module.exports = { claimThread, decideApproval };
