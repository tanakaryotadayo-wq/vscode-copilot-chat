/*---------------------------------------------------------------------------------------------
 *  Semantic Harvest — Module Index
 *  Barrel export for the harvest subsystem.
 *--------------------------------------------------------------------------------------------*/

export { SidecarClient } from './sidecarClient.js';
export type {
	SidecarConfig,
	HarvestPayload,
	SymbolInfo,
	DependencyInfo,
	CallEdge,
	SemanticDeltaPayload,
	SidecarResponse,
} from './sidecarClient.js';

export {
	extractSymbols,
	extractCallGraph,
	extractDependencies,
	computeContentHash,
} from './symbolExtractor.js';

export { HarvestEngine } from './harvestEngine.js';
export type { HarvestEngineOptions, HarvestEvent } from './harvestEngine.js';

export { PacketExplorer } from './packetExplorer.js';

export { SemanticDiffLensProvider } from './semanticDiffLens.js';
