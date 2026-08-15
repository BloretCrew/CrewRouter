# 控制台日志输出规范

## 概述

本项目采用自定义日志系统，无第三方日志库依赖。日志系统集中在 `server.js` 第 17~66 行，实现**双重输出**：控制台（ANSI 彩色）+ 文件（追加写入）。

---

## 日志级别

| 级别 | 方法 | 控制台颜色 | 控制台方法 | 使用场景 |
|------|------|------------|------------|----------|
| **INFO** | `Logger.info()` | 青色 `\x1b[36m` | `console.log` | 正常操作记录（创建、删除、同步等）、启动信息 |
| **SUCCESS** | `Logger.success()` | 绿色 `\x1b[32m` | `console.log` | 操作成功完成（初始化、AI 回复成功、消息发送成功等） |
| **WARN** | `Logger.warn()` | 黄色 `\x1b[33m` | `console.log` | 权限不足、功能未启用、等待超时等 |
| **ERROR** | `Logger.error()` | 红色 `\x1b[31m` | `console.error` | 数据库错误、API 调用失败、异常捕获 |
| **DEBUG** | `Logger.debug()` | 灰色 `\x1b[90m` | `console.log` | 调试输出（仅在 OAuth 登录调试中使用） |
| **REQUEST** | `Logger.request()` | 多色（按方法/状态码） | `console.log` | 所有 HTTP 请求的访问日志 |

**注意**：无运行时日志级别过滤/配置，所有级别始终输出。

---

## 输出格式

### 控制台格式

**通用日志**（info/success/warn/error/debug）：

```
[<ANSI颜色>[LEVEL]</ANSI重置>] <消息内容>
```

示例：
```
[INFO] Crant AI Studio 运行于 http://localhost:21111
[SUCCESS] 数据库表初始化完成。
[ERROR] 数据库初始化错误: Error: connection refused
[WARN] [拒绝访问] 数据库中未找到用户 xxx
[DEBUG] =================== PASS-PORT 登录调试 ===================
```

**请求日志**（request）：

```
<方法颜色>METHOD</重置> URL <状态码颜色>STATUS</重置> <用户颜色>[username]</重置> <青色>DURATIONms</重置> <灰色>[IP]</灰色>
```

示例：
```
GET /api/posts 200 [Detrital] 15ms [::1]
POST /api/login 302 [Guest] 120ms [192.168.1.1]
DELETE /api/posts/123 500 [admin] 200ms [10.0.0.1]
```

**颜色规则**：
- HTTP 方法：GET 绿色，POST 黄色，其他白色
- 状态码：>= 500 红色，>= 400 黄色，其他绿色
- 用户：已登录紫色 `[username]`，未登录灰色 `[Guest]`

### 文件格式

**通用日志**：

```
[<本地时间字符串>] [<LEVEL>] <消息内容>
```

示例：
```
[2026/5/2 14:30:15] [INFO] Crant AI Studio 运行于 http://localhost:21111
[2026/5/2 14:30:15] [ERROR] 数据库初始化错误: ...
```

**请求日志**：

```
[<本地时间字符串>] [REQUEST] METHOD URL STATUS [USER] DURATIONms [IP]
```

示例：
```
[2026/5/2 14:30:15] [REQUEST] GET /api/posts 200 [Detrital] 15ms [::1]
```

---

## 文件日志配置

| 配置项 | 值 |
|--------|-----|
| 日志目录 | `<项目根目录>/log/` |
| 文件名格式 | `BBBS-YYYY-MM-DD-HH-MM-SS.log` |
| 创建模式 | 追加写入 (`flags: 'a'`) |
| 对象参数序列化 | `JSON.stringify()` |
| 非对象参数转换 | `String()` |

---

## 使用约定

### 消息格式

使用中文消息，用**方括号前缀**标识模块/操作：

```javascript
Logger.info(`[数据库迁移] 执行迁移脚本 v${version}`);
Logger.info(`[删除帖子] 用户: ${username}, IP: ${ipLocation}, 板块: ${board}`);
Logger.error('[NapCat] 发送消息失败:', error);
```

常用前缀：
- `[数据库迁移]` - 数据库迁移操作
- `[创建板块]` / `[创建分区]` / `[重命名板块]` - 板块管理
- `[删除帖子]` - 帖子删除
- `[拒绝访问]` / `[canAccessBoard 错误]` - 权限相关
- `[获取帖子列表]` / `[获取所有帖子]` - 查询操作
- `[表情回应]` - 表情功能
- `[举报]` / `[举报检查]` - 举报功能
- `[NapCat]` - NapCat 集成
- `[PCL 首页]` - PCL 客户端
- `[同步处理]` - 用户数据同步
- `[定时帖子任务]` / `[定时评论任务]` - 定时任务

### 上下文信息

操作日志应包含用户、IP、目标等上下文：

```javascript
Logger.info(`[删除帖子] 用户: ${username}, IP: ${ipLocation}, 板块: ${board}, 分区: ${section}, 文件名: ${data.filename}`);
```

### 错误日志

错误日志通常直接传入 error 对象：

```javascript
Logger.error('向 users 表添加 title 列失败:', e);
```

---

## 相关代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `server.js` | 17-26 | 日志文件配置（目录创建、文件路径、写入流） |
| `server.js` | 28-32 | `writeToFile()` 函数 - 文件日志写入 |
| `server.js` | 35-66 | `Logger` 对象定义 - 全部日志方法 |
| `server.js` | 56-65 | `Logger.request()` - HTTP 请求日志格式化 |
| `server.js` | 610-618 | Express 日志中间件 - 自动记录所有请求 |
| `server.js` | 6054-6061 | 服务器启动日志输出 |

---

## 前端日志

前端代码仅使用原生 `console.error()`，无自定义日志封装：

- `public/js/page-editor.js` - 组件/布局加载错误
- `public/js/component-renderer.js` - 组件渲染/脚本执行错误
