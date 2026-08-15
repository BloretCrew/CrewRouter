/**
 * Panel Runner - 并行执行多个 Panel 模型
 *
 * 职责：
 * - 将 prompt 同时发送给多个模型
 * - 收集所有模型的输出
 * - 处理错误和超时
 */

const Logger = require('../logger');

// 并行执行 Panel 模型
async function runPanels(fusionConfig, messages, options = {}) {
  const { temperature, max_tokens, callModel, tools, tool_choice, response_format } = options;
  const panelModels = fusionConfig.panel_models || [];
  const maxPanelCount = fusionConfig.max_panel_count || 8;

  // 限制 Panel 数量
  const modelsToRun = panelModels.slice(0, maxPanelCount);

  Logger.info(`[Panel] 开始并行执行: ${modelsToRun.length} 个模型`);

  // 并行调用所有模型
  const promises = modelsToRun.map(async (modelId, index) => {
    const panelStart = Date.now();
    try {
      Logger.info(`[Panel] 调用模型 ${index + 1}/${modelsToRun.length}: ${modelId}`);

      const result = await callModel(modelId, messages, {
        temperature,
        max_tokens,
        tools,
        tool_choice,
        response_format
      });

      const latency = Date.now() - panelStart;
      Logger.info(`[Panel] 模型 ${modelId} 完成: latency=${latency}ms, content_length=${result.content?.length || 0}`);

      return {
        model_id: modelId,
        index,
        success: true,
        content: result.content,
        usage: result.usage,
        latency
      };
    } catch (err) {
      const latency = Date.now() - panelStart;
      Logger.error(`[Panel] 模型 ${modelId} 失败: error=${err.message}, latency=${latency}ms`);

      return {
        model_id: modelId,
        index,
        success: false,
        error: err.message,
        content: '',
        usage: { promptTokens: 0, completionTokens: 0 },
        latency
      };
    }
  });

  // 等待所有模型完成
  const results = await Promise.all(promises);

  // 统计结果
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const totalLatency = Math.max(...results.map(r => r.latency));

  Logger.info(`[Panel] 执行完成: ${successCount} 成功, ${failCount} 失败, 总耗时=${totalLatency}ms`);

  return results;
}

// 构建 Panel 输出摘要（用于 Judge 分析）
function buildPanelSummary(panelResults) {
  return panelResults
    .filter(r => r.success)
    .map((r, i) => ({
      model: r.model_id,
      index: r.index,
      content: r.content,
      tokens: (r.usage?.promptTokens || 0) + (r.usage?.completionTokens || 0)
    }));
}

module.exports = {
  runPanels,
  buildPanelSummary
};
