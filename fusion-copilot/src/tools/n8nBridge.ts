import * as vscode from 'vscode';

export class N8nBridge {
	private readonly webhookUrl: string;

	constructor() {
		// Define your local n8n IDE trigger webhook URL here
		this.webhookUrl = 'http://localhost:5678/webhook/jules-start';
	}

	/**
	 * Send a task and repository context to the external n8n Visual Workflow Engine.
	 * n8n will take over the closed loop (Task Execution -> Git Diff -> DEEPTHINK Review -> Auto Fix).
	 */
	async triggerJulesAuditLoop(repo: string, task: string): Promise<boolean> {
		try {
			const res = await fetch(this.webhookUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repo, task })
			});
			if (!res.ok) {
				console.error(`n8n webhook failed with HTTP ${res.status}`);
				return false;
			}
			return true;
		} catch (err) {
			console.error(`n8n webhook error: ${err}`);
			return false;
		}
	}
}
