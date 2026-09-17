'use strict';

function safeDetail(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[链接已省略]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|crh_|cr-sk-)[a-zA-Z0-9_-]+/g, '[已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim().slice(0, 600);
}

// 只提取错误说明，不向用户转发整个上游响应或请求数据。
function formatSummaryError(body, status) {
  const error = body?.error ?? body;
  const metadata = error?.metadata || {};
  let raw = metadata.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { /* plain-text provider reason */ }
  }
  const reason = safeDetail(typeof raw === 'object' && raw !== null
    ? (raw.error?.message || raw.message || (typeof raw.error === 'string' ? raw.error : ''))
    : raw);
  const message = safeDetail(typeof error === 'string' ? error : error?.message);
  const code = safeDetail(error?.code);
  const provider = safeDetail(metadata.provider_name);
  const httpStatus = Number(status);
  const parts = [Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
    ? `总结生成失败（HTTP ${httpStatus}）` : '总结生成失败（流式上游错误）'];
  if (provider) parts.push(`上游：${provider}`);
  if (code) parts.push(`错误码：${code}`);
  parts.push(`原因：${reason || message || '上游未提供具体错误说明'}`);
  if (reason && message && reason !== message) parts.push(`上游消息：${message}`);
  if (httpStatus === 429 || Number(error?.code) === 429) {
    parts.push(metadata.limit_source === 'upstream_provider_shared_pool'
      ? '限流来源：上游供应商共享额度池'
      : '请求被限流或额度受限');
    parts.push('建议：稍后重试，或在 CrewRouter Key 中选择其他可用模型。');
  } else if (httpStatus === 401 || httpStatus === 403) {
    parts.push('建议：检查 Key 权限；请管理员检查供应商凭据与模型访问权限。');
  } else if (httpStatus >= 500) {
    parts.push('建议：稍后重试；如持续失败，请管理员检查供应商服务。');
  }
  return parts.join('；');
}

module.exports = { formatSummaryError };
