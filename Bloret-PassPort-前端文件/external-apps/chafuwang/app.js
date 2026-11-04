const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https'); // 添加https模块导入
const multer = require('multer');
const { normalizeUsername, nicknameFor } = require('./username-migrate');
const { buildCommentAuthor } = require('./comment-display');

// 读取配置文件
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const port = process.env.PORT || config.port || 3000;

const oauthAppConfig = config.OauthApp || {};
const oauthAppId = String(oauthAppConfig.id || '').trim();
const oauthAppSecret = String(oauthAppConfig.secret || '').trim();
const oauthRedirectUri = String(oauthAppConfig.redirect_uri || '').trim();
const oauthAuthorizeBase = String(process.env.OAUTH_AUTHORIZE_BASE || 'https://passport.bloret.net').trim();
const oauthVerifyBase = String(process.env.OAUTH_VERIFY_BASE || oauthAppConfig.verify_base || oauthAuthorizeBase || 'https://passport.bloret.net').trim();
const oauthVerifyPath = String(process.env.OAUTH_VERIFY_PATH || oauthAppConfig.verify_path || '/app/verify').trim() || '/app/verify';
const imageHostBase = String(config.imghost || '').trim();
const configuredAdminUsers = new Set(
    (Array.isArray(config.admin) ? config.admin : [])
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
);

function isConfiguredSuperAdmin(username) {
    // 迁移兼容：配置白名单里新旧拼写均可命中
    const canon = normalizeUsername(String(username || '').trim());
    return configuredAdminUsers.has(canon.toLowerCase()) || configuredAdminUsers.has(String(username || '').trim().toLowerCase());
}

function isOauthConfigured() {
    return Boolean(oauthAppId && oauthAppSecret && oauthRedirectUri);
}

function buildOauthAuthorizeUrl() {
    if (!oauthAppId || !oauthRedirectUri) {
        return '';
    }

    const authorizeUrl = new URL('/app/oauth', oauthAuthorizeBase);
    authorizeUrl.search = new URLSearchParams({
        app_id: oauthAppId,
        redirect_uri: oauthRedirectUri
    }).toString();

    return authorizeUrl.toString();
}

function buildPassportHomeUrl() {
    try {
        return new URL('/', oauthAuthorizeBase || 'https://passport.bloret.net').toString();
    } catch (error) {
        return 'https://passport.bloret.net/';
    }
}

function buildOauthVerifyUrl(code) {
    const verifyUrl = new URL(oauthVerifyPath, oauthVerifyBase);
    verifyUrl.search = new URLSearchParams({
        app_id: oauthAppId,
        app_secret: oauthAppSecret,
        code: String(code || '')
    }).toString();

    return verifyUrl;
}

function sanitizeOauthUrlForLog(value) {
    try {
        const url = new URL(String(value || ''));
        if (url.searchParams.has('app_secret')) {
            url.searchParams.set('app_secret', '***');
        }
        if (url.searchParams.has('code')) {
            url.searchParams.set('code', '***');
        }
        return url.toString();
    } catch (error) {
        return '[invalid-oauth-url]';
    }
}

function previewText(value, maxLength = 200) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength)}…`;
}

function requestOauthUserData(verifyUrl) {
    return new Promise((resolve, reject) => {
        const requestModule = verifyUrl.protocol === 'https:' ? https : http;
        const request = requestModule.request(
            {
                protocol: verifyUrl.protocol,
                hostname: verifyUrl.hostname,
                port: verifyUrl.port || undefined,
                method: 'GET',
                path: `${verifyUrl.pathname}${verifyUrl.search}`,
                headers: {
                    Accept: 'application/json'
                },
                insecureHTTPParser: true
            },
            (response) => {
                let data = '';

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    const statusCode = Number(response.statusCode) || 0;

                    if (statusCode < 200 || statusCode >= 300) {
                        return reject(new Error(`OAuth verify failed with status ${statusCode}: ${previewText(data)}`));
                    }

                    try {
                        const parsed = JSON.parse(data);
                        return resolve(parsed);
                    } catch (error) {
                        return reject(new Error(`OAuth verify returned non-JSON payload: ${previewText(data)}`));
                    }
                });
            }
        );

        request.on('error', (error) => {
            reject(error);
        });

        request.end();
    });
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return String(value || '');
    }
}

function parseRequestCookies(req) {
    const rawCookie = String(req?.headers?.cookie || '');
    if (!rawCookie) {
        return {};
    }

    return rawCookie.split(';').reduce((accumulator, item) => {
        const entry = String(item || '').trim();
        if (!entry) {
            return accumulator;
        }

        const separatorIndex = entry.indexOf('=');
        if (separatorIndex <= 0) {
            return accumulator;
        }

        const key = entry.slice(0, separatorIndex).trim();
        const value = entry.slice(separatorIndex + 1).trim();
        if (!key) {
            return accumulator;
        }

        accumulator[key] = safeDecodeURIComponent(value);
        return accumulator;
    }, {});
}

function normalizeServerHostInput(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value)) {
        try {
            const parsed = new URL(value);
            return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
        } catch (error) {
            return '';
        }
    }

    return value;
}

function isValidServerHost(value) {
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d+)?$/.test(String(value || '').trim());
}

function normalizeBackgroundUrl(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
        return value;
    }

    return '';
}

function normalizeImageGallery(value, limit = 8) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const list = [];

    source.forEach((item) => {
        const url = normalizeBackgroundUrl(item);
        if (!url || seen.has(url)) {
            return;
        }

        seen.add(url);
        list.push(url);
    });

    return list.slice(0, Math.max(0, Number(limit) || 0));
}

function normalizeAvatarUrl(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
        return value;
    }

    return '';
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(/[\n,，]/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function dedupeStringArray(value) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();

    return source
        .map((item) => String(item || '').trim())
        .filter((item) => {
            if (!item || seen.has(item)) {
                return false;
            }

            seen.add(item);
            return true;
        });
}

function normalizePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return value;
}

function normalizeActivityDate(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return '';
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        return rawValue;
    }

    const text = String(rawValue || '').trim();
    if (!text) {
        return '';
    }

    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
        return numeric;
    }

    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
        return parsed;
    }

    return text;
}

function normalizeActivityLink(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
        return value;
    }

    if (isValidServerHost(value)) {
        return `https://${value}`;
    }

    return '';
}

function normalizeSingleActivity(item, index = 0) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const title = String(item.title || item.name || '').trim();
    if (!title) {
        return null;
    }

    const summary = String(item.summary || item.desc || item.description || '').trim();
    const banner = normalizeBackgroundUrl(item.banner || item.cover || item.image || item.poster);
    const startAt = normalizeActivityDate(item.startAt || item.start || item.beginAt || item.startTime);
    const endAt = normalizeActivityDate(item.endAt || item.end || item.finishAt || item.endTime);
    const link = normalizeActivityLink(item.link || item.url);
    const updatedAtRaw = Number(item.updatedAt);

    return {
        id: String(item.id || `activity-${Date.now()}-${index + 1}`).trim(),
        title,
        summary,
        banner,
        startAt,
        endAt,
        link,
        updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : Date.now()
    };
}

function normalizeServerActivities(value) {
    const source = Array.isArray(value) ? value : [];
    return source
        .map((item, index) => normalizeSingleActivity(item, index))
        .filter(Boolean)
        .slice(0, 20);
}

function toAbsoluteImageUrl(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    if (value.startsWith('/') && imageHostBase) {
        try {
            return new URL(value, imageHostBase).toString();
        } catch (error) {
            return value;
        }
    }

    return value;
}

