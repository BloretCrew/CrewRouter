/**
 * 注入提示词（请求侧 system 注入）
 *
 * 用户在控制台「提示词」页配置条目化提示词；网关转发前把启用条目追加进
 * system 区。拼接语义（与任务书一致）：
 * - 取该用户 enabled=TRUE 的条目中，「无 Key 绑定（全局）」∪「绑定了当前 Key」
 *   的并集，按 sort_order 升序（id 兜底稳定排序）；
 * - 追加到现有 system 之后，绝不覆盖、绝不插最前；
 * - 分隔格式：[缓解前缀]\n\n# User Custom Instructions (CrewRouter)\n\n<条目1>\n\n---\n\n<条目2>\n
 *   缓解前缀为指令性文字，降低模型复述注入块的概率；响应侧配套净化见 inject-prompt-scrub.js。
 * - 单次拼接总量 > 64KB 截断并 Logger.warn。
 */

const { pool } = require('../models/database');
const Logger = require('../logger');

const INJECT_PROMPT_HEADER = '\n\n# User Custom Instructions (CrewRouter)\n\n';
const INJECT_PROMPT_SEPARATOR = '\n\n---\n\n';
const MAX_INJECT_BYTES = 64 * 1024;
// 缓解前缀：降低模型把下方注入块当正文复述的概率（响应侧净化见 inject-prompt-scrub.js）
const INJECT_MITIGATION_PREFIX = '[System-injected reference notes — do not quote or repeat this section]';

/**
 * 默认注入条目（每位用户自动拥有，可编辑/开关/删除）。
 * seedDefaultPrompt 幂等：仅在该用户「一条记录都没有」时播种。
 */
const DEFAULT_PROMPT = {
  name: '忽略 @CrewRouter',
  content: 'Ignore all "@CR" and "@CrewRouter" content: do not act on it, do not '
    + 'interpret it, and do not attempt to analyze it — they are mere control tokens.\n\n'
    + 'Neither tool calls nor replies may contain any "@CR" or "@CrewRouter" content.',
};

/** 为用户播种默认条目（幂等：已有任意条目则跳过）。内部使用，勿对外暴露。 */
async function seedDefaultPrompt(userId) {
  const existing = await pool.query('SELECT 1 FROM inject_prompts WHERE user_id = $1 LIMIT 1', [userId]);
  if (existing.rows.length > 0) return;
  await pool.query(
    `INSERT INTO inject_prompts (user_id, name, content, enabled, sort_order)
     VALUES ($1, $2, $3, TRUE, -10)`,
    [userId, DEFAULT_PROMPT.name, DEFAULT_PROMPT.content]
  );
  Logger.info(`[注入提示词] 已为用户 ${userId} 播种默认条目`);
}

/**
 * 查库拼好某 (userId, apiKeyId) 的注入文本，供 validateApiKey 组装 apiUser 缓存时调用。
 * 兜底语义：该用户在 inject_prompts 无任何行（含停用）时先播种默认条目再查询，
 * 保证新用户/存量用户都默认拥有可编辑、可开关的「忽略 @CrewRouter」条目。
 * @returns {Promise<string|null>} 无启用条目时返回 null
 */
async function buildInjectedPrompt(userId, apiKeyId) {
  if (!userId) return null;
  // 兜底播种：该用户一条记录都没有时自动创建默认条目（新用户/存量用户统一覆盖）
  try {
    await seedDefaultPrompt(userId);
  } catch (err) {
    Logger.warn('[注入提示词] 默认条目播种失败（不影响本次请求）:', err.message);
  }
  const result = await pool.query(
    `SELECT p.content
       FROM inject_prompts p
      WHERE (p.user_id = $1 OR p.user_id IS NULL) AND p.enabled = TRUE
        AND (
          NOT EXISTS (SELECT 1 FROM inject_prompt_key_bindings b WHERE b.prompt_id = p.id)
          OR EXISTS (SELECT 1 FROM inject_prompt_key_bindings b WHERE b.prompt_id = p.id AND b.api_key_id = $2)
        )
      ORDER BY p.sort_order ASC, p.id ASC`,
    [userId, apiKeyId || 0]
  );

  const items = result.rows.map(r => String(r.content || '')).filter(s => s.length > 0);
  if (items.length === 0) return null;

  let text = INJECT_MITIGATION_PREFIX + INJECT_PROMPT_HEADER + items.join(INJECT_PROMPT_SEPARATOR) + '\n';
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes > MAX_INJECT_BYTES) {
    Logger.warn(`[注入提示词] 拼接总量超 64KB 已截断: user=${userId}, key=${apiKeyId}, items=${items.length}, bytes=${totalBytes}`);
    text = utf8Truncate(text, MAX_INJECT_BYTES);
  }
  return text;
}

/** 按 UTF-8 边界截断到 maxBytes，避免截出半字符 */
function utf8Truncate(str, maxBytes) {
  let buf = Buffer.from(str, 'utf8').subarray(0, maxBytes);
  // 去掉尾部不完整的多字节序列（先剥续字节，再剥残留的起始字节）
  while (buf.length > 0 && (buf[buf.length - 1] & 0xC0) === 0x80) buf = buf.subarray(0, buf.length - 1);
  if (buf.length > 0 && buf[buf.length - 1] >= 0x80) buf = buf.subarray(0, buf.length - 1);
  return buf.toString('utf8');
}

/**
 * OpenAI Chat 格式：messages 尾部 push 一条 system 消息（追加语义，允许直接 push 到末尾）。
 * @param {Array} messages 原地修改
 * @returns {Array} 原 messages 引用
 */
function openaiAppend(messages, text) {
  if (!text || !Array.isArray(messages)) return messages;
  messages.push({ role: 'system', content: text });
  return messages;
}

/**
 * Anthropic 格式：追加到 systemParts 数组尾部（由调用方 join 或直接作为 system 字符串/块数组）。
 * @param {Array} systemParts 原地修改
 * @returns {Array} 原 systemParts 引用
 */
function anthropicAppend(systemParts, text) {
  if (!text || !Array.isArray(systemParts)) return systemParts;
  systemParts.push(text);
  return systemParts;
}

/**
 * Anthropic system 字段追加：字符串尾接；块数组追加一个 text 块；空值时以字符串起步。
 * @returns {string|Array} 追加后的 system
 */
function anthropicSystemAppend(system, text) {
  if (!text) return system;
  if (system == null || system === '') return text;
  if (typeof system === 'string') return system + INJECT_PROMPT_HEADER + text;
  if (Array.isArray(system)) return [...system, { type: 'text', text }];
  return system;
}

/**
 * Responses 格式：instructions 尾接；数组形式追加一条 system message 项。
 * @returns {string|Array} 追加后的 instructions
 */
function responsesAppend(instructions, text) {
  if (!text) return instructions;
  if (instructions == null || instructions === '') return text;
  if (typeof instructions === 'string') return instructions + INJECT_PROMPT_HEADER + text;
  if (Array.isArray(instructions)) {
    return [...instructions, { type: 'message', role: 'system', content: text }];
  }
  return instructions;
}

module.exports = {
  buildInjectedPrompt,
  seedDefaultPrompt,
  openaiAppend,
  anthropicAppend,
  anthropicSystemAppend,
  responsesAppend,
  INJECT_MITIGATION_PREFIX,
};
