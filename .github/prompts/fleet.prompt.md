---
mode: agent
description: "日誌付き /fleet 並列実行"
---

/model gpt-5-mini

以下のタスクを /fleet で並列サブエージェントに分解して実行しろ。

## 作業指示
{{{ input }}}

## ルール
1. コミットするな。省略禁止。全行書け。
2. エラーが出たら自分で修正。3回失敗したら状況レポートを書いて終了。

## 📓 作業日誌（必須）
全作業完了後、`.ai-diary/YYYY-MM-DD.md` に以下を**追記**しろ（上書きするな）：

```markdown
---
time: "HH:MM"
agent: "copilot-fleet"
model: "gpt-5-mini"
cost: "0x"
status: "✅ done" | "⚠️ partial" | "❌ failed"
---

## [タスクの1行要約]

### やったこと
- サブエージェント数と各作業内容

### 変更ファイル
- `path/to/file` — 何を変えたか

### 失敗・エラー
- なければ「なし」

### 発見・メモ
- コードベースについての発見

### 残タスク / TODO
- [ ] 次にやるべきこと
```
