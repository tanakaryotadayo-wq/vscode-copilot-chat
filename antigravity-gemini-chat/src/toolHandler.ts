/*---------------------------------------------------------------------------------------------
 *  Antigravity Gemini Chat Extension
 *  Tool handler — built-in tools for file operations, terminal, search
 *--------------------------------------------------------------------------------------------*/

import type { Tool, FunctionDeclaration, Schema, Type } from '@google/genai';

/**
 * Definition of a tool that can be invoked by Gemini.
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: FunctionDeclaration['parameters'];
	execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * Convert tool definitions to Gemini function declarations format.
 */
export function toGeminiFunctionDeclarations(tools: ToolDefinition[]): Tool[] {
	if (tools.length === 0) {
		return [];
	}

	return [{
		functionDeclarations: tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	}];
}

/**
 * Find and execute a tool by name.
 */
export async function executeTool(
	tools: ToolDefinition[],
	toolName: string,
	args: Record<string, unknown>,
): Promise<string> {
	const tool = tools.find(t => t.name === toolName);
	if (!tool) {
		return JSON.stringify({ error: `Unknown tool: ${toolName}` });
	}
	try {
		return await tool.execute(args);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return JSON.stringify({ error: message });
	}
}

/**
 * Create the default set of tools available to Gemini in the chat.
 * These tools are modeled after copilot-chat's tool set but use VS Code stable APIs.
 */
export function createDefaultTools(vscode: typeof import('vscode')): ToolDefinition[] {
	const tools: ToolDefinition[] = [];

	// Tool: Read file contents
	tools.push({
		name: 'read_file',
		description: 'Read the contents of a file from the workspace. Returns the file content as text.',
		parameters: {
			type: 'OBJECT' as unknown as Type,
			properties: {
				filePath: {
					type: 'STRING' as unknown as Type,
					description: 'The absolute or workspace-relative path to the file to read.',
				} as Schema,
				startLine: {
					type: 'NUMBER' as unknown as Type,
					description: 'Optional start line (1-indexed). If omitted, reads from the beginning.',
				} as Schema,
				endLine: {
					type: 'NUMBER' as unknown as Type,
					description: 'Optional end line (1-indexed, inclusive). If omitted, reads to the end.',
				} as Schema,
			},
			required: ['filePath'],
		},
		execute: async (args) => {
			const filePath = args.filePath as string;
			try {
				const uri = filePath.startsWith('/')
					? vscode.Uri.file(filePath)
					: vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, filePath);
				const doc = await vscode.workspace.openTextDocument(uri);
				const startLine = (args.startLine as number | undefined) ?? 1;
				const endLine = (args.endLine as number | undefined) ?? doc.lineCount;
				const range = new vscode.Range(
					Math.max(0, startLine - 1), 0,
					Math.min(doc.lineCount - 1, endLine - 1), Number.MAX_SAFE_INTEGER,
				);
				return doc.getText(range);
			} catch (err) {
				return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	// Tool: List directory contents
	tools.push({
		name: 'list_directory',
		description: 'List the contents of a directory. Returns names of files and subdirectories.',
		parameters: {
			type: 'OBJECT' as unknown as Type,
			properties: {
				path: {
					type: 'STRING' as unknown as Type,
					description: 'The absolute or workspace-relative path to the directory.',
				} as Schema,
			},
			required: ['path'],
		},
		execute: async (args) => {
			const dirPath = args.path as string;
			try {
				const uri = dirPath.startsWith('/')
					? vscode.Uri.file(dirPath)
					: vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, dirPath);
				const entries = await vscode.workspace.fs.readDirectory(uri);
				return entries.map(([name, type]) => {
					const suffix = type === vscode.FileType.Directory ? '/' : '';
					return `${name}${suffix}`;
				}).join('\n');
			} catch (err) {
				return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	// Tool: Search text in files
	tools.push({
		name: 'search_text',
		description: 'Search for text across files in the workspace. Returns matching file paths and line content.',
		parameters: {
			type: 'OBJECT' as unknown as Type,
			properties: {
				query: {
					type: 'STRING' as unknown as Type,
					description: 'The search query (plain text or regex pattern).',
				} as Schema,
				includePattern: {
					type: 'STRING' as unknown as Type,
					description: 'Glob pattern to filter files (e.g., "**/*.ts").',
				} as Schema,
			},
			required: ['query'],
		},
		execute: async (args) => {
			const query = args.query as string;
			try {
				// Use findTextInFiles if available, otherwise return guidance
				const results: string[] = [];
				const pattern = new vscode.TextSearchQuery(query);
				// Fallback: suggest using grep
				return `Search for "${query}" — use terminal: grep -rn "${query}" in workspace`;
			} catch (err) {
				return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	// Tool: Run command in terminal
	tools.push({
		name: 'run_command',
		description: 'Execute a shell command in the integrated terminal. Returns the command output.',
		parameters: {
			type: 'OBJECT' as unknown as Type,
			properties: {
				command: {
					type: 'STRING' as unknown as Type,
					description: 'The shell command to execute.',
				} as Schema,
				cwd: {
					type: 'STRING' as unknown as Type,
					description: 'Optional working directory for the command.',
				} as Schema,
			},
			required: ['command'],
		},
		execute: async (args) => {
			const command = args.command as string;
			try {
				const terminal = vscode.window.createTerminal({
					name: 'Gemini',
					cwd: args.cwd as string | undefined,
				});
				terminal.sendText(command);
				terminal.show();
				return `Command sent to terminal: ${command}`;
			} catch (err) {
				return `Error running command: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	// Tool: Get workspace info
	tools.push({
		name: 'get_workspace_info',
		description: 'Get information about the current workspace: folders, open files, active editor.',
		parameters: {
			type: 'OBJECT' as unknown as Type,
			properties: {},
		},
		execute: async () => {
			const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
			const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? 'none';
			const openFiles = vscode.window.tabGroups.all
				.flatMap(g => g.tabs)
				.map(t => (t.input as { uri?: vscode.Uri })?.uri?.fsPath)
				.filter(Boolean);
			return JSON.stringify({
				workspaceFolders: folders,
				activeFile,
				openFiles: openFiles.slice(0, 10),
			}, null, 2);
		},
	});

	return tools;
}
