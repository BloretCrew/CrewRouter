'use strict';

/**
 * 配置读写：与 Python 版共用 ~/.config/cr-report.json 及状态文件路径，两版可互换。
 * 兼容两种形态：
 *   { url, key }                                        静态 API Key
 *   { url, access_token, refresh_token, expires_at }    OAuth 凭证对
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH =
  process.env.CREWROUTER_CONFIG ||
  process.env.CR_REPORT_CONFIG || // 兼容 Python 版环境变量
  path.join(os.homedir(), '.config', 'cr-report.json');
const GROK_SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const STATE_PATH = path.join(os.homedir(), '.cache', 'cr-report-grok-state.json');
// 刷新必须串行的锁文件：并发 hook 同时刷会导致旧 refresh 重放被服务端全链吊销
const TOKEN_LOCK_PATH = path.join(os.homedir(), '.cache', 'cr-report-token.lock');

function loadCfg() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  } catch (_) {
    return null;
  }
}

/** 写回配置并收紧权限为 600（含长期 refresh_token，不能组/其他人可读） */
function saveCfg(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

/** 服务端地址：环境变量优先于配置文件，去掉尾部斜杠 */
function effectiveUrl(cfg) {
  const raw = process.env.CREWROUTER_URL || (cfg && cfg.url) || '';
  return String(raw).replace(/\/+$/, '');
}

module.exports = {
  CONFIG_PATH,
  GROK_SESSIONS_DIR,
  STATE_PATH,
  TOKEN_LOCK_PATH,
  loadCfg,
  saveCfg,
  effectiveUrl,
};
