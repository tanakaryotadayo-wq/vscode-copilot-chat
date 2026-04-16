# AI作業日誌 (.ai-diary/)

## ルール
- **全てのAIエージェント**（Copilot CLI, Antigravity Claude, Jules）は作業完了時に日誌を書く
- 1エントリ = 1タスク（追記方式、1日複数エントリ可）
- ファイル名: `YYYY-MM-DD.md`（日付ごと）
- **嘘を書くな。** 失敗は正直に。成功を盛るな。

## エントリ形式

```markdown
---
time: "HH:MM"
agent: "copilot-fleet" | "copilot-tasks" | "antigravity-claude" | "jules" | "qwen3"
model: "gpt-5-mini" | "gpt-5.4" | "claude-opus-4.6" | "qwen3-coder-80b"
cost: "0x" | "1x" | "3x"
duration: "5m" | "1h30m"
status: "✅ done" | "⚠️ partial" | "❌ failed"
---

## [タスクの1行要約]

### やったこと
- 具体的にやったこと

### 変更ファイル
- `path/to/file1.ts` — 何を変えたか
- `path/to/file2.py` — 何を変えたか

### 失敗・エラー
- 何がうまくいかなかったか（なければ「なし」）

### 発見・メモ
- コードベースについて発見したこと
- 「このモジュールは〇〇に依存してる」等

### 残タスク / TODO
- [ ] 次にやるべきこと
- [ ] フォローアップ
```

## 目的
1. **AI間の引き継ぎ**: ClaudeがCopilot CLIの作業を把握、逆も然り
2. **失敗の学習**: 同じ失敗を繰り返さない
3. **コスト追跡**: model × duration で実コストを可視化
4. **知識蓄積**: コードベースについての発見がストックされる