function parseLauncherLoginResult(rawValue) {
    const cleaned = String(rawValue || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (!cleaned) {
        return {
            ok: false,
            data: null,
            cleaned
        };
    }

    try {
        return {
            ok: true,
            data: JSON.parse(cleaned),
            cleaned
        };
    } catch (error) {
        return {
            ok: false,
            data: null,
            cleaned,
            error
        };
    }
}

function verifyLauncherCredentials(username, password) {
    return new Promise((resolve, reject) => {
        const loginQuery = `name=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        const loginTargetUrl = `http://launcher.bloret.net/api/login?${loginQuery}`;

        http.get(loginTargetUrl, (loginResponse) => {
            let loginResult = '';

            loginResponse.on('data', (chunk) => {
                loginResult += chunk;
            });

            loginResponse.on('end', () => {
                try {
                    const parsed = parseLauncherLoginResult(loginResult);
                    if (!parsed.ok || !parsed.data) {
                        return resolve({
                            authenticated: false,
                            response: {
                                message: `用户验证服务返回异常响应：${previewText(parsed.cleaned || '[empty]')}`,
                                authServiceError: true
                            }
                        });
                    }

                    const statusCode = Number(loginResponse.statusCode) || 0;
                    const isHttpOk = statusCode >= 200 && statusCode < 300;
                    const authenticated = isHttpOk && Boolean(parsed.data.status || parsed.data.success);

                    if (!isHttpOk && !parsed.data.message) {
                        parsed.data.message = `用户验证服务状态异常（${statusCode}）`;
                    }
                    if (!isHttpOk) {
                        parsed.data.authServiceError = true;
                    }

                    resolve({
                        authenticated,
                        response: parsed.data
                    });
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            reject(error);
        });
    });
}

const TYPE_DATA_FILE = path.join(__dirname, 'data', 'type.json');
const PART_DATA_FILE = path.join(__dirname, 'data', 'part.json');
const SERVER_REVIEW_QUEUE_FILE = path.join(__dirname, 'data', 'server_review_queue.json');
const SERVER_COMMENT_FILE = path.join(__dirname, 'data', 'server_comments.json');

function ensureFileDirectory(filePath) {
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function readTypeConfigMap() {
    if (!fs.existsSync(TYPE_DATA_FILE)) {
        return {};
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(TYPE_DATA_FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        return parsed;
    } catch (error) {
        console.warn('读取 data/type.json 失败：', error);
        return {};
    }
}

function isUserEditableTagFlag(rawFlag) {
    if (rawFlag === true || rawFlag === 1) {
        return true;
    }

    if (typeof rawFlag === 'string') {
        const normalized = rawFlag.trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }

    return false;
}

function getUserEditableTagSet(typeConfig = readTypeConfigMap()) {
    const allowed = new Set();
    if (!typeConfig || typeof typeConfig !== 'object' || Array.isArray(typeConfig)) {
        return allowed;
    }

    Object.entries(typeConfig).forEach(([key, value]) => {
        if (!value || typeof value !== 'object' || !isUserEditableTagFlag(value.user)) {
            return;
        }

        const tagName = String(value.name || key || '').trim();
        if (tagName) {
            allowed.add(tagName);
        }
    });

    return allowed;
}

function normalizeServerTypeByRole(existingType, submittedType, options = {}) {
    const allowAllTags = Boolean(options.allowAllTags);
    const normalizedSubmitted = dedupeStringArray(normalizeStringArray(submittedType));

    if (allowAllTags) {
        return normalizedSubmitted;
    }

    const editableTagSet = getUserEditableTagSet();
    const lockedExistingTags = dedupeStringArray(
        normalizeStringArray(existingType).filter((tag) => !editableTagSet.has(tag))
    );

    if (editableTagSet.size === 0) {
        return lockedExistingTags;
    }

    const editableSubmittedTags = normalizedSubmitted.filter((tag) => editableTagSet.has(tag));
    return dedupeStringArray([...lockedExistingTags, ...editableSubmittedTags]);
}

function normalizeServerCommentTarget(rawValue) {
    const host = normalizeServerHostInput(rawValue);
    if (!host || !isValidServerHost(host)) {
        return '';
    }

    return host.toLowerCase();
}

function normalizeUsernameKey(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeServerCommentThreadItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const id = String(item.id || '').trim() || createServerCommentId();
    const content = String(item.content || '').trim();
    const createdAt = Number(item.createdAt);

    if (!content) {
        return null;
    }

    return {
        id,
        content: content.slice(0, 500),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
    };
}

function normalizeServerCommentReplyItem(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const id = String(item.id || '').trim() || createServerCommentId();
    const username = String(item.username || '').trim() || '匿名用户';
    const nickname = String(item.nickname || item.username || '').trim() || username;
    const usernameKey = normalizeUsernameKey(item.usernameKey || item.username || username);
    const content = String(item.content || '').trim();
    const createdAt = Number(item.createdAt);

    if (!content) {
        return null;
    }

    return {
        id,
        username,
        nickname,
        usernameKey,
        content: content.slice(0, 500),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
    };
}

function normalizeServerCommentRecord(record) {
    if (!record || typeof record !== 'object') {
        return null;
    }

    const id = String(record.id || '').trim();
    const username = String(record.username || '').trim() || '匿名用户';
    // 迁移兼容：历史数据的 username 可能是旧名；优先显式 nickname，否则由迁移映射推导
    const storedNick = String(record.nickname || '').trim();
    const nickname = storedNick || (username !== '匿名用户' ? nicknameFor(username) : username);
    const usernameKey = normalizeUsernameKey(record.usernameKey || username);
    const content = String(record.content || '').trim();
    const rating = Number(record.rating);
    const createdAt = Number(record.createdAt);

    if (!id || !content || !Number.isFinite(rating)) {
        return null;
    }

    return {
        id,
        username,
        nickname,
        usernameKey,
        content: content.slice(0, 500),
        rating: Math.min(5, Math.max(1, Math.round(rating * 10) / 10)),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        followUps: Array.isArray(record.followUps)
            ? record.followUps.map((item) => normalizeServerCommentThreadItem(item)).filter(Boolean)
            : [],
        replies: Array.isArray(record.replies)
            ? record.replies.map((item) => normalizeServerCommentReplyItem(item)).filter(Boolean)
            : []
    };
}

function normalizeServerCommentList(list) {
    const source = Array.isArray(list) ? list : [];

    const comments = source
        .map((item) => normalizeServerCommentRecord(item))
        .filter(Boolean)
        .slice(0, 500);

    return comments;
}

function readServerCommentStore() {
    if (!fs.existsSync(SERVER_COMMENT_FILE)) {
        return {};
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(SERVER_COMMENT_FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        const store = {};
        Object.entries(parsed).forEach(([key, value]) => {
            const host = normalizeServerCommentTarget(key);
            if (!host) {
                return;
            }

            const comments = Array.isArray(value)
                ? normalizeServerCommentList(value)
                : [];

            store[host] = comments;
        });

        return store;
    } catch (error) {
        console.error('读取评论数据失败：', error);
        return {};
    }
}

function writeServerCommentStore(store) {
    ensureFileDirectory(SERVER_COMMENT_FILE);
    fs.writeFileSync(
        SERVER_COMMENT_FILE,
        JSON.stringify(store && typeof store === 'object' ? store : {}, null, 2)
    );
}

function summarizeServerComments(comments) {
    const list = normalizeServerCommentList(comments);
    const validRatings = list
        .map((item) => Number(item?.rating))
        .filter((value) => Number.isFinite(value));

    const ratingCount = validRatings.length;
    const averageRating = ratingCount > 0
        ? Math.round((validRatings.reduce((sum, value) => sum + value, 0) / ratingCount) * 10) / 10
        : null;

    return {
        ratingCount,
        averageRating
    };
}

function createServerCommentId() {
    return `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function findServerByHost(host) {
    const normalizedHost = normalizeServerCommentTarget(host);
    if (!normalizedHost) {
        return null;
    }

    const partData = readPartData();
    return partData.Servers.find((item) => normalizeServerCommentTarget(item?.url || '') === normalizedHost) || null;
}

function readPartData() {
    ensureFileDirectory(PART_DATA_FILE);

    if (!fs.existsSync(PART_DATA_FILE)) {
        return { Servers: [] };
    }

    try {
        const partData = JSON.parse(fs.readFileSync(PART_DATA_FILE, 'utf8'));
        if (!partData || typeof partData !== 'object' || Array.isArray(partData)) {
            return { Servers: [] };
        }

        if (!Array.isArray(partData.Servers)) {
            partData.Servers = [];
        }

        return partData;
    } catch (error) {
        throw new Error(`读取 data/part.json 失败: ${error.message || 'unknown error'}`);
    }
}

function writePartData(partData) {
    ensureFileDirectory(PART_DATA_FILE);
    fs.writeFileSync(PART_DATA_FILE, JSON.stringify(partData, null, 2));
}

function readServerReviewQueue() {
    if (!fs.existsSync(SERVER_REVIEW_QUEUE_FILE)) {
        return [];
    }

    const parsed = JSON.parse(fs.readFileSync(SERVER_REVIEW_QUEUE_FILE, 'utf8'));
    const list = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.requests) ? parsed.requests : []);

    return list
        .filter((item) => item && typeof item === 'object')
        .filter((item) => String(item.id || '').trim());
}

function writeServerReviewQueue(queue) {
    ensureFileDirectory(SERVER_REVIEW_QUEUE_FILE);
    fs.writeFileSync(
        SERVER_REVIEW_QUEUE_FILE,
        JSON.stringify(Array.isArray(queue) ? queue : [], null, 2)
    );
}

function createReviewRequestId() {
    return `review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildNextServerPayload(existingServer, serverInput, host, username, userAvatar = '', options = {}) {
    const nickname = String(options.nickname || username).trim() || username;
    const allowAllTags = Boolean(options.allowAllTags);
    const systemUpdatedAt = Date.now();
    const gallery = normalizeImageGallery(serverInput.gallery ?? existingServer?.gallery);
    const background = normalizeBackgroundUrl(serverInput.background)
        || normalizeBackgroundUrl(existingServer?.background)
        || gallery[0]
        || '';

    return {
        ...(existingServer || {}),
        title: String(serverInput.title || '').trim(),
        text: String(serverInput.text || '').trim(),
        url: host,
        otherip: normalizePlainObject(serverInput.otherip),
        OnlineCheck: Boolean(serverInput.OnlineCheck),
        type: normalizeServerTypeByRole(existingServer?.type, serverInput.type, { allowAllTags }),
        tip: String(serverInput.tip || ''),
        links: normalizePlainObject(serverInput.links),
        author: existingServer?.author ? String(existingServer.author) : username,
        authorNickname: existingServer?.authorNickname ? String(existingServer.authorNickname) : nickname,
        authorAvatar: normalizeAvatarUrl(serverInput.authorAvatar || existingServer?.authorAvatar || userAvatar),
        category: String(serverInput.category || ''),
        client: String(serverInput.client || ''),
        language: String(serverInput.language || ''),
        version: String(serverInput.version || ''),
        mode: String(serverInput.mode || ''),
        build: String(serverInput.build || ''),
        updatedAt: systemUpdatedAt,
        privacy: String(serverInput.privacy || ''),
        time: Number.isFinite(Number(existingServer?.time)) ? Number(existingServer.time) : Date.now(),
        BestTime: String(serverInput.BestTime ?? existingServer?.BestTime ?? ''),
        activities: normalizeServerActivities(serverInput.activities ?? existingServer?.activities),
        background,
        gallery
    };
}

async function authenticateRequestUser(req, logLabel = '') {
    const cookies = parseRequestCookies(req);
    // 迁移兼容：cookie 里的旧用户名（如 Rhedar/NBF）收敛为新 username
    const rawUsername = String(cookies.username || '').trim();
    const username = normalizeUsername(rawUsername);
    const nickname = String(cookies.nickname || '').trim() || nicknameFor(username);
    const password = String(cookies.password || '').trim();

    if (!username || !password) {
        return {
            success: false,
            status: 401,
            message: '请先登录后再操作'
        };
    }

    let authResult;
    try {
        authResult = await verifyLauncherCredentials(username, password);
    } catch (error) {
        authResult = {
            authenticated: false,
            response: {
                message: `用户验证服务不可用：${error.message || 'unknown error'}`,
                authServiceError: true
            }
        };
    }

    if (!authResult.authenticated) {
        const authServiceError = Boolean(authResult?.response?.authServiceError);
        if (!authServiceError) {
            return {
                success: false,
                status: 401,
                message: authResult?.response?.message || '用户验证失败'
            };
        }

        console.warn(`[AUTH_FALLBACK] ${logLabel || 'request'} 使用会话回退鉴权：`, {
            username,
            reason: authResult?.response?.message || 'auth service unavailable'
        });
    }

    return {
        success: true,
        username,
        nickname,
        avatar: String(cookies.avatar || '').trim(),
        isSuperAdmin: isConfiguredSuperAdmin(username)
    };
}

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

const retiredPageRoutePatterns = [
    /^\/(?:login|new|settings|change-server-post)(?:\/.*)?$/i,
    /^\/reg\.html$/i,
    /^\/[^/]+\.html$/i
];

function shouldRedirectToUnifiedHome(pathname) {
    if (pathname === '/' || pathname === '/index.html') {
        return false;
    }

    return retiredPageRoutePatterns.some((pattern) => pattern.test(pathname));
}

const staticAssetExtensions = new Set([
    '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.map',
    '.txt', '.xml', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.md', '.html'
]);

function resolveServerHostFromPath(pathname) {
    const rawPath = String(pathname || '').trim();
    if (!rawPath || rawPath === '/' || rawPath === '/index.html') {
        return '';
    }

    const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
    if (!trimmed || trimmed.includes('/')) {
        return '';
    }

    const decoded = safeDecodeURIComponent(trimmed).trim();
    if (!decoded || decoded.includes('/')) {
        return '';
    }

    if (!isValidServerHost(decoded)) {
        return '';
    }

    if (!decoded.includes('.') && !decoded.includes(':')) {
        return '';
    }

    const extension = path.extname(decoded).toLowerCase();
    if (staticAssetExtensions.has(extension)) {
        return '';
    }

    return decoded;
}

function buildIntegratedIndexHtml() {
    const htmlPath = path.join(__dirname, 'index.html');
    const cssPath = path.join(__dirname, 'index.css');
    const jsPath = path.join(__dirname, 'index.js');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    const htmlWithInlineCss = html.replace(
        /<link\s+rel="stylesheet"\s+href="index\.css"\s*>/i,
        `<style id="inline-fluent2-style">\n${css}\n</style>`
    );

    return htmlWithInlineCss.replace(
        /<script\s+src="index\.js"><\/script>/i,
        `<script id="inline-fluent2-script">\n${js}\n</script>`
    );
}

// 创建访问日志中间件
const accessLogStream = fs.createWriteStream(path.join(__dirname, 'log', 'access.log'), { flags: 'a' });

// 添加中间件来阻止访问敏感文件
app.use((req, res, next) => {
    // 阻止直接访问配置文件
    if (req.path === '/config.json') {
        // 记录访问被拒绝的日志
        const logMessage = `[${new Date().toISOString()}] [FORBIDDEN] ${req.ip} tried to access ${req.path}\n`;
        console.log(logMessage.trim());
        accessLogStream.write(logMessage);
        
        return res.status(403).send('Forbidden');
    }
    next();
});

// 添加访问日志中间件
app.use((req, res, next) => {
    // 记录请求信息
    const logMessage = `[${new Date().toISOString()}] [INFO] ${req.ip} ${req.method} ${req.path}\n`;
    console.log(logMessage.trim());
    accessLogStream.write(logMessage);
    
    // 如果有查询参数，也记录它们（但要避免记录敏感信息）
    if (Object.keys(req.query).length > 0) {
        // 过滤掉可能的敏感参数
        const filteredQuery = { ...req.query };
        delete filteredQuery.password;
        delete filteredQuery.token;
        delete filteredQuery.code;
        delete filteredQuery.app_secret;
        
        if (Object.keys(filteredQuery).length > 0) {
            const queryLogMessage = `[${new Date().toISOString()}] [QUERY] ${req.ip} ${req.path} - Query: ${JSON.stringify(filteredQuery)}\n`;
            console.log(queryLogMessage.trim());
            accessLogStream.write(queryLogMessage);
        }
    }
    
    next();
});

// 添加OAuth回调端点
app.get('/oauth', async (req, res) => {
    try {
        const code = String(req.query.code || '').trim();
        
        // 检查是否提供了授权码
        if (!code) {
            return res.status(400).send('Missing authorization code');
        }

        if (!isOauthConfigured()) {
            return res.status(500).send('OAuth config is incomplete');
        }

        const verifyUrl = buildOauthVerifyUrl(code);
        let userData;

        try {
            userData = await requestOauthUserData(verifyUrl);
        } catch (error) {
            console.error('Error verifying authorization code:', {
                message: error.message,
                verifyUrl: sanitizeOauthUrlForLog(verifyUrl)
            });
            return res.status(502).send('Failed to verify authorization code');
        }

        if (userData.username && userData.password) {
            const oneYear = 365 * 24 * 60 * 60 * 1000;
            const expiresDate = new Date(Date.now() + oneYear);
            const commonCookieOptions = {
                expires: expiresDate,
                httpOnly: false,
                path: '/'
            };

            res.cookie('username', normalizeUsername(userData.username), {
                ...commonCookieOptions
            });
            // 展示名（nickname）：verify 未返回时回退迁移映射/用户名
            res.cookie('nickname', userData.nickname || nicknameFor(normalizeUsername(userData.username)), {
                ...commonCookieOptions
            });
            res.cookie('password', userData.password, {
                ...commonCookieOptions
            });

            const isAdmin = isConfiguredSuperAdmin(userData.username);
            res.cookie('admin', isAdmin, {
                ...commonCookieOptions
            });

            const avatar = typeof userData.avatar === 'string' ? userData.avatar.trim() : '';
            if (avatar) {
                res.cookie('avatar', avatar, {
                    ...commonCookieOptions
                });
            } else {
                res.clearCookie('avatar', { path: '/' });
            }

            return res.redirect('/');
        }

        console.error('Invalid user data received from OAuth verify:', previewText(JSON.stringify(userData), 300));
        return res.status(400).send('Invalid user data received');
    } catch (err) {
        console.error('OAuth callback error:', err);
        res.status(500).send('Internal server error');
    }
});

app.get('/api/oauth/url', (req, res) => {
    if (!oauthAppId || !oauthRedirectUri) {
        return res.status(500).json({ error: 'OAuth config is incomplete' });
    }

    return res.json({
        app_id: oauthAppId,
        redirect_uri: oauthRedirectUri,
        url: buildOauthAuthorizeUrl()
    });
});

app.get('/api/oauth/entry', (req, res) => {
    const oauthUrl = buildOauthAuthorizeUrl();
    if (!oauthUrl) {
        return res.status(500).send('OAuth config is incomplete');
    }

    return res.redirect(oauthUrl);
});

app.get('/api/oauth/passport', (req, res) => {
    return res.redirect(buildPassportHomeUrl());
});

app.get('/api/auth/session', (req, res) => {
    const cookies = parseRequestCookies(req);
    // 迁移兼容：旧 Cookie 里的旧用户名收敛为新 username；nickname 缺省回退映射
    const rawUsername = String(cookies.username || '').trim();
    const username = normalizeUsername(rawUsername);
    const nickname = String(cookies.nickname || '').trim() || nicknameFor(username);
    const avatar = String(cookies.avatar || '').trim();

    return res.json({
        authenticated: Boolean(username),
        username,
        nickname,
        avatar,
        admin: isConfiguredSuperAdmin(rawUsername) || isConfiguredSuperAdmin(username)
    });
});

app.post('/api/logout', (req, res) => {
    const clearCookieOptions = { path: '/' };

    res.clearCookie('username', clearCookieOptions);
    res.clearCookie('password', clearCookieOptions);
    res.clearCookie('admin', clearCookieOptions);
    res.clearCookie('avatar', clearCookieOptions);

    return res.json({ success: true });
});

app.get('/api/logout', (req, res) => {
    const clearCookieOptions = { path: '/' };

    res.clearCookie('username', clearCookieOptions);
    res.clearCookie('password', clearCookieOptions);
    res.clearCookie('admin', clearCookieOptions);
    res.clearCookie('avatar', clearCookieOptions);

    return res.redirect('/');
});

app.get(['/', '/index.html'], (req, res) => {
    try {
        const integratedHtml = buildIntegratedIndexHtml();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(integratedHtml);
    } catch (error) {
        console.error('构建集成首页失败:', error);
        return res.status(500).send('首页渲染失败');
    }
});

app.get('/:serverHost', (req, res, next) => {
    const serverHost = resolveServerHostFromPath(req.path);
    if (!serverHost) {
        return next();
    }

    const possibleStaticPath = path.join(__dirname, serverHost);
    if (fs.existsSync(possibleStaticPath)) {
        return next();
    }

    try {
        const integratedHtml = buildIntegratedIndexHtml();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(integratedHtml);
    } catch (error) {
        console.error('构建服务器详情路径首页失败:', error);
        return res.status(500).send('首页渲染失败');
    }
});

app.use((req, res, next) => {
    if (req.method !== 'GET') {
        return next();
    }

    if (shouldRedirectToUnifiedHome(req.path)) {
        return res.redirect('/');
    }

    return next();
});

// 提供静态文件服务
app.use(express.static(__dirname));

// 添加中间件来解析JSON请求体
app.use(express.json());

app.post('/api/image/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        if (!imageHostBase) {
            return res.status(500).json({ success: false, message: 'Image host is not configured' });
        }

        const uploadUrl = new URL('/api/upload', imageHostBase).toString();
        const formData = new FormData();
        const blob = new Blob([req.file.buffer], {
            type: req.file.mimetype || 'application/octet-stream'
        });
        formData.append('image', blob, req.file.originalname || `upload-${Date.now()}`);

        const response = await fetch(uploadUrl, {
            method: 'POST',
            body: formData
        });

        const responseText = await response.text();
        let payload = null;

        try {
            payload = JSON.parse(responseText);
        } catch (error) {
            return res.status(502).json({ success: false, message: `Image host returned invalid response: ${previewText(responseText)}` });
        }

        if (!response.ok || !payload?.success) {
            return res.status(502).json({
                success: false,
                message: payload?.message || `Image host request failed with status ${response.status}`
            });
        }

        if (payload?.data?.url) {
            payload.data.url = toAbsoluteImageUrl(payload.data.url);
        }

        return res.json(payload);
    } catch (error) {
        console.error('图片上传失败：', error);
        return res.status(500).json({ success: false, message: 'Image upload failed' });
    }
});

app.post('/api/server/upsert', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server/upsert');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        const username = auth.username;
        const avatar = auth.avatar;
        const isSuperAdmin = auth.isSuperAdmin;

        const mode = req.body?.mode === 'edit' ? 'edit' : 'create';
        const originalUrl = normalizeServerHostInput(req.body?.originalUrl || '');
        const serverInput = req.body?.server && typeof req.body.server === 'object' ? req.body.server : {};

        const title = String(serverInput.title || '').trim();
        const text = String(serverInput.text || '').trim();
        const host = normalizeServerHostInput(serverInput.url || '');
        const client = String(serverInput.client || '').trim();

        if (!title || !text || !host) {
            return res.status(400).json({ success: false, message: '缺少必填字段：title、text、url' });
        }

        if (!isValidServerHost(host)) {
            return res.status(400).json({ success: false, message: '服务器地址格式无效' });
        }

        if (!client) {
            return res.status(400).json({ success: false, message: '请至少选择一个客户端' });
        }

        const partData = readPartData();

        const existingIndexByUrl = partData.Servers.findIndex((item) => String(item?.url || '').trim() === host);
        const targetIndex = mode === 'edit'
            ? partData.Servers.findIndex((item) => String(item?.url || '').trim() === (originalUrl || host))
            : -1;

        if (mode === 'create' && existingIndexByUrl >= 0) {
            return res.status(409).json({ success: false, message: '该服务器地址已存在，请使用编辑功能修改' });
        }

        if (mode === 'edit' && targetIndex < 0) {
            return res.status(404).json({ success: false, message: '未找到需要编辑的服务器' });
        }

        if (mode === 'edit' && existingIndexByUrl >= 0 && existingIndexByUrl !== targetIndex) {
            return res.status(409).json({ success: false, message: '新地址已被其他服务器占用' });
        }

        const existingServer = targetIndex >= 0 ? partData.Servers[targetIndex] : null;
        if (mode === 'edit' && existingServer && !isSuperAdmin) {
            const author = String(existingServer.author || '').trim();
            if (!author || author !== username) {
                return res.status(403).json({ success: false, message: '只有该服务器作者或网站超级管理员可以编辑' });
            }
        }

        const nextServer = buildNextServerPayload(existingServer, serverInput, host, username, avatar, {
            allowAllTags: isSuperAdmin,
            nickname: auth.nickname
        });

        if (isSuperAdmin) {
            if (mode === 'create') {
                partData.Servers.push(nextServer);
            } else {
                partData.Servers[targetIndex] = nextServer;
            }

            writePartData(partData);

            console.log(`服务器信息保存成功（upsert）: ${host} [mode=${mode}] [super-admin]`);

            return res.json({
                success: true,
                pending: false,
                mode,
                server: nextServer,
                message: '保存成功'
            });
        }

        const reviewTargetKey = mode === 'edit' ? (originalUrl || host) : host;
        const reviewQueue = readServerReviewQueue();
        const pendingIndex = reviewQueue.findIndex((item) => {
            const sameMode = String(item?.mode || '') === mode;
            const sameTarget = String(item?.targetKey || '').trim() === reviewTargetKey;
            return sameMode && sameTarget;
        });

        if (pendingIndex >= 0) {
            const existingReview = reviewQueue[pendingIndex];
            const submitter = String(existingReview?.submittedBy || '').trim();
            if (submitter && submitter !== username) {
                return res.status(409).json({
                    success: false,
                    message: '该服务器已有待审核请求，请等待超级管理员处理后再提交。'
                });
            }
        }

        const reviewRequest = {
            id: pendingIndex >= 0
                ? String(reviewQueue[pendingIndex]?.id || createReviewRequestId())
                : createReviewRequestId(),
            mode,
            targetKey: reviewTargetKey,
            originalUrl: mode === 'edit' ? (originalUrl || host) : '',
            submittedBy: username,
            submittedAt: Date.now(),
            server: nextServer
        };

        if (pendingIndex >= 0) {
            reviewQueue[pendingIndex] = reviewRequest;
        } else {
            reviewQueue.push(reviewRequest);
        }

        writeServerReviewQueue(reviewQueue);

        console.log(`服务器信息已提交审核: ${host} [mode=${mode}] [by=${username}]`);

        return res.json({
            success: true,
            pending: true,
            mode,
            reviewId: reviewRequest.id,
            server: nextServer,
            message: '提交成功，等待超级管理员审核。'
        });
    } catch (error) {
        console.error('保存服务器信息失败：', error);
        return res.status(500).json({ success: false, message: '保存失败，请稍后重试' });
    }
});

app.delete('/api/server', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        if (!auth.isSuperAdmin) {
            return res.status(403).json({ success: false, message: '仅超级管理员可以删除服务器' });
        }

        const host = normalizeServerCommentTarget(req.query?.host || req.query?.url || req.body?.host || req.body?.url || '');
        if (!host) {
            return res.status(400).json({ success: false, message: '服务器地址无效' });
        }

        const partData = readPartData();
        const targetIndex = partData.Servers.findIndex((item) => normalizeServerCommentTarget(item?.url || '') === host);
        if (targetIndex < 0) {
            return res.status(404).json({ success: false, message: '未找到要删除的服务器' });
        }

        const removedServer = partData.Servers.splice(targetIndex, 1)[0] || {};
        writePartData(partData);

        const commentStore = readServerCommentStore();
        if (Object.prototype.hasOwnProperty.call(commentStore, host)) {
            delete commentStore[host];
            writeServerCommentStore(commentStore);
        }

        const reviewQueue = readServerReviewQueue();
        const nextReviewQueue = reviewQueue.filter((item) => {
            const targetKey = normalizeServerCommentTarget(item?.targetKey || '');
            const originalKey = normalizeServerCommentTarget(item?.originalUrl || '');
            const reviewHost = normalizeServerCommentTarget(item?.server?.url || '');
            return targetKey !== host && originalKey !== host && reviewHost !== host;
        });

        if (nextReviewQueue.length !== reviewQueue.length) {
            writeServerReviewQueue(nextReviewQueue);
        }

        console.log(`服务器已删除: ${host} [by=${auth.username}]`);

        return res.json({
            success: true,
            host,
            server: {
                title: String(removedServer?.title || '').trim(),
                url: String(removedServer?.url || '').trim()
            },
            message: '服务器删除成功'
        });
    } catch (error) {
        console.error('删除服务器失败：', error);
        return res.status(500).json({ success: false, message: '删除服务器失败，请稍后重试' });
    }
});

app.get('/api/server/reviews', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server/reviews');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        if (!auth.isSuperAdmin) {
            return res.status(403).json({ success: false, message: '仅超级管理员可访问管理中心' });
        }

        const requests = readServerReviewQueue()
            .sort((left, right) => (Number(right?.submittedAt) || 0) - (Number(left?.submittedAt) || 0));

        return res.json({
            success: true,
            requests
        });
    } catch (error) {
        console.error('读取待审核列表失败：', error);
        return res.status(500).json({ success: false, message: '读取待审核列表失败，请稍后重试' });
    }
});

