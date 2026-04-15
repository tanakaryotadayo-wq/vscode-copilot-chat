/*---------------------------------------------------------------------------------------------
 *  Semantic Harvest — Neural Packet Explorer (TreeView)
 *  A VS Code TreeView that shows Neural Packets for the current workspace.
 *  Connects the "覚える" layer to the editor UI.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { HarvestEngine, HarvestEvent } from './harvestEngine.js';

interface PacketNode {
	label: string;
	description: string;
	tooltip: string;
	iconId: string;
	filePath?: string;
	children?: PacketNode[];
	collapsible: boolean;
}

/**
 * TreeDataProvider for Neural Packet browsing.
 * Shows harvested files → symbols → metrics in a tree structure.
 */
export class PacketExplorer implements vscode.TreeDataProvider<PacketNode>, vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private _onDidChangeTreeData = new vscode.EventEmitter<PacketNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private files = new Map<string, {
		symbolCount: number;
		dependencyCount: number;
		callEdgeCount: number;
		lastHarvest: number;
		hasSemanticDelta: boolean;
	}>();

	constructor(private readonly engine: HarvestEngine) {
		// Listen for harvest events
		this.disposables.push(
			engine.onDidHarvest(event => this.onHarvest(event)),
		);
	}

	/**
	 * Register the TreeView in VS Code.
	 */
	register(context: vscode.ExtensionContext): vscode.TreeView<PacketNode> {
		const treeView = vscode.window.createTreeView('fusionHarvestExplorer', {
			treeDataProvider: this,
			showCollapseAll: true,
		});
		context.subscriptions.push(treeView);
		return treeView;
	}

	// ── TreeDataProvider ──────────────────────────────────────────────────

	getTreeItem(element: PacketNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			element.label,
			element.collapsible
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		item.description = element.description;
		item.tooltip = element.tooltip;
		item.iconPath = new vscode.ThemeIcon(element.iconId);

		if (element.filePath) {
			item.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [vscode.Uri.file(element.filePath)],
			};
		}

		return item;
	}

	getChildren(element?: PacketNode): PacketNode[] {
		if (!element) {
			return this.getRootNodes();
		}
		return element.children ?? [];
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private getRootNodes(): PacketNode[] {
		const stats = this.engine.getStats();

		// Summary node
		const summaryNode: PacketNode = {
			label: `Harvest: ${stats.harvestCount} processed`,
			description: stats.sidecarOnline ? '🟢 online' : '🔴 offline',
			tooltip: `Tracked files: ${stats.trackedFiles}\nErrors: ${stats.errorCount}\nSidecar: ${stats.sidecarOnline ? 'connected' : 'disconnected'}`,
			iconId: 'pulse',
			collapsible: false,
		};

		// File nodes
		const fileNodes: PacketNode[] = [];
		for (const [filePath, info] of this.files) {
			const basename = filePath.split('/').pop() ?? filePath;
			const ago = this.timeAgo(info.lastHarvest);

			fileNodes.push({
				label: basename,
				description: `${info.symbolCount} sym | ${info.dependencyCount} dep${info.hasSemanticDelta ? ' | Δ' : ''}`,
				tooltip: [
					filePath,
					`Symbols: ${info.symbolCount}`,
					`Dependencies: ${info.dependencyCount}`,
					`Call edges: ${info.callEdgeCount}`,
					`Last harvest: ${ago}`,
					info.hasSemanticDelta ? 'Has semantic delta (changed)' : 'No changes since last harvest',
				].join('\n'),
				iconId: info.hasSemanticDelta ? 'diff-modified' : 'file-code',
				filePath,
				collapsible: false,
			});
		}

		// Sort by most recently harvested
		fileNodes.sort((a, b) => {
			const aTime = this.files.get(a.filePath!)?.lastHarvest ?? 0;
			const bTime = this.files.get(b.filePath!)?.lastHarvest ?? 0;
			return bTime - aTime;
		});

		return [summaryNode, ...fileNodes];
	}

	private onHarvest(event: HarvestEvent): void {
		this.files.set(event.filePath, {
			symbolCount: event.symbolCount,
			dependencyCount: event.dependencyCount,
			callEdgeCount: event.callEdgeCount,
			lastHarvest: Date.now(),
			hasSemanticDelta: event.hasSemanticDelta,
		});

		this._onDidChangeTreeData.fire(undefined);
	}

	private timeAgo(timestamp: number): string {
		const seconds = Math.floor((Date.now() - timestamp) / 1000);
		if (seconds < 60) { return `${seconds}s ago`; }
		if (seconds < 3600) { return `${Math.floor(seconds / 60)}m ago`; }
		return `${Math.floor(seconds / 3600)}h ago`;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
