# 七种 Harness 的 Message / Prompt 构成深度对比

> 本文基于仓库内源码读取，不是通过请求内容猜测客户端身份。重点记录：信息从哪里读取、进入哪个载体、消息顺序、是否动态、缓存/增量策略，以及最终 provider 请求与内部 transcript 的差异。
>
> 分析对象：
>
> - `claude-code-source-code/`
> - `codex/`
> - `grok-build/`
> - `opencode/`
> - `qwen-code/`
> - `hermes-agent/`
> - `openclaw/`

## 1. 先区分四种载体

不同 harness 对“message”的含义并不相同。不能只看一个 `messages[]` 数组：

| 载体 | 典型内容 | 是否一定属于模型 messages |
|---|---|---:|
| 顶层 system / instructions | 身份、行为规则、环境、项目规则、Git snapshot | 不一定；Codex 普通 Responses API 的 `instructions` 在顶层 |
| chronological messages / contents / input | user、assistant、tool、tool_result、上下文 reminder | 通常是 |
| tools | 工具名称、描述、schema、MCP 工具 | 不是 message |
| SDK/session metadata | cwd、session_id、工具名、MCP server 状态、agent 信息 | 通常不是模型 prompt |

跨 harness 对比时，必须同时读取：

```text
system / instructions
messages / input / contents
roles / synthetic tags
tools
session metadata
```

## 2. 总体对比表

| Harness | 主要模型协议载体 | 环境信息 | Git 信息 | 项目规则 | MCP / 工具 | 动态策略 |
|---|---|---|---|---|---|---|
| Claude Code | Anthropic `system` + `messages` | system 动态 Environment section | systemContext 尾部，通常会话快照 | `isMeta=true` 的 synthetic user message | MCP tools 进 `tools`；instructions 进 system 或 delta attachment | 多层 memoize、compact、tool search、cache |
| Codex | Responses API `instructions` + `input` + `tools` | `environment_context` 通常是 input user contextual fragment | 通常不自动注入完整 Git status；由工具实时读取 | `AGENTS.md` 是 contextual user message | tools 由 ToolRouter 动态生成 | `ContextManager` 保存 baseline，后续只注入 world-state diff |
| Grok Build | system prompt + synthetic `ConversationItem` | system 和 synthetic user 都可能有环境字段 | 默认首个 user prefix 中的 `<git_status>` 快照 | `ProjectInstructions` synthetic user item | 原生工具、MCP meta-tools、skills reminder | prefix、skill reminder、task reminder、compaction、resume/fork |
| OpenCode | AI SDK `system[]` + `ModelMessage[]`，Native 有 `LLMRequest.system/messages` | system `<env>` | `<env>` 只判断是否 Git repo；实际 status 不进 system prompt | system instructions 字符串 | MCP instructions 进 system；MCP tools 进 tools | session history 持久化，system/tools 按变化重建 |
| Qwen Code | Gemini `systemInstruction` + `contents` + `config.tools` | startup user reminder 中的 environment context | systemInstruction 的 Git snapshot | QWEN/AGENTS/rules 进入 systemInstruction | MCP instructions/user reminder、deferred metadata、tools schema 分离 | 启动前缀稳定，后续 reminder 增量追加 |
| Hermes Agent | OpenAI-style `messages` + `tools`，部分 transport 再拆 system | system prompt environment hints / coding snapshot | coding workspace snapshot 中包含 branch/status/log | system prompt context files | 主要进 tools；MCP 刷新受 prompt cache 约束 | system prompt SessionDB 缓存，request-only context 不污染缓存 |
| OpenClaw | `systemPrompt` + `messages` + `tools`；SDK/worker 有独立链路 | system prompt runtime/sandbox/workspace sections | 主 prompt 通常只显示 repoRoot，不自动注入 status | bootstrap/context files 进入 system prompt | MCP 主要 materialize 成 tools | stable/dynamic prompt 分区、workspace/cwd/sandbox 分离 |

## 3. Claude Code

### 3.1 主调用链

```text
QueryEngine.submitMessage
  -> fetchSystemPromptParts
     -> getSystemPrompt
     -> getUserContext
     -> getSystemContext
  -> processUserInput
  -> prependUserContext
  -> query
  -> queryModelWithStreaming
  -> Anthropic messages.create
```

核心源码：

