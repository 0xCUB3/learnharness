/**
 * Option A — incremental anchored force layout (core/layout.ts). The
 * properties the user asked for: the layout EVOLVES (old placements stay
 * recognizable), new nodes land near their cluster, orphans collect on
 * the rim, and everything is deterministic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { incrementalLayout, settleGraphLayout } from "../src/core/layout.ts";
import type { GraphNode, GraphEdge, Position } from "../src/core/contracts.ts";

const node = (id: string): GraphNode => ({
	id,
	name: id,
	statement: id,
	aliases: [],
	createdAt: "2026-09-13T00:00:00.000Z",
	provenance: [],
});
const edge = (from: string, to: string): GraphEdge => ({ from, to, type: "supports", provenance: [] });

const mean = (positions: Map<string, Position>, ids: string[]): { x: number; y: number } => ({
	x: ids.reduce((s, id) => s + positions.get(id)!.x, 0) / ids.length,
	y: ids.reduce((s, id) => s + positions.get(id)!.y, 0) / ids.length,
});

describe("incrementalLayout", () => {
	it("bootstraps deterministically from an empty ledger", () => {
		const nodes = ["a", "b", "c", "d"].map(node);
		const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
		const first = incrementalLayout(nodes, edges, new Map());
		const second = incrementalLayout(nodes, edges, new Map());
		assert.equal(first.size, 4);
		for (const [id, p] of first) {
			assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `finite coords for ${id}`);
			assert.deepEqual(p, second.get(id), `deterministic position for ${id}`);
		}
	});

	it("rest state is stable: a re-settle with nothing new barely moves nodes", () => {
		const nodes = ["a", "b", "c", "d", "e"].map(node);
		const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("a", "e")];
		const rest = incrementalLayout(nodes, edges, new Map());
		const span =
			Math.max(...[...rest.values()].map((p) => p.x)) - Math.min(...[...rest.values()].map((p) => p.x));
		const again = incrementalLayout(nodes, edges, rest);
		let maxShift = 0;
		for (const [id, p] of rest) {
			const q = again.get(id)!;
			maxShift = Math.max(maxShift, Math.hypot(p.x - q.x, p.y - q.y));
		}
		assert.ok(maxShift < span * 0.1, `re-settle drift ${maxShift.toFixed(2)} should be < 10% of span ${span.toFixed(2)}`);
	});

	it("evolves: an anchored node stays near its anchor while a new neighbor joins it", () => {
		const core = ["a", "b", "c"].map(node);
		const coreEdges = [edge("a", "b"), edge("b", "c")];
		const previous = incrementalLayout(core, coreEdges, new Map());
		const anchor = previous.get("b")!;
		const dist = Math.hypot;
		const nearby = ["d", "e"].map(node);
		const next = incrementalLayout(
			[...core, ...nearby],
			[...coreEdges, edge("b", "d"), edge("d", "e")],
			previous,
		);
		// The anchor keeps its neighborhood (bounded drift), and the new
		// nodes landed near it rather than being flung elsewhere.
		const coreSpanBefore =
			Math.max(...[...previous.values()].map((p) => p.x)) - Math.min(...[...previous.values()].map((p) => p.x));
		assert.ok(
			dist(next.get("b")!.x - anchor.x, next.get("b")!.y - anchor.y) < coreSpanBefore,
			"anchored node b stays near its previous position",
		);
		const centroid = mean(next, ["b", "d", "e"]);
		assert.ok(
			dist(next.get("d")!.x - centroid.x, next.get("d")!.y - centroid.y) < coreSpanBefore * 2,
			"new neighbor d landed near the cluster it arrived with",
		);
	});

	it("rim: an orphan ends up outside the anchored core", () => {
		const core = ["a", "b", "c", "d", "e"].map(node);
		const coreEdges = [
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "d"),
			edge("d", "e"),
			edge("a", "e"),
			edge("b", "d"),
		];
		const previous = incrementalLayout(core, coreEdges, new Map());
		const next = incrementalLayout([...core, node("orphan")], coreEdges, previous);
		const c = mean(previous, ["a", "b", "c", "d", "e"]);
		const coreMax = Math.max(
			...[...next.entries()].filter(([id]) => id !== "orphan").map(([, p]) => Math.hypot(p.x - c.x, p.y - c.y)),
		);
		const orphanR = Math.hypot(next.get("orphan")!.x - c.x, next.get("orphan")!.y - c.y);
		assert.ok(orphanR > coreMax, `orphan at r=${orphanR.toFixed(1)} should sit outside core max r=${coreMax.toFixed(1)}`);
	});
});

describe("settleGraphLayout", () => {
	it("dedupes repeated node lines, runs, and writes the whole ledger", () => {
		const written: Record<string, Position>[] = [];
		const lines = [node("a"), node("b"), node("a")]; // "a" appended twice
		const store = {
			readNodes: () => lines.map((l) => ({ ...l })),
			readEdges: () => [edge("a", "b")],
			readPositions: () => ({} as Record<string, Position>),
			writePositions: (p: Record<string, Position>) => void written.push(p),
		};
		settleGraphLayout(store);
		assert.equal(written.length, 1);
		assert.deepEqual(Object.keys(written[0]!).sort(), ["a", "b"], "one position per UNIQUE node");
	});

	it("does nothing on an empty graph", () => {
		const written: Record<string, Position>[] = [];
		settleGraphLayout({
			readNodes: () => [],
			readEdges: () => [],
			readPositions: () => ({} as Record<string, Position>),
			writePositions: (p) => void written.push(p),
		});
		assert.equal(written.length, 0);
	});
});