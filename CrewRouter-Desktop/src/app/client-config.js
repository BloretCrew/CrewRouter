'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const JSON5 = require('json5');
const jsonc = require('jsonc-parser');
const TOML = require('@iarna/toml');
const YAML = require('yaml');

const TOOLS = Object.freeze({
  claude: ['CLAUDE_CONFIG_DIR', '.claude', 'settings.json', 'jsonc'],
  codex: ['CODEX_HOME', '.codex', 'config.toml', 'toml'],
  grok: ['GROK_HOME', '.grok', 'config.toml', 'toml'],
  opencode: ['XDG_CONFIG_HOME', '.config', 'opencode/opencode.json', 'jsonc'],
  qwen_code: ['QWEN_HOME', '.qwen', 'settings.json', 'jsonc'],
  hermes: ['HERMES_HOME', '.hermes', 'config.yaml', 'yaml'],
  openclaw: ['OPENCLAW_STATE_DIR', '.openclaw', 'openclaw.json', 'json5'],
});
const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', opencode: 'OpenCode', qwen_code: 'Qwen Code', hermes: 'Hermes', openclaw: 'OpenClaw' };
const MAX_FILE = 1024 * 1024;
class ConfigError extends Error {}
const fail = (message) => { throw new ConfigError(message); };
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function safePath(value, home) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) fail('配置目录无效，请使用手动配置。');
  value = value.trim();
  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = path.join(home, value.slice(2));
  if (!path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) fail('配置目录必须是无路径穿越的绝对路径。');
  return path.normalize(value);
}

function inspectPath(target) {
  const root = path.parse(target).root;
  let current = root;
  const parts = target.slice(root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) fail('配置路径包含符号链接，请使用手动配置。');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('配置父路径不是目录。');
    if (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)) fail('配置文件不是普通独立文件。');
    if (i === parts.length - 1 && typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('配置文件不属于当前用户。');
  }
}

function objectAt(root, keys) {
  let node = root;
  for (const key of keys) {
    if (node[key] === undefined) node[key] = {};
    if (!plain(node[key])) fail('配置字段类型冲突，请使用手动配置。');
    node = node[key];
  }
  return node;
}
function merge(root, keys, values) { Object.assign(objectAt(root, keys), values); }
function mergeModel(root, keys, model, values) {
  const parent = objectAt(root, keys.slice(0, -1));
  const key = keys.at(-1);
  if (parent[key] === undefined) parent[key] = [];
  if (!Array.isArray(parent[key]) || parent[key].some((item) => !plain(item) || typeof item.id !== 'string')) fail('模型列表结构无效，请使用手动配置。');
  if (parent[key].filter((item) => item.id === model).length > 1) fail('模型列表存在重复 ID。');
  const existing = parent[key].find((item) => item.id === model);
  if (existing) Object.assign(existing, values);
  else parent[key].push({ id: model, ...values });
}
function validateTree(value, depth = 0) {
  if (depth > 40) fail('配置结构过于复杂，请使用手动配置。');
  if (value instanceof Date) fail('配置包含无法安全保留的日期时间，请使用手动配置。');
  if (typeof value === 'bigint') fail('配置包含无法安全保留的整数。');
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) fail('配置包含无法安全保留的数值。');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype', '$include', 'include', 'includes', 'extends'].includes(key)) fail('配置包含不支持的引用或复杂字段，请使用手动配置。');
    validateTree(item, depth + 1);
  }
}
function hasComments(text, format) {
  const scanner = jsonc.createScanner(text, false);
  if (format === 'json5') {
    // JSON5 单引号字符串需先屏蔽，避免把字符串内容误认为注释。
    text = text.replace(/'(?:\\.|[^'\\])*'/g, '""');
  }
  if (format === 'json5') {
    const scan = jsonc.createScanner(text, false);
    for (let token = scan.scan(); token !== jsonc.SyntaxKind.EOF; token = scan.scan()) {
      if ([jsonc.SyntaxKind.LineCommentTrivia, jsonc.SyntaxKind.BlockCommentTrivia].includes(token)) return true;
    }
    return false;
  }
  for (let token = scanner.scan(); token !== jsonc.SyntaxKind.EOF; token = scanner.scan()) {
    if ([jsonc.SyntaxKind.LineCommentTrivia, jsonc.SyntaxKind.BlockCommentTrivia].includes(token)) return true;
  }
  return false;
}
function checkDuplicateKeys(node) {
  if (!node) return;
  if (node.type === 'object') {
    const keys = node.children.map((item) => item.children[0].value);
    if (new Set(keys).size !== keys.length) fail('配置存在重复字段。');
  }
  for (const child of node.children || []) checkDuplicateKeys(child);
}
function parseConfig(text, format) {
  let result;
  if (format === 'jsonc') {
    const errors = [];
    const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length || !tree) fail('配置损坏，请先修复或使用手动配置。');
    checkDuplicateKeys(tree);
    result = jsonc.getNodeValue(tree);
  } else if (format === 'json5') {
    if (hasComments(text, format)) fail('无法安全保留 JSON5 注释，请使用手动配置。');
    const errors = [];
    const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length || !tree) fail('无法安全保留复杂 JSON5，请使用手动配置。');
    checkDuplicateKeys(tree);
    result = JSON5.parse(text);
  } else if (format === 'toml') {
    // 当前 TOML 解析器不能无损保留注释或多行字符串。
    if (text.includes('#') || text.includes('"""') || text.includes("'''")) fail('无法安全保留复杂 TOML 或注释，请使用手动配置。');
    result = TOML.parse(text);
  } else {
    const doc = YAML.parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) fail('YAML 配置损坏，请使用手动配置。');
    YAML.visit(doc, (_key, node) => {
      if (YAML.isAlias(node) || node?.anchor || node?.tag || node?.comment || node?.commentBefore) fail('无法安全保留复杂 YAML 或注释，请使用手动配置。');
    });
    if (doc.comment || doc.commentBefore) fail('无法安全保留 YAML 注释，请使用手动配置。');
    result = doc.toJS({ maxAliasCount: 0 });
  }
  if (!plain(result)) fail('配置顶层必须是对象。');
  validateTree(result);
  return result;
}
function applyConfig(config, { tool, baseUrl, apiKey, model }) {
  switch (tool) {
    case 'claude':
      merge(config, ['env'], { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model });
      config.model = model;
      if (config.effortLevel === undefined) config.effortLevel = 'high';
      break;
    case 'codex':
      Object.assign(config, { model, model_provider: 'crewrouter' });
      merge(config, ['model_providers', 'crewrouter'], { name: 'CrewRouter', base_url: baseUrl, experimental_bearer_token: apiKey, wire_api: 'responses', requires_openai_auth: false });
      break;
    case 'grok':
      merge(config, ['model', 'crewrouter'], { model, name: 'CrewRouter', base_url: baseUrl, api_key: apiKey, api_backend: 'chat_completions' });
      if (config.model.crewrouter.context_window === undefined) config.model.crewrouter.context_window = 200000;
      merge(config, ['models'], { default: 'crewrouter' }); break;
    case 'opencode':
      merge(config, ['provider', 'crewrouter'], { npm: '@ai-sdk/openai-compatible', name: 'CrewRouter' });
      merge(config, ['provider', 'crewrouter', 'options'], { baseURL: baseUrl, apiKey });
      merge(config, ['provider', 'crewrouter', 'models', model], { name: model });
      config.model = `crewrouter/${model}`; break;
    case 'qwen_code':
      merge(config, ['model'], { name: model, baseUrl });
      merge(config, ['security', 'auth'], { selectedType: 'openai', apiKey, baseUrl });
      merge(config, ['providerProtocol'], { crewrouter: 'openai' });
      mergeModel(config, ['modelProviders', 'crewrouter'], model, { name: model, baseUrl }); break;
    case 'hermes':
      merge(config, ['model'], { provider: 'custom:crewrouter', default: model });
      merge(config, ['providers', 'crewrouter'], { base_url: baseUrl, api_key: apiKey, transport: 'openai_chat', default_model: model }); break;
    case 'openclaw':
      merge(config, ['models', 'providers', 'crewrouter'], { baseUrl, apiKey, api: 'openai-completions' });
      mergeModel(config, ['models', 'providers', 'crewrouter', 'models'], model, { name: model });
      merge(config, ['agents', 'defaults', 'model'], { primary: `crewrouter/${model}` }); break;
    default: fail('不支持此客户端自动写入。');
  }
  return config;
}
function serialize(text, before, after, format) {
  if (format === 'jsonc' && text) {
    function update(old, value, keys) {
      if (plain(old) && plain(value)) {
        for (const key of Object.keys(value)) update(old[key], value[key], [...keys, key]);
      } else if (JSON.stringify(old) !== JSON.stringify(value)) {
        if (Array.isArray(old) && hasComments(text, 'jsonc')) fail('无法安全保留模型列表注释，请使用手动配置。');
        text = jsonc.applyEdits(text, jsonc.modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      }
    }
    update(before, after, []);
    return text;
  }
  if (format === 'toml') return TOML.stringify(after);
  if (format === 'yaml') return YAML.stringify(after);
  return `${JSON.stringify(after, null, 2)}\n`;
}
function validateRequest(request) {
  if (!plain(request) || Object.keys(request).some((key) => !['tool', 'baseUrl', 'apiKey', 'model', 'project'].includes(key))) fail('配置请求字段无效。');
  if (!Object.hasOwn(TOOLS, request.tool)) fail('不支持此客户端自动写入。');
  for (const [key, max] of [['baseUrl', 2048], ['apiKey', 4096], ['model', 256]]) {
    const value = request[key];
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x20\x7f]/.test(value)) fail('配置请求参数无效。');
  }
  if (['__proto__', 'constructor', 'prototype'].includes(request.model)) fail('模型名称无效。');
  let url;
  try { url = new URL(request.baseUrl); } catch { fail('服务地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('服务地址必须是无凭证、无查询参数的 HTTP(S) 地址。');
  if (request.project !== undefined && (typeof request.project !== 'boolean' || request.tool !== 'opencode')) fail('只有 OpenCode 支持项目配置请求。');
}

function createClientConfigService({ env = process.env, home = os.homedir(), dialog, getWindow = () => null, fsImpl = fs } = {}) {
  let busy = false;
  home = safePath(home, os.homedir());
  function target(tool) {
    if (typeof tool !== 'string') fail('客户端名称无效。');
    if (!Object.hasOwn(TOOLS, tool)) return { path: null, supported: false };
    if ((tool === 'hermes' && env.HERMES_PROFILE) || (tool === 'openclaw' && env.OPENCLAW_PROFILE) || (tool === 'opencode' && (env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_DIR || env.OPENCODE_CONFIG_CONTENT))) fail('存在 profile 或额外配置覆盖，请使用手动配置。');
    const [variable, directory, filename, format] = TOOLS[tool];
    const effectiveHome = tool === 'openclaw' && env.OPENCLAW_HOME ? safePath(env.OPENCLAW_HOME, home) : home;
    let file = path.join(safePath(env[variable] || path.join(effectiveHome, directory), effectiveHome), filename);
    if (tool === 'openclaw' && env.OPENCLAW_CONFIG_PATH) file = safePath(env.OPENCLAW_CONFIG_PATH, home);
    if (tool === 'opencode') {
      const alternative = file.replace(/\.json$/, '.jsonc');
      inspectPath(alternative);
      if (fs.existsSync(alternative)) {
        if (fs.existsSync(file)) fail('同时存在多个 OpenCode 配置，请使用手动配置。');
        file = alternative;
      }
    }
    inspectPath(file);
    const managed = tool === 'claude' ? ['managed-settings.json', 'settings.local.json'] : tool === 'codex' ? ['managed_config.toml'] : tool === 'openclaw' ? ['clawdbot.json', 'moltbot.json'] : [];
    for (const name of managed) {
      const other = path.join(path.dirname(file), name);
      inspectPath(other);
      if (fs.existsSync(other)) fail('配置存在托管或额外文件覆盖，请使用手动配置。');
    }
    return { path: file, supported: true, format };
  }
  function read(file, format) {
    inspectPath(file);
    if (!fs.existsSync(file)) return { text: '', config: {} };
    const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size > MAX_FILE || stat.nlink !== 1) fail('配置文件过大或不安全。');
      const text = fs.readFileSync(handle, 'utf8');
      return { text, config: parseConfig(text, format) };
    } finally { fs.closeSync(handle); }
  }
  async function writeClientConfig(input, { isTrusted = () => true } = {}) {
    if (busy) fail('已有配置写入正在进行，请稍候。');
    busy = true;
    let temporary = null;
    try {
      validateRequest(input);
      const request = { ...input };
      const base = request.baseUrl.replace(/\/+$/, '');
      request.baseUrl = request.tool === 'claude' ? base.replace(/\/v1$/, '') : (/\/v1$/.test(base) ? base : base + '/v1');
      let resolved = target(request.tool);
      if (request.project) {
        const choice = await dialog.showOpenDialog(getWindow(), { title: '选择 OpenCode 项目目录', properties: ['openDirectory'] });
        if (choice.canceled || choice.filePaths.length !== 1) return { path: null, backupPath: null, canceled: true };
        resolved = { path: path.join(safePath(choice.filePaths[0], home), 'opencode.json'), format: 'jsonc', supported: true };
        const alternative = resolved.path.replace(/\.json$/, '.jsonc');
        inspectPath(alternative);
        if (fs.existsSync(alternative)) {
          if (fs.existsSync(resolved.path)) fail('同时存在多个 OpenCode 配置，请使用手动配置。');
          resolved.path = alternative;
        }
      }
      const file = resolved.path;
      const original = read(file, resolved.format);
      if (original.config.profile || original.config.profiles || original.config.managed || original.config.custom_providers) fail('配置存在 profile 或托管歧义，请使用手动配置。');
      const provider = request.tool === 'codex' ? original.config.model_providers?.crewrouter : request.tool === 'grok' ? original.config.model?.crewrouter : request.tool === 'hermes' ? original.config.providers?.crewrouter : null;
      if (provider && ['env_key', 'auth_provider', 'http_headers', 'env_http_headers', 'extra_headers', 'key_env', 'api_key_env', 'key_cmd', 'api_mode'].some((key) => provider[key] !== undefined)) fail('配置存在认证覆盖，请使用手动配置。');
      if (request.tool === 'qwen_code' && original.config.modelProviders?.crewrouter?.some?.((item) => item.id === request.model && (item.envKey !== undefined || item.apiKey !== undefined))) fail('配置存在模型认证覆盖，请使用手动配置。');
      if (request.tool === 'qwen_code' && hasComments(original.text, 'jsonc') && original.config.modelProviders?.crewrouter) fail('无法安全保留模型列表注释，请使用手动配置。');
      if (provider?.requires_openai_auth === true || provider?.auth !== undefined) fail('配置存在认证覆盖，请使用手动配置。');
      if (request.tool === 'opencode') {
        const provider = original.config.provider?.crewrouter;
        for (const headers of [provider?.headers, provider?.options?.headers]) {
          if (headers !== undefined && (!plain(headers) || Object.keys(headers).some((key) => key.toLowerCase() === 'authorization'))) fail('配置存在认证请求头覆盖，请使用手动配置。');
        }
      }
      const after = applyConfig(structuredClone(original.config), request);
      const output = serialize(original.text, original.config, after, resolved.format);
      if (Buffer.byteLength(output) > MAX_FILE) fail('配置文件合并后过大，请使用手动配置。');
      parseConfig(output, resolved.format);
      const confirmation = await dialog.showMessageBox(getWindow(), {
        type: 'warning', title: '写入客户端配置？', message: `写入 ${TOOL_NAMES[request.tool]} 配置？`,
        detail: `目标文件：${file}\n将更新 CrewRouter 服务地址、认证密钥和默认模型；同名 provider 和默认模型可能被替换。保留其他字段，已有文件自动备份。\n${request.tool === 'hermes' ? 'Hermes 现有凭证池或 profile 可能影响实际认证。' : ''}`,
        buttons: ['取消', '写入配置'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirmation.response !== 1) return { path: file, backupPath: null, canceled: true };
      if (!isTrusted()) fail('页面已变化，请重新打开配置窗口。');
      if (!request.project && target(request.tool).path !== file) fail('目标配置已变化，请重试。');
      const current = read(file, resolved.format);
      if (current.text !== original.text || fs.existsSync(file) !== Boolean(original.text)) {
        // 空配置无法解析，因此空文本只表示此前文件不存在。
        fail('配置文件已变化，请重试。');
      }
      inspectPath(file);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      inspectPath(file);
      const suffix = crypto.randomUUID();
      const backupPath = original.text ? `${file}.crewrouter-backup-${suffix}` : null;
      if (backupPath) fs.writeFileSync(backupPath, original.text, { flag: 'wx', mode: 0o600 });
      temporary = path.join(path.dirname(file), `.crewrouter-${suffix}.tmp`);
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, output, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      inspectPath(file);
      if (!isTrusted() || read(file, resolved.format).text !== original.text) fail('配置或页面已变化，请重试。');
      fsImpl.renameSync(temporary, file);
      temporary = null;
      return { path: file, backupPath, canceled: false };
    } catch (error) {
      // 解析器和文件系统错误可能携带原文；仅透传模块定义的固定提示。
      if (error instanceof ConfigError) throw error;
      throw new Error('配置写入失败，请检查格式、目录权限，或使用手动配置。');
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
      busy = false;
    }
  }
  return {
    getClientConfigTarget(tool) { try { const result = target(tool); return { path: result.path, supported: result.supported }; } catch { throw new Error('配置路径不安全或存在额外覆盖，请使用手动配置。'); } },
    writeClientConfig,
  };
}

module.exports = { createClientConfigService, TOOLS };
