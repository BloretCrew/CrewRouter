'use strict';
const fs = require('fs');
const { loadConfig, configPath, credentialStatus, activeProfile, getAccessToken } = require('./config');
const { scanHooks, hookPath, install } = require('./hooks');
const { list } = require('./clients');
const { diagnose } = require('./network');

function stage(name, level, detail) { return { name, level, detail }; }

async function setup(options = {}) {
  const cfg = loadConfig();
  const hook = scanHooks(options.command || process.argv[1]);
  const credential = credentialStatus(activeProfile(cfg)?.profile || cfg);
  const stages = [
    stage('CLI', fs.existsSync(options.command || process.argv[1]) ? 'READY' : 'FAILED', 'CLI 可执行文件'),
    stage('Hook', hook.valid ? 'READY' : hook.level === 'ERROR' ? 'FAILED' : 'WARN', hook.valid ? 'Helper Hook 已就绪' : `需要配置 Hook：${hookPath()}`),
    stage('配置', cfg ? 'READY' : 'WARN', cfg ? '配置文件已存在' : `未找到配置：${configPath()}`),
    stage('认证', credential.level === 'OK' ? 'READY' : credential.level === 'MISSING' ? 'WARN' : 'FAILED', credential.label),
    stage('客户端', 'READY', `${list().length} 个客户端可检查`),
  ];
  const actions = [];
  if (!cfg) actions.push('运行 cr-report profile add NAME URL，然后配置认证');
  if (!hook.valid) actions.push(`运行 cr-report hooks install（目标：${hookPath()}）`);
  const result = { dry_run: options.dryRun !== false, verify: Boolean(options.verify), yes: Boolean(options.yes), stages, actions, config: cfg ? 'present' : 'missing', router_url: cfg?.url ? 'configured' : 'missing', hook, clients: list() };
  if (options.verify) {
    const checks = await diagnose(cfg, { verify: true });
    result.remote = checks;
    for (const check of checks) result.stages.push(stage(`远程 ${check.name}`, check.level === 'OK' ? 'READY' : check.level === 'WARN' ? 'WARN' : 'FAILED', check.detail));
  }
  if (options.yes && !options.dryRun && !hook.valid && hook.level !== 'ERROR') {
    install(options.command || process.argv[1]);
    result.applied = ['安装 Helper Hook'];
  }
  if (options.nonInteractive && result.actions.length && !options.yes && !options.dryRun) throw new Error(`非交互安装缺少必要信息：${result.actions.join('；')}`);
  result.overall = result.stages.some(x => x.level === 'FAILED') ? 'FAILED' : result.stages.some(x => x.level === 'WARN') ? 'WARN' : 'READY';
  return result;
}
module.exports = { setup, stage };
