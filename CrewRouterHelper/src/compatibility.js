'use strict';
const fs = require('fs');
const https = require('https');
const http = require('http');
const { loadConfig } = require('./config');
function version() { let grok = null; try { grok = require(`${process.env.GROK_HOME || require('os').homedir() + '/.grok'}/package.json`).version || null; } catch {} return { helper: require('../package.json').version, node: process.versions.node, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] || null, grok, router_api: 'client-events/v1', event_schema: 1 }; }
function compatibility() { const v = version(); return { ...v, compatible: Number(process.versions.node.split('.')[0]) >= 16, notes: ['只读检查；不会下载、替换或发布任何文件'] }; }
function checkUpdate(timeout = 1500) { const cfg = loadConfig(); if (!cfg?.url) return Promise.resolve({ checked: false, reason: '未配置 Router URL' }); return new Promise((resolve) => { const target = new URL(String(cfg.url).replace(/\/$/, '') + '/api/client-events/live?window=1'); const transport = target.protocol === 'https:' ? https : http; const req = transport.request(target, { method: 'GET', timeout, headers: { accept: 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve({ checked: true, status: res.statusCode, update_available: false, message: '当前 CLI 不执行自动更新' })); }); req.on('timeout', () => req.destroy()); req.on('error', () => resolve({ checked: false, reason: 'Router 不可达或请求超时' })); req.end(); }); }
module.exports = { version, compatibility, checkUpdate };
