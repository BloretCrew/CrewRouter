# CrewRouterHelper

零依赖 npm CLI，用于将 Grok/Claude 风格 Hooks 事件安全上报到 CrewRouter，并检查 Grok Hook 安置状态。Python `cr-report.py` 仍保留为兼容入口。

## 推荐流程（Task 9）

```bash
npm install -g crewrouter-helper
cr-report login --url https://your-router.example
cr-report setup --verify --yes
cr-report heartbeat --json
cr-report test --harness grok
cr-report remote test --event SessionStart,PostToolUse,Stop
cr-report doctor --json
```

推荐先执行只读的 `setup --dry-run`、`doctor` 和 `heartbeat`，确认路径、权限、凭证及 Router 可达后，再使用带 `--yes` 的写操作。生产环境只应使用正式 Router URL；本地验收可使用 localhost，不会自动执行服务端 DDL。

## 安装与使用

`login` 使用 PKCE 浏览器授权；凭证写入 `~/.config/cr-report.json` 并设置为 600。也兼容旧版配置中的 `key` 字段。`logout` 只删除本地凭证。

```bash
cr-report hooks install
cr-report status
cr-report test --harness grok
```

## Grok Hooks

`hooks install` 仅原子写入 `~/.grok/hooks/crewrouter-helper.json`，不会修改 `orca-status.json`、`bark-notify.json` 或其他 Hook，也不会将密钥写入 Hook JSON。卸载使用 `cr-report hooks uninstall`，重复安装和卸载均幂等。

支持 `hookEventName`/`hook_event_name`、`sessionId`/`session_id`、`toolName`/`tool_name`、`toolInput`/`tool_input`、`cwd`/`workspaceRoot`，以及 SessionStart、SessionEnd、PreToolUse、PostToolUse、PostToolUseFailure、PermissionDenied、Stop、StopFailure、Notification、SubagentStart、SubagentStop、PreCompact、PostCompact。未知事件跳过且退出 0；网络和配置异常 fail-open。

## Doctor、Repair、备份与迁移

`doctor` 始终只读；`repair` 和兼容的 `doctor --fix` 默认 dry-run，实际修复必须显式 `--yes`。修复只处理 Helper 自己的 Hook 和权限，并在写入前备份。

```bash
cr-report doctor --json
cr-report repair --dry-run
cr-report repair --yes --json
cr-report backup list
cr-report backup create --yes
cr-report backup restore BACKUP_ID --yes
cr-report migrate --dry-run
cr-report migrate --yes
cr-report rollback BACKUP_ID --yes
```

迁移会把旧单配置/profile 和旧 Python Hook 路径转换为当前 CLI；写入前创建受控备份，恢复前校验 manifest、允许文件路径和 SHA-256，失败时回滚并显式报错。`backup` 与 `rollback` 统一使用迁移备份目录；`rollback` 仅恢复 Helper 自己创建且经过路径校验的备份。以上命令均不连接数据库、不执行生产 DDL。

## 失败队列与幂等

上报失败会写入用户缓存目录中的脱敏 JSONL 失败队列，Hook 不等待重试且始终 fail-open。可用 `queue inspect` 查看、`queue retry --id ID` 或 `queue retry --all` 重试，超过上限进入死信；清理和死信操作需要 `--yes`。事件携带稳定 `event_id` 时，服务端按 user、harness 和 event_id 去重，重复请求返回 `duplicate: true`，因此重试不会重复通知；旧客户端没有 event_id 时仍保持兼容。

```bash
cr-report queue inspect --json
cr-report queue retry --all
cr-report queue dead-letter --yes
cr-report queue prune --yes
```

## 客户端兼容矩阵

| 客户端 | 探测/展示 | Helper 自动安装 | 配置方式 |
|---|---:|---:|---|
| Grok Build | 支持 | 支持 | `clients setup grok --yes` 或 `hooks install` |
| Claude Code | 支持 | 不自动修改 | 手动配置 `cr-report hook --harness claude` |
| Qwen Code | 支持 | 不自动修改 | 手动配置 `cr-report hook --harness qwen` |
| Codex | 支持 | 不自动修改 | 使用既有 `codex-cr`/手动集成 |

`clients compatibility --verbose`、`clients list --verbose` 和 `compatibility` 只读输出版本、协议、事件 schema 及安装计划，不显示凭证。非 Grok 客户端仅探测和给出手动步骤。

## status / heartbeat / TUI / remote

`status` 是只读扫描；`heartbeat --json` 汇总本地 CLI、Hook、配置以及可选远程 URL、DNS、TCP/TLS、HTTP、认证和事件权限检查；`tui` 提供零依赖终端展示。`remote status|capabilities|recent-events` 只显示脱敏摘要，`remote test --event a,b,c` 发送有限的远程测试事件；请求带有服务端识别的测试标记，不进入正常通知链，并只报告状态。

## Python 兼容入口

原有 `cr-report.py`、`install-grok-hooks.py`、`cr-login` 和 `codex-cr` 保留。Python 入口适用于既有 Claude/Qwen/Codex/Hermes/OpenClaw 集成；npm CLI 是新的主入口。

Python 事件上报保留客户端会话身份：Hook 从 `session_id`/`sessionId`（兼容 `conversation_id`、`thread_id`）读取，并透传 `parent_session_id`、`subagent_id`、`cwd`/`workspaceRoot` 和项目字段；Hermes/OpenClaw 等 emit 集成可使用 `--parent-session`、`--subagent`、`--project`。没有明确 session id 时服务端将事件标为 unknown，不会并入最近会话。

## 测试与未验证外部环境

本包测试分为：Helper Node 单元测试（`node --test test/*.test.js`）、根目录静态契约测试、CLI 命令验收和 JavaScript 语法检查。远程 Router 的真实 OAuth、网络、TLS、数据库连接、Hook 宿主实际回调，以及生产部署环境未在本地验收中验证；需要在目标环境使用脱敏凭证和非生产数据单独验证。

```bash
cd CrewRouterHelper && npm test
npm pack --dry-run
```

本包不包含依赖、缓存、临时文件或凭证；项目不会自动 publish 或 push。
