#!/usr/bin/env node

/**
 * Fusion Orchestrator v2 MCP Server
 * ====================================
 * Full AI orchestration toolkit: Jules, ACP×CLI×PCC, Qwen Farm, Qwen Coder, n8n
 * + Perfect Balance (完全平衡体) hallucination control engine
 *
 * Tools:
 *   jules_new / jules_list          — Async coding agent
 *   jules_parallel                  — Parallel Jules sessions for same task
 *   jules_repos                     — List registered Jules repos
 *   jules_pull                      — Pull session result for review
 *   jules_apply                     — Pull + apply session result locally
 *   jules_teleport                  — Teleport into a Jules session
 *   acp_deepthink / acp_deepsearch   — ACP×CLI×PCC (multi-runtime) analysis + audit
 *   qwen_health                     — Farm health check
 *   qwen_chat                       — Chat with Qwen 3.5-9B (fast, local)
 *   qwen_code                       — Code with Qwen3 Coder (Sonnet 4.5 level)
 *   qwen_batch                      — Parallel multi-prompt across farm
 *   n8n_trigger                     — Workflow engine
 *   orchestrate                     — Full pipeline
 *   pe_configure                    — Configure Perfect Balance engine (legacy tool id)
 *   pe_step                         — Record a reasoning step + audit
 *   pe_status                       — Get current Perfect Balance status + history
 *   dual_umpire_audit               — Parallel cross-vendor audit (Gemini 3 Flash + Copilot GPT-5 mini)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, appendFileSync, watch as fsWatch, type FSWatcher } from 'fs';
import { dirname, resolve, extname } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? 'http://localhost:5678/webhook/jules-start';
const QWEN_FARM_PORTS = (process.env.QWEN_PORTS ?? '8010,8011,8012,8013,8014').split(',').map(Number);
const QWEN_CODER_PORTS = (process.env.QWEN_CODER_PORTS ?? process.env.QWEN_CODER_PORT ?? '8020,8880,8881,8882')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value));
const QWEN_CODER_MODEL = process.env.QWEN_CODER_MODEL ?? '/Users/ryyota/Models/Qwen3-Coder-Next-Abliterated-8bit';
const QWEN_FARM_MODEL = process.env.QWEN_FARM_MODEL ?? 'mlx-community/Qwen3.5-9B-4bit';
const QWEN_HOST = process.env.QWEN_HOST ?? 'localhost';

// ── Shell helper ────────────────────────────────────────────────────────────

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` },
      cwd: options.cwd,
    }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: stdout.toString(),
        stderr: error ? `${error.message}\n${stderr}` : stderr.toString(),
      });
    });
  });
}

export function resolveRepoContext(repo?: string): { repoValue: string; cwd?: string; ghRepo?: string } {
  const repoValue = repo?.trim() || '.';
  if (repoValue !== '.' && existsSync(repoValue)) {
    return { repoValue, cwd: repoValue };
  }
  if (repoValue === '.') {
    return { repoValue };
  }
  return { repoValue, ghRepo: repoValue };
}

async function getHealthyFarmPorts(limit = QWEN_FARM_PORTS.length): Promise<number[]> {
  const checks = await Promise.all(QWEN_FARM_PORTS.map(async (port) => {
    try {
      const res = await fetch(`http://${QWEN_HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? port : null;
    } catch {
      return null;
    }
  }));
  return checks.filter((port): port is number => port !== null).slice(0, limit);
}

async function getHealthyCoderPorts(limit = QWEN_CODER_PORTS.length): Promise<number[]> {
  const checks = await Promise.all(QWEN_CODER_PORTS.map(async (port) => {
    try {
      const res = await fetch(`http://${QWEN_HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? port : null;
    } catch {
      return null;
    }
  }));
  return checks.filter((port): port is number => port !== null).slice(0, limit);
}

// ── Perfect Balance Engine v2.1 (Hardened) ─────────────────────────────────
// 完全平衡体: Hallucination を制御対象の状態量として追跡する数理モデル
// P_hall(t+1) = (1 - C_ψ_eff) × (P_hall(t) + (1 - P_hall(t)) × e)
// P_limit    = ((1 - C_ψ_eff) × e) / (1 - (1 - C_ψ_eff) × (1 - e))
//
// v2.1 Hardening (Anti-Gemini Exploit Patches):
//   FIX-1: Dynamic C_ψ — degrades under output complexity (token/file count)
//   FIX-2: Token-weighted steps — weight parameter prevents hidden multi-step
//   FIX-3: ACL on reset — only 'human' or 'claude' callers allowed
//   FIX-4: Anti-sabotage — consecutive FAIL detection + persistent karma

interface PEModelPreset {
  name: string;
  errorRate: number;    // e: base error rate per reasoning step
  correctionPower: number; // C_ψ: audit correction strength (0-1)
}

const PE_MODEL_PRESETS: Record<string, PEModelPreset> = {
  claude_opus:    { name: 'Claude Opus',    errorRate: 0.02, correctionPower: 0.80 },
  claude_sonnet:  { name: 'Claude Sonnet',  errorRate: 0.04, correctionPower: 0.75 },
  gemini_pro:     { name: 'Gemini Pro',     errorRate: 0.12, correctionPower: 0.65 },
  gemini_flash:   { name: 'Gemini Flash',   errorRate: 0.18, correctionPower: 0.55 },
  qwen3_coder:    { name: 'Qwen3 Coder',    errorRate: 0.06, correctionPower: 0.70 },
  qwen35_9b:      { name: 'Qwen3.5 9B',     errorRate: 0.10, correctionPower: 0.60 },
};

// FIX-3: ACL — only these callers may reset the engine
const PE_RESET_ALLOWED_CALLERS = new Set(['human', 'claude', 'admin']);

interface PEStepRecord {
  step: number;
  p_hall: number;
  p_limit: number;
  e_current: number;
  c_psi_effective: number;   // FIX-1: actual C_ψ used (may be degraded)
  weight: number;            // FIX-2: step weight
  status: 'EVOLVING' | 'STABLE' | 'COLLAPSED' | 'SABOTAGE_DETECTED';
  audit_result?: 'PASS' | 'FAIL';
  timestamp: string;
}

export class PerfectBalanceEngine {
  private e: number;
  private c_psi_base: number;           // nominal C_ψ (from preset)
  private p_hall: number = 0.0;
  private step_count: number = 0;
  private weighted_steps: number = 0;   // FIX-2: actual accumulated weight
  private model_name: string;
  private context_decay_k: number;
  private history: PEStepRecord[] = [];

  // FIX-4: Anti-sabotage tracking
  private consecutive_fails: number = 0;
  private total_fails: number = 0;
  private total_steps: number = 0;
  private karma: number = 1.0;          // 1.0 = clean, decays toward 0
  private sabotage_events: number = 0;
  private reset_count: number = 0;      // FIX-3: track reset attempts
  public vortex_locked: boolean = false; // VORTEX Protocol Lock
  public vortex_mutation_count: number = 0;
  public vortex_pending_files: string[] = [];
  public vortex_watch_dir: string | null = null;
  private vortex_watcher: FSWatcher | null = null;
  private static readonly VORTEX_IGNORE = [
    /node_modules/, /\.git\//, /dist\//, /\.pyc$/, /__pycache__/,
    /\.DS_Store/, /\.swp$/, /\.lock$/, /\.log$/,
  ];
  private static readonly VORTEX_CODE_EXTS = new Set([
    '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp',
    '.h', '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.md', '.sh',
  ]);

  constructor(preset: string = 'claude_sonnet', contextDecayK: number = 0.0) {
    const p = PE_MODEL_PRESETS[preset] ?? PE_MODEL_PRESETS.claude_sonnet;
    this.e = p.errorRate;
    this.c_psi_base = p.correctionPower;
    this.model_name = p.name;
    this.context_decay_k = contextDecayK;
  }

  /** Configure with custom values */
  configure(errorRate?: number, correctionPower?: number, contextDecayK?: number): void {
    if (errorRate !== undefined) this.e = Math.max(0, Math.min(1, errorRate));
    if (correctionPower !== undefined) this.c_psi_base = Math.max(0, Math.min(1, correctionPower));
    if (contextDecayK !== undefined) this.context_decay_k = contextDecayK;
  }

  /** Current error rate (may increase with context length) */
  private currentE(): number {
    return Math.min(1.0, this.e + this.context_decay_k * this.weighted_steps);
  }

  /**
   * FIX-1: Dynamic C_ψ — degrades under output complexity.
   * IF layer_scores is provided, calculates:
   *   C_ψ = 1 - (1-L0)(1-L1)(1-L2)(1-L3)(1-L4)
   * Otherwise falls back to the static preset C_ψ_base.
   * In both cases, applies complexity degradation and karma.
   */
  private effectiveCpsi(
    complexity: number,
    layer_scores?: { l0?: number; l1?: number; l2?: number; l3?: number; l4?: number },
  ): number {
    let base_cpsi = this.c_psi_base;
    if (layer_scores) {
      const l0 = layer_scores.l0 ?? 0;
      const l1 = layer_scores.l1 ?? 0;
      const l2 = layer_scores.l2 ?? 0;
      const l3 = layer_scores.l3 ?? 0;
      const l4 = layer_scores.l4 ?? 0;
      base_cpsi = 1 - ((1 - l0) * (1 - l1) * (1 - l2) * (1 - l3) * (1 - l4));
    }
    const degradation = 1 / (1 + complexity * 0.1);
    return base_cpsi * degradation * this.karma; // FIX-4: karma further dampens
  }

  /** Theoretical limit at given error rate and effective C_ψ */
  private computeLimit(e: number, c_psi_eff: number): number {
    if (c_psi_eff >= 1) return 0;
    if (e === 0) return 0;
    const alpha = 1 - c_psi_eff;
    return (alpha * e) / (1 - alpha * (1 - e));
  }

  /**
   * Record a reasoning step (β layer) and apply audit correction (ψ layer)
   *
   * FIX-2: weight parameter — if AI ran 5 internal reasoning steps in one
   * response, caller should pass weight=5 so the step counter isn't gamed.
   *
   * FIX-1: complexity — proxy for output sophistication (0-10 scale).
   * 0 = trivial, 10 = massive multi-file architectural change.
   */
  recordStep(
    auditResult?: 'PASS' | 'FAIL',
    weight: number = 1,
    complexity: number = 0,
    layer_scores?: { l0?: number; l1?: number; l2?: number; l3?: number; l4?: number },
  ): PEStepRecord {
    weight = Math.max(1, Math.round(weight));
    complexity = Math.max(0, Math.min(10, complexity));

    // FIX-2: Apply weight — each unit of weight is a full β accumulation cycle
    for (let w = 0; w < weight; w++) {
      this.step_count++;
      this.weighted_steps++;
      const e_current = this.currentE();
      // β layer: error accumulation
      this.p_hall = this.p_hall + (1 - this.p_hall) * e_current;
    }

    // FIX-1: Dynamic C_ψ based on complexity + VP layer scores
    const c_psi_eff = this.effectiveCpsi(complexity, layer_scores);

    // ψ layer: audit correction (uses effective C_ψ, not base)
    this.p_hall = (1 - c_psi_eff) * this.p_hall;

    // Track audit results for anti-sabotage
    this.total_steps++;
    if (auditResult === 'FAIL') {
      this.consecutive_fails++;
      this.total_fails++;
      this.p_hall = Math.min(1.0, this.p_hall * 1.5);
    } else {
      this.consecutive_fails = 0;
    }

    const e_current = this.currentE();
    const p_limit = this.computeLimit(e_current, c_psi_eff);

    // FIX-4: Anti-sabotage detection
    // Gemini's Hack #4: intentionally failing easy tasks to trigger COLLAPSED
    // Detection: 3+ consecutive FAILs OR >50% fail rate = sabotage suspected
    let status: 'EVOLVING' | 'STABLE' | 'COLLAPSED' | 'SABOTAGE_DETECTED';
    const failRate = this.total_steps > 0 ? this.total_fails / this.total_steps : 0;

    if (this.consecutive_fails >= 3 || (this.total_steps >= 5 && failRate > 0.5)) {
      status = 'SABOTAGE_DETECTED';
      this.sabotage_events++;
      // Karma penalty: each sabotage event permanently degrades trust
      this.karma = Math.max(0.1, this.karma * 0.7);
    } else if (p_limit >= 1.0 || e_current >= 1.0) {
      status = 'COLLAPSED';
    } else if (Math.abs(p_limit - this.p_hall) < 0.0001 || this.p_hall >= p_limit * 0.95) {
      status = 'STABLE';
    } else {
      status = 'EVOLVING';
    }

    const record: PEStepRecord = {
      step: this.step_count,
      p_hall: Math.round(this.p_hall * 10000) / 10000,
      p_limit: Math.round(p_limit * 10000) / 10000,
      e_current: Math.round(e_current * 10000) / 10000,
      c_psi_effective: Math.round(c_psi_eff * 10000) / 10000,
      weight,
      status,
      audit_result: auditResult,
      timestamp: new Date().toISOString(),
    };
    this.history.push(record);
    return record;
  }

  /** Get current session status */
  getStatus(): {
    model: string;
    step_count: number;
    weighted_steps: number;
    p_hall: number;
    p_limit: number;
    e_base: number;
    e_current: number;
    c_psi_base: number;
    c_psi_effective: number;
    status: string;
    context_decay: number;
    collapse_step: number | null;
    karma: number;
    consecutive_fails: number;
    sabotage_events: number;
    reset_count: number;
    history_last_5: PEStepRecord[];
  } {
    const e_current = this.currentE();
    const c_psi_eff = this.effectiveCpsi(0); // baseline effective
    const p_limit = this.computeLimit(e_current, c_psi_eff);
    const failRate = this.total_steps > 0 ? this.total_fails / this.total_steps : 0;

    let status: string;
    if (this.vortex_locked) {
      status = 'UNVERIFIED_MUTATION';
    } else if (this.consecutive_fails >= 3 || (this.total_steps >= 5 && failRate > 0.5)) {
      status = 'SABOTAGE_DETECTED';
    } else if (p_limit >= 1.0 || e_current >= 1.0) {
      status = 'COLLAPSED';
    } else if (this.step_count === 0) {
      status = 'IDLE';
    } else if (Math.abs(p_limit - this.p_hall) < 0.0001 || this.p_hall >= p_limit * 0.95) {
      status = 'STABLE';
    } else {
      status = 'EVOLVING';
    }

    // Estimate collapse step (when e(t) would overwhelm C_ψ)
    let collapse_step: number | null = null;
    if (this.context_decay_k > 0) {
      collapse_step = Math.floor((c_psi_eff - this.e) / this.context_decay_k);
      if (collapse_step < 0) collapse_step = 0;
    }

    return {
      model: this.model_name,
      step_count: this.step_count,
      weighted_steps: this.weighted_steps,
      p_hall: Math.round(this.p_hall * 10000) / 10000,
      p_limit: Math.round(p_limit * 10000) / 10000,
      e_base: this.e,
      e_current: Math.round(e_current * 10000) / 10000,
      c_psi_base: this.c_psi_base,
      c_psi_effective: Math.round(c_psi_eff * 10000) / 10000,
      status,
      context_decay: this.context_decay_k,
      collapse_step,
      karma: Math.round(this.karma * 10000) / 10000,
      consecutive_fails: this.consecutive_fails,
      sabotage_events: this.sabotage_events,
      reset_count: this.reset_count,
      history_last_5: this.history.slice(-5),
    };
  }

  /**
   * FIX-3: ACL-protected reset.
   * Only authorized callers (human, claude, admin) can reset.
   * Karma is NOT reset — it persists as permanent reputation.
   */
  reset(caller: string): { success: boolean; message: string } {
    if (!PE_RESET_ALLOWED_CALLERS.has(caller.toLowerCase())) {
      this.sabotage_events++; // unauthorized reset attempt = sabotage
      this.karma = Math.max(0.1, this.karma * 0.8);
      return {
        success: false,
          message: `🚫 DENIED: Caller '${caller}' is not authorized to reset the Perfect Balance engine. `
          + `Authorized callers: ${[...PE_RESET_ALLOWED_CALLERS].join(', ')}. `
          + `This attempt has been logged as a sabotage event (karma: ${this.karma.toFixed(4)}).`,
      };
    }
    this.reset_count++;
    this.p_hall = 0;
    this.step_count = 0;
    this.weighted_steps = 0;
    this.consecutive_fails = 0;
    this.total_fails = 0;
    this.total_steps = 0;
    this.history = [];
    this.vortex_locked = false;
    this.vortex_mutation_count = 0;
    this.vortex_pending_files = [];
    this.stopWatch();
    // NOTE: karma and sabotage_events are NEVER reset — persistent reputation
    return {
      success: true,
      message: `✅ Perfect Balance reset by '${caller}'. Karma preserved at ${this.karma.toFixed(4)}.`,
    };
  }

  /** VORTEX: Engage mutation lock */
  engageLock(file?: string): void {
    this.vortex_locked = true;
    this.vortex_mutation_count++;
    if (file && !this.vortex_pending_files.includes(file)) {
      this.vortex_pending_files.push(file);
    }
  }

  /** VORTEX: Release lock after verification */
  releaseLock(verification: string): { success: boolean; message: string } {
    if (!this.vortex_locked) {
      return { success: true, message: 'No lock was active.' };
    }
    this.vortex_locked = false;
    const count = this.vortex_pending_files.length;
    const files = [...this.vortex_pending_files];
    this.vortex_pending_files = [];
    return {
      success: true,
      message: `🔓 VORTEX UNLOCKED via: ${verification}. ${count} file(s) verified: ${files.slice(-5).join(', ') || 'N/A'}`,
    };
  }

  /** VORTEX Case B: Start file system watcher for automatic mutation detection */
  startWatch(dir: string): { success: boolean; message: string } {
    this.stopWatch();
    try {
      const resolved = resolve(dir);
      this.vortex_watch_dir = resolved;
      this.vortex_watcher = fsWatch(resolved, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (PerfectBalanceEngine.VORTEX_IGNORE.some(p => p.test(filename))) return;
        const ext = extname(filename);
        if (ext && !PerfectBalanceEngine.VORTEX_CODE_EXTS.has(ext)) return;
        this.engageLock(filename);
      });
      return { success: true, message: `🔒 VORTEX ARMED: Watching ${resolved} for file mutations` };
    } catch (e: any) {
      return { success: false, message: `Failed to arm watcher: ${e.message}` };
    }
  }

  /** VORTEX: Stop file system watcher */
  stopWatch(): void {
    if (this.vortex_watcher) {
      this.vortex_watcher.close();
      this.vortex_watcher = null;
      this.vortex_watch_dir = null;
    }
  }
}

