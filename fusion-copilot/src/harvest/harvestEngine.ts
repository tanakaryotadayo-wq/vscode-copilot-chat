/*---------------------------------------------------------------------------------------------
 *  Semantic Harvest — Harvest Engine
 *  The core "二重人格" driver: every save triggers meaning extraction.
 *
 *  Pipeline: onDidSave → extractSymbols → extractDeps → computeHash →
 *            diffWithPrevious → submitToSidecar → updateUI
 *
 *  Design principles:
 *  - Extension is thin: extract + transform only
 *  - Sidecar is thick: vectorize + store + drift-detect
 *  - Debounce saves to avoid flooding
 *  - Degrade gracefully if sidecar is offline
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SidecarClient, type HarvestPayload, type SemanticDeltaPayload, type CallEdge } from './sidecarClient.js';
import {
	extractSymbols,
	extractCallGraph,
	extractDependencies,
	computeContentHash,
} from './symbolExtractor.js';

export interface HarvestEngineOptions {
	/** Languages to harvest (empty = all) */
	includedLanguages?: string[];
	/** File patterns to exclude */
	excludePatterns?: string[];
	/** Debounce interval in ms (default: 1000) */
	debounceMs?: number;
	/** Enable call graph extraction (heavier, default: false) */
	enableCallGraph?: boolean;
	/** Log function */
	log?: (message: string) => void;
}

interface HarvestState {
	lastHash: string;
	lastSymbolNames: string[];
	lastHarvestTime: number;
	packetId?: string;
}

/**
 * The Harvest Engine — turns VS Code's "save" action into a semantic extraction event.
 * This is the bridge between the editor personality and the memory personality.
 */
export class HarvestEngine implements vscode.Disposable {
	private readonly sidecar: SidecarClient;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly fileState = new Map<string, HarvestState>();
	private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly options: Required<HarvestEngineOptions>;

	// Stats
	private harvestCount = 0;
	private errorCount = 0;
	private sidecarOnline = false;

	constructor(sidecar: SidecarClient, options: HarvestEngineOptions = {}) {
		this.sidecar = sidecar;
		this.options = {
			includedLanguages: options.includedLanguages ?? [],
			excludePatterns: options.excludePatterns ?? [
				'**/node_modules/**',
				'**/.git/**',
				'**/dist/**',
				'**/out/**',
				'**/*.min.*',
			],
			debounceMs: options.debounceMs ?? 1000,
			enableCallGraph: options.enableCallGraph ?? false,
			log: options.log ?? (() => {}),
		};
	}

	/**
	 * Activate the harvest engine — register event listeners.
	 */
	activate(context: vscode.ExtensionContext): void {
		// File save hook — the core trigger
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(doc => this.onDocumentSaved(doc)),
		);

