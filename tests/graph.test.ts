/**
 * Graph merger + trigger + derivation tests (vision §1, 2026-09-02 redesign;
 * events cleanup 2026-09-27).
 * The merger (core/graph.ts mergeFindings) is the pipeline's deterministic
 * apply stage: AUDITED VERDICTS in, ledger appends out — link-or-create
 * identity (the auditor's linkTo, never string matching) and the
 * idempotency guarantees. No events ledger: quiz outcomes and
 * understanding observations are no longer formalized in the graph.
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
import type { AuditVerdicts, SessionFindings } from "../src/core/contracts.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import { getGraph, graphSnapshot, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import { coverageSlots } from "../src/core/coverage.ts";
import { graphStore } from "../src/store/graph.ts";
import { chatStore } from "../src/store/chats.ts";
import { LEDGER_FILES, PATHS, SOURCES_FILE } from "../config.ts";

/** The wired fs adapters, exactly what src/server/stores.ts passes in production. */
const graphDeps = { chatStore, graphStore } as const satisfies GraphDeps;

/** The session merge source for a chat — what the pipeline passes: the
 *  fold stamp only (the merger reads no transcript; quiz-event rebuilding
 *  died with the events ledger, 2026-09-27). */
function sessionSource(chatId: string): { foldedAt: string } {
	const record = chatStore.getChat(chatId)!;
	return { foldedAt: record.updatedAt };
}

// ─── ledger isolation (backup-and-clear of data/graph/*.jsonl) ──────────────

const LEDGER_PATHS = [...Object.values(LEDGER_FILES), SOURCES_FILE];
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

// Native fixture builders (Wave B): the record holds pi-native history —
// an assistant message carrying tool calls + one tool result per call. The
// projection reproduces the old part shapes (state output-available, input
// = arguments, output = result details).
interface NativeCall {
	name: string;
	toolCallId: string;
	input: Record<string, unknown>;
	output: QuestionAnswerData;
}

function user(id: string, text: string): LhMessage[] {
	return [{ id, role: "user", content: text, timestamp: Date.now() } as never];
}

function assistant(id: string, calls: NativeCall[]): LhMessage[] {
	const content = calls.map((c) => ({ type: "toolCall", id: c.toolCallId, name: c.name, arguments: c.input as never }));
	const out: LhMessage[] = [
		{
			id,
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never,
	];
	for (const c of calls) {
		out.push({
			id: `r_${c.toolCallId}`,
			role: "toolResult",
			toolCallId: c.toolCallId,
			toolName: c.name,
			content: [{ type: "text", text: "ok" }],
			details: c.output,
			isError: false,
			timestamp: Date.now(),
		} as never);
	}
	return out;
}

function quizPart(
	toolCallId: string,
	input: Record<string, unknown>,
	output: QuestionAnswerData,
): NativeCall {
	return { name: "quiz", toolCallId, input, output };
}

function askPart(
	toolCallId: string,
	input: Record<string, unknown>,
	output: QuestionAnswerData,
): NativeCall {
	return { name: "ask_user_question", toolCallId, input, output };
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
function fixtureChat(title: string, messages: LhMessage[]) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, messages);
	return chatStore.getChat(chat.id)!;
}

/** The full fixture transcript: five graded quizzes + a dismissed one + an ask. */
function fixtureMessages(): LhMessage[] {
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
			askPart(
				"call-7",
				{ question: "free text?" },
				answer({ questionId: "call-7", kind: "ask", questionText: "free text?", text: "because" }),
			),
		]),
	].flat();
}

/** The extractor's findings for the fixture chat: three propositions,
 *  one follows edge (the graph starts empty — no links). */
function fixtureFindings(): SessionFindings {
	return {
		propositions: [
			{
				id: "p1",
				name: "Alpha",
				statement: "Alpha intuition",
				aliases: ["alpha feel"],
			},
			{
				id: "p2",
				name: "Beta rule",
				statement: "Beta rule",
				aliases: [],
			},
			{
				id: "p3",
				name: "Gamma",
				statement: "Gamma application",
				aliases: [],
			},
		],
		edges: [
			{
				from: "p1",
				to: "p2",
				type: "follows",
			},
		],
	};
}

/** The auditor's verdicts when nothing links: an empty verdict set is a
 *  valid full review (verdicts-only, owner 2026-09-28). */
function fixtureVerdicts(): AuditVerdicts {
	return { links: [], edges: [] };
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
	};
}

