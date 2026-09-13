/**
 * COMMUNITY DETECTION for the knowledge graph (vision §1, DECIDED
 * 2026-09-13): Louvain modularity over the undirected, unweighted
 * follows+supports structure — purely structural, so it never depends on
 * layout, and the extraction pipeline never knows clusters exist.
 *
 * Determinism: Louvain's random-walk traversal is driven by a SEEDED
 * mulberry32 RNG (default seed constant below), so the same graph always
 * yields the same partition. Community INDICES are still not stable
 * across graph edits — which is why labelings (Phase B) key to sorted
 * MEMBER SETS, never to indices.
 *
 * Undirected + unweighted (user-decided 2026-09-13): both edge types are
 * equally real relations between propositions — direction is
 * derivational-vs-grounding, not stronger-vs-weaker — and a follows AND
 * a supports between the same pair collapse to one edge.
 *
 * This module is browser-safe pure logic (no node builtins, no fs): the
 * server runs it for the snapshot payload, the renderer for nothing
 * (clusters arrive precomputed), and tests run it directly.
 *
 * NOTE: no minimum-size filter here — detection returns every community,
 * singletons included. The ≥3-node render threshold (decided) is a
 * PRESENTATION rule; it lives in the payload derivation and the
 * renderer, not in the algorithm.
 */
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { ClusterLabeling } from "./contracts.ts";

/** A detected community. Members are SORTED node ids — the member set IS
 * the identity a labeling record can outlive a reshuffle with. */
export interface Community {
	members: string[];
}

/** Communities below this size are not rendered, not named — presentation
 *  rule (user-decided 2026-09-13): a region of the world model needs at
 *  least three propositions to be worth a hull and a label. */
export const MIN_CLUSTER_SIZE = 3;

export interface CommunityDetection {
	communities: Community[];
	/** Modularity of the found partition — the one quality number. */
	modularity: number;
}

export interface DetectOptions {
	/** Louvain resolution (higher → more, smaller communities). Default 1.
	 * Parked for the multi-scale work; exposed now so that dial has a home. */
	resolution?: number;
	/** RNG seed. Default "lh-clusters". Same seed + same graph → same
	 * partition, always. */
	seed?: string;
}

/** mulberry32 seeded by a string (FNV-1a) — the same recipe as
 * question-core's seededRandom, inlined so this module has no
 * cross-domain dependency. */
function seededRng(seed: string): () => number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	let a = h >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Detect communities over a graph's structure. Inputs are the minimal
 * structural shapes of the snapshot contracts (GraphNode.id,
 * GraphEdge.from/to), so both the real snapshot and test fixtures feed it.
 *
 * Edges referencing unknown node ids are skipped defensively (the ledgers
 * are append-only; a mid-merge read should never crash detection), and
 * duplicate pairs (follows+supports, or reverse direction) collapse —
 * mergeEdge keeps the first.
 */
export function detectCommunities(
	nodes: readonly { id: string }[],
	edges: readonly { from: string; to: string }[],
	opts?: DetectOptions,
): CommunityDetection {
	const graph = new Graph({ type: "undirected" });
	for (const node of nodes) graph.addNode(node.id);
	for (const edge of edges) {
		if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
		if (edge.from === edge.to) continue; // self-loops: no community signal
		graph.mergeEdge(edge.from, edge.to);
	}
	// Louvain on a 0-edge graph is degenerate; every node is trivially its
	// own community (and louvain on an empty graph returns nothing useful).
	if (graph.size === 0) {
		return {
			communities: nodes.map((n) => ({ members: [n.id] })).sort((a, b) => (a.members[0] ?? "").localeCompare(b.members[0] ?? "")),
			modularity: 0,
		};
	}
	const details = louvain.detailed(graph, {
		rng: seededRng(opts?.seed ?? "lh-clusters"),
		resolution: opts?.resolution ?? 1,
	});
	const byIndex = new Map<number, string[]>();
	for (const [id, index] of Object.entries(details.communities)) {
		const bucket = byIndex.get(index) ?? [];
		bucket.push(id);
		byIndex.set(index, bucket);
	}
	const communities = [...byIndex.values()]
		.map((ids) => ({ members: ids.sort() }))
		.sort(
			(a, b) =>
				b.members.length - a.members.length ||
				(a.members[0] ?? "").localeCompare(b.members[0] ?? ""),
		);
	return { communities, modularity: details.modularity };
}

/**
 * Claim labeling records for detected communities — CORE-SURVIVAL (DECIDED
 * 2026-09-13): a community keeps a record's label while AT LEAST HALF of
 * the record's core survives in it (overlap * 2 >= core.length; exactly
 * half survives). Both sides are single-successor: one community holds at
 * most one label, one record is claimed by at most one community — on a
 * split, only the branch carrying the majority of the core keeps the name;
 * on a merge, the best-overlapping record wins.
 *
 * Greedy assignment by overlap size (largest first; ties broken by newer
 * record). Returns a claim (or null) per community, in input order —
 * unclaimed communities are the namer's input. Pure: same inputs, same
 * claims.
 */
export function matchClusterLabelings(
	communities: readonly Community[],
	labelings: readonly ClusterLabeling[],
): (ClusterLabeling | null)[] {
	interface Pair {
		community: number;
		labeling: ClusterLabeling;
		overlap: number;
	}
	const pairs: Pair[] = [];
	communities.forEach((community, ci) => {
		const members = new Set(community.members);
		for (const labeling of labelings) {
			const overlap = labeling.core.reduce((n, id) => n + (members.has(id) ? 1 : 0), 0);
			if (overlap * 2 >= labeling.core.length && overlap > 0) {
				pairs.push({ community: ci, labeling, overlap });
			}
		}
	});
	pairs.sort((a, b) => b.overlap - a.overlap || (a.labeling.createdAt < b.labeling.createdAt ? 1 : -1));
	const claims: (ClusterLabeling | null)[] = communities.map(() => null);
	const takenRecords = new Set<string>();
	for (const pair of pairs) {
		if (claims[pair.community] || takenRecords.has(pair.labeling.id)) continue;
		claims[pair.community] = pair.labeling;
		takenRecords.add(pair.labeling.id);
	}
	return claims;
}
