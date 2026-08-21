/**
 * Stage 3 — Merge (deterministic code + LLM adjudication for node identity).
 * NOT YET IMPLEMENTED. Interface specified:
 *
 *   Input:  ExtractedSession (Stage 2 output) + canonical graph
 *   1. Embed canonical node statements (cached) → kNN candidates per incoming node.
 *   2. ONE LLM adjudication call per session: each pair →
 *        same    → alias + attach events to canonical node
 *        related → new node + proposed cross-session edge (the quiet superpower)
 *        unrelated → new node, no edge
 *   3. Apply deterministically; log every decision as a SessionMapping
 *      (reversible by design — wrong merges must be one-line fixes).
 *
 * Policy: fully automatic, conservative — prefer duplicates over wrong merges.
 * No domain filter on candidates (cross-domain merging is the point).
 */

import type { ExtractedSession } from "../schema.ts";

export async function mergeSession(extraction: ExtractedSession): Promise<void> {
	throw new Error("Not implemented — Stage 3 (merger) comes after the extractor.");
}
