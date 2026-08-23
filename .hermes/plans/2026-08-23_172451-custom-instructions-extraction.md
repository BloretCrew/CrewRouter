# 调用记录：自定义提示词文件提取与标记

## 目标
CR 网关收到各 Coding Harness 请求时，把请求中携带的自定义提示词文件（CLAUDE.md / AGENTS.md / .cursorrules / QWEN.md / SOUL.md 等）
从 messages/system 中提取出来，标记进 usage_records.plugin_meta（新键 `customInstructions`），供管理后台查看每次调用带了哪些项目规则。

## 实现
1. `server/utils/custom-instructions-extractor.js`：
   - 输入 messages 数组 + system（字符串/数组）+ 可选 requestSource；输出 `{ items:[], skipped:null|'size' }`。
   - items 每项 `{ file, source, content, chars, position, truncated }`；source ∈ claude_md/agents_md/cursorrules/qwen_md/soul_md/other；
     position ∈ first_user/system/fragment。
   - 通用标签扫描 + 各家特化：claudeMd（Claude Code）、`<user_instructions>`（Codex）、Grok system-reminder 规则块、
     `# Project Context`（Hermes/OpenClaw 依 requestSource 仲裁）、`Instructions from`（OpenCode）、`--- Context from`（Qwen）。
   - 单文件 >32KB 只记前 2KB + truncated:true；messages+system 总字节 >2MB 跳过提取并标记 skipped:size。
   - 纯正则、无 IO、任何异常 try/catch 兜底返回空。
2. `server/routes/api.js`：8 处 `INSERT INTO usage_records` 在落库前用 `buildUsagePluginMeta(ctxMeta, messages, system, req)` 合并
   pluginMeta + customInstructions；无命中不写键（零额外开销）。
3. `server/routes/admin.js`：/usage-logs 列表补 `custom_instruction_count`；/:id 详情返回 plugin_meta（含 customInstructions）；
   /export 增加 `custom_instructions_files` 列（文件名逗号拼接 + CSV 转义）。
4. `public/js/admin.js`（管理后台）：列表命中行显示 `📄 N` 徽标；详情新增「自定义提示词」区块（file/source/chars/truncated，内容折叠可展开 pre 滚动）。
5. `lang/zh.json` / `lang/en.json`：补 i18n 文案。

## 验证
- node --check 全部改动文件。
- initdb 本地 PG（端口 5433），起 CrewRouter 测试实例（端口 20008+，CR_* 指向本地库）。
- 构造 claude_code（带 CLAUDE.md）请求 curl 打入，查 usage_records.plugin_meta.customInstructions 正确提取。
- 构造 codex `<user_instructions>` 提取；构造无规则 unknown 请求 → 空数组、不写 customInstructions 键。
- 清理测试数据后 git commit（feat: 调用记录提取并标记自定义提示词文件），不 push。
