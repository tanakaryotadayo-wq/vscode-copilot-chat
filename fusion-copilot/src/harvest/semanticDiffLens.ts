/*---------------------------------------------------------------------------------------------
 *  Semantic Harvest — Semantic Diff CodeLens
 *  Shows inline markers above functions/classes that have semantically changed
 *  since the last harvest. Uses data from the HarvestEngine's state diff.
 *
 *  This bridges the "理解する" layer (semantic diff) with the editor UI.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { HarvestEngine } from './harvestEngine.js';
import { extractSymbols } from './symbolExtractor.js';

/**
 * CodeLens provider that shows semantic diff indicators above changed symbols.
 *
 * Example CodeLens display:
 *   [Δ Changed since last save] [+3 deps] [Call graph: 5 edges]
 *   function processDocument(...) {
 */
export class SemanticDiffLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	constructor(private readonly engine: HarvestEngine) {
		// Refresh CodeLenses when a harvest completes
		this.disposables.push(
			engine.onDidHarvest(() => this._onDidChangeCodeLenses.fire()),
		);
	}

	/**
	 * Register the CodeLens provider.
	 */
	register(context: vscode.ExtensionContext): void {
		const provider = vscode.languages.registerCodeLensProvider(
			{ pattern: '**/*.{ts,tsx,js,jsx,py,go,rs,java}' },
			this,
		);
		context.subscriptions.push(provider);
	}

	async provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.CodeLens[]> {
		const filePath = document.uri.fsPath;
		const state = this.engine.getFileState(filePath);

		// No previous state — nothing to diff
		if (!state) { return []; }

		const lenses: vscode.CodeLens[] = [];
		const symbols = await extractSymbols(document);

		for (const sym of symbols) {
			// Only add CodeLens for top-level functions, classes, interfaces
			if (!['Function', 'Class', 'Interface', 'Method', 'Enum'].includes(sym.kind)) {
				continue;
			}

			const range = new vscode.Range(sym.range.startLine, 0, sym.range.startLine, 0);

			// Check if this symbol was in the delta
			const wasChanged = state.lastSymbolNames.includes(sym.name);
			const isNew = !state.lastSymbolNames.includes(sym.name);

			if (isNew) {
				lenses.push(new vscode.CodeLens(range, {
					title: '$(diff-added) New symbol',
					command: '',
					tooltip: `"${sym.name}" was added in this save`,
				}));
			} else if (wasChanged) {
				// Symbol existed before — show stability info
				lenses.push(new vscode.CodeLens(range, {
					title: `$(pulse) ${sym.kind}: ${sym.name}`,
					command: 'fusion.harvest.showSymbolInfo',
					arguments: [filePath, sym.name],
					tooltip: `Click to view semantic history for "${sym.name}"`,
				}));
			}
		}

		// File-level CodeLens at the top
		if (lenses.length === 0 && state.lastHash) {
			lenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
				title: `$(check) Harvested: ${state.lastSymbolNames.length} symbols tracked`,
				command: '',
				tooltip: `Last harvest: ${new Date(state.lastHarvestTime).toLocaleTimeString()}\nContent hash: ${state.lastHash}`,
			}));
		}

		return lenses;
	}

	dispose(): void {
		this._onDidChangeCodeLenses.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
