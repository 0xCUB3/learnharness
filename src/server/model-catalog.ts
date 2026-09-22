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

/** The conversation agents' resolved default (pure form — the record's chat
 *  section + the strong slot in, CatalogDefaults out; `catalogDefaults()`
 *  below is the fs wrapper). BYOK (owner, 2026-09-22): there is no factory
 *  floor — when neither the chat section nor the strong slot names a
 *  model, the default is NULL and the turn gate refuses with the 503
 *  models_not_configured envelope. An unset thinkingLevel resolves from
 *  DEFAULT_THINKING_ORDER at engine build (reported as absent here). */
export function catalogDefaultsFor(
	chat: ChatSettings | undefined,
	strong: EffectiveSlot | null,
): CatalogDefaults | null {
	const model = chat?.model ?? (strong ? { provider: strong.provider, id: strong.id } : undefined);
	if (!model) return null;
	const level = chat?.thinkingLevel ?? strong?.thinkingLevel;
	return {
		model,
		...(level !== undefined ? { thinkingLevel: level } : {}),
	};
}

/** The conversation agents' resolved default — what a settings-less chat
 *  runs. (settings-storage wave, 2026-09-19): the user's picked default
 *  rides in the settings record's `chat` section; the picker's defaults
 *  row shows it once chosen. */
export function catalogDefaults(): CatalogDefaults | null {
	return catalogDefaultsFor(settingsStore.readSettings()?.chat, effectiveSettings().models.strong);
}

/** Project the resolved per-role specs to the client DTO (pure — the
 *  settings UI's "Default: <actual pinned model>" caption reads this).
 *  BYOK (owner, 2026-09-22): an empty chain projects to NULL — the caption
 *  honestly shows "not configured", never a phantom default. */
export function rolePinsFor(
	models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>,
): RolePins {
	const pins = {} as RolePins;
	for (const role of BACKGROUND_MODEL_ROLES) {
		const spec = models[role];
		pins[role] = spec
			? {
					model: { provider: spec.provider, id: spec.id },
					...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
				}
			: null;
	}
	return pins;
}

/** The six background roles' RESOLVED pins: the user's agent-models
 *  override → tier slot → nothing — the same resolution the agent wiring
 *  uses (src/server/stores.ts effectiveSettings), so the caption can
 *  never drift from what actually runs. */
export function catalogRolePins(): RolePins {
	return rolePinsFor(effectiveSettings().agent.models);
}

/** The three slot tiers' RESOLVED pins — effectiveSettings().models
 *  verbatim: the same resolution the engine wiring uses, so the Models
 *  settings page's captions cannot drift from what actually runs. NULL
 *  per tier that holds no model. */
export function catalogSlots(): SlotPins {
	const slots = effectiveSettings().models;
	const pins = {} as SlotPins;
	for (const name of ["strong", "cheap", "vision"] as const) {
		const slot: EffectiveSlot | null = slots[name];
		pins[name] = slot
			? {
					model: { provider: slot.provider, id: slot.id },
					...(slot.thinkingLevel !== undefined ? { thinkingLevel: slot.thinkingLevel } : {}),
				}
			: null;
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
		// The conversation chain's fallback is the strong slot — the model
		// a settings-less chat would run. BYOK (owner, 2026-09-22): with no
		// model to check against (no chat.model, no strong slot), the level
		// rides unchecked — it clamps against whatever the chain later holds.
		const strong = effectiveSettings().models.strong;
		const provider = settings.model?.provider ?? strong?.provider;
		const id = settings.model?.id ?? strong?.id;
		if (!provider || !id) return { ok: true };
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
 *  catalog — the same gate the chat section gets. A slot must NAME a real
 *  provider+model (owner, 2026-09-22: no factory floor exists, so a level
 *  alone can never run — the parser rejects it, this gate re-checks the
 *  model); a thinkingLevel must be supported by the slot's own model.
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
		// The write-side parser requires slot.model (owner, 2026-09-22 — a
		// level-only slot can never run), so this fallback is tolerance for
		// future callers; with no model to check against, accept (the
		// engine build clamps whatever the chain later holds).
		const resolved = effectiveSettings().models[name];
		const provider = slot.model?.provider ?? resolved?.provider;
		const id = slot.model?.id ?? resolved?.id;
		if (!provider || !id) return { ok: true };
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
