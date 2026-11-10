# Desktop 客户端配置

Desktop 控制台的“客户端配置”支持确认后写入当前电脑。浏览器和旧版 Desktop 保留手动配置与复制按钮。结果弹窗可用晶液分段控件在「配置内容」与「终端命令」之间切换；终端命令面向 Bash（Linux / macOS / WSL），粘贴后整文件覆盖写入目标路径。

## 支持工具

| 工具 | 默认文件 | 写入结构 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `env` 中的 Anthropic 地址、认证与模型 |
| Codex | `~/.codex/config.toml` | `model_providers.crewrouter`，Responses 与 Bearer token |
| Grok Build | `~/.grok/config.toml` | `model.crewrouter` 与默认模型 |
| OpenCode | `~/.config/opencode/opencode.json` | `provider.crewrouter`；可选择项目目录 |
| Qwen Code | `~/.qwen/settings.json` | OpenAI 认证、模型与 `modelProviders` |
| Hermes | `~/.hermes/config.yaml` | named custom provider 与默认模型 |
| OpenClaw | `~/.openclaw/openclaw.json` | `models.providers.crewrouter` 与默认模型 |
| Gemini CLI（手动/终端） | `~/.gemini/.env` + `~/.gemini/settings.json` | `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL`；终端命令合并 `security.auth.selectedType = "gemini-api-key"` |
| Antigravity CLI / agy（手动/终端） | `~/.crewrouter/agy/antigravity-cli/settings.json` | `modelProvider: "gemini"`；Key 只通过进程环境传入，终端命令用 `agy --gemini_dir` 启动 |

Desktop 尊重工具的配置目录环境变量；实际路径显示在弹窗及系统确认框。系统服务、项目配置、profile 或环境变量可能改变工具最终生效的配置。Hermes 现有凭证池也可能影响认证。DeepSeek Harness 的本地配置结构尚未核实，仅提供带提示的手动参考，不生成可执行终端命令。

Gemini CLI 与 agy 目前**不参与 Desktop 自动写入**：Gemini CLI 需要同时维护 `.env` 与 `settings.json`，agy 依赖进程环境和私有 `--gemini_dir`，无法用现有单文件合并器表达。弹窗会自动回退到手动配置/终端命令；CC Switch 导入会由 cc-switch 处理原生文件与启动环境。

Gemini CLI 的 `.env` 只是用户级兜底：如果当前项目目录已有 `.env`，CLI 会优先读取项目文件。设置 `security.auth.selectedType` 前若已有 OAuth 登录，可在 CLI 中执行 `/auth` 切换到 API Key。

agy 的 `settings.json` 不写 `model`：agy 只认本机模型显示名，写模型 ID 会被静默忽略。需要固定模型时，在 agy 中执行 `/model` 选择。

## 终端一键命令

- 生成器：`CrewRouterClientConfig.generateShellCommand()`（`public/js/client-config.js`）。
- 形态：`mkdir -p "$HOME/..."`、`cat > ... <<'CREWROUTER_EOF'`、`chmod 600`。
- 语义：整文件覆盖，与 Desktop「合并写入并备份」不同；适合新机或可接受覆盖的场景。
- 命令含密钥；UI 提示勿分享。不支持 Windows 原生 PowerShell。
- Gemini CLI 的终端命令先整文件写 `~/.gemini/.env`，再用 `node -` 合并 `~/.gemini/settings.json`（保留其他字段；文件不是合法 JSON 时拒绝覆盖）。没有 `node` 时只提示手动设置。
- agy 的终端命令写私有 `~/.crewrouter/agy/antigravity-cli/settings.json`，然后以 `GEMINI_API_KEY=... GOOGLE_GEMINI_BASE_URL=... agy --gemini_dir=...` 启动；Key 不写入文件。
- OpenCode 终端命令写入用户级默认路径；项目目录选择仍仅 Desktop 写入流程提供。

## 写入保护

- 页面只能传工具、服务地址、凭证和模型，主进程决定文件路径与字段。
- 只有 Desktop 当前连接控制台的主帧可以调用写入；原生确认默认取消。
- 合并保留其他设置，写入前生成独立备份，使用临时文件原子替换。
- 含凭证的文件和备份限制为当前用户读写；错误提示不包含配置内容或凭证。
- 拒绝符号链接、硬链接、损坏配置、复杂引用、认证覆盖和并发变更。
- JSONC 可保留注释；已有 JSON5 仅接受安全的 JSONC 子集。无法安全保留的 TOML/YAML/JSON5 注释、日期时间及复杂结构会提示手动配置。

下方“备用选项：手动配置”随时可展开。配置内容包含密钥，请避免分享或提交。

## 验证

```sh
node scripts/test-client-config.js
npm --prefix CrewRouter-Desktop test
node CrewRouter-Desktop/scripts/test-client-config-flow.js
```

真实 Electron 流程使用隔离临时 HOME 和测试凭证，写入真实临时文件；系统确认通过测试代理模拟接受/取消。普通 Chrome 流程由 `scripts/test-client-config-browser.js` 验证，需要本地隔离 demo 服务和 Chrome 调试端口。

验收边界：自动写入成功表示文件已保存。各客户端版本的真实模型请求、系统服务环境及凭证池优先级仍需用户启动工具确认。
