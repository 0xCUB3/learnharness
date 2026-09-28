/**
 * The extraction pipeline tests (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27): extractor → auditor → merger, the sole graph writer —
 * the extractor alone sees the source (whole-session markdown), the auditor
 * never does (identity linking through graph tools), the merger is
 * deterministic.
 *
 *   transcriptView  — the markdown rendering the extractor sees (pure):
 *                     id-anchored Teacher/Learner blocks + check blocks
 *   pipeline        — scripted faux engines drive both agents: findings out,
 *                     audit verdict (with linkTo identity) in, deterministic
 *                     merge applied; failure paths checkpoint nothing;
 *                     single-flight per chat
 *
 * The merger itself (identity verdicts, idempotency) is tested in
 * tests/graph.test.ts directly against mergeFindings — here it is the
 * integration: what one full pipeline run does to the ledgers.
 *
 * Ledger: in-memory (the GraphStore port) — this suite never touches
 * data/graph. Chats: real ChatRecords in the real chat store (created and
 * deleted by this suite).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newPlanBlockMessage } from "../src/core/native-messages.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type {
	AuditVerdicts,
	CoverageEntry,
	ExtractionRunUsage,
	GraphEdge,
	GraphNode,
	NodeMapping,
	NotesSource,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { abortExtraction, createExtractionPipeline, extractionStatuses, transcriptView } from "../src/agent/subagents/extraction.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, providerKeyMissing, type ModelSlotName } from "../src/core/settings.ts";
import { coverageOf, messageViewLines } from "../src/core/coverage.ts";
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
 *  free-form, with chat-level provenance. */
