# CrewRouter 部署指南

本文档说明如何在你的服务器上部署和运行 CrewRouter。

---

## 〇、交付物清单

购买后，你将收到以下文件，请根据你选择的部署方式使用对应文件。

### 方式一：直接运行（推荐新手）

```
crewrouter/
├── dist/                        ← 核心程序
│   ├── server.js                ← 主程序
│   ├── package.json             ← 依赖声明
│   ├── config.example.json      ← 配置文件模板
│   └── public/                  ← 前端页面资源
├── start.sh                     ← 一键启动脚本
├── docs/
│   └── deployment.md            ← 本文档（部署指南）
└── LICENSE                      ← GNU GPL v3 开源许可证
```

**你需要做的：**

1. 将整个 `crewrouter/` 文件夹上传到服务器
2. `cd crewrouter/dist && npm install --omit=dev`
3. `cp config.example.json config.json` 并编辑配置
4. 运行 `node server.js` 或 `./start.sh`

### 方式二：Docker 部署

```
crewrouter-docker/
├── docker-compose.yml           ← Docker Compose 编排文件
├── .env.example                 ← 环境变量配置模板
├── docs/
│   └── deployment.md            ← 本文档（部署指南）
└── LICENSE                      ← GNU GPL v3 开源许可证
```

Docker 镜像会从容器仓库拉取，无需手动管理程序文件。

**你需要做的：**

1. 将 `crewrouter-docker/` 文件夹上传到服务器
2. `cp .env.example .env` 并编辑配置
3. 运行 `docker compose up -d`

### 你还会收到

| 项目 | 说明 |
|------|------|
| **技术支持联系方式** | 遇到部署问题可联系我们 |

---

## 〇点五、自动更新（直接运行）

在 **直接运行（dist）** 部署下，管理员可在管理后台使用一键更新：

1. 打开 **管理后台 → 系统设置 → 版本与更新**
2. 点击 **检查更新**（也会在登录后台时静默检查；有新版本时顶部提示）
3. 确认后点击 **一键更新**：自动从官方源下载安装包、覆盖程序文件并重启

| 项目 | 说明 |
|------|------|
| 版本接口 | `https://crewrouter.bloret.net/api/version` |
| 更新包 | `https://crewrouter.bloret.net/api/updates/latest` |
| 保留文件 | `config.json`、`node_modules`（依赖变更时会自动 `npm install`）、数据库 |
| Docker | **不支持**容器内一键替换；请拉取新镜像后 `docker compose up -d` |
| 环境变量 | `CR_UPDATE_VERSION_URL` / `CR_UPDATE_PACKAGE_URL` 可覆盖官方地址；`CR_DISABLE_AUTO_UPDATE=1` 禁用应用更新 |

更新包必须是 ZIP 格式，并直接包含可定位到 `server.js` 与 `package.json` 的程序目录；不支持 ZIP 内嵌 tar 包。下载上限为 32 MiB，更新 URL 必须是公网 HTTPS 且不能重定向。依赖发生变化时会调用 `npm install`，因此需要 Node.js 20 或更新版本及 npm registry 网络访问；失败时会尝试从 `dist/data/updates/backup-*` 回滚。

---

## 〇点六、统计信息上报（可选）

自建实例**默认不**上报任何数据。首次进入控制台的管理员会在授权弹窗中决定是否允许；也可在 **管理后台 → 系统设置 → 统计信息上报** 随时开启/关闭，并选择粒度。

开启后实例按 `interval`（默认每 1 小时）向官方服务器发送一次**匿名聚合**使用统计：请求量、Token 消耗、成本、活跃用户/密钥数、请求类型分布，以及可选的模型/供应商分布。明确不含用户名/邮箱/IP、API 密钥与上游密钥、请求与回复正文等隐私信息。

| 配置 | 环境变量 | 说明 |
|------|---------|------|
| `statsReport.enabled` | `CR_STATS_REPORT_ENABLED` | 配置级总开关，`false` 强制关闭（仍需管理员授权才真正上报） |
| `statsReport.url` | `CR_STATS_REPORT_URL` | 上报地址，默认 `https://crewrouter.bloret.net/api/stats-report` |
| `statsReport.token` | `CR_STATS_REPORT_TOKEN` | 可选共享令牌，接收端配置后校验 |
| `statsReport.interval` | `CR_STATS_REPORT_INTERVAL` | 上报间隔（秒），默认 `3600` |
| `statsReport.granularity` | `CR_STATS_REPORT_GRANULARITY` | `detailed`（默认）或 `counts` |

