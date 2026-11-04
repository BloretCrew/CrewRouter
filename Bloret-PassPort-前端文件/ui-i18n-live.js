/**
 * Live UI catalogs from Bloret Translation public APIs (tr.bloret.net).
 *
 * Uses the same pair documented in Translation Collector PublicAPI:
 *   1. GET /api/v1/orgs/{org}/projects/{project}/manifest
 *   2. GET /api/v1/orgs/{org}/projects/{project}/files/{fileId}/translated?locale=
 *
 * Config: config.json → uiI18n (see defaults below).
 * Live non-empty strings overlay disk lang/*.json; empty/missing keep disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** @typedef {Record<string, string>} Catalog */

/**
 * @typedef {object} UiI18nConfig
 * @property {boolean} enabled
 * @property {string} baseUrl
 * @property {string} orgSlug
 * @property {string} projectSlug
 * @property {string} fileId
 * @property {Record<string, string>} localeMap
 * @property {string} mode
 * @property {boolean} fallbackMt
 * @property {number} cacheTtlMs
 * @property {number} timeoutMs
 */

/** @type {UiI18nConfig} */
const DEFAULTS = {
    enabled: false,
    baseUrl: 'https://tr.bloret.net',
    orgSlug: 'bloret',
    projectSlug: 'bloret-passport',
    fileId: 'f0c1f063-cf0e-45e1-935b-a987054d91ed',
    localeMap: { en: 'en', ru: 'ru' },
    mode: 'top_voted',
    fallbackMt: false,
    cacheTtlMs: 60_000,
    timeoutMs: 8_000,
};

/** @type {UiI18nConfig|null} */
let cachedCfg = null;

function loadUiI18nConfig() {
    if (cachedCfg) return cachedCfg;
    const raw = require('./config-loader').loadConfig();
    const u = raw.uiI18n && typeof raw.uiI18n === 'object' ? raw.uiI18n : {};
    cachedCfg = {
        enabled: u.enabled === true,
        baseUrl: typeof u.baseUrl === 'string' && u.baseUrl
            ? u.baseUrl.replace(/\/$/, '')
            : DEFAULTS.baseUrl,
        orgSlug: u.orgSlug || DEFAULTS.orgSlug,
        projectSlug: u.projectSlug || DEFAULTS.projectSlug,
        fileId: u.fileId || DEFAULTS.fileId,
        localeMap:
            u.localeMap && typeof u.localeMap === 'object'
                ? { ...DEFAULTS.localeMap, ...u.localeMap }
                : { ...DEFAULTS.localeMap },
        mode: ['top_voted', 'approved', 'source', 'empty'].includes(u.mode)
            ? u.mode
            : DEFAULTS.mode,
        fallbackMt: u.fallbackMt === true,
        cacheTtlMs:
            typeof u.cacheTtlMs === 'number' && u.cacheTtlMs > 0
                ? u.cacheTtlMs
                : DEFAULTS.cacheTtlMs,
        timeoutMs:
            typeof u.timeoutMs === 'number' && u.timeoutMs > 0
                ? u.timeoutMs
                : DEFAULTS.timeoutMs,
    };
    return cachedCfg;
}

/** Allow tests / hot-reload to pick up config again */
function reloadUiI18nConfig() {
    cachedCfg = null;
    return loadUiI18nConfig();
}

/** @type {Map<string, { catalog: Catalog, fetchedAt: number, source: string }>} */
const cache = new Map();
/** @type {Map<string, Promise<Catalog|null>>} */
const inflight = new Map();

let lastManifestOkAt = 0;
let lastManifestError = null;

function cacheKey(uiLang, projectLocale) {
    const c = loadUiI18nConfig();
    return `${c.orgSlug}/${c.projectSlug}/${c.fileId}/${uiLang}->${projectLocale}`;
}

function asCatalog(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    /** @type {Catalog} */
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') out[k] = v;
    }
    return out;
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: ac.signal,
            headers: { Accept: 'application/json' },
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

