import * as vscode from 'vscode';
import type { McpBridge } from '../tools/mcpBridge.js';

export interface InlineContext {
	prefix: string;
	suffix: string;
	crossFileContext: string;
	fimPrompt: string;
}

export class ContextBuilder {
	static async build(document: vscode.TextDocument, position: vscode.Position, mcp: McpBridge): Promise<InlineContext> {
		const prefix = document.getText(new vscode.Range(Math.max(0, position.line - 150), 0, position.line, position.character));
		const endLine = Math.min(document.lineCount - 1, position.line + 50);
		const suffix = document.getText(new vscode.Range(position.line, position.character, endLine, document.lineAt(endLine).text.length));
		
		let crossFileContext = '';
		const query = prefix.split('\n').slice(-5).join('\n').trim();
		if (query.length > 10 && mcp.isRunning) {
			const res = await mcp.callTool('memory_search', { query, limit: 2 });
			if (res.success && res.content) {
				crossFileContext = `/* Semantic Context:\n${res.content}\n*/\n`;
			}
		}
		const fimPrompt = `<|fim_prefix|>${crossFileContext}${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
		return { prefix, suffix, crossFileContext, fimPrompt };
	}
}
