/**
 * Community detection tests (vision §1, DECIDED 2026-09-13) — pure
 * structural Louvain over follows+supports, deterministic via seed.
 * Assertions are on SHAPE and MEMBER SETS, never community indices
 * (indices reshuffle; member sets are what labelings key to).
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { matchClusterLabelings, MIN_CLUSTER_SIZE, type Community } from "../src/core/clusters.ts";
import { clusterHue } from "../components/cluster-geometry.ts";
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

describe("clusterHue", () => {
	test("is stable per id and spreads", () => {
		// Same id → same hue, always; different ids → usually different hues.
		assert.equal(clusterHue("cluster-a"), clusterHue("cluster-a"));
		const hues = new Set<number>();
		for (let i = 0; i < 40; i++) hues.add(clusterHue(`cluster-${i}`));
		assert.ok(hues.size > 20, `expected spread, got ${hues.size} distinct hues for 40 ids`);
		for (const h of hues) assert.ok(h >= 0 && h < 360);
	});
});

