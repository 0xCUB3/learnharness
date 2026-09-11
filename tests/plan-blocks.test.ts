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