/**
 * Plan-tree tests (W1) — two layers:
 *
 *  1. Pure ops (src/core/plan-tree.ts): every validation error path, cascade
 *     remove, version semantics, setCurrent/markDone behavior.
 *  2. Tool execute (src/agent/tools/plan.ts): against the REAL chat store —
 *     plan_init happy path + refusal to re-init, a mutation round-trip that
 *     persists to the record, error results on invalid ops.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { derivePlanStatuses, derivedNodeStatus, type PlanTree, type PlanToolResult } from "../src/core/contracts.ts";
import {
	addEdge,
	addNode,
	createTree,
	emptyTree,
	markDone,
	PlanTreeError,
	removeEdge,
	removeNode,
	setCurrent,
	updateNode,
} from "../src/core/plan-tree.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import { parseMermaidPlan } from "../src/agent/tools/mermaid-plan.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const N = (id: string, title = id, summary?: string) => ({ id, title, ...(summary ? { summary } : {}) });
const E = (from: string, to: string) => ({ from, to });

function tree(ids: string[], edges: Array<[string, string]> = []): PlanTree {
	return createTree(
		ids.map((id) => N(id)),
		edges.map(([from, to]) => E(from, to)),
	);
}

/** Assert the op throws a PlanTreeError matching the given regex. */
function assertReject(fn: () => unknown, needle: RegExp): void {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof PlanTreeError, `expected PlanTreeError, got ${err}`);
		assert.match(err.message, needle);
		return;
	}
	assert.fail(`expected a PlanTreeError matching ${needle}, but the op succeeded`);
}

// ─── 1. pure ops ─────────────────────────────────────────────────────────────

describe("plan-tree pure ops", () => {
	it("createTree builds version 1 with no mutation of its inputs", () => {
		const nodes = [N("a", "A"), N("b", "B")];
		const edges = [E("a", "b")];
		const t = createTree(nodes, edges);
		assert.equal(t.version, 1);
		assert.equal(t.currentNodeId, null);
		assert.deepEqual(t.doneNodeIds, []);
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b"]);
		assert.deepEqual(t.edges, [E("a", "b")]);
		// Input arrays untouched (deep-copied into the tree).
		assert.deepEqual(nodes, [N("a", "A"), N("b", "B")]);
		assert.deepEqual(edges, [E("a", "b")]);
	});

	it("createTree rejects duplicate node ids", () => {
		assertReject(() => createTree([N("a"), N("a")], []), /Duplicate node id "a"/);
	});

	it("createTree rejects edges with missing endpoints", () => {
		assertReject(() => createTree([N("a")], [E("a", "ghost")]), /unknown node id "ghost"/);
		assertReject(() => createTree([N("a")], [E("ghost", "a")]), /unknown node id "ghost"/);
	});

	it("createTree rejects self-loops, duplicates, and cycles", () => {
		assertReject(() => createTree([N("a")], [E("a", "a")]), /self-loop/);
		assertReject(() => createTree([N("a"), N("b")], [E("a", "b"), E("a", "b")]), /already exists/);
		// a→b→c→a is a cycle.
		assertReject(
			() => createTree([N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c"), E("c", "a")]),
			/cycle/,
		);
	});

	it("createTree rejects invalid node shapes", () => {
		assertReject(() => createTree([N("")], []), /non-empty `id`/);
		assertReject(() => createTree([{ id: "a", title: "" }], []), /non-empty `title`/);
	});

	it("addNode appends and increments version; parents become requires edges", () => {
		const t = addNode(tree(["a", "b"], [["a", "b"]]), N("c", "C", "the goal"), ["a", "b"]);
		assert.equal(t.version, 2); // createTree=1, plus this op
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b", "c"]);
		assert.deepEqual(t.edges, [E("a", "b"), E("a", "c"), E("b", "c")]);
	});

	it("addNode rejects duplicate ids, unknown parents, self-parent, and cycle-creating parents", () => {
		const base = tree(["a", "b"], [["a", "b"]]);
		assertReject(() => addNode(base, N("a")), /already exists/);
		assertReject(() => addNode(base, N("c"), ["ghost"]), /unknown node id "ghost"/);
		assertReject(() => addNode(base, N("c"), ["c"]), /itself as a parent/);
		// a→b exists; adding node x with parent b gives b→x — fine. But a NEW
		// node whose parents would create a cycle can't happen (new nodes have no
		// incoming edges yet) — the cycle case is covered via addEdge below.
	});

	it("updateNode patches title/summary and requires an existing node", () => {
		let t = tree(["a"]);
		t = updateNode(t, "a", { title: "A2" });
		assert.equal(t.nodes[0]!.title, "A2");
		assert.equal(t.version, 2);
		t = updateNode(t, "a", { summary: "what it covers" });
		assert.equal(t.nodes[0]!.summary, "what it covers");
		assert.equal(t.nodes[0]!.title, "A2");
		assert.equal(t.version, 3);
		assertReject(() => updateNode(t, "ghost", { title: "x" }), /Cannot update node "ghost"/);
	});

	it("removeNode cascades: edges both directions, currentNodeId, doneNodeIds", () => {
		// a→b→c, b current, a+b done.
		let t = tree(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
		t = setCurrent(t, "b");
		t = markDone(t, "a");
		t = markDone(t, "b");
		t = removeNode(t, "b");
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "c"]);
		assert.deepEqual(t.edges, []); // both edges touched b
		assert.equal(t.currentNodeId, null); // b was current
		assert.deepEqual(t.doneNodeIds, ["a"]); // b's done entry gone
		assert.equal(t.version, 5);
		assertReject(() => removeNode(t, "b"), /Cannot remove node "b"/);
	});

	it("addEdge validates: unknown endpoints, self-loop, duplicate, cycle", () => {
		const t = tree(["a", "b", "c"], [["a", "b"]]);
		assertReject(() => addEdge(t, "a", "ghost"), /unknown node id "ghost"/);
		assertReject(() => addEdge(t, "ghost", "a"), /unknown node id "ghost"/);
		assertReject(() => addEdge(t, "a", "a"), /self-loop/);
		assertReject(() => addEdge(t, "a", "b"), /already exists/);
		// a→b exists; b→a closes the loop.
		assertReject(() => addEdge(t, "b", "a"), /cycle/);
	});

	it("addEdge rejects an indirect cycle (A→B→C then C→A)", () => {
		const t = tree(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
		assertReject(() => addEdge(t, "c", "a"), /cycle/);
		// The reverse direction is fine (c already depends on a transitively).
		const ok = addEdge(t, "a", "c");
		assert.deepEqual(ok.edges, [E("a", "b"), E("b", "c"), E("a", "c")]);
		assert.equal(ok.version, 2);
	});

	it("removeEdge requires the edge to exist", () => {
		const t = tree(["a", "b"], [["a", "b"]]);
		const next = removeEdge(t, "a", "b");
		assert.deepEqual(next.edges, []);
		assert.equal(next.version, 2);
		assertReject(() => removeEdge(next, "a", "b"), /no such edge/);
	});

	it("setCurrent requires an existing node and never touches doneNodeIds", () => {
		let t = tree(["a", "b"]);
		t = markDone(t, "a");
		t = setCurrent(t, "b");
		assert.equal(t.currentNodeId, "b");
		assert.deepEqual(t.doneNodeIds, ["a"]); // untouched
		assert.equal(t.version, 3);
		assertReject(() => setCurrent(t, "ghost"), /Cannot set current node "ghost"/);
	});

	it("setCurrent on the already-current node is a true no-op (no version bump)", () => {
		let t = tree(["a"]);
		t = setCurrent(t, "a");
		const version = t.version;
		const again = setCurrent(t, "a");
		assert.equal(again.version, version);
		assert.equal(again, t); // same object: nothing changed
	});

	it("markDone requires an existing node and is idempotent", () => {
		let t = tree(["a"]);
		t = markDone(t, "a");
		assert.deepEqual(t.doneNodeIds, ["a"]);
		const version = t.version;
		const again = markDone(t, "a");
		assert.equal(again.version, version);
		assert.equal(again, t); // same object: nothing changed
		assertReject(() => markDone(t, "ghost"), /Cannot mark node "ghost" done/);
	});

	it("every op returns a new tree object (no mutation of the input)", () => {
		const t = tree(["a", "b", "c"], [["a", "b"]]);
		const snapshot = JSON.stringify(t);
		addNode(t, N("d"), ["b"]);
		updateNode(t, "a", { title: "X" });
		removeNode(t, "a");
		addEdge(t, "b", "c");
		removeEdge(t, "a", "b");
		setCurrent(t, "b");
		markDone(t, "b");
		assert.equal(JSON.stringify(t), snapshot);
	});
});

// ─── 2. tool execute against the real store ─────────────────────────────────

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

/** Call a plan tool's execute directly with a minimal execution-options object. */
async function exec(tools: ReturnType<typeof planTools>, name: string, input: unknown): Promise<PlanToolResult> {
	const t = tools[name]!;
	assert.ok(typeof t.execute === "function", `${name} must be a server-side tool with execute`);
	return t.execute(input as never, { toolCallId: "test", messages: [] } as never) as Promise<PlanToolResult>;
}

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

describe("plan_init — the author-once mermaid tool (execute against the real store)", () => {
	it("parses a mermaid block, builds the tree, persists, returns the full tree", async () => {
		const chatId = newChat("Plan: init");
		const tools = planTools({ chatId, chatStore });

		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  primitives[Number primitives] --> operators[Arithmetic operators]\n  operators --> expressions[Evaluating expressions]\n  detour[Side quest]\n",
		});
		assert.equal(res.ok, true);
		assert.equal(res.error, undefined);
		assert.equal(res.tree.version, 1);
		assert.deepEqual(
			res.tree.nodes.map((n) => n.id),
			["primitives", "operators", "expressions", "detour"],
		);
		assert.deepEqual(res.tree.edges, [
			{ from: "primitives", to: "operators" },
			{ from: "operators", to: "expressions" },
		]);

		const saved = chatStore.getChat(chatId)!.tree;
		assert.ok(saved, "tree persisted to the chat record");
		assert.deepEqual(saved, res.tree);
	});

	it("RE-CALLABLE: a rewrite replaces the tree wholesale (the mutation tools are gone)", async () => {
		const chatId = newChat("Plan: rewrite");
		const tools = planTools({ chatId, chatStore });
		await exec(tools, "plan_init", {
			mermaid: "graph TD\n  a[First attempt] --> b[Early shape]\n",
		});

		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  truth[The core truth]\n  goal[The sink] --> truth\n",
		});
		assert.equal(res.ok, true, "re-init is the sanctioned rewrite path now");
		assert.deepEqual(
			res.tree.nodes.map((n) => n.id),
			["truth", "goal"],
		);
		assert.deepEqual(
			chatStore.getChat(chatId)!.tree!.nodes.map((n) => n.id),
			["truth", "goal"],
			"rewrite persisted",
		);
	});

	it("parse failures collect EVERY problem with line numbers and persist nothing", async () => {
		const chatId = newChat("Plan: bad parse");
		const tools = planTools({ chatId, chatStore });

		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  Foo Bar[x] --> y\n  a --> a\n  subgraph hi\n",
		});
		assert.equal(res.ok, false);
		const err = res.error!;
		assert.match(err, /line 2/);
		assert.match(err, /line 3/);
		assert.match(err, /line 4/);
		assert.deepEqual(res.tree, emptyTree());
		assert.equal(chatStore.getChat(chatId)!.tree, undefined, "nothing persisted on failure");
	});

	it("structural failures (cycle) become ok:false without persisting", async () => {
		const chatId = newChat("Plan: cycle");
		const tools = planTools({ chatId, chatStore });
		const res = await exec(tools, "plan_init", {
			mermaid: "graph TD\n  a[A] --> b[B]\n  b --> a\n",
		});
		assert.equal(res.ok, false);
		assert.match(res.error!, /cycle/);
		assert.deepEqual(res.tree, emptyTree());
	});

	it("only plan_init exists — the seven mutation/tracking tools are gone by design", () => {
		const tools = planTools({ chatId: "chat_x", chatStore });
		assert.deepEqual(Object.keys(tools), ["plan_init"]);
	});

	it("unknown chat returns ok:false with the empty tree", async () => {
		const tools = planTools({ chatId: "chat_nonexistent", chatStore });
		const res = await exec(tools, "plan_init", { mermaid: "graph TD\n  a[A]\n" });
		assert.equal(res.ok, false);
		assert.match(res.error!, /Chat not found/);
		assert.deepEqual(res.tree, emptyTree());
	});
});

// ─── the mermaid subset parser ────────────────────────────────────────────────

describe("parseMermaidPlan (the constrained mermaid subset)", () => {
	const parse = (m: string) => parseMermaidPlan(m);

	it("accepts graph TD and flowchart TB headers (case-insensitive), comments, and blank lines", () => {
		for (const header of ["graph TD", "graph td", "flowchart TB", "Flowchart td"]) {
			const res = parse(`${header}\n%% a comment\n\n  a[Alpha]\n`);
			assert.equal(res.ok, true, header);
			assert.deepEqual(res.plan!.nodes, [{ id: "a", title: "Alpha" }]);
		}
	});

	it("bare ids fall back to id-as-title; bracket and paren labels both work", () => {
		const res = parse("graph TD\n  bare\n  bracket[Bracket title]\n  paren(\"Paren title\")\n");
		assert.deepEqual(res.plan!.nodes, [
			{ id: "bare", title: "bare" },
			{ id: "bracket", title: "Bracket title" },
			{ id: "paren", title: "Paren title" },
		]);
	});

	it("edges register bare endpoints as nodes and dedupe duplicate edges", () => {
		const res = parse("graph TD\n  a --> b[Bee]\n  a --> b[Bee]\n");
		assert.deepEqual(res.plan!.nodes, [
			{ id: "a", title: "a" },
			{ id: "b", title: "Bee" },
		]);
		assert.deepEqual(res.plan!.edges, [{ from: "a", to: "b" }]);
	});

	it("labels on both edge endpoints survive; forward references are fine", () => {
		const res = parse("graph TD\n  downstream[Later thing] --> upstream[Earlier thing]\n");
		assert.deepEqual(res.plan!.edges, [{ from: "downstream", to: "upstream" }]);
		assert.deepEqual(res.plan!.nodes, [
			{ id: "downstream", title: "Later thing" },
			{ id: "upstream", title: "Earlier thing" },
		]);
	});

	it("rejects: non-slug ids, self-loops, chained edges, subgraphs, missing header, empty", () => {
		assert.ok(!parse("graph TD\n  Foo Bar[x]\n").ok, "id with a space");
		assert.match(parse("graph TD\n  Foo Bar[x]\n").problems[0]!, /line 2.*slug/);
		assert.ok(!parse("graph TD\n  a --> a\n").ok, "self-loop");
		assert.ok(!parse("graph TD\n  a --> b --> c\n").ok, "chained edge");
		assert.match(parse("graph TD\n  a --> b --> c\n").problems[0]!, /one edge per line/);
		assert.ok(!parse("graph TD\n  subgraph cluster\n").ok, "subgraph");
		assert.ok(!parse("digraph G\n  a\n").ok, "wrong header");
		assert.ok(!parse("%% only a comment\n").ok, "empty plan");
	});

	it("the first label wins when a node line repeats (relabeling mid-block is ignored)", () => {
		const res = parse("graph TD\n  a[First label]\n  a[Second label]\n");
		assert.deepEqual(res.plan!.nodes, [{ id: "a", title: "First label" }]);
	});
});

// ─── derived statuses (the tracking the teacher no longer does) ───────────────

describe("derivePlanStatuses (statuses derive from checks, never declarations)", () => {
	const tree: PlanTree = {
		nodes: [
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
			{ id: "c", title: "C" },
		],
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		],
		currentNodeId: null,
		doneNodeIds: [],
		version: 1,
	};
	const quizPart = (state: string, nodeId: string | undefined, correct?: boolean) => ({
		type: "tool-quiz",
		state,
		input: nodeId === undefined ? {} : { nodeId },
		output: correct === undefined ? undefined : { correct },
	});
	type QuizPart = { type: string; state: string; input: unknown; output?: unknown };
	const msg = (...parts: QuizPart[]) => ({ parts });

	it("empty transcript → current = first node (authoring order, no prereqs), nothing done", () => {
		const st = derivePlanStatuses(tree, []);
		assert.equal(st.current, "a");
		assert.equal(st.done.size, 0);
	});

	it("a passed check on a tags it done; current advances to the next topologically-ready node", () => {
		const st = derivePlanStatuses(tree, [msg(quizPart("output-available", "a", true))]);
		assert.deepEqual([...st.done], ["a"]);
		assert.equal(st.current, "b");
	});

	it("a pending check OWNS current, wherever the topo frontier is", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("input-available", "c")), // a jump check on the sink
		]);
		assert.equal(st.current, "c", "the open check is where we are");
		assert.deepEqual([...st.done], ["a"]);
	});

	it("a FAILED check marks nothing done (explaining is yours, done is theirs)", () => {
		const st = derivePlanStatuses(tree, [msg(quizPart("output-available", "a", false))]);
		assert.equal(st.done.size, 0);
		assert.equal(st.current, "a", "frontier unmoved — resume teaching");
	});

	it("untagged checks and unknown nodeIds are lost signal — ignored", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", undefined, true)),
			msg(quizPart("output-available", "ghost", true)),
		]);
		assert.equal(st.done.size, 0);
		assert.equal(st.current, "a");
	});

	it("prereqs gate the frontier: c isn't next until b is demonstrated", () => {
		const st = derivePlanStatuses(tree, [msg(quizPart("output-available", "a", true))]);
		assert.equal(st.current, "b", "c requires b");
		const st2 = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "b", true)),
		]);
		assert.equal(st2.current, "c");
		assert.equal(derivedNodeStatus(st2, "a"), "done");
		assert.equal(derivedNodeStatus(st2, "c"), "current");
		assert.equal(derivedNodeStatus(st2, "b"), "done");
	});

	it("a rewritten map keeps honest progress for reused slugs (derivation matches the CURRENT tree)", () => {
		const rewritten: PlanTree = { ...tree, nodes: [tree.nodes[0]!, tree.nodes[1]!] };
		const st = derivePlanStatuses(rewritten, [msg(quizPart("output-available", "a", true))]);
		assert.equal(st.current, "b");
		const orphaned = derivePlanStatuses(rewritten, [msg(quizPart("output-available", "c", true))]);
		assert.equal(orphaned.done.size, 0, "a slug removed from the rewrite stops counting");
	});
});
