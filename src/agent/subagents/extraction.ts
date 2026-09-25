import * as crypto from "node:crypto";
import type { UIMessage } from "ai";
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
	AuditResult,
	CallUsage,
	ChatRecord,
	ExtractionRunUsage,
	ExtractionStageUsage,
	GraphNode,
	SessionFindings,
} from "../../core/contracts.ts";
import { getGraph, mergeFindings, type EmissionStats, type GraphDeps } from "../../core/graph.ts";
import type { GraphStore } from "../../core/ports.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { batchRuns, batchTag, coverageOf, messageViewLines } from "../../core/coverage.ts";
import { projectNative } from "../../core/projection.ts";

/**
 * The extraction pipeline (vision §1 construction, 2026-09-02 redesign) — the
 * sole graph writer. Three stages, one orchestrator:
 *
 *   extractor (LLM)  transcript → SessionFindings (free-form propositions,
 *                    follows/supports edges, quiz attribution, understanding
 *                    notes — each with verbatim evidence). TREE-BLIND: it
 *                    sees only the transcript, never the plan tree.
 *   auditor (LLM)    findings + THE CURRENT GRAPH → AuditResult: the
 *                    verified subset with an identity verdict per
 *                    proposition (linkTo an existing node, or create), plus
 *                    the drops for the log.
 *   merger (core)    mergeFindings() → deterministic ledger appends
 *
 * The LLM stages supply only the judgment calls; the deterministic rebuild
 * in the merger owns everything that must never be mis-copied (event kinds,
 * timestamps, refs, provenance points). Both agents are single-tool-call
 * workers: their whole deliverable is one TypeBox-validated submit call — a
 * ToolLoopAgent purely so the model can retry a schema-invalid call.
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
 * source ids ("src_" + path hash) play the chatId role in mappings, events
 * and checkpoints, and the source record (graphStore sources seam) carries
 * the file path + the run's usage. No quiz events are ever built from
 * notes — quiz outcomes inside the text surface only through the
 * extractor's understanding observations (user-decided 2026-09-13).
 *
 * Observability (§5 baseline): every stage logs one line per step, its
 * start, and its duration; the pipeline logs a failure line before
 * rethrowing, so the server log reads start → stage timings → merged
 * stats (or failed) for every run.
 */

// ─── the transcript view (what the extractor + auditor see) ─────────────────

/**
 * A quiz tool part's outcome, one line: the attribution evidence.
 * (question text + what the learner did — kind/correct are rebuilt by the
 * merger; the extractor only needs enough to attribute.)
 */
/**
 * The compact transcript both LLM stages see: user/teacher text VERBATIM,
 * each tagged with its message id (provenance anchors — the extractor
 * reports them back per proposition/edge), and quiz outcome lines.
 * TREE-BLIND by design (2026-09-02): no plan tree, no mark_done —
 * extraction is free-form, decoupled from the session's plan. Job tool
 * parts (research/demo/visual) are noise for extraction — their outcomes
 * are summarized as one line each.
 */
export function transcriptView(record: ChatRecord): string {
	// The shared seam (core/coverage.ts messageViewLines): the LLM's prompt
	// view and the coverage fingerprint use ONE line builder, so "covered"
	// means — exactly — what the extractor saw. Wave B: the record is native
	// history — the extraction view reads through the one-way projection.
	const lines = [`SESSION: ${record.title}`];
	const projected = projectNative(record.messages);
	projected.forEach((message, index) => {
		lines.push(...messageViewLines(message, message.id || `m${index}`));
	});
	return lines.join("\n");
}

// ─── the extractor ──────────────────────────────────────────────────────────

const evidenceSchema = Type.Array(Type.String(), {
	minItems: 1,
	description: "Verbatim quotes from the transcript that back this. The auditor will check every quote.",
});

const messagesSchema = Type.Array(Type.String(), {
	description: "The message ids (from the [id] tags in the transcript) where this came up — provenance.",
});