- `claude-code-source-code/src/QueryEngine.ts`
- `src/utils/queryContext.ts`
- `src/utils/api.ts`
- `src/query.ts`
- `src/services/api/claude.ts`
- `src/context.ts`
- `src/constants/prompts.ts`

### 3.2 最终结构

Claude Code 使用 Anthropic 风格：

```text
system: TextBlockParam[]
messages: MessageParam[]
tools: Tool[]
```

没有发现独立的 API `developer` role。典型结构：

```text
system
  1. attribution / CLI prefix
  2. 默认静态 Claude Code prompt
  3. Environment section
  4. memory / dynamic sections
  5. MCP server instructions
  6. append system prompt
  7. systemContext
     - gitStatus
     - cacheBreaker

messages
  0. user / isMeta=true / <system-reminder>
     - claudeMd
     - currentDate
  1. 历史 user/assistant/tool_result
  2. 当前 user message

tools
  - 内置工具
  - MCP 工具
  - deferred tool / tool search 工具
```

### 3.3 实际读取字段

#### Environment

`computeEnvInfo()` / `computeSimpleEnvInfo()` 读取并注入：

- Primary working directory
- 是否 Git repository
- additional working directories
- platform
- shell
- OS version
- model / model ID
- worktree 信息

#### Git

`getGitStatus()` 读取：

```text
git status --short
git log --oneline -n 5
git branch/default branch
user.name
```

结果写入：

```text
systemContext.gitStatus
  -> appendSystemContext
  -> system prompt 最后部分
```

特点：

- 会话开始快照；
- memoize；
- 超过约 2000 字符会截断；
- 提示模型必要时自行执行 Git。

#### CLAUDE.md / rules

发现来源：

- managed memory
- `~/.claude/CLAUDE.md`
- `~/.claude/rules/*.md`
- 项目目录链上的 `CLAUDE.md`
- `.claude/rules/*.md`
- `CLAUDE.local.md`
- `--add-dir` 目录

最终主要变成：

```text
messages[0] = user, isMeta=true
<system-reminder>
...
# claudeMd
...
# currentDate
...
</system-reminder>
```

这不是顶层 system 的普通字符串。

#### MCP

MCP 信息分开：

```text
MCP tool schema
  -> request.tools

MCP server instructions
  -> system prompt 的 mcp_instructions section
  或 MCP delta attachment

SDK system/init
  -> mcp_servers、tools 名称、agents、skills 等元数据
```

### 3.4 动态性

| 内容 | 动态行为 |
|---|---|
| cwd | 每轮 `setCwd` |
| Git status | 会话快照，memoize |
| CLAUDE.md | `getUserContext()` 缓存，reset/compact 时可能重建 |
| MCP connection/tools | 可重连、deferred tool、delta 更新 |
| current date | 通过 attachment 处理日期变化 |
| 压缩 | 可能丢弃旧消息并重新组装 system/context |

## 4. Codex

### 4.1 主调用链

```text
Session::run_turn
  -> capture_step_context_with_required_mcp_servers
  -> build_world_state_for_step
  -> record_context_updates_and_set_reference_context_item
  -> ContextManager.clone_history().for_prompt
  -> build_prompt
  -> ModelClient::build_responses_request
```

核心源码：

- `codex/codex-rs/core/src/session/turn.rs`
- `core/src/session/mod.rs`
- `core/src/session/world_state.rs`
- `core/src/context/world_state/`
- `core/src/client.rs`
- `core/src/agents_md_manager.rs`
- `core/src/agents_md.rs`

### 4.2 普通 Responses API 的载体

Codex 最关键的区别是：

```text
base_instructions -> Responses API 顶层 instructions
world state / AGENTS / user input -> input
tools -> tools
```

典型 input：

```text
input[0]  developer message：聚合 developer instructions
input[1]  developer message：权限/模型/插件等，可选
input[2]  user message：AGENTS.md + environment_context 等 contextual user fragments
input[3]  user message：实际用户输入
input[4+] tool call/output/reasoning/compaction
```

Responses Lite 是例外：

```text
input[0] AdditionalTools(developer)
input[1] Message(developer, base_instructions)
input[2...] 原始 input
```

### 4.3 `environment_context`

配置：

```toml
include_environment_context = true
```

默认开启。

字段可能包括：

