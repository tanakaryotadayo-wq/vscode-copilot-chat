/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — Local AI Client
 *  OpenAI-compatible API client for MLX inference servers (Qwen, etc.)
 *  
 *  Connects to local MLX servers running OpenAI-compatible endpoints.
 *  Supports streaming, non-streaming, health checks, and abort signals.
 *--------------------------------------------------------------------------------------------*/

export interface LocalAiRequestOptions {
	model?: string;
	messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
	maxTokens?: number;
	temperature?: number;
	stop?: string[];
	stream?: boolean;
	abortSignal?: AbortSignal;
}

export interface LocalAiStreamChunk {
	text: string;
	finishReason?: string;
}

export interface LocalAiResponse {
	text: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	finishReason?: string;
	latencyMs: number;
}

export interface LocalAiHealthStatus {
	online: boolean;
	model?: string;
	latencyMs: number;
	error?: string;
}

/**
 * Client for OpenAI-compatible local AI servers (MLX, vLLM, llama.cpp, etc.)
 */
export class LocalAiClient {
	constructor(
		private readonly baseUrl: string,
		private readonly defaultModel: string = 'default',
	) {}

	get url(): string {
		return this.baseUrl;
	}

	/**
	 * Check if the server is reachable and responsive.
	 */
	async healthCheck(): Promise<LocalAiHealthStatus> {
		const start = Date.now();
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 3000);

			const res = await fetch(`${this.baseUrl}/v1/models`, {
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (!res.ok) {
				return { online: false, latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
			}

			const data = await res.json() as { data?: Array<{ id: string }> };
			const model = data?.data?.[0]?.id;

			return { online: true, model, latencyMs: Date.now() - start };
		} catch (err) {
			return {
				online: false,
				latencyMs: Date.now() - start,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Generate a non-streaming completion.
	 */
	async complete(options: LocalAiRequestOptions): Promise<LocalAiResponse> {
		const start = Date.now();

		const body = {
			model: options.model ?? this.defaultModel,
			messages: options.messages,
			max_tokens: options.maxTokens ?? 2048,
			temperature: options.temperature ?? 0.3,
			stop: options.stop,
			stream: false,
		};

		const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: options.abortSignal,
		});

		if (!res.ok) {
			const errorText = await res.text().catch(() => 'Unknown error');
			throw new Error(`Local AI error ${res.status}: ${errorText}`);
		}

		const data = await res.json() as {
			choices: Array<{ message: { content: string }; finish_reason: string }>;
			usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
		};

		const choice = data.choices?.[0];

		return {
			text: choice?.message?.content ?? '',
			usage: data.usage ? {
				promptTokens: data.usage.prompt_tokens,
				completionTokens: data.usage.completion_tokens,
				totalTokens: data.usage.total_tokens,
			} : undefined,
			finishReason: choice?.finish_reason,
			latencyMs: Date.now() - start,
		};
	}

	/**
	 * Generate a streaming completion. Yields text chunks as they arrive.
	 */
	async *streamComplete(options: LocalAiRequestOptions): AsyncGenerator<LocalAiStreamChunk> {
		const body = {
			model: options.model ?? this.defaultModel,
			messages: options.messages,
			max_tokens: options.maxTokens ?? 2048,
			temperature: options.temperature ?? 0.3,
			stop: options.stop,
			stream: true,
		};

		const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: options.abortSignal,
		});

		if (!res.ok) {
			const errorText = await res.text().catch(() => 'Unknown error');
			throw new Error(`Local AI stream error ${res.status}: ${errorText}`);
		}

		if (!res.body) {
			throw new Error('No response body for streaming');
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) { continue; }

					const data = trimmed.slice(6);
					if (data === '[DONE]') { return; }

					try {
						const parsed = JSON.parse(data) as {
							choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
						};
						const delta = parsed.choices?.[0]?.delta;
						if (delta?.content) {
							yield {
								text: delta.content,
								finishReason: parsed.choices[0].finish_reason ?? undefined,
							};
						}
					} catch {
						// Skip malformed SSE lines
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Quick single-prompt completion (convenience wrapper).
	 */
	async ask(prompt: string, systemPrompt?: string): Promise<string> {
		const messages: LocalAiRequestOptions['messages'] = [];
		if (systemPrompt) {
			messages.push({ role: 'system', content: systemPrompt });
		}
		messages.push({ role: 'user', content: prompt });

		const result = await this.complete({ messages });
		return result.text;
	}

	/**
	 * Generate a streaming raw completion (FIM / Ghost Text).
	 */
	async *streamRawComplete(options: { model?: string; prompt: string; maxTokens?: number; stop?: string[]; abortSignal?: AbortSignal }): AsyncGenerator<LocalAiStreamChunk> {
		const body = {
			model: options.model ?? this.defaultModel,
			prompt: options.prompt,
			max_tokens: options.maxTokens ?? 128,
			temperature: 0.1,
			stop: options.stop ?? ['\n\n', '<|file_separator|>'],
			stream: true,
		};

		const res = await fetch(`${this.baseUrl}/v1/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: options.abortSignal,
		});

		if (!res.ok) {
			const errorText = await res.text().catch(() => 'Unknown error');
			throw new Error(`Local AI raw stream error ${res.status}: ${errorText}`);
		}

		if (!res.body) {
			throw new Error('No response body for streaming');
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) { continue; }

					const data = trimmed.slice(6);
					if (data === '[DONE]') { return; }

					try {
						const parsed = JSON.parse(data) as {
							choices: Array<{ text?: string; finish_reason?: string }>;
						};
						const choice = parsed.choices?.[0];
						if (choice?.text) {
							yield { // Yielding text delta instead of full array
								text: choice.text,
								finishReason: choice.finish_reason ?? undefined,
							};
						}
					} catch {
						// Skip malformed SSE lines
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}
