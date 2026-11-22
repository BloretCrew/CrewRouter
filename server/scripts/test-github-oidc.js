'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const oidc = require('../utils/github-oidc');

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function fixture({ changes = {}, keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  const header = { alg: 'RS256', typ: 'JWT', kid: 'fixture-kid' };
  const claims = {
    iss: oidc.ISSUER,
    aud: 'https://router.example/oauth/github-actions',
    sub: 'repo:acme/service:ref:refs/heads/main',
    repository: 'acme/service',
    ref: 'refs/heads/main',
    workflow_ref: 'acme/service/.github/workflows/ci.yml@refs/heads/main',
    event_name: 'push',
    iat: now,
    exp: now + 300,
    jti: 'run-id-1',
    ...changes,
  };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), keyPair.privateKey).toString('base64url');
  const token = `${signingInput}.${signature}`;
  return { token, claims, jwks: { keys: [{ ...jwk, kid: 'fixture-kid', use: 'sig', alg: 'RS256' }] } };
}

const policy = {
  audience: 'https://router.example/oauth/github-actions',
  eventName: 'push',
  allowedRepositories: ['acme/service'],
  allowedRefs: ['refs/heads/main'],
  allowedWorkflows: ['acme/service/.github/workflows/ci.yml@refs/heads/main'],
  allowedSubjects: ['repo:acme/service:ref:refs/heads/main'],
};

test('valid GitHub Actions JWT matches issuer, audience, signature, time and exact trust lists', () => {
  const f = fixture();
  assert.equal(oidc.verifyJwt(f.token, f.jwks, policy).claims.repository, f.claims.repository);
});

test('rejects malformed token, bad signature and wrong claims', () => {
  const f = fixture();
  assert.equal(oidc.verifyJwt('not.jwt', f.jwks, policy).error, 'invalid_token');
  assert.equal(oidc.verifyJwt(`${f.token.slice(0, -1)}x`, f.jwks, policy).error, 'invalid_signature');
  for (const [changes, expected] of [[{ aud: 'wrong' }, 'invalid_claims'], [{ repository: 'fork/evil' }, 'trust_policy_denied'], [{ event_name: 'pull_request' }, 'untrusted_event']]) {
    const altered = fixture({ changes });
    assert.equal(oidc.verifyJwt(altered.token, altered.jwks, policy).error, expected);
  }
});

test('rejects expired, future-issued and excessive lifetime JWTs', () => {
  const f = fixture();
  for (const changes of [{ exp: Math.floor(Date.now() / 1000) - 600 }, { iat: Math.floor(Date.now() / 1000) + 3600 }, { exp: Math.floor(Date.now() / 1000) + 3600 }]) {
    const altered = fixture({ changes });
    assert.equal(oidc.verifyJwt(altered.token, altered.jwks, policy).error, 'invalid_time');
  }
});

test('OIDC trust is disabled or incomplete unless explicit user and repository/ref/workflow lists exist', () => {
  assert.equal(oidc.getTrustPolicy({ githubActionsOidc: { enabled: false, userId: 1, repositories: ['acme/service'], refs: ['refs/heads/main'], workflows: ['acme/service/.github/workflows/ci.yml@refs/heads/main'] } }), null);
  assert.equal(oidc.getTrustPolicy({ githubActionsOidc: { enabled: true, userId: 1, audience: 'https://router.example/oauth/github-actions', repositories: ['*'], refs: ['refs/heads/main'], workflows: ['workflow'], subjects: ['repo:acme/service:ref:refs/heads/main'] } }), null);
  assert.equal(oidc.getTrustPolicy({ app: { publicOrigin: 'https://router.example' }, githubActionsOidc: { enabled: true, userId: 1, audience: 'https://router.example/oauth/github-actions', repositories: ['acme/service'], refs: ['refs/heads/main'], workflows: ['workflow'], subjects: ['*'] } }), null);
  assert.equal(oidc.getTrustPolicy({ app: { publicOrigin: 'https://router.example' }, githubActionsOidc: { enabled: true, userId: 1, eventName: 'push', audience: 'https://router.example/oauth/github-actions', repositories: ['acme/service'], refs: ['refs/heads/main'], workflows: ['acme/service/.github/workflows/ci.yml@refs/heads/main'], subjects: ['repo:acme/service:ref:refs/heads/main'] } }).audience, 'https://router.example/oauth/github-actions');
  assert.equal(oidc.getTrustPolicy({ app: { publicOrigin: 'http://router.example' }, githubActionsOidc: { enabled: true, userId: 1, audience: 'http://router.example/oauth/github-actions', repositories: ['acme/service'], refs: ['refs/heads/main'], workflows: ['acme/service/.github/workflows/ci.yml@refs/heads/main'], subjects: ['repo:acme/service:ref:refs/heads/main'] } }), null);
});