app.post('/api/server/reviews/:reviewId/approve', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server/reviews/:reviewId/approve');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        if (!auth.isSuperAdmin) {
            return res.status(403).json({ success: false, message: '仅超级管理员可以审核请求' });
        }

        const reviewId = String(req.params.reviewId || '').trim();
        if (!reviewId) {
            return res.status(400).json({ success: false, message: '缺少审核请求 ID' });
        }

        const reviewQueue = readServerReviewQueue();
        const reviewIndex = reviewQueue.findIndex((item) => String(item?.id || '').trim() === reviewId);
        if (reviewIndex < 0) {
            return res.status(404).json({ success: false, message: '未找到待审核请求' });
        }

        const reviewRequest = reviewQueue[reviewIndex];
        const mode = reviewRequest?.mode === 'edit' ? 'edit' : 'create';
        const draftServer = reviewRequest?.server && typeof reviewRequest.server === 'object'
            ? reviewRequest.server
            : null;

        if (!draftServer) {
            return res.status(400).json({ success: false, message: '待审核数据无效' });
        }

        const host = normalizeServerHostInput(draftServer.url || '');
        const originalUrl = normalizeServerHostInput(reviewRequest?.originalUrl || '');

        if (!host || !isValidServerHost(host)) {
            return res.status(400).json({ success: false, message: '待审核数据中的服务器地址无效' });
        }

        const partData = readPartData();
        const existingIndexByUrl = partData.Servers.findIndex((item) => String(item?.url || '').trim() === host);
        const targetIndex = mode === 'edit'
            ? partData.Servers.findIndex((item) => String(item?.url || '').trim() === (originalUrl || host))
            : -1;

        if (mode === 'create' && existingIndexByUrl >= 0) {
            return res.status(409).json({ success: false, message: '该服务器地址已存在，无法通过创建审核' });
        }

        if (mode === 'edit' && targetIndex < 0) {
            return res.status(404).json({ success: false, message: '原服务器不存在，无法通过编辑审核' });
        }

        if (mode === 'edit' && existingIndexByUrl >= 0 && existingIndexByUrl !== targetIndex) {
            return res.status(409).json({ success: false, message: '新地址已被其他服务器占用，无法通过审核' });
        }

        const existingServer = targetIndex >= 0 ? partData.Servers[targetIndex] : null;
        const gallery = normalizeImageGallery(draftServer.gallery ?? existingServer?.gallery);
        const background = normalizeBackgroundUrl(draftServer.background)
            || normalizeBackgroundUrl(existingServer?.background)
            || gallery[0]
            || '';
        const approvedServer = {
            ...(existingServer || {}),
            title: String(draftServer.title || '').trim(),
            text: String(draftServer.text || '').trim(),
            url: host,
            otherip: normalizePlainObject(draftServer.otherip),
            OnlineCheck: Boolean(draftServer.OnlineCheck),
            type: normalizeServerTypeByRole(existingServer?.type, draftServer.type),
            tip: String(draftServer.tip || ''),
            links: normalizePlainObject(draftServer.links),
            author: existingServer?.author
                ? String(existingServer.author)
                : String(draftServer.author || reviewRequest?.submittedBy || auth.username),
            authorAvatar: normalizeAvatarUrl(draftServer.authorAvatar || existingServer?.authorAvatar || ''),
            category: String(draftServer.category || ''),
            client: String(draftServer.client || ''),
            language: String(draftServer.language || ''),
            version: String(draftServer.version || ''),
            mode: String(draftServer.mode || ''),
            build: String(draftServer.build || ''),
            updatedAt: Date.now(),
            privacy: String(draftServer.privacy || ''),
            time: Number.isFinite(Number(existingServer?.time))
                ? Number(existingServer.time)
                : (Number.isFinite(Number(draftServer.time)) ? Number(draftServer.time) : Date.now()),
            BestTime: String(draftServer.BestTime ?? existingServer?.BestTime ?? ''),
            activities: normalizeServerActivities(draftServer.activities ?? existingServer?.activities),
            background,
            gallery
        };

        if (!approvedServer.title || !approvedServer.text || !approvedServer.url) {
            return res.status(400).json({ success: false, message: '待审核数据缺少必填字段' });
        }

        if (mode === 'create') {
            partData.Servers.push(approvedServer);
        } else {
            partData.Servers[targetIndex] = approvedServer;
        }

        writePartData(partData);

        reviewQueue.splice(reviewIndex, 1);
        writeServerReviewQueue(reviewQueue);

        console.log(`审核通过并发布服务器: ${approvedServer.url} [mode=${mode}] [reviewId=${reviewId}]`);

        return res.json({
            success: true,
            reviewId,
            mode,
            server: approvedServer,
            message: '审核通过并发布成功'
        });
    } catch (error) {
        console.error('审核通过失败：', error);
        return res.status(500).json({ success: false, message: '审核通过失败，请稍后重试' });
    }
});

