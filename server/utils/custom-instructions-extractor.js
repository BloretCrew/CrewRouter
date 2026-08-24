'use strict';

/**
 * 自定义提示词文件提取器
 *
 * 从 Coding Harness 请求的 messages / system 中提取被注入的项目规则文件
 * （CLAUDE.md / AGENTS.md / .cursorrules / QWEN.md / SOUL.md 等），用于在调用记录里
 * 标记每次调用带了哪些项目规则。
 *
 * 设计约束（见任务要求）：
 * - 严格在内存中完成，纯正则、无 IO，同步返回。
 * - 任何解析异常都被捕获，绝不抛出；无匹配返回空数组。
 * - messages+system 总字节 > MAX_MESSAGES_BYTES 时跳过提取，并标记 skipped:'size'。
 * - 单文件内容 > MAX_FILE_CHARS 只保留前 TRUNCATE_KEEP_CHARS 字符并置 truncated:true。
 *
 * 返回形如 { items: [{ file, source, content, chars, position, truncated }], skipped: null|'size' }。
 * position：'first_user' | 'system' | 'fragment'。
 */

const MAX_MESSAGES_BYTES = 2 * 1024 * 1024; // 2MB 安全阈值
const MAX_FILE_CHARS = 32 * 1024; // 单文件 32KB 截断保护
const TRUNCATE_KEEP_CHARS = 2048; // 超过阈值只留前 2KB

const SOURCE = Object.freeze({
  CLAUDE_MD: 'claude_md',
  AGENTS_MD: 'agents_md',
  CURSORRULES: 'cursorrules',
  QWEN_MD: 'qwen_md',
  SOUL_MD: 'soul_md',
  OTHER: 'other',
});

// 已知规则文件的后缀（用于从任意路径收拢 basename 并归类）
const RULES_FILE_RE = /(AGENTS?\.md|AGENTS\.override\.md|CLAUDE\.md|QWEN\.md|QWEN\.local\.md|SOUL\.md|IDENTITY\.md|USER\.md|TOOLS\.md|MEMORY\.md|\.cursorrules|CONTEXT\.md|HERMES\.md|\.hermes\.md)$/i;

/**
 * 根据文件名/路径推断规则文件类型。
 * @param {string} name
 * @returns {string}
 */
function classifyFile(name) {
  const n = String(name || '').trim();
  if (/CLAUDE\.md$/i.test(n)) return SOURCE.CLAUDE_MD;
  if (/(AGENTS?|AGENT)(\.override)?\.md$/i.test(n)) return SOURCE.AGENTS_MD;
  if (/\.cursorrules$/i.test(n)) return SOURCE.CURSORRULES;
  if (/QWEN[^/\\]*\.md$/i.test(n)) return SOURCE.QWEN_MD;
  if (/SOUL\.md$/i.test(n)) return SOURCE.SOUL_MD;
  return SOURCE.OTHER;
}

/** 取路径最后一段作为可读文件名 */
function baseName(path) {
  const p = String(path || '').trim();
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const name = idx >= 0 ? p.slice(idx + 1) : p;
  return name.replace(/^["'`\s]+|["'`\s]+$/g, '');
}

/**
 * 将 content 字段（string | 多模态 blocks 数组 | 对象）转为可匹配文本。
 * @param {*} content
 * @returns {string}
 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      if (typeof part === 'string') out += `${part}\n`;
      else if (part && typeof part === 'object') {
        if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') continue;
        for (const key of ['text', 'content', 'input_text']) {
          if (typeof part[key] === 'string') { out += `${part[key]}\n`; break; }
        }
        if (part.type === 'input_text' && typeof part.text === 'string') out += `${part.text}\n`;
        if (part.type === 'text' && typeof part.text === 'string') out += `${part.text}\n`;
      }
    }
    return out;
  }
  if (typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return String(content);
}

/** 从一条消息对象取参与匹配的文本（含 role 信号，供 position 判定） */
function messageText(m) {
  if (!m || typeof m !== 'object') return '';
  let out = '';
  if (m.role) out += `role:${m.role}\n`;
  if (m.content != null) out += contentToText(m.content) + '\n';
  if (m.instructions != null) out += contentToText(m.instructions) + '\n';
  if (m.text != null) out += contentToText(m.text) + '\n';
  return out;
}

/** 估算 messages+system 的字节数（跳过超大输入用，不参与解析） */
function estimateBytes(messages, system) {
  let n = 0;
  const add = (v) => {
    if (v == null) return;
    n += Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
  };
  add(system);
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') { add(m); continue; }
      add(m.role);
      add(m.content);
      add(m.instructions);
      add(m.text);
    }
  } else {
    add(messages);
  }
  return n;
}

