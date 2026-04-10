/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — MCP Bridge
 *  Connects to fusion-gate MCP server for tool calling (17+ tools)
 *  
 *  Communicates with fusion_gate_mcp.py via JSON-RPC over stdio.
 *  Provides tool definitions and execution for Chat Participant.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';

export interface McpToolResult {
	success: boolean;
	content: string;
	error?: string;
}

/**
 * Bridge to fusion-gate MCP server.
 * Spawns the MCP server as a subprocess and communicates via JSON-RPC.
 */
export class McpBridge {
	private process: ChildProcess | undefined;
	private requestId = 0;
	private pendingRequests = new Map<number, {
		resolve: (value: unknown) => void;
		reject: (reason: Error) => void;
	}>();
	private buffer = '';
	private initialized = false;

	constructor(
		private readonly pythonPath: string = '/Users/ryyota/miniforge3/bin/python3',
		private readonly mcpScript: string = '/Users/ryyota/fusion-gate/integration/fusion_gate_mcp.py',
		private readonly pythonPaths: string[] = [
			'/Users/ryyota/fusion-gate/gate',
			'/Users/ryyota/fusion-gate/intelligence',
			'/Users/ryyota/fusion-gate/integration',
		],
	) {}

	/**
	 * Start the MCP server subprocess.
	 */
	async start(): Promise<boolean> {
		if (this.process) { return true; }

		try {
			// Validate paths before spawning
			const fs = await import('fs');
			if (!fs.existsSync(this.pythonPath)) {
				console.error(`[mcp] Python not found at: ${this.pythonPath}`);
				return false;
			}
			if (!fs.existsSync(this.mcpScript)) {
				console.error(`[mcp] MCP script not found at: ${this.mcpScript}`);
				return false;
			}

			this.process = spawn(this.pythonPath, [this.mcpScript], {
				env: {
					...process.env,
					PYTHONUNBUFFERED: '1',
					PYTHONPATH: this.pythonPaths.join(':'),
					EMBEDDING2_MODE: 'local_ai',
				},
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			if (!this.process.stdout || !this.process.stdin) {
				throw new Error('Failed to create MCP process stdio');
			}

			// Handle stdout (JSON-RPC responses)
			this.process.stdout.on('data', (data: Buffer) => {
				this.buffer += data.toString();
				this.processBuffer();
			});

			this.process.stderr?.on('data', (data: Buffer) => {
				// MCP server stderr — log but don't fail
				const msg = data.toString().trim();
				if (msg) { console.log(`[mcp-stderr] ${msg}`); }
			});

			this.process.on('exit', (code) => {
				console.log(`[mcp] Process exited with code ${code}`);
				this.process = undefined;
				this.initialized = false;
			});

			// Send initialize request
			const initResult = await this.sendRequest('initialize', {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'fusion-copilot', version: '0.1.0' },
			});

			// Send initialized notification
			this.sendNotification('notifications/initialized', {});
			this.initialized = true;

			return true;
		} catch (err) {
			console.error(`[mcp] Failed to start: ${err}`);
			this.process = undefined;
			return false;
		}
	}

	/**
	 * Call an MCP tool by name.
	 */
	async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
		if (!this.initialized) {
			const started = await this.start();
			if (!started) {
				return { success: false, content: '', error: 'MCP server not available' };
			}
		}

		try {
			const result = await this.sendRequest('tools/call', { name, arguments: args }) as {
				content?: Array<{ type: string; text: string }>;
			};

			const text = result?.content?.map((c: { text: string }) => c.text).join('\n') ?? '';
			return { success: true, content: text };
		} catch (err) {
			return {
				success: false,
				content: '',
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * List available MCP tools.
	 */
	async listTools(): Promise<Array<{ name: string; description: string }>> {
		if (!this.initialized) { await this.start(); }

		try {
			const result = await this.sendRequest('tools/list', {}) as {
				tools?: Array<{ name: string; description: string }>;
			};
			return result?.tools ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * Check if MCP bridge is running and healthy.
	 */
	get isRunning(): boolean {
		return this.initialized && !!this.process;
	}

	/**
	 * Stop the MCP server.
	 */
	stop(): void {
		if (this.process) {
			this.process.kill('SIGTERM');
			this.process = undefined;
			this.initialized = false;
		}
	}

	// ── JSON-RPC ────────────────────────────────────────────────────────────

	private sendRequest(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++this.requestId;
			this.pendingRequests.set(id, { resolve, reject });

			const message = JSON.stringify({
				jsonrpc: '2.0',
				id,
				method,
				params,
			});

			const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

			try {
				this.process?.stdin?.write(frame);
			} catch (err) {
				this.pendingRequests.delete(id);
				reject(new Error(`Failed to send: ${err}`));
			}

			// Timeout after 30s
			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`MCP request timeout: ${method}`));
				}
			}, 30_000);
		});
	}

	private sendNotification(method: string, params: unknown): void {
		const message = JSON.stringify({
			jsonrpc: '2.0',
			method,
			params,
		});
		const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
		this.process?.stdin?.write(frame);
	}

	private processBuffer(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) { break; }

			const header = this.buffer.slice(0, headerEnd);
			const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
			if (!lengthMatch) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const contentLength = parseInt(lengthMatch[1], 10);
			const contentStart = headerEnd + 4;

			if (this.buffer.length < contentStart + contentLength) {
				break; // Wait for more data
			}

			const content = this.buffer.slice(contentStart, contentStart + contentLength);
			this.buffer = this.buffer.slice(contentStart + contentLength);

			try {
				const msg = JSON.parse(content) as { id?: number; result?: unknown; error?: { message: string } };
				if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
					const pending = this.pendingRequests.get(msg.id)!;
					this.pendingRequests.delete(msg.id);

					if (msg.error) {
						pending.reject(new Error(msg.error.message));
					} else {
						pending.resolve(msg.result);
					}
				}
			} catch {
				// Skip malformed JSON
			}
		}
	}
}