async function fetchUiI18nManifest() {
    const c = loadUiI18nConfig();
    if (!c.enabled) return { ok: false, error: 'disabled' };
    const url =
        `${c.baseUrl}/api/v1/orgs/${encodeURIComponent(c.orgSlug)}` +
        `/projects/${encodeURIComponent(c.projectSlug)}/manifest`;
    try {
        const data = await fetchJson(url, c.timeoutMs);
        lastManifestOkAt = Date.now();
        lastManifestError = null;
        return { ok: true, lang: data && data.lang };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastManifestError = msg;
        console.warn(`[ui-i18n] manifest failed: ${msg}`);
        return { ok: false, error: msg };
    }
}

/**
 * @param {string} uiLang  zh|en|ru
 * @returns {Promise<Catalog|null>}
 */
async function fetchLiveCatalog(uiLang) {
    const c = loadUiI18nConfig();
    if (!c.enabled) return null;
    if (uiLang === 'zh') return null;

    const projectLocale = c.localeMap[uiLang];
    if (!projectLocale) return null;

    const key = cacheKey(uiLang, projectLocale);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.fetchedAt < c.cacheTtlMs) {
        return hit.catalog;
    }

    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
        if (!lastManifestOkAt || now - lastManifestOkAt > c.cacheTtlMs) {
            await fetchUiI18nManifest();
        }

        const q = new URLSearchParams({
            locale: projectLocale,
            mode: c.mode,
        });
        if (c.fallbackMt) q.set('fallbackMt', '1');

        const url =
            `${c.baseUrl}/api/v1/orgs/${encodeURIComponent(c.orgSlug)}` +
            `/projects/${encodeURIComponent(c.projectSlug)}` +
            `/files/${encodeURIComponent(c.fileId)}/translated?${q}`;

        try {
            const raw = await fetchJson(url, c.timeoutMs);
            const catalog = asCatalog(raw);
            if (!catalog) {
                throw new Error('empty or invalid catalog body');
            }
            // Accept even all-empty bodies (project may have no suggestions yet);
            // merge layer keeps disk strings for empty live values.
            cache.set(key, {
                catalog,
                fetchedAt: Date.now(),
                source: 'live',
            });
            const filled = Object.values(catalog).filter(
                (v) => typeof v === 'string' && v.trim()
            ).length;
            console.log(
                `[ui-i18n] live catalog ${uiLang}←${projectLocale}: ${Object.keys(catalog).length} keys (${filled} non-empty)`
            );
            return catalog;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[ui-i18n] translated fetch failed (${uiLang}): ${msg}`);
            if (hit) {
                cache.set(key, { ...hit, source: 'stale' });
                return hit.catalog;
            }
            return null;
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, promise);
    return promise;
}

/**
 * @param {Catalog} disk
 * @param {Catalog|null|undefined} live
 * @returns {Catalog}
 */
function mergeCatalogs(disk, live) {
    if (!live || Object.keys(live).length === 0) return disk;
    const out = { ...disk };
    for (const [k, v] of Object.entries(live)) {
        if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
}

/**
 * @param {string} uiLang
 * @returns {Promise<Catalog|null>}
 */
async function ensureLiveCatalog(uiLang) {
    const c = loadUiI18nConfig();
    if (!c.enabled || uiLang === 'zh') return null;
    return fetchLiveCatalog(uiLang);
}

/**
 * @param {string} uiLang
 * @returns {Catalog|null}
 */
function getCachedLiveCatalog(uiLang) {
    const c = loadUiI18nConfig();
    if (!c.enabled || uiLang === 'zh') return null;
    const projectLocale = c.localeMap[uiLang];
    if (!projectLocale) return null;
    const ent = cache.get(cacheKey(uiLang, projectLocale));
    return ent ? ent.catalog : null;
}

function liveI18nStatus() {
    return {
        enabled: loadUiI18nConfig().enabled,
        lastManifestOkAt,
        lastManifestError,
        cacheSize: cache.size,
        config: loadUiI18nConfig(),
    };
}

function _resetLiveI18nCacheForTests() {
    cache.clear();
    inflight.clear();
    lastManifestOkAt = 0;
    lastManifestError = null;
    cachedCfg = null;
}

module.exports = {
    loadUiI18nConfig,
    reloadUiI18nConfig,
    fetchUiI18nManifest,
    fetchLiveCatalog,
    ensureLiveCatalog,
    getCachedLiveCatalog,
    mergeCatalogs,
    liveI18nStatus,
    _resetLiveI18nCacheForTests,
    DEFAULTS,
};
