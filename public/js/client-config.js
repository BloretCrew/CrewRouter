(function (root) {
  'use strict';

  const DEFAULT_MODEL = 'claude-fable-5';
  const GEMINI_MODEL = 'gemini-2.5-pro';
  const DEFAULT_MODEL_BY_TOOL = Object.freeze({ gemini_cli: GEMINI_MODEL });
  const MODEL_CONTEXT_WINDOW = 200000;
  const MODEL_MAX_OUTPUT = 64000;
  const ZCODE_MAX_OUTPUT = 32768;
  const KIMI_CONTEXT_SIZE = 200000;
  const KIMI_LINK_CONTEXT_SIZE = 131072;
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
  const toV1 = value => /\/v1$/.test(value) ? value : value + '/v1';
  const toAnthropicBase = value => value.replace(/\/v1$/, '');

  function defaultModelFor(tool) {
    return DEFAULT_MODEL_BY_TOOL[tool] || DEFAULT_MODEL;
  }

  function piModelsDocument(v1, apiKey, model) {
    return {
      $schema: 'https://pi.dev/schemas/models.schema.json',
      providers: { crewrouter: {
        name: 'CrewRouter',
        baseUrl: v1,
        api: 'openai-completions',
        apiKey,
        models: [{ id: model, name: model, contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: MODEL_MAX_OUTPUT }]
      } }
    };
  }

  function qoderProvider(v1, apiKey, model) {
    return {
      type: 'openai-compatible',
      protocol: 'openai',
      authType: 'bearer',
      displayName: 'CrewRouter',
      baseUrl: v1,
      apiKey,
      model,
      models: [{
        model,
        displayName: model,
        contextWindow: MODEL_CONTEXT_WINDOW,
        maxOutputTokens: MODEL_MAX_OUTPUT,
        capabilities: { tools: true, vision: false }
      }]
    };
  }

  function zcodeProviderConfig(v1, apiKey, model) {
    return {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{
          providerId: 'crewrouter',
          templateId: null,
          providerName: 'CrewRouter',
          enabled: true,
          config: {
            group: 'standard-personal',
            logo: null,
            access: { type: 'api-key', apiKey },
            api: { type: 'openai-chat-completions', baseUrl: v1, headers: {} },
            personalModelIds: [model],
            modelOrder: [model],
            visibility: 'visible'
          }
        }] },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [{
            providerId: 'crewrouter',
            modelId: model,
            config: {
              enabled: true,
              properties: {
                contextWindow: MODEL_CONTEXT_WINDOW,
                inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: false
              },
              optionSpecs: {
                maxOutputTokens: { max: ZCODE_MAX_OUTPUT },
                reasoningLevel: { values: ['disabled'], map: '{}' }
              }
            }
          }]
        },
        providerOrder: ['crewrouter'],
        defaultModelSelection: { providerId: 'crewrouter', modelId: model }
      }
    };
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
    const v1 = toV1(base);
    const result = (title, path, content, supported = true, reason = '') => ({ title, path, content, supported, reason });

    switch (tool) {
      case 'claude':
        return result('Claude Code 配置', '~/.claude/settings.json', json({
          env: {
            ANTHROPIC_BASE_URL: toAnthropicBase(base), ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model
          },
          model,
          effortLevel: 'high'
        }));
      case 'claude_desktop':
        return result('Claude Desktop 配置', '~/Library/Application Support/Claude-3p/configLibrary/crewrouter.json', json({
          coworkEgressAllowedHosts: ['*'],
          disableDeploymentModeChooser: true,
          inferenceGatewayApiKey: apiKey,
          inferenceGatewayAuthScheme: 'bearer',
          inferenceGatewayBaseUrl: toAnthropicBase(base),
          inferenceProvider: 'gateway',
          inferenceModels: [model]
        }), false, 'Claude Desktop 需要同时修改 Claude 与 Claude-3p 的 claude_desktop_config.json 和 configLibrary，请按文档手动配置或使用 CC Switch 导入。');
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
      case 'pi':
        return result('Pi 配置', '~/.pi/agent/models.json', json(piModelsDocument(v1, apiKey, model)));
      case 'kimi_code':
        return result('Kimi Code 配置', '~/.kimi-code/config.toml', [
          'default_model = ' + quote('crewrouter/' + model),
          '',
          '[providers.crewrouter]',
          'type = "openai"',
          'base_url = ' + quote(v1),
          'api_key = ' + quote(apiKey),
          '',
          '[models.' + quote('crewrouter/' + model) + ']',
          'provider = "crewrouter"',
          'model = ' + quote(model),
          'display_name = ' + quote(model),
          'max_context_size = ' + KIMI_CONTEXT_SIZE,
          'capabilities = ["tool_use"]'
        ].join('\n'));
      case 'qoder_cli':
        return result('Qoder CLI 配置', '~/.qoder/settings.json', json({
          providers: { crewrouter: qoderProvider(v1, apiKey, model) }
        }));
      case 'cursor':
        return result('Cursor 配置', '~/.config/Cursor/User/globalStorage/state.vscdb', [
          'Cursor 自定义 OpenAI 兼容端点（手动配置）',
          '',
          '1. 打开 Cursor Settings → Models。',
          '2. 在 OpenAI API Key 中填入：',
          '   ' + apiKey,
          '3. 启用 Override OpenAI Base URL，并填写：',
          '   ' + v1,
          '4. 在模型列表中选择或添加：',
          '   ' + model,
          '',
          'Cursor 把该地址保存在应用持久化存储（state.vscdb）中，',
          '不读取 settings.json；因此这里不生成可执行写入命令。'
        ].join('\n'), false, 'Cursor 将自定义端点保存在应用持久化存储（state.vscdb）中，不读取 settings.json；请在 Settings → Models 中手动填写 API Key 与 Base URL。');
      case 'zcode':
        return result('ZCode 配置', '~/.zcode/v2/provider_config.json', json(zcodeProviderConfig(v1, apiKey, model)));
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

  function jsonMergeShell(filePath, script) {
    const body = script.join('\n');
    const delimiter = pickHeredocDelimiter(body, 'CREWROUTER_JSON');
    return [
      'mkdir -p "' + parentDir(filePath) + '"',
      'if command -v node >/dev/null 2>&1; then',
      '  node - "' + filePath + '" <<\'' + delimiter + '\'',
      ...script,
      delimiter,
      '  chmod 600 "' + filePath + '"',
      'else',
      '  echo \'CrewRouter: 未找到 node，请按文档手动合并 ' + filePath + '\'',
      'fi'
    ];
  }

  function piSettingsShell(model) {
    return jsonMergeShell('$HOME/.pi/agent/settings.json', [
      "const fs = require('fs');",
      'const file = process.argv[2];',
      'let doc = {};',
      "try { const text = fs.readFileSync(file, 'utf8'); if (text.trim()) doc = JSON.parse(text); } catch (error) {",
      "  if (error.code !== 'ENOENT') { console.error('CrewRouter: 拒绝覆盖无法解析的 settings.json:', error.message); process.exit(1); }",
      '}',
      "if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { console.error('CrewRouter: settings.json 顶层不是对象'); process.exit(1); }",
      'doc.defaultProvider = "crewrouter";',
      'doc.defaultModel = ' + JSON.stringify(model) + ';',
      "fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\\n');"
    ]);
  }

  function qoderSettingsShell(provider) {
    return jsonMergeShell('$HOME/.qoder/settings.json', [
      "const fs = require('fs');",
      'const file = process.argv[2];',
      'let doc = {};',
      "try { const text = fs.readFileSync(file, 'utf8'); if (text.trim()) doc = JSON.parse(text); } catch (error) {",
      "  if (error.code !== 'ENOENT') { console.error('CrewRouter: 拒绝覆盖无法解析的 settings.json:', error.message); process.exit(1); }",
      '}',
      "if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { console.error('CrewRouter: settings.json 顶层不是对象'); process.exit(1); }",
      "doc.providers = doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers) ? doc.providers : {};",
      'doc.providers.crewrouter = ' + JSON.stringify(provider, null, 2) + ';',
      "fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\\n');"
    ]);
  }

  function zcodeProviderShell(document) {
    const rule = document.config.providerConfigRules.providerRules[0];
    const manual = document.config.modelConfigRules.manualProviderModelRules[0];
    const selection = document.config.defaultModelSelection;
    return jsonMergeShell('$HOME/.zcode/v2/provider_config.json', [
      "const fs = require('fs');",
      'const file = process.argv[2];',
      'let doc = null;',
      "try { const text = fs.readFileSync(file, 'utf8'); if (text.trim()) doc = JSON.parse(text); } catch (error) {",
      "  if (error.code !== 'ENOENT') { console.error('CrewRouter: 拒绝覆盖无法解析的 provider_config.json:', error.message); process.exit(1); }",
      '}',
      'if (!doc) doc = { schemaVersion: 1, config: {} };',
      "if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.schemaVersion !== 1) { console.error('CrewRouter: provider_config.json 不是 schemaVersion 1'); process.exit(1); }",
      "doc.config = doc.config && typeof doc.config === 'object' && !Array.isArray(doc.config) ? doc.config : {};",
      "doc.config.providerConfigRules = doc.config.providerConfigRules && typeof doc.config.providerConfigRules === 'object' && !Array.isArray(doc.config.providerConfigRules) ? doc.config.providerConfigRules : {};",
      'doc.config.providerConfigRules.providerRules = (Array.isArray(doc.config.providerConfigRules.providerRules) ? doc.config.providerConfigRules.providerRules : []).filter(rule => !rule || rule.providerId !== "crewrouter");',
      'doc.config.providerConfigRules.providerRules.push(' + JSON.stringify(rule, null, 2) + ');',
      "doc.config.modelConfigRules = doc.config.modelConfigRules && typeof doc.config.modelConfigRules === 'object' && !Array.isArray(doc.config.modelConfigRules) ? doc.config.modelConfigRules : {};",
      'doc.config.modelConfigRules.providerModelRules = (Array.isArray(doc.config.modelConfigRules.providerModelRules) ? doc.config.modelConfigRules.providerModelRules : []).filter(rule => !rule || rule.providerId !== "crewrouter");',
      'doc.config.modelConfigRules.manualProviderModelRules = (Array.isArray(doc.config.modelConfigRules.manualProviderModelRules) ? doc.config.modelConfigRules.manualProviderModelRules : []).filter(rule => !rule || rule.providerId !== "crewrouter");',
      'doc.config.modelConfigRules.manualProviderModelRules.push(' + JSON.stringify(manual, null, 2) + ');',
      'doc.config.providerOrder = ["crewrouter", ...(Array.isArray(doc.config.providerOrder) ? doc.config.providerOrder.filter(id => id !== "crewrouter") : [])];',
      'doc.config.defaultModelSelection = ' + JSON.stringify(selection) + ';',
      "fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\\n');"
    ]);
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
    const base = String(options?.baseUrl ?? options?.claudeConfig?.env?.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
    const apiKey = options?.apiKey ?? options?.claudeConfig?.env?.ANTHROPIC_AUTH_TOKEN;
    const model = options?.model || defaultModelFor(tool);
    if (tool === 'qoder_cli') {
      return Object.assign({}, generated, { shell: qoderSettingsShell(qoderProvider(toV1(base), apiKey, model)).join('\n') });
    }
    if (tool === 'zcode') {
      return Object.assign({}, generated, { shell: zcodeProviderShell(zcodeProviderConfig(toV1(base), apiKey, model)).join('\n') });
    }
    const lines = writeFileShell(filePath, generated.content);
    if (tool === 'pi') lines.push(...piSettingsShell(model));
    if (tool === 'gemini_cli') lines.push(...geminiSettingsShell());
    if (tool === 'agy') lines.push(agyLaunchShell(options));
    return Object.assign({}, generated, { shell: lines.join('\n') });
  }

  function ccSwitchConfig(app, { baseUrl, apiKey, model } = {}) {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    if (!base || typeof apiKey !== 'string' || !apiKey) {
      throw new Error('客户端配置参数无效');
    }
    if (app === 'claude' || app === 'claude-desktop') {
      return { env: { ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_BASE_URL: toAnthropicBase(base), ANTHROPIC_MODEL: model || DEFAULT_MODEL } };
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
    if (app === 'pi') {
      const selected = model || DEFAULT_MODEL;
      return {
        name: 'CrewRouter',
        baseUrl: toV1(base),
        apiKey,
        api: 'openai-completions',
        models: [{ id: selected, name: selected }]
      };
    }
    if (app === 'kimi') {
      const selected = model || DEFAULT_MODEL;
      return {
        provider: { type: 'openai', base_url: toV1(base), api_key: apiKey },
        models: { [selected]: { model: selected, max_context_size: KIMI_LINK_CONTEXT_SIZE, capabilities: ['tool_use'] } }
      };
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