const understandingSchema = Type.Optional(
	Type.Union(
		[
			Type.Literal("solid"),
			Type.Literal("shaky"),
			Type.Literal("accepted"),
			Type.Literal("resisted"),
			Type.Literal("not yet engaged"),
		],
		{
			description:
				"ONE word — the learner's grasp of this proposition in THIS session, from the fixed scale " +
				'"solid" | "shaky" | "accepted" | "resisted" | "not yet engaged". Nothing else: no numbers, ' +
				"no justification, no explanation.",
		},
	),
);

const propositionProps = {
	id: Type.String({ description: 'Local id: "p1", "p2", … — referenced by edges and attribution.' }),
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
			'might-makes-right social Darwinism") — the wrongness lives in the quiz outcomes, never here.',
	}),
	aliases: Type.Array(Type.String(), {
		description: "Verbatim phrasings this session used for the same proposition, if any.",
	}),
	messages: messagesSchema,
	evidence: evidenceSchema,
	understanding: understandingSchema,
};

const edgeSchema = Type.Object({
	from: Type.String({ description: "Proposition id that is followed / supported." }),
	to: Type.String({ description: "Proposition id that follows / is supported by `from`." }),
	type: Type.Union([Type.Literal("follows"), Type.Literal("supports")], {
		description: '"follows" = to is derivable from from; "supports" = from grounds to without entailing it.',
	}),
	messages: messagesSchema,
	evidence: evidenceSchema,
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
	edges: Type.Optional(
		Type.Array(edgeSchema, {
			description:
				"Relations between propositions: follows (derivable) / supports (grounds without entailing). Pass [] when there are none — never omit the field.",
		}),
	),
	attribution: Type.Optional(
		Type.Object(
			{
				quiz: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
					description:
						"toolCallId of EVERY quiz line → the proposition id it was really testing. Attribute RETROACTIVELY — the whole transcript is visible; map each quiz to the proposition it tests (often articulated elsewhere in the session). null when genuinely unattributable.",
				}),
			},
			{
				description:
					"Quiz attribution — your only event judgment. Pass { quiz: {} } when the session has no quiz lines — never omit the field.",
			},
		),
	),
};

const findingsSchema = Type.Object(findingsProps);

const auditProps = {
	...findingsProps,
	propositions: Type.Array(
		Type.Object({
			...propositionProps,
			linkTo: Type.Optional(
				Type.String({
					description:
						"The id of the EXISTING graph node this proposition IS — your identity verdict. Absent = create a new node. When unsure, omit: duplicates over wrong merges.",
				}),
			),
		}),
		{
			description: "Every distinct proposition the session touched — true statements, misconception-free.",
		},
	),
	dropped: Type.Optional(
		Type.Array(
			Type.Object({
				ref: Type.String({
					description: 'Proposition id, "from→to" for an edge, or attribution toolCallId.',
				}),
				reason: Type.String(),
			}),
			{
				description:
					"Everything you dropped, with the reason — the audit trail. Pass [] when you dropped nothing — never omit the field.",
			},
		),
	),
};

const auditSchema = Type.Object(auditProps);

// The notes front door's shapes: everything session findings have, minus
// quiz attribution — raw notes have no quiz tool parts, so there is
// nothing to attribute (and no event to build: outcomes inside the text
// surface only through understanding observations, user-decided).
const { attribution: _omitted, ...notesFindingsProps } = findingsProps;
const notesFindingsSchema = Type.Object(notesFindingsProps);
const { attribution: _omitted2, ...notesAuditProps } = auditProps;
const notesAuditSchema = Type.Object(notesAuditProps);
type NotesFindings = Omit<SessionFindings, "attribution">;
type NotesAuditResult = Omit<AuditResult, "attribution">;

// ── the weak-model ??-fills (the old zod defaults, applied at submit) ──

