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
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newPlanBlockMessage } from "../src/core/native-messages.ts";
import { projectNative } from "../src/core/projection.ts";
import type {
	AuditResult,
	CoverageEntry,
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
import { ModelsNotConfiguredError, ProviderKeyMissingError, providerKeyMissing, type ModelSlotName } from "../src/core/settings.ts";
import { batchTag, coverageOf, coverageSlots } from "../src/core/coverage.ts";
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
	const positions = new Map<string, { x: number; y: number }>();
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
		// The layout ledger — settleGraphLayout writes it after each merge.
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		// The destructive seam (wave 6 session deletion) — mirrors the real
		// store: replace the provided ledgers' full contents.
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })));
			if (next.edges) edges.splice(0, edges.length, ...next.edges.map((e) => ({ ...e, provenance: [...e.provenance] })));
			if (next.events) events.splice(0, events.length, ...next.events.map((e) => ({ ...e })));
			if (next.mappings) mappings.splice(0, mappings.length, ...next.mappings.map((m) => ({ ...m })));
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage.map((c) => ({ ...c })));
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints.map((c) => ({ ...c })));
		},
	} satisfies GraphStore;
}

// Native fixture builders (Wave B): the record holds pi-native history —
// an assistant message with its tool calls + one result message per call;
// the projection reproduces the part shapes these view tests pin.
interface NativeCallDesc {
	name: string;
	toolCallId: string;
	input: Record<string, unknown>;
	output: unknown;
}

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

function assistant(id: string, items: unknown[]): LhMessage[] {
	const content: unknown[] = [];
	const calls: NativeCallDesc[] = [];
	for (const item of items) {
		const it = item as { type?: string; text?: string };
		if (it && it.type === "text") {
			content.push({ type: "text", text: it.text });
		} else {
			const call = item as NativeCallDesc;
			calls.push(call);
			content.push({ type: "toolCall", id: call.toolCallId, name: call.name, arguments: call.input as never });
		}
	}
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
	for (const call of calls) {
		out.push({
			id: `r_${call.toolCallId}`,
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.name,
			content: [{ type: "text", text: "ok" }],
			details: call.output,
			isError: false,
			timestamp: Date.now(),
		} as never);
	}
	return out;
}

function quizPart(toolCallId: string, input: Record<string, unknown>, output: Record<string, unknown>): NativeCallDesc {
	return { name: "quiz", toolCallId, input, output };
}

function planPart(toolCallId: string, name: string, input: Record<string, unknown>, tree: unknown): NativeCallDesc {
	return { name, toolCallId, input, output: { ok: true, tree } };
}

/** A session-shaped fixture chat: probe → teaching text → check. Tree-blind
 *  world: the plan tree is NOT part of extraction — it is noise. */