- cwd
- shell
- current_date
- timezone
- environment id
- environment readiness/status
- workspace roots
- permission profile
- network policy
- selected capability roots
- subagents
- remote environment 状态

构造链：

```text
capture_step_context...
  -> EnvironmentsState::from_turn_context_with_environments
  -> build_world_state_for_step
  -> render_full / render_diff
  -> contextual user fragment
```

### 4.4 AGENTS.md

搜索从当前环境 cwd 开始，通常以 `.git` 为 project root marker：

```text
AGENTS.override.md
AGENTS.md
其他 project_doc_fallback_filenames
```

从 project root 到 cwd 拼接，受 `project_doc_max_bytes` 总预算限制，默认约 32 KiB。

包装形式类似：

```text
# AGENTS.md instructions for <cwd>

<INSTRUCTIONS>
...
</INSTRUCTIONS>
```

随后进入 `AgentsMdState`，通常按 contextual user fragment 进入 input。

### 4.5 动态性

Codex 使用 world-state baseline：

```text
首次：完整 environment/world state
后续：只追加 world-state diff
```

因此 Codex 不是每次重新构造一个完整 messages 数组，而是由 `ContextManager` 持续维护 `ResponseItem` history。

工具集合由 `ToolRouter.model_visible_specs()` 依据：

- model capabilities
- environment readiness
- permissions
- MCP/plugin/app 状态
- feature flags
- code mode

动态决定。

## 5. Grok Build

### 5.1 两条主要链

#### system prompt

```text
AgentBuilder::build
  -> PromptContext
  -> PromptContext::render
  -> Agent.system_prompt
  -> install_system_prompt
  -> conversation[0] = System
```

#### synthetic user prefix

```text
SessionActor::build_user_message_prefix
  -> construct_user_message
  -> construct_user_message_minimal
  -> compute_vcs_status_block
  -> git_status_short / jj_status
  -> conversation.insert(1, User(prefix))
```

核心源码：

- `grok-build/crates/codegen/xai-grok-agent/src/prompt/context.rs`
- `xai-grok-agent/src/prompt/user_message.rs`
- `xai-grok-shell/src/session/user_message.rs`
- `xai-grok-shell/src/session/acp_session_impl/prompt_build.rs`
- `xai-grok-shell/src/session/acp_session_impl/spawn.rs`
- `xai-grok-shell/src/session/acp_session_impl/session_setup.rs`

### 5.2 Default 主会话

常见顺序：

```text
[0] System
    完整 Grok Build system prompt

[1] UserMeta
    <user_info>
    OS Version
    Shell
    Workspace Path
    Today's date
    Note
    </user_info>

    <git_status> ... </git_status>  可选

[2] ProjectInstructions  可选
    AGENTS.md / Claude.md / rules

[3] SystemReminder  可选
    skill / task / monitor / memory 等

[4] User
    <user_query>真实请求</user_query>
```

但不能固定假设 `messages[1]`：

- 有 `AGENTS.md` 时 project instructions 可能占据 index 1；
- resume/fork/subagent/compaction 可能改变顺序；
- system prompt 的 subagent 模板也可能包含 `<user_info>`；
- 必须按消息内容和 `SyntheticReason` 读取。

### 5.3 Grok 默认字段

`<user_info>`：

- OS Version
- Shell
- Workspace Path
- Today's date
- 相对路径提示

`<git_status>`：

```text
git status --short --branch --untracked-files=normal
```

约束：

- 5 秒 timeout
- stdout 达到 1 MiB 时丢弃
- render 最大 10,000 字符
- 快照在会话开始时生成
- 非 Git 或失败时不生成区块

### 5.4 Custom user-message template

可渲染字段：

- workspace_path
- os_family
- shell
- vcs_root
- vcs_status
- today_local
- terminals_folder
- workspace_rules
- user_rules
- skills
- mcp_servers
- mcps_root
- read_tool_name

### 5.5 Grok 的 synthetic message 类型

| SyntheticReason | 用途 |
|---|---|
| `CompactionMeta` | user-info、summary carrier |
| `ProjectInstructions` | AGENTS/项目规则 |
| `SystemReminder` | skills、task、monitor、memory 等 |
| `Interjection` | 工作中用户插话 |
| `AutoContinue` | 自动继续 |

compaction 后会重新组装为：

