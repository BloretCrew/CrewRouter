/**
 * Bloret PassPort i18n
 * 语言文件：lang/zh.json、lang/en.json、lang/ru.json（source-as-key）
 *
 * 可选：config.uiI18n.enabled 时，通过 tr.bloret.net 公开
 * Manifest + Translated 接口拉取实时译文并覆盖磁盘目录
 * （见 ui-i18n-live.js）。
 *
 * 用法：
 *   const { t, middleware, getLang } = require('./i18n');
 *   app.use(middleware());
 *   // 路由里：req.t('用户不存在') 或 t(req, '用户不存在')
 *   // 模板字符串：${req.t('登录')}
 *   // 无 req 时：t('登录') 默认中文；t('登录', 'en') 指定语言
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const {
    ensureLiveCatalog,
    getCachedLiveCatalog,
    mergeCatalogs,
    loadUiI18nConfig,
} = require('./ui-i18n-live');

const LANG_DIR = path.join(__dirname, 'lang');
const SUPPORTED = ['zh', 'en', 'ru'];
const DEFAULT_LANG = 'zh';

/** 请求级语言上下文，方便 generate*Html 里直接 t('登录') 无需传 req */
const als = new AsyncLocalStorage();

/** Disk-only catalogs (boot / reload). Live overlays applied in catalogFor. */
/** @type {Record<string, Record<string, string>>} */
const diskCatalogs = {};

function loadCatalog(lang) {
    const file = path.join(LANG_DIR, `${lang}.json`);
    if (!fs.existsSync(file)) {
        console.warn(`[i18n] missing lang file: ${file}`);
        return {};
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        /** @type {Record<string, string>} */
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    } catch (e) {
        console.error(`[i18n] failed to load ${file}:`, e.message);
        return {};
    }
}

function reload() {
    for (const lang of SUPPORTED) {
        diskCatalogs[lang] = loadCatalog(lang);
    }
}

reload();

/**
 * 从 Accept-Language / cookie / query 解析语言
 * 优先级：?lang= > cookie bp_lang > Accept-Language > default
 */
function detectLang(req) {
    if (!req) return DEFAULT_LANG;

    const q = req.query && (req.query.lang || req.query.locale);
    if (q && SUPPORTED.includes(String(q).toLowerCase().slice(0, 2))) {
        return String(q).toLowerCase().slice(0, 2);
    }

    const cookieHeader = req.headers && req.headers.cookie;
    if (cookieHeader) {
        const m = /(?:^|;\s*)bp_lang=([a-zA-Z\-]+)/.exec(cookieHeader);
        if (m) {
            const c = m[1].toLowerCase().slice(0, 2);
            if (SUPPORTED.includes(c)) return c;
        }
    }

    const al = req.headers && req.headers['accept-language'];
    if (al) {
        // e.g. "en-US,en;q=0.9,zh-CN;q=0.8"
        const parts = String(al).split(',');
        for (const part of parts) {
            const code = part.trim().split(';')[0].trim().toLowerCase().slice(0, 2);
            if (SUPPORTED.includes(code)) return code;
        }
    }

    return DEFAULT_LANG;
}

/**
 * @param {string} lang
 * @returns {Record<string, string>}
 */
function catalogFor(lang) {
    const L = SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
    const disk = diskCatalogs[L] || diskCatalogs[DEFAULT_LANG] || {};
    if (L === 'zh') return disk;
    const live = getCachedLiveCatalog(L);
    return mergeCatalogs(disk, live);
}

/**
 * 翻译
 * @param {string} key 中文原文（source-as-key）
 * @param {string} [lang] 语言代码
 * @param {Record<string, string|number>} [vars] 插值 {name} → value
 */
function translate(key, lang, vars) {
    if (key == null || key === '') return key;
    const L = (lang && SUPPORTED.includes(lang)) ? lang : DEFAULT_LANG;
    const catalog = catalogFor(L);
    let out = catalog[key];
    if (out == null) {
        // fallback：中文原文，再 fallback key 本身
        out = (diskCatalogs[DEFAULT_LANG] && diskCatalogs[DEFAULT_LANG][key]) || key;
    }
    // 去掉未完成英文的 [EN] 前缀（显示时）
    if (typeof out === 'string' && out.startsWith('[EN] ')) {
        out = out.slice(5);
    }
    if (vars && typeof out === 'string') {
        out = out.replace(/\{(\w+)\}/g, (_, k) =>
            (vars[k] != null ? String(vars[k]) : `{${k}}`)
        );
    }
    return out;
}

