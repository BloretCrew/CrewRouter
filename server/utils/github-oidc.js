'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_JWKS_AGE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;
const MAX_TOKEN_TTL_SEC = 10 * 60;

let jwksCache;

function decodeSegment(segment) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const bytes = Buffer.from(segment, 'base64url');
    if (!bytes.length || bytes.toString('base64url') !== segment) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function verifyJwt(token, jwks, options = {}) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { error: 'invalid_token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'invalid_token' };
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return { error: 'invalid_token' };
  const key = jwks?.keys?.find(item => item.kid === header.kid && item.kty === 'RSA' && (!item.use || item.use === 'sig') && (!item.alg || item.alg === 'RS256'));
  if (!key) return { error: 'unknown_key' };
  const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return { error: 'invalid_token' };
  const signature = Buffer.from(parts[2], 'base64url');
  if (!signature.length || signature.toString('base64url') !== parts[2] || !crypto.verify('RSA-SHA256', signingInput, publicKey, signature)) return { error: 'invalid_signature' };

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iss !== ISSUER || claims.aud !== options.audience) return { error: 'invalid_claims' };
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp <= now - CLOCK_SKEW_SEC || claims.iat > now + CLOCK_SKEW_SEC || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_TTL_SEC) return { error: 'invalid_time' };
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SEC)) return { error: 'invalid_time' };
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.jti !== 'string' || !claims.jti) return { error: 'invalid_subject' };
  const repository = claims.repository;
  const ref = claims.ref;
  const workflow = claims.workflow_ref;
  const allowedRepositories = options.allowedRepositories || [];
  const allowedRefs = options.allowedRefs || [];
  const allowedWorkflows = options.allowedWorkflows || [];
  const allowedSubjects = options.allowedSubjects || [];
  if (!allowedRepositories.includes(repository) || !allowedRefs.includes(ref) || !allowedWorkflows.includes(workflow) || !allowedSubjects.includes(claims.sub)) return { error: 'trust_policy_denied' };
  if (claims.event_name !== options.eventName || claims.event_name === 'pull_request' || claims.event_name === 'pull_request_target') return { error: 'untrusted_event' };
  return { claims };
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'token.actions.githubusercontent.com') return reject(new Error('OIDC JWKS origin rejected'));
    const req = https.request(target, { method: 'GET', headers: { accept: 'application/json' }, timeout: options.timeout || 3000 }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 65_536) req.destroy(new Error('OIDC JWKS response too large'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('OIDC JWKS unavailable'));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('OIDC JWKS response invalid')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('OIDC JWKS timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function getJwks(now = Date.now()) {
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.value;
  const value = await requestJson(JWKS_URL);
  if (!value || !Array.isArray(value.keys) || value.keys.length === 0) throw new Error('OIDC JWKS has no keys');
  jwksCache = { value, expiresAt: now + MAX_JWKS_AGE_MS };
  return value;
}

async function verifyGitHubActionsToken(token, options = {}) {
  let jwks = await getJwks(options.now ?? Date.now());
  let result;
  try { result = verifyJwt(token, jwks, options); } catch { return { error: 'invalid_token' }; }
  if (result.error === 'unknown_key') {
    jwksCache = null;
    jwks = await getJwks(options.now ?? Date.now());
    try { result = verifyJwt(token, jwks, options); } catch { return { error: 'invalid_token' }; }
  }
  return result;
}

function getTrustPolicy(config) {
  const auth = config?.githubActionsOidc;
  if (!auth || auth.enabled !== true) return null;
  const allowedRepositories = cleanList(auth.repositories);
  const allowedRefs = cleanList(auth.refs);
  const allowedWorkflows = cleanList(auth.workflows);
  const allowedSubjects = cleanList(auth.subjects);
  const eventName = typeof auth.eventName === 'string' ? auth.eventName : '';
  if (!Number.isSafeInteger(Number(auth.userId)) || Number(auth.userId) < 1) return null;
  if (!['push', 'workflow_dispatch', 'schedule'].includes(eventName)) return null;
  if (!allowedRepositories.length || !allowedRefs.length || !allowedWorkflows.length || !allowedSubjects.length) return null;
  if (allowedRepositories.some(value => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))) return null;
  if (allowedSubjects.some(value => value.includes('*'))) return null;
  const configuredAudience = typeof auth.audience === 'string' && auth.audience.trim() ? auth.audience.trim() : '';
  if (!configuredAudience) return null;
  let publicOrigin;
  try { publicOrigin = new URL(config.app?.publicOrigin || ''); } catch { return null; }
  if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) return null;
  if (configuredAudience !== `${publicOrigin.origin}/oauth/github-actions`) return null;
  return { ...auth, userId: Number(auth.userId), eventName, allowedRepositories, allowedRefs, allowedWorkflows, allowedSubjects, audience: configuredAudience };
}

function cleanList(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.length > 0 && item.length <= 256))] : [];
}

function resetCacheForTests() {
  jwksCache = null;
}

module.exports = {
  ISSUER,
  MAX_TOKEN_TTL_SEC,
  getTrustPolicy,
  verifyJwt,
  verifyGitHubActionsToken,
  resetCacheForTests,
};