describe("the merger (mergeFindings)", () => {
	it("creates nodes from the verdicts with chat-level provenance", () => {
		const stats = mergeFindings(chat1.id, fixtureFindings(), fixtureVerdicts(), graphDeps, sessionSource(chat1.id));
		assert.deepEqual(stats, { nodes: 3, edges: 1 });

		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		const idByStatement = new Map(graph.nodes.map((n) => [n.statement, n.id]));
		for (const node of graph.nodes) {
			assert.match(node.id, /^n_/);
			assert.ok(node.name.length > 0, "name is required");
			assert.equal("kind" in node, false, "no kind field");
			assert.ok(Array.isArray(node.provenance), "provenance attached");
		}
		// Provenance is CHAT-LEVEL (submit-schema slim, 2026-09-28):
		// propositions no longer carry message ids — the run's source key
		// is the whole provenance.
		const alpha = graph.nodes.find((n) => n.statement === "Alpha intuition")!;
		assert.deepEqual(alpha.provenance, [{ chatId: chat1.id, messageId: "" }]);

		// The follows edge, provenance attached.
		assert.equal(graph.edges.length, 1);
		const edge = graph.edges[0]!;
		assert.equal(edge.from, idByStatement.get("Alpha intuition"));
		assert.equal(edge.to, idByStatement.get("Beta rule"));
		assert.equal(edge.type, "follows");
		assert.deepEqual(edge.provenance, [{ chatId: chat1.id, messageId: "" }]);

		// Mapping lines: one per (chat, sourceId).
		assert.deepEqual(
			graphStore.readMappings().map((m) => m.sourceId),
			["p1", "p2", "p3"],
		);
	});

	it("is idempotent — re-merging the same verdicts appends nothing", () => {
		const stats = mergeFindings(chat1.id, fixtureFindings(), fixtureVerdicts(), graphDeps, sessionSource(chat1.id));
		assert.deepEqual(stats, { nodes: 0, edges: 0 });
		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		assert.equal(graph.edges.length, 1);
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
		].flat());
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
					},
				],
				edges: [],
			},
			// VERDICTS-ONLY: the identity call is a link entry, not a field
			// on the proposition (owner, 2026-09-28).
			{ links: [{ id: "q1", linkTo: alphaId }], edges: [] },
			graphDeps,
			sessionSource(chat2.id),
		);
		assert.deepEqual(stats, { nodes: 0, edges: 0 });

		const after = scopedGraph([chat1.id, chat2.id]);
		assert.equal(after.nodes.length, 3, "no duplicate node");
		const alpha = getGraph(graphStore).nodes.find((n) => n.id === alphaId)!;
		assert.ok(alpha.aliases.includes("Alpha feel"), "the session's phrasing joins the aliases");
		assert.ok(alpha.aliases.includes("alpha intuition"));
		assert.ok(
			alpha.provenance.some((pt) => pt.chatId === chat2.id),
			"provenance unions",
		);
		// The mapping records the verdict: (chat2, q1) → the linked node.
		const m = graphStore.readMappings().find((x) => x.chatId === chat2.id)!;
		assert.deepEqual(m, { chatId: chat2.id, sourceId: "q1", graphNodeId: alphaId });
	});

	it("resolves imported-notes ids to their file paths in the snapshot (static provenance)", () => {
		// The notes front door in miniature: a source record + a merge under
		// its src id — the snapshot must label it with the file path (a
		// static entry), never as a chat session.
		graphStore.upsertSource({ id: "src_snapfixture", filePath: "/vault/learn vim.md", importedAt: "2026-09-13T00:00:00.000Z" });
		mergeFindings(
			"src_snapfixture",
			{
				propositions: [
					{
						id: "p1",
						name: "Vim registers",
						statement: "Vim registers map single keys to editing commands.",
						aliases: [],
					},
				],
				edges: [],
			},
			{ links: [], edges: [] },
			graphDeps,
			{ foldedAt: "2026-09-13T00:00:00.000Z" },
		);
		const snap = graphSnapshot(graphDeps);
		const node = snap.nodes.find((n) => n.statement === "Vim registers map single keys to editing commands.")!;
		assert.equal(snap.fileSources["src_snapfixture"], "/vault/learn vim.md");
		assert.deepEqual(snap.nodeSessions[node.id], ["src_snapfixture"], "the file entry joins the node's sessions list");
		assert.equal(snap.sessions["src_snapfixture"], undefined, "a notes source is never a chat session");
	});

	it("derives BIRTH-SESSION clusters in graphSnapshot, labeled with the session's name", () => {
		// Wave 7 (owner-locked 2026-09-23): embeddings are dead — a cluster is
		// the session that BIRTHED its propositions, derived on read from
		// provenance. No ledger partition to play, no LLM naming pass — the
		// label IS the session's name (chat title / file path).
		const tri = ["Alpha.", "Beta.", "Gamma cluster."] as const;
		graphStore.upsertSource({ id: "src_clusterfixture", filePath: "/vault/cluster notes.md", importedAt: "2026-09-13T00:00:00.000Z" });
		const merge = mergeFindings(
			"src_clusterfixture",
			{
				propositions: tri.map((statement, i) => ({
					id: `p${i + 1}`,
					name: `Cluster node ${i + 1}`,
					statement,
					aliases: [],
				})),
				edges: [
					{ from: "p1", to: "p2", type: "follows", },
					{ from: "p2", to: "p3", type: "follows", },
					{ from: "p1", to: "p3", type: "follows", },
				],
			},
			{ links: [], edges: [] },
			graphDeps,
			{ foldedAt: "2026-09-13T00:00:00.000Z" },
		);
		assert.equal(merge.nodes, 3);
		const snap = graphSnapshot(graphDeps);
		// Presentation threshold: every cluster is >= 3 members.
		assert.ok(snap.clusters.every((c) => c.members.length >= 3));
		// Our trio is exactly one cluster — the notes file that BIRTHED it,
		// labeled with its path, id = the source id (stable, no content hash).
		const mine = snap.clusters.find((c) => c.members.length === 3 && tri.every((s) => c.members.includes(snap.nodes.find((n) => n.statement === s)!.id)));
		assert.ok(mine, "the trio is one cluster");
		assert.equal(mine!.id, "src_clusterfixture");
		assert.equal(mine!.label, "/vault/cluster notes.md", "a notes file is a birth-session — the label is its path");
	});

	it("derives the sessions index in graphSnapshot", () => {
		const snap = graphSnapshot(graphDeps);
		const idByStatement = new Map(snap.nodes.map((n) => [n.statement, n.id]));
		// No node-state classes (2026-09-08) and no understanding
		// observations (2026-09-27 cleanup): the snapshot carries only the
		// objective graph + sessions.
		assert.equal("nodeStates" in snap, false);
		assert.equal("nodeObservations" in snap, false);

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
		const chat3 = fixtureChat("Graph fixture 3", [user("u1", "third")].flat());
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
					},
				],
				edges: [],
			},
			// empty verdicts — identity is the auditor's call alone
			{ links: [], edges: [] },
			graphDeps,
			sessionSource(chat3.id),
		);
		assert.equal(stats.nodes, 1, "created — the merger does not match strings");
		assert.equal(getGraph(graphStore).nodes.filter((n) => n.statement === "Alpha intuition").length, 2);
	});

	it("merges the notes front door: source id as chatId, checkpoint at import time", () => {
		// Raw personal notes carry no transcript — no message anchors; the
		// file is the provenance (and no events exist to build, 2026-09-27).
		const stats = mergeFindings(
			"src_notesfixture",
			{
				propositions: [
					{
						id: "p1",
						name: "Vim normal mode",
						statement: "Vim starts in Normal mode, where keys are commands.",
						aliases: [],
					},
				],
				edges: [],
			},
			{ links: [], edges: [] },
			graphDeps,
			{ foldedAt: "2026-09-13T00:00:00.000Z" },
		);
		assert.deepEqual(stats, { nodes: 1, edges: 0 });

		const node = getGraph(graphStore).nodes.find((n) => n.statement.startsWith("Vim starts"))!;
		assert.deepEqual(node.provenance, [{ chatId: "src_notesfixture", messageId: "" }], "one chat-level point — the source key, no message anchors");
		assert.deepEqual(graphStore.readMappings().find((m) => m.chatId === "src_notesfixture"), {
			chatId: "src_notesfixture",
			sourceId: "p1",
			graphNodeId: node.id,
		});
		// The checkpoint stamps the import time.
		assert.equal(graphStore.readCheckpoints().find((c) => c.chatId === "src_notesfixture")?.foldedAt, "2026-09-13T00:00:00.000Z");
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

// ─── session deletion (wave 6 — the first destructive ledger operation) ─────

import { deleteChatTraces, type ChatDeletionStats } from "../src/core/graph-deletion.ts";
import { deleteChatSession, sessionCoverage } from "../src/server/chats.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { jobStore } from "../src/store/jobs.ts";
import {
	deleteNodeTraces,
	nodeDeletionImpact,
	type NodeDeletionStats,
} from "../src/core/graph-deletion.ts";
import { deleteGraphNode, graphRevision } from "../src/server/graph.ts";

describe("session deletion (deleteChatTraces + deleteChatSession, wave 6)", () => {
	/** Two-session scenario: dA creates the shared node X + the orphan Y and
	 *  asserts X→Y; dB links X (its own phrasings), creates Z, asserts X→Z.
	 *  Deleting dA must: keep X (dB's link line survives, dA's create-line
	 *  aliases stripped — the identity stays), kill Y (orphan), keep Z and
	 *  dB's edge, kill dA's events/mappings/coverage/checkpoints. */
	function buildTwoSessionScenario() {
		const dA = fixtureChat("Deletion session A", [
			user("du1", "teach me the deletion topic"),
			assistant("da1", [
				quizPart(
					"d-call-1",
					{ question: "DQ1", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionId: "d-call-1", questionText: "DQ1 text", correct: true, answeredAt: "2026-09-23T00:00:00.000Z" }),
				),
			]),
		].flat());
		const findingsA: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Shared core", statement: "Shared core statement", aliases: ["shared feel"], },
				{ id: "p2", name: "Solo fact", statement: "Solo fact statement", aliases: ["solo feel"], },
			],
			edges: [{ from: "p1", to: "p2", type: "follows", }],
		};
		mergeFindings(dA.id, findingsA, { links: [], edges: [] }, graphDeps, sessionSource(dA.id));
		// Resolve through THIS session's mappings — the shared ledger holds
		// lookalike statements from earlier tests, so statement-lookup would
		// link dB to the wrong node.
		const mappedId = (sourceId: string): string =>
			graphStore.readMappings().find((m) => m.chatId === dA.id && m.sourceId === sourceId)!.graphNodeId;
		const xId = mappedId("p1");
		const yId = mappedId("p2");

		const dB = fixtureChat("Deletion session B", [
			user("eu1", "more on the shared core"),
			assistant("eb1", [
				quizPart(
					"e-call-1",
					{ question: "EQ1", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" },
					answer({ questionId: "e-call-1", questionText: "EQ1 text", correct: false, answeredAt: "2026-09-23T00:01:00.000Z" }),
				),
			]),
		].flat());
		const findingsB: SessionFindings = {
			propositions: [
				{ id: "q1", name: "Shared again", statement: "Shared core, rephrased", aliases: ["B phrasing"] },
				{ id: "q2", name: "B extra", statement: "B extra statement", aliases: ["b extra feel"], },
			],
			edges: [{ from: "q1", to: "q2", type: "follows", }],
		};
		mergeFindings(dB.id, findingsB, { links: [{ id: "q1", linkTo: xId }], edges: [] }, graphDeps, sessionSource(dB.id));
		const zId = graphStore.readMappings().find((m) => m.chatId === dB.id && m.sourceId === "q2")!.graphNodeId;

		// Coverage rows (both chats) + positions garnish — the deletion
		// prunes both ledgers.
		for (const chat of [dA, dB]) {
			for (let i = 0; i < 2; i++) {
				graphStore.appendCoverage({ chatId: chat.id, fp: `${chat.id}-${i}`, tokens: 10, foldedAt: "2026-09-23T00:02:00.000Z" });
			}
		}
		graphStore.writePositions({ ...graphStore.readPositions(), [xId]: { x: 1, y: 1 }, [yId]: { x: 2, y: 2 }, [zId]: { x: 3, y: 3 } });
		return { dA, dB, xId, yId, zId };
	}

	it("delete-nodes: the shared node survives with the other session's content; the orphan dies; the creator's aliases are stripped (owner ruling 2026-09-23)", () => {
		const { dA, dB, xId, yId, zId } = buildTwoSessionScenario();
		const zLineBefore = JSON.stringify(graphStore.readNodes().find((n) => n.id === zId));

		const stats = deleteChatTraces(graphStore, dA.id, "delete-nodes");
		assert.deepEqual(stats, {
			nodesRemoved: 1,
			edgesRemoved: 1,
			mappingsRemoved: 2,
			coverageRemoved: 2,
			checkpointsRemoved: 1,
		} satisfies ChatDeletionStats);

		const graph = getGraph(graphStore);
		// X survives: identity (name/statement/createdAt from the create
		// line) intact, dA's aliases + provenance gone, dB's phrasings in.
		const x = graph.nodes.find((n) => n.id === xId)!;
		assert.equal(x.statement, "Shared core statement", "the shared identity survives");
		assert.equal(x.name, "Shared core");
		assert.ok(!x.aliases.includes("shared feel"), "the deleted creator's phrasings are stripped (owner ruling)");
		assert.ok(x.aliases.includes("B phrasing") && x.aliases.includes("Shared core, rephrased"));
		assert.deepEqual(x.provenance, [{ chatId: dB.id, messageId: "" }], "only dB's provenance remains");
		// Y (the orphan) is gone entirely.
		assert.equal(graph.nodes.some((n) => n.id === yId), false);
		assert.equal(graphStore.readNodes().some((n) => n.id === yId), false);
		// Z (dB-only) is untouched, byte-identical.
		assert.equal(JSON.stringify(graphStore.readNodes().find((n) => n.id === zId)), zLineBefore);
		// Edges: dA's assertion X→Y died; dB's X→Z survived.
		const scoped = scopedGraph([dA.id, dB.id]);
		assert.deepEqual(scoped.edges, [{ from: xId, to: zId, type: "follows", provenance: [{ chatId: dB.id, messageId: "" }] }]);
		// Mappings: dA's audit trail died; dB's stays.
		const mappings = graphStore.readMappings().filter((m) => [dA.id, dB.id].includes(m.chatId));
		assert.deepEqual(mappings, [{ chatId: dB.id, sourceId: "q1", graphNodeId: xId }, { chatId: dB.id, sourceId: "q2", graphNodeId: zId }]);
		// Positions: the orphan pruned.
		const positions = graphStore.readPositions();
		assert.equal(positions[yId], undefined);
		assert.deepEqual(positions[xId], { x: 1, y: 1 });
		// The snapshot resolves X to dB only — the deleted chat left no ghost.
		const snapshot = graphSnapshot(graphDeps);
		assert.deepEqual(snapshot.nodeSessions[xId], [dB.id]);
		assert.ok(snapshot.sessions[dB.id] && !snapshot.sessions[dA.id]);
		// Atomic rewrites left no temp files, and appends still work.
		assert.equal(fs.readdirSync(PATHS.graph).filter((f) => f.includes(".tmp-")).length, 0);
		const nodesBefore = graphStore.readNodes().length;
		// Foreign provenance: the probe is another chat's data, so later
		// deletions must leave it untouched (the foreign-data doctrine).
		graphStore.appendNode({ id: "n_del_append_probe", name: "Probe", statement: "Probe statement", aliases: [], createdAt: "2026-09-23T00:04:00.000Z", provenance: [{ chatId: "chat_foreign_probe", messageId: "" }] });
		assert.equal(graphStore.readNodes().length, nodesBefore + 1);
		// Idempotent: a second run finds nothing.
		assert.deepEqual(deleteChatTraces(graphStore, dA.id, "delete-nodes"), { ...stats, nodesRemoved: 0, edgesRemoved: 0, mappingsRemoved: 0, coverageRemoved: 0, checkpointsRemoved: 0 } satisfies ChatDeletionStats);
	});

	it("preserve-graph: only the extraction bookkeeping dies — the graph ledgers are byte-identical", () => {
		const { dA, dB, xId, yId, zId } = buildTwoSessionScenario();
		const before = {
			nodes: graphStore.readNodes(),
			edges: graphStore.readEdges(),
			mappings: graphStore.readMappings(),
			positions: graphStore.readPositions(),
		};
		const stats = deleteChatTraces(graphStore, dA.id, "preserve-graph");
		assert.deepEqual(stats, {
			nodesRemoved: 0,
			edgesRemoved: 0,
			mappingsRemoved: 0,
			coverageRemoved: 2,
			checkpointsRemoved: 1,
		} satisfies ChatDeletionStats);
		assert.deepEqual(graphStore.readNodes(), before.nodes);
		assert.deepEqual(graphStore.readEdges(), before.edges);
		assert.deepEqual(graphStore.readMappings(), before.mappings);
		assert.deepEqual(graphStore.readPositions(), before.positions);
		assert.equal(graphStore.readCoverage().some((row) => row.chatId === dA.id), false);
		assert.equal(graphStore.readCoverage().some((row) => row.chatId === dB.id), true);
		void xId; void yId; void zId;
	});

	it("deleteChatSession: the orchestration's gates and the sync block", async () => {
		// 404 — unknown chat.
		assert.deepEqual(await deleteChatSession("chat_missing_delete", "delete-nodes"), { ok: false, status: 404, code: "not_found", error: "No such session" });

		const { dA } = buildTwoSessionScenario();
		// 409 — a turn in flight.
		beginTurn(dA.id);
		const turnedAway = await deleteChatSession(dA.id, "delete-nodes");
		assert.deepEqual(turnedAway, { ok: false, status: 409, code: "turn_in_flight", error: "A turn is running in this session — try again when it finishes", jobIds: [] });
		endTurn(dA.id);
		// 409 — running background jobs.
		const job = jobStore.createJob({ kind: "research", chatId: dA.id, toolCallId: "del-call-1" });
		const jobsBlocked = await deleteChatSession(dA.id, "delete-nodes");
		assert.ok(!jobsBlocked.ok && jobsBlocked.status === 409, "refused with 409");
		if (jobsBlocked.code === "jobs_running") assert.deepEqual(jobsBlocked.jobIds, [job.id]);
		assert.equal(jobStore.deleteJobsForChat(dA.id), 1, "test cleanup — the job file is gone");

		// Success — a terminal job rides along; the chat record dies last.
		const doneJob = jobStore.createJob({ kind: "research", chatId: dA.id, toolCallId: "del-call-2" });
		jobStore.updateJob(doneJob.id, { status: "done", activity: "delivered" });
		const outcome = await deleteChatSession(dA.id, "delete-nodes");
		assert.equal(outcome.ok, true);
		if (outcome.ok) {
			assert.equal(outcome.mode, "delete-nodes");
			assert.equal(outcome.stats.nodesRemoved, 1);
			assert.equal(outcome.jobsRemoved, 1);
			assert.ok(outcome.graphRevision > 0, "the version stamp moved");
		}
		assert.equal(chatStore.getChat(dA.id), null, "the chat record is gone");
		assert.equal(jobStore.getJob(doneJob.id), null, "the chat's job records are gone");
		// And a second call is an honest 404.
		assert.deepEqual(await deleteChatSession(dA.id, "delete-nodes"), { ok: false, status: 404, code: "not_found", error: "No such session" });
	});
});

