# CPA 额度查询

CrewRouter 支持通过 CPA v8 的额度插件查询账号额度。现有手动刷新、定时查询、后台额度详情和控制台额度展示共用该适配器。

## 服务器配置

在 CrewRouter 服务环境中设置：

```sh
CPA_MANAGEMENT_URL=http://127.0.0.1:8317
CPA_MANAGEMENT_KEY=<CPA 管理密钥>
```

管理地址默认是 `http://127.0.0.1:8317`，也接受以 `/v8/management` 结尾的地址。管理密钥仅从服务器环境读取，不写入供应商配置或下发浏览器。请求禁止重定向，避免管理密钥泄露。请只配置可信 CPA 服务。

## 供应商配置

1. 在后台编辑供应商，启用额度查询，选择 CPA 额度插件查询方式。
2. 在同一编辑窗口填写「CPA 额度插件 ID」和「CPA 账号凭据索引」。
3. 点击保存，配置与供应商设置一起持久化；随后点击查询额度。

已有 CPA JSON 配置自动回填到这两个字段。切换到其他查询方式时，CPA 字段隐藏，现有额度脚本保持原值。

插件 ID 可通过 CPA `GET /v8/management/plugins` 获取；该插件需要支持目标供应商的额度查询。凭据索引通过 CPA `GET /v8/management/credentials` 获取。上述接口均需要管理密钥。

CrewRouter 调用 `GET /v8/management/plugins/{plugin_id}/quota?auth_index={auth_index}`。独立额度窗口分别展示，主额度使用剩余比例最低的窗口。支持 CPA 的 camelCase 和 snake_case 额度字段，也支持数值摘要中的 `balance` 或 `remaining`。无有效数据时明确报错。v0 接口不做自动降级。

本适配器使用管理员指定的账号关联。配置前请确认该账号应向哪些用户或 Team 展示，现有供应商权限控制继续生效。该功能不自动导入 OAuth 账号，不改变请求路由或额度耗尽后的模型调度。

## 测试

`npm run test:quota-usage` 包含 CPA 归一化、隔离 HTTP 服务查询、鉴权、错误状态及重定向测试。真实额度查询需要运行 CPA 并配置额度插件和账号。