```text
System
UserMeta(prefix)
ProjectInstructions?
User(last query)
recent messages
UserMeta(summary)
SystemReminder?
```

## 6. OpenCode

### 6.1 普通 AI SDK 路径

主链：

```text
SessionPrompt.runLoop
  -> SessionTools.resolve
  -> SystemPrompt.environment
  -> Instruction.system
  -> SystemPrompt.mcp
  -> SystemPrompt.skills
  -> MessageV2.toModelMessagesEffect
  -> LLMRequestPrep.prepare
  -> streamText
```

核心源码：

- `opencode/packages/opencode/src/session/prompt.ts`
- `src/session/system.ts`
- `src/session/instruction.ts`
- `src/session/llm/request.ts`
- `src/session/llm/native-request.ts`
- `src/project/instance-store.ts`
- `src/project/vcs.ts`

### 6.2 system 顺序

在进入 LLM 层前：

```text
1. environment
2. project/global instructions
3. MCP instructions
4. skills
5. structured output prompt，可选
```

随后 `LLMRequestPrep.prepare()` 加入：

```text
agent.prompt
或 provider default prompt
+ 上述 system sections
+ user.system
```

普通 AI SDK provider 通常最终得到：

```text
{ role: "system", content: "agent/provider + <env> + instructions + MCP + skills" }
...history messages
```

OpenAI OAuth / Workflow 可能改用 provider options 的 `instructions`，而不是前置 system message。

### 6.3 `<env>` 字段

```text
Working directory: ctx.directory
Workspace root folder: ctx.worktree
Is directory a git repo: yes/no
Platform: process.platform
Today's date: new Date().toDateString()
model name / providerID
```

OpenCode 的 `<env>` **不读取完整 Git status**，只判断项目是否 Git 仓库。

完整 Git status 由 `Vcs.status()` 提供给 UI/VCS/snapshot/diff 等路径，不自动进入 prompt。

### 6.4 项目规则

全局：

- `$OPENCODE_CONFIG/AGENTS.md`
- `~/.claude/CLAUDE.md`

项目级优先级：

```text
AGENTS.md
  > CLAUDE.md
    > CONTEXT.md
```

找到某一类文件后，不继续叠加低优先级文件名。规则包装为：

```text
Instructions from: /absolute/path
<file contents>
```

此外支持 `config.instructions` 指定本地路径、glob、HTTP URL。

### 6.5 MCP 与 tools

```text
MCP server instructions
  -> <mcp_instructions> system block

MCP tool schemas
  -> SessionTools.resolve
  -> request.tools

权限
  -> agent.permission + session.permission
  -> tool visibility / execution-time ask
```

MCP 的 root directory 使用 `InstanceState.directory`，不一定等于 worktree 根。

## 7. Qwen Code

### 7.1 最终协议形态

```text
GenerateContentRequest
├── config.systemInstruction
├── config.tools
└── contents
```

常见结构：

```text
systemInstruction
  1. core/custom base prompt
  2. QWEN.md / AGENTS.md / QWEN.local.md / baseline rules
  3. append prompt
  4. Git snapshot
  5. managed auto-memory

contents[0] user
  Part 0: MCP server instructions
  Part 1: available_skills
  Part 2: cwd/date/OS/folder structure
  Part 3: deferred tools metadata

contents[1...] resumed history / user / tool response / reminders
```

### 7.2 环境 reminder

`getEnvironmentContext()` 读取：

- 当前日期
- `process.platform`
- 工作目录列表
- 目录结构

格式为：

```xml
<system-reminder>
This is the Qwen Code...
Today's date is ...
My operating system is: ...
I'm currently working in ...
...
</system-reminder>
```

它不在 systemInstruction，而是启动 `contents[0]` 的 user parts。

### 7.3 Git snapshot

`getRecentGitStatus(config.getCwd())`：

```text
git --no-optional-locks status --short --branch
git --no-optional-locks log --oneline -n 5
```

注入 systemInstruction 的 Git layer：

```text
Git snapshot at conversation start...
Current branch
Status
Recent commits
```

特点：

- 每个 GeminiClient 缓存一次；
- `/cd` 变更目录时清缓存并重建；
- system 明确要求模型必要时执行实时 Git。

### 7.4 规则和条件规则

启动 systemInstruction：

- QWEN.md
- AGENTS.md
- QWEN.local.md
- `.qwen/rules/` 中无 `paths` 的 baseline rules
- append prompt

