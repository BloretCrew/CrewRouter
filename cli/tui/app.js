'use strict';

const {
  loadConfig,
  ensureLocalProfile,
  saveRemoteProfile,
  setActiveProfile,
  clearSession,
  getSession,
  localProfile,
  normalizeBaseUrl,
} = require('../lib/config');
const { createContext, persistClientSession, openBrowser } = require('../lib/context');
const { verifySession, verifyApiKey, loginPassword, completeTwoFactor, loginApiKey, TwoFactorRequired } = require('../lib/auth');
const { probeHealth, startLocalService, stopLocalService, readLogs } = require('../lib/service');
const { buildPages } = require('./pages');

function applySessionToRuntime(runtime, context) {
  runtime.client = context.client;
  runtime.client.setBaseUrl(context.target.baseUrl);
  runtime.profileName = context.profileName;
  runtime.profile = context.profile;
  runtime.saved = context.saved;
}

function setTarget(runtime, { name, profile, baseUrl, save = true }) {
  const next = normalizeBaseUrl(baseUrl);
  runtime.profileName = name;
  runtime.profile = profile;
  runtime.target = { name, profile, baseUrl: next, adHoc: false };
  runtime.client.setBaseUrl(next);
  runtime.client.clearAuth();
  const saved = getSession(name);
  const reusable = saved && saved.baseUrl === next ? saved : null;
  if (reusable) {
    if (reusable.authType === 'api-key' && reusable.apiKey) runtime.client.setApiKey(reusable.apiKey);
    else if (reusable.authType === 'session') runtime.client.setSession({ cookieJar: reusable.cookieJar, csrfToken: reusable.csrfToken, username: reusable.username, isAdmin: reusable.isAdmin });
  }
  runtime.context = { cfg: loadConfig(), target: runtime.target, profile, profileName: name, client: runtime.client, saved: reusable };
  runtime.saved = reusable;
  runtime.health = null;
  runtime.user = null;
  if (profile && profile.type === 'local') {
    runtime.configPath = profile.configPath || runtime.configPath;
    runtime.configPort = profile.port || runtime.configPort;
  }
  if (save && profile) {
    if (profile.type === 'local') ensureLocalProfile({ port: profile.port, host: profile.host, configPath: profile.configPath, makeCurrent: true });
    else saveRemoteProfile(name, next, { makeCurrent: true, displayName: profile.name });
    runtime.context.cfg = loadConfig();
  }
}