app.post('/api/server/reviews/:reviewId/reject', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server/reviews/:reviewId/reject');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        if (!auth.isSuperAdmin) {
            return res.status(403).json({ success: false, message: '仅超级管理员可以审核请求' });
        }

        const reviewId = String(req.params.reviewId || '').trim();
        if (!reviewId) {
            return res.status(400).json({ success: false, message: '缺少审核请求 ID' });
        }

        const reviewQueue = readServerReviewQueue();
        const reviewIndex = reviewQueue.findIndex((item) => String(item?.id || '').trim() === reviewId);
        if (reviewIndex < 0) {
            return res.status(404).json({ success: false, message: '未找到待审核请求' });
        }

        reviewQueue.splice(reviewIndex, 1);
        writeServerReviewQueue(reviewQueue);

        console.log(`审核拒绝服务器提交: [reviewId=${reviewId}]`);

        return res.json({
            success: true,
            reviewId,
            message: '已拒绝该提交'
        });
    } catch (error) {
        console.error('审核拒绝失败：', error);
        return res.status(500).json({ success: false, message: '审核拒绝失败，请稍后重试' });
    }
});

app.get('/api/server/comments', (req, res) => {
    try {
        const host = normalizeServerCommentTarget(req.query?.host || req.query?.url || '');
        if (!host) {
            return res.status(400).json({ success: false, message: '服务器地址无效' });
        }

        const commentStore = readServerCommentStore();
        const comments = normalizeServerCommentList(commentStore[host]);
        comments.sort((left, right) => (Number(right?.createdAt) || 0) - (Number(left?.createdAt) || 0));

        return res.json({
            success: true,
            host,
            comments,
            summary: summarizeServerComments(comments)
        });
    } catch (error) {
        console.error('读取服务器评论失败：', error);
        return res.status(500).json({ success: false, message: '读取评论失败，请稍后重试' });
    }
});

