/**
 * CrewRouter i18n catalog proxy.
 *
 * Serves UI translation catalogs from the Bloret Translation Collector public API
 * (same endpoints third parties use — dogfood pattern from tr.bloret.net itself).
 *
 *   GET /api/i18n/catalog?locale=en
 *
 * Source: {uiI18n.baseUrl}/api/v1/orgs/{orgSlug}/projects/{projectSlug}/files/{fileId}/translated?locale=…
 * Fallback chain: live → last good (memory) → disk lang/{locale}.json
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** @type {Map<string, { catalog: object, fetchedAt: number, source: string }>} */
const cache = new Map();
/** @type {Map<string, Promise<object|null>>} */
const inflight = new Map();

function uiI18nConfig() {
  try {
    const cfg = require('../../config.json');
    return cfg.uiI18n || null;
  } catch (e) {
    return null;
  }
}

function apiBase(cfg) {
  return String(cfg.baseUrl || 'https://tr.bloret.net').replace(/\/+$/, '');
}

function fetchJson(url, timeoutMs) {
  // Node 18+: global fetch available
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .finally(() => clearTimeout(timer));
}

function asCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function diskCatalog(locale) {
  if (!/^[a-zA-Z-]{2,10}$/.test(locale)) return null;
  try {
    const p = path.join(__dirname, '..', '..', 'lang', `${locale}.json`);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return asCatalog(raw);
  } catch (e) {
    return null;
  }
}

async function getCatalog(locale) {
  const cfg = uiI18nConfig();
  const hit = cache.get(locale);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    return { catalog: hit.catalog, source: hit.source };
  }

  let live = null;
  if (cfg && cfg.enabled !== false && cfg.fileId) {
    const key = locale;
    if (!inflight.has(key)) {
      const url =
        `${apiBase(cfg)}/api/v1/orgs/${encodeURIComponent(cfg.orgSlug)}` +
        `/projects/${encodeURIComponent(cfg.projectSlug)}` +
        `/files/${encodeURIComponent(cfg.fileId)}/translated` +
        `?locale=${encodeURIComponent(locale)}&mode=top_voted&fallbackMt=1`;
      inflight.set(
        key,
        fetchJson(url, FETCH_TIMEOUT_MS).finally(() => inflight.delete(key))
      );
    }
    live = await inflight.get(key).catch(() => null);
    live = asCatalog(live);
  }

  if (live) {
    // merge disk under live: new keys added locally but not yet uploaded to BTC
    // still get their translation instead of falling back to Chinese source.
    const disk = diskCatalog(locale);
    const merged = disk ? Object.assign({}, disk, live) : live;
    cache.set(locale, { catalog: merged, fetchedAt: Date.now(), source: 'live' });
    return { catalog: merged, source: 'live' };
  }

  if (hit) {
    // stale live data beats disk
    return { catalog: hit.catalog, source: 'stale' };
  }

  const disk = diskCatalog(locale);
  if (disk) {
    cache.set(locale, { catalog: disk, fetchedAt: Date.now(), source: 'disk' });
    return { catalog: disk, source: 'disk' };
  }

  return { catalog: {}, source: 'empty' };
}

router.get('/catalog', async (req, res) => {
  const locale = String(req.query.locale || '').trim();
  if (!locale) return res.status(400).json({ error: '缺少 locale' });
  try {
    const { catalog, source } = await getCatalog(locale);
    res.set('X-I18N-Source', source);
    res.set('Cache-Control', 'no-store');
    res.json(catalog);
  } catch (err) {
    console.error('[i18n] catalog error:', err.message);
    const disk = diskCatalog(locale) || {};
    res.set('X-I18N-Source', 'disk-error');
    res.json(disk);
  }
});

module.exports = router;