		// Active editor change — pre-harvest for responsiveness
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor) { this.preHarvest(editor.document); }
			}),
		);

		// Initial sidecar health check
		this.checkSidecarHealth();

		// Periodic health check (every 60s)
		const healthInterval = setInterval(() => this.checkSidecarHealth(), 60_000);
		this.disposables.push({ dispose: () => clearInterval(healthInterval) });

		// Push all to context
		for (const d of this.disposables) {
			context.subscriptions.push(d);
		}

		this.options.log('[harvest] Engine activated');
	}

	/**
	 * Get current harvest statistics.
	 */
	getStats(): { harvestCount: number; errorCount: number; trackedFiles: number; sidecarOnline: boolean } {
		return {
			harvestCount: this.harvestCount,
			errorCount: this.errorCount,
			trackedFiles: this.fileState.size,
			sidecarOnline: this.sidecarOnline,
		};
	}

	/**
	 * Get previous state for a file (for semantic diff display).
	 */
	getFileState(filePath: string): HarvestState | undefined {
		return this.fileState.get(filePath);
	}

	/**
	 * Force a harvest of the currently active document.
	 */
	async harvestActiveDocument(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			await this.harvest(editor.document);
		}
	}

	// ── Core Pipeline ─────────────────────────────────────────────────────

	private onDocumentSaved(document: vscode.TextDocument): void {
		// Skip if language not included
		if (this.options.includedLanguages.length > 0
			&& !this.options.includedLanguages.includes(document.languageId)) {
			return;
		}

		// Skip excluded patterns
		const filePath = document.uri.fsPath;
		if (this.isExcluded(filePath)) { return; }

		// Debounce rapid saves
		const existing = this.debounceTimers.get(filePath);
		if (existing) { clearTimeout(existing); }

		this.debounceTimers.set(filePath, setTimeout(() => {
			this.debounceTimers.delete(filePath);
			this.harvest(document).catch(err => {
				this.options.log(`[harvest] Error: ${err}`);
				this.errorCount++;
			});
		}, this.options.debounceMs));
	}

	private async harvest(document: vscode.TextDocument): Promise<void> {
		const filePath = document.uri.fsPath;
		const startTime = Date.now();

		// Compute content hash first — skip if unchanged
		const text = document.getText();
		const currentHash = computeContentHash(text);
		const prevState = this.fileState.get(filePath);

		if (prevState && prevState.lastHash === currentHash) {
			this.options.log(`[harvest] Skip (unchanged): ${filePath}`);
			return;
		}

		this.options.log(`[harvest] Processing: ${filePath}`);

		// ① Extract symbols (LSP DocumentSymbol)
		const symbols = await extractSymbols(document);

		// ② Extract dependencies (regex-based)
		const dependencies = extractDependencies(document);

		// ③ Compute semantic delta (what changed since last harvest?)
		let semanticDelta: SemanticDeltaPayload | undefined;
		if (prevState) {
			const currentSymbolNames = symbols.map(s => s.name);
			const prevNames = new Set(prevState.lastSymbolNames);
			const currNames = new Set(currentSymbolNames);

			semanticDelta = {
				previousHash: prevState.lastHash,
				changedSymbols: currentSymbolNames.filter(n => prevNames.has(n)),
				addedSymbols: currentSymbolNames.filter(n => !prevNames.has(n)),
				removedSymbols: prevState.lastSymbolNames.filter(n => !currNames.has(n)),
			};
		}

		// ④ Optional: Extract call graph (heavier operation)
		let callGraph: CallEdge[] | undefined;
		if (this.options.enableCallGraph && symbols.length > 0) {
			callGraph = await extractCallGraph(document, symbols);
		}

		// ⑤ Build harvest payload
		const payload: HarvestPayload = {
			filePath,
			languageId: document.languageId,
			symbols,
			dependencies,
			contentHash: currentHash,
			timestamp: new Date().toISOString(),
			callGraph,
			semanticDelta,
		};

		// ⑥ Submit to sidecar (if online)
		if (this.sidecarOnline) {
			try {
				const response = await this.sidecar.submitHarvest(payload);
				if (response.success) {
					this.options.log(`[harvest] ✓ ${filePath} → packet:${response.packetId ?? 'new'} (${Date.now() - startTime}ms)`);
				} else {
					this.options.log(`[harvest] ✗ Sidecar rejected: ${response.error}`);
					this.errorCount++;
				}
			} catch (err) {
				this.options.log(`[harvest] ✗ Sidecar error: ${err}`);
				this.sidecarOnline = false;
				this.errorCount++;
			}
		} else {
			this.options.log(`[harvest] ○ Offline harvest (cached locally): ${filePath}`);
		}

		// ⑦ Update local state (even if sidecar is offline)
		this.fileState.set(filePath, {
			lastHash: currentHash,
			lastSymbolNames: symbols.map(s => s.name),
			lastHarvestTime: Date.now(),
		});

		this.harvestCount++;

		// Fire event for UI updates
		this._onDidHarvest.fire({
			filePath,
			symbolCount: symbols.length,
			dependencyCount: dependencies.length,
			callEdgeCount: callGraph?.length ?? 0,
			hasSemanticDelta: !!semanticDelta,
			durationMs: Date.now() - startTime,
		});
	}

	/**
	 * Pre-harvest: run lightweight extraction when switching files.
	 * Does NOT submit to sidecar — just updates local symbol cache.
	 */
	private async preHarvest(document: vscode.TextDocument): Promise<void> {
		if (this.isExcluded(document.uri.fsPath)) { return; }
		if (this.fileState.has(document.uri.fsPath)) { return; }

		const symbols = await extractSymbols(document);
		const hash = computeContentHash(document.getText());

		this.fileState.set(document.uri.fsPath, {
			lastHash: hash,
			lastSymbolNames: symbols.map(s => s.name),
			lastHarvestTime: Date.now(),
		});
	}

	private isExcluded(filePath: string): boolean {
		for (const pattern of this.options.excludePatterns) {
			// Simple glob check — ** matches any path segment
			const regex = new RegExp(
				'^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$',
			);
			if (regex.test(filePath)) { return true; }
		}
		return false;
	}

	private async checkSidecarHealth(): Promise<void> {
		try {
			const result = await this.sidecar.healthCheck();
			const wasOffline = !this.sidecarOnline;
			this.sidecarOnline = result.healthy;

			if (wasOffline && result.healthy) {
				this.options.log('[harvest] Sidecar reconnected');
			} else if (!wasOffline && !result.healthy) {
				this.options.log('[harvest] Sidecar disconnected — switching to offline mode');
			}
		} catch {
			this.sidecarOnline = false;
		}
	}

	// ── Events ────────────────────────────────────────────────────────────

	private _onDidHarvest = new vscode.EventEmitter<HarvestEvent>();
	readonly onDidHarvest = this._onDidHarvest.event;

	dispose(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		this._onDidHarvest.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

export interface HarvestEvent {
	filePath: string;
	symbolCount: number;
	dependencyCount: number;
	callEdgeCount: number;
	hasSemanticDelta: boolean;
	durationMs: number;
}
