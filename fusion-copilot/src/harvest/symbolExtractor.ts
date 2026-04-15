/*---------------------------------------------------------------------------------------------
 *  Semantic Harvest — Symbol Extractor
 *  Uses VS Code's built-in LSP to extract document symbols, call hierarchy,
 *  and dependency information. This is the "読む + 理解する" bridge.
 *
 *  Design: Extension is thin (extract + transform), Sidecar is thick (store + vectorize).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { SymbolInfo, DependencyInfo, CallEdge } from './sidecarClient.js';

/**
 * Extracts document symbols from a TextDocument using the LSP DocumentSymbol provider.
 * Returns a flat + nested tree of symbols suitable for Neural Packet ingestion.
 */
export async function extractSymbols(document: vscode.TextDocument): Promise<SymbolInfo[]> {
	const uri = document.uri;

	try {
		const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			uri,
		);

		if (!rawSymbols || rawSymbols.length === 0) {
			return [];
		}

		return rawSymbols.map(convertSymbol);
	} catch {
		// LSP not available for this language — degrade gracefully
		return [];
	}
}

/**
 * Builds a call graph for a specific symbol (function/method) using LSP Call Hierarchy.
 * Returns outgoing call edges from the given position.
 */
export async function extractCallGraph(
	document: vscode.TextDocument,
	symbols: SymbolInfo[],
): Promise<CallEdge[]> {
	const edges: CallEdge[] = [];
	const functions = flattenSymbols(symbols).filter(
		s => s.kind === 'Function' || s.kind === 'Method' || s.kind === 'Constructor',
	);

	// Limit to avoid LSP overload — process max 50 functions per file
	const batch = functions.slice(0, 50);

	for (const fn of batch) {
		try {
			const position = new vscode.Position(fn.range.startLine, 0);

			// Prepare call hierarchy
			const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
				'vscode.prepareCallHierarchy',
				document.uri,
				position,
			);

			if (!items || items.length === 0) { continue; }

			// Get outgoing calls
			const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
				'vscode.provideOutgoingCalls',
				items[0],
			);

			if (outgoing) {
				for (const call of outgoing) {
					edges.push({
						caller: {
							name: fn.name,
							filePath: document.uri.fsPath,
							line: fn.range.startLine,
						},
						callee: {
							name: call.to.name,
							filePath: call.to.uri.fsPath,
							line: call.to.range.start.line,
						},
					});
				}
			}
		} catch {
			// Call hierarchy not supported for this symbol — skip
			continue;
		}
	}

	return edges;
}

/**
 * Extracts import/require dependencies from a TypeScript/JavaScript document.
 * Uses regex for speed — no AST parser needed for import extraction.
 */
export function extractDependencies(document: vscode.TextDocument): DependencyInfo[] {
	const text = document.getText();
	const deps: DependencyInfo[] = [];

	// ES import: import { X, Y } from 'module'
	const esImportRegex = /import\s+(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;

	while ((match = esImportRegex.exec(text)) !== null) {
		const namedImports = match[1] ?? match[3] ?? '';
		const defaultImport = match[2] ?? '';
		const source = match[4];

		const specifiers = [
			...namedImports.split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean),
			...(defaultImport ? [defaultImport] : []),
		];

		deps.push({
			source,
			specifiers,
			isRelative: source.startsWith('.') || source.startsWith('/'),
		});
	}

	// Side-effect import: import 'module'
	const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
	while ((match = sideEffectRegex.exec(text)) !== null) {
		const source = match[1];
		// Skip if already captured by esImportRegex
		if (!deps.some(d => d.source === source)) {
			deps.push({
				source,
				specifiers: [],
				isRelative: source.startsWith('.') || source.startsWith('/'),
			});
		}
	}

	// CommonJS require: const X = require('module')
	const requireRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/g;
	while ((match = requireRegex.exec(text)) !== null) {
		const namedImports = match[1] ?? '';
		const defaultImport = match[2] ?? '';
		const source = match[3];

		const specifiers = [
			...namedImports.split(',').map(s => s.trim()).filter(Boolean),
			...(defaultImport ? [defaultImport] : []),
		];

		deps.push({
			source,
			specifiers,
			isRelative: source.startsWith('.') || source.startsWith('/'),
		});
	}

	// Python import (bonus — for polyglot support)
	if (document.languageId === 'python') {
		const pyImportRegex = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/gm;
		while ((match = pyImportRegex.exec(text)) !== null) {
			const source = match[1] ?? match[2].split(',')[0].trim().split(/\s+as\s+/)[0];
			const specifiers = match[2]
				.split(',')
				.map(s => s.trim().split(/\s+as\s+/)[0])
				.filter(Boolean);

			deps.push({
				source,
				specifiers,
				isRelative: source.startsWith('.'),
			});
		}
	}

	return deps;
}

/**
 * Compute a content hash for deduplication.
 * Uses a fast, non-cryptographic hash suitable for change detection.
 */
export function computeContentHash(text: string): string {
	// FNV-1a 32-bit hash — fast and good enough for change detection
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

// ── Internal Helpers ──────────────────────────────────────────────────────

function convertSymbol(sym: vscode.DocumentSymbol): SymbolInfo {
	return {
		name: sym.name,
		kind: vscode.SymbolKind[sym.kind],
		range: {
			startLine: sym.range.start.line,
			endLine: sym.range.end.line,
		},
		detail: sym.detail || undefined,
		children: sym.children.length > 0
			? sym.children.map(convertSymbol)
			: undefined,
	};
}

function flattenSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
	const result: SymbolInfo[] = [];
	for (const sym of symbols) {
		result.push(sym);
		if (sym.children) {
			result.push(...flattenSymbols(sym.children));
		}
	}
	return result;
}