app.post('/api/server/comments', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server/comments');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        const host = normalizeServerCommentTarget(req.body?.host || req.body?.url || '');
        if (!host) {
            return res.status(400).json({ success: false, message: '服务器地址无效' });
        }

        const content = String(req.body?.content || req.body?.comment || '').trim();
        if (!content) {
            return res.status(400).json({ success: false, message: '评论内容不能为空' });
        }

        if (content.length > 500) {
            return res.status(400).json({ success: false, message: '评论内容不能超过 500 字' });
        }

        const server = findServerByHost(host);
        if (!server) {
            return res.status(404).json({ success: false, message: '未找到该服务器，无法发布评论' });
        }

        const requesterKey = normalizeUsernameKey(auth.username);
        const authorKey = normalizeUsernameKey(server?.author || '');
        if (requesterKey && authorKey && requesterKey === authorKey) {
            return res.status(403).json({ success: false, message: '服务器作者不能评论，但可以回复其他玩家评论' });
        }

        const commentStore = readServerCommentStore();
        const hostComments = normalizeServerCommentList(commentStore[host]);
        const existingIndex = hostComments.findIndex((item) => normalizeUsernameKey(item?.usernameKey || item?.username) === requesterKey);

        let action = 'create';
        let targetComment = null;

        if (existingIndex >= 0) {
            action = 'follow-up';
            const existingComment = hostComments[existingIndex];
            const nextFollowUps = Array.isArray(existingComment.followUps)
                ? existingComment.followUps.slice()
                : [];

            nextFollowUps.push({
                id: createServerCommentId(),
                content,
                createdAt: Date.now()
            });

            if (nextFollowUps.length > 200) {
                nextFollowUps.splice(0, nextFollowUps.length - 200);
            }

            hostComments[existingIndex] = {
                ...existingComment,
                followUps: nextFollowUps
            };

            targetComment = hostComments[existingIndex];
        } else {
            const rating = Number(req.body?.rating);
            if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
                return res.status(400).json({ success: false, message: '首次评论必须提供 1 到 5 分评分' });
            }

            const newComment = {
                id: createServerCommentId(),
                ...buildCommentAuthor(auth, normalizeUsernameKey),
                content,
                rating: Math.round(Math.min(5, Math.max(1, rating)) * 10) / 10,
                createdAt: Date.now(),
                followUps: [],
                replies: []
            };

            hostComments.push(newComment);
            targetComment = newComment;
        }

        if (hostComments.length > 500) {
            hostComments.splice(0, hostComments.length - 500);
        }

        commentStore[host] = hostComments;
        writeServerCommentStore(commentStore);

        const sortedComments = normalizeServerCommentList(hostComments)
            .sort((left, right) => (Number(right?.createdAt) || 0) - (Number(left?.createdAt) || 0));

        return res.json({
            success: true,
            action,
            message: action === 'follow-up' ? '追评发布成功' : '评论发布成功',
            comment: targetComment,
            comments: sortedComments,
            summary: summarizeServerComments(hostComments)
        });
    } catch (error) {
        console.error('发布服务器评论失败：', error);
        return res.status(500).json({ success: false, message: '发布评论失败，请稍后重试' });
    }
});

app.delete('/api/server/comments/:commentId', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server/comments/:commentId');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        if (!auth.isSuperAdmin) {
            return res.status(403).json({ success: false, message: '仅超级管理员可以删除评论' });
        }

        const commentId = String(req.params.commentId || '').trim();
        if (!commentId) {
            return res.status(400).json({ success: false, message: '缺少评论 ID' });
        }

        const host = normalizeServerCommentTarget(req.query?.host || req.query?.url || req.body?.host || req.body?.url || '');
        if (!host) {
            return res.status(400).json({ success: false, message: '服务器地址无效' });
        }

        const commentStore = readServerCommentStore();
        const hostComments = normalizeServerCommentList(commentStore[host]);
        const targetIndex = hostComments.findIndex((item) => String(item?.id || '').trim() === commentId);
        if (targetIndex < 0) {
            return res.status(404).json({ success: false, message: '未找到要删除的评论' });
        }

        hostComments.splice(targetIndex, 1);

        if (hostComments.length > 0) {
            commentStore[host] = hostComments;
        } else {
            delete commentStore[host];
        }

        writeServerCommentStore(commentStore);

        const sortedComments = normalizeServerCommentList(hostComments)
            .sort((left, right) => (Number(right?.createdAt) || 0) - (Number(left?.createdAt) || 0));

        console.log(`评论已删除: [host=${host}] [commentId=${commentId}] [by=${auth.username}]`);

        return res.json({
            success: true,
            host,
            commentId,
            comments: sortedComments,
            summary: summarizeServerComments(hostComments),
            message: '评论删除成功'
        });
    } catch (error) {
        console.error('删除评论失败：', error);
        return res.status(500).json({ success: false, message: '删除评论失败，请稍后重试' });
    }
});

app.post('/api/server/comments/:commentId/replies', async (req, res) => {
    try {
        const auth = await authenticateRequestUser(req, '/api/server/comments/:commentId/replies');
        if (!auth.success) {
            return res.status(auth.status).json({ success: false, message: auth.message });
        }

        const commentId = String(req.params.commentId || '').trim();
        if (!commentId) {
            return res.status(400).json({ success: false, message: '缺少评论 ID' });
        }

        const host = normalizeServerCommentTarget(req.body?.host || req.body?.url || '');
        if (!host) {
            return res.status(400).json({ success: false, message: '服务器地址无效' });
        }

        const content = String(req.body?.content || '').trim();
        if (!content) {
            return res.status(400).json({ success: false, message: '回复内容不能为空' });
        }

        if (content.length > 500) {
            return res.status(400).json({ success: false, message: '回复内容不能超过 500 字' });
        }

        const server = findServerByHost(host);
        if (!server) {
            return res.status(404).json({ success: false, message: '未找到该服务器，无法回复评论' });
        }

        const requesterKey = normalizeUsernameKey(auth.username);
        const authorKey = normalizeUsernameKey(server?.author || '');
        if (!authorKey || requesterKey !== authorKey) {
            return res.status(403).json({ success: false, message: '仅服务器作者可以回复评论' });
        }

        const commentStore = readServerCommentStore();
        const hostComments = normalizeServerCommentList(commentStore[host]);
        const targetIndex = hostComments.findIndex((item) => String(item?.id || '').trim() === commentId);
        if (targetIndex < 0) {
            return res.status(404).json({ success: false, message: '未找到要回复的评论' });
        }

        const targetComment = hostComments[targetIndex];
        if (normalizeUsernameKey(targetComment?.usernameKey || targetComment?.username) === requesterKey) {
            return res.status(400).json({ success: false, message: '作者不能回复自己的评论' });
        }

        const replies = Array.isArray(targetComment.replies)
            ? targetComment.replies.slice()
            : [];
        replies.push({
            id: createServerCommentId(),
            ...buildCommentAuthor(auth, normalizeUsernameKey),
            content,
            createdAt: Date.now()
        });

        if (replies.length > 200) {
            replies.splice(0, replies.length - 200);
        }

        hostComments[targetIndex] = {
            ...targetComment,
            replies
        };

        commentStore[host] = hostComments;
        writeServerCommentStore(commentStore);

        const sortedComments = normalizeServerCommentList(hostComments)
            .sort((left, right) => (Number(right?.createdAt) || 0) - (Number(left?.createdAt) || 0));

        return res.json({
            success: true,
            message: '回复成功',
            comments: sortedComments,
            summary: summarizeServerComments(hostComments)
        });
    } catch (error) {
        console.error('回复评论失败：', error);
        return res.status(500).json({ success: false, message: '回复失败，请稍后重试' });
    }
});