/**
 * 构建带 position 标注的文本段。
 * @returns {Array<{text:string, position:string}>}
 */
function buildSegments(messages, system) {
  const segments = [];
  const pushSystem = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      for (const block of v) {
        const t = contentToText(block);
        if (t) segments.push({ text: t, position: 'system' });
      }
    } else {
      const t = contentToText(v);
      if (t) segments.push({ text: t, position: 'system' });
    }
  };
  pushSystem(system);

  let list = messages;
  if (typeof messages === 'string') {
    try { const p = JSON.parse(messages); list = Array.isArray(p) ? p : null; } catch { list = null; }
    if (!list && messages) segments.push({ text: messages, position: 'fragment' });
  }
  if (Array.isArray(list)) {
    list.forEach((m, idx) => {
      if (!m || typeof m !== 'object') { const t = contentToText(m); if (t) segments.push({ text: t, position: 'fragment' }); return; }
      const role = String(m.role || '');
      let position;
      if (role === 'system' || role === 'developer') position = 'system';
      else if (role === 'user' && idx === 0) position = 'first_user';
      else position = 'fragment';
      const t = messageText(m);
      if (t) segments.push({ text: t, position });
    });
  }
  return segments;
}

/** 把提取片段装填成输出 item */
function makeItem(file, content, position) {
  const contentStr = String(content || '').replace(/\s+$/, '');
  const chars = contentStr.length;
  let out = contentStr;
  let truncated = false;
  if (chars > MAX_FILE_CHARS) {
    out = contentStr.slice(0, TRUNCATE_KEEP_CHARS);
    truncated = true;
  }
  return {
    file: file || 'unknown',
    source: classifyFile(file),
    content: out,
    chars,
    position,
    truncated,
  };
}

// ——————— 各家特化解析器（均返回 [{ file, content, position }]） ———————

/** Claude Code：首条 isMeta user 的 <system-reminder> 内 `# claudeMd` 段（可含多个 `Contents of <path>` 文件块） */
function parseClaudeMd(text, position) {
  const items = [];
  const sectionRe = /#\s*claudeMd\b[^\n]*\n([\s\S]*?)(?=\n\s*#\s+[A-Za-z]|<\/system-reminder>|<system-reminder>|$)/gi;
  let m;
  while ((m = sectionRe.exec(text))) {
    const block = m[1];
    const fileRe = /Contents of\s+([^\n]+?)\s*\([^)]*project instructions[^)]*\)\s*:\s*\n([\s\S]*?)(?=\n\s*Contents of\s|\n\s*#\s+[A-Za-z]|<\/system-reminder>|<system-reminder>|$)/g;
    let f;
    while ((f = fileRe.exec(block))) {
      items.push({ file: f[1].trim(), content: f[2], position });
    }
    // 兜底：无 `Contents of` 头时，若块内出现规则文件名，整块视为内容
    if (!items.length) {
      const fr = block.match(RULES_FILE_RE);
      if (fr) items.push({ file: fr[0], content: block.trim(), position });
    }
  }
  return items;
}

