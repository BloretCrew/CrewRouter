#!/bin/bash
# ============================================
# CrewRouter 一键部署脚本
#
# 用法：
#   chmod +x deploy.sh && ./deploy.sh
#
# 支持：阿里云 ECS、雨云、任何装了 Docker 的 Linux 服务器
# ============================================

set -e

# ============================================
# 颜色与输出函数
# ============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[信息]${NC} $1"; }
success() { echo -e "${GREEN}[成功]${NC} $1"; }
warn()    { echo -e "${YELLOW}[注意]${NC} $1"; }
error()   { echo -e "${RED}[错误]${NC} $1"; exit 1; }

# ============================================
# 方向键交互选择菜单
#
# 用法: select_menu "标题" "选项1" "选项2" "选项3"
# 结果: SELECTED_INDEX (0-based) 写入全局变量
#
# 操作: ↑↓ 方向键 或 j/k 移动，Enter/空格 确认，数字键直接跳转
# ============================================
select_menu() {
  local title="$1"
  shift
  local options=("$@")
  local count=${#options[@]}
  local current=0
  local ESC=$'\033'

  # 隐藏光标
  tput civis 2>/dev/null || true

  # 清理函数：恢复光标
  cleanup_select() {
    tput cnorm 2>/dev/null || true
  }
  trap cleanup_select EXIT

  # 首次绘制
  draw_menu() {
    # 移动到菜单起始行并重绘
    echo -e "\r${CYAN}${BOLD}${title}${NC}"
    for i in "${!options[@]}"; do
      if [ "$i" -eq "$current" ]; then
        echo -e "  ${GREEN}${BOLD}▸ ${options[$i]}${NC}  "
      else
        echo -e "    ${DIM}${options[$i]}${NC}  "
      fi
    done
    echo -e "${DIM}  操作: ↑↓ 移动  Enter 确认  数字键跳转${NC}"
  }

  # 重绘菜单（清除旧内容后重画）
  redraw_menu() {
    # 光标上移回到菜单顶部
    for ((j = 0; j < count + 2; j++)); do
      echo -ne "\033[1A\033[2K"
    done
    echo -e "\r\033[2K${CYAN}${BOLD}${title}${NC}"
    for i in "${!options[@]}"; do
      if [ "$i" -eq "$current" ]; then
        echo -e "\r\033[2K  ${GREEN}${BOLD}▸ ${options[$i]}${NC}"
      else
        echo -e "\r\033[2K    ${DIM}${options[$i]}${NC}"
      fi
    done
    echo -e "\r\033[2K${DIM}  操作: ↑↓ 移动  Enter 确认  数字键跳转${NC}"
  }

  draw_menu

  while true; do
    read -rsn1 key

    # 检测 ESC 序列（方向键）
    if [[ "$key" == "$ESC" ]]; then
      read -rsn2 -t 0.1 key2 2>/dev/null || true
      case "$key2" in
        '[A') # 上箭头
          current=$(( (current - 1 + count) % count ))
          redraw_menu
          ;;
        '[B') # 下箭头
          current=$(( (current + 1) % count ))
          redraw_menu
          ;;
      esac
    # j/k/vim 风格
    elif [[ "$key" == "k" || "$key" == "K" ]]; then
      current=$(( (current - 1 + count) % count ))
      redraw_menu
    elif [[ "$key" == "j" || "$key" == "J" ]]; then
      current=$(( (current + 1) % count ))
      redraw_menu
    # 数字键直接跳转
    elif [[ "$key" =~ [1-${count}] ]]; then
      current=$(( key - 1 ))
      redraw_menu
    # Enter / 空格确认
    elif [[ "$key" == "" || "$key" == " " ]]; then
      break
    fi
  done

  # 恢复光标
  cleanup_select
  trap - EXIT

  SELECTED_INDEX=$current
}

# ============================================
# Step 1: 检查环境
# ============================================
info "检查系统环境..."

if ! command -v docker &> /dev/null; then
  error "未检测到 Docker。请先安装 Docker：https://docs.docker.com/engine/install/"
fi

if ! docker info &> /dev/null; then
  error "Docker 未启动或当前用户无权限。请执行: sudo usermod -aG docker \$USER"
fi

if command -v docker-compose &> /dev/null; then
  COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  error "未检测到 docker-compose。请安装: https://docs.docker.com/compose/install/"
fi

success "Docker 环境正常 ($COMPOSE_CMD)"

