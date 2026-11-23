#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [pluginId, version, sha256Arg, permissionsArg, privateKeyPem] = process.argv.slice(2);
if (!pluginId || !version || !sha256Arg || !permissionsArg || !privateKeyPem) {
  console.error('用法: node scripts/sign-plugin-package.mjs <pluginId> <version> <sha256> <permissions-json> <private-key-pem-file>');
  process.exit(2);
}
const sha256 = sha256Arg.toLowerCase();
if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('SHA-256 必须为 64 位十六进制');
const parsed = JSON.parse(permissionsArg);
if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('permissions-json 必须是字符串数组');
const permissions = [...new Set(parsed)].sort();
const key = createPrivateKey(await readFile(privateKeyPem, 'utf8'));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('发布者私钥必须是 Ed25519');
const message = `crewrouter-plugin-v1\n${pluginId}\n${version}\n${sha256}\n${JSON.stringify(permissions)}`;
console.log(JSON.stringify({
  signatureAlgorithm: 'Ed25519',
  signatureKeyId: process.env.CR_PLUGIN_SIGNING_KEY_ID || '',
  signature: sign(null, Buffer.from(message), key).toString('base64'),
}, null, 2));