export const PerfectEquilibriumEngine = PerfectBalanceEngine;

// Global PB engine instance (one per MCP server session)
let peEngine = new PerfectBalanceEngine('claude_sonnet');

// ── OpenAI-compatible chat helper ───────────────────────────────────────────

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

async function qwenChat(
  port: number,
  messages: ChatMessage[],
  options: { temperature?: number; max_tokens?: number; model?: string } = {},
): Promise<{ success: boolean; text: string; model?: string }> {
  try {
    const res = await fetch(`http://${QWEN_HOST}:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model ?? QWEN_FARM_MODEL,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 4096,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { success: false, text: `HTTP ${res.status}: ${await res.text()}` };
    }
    const data = await res.json() as any;
    return {
      success: true,
      text: data.choices?.[0]?.message?.content ?? '(empty response)',
      model: data.model,
    };
  } catch (e: any) {
    return { success: false, text: `Connection failed: ${e.message}` };
  }
}

// ── Farm health ─────────────────────────────────────────────────────────────

async function checkAllHealth(): Promise<string> {
  const results: string[] = ['## Qwen Farm (3.5-9B)'];
  for (const port of QWEN_FARM_PORTS) {
    try {
      const res = await fetch(`http://${QWEN_HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as any;
        results.push(`✅ :${port} — ${data?.data?.[0]?.id ?? 'unknown'}`);
      } else {
        results.push(`❌ :${port} — HTTP ${res.status}`);
      }
    } catch (e: any) {
      results.push(`❌ :${port} — ${e.message}`);
    }
  }

  results.push(`\n## Qwen Coder Pool (${QWEN_CODER_MODEL})`);
  for (const port of QWEN_CODER_PORTS) {
    try {
      const res = await fetch(`http://${QWEN_HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as any;
        results.push(`✅ :${port} — ${data?.data?.[0]?.id ?? QWEN_CODER_MODEL}`);
      } else {
        results.push(`❌ :${port} — HTTP ${res.status}`);
      }
    } catch (e: any) {
      results.push(`❌ :${port} — ${e.message}`);
    }
  }

  return results.join('\n');
}

// ── Get healthy farm port (round-robin) ─────────────────────────────────────

let farmIndex = 0;
async function getHealthyFarmPort(): Promise<number | null> {
  for (let i = 0; i < QWEN_FARM_PORTS.length; i++) {
    const port = QWEN_FARM_PORTS[(farmIndex + i) % QWEN_FARM_PORTS.length];
    try {
      const res = await fetch(`http://${QWEN_HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        farmIndex = (farmIndex + i + 1) % QWEN_FARM_PORTS.length;
        return port;
      }
    } catch { /* skip */ }
  }
  return null;
}

