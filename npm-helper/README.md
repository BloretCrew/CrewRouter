# crewrouter-helper（@bloret-crew/crewrouter-helper）

CrewRouter 客户端事件统一上报器 —— Node.js 零依赖 CLI，是 Python 版
`cr-report.py` / `cr-login` 的一一对应移植：所有 AI 客户端共用这一个程序。

A unified event reporter for CrewRouter — a zero-dependency Node.js CLI,
a one-to-one port of the Python `cr-report.py` / `cr-login` scripts.

## 安装 / Install

```bash
npm i -g @bloret-crew/crewrouter-helper
# 或免安装直接运行 / or run without installing
npx @bloret-crew/crewrouter-helper test

# 要求 / Requires: Node.js >= 18；零第三方依赖 / zero third-party dependencies
```

## 交互式 TUI

在交互式终端直接运行 `crewrouter-helper`，即可打开菜单：查看连接状态、登录/配置服务、为 Claude Code / Qwen Code / Codex 写入上报 Hook，以及发送测试事件。菜单使用方向键选择、Enter 确认，`q` 或 Esc 返回；同时支持 `j/k` 作为备用导航键。客户端配置会保留已有内容，重复配置不会重复添加 Hook。当前包保持 Node.js 18+ 零依赖设计；OpenTUI 目前要求 Bun 1.3+ 或 Node.js 26.4+ ESM，因此未作为运行时依赖引入。

客户端配置入口会自动写入：Claude Code 的 `~/.claude/settings.json`、Qwen Code 的 `~/.qwen/settings.json`、Codex 的 `~/.codex/config.toml`。非交互环境仍显示原有帮助信息，适合脚本和 Hook 调用。

## 子命令 / Subcommands

| 命令 / Command | 说明 / Description |
| --- | --- |
| `hook --harness <id> [--event <type>]` | 读 stdin 的 Claude 风格 hook JSON，映射后转发 / Read Claude-style hook JSON from stdin and forward it |
| `emit --harness <id> --event <t> [--session <id>] [--tool <n>] [--cwd <dir>]` | 直接发一条事件 / Emit one event directly |
| `watch [--harness grok] [--interval 5]` | 常驻 tail `~/.grok/sessions/**/updates.jsonl` / Tail Grok session updates |
| `login [--url http://127.0.0.1:20003]` | 浏览器 OAuth PKCE 授权 / Browser OAuth PKCE login |
| `logout` | 删除本地凭证 / Remove local credentials |
| `test [--harness hermes]` | 发测试事件验证链路 / Send a test event |
| `--print` | 输出有效 access token（临期自动刷新）/ Print a valid access token (auto-refreshes) |

事件取值 / Events: `session_start`、`session_end`、`tool_use`
harness 取值 / Harness ids: `claude_code` / `codex` / `grok` / `opencode` /
`qwen_code` / `hermes` / `openclaw` / `deepseek_harness`

## 登录与凭证 / Login & credentials

```bash
crewrouter-helper login                                  # 打开官方商店，选择已登录过的 CrewRouter 后授权
crewrouter-helper login --url http://127.0.0.1:20003   # 直接在指定 CrewRouter 授权
crewrouter-helper test                                  # 应输出 HTTP 200 {"ok":true}
crewrouter-helper logout                                # 删除 ~/.config/cr-report.json
```

配置文件 `~/.config/cr-report.json` 兼容两种形态 / The config file supports both shapes:

```jsonc
// OAuth（推荐 / recommended）
{ "url": "http://127.0.0.1:20003", "access_token": "...", "refresh_token": "...", "expires_at": 1234567890.0 }
// 静态 Key（仍兼容 / still supported）
{ "url": "http://127.0.0.1:20003", "key": "cr-sk-..." }
```

凭证优先级 / Credential priority：OAuth access 未过期直用 → 过期前 60s 加独占锁自动刷新 →
回落静态 key。（Valid OAuth access token is used directly; within 60s of expiry it is
refreshed under an exclusive lock file; otherwise falls back to the static key.）

