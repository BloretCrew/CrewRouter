/**
 * 操作日志工具
 *
 * 记录用户/管理员在系统中的每一次写操作（POST/PUT/DELETE/PATCH），
 * 精确到人、时间、IP、操作类型与目标。
 *
 * 用法：
 *   1. 路由级自动记录：在需要审计的路由上挂载 `auditMiddleware()`，
 *      它会在响应结束后按 HTTP 方法+路径自动生成一条日志。
 *   2. 业务级显式记录：在关键业务点（如 Co-Key 成员变更、登录）调用
 *      `logAction(...)` 补充结构化详情。
 *
 * 日志写入采用 fire-and-forget，失败仅记 Logger.warn，不影响业务流程。
 */
const { pool } = require('../models/database');
const Logger = require('../logger');

/**
 * 操作类型枚举（用于 operation_logs.action）
 * 命名约定：resource.verb，例如 api_key.create
 */
const ACTIONS = {
  // 认证
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_2FA: 'auth.login_2fa',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_SET_PASSWORD: 'auth.set_password',
  AUTH_CHANGE_PASSWORD: 'auth.change_password',

  // 插件自有操作
  PLUGIN_ACTION: 'plugin.action',

  // Co-Key 成员
  COKEY_MEMBER_ADD: 'cokey.member_add',
  COKEY_MEMBER_REMOVE: 'cokey.member_remove',
  COKEY_MEMBER_LEAVE: 'cokey.member_leave',

  // API Key
  API_KEY_CREATE: 'api_key.create',
  API_KEY_UPDATE: 'api_key.update',
  API_KEY_DELETE: 'api_key.delete',
  API_KEY_TOGGLE: 'api_key.toggle',
  API_KEY_MODELS: 'api_key.models',
  API_KEY_FUSION: 'api_key.fusion',
  API_KEY_SIGNATURE: 'api_key.signature',
  API_KEY_SCHEDULE: 'api_key.schedule',
  API_KEY_SWALLOW_IMAGES: 'api_key.swallow_images',
  API_KEY_CREWROUTER_COMMANDS: 'api_key.crewrouter_commands',
  API_KEY_TAGS: 'api_key.tags',

  // 用户自身
  USER_SETTINGS: 'user.settings',
  USER_AVATAR: 'user.avatar',
  USER_REDEEM: 'user.redeem',
  USER_PROVIDER_CREATE: 'user.provider_create',
  USER_PROVIDER_UPDATE: 'user.provider_update',
  USER_PROVIDER_DELETE: 'user.provider_delete',
  USER_MODEL_CREATE: 'user.model_create',
  USER_MODEL_UPDATE: 'user.model_update',
  USER_MODEL_DELETE: 'user.model_delete',
  USER_MODEL_PUBLISH: 'user.model_publish',
  USER_2FA_ENABLE: 'user.2fa_enable',
  USER_2FA_DISABLE: 'user.2fa_disable',
  USER_PASSKEY_REGISTER: 'user.passkey_register',
  USER_PASSKEY_DELETE: 'user.passkey_delete',
  USER_CONVERSATION: 'user.conversation',

  // 管理员
  ADMIN_USER_UPDATE: 'admin.user_update',
  ADMIN_USER_REFUND: 'admin.user_refund',
  ADMIN_MODEL_CREATE: 'admin.model_create',
  ADMIN_MODEL_UPDATE: 'admin.model_update',
  ADMIN_MODEL_DELETE: 'admin.model_delete',
  ADMIN_MODEL_BATCH: 'admin.model_batch',
  ADMIN_PROVIDER_CREATE: 'admin.provider_create',
  ADMIN_PROVIDER_UPDATE: 'admin.provider_update',
  ADMIN_PROVIDER_DELETE: 'admin.provider_delete',
  ADMIN_PROVIDER_TOGGLE: 'admin.provider_toggle',
  ADMIN_PROVIDER_SYNC: 'admin.provider_sync',
  ADMIN_TEAM_CREATE: 'admin.team_create',
  ADMIN_TEAM_UPDATE: 'admin.team_update',
  ADMIN_TEAM_DELETE: 'admin.team_delete',
  ADMIN_TEAM_MEMBER: 'admin.team_member',
  ADMIN_TEAM_MODEL: 'admin.team_model',
  ADMIN_USER_GROUP: 'admin.user_group',
  ADMIN_REDEMPTION_CODE: 'admin.redemption_code',
  ADMIN_PRODUCT: 'admin.product',
  ADMIN_SETTINGS: 'admin.settings',
  ADMIN_FEISHU: 'admin.feishu',
  ADMIN_FUSION_CONFIG: 'admin.fusion_config',
  ADMIN_PROVIDER_TAG: 'admin.provider_tag',

  // 插件
  PLUGIN_INSTALL: 'plugin.install',
  PLUGIN_UNINSTALL: 'plugin.uninstall',
};

