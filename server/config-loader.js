/**
 * 统一配置加载器
 *
 * 优先级：环境变量 (CR_*) > config.json > 默认值
 * 支持 Docker 部署场景下纯环境变量配置（无 config.json）
 */

const fs = require('fs');
const path = require('path');

// 配置文件路径兼容：
// - 开发：server/config-loader.js → 项目根 config.json
// - 构建后：dist/server.js → dist/config.json（与 server.js 同级）
function resolveConfigPath() {
  const candidates = [
    path.join(__dirname, 'config.json'),           // dist/ 同级
    path.join(__dirname, '..', 'config.json'),     // 开发时 server/../config.json
    path.join(process.cwd(), 'config.json'),       // 当前工作目录
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

// 默认配置
const DEFAULTS = {
  app: {
    name: 'CrewRouter',
    port: 20003,
    host: 'localhost',
    sessionSecret: 'change-me-in-production',
    demo: false,
  },
  database: {
    host: 'localhost',
    port: 5432,
    name: 'crewrouter',
    user: 'crewrouter',
    password: '',
  },
  demo: false,
};

// 读取 config.json（如果存在）
function loadConfigFile() {
  const configPath = resolveConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      console.log(`[config-loader] 已加载配置: ${configPath}`);
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[config-loader] 读取 config.json 失败:', err.message);
  }
  console.log('[config-loader] 未找到 config.json，使用默认值 + 环境变量');
  return {};
}

// 环境变量映射表：ENV_NAME → config 路径
const ENV_MAP = {
  // app
  CR_APP_NAME:           'app.name',
  CR_APP_PORT:           'app.port',
  CR_APP_HOST:           'app.host',
  CR_SESSION_SECRET:     'app.sessionSecret',
  CR_DEMO:               'app.demo',

  // database
  CR_DB_HOST:            'database.host',
  CR_DB_PORT:            'database.port',
  CR_DB_NAME:            'database.name',
  CR_DB_USER:            'database.user',
  CR_DB_PASSWORD:        'database.password',

  // feishu
  CR_FEISHU_APP_ID:      'feishu.appId',
  CR_FEISHU_APP_SECRET:  'feishu.appSecret',
  CR_FEISHU_TENANT_KEY:  'feishu.tenantKey',

  // github oauth
  CR_GITHUB_CLIENT_ID:     'github.clientId',
  CR_GITHUB_CLIENT_SECRET: 'github.clientSecret',
  CR_GITHUB_REDIRECT_URI:  'github.redirectUri',

  // email
  CR_EMAIL_ADDRESS:      'email.address',
  CR_EMAIL_PASSWORD:     'email.password',
  CR_SMTP_HOST:          'email.SMTP.host',
  CR_SMTP_PORT:          'email.SMTP.port',
  CR_SMTP_SSL:           'email.SMTP.SSL',

  // env (provider env vars)
  CR_ANTHROPIC_BASE_URL:   'env.ANTHROPIC_BASE_URL',
  CR_ANTHROPIC_AUTH_TOKEN: 'env.ANTHROPIC_AUTH_TOKEN',
};

// 深度合并对象（source 覆盖 target）
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

// 根据路径设置值："a.b.c" → obj.a.b.c = value
function setByPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// 类型转换：字符串环境变量 → 合适的 JS 类型
function coerceValue(value, targetType) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (targetType === 'number' || (typeof targetType === 'number')) {
    const n = Number(value);
    if (!isNaN(n)) return n;
  }
  // 尝试数字转换（端口号等）
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

// 构建环境变量覆盖层
function buildEnvOverlay() {
  const overlay = {};
  for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
    const envValue = process.env[envKey];
    if (envValue !== undefined && envValue !== '') {
      setByPath(overlay, configPath, coerceValue(envValue));
    }
  }
  return overlay;
}

// 加载最终配置
function loadConfig() {
  const fileConfig = loadConfigFile();
  const withDefaults = deepMerge(DEFAULTS, fileConfig);
  const envOverlay = buildEnvOverlay();
  const final = deepMerge(withDefaults, envOverlay);

  // 确保嵌套对象有默认值
  if (!final.database) final.database = DEFAULTS.database;
  if (!final.app) final.app = DEFAULTS.app;

  return final;
}

const config = loadConfig();

// 冻结配置防止运行时修改
Object.freeze(config);

module.exports = config;
