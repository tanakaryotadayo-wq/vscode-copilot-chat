#!/bin/bash
# ============================================================
# Fusion Copilot — Ghost-Text 自動テストスクリプト
# Antigravityのターミナルから直接実行してください
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔧 [1/5] ビルド確認..."
npm run build
echo "✅ ビルド成功"

echo ""
echo "🔍 [2/5] TypeScript型チェック..."
npx tsc --noEmit
echo "✅ 型エラーなし"

echo ""
echo "📦 [3/5] 生成済みバンドルの検証..."
if [ -f dist/extension.js ]; then
    SIZE=$(wc -c < dist/extension.js | tr -d ' ')
    echo "✅ dist/extension.js が存在 (${SIZE} bytes)"
    
    # FIMトークンの存在確認
    if grep -q "fim_prefix" dist/extension.js; then
        echo "✅ FIM (Fill-in-the-Middle) トークンがバンドルに含まれている"
    else
        echo "❌ FIMトークンが見つからない！contextBuilder.tsの結合を確認"
        exit 1
    fi
    
    # streamRawCompleteの存在確認
    if grep -q "streamRawComplete" dist/extension.js; then
        echo "✅ streamRawComplete (生FIMストリーミング) がバンドルに含まれている"
    else
        echo "❌ streamRawCompleteが見つからない！localAiClient.tsの結合を確認"
        exit 1
    fi
    
    # ContextBuilderの存在確認
    if grep -q "getCrossFileContext\|crossFileContext" dist/extension.js; then
        echo "✅ CrossFileContext (裏タブカンニング) がバンドルに含まれている"
    else
        echo "❌ CrossFileContextが見つからない！"
        exit 1
    fi
else
    echo "❌ dist/extension.js が見つからない"
    exit 1
fi

echo ""
echo "🚀 [4/5] Extension Host デバッグ起動..."
# 既存のデバッグポート競合を排除
lsof -ti:9223 | xargs kill -9 2>/dev/null || true

code --extensionDevelopmentPath="$PWD" \
     --remote-debugging-port=9223 \
     --user-data-dir="$PWD/.vscode-ext-debug" &
VSCODE_PID=$!
echo "  VS Code PID: $VSCODE_PID (ポート9223)"
echo "  起動待機中 (8秒) ..."
sleep 8

echo ""
echo "🔗 [5/5] agent-browser 接続テスト..."
if command -v agent-browser &>/dev/null; then
    agent-browser connect 9223 && agent-browser tab
elif npx -y agent-browser connect 9223 2>/dev/null; then
    npx -y agent-browser tab
else
    echo "⚠️  agent-browserが利用できません。手動でブラウザから http://localhost:9223 にアクセスして確認してください。"
fi

echo ""
echo "============================================================"
echo "🎉 全チェック完了！"
echo ""
echo "テスト方法:"
echo "  1. 開かれたVS Codeウインドウで任意の .ts ファイルを開く"
echo "  2. コードを入力してタイピングを止める（150ms待つ）"
echo "  3. 灰色のインラインサジェスト（Ghost Text）が表示されれば成功！"
echo ""
echo "※ ローカルAIサーバー (Qwen3.5) がポート8010-8014で起動している必要があります"
echo "※ 終了するには: kill $VSCODE_PID"
echo "============================================================"
