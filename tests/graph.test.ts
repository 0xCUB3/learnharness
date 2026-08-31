/**
 * Graph store + emission tests (W4; vision §1, contracts.ts "v1 emission").
 *
 * Ledger isolation: PATHS is fixed at import time, so the five data/graph
 * ledgers are backed up and cleared before the suite and restored after
 * (try/finally-shaped: the after() hook always runs, even on failure).
 * The chat fixtures are real ChatRecords in the chat store (created and
 * deleted by this suite) — emission reads exactly what production reads.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import type { UIMessage } from "ai";
import type { PlanTree, PlanToolResult } from "../src/core/contracts.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { createTree, markDone, removeNode } from "../src/core/plan-tree.ts";
import { emitChat, foldStaleChats, getGraph, graphSnapshot, type GraphDeps } from "../src/core/graph.ts";
import { graphStore } from "../src/store/graph.ts";
import { chatStore } from "../src/store/chats.ts";
import { LEDGER_FILES, PATHS } from "../config.ts";

/** The wired fs adapters, exactly what src/server/stores.ts passes in production. */
const graphDeps = { chatStore, graphStore } as const satisfies GraphDeps;

// ─── ledger isolation (backup-and-clear of data/graph/*.jsonl) ──────────────

const LEDGER_PATHS = Object.values(LEDGER_FILES);
const backups: Array<{ file: string; bak: string }> = [];
const createdChats: string[] = [];

fs.mkdirSync(PATHS.graph, { recursive: true });
for (const file of LEDGER_PATHS) {
	if (fs.existsSync(file)) {
		const bak = `${file}.w4test.bak`;
		fs.renameSync(file, bak);
		backups.push({ file, bak });
	}
}

after(() => {
	for (const file of LEDGER_PATHS) {
		try {
			fs.unlinkSync(file);
		} catch {
			/* nothing was written here */
		}
	}
	for (const { file, bak } of backups) fs.renameSync(bak, file);
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});

// ─── fixture builders ────────────────────────────────────────────────────────

function assistant(id: string, parts: unknown[]): UIMessage {
	return { id, role: "assistant", parts } as unknown as UIMessage;
}

function user(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function quizPart(
	toolCallId: string,
	input: Record<string, unknown>,
	output: QuestionAnswerData,
): unknown {
	return { type: "tool-quiz", toolCallId, state: "output-available", input, output };
}

function planPart(toolCallId: string, name: string, input: Record<string, unknown>, tree: PlanTree): unknown {
	return {
		type: `tool-${name}`,
		toolCallId,
		state: "output-available",
		input,
		output: { ok: true, tree } satisfies PlanToolResult,
	};
}

function answer(over: Partial<QuestionAnswerData>): QuestionAnswerData {
	return {
		questionId: "q",
		kind: "quiz",
		questionText: "question text",
		dontKnow: false,
		answers: [],
		answeredAt: "2026-08-22T00:00:00.000Z",
		...over,
	};
}

/** Create a chat in the real store with a tree and messages; returns the record. */
function fixtureChat(title: string, tree: PlanTree | null, messages: UIMessage[]) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	if (tree) chatStore.saveTree(chat.id, tree);
	chatStore.saveMessages(chat.id, messages);
	return chatStore.getChat(chat.id)!;
}

/** The fixture tree: alpha → beta, gamma free-floating, alpha done. */
function fixtureTree(): PlanTree {
	return markDone(
		createTree(
			[
				{ id: "alpha", title: "Alpha intuition" },
				{ id: "beta", title: "Beta rule" },
				{ id: "gamma", title: "Gamma application" },
			],
			[{ from: "alpha", to: "beta" }],
		),
		"alpha",
	);
}

/** The full fixture transcript: probes → plan → checks → mark_done → noise. */
function fixtureMessages(tree: PlanTree): UIMessage[] {
	return [
		user("u1", "teach me the fixture topic"),
		assistant("a1", [
			quizPart(
				"call-1",
				{ question: "Q1", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-1", questionText: "Q1 text", correct: false, answeredAt: "2026-08-22T01:00:00.000Z" }),
			),
		]),
		assistant("a2", [
			quizPart(
				"call-2",
				{ question: "Q2", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-2", questionText: "Q2 text", dontKnow: true, correct: false, answeredAt: "2026-08-22T01:01:00.000Z" }),
			),
		]),
		assistant("a3", [planPart("p1", "plan_init", { nodes: [], edges: [] }, tree)]),
		assistant("a4", [
			quizPart(
				"call-3",
				{ question: "Q3", nodeId: "alpha", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-3", questionText: "Q3 text", correct: true, note: "recalled the diagram", answeredAt: "2026-08-22T02:00:00.000Z" }),
			),
		]),
		assistant("a5", [
			quizPart(
				"call-4",
				{ question: "Q4", nodeId: "beta", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-4", questionText: "Q4 text", correct: false, answeredAt: "2026-08-22T02:01:00.000Z" }),
			),
		]),
		assistant("a6", [
			// nodeId present but NOT in the tree → unmapped → null + question text
			quizPart(
				"call-5",
				{ question: "Q5", nodeId: "ghost", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-5", questionText: "Q5 text", dontKnow: true, correct: false, answeredAt: "2026-08-22T02:02:00.000Z" }),
			),
		]),
		assistant("a7", [planPart("p2", "plan_mark_done", { id: "alpha" }, tree)]),
		assistant("a8", [
			// dismissed quiz + an answered ask — neither emits an event
			quizPart(
				"call-6",
				{ question: "Q6", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-6", questionText: "Q6 text", dismissed: true }),
			),
			{
				type: "tool-ask_user_question",
				toolCallId: "call-7",
				state: "output-available",
				input: { question: "free text?" },
				output: answer({ questionId: "call-7", kind: "ask", questionText: "free text?", text: "because" }),
			},
		]),
	];
}

/** The chat every emission test folds (shared, so ordering is intentional). */
const chat1 = fixtureChat("Graph fixture", fixtureTree(), fixtureMessages(fixtureTree()));

/** Set by the provenance test; the snapshot test (which runs after it) reads it. */
let chat2Id = "";

// ─── emission ────────────────────────────────────────────────────────────────

/** Everything the graph holds for a set of chats (other processes' test
 *  emissions run concurrently against the same files — scope, never assume). */
function scopedGraph(chatIds: string[]) {
	const graph = getGraph(graphStore);
	const nodeIds = new Set(
		graphStore
			.readMappings()
			.filter((m) => chatIds.includes(m.chatId))
			.map((m) => m.graphNodeId),
	);
	return {
		nodes: graph.nodes.filter((n) => nodeIds.has(n.id)),
		edges: graph.edges.filter((e) => e.provenance.some((c) => chatIds.includes(c))),
		events: graph.events.filter((e) => chatIds.includes(e.chatId)),
	};
}

describe("graph emission (emitChat)", () => {
	it("folds tree nodes/edges and quiz/mark_done events with the probe/check boundary", () => {
		const stats = emitChat(chat1.id, graphDeps);
		assert.deepEqual(stats, { nodes: 3, edges: 1, events: 6 });

		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		const idByStatement = new Map(graph.nodes.map((n) => [n.statement, n.id]));
		for (const node of graph.nodes) {
			assert.equal(node.kind, "truth");
			assert.deepEqual(node.aliases, []);
			assert.match(node.id, /^n_/);
		}

		// Tree edge alpha→beta becomes a `requires` edge on the mapped nodes.
		assert.equal(graph.edges.length, 1);
		const edge = graph.edges[0]!;
		assert.equal(edge.from, idByStatement.get("Alpha intuition"));
		assert.equal(edge.to, idByStatement.get("Beta rule"));
		assert.equal(edge.type, "requires");
		assert.deepEqual(edge.provenance, [chat1.id]);

		// Events — kinds, refs, node attribution, notes, question fallback.
		assert.equal(graph.events.length, 6);
		const byRef = new Map(graph.events.map((e) => [e.ref, e]));

		const probeMiss = byRef.get("call-1")!;
		assert.equal(probeMiss.kind, "probe-miss"); // quiz BEFORE plan_init
		assert.equal(probeMiss.nodeId, null);
		assert.equal(probeMiss.question, "Q1 text");
		assert.equal(probeMiss.chatId, chat1.id);

		const probeDontKnow = byRef.get("call-2")!;
		assert.equal(probeDontKnow.kind, "dont-know"); // same kind, both phases
		assert.equal(probeDontKnow.nodeId, null);

		const check = byRef.get("call-3")!;
		assert.equal(check.kind, "check-correct"); // quiz AFTER plan_init
		assert.equal(check.nodeId, idByStatement.get("Alpha intuition"));
		assert.equal(check.note, "recalled the diagram");
		assert.equal(check.question, undefined); // resolved nodeId → no question text

		const checkMiss = byRef.get("call-4")!;
		assert.equal(checkMiss.kind, "check-incorrect");
		assert.equal(checkMiss.nodeId, idByStatement.get("Beta rule"));

		const unmapped = byRef.get("call-5")!;
		assert.equal(unmapped.kind, "dont-know");
		assert.equal(unmapped.nodeId, null); // nodeId present but unmapped
		assert.equal(unmapped.question, "Q5 text");

		const taught = byRef.get("taught:alpha")!;
		assert.equal(taught.kind, "taught");
		assert.equal(taught.nodeId, idByStatement.get("Alpha intuition"));

		// The dismissed quiz and the ask question emitted nothing.
		assert.equal([...byRef.keys()].filter((r) => r === "call-6" || r === "call-7").length, 0);
	});

	it("is idempotent — re-emission appends nothing", () => {
		const stats = emitChat(chat1.id, graphDeps);
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 0 });
		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		assert.equal(graph.edges.length, 1);
		assert.equal(graph.events.length, 6);
		// exactly one checkpoint line per fold, though — checkpoints are a log
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === chat1.id).length, 2);
	});

	it("accumulates edge provenance when another chat maps onto the same nodes", () => {
		// Simulates what a future consolidation merge produces: chat2's tree
		// slugs map onto chat1's graph nodes, so its edge assertion dedupes
		// by (from,to,type) and just adds chat2 to the provenance.
		const tree2 = createTree(
			[
				{ id: "alpha", title: "Alpha (second session)" },
				{ id: "beta", title: "Beta (second session)" },
			],
			[{ from: "alpha", to: "beta" }],
		);
		const chat2 = fixtureChat("Graph fixture 2", tree2, [
			user("u1", "again"),
			assistant("a1", [planPart("p1", "plan_init", { nodes: [], edges: [] }, tree2)]),
		]);

		const before = getGraph(graphStore);
		const gAlpha = before.nodes.find((n) => n.statement === "Alpha intuition")!.id;
		const gBeta = before.nodes.find((n) => n.statement === "Beta rule")!.id;
		graphStore.appendMapping({ chatId: chat2.id, treeNodeId: "alpha", graphNodeId: gAlpha });
		graphStore.appendMapping({ chatId: chat2.id, treeNodeId: "beta", graphNodeId: gBeta });

		const stats = emitChat(chat2.id, graphDeps);
		assert.deepEqual(stats, { nodes: 0, edges: 1, events: 0 });
		chat2Id = chat2.id;

		const after = scopedGraph([chat1.id, chat2.id]);
		assert.equal(after.nodes.length, 3); // no duplicate nodes
		assert.equal(after.edges.length, 1); // one merged edge…
		assert.deepEqual(after.edges[0]!.provenance, [chat1.id, chat2.id]); // …two sessions
	});

	it("derives node states, sessions, and node provenance in graphSnapshot", () => {
		const snap = graphSnapshot(graphDeps);
		const idByStatement = new Map(snap.nodes.map((n) => [n.statement, n.id]));
		assert.equal(snap.nodeStates[idByStatement.get("Alpha intuition")!], "taught");
		assert.equal(snap.nodeStates[idByStatement.get("Beta rule")!], "missed");
		assert.equal(snap.nodeStates[idByStatement.get("Gamma application")!], "candidate");

		assert.equal(snap.sessions[chat1.id], "Graph fixture");
		assert.equal(snap.sessions[chat2Id], "Graph fixture 2");
		assert.deepEqual(
			(snap.nodeSessions[idByStatement.get("Alpha intuition")!] ?? []).sort(),
			[chat1.id, chat2Id].sort(),
		);
		// Gamma was only ever created (mapping) by chat1.
		assert.deepEqual(snap.nodeSessions[idByStatement.get("Gamma application")!], [chat1.id]);
	});

	it("replays plan tool outputs when record.tree is missing (removed nodes stay out)", () => {
		const initTree = createTree(
			[
				{ id: "x", title: "X live" },
				{ id: "y", title: "Y pruned" },
			],
			[{ from: "x", to: "y" }],
		);
		const prunedTree = removeNode(initTree, "y");
		const chat = fixtureChat("Replay fixture", null, [
			user("u1", "go"),
			assistant("a1", [planPart("p1", "plan_init", { nodes: [], edges: [] }, initTree)]),
			assistant("a2", [planPart("p2", "plan_remove_node", { id: "y" }, prunedTree)]),
		]);

		const stats = emitChat(chat.id, graphDeps);
		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 0 }); // y pruned, edge cascaded away

		const graph = scopedGraph([chat.id]);
		assert.ok(graph.nodes.some((n) => n.statement === "X live"));
		assert.ok(!graph.nodes.some((n) => n.statement === "Y pruned"));
	});

	it("returns zeros for unknown chats", () => {
		assert.deepEqual(emitChat("chat_does_not_exist", graphDeps), { nodes: 0, edges: 0, events: 0 });
	});
});

// chat2 from the provenance test, reachable by the snapshot test below it.

describe("catch-up (foldStaleChats)", () => {
	it("folds chats newer than their checkpoint, exactly once, deriving known state", () => {
		const tree = createTree([{ id: "solo", title: "Solo node" }], []);
		const chat = fixtureChat("Catch-up fixture", tree, [
			user("u1", "go"),
			assistant("a1", [planPart("p1", "plan_init", { nodes: [], edges: [] }, tree)]),
			assistant("a2", [
				quizPart(
					"call-s",
					{ question: "QS", nodeId: "solo", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionId: "call-s", questionText: "QS text", correct: true, answeredAt: "2026-08-22T03:00:00.000Z" }),
				),
			]),
		]);

		const folded = foldStaleChats(graphDeps);
		assert.ok(folded >= 1, "the catch-up fixture was folded");
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === chat.id).length, 1);

		const snap = graphSnapshot(graphDeps);
		const solo = snap.nodes.find((n) => n.statement === "Solo node");
		assert.ok(solo, "solo node was emitted by the catch-up fold");
		assert.equal(snap.nodeStates[solo.id], "known"); // correct check, no taught event
		assert.equal(snap.sessions[chat.id], "Catch-up fixture");

		// Already checkpointed → not folded again (other test files' chats may
		// legitimately fold here, so assert on THIS chat only).
		foldStaleChats(graphDeps);
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === chat.id).length, 1);
	});
});

// ─── store primitives ────────────────────────────────────────────────────────

describe("graph ledger store", () => {
	it("round-trips lines and skips corrupt / foreign-shaped lines (strict reads)", () => {
		const node = { id: "n_storetest", statement: "Store test", aliases: [], kind: "truth" as const, createdAt: "2026-08-22T00:00:00.000Z" };
		graphStore.appendNode(node);
		// A torn append and a legacy V0-shaped node (different schema) — both skipped.
		fs.appendFileSync(
			LEDGER_FILES.nodes,
			`{not json}\n${JSON.stringify({ id: "legacy", statement: "Legacy shape", domain: "x", state: "known" })}\n`,
			"utf-8",
		);
		const nodes = graphStore.readNodes().filter((n) => n.id === "n_storetest" || n.id === "legacy");
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0]!.statement, "Store test");
	});
});