function fixtureChat() {
	const chat = chatStore.createChat("Extraction fixture");
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [
		user("u1", "teach me the chain rule"),
		...assistant("a1", [
			quizPart("probe-1", { question: "What is a derivative, roughly?" }, {
				questionId: "probe-1", kind: "quiz", questionText: "What is a derivative, roughly?",
				correct: false, dontKnow: false, answeredAt: "2026-08-22T01:00:00.000Z",
			}),
		]),
		// Distinct TURNS: the native grouping canon merges consecutive
		// assistant messages into one view group, so the fixture separates
		// its turns with learner messages (the real record's shape).
		user("u2", "go on"),
		...assistant("a2", [
			{ type: "text", text: "The derivative measures how fast a function changes." },
			planPart("p1", "plan_init", { nodes: [], edges: [] }, { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 1 }),
		]),
		user("u3", "check me"),
		...assistant("a3", [
			quizPart("check-1", { question: "Check" }, {
				questionId: "check-1", kind: "quiz", questionText: "Check", correct: true, dontKnow: false,
				answeredAt: "2026-08-22T02:00:00.000Z",
			}),
		]),
	].flat());
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
			...assistant("a1", [
				{
					name: "research",
					toolCallId: "r1",
					input: { question: "q" },
					output: { brief: "long brief", sources: [] },
				},
				{ type: "text", text: "   " },
			]),
		].flat());
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
		// The observation ref is BATCH-TAGGED (obs:<tag>:p1) so a re-run of
		// the same batch dedupes while a re-opened message's update lands as
		// a new event (vision-extraction-coverage.md).
		const events = ledgers.readEvents();
		const record = chatStore.getChat(chatId)!;
		const expectedTag = batchTag(coverageSlots(projectNative(record.messages)));
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
		assert.equal(covered.length, projectNative(record.messages).length);
		assert.ok(covered.every((c) => c.chatId === chatId && c.fp.length === 64 && c.tokens > 0));
		assert.equal(ledgers.readCheckpoints().length, 0, "the chat path writes coverage, not the legacy checkpoint");

		assert.equal(
			coverageOf(projectNative(record.messages), covered, chatId).uncoveredCount,
			0,
			"every message is now covered",
		);
	});

	it("BYOK refusal: no stage engines anywhere → the run throws honestly before any stage (owner, 2026-09-22)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// No direct engines AND no engineFor — the chain came up empty.
		const pipeline = createExtractionPipeline({ chatStore, graphStore: ledgers });
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ModelsNotConfiguredError);
			assert.deepEqual(err.envelope.missing, ["cheap"]); // extractor + auditor are the cheap tier
			assert.equal(err.envelope.code, "models_not_configured");
			return true;
		});
		// nothing ran: no phase residue, no usage, no coverage writes
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("key-presence refusal: a stage engine whose provider key is gone throws before any batch (provider-key interlude, 2026-09-25)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = fauxEngine([]);
		const auditor = fauxEngine([]);
		const seen: Array<[string, ModelSlotName]> = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor,
			providerKeyMissing: (provider, tier) => {
				seen.push([provider, tier]);
				return providerKeyMissing(provider, [tier]);
			},
		});
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ProviderKeyMissingError);
			assert.equal(err.envelope.code, "provider_key_missing");
			assert.equal(err.envelope.provider, extractor.model.provider, "the provider of the keyless engine");
			assert.deepEqual(err.envelope.slots, ["cheap"], "extractor + auditor are the cheap tier");
			return true;
		});
		// FIRST offender surfaces (extractor before auditor) — and nothing
		// ran: the refusal lands before any batch, no coverage writes.
		assert.deepEqual(seen, [[extractor.model.provider, "cheap"]]);
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("key-presence pass-through: null from the check lets a stage through — the NEXT keyless stage surfaces (first-offender discipline)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([]),
			auditor: fauxEngine([]),
			providerKeyMissing: (provider, tier) => (calls++ === 0 ? null : providerKeyMissing(provider, [tier])),
		});
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ProviderKeyMissingError, "the auditor's refusal surfaces after the extractor passed");
			return true;
		});
		assert.equal(calls, 2, "both stages were checked, in order");
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("the LLM cluster-namer is DEAD (wave 7): a merge mints no naming runs — labels are session names now", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		// Identity-pass verdict: p1 becomes a new node, p2 dropped (no links).
		const verdict: AuditResult = {
			propositions: [{ ...FINDINGS.propositions[0]! }],
			edges: [],
			attribution: { quiz: { "probe-1": "p1" } },
			dropped: [{ ref: "p2", reason: "evidence not found" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 1, edges: 0, events: 3 });
		// Wave 7 (950ddfd): birth-session clusters carry session-name labels,
		// so the post-merge naming garnish is gone — no model spend, no
		// naming-run records, no label writes.
	});



	it("engineFor fills the stages (model slots wave): the chain replaces config pins", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditResult = {
			propositions: FINDINGS.propositions,
			edges: [], // the edge is dropped with it
			attribution: FINDINGS.attribution,
			dropped: [{ ref: "p1→p2", reason: "endpoint dropped" }],
		};
		const consulted: string[] = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			// NO direct values — the stages resolve ENTIRELY through engineFor
			// (the role override → slot → factory-pin chain, read fresh per
			// stage call in production; here, the scripted chain).
			engineFor: (role) => {
				consulted.push(role);
				if (role === "extractor") return submitModel("submit_findings", FINDINGS);
				if (role === "auditor") return submitModel("submit_review", verdict);
				return submitModel("submit_labels", { labels: [] });
			},
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.nodes, 2, "the chain-fed pipeline ran end to end — both propositions merged");
		// The stages were resolved through the chain, in pipeline order (the
		// labeler is fire-and-forget garnish — extractor + auditor are the
		// pinned order).
		assert.equal(consulted[0], "extractor");
		assert.equal(consulted[1], "auditor");
	});

	it("direct test values still WIN over engineFor (the priority pin)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditResult = {
			propositions: FINDINGS.propositions,
			edges: [],
			attribution: FINDINGS.attribution,
			dropped: [{ ref: "p1→p2", reason: "endpoint dropped" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
			// If the direct values did NOT win, this throw would surface.
			engineFor: (role) => {
				throw new Error(`engineFor should not be consulted for ${role} when a direct value is set`);
			},
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.nodes, 2, "the direct-value seams ran, untouched by engineFor");
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
			extractor: hangingModel(), // hangs until aborted — no step finishes
			auditor: submitModel("submit_review", { propositions: [], edges: [], attribution: { quiz: {} }, dropped: [] }),
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
			extractor: gatedExtractor,
			auditor: silentModel(),
		});
		// A SECOND instance over DIFFERENT ledgers — the observer a separate
		// route entry's module instance is in dev (the turn-liveness lesson:
		// module instances split; globalThis does not).
		const observer = createExtractionPipeline({
			chatStore,
			graphStore: memoryLedgers(),
			extractor: silentModel(),
			auditor: silentModel(),
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
			extractor: silentModel(),
			auditor: silentModel(),
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
 *  (~1200 tok each — 3600+1200 > the factory chunk budget 4096 → batches of
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
			extractor: fauxEngine([findingsStep((v) => views.push(v)), findingsStep((v) => views.push(v))]),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
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
		assert.equal(coverage.length, projectNative(record.messages).length);
		assert.equal(ledgers.readCheckpoints().length, 0);
		assert.equal(coverageOf(projectNative(record.messages), coverage, chatId).uncoveredCount, 0);

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
		const cov = coverageOf(projectNative(record.messages), ledgers.readCoverage(), chatId);
		assert.equal(cov.uncoveredCount, 2, "the in-flight batch's messages stay uncovered");

		// The re-run — the manual extract button — picks up ONLY the
		// remainder: one batch, messages 4-5 alone in the prompt.
		const reRunViews: string[] = [];
		const finisher = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
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
			extractor: fauxEngine([findingsStep()]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await pipeline.runExtraction(chatId);
		// Wave B: the record is native — coverage reads the projection.
		const record = () => chatStore.getChat(chatId)!.messages;
		const messages = () => projectNative(record());
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0);

		// Data parts are invisible to the extraction view — a plan-block
		// marker append (whose data part splices into the projected view)
		// does NOT re-open a covered message.
		chatStore.saveMessages(chatId, [
			...record(),
			newPlanBlockMessage("call_s2", { kind: "full", at: "2026-09-26T00:00:00.000Z", current: null, nodes: [], edges: [] }),
		]);
		const afterAttach = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterAttach.uncoveredCount, 0, "data parts don't change the fingerprint");

		// A quiz answer merging into an ASKING message changes its view →
		// exactly that message re-opens, and the next run extracts it alone.
		// (Native: the answer arrives as the call's tool result — the
		// projected group gains the answer line.)
		const mutated = record().map((m) =>
			(m as { id?: string }).id === "s1"
				? ({ ...m, content: [...(m as { content: unknown[] }).content, { type: "text", text: "the answer merged in late" }] } as never)
				: m,
		);
		chatStore.saveMessages(chatId, mutated);
		const afterMerge = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterMerge.uncoveredCount, 1, "only the mutated message re-opens");

		const reRunViews: string[] = [];
		const reOpener = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await reOpener.runExtraction(chatId);
		assert.equal(reRunViews.length, 1, "one batch: the single re-opened message");
		assert.ok(reRunViews[0]!.includes("LEARNER [s1]") && !reRunViews[0]!.includes("LEARNER [s2]"));
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0, "re-covered");
	});
});

