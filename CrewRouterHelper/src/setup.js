'use strict';
const fs = require('fs');
const { loadConfig } = require('./config');
const { scanHooks, hookPath } = require('./hooks');
const { list } = require('./clients');
async function setup(options = {}) { const cfg = loadConfig(); const result = { dry_run: Boolean(options.dryRun), config: cfg ? 'present' : 'missing', router_url: cfg?.url ? 'configured' : 'missing', hook: scanHooks(options.command || process.argv[1]), clients: list(), actions: [] }; if (!cfg) result.actions.push('运行 cr-report profile add NAME URL，然后配置认证'); if (!result.hook.valid) result.actions.push(`运行 cr-report hooks install（目标：${hookPath()}）`); if (options.nonInteractive && result.actions.length && !options.dryRun) throw new Error(`非交互安装缺少必要信息：${result.actions.join('；')}`); return result; }
module.exports = { setup };
