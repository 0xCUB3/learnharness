/**
 * Community detection tests (vision §1, DECIDED 2026-09-13) — pure
 * structural Louvain over follows+supports, deterministic via seed.
 * Assertions are on SHAPE and MEMBER SETS, never community indices
 * (indices reshuffle; member sets are what labelings key to).
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { detectCommunities } from "../src/core/clusters.ts";
import type { Community } from "../src/core/clusters.ts";

const ids = (n: number, prefix = "n") => [...Array(n).keys()].map((i) => `${prefix}${i}`);

/** A clique on the given ids. */
const clique = (nodeIds: string[]) =>
	nodeIds.flatMap((a, i) => nodeIds.slice(i + 1).map((b) => ({ from: a, to: b })));

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
		assert.deepEqual(result.communities[0].members.sort(), ["a", "b", "c"]);
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
		assert.deepEqual(result.communities[0].members.sort(), ["a", "b"]);
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
		const last = result.communities[result.communities.length - 1];
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
