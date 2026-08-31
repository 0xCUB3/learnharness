import type { GraphSnapshot } from "../core/contracts.ts";
import { graphSnapshot } from "../core/graph.ts";
import { stores } from "./stores.ts";

/**
 * Server-side graph entry for the home view (GET /api/graph). A PURE READ:
 * the extraction pipeline (the sole graph writer) is triggered by quiz
 * answers in sessions (turn-service), never from here — the home view
 * reflects whatever the pipeline has merged so far.
 */
export function graphView(): GraphSnapshot {
	return graphSnapshot(stores);
}
