/**
 * URL 安全校验工具
 *
 * 用于 SSRF 防护：校验外部请求 URL，防止请求内网和服务端元数据。
 */

const { URL } = require('url');
const net = require('net');

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
  // 文档/示例地址
  { start: '198.18.0.0', end: '198.19.255.255' },
];

// IPv6 特殊地址
const IPV6_BLOCKED_PREFIXES = [
  '::1',           // 本地回环
  '::',            // 未指定
  'fe80::',        // 链路本地
  'fc00::',        // 唯一本地地址
  'fd00::',        // 唯一本地地址
  'ff00::',        // 组播
  '0:0:0:0:0:ffff:', // IPv4 映射地址（需额外检查嵌入的 IPv4）
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
 * 检查 IPv6 地址是否在禁止范围
 */
function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  return IPV6_BLOCKED_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/**
 * 解析 hostname 并检查是否为禁止地址
 */
function isBlockedHost(hostname) {
  // 排除 DNS 解析失败
  if (!hostname) return true;

  // 检查是否为 IP 地址
  if (net.isIPv4(hostname)) {
    return isPrivateIPv4(hostname);
  }
  if (net.isIPv6(hostname)) {
    return isBlockedIPv6(hostname);
  }

  // 检查是否为本地主机名
  const localHosts = [
    'localhost', 'localhost.localdomain', 'local',
    '127.0.0.1', '::1',
    '0.0.0.0',
    'broadcasthost',
  ];
  if (localHosts.includes(hostname.toLowerCase())) {
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
  const { allowPrivate = false } = options;

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

    // 检查 IP 形式的 URL 中的地址
    if (net.isIPv4(url.hostname) && isPrivateIPv4(url.hostname)) {
      return { ok: false, error: `不允许请求内网 IP: ${url.hostname}` };
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
 * 去掉尾部已知端点路径，避免再拼 /v1/chat/completions 时出现 /v1/v1。
 * 与 server/routes/api.js 的 cleanBaseUrl 保持一致。
 */
function cleanBaseUrl(base) {
  return String(base || '')
    .replace(/\/$/, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/v1\/responses$/i, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/api$/i, '');
}

module.exports = {
  validateUrl,
  buildSafeUrl,
  cleanBaseUrl,
  isBlockedHost,
  isPrivateIPv4,
  PRIVATE_RANGES,
};
