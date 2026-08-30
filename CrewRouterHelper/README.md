# CrewRouterHelper —— CrewRouter 客户端事件上报

八个客户端共用一个上报器 [`cr-report.py`](./cr-report.py)（单文件 Python，零依赖）。

## 一次性配置

```bash
mkdir -p ~/.config ~/.local/bin
cp cr-report.py ~/.local/bin/cr-report.py && chmod +x ~/.local/bin/cr-report.py
cat > ~/.config/cr-report.json <<'EOF'
{ "url": "http://127.0.0.1:20003", "key": "你的 CrewRouter API Key" }
EOF
chmod 600 ~/.config/cr-report.json
~/.local/bin/cr-report.py test   # 应输出 HTTP 200 {"ok":true}
```

## 各客户端接入（原生 hook，无需兼容层）

### Claude Code（`~/.claude/settings.json`）
```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command",
      "command": "~/.local/bin/cr-report.py hook --harness claude_code"}]}],
    "SessionEnd":   [{"hooks": [{"type": "command",
      "command": "~/.local/bin/cr-report.py hook --harness claude_code"}]}],
    "PostToolUse":  [{"hooks": [{"type": "command",
      "command": "~/.local/bin/cr-report.py hook --harness claude_code"}]}]
  }
}
```
事件类型从 stdin 的 `hook_event_name` 自动推断，三段命令完全相同。

### Qwen Code（`~/.qwen/settings.json`）
同上，`--harness qwen_code`。Qwen hooks 与 Claude 格式一致。

### Codex（`~/.codex/config.toml`，v0.124+ 需 `codex_hooks = true`）
```toml
[hooks.PostToolUse]
command = "~/.local/bin/cr-report.py hook --harness codex"
```

### Grok（新版优先原生 Hooks）
Grok 1.x 支持全局 JSON Hooks。安装器只写入 CrewRouter 专用文件，不会覆盖 Orca/Bark 或其他 Hook：
```bash
cd CrewRouterHelper
python3 install-grok-hooks.py install
python3 install-grok-hooks.py install --cr-report ~/.local/bin/cr-report.py
python3 cr-report.py hook --harness grok <<'EOF'
{"hookEventName":"PostToolUse","sessionId":"test","toolName":"Bash","cwd":"/tmp"}
EOF
```
Hook 配置在 `~/.grok/hooks/crewrouter-helper.json`，凭证仍只在
`~/.config/cr-report.json`，不会写入 JSON。卸载只删除该文件：
```bash
python3 install-grok-hooks.py uninstall
```
全局 Hook 无需项目授权；项目级 `.grok/hooks/` 需要信任，且各层配置会合并。
安装后可在 Grok `/hooks`（或 `Ctrl+L` 的 Hooks 页）确认已加载。

旧版 Grok 或禁用 Hooks 时仍可用 watch 兜底（不要与原生 Hook 同时启用，避免重复上报）：
```bash
nohup ~/.local/bin/cr-report.py watch --harness grok >/dev/null 2>&1 &
```
watch 只旁路推断新会话和 `tool_call`，可能漏事件，不能阻止工具调用；不会默认启动。
状态存 `~/.cache/cr-report-grok-state.json`。

### Hermes / OpenClaw / DeepSeek Harness
直接在会话启动处调用：
```bash
cr-report.py emit --harness hermes --event session_start --session "$SESSION_ID"
```

## 设计约定

- **静默失败**：任何错误（配置缺失、网络失败、JSON 解析失败）都退出 0，
  绝不阻塞客户端工具执行。
- 密钥只存在 `~/.config/cr-report.json` 一处，客户端配置文件里不含密钥。
- 服务端校验 harness 必须是 8 种标准标识之一
  （claude_code / codex / grok / opencode / qwen_code / hermes / openclaw / deepseek_harness）。
