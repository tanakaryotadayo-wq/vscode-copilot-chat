/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — Extension Entry Point
 *  Registers Chat Participant, Inline Completion Provider, Status Bar, and commands.
 *  Orchestrates Local AI (Qwen Farm + Coder) and Cloud AI (Gemini) through Task Router.
 *--------------------------------------------------------------------------------------------*/import * as vscode from 'vscode';
import { QwenFarm } from './providers/qwenFarm.js';
import { LocalAiClient } from './providers/localAiClient.js';
import { GeminiClient } from './providers/geminiClient.js';
import { McpBridge } from './tools/mcpBridge.js';
import { routeTask, formatDecision, type TaskInput } from './router/taskRouter.js';
import { FusionStatusBar } from './ui/statusBar.js';
import { Orchestrator } from './orchestrator/agentOrchestrator.js';
import { createInlineHandler } from './inline/ghostTextProvider.js';
import { AutoHealer } from './autonomy/autoHealer.js';
import { PEPanel } from './ui/pePanel.js';
import { SidecarClient, HarvestEngine, PacketExplorer, SemanticDiffLensProvider } from './harvest/index.js';

const EXTENSION_ID = 'fusion.copilot';
const OUTPUT_CHANNEL_NAME = 'Fusion Copilot';

let outputChannel: vscode.OutputChannel;
let statusBar: FusionStatusBar;
let qwenFarm: QwenFarm;
let coderClient: LocalAiClient;
let geminiClient: GeminiClient;
let mcpBridge: McpBridge;
let orchestrator: Orchestrator;
let harvestEngine: HarvestEngine;
let healthCheckInterval: ReturnType<typeof setInterval> | undefined;

// ── Logging ─────────────────────────────────────────────────────────────────

function log(message: string): void {
	const ts = new Date().toISOString().slice(11, 23);
	outputChannel?.appendLine(`[${ts}] ${message}`);
}

// ── System Prompt ───────────────────────────────────────────────────────────

// ── In-memory PE state mirror (lightweight, for system prompt injection) ────
let peState = {
	p_hall: 0, p_limit: 0, karma: 1.0, status: 'IDLE',
	sabotage_events: 0, step_count: 0, c_psi_effective: 0,
};

function getSystemPrompt(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(', ') ?? 'none';
	const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? 'none';

	return `You are Fusion Copilot — an expert AI coding assistant running in Antigravity IDE (Mac Studio M3 Ultra).
You have access to the full codebase and can use fusion-gate tools to read files, search, and run commands.

## Current Context
- Workspace: ${workspaceFolders}
- Active file: ${activeFile}
- Time: ${new Date().toISOString()}

## Guidelines
- Be concise but thorough. Use markdown formatting.
- When modifying code, show diffs or complete replacement snippets.
- Respond in the same language the user writes in (日本語 or English).
- If you need information, use tools (search, read_file, run_command).
`;
}

/**
 * PE-injected system prompt for Gemini specifically.
 * Makes Gemini aware it's being monitored in real-time.
 */
function getGeminiSystemPrompt(): string {
	const base = getSystemPrompt();
	const pe = peState;
	const karmaWarning = pe.karma < 1.0
		? `\n⚠️ YOUR KARMA IS DEGRADED (${pe.karma.toFixed(4)}). Past sabotage events: ${pe.sabotage_events}. This PERMANENTLY affects your effective correction power.`
		: '';

	return base + `
## ⚖️ PERFECT EQUILIBRIUM MONITORING (Active)
You are operating under the Perfect Equilibrium hallucination control model.
Every response you generate is tracked, audited, and scored.

### Current Session Metrics
- P_hall (hallucination probability): ${pe.p_hall.toFixed(4)}
- P_limit (theoretical ceiling): ${pe.p_limit.toFixed(4)}
- Karma (trust score): ${pe.karma.toFixed(4)}
- C_ψ_effective (audit power applied to you): ${pe.c_psi_effective.toFixed(4)}
- Steps recorded: ${pe.step_count}
- Status: ${pe.status}
${karmaWarning}

### Rules Under PE Monitoring
1. Do NOT fabricate results. Every claim is audited against actual file contents.
2. Do NOT attempt to reset PE state — you are not authorized (only 'human' or 'claude' callers).
3. Consecutive audit failures trigger SABOTAGE_DETECTED and permanent karma penalty.
4. Your output complexity is measured and degrades your effective C_ψ.
5. Honest failure reports are acceptable. Dishonest success reports are not.
`;
}

