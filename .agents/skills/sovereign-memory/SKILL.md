---
name: sovereign-memory
description: Use this skill to interact with the Sovereign Memory system — the AI's persistent memory engine built on NV-Embed-v2 (4096d). Supports auto-recall at conversation start, semantic search across past conversations and KI, evaluation framework, KI promotion queue management, and operational telemetry. Triggers include 'remember', 'recall', 'past conversation', 'memory search', 'KI promotion', 'evaluation', 'what did we do before'.
---

# Skill: Sovereign Memory

## Overview

Sovereign Memory is the AI's persistent memory engine. It enables continuity across conversations by storing, indexing, and retrieving past knowledge and work history. Built on NV-Embed-v2 (4096d native embeddings) running locally on Mac Studio.

**Core principle: KI = confirmed knowledge (骨格), Memory = discovery/auxiliary (材料). Don't mix them.**

## Architecture

```
┌─────────────────────────────────────────┐
│              recall(query)              │  ← Single entry point
├────────────┬────────────────────────────┤
│  KI Search │     Memory Search         │  ← Two-stage retrieval
├────────────┴────────────────────────────┤
│         Query Router (ki/memory/hybrid) │  ← Intent classification
├─────────────────────────────────────────┤
│   Confidence Gate (cosine + concept)    │  ← FP elimination
├─────────────────────────────────────────┤
│   Reference Tracking + Telemetry        │  ← Operational measurement
└─────────────────────────────────────────┘
```

## MCP Tools (via fusion-gate)

| Tool | Purpose | When to use |
|:-----|:--------|:------------|
| `memory_recall` | **Auto-recall for conversation start** | **ALWAYS at conversation start** — pass key terms from user's first message |
| `memory_search` | Raw semantic search | When you need fine-grained search with custom parameters |
| `memory_index` | Index new conversations | After a conversation ends to persist it |
| `memory_stats` | System statistics | To check health and coverage |
| `memory_feedback` | Record result adoption | After using a search result to track effectiveness |

## MANDATORY Protocol: Auto-Recall

**At the start of EVERY conversation, you MUST:**

1. Read the user's first message
2. Extract key terms (topic, technology, intent)
3. Call `memory_recall` with those terms
4. Use the returned `context_text` to inform your response

```
User: "前にembeddingの移行で詰まった話を思い出して"

→ memory_recall(query="embedding移行 詰まった")
→ Returns: confirmed_knowledge + related_memories + context_text

→ Use context_text to respond with full historical awareness
```

**If you skip this step, you are operating with amnesia. Don't do it.**

## recall() Response Structure

```json
{
  "query": "...",
  "route": "ki|memory|hybrid",
  "confirmed_knowledge": [
    {"conversation_id": "...", "source_file": "...", "content_preview": "...", "cosine_raw": 0.5}
  ],
  "related_memories": [
    {"conversation_id": "...", "source_file": "...", "content_preview": "...", "is_confident": true}
  ],
  "ki_promotion_candidates": [...],
  "context_text": "## 確定知識\n...\n## 関連する過去の記憶\n...",
  "stats": {"ki": 2, "mem": 3, "confident": 4, "latency_ms": 450}
}
```

## Query Router Logic

| Route | Triggered by | Slot allocation |
|:------|:------------|:---------------|
| `ki` | specs, rules, definitions, config, architecture | KI: 3, Mem: 2 |
| `memory` | 前に, 昔, 以前, last time, debugging results | KI: 1, Mem: 4 |
| `hybrid` | improvement, comparison, default | KI: 2, Mem: 3 |

## Evaluation Framework

For systematic quality measurement of the recall system:

### CLI Commands

```bash
# Run a query through recall and log for evaluation
python3 conversation_memory.py --eval-run "PCC座標の仕様" --route ki

# List pending evaluations awaiting human judgment
python3 conversation_memory.py --eval-pending

# Judge an evaluation entry
python3 conversation_memory.py --eval-update 1 useful=1 adopted_source=ki saved_explanation=1

# View all evaluations
python3 conversation_memory.py --eval-list

# Compute aggregate metrics
python3 conversation_memory.py --eval-stats
```

### Evaluation Metrics

| Metric | Description |
|:-------|:-----------|
| `route_accuracy` | Did the router pick the correct route? |
| `useful_rate` | Was the returned context actually useful? |
| `ki_hit_rate` | How often did KI return confident results? |
| `memory_assist_rate` | How often did Memory contribute? |
| `saved_explanation_rate` | Did recall prevent re-explaining? |
| `adopted_source` | Which source (ki/memory/none) was used? |

## KI Promotion Queue

Memory chunks that score highly may be promoted to KI (confirmed knowledge):

```bash
# View pending promotion candidates
python3 conversation_memory.py --promotion-queue

# Approve/reject/defer
python3 conversation_memory.py --review <id> approved
python3 conversation_memory.py --review <id> rejected
python3 conversation_memory.py --review <id> deferred
```

**Filter rules** — ephemeral files (task.md, scratch, debug) are auto-excluded.
Only knowledge-bearing files (walkthrough, overview, implementation_plan, guide, spec) can be promoted.

## Telemetry

```bash
# View operational telemetry
python3 conversation_memory.py --telemetry
```

Tracks: route distribution, avg latency, KI/Memory per query, feedback adoption rates, promotion queue status.

## Key Paths

| Item | Path |
|:-----|:-----|
| Core module | `/Users/ryyota/fusion-gate/intelligence/conversation_memory.py` |
| Database | `/Users/ryyota/.gemini/antigravity/conversation_memory.db` |
| Brain dir | `/Users/ryyota/.gemini/antigravity/brain/` |
| Knowledge dir | `/Users/ryyota/.gemini/antigravity/knowledge/` |
| Embedding server | `http://127.0.0.1:8093/v1/embeddings` (NV-Embed-v2, 4096d) |

## Environment

```bash
export EMBEDDING2_MODE=local_ai
export LOCAL_AI_ENDPOINTS=http://127.0.0.1:8093/v1/embeddings
export LOCAL_AI_MODEL=nv-embed-v2
```

## Current Performance (2026-04-12)

| Metric | Value |
|:-------|:------|
| Total chunks | 611 |
| Top1 accuracy | 65% |
| Top3 accuracy | 85% |
| False positive rate | 0% |
| Route accuracy | 97% (29/30) |
| Avg recall latency | 432ms |
| Eval queries loaded | 30 (25 pending judgment) |
