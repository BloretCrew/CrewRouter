'use strict';

/**
 * 读取并结构化分析 harness 注入到请求消息中的上下文。
 *
 * 这里不负责“猜测客户端身份”，而是只读取消息中实际存在的字段和区块；
 * 未出现的字段保持 null/false，避免把识别结果当成事实。
 */

const MAX_ANALYSIS_TEXT_CHARS = 120000;

const BLOCK_NAMES = Object.freeze([
  'user_info',
  'git_status',
  'jj_status',
  'project_layout',
  'environment_context',
  'system-reminder',
]);

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return [value.text, value.content, value.input_text].map(textOf).filter(Boolean).join('\n');
  }
  return String(value);
}

function parseKeyValueBlock(text, tag) {
  const match = text.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return null;
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (m) values[m[1].trim()] = m[2];
  }
  return values;
}

function extractBlocks(text) {
  const blocks = {};
  for (const name of BLOCK_NAMES) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
    const values = [];
    let match;
    while ((match = re.exec(text))) values.push(match[1].trim());
    if (values.length) blocks[name] = values;
  }
  return blocks;
}

function messageContent(message) {
  const text = textOf(message?.content ?? message?.input ?? message);
  return text.length > MAX_ANALYSIS_TEXT_CHARS ? text.slice(0, MAX_ANALYSIS_TEXT_CHARS) : text;
}

function analyzeMessages(rawMessages) {
  let messages = rawMessages;
  if (typeof messages === 'string') {
    try { messages = JSON.parse(messages); } catch { messages = [{ role: 'unknown', content: messages }]; }
  }
  if (!Array.isArray(messages)) messages = messages ? [messages] : [];

  const perMessage = messages.map((message, index) => {
    const text = messageContent(message);
    const blocks = extractBlocks(text);
    const userInfo = parseKeyValueBlock(text, 'user_info');
    const hasQuery = /<user_query\b[\s>]/i.test(text);
    return {
      index,
      role: message?.role || null,
      content_type: Array.isArray(message?.content) ? 'array' : typeof message?.content,
      characters: text.length,
      lines: text ? text.split(/\r?\n/).length : 0,
      blocks: Object.keys(blocks),
      block_counts: Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.length])),
      has_user_query: hasQuery,
      user_info: userInfo ? {
        os_version: userInfo['OS Version'] ?? null,
        shell: userInfo.Shell ?? null,
        workspace_path: userInfo['Workspace Path'] ?? null,
        date: userInfo["Today's date"] ?? null,
        note: userInfo.Note ?? null,
        extra_fields: Object.keys(userInfo).filter(k => !['OS Version', 'Shell', 'Workspace Path', "Today's date", 'Note'].includes(k)),
      } : null,
      git_status: blocks.git_status?.[0] ?? blocks.jj_status?.[0] ?? null,
      project_layout: blocks.project_layout?.[0] ?? null,
      environment_context: blocks.environment_context?.[0] ?? null,
      system_reminder: blocks['system-reminder']?.[0] ?? null,
    };
  });

  const allText = perMessage.map((m, i) => `${i}:${messageContent(messages[i])}`).join('\n');
  const blockCounts = {};
  for (const item of perMessage) for (const block of item.blocks) blockCounts[block] = (blockCounts[block] || 0) + 1;
  const info = perMessage.find(m => m.user_info)?.user_info || null;
  const git = perMessage.find(m => m.git_status)?.git_status || null;
  const allMessageText = messages.map(messageContent).join('\n');
  const workspacePath = info?.workspace_path
    || allMessageText.match(/(?:Working directory|Primary working directory|Current working directory|Workspace root folder):\s*([^\n<]+)/i)?.[1]?.trim()
    || allMessageText.match(/(?:currently working in the directory|cwd)[:：]\s*([^\n<]+)/i)?.[1]?.trim()
    || allMessageText.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i)?.[1]?.trim()
    || null;

  return {
    version: 1,
    message_count: messages.length,
    roles: perMessage.reduce((out, m) => { out[m.role || 'unknown'] = (out[m.role || 'unknown'] || 0) + 1; return out; }, {}),
    total_characters: allText.length,
    total_lines: allText ? allText.split(/\r?\n/).length : 0,
    first_user_message_index: perMessage.findIndex(m => m.role === 'user'),
    metadata_message_indexes: perMessage.filter(m => m.blocks.length > 0 && !m.has_user_query).map(m => m.index),
    block_counts: blockCounts,
    observed_fields: {
      os_version: !!info?.os_version,
      shell: !!info?.shell,
      workspace_path: !!workspacePath,
      date: !!info?.date,
      note: !!info?.note,
      git_status: !!git,
      project_layout: perMessage.some(m => m.project_layout),
      environment_context: !!blockCounts.environment_context,
    },
    values: {
      os_version: info?.os_version || null,
      shell: info?.shell || null,
      workspace_path: workspacePath,
      date: info?.date || null,
      git_status: git,
      project_layout: perMessage.find(m => m.project_layout)?.project_layout || null,
      environment_context: perMessage.find(m => m.environment_context)?.environment_context || null,
      system_reminder: perMessage.find(m => m.system_reminder)?.system_reminder || null,
    },
    messages: perMessage,
  };
}

function storedAnalysis(row) {
  const source = row.analysis || row;
  if (source.message_count == null) return null;
  const blockCounts = source.block_counts || {};
  const observedFields = source.observed_fields || {};
  const values = source.values || {};
  return {
    message_count: Number(source.message_count) || 0,
    total_characters: Number(source.total_characters) || 0,
    total_lines: Number(source.total_lines) || 0,
    metadata_message_indexes: Array.from({ length: Number(source.metadata_message_count) || 0 }),
    block_counts: blockCounts,
    observed_fields: observedFields,
    values: { ...values, workspace_path: source.workspace_path || values.workspace_path || null },
  };
}