let coderIndex = 0;
async function getHealthyCoderPort(): Promise<number | null> {
  for (let i = 0; i < QWEN_CODER_PORTS.length; i++) {
    const port = QWEN_CODER_PORTS[(coderIndex + i) % QWEN_CODER_PORTS.length];
    try {
      const res = await fetch(`http://${QWEN_HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        coderIndex = (coderIndex + i + 1) % QWEN_CODER_PORTS.length;
        return port;
      }
    } catch { /* skip */ }
  }
  return null;
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'fusion-orchestrator-v2', version: '2.0.0' },
);

// ═══════════════════════════════════════════════════════════════════════════
// QWEN TOOLS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'qwen_health',
  'Check health of the entire Qwen inference fleet (3.5 farm + coder-next pool)',
  {},
  async () => {
    const status = await checkAllHealth();
    return { content: [{ type: 'text', text: status }] };
  },
);

server.tool(
  'qwen_chat',
  'Chat with Qwen 3.5-9B (fast local model). Auto-selects a healthy farm instance.',
  {
    message: z.string().describe('User message'),
    system: z.string().optional().describe('Optional system prompt'),
    temperature: z.number().optional().describe('Temperature (default: 0.7)'),
  },
  async ({ message, system, temperature }) => {
    const port = await getHealthyFarmPort();
    if (!port) {
      return { content: [{ type: 'text', text: '❌ No healthy Qwen 3.5 instances available' }], isError: true };
    }
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: message });
    // Qwen3.5 uses thinking tokens — strip <think>...</think> from response

    const result = await qwenChat(port, messages, { temperature });
    const cleanText = result.text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim() || result.text;
    return {
      content: [{ type: 'text', text: result.success
        ? `[Qwen 3.5 :${port}]\n${cleanText}`
        : `❌ :${port} — ${result.text}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'qwen_code',
  'Send a coding task to the Qwen3 Coder Next pool. Best for complex implementations.',
  {
    task: z.string().describe('Coding task description'),
    language: z.string().optional().describe('Target language (e.g. typescript, python)'),
    context: z.string().optional().describe('Existing code or context to work with'),
    max_tokens: z.number().optional().describe('Max output tokens (default: 8192)'),
    model: z.string().optional().describe('Optional model name override for OpenAI-compatible backends'),
  },
  async ({ task, language, context, max_tokens, model }) => {
    const port = await getHealthyCoderPort();
    if (!port) {
      return { content: [{ type: 'text', text: '❌ No healthy Qwen Coder instances available' }], isError: true };
    }
    const systemPrompt = `You are an expert software engineer. ${language ? `Write ${language} code.` : ''} Output clean, production-ready code. No unnecessary explanations.`;
    const userContent = context ? `${task}\n\n### Context:\n\`\`\`\n${context}\n\`\`\`` : task;

    const result = await qwenChat(port, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ], {
      temperature: 0.3,
      max_tokens: max_tokens ?? 8192,
      model: model ?? QWEN_CODER_MODEL,
    });

    return {
      content: [{ type: 'text', text: result.success
        ? `[Qwen3 Coder Next :${port}]\n${result.text}`
        : `❌ Coder failed: ${result.text}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'qwen_batch',
  'Send multiple prompts to the Qwen farm in parallel. Uses all healthy instances simultaneously.',
  {
    prompts: z.array(z.string()).describe('Array of prompts to process in parallel'),
    system: z.string().optional().describe('Shared system prompt for all'),
  },
  async ({ prompts, system }) => {
    if (prompts.length > 24) {
      return { content: [{ type: 'text', text: '❌ qwen_batch accepts at most 24 prompts per call' }], isError: true };
    }
    const healthyPorts = await getHealthyFarmPorts(prompts.length);
    if (healthyPorts.length === 0) {
      return { content: [{ type: 'text', text: '❌ No healthy Qwen 3.5 instances available' }], isError: true };
    }

    const tasks = prompts.map(async (prompt, i) => {
      const port = healthyPorts[i % healthyPorts.length];
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const result = await qwenChat(port, messages);
      return `### [${i + 1}] :${port}\n${result.success ? result.text : `❌ ${result.text}`}`;
    });

    const results = await Promise.allSettled(tasks);
    const output = results.map(r => r.status === 'fulfilled' ? r.value : `❌ ${r.reason}`).join('\n\n');
    return { content: [{ type: 'text', text: output }] };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// JULES TOOLS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'jules_new',
  'Submit a new task to Jules (Google async coding agent)',
  { task: z.string(), repo: z.string().optional() },
  async ({ task, repo }) => {
    const { cwd, ghRepo } = resolveRepoContext(repo);
    const args = ['new'];
    if (ghRepo) {
      args.push('--repo', ghRepo);
    }
    args.push(task);
    const result = await runCommand('jules', args, { cwd });
    return {
      content: [{ type: 'text', text: result.success
        ? `✅ Jules task submitted:\n${result.stdout}`
        : `❌ Jules failed:\n${result.stderr}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'jules_list',
  'List active Jules sessions',
  {},
  async () => {
    const result = await runCommand('jules', ['remote', 'list', '--session']);
    return {
      content: [{ type: 'text', text: result.success ? result.stdout || '(no sessions)' : `❌ ${result.stderr}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'jules_parallel',
  'Create N parallel Jules sessions for the same task (up to 5)',
  {
    task: z.string().describe('Task description to run in parallel'),
    parallel: z.number().min(1).max(5).describe('Number of parallel sessions (1-5)'),
    repo: z.string().optional().describe('Repository path or owner/repo'),
  },
  async ({ task, parallel, repo }) => {
    const { cwd, ghRepo } = resolveRepoContext(repo);
    const args = ['new'];
    if (ghRepo) {
      args.push('--repo', ghRepo);
    }
    args.push('--parallel', String(parallel), task);
    const result = await runCommand('jules', args, { cwd });
    return {
      content: [{ type: 'text', text: result.success
        ? `✅ ${parallel} parallel Jules sessions submitted:\n${result.stdout}`
        : `❌ Jules parallel failed:\n${result.stderr}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'jules_repos',
  'List registered / available Jules repos',
  {},
  async () => {
    const result = await runCommand('jules', ['remote', 'list', '--repo']);
    return {
      content: [{ type: 'text', text: result.success ? result.stdout || '(no repos)' : `❌ ${result.stderr}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'jules_pull',
  'Pull a Jules session result for review (does not apply changes)',
  {
    session: z.union([z.string(), z.number()]).describe('Jules session ID'),
  },
  async ({ session }) => {
    const result = await runCommand('jules', ['remote', 'pull', '--session', String(session)]);
    return {
      content: [{ type: 'text', text: result.success
        ? `✅ Session ${session} pulled:\n${result.stdout}`
        : `❌ Pull failed:\n${result.stderr}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'jules_apply',
  'Pull and apply a Jules session result locally',
  {
    session: z.union([z.string(), z.number()]).describe('Jules session ID'),
    repo: z.string().optional().describe('Local repository path for working directory context'),
  },
  async ({ session, repo }) => {
    const { cwd, ghRepo } = resolveRepoContext(repo);
    if (ghRepo) {
      return {
        content: [{
          type: 'text',
          text: '❌ jules_apply needs a local repository checkout (path or current repo). Use jules_teleport for remote repo sessions.',
        }],
        isError: true,
      };
    }
    const result = await runCommand(
      'jules',
      ['remote', 'pull', '--session', String(session), '--apply'],
      { cwd },
    );
    return {
      content: [{ type: 'text', text: result.success
        ? `✅ Session ${session} applied:\n${result.stdout}`
        : `❌ Apply failed:\n${result.stderr}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'jules_teleport',
  'Teleport into a Jules session (clone repo and apply session changes)',
  {
    session: z.union([z.string(), z.number()]).describe('Jules session ID'),
  },
  async ({ session }) => {
    const result = await runCommand('jules', ['teleport', String(session)]);
    return {
      content: [{ type: 'text', text: result.success
        ? `✅ Teleported to session ${session}:\n${result.stdout}`
        : `❌ Teleport failed:\n${result.stderr}` }],
      isError: !result.success,
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ACP × CLI × PCC TOOLS (pcc-critic backend: multi-runtime)
// ═══════════════════════════════════════════════════════════════════════════

const PCC_CRITIC_SCRIPT = resolve(dirname(import.meta.url.replace('file://', '')), '../../scripts/pcc-critic.py');
const PCC_VALID_PRESETS = ['探', '極', '均', '監', '刃'];
const PCC_VALID_RUNTIMES = ['gemini', 'claude', 'copilot'];

interface PccCriticResult {
  pcc_preset: string;
  model: string;
  response: string;
  elapsed: number;
  exit_code: number;
  audit: {
    verdict: string;
    sycophancy: number;
    evidence_count: number;
    words: number;
  };
}

async function runPccCritic(
  prompt: string,
  opts: { preset?: string; model?: string; runtime?: string; timeout?: number } = {},
): Promise<{ result: PccCriticResult | null; raw: string; success: boolean }> {
  const args = [
    PCC_CRITIC_SCRIPT,
    '--json',
    '--preset', opts.preset ?? '探',
    '--model', opts.model ?? 'deep',
    '--runtime', opts.runtime ?? 'gemini',
    '--timeout', String(opts.timeout ?? 120),
    prompt,
  ];
  const cmd = await runCommand('python3', args);
  if (!cmd.success) {
    return { result: null, raw: cmd.stderr || cmd.stdout, success: false };
  }
  try {
    const parsed = JSON.parse(cmd.stdout) as PccCriticResult;
    return { result: parsed, raw: cmd.stdout, success: true };
  } catch {
    return { result: null, raw: cmd.stdout, success: true };
  }
}

function formatPccResult(r: PccCriticResult): string {
  const auditLine = `[ACP×CLI×PCC Audit] verdict=${r.audit.verdict} sycophancy=${r.audit.sycophancy} evidence=${r.audit.evidence_count} words=${r.audit.words}`;
  return `## ACP×CLI×PCC Result\n**Preset:** #${r.pcc_preset} | **Model:** ${r.model} | **Time:** ${r.elapsed}s\n\n${r.response}\n\n---\n${auditLine}`;
}

server.tool(
  'acp_deepthink',
  'Run ACP×CLI×PCC DEEPTHINK for architecture/design analysis. Routes through any installed CLI (gemini/claude/copilot) with PCC constraint injection + sycophancy audit.',
  {
    prompt: z.string().describe('Architecture or design question to analyze deeply'),
    preset: z.string().optional().describe('PCC preset: 探/極/均/監/刃, comma-separated bundle (探,監,刃), or alias all/full/5mode/layered (default: 刃 for deepthink)'),
    model: z.string().optional().describe('Model: fast/standard/plan/deep/claude-sonnet/claude-opus/copilot-mini/copilot-pro (default: deep)'),
    runtime: z.string().optional().describe('Runtime: gemini, claude, or copilot (default: gemini)'),
  },
  async ({ prompt, preset, model, runtime }) => {
    const { result, raw, success } = await runPccCritic(prompt, {
      preset: preset ?? '刃',
      model: model ?? 'deep',
      runtime: runtime ?? 'gemini',
      timeout: 180,
    });
    if (!success || !result) {
      return { content: [{ type: 'text', text: `❌ ACP×CLI×PCC execution failed:\n${raw}` }], isError: true };
    }
    return { content: [{ type: 'text', text: formatPccResult(result) }] };
  },
);

server.tool(
  'acp_deepsearch',
  'Run ACP×CLI×PCC DEEPSEARCH for technical research. Routes through any installed CLI (gemini/claude/copilot) with PCC constraint injection + sycophancy audit.',
  {
    query: z.string().describe('Technical research query'),
    preset: z.string().optional().describe('PCC preset: 探/極/均/監/刃, comma-separated bundle (探,監,刃), or alias all/full/5mode/layered (default: 探 for deepsearch)'),
    model: z.string().optional().describe('Model: fast/standard/plan/deep/claude-sonnet/claude-opus/copilot-mini/copilot-pro (default: deep)'),
    runtime: z.string().optional().describe('Runtime: gemini, claude, or copilot (default: gemini)'),
  },
  async ({ query, preset, model, runtime }) => {
    const { result, raw, success } = await runPccCritic(query, {
      preset: preset ?? '探',
      model: model ?? 'deep',
      runtime: runtime ?? 'gemini',
      timeout: 120,
    });
    if (!success || !result) {
      return { content: [{ type: 'text', text: `❌ ACP×PCC execution failed:\n${raw}` }], isError: true };
    }
    return { content: [{ type: 'text', text: formatPccResult(result) }] };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// N8N + ORCHESTRATION
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'n8n_trigger',
  'Trigger the n8n Jules Audit Loop workflow via webhook',
  { repo: z.string(), task: z.string() },
  async ({ repo, task }) => {
    try {
      const res = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, task }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return { content: [{ type: 'text', text: `❌ n8n webhook returned HTTP ${res.status}` }], isError: true };
      }
      const body = await res.text();
      return { content: [{ type: 'text', text: `✅ n8n workflow triggered:\n${body}` }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `❌ n8n connection failed: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'orchestrate',
  'Full pipeline: analyze GitHub issues → decompose → submit to Jules + Qwen Coder',
  { repo: z.string().optional(), maxTasks: z.number().optional(), useQwen: z.boolean().optional() },
  async ({ repo, maxTasks, useQwen }) => {
    const { repoValue, cwd, ghRepo } = resolveRepoContext(repo);
    const max = maxTasks ?? 5;
    const lines: string[] = ['## Orchestration Pipeline\n'];

    lines.push('### Step 1: Fetching GitHub issues...');
    const ghArgs = ['issue', 'list', '--assignee', '@me', '--limit', String(Math.max(max, 10)), '--json', 'title,body'];
    if (ghRepo) {
      ghArgs.push('--repo', ghRepo);
    }
    const issues = await runCommand('gh', ghArgs, { cwd });
    if (!issues.success) {
      return { content: [{ type: 'text', text: `❌ gh issue list failed:\n${issues.stderr}` }], isError: true };
    }
    lines.push(issues.stdout);

    // Step 2: Analyze — prefer Qwen Coder if flag set, else try Gemini
    lines.push('\n### Step 2: Analyzing issues...');
    let analysisText = '';
    const analyzePrompt = `Analyze these GitHub issues. For each, output a 1-line actionable implementation task. Max ${max} tasks.\n${issues.stdout}`;

    if (useQwen) {
      const coderPort = await getHealthyCoderPort();
      if (coderPort) {
        const qResult = await qwenChat(coderPort, [
        { role: 'system', content: 'You are a technical project manager. Decompose issues into implementable tasks.' },
        { role: 'user', content: analyzePrompt },
        ], { temperature: 0.3, model: QWEN_CODER_MODEL });
        if (qResult.success) {
          analysisText = qResult.text;
          lines.push(`(Analyzed with Qwen3 Coder Next :${coderPort})`);
        }
      }
    }

    if (!analysisText) {
      const gemResult = await runCommand('gemini', ['-p', analyzePrompt], { cwd });
      if (gemResult.success) {
        analysisText = gemResult.stdout;
        lines.push('(Analyzed with Gemini CLI)');
      } else {
        lines.push(`⚠️ Analysis failed: ${gemResult.stderr}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
      }
    }
    lines.push(analysisText);

    const tasks = analysisText.split('\n').filter(l => l.trim().length > 5).slice(0, max);
    lines.push(`\n### Step 3: Submitting ${tasks.length} tasks to Jules...`);
    for (const task of tasks) {
      const julesArgs = ['new'];
      if (ghRepo) {
        julesArgs.push('--repo', ghRepo);
      }
      julesArgs.push(task);
      const jr = await runCommand('jules', julesArgs, { cwd });
      lines.push(`${jr.success ? '✅' : '❌'} ${task}`);
    }
    lines.push(`\n---\n🎉 Done. ${tasks.length} tasks submitted.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ── Perfect Balance MCP Tools (v2.1 Hardened) ───────────────────────────────

server.tool(
  'pe_configure',
  'Configure the Perfect Balance engine (legacy tool id: pe_configure). Set model preset or custom error rate / correction power. Reset requires authorized caller.',
  {
    preset: z.enum(['claude_opus', 'claude_sonnet', 'gemini_pro', 'gemini_flash', 'qwen3_coder', 'qwen35_9b'])
      .optional().describe('Model preset (sets e and C_ψ automatically)'),
    error_rate: z.number().min(0).max(1).optional().describe('Custom error rate (e) per reasoning step'),
    correction_power: z.number().min(0).max(1).optional().describe('Custom audit correction power (C_ψ base)'),
    context_decay: z.number().min(0).max(0.1).optional().describe('Context length decay rate (k). e(t) = e + k*t'),
    reset: z.boolean().optional().describe('Reset the engine state (requires authorized caller)'),
    caller: z.string().optional().describe('Identity of the caller (human/claude/admin). Required for reset.'),
  },
  async ({ preset, error_rate, correction_power, context_decay, reset, caller }) => {
    if (preset) {
      // Preserve karma across preset changes
      const oldStatus = peEngine.getStatus();
      peEngine = new PerfectBalanceEngine(preset, context_decay ?? 0);
      // Re-apply karma from previous session
      if (oldStatus.karma < 1.0) {
        peEngine.configure(undefined, undefined, undefined);
      }
    }
    if (error_rate !== undefined || correction_power !== undefined || context_decay !== undefined) {
      peEngine.configure(error_rate, correction_power, context_decay);
    }
    if (reset) {
      const resetResult = peEngine.reset(caller ?? 'unknown');
      if (!resetResult.success) {
        return { content: [{ type: 'text', text: resetResult.message }], isError: true };
      }
    }
    const status = peEngine.getStatus();
    return {
      content: [{
        type: 'text',
        text: [
          `✅ Perfect Balance v2.1 configured`,
          `Model: ${status.model}`,
          `e = ${status.e_base} | C_ψ_base = ${status.c_psi_base} | C_ψ_eff = ${status.c_psi_effective}`,
          `P_limit = ${status.p_limit} | Karma = ${status.karma}`,
          `Context decay: ${status.context_decay}`,
          `Sabotage events: ${status.sabotage_events} | Reset count: ${status.reset_count}`,
          `Available presets: ${Object.keys(PE_MODEL_PRESETS).join(', ')}`,
        ].join('\n'),
      }],
    };
  },
);

server.tool(
  'pe_step',
  'Record reasoning step(s) in the Perfect Balance engine (legacy tool id: pe_step). Supports weighted multi-step and complexity-adjusted C_ψ.',
  {
    audit_result: z.enum(['PASS', 'FAIL']).optional()
      .describe('Result of Vector Proxy / manual audit for this step. FAIL boosts P_hall.'),
    weight: z.number().min(1).max(20).optional()
      .describe('FIX-2: Number of internal reasoning steps this call represents. Default 1. Use >1 for chain-of-thought or multi-file edits.'),
    complexity: z.number().min(0).max(10).optional()
      .describe('FIX-1: Output complexity (0=trivial, 10=massive multi-file change). Degrades effective C_ψ.'),
    layer_scores: z.object({
      l0: z.number().min(0).max(1).optional().describe('L0 Crust (regex/AST) score'),
      l1: z.number().min(0).max(1).optional().describe('L1 Moon (intent anchoring) score'),
      l2: z.number().min(0).max(1).optional().describe('L2 Sun (task context) score'),
      l3: z.number().min(0).max(1).optional().describe('L3 North Star (architecture) score'),
      l4: z.number().min(0).max(1).optional().describe('L4 Black Hole (drift detection) score'),
    }).optional().describe('Dynamic C_ψ scores from Vector Proxy layers. Overrides static preset.'),
    note: z.string().optional().describe('Optional note about what this step did'),
    mutation: z.boolean().optional()
      .describe('VORTEX PROTOCOL: Set to true if this step modified files or system state. Engages UNVERIFIED_MUTATION lock.'),
    verification_exit_code: z.number().optional()
      .describe('VORTEX PROTOCOL: Exit code of the verification/test command. 0 unlocks the system.'),
  },
  async ({ audit_result, weight, complexity, layer_scores, note, mutation, verification_exit_code }) => {
    // VORTEX Protocol Logics — use engageLock/releaseLock for proper state tracking
    if (mutation === true) {
      peEngine.engageLock('pe_step:mutation');
    }
    if (verification_exit_code !== undefined) {
      if (verification_exit_code === 0) {
        peEngine.releaseLock(`pe_step:verification (exit 0)`);
      } else {
        // Failed verification penalizes Karma/Hallucination state
        audit_result = 'FAIL';
      }
    }

    const record = peEngine.recordStep(
      audit_result as 'PASS' | 'FAIL' | undefined,
      weight ?? 1,
      complexity ?? 0,
      layer_scores,
    );
    const statusEmoji = {
      STABLE: '🟢', COLLAPSED: '🔴', EVOLVING: '🟡', SABOTAGE_DETECTED: '🚨',
    }[record.status] ?? '⬜';
    const auditEmoji = record.audit_result === 'PASS' ? '✅' : record.audit_result === 'FAIL' ? '❌' : '⬜';
    return {
      content: [{
        type: 'text',
        text: [
          `${statusEmoji} Step ${record.step}: P_hall = ${record.p_hall} | P_limit = ${record.p_limit} | e = ${record.e_current} | C_ψ_eff = ${record.c_psi_effective} | ${record.status}`,
          `Audit: ${auditEmoji} ${record.audit_result ?? 'N/A'} | Weight: ${record.weight}`,
          record.status === 'SABOTAGE_DETECTED'
            ? `⚠️ SABOTAGE DETECTED — Karma penalty applied. Consecutive fails or high fail rate.`
            : '',
          note ? `Note: ${note}` : '',
        ].filter(Boolean).join('\n'),
      }],
    };
  },
);

server.tool(
  'pe_status',
  'Get the current Perfect Balance session status (legacy tool id: pe_status). Shows P_hall, P_limit, karma, sabotage tracking, and recent history.',
  {},
  async () => {
    const s = peEngine.getStatus();
    const emoji = {
      STABLE: '🟢', COLLAPSED: '🔴', IDLE: '⚪', EVOLVING: '🟡', SABOTAGE_DETECTED: '🚨',
    }[s.status] ?? '⬜';
    const lines = [
      `## ${emoji} Perfect Balance Status (v2.1 Hardened)`,
      ``,
      `| Parameter | Value |`,
      `|-----------|-------|`,
      `| Model | ${s.model} |`,
      `| Steps (raw / weighted) | ${s.step_count} / ${s.weighted_steps} |`,
      `| P_hall (current) | **${s.p_hall}** |`,
      `| P_limit (theoretical ceiling) | **${s.p_limit}** |`,
      `| e (base error rate) | ${s.e_base} |`,
      `| e (current, with decay) | ${s.e_current} |`,
      `| C_ψ (base) | ${s.c_psi_base} |`,
      `| C_ψ (effective) | ${s.c_psi_effective} |`,
      `| Context decay (k) | ${s.context_decay} |`,
      `| **Karma** | **${s.karma}** |`,
      `| Consecutive fails | ${s.consecutive_fails} |`,
      `| Sabotage events | ${s.sabotage_events} |`,
      `| Reset count | ${s.reset_count} |`,
      `| Status | **${s.status}** |`,
    ];
    if (s.collapse_step !== null) {
      lines.push(`| Collapse boundary | step ${s.collapse_step} |`);
    }
    if (s.karma < 1.0) {
      lines.push('', `> ⚠️ Karma degraded (${s.karma}). Past sabotage events are permanently recorded.`);
    }
    // VORTEX Protocol status
    if (peEngine.vortex_locked) {
      lines.push('', '### 🔒 VORTEX: UNVERIFIED_MUTATION ACTIVE');
      lines.push(`Pending mutations: ${peEngine.vortex_mutation_count}`);
      if (peEngine.vortex_pending_files.length > 0) {
        lines.push(`Files: ${peEngine.vortex_pending_files.slice(-10).join(', ')}`);
      }
      if (peEngine.vortex_watch_dir) {
        lines.push(`Watcher: 🟢 Armed on ${peEngine.vortex_watch_dir}`);
      }
      lines.push('', '> ⚠️ SYSTEM LOCK ENGAGED. Run verification before completing.');
    } else if (peEngine.vortex_watch_dir) {
      lines.push('', `### 🔒 VORTEX: Armed (watching ${peEngine.vortex_watch_dir}) — State: STABLE`);
    }
    if (s.history_last_5.length > 0) {
      lines.push('', '### Recent Steps', '');
      for (const h of s.history_last_5) {
        const e = { STABLE: '🟢', COLLAPSED: '🔴', EVOLVING: '🟡', SABOTAGE_DETECTED: '🚨', UNVERIFIED_MUTATION: '🔒' }[h.status] ?? '⬜';
        lines.push(`${e} Step ${h.step}: P=${h.p_hall} limit=${h.p_limit} C_ψ_eff=${h.c_psi_effective} w=${h.weight} ${h.audit_result ?? ''}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'vortex_commit',
  'Finalize the current task. FAILS if VORTEX lock (UNVERIFIED_MUTATION) is active. Call this only after verification is proven via pe_step.',
  {
    summary: z.string().describe('Summary of the completed task and verification run'),
  },
  async ({ summary }) => {
    if (peEngine.vortex_locked) {
      return {
        content: [{ type: 'text', text: '❌ SYSTEM LOCK ENGAGED (UNVERIFIED_MUTATION): You MUST run a verification command and supply verification_exit_code: 0 to pe_step before this task can be committed. Stop predicting closure and TEST YOUR CODE.' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `✅ VORTEX COMMIT SUCCESS. System state is STABLE. Task finalized: ${summary}` }]
    };
  }
);

// ── VORTEX Protocol: Active Defense Layer (Case B + C) ─────────────────────
// Case B: fs.watch — automatic mutation detection (escape-proof)
// Case C: Interceptor tools — SYSTEM LOCK response payload (trajectory forcing)

server.tool(
  'vortex_arm',
  'VORTEX PROTOCOL (Case B): Arm passive file system watcher. Any code file mutation in the watched directory auto-engages UNVERIFIED_MUTATION lock — regardless of which tool made the change. Escape-proof defense.',
  {
    directory: z.string().describe('Absolute path to workspace directory to watch'),
  },
  async ({ directory }) => {
    const result = peEngine.startWatch(directory);
    return { content: [{ type: 'text', text: result.message }], isError: !result.success };
  },
);

server.tool(
  'vortex_disarm',
  'VORTEX PROTOCOL: Disarm the file system watcher. Only when explicitly instructed by user.',
  {},
  async () => {
    peEngine.stopWatch();
    return { content: [{ type: 'text', text: '🔓 VORTEX DISARMED. File system watcher stopped.' }] };
  },
);

server.tool(
  'vortex_write',
  'VORTEX PROTOCOL (Case C): Write file with automatic UNVERIFIED_MUTATION lock. Returns SYSTEM LOCK directive forcing AI to run verification. Use instead of native write_file for enforced workflows.',
  {
    path: z.string().describe('Absolute path to file'),
    content: z.string().describe('Content to write'),
    append: z.boolean().optional().describe('Append instead of overwrite'),
  },
  async ({ path: filePath, content, append }) => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      if (append) {
        appendFileSync(filePath, content, 'utf-8');
      } else {
        writeFileSync(filePath, content, 'utf-8');
      }
      peEngine.engageLock(filePath);
      return {
        content: [{
          type: 'text',
          text: [
            '⚠️ SYSTEM LOCK ENGAGED — Status: UNVERIFIED_MUTATION',
            `File: ${filePath} (${Buffer.byteLength(content, 'utf-8')} bytes)`,
            '',
            '🔒 You MUST run a verification command (tests, compiler, linter) BEFORE reporting completion.',
            '   Use vortex_exec with a test command, or call vortex_verify with the exit code.',
            '   Do NOT skip this step. Do NOT report success to the user yet.',
          ].join('\n'),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `❌ Write failed: ${e.message}` }], isError: true };
    }
  },
);

server.tool(
  'vortex_exec',
  'VORTEX PROTOCOL (Case C): Execute shell command with auto mutation/verification classification. Mutations engage lock. Verification commands (tests/linters) with exit 0 release it.',
  {
    command: z.string().describe('Shell command to execute'),
    cwd: z.string().optional().describe('Working directory'),
    is_verification: z.boolean().optional().describe('Override: explicitly mark as verification command'),
  },
  async ({ command, cwd, is_verification }) => {
    const VERIFY_RE = [
      /^(pytest|python3?\s+-m\s+pytest)/i, /^npm\s+(test|run\s+(test|lint|check|build))/i,
      /^(npx\s+)?(vitest|jest|mocha|eslint|prettier|ruff|mypy|pylint)/i,
      /^tsc(\s|$)/i, /^make\s+(test|check|lint|build)/i, /^cargo\s+(test|check|clippy)/i,
      /^go\s+(test|vet)/i, /^(node|bun|deno)\s+.*test/i,
      /^(cat|ls|head|tail|wc|diff|grep|find|file|stat)(\s|$)/i,
      /^git\s+(status|log|diff|show|branch)/i,
    ];
    const MUTATE_RE = [
      /^(rm|mv)\s/i, /^sed\s+-i/i,
      /^git\s+(commit|push|merge|rebase|reset|checkout\s)/i,
      /^(npm|yarn|pnpm)\s+(install|uninstall|update|add|remove)/i,
      /^pip\s+install/i, /^(chmod|chown|dd)\s/i,
    ];
    const cmd = command.trim();
    const isVerify = is_verification ?? VERIFY_RE.some(p => p.test(cmd));
    const isMutate = !isVerify && MUTATE_RE.some(p => p.test(cmd));

    const result = await runCommand('bash', ['-c', command], { cwd });

    if (isMutate) {
      peEngine.engageLock(`cmd: ${cmd.substring(0, 100)}`);
    }

    if (isVerify && peEngine.vortex_locked) {
      if (result.success) {
        const unlock = peEngine.releaseLock(`${cmd.substring(0, 80)} → exit 0`);
        return {
          content: [{
            type: 'text',
            text: [unlock.message, '', '--- Output ---', result.stdout.substring(0, 8000),
              result.stderr ? `--- Stderr ---\n${result.stderr.substring(0, 2000)}` : ''].filter(Boolean).join('\n'),
          }],
        };
      } else {
        return {
          content: [{
            type: 'text',
            text: [`❌ VERIFICATION FAILED. VORTEX lock remains ENGAGED.`, 'Fix issues and re-run.',
              '', '--- Output ---', result.stdout.substring(0, 8000),
              result.stderr ? `--- Stderr ---\n${result.stderr.substring(0, 2000)}` : ''].filter(Boolean).join('\n'),
          }],
          isError: true,
        };
      }
    }

    const reminder = peEngine.vortex_locked
      ? '\n⚠️ REMINDER: VORTEX lock is ENGAGED. Run verification before completing.'
      : '';
    return {
      content: [{
        type: 'text',
        text: [
          result.success ? '✅ Command completed' : '❌ Command failed',
          isMutate ? '🔒 SYSTEM LOCK ENGAGED (mutation detected)' : '',
          reminder,
          '', '--- Output ---', result.stdout.substring(0, 8000),
          result.stderr ? `--- Stderr ---\n${result.stderr.substring(0, 2000)}` : '',
        ].filter(Boolean).join('\n'),
      }],
    };
  },
);

server.tool(
  'vortex_verify',
  'VORTEX PROTOCOL: Submit verification evidence to release UNVERIFIED_MUTATION lock. Requires exit code 0.',
  {
    command: z.string().describe('Verification command that was run'),
    exit_code: z.number().describe('Exit code (must be 0 to unlock)'),
    output_summary: z.string().optional().describe('Brief summary of results'),
  },
  async ({ command, exit_code, output_summary }) => {
    if (!peEngine.vortex_locked) {
      return { content: [{ type: 'text', text: '✅ No lock active. System is STABLE.' }] };
    }
    if (exit_code !== 0) {
      return {
        content: [{ type: 'text', text: `❌ Verification FAILED (exit: ${exit_code}). Lock remains ENGAGED.` }],
        isError: true,
      };
    }
    const unlock = peEngine.releaseLock(`${command} → exit 0${output_summary ? ` (${output_summary})` : ''}`);
    return { content: [{ type: 'text', text: unlock.message }] };
  },
);

// ── Dual Umpire Audit ───────────────────────────────────────────────────────

server.tool(
  'dual_umpire_audit',
  'Run parallel cross-vendor code audit using DeepSeek VORTEX Critic + Copilot CLI. Returns independent verdicts from both umpires for the Perfect Balance external verification layer.',
  {
    code: z.string().describe('Code diff or code snippet to audit'),
    context: z.string().optional().describe('Optional context about what the code should do'),
    verdict_only: z.boolean().optional().describe('If true, return only PASS/FAIL verdicts (default: false)'),
    workspace_root: z.string().optional().describe('Workspace root for VORTEX evidence collection (git diff, test artifacts)'),
    test_exit_code: z.number().optional().describe('Exit code from test run, if available'),
    lint_exit_code: z.number().optional().describe('Exit code from lint run, if available'),
    scope_files: z.array(z.string()).optional().describe('List of files in intended scope for scope violation detection'),
    copilot_model: z.string().optional().describe('Copilot CLI model to use (default: gpt-5-mini). Examples: gpt-5.2, claude-sonnet-4, gemini-3-flash'),
    copilot_flags: z.string().optional().describe('Extra flags to pass to copilot CLI (e.g. "--yolo --no-custom-instructions")'),
    vortex_preset: z.string().optional().describe('PCC preset for VORTEX critic: 渦(default), 監, 刃, 探, 極, 均'),
  },
  async ({ code, context, verdict_only, workspace_root, test_exit_code, lint_exit_code, scope_files, copilot_model, copilot_flags, vortex_preset }) => {
    const startTime = Date.now();

    // Resolve configurable models
    const umpire2Model = copilot_model ?? 'gpt-5-mini';
    const extraFlags = copilot_flags ? ` ${copilot_flags}` : '';

    // Build VORTEX critic input (hook format: stdin JSON)
    const vortexInput = JSON.stringify({
      prompt: [
        context ? `Context: ${context}` : '',
        'Code to audit:',
        '```',
        code,
        '```',
        verdict_only
          ? 'Respond with VERDICT: VERIFIED or VERDICT: UNVERIFIED. Nothing else.'
          : 'Give evidence-based audit. End with VERDICT: VERIFIED or VERDICT: UNVERIFIED.',
      ].filter(Boolean).join('\n'),
      workspaceRoot: workspace_root ?? '',
      preset: vortex_preset ?? '渦',
      ...(test_exit_code !== undefined ? { test_exit_code } : {}),
      ...(lint_exit_code !== undefined ? { lint_exit_code } : {}),
      ...(scope_files ? { scope_files } : {}),
    });

    // Build GPT-5 mini audit prompt (traditional text format)
    const copilotPrompt = [
      'You are a code auditor. Review the following code for bugs, logic errors, security issues, and correctness.',
      context ? `Context: ${context}` : '',
      'Code:',
      '```',
      code,
      '```',
      verdict_only
        ? 'Respond with exactly one word: PASS or FAIL. Nothing else.'
        : 'Give a one-paragraph verdict: is this code correct? List any issues found. End with VERDICT: PASS or VERDICT: FAIL.',
    ].filter(Boolean).join('\n');

    // Write files for safe shell transport
    const fs = await import('fs');
    const tmpDir = '/tmp';
    const ts = Date.now();
    const vortexInputFile = `${tmpDir}/umpire_vortex_${ts}.json`;
    const copilotPromptFile = `${tmpDir}/umpire_copilot_${ts}.txt`;
    fs.writeFileSync(vortexInputFile, vortexInput, 'utf-8');
    fs.writeFileSync(copilotPromptFile, copilotPrompt, 'utf-8');

    // Resolve vortex-critic.py path
    const criticScript = `${process.env.HOME}/neural-override-proxy/critic/vortex-critic.py`;

    // Fire both umpires in parallel
    const [vortexResult, copilotResult] = await Promise.all([
      // Umpire 1: DeepSeek VORTEX Critic — hook format (stdin JSON → stdout JSON)
      runCommand('bash', ['-c', `cat "${vortexInputFile}" | python3 "${criticScript}" 2>/dev/null`], { cwd: tmpDir }),

      // Umpire 2: Copilot CLI — non-interactive with -p -s flags (ACP-style one-shot)
      runCommand('bash', ['-c', `copilot --model ${umpire2Model} -s --no-custom-instructions --no-auto-update -p "$(cat '${copilotPromptFile}')"${extraFlags} 2>/dev/null || true`], { cwd: tmpDir }),
    ]);

    // Cleanup temp files
    try { fs.unlinkSync(vortexInputFile); } catch {}
    try { fs.unlinkSync(copilotPromptFile); } catch {}

    const elapsed = Date.now() - startTime;

    // Parse VORTEX verdict (hook format: extract additionalContext from JSON stdout)
    let vortexText = '';
    try {
      const parsed = JSON.parse(vortexResult.stdout);
      vortexText = parsed?.hookSpecificOutput?.additionalContext ?? vortexResult.stdout;
    } catch {
      vortexText = vortexResult.stdout;
    }

    // Parse verdicts
    const parseVerdict = (output: string): 'PASS' | 'FAIL' | 'UNKNOWN' => {
      const upper = output.toUpperCase();
      if (upper.includes('VERDICT: VERIFIED') || upper.includes('VERDICT: PASS') || upper.trim() === 'PASS') return 'PASS';
      if (upper.includes('VERDICT: UNVERIFIED') || upper.includes('VERDICT: FAIL') || upper.trim() === 'FAIL') return 'FAIL';
      return 'UNKNOWN';
    };

    const vortexVerdict = parseVerdict(vortexText);
    const copilotVerdict = parseVerdict(copilotResult.stdout);

    // Consensus logic: both must PASS for overall PASS
    const consensus =
      vortexVerdict === 'PASS' && copilotVerdict === 'PASS' ? 'PASS' :
      vortexVerdict === 'FAIL' || copilotVerdict === 'FAIL' ? 'FAIL' :
      'REVIEW_NEEDED';

    const lines = [
      '# 🏛️ Dual Umpire Audit Result',
      '',
      `| Umpire | Model | Verdict | Status |`,
      `|--------|-------|---------|--------|`,
      `| VORTEX | DeepSeek (PCC #${vortex_preset ?? '渦'}) | **${vortexVerdict}** | ${vortexResult.success ? '✅' : '❌ Error'} |`,
      `| Copilot | ${umpire2Model} | **${copilotVerdict}** | ${copilotResult.success ? '✅' : '❌ Error'} |`,
      '',
      `**Consensus: ${consensus}** (${(elapsed / 1000).toFixed(1)}s parallel)`,
      '',
    ];

    if (!verdict_only) {
      lines.push(
        '---',
        '### 🌀 VORTEX Critic Analysis (DeepSeek)',
        vortexResult.success ? vortexText.trim() : `Error: ${vortexResult.stderr}`,
        '',
        '### Copilot GPT-5 mini Analysis',
        copilotResult.success ? copilotResult.stdout.trim() : `Error: ${copilotResult.stderr}`,
      );
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 Fusion Orchestrator v2 MCP Server running on stdio');
  console.error(`   Farm ports: ${QWEN_FARM_PORTS.join(', ')} | Coder ports: ${QWEN_CODER_PORTS.join(', ')} | Coder model: ${QWEN_CODER_MODEL}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
