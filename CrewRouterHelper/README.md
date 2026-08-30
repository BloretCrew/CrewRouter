# CrewRouterHelper

零依赖 npm CLI，用于将 Grok/Claude 风格 Hooks 事件安全上报到 CrewRouter，并检查 Grok Hook 安置状态。Python `cr-report.py` 仍保留为兼容入口。

## 安装与使用

```bash
npm install -g crewrouter-helper
cr-report login --url http://127.0.0.1:20003
cr-report hooks install
cr-report status
cr-report test --harness grok
```

`login` 使用 PKCE 浏览器授权；凭证写入 `~/.config/cr-report.json` 并设置为 600。也兼容旧版配置中的 `key` 字段。`logout` 只删除本地凭证。

## Grok Hooks

`hooks install` 仅原子写入 `~/.grok/hooks/crewrouter-helper.json`，不会修改 `orca-status.json`、`bark-notify.json` 或任何其他 Hook，也不会将密钥写入 Hook JSON。卸载使用 `cr-report hooks uninstall`，重复安装和卸载均幂等。

Hook 命令通过当前 npm CLI 的可靠绝对路径执行，并原样读取 stdin：

```bash
printf '%s\n' '{"hookEventName":"PostToolUse","sessionId":"demo","toolName":"Bash"}' | cr-report hook --harness grok
cr-report emit --harness hermes --event session_start --session demo
```

支持 `hookEventName`/`hook_event_name`、`sessionId`/`session_id`、`toolName`/`tool_name`、`toolInput`/`tool_input`、`cwd`/`workspaceRoot`，以及 SessionStart、SessionEnd、PreToolUse、PostToolUse、PostToolUseFailure、PermissionDenied、Stop、StopFailure、Notification、SubagentStart、SubagentStop、PreCompact、PostCompact。未知事件跳过且退出 0；网络和配置异常 fail-open。

## status / tui / watch

`status` 是只读非交互扫描，`tui` 提供零依赖终端展示：Hook 文件有效性、事件列表、CLI 可执行性、凭证是否配置/临期、服务端地址、旧 watch 兼容状态和检查时间。不会显示 token/API key。旧 Python `watch` 仍可用，但不要与原生 Grok Hook 同时运行，以免重复上报。

## Python 兼容入口

原有 `cr-report.py`、`install-grok-hooks.py`、`cr-login` 和 `codex-cr` 保留。Python 入口适用于既有 Claude/Qwen/Codex/Hermes/OpenClaw 集成；npm CLI 是新的主入口。

## 开发检查

```bash
npm test
npm pack --dry-run
```

本包不包含依赖、缓存、临时文件或凭证；项目不会自动 publish 或 push。
