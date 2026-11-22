'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const source = require('../utils/github-actions-token');

function mockHttps(status, body) {
  const calls = [];
  return {
    calls,
    request(url, options, callback) {
      calls.push({ url: String(url), options });
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.setEncoding = () => {};
        callback(res);
        queueMicrotask(() => { if (typeof body === 'string') res.emit('data', body); res.emit('end'); });
      };
      req.destroy = error => { queueMicrotask(() => req.emit('error', error)); };
      return req;
    },
  };
}

test('requests a single-quoted configured audience from GitHub runner and never leaks runner token', async () => {
  const https = mockHttps(200, JSON.stringify({ value: 'jwt-assertion' }));
  const value = await source.getGitHubActionsAssertion({
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.githubusercontent.com/token?x=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-secret',
    },
    audience: 'https://router.example/oauth/github-actions',
    https,
  });
  assert.equal(value, 'jwt-assertion');
  assert.equal(https.calls.length, 1);
  assert.equal(https.calls[0].url, 'https://actions.githubusercontent.com/token?x=1&audience=https%3A%2F%2Frouter.example%2Foauth%2Fgithub-actions');
  assert.equal(https.calls[0].options.headers.authorization, 'Bearer runner-secret');
});

test('rejects unavailable runner credentials, unsafe hosts, bad status and malformed payloads', async () => {
  await assert.rejects(source.getGitHubActionsAssertion({ env: {}, audience: 'https://router.example/aud' }), /not available/);
  await assert.rejects(source.getGitHubActionsAssertion({ env: {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'http://evil.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
  }, audience: 'https://router.example/aud', https: mockHttps(200, '{}') }), /rejected/);
  await assert.rejects(source.getGitHubActionsAssertion({ env: {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
  }, audience: 'https://router.example/aud', https: mockHttps(401, '{}') }), /failed/);
  await assert.rejects(source.getGitHubActionsAssertion({ env: {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
  }, audience: 'https://router.example/aud', https: mockHttps(200, '{') }), /invalid/);
});
