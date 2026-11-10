'use strict';

const {
  loadConfig,
  saveRemoteProfile,
  ensureLocalProfile,
  setActiveProfile,
  getSession,
  clearSession,
  normalizeBaseUrl,
  isLoopbackBase,
} = require('../config');
const { createContext, persistClientSession, ensureAuthenticated } = require('../context');
const { loginPassword, completeTwoFactor, loginApiKey, logout, TwoFactorRequired } = require('../auth');
const { probeHealth } = require('../service');
const { ask, askSecret, readAll } = require('../input');
const { printJson, success, describeError } = require('../output');
const { bold, green, yellow, dim } = require('../format');

function profileNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/[^A-Za-z0-9.-]/g, '-');
    return host && host !== '127.0.0.1' && host !== 'localhost' ? host : 'remote';
  } catch (_) { return 'remote'; }
}

function prepareProfile(args) {
  let cfg = loadConfig();
  if (args.url) {
    const url = normalizeBaseUrl(args.url);
    const name = args.profile || args.name || profileNameFromUrl(url);
    saveRemoteProfile(name, url, { makeCurrent: true, displayName: args.name });
    return { cfg: loadConfig(), name };
  }
  if (args.profile) {
    if (!cfg.profiles[args.profile]) throw new Error(`profile 不存在：${args.profile}`);
    setActiveProfile(args.profile, cfg);
    return { cfg: loadConfig(), name: args.profile };
  }
  const envUrl = process.env.CREWROUTER_URL || process.env.CR_URL;
  if (envUrl) {
    const url = normalizeBaseUrl(envUrl);
    const name = profileNameFromUrl(url);
    saveRemoteProfile(name, url, { makeCurrent: true });
    return { cfg: loadConfig(), name };
  }
  if (!cfg.currentProfile) {
    cfg = ensureLocalProfile({ port: args.port, configPath: args.config, makeCurrent: true });
    return { cfg, name: cfg.currentProfile };
  }
  return { cfg, name: cfg.currentProfile };
}

async function readSecretInput(args, kind) {
  if (kind === 'api-key') {
    const apiKeyArg = args['api-key'] !== undefined ? args['api-key'] : args.apiKey;
    if (apiKeyArg !== undefined) {
      if (typeof apiKeyArg !== 'string' || !apiKeyArg) throw new Error('--api-key 需要一个值，或改用 --api-key-stdin');
      return apiKeyArg;
    }
    if (args['api-key-stdin']) {
      const value = (await readAll()).trim();
      if (!value) throw new Error('stdin 中没有 API Key');
      return value;
    }
    return (await askSecret('API Key：')).trim();
  }
  if (args.password) throw new Error('出于安全考虑不支持通过 --password 传递密码，请使用 --password-stdin 或交互输入');
  if (args['password-stdin']) {
    const value = (await readAll()).replace(/\r?\n$/, '');
    if (!value) throw new Error('stdin 中没有密码');
    return value;
  }
  return askSecret('密码：');
}

async function loginCommand(args, { json = false } = {}) {
  const { cfg, name } = prepareProfile(args);
  const context = createContext({ ...args, url: null, profile: name });
  const health = await probeHealth(context.client.baseUrl, { timeoutMs: 2000 });
  if (!health.ok) throw new Error(`无法连接 ${context.client.baseUrl}：${health.error || '连接失败'}`);
  if (/^http:/i.test(context.client.baseUrl) && !isLoopbackBase(context.client.baseUrl)) {
    console.log(yellow('警告：远程 HTTP 连接不会加密密码或会话 Cookie，生产环境请使用 HTTPS。'));
  }
  if (health.setup && (health.setup.needsSetup || health.setup.needsEdition)) {
    console.log(yellow(`实例尚未完成初始化，请先在浏览器打开 ${context.client.baseUrl}/setup`));
    return 1;
  }
  const methods = health.instance && health.instance.auth && Array.isArray(health.instance.auth.methods)
    ? health.instance.auth.methods : ['password'];
  const apiKeyMode = Boolean(args['api-key'] || args.apiKey || args['api-key-stdin']) || args.method === 'api-key';
  let me;
  if (apiKeyMode) {
    const key = await readSecretInput(args, 'api-key');
    me = await loginApiKey(context.client, key);
  } else {
    if (!methods.includes('password')) {
      throw new Error(`该实例未启用密码登录（支持：${methods.join(', ') || '未知'}）。请使用 cr login --api-key-stdin 或浏览器登录。`);
    }
    const login = args.username || process.env.CREWROUTER_USERNAME || process.env.CR_USERNAME || (await ask('用户名或邮箱：')).trim();
    if (!login) throw new Error('用户名不能为空');
    const password = await readSecretInput(args, 'password');
    try {
      me = await loginPassword(context.client, { login, password });
    } catch (error) {
      if (error instanceof TwoFactorRequired) {
        const code = args.otp || (await askSecret('TOTP 六位验证码：')).trim();
        me = await completeTwoFactor(context.client, error.userId, code);
      } else throw error;
    }
  }
  persistClientSession(context, { username: me && me.username ? me.username : context.client.username, isAdmin: context.client.isAdmin });
  if (json) {
    printJson(success(name, {
      profile: name,
      baseUrl: context.client.baseUrl,
      username: me && me.username ? me.username : context.client.username,
      isAdmin: context.client.isAdmin,
      authType: context.client.authType(),
      warning: context.client.authWarning || '',
    }));
    return 0;
  }
  console.log(green(`已登录：${me && me.username ? me.username : context.client.username}${context.client.isAdmin === true ? '（管理员）' : ''}`));
  if (context.client.authWarning) console.log(yellow(context.client.authWarning));
  console.log(`Profile：${name} · ${context.client.baseUrl}`);
  console.log(dim('会话凭证已保存到 0600 权限的 sessions.json；不会保存密码。'));
  return 0;
}

