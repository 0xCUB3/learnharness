/**
 * Graph merger + trigger + derivation tests (vision §1, 2026-09-02 redesign).
 * The merger (core/graph.ts mergeFindings) is the pipeline's deterministic
 * apply stage: AUDITED VERDICTS in, ledger appends out — link-or-create
 * identity (the auditor's linkTo, never string matching), deterministic quiz
 * events, understanding observations, and the idempotency guarantees.
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
import type { AuditResult } from "../src/core/contracts.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
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

/** Create a chat in the real store with messages; returns the record.
 *  Tree-blind world: the plan tree is irrelevant to the merger — no tree. */
function fixtureChat(title: string, messages: UIMessage[]) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, messages);
	return chatStore.getChat(chat.id)!;
}

/** The full fixture transcript: five graded quizzes + a dismissed one + an ask. */
function fixtureMessages(): UIMessage[] {
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
		assistant("a3", [
			// input.nodeId "alpha" is deliberately present and IGNORED —
			// attribution is the only quiz→node path in the tree-blind world.
			quizPart(
				"call-3",
				{ question: "Q3", nodeId: "alpha", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-3", questionText: "Q3 text", correct: true, note: "recalled the diagram", answeredAt: "2026-08-22T02:00:00.000Z" }),
			),
		]),
		assistant("a4", [
			quizPart(
				"call-4",
				{ question: "Q4", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-4", questionText: "Q4 text", correct: false, answeredAt: "2026-08-22T02:01:00.000Z" }),
			),
		]),
		assistant("a5", [
			quizPart(
				"call-5",
				{ question: "Q5", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
				answer({ questionId: "call-5", questionText: "Q5 text", dontKnow: true, correct: false, answeredAt: "2026-08-22T02:02:00.000Z" }),
			),
		]),
		assistant("a6", [
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

/** The auditor's verdict for the fixture chat: three verified propositions
 *  (no linkTo — the graph starts empty), one follows edge, all quizzes
 *  attributed, one understanding note. */
function fixtureAudit(): AuditResult {
	return {
		propositions: [
			{
				id: "p1",
				name: "Alpha",
				statement: "Alpha intuition",
				aliases: ["alpha feel"],
				messages: ["a1", "a3"],
				evidence: ["fixture evidence"],
				understanding: "solid after the check",
			},
			{
				id: "p2",
				name: "Beta rule",
				statement: "Beta rule",
				aliases: [],
				messages: ["a4"],
				evidence: ["fixture evidence"],
			},
			{
				id: "p3",
				name: "Gamma",
				statement: "Gamma application",
				aliases: [],
				messages: ["a5"],
				evidence: ["fixture evidence"],
			},
		],
		edges: [
			{
				from: "p1",
				to: "p2",
				type: "follows",
				messages: ["a4"],
				evidence: ["fixture evidence"],
			},
		],
		attribution: { quiz: { "call-1": "p1", "call-2": null, "call-3": "p1", "call-4": "p2", "call-5": "p3" } },
		dropped: [],
	};
}

/** The chat every merger test folds (shared, so ordering is intentional). */
const chat1 = fixtureChat("Graph fixture", fixtureMessages());

/** Set by the cross-session tests; the snapshot test (which runs after) reads them. */
let chat2Id = "";
let chat3Id = "";

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
		edges: graph.edges.filter((e) => e.provenance.some((pt) => chatIds.includes(pt.chatId))),
		events: graph.events.filter((e) => chatIds.includes(e.chatId)),
	};
}

describe("the merger (mergeFindings)", () => {
	it("creates nodes from the verdicts, rebuilds quiz events deterministically, records observations", () => {
		const stats = mergeFindings(chat1.id, fixtureAudit(), graphDeps);
		assert.deepEqual(stats, { nodes: 3, edges: 1, events: 6 });

		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		const idByStatement = new Map(graph.nodes.map((n) => [n.statement, n.id]));
		for (const node of graph.nodes) {
			assert.match(node.id, /^n_/);
			assert.ok(node.name.length > 0, "name is required");
			assert.equal("kind" in node, false, "no kind field");
			assert.ok(Array.isArray(node.provenance), "message-granular provenance");
		}
		// Provenance is message-granular: p1 came up in a1 and a3.
		const alpha = graph.nodes.find((n) => n.statement === "Alpha intuition")!;
		assert.deepEqual(alpha.provenance, [
			{ chatId: chat1.id, messageId: "a1" },
			{ chatId: chat1.id, messageId: "a3" },
		]);

		// The follows edge, provenance attached.
		assert.equal(graph.edges.length, 1);
		const edge = graph.edges[0]!;
		assert.equal(edge.from, idByStatement.get("Alpha intuition"));
		assert.equal(edge.to, idByStatement.get("Beta rule"));
		assert.equal(edge.type, "follows");
		assert.deepEqual(edge.provenance, [{ chatId: chat1.id, messageId: "a4" }]);

		// Mapping lines: one per (chat, sourceId).
		assert.deepEqual(
			graphStore.readMappings().map((m) => m.sourceId),
			["p1", "p2", "p3"],
		);

		// Events — kinds, refs, notes, and the attribution paths.
		assert.equal(graph.events.length, 6);
		const byRef = new Map(graph.events.map((e) => [e.ref, e]));

		const miss = byRef.get("call-1")!;
		assert.equal(miss.kind, "miss");
		assert.equal(miss.nodeId, idByStatement.get("Alpha intuition"), "attributed quiz");

		const dontKnow = byRef.get("call-2")!;
		assert.equal(dontKnow.kind, "dont-know");
		assert.equal(dontKnow.nodeId, null, "unattributable → null");
		assert.equal(dontKnow.question, "Q2 text");

		const correct = byRef.get("call-3")!;
		assert.equal(correct.kind, "correct");
		assert.equal(correct.nodeId, idByStatement.get("Alpha intuition"), "attribution wins over the ignored input.nodeId");
		assert.equal(correct.note, "recalled the diagram");

		const miss2 = byRef.get("call-4")!;
		assert.equal(miss2.kind, "miss");
		assert.equal(miss2.nodeId, idByStatement.get("Beta rule"));

		const dontKnow2 = byRef.get("call-5")!;
		assert.equal(dontKnow2.kind, "dont-know");
		assert.equal(dontKnow2.nodeId, idByStatement.get("Gamma application"));

		const observation = byRef.get("obs:p1")!;
		assert.equal(observation.kind, "observation");
		assert.equal(observation.nodeId, idByStatement.get("Alpha intuition"));
		assert.equal(observation.note, "solid after the check");

		// The dismissed quiz and the ask question became nothing.
		assert.equal([...byRef.keys()].filter((r) => r === "call-6" || r === "call-7").length, 0);
	});

	it("is idempotent — re-merging the same verdicts appends nothing", () => {
		const stats = mergeFindings(chat1.id, fixtureAudit(), graphDeps);
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 0 });
		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		assert.equal(graph.edges.length, 1);
		assert.equal(graph.events.length, 6);
		// exactly one checkpoint line per merge, though — checkpoints are a log
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === chat1.id).length, 2);
	});

	it("applies a linkTo verdict: phrasings join aliases, provenance unions, no duplicate node", () => {
		const alphaId = scopedGraph([chat1.id]).nodes.find((n) => n.statement === "Alpha intuition")!.id;
		const chat2 = fixtureChat("Graph fixture 2", [
			user("u1", "again"),
			assistant("a1", [
				quizPart(
					"call-9",
					{ question: "Q9", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionId: "call-9", questionText: "Q9 text", correct: true, answeredAt: "2026-08-22T03:00:00.000Z" }),
				),
			]),
		]);
		chat2Id = chat2.id;

		// The auditor's identity verdict: this proposition IS the alpha node.
		const stats = mergeFindings(
			chat2.id,
			{
				propositions: [
					{
						id: "q1",
						name: "Alpha",
						statement: "Alpha feel", // a DIFFERENT phrasing — identity is the verdict, not strings
						aliases: ["alpha intuition"],
						messages: ["a1"],
						evidence: ["fixture evidence"],
						linkTo: alphaId,
					},
				],
				edges: [],
				attribution: { quiz: { "call-9": "q1" } },
				dropped: [],
			},
			graphDeps,
		);
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 1 });

		const after = scopedGraph([chat1.id, chat2.id]);
		assert.equal(after.nodes.length, 3, "no duplicate node");
		const alpha = getGraph(graphStore).nodes.find((n) => n.id === alphaId)!;
		assert.ok(alpha.aliases.includes("Alpha feel"), "the session's phrasing joins the aliases");
		assert.ok(alpha.aliases.includes("alpha intuition"));
		assert.ok(
			alpha.provenance.some((pt) => pt.chatId === chat2.id && pt.messageId === "a1"),
			"provenance unions",
		);
		// The mapping records the verdict: (chat2, q1) → the linked node.
		const m = graphStore.readMappings().find((x) => x.chatId === chat2.id)!;
		assert.deepEqual(m, { chatId: chat2.id, sourceId: "q1", graphNodeId: alphaId });
	});

	it("derives node states and sessions in graphSnapshot", () => {
		const snap = graphSnapshot(graphDeps);
		const idByStatement = new Map(snap.nodes.map((n) => [n.statement, n.id]));
		// Alpha's latest quiz is call-9 (chat2, correct) → known.
		assert.equal(snap.nodeStates[idByStatement.get("Alpha intuition")!], "known");
		assert.equal(snap.nodeStates[idByStatement.get("Beta rule")!], "missed");
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

	it("never string-matches without a verdict — an identical statement without linkTo is a NEW node", () => {
		const chat3 = fixtureChat("Graph fixture 3", [user("u1", "third")]);
		chat3Id = chat3.id;
		const stats = mergeFindings(
			chat3.id,
			{
				propositions: [
					{
						id: "r1",
						name: "Alpha",
						statement: "Alpha intuition", // IDENTICAL to the existing node's statement
						aliases: [],
						messages: ["u1"],
						evidence: ["fixture evidence"],
						// no linkTo — identity is the auditor's call alone
					},
				],
				edges: [],
				attribution: { quiz: {} },
				dropped: [],
			},
			graphDeps,
		);
		assert.equal(stats.nodes, 1, "created — the merger does not match strings");
		assert.equal(getGraph(graphStore).nodes.filter((n) => n.statement === "Alpha intuition").length, 2);
	});

	it("returns zeros for unknown chats", () => {
		assert.deepEqual(mergeFindings("chat_does_not_exist", fixtureAudit(), graphDeps), {
			nodes: 0,
			edges: 0,
			events: 0,
		});
	});
});

