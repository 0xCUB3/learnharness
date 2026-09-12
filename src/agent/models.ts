import {
	clampThinkingLevel,
	createModels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
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

/** The process-wide pi-ai Models collection (OpenRouter catalog). */
export function piModels() {
	if (!collection) {
		collection = createModels();
		collection.setProvider(openrouterProvider());
	}
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** The production engine for one agent role. `settings` is the chat's
 * model-control override (prober/teacher only — sub-agent callers pass
 * nothing and get config.ts's pin): any absent field falls back to the
 * config spec, and the thinking level is CLAMPED to the model's supported
 * list (pi's thinkingLevelMap — e.g. GLM-5.3-flash accepts low|high|max),
 * so a settings change between models can never send an invalid level. */
export function piEngineFor(role: ModelRole, settings?: ChatSettings): PiEngine {
	const models: Models = piModels();
	const spec = MODELS[role];
	const modelId = settings?.model?.id ?? spec.model;
	const providerId = settings?.model?.provider ?? "openrouter";
	const model = models.getModel(providerId, modelId);
	if (!model) {
		throw new Error(`${providerId} catalog has no model ${modelId} (role ${role})`);
	}
	const requested = settings?.thinkingLevel ?? thinkingLevelFor(role);
	const level = clampThinkingLevel(model, requested);
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
				apiKey: options?.apiKey ?? openRouterApiKey(),
			}),
	};
}