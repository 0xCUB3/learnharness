/**
 * Model-catalog contracts (model-control wave, 2026-09-12) — the client-safe
 * shapes of GET /api/models and PUT /api/chats/[id]/settings responses.
 * Pure types; the server projection lives in src/server/model-catalog.ts
 * (which OWNS these shapes — the contract is defined here only so client
 * components never import from the server band).
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** One picker row: everything the UI shows about a model, projected from
 *  pi-ai's catalog. Costs are USD per 1M tokens (the same catalog, the same
 *  units core/prices.ts's generated table carries). */
export interface ModelCatalogEntry {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/** The thinking levels this model actually accepts (pi's
	 * thinkingLevelMap — e.g. GLM-5.3-flash: low|high|max). The thinking
	 * picker lists exactly these; anything else is a lie. */
	supportedLevels: ThinkingLevel[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** The conversation agents' config pin (config.ts MODELS prober/teacher —
 *  one controller, so one pin): what a chat without settings runs. */
export interface CatalogDefaults {
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
}

/** GET /api/models response. */
export interface ModelCatalogResponse {
	models: ModelCatalogEntry[];
	defaults: CatalogDefaults;
}