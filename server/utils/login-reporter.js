/**
 * 登录状态上报模块（仅 demo: false 的自建实例生效）
 *
 * 用户在本实例登录/退出登录时，向官方演示站上报一次匿名事件，
 * 用于在多 CrewRouter 之间展示活跃状态。默认开启，可在管理后台关闭。
 *
 * 隐私说明：不含用户名/邮箱等身份信息，仅记录：
 * 事件类型（login/logout）、本实例对外域名、本实例设备码、
 * 账户类型（是否管理员）、终端登录 IP、User-Agent 与时间。
 *
 * 可靠性：fire-and-forget，3 秒超时，任何失败仅记录 warn，绝不阻塞登录流程。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Logger = require('../logger');
const config = require('../config-loader');

// ---------- 配置 ----------
const REPORT_URL =
  process.env.CR_LOGIN_REPORT_URL ||
  (config.loginReport && config.loginReport.url) ||
  'https://crewrouter.bloret.net/api/login-report';
const REPORT_TOKEN =
  process.env.CR_LOGIN_REPORT_TOKEN ||
  (config.loginReport && config.loginReport.token) ||
  '';

// 配置级总开关：config loginReport.enabled 显式为 false 时强制关闭（管理后台开关不再生效）
const CONFIG_ENABLED = !((config.loginReport && config.loginReport.enabled) === false);

const REQUEST_TIMEOUT_MS = 3000;
const SETTINGS_CACHE_TTL_MS = 60000;

let VERSION = '';
try {
  VERSION = require('../../package.json').version || '';
} catch {
  /* 版本号可选 */
}

// ---------- 实例设备码 ----------
let instanceIdCache = null;

function resolveInstanceId() {
  if (instanceIdCache) return instanceIdCache;
  // data/ 目录位于项目根（updater 升级时保留 data 目录，设备码不丢失）
  const candidates = [
    path.join(__dirname, '..', '..', 'data'),
    path.join(process.cwd(), 'data'),
  ];
  const file = path.join(candidates[0], 'instance-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      instanceIdCache = existing;
      return instanceIdCache;
    }
  } catch {
    /* 首次生成 */
  }

  instanceIdCache = crypto.randomUUID();
  try {
    fs.mkdirSync(candidates[0], { recursive: true });
    fs.writeFileSync(file, instanceIdCache + '\n', { mode: 0o600 });
  } catch (err) {
    // 只读环境：退回使用 cwd，再失败则仅在内存中保留
    try {
      fs.mkdirSync(candidates[1], { recursive: true });
      fs.writeFileSync(path.join(candidates[1], 'instance-id'), instanceIdCache + '\n', { mode: 0o600 });
    } catch {
      Logger.warn('[login-report] 设备码无法持久化，仅内存保留:', err.message);
    }
  }
  return instanceIdCache;
}

// ---------- 开关（settings 表 + 内存缓存） ----------
let enabledCache = { value: true, loadedAt: 0 };

function parseSettingValue(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw === 'true';
    }
  }
  return raw !== false && raw !== null && raw !== undefined;
}

async function isEnabled() {
  if (!CONFIG_ENABLED) return false;
  const now = Date.now();
  if (now - enabledCache.loadedAt < SETTINGS_CACHE_TTL_MS) return enabledCache.value;
  try {
    const { pool } = require('../models/database');
    const result = await pool.query("SELECT value FROM settings WHERE key = 'login_report_enabled'");
    enabledCache = {
      value: result.rows.length > 0 ? parseSettingValue(result.rows[0].value) : true,
      loadedAt: now,
    };
  } catch (err) {
    // 查询失败时沿用旧值并刷新时间戳，避免每次登录都重试
    Logger.warn('[login-report] 读取上报开关失败，沿用旧值:', err.message);
    enabledCache.loadedAt = now;
  }
  return enabledCache.value;
}

/** 管理后台修改设置后可调用以立即生效（有 TTL 缓存兜底，可不调） */
function invalidateEnabledCache() {
  enabledCache.loadedAt = 0;
}

// ---------- 上报 ----------
function resolveDomain(req) {
  const cfgDomain = config.loginReport && config.loginReport.domain;
  if (cfgDomain && String(cfgDomain).trim()) return String(cfgDomain).trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  return host || 'unknown';
}

async function report(event, req) {
  try {
    if (!(await isEnabled())) return;

    const payload = {
      event,
      domain: resolveDomain(req),
      deviceId: resolveInstanceId(),
      isAdmin: req.session?.user?.isAdmin === true,
      ip: req.ip || (req.connection && req.connection.remoteAddress) || 'unknown',
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
      version: VERSION,
      time: new Date().toISOString(),
    };

    await axios.post(REPORT_URL, payload, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        ...(REPORT_TOKEN ? { 'X-Report-Token': REPORT_TOKEN } : {}),
      },
    });
    Logger.info(`[login-report] 已上报 ${event} 事件 (${payload.domain})`);
  } catch (err) {
    Logger.warn(`[login-report] 上报失败（不影响登录流程）: ${err.message}`);
  }
}

/** fire-and-forget：登录成功后调用 */
function reportLoginEvent(req) {
  if (!req) return;
  Promise.resolve().then(() => report('login', req)).catch(() => {});
}

/** fire-and-forget：退出登录时调用 */
function reportLogoutEvent(req) {
  if (!req) return;
  Promise.resolve().then(() => report('logout', req)).catch(() => {});
}

module.exports = {
  reportLoginEvent,
  reportLogoutEvent,
  invalidateEnabledCache,
};
