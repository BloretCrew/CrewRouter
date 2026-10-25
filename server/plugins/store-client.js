/**
 * 插件商店客户端（实例侧）
 *
 * 负责：校验插件商店源（防 SSRF / 恶意安装）、从商店拉取插件包信息、
 * 下载插件 zip 并校验 sha256。仅信任 config.store.pluginSource 允许清单内的 https 源。
 */

const crypto = require('crypto');
const fs = require('fs');
const Logger = require('../logger');
const { validateUrl } = require('../utils/url-validator');
const proxyPool = require('../proxy-pool');

const DEFAULT_STORE = 'https://crewrouter.bloret.net';
const MAX_PACKAGE_INFO_BYTES = 1024 * 1024;
const MAX_PLUGIN_PACKAGE_BYTES = 30 * 1024 * 1024;

function getConfig() {
  try { return require('../config-loader'); } catch { return {}; }
}

function normalizeSources(input) {
  const list = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) list.push(v.trim().replace(/\/+$/, '')); };
  if (Array.isArray(input)) input.forEach(push);
  else push(input);
  return list;
}

function allowedSources() {
  const cfg = getConfig();
  const store = cfg.store || {};
  const list = normalizeSources(store.pluginSource);
  if (!list.length) list.push(DEFAULT_STORE);
  return list;
}

function isAllowedSource(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const base = url.replace(/\/+$/, '');
  return allowedSources().includes(base);
}

async function readResponseLimited(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error('商店响应超过大小限制');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('商店响应超过大小限制');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/** 从商店拉取插件包信息（package-info，CORS 公开，无需商店登录） */
async function fetchPackageInfo(storeBase, pluginId) {
  const base = String(storeBase || '').replace(/\/+$/, '');
  const url = `${base}/store/api/plugins/${encodeURIComponent(pluginId)}/package-info`;
  const check = await validateUrl(url, { allowPrivate: false });
  if (!check.ok) throw new Error(`插件商店 URL 校验失败: ${check.error}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await proxyPool.pinnedFetchValidated(check, { signal: ac.signal, headers: { Accept: 'application/json' }, redirect: 'manual' });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const err = new Error(`从商店获取插件信息失败（HTTP ${res.status}）`);
      err.status = res.status;
      throw err;
    }
    const body = await readResponseLimited(res, MAX_PACKAGE_INFO_BYTES);
    let data;
    try { data = JSON.parse(body.toString('utf8')); }
    catch { throw new Error('商店返回的插件信息不是有效 JSON'); }
    if (!data || !data.plugin) {
      const err = new Error('商店返回的插件信息为空');
      err.status = 404;
      throw err;
    }
    return data.plugin;
  } finally {
    clearTimeout(timer);
  }
}

/** 下载插件 zip 到本地文件；若提供 sha256 则校验；限制大小与超时 */
async function downloadPackage(url, destPath, expectedSha256) {
  const check = await validateUrl(String(url), { allowPrivate: false });
  if (!check.ok) throw new Error(`插件下载 URL 校验失败: ${check.error}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  let res;
  let out;
  try {
    // 商店协议要求 ZIP 直链；拒绝重定向以免 URL 校验被绕过。
    res = await proxyPool.pinnedFetchValidated(check, { signal: ac.signal, redirect: 'manual' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PLUGIN_PACKAGE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Error('插件包超过大小限制');
    }
    if (!res.body) throw new Error('插件下载响应体为空');

    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 });
    const reader = res.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PLUGIN_PACKAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('插件包超过大小限制');
      }
      hash.update(value);
      await new Promise((resolve, reject) => out.write(value, (e) => (e ? reject(e) : resolve())));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    out = null;
    if (expectedSha256) {
      const got = hash.digest('hex');
      if (got.toLowerCase() !== String(expectedSha256).toLowerCase()) {
        throw new Error('插件包 SHA256 校验失败');
      }
    }
  } catch (e) {
    await res?.body?.cancel().catch(() => {});
    throw new Error('下载插件包失败: ' + e.message);
  } finally {
    clearTimeout(timer);
    if (out) {
      await new Promise((resolve) => out.end(resolve));
    }
  }
}

module.exports = { DEFAULT_STORE, allowedSources, isAllowedSource, fetchPackageInfo, downloadPackage };
