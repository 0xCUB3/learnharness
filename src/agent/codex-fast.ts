import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
/** streamSimple drops serviceTier, but forwards onPayload before SSE/WS split. */
export function codexServiceTierPayload(fast: boolean, upstream?: SimpleStreamOptions["onPayload"]): NonNullable<SimpleStreamOptions["onPayload"]> {
 return async (raw, model) => {
  const replacement = await upstream?.(raw, model);
  const payload = replacement === undefined ? raw : replacement;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Codex request payload");
  const body = { ...payload } as Record<string, unknown>;
  // Persisted user choice wins over a stale or caller-supplied tier.
  delete body.service_tier;
  if (fast) body.service_tier = "priority";
  return body;
 };
}
