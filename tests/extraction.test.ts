/**
 * The extraction pipeline tests (vision §1 construction, 2026-09-02 redesign):
 * extractor → auditor → merger, the sole graph writer — tree-blind,
 * free-form, with the auditor owning faithfulness and identity.
 *
 *   transcriptView  — the compact view both LLM stages see (pure):
 *                     message-id-tagged verbatim text + quiz lines, NO tree
 *   pipeline        — scripted faux engines drive both agents: findings out,
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
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { UIMessage } from "ai";
import type { PiEngine } from "../src/agent/models.ts";
import type {
	AuditResult,
	ClusterLabeling,
	ExtractionRunUsage,
	GraphEdge,
	GraphNode,
	LedgerEvent,
	NodeMapping,
	NotesSource,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { abortExtraction, createExtractionPipeline, extractionStatuses, transcriptView } from "../src/agent/subagents/extraction.ts";
import { clusterNamingSettled, refreshClusterLabels } from "../src/agent/subagents/cluster-namer.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const createdChats: string[] = [];

/** A scripted pi engine (faux provider, docs/pi-engine-swap.md §7): the
 *  response queue replaces the old doGenerate turn counter. Usage is
 *  ESTIMATED by faux from the prompt/response text (deterministic, > 0) —
 *  the tests assert structure and positivity, not flat mock numbers. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** An in-memory GraphStore (core/ports.ts) — this suite never touches data/graph. */