刷新锁为 `~/.cache/cr-report-token.lock`（wx 独占创建 + 自旋重试，最多等 5s）：
并发 hook 同时刷新会导致旧 refresh_token 重放被服务端按重放处理并全链吊销。
(The refresh lock serializes concurrent refreshes — replaying an old refresh token
revokes the whole grant chain server-side.)

## 各客户端接入 / Per-client wiring

### Claude Code（`~/.claude/settings.json`）

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command",
      "command": "crewrouter-helper hook --harness claude_code"}]}],
    "SessionEnd":   [{"hooks": [{"type": "command",
      "command": "crewrouter-helper hook --harness claude_code"}]}],
    "PostToolUse":  [{"hooks": [{"type": "command",
      "command": "crewrouter-helper hook --harness claude_code"}]}]
  }
}
```

事件类型从 stdin 的 `hook_event_name` 自动推断，三段命令完全相同。
(Event type is inferred from `hook_event_name`; all three entries are identical.)

Qwen Code 同理：`~/.qwen/settings.json` 里把 `--harness` 改为 `qwen_code`
（hooks 格式与 Claude 一致）。(Same for Qwen Code with harness id `qwen_code`.)

### Codex（`~/.codex/config.toml`，v0.124+ 需 `codex_hooks = true`）

```toml
[hooks.PostToolUse]
command = "crewrouter-helper hook --harness codex"
```

### Grok（无 hook → watch 模式常驻 / no hooks → resident watcher）

```bash
nohup crewrouter-helper watch --harness grok >/dev/null 2>&1 &
```

tail `~/.grok/sessions/**/updates.jsonl`：新会话目录 → `session_start`，
`tool_call` 行 → `tool_use`；增量偏移存
`~/.cache/cr-report-grok-state.json`，含半行保护。
(New session directories produce session_start; tool_call lines produce tool_use.
Byte offsets persist in the state file with partial-line protection.)

### Hermes / OpenClaw / DeepSeek Harness

会话启动处直接调用 / Call at session start:

```bash
crewrouter-helper emit --harness hermes --event session_start --session "$SESSION_ID"
```

### apiKeyHelper 场景 / For API-key helpers

Claude Code 的 `apiKeyHelper` 可指向 `crewrouter-helper --print`
（stdout 只输出 token，错误走 stderr 且退出非零）。
(Point Claude Code's apiKeyHelper at `--print`: stdout carries only the token;
errors go to stderr with a non-zero exit.)

## 环境变量 / Environment variables

| 变量 / Variable | 作用 / Purpose |
| --- | --- |
| `CREWROUTER_URL` | 覆盖服务端地址（login 缺省也用它）/ Override server base URL |
| `CREWROUTER_KEY` | 提供静态 Key 回落 / Static-key fallback credential |
| `CREWROUTER_CONFIG` | 覆盖配置文件路径 / Config file path override |
| `CR_REPORT_CONFIG` | 同上（兼容 Python 版）/ Same, Python-compatible alias |
| `CREWROUTER_NO_BROWSER=1` | 不拉起浏览器，只打印授权链接 / Print auth URL only |
| `CR_REPORT_NO_BROWSER=1` | 同上（兼容 Python 版）/ Same, Python-compatible alias |

## 设计约定 / Design notes

- **静默失败 / Silent failure**：hook 模式任何错误（配置缺失、网络失败、JSON 解析失败）
  都静默退出 0，绝不阻塞客户端工具执行。(In hook mode every failure exits 0 silently.)
- 密钥只存 `~/.config/cr-report.json` 一处且权限 600，客户端配置文件里不含密钥。
  (Credentials live in one 600-permission file; client configs hold no secrets.)
- 与服务端的契约：`POST /api/client-events`、`POST /oauth/token`、`GET /oauth/authorize`。
  (Server contract: the three endpoints above.)

## License

GNU General Public License v3.0 only (GPL-3.0-only)
