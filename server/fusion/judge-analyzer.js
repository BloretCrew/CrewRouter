/**
 * Judge Analyzer - 分析各 Panel 模型输出的差异
 *
 * 职责：
 * - 分析各 Panel 输出的共识、矛盾、盲点、独特洞见
 * - 输出结构化 JSON 分析结果
 */

const Logger = require('../logger');

// Judge 分析 Prompt 模板
const JUDGE_PROMPT_TEMPLATE = `你是一个专业的 AI 输出分析专家。请分析以下多个 AI 模型对同一问题的回答，找出：

1. **共识点 (consensus)**: 所有或大多数模型都认同的观点
2. **矛盾点 (contradictions)**: 模型之间存在分歧或矛盾的地方
3. **盲点 (blind_spots)**: 大多数模型都忽略或未充分讨论的方面
4. **独特洞见 (unique_insights)**: 某个模型提出的独特或创新性观点

请以 JSON 格式输出分析结果，格式如下：
{
  "consensus": ["观点1", "观点2", ...],
  "contradictions": [
    {"topic": "主题", "models": ["模型A观点", "模型B观点"], "analysis": "分析"}
  ],
  "blind_spots": ["盲点1", "盲点2", ...],
  "unique_insights": [
    {"model": "模型名", "insight": "洞见内容", "significance": "重要性说明"}
  ],
  "confidence_scores": {
    "模型名": 0.85,
    ...
  }
}

请仅输出 JSON，不要添加任何额外说明。`;

// 构建 Judge 分析请求
function buildJudgeMessages(originalMessages, panelResults) {
  // 构建 Panel 输出摘要
  const panelSummary = panelResults
    .filter(r => r.success)
    .map((r, i) => `=== 模型 ${i + 1}: ${r.model_id} ===\n${r.content}`)
    .join('\n\n');

  // 获取原始用户问题
  const userQuestion = originalMessages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join('\n');

  return [
    {
      role: 'system',
      content: JUDGE_PROMPT_TEMPLATE
    },
    {
      role: 'user',
      content: `原始问题：\n${userQuestion}\n\n各模型回答：\n${panelSummary}\n\n请分析以上回答。`
    }
  ];
}

// 运行 Judge 分析
async function runJudge(fusionConfig, originalMessages, panelResults, options = {}) {
  const { callModel } = options;
  const judgeModelId = fusionConfig.judge_model_id;

  if (!judgeModelId) {
    Logger.warn('[Judge] 未配置 Judge 模型，跳过分析');
    return {
      consensus: [],
      contradictions: [],
      blind_spots: [],
      unique_insights: [],
      confidence_scores: {},
      skipped: true
    };
  }

  Logger.info(`[Judge] 开始分析: 使用模型 ${judgeModelId}`);

  try {
    // 构建 Judge 请求
    const judgeMessages = buildJudgeMessages(originalMessages, panelResults);
    Logger.info(`[Judge] 请求已构建: ${judgeMessages.length} 条消息`);

    // 调用 Judge 模型（带 90 秒超时）
    const judgeStart = Date.now();
    const judgeTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Judge 调用超时 (90s)')), 90000)
    );
    const result = await Promise.race([
      callModel(judgeModelId, judgeMessages, { temperature: 0.3, max_tokens: 4096 }),
      judgeTimeout
    ]);
    Logger.info(`[Judge] 模型调用完成: latency=${Date.now() - judgeStart}ms, content_length=${result.content?.length || 0}`);

    // 解析 JSON 响应
    let analysis;
    try {
      // 尝试从响应中提取 JSON
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('无法从响应中提取 JSON');
      }
    } catch (parseErr) {
      Logger.warn(`[Judge] JSON 解析失败: ${parseErr.message}, 原始响应: ${result.content.substring(0, 500)}`);
      analysis = {
        consensus: [],
        contradictions: [],
        blind_spots: [],
        unique_insights: [],
        confidence_scores: {},
        parse_error: parseErr.message
      };
    }

    Logger.info(`[Judge] 分析完成: consensus=${analysis.consensus?.length || 0}, contradictions=${analysis.contradictions?.length || 0}, blind_spots=${analysis.blind_spots?.length || 0}, unique_insights=${analysis.unique_insights?.length || 0}`);

    return {
      ...analysis,
      usage: result.usage,
      model_id: judgeModelId
    };
  } catch (err) {
    Logger.error(`[Judge] 分析失败: ${err.message}`);
    return {
      consensus: [],
      contradictions: [],
      blind_spots: [],
      unique_insights: [],
      confidence_scores: {},
      error: err.message
    };
  }
}

module.exports = {
  runJudge,
  buildJudgeMessages,
  JUDGE_PROMPT_TEMPLATE
};