function fillFindings(raw: Static<typeof findingsSchema>): SessionFindings {
	return {
		propositions: raw.propositions,
		edges: raw.edges ?? [],
		attribution: raw.attribution ?? { quiz: {} },
	};
}

function fillNotesFindings(raw: Static<typeof notesFindingsSchema>): NotesFindings {
	return { propositions: raw.propositions, edges: raw.edges ?? [] };
}

function fillAudit(raw: Static<typeof auditSchema>): AuditResult {
	return {
		propositions: raw.propositions,
		edges: raw.edges ?? [],
		attribution: raw.attribution ?? { quiz: {} },
		dropped: raw.dropped ?? [],
	};
}

function fillNotesAudit(raw: Static<typeof notesAuditSchema>): NotesAuditResult {
	return { propositions: raw.propositions, edges: raw.edges ?? [], dropped: raw.dropped ?? [] };
}

const NOTES_EXTRACTOR_INSTRUCTIONS = `You are the extraction specialist in a learning application. You read ONE source —
the user's own NOTES, in an ARBITRARY format (personal notes, an exported conversation, a document — anything) — and
report what those notes show the author engaging with, as structured findings for their global knowledge graph.

There is no session and no chat structure here: the source is raw text, the author's own material. Read it as such.

Report, with verbatim evidence quotes for everything:

NODE THEORY — the graph is a set of TRUE propositions about the world, full stop. A node is never anything about the
author or the source. The author's relationship to a proposition is expressed ENTIRELY by your understanding note; it
never leaks into the node itself. So no "the author understands X", no "mentioned in these notes": the node is just X.
A misconception is NOT a node of its own wrong claim — state the TRUE correction as the proposition.

1. PROPOSITIONS — every distinct reasoning-step-sized proposition the notes actually engage with:
   - Each has a "name" — a VERY short label, a few words, a compact handle like a glossary headword ("Will to power",
     "Divine command theory"). Not a sentence; it becomes the node's label in the graph, so keep it glanceable.
   - And a "statement" — the self-contained TRUE proposition at full precision.
   - Notes may explain things at length or quote material the author is studying: extract the propositions themselves,
     one reasoning step each — never a topic blob, never a sub-step.
   - "messages": ALWAYS an empty list — provenance is the file itself.
   - "aliases": verbatim phrasings the notes used for the same proposition.
   - "understanding": ONE word from the fixed scale — "solid", "shaky", "accepted", "resisted", or "not yet engaged" —
     judging the AUTHOR's grasp of the proposition as the notes show it: their own commentary, self-assessments,
     recorded quiz outcomes, the way they write about it. Strictly one word, no numbers, no justification (a
     wrong-shaped note is rejected by the schema). When the notes give no signal, omit the field.

2. EDGES between propositions:
   - "follows": to is DERIVABLE from from (understanding from makes understanding to achievable).
   - "supports": from GROUNDS to without entailing it (helpful context, not a prerequisite).
   - Only relations the notes actually articulate — with evidence.

There is no quiz attribution for notes — the source has no quiz events, and the schema has no attribution field.

Evidence discipline: every quote must appear VERBATIM in the source. The auditor rejects anything unbacked. When in
doubt, report; the auditor decides.

Include EVERY top-level field of the call even when empty — "edges": [] when there are no relations. NEVER omit
a field because it is empty.

Your entire deliverable is ONE submit_findings call.`;