// 代理登录端点
app.get('/api/login', (req, res) => {
    // 获取查询参数中的用户名和密码
    const { name, password } = req.query;
    
    // 检查参数是否存在
    if (!name || !password) {
        return res.status(400).json({ error: '缺少用户名或密码参数' });
    }
    
    // 构造查询字符串
    const queryString = `name=${encodeURIComponent(name)}&password=${encodeURIComponent(password)}`;
    
    // 构造目标URL
    const targetUrl = `http://launcher.bloret.net/api/login?${queryString}`;
    
    // 发起HTTP请求到目标服务器
    http.get(targetUrl, (response) => {
        let data = '';
        
        // 接收响应数据
        response.on('data', (chunk) => {
            data += chunk;
        });
        
        // 响应结束时处理数据
        response.on('end', () => {
            // 设置CORS头部
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');
            
            // 清理ANSI转义序列
            const cleanedData = data.replace(/\u001b\[[0-9;]*m/g, '');

            try {
                const parsed = JSON.parse(cleanedData);
                const isAuthenticated = Boolean(parsed?.status || parsed?.success);
                const resolvedUsername = String(parsed?.name || parsed?.username || name || '').trim();
                parsed.admin = isAuthenticated && isConfiguredSuperAdmin(resolvedUsername);
                return res.json(parsed);
            } catch (error) {
                return res.send(cleanedData);
            }
        });
    }).on('error', (err) => {
        console.error('访问外部API时发生错误:', err);
        res.status(500).json({ error: '内部服务器错误' });
    });
});

// AI搜索端点
app.post('/api/ai/search', (req, res) => {
    try {
        console.log('收到AI搜索请求');
        
        // 获取请求体中的文本内容
        const { text } = req.body;
        
        if (!text) {
            console.log('请求缺少text字段');
            return res.status(400).json({ error: '缺少text字段' });
        }
        
        console.log('请求内容长度:', text.length);
        
        // 构造请求数据
        const postData = JSON.stringify({
            name: "",
            text: text
        });
        
        console.log(`正在向AI接口发送搜索请求`);
        console.log(`请求内容长度: ${text.length}`);
        
        // 配置请求选项 - 使用HTTP和正确的端口2
        const options = {
            hostname: 'pcfs.eno.ink',
            port: 2, // 使用正确的端口
            path: '/api/ai/post',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'key': 'RHEDARANDDETRITALSERVERPCFSpiecesandcloudflashserver87654321',
                'model': 'ChaFuWang-ServerSearch'
            }
        };
        
        console.log(`请求配置:`, options);
        
        // 发送HTTP请求（不是HTTPS）
        const request = http.request(options, (response) => {
            let data = '';
            
            response.on('data', (chunk) => {
                data += chunk;
            });
            
            response.on('end', () => {
                console.log(`AI接口响应状态码: ${response.statusCode}`);
                console.log(`AI接口响应头: ${JSON.stringify(response.headers)}`);
                
                // 检查响应状态码
                if (response.statusCode !== 200) {
                    console.error(`AI接口请求失败，状态码: ${response.statusCode}`);
                    console.error(`响应内容: ${data}`);
                    return res.status(response.statusCode).json({ error: `AI接口请求失败，状态码: ${response.statusCode}` });
                }
                
                // 检查响应内容是否为JSON格式
                if (data.startsWith('<!DOCTYPE') || data.startsWith('<html')) {
                    console.error(`AI接口返回了HTML而非JSON`);
                    console.error(`响应内容预览: ${data.substring(0, 200)}...`);
                    return res.status(500).json({ error: 'AI接口返回了HTML页面而非JSON数据' });
                }
                
                try {
                    const result = JSON.parse(data);
                    console.log(`AI接口响应数据: ${JSON.stringify(result)}`);
                    
                    if (result.content) {
                        // 返回content字段
                        console.log('成功获取AI内容，返回给前端');
                        res.json({ content: result.content });
                    } else {
                        console.error(`AI接口返回数据格式不正确，缺少content字段: ${JSON.stringify(result)}`);
                        res.status(500).json({ error: 'AI接口返回数据格式不正确' });
                    }
                } catch (err) {
                    console.error(`解析AI接口响应失败: ${err.message}`);
                    console.error(`响应内容: ${data}`);
                    res.status(500).json({ error: `解析AI接口响应失败: ${err.message}` });
                }
            });
        });
        
        request.on('error', (err) => {
            console.error(`请求AI接口失败: ${err.message}`);
            res.status(500).json({ error: `请求AI接口失败: ${err.message}` });
        });
        
        // 写入请求数据
        request.write(postData);
        request.end();
        console.log('请求已发送至AI接口');
    } catch (err) {
        console.error(`处理AI搜索请求时发生错误: ${err.message}`);
        res.status(500).json({ error: `处理AI搜索请求时发生错误: ${err.message}` });
    }
});
// 添加新服务器信息的API端点
app.post('/api/post-server', (req, res) => {
    try {
        console.log('收到添加服务器请求');
        
        // 获取请求头中的用户名和密码
        const { username, password } = req.headers;
        
        if (!username || !password) {
            console.log('请求缺少用户名或密码');
            return res.status(400).json({ error: '缺少用户名或密码' });
        }
        
        // 验证用户凭据 - 使用与登录相同的验证方法
        const loginData = JSON.stringify({
            name: username,
            password: password
        });
        
        const loginQuery = `name=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        const loginTargetUrl = `http://launcher.bloret.net/api/login?${loginQuery}`;
        
        http.get(loginTargetUrl, (loginResponse) => {
            let loginResult = '';
            
            loginResponse.on('data', (chunk) => {
                loginResult += chunk;
            });
            
            loginResponse.on('end', () => {
                try {
                    const parsedLogin = parseLauncherLoginResult(loginResult);
                    if (!parsedLogin.ok || !parsedLogin.data) {
                        return res.status(502).json({
                            error: '用户验证服务异常',
                            message: `验证服务返回异常响应：${previewText(parsedLogin.cleaned || '[empty]')}`
                        });
                    }

                    const loginResultData = parsedLogin.data;
                    
                    // 检查登录结果 - 适配不同的API响应格式
                    // 有些API使用status字段，有些使用success字段
                    const isAuthenticated = loginResultData.status || loginResultData.success;
                    
                    if (!isAuthenticated) {
                        console.log('用户验证失败:', loginResultData);
                        return res.status(401).json({ 
                            error: '用户验证失败',
                            message: loginResultData.message || '用户名或密码错误'
                        });
                    }
                    
                    // 获取请求体数据
                    const requestData = req.body;
                    
                    // 验证必需字段
                    if (!requestData.title || !requestData.text || !requestData.url) {
                        console.log('缺少必需字段');
                        return res.status(400).json({ error: '缺少必需字段: title, text, url' });
                    }

                    const partPath = path.join(__dirname, 'data/part.json');
                    let existingServer = null;
                    try {
                        if (fs.existsSync(partPath)) {
                            const partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
                            const servers = Array.isArray(partData?.Servers) ? partData.Servers : [];
                            const targetUrl = String(requestData.url || '').trim();
                            existingServer = servers.find((server) => String(server?.url || '').trim() === targetUrl) || null;
                        }
                    } catch (readError) {
                        console.error('读取服务器数据失败:', readError);
                        return res.status(500).json({ error: '读取服务器数据失败' });
                    }

                    const isAdmin = isConfiguredSuperAdmin(username);
                    if (existingServer && !isAdmin) {
                        const author = String(existingServer.author || '').trim();
                        if (!author || author !== username) {
                            return res.status(403).json({ error: '只有该服务器作者或网站超级管理员可以编辑' });
                        }
                    }
                    
                    // 获取当前时间戳
                    const currentTime = Number.isFinite(Number(existingServer?.time)) ? Number(existingServer.time) : Date.now();
                    
                    // 构造服务器数据
                    const serverData = {
                        title: requestData.title,
                        text: requestData.text,
                        url: requestData.url,
                        otherip: requestData.otherip || {},
                        OnlineCheck: requestData.OnlineCheck || false,
                        type: normalizeServerTypeByRole(existingServer?.type, requestData.type, { allowAllTags: isAdmin }),
                        tip: requestData.tip || "",
                        links: requestData.links || {},
                        author: existingServer?.author ? String(existingServer.author) : username,
                        updatedAt: Date.now(),
                        time: currentTime,
                        BestTime: ""
                    };
                    
                    // 将数据临时存入 checkingpost.json
                    const checkingPostPath = path.join(__dirname, 'checkingpost.json');
                    fs.writeFileSync(checkingPostPath, JSON.stringify(serverData, null, 2));
                    console.log('服务器数据已临时存入 checkingpost.json');
                    
                    // 发送 webhook 请求到飞书
                    const webhookUrl = 'https://www.feishu.cn/flow/api/trigger-webhook/b3fa47ab05ed738ab43bfa84399cf6cc';
                    const webhookData = JSON.stringify({
                        server: serverData
                    });
                    
                    const webhookOptions = {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(webhookData)
                        }
                    };
                    
                    const webhookReq = https.request(webhookUrl, webhookOptions, (webhookRes) => {
                        let webhookResponse = '';
                        
                        webhookRes.on('data', (chunk) => {
                            webhookResponse += chunk;
                        });
                        
                        webhookRes.on('end', () => {
                            console.log('Webhook 请求发送成功，响应状态码:', webhookRes.statusCode);
                            
                            // // 读取现有的data/part.json文件
                            // const partPath = path.join(__dirname, 'data/part.json');
                            // let partData = {};
                            
                            // if (fs.existsSync(partPath)) {
                            //     partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
                            // }
                            
                            // // 确保Servers数组存在
                            // if (!partData.Servers) {
                            //     partData.Servers = [];
                            // }
                            
                            // // 检查是否已存在相同URL的服务器
                            // const existingServerIndex = partData.Servers.findIndex(server => server.url === requestData.url);
                            
                            // if (existingServerIndex >= 0) {
                            //     // 更新现有服务器信息
                            //     partData.Servers[existingServerIndex] = serverData;
                            // } else {
                            //     // 添加新服务器
                            //     partData.Servers.push(serverData);
                            // }
                            
                            // // 保存更新后的数据到data/part.json
                            // fs.writeFileSync(partPath, JSON.stringify(partData, null, 2));
                            
                            // console.log(`服务器信息已保存: ${requestData.title}`);
                            // res.json({ success: true, message: '服务器信息保存成功' });
                        });
                    });
                    
                    webhookReq.on('error', (err) => {
                        console.error('发送 webhook 请求时发生错误:', err);
                        // 即使 webhook 发送失败，仍然保存服务器信息
                        saveServerInfo(requestData, serverData, res);
                    });
                    
                    webhookReq.write(webhookData);
                    webhookReq.end();
                    
                } catch (err) {
                    console.error('处理用户验证响应时发生错误:', err);
                    res.status(500).json({ error: '处理用户验证响应时发生错误' });
                }
            });
        }).on('error', (err) => {
            console.error('验证用户凭据时发生错误:', err);
            res.status(500).json({ error: '验证用户凭据时发生错误' });
        });
    } catch (err) {
        console.error('处理添加服务器请求时发生错误:', err);
        res.status(500).json({ error: '处理添加服务器请求时发生错误' });
    }
});

// 保存服务器信息的辅助函数
function saveServerInfo(requestData, serverData, res) {
    try {
        // 读取现有的data/part.json文件
        const partPath = path.join(__dirname, 'data/part.json');
        let partData = {};
        
        if (fs.existsSync(partPath)) {
            partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
        }
        
        // 确保Servers数组存在
        if (!partData.Servers) {
            partData.Servers = [];
        }
        
        // 检查是否已存在相同URL的服务器
        const existingServerIndex = partData.Servers.findIndex(server => server.url === requestData.url);
        
        if (existingServerIndex >= 0) {
            // 更新现有服务器信息
            partData.Servers[existingServerIndex] = serverData;
        } else {
            // 添加新服务器
            partData.Servers.push(serverData);
        }
        
        // 保存更新后的数据到data/part.json
        fs.writeFileSync(partPath, JSON.stringify(partData, null, 2));
        
        console.log(`服务器信息已保存: ${requestData.title}`);
        if (res) {
            res.json({ success: true, message: '服务器信息保存成功' });
        }
    } catch (err) {
        console.error('保存服务器信息时发生错误:', err);
        if (res) {
            res.status(500).json({ error: '保存服务器信息时发生错误' });
        }
    }
}

// 添加用于存储服务器历史数据的文件路径
const SERVER_HISTORY_FILE = path.join(__dirname, 'data', 'server_history.json');

// 提供服务器历史数据的API端点
app.get('/server-history/:serverUrl', (req, res) => {
    try {
        const serverUrl = decodeURIComponent(req.params.serverUrl);
        
        // 检查历史数据文件是否存在
        if (!fs.existsSync(SERVER_HISTORY_FILE)) {
            return res.json([]);
        }
        
        // 读取历史数据
        const history = JSON.parse(fs.readFileSync(SERVER_HISTORY_FILE, 'utf8'));
        
        // 返回特定服务器的历史数据
        const serverHistory = history[serverUrl] || [];
        
        // 按时间排序
        serverHistory.sort((a, b) => a.timestamp - b.timestamp);
        
        res.json(serverHistory);
    } catch (err) {
        console.error('读取服务器历史数据时发生错误:', err);
        res.status(500).json({ error: '读取服务器历史数据失败' });
    }
});
// 读取服务器列表
function getServerList() {
    try {
        const partData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/part.json'), 'utf8'));
        const servers = [];
        
        // 遍历所有板块中的服务器
        Object.values(partData).forEach(section => {
            if (Array.isArray(section)) {
                section.forEach(server => {
                    if (server.url && !servers.includes(server.url)) {
                        servers.push(server.url);
                    }
                });
            }
        });
        
        return servers;
    } catch (err) {
        console.error('读取服务器列表时发生错误:', err);
        return [];
    }
}

// 获取单个服务器状态（带重试机制）
async function getServerStatus(serverUrl) {
    let attempts = 0;
    const maxAttempts = 5;
    const retryDelay = 10000; // 10秒
    
    while (attempts < maxAttempts) {
        try {
            const result = await getServerStatusAttempt(serverUrl);
            return result;
        } catch (err) {
            attempts++;
            console.error(`获取服务器 ${serverUrl} 数据时发生错误 (尝试 ${attempts}/${maxAttempts}):`, err.message);
            
            if (attempts < maxAttempts) {
                // 等待10秒后重试
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
                // 所有重试都失败了，抛出错误
                throw new Error(`服务器 ${serverUrl} 在 ${maxAttempts} 次尝试后仍然无法访问`);
            }
        }
    }
}