function currentLang() {
    const store = als.getStore();
    if (store && store.lang) return store.lang;
    return DEFAULT_LANG;
}

/** HTML <html lang="..."> 值 */
function htmlLang(lang) {
    const L = lang || currentLang();
    if (L === 'zh') return 'zh-CN';
    if (L === 'en') return 'en';
    if (L === 'ru') return 'ru';
    return L;
}

/**
 * 便捷函数：
 *   t('登录')                  → 当前请求语言（无请求则中文）
 *   t('登录', 'en')            → 英文
 *   t(req, '登录')             → 按 req 语言
 *   t(req, '你好 {name}', {name:'A'})
 */
function t(a, b, c) {
    // t(req, key, vars?)
    if (a && typeof a === 'object' && a.headers) {
        const lang = a.lang || detectLang(a);
        return translate(b, lang, c);
    }
    // t(key, lang?, vars?)
    if (typeof b === 'string' && SUPPORTED.includes(b)) {
        return translate(a, b, c);
    }
    // t(key, vars?)
    if (b && typeof b === 'object') {
        return translate(a, currentLang(), b);
    }
    // t(key) 或 t(key, undefined)
    return translate(a, (b || currentLang()), c);
}

/**
 * Express 中间件：挂 req.lang / req.t，并处理 ?lang= 写 cookie
 * 同时用 AsyncLocalStorage 让全局 t() 在本请求内自动用对语言
 * 若启用 uiI18n，在进入路由前异步刷新当前语言的 live catalog（带 TTL 缓存）
 */
function middleware(options = {}) {
    const cookieMaxAge = options.cookieMaxAge || 365 * 24 * 3600; // 1 year
    return function i18nMiddleware(req, res, next) {
        // ?lang=xx 持久化
        const q = req.query && (req.query.lang || req.query.locale);
        let setCookie = null;
        if (q) {
            const code = String(q).toLowerCase().slice(0, 2);
            if (SUPPORTED.includes(code)) {
                setCookie = `bp_lang=${code}; Path=/; Max-Age=${cookieMaxAge}; SameSite=Lax`;
            }
        }

        const lang = detectLang(req);

        const finish = () => {
            req.lang = lang;
            req.t = function (key, vars) {
                return translate(key, req.lang, vars);
            };
            req.htmlLang = htmlLang(req.lang);
            if (setCookie) {
                const prev = res.getHeader('Set-Cookie');
                if (!prev) res.setHeader('Set-Cookie', setCookie);
                else if (Array.isArray(prev)) res.setHeader('Set-Cookie', prev.concat(setCookie));
                else res.setHeader('Set-Cookie', [prev, setCookie]);
            }
            als.run({ lang: req.lang, req }, () => next());
        };

        // Skip live refresh for health / static noise if any; always skip zh.
        const p = (req.path || req.url || '').split('?')[0];
        const skipLive =
            lang === 'zh' ||
            p === '/api/health' ||
            p.startsWith('/api/health');

        if (skipLive || !loadUiI18nConfig().enabled) {
            finish();
            return;
        }

        void ensureLiveCatalog(lang)
            .catch(() => null)
            .then(() => finish());
    };
}

/**
 * 给 generate*Html 用：返回绑定了当前语言的 t
 * 无 req 时用默认语言
 */
function binder(reqOrLang) {
    let lang = DEFAULT_LANG;
    if (typeof reqOrLang === 'string') lang = reqOrLang;
    else if (reqOrLang && reqOrLang.lang) lang = reqOrLang.lang;
    else if (reqOrLang && reqOrLang.headers) lang = detectLang(reqOrLang);
    return function boundT(key, vars) {
        return translate(key, lang, vars);
    };
}

function getCatalog(lang) {
    const L = lang && SUPPORTED.includes(lang) ? lang : currentLang();
    return catalogFor(L);
}

module.exports = {
    t,
    translate,
    detectLang,
    middleware,
    binder,
    reload,
    currentLang,
    htmlLang,
    getCatalog,
    SUPPORTED,
    DEFAULT_LANG,
    /** @deprecated use getCatalog / disk+live merge; kept for callers */
    getCatalogs: () => {
        const out = {};
        for (const lang of SUPPORTED) out[lang] = catalogFor(lang);
        return out;
    },
};
