# CrewRouter 27.0 Beta

> 27.0 Beta 是预发布测试版，正式版之前的包、镜像和应用均可能变更。面向用户显示 `27.0 Beta`；机器可读的候选版本为 `27.0.0-beta.4`。

beta.1 与 beta.3 均已有 GitHub Pre-release；beta.2 的 tag workflow 曾失败且未发布。beta.3 的 GitHub 资产已发布，但 npm Trusted Publisher 不匹配，两个 npm 包未发布。beta.4 的 GitHub Pre-release、服务端/Desktop 资产及 npm SDK/CLI beta 包现已发布。SDK 与 CLI 不创建单独的 GitHub Release，npm 包使用 `@bloret-crew` 组织作用域。

## 发布项

| 组件 | 版本 | 分发渠道 |
|---|---:|---|
| CrewRouter 主服务 | 27.0.0-beta.4 | 本页服务端安装包；OCI 镜像暂不在此次发布流程中构建或推送 |
| CrewRouter Desktop | 27.0.0-beta.4 | 本页 Linux AppImage、Windows NSIS 安装程序、macOS Apple Silicon/Intel DMG |
| CrewRouter SDK（TypeScript） | 27.0.0-beta.4 | npm `@bloret-crew/crewrouter-sdk`（`beta` 标签） |
| CrewRouter CLI | 27.0.0-beta.4 | npm `@bloret-crew/crewrouter`（`beta` 标签） |

## 发布门禁

创建 Pre-release 前，必须在同一个 tag / commit 上通过服务端、SDK、CLI 和 Desktop 自动化测试；Windows/macOS/Linux 平台包全部构建完成；npm 打包清单与干净目录安装 smoke 通过；Desktop Remote URL DNS 全量地址校验与隔离回归通过。任何失败都停止 release，而不是创建不完整的发布页。

GitHub workflow 生成所有资产的 SHA-256 清单并将其一并附加。Pre-release 仅包含已构建和校验的真实文件，不把 Actions 的短期 workflow artifact 当作正式发布资产。

## Beta 使用限制

- Desktop 远程连接默认拒绝回环、私网、链路本地及保留网络目标；仅明确的 Local 流程开放 loopback。DNS 在连接前验证，本 Beta 暂不承诺防止恶意 DNS 重绑定造成校验和实际连接目标不一致；仅在可信网络试用。
- Desktop 安装包不得包含 PassPort 共享 Client Secret。公共客户端 PKCE／安全中转尚未完成前，不承诺开箱 Local 登录；Local 只允许受控开发/内部测试配置。建议 Beta 试用者用 Remote 模式连接已有 CrewRouter 服务。
- SDK 与 CLI 不提供单独的 GitHub Release，只通过 npm 分发。beta.1 已发布，`latest` 与 `beta` 标签目前仍指向 `27.0.0-beta.1`。beta.4 已发布到 `beta`；`latest` 保持指向 `27.0.0-beta.1`，后续稳定版发布时再迁移该标签。
- 测试版不得覆盖 `latest` / `saas-latest` 或既有稳定版。升级前备份配置和数据库，测试环境与正式数据严格隔离。

## 完成前检查清单

- [x] beta.1 GitHub Pre-release 和 npm `beta` 包已存在（历史发布）。
- [x] beta.3 workflow 配置完整版本门禁、四平台构建与 checksum 生成步骤。
- [x] beta.3 release dry-run 全部构建与 gate jobs 通过。
- [x] beta.3 GitHub tag workflow 构建并创建 Pre-release；server 与四个平台 Desktop 资产来自同一 commit 并附 SHA-256。
- [ ] beta.3 npm 候选包经单独的手动 publish job 发布到 `beta`；当前 registry PUT 返回 HTTP 404，待修复 npm package publish access。
- [x] 核验 beta.3 release/tag 与全部 9 个 GitHub 资产；npm dist-tags 仍指向 beta.1，本次未移动 `latest`。
- [x] beta.4 manifests、lockfiles、user-agent、OpenAPI version 和 release gates 已统一为同一个 candidate version。
- [x] beta.4 clean dry-run 的所有发布 gate 和平台构建全部通过。
- [x] beta.4 tag workflow 创建 GitHub Pre-release 和同 SHA 服务端/Desktop 资产。
- [x] 两个 npm 包的 Trusted Publisher 发布通过；beta.4 SDK 与 CLI 版本发布到 `beta`，未移动 `latest`。
