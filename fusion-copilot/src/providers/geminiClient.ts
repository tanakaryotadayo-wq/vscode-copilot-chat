/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — Gemini Client
 *  Streaming API integration with @google/genai SDK
 *  
 *  Ported from antigravity-gemini-chat with modifications for Fusion Copilot routing.
 *--------------------------------------------------------------------------------------------*/

import { GoogleGenAI, type GenerateContentParameters, type Content, type Tool } from '@google/genai';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
	toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	toolResults?: Array<{ callId: string; content: string }>;
}

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
	};
}

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
 * Convert ChatMessages to Gemini Content format.
 */
function convertToGeminiMessages(messages: ChatMessage[]): { contents: Content[]; systemInstruction?: string } {
	let systemInstruction: string | undefined;
	const contents: Content[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			systemInstruction = (systemInstruction ? systemInstruction + '\n\n' : '') + msg.content;
			continue;
		}

		contents.push({
			role: msg.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: msg.content }],
		});
	}

	return { contents, systemInstruction };
}

/**
 * Gemini API client with streaming support.
 */
export class GeminiClient {
	private _client: GoogleGenAI | undefined;

	constructor(private _apiKey: string) {
		if (_apiKey) {
			this._client = new GoogleGenAI({ apiKey: _apiKey });
		}
	}

	get isConfigured(): boolean {
		return !!this._apiKey && !!this._client;
	}

	setApiKey(apiKey: string): void {
		this._apiKey = apiKey;
		this._client = new GoogleGenAI({ apiKey });
	}

	/**
	 * Stream a chat completion from Gemini.
	 */
	async *streamChat(options: GeminiRequestOptions): AsyncGenerator<GeminiStreamChunk> {
		if (!this._client) {
			throw new Error('Gemini client not configured.');
		}

		const { contents, systemInstruction: extractedSys } = convertToGeminiMessages(options.messages);

		const finalSystemInstruction = [
			options.systemInstruction,
			extractedSys,
		].filter(Boolean).join('\n\n') || undefined;

		const params: GenerateContentParameters = {
			model: options.model,
			contents,
			config: {
				systemInstruction: finalSystemInstruction,
				tools: options.tools?.length ? options.tools : undefined,
				maxOutputTokens: options.maxOutputTokens ?? 65536,
				thinkingConfig: options.enableThinking ? { includeThoughts: true } : undefined,
				abortSignal: options.abortSignal,
			},
		};

		const stream = await this._client.models.generateContentStream(params);

		for await (const chunk of stream) {
			if (chunk.candidates?.length) {
				const candidate = chunk.candidates[0];
				if (candidate.content?.parts) {
					for (const part of candidate.content.parts) {
						if ('thought' in part && part.thought === true && part.text) {
							yield { type: 'thinking', text: part.text };
						} else if (part.text) {
							yield { type: 'text', text: part.text };
						} else if (part.functionCall?.name) {
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

			if (chunk.usageMetadata) {
				yield {
					type: 'usage',
					usage: {
						promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
						completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
						thinkingTokens: chunk.usageMetadata.thoughtsTokenCount ?? 0,
						totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
					},
				};
			}
		}
	}

	/**
	 * Non-streaming chat — returns full response.
	 */
	async chat(options: GeminiRequestOptions): Promise<{ text: string; thinking: string }> {
		let text = '';
		let thinking = '';

		for await (const chunk of this.streamChat(options)) {
			if (chunk.type === 'text') { text += chunk.text ?? ''; }
			if (chunk.type === 'thinking') { thinking += chunk.text ?? ''; }
		}

		return { text, thinking };
	}

	/**
	 * Quick health check — try listing models.
	 */
	async healthCheck(): Promise<boolean> {
		if (!this._client) { return false; }
		try {
			const response = await this._client.models.list();
			for await (const _model of response) {
				return true; // At least one model exists
			}
			return true;
		} catch {
			return false;
		}
	}
}
