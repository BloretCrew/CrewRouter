'use strict';

const crypto = require('node:crypto');

// A previously distributed application secret is public. Keep only its
// fingerprint so copied older configuration files cannot silently reuse it.
const RETIRED_SECRET_SHA256 = 'c65f0fce271122257dc98848df6b6dcc316dcc114a03287876aa0f53ffd8f94e';
const APP_ID_MAX_LENGTH = 255;
const APP_SECRET_MAX_LENGTH = 4096;
const TEMPLATE_VALUE = /^(?:your(?:[-_ ]|$)|replace(?:[-_ ]|$)|change[-_ ]?me(?:[-_ ]|$)|(?:app[-_ ]?)?(?:id|secret)[-_ ]?here$|<.*>$|\$\{.*\}$|\{\{.*\}\}$)/i;

function isCredentialString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !/[\s\x00-\x1f\x7f]/u.test(value) && !TEMPLATE_VALUE.test(value);
}

function isRetiredPassportSecret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= APP_SECRET_MAX_LENGTH
    && crypto.createHash('sha256').update(value, 'utf8').digest('hex') === RETIRED_SECRET_SHA256;
}

// Takes the passport object itself, not the application's top-level config.
function hasPassportCredentials(cfg) {
  return Boolean(cfg && typeof cfg === 'object' && !Array.isArray(cfg)
    && isCredentialString(cfg.appId, APP_ID_MAX_LENGTH)
    && isCredentialString(cfg.appSecret, APP_SECRET_MAX_LENGTH)
    && !isRetiredPassportSecret(cfg.appSecret));
}

module.exports = { hasPassportCredentials, isRetiredPassportSecret };
