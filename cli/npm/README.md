# CrewRouter CLI 27.0 Beta

```bash
npm install -g @bloret-crew/crewrouter@beta
cr --help
```


要求 Node.js 20 或更高。远程管理命令连接已有 CrewRouter 实例；本地 `start` / `serve` 需本机另行安装兼容的 CrewRouter Server，不会由独立 CLI 包内嵌 Server。CLI 包附带可选的 DSH 插件；首次交互运行普通命令时检测到 DSH 后会征求用户同意并要求选择 profile。拒绝时可选择记住设置，不再自动询问；状态、概览、诊断、帮助和版本命令不触发安装引导。插件安装不会在 npm 生命周期脚本中执行。完整文档见[仓库 CLI 说明](https://github.com/BloretCrew/CrewRouter/blob/main/docs/cli.md)。

GPL-3.0。仅连接您获准访问的 CrewRouter 实例。
