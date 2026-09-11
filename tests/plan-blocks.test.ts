import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { neighborhood, withPlanBlocks, type PlanBlockPart } from "../src/core/plan-blocks.ts";
import type { PlanTree } from "../src/core/contracts.ts";

/** The 5-node DAG the neighborhood tests slice:
 *  A → B → C, B → D → E (B's children C,D; A's only child is B). */
function tree(): PlanTree {
	return {
		nodes: [
			{ id: "a", title: "Foundations" },
			{ id: "b", title: "Core" },
			{ id: "c", title: "Applied" },
			{ id: "d", title: "Deep dive" },
			{ id: "e", title: "Frontier" },
		],
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "b", to: "d" },
			{ from: "d", to: "e" },
		],
		currentNodeId: null,
		doneNodeIds: [],
		version: 1,
	};
}

function msg(id: string, role: "user" | "assistant", parts: UIMessage["parts"] = []): UIMessage {
	return { id, role, parts };
}

function blocksOf(m: UIMessage): PlanBlockPart[] {
	return m.parts.filter((p): p is PlanBlockPart => p.type === "data-plan-block") as PlanBlockPart[];
}

function allBlocks(messages: UIMessage[]): PlanBlockPart[] {
	return messages.flatMap((m) => blocksOf(m));
}

/** tool-plan_init part in terminal state (the authoring call succeeded). */
function planInitPart(tree: PlanTree, ok = true) {
	return { type: "tool-plan_init", state: "output-available", input: { mermaid: "graph TD" }, output: { ok, tree } } as unknown as UIMessage["parts"][number];
}

/** tool-quiz part tagged with a node. `answered` appends the learner's output. */
function quizPart(nodeId: string, answered?: { correct: boolean }) {
	const part = {
		type: "tool-quiz",
		state: answered ? "output-available" : "input-available",
		input: { nodeId, question: "…", options: [] },
		...(answered ? { output: { correct: answered.correct } } : {}),
	} as unknown as UIMessage["parts"][number];
	return part;
}

describe("neighborhood (pure scope)", () => {
	it("includes current + direct parents + direct children, nothing further", () => {
		const { nodes, edges } = neighborhood(tree(), "b");
		assert.deepEqual(
			nodes.map((n) => n.id).sort(),
			["a", "b", "c", "d"],
		);
		assert.deepEqual(edges.map((e) => `${e.from}>${e.to}`).sort(), ["a>b", "b>c", "b>d"]);
	});
});

describe("withPlanBlocks", () => {
	it("attaches a FULL block to the assistant message with a successful plan_init", () => {
		const t = tree();
		const out = withPlanBlocks(
			[msg("m1", "user", [{ type: "text", text: "teach me" } as never]), msg("m2", "assistant", [planInitPart(t)])],
			t,
		);
		const blocks = allBlocks(out);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]!.data.kind, "full");
		assert.equal(blocks[0]!.data.current, "a"); // first prereq-free node
		assert.equal(blocks[0]!.data.nodes.length, 5);
		assert.equal(blocksOf(out[1]!).length, 1); // on the plan_init message itself
	});

	it("ignores a failed plan_init (ok: false)", () => {
		const t = tree();
		const out = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant", [planInitPart(t, false)])], t);
		assert.equal(allBlocks(out).length, 0);
	});

	it("attaches a NEIGHBORHOOD block on the last assistant message when a check goes out", () => {
		const t = tree();
		const out = withPlanBlocks(
			[
				msg("m1", "user"),
				msg("m2", "assistant", [quizPart("a", { correct: true })]), // a done earlier
				msg("m3", "assistant", [quizPart("b")]), // check on b now out
			],
			t,
		);
		const blocks = allBlocks(out);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]!.data.kind, "neighborhood");
		assert.equal(blocks[0]!.data.current, "b");
		assert.deepEqual(
			blocks[0]!.data.nodes.map((n) => n.id).sort(),
			["a", "b", "c", "d"], // e excluded: grandchild of b via d
		);
		assert.equal(blocksOf(out[2]!).length, 1); // on the LAST assistant message
	});

	it("does not re-emit when the plan state has not moved", () => {
		const t = tree();
		const turn1 = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant", [quizPart("b")])], t);
		assert.equal(allBlocks(turn1).length, 1);
		// next turn: plain exchange, plan untouched — the previous block IS the as-of slice
		const turn2 = withPlanBlocks(
			[...turn1, msg("m3", "user"), msg("m4", "assistant", [{ type: "text", text: "ok" } as never])],
			t,
		);
		assert.equal(allBlocks(turn2).length, 1); // nothing new
		assert.equal(blocksOf(turn2[3]!).length, 0);
	});

	it("re-emits when a check resolves (done grows / current falls back)", () => {
		const t = tree();
		const asked = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant", [quizPart("b")])], t);
		// learner answers correctly: done grows, no check out → current falls to a
		const answered = withPlanBlocks(
			[...asked, msg("m3", "user"), msg("m4", "assistant", [{ type: "text", text: "good" } as never])].map((m) =>
				m.id === "m2" ? { ...m, parts: m.parts.map((p) => (p.type === "tool-quiz" ? quizPart("b", { correct: true }) : p)) } : m,
			),
			t,
		);
		const blocks = allBlocks(answered);
		assert.equal(blocks.length, 2);
		const latest = blocks.at(-1)!.data;
		assert.equal(latest.kind, "neighborhood");
		assert.deepEqual(
			latest.nodes.find((n) => n.id === "b")!.status,
			"done",
		);
		assert.equal(latest.current, "a"); // b done, a never checked → first eligible
	});

	it("re-emits when a failed check resets the standing (no done growth)", () => {
		const t = tree();
		const asked = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant", [quizPart("b")])], t);
		// learner answers WRONG: done doesn't grow, but no check is out anymore
		// → current falls back to the first eligible node
		const failed = withPlanBlocks(
			[...asked, msg("m3", "user"), msg("m4", "assistant", [{ type: "text", text: "let's review" } as never])].map((m) =>
				m.id === "m2" ? { ...m, parts: m.parts.map((p) => (p.type === "tool-quiz" ? quizPart("b", { correct: false }) : p)) } : m,
			),
			t,
		);
		const blocks = allBlocks(failed);
		assert.equal(blocks.length, 2);
		const latest = blocks.at(-1)!.data;
		assert.equal(latest.current, "a");
		assert.equal(latest.nodes.find((n) => n.id === "b")!.status, "upcoming"); // not done
	});

	it("is idempotent when the same list is persisted twice (retry replay)", () => {
		const t = tree();
		const once = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant", [quizPart("b")])], t);
		const twice = withPlanBlocks(once, t);
		assert.equal(allBlocks(twice).length, 1);
		assert.equal(twice[1]!.parts.length, once[1]!.parts.length);
	});

	it("attaches a new FULL block on a plan rewrite, keeping the old block frozen", () => {
		const t = tree();
		const authored = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant", [planInitPart(t)])], t);
		const rewrite = withPlanBlocks(
			[...authored, msg("m3", "user"), msg("m4", "assistant", [planInitPart(t)])],
			t,
		);
		const blocks = allBlocks(rewrite);
		assert.equal(blocks.length, 2);
		assert.deepEqual(blocks.map((b) => b.data.kind), ["full", "full"]);
		assert.equal(blocksOf(rewrite[3]!).length, 1); // new block on the NEW authoring message
	});

	it("no-ops on null/empty tree and on messages without assistant turns", () => {
		assert.equal(withPlanBlocks([msg("m1", "user")], tree()).length, 1);
		const empty = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant")], { ...tree(), nodes: [] });
		assert.equal(allBlocks(empty).length, 0);
		const noTree = withPlanBlocks([msg("m1", "user"), msg("m2", "assistant")], null);
		assert.equal(allBlocks(noTree).length, 0);
	});
});
