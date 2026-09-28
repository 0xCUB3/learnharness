import * as crypto from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import {
	FACTORY_SETTINGS,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	ROLE_SLOT,
	type ModelSlotName,
	type ProviderKeyMissing,
} from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import type {
	AuditVerdicts,
	CallUsage,
	ChatRecord,
	ExtractionRunUsage,
	ExtractionStageUsage,
	SessionFindings,
} from "../../core/contracts.ts";
import { getGraph, mergeFindings, type EmissionStats, type GraphDeps } from "../../core/graph.ts";
import type { GraphStore } from "../../core/ports.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { batchRuns, coverageOf, messageViewLines } from "../../core/coverage.ts";
import { sessionMarkdown } from "../../core/session-markdown.ts";
import { auditorGraphTools } from "../tools/graph.ts";

/**
 * The extraction pipeline (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27) — the sole graph writer. Three stages, one
 * orchestrator:
 *
 *   extractor (LLM)  the ONE stage that sees the raw source (a session
 *                    rendered as markdown by the shared session-markdown
 *                    engine, or a notes file verbatim) → SessionFindings:
 *                    propositions + follows/supports edges, each with
 *                    TREE-BLIND, graph-blind, FULLY
 *                    TRUSTED — nothing downstream re-checks it.
 *   auditor (LLM)    never sees the source. Its job is IDENTITY: for each
 *                    proposition, linkTo an existing graph node or create —
 *                    decided by EXPLORING the graph through tools (find /
 *                    list_sessions / list_propositions), not by an injected
 *                    graph dump (context bloat, owner 2026-09-27). It may
 *                    also draw BRIDGING edges from existing graph nodes to
 *                    the batch's propositions.
 *   merger (core)    mergeFindings() → deterministic ledger appends
 *
 * The events ledger is GONE (2026-09-27): quiz outcomes and understanding
 * observations are no longer formalized in the graph — the graph is purely
 * extracted reasoning chains (nodes + edges). Understanding-level
 * assessment is practice-module territory.
 *
 * The extractor is a single-tool-call worker (one TypeBox-validated submit
 * call — a pi agent purely so the model can retry a schema-invalid call).
 * The auditor is a small AGENTIC loop: exploration tools plus one submit.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * (chat-handler) injects the storage ports + models; this module never
 * imports an adapter. runExtraction is single-flight per chat: a second
 * trigger while one run is in flight is a no-op (the next trigger picks up
 * whatever the in-flight run missed). On failure nothing is checkpointed —
 * the next trigger re-runs the whole thing.
 *
 * The FORMAT-AGNOSTIC FRONT DOOR (2026-09-13): importNotes() runs the SAME
 * three stages over raw personal notes (arbitrary format — no chat, no
 * session, no message ids). A notes-mode extractor prompt replaces the
 * session one; the auditor and merger are shared (identity + deterministic
 * appends don't care where text came from). Provenance is the file itself:
 * source ids ("src_" + path hash) play the chatId role in mappings and
 * checkpoints, and the source record (graphStore sources seam) carries
 * the file path + the run's usage.
 *
 * Observability (§5 baseline): every stage logs one line per step, its
 * start, and its duration; the pipeline logs a failure line before
 * rethrowing, so the server log reads start → stage timings → merged
 * stats (or failed) for every run.
 */

// ─── the source view (what the extractor sees) ──────────────────────────────

/**
 * A session rendered as readable markdown — the EXTRACTOR's view (owner
 * ruling 2026-09-27): the whole session goes in, formatted by the ONE
 * shared session-markdown engine (core/session-markdown.ts — the same
 * engine the user-facing session export will use), with the message-id
 * anchors preserved (the extractor reports them back per
 * proposition/edge — they become provenance). TREE-BLIND by design:
 * no plan tree, no mark_done.
 *
 * Presentation-only: coverage fingerprints hash core/coverage.ts's line
 * format, which is SEPARATE and unchanged — re-formatting the view never
 * re-opens covered history (the deliberate 2026-09-27 split).
 */
export function transcriptView(record: ChatRecord): string {
	// anchors OFF (submit-schema slim, 2026-09-28): propositions no longer
	// carry message ids, so the [id] anchors are noise for the extractor.
	return sessionMarkdown(record.messages, { title: record.title, anchors: false });
}

// ─── the extractor ──────────────────────────────────────────────────────────

const propositionProps = {
	id: Type.String({ description: 'Local id: "p1", "p2", … — referenced by edges.' }),
	name: Type.String({
		description:
			"A very short label for the proposition — a few words, a compact handle like a glossary headword " +
			"('Will to power', 'Divine command theory'). Not a sentence, needn't be unique or " +
			"self-contained: the statement carries the precision. This becomes the node's label in the graph.",
	}),
	statement: Type.String({
		description:
			"The proposition as one reasoning step — a TRUE, self-contained, world-facing statement. " +
			'Never reference the learner, the teacher, or the session: not "the learner understands X" but ' +
			'"X". A misconception is stated as the TRUE correction ("Nietzsche did not endorse ' +
			'might-makes-right social Darwinism") — wrongness is never recorded in the graph.',
	}),
	aliases: Type.Optional(
		Type.Array(Type.String(), {
			description: "Verbatim phrasings this session used for the same proposition, if any.",
		}),
	),
};

const edgeSchema = Type.Object({
	from: Type.String({ description: "Proposition id that is followed / supported." }),
	to: Type.String({ description: "Proposition id that follows / is supported by `from`." }),
	type: Type.Union([Type.Literal("follows"), Type.Literal("supports")], {
		description: '"follows" = to is derivable from from; "supports" = from grounds to without entailing it.',
	}),
});

