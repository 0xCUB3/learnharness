/**
 * Graph merger + trigger + derivation tests (vision §1; contracts.ts
 * "extraction pipeline"). The merger (core/graph.ts mergeFindings) is the
 * pipeline's deterministic apply stage: findings in, ledger appends out —
 * identity resolution, retroactive probe attribution, event rebuild, and
 * the idempotency guarantees.
 *
 * Ledger isolation: PATHS is fixed at import time, so the five data/graph
 * ledgers are backed up and cleared before the suite and restored after
 * (try/finally-shaped: the after() hook always runs, even on failure).
 * The chat fixtures are real ChatRecords in the chat store (created and
 * deleted by this suite) — the merger reads exactly what production reads.
 * The full LLM pipeline (extractor → auditor) is tested in
 * tests/extraction.test.ts with mock models.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import type { UIMessage } from "ai";
import type { PlanTree, PlanToolResult, SessionFindings } from "../src/core/contracts.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { createTree, markDone } from "../src/core/plan-tree.ts";
import { getGraph, graphSnapshot, mergeFindings, pendingQuizAnswers, type GraphDeps } from "../src/core/graph.ts";
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
		const bak = `${file}.w5test.bak`;
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

/**
 * Findings shaped exactly like what the extractor would produce for a
 * session's plan tree: one proposition per tree node (statement = title,
 * treeNodeId set), one `requires` edge per tree edge.
 */
