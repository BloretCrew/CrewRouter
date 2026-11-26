'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createContext, ensureAuthenticated } = require('../context');
const { verifySession, verifyApiKey } = require('../auth');
const { getBalance, getStats, listApiKeys, statsSummary } = require('../api');
const { probeHealth, processAlive } = require('../service');
const { loadServiceState, ensurePrivateDir, configPath, sessionsPath, cliHome } = require('../config');
const { printJson, success, describeError } = require('../output');
const {
  bold, dim, green, yellow, red, formatBigNumber, formatCost, relativePath, table,
} = require('../format');
const { version: packageVersion } = require('../version');

const HELP_TEXT = `CrewRouter CLI (cr) — 连接远程实例或从本机启动 CrewRouter

用法：
  cr [tui]                         打开全屏 TUI（默认）
  cr status [--json]               查看连接、服务与登录状态
  cr login [--url URL]             登录（密码、API Key 或 --oauth 设备码）；OAuth 需命名 profile
  cr logout                        退出登录并删除本地凭证
  cr connect <URL> [--name NAME]   添加/切换远程服务器
  cr profiles [--json]             列出服务器 profile
  cr use <NAME>                    切换当前 profile

本地服务：
  cr start [--port N] [--config PATH] [--demo]
  cr stop [--force]
  cr restart
  cr logs [--lines N] [-f]
  cr serve [--port N] [--config PATH] [--demo]

数据：
  cr overview [--days N] [--json]
  cr providers [--json]
  cr providers ping <ID>
  cr providers toggle <ID> --enabled|--disabled
  cr models [--search Q] [--json]
  cr keys list|create|enable|disable|rename|delete|config ...
  cr usage [--days N] [--json]
  cr sessions [--days N] [--page N] [--json]
  cr sessions messages <KEY> [--page N] [--json]

DSH 插件：
  cr dsh-plugin status
  cr dsh-plugin install --profile <名称>
  cr dsh-plugin uninstall --profile <名称> [--yes]

其他：
  cr doctor [--json]
  cr version
  cr help [命令]

环境：
  CR_CLI_HOME                    配置目录（默认 ~/.config/crewrouter）
  CREWROUTER_URL / CR_URL        默认服务器地址
  CREWROUTER_API_KEY / CR_API_KEY 直接使用 API Key
  CR_CONFIG_PATH                 本地服务 config.json 路径
  CR_THEME / CR_PALETTE          TUI 配色（coral/indigo/graphite/mono/circuit/dusk）
  CR_COLOR_SCHEME                auto/dark/light/plain

激活命令：npm link（或 npm install -g .）后即可直接运行 cr。`;

async function authStatus(client) {
  if (!client) return { type: 'none', label: '未登录' };
  if (client.apiKey) {
    try {
      await verifyApiKey(client);
      return { type: 'api-key', label: `API Key · ${client.username || '用户'}${client.authWarning ? ' · 权限受限' : ''}`, username: client.username, isAdmin: client.isAdmin, warning: client.authWarning || '' };
    } catch (error) {
      return { type: 'api-key', label: `API Key 不可用：${describeError(error)}`, error: true };
    }
  }
  if (!client.cookieJar || !client.cookieJar.length) return { type: 'none', label: '未登录' };
  try {
    const me = await verifySession(client);
    if (!me) return { type: 'session', label: '会话已失效', error: true };
    return { type: 'session', label: `${me.username || '已登录'}${me.isAdmin ? ' · 管理员' : ''}`, username: me.username, isAdmin: me.isAdmin === true };
  } catch (error) {
    return { type: 'session', label: `会话检查失败：${describeError(error)}`, error: true };
  }
}

