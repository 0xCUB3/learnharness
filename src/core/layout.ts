/**
 * The layout engine — d3-force, everywhere (DECIDED 2026-09-13).
 *
 * One engine owns the equilibrium: the merge-time incremental settle AND
 * the live drag physics run the SAME force set (links as springs, charge
 * repulsion, weak gravity), so the positions ledger and the transient
 * simulation agree on what "resting" means. (FA2 was replaced after a
 * research round: it has no annealing/pinning/settle model and mixing it
 * with a different live engine visibly re-flows the graph on every drag.)
 *
 * Layout EVOLVES instead of reshuffling (Option A): each settle warm-starts
 * from the positions ledger and spring-ties every previously-positioned
 * node toward its anchor (a per-node anchor force). New nodes seed near
 * their positioned neighbors; orphans seed on the rim OUTSIDE the core and
 * are anchored there, so they read as "not yet connected knowledge".
 *
 * Design constraints (kept deliberately, for live physics):
 *  - PURE: no fs, no server types — this module runs server-side (the
 *    merge settle) and in the browser (the live simulation, via the core
 *    barrel). A pinned node is just fx/fy; an anchored node is a spring.
 *  - DETERMINISTIC: seeds derive from node id; d3-force ticks are
 *    deterministic — same inputs, same layout.
 */

import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceX,
	forceY,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode, Position } from "./contracts.ts";
import { seededRandom } from "./question-core.ts";

/** A node the d3 simulation mutates (x/y/vx/vy; fx/fy = pinned). */
export interface LayoutNode extends SimulationNodeDatum {
	id: string;
}

/** A link as d3 sees it (id strings resolve to node refs on init). */
type SimLink = SimulationLinkDatum<LayoutNode>;

export interface SimOptions {
	/** Link spring rest length (world units). */
	linkDistance?: number;
	/** Many-body repulsion strength (negative). */
	chargeStrength?: number;
	/** Center-of-mass gravity: pulls loose components inward. Weak —
	 *  anchors, not gravity, hold the evolved layout's frame. */
	gravity?: { x: number; y: number; strength: number };
	/** Alpha decay per tick — higher = snappier settle. The merge settle
	 *  uses d3's default 0.0228 (~300 ticks); the live sim passes ~0.05. */
	alphaDecay?: number;
}

/** Link input: edges are undirected for layout purposes. */
export interface LayoutEdge {
	from: string;
	to: string;
}

const LINK_DISTANCE = 40;
const CHARGE_STRENGTH = -120;
/** Per-tick anchor re-blend: fraction of an anchored node's displacement
 *  from its previous position that SURVIVES each tick. 0.85 = gentle
 *  evolution where forces are strong, stillness where they are not —
 *  the exact FA2-era constant. Position-space (alpha-independent), so it
 *  cannot be overpowered by d3's long-range link springs the way a force-
 *  space anchor can (forceLink is a Hooke spring: strength*(d-L)*alpha). */
const ANCHOR_RETENTION = 0.85;
/** Gravity strengths. d3 manyBody repulsion falls off as 1/d, so two
 *  20-node blobs at distance d push with ~n1*n2*|charge|/d; cluster
 *  spacing settles where that equals g*d*n/2 — g=0.03 lands clusters
 *  ~400 world units apart (the FA2-era density), and the anchor re-blend
 *  (position-space, alpha-independent) keeps gravity's transient sag
 *  from ever moving an anchored node at rest. */
const BOOTSTRAP_GRAVITY = 0.2;
/** Exported: the live sim reuses this so its rest state matches the
 *  server settle's equilibrium (one engine, one rest). */
export const INCREMENTAL_GRAVITY = 0.12;

/**
 * The one force set. Returns a STOPPED simulation — callers drive it
 * manually (tick-per-frame live, or a bounded tick loop when settling).
 * Deterministic; mutates `nodes` in place (d3 semantics: impure by design,
 * zero per-tick allocation).
 */
export function createGraphSimulation(
	nodes: LayoutNode[],
	edges: ReadonlyArray<LayoutEdge>,
	options: SimOptions = {},
): Simulation<LayoutNode, SimLink> {
	const sim = forceSimulation<LayoutNode, SimLink>(nodes)
		.force(
			"link",
			forceLink<LayoutNode, SimLink>(
				edges.map((e) => ({ source: e.from, target: e.to })),
			)
				.id((d) => d.id)
				.distance(options.linkDistance ?? LINK_DISTANCE),
		)
		.force("charge", forceManyBody<LayoutNode>().strength(options.chargeStrength ?? CHARGE_STRENGTH))
		.alphaDecay(options.alphaDecay ?? 0.0228)
		.stop();

	const g = options.gravity;
	if (g) {
		sim.force("x", forceX<LayoutNode>(g.x).strength(g.strength));
		sim.force("y", forceY<LayoutNode>(g.y).strength(g.strength));
	}
	return sim;
}

