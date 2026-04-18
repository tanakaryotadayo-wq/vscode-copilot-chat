# 🚀 Fusion Orchestrator v2 MCP Server

**Antigravity IDE × Jules × ACP×CLI×PCC × PE × n8n を統合する、独立型MCPサーバー**

---

## これは何？

Fusion Copilot の全オーケストレーション機能（Jules 非同期コーディング、ACP×CLI×PCC による Gemini / Claude / Copilot 批判的実行、Perfect Equilibrium、n8n ワークフロー実行、Qwen ローカルAIファーム）を、
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

# テスト
npm test
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
| `acp_deepthink` | ACP×CLI×PCC で深い設計思考を実行 | `prompt` |
| `acp_deepsearch` | ACP×CLI×PCC で技術調査を実行 | `query` |
| `n8n_trigger` | n8n Webhookを叩いてJules監査ループを発動 | `repo`, `task` |
| `qwen_health` | Qwen 3.5 ファーム（8010-8014）の死活チェック | — |
| `orchestrate` | GitHub Issue分析 → タスク分解 → Jules並列投入の全自動パイプライン | — |
| `pe_configure` | Perfect Equilibrium の preset / e / C_ψ を設定 | — |
| `pe_step` | 推論ステップを記録し、動的 C_ψ と sabotage を評価 | — |
| `pe_status` | PE の現在状態と履歴を確認 | — |
| `dual_umpire_audit` | DeepSeek VORTEX Critic + Copilot の二重審判監査 | `code` |

## 🧠 ACP×CLI×PCC の実運用

`acp_deepthink` / `acp_deepsearch` は `scripts/pcc-critic.py` を backend に使います。

### PCC presets

- `探` — 批判的探索
- `極` — 極限精度
- `均` — バランス型
- `監` — evidence-first 監査
- `刃` — 実装設計レビュー

### 単発 layered bundle

Gemini CLI のような **1リクエスト前提ランタイム**では、複数 preset を 1 回の実行に束ねられます。

```bash
python3 scripts/pcc-critic.py --runtime gemini --model fast --preset all "この設計を多層で検証しろ"
python3 scripts/pcc-critic.py --runtime gemini --model plan --preset 探,監,刃 "この変更を厚くレビューしろ"
```

- `all` / `full` / `5mode` / `layered`
  - `探,極,均,監,刃` を single-shot でまとめて実行
- `探,監,刃`
  - 実用上のコア3モード

### 推奨モデル alias

| Alias | Model |
|:------|:------|
| `fast` | `gemini-3.1-flash-lite-preview` |
| `standard` | `gemini-3-flash-preview` |
| `plan` | `gemini-3.1-pro-preview` |
| `deep` | `gemini-3.1-pro-preview` |

### Gemini 単発運用の目安

実測では次の使い分けが安定でした。

- **普段使い:** `standard + 探,監,刃`
- **重い設計レビュー:** `plan + all` または `plan + 探,均,監,刃`
- **注意:** `plan + all` は quality は高いが、timeout を 240 秒以上に伸ばした方が安定しやすい

### Gemini CLI 解決順

`pcc-critic.py` は Gemini CLI を次の順で解決します。

1. `GEMINI_BIN`
2. Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`)
3. 現在の `PATH`
4. `~/.nvm/nvm.sh` が存在する場合のみ nvm 管理下の `gemini`

そのため、**nvm が無い Mac でも警告なしで動作**します。

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
- **外部依存**: `jules` CLI, `gemini` CLI, `claude` CLI, `copilot` CLI, `gh` CLI, `n8n` (Webhook)

## 📋 監査ログ

このサーバーは Claude Opus 4.6 による客観監査を経て構築されました。
Geminiセッションで構築された全モジュールの問題点を洗い出し、P0/P1の修正を適用済みです。

- ✅ `jules` CLI コマンド構文修正
- ✅ AutoHealer デッドロック防止
- ✅ AutoHealer ファイル全置換 → 差分パッチ化
- ✅ MCP Bridge パス存在チェック追加
- ✅ MCP サーバー独立化 + プロトコルテスト通過