// 单次获取服务器状态的尝试
function getServerStatusAttempt(serverUrl) {
    return new Promise((resolve, reject) => {
        const targetUrl = `https://api.mcsrvstat.us/3/${encodeURIComponent(serverUrl)}`;
        
        // 添加请求选项，包括User-Agent
        const options = {
            hostname: 'api.mcsrvstat.us',
            port: 443,
            path: `/3/${encodeURIComponent(serverUrl)}`,
            method: 'GET',
            headers: {
                'User-Agent': 'chafuwang-server-monitor/1.0 (https://github.com/chafuwang)'
            }
        };
        
        const req = https.get(options, (response) => {
            let data = '';
            
            // 设置编码
            response.setEncoding('utf8');
            
            response.on('data', (chunk) => {
                data += chunk;
            });
            
            response.on('end', () => {
                try {
                    // 检查响应状态码
                    if (response.statusCode !== 200) {
                        console.error(`API请求失败，状态码 ${response.statusCode}，服务器: ${serverUrl}`);
                        console.error('响应数据:', data);
                        reject(new Error(`API请求失败，状态码 ${response.statusCode}`));
                        return;
                    }
                    
                    // 检查返回的数据是否为有效的JSON
                    if (!data || data.trim() === '') {
                        reject(new Error('来自服务器的空响应'));
                        return;
                    }
                    
                    // 检查是否包含错误信息
                    if (data.startsWith('Your')) {
                        console.error(`速率限制或错误响应，服务器: ${serverUrl}:`, data);
                        reject(new Error(`API错误: ${data.substring(0, 100)}...`));
                        return;
                    }
                    
                    const jsonData = JSON.parse(data);
                    
                    // 提取MOTD信息
                    let motd = '';
                    if (jsonData.motd && jsonData.motd.clean) {
                        motd = jsonData.motd.clean.join(' ');
                    }
                    
                    resolve({
                        url: serverUrl,
                        timestamp: Date.now(),
                        online: jsonData.online || false,
                        players: jsonData.players ? {
                            online: jsonData.players.online || 0,
                            max: jsonData.players.max || 0
                        } : { online: 0, max: 0 },
                        motd: motd
                    });
                } catch (err) {
                    console.error(`解析服务器 ${serverUrl} 的JSON响应时发生错误:`, data);
                    reject(err);
                }
            });
        });
        
        req.on('error', (err) => {
            reject(err);
        });
        
        // 设置超时
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('请求超时'));
        });
    });
}

// 保存服务器历史数据
function saveServerHistory(historyData) {
    try {
        let history = {};
        if (fs.existsSync(SERVER_HISTORY_FILE)) {
            history = JSON.parse(fs.readFileSync(SERVER_HISTORY_FILE, 'utf8'));
        }
        
        // 添加新数据
        history[historyData.url] = history[historyData.url] || [];
        history[historyData.url].push({
            timestamp: historyData.timestamp,
            online: historyData.online,
            players: historyData.players
        });
        
        // 只保留30天内的数据
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        history[historyData.url] = history[historyData.url].filter(record => 
            record.timestamp > thirtyDaysAgo
        );
        
        // 如果单个服务器记录超过100个，只保留最新的100个
        if (history[historyData.url].length > 100) {
            // 按时间戳排序，保留最新的100个记录
            history[historyData.url].sort((a, b) => b.timestamp - a.timestamp);
            history[historyData.url] = history[historyData.url].slice(0, 100);
            // 重新按时间顺序排序
            history[historyData.url].sort((a, b) => a.timestamp - b.timestamp);
        }
        
        fs.writeFileSync(SERVER_HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (err) {
        console.error('保存服务器历史数据时发生错误:', err);
    }
}

// 检查服务器是否24小时及以上不在线
function checkAndMarkOfflineServers() {
    try {
        if (!fs.existsSync(SERVER_HISTORY_FILE)) {
            return;
        }
        
        const history = JSON.parse(fs.readFileSync(SERVER_HISTORY_FILE, 'utf8'));
        const partData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/part.json'), 'utf8'));
        
        // 获取所有服务器URL
        const allServers = [];
        Object.values(partData).forEach(section => {
            if (Array.isArray(section)) {
                section.forEach(server => {
                    if (server.url && !allServers.includes(server.url)) {
                        allServers.push(server.url);
                    }
                });
            }
        });
        
        // 检查每个服务器
        allServers.forEach(serverUrl => {
            const serverHistory = history[serverUrl] || [];
            if (serverHistory.length > 0) {
                // 获取最新的记录
                const latestRecord = serverHistory[serverHistory.length - 1];
                
                // 如果服务器当前离线，检查是否已经离线24小时以上
                if (!latestRecord.online) {
                    // 查找最近一次在线的记录
                    const lastOnlineRecord = serverHistory.slice().reverse().find(record => record.online);
                    
                    if (lastOnlineRecord) {
                        const offlineDuration = Date.now() - lastOnlineRecord.timestamp;
                        const twentyFourHours = 24 * 60 * 60 * 1000;
                        
                        // 如果离线时间超过24小时，标记服务器
                        if (offlineDuration >= twentyFourHours) {
                            markServerAsLongOffline(serverUrl);
                        }
                    } else {
                        // 如果从未在线过，检查第一条记录的时间
                        const firstRecord = serverHistory[0];
                        const offlineDuration = Date.now() - firstRecord.timestamp;
                        const twentyFourHours = 24 * 60 * 60 * 1000;
                        
                        if (offlineDuration >= twentyFourHours) {
                            markServerAsLongOffline(serverUrl);
                        }
                    }
                } else {
                    // 如果服务器在线，取消标记
                    unmarkServerAsLongOffline(serverUrl);
                }
            }
        });
    } catch (err) {
        console.error('检查服务器离线状态时发生错误:', err);
    }
}

// 标记服务器为长期离线
function markServerAsLongOffline(serverUrl) {
    try {
        const partPath = path.join(__dirname, 'data/part.json');
        const partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
        
        let updated = false;
        
        // 查找并更新服务器信息
        Object.values(partData).forEach(section => {
            if (Array.isArray(section)) {
                section.forEach(server => {
                    if (server.url === serverUrl) {
                        // 检查是否已经有24小时离线标签
                        if (!server.type || !server.type.includes('24小时及以上不在线')) {
                            if (!server.type) {
                                server.type = [];
                            }
                            server.type.push('24小时及以上不在线');
                            updated = true;
                        }
                    }
                });
            }
        });
        
        // 如果有更新，保存文件
        if (updated) {
            fs.writeFileSync(partPath, JSON.stringify(partData, null, 2));
            console.log(`服务器 ${serverUrl} 已标记为"24小时及以上不在线"`);
        }
    } catch (err) {
        console.error(`标记服务器 ${serverUrl} 为长期离线时发生错误:`, err);
    }
}

// 取消标记服务器为长期离线
function unmarkServerAsLongOffline(serverUrl) {
    try {
        const partPath = path.join(__dirname, 'data/part.json');
        const partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
        
        let updated = false;
        
        // 查找并更新服务器信息
        Object.values(partData).forEach(section => {
            if (Array.isArray(section)) {
                section.forEach(server => {
                    if (server.url === serverUrl) {
                        // 检查是否有24小时离线标签
                        if (server.type && server.type.includes('24小时及以上不在线')) {
                            server.type = server.type.filter(tag => tag !== '24小时及以上不在线');
                            updated = true;
                        }
                    }
                });
            }
        });
        
        // 如果有更新，保存文件
        if (updated) {
            fs.writeFileSync(partPath, JSON.stringify(partData, null, 2));
            console.log(`服务器 ${serverUrl} 的"24小时及以上不在线"标记已移除`);
        }
    } catch (err) {
        console.error(`取消标记服务器 ${serverUrl} 为长期离线时发生错误:`, err);
    }
}

// 向AI接口发送请求获取服务器最佳游戏时间
async function getServerBestTime(server) {
    return new Promise((resolve, reject) => {
        // 构造请求内容
        let context = `该服务器信息: ${server.title}(${server.url})`;
        
        // 获取服务器MOTD信息
        getServerStatusAttempt(server.url)
            .then(status => {
                if (status && status.online) {
                    context += `，该服务器MOTD: ${status.motd || '无MOTD信息'}`;
                } else {
                    context += '，该服务器MOTD: 无法获取（服务器可能离线）';
                }
                
                // 获取服务器历史24小时人数
                processServerHistoryAndSendRequest();
            })
            .catch(err => {
                // 即使获取MOTD失败也继续处理
                context += `，该服务器MOTD: 无法获取（错误：${err.message}）`;
                processServerHistoryAndSendRequest();
            });
            
        // 处理服务器历史数据并发送请求的函数
        function processServerHistoryAndSendRequest() {
            try {
                if (fs.existsSync(SERVER_HISTORY_FILE)) {
                    const history = JSON.parse(fs.readFileSync(SERVER_HISTORY_FILE, 'utf8'));
                    const serverHistory = history[server.url] || [];
                    
                    // 过滤出最近24小时的记录
                    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
                    const recentHistory = serverHistory.filter(record => 
                        record.timestamp > twentyFourHoursAgo
                    );
                    
                    context += `，该服务器历史24小时人数: ${JSON.stringify(recentHistory)}`;
                } else {
                    context += '，该服务器历史24小时人数: 无历史数据';
                }
                
                // 构造请求数据
                const postData = JSON.stringify({
                    name: "",
                    text: context
                });
                
                console.log(`正在向AI接口发送请求，服务器: ${server.url}`);
                console.log(`请求内容: ${context}`);
                
                // 配置请求选项 - 使用HTTP和正确的端口2
                const options = {
                    hostname: 'pcfs.eno.ink',
                    port: 2, // 使用正确的端口
                    path: '/api/ai/post',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'key': 'RHEDARANDDETRITALSERVERPCFSpiecesandcloudflashserver87654321',
                        'model': 'ChaFuWang-BestTime'
                    }
                };
                
                // 发送HTTP请求（不是HTTPS）
                const req = http.request(options, (res) => {
                    let data = '';
                    
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    res.on('end', () => {
                        console.log(`AI接口响应状态码: ${res.statusCode}`);
                        console.log(`AI接口响应头: ${JSON.stringify(res.headers)}`);
                        
                        // 检查响应状态码
                        if (res.statusCode !== 200) {
                            console.error(`AI接口请求失败，状态码: ${res.statusCode}，服务器: ${server.url}`);
                            console.error(`响应内容: ${data}`);
                            return reject(new Error(`AI接口请求失败，状态码: ${res.statusCode}`));
                        }
                        
                        // 检查响应内容是否为JSON格式
                        if (data.startsWith('<!DOCTYPE') || data.startsWith('<html')) {
                            console.error(`AI接口返回了HTML而非JSON，服务器: ${server.url}`);
                            console.error(`响应内容预览: ${data.substring(0, 200)}...`);
                            return reject(new Error('AI接口返回了HTML页面而非JSON数据'));
                        }
                        
                        try {
                            const result = JSON.parse(data);
                            console.log(`AI接口响应数据: ${JSON.stringify(result)}`);
                            
                            if (result.content) {
                                resolve(result.content);
                            } else {
                                console.error(`AI接口返回数据格式不正确，缺少content字段: ${JSON.stringify(result)}`);
                                reject(new Error('AI接口返回数据格式不正确'));
                            }
                        } catch (err) {
                            console.error(`解析AI接口响应失败: ${err.message}`);
                            console.error(`响应内容: ${data}`);
                            reject(new Error(`解析AI接口响应失败: ${err.message}`));
                        }
                    });
                });
                
                req.on('error', (err) => {
                    console.error(`请求AI接口失败: ${err.message}`);
                    reject(new Error(`请求AI接口失败: ${err.message}`));
                });
                
                
                // 写入请求数据
                req.write(postData);
                req.end();
            } catch (err) {
                console.error(`获取服务器历史数据失败: ${err.message}`);
                reject(new Error(`获取服务器历史数据失败: ${err.message}`));
            }
        }
    });
}

// 保存服务器最佳游戏时间到data/part.json
function saveServerBestTime(serverUrl, bestTime) {
    try {
        const partPath = path.join(__dirname, 'data/part.json');
        const partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
        
        let updated = false;
        
        // 查找并更新服务器信息
        Object.values(partData).forEach(section => {
            if (Array.isArray(section)) {
                section.forEach(server => {
                    if (server.url === serverUrl) {
                        server.BestTime = bestTime;
                        updated = true;
                    }
                });
            }
        });
        
        // 如果有更新，保存文件
        if (updated) {
            fs.writeFileSync(partPath, JSON.stringify(partData, null, 2));
            console.log(`服务器 ${serverUrl} 的最佳游戏时间已更新: ${bestTime}`);
        }
    } catch (err) {
        console.error(`保存服务器 ${serverUrl} 最佳游戏时间时发生错误:`, err);
    }
}

// 获取所有服务器并请求AI接口获取最佳游戏时间
async function collectServerBestTimes() {
    console.log('开始收集服务器最佳游戏时间...');
    
    try {
        const partData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/part.json'), 'utf8'));
        const servers = [];
        
        // 收集所有服务器
        Object.values(partData).forEach(section => {
            if (Array.isArray(section)) {
                section.forEach(server => {
                    if (server.url) {
                        servers.push(server);
                    }
                });
            }
        });
        
        // 逐个处理每个服务器
        for (let i = 0; i < servers.length; i++) {
            const server = servers[i];
            try {
                console.log(`正在获取服务器 ${server.url} 的最佳游戏时间...`);
                const bestTime = await getServerBestTime(server);
                saveServerBestTime(server.url, bestTime);
                console.log(`服务器 ${server.url} 的最佳游戏时间获取成功`);
            } catch (err) {
                console.error(`获取服务器 ${server.url} 最佳游戏时间时发生错误:`, err.message);
            }
            
            // 等待1分钟再处理下一个服务器
            if (i < servers.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 60 * 1000));
            }
        }
        
        // 显示下次执行时间
        const nextExecution = new Date(Date.now() + 24 * 60 * 60 * 1000);
        console.log('服务器最佳游戏时间收集完成。下次收集将在', nextExecution.toLocaleString('zh-CN'), '进行');
    } catch (err) {
        console.error('收集服务器最佳游戏时间时发生错误:', err);
    }
}

