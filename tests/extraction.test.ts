/**
 * The extraction pipeline tests (vision §1 construction, 2026-09-02 redesign):
 * extractor → auditor → merger, the sole graph writer — tree-blind,
 * free-form, with the auditor owning faithfulness and identity.
 *
 *   transcriptView  — the compact view both LLM stages see (pure):
 *                     message-id-tagged verbatim text + quiz lines, NO tree
 *   pipeline        — MockLanguageModelV4 drives both agents: findings out,
 *                     audit verdict (with linkTo identity) in, deterministic
 *                     merge applied; failure paths checkpoint nothing;
 *                     single-flight per chat
 *
 * The merger itself (identity verdicts, event rebuild, idempotency) is
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
import type {
	AuditResult,
	GraphEdge,
	GraphNode,
	LedgerEvent,
	NodeMapping,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { createExtractionPipeline, extractionStatuses, transcriptView } from "../src/agent/subagents/extraction.ts";
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

function planPart(toolCallId: string, name: string, input: Record<string, unknown>, tree: unknown): unknown {
	return {
		type: `tool-${name}`,
		toolCallId,
		state: "output-available",
		input,
		output: { ok: true, tree },
	};
}

/** A session-shaped fixture chat: probe → teaching text → check. Tree-blind
 *  world: the plan tree is NOT part of extraction — it is noise. */
function fixtureChat() {
	const chat = chatStore.createChat("Extraction fixture");
	createdChats.push(chat.id);
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
			planPart("p1", "plan_init", { nodes: [], edges: [] }, { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 1 }),
		]),
		assistant("a3", [
			quizPart("check-1", { question: "Check" }, {
				questionId: "check-1", kind: "quiz", questionText: "Check", correct: true, dontKnow: false,
				answeredAt: "2026-08-22T02:00:00.000Z",
			}),
		]),
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

/** What the extractor would produce for the fixture session — tree-blind,
 *  free-form, with message-granular provenance + an understanding note. */
const FINDINGS: SessionFindings = {
	propositions: [
		{
			id: "p1",
			name: "Derivative",
			statement: "The derivative measures how fast a function changes",
			aliases: [],
			messages: ["a2"],
			evidence: ["TEACHER [a2]: The derivative measures how fast a function changes."],
			understanding: "solid",
		},
		{
			id: "p2",
			name: "Chain rule",
			statement: "The chain rule differentiates composed functions by multiplying local rates.",
			aliases: [],
			messages: ["a2"],
			evidence: ["LEARNER [u1]: teach me the chain rule"],
		},
	],
	edges: [
		{
			from: "p1",
			to: "p2",
			type: "follows",
			messages: ["a2"],
			evidence: ["LEARNER [u1]: teach me the chain rule"],
		},
	],
	attribution: { quiz: { "probe-1": "p1", "check-1": "p2" } },
};

/** A model whose ONE tool call is `name` with the given input; then text.
 *  `onCall` (optional) fires at the moment of the first generate — the
 *  observation point for mid-run assertions. */
function submitModel(name: string, input: unknown, onCall?: () => void): MockLanguageModelV4 {
	let turn = 0;
	return new MockLanguageModelV4({
		doGenerate: async () => {
			turn++;
			if (turn === 1) {
				onCall?.();
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
	it("shows message-id-tagged verbatim conversation + quiz lines — tree-blind, plan ops folded", () => {
		const { record } = fixtureChat();
		const view = transcriptView(record);

		assert.match(view, /SESSION: Extraction fixture/);

		// Conversation verbatim, each line tagged with its message id —
		// the provenance anchors the extractor reports back.
		assert.match(view, /LEARNER \[u1\] teach me the chain rule/);
		assert.match(view, /TEACHER \[a2\] The derivative measures how fast a function changes\./);

		// Structured events, attribution-ready.
		assert.match(view, /QUIZ \[probe-1\] What is a derivative, roughly\? — the learner answered incorrectly/);
		assert.match(view, /QUIZ \[check-1\] Check — the learner answered correctly/);

		// TREE-BLIND: no plan tree, no tree edges, no mark_done lines — plan
		// ops fold to the generic one-liner like every other non-quiz tool.
		assert.doesNotMatch(view, /FINAL PLAN TREE/);
		assert.doesNotMatch(view, /TREE EDGES/);
		assert.match(view, /\(plan_init tool result delivered\)/);
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
	it("runs end to end: findings → audit verdict (identity) → deterministic merge + checkpoint", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The auditor passes p1 through and LINKS it to a pre-existing node
		// (identity verdict), drops p2 (unbacked) + the edge with it.
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const verdict: AuditResult = {
			propositions: [
				{ ...FINDINGS.propositions[0]!, linkTo: existingId },
			],
			edges: [],
			attribution: { quiz: { "probe-1": "p1" } },
			dropped: [{ ref: "p2", reason: "evidence not found" }, { ref: "p1→p2", reason: "endpoint dropped" }],
		};

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);

		// The linked proposition created NO new node; the understanding note
		// became an observation; both quizzes became events.
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 3 });

		// Link-append: the phrasing joined the existing node's aliases and
		// the provenance unioned; no second node line defines a new node.
		assert.equal(ledgers.readNodes().length, 2); // the pre-seeded line + the link line
		assert.deepEqual(ledgers.readMappings(), [{ chatId, sourceId: "p1", graphNodeId: existingId }]);

		// Events rebuilt deterministically: quizzes in transcript order, then
		// the observation. check-1's attribution pointed at the DROPPED p2 →
		// unresolvable → null (the question text is kept for later attribution).
		const events = ledgers.readEvents();
		assert.deepEqual(
			events.map((e) => [e.kind, e.ref, e.nodeId]),
			[
				["miss", "probe-1", existingId],
				["correct", "check-1", null],
				["observation", "obs:p1", existingId],
			],
		);
		assert.equal(events[0]!.nodeId, existingId, "probe attributed via the verdict's mapping");
		assert.equal(events[2]!.note, "solid", "the understanding note joins the ledger");

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
			auditor: submitModel("submit_review", { ...FINDINGS, dropped: [] }),
		});
		await assert.rejects(failingExtractor.runExtraction(chatId), /the extractor never submitted findings/);
		assert.equal(ledgers.readCheckpoints().length, 0);
	});

	it("reports its phase through the status registry while running, and clears it when done", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const seen: (string | undefined)[] = [];
		const phaseOf = () => extractionStatuses().find((r) => r.chatId === chatId)?.phase;
		const verdict: AuditResult = {
			propositions: [{ ...FINDINGS.propositions[0]!, linkTo: existingId }],
			edges: [],
			attribution: { quiz: {} },
			dropped: [{ ref: "p2", reason: "evidence not found" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// Each stage's first generate is the observation point: the
			// registry must already carry this chat at the right phase.
			extractor: submitModel("submit_findings", FINDINGS, () => seen.push(phaseOf())),
			auditor: submitModel("submit_review", verdict, () => seen.push(phaseOf())),
		});
		await pipeline.runExtraction(chatId);
		assert.deepEqual(seen, ["extracting", "auditing"]);
		assert.equal(extractionStatuses().length, 0, "the registry clears when the run ends");
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
