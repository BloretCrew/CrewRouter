'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');

const IPV4_PRIVATE = [
  ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'], ['192.0.2.0', '192.0.2.255'],
  ['192.88.99.0', '192.88.99.255'], ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'], ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'], ['224.0.0.0', '239.255.255.255'],
  ['240.0.0.0', '255.255.255.255']
];
const ip4Number = (ip) => ip.split('.').reduce((n, p) => (n * 256) + Number(p), 0);
const isPrivateIPv4 = (ip) => net.isIPv4(ip) && IPV4_PRIVATE.some(([a, b]) => ip4Number(ip) >= ip4Number(a) && ip4Number(ip) <= ip4Number(b));
const ip6Groups = (ip) => {
  const normalized = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(normalized) || normalized.includes('.')) return null;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(part => parseInt(part, 16));
  return groups.length === 8 && groups.every(part => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? groups : null;
};
const isPrivateIPv6 = (ip) => {
  const normalized = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(normalized)) return false;
  if (normalized.includes('.')) {
    const v4 = normalized.slice(normalized.lastIndexOf(':') + 1);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  const groups = ip6Groups(normalized);
  if (!groups) return true;
  if (groups.every(part => part === 0) || (groups.slice(0, 7).every(part => part === 0) && groups[7] === 1)) return true;
  if ((groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xffc0) === 0xfec0 || (groups[0] & 0xff00) === 0xff00) return true;
  if (groups.slice(0, 6).every(part => part === 0)) return true; // deprecated IPv4-compatible
  if (groups.slice(0, 5).every(part => part === 0) && groups[5] === 0xffff) {
    return isPrivateIPv4(`${groups[6] >>> 8}.${groups[6] & 255}.${groups[7] >>> 8}.${groups[7] & 255}`);
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(part => part === 0)) {
    return isPrivateIPv4(`${groups[6] >>> 8}.${groups[6] & 255}.${groups[7] >>> 8}.${groups[7] & 255}`);
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 1) return true;
  if (groups[0] === 0x2002) return isPrivateIPv4(`${groups[1] >>> 8}.${groups[1] & 255}.${groups[2] >>> 8}.${groups[2] & 255}`);
  return groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0x0db8);
};
const isLocalHost = (host) => ['localhost', 'localhost.localdomain', 'local', 'broadcasthost'].includes(host.toLowerCase());
const isLoopbackHost = (host) => isLocalHost(host) || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
const isPrivateHost = (host) => isPrivateIPv4(host) || isPrivateIPv6(host) || isLocalHost(host);
const isBlockedHost = (host) => isPrivateHost(host) || host.startsWith('192.0.2.') || host.startsWith('198.51.100.') || host.startsWith('203.0.113.') || (net.isIPv4(host) && !/^([1-9]|[1-9][0-9]|1[0-9]{2}|2[0-1][0-9]|22[0-3])\./.test(host));

function redactUrl(input) {
  let url;
  try { url = new URL(String(input)); } catch { return '[invalid-url]'; }
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|key|code|auth|ticket|session|state/i.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  if (url.username || url.password) { url.username = '[REDACTED]'; url.password = ''; }
  if (url.hash) url.hash = '#[REDACTED]';
  return url.toString();
}

async function validateRemoteUrl(input, options = {}) {
  const { allowLocalhost = false, resolveDns = true, requirePort = false, lookup = dns.lookup } = options;
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'URL 不能为空' };
  let url;
  try { url = new URL(input); } catch { return { ok: false, error: 'URL 格式无效' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: '仅允许 http/https' };
  if (url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => /token|secret|key|code|auth|ticket|session|state/i.test(key))) return { ok: false, error: 'URL 不得包含凭据、fragment 或敏感参数' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (requirePort && !url.port) return { ok: false, error: '必须指定端口' };

  // Permit local destinations only when the caller explicitly uses the Local flow.
  const explicitlyLocalTarget = allowLocalhost && isLoopbackHost(host);
  if (isBlockedHost(host) && !explicitlyLocalTarget) return { ok: false, error: '不允许连接本地或保留地址' };
  if (resolveDns && !net.isIP(host) && !isLocalHost(host)) {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch { return { ok: false, error: '域名 DNS 解析失败' }; }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => {
      const resolved = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
      return isBlockedHost(resolved) && !(explicitlyLocalTarget && isLoopbackHost(resolved));
    })) {
      return { ok: false, error: '域名解析到本地或内网地址' };
    }
  }
  return { ok: true, url, redacted: redactUrl(url.toString()) };
}

module.exports = { validateRemoteUrl, redactUrl, isPrivateHost, isPrivateIPv4, isPrivateIPv6 };