// ─── single-node deletion (node interlude, full death) ───────────────────────

describe("single-node deletion (deleteNodeTraces + deleteGraphNode, node interlude)", () => {
	/** The full-death scenario: node X is born in a notes file (the
	 *  production orphan shape — EMPTY provenance, the mapping line is the
	 *  anchor), re-encountered by a chat (link line: alias + provenance),
	 *  asserted in an edge, and evaluated by two sessions. */
	function buildNodeScenario() {
		// Clean slate per test: each test in this describe builds its own
		// scenario from empty ledgers (the suite's isolation covers the
		// whole file; this covers describe-internal stacking).
		graphStore.rewriteLedgers({ nodes: [], edges: [], mappings: [] });
		graphStore.writePositions({});
		graphStore.appendNode({
			id: "n_dead",
			name: "Doomed",
			statement: "Doomed statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [],
		});
		// The chat's re-encounter: a link line (alias + its own provenance).
		graphStore.appendNode({
			id: "n_dead",
			name: "Doomed",
			statement: "Doomed statement",
			aliases: ["doomed, rephrased"],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_a", messageId: "m1" }],
		});
		// A neighbor + two edges: only the one touching X dies.
		graphStore.appendNode({
			id: "n_keep",
			name: "Keeper",
			statement: "Keeper statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_a", messageId: "m2" }],
		});
		graphStore.appendEdge({ from: "n_dead", to: "n_keep", type: "follows", provenance: [{ chatId: "chat_node_a", messageId: "m1" }] });
		graphStore.appendEdge({ from: "n_keep", to: "n_dead", type: "supports", provenance: [{ chatId: "chat_node_b", messageId: "m3" }] });
		graphStore.appendEdge({ from: "n_keep", to: "n_other", type: "follows", provenance: [{ chatId: "chat_node_b", messageId: "m3" }] });
		// Mappings: the notes anchor + the chat's audit trail.
		graphStore.appendMapping({ chatId: "src_nodefile", sourceId: "p1", graphNodeId: "n_dead" });
		graphStore.appendMapping({ chatId: "chat_node_a", sourceId: "p1", graphNodeId: "n_dead" });
		graphStore.appendMapping({ chatId: "chat_node_a", sourceId: "p2", graphNodeId: "n_keep" });
		// Resting positions for both.
		graphStore.writePositions({ n_dead: { x: 1, y: 1 }, n_keep: { x: 2, y: 2 } });
	}

	it("nodeDeletionImpact: the confirm dialog's pre-flight facts", () => {
		buildNodeScenario();
		assert.deepEqual(nodeDeletionImpact(graphStore, "n_dead"), {
			edges: 2,
			// The file anchor + the re-encounter — every referencing
			// session, deduped and sorted.
			sessions: ["chat_node_a", "src_nodefile"],
		});
		// Unknown node: null (the route's 404).
		assert.equal(nodeDeletionImpact(graphStore, "n_missing"), null);
	});

	it("deleteNodeTraces: FULL DEATH — the node, its edges, its evidence, its anchors, its position", () => {
		buildNodeScenario();
		const keepLineBefore = JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep"));
		const stats = deleteNodeTraces(graphStore, "n_dead");
		assert.deepEqual(stats, { edgesRemoved: 2, mappingsRemoved: 2 } satisfies NodeDeletionStats);

		// The node's EVERY line is gone; the neighbor is byte-identical
		// (full death is node-scoped — other nodes' sessions keep their
		// aliases and provenance).
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_dead"), false);
		assert.equal(
			JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep")),
			keepLineBefore,
			"the untouched node is byte-identical",
		);
		// Only the edge to nowhere rode along; the foreign edge X→Z stays.
		assert.deepEqual(
			graphStore.readEdges().map((e) => [e.from, e.to]),
			[["n_keep", "n_other"]],
		);
		// The audit trail: X's mappings gone, the neighbor's stay.
		assert.deepEqual(graphStore.readMappings().map((m) => m.graphNodeId), ["n_keep"]);
		// The resting position died with the node.
		const positions = graphStore.readPositions();
		assert.equal(positions["n_dead"], undefined);
		assert.deepEqual(positions["n_keep"], { x: 2, y: 2 });
		// Atomic rewrites left no temp files.
		assert.equal(fs.readdirSync(PATHS.graph).filter((f) => f.includes(".tmp-")).length, 0);
		// Idempotent: a second run finds no node — null.
		assert.equal(deleteNodeTraces(graphStore, "n_dead"), null);
	});

	it("deleteNodeTraces: a node nothing references still dies, and only its file moves", () => {
		graphStore.appendNode({
			id: "n_solo",
			name: "Solo",
			statement: "Solo statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_solo", messageId: "m1" }],
		});
		const stats = deleteNodeTraces(graphStore, "n_solo");
		assert.deepEqual(stats, { edgesRemoved: 0, mappingsRemoved: 0 } satisfies NodeDeletionStats);
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_solo"), false);
	});

	it("deleteGraphNode: the orchestration — extraction gate, 404, success", () => {
		// 404 — unknown node.
		assert.deepEqual(deleteGraphNode("n_missing_node"), {
			ok: false,
			status: 404,
			code: "not_found",
			error: "No such node",
		});

		// 409 — ANY registered extraction run: a mid-flight run could
		// re-reference the dying node; the run is never aborted (its spend
		// belongs to another session), the caller retries. The registry is
		// the pipeline's globalThis store — a fake entry is the honest way
		// to pin the gate without staging a real run.
		const g = globalThis as { __lhExtractionRuns?: unknown };
		const realRuns = g.__lhExtractionRuns;
		g.__lhExtractionRuns = {
			running: new Map([
				["chat_busy", { chatId: "chat_busy", kind: "chat", phase: "extracting", startedAt: 1, usage: {}, controller: new AbortController() }],
			]),
			inFlight: new Set(),
			lastStartedAt: 0,
		};
		try {
			assert.deepEqual(deleteGraphNode("n_gate_probe"), {
				ok: false,
				status: 409,
				code: "extraction_running",
				error: "An extraction is running — try again when it finishes",
			});
		} finally {
			g.__lhExtractionRuns = realRuns;
		}

		// Success — the node dies, the version stamp moves.
		graphStore.appendNode({
			id: "n_orch",
			name: "Orchestrated",
			statement: "Orchestrated statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_c", messageId: "m1" }],
		});
		const revisionBefore = graphRevision();
		const outcome = deleteGraphNode("n_orch");
		assert.ok(outcome.ok);
		assert.deepEqual(outcome.stats, { edgesRemoved: 0, mappingsRemoved: 0 });
		assert.ok(outcome.graphRevision > 0);
		assert.ok(outcome.graphRevision >= revisionBefore, "the version stamp moved");
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_orch"), false);
		// And a second call is an honest 404.
		assert.deepEqual(deleteGraphNode("n_orch"), { ok: false, status: 404, code: "not_found", error: "No such node" });
	});
});

