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
import type { PlanTree, PlanToolResult } from "../src/core/contracts.ts";
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
import { createChat, getChat } from "../src/store/chats.ts";
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
	const chat = createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

describe("plan tools (execute against the real store)", () => {
	it("plan_init creates and persists the tree; result is ok with the full tree", async () => {
		const chatId = newChat("Plan tools: init");
		const tools = planTools({ chatId });

		const res = await exec(tools, "plan_init", {
			nodes: [
				{ id: "truth", title: "Core truth" },
				{ id: "goal", title: "The goal" },
			],
			edges: [{ from: "truth", to: "goal" }],
		});
		assert.equal(res.ok, true);
		assert.equal(res.error, undefined);
		assert.equal(res.tree.version, 1);
		assert.equal(res.tree.nodes.length, 2);
		assert.deepEqual(res.tree.edges, [{ from: "truth", to: "goal" }]);

		const saved = getChat(chatId)!.tree;
		assert.ok(saved, "tree persisted to the chat record");
		assert.deepEqual(saved, res.tree);
	});

	it("plan_init refuses to re-init and never silently wipes the existing tree", async () => {
		const chatId = newChat("Plan tools: re-init");
		const tools = planTools({ chatId });
		await exec(tools, "plan_init", { nodes: [{ id: "a", title: "A" }] });

		const res = await exec(tools, "plan_init", {
			nodes: [{ id: "totally", title: "Different tree" }],
		});
		assert.equal(res.ok, false);
		assert.equal(res.error, "Tree already initialized — use the mutation tools");
		assert.deepEqual(res.tree.nodes.map((n: { id: string }) => n.id), ["a"], "existing tree returned, not wiped");

		const saved = getChat(chatId)!.tree!;
		assert.deepEqual(saved.nodes.map((n) => n.id), ["a"]);
	});

	it("plan_init returns an error result on invalid input (cycle) without persisting", async () => {
		const chatId = newChat("Plan tools: bad init");
		const tools = planTools({ chatId });
		const res = await exec(tools, "plan_init", {
			nodes: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "a" },
			],
		});
		assert.equal(res.ok, false);
		assert.match(res.error!, /cycle/);
		assert.deepEqual(res.tree, emptyTree());
		assert.equal(getChat(chatId)!.tree, undefined, "nothing persisted on failure");
	});

	it("mutation round-trip: add node with parents, set current, mark done — each persists", async () => {
		const chatId = newChat("Plan tools: round-trip");
		const tools = planTools({ chatId });

		await exec(tools, "plan_init", {
			nodes: [
				{ id: "ratelimit", title: "Token bucket" },
				{ id: "burst", title: "Burst vs steady" },
			],
			edges: [{ from: "ratelimit", to: "burst" }],
		});

		const added = await exec(tools, "plan_add_node", {
			id: "detour",
			title: "Why leaky bucket differs",
			summary: "Learner asked about the leaky-bucket variant.",
			parents: ["ratelimit"],
		});
		assert.equal(added.ok, true);
		assert.deepEqual(
			added.tree.edges.map((e) => `${e.from}→${e.to}`),
			["ratelimit→burst", "ratelimit→detour"],
		);
		assert.equal(added.tree.version, 2);
		assert.deepEqual(getChat(chatId)!.tree!, added.tree, "add_node persisted");

		const current = await exec(tools, "plan_set_current", { id: "detour" });
		assert.equal(current.ok, true);
		assert.equal(current.tree.currentNodeId, "detour");
		assert.equal(getChat(chatId)!.tree!.currentNodeId, "detour", "set_current persisted");

		const done = await exec(tools, "plan_mark_done", { id: "ratelimit" });
		assert.equal(done.ok, true);
		assert.deepEqual(done.tree.doneNodeIds, ["ratelimit"]);
		assert.deepEqual(getChat(chatId)!.tree!.doneNodeIds, ["ratelimit"], "mark_done persisted");
		assert.equal(done.tree.version, 4);
	});

	it("invalid mutations return ok:false with the current tree and persist nothing", async () => {
		const chatId = newChat("Plan tools: invalid ops");
		const tools = planTools({ chatId });
		await exec(tools, "plan_init", { nodes: [{ id: "a", title: "A" }] });
		const before = getChat(chatId)!.tree!;

		const dup = await exec(tools, "plan_add_node", { id: "a", title: "Impostor" });
		assert.equal(dup.ok, false);
		assert.match(dup.error!, /already exists/);
		assert.deepEqual(dup.tree, before);

		const missing = await exec(tools, "plan_set_current", { id: "ghost" });
		assert.equal(missing.ok, false);
		assert.match(missing.error!, /unknown node id "ghost"|not in the tree/);

		const badEdge = await exec(tools, "plan_add_edge", { from: "a", to: "a" });
		assert.equal(badEdge.ok, false);
		assert.match(badEdge.error!, /self-loop/);

		assert.deepEqual(getChat(chatId)!.tree!, before, "record untouched by failed ops");
	});

	it("mutation tools work on a fresh (uninitialized) chat: the tree seeds from empty", async () => {
		const chatId = newChat("Plan tools: no init");
		const tools = planTools({ chatId });
		const res = await exec(tools, "plan_add_node", { id: "a", title: "A" });
		assert.equal(res.ok, true);
		assert.equal(res.tree.nodes.length, 1);
		assert.ok(getChat(chatId)!.tree, "tree seeded without plan_init");
	});

	it("unknown chat returns ok:false with the empty tree", async () => {
		const tools = planTools({ chatId: "chat_nonexistent" });
		const res = await exec(tools, "plan_mark_done", { id: "a" });
		assert.equal(res.ok, false);
		assert.match(res.error!, /Chat not found/);
		assert.deepEqual(res.tree, emptyTree());
	});
});
