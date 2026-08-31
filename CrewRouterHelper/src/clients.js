'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hookPath, install, uninstall, scanHooks, installPlan } = require('./hooks');

const CLIENTS = {
  grok: { path: hookPath, supported: true, hookSupport: true, helper: true },
  claude: { path: () => path.join(os.homedir(), '.claude', 'settings.json'), supported: false, hookSupport: true, helper: false },
  qwen: { path: () => path.join(os.homedir(), '.qwen', 'settings.json'), supported: false, hookSupport: true, helper: false },
  codex: { path: () => path.join(os.homedir(), '.codex', 'config.json'), supported: false, hookSupport: false, helper: false },
};

function inspect(name, options = {}) {
  const c = CLIENTS[name];
  if (!c) throw new Error(`未知客户端: ${name}`);
  const file = c.path();
  let exists = false;
  try { exists = fs.existsSync(file); } catch {}
  const hook = name === 'grok' ? scanHooks(options.command || process.argv[1]) : null;
  const result = {
    name, supported: c.supported, version: null, hook_support: c.hookSupport,
    config_path: file, config_exists: exists, exists,
    helper_installed: Boolean(hook?.valid), helper_connected: Boolean(hook?.valid),
    auto_install: c.supported, verification: hook ? (hook.valid ? 'passed' : hook.level) : 'not_run',
    hook: hook ? { level: hook.level, valid: hook.valid, events: hook.events, command_executable: hook.commandExecutable } : null,
    conflict: Boolean(hook && hook.exists && !hook.valid),
    note: c.supported ? '可安全管理 CrewRouter Hook' : '仅探测，不自动修改客户端配置',
  };
  if (options.verbose) result.install_plan = c.supported ? installPlan(options.command || process.argv[1]) : null;
  return result;
}
function list(options = {}) { return Object.keys(CLIENTS).map((name) => inspect(name, options)); }
function setup(name = 'grok', options = {}) {
  const info = inspect(name, options);
  if (name !== 'grok') return { ...info, action: 'manual', confirmation_required: false, manual_steps: [`确认 ${info.config_path} 是否存在并阅读 ${name} 的 Hook 配置文档`, `将事件上报命令配置为 cr-report hook --harness ${name}`, '执行 cr-report test --harness ' + name + ' 验证；本工具不会自动修改该文件'] };
  const plan = installPlan(options.command || process.argv[1]);
  return { ...info, action: options.confirmed ? 'install' : 'plan', confirmation_required: !options.confirmed, install_plan: plan };
}
function change(name, action, dryRun = false, yes = false) {
  const info = inspect(name);
  if (!info.supported) throw new Error(`${name} 当前只支持 inspect/list/setup，拒绝修改用户配置`);
  if (!dryRun && !yes) throw new Error(`${action} 需要 --yes 确认`);
  if (dryRun) return { ...info, action, dry_run: true, install_plan: installPlan(process.argv[1]) };
  if (action === 'install') install(path.resolve(process.argv[1])); else uninstall();
  return { ...inspect(name), action, dry_run: false, verification: 'passed' };
}
module.exports = { CLIENTS, inspect, clientInspect: inspect, list, listClients: list, clientList: list, setup, change };
