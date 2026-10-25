'use strict';

// These checks reject shipped placeholders and clearly unsuitable key sizes.
// Length is not an entropy estimate: deployments must generate a random secret.
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4096;
const KNOWN_PLACEHOLDERS = new Set([
  'change-me-in-production',
  'your-session-secret-here',
  'your-store-session-signing-secret',
]);

function isStoreSessionSecretValid(secret) {
  if (typeof secret !== 'string' || secret.length > MAX_SECRET_BYTES
      || secret.trim() !== secret || /[\x00-\x1f\x7f]/.test(secret)
      || KNOWN_PLACEHOLDERS.has(secret.toLowerCase())) return false;
  const bytes = Buffer.byteLength(secret, 'utf8');
  return bytes >= MIN_SECRET_BYTES && bytes <= MAX_SECRET_BYTES
    && Buffer.from(secret, 'utf8').toString('utf8') === secret;
}

module.exports = { isStoreSessionSecretValid };