按需注入：

- `.qwen/rules/` 中带 `paths` 的 conditional rules
- 文件访问匹配后，通过 tool result 之后的 `<system-reminder>` 注入
- 每条规则通常只注入一次

### 7.5 MCP / skills

MCP server instructions：

```text
contents[0].parts[0] = user system-reminder
```

MCP tool declarations：

```text
config.tools.functionDeclarations
```

deferred MCP tools：

```text
contents[0].parts[3] = metadata reminder
```

available skills：

```text
contents[0].parts[1] = <available_skills> reminder
```

启动后 skill/MCP/agent 变化会追加新的 user system-reminder，不修改稳定 system 前缀。

## 8. Hermes Agent

### 8.1 主链

```text
AIAgent.run_conversation
  -> build_turn_context
  -> restore/build system prompt
  -> conversation history + current user
  -> api_messages copy
  -> ephemeral/prefill/context-engine injection
  -> provider adapter
```

核心源码：

- `hermes-agent/agent/conversation_loop.py`
- `agent/turn_context.py`
- `agent/system_prompt.py`
- `agent/prompt_builder.py`
- `agent/coding_context.py`
- `agent/chat_completion_helpers.py`

### 8.2 system prompt 分层

`build_system_prompt_parts()` 返回：

```text
stable
  1. SOUL.md / default identity
  2. Hermes help / task / tool guidance
  3. environment hints
  4. coding operating brief

context
  5. coding workspace snapshot
  6. coding operator instructions
  7. Python environment probe
  8. active profile / platform / caller system message
  9. project context files

volatile
  10. skills index
  11. built-in memory
  12. USER profile
  13. external memory
  14. date/session/model/provider/platform identity
```

最终：

```text
stable + context + volatile
```

### 8.3 environment / cwd

本地：

```text
Host
User home directory
Current working directory
```

远程 backend：

```text
backend OS
backend kernel
backend HOME
backend pwd
backend user
```

远程信息由与 terminal 工具相同的 backend probe 读取，避免把 Hermes 主机路径错误展示给模型。

### 8.4 coding workspace snapshot

当 coding posture 开启时，读取：

```text
git status --porcelain=2 --branch
git rev-parse --git-dir
git rev-parse --git-common-dir
git log -3 --pretty=%h %s
```

注入字段：

- Root
- Branch
- Worktree
- staged
- modified
- untracked
- conflicts
- recent commits
- project facts
- package manager
- verify commands
- context files

它是 session start snapshot，放在 system prompt context tier，不会每轮执行 Git。

### 8.5 项目上下文

`build_context_files_prompt()` 支持并按优先级选择：

```text
.hermes.md / HERMES.md
AGENTS.md
CLAUDE.md
.cursorrules / .cursor/rules/*.mdc
```

AGENTS.md 会按照 git root 到 cwd 的目录链合并；更深层目录更具体。

### 8.6 API 边界

逻辑 transcript 与 provider payload 分离：

```text
cached system prompt
+ ephemeral system prompt
-> api_messages[0]

prefill messages
-> system 后、history 前

external recall / plugin pre_llm_call
-> 当前 user API message
```

MCP 主要进入 `tools` 字段；`ephemeral_system_prompt` 不写入 SessionDB 缓存。

## 9. OpenClaw

### 9.1 两条 Prompt 链

#### 主 Embedded Agent Runtime

```text
runEmbeddedAttempt
  -> prepare skills
  -> prepare bootstrap
  -> bundle core/MCP/LSP tools
  -> prepare tool catalog
  -> prepare system prompt
  -> AgentSession
  -> provider {systemPrompt, messages, tools}
```

#### Session SDK / Worker

```text
DefaultResourceLoader
  -> project context / skills / prompt
  -> AgentSessionBase.rebuildSystemPrompt
  -> buildSystemPrompt
  -> worker inference context
```

两条链并不完全相同，尤其 Worker 会关闭 ambient extensions、skills、prompt templates 和自动 context discovery。

### 9.2 workspace / cwd / sandbox

OpenClaw 有意区分：

```text
workspaceDir = agent identity/context/bootstrap 根
cwd = task/runtime 执行目录
```

sandbox 开启后：

