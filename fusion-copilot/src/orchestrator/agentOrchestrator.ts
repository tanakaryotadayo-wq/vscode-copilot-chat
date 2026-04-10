/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — Agent Orchestrator
 *  Bridges Antigravity IDE with Gemini CLI (DEEPTHINK/DEEPSEARCH) and Jules (async tasks).
 *  This is the heart of the Agent Manager — the conductor of the AI orchestra.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';

// ── Types ───────────────────────────────────────────────────────────────────

export interface OrchestratorResult {
	success: boolean;
	output: string;
	error?: string;
}

export interface JulesSession {
	taskDescription: string;
	repo: string;
	status: 'queued' | 'running' | 'done' | 'error';
}

// ── Shell Executor ──────────────────────────────────────────────────────────

function runShell(command: string, cwd?: string): Promise<OrchestratorResult> {
	return new Promise((resolve) => {
		const options: { cwd?: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv } = {
			timeout: 120_000, // 2 minute max
			maxBuffer: 10 * 1024 * 1024, // 10MB
			env: {
				...process.env,
				PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
			},
		};
		if (cwd) { options.cwd = cwd; }

		exec(command, options, (error, stdout, stderr) => {
			if (error) {
				resolve({
					success: false,
					output: stdout.toString(),
					error: `${error.message}\n${stderr.toString()}`,
				});
			} else {
				resolve({
					success: true,
					output: stdout.toString(),
				});
			}
		});
	});
}

// ── Jules Integration ───────────────────────────────────────────────────────

export class JulesAgent {
	private sessions: JulesSession[] = [];

	/**
	 * Submit a task to Jules for async execution.
	 */
	async submitTask(taskDescription: string, repo?: string): Promise<OrchestratorResult> {
		const repoPath = repo ?? this.getWorkspaceRoot() ?? '.';
		const escapedTask = taskDescription.replace(/"/g, '\\"').replace(/\n/g, ' ');

		const result = await runShell(
			`jules new "${escapedTask}" --repo "${repoPath}"`,
			repoPath,
		);

		if (result.success) {
			this.sessions.push({
				taskDescription,
				repo: repoPath,
				status: 'queued',
			});
		}

		return result;
	}

	/**
	 * Submit multiple tasks from a task list (one per line).
	 */
	async submitBatch(taskList: string, repo?: string): Promise<OrchestratorResult[]> {
		const tasks = taskList.split('\n').filter(line => line.trim().length > 0);
		const results: OrchestratorResult[] = [];

		for (const task of tasks) {
			const result = await this.submitTask(task.trim(), repo);
			results.push(result);
		}

		return results;
	}

	getActiveSessions(): JulesSession[] {
		return this.sessions;
	}

	private getWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}
}

// ── Gemini CLI Integration ──────────────────────────────────────────────────

export class GeminiCliAgent {

	/**
	 * Run Gemini CLI with DEEPTHINK mode for heavy design/architecture problems.
	 */
	async deepthink(prompt: string): Promise<OrchestratorResult> {
		const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/`/g, '\\`');
		return runShell(`gemini -p "DEEPTHINK: ${escapedPrompt}"`);
	}

