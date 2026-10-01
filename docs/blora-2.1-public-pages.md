# Blora 2.1.0 公共页面规范优化

## 范围与来源

负责 `public/pages` 中除 `admin.html`、`console.html` 外的 12 个现有 HTML 页面，以及 `auth-shell.css`、`playground.css`、`store.css`、`usage.css` 和其专用脚本。`admin.html.bak` 是非运行备份，未修改。

依据实际安装的 `node_modules/@bloret-crew/blora-design/package.json`（版本 2.1.0）、`llms.txt`、`dist/docs/{patterns,standards,guide,framework}.md`、`dist/docs/migration/from-any-ui-to-blora-design.md`、对应 Field/Card/Input/Select/Switch/Slider/Rate/Upload/Empty/Alert/Button 契约以及 token/component manifests。

未修改共享 `main.css`、`themes.css`、`blora-foundation.js`、`blora-dialog.js`、`blora.css`。共享旧样式通过各页面的 `@import ... layer(legacy)` 隔离，专用样式中旧外观进入 legacy 层，未分层样式只保留布局。用户已有修改和其他代理工作未纳入提交；本任务按要求不提交。

## 页面问题、能力与验证简表

| 页面 | 处理的问题 | 对应官方能力 | 实际验证 |
| --- | --- | --- | --- |
| index | 生成式 Field 控件身份、密码管理器属性、表单 inline handler、卡片标题描述及旧图标 | Field 2.1 原生子节点接管；Card title/desc/header；Lucide | 密码为 INPUT，每个 Field 恰好一个 input；current-password、required、minlength=6 保留，空密码 checkValidity=false |
| set-password | 新密码控件、表单事件和外观补丁 | 原生子节点 Field、官方 Card/图标 | new-password、required、minlength=6 保留；两个密码 Field 均只有一个原生 input |
| feishu-bind | 密码裸控件、旧登录卡片及手绘链接图标 | Field 原生接管、Card、data-icon=link | 密码原 ID 保留；current-password、required、minlength=6；原绑定接口及提交处理不变 |
| oauth-consent | 默认 Select 值早于组件升级时未进入 FormData；权限图标 | 官方 Select 表单关联、升级后同步 value、Lucide check | 原生 POST action=/oauth/authorize/approve；FormData 含 api_key_id=1 和原查询参数隐藏域 |
| setup | 裸管理员输入、多个主按钮、旧状态图标与卡片密度 | Field、outline 选择按钮、compact Card、Spinner | 3 个原生输入 ID 保留；卡片计算 padding=24px；原 setup 流程/接口未改 |
| playground | 裸滑块开关、系统提示词和消息输入、原生 confirm/alert、手写空错误/Toast | Slider、Switch、Field、Dialog、Empty、Alert、message | temperature=1.5 后显示 1.5；checked=false 后显示已禁用；原 value/checked 和事件数据流保留 |
| plugin-install | 未发布 action-primary token、手写加载/安装成功失败提示 | 已发布语义 token、Skeleton、Alert、Card title/desc | lint 无未知 token；模拟安装信息可渲染；401/403 分支和安装 POST 保留 |
| purchase | 商品卡片外观、Emoji 占位图标及动态 onclick | compact Card title/desc、Lucide package、原生事件绑定 | 模拟商品显示“验收商品”；purchaseAction 为 BUTTON；原 handlePurchase 逻辑保留 |
| showcase | 未分层旧外观、硬编码颜色、手写 Skeleton、语言 Select 与 iframe onload | legacy 隔离、语义 token、Skeleton、Select、事件绑定 | 浅深色与 390/1280px 均无页面横向溢出和未捕获异常 |
| data | 自制统计卡片/表格、无加载和错误反馈、手写空态 | compact Card、Table、Skeleton、Alert、Empty | 统计卡片 padding=24px；保留 30 秒刷新和 /api/stats-report/overview |
| store | 自制插件卡片、动态裸文本/审核选择/文件/评分控件及手写 banner | compact Card title/desc、Field、Select、Upload compact、Rate、Alert、Empty | 模拟列表卡片 padding=24px；搜索由 Field 接管；提交页 13 个 Field 各有一个原生控件；FileReader 仍读取 Upload.files |
| usage | 表格嵌套自制卡片、手写加载空错误、模型 chip | 官方 Table、Spinner、Empty、Alert、Tag | 模拟 keyId=1 用量可渲染；原凭据、401/403 控制台跳转和聚合逻辑保留 |

## 检查证据

- 全部负责业务页面、专用 CSS 和专用 JS 均纳入 npm 包自带 lint，未关闭规则或排除业务文件：`✔ 0 problems`（0 errors / 0 warnings）。
- `git diff --check` 在负责文件范围内通过。
- 12 个页面相较 HEAD 的全部原静态 ID 保留。
- 46 段 inline JS 和 5 个专用 JS 文件 `node --check` 通过。
- 隔离静态服务器直接提供 npm dist 文件；真实 Google Chrome headless CDP 验证 12 页面 × 浅/深色 × 1280/390px，共 48 次：主题属性全部匹配，页面横向溢出 0 次，未捕获 JS 异常 0 次。
- 原生 Field、Slider/Switch 事件、OAuth FormData、动态插件卡片/提交 Field、商品按钮均另行进行 DOM/交互验证。
- 本次临时机器可读证据：`/tmp/public-blora-before.json`、`/tmp/public-blora-after.json`、`/tmp/public-blora-browser.json`、`/tmp/public-blora-interactions.json`。这些临时路径不会随仓库分发。

复现 lint：

```sh
node node_modules/@bloret-crew/blora-design/bin/blora-lint.mjs public/pages/{data,feishu-bind,index,oauth-consent,playground,plugin-install,purchase,set-password,setup,showcase,store,usage}.html public/css/{auth-shell,playground,store,usage}.css public/js/{oauth-consent,playground,playground-state,store,usage}.js
```

## 未验证与范围边界

浏览器验证使用模拟 GET 数据，没有提交真实密码、创建管理员、安装插件、发起计费购买、发送模型流式请求或写入商店评分/审核。真实数据库、真实 OAuth 回调/权限会话、外部图片和 PassPort 联调、长内容视觉与完整键盘/屏幕阅读器验收仍需主代理在部署环境执行，不能由上述静态/mock 验证替代。

保留的特殊内容排版、营销展示和部分旧弹层外观处于 legacy 层；不是宣称所有遗留 DOM 均已换成官方组件。共享适配器和其他代理管理的 services 文件不属于本任务修改范围。未提交、未推送。