async function chooseTarget(ctx, runtime, { force = false } = {}) {
  for (;;) {
    const health = await probeHealth(runtime.client.baseUrl, { timeoutMs: 2000 });
    runtime.health = health;
    if (health.ok && !force) return health;
    const options = health.ok ? [
      { label: `继续使用当前连接（${runtime.client.baseUrl}）`, value: 'retry' },
      { label: '启动本机服务', value: 'local' },
      { label: '启动本机 Demo（无需数据库）', value: 'demo' },
      { label: '连接远程服务器', value: 'remote' },
    ] : [
      { label: `启动本机服务（${runtime.client.baseUrl}）`, value: 'local' },
      { label: '启动本机 Demo（无需数据库）', value: 'demo' },
      { label: '连接远程服务器', value: 'remote' },
      { label: '重新检查连接', value: 'retry' },
    ];
    options.push({ label: '退出', value: 'quit' });
    const choice = await ctx.choose(health.ok ? '切换服务器' : `无法连接 ${runtime.client.baseUrl}`, options, {
      description: health.ok
        ? '可以继续使用当前连接，或启动本机服务/连接其他远程实例。'
        : `原因：${health.error || '连接失败'}\n可以启动本机 CrewRouter，或连接已有的远程实例。`,
    });
    if (choice === null || choice === 'quit') return null;
    if (choice === 'retry') { if (force) return health; continue; }
    if (choice === 'local' || choice === 'demo') {
      ctx.notify(choice === 'demo' ? '正在启动本机 Demo 服务…' : '正在启动本机服务…');
      try {
        const profile = localProfile({ port: runtime.configPort, configPath: runtime.configPath });
        const result = await startLocalService({
          host: profile.host,
          port: profile.port,
          configPath: runtime.configPath,
          demo: choice === 'demo',
          timeoutMs: 30000,
        });
        setTarget(runtime, { name: 'local', profile: { ...profile, port: result.port, baseUrl: result.baseUrl }, baseUrl: result.baseUrl });
        ensureLocalProfile({ host: result.host, port: result.port, configPath: runtime.configPath, makeCurrent: true });
        runtime.profile = loadConfig().profiles.local;
        runtime.localService = result;
        ctx.notify(result.external ? `已复用 ${result.baseUrl}` : `本机服务已启动：${result.baseUrl}`);
        const next = await probeHealth(result.baseUrl, { timeoutMs: 2000 });
        runtime.health = next;
        if (next.ok) return next;
      } catch (error) {
        const log = readLogs(30);
        await ctx.show('本机服务启动失败', `${error.message}${log ? `\n\n--- 最近日志 ---\n${log}` : ''}`);
      }
      continue;
    }
    if (choice === 'remote') {
      const values = await ctx.form('连接远程服务器', [
        { name: 'url', label: '服务器 URL', value: 'https://' },
        { name: 'name', label: 'Profile 名称（可选）', value: '' },
      ], { description: '管理 API 地址应指向站点根路径，例如 https://router.example.com。', submitLabel: '连接' });
      if (!values || !values.url) continue;
      try {
        const baseUrl = normalizeBaseUrl(values.url);
        const name = (values.name || '').trim() || new URL(baseUrl).hostname.replace(/[^A-Za-z0-9_.-]/g, '-') || 'remote';
        const probe = await probeHealth(baseUrl, { timeoutMs: 4000 });
        if (!probe.ok) throw new Error(`无法连接：${probe.error || '连接失败'}`);
        saveRemoteProfile(name, baseUrl, { makeCurrent: true });
        const cfg = loadConfig();
        setTarget(runtime, { name, profile: cfg.profiles[name], baseUrl, save: false });
        runtime.health = probe;
        ctx.notify(`已连接 ${name} · ${baseUrl}`);
        return probe;
      } catch (error) {
        await ctx.show('连接失败', error.message);
      }
    }
  }
}

async function ensureSetup(ctx, runtime) {
  for (;;) {
    const health = runtime.health && runtime.health.ok ? runtime.health : await probeHealth(runtime.client.baseUrl, { timeoutMs: 2000 });
    runtime.health = health;
    if (!health.ok) return false;
    const setup = health.setup || {};
    if (!setup.needsSetup && !setup.needsEdition) return true;
    const choice = await ctx.choose('实例尚未完成初始化', [
      { label: '在浏览器打开初始化页面', value: 'open' },
      { label: '我已完成，重新检查', value: 'retry' },
      { label: '退出', value: 'quit' },
    ], { description: `请先在浏览器打开 ${runtime.client.baseUrl}/setup 完成 edition 与管理员初始化。` });
    if (choice === null || choice === 'quit') return false;
    if (choice === 'open') openBrowser(`${runtime.client.baseUrl}/setup`);
  }
}