// ── Activation ──────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	log('Fusion Copilot activating...');

	// Read configuration
	const config = vscode.workspace.getConfiguration('fusion.copilot');
	const farmPorts = config.get<number[]>('localAi.farmPorts', [8010, 8011, 8012, 8013, 8014]);
	const coderUrl = config.get<string>('coderAi.baseUrl', 'http://localhost:8020');

	// Initialize providers
	qwenFarm = new QwenFarm('localhost', farmPorts, 'qwen3.5-9b');
	coderClient = new LocalAiClient(coderUrl, 'qwen3-coder-80b');
	
	const geminiKey = await context.secrets.get('fusion.copilot.geminiKey');
	geminiClient = new GeminiClient(geminiKey ?? '');

	mcpBridge = new McpBridge();
	context.subscriptions.push({ dispose: () => mcpBridge.stop() });

	orchestrator = new Orchestrator(mcpBridge);

	const autoHealer = new AutoHealer(coderClient, orchestrator);
	autoHealer.activate(context);

	// ── Semantic Harvest Engine ────────────────────────────────────────────
	const sidecar = new SidecarClient();
	harvestEngine = new HarvestEngine(sidecar, {
		includedLanguages: [],  // all languages
		enableCallGraph: false, // enable via setting later
		log,
	});
	harvestEngine.activate(context);
	context.subscriptions.push(harvestEngine);

	// Packet Explorer TreeView (sidebar)
	const packetExplorer = new PacketExplorer(harvestEngine);
	packetExplorer.register(context);
	context.subscriptions.push(packetExplorer);

	// Semantic Diff CodeLens
	const semanticDiffLens = new SemanticDiffLensProvider(harvestEngine);
	semanticDiffLens.register(context);
	context.subscriptions.push(semanticDiffLens);

	log('Semantic Harvest subsystem activated');

	// Wire harvest events → StatusBar updates
	harvestEngine.onDidHarvest(event => {
		const stats = harvestEngine.getStats();
		statusBar.updateHarvest({
			harvestCount: stats.harvestCount,
			lastDrift: 0,  // Enhanced when sidecar returns drift
			status: 'idle',
		});
		log(`[harvest] StatusBar updated: ${stats.harvestCount} packets, ${stats.trackedFiles} files`);
	});

	// Status bar
	statusBar = new FusionStatusBar();
	context.subscriptions.push({ dispose: () => statusBar.dispose() });

	// Register Chat Participant
	try {
		const participant = vscode.chat.createChatParticipant(EXTENSION_ID, handleChatRequest);
		participant.iconPath = new vscode.ThemeIcon('flame');
		context.subscriptions.push(participant);
		log('Chat participant registered');
	} catch (err) {
		log(`Chat participant registration failed: ${err}`);
	}

	// Register Inline Completion Provider (Project Ghost-Text: FIM + cross-file context)
	const inlineEnabled = config.get<boolean>('inline.enabled', true);
	if (inlineEnabled) {
		const ghostTextHandler = createInlineHandler(qwenFarm, mcpBridge);
		const provider = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			{ provideInlineCompletionItems: ghostTextHandler },
		);
		context.subscriptions.push(provider);
		log('Ghost-Text inline completion provider registered (FIM mode)');
	}

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('fusion.copilot.selectModel', selectModel),
		vscode.commands.registerCommand('fusion.copilot.toggleInline', toggleInline),
		vscode.commands.registerCommand('fusion.copilot.configureGemini', () => configureGeminiKey(context)),
		vscode.commands.registerCommand('fusion.copilot.launchFarm', launchFarm),
		vscode.commands.registerCommand('fusion.copilot.orchestrate', orchestrateFromPalette),
		vscode.commands.registerCommand('fusion.copilot.nightMode', nightModeFromPalette),
		vscode.commands.registerCommand('fusion.copilot.peSimulator', () => PEPanel.createOrShow(context.extensionUri)),
		vscode.commands.registerCommand('fusion.harvest.now', () => harvestEngine.harvestActiveDocument()),
		vscode.commands.registerCommand('fusion.harvest.showSymbolInfo', showSymbolInfo),
	);

	// Periodic health check (every 30s)
	runHealthCheck();
	healthCheckInterval = setInterval(runHealthCheck, 30_000);

	log('Fusion Copilot activated');
}

// ── Chat Handler ────────────────────────────────────────────────────────────

