/**
 * PRACTICE-MODULE CORE (slice 1, 2026-09-29 plan): the chain bijection —
 * chainsForSelection (group by conclusion, FOLLOWS ONLY — supports are
 * invisible to practice, owner ruling) / chainsToGraph (the exact inverse,
 * round-trip pinned) — and chainCoverage (the set's completeness law:
 * union of the problems' chains must equal the set's chains).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EdgeType } from "../src/core/contracts.ts";
import { chainCoverage, chainsForSelection, chainsToGraph, formatChainLine } from "../src/core/practice.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const n = (id: string) => ({ id });
const e = (from: string, to: string, type: EdgeType = "follows") => ({ from, to, type });

/** The plan's canonical shape: diamond a→b, a→c, b→d, c→d. */
const diamond = {
	nodes: [n("a"), n("b"), n("c"), n("d")],
	edges: [e("a", "b"), e("a", "c"), e("b", "d"), e("c", "d")],
};
const diamondChains = [
	{ id: "b", premises: ["a"], conclusion: "b" },
	{ id: "c", premises: ["a"], conclusion: "c" },
	{ id: "d", premises: ["b", "c"], conclusion: "d" },
];

// ─── chainsForSelection ──────────────────────────────────────────────────────

describe("chainsForSelection", () => {
	it("groups by conclusion: the diamond a→b, a→c, b→d, c→d is three chains", () => {
		assert.deepEqual(chainsForSelection(diamond.nodes, diamond.edges), diamondChains);
	});

	it("a premise-only node is NOT its own chain — it lives inside the chains it feeds", () => {
		const ids = chainsForSelection(diamond.nodes, diamond.edges).map((c) => c.id);
		assert.ok(!ids.includes("a")); // a is only ever a premise
	});

	it("an isolated node becomes a singleton chain", () => {
		const chains = chainsForSelection([...diamond.nodes, n("z")], diamond.edges);
		assert.deepEqual(chains.at(-1), { id: "z", premises: [], conclusion: "z" });
	});

	it("supports edges are NO edges — nodes joined only by supports are singletons", () => {
		const chains = chainsForSelection([n("x"), n("y")], [e("x", "y", "supports")]);
		assert.deepEqual(chains, [
			{ id: "x", premises: [], conclusion: "x" },
			{ id: "y", premises: [], conclusion: "y" },
		]);
	});

	it("an edge with an endpoint outside the selection is excluded entirely", () => {
		// a→out would chain a; out is not selected, so the edge is gone and
		// a (nothing else left) falls back to a singleton.
		const chains = chainsForSelection([n("a")], [e("a", "out"), e("in", "a")]);
		assert.deepEqual(chains, [{ id: "a", premises: [], conclusion: "a" }]);
	});

	it("duplicate edge assertions collapse into one premise", () => {
		const chains = chainsForSelection([n("a"), n("b")], [e("a", "b"), e("a", "b")]);
		assert.deepEqual(chains, [{ id: "b", premises: ["a"], conclusion: "b" }]);
	});

	it("is deterministic — chains and premises sorted by id", () => {
		const shuffled = chainsForSelection(
			[n("d"), n("c"), n("b"), n("a")],
			[e("c", "d"), e("a", "c"), e("a", "b"), e("b", "d")],
		);
		assert.deepEqual(shuffled, diamondChains);
	});
});

// ─── chainsToGraph — the bijection ───────────────────────────────────────────

describe("chainsToGraph (the inverse)", () => {
	it("reproduces exactly the selection's follows-edges (both ends selected)", () => {
		const supportsNoise = e("x", "y", "supports");
		const outside = e("a", "out");
		const { edges } = chainsToGraph(chainsForSelection(diamond.nodes, [...diamond.edges, supportsNoise, outside]));
		assert.deepEqual(edges, [...diamond.edges]);
	});

	it("round-trips a canonical chain list — singletons survive only for edge-less nodes", () => {
		// NOTE: the bijection is over chainsForSelection's IMAGE — lists where a
		// singleton's node never also appears as a premise/conclusion elsewhere.
		// (A "singleton + premise elsewhere" list is degenerate: not something
		// the translation ever produces.)
		const canonical = [
			{ id: "p1", premises: ["a", "b"], conclusion: "p1" },
			{ id: "p9", premises: [], conclusion: "p9" },
			{ id: "c1", premises: ["p1"], conclusion: "c1" },
		];
		const nodeIds = [...new Set(canonical.flatMap((c) => [c.conclusion, ...c.premises]))];
		const roundTripped = chainsForSelection(nodeIds.map(n), chainsToGraph(canonical).edges);
		assert.deepEqual(roundTripped, [
			{ id: "c1", premises: ["p1"], conclusion: "c1" },
			{ id: "p1", premises: ["a", "b"], conclusion: "p1" },
			{ id: "p9", premises: [], conclusion: "p9" },
		]);
	});
});

// ─── chainCoverage ───────────────────────────────────────────────────────────

describe("chainCoverage", () => {
	it("complete cover: every chain exercised, no missing", () => {
		const set = {
			chains: diamondChains,
			problems: [{ chains: ["b", "c"] }, { chains: ["d"] }],
		};
		assert.deepEqual(chainCoverage(set), { missing: [], duplicated: [] });
	});

	it("missing: a chain no problem exercises", () => {
		const set = {
			chains: diamondChains,
			problems: [{ chains: ["d"] }],
		};
		assert.deepEqual(chainCoverage(set), { missing: ["b", "c"], duplicated: [] });
	});

	it("duplicated is informational — a chain exercised twice is allowed", () => {
		const set = {
			chains: diamondChains,
			problems: [{ chains: ["b", "c", "d"] }, { chains: ["b", "d"] }],
		};
		assert.deepEqual(chainCoverage(set), { missing: [], duplicated: ["b", "d"] });
	});

	it("problems claiming chain ids outside the set neither cover nor fail anything", () => {
		const set = {
			chains: [{ id: "b" }] as Array<{ id: string }>,
			problems: [{ chains: ["b", "ghost"] }],
		};
		assert.deepEqual(chainCoverage(set), { missing: [], duplicated: [] });
	});
});

describe("formatChainLine (the chain table's one-line shape, 2026-09-29)", () => {
	const props = {
		p1: { name: "Premise one" },
		p2: { name: "Premise two" },
		c1: { name: "Conclusion" },
		solo: { name: "Standalone" },
	};

	it("joins sorted premise NAMES by the derivation arrow", () => {
		assert.equal(formatChainLine({ premises: ["p2", "p1"], conclusion: "c1" }, props), "Premise one, Premise two → Conclusion");
	});

	it("a singleton shows its (no premises) marker", () => {
		assert.equal(formatChainLine({ premises: [], conclusion: "solo" }, props), "Standalone (no premises)");
	});

	it("unknown ids fall back to the raw id (honest, never guessed)", () => {
		assert.equal(formatChainLine({ premises: ["ghost"], conclusion: "c1" }, props), "ghost → Conclusion");
	});
});
