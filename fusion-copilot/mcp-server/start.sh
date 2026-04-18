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

# ビルドがない、または source/package が dist より新しければビルド
needs_build=false
if [ ! -f "dist/index.js" ]; then
  needs_build=true
elif find src package.json package-lock.json tsconfig.json vitest.config.ts -type f -newer dist/index.js 2>/dev/null | grep -q .; then
  needs_build=true
fi

if [ "$needs_build" = true ]; then
  echo "🔨 Building..." >&2
  npm run build
fi

echo "🚀 Starting Fusion Orchestrator v2 MCP Server..." >&2
exec node dist/index.js