	/**
	 * Run Gemini CLI with DEEPSEARCH mode for technical research.
	 */
	async deepsearch(query: string): Promise<OrchestratorResult> {
		const escapedQuery = query.replace(/"/g, '\\"').replace(/`/g, '\\`');
		return runShell(`gemini -p "DEEPSEARCH: ${escapedQuery}"`);
	}

	/**
	 * Analyze GitHub issues and pick the most impactful one.
	 */
	async analyzeIssues(): Promise<OrchestratorResult> {
		return runShell(
			`gemini -p "Analyze these GitHub issues. Rank by impact and complexity. For each, give a 1-line task description suitable for automated implementation.\n$(gh issue list --assignee @me --limit 10 --json title,body | jq -r '.[] | .title')"`,
		);
	}

	/**
	 * The Ultimate Combo: Analyze issues → pick most tedious → send to Jules.
	 */
	async analyzeAndDelegate(): Promise<OrchestratorResult> {
		return runShell(
			`gemini -p "Find the most tedious issue that would benefit most from automated implementation. Print ONLY the issue title verbatim, nothing else.\n$(gh issue list --assignee @me --limit 10)" | jules remote new --repo .`,
		);
	}
}

// ── Orchestration Pipeline ──────────────────────────────────────────────────

import { N8nBridge } from '../tools/n8nBridge.js';

export class Orchestrator {
	public readonly jules = new JulesAgent();
	public readonly gemini = new GeminiCliAgent();
	private readonly n8n = new N8nBridge();

	constructor(private readonly mcpBridge?: any) {} // Weak type to avoid cyclic import or just inject any

	/**
	 * Full orchestration pipeline:
	 * 1. Gemini analyzes issues
	 * 2. Gemini decomposes into tasks
	 * 3. Each task is submitted to Jules
	 */
	async fullPipeline(stream: vscode.ChatResponseStream): Promise<void> {
		stream.progress('🔍 Step 1: Analyzing GitHub issues with Gemini DEEPTHINK...');

		const analysis = await this.gemini.analyzeIssues();
		if (!analysis.success) {
			stream.markdown(`❌ **Issue analysis failed**: ${analysis.error}\n\n`);
			stream.markdown('> Make sure `gh` (GitHub CLI) and `gemini` (Gemini CLI) are installed and authenticated.\n');
			return;
		}

		stream.markdown(`### 📊 Issue Analysis\n\n${analysis.output}\n\n`);
		stream.progress('🔧 Step 2: Decomposing into Jules tasks...');

		// Extract task lines from Gemini's output
		const tasks = analysis.output
			.split('\n')
			.filter(line => line.trim().length > 5)
			.slice(0, 5); // Max 5 parallel Jules sessions

		if (tasks.length === 0) {
			stream.markdown('⚠️ No actionable tasks found in the analysis.\n');
			return;
		}

		stream.markdown(`### 🚀 Submitting ${tasks.length} tasks to Jules\n\n`);

		for (const task of tasks) {
			const useMcp = vscode.workspace.getConfiguration('fusion.copilot').get<boolean>('n8n.useMcp', false);
			
			if (useMcp && this.mcpBridge) {
				stream.progress(`Submitting to n8n MCP Server: ${task.slice(0, 60)}...`);
				try {
					const mcpResult = await this.mcpBridge.callTool('trigger_n8n_jules_audit', {
						repo: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.',
						task: task
					});
					stream.markdown(`🚀 (Transferred via MCP Server) ${task}\n\n`);
				} catch (err: any) {
					stream.markdown(`❌ (MCP Webhook fail: ${err.message}) ${task}\n\n`);
				}
			} else {
				stream.progress(`Submitting to n8n webhook (Legacy REST): ${task.slice(0, 60)}...`);
				const success = await this.n8n.triggerJulesAuditLoop(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.', task);
				const icon = success ? '🚀 (Transferred to n8n REST)' : '❌ (n8n Webhook fail)';
				stream.markdown(`${icon} ${task}\n\n`);
			}
		}

		stream.markdown(`\n---\n\n🎉 **Orchestration complete!** ${tasks.length} tasks submitted to Jules.\nCheck progress with \`jules list\` or GitHub PRs.\n`);
	}

	/**
	 * Night mode: Queue up overnight work.
	 */
	async nightMode(stream: vscode.ChatResponseStream): Promise<void> {
		stream.markdown('## 🌙 Night Mode Activated\n\n');
		stream.progress('Analyzing issues for overnight development...');

		const analysis = await this.gemini.deepthink(
			'Analyze these GitHub issues and create a prioritized overnight development plan. ' +
			'Output as a numbered list of specific, actionable tasks that can be automated. ' +
			'Focus on tasks that are tedious but well-defined.'
		);

		if (!analysis.success) {
			stream.markdown(`❌ DEEPTHINK analysis failed: ${analysis.error}\n`);
			return;
		}

		stream.markdown(`### 🧠 DEEPTHINK Analysis\n\n${analysis.output}\n\n`);
		stream.markdown('---\n\n');

		const tasks = analysis.output
			.split('\n')
			.filter(line => /^\d+[\.\)]/.test(line.trim()))
			.slice(0, 8);

		if (tasks.length > 0) {
			stream.markdown(`### 🤖 Transferring ${tasks.length} tasks to n8n Workflow Engine\n\n`);
			for (const task of tasks) {
				const useMcp = vscode.workspace.getConfiguration('fusion.copilot').get<boolean>('n8n.useMcp', false);
				let success = false;
				if (useMcp && this.mcpBridge) {
					try {
						await this.mcpBridge.callTool('trigger_n8n_jules_audit', {
							repo: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.',
							task: task
						});
						success = true;
					} catch(e) {}
				} else {
					success = await this.n8n.triggerJulesAuditLoop(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.', task);
				}
				stream.markdown(`${success ? '🚀' : '❌'} ${task}\n\n`);
			}
			stream.markdown('\n🌙 **Go to sleep. Jules is working overnight.**\n');
			stream.markdown('Check `gh pr list` in the morning for ready PRs.\n');
		} else {
			stream.markdown('⚠️ Could not extract actionable tasks. Try running `/orchestrate` manually.\n');
		}
	}
}