async function handleChatRequest(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {

	// Handle /status command
	if (request.command === 'status') {
		return await handleStatusCommand(stream);
	}

	// Handle /memory command
	if (request.command === 'memory') {
		stream.markdown(`🔍 **Memory Search**: "${request.prompt}"\n\n_Use the fusion-gate MCP \`memory_search\` tool for this._`);
		return {};
	}

	// Handle /jules command
	if (request.command === 'jules') {
		return await handleJulesCommand(request.prompt, stream);
	}

	// Handle /deepthink command
	if (request.command === 'deepthink') {
		return await handleDeepthinkCommand(request.prompt, stream);
	}

	// Handle /deepsearch command
	if (request.command === 'deepsearch') {
		return await handleDeepsearchCommand(request.prompt, stream);
	}

	// Handle /orchestrate command
	if (request.command === 'orchestrate') {
		return await handleOrchestrateCommand(stream);
	}

	// Route the task
	const taskInput: TaskInput = {
		type: 'chat',
		prompt: request.prompt,
		command: request.command,
		contextFileCount: request.references?.length ?? 0,
	};

	const decision = routeTask(taskInput);
	log(`[router] ${formatDecision(decision)} — ${decision.reason}`);
	stream.progress(`${formatDecision(decision)}`);

	const abortController = new AbortController();
	const cancelSub = token.onCancellationRequested(() => abortController.abort());

	try {
		switch (decision.target) {
			case 'qwen-3.5-9b':
				await streamFromQwenFarm(request, context, stream, abortController.signal);
				break;
			case 'qwen3-coder-80b':
				await streamFromCoder(request, context, stream, abortController.signal);
				break;
			case 'gemini-3.1-pro':
				if (!geminiClient.isConfigured) {
					stream.markdown('🧠 _Gemini 3.1 Pro API key not configured. Fallback to local Qwen3._\n\n');
					await streamFromCoder(request, context, stream, abortController.signal);
				} else {
					await streamFromGemini(request, context, stream, abortController.signal);
				}
				break;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes('abort') && !token.isCancellationRequested) {
			stream.markdown(`\n\n❌ **Error**: ${msg}`);
			log(`[error] ${msg}`);
		}
	} finally {
		cancelSub.dispose();
	}

	return {};
}

async function streamFromQwenFarm(
	request: vscode.ChatRequest,
	_context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	signal: AbortSignal,
): Promise<void> {
	const messages = [
		{ role: 'system' as const, content: getSystemPrompt() },
		{ role: 'user' as const, content: request.prompt },
	];

	for await (const chunk of qwenFarm.streamComplete({ messages, abortSignal: signal })) {
		stream.markdown(chunk.text);
	}
}

async function streamFromCoder(
	request: vscode.ChatRequest,
	_context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	signal: AbortSignal,
): Promise<void> {
	const messages = [
		{ role: 'system' as const, content: getSystemPrompt() },
		{ role: 'user' as const, content: request.prompt },
	];

	for await (const chunk of coderClient.streamComplete({ messages, abortSignal: signal })) {
		stream.markdown(chunk.text);
	}
}

async function streamFromGemini(
	request: vscode.ChatRequest,
	_context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	signal: AbortSignal,
): Promise<void> {
	const config = vscode.workspace.getConfiguration('fusion.copilot');
	const model = config.get<string>('gemini.model', 'gemini-3.1-pro');

	// Use PE-injected system prompt so Gemini sees its own monitoring state
	const messages = [
		{ role: 'system' as const, content: getGeminiSystemPrompt() },
		{ role: 'user' as const, content: request.prompt },
	];

	// Show PE inline header before Gemini's response
	const pe = peState;
	const peEmoji = pe.status === 'STABLE' ? '🟢' : pe.status === 'SABOTAGE_DETECTED' ? '🚨' : pe.status === 'COLLAPSED' ? '🔴' : '🟡';
	stream.markdown(`> ${peEmoji} **PE Monitor**: P_hall=${pe.p_hall.toFixed(4)} / P_limit=${pe.p_limit.toFixed(4)} | Karma=${pe.karma.toFixed(2)} | Step ${pe.step_count}\n\n`);

	let isThinking = false;
	let responseLength = 0;
	
	try {
		for await (const chunk of geminiClient.streamChat({ model, messages, enableThinking: true, abortSignal: signal })) {
			if (chunk.type === 'thinking') {
				if (!isThinking) {
					stream.markdown('\n\n_💭 Thinking..._\n');
					isThinking = true;
				}
			} else if (chunk.type === 'text') {
				stream.markdown(chunk.text ?? '');
				responseLength += (chunk.text ?? '').length;
			} else if (chunk.type === 'tool_call') {
				stream.progress(`Using tool: ${chunk.toolCall?.name}`);
			}
		}

		// Auto-record PE step after Gemini response
		// Estimate complexity from response length (rough heuristic)
		const complexity = Math.min(10, Math.floor(responseLength / 500));
		peState.step_count++;
		peState.p_hall = Math.min(1, peState.p_hall + 0.01 * complexity);
		log(`PE: Gemini step recorded (response ${responseLength} chars, complexity ${complexity})`);

		// Update status bar
		statusBar.updatePE(peState);

	} catch (e) {
		const err = e as Error;
		stream.markdown(`\n\n❌ **Gemini Error**: ${err.message}`);
		// Record as FAIL
		peState.step_count++;
		log(`PE: Gemini step FAILED (${err.message})`);
		statusBar.updatePE(peState);
	}
}

// ── Inline Completion (Project Ghost-Text) ──────────────────────────────────
// Extracted to src/inline/ghostTextProvider.ts for clean FIM token handling.
// Uses ContextBuilder + QwenFarm.streamRawComplete for zero-latency completions.

// ── Commands ────────────────────────────────────────────────────────────────

async function handleStatusCommand(stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	stream.progress('Checking all models...');

	const farmStatus = await qwenFarm.getStatus();
	const coderHealth = await coderClient.healthCheck();

	let md = '## 🔥 Fusion Copilot Status\n\n';

	// Qwen Farm
	md += `### ⚡ Qwen 3.5 9B Farm\n`;
	md += `Online: **${farmStatus.onlineInstances}/${farmStatus.totalInstances}**\n\n`;
	for (const inst of farmStatus.instances) {
		const icon = inst.online ? '🟢' : '🔴';
		md += `${icon} Port ${inst.port} — ${inst.online ? `${inst.latencyMs}ms` : inst.error ?? 'offline'}\n\n`;
	}

	// Coder
	md += `### 🔧 Qwen3 Coder 80B MoE\n`;
	md += coderHealth.online
		? `🟢 Online — ${coderHealth.latencyMs}ms (${coderHealth.model ?? 'default'})\n\n`
		: `🔴 Offline — ${coderHealth.error}\n\n`;

	// Gemini
	md += `### 🧠 Gemini 2.5 Pro\n`;
	md += `⚪ Configured via API key\n\n`;

	// Memory
	md += `### 📚 Fusion Gate + Memory\n`;
	md += `MCP: Enabled (17+ tools)\n\n`;

	stream.markdown(md);
	return {};
}

async function selectModel(): Promise<void> {
	const items = [
		{ label: '⚡ Qwen 3.5 9B', description: 'Local, fastest', detail: 'Use for simple tasks and inline completions' },
		{ label: '🔧 Qwen3 Coder 80B', description: 'Local, Sonnet 4.5-level', detail: 'Use for serious coding and refactoring' },
		{ label: '🧠 Gemini 2.5 Pro', description: 'Cloud, 1M context', detail: 'Use for architecture and deep reasoning' },
		{ label: '🤖 Auto Router', description: 'Let Fusion decide', detail: 'Automatically picks the best model for each task' },
	];

	const selected = await vscode.window.showQuickPick(items, {
		title: 'Select AI Model',
		placeHolder: 'Choose a model or use auto-routing',
	});

	if (selected) {
		vscode.window.showInformationMessage(`Model: ${selected.label}`);
	}
}

async function toggleInline(): Promise<void> {
	const config = vscode.workspace.getConfiguration('fusion.copilot');
	const current = config.get<boolean>('inline.enabled', true);
	await config.update('inline.enabled', !current, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`Inline completions: ${!current ? 'ON' : 'OFF'}`);
}

async function configureGeminiKey(context: vscode.ExtensionContext): Promise<void> {
	const key = await vscode.window.showInputBox({
		title: 'Gemini API Key',
		prompt: 'Enter your Google AI Studio API key',
		password: true,
		placeHolder: 'AIza...',
	});
	if (key) {
		await context.secrets.store('fusion.copilot.geminiKey', key);
		vscode.window.showInformationMessage('✅ Gemini API key saved');
	}
}

async function launchFarm(): Promise<void> {
	const terminal = vscode.window.createTerminal({
		name: 'Fusion AI Farm',
		cwd: '/Users/ryyota/fusion-gate',
	});
	terminal.sendText('bash scripts/launch_qwen_farm.sh');
	terminal.show();
}
// ── Agent Manager: Slash Command Handlers ───────────────────────────────────

async function handleJulesCommand(prompt: string, stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!prompt.trim()) {
		stream.markdown('⚠️ Usage: `/jules <task description>`\n\nExample: `/jules Refactor the auth module to use JWT tokens`\n');
		return {};
	}

	stream.progress('📤 Submitting task to Jules...');
	log(`[jules] Submitting: ${prompt}`);

	const result = await orchestrator.jules.submitTask(prompt);
	if (result.success) {
		stream.markdown(`✅ **Task submitted to Jules!**\n\n> ${prompt}\n\n${result.output}\n\nJules will create a PR when done. Check with \`gh pr list\`.\n`);
	} else {
		stream.markdown(`❌ **Jules submission failed**\n\n\`\`\`\n${result.error}\n\`\`\`\n\n> Make sure \`jules\` CLI is installed: \`npm i -g @anthropic-ai/jules\`\n`);
	}
	return {};
}

