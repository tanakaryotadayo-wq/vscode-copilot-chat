#!/bin/bash
# =============================================================================
# 🤖 Antigravity Agent Spawner — 無料 gh copilot CLI マルチエージェント
# =============================================================================
# GPT-5-mini (0x無料) × N体の並列エージェントを起動して
# 各エージェントの結果を .ai-diary/ に自動回収する
#
# Usage:
#   spawn-agents.sh --fleet "レポジトリの構造分析して"    # fleetモード (日誌 + 並列分解)
#   spawn-agents.sh --worker "TypeScriptエラー全部直せ"   # workerモード (単体実行)
#   spawn-agents.sh -p "タスク" -n 3                     # rawモード (プロンプト直指定)
#   spawn-agents.sh -l tasks/*.md                        # ファイルリストから1体ずつ
# =============================================================================

set -e

GH="/opt/homebrew/Cellar/gh/2.89.0/bin/gh"
MODEL="${MODEL:-gpt-5-mini}"
WORK_DIR="${WORK_DIR:-$(pwd)}"
DIARY_DIR="${WORK_DIR}/.ai-diary"
RESULTS_DIR="/tmp/antigravity-agents"
MAX_AGENTS="${MAX_AGENTS:-5}"
COST_LABEL="0x"

# Auto-inject GH token for copilot auth
if [ -z "$GH_TOKEN" ] && [ -z "$COPILOT_GITHUB_TOKEN" ]; then
  export GH_TOKEN=$($GH auth token 2>/dev/null || echo "")
  if [ -z "$GH_TOKEN" ]; then
    echo "❌ No GitHub token found. Run: $GH auth login"
    exit 1
  fi
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

mkdir -p "$RESULTS_DIR"
mkdir -p "$DIARY_DIR"

# =============================================================================
# プロンプトテンプレート
# =============================================================================

# Fleet: ビルトイン /fleet で並列サブエージェント実行 + 日誌
build_fleet_prompt() {
  local input="$1"
  local diary_date=$(date "+%Y-%m-%d")
  local diary_time=$(date "+%H:%M")
  cat <<FLEET_EOF
/fleet ${input}

コミットするな。省略禁止。全行書け。
エラーが出たら自分で修正。3回失敗したら状況レポートを書いて終了。

## 📓 作業日誌（必須）
全作業完了後、.ai-diary/${diary_date}.md に以下を追記しろ（上書きするな）：

---
time: "${diary_time}"
agent: "copilot-fleet"
model: "${MODEL}"
cost: "${COST_LABEL}"
status: "✅ done / ⚠️ partial / ❌ failed"
---

## [タスクの1行要約]

### やったこと
- サブエージェント数と各作業内容

### 変更ファイル
- path/to/file — 何を変えたか

### 失敗・エラー
- なければ「なし」

### 発見・メモ
- コードベースについての発見

### 残タスク / TODO
- [ ] 次にやるべきこと
FLEET_EOF
}

# Worker: 単体タスク実行 + 日誌
build_worker_prompt() {
  local input="$1"
  local diary_date=$(date "+%Y-%m-%d")
  local diary_time=$(date "+%H:%M")
  cat <<WORKER_EOF
${input}

## ルール
1. 指示されたことだけやれ。スコープを勝手に広げるな。
2. エラーが出たら自分で修正。3回失敗したら状況レポートを書いて終了。
3. コミットするな。コード変更だけ行え。
4. 省略禁止。全行書け。

## 📓 作業日誌（必須）
.ai-diary/${diary_date}.md に以下を追記しろ（上書きするな）：

---
time: "${diary_time}"
agent: "copilot-worker"
model: "${MODEL}"
cost: "${COST_LABEL}"
status: "✅ done / ⚠️ partial / ❌ failed"
---

## [タスクの1行要約]

### やったこと
- 具体的な変更内容

### 変更ファイル
- path/to/file — 何を変えたか

### 失敗・エラー
- なければ「なし」

### 残タスク / TODO
- [ ] 次にやるべきこと
WORKER_EOF
}