const FINDINGS: SessionFindings = {
	propositions: [
		{
			id: "p1",
			name: "Derivative",
			statement: "The derivative measures how fast a function changes",
			aliases: [],
		},
		{
			id: "p2",
			name: "Chain rule",
			statement: "The chain rule differentiates composed functions by multiplying local rates.",
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
				[fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

/** A submit model whose single response WAITS on a gate before answering —
 *  the timing control for the serialized-audit tests (owner 2026-09-28):
 *  the model call has STARTED (onCall fired, the run holds the audit
 *  gate) but will not resolve until the test opens the gate. */
function gatedSubmitModel(name: string, input: unknown, gate: Promise<void>, onCall?: () => void): PiEngine {
	return fauxEngine([
		async () => {
			onCall?.();
			await gate;
			return fauxAssistantMessage(
				[fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

/** Poll until true — the queued-phase observations need real ticks. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
	for (const t0 = Date.now(); !cond(); ) {
		if (Date.now() - t0 > ms) throw new Error("condition never became true in time");
		await new Promise((r) => setTimeout(r, 2));
	}
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

describe("transcriptView (pure — the shared markdown engine, owner 2026-09-27)", () => {
	it("renders anchorless speaker blocks + check blocks — tree-blind, plan ops folded", () => {
		const { record } = fixtureChat();
		const view = transcriptView(record);

		// The document header is the session title.
		assert.match(view, /^# Extraction fixture$/m);

		// Conversation verbatim, each block headed by its speaker only —
		// the [id] anchors are GONE (submit-schema slim, 2026-09-28:
		// propositions no longer report message ids).
		assert.match(view, /### Learner\n\nteach me the chain rule/);
		assert.match(view, /### Teacher\n\nThe derivative measures how fast a function changes\./);

		// Checks render as readable blocks (question + outcome).
		assert.match(view, /### Quiz\n/);
		assert.match(view, /\*\*Q:\*\* What is a derivative, roughly\?/);
		assert.match(view, /The learner answered incorrectly\./);
		assert.match(view, /The learner answered correctly\./);

		// TREE-BLIND: no plan tree, no tree edges, no mark_done lines — plan
		// ops fold to the generic one-liner like every other non-quiz tool.
		assert.doesNotMatch(view, /FINAL PLAN TREE/);
		assert.doesNotMatch(view, /TREE EDGES/);
		assert.match(view, /\*plan_init result delivered\*/);
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
		assert.match(view, /\*research result delivered\*/);
		assert.doesNotMatch(view, /long brief/);
		assert.doesNotMatch(view, /### Teacher/);
	});
});

// ─── the pipeline ───────────────────────────────────────────────────────────

describe("the extraction pipeline (extractor → auditor → merger)", () => {
	it("stringified-payload heal (owner, 2026-09-28): propositions arriving as ONE JSON string still validate and merge", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [], edges: [] };

		// The weak-model failure from the OpenRouter log: the whole array
		// emitted as a JSON-STRING ("propositions.0: must be object").
		// pi-agent-core's prepareArguments shim runs BEFORE TypeBox — the
		// heal parses it, validation passes, no retry burned.
		const extractor = submitModel("submit_findings", {
			propositions: JSON.stringify(FINDINGS.propositions),
			edges: FINDINGS.edges,
		});

		const pipeline = createExtractionPipeline({ chatStore, graphStore: ledgers, extractor, auditor: submitModel("submit_review", verdict) });
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 2, edges: 1 });
	});

	it("runs end to end: findings → audit verdict (identity) → deterministic merge + checkpoint", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		// The auditor passes p1 through and LINKS it to a pre-existing node
		// (identity verdict); p2 stays a verdict-free create.
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
			edges: [],
		};

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);

		// VERDICTS-ONLY (2026-09-28): findings merge in FULL — the linked
		// p1 creates no node, p2 creates one, and the extractor's edge
		// resolves through them. (The old echo form could silently drop
		// content by omitting it; that accidental drop channel is gone.)
		assert.deepEqual(stats, { nodes: 1, edges: 1 });

		// Link-append: the phrasing joined the existing node's aliases and
		// the provenance unioned; p2's create line is its own node.
		assert.equal(ledgers.readNodes().length, 3); // pre-seeded + link line + p2's create
		const mappings = ledgers.readMappings();
		assert.equal(mappings.length, 2);
		assert.deepEqual(mappings[0], { chatId, sourceId: "p1", graphNodeId: existingId });
		assert.equal(mappings[1]!.sourceId, "p2");
		assert.match(mappings[1]!.graphNodeId, /^n_/);

		// COVERAGE checkpointed per message (not a whole-chat checkpoint):
		// one entry per transcript message, fingerprinted content each —
		// the same turns are never extracted twice.
		const record = chatStore.getChat(chatId)!;
		const covered = ledgers.readCoverage();
		// Wave D: the coverage unit is the VISIBLE native message — bonded
		// riders with no view lines (a textless call message) are context,
		// never checkpointed.
		const visible = record.messages.filter(
			(m) => messageViewLines(m, m.id).length > 0,
		).length;
		assert.equal(covered.length, visible);
		assert.ok(covered.every((c) => c.chatId === chatId && c.fp.length === 64 && c.tokens > 0));
		assert.equal(ledgers.readCheckpoints().length, 0, "the chat path writes coverage, not the legacy checkpoint");

		assert.equal(
			coverageOf(record.messages, covered, chatId).uncoveredCount,
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
		// Empty verdicts: everything creates (verdicts-only, 2026-09-28).
		const verdict: AuditVerdicts = { links: [], edges: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 2, edges: 1 }); // full findings merge (verdicts-only)
		// Wave 7 (950ddfd): birth-session clusters carry session-name labels,
		// so the post-merge naming garnish is gone — no model spend, no
		// naming-run records, no label writes.
	});



	it("engineFor fills the stages (model slots wave): the chain replaces config pins", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [], edges: [] };
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
		const verdict: AuditVerdicts = { links: [], edges: [] };
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
			auditor: submitModel("submit_review", FINDINGS),
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
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
			edges: [],
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

	it("serialized audit (owner 2026-09-28): a second run QUEUES at the gate; its auditor explores the graph only AFTER the first run's merge", async () => {
		const a = fixtureChat();
		const b = fixtureChat();
		const ledgers = memoryLedgers();

		const single = (id: string, name: string, statement: string): SessionFindings => ({
			propositions: [{ id, name, statement, aliases: [], }],
			edges: [],
		});
		const findingsA = single("pa", "Alpha claim", "Alpha statement, full precision");
		const findingsB = single("pb", "Beta claim", "Beta statement, full precision");

		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		let aAuditing = false;
		const pipelineA = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", findingsA),
			auditor: gatedSubmitModel("submit_review", findingsA, gate, () => {
				aAuditing = true;
			}),
		});
		const runA = pipelineA.runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));
		assert.ok(aAuditing, "run A holds the gate — its audit model call is in flight");

		let bAuditorCalled = false;
		let bSawAlphasMerge = false;
		const pipelineB = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", findingsB),
			// THE pin: when B's auditor is finally invoked, A's merge must
			// already be in the ledgers — B explores the post-merge graph,
			// which is the entire point of the gate.
			auditor: submitModel("submit_review", findingsB, () => {
				bAuditorCalled = true;
				bSawAlphasMerge = ledgers.readNodes().some((n) => n.name === "Alpha claim");
			}),
		});
		const runB = pipelineB.runExtraction(b.chatId);

		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));
		assert.ok(!bAuditorCalled, "B's auditor has not been invoked — it queues behind A");
		assert.equal(ledgers.readNodes().filter((n) => n.name === "Beta claim").length, 0, "nothing of B merged yet");
		assert.equal(extractionStatuses().find((r) => r.chatId === a.chatId)?.phase, "auditing", "A still audits while B waits");

		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, edges: 0 });
		assert.deepEqual(await runB, { nodes: 1, edges: 0 });
		assert.ok(bAuditorCalled);
		assert.ok(bSawAlphasMerge, "B's auditor saw A's merged node — audit serialized after merge");
		assert.equal(extractionStatuses().length, 0, "both runs left the registry");
	});

	it("serialized audit: a run ABORTED while waiting never audits — and the queue chain stays healthy for successors", async () => {
		const a = fixtureChat();
		const b = fixtureChat();
		const c = fixtureChat();
		const ledgers = memoryLedgers();

		const single = (id: string, name: string, statement: string): SessionFindings => ({
			propositions: [{ id, name, statement, aliases: [], }],
			edges: [],
		});

		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		const pipelineA = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pa", "Alpha claim", "Alpha statement")),
			auditor: gatedSubmitModel("submit_review", single("pa", "Alpha claim", "Alpha statement"), gate),
		});
		const runA = pipelineA.runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));

		let bAuditorCalled = false;
		const pipelineB = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pb", "Beta claim", "Beta statement")),
			auditor: submitModel("submit_review", single("pb", "Beta claim", "Beta statement"), () => {
				bAuditorCalled = true;
			}),
		});
		const runB = pipelineB.runExtraction(b.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));

		// The dock's abort button, pressed while B queues.
		assert.equal(abortExtraction(b.chatId), true);
		assert.deepEqual(await runB, { nodes: 0, edges: 0 }, "aborted before auditing — zero emissions");
		assert.ok(!bAuditorCalled, "B's auditor was never invoked");
		assert.ok(!extractionStatuses().some((r) => r.chatId === b.chatId), "B left the registry");
		assert.equal(ledgers.readCoverage().some((row) => row.chatId === b.chatId), false, "B checkpointed nothing");

		// The chain link B abandoned still resolved: A finishes, and a
		// THIRD run audits normally — no deadlock residue.
		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, edges: 0 });
		const pipelineC = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pc", "Gamma claim", "Gamma statement")),
			auditor: submitModel("submit_review", single("pc", "Gamma claim", "Gamma statement")),
		});
		assert.deepEqual(await pipelineC.runExtraction(c.chatId), { nodes: 1, edges: 0 });
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
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
			edges: [],
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
		assert.equal(run.stats?.nodes, 1); // p2 created; p1 linked, not created
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
			auditor: submitModel("submit_review", { propositions: [], edges: [] }),
		});
		const runPromise = pipeline.runExtraction(chatId);

		// The registry entry exists synchronously after the call (setPhase
		// runs before the first await); abort is TRUE cancellation.
		assert.equal(abortExtraction(chatId), true);
		const stats = await runPromise;

		// A deliberate stop, not a failure: zero emissions, no throw.
		assert.deepEqual(stats, { nodes: 0, edges: 0 });
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
		assert.deepEqual(second, { nodes: 0, edges: 0 });

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
		assert.deepEqual(await observer.runExtraction(chatId), { nodes: 0, edges: 0 }, "single-flight spans pipeline instances");

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

