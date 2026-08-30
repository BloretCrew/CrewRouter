'use strict';

const assert = require('assert');
const {
  DEFAULT_MAX_BODY_BYTES,
  validateBeforeUpstreamRewrite,
} = require('../utils/before-upstream-policy');

const original = {
  url: 'https://api.vendor.example/v1/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer provider-secret',
  },
  bodyText: JSON.stringify({ model: 'allowed-model', messages: [{ role: 'user', content: 'hello' }] }),
};

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error && error.code === code);
}

(async () => {
  await rejectsCode(
    validateBeforeUpstreamRewrite(original, { ...original, url: 'http://169.254.169.254/latest/meta-data' }),
    'plugin_url_rejected'
  );

  const oversizedBody = JSON.stringify({
    model: 'allowed-model',
    messages: [{ role: 'user', content: 'x'.repeat(DEFAULT_MAX_BODY_BYTES) }],
  });
  await rejectsCode(
    validateBeforeUpstreamRewrite(original, { ...original, bodyText: oversizedBody }),
    'plugin_body_too_large'
  );

  await rejectsCode(
    validateBeforeUpstreamRewrite(original, {
      ...original,
      bodyText: JSON.stringify({ model: 'unauthorized-model', messages: [] }),
    }),
    'plugin_model_unauthorized'
  );
  await rejectsCode(
    validateBeforeUpstreamRewrite({ ...original, model: 'allowed-model', providerId: 'provider-a' }, {
      ...original,
      model: 'unauthorized-model',
    }),
    'plugin_model_unauthorized'
  );
  await rejectsCode(
    validateBeforeUpstreamRewrite({ ...original, model: 'allowed-model', providerId: 'provider-a' }, {
      ...original,
      providerId: 'provider-b',
    }),
    'plugin_provider_unauthorized'
  );

  await rejectsCode(
    validateBeforeUpstreamRewrite(original, { ...original, bodyText: '{not-json' }),
    'plugin_body_invalid_json'
  );
  await rejectsCode(
    validateBeforeUpstreamRewrite(original, { ...original, bodyText: JSON.stringify({ messages: [] }) }),
    'plugin_model_required'
  );

  let urlChecks = 0;
  const headersOnly = await validateBeforeUpstreamRewrite(original, {
    ...original,
    headers: { ...original.headers, 'X-Plugin-Trace': 'enabled' },
  }, {
    validateUrl: async () => {
      urlChecks += 1;
      return { ok: false, error: 'must not run' };
    },
  });
  assert.strictEqual(urlChecks, 0);
  assert.deepStrictEqual(headersOnly.changed, { url: false, headers: true, bodyText: false, model: false, provider: false });
  assert.strictEqual(headersOnly.override.bodyText, undefined);
  assert.strictEqual(headersOnly.override.url, undefined);
  assert.strictEqual(headersOnly.override.headers.authorization, 'Bearer provider-secret');
  assert.strictEqual(headersOnly.override.headers['x-plugin-trace'], 'enabled');

  await rejectsCode(
    validateBeforeUpstreamRewrite(original, { ...original, headers: { ...original.headers, Host: 'evil.example' } }),
    'plugin_header_forbidden'
  );
  const crossOriginCredentials = await validateBeforeUpstreamRewrite(original, {
    ...original,
    url: 'https://other.example/v1/chat/completions',
    headers: { ...original.headers, Cookie: 'session=secret' },
  }, {
    validateUrl: async url => ({ ok: true, url: new URL(url) }),
  });
  assert.strictEqual(crossOriginCredentials.override.headers.cookie, undefined);

  const crossOrigin = await validateBeforeUpstreamRewrite(original, {
    ...original,
    url: 'https://other.example/v1/chat/completions',
  }, {
    validateUrl: async url => ({ ok: true, url: new URL(url) }),
  });
  assert.strictEqual(crossOrigin.override.headers.authorization, undefined);
  assert.strictEqual(crossOrigin.override.headers['content-type'], 'application/json');

  console.log('beforeUpstream policy tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
