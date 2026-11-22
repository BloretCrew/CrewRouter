'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/github-actions-oidc.js'), 'utf8').replace("setInterval(() => {\n  const cutoff = Date.now() - 60_000;\n  for (const [key, timestamps] of exchangeAttempts) {\n    const current = timestamps.filter(timestamp => timestamp > cutoff);\n    if (current.length) exchangeAttempts.set(key, current);\n    else exchangeAttempts.delete(key);\n  }\n}, 60_000).unref?.();", '');
const config = { app: { publicOrigin: 'https://router.example.com' }, githubActionsOidc: {
  enabled: true, userId: 7, eventName: 'push', audience: 'https://router.example.com/oauth/github-actions',
  repositories: ['acme/service'], refs: ['refs/heads/main'], workflows: ['acme/service/.github/workflows/ci.yml@refs/heads/main'], subjects: ['repo:acme/service:ref:refs/heads/main'],
} };

function response() {
  return { headers: {}, set(name, value) { this.headers[name.toLowerCase()] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function make({ assertion = 'assertion', verified = { claims: { repository: 'acme/service', ref: 'refs/heads/main', workflow_ref: config.githubActionsOidc.workflows[0], jti: 'run-id-1' } }, keyRows = [{ id: 42 }], insertError } = {}) {
  const state = { queries: [], response: null };
  const pool = { async query(sql, params) {
    state.queries.push({ sql, params });
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS github_actions_oidc_assertions')) return { rows: [] };
    if (sql.startsWith('DELETE FROM github_actions_oidc_assertions')) return { rows: [] };
    if (sql.includes('FROM api_keys ak')) {
      assert(sql.includes('schedule_enabled IS DISTINCT FROM TRUE'));
      assert(sql.includes('suspended_at IS NULL'));
      return { rows: keyRows };
    }
    if (sql.includes('INSERT INTO github_actions_oidc_assertions')) return { rowCount: 1, rows: [] };
    if (sql.includes('INSERT INTO oauth_tokens')) { if (insertError) throw insertError; return { rows: [] }; }
    throw new Error('unexpected SQL: ' + sql);
  } };
  const githubOidc = { getTrustPolicy: value => value.githubActionsOidc.enabled ? (value.githubActionsOidc.audience === `${value.app.publicOrigin}/oauth/github-actions` ? { ...value.githubActionsOidc, allowedRepositories: value.githubActionsOidc.repositories, allowedRefs: value.githubActionsOidc.refs, allowedWorkflows: value.githubActionsOidc.workflows, allowedSubjects: value.githubActionsOidc.subjects, eventName: value.githubActionsOidc.eventName } : null) : null,
    verifyGitHubActionsToken: async token => { state.assertion = token; return verified; } };
  const module = { exports: {} };
  vm.runInNewContext(routeSource, {
    require(name) {
      if (name === 'express') return { Router: () => ({ post(_path, handler) { state.handler = handler; } }) };
      if (name === 'node:crypto') return require('node:crypto');
      if (name === '../models/database') return { pool };
      if (name === '../config-loader') return config;
      if (name === '../logger') return { warn() {}, error() {} };
      if (name === '../utils/github-oidc') return githubOidc;
      if (name === './oauth') return { ensureOAuthTables: async () => {} };
      throw new Error('unexpected require: ' + name);
    },
    module, exports: module.exports,
  });
  const req = { body: { assertion } };
  const res = response();
  return { state, req, res, run: () => state.handler(req, res) };
}

test('OIDC assertion exchanges for a short-lived CrewRouter gateway token bound to configured user/key', async () => {
  const f = make();
  await f.run();
  assert.equal(f.res.statusCode, undefined);
  assert.equal(f.res.body.token_type, 'Bearer');
  assert.equal(f.res.body.scope, 'gateway:invoke');
  assert.equal(f.res.body.expires_in, 600);
  assert.match(f.res.body.access_token, /^crh_[A-Za-z0-9_-]+$/);
  assert.equal(f.res.headers['cache-control'], 'no-store');
  const insert = f.state.queries.find(item => item.sql.includes('INSERT INTO oauth_tokens'));
  assert.equal(JSON.stringify(insert.params.slice(1)), JSON.stringify([7, 42, 'github-actions-oidc', 'gateway:invoke', '600']));
  assert.notEqual(insert.params[0], f.res.body.access_token);
  assert.equal(JSON.stringify(f.res.body).includes('assertion'), false);
});

test('OIDC endpoint is dark when federation is disabled or audience mismatches public origin', async () => {
  const f = make();
  config.githubActionsOidc.enabled = false;
  await f.run();
  assert.equal(f.res.statusCode, 404);
  config.githubActionsOidc.enabled = true;
  const mismatch = make();
  config.githubActionsOidc.audience = 'https://other.example/aud';
  await mismatch.run();
  assert.equal(mismatch.res.statusCode, 404);
  config.githubActionsOidc.audience = 'https://router.example.com/oauth/github-actions';
});

test('untrusted assertion is rejected and no access token row is written', async () => {
  const f = make({ verified: { error: 'trust_policy_denied' } });
  await f.run();
  assert.equal(f.res.statusCode, 401);
  assert.equal(f.state.queries.some(item => item.sql.includes('INSERT INTO oauth_tokens')), false);
});

test('no eligible gateway key denies token exchange', async () => {
  const f = make({ keyRows: [] });
  await f.run();
  assert.equal(f.res.statusCode, 403);
  assert.equal(f.state.queries.some(item => item.sql.includes('INSERT INTO oauth_tokens')), false);
});
