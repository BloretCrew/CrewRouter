# Desktop Personal 模型库修复任务

> 给 Grok：在 `/data/CrewRouter/CrewRouter-Desktop` 修复 Desktop 内置 Server 的 Personal 模型库错误限制。只 commit 不 push。先审查当前工作树和最近提交，不要 reset，不要重复已完成工作。

## 已确认根因
父项目 Personal capabilities 已经包含完整个人 AI 能力，但 Desktop 的 `scripts/stage-server.js` 仍有旧的构建期前端注入逻辑：遇到 `desktop-local + personal` 就把模型库替换为“Personal 版本本地服务不提供共享模型库”，并隐藏模型绑定区域。必须删除/撤销这段旧限制。

## 目标
Personal 和 desktop-local Personal 必须保留完整个人模型库：

- 模型库页面正常加载；
- Provider/上游可添加和管理；
- API Key 可添加和管理；
- 默认模型和 Harness 专属模型可选择/绑定；
- 模型测试可用；
- 没有配置时显示正常空状态，例如“还没有配置 Provider”，不能显示“Personal 不提供模型库”；
- 只隐藏团队成员、共享 Key、团队权限和协作管理。

## 必须完成

1. 删除或改正 `scripts/stage-server.js` 中针对 `desktop-local + personal` 隐藏/替换模型库的注入逻辑；
2. 确认 staged server 不再包含该旧限制；
3. 确认服务端 Personal API 的访问仍有当前用户隔离，不要删除正常权限检查；
4. 更新 Desktop 测试，覆盖旧提示不会出现、模型库个人能力不会被隐藏；
5. 保持 Local `desktop-local + personal`、免登录、上报、远程直连、官方 Demo 转向和安全 IPC 不回归；
6. 不修改父项目生产服务、生产数据库或生产端口。

## 验证

运行：

```bash
npm test
npm run syntax
npm run stage:server
npm run validate:server-bundle
```

若需要启动服务，使用临时目录、临时端口、隔离数据库，不使用生产。使用正式 Electron main 流程，清除 `CREWROUTER_SERVER_ROOT`，点击本地使用并输入测试用户名，确认：

- 直接进入本地控制台；
- 模型库不出现“Personal 不提供共享模型库”；
- 没有 Provider 时是明确个人空状态；
- 不出现登录页、setup 页、加载失败或持续加载；
- 960x700 和 600x700 都正常。

生成并实际读取截图：

- `.hermes/screenshots/personal-model-library-960x700.png`
- `.hermes/screenshots/personal-model-library-600x700.png`

截图必须来自正式 Electron main 流程，不能只检查文件存在。完成后输出实际截图内容、测试结果、修改文件和 commit hash。