# ============================================
# Step 2: 配置
# ============================================
info "开始配置 CrewRouter..."

# 生成随机密码
SESSION_SECRET=$(openssl rand -hex 32)

# 询问基本配置
echo ""
echo -e "${BLUE}${BOLD}=== CrewRouter 部署配置 ===${NC}"
echo ""

read -p "服务器域名/IP (默认 localhost): " APP_HOST
APP_HOST=${APP_HOST:-localhost}

read -p "服务端口 (默认 20003): " APP_PORT
APP_PORT=${APP_PORT:-20003}

# ---- 数据库配置 ----
echo ""
echo -e "${YELLOW}${BOLD}数据库配置:${NC}"
echo -e "${DIM}  CrewRouter 需要 PostgreSQL 14+ 数据库。${NC}"
echo ""

select_menu "请选择数据库来源:" \
  "自动安装 PostgreSQL — Docker 容器，推荐新手（数据存储在 Docker Volume）" \
  "使用已有数据库 — 自备 PostgreSQL，填写连接信息" \
  "稍后手动配置 — 占位值，后续编辑 .env 文件"

DB_INSTALL_MODE=$SELECTED_INDEX

if [ "$DB_INSTALL_MODE" -eq 0 ]; then
  # ---- 自动安装 PostgreSQL ----
  DB_PASSWORD=$(openssl rand -hex 16)
  DB_HOST="postgres"
  DB_PORT=5432
  DB_NAME="crewrouter"
  DB_USER="crewrouter"
  info "将使用 Docker 内置 PostgreSQL 容器，数据持久化在 Docker Volume 中"

elif [ "$DB_INSTALL_MODE" -eq 1 ]; then
  # ---- 使用已有数据库 ----
  echo ""
  info "请输入已有 PostgreSQL 数据库的连接信息："
  echo -e "${DIM}  请确保数据库版本 ≥ 14，且用户有创建数据库的权限。${NC}"
  echo ""

  read -p "数据库主机 (默认 localhost): " DB_HOST
  DB_HOST=${DB_HOST:-localhost}

  read -p "数据库端口 (默认 5432): " DB_PORT
  DB_PORT=${DB_PORT:-5432}

  read -p "数据库名称 (默认 crewrouter): " DB_NAME
  DB_NAME=${DB_NAME:-crewrouter}

  read -p "数据库用户名 (默认 crewrouter): " DB_USER
  DB_USER=${DB_USER:-crewrouter}

  read -sp "数据库密码: " DB_PASSWORD
  echo ""

  # 尝试测试连接
  info "测试数据库连接..."
  if command -v pg_isready &> /dev/null; then
    if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t 5 &>/dev/null; then
      success "数据库连接正常"
    else
      warn "无法连接到数据库（主机: $DB_HOST:$DB_PORT）"
      warn "这可能是因为数据库/用户还未创建，请手动执行以下 SQL："
      echo ""
      echo -e "  ${CYAN}CREATE USER ${DB_USER} WITH PASSWORD '你的密码';${NC}"
      echo -e "  ${CYAN}CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};${NC}"
      echo ""
      warn "部署将继续，请在数据库就绪后重启 CrewRouter 容器。"
    fi
  else
    warn "未安装 pg_isready，跳过连接测试。请确认数据库可访问。"
  fi

else
  # ---- 稍后手动配置 ----
  DB_PASSWORD="请替换为你的数据库密码"
  DB_HOST="localhost"
  DB_PORT=5432
  DB_NAME="crewrouter"
  DB_USER="crewrouter"
  warn "数据库配置已留为占位值，请稍后编辑 .env 文件填写实际值。"
  warn "需要配置: CR_DB_HOST, CR_DB_PORT, CR_DB_NAME, CR_DB_USER, CR_DB_PASSWORD"
fi

# ============================================
# Step 3: 生成配置文件
# ============================================
info "生成配置文件..."

cat > .env << EOF
# CrewRouter 配置 — 由 deploy.sh 自动生成
# 生成时间: $(date '+%Y-%m-%d %H:%M:%S')

# 应用配置
CR_APP_PORT=${APP_PORT}
CR_APP_HOST=${APP_HOST}
CR_SESSION_SECRET=${SESSION_SECRET}

# 数据库
CR_DB_HOST=${DB_HOST}
CR_DB_PORT=${DB_PORT}
CR_DB_NAME=${DB_NAME}
CR_DB_USER=${DB_USER}
CR_DB_PASSWORD=${DB_PASSWORD}

