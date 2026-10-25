# 自动更新包目录

将最新发布包命名为 `latest.zip` 放在此目录后，本机可通过：

- `GET /api/version` — 返回当前 `package.json` 版本
- `GET /api/updates/latest` — 下载 `latest.zip`

客户实例会从官方源（默认 `https://crewrouter.bloret.net`）检查版本并一键更新。

## 生成 latest.zip

推荐执行交付打包（会同步写出本目录下的 `latest.zip`）：

```bash
./deploy/pack-delivery.sh
```

也可手动打包 `crewrouter-direct/`（内含 `dist/server.js` 等）为 zip。

## 包结构要求

解压后须能定位到同时包含 `server.js` 与 `package.json` 的目录，例如：

```
crewrouter-direct/dist/server.js
crewrouter-direct/dist/package.json
crewrouter-direct/dist/public/
```

ZIP 更新包最大 32 MiB，必须直接包含上述程序目录；不支持嵌套 `*.tar.gz`。更新程序会拒绝重定向，并要求更新 URL 为公网 HTTPS 地址。