async function authenticate(ctx, runtime) {
  const health = await chooseTarget(ctx, runtime);
  if (!health) return false;
  if (!(await ensureSetup(ctx, runtime))) return false;

  if (runtime.client.apiKey) {
    const ok = await verifyApiKey(runtime.client);
    if (ok) { runtime.user = { username: runtime.client.username, isAdmin: runtime.client.isAdmin }; return true; }
    runtime.client.clearAuth();
  } else if (runtime.client.cookieJar && runtime.client.cookieJar.length) {
    const me = await verifySession(runtime.client);
    if (me) {
      runtime.user = me;
      persistClientSession(runtime.context, { username: me.username, isAdmin: runtime.client.isAdmin });
      return true;
    }
    runtime.client.clearAuth();
    if (!runtime.target?.adHoc) clearSession(runtime.profileName);
  }

  const methods = health.instance && health.instance.auth && Array.isArray(health.instance.auth.methods)
    ? health.instance.auth.methods : ['password'];
  const canPassword = methods.includes('password');
  for (;;) {
    const options = [];
    if (canPassword) options.push({ label: '用户名 / 密码登录', value: 'password' });
    options.push({ label: 'API Key 登录', value: 'api-key' });
    options.push({ label: '切换服务器', value: 'switch' });
    options.push({ label: '退出', value: 'quit' });
    const method = await ctx.choose('登录', options, {
      description: `目标：${runtime.client.baseUrl}\n实例认证方式：${methods.join('、') || '未知'}${canPassword ? '' : '\n该实例未启用密码登录；请使用 API Key，或先在浏览器登录。'}`,
    });
    if (method === null || method === 'quit') return false;
    if (method === 'switch') {
      const next = await chooseTarget(ctx, runtime, { force: true });
      if (!next) return false;
      return authenticate(ctx, runtime);
    }
    try {
      if (method === 'api-key') {
        const key = await ctx.ask('API Key', { secret: true, description: 'API Key 需要具备管理接口权限；仅有 gateway 权限的 Key 只能读取部分数据。' });
        if (!key) continue;
        const me = await loginApiKey(runtime.client, String(key).trim());
        runtime.user = me;
        persistClientSession(runtime.context, { username: runtime.client.username, isAdmin: runtime.client.isAdmin });
        if (me.warning) await ctx.show('API Key 权限受限', me.warning);
        return true;
      }
      const credentials = await ctx.form('密码登录', [
        { name: 'login', label: '用户名或邮箱' },
        { name: 'password', label: '密码', secret: true },
      ], { description: '密码只用于换取会话，不会保存到磁盘。', submitLabel: '登录' });
      if (!credentials) continue;
      let me;
      try {
        me = await loginPassword(runtime.client, credentials);
      } catch (error) {
        if (error instanceof TwoFactorRequired) {
          const code = await ctx.ask('TOTP 六位验证码', { secret: true });
          if (!code) continue;
          me = await completeTwoFactor(runtime.client, error.userId, code);
        } else throw error;
      }
      runtime.user = me;
      persistClientSession(runtime.context, { username: me.username, isAdmin: runtime.client.isAdmin });
      return true;
    } catch (error) {
      if (error && error.statusCode === 401) {
        await ctx.show('登录失败', '用户名、密码、验证码或 API Key 不正确，请重试。');
      } else if (error && error.statusCode === 429) {
        await ctx.show('登录失败', '尝试过于频繁，请稍后再试。');
      } else if (error && error.statusCode === 403) {
        await ctx.show('权限不足', `${error.message}\n\nAPI Key 默认只有 gateway 权限；请在 Web 控制台为 Key 授予管理权限，或改用密码会话登录。`);
      } else {
        await ctx.show('登录失败', error && error.message ? error.message : '未知错误');
      }
    }
  }
}

async function startLocal(ctx, runtime, demo = false) {
  const profile = localProfile({ port: runtime.configPort, configPath: runtime.configPath });
  const result = await startLocalService({
    host: profile.host,
    port: profile.port,
    configPath: runtime.configPath,
    demo,
    timeoutMs: 30000,
  });
  setTarget(runtime, { name: 'local', profile: { ...profile, port: result.port, baseUrl: result.baseUrl }, baseUrl: result.baseUrl });
  runtime.profile = loadConfig().profiles.local;
  runtime.localService = result;
  return result;
}

async function switchProfile(ctx, runtime, name) {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) throw new Error(`profile 不存在：${name}`);
  setActiveProfile(name, cfg);
  const context = createContext({ profile: name });
  applySessionToRuntime(runtime, context);
  runtime.context = context;
  runtime.target = context.target;
  if (context.profile && context.profile.type === 'local') {
    runtime.configPath = context.profile.configPath || runtime.configPath;
    runtime.configPort = context.profile.port || runtime.configPort;
  }
  await ctx.relogin(`已切换到 profile：${name}`);
}

