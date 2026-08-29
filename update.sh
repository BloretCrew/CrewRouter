#!/usr/bin/env bash
# 重新构建并重启 CrewRouter。
#
# 用法：
#   ./update.sh /path/to/runtime
#   RUNTIME_DIR=/path/to/runtime ./update.sh
#
# runtime 目录需要包含：
#   app/start.sh       启动脚本
#   app/server.pid     当前服务 PID（可选）

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${1:-${RUNTIME_DIR:-$PROJECT_ROOT/.runtime}}"
APP_DIR="$RUNTIME_DIR/app"
START_SCRIPT="${START_SCRIPT:-$APP_DIR/start.sh}"
PID_FILE="${PID_FILE:-$APP_DIR/server.pid}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:25404/api/version}"

info() { printf '[信息] %s\n' "$*"; }
success() { printf '[成功] %s\n' "$*"; }
error() { printf '[错误] %s\n' "$*" >&2; exit 1; }

[ -x "$START_SCRIPT" ] || error "找不到可执行启动脚本：$START_SCRIPT"

cd "$PROJECT_ROOT"
info "开始构建最新代码..."
npm run build
success "构建完成"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
    info "停止旧服务（PID $PID）..."
    kill "$PID"
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$PID" 2>/dev/null; then
      info "旧服务未正常退出，强制停止（PID $PID）..."
      kill -9 "$PID"
    fi
  fi
fi

mkdir -p "$APP_DIR"
info "启动更新后的服务..."
nohup "$START_SCRIPT" > "$APP_DIR/server.log" 2>&1 &
NEW_PID=$!
printf '%s\n' "$NEW_PID" > "$PID_FILE"

for _ in $(seq 1 90); do
  if curl -fsS "$HEALTH_URL" > "$APP_DIR/version.json"; then
    success "服务已更新并启动"
    printf '地址：%s\n' "${HEALTH_URL%/api/version}"
    printf 'PID：%s\n' "$NEW_PID"
    exit 0
  fi
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    tail -80 "$APP_DIR/server.log" >&2 || true
    error "服务启动失败"
  fi
  sleep 1
done

tail -80 "$APP_DIR/server.log" >&2 || true
error "服务启动超时"
