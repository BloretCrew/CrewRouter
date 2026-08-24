/**
 * 注入提示词回显净化（响应侧）
 *
 * 模型偶发把 system 里的注入块原样复述进回复（诊断：usage_records 中
 * request_source=hermes 的 4 条记录）。本模块在网关返回客户端前剥离这些片段，
 * 使无论模型怎么复述，客户端都收不到污染内容。
 *
 * 剥离规则（与 utils/inject-prompt.js 的拼接格式对应）：
 * - 锚点：文本开头或空行后的独立标题行 `# User Custom Instructions (CrewRouter)`；
 * - 从锚点吞到下一个 `\n\n---\n\n` 分隔符或文本结尾；
 * - 若整条消息剥完为空/纯空白，返回空串标记；
 * - 行中内联提及标题的正文不受影响（无空行边界即不匹配）。
 *
 * 已知限制：
 * - 多条目回显若未逐字复述全量拼接文本，锚点扫描只剥到首个分隔符，
 *   后续条目残留——接入点传入 exactText（buildInjectedPrompt 原文）时走精确移除优先。
 * - 流式路径未接入净化（降级），残余风险见任务总结。
 */

'use strict';

// 缓解前缀与 utils/inject-prompt.js 保持一致；复述消息可能带上它，一并剥离
let INJECT_MITIGATION_PREFIX = '[System-injected reference notes';
try {
  ({ INJECT_MITIGATION_PREFIX } = require('./inject-prompt'));
} catch { /* 独立使用时回退到字面前缀识别 */ }

const INJECT_HEADER_TITLE = '# User Custom Instructions (CrewRouter)';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 锚点：字符串开头或空行后的独立标题行（容忍行尾空白与 \r\n）
// 单个 \n 紧邻标题不构成锚点，避免误伤行内引用
const HEADER_BLOCK_RE = new RegExp(
  '(^|\\n\\n|\\r\\n\\r\\n)[ \\t]*' + escapeRegExp(INJECT_HEADER_TITLE) + '[ \\t]*\\r?\\n[\\s\\S]*?(?=\\n\\n---\\n\\n|$)',
  'g'
);

// 同上，但额外吞掉紧邻标题之前的缓解前缀行（拼接文本的标准开头形态）
const FULL_BLOCK_RE = new RegExp(
  '(^|\\n|\\r\\n)' + escapeRegExp(INJECT_MITIGATION_PREFIX) + '[^\\n]*\\r?\\n(?:[ \\t]*\\r?\\n)+[ \\t]*'
  + escapeRegExp(INJECT_HEADER_TITLE) + '[ \\t]*\\r?\\n[\\s\\S]*?(?=\\n\\n---\\n\\n|$)',
  'g'
);

/**
 * 从完整注入文本派生精确移除候选：
 * 原文、去尾部换行、以及从特征标题起的子串（模型复述时可能省略缓解前缀行）。
 */
function exactCandidates(injectPromptText) {
  const out = new Set();
  const add = (s) => { if (typeof s === 'string' && s.trim()) out.add(s); };
  add(injectPromptText);
  add(injectPromptText.replace(/\n+$/, ''));
  const idx = injectPromptText.indexOf(INJECT_HEADER_TITLE);
  if (idx > 0) {
    const fromHeader = injectPromptText.slice(idx);
    add(fromHeader);
    add(fromHeader.replace(/\n+$/, ''));
  }
  return [...out];
}

/**
 * 剥离文本中的注入块回显。
 * @param {string} text 待净化的模型输出文本
 * @param {object} [options]
 * @param {string} [options.exactText] 本次请求实际拼好的注入全文；提供时先做精确移除
 * @returns {string} 净化后的文本；整条剥空时为 ''
 */
function scrubInjectedEcho(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  let changed = false;

  // 1) 精确移除：与本次启用条目拼接结果完全一致的片段
  for (const candidate of exactCandidates(options.exactText || '')) {
    if (out.includes(candidate)) {
      out = out.split(candidate).join('');
      changed = true;
    }
  }

  // 2) 锚点扫描：缓解前缀行+标题行起、到分隔符或文本结尾；未命中再退回纯标题锚点
  if (FULL_BLOCK_RE.test(out)) {
    FULL_BLOCK_RE.lastIndex = 0;
    out = out.replace(FULL_BLOCK_RE, (m, boundary) => boundary);
    changed = true;
  }
  FULL_BLOCK_RE.lastIndex = 0;
  if (HEADER_BLOCK_RE.test(out)) {
    HEADER_BLOCK_RE.lastIndex = 0;
    out = out.replace(HEADER_BLOCK_RE, (m, boundary) => boundary);
    changed = true;
  }
  HEADER_BLOCK_RE.lastIndex = 0;

  if (!changed) return text;

  // 拼接清理：块被剥后可能残留悬空的分隔符/多余空行/尾随空白
  out = out.replace(/^(?:\r?\n)+/, '').replace(/^(?:\r?\n)*---(?:\r?\n)+/, '');
  out = out.replace(/\n{3,}---\n\n/g, '\n\n---\n\n');
  out = out.replace(/\s+$/, '');

  return out.trim() === '' ? '' : out;
}

/**
 * OpenAI chat.completion 非流式 JSON 就地净化（choices[].message.content）。
 * @returns {boolean} 是否有改动
 */
function scrubOpenAiChatCompletion(data, injectPromptText) {
  if (!injectPromptText || !data || !Array.isArray(data.choices)) return false;
  let changed = false;
  for (const choice of data.choices) {
    const msg = choice && choice.message;
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      const s = scrubInjectedEcho(msg.content, { exactText: injectPromptText });
      if (s !== msg.content) { msg.content = s; changed = true; }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          const s = scrubInjectedEcho(part.text, { exactText: injectPromptText });
          if (s !== part.text) { part.text = s; changed = true; }
        }
      }
    }
  }
  return changed;
}

/**
 * Anthropic messages 非流式 JSON 就地净化（content[].type=text 块）。
 * @returns {boolean} 是否有改动
 */
function scrubAnthropicResponse(data, injectPromptText) {
  if (!injectPromptText || !data || !Array.isArray(data.content)) return false;
  let changed = false;
  for (const block of data.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const s = scrubInjectedEcho(block.text, { exactText: injectPromptText });
      if (s !== block.text) { block.text = s; changed = true; }
    }
  }
  return changed;
}

/**
 * Responses API 非流式 JSON 就地净化（output[] 中 message 的 output_text，
 * 并同步重算顶层 output_text 汇总字段）。
 * @returns {boolean} 是否有改动
 */
function scrubResponsesApiResult(data, injectPromptText) {
  if (!injectPromptText || !data || !Array.isArray(data.output)) return false;
  let changed = false;
  for (const item of data.output) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && c.type === 'output_text' && typeof c.text === 'string') {
          const s = scrubInjectedEcho(c.text, { exactText: injectPromptText });
          if (s !== c.text) { c.text = s; changed = true; }
        }
      }
    }
  }
  if (changed && typeof data.output_text === 'string') {
    data.output_text = data.output
      .filter(o => o.type === 'message')
      .map(o => Array.isArray(o.content) ? o.content.map(c => c.text || '').join('') : '')
      .join('');
  }
  return changed;
}

module.exports = {
  INJECT_HEADER_TITLE,
  scrubInjectedEcho,
  scrubOpenAiChatCompletion,
  scrubAnthropicResponse,
  scrubResponsesApiResult,
};