// ─── session deletion mid-run (wave 6) ─────────────────────────────────────

describe("the session-deletion guard (chat deleted mid-run)", () => {
	it("a run whose chat dies mid-extraction aborts at the merge with nothing merged, checkpointed, or billed", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The chat record is deleted DURING the audit model call — the worst
		// window: findings already spent, the merge next.
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", { propositions: FINDINGS.propositions, edges: [], attribution: { quiz: {} }, dropped: [] }, () => chatStore.deleteChat(chatId)),
		});
		const stats = await pipeline.runExtraction(chatId);

		// The abort rides the existing abort path: info, not error; zero
		// emissions (stats present but empty — nothing merged).
		assert.ok(stats);
		assert.equal(stats.nodes, 0);
		assert.equal(stats.edges, 0);
		assert.equal(stats.events, 0);

		// Nothing merged, nothing checkpointed — the deleted chat leaves no
		// trace for a later snapshot to resurrect.
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readEdges().length, 0);
		assert.equal(ledgers.readEvents().length, 0);
		assert.equal(ledgers.readMappings().length, 0);
		assert.equal(ledgers.readCoverage().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0);

		// The run is off the registry (the finally always cleans up).
		assert.equal(extractionStatuses().some((run) => run.chatId === chatId), false);
		// And its partial spend died with the chat — no usage row on a ghost.
		assert.equal(chatStore.getChat(chatId), null);
	});
});
