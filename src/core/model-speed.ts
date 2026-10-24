/** Codex subscription speed, separate from reasoning effort and API billing. */
export type ModelServiceTier = "default" | "priority";

// OpenAI Codex speed documentation, checked 2026-10-24. This is model
// capability, not a promise of account entitlement or delivered latency.
const CODEX_FAST_MODELS = new Set([
 "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
 "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol",
]);
export function supportsCodexFastMode(provider: string, id: string): boolean {
 return provider === "subscription-openai-codex" && CODEX_FAST_MODELS.has(id);
}
export function isModelServiceTier(value: unknown): value is ModelServiceTier {
 return value === "default" || value === "priority";
}
/** Unsupported providers never inherit or dispatch a Codex speed override. */
export function modelServiceTier(provider: string, id: string, value: unknown): ModelServiceTier | undefined {
 return supportsCodexFastMode(provider, id) && isModelServiceTier(value) ? value : undefined;
}
