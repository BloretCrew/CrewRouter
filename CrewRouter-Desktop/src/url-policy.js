'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');

const IPV4_PRIVATE = [
  ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'], ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'], ['224.0.0.0', '255.255.255.255']
];
const ip4Number = (ip) => ip.split('.').reduce((n, p) => (n * 256) + Number(p), 0);
const isPrivateIPv4 = (ip) => net.isIPv4(ip) && IPV4_PRIVATE.some(([a, b]) => ip4Number(ip) >= ip4Number(a) && ip4Number(ip) <= ip4Number(b));
const isPrivateIPv6 = (ip) => {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(normalized)) return false;
  return normalized === '::' || normalized === '::1' || /^(fc|fd)/.test(normalized) || /^(fe[89ab])/i.test(normalized) || normalized.startsWith('ff');
};
const isLocalHost = (host) => ['localhost', 'localhost.localdomain', 'local', 'broadcasthost'].includes(host.toLowerCase());
const isPrivateHost = (host) => isPrivateIPv4(host) || isPrivateIPv6(host) || isLocalHost(host);

function redactUrl(input) {
  let url;
  try { url = new URL(String(input)); } catch { return '[invalid-url]'; }
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|key|code|auth|ticket|session|state/i.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  if (url.username || url.password) { url.username = '[REDACTED]'; url.password = ''; }
  return url.toString();
}

async function validateRemoteUrl(input, options = {}) {
  const { allowLocalhost = false, resolveDns = true, requirePort = false } = options;
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'URL 不能为空' };
  let url;
  try { url = new URL(input); } catch { return { ok: false, error: 'URL 格式无效' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: '仅允许 http/https' };
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => /token|secret|key|code|auth|ticket|session|state/i.test(key))) return { ok: false, error: 'URL 不得包含凭据或敏感参数' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = isPrivateHost(host);
  const explicitLocal = allowLocalhost && (isLocalHost(host) || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0');
  if (local && !explicitLocal) return { ok: false, error: '远程 URL 禁止 localhost 或内网地址' };
  if (requirePort && !url.port) return { ok: false, error: '必须指定端口' };
  if (!allowLocalhost && resolveDns && !net.isIP(host)) {
    let records;
    try { records = await dns.lookup(host, { all: true, verbatim: true }); } catch { return { ok: false, error: '域名 DNS 解析失败' }; }
    if (!records.length || records.some(({ address }) => isPrivateHost(address))) return { ok: false, error: '域名解析到内网地址' };
  }
  return { ok: true, url, redacted: redactUrl(url.toString()) };
}

module.exports = { validateRemoteUrl, redactUrl, isPrivateHost, isPrivateIPv4, isPrivateIPv6 };
