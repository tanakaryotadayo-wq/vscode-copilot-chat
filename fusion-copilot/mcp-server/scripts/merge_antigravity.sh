#!/bin/bash
# ================================================================
# Antigravity KI/Brain マージスクリプト
# MBA → Mac Studio の非破壊統合
# ================================================================
# 使い方:
#   1. MBA の ~/.gemini/antigravity/ を tar で Mac Studio に転送
#   2. このスクリプトを Mac Studio 上で実行
#
#   ./merge_antigravity.sh /path/to/mba_antigravity_backup.tar.gz
# ================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

MS_DIR="$HOME/.gemini/antigravity"
BACKUP_DIR="$HOME/.gemini/antigravity/.merge_backup_$(date +%Y%m%d_%H%M%S)"
STAGING_DIR="/tmp/antigravity_mba_staging_$$"

if [ $# -lt 1 ]; then
  echo -e "${RED}Usage: $0 <mba_backup.tar.gz>${NC}"
  echo "  Create the backup on MBA first:"
  echo "    tar -czf ~/antigravity_mba_backup.tar.gz -C ~/.gemini antigravity/"
  exit 1
fi

MBA_ARCHIVE="$1"
if [ ! -f "$MBA_ARCHIVE" ]; then
  echo -e "${RED}File not found: $MBA_ARCHIVE${NC}"
  exit 1
fi

echo -e "${YELLOW}=== Antigravity KI/Brain Merger ===${NC}"
echo "  Source: $MBA_ARCHIVE (MBA)"
echo "  Target: $MS_DIR (Mac Studio)"
echo ""

# ── Phase 1: Extract MBA data to staging ──────────────────────
echo -e "${GREEN}[Phase 1] Extracting MBA backup to staging...${NC}"
mkdir -p "$STAGING_DIR"
tar -xzf "$MBA_ARCHIVE" -C "$STAGING_DIR"
MBA_DIR="$STAGING_DIR/antigravity"

if [ ! -d "$MBA_DIR" ]; then
  echo -e "${RED}Expected $MBA_DIR but not found. Check archive structure.${NC}"
  ls -la "$STAGING_DIR"
  exit 1
fi

echo "  MBA knowledge items:"
ls "$MBA_DIR/knowledge/" 2>/dev/null | grep -v "\.lock$" || echo "  (none)"
echo "  MBA brain conversations:"
ls "$MBA_DIR/brain/" 2>/dev/null | wc -l | xargs echo "  "

# ── Phase 2: Create backup of MS data ─────────────────────────
echo ""
echo -e "${GREEN}[Phase 2] Backing up Mac Studio data...${NC}"
mkdir -p "$BACKUP_DIR"
cp -R "$MS_DIR/knowledge" "$BACKUP_DIR/" 2>/dev/null || true
cp -R "$MS_DIR/brain" "$BACKUP_DIR/" 2>/dev/null || true
cp "$MS_DIR/conversation_memory.db" "$BACKUP_DIR/" 2>/dev/null || true
echo "  Backup saved to: $BACKUP_DIR"

# ── Phase 3: Merge Knowledge Items ────────────────────────────
echo ""
echo -e "${GREEN}[Phase 3] Merging Knowledge Items...${NC}"

for ki_dir in "$MBA_DIR/knowledge"/*/; do
  ki_name=$(basename "$ki_dir")
  ms_ki="$MS_DIR/knowledge/$ki_name"

  if [ -d "$ms_ki" ]; then
    # Both exist — compare timestamps
    mba_meta="$ki_dir/metadata.json"
    ms_meta="$ms_ki/metadata.json"

    if [ -f "$mba_meta" ] && [ -f "$ms_meta" ]; then
      mba_ts=$(python3 -c "import json; print(json.load(open('$mba_meta')).get('lastModified',''))" 2>/dev/null || echo "")
      ms_ts=$(python3 -c "import json; print(json.load(open('$ms_meta')).get('lastModified',''))" 2>/dev/null || echo "")

      if [[ "$mba_ts" > "$ms_ts" ]]; then
        echo -e "  ${YELLOW}↑ $ki_name${NC}: MBA is newer ($mba_ts > $ms_ts) → replacing"
        cp -R "$ki_dir" "$MS_DIR/knowledge/"
      else
        echo -e "  ${GREEN}= $ki_name${NC}: MS is newer or equal → keeping"
      fi
    else
      echo -e "  ${YELLOW}? $ki_name${NC}: metadata comparison failed → keeping MS version"
    fi
  else
    # MBA only — copy to MS
    echo -e "  ${GREEN}+ $ki_name${NC}: MBA only → copying to MS"
    cp -R "$ki_dir" "$MS_DIR/knowledge/"
  fi
done

# Copy standalone files (user_preferences, r7000_firmware_analysis, etc.)
for f in "$MBA_DIR/knowledge"/*; do
  if [ -f "$f" ] && [ "$(basename "$f")" != "knowledge.lock" ]; then
    fname=$(basename "$f")
    if [ ! -f "$MS_DIR/knowledge/$fname" ]; then
      echo -e "  ${GREEN}+ $fname${NC}: copying file"
      cp "$f" "$MS_DIR/knowledge/"
    fi
  fi
done

# ── Phase 4: Merge Brain (conversations) ──────────────────────
echo ""
echo -e "${GREEN}[Phase 4] Merging brain conversations...${NC}"

merged=0
skipped=0
for conv in "$MBA_DIR/brain"/*/; do
  conv_id=$(basename "$conv")
  ms_conv="$MS_DIR/brain/$conv_id"
  if [ -d "$ms_conv" ]; then
    skipped=$((skipped + 1))
  else
    cp -R "$conv" "$MS_DIR/brain/"
    merged=$((merged + 1))
  fi
done
echo "  Merged: $merged conversations, Skipped (already exists): $skipped"

# ── Phase 5: Merge conversation_memory.db ──────────────────────
echo ""
echo -e "${GREEN}[Phase 5] Merging conversation_memory.db...${NC}"

MBA_DB="$MBA_DIR/conversation_memory.db"
MS_DB="$MS_DIR/conversation_memory.db"

if [ -f "$MBA_DB" ] && [ -f "$MS_DB" ]; then
  # Get tables from MBA
  tables=$(sqlite3 "$MBA_DB" ".tables" 2>/dev/null || echo "")
  if [ -n "$tables" ]; then
    for table in $tables; do
      echo "  Merging table: $table"
      # Dump MBA data as INSERT OR IGNORE
      sqlite3 "$MBA_DB" ".mode insert $table" "SELECT * FROM $table;" 2>/dev/null | \
        sed 's/^INSERT INTO/INSERT OR IGNORE INTO/' | \
        sqlite3 "$MS_DB" 2>/dev/null || echo "    ⚠ Some rows failed (likely duplicates)"
    done
    echo "  Done."
  else
    echo "  No tables found in MBA DB."
  fi
elif [ -f "$MBA_DB" ] && [ ! -f "$MS_DB" ]; then
  echo "  MS DB doesn't exist → copying MBA DB directly"
  cp "$MBA_DB" "$MS_DB"
else
  echo "  MBA DB not found → skipping"
fi

# ── Phase 6: Merge MCP config ──────────────────────────────────
echo ""
echo -e "${GREEN}[Phase 6] Checking MCP config...${NC}"
MBA_MCP="$MBA_DIR/mcp_config.json"
if [ -f "$MBA_MCP" ]; then
  echo "  MBA MCP config found. Manual review recommended:"
  echo "  $MBA_MCP"
  echo "  (Not auto-merging to avoid conflicts)"
else
  echo "  No MBA MCP config → skipping"
fi

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}[Cleanup] Removing staging...${NC}"
rm -rf "$STAGING_DIR"

echo ""
echo -e "${GREEN}=== Merge Complete ===${NC}"
echo "  Backup: $BACKUP_DIR"
echo "  Knowledge items: $(ls "$MS_DIR/knowledge/" | grep -v "\.lock$" | wc -l | xargs)"
echo "  Brain conversations: $(ls "$MS_DIR/brain/" 2>/dev/null | wc -l | xargs)"
echo ""
echo -e "${YELLOW}Next: Restart Antigravity to pick up the merged data.${NC}"
