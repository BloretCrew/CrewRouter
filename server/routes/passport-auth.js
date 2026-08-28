const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/database');
const config = require('../config-loader');
const Logger = require('../logger');
const { getAuthMode } = require('../utils/auth-mode');
const { validateInvite } = require('./auth-invites');

const router = express.Router();
const passport = config.passport || {};
const baseUrl = 'https://passport.bloret.net';

function redirectUri(req) {
  return passport.redirectCallbackHost || `${req.protocol || 'https'}://${req.get('host')}/auth/passport/callback`;
}
function sessionUser(user) {
  return { id: user.id, username: user.username, email: user.email, avatar: user.avatar, isAdmin: user.is_admin, balance: parseFloat(user.balance || 0), refund_balance: parseFloat(user.refund_balance || 0), api_signature_enabled: user.api_signature_enabled === true, api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}' };
}

router.get('/passport', async (req, res) => {
  if (await getAuthMode() !== 'passport') return res.redirect('/?error=passport_disabled');
  if (!passport.appId || !passport.appSecret) return res.redirect('/?error=passport_not_configured');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.passportState = state;
  const params = new URLSearchParams({ app_id: passport.appId, redirect_uri: redirectUri(req), state });
  res.redirect(`${baseUrl}/app/oauth?${params}`);
});

router.get('/passport/callback', async (req, res) => {
  const { code, state, invite } = req.query;
  if (!state || state !== req.session.passportState) return res.status(400).send('PassPort 登录状态无效，请返回重试。');
  delete req.session.passportState;
  if (!code) return res.status(400).send('PassPort 未返回授权码。');
  try {
    const response = await fetch(`${baseUrl}/app/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_id: passport.appId, app_secret: passport.appSecret, code }),
    });
    const data = await response.json();
    if (!response.ok || data.error || data.code && data.code !== 0) throw new Error(data.error || data.message || data.msg || 'PassPort 验证失败');
    const passportUsername = String(data.username || '').trim();
    if (!passportUsername) throw new Error('PassPort 未返回用户名');
    let result = await pool.query('SELECT * FROM users WHERE passport_username = $1', [passportUsername]);
    let user = result.rows[0];
    if (!user) {
      const validInvite = await validateInvite(invite);
      if (!validInvite) return res.status(403).send('该登录需要有效邀请链接，请使用管理员提供的邀请链接访问。');
      const nickname = String(data.nickname || passportUsername).trim();
      let username = nickname || passportUsername;
      const collision = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (collision.rows.length) username = `${username}_pp`;
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE');
      result = await pool.query(
        `INSERT INTO users (username, passport_username, email, avatar, is_admin, email_verified, balance)
         VALUES ($1, $2, $3, $4, $5, TRUE, 10) RETURNING *`,
        [username, passportUsername, data.email || null, data.avatar || null, count.rows[0].count === 0]
      );
      user = result.rows[0];
      await pool.query('UPDATE auth_invites SET used = TRUE, used_by = $1, used_at = CURRENT_TIMESTAMP WHERE id = $2', [user.id, validInvite.id]);
      try { await require('../utils/inject-prompt').seedDefaultPrompt(user.id); } catch (err) { Logger.warn('[PassPort] 默认提示词播种跳过:', err.message); }
      try {
        const group = await pool.query('SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1');
        if (group.rows.length) await pool.query('UPDATE users SET group_id = $1 WHERE id = $2', [group.rows[0].id, user.id]);
        const team = await pool.query('SELECT id FROM teams WHERE is_default = TRUE LIMIT 1');
        if (team.rows.length) await pool.query('INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, team.rows[0].id]);
      } catch (err) { Logger.warn('[PassPort] 默认组播种跳过:', err.message); }
    }
    req.session.user = sessionUser(user);
    req.session.user.passportUsername = passportUsername;
    req.session.save((err) => err ? res.status(500).send('登录会话保存失败，请重试。') : res.redirect('/console'));
  } catch (err) {
    Logger.error('[PassPort] 回调失败:', err.message);
    res.status(502).send('PassPort 登录失败，请稍后重试。');
  }
});

module.exports = router;
