#!/usr/bin/env node

/**
 * Fusion Orchestrator v2 MCP Server
 * ====================================
 * Full AI orchestration toolkit: Jules, Gemini CLI, Qwen Farm, Qwen Coder, n8n
 *
 * Tools:
 *   jules_new / jules_list          — Async coding agent
 *   jules_parallel                  — Parallel Jules sessions for same task
 *   jules_repos                     — List registered Jules repos
 *   jules_pull                      — Pull session result for review
 *   jules_apply                     — Pull + apply session result locally
 *   jules_teleport                  — Teleport into a Jules session
 *   gemini_deepthink / deepsearch   — Gemini CLI analysis
 *   qwen_health                     — Farm health check
 *   qwen_chat                       — Chat with Qwen 3.5-9B (fast, local)
 *   qwen_code                       — Code with Qwen3 Coder (Sonnet 4.5 level)
 *   qwen_batch                      — Parallel multi-prompt across farm
 *   n8n_trigger                     — Workflow engine
 *   orchestrate                     — Full pipeline
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { existsSync } from 'fs';

// ── Config ──────────────────────────────────────────────────────────────────

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? 'http://localhost:5678/webhook/jules-start';
const QWEN_FARM_PORTS = (process.env.QWEN_PORTS ?? '8010,8011,8012,8013,8014').split(',').map(Number);
const QWEN_CODER_PORT = Number(process.env.QWEN_CODER_PORT ?? '8020');
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

function resolveRepoContext(repo?: string): { repoValue: string; cwd?: string; ghRepo?: string } {
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
        model: options.model ?? 'default',
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

  results.push('\n## Qwen Coder (Qwen3 Coder 80B)');
  try {
    const res = await fetch(`http://${QWEN_HOST}:${QWEN_CODER_PORT}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json() as any;
      results.push(`✅ :${QWEN_CODER_PORT} — ${data?.data?.[0]?.id ?? 'unknown'}`);
    } else {
      results.push(`❌ :${QWEN_CODER_PORT} — HTTP ${res.status}`);
    }
  } catch (e: any) {
    results.push(`❌ :${QWEN_CODER_PORT} — ${e.message}`);
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

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'fusion-orchestrator-v2', version: '2.0.0' },
);

// ═══════════════════════════════════════════════════════════════════════════
// QWEN TOOLS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'qwen_health',
  'Check health of the entire Qwen inference fleet (farm 8010-8014 + coder 8020)',
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

    const result = await qwenChat(port, messages, { temperature });
    return {
      content: [{ type: 'text', text: result.success
        ? `[Qwen 3.5 :${port}]\n${result.text}`
        : `❌ :${port} — ${result.text}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'qwen_code',
  'Send a coding task to Qwen3 Coder 80B (Sonnet 4.5 level). Best for complex implementations.',
  {
    task: z.string().describe('Coding task description'),
    language: z.string().optional().describe('Target language (e.g. typescript, python)'),
    context: z.string().optional().describe('Existing code or context to work with'),
    max_tokens: z.number().optional().describe('Max output tokens (default: 8192)'),
  },
  async ({ task, language, context, max_tokens }) => {
    const systemPrompt = `You are an expert software engineer. ${language ? `Write ${language} code.` : ''} Output clean, production-ready code. No unnecessary explanations.`;
    const userContent = context ? `${task}\n\n### Context:\n\`\`\`\n${context}\n\`\`\`` : task;

    const result = await qwenChat(QWEN_CODER_PORT, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ], { temperature: 0.3, max_tokens: max_tokens ?? 8192 });

    return {
      content: [{ type: 'text', text: result.success
        ? `[Qwen3 Coder :${QWEN_CODER_PORT}]\n${result.text}`
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
// GEMINI CLI TOOLS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'gemini_deepthink',
  'Run Gemini CLI DEEPTHINK for architecture/design analysis',
  { prompt: z.string() },
  async ({ prompt }) => {
    const result = await runCommand('gemini', ['-p', `DEEPTHINK: ${prompt}`]);
    return {
      content: [{ type: 'text', text: result.success ? result.stdout : `❌ ${result.stderr}` }],
      isError: !result.success,
    };
  },
);

server.tool(
  'gemini_deepsearch',
  'Run Gemini CLI DEEPSEARCH for technical research',
  { query: z.string() },
  async ({ query }) => {
    const result = await runCommand('gemini', ['-p', `DEEPSEARCH: ${query}`]);
    return {
      content: [{ type: 'text', text: result.success ? result.stdout : `❌ ${result.stderr}` }],
      isError: !result.success,
    };
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
      const qResult = await qwenChat(QWEN_CODER_PORT, [
        { role: 'system', content: 'You are a technical project manager. Decompose issues into implementable tasks.' },
        { role: 'user', content: analyzePrompt },
      ], { temperature: 0.3 });
      if (qResult.success) {
        analysisText = qResult.text;
        lines.push('(Analyzed with Qwen3 Coder)');
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 Fusion Orchestrator v2 MCP Server running on stdio');
  console.error(`   Farm ports: ${QWEN_FARM_PORTS.join(', ')} | Coder port: ${QWEN_CODER_PORT}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
