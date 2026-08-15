# ==========================================================
# CrewRouter Docker 多阶段构建
#
# Stage 1: build — 安装依赖、打包、混淆
# Stage 2: release — 精简镜像，仅含混淆后产物
# ==========================================================

# ---- Stage 1: Build ----
FROM node:22-alpine AS build

WORKDIR /app

# 安装构建工具依赖
COPY package.json package-lock.json* ./
RUN npm ci

# 复制构建脚本
COPY deploy/build/ ./deploy/build/

# 复制源代码
COPY server/ ./server/
COPY public/ ./public/
COPY config.example.json ./

# 执行构建：bundle → obfuscate → package
RUN node deploy/build/build-release.js release

# ---- Stage 2: Release ----
FROM node:22-alpine AS release

# 安全加固：创建非 root 用户
RUN addgroup -S crewrouter && adduser -S crewrouter -G crewrouter

WORKDIR /app

# 仅复制构建产物
COPY --from=build /app/dist/ ./

# 安装生产依赖
RUN npm install --omit=dev --ignore-scripts && \
    npm cache clean --force

# 创建日志目录
RUN mkdir -p /app/log && chown -R crewrouter:crewrouter /app

# 切换到非 root 用户
USER crewrouter

# 暴露端口
EXPOSE 20003

# 环境变量默认值
ENV CR_APP_PORT=20003 \
    NODE_ENV=production

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:20003/ || exit 1

# 启动命令
CMD ["node", "server.js"]
