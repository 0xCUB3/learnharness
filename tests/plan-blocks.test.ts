/**
 * plan-blocks — the INTERIM plan presentation seam (docs/probe-teach-split.md
 * §6): the full block renders IN FLOW exactly once, attached to the
 * assistant message carrying the successful plan_init call. The
 * neighborhood-block machinery is retired (position derives live from
 * derivePlanStatuses); the persistent DAG window (UI wave) succeeds this.
 */
import assert from "node:assert";
import test from "node:test";
import type { UIMessage } from "ai";
import { withPlanBlocks, type PlanBlockPart } from "../src/core/plan-blocks.ts";
import type { PlanTree } from "../src/core/contracts.ts";

// 5-node fixture: a → b → c, b → d, d → e.
const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "A" },
		{ id: "b", title: "B" },
		{ id: "c", title: "C" },
		{ id: "d", title: "D" },
		{ id: "e", title: "E" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
		{ from: "b", to: "d" },
		{ from: "d", to: "e" },
	],
	version: 1,
};

/** A rewrite fixture: 3 fresh nodes (x, y, z), different from TREE. */
const TREE2: PlanTree = {
	nodes: [
		{ id: "x", title: "X" },
		{ id: "y", title: "Y" },
		{ id: "z", title: "Z" },
	],
	edges: [{ from: "x", to: "y" }, { from: "y", to: "z" }],
	version: 2,
};

/** An assistant message carrying a successful plan_init with the fixture tree. */
function planInitMessage(id: string, tree: PlanTree = TREE): UIMessage {
	return {
		id,
		role: "assistant",
		parts: [
			{ type: "text", text: "Here is the plan." },
			{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } },
		],
	} as unknown as UIMessage;
}

/** A message built from raw parts (positional tests need exact part arrays). */
function msg(role: string, parts: unknown[]): UIMessage {
	return { id: `m_${Math.random().toString(36).slice(2, 8)}`, role, parts } as unknown as UIMessage;
}

function blocksOf(messages: UIMessage[]): PlanBlockPart[] {
	return messages.flatMap((m) => m.parts.filter((p) => p.type === "data-plan-block") as PlanBlockPart[]);
}

test("withPlanBlocks: a successful plan_init message gains ONE full block (all nodes, statuses from the transcript)", () => {
	const out = withPlanBlocks([planInitMessage("m1")], TREE);
	const blocks = blocksOf(out);
	assert.equal(blocks.length, 1);
	const data = blocks[0]!.data;
	assert.equal(data.kind, "full");
	assert.equal(data.current, null, "at authoring nothing is current");
	assert.equal(data.nodes.length, 5);
	assert.ok(data.nodes.every((n) => n.status === "upcoming"));
	assert.equal(data.edges.length, 4);
	// attached to the plan_init message itself
	assert.equal(blocksOf([out[0]!]).length, 1);
});

test("withPlanBlocks: a FAILED plan_init gains nothing", () => {
	const failed: UIMessage = {
		id: "m1",
		role: "assistant",
		parts: [
			{ type: "text", text: "oops" },
			{ type: "tool-plan_init", state: "output-error", output: { ok: false, error: "bad" } },
		],
	} as unknown as UIMessage;
	assert.equal(blocksOf(withPlanBlocks([failed], TREE)).length, 0);
});

test("withPlanBlocks: idempotent — a message that already carries a block is never given another", () => {
	const once = withPlanBlocks([planInitMessage("m1")], TREE);
	const twice = withPlanBlocks(once, TREE);
	assert.equal(blocksOf(twice).length, 1, "no duplicate block on persist replay");
});

test("withPlanBlocks: a plan REWRITE (second successful plan_init) gets its own full block; the old stays frozen", () => {
	const rewrittenTree: PlanTree = { nodes: TREE.nodes.slice(0, 3), edges: [{ from: "a", to: "b" }], version: 2 };
	const out = withPlanBlocks([planInitMessage("m1"), planInitMessage("m2", rewrittenTree)], rewrittenTree);
	const blocks = blocksOf(out);
	assert.equal(blocks.length, 2, "one full block per authoring event");
	assert.equal(blocks[1]!.data.nodes.length, 3);
});

test("withPlanBlocks: the block renders IN FLOW immediately after the plan_init part — not appended under the turn's later parts", () => {
	// Real-world shape (user session chat_mtwgb9lj): the authoring turn
	// carries plan_init, then presentation prose, then quiz calls — emission
	// runs at persistTurn AFTER all of that exists.
	const turn = msg("assistant", [
		{ type: "step-start" },
		{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree: TREE } },
		{ type: "step-start" },
		{ type: "text", state: "done", text: "Here's the plan." },
		{ type: "tool-quiz", state: "input-available", input: { question: "q?" } },
	]);
	const out = withPlanBlocks([turn], TREE);
	const types = out[0]!.parts.map((p) => p.type);
	assert.equal(types[2], "data-plan-block", "the block directly follows the plan_init part");
	assert.equal(types.indexOf("data-plan-block"), 2);
	assert.ok(types.indexOf("data-plan-block") < types.indexOf("text"), "block before the prose");
	assert.ok(types.indexOf("data-plan-block") < types.indexOf("tool-quiz"), "block before the first check");
	assert.equal(types.at(-1), "tool-quiz", "the quiz is still the turn's last part");
});

test("withPlanBlocks: with multiple plan_inits in one turn (a rewrite), the block follows the LAST one", () => {
	const turn = msg("assistant", [
		{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree: TREE } },
		{ type: "text", state: "done", text: "v1" },
		{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree: TREE2 } },
		{ type: "text", state: "done", text: "v2" },
	]);
	const out = withPlanBlocks([turn], TREE2);
	const types = out[0]!.parts.map((p) => p.type);
	assert.equal(types[3], "data-plan-block", "block directly after the last successful init");
	assert.equal(types[4], "text", "the trailing prose stays after the block");
	assert.equal(out[0]!.parts.filter((p) => p.type === "data-plan-block").length, 1, "one block per message even on a same-turn rewrite");
});

test("withPlanBlocks: quizzes alone emit nothing (no neighborhood blocks anymore)", () => {
	const quizTurn: UIMessage = {
		id: "m1",
		role: "assistant",
		parts: [
			{ type: "text", text: "check" },
			{ type: "tool-quiz", state: "output-available", input: { nodeId: "b" }, output: { correct: true } },
		],
	} as unknown as UIMessage;
	assert.equal(blocksOf(withPlanBlocks([quizTurn], TREE)).length, 0);
});

test("withPlanBlocks: no tree / empty tree / no messages are no-ops", () => {
	assert.equal(withPlanBlocks([planInitMessage("m1")], null).length, 1, "passthrough");
	const emptyTree: PlanTree = { nodes: [], edges: [], version: 0 };
	assert.equal(blocksOf(withPlanBlocks([planInitMessage("m1")], emptyTree)).length, 0);
	assert.equal(withPlanBlocks([], TREE).length, 0);
});

test("withPlanBlocks: mid-lesson rewrite snapshot derives statuses from the whole transcript", () => {
	// A tagged quiz call on node b happened before the rewrite: b is current.
	const quizBefore: UIMessage = {
		id: "m0",
		role: "assistant",
		parts: [
			{ type: "text", text: "about b" },
			{ type: "tool-quiz", state: "output-available", input: { nodeId: "b" }, output: { correct: true } },
		],
	} as unknown as UIMessage;
	const out = withPlanBlocks([quizBefore, planInitMessage("m1")], TREE);
	const data = blocksOf(out)[0]!.data;
	assert.equal(data.current, "b");
	const b = data.nodes.find((n) => n.id === "b")!;
	assert.equal(b.status, "current");
});