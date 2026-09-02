'use strict';

/** 将 API Key 的模型绑定查询结果组装成网关请求身份字段。 */
function buildApiKeyModelBindings({ currentModelId = null, modelQueueRows = [], harnessRows = [] } = {}) {
  const modelQueue = Array.isArray(modelQueueRows)
    ? modelQueueRows
      .filter(row => row && row.model_id && row.enabled !== false)
      .map(row => String(row.model_id).trim())
      .filter(Boolean)
    : [];
  const harnessModels = {};
  if (Array.isArray(harnessRows)) {
    for (const row of harnessRows) {
      const harness = String(row?.harness || '').trim();
      const modelId = String(row?.model_id || '').trim();
      if (harness && modelId) harnessModels[harness] = modelId;
    }
  }
  return {
    currentModelId: currentModelId ? String(currentModelId).trim() : null,
    modelQueue,
    harnessModels,
  };
}

/** 会话记录按时间升序读取时，选取该会话最后一条记录使用的 API Key。 */
function resolveSummaryApiKeyId(records = []) {
  if (!Array.isArray(records)) return null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const value = Number(records[i]?.api_key_id);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

module.exports = { buildApiKeyModelBindings, resolveSummaryApiKeyId };