async function logoutCommand(args, { json = false } = {}) {
  const context = createContext(args);
  const existed = Boolean(context.saved);
  await logout(context.client);
  if (!context.target.adHoc) clearSession(context.profileName);
  if (json) { printJson(success(context.profileName, { loggedOut: true, existed })); return 0; }
  console.log(existed ? '已退出登录并删除本地会话。' : dim('当前 profile 没有保存的登录会话。'));
  return 0;
}

async function connectCommand(args, { json = false } = {}) {
  const urlValue = args._[1] || args.url;
  if (!urlValue) throw Object.assign(new Error('请提供服务器 URL：cr connect https://router.example.com'), { code: 'PARSE_ERROR' });
  const baseUrl = normalizeBaseUrl(urlValue);
  const name = args.name || args.profile || profileNameFromUrl(baseUrl);
  const probe = await probeHealth(baseUrl, { timeoutMs: 3000 });
  if (!probe.ok) throw new Error(`服务器不可达：${baseUrl}（${probe.error || '连接失败'}）`);
  saveRemoteProfile(name, baseUrl, { makeCurrent: true, displayName: args.name });
  if (json) {
    printJson(success(name, { profile: name, baseUrl, version: probe.version, instance: probe.instance }));
    return 0;
  }
  console.log(green(`已保存并切换到 profile：${name}`));
  console.log(`地址：${baseUrl}`);
  if (/^http:/i.test(baseUrl) && !isLoopbackBase(baseUrl)) {
    console.log(yellow('警告：远程 HTTP 连接不会加密密码或会话 Cookie，生产环境请使用 HTTPS。'));
  }
  if (probe.instance) {
    console.log(`实例：${probe.instance.edition || '未知'} · ${probe.instance.runtime || '未知'}`);
    const methods = probe.instance.auth && Array.isArray(probe.instance.auth.methods) ? probe.instance.auth.methods : [];
    if (methods.length) console.log(`认证：${methods.join(', ')}`);
  }
  console.log(dim('下一步：cr login'));
  return 0;
}

function profilesCommand(args, { json = false } = {}) {
  const cfg = loadConfig();
  const rows = Object.entries(cfg.profiles).map(([name, profile]) => {
    const session = getSession(name);
    return {
      name,
      current: name === cfg.currentProfile,
      type: profile.type,
      url: profile.baseUrl,
      loggedIn: Boolean(session && (session.apiKey || (session.cookieJar && session.cookieJar.length))),
      authType: session ? session.authType : null,
      username: session ? session.username : '',
    };
  });
  if (json) { printJson(success(cfg.currentProfile, { profiles: rows, currentProfile: cfg.currentProfile, configPath: require('../config').configPath() })); return 0; }
  if (!rows.length) { console.log('尚无 profile。执行 cr connect <URL> 或 cr login 创建。'); return 0; }
  console.log(bold('CrewRouter profiles'));
  for (const row of rows) {
    const mark = row.current ? '›' : ' ';
    const login = row.loggedIn ? green('已登录') : dim('未登录');
    console.log(`${mark} ${row.name} · ${row.type === 'local' ? '本机' : '远程'} · ${row.url} · ${login}${row.username ? ` · ${row.username}` : ''}`);
  }
  return 0;
}

function useCommand(args, { json = false } = {}) {
  const name = args._[1] || args.name;
  if (!name) throw Object.assign(new Error('请提供 profile 名称：cr use <name>'), { code: 'PARSE_ERROR' });
  const cfg = setActiveProfile(name);
  if (json) { printJson(success(name, { currentProfile: cfg.currentProfile, profile: cfg.profiles[name] })); return 0; }
  console.log(green(`已切换到 profile：${name}`));
  console.log(`${cfg.profiles[name].baseUrl}`);
  return 0;
}


module.exports = {
  loginCommand,
  logoutCommand,
  connectCommand,
  profilesCommand,
  useCommand,
};