function serviceHealthLines(health) {
  if (!health) return ['服务：未知'];
  if (!health.ok) return [`服务：离线（${health.error || '连接失败'}）`];
  const instance = health.instance && typeof health.instance === 'object' ? health.instance : {};
  return [
    `服务：在线 · ${health.version && health.version.name ? health.version.name : 'CrewRouter'} ${health.version && health.version.version ? health.version.version : ''}`.trim(),
    `实例：${instance.edition || '未知'} · ${instance.runtime || '未知'} · 认证 ${Array.isArray(instance.auth && instance.auth.methods) ? instance.auth.methods.join(', ') : '未知'}`,
    `延迟：${health.latencyMs} ms`,
  ];
}

async function statusCommand(args, { json = false } = {}) {
  const context = createContext(args);
  const health = await probeHealth(context.client.baseUrl, { timeoutMs: args.timeout || 2000 });
  const auth = await authStatus(health.ok ? context.client : null);
  const local = loadServiceState();
  const payload = {
    profile: context.profileName,
    baseUrl: context.client.baseUrl,
    profileType: context.profile ? context.profile.type : 'remote',
    health,
    auth,
    localService: local ? { pid: local.pid, alive: processAlive(local.pid), port: local.port, baseUrl: local.baseUrl } : null,
  };
  if (json) { printJson(success(context.profileName, payload)); return 0; }
  console.log(bold('CrewRouter CLI'));
  console.log(`Profile：${context.profileName}（${payload.profileType === 'local' ? '本机' : '远程'}）`);
  console.log(`地址：${context.client.baseUrl}`);
  for (const line of serviceHealthLines(health)) console.log(line);
  if (health.setup) {
    const needs = health.setup.needsSetup || health.setup.needsEdition;
    console.log(`初始化：${needs ? yellow('尚未完成，请打开 /setup') : green('已完成')}`);
  }
  console.log(`登录：${auth.error ? red(auth.label) : auth.type === 'none' ? dim(auth.label) : green(auth.label)}`);
  if (local) console.log(`本机进程：PID ${local.pid} · ${processAlive(local.pid) ? '运行中' : '已退出'} · ${local.baseUrl}`);
  return health.ok ? 0 : 1;
}

async function versionCommand(args, { json = false } = {}) {
  const context = createContext(args);
  const health = await probeHealth(context.client.baseUrl, { timeoutMs: 1200 });
  const payload = {
    cli: packageVersion,
    node: process.version,
    server: health.ok ? health.version : null,
    baseUrl: context.client.baseUrl,
  };
  if (json) { printJson(success(context.profileName, payload)); return 0; }
  console.log(`CrewRouter CLI ${packageVersion} · Node ${process.version}`);
  if (health.ok) console.log(`服务端 ${health.version && health.version.version ? health.version.version : '未知'} · ${context.client.baseUrl}`);
  else console.log(dim(`服务端不可达：${health.error || '连接失败'}`));
  return 0;
}

async function overviewCommand(args, { json = false } = {}) {
  const context = createContext(args);
  await ensureAuthenticated(context);
  const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
  const [balance, stats, keys] = await Promise.all([
    getBalance(context.client),
    getStats(context.client, days),
    listApiKeys(context.client).catch(error => ({ error })),
  ]);
  const summary = statsSummary(stats);
  const payload = { days, balance, summary, keyCount: Array.isArray(keys) ? keys.length : null };
  if (json) { printJson(success(context.profileName, payload)); return 0; }
  console.log(bold(`CrewRouter 概览 · 最近 ${days} 天`));
  console.log(`Profile：${context.profileName} · ${context.client.baseUrl}`);
  console.log(`用户：${context.client.username || '未知'}${context.client.isAdmin ? ' · 管理员' : ''}`);
  console.log(`余额：${balance && balance.balance !== undefined ? balance.balance : '未知'}`);
  console.log(`请求：${summary.requests.toLocaleString()} · Token：${formatBigNumber(summary.tokens)} · 费用：${formatCost(summary.cost)}`);
  if (summary.avgLatency) console.log(`平均延迟：${Math.round(summary.avgLatency)} ms`);
  if (Array.isArray(keys)) console.log(`API Key：${keys.length} 个`);
  const daily = summary.daily.slice(-7);
  if (daily.length) {
    console.log('');
    console.log(bold('最近每日用量'));
    console.log(table(daily, [
      { label: '日期', key: row => row.date || '', width: 12 },
      { label: '请求', key: row => Number(row.requests || 0).toLocaleString(), width: 8, align: 'right' },
      { label: 'Token', key: row => formatBigNumber(row.tokens), width: 8, align: 'right' },
      { label: '费用', key: row => formatCost(row.cost), width: 10, align: 'right' },
    ], { maxWidth: process.stdout.columns || 100 }));
  }
  return 0;
}

