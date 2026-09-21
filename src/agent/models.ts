import {
	clampThinkingLevel,
	createModels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MODELS, type ModelRole } from "../../config.ts";
import type { ChatSettings } from "../core/contracts/chat.ts";

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). Model choice and thinking budget live in
 * config.ts (MODELS) — the single tuning table; this module only wires them
 * to pi-ai's OpenRouter provider.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalog (glm-5.3-flash and qwen3.8-max are both in
 * 0.85.1's built-ins — no overlay fetch) and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

/** The role's config thinking level (config's scale IS pi's since the
 * model-control wave — no mapping needed). */
export function thinkingLevelFor(role: ModelRole): ThinkingLevel {
	return MODELS[role].effort;
}

let collection: ReturnType<typeof createModels> | undefined;

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels();
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from
 *  (model slots wave, 2026-09-20): the settings-resolution chain's output.
 *  Every field concrete; the CALLER resolved the chain (role override →
 *  slot → factory pin, or the chat's conversation chain). */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec): PiEngine {
	const models: Models = piModels();
	const model = models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	const level = clampThinkingLevel(model, spec.thinkingLevel);
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		streamFn: (requestModel, context, options) =>
			models.streamSimple(requestModel, context, {
				...options,
				reasoning: level === "off" ? undefined : level,
			}),
	};
}

/** The production engine for one agent role — the LEGACY fallback path:
 *  the chat's model-control override over config.ts's pin. Production
 *  callers (chat-handler) now resolve the full chain (chat override →
 *  strong slot → factory pin) and call piEngineForSpec; this stays for
 *  direct config-pin fallbacks (sub-agents without an injected engine —
 *  the job runner injects one — and tests). */
export function piEngineFor(role: ModelRole, settings?: ChatSettings): PiEngine {
	const spec = MODELS[role];
	return piEngineForSpec({
		provider: settings?.model?.provider ?? spec.provider,
		id: settings?.model?.id ?? spec.model,
		thinkingLevel: settings?.thinkingLevel ?? thinkingLevelFor(role),
	});
}