function treeFindings(tree: PlanTree): SessionFindings {
	const idByNodeId = new Map(tree.nodes.map((n, i) => [n.id, `p${i + 1}`]));
	return {
		propositions: tree.nodes.map((n, i) => ({
			id: `p${i + 1}`,
			name: n.title,
			statement: n.title,
			aliases: [],
			kind: "truth" as const,
			treeNodeId: n.id,
			evidence: ["fixture evidence"],
		})),
		edges: tree.edges.map((e) => ({
			from: idByNodeId.get(e.from)!,
			to: idByNodeId.get(e.to)!,
			type: "requires" as const,
			evidence: ["fixture evidence"],
		})),
		attribution: { quiz: {} },
	};
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
			// nodeId present but NOT in the tree → tagged-but-unmapped: the
			// attribution can rescue it, or it lands null + question text.
			quizPart(
				"call-5",
				{ question: "Q5", nodeId: "ghost", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-5", questionText: "Q5 text", dontKnow: true, correct: false, answeredAt: "2026-08-22T02:02:00.000Z" }),
			),
		]),
		assistant("a7", [planPart("p2", "plan_mark_done", { id: "alpha" }, tree)]),
		assistant("a8", [
			// dismissed quiz + an answered ask — neither becomes an event
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

/**
 * The extractor's findings for the fixture chat: the tree as propositions +
 * the probe attribution. The audit stage is a no-op pass-through in these
 * merger tests — its behavior is tested with the pipeline (extraction.test).
 */
function fixtureFindings(): SessionFindings {
	const findings = treeFindings(fixtureTree());
	// Untagged probe quizzes: call-1 attributed retroactively to Alpha (the
	// vision's open question — resolved by the extractor); call-2 genuinely
	// unattributable; call-5's ghost nodeId is rescued onto Gamma.
	findings.attribution.quiz = { "call-1": "p1", "call-2": null, "call-5": "p3" };
	return findings;
}

/** The chat every merger test folds (shared, so ordering is intentional). */
const chat1 = fixtureChat("Graph fixture", fixtureTree(), fixtureMessages(fixtureTree()));

/** Set by the cross-session test; the snapshot test (which runs after it) reads it. */
let chat2Id = "";

// ─── the merger ──────────────────────────────────────────────────────────────

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

describe("the merger (mergeFindings)", () => {
	it("merges propositions/edges by identity and rebuilds events with retroactive probe attribution", () => {
		const stats = mergeFindings(chat1.id, fixtureFindings(), graphDeps);
		assert.deepEqual(stats, { nodes: 3, edges: 1, events: 6 });

		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		const idByStatement = new Map(graph.nodes.map((n) => [n.statement, n.id]));
		for (const node of graph.nodes) {
			assert.equal(node.kind, "truth");
			assert.deepEqual(node.aliases, []);
			assert.match(node.id, /^n_/);
		}

		// The tree edge alpha→beta becomes a `requires` edge on the mapped nodes.
		assert.equal(graph.edges.length, 1);
		const edge = graph.edges[0]!;
		assert.equal(edge.from, idByStatement.get("Alpha intuition"));
		assert.equal(edge.to, idByStatement.get("Beta rule"));
		assert.equal(edge.type, "requires");
		assert.deepEqual(edge.provenance, [chat1.id]);

		// Events — kinds, refs, notes, and the attribution paths.
		assert.equal(graph.events.length, 6);
		const byRef = new Map(graph.events.map((e) => [e.ref, e]));

		const probeMiss = byRef.get("call-1")!;
		assert.equal(probeMiss.kind, "probe-miss"); // quiz BEFORE plan_init
		assert.equal(probeMiss.nodeId, idByStatement.get("Alpha intuition"), "retroactive probe attribution");
		assert.equal(probeMiss.question, undefined, "attributed → no question text needed");

		const probeDontKnow = byRef.get("call-2")!;
		assert.equal(probeDontKnow.kind, "dont-know"); // same kind, both phases
		assert.equal(probeDontKnow.nodeId, null, "unattributable probe → null");
		assert.equal(probeDontKnow.question, "Q2 text");

		const check = byRef.get("call-3")!;
		assert.equal(check.kind, "check-correct"); // quiz AFTER plan_init
		assert.equal(check.nodeId, idByStatement.get("Alpha intuition"), "tagged quiz → deterministic");
		assert.equal(check.note, "recalled the diagram");

		const checkMiss = byRef.get("call-4")!;
		assert.equal(checkMiss.kind, "check-incorrect");
		assert.equal(checkMiss.nodeId, idByStatement.get("Beta rule"));

		const ghost = byRef.get("call-5")!;
		assert.equal(ghost.kind, "dont-know");
		assert.equal(ghost.nodeId, idByStatement.get("Gamma application"), "tagged-but-unmapped rescued by attribution");
		assert.equal(ghost.question, undefined);

		const taught = byRef.get("taught:alpha")!;
		assert.equal(taught.kind, "taught");
		assert.equal(taught.nodeId, idByStatement.get("Alpha intuition"), "mark_done → tree-node mapping");

		// The dismissed quiz and the ask question became nothing.
		assert.equal([...byRef.keys()].filter((r) => r === "call-6" || r === "call-7").length, 0);
	});

	it("is idempotent — re-merging the same findings appends nothing", () => {
		const stats = mergeFindings(chat1.id, fixtureFindings(), graphDeps);
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 0 });
		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		assert.equal(graph.edges.length, 1);
		assert.equal(graph.events.length, 6);
		// exactly one checkpoint line per merge, though — checkpoints are a log
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === chat1.id).length, 2);
	});

	it("merges a second session onto the same nodes and accumulates edge provenance", () => {
		// chat2 re-teaches the same two propositions (identical statements) —
		// the conservative identity resolution recognizes them.
		const tree2 = createTree(
			[
				{ id: "a", title: "Alpha intuition" },
				{ id: "b", title: "Beta rule" },
			],
			[{ from: "a", to: "b" }],
		);
		const chat2 = fixtureChat("Graph fixture 2", tree2, [
			user("u1", "again"),
			assistant("a1", [planPart("p1", "plan_init", { nodes: [], edges: [] }, tree2)]),
		]);

		const stats = mergeFindings(chat2.id, treeFindings(tree2), graphDeps);
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
		// Gamma: no taught/checks — but the rescued dont-know probe (call-5)
		// makes its latest event a dont-know.
		assert.equal(snap.nodeStates[idByStatement.get("Gamma application")!], "dont-know");

		assert.equal(snap.sessions[chat1.id], "Graph fixture");
		assert.equal(snap.sessions[chat2Id], "Graph fixture 2");
		assert.deepEqual(
			(snap.nodeSessions[idByStatement.get("Alpha intuition")!] ?? []).sort(),
			[chat1.id, chat2Id].sort(),
		);
		// Gamma was only ever touched by chat1.
		assert.deepEqual(snap.nodeSessions[idByStatement.get("Gamma application")!], [chat1.id]);
	});

	it("returns zeros for unknown chats", () => {
		assert.deepEqual(mergeFindings("chat_does_not_exist", treeFindings(fixtureTree()), graphDeps), {
			nodes: 0,
			edges: 0,
			events: 0,
		});
	});
});