- effectiveWorkspace 可能映射到 sandbox workspace
- effectiveCwd 通常被限制到 sandbox workspace
- 不一致 cwd override 可能 fail-closed
- bootstrap、MCP、LSP、system prompt、工具执行分别使用明确的 workspace/cwd 变量

### 9.3 Bootstrap 文件

主 Embedded Runtime 默认读取：

```text
AGENTS.md
SOUL.md
IDENTITY.md
USER.md
BOOTSTRAP.md
MEMORY.md
```

顺序固定。根据 sessionKey、chatType、contextInjection 模式、bootstrap 是否已完成、hook override 和字符预算过滤。

Worker runtime 只显式注入 workspace 根 `AGENTS.md`，并关闭：

- ambient extensions
- skills
- prompt templates
- themes
- 自动 context files

### 9.4 system prompt 顺序

普通 full prompt 大致为：

```text
1. agent identity
2. model/runtime identity
3. tools/capabilities
4. workflow guidance
5. owner / identity guidance
6. time/date/timezone
7. workspace path/guidance
8. cwd/repo facts
9. docs/source references
10. sandbox section
11. bootstrap/context files
12. skills
13. memory/project memory
14. watched sessions
15. provider contribution
16. extra prompt
17. truncation/warning notices
```

主 prompt 通常只注入 `repoRoot` 身份，不自动注入：

- branch
- dirty/clean
- git diff
- staged files
- recent commits

模型被要求通过工具实时检查 Git。

### 9.5 MCP / tools

```text
MCP config
  -> session-scoped MCP runtime
  -> connect/list tools/resources/prompts
  -> materialize MCP tools
  -> final effective tool policy
  -> AgentSession.state.tools
  -> provider tools
```

MCP 通常不作为 system prompt 文本，而是工具 schema；sandbox、tool allowlist、requester scope 和 permission 会影响可见性。

### 9.6 skills

主 Embedded Runtime 使用 workspace skill snapshot：

- workspace/managed/bundled/plugin/remote node skills
- eligibility/filter/version
- sandbox skill directory
- restricted tool run 可能降级到 minimal prompt

最终通过 `skillsSnapshot.prompt` 进入 system prompt。

## 10. 七种 Harness 的关键差异

### 10.1 Git 注入策略

| Harness | Prompt 是否自动包含完整 Git status |
|---|---:|
| Claude Code | 是，systemContext 快照 |
| Codex | 通常不是完整 status；环境/权限 context 与工具实时读取更重要 |
| Grok Build | 是，默认 synthetic user `<git_status>` |
| OpenCode | 否，只在 `<env>` 判断是否 Git repo |
| Qwen Code | 是，systemInstruction Git snapshot |
| Hermes Agent | 是，coding workspace snapshot |
| OpenClaw | 通常否，只显示 repoRoot；鼓励工具实时检查 |

### 10.2 项目规则载体

| Harness | 主要载体 |
|---|---|
| Claude Code | synthetic user `isMeta` reminder |
| Codex | contextual user fragment / input message |
| Grok Build | ProjectInstructions synthetic user item；custom/system context 也可能出现 |
| OpenCode | system instructions 字符串 |
| Qwen Code | systemInstruction，conditional rules 走 user reminder |
| Hermes Agent | system prompt context tier |
| OpenClaw | bootstrap/context system prompt，Worker 受限 |

### 10.3 工具/MCP 载体

| Harness | 工具 schema | MCP instructions |
|---|---|---|
| Claude Code | tools | system / delta attachment |
| Codex | top-level tools | world-state/developer/user context + tool schema |
| Grok Build | tools / meta-tools | custom user context 的 server metadata + tools |
| OpenCode | tools | system `<mcp_instructions>` |
| Qwen Code | `config.tools` | startup user reminder |
| Hermes Agent | tools | 主要不进 system |
| OpenClaw | tools | 主要 materialize 成 tools |

### 10.4 缓存边界

| Harness | 缓存/增量核心 |
|---|---|
| Claude Code | system/context memoize、prompt cache、compact |
| Codex | ContextManager world-state baseline + diff |
| Grok Build | synthetic prefix、skill/task reminder、compaction/rebuild |
| OpenCode | session history + system/tools change detection |
| Qwen Code | stable system prefix + startup history + reminder append |
| Hermes Agent | stable/context/volatile + SessionDB system prompt |
| OpenClaw | stable/dynamic prompt input hash + session resource loader |