# 邮件（可选，后续可在管理面板配置）
CR_EMAIL_ADDRESS=
CR_EMAIL_PASSWORD=
CR_SMTP_HOST=
CR_SMTP_PORT=465
CR_SMTP_SSL=true

# 飞书（可选）
CR_FEISHU_APP_ID=
CR_FEISHU_APP_SECRET=
CR_FEISHU_TENANT_KEY=

# GitHub OAuth（可选）
CR_GITHUB_CLIENT_ID=
CR_GITHUB_CLIENT_SECRET=
CR_GITHUB_REDIRECT_URI=
EOF

success "配置文件已生成: .env"

# ============================================
# Step 3.5: 外部数据库 → 生成 override 文件
# ============================================
if [ "$DB_INSTALL_MODE" -eq 1 ]; then
  info "生成 docker-compose.override.yml（外部数据库模式，禁用内置 PostgreSQL）..."

  cat > docker-compose.override.yml << 'OVERRIDEOF'
# 由 deploy.sh 自动生成 — 外部 PostgreSQL 模式
# 当使用自备数据库时，此文件禁用内置 postgres 容器
#
# 如需恢复内置数据库，删除此文件后重新 docker compose up -d
services:
  crewrouter:
    depends_on: []

  postgres:
    profiles:
      - disabled
OVERRIDEOF

  success "已生成 docker-compose.override.yml"
  info "内置 PostgreSQL 容器已禁用，将使用你提供的外部数据库。"
fi

# ============================================
# Step 4: 构建并启动
# ============================================
echo ""
info "正在构建 Docker 镜像（首次构建可能需要几分钟）..."
echo ""

# 使用 override 文件（如存在）
COMPOSE_FILE="docker-compose.yml"
OVERRIDE_FLAG=""
if [ -f "docker-compose.override.yml" ]; then
  OVERRIDE_FLAG="-f docker-compose.override.yml"
fi

$COMPOSE_CMD -f $COMPOSE_FILE $OVERRIDE_FLAG up -d --build

# ============================================
# Step 5: 等待服务就绪
# ============================================
info "等待服务启动..."

MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${APP_PORT}/" | grep -q "200\|301\|302"; then
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  echo -n "."
done
echo ""

if [ $WAITED -ge $MAX_WAIT ]; then
  warn "服务可能还在启动中，请稍后访问 http://${APP_HOST}:${APP_PORT}"
  warn "查看日志: $COMPOSE_CMD -f $COMPOSE_FILE $OVERRIDE_FLAG logs -f"
else
  success "服务已启动！"
fi

# ============================================
# 完成
# ============================================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  CrewRouter 部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  访问地址: ${BLUE}http://${APP_HOST}:${APP_PORT}${NC}"
echo -e "  管理面板: ${BLUE}http://${APP_HOST}:${APP_PORT}/admin${NC}"

if [ "$DB_INSTALL_MODE" -eq 0 ]; then
  echo -e "  数据库:   ${BLUE}Docker 内置 PostgreSQL（Volume: crewrouter-data）${NC}"
elif [ "$DB_INSTALL_MODE" -eq 1 ]; then
  echo -e "  数据库:   ${BLUE}外部 PostgreSQL ${DB_HOST}:${DB_PORT}/${DB_NAME}${NC}"
else
  echo -e "  数据库:   ${YELLOW}待配置 — 请编辑 .env 文件${NC}"
fi

echo ""
echo -e "  ${YELLOW}重要：首次访问请进入管理面板完成初始设置${NC}"
echo ""
echo -e "  常用命令:"
echo -e "    查看日志:   $COMPOSE_CMD -f $COMPOSE_FILE $OVERRIDE_FLAG logs -f"
echo -e "    重启服务:   $COMPOSE_CMD -f $COMPOSE_FILE $OVERRIDE_FLAG restart"
echo -e "    停止服务:   $COMPOSE_CMD -f $COMPOSE_FILE $OVERRIDE_FLAG down"
echo -e "    更新版本:   $COMPOSE_CMD -f $COMPOSE_FILE $OVERRIDE_FLAG up -d --build"
echo ""
echo -e "  配置文件: .env"
if [ -f "docker-compose.override.yml" ]; then
  echo -e "  Compose覆盖: docker-compose.override.yml（外部数据库模式）"
fi
echo ""
