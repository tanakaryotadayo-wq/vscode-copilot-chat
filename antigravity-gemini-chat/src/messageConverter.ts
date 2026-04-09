/*---------------------------------------------------------------------------------------------
 *  Antigravity Gemini Chat Extension
 *  Gemini-powered AI chat for Antigravity IDE
 *  
 *  Core message converter — translates VS Code Chat messages to Gemini API format.
 *  Derived from vscode-copilot-chat/src/extension/byok/common/geminiMessageConverter.ts
 *--------------------------------------------------------------------------------------------*/

import type { Content, FunctionCall, Part } from '@google/genai';

/**
 * Represents a chat message in the internal format before conversion to Gemini.
 */
export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	}>;
	toolResults?: Array<{
		callId: string;
		content: string;
	}>;
}

/**
 * Result of converting messages to Gemini format.
 */
export interface GeminiConvertedMessages {
	contents: Content[];
	systemInstruction?: string;
}

/**
 * Convert an array of ChatMessages to Gemini API format.
 * Extracts system messages as systemInstruction and maps user/assistant to Gemini roles.
 */
export function convertToGeminiMessages(messages: ChatMessage[]): GeminiConvertedMessages {
	const systemParts: string[] = [];
	const contents: Content[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			systemParts.push(msg.content);
			continue;
		}

		const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
		const parts: Part[] = [];

		// Text content
		if (msg.content) {
			parts.push({ text: msg.content });
		}

		// Tool calls (from model)
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				const fc: FunctionCall = {
					name: tc.name,
					args: tc.arguments as Record<string, unknown>,
				};
				parts.push({ functionCall: fc });
			}
		}

		// Tool results (from user providing results back)
		if (msg.toolResults) {
			for (const tr of msg.toolResults) {
				parts.push({
					functionResponse: {
						name: tr.callId,
						response: { result: tr.content },
					},
				});
			}
		}

		if (parts.length > 0) {
			// Merge consecutive messages with the same role
			const lastContent = contents[contents.length - 1];
			if (lastContent && lastContent.role === geminiRole) {
				lastContent.parts!.push(...parts);
			} else {
				contents.push({ role: geminiRole, parts });
			}
		}
	}

	return {
		contents,
		systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
	};
}

/**
 * Create a simple user message Content from text.
 */
export function createUserContent(text: string): Content {
	return {
		role: 'user',
		parts: [{ text }],
	};
}

/**
 * Create a system instruction string from multiple parts.
 */
export function buildSystemInstruction(parts: string[]): string {
	return parts.filter(Boolean).join('\n\n');
}
