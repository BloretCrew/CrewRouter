/**
 * API 调用错误记录
 * - 热路径 fire-and-forget 写入
 * - 管理后台查询近期失败调用
 */
const { pool } = require('../models/database');
const Logger = require('../logger');
const { notifyUser, NOTIFICATION_TYPES } = require('./notifications');

const MAX_MESSAGE_LEN = 4000;
const MAX_BODY_LEN = 8000;
/** 默认保留天数，查询与定期清理共用 */
const RETENTION_DAYS = 14;

let tableReady = false;
let cleanupTimer = null;

function truncate(str, max) {
  if (str == null) return null;
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

function extractErrorMessage(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  try {
    if (body.error?.message) return body.error.message;
    if (body.message) return body.message;
    if (body.error && typeof body.error === 'string') return body.error;
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return String(body);
  }
}

function extractErrorType(body) {
  if (body == null || typeof body !== 'object') return null;
  if (body.error?.type) return String(body.error.type);
  if (body.error?.code) return String(body.error.code);
  if (body.type && body.type !== 'error') return String(body.type);
  return null;
}

function clientIp(req) {
  if (!req) return null;
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 45);
  }
  const realIp = req.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim().slice(0, 45);
  }
  return (req.ip || req.socket?.remoteAddress || null);
}

/**
 * 建表（启动迁移 / 首次写入前）
 */
async function ensureApiErrorRecordsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_error_records (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        api_key_id INTEGER,
        model_id VARCHAR(255),
        provider_id VARCHAR(100),
        request_type VARCHAR(50) DEFAULT 'chat',
        status_code INTEGER,
        error_type VARCHAR(100),
        error_message TEXT,
        error_body TEXT,
        latency_ms INTEGER,
        ip_address VARCHAR(45),
        is_final BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_error_records_created
      ON api_error_records (created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_error_records_user
      ON api_error_records (user_id, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_error_records_provider
      ON api_error_records (provider_id, created_at DESC)
    `);
    tableReady = true;
    Logger.info('[迁移] 表 api_error_records 已就绪');
  } catch (err) {
    Logger.warn(`[迁移] api_error_records 表创建跳过: ${err.message}`);
  }
}

/**
 * 清理过期错误记录（默认保留 14 天）
 */
async function cleanupOldErrorRecords(days = RETENTION_DAYS) {
  try {
    const result = await pool.query(
      `DELETE FROM api_error_records
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [days]
    );
    if (result.rowCount > 0) {
      Logger.info(`[错误记录] 已清理 ${result.rowCount} 条超过 ${days} 天的记录`);
    }
  } catch (err) {
    Logger.warn(`[错误记录] 清理失败: ${err.message}`);
  }
}

function startErrorRecordsCleanup() {
  if (cleanupTimer) return;
  // 启动后延迟 2 分钟再清，之后每 6 小时
  setTimeout(() => {
    cleanupOldErrorRecords().catch(() => {});
    cleanupTimer = setInterval(() => {
      cleanupOldErrorRecords().catch(() => {});
    }, 6 * 60 * 60 * 1000);
    if (cleanupTimer.unref) cleanupTimer.unref();
  }, 2 * 60 * 1000);
}

/**
 * 记录一次 API 调用错误（异步，不阻塞主路径）
 * @param {object} opts
 */
function recordApiError(opts = {}) {
  const {
    userId = null,
    apiKeyId = null,
    modelId = null,
    providerId = null,
    requestType = 'chat',
    statusCode = null,
    errorType = null,
    errorMessage = null,
    errorBody = null,
    latencyMs = null,
    ipAddress = null,
    isFinal = true,
    req = null,
  } = opts;

  // 从 body / Error 对象推断
  let message = errorMessage;
  let type = errorType;
  let bodyStr = null;

  if (errorBody != null) {
    if (typeof errorBody === 'string') {
      bodyStr = errorBody;
      if (!message) message = errorBody;
    } else if (errorBody instanceof Error) {
      if (!message) message = errorBody.message;
      if (!type) type = 'exception';
      bodyStr = errorBody.stack || errorBody.message;
    } else {
      if (!message) message = extractErrorMessage(errorBody);
      if (!type) type = extractErrorType(errorBody);
      try {
        bodyStr = JSON.stringify(errorBody);
      } catch {
        bodyStr = String(errorBody);
      }
    }
  }

  if (!message) message = 'Unknown error';
  if (!type) type = statusCode != null && statusCode >= 500 ? 'server_error' : 'api_error';

  const ip = ipAddress || clientIp(req);

  const run = async () => {
    if (!tableReady) {
      await ensureApiErrorRecordsTable();
    }
    await pool.query(
      `INSERT INTO api_error_records
        (user_id, api_key_id, model_id, provider_id, request_type,
         status_code, error_type, error_message, error_body,
         latency_ms, ip_address, is_final)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        userId,
        apiKeyId,
        modelId != null ? String(modelId).slice(0, 255) : null,
        providerId != null ? String(providerId).slice(0, 100) : null,
        requestType != null ? String(requestType).slice(0, 50) : 'chat',
        statusCode != null ? parseInt(statusCode, 10) || null : null,
        type != null ? String(type).slice(0, 100) : null,
        truncate(message, MAX_MESSAGE_LEN),
        truncate(bodyStr, MAX_BODY_LEN),
        latencyMs != null ? Math.max(0, Math.round(latencyMs)) : null,
        ip != null ? String(ip).slice(0, 45) : null,
        isFinal !== false,
      ]
    );
  };

  run().catch((err) => {
    Logger.warn(`[错误记录] 写入失败: ${err.message}`);
  });

  if (userId && isFinal) {
    notifyUser(userId, NOTIFICATION_TYPES.REQUEST_ERROR,
      `${requestType || 'API'} 请求异常${statusCode ? `（HTTP ${statusCode}）` : ''}：${truncate(message, 500)}`,
      { statusCode, errorType: type, modelId, providerId }).catch(() => {});
  }
}

/**
 * 从 Express req + 错误上下文快捷记录
 */
function captureCallError(req, context = {}) {
  const apiUser = req?.apiUser || {};
  const {
    modelId = null,
    providerId = null,
    requestType = 'chat',
    status = null,
    body = null,
    error = null,
    latencyMs = null,
    isFinal = true,
  } = context;

  recordApiError({
    userId: apiUser.userId ?? null,
    apiKeyId: apiUser.keyId ?? null,
    modelId,
    providerId,
    requestType,
    statusCode: status,
    errorType: error ? 'exception' : extractErrorType(body),
    errorMessage: error?.message || extractErrorMessage(body),
    errorBody: error || body,
    latencyMs,
    req,
    isFinal,
  });
}

module.exports = {
  ensureApiErrorRecordsTable,
  cleanupOldErrorRecords,
  startErrorRecordsCleanup,
  recordApiError,
  captureCallError,
  clientIp,
  extractErrorMessage,
  extractErrorType,
  RETENTION_DAYS,
};
