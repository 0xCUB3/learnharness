/**
 * Model-catalog contracts (model-control wave, 2026-09-12) — the client-safe
 * shapes of GET /api/models and PUT /api/chats/[id]/settings responses.
 * Pure types; the server projection lives in src/server/model-catalog.ts
 * (which OWNS these shapes — the contract is defined here only so client
 * components never import from the server band).
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BackgroundModelRole, ModelSlotName } from "../settings.ts";

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

/** One background role's RESOLVED pin (settings interlude, 2026-09-19):
 *  the user's agent-models override falling back to the config.ts MODELS
 *  pin — what that role actually runs today. The settings UI shows each
 *  agent-role row's "Default: <this>" caption from it. */
export type RolePins = Record<
	BackgroundModelRole,
	{ model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }
>;

/** One slot tier's RESOLVED pin (model slots wave, 2026-09-20): the
 *  strong/cheap/vision tier's concrete model — slot override falling back
 *  to the factory rep pin. The settings UI captions each slot row with it
 *  and the picker pre-fills from it. */
export type SlotPins = Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }>;

/** GET /api/models response. */
export interface ModelCatalogResponse {
	models: ModelCatalogEntry[];
	defaults: CatalogDefaults;
	/** The six background roles' resolved pins (same resolution the agent
	 *  factories use — src/server/stores.ts effectiveSettings). */
	rolePins: RolePins;
	/** The three slot tiers' resolved pins (model slots wave, 2026-09-20):
	 *  same resolution chain — role override → slot → factory pin — reported
	 *  at tier granularity; effectiveSettings().models verbatim. */
	slots: SlotPins;
	/** Providers with a PRESENT key, and which env var gates each — the
	 *  model slots wave's federation surface (2026-09-20): the picker lists
	 *  models from these providers' pi-ai catalogs only. Keyless providers
	 *  are simply absent (the Keys page is the discovery surface, same
	 *  discipline as the search engines). */
	providers: CatalogProvider[];
}

/** One row of the providers surface. */
export interface CatalogProvider {
	id: string;
	/** The env var whose presence federates this provider in. */
	envVar: string;
	/** Whether that var is currently present (env or auth file). */
	keyPresent: boolean;
}