# Raw: プロンプトそのまま + 日誌だけ追加
build_raw_prompt() {
  local input="$1"
  local agent_id="$2"
  local diary_date=$(date "+%Y-%m-%d")
  local diary_time=$(date "+%H:%M")
  cat <<RAW_EOF
${input}

---
## 必須: 作業日誌
タスク完了後、.ai-diary/${diary_date}.md に以下を追記しろ（上書きするな）：

---
time: "${diary_time}"
agent: "copilot-spawn-${agent_id}"
model: "${MODEL}"
cost: "${COST_LABEL}"
status: "✅ done / ⚠️ partial / ❌ failed"
---

## [タスクの1行要約]

### やったこと
### 変更ファイル
### 失敗・エラー
### 発見・メモ
### 残タスク / TODO
RAW_EOF
}

usage() {
  echo ""
  echo -e "${BOLD}🤖 Antigravity Agent Spawner${NC}"
  echo ""
  echo "Usage:"
  echo "  $0 --fleet \"タスク\"              # 並列分解 + 日誌 (0xコスト)"
  echo "  $0 --worker \"タスク\"              # 品質重視 + 日誌"
  echo "  $0 -p \"タスク\" [-n count]        # rawモード"
  echo "  $0 -l task1.md task2.md ...      # ファイルリストから"
  echo ""
  echo "Options:"
  echo "  --fleet  fleetモード (分解+並列+日誌)"
  echo "  --worker  workerモード (単体実行+日誌)"
  echo "  -p       プロンプト直接指定"
  echo "  -n       エージェント数 (default: 1, max: $MAX_AGENTS)"
  echo "  -m       モデル (default: $MODEL)"
  echo "  -d       作業ディレクトリ (default: .)"
  echo ""
  echo "Examples:"
  echo "  $0 --fleet \"src/のTypeScriptエラー全部直せ\""
  echo "  $0 --worker \"README.mdを書け\" -n 3"
  echo "  $0 -p \"hello\" -m gpt-5.4"
  exit 1
}

# =============================================================================
# 1体のエージェントを起動する
# =============================================================================
spawn_one() {
  local agent_id=$1
  local full_prompt="$2"
  local mode_label="${3:-raw}"
  local log_file="$RESULTS_DIR/agent-${agent_id}.log"
  local session_file="$RESULTS_DIR/agent-${agent_id}-session.md"

  echo -e "${CYAN}🤖 Agent #${agent_id}${NC} [${MAGENTA}${mode_label}${NC}] spawning... (model: ${MODEL})"

  # gh copilot を非対話モードで実行
  $GH copilot \
    --model "$MODEL" \
    --mode autopilot \
    --no-ask-user \
    --yolo \
    --silent \
    --share "$session_file" \
    -p "$full_prompt" \
    > "$log_file" 2>&1 &

  local pid=$!
  echo "$pid" > "$RESULTS_DIR/agent-${agent_id}.pid"
  echo -e "${DIM}   PID: $pid | Log: $log_file${NC}"
}

# =============================================================================
# 全エージェントの完了を待つ
# =============================================================================
wait_all() {
  local agents=$1
  echo ""
  echo -e "${BOLD}⏳ Waiting for $agents agent(s)...${NC}"
  echo ""

  local completed=0
  local failed=0

  for i in $(seq 1 "$agents"); do
    local pid_file="$RESULTS_DIR/agent-${i}.pid"
    if [ -f "$pid_file" ]; then
      local pid=$(cat "$pid_file")
      if wait "$pid" 2>/dev/null; then
        completed=$((completed + 1))
        echo -e "${GREEN}✅ Agent #${i} (PID $pid) completed${NC}"
      else
        failed=$((failed + 1))
        echo -e "${RED}❌ Agent #${i} (PID $pid) failed${NC}"
      fi
    fi
  done

  echo ""
  echo -e "${BOLD}═══════════════════════════════════════${NC}"
  echo -e "${GREEN}  Completed: $completed${NC} | ${RED}Failed: $failed${NC} | Total: $agents"
  echo -e "${BOLD}═══════════════════════════════════════${NC}"

  # 結果の日誌を表示
  local today_diary="$DIARY_DIR/$(date +%Y-%m-%d).md"
  if [ -f "$today_diary" ]; then
    echo ""
    echo -e "${CYAN}📓 Today's diary (last 30 lines):${NC}"
    tail -30 "$today_diary"
  fi

  # セッションログのリスト
  echo ""
  echo -e "${CYAN}📋 Session logs:${NC}"
  for i in $(seq 1 "$agents"); do
    local sf="$RESULTS_DIR/agent-${i}-session.md"
    if [ -f "$sf" ]; then
      local size=$(wc -c < "$sf" | tr -d ' ')
      echo -e "  ${DIM}Agent #${i}:${NC} $sf (${size} bytes)"
    fi
  done
}

# =============================================================================
# メインルーター
# =============================================================================
PROMPT=""
COUNT=1
FILES=()
MODE="raw"  # raw | fleet | worker

while [[ $# -gt 0 ]]; do
  case $1 in
    --fleet)
      MODE="fleet"
      PROMPT="$2"
      shift 2
      ;;
    --worker)
      MODE="worker"
      PROMPT="$2"
      shift 2
      ;;
    -p)
      MODE="raw"
      PROMPT="$2"
      shift 2
      ;;
    -n)
      COUNT="$2"
      shift 2
      ;;
    -m)
      MODEL="$2"
      shift 2
      ;;
    -d)
      WORK_DIR="$2"
      DIARY_DIR="${WORK_DIR}/.ai-diary"
      shift 2
      ;;
    -l)
      shift
      while [[ $# -gt 0 && ! "$1" =~ ^- ]]; do
        FILES+=("$1")
        shift
      done
      ;;
    -h|--help)
      usage
      ;;
    *)
      if [ -f "$1" ]; then
        PROMPT=$(cat "$1")
      else
        PROMPT="$1"
      fi
      shift
      ;;
  esac
done

# コスト計算
case "$MODEL" in
  gpt-5-mini) COST_LABEL="0x" ;;
  gpt-5.4)    COST_LABEL="1x" ;;
  *)          COST_LABEL="?x" ;;
esac

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  🤖 Antigravity Agent Spawner${NC}"
echo -e "${DIM}  Model: ${MODEL} (${COST_LABEL}) | Mode: ${MODE} | Dir: ${WORK_DIR}${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

if [ ${#FILES[@]} -gt 0 ]; then
  # ファイルリストモード
  COUNT=${#FILES[@]}
  if [ "$COUNT" -gt "$MAX_AGENTS" ]; then
    echo -e "${RED}❌ Too many agents ($COUNT > $MAX_AGENTS)${NC}"
    exit 1
  fi
  for i in $(seq 1 "$COUNT"); do
    local_prompt=$(cat "${FILES[$((i-1))]}")
    case "$MODE" in
      fleet) full=$(build_fleet_prompt "$local_prompt") ;;
      tasks) full=$(build_worker_prompt "$local_prompt") ;;
      *)     full=$(build_raw_prompt "$local_prompt" "$i") ;;
    esac
    spawn_one "$i" "$full" "$MODE"
  done

elif [ -n "$PROMPT" ]; then
  # プロンプトモード
  if [ "$COUNT" -gt "$MAX_AGENTS" ]; then
    echo -e "${RED}❌ Too many agents ($COUNT > $MAX_AGENTS)${NC}"
    exit 1
  fi
  for i in $(seq 1 "$COUNT"); do
    case "$MODE" in
      fleet) full=$(build_fleet_prompt "$PROMPT") ;;
      tasks) full=$(build_worker_prompt "$PROMPT") ;;
      *)     full=$(build_raw_prompt "$PROMPT" "$i") ;;
    esac
    spawn_one "$i" "$full" "$MODE"
  done

else
  usage
fi

wait_all "$COUNT"
