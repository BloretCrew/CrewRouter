const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = process.env.RP_NAME || 'CrewRouter';

// 内存存储挑战码（短时有效；进程重启后失效）
const challenges = new Map();

// 挑战码 5 分钟过期
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * 将 Buffer / Uint8Array 转换为 base64url 字符串
 */
function bufferToBase64url(buffer) {
    if (!buffer) return '';
    if (typeof buffer === 'string') return buffer;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return buf.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * 将 base64url 字符串转换为 Buffer / Uint8Array
 */
function base64urlToBuffer(base64url) {
    if (!base64url) return Buffer.alloc(0);
    if (Buffer.isBuffer(base64url) || base64url instanceof Uint8Array) {
        return Buffer.from(base64url);
    }
    // 兼容错误入库的 Buffer JSON 形态 { type: 'Buffer', data: [...] }
    if (typeof base64url === 'object' && Array.isArray(base64url.data)) {
        return Buffer.from(base64url.data);
    }
    // 兼容错误入库的 Uint8Array 对象形态 { "0": 1, "1": 2, ... }
    if (typeof base64url === 'object' && !Array.isArray(base64url)) {
        const keys = Object.keys(base64url).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
        if (keys.length > 0) {
            return Buffer.from(keys.map(k => base64url[k]));
        }
    }

    let base64 = String(base64url)
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const pad = base64.length % 4;
    if (pad) {
        base64 += '='.repeat(4 - pad);
    }

    return Buffer.from(base64, 'base64');
}

/**
 * 从请求推导 RP ID 与 Origin
 * 可用环境变量 RP_ID / ORIGIN 覆盖
 */
function getWebAuthnConfig(req) {
    const hostHeader = req?.get?.('host') || req?.headers?.host || '';
    const hostname = (req?.hostname || hostHeader.split(':')[0] || '').split(':')[0];
    const rpID = process.env.RP_ID || hostname || 'localhost';
    const proto = req?.protocol || (req?.secure ? 'https' : 'http') || 'https';
    const origin = process.env.ORIGIN || (hostHeader ? `${proto}://${hostHeader}` : `https://${rpID}`);
    return { rpID, origin, rpName: RP_NAME };
}

function setChallenge(key, challenge) {
    challenges.set(String(key), {
        challenge: typeof challenge === 'string' ? challenge : bufferToBase64url(challenge),
        expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
}

function getChallenge(key) {
    const entry = challenges.get(String(key));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        challenges.delete(String(key));
        return null;
    }
    return entry.challenge;
}

function deleteChallenge(key) {
    challenges.delete(String(key));
}

function normalizePasskeys(passkeys) {
    if (!passkeys) return [];
    if (typeof passkeys === 'string') {
        try {
            passkeys = JSON.parse(passkeys);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(passkeys)) return [];
    return passkeys.filter(pk => pk && pk.credentialID);
}

function toExcludeCredentials(passkeys) {
    return normalizePasskeys(passkeys).map(pk => ({
        id: typeof pk.credentialID === 'string' ? pk.credentialID : bufferToBase64url(pk.credentialID),
        transports: Array.isArray(pk.transports) ? pk.transports : undefined,
    }));
}

class PassKeyManager {
    /**
     * 生成注册选项（返回 JSON-safe，可直接 res.json）
     */
    async getRegistrationOptions(user, { rpID, excludeCredentials } = {}) {
        try {
            const userIdStr = String(user.id);
            const userEncodedID = new TextEncoder().encode(userIdStr);
            const exclude = excludeCredentials || toExcludeCredentials(user.passkeys);

            const options = await generateRegistrationOptions({
                rpName: RP_NAME,
                rpID: rpID || process.env.RP_ID || 'localhost',
                userID: userEncodedID,
                userName: user.username || user.email || userIdStr,
                userDisplayName: user.username || user.email || userIdStr,
                attestationType: 'none',
                excludeCredentials: exclude,
                authenticatorSelection: {
                    residentKey: 'preferred',
                    userVerification: 'preferred',
                    authenticatorAttachment: undefined,
                },
            });

            // options.challenge 已是 base64url 字符串
            setChallenge(`reg:${userIdStr}`, options.challenge);
            return options;
        } catch (error) {
            console.error('PassKey 生成注册选项失败:', error);
            throw error;
        }
    }

    /**
     * 验证注册响应，返回可入库的规范化 passkey 对象
     * body 必须是 RegistrationResponseJSON（base64url 字符串，禁止转 Buffer）
     */
    async verifyRegistration(userId, body, { origin, rpID } = {}) {
        const expectedChallenge = getChallenge(`reg:${userId}`);
        if (!expectedChallenge) {
            throw new Error('注册挑战码不存在或已过期，请重试');
        }

        try {
            // @simplewebauthn/server v13 要求 response 为 base64url 字符串 JSON
            const verification = await verifyRegistrationResponse({
                response: body,
                expectedChallenge,
                expectedOrigin: origin,
                expectedRPID: rpID,
                requireUserVerification: false,
            });

            if (!verification.verified || !verification.registrationInfo) {
                throw new Error('注册验证未通过');
            }

            deleteChallenge(`reg:${userId}`);

            const info = verification.registrationInfo;
            const credential = info.credential;

            return {
                credentialID: credential.id,
                credentialPublicKey: bufferToBase64url(credential.publicKey),
                counter: Number(credential.counter || 0),
                deviceType: info.credentialDeviceType || 'unknown',
                backedUp: !!info.credentialBackedUp,
                transports: credential.transports || body?.response?.transports || [],
                createdAt: new Date().toISOString(),
            };
        } catch (error) {
            console.error('PassKey 注册验证异常:', error);
            throw error;
        }
    }

    /**
     * 生成认证（登录）选项
     * userPasskeys 为空时不传 allowCredentials，支持可发现凭证登录
     */
    async getAuthenticationOptions(userPasskeys, { rpID } = {}) {
        try {
            const validPasskeys = normalizePasskeys(userPasskeys);
            let allowCredentials;

            if (validPasskeys.length > 0) {
                allowCredentials = validPasskeys.map(key => ({
                    id: typeof key.credentialID === 'string'
                        ? key.credentialID
                        : bufferToBase64url(key.credentialID),
                    transports: Array.isArray(key.transports) ? key.transports : undefined,
                }));
            }

            const options = await generateAuthenticationOptions({
                rpID: rpID || process.env.RP_ID || 'localhost',
                allowCredentials,
                userVerification: 'preferred',
            });

            setChallenge(`auth:${options.challenge}`, options.challenge);
            return options;
        } catch (error) {
            console.error('PassKey 生成登录选项失败:', error);
            throw error;
        }
    }

    /**
     * 验证登录断言
     * body 必须是 AuthenticationResponseJSON（base64url 字符串）
     */
    async verifyAuthentication(passkey, body, challengeFromClient, { origin, rpID } = {}) {
        const expectedChallenge = getChallenge(`auth:${challengeFromClient}`) || getChallenge(challengeFromClient);
        if (!expectedChallenge) {
            throw new Error('服务器挑战码失效，请刷新重试');
        }

        try {
            const credentialID = typeof passkey.credentialID === 'string'
                ? passkey.credentialID
                : bufferToBase64url(passkey.credentialID);

            const publicKey = base64urlToBuffer(passkey.credentialPublicKey);

            const credential = {
                id: credentialID,
                publicKey: new Uint8Array(publicKey),
                counter: Number(passkey.counter || 0),
                transports: passkey.transports,
            };

            const verification = await verifyAuthenticationResponse({
                response: body,
                expectedChallenge,
                expectedOrigin: origin,
                expectedRPID: rpID,
                credential,
                requireUserVerification: false,
            });

            if (!verification.verified) {
                throw new Error('身份验证未通过');
            }

            deleteChallenge(`auth:${challengeFromClient}`);
            deleteChallenge(challengeFromClient);

            return verification.authenticationInfo;
        } catch (error) {
            console.error('PassKey 登录验证异常:', error);
            throw error;
        }
    }
}

module.exports = new PassKeyManager();
module.exports.getWebAuthnConfig = getWebAuthnConfig;
module.exports.bufferToBase64url = bufferToBase64url;
module.exports.base64urlToBuffer = base64urlToBuffer;
module.exports.normalizePasskeys = normalizePasskeys;
