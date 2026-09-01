/**
 * The extraction pipeline tests (vision §1 construction): extractor →
 * auditor → merger, the sole graph writer.
 *
 *   transcriptView  — the compact view both LLM stages see (pure)
 *   pipeline        — MockLanguageModelV4 drives both agents: findings out,
 *                     audit verdict in, deterministic merge applied; failure
 *                     paths checkpoint nothing; single-flight per chat
 *
 * The merger itself (identity resolution, event rebuild, idempotency) is
 * tested in tests/graph.test.ts directly against mergeFindings — here it is
 * the integration: what one full pipeline run does to the ledgers.
 *
 * Ledger: in-memory (the GraphStore port) — this suite never touches
 * data/graph. Chats: real ChatRecords in the real chat store (created and
 * deleted by this suite).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { UIMessage } from "ai";
import type { GraphEdge, GraphNode, LedgerEvent, NodeMapping, SessionCheckpoint, SessionFindings } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { createTree, markDone } from "../src/core/plan-tree.ts";
import { createExtractionPipeline, transcriptView } from "../src/agent/subagents/extraction.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const createdChats: string[] = [];

function usage() {
	return {
		inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 5, text: 5, reasoning: 0 },
	};
}

/** An in-memory GraphStore (core/ports.ts) — this suite never touches data/graph. */
function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const events: LedgerEvent[] = [];
	const mappings: NodeMapping[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	return {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendEdge: (e: GraphEdge) => void edges.push(e),
		readEdges: () => edges.map((e) => ({ ...e })),
		appendEvent: (e: LedgerEvent) => void events.push(e),
		readEvents: () => events.map((e) => ({ ...e })),
		appendMapping: (m: NodeMapping) => void mappings.push(m),
		readMappings: () => mappings.map((m) => ({ ...m })),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
	} satisfies GraphStore;
}

function assistant(id: string, parts: unknown[]): UIMessage {
	return { id, role: "assistant", parts } as unknown as UIMessage;
}

function user(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function quizPart(toolCallId: string, input: Record<string, unknown>, output: Record<string, unknown>): unknown {
	return { type: "tool-quiz", toolCallId, state: "output-available", input, output };
}

function planPart(toolCallId: string, name: string, input: Record<string, unknown>, tree: ReturnType<typeof createTree>): unknown {
	return {
		type: `tool-${name}`,
		toolCallId,
		state: "output-available",
		input,
		output: { ok: true, tree },
	};
}

/** A session-shaped fixture chat: probe → plan → check → mark_done. */
function fixtureChat() {
	const tree = markDone(
		createTree(
			[
				{ id: "cr", title: "Chain rule intuition" },
				{ id: "apply", title: "Applying the chain rule" },
			],
			[{ from: "cr", to: "apply" }],
		),
		"cr",
	);
	const chat = chatStore.createChat("Extraction fixture");
	createdChats.push(chat.id);
	chatStore.saveTree(chat.id, tree);
	chatStore.saveMessages(chat.id, [
		user("u1", "teach me the chain rule"),
		assistant("a1", [
			quizPart("probe-1", { question: "What is a derivative, roughly?" }, {
				questionId: "probe-1", kind: "quiz", questionText: "What is a derivative, roughly?",
				correct: false, dontKnow: false, answeredAt: "2026-08-22T01:00:00.000Z",
			}),
		]),
		assistant("a2", [
			{ type: "text", text: "The derivative measures how fast a function changes." },
			planPart("p1", "plan_init", { nodes: [], edges: [] }, tree),
		]),
		assistant("a3", [
			quizPart("check-1", { question: "Check", nodeId: "apply" }, {
				questionId: "check-1", kind: "quiz", questionText: "Check", correct: true, dontKnow: false,
				answeredAt: "2026-08-22T02:00:00.000Z",
			}),
		]),
		assistant("a4", [planPart("p2", "plan_mark_done", { id: "cr" }, tree)]),
	]);
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});

/** What the extractor would produce for the fixture session. */
const FINDINGS: SessionFindings = {
	propositions: [
		{
			id: "p1",
			name: "Chain rule",
			statement: "Chain rule intuition",
			aliases: [],
			kind: "truth",
			treeNodeId: "cr",
			evidence: ["TEACHER: The derivative measures how fast a function changes."],
		},
		{
			id: "p2",
			name: "Applying chain rule",
			statement: "Applying the chain rule",
			aliases: [],
			kind: "truth",
			treeNodeId: "apply",
			evidence: ["FINAL PLAN TREE (node ids): cr = Chain rule intuition; apply = Applying the chain rule"],
		},
	],
	edges: [{ from: "p1", to: "p2", type: "requires", evidence: ["TREE EDGES: cr requires apply"] }],
	attribution: { quiz: { "probe-1": "p1" } },
};

/** A model whose ONE tool call is `name` with the given input; then text. */
function submitModel(name: string, input: unknown): MockLanguageModelV4 {
	let turn = 0;
	return new MockLanguageModelV4({
		doGenerate: async () => {
			turn++;
			if (turn === 1) {
				return {
					content: [
						{
							type: "tool-call" as const,
							toolCallId: `${name}-call`,
							toolName: name,
							input: JSON.stringify(input),
						},
					],
					finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
					usage: usage(),
					warnings: [],
				};
			}
			return {
				content: [{ type: "text" as const, text: "submitted" }],
				finishReason: { unified: "stop" as const, raw: "stop" },
				usage: usage(),
				warnings: [],
			};
		},
	});
}

