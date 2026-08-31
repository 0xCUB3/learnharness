import { openrouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { MODELS, type ModelRole } from "../../config.ts";

/**
 * The one factory every agent's model comes from. Model choice and thinking
 * budget live in config.ts (MODELS) — the single tuning table; this module
 * only wires them to OpenRouter. `effort: "none"` is OpenRouter's off-switch
 * for reasoning tokens; higher levels let the model think longer (and bill
 * accordingly).
 */
export function modelFor(role: ModelRole): LanguageModel {
	const spec = MODELS[role];
	return openrouter(spec.model, {
		reasoning: { enabled: true, effort: spec.effort },
	});
}