function buildRuntime(args) {
  let cfg = loadConfig();
  if (args.url && !args.profile) {
    let name = 'remote';
    try { name = new URL(args.url).hostname.replace(/[^A-Za-z0-9_.-]/g, '-') || 'remote'; } catch (_) {}
    saveRemoteProfile(name, args.url, { makeCurrent: true, displayName: name });
    cfg = loadConfig();
    args = { ...args, profile: name, url: null };
  }
  if (!cfg.currentProfile) {
    cfg = ensureLocalProfile({ port: args.port, configPath: args.config, makeCurrent: true });
  }
  const context = createContext(args);
  const runtime = {
    cfg,
    context,
    client: context.client,
    target: context.target,
    profileName: context.profileName,
    profile: context.profile,
    saved: context.saved,
    configPath: args.config || (context.profile && context.profile.configPath) || null,
    configPort: args.port || (context.profile && context.profile.type === 'local' ? context.profile.port : undefined),
    days: cfg.tui ? cfg.tui.days : 30,
    health: null,
    user: null,
    localService: null,
    async startLocal(ctx, demo = false) { return startLocal(ctx, runtime, demo); },
    async stopLocal(ctx) {
      const result = await stopLocalService({ force: false });
      ctx.notify(result.stopped ? '本机服务已停止。' : (result.message || '没有需要停止的服务。'));
      return result;
    },
    async switchProfile(ctx, name) { return switchProfile(ctx, runtime, name); },
    async addRemote(ctx) {
      const values = await ctx.form('添加远程服务器', [
        { name: 'url', label: '服务器 URL', value: 'https://' },
        { name: 'name', label: 'Profile 名称（可选）', value: '' },
      ], { description: '将保存 profile 并切换过去。', submitLabel: '保存' });
      if (!values || !values.url) return false;
      const baseUrl = normalizeBaseUrl(values.url);
      const name = (values.name || '').trim() || new URL(baseUrl).hostname.replace(/[^A-Za-z0-9_.-]/g, '-') || 'remote';
      const probe = await probeHealth(baseUrl, { timeoutMs: 4000 });
      if (!probe.ok) throw new Error(`无法连接：${probe.error || '连接失败'}`);
      saveRemoteProfile(name, baseUrl, { makeCurrent: true });
      await switchProfile(ctx, runtime, name);
      return true;
    },
    async logout(ctx) {
      if (!runtime.target.adHoc) clearSession(runtime.profileName);
      runtime.client.clearAuth();
      runtime.saved = null;
      runtime.user = null;
      await ctx.relogin('已退出当前登录，请重新登录。');
      return true;
    },
  };
  return runtime;
}

async function runCliTui(args = {}, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const runtime = buildRuntime(args);
  const pages = buildPages(runtime);
  const { navGroups } = require('./pages');
  const { runPagedTui } = require('./engine');
  const authenticateFn = ctx => authenticate(ctx, runtime);
  const refreshMs = runtime.cfg.tui ? runtime.cfg.tui.refreshMs : 10000;
  const run = runPagedTui({
    input,
    output,
    env,
    api: (path, options) => runtime.client.request(path, options),
    pages,
    authenticate: authenticateFn,
    onSessionReset: () => { runtime.user = null; },
    refreshMs,
    title: 'CrewRouter',
    headerRight: () => {
      if (runtime.client.authWarning) return '权限受限';
      if (runtime.client.isAdmin === true) return 'admin';
      if (runtime.user || runtime.client.username) return runtime.client.username || '已登录';
      return '未登录';
    },
    sidebarFooter: () => [runtime.profileName || 'local', runtime.client.authWarning ? '权限受限' : (runtime.user || runtime.client.username ? '已连接' : '未登录')],
    navGroups,
  });
  return run;
}

module.exports = { runCliTui, buildRuntime, authenticate, chooseTarget, buildPages };
