const express = require('express');
const router = express.Router();
const axios = require('axios');
const { pool } = require('../models/database');
const Logger = require('../logger');
const config = require('../config-loader');
const { reportLoginEvent } = require('../utils/login-reporter');
const { displayName } = require('../display-name');

// GitHub OAuth 配置
const GITHUB_CLIENT_ID = config.github?.clientId || '';
const GITHUB_CLIENT_SECRET = config.github?.clientSecret || '';
const GITHUB_REDIRECT_URI = config.github?.redirectUri || 'https://studio.crantai.com/auth/github/callback';

Logger.info(`[GitHub OAuth] Client ID: ${GITHUB_CLIENT_ID}`);
Logger.info(`[GitHub OAuth] Redirect URI: ${GITHUB_REDIRECT_URI}`);

// GitHub 登录入口
router.get('/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    Logger.error('[GitHub OAuth] Client ID 未配置');
    return res.status(500).json({ error: 'GitHub OAuth 未配置' });
  }

  const scope = 'user:email';
  const state = req.query.state || '';
  
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=${scope}&redirect_uri=${encodeURIComponent(GITHUB_REDIRECT_URI)}&state=${state}`;
  Logger.info(`[GitHub 登录] 重定向到: ${authUrl}`);
  res.redirect(authUrl);
});

// GitHub OAuth 回调
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;

  Logger.info(`[GitHub 回调] 收到回调 code=${code ? '有' : '无'}, state=${state}`);

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // 用 code 换取 access_token
    const tokenResponse = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code: code,
      redirect_uri: GITHUB_REDIRECT_URI
    }, {
      headers: { Accept: 'application/json' }
    });

    const accessToken = tokenResponse.data.access_token;
    Logger.info(`[GitHub 回调] access_token 获取${accessToken ? '成功' : '失败'}`);

    if (!accessToken) {
      Logger.error('[GitHub 登录] 获取 access_token 失败:', tokenResponse.data);
      return res.redirect('/?error=token_failed');
    }

    // 获取用户信息
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `token ${accessToken}` }
    });

    const githubUser = userResponse.data;
    const githubId = String(githubUser.id);
    Logger.info(`[GitHub 回调] GitHub 用户: ${githubUser.login} (ID: ${githubId})`);

    // 查找已绑定此 GitHub ID 的用户
    const existingUser = await pool.query('SELECT * FROM users WHERE github_id = $1', [githubId]);
    Logger.info(`[GitHub 回调] 找到 ${existingUser.rows.length} 个已绑定用户`);

    if (existingUser.rows.length > 0) {
      // 用户已绑定，直接登录
      const user = existingUser.rows[0];
      
      req.session.user = {
        id: user.id,
        username: user.username,
        nickname: displayName(user, user.username),
        email: user.email,
        avatar: user.avatar,
        isAdmin: user.is_admin,
        balance: user.balance,
        refund_balance: user.refund_balance || 0,
        api_signature_enabled: user.api_signature_enabled === true,
        api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}'
      };

      Logger.info(`[GitHub 登录] 用户 ${user.username} 通过 GitHub 登录`);
      req.session.save((err) => {
        if (err) {
          Logger.error('[GitHub 登录] Session 保存失败:', err);
          return res.redirect('/?error=session_failed');
        }
        // 登录状态上报（fire-and-forget）
        reportLoginEvent(req);
        Logger.info(`[GitHub 登录] Session 保存成功，重定向到控制台`);
        res.redirect('/console');
      });
    } else {
      // 未绑定，获取 GitHub 用户邮箱
      let githubEmail = githubUser.email;
      if (!githubEmail) {
        try {
          const emailResponse = await axios.get('https://api.github.com/user/emails', {
            headers: { Authorization: `token ${accessToken}` }
          });
          const primaryEmail = emailResponse.data.find(e => e.primary && e.verified);
          if (primaryEmail) githubEmail = primaryEmail.email;
        } catch (e) {
          Logger.warn(`[GitHub 回调] 获取邮箱失败: ${e.message}`);
        }
      }

      // 如果有邮箱，检查是否已注册
      if (githubEmail) {
        const emailUser = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [githubEmail]);
        if (emailUser.rows.length > 0) {
          // 邮箱已注册，绑定 GitHub 并登录
          const user = emailUser.rows[0];
          await pool.query('UPDATE users SET github_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [githubId, user.id]);

          req.session.user = {
            id: user.id,
            username: user.username,
            nickname: displayName(user, user.username),
            email: user.email,
            avatar: user.avatar,
            isAdmin: user.is_admin,
            balance: user.balance,
            refund_balance: user.refund_balance || 0,
            api_signature_enabled: user.api_signature_enabled === true,
            api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}'
          };

          Logger.info(`[GitHub 登录] 邮箱 ${githubEmail} 已注册，绑定 GitHub 并登录用户 ${user.username}`);
          req.session.save((err) => {
            if (err) {
              Logger.error('[GitHub 登录] Session 保存失败:', err);
              return res.redirect('/?error=session_failed');
            }
            // 登录状态上报（fire-and-forget）
            reportLoginEvent(req);
            res.redirect('/console');
          });
          return;
        }
      }

      // 未注册，提示用户联系管理员
      Logger.info(`[GitHub 登录] 新用户 ${githubUser.login} 尝试登录但未注册，已拒绝`);
      res.redirect('/?error=account_not_found');
    }
  } catch (error) {
    Logger.error('[GitHub 登录] 错误:', error);
    res.redirect('/?error=github_error');
  }
});

// 解绑 GitHub
router.post('/github/unbind', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: '请先登录' });
    }

    const userId = req.session.user.id;
    await pool.query('UPDATE users SET github_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
    
    Logger.info(`[GitHub 解绑] 用户 ${req.session.user.username} 解绑了 GitHub 账号`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[GitHub 解绑] 错误:', error);
    res.status(500).json({ error: '解绑失败' });
  }
});

// 获取 GitHub 绑定状态
router.get('/github/status', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: '请先登录' });
    }

    const userId = req.session.user.id;
    const result = await pool.query('SELECT github_id FROM users WHERE id = $1', [userId]);
    
    res.json({ 
      bound: !!result.rows[0]?.github_id,
      githubId: result.rows[0]?.github_id || null
    });
  } catch (error) {
    Logger.error('[GitHub 状态] 错误:', error);
    res.status(500).json({ error: '获取状态失败' });
  }
});

module.exports = router;
