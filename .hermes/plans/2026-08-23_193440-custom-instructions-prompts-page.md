# 提示词页面：历史自定义提示词聚合展示（重复合并）

## 目标
控制台新增「提示词」页面，展示历史收集到的自定义提示词文件（usage_records.plugin_meta->'customInstructions'），
按内容指纹去重合并显示；管理后台同步加入口。与现有「调用记录」页风格一致（筛选栏 + 表格 + 分页 + 详情弹窗）。

## 实现
1. 后端新文件 `server/routes/admin-custom-instructions.js`，挂载到 `/api/admin`（server/index.js）：
   - `GET /api/admin/custom-instructions`：SQL 侧 `jsonb_array_elements` 展开聚合。
     - 指纹 = sha256(file + content)（file 为空用 source + content），Node 侧 crypto 计算；
       SQL 按 (file, source, content) 分组，与指纹分组一一对应。
     - 聚合字段：first_seen(min created_at)、last_seen(max)、count、user_count(distinct user_id)、
       chars(max)、truncated(bool_or)、positions、sample_record_id、preview(前 160 字符)。
     - query：page/pageSize、search(file/content ILIKE)、source 精确匹配、
       sort ∈ count|first_seen|last_seen（白名单，均 DESC）。
     - 扫描窗口：先取最近 N 天内最新 M 条 usage_records 再展开
       （CR_CI_SCAN_DAYS 默认 30、CR_CI_SCAN_MAX_RECORDS 默认 200000，process.env 可配）。
   - `GET /api/admin/custom-instructions/:fingerprint`：复用聚合逻辑定位该指纹，
     返回完整 content + positions + 最近 10 条引用记录（record id/时间/user/username/model/request_source）。
   - 自动迁移：模块内懒执行 `CREATE INDEX IF NOT EXISTS idx_usage_records_plugin_meta_gin
     ON usage_records USING gin(plugin_meta jsonb_path_ops)`（同 login-report.js ensureTable 模式），
     失败仅告警不阻断。requireAuth + requireAdmin。
2. 前端控制台（public/pages/console.html + public/js/app.js）：
   - 侧边栏「操作日志」下新增「提示词」导航项（data-page="prompts"，默认隐藏，isAdmin 时显示）。
   - 新页面 promptsPage：搜索框 + 来源筛选（复用 request_source 色系徽章）+ 排序 + 分页表格
     （文件名/来源/字符数/出现次数/关联用户/首次出现/最近出现）。
   - promptDetailModal 弹窗：元信息 + 完整内容 pre + 最近引用记录表。
   - app.js：titles、loadPage 分支、loadCustomPrompts/showCustomPromptDetail 方法（复用
     _usageRequestSourceMeta/_usageRequestSourceBadge）。
3. 管理后台（public/pages/admin.html + public/js/admin.js）：nav 加 adminPrompts、
   adminPromptsPage 页面区 + 详情弹窗，admin.js 加 titles/loadPage 分支与加载方法（各自实现，复用徽章函数）。
4. lang/zh.json / lang/en.json 补新增文案（已存在的 key 不重复添加）。

## 验证
- node --check 全部改动 js 文件。
- 本地 PG 5433 建独立测试库跑 init-db；CR_APP_PORT=20008 + CR_DB_* 指向测试库起实例（生产 20003/20004 不动）。
- psql 直插假 usage_records：多用户 × 重复 CLAUDE.md（相同内容跨 harness）、内容变体、AGENTS.md/.cursorrules、
  非 array plugin_meta、无 plugin_meta、超 30 天旧记录（应被窗口排除）。
- curl 登录拿会话后验证：去重计数正确、search/source/sort/pagination 正常、详情接口指纹命中与引用记录正确。
- 测完 drop 测试库并停实例；git 提交 docs（本计划）+ feat，不 push。
