# CrewRouter Desktop 内置本地 Personal Server

> 给 Grok：在 `/data/CrewRouter/CrewRouter-Desktop` 继续完成。使用 `bloret-router`，只 commit 不 push。当前已有未提交内置 Server 改动，先审查 diff，不要 reset，不要破坏 OOBE、远程 Demo 转向、Blora、preload/IPC、认证和上报。

## 用户最终要求
本地模式的完整 CrewRouter Personal Server 必须随 Desktop 一起分发。正式用户不能设置 `CREWROUTER_SERVER_ROOT`，也不能依赖 `/data/CrewRouter`。

点击本地使用后：从安装包资源找到 Server → 独立 userData → 随机 loopback 端口 → 启动完整 Server → 健康检查 → BrowserWindow 加载本地 Server。

本地语义：`runtime=desktop-local`、`edition=personal`、`auth.required=false`、`demo=false`，保留 login/stats reporting。

## 当前验收发现（必须修复）
最近实际 Electron 截图显示父项目 `/api/setup` 的“选择安装版本 / Personal Edition / Team Edition”页面，不是 Desktop 本地模式。Server 可能已启动，但 Desktop 生成的 runtime 配置没有真正被父项目使用，或仍进入 edition setup。

必须先定位真实根因：

- 检查 `server/config-loader.js`、`server/index.js`、setup/edition middleware 的真实读取路径和字段；
- 确认子进程使用 Desktop 写出的 `CR_CONFIG_PATH`、`CR_DATA_DIR`、`CR_RUNTIME`、`CR_EDITION` 等配置；
- 确认本地启动不会访问生产 config/database；
- 本地应直接作为 `desktop-local + personal` 免交互运行，不能自动点击版本选择来伪造成功；
- 本地 Server 必须在独立临时数据库中完成真实初始化和 `/api/instance` 验证。

## 继续任务
1. 审查并清理不安全/无效的 `data/`、自动生成文件；禁止生产数据库、凭据、`.env`、生产配置或日志进入 bundle。
2. 完成 staged bundle 与 `process.resourcesPath` 定位；开发模式无 `CREWROUTER_SERVER_ROOT` 时可使用明确 staged fallback；正式打包不依赖环境变量。
3. 修正隔离数据库生命周期，失败时停止临时数据库和 Server，不残留进程。
4. 修复配置读取/启动语义，使无环境变量正式 Electron main 流程点击“本地使用”后直接加载 desktop-local personal，而不是 setup edition 选择页。
5. 重新生成并实际读取 `.hermes/screenshots/local-mode-960x700.png`、`.hermes/screenshots/local-mode-600x700.png`；必须来自正式 main 流程。
6. 保持 OOBE、远程两入口及 Demo 转向、Blora、IPC、安全、认证和上报不回归。

## 必须运行
```bash
npm test
npm run syntax
npm run validate:server-bundle
npm run test:packaged-server
npm run build -- --publish never
```
所有临时服务使用临时目录/端口/数据库，结束后清理。不得触碰生产 `20003`、Show `20004`。

## 提交
只有真实测试、HTTP、正式 Electron 和截图都通过后才 commit；只 commit 不 push。输出修改文件、bundle结构、无环境变量启动证据、隔离服务结果、截图内容、测试结果、commit hash和未完成项。50轮不足时保留正确进展，下一轮继续，禁止 reset。