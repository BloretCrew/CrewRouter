# 插件信任、安装与执行边界

## 当前执行模式

后端 `main.js` 默认不执行。常规 `trusted-in-process` 插件只有在管理员审查代码并显式设置 `CR_TRUST_IN_PROCESS_PLUGINS=1` 后才运行于 CR 主进程；Node VM、权限清单、超时和任务重试都不是恶意代码的 OS 隔离。

Linux bubblewrap 提供两种严格受限模式：`executionMode: "isolated-task"` 仅支持纯计算 `task-entry.js`；`executionMode: "isolated-hooks"` 仅支持 JSON-safe 的 `billing:calculate` 和 `stats:record`，每次调用启动一次短命 worker，payload/meta 经字段白名单投影，不传凭据、request body 或用户/Key ID。该模式额外权限只能是 manifest hooks 所需的 `billing:modify` / `gateway:modify`，handler 返回值再按 hook schema 限制；每次调用有 worker 启动开销，不用于流式热路径。gateway request/response/stream、API-key、provider、routes、cron、storage 和 network 等宿主 API 仍不支持隔离执行，必须留在 trusted-in-process 并经管理员审查。

管理员需显式设置 `CR_ENABLE_PLUGIN_BWRAP=1`；启动时 live-preflight bubblewrap user/PID/network/IPC/UTS namespace、UID/GID 与 capability 限制。root 服务通过 `setpriv` 降到宿主 nobody (65534)；bubblewrap 和 Node runtime 必须可由该用户遍历/执行，可用 `CR_PLUGIN_NODE_PATH` 指定 world-readable Node binary（例如 root 下默认 `/root/.nvm` 路径会被拒绝）。runtime 缺失或 preflight 失败则拒绝加载，不回退主进程。

该模式有真实 OS namespace/host UID 边界，但共享宿主内核，不保证抵御内核漏洞、bwrap/Node漏洞或侧信道；不等同于每插件 OCI 容器。隔离 task/hook entry 均无宿主 imports/API；rootfs 只挂载 Node ELF 与动态库、只读 entry/RPC frame、独立临时目录，网络 namespace 关闭；资源限额为 address-space 4 GiB、CPU 25 秒、wall-clock ≤30 秒（hooks 实际上限 2 秒）、NOFILE 64、FSIZE 512 KiB，stdout frame ≤256 KiB，JSON payload/result ≤64 KiB，超时杀 worker process group。**尚未配置 cgroup CPU/内存配额或 seccomp syscall filter**；该模式是有边界的 Linux 纵深防御，不得用于需要内核级抗逃逸保证的恶意/高风险代码。未知或无法审查代码仍建议禁用。需要更强隔离时仍需独立容器/低权限服务、最小挂载、网络策略、seccomp/AppArmor 与逃逸测试。

## 商店包校验

从允许的 HTTPS 商店源安装时，服务器要求包 SHA-256 并与下载内容比对，校验 ZIP 结构、manifest 和插件 ID。安装确认提交的包摘要和权限快照也会与服务器重新获取的元信息/包内容比较；不一致时要求管理员重新查看权限。

SHA-256 只证明下载的归档与商店元数据中的摘要相同。若商店元数据和归档由同一发布方控制，哈希**不构成发布者身份签名**。

实例管理员可选择配置 `store.pluginSigningKeys`（key ID → PEM Ed25519 公钥）。配置至少一个受信 key 后，商店包必须提供 `signatureKeyId` 和 Base64 `signature`，签名消息为 UTF-8：`crewrouter-plugin-v1`、plugin ID、version、小写 SHA-256、JSON 序列化排序后的 permissions 数组，每段之间用单个 LF 字节分隔（不含末尾 LF）；签名缺失、key 未受信或版本/摘要/权限不符都会拒绝安装。发布者可运行 `node scripts/sign-plugin-package.mjs <id> <version> <sha256> '<permissions-json>' <private-key-pem-file>` 生成表单所需签名字段；设置 `CR_PLUGIN_SIGNING_KEY_ID` 作为 key ID。私钥只保存在发布者受控环境中。没有配置签名 key 时，系统明确处于“管理员信任来源”兼容模式，不声称已验证发布者身份。密钥轮换时先同时配置新旧公钥，待旧版本迁移完成后再移除旧 key。签名证明发布者密钥持有，不证明代码安全；商店审核（若有）也不等于独立安全审计。

安装页面会显示权限、SHA-256、进程内执行警示，并要求管理员确认权限；具有后端权限的包还要求单独确认信任风险。管理员确认不代表插件代码已安全。

## 更新与回滚

商店更新会保留插件原有启用状态；已禁用插件不会因更新自动启用。升级前应检查新版本权限变化和代码来源。若摘要缺失、无效或与下载包不符，安装失败。

## 任务与事件

- 默认 `tasks:register` handler 在 trusted-in-process 主进程执行，Promise 超时/AbortSignal 不能杀死同步阻塞代码。声明 `executionMode: "isolated-task"` 的纯计算 task handler 则运行于 Linux bubblewrap namespace worker，host 超时会杀整个进程组；此模式不提供其他 ctx API。
- `events:subscribe` 是字段白名单、版本化的进程内 best-effort 通知，不是 durable message broker；跨重启可靠处理用持久任务。模型健康事件仅在每模型健康状态跃迁时发布。配额阈值事件仅在用户为 OpenCode Go Key 显式开启 quota warning、且签名路径成功读取上游额度后发布；payload 仅含窗口 scope、remaining、threshold，不含用户/Key/provider ID。Team 计费限额热路径不广播。事件去重状态目前是内存 best-effort，重启会重新建立基线，不保证 durable delivery。
