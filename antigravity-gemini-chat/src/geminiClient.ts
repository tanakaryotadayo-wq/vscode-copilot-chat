/*---------------------------------------------------------------------------------------------
 *  Antigravity Gemini Chat Extension
 *  Gemini Client — streaming API integration with @google/genai SDK
 *  
 *  Architecture derived from vscode-copilot-chat's GeminiNativeBYOKLMProvider
 *  but simplified for standalone use without proposed API dependencies.
 *--------------------------------------------------------------------------------------------*/

import { GoogleGenAI, GenerateContentParameters, Content, Tool } from '@google/genai';
import { convertToGeminiMessages, type ChatMessage } from './messageConverter.js';

/**
 * Streamed response chunk from Gemini.
 */
export interface GeminiStreamChunk {
	type: 'text' | 'thinking' | 'tool_call' | 'usage';
	text?: string;
	toolCall?: {
		id: string;
		name: string;
		args: Record<string, unknown>;
	};
	usage?: {
		promptTokens: number;
		completionTokens: number;
		thinkingTokens: number;
		totalTokens: number;
		cachedTokens: number;
	};
}

/**
 * Options for Gemini generation request.
 */
export interface GeminiRequestOptions {
	model: string;
	messages: ChatMessage[];
	systemInstruction?: string;
	tools?: Tool[];
	maxOutputTokens?: number;
	enableThinking?: boolean;
	abortSignal?: AbortSignal;
}

/**
 * Gemini API client with streaming support.
 */
export class GeminiClient {
	private _client: GoogleGenAI | undefined;

	constructor(private _apiKey: string) {
		this._client = new GoogleGenAI({ apiKey: _apiKey });
	}

	/**
	 * Update the API key (e.g., after user reconfiguration).
	 */
	setApiKey(apiKey: string): void {
		this._apiKey = apiKey;
		this._client = new GoogleGenAI({ apiKey });
	}

	get isConfigured(): boolean {
		return !!this._apiKey;
	}

	/**
	 * List available models from the API.
	 */
	async listModels(): Promise<Array<{ id: string; displayName: string }>> {
		if (!this._client) {
			throw new Error('Gemini client not configured. Set API key first.');
		}
		const models: Array<{ id: string; displayName: string }> = [];
		const response = await this._client.models.list();
		for await (const model of response) {
			if (model.name) {
				models.push({
					id: model.name.replace('models/', ''),
					displayName: model.displayName || model.name,
				});
			}
		}
		return models;
	}

	/**
	 * Send a streaming request to Gemini and yield response chunks.
	 * This is the core method derived from copilot-chat's _makeRequest pattern.
	 */
	async *streamChat(options: GeminiRequestOptions): AsyncGenerator<GeminiStreamChunk> {
		if (!this._client) {
			throw new Error('Gemini client not configured. Set API key first.');
		}

		const { contents, systemInstruction: extractedSysInstruction } = convertToGeminiMessages(options.messages);

		// Merge explicit system instruction with extracted ones
		const finalSystemInstruction = [
			options.systemInstruction,
			extractedSysInstruction,
		].filter(Boolean).join('\n\n') || undefined;

		const params: GenerateContentParameters = {
			model: options.model,
			contents,
			config: {
				systemInstruction: finalSystemInstruction,
				tools: options.tools && options.tools.length > 0 ? options.tools : undefined,
				maxOutputTokens: options.maxOutputTokens ?? 65536,
				thinkingConfig: options.enableThinking ? { includeThoughts: true } : undefined,
				abortSignal: options.abortSignal,
			},
		};

		const stream = await this._client.models.generateContentStream(params);

		for await (const chunk of stream) {
			// Process candidates
			if (chunk.candidates && chunk.candidates.length > 0) {
				const candidate = chunk.candidates[0];
				if (candidate.content?.parts) {
					for (const part of candidate.content.parts) {
						// Thinking/reasoning content
						if ('thought' in part && part.thought === true && part.text) {
							yield { type: 'thinking', text: part.text };
						}
						// Regular text content
						else if (part.text) {
							yield { type: 'text', text: part.text };
						}
						// Function/tool call
						else if (part.functionCall?.name) {
							yield {
								type: 'tool_call',
								toolCall: {
									id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
									name: part.functionCall.name,
									args: (part.functionCall.args ?? {}) as Record<string, unknown>,
								},
							};
						}
					}
				}
			}

			// Extract usage metadata
			if (chunk.usageMetadata) {
				yield {
					type: 'usage',
					usage: {
						promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
						completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
						thinkingTokens: chunk.usageMetadata.thoughtsTokenCount ?? 0,
						totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
						cachedTokens: chunk.usageMetadata.cachedContentTokenCount ?? 0,
					},
				};
			}
		}
	}

	/**
	 * Non-streaming request — returns complete response.
	 */
	async chat(options: GeminiRequestOptions): Promise<{
		text: string;
		toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
		thinking: string;
		usage?: GeminiStreamChunk['usage'];
	}> {
		let text = '';
		let thinking = '';
		const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
		let usage: GeminiStreamChunk['usage'] | undefined;

		for await (const chunk of this.streamChat(options)) {
			switch (chunk.type) {
				case 'text':
					text += chunk.text ?? '';
					break;
				case 'thinking':
					thinking += chunk.text ?? '';
					break;
				case 'tool_call':
					if (chunk.toolCall) {
						toolCalls.push(chunk.toolCall);
					}
					break;
				case 'usage':
					usage = chunk.usage;
					break;
			}
		}

		return { text, toolCalls, thinking, usage };
	}
}
