# CrewRouter Desktop 本地首次用户名 OOBE

> 给 Grok：在 `/data/CrewRouter/CrewRouter-Desktop` 修复本地模式首次启动流程。使用 `bloret-router`，只 commit 不 push。先审查当前工作树和已有本地 Server 改动，不要 reset，不要破坏 OOBE 简化、远程 Demo 转向、Blora、IPC、安全和上报。

## 用户最终需求

本地版不需要登录，但首次打开时询问一次用户名：

```text
首次打开
→ 输入用户名
→ 启动内置 Personal Server
→ 自动建立本地身份
→ 直接进入控制台
```

以后启动自动进入，不再重复询问。

## 必须实现

1. 本地 OOBE 首屏只在选择“本地使用”后显示用户名表单；首屏仍保持 Local / Remote 两个入口。
2. 只询问用户名，不要密码、登录按钮、Passport、Passkey 或 Personal/Team 选择。
3. 用户名用于本地用户显示名/资料；内部身份使用稳定本地 ID，不把用户名当作密码或安全凭据。
4. 用户名校验：去除首尾空格；不能为空；长度和危险字符按现有安全规则限制；错误信息清晰；不要把用户输入直接拼接 HTML。
5. 保存到 Desktop 自己的 userData/profile，不保存到生产路径，不泄露到 URL；以后启动自动复用。
6. 启动内置完整 Personal Server 时，把显示名/本地身份以安全、明确的 runtime 配置或受控 IPC 传入；Server 识别为：
   - `runtime=desktop-local`
   - `edition=personal`
   - `auth.required=false`
   - `auth.methods=["local"]`
   - `demo=false`
   本地自动进入控制台，不显示服务端登录页或 setup 版本选择页。
7. 用户名首次保存失败时不能留下半成品 profile；允许用户重试。
8. 兼容已有安装：已有本地 profile 但没有显示名时，补充询问一次；远程 profile 不受影响。
9. 保留 login-report/stats-report 逻辑，不关闭上报。
10. 保持正式 Blora 2.0 组件，使用 SF Symbols，不引入 Lucide；布局适配 960x700 和 600x700。

## 验证要求

- 单元测试覆盖空白、非法、边界用户名、HTML 注入、持久化、已有 profile 自动跳过、远程 profile 不受影响；
- 本地 Server 集成测试使用临时数据目录、临时端口、隔离临时数据库，不碰生产 20003/20004 和生产数据库；
- 正式 Electron main 流程清除 `CREWROUTER_SERVER_ROOT`，首次输入测试用户名，点击继续/本地使用，确认直接进入本地控制台；
- 关闭并重新启动正式 Electron，确认不再询问用户名；
- 确认没有登录页、版本选择页、加载失败或持续加载；
- 生成并实际读取：
  - `.hermes/screenshots/local-username-oobe-960x700.png`
  - `.hermes/screenshots/local-username-console-960x700.png`
  - `.hermes/screenshots/local-username-console-600x700.png`

截图必须真实来自正式 Electron main 流程，不能只检查文件存在。首次用户名页和进入控制台的截图都要确认内容、布局和状态真实正确。

运行：

```bash
npm test
npm run syntax
npm run validate:server-bundle
npm run test:packaged-server
npm run build -- --publish never
```

所有失败继续修复，直到真实流程通过。只 commit 不 push。输出修改文件、测试结果、实际启动证据、截图内容和 commit hash。不要修改父项目生产服务或生产数据库。