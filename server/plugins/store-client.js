/**
 * 插件商店客户端（实例侧）
 *
 * 负责：校验插件商店源（防 SSRF / 恶意安装）、从商店拉取插件包信息、
 * 下载插件 zip 并校验 sha256。仅信任 config.store.pluginSource 允许清单内的 https 源。
 */

const crypto = require('crypto');
const fs = require('fs');
const Logger = require('../logger');

const DEFAULT_STORE = 'https://crewrouter.bloret.net';

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

/** 从商店拉取插件包信息（package-info，CORS 公开，无需商店登录） */
async function fetchPackageInfo(storeBase, pluginId) {
  const base = String(storeBase || '').replace(/\/+$/, '');
  const url = `${base}/store/api/plugins/${encodeURIComponent(pluginId)}/package-info`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`从商店获取插件信息失败（HTTP ${res.status}）`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  let res;
  try {
    res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('下载插件包失败: ' + e.message);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`下载插件包失败（HTTP ${res.status}）`);

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(destPath);
  const reader = res.body.getReader();
  const MAX = 30 * 1024 * 1024;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX) {
        await reader.cancel();
        throw new Error('插件包超过大小限制');
      }
      hash.update(value);
      await new Promise((resolve, reject) => out.write(value, (e) => (e ? reject(e) : resolve())));
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  if (expectedSha256) {
    const got = hash.digest('hex');
    if (got.toLowerCase() !== String(expectedSha256).toLowerCase()) {
      throw new Error('插件包 SHA256 校验失败');
    }
  }
}

module.exports = { DEFAULT_STORE, allowedSources, isAllowedSource, fetchPackageInfo, downloadPackage };
