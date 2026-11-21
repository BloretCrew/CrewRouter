# CrewRouter 27.0 Beta

> 27.0 Beta 是预发布测试版，正式版之前的包、镜像和应用均可能变更。面向用户显示 `27.0 Beta`；机器可读的候选版本为 `27.0.0-beta.1`。

本轮通过 tag 发布自动化验收后：主仓库只创建一条 GitHub Pre-release，包含 CrewRouter 主服务安装包及 Desktop 平台安装包。SDK 与 CLI 只准备独立 npm beta tarball 和 npm 候选 artifact，不创建各自的 GitHub Release；本地源代码仍在审查阶段。npm 包使用 `@bloret-crew` 组织作用域。

## 计划发布项

| 组件 | 候选版本 | 分发渠道 |
|---|---:|---|
| CrewRouter 主服务 | 27.0.0-beta.1 | 本页服务端安装包；OCI 镜像暂不在此次发布流程中构建或推送 |
| CrewRouter Desktop | 27.0.0-beta.1 | 本页 Linux AppImage、Windows NSIS 安装程序、macOS Apple Silicon/Intel DMG |
| CrewRouter SDK（TypeScript） | 27.0.0-beta.1 | npm `@bloret-crew/crewrouter-sdk`（beta 标签）；publish 尚未执行 |
| CrewRouter CLI | 27.0.0-beta.1 | npm `@bloret-crew/crewrouter`（beta 标签）；publish 尚未执行 |

## 发布门禁

创建 Pre-release 前，必须在同一个 tag / commit 上通过服务端、SDK、CLI 和 Desktop 自动化测试；Windows/macOS/Linux 平台包全部构建完成；npm 打包清单与干净目录安装 smoke 通过；Desktop Remote URL DNS 全量地址校验与隔离回归通过。任何失败都停止 release，而不是创建不完整的发布页。

GitHub workflow 生成所有资产的 SHA-256 清单并将其一并附加。Pre-release 仅包含已构建和校验的真实文件，不把 Actions 的短期 workflow artifact 当作正式发布资产。

## Beta 使用限制

- Desktop 远程连接默认拒绝回环、私网、链路本地及保留网络目标；仅明确的 Local 流程开放 loopback。DNS 在连接前验证，本 Beta 暂不承诺防止恶意 DNS 重绑定造成校验和实际连接目标不一致；仅在可信网络试用。
- Desktop 安装包不得包含 PassPort 共享 Client Secret。公共客户端 PKCE／安全中转尚未完成前，不承诺开箱 Local 登录；Local 只允许受控开发/内部测试配置。建议 Beta 试用者用 Remote 模式连接已有 CrewRouter 服务。
- 不提供 SDK 或 CLI 单独 GitHub Release，也不会自动向 npm publish。workflow 会核验 registry 中的目标包名、版本可用性并生成候选 tarball；候选 npm 安装验收通过、权限与发布者确认后，才可单独执行公开 publish。
- 测试版不得覆盖 `latest` / `saas-latest` 或既有稳定版。升级前备份配置和数据库，测试环境与正式数据严格隔离。

## 完成前检查清单

- [ ] GitHub Pre-release（主服务 + Desktop）构建和创建通过前，不向用户提供预发布安装命令或发布页 URL。
- [ ] Desktop Beta 明确限制为 Remote 优先；缺少受控配置时 Local 停止在本地 Server 启动之前；不得将任何 PassPort 共享 Secret 打入安装包。
- [ ] npm 候选包名在目标 org/registry 确认可用、publish identity 与 version owner 确认后才发布；CI 只上传候选包而不 npm publish。
- [ ] Linux、Windows、macOS Apple Silicon/Intel 全部 Desktop assets 构建成功并附 SHA-256。
- [ ] 发布 tag 对应 GitHub Actions required jobs 全部成功；所有产品来自同一 commit。
- [ ] 主仓库 Release 标记 Pre-release，标题 `CrewRouter 27.0 Beta`；不发 27.0 GitHub 正式版或 Docker latest image。
- [ ] 发布后复核 GitHub release/tag 和 npm registry/dist-tags；稳定 `latest`/`saas-latest` 与既有 `27.0` tag 均未改变。
