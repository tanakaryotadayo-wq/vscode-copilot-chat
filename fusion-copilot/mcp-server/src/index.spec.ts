/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { PerfectBalanceEngine, resolveRepoContext } from './index.js';

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		existsSync: vi.fn(),
	};
});

describe('resolveRepoContext', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('should default to current directory when repo is undefined', () => {
		expect(resolveRepoContext()).toEqual({ repoValue: '.' });
	});

	it('should return current directory when repo is "."', () => {
		expect(resolveRepoContext('.')).toEqual({ repoValue: '.' });
	});

	it('should return cwd when repo is an existing local path', () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		expect(resolveRepoContext('/local/path')).toEqual({ repoValue: '/local/path', cwd: '/local/path' });
	});

	it('should return ghRepo when repo is not an existing local path', () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		expect(resolveRepoContext('owner/repo')).toEqual({ repoValue: 'owner/repo', ghRepo: 'owner/repo' });
	});
});

describe('PerfectBalanceEngine', () => {
	let engine: PerfectBalanceEngine;

	beforeEach(() => {
		engine = new PerfectBalanceEngine('claude_sonnet');
	});

	describe('Initialization and Configuration', () => {
		it('should initialize with correct default preset', () => {
			const status = engine.getStatus();
			expect(status.model).toBe('Claude Sonnet');
			expect(status.e_base).toBe(0.04);
			expect(status.c_psi_base).toBe(0.75);
			expect(status.karma).toBe(1.0);
		});

		it('should allow custom configuration', () => {
			engine.configure(0.05, 0.8, 0.01);
			const status = engine.getStatus();
			expect(status.e_base).toBe(0.05);
			expect(status.c_psi_base).toBe(0.8);
			expect(status.context_decay).toBe(0.01);
		});
	});

	describe('Step Recording and State Evaluation', () => {
		it('should record a PASS step and maintain STABLE/EVOLVING status', () => {
			const record = engine.recordStep('PASS');
			expect(record.step).toBe(1);
			expect(record.weight).toBe(1);
			expect(record.audit_result).toBe('PASS');
			expect(['EVOLVING', 'STABLE']).toContain(record.status);
		});

		it('should detect sabotage on 3 consecutive FAILs', () => {
			engine.recordStep('FAIL');
			engine.recordStep('FAIL');
			const record = engine.recordStep('FAIL');

			expect(record.status).toBe('SABOTAGE_DETECTED');
			const status = engine.getStatus();
			expect(status.sabotage_events).toBe(1);
			expect(status.karma).toBeLessThan(1.0);
		});

		it('should detect sabotage on >50% fail rate over 5 steps', () => {
			engine.recordStep('FAIL');
			engine.recordStep('PASS');
			engine.recordStep('FAIL');
			engine.recordStep('PASS');
			const record = engine.recordStep('FAIL'); // 3 fails out of 5

			expect(record.status).toBe('SABOTAGE_DETECTED');
			const status = engine.getStatus();
			expect(status.sabotage_events).toBe(1);
		});

		it('should handle weighted steps correctly', () => {
			engine.recordStep('PASS', 5);
			const status = engine.getStatus();
			expect(status.step_count).toBe(5);
			expect(status.weighted_steps).toBe(5);
		});

		it('should degrade effective c_psi with higher complexity', () => {
			const recordLow = engine.recordStep('PASS', 1, 0);
			const cPsiLow = recordLow.c_psi_effective;

			engine.reset('human');

			const recordHigh = engine.recordStep('PASS', 1, 10);
			expect(recordHigh.c_psi_effective).toBeLessThan(cPsiLow);
		});
	});

	describe('VP Layer Scores (Dynamic C_ψ)', () => {
		it('should use static C_ψ_base when no layer_scores provided', () => {
			const record = engine.recordStep('PASS', 1, 2);
			// C_ψ_eff = 0.75 * (1 / (1 + 2*0.1)) * 1.0 = 0.75 * 0.8333 = 0.625
			expect(record.c_psi_effective).toBeCloseTo(0.625, 3);
		});

		it('should calculate dynamic C_ψ from VP layer scores', () => {
			const layer_scores = { l0: 0.95, l1: 0.88, l2: 0.72, l3: 0.6, l4: 0.85 };
			const record = engine.recordStep('PASS', 1, 2, layer_scores);
			// base = 1 - (0.05 * 0.12 * 0.28 * 0.40 * 0.15) = 1 - 0.00002520 ≈ 0.99997
			// C_ψ_eff = 0.99997 * (1/1.2) * 1.0 ≈ 0.8333
			expect(record.c_psi_effective).toBeGreaterThan(0.625); // must exceed static
		});

		it('should return zero C_ψ when all VP layers are zero', () => {
			const layer_scores = { l0: 0, l1: 0, l2: 0, l3: 0, l4: 0 };
			const record = engine.recordStep('PASS', 1, 0, layer_scores);
			// base = 1 - (1*1*1*1*1) = 0, so C_ψ_eff = 0
			expect(record.c_psi_effective).toBe(0);
		});

		it('should return perfect C_ψ when all VP layers are 1.0', () => {
			const layer_scores = { l0: 1, l1: 1, l2: 1, l3: 1, l4: 1 };
			const record = engine.recordStep('PASS', 1, 0, layer_scores);
			// base = 1 - 0 = 1.0, C_ψ_eff = 1.0 * 1.0 * 1.0 = 1.0
			expect(record.c_psi_effective).toBe(1.0);
		});

		it('should produce lower correction with weak VP scores than static preset', () => {
			const staticRecord = engine.recordStep('PASS', 1, 2);
			engine.reset('human');
			const weakVP = { l0: 0.3, l1: 0.2, l2: 0.1, l3: 0.0, l4: 0.1 };
			const dynamicRecord = engine.recordStep('PASS', 1, 2, weakVP);
			expect(dynamicRecord.c_psi_effective).toBeLessThan(staticRecord.c_psi_effective);
		});

		it('should produce lower P_hall with strong VP than without', () => {
			// 10 steps without VP
			const noVP = new PerfectBalanceEngine('gemini_pro');
			for (let i = 0; i < 10; i++) {
				noVP.recordStep('PASS', 1, 2);
			}

			// 10 steps with strong VP
			const withVP = new PerfectBalanceEngine('gemini_pro');
			const vp = { l0: 0.95, l1: 0.88, l2: 0.72, l3: 0.6, l4: 0.85 };
			for (let i = 0; i < 10; i++) {
				withVP.recordStep('PASS', 1, 2, vp);
			}

			expect(withVP.getStatus().p_hall).toBeLessThan(noVP.getStatus().p_hall);
		});

		it('should degrade dynamic C_ψ with low karma', () => {
			// Trigger karma penalty: unauthorized reset attempt
			engine.reset('hacker');

			const layer_scores = { l0: 0.95, l1: 0.88, l2: 0.72, l3: 0.6, l4: 0.85 };
			const record = engine.recordStep('PASS', 1, 0, layer_scores);

			// Clean engine for comparison
			const clean = new PerfectBalanceEngine('claude_sonnet');
			const cleanRecord = clean.recordStep('PASS', 1, 0, layer_scores);

			expect(record.c_psi_effective).toBeLessThan(cleanRecord.c_psi_effective);
		});

		it('should handle partial layer scores (missing layers default to 0)', () => {
			const partial = { l0: 0.9, l2: 0.8 }; // l1, l3, l4 missing → 0
			const record = engine.recordStep('PASS', 1, 0, partial);
			// base = 1 - (0.1 * 1.0 * 0.2 * 1.0 * 1.0) = 1 - 0.02 = 0.98
			expect(record.c_psi_effective).toBeCloseTo(0.98, 2);
		});
	});

	describe('Reset and ACL', () => {
		it('should allow reset from authorized caller', () => {
			engine.recordStep('PASS');
			const result = engine.reset('human');
			expect(result.success).toBe(true);
			expect(engine.getStatus().step_count).toBe(0);
		});

		it('should deny reset from unauthorized caller and penalize karma', () => {
			const initialKarma = engine.getStatus().karma;
			const result = engine.reset('hacker');
			expect(result.success).toBe(false);

			const status = engine.getStatus();
			expect(status.sabotage_events).toBe(1);
			expect(status.karma).toBeLessThan(initialKarma);
		});
	});
});
