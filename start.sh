#!/bin/sh
# 本地一键启动：自动安装依赖并启动服务
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "首次运行，安装依赖..."
  npm install
fi
exec node server.js
