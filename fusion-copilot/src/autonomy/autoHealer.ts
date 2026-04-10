import * as vscode from 'vscode';
import type { LocalAiClient } from '../providers/localAiClient.js';
import type { Orchestrator } from '../orchestrator/agentOrchestrator.js';

const LOG_PREFIX = '[AutoHealer]';

export class AutoHealer {
	private isHealing = false;
	private readonly output: vscode.OutputChannel;

	constructor(private coder: LocalAiClient, private orchestrator: Orchestrator) {
		this.output = vscode.window.createOutputChannel('Fusion AutoHealer');
	}

	public activate(context: vscode.ExtensionContext) {
		context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(e => this.handleDiagnostics(e)));
		this.output.appendLine(`${LOG_PREFIX} Activated — watching for LSP errors.`);
	}

	private async handleDiagnostics(e: vscode.DiagnosticChangeEvent) {
		if (this.isHealing) return;
		for (const uri of e.uris) {
			const diags = vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
			if (diags.length > 0) {
				this.isHealing = true;
				try {
					await this.processErrors(uri, diags);
				} finally {
					this.isHealing = false;
				}
				break;
			}
		}
	}

	private async processErrors(uri: vscode.Uri, diags: vscode.Diagnostic[]) {
		const doc = await vscode.workspace.openTextDocument(uri);
		const totalLines = doc.lineCount;

		// Determine the affected line range (union of all error ranges ± context)
		const CONTEXT_LINES = 5;
		let minLine = totalLines;
		let maxLine = 0;
		for (const d of diags) {
			minLine = Math.min(minLine, d.range.start.line);
			maxLine = Math.max(maxLine, d.range.end.line);
		}
		const rangeStart = Math.max(0, minLine - CONTEXT_LINES);
		const rangeEnd = Math.min(totalLines - 1, maxLine + CONTEXT_LINES);

		const snippet = doc.getText(new vscode.Range(rangeStart, 0, rangeEnd, doc.lineAt(rangeEnd).text.length));
		const errorText = diags.map(d => `Line ${d.range.start.line + 1}: ${d.message}`).join('\n');

		this.output.appendLine(`${LOG_PREFIX} ${diags.length} error(s) in ${uri.fsPath} (lines ${rangeStart + 1}-${rangeEnd + 1})`);

		const prompt = `Fix ONLY the compilation errors in these lines. Return ONLY the corrected code lines, no markdown fences, no explanations.\nErrors:\n${errorText}\nCode (lines ${rangeStart + 1}-${rangeEnd + 1}):\n${snippet}`;

		try {
			const result = await this.coder.ask(prompt);
			// Strip markdown fences if the model ignores the instruction
			const match = result.match(/```[a-z]*\n([\s\S]*?)```/);
			const replacement = (match ? match[1] : result).trim();

			// Sanity checks before applying
			const originalLineCount = rangeEnd - rangeStart + 1;
			const replacementLineCount = replacement.split('\n').length;
			const sizeDelta = Math.abs(replacementLineCount - originalLineCount);

			if (replacement.length < 10) {
				this.output.appendLine(`${LOG_PREFIX} SKIP — AI returned too-short response (${replacement.length} chars)`);
				return;
			}
			if (replacement.includes('I cannot') || replacement.includes('I\'m sorry')) {
				this.output.appendLine(`${LOG_PREFIX} SKIP — AI refused to fix`);
				return;
			}
			if (sizeDelta > originalLineCount * 0.5 && originalLineCount > 10) {
				this.output.appendLine(`${LOG_PREFIX} SKIP — line count changed too much (${originalLineCount} → ${replacementLineCount}), likely truncated`);
				return;
			}

			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(rangeStart, 0, rangeEnd, doc.lineAt(rangeEnd).text.length), replacement);
			await vscode.workspace.applyEdit(edit);
			await doc.save();
			this.output.appendLine(`${LOG_PREFIX} Applied fix to lines ${rangeStart + 1}-${rangeEnd + 1}`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`${LOG_PREFIX} ERROR — local AI fix failed: ${msg}`);
			try {
				await this.orchestrator.jules.submitTask(`Auto-Heal failed for ${uri.fsPath}:\n${errorText}`);
				this.output.appendLine(`${LOG_PREFIX} Escalated to Jules`);
			} catch (julesErr: unknown) {
				const julesMsg = julesErr instanceof Error ? julesErr.message : String(julesErr);
				this.output.appendLine(`${LOG_PREFIX} Jules escalation also failed: ${julesMsg}`);
			}
		}
	}
}

