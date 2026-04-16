/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — Status Bar
 *  Shows real-time model status + Perfect Equilibrium metrics in the VS Code status bar.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { FarmStatus } from '../providers/qwenFarm.js';
import type { LocalAiHealthStatus } from '../providers/localAiClient.js';

export interface PEStatusData {
	p_hall: number;
	p_limit: number;
	karma: number;
	status: string;
	sabotage_events: number;
	step_count: number;
}

export interface HarvestStatusData {
	harvestCount: number;
	lastDrift: number;
	status: 'idle' | 'harvesting' | 'error';
}

export class FusionStatusBar {
	private readonly item: vscode.StatusBarItem;
	private readonly peItem: vscode.StatusBarItem;
	private readonly harvestItem: vscode.StatusBarItem;
	private disposed = false;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'fusion.copilot.selectModel';
		this.item.tooltip = 'Fusion Copilot — Click to select model';
		this.setLoading();
		this.item.show();

		// PE Status Bar (always visible, to the right of the main bar)
		this.peItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
		this.peItem.tooltip = '⚖️ Perfect Equilibrium — Hallucination Control';
		this.peItem.text = '⚖️ PE: IDLE';
		this.peItem.show();

		// Harvest Status Bar (to the right of PE)
		this.harvestItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
		this.harvestItem.command = 'fusion.harvest.now';
		this.harvestItem.tooltip = '🌾 Semantic Harvest — Click to harvest current file';
		this.harvestItem.text = '🌾 Harvest: 0';
		this.harvestItem.show();
	}

	/** Show loading state */
	setLoading(): void {
		this.item.text = '$(loading~spin) Fusion';
		this.item.backgroundColor = undefined;
	}

	/** Update status bar with current health info */
	update(farm: FarmStatus | null, coder: LocalAiHealthStatus | null, geminiOnline: boolean): void {
		if (this.disposed) { return; }

		const parts: string[] = [];

		// Qwen Farm
		if (farm) {
			const farmIcon = farm.onlineInstances > 0 ? '✓' : '✗';
			parts.push(`Q3.5×${farm.onlineInstances}/${farm.totalInstances} ${farmIcon}`);
		} else {
			parts.push('Q3.5 ?');
		}

		// Coder
		if (coder) {
			parts.push(coder.online ? 'Coder ✓' : 'Coder ✗');
		} else {
			parts.push('Coder ?');
		}

		// Gemini
		parts.push(geminiOnline ? 'Gemini ✓' : 'Gemini ✗');

		// Set appearance based on overall health
		const allOnline = (farm?.onlineInstances ?? 0) > 0 && (coder?.online ?? false) && geminiOnline;
		const someOnline = (farm?.onlineInstances ?? 0) > 0 || (coder?.online ?? false) || geminiOnline;

		if (allOnline) {
			this.item.text = `$(flame) Fusion: ${parts.join(' | ')}`;
			this.item.backgroundColor = undefined;
		} else if (someOnline) {
			this.item.text = `$(warning) Fusion: ${parts.join(' | ')}`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			this.item.text = `$(error) Fusion: ALL OFFLINE`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		}
	}

	/** Update PE metrics in the status bar */
	updatePE(pe: PEStatusData): void {
		if (this.disposed) { return; }

		const emoji = pe.status === 'STABLE' ? '🟢'
			: pe.status === 'SABOTAGE_DETECTED' ? '🚨'
			: pe.status === 'COLLAPSED' ? '🔴'
			: pe.status === 'IDLE' ? '⚪'
			: '🟡';

		const karmaStr = pe.karma < 1.0 ? ` K:${pe.karma.toFixed(2)}` : '';
		const sabStr = pe.sabotage_events > 0 ? ` 🚨${pe.sabotage_events}` : '';
		this.peItem.text = `${emoji} PE: ${(pe.p_hall * 100).toFixed(1)}%/${(pe.p_limit * 100).toFixed(1)}%${karmaStr}${sabStr}`;

		if (pe.status === 'SABOTAGE_DETECTED') {
			this.peItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			this.peItem.tooltip = `🚨 SABOTAGE DETECTED — Karma: ${pe.karma.toFixed(4)} | Sabotage events: ${pe.sabotage_events}`;
		} else if (pe.karma < 0.8) {
			this.peItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.peItem.tooltip = `⚠️ Degraded trust — Karma: ${pe.karma.toFixed(4)} | Steps: ${pe.step_count}`;
		} else {
			this.peItem.backgroundColor = undefined;
			this.peItem.tooltip = `⚖️ P_hall: ${pe.p_hall.toFixed(4)} / P_limit: ${pe.p_limit.toFixed(4)} | Steps: ${pe.step_count}`;
		}
	}

	/** Update harvest metrics in the status bar */
	updateHarvest(data: HarvestStatusData): void {
		if (this.disposed) { return; }

		const driftStr = data.lastDrift > 0 ? ` Δ${(data.lastDrift * 100).toFixed(1)}%` : '';

		if (data.status === 'harvesting') {
			this.harvestItem.text = `$(loading~spin) Harvesting...`;
			this.harvestItem.backgroundColor = undefined;
		} else if (data.status === 'error') {
			this.harvestItem.text = `🌾 Harvest: ERR`;
			this.harvestItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			this.harvestItem.text = `🌾 ${data.harvestCount}${driftStr}`;
			this.harvestItem.backgroundColor = undefined;
		}

		this.harvestItem.tooltip = [
			'🌾 Semantic Harvest',
			`Packets harvested: ${data.harvestCount}`,
			`Last drift: ${(data.lastDrift * 100).toFixed(2)}%`,
			'Click to harvest current file',
		].join('\n');
	}

	/** Set a temporary status message */
	flash(message: string, durationMs: number = 3000): void {
		const prev = this.item.text;
		this.item.text = `$(flame) ${message}`;
		setTimeout(() => {
			if (!this.disposed) { this.item.text = prev; }
		}, durationMs);
	}

	dispose(): void {
		this.disposed = true;
		this.item.dispose();
		this.peItem.dispose();
		this.harvestItem.dispose();
	}
}