// ─── the trigger helper ──────────────────────────────────────────────────────

describe("the trigger helper (pendingQuizAnswers)", () => {
	it("counts answered quizzes not yet in the ledger — dismissed/ask never count", () => {
		const chat = fixtureChat("Trigger fixture", [
			user("u1", "go"),
			assistant("a1", [
				quizPart(
					"call-s",
					{ question: "QS", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
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

		mergeFindings(chat.id, fixtureAudit(), graphDeps);
		// call-s is unattributed here (fixtureAudit has no call-s attribution)
		// — but it still becomes an event, so nothing stays pending.
		assert.equal(pendingQuizAnswers(chat.id, graphDeps), 0, "extracted → nothing pending");

		// A NEW answered quiz raises the count again (the re-trigger path).
		chatStore.saveMessages(chat.id, [
			...chatStore.getChat(chat.id)!.messages,
			assistant("a3", [
				quizPart(
					"call-s4",
					{ question: "QS4", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
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
		const node = {
			id: "n_storetest",
			name: "Store test",
			statement: "Store test, elaborated.",
			aliases: [] as string[],
			createdAt: "2026-08-22T00:00:00.000Z",
			provenance: [{ chatId: "chat_c", messageId: "m1" }],
		};
		graphStore.appendNode(node);
		// A torn append and a pre-name-pivot node (old schema: description, no
		// name) — both skipped by the strict guard.
		fs.appendFileSync(
			LEDGER_FILES.nodes,
			`{not json}\n${JSON.stringify({ id: "legacy", statement: "Legacy shape", description: "Old schema.", aliases: [], createdAt: "2026-08-22T00:00:00.000Z", provenance: [] })}\n`,
			"utf-8",
		);
		const nodes = graphStore.readNodes().filter((n) => n.id === "n_storetest" || n.id === "legacy");
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0]!.name, "Store test");
		assert.equal(nodes[0]!.statement, "Store test, elaborated.");
		assert.deepEqual(nodes[0]!.provenance, [{ chatId: "chat_c", messageId: "m1" }]);
	});

	it("returns RAW node lines — repeated ids (link-appends) are each their own line; getGraph merges", () => {
		const line = (msgId: string) =>
			JSON.stringify({
				id: "n_linktest",
				name: "Link test",
				statement: `Phrasing ${msgId}`,
				aliases: [],
				createdAt: "2026-08-22T00:00:00.000Z",
				provenance: [{ chatId: "chat_c", messageId: msgId }],
			});
		fs.appendFileSync(LEDGER_FILES.nodes, `${line("m1")}\n${line("m2")}\n`, "utf-8");
		const lines = graphStore.readNodes().filter((n) => n.id === "n_linktest");
		assert.equal(lines.length, 2, "the store returns raw lines, one per append");
		const merged = getGraph(graphStore).nodes.find((n) => n.id === "n_linktest")!;
		assert.equal(merged.statement, "Phrasing m1", "the FIRST line defines the node");
		assert.ok(merged.aliases.includes("Phrasing m2"), "later phrasings join the aliases");
		assert.deepEqual(merged.provenance.map((p) => p.messageId), ["m1", "m2"]);
	});
});