---

## 一、系统要求

| 项目 | 最低要求 |
|------|---------|
| 操作系统 | Linux (推荐 Ubuntu 20.04+) / macOS / Windows |
| Node.js | >= 16.0.0（推荐 20.x LTS） |
| PostgreSQL | >= 14 |
| 内存 | >= 2GB |
| 磁盘 | >= 1GB 可用空间 |
| 网络 | 需要访问上游 AI 供应商 API |

---

## 二、部署方式选择

| 方式 | 适合场景 | 说明 |
|------|---------|------|
| **直接运行** | 快速上手、熟悉 Node.js | 用 Node.js 直接运行，配合 systemd 托管 |
| **Docker 部署** | 生产环境、一键启动 | 自带 PostgreSQL，容器隔离 |

---

## 三、方式一：直接运行

### 3.1 安装 Node.js

如果服务器上还没有 Node.js：

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 验证
node -v  # 应显示 v20.x.x
npm -v
```

### 3.2 安装 PostgreSQL

```bash
# Ubuntu / Debian
sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql

# 创建数据库和用户
sudo -u postgres psql << EOF
CREATE USER crewrouter WITH PASSWORD '你的数据库密码';
CREATE DATABASE crewrouter OWNER crewrouter;
EOF
```

### 3.3 部署应用

```bash
# 上传 dist/ 目录到服务器（通过 scp、rsync 或其他方式）
scp -r dist/ user@your-server:/opt/crewrouter/

# 登录服务器
ssh user@your-server
cd /opt/crewrouter

# 安装生产依赖
npm install --omit=dev

# 创建配置文件
cp config.example.json config.json
```

### 3.4 编辑配置文件

```bash
nano config.json
```

需要修改的关键配置：

```json
{
  "app": {
    "name": "CrewRouter",
    "port": 20003,
    "host": "你的域名或IP",
    "sessionSecret": "替换为任意随机字符串"
  },
  "database": {
    "host": "localhost",
    "port": 5432,
    "name": "crewrouter",
    "user": "crewrouter",
    "password": "你在 3.2 步设置的密码"
  }
}
```

或者用环境变量（推荐，更安全）：

```bash
export CR_DB_PASSWORD="你的数据库密码"
export CR_SESSION_SECRET="随机字符串"
```

使用 PassPort 登录的实例还需在身份提供方创建独立应用，配置允许的回调地址，并设置该应用的凭据：

```bash
export CR_PASSPORT_APP_ID="替换为独立应用的ID"
export CR_PASSPORT_APP_SECRET="替换为独立应用的Secret"
```

也可填写 `config.json` 的 `passport.appId`、`passport.appSecret`。缺少任一项、仍为模板值或仍使用旧版公开的共享 Secret 时，登录不会启动；登录页会显示未配置提示。空配置不会再恢复共享凭据。旧 Secret 已公开，应用所有者还须在 PassPort 侧撤销或轮换它，删除源码默认值不会使上游凭据失效。不要把新 Secret 放入 Git 或发布包。

Demo 插件商店使用独立的 `store.passport` 应用配置，其会话密钥可配置为 `CR_STORE_SESSION_SECRET` 或 `store.passport.sessionSecret`；未显式指定时沿用应用会话密钥。该密钥至少需要 32 字节、应随机生成；默认值、模板值和过短密钥会使商店登录及写操作关闭。轮换商店密钥会使旧商店会话和待授权状态失效。商店仅在 Demo 模式挂载，顶层 PassPort 配置不会自动配置商店。

### 3.5 启动服务

```bash
# 直接启动（测试用）
node server.js

# 看到以下输出表示成功：
# [数据库] 连接成功
# CrewRouter API 服务运行于 http://localhost:20003
```

### 3.6 设置开机自启（systemd）

```bash
sudo tee /etc/systemd/system/crewrouter.service << EOF
[Unit]
Description=CrewRouter AI API Gateway
After=network.target postgresql.service

[Service]
Type=simple
User=crewrouter
WorkingDirectory=/opt/crewrouter
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 创建系统用户（可选）
sudo useradd -r -s /bin/false crewrouter
sudo chown -R crewrouter:crewrouter /opt/crewrouter

# 启动并设为开机自启
sudo systemctl daemon-reload
sudo systemctl enable crewrouter
sudo systemctl start crewrouter