/** What the notes-mode extractor submits: same shapes as session findings,
 *  messages always empty (the file is the provenance). */
const NOTES_FINDINGS = {
	propositions: [
		{
			id: "p1",
			name: "Vim normal mode",
			statement: "Vim starts in Normal mode, where keys are commands.",
			aliases: [],
		},
	],
	edges: [],
} as const;

const NOTES_VERDICT = {
	propositions: [NOTES_FINDINGS.propositions[0]],
	edges: [],
} as const;

describe("the notes front door (importNotes — format-agnostic)", () => {
	it("imports raw notes end to end: source record, file-scoped provenance", async () => {
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

		assert.deepEqual(stats, { nodes: 1, edges: 0 });
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

		// File-scoped provenance (submit-schema slim, 2026-09-28): the
		// node carries ONE chat-level point — the source key itself, no
		// message anchors.
		const node = ledgers.readNodes()[0]!;
		assert.equal(node.statement, "Vim starts in Normal mode, where keys are commands.");
		assert.deepEqual(node.provenance, [{ chatId: source.id, messageId: "" }]);
		assert.deepEqual(ledgers.readMappings(), [{ chatId: source.id, sourceId: "p1", graphNodeId: node.id }]);
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
		assert.deepEqual(first, { nodes: 1, edges: 0 });

		const second = await mk().importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(second, { nodes: 0, edges: 0 }, "the same source id dedupes everything");

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
		assert.deepEqual(await runPromise, { nodes: 0, edges: 0 });
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCheckpoints().length, 0, "nothing checkpointed");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1, "partial usage still persisted");
		assert.equal(ledgers.readSources()[0]!.extractions![0]!.stats, undefined, "never merged → no stats");
	});
});