## 11. 对当前消息分析器的影响

现有 `server/utils/message-analysis.js` 主要识别 XML 区块，适合 Grok、Codex、Qwen、OpenClaw 等部分结构，但跨七种 harness 需要补充以下读取维度：

### 11.1 顶层字段

除了 `messages`，应读取并标记：

```text
system
instructions
input
contents
tools
metadata
```

### 11.2 角色和载体

每条读取结果需要记录：

```text
transport: system | instructions | messages | input | contents | tools | metadata
role: system | developer | user | assistant | tool
synthetic/meta: true/false/unknown
```

### 11.3 非 XML 结构

新增结构标记：

- Claude Code：`isMeta`、`claudeMd`、`currentDate`、`gitStatus`
- Codex：`environment_context`、`AGENTS.md instructions`、`developer_instructions`、`instructions` 顶层字段
- OpenCode：`<env>`、`Instructions from:`、`<mcp_instructions>`、`skills`
- Qwen：`<available_skills>`、`<system-reminder>`、Git snapshot layer
- Hermes：`Workspace (snapshot at session start)`、`Current working directory`、`Root/Branch/Status/Recent commits`
- OpenClaw：`<project_context>`、sandbox/runtime sections、`repo=`、bootstrap files

### 11.4 “识别”与“读取”必须分离

来源识别：

```text
request_source = grok / codex / ...
```

内容读取：

```text
实际出现了哪些字段、在哪个载体、哪个索引、哪个动态区块
```

不能因为 `request_source=grok` 就假设存在 `<git_status>`；也不能因为存在 `<env>` 就推断一定是 OpenCode。应当同时输出：

```text
observed: true/false
source: raw-message | top-level-system | tool-schema | metadata
confidence: actual-read
```

## 12. 推荐的统一分析模型

后续可将每条请求规范化为：

```json
{
  "harness": "grok",
  "transport": {
    "system": [],
    "instructions": null,
    "messages": [],
    "input": null,
    "contents": null,
    "tools": []
  },
  "observations": [
    {
      "kind": "workspace_path",
      "value": "/workspace/project",
      "carrier": "messages",
      "index": 1,
      "role": "user",
      "synthetic": true,
      "actual_read": true
    },
    {
      "kind": "git_status",
      "value": "...",
      "carrier": "messages",
      "index": 1,
      "role": "user",
      "synthetic": true,
      "actual_read": true
    }
  ],
  "statistics": {
    "message_count": 5,
    "system_characters": 12000,
    "input_characters": 42000,
    "tool_count": 18,
    "mcp_tool_count": 4,
    "synthetic_message_count": 2
  }
}
```

这个模型可以避免把不同协议硬塞进 OpenAI `messages[]` 的单一假设。

## 13. 当前已确认的最重要结论

1. **Claude Code、Codex、Grok、Qwen、Hermes 都会向模型提供较强的本地环境或项目上下文，但载体不同。**
2. **Grok 的 `<user_info>` + `<git_status>` 是最显眼的 synthetic user 前缀，但不是唯一上下文消息，也不是永远固定 index 1。**
3. **Claude Code 的 CLAUDE.md 主要是 `isMeta` synthetic user；Git status 则位于 systemContext。**
4. **Codex 把 base instructions 与 input 中的 contextual developer/user fragments 明确分开，并通过 world-state diff 增量维护。**
5. **OpenCode 的 `<env>` 只提供目录、worktree、平台、日期和“是否 Git repo”，不会自动发送 Git status。**
6. **Qwen 把环境、MCP、skills、deferred tool 元数据放入启动 user contents 的多个 reminder parts，而 Git snapshot 进入 systemInstruction。**
7. **Hermes 的 coding 模式会把完整 workspace/Git/project facts 放入 system prompt context tier，并通过 SessionDB 缓存。**
8. **OpenClaw 明确区分 workspaceDir 与 cwd，sandbox 会重映射路径；主 prompt 通常不自动注入 Git status。**
9. **MCP tools 几乎始终进入 tools/schema 载体，而不是普通 message 正文；MCP instructions 才可能进入 system 或 reminder。**
10. **最终 wire payload 之前普遍还有一次 transform：tool pairing、context compaction、provider adapter、cache marker、deferred tools、权限过滤都会改变最终形态。**