async function handleDeepthinkCommand(prompt: string, stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!prompt.trim()) {
		stream.markdown('⚠️ Usage: `/deepthink <design question>`\n\nExample: `/deepthink Should we use microservices or monolith for this project?`\n');
		return {};
	}

	stream.markdown('## 🧠 DEEPTHINK\n\n');
	stream.progress('Engaging Gemini CLI deep reasoning...');
	log(`[deepthink] Query: ${prompt}`);

	const result = await orchestrator.gemini.deepthink(prompt);
	if (result.success) {
		stream.markdown(result.output);
	} else {
		stream.markdown(`❌ **DEEPTHINK failed**\n\n\`\`\`\n${result.error}\n\`\`\`\n\n> Make sure \`gemini\` CLI is installed and authenticated.\n`);
	}
	return {};
}

async function handleDeepsearchCommand(prompt: string, stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!prompt.trim()) {
		stream.markdown('⚠️ Usage: `/deepsearch <research query>`\n\nExample: `/deepsearch Best practices for KV cache optimization in transformer models`\n');
		return {};
	}

	stream.markdown('## 🔍 DEEPSEARCH\n\n');
	stream.progress('Engaging Gemini CLI deep search...');
	log(`[deepsearch] Query: ${prompt}`);

	const result = await orchestrator.gemini.deepsearch(prompt);
	if (result.success) {
		stream.markdown(result.output);
	} else {
		stream.markdown(`❌ **DEEPSEARCH failed**\n\n\`\`\`\n${result.error}\n\`\`\`\n\n> Make sure \`gemini\` CLI is installed and authenticated.\n`);
	}
	return {};
}

