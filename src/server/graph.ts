import type { GraphSnapshot } from "../core/contracts.ts";
import { foldStaleChats, graphSnapshot } from "../core/graph.ts";

/**
 * Server-side graph entry for the home view (GET /api/graph): fold any chat
 * whose updatedAt outstrips its emission checkpoint first (partial sessions
 * deposit value), then return the snapshot. Today the fold is the naive-union
 * emission; the extraction-pipeline stage replaces the writer behind this
 * same read surface.
 */
export function graphView(): GraphSnapshot {
	foldStaleChats();
	return graphSnapshot();
}
