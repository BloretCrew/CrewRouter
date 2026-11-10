(function (root) {
  'use strict';

  const DEFAULT_MODEL = 'claude-fable-5';
  const GEMINI_MODEL = 'gemini-2.5-pro';
  const DEFAULT_MODEL_BY_TOOL = Object.freeze({ gemini_cli: GEMINI_MODEL });
  const json = value => JSON.stringify(value, null, 2);
  const quote = value => JSON.stringify(value).replace(/\u007f/g, '\\u007f');
  const shellQuote = value => "$'" + value.replace(/[\\'\x00-\x1f\x7f]/g, char => {
    if (char === '\\' || char === "'") return '\\' + char;
    return '\\' + char.charCodeAt(0).toString(8).padStart(3, '0');
  }) + "'";
  const dotenvQuote = value => '"' + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f\x7f]/g, char => {
      if (char === '\n') return '\\n';
      if (char === '\r') return '\\r';
      if (char === '\t') return '\\t';
      return '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
    }) + '"';

  function defaultModelFor(tool) {
    return DEFAULT_MODEL_BY_TOOL[tool] || DEFAULT_MODEL;
  }

  function generate(tool, { baseUrl, apiKey, model, claudeConfig } = {}) {
    baseUrl = baseUrl ?? claudeConfig?.env?.ANTHROPIC_BASE_URL;
    apiKey = apiKey ?? claudeConfig?.env?.ANTHROPIC_AUTH_TOKEN;
    model = model || defaultModelFor(tool);
    for (const value of [baseUrl, apiKey, model]) {
      if (typeof value !== 'string' || !value || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) {
        throw new Error('客户端配置参数无效');
      }
    }
    const base = baseUrl.replace(/\/+$/, '');
    const v1 = /\/v1$/.test(base) ? base : base + '/v1';
    const result = (title, path, content, supported = true, reason = '') => ({ title, path, content, supported, reason });

    switch (tool) {
      case 'claude':
        return result('Claude Code 配置', '~/.claude/settings.json', json({
          env: {
            ANTHROPIC_BASE_URL: base.replace(/\/v1$/, ''), ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model
          },
          model,
          effortLevel: 'high'
        }));
      case 'codex':
        return result('Codex 配置', '~/.codex/config.toml', [
          'model = ' + quote(model),
          'model_provider = "crewrouter"',
          '',
          '[model_providers.crewrouter]',
          'name = "CrewRouter"',
          'base_url = ' + quote(v1),
          'experimental_bearer_token = ' + quote(apiKey),
          'wire_api = "responses"',
          'requires_openai_auth = false'
        ].join('\n'));
      case 'grok':
        return result('Grok Build 配置', '~/.grok/config.toml', [
          '[model.crewrouter]',
          'model = ' + quote(model),
          'base_url = ' + quote(v1),
          'name = "CrewRouter"',
          'api_key = ' + quote(apiKey),
          'api_backend = "chat_completions"',
          'context_window = 200000',
          '',
          '[models]',
          'default = "crewrouter"'
        ].join('\n'));
      case 'opencode':
        return result('OpenCode 配置', '~/.config/opencode/opencode.json', json({
          provider: { crewrouter: {
            npm: '@ai-sdk/openai-compatible',
            name: 'CrewRouter',
            options: { baseURL: v1, apiKey },
            models: { [model]: { name: model } }
          } },
          model: 'crewrouter/' + model
        }));
      case 'qwen_code':
        return result('Qwen Code 配置', '~/.qwen/settings.json', json({
          model: { name: model, baseUrl: v1 },
          security: { auth: { selectedType: 'openai', apiKey, baseUrl: v1 } },
          providerProtocol: { crewrouter: 'openai' },
          modelProviders: { crewrouter: [{ id: model, name: model, baseUrl: v1 }] }
        }));
      case 'hermes':
        return result('Hermes 配置', '~/.hermes/config.yaml', [
          'model:',
          '  provider: "custom:crewrouter"',
          '  default: ' + quote(model),
          'providers:',
          '  crewrouter:',
          '    base_url: ' + quote(v1),
          '    api_key: ' + quote(apiKey),
          '    transport: "openai_chat"',
          '    default_model: ' + quote(model)
        ].join('\n'));
      case 'openclaw':
        return result('OpenClaw 配置', '~/.openclaw/openclaw.json', json({
          models: { providers: { crewrouter: {
            baseUrl: v1, apiKey, api: 'openai-completions',
            models: [{ id: model, name: model }]
          } } },
          agents: { defaults: { model: { primary: 'crewrouter/' + model } } }
        }));
      case 'gemini_cli':
        return result('Gemini CLI 配置', '~/.gemini/.env', [
          '# CrewRouter Gemini CLI',
          '# 如已登录 Google OAuth，请在 Gemini CLI 中执行 /auth 切换到 API Key',
          'GEMINI_API_KEY=' + dotenvQuote(apiKey),
          'GOOGLE_GEMINI_BASE_URL=' + dotenvQuote(base),
          'GEMINI_MODEL=' + dotenvQuote(model)
        ].join('\n'));
      case 'agy':
        return result('Antigravity CLI (agy) 配置', '~/.crewrouter/agy/antigravity-cli/settings.json', json({
          modelProvider: 'gemini'
        }), true, 'agy 只从进程环境读取密钥；请使用终端命令启动，或通过 CC Switch 导入。');
      case 'deepseek':
        return result('DeepSeek Harness 配置', '~/.dsh/settings.yaml', [
          '# ~/.dsh/settings.yaml',
          '# DeepSeek Harness (dsh) → CrewRouter',
          '# 配置路径、schema 与端点拼接行为未核实；以下仅保留手动配置参考',
          'llm-deepseek:',
          '  apiKeyEnv: DEEPSEEK_API_KEY',
          '  baseURL: ' + quote(v1),
          '',
          '# 同时导出密钥（或在 dsh 模型设置页写入同一凭证；以下使用 Bash）：',
          '# export DEEPSEEK_API_KEY=' + shellQuote(apiKey),
          '# export DEEPSEEK_BASE_URL=' + shellQuote(v1),
          ''
        ].join('\n'), false, 'DeepSeek Harness 的配置路径与 schema 未核实，仅提供手动配置。');
      default:
        return result('未知工具', '', '', false, '未知客户端工具');
    }
  }

  function toHomePath(path) {
    if (typeof path !== 'string' || !path) return '';
    if (path === '~') return '$HOME';
    if (path.startsWith('~/')) return '$HOME/' + path.slice(2);
    return path;
  }

  function parentDir(path) {
    const idx = path.lastIndexOf('/');
    return idx > 0 ? path.slice(0, idx) : '';
  }

  function pickHeredocDelimiter(content, base = 'CREWROUTER_EOF') {
    let delimiter = base;
    let n = 0;
    while (content.includes(delimiter)) {
      n += 1;
      delimiter = base + '_' + n;
    }
    return delimiter;
  }

  function writeFileShell(filePath, content) {
    const dirPath = parentDir(filePath);
    const delimiter = pickHeredocDelimiter(content);
    return [
      'mkdir -p "' + dirPath + '"',
      'cat > "' + filePath + '" <<\'' + delimiter + '\'',
      content,
      delimiter,
      'chmod 600 "' + filePath + '"'
    ];
  }

  function geminiSettingsShell() {
    const settingsPath = '$HOME/.gemini/settings.json';
    return [
      'if command -v node >/dev/null 2>&1; then',
      '  node - "' + settingsPath + '" <<\'CREWROUTER_JSON\' || exit 1',
      "const fs = require('fs');",
      'const file = process.argv[2];',
      'let doc = {};',
      "try { const text = fs.readFileSync(file, 'utf8'); if (text.trim()) doc = JSON.parse(text); } catch (error) {",
      "  if (error.code !== 'ENOENT') { console.error('CrewRouter: 拒绝覆盖无法解析的 settings.json:', error.message); process.exit(1); }",
      '}',
      "if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { console.error('CrewRouter: settings.json 顶层不是对象'); process.exit(1); }",
      "doc.security = doc.security && typeof doc.security === 'object' && !Array.isArray(doc.security) ? doc.security : {};",
      "doc.security.auth = doc.security.auth && typeof doc.security.auth === 'object' && !Array.isArray(doc.security.auth) ? doc.security.auth : {};",
      "doc.security.auth.selectedType = 'gemini-api-key';",
      "fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\\n');",
      'CREWROUTER_JSON',
      '  chmod 600 "' + settingsPath + '"',
      'else',
      '  echo \'CrewRouter: 未找到 node，请手动在 ~/.gemini/settings.json 设置 security.auth.selectedType = "gemini-api-key"\'',
      'fi'
    ];
  }

  function agyLaunchShell(options) {
    const baseUrl = String(options?.baseUrl ?? options?.claudeConfig?.env?.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
    const apiKey = options?.apiKey ?? options?.claudeConfig?.env?.ANTHROPIC_AUTH_TOKEN;
    if (typeof baseUrl !== 'string' || !baseUrl || typeof apiKey !== 'string' || !apiKey) {
      throw new Error('客户端配置参数无效');
    }
    const agyDir = '$HOME/.crewrouter/agy';
    return 'GEMINI_API_KEY=' + shellQuote(apiKey)
      + ' GOOGLE_GEMINI_BASE_URL=' + shellQuote(baseUrl)
      + ' agy --gemini_dir="' + agyDir + '"';
  }

  function generateShellCommand(tool, options) {
    const generated = generate(tool, options);
    if (!generated.supported || !generated.path || !generated.content) {
      return Object.assign({}, generated, { shell: '' });
    }
    const filePath = toHomePath(generated.path);
    if (!filePath) {
      return Object.assign({}, generated, { shell: '', supported: false, reason: generated.reason || '无法生成终端命令' });
    }
    const lines = writeFileShell(filePath, generated.content);
    if (tool === 'gemini_cli') lines.push(...geminiSettingsShell());
    if (tool === 'agy') lines.push(agyLaunchShell(options));
    return Object.assign({}, generated, { shell: lines.join('\n') });
  }

  function ccSwitchConfig(app, { baseUrl, apiKey, model } = {}) {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    if (!base || typeof apiKey !== 'string' || !apiKey) {
      throw new Error('客户端配置参数无效');
    }
    if (app === 'claude') {
      return { env: { ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_BASE_URL: base, ANTHROPIC_MODEL: model || DEFAULT_MODEL } };
    }
    if (app === 'codex') {
      return {
        auth: { OPENAI_API_KEY: apiKey },
        config: '[model_providers.openai]\nbase_url = "' + base + '"\n\n[general]\nmodel = "gpt-5.1"'
      };
    }
    if (app === 'gemini') {
      return { env: {
        GEMINI_API_KEY: apiKey,
        GOOGLE_GEMINI_BASE_URL: base,
        GEMINI_MODEL: model || GEMINI_MODEL
      } };
    }
    if (app === 'agy') {
      return { env: { GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: base } };
    }
    throw new Error('未知客户端应用');
  }

  root.CrewRouterClientConfig = Object.freeze({
    generate,
    generateShellCommand,
    ccSwitchConfig,
    defaultModelFor
  });
})(typeof window !== 'undefined' ? window : globalThis);
