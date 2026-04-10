/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AbstractDocumentWithLanguageId } from '../../../../../platform/editing/common/abstractText';
import { CachedFunction } from '../../../../../util/vs/base/common/cache';
import { ICostFnFactory, RemovableNode } from './implementation';

const SUPPORTED_LANGUAGE_IDS = new Set([
	'typescript',
	'typescriptreact',
	'javascript',
	'javascriptreact',
	'java',
	'csharp',
	'cpp',
]);

const STRUCTURE_KINDS = new Set([
	'class_declaration',
	'class_specifier',
	'constructor',
	'enum_declaration',
	'field_definition',
	'function_declaration',
	'interface_declaration',
	'lexical_declaration',
	'method_declaration',
	'method_definition',
	'method_signature',
	'property_signature',
	'public_field_definition',
	'type_alias_declaration',
	'variable_declaration',
]);

const BODY_KINDS = new Set([
	'block',
	'compound_statement',
	'function_body',
	'statement_block',
]);

const STRUCTURE_MULTIPLIER = 0.45;
const BODY_MULTIPLIER = 6;

/**
 * Biases summarization toward API surface / declaration headers and away from implementation bodies.
 */
export const astNavTreeCostFn: ICostFnFactory<AbstractDocumentWithLanguageId> = {
	createCostFn(doc) {
		if (!SUPPORTED_LANGUAGE_IDS.has(doc.languageId)) {
			return (_node, currentCost) => currentCost;
		}

		const nodeMultiplier: CachedFunction<RemovableNode, number> = new CachedFunction(node => {
			const parentMultiplier = node.parent ? nodeMultiplier.get(node.parent) : 1;
			if (BODY_KINDS.has(node.kind)) {
				return parentMultiplier * BODY_MULTIPLIER;
			}
			if (STRUCTURE_KINDS.has(node.kind)) {
				return parentMultiplier * STRUCTURE_MULTIPLIER;
			}
			return parentMultiplier;
		});

		return (node, currentCost) => {
			if (!node) {
				return currentCost;
			}
			return currentCost * nodeMultiplier.get(node);
		};
	},
};
