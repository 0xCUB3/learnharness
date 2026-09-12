/**
 * The model catalog's server surface (model-control wave, 2026-09-12):
 * pi-ai's shipped OpenRouter catalog projected to client-safe DTOs for the
 * picker (GET /api/models), plus the validation gate for per-chat settings
 * (PUT /api/chats/[id]/settings).
 *
 * pi-ai owns ALL the data: the catalog (id/name/cost/context/modality/
 * thinkingLevelMap) and the per-model thinking truth
 * (getSupportedThinkingLevels / clampThinkingLevel). This module only
 * projects and validates — no second registry to drift out of sync.
 *
 * Multi-provider future: `getModels()` is called per configured provider,
 * so a second provider (pi-ai ships ~30) appears in the picker by adding
 * it to piModels() in src/agent/models.ts — nothing here changes.
 */

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MODELS } from "../../config.ts";
import { piModels } from "../agent/models.ts";
import type { ChatSettings } from "../core/contracts/chat.ts";
import type {
	CatalogDefaults,
	ModelCatalogEntry,
	ModelCatalogResponse,
} from "../core/contracts/models.ts";

/** The picker's client-safe model entry (contract: core/contracts/models.ts). */
export type ModelDto = ModelCatalogEntry;

/** The conversation agents' config pin — what a settings-less chat runs. */
export function catalogDefaults(): CatalogDefaults {
	return {
		model: { provider: "openrouter", id: MODELS.prober.model },
		thinkingLevel: MODELS.prober.effort as ThinkingLevel,
	};
}

/** Project one catalog model to the client DTO. */
export function toModelDto(model: Model<Api>): ModelDto {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		supportedLevels: getSupportedThinkingLevels(model),
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** The full picker payload: every model of every configured provider
 *  (sorted by provider then id — stable, diff-friendly) + the config
 *  defaults a settings-less chat runs. */
export function modelCatalog(): ModelCatalogResponse {
	const models = piModels()
		.getProviders()
		.flatMap((p) => piModels().getModels(p.id))
		.map(toModelDto)
		.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
	return { models, defaults: catalogDefaults() };
}

/** One validated outcome for a settings write. */
export type SettingsValidation =
	| { ok: true }
	| { ok: false; error: string; supported?: ThinkingLevel[] };

/** Validate a picker write against the catalog (the settings route's gate).
 *  `settings` is replace-whole: absent fields mean "config default".
 *  - model: provider must be configured, id must exist in its catalog.
 *  - thinkingLevel: must be in the resolved model's supported list —
 *    the model the picker writes against (settings.model, else config's
 *    prober/teacher pin; one controller, so the two specs share it). */
export function validateChatSettings(settings: ChatSettings): SettingsValidation {
	const providers = piModels().getProviders().map((p) => p.id);
	if (settings.model) {
		const { provider, id } = settings.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!piModels().getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	if (settings.thinkingLevel !== undefined) {
		const provider = settings.model?.provider ?? "openrouter";
		const id = settings.model?.id ?? MODELS.prober.model;
		const model = piModels().getModel(provider, id);
		if (!model) return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(settings.thinkingLevel)) {
			return {
				ok: false,
				error: `${id} does not support thinking level "${settings.thinkingLevel}"`,
				supported,
			};
		}
	}
	return { ok: true };
}