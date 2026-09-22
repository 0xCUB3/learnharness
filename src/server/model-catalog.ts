/**
 * The model catalog's server surface (model-control wave, 2026-09-12;
 * federated since the model-slots wave, 2026-09-20): pi-ai's catalog for
 * every KEYED provider, projected to client-safe DTOs for the picker (GET
 * /api/models), plus the validation gate for settings writes (PUT
 * /api/settings/* — the per-chat settings PUT is retired from the UI;
 * legacy records' per-chat overrides still resolve server-side).
 *
 * pi-ai owns ALL the data: the catalog (id/name/cost/context/modality/
 * thinkingLevelMap) and the per-model thinking truth
 * (getSupportedThinkingLevels / clampThinkingLevel). This module only
 * projects and validates — no second registry to drift out of sync.
 *
 * Federation: `getModels()` is called per keyed provider (federated, the
 * model-slots wave), so a provider appears in the picker exactly when its
 * key is present — piModels() in src/agent/models.ts owns the provider
 * set; nothing here changes.
 */

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { piModels } from "../agent/models.ts";
import { settingsStore } from "../store/settings.ts";
import { effectiveSettings } from "./stores.ts";
import { keyValue } from "./keys.ts";
import type { ChatSettings } from "../core/contracts/chat.ts";
import type {
	CatalogDefaults,
	CatalogProvider,
	ModelCatalogEntry,
	ModelCatalogResponse,
	RolePins,
	SlotPins,
} from "../core/contracts/models.ts";
import type { EffectiveModelSpec, EffectiveSlot } from "../core/settings-resolution.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import { BACKGROUND_MODEL_ROLES, type BackgroundModelRole, type ModelSlotName, type ModelsSettings } from "../core/settings.ts";

/** The picker's client-safe model entry (contract: core/contracts/models.ts). */
export type ModelDto = ModelCatalogEntry;

/** The conversation agents' resolved default pin (pure form — the record's
 *  chat section in, CatalogDefaults out; `catalogDefaults()` below is the
 *  fs wrapper). Absent fields (or no record — BYOK first boot) fall back
 *  to the config pin, exactly as before. */
export function catalogDefaultsFor(chat: ChatSettings | undefined, strong: EffectiveSlot): CatalogDefaults {
	return {
		model: chat?.model ?? { provider: strong.provider, id: strong.id },
		thinkingLevel: chat?.thinkingLevel ?? strong.thinkingLevel,
	};
}

/** The conversation agents' config pin — what a settings-less chat runs.
 *  (settings-storage wave, 2026-09-19): the user's picked default rides in
 *  the settings record's `chat` section; the picker's defaults row shows
 *  it once chosen. */
export function catalogDefaults(): CatalogDefaults {
	return catalogDefaultsFor(settingsStore.readSettings()?.chat, effectiveSettings().models.strong);
}

/** Project the resolved per-role specs to the client DTO (pure — the
 *  settings UI's "Default: <actual pinned model>" caption reads this).
 *  thinkingLevel is always concrete in the resolved view; the contract
 *  keeps it optional so the UI tolerates a future role without one. */
export function rolePinsFor(models: Record<BackgroundModelRole, EffectiveModelSpec>): RolePins {
	const pins = {} as RolePins;
	for (const role of BACKGROUND_MODEL_ROLES) {
		const spec = models[role];
		pins[role] = {
			model: { provider: spec.provider, id: spec.id },
			thinkingLevel: spec.thinkingLevel,
		};
	}
	return pins;
}

/** The six background roles' RESOLVED pins (settings interlude,
 *  2026-09-19): the user's agent-models override falling back to the
 *  config.ts MODELS pin — the same resolution the agent factories use
 *  (src/server/stores.ts effectiveSettings), so the caption can never
 *  drift from what actually runs. */
export function catalogRolePins(): RolePins {
	return rolePinsFor(effectiveSettings().agent.models);
}

/** The three slot tiers' RESOLVED pins (model slots wave, 2026-09-20) —
 *  effectiveSettings().models verbatim: slot over factory rep pin, the
 *  same resolution the engine wiring uses, so the Models settings page's
 *  captions cannot drift from what actually runs. */
export function catalogSlots(): SlotPins {
	const slots = effectiveSettings().models;
	const pins = {} as SlotPins;
	for (const name of ["strong", "cheap", "vision"] as const) {
		const slot: EffectiveSlot = slots[name];
		pins[name] = {
			model: { provider: slot.provider, id: slot.id },
			thinkingLevel: slot.thinkingLevel,
		};
	}
	return pins;
}

/** The providers surface (model slots wave, 2026-09-20): one row per
 *  plain-key model provider (core/auth-keys.ts's pi-ai-derived table),
 *  with keyPresent read env-wins through the keys seam, fresh per call —
 *  saving a key immediately federates the provider into the picker. */
export function catalogProviders(): CatalogProvider[] {
	return AUTH_PROVIDER_KEYS.map((p) => ({
		id: p.id,
		envVar: p.envVar,
		keyPresent: keyValue(p.envVar) !== undefined,
	})).sort((a, b) => a.id.localeCompare(b.id));
}

/** The providers whose key is present — the picker federates exactly
 *  these (a keyless provider's models are unreachable by design; the
 *  Keys page is the discovery surface, same discipline as search). */
function keyedProviderIds(): Set<string> {
	return new Set(catalogProviders().filter((p) => p.keyPresent).map((p) => p.id));
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
 *  defaults a settings-less chat runs + the background roles' resolved
 *  pins (the settings UI's per-role default captions). */
export function modelCatalog(): ModelCatalogResponse {
	const keyed = keyedProviderIds();
	const models = piModels()
		.getProviders()
		.filter((p) => keyed.has(p.id))
		.flatMap((p) => piModels().getModels(p.id))
		.map(toModelDto)
		.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
	return {
		models,
		defaults: catalogDefaults(),
		rolePins: catalogRolePins(),
		slots: catalogSlots(),
		providers: catalogProviders(),
	};
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
		// The conversation chain's fallback is the strong slot (model slots
		// wave, 2026-09-20) — the model a settings-less chat would run.
		const strong = effectiveSettings().models.strong;
		const provider = settings.model?.provider ?? strong.provider;
		const id = settings.model?.id ?? strong.id;
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
/** Validate a models-section write (PUT /api/settings/models) against the
 *  catalog — the same gate the chat section gets. Model swaps must name a
 *  real provider+model; a thinkingLevel must be supported by the model the
 *  slot would resolve to (the slot's own model, else the factory rep pin).
 *  keyPresent is NOT gated here (a stored pin for a provider whose key
 *  lapsed stays valid — it fails honestly at stream time, and the picker
 *  stops offering it). */
export function validateModelsSettings(settings: ModelsSettings): SettingsValidation {
	for (const name of ["strong", "cheap", "vision"] as const) {
		const slot = settings[name];
		if (!slot) continue;
		const verdict = validateSlotSpec(name, slot);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

function validateSlotSpec(name: ModelSlotName, slot: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }): SettingsValidation {
	const providers = piModels().getProviders().map((p) => p.id);
	if (slot.model) {
		const { provider, id } = slot.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!piModels().getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	if (slot.thinkingLevel !== undefined) {
		const provider = slot.model?.provider ?? effectiveSettings().models[name].provider;
		const id = slot.model?.id ?? effectiveSettings().models[name].id;
		const model = piModels().getModel(provider, id);
		if (!model) return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(slot.thinkingLevel)) {
			return {
				ok: false,
				error: `${id} does not support thinking level "${slot.thinkingLevel}"`,
				supported,
			};
		}
	}
	return { ok: true };
}
