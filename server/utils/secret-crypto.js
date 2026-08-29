const crypto = require('crypto');
const config = require('../config-loader');

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getEncryptionKey() {
  const configured = process.env.CR_PROVIDER_KEY_ENCRYPTION_KEY
    || config.providerKeyEncryptionKey
    || config.app?.providerKeyEncryptionKey
    || config.app?.sessionSecret;
  if (!configured) throw new Error('未配置供应商密钥加密密钥');
  return crypto.createHash('sha256').update(String(configured)).digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptSecret(value) {
  if (value == null || value === '') return value;
  const text = String(value);
  if (isEncrypted(text)) return text;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  if (value == null || value === '') return value;
  const text = String(value);
  if (!isEncrypted(text)) return text;
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('供应商密钥密文格式无效');
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(parts[0], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { PREFIX, isEncrypted, encryptSecret, decryptSecret };
