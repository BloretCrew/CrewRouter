'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
function configPath() { return process.env.CR_REPORT_CONFIG || path.join(os.homedir(), '.config', 'cr-report.json'); }
function loadConfig() { try { const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); return cfg && typeof cfg === 'object' ? cfg : null; } catch { return null; } }
function credentialStatus(cfg = loadConfig()) {
  if (!cfg || (!cfg.access_token && !cfg.refresh_token && !cfg.key)) return { level: 'MISSING', label: '缺失' };
  const exp = Number(cfg.expires_at || 0);
  if (cfg.refresh_token && exp && exp <= Date.now() / 1000 + 86400) return { level: 'WARN', label: '即将过期' };
  return { level: 'OK', label: '已配置' };
}
function saveConfig(cfg) { const target = configPath(); fs.mkdirSync(path.dirname(target), { recursive: true }); const tmp = `${target}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, target); }
function getCredential() { const cfg = loadConfig(); if (!cfg) return { url: null, token: null }; return { url: String(cfg.url || '').replace(/\/$/, ''), token: cfg.access_token || cfg.key || null }; }
module.exports = { configPath, loadConfig, saveConfig, getCredential, credentialStatus };