async function doctorCommand(args, { json = false } = {}) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20 ? 'pass' : 'fail', `${process.version}（需要 >= 20）`);
  try {
    ensurePrivateDir(cliHome());
    const mode = fs.statSync(cliHome()).mode & 0o777;
    add('配置目录', mode === 0o700 ? 'pass' : 'warn', `${relativePath(cliHome())}（${mode.toString(8)}）`);
  } catch (error) { add('配置目录', 'fail', error.message); }
  add('profile 配置', fs.existsSync(configPath()) ? 'pass' : 'warn', fs.existsSync(configPath()) ? relativePath(configPath()) : '尚未创建，首次 connect/login 会创建');
  add('会话文件', fs.existsSync(sessionsPath()) ? 'pass' : 'warn', fs.existsSync(sessionsPath()) ? relativePath(sessionsPath()) : '尚未登录');
  try {
    const context = createContext(args);
    const health = await probeHealth(context.client.baseUrl, { timeoutMs: 2000 });
    add('服务连接', health.ok ? 'pass' : 'fail', health.ok ? `${context.client.baseUrl} · ${health.version && health.version.version || '未知版本'}` : `${context.client.baseUrl} · ${health.error || '连接失败'}`);
    if (health.setup) add('实例初始化', health.setup.needsSetup || health.setup.needsEdition ? 'warn' : 'pass', health.setup.needsSetup || health.setup.needsEdition ? '需要在浏览器完成 /setup' : '已完成');
    const auth = health.ok ? await authStatus(context.client) : { label: '未检查' };
    add('登录状态', auth.error ? 'fail' : auth.type === 'none' ? 'warn' : 'pass', auth.label);
    if (health.ok && auth.type === 'none') add('提示', 'info', '执行 cr login 登录后再使用管理命令');
  } catch (error) {
    add('服务连接', 'fail', error.message);
  }
  const local = loadServiceState();
  add('本地服务', local ? (processAlive(local.pid) ? 'pass' : 'warn') : 'info', local ? `PID ${local.pid} · ${local.baseUrl}${processAlive(local.pid) ? '' : '（进程已退出）'}` : '没有 cr 启动的本地服务');
  const entry = path.resolve(__dirname, '..', 'local-server-entry.js');
  add('本地启动入口', fs.existsSync(entry) ? 'pass' : 'fail', entry);
  const serverEntry = path.resolve(__dirname, '..', '..', '..', 'server', 'index.js');
  add('Server 文件', fs.existsSync(serverEntry) ? 'pass' : 'fail', serverEntry);
  if (args.json) { printJson(success('doctor', { checks })); return checks.some(item => item.level === 'fail') ? 1 : 0; }
  console.log(bold('CrewRouter CLI 诊断'));
  for (const check of checks) {
    const icon = check.level === 'pass' ? green('✓') : check.level === 'warn' ? yellow('!') : check.level === 'fail' ? red('✕') : dim('•');
    console.log(`${icon} ${check.name}：${check.detail}`);
  }
  return checks.some(item => item.level === 'fail') ? 1 : 0;
}

function printHelp(command) {
  if (command) {
    const line = HELP_TEXT.split('\n').find(item => item.trim().startsWith(`cr ${command}`));
    if (line) { console.log(line.trim()); return; }
  }
  console.log(HELP_TEXT);
}

module.exports = {
  HELP_TEXT,
  authStatus,
  statusCommand,
  versionCommand,
  overviewCommand,
  doctorCommand,
  printHelp,
};