describe("session coverage read (extraction-UX redesign, 2026-09-24)", () => {
	it("one session's block: derived uncovered, the newest fold, honest nulls", () => {
		// Empty coverage: everything uncovered, no fold yet, not running.
		const chat = fixtureChat("coverage read", [
			user("cov_u1", "tell me about coverage reads"),
			user("cov_u2", "and about per-session blocks"),
			user("cov_u3", "a third distinct message"),
		].flat());
		const empty = sessionCoverage(chat.id)!;
		assert.ok(empty);
		assert.equal(empty.totalMessages, 3);
		assert.equal(empty.coveredCount, 0);
		assert.equal(empty.uncoveredCount, 3);
		assert.equal(empty.coveredTokens, 0);
		assert.ok(empty.uncoveredTokens > 0);
		assert.equal(empty.running, false);
		assert.equal(empty.lastFoldedAt, null, "no fold yet");

		// Fold the first two messages: the read derives the split + the
		// newest fold timestamp from the ledger rows.
		const slots = coverageSlots(chatStore.getChat(chat.id)!.messages);
		graphStore.appendCoverage({ chatId: chat.id, fp: slots[0]!.fp, tokens: slots[0]!.tokens, foldedAt: "2026-09-24T10:00:00.000Z" });
		graphStore.appendCoverage({ chatId: chat.id, fp: slots[1]!.fp, tokens: slots[1]!.tokens, foldedAt: "2026-09-24T11:30:00.000Z" });
		// Another session's row must not leak into this read.
		graphStore.appendCoverage({ chatId: "chat_other", fp: slots[2]!.fp, tokens: slots[2]!.tokens, foldedAt: "2026-09-24T23:00:00.000Z" });

		const cov = sessionCoverage(chat.id)!;
		assert.equal(cov.totalMessages, 3);
		assert.equal(cov.coveredCount, 2);
		assert.equal(cov.uncoveredCount, 1);
		assert.equal(cov.coveredTokens, slots[0]!.tokens + slots[1]!.tokens);
		assert.equal(cov.uncoveredTokens, slots[2]!.tokens);
		assert.equal(cov.lastFoldedAt, "2026-09-24T11:30:00.000Z", "the NEWEST fold, and scoped to this session's rows");
	});

	it("running: true only for THIS session's chat-kind run (the registry pin)", () => {
		const chat = fixtureChat("coverage running", [user("cov_r1", "running pin")].flat());
		const g = globalThis as { __lhExtractionRuns?: unknown };
		const realRuns = g.__lhExtractionRuns;
		try {
			g.__lhExtractionRuns = {
				running: new Map([
					// a notes run for the same id is NOT this session's chat run
					["src_notes", { chatId: "src_notes", kind: "notes", phase: "extracting", startedAt: 1, usage: {}, controller: new AbortController() }],
					["other_chat", { chatId: "other_chat", kind: "chat", phase: "auditing", startedAt: 2, usage: {}, controller: new AbortController() }],
				]),
				inFlight: new Set(),
				lastStartedAt: 0,
			};
			assert.equal(sessionCoverage(chat.id)!.running, false, "no chat-kind run for this id");
			g.__lhExtractionRuns = {
				running: new Map([
					[chat.id, { chatId: chat.id, kind: "chat", phase: "extracting", startedAt: 3, usage: {}, controller: new AbortController() }],
				]),
				inFlight: new Set(),
				lastStartedAt: 0,
			};
			assert.equal(sessionCoverage(chat.id)!.running, true);
		} finally {
			g.__lhExtractionRuns = realRuns;
		}
	});

	it("unknown chat → null (the caller owns the 404)", () => {
		assert.equal(sessionCoverage("chat_never_was"), null);
	});
});
