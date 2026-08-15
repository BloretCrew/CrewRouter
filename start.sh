#!/bin/bash
# ============================================
# CrewRouter 直接运行启动脚本
#
# 用法：在 dist/ 目录下执行 ./start.sh
# 或者：在项目根目录执行 ./start.sh（自动构建）
#
# 首次运行时引导配置数据库连接，写入 config.json
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
# ============================================
select_menu() {
  local title="$1"
  shift
  local options=("$@")
  local count=${#options[@]}
  local current=0
  local ESC=$'\033'

  tput civis 2>/dev/null || true
  cleanup_select() { tput cnorm 2>/dev/null || true; }
  trap cleanup_select EXIT

  draw_menu() {
    echo -e "\r${CYAN}${BOLD}${title}${NC}"
    for i in "${!options[@]}"; do
      if [ "$i" -eq "$current" ]; then
        echo -e "  ${GREEN}${BOLD}▸ ${options[$i]}${NC}"
      else
        echo -e "    ${DIM}${options[$i]}${NC}"
      fi
    done
    echo -e "${DIM}  操作: ↑↓ 移动  Enter 确认  数字键跳转${NC}"
  }

  redraw_menu() {
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
    if [[ "$key" == "$ESC" ]]; then
      read -rsn2 -t 0.1 key2 2>/dev/null || true
      case "$key2" in
        '[A') current=$(( (current - 1 + count) % count )); redraw_menu ;;
        '[B') current=$(( (current + 1) % count )); redraw_menu ;;
      esac
    elif [[ "$key" == "k" || "$key" == "K" ]]; then
      current=$(( (current - 1 + count) % count )); redraw_menu
    elif [[ "$key" == "j" || "$key" == "J" ]]; then
      current=$(( (current + 1) % count )); redraw_menu
    elif [[ "$key" =~ [1-${count}] ]]; then
      current=$(( key - 1 )); redraw_menu
    elif [[ "$key" == "" || "$key" == " " ]]; then
      break
    fi
  done

  cleanup_select
  trap - EXIT
  SELECTED_INDEX=$current
}

# ============================================
# 检测当前目录
# ============================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "server.js" ] && [ -f "package.json" ]; then
  WORK_DIR="."
elif [ -f "dist/server.js" ] && [ -f "dist/package.json" ]; then
  if [ ! -d "dist/node_modules" ]; then
    info "首次运行，先安装依赖..."
    cd dist && npm install --omit=dev && cd ..
  fi
  WORK_DIR="dist"
else
  error "未找到 dist/server.js，请先运行 npm run build"
fi

cd "$WORK_DIR"

# 检查依赖
if [ ! -d "node_modules" ]; then
  info "安装生产依赖..."
  npm install --omit=dev
fi

# ============================================
# 首次配置向导
# ============================================
CONFIG_FILE="config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  info "首次运行，启动配置向导..."
  echo ""
  echo -e "${BLUE}${BOLD}========================================${NC}"
  echo -e "${BLUE}${BOLD}  CrewRouter 首次配置向导${NC}"
  echo -e "${BLUE}${BOLD}========================================${NC}"
  echo ""

  # ---- 基本配置 ----
  SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')

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
    "自动安装 PostgreSQL（本机，推荐新手）" \
    "使用已有数据库（自备 PostgreSQL）" \
    "稍后手动配置"

  DB_CHOICE=$SELECTED_INDEX

  if [ "$DB_CHOICE" -eq 0 ]; then
    # ---- 自动安装 PostgreSQL ----
    echo ""
    info "将在本机安装 PostgreSQL..."

    # 检测系统类型
    if command -v apt-get &> /dev/null; then
      PKG_MANAGER="apt"
      info "检测到 Debian/Ubuntu 系统"
      sudo apt-get update -qq
      sudo apt-get install -y -qq postgresql postgresql-contrib
      sudo systemctl start postgresql
      sudo systemctl enable postgresql
    elif command -v dnf &> /dev/null; then
      PKG_MANAGER="dnf"
      info "检测到 Fedora/RHEL 系统"
      sudo dnf install -y postgresql-server postgresql-contrib
      sudo postgresql-setup --initdb
      sudo systemctl start postgresql
      sudo systemctl enable postgresql
    elif command -v yum &> /dev/null; then
      PKG_MANAGER="yum"
      info "检测到 CentOS 系统"
      sudo yum install -y postgresql-server postgresql-contrib
      sudo postgresql-setup --initdb
      sudo systemctl start postgresql
      sudo systemctl enable postgresql
    elif command -v pacman &> /dev/null; then
      PKG_MANAGER="pacman"
      info "检测到 Arch Linux 系统"
      sudo pacman -S --noconfirm postgresql
      sudo -u postgres initdb -D /var/lib/postgres/data
      sudo systemctl start postgresql
      sudo systemctl enable postgresql
    else
      error "无法识别系统包管理器。请手动安装 PostgreSQL 14+，然后选择「使用已有数据库」。"
    fi

    success "PostgreSQL 已安装并启动"

    # 创建数据库和用户
    DB_PASSWORD=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    DB_HOST="localhost"
    DB_PORT=5432
    DB_NAME="crewrouter"
    DB_USER="crewrouter"

    info "创建数据库用户和数据库..."
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" 2>/dev/null || \
      warn "用户 $DB_USER 已存在，跳过创建"
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || \
      warn "数据库 $DB_NAME 已存在，跳过创建"

    success "数据库已创建: $DB_NAME (用户: $DB_USER)"
    echo -e "  ${DIM}数据库密码: $DB_PASSWORD${NC}"
    echo -e "  ${DIM}（已自动写入 config.json，请妥善保管）${NC}"

  elif [ "$DB_CHOICE" -eq 1 ]; then
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

    # 测试连接
    info "测试数据库连接..."
    if command -v pg_isready &> /dev/null; then
      if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t 5 &>/dev/null; then
        success "数据库连接正常"
      else
        warn "无法连接到数据库（$DB_HOST:$DB_PORT）"
        warn "请手动执行以下 SQL 创建数据库和用户："
        echo ""
        echo -e "  ${CYAN}CREATE USER ${DB_USER} WITH PASSWORD '你的密码';${NC}"
        echo -e "  ${CYAN}CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};${NC}"
        echo ""
        warn "配置已写入 config.json，请在数据库就绪后重新运行 start.sh。"
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
    warn "数据库配置已留为占位值，请稍后编辑 config.json 填写实际值。"
  fi

  # ---- 生成 config.json ----
  info "生成配置文件..."

  cat > "$CONFIG_FILE" << EOF
{
  "app": {
    "name": "CrewRouter",
    "port": ${APP_PORT},
    "host": "${APP_HOST}",
    "sessionSecret": "${SESSION_SECRET}",
    "demo": false
  },
  "database": {
    "host": "${DB_HOST}",
    "port": ${DB_PORT},
    "name": "${DB_NAME}",
    "user": "${DB_USER}",
    "password": "${DB_PASSWORD}"
  },
  "demo": false
}
EOF

  success "配置文件已生成: $CONFIG_FILE"
  echo ""

fi

# ============================================
# 启动
# ============================================
info "启动 CrewRouter..."
exec node server.js
