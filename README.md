<img src="ico.png" width="160" height="160" alt="CrewRouter" align="left" />
<div align="center">
  <h1>CrewRouter</h1>
  <p>
    一个 API 端点，接入所有 AI 模型。<br>
    智能路由、精细管控、实时洞察，为团队而生。
  </p>
</div>

<br clear="all" />

<div align="center">

[![Build & Release](https://github.com/BloretCrew/CrewRouter/actions/workflows/build-docker.yml/badge.svg)](https://github.com/BloretCrew/CrewRouter/actions/workflows/build-docker.yml)
![仓库大小](https://img.shields.io/github/repo-size/BloretCrew/CrewRouter?style=social&label=%E4%BB%93%E5%BA%93%E5%A4%A7%E5%B0%8F)
![星标数](https://img.shields.io/github/stars/BloretCrew/CrewRouter?style=social&label=%E6%98%9F%E6%A0%87)
![许可证](https://img.shields.io/github/license/BloretCrew/CrewRouter?label=License)
[![最新正式版](https://img.shields.io/github/v/release/BloretCrew/CrewRouter?label=%E6%9C%80%E6%96%B0%E6%AD%A3%E5%BC%8F%E7%89%88)](https://github.com/BloretCrew/CrewRouter/releases)
![Docker](https://img.shields.io/badge/Docker-detritalw%2Fcrewrouter-2496ED?logo=docker&logoColor=white)

**团队级 AI 模型统一网关** · OpenAI / Anthropic 双协议 · 自托管

[演示控制台](https://router.crantai.com/) · [部署指南](docs/deployment.md) · [架构说明](docs/ARCHITECTURE.md) · [API 文档](docs/API.md)

</div>

---

## 它是什么

CrewRouter 把多家上游模型供应商收成 **一个 OpenAI / Anthropic 兼容端点**。团队成员只拿网关下发的 Key，用 Claude Code、Codex、Cursor、OpenCode、Cherry Studio 等工具时，只需改 `base_url`。供应商密钥留在网关里，成员有使用权、没有所有权。

应用 → **CrewRouter** → OpenAI / Anthropic / DeepSeek / 更多…

## 核心功能

- [x] **多供应商聚合** — OpenAI、Anthropic、DeepSeek 等，一个端点全部接入
- [x] **协议自动转换** — OpenAI ↔ Anthropic 双向转换，用 OpenAI SDK 调 Claude，或反过来
- [x] **智能路由** — 按团队分配模型，支持别名、上游映射和自定义规则
- [x] **Fusion 模式** — 同一请求并发多个模型，裁判模型评估并综合最优回答
- [x] **实时统计** — 请求量、Token、延迟、成本；按模型 / Key / 时间下钻
- [x] **API Key 管理** — 时间调度、模型绑定、自定义签名、独立 Fusion 配置
- [x] **多因素认证** — TOTP、WebAuthn PassKey、飞书 / GitHub OAuth
- [x] **动态密钥刷新** — 供应商 Key 可用脚本定时轮换并缓存
- [x] **代理池** — 每供应商独立代理，支持订阅导入，应对跨境与 429
- [x] **团队与权限** — 个人 / 默认 / 前沿团队分层，配合用户组限额
- [x] **灵活计费** — Token 倍率、兑换码、余额告警、可退款余额
- [x] **密钥隔离** — 上游地址与 Key 对成员和本地工具不可见
- [x] **Playground** — 控制台内交互调试与会话历史
- [x] **开箱向导** — 首次启动 OOBE 完成数据库与管理员配置
- [x] **深浅色主题** — 跟随系统或手动切换

## 兼容的客户端

只需更换 `base_url`，无需改业务代码：

Claude Code · Claude Desktop · Codex · OpenCode · OpenClaw · Hermes Agent · Kilo Code · Cline · Cherry Studio · Qwen Code · Cursor · 以及一切走 OpenAI / Anthropic 协议的工具

```bash
# 只需更换 base_url
curl https://your-host/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-host/v1",
    api_key="sk-your-key",
)
resp = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## 快速开始

### 方式一：一键包（推荐）

从 **[GitHub Releases](https://github.com/BloretCrew/CrewRouter/releases)** 下载 `crewrouter-direct-v*.tar.gz`（由 CI 自动构建），上传到服务器后：

```bash
tar xzf crewrouter-direct-v*.tar.gz
cd crewrouter-direct
./start.sh
```

`start.sh` 会在首次运行时自动安装依赖、引导配置数据库（支持自动安装 PostgreSQL 或连接已有实例）并生成 `config.json`，随后自动启动服务。浏览器打开 `http://your-server:20003` 即可使用。

> [!TIP]
> 一键包支持管理后台**一键更新**：进入 管理后台 → 系统设置 → 版本与更新，点击检查更新并确认后自动拉取官方更新包、覆盖程序并重启，`config.json` 与数据库均保留。详见 [docs/deployment.md](docs/deployment.md)。

### 方式二：Docker

```bash
cp .env.example .env   # 填写 CR_SESSION_SECRET、CR_DB_PASSWORD 等
docker compose up -d
```

浏览器打开 `http://localhost:20003`，按开箱向导完成初始化。

镜像：[`detritalw/crewrouter`](https://hub.docker.com/r/detritalw/crewrouter)，亦可使用 CI 推送的 `ghcr.io` 镜像。Docker 部署不支持容器内一键更新，升级请拉取新镜像后 `docker compose up -d`。

### 方式三：源码运行

需要 **Node.js ≥ 16**（建议 20 LTS）和 **PostgreSQL ≥ 14**。

```bash
npm install
cp config.example.json config.json   # 填写数据库与 sessionSecret
# 创建数据库用户与库，例如：
#   CREATE USER crewrouter WITH PASSWORD '...';
#   CREATE DATABASE crewrouter OWNER crewrouter;
npm run init-db
npm start          # 开发可用 npm run dev
```

默认监听配置中的端口（示例为 `20003`）。生产部署、systemd 托管见 **[docs/deployment.md](docs/deployment.md)**。

> [!NOTE]
> 演示站可在管理员开启 `demo` 后访问公开展示页与只读控制台，无需注册即可浏览界面。自托管默认 `demo: false`。

## 配置要点

`config.json`（或 Docker 环境变量 `CR_*`）中最常改的几项：

| 项 | 说明 |
|----|------|
| `app.port` / `CR_APP_PORT` | 监听端口，默认 `20003` |
| `app.sessionSecret` | 会话密钥，生产环境必须更换 |
| `database.*` / `CR_DB_*` | PostgreSQL 连接 |
| `initialProviders` / `initialModels` | 首次初始化写入的供应商与模型 |
| `feishu` / GitHub OAuth | 可选企业登录 |
| `email` | 可选 SMTP（余额告警等） |

完整字段见 `config.example.json` 与 [docs/deployment.md](docs/deployment.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/deployment.md](docs/deployment.md) | 直接运行 / Docker / 更新 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 目录结构、路由与适配器 |
| [docs/API.md](docs/API.md) | HTTP API |
| [docs/integration-guide.md](docs/integration-guide.md) | 接入现有应用 |
| [LOG_SPEC.md](LOG_SPEC.md) | 运行日志约定 |

## 技术栈

- **运行时** Node.js · Express
- **数据** PostgreSQL
- **前端** 原生 HTML / CSS / JS（控制台、管理后台、Playground、Showcase）
- **安全** Session、TOTP、WebAuthn、OAuth、SSRF 校验

## 开源许可

本项目以 **GNU General Public License v3.0** 发布。

- 你可以自由使用、修改和分发
- 衍生作品须同样以 GPL-3.0 发布
- 详见 [LICENSE](./LICENSE)

## 星标历史

 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=BloretCrew/CrewRouter&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=BloretCrew/CrewRouter&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=BloretCrew/CrewRouter&type=Date" />
 </picture>

## 相关链接

[Bloret Crew](https://github.com/BloretCrew) · [Bloret Launcher](https://github.com/BloretCrew/Bloret-Launcher) · [演示站](https://router.crantai.com/)
