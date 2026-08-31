'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hookPath, install, uninstall, scanHooks } = require('./hooks');
const CLIENTS = { grok: { path: hookPath, supported: true }, claude: { path: () => path.join(os.homedir(), '.claude', 'settings.json'), supported: false }, qwen: { path: () => path.join(os.homedir(), '.qwen', 'settings.json'), supported: false }, codex: { path: () => path.join(os.homedir(), '.codex', 'config.json'), supported: false } };
function inspect(name) { const c = CLIENTS[name]; if (!c) throw new Error(`未知客户端: ${name}`); const file = c.path(); let exists = false; try { exists = fs.existsSync(file); } catch {} const hook = name === 'grok' ? scanHooks(process.argv[1]) : null; return { name, supported: c.supported, config_path: file, exists, helper_installed: Boolean(hook?.valid), hook: hook ? { level: hook.level, valid: hook.valid, events: hook.events, command_executable: hook.commandExecutable } : undefined, conflict: Boolean(hook && hook.exists && !hook.valid), note: c.supported ? '可安全管理 CrewRouter Hook' : '仅探测，不自动修改客户端配置' }; }
function list() { return Object.keys(CLIENTS).map((name) => inspect(name)); }
function change(name, action, dryRun = false, yes = false) { const info = inspect(name); if (!info.supported) throw new Error(`${name} 当前只支持 inspect/list，拒绝修改用户配置`); if (!dryRun && !yes) throw new Error(`${action} 需要 --yes 确认`); if (dryRun) return { ...info, action, dry_run: true }; if (action === 'install') install(path.resolve(process.argv[1])); else uninstall(); return { ...inspect(name), action, dry_run: false }; }
module.exports = { CLIENTS, inspect, clientInspect: inspect, list, listClients: list, clientList: list, change };
