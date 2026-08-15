'use strict';

/**
 * 从 HTTP 请求识别 Coding Harness 客户端来源
 *
 * 信号（优先级大致为）：
 * 1. 强专用 Header（如 x-grok-client-identifier）
 * 2. 显式 x-crewrouter-client / metadata
 * 3. **提示词 / system / tools 内容指纹**（成功率关键，可纠正伪装 UA）
 * 4. originator / 厂商专用头
 * 5. User-Agent
 *
 * 已知限制：部分客户端可自定义 system prompt，会降低提示词命中率；
 * Qwen 在部分代理路径会伪装 claude-cli，若仍带「You are Qwen Code」可纠正。
 */

const REQUEST_SOURCES = Object.freeze({
  GROK: 'grok',
  CODEX: 'codex',
  CLAUDE_CODE: 'claude_code',
  OPENCODE: 'opencode',
  QWEN_CODE: 'qwen_code',
  HERMES: 'hermes',
  OPENCLAW: 'openclaw',
  DEEPSEEK: 'deepseek_harness',
  UNKNOWN: 'unknown',
});

/** 可单独绑定模型的 harness（不含 unknown） */
const HARNESS_SOURCES = Object.freeze([
  REQUEST_SOURCES.CLAUDE_CODE,
  REQUEST_SOURCES.CODEX,
  REQUEST_SOURCES.GROK,
  REQUEST_SOURCES.OPENCODE,
  REQUEST_SOURCES.QWEN_CODE,
  REQUEST_SOURCES.HERMES,
  REQUEST_SOURCES.OPENCLAW,
  REQUEST_SOURCES.DEEPSEEK,
]);

const HARNESS_SOURCE_SET = new Set(HARNESS_SOURCES);

const LABELS = Object.freeze({
  grok: 'Grok',
  codex: 'Codex',
  claude_code: 'Claude Code',
  opencode: 'OpenCode',
  qwen_code: 'Qwen Code',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  deepseek_harness: 'DeepSeek Harness',
  unknown: '未知/其他',
});

const BADGE_COLORS = Object.freeze({
  grok: '#a855f7',
  codex: '#10b981',
  claude_code: '#f59e0b',
  opencode: '#3b82f6',
  qwen_code: '#6366f1',
  hermes: '#ec4899',
  openclaw: '#0ea5e9',
  deepseek_harness: '#4d6bfe',
  unknown: 'var(--muted-foreground)',
});

function isHarnessSource(value) {
  return HARNESS_SOURCE_SET.has(normalizeRequestSource(value));
}

/**
 * 高置信度身份句 + 产品专属 message 结构块
 *
 * 结构指纹来自各 harness 源码组装逻辑（如 Grok msg[1] 的 <user_info>/<git_status>）。
 * 注意：不要用裸 <system-reminder> / CLAUDE.md / TodoWrite / 裸 SOUL.md 等易跨产品复用的弱特征。
 * 规则顺序：更具体的产品优先（同命中数时靠前者胜出）。
 */
