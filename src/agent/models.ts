import {
	createModels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MODELS, type ModelRole } from "../../config.ts";

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
}

export type { ThinkingLevel };

/** config's effort scale maps 1:1 onto pi's thinking levels (none→off). */
export function thinkingLevelFor(role: ModelRole): ThinkingLevel {
	const effort = MODELS[role].effort as string;
	return effort === "none" ? "off" : (effort as ThinkingLevel);
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

/** The production engine for one agent role (config.ts MODELS). */
export function piEngineFor(role: ModelRole): PiEngine {
	const models: Models = piModels();
	const spec = MODELS[role];
	const model = models.getModel("openrouter", spec.model);
	if (!model) throw new Error(`OpenRouter catalog has no model ${spec.model} (role ${role})`);
	const level = thinkingLevelFor(role);
	return {
		model,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); pin the role's level
		// so a bare engine can never drift.
		streamFn: (requestModel, context, options) =>
			models.streamSimple(requestModel, context, {
				...options,
				reasoning: level === "off" ? undefined : level,
				apiKey: options?.apiKey ?? openRouterApiKey(),
			}),
	};
}