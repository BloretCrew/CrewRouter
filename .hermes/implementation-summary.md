# 注入提示词实现总结

## 改动文件

- `server/utils/inject-prompt.js`：改为 `<system-reminder>` + `# claudeMd` + `Contents of ... (project instructions, ...)` + `# currentDate` 格式；各协议改为首条 user 前插入 meta user。
- `server/utils/inject-prompt-scrub.js`：新增 Claude Code 风格 system-reminder/claudeMd 回显净化，同时保留旧格式和 exactText 精确移除。
- `server/utils/inject-prompt-stream.js`：流式跨 chunk 净化新格式。
- `server/routes/api.js`：OpenAI Chat、Chat→Responses、Chat→Anthropic、Fusion、Anthropic Messages、Responses 直连改为目标位置注入。
- `server/scripts/test-inject-scrub.js`：测试样例更新为新格式。

## 注入位置

- OpenAI Chat：`server/routes/api.js:1352`，首条 user 消息前插入 `{ role: 'user', isMeta: true }`。
- Chat→Responses：`server/routes/api.js:1724`，`input` 首条 user item 前插入 meta message。
- Chat→Anthropic：`server/routes/api.js:1922`，Anthropic `messages` 首条 user 前插入 contextual meta user。
- Fusion：`server/routes/api.js:2455`，转换后的 messages 首条 user 前插入 meta user。
- Anthropic 直连：`server/routes/api.js:3082`，请求 `messages` 首条 user 前插入 meta user。
- Responses 直连：`server/routes/api.js:5271`，`body.input` 首条 user item 前插入 meta message。

## 验证结果

- `node --check server/utils/inject-prompt.js`：通过。
- `node --check server/utils/inject-prompt-scrub.js`：通过。
- `node --check server/utils/inject-prompt-stream.js`：通过。
- `node --check server/routes/api.js`：通过。
- `node --check server/scripts/test-inject-scrub.js`：通过。
- `node server/scripts/test-custom-instructions.js`：通过，`ALL_PASS`。
- `node server/scripts/test-request-source.js`：通过，`All request-source assertions passed`。
- `node server/scripts/test-inject-scrub.js`：未能执行，当前工作树缺少 `node_modules/pg`，加载数据库模块时报 `Cannot find module 'pg'`。
- `node server/scripts/test-usage-accuracy.js`：未能执行，同样因缺少 `node_modules/pg`。
- `npm run build`：未运行；任务要求的依赖环境不完整，且构建非核心验证。

## 未覆盖项

未在真实上游请求中验证各供应商对 `isMeta` 字段的透传行为；未启动服务，未进行端到端网络验证。数据库依赖缺失导致净化单测和用量回归无法运行。
