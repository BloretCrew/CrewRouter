# CrewRouter 27.0 Beta

> 27.0 Beta 是预发布测试版，正式版之前的包、镜像和应用均可能变更。面向用户显示 `27.0 Beta`；机器可读的候选版本为 `27.0.0-beta.2`。

beta.1 已有 GitHub Pre-release，SDK 与 CLI 也已发布到 npm `beta` 标签。本文记录 beta.2 候选；在 `.2` tag 工作流和手动 npm publish 全部成功前，下列 beta.2 资产尚未发布。SDK 与 CLI 不创建单独的 GitHub Release；npm 包使用 `@bloret-crew` 组织作用域。

## 发布项

| 组件 | 版本 | 分发渠道 |
|---|---:|---|
| CrewRouter 主服务 | 27.0.0-beta.2 | 本页服务端安装包；OCI 镜像暂不在此次发布流程中构建或推送 |
| CrewRouter Desktop | 27.0.0-beta.2 | 本页 Linux AppImage、Windows NSIS 安装程序、macOS Apple Silicon/Intel DMG |
| CrewRouter SDK（TypeScript） | 27.0.0-beta.2 | npm `@bloret-crew/crewrouter-sdk`（`beta` 标签） |
| CrewRouter CLI | 27.0.0-beta.2 | npm `@bloret-crew/crewrouter`（`beta` 标签） |

## 发布门禁

创建 Pre-release 前，必须在同一个 tag / commit 上通过服务端、SDK、CLI 和 Desktop 自动化测试；Windows/macOS/Linux 平台包全部构建完成；npm 打包清单与干净目录安装 smoke 通过；Desktop Remote URL DNS 全量地址校验与隔离回归通过。任何失败都停止 release，而不是创建不完整的发布页。

GitHub workflow 生成所有资产的 SHA-256 清单并将其一并附加。Pre-release 仅包含已构建和校验的真实文件，不把 Actions 的短期 workflow artifact 当作正式发布资产。

## Beta 使用限制

- Desktop 远程连接默认拒绝回环、私网、链路本地及保留网络目标；仅明确的 Local 流程开放 loopback。DNS 在连接前验证，本 Beta 暂不承诺防止恶意 DNS 重绑定造成校验和实际连接目标不一致；仅在可信网络试用。
- Desktop 安装包不得包含 PassPort 共享 Client Secret。公共客户端 PKCE／安全中转尚未完成前，不承诺开箱 Local 登录；Local 只允许受控开发/内部测试配置。建议 Beta 试用者用 Remote 模式连接已有 CrewRouter 服务。
- SDK 与 CLI 不提供单独的 GitHub Release，只通过 npm 分发。beta.1 已发布，`latest` 与 `beta` 标签目前仍指向 `27.0.0-beta.1`。beta.2 候选只推送到 `beta`；此发布不移动 `latest`，后续稳定版发布时再迁移该标签。
- 测试版不得覆盖 `latest` / `saas-latest` 或既有稳定版。升级前备份配置和数据库，测试环境与正式数据严格隔离。

## 完成前检查清单

- [x] beta.1 GitHub Pre-release 和 npm `beta` 包已存在（历史发布）。
- [x] beta.2 workflow 已配置完整版本门禁、四平台构建与 checksum 生成步骤。
- [ ] beta.2 release dry-run 全部 jobs 通过。
- [ ] beta.2 GitHub tag workflow 构建并创建 Pre-release；资产来自同一 commit 并附 SHA-256。
- [ ] beta.2 npm 候选包经单独的手动 publish job 发布到 `beta`；不移动 npm `latest`。
- [ ] 发布后复核 beta.2 release/tag 和 npm dist-tags；既有 beta.1 `latest` 不变。