// 定时收集服务器数据的任务
async function collectServerData() {
    console.log('开始收集服务器数据...');
    const servers = getServerList();
    
    for (let i = 0; i < servers.length; i++) {
        const serverUrl = servers[i];
        try {
            console.log(`正在获取服务器数据: ${serverUrl}`);
            const status = await getServerStatus(serverUrl);
            saveServerHistory(status);
            console.log(`服务器数据保存成功: ${serverUrl}`);
        } catch (err) {
            console.error(`获取服务器 ${serverUrl} 数据时发生错误:`, err.message);
            
            // 保存错误记录，标记服务器为离线
            try {
                saveServerHistory({
                    url: serverUrl,
                    timestamp: Date.now(),
                    online: false,
                    players: { online: 0, max: 0 }
                });
            } catch (saveErr) {
                console.error(`保存服务器 ${serverUrl} 离线状态时发生错误:`, saveErr);
            }
        }
        
        // 等待5秒再查询下一个服务器
        if (i < servers.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    // 检查并标记长期离线的服务器
    checkAndMarkOfflineServers();
    
    // 显示下次执行时间
    const nextExecution = new Date(Date.now() + 60 * 60 * 1000);
    console.log('服务器数据收集完成。下次数据收集将在', nextExecution.toLocaleString('zh-CN'), '进行');
}

// 每小时执行一次服务器数据收集任务
setInterval(collectServerData, 60 * 60 * 1000);

// 每天执行一次服务器最佳游戏时间收集任务（间隔24小时）
setInterval(collectServerBestTimes, 24 * 60 * 60 * 1000);

// 立即执行一次数据收集
collectServerData();

// 立即执行一次最佳游戏时间收集（延迟1分钟后执行，确保服务器启动完成）
// setTimeout(collectServerBestTimes, 60 * 1000);

// 启动服务器
app.listen(port, () => {
    console.log(`服务器正在端口 ${port} 上运行`);
    console.log(`访问地址: http://localhost:${port}`);
});

// 新增 API 端点用于审核并接受 checkingpost.json 中的请求
app.get('/api/acceptnewpost', (req, res) => {
    try {
        console.log('收到审核请求');
        
        // 获取查询参数中的 token
        const { token } = req.query;
        
        // 检查参数是否存在
        if (!token) {
            console.log('请求缺少 token 参数');
            return res.status(400).json({ error: '缺少 token 参数' });
        }
        
        // 从 config.json 中读取 token
        const expectedToken = config.token;
        
        // 比对 token
        if (token !== expectedToken) {
            console.log('token 验证失败');
            return res.status(401).json({ error: 'token 验证失败' });
        }
        
        // 读取 checkingpost.json 文件
        const checkingPostPath = path.join(__dirname, 'checkingpost.json');
        if (!fs.existsSync(checkingPostPath)) {
            console.log('没有待审核的请求');
            return res.status(404).json({ error: '没有待审核的请求' });
        }
        
        const serverData = JSON.parse(fs.readFileSync(checkingPostPath, 'utf8'));
        
        // 读取现有的 data/part.json 文件
        const partPath = path.join(__dirname, 'data/part.json');
        let partData = {};
        
        if (fs.existsSync(partPath)) {
            partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
        }
        
        // 确保 Servers 数组存在
        if (!partData.Servers) {
            partData.Servers = [];
        }
        
        // 检查是否已存在相同 URL 的服务器
        const existingServerIndex = partData.Servers.findIndex(server => server.url === serverData.url);
        
        if (existingServerIndex >= 0) {
            // 覆盖现有服务器信息（完全替换）
            partData.Servers[existingServerIndex] = serverData;
        } else {
            // 添加新服务器
            partData.Servers.push(serverData);
        }
        
        // 保存更新后的数据到 data/part.json
        fs.writeFileSync(partPath, JSON.stringify(partData, null, 2));
        
        // 删除 checkingpost.json 文件
        fs.unlinkSync(checkingPostPath);
        
        console.log(`服务器信息已审核并保存: ${serverData.title}`);
        res.json({ success: true, message: '服务器信息已审核并保存' });
    } catch (err) {
        console.error('处理审核请求时发生错误:', err);
        res.status(500).json({ error: '处理审核请求时发生错误' });
    }
});

// 新增 API 端点用于拒绝并清除 checkingpost.json 中的请求
app.get('/api/cancelnewpost', (req, res) => {
    try {
        console.log('收到拒绝请求');
        
        // 获取查询参数中的 token
        const { token } = req.query;
        
        // 检查参数是否存在
        if (!token) {
            console.log('请求缺少 token 参数');
            return res.status(400).json({ error: '缺少 token 参数' });
        }
        
        // 从 config.json 中读取 token
        const expectedToken = config.token;
        
        // 比对 token
        if (token !== expectedToken) {
            console.log('token 验证失败');
            return res.status(401).json({ error: 'token 验证失败' });
        }
        
        // 读取 checkingpost.json 文件路径
        const checkingPostPath = path.join(__dirname, 'checkingpost.json');
        
        // 检查文件是否存在
        if (!fs.existsSync(checkingPostPath)) {
            console.log('没有待处理的请求');
            return res.status(404).json({ error: '没有待处理的请求' });
        }
        
        // 删除 checkingpost.json 文件
        fs.unlinkSync(checkingPostPath);
        
        console.log('已拒绝并清除待处理请求');
        res.json({ success: true, message: '已拒绝并清除待处理请求' });
    } catch (err) {
        console.error('处理拒绝请求时发生错误:', err);
        res.status(500).json({ error: '处理拒绝请求时发生错误' });
    }
});
// 获取服务器信息的API端点
app.get('/api/getserver', async (req, res) => {
    try {
        const { name } = req.query;

        if (!name) {
            return res.status(400).json({ error: '缺少服务器名称参数' });
        }

        // 1. 读取 data/part.json 配置文件
        const partPath = path.join(__dirname, 'data/part.json');
        let partData;
        try {
            partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
        } catch (readErr) {
            console.error('读取 data/part.json 失败:', readErr);
            return res.status(500).json({ error: '无法读取服务器配置信息' });
        }

        const serverConfig = partData.Servers.find(server => server.title === name);

        if (!serverConfig) {
            return res.status(404).json({ error: '未找到指定服务器' });
        }

        // 2. 调用 https://api.mcsrvstat.us 接口
        const serverAddress = serverConfig.url;
        const apiUrl = `https://api.mcsrvstat.us/3/${serverAddress}`;

        https.get(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
            }
        }, (apiResponse) => {
            let apiData = '';

            apiResponse.on('data', (chunk) => {
                apiData += chunk;
            });

            apiResponse.on('end', () => {
                try {
                    let statusData;
                    try {
                        statusData = JSON.parse(apiData);
                    } catch (parseError) {
                        console.error(`解析 mcsrvstat.us 响应失败: ${parseError.message}\n原始响应: ${apiData}`);
                        return res.status(500).json({ error: '获取服务器状态失败：外部API返回无效响应' });
                    }

                    // 3. 提取必要的实时状态字段
                    const realTimeStatus = {
                        online: statusData.online || false,
                        ip: statusData.ip || serverAddress, // Fallback to configured address if IP not in status
                        port: statusData.port || 25565, // Default Minecraft port
                        version: statusData.version || '未知',
                        protocolName: statusData.protocol ? statusData.protocol.name : '未知',
                        playersOnline: statusData.players ? statusData.players.online : 0,
                        playersMax: statusData.players ? statusData.players.max : 0,
                        motdClean: statusData.motd ? statusData.motd.clean : []
                    };

                    // 4. 合并实时状态信息与配置信息
                    const combinedData = {
                        ...serverConfig,
                        realTimeStatus: realTimeStatus
                    };

                    res.json(combinedData);

                } catch (parseErr) {
                    console.error('解析 mcsrvstat.us 响应失败:', parseErr);
                    res.status(500).json({ error: '无法解析服务器状态信息' });
                }
            });
        }).on('error', (apiErr) => {
            console.error('请求 mcsrvstat.us 失败:', apiErr);
            res.status(500).json({ error: '无法获取服务器实时状态' });
        });

    } catch (err) {
        console.error('处理 /api/getserver 请求时发生错误:', err);
        res.status(500).json({ error: '内部服务器错误' });
    }
});