/*---------------------------------------------------------------------------------------------
 *  Fusion Copilot — Task Router
 *  Intelligent routing of user tasks to the optimal AI model.
 *  
 *  Analyzes input complexity, type, and context to decide whether to use:
 *  - Qwen 3.5 9B (fast, local): simple tasks, inline completions
 *  - Qwen3 Coder 80B MoE (coding, local): refactoring, code generation
 *  - Gemini 2.5 Pro (cloud): architecture, deep reasoning, large context
 *--------------------------------------------------------------------------------------------*/

export type ModelTarget = 'qwen-3.5-9b' | 'qwen3-coder-80b' | 'gemini-3.1-pro';

export interface TaskInput {
	type: 'chat' | 'inline_completion' | 'slash_command';
	prompt: string;
	command?: string;
	/** Number of files referenced or open */
	contextFileCount?: number;
	/** Estimated input token count */
	inputTokenEstimate?: number;
	/** Whether the prompt is primarily about code */
	isCodeHeavy?: boolean;
}

export interface RoutingDecision {
	target: ModelTarget;
	reason: string;
	confidence: number;
}

// Keywords that suggest code-heavy tasks
const CODE_KEYWORDS = [
	'refactor', 'リファクタ', 'implement', '実装',
	'fix', 'bug', 'バグ', 'debug', 'デバッグ',
	'test', 'テスト', 'write', '書いて',
	'function', '関数', 'class', 'クラス',
	'optimize', '最適化', 'performance', 'パフォーマンス',
	'lint', 'type', 'error', 'エラー',
];

// Keywords suggesting high complexity / deep reasoning
const REASONING_KEYWORDS = [
	'architecture', 'アーキテクチャ', 'design', '設計',
	'explain', '説明', 'why', 'なぜ', 'どうして',
	'compare', '比較', 'trade-off', 'トレードオフ',
	'review', 'レビュー', 'security', 'セキュリティ',
	'plan', 'プラン', '計画', 'strategy', '戦略',
	'migrate', 'マイグレーション', 'analyze', '分析',
];

// Keywords for simple tasks
const SIMPLE_KEYWORDS = [
	'rename', 'リネーム', 'comment', 'コメント',
	'format', 'フォーマット', 'import', 'インポート',
	'translate', '翻訳', 'summarize', '要約',
	'complete', '補完', 'suggest', 'サジェスト',
];

/**
 * Estimate the complexity of a task from 0.0 (trivial) to 1.0 (extremely complex).
 */
function estimateComplexity(input: TaskInput): number {
	let score = 0.5; // baseline

	const lowerPrompt = input.prompt.toLowerCase();

	// Short prompts are likely simpler
	if (input.prompt.length < 50) { score -= 0.2; }
	if (input.prompt.length > 500) { score += 0.15; }
	if (input.prompt.length > 2000) { score += 0.2; }

	// Check for keyword matches
	const hasCodeKeywords = CODE_KEYWORDS.some(kw => lowerPrompt.includes(kw));
	const hasReasoningKeywords = REASONING_KEYWORDS.some(kw => lowerPrompt.includes(kw));
	const hasSimpleKeywords = SIMPLE_KEYWORDS.some(kw => lowerPrompt.includes(kw));

	if (hasSimpleKeywords) { score -= 0.25; }
	if (hasCodeKeywords) { score += 0.1; }
	if (hasReasoningKeywords) { score += 0.25; }

	// Many referenced files suggest complexity
	if (input.contextFileCount && input.contextFileCount > 3) { score += 0.15; }
	if (input.contextFileCount && input.contextFileCount > 10) { score += 0.2; }

	return Math.max(0, Math.min(1, score));
}

/**
 * Detect if the prompt is primarily about code operations.
 */
function detectCodeHeavy(prompt: string): boolean {
	const lower = prompt.toLowerCase();

	// Contains code fences
	if (prompt.includes('```')) { return true; }

	// References file extensions
	if (/\.(ts|js|py|rs|go|java|cpp|c|rb|swift|kt)\b/.test(prompt)) { return true; }

	// Code keywords
	return CODE_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Route a task to the optimal AI model.
 */
export function routeTask(input: TaskInput): RoutingDecision {
	// ── Rule 1: Slash commands override auto-routing ──
	if (input.command) {
		switch (input.command) {
			case 'quick':
				return { target: 'qwen-3.5-9b', reason: '/quick command — forced local fast model', confidence: 1.0 };
			case 'code':
				return { target: 'qwen3-coder-80b', reason: '/code command — forced coding model', confidence: 1.0 };
			case 'think':
				return { target: 'gemini-3.1-pro', reason: '/think command — forced cloud reasoning', confidence: 1.0 };
		}
	}

	// ── Rule 2: Inline completions always go to Qwen 3.5 (fastest) ──
	if (input.type === 'inline_completion') {
		return { target: 'qwen-3.5-9b', reason: 'Inline completion — requires <50ms latency', confidence: 1.0 };
	}

	// ── Rule 3: Auto-route based on complexity analysis ──
	const isCodeHeavy = input.isCodeHeavy ?? detectCodeHeavy(input.prompt);
	const complexity = estimateComplexity({ ...input, isCodeHeavy });

	// Simple tasks → Qwen 3.5
	if (complexity < 0.35) {
		return {
			target: 'qwen-3.5-9b',
			reason: `Low complexity (${complexity.toFixed(2)}) — fast local model sufficient`,
			confidence: 0.8,
		};
	}

	// Code-focused medium tasks → Qwen3 Coder
	if (isCodeHeavy && complexity < 0.75) {
		return {
			target: 'qwen3-coder-80b',
			reason: `Code-heavy + medium complexity (${complexity.toFixed(2)}) — coding specialist`,
			confidence: 0.85,
		};
	}

	// Medium tasks without code focus → still try Coder if possible
	if (complexity < 0.65) {
		return {
			target: 'qwen3-coder-80b',
			reason: `Medium complexity (${complexity.toFixed(2)}) — local coding model`,
			confidence: 0.7,
		};
	}

	// High complexity → Gemini
	return {
		target: 'gemini-3.1-pro',
		reason: `High complexity (${complexity.toFixed(2)}) — cloud reasoning required`,
		confidence: 0.9,
	};
}

/**
 * Format a routing decision as a human-readable status string.
 */
export function formatDecision(decision: RoutingDecision): string {
	const icons: Record<ModelTarget, string> = {
		'qwen-3.5-9b': '⚡',
		'qwen3-coder-80b': '🔧',
		'gemini-3.1-pro': '🧠',
	};
	const names: Record<ModelTarget, string> = {
		'qwen-3.5-9b': 'Qwen 3.5 (Local)',
		'qwen3-coder-80b': 'Qwen3 Coder (Local)',
		'gemini-3.1-pro': 'Gemini 3.1 Pro (Cloud)',
	};
	return `${icons[decision.target]} → ${names[decision.target]}`;
}
