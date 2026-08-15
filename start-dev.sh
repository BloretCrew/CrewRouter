#!/bin/bash
# 自动加载 NVM 环境变量
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 切换到项目目录（可选，保险起见）
cd "$(dirname "$0")"

# 执行启动命令
exec npm run dev
