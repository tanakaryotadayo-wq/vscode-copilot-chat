/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — Qwen Farm
 *  Load balancer for multiple Qwen 3.5 9B instances with KV cache
 *  
 *  Distributes requests across N MLX server instances using round-robin.
 *  Each instance pre-loads a shared system prompt into KV cache for instant TTFT.
 *--------------------------------------------------------------------------------------------*/

import { LocalAiClient, type LocalAiHealthStatus, type LocalAiRequestOptions, type LocalAiResponse, type LocalAiStreamChunk } from './localAiClient.js';

export interface FarmStatus {
	totalInstances: number;
	onlineInstances: number;
	instances: Array<{
		port: number;
		online: boolean;
		model?: string;
		latencyMs: number;
		error?: string;
	}>;
}

/**
 * Load balancer over multiple local AI instances.
 * Round-robins requests across healthy instances for maximum throughput.
 */
export class QwenFarm {
	private readonly clients: LocalAiClient[];
	private readonly ports: number[];
	private currentIndex = 0;
	private healthCache: Map<number, { status: LocalAiHealthStatus; checkedAt: number }> = new Map();

	/** Health cache TTL in ms */
	private static readonly HEALTH_CACHE_TTL = 30_000;

	constructor(
		private readonly host: string = 'localhost',
		ports: number[] = [8010, 8011, 8012, 8013, 8014],
		private readonly model: string = 'qwen3.5-9b',
	) {
		this.ports = ports;
		this.clients = ports.map(port =>
			new LocalAiClient(`http://${host}:${port}`, model)
		);
	}

	get instanceCount(): number {
		return this.clients.length;
	}

	/**
	 * Get the next healthy instance using round-robin.
	 * Falls back to any available instance if the primary choice is down.
	 */
	private async getNextClient(): Promise<LocalAiClient | null> {
		const startIdx = this.currentIndex;
		const total = this.clients.length;

		for (let i = 0; i < total; i++) {
			const idx = (startIdx + i) % total;
			const client = this.clients[idx];
			const port = this.ports[idx];

			// Check health cache first
			const cached = this.healthCache.get(port);
			if (cached && Date.now() - cached.checkedAt < QwenFarm.HEALTH_CACHE_TTL) {
				if (cached.status.online) {
					this.currentIndex = (idx + 1) % total;
					return client;
				}
				continue;
			}

			// Cache miss or expired — do a fresh health check
			const health = await client.healthCheck();
			this.healthCache.set(port, { status: health, checkedAt: Date.now() });

			if (health.online) {
				this.currentIndex = (idx + 1) % total;
				return client;
			}
		}

		return null;
	}

	/**
	 * Send a completion request to the next available Qwen instance.
	 */
	async complete(options: LocalAiRequestOptions): Promise<LocalAiResponse> {
		const client = await this.getNextClient();
		if (!client) {
			throw new Error('No Qwen farm instances are online. Run `launch_qwen_farm.sh` to start them.');
		}
		return client.complete({ ...options, model: options.model ?? this.model });
	}

	/**
	 * Stream a completion from the next available Qwen instance.
	 */
	async *streamComplete(options: LocalAiRequestOptions): AsyncGenerator<LocalAiStreamChunk> {
		const client = await this.getNextClient();
		if (!client) {
			throw new Error('No Qwen farm instances are online.');
		}
		yield* client.streamComplete({ ...options, model: options.model ?? this.model });
	}

	/**
	 * Stream a raw FIM string from the next available Qwen instance.
	 */
	async *streamRawComplete(options: { prompt: string; maxTokens?: number; stop?: string[]; abortSignal?: AbortSignal }): AsyncGenerator<LocalAiStreamChunk> {
		const client = await this.getNextClient();
		if (!client) {
			throw new Error('No Qwen farm instances are online.');
		}
		yield* client.streamRawComplete({ ...options, model: this.model });
	}

	/**
	 * Quick ask — single prompt, non-streaming.
	 */
	async ask(prompt: string, systemPrompt?: string): Promise<string> {
		const client = await this.getNextClient();
		if (!client) {
			throw new Error('No Qwen farm instances are online.');
		}
		return client.ask(prompt, systemPrompt);
	}

	/**
	 * Check health of all instances in the farm.
	 */
	async getStatus(): Promise<FarmStatus> {
		const checks = await Promise.all(
			this.clients.map(async (client, i) => {
				const health = await client.healthCheck();
				const port = this.ports[i];
				this.healthCache.set(port, { status: health, checkedAt: Date.now() });
				return { port, ...health };
			})
		);

		return {
			totalInstances: checks.length,
			onlineInstances: checks.filter(c => c.online).length,
			instances: checks,
		};
	}

	/**
	 * Invalidate health cache for all instances (force re-check).
	 */
	resetHealthCache(): void {
		this.healthCache.clear();
	}
}
