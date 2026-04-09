# 🚀 Fusion Orchestrator v2 MCP Server

**Antigravity IDE × Jules × Gemini × n8n を統合する、独立型MCPサーバー**

---

## これは何？

Fusion Copilot の全オーケストレーション機能（Jules 非同期コーディング、Gemini DEEPTHINK/DEEPSEARCH、n8n ワークフロー実行、Qwen ローカルAIファーム）を、
**MCP（Model Context Protocol）準拠の独立サーバー**として公開するものです。

これにより、**Antigravity IDE・Claude Desktop・その他任意のMCP対応AIクライアント**から、
あなたのローカル環境のオーケストレーション基盤をツールコールで直接叩けるようになります。

## 📦 セットアップ

```bash
cd fusion-copilot/mcp-server
npm install
```

## ▶️ 起動方法

```bash
# 開発モード（tsx直接実行）
npm run dev

# ビルド → 実行
npm run build
npm start
```

## 🧬 バージョン運用

- この実装系統は **v2 スナップショット** として扱います。
- 原本を上書きせず、次の試作は **v3** として並走させ、安定後に差分で統合します。
- そのため、ディレクトリは互換性のため現状維持しつつ、サーバー名とパッケージ名は **v2** で明示します。

## 🔧 公開ツール一覧

| ツール名 | 説明 | 必須引数 |
|:---------|:-----|:---------|
| `qwen_chat` | Qwen 3.5-9B ファームへラウンドロビンでチャット | `message` |
| `qwen_code` | Qwen3 Coder 80B にコーディング依頼 | `task` |
| `qwen_batch` | Qwen ファームへ複数プロンプトを並列投入 | `prompts` |
| `jules_new` | Julesにタスクを送信 | `task` |
| `jules_list` | 稼働中のJulesセッションを一覧 | — |
| `jules_parallel` | 同一タスクを並列Jules セッションで実行（最大5） | `task`, `parallel` |
| `jules_repos` | 登録済み Jules リポジトリを一覧 | — |
| `jules_pull` | Jules セッション結果を取得（レビュー用） | `session` |
| `jules_apply` | Jules セッション結果を取得しローカルに適用 | `session` |
| `jules_teleport` | Jules セッションにテレポート | `session` |
| `gemini_deepthink` | Gemini CLIで深い設計思考を実行 | `prompt` |
| `gemini_deepsearch` | Gemini CLIで技術調査を実行 | `query` |
| `n8n_trigger` | n8n Webhookを叩いてJules監査ループを発動 | `repo`, `task` |
| `qwen_health` | Qwen 3.5 ファーム（8010-8014）の死活チェック | — |
| `orchestrate` | GitHub Issue分析 → タスク分解 → Jules並列投入の全自動パイプライン | — |

## 🔌 Antigravity IDE への登録

`.vscode/mcp.json` に以下を追加：

```jsonc
{
  "servers": {
    "fusion-orchestrator-v2": {
      "type": "stdio",
      "command": "bash",
      "args": ["start.sh"],
      "cwd": "${workspaceFolder}/fusion-copilot/mcp-server"
    }
  }
}
```

### グローバル登録（全ワークスペースで使う場合）

`~/.gemini/settings.json` に追加するか、VS Codeの `settings.json` に追記：

```jsonc
"mcp": {
  "servers": {
    "fusion-orchestrator-v2": {
      "type": "stdio",
      "command": "bash",
      "args": ["/Users/ryyota/Library/CloudStorage/GoogleDrive-tanakaryotadayo@gmail.com/マイドライブ/vscode-copilot-chat/fusion-copilot/mcp-server/start.sh"]
    }
  }
}
```

## 🌐 環境変数

| 変数名 | デフォルト | 説明 |
|:-------|:-----------|:-----|
| `N8N_WEBHOOK_URL` | `http://localhost:5678/webhook/jules-start` | n8n Webhook URL |
| `QWEN_PORTS` | `8010,8011,8012,8013,8014` | Qwenファームのポート（カンマ区切り） |
| `QWEN_HOST` | `localhost` | Qwenファームのホスト |

## 🏗️ 技術スタック

- **MCP SDK**: `@modelcontextprotocol/sdk`（高レベル `McpServer` API使用）
- **プロトコル**: newline-delimited JSON-RPC over stdio
- **ランタイム**: Node.js + TypeScript (tsx)
- **外部依存**: `jules` CLI, `gemini` CLI, `gh` CLI, `n8n` (Webhook)

## 📋 監査ログ

このサーバーは Claude Opus 4.6 による客観監査を経て構築されました。
Geminiセッションで構築された全モジュールの問題点を洗い出し、P0/P1の修正を適用済みです。

- ✅ `jules` CLI コマンド構文修正
- ✅ AutoHealer デッドロック防止
- ✅ AutoHealer ファイル全置換 → 差分パッチ化
- ✅ MCP Bridge パス存在チェック追加
- ✅ MCP サーバー独立化 + プロトコルテスト通過
