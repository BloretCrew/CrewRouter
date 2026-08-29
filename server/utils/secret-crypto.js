const crypto = require('crypto');
const config = require('../config-loader');

const PREFIX = 'aesgcm:';
const LEGACY_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function configuredMasterKey() {
  return process.env.CRW_MASTER_KEY
    || process.env.CR_MASTER_KEY
    || config.gateway?.masterKey
    || config.masterKey;
}

function getEncryptionKey() {
  const configured = configuredMasterKey();
  if (configured) return crypto.createHash('sha256').update(String(configured)).digest();
  const isProduction = process.env.NODE_ENV === 'production' || process.env.CR_ENV === 'production';
  if (isProduction) throw new Error('生产环境必须配置 gateway.masterKey 或 CRW_MASTER_KEY');
  const devKey = 'crewrouter-development-master-key';
  console.warn('[secret-crypto] 未配置 gateway.masterKey/CRW_MASTER_KEY，使用临时开发密钥；生产环境将拒绝启动');
  return crypto.createHash('sha256').update(devKey).digest();
}

function getLegacyEncryptionKey() {
  const configured = process.env.CR_PROVIDER_KEY_ENCRYPTION_KEY
    || config.providerKeyEncryptionKey
    || config.app?.providerKeyEncryptionKey
    || config.app?.sessionSecret;
  if (!configured) throw new Error('未配置旧版供应商密钥加密密钥');
  return crypto.createHash('sha256').update(String(configured)).digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && (value.startsWith(PREFIX) || value.startsWith(LEGACY_PREFIX));
}

function encryptSecret(value) {
  if (value == null || value === '') return value;
  const text = String(value);
  if (isEncrypted(text)) return text;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(value) {
  if (value == null || value === '') return value;
  const text = String(value);
  if (!isEncrypted(text)) return text;
  const legacy = text.startsWith(LEGACY_PREFIX);
  const parts = text.slice(legacy ? LEGACY_PREFIX.length : PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('供应商密钥密文格式无效');
  const encoding = legacy ? 'base64' : 'hex';
  const decipher = crypto.createDecipheriv(ALGORITHM, legacy ? getLegacyEncryptionKey() : getEncryptionKey(), Buffer.from(parts[0], encoding));
  decipher.setAuthTag(Buffer.from(parts[1], encoding));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], encoding)), decipher.final()]).toString('utf8');
}

module.exports = { PREFIX, LEGACY_PREFIX, isEncrypted, encryptSecret, decryptSecret };