// Weak-model tolerance (owner, 2026-09-25): the old zod `.default([])` /
// `.default({ quiz: {} })` on required-but-empty fields becomes Type.Optional
// here + a ??-fill at the submit seam (fillFindings/fillAudit below) — same
// contract on the wire (omission tolerated, empty never means "invalid"),
// no zod left in the agent band.
const findingsProps = {
	propositions: Type.Array(Type.Object(propositionProps), {
		description: "Every distinct proposition the session touched — true statements, misconception-free.",
	}),
	edges: Type.Array(edgeSchema, {
		description:
			"Relations between propositions: follows (derivable) / supports (grounds without entailing). Pass [] when there are none — never omit the field.",
	}),
};

const findingsSchema = Type.Object(findingsProps);

// VERDICTS-ONLY (owner, 2026-09-28): the auditor never alters the
// extractor's findings, so it does not restate them — links + bridging
// edges are its entire deliverable. An order-of-magnitude smaller submit
// than the old full-findings echo.
const auditSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The proposition id from the findings ("p1", …).' }),
			linkTo: Type.String({
				description:
					"The id of the EXISTING graph node this proposition IS — your identity verdict. EQUIVALENCE BIAS (2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart.",
			}),
		}),
		{ description: "Identity verdicts — which findings propositions ARE existing graph nodes. A proposition absent from here = create a new node. Pass [] when none — never omit the field." },
	),
	edges: Type.Array(edgeSchema, {
		description:
			"BRIDGING edges ONLY — new edges welding this batch into the existing graph, with an EXISTING graph node id as one endpoint (or both) and/or a findings proposition id. NEVER restate the extractor's own edges. Pass [] when none — never omit the field.",
	}),
});

// The notes front door's shapes are IDENTICAL to the session shapes now
// (the only difference was quiz attribution, which no longer exists):
// one schema, one findings type, both front doors.
type NotesFindings = SessionFindings;
type NotesAuditResult = AuditVerdicts;

// ── the weak-model string-heal (owner, 2026-09-28) ──
//
// OpenRouter log evidence: weak models under a big submit payload often
// emit the whole `propositions` array as ONE JSON-STRING instead of a
// native array ("propositions.0: must be object"). pi-agent-core runs
// `prepareArguments` BEFORE TypeBox validation — the sanctioned shim
// point (same doctrine as restoreMathEscapes at the display seam: heal
// weak-model wire behavior, don't punish it with a retry). Best-effort:
// heal only a string that parses to an array; anything else passes
// through untouched and fails validation exactly as before.
function healStringifiedArrays(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of ["propositions", "edges"]) {
		const v = out[key];
		if (typeof v !== "string" || v.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(v);
			if (Array.isArray(parsed)) out[key] = parsed;
		} catch {
			// not a clean stringify (e.g. truncated) — leave for validation
		}
	}
	return out;
}

// ── the submit seam (owner, 2026-09-28) ──
//
// Both top-level fields on both submit tools are REQUIRED — a payload
// missing `edges`/`links` fails validation instead of silently merging
// edge-less (the degraded-retry hole: the model's first truncated
// attempt failed validation, then the retry passed with propositions
// only — optional edges ??-filled [] — merging a pile of nodes with no
// structure). Only the per-item aliases stay optional with a ??-fill.

function fillFindings(raw: Static<typeof findingsSchema>): SessionFindings {
	return {
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
		edges: raw.edges,
	};
}

function fillAudit(raw: Static<typeof auditSchema>): AuditVerdicts {
	return {
		links: raw.links,
		edges: raw.edges,
	};
}

const NOTES_EXTRACTOR_INSTRUCTIONS = `You are the extraction specialist in a learning application. You read ONE source —
the user's own NOTES, in an ARBITRARY format (personal notes, an exported conversation, a document — anything) — and
report what those notes show the author engaging with, as structured findings for their global knowledge graph.

There is no session and no chat structure here: the source is raw text, the author's own material. Read it as such.
You are the ONLY stage that sees this source — you are fully trusted; report carefully.
You may be seeing ONE PART of a longer file (large files are chunked): extract exactly what THIS part holds —
the auditor links equivalent propositions across parts, so overlap worries are not yours.

The graph is a set of TRUE propositions about the world, full stop. A node is never anything about the author or the
source — no "the author understands X", no "mentioned in these notes": the node is just X. A misconception is NOT a
node of its own wrong claim — state the TRUE correction as the proposition.

1. PROPOSITIONS — every distinct reasoning-step-sized proposition the notes actually engage with:
   - Each has a "name" — a VERY short label, a few words: ESTABLISHED terminology, the term the discipline
     itself uses, a glossary headword a textbook would print ("Will to power", "Divine command theory").
     NEVER source-local bookkeeping — no letters, numbering, or positional labels ("F1", "criterion C",
     "the second objection"): the name becomes a GLOBAL graph label that someone who never saw these
     notes must parse. If the notes used a local shorthand for an established idea, name the node by the
     established term and put the shorthand in "aliases".
   - And a "statement" — the self-contained TRUE proposition at full precision.
   - MERGE YOUR OWN OUTPUT before submitting: two propositions stating the SAME claim at different
     precision, granularity, or angle are ONE proposition — one statement at full precision, the other
     phrasings in "aliases". Nothing downstream dedupes you; duplicates become duplicate graph nodes.
   - Closely related but genuinely distinct propositions stay separate — and MUST be connected by an
     edge (see 2).
   - Notes may explain things at length or quote material the author is studying: extract the propositions themselves,
     one reasoning step each — never a topic blob, never a sub-step.
   - "aliases": verbatim phrasings the notes used for the same proposition.

2. EDGES between propositions — the connective tissue; a graph of lonely nodes is a failed extraction:
   - "follows": to is DERIVABLE from from (understanding from makes understanding to achievable).
   - "supports": from GROUNDS to without entailing it (evidence, motivation, context — helpful, not a
     prerequisite).
   - COMPLETENESS: whenever these notes present one proposition as evidence for, consequence of, or
     prerequisite of another, that edge MUST be in your findings. Omitting a real relation is the main
     way extraction fails — do not leave obviously related propositions unconnected.

Faithfulness: extract only what the source actually articulates — never invent, pad, or compress into vagueness. When
in doubt about a proposition's exact content, quote its source passage to yourself first, then state it precisely.

Include EVERY top-level field of the call even when empty — "edges": [] when there are no relations. NEVER omit
a field because it is empty.

Your entire deliverable is ONE submit_findings call.`;

