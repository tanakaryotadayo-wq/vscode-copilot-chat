/*---------------------------------------------------------------------------------------------
 *  Semantic Harvest — Sidecar Client
 *  HTTP client for communicating with Newgate sidecar daemons.
 *  Sends harvested semantic data (symbols, call graphs, diffs) to the
 *  fusion-gate intelligence layer for vectorization and storage.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';

export interface SidecarConfig {
	vectorProxyPort: number;   // :9700
	fusionGatePort: number;    // :9800
	cbfPort: number;           // :9801
	pccPort: number;           // :9802
	embeddingBasePort: number; // :8093 (first of 15-fleet)
	host: string;              // localhost
}

export interface HarvestPayload {
	/** Absolute file path */
	filePath: string;
	/** Language ID (typescript, python, etc.) */
	languageId: string;
	/** Document symbol tree */
	symbols: SymbolInfo[];
	/** Import/export dependencies */
	dependencies: DependencyInfo[];
	/** Content hash for dedup */
	contentHash: string;
	/** Timestamp */
	timestamp: string;
	/** Optional call hierarchy data */
	callGraph?: CallEdge[];
	/** Optional semantic diff from last save */
	semanticDelta?: SemanticDeltaPayload;
}

export interface SymbolInfo {
	name: string;
	kind: string;            // function, class, variable, interface, etc.
	range: { startLine: number; endLine: number };
	children?: SymbolInfo[];
	detail?: string;         // type signature if available
	containerName?: string;
}

export interface DependencyInfo {
	source: string;           // import source (e.g., './utils', 'vscode')
	specifiers: string[];     // imported names
	isRelative: boolean;
	resolvedPath?: string;    // absolute resolved path
}

export interface CallEdge {
	caller: { name: string; filePath: string; line: number };
	callee: { name: string; filePath: string; line: number };
}

export interface SemanticDeltaPayload {
	/** Previous content hash */
	previousHash: string;
	/** Changed symbol names */
	changedSymbols: string[];
	/** Added symbols */
	addedSymbols: string[];
	/** Removed symbols */
	removedSymbols: string[];
}

export interface SidecarResponse {
	success: boolean;
	packetId?: string;
	driftScore?: number;
	error?: string;
}

const DEFAULT_CONFIG: SidecarConfig = {
	vectorProxyPort: 9700,
	fusionGatePort: 9800,
	cbfPort: 9801,
	pccPort: 9802,
	embeddingBasePort: 8093,
	host: 'localhost',
};

/**
 * HTTP client for the Newgate sidecar daemons.
 * Thin wrapper — all heavy processing happens in the sidecar.
 */
export class SidecarClient {
	private readonly config: SidecarConfig;
	private lastHealthCheck: { timestamp: number; healthy: boolean } | undefined;

	constructor(config?: Partial<SidecarConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Submit harvested semantic data to Fusion Gate for packetization.
	 * POST /harvest → fusion_gate:9800
	 */
	async submitHarvest(payload: HarvestPayload): Promise<SidecarResponse> {
		return this.post(this.config.fusionGatePort, '/harvest', payload) as Promise<SidecarResponse>;
	}

	/**
	 * Request semantic delta computation for a file.
	 * POST /semantic-delta → fusion_gate:9800
	 */
	async computeSemanticDelta(filePath: string, currentHash: string): Promise<{
		driftScore: number;
		changedConcepts: string[];
		stabilityIndex: number;
	}> {
		const result = await this.post(this.config.fusionGatePort, '/semantic-delta', {
			file_path: filePath,
			current_hash: currentHash,
		});
		return result as { driftScore: number; changedConcepts: string[]; stabilityIndex: number };
	}

	/**
	 * Query neural packets for a file.
	 * GET /packets?file=<path> → fusion_gate:9800
	 */
	async getPacketsForFile(filePath: string): Promise<Array<{
		id: string;
		name: string;
		type: string;
		status: string;
		driftScore: number;
	}>> {
		const result = await this.get(this.config.fusionGatePort, `/packets?file=${encodeURIComponent(filePath)}`);
		return (result as { packets: Array<{ id: string; name: string; type: string; status: string; driftScore: number }> }).packets ?? [];
	}

	/**
	 * Health check — is the sidecar alive?
	 */
	async healthCheck(): Promise<{ healthy: boolean; services: Record<string, boolean> }> {
		const now = Date.now();
		if (this.lastHealthCheck && now - this.lastHealthCheck.timestamp < 5000) {
			return { healthy: this.lastHealthCheck.healthy, services: {} };
		}

		const checks = await Promise.allSettled([
			this.get(this.config.fusionGatePort, '/health'),
			this.get(this.config.vectorProxyPort, '/health'),
			this.get(this.config.cbfPort, '/health'),
		]);

		const services: Record<string, boolean> = {
			fusionGate: checks[0].status === 'fulfilled',
			vectorProxy: checks[1].status === 'fulfilled',
			cbf: checks[2].status === 'fulfilled',
		};

		const healthy = Object.values(services).some(v => v);
		this.lastHealthCheck = { timestamp: now, healthy };

		return { healthy, services };
	}

	// ── HTTP Primitives ──────────────────────────────────────────────────

	private post(port: number, path: string, body: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const data = JSON.stringify(body);
			const req = http.request({
				hostname: this.config.host,
				port,
				path,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(data),
				},
				timeout: 10_000,
			}, (res) => {
				let body = '';
				res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
				res.on('end', () => {
					try {
						resolve(JSON.parse(body));
					} catch {
						resolve({ success: true, raw: body });
					}
				});
			});

			req.on('error', (err) => reject(err));
			req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
			req.write(data);
			req.end();
		});
	}

	private get(port: number, path: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const req = http.request({
				hostname: this.config.host,
				port,
				path,
				method: 'GET',
				timeout: 5_000,
			}, (res) => {
				let body = '';
				res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
				res.on('end', () => {
					try {
						resolve(JSON.parse(body));
					} catch {
						resolve({ success: true, raw: body });
					}
				});
			});

			req.on('error', (err) => reject(err));
			req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: GET ${path}`)); });
			req.end();
		});
	}
}
