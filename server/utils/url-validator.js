/**
 * URL 安全校验工具
 *
 * 用于 SSRF 防护：校验外部请求 URL，防止请求内网和服务端元数据。
 */

const { URL } = require('url');
const net = require('net');
const dns = require('dns').promises;

// 内网 IP 范围和特殊用途 IP
const PRIVATE_RANGES = [
  // IPv4 私有地址
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
  // 回环地址
  { start: '127.0.0.0', end: '127.255.255.255' },
  // 链路本地地址（含 Metadata 服务 169.254.169.254）
  { start: '169.254.0.0', end: '169.254.255.255' },
  // 本地通信（0.0.0.0/8）
  { start: '0.0.0.0', end: '0.255.255.255' },
  // 注意：不拦 198.18.0.0/15（RFC 2544 基准测试网段）。Fake-IP 代理（Clash/Mihomo 等）
  // 会把公网域名解析到该网段，实际连接经代理出公网，拦截会导致所有外部供应商不可用。
];


/**
 * 将 IP 字符串转换为数字（用于范围比较）
 */
function ipToNumber(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return null;
  if (parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * 检查 IPv4 地址是否在私有/内网范围
 */
function isPrivateIPv4(ip) {
  const num = ipToNumber(ip);
  if (num === null) return false;
  return PRIVATE_RANGES.some(range => {
    const start = ipToNumber(range.start);
    const end = ipToNumber(range.end);
    return num >= start && num <= end;
  });
}

/**
 * 将 IPv6 地址展开为 8 个 16 位分组。
 */
function parseIPv6(ip) {
  let value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(value)) return null;

  const ipv4Match = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = ipToNumber(ipv4Match[1]);
    if (ipv4 === null) return null;
    value = value.slice(0, -ipv4Match[1].length) + `${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(part => parseInt(part || '0', 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

/**
 * 检查 IPv6 地址是否在禁止范围
 */
function isBlockedIPv6(ip) {
  const groups = parseIPv6(ip);
  if (!groups) return true;
  if (groups.every(group => group === 0)) return true; // ::/128
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true; // ::1/128
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`;
    return isPrivateIPv4(mapped);
  }
  return false;
}

/**
 * 解析 hostname 并检查是否为禁止地址
 */
function isBlockedHost(hostname) {
  // 排除 DNS 解析失败
  if (!hostname) return true;
  const normalizedHost = String(hostname).replace(/^\[|\]$/g, '');

  // 检查是否为 IP 地址
  if (net.isIPv4(normalizedHost)) {
    return isPrivateIPv4(normalizedHost);
  }
  if (net.isIPv6(normalizedHost)) {
    return isBlockedIPv6(normalizedHost);
  }

  // 检查是否为本地主机名
  const localHosts = [
    'localhost', 'localhost.localdomain', 'local',
    '127.0.0.1', '::1',
    '0.0.0.0',
    'broadcasthost',
  ];
  if (localHosts.includes(normalizedHost.toLowerCase())) {
    return true;
  }

  return false;
}

/**
 * 校验外部请求 URL 的安全性
 *
 * @param {string} urlStr - 要校验的 URL
 * @param {object} options
 * @param {boolean} options.allowPrivate - 是否允许内网地址（默认 false）
 * @param {boolean} options.resolveDNS - 是否解析域名检查 IP（默认 false，依赖 dns 模块）
 * @returns {{ ok: boolean, error?: string, url?: URL }}
 */
async function validateUrl(urlStr, options = {}) {
  const { allowPrivate = false, resolveDNS = true } = options;

  if (!urlStr || typeof urlStr !== 'string') {
    return { ok: false, error: 'URL 不能为空' };
  }

  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return { ok: false, error: 'URL 格式无效' };
  }

  // 协议校验：只允许 HTTP/HTTPS
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `不允许的协议: ${url.protocol}（仅支持 http/https）` };
  }

  if (!allowPrivate) {
    // 检查 hostname
    if (isBlockedHost(url.hostname)) {
      return { ok: false, error: `不允许请求内网地址: ${url.hostname}` };
    }

    const normalizedHost = url.hostname.replace(/^\[|\]$/g, '');

    // 检查 IP 形式的 URL 中的地址
    if (net.isIPv4(normalizedHost) && isPrivateIPv4(normalizedHost)) {
      return { ok: false, error: `不允许请求内网 IP: ${url.hostname}` };
    }
    if (net.isIPv6(normalizedHost) && isBlockedIPv6(normalizedHost)) {
      return { ok: false, error: `不允许请求内网 IPv6: ${url.hostname}` };
    }

    // 解析域名并检查所有地址。请求仍按域名连接，无法完全消除 DNS rebinding。
    if (resolveDNS && !net.isIP(normalizedHost)) {
      let addresses;
      try {
        addresses = await dns.lookup(normalizedHost, { all: true, verbatim: true });
      } catch (err) {
        return { ok: false, error: `域名 DNS 解析失败: ${url.hostname}` };
      }
      if (!addresses.length || addresses.some(({ address }) => net.isIPv4(address)
        ? isPrivateIPv4(address)
        : isBlockedIPv6(address))) {
        return { ok: false, error: `域名解析到不允许的内网地址: ${url.hostname}` };
      }
    }
  }

  return { ok: true, url };
}

/**
 * 从供应商 base_url 构建安全的请求 URL
 *
 * @param {string} baseUrl - 供应商配置的 base_url
 * @param {string} path - API 路径
 * @param {object} options
 * @returns {{ ok: boolean, url?: string, error?: string }}
 */
async function buildSafeUrl(baseUrl, path = '', options = {}) {
  if (!baseUrl) {
    return { ok: false, error: 'base_url 为空' };
  }

  // 清理末尾斜杠
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const fullUrl = `${cleanBase}${cleanPath}`;

  return validateUrl(fullUrl, options);
}

/**
 * 去掉尾部已知端点路径，避免再拼端点时出现 /v1/v1。
 * 注意：保留 /v1、/api/v1 这类版本前缀（如 OpenRouter 的 https://openrouter.ai/api/v1），
 * 拼接端点时由 upstreamUrl() 判断是否需要补 /v1。
 */
function cleanBaseUrl(base) {
  return String(base || '')
    .replace(/\/+$/, '')
    .replace(/\/v1\/chat\/completions\/*$/i, '')
    .replace(/\/v1\/messages\/*$/i, '')
    .replace(/\/v1\/responses\/*$/i, '')
    .replace(/\/chat\/completions\/*$/i, '')
    .replace(/\/messages\/*$/i, '')
    .replace(/\/responses\/*$/i, '');
}

/**
 * 拼接上游 API 端点。endpoint 不含版本前缀（如 '/chat/completions'）；
 * base_url 已以版本段结尾时直接拼，否则补上 defaultVersion。
 */
function upstreamUrl(base, endpoint, defaultVersion = '/v1') {
  const clean = cleanBaseUrl(base);
  const hasVersionSuffix = /\/v\d+(?:[a-z]+\d*)?$/i.test(clean);
  const version = `/${String(defaultVersion || 'v1').replace(/^\/+|\/+$/g, '')}`;
  return hasVersionSuffix ? clean + endpoint : `${clean}${version}${endpoint}`;
}

module.exports = {
  validateUrl,
  buildSafeUrl,
  cleanBaseUrl,
  upstreamUrl,
  isBlockedHost,
  isPrivateIPv4,
  isBlockedIPv6,
  PRIVATE_RANGES,
};
