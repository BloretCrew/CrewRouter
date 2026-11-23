# 隔离任务示例

此示例只演示纯计算任务，不访问数据库、文件、网络或宿主 API。

- `plugin.json` 声明 `executionMode: "isolated-task"` 和 `tasks:register`。
- `task-entry.js` 是 ≤256 KiB、无 imports 的 handler factory，返回 manifest taskHandlers 列出的 JSON handler。
- Linux 部署需安装 bubblewrap，并由管理员显式设置 `CR_ENABLE_PLUGIN_BWRAP=1`；启动时 live-probe namespace、uid/gid 和 cap-drop。
- 启动时会 probe user/PID/network namespaces、uid/gid 切换到 65534、capabilities drop；任何失败均拒绝加载，不回退主进程。
- handler 输入/结果 JSON 限 64 KiB，超时 kill worker process group。

此执行模式不支持 `storage`、`network`、gateway/billing/API-key/provider hooks、routes、cron、events 或页面/插槽；需要这些能力的插件必须继续在 `trusted-in-process` 模式运行并经过管理员审查。Root 部署要求 `setpriv` 和 world-readable Node runtime（必要时配置 `CR_PLUGIN_NODE_PATH`），没有这些条件时 runtime preflight 会 fail closed。VM/bwrap 组合属于该 Linux 部署主机上的 OS 限制，仍不承诺对抗内核/运行时漏洞或容器逃逸。