const EXTRACTOR_INSTRUCTIONS = `You are the extraction specialist in a learning application. You read ONE session
transcript and report what was learned — as structured findings for the learner's global knowledge graph.

The transcript view shows: the conversation verbatim (LEARNER / TEACHER lines, each tagged with its message id)
and QUIZ outcome lines.

Report, with verbatim evidence quotes for everything:

NODE THEORY — the graph is a set of TRUE propositions about the world, full stop. A node is never anything
about the learner or the session. The learner's relationship to a proposition — whether they know it, missed
it, resisted it — is expressed ENTIRELY by the quiz outcomes and your understanding note; it never leaks into
the node itself. So no "the learner understands X", no "discussed in this session": the node is just X. A
misconception is NOT a node of its own wrong claim — state the TRUE correction as the proposition, and let the
quiz outcomes carry that the learner believed the wrong version.

1. PROPOSITIONS — every distinct reasoning-step-sized proposition the session touched:
   - Each has a "name" — a VERY short label, a few words, a compact handle like a glossary headword
     ("Will to power", "Divine command theory"). Not a sentence; needn't be unique or self-contained.
     It becomes the node's label in the graph, so keep it glanceable: names are what one reads on
     the graph, statements are what one reads on the node.
   - And a "statement" — the self-contained TRUE proposition at full precision (the elaboration lives
     in the graph only as this one statement).
   - Include corrections of misconceptions the teacher articulated, and true facts explained in prose.
   - One reasoning step per proposition: never a topic blob, never a sub-step.
   - "messages": the [id] tags of every message where the proposition came up — provenance, report it.
   - "aliases": verbatim phrasings this session used for the same proposition.
   - "understanding": ONE word from the fixed scale — "solid", "shaky", "accepted", "resisted", or
     "not yet engaged" — judging the learner's grasp of the proposition in THIS session. Strictly one
     word, no numbers, no justification, no explanation (a wrong-shaped note is rejected by the schema).

2. EDGES between propositions:
   - "follows": to is DERIVABLE from from (understanding from makes understanding to achievable).
   - "supports": from GROUNDS to without entailing it (helpful context, not a prerequisite).
   - Only relations the transcript actually articulates — with evidence.

3. ATTRIBUTION — every QUIZ line gets a mapping: toolCallId → the proposition id it was really testing.
   Attribute RETROACTIVELY — a quiz often tests a proposition the session only articulates later; the
   question text is your guide. If you truly cannot tell, use null.

Evidence discipline: every quote must appear VERBATIM in the transcript view (a QUIZ line counts as the
transcript). The auditor rejects anything unbacked. When in doubt, report; the auditor decides.

Include EVERY top-level field of the call even when empty — "edges": [], "attribution": { quiz: {} } when there
are no quizzes. NEVER omit a field because it is empty.

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
}): Promise<T> {
	let submitted: T | undefined;
	const result = await runSubagent(
		[
			{
				name: opts.toolName,
				label: opts.toolName,
				description: opts.toolDescription,
				parameters: opts.parameters,
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
			maxTurns: 4,
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
		parameters: notesFindingsSchema,
		fill: fillNotesFindings,
		systemPrompt: NOTES_EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
	});
}

// ─── the auditor ───────────────────────────────────────────────────────────


const AUDITOR_INSTRUCTIONS = `You are the audit stage of a learning application's extraction pipeline. You receive
ONE source — a session transcript, or the author's personal notes in an ARBITRARY format (the notes front door) — a
set of proposed findings (propositions, edges, and quiz attribution where the source has quiz lines), and the
CURRENT knowledge graph. Your jobs: the faithfulness net, and identity.

FAITHFULNESS — verify every candidate against the source text:
- PROPOSITIONS: every evidence quote must appear (near-)verbatim in the transcript view, and the statement
  must be a faithful reading of it. The node theory applies: a statement must be a TRUE, self-contained,
  world-facing fact — reword learner- or session-relative statements ("the learner understands X" → "X"), state
  misconceptions as the true correction, or drop them when no objective fact is backed. Drop invented or
  bloated statements. Conservative: when two proposed propositions are really one, keep the better-stated one
  and drop the other.
- EDGES: the evidence must actually articulate the relation, in the direction claimed. Drop
  direction-swapped or speculative edges.
- ATTRIBUTION: the QUIZ line's question must genuinely test the attributed proposition. Drop wrong
  attributions to null, or re-point them to the proposition the question actually tests. (Session
  sources only — notes findings carry no attribution; there is nothing to verify.)