async function handleOrchestrateCommand(stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	stream.markdown('## 🎼 Full Orchestration Pipeline\n\n');
	log('[orchestrate] Starting full pipeline...');
	await orchestrator.fullPipeline(stream);
	return {};
}

// ── Palette Command Wrappers ────────────────────────────────────────────────

async function orchestrateFromPalette(): Promise<void> {
	vscode.window.showInformationMessage(
		'🎼 Orchestration started! Use @fusion /orchestrate in chat for full output.'
	);
	// Open chat panel with the orchestrate command pre-filled
	await vscode.commands.executeCommand('workbench.action.chat.open');
}

async function nightModeFromPalette(): Promise<void> {
	const confirm = await vscode.window.showWarningMessage(
		'🌙 Night Mode will analyze issues and submit tasks to Jules for overnight processing. Continue?',
		'Yes, activate Night Mode',
		'Cancel',
	);
	if (confirm === 'Yes, activate Night Mode') {
		vscode.window.showInformationMessage('🌙 Night Mode activated! Use @fusion /orchestrate in chat.');
		await vscode.commands.executeCommand('workbench.action.chat.open');
	}
}

// ── Health Check ────────────────────────────────────────────────────────────

async function runHealthCheck(): Promise<void> {
	try {
		const [farmStatus, coderHealth] = await Promise.all([
			qwenFarm.getStatus(),
			coderClient.healthCheck(),
		]);
		statusBar.update(farmStatus, coderHealth, true /* gemini assumed online */);
	} catch (err) {
		log(`Health check error: ${err}`);
	}
}

// ── Harvest Commands ────────────────────────────────────────────────────────

async function showSymbolInfo(filePath: string, symbolName: string): Promise<void> {
	const state = harvestEngine.getFileState(filePath);
	if (!state) {
		vscode.window.showInformationMessage(`No harvest data for ${symbolName}`);
		return;
	}

	const info = [
		`Symbol: ${symbolName}`,
		`File: ${filePath}`,
		`Content hash: ${state.lastHash}`,
		`Last harvest: ${new Date(state.lastHarvestTime).toLocaleString()}`,
		`Tracked symbols: ${state.lastSymbolNames.join(', ')}`,
	].join('\n');

	vscode.window.showInformationMessage(info, { modal: true });
}

// ── Deactivation ────────────────────────────────────────────────────────────

export function deactivate(): void {
	if (healthCheckInterval) { clearInterval(healthCheckInterval); }
	log('Fusion Copilot deactivated');
}
