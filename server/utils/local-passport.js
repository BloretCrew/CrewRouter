'use strict';
const crypto = require('crypto');

const STATE_TTL_MS = 5 * 60 * 1000;
const pendingStates = new Map();

function localError(message) {
  return Object.assign(new Error(message), { code: 'LOCAL_PASSPORT_DENIED' });
}

function validateLocalToken(req, token = process.env.CR_LOCAL_TOKEN) {
  const supplied = req.get('x-crewrouter-desktop-token');
  if (typeof token !== 'string' || !token || typeof supplied !== 'string') throw localError('Desktop token 无效');
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw localError('Desktop token 无效');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) throw localError('仅允许本机访问');
}

function localOrigin(req, port) {
  const host = req.get('host');
  if (typeof host !== 'string' || req.protocol !== 'http') throw localError('Local origin 无效');
  let url;
  try { url = new URL(`http://${host}`); } catch (_) { throw localError('Local origin 无效'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || Number(url.port || 80) !== Number(port)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || host !== url.host) throw localError('Local origin 无效');
  const requested = req.query.redirect_origin;
  if (requested !== undefined && (typeof requested !== 'string' || requested !== url.origin)) throw localError('回调必须使用当前 Local origin');
  return url.origin;
}

function issueState(req, origin, now = Date.now()) {
  for (const [state, pending] of pendingStates) {
    if (pending.expiresAt <= now || pending.sessionIds.has(req.sessionID)) {
      pending.revoked = true;
      pendingStates.delete(state);
    }
  }
  if (pendingStates.size >= 1000) throw localError('待处理授权过多');
  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.set(state, { sessionId: req.sessionID, sessionIds: new Set([req.sessionID]), origin, expiresAt: now + STATE_TTL_MS, consumed: false, revoked: false });
  req.session.localPassportState = state;
  return state;
}

function consumeState(req, origin, now = Date.now()) {
  const state = req.query.state;
  const pending = typeof state === 'string' ? pendingStates.get(state) : null;
  if (!pending || pending.consumed || pending.revoked || pending.sessionId !== req.sessionID || req.session.localPassportState !== state) throw localError('PassPort 登录状态无效');
  // 在任何异步验证之前消费，阻止并发回调和失败后的重放。
  pending.consumed = true;
  delete req.session.localPassportState;
  if (pending.expiresAt <= now || pending.origin !== origin) {
    pending.revoked = true;
    pendingStates.delete(state);
    throw localError('PassPort 登录状态已过期或 origin 不匹配');
  }
  if (typeof req.query.code !== 'string' || !req.query.code.trim() || req.query.code.length > 4096) {
    pendingStates.delete(state);
    throw localError('PassPort 授权码无效');
  }
  return pending;
}

function cancelSession(req, secret) {
  const sessionIds = new Set([req.sessionID]);
  // regenerate 已删除旧存储记录时，express-session 会分配新 ID；仍须撤销 Cookie 指向的旧授权。
  if (secret && req.headers?.cookie) {
    try {
      const signed = require('cookie').parse(req.headers.cookie)['connect.sid'];
      if (signed?.startsWith('s:')) {
        for (const key of Array.isArray(secret) ? secret : [secret]) {
          const id = require('cookie-signature').unsign(signed.slice(2), key);
          if (id) sessionIds.add(id);
        }
      }
    } catch (_) { /* 无效 Cookie 不作为撤销依据。 */ }
  }
  for (const [state, pending] of pendingStates) {
    if ([...sessionIds].some(id => pending.sessionIds.has(id))) {
      pending.revoked = true;
      pendingStates.delete(state);
    }
  }
}

function assertActive(pending, now = Date.now()) {
  if (pending.revoked || pending.expiresAt <= now) throw localError('PassPort 授权已取消或过期');
}

function finishState(pending) {
  for (const [state, item] of pendingStates) {
    if (item === pending) pendingStates.delete(state);
  }
}

function passportIdentity(data) {
  if (typeof data.username !== 'string' || !data.username.trim() || data.username.trim().length > 255
    || typeof data.apptoken !== 'string' || !data.apptoken.trim()) throw localError('PassPort 身份无效');
  return data.username.trim();
}

function hasPasskeys(value) {
  if (value == null) return false;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return true; }
  }
  return !Array.isArray(value) || value.length > 0;
}

function chooseLocalUser(users, identity) {
  const bound = users.filter(user => user.passport_username);
  if (bound.length) {
    if (bound.length !== 1 || bound[0].passport_username !== identity || bound[0].is_admin !== true) throw localError('此 Local 实例已绑定其他身份');
    return bound[0];
  }
  if (!users.length) return null;
  // displayName 不是身份证据；旧版本只创建无密码、无邮箱、无第三方身份的唯一管理员。
  const admins = users.filter(user => user.is_admin === true);
  if (users.length !== 1 || admins.length !== 1) throw localError('无法安全识别旧 Local 管理员');
  const user = admins[0];
  if (user.email || user.password_hash || user.github_id || user.feishu_open_id || user.two_factor_enabled || hasPasskeys(user.passkeys)) throw localError('旧管理员具有其他认证身份，拒绝自动绑定');
  return user;
}

async function bindLocalUser(client, identity, createUser) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('crewrouter-desktop-local-passport'))");
  const result = await client.query('SELECT * FROM users ORDER BY id FOR UPDATE');
  let user = chooseLocalUser(result.rows, identity);
  if (!user) return createUser();
  if (!user.passport_username) {
    const updated = await client.query('UPDATE users SET passport_username = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', [identity, user.id]);
    user = updated.rows[0];
  }
  return user;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

function localSessionGuard(pool) {
  return async (req, res, next) => {
    if (!req.session?.user) return next();
    const user = req.session.user;
    try {
      let valid = false;
      if (req.session.localPassportAuth === true && !user.local && typeof user.passportUsername === 'string') {
        const result = await pool.query('SELECT passport_username, is_admin FROM users WHERE id = $1', [user.id]);
        valid = result.rows.length === 1 && result.rows[0].passport_username === user.passportUsername && result.rows[0].is_admin === true;
      }
      if (valid) return next();
      await regenerateSession(req);
      return next();
    } catch (error) {
      return res.status(503).json({ error: 'Local 认证状态暂不可用' });
    }
  };
}

async function ensureDesktopLocalPersonalTeam(client, user) {
  const existing = await client.query(
    `SELECT t.id FROM teams t
     JOIN user_teams ut ON ut.team_id = t.id
     WHERE ut.user_id = $1 AND t.is_personal = TRUE
     LIMIT 1`,
    [user.id]
  );
  if (existing.rows.length) return existing.rows[0];
  const team = await client.query(
    'INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id',
    [`${user.username} 的个人账户`, '个人账户，系统自动创建']
  );
  await client.query(
    'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [user.id, team.rows[0].id]
  );
  return team.rows[0];
}

async function ensureDesktopLocalPersonalModels(client, team) {
  await client.query(
    `INSERT INTO team_models (team_id, model_id)
     SELECT $1, m.id FROM models m
     JOIN providers p ON p.id = m.provider
     WHERE m.enabled = TRUE AND p.enabled = TRUE
     ON CONFLICT (team_id, model_id) DO NOTHING`,
    [team.id]
  );
}


module.exports = { ensureDesktopLocalPersonalTeam, ensureDesktopLocalPersonalModels, STATE_TTL_MS, validateLocalToken, localOrigin, issueState, consumeState, cancelSession, assertActive, finishState, passportIdentity, chooseLocalUser, bindLocalUser, regenerateSession, localSessionGuard };
