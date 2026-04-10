import * as vscode from 'vscode';
import { ContextBuilder } from '../context/contextBuilder.js';
import type { QwenFarm } from '../providers/qwenFarm.js';
import type { McpBridge } from '../tools/mcpBridge.js';

export function createInlineHandler(qwenFarm: QwenFarm, mcpBridge: McpBridge) {
	return async function handleInlineCompletion(
		document: vscode.TextDocument, position: vscode.Position,
		_context: vscode.InlineCompletionContext, token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[]> {
		if (token.isCancellationRequested) return [];
		await new Promise(resolve => setTimeout(resolve, 150));
		if (token.isCancellationRequested) return [];

		const inlineCtx = await ContextBuilder.build(document, position, mcpBridge);
		const abortController = new AbortController();
		const cancelSub = token.onCancellationRequested(() => abortController.abort());
		
		try {
			let fullText = '';
			for await (const chunk of qwenFarm.streamRawComplete({
				prompt: inlineCtx.fimPrompt, maxTokens: 64, stop: ['\n\n', '<|file_separator|>'], abortSignal: abortController.signal
			})) {
				fullText += chunk.text;
				if (fullText.includes('\n\n')) { fullText = fullText.split('\n\n')[0]; break; }
			}
			if (!fullText.trim()) return [];
			return [new vscode.InlineCompletionItem(fullText.trimEnd(), new vscode.Range(position, position))];
		} catch { return []; } finally { cancelSub.dispose(); }
	};
}
