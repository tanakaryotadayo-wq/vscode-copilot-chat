#!/bin/bash
# fusion-orchestrator-v2 セットアップ & 起動スクリプト
# MBA (MacBook Air) でも Mac Studio でも動く
set -e

# Antigravity IDE sandbox doesn't include Homebrew in PATH
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

# Jules API Key from macOS Keychain
export JULES_API_KEY=$(security find-generic-password -s "jules-api-key" -a "jules" -w 2>/dev/null)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 依存がなければインストール
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..." >&2
  npm install
fi

# ビルドがなければビルド
if [ ! -f "dist/index.js" ]; then
  echo "🔨 Building..." >&2
  npm run build
fi

echo "🚀 Starting Fusion Orchestrator v2 MCP Server..." >&2
exec node dist/index.js