/** Codex：<user_instructions>...</user_instructions> contextual user fragment */
function parseCodex(text, position) {
  const items = [];
  const re = /<user_instructions>([\s\S]*?)<\/user_instructions>/gi;
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1];
    const header = inner.match(/#[^\n]*(AGENTS\.override\.md|AGENTS\.md)\s*instructions for[^\n]*/i);
    const file = header ? header[1] : 'AGENTS.md';
    let content = inner.replace(/^[\s]*#\s*[^\n]*instructions for[^\n]*\n?/i, '');
    content = content.replace(/^[\s]*#\s*[^\n]*\n?/, '');
    items.push({ file, content: content.replace(/\s+$/, ''), position });
  }
  return items;
}

/** Grok Build：<system-reminder> 规则块（alwaysAppliedWorkspaceRules / workspace rules / ProjectInstructions） */
function parseGrok(text, position) {
  const items = [];
  const matches = [];
  const srRe = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;
  let sr;
  while ((sr = srRe.exec(text))) matches.push(sr[1]);
  const candidateTexts = matches.length ? matches : [text];
  for (const block of candidateTexts) {
    // 结尾标记：必须命中强特征，避免把普通注释当成规则文件
    if (!/alwaysAppliedWorkspaceRules|always_applied_workspace_rules|workspace rules|ProjectInstructions/i.test(block)) continue;
    // 优先捕捉自闭合/成对的 rule 标签（name 指向规则文件）
    const tagRe = /<([A-Za-z0-9_:]{1,80})\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/gi;
    let t;
    let sawFile = false;
    while ((t = tagRe.exec(block))) {
      if (RULES_FILE_RE.test(t[2]) || RULES_FILE_RE.test(t[3])) {
        sawFile = true;
        items.push({ file: t[2].trim() || 'AGENTS.md', content: t[3], position });
      }
    }
    if (sawFile) continue;
    // 兜底：按行扫描规则文件名，取其后的文本（到下一个规则文件前）
    const fileRefs = [...block.matchAll(new RegExp(RULES_FILE_RE.source, 'gi'))];
    if (!fileRefs.length) continue;
    const first = fileRefs[0];
    const startIdx = block.indexOf(first[0]) + first[0].length;
    let rest = block.slice(startIdx);
    const nextIdx = rest.search(new RegExp(RULES_FILE_RE.source, 'i'));
    if (nextIdx >= 0) rest = rest.slice(0, nextIdx);
    if (rest.trim()) items.push({ file: first[0], content: rest.trim(), position });
  }
  return items;
}

/** Hermes / OpenClaw：`# Project Context` 段内的上下文文件块 */
function parseProjectContext(text, position) {
  const items = [];
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const head = lines[i].match(/^\s*(#{1,3})\s*Project Context\b/i);
    if (!head) { i += 1; continue; }
    const level = head[1].length;
    i += 1;
    const sectionLines = [];
    while (i < lines.length) {
      const h = lines[i].match(/^\s*(#{1,3})\s+(.*)$/);
      if (h && h[1].length <= level) break; // 同级/更高层级标题 → 本段结束
      sectionLines.push(lines[i]);
      i += 1;
    }
    const section = sectionLines.join('\n');
    const subRe = /^[ \t]*#+[ \t]+([^\n#]{1,200})[ \t]*\n([\s\S]*?)(?=^[ \t]*#+[ \t]+[^\n#]+\n|$)/gim;
    let s;
    while ((s = subRe.exec(section))) {
      let file = baseName(s[1].trim().replace(/[`"'():]/g, '').trim());
      const content = s[2].replace(/\s+$/, '');
      if (!content.trim()) continue;
      if (/AGENTS?\.md|CLAUDE\.md|QWEN\.md|SOUL\.md|\.cursorrules|IDENTITY|USER\.md|TOOLS\.md|MEMORY\.md|CONTEXT\.md|\.hermes\.md|HERMES\.md/i.test(file)) {
        items.push({ file, content, position });
      }
    }
  }
  return items;
}

/** OpenCode：system 消息中 `Instructions from <path>` 段（或 system-reminder 内顺带注入） */
function parseOpenCode(text, position) {
  const items = [];
  const re = /Instructions from:?\s*([^\n]+)\n([\s\S]*?)(?=\n\s*Instructions from:?\s|<\/system-reminder>|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    let file = m[1].trim().replace(/[`"<>]/g, '');
    file = baseName(file);
    const content = m[2].replace(/\s+$/, '');
    if (RULES_FILE_RE.test(file) && content.trim()) {
      items.push({ file, content, position });
    }
  }
  return items;
}

/** Qwen Code：`--- Context from: <path> ---` 包裹段 */
function parseQwen(text, position) {
  const items = [];
  const re = /---\s*Context from:\s*([^\n]+?)\s*---\s*\n([\s\S]*?)(?=\n\s*---\s*Context from:|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    let file = m[1].trim().replace(/[`"<>]/g, '');
    file = baseName(file);
    const content = m[2].replace(/\s+$/, '');
    if (RULES_FILE_RE.test(file) && content.trim()) {
      items.push({ file, content, position });
    }
  }
  return items;
}

/** 校验 text 是否包含各解析器所需的强特征，避免无关文本误报 */
function hasClaudeMd(text) { return /#\s*claudeMd\b/i.test(text); }
function hasCodex(text) { return /<user_instructions>/i.test(text); }
function hasGrok(text) { return /alwaysAppliedWorkspaceRules|always_applied_workspace_rules|ProjectInstructions/i.test(text) || /workspace rules/i.test(text); }
function hasProjectContext(text) { return /#+\s*Project Context\b/i.test(text); }
function hasOpenCode(text) { return /Instructions from:?\s+\S/i.test(text); }
function hasQwen(text) { return /---\s*Context from:/i.test(text); }

/**
 * 按 harness 类型挑取解析器；未知类型走通用扫描（覆盖各家强标记，去重兜底）。
 */
function parsersFor(requestSource, segment) {
  const text = segment.text;
  const list = [];
  const src = String(requestSource || '').toLowerCase();
  if (src === 'claude_code' || hasClaudeMd(text)) list.push(parseClaudeMd);
  if (src === 'codex' || hasCodex(text)) list.push(parseCodex);
  if (src === 'grok' || hasGrok(text)) list.push(parseGrok);
  if ((src === 'hermes' || src === 'openclaw') || (!src && hasProjectContext(text))) list.push(parseProjectContext);
  if (src === 'opencode' || hasOpenCode(text)) list.push(parseOpenCode);
  if (src === 'qwen_code' || hasQwen(text)) list.push(parseQwen);
  return list;
}

/** 汇总原始片段，装填 + 去重（同名保留内容更长者） */
function finalize(rawItems) {
  const byFile = new Map();
  for (const item of rawItems) {
    const out = makeItem(item.file, item.content, item.position);
    const key = baseName(out.file).toLowerCase();
    const existing = byFile.get(key);
    if (!existing || out.chars > existing.chars) byFile.set(key, out);
  }
  return [...byFile.values()];
}

/**
 * 提取自定义提示词文件。
 * @param {Array|string|null} messages 请求消息数组（Responses 用 input）
 * @param {string|Array|null} system 独立 system 字段
 * @param {object} [opts]
 * @param {string} [opts.requestSource] 已识别的 harness 类型（不传则通用扫描）
 * @returns {{items: Array<{file:string,source:string,content:string,chars:number,position:string,truncated:boolean}>, skipped:string|null}}
 */
function extractCustomInstructions(messages, system, opts = {}) {
  try {
    if (messages == null && system == null) return { items: [], skipped: null };
    if (estimateBytes(messages, system) > MAX_MESSAGES_BYTES) return { items: [], skipped: 'size' };

    const segments = buildSegments(messages, system);
    const requestSource = String(opts && opts.requestSource || '').toLowerCase() || null;
    const raw = [];
    for (const seg of segments) {
      if (!seg.text) continue;
      const parsers = parsersFor(requestSource, seg);
      for (const parse of parsers) {
        let out = [];
        try { out = parse(seg.text, seg.position) || []; } catch { out = []; }
        for (const o of out) if (o && o.content && o.content.trim()) raw.push(o);
      }
    }
    return { items: finalize(raw), skipped: null };
  } catch (err) {
    // 提取异常绝不抛出：退化为无结果，不影响主线
    return { items: [], skipped: null };
  }
}

module.exports = {
  SOURCE,
  classifyFile,
  extractCustomInstructions,
};
