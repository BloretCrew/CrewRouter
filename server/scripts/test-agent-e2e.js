'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

const PORT = Number(process.env.AGENT_E2E_PORT) || 20106;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/config`, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch (_) { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('server did not start');
}

function parseSse(text) {
  return text.split('\n\n')
    .flatMap(block => block.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => {
      try { return JSON.parse(line.slice(6)); } catch (_) { return null; }
    })
    .filter(Boolean);
}

async function main() {
  const cluster = createIsolatedPostgres('agent-e2e');
  const configPath = '/tmp/cr-agent-e2e-config.json';
  fs.writeFileSync(configPath, JSON.stringify({
    edition: 'team',
    app: {
      name: 'CrewRouter Agent E2E',
      port: PORT,
      host: '127.0.0.1',
      publicOrigin: BASE,
      sessionSecret: 'agent-e2e-session-secret',
      demo: false
    },
    database: {
      host: cluster.connection.host,
      port: cluster.connection.port,
      name: cluster.connection.database,
      user: cluster.connection.user,
      password: cluster.connection.password
    },
    loginReport: { enabled: false },
    statsReport: { enabled: false },
    store: { seedDemo: false, updateCheck: { enabled: false } },
    gateway: { masterKey: 'agent-e2e-master-key' },
    demo: false
  }, null, 2));

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      CR_CONFIG_PATH: configPath,
      CR_LOGIN_REPORT_ENABLED: 'false',
      CR_STATS_REPORT_ENABLED: 'false',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const pool = new Pool(cluster.connection);
  try {
    await waitForServer();
    const passwordHash = await bcrypt.hash('e2e-password', 8);
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('setup_complete', 'true'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
    await pool.query(
      `INSERT INTO instance_settings (singleton_key, edition) VALUES ('instance', 'team')
       ON CONFLICT (singleton_key) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, is_admin, balance, refund_balance, email_verified)
       VALUES (1, 'e2e-admin', 'e2e@example.invalid', $1, TRUE, 1000, 0, TRUE)
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_admin = TRUE, balance = 1000`,
      [passwordHash]
    );
    await pool.query(
      `INSERT INTO teams (id, name, is_default, is_personal) VALUES (1, 'E2E Team', TRUE, TRUE)
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(`INSERT INTO user_teams (user_id, team_id) VALUES (1, 1) ON CONFLICT DO NOTHING`);
    await pool.query(
      `INSERT INTO providers (id, name, base_url, api_key, format, enabled)
       VALUES ('e2e-provider', 'E2E Provider', 'https://example.invalid/v1', 'test-key', 'openai', TRUE)
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO models (id, name, provider, enabled, output_kind, upstream_model_id, model_multiplier)
       VALUES ('test-model', 'TestModel', 'e2e-provider', TRUE, 'chat', 'test-model', 1.0)
       ON CONFLICT (id) DO UPDATE SET enabled = TRUE, model_multiplier = 1.0`
    );
    await pool.query(
      `INSERT INTO team_models (team_id, model_id, enabled) VALUES (1, 'test-model', TRUE)
       ON CONFLICT (team_id, model_id) DO UPDATE SET enabled = TRUE`
    );

    const login = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ login: 'e2e-admin', password: 'e2e-password' })
    });
    if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
    const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
    const cookie = setCookies.filter(Boolean).map(value => value.split(';')[0]).join('; ');
    if (!cookie) throw new Error('login did not return a session cookie');

    const csrfResponse = await fetch(`${BASE}/api/csrf-token`, { headers: { cookie } });
    const csrf = await csrfResponse.json();
    if (!csrf.token) throw new Error('missing CSRF token');

    const form = new FormData();
    form.append('files', new Blob(['model,price\ntest-model,2\n'], { type: 'text/csv' }), 'prices.csv');
    const upload = await fetch(`${BASE}/api/agent/manage/attachments`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf.token, origin: BASE },
      body: form
    });
    const uploaded = await upload.json();
    if (!upload.ok || !uploaded.attachments?.length) {
      throw new Error(`upload failed: ${upload.status} ${JSON.stringify(uploaded)}`);
    }
    const attachmentId = uploaded.attachments[0].id;

    const run = await fetch(`${BASE}/api/agent/manage/runs`, {
      method: 'POST',
      headers: {
        cookie, 'x-csrf-token': csrf.token, origin: BASE, 'content-type': 'application/json'
      },
      body: JSON.stringify({
        text: '请根据附件调整 test-model 的倍率',
        model: 'test-model',
        attachment_ids: [attachmentId]
      })
    });
    const runText = await run.text();
    if (!run.ok) throw new Error(`run failed: ${run.status} ${runText}`);
    const events = parseSse(runText);
    const approvalEvent = events.find(event => event.type === 'approval.required');
    if (!approvalEvent) throw new Error(`no approval event: ${runText.slice(-2000)}`);
    const payload = approvalEvent.payload;
    if (payload.name !== 'batch_set_model_multipliers') {
      throw new Error(`unexpected approval tool: ${payload.name}`);
    }
    if (payload.preview?.rows?.[0]?.proposed_multiplier !== 2.4) {
      throw new Error(`unexpected preview: ${JSON.stringify(payload.preview)}`);
    }
    const threadId = events.find(event => event.type === 'run.started')?.payload?.thread_id;
    if (!threadId) throw new Error('missing thread id');

    const approval = await fetch(`${BASE}/api/agent/manage/approvals/${payload.approval_id}`, {
      method: 'POST',
      headers: {
        cookie, 'x-csrf-token': csrf.token, origin: BASE, 'content-type': 'application/json'
      },
      body: JSON.stringify({ decision: 'allow' })
    });
    const approvalText = await approval.text();
    if (!approval.ok) throw new Error(`approval failed: ${approval.status} ${approvalText}`);
    if (!parseSse(approvalText).some(event => event.type === 'run.completed')) {
      throw new Error(`approval did not complete: ${approvalText.slice(-2000)}`);
    }

    const model = await pool.query("SELECT model_multiplier FROM models WHERE id='test-model'");
    if (Number(model.rows[0].model_multiplier) !== 2.4) {
      throw new Error(`multiplier not applied: ${model.rows[0].model_multiplier}`);
    }
    const approvalRow = await pool.query('SELECT status FROM agent_approvals WHERE id=$1', [payload.approval_id]);
    if (approvalRow.rows[0].status !== 'approved') throw new Error('approval not approved');
    const messages = await pool.query(
      "SELECT content, attachments FROM agent_messages WHERE thread_id=$1 AND role='user' ORDER BY id LIMIT 1",
      [threadId]
    );
    if (!messages.rows[0]?.attachments?.length) {
      throw new Error('user message did not retain attachments');
    }
    if (!String(messages.rows[0].content).includes('[用户上传资料]')) throw new Error('user message missing attachment manifest');
    const bound = await pool.query('SELECT thread_id FROM agent_attachments WHERE id=$1', [attachmentId]);
    if (bound.rows[0].thread_id !== threadId) throw new Error('attachment not bound to thread');
    const audit = await pool.query("SELECT COUNT(*)::int AS count FROM operation_logs WHERE action='admin.model_batch'");
    if (audit.rows[0].count < 1) throw new Error('missing batch audit log');

    console.log('E2E_OK', JSON.stringify({
      threadId,
      attachmentId,
      multiplier: Number(model.rows[0].model_multiplier),
      approvalStatus: approvalRow.rows[0].status,
      auditCount: audit.rows[0].count
    }));
  } catch (error) {
    console.error('E2E_FAILED', error.message);
    console.error(output.slice(-4000));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await pool.end();
    cluster.stop();
    fs.rmSync(configPath, { force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
