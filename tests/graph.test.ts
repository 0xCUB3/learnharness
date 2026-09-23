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
import type { AuditResult, NamingRunUsage } from "../src/core/contracts.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { getGraph, graphSnapshot, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import { graphStore } from "../src/store/graph.ts";
import { chatStore } from "../src/store/chats.ts";
import { LEDGER_FILES, PATHS, SOURCES_FILE, EMBEDDINGS_FILE } from "../config.ts";

/** The wired fs adapters, exactly what src/server/stores.ts passes in production. */
const graphDeps = { chatStore, graphStore } as const satisfies GraphDeps;

/** The session merge source for a chat — what the pipeline passes: the live
 *  transcript + its updatedAt checkpoint stamp. (Notes imports pass
 *  messages: null — see the notes-merger test below.) */
function sessionSource(chatId: string): { messages: UIMessage[]; foldedAt: string } {
	const record = chatStore.getChat(chatId)!;
	return { messages: record.messages as UIMessage[], foldedAt: record.updatedAt };
}

// ─── ledger isolation (backup-and-clear of data/graph/*.jsonl) ──────────────

// EMBEDDINGS_FILE too: the semantic-cluster source (read by graphSnapshot)
// — isolated like the rest so this suite never touches the real vectors.
const LEDGER_PATHS = [...Object.values(LEDGER_FILES), SOURCES_FILE, EMBEDDINGS_FILE];
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
				understanding: "solid",
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
		const stats = mergeFindings(chat1.id, fixtureAudit(), graphDeps, sessionSource(chat1.id));
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
		assert.equal(observation.note, "solid");

		// The dismissed quiz and the ask question became nothing.
		assert.equal([...byRef.keys()].filter((r) => r === "call-6" || r === "call-7").length, 0);
	});

	it("is idempotent — re-merging the same verdicts appends nothing", () => {
		const stats = mergeFindings(chat1.id, fixtureAudit(), graphDeps, sessionSource(chat1.id));
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
			sessionSource(chat2.id),
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
						messages: [],
						evidence: ["fixture evidence"],
						understanding: "solid",
					},
				],
				edges: [],
				attribution: { quiz: {} },
				dropped: [],
			},
			graphDeps,
			{ messages: null, foldedAt: "2026-09-13T00:00:00.000Z" },
		);
		const snap = graphSnapshot(graphDeps);
		const node = snap.nodes.find((n) => n.statement === "Vim registers map single keys to editing commands.")!;
		assert.equal(snap.fileSources["src_snapfixture"], "/vault/learn vim.md");
		assert.deepEqual(snap.nodeSessions[node.id], ["src_snapfixture"], "the file entry joins the node's sessions list");
		assert.equal(snap.sessions["src_snapfixture"], undefined, "a notes source is never a chat session");
		// The understanding observation joins under the source id like any session's.
		assert.equal(snap.nodeObservations[node.id]!["src_snapfixture"], "solid");
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
					messages: [`cluster_msg_${i + 1}`], // birth provenance — the message anchors
					evidence: ["fixture evidence"],
				})),
				edges: [
					{ from: "p1", to: "p2", type: "follows", messages: [], evidence: ["e"] },
					{ from: "p2", to: "p3", type: "follows", messages: [], evidence: ["e"] },
					{ from: "p1", to: "p3", type: "follows", messages: [], evidence: ["e"] },
				],
				attribution: { quiz: {} },
				dropped: [],
			},
			graphDeps,
			{ messages: null, foldedAt: "2026-09-13T00:00:00.000Z" },
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

	it("derives sessions and per-session understanding observations in graphSnapshot", () => {
		const snap = graphSnapshot(graphDeps);
		const idByStatement = new Map(snap.nodes.map((n) => [n.statement, n.id]));
		// No node-state classes anymore (2026-09-08): the snapshot carries
		// only the objective graph + sessions; quiz outcomes stay ledger data.
		assert.equal("nodeStates" in snap, false);

		assert.equal(snap.sessions[chat1.id], "Graph fixture");
		assert.equal(snap.sessions[chat2Id], "Graph fixture 2");
		assert.deepEqual(
			(snap.nodeSessions[idByStatement.get("Alpha intuition")!] ?? []).sort(),
			[chat1.id, chat2Id].sort(),
		);
		// Gamma was only ever touched by chat1.
		assert.deepEqual(snap.nodeSessions[idByStatement.get("Gamma application")!], [chat1.id]);

		// Understanding observations: (node → chat → the extractor's note).
		// Alpha carries chat1's "solid" level; chat2's q1 has no level.
		const alphaObs = snap.nodeObservations[idByStatement.get("Alpha intuition")!] ?? {};
		assert.equal(alphaObs[chat1.id], "solid");
		assert.equal(alphaObs[chat2Id], undefined);
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
			sessionSource(chat3.id),
		);
		assert.equal(stats.nodes, 1, "created — the merger does not match strings");
		assert.equal(getGraph(graphStore).nodes.filter((n) => n.statement === "Alpha intuition").length, 2);
	});

	it("merges the notes front door: source id as chatId, no quiz events, checkpoint at import time", () => {
		// Raw personal notes carry no transcript — the merger gets no
		// message parts, so NO quiz events are rebuilt; the understanding
		// observation still lands, keyed to the source id.
		const stats = mergeFindings(
			"src_notesfixture",
			{
				propositions: [
					{
						id: "p1",
						name: "Vim normal mode",
						statement: "Vim starts in Normal mode, where keys are commands.",
						aliases: [],
						messages: [], // notes carry no message anchors — the file is the provenance
						evidence: ["fixture evidence"],
						understanding: "solid",
					},
				],
				edges: [],
				attribution: { quiz: {} }, // normalized by the notes pipeline — nothing to attribute
				dropped: [],
			},
			graphDeps,
			{ messages: null, foldedAt: "2026-09-13T00:00:00.000Z" },
		);
		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 1 });

		const node = getGraph(graphStore).nodes.find((n) => n.statement.startsWith("Vim starts"))!;
		assert.deepEqual(node.provenance, [], "no message anchors — the mapping line carries the source");
		assert.deepEqual(graphStore.readMappings().find((m) => m.chatId === "src_notesfixture"), {
			chatId: "src_notesfixture",
			sourceId: "p1",
			graphNodeId: node.id,
		});
		// The observation event is file-scoped; no quiz events exist.
		const events = graphStore.readEvents().filter((e) => e.chatId === "src_notesfixture");
		assert.deepEqual(
			events.map((e) => [e.kind, e.ref, e.note]),
			[["observation", "obs:p1", "solid"]],
		);
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

	it("appendNamingUsage is idempotent per startedAt and strict-reads foreign shapes", () => {
		const run: NamingRunUsage = {
			startedAt: 1789800000000,
			at: "2026-09-17T00:00:00.000Z",
			durationMs: 1234,
			model: "z-ai/glm-5.3-flash",
			steps: [{ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: undefined, reasoningTokens: 0 }],
			stats: { detected: 4, claimed: 3, named: 1, appended: 1 },
		};
		graphStore.appendNamingUsage(run);
		graphStore.appendNamingUsage(run); // re-append: same startedAt — no-op
		// A torn append + a foreign shape (missing stats) — skipped by the guard.
		fs.appendFileSync(
			LEDGER_FILES.namingRuns,
			`{not json}\n${JSON.stringify({ startedAt: 1789800000001, at: "x", durationMs: 1, model: "m", steps: [] })}\n`,
			"utf-8",
		);
		const runs = graphStore.readNamingRuns().filter((r) => r.startedAt >= 1789800000000);
		assert.equal(runs.length, 1, "one record — idempotent append, corrupt/foreign lines skipped");
		assert.deepEqual(runs[0]!.stats, { detected: 4, claimed: 3, named: 1, appended: 1 });
		assert.equal(runs[0]!.steps.length, 1);
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
import { deleteChatSession } from "../src/server/chats.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { jobStore } from "../src/store/jobs.ts";

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
		]);
		const auditA: AuditResult = {
			propositions: [
				{ id: "p1", name: "Shared core", statement: "Shared core statement", aliases: ["shared feel"], messages: ["du1"], evidence: ["e"], understanding: "solid" },
				{ id: "p2", name: "Solo fact", statement: "Solo fact statement", aliases: ["solo feel"], messages: ["du1"], evidence: ["e"] },
			],
			edges: [{ from: "p1", to: "p2", type: "follows", messages: ["du1"], evidence: ["e"] }],
			attribution: { quiz: { "d-call-1": "p1" } },
			dropped: [],
		};
		mergeFindings(dA.id, auditA, graphDeps, sessionSource(dA.id));
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
		]);
		const auditB: AuditResult = {
			propositions: [
				{ id: "q1", name: "Shared again", statement: "Shared core, rephrased", aliases: ["B phrasing"], messages: ["eu1"], evidence: ["e"], linkTo: xId, understanding: "shaky" },
				{ id: "q2", name: "B extra", statement: "B extra statement", aliases: ["b extra feel"], messages: ["eu1"], evidence: ["e"] },
			],
			edges: [{ from: "q1", to: "q2", type: "follows", messages: ["eu1"], evidence: ["e"] }],
			attribution: { quiz: { "e-call-1": "q1" } },
			dropped: [],
		};
		mergeFindings(dB.id, auditB, graphDeps, sessionSource(dB.id));
		const zId = graphStore.readMappings().find((m) => m.chatId === dB.id && m.sourceId === "q2")!.graphNodeId;

		// Coverage rows (both chats) + positions + embeddings garnish — the
		// deletion prunes all three ledgers.
		for (const chat of [dA, dB]) {
			for (let i = 0; i < 2; i++) {
				graphStore.appendCoverage({ chatId: chat.id, fp: `${chat.id}-${i}`, tokens: 10, foldedAt: "2026-09-23T00:02:00.000Z" });
			}
		}
		graphStore.writePositions({ ...graphStore.readPositions(), [xId]: { x: 1, y: 1 }, [yId]: { x: 2, y: 2 }, [zId]: { x: 3, y: 3 } });
		const emb = graphStore.readEmbeddings();
		graphStore.writeEmbeddings({
			...emb,
			vectors: { ...emb.vectors, [xId]: [1, 0], [yId]: [0, 1], [zId]: [1, 1] },
			clusters: [...emb.clusters, { members: [xId, yId, zId] }],
			updatedAt: "2026-09-23T00:03:00.000Z",
		});
		return { dA, dB, xId, yId, zId };
	}

	it("delete-nodes: the shared node survives with the other session's content; the orphan dies; the creator's aliases are stripped (owner ruling 2026-09-23)", () => {
		const { dA, dB, xId, yId, zId } = buildTwoSessionScenario();
		const zLineBefore = JSON.stringify(graphStore.readNodes().find((n) => n.id === zId));

		const stats = deleteChatTraces(graphStore, dA.id, "delete-nodes");
		assert.deepEqual(stats, {
			nodesRemoved: 1,
			edgesRemoved: 1,
			eventsRemoved: 2,
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
		assert.deepEqual(x.provenance, [{ chatId: dB.id, messageId: "eu1" }], "only dB's provenance remains");
		// Y (the orphan) is gone entirely.
		assert.equal(graph.nodes.some((n) => n.id === yId), false);
		assert.equal(graphStore.readNodes().some((n) => n.id === yId), false);
		// Z (dB-only) is untouched, byte-identical.
		assert.equal(JSON.stringify(graphStore.readNodes().find((n) => n.id === zId)), zLineBefore);
		// Edges: dA's assertion X→Y died; dB's X→Z survived.
		const scoped = scopedGraph([dA.id, dB.id]);
		assert.deepEqual(scoped.edges, [{ from: xId, to: zId, type: "follows", provenance: [{ chatId: dB.id, messageId: "eu1" }] }]);
		// Events: only dB's quiz + observation remain.
		assert.deepEqual(scoped.events.map((e) => [e.kind, e.chatId === dB.id]), [
			["miss", true],
			["observation", true],
		]);
		// Mappings: dA's audit trail died; dB's stays.
		const mappings = graphStore.readMappings().filter((m) => [dA.id, dB.id].includes(m.chatId));
		assert.deepEqual(mappings, [{ chatId: dB.id, sourceId: "q1", graphNodeId: xId }, { chatId: dB.id, sourceId: "q2", graphNodeId: zId }]);
		// Positions/embeddings: the orphan pruned everywhere.
		const positions = graphStore.readPositions();
		assert.equal(positions[yId], undefined);
		assert.deepEqual(positions[xId], { x: 1, y: 1 });
		const emb = graphStore.readEmbeddings();
		assert.equal(emb.vectors[yId], undefined);
		assert.ok(emb.vectors[xId] && emb.vectors[zId]);
		assert.deepEqual(emb.clusters.at(-1), { members: [xId, zId] }, "dead members pruned from the hull");
		// The snapshot resolves X to dB only — the deleted chat left no ghost.
		const snapshot = graphSnapshot(graphDeps);
		assert.deepEqual(snapshot.nodeSessions[xId], [dB.id]);
		assert.deepEqual(snapshot.nodeObservations[xId], { [dB.id]: "shaky" });
		assert.ok(snapshot.sessions[dB.id] && !snapshot.sessions[dA.id]);
		// Atomic rewrites left no temp files, and appends still work.
		assert.equal(fs.readdirSync(PATHS.graph).filter((f) => f.includes(".tmp-")).length, 0);
		const eventsBefore = graphStore.readEvents().length;
		graphStore.appendEvent({ nodeId: null, kind: "correct", chatId: "chat_del_append_probe", at: "2026-09-23T00:04:00.000Z" });
		assert.equal(graphStore.readEvents().length, eventsBefore + 1);
		// Idempotent: a second run finds nothing.
		assert.deepEqual(deleteChatTraces(graphStore, dA.id, "delete-nodes"), { ...stats, nodesRemoved: 0, edgesRemoved: 0, eventsRemoved: 0, mappingsRemoved: 0, coverageRemoved: 0, checkpointsRemoved: 0 } satisfies ChatDeletionStats);
	});

	it("preserve-graph: only the extraction bookkeeping dies — the graph ledgers are byte-identical", () => {
		const { dA, dB, xId, yId, zId } = buildTwoSessionScenario();
		const before = {
			nodes: graphStore.readNodes(),
			edges: graphStore.readEdges(),
			events: graphStore.readEvents(),
			mappings: graphStore.readMappings(),
			positions: graphStore.readPositions(),
			embeddings: graphStore.readEmbeddings(),
		};
		const stats = deleteChatTraces(graphStore, dA.id, "preserve-graph");
		assert.deepEqual(stats, {
			nodesRemoved: 0,
			edgesRemoved: 0,
			eventsRemoved: 0,
			mappingsRemoved: 0,
			coverageRemoved: 2,
			checkpointsRemoved: 1,
		} satisfies ChatDeletionStats);
		assert.deepEqual(graphStore.readNodes(), before.nodes);
		assert.deepEqual(graphStore.readEdges(), before.edges);
		assert.deepEqual(graphStore.readEvents(), before.events);
		assert.deepEqual(graphStore.readMappings(), before.mappings);
		assert.deepEqual(graphStore.readPositions(), before.positions);
		assert.deepEqual(graphStore.readEmbeddings(), before.embeddings);
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
