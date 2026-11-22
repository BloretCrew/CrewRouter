'use strict';

const https = require('node:https');

function getGitHubActionsAssertion(options = {}) {
  const env = options.env || process.env;
  const endpoint = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (typeof endpoint !== 'string' || !endpoint || typeof requestToken !== 'string' || !requestToken) {
    return Promise.reject(new Error('GitHub Actions OIDC request credentials are not available in this process'));
  }
  if (typeof options.audience !== 'string' || !options.audience.trim()) return Promise.reject(new Error('GitHub Actions OIDC audience is not configured'));

  let target;
  try { target = new URL(endpoint); } catch { return Promise.reject(new Error('GitHub Actions OIDC endpoint is invalid')); }
  if (target.protocol !== 'https:' || !['actions.githubusercontent.com', 'token.actions.githubusercontent.com', 'pipelines.actions.githubusercontent.com'].includes(target.hostname) || target.username || target.password || target.port && target.port !== '443') {
    return Promise.reject(new Error('GitHub Actions OIDC endpoint origin rejected'));
  }
  target.searchParams.set('audience', options.audience);
  const transport = options.https || https;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method: 'GET',
      headers: { authorization: `Bearer ${requestToken}`, accept: 'application/json' },
      timeout: options.timeout || 3000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 32_768) req.destroy(new Error('GitHub Actions OIDC response too large'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('GitHub Actions OIDC token request failed'));
        let parsed;
        try { parsed = JSON.parse(body); } catch { return reject(new Error('GitHub Actions OIDC response invalid')); }
        if (typeof parsed.value !== 'string' || !parsed.value || parsed.value.length > 16_384) return reject(new Error('GitHub Actions OIDC response invalid'));
        return resolve(parsed.value);
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub Actions OIDC request timeout')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { getGitHubActionsAssertion };
