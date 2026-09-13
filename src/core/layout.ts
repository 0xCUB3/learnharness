/**
 * Option A — incremental anchored force layout (DECIDED 2026-09-13).
 *
 * The layout EVOLVES instead of reshuffling: each settle warm-starts
 * forceAtlas2 from the positions ledger, ties every previously-positioned
 * node back toward its anchor (a per-iteration re-blend), and seeds new
 * nodes near their positioned neighbors — so old placements stay
 * recognizable while the graph grows, exactly the way a mind map accretes
 * around what came before.
 *
 * Design constraints (kept deliberately, for future live physics):
 *  - PURE: no fs, no server types — the same function is the merge-time
 *    server settler AND the future client-side live simulator (a pinned
 *    node is just an anchor with full retention).
 *  - DETERMINISTIC: seeded by node id, so the same graph + ledger state
 *    always settles identically.
 *
 * Orphans (degree-0 nodes) seed on the rim — outside the anchored core's
 * bounding box — so they read as "not yet connected knowledge", the organic
 * outer ring the user asked for.
 */

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphNode, GraphEdge, Position } from "./contracts.ts";
import { seededRandom } from "./question-core.ts";

export interface IncrementalLayoutOptions {
	/** FA2 iterations per settle (default 100 — same depth as the classic
	 *  one-shot pass, so a fresh graph settles exactly like the old code). */
	iterations?: number;
	/** Per-iteration anchor retention: how much of a previously-positioned
	 *  node's displacement from its anchor SURVIVES each iteration.
	 *  1 = fully pinned (never moves), 0.85 = gentle drift where forces
	 *  are strong (near new nodes), stillness where they are not. */
	anchorRetention?: number;
}

/** Layout adjacency input: edges are undirected for layout purposes. */
export interface LayoutEdge {
	from: string;
	to: string;
}

/**
 * One incremental settle. `nodes`/`edges` describe the CURRENT graph;
 * `previous` is the positions ledger (empty on the very first settle —
 * then this degrades to the classic seeded-scatter + 100-iteration FA2
 * pass, i.e. what the browser used to do from scratch every time).
 * Returns positions for EVERY node in `nodes`.
 */
export function incrementalLayout(
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
	edges: ReadonlyArray<LayoutEdge>,
	previous: ReadonlyMap<string, Position>,
	options: IncrementalLayoutOptions = {},
): Map<string, Position> {
	const iterations = options.iterations ?? 100;
	const retention = options.anchorRetention ?? 0.85;

	// Anchors: the warm-start set (the previous rest state).
	const anchors = new Map<string, Position>();
	for (const node of nodes) {
		const prev = previous.get(node.id);
		if (prev) anchors.set(node.id, { x: prev.x, y: prev.y });
	}

	// The anchored core's bounding box + centroid, for rim seeds.
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	let cx = 0;
	let cy = 0;
	for (const a of anchors.values()) {
		minX = Math.min(minX, a.x);
		maxX = Math.max(maxX, a.x);
		minY = Math.min(minY, a.y);
		maxY = Math.max(maxY, a.y);
		cx += a.x;
		cy += a.y;
	}
	const hasCore = anchors.size > 0;
	if (hasCore) {
		cx /= anchors.size;
		cy /= anchors.size;
	}
	const coreRadius = hasCore
		? Math.max(maxX - minX, maxY - minY) / 2
		: 1;

	// Adjacency for neighbor seeding (undirected: edges include assertions).
	const adjacency = new Map<string, string[]>();
	for (const e of edges) {
		if (e.from === e.to) continue;
		(adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to);
		(adjacency.get(e.to) ?? adjacency.set(e.to, []).get(e.to)!).push(e.from);
	}

	const graph = new Graph();
	for (const node of nodes) {
		const rand = seededRandom(node.id);
		const anchor = anchors.get(node.id);
		let x: number;
		let y: number;
		if (anchor) {
			// Warm start: resume from the previous rest position.
			x = anchor.x;
			y = anchor.y;
		} else {
			// New node: seed near its positioned neighbors (the cluster it
			// arrived with), else on the rim outside the core, else scatter.
			let sx = 0;
			let sy = 0;
			let found = 0;
			for (const nbr of adjacency.get(node.id) ?? []) {
				const na = anchors.get(nbr);
				if (na) {
					sx += na.x;
					sy += na.y;
					found++;
				}
			}
			if (found > 0) {
				x = sx / found + (rand() - 0.5) * 8;
				y = sy / found + (rand() - 0.5) * 8;
			} else if (hasCore) {
				const angle = rand() * Math.PI * 2;
				const radius = coreRadius * 1.15 + 4 + rand() * 8;
				x = cx + Math.cos(angle) * radius;
				y = cy + Math.sin(angle) * radius;
			} else {
				// Bootstrap: the classic seeded scatter (FA2 requires
				// non-zero coordinates; (rand()-0.5)*100 hits both axes).
				x = (rand() - 0.5) * 100;
				y = (rand() - 0.5) * 100;
			}
		}
		// FA2 divides by distances — a coincident (0,0) seed is degenerate.
		if (x === 0 && y === 0) x = 0.5;
		graph.addNode(node.id, { x, y });
	}
	for (const e of edges) {
		if (graph.hasNode(e.from) && graph.hasNode(e.to) && !graph.hasEdge(e.from, e.to)) {
			graph.addEdge(e.from, e.to);
		}
	}

	// Same escalation as the browser path: Barnes-Hut above ~500 nodes.
	const settings = {
		...forceAtlas2.inferSettings(graph),
		...(graph.order > 500 ? { barnesHutOptimize: true } : {}),
	};
	for (let i = 0; i < iterations; i++) {
		forceAtlas2.assign(graph, { iterations: 1, settings });
		// Anchor re-blend: previously-positioned nodes are pulled back
		// toward their rest positions, so the layout evolves locally
		// instead of globally reshuffling. displacement * retention —
		// strong forces still win out (equilibrium ≈ force/(1-retention)),
		// weak ones fade to stillness.
		if (hasCore && retention < 1) {
			for (const [id, a] of anchors) {
				const attrs = graph.getNodeAttributes(id);
				graph.setNodeAttribute(id, "x", a.x + (attrs.x - a.x) * retention);
				graph.setNodeAttribute(id, "y", a.y + (attrs.y - a.y) * retention);
			}
		}
	}

	const out = new Map<string, Position>();
	graph.forEachNode((id, attrs) => out.set(id, { x: attrs.x, y: attrs.y }));
	return out;
}

/**
 * The merge-time settle: recompute the resting layout from the CURRENT
 * graph + the positions ledger, and replace the ledger. Called by the
 * extraction pipeline after every merge (the sole writer). Synchronous —
 * it must finish before the next /api/graph fetch reflects the merge.
 */
export function settleGraphLayout(graphStore: {
	readNodes(): GraphNode[];
	readEdges(): GraphEdge[];
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
	const previous = new Map(Object.entries(graphStore.readPositions()));
	const next = incrementalLayout(unique, graphStore.readEdges(), previous);
	graphStore.writePositions(Object.fromEntries(next));
}