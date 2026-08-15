#!/bin/bash
# ============================================
# CrewRouter 交付物打包脚本
#
# 用法：./deploy/pack-delivery.sh
#
# 产物：
#   release/crewrouter-direct/    ← 直接运行交付包
#   release/crewrouter-docker/    ← Docker 交付包
#   release/crewrouter-direct.tar.gz
#   release/crewrouter-docker.tar.gz
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[信息]${NC} $1"; }
success() { echo -e "${GREEN}[完成]${NC} $1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="$ROOT/release"
DIRECT_DIR="$RELEASE_DIR/crewrouter-direct"
DOCKER_DIR="$RELEASE_DIR/crewrouter-docker"
VERSION=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "1.0.0")

# 清理旧产物
rm -rf "$RELEASE_DIR"
mkdir -p "$DIRECT_DIR" "$DOCKER_DIR"

# ============================================
# Step 1: 构建
# ============================================
info "构建 dist/ ..."
cd "$ROOT"
node deploy/build/build-release.js release

# ============================================
# Step 2: 打包直接运行交付物
# ============================================
info "打包直接运行交付物..."

# 复制 dist/
cp -r "$ROOT/dist" "$DIRECT_DIR/dist"

# 复制启动脚本
cp "$ROOT/start.sh" "$DIRECT_DIR/"
chmod +x "$DIRECT_DIR/start.sh"

# 复制文档
mkdir -p "$DIRECT_DIR/docs"
cp "$ROOT/docs/deployment.md" "$DIRECT_DIR/docs/"

# 复制许可证
cp "$ROOT/LICENSE" "$DIRECT_DIR/"

# 打包
cd "$RELEASE_DIR"
tar czf "crewrouter-direct-v${VERSION}.tar.gz" crewrouter-direct/
success "crewrouter-direct-v${VERSION}.tar.gz ($(du -h "crewrouter-direct-v${VERSION}.tar.gz" | cut -f1))"

# 生成自动更新包 updates/latest.zip（官方站可托管；客户端兼容 zip 内嵌 tar.gz）
info "生成 updates/latest.zip（自动更新用）..."
UPDATES_DIR="$ROOT/updates"
mkdir -p "$UPDATES_DIR"
rm -f "$UPDATES_DIR/latest.zip"
# 优先打扁平 crewrouter-direct 目录，便于解压后定位 dist/server.js
(
  cd "$RELEASE_DIR"
  zip -qr "$UPDATES_DIR/latest.zip" crewrouter-direct
)
# 同时放入 tar.gz，兼容仅提供归档的旧流程
# （若已有目录树，zip 内再塞 tar.gz 非必须；此处额外复制一份到 release 便于分发）
cp "$RELEASE_DIR/crewrouter-direct-v${VERSION}.tar.gz" "$UPDATES_DIR/crewrouter-direct-v${VERSION}.tar.gz" 2>/dev/null || true
success "updates/latest.zip ($(du -h "$UPDATES_DIR/latest.zip" | cut -f1))"

# ============================================
# Step 3: 打包 Docker 交付物
# ============================================
info "打包 Docker 交付物..."

# 复制 docker-compose.yml
cp "$ROOT/docker-compose.yml" "$DOCKER_DIR/"

# 复制 .env.example
cp "$ROOT/.env.example" "$DOCKER_DIR/"

# 复制文档
mkdir -p "$DOCKER_DIR/docs"
cp "$ROOT/docs/deployment.md" "$DOCKER_DIR/docs/"

# 复制许可证
cp "$ROOT/LICENSE" "$DOCKER_DIR/"

# 创建说明文件
cat > "$DOCKER_DIR/README.txt" << 'EOF'
CrewRouter Docker 部署说明
==========================

1. 安装 Docker（如果还没有）：
   curl -fsSL https://get.docker.com | sh

2. 创建配置文件：
   cp .env.example .env
   nano .env    # 编辑配置

3. 启动服务：
   docker compose up -d

4. 访问：
   http://你的服务器IP:20003

5. 常用命令：
   docker compose logs -f    # 查看日志
   docker compose restart    # 重启
   docker compose down       # 停止

详细说明请参考 docs/deployment.md
EOF

# 打包
cd "$RELEASE_DIR"
tar czf "crewrouter-docker-v${VERSION}.tar.gz" crewrouter-docker/
success "crewrouter-docker-v${VERSION}.tar.gz ($(du -h "crewrouter-docker-v${VERSION}.tar.gz" | cut -f1))"

# ============================================
# 完成
# ============================================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  交付物打包完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "  产物目录: $RELEASE_DIR/"
echo ""
echo "  直接运行: crewrouter-direct-v${VERSION}.tar.gz"
echo "    └── 客户解压后 npm install --omit=dev && node server.js"
echo ""
echo "  Docker:   crewrouter-docker-v${VERSION}.tar.gz"
echo "    └── 客户解压后配置 .env && docker compose up -d"
echo ""