const PROMPT_IDENTITY_RULES = [
  {
    source: REQUEST_SOURCES.DEEPSEEK,
    patterns: [
      /You are an AI agent powered by DeepSeek Harness/i,
      /powered by DeepSeek Harness/i,
      /DeepSeek Harness \(`?dsh`?\) is an open-source agent harness/i,
      /harness:identity/i,
    ],
  },
  {
    source: REQUEST_SOURCES.GROK,
    patterns: [
      /You are Grok(?:\s+[\d.]+)? released by xAI/i,
      /You are Grok released by xAI\. You are an interactive CLI tool/i,
      /You are a Grok Build subagent/i,
      /Grok Build subagent/i,
      /xAI Grok Build harness/i,
      /for the xAI Grok Build harness/i,
      /You are the Goal Plan Writer for the xAI Grok Build harness/i,
      /You are the Goal Summarizer for the xAI Grok Build harness/i,
      /You are the Goal Strategist for the xAI Grok Build harness/i,
      /Grok Build TUI/i,
      /Available Render Components:/i,
      /get_command_or_subagent_output/i,
      // 结构：session user_message.rs 的 <user_info> 前缀（常为 messages[1]）
      /<user_info>\s*OS Version:\s*.+?\s*Shell:\s*.+?\s*Workspace Path:/is,
      /<user_info>[\s\S]{0,500}?Workspace Path:\s*\S+/i,
      /Note: Prefer using relative paths over absolute paths as tool call args when possible\./i,
    ],
  },
  {
    source: REQUEST_SOURCES.CLAUDE_CODE,
    patterns: [
      /You are Claude Code, Anthropic's official CLI for Claude/i,
      /running within the Claude Agent SDK/i,
      /You are a Claude agent, built on Anthropic's Claude Agent SDK/i,
      /You are an agent for Claude Code, Anthropic's official CLI/i,
      /\/help: Get help with using Claude Code/i,
      /Anthropic's official CLI for Claude/i,
      /deferred tools are now available via ToolSearch/i,
      // 结构：prependUserContext 的 # claudeMd / # currentDate 键（非裸 system-reminder）
      /# claudeMd\b/i,
      /# currentDate\s*\n\s*Today's date is /i,
    ],
  },
  {
    source: REQUEST_SOURCES.CODEX,
    patterns: [
      /You are a coding agent running in the Codex CLI/i,
      /Codex CLI is an open source project led by OpenAI/i,
      /You are Codex, an OpenAI general-purpose agentic assistant/i,
      /Within this context, Codex refers to the open-source agentic coding interface/i,
      // 结构：<environment_context><cwd>…</cwd>
      /<environment_context>[\s\S]{0,400}?<cwd>/i,
      /<environment_context>[\s\S]{0,800}?<shell>/i,
    ],
  },
  {
    source: REQUEST_SOURCES.QWEN_CODE,
    patterns: [
      /You are Qwen Code,/i,
      /developed by Alibaba Group, specializing in software engineering tasks/i,
      /Analyze this Qwen Code session/i,
      /Analyze this Qwen Code usage data/i,
      // 结构：environmentContext.ts 启动上下文
      /This is the Qwen Code\. We are setting up the context for our chat/i,
      /I'm currently working in the directory:/i,
    ],
  },
  {
    source: REQUEST_SOURCES.HERMES,
    patterns: [
      /You are Hermes Agent, an intelligent AI assistant created by Nous Research/i,
      /You run on Hermes Agent \(by Nous Research\)/i,
      /hermes-agent\.nousresearch\.com/i,
      /Active Hermes profile:/i,
      /You are being used as the active ACP agent backend for Hermes/i,
      /You are a security reviewer for an AI coding agent/i,
      /created by Nous Research/i,
      // 结构：system_prompt / coding_context / prompt_builder
      /Workspace \(snapshot at session start/i,
      /User home directory:\s*\S+/i,
      /Current working directory:\s*\S+/i,
      /# SOUL\.md[^\n]*\n[\s\S]{0,800}?Hermes/i,
      /你是 Hermes Agent/i,
    ],
  },
  {
    source: REQUEST_SOURCES.OPENCLAW,
    patterns: [
      /You are a personal assistant running inside OpenClaw/i,
      /operating inside OpenClaw's embedded coding agent harness/i,
      /## OpenClaw Control/i,
      /OpenClaw behavior questions:/i,
      /Provider messaging: never exec\/curl; OpenClaw routes/i,
      /running inside OpenClaw/i,
      // 结构：system-prompt.ts Workspace / Project Context 段
      /## Workspace Files \(injected\)/i,
      /Sandbox container workdir:/i,
      /Sandbox host mount source \(file tools bridge only/i,
    ],
  },
  {
    source: REQUEST_SOURCES.OPENCODE,
    patterns: [
      /You are opencode, an interactive CLI tool that helps users with software engineering tasks/i,
      /You are OpenCode, the best coding agent on the planet/i,
      /To give feedback, users should report the issue at https:\/\/github\.com\/anomalyco\/opencode/i,
      /gather information to answer the question from opencode docs at https:\/\/opencode\.ai/i,
      /from OpenCode docs\. The list of available docs is available at https:\/\/opencode\.ai\/docs/i,
      /You are powered by the model named .+\. The exact model ID is \S+\/\S+/i,
      // 结构：system-context/builtins.ts <env> 块
      /Here is some useful information about the environment you are running in:/i,
      /<env>\s*Working directory:/i,
      /Workspace root folder:\s*\S+/i,
    ],
  },
];

/**
 * 中等置信度：仅在「无任何身份句命中」时启用。
 * 禁用跨产品共享标记（裸 system-reminder / CLAUDE.md / 裸 SOUL.md / You're not a chatbot）。
 * minHits 默认 2。
 */
const PROMPT_SUPPORT_RULES = [
  {
    source: REQUEST_SOURCES.GROK,
    minHits: 2,
    patterns: [
      /\brun_terminal_command\b/,
      /\bsearch_replace\b/,
      /\benter_plan_mode\b/,
      /\bexit_plan_mode\b/,
      /\bspawn_subagent\b/,
      /\bget_command_or_subagent_output\b/,
      /<user_info>/i,
      /Workspace Path:/i,
      /<git_status>/i,
      /This is the git status at the start of the conversation\. Note that this status is a snapshot in time/i,
      /ordered from repo root to current directory - deeper files take precedence/i,
    ],
  },
  {
    source: REQUEST_SOURCES.CODEX,
    minHits: 2,
    patterns: [
      /\bapply_patch\b/,
      /\bshell_command\b/,
      /\bupdate_plan\b/,
      /# AGENTS\.md spec/i,
      /<environment_context>/i,
      /<\/cwd>/i,
      /<workspace_roots>/i,
      /<permission_profile\b/i,
      /<filesystem>/i,
    ],
  },
  {
    source: REQUEST_SOURCES.CLAUDE_CODE,
    minHits: 2,
    patterns: [
      /Anthropic's official CLI/i,
      /\bToolSearch\b/,
      /\bNotebookEdit\b/,
      /claude\.ai\/code/i,
      /# claudeMd\b/i,
      /# currentDate\b/i,
      /Available agent types for the Agent tool:/i,
    ],
  },
  {
    // 勿用裸 SOUL.md / You're not a chatbot：Hermes 常加载同款 SOUL 模板
    source: REQUEST_SOURCES.OPENCLAW,
    minHits: 2,
    patterns: [
      /\bIDENTITY\.md\b/,
      /\bopenclaw\b/i,
      /## Workspace Files \(injected\)/i,
      /Working directory: \S+[\s\S]{0,200}?## Workspace/i,
      /sessions_spawn\(runtime:/i,
    ],
  },
  {
    source: REQUEST_SOURCES.HERMES,
    minHits: 2,
    patterns: [
      /\bHERMES_HOME\b/,
      /hermes-agent/i,
      /Nous Research/i,
      /Active Hermes profile:/i,
      /User home directory:/i,
      /Current working directory:/i,
      /Workspace \(snapshot at session start/i,
      /# SOUL\.md/i,
      /skill_view\(name=['"]hermes-agent['"]\)/i,
    ],
  },
  {
    source: REQUEST_SOURCES.OPENCODE,
    minHits: 2,
    patterns: [
      /<available_references>/i,
      /Workspace root folder:/i,
      /anomalyco\/opencode/i,
      /Here is some useful information about the environment you are running in:/i,
      /Is directory a git repo:/i,
      /The environment you are running in is now:/i,
    ],
  },
  {
    source: REQUEST_SOURCES.QWEN_CODE,
    minHits: 1,
    patterns: [
      /You are Qwen Code/i,
      /Alibaba Group, specializing in software engineering/i,
      /This is the Qwen Code\. We are setting up the context/i,
    ],
  },
];

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const lower = name.toLowerCase();
  const direct = headers[lower] ?? headers[name];
  if (direct != null && direct !== '') {
    return Array.isArray(direct) ? direct.join(' ') : String(direct);
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? value.join(' ') : String(value || '');
}

function looksLikeCodexOriginator(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/^codex(?:$|[_-])/i.test(v)) return true;
  if (/^Codex\s/i.test(v)) return true;
  return false;
}

/**
 * 从 content 字段抽取文本（string | multipart blocks）
 */
/** 去掉 data-url / 超长 base64，避免语料膨胀与匹配失败 */
function stripHeavyPayloads(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/data:[a-z0-9.+/-]+;base64,[a-z0-9+/=\s]{200,}/gi, ' ')
    .replace(/["']url["']\s*:\s*["']data:[^"']{200,}["']/gi, ' ')
    .slice(0, 80000);
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return stripHeavyPayloads(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return stripHeavyPayloads(part);
        if (!part || typeof part !== 'object') return '';
        // 跳过纯图片块
        if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') return '';
        if (typeof part.text === 'string') return stripHeavyPayloads(part.text);
        if (typeof part.content === 'string') return stripHeavyPayloads(part.content);
        if (typeof part.input_text === 'string') return stripHeavyPayloads(part.input_text);
        if (part.type === 'input_text' && typeof part.text === 'string') return stripHeavyPayloads(part.text);
        if (part.type === 'text' && typeof part.text === 'string') return stripHeavyPayloads(part.text);
        if (typeof part.input === 'string') return stripHeavyPayloads(part.input);
        if (part.function?.name) return ` tool:${part.function.name} `;
        if (part.name) return ` tool:${part.name} `;
        return '';
      })
      .join('\n');
  }
  if (typeof content === 'object') {
    try {
      return stripHeavyPayloads(JSON.stringify(content));
    } catch {
      return '';
    }
  }
  return stripHeavyPayloads(String(content));
}

/**
 * 从请求 body 抽取可匹配的提示词语料（限制长度，避免超大 body）
 * @param {object|string|null} body
 * @param {object} [metadata]
 * @returns {string}
 */
function extractPromptCorpus(body, metadata = {}) {
  if (body == null && !metadata) return '';
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return stripHeavyPayloads(body).slice(0, 120000);
    }
  }
  // 入库 messages 有时是「消息数组」本身，而非完整 body
  if (Array.isArray(parsed)) {
    parsed = { messages: parsed };
  }
  if (!parsed || typeof parsed !== 'object') {
    return '';
  }

  const chunks = [];
  const push = (v) => {
    const t = contentToText(v);
    if (t) chunks.push(t);
  };

  // Anthropic / OpenAI chat
  push(parsed.system);
  if (Array.isArray(parsed.system)) {
    for (const s of parsed.system) push(s);
  }

  // OpenAI Responses API
  push(parsed.instructions);

  // messages / input
  const messageLists = [];
  if (Array.isArray(parsed.messages)) messageLists.push(parsed.messages);
  if (Array.isArray(parsed.input)) messageLists.push(parsed.input);
  for (const list of messageLists) {
    // 优先 system / developer；再取前若干条 user/tool（Grok 结构块常在 messages[1] user）
    const systemish = list.filter((m) => m && (m.role === 'system' || m.role === 'developer'));
    const others = list.filter((m) => m && m.role !== 'system' && m.role !== 'developer').slice(0, 16);
    // 保证前 4 条消息始终入语料（覆盖 Grok user_info / Codex environment_context 位置）
    const head = list.slice(0, 4).filter(Boolean);
    const seen = new Set();
    const prioritized = [];
    for (const m of [...systemish, ...head, ...others]) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      prioritized.push(m);
    }
    for (const m of prioritized) {
      if (!m) continue;
      push(m.content);
      // 结构块 / 长 system 常在 user 消息前部（Grok <user_info>、Claude system-reminder）
      if (m.role === 'user') {
        const raw =
          typeof m.content === 'string'
            ? m.content
            : contentToText(m.content);
        if (raw && raw.length > 200) {
          push(raw.slice(0, 6000));
        }
      }
      if (m.role) chunks.push(` role:${m.role} `);
      // tool definitions embedded in assistant messages
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc?.function?.name) chunks.push(` tool:${tc.function.name} `);
          if (tc?.name) chunks.push(` tool:${tc.name} `);
        }
      }
    }
  }

  // tools array（OpenAI / Anthropic tools）
  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools.slice(0, 80)) {
      if (!tool) continue;
      if (tool.name) chunks.push(` tool:${tool.name} `);
      if (tool.function?.name) chunks.push(` tool:${tool.function.name} `);
      if (tool.type === 'function' && tool.function?.name) {
        chunks.push(` tool:${tool.function.name} `);
      }
      // description 有时含产品名
      if (typeof tool.description === 'string' && tool.description.length < 500) {
        push(tool.description);
      }
      if (typeof tool.function?.description === 'string' && tool.function.description.length < 500) {
        push(tool.function.description);
      }
    }
  }

  if (metadata.prompt) push(metadata.prompt);
  if (metadata.system) push(metadata.system);

  const corpus = chunks.join('\n');
  // 截断：身份句通常在 system 前部
  return corpus.length > 160000 ? corpus.slice(0, 160000) : corpus;
}

