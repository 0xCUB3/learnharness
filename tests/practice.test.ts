/**
 * PRACTICE-MODULE CORE: chainsForSelection over the STORED chains
 * (chains-primary, owner 2026-09-30: a chain rides along iff every member
 * is selected; nodes in no surviving chain are singletons) and
 * chainCoverage (the set's completeness law: union of the problems' chains
 * must equal the set's chains).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain } from "../src/core/contracts.ts";
import { chainCoverage, chainsForSelection, formatChainLine } from "../src/core/practice.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const n = (id: string) => ({ id });
const arg = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [],
	createdAt: "2026-09-30T00:00:00.000Z",
});

/** The plan's canonical shape: diamond a→b, a→c, b∧c→d — three stored
 *  arguments (each its own arg_ id, conclusion ids may repeat). */
const diamondNodes = [n("a"), n("b"), n("c"), n("d")];
const diamondArgs = [arg("arg_b", ["a"], "b"), arg("arg_c", ["a"], "c"), arg("arg_d", ["b", "c"], "d")];

// ─── chainsForSelection ──────────────────────────────────────────────────────

describe("chainsForSelection", () => {
	it("keeps every fully-selected stored argument, each under its own id", () => {
		assert.deepEqual(chainsForSelection(diamondNodes, diamondArgs), [
			{ id: "arg_b", premises: ["a"], conclusion: "b" },
			{ id: "arg_c", premises: ["a"], conclusion: "c" },
			{ id: "arg_d", premises: ["b", "c"], conclusion: "d" },
		]);
	});

	it("a premise-only node is NOT its own chain — it lives inside the arguments it feeds", () => {
		const ids = chainsForSelection(diamondNodes, diamondArgs).map((c) => c.id);
		assert.ok(!ids.includes("a")); // a is only ever a premise
	});

	it("an isolated node becomes a singleton chain", () => {
		const chains = chainsForSelection([...diamondNodes, n("z")], diamondArgs);
		assert.deepEqual(chains.at(-1), { id: "z", premises: [], conclusion: "z" });
	});

	it("two independent arguments for one conclusion stay DISTINCT chains", () => {
		// The bijection problem that killed edge-grouping (owner, 2026-09-30):
		// A∧B⇒E and C∧D⇒E must never union into A∧B∧C∧D⇒E.
		const chains = chainsForSelection(
			[n("a"), n("b"), n("c"), n("d"), n("e")],
			[arg("arg_e1", ["a", "b"], "e"), arg("arg_e2", ["c", "d"], "e")],
		);
		assert.deepEqual(chains, [
			{ id: "arg_e1", premises: ["a", "b"], conclusion: "e" },
			{ id: "arg_e2", premises: ["c", "d"], conclusion: "e" },
		]);
	});

	it("an argument with ANY member outside the selection is excluded entirely", () => {
		// arg_ab needs b; b is not selected, so the argument is gone and
		// a (nothing else left) falls back to a singleton.
		const chains = chainsForSelection([n("a")], [arg("arg_ab", ["a"], "b"), arg("arg_ia", ["in"], "a")]);
		assert.deepEqual(chains, [{ id: "a", premises: [], conclusion: "a" }]);
	});

	it("a chain referencing unknown node ids simply never applies", () => {
		const chains = chainsForSelection([n("a"), n("b")], [arg("arg_ghost", ["ghost"], "b")]);
		assert.deepEqual(chains, [
			{ id: "a", premises: [], conclusion: "a" },
			{ id: "b", premises: [], conclusion: "b" },
		]);
	});

	it("is deterministic — chains sorted by id, premises sorted", () => {
		const shuffled = chainsForSelection(
			[n("d"), n("c"), n("b"), n("a")],
			[arg("arg_d", ["c", "b"], "d"), arg("arg_c", ["a"], "c"), arg("arg_b", ["a"], "b")],
		);
		assert.deepEqual(shuffled, [
			{ id: "arg_b", premises: ["a"], conclusion: "b" },
			{ id: "arg_c", premises: ["a"], conclusion: "c" },
			{ id: "arg_d", premises: ["b", "c"], conclusion: "d" },
		]);
	});
});

// ─── chainCoverage ───────────────────────────────────────────────────────────

const diamondChains = [
	{ id: "arg_b", premises: ["a"], conclusion: "b" },
	{ id: "arg_c", premises: ["a"], conclusion: "c" },
	{ id: "arg_d", premises: ["b", "c"], conclusion: "d" },
];

describe("chainCoverage", () => {
	it("complete cover: every chain exercised, no missing", () => {
		const set = {
			chains: diamondChains,
			problems: [{ chains: ["arg_b", "arg_c"] }, { chains: ["arg_d"] }],
		};
		assert.deepEqual(chainCoverage(set), { missing: [], duplicated: [] });
	});

	it("missing: a chain no problem exercises", () => {
		const set = {
			chains: diamondChains,
			problems: [{ chains: ["arg_d"] }],
		};
		assert.deepEqual(chainCoverage(set), { missing: ["arg_b", "arg_c"], duplicated: [] });
	});

	it("duplicated is informational — a chain exercised twice is allowed", () => {
		const set = {
			chains: diamondChains,
			problems: [{ chains: ["arg_b", "arg_c", "arg_d"] }, { chains: ["arg_b", "arg_d"] }],
		};
		assert.deepEqual(chainCoverage(set), { missing: [], duplicated: ["arg_b", "arg_d"] });
	});

	it("problems claiming chain ids outside the set neither cover nor fail anything", () => {
		const set = {
			chains: [{ id: "arg_b" }] as Array<{ id: string }>,
			problems: [{ chains: ["arg_b", "ghost"] }],
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
