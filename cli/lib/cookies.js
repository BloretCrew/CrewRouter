'use strict';

// Minimal RFC 6265-ish cookie jar tailored to the CrewRouter session cookie.

function parseSetCookie(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const parts = header.split(';');
  const pair = parts.shift();
  const index = pair.indexOf('=');
  if (index <= 0) return null;
  const cookie = {
    name: pair.slice(0, index).trim(),
    value: pair.slice(index + 1).trim(),
    path: '/',
    domain: null,
    secure: false,
    httpOnly: false,
    expiresAt: null,
  };
  if (!cookie.name) return null;
  for (const attribute of parts) {
    const at = attribute.indexOf('=');
    const key = (at >= 0 ? attribute.slice(0, at) : attribute).trim().toLowerCase();
    const value = at >= 0 ? attribute.slice(at + 1).trim() : '';
    if (key === 'path' && value) cookie.path = value;
    else if (key === 'domain' && value) cookie.domain = value.replace(/^\./, '').toLowerCase();
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
    } else if (key === 'expires') {
      const time = Date.parse(value);
      if (Number.isFinite(time)) cookie.expiresAt = time;
    }
  }
  return cookie;
}

function domainMatches(cookie, hostname) {
  if (!cookie.domain) return true;
  return hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
}

function pathMatches(cookie, pathname) {
  const cookiePath = cookie.path || '/';
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/';
}

function pruneJar(jar, { hostname, pathname, secure } = {}) {
  const now = Date.now();
  const next = [];
  for (const cookie of Array.isArray(jar) ? jar : []) {
    if (!cookie || typeof cookie.name !== 'string') continue;
    if (cookie.expiresAt && cookie.expiresAt <= now) continue;
    if (hostname && !domainMatches(cookie, hostname)) continue;
    if (pathname && !pathMatches(cookie, pathname)) continue;
    if (secure === false && cookie.secure) continue;
    next.push(cookie);
  }
  return next;
}

function updateJar(jar, setCookieHeaders, requestUrl) {
  let url;
  try { url = new URL(requestUrl); } catch (_) { return Array.isArray(jar) ? jar.slice() : []; }
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname || '/';
  const existing = Array.isArray(jar) ? jar.slice() : [];
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
  for (const header of headers) {
    const parsed = parseSetCookie(header);
    if (!parsed) continue;
    const cookie = {
      ...parsed,
      domain: parsed.domain || null,
      path: parsed.path || pathname,
    };
    const index = existing.findIndex(item => item.name === cookie.name && (item.domain || '') === (cookie.domain || '') && (item.path || '/') === cookie.path);
    if (cookie.expiresAt && cookie.expiresAt <= Date.now()) {
      if (index >= 0) existing.splice(index, 1);
      continue;
    }
    if (index >= 0) existing[index] = cookie; else existing.push(cookie);
  }
  return pruneJar(existing, { hostname, pathname, secure: url.protocol === 'https:' });
}

function cookieHeader(jar, requestUrl) {
  let url;
  try { url = new URL(requestUrl); } catch (_) { return ''; }
  const cookies = pruneJar(jar, {
    hostname: url.hostname.toLowerCase(),
    pathname: url.pathname || '/',
    secure: url.protocol === 'https:',
  }).sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function maskCookieJar(jar) {
  return (Array.isArray(jar) ? jar : []).map(cookie => ({
    name: cookie.name,
    value: cookie.value ? '••••' : '',
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure === true,
  }));
}

module.exports = { parseSetCookie, updateJar, cookieHeader, maskCookieJar };