/**
 * 异步写入一条操作日志
 * @param {object} params
 * @param {number|null} params.userId  操作者用户 ID（未登录为 null）
 * @param {string} params.username     操作者用户名（未登录为 '系统' 或 IP）
 * @param {boolean} params.isAdmin     是否管理员操作
 * @param {string} params.action       操作类型（见 ACTIONS）
 * @param {string} params.resourceType 资源类型（如 api_key / user / provider）
 * @param {string|number|null} params.resourceId  资源 ID
 * @param {string} params.description  可读描述
 * @param {object} [params.details]    结构化详情（JSON）
 * @param {string} [params.ip]         请求 IP
 * @param {string} [params.userAgent]  User-Agent
 * @param {number} [params.status]     HTTP 状态码
 * @param {number} [params.durationMs] 耗时毫秒
 */
async function logAction({
  userId = null,
  username = '系统',
  isAdmin = false,
  action,
  resourceType = '',
  resourceId = null,
  description = '',
  details = null,
  ip = null,
  userAgent = null,
  status = 200,
  durationMs = null,
}) {
  try {
    await pool.query(
      `INSERT INTO operation_logs
         (user_id, username, is_admin, action, resource_type, resource_id,
          description, details, ip_address, user_agent, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        userId,
        String(username || '系统').slice(0, 255),
        !!isAdmin,
        String(action || 'unknown').slice(0, 100),
        String(resourceType || '').slice(0, 50),
        resourceId == null ? null : String(resourceId).slice(0, 100),
        String(description || '').slice(0, 500),
        details == null ? null : JSON.stringify(details),
        ip ? String(ip).slice(0, 45) : null,
        userAgent ? String(userAgent).slice(0, 500) : null,
        Number.isFinite(status) ? status : null,
        Number.isFinite(durationMs) ? durationMs : null,
      ]
    );
  } catch (err) {
    Logger.warn(`[操作日志] 写入失败: ${err.message}`);
  }
}

/**
 * Express 中间件：自动记录经过该路由的写操作。
 * 在 res.finish 时触发，依据 action 映射生成日志。
 *
 * @param {string} action        操作类型（见 ACTIONS）
 * @param {object} [opts]
 * @param {string} [opts.resourceType]  资源类型
 * @param {function} [opts.resourceIdFrom]  (req) => resourceId
 * @param {function} [opts.descriptionFrom] (req, res) => description
 * @param {function} [opts.detailsFrom]     (req, res) => details
 * @param {boolean} [opts.onlySuccess]      仅记录 2xx（默认 true）
 */
function auditMiddleware(action, opts = {}) {
  const {
    resourceType = '',
    resourceIdFrom = null,
    descriptionFrom = null,
    detailsFrom = null,
    onlySuccess = true,
  } = opts;

  return (req, res, next) => {
    const start = Date.now();
    const recordLog = () => {
      res.removeListener('finish', recordLog);
      const status = res.statusCode;
      if (onlySuccess && (status < 200 || status >= 300)) return;

      const user = req.session?.user;
      const details = detailsFrom ? safeCall(detailsFrom, req, res) : null;

      logAction({
        userId: user?.id || null,
        username: user?.username || (req.ip || '匿名'),
        isAdmin: !!user?.isAdmin,
        action,
        resourceType,
        resourceId: resourceIdFrom ? safeCall(resourceIdFrom, req) : null,
        description: descriptionFrom ? safeCall(descriptionFrom, req, res) : '',
        details,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        status,
        durationMs: Date.now() - start,
      });
    };
    res.on('finish', recordLog);
    next();
  };
}

function safeCall(fn, ...args) {
  try { return fn(...args); } catch { return null; }
}

module.exports = {
  ACTIONS,
  logAction,
  auditMiddleware,
};
