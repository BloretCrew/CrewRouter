# Harness message 上下文读取分析

## 结论

Grok Build 的“第二项 message”通常不是普通用户提问，而是一个由客户端在会话启动时注入的 **synthetic user 元数据消息**。但不能把 `messages[1]` 当成绝对协议：如果项目存在 `AGENTS.md`/规则文件，项目指令也可能被插入为 synthetic user message，从而使用户上下文前缀移动到 `messages[2]`；resume、subagent 和重建路径的插入顺序也可能不同。应读取每一条消息并按内容标记，而不是只读取固定下标。

另外，Grok 的 system prompt 模板本身也可能包含一组环境占位符（尤其是 subagent 模板中的 `<user_info>`），因此“项目路径只在第二项、system 绝不包含环境字段”并不成立。完整分析必须分别记录：消息索引、角色、区块和字段来源。

本仓库现在会在管理员调用详情中增加 `message_analysis`，只根据已保存的 `usage_records.messages` 读取实际出现的字段，不把客户端识别结果当作消息事实。

## Grok Build 的构成来源

源码位置：`grok-build/crates/codegen/xai-grok-shell/src/session/user_message.rs`

调用链：

1. `construct_user_message(...)` 构造首条用户上下文消息。
2. `construct_user_message_minimal(...)` 读取 OS、Shell、工作区路径和本地日期。
3. `compute_vcs_status_block(...)` 读取 Git/JJ 状态，并设置 5 秒超时。
4. `format_vcs_status_block(...)` 写入带说明文字的 `<git_status>` 或 `<jj_status>` 区块。
5. 会话请求把该前缀作为 user-role message 发送，真实问题随后以 `<user_query>` 形式出现。

## 已确认的字段

### `<user_info>`

| 字段 | 读取内容 | 备注 |
|---|---|---|
| `OS Version` | 操作系统值 | 远程 workspace 可覆盖；渲染器也支持 kernel/release 形式 |
| `Shell` | Shell 展示值 | 本地 Unix 默认读取 `$SHELL` |
| `Workspace Path` | 当前工作区路径 | 远程 workspace 使用远端 cwd |
| `Today's date` | 会话启动/压缩时的本地日期 | 日期格式是可观察的 prompt 协议 |
| `Note` | 相对路径建议 | 固定提示语 |

### `<git_status>` / `<jj_status>`

Grok 会在区块前写入说明：

> This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

Git 短状态由 `git status --short --branch --untracked-files=normal` 获取，结果会压缩部分空格，并在渲染时限制到 10,000 字符；获取失败或超时则不写入区块。JJ 使用 `<jj_status>`，没有 Git staging area。

### 其他已在源码中出现的上下文区块

用户消息渲染器还支持 workspace overview、规则文件、技能列表和 MCP 列表；它们是否出现在具体请求中取决于调用方和模板。分析器会标记当前保存消息中实际出现的：

- `project_layout`
- `environment_context`
- `system-reminder`
- `user_info`
- `git_status`
- `jj_status`

## System prompt 与 synthetic user message 的区别

源码追踪得到两条独立链路：

```text
AgentBuilder::build
  -> PromptContext::render
  -> Agent.system_prompt
  -> install_system_prompt
  -> conversation[0] = System(system_prompt)
```

以及：

```text
SessionActor::build_user_message_prefix
  -> construct_user_message
  -> construct_user_message_minimal
  -> compute_vcs_status_block
  -> conversation.insert(1, User(prefix))
```

因此：

- 完整动态 Git 状态主要进入 synthetic user 前缀，而不是 system prompt。
- system prompt 仍可能通过模板占位符注入 OS、Shell、Workspace Path、日期等环境信息。
- `session_env` 主要传递给工具执行上下文，未发现整体序列化到 prompt。
- 默认无项目指令时，常见顺序是 `System -> user_info/git_status -> user_query`。
- 有项目指令时，可能出现 `System -> AGENTS.md reminder -> user_info/git_status`，也可能是 `System -> user_info/git_status -> AGENTS.md reminder`，取决于 spawn、resume 或重建路径。

### 自定义 user-message 模板

Grok 还支持 Custom 模板。模板上下文可以读取：

- `workspace_path`
- `os_family`
- `shell`
- `vcs_root`
- `vcs_status`
- `today_local`
- `terminals_folder`
- workspace/user rules
- skill registry
- MCP server 元数据

所以分析器需要保留逐消息原文和区块索引，不能只依赖 Grok 默认模板的固定字段。

## “读取”与“识别”的边界

- `request_source` 是来源识别标签，仍保留原有逻辑。
- `message_analysis` 是对原始消息正文的结构化读取：消息数量、角色数量、字符/行数、区块位置、区块计数、工作区路径、Shell、OS、日期和 Git/JJ 状态。
- 没有出现的字段标为 `false` 或 `null`。
- 不使用 `<user_info>`/`<git_status>` 去反推一个不存在的字段。
- 原始消息仍然完整保留，分析结果只是详情接口的派生数据。

## 统计口径

单条调用详情的 `message_analysis` 包含：

- `message_count`：消息总数。
- `roles`：system/user/assistant/tool 等角色计数。
- `total_characters`、`total_lines`：所有消息文本的长度。
- `metadata_message_indexes`：包含结构区块且不含 `<user_query>` 的消息索引；典型 Grok 请求会得到 `[1]`。
- `block_counts`：每类 XML 区块在多少条消息中出现。
- `observed_fields`：字段是否实际出现。
- `values`：实际读取的字段值。
- `messages`：逐条消息的索引、角色、长度、区块列表、`user_info` 字段和 Git/JJ 状态。

管理员详情接口：

```text
GET /api/admin/usage-logs/:id
```

返回：

```json
{
  "log": {
    "messages": [],
    "message_analysis": {
      "metadata_message_indexes": [1],
      "values": {
        "workspace_path": "/data/project",
        "os_version": "linux",
        "shell": "/bin/bash"
      }
    }
  }
}
```

前端详情页会把这些字段和区块计数显示在“消息读取统计”区域，再显示完整原始消息。
