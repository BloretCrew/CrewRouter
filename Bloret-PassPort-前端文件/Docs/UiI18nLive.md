# UI 实时译文（tr.bloret.net）

PassPort 界面文案可走 [Bloret Translation](https://tr.bloret.net) 的公开接口，与启动器 / 第三方同源。

## 接口

| 步骤 | 方法 |
|------|------|
| 1 | `GET /api/v1/orgs/{orgSlug}/projects/{projectSlug}/manifest` |
| 2 | `GET /api/v1/orgs/{orgSlug}/projects/{projectSlug}/files/{fileId}/translated?locale=&mode=top_voted` |

完整说明见 Translation Collector 仓库 `docs/PublicAPI.md`。

本站项目：

- 组织 / 项目：`bloret` / `bloret-passport`
- 源文件：`zh.json`，`fileId` = `f0c1f063-cf0e-45e1-935b-a987054d91ed`

## 配置

`config.json` → `uiI18n`：

```json
{
  "uiI18n": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:20005",
    "orgSlug": "bloret",
    "projectSlug": "bloret-passport",
    "fileId": "f0c1f063-cf0e-45e1-935b-a987054d91ed",
    "localeMap": { "en": "en", "ru": "ru" },
    "mode": "top_voted",
    "fallbackMt": false,
    "cacheTtlMs": 60000,
    "timeoutMs": 8000
  }
}
```

- `baseUrl`：同机部署建议回环地址；也可写 `https://tr.bloret.net`。
- `zh` 仍用磁盘 `lang/zh.json`（source-as-key）；`en` / `ru` 拉 live 后与磁盘合并（**仅非空 live 覆盖**，BTC 尚无译文时继续用磁盘）。

## 实现

- `ui-i18n-live.js` — 拉 manifest / translated、TTL 缓存
- `i18n.js` — 中间件在请求前 `ensureLiveCatalog`，`t()` 读合并后的目录

关闭：`uiI18n.enabled: false`，行为与仅磁盘语言包一致。
