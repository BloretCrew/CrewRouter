# CrewRouter CLI 27.0 Beta

独立的 GPL-3.0 CLI 客户端发布包，带 `cr` 和 `crewrouter` 命令入口。

> 测试版会发生破坏性变化。该包只通过 npm `beta` dist-tag 分发。

```bash
# 将来的 npm 测试版安装方式（候选包尚未发布）
npm install -g crewrouter-cli@beta
cr --help
```


要求 Node.js 20 或更高。远程管理命令连接已有 CrewRouter 实例；本地 `start` / `serve` 需本机另行安装兼容的 CrewRouter Server，不会由独立 CLI 包内嵌 Server。完整文档见[仓库 CLI 说明](https://github.com/BloretCrew/CrewRouter/blob/main/docs/cli.md)。

GPL-3.0。仅连接您获准访问的 CrewRouter 实例。
