# Desktop 客户端配置

Desktop 控制台的“客户端配置”支持确认后写入当前电脑。浏览器和旧版 Desktop 保留手动配置与复制按钮。

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

Desktop 尊重工具的配置目录环境变量；实际路径显示在弹窗及系统确认框。系统服务、项目配置、profile 或环境变量可能改变工具最终生效的配置。Hermes 现有凭证池也可能影响认证。DeepSeek Harness 的本地配置结构尚未核实，仅提供带提示的手动参考。

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
