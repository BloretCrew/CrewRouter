# client-hooks —— CrewRouter 客户端事件上报

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

### Grok（无 hook → watch 模式常驻）
```bash
nohup ~/.local/bin/cr-report.py watch --harness grok >/dev/null 2>&1 &
```
tail `~/.grok/sessions/**/updates.jsonl`：新会话目录 → session_start，
tool_call 行 → tool_use。状态存 `~/.cache/cr-report-grok-state.json`。

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