/** A model that never calls a tool (the failure path). */
function silentModel(): MockLanguageModelV4 {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: "I refuse to use tools" }],
			finishReason: { unified: "stop" as const, raw: "stop" },
			usage: usage(),
			warnings: [],
		}),
	});
}

// ─── transcriptView (pure) ───────────────────────────────────────────────────

describe("transcriptView (pure)", () => {
	it("shows the final tree, verbatim conversation, structured events — plan ops folded", () => {
		const { record } = fixtureChat();
		const view = transcriptView(record);

		// The final tree with node ids (the extractor's backbone + the
		// pruned-out stays pruned — only the FINAL tree is shown).
		assert.match(view, /SESSION: Extraction fixture/);
		assert.match(view, /FINAL PLAN TREE \(node ids\): cr = Chain rule intuition; apply = Applying the chain rule/);
		assert.match(view, /TREE EDGES: cr requires apply/);

		// Conversation verbatim — evidence quotes can come from it.
		assert.match(view, /LEARNER: teach me the chain rule/);
		assert.match(view, /TEACHER: The derivative measures how fast a function changes\./);

		// Structured events, attribution-ready.
		assert.match(view, /QUIZ \[probe-1\] What is a derivative, roughly\? — the learner answered incorrectly/);
		assert.match(view, /QUIZ \[check-1\] Check — the learner answered correctly/);
		assert.match(view, /TEACHER marked tree node done \[p2\]: cr/);

		// plan_init / plan_mark_done tool parts themselves are folded into
		// the tree line — no raw JSON noise.
		assert.doesNotMatch(view, /plan_init/);
		assert.doesNotMatch(view, /output-available/);
	});

	it("summarizes job tool results as one line and drops empty text", () => {
		const chat = chatStore.createChat("View noise fixture");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			user("u1", "go"),
			assistant("a1", [
				{
					type: "tool-research",
					toolCallId: "r1",
					state: "output-available",
					input: { question: "q" },
					output: { brief: "long brief", sources: [] },
				},
				{ type: "text", text: "   " },
			]),
		]);
		const view = transcriptView(chatStore.getChat(chat.id)!);
		assert.match(view, /\(research tool result delivered\)/);
		assert.doesNotMatch(view, /long brief/);
		assert.doesNotMatch(view, /TEACHER: {2}/);
	});
});

// ─── the pipeline ───────────────────────────────────────────────────────────

describe("the extraction pipeline (extractor → auditor → merger)", () => {
	it("runs end to end: findings → audit verdict → deterministic merge + checkpoint", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The auditor passes p1 through, drops p2 (unbacked), re-points the
		// probe attribution to p1, and records the drop.
		const verified: SessionFindings = {
			propositions: [FINDINGS.propositions[0]!],
			edges: [],
			attribution: { quiz: { "probe-1": "p1" } },
		};

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", { ...verified, dropped: [{ ref: "p2", reason: "evidence not found" }] }),
		});
		const stats = await pipeline.runExtraction(chatId);

		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 3 });

		// Only the audited proposition became a node; mapping provenance kept.
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readNodes()[0]!.statement, "Chain rule intuition");
		assert.deepEqual(ledgers.readMappings(), [{ chatId, sourceId: "cr", graphNodeId: ledgers.readNodes()[0]!.id }]);

		// Events rebuilt deterministically from the transcript — the probe
		// retroactively attributed, the check tagged, mark_done mapped.
		const events = ledgers.readEvents();
		assert.deepEqual(
			events.map((e) => [e.kind, e.ref]),
			[
				["probe-miss", "probe-1"],
				["check-correct", "check-1"],
				["taught", "taught:cr"],
			],
		);
		const nodeId = ledgers.readNodes()[0]!.id;
		assert.equal(events[0]!.nodeId, nodeId, "probe attributed via audit");
		assert.equal(events[1]!.nodeId, null, "tagged to a dropped proposition → null");
		assert.equal(events[2]!.nodeId, nodeId, "taught via tree-node mapping");

		// Checkpointed through the record's updatedAt — never the same turns twice.
		assert.equal(ledgers.readCheckpoints().length, 1);
	});

	it("checkpoints nothing when a stage fails", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: silentModel(), // never submits the review
		});
		await assert.rejects(pipeline.runExtraction(chatId), /the auditor never submitted a review/);
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0, "no checkpoint — the next trigger re-runs");

		const failingExtractor = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: silentModel(),
			auditor: submitModel("submit_review", FINDINGS),
		});
		await assert.rejects(failingExtractor.runExtraction(chatId), /the extractor never submitted findings/);
		assert.equal(ledgers.readCheckpoints().length, 0);
	});

	it("is single-flight per chat — a concurrent second run is a no-op", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The extractor's first call hangs until we release it.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const gatedExtractor = new MockLanguageModelV4({
			doGenerate: async () => {
				calls++;
				if (calls === 1) await gate;
				return {
					content: [{ type: "text" as const, text: "…" }],
					finishReason: { unified: "stop" as const, raw: "stop" },
					usage: usage(),
					warnings: [],
				};
			},
		});

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: gatedExtractor,
			auditor: silentModel(),
		});

		const first = pipeline.runExtraction(chatId);
		const second = await pipeline.runExtraction(chatId); // in-flight → zeros
		assert.deepEqual(second, { nodes: 0, edges: 0, events: 0 });

		release();
		await assert.rejects(first, /the extractor never submitted findings/);
	});

	it("throws for unknown chats", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: silentModel(),
			auditor: silentModel(),
		});
		await assert.rejects(pipeline.runExtraction("chat_does_not_exist"), /Chat not found/);
	});
});