/**
 * @param {string} corpus
 * @param {Array<{source:string,patterns:RegExp[],minHits?:number}>} rules
 * @param {number} defaultMinHits
 * @returns {{source:string,hits:number}|null}
 */
function matchRulesScored(corpus, rules, defaultMinHits = 1) {
  if (!corpus) return null;
  let best = null;
  let bestHits = 0;
  for (const rule of rules) {
    const minHits = rule.minHits != null ? rule.minHits : defaultMinHits;
    let hits = 0;
    for (const re of rule.patterns) {
      if (re.test(corpus)) hits += 1;
    }
    // 同命中数时保留先出现的规则（GROK 等更靠前）
    if (hits >= minHits && hits > bestHits) {
      bestHits = hits;
      best = rule.source;
    }
  }
  return best ? { source: best, hits: bestHits } : null;
}

/**
 * 仅根据提示词/工具指纹识别
 * @returns {string|null}
 */
/**
 * Hermes 与 OpenClaw 都可能注入 SOUL.md；用 Hermes 运行时结构块仲裁。
 * @param {string} corpus
 * @returns {boolean}
 */
function hasHermesRuntimeMarkers(corpus) {
  if (!corpus) return false;
  return (
    /Active Hermes profile:/i.test(corpus) ||
    /You run on Hermes Agent/i.test(corpus) ||
    /hermes-agent\.nousresearch\.com/i.test(corpus) ||
    /Workspace \(snapshot at session start/i.test(corpus) ||
    (/User home directory:/i.test(corpus) && /Current working directory:/i.test(corpus)) ||
    /You are Hermes Agent/i.test(corpus) ||
    /created by Nous Research/i.test(corpus) ||
    /skill_view\(name=['"]hermes-agent['"]\)/i.test(corpus) ||
    /你是 Hermes Agent/i.test(corpus)
  );
}

/**
 * OpenClaw 专属（非共享 SOUL 模板）
 * @param {string} corpus
 * @returns {boolean}
 */
function hasOpenClawRuntimeMarkers(corpus) {
  if (!corpus) return false;
  return (
    /running inside OpenClaw/i.test(corpus) ||
    /You are a personal assistant running inside OpenClaw/i.test(corpus) ||
    /## OpenClaw Control/i.test(corpus) ||
    /## Workspace Files \(injected\)/i.test(corpus) ||
    /Sandbox container workdir:/i.test(corpus) ||
    /operating inside OpenClaw/i.test(corpus)
  );
}

function detectRequestSourceFromPrompt(body, metadata = {}) {
  const corpus = extractPromptCorpus(body, metadata);
  if (!corpus) return null;

  // 1) 身份句 / 结构块：任一命中即可；多产品同时命中时取命中数更高者
  const identity = matchRulesScored(corpus, PROMPT_IDENTITY_RULES, 1);
  if (identity) {
    // Hermes 常挂 OpenClaw 风格 SOUL：有 Hermes 运行时标记则 Hermes 优先
    if (
      identity.source === REQUEST_SOURCES.OPENCLAW &&
      hasHermesRuntimeMarkers(corpus) &&
      !hasOpenClawRuntimeMarkers(corpus)
    ) {
      return REQUEST_SOURCES.HERMES;
    }
    if (
      identity.source === REQUEST_SOURCES.HERMES &&
      hasOpenClawRuntimeMarkers(corpus) &&
      !hasHermesRuntimeMarkers(corpus)
    ) {
      return REQUEST_SOURCES.OPENCLAW;
    }
    return identity.source;
  }

  // 2) 支持规则：更严的 minHits，且禁止用跨产品弱特征
  const support = matchRulesScored(corpus, PROMPT_SUPPORT_RULES, 2);
  if (!support) return null;

  if (
    support.source === REQUEST_SOURCES.OPENCLAW &&
    hasHermesRuntimeMarkers(corpus) &&
    !hasOpenClawRuntimeMarkers(corpus)
  ) {
    return REQUEST_SOURCES.HERMES;
  }
  return support.source;
}

function detectFromHeadersOnly(headers = {}, metadata = {}) {
  const grokId = header(headers, 'x-grok-client-identifier');
  if (/^(grok|grok-shell|grok-tui|grok-web|nebula)/i.test(grokId)) {
    return REQUEST_SOURCES.GROK;
  }
  const hasGrokSession =
    header(headers, 'x-grok-session-id') ||
    header(headers, 'x-grok-conv-id') ||
    header(headers, 'x-grok-agent-id');
  if (hasGrokSession && /grok/i.test(header(headers, 'user-agent') + grokId)) {
    return REQUEST_SOURCES.GROK;
  }

  const explicit =
    header(headers, 'x-crewrouter-client') ||
    metadata.client ||
    metadata.clientName ||
    metadata.client_name ||
    '';
  if (/^grok(?:[-_]|$)/i.test(explicit)) return REQUEST_SOURCES.GROK;
  if (/^codex(?:[-_]|$)/i.test(explicit)) return REQUEST_SOURCES.CODEX;
  if (/^claude(?:[-_ ]?code)?(?:[-_/]|$)/i.test(explicit)) return REQUEST_SOURCES.CLAUDE_CODE;
  if (/^open[-_]?code(?:[-_/]|$)/i.test(explicit)) return REQUEST_SOURCES.OPENCODE;
  if (/^qwen(?:[-_ ]?code)?(?:[-_/]|$)/i.test(explicit)) return REQUEST_SOURCES.QWEN_CODE;
  if (/^hermes(?:[-_]?agent)?(?:[-_/]|$)/i.test(explicit)) return REQUEST_SOURCES.HERMES;
  if (/^open[-_]?claw(?:[-_/]|$)/i.test(explicit)) return REQUEST_SOURCES.OPENCLAW;
  if (/^deepseek(?:[-_]?harness)?(?:[-_/]|$)/i.test(explicit) || /^dsh(?:[-_/]|$)/i.test(explicit)) {
    return REQUEST_SOURCES.DEEPSEEK;
  }

  const originator = header(headers, 'originator');
  if (/^openclaw(?:$|[_-])/i.test(originator)) return REQUEST_SOURCES.OPENCLAW;
  if (looksLikeCodexOriginator(originator)) return REQUEST_SOURCES.CODEX;

  if (
    header(headers, 'x-opencode-session') ||
    header(headers, 'x-opencode-client') ||
    header(headers, 'x-opencode-request')
  ) {
    return REQUEST_SOURCES.OPENCODE;
  }

  const dsUa = header(headers, 'x-dashscope-useragent');
  if (dsUa && /QwenCode|qwen-code/i.test(dsUa)) return REQUEST_SOURCES.QWEN_CODE;

  if (
    header(headers, 'x-deepseek-harness-user-id') ||
    header(headers, 'x-deepseek-harness-session-id') ||
    header(headers, 'x-deepseek-harness-compact')
  ) {
    return REQUEST_SOURCES.DEEPSEEK;
  }

  return null;
}

function detectFromUserAgent(headers = {}) {
  const ua = header(headers, 'user-agent');
  if (!ua) return null;

  if (
    /(?:^|[\s/;])deepseek-harness\//i.test(ua) ||
    /\(\+https:\/\/github\.com\/deepseek-ai\/deepseek-harness\)/i.test(ua) ||
    /^deepseek-harness(?:$|[\s/])/i.test(ua)
  ) {
    return REQUEST_SOURCES.DEEPSEEK;
  }
  if (/(?:^|[\s/;])openclaw\//i.test(ua) || /^openclaw(?:\s|\(|$)/i.test(ua)) {
    return REQUEST_SOURCES.OPENCLAW;
  }
  if (
    /(?:^|[\s/;])hermes-cli\//i.test(ua) ||
    /(?:^|[\s/;])HermesAgent\//i.test(ua) ||
    /(?:^|[\s/;])HermesDashboard\//i.test(ua) ||
    /(?:^|[\s/;])hermes-dashboard\//i.test(ua) ||
    /^hermes(?:$|[\s/_-])/i.test(ua)
  ) {
    return REQUEST_SOURCES.HERMES;
  }
  if (
    /(?:^|[\s/;])QwenCode\//i.test(ua) ||
    /(?:^|[\s/;])qwen-code(?:\/|\s|$)/i.test(ua) ||
    /^qwen-code(?:$|[\s/])/i.test(ua)
  ) {
    return REQUEST_SOURCES.QWEN_CODE;
  }
  if (
    /(?:^|[\s/;])claude-cli\//i.test(ua) ||
    /(?:^|[\s/;])claude-code\//i.test(ua) ||
    /^claude-cli(?:$|[\s/])/i.test(ua) ||
    /^claude-code(?:$|[\s/])/i.test(ua)
  ) {
    return REQUEST_SOURCES.CLAUDE_CODE;
  }
  if (
    /(?:^|[\s/;])codex_cli_rs\//i.test(ua) ||
    /(?:^|[\s/;])codex-cli(?:\/|\s|$)/i.test(ua) ||
    /(?:^|[\s/;])codex_vscode\//i.test(ua) ||
    /(?:^|[\s/;])codex-tui\//i.test(ua) ||
    /(?:^|[\s/;])codex_atlas\//i.test(ua) ||
    /(?:^|[\s/;])codex_chatgpt_desktop\//i.test(ua) ||
    /^codex(?:$|[\s/_-])/i.test(ua)
  ) {
    return REQUEST_SOURCES.CODEX;
  }
  if (/(?:^|[\s/;])opencode\//i.test(ua) || /^opencode(?:$|[\s/])/i.test(ua)) {
    return REQUEST_SOURCES.OPENCODE;
  }
  if (
    /xai-grok|grok-(?:shell|tui|web|pager|build)\//i.test(ua) ||
    /(?:^|[\s/;])grok-shell\//i.test(ua) ||
    /^Grok\b/i.test(ua)
  ) {
    return REQUEST_SOURCES.GROK;
  }
  return null;
}

/**
 * @param {object} headers
 * @param {object} [metadata]
 * @param {object|string|null} [body] - 请求体（messages/system/tools/instructions）
 * @returns {string}
 */
function detectRequestSource(headers = {}, metadata = {}, body = null) {
  // 1) 强 Header / 显式声明
  const fromHeaderStrong = detectFromHeadersOnly(headers, metadata);
  // 仅 x-crewrouter-client 与 grok 强头、originator 等：其中 explicit 与 grok 最强
  // 若 header 命中但与提示词身份冲突，提示词身份优先（除 x-crewrouter-client 与 x-grok-*）
  const explicit =
    header(headers, 'x-crewrouter-client') ||
    metadata.client ||
    metadata.clientName ||
    metadata.client_name ||
    '';
  const hasExplicit = Boolean(String(explicit).trim());
  const hasStrongGrok =
    /^(grok|grok-shell|grok-tui|grok-web|nebula)/i.test(header(headers, 'x-grok-client-identifier'));

  if (hasExplicit && fromHeaderStrong) return fromHeaderStrong;
  if (hasStrongGrok) return REQUEST_SOURCES.GROK;

  // 2) 提示词高置信度身份（可纠正伪装 UA，如 Qwen→claude-cli）
  const fromPrompt = detectRequestSourceFromPrompt(body ?? metadata.body ?? null, metadata);
  if (fromPrompt) return fromPrompt;

  // 3) 其余 Header（originator、x-opencode-* 等）
  if (fromHeaderStrong) return fromHeaderStrong;

  // 4) User-Agent
  const fromUa = detectFromUserAgent(headers);
  if (fromUa) return fromUa;

  return REQUEST_SOURCES.UNKNOWN;
}

function normalizeRequestSource(value) {
  const source = String(value || '')
    .trim()
    .toLowerCase();
  return Object.values(REQUEST_SOURCES).includes(source) ? source : REQUEST_SOURCES.UNKNOWN;
}

function sourceLabel(value) {
  return LABELS[normalizeRequestSource(value)];
}

function sourceBadgeColor(value) {
  return BADGE_COLORS[normalizeRequestSource(value)] || BADGE_COLORS.unknown;
}

/**
 * @param {import('express').Request|object} req
 * @param {object} [metadata]
 */
function clientMetaFromReq(req, metadata = {}) {
  const headers = req?.headers || {};
  // 支持直接传 headers 对象（旧测试）
  const isPlainHeaders =
    req && !req.headers && typeof req === 'object' && !req.body && !req.method;
  const hdrs = isPlainHeaders ? req : headers;
  const body = metadata.body !== undefined ? metadata.body : req?.body;
  const uaRaw = header(hdrs, 'user-agent');
  const userAgent = uaRaw ? uaRaw.slice(0, 500) : null;
  return {
    requestSource: detectRequestSource(hdrs, metadata, body),
    userAgent,
  };
}

module.exports = {
  REQUEST_SOURCES,
  HARNESS_SOURCES,
  LABELS,
  BADGE_COLORS,
  detectRequestSource,
  detectRequestSourceFromPrompt,
  extractPromptCorpus,
  normalizeRequestSource,
  isHarnessSource,
  sourceLabel,
  sourceBadgeColor,
  clientMetaFromReq,
};
