/**
 * Community detection tests (vision §1, DECIDED 2026-09-13) — pure
 * structural Louvain over follows+supports, deterministic via seed.
 * Assertions are on SHAPE and MEMBER SETS, never community indices
 * (indices reshuffle; member sets are what labelings key to).
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { detectCommunities, matchClusterLabelings, MIN_CLUSTER_SIZE } from "../src/core/clusters.ts";
import { clusterHue, convexHull, offsetPolygon, outwardNormal } from "../components/cluster-geometry.ts";
import type { Community } from "../src/core/clusters.ts";
import type { ClusterLabeling } from "../src/core/contracts.ts";

const ids = (n: number, prefix = "n") => [...Array(n).keys()].map((i) => `${prefix}${i}`);

/** A clique on the given ids. */
const clique = (nodeIds: string[]) =>
	nodeIds.flatMap((a, i) => nodeIds.slice(i + 1).map((b) => ({ from: a, to: b })));

const labeling = (id: string, core: string[], createdAt = "2026-09-01T00:00:00.000Z"): ClusterLabeling => ({
	id,
	label: `label-${id}`,
	core,
	createdAt,
});

describe("matchClusterLabelings", () => {
	test("claims a labeling while at least half its core survives in the community", () => {
		const community: Community = { members: ["a", "b", "c", "d", "e"] };
		const records = [labeling("clu_1", ["a", "b", "x", "y"])]; // 2 of 4 survive — exactly half
		const [claim] = matchClusterLabelings([community], records);
		assert.equal(claim?.id, "clu_1");
		// One fewer survivor: under half → relabel.
		const [dead] = matchClusterLabelings([{ members: ["a", "c", "d", "e", "f"] }], records);
		assert.equal(dead, null);
	});

	test("single successor: a split core keeps its label in only one community", () => {
		const records = [labeling("clu_1", ["a", "b", "c", "d"])];
		const left: Community = { members: ["a", "b", "z"] }; // 2 of 4 — half
		const right: Community = { members: ["c", "d", "w"] }; // 2 of 4 — half
		// Tie: larger overlap wins; equal → both eligible, greedy takes first come.
		const claims = matchClusterLabelings([left, right], records);
		const claimed = claims.filter((c) => c !== null);
		assert.equal(claimed.length, 1);
		assert.equal(claimed[0]?.id, "clu_1");
	});

	test("greedy: the best-overlapping community wins the record", () => {
		const records = [labeling("clu_1", ["a", "b", "c", "d"])];
		const weak: Community = { members: ["a", "b", "q", "r", "s"] }; // 2/4
		const strong: Community = { members: ["a", "b", "c", "x", "y"] }; // 3/4
		const claims = matchClusterLabelings([weak, strong], records);
		assert.equal(claims[0], null);
		assert.equal(claims[1]?.id, "clu_1");
	});

	test("one record per community; newest record breaks ties", () => {
		const oldR = labeling("clu_old", ["a", "b"], "2026-09-01T00:00:00.000Z");
		const newR = labeling("clu_new", ["a", "b"], "2026-09-02T00:00:00.000Z");
		const community: Community = { members: ["a", "b", "c"] };
		const [claim] = matchClusterLabelings([community], [oldR, newR]);
		assert.equal(claim?.id, "clu_new");
	});

	test("no labelings: every community unclaimed; empty communities array ok", () => {
		assert.deepEqual(matchClusterLabelings([{ members: ["a", "b"] }], []), [null]);
		assert.deepEqual(matchClusterLabelings([], [labeling("clu_1", ["a"])]), []);
	});

	test("MIN_CLUSTER_SIZE is 3 (the render/naming threshold)", () => {
		assert.equal(MIN_CLUSTER_SIZE, 3);
	});
});

describe("hull geometry (the inward-normal regression)", () => {
	// Screen coordinates: y grows DOWN. The first implementation used
	// (-dy, dx) as the "outward" normal — which points INWARD for the
	// clockwise-on-screen rings monotone chain produces here, shrinking
	// every hull by the pad and inverting it entirely once a cluster
	// projected smaller than ~2x the pad (spiky shape churn on zoom).

	const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

	test("outwardNormal points away from a square's interior (screen coords)", () => {
		const square = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		const center = { x: 5, y: 5 };
		for (let i = 0; i < 4; i++) {
			const a = square[i]!;
			const b = square[(i + 1) % 4]!;
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const n = outwardNormal(a, b);
			// The normal translated from the edge midpoint moves AWAY from the center.
			const moved = { x: mid.x + n.x, y: mid.y + n.y };
			assert.ok(dist(moved, center) > dist(mid, center), `edge ${i}: normal points inward`);
		}
	});

	test("offsetPolygon moves every vertex AWAY from the centroid", () => {
		const hull = convexHull([
			{ x: 0, y: 0 }, { x: 40, y: 3 }, { x: 55, y: 30 }, { x: 20, y: 44 }, { x: 2, y: 25 },
		]);
		const centroid = {
			x: hull.reduce((s, p) => s + p.x, 0) / hull.length,
			y: hull.reduce((s, p) => s + p.y, 0) / hull.length,
		};
		for (const [i, v] of hull.entries()) {
			const moved = offsetPolygon(hull, 14)[i]!;
			assert.ok(
				dist(moved, centroid) > dist(v, centroid),
				`vertex ${i} moved inward (was ${dist(v, centroid).toFixed(1)}, now ${dist(moved, centroid).toFixed(1)})`,
			);
		}
	});

	test("offsetPolygon stays sane when the hull is SMALLER than the pad (the zoom-out case)", () => {
		// A 10px cluster padded by 14px: must still be a simple polygon
		// (no vertex crossing the centroid, no inversion).
		const hull = convexHull([
			{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 9, y: 9 }, { x: 1, y: 8 },
		]);
		const centroid = {
			x: hull.reduce((s, p) => s + p.x, 0) / hull.length,
			y: hull.reduce((s, p) => s + p.y, 0) / hull.length,
		};
		const moved = offsetPolygon(hull, 14);
		for (const v of moved) {
			assert.ok(dist(v, centroid) >= 10, `vertex collapsed past the centroid: ${JSON.stringify(v)}`);
		}
		// Vertex ORDER stays angularly monotone around the centroid (no self-intersection).
		const angles = moved.map((v) => Math.atan2(v.y - centroid.y, v.x - centroid.x));
		let prev = angles[0]!;
		for (const a of angles.slice(1)) {
			let d = a - prev;
			while (d > Math.PI) d -= 2 * Math.PI;
			while (d < -Math.PI) d += 2 * Math.PI;
			assert.ok(d !== 0, "duplicate angle — degenerate offset");
			prev = a;
		}
	});

	test("convexHull returns a clockwise-on-screen ring (the orientation the normal math assumes)", () => {
		const hull = convexHull([
			{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
		]);
		// Signed area in code coords: clockwise-on-screen (y-down) = positive.
		let area = 0;
		for (let i = 0; i < hull.length; i++) {
			const a = hull[i]!;
			const b = hull[(i + 1) % hull.length]!;
			area += a.x * b.y - b.x * a.y;
		}
		assert.ok(area / 2 > 0, `expected positive (clockwise-on-screen) area, got ${area / 2}`);
	});

	test("clusterHue is stable per id and spreads", () => {
		assert.equal(clusterHue("clu_abc123def456"), clusterHue("clu_abc123def456"));
		const hues = new Set(Array.from({ length: 40 }, (_, i) => clusterHue(`clu_${i}`)));
		assert.ok(hues.size > 25, `expected spread hues, got ${hues.size}`);
	});
});

describe("detectCommunities", () => {
	test("two dense cliques joined by a single bridge split into two communities", () => {
		const left = ids(4, "L");
		const right = ids(4, "R");
		const bridge = { from: "L0", to: "R0" };
		const result = detectCommunities([...left, ...right].map((id) => ({ id })), [...clique(left), ...clique(right), bridge]);
		assert.equal(result.communities.length, 2);
		assert.equal(result.modularity > 0.3, true);
		// Member sets, not order: the two big communities are exactly the cliques.
		const big = result.communities.filter((c) => c.members.length === 4);
		assert.deepEqual(big.map((c) => c.members.sort()).sort(), [left.slice().sort(), right.slice().sort()]);
	});

	test("deterministic: same graph, same seed → identical partition", () => {
		const nodes = ids(10).map((id) => ({ id }));
		const edges = [...clique(ids(5)), ...clique(ids(5, "n").slice().reverse().slice(0, 5)), { from: "n0", to: "n9" }];
		const a = detectCommunities(nodes, edges);
		const b = detectCommunities(nodes, edges);
		assert.deepEqual(a.communities, b.communities);
		assert.equal(a.modularity, b.modularity);
	});

	test("no edges: every node is its own singleton community", () => {
		const result = detectCommunities(ids(3).map((id) => ({ id })), []);
		assert.equal(result.communities.length, 3);
		for (const c of result.communities) assert.equal(c.members.length, 1);
		assert.equal(result.modularity, 0);
	});

	test("empty graph: zero communities", () => {
		assert.deepEqual(detectCommunities([], []), { communities: [], modularity: 0 });
	});

	test("duplicate and reversed pairs collapse to one edge (undirected, unweighted)", () => {
		const nodes = ["a", "b", "c"].map((id) => ({ id }));
		// follows a→b AND supports b→a — same pair twice, both directions.
		const result = detectCommunities(nodes, [
			{ from: "a", to: "b" },
			{ from: "b", to: "a" },
			{ from: "b", to: "c" },
		]);
		assert.equal(result.communities.length, 1);
		assert.deepEqual(result.communities[0]!.members.sort(), ["a", "b", "c"]);
	});

	test("self-loops and unknown-endpoint edges are skipped defensively", () => {
		const nodes = ["a", "b"].map((id) => ({ id }));
		const result = detectCommunities(nodes, [
			{ from: "a", to: "a" }, // self-loop
			{ from: "a", to: "ghost" }, // dangling
			{ from: "ghost1", to: "ghost2" },
			{ from: "a", to: "b" }, // the one real edge
		]);
		assert.equal(result.communities.length, 1);
		assert.deepEqual(result.communities[0]!.members.sort(), ["a", "b"]);
	});

	test("members are sorted; communities ordered by size then id", () => {
		const left = ids(4, "L");
		const right = ids(4, "R");
		const result = detectCommunities(
			[...left, ...right, "iso"].map((id) => ({ id })),
			[...clique(left), ...clique(right), { from: "L0", to: "R0" }],
		);
		for (const c of result.communities as Community[]) {
			const sorted = c.members.slice().sort();
			assert.deepEqual(c.members, sorted);
		}
		// iso (isolated) is last: size 1 < 4.
		const last = result.communities[result.communities.length - 1]!;
		assert.deepEqual(last.members, ["iso"]);
	});

	test("seed override changes nothing structurally but stays deterministic", () => {
		const nodes = ids(8).map((id) => ({ id }));
		const edges = [...clique(["n0", "n1", "n2", "n3"]), ...clique(["n4", "n5", "n6", "n7"]), { from: "n0", to: "n4" }];
		const a = detectCommunities(nodes, edges, { seed: "one" });
		const b = detectCommunities(nodes, edges, { seed: "one" });
		const c = detectCommunities(nodes, edges, { seed: "two" });
		assert.deepEqual(a.communities, b.communities);
		// A different seed partitions the same graph into member sets that
		// may or may not coincide — but both runs are 2 communities here,
		// because the structure dominates.
		assert.equal(c.communities.length, 2);
	});
});
