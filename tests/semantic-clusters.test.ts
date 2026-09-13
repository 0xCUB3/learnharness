/**
 * Semantic topic clustering (the Louvain REPLACEMENT, DECIDED
 * 2026-09-13): average-linkage agglomerative clustering over the
 * embedding ledger — related TOPICS, not reasoning chains. Pure and
 * deterministic, so these tests are exact.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { semanticClusters, SEMANTIC_SIM_THRESHOLD, cosineSimilarity } from "../src/core/semantic-clusters.ts";

/** Two clearly-related one-hot-ish vectors (high cosine similarity). */
function near(vec: number[], target: number[], amount = 0.2): number[] {
	let dot = 0;
	for (let i = 0; i < vec.length; i++) dot += vec[i]! * target[i]!;
	const mixed = vec.map((x, i) => x + amount * target[i]!);
	let mag = 0;
	for (const x of mixed) mag += x * x;
	mag = Math.sqrt(mag);
	return mixed.map((x) => x / mag);
}

function axis(dim: number, k: number): number[] {
	return Array.from({ length: dim }, (_, i) => (i === k ? 1 : 0));
}

describe("cosineSimilarity", () => {
	test("identical unit vectors → 1; orthogonal → 0; defensive normalization", () => {
		const a = axis(4, 0);
		const b = axis(4, 1);
		assert.ok(cosineSimilarity(a, a) > 0.999);
		assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-9);
		// Unnormalized twins still match.
		assert.ok(cosineSimilarity([3, 0], [5, 0]) > 0.999);
	});
});

describe("semanticClusters", () => {
	test("empty ledger: zero clusters (nothing embedded yet)", () => {
		assert.deepEqual(semanticClusters({}), []);
	});

	test("related vectors merge; distant ones stay separate (threshold)", () => {
		const dim = 8;
		const topicA = axis(dim, 0);
		const topicB = axis(dim, 1);
		const vectors = {
			a1: near(topicA, topicB, 0.1),
			a2: near(topicA, topicB, 0.15),
			a3: near(topicA, topicB, 0.05),
			b1: near(topicB, topicA, 0.1),
			b2: near(topicB, topicA, 0.12),
		};
		const clusters = semanticClusters(vectors);
		// Both topics form; average-linkage similarity within each is well
		// above the default threshold, across is well below.
		const big = clusters.filter((c) => c.members.length >= 2);
		assert.equal(big.length, 2);
		assert.deepEqual(
			big.map((c) => c.members.sort()).sort((x, y) => x[0]!.localeCompare(y[0]!)),
			[["a1", "a2", "a3"], ["b1", "b2"]],
		);
	});

	test("threshold is the granularity knob: higher splits, lower merges", () => {
		const dim = 6;
		const vectors = {
			x: near(axis(dim, 0), axis(dim, 1), 0.3),
			y: near(axis(dim, 1), axis(dim, 0), 0.3),
		};
		// Similarity ~0.72: merges below that, splits above.
		const sim = cosineSimilarity(vectors.x!, vectors.y!);
		assert.equal(semanticClusters(vectors, { similarityThreshold: sim - 0.01 }).length, 1);
		assert.equal(semanticClusters(vectors, { similarityThreshold: sim + 0.01 }).length, 2);
	});

	test("stragglers stay singletons by default; attachStragglers forces membership", () => {
		const dim = 6;
		const topic = axis(dim, 0);
		const vectors = {
			t1: near(topic, axis(dim, 1), 0.1),
			t2: near(topic, axis(dim, 2), 0.1),
			t3: near(topic, axis(dim, 3), 0.1),
			loner: axis(dim, 5), // orthogonal: fits nothing
		};
		const loose = semanticClusters(vectors);
		const looseLoner = loose.find((c) => c.members.includes("loner"));
		assert.equal(looseLoner?.members.length, 1, "default: loner is a straggler");
		assert.equal(loose.find((c) => c.members.length >= 3)?.members.length, 3);

		const allIn = semanticClusters(vectors, { attachStragglers: true });
		assert.equal(allIn.length, 1, "attach: the loner joins the nearest topic");
		assert.ok(allIn[0]!.members.includes("loner"));
	});

	test("members sorted; clusters ordered by size then id (deterministic)", () => {
		const dim = 4;
		const vectors = {
			solo: axis(dim, 3),
			p1: near(axis(dim, 0), axis(dim, 1), 0.05),
			p2: near(axis(dim, 0), axis(dim, 2), 0.05),
			q1: near(axis(dim, 1), axis(dim, 0), 0.05),
			q2: near(axis(dim, 1), axis(dim, 2), 0.05),
		};
		const a = semanticClusters(vectors);
		const b = semanticClusters(vectors);
		assert.deepEqual(a, b, "same input → identical partition");
		for (let i = 1; i < a.length; i++) {
			assert.ok(a[i - 1]!.members.length >= a[i]!.members.length, "size-descending");
		}
		for (const c of a) {
			assert.deepEqual(c.members, [...c.members].sort(), "members sorted");
		}
	});

	test("default threshold is the swept real-graph value", () => {
		assert.equal(SEMANTIC_SIM_THRESHOLD, 0.6);
	});
});
