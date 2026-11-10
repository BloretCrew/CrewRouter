'use strict';

// CrewRouter CLI profile/session/state storage. No third-party dependencies.
// Secrets live only in sessions.json and are written with mode 0600.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 20003;
const CONFIG_VERSION = 1;

function cliHome() {
  return path.resolve(process.env.CR_CLI_HOME || path.join(os.homedir(), '.config', 'crewrouter'));
}

function configPath() {
  return path.join(cliHome(), 'cli.json');
}

function sessionsPath() {
  return path.join(cliHome(), 'sessions.json');
}

function servicePath() {
  return path.join(cliHome(), 'service.json');
}

function logDir() {
  return path.join(cliHome(), 'logs');
}

function logPathForPort(port) {
  return path.join(logDir(), `local-${Number(port) || DEFAULT_PORT}.log`);
}

function ensurePrivateDir(dir = cliHome()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`配置目录不是普通目录：${dir}`);
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  } catch (error) {
    if (error.code === 'ENOENT') return ensurePrivateDir(dir);
    throw error;
  }
  return dir;
}

function atomicWriteJson(file, value, mode = 0o600) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try { fs.fchmodSync(fd, mode); } catch (_) {}
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, mode); } catch (_) {}
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_) { throw new Error('服务器地址无效，请使用 http:// 或 https:// URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务器地址必须使用 http 或 https');
  if (url.username || url.password) throw new Error('服务器地址不能包含用户名或密码');
  if (url.search || url.hash) throw new Error('服务器地址不能包含查询串或片段');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/v1') throw new Error('管理 API 地址必须指向站点根路径，不能带 /v1 或子路径');
  return `${url.protocol}//${url.host}`;
}

function isLoopbackBase(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
  } catch (_) { return false; }
}

function normalizePort(value, fallback = DEFAULT_PORT) {
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  return fallback;
}

function readServerConfig(configFile) {
  if (!configFile) return {};
  try {
    const value = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (_) { return {}; }
}

function defaultConfigFilePath() {
  if (process.env.CR_CONFIG_PATH) return path.resolve(process.env.CR_CONFIG_PATH);
  if (process.env.CR_CONFIG) return path.resolve(process.env.CR_CONFIG);
  const root = path.resolve(__dirname, '..', '..');
  for (const candidate of [path.join(root, 'config.json'), path.join(root, 'dist', 'config.json')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(root, 'config.json');
}

function resolveLocalPort({ port, configPath: explicitConfig } = {}) {
  if (port !== undefined && port !== null && port !== '') return normalizePort(port);
  if (process.env.CR_APP_PORT) return normalizePort(process.env.CR_APP_PORT);
  const configFile = explicitConfig ? path.resolve(explicitConfig) : defaultConfigFilePath();
  const config = readServerConfig(configFile);
  return normalizePort(config.app && config.app.port, DEFAULT_PORT);
}

function localProfile({ port, host = '127.0.0.1', configPath: explicitConfig } = {}) {
  const resolvedPort = resolveLocalPort({ port, configPath: explicitConfig });
  return {
    name: '本机',
    type: 'local',
    baseUrl: `http://${host}:${resolvedPort}`,
    host,
    port: resolvedPort,
    configPath: explicitConfig ? path.resolve(explicitConfig) : null,
  };
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const profiles = {};
  if (source.profiles && typeof source.profiles === 'object' && !Array.isArray(source.profiles)) {
    for (const [name, profile] of Object.entries(source.profiles)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) continue;
      if (!profile || typeof profile !== 'object') continue;
      try {
        profiles[name] = {
          name: String(profile.name || name).slice(0, 100),
          type: profile.type === 'local' ? 'local' : 'remote',
          baseUrl: normalizeBaseUrl(profile.baseUrl),
          ...(profile.type === 'local' ? {
            host: String(profile.host || new URL(profile.baseUrl).hostname),
            port: normalizePort(profile.port, Number(new URL(profile.baseUrl).port) || (new URL(profile.baseUrl).protocol === 'https:' ? 443 : 80)),
            configPath: profile.configPath ? path.resolve(profile.configPath) : null,
          } : {}),
        };
      } catch (_) { /* ignore malformed profile */ }
    }
  }
  const currentProfile = profiles[source.currentProfile] ? source.currentProfile
    : (Object.keys(profiles)[0] || null);
  return {
    version: CONFIG_VERSION,
    currentProfile,
    profiles,
    tui: {
      refreshMs: Math.min(Math.max(Number(source.tui && source.tui.refreshMs) || 10000, 2000), 60000),
      days: Math.min(Math.max(Number(source.tui && source.tui.days) || 30, 1), 365),
    },
  };
}

function loadConfig() {
  return normalizeConfig(readJson(configPath(), {}));
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  atomicWriteJson(configPath(), normalized, 0o600);
  return normalized;
}

function ensureLocalProfile({ port, host = '127.0.0.1', configPath: explicitConfig, makeCurrent = false } = {}) {
  const cfg = loadConfig();
  if (!cfg.profiles.local) cfg.profiles.local = localProfile({ port, host, configPath: explicitConfig });
  else if (port || explicitConfig) {
    cfg.profiles.local = { ...cfg.profiles.local, ...localProfile({ port, host, configPath: explicitConfig }) };
  }
  if (!cfg.currentProfile) cfg.currentProfile = 'local';
  if (makeCurrent) cfg.currentProfile = 'local';
  return saveConfig(cfg);
}

function activeProfile(cfg = loadConfig()) {
  if (!cfg.currentProfile) return null;
  return cfg.profiles[cfg.currentProfile] || null;
}

function setActiveProfile(name, cfg = loadConfig()) {
  if (!cfg.profiles[name]) throw new Error(`profile 不存在：${name}`);
  cfg.currentProfile = name;
  return saveConfig(cfg);
}

function saveRemoteProfile(name, baseUrl, { makeCurrent = true, displayName } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(name || ''))) {
    throw new Error('profile 名称只能包含字母、数字、点、下划线和短横线');
  }
  const cfg = loadConfig();
  cfg.profiles[name] = {
    name: displayName ? String(displayName).slice(0, 100) : name,
    type: 'remote',
    baseUrl: normalizeBaseUrl(baseUrl),
  };
  if (makeCurrent) cfg.currentProfile = name;
  return saveConfig(cfg);
}

function removeProfile(name, cfg = loadConfig()) {
  if (!cfg.profiles[name]) throw new Error(`profile 不存在：${name}`);
  if (cfg.currentProfile === name) throw new Error('不能删除当前 profile，请先切换到其他 profile');
  delete cfg.profiles[name];
  return saveConfig(cfg);
}

function normalizeSessions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const profiles = {};
  if (source.profiles && typeof source.profiles === 'object' && !Array.isArray(source.profiles)) {
    for (const [name, entry] of Object.entries(source.profiles)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      profiles[name] = {
        authType: entry.authType === 'api-key' ? 'api-key' : 'session',
        ...(entry.authType === 'api-key' ? { apiKey: String(entry.apiKey || '') } : {
          cookieJar: Array.isArray(entry.cookieJar) ? entry.cookieJar.filter(cookie => cookie && typeof cookie.name === 'string') : [],
          csrfToken: typeof entry.csrfToken === 'string' ? entry.csrfToken : '',
        }),
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
        username: entry.username ? String(entry.username) : '',
        isAdmin: entry.isAdmin === true ? true : entry.isAdmin === false ? false : null,
        savedAt: Number(entry.savedAt) || Date.now(),
        lastVerifiedAt: Number(entry.lastVerifiedAt) || null,
      };
    }
  }
  return { version: CONFIG_VERSION, profiles };
}

function loadSessions() {
  return normalizeSessions(readJson(sessionsPath(), { version: CONFIG_VERSION, profiles: {} }));
}

function saveSessions(sessions) {
  const normalized = normalizeSessions(sessions);
  atomicWriteJson(sessionsPath(), normalized, 0o600);
  return normalized;
}

function getSession(name) {
  return loadSessions().profiles[name] || null;
}

function saveSession(name, session) {
  const sessions = loadSessions();
  sessions.profiles[name] = {
    ...session,
    savedAt: Date.now(),
    lastVerifiedAt: Date.now(),
  };
  return saveSessions(sessions).profiles[name];
}

function clearSession(name) {
  const sessions = loadSessions();
  if (sessions.profiles[name]) delete sessions.profiles[name];
  saveSessions(sessions);
}

function normalizeServiceState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pid = Number(raw.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    nonce: String(raw.nonce || ''),
    host: String(raw.host || '127.0.0.1'),
    port: normalizePort(raw.port),
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : `http://${raw.host || '127.0.0.1'}:${normalizePort(raw.port)}`,
    startedAt: Number(raw.startedAt) || Date.now(),
    configPath: raw.configPath ? String(raw.configPath) : null,
    logPath: raw.logPath ? String(raw.logPath) : null,
    demo: raw.demo === true,
  };
}

function loadServiceState() {
  return normalizeServiceState(readJson(servicePath(), null));
}

function saveServiceState(state) {
  atomicWriteJson(servicePath(), state, 0o600);
  return state;
}

function clearServiceState() {
  try { fs.unlinkSync(servicePath()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function tailFile(file, lines = 80) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-Math.max(1, lines)).join('\n');
  } catch (_) {
    return '';
  }
}

module.exports = {
  DEFAULT_PORT,
  CONFIG_VERSION,
  cliHome,
  configPath,
  sessionsPath,
  servicePath,
  logDir,
  logPathForPort,
  ensurePrivateDir,
  atomicWriteJson,
  readJson,
  normalizeBaseUrl,
  isLoopbackBase,
  normalizePort,
  defaultConfigFilePath,
  resolveLocalPort,
  localProfile,
  loadConfig,
  saveConfig,
  ensureLocalProfile,
  activeProfile,
  setActiveProfile,
  saveRemoteProfile,
  removeProfile,
  loadSessions,
  saveSessions,
  getSession,
  saveSession,
  clearSession,
  loadServiceState,
  saveServiceState,
  clearServiceState,
  tailFile,
};
