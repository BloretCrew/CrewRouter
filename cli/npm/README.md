# CrewRouter CLI 27.0 Beta

```bash
npm install -g @bloret-crew/crewrouter@beta
cr --help
```


要求 Node.js 20 或更高。远程管理命令连接已有 CrewRouter 实例；本地 `start` / `serve` 需本机另行安装兼容的 CrewRouter Server，不会由独立 CLI 包内嵌 Server。CLI 包附带可选的 DSH 插件；首次交互运行命令时检测到 DSH 后会询问用户是否为所选 profile 安装，用户需确认后继续（状态、帮助、版本命令不触发）。安装 DSH 插件不会在 npm 生命周期脚本中进行。完整文档见[仓库 CLI 说明](https://github.com/BloretCrew/CrewRouter/blob/main/docs/cli.md)。

GPL-3.0。仅连接您获准访问的 CrewRouter 实例。
