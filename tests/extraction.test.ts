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
	CoverageEntry,
	ExtractionRunUsage,
	GraphEdge,
	GraphNode,
	LedgerEvent,
	NamingRunUsage,
	NodeMapping,
	NotesSource,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { abortExtraction, createExtractionPipeline, extractionStatuses, transcriptView } from "../src/agent/subagents/extraction.ts";
import { batchTag, coverageOf, coverageSlots } from "../src/core/coverage.ts";
import { clusterNamingSettled, refreshClusterLabels } from "../src/agent/subagents/cluster-namer.ts";
import { semanticClusters } from "../src/core/semantic-clusters.ts";
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
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	const clusterLabels: ClusterLabeling[] = [];
	const namingRuns: NamingRunUsage[] = [];
	const positions = new Map<string, { x: number; y: number }>();
	const embeddings = {
		model: "",
		dim: 0,
		updatedAt: "",
		vectors: new Map<string, number[]>(),
		clusters: new Array<Array<string>>(),
	};
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
		// Extraction coverage (vision-extraction-coverage.md) — append-only;
		// the chat pipeline checkpoints one entry per covered message.
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
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
		// Cluster-naming run usage — mirrors the real store: dedupe per startedAt.
		appendNamingUsage: (entry: NamingRunUsage) => {
			if (!namingRuns.some((r) => r.startedAt === entry.startedAt)) namingRuns.push(entry);
		},
		readNamingRuns: () => namingRuns.map((r) => ({ ...r, steps: [...r.steps], stats: { ...r.stats } })),
		// The layout ledger — settleGraphLayout writes it after each merge.
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		// The embedding ledger — the embedder writes it after a merge.
		readEmbeddings: () => ({ model: embeddings.model, dim: embeddings.dim, vectors: Object.fromEntries([...embeddings.vectors].map(([id, v]) => [id, [...v]])), clusters: [...embeddings.clusters.map((c) => ({ members: [...c] }))], updatedAt: embeddings.updatedAt }),
		writeEmbeddings: (next) => {
			embeddings.model = next.model;
			embeddings.dim = next.dim;
			embeddings.updatedAt = next.updatedAt;
			embeddings.vectors.clear();
			for (const [id, v] of Object.entries(next.vectors)) embeddings.vectors.set(id, [...v]);
			embeddings.clusters = next.clusters.map((c) => [...c.members]);
		},
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
			embedder: fakeEmbedder,
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
		// The observation ref is BATCH-TAGGED (obs:<tag>:p1) so a re-run of
		// the same batch dedupes while a re-opened message's update lands as
		// a new event (vision-extraction-coverage.md).
		const events = ledgers.readEvents();
		const record = chatStore.getChat(chatId)!;
		const expectedTag = batchTag(coverageSlots(record.messages as UIMessage[]));
		assert.deepEqual(
			events.map((e) => [e.kind, e.ref, e.nodeId]),
			[
				["miss", "probe-1", existingId],
				["correct", "check-1", null],
				["observation", `obs:${expectedTag}:p1`, existingId],
			],
		);
		assert.equal(events[0]!.nodeId, existingId, "probe attributed via the verdict's mapping");
		assert.equal(events[2]!.note, "solid", "the understanding note joins the ledger");

		// COVERAGE checkpointed per message (not a whole-chat checkpoint):
		// one entry per transcript message, fingerprinted content each —
		// the same turns are never extracted twice.
		const covered = ledgers.readCoverage();
		assert.equal(covered.length, record.messages.length);
		assert.ok(covered.every((c) => c.chatId === chatId && c.fp.length === 64 && c.tokens > 0));
		assert.equal(ledgers.readCheckpoints().length, 0, "the chat path writes coverage, not the legacy checkpoint");
		assert.equal(
			coverageOf(record.messages as UIMessage[], covered, chatId).uncoveredCount,
			0,
			"every message is now covered",
		);
	});

	it("checkpoints nothing when a stage fails", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
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
			embedder: fakeEmbedder,
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
			embedder: fakeEmbedder,
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

	it("labels the post-batch embedding tail as its own phase — not 'merging' (2026-09-19 accuracy fix)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// Gate the embedder so we can observe the registry WHILE the tail
		// runs — mergeFindings has already returned, every batch is merged.
		let releaseEmbed!: () => void;
		const embedGate = new Promise<void>((resolve) => {
			releaseEmbed = resolve;
		});
		let observed: string | undefined;
		const gatedEmbedder = async (store: GraphStore) => {
			await embedGate;
			observed = extractionStatuses().find((r) => r.chatId === chatId)?.phase;
			await fakeEmbedder(store);
		};
		const verdict: AuditResult = { propositions: FINDINGS.propositions, edges: [], attribution: { quiz: {} }, dropped: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: gatedEmbedder,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		const run = pipeline.runExtraction(chatId);
		// Wait for the tail: the phase must flip to "embedding" while the
		// embedder hangs — the incident this fixes is minutes of "merging"
		// AFTER the last merge, so the flip itself is the assertion.
		const t0 = Date.now();
		while (extractionStatuses().find((r) => r.chatId === chatId)?.phase !== "embedding") {
			if (Date.now() - t0 > 2000) {
				releaseEmbed();
				await run;
				assert.fail("the tail never flipped to embedding (stuck at 'merging'?)");
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		releaseEmbed();
		await run;
		assert.equal(observed, "embedding", "still embedding through the tail, never back to 'merging'");
		assert.equal(extractionStatuses().length, 0, "clears when done");
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
			embedder: fakeEmbedder,
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
		// the scripted engine's model, provider-qualified (model slots wave)
		assert.equal(run.stages.extractor.model, "faux:faux-1");
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
			embedder: fakeEmbedder,
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
			embedder: fakeEmbedder,
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

	it("registers runs on the process-wide registry (route-instance safety): a second pipeline instance sees the same single-flight state", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// Gated extractor: the first call hangs until released, so the run
		// stays registered while we observe it.
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
			embedder: fakeEmbedder,
			extractor: gatedExtractor,
			auditor: silentModel(),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		// A SECOND instance over DIFFERENT ledgers — the observer a separate
		// route entry's module instance is in dev (the turn-liveness lesson:
		// module instances split; globalThis does not).
		const observer = createExtractionPipeline({
			chatStore,
			graphStore: memoryLedgers(),
			embedder: fakeEmbedder,
			extractor: silentModel(),
			auditor: silentModel(),
			labeler: submitModel("submit_labels", { labels: [] }),
		});

		const first = pipeline.runExtraction(chatId);
		// The synchronous prefix (setPhase at batch start) registers BEFORE
		// the first await — the run is visible the moment it starts.
		assert.ok(
			extractionStatuses().some((run) => run.chatId === chatId && run.phase === "extracting"),
			"the run is registered at start",
		);
		const g = globalThis as { __lhExtractionRuns?: { running: Map<string, unknown> } };
		assert.ok(g.__lhExtractionRuns?.running.has(chatId), "the registry lives on globalThis — no module-instance split can hide runs");
		assert.deepEqual(await observer.runExtraction(chatId), { nodes: 0, edges: 0, events: 0 }, "single-flight spans pipeline instances");

		release();
		await assert.rejects(first, /the extractor never submitted findings/);
		assert.ok(!extractionStatuses().some((run) => run.chatId === chatId), "the registry entry clears when the run ends (however it ends)");
		assert.ok(!g.__lhExtractionRuns?.running.has(chatId), "nothing leaks into the global registry");
	});

	it("throws for unknown chats", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
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

/** Test seam for the embedder: fakes the post-merge embedding batch —
 *  one identical unit vector per node → semanticClusters merges them all
 *  into ONE topic — then persists the partition like the real embedder. */
const fakeEmbedder = async (store: GraphStore) => {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const n of store.readNodes()) {
		if (seen.has(n.id)) continue;
		seen.add(n.id);
		ids.push(n.id);
	}
	const vectors = Object.fromEntries(ids.map((id) => [id, [1, 0, 0]]));
	store.writeEmbeddings({
		model: "test/embedder",
		dim: 3,
		vectors,
		clusters: semanticClusters(vectors),
		updatedAt: "2026-09-13T00:00:00.000Z",
	});
};

describe("cluster naming (the post-extraction garnish)", () => {
	it("names a new community after a notes merge — one record, claimed on the next refresh", async () => {
		const ledgers = memoryLedgers();
		const namerCalls: number[] = [];
		const labeler = submitModel("submit_labels", { labels: [{ key: "c0", label: "Vim modal grammar" }] }, () => namerCalls.push(1));
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
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
		// Money channel (2026-09 cost metrics): the naming call billed —
		// ONE run record with the faux model, deterministic > 0 usage, and
		// the refresh stats. The second refresh named nothing (no model
		// call — early return), so no second record.
		const namingRuns = ledgers.readNamingRuns();
		assert.equal(namingRuns.length, 1, "one naming run billed");
		assert.equal(namingRuns[0]!.model, labeler.model.id);
		assert.ok(namingRuns[0]!.steps.length >= 1, "at least one billed step");
		assert.ok((namingRuns[0]!.steps[0]!.inputTokens ?? 0) > 0, "usage estimated > 0");
		assert.equal(namingRuns[0]!.stats.appended, 1);
		assert.equal(namingRuns[0]!.stats.named, 1);
		assert.ok(namingRuns[0]!.durationMs >= 0);
	});

	it("naming failure never fails the run", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
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
			embedder: fakeEmbedder,
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
				embedder: fakeEmbedder,
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
			embedder: fakeEmbedder,
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

// ── the chunked pipeline (extraction coverage — vision-extraction-coverage.md) ──

/** Pull the pipeline's prompt view out of a model call: the pipeline sends
 *  `Transcript:\n\n<view>` as the user turn, so the LAST user message's
 *  text IS what the extractor saw. */
function capturedView(context: unknown): string {
	const messages = (context as { messages?: { role: string; content: string }[] }).messages ?? [];
	const last = [...messages].reverse().find((m) => m.role === "user");
	return typeof last?.content === "string" ? last.content : "";
}

/** An extractor step that submits FINDINGS, optionally capturing its view. */
function findingsStep(capture?: (view: string) => void): FauxResponseStep {
	return (context) => {
		capture?.(capturedView(context));
		return fauxAssistantMessage(
			[fauxToolCall("submit_findings", FINDINGS as unknown as Record<string, unknown>, { id: "findings-call" })],
			{ stopReason: "toolUse" },
		);
	};
}

/** An auditor step that passes p1 through (no linkTo — a fresh node), drops p2. */
function passThroughAuditStep(): FauxResponseStep {
	return () =>
		fauxAssistantMessage(
			[
				fauxToolCall(
					"submit_review",
					{
						propositions: [{ ...FINDINGS.propositions[0]! }],
						edges: [],
						attribution: { quiz: {} },
						dropped: [{ ref: "p2", reason: "evidence not found" }],
					} as unknown as Record<string, unknown>,
					{ id: "review-call" },
				),
			],
			{ stopReason: "toolUse" },
		);
}

/** A session with UNCOVERED-multiple-batch mass: five long distinct messages
 *  (~1200 tok each — 3600+1200 > EXTRACTION.chunkTokens 4096 → batches of
 *  [m1,m2,m3] and [m4,m5]). */
function chunkyChat() {
	const chat = chatStore.createChat("Chunky coverage fixture");
	createdChats.push(chat.id);
	// ~1230 tok per message (chars/4): three fill the 4096 budget, the
	// fourth would overflow — deterministic batches [m1,m2,m3] + [m4,m5].
	chatStore.saveMessages(
		chat.id,
		[1, 2, 3, 4, 5].map((n) => user(`u${n}`, `topic ${n}: ${"detail ".repeat(700)}${n}`)),
	);
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

describe("the chunked pipeline (extraction coverage)", () => {
	it("extracts uncovered messages in token-budgeted batches, checkpoints coverage per batch, and no-ops once covered", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const views: string[] = [];

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
			extractor: fauxEngine([findingsStep((v) => views.push(v)), findingsStep((v) => views.push(v))]),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		const stats = await pipeline.runExtraction(chatId);

		// Two batches: the first held messages 1-3, the second 4-5 — a
		// message is never split, batches are consecutive oldest-first.
		assert.equal(views.length, 2, "one extractor call per batch");
		assert.ok(views[0]!.includes("LEARNER [u1]") && views[0]!.includes("LEARNER [u3]"));
		assert.ok(!views[0]!.includes("LEARNER [u4]"), "the batch stops at the token budget");
		assert.ok(views[1]!.includes("LEARNER [u4]") && views[1]!.includes("LEARNER [u5]"));
		assert.ok(!views[1]!.includes("LEARNER [u3]"));

		// p1 was a fresh node in batch 1; batch 2's p1 mapped to the same
		// node (chat-scoped mapping) — but its understanding note is a NEW
		// batch-tagged observation.
		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 2 });

		// Per-batch coverage: every message checkpointed, nothing legacy.
		const coverage = ledgers.readCoverage();
		assert.equal(coverage.length, record.messages.length);
		assert.equal(ledgers.readCheckpoints().length, 0);
		assert.equal(coverageOf(record.messages as UIMessage[], coverage, chatId).uncoveredCount, 0);

		// A second run is a NO-OP: nothing uncovered → no model calls, no
		// new usage entry (no money spent on covered ground).
		const before = views.length;
		const again = await pipeline.runExtraction(chatId);
		assert.deepEqual(again, { nodes: 0, edges: 0, events: 0 });
		assert.equal(views.length, before);
		assert.equal(chatStore.getChat(chatId)!.extractions?.length, 1, "the no-op run persists no usage");
	});

	it("aborting after a merged batch keeps it covered; the re-run extracts only the remainder", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const views: string[] = [];

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
			// Batch 1 submits and merges; batch 2's extractor call HANGS
			// until the abort fires — the dock's abort button, mid-run.
			extractor: fauxEngine([
				findingsStep((v) => views.push(v)),
				(_context, options) =>
					new Promise((resolve) => {
						const sig = options?.signal;
						if (sig?.aborted) {
							resolve(fauxAssistantMessage("late"));
							return;
						}
						sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
					}),
			]),
			auditor: fauxEngine([passThroughAuditStep()]),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		const runPromise = pipeline.runExtraction(chatId);
		// The abort must land while batch 2's extractor hangs. The faux
		// stream only resolves on abort, so wait for the batch-1 merge to
		// show in coverage, then abort.
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (ledgers.readCoverage().length > 0) {
					clearInterval(check);
					resolve();
				}
			}, 5);
		});
		assert.equal(abortExtraction(chatId), true);
		const stats = await runPromise;

		// Batch 1's emissions are kept and its messages stay covered.
		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 1 });
		assert.equal(ledgers.readCoverage().length, 3, "batch 1 checkpointed its three messages");
		const cov = coverageOf(record.messages as UIMessage[], ledgers.readCoverage(), chatId);
		assert.equal(cov.uncoveredCount, 2, "the in-flight batch's messages stay uncovered");

		// The re-run — the manual extract button — picks up ONLY the
		// remainder: one batch, messages 4-5 alone in the prompt.
		const reRunViews: string[] = [];
		const finisher = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		await finisher.runExtraction(chatId);
		assert.equal(reRunViews.length, 1);
		assert.ok(reRunViews[0]!.includes("LEARNER [u4]") && reRunViews[0]!.includes("LEARNER [u5]"));
		assert.ok(!reRunViews[0]!.includes("LEARNER [u1]"), "the covered remainder never re-enters the prompt");
		assert.equal(ledgers.readCoverage().length, 5, "the re-run closed the gap");
	});

	it("a re-opened message re-extracts alone; a data-part attach never re-opens it", async () => {
		// A small session: one batch covers everything, so re-openings are
		// the ONLY thing later runs can see.
		const chat = chatStore.createChat("Re-open fixture");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [user("s1", "short topic one"), user("s2", "short topic two")]);
		const chatId = chat.id;
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
			extractor: fauxEngine([findingsStep()]),
			auditor: fauxEngine([passThroughAuditStep()]),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		await pipeline.runExtraction(chatId);
		const messages = () => chatStore.getChat(chatId)!.messages as UIMessage[];
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0);

		// Data parts are invisible to the extraction view — plan-block
		// attach does NOT re-open a covered message.
		const withDataPart = messages().map((m) =>
			m.id === "u2"
				? { ...m, parts: [...m.parts, { type: "data-plan-blocks", planBlocks: [] } as unknown as UIMessage["parts"][number]] }
				: m,
		);
		chatStore.saveMessages(chatId, withDataPart);
		const afterAttach = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterAttach.uncoveredCount, 0, "data parts don't change the fingerprint");

		// A quiz answer merging into an ASKING message changes its view →
		// exactly that message re-opens, and the next run extracts it alone.
		const mutated = messages().map((m) =>
			m.id === "s1" ? { ...m, parts: [...m.parts, { type: "text", text: "the answer merged in late" }] } : m,
		) as unknown as UIMessage[];
		chatStore.saveMessages(chatId, mutated);
		const afterMerge = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterMerge.uncoveredCount, 1, "only the mutated message re-opens");

		const reRunViews: string[] = [];
		const reOpener = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			embedder: fakeEmbedder,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
			labeler: submitModel("submit_labels", { labels: [] }),
		});
		await reOpener.runExtraction(chatId);
		assert.equal(reRunViews.length, 1, "one batch: the single re-opened message");
		assert.ok(reRunViews[0]!.includes("LEARNER [s1]") && !reRunViews[0]!.includes("LEARNER [s2]"));
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0, "re-covered");
	});
});