function addNumber(map, key, value) {
  map[key] = (map[key] || 0) + (Number(value) || 0);
}

/** 汇总多条 usage_records；原始 messages 只在服务端解析，不返回正文。 */
function aggregateMessageStats(rows = []) {
  const summary = {
    requests: 0, analyzed_requests: 0, total_messages: 0, total_characters: 0, total_lines: 0,
    sampled: false, sample_size: rows.length,
    metadata_requests: 0, workspace_requests: 0, git_requests: 0, total_tokens: 0, total_cost: 0,
  };
  const bySource = new Map();
  const byBlock = new Map();
  const byWorkspace = new Map();
  const daily = new Map();

  for (const row of rows) {
    summary.requests += 1;
    summary.total_tokens += Number(row.tokens_used) || 0;
    summary.total_cost += Number(row.cost) || 0;
    const analysis = row.analysis ? storedAnalysis(row) : analyzeMessages(row.messages);
    if (!analysis) continue;
    if (!analysis.message_count) continue;
    summary.analyzed_requests += 1;
    summary.total_messages += analysis.message_count;
    summary.total_characters += analysis.total_characters;
    summary.total_lines += analysis.total_lines;
    if (analysis.metadata_message_indexes.length) summary.metadata_requests += 1;
    if (analysis.values.workspace_path) summary.workspace_requests += 1;
    if (analysis.values.git_status) summary.git_requests += 1;

    const source = String(row.request_source || 'unknown').toLowerCase();
    const sourceRow = bySource.get(source) || { request_source: source, requests: 0, messages: 0, characters: 0, tokens: 0, cost: 0, metadata_requests: 0, workspace_requests: 0, git_requests: 0 };
    sourceRow.requests += 1;
    sourceRow.messages += analysis.message_count;
    sourceRow.characters += analysis.total_characters;
    sourceRow.tokens += Number(row.tokens_used) || 0;
    sourceRow.cost += Number(row.cost) || 0;
    sourceRow.metadata_requests += analysis.metadata_message_indexes.length ? 1 : 0;
    sourceRow.workspace_requests += analysis.values.workspace_path ? 1 : 0;
    sourceRow.git_requests += analysis.values.git_status ? 1 : 0;
    bySource.set(source, sourceRow);

    for (const block of Object.keys(analysis.block_counts)) {
      const item = byBlock.get(block) || { block, requests: 0, occurrences: 0, tokens: 0, cost: 0 };
      item.requests += 1;
      item.occurrences += analysis.block_counts[block];
      item.tokens += Number(row.tokens_used) || 0;
      item.cost += Number(row.cost) || 0;
      byBlock.set(block, item);
    }
    if (analysis.values.workspace_path) {
      const item = byWorkspace.get(analysis.values.workspace_path) || { workspace_path: analysis.values.workspace_path, requests: 0, tokens: 0, cost: 0, characters: 0, sources: {} };
      item.requests += 1;
      item.tokens += Number(row.tokens_used) || 0;
      item.cost += Number(row.cost) || 0;
      item.characters += analysis.total_characters;
      addNumber(item.sources, source, 1);
      byWorkspace.set(analysis.values.workspace_path, item);
    }
    let day = 'unknown';
    if (row.created_at) {
      const parsedDate = new Date(row.created_at);
      if (!Number.isNaN(parsedDate.getTime())) day = parsedDate.toISOString().slice(0, 10);
    }
    const dailyRow = daily.get(day) || { date: day, requests: 0, messages: 0, characters: 0, tokens: 0, cost: 0, metadata_requests: 0, workspace_requests: 0, git_requests: 0 };
    dailyRow.requests += 1;
    dailyRow.messages += analysis.message_count;
    dailyRow.characters += analysis.total_characters;
    dailyRow.tokens += Number(row.tokens_used) || 0;
    dailyRow.cost += Number(row.cost) || 0;
    dailyRow.metadata_requests += analysis.metadata_message_indexes.length ? 1 : 0;
    dailyRow.workspace_requests += analysis.values.workspace_path ? 1 : 0;
    dailyRow.git_requests += analysis.values.git_status ? 1 : 0;
    daily.set(day, dailyRow);
  }

  const count = summary.analyzed_requests || 1;
  const dailyRows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const peakDay = dailyRows.reduce((best, item) => !best || item.requests > best.requests ? item : best, null);
  return {
    version: 1,
    summary: {
      ...summary,
      active_days: dailyRows.filter(item => item.date !== 'unknown').length,
      first_activity: dailyRows[0]?.date || null,
      last_activity: dailyRows[dailyRows.length - 1]?.date || null,
      avg_messages: summary.total_messages / count,
      avg_characters: summary.total_characters / count,
      avg_lines: summary.total_lines / count,
      avg_daily_requests: summary.requests / Math.max(dailyRows.length, 1),
      avg_daily_tokens: summary.total_tokens / Math.max(dailyRows.length, 1),
      peak_day: peakDay ? { date: peakDay.date, requests: peakDay.requests, tokens: peakDay.tokens } : null,
      metadata_rate: summary.metadata_requests / count,
      workspace_rate: summary.workspace_requests / count,
      git_rate: summary.git_requests / count,
    },
    by_source: [...bySource.values()].sort((a, b) => b.requests - a.requests),
    by_block: [...byBlock.values()].sort((a, b) => b.requests - a.requests),
    by_workspace: [...byWorkspace.values()].sort((a, b) => b.requests - a.requests).slice(0, 100),
    daily: dailyRows,
  };
}

module.exports = { analyzeMessages, aggregateMessageStats, extractBlocks, parseKeyValueBlock };
