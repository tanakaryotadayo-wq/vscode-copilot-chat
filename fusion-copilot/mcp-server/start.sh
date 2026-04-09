#!/bin/bash
# fusion-orchestrator-mcp セットアップ & 起動スクリプト
# MBA (MacBook Air) でも Mac Studio でも動く
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 依存がなければインストール
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

# ビルドがなければビルド
if [ ! -f "dist/index.js" ]; then
  echo "🔨 Building..."
  npm run build
fi

echo "🚀 Starting Fusion Orchestrator MCP Server..."
exec node dist/index.js
