/*---------------------------------------------------------------------------------------------
 *  Antigravity Gemini Chat Extension
 *  Extension entry point — Chat Participant registration & orchestration
 *  
 *  Fuses Copilot Chat's architecture patterns with Antigravity IDE capabilities.
 *  Uses ONLY stable VS Code APIs — no proposed API dependencies.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GeminiClient, type GeminiStreamChunk } from './geminiClient.js';
import { type ChatMessage } from './messageConverter.js';
import { createDefaultTools, executeTool, toGeminiFunctionDeclarations, type ToolDefinition } from './toolHandler.js';

const EXTENSION_ID = 'antigravity.gemini';
const API_KEY_SECRET = 'antigravity.gemini.apiKey';
const OUTPUT_CHANNEL_NAME = 'Antigravity Gemini';

let outputChannel: vscode.OutputChannel;
let geminiClient: GeminiClient | undefined;
let secretStorage: vscode.SecretStorage;

/**
 * System prompt that establishes Gemini's behavior in the Antigravity IDE context.
 */
function getSystemPrompt(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(', ') ?? 'none';
	const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? 'none';
	
	return `You are an expert AI coding assistant powered by Google Gemini, integrated into the Antigravity IDE (a VS Code-based development environment).

## Capabilities
- You can read files, list directories, search code, and run terminal commands through tool calling.
- You have deep understanding of programming languages, frameworks, and software architecture.
- You can analyze code, debug issues, suggest improvements, and write new code.

## Current Context
- Workspace folders: ${workspaceFolders}
- Active file: ${activeFile}
- IDE: Antigravity (VS Code-based)
- Time: ${new Date().toISOString()}

## Guidelines
- Be concise but thorough in your responses
- Use markdown formatting for code blocks and structured output
- When modifying code, show diffs or complete replacement snippets
- Proactively use tools to gather context before answering questions about the codebase
- If you need to see file contents, use the read_file tool
- Always consider the full context of the user's workspace
- Respond in the same language the user writes in
`;
}

/**
 * Activate the extension — register chat participant, commands, and initialize services.
 */
export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	secretStorage = context.secrets;
	
	log('Antigravity Gemini Chat extension activating...');

	// Initialize Gemini client from stored API key
	initializeClient(context).catch(err => {
		log(`Failed to initialize Gemini client: ${err}`);
	});

	// Register chat participant
	try {
		const participant = vscode.chat.createChatParticipant(EXTENSION_ID, handleChatRequest);
		participant.iconPath = new vscode.ThemeIcon('sparkle');
		context.subscriptions.push(participant);
		log('Chat participant registered successfully');
	} catch (err) {
		log(`Failed to register chat participant: ${err}. Falling back to command-based chat.`);
		// If chat API is not available, register command-based fallback
		registerFallbackCommands(context);
	}

	// Register configuration command
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity.gemini.configure', () => configureApiKey(context)),
	);

	// Register model selection command
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity.gemini.selectModel', selectModel),
	);

	// Watch for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('antigravity.gemini')) {
				log('Configuration changed, updating...');
			}
		}),
	);

	log('Antigravity Gemini Chat extension activated');
}

/**
 * Initialize the Gemini client from stored secrets.
 */
async function initializeClient(context: vscode.ExtensionContext): Promise<void> {
	const apiKey = await secretStorage.get(API_KEY_SECRET);
	if (apiKey) {
		geminiClient = new GeminiClient(apiKey);
		log('Gemini client initialized with stored API key');
	} else {
		log('No API key found. Use /configure or the command palette to set one.');
	}
}

/**
 * Main chat request handler — orchestrates the conversation with Gemini.
 */
async function handleChatRequest(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {

	// Handle slash commands
	if (request.command === 'configure') {
		await configureApiKey(undefined);
		stream.markdown('✅ API key configuration updated. You can now chat with Gemini.');
		return {};
	}

	if (request.command === 'models') {
		return await handleModelsCommand(stream, token);
	}

	// Ensure client is configured
	if (!geminiClient?.isConfigured) {
		stream.markdown('⚠️ **Gemini API key not configured.**\n\nUse `/configure` or run `Gemini: Configure API Key` from the command palette.');
		return {};
	}

	// Get configuration
	const config = vscode.workspace.getConfiguration('antigravity.gemini');
	const modelId = config.get<string>('model', 'gemini-2.5-pro');
	const enableThinking = request.command === 'think' || config.get<boolean>('enableThinking', true);
	const maxOutputTokens = config.get<number>('maxOutputTokens', 65536);
	const enableToolCalling = config.get<boolean>('enableToolCalling', true);

	// Build conversation history
	const messages = buildConversationHistory(request, context);

	// Prepare tools
	const vscodeModule = await import('vscode');
	const toolDefs = enableToolCalling ? createDefaultTools(vscodeModule) : [];
	const geminiTools = enableToolCalling ? toGeminiFunctionDeclarations(toolDefs) : [];

	// Abort controller for cancellation
	const abortController = new AbortController();
	const cancelSub = token.onCancellationRequested(() => {
		abortController.abort();
		log('Request cancelled by user');
	});

	try {
		// Show model info
		stream.progress(`Thinking with ${modelId}...`);

		let hasThinkingContent = false;
		let iterationCount = 0;
		const maxToolIterations = 10;
		let currentMessages = [...messages];

		// Tool calling loop — Gemini may request multiple tool calls
		while (iterationCount < maxToolIterations) {
			iterationCount++;
			let hasToolCalls = false;
			const pendingToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

			for await (const chunk of geminiClient.streamChat({
				model: modelId,
				messages: currentMessages,
				systemInstruction: getSystemPrompt(),
				tools: geminiTools,
				maxOutputTokens,
				enableThinking,
				abortSignal: abortController.signal,
			})) {
				if (token.isCancellationRequested) {
					break;
				}

				switch (chunk.type) {
					case 'thinking':
						if (chunk.text) {
							if (!hasThinkingContent) {
								hasThinkingContent = true;
								// Use progress for thinking content since we can't stream it separately
								stream.progress('Reasoning...');
							}
							log(`[thinking] ${chunk.text.substring(0, 200)}`);
						}
						break;
					case 'text':
						if (chunk.text) {
							stream.markdown(chunk.text);
						}
						break;
					case 'tool_call':
						if (chunk.toolCall) {
							hasToolCalls = true;
							pendingToolCalls.push(chunk.toolCall);
							log(`[tool_call] ${chunk.toolCall.name}(${JSON.stringify(chunk.toolCall.args)})`);
							stream.progress(`🔧 Using tool: ${chunk.toolCall.name}`);
						}
						break;
					case 'usage':
						if (chunk.usage) {
							log(`[usage] prompt=${chunk.usage.promptTokens} completion=${chunk.usage.completionTokens} thinking=${chunk.usage.thinkingTokens} total=${chunk.usage.totalTokens}`);
						}
						break;
				}
			}

			// If no tool calls, we're done
			if (!hasToolCalls || token.isCancellationRequested) {
				break;
			}

			// Execute tool calls and feed results back
			for (const tc of pendingToolCalls) {
				const result = await executeTool(toolDefs, tc.name, tc.args);
				log(`[tool_result] ${tc.name}: ${result.substring(0, 500)}`);

				// Add tool call and result to conversation for next iteration
				currentMessages.push({
					role: 'assistant',
					content: '',
					toolCalls: [tc],
				});
				currentMessages.push({
					role: 'user',
					content: '',
					toolResults: [{
						callId: tc.name,
						content: result,
					}],
				});
			}
		}

		return {};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes('AbortError') || token.isCancellationRequested) {
			log('Request aborted');
			return {};
		}
		log(`Error during chat: ${message}`);
		stream.markdown(`\n\n❌ **Error:** ${message}`);
		return {};
	} finally {
		cancelSub.dispose();
	}
}

/**
 * Build conversation history from the chat context.
 */
function buildConversationHistory(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
): ChatMessage[] {
	const messages: ChatMessage[] = [];

	// Include previous turns from the conversation
	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push({
				role: 'user',
				content: turn.prompt,
			});
		} else if (turn instanceof vscode.ChatResponseTurn) {
			// Extract text from response parts
			const parts: string[] = [];
			for (const part of turn.response) {
				if (part instanceof vscode.ChatResponseMarkdownPart) {
					parts.push(part.value.value);
				}
			}
			if (parts.length > 0) {
				messages.push({
					role: 'assistant',
					content: parts.join(''),
				});
			}
		}
	}

	// Add the current request
	let userPrompt = request.prompt;

	// Include referenced files/selections if any
	if (request.references && request.references.length > 0) {
		const refTexts: string[] = [];
		for (const ref of request.references) {
			if (ref.value instanceof vscode.Uri) {
				refTexts.push(`[Referenced file: ${ref.value.fsPath}]`);
			} else if (ref.value instanceof vscode.Location) {
				refTexts.push(`[Referenced location: ${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}]`);
			}
		}
		if (refTexts.length > 0) {
			userPrompt = `${refTexts.join('\n')}\n\n${userPrompt}`;
		}
	}

	messages.push({
		role: 'user',
		content: userPrompt,
	});

	return messages;
}

/**
 * Handle /models command — list available Gemini models.
 */
async function handleModelsCommand(
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
	if (!geminiClient?.isConfigured) {
		stream.markdown('⚠️ **API key not configured.** Use `/configure` first.');
		return {};
	}

	try {
		stream.progress('Fetching available models...');
		const models = await geminiClient.listModels();
		
		const modelList = models
			.filter(m => m.id.includes('gemini'))
			.map(m => `- **${m.id}** — ${m.displayName}`)
			.join('\n');
		
		const currentModel = vscode.workspace.getConfiguration('antigravity.gemini').get<string>('model', 'gemini-2.5-pro');
		stream.markdown(`## Available Gemini Models\n\nCurrent: **${currentModel}**\n\n${modelList}\n\n_Use \`Gemini: Select Model\` from the command palette to change._`);
	} catch (err) {
		stream.markdown(`❌ Error fetching models: ${err instanceof Error ? err.message : String(err)}`);
	}

	return {};
}

/**
 * Configure the Gemini API key via input prompt.
 */
async function configureApiKey(context: vscode.ExtensionContext | undefined): Promise<void> {
	const existingKey = await secretStorage.get(API_KEY_SECRET);
	
	const apiKey = await vscode.window.showInputBox({
		title: 'Gemini API Key',
		prompt: existingKey
			? 'Enter a new Gemini API key (leave empty to clear)'
			: 'Enter your Google AI Studio API key (from https://aistudio.google.com/apikey)',
		password: true,
		placeHolder: 'AIza...',
		ignoreFocusOut: true,
	});

	if (apiKey === undefined) {
		// Cancelled
		return;
	}

	if (apiKey === '') {
		// Clear key
		await secretStorage.delete(API_KEY_SECRET);
		geminiClient = undefined;
		vscode.window.showInformationMessage('Gemini API key cleared.');
		log('API key cleared');
		return;
	}

	// Store and initialize
	await secretStorage.store(API_KEY_SECRET, apiKey);
	geminiClient = new GeminiClient(apiKey);
	vscode.window.showInformationMessage('✅ Gemini API key configured successfully!');
	log('API key updated');
}

/**
 * Select a Gemini model from quick pick.
 */
async function selectModel(): Promise<void> {
	const config = vscode.workspace.getConfiguration('antigravity.gemini');
	const currentModel = config.get<string>('model', 'gemini-2.5-pro');

	const models = [
		{ label: 'gemini-2.5-pro', description: 'Most capable, thinking model', detail: '1M context, thinking' },
		{ label: 'gemini-2.5-flash', description: 'Fast with thinking', detail: '1M context, thinking' },
		{ label: 'gemini-2.0-flash', description: 'Fast and efficient', detail: '1M context' },
		{ label: 'gemini-2.0-flash-lite', description: 'Lightweight', detail: '128K context' },
	];

	// Mark current model
	const items = models.map(m => ({
		...m,
		label: m.label === currentModel ? `$(check) ${m.label}` : m.label,
		picked: m.label === currentModel,
	}));

	const selected = await vscode.window.showQuickPick(items, {
		title: 'Select Gemini Model',
		placeHolder: `Current: ${currentModel}`,
	});

	if (selected) {
		const modelId = selected.label.replace('$(check) ', '');
		await config.update('model', modelId, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Model set to: ${modelId}`);
		log(`Model changed to ${modelId}`);
	}
}

/**
 * Fallback: register commands for non-chat-API environments.
 */
function registerFallbackCommands(context: vscode.ExtensionContext): void {
	log('Chat API not available — registering WebView fallback');
	
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity.gemini.openChat', async () => {
			// Create a simple output-based chat as fallback
			const input = await vscode.window.showInputBox({
				title: 'Gemini Chat',
				prompt: 'Enter your message',
				placeHolder: 'Ask Gemini anything...',
			});

			if (!input || !geminiClient?.isConfigured) {
				return;
			}

			outputChannel.show();
			outputChannel.appendLine(`\n👤 User: ${input}`);
			outputChannel.appendLine(`🤖 Gemini:`);

			try {
				for await (const chunk of geminiClient.streamChat({
					model: vscode.workspace.getConfiguration('antigravity.gemini').get<string>('model', 'gemini-2.5-pro'),
					messages: [{ role: 'user', content: input }],
					systemInstruction: getSystemPrompt(),
					enableThinking: true,
				})) {
					if (chunk.type === 'text' && chunk.text) {
						outputChannel.append(chunk.text);
					}
				}
				outputChannel.appendLine('\n');
			} catch (err) {
				outputChannel.appendLine(`\n❌ Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	);
}

/**
 * Utility: log to output channel with timestamp.
 */
function log(message: string): void {
	const timestamp = new Date().toISOString().slice(11, 23);
	outputChannel?.appendLine(`[${timestamp}] ${message}`);
}

/**
 * Deactivate the extension.
 */
export function deactivate(): void {
	log('Antigravity Gemini Chat extension deactivated');
}