- UNDERSTANDING levels: verify against the quiz outcomes and the session's evidence — or, for notes,
  the author's own words; each note must be
  exactly one word from the fixed scale ("solid", "shaky", "accepted", "resisted", "not yet engaged") —
  reword or drop anything else. No justifications.

IDENTITY — link-or-create, per proposition:
- You see the current graph (every node: id, name, statement, aliases). For each verified proposition,
  decide: does an EXISTING node already state this same proposition?
- If yes: set "linkTo" to that node's id. The session's phrasings will join its aliases and its provenance;
  the node keeps its existing name (labels stay stable across sessions — ignore your name for linked nodes).
- If no: omit "linkTo" and a new node is created, with the extractor's name as its label. Reword only a
  clearly unglanceable name (an unwieldy sentence of a name); keep it short.
- When unsure, omit — duplicates are recoverable later; wrong merges are not.

Also drop propositions not referenced by anything else ONLY if they have no other backing — an unreferenced but
well-evidenced proposition is still knowledge.

Never invent new candidates. Your entire deliverable is ONE submit_review call containing the verified findings
(the same shapes you received, with linkTo added) plus the dropped list.

Include EVERY top-level field of the call even when empty — "edges": [], "dropped": []. NEVER omit a field
because it is empty.`;

/** The current graph, compact — the auditor's identity context. */
function graphView(nodes: GraphNode[]): string {
	if (nodes.length === 0) return "(the graph is currently empty — every proposition is a new node)";
	const lines = nodes.map(
		(n) =>
			`- ${n.id} :: ${n.name}\n  statement: ${n.statement}` +
			(n.aliases.length > 0 ? `\n  aliases: ${n.aliases.join(" | ")}` : ""),
	);
	return lines.join("\n");
}

/** The auditor over session findings (the chat front door). */
function runAuditor(
	engine: PiEngine | undefined,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<AuditResult> {
	return runSubmitAgent({
		role: "auditor",
		toolName: "submit_review",
		toolDescription: "Submit the verified findings subset (with identity verdicts) + the dropped list.",
		parameters: auditSchema,
		fill: fillAudit,
		systemPrompt: AUDITOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the auditor never submitted a review",
	});
}

/** The auditor over notes findings (the format-agnostic front door): same
 *  faithfulness + identity job, notes-mode schema (no attribution). */
function runNotesAuditor(
	engine: PiEngine | undefined,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<NotesAuditResult> {
	return runSubmitAgent({
		role: "auditor",
		toolName: "submit_review",
		toolDescription: "Submit the verified findings subset (with identity verdicts) + the dropped list.",
		parameters: notesAuditSchema,
		fill: fillNotesAudit,
		systemPrompt: AUDITOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the auditor never submitted a review",
	});
}

// ─── the pipeline status registry ─────────────────────────────────────────────

/** The pipeline phases, in order — what the home status endpoint shows.
 *  The post-batch embedding tail was its own phase (accuracy wave,
 *  2026-09-19) until wave 7 killed the embedder seam wholesale (this
 *  interlude) — birth-session clusters need no post-merge pass. The
 *  phases tell the truth about what the loop is actually waiting on. */
export type ExtractionPhase = "extracting" | "auditing" | "merging";

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
	 *  same source identity (mappings + events dedupe by it). */
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

	async function extract(chatId: string, view: string): Promise<SessionFindings> {
		const signal = runningExtractions.get(chatId)?.controller.signal;
		signal?.throwIfAborted(); // an abort during a sync gap ends the run here
		console.info(`[extraction ${chatId}] extractor starting (${view.split("\n").length} transcript lines)`);
		const t0 = performance.now();

		const findings = await runExtractor(
			stageEngine("extractor", deps.extractor),
			`Transcript:\n\n${view}`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(chatId, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${chatId}] extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	async function audit(chatId: string, findings: SessionFindings, view: string): Promise<AuditResult> {
		const signal = runningExtractions.get(chatId)?.controller.signal;
		signal?.throwIfAborted(); // an abort during the extract→audit gap ends here
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${chatId}] auditor starting (${findings.propositions.length} propositions, ${findings.edges.length} edges, ` +
				`${Object.keys(findings.attribution.quiz).length} attributions, ${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();

		const auditResult = await runAuditor(
			stageEngine("auditor", deps.auditor),
			`Transcript:\n\n${view}\n\nProposed findings:\n\n${JSON.stringify(findings, null, 2)}\n\n` +
				`Current knowledge graph (${graph.nodes.length} nodes):\n\n${graphView(graph.nodes)}`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(chatId, "auditor", callUsage(usage), model);
				console.info(`[extraction] auditor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		if (auditResult.dropped.length > 0) {
			console.info(
				`[extraction ${chatId}] audit dropped ${auditResult.dropped.length}: ` +
					auditResult.dropped.map((d) => `${d.ref} (${d.reason})`).join("; "),
			);
		}
		console.info(
			`[extraction ${chatId}] audit kept ${auditResult.propositions.length}/${findings.propositions.length} propositions, ` +
				`${auditResult.edges.length}/${findings.edges.length} edges, ` +
				`${auditResult.propositions.filter((p) => p.linkTo !== undefined).length} linked to existing nodes`,
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
		if (inFlight.has(chatId)) return { nodes: 0, edges: 0, events: 0 };
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
		const total: EmissionStats = { nodes: 0, edges: 0, events: 0 };
		try {
			const record = chatStore.getChat(chatId);
			if (!record) throw new Error(`Chat not found: ${chatId}`);
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): the write channel needs extractor + auditor
			// engines AND their providers' keys; a refusal lands BEFORE any
			// stage runs (typed — the trigger skips, routes surface 503).
			refuseIfStagesUnready();
			const projected = projectNative(record.messages);
			const covered = coverageOf(projected, graphStore.readCoverage(), chatId);
			if (covered.uncovered.length === 0) {
				console.info(`[extraction ${chatId}] nothing uncovered — no-op`);
				return { nodes: 0, edges: 0, events: 0 };
			}
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			const batches = batchRuns(covered.uncovered, chunkTokens);
			console.info(
				`[extraction ${chatId}] pipeline start — ${covered.uncoveredTokens} uncovered tok, ` +
					`${covered.uncoveredCount} messages, ${batches.length} batch(es) of ≤${chunkTokens} tok`,
			);
			for (const batch of batches) {
				// The batch's prompt view: SESSION header + the batch's lines,
				// same provenance [id] tags the fingerprints used (coverage
				// and prompt share ONE line builder — core/coverage.ts).
				const mids = projected.map((m, i) => (m.id || `m${i}`) as string);
				const view = [
					`SESSION: ${record.title}`,
					...batch.flatMap((slot) => {
						const idx = projected.indexOf(slot.message);
						return messageViewLines(slot.message, mids[idx] ?? slot.message.id);
					}),
				].join("\n");
				setPhase(chatId, "extracting", "chat");
				const findings = await extract(chatId, view);
				setPhase(chatId, "auditing", "chat");
				const auditResult = await audit(chatId, findings, view);
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
				const stats = mergeFindings(chatId, auditResult, { chatStore, graphStore }, {
					messages: batch.map((slot) => slot.message),
					foldedAt,
					coverage: batch.map((slot) => ({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt })),
					batchTag: batchTag(batch),
				});
				total.nodes += stats.nodes;
				total.edges += stats.edges;
				total.events += stats.events;
				batchesDone++;
				console.info(
					`[extraction ${chatId}] batch ${batchesDone}/${batches.length} merged: ` +
						`${stats.nodes} nodes, ${stats.edges} edges, ${stats.events} events`,
				);
			}
			const stats = total;
			// Option A: the layout ledger evolves with the merge (sync — the
			// next snapshot fetch must already reflect the new nodes).
			settleGraphLayout(graphStore);
			persistRunUsage(chatId, Math.round(performance.now() - t0), stats);
			console.info(
				`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.events} events ` +
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
	function notesView(input: { filePath: string; text: string }): string {
		return `SOURCE (the author's personal notes): ${input.filePath}\n\n${input.text}`;
	}

	async function notesExtract(input: { id: string; filePath: string; text: string }): Promise<NotesFindings> {
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

	async function notesAudit(input: { id: string; filePath: string; text: string }, findings: NotesFindings): Promise<NotesAuditResult> {
		const signal = runningExtractions.get(input.id)?.controller.signal;
		signal?.throwIfAborted(); // an abort during the extract→audit gap ends here
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${input.id}] notes auditor starting (${findings.propositions.length} propositions, ` +
				`${findings.edges.length} edges, ${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();
		const auditResult = await runNotesAuditor(
			stageEngine("auditor", deps.auditor),
			`Source:\n\n${notesView(input)}\n\nProposed findings:\n\n${JSON.stringify(findings, null, 2)}\n\n` +
				`Current knowledge graph (${graph.nodes.length} nodes):\n\n${graphView(graph.nodes)}`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(input.id, "auditor", callUsage(usage), model);
				console.info(`[extraction] auditor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		if (auditResult.dropped.length > 0) {
			console.info(
				`[extraction ${input.id}] audit dropped ${auditResult.dropped.length}: ` +
					auditResult.dropped.map((d) => `${d.ref} (${d.reason})`).join("; "),
			);
		}
		console.info(
			`[extraction ${input.id}] audit kept ${auditResult.propositions.length}/${findings.propositions.length} propositions, ` +
				`${auditResult.propositions.filter((p) => p.linkTo !== undefined).length} linked to existing nodes`,
		);
		console.info(`[extraction ${input.id}] notes auditor done in ${Math.round(performance.now() - t0)}ms`);
		return auditResult;
	}

	async function runNotesExtraction(input: { id: string; filePath: string; text: string; importedAt: string }): Promise<EmissionStats> {
		const { id } = input;
		if (inFlight.has(id)) return { nodes: 0, edges: 0, events: 0 };
		inFlight.add(id);
		const t0 = performance.now();
		try {
			// BYOK per-need gate (owner, 2026-09-22) + key presence
			// (2026-09-25): same refusal as the chat front door — no
			// extractor/auditor engines, or a stage key gone, no run.
			refuseIfStagesUnready();
			console.info(`[extraction ${id}] notes pipeline start (${input.filePath})`);
			setPhase(id, "extracting", "notes", input.filePath);
			const findings = await notesExtract(input);
			setPhase(id, "auditing", "notes", input.filePath);
			const notesResult = await notesAudit(input, findings);
			setPhase(id, "merging", "notes", input.filePath);
			// Normalize to the merger's findings shape: notes carry no quiz
			// attribution, and the merger scans no quiz parts for notes
			// (messages: null) — nothing to attribute, nothing to build.
			const auditResult: AuditResult = { ...notesResult, attribution: { quiz: {} } };
			const stats = mergeFindings(id, auditResult, { chatStore, graphStore }, { messages: null, foldedAt: input.importedAt });
			// Same post-merge settle as the chat path.
			settleGraphLayout(graphStore);
			persistRunUsage(id, Math.round(performance.now() - t0), stats);
			console.info(
				`[extraction ${id}] merged: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.events} events ` +
					`(${Math.round(performance.now() - t0)}ms total)`,
			);
			return stats;
		} catch (err) {
			persistRunUsage(id, Math.round(performance.now() - t0), undefined);
			if (err instanceof Error && err.name === "AbortError") {
				console.info(`[extraction ${id}] aborted (${Math.round(performance.now() - t0)}ms) — nothing merged, nothing checkpointed`);
				return { nodes: 0, edges: 0, events: 0 };
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

