(function (root) {
  'use strict';

  const DEFAULT_MODEL = 'claude-fable-5';
  const json = value => JSON.stringify(value, null, 2);
  const quote = value => JSON.stringify(value).replace(/\u007f/g, '\\u007f');
  const shellQuote = value => "$'" + value.replace(/[\\'\x00-\x1f\x7f]/g, char => {
    if (char === '\\' || char === "'") return '\\' + char;
    return '\\' + char.charCodeAt(0).toString(8).padStart(3, '0');
  }) + "'";

  function generate(tool, { baseUrl, apiKey, model = DEFAULT_MODEL, claudeConfig } = {}) {
    baseUrl = baseUrl ?? claudeConfig?.env?.ANTHROPIC_BASE_URL;
    apiKey = apiKey ?? claudeConfig?.env?.ANTHROPIC_AUTH_TOKEN;
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

  root.CrewRouterClientConfig = Object.freeze({ generate });
})(typeof window !== 'undefined' ? window : globalThis);