export interface IncrementalLayoutOptions {
	/** Manual ticks for the settle (default 300 — d3's anneal to alphaMin). */
	ticks?: number;
	/** Per-tick anchor re-blend (default 0.85; 1 = fully pinned). */
	anchorRetention?: number;
	/** Center-of-mass gravity strength override (tuning/A-B experiments;
	 *  defaults to the internal bootstrap/incremental constants). */
	gravityStrength?: number;
}

/**
 * One incremental settle. `nodes`/`edges` describe the CURRENT graph;
 * `previous` is the positions ledger (empty on the very first settle —
 * then this degrades to a seeded-scatter bootstrap). Returns positions
 * for EVERY node in `nodes`.
 */
export function incrementalLayout(
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
	edges: ReadonlyArray<LayoutEdge>,
	previous: ReadonlyMap<string, Position>,
	options: IncrementalLayoutOptions = {},
): Map<string, Position> {
	const ticks = options.ticks ?? 300;
	const retention = options.anchorRetention ?? ANCHOR_RETENTION;

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
	const coreRadius = hasCore ? Math.max(maxX - minX, maxY - minY) / 2 : 1;

	// Adjacency for neighbor seeding (undirected: edges include assertions).
	const adjacency = new Map<string, string[]>();
	const linkTo = (a: string, b: string): void => {
		if (a === b) return;
		let list = adjacency.get(a);
		if (!list) adjacency.set(a, (list = []));
		list.push(b);
	};
	for (const e of edges) {
		linkTo(e.from, e.to);
		linkTo(e.to, e.from);
	}

	// The rim radius derives from the CONNECTED core's mean radius — orphans
	// never inflate it (a max-span-based radius feeds back: each batch's
	// rim pushes the next batch's rim farther out, and the layout runs
	// away). 1.7x matches the density the FA2-era settle produced
	// (orphan mean r ~338 vs connected ~194).
	let rimRadius = 0;
	let connectedAnchored = 0;
	for (const [id, a] of anchors) {
		if ((adjacency.get(id)?.length ?? 0) === 0) continue;
		connectedAnchored++;
		rimRadius += Math.hypot(a.x - cx, a.y - cy);
	}
	if (connectedAnchored > 0) rimRadius = (rimRadius / connectedAnchored) * 1.7;
	else if (hasCore) rimRadius = coreRadius * 1.15; // no connected anchors yet: bbox fallback
	rimRadius += 4;

	// Seed every node.
	const simNodes: LayoutNode[] = nodes.map((node) => {
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
				const radius = rimRadius + rand() * 8;
				x = cx + Math.cos(angle) * radius;
				y = cy + Math.sin(angle) * radius;
				// An orphan's intended rest spot IS the rim seed: anchor it
				// there so gravity cannot sink it into the core. (A later
				// batch linking it to the graph pulls it in naturally —
				// but then it also has a previous position, and its anchor
				// becomes that previous position, exactly like any node.)
				anchors.set(node.id, { x, y });
			} else {
				// Bootstrap: the classic seeded scatter.
				x = (rand() - 0.5) * 100;
				y = (rand() - 0.5) * 100;
			}
		}
		// d3 is fine with coincident seeds (no division), but nudge exact
		// overlaps of a brand-new node onto its only neighbor anyway.
		if (x === 0 && y === 0) x = 0.5;
		return { id: node.id, x, y };
	});

	const sim = createGraphSimulation(simNodes, edges, {
		gravity: {
			x: cx,
			y: cy,
			strength: options.gravityStrength ?? (hasCore ? INCREMENTAL_GRAVITY : BOOTSTRAP_GRAVITY),
		},
	});
	const byId = new Map(simNodes.map((n) => [n.id, n]));
	for (let i = 0; i < ticks; i++) {
		sim.tick();
		// Anchor re-blend (position space, alpha-independent — see the
		// ANCHOR_RETENTION note). Pinned nodes (fx/fy) are left to d3.
		if (hasCore && retention < 1) {
			for (const [id, a] of anchors) {
				const n = byId.get(id);
				if (!n || n.fx != null || n.fy != null) continue;
				const x = n.x ?? 0;
				const y = n.y ?? 0;
				n.x = a.x + (x - a.x) * retention;
				n.y = a.y + (y - a.y) * retention;
			}
		}
	}

	const out = new Map<string, Position>();
	for (const n of simNodes) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
	return out;
}

/**
 * The merge-time settle: recompute the resting layout from the CURRENT
 * graph + the positions ledger, and replace the ledger. Called by the
 * extraction pipeline after every merge (the sole writer) and by the
 * positions-commit endpoint when the graph grew under a live-physics
 * commit (client positions become the anchor set). Synchronous — it must
 * finish before the next /api/graph fetch reflects the change.
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