// ─── the trigger helper ──────────────────────────────────────────────────────

describe("the trigger helper (pendingQuizAnswers)", () => {
	it("counts answered quizzes not yet in the ledger — dismissed/ask never count", () => {
		const tree = createTree([{ id: "solo", title: "Solo node" }], []);
		const chat = fixtureChat("Trigger fixture", tree, [
			user("u1", "go"),
			assistant("a1", [planPart("p1", "plan_init", { nodes: [], edges: [] }, tree)]),
			assistant("a2", [
				quizPart(
					"call-s",
					{ question: "QS", nodeId: "solo", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionId: "call-s", questionText: "QS text", correct: true, answeredAt: "2026-08-22T03:00:00.000Z" }),
				),
				quizPart(
					"call-s2",
					{ question: "QS2", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionId: "call-s2", questionText: "QS2 text", dismissed: true }),
				),
				{
					type: "tool-ask_user_question",
					toolCallId: "call-s3",
					state: "output-available",
					input: { question: "free?" },
					output: answer({ questionId: "call-s3", kind: "ask", questionText: "free?", text: "y" }),
				},
			]),
		]);

		assert.equal(pendingQuizAnswers(chat.id, graphDeps), 1, "one answered quiz pending");
		assert.equal(pendingQuizAnswers("chat_does_not_exist", graphDeps), 0);

		mergeFindings(chat.id, treeFindings(tree), graphDeps);
		assert.equal(pendingQuizAnswers(chat.id, graphDeps), 0, "extracted → nothing pending");

		// A NEW answered quiz raises the count again (the re-trigger path).
		chatStore.saveMessages(chat.id, [
			...chatStore.getChat(chat.id)!.messages,
			assistant("a3", [
				quizPart(
					"call-s4",
					{ question: "QS4", nodeId: "solo", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionId: "call-s4", questionText: "QS4 text", correct: false, answeredAt: "2026-08-22T03:01:00.000Z" }),
				),
			]),
		]);
		assert.equal(pendingQuizAnswers(chat.id, graphDeps), 1);
	});
});

// ─── store primitives ────────────────────────────────────────────────────────

describe("graph ledger store", () => {
	it("round-trips lines and skips corrupt / foreign-shaped lines (strict reads)", () => {
		const node = { id: "n_storetest", name: "Store test", statement: "Store test", aliases: [], kind: "truth" as const, createdAt: "2026-08-22T00:00:00.000Z" };
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
		assert.equal(nodes[0]!.name, "Store test");
	});

	it("derives a name for pre-name ledger lines (legacy reads)", () => {
		// A full, valid node line written before `name` existed.
		fs.appendFileSync(
			LEDGER_FILES.nodes,
			`${JSON.stringify({ id: "n_prename", statement: "Derivatives measure instantaneous change; they are limits.", aliases: [], kind: "truth", createdAt: "2026-08-22T00:00:00.000Z" })}\n`,
			"utf-8",
		);
		const node = graphStore.readNodes().find((n) => n.id === "n_prename");
		assert.ok(node);
		assert.equal(node.name, "Derivatives measure instantaneous change");
	});
});
