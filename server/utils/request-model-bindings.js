'use strict';

/**
 * 请求 model 名称映射的输入归一化。
 *
 * 请求名来自客户端可自由填写的 `model` 字段，写库前必须统一校验：
 * - 名称去首尾空白、统一小写后入库，读取时再做一次小写比较；
 * - 用真实 Unicode 码点范围拦截控制字符（含换行、制表符），
 *   避免它们进入日志和下游请求头；
 * - harness 为空表示「所有 Harness」，否则必须是可单独绑定模型的来源；
 * - fusion 名称是网关保留路由，不能占用为映射名称。
 */

const MAX_REQUEST_MODEL_BINDINGS = 100;
const MAX_REQUEST_MODEL_NAME_LENGTH = 255;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const RESERVED_FUSION_NAME = /^fusion(?:$|[:/])/i;

function normalizeRequestModelName(rawName) {
  const requestModelName = String(rawName ?? '').trim();
  if (!requestModelName
    || requestModelName.length > MAX_REQUEST_MODEL_NAME_LENGTH
    || CONTROL_CHARS.test(requestModelName)) {
    return { error: `请求模型名不能为空、不可含控制字符且最多 ${MAX_REQUEST_MODEL_NAME_LENGTH} 字符` };
  }
  if (RESERVED_FUSION_NAME.test(requestModelName)) {
    return { error: `请求名为 ${requestModelName}，与保留的 Fusion 路由名称冲突` };
  }
  return { requestModelName: requestModelName.toLowerCase() };
}

function normalizeRequestModelBindings(input, { isHarnessSource, harnessSources = [] } = {}) {
  if (!Array.isArray(input) || input.length > MAX_REQUEST_MODEL_BINDINGS) {
    return { error: `bindings 必须是最多 ${MAX_REQUEST_MODEL_BINDINGS} 项的数组` };
  }
  const bindings = [];
  const seen = new Set();
  for (const item of input) {
    const nameCheck = normalizeRequestModelName(item?.requestModelName ?? item?.request_model_name);
    if (nameCheck.error) return { error: nameCheck.error };
    const harnessRaw = String(item?.harness || '').trim().toLowerCase();
    const harness = harnessRaw || null;
    const modelId = String(item?.modelId ?? item?.model_id ?? '').trim();
    if (harness && (typeof isHarnessSource !== 'function' || !isHarnessSource(harness) || harness === 'unknown')) {
      return { error: `无效的 harness，可选: ${harnessSources.join(', ')}` };
    }
    if (!modelId) return { error: `请为请求名 ${nameCheck.requestModelName} 选择目标模型` };
    const unique = `${harness || '*'}:${nameCheck.requestModelName}`;
    if (seen.has(unique)) return { error: `请求名映射重复: ${nameCheck.requestModelName}` };
    seen.add(unique);
    bindings.push({ requestModelName: nameCheck.requestModelName, harness, modelId });
  }
  return { bindings };
}

module.exports = {
  MAX_REQUEST_MODEL_BINDINGS,
  MAX_REQUEST_MODEL_NAME_LENGTH,
  normalizeRequestModelName,
  normalizeRequestModelBindings,
};
