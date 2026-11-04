// minecraft.js - Minecraft 模块
// 处理 Minecraft 账户绑定、Microsoft OAuth 登录、Token 刷新等功能
const { t, htmlLang } = require('./i18n');
const axios = require('axios');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { safeEqualString, getClientIp, scriptJson } = require('./security');

const MC_TOKEN_EXPIRE_HOURS = 24;
const MC_TOKEN_REFRESH_BEFORE_HOURS = 2;
const MC_TOKEN_AUTO_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

module.exports = function setupMinecraft(app, db, config, parseCookies, logUserAction, generateSidebarHtml, sidebarScript, bloraAssetTags) {

    const { createBrowserOAuthFlow } = require('./lib/browser-oauth-flow');
    const microsoftStarts = createBrowserOAuthFlow();
    const microsoftCallbacks = createBrowserOAuthFlow();
    const msCookieOptions = { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 300000 };
    const binding = req => ({ username: req.authUsername, sessionToken: req.sessionToken });
    app.get('/login/Minecraft/Microsoft/start', async (req, res) => {
        if (!req.authUsername || !req.sessionToken) return res.redirect('/');
        const user = await db.getUser(req.authUsername);
        if (!user) return res.redirect('/');
        const microsoft = config.oauth && config.oauth.microsoft;
        if (!microsoft || !microsoft.client_id || !microsoft.client_secret) return res.sendStatus(503);
        const state = microsoftStarts.create(binding(req));
        res.cookie('__Host-bp_ms_state', state, msCookieOptions);
        const target = new URL('https://login.live.com/oauth20_authorize.srf');
        target.search = new URLSearchParams({ client_id: microsoft.client_id, response_type: 'code',
            redirect_uri: microsoft.redirect_uri || 'https://passport.bloret.net/login/Minecraft/Microsoft',
            scope: 'XboxLive.signin offline_access', state }).toString();
        return res.redirect(target.href);
    });

    // --- 带有重试机制的 Axios 请求辅助函数 ---
    async function axiosPostWithRetry(url, data, config = {}, retries = 3, delay = 2000) {
        for (let i = 0; i < retries; i++) {
            try {
                return await axios.post(url, data, config);
            } catch (error) {
                const isRateLimit = error.response && error.response.status === 429;
                const isServerError = error.response && error.response.status >= 500;

                if ((isRateLimit || isServerError) && i < retries - 1) {
                    console.log(`[Minecraft Login] API 请求受限或出错 (Attempt ${i + 1}/${retries})，等待 ${delay}ms 后重试... URL: ${url}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw error;
            }
        }
    }

    // 1. 修改后的回调路由：只负责渲染"处理中"页面
    app.get('/login/Minecraft/Microsoft', async (req, res) => {
        const { code, state } = req.query;

        const cookies = parseCookies(req.headers.cookie || '');
        const username = req.authUsername;

        if (!username) {
            const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
            return res.redirect(`/?redirect_uri=${encodeURIComponent(currentUrl)}`);
        }
        const user = await db.getUser(username);
        if (!user) {
            const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
            return res.redirect(`/?redirect_uri=${encodeURIComponent(currentUrl)}`);
        }

        if (typeof code !== 'string' || !code || code.length > 4096 ||
            !microsoftStarts.consume(state, cookies['__Host-bp_ms_state'], binding(req))) {
            return res.status(400).send(t('授权状态无效或已过期，请重新发起绑定'));
        }
        res.clearCookie('__Host-bp_ms_state', msCookieOptions);
        const transaction = microsoftCallbacks.create({ ...binding(req), code });
        res.cookie('__Host-bp_ms_callback', transaction, msCookieOptions);

        res.send(`
    <!DOCTYPE html>
    <html lang="${htmlLang()}">
    <head>
        <link rel="icon" href="/BL.png" type="image/png">
        <link rel="apple-touch-icon" href="/BL.png">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${t('正在验证 Minecraft 账户...')}</title>
                <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
        <style>
            .minecraft-status-page { display: block !important; }
            .minecraft-status-page .blora-card { width: min(400px, calc(100vw - 2 * var(--blora-space-5))); margin: 0 auto; box-sizing: border-box; }
            .status-text {
                margin-top: 20px;
                color: var(--foreground);
                font-size: 16px;
            }
            .sub-text {
                margin-top: 10px;
                color: var(--muted-foreground);
                font-size: 12px;
            }
        </style>
    ${bloraAssetTags()}</head>
    <body class="blora-page blora-scope minecraft-status-page">
        <div class="blora-card">
            <div class="spinner" style="width:32px;height:32px;margin:0 auto 8px;"></div>
            <h3 class="status-text" id="status">${t('正在连接微软服务器...')}</h3>
            <p class="sub-text">${t('此过程可能需要几秒钟，请勿关闭页面。')}</p>
            <div id="error-msg" style="color: #a4262c; margin-top: 15px; display: none;"></div>
            <button type="button" class="blora-button" data-variant="primary" id="retry-btn" onclick="location.reload()" style="display:none; margin-top:15px;" >${t('重试')}</button>
            <button type="button" class="blora-button" data-variant="outline" id="home-btn" onclick="location.href='/'" style="display:none; margin-top:15px;" >${t('返回首页')}</button>
        </div>

        <script>
            async function startVerification() {
                const statusEl = document.getElementById('status');
                const errorEl = document.getElementById('error-msg');
                const homeBtn = document.getElementById('home-btn');
                const retryBtn = document.getElementById('retry-btn');

                try {
                    statusEl.innerText = ${scriptJson(t('正在验证 Xbox 及 Minecraft 权限...'))};

                    const response = await fetch('/api/login/Minecraft/Microsoft/Process', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ transaction: ${scriptJson(transaction)} })
                    });

                    const result = await response.json();

                    if (result.success) {
                        statusEl.innerText = ${scriptJson(t('验证成功！正在跳转...'))};
                        setTimeout(() => {
                            window.location.href = '/';
                        }, 1000);
                    } else {
                        throw new Error(result.message || ${scriptJson(t('未知错误'))});
                    }
                } catch (err) {
                    document.querySelector('.spinner').style.display = 'none';
                    statusEl.innerText = ${scriptJson(t('验证失败'))};
                    errorEl.innerText = err.message;
                    errorEl.style.display = 'block';
                    homeBtn.style.display = 'inline-block';
                    if (!err.message.includes('code')) {
                        retryBtn.style.display = 'inline-block';
                    }
                }
            }

            window.onload = startVerification;
        </script>
    </body>
    </html>
    `);
    });

    // 2. 实际处理验证逻辑的 API (POST)
    app.post('/api/login/Minecraft/Microsoft/Process', async (req, res) => {
        const { transaction } = req.body;
        const cookies = parseCookies(req.headers.cookie || '');
        const username = req.authUsername;

        if (!username) {
            return res.status(401).json({ success: false, message: t('登录已过期，请重新登录') });
        }
        const user = await db.getUser(username);
        if (!user) {
            return res.status(401).json({ success: false, message: t('登录已过期，请重新登录') });
        }

        const callback = microsoftCallbacks.consume(transaction, cookies['__Host-bp_ms_callback'], binding(req));
        if (!callback) return res.status(400).json({ success: false, message: t('授权状态无效或已过期，请重新发起绑定') });
        res.clearCookie('__Host-bp_ms_callback', msCookieOptions);
        const code = callback.code;

        // --- 代理配置 ---
        const PROXY_URL = config.proxy && config.proxy.enable && config.proxy.url ? config.proxy.url : '';
        let axiosConfig = { timeout: 15000, maxRedirects: 0, maxContentLength: 1024 * 1024 };

        if (PROXY_URL) {
            try {
                const agent = new HttpsProxyAgent(PROXY_URL);
                axiosConfig = {
                    ...axiosConfig,
                    httpsAgent: agent,
                    proxy: false,
                    timeout: 15000
                };
                console.log('[Minecraft Login] 使用已配置代理连接微软服务器');
            } catch (e) {
                console.warn(t('[Minecraft Login] 代理配置失败，将尝试直连'), e);
            }
        } else {
            console.log(t('[Minecraft Login] 未配置代理，将直接连接微软服务器'));
        }

        try {
            // --- 第一阶段：用 code 换取微软 Access Token ---
            const msOAuth = (config.oauth && config.oauth.microsoft) || {};
            const msTokenResponse = await axios.post('https://login.live.com/oauth20_token.srf', new URLSearchParams({
                client_id: msOAuth.client_id,
                client_secret: msOAuth.client_secret,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: msOAuth.redirect_uri || 'https://passport.bloret.net/login/Minecraft/Microsoft'
            }), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                ...axiosConfig
            });

            const msAccessToken = msTokenResponse.data.access_token;
            const msRefreshToken = msTokenResponse.data.refresh_token;

            // --- 第二阶段：换取 Xbox Live Token ---
            const xblResponse = await axios.post('https://user.auth.xboxlive.com/user/authenticate', {
                Properties: {
                    AuthMethod: 'RPS',
                    SiteName: 'user.auth.xboxlive.com',
                    RpsTicket: `d=${msAccessToken}`
                },
                RelyingParty: 'http://auth.xboxlive.com',
                TokenType: 'JWT'
            }, axiosConfig);

            const xblToken = xblResponse.data.Token;
            const userHash = xblResponse.data.DisplayClaims.xui[0].uhs;

            // --- 第三阶段：换取 XSTS Token ---
            const xstsResponse = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
                Properties: {
                    SandboxId: 'RETAIL',
                    UserTokens: [xblToken]
                },
                RelyingParty: 'rp://api.minecraftservices.com/',
                TokenType: 'JWT'
            }, axiosConfig);
            const xstsToken = xstsResponse.data.Token;

            // --- 第四阶段：换取 Minecraft Access Token ---
            const mcResponse = await axiosPostWithRetry(
                'https://api.minecraftservices.com/authentication/login_with_xbox',
                { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
                axiosConfig,
                3,
                2500
            );
            const mcAccessToken = mcResponse.data.access_token;

            // --- 第五阶段：获取 Minecraft 档案 ---
            const profileResponse = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
                headers: { Authorization: `Bearer ${mcAccessToken}` },
                ...axiosConfig
            });
            const profile = profileResponse.data;

            // 数据持久化
            const currentUser = await db.getUser(username);
            if (!currentUser) {
                return res.status(404).json({ success: false, message: t('用户不存在') });
            }

            const accountData = {
                username: profile.name,
                uuid: profile.id,
                access_token: mcAccessToken,
                refresh_token: msRefreshToken,
                type: 'Microsoft',
                login_time: new Date().toISOString()
            };

            await db.mutateMinecraftAccount(username, { operation: 'upsert', uuid: accountData.uuid, account: accountData });

            const clientIp = getClientIp(req);
            await logUserAction(username, 'minecraft_bind', `成功绑定 Minecraft 账号: ${profile.name}`, clientIp);

            return res.json({ success: true, username: profile.name });

        } catch (error) {
            console.error(t('Minecraft 验证详细错误:'), error.code || 'provider_error');

            let msg = error.message;
            if (error.response && error.response.data) {
                if (error.response.data.error === 'TOO_MANY_REQUESTS') {
                    msg = t('Minecraft API 请求过于频繁，请稍后再试 (429)。');
                } else if (error.response.data.errorMessage) {
                    msg = t('Minecraft 验证服务暂不可用');
                } else {
                    msg = t('Minecraft 验证服务暂不可用');
                }
            }

            res.status(500).json({ success: false, message: t('验证失败: {message}', { message: msg }) });
        }
    });

    // --- 代理配置构建函数 ---
    function buildProxyAxiosConfig() {
        const PROXY_URL = config.proxy && config.proxy.enable && config.proxy.url ? config.proxy.url : '';
        let axiosConfig = { timeout: 15000, maxRedirects: 0, maxContentLength: 1024 * 1024 };
        if (PROXY_URL) {
            try {
                const agent = new HttpsProxyAgent(PROXY_URL);
                axiosConfig = {
                    ...axiosConfig,
                    httpsAgent: agent,
                    proxy: false,
                    timeout: 15000
                };
            } catch (e) {
                console.warn(t('[Minecraft] 代理配置失败，将尝试直连'));
            }
        }
        return axiosConfig;
    }

    // --- Microsoft Token 刷新逻辑 ---
    const pendingRefreshes = new Map();
    function refreshMicrosoftToken(refreshToken, axiosConfig) {
        const key = crypto.createHash('sha256').update(refreshToken).digest('hex');
        if (pendingRefreshes.has(key)) return pendingRefreshes.get(key);
        if (pendingRefreshes.size >= 1000) return Promise.reject(new Error('Too many pending refresh requests'));
        const promise = exchangeMicrosoftToken(refreshToken, axiosConfig).finally(() => pendingRefreshes.delete(key));
        pendingRefreshes.set(key, promise);
        return promise;
    }
    async function exchangeMicrosoftToken(refreshToken, axiosConfig) {
        const msOAuth = (config.oauth && config.oauth.microsoft) || {};
        const msTokenResponse = await axios.post('https://login.live.com/oauth20_token.srf', new URLSearchParams({
            client_id: msOAuth.client_id,
            client_secret: msOAuth.client_secret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
            redirect_uri: msOAuth.redirect_uri || 'https://passport.bloret.net/login/Minecraft/Microsoft'
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            ...axiosConfig
        });

        const msAccessToken = msTokenResponse.data.access_token;
        const msRefreshToken = msTokenResponse.data.refresh_token;

        const xblResponse = await axios.post('https://user.auth.xboxlive.com/user/authenticate', {
            Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
            RelyingParty: 'http://auth.xboxlive.com',
            TokenType: 'JWT'
        }, axiosConfig);
        const xblToken = xblResponse.data.Token;
        const userHash = xblResponse.data.DisplayClaims.xui[0].uhs;

        const xstsResponse = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
            Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT'
        }, axiosConfig);
        const xstsToken = xstsResponse.data.Token;

        const mcResponse = await axiosPostWithRetry(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
            axiosConfig, 3, 2500
        );

        return {
            mcAccessToken: mcResponse.data.access_token,
            msRefreshToken: msRefreshToken || refreshToken
        };
    }

    // --- 单用户 Token 刷新 ---
    async function refreshUserMicrosoftToken(username) {
        const user = await db.getUser(username);
        if (!user || !user.MinecraftAccounts) return false;

        const msAccountIndex = user.MinecraftAccounts.findIndex(acc => acc.type === 'Microsoft');
        if (msAccountIndex === -1) return false;

        const msAccount = user.MinecraftAccounts[msAccountIndex];
        if (!msAccount.refresh_token) return false;

        const axiosConfig = buildProxyAxiosConfig();
        const result = await refreshMicrosoftToken(msAccount.refresh_token, axiosConfig);

        return Boolean(await db.mutateMinecraftAccount(username, { operation: 'refresh', uuid: msAccount.uuid,
            expectedRefreshToken: msAccount.refresh_token, patch: { access_token: result.mcAccessToken,
                refresh_token: result.msRefreshToken, login_time: new Date().toISOString() } }));
    }

    // --- 批量自动刷新所有用户的 Microsoft Token ---
    async function autoRefreshAllMicrosoftTokens() {
        console.log(t('[Token AutoRefresh] 开始扫描所有用户的 Microsoft Token...'));
        const users = await db.getAllUsers();
        let refreshed = 0;
        let failed = 0;
        let skipped = 0;

        for (const user of users) {
            if (!user.MinecraftAccounts || user.MinecraftAccounts.length === 0) continue;

            const msAccount = user.MinecraftAccounts.find(acc => acc.type === 'Microsoft');
            if (!msAccount) continue;

            if (!msAccount.refresh_token) {
                skipped++;
                continue;
            }

            const loginTime = new Date(msAccount.login_time);
            const now = new Date();
            const hoursSinceLogin = (now - loginTime) / (1000 * 60 * 60);

            if (hoursSinceLogin < MC_TOKEN_EXPIRE_HOURS - MC_TOKEN_REFRESH_BEFORE_HOURS) {
                continue;
            }

            console.log(`[Token AutoRefresh] 用户 ${user.username} 的 Token 已存在 ${hoursSinceLogin.toFixed(1)} 小时，即将过期，开始刷新...`);
            try {
                const success = await refreshUserMicrosoftToken(user.username);
                if (success) {
                    refreshed++;
                } else {
                    skipped++;
                }
            } catch (error) {
                failed++;
                console.error(`[Token AutoRefresh] 用户 ${user.username} Token 刷新失败:`, error.code || 'provider_error');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log(`[Token AutoRefresh] 扫描完成: 刷新 ${refreshed} 个, 失败 ${failed} 个, 跳过 ${skipped} 个`);
    }

    // 刷新 Minecraft Token 核心逻辑
    async function handleMinecraftTokenRefresh(req, res) {
        try {
            // 鉴权方式（优先级）：
            // 1) OAuth App 凭据：app_id + app_secret + user + usertoken（Launcher 等客户端推荐）
            // 2) Cookie username（网页端会话）
            let username = null;

            const { app_id, app_secret, user: queryUser, usertoken } = { ...req.query, ...req.body };
            if (app_id && app_secret && queryUser && usertoken) {
                const oauthApp = await db.getOAuthApp(app_id);
                if (!oauthApp || !safeEqualString(oauthApp.app_secret, app_secret)) {
                    return res.status(401).json({ success: false, message: t('应用ID或密钥不正确') });
                }
                if (!(await db.validateAppToken(queryUser, app_id, usertoken))) {
                    return res.status(401).json({ success: false, message: t('用户或用户令牌不正确') });
                }
                username = queryUser;
            } else {
                const cookies = parseCookies(req.headers.cookie || '');
                username = req.authUsername;
            }

            if (!username) {
                return res.status(401).json({ success: false, message: t('登录已过期') });
            }
            const user = await db.getUser(username);
            if (!user) {
                return res.status(401).json({ success: false, message: t('登录已过期') });
            }
            if (!user.MinecraftAccounts || user.MinecraftAccounts.length === 0) {
                return res.status(404).json({ success: false, message: t('未绑定 Minecraft 账号') });
            }

            const msAccountIndex = user.MinecraftAccounts.findIndex(acc => acc.type === 'Microsoft');
            if (msAccountIndex === -1) {
                return res.status(400).json({ success: false, message: t('没有绑定的 Microsoft 账号') });
            }

            const msAccount = user.MinecraftAccounts[msAccountIndex];
            if (!msAccount.refresh_token) {
                return res.status(400).json({ success: false, message: t('凭证已失效，请重新登录') });
            }

            const axiosConfig = buildProxyAxiosConfig();
            const result = await refreshMicrosoftToken(msAccount.refresh_token, axiosConfig);

            const updated = await db.mutateMinecraftAccount(username, { operation: 'refresh', uuid: msAccount.uuid,
                expectedRefreshToken: msAccount.refresh_token, patch: { access_token: result.mcAccessToken,
                    refresh_token: result.msRefreshToken, login_time: new Date().toISOString() } });
            if (!updated) return res.status(409).json({ success: false, message: t('账户已变更，请重试') });

            return res.json({ success: true, message: t('Token 刷新成功'), access_token: result.mcAccessToken });

        } catch (error) {
            console.error(t('[Minecraft Refresh] 刷新失败:'), error.code || 'provider_error');
            return res.status(500).json({
                success: false,
                message: t('刷新失败，请重新登录'),
                error: error.message
            });
        }
    }

    // 网页端路径
    app.post('/login/Minecraft/Refresh', handleMinecraftTokenRefresh);
    // Launcher / 文档使用的 API 路径（历史兼容）
    app.post('/api/login/Minecraft/Refresh', handleMinecraftTokenRefresh);

    // 处理 Minecraft 离线登录绑定
    app.post('/login/Minecraft/Offline', async (req, res) => {
        try {
            const cookies = parseCookies(req.headers.cookie || '');
            const username = req.authUsername;
            let { username: mcUsername } = req.body;

            const currentUser = await db.getUser(username);
            if (!username || !currentUser) {
                return res.status(401).json({ success: false, message: t('未登录或会话已过期') });
            }
            if (!mcUsername || mcUsername.trim() === "") {
                return res.status(400).json({ success: false, message: t('玩家名不能为空') });
            }

            mcUsername = mcUsername.trim();

            const usernameRegex = /^[a-zA-Z0-9_]{3,16}$/;
            if (!usernameRegex.test(mcUsername)) {
                return res.status(400).json({
                    success: false,
                    message: t('玩家名不符合规则：长度需为3-16位，且只能包含字母、数字及下划线')
                });
            }

            try {
                const mojangResponse = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${mcUsername}`, buildProxyAxiosConfig());
                if (mojangResponse.status === 200 && mojangResponse.data && mojangResponse.data.id) {
                    return res.status(400).json({
                        success: false,
                        message: t('名字 "{name}" 已被正版玩家占用，离线模式不可使用该名字', { name: mcUsername })
                    });
                }
            } catch (error) {
                if (error.response && error.response.status !== 404) {
                    console.error(t('Mojang API 访问失败:'), error.message);
                    return res.status(500).json({ success: false, message: t('无法验证正版查重，请稍后再试') });
                }
            }

            const uuid = crypto.createHash('md5').update("OfflinePlayer:" + mcUsername).digest('hex');
            const formattedUuid = uuid.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, "$1-$2-$3-$4-$5");

            const accountData = {
                username: mcUsername,
                uuid: formattedUuid,
                type: 'Offline',
                login_time: new Date().toISOString()
            };

            await db.mutateMinecraftAccount(username, { operation: 'upsert', uuid: accountData.uuid, account: accountData });

            const clientIp = getClientIp(req);
            await db.logUserAction(username, 'minecraft_bind_offline', `成功绑定离线 Minecraft 账号: ${mcUsername}`, clientIp);

            return res.json({ success: true, message: t('绑定成功') });
        } catch (error) {
            console.error(t('离线绑定接口崩溃:'), error);
            return res.status(500).json({ success: false, message: t('服务器内部错误') });
        }
    });

    // 处理移除 Minecraft 账户请求
    app.post('/login/Minecraft/Remove', async (req, res) => {
        try {
            const cookies = parseCookies(req.headers.cookie || '');
            const username = req.authUsername;
            const { uuid } = req.body;

            const currentUser = await db.getUser(username);
            if (!username || !currentUser) {
                return res.status(401).json({ success: false, message: t('未登录') });
            }

            const minecraftAccounts = currentUser.MinecraftAccounts || [];
            if (minecraftAccounts.length === 0) {
                return res.status(404).json({ success: false, message: t('未找到账户列表') });
            }

            const initialLength = minecraftAccounts.length;
            const newMinecraftAccounts = minecraftAccounts.filter(acc => acc.uuid !== uuid);

            if (newMinecraftAccounts.length === initialLength) {
                return res.status(404).json({ success: false, message: t('未找到该账户') });
            }

            if (!await db.mutateMinecraftAccount(username, { operation: 'remove', uuid })) return res.status(404).json({ success: false, message: t('未找到该账户') });

            const clientIp = getClientIp(req);
            await logUserAction(username, 'minecraft_remove', `移除了 Minecraft 账户: ${uuid}`, clientIp);

            return res.json({ success: true, message: t('移除成功') });
        } catch (error) {
            console.error(t('移除账户失败:'), error);
            return res.status(500).json({ success: false, message: t('服务器内部错误') });
        }
    });

    // ================= Minecraft 档案管理 =================

    /**
     * 获取指定账户的有效 access_token，必要时自动刷新。
     * 仅对 Microsoft 账号有效（离线账号没有可操作的在线档案）。
     * @returns {Promise<{accessToken: string, account: object} | null>}
     */
    async function getValidMcAccessToken(username, uuid) {
        const user = await db.getUser(username);
        if (!user || !user.MinecraftAccounts) return null;

        const idx = user.MinecraftAccounts.findIndex(acc => acc.uuid === uuid && acc.type === 'Microsoft');
        if (idx === -1) return null;

        const account = user.MinecraftAccounts[idx];
        if (!account.refresh_token) return null;

        // 判断是否需要刷新（剩余有效时间不足阈值）
        const loginTime = account.login_time ? new Date(account.login_time) : new Date(0);
        const hoursSinceLogin = (Date.now() - loginTime.getTime()) / (1000 * 60 * 60);
        if (hoursSinceLogin >= MC_TOKEN_EXPIRE_HOURS - MC_TOKEN_REFRESH_BEFORE_HOURS) {
            const axiosConfig = buildProxyAxiosConfig();
            const result = await refreshMicrosoftToken(account.refresh_token, axiosConfig);

            const updated = await db.mutateMinecraftAccount(username, { operation: 'refresh', uuid,
                expectedRefreshToken: account.refresh_token, patch: { access_token: result.mcAccessToken,
                    refresh_token: result.msRefreshToken, login_time: new Date().toISOString() } });
            if (!updated) return null;
            return { accessToken: result.mcAccessToken, account: updated };
        }

        return { accessToken: account.access_token, account };
    }

    /**
     * 拉取某账号的完整 Minecraft 档案（含 skins / cape）。
     * GET https://api.minecraftservices.com/minecraft/profile
     */
    async function fetchMcSkins(accessToken, axiosConfig) {
        const resp = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
            headers: { Authorization: `Bearer ${accessToken}` },
            ...axiosConfig
        });
        return resp.data;
    }

    /**
     * 通过玩家名查询 Minecraft 正版档案（含皮肤 URL）。
     * 使用 sessionserver.mojang.com / api.mojang.com（无需鉴权）。
     * @returns {Promise<{uuid, username, skinUrl, capeUrl, model} | null>}
     */
    async function lookupPlayerByName(playerName) {
        const axiosConfig = buildProxyAxiosConfig();
        // 1) 名字 -> UUID
        const profileResp = await axios.get(
            `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(playerName)}`,
            { ...axiosConfig, validateStatus: () => true }
        );
        if (profileResp.status === 404 || !profileResp.data || !profileResp.data.id) return null;
        const uuid = profileResp.data.id;
        const name = profileResp.data.name;

        // 2) UUID -> 档案纹理（含 skin / cape）
        const sessionResp = await axios.get(
            `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
            { ...axiosConfig, validateStatus: () => true }
        );
        if (sessionResp.status !== 200 || !sessionResp.data || !sessionResp.data.properties) {
            return { uuid, username: name, skinUrl: null, capeUrl: null, model: 'classic' };
        }

        const texturesProp = sessionResp.data.properties.find(p => p.name === 'textures');
        if (!texturesProp) return { uuid, username: name, skinUrl: null, capeUrl: null, model: 'classic' };

        let textures;
        try {
            textures = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
        } catch (_) {
            return { uuid, username: name, skinUrl: null, capeUrl: null, model: 'classic' };
        }

        const skin = textures.textures && textures.textures.SKIN;
        const cape = textures.textures && textures.textures.CAPE;
        return {
            uuid,
            username: name,
            skinUrl: skin ? skin.url : null,
            capeUrl: cape ? cape.url : null,
            model: (skin && skin.metadata && skin.metadata.model === 'slim') ? 'slim' : 'classic'
        };
    }

    // --- 鉴权辅助：网页端会话校验，返回 {username, user} 或直接 res 错误 ---
    async function requireWebSession(req, res) {
        const username = req.authUsername;
        if (!username) {
            res.status(401).json({ success: false, message: t('未登录或会话已过期') });
            return null;
        }
        const user = await db.getUser(username);
        if (!user) {
            res.status(401).json({ success: false, message: t('未登录或会话已过期') });
            return null;
        }
        return { username, user };
    }

    // 获取指定账号的 Minecraft 档案（皮肤 / 披风）
    app.get('/api/minecraft/profile/:uuid', async (req, res) => {
        try {
            const session = await requireWebSession(req, res);
            if (!session) return;
            const { username } = session;
            const { uuid } = req.params;

            const tokenInfo = await getValidMcAccessToken(username, uuid);
            if (!tokenInfo) {
                return res.status(404).json({ success: false, message: t('未找到该 Microsoft Minecraft 账号，或凭证已失效') });
            }
            const axiosConfig = buildProxyAxiosConfig();
            const skins = await fetchMcSkins(tokenInfo.accessToken, axiosConfig);

            const clientIp = getClientIp(req);
            await logUserAction(username, 'minecraft_profile_read', `读取 Minecraft 档案: ${tokenInfo.account.username} (${uuid})`, clientIp);

            return res.json({ success: true, profile: skins, account: { username: tokenInfo.account.username, uuid: tokenInfo.account.uuid } });
        } catch (error) {
            console.error(t('[Minecraft Profile] 读取档案失败:'), error.code || 'provider_error');
            const status = error.response && error.response.status === 404 ? 404 : 500;
            return res.status(status).json({
                success: false,
                message: t('读取档案失败:') + ' ' + (error.response && error.response.data && error.response.data.errorMessage ? error.response.data.errorMessage : error.message)
            });
        }
    });

    // 上传 / 修改皮肤（base64 或 URL）
    app.post('/api/minecraft/skin/upload', async (req, res) => {
        try {
            const session = await requireWebSession(req, res);
            if (!session) return;
            const { username } = session;
            const { uuid, variant, url, base64, model } = req.body || {};

            if (!uuid) return res.status(400).json({ success: false, message: t('缺少 uuid') });
            if (!variant || !['classic', 'slim'].includes(variant)) {
                return res.status(400).json({ success: false, message: t('variant 必须为 classic 或 slim') });
            }

            const tokenInfo = await getValidMcAccessToken(username, uuid);
            if (!tokenInfo) {
                return res.status(404).json({ success: false, message: t('未找到该 Microsoft Minecraft 账号，或凭证已失效') });
            }
            const axiosConfig = buildProxyAxiosConfig();

            if (url) {
                // 通过 URL 设置皮肤
                await axios.post(
                    'https://api.minecraftservices.com/minecraft/profile/skins',
                    { variant, url },
                    { headers: { Authorization: `Bearer ${tokenInfo.accessToken}`, 'Content-Type': 'application/json' }, ...axiosConfig }
                );
            } else if (base64) {
                // 通过 base64 上传皮肤
                const skinBuf = Buffer.from(base64, 'base64');
                if (skinBuf.length > 1024 * 1024) {
                    return res.status(400).json({ success: false, message: t('皮肤文件过大（>1MB）') });
                }
                const FormData = require('form-data');
                const form = new FormData();
                form.append('variant', variant);
                form.append('file', skinBuf, { filename: 'skin.png', contentType: 'image/png' });
                await axios.put(
                    'https://api.minecraftservices.com/minecraft/profile/skins',
                    form,
                    {
                        headers: {
                            Authorization: `Bearer ${tokenInfo.accessToken}`,
                            ...form.getHeaders()
                        },
                        ...axiosConfig,
                        maxBodyLength: Infinity,
                        maxContentLength: 1024 * 1024,
                        timeout: 15000,
                        maxRedirects: 0
                    }
                );
            } else {
                return res.status(400).json({ success: false, message: t('必须提供 url 或 base64') });
            }

            const clientIp = getClientIp(req);
            await logUserAction(username, 'minecraft_skin_change', `修改皮肤: ${tokenInfo.account.username} (${uuid}), variant=${variant}`, clientIp);

            return res.json({ success: true, message: t('皮肤已更新') });
        } catch (error) {
            console.error(t('[Minecraft Skin] 上传皮肤失败:'), error.code || 'provider_error');
            return res.status(500).json({
                success: false,
                message: t('上传皮肤失败:') + (error.response && error.response.data && error.response.data.errorMessage ? error.response.data.errorMessage : error.message)
            });
        }
    });

    // 重置皮肤为默认
    app.post('/api/minecraft/skin/reset', async (req, res) => {
        try {
            const session = await requireWebSession(req, res);
            if (!session) return;
            const { username } = session;
            const { uuid } = req.body || {};

            if (!uuid) return res.status(400).json({ success: false, message: t('缺少 uuid') });

            const tokenInfo = await getValidMcAccessToken(username, uuid);
            if (!tokenInfo) {
                return res.status(404).json({ success: false, message: t('未找到该 Microsoft Minecraft 账号，或凭证已失效') });
            }
            const axiosConfig = buildProxyAxiosConfig();

            await axios.delete(
                'https://api.minecraftservices.com/minecraft/profile/skins/active',
                { headers: { Authorization: `Bearer ${tokenInfo.accessToken}` }, ...axiosConfig }
            );

            const clientIp = getClientIp(req);
            await logUserAction(username, 'minecraft_skin_reset', `重置皮肤: ${tokenInfo.account.username} (${uuid})`, clientIp);

            return res.json({ success: true, message: t('皮肤已重置') });
        } catch (error) {
            console.error(t('[Minecraft Skin] 重置皮肤失败:'), error.code || 'provider_error');
            return res.status(500).json({
                success: false,
                message: t('重置皮肤失败:') + (error.response && error.response.data && error.response.data.errorMessage ? error.response.data.errorMessage : error.message)
            });
        }
    });

    // 隐藏披风（Mojang API 不支持任意选择披风，仅可隐藏当前披风）
    app.post('/api/minecraft/cape/hide', async (req, res) => {
        try {
            const session = await requireWebSession(req, res);
            if (!session) return;
            const { username } = session;
            const { uuid } = req.body || {};

            if (!uuid) return res.status(400).json({ success: false, message: t('缺少 uuid') });

            const tokenInfo = await getValidMcAccessToken(username, uuid);
            if (!tokenInfo) {
                return res.status(404).json({ success: false, message: t('未找到该 Microsoft Minecraft 账号，或凭证已失效') });
            }
            const axiosConfig = buildProxyAxiosConfig();

            await axios.delete(
                'https://api.minecraftservices.com/minecraft/profile/capes/active',
                { headers: { Authorization: `Bearer ${tokenInfo.accessToken}` }, ...axiosConfig }
            );

            const clientIp = getClientIp(req);
            await logUserAction(username, 'minecraft_cape_hide', `隐藏披风: ${tokenInfo.account.username} (${uuid})`, clientIp);

            return res.json({ success: true, message: t('披风已隐藏') });
        } catch (error) {
            console.error(t('[Minecraft Cape] 隐藏披风失败:'), error.code || 'provider_error');
            return res.status(500).json({
                success: false,
                message: t('隐藏披风失败:') + (error.response && error.response.data && error.response.data.errorMessage ? error.response.data.errorMessage : error.message)
            });
        }
    });

    /**
     * 复制其他玩家的档案到自己的 Microsoft 账号：
     * 1. 输入玩家名（或 UUID），查询其皮肤 + 披风 URL；
     * 2. 将皮肤上传至当前用户的指定 Microsoft 账号；
     * 3. 披风因 Mojang 限制无法直接设置（仅可使用已拥有的披风），故仅复制皮肤。
     */
    app.post('/api/minecraft/profile/copy', async (req, res) => {
        try {
            const session = await requireWebSession(req, res);
            if (!session) return;
            const { username } = session;
            const { targetUuid, sourceName, sourceUuid } = req.body || {};

            if (!targetUuid) return res.status(400).json({ success: false, message: t('缺少目标账号 targetUuid') });
            if (!sourceName && !sourceUuid) return res.status(400).json({ success: false, message: t('需提供 sourceName 或 sourceUuid') });

            // 1) 解析来源玩家皮肤 URL
            let sourcePlayer;
            if (sourceUuid) {
                // 直接通过 UUID 查询
                const axiosConfig0 = buildProxyAxiosConfig();
                const cleanUuid = String(sourceUuid).replace(/-/g, '');
                const sessionResp = await axios.get(
                    `https://sessionserver.mojang.com/session/minecraft/profile/${cleanUuid}`,
                    { ...axiosConfig0, validateStatus: () => true }
                );
                if (sessionResp.status !== 200 || !sessionResp.data || !sessionResp.data.properties) {
                    return res.status(404).json({ success: false, message: t('未找到该玩家档案') });
                }
                const texturesProp = sessionResp.data.properties.find(p => p.name === 'textures');
                let textures = {};
                if (texturesProp) {
                    try { textures = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8')); } catch (_) {}
                }
                const skin = textures.textures && textures.textures.SKIN;
                const cape = textures.textures && textures.textures.CAPE;
                sourcePlayer = {
                    uuid: sessionResp.data.id,
                    username: sessionResp.data.name,
                    skinUrl: skin ? skin.url : null,
                    capeUrl: cape ? cape.url : null,
                    model: (skin && skin.metadata && skin.metadata.model === 'slim') ? 'slim' : 'classic'
                };
            } else {
                sourcePlayer = await lookupPlayerByName(sourceName);
            }

            if (!sourcePlayer || !sourcePlayer.skinUrl) {
                return res.status(404).json({ success: false, message: t('该玩家没有可用的皮肤，无法复制') });
            }

            // 2) 获取目标账号的有效 token
            const tokenInfo = await getValidMcAccessToken(username, targetUuid);
            if (!tokenInfo) {
                return res.status(404).json({ success: false, message: t('未找到目标 Microsoft Minecraft 账号，或凭证已失效') });
            }
            const axiosConfig = buildProxyAxiosConfig();

            // 3) 通过 URL 上传皮肤到目标账号
            await axios.post(
                'https://api.minecraftservices.com/minecraft/profile/skins',
                { variant: sourcePlayer.model, url: sourcePlayer.skinUrl },
                { headers: { Authorization: `Bearer ${tokenInfo.accessToken}`, 'Content-Type': 'application/json' }, ...axiosConfig }
            );

            const clientIp = getClientIp(req);
            await logUserAction(
                username,
                'minecraft_profile_copy',
                t('复制档案: {source} -> {target} ({uuid})', { source: sourcePlayer.username, target: tokenInfo.account.username, uuid: targetUuid }),
                clientIp
            );

            return res.json({
                success: true,
                message: t('已将 {source} 的皮肤复制到 {target}', { source: sourcePlayer.username, target: tokenInfo.account.username }),
                source: sourcePlayer
            });
        } catch (error) {
            console.error(t('[Minecraft Profile] 复制档案失败:'), error.code || 'provider_error');
            return res.status(500).json({
                success: false,
                message: t('复制档案失败:') + (error.response && error.response.data && error.response.data.errorMessage ? error.response.data.errorMessage : error.message)
            });
        }
    });

    // OAuth PKCE clients must explicitly request game credential access.
    app.get('/oauth/minecraft/accounts', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const match = /^Bearer\s+([A-Za-z0-9._~+\/-]+={0,2})$/i.exec(String(req.headers.authorization || ''));
        if (!match) return res.status(401).json({error: 'invalid_token'});
        const hash = crypto.createHash('sha256').update(match[1]).digest('hex');
        const token = await db.getOAuthAccessToken(hash);
        if (!token) return res.status(401).json({error: 'invalid_token'});
        if (!String(token.scope || '').split(/\s+/).includes('minecraft:accounts')) {
            return res.status(403).json({error: 'insufficient_scope', scope: 'minecraft:accounts'});
        }
        let user = await db.getUser(token.username);
        if (!user) return res.status(401).json({error: 'invalid_token'});
        const needsRefresh = (user.MinecraftAccounts || []).some(account =>
            account.type === 'Microsoft' && account.refresh_token && account.login_time &&
            (Date.now() - new Date(account.login_time).getTime()) / 3600000 >= MC_TOKEN_EXPIRE_HOURS - MC_TOKEN_REFRESH_BEFORE_HOURS);
        if (needsRefresh) {
            try {
                if (!await refreshUserMicrosoftToken(token.username)) {
                    return res.status(502).json({error: 'minecraft_refresh_failed'});
                }
                user = await db.getUser(token.username);
                if (!user) return res.status(401).json({error: 'invalid_token'});
            } catch {
                return res.status(502).json({error: 'minecraft_refresh_failed'});
            }
        }
        const accounts = (user.MinecraftAccounts || []).map(account => {
            const {refresh_token, ...gameAccount} = account;
            return gameAccount;
        });
        await logUserAction(token.username, 'read_minecraft_accounts',
            'OAuth 应用 ' + token.client_id + ' 读取了 Minecraft 账户列表', req.ip);
        return res.json({status: 'success', accounts});
    });

    // 处理获取 Minecraft 账户列表请求 (OAuth API)
    app.get('/app/MinecraftAccounts', async (req, res) => {
        const h = req.headers || {};
        const b = req.body || {};
        const q = req.query || {};
        const app_id = h['x-app-id'] || b.app_id || q.app_id;
        const app_secret = h['x-app-secret'] || b.app_secret || q.app_secret;
        const user = h['x-username'] || h['x-user'] || b.user || q.user;
        const usertoken = h['x-user-token'] || b.usertoken || q.usertoken;

        if (!app_id || !app_secret || !user || !usertoken) {
            return res.status(400).json({ status: 'error', message: t('缺少必要的参数') });
        }

        const oauthApp = await db.getOAuthApp(app_id);
        if (!oauthApp || !safeEqualString(oauthApp.app_secret, app_secret)) {
            return res.status(401).json({ status: 'error', message: t('应用ID或密钥不正确') });
        }

        if (!(oauthApp.permissions || []).includes('minecraft:accounts')) {
            return res.status(403).json({ error: 'insufficient_scope', scope: 'minecraft:accounts' });
        }

        // 多令牌表 + 旧字段兼容：重新授权生成新令牌后，旧令牌仍应可用
        const targetUser = await db.getUser(user);
        if (!targetUser || !(await db.validateAppToken(user, app_id, usertoken))) {
            return res.status(401).json({ status: 'error', message: t('用户或用户令牌不正确') });
        }

        // 若微软 Token 即将过期/已过期，先尝试刷新再返回
        // 避免 Launcher 拿到过期 access_token（微软 MC Token 约 24h 有效）
        try {
            const msAccount = (targetUser.MinecraftAccounts || []).find(acc => acc.type === 'Microsoft');
            if (msAccount && msAccount.refresh_token && msAccount.login_time) {
                const hoursSinceLogin = (Date.now() - new Date(msAccount.login_time).getTime()) / (1000 * 60 * 60);
                if (hoursSinceLogin >= MC_TOKEN_EXPIRE_HOURS - MC_TOKEN_REFRESH_BEFORE_HOURS) {
                    console.log(`[MinecraftAccounts] 用户 ${user} 的 MC Token 已存在 ${hoursSinceLogin.toFixed(1)}h，按需刷新...`);
                    await refreshUserMicrosoftToken(user);
                    // 重新读取刷新后的账户列表
                    const refreshedUser = await db.getUser(user);
                    if (refreshedUser) {
                        targetUser.MinecraftAccounts = refreshedUser.MinecraftAccounts;
                    }
                }
            }
        } catch (refreshErr) {
            console.error(`[MinecraftAccounts] 按需刷新失败 user=${user}:`,
                refreshErr.code || 'provider_error');
            // 刷新失败不阻断列表返回，客户端仍可拿到现有数据
        }

        const accounts = (targetUser.MinecraftAccounts || []).map(({ refresh_token, ...account }) => account);

        const clientIp = getClientIp(req);
        await logUserAction(user, 'read_minecraft_accounts', `应用 ${app_id} 读取了 Minecraft 账户列表`, clientIp);

        res.json({
            status: 'success',
            username: user,
            accounts: accounts
        });
    });

    // Minecraft 档案页面路由
    app.get('/minecraft', async (req, res) => {
        const cookies = parseCookies(req.headers.cookie || '');
        const username = req.authUsername;
        if (!username) return res.redirect('/');
        const user = await db.getUser(username);
        if (!user) return res.redirect('/');
        res.send(generateMinecraftPageHtml(user));
    });

    // --- Minecraft 页面 HTML 生成 ---
    function generateMinecraftPageHtml(user) {
        const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;
        const escapeHtml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        return `
    <!DOCTYPE html>
    <html lang="${htmlLang()}">
    <head>
        <link rel="icon" href="/BL.png" type="image/png">
        <link rel="apple-touch-icon" href="/BL.png">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${t('Minecraft 档案 - Bloret PassPort')}</title>
        <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
                <style>
            .mc-account-list-card { padding: 0; overflow: hidden; }
            .mc-account-list .blora-list__item {
                align-items: center;
                cursor: pointer;
            }
            .mc-account-list .blora-list__item.active {
                background: var(--blora-color-action-primary-tint);
            }
            .mc-account-list .blora-list__item > img {
                flex: none;
                width: 32px;
                height: 32px;
                border-radius: var(--blora-radius-sm);
                background: var(--blora-color-surface-raised);
            }
            .mc-account-list .blora-list__meta { min-width: 0; }
            .mc-account-list .blora-list__title,
            .mc-account-list .blora-list__desc { overflow-wrap: anywhere; }
            .mc-account-list .view-mc-btn { flex: none; align-self: center; }
            .mc-profile-footer { display: flex; justify-content: flex-end; margin-top: 20px; }

            .mc-action-row {
                display: flex;
                gap: 10px;
                margin-bottom: 20px;
                flex-wrap: wrap;
            }

            /* 档案管理区域 */
            .mc-profile-panel {
                margin-top: 24px;
                padding-top: 20px;
                border-top: 1px solid var(--border);
            }
            .mc-profile-grid {
                display: flex;
                gap: 24px;
                align-items: flex-start;
                flex-wrap: wrap;
            }
            .mc-skin-preview {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 8px;
            }
            .mc-skin-preview img {
                border-radius: 8px;
                background: var(--muted, #f0f0f3);
                image-rendering: pixelated;
            }
            .mc-skin-label {
                font-size: 12px;
                color: var(--text-secondary, #666);
            }
            .mc-profile-empty {
                color: var(--text-secondary, #666);
                font-style: italic;
                padding: 16px 0;
            }
            .mc-variant-toggle {
                display: flex;
                gap: 8px;
                align-items: center;
                font-size: 13px;
                color: var(--text-secondary, #666);
            }
            .mc-variant-toggle select {
                padding: 4px 8px;
                border-radius: 6px;
                border: 1px solid var(--border);
                background: var(--background);
                color: var(--text-primary);
            }
            .mc-loading {
                display: inline-block;
                width: 14px;
                height: 14px;
                border: 2px solid var(--border);
                border-top-color: #0071e3;
                border-radius: 50%;
                animation: mc-spin 0.8s linear infinite;
                vertical-align: middle;
            }
            @keyframes mc-spin { to { transform: rotate(360deg); } }

            @media (max-width: 768px) {
                .mc-action-row {
                    flex-direction: column;
                }
                .mc-action-row .blora-button {
                    width: 100%;
                }
                .mc-account-list .blora-list__item {
                    align-items: flex-start;
                }
                .mc-account-list .view-mc-btn {
                    display: inline-flex;
                    margin-left: auto;
                }
                #offlineLoginDialog > div,
                #copyProfileDialog > div,
                #skinUploadDialog > div {
                    min-width: 0 !important;
                    width: 100%;
                    box-sizing: border-box;
                }
                .mc-profile-grid {
                    flex-direction: column;
                    align-items: stretch;
                }
            }
        </style>
    ${bloraAssetTags()}</head>
    <body class="blora-page blora-scope">
        ${generateSidebarHtml(user, 'minecraft')}

        <div class="main-content-apple">
            <h1 class="page-title">${t('Minecraft 档案')}</h1>
            <div class="user-info-card">
                <div class="post-title">${t('Minecraft 账户')}</div>
                <div class="post-content">
                    <div class="mc-action-row">
                        <button type="button" class="blora-button" data-variant="primary" onclick="window.location.href='/login/Minecraft/Microsoft/start'" >${t('微软登录')}</button>
                        <button type="button" class="blora-button" data-variant="outline" onclick="showOfflineDialog()" >${t('离线登录')}</button>
                    </div>

                    <div style="margin-top: 15px; width: 100%; display: flex; justify-content: center;">
                        <button type="button" class="blora-button" data-variant="primary" onclick="window.location.href='http://localhost:25252/sync/Minecraft_Account'" style="width: 100%;" >
                            ${t('同步到 Bloret Launcher')}
                        </button>
                    </div>

                    <div id="minecraft-accounts-list">
                        ${(user.MinecraftAccounts && user.MinecraftAccounts.length > 0) ? `
                        <div class="blora-card mc-account-list-card">
                            <div class="blora-list mc-account-list">
                                ${user.MinecraftAccounts.map(acc => {
                                    const uuid = escapeHtml(acc.uuid);
                                    const accountName = escapeHtml(acc.username);
                                    const typeLabel = acc.type === 'Microsoft' ? t('微软') : t('离线');
                                    const safeUuidArg = JSON.stringify(String(acc.uuid || ''));
                                    const safeTypeArg = JSON.stringify(String(acc.type || ''));
                                    const safeNameArg = JSON.stringify(String(acc.username || ''));
                                    const selectHandler = escapeHtml(`selectMcAccount(${safeUuidArg}, ${safeTypeArg}, ${safeNameArg})`);
                                    return `<div class="blora-list__item mc-account-item" role="button" tabindex="0" data-uuid="${uuid}" data-type="${escapeHtml(acc.type)}" data-name="${accountName}" onclick='${selectHandler}' onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ${selectHandler} }">
                                    <img src="https://visage.surgeplay.com/face/64/${encodeURIComponent(String(acc.username || ''))}" alt="${escapeHtml(t('Minecraft 头像'))}">
                                    <div class="blora-list__meta">
                                        <div class="blora-list__title">${accountName} <span class="mc-account-type">(${escapeHtml(typeLabel)})</span></div>
                                        <div class="blora-list__desc mc-account-uuid">${uuid}</div>
                                    </div>
                                    <button type="button" class="blora-button view-mc-btn" data-variant="outline" data-size="sm" onclick="event.stopPropagation(); selectMcAccount(${safeUuidArg}, ${safeTypeArg}, ${safeNameArg})" title="${escapeHtml(t('查看档案'))}">${t('查看')}</button>
                                </div>`;
                                }).join('')}
                            </div>
                        </div>` : `<blora-empty title="${escapeHtml(t('暂未绑定任何账户'))}"></blora-empty>`}
                    </div>
                </div>
            </div>

            <!-- 档案管理面板 -->
            <div class="user-info-card" id="mc-profile-card" hidden>
                <div class="post-title">${t('档案管理')} <span id="mc-profile-account-name" style="font-weight: normal; color: var(--text-secondary, #666); font-size: 14px;"></span></div>
                <div class="post-content">
                    <div id="mc-profile-content">
                        <p class="mc-profile-empty">${t('请在上方选择一个账户')}</p>
                    </div>
                    <div class="mc-profile-footer">
                        <button type="button" class="blora-button" data-variant="danger" onclick="removeSelectedMinecraftAccount()">${t('删除')}</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- 离线登录账户绑定对话框 -->
        <blora-dialog id="offlineLoginDialog"  >
            <div style="padding: 24px; min-width: 350px;">
                <h3 style="margin-top: 0; margin-bottom: 20px;">${t('绑定 Minecraft 离线账户')}</h3>
                <div style="margin-bottom: 20px;">
                    <label class="form-label" for="mcUsernameInput">${t('游戏玩家名:')}</label>
                    <input class="blora-input" type="text" id="mcUsernameInput" placeholder="${t('请输入玩家名')}" style="width: 100%;" >
                    <p style="font-size: 12px; color: #666; margin-top: 8px;">${t('* 将根据玩家名自动生成离线 UUID')}</p>
                </div>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button type="button" class="blora-button" data-variant="outline" onclick="hideOfflineDialog()" >${t('取消')}</button>
                    <button type="button" class="blora-button" data-variant="primary" onclick="submitOfflineBinding()" >${t('确认绑定')}</button>
                </div>
            </div>
        </blora-dialog>

        <!-- 上传皮肤对话框 -->
        <blora-dialog id="skinUploadDialog">
            <div style="padding: 24px; min-width: 380px;">
                <h3 style="margin-top: 0; margin-bottom: 20px;">${t('上传皮肤')}</h3>
                <div style="margin-bottom: 16px;">
                    <label class="form-label">${t('皮肤图片 (PNG):')}</label>
                    <input class="blora-input" type="file" id="skinFileInput" accept="image/png" style="width: 100%;">
                    <p style="font-size: 12px; color: #666; margin-top: 6px;">${t('* 仅支持 PNG 格式，建议 64x64 或 64x32')}</p>
                </div>
                <div style="margin-bottom: 20px;" class="mc-variant-toggle">
                    <label>${t('模型:')}</label>
                    <blora-select id="skinVariantSelect">
                        <blora-option value="classic">${t('经典 (Classic)')}</blora-option>
                        <blora-option value="slim">${t('纤细 (Slim)')}</blora-option>
                    </blora-select>
                </div>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button type="button" class="blora-button" data-variant="outline" onclick="hideSkinUploadDialog()">${t('取消')}</button>
                    <button type="button" class="blora-button" data-variant="primary" onclick="submitSkinUpload()">${t('上传')}</button>
                </div>
            </div>
        </blora-dialog>

        <!-- 复制档案对话框 -->
        <blora-dialog id="copyProfileDialog">
            <div style="padding: 24px; min-width: 380px;">
                <h3 style="margin-top: 0; margin-bottom: 8px;">${t('复制玩家档案')}</h3>
                <p style="font-size: 13px; color: var(--text-secondary, #666); margin: 0 0 16px;">${t('将其他玩家的皮肤复制到')} <strong id="copy-target-name"></strong></p>
                <div style="margin-bottom: 16px;">
                    <label class="form-label">${t('来源玩家名 / UUID:')}</label>
                    <input class="blora-input" type="text" id="copySourceInput" placeholder="${t('输入正版玩家名或 UUID')}" style="width: 100%;">
                    <p style="font-size: 12px; color: #666; margin-top: 6px;">${t('* 仅可复制皮肤；披风受 Mojang 限制，需通过官方切换')}</p>
                </div>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button type="button" class="blora-button" data-variant="outline" onclick="hideCopyProfileDialog()">${t('取消')}</button>
                    <button type="button" class="blora-button" data-variant="primary" onclick="submitCopyProfile()">${t('复制皮肤')}</button>
                </div>
            </div>
        </blora-dialog>

        <script>
        ${sidebarScript}

        function showOfflineDialog() {
            const dialog = document.getElementById('offlineLoginDialog');
            dialog.show();
            setTimeout(() => document.getElementById('mcUsernameInput').focus(), 100);
        }

        function hideOfflineDialog() {
            document.getElementById('offlineLoginDialog').hidden = true;
            document.getElementById('mcUsernameInput').value = '';
        }

        async function submitOfflineBinding() {
            const mcUsername = document.getElementById('mcUsernameInput').value.trim();
            if (!mcUsername) {
                alert(${scriptJson(t('请输入玩家名'))});
                return;
            }

            try {
                const response = await fetch('/login/Minecraft/Offline', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: mcUsername })
                });

                const result = await response.json();
                if (result.success) {
                    location.reload();
                } else {
                    alert(result.message || ${scriptJson(t('绑定失败'))});
                }
            } catch (error) {
                console.error(${scriptJson(t('绑定请求失败:'))}, error);
                alert(${scriptJson(t('服务器连接失败'))});
            }
        }

        async function removeMinecraftAccount(uuid, username) {
            if (!confirm(${scriptJson(t('确定要移除账户 "{username}" 吗？'))}.replace('{username}', username))) {
                return;
            }

            try {
                const response = await fetch('/login/Minecraft/Remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uuid: uuid })
                });

                const result = await response.json();
                if (result.success) {
                    location.reload();
                } else {
                    alert(result.message || ${scriptJson(t('移除失败'))});
                }
            } catch (error) {
                console.error(${scriptJson(t('移除请求失败:'))}, error);
                alert(${scriptJson(t('服务器连接失败'))});
            }
        }

        // ============ 档案管理 ============
        let selectedAccount = null; // { uuid, type, name }

        function removeSelectedMinecraftAccount() {
            if (selectedAccount) removeMinecraftAccount(selectedAccount.uuid, selectedAccount.name);
        }

        function selectMcAccount(uuid, type, name) {
            selectedAccount = { uuid, type, name };

            // 高亮选中项
            document.querySelectorAll('.mc-account-item').forEach(el => {
                el.classList.toggle('active', el.dataset.uuid === uuid);
            });

            const card = document.getElementById('mc-profile-card');
            const nameEl = document.getElementById('mc-profile-account-name');
            const content = document.getElementById('mc-profile-content');
            card.hidden = false;
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            nameEl.textContent = '— ' + name + ' (' + (type === 'Microsoft' ? ${scriptJson(t('微软'))} : ${scriptJson(t('离线'))}) + ')';

            if (type !== 'Microsoft') {
                content.innerHTML = '<p class="mc-profile-empty">${t('离线账号没有可管理的在线档案。如需管理皮肤，请绑定微软账号。')}</p>';
                return;
            }
            loadProfile(uuid);
        }

        async function loadProfile(uuid) {
            const content = document.getElementById('mc-profile-content');
            content.innerHTML = '<p class="mc-profile-empty"><span class="mc-loading"></span> ${t('正在读取档案…')}</p>';
            try {
                const resp = await fetch('/api/minecraft/profile/' + encodeURIComponent(uuid));
                const data = await resp.json();
                if (!data.success) {
                    content.innerHTML = '<p class="mc-profile-empty">' + (data.message || ${scriptJson(t('读取档案失败'))}) + '</p>';
                    return;
                }
                renderProfile(data.profile, data.account);
            } catch (e) {
                console.error(${scriptJson(t('读取档案失败:'))}, e);
                content.innerHTML = '<p class="mc-profile-empty">${t('服务器连接失败')}</p>';
            }
        }

        function renderProfile(profile, account) {
            const content = document.getElementById('mc-profile-content');
            const skins = (profile && profile.skins) || [];
            const capes = (profile && profile.capes) || [];
            const activeSkin = skins.find(s => s.state === 'ACTIVE') || skins[0];
            const activeCape = capes.find(c => c.state === 'ACTIVE');

            const skinUrl = activeSkin ? activeSkin.url : null;
            const capeUrl = activeCape ? activeCape.url : null;

            content.innerHTML = \`
                <div class="mc-profile-grid">
                    <div class="mc-skin-preview">
                        <img src="\${skinUrl ? skinUrl : 'https://visage.surgeplay.com/full/120/' + encodeURIComponent(account.username)}" width="120" height="180" alt="skin">
                        <span class="mc-skin-label">${t('皮肤预览')}</span>
                    </div>
                    <div class="mc-skin-preview">
                        <img src="\${capeUrl ? capeUrl : ''}" width="100" height="80" alt="cape" style="background: var(--muted, #f0f0f3); \${capeUrl ? '' : 'opacity:0.3;'}">
                        <span class="mc-skin-label">\${capeUrl ? ${scriptJson(t('当前披风'))} : ${scriptJson(t('无披风'))}}</span>
                    </div>
                </div>
            \`;
        }

        // --- 上传皮肤 ---
        function showSkinUploadDialog() {
            if (!selectedAccount || selectedAccount.type !== 'Microsoft') return;
            document.getElementById('skinUploadDialog').show();
        }
        function hideSkinUploadDialog() {
            document.getElementById('skinUploadDialog').close();
            document.getElementById('skinFileInput').value = '';
        }
        async function submitSkinUpload() {
            if (!selectedAccount) return;
            const fileInput = document.getElementById('skinFileInput');
            const variant = document.getElementById('skinVariantSelect').value;
            const file = fileInput.files[0];
            if (!file) { alert(${scriptJson(t('请选择皮肤文件'))}); return; }
            if (file.type !== 'image/png') { alert(${scriptJson(t('仅支持 PNG 格式'))}); return; }

            const reader = new FileReader();
            reader.onload = async function(e) {
                const base64 = e.target.result.split(',')[1];
                try {
                    const resp = await fetch('/api/minecraft/skin/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uuid: selectedAccount.uuid, variant, base64 })
                    });
                    const data = await resp.json();
                    if (data.success) {
                        hideSkinUploadDialog();
                        loadProfile(selectedAccount.uuid);
                    } else {
                        alert(data.message || ${scriptJson(t('上传失败'))});
                    }
                } catch (err) {
                    console.error('上传皮肤失败:', err);
                    alert(${scriptJson(t('服务器连接失败'))});
                }
            };
            reader.readAsDataURL(file);
        }

        // --- 复制档案 ---
        function showCopyProfileDialog() {
            if (!selectedAccount || selectedAccount.type !== 'Microsoft') return;
            document.getElementById('copy-target-name').textContent = selectedAccount.name;
            document.getElementById('copyProfileDialog').show();
        }
        function hideCopyProfileDialog() {
            document.getElementById('copyProfileDialog').close();
            document.getElementById('copySourceInput').value = '';
        }
        async function submitCopyProfile() {
            if (!selectedAccount) return;
            const src = document.getElementById('copySourceInput').value.trim();
            if (!src) { alert(${scriptJson(t('请输入来源玩家名或 UUID'))}); return; }

            const isUuid = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(src) || /^[0-9a-fA-F]{32}$/.test(src);
            const body = { targetUuid: selectedAccount.uuid };
            if (isUuid) body.sourceUuid = src; else body.sourceName = src;

            try {
                const resp = await fetch('/api/minecraft/profile/copy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await resp.json();
                if (data.success) {
                    alert(data.message || ${scriptJson(t('复制成功'))});
                    hideCopyProfileDialog();
                    loadProfile(selectedAccount.uuid);
                } else {
                    alert(data.message || ${scriptJson(t('复制失败'))});
                }
            } catch (err) {
                console.error('复制档案失败:', err);
                alert(${scriptJson(t('服务器连接失败'))});
            }
        }

        // --- 重置皮肤 ---
        async function resetSkin() {
            if (!selectedAccount) return;
            if (!confirm(${scriptJson(t('确定要重置皮肤为默认吗？'))})) return;
            try {
                const resp = await fetch('/api/minecraft/skin/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uuid: selectedAccount.uuid })
                });
                const data = await resp.json();
                if (data.success) { loadProfile(selectedAccount.uuid); }
                else { alert(data.message || ${scriptJson(t('重置失败'))}); }
            } catch (err) {
                console.error('重置皮肤失败:', err);
                alert(${scriptJson(t('服务器连接失败'))});
            }
        }

        // --- 隐藏披风 ---
        async function hideCape() {
            if (!selectedAccount) return;
            if (!confirm(${scriptJson(t('确定要隐藏当前披风吗？'))})) return;
            try {
                const resp = await fetch('/api/minecraft/cape/hide', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uuid: selectedAccount.uuid })
                });
                const data = await resp.json();
                if (data.success) { loadProfile(selectedAccount.uuid); }
                else { alert(data.message || ${scriptJson(t('隐藏失败'))}); }
            } catch (err) {
                console.error('隐藏披风失败:', err);
                alert(${scriptJson(t('服务器连接失败'))});
            }
        }
        </script>
    </body>
    </html>
        `;
    }

    return {
        autoRefreshAllMicrosoftTokens,
        MC_TOKEN_AUTO_REFRESH_INTERVAL_MS
    };
};
