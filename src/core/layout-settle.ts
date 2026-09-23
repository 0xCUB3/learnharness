import type { GraphEdge, GraphNode, NodeMapping, Position } from "./contracts.ts";
import { incrementalLayout } from "./layout.ts";
import { birthSessionPartition } from "./session-clusters.ts";

/**
 * The merge-time settle: recompute the resting layout from the CURRENT
 * graph + the positions ledger, and replace the ledger. Called by the
 * extraction pipeline after every merge (the sole writer) and by the
 * positions-commit endpoint when the graph grew under a live-physics
 * commit (client positions become the anchor set). Synchronous — it must
 * finish before the next /api/graph fetch reflects the change.
 *
 * SPLIT FROM layout.ts deliberately (2026-09-13): layout.ts is in the
 * browser barrel, and the settle needs the cluster partition for the
 * cluster centroid pull — this module must not ship in the client bundle.
 * Server code imports it DIRECTLY; it is never re-exported through
 * src/core/index.ts.
 */
export function settleGraphLayout(graphStore: {
	readNodes(): GraphNode[];
	readEdges(): GraphEdge[];
	readMappings(): NodeMapping[];
	readPositions(): Record<string, Position>;
	writePositions(positions: Record<string, Position>): void;
}): void {
	const nodes = graphStore.readNodes();
	if (nodes.length === 0) return;
	// Node LINES may repeat an id (link-appends) — dedupe, first defines.
	const seen = new Set<string>();
	const unique = nodes.filter((n) => {
		if (seen.has(n.id)) return false;
		seen.add(n.id);
		return true;
	});
	const edges = graphStore.readEdges();
	const previous = new Map(Object.entries(graphStore.readPositions()));
	// The cluster partition for the centroid pull: the SAME birth-session
	// partition the snapshot renders (derived from provenance on read —
	// core/session-clusters.ts, wave 7) — one cluster concept everywhere.
	// The unique list is the deduped set the partition needs (lines may
	// repeat an id — first defines).
	const communities = birthSessionPartition(unique, graphStore.readMappings());
	const next = incrementalLayout(unique, edges, previous, { clusters: communities });
	graphStore.writePositions(Object.fromEntries(next));
}