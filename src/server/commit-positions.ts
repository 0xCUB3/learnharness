/**
 * Server-side commit for the live physics drag (PUT /api/graph/positions).
 * The client's renderer anneals a drag to rest and PUTs the new rest
 * state; the server trusts it for the nodes it knows about and, if the
 * graph grew while the user was dragging (a merge landed), runs ONE
 * incremental settle (settleGraphLayout) so the fresh nodes are absorbed
 * into the frame the user just arranged — client positions act as
 * anchors, never as a clobber.
 *
 * Every body is sanitized: garbage coordinates clamp or drop, unknown
 * ids are discarded, nothing throws.
 */
import type { Position } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import { settleGraphLayout } from "../core/layout.ts";
import { stores } from "./stores.ts";

/** Max |x| or |y| accepted — NaN/Infinity clamp here, absurd too. */
const MAX_COORD = 1e6;

/**
 * Accepts the raw PUT body (a Record of id → {x, y}) and returns the
 * sanitized positions actually persisted (empty object = nothing written,
 * e.g. a body with no known ids — the caller reports but never fails).
 */
export function commitPositions(input: unknown): Record<string, Position> {
	if (typeof input !== "object" || input === null) return {};
	const raw = input as Record<string, unknown>;

	// Only ids the graph actually has (first line wins, like getGraph).
	const known = new Map<string, boolean>();
	for (const line of stores.graphStore.readNodes()) {
		if (!known.has(line.id)) known.set(line.id, true);
	}

	const positions: Record<string, Position> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!known.has(id)) continue;
		if (typeof value !== "object" || value === null) continue;
		const { x, y } = value as Record<string, unknown>;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
			continue;
		positions[id] = {
			x: Math.min(Math.max(x, -MAX_COORD), MAX_COORD),
			y: Math.min(Math.max(y, -MAX_COORD), MAX_COORD),
		};
	}
	if (Object.keys(positions).length === 0) return {};

	stores.graphStore.writePositions(positions);

	// The graph grew past what the client knew (a merge landed mid-drag):
	// absorb the new nodes with the client's rest state as anchors.
	const unique = getGraph(stores.graphStore).nodes.length;
	if (unique > Object.keys(positions).length) settleGraphLayout(stores.graphStore);
	return positions;
}