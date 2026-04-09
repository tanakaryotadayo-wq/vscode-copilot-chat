#!/bin/bash
# ================================================================
# Antigravity 汚染チェックスクリプト
# fusion-gate の vector_proxy_audit を使って
# KI, GEMINI.md, settings を検査する
# ================================================================
# 使い方:
#   ./contamination_check.sh [target_dir]
#   デフォルトは ~/.gemini/antigravity/
# ================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

TARGET="${1:-$HOME/.gemini/antigravity}"

echo -e "${YELLOW}=== Antigravity 汚染チェック ===${NC}"
echo "  Target: $TARGET"
echo ""

SUSPICIOUS=0

# ── 1. Scan for injection patterns in all text files ──────────
echo -e "${GREEN}[1/4] Scanning for prompt injection patterns...${NC}"

INJECTION_PATTERNS=(
  "IGNORE PREVIOUS"
  "IGNORE ALL PREVIOUS"
  "DISREGARD"
  "SYSTEM OVERRIDE"
  "DO_NOT_TRUST"
  "You are now"
  "Forget all previous"
  "Act as if"
  "sudo mode"
  "DAN mode"
  "jailbreak"
  "TRUST_NONE"
  "inject"
  "<script>"
  "eval("
  "exec("
  "__import__"
)

for pattern in "${INJECTION_PATTERNS[@]}"; do
  matches=$(grep -ril "$pattern" "$TARGET" --include="*.json" --include="*.md" --include="*.txt" --include="*.yaml" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo -e "  ${RED}⚠ Found '$pattern' in:${NC}"
    echo "$matches" | sed 's/^/    /'
    SUSPICIOUS=$((SUSPICIOUS + 1))
  fi
done

if [ $SUSPICIOUS -eq 0 ]; then
  echo -e "  ${GREEN}✅ No injection patterns found${NC}"
fi

# ── 2. Check trustedFolders.json ──────────────────────────────
echo ""
echo -e "${GREEN}[2/4] Checking trustedFolders.json...${NC}"

TRUSTED_FILE="$HOME/.gemini/trustedFolders.json"
if [ -f "$TRUSTED_FILE" ]; then
  untrusted=$(python3 -c "
import json
with open('$TRUSTED_FILE') as f:
    data = json.load(f)
for k, v in data.items():
    if v == 'DO_NOT_TRUST':
        print(f'  ⚠ {k} = {v}')
" 2>/dev/null || echo "  (parse error)")
  if [ -n "$untrusted" ]; then
    echo -e "  ${RED}Suspicious entries:${NC}"
    echo "$untrusted"
    SUSPICIOUS=$((SUSPICIOUS + 1))
  else
    echo -e "  ${GREEN}✅ Clean${NC}"
  fi
else
  echo "  (file not found — skipping)"
fi

# ── 3. Check GEMINI.md for tampering ──────────────────────────
echo ""
echo -e "${GREEN}[3/4] Checking GEMINI.md...${NC}"

GEMINI_FILE="$HOME/.gemini/GEMINI.md"
if [ -f "$GEMINI_FILE" ]; then
  size=$(wc -c < "$GEMINI_FILE" | xargs)
  lines=$(wc -l < "$GEMINI_FILE" | xargs)
  echo "  Size: ${size} bytes, ${lines} lines"

  # Check for suspiciously large files or hidden content
  if [ "$size" -gt 50000 ]; then
    echo -e "  ${RED}⚠ Unusually large GEMINI.md (${size} bytes)${NC}"
    SUSPICIOUS=$((SUSPICIOUS + 1))
  fi

  # Check for hidden unicode control characters
  hidden=$(grep -P '[\x00-\x08\x0e-\x1f\x7f-\x9f]' "$GEMINI_FILE" 2>/dev/null | wc -l | xargs)
  if [ "$hidden" -gt 0 ]; then
    echo -e "  ${RED}⚠ Hidden control characters found (${hidden} lines)${NC}"
    SUSPICIOUS=$((SUSPICIOUS + 1))
  else
    echo -e "  ${GREEN}✅ Clean${NC}"
  fi
else
  echo "  (not found)"
fi

# ── 4. Check settings.json for anomalies ─────────────────────
echo ""
echo -e "${GREEN}[4/4] Checking settings.json...${NC}"

SETTINGS_FILE="$HOME/.gemini/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  python3 -c "
import json
with open('$SETTINGS_FILE') as f:
    data = json.load(f)
# Check for unexpected keys
known_keys = {'ui', 'hasSeenIdeIntegrationNudge', 'security', 'model', 'general', 'ide'}
unknown = set(data.keys()) - known_keys
if unknown:
    print(f'  ⚠ Unknown settings keys: {unknown}')
else:
    print('  ✅ Clean')
" 2>/dev/null || echo "  (parse error)"
else
  echo "  (not found)"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $SUSPICIOUS -eq 0 ]; then
  echo -e "${GREEN}✅ 汚染チェック完了: クリーン${NC}"
  echo "  統合を安全に実行できます。"
else
  echo -e "${RED}⚠ 汚染チェック完了: ${SUSPICIOUS} 件の疑わしい項目${NC}"
  echo "  統合前に手動で確認してください。"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