const EXTRACTOR_INSTRUCTIONS = `You are the extraction specialist in a learning application. You read ONE session
rendering and report what that session teaches — as structured findings for the learner's global knowledge graph.

The session is rendered as readable markdown: Teacher and Learner passages in order, Quiz / Recall-check /
Question blocks for the embedded checks, and one-line notes where other tools ran. Read ALL of it as the session's
teaching content.

You are the ONLY stage that sees this source, and you are FULLY TRUSTED: nothing downstream re-checks your work.
Extract carefully — the graph will hold exactly what you report.

The graph is a set of TRUE propositions about the world, full stop. A node is never anything about the learner or the
session — no "the learner understands X", no "discussed in this session": the node is just X. A misconception is NOT
a node of its own wrong claim — state the TRUE correction as the proposition.

1. PROPOSITIONS — every distinct reasoning-step-sized proposition the session touched:
   - Each has a "name" — a VERY short label, a few words: ESTABLISHED terminology, the term the discipline
     itself uses, a glossary headword a textbook would print ("Will to power", "Divine command theory").
     NEVER session-local bookkeeping — no letters, numbering, or positional labels ("F1", "criterion C",
     "the second objection"): the name becomes a GLOBAL graph label that someone who never saw this
     session must parse. If the session used a local shorthand for an established idea, name the node by
     the established term and put the shorthand in "aliases".
   - And a "statement" — the self-contained TRUE proposition at full precision (the elaboration lives
     in the graph only as this one statement).
   - MERGE YOUR OWN OUTPUT before submitting: two propositions stating the SAME claim at different
     precision, granularity, or angle are ONE proposition — one statement at full precision, the other
     phrasings in "aliases". Nothing downstream dedupes you; duplicates become duplicate graph nodes.
   - Closely related but genuinely distinct propositions stay separate — and MUST be connected by an
     edge (see 2).
   - Include corrections of misconceptions the teacher articulated, and true facts explained in prose.
   - One reasoning step per proposition: never a topic blob, never a sub-step.
   - "aliases": verbatim phrasings this session used for the same proposition.

2. EDGES between propositions — the connective tissue; a graph of lonely nodes is a failed extraction:
   - "follows": to is DERIVABLE from from (understanding from makes understanding to achievable).
   - "supports": from GROUNDS to without entailing it (evidence, motivation, context — helpful, not a
     prerequisite).
   - COMPLETENESS: whenever this session presents one proposition as evidence for, consequence of, or
     prerequisite of another, that edge MUST be in your findings. Omitting a real relation is the main
     way extraction fails — do not leave obviously related propositions unconnected.

Faithfulness: extract only what the session actually articulates — never invent, pad, or compress into vagueness. When
in doubt about a proposition's exact content, quote its source passage to yourself first, then state it precisely.

Include EVERY top-level field of the call even when empty — "edges": [] when there are no relations. NEVER omit a
field because it is empty.

Your entire deliverable is ONE submit_findings call.`;

/** One single-submit agent run — the shared shape of EVERY LLM stage
 *  here (session + notes): the whole deliverable is ONE TypeBox-validated
 *  submit call (a pi agent purely so the model can retry a schema-invalid
 *  call). The submitted value is captured from the execute seam, which
 *  only fires on a schema-valid call — the ??-fill (the old zod defaults)
 *  applies at the capture. */
async function runSubmitAgent<T>(opts: {
	role: ModelRole;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	/** Weak-model tolerance: the old zod `.default()`s, applied to the
	 *  schema-valid raw input at the submit seam. */
	fill: (input: any) => T;
	systemPrompt: string;
	prompt: string;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	neverSubmitted: string;
	/** Extra tools beside the submit call (the auditor's graph-exploration
	 *  set, 2026-09-27): a small agentic loop instead of a bare retry. */
	extraTools?: Record<string, AgentTool<any>>;
	/** Turn budget for the loop (default 4 = retry-only; the auditor runs
	 *  an exploration loop instead — 16). */
	maxTurns?: number;
}): Promise<T> {
	let submitted: T | undefined;
	const result = await runSubagent(
		[
			...(opts.extraTools ? Object.values(opts.extraTools) : []),
			{
				name: opts.toolName,
				label: opts.toolName,
				description: opts.toolDescription,
				parameters: opts.parameters,
				prepareArguments: (args) => healStringifiedArrays(args) as never,
				execute: async (_toolCallId, input) => {
					submitted = opts.fill(input);
					return toToolResult(submitted);
				},
			} satisfies AgentTool<any>,
		],
		{
			role: opts.role,
			engine: opts.engine,
			systemPrompt: opts.systemPrompt,
			prompt: opts.prompt,
			maxTurns: opts.maxTurns ?? 4,
			abortSignal: opts.signal,
			onAssistantMessage: (message, step) =>
				opts.onStep(
					message.usage,
					// Provider-qualified stamp (model slots wave, 2026-09-20):
					// pi reports the bare id; usage stamps carry provider:id to
					// match the price table's uniform keys.
					`${message.provider}:${message.model}`,
					step,
					message.stopReason,
					message.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name).join(", ") || "(none)",
				),
			shouldStop: (_message, toolResults) => toolResults.some((r) => r.toolName === opts.toolName && !r.isError),
		},
	);
	void result;
	if (!submitted) throw new Error(opts.neverSubmitted);
	return submitted;
}