function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const events: LedgerEvent[] = [];
	const mappings: NodeMapping[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const sources = new Map<string, NotesSource>();
	const clusterLabels: ClusterLabeling[] = [];
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
		upsertSource: (s: NotesSource) => {
			// Mirrors the real store: an upsert KEEPS the existing usage log.
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		appendSourceUsage: (id: string, entry: ExtractionRunUsage) => {
			const source = sources.get(id);
			if (!source) return;
			if (!source.extractions?.some((r) => r.startedAt === entry.startedAt)) {
				source.extractions = [...(source.extractions ?? []), entry];
			}
		},
		// Cluster labelings — mirrors the real store: append dedupes by id.
		appendClusterLabel: (l: ClusterLabeling) => {
			if (!clusterLabels.some((x) => x.id === l.id)) clusterLabels.push(l);
		},
		readClusterLabels: () => clusterLabels.map((l) => ({ ...l, core: [...l.core] })),
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

/** An engine whose ONE response is the `name` tool call with the given
 *  input — the whole deliverable; the pipeline stops after a clean submit
 *  (shouldStop), so no trailing text step exists anymore. `onCall` fires at
 *  the moment of the model call — the observation point for mid-run
 *  assertions. */
function submitModel(name: string, input: unknown, onCall?: () => void): PiEngine {
	return fauxEngine([
		(context) => {
			onCall?.();
			void context;
			return fauxAssistantMessage(
				[fauxToolCall(name, input as Record<string, unknown>, { id: `${name}-call` })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

/** An engine whose model call never resolves until its abort signal fires
 *  — mimicking a cancelled provider request (the abort path). Like a real
 *  provider, an ALREADY-aborted signal resolves immediately (the abort can
 *  win the race before the call attaches its listener); the faux stream
 *  then sees the aborted signal and ends the message as aborted. */
function hangingModel(): PiEngine {
	return fauxEngine([
		(_context, options) =>
			new Promise((resolve) => {
				const sig = options?.signal;
				if (sig?.aborted) {
					resolve(fauxAssistantMessage("late"));
					return;
				}
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			}),
	]);
}

/** An engine that never calls a tool (the failure path). */
function silentModel(): PiEngine {
	return fauxEngine([fauxAssistantMessage("I refuse to use tools"), fauxAssistantMessage("…")]);
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
			labeler: submitModel("submit_labels", { labels: [] }),
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
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		await assert.rejects(pipeline.runExtraction(chatId), /the auditor never submitted a review/);
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0, "no checkpoint — the next trigger re-runs");

		const failingExtractor = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: silentModel(),
			auditor: submitModel("submit_review", { ...FINDINGS, dropped: [] }),
			labeler: submitModel("submit_labels", { labels: [] }),
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
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		await pipeline.runExtraction(chatId);
		assert.deepEqual(seen, ["extracting", "auditing"]);
		assert.equal(extractionStatuses().length, 0, "the registry clears when the run ends");
	});

	it("captures per-stage usage live, persists the run's usage into the chat record", async () => {
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
		const usageSeen: (number | undefined)[] = [];
		const verdict: AuditResult = {
			propositions: [{ ...FINDINGS.propositions[0]!, linkTo: existingId }],
			edges: [],
			attribution: { quiz: {} },
			dropped: [{ ref: "p2", reason: "evidence not found" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// During the auditor's generate, the registry must already carry
			// the extractor's fully accumulated live usage (2 steps × 10/5).
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict, () =>
				usageSeen.push(extractionStatuses().find((r) => r.chatId === chatId)?.usage.extractor?.steps.at(-1)?.inputTokens),
			),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		await pipeline.runExtraction(chatId);

		// Live: mid-audit the extractor's usage was fully accumulated (faux
		// estimates tokens from the prompt/response text — deterministic,
		// positive, no cache).
		assert.equal(usageSeen.length, 1);
		assert.ok(typeof usageSeen[0] === "number" && usageSeen[0]! > 0, "the extractor's step billed input tokens");

		// Persisted: the run appended ONE usage entry to the chat's
		// extractions log — per-stage model + steps, with merge stats.
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.extractions?.length, 1);
		const run = record.extractions![0]!;
		assert.equal(run.stats?.nodes, 0); // linked, not created
		assert.equal(run.stats?.events, 3);
		assert.equal(run.stages.extractor.model, "faux-1"); // the scripted engine's model id
		assert.equal(run.stages.extractor.steps.length, 1); // the submit call — the run STOPS after a clean submit
		const step = run.stages.extractor.steps[0]!;
		assert.ok(step.inputTokens! > 0 && step.outputTokens! > 0, "estimated usage captured");
		assert.equal(step.cacheReadTokens, 0);
		assert.equal(step.cacheWriteTokens, 0);
		assert.equal(step.reasoningTokens, 0);
		assert.equal(run.stages.auditor.steps.length, 1);
		assert.ok(!Number.isNaN(Date.parse(run.at)));
	});

	it("aborts mid-run: cancels the model call, persists partial usage, checkpoints nothing", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: hangingModel(), // hangs until aborted — no step finishes
			auditor: submitModel("submit_review", { propositions: [], edges: [], attribution: { quiz: {} }, dropped: [] }),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		const runPromise = pipeline.runExtraction(chatId);

		// The registry entry exists synchronously after the call (setPhase
		// runs before the first await); abort is TRUE cancellation.
		assert.equal(abortExtraction(chatId), true);
		const stats = await runPromise;

		// A deliberate stop, not a failure: zero emissions, no throw.
		assert.deepEqual(stats, { nodes: 0, edges: 0, events: 0 });
		assert.equal(extractionStatuses().length, 0, "the registry clears");
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCheckpoints().length, 0, "nothing checkpointed — the next trigger re-runs");

		// Partial usage still persisted (money was spent): stats absent,
		// no completed steps in either stage.
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.extractions?.length, 1);
		const run = record.extractions![0]!;
		assert.equal(run.stats, undefined);
		assert.equal(run.stages.extractor.steps.length, 0);
		assert.equal(run.stages.auditor.steps.length, 0);

		// Aborting a non-running chat is an idempotent no-op.
		assert.equal(abortExtraction(chatId), false);
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
		const gatedExtractor = fauxEngine([
			async () => {
				calls++;
				if (calls === 1) await gate;
				return fauxAssistantMessage("…");
			},
		]);

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: gatedExtractor,
			auditor: silentModel(),
			labeler: submitModel("submit_labels", { labels: [] }),
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
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		await assert.rejects(pipeline.runExtraction("chat_does_not_exist"), /Chat not found/);
	});
});

// ── the notes front door (format-agnostic import) ────────────────────────────

/** Raw personal notes — arbitrary format, no session, no message ids. */
const NOTES_TEXT = `> [!quote] YOU
> teach me vim

> [!abstract] PI
> Vim always starts in Normal mode — keys are commands, not text.`;

/** What the notes-mode extractor submits: same shapes minus attribution,
 *  and messages always empty (the file is the provenance). */
const NOTES_FINDINGS = {
	propositions: [
		{
			id: "p1",
			name: "Vim normal mode",
			statement: "Vim starts in Normal mode, where keys are commands.",
			aliases: [],
			messages: [],
			evidence: ["Vim always starts in Normal mode — keys are commands, not text."],
			understanding: "solid",
		},
	],
	edges: [],
} as const;

const NOTES_VERDICT = {
	propositions: [NOTES_FINDINGS.propositions[0]],
	edges: [],
	dropped: [],
} as const;

const CLUSTER_FINDINGS = {
	propositions: [
		{ id: "p1", name: "Modal editing", statement: "Vim edits text through modal command modes.", aliases: [], messages: [], evidence: ["Normal mode keys are commands."], understanding: "solid" },
		{ id: "p2", name: "Verb-object grammar", statement: "Vim commands compose as verb and object.", aliases: [], messages: [], evidence: ["d then motion deletes."], understanding: "solid" },
		{ id: "p3", name: "Operator-pending", statement: "Vim enters operator-pending mode between verb and object.", aliases: [], messages: [], evidence: ["After d, a motion is expected."], understanding: "solid" },
	],
	edges: [
		{ from: "p1", to: "p2", type: "follows", messages: [], evidence: ["e"] },
		{ from: "p2", to: "p3", type: "follows", messages: [], evidence: ["e"] },
	],
} as const;

const CLUSTER_VERDICT = {
	propositions: CLUSTER_FINDINGS.propositions,
	edges: CLUSTER_FINDINGS.edges,
	dropped: [],
} as const;

describe("cluster naming (the post-extraction garnish)", () => {
	it("names a new community after a notes merge — one record, claimed on the next refresh", async () => {
		const ledgers = memoryLedgers();
		const namerCalls: number[] = [];
		const labeler = submitModel("submit_labels", { labels: [{ key: "c0", label: "Vim modal grammar" }] }, () => namerCalls.push(1));
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", CLUSTER_FINDINGS),
			auditor: submitModel("submit_review", CLUSTER_VERDICT),
			labeler,
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/modal.md", text: "raw notes, any format" });
		assert.deepEqual(stats, { nodes: 3, edges: 2, events: 3 });
		// The refresh is fire-and-forget inside the pipeline — settle it.
		await clusterNamingSettled();
		assert.equal(namerCalls.length, 1, "ONE singular naming call");
		const records = ledgers.readClusterLabels();
		assert.equal(records.length, 1);
		assert.equal(records[0]!.label, "Vim modal grammar");
		assert.equal(records[0]!.core.length, 3);
		assert.match(records[0]!.id, /^clu_/);
		// Second refresh: core-survival claims it — nothing new to name.
		const again = await refreshClusterLabels({ graphStore: ledgers, engine: labeler });
		assert.equal(again.named, 0);
		assert.equal(again.appended, 0);
		assert.ok(again.claimed >= 1);
		assert.equal(ledgers.readClusterLabels().length, 1, "no duplicate records");
	});

	it("naming failure never fails the run", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", CLUSTER_FINDINGS),
			auditor: submitModel("submit_review", CLUSTER_VERDICT),
			labeler: silentModel(), // never submits — the namer throws
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/modal.md", text: "raw notes" });
		assert.deepEqual(stats, { nodes: 3, edges: 2, events: 3 }, "the merge itself succeeded");
		await clusterNamingSettled();
		assert.equal(ledgers.readClusterLabels().length, 0, "nothing named, nothing appended");
	});
});

describe("the notes front door (importNotes — format-agnostic)", () => {
	it("imports raw notes end to end: source record, file-scoped provenance, no quiz events", async () => {
		const ledgers = memoryLedgers();
		const seen: { kind?: string; label?: string }[] = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", NOTES_FINDINGS),
			// During the auditor's call the registry must show the notes run.
			auditor: submitModel("submit_review", NOTES_VERDICT, () => {
				const run = extractionStatuses().find((r) => r.chatId.startsWith("src_"));
				seen.push({ kind: run?.kind, label: run?.label });
			}),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });

		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 1 });
		// The run surfaced as a NOTES run labeled with the file path.
		assert.deepEqual(seen, [{ kind: "notes", label: "/vault/learn vim.md" }]);
		assert.equal(extractionStatuses().length, 0, "the registry clears when the run ends");

		// The source record: deterministic src id, the file path, the usage log.
		const source = ledgers.readSources()[0]!;
		assert.match(source.id, /^src_/);
		assert.equal(source.filePath, "/vault/learn vim.md");
		assert.ok(Date.parse(source.importedAt));
		assert.equal(source.extractions?.length, 1, "the run's usage persisted into the source record");
		assert.equal(source.extractions![0]!.stats?.nodes, 1);
		assert.ok(source.extractions![0]!.stages.extractor.steps.length > 0, "faux usage captured");

		// File-scoped provenance: the mapping line carries the source id;
		// the node carries NO message anchors.
		const node = ledgers.readNodes()[0]!;
		assert.equal(node.statement, "Vim starts in Normal mode, where keys are commands.");
		assert.deepEqual(node.provenance, []);
		assert.deepEqual(ledgers.readMappings(), [{ chatId: source.id, sourceId: "p1", graphNodeId: node.id }]);

		// One observation event, zero quiz events — outcomes inside notes
		// surface only through understanding observations (user-decided).
		const events = ledgers.readEvents();
		assert.deepEqual(
			events.map((e) => [e.kind, e.chatId, e.ref, e.note]),
			[["observation", source.id, "obs:p1", "solid"]],
		);
		// The checkpoint stamps the import.
		assert.equal(ledgers.readCheckpoints()[0]!.chatId, source.id);
	});

	it("re-importing the same file is idempotent: same source identity, refs dedupe, usage history grows", async () => {
		const ledgers = memoryLedgers();
		const mk = () =>
			createExtractionPipeline({
				chatStore,
				graphStore: ledgers,
				extractor: submitModel("submit_findings", NOTES_FINDINGS),
				auditor: submitModel("submit_review", NOTES_VERDICT),
				labeler: submitModel("submit_labels", { labels: [] }),
			});
		const first = await mk().importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(first, { nodes: 1, edges: 0, events: 1 });

		const second = await mk().importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(second, { nodes: 0, edges: 0, events: 0 }, "the same source id dedupes everything");

		assert.equal(ledgers.readSources().length, 1, "one source identity — the path hashes to the same id");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2, "both runs billed their usage");
		assert.equal(ledgers.readNodes().length, 1, "no duplicate node");
	});

	it("aborts like a chat run: true cancellation, nothing merged, partial usage in the source record", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: hangingModel(),
			auditor: submitModel("submit_review", NOTES_VERDICT),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		const runPromise = pipeline.importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });

		const srcId = extractionStatuses().find((r) => r.chatId.startsWith("src_"))!.chatId;
		assert.equal(abortExtraction(srcId), true);
		assert.deepEqual(await runPromise, { nodes: 0, edges: 0, events: 0 });
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCheckpoints().length, 0, "nothing checkpointed");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1, "partial usage still persisted");
		assert.equal(ledgers.readSources()[0]!.extractions![0]!.stats, undefined, "never merged → no stats");
	});
});