# 查看状态
sudo systemctl status crewrouter
sudo journalctl -u crewrouter -f
```

### 3.7 反向代理（Nginx）

建议在前面加一层 Nginx，用于 SSL 和域名绑定：

```nginx
server {
    listen 80;
    server_name 你的域名;

    location / {
        proxy_pass http://127.0.0.1:20003;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 50m;
    }
}
```

SSL 配置（推荐使用 certbot）：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

应用默认只信任 loopback 来源的代理。若反向代理位于其他主机或容器网段，在 `.env` 中将 `CR_TRUST_PROXY` 设置为可信代理 IP/CIDR 列表；同时在防火墙限制应用端口，使请求只能经过这些代理。不要仅按固定代理跳数信任来源，也不要设置为 `true` 或 `*`。

应用网关接口以及 Playground/对话接口允许最大 50 MiB 的 JSON 请求体，以支持长上下文与图片；其他 JSON 和表单接口限制为 2 MiB。Nginx 的 `client_max_body_size` 是入口上限，仍需服从应用各接口的限制。

---

## 四、方式二：Docker 部署

### 4.1 安装 Docker

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 重新登录生效

# 验证
docker --version
docker compose version
```

### 4.2 部署

```bash
# 创建目录
mkdir -p /opt/crewrouter && cd /opt/crewrouter

# 上传文件（docker-compose.yml 和 .env）
# 将 docker-compose.yml、.env.example 放到此目录

# 创建配置文件
cp .env.example .env
nano .env
```

### 4.3 编辑 .env 文件

```bash
# 必填项
CR_APP_HOST=你的域名或IP
CR_SESSION_SECRET=替换为任意随机字符串
CR_DB_PASSWORD=设置一个强密码

# 可选
CR_EMAIL_ADDRESS=你的邮箱
CR_EMAIL_PASSWORD=邮箱密码
CR_SMTP_HOST=smtp.example.com
```

### 4.4 启动

```bash
docker compose up -d

# 查看日志
docker compose logs -f

# 看到以下输出表示成功：
# [数据库] 连接成功
# CrewRouter API 服务运行于 http://localhost:20003
```

### 4.5 常用命令

```bash
# 查看状态
docker compose ps

# 重启
docker compose restart

# 停止
docker compose down

# 更新版本
docker compose pull
docker compose up -d

# 查看日志
docker compose logs -f crewrouter

# 进入容器调试
docker compose exec crewrouter sh

# 数据库备份
docker compose exec postgres pg_dump -U crewrouter crewrouter > backup.sql
```

---

## 五、首次使用

### 5.1 初始化管理员

1. 浏览器访问 `http://你的域名:20003`
2. 系统会自动跳转到初始化页面
3. 创建管理员账号（用户名 + 密码 + 邮箱）

### 5.2 配置 AI 供应商

1. 登录管理面板：`http://你的域名:20003/admin`
2. 进入「供应商管理」
3. 添加你的 AI API 供应商（OpenAI、Anthropic 等）
4. 填写 API Key 和 Base URL

### 5.3 配置模型

1. 进入「模型管理」
2. 添加可用模型并关联到对应的供应商
3. 设置价格和倍率

### 5.4 创建用户

1. 进入「用户管理」或开放用户注册
2. 用户注册后获得 API Key
3. 用户使用 API Key 调用 `/v1/chat/completions` 等标准 OpenAI 接口

---

## 七、API 使用

CrewRouter 兼容 OpenAI API 格式。将请求发送到你的服务器地址即可。

### Chat Completions

```bash
curl http://你的域名:20003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-你的API-Key" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 查看可用模型

```bash
curl http://你的域名:20003/v1/models \
  -H "Authorization: Bearer sk-你的API-Key"
```

---

## 八、常见问题

### Q: 启动报错 "ECONNREFUSED" 数据库连接失败？

检查 PostgreSQL 是否启动，配置中的数据库地址、端口、密码是否正确。

### Q: 如何更新到新版本？

**直接运行**：
```bash
systemctl stop crewrouter
# 替换 dist/ 中的文件
npm install --omit=dev
systemctl start crewrouter
```

**Docker**：
```bash
docker compose pull && docker compose up -d
```

### Q: 如何备份数据？

备份 PostgreSQL 数据库即可：
```bash
# 直接运行
pg_dump -U crewrouter crewrouter > backup_$(date +%Y%m%d).sql

# Docker
docker compose exec postgres pg_dump -U crewrouter crewrouter > backup_$(date +%Y%m%d).sql
```

### Q: 端口被占用怎么办？

修改 `config.json` 中的 `app.port` 或 `.env` 中的 `CR_APP_PORT`，同时修改 `docker-compose.yml` 中的端口映射。
