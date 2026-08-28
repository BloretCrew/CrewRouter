# README 更新审查

- 审查对象：提交 `f715327` 相对父提交 `f715327^` 的 diff
- 任务范围：仅审查任务书中的 README 部分
- 结论：发现 1 个问题

## Issues

1. **severity：中**  
   **file:line：`README.md:57`**  
   **description：** 新增功能条目将 OAuth 2.0 授权服务描述为“PKCE、AI 客户端凭证”。代码中的 OAuth 服务确实实现了 PKCE 授权码流程和 refresh token（`server/routes/oauth.js`），但 `/oauth/token` 当前仅分派 `authorization_code` 与 `refresh_token` 两种 grant，未实现 `client_credentials` grant；管理后台中出现的 `client_credentials` 仅是示例请求，不能证明该服务已提供机器客户端凭证模式。因此该条目的“AI 客户端凭证”表述超出当前实现，功能宣传不完全真实。  
   **suggestion：** 将条目改为准确描述已实现能力，例如“OAuth 2.0 授权服务 — PKCE 授权码、刷新令牌与 AI 客户端授权”，或在实现 `client_credentials` grant 后再保留“AI 客户端凭证”。  
   **status：** open

## 审查项结论

- **是否只改 README：** 是。`git diff --name-status f715327^ f715327` 仅显示 `README.md`，提交统计为 1 个文件；当前工作树除本次审查报告外没有发现提交之外的 README 修改。
- **功能条目格式：** 通过。新增条目均采用 `- [x] **名称** — 说明` 格式，共 9 条，位置位于“核心功能”现有清单之后。
- **新增功能真实性：** 除上述 OAuth“AI 客户端凭证”表述外，其余条目均能在仓库现有插件、商店、i18n、提示词注入/净化、Helper 上报、模型库与会话总结实现中找到对应依据。
- **技术栈补充：** 通过。前端行补充了 i18n 与插件运行时，服务端行补充了 OAuth 授权服务与插件商店。
- **兼容客户端补充：** 通过。兼容客户端行已补充“以及安装了对应插件的任意客户端”。
- **是否意外改动其它内容：** 未发现。除核心功能、兼容客户端和技术栈相关说明外，快速开始、配置、文档、许可、星标等部分未被 diff 改动。