// ── the chunked pipeline (extraction coverage — vision-extraction-coverage.md) ──

/** Pull the pipeline's prompt view out of a model call: the pipeline sends
 *  the session's markdown document itself as the user turn, so the LAST
 *  user message's text IS what the extractor saw. */
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
			[fauxToolCall("submit_findings", FINDINGS as unknown as ToolCall["arguments"], { id: "findings-call" })],
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
						links: [],
						edges: [],
					} as unknown as ToolCall["arguments"],
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
		assert.ok(views[0]!.includes("### Learner") && views[0]!.includes("topic 1:"));
		assert.ok(!views[0]!.includes("topic 4:"), "the batch stops at the token budget");
		assert.ok(views[1]!.includes("### Learner") && views[1]!.includes("topic 4:"));
		assert.ok(!views[1]!.includes("topic 3:"));
		// The document header is the session title.
		assert.ok(views[0]!.startsWith("# Chunky coverage fixture"));

		// Batch 1 merged the full findings (verdicts-only: the extractor's
		// output always fully merges); batch 2's identical ids mapped to
		// the same nodes (chat-scoped mapping) — nothing new.
		assert.deepEqual(stats, { nodes: 2, edges: 1 });

		// Per-batch coverage: every message checkpointed, nothing legacy.
		const coverage = ledgers.readCoverage();
		assert.equal(coverage.length, record.messages.length);
		assert.equal(ledgers.readCheckpoints().length, 0);
		assert.equal(coverageOf(record.messages, coverage, chatId).uncoveredCount, 0);

		// A second run is a NO-OP: nothing uncovered → no model calls, no
		// new usage entry (no money spent on covered ground).
		const before = views.length;
		const again = await pipeline.runExtraction(chatId);
		assert.deepEqual(again, { nodes: 0, edges: 0 });
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
		assert.deepEqual(stats, { nodes: 2, edges: 1 });
		assert.equal(ledgers.readCoverage().length, 3, "batch 1 checkpointed its three messages");
		const cov = coverageOf(record.messages, ledgers.readCoverage(), chatId);
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
		assert.ok(reRunViews[0]!.includes("### Learner") && reRunViews[0]!.includes("topic 4:"));
		assert.ok(!reRunViews[0]!.includes("### Learner · u1"), "the covered remainder never re-enters the prompt");
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
		// Wave D: the record IS native history — coverage reads it directly.
		const record = () => chatStore.getChat(chatId)!.messages;
		const messages = () => record();
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
		assert.ok(reRunViews[0]!.includes("the answer merged in late") && !reRunViews[0]!.includes("### Learner · s2"));
		assert.ok(reRunViews[0]!.includes("### Learner"), "the re-opened message renders");
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
			auditor: submitModel("submit_review", { propositions: FINDINGS.propositions, edges: [] }, () => chatStore.deleteChat(chatId)),
		});
		const stats = await pipeline.runExtraction(chatId);

		// The abort rides the existing abort path: info, not error; zero
		// emissions (stats present but empty — nothing merged).
		assert.ok(stats);
		assert.equal(stats.nodes, 0);
		assert.equal(stats.edges, 0);

		// Nothing merged, nothing checkpointed — the deleted chat leaves no
		// trace for a later snapshot to resurrect.
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readEdges().length, 0);
		assert.equal(ledgers.readMappings().length, 0);
		assert.equal(ledgers.readCoverage().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0);

		// The run is off the registry (the finally always cleans up).
		assert.equal(extractionStatuses().some((run) => run.chatId === chatId), false);
		// And its partial spend died with the chat — no usage row on a ghost.
		assert.equal(chatStore.getChat(chatId), null);
	});
});
