---
name: fusion-orchestrator
description: Use this skill to orchestrate AI agents through the fusion-orchestrator MCP server. Supports local Qwen AI (chat, code, batch), Jules async tasks, Gemini deep analysis, and n8n workflow automation. Triggers include 'orchestrate', 'ask Qwen', 'code with Qwen', 'deep think', 'Jules', 'batch process'.
---

# Skill: Fusion Orchestrator

## MCP Server

This skill requires the `fusion-orchestrator` MCP server. It should be registered in `.vscode/mcp.json`:

```jsonc
{
  "servers": {
    "fusion-orchestrator": {
      "type": "stdio",
      "command": "bash",
      "args": ["start.sh"],
      "cwd": "${workspaceFolder}/fusion-copilot/mcp-server"
    }
  }
}
```

## 10 Available Tools

### Quick Reference

| Priority | Tool | Use case |
|:---------|:-----|:---------|
| 1st | `qwen_chat` | Fast local AI for simple tasks (free, instant) |
| 2nd | `qwen_code` | Complex coding with Qwen3 Coder 80B |
| 3rd | `qwen_batch` | Parallel prompts across 5 farm instances |
| 4th | `jules_new` | Async task delegation (creates PRs) |
| 5th | `gemini_deepthink` | Architecture analysis |
| 6th | `gemini_deepsearch` | Tech research |
| — | `qwen_health` | Check instance status |
| — | `jules_list` | Check Jules sessions |
| — | `n8n_trigger` | Start audit workflow |
| — | `orchestrate` | Full auto pipeline |

### Key Principle

**Prefer local AI first (qwen_chat / qwen_code)**, then escalate to cloud (Jules / Gemini) only when needed.
Local = free, instant, private. Cloud = async, rate-limited.

### Tool Details

#### `qwen_code` — The Powerhouse
- Qwen3 Coder 80B at port 8020
- Sonnet 4.5 level coding capability
- Use for: implementations, refactors, code reviews, test generation
- Params: `task`, `language`, `context`, `max_tokens`

#### `qwen_batch` — Parallel Farm
- Sends N prompts to N Qwen instances simultaneously
- Use for: batch summarization, parallel analysis, mass code generation
- Params: `prompts[]`, `system`

#### `orchestrate` — Auto Pipeline
- Fetches GitHub issues → Analyzes → Submits to Jules
- Set `useQwen: true` to use Qwen Coder instead of Gemini for analysis
- Params: `repo`, `maxTasks`, `useQwen`

---

## Architecture Decision Record (ADR) — RATIFIED

All AI agents MUST follow this when making infrastructure decisions:

| Layer | What | Service |
|-------|------|---------|
| Code | fusion-gate, MCP servers, skills | **GitHub** |
| Raw files | logs, zips, exports, Drive salvage | **GCS** or **local FS** |
| Index DB | chunks, embeddings, semantic_delta, drift | **Cloud SQL** or **local SQLite** |
| API layer | MCP gateway, audit, ingestion | **Cloud Run** |
| Working set | cache, raw packets, WIP | **Mac Studio local** |

**Rules:**
- Raw file blobs NEVER go into DB. Only metadata + extracted text + embeddings.
- Google Drive = archive input only. Never active cache.
- GitHub = code only. No data files.
- Prefer local-first. Cloud is control plane + persistence.

**OpSec:** fusion-gate core (Harvest, Semantic, PCC, CBF, ECK, Vector Proxy) is classified. Never send to Jules or external cloud agents.