/** The extractor over ONE session transcript (the chat front door). */
function runExtractor(
	engine: PiEngine | undefined,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<SessionFindings> {
	return runSubmitAgent({
		role: "extractor",
		toolName: "submit_findings",
		toolDescription: "Submit the session findings.",
		parameters: findingsSchema,
		fill: fillFindings,
		systemPrompt: EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
	});
}

/** The extractor over ONE source of raw personal notes (the format-agnostic
 *  front door): same single-submit shape, notes-mode prompt + schema. */
function runNotesExtractor(
	engine: PiEngine | undefined,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<NotesFindings> {
	return runSubmitAgent({
		role: "extractor",
		toolName: "submit_findings",
		toolDescription: "Submit the notes findings.",
		parameters: findingsSchema,
		fill: fillFindings,
		systemPrompt: NOTES_EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
	});
}

// ─── the auditor ───────────────────────────────────────────────────────────


const AUDITOR_INSTRUCTIONS = `You are the linking stage of a learning application's extraction pipeline. An extractor
has read a source (a teaching session, or the author's personal notes) and reported findings: propositions and
follows/supports edges. You NEVER see the source itself — the extractor is fully trusted, and you do not re-check
its work. Your job is IDENTITY: connecting those findings to the CURRENT knowledge graph, preparing the merge.

You explore the graph through your tools: find (glob over names + statements + aliases), list_sessions, and
list_propositions (full statement text, per session). The graph may be large — search, don't assume.

IDENTITY — links, per proposition:
- For each proposition, search the graph (its key words, its synonyms, its phrasings). Does an EXISTING node already
  state this same proposition?
- If yes: add { "id": <its proposition id>, "linkTo": <that node's id> } to "links". The session's phrasings join
  its aliases and its provenance; the node keeps its existing name.
- If no: add nothing — a new node is created with the extractor's name as its label.
- EQUIVALENCE BIAS (owner ruling): paraphrases, rewordings, and compressions of the same claim MERGE. When two
  statements are the same claim at different precision or from different angles, LINK them. Only genuinely distinct
  propositions — different claims about the world — stay apart. You are NOT guarding against wrong merges; you are
  hunting for right ones.

BRIDGING EDGES — the one place you create edges:
- You may add edges whose endpoints are an EXISTING graph node id and one of the batch's propositions (use the
  existing node's real id as "from" or "to"). This is how the new material gets welded into the old graph: when the
  existing graph's content makes a proposition follow, or grounds it, draw the edge.
- Keep edges typed like the extractor's: "follows" = derivable; "supports" = grounds without entailing.
- Never invent propositions. NEVER restate the extractor's own edges — they merge as-is.

Your deliverable is ONLY the verdicts: "links" + "edges" (bridging ONLY). NEVER restate the propositions or the
extractor's edges — the merger already has them. Your entire deliverable is ONE submit_review call.

Include EVERY top-level field of the call even when empty — "links": [] when nothing links, "edges": [] when there
are no bridges. NEVER omit a field because it is empty.`;

/** The auditor — one shape for both front doors now (the notes schema was
 *  identical once attribution died). An agentic loop: graph-exploration
 *  tools plus the one submit call. */
function runAuditor(
	engine: PiEngine | undefined,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
	tools: Record<string, AgentTool<any>>,
): Promise<AuditVerdicts> {
	return runSubmitAgent({
		role: "auditor",
		toolName: "submit_review",
		toolDescription: "Submit the verdicts ONLY: identity links + bridging edges — never the propositions themselves.",
		parameters: auditSchema,
		fill: fillAudit,
		systemPrompt: AUDITOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the auditor never submitted a review",
		extraTools: tools,
		maxTurns: 16,
	});
}

// ─── the pipeline status registry ─────────────────────────────────────────────

/** The pipeline phases, in order — what the home status endpoint shows.
 *  The post-batch embedding tail was its own phase (accuracy wave,
 *  2026-09-19) until wave 7 killed the embedder seam wholesale (this
 *  interlude) — birth-session clusters need no post-merge pass. The
 *  phases tell the truth about what the loop is actually waiting on.
 *  "waiting" (owner 2026-09-28): the serialized-audit gate — the run's
 *  audit+merge critical section is queued behind another run's; the
 *  extractor is done but the auditor may not start until the graph is
 *  stable. */
export type ExtractionPhase = "extracting" | "waiting" | "auditing" | "merging";

/** One in-flight pipeline run. Module-level: one process, one registry.
 *  Exported for the status payload's consumer typing (the dock). */
export interface RunningExtraction {
	chatId: string;
	/** Which front door the run came through — label + usage-persistence
	 *  depend on it (chats bill their chat record; notes bill the source
	 *  record). */
	kind: "chat" | "notes";
	/** Display label (the file path for notes imports); the status route
	 *  falls back to the chat store for chat runs. */
	label?: string;
	phase: ExtractionPhase;
	startedAt: number;
	/** Live per-stage usage, accumulated as steps bill (the dock's cost /
	 *  context-window blobs read this through /api/graph/status). */
	usage: {
		extractor?: ExtractionStageUsage;
		auditor?: ExtractionStageUsage;
	};
	/** True-cancellation handle (the dock's abort button): one controller per
	 *  run, shared across phases; abort() cancels the in-flight model call. */
	controller: AbortController;
}

interface LhExtractionGlobal {
	__lhExtractionRuns?: {
		/** In-flight pipeline runs, keyed chatId (chat) / src id (notes). */
		running: Map<string, RunningExtraction>;
		/** The single-flight guard, shared by every pipeline instance. */
		inFlight: Set<string>;
		/** Last minted startedAt — kept monotonic so two runs starting in the
		 *  same millisecond never collide on the usage idempotency key. */
		lastStartedAt: number;
	};
	/** The serialized-audit mutex (owner 2026-09-28): a FIFO promise
	 *  chain — the audit+merge critical section runs one run at a time,
	 *  process-wide. globalThis for the same module-instance reason as
	 *  the run registries. */
	__lhAuditLock?: { tail: Promise<void> };
}

/** THE RUN REGISTRIES live on globalThis, not module level — the
 *  turn-liveness lesson: Next dev compiles each route entry as its own
 *  module instance, so a module-level Map is a different object in the
 *  /api/activity route than in the pipeline's chat-handler instance —
 *  the status routes would read an always-empty registry. One process,
 *  one truth — the same idiom as the turn, wake, and abort registries
 *  (moved 2026-09-19, the observability-accuracy wave; also makes the
 *  single-flight guard cross route instances). */
function runs(): NonNullable<LhExtractionGlobal["__lhExtractionRuns"]> {
	const g = globalThis as typeof globalThis & LhExtractionGlobal;
	return (g.__lhExtractionRuns ??= { running: new Map(), inFlight: new Set(), lastStartedAt: 0 });
}

/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export function extractionStatuses(): RunningExtraction[] {
	return [...runs().running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** True cancellation of the in-flight run for a chat (the dock's abort
 *  button): the pending model call receives the signal — the provider
 *  cancels the request, spend stops — and the run ends like a failure:
 *  nothing merged, nothing checkpointed, partial usage still persisted.
 *  Returns false when no run is in flight (idempotent no-op). */
export function abortExtraction(chatId: string): boolean {
	const run = runs().running.get(chatId);
	if (!run) return false;
	run.controller.abort();
	return true;
}

// ─── the pipeline ───────────────────────────────────────────────────────────

export interface ExtractionModels {
	/** Test seam: a scripted engine per stage — checked FIRST, ahead of the
	 *  engineFor chain (production wires no direct values). */
	extractor?: PiEngine;
	auditor?: PiEngine;
	/** Settings-resolved engine per role — the same slot treatment the
	 *  job runner got, read FRESH per stage call (a settings PUT between
	 *  stages lands). BYOK (owner, 2026-09-22): the chain (role override →
	 *  slot → NOTHING) may end EMPTY → undefined; the front doors refuse
	 *  with ModelsNotConfiguredError before any stage runs. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** Key-presence gate (provider-key interlude, 2026-09-25): given a
	 *  stage engine's provider + the role's slot tier, the injected check
	 *  returns the refusal envelope when the provider's key is missing
	 *  (null = run). Same injection discipline as the job runner's seam
	 *  (the agent layer may not read the key store); absent in tests that
	 *  inject engines directly (test engines never owe a key). A keyless
	 *  stage refuses with ProviderKeyMissingError BEFORE any batch runs. */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

export interface ExtractionPipelineDeps extends GraphDeps, ExtractionModels {
	/** The chunk budget — the transcript-token share of the extractor's
	 *  context; batches fill to it (the trigger fires on the same number,
	 *  read fresh per turn by the composition root). OPTIONAL with the
	 *  factory default (4096) so test fixtures stay minimal; the server
	 *  callers wire the live effective settings (extraction-UX redesign,
	 *  2026-09-24). */
	getChunkTokens?: () => number;
}

export interface NotesImportInput {
	/** The source's file path — its identity (deterministic src id) AND its
	 *  provenance label in the detail card. */
	filePath: string;
	/** The file's raw content, VERBATIM — any format. */
	text: string;
}

export interface ExtractionPipeline {
	/** Extract + audit + merge ONE chat. Single-flight per chat; resolves to
	 *  the merger's append stats (or throws — no checkpoint on failure). */
	runExtraction(chatId: string): Promise<EmissionStats>;
	/** The format-agnostic front door (2026-09-13): run the same pipeline
	 *  over ONE raw notes file. The source id is deterministic per file
	 *  path, so re-importing the same file re-runs extraction against the
	 *  same source identity (mappings dedupe by it). */
	importNotes(input: NotesImportInput): Promise<EmissionStats>;
}

/** pi's per-step usage, flattened to the persisted CallUsage fields
 *  (the money channel's capture shape, contracts/chat.ts). Exported for
 *  the cluster namer — the same capture shape (2026-09 graph cost
 *  metrics wave). Module scope: no closure deps, pure projection. */
export function callUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		// Optional in pi's Usage (providers that never emit reasoning
		// tokens leave it unset) — persisted as 0, never dropped.
		reasoningTokens: usage.reasoning ?? 0,
	};
}

export function createExtractionPipeline(deps: ExtractionPipelineDeps): ExtractionPipeline {
	const { chatStore, graphStore } = deps;
	// Stage-engine resolution: a direct test value wins; otherwise the
	// engineFor chain (role override → slot → nothing, resolved FRESH per
	// stage call server-side) — the job runner's exact treatment. undefined
	// = the BYOK chain came up empty; the front-door guards turn that into
	// an honest refusal.
	const stageEngine = (role: ModelRole, override?: PiEngine): PiEngine | undefined =>
		override ?? deps.engineFor?.(role);
	/** The per-need refusal guard: which slot tiers the pipeline's stages
	 *  found unset (test values count as configured — they ARE engines),
	 *  and whether a configured stage's provider key is gone (provider-key
	 *  interlude, 2026-09-25) — both refuse BEFORE any batch runs. */
	function refuseIfStagesUnready(): void {
		const stages: readonly [ModelRole, PiEngine | undefined][] = [
			["extractor", stageEngine("extractor", deps.extractor)],
			["auditor", stageEngine("auditor", deps.auditor)],
		];
		const missing = new Set<ModelSlotName>();
		for (const [role, engine] of stages) if (!engine) missing.add(ROLE_SLOT[role]);
		if (missing.size > 0) {
			console.info(`[extraction] refused — no model configured for: ${[...missing].join(", ")}`);
			throw new ModelsNotConfiguredError([...missing]);
		}
		// Key-presence parity: first offender surfaces (extractor before
		// auditor); fixing that key re-gates and the next run surfaces the
		// next offender, if any.
		for (const [role, engine] of stages) {
			const refusal = deps.providerKeyMissing?.(engine!.model.provider, ROLE_SLOT[role]);
			if (refusal) {
				console.info(`[extraction] refused — ${JSON.stringify(refusal)}`);
				throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
			}
		}
	}
	// THE SHARED REGISTRIES (runs() above — globalThis): every pipeline
	// instance (route entries in dev, tests) sees the same runs, the same
	// single-flight guard. No module-level state left in this factory.
	const runningExtractions = runs().running;
	const inFlight = runs().inFlight;

	function setPhase(chatId: string, phase: ExtractionPhase, kind: "chat" | "notes", label?: string): void {
		const R = runs();
		const prev = runningExtractions.get(chatId);
		if (!prev) R.lastStartedAt = Math.max(Date.now(), R.lastStartedAt + 1);
		runningExtractions.set(chatId, {
			chatId,
			kind,
			label: prev?.label ?? label, // phase changes never lose the label
			phase,
			startedAt: prev?.startedAt ?? R.lastStartedAt,
			usage: prev?.usage ?? {}, // phase changes never lose usage
			controller: prev?.controller ?? new AbortController(),
		});
	}

	/** Accumulate one billed step into the run's registry entry (live). */
	function recordStep(chatId: string, stage: "extractor" | "auditor", usage: CallUsage, model: string): void {
		const run = runningExtractions.get(chatId);
		if (!run) return; // not running (tests driving stages directly)
		run.usage[stage] ??= { model, steps: [] };
		run.usage[stage]!.steps.push(usage);
	}

	/** SERIALIZED AUDIT (owner 2026-09-28): the auditor explores the LIVE
	 *  graph through its tools and stamps identity verdicts against what
	 *  it finds — so the audit+merge section is a process-wide critical
	 *  section. Two concurrent audits would each link into a graph the
	 *  other is about to change: the structural mint of duplicate nodes.
	 *  The extractor stays parallel (source-local, graph-blind). The
	 *  check runs BEFORE any LLM is invoked or the graph read; the lock
	 *  is FIFO, held through the merge, reacquired per batch, and
	 *  abort-aware on both sides of the queue (a waiter that aborts
	 *  leaves without auditing — its chain link still resolves, so
	 *  successors never hang). */
	async function withAuditLock<T>(chatId: string, kind: "chat" | "notes", label: string | undefined, critical: () => Promise<T>): Promise<T> {
		setPhase(chatId, "waiting", kind, label);
		const g = globalThis as typeof globalThis & LhExtractionGlobal;
		const lock = (g.__lhAuditLock ??= { tail: Promise.resolve() });
		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		const signal = runningExtractions.get(chatId)?.controller.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			if (!signal) return;
			onAbort = () => {
				const err = new Error("extraction aborted while waiting for the audit gate");
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([prev, aborted]);
			signal?.throwIfAborted(); // aborted exactly at handoff
			return await critical();
		} finally {
			if (onAbort && signal && !signal.aborted) signal.removeEventListener("abort", onAbort);
			release();
		}
	}

	async function extract(chatId: string, view: string): Promise<SessionFindings> {
		const signal = runningExtractions.get(chatId)?.controller.signal;
		signal?.throwIfAborted(); // an abort during a sync gap ends the run here
		console.info(`[extraction ${chatId}] extractor starting (${view.split("\n").length} markdown lines)`);
		const t0 = performance.now();

		const findings = await runExtractor(
			stageEngine("extractor", deps.extractor),
			view,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(chatId, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${chatId}] extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	async function audit(chatId: string, findings: SessionFindings): Promise<AuditVerdicts> {
		const signal = runningExtractions.get(chatId)?.controller.signal;
		signal?.throwIfAborted(); // an abort during the extract→audit gap ends here
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${chatId}] auditor starting (${findings.propositions.length} propositions, ${findings.edges.length} edges, ` +
				`${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();

		// The auditor NEVER sees the source (owner 2026-09-27): findings
		// JSON + identity instructions, and the graph reached through
		// exploration tools instead of an injected dump.
		const auditResult = await runAuditor(
			stageEngine("auditor", deps.auditor),
			`Proposed findings from the extractor (the source itself is not available to you — the extractor is fully trusted):\n\n` +
				`${JSON.stringify(findings, null, 2)}\n\n` +
				`The current knowledge graph has ${graph.nodes.length} node(s). Explore it with your tools and link what links.`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(chatId, "auditor", callUsage(usage), model);
				console.info(`[extraction] auditor step ${step}: ${finishReason}, tools: ${tools}`);
			},
			auditorGraphTools({ chatStore, graphStore }),
		);
		console.info(
			`[extraction ${chatId}] audit: ${findings.propositions.length} propositions through, ` +
				`${auditResult.links.length} linked to existing nodes, ${auditResult.edges.length} bridging edges`,
		);
		console.info(`[extraction ${chatId}] auditor done in ${Math.round(performance.now() - t0)}ms`);
		return auditResult;
	}

	/** Append the run's usage record to the chat's extractions log — success
	 *  or failure: a failed run still spent money, and its partial usage is
	 *  exactly what the record should show (stats absent = never merged).
	 *  Idempotent per startedAt (the store dedupes). */
	function persistRunUsage(chatId: string, durationMs: number, stats: EmissionStats | undefined): void {
		const run = runningExtractions.get(chatId);
		if (!run) return; // not running (tests driving stages directly)
		// SESSION-DELETION GUARD (wave 6): a chat deleted mid-run has no
		// usage log to append to — the record's death is the user's choice
		// and its partial spend logs with it (appendSourceUsage below
		// already no-ops for a vanished source; the chat path guards here).
		if (run.kind === "chat" && !chatStore.getChat(chatId)) return;
		const entry: ExtractionRunUsage = {
			startedAt: run.startedAt,
			at: new Date().toISOString(),
			durationMs,
			stats,
			stages: {
				extractor: run.usage.extractor ?? { model: "unknown", steps: [] },
				auditor: run.usage.auditor ?? { model: "unknown", steps: [] },
			},
		};
		if (run.kind === "notes") graphStore.appendSourceUsage(chatId, entry);
		else chatStore.appendExtractionUsage(chatId, entry);
	}

	async function runExtraction(chatId: string): Promise<EmissionStats> {
		if (inFlight.has(chatId)) return { nodes: 0, edges: 0 };
		inFlight.add(chatId);
		const t0 = performance.now();
		// COVERAGE (vision-extraction-coverage.md, 2026-09-15): extract ONLY
		// what the per-chat coverage ledger doesn't already hold — never the
		// whole session. Batches are token-budgeted runs of the oldest
		// uncovered messages; each merged batch checkpoints its messages'
		// coverage ATOMICALLY (inside the merger's step 4), so an abort or
		// error below loses at most the in-flight batch — every earlier
		// batch stays covered, the rest stays visibly uncovered.
		let batchesDone = 0;
		const total: EmissionStats = { nodes: 0, edges: 0 };
		try {
			const record = chatStore.getChat(chatId);
			if (!record) throw new Error(`Chat not found: ${chatId}`);
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): the write channel needs extractor + auditor
			// engines AND their providers' keys; a refusal lands BEFORE any
			// stage runs (typed — the trigger skips, routes surface 503).
			refuseIfStagesUnready();
			const covered = coverageOf(record.messages, graphStore.readCoverage(), chatId);
			if (covered.uncovered.length === 0) {
				console.info(`[extraction ${chatId}] nothing uncovered — no-op`);
				return { nodes: 0, edges: 0 };
			}
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			// The batcher's one rule (owner, Wave D): a tool-call message and
			// its result message(s) are INSEPARABLE — one chunk, covered
			// together, read together (core/coverage.ts batchRuns).
			const batches = batchRuns(covered.slots, covered.uncovered, chunkTokens);
			console.info(
				`[extraction ${chatId}] pipeline start — ${covered.uncoveredTokens} uncovered tok, ` +
					`${covered.uncoveredCount} messages, ${batches.length} batch(es) of ≤${chunkTokens} tok`,
			);
			for (const batch of batches) {
				// The batch's source view: the ONE shared markdown engine
				// (owner 2026-09-27) over the batch's messages. Anchors OFF
				// (2026-09-28): propositions report no message ids, so the
				// [id] anchors are noise — same as transcriptView. The
				// fingerprint's line format is separate and unchanged (no
				// mass re-extraction).
				const view = sessionMarkdown(
					batch.map((slot) => slot.message),
					{ title: record.title, anchors: false },
				);
				setPhase(chatId, "extracting", "chat");
				const findings = await extract(chatId, view);
				// SERIALIZED AUDIT (owner 2026-09-28): audit + merge are the
				// graph-mutating critical section — one run at a time,
				// process-wide, so the auditor explores the graph as it
				// stands AFTER every earlier run's merge. Reacquired per
				// batch: interleaved runs each audit against the latest
				// graph instead of starving each other.
				await withAuditLock(chatId, "chat", undefined, async () => {
					setPhase(chatId, "auditing", "chat");
					const auditResult = await audit(chatId, findings);
					setPhase(chatId, "merging", "chat");
					// SESSION-DELETION GUARD (wave 6): a chat deleted mid-run must never
					// merge. The deletion route aborts this run first and runs its purge
					// as one sync block; this closes the last window — a run that slipped
					// past the wind-down finds the chat gone HERE and rides the existing
					// abort path (info, not error): nothing merged, nothing checkpointed.
					if (!chatStore.getChat(chatId)) {
						const gone = new Error(`chat deleted mid-run: ${chatId}`);
						gone.name = "AbortError";
						throw gone;
					}
					// The batch's messages, snapshotted when the run computed
					// coverage — if a message mutates mid-run (a quiz answer
					// merges in), the stored fingerprint won't match its new
					// one and it re-opens: honest by construction.
					const foldedAt = new Date().toISOString();
					const batchStats = mergeFindings(chatId, findings, auditResult, { chatStore, graphStore }, {
						foldedAt,
						coverage: batch
							.filter((slot) => messageViewLines(slot.message, slot.message.id).length > 0)
							.map((slot) => ({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt })),
					});
					total.nodes += batchStats.nodes;
					total.edges += batchStats.edges;
				});
				batchesDone++;
				console.info(
					`[extraction ${chatId}] batch ${batchesDone}/${batches.length} merged: ` +
						`${total.nodes} nodes, ${total.edges} edges (cumulative)`,
				);
			}
			const stats = total;
			// Option A: the layout ledger evolves with the merge (sync — the
			// next snapshot fetch must already reflect the new nodes).
			settleGraphLayout(graphStore);
			persistRunUsage(chatId, Math.round(performance.now() - t0), stats);
			console.info(
				`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.edges} edges ` +
					`(${Math.round(performance.now() - t0)}ms total)`,
			);
			return stats;
		} catch (err) {
			persistRunUsage(chatId, Math.round(performance.now() - t0), batchesDone > 0 ? total : undefined);
			// Aborted (the dock's abort button): a deliberate stop, not a
			// failure. Per-batch coverage (above) makes the stop CHEAP: every
			// merged batch stays covered; only the in-flight one doesn't — it
			// stays uncovered, and the next trigger or manual run picks it
			// up. Partial usage is persisted either way.
			if (err instanceof Error && err.name === "AbortError") {
				console.info(
					`[extraction ${chatId}] aborted (${Math.round(performance.now() - t0)}ms) — ` +
						`${batchesDone} merged batch(es) stay covered, the in-flight one does not`,
				);
				return total;
			}
			// A failure keeps the same discipline: merged batches stay
			// covered, nothing else is checkpointed, and the throw travels
			// to the caller (this line keeps the run's log legible).
			console.error(`[extraction ${chatId}] pipeline failed (${Math.round(performance.now() - t0)}ms) after ${batchesDone} batch(es):`, err);
			throw err;
		} finally {
			inFlight.delete(chatId);
			runningExtractions.delete(chatId); // done or failed — no longer running
		}
	}

	// ── the notes front door (format-agnostic: raw text in, same graph out) ──

	/** The raw source view the notes stages see: the file path + the text
	 *  VERBATIM. No message ids — provenance is the file itself. */
	function notesView(input: { filePath: string; text: string; part?: { i: number; n: number } }): string {
		const part = input.part && input.part.n > 1 ? ` (part ${input.part.i}/${input.part.n})` : "";
		return `SOURCE (the author's personal notes): ${input.filePath}${part}\n\n${input.text}`;
	}

	/** Chunk the notes text under the same budget the chat path uses
	 * (owner, 2026-09-28: the whole-file-in-one-call design collapsed a
	 * weak model — 26 propositions, structure bleed mid-emission).
	 * Greedy by line, chars/4 like every other estimate in the app; a
	 * single over-budget line rides alone (never split a line). */
	function chunkNotes(text: string, budget: number): string[] {
		if (text.trim().length === 0) return [];
		const out: string[] = [];
		let current = "";
		for (const line of text.split("\n")) {
			const candidate = current.length === 0 ? line : current + "\n" + line;
			if (current.length > 0 && Math.ceil(candidate.length / 4) > budget) {
				out.push(current);
				current = line;
			} else {
				current = candidate;
			}
		}
		if (current.trim().length > 0) out.push(current);
		return out;
	}

	async function notesExtract(input: { id: string; filePath: string; text: string; part?: { i: number; n: number } }): Promise<NotesFindings> {
		const signal = runningExtractions.get(input.id)?.controller.signal;
		signal?.throwIfAborted(); // an abort during a sync gap ends the run here
		const view = notesView(input);
		console.info(`[extraction ${input.id}] notes extractor starting (${view.split("\n").length} source lines)`);
		const t0 = performance.now();
		const findings = await runNotesExtractor(
			stageEngine("extractor", deps.extractor),
			view,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(input.id, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${input.id}] notes extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	// The notes auditor is the SAME identity-linker as the chat one (one
	// schema now that attribution is gone) — audit() above, verbatim.

	async function runNotesExtraction(input: { id: string; filePath: string; text: string; importedAt: string }): Promise<EmissionStats> {
		const { id } = input;
		if (inFlight.has(id)) return { nodes: 0, edges: 0 };
		inFlight.add(id);
		const t0 = performance.now();
		try {
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): same refusal as the chat front door — no
			// extractor/auditor engines, or a stage key gone, no run.
			refuseIfStagesUnready();
			// CHUNKED like the chat path (owner, 2026-09-28): each chunk is a
			// standalone extract → audit → merge, so no single call carries a
			// whole large file. Abort mid-run keeps earlier chunks merged
			// (same doctrine as chat batches).
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			const chunks = chunkNotes(input.text, chunkTokens);
			console.info(
				`[extraction ${id}] notes pipeline start (${input.filePath}) — ${chunks.length} chunk(s) of ≤${chunkTokens} tok`,
			);
			const stats: EmissionStats = { nodes: 0, edges: 0 };
			for (const [i, chunk] of chunks.entries()) {
				setPhase(id, "extracting", "notes", input.filePath);
				const findings = await notesExtract({ ...input, text: chunk, part: { i: i + 1, n: chunks.length } });
				// SERIALIZED AUDIT (owner, 2026-09-28): the same gate as the chat
				// path — a notes import and a chat run may extract in parallel,
				// but audit + merge one at a time, process-wide. Reacquired per
				// chunk so multi-chunk runs interleave fairly.
				const merged = await withAuditLock(id, "notes", input.filePath, async () => {
					setPhase(id, "auditing", "notes", input.filePath);
					const auditResult = await audit(id, findings);
					setPhase(id, "merging", "notes", input.filePath);
					return mergeFindings(id, findings, auditResult, { chatStore, graphStore }, { foldedAt: input.importedAt });
				});
				stats.nodes += merged.nodes;
				stats.edges += merged.edges;
			}
			// Same post-merge settle as the chat path.
			settleGraphLayout(graphStore);
			persistRunUsage(id, Math.round(performance.now() - t0), stats);
			console.info(
				`[extraction ${id}] merged: ${stats.nodes} nodes, ${stats.edges} edges ` +
					`(${Math.round(performance.now() - t0)}ms total)`,
			);
			return stats;
		} catch (err) {
			persistRunUsage(id, Math.round(performance.now() - t0), undefined);
			if (err instanceof Error && err.name === "AbortError") {
				console.info(`[extraction ${id}] aborted (${Math.round(performance.now() - t0)}ms) — nothing merged, nothing checkpointed`);
				return { nodes: 0, edges: 0 };
			}
			console.error(`[extraction ${id}] notes pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			throw err;
		} finally {
			inFlight.delete(id);
			runningExtractions.delete(id); // done or failed — no longer running
		}
	}

	/** Import ONE raw notes file: register the source (deterministic id per
	 *  file path — re-import keeps the same identity and its usage history)
	 *  and run the pipeline over it. */
	async function importNotes(input: NotesImportInput): Promise<EmissionStats> {
		const id = `src_${crypto.createHash("sha256").update(input.filePath).digest("hex").slice(0, 12)}`;
		const importedAt = new Date().toISOString();
		graphStore.upsertSource({ id, filePath: input.filePath, importedAt });
		return runNotesExtraction({ id, ...input, importedAt });
	}

	return { runExtraction, importNotes };
}

