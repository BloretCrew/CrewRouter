'use strict';

const fs = require('node:fs');
const {
  startLocalService,
  stopLocalService,
  serveForeground,
  readLogs,
} = require('../service');
const { ensureLocalProfile, loadConfig, loadServiceState, resolveLocalPort, logPathForPort } = require('../config');
const { printJson, success } = require('../output');
const { bold, green, yellow, dim, relativePath } = require('../format');

function servicePayload(result) {
  return {
    pid: result.pid || null,
    host: result.host,
    port: result.port,
    baseUrl: result.baseUrl,
    external: result.external === true,
    reused: result.reused === true,
    startedAt: result.startedAt || null,
    logPath: result.logPath || null,
    health: result.health || null,
  };
}

async function startCommand(args, { json = false } = {}) {
  const existingLocal = loadConfig().profiles.local;
  const configPath = args.config || (existingLocal && existingLocal.configPath) || undefined;
  const result = await startLocalService({
    host: args.host || '127.0.0.1',
    port: args.port,
    configPath,
    demo: args.demo === true,
    timeoutMs: args.timeout ? Number(args.timeout) : undefined,
  });
  ensureLocalProfile({ host: result.host, port: result.port, configPath, makeCurrent: true });
  if (json) { printJson(success('local', servicePayload(result))); return 0; }
  if (result.external) console.log(yellow(`端口 ${result.port} 已有 CrewRouter 服务运行，直接复用：${result.baseUrl}`));
  else if (result.reused) console.log(yellow(`本地服务已在运行：${result.baseUrl}`));
  else console.log(green(`本地服务已启动：${result.baseUrl}`));
  if (result.pid) console.log(`PID：${result.pid}`);
  if (result.logPath) console.log(`日志：${relativePath(result.logPath)}`);
  if (result.health && result.health.setup && (result.health.setup.needsSetup || result.health.setup.needsEdition)) {
    console.log(yellow(`实例尚未完成初始化，请在浏览器打开 ${result.baseUrl}/setup`));
  }
  return 0;
}

async function stopCommand(args, { json = false } = {}) {
  const result = await stopLocalService({ force: args.force === true });
  if (json) { printJson(success('local', result)); return 0; }
  console.log(result.stopped ? green('本地服务已停止。') : dim(result.message || '没有需要停止的服务。'));
  return 0;
}

async function restartCommand(args, { json = false } = {}) {
  const existingLocal = loadConfig().profiles.local;
  const previous = loadServiceState();
  const configPath = args.config || (previous && previous.configPath) || (existingLocal && existingLocal.configPath) || undefined;
  const demo = args.demo === true || Boolean(previous && previous.demo);
  const stopped = await stopLocalService({ force: args.force === true });
  const result = await startLocalService({
    host: args.host || '127.0.0.1',
    port: args.port || (previous && previous.port),
    configPath,
    demo,
  });
  ensureLocalProfile({ host: result.host, port: result.port, configPath, makeCurrent: true });
  if (json) { printJson(success('local', { stopped, started: servicePayload(result) })); return 0; }
  console.log(green(`本地服务已重启：${result.baseUrl}`));
  return 0;
}

async function logsCommand(args, { json = false } = {}) {
  const lines = Math.min(Math.max(Number(args.lines) || 100, 1), 5000);
  const state = loadServiceState();
  const localProfile = loadConfig().profiles.local;
  const configPath = args.config || (localProfile && localProfile.configPath) || undefined;
  const file = state && state.logPath
    ? state.logPath
    : logPathForPort(resolveLocalPort({ port: localProfile && localProfile.port, configPath }));
  if (!file) {
    if (json) { printJson(success('local', { lines: [], file: null })); return 0; }
    console.log(dim('没有由 cr 启动的本地服务日志。先执行 cr start。'));
    return 0;
  }
  if (json) {
    printJson(success('local', { file, lines: readLogs(lines, file).split('\n').filter(Boolean) }));
    return 0;
  }
  if (!fs.existsSync(file)) {
    console.log(dim(`日志文件尚不存在：${relativePath(file)}`));
    return 0;
  }
  const initial = readLogs(lines, file);
  if (initial) process.stdout.write(`${initial}\n`);
  if (!args.follow) return 0;
  console.log(dim(`正在跟踪 ${relativePath(file)}（Ctrl+C 退出）`));
  let position = fs.statSync(file).size;
  const timer = setInterval(() => {
    try {
      const stat = fs.statSync(file);
      if (stat.size < position) position = 0;
      if (stat.size === position) return;
      const fd = fs.openSync(file, 'r');
      const length = stat.size - position;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, position);
      fs.closeSync(fd);
      position = stat.size;
      process.stdout.write(buffer);
    } catch (_) { /* file may be rotating */ }
  }, 500);
  await new Promise(resolve => process.once('SIGINT', resolve));
  clearInterval(timer);
  console.log('');
  return 0;
}

async function serveCommand(args, { json = false } = {}) {
  const existingLocal = loadConfig().profiles.local;
  const configPath = args.config || (existingLocal && existingLocal.configPath) || undefined;
  const host = args.host || '127.0.0.1';
  const port = resolveLocalPort({ port: args.port, configPath });
  if (json) {
    printJson(success('local', { host, port, foreground: true }));
  } else {
    console.log(bold(`前台启动本地服务：http://${host}:${port}`));
    console.log(dim('按 Ctrl+C 停止。'));
  }
  await serveForeground({
    host,
    port,
    configPath,
    demo: args.demo === true,
    onSpawn: () => ensureLocalProfile({ host, port, configPath, makeCurrent: true }),
  });
  return 0;
}

module.exports = { startCommand, stopCommand, restartCommand, logsCommand, serveCommand };
