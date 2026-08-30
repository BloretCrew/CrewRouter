'use strict';

const { pool } = require('../models/database');
const { buildTeamReadPredicate } = require('../utils/team-read-access');

async function auditTeamConsistency(db = pool) {
  const checks = [
    ['users.team_id 与 user_teams 不一致', `
      SELECT u.id, u.team_id, COALESCE(primary_team.team_id, NULL) AS membership_team_id
      FROM users u
      LEFT JOIN LATERAL (
        SELECT ut.team_id FROM user_teams ut
        WHERE ut.user_id = u.id ORDER BY ut.created_at ASC, ut.id ASC LIMIT 1
      ) primary_team ON TRUE
      WHERE u.team_id IS DISTINCT FROM primary_team.team_id
      ORDER BY u.id
    `],
    ['user_teams 孤儿成员', `
      SELECT ut.id, ut.user_id, ut.team_id
      FROM user_teams ut
      LEFT JOIN users u ON u.id = ut.user_id
      LEFT JOIN teams t ON t.id = ut.team_id
      WHERE u.id IS NULL OR t.id IS NULL
      ORDER BY ut.id
    `],
    ['team_models 孤儿映射', `
      SELECT tm.id, tm.team_id, tm.model_id
      FROM team_models tm
      LEFT JOIN teams t ON t.id = tm.team_id
      LEFT JOIN models m ON m.id = tm.model_id
      WHERE t.id IS NULL OR m.id IS NULL
      ORDER BY tm.id
    `],
  ];
  const results = [];
  for (const [name, sql] of checks) {
    const result = await db.query(sql);
    results.push({ name, count: result.rows.length, rows: result.rows });
  }
  return { dryRun: true, ok: results.every(result => result.count === 0), checks: results };
}

async function main() {
  if (!process.argv.includes('--dry-run')) {
    throw new Error('仅支持 --dry-run；此审计脚本不会执行修复或写入');
  }
  const report = await auditTeamConsistency();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) main().catch(error => {
  console.error(`[team-consistency] ${error.message}`);
  process.exitCode = 2;
});

module.exports = { auditTeamConsistency, main, buildTeamReadPredicate };
