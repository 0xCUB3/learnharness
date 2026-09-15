/**
 * Chat-session contracts — records, summaries, UI extension points
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
import type { UIMessage } from "ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Phase3 } from "../phases.ts";
import type { PlanNodeStatus, PlanTree } from "./plan.ts";
import type { EmissionStats, UnderstandingLevel } from "./graph.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** One persisted session: data/chats/<id>.json. The stored messages are full
 * AI SDK UIMessages (parts included) — the canonical session record: a
 * pending quiz is a tool part in `input-available` state, which is exactly
 * what makes resume-mid-question free. */
export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: UIMessage[];
	/** The session's plan tree (vision §2) — written by plan tools via saveTree. */
	tree?: PlanTree;
	/** Append-only usage log (observability, 2026-09): one entry per model
	 * turn. DELIBERATELY a parallel log, not per-message metadata — the client
	 * re-POSTs its message list every turn and its copies never carry
	 * server-stamped fields, so anything inside message objects gets clobbered
	 * by the next persist. Keyed by messageId so the transcript view can fold
	 * each entry onto its message; aggregates are folds over this log
	 * (core/prices.ts). */
	turns?: TurnUsage[];
	/** Append-only background-extraction usage log (2026-09 observability):
	 *  one entry per finished pipeline run on THIS chat — extraction is real
	 *  spend too. Same parallel-log discipline as `turns` (nothing rides
	 *  inside messages). Keyed by startedAt; idempotent appends. */
	extractions?: ExtractionRunUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
}

/** The conversation agents' runtime model choice (model-control wave,
 *  2026-09-12): a per-chat override of config.ts's pinned prober/teacher
 *  spec. Absent fields fall back to config; written by the model picker
 *  (PUT /api/chats/[id]/settings) and read at turn composition — the
 *  agents are stateless per turn, so a change takes effect on the next
 *  turn by construction. Background sub-agents are NEVER overridden
 *  (config-pinned: they're infrastructure, not conversation). */
export interface ChatSettings {
	/** pi-ai catalog coordinates: the provider that owns the model. Only
	 *  "openrouter" is configured today; the field exists so a second
	 *  provider needs no schema change. */
	model?: { provider: string; id: string };
	/** pi thinking level — must be in the chosen model's supported list
	 *  (getSupportedThinkingLevels; enforced by the settings route). */
	thinkingLevel?: ThinkingLevel;
	/** Graph context injection (vision-context-injection.md): the session's
	 *  token budget for the prior-knowledge block — the top semantically
	 *  closest propositions from the knowledge graph, injected once, at
	 *  session start, as a steer. Absent = the default (on); 0 = off. The
	 *  settings route enforces the range; the trigger (turn-service →
	 *  subagents/graph-context.ts) is one-shot, so a mid-session change
	 *  affects only sessions that haven't injected yet. */
	graphContextTokens?: number;
}

/** The injection budget's decided knobs (2026-09-14; scale revised
 *  2026-09-15, owner): default 1024 (a meaningful, modest slice of prior
 *  knowledge), hard max 16384, 0 = off. The UI is a DISCRETE slider over
 *  these stops — powers of four from 64 (the fine-grained low end was
 *  theater: a 128-token budget is ~2 propositions, nobody wants that
 *  dial); the server still accepts any integer in range (a stale client
 *  can't brick settings), the stops only govern what the slider sends. */
export const GRAPH_CONTEXT_TOKENS_DEFAULT = 1024;
export const GRAPH_CONTEXT_TOKENS_MAX = 16384;
/** The slider's positions, left to right: off, then powers of four. */
export const GRAPH_CONTEXT_TOKENS_STOPS = [0, 64, 256, 1024, 4096, 16384] as const;

// ─── Background-extraction usage (the money channel, extraction side) ────────

/** One pipeline stage's model usage — the stage's model + every step it
 *  billed (CallUsage per agent step). Steps, not a sum: cost and context
 *  folds happen at read time (core/prices.ts). */
export interface ExtractionStageUsage {
	/** The OpenRouter model id that ran this stage. */
	model: string;
	steps: CallUsage[];
}

/** One finished (or failed mid-flight) extraction run's usage record.
 *  Appended to the chat's `extractions` log when the run ends — success or
 *  failure, because money was spent either way; `stats` is present only
 *  when the merger actually ran. */
export interface ExtractionRunUsage {
	/** The run's registry startedAt (ms) — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	/** What the run merged into the graph; absent when it failed first. */
	stats?: EmissionStats;
	/** Model usage per stage, in pipeline order (merger is deterministic —
	 *  no model call, no entry). */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

// ─── Usage accounting (the money channel) ─────────────────────────────────────

/** One model call's token accounting — the SDK's LanguageModelUsage
 * flattened to the fields we persist (undefined = provider didn't report;
 * renderers show absent, never zero). */
export interface CallUsage {
	/** Total input (prompt) tokens, cached portion included. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call (OpenRouter bills writes
	 * for some providers; undefined = not reported/not billed). */
	cacheWriteTokens: number | undefined;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** One billing turn: one full invocation of the teacher (a client turn or a
 * wake turn — same handler, same log). A turn with tool calls spans several
 * agent steps, and each step bills separately. Capture lands at the persist
 * seam (server); cost is INFERRED at read time from core/prices.ts. */
export interface TurnUsage {
	/** Unique per REQUEST (turn): one invocation of the handler — the
	 *  idempotency key for the append-only log. Continuation turns share a
	 *  response message id (the SDK coalesces them); keying on messageId
	 *  would swallow their usage. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this
	 *  entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The OpenRouter model id that ran the turn. */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: CallUsage[];
}

// ─── Plan blocks (the plan lives in the chat) ────────────────────────────────

/** Payload of the persisted `data-plan-block` UI part (2026-09 design): a
 * SNAPSHOT of the plan at the moment it changed, rendered as a block in the
 * chat flow. Attached to the assistant message that carries the plan_init
 * tool call (kind "full") or the answered check quiz part (kind
 * "neighborhood"). Data parts never reach the model (convertToModelMessages
 * drops them) — the block is pure UI history, reappearing identically on
 * reload because it lives in the record.
 *
 * Rendering contract: a "full" block renders the whole DAG borderless,
 * horizontally filling the chat column, natural height; a "neighborhood"
 * block renders current node + direct parents + direct children in its own
 * small container, the current node glowing — clearly a fragment, not the
 * whole plan. Clicking either opens the full plan in a popup. */
/** The learner's plan verdict (docs/probe-teach-split.md §4): a data part
 *  riding its own user message — the ONLY thing on that message. It is THE
 *  plan→teach phase seam (phaseAt3 reads accepted from the transcript), and
 *  both verdicts are real transcript events: accept sanctions teaching,
 *  decline asks for revision. The part is the message TYPE (the "custom
 *  message" scheme, 2026-09-12): the message carries no human-authored text,
 *  the model-facing wording is owned by the adapter (record-adapter.ts
 *  flattens it to VERDICT_TEXT below), and the UI renders the verdict
 *  marker — never a user bubble. A learner who also typed a note sends the
 *  note as its own real user message first; the verdict message follows. */
export interface PlanVerdictData {
	/** true = accept (sanction to teach); false = decline (revise the plan). */
	accepted: boolean;
	/** ISO timestamp of the click. */
	at: string;
}

/** The model-facing text of a verdict message — single-sourced here so the
 *  adapter, the tests, and reality can't drift apart. */
export function verdictText(accepted: boolean): string {
	return accepted
		? "The learner accepted the plan — begin teaching."
		: "The learner would like the plan revised before teaching begins.";
}

/** The model-facing text of the probe→teach handoff wake (the custom-message
 *  scheme): the wake message carries only the data-probe-handoff part, and
 *  the adapter flattens it to THIS. Single-sourced so the prober's seam, the
 *  tests, and reality can't drift apart. */
export const HANDOFF_TEXT =
	"The probe is concluded — the learner assessment is recorded. " +
	"Author the session's plan map now (call plan_init) and present it, then begin teaching.";

// ─── Graph context injection (vision-context-injection.md, 2026-09-14) ────────

/** One selected prior-knowledge proposition: similarity-ranked, annotated
 *  with the learner's CURRENT understanding level — the fold is MOST
 *  RECENT extraction instance (levels are per-instance, tied to moments in
 *  time; the latest evidence is the best estimate of current understanding).
 *  null = the node has no observation event at all. */
export interface GraphContextProposition {
	id: string;
	statement: string;
	level: UnderstandingLevel | null;
}

/** The data-graph-context part payload: what the UI renders (the counts)
 *  AND the audit trail (the full block content — the transcript shows
 *  exactly what was injected, and when). The model-facing text is derived
 *  from this by graphContextText below — the adapter flattens the marker
 *  part to it (the custom-message scheme: no authored human speech). */
export interface GraphContextData {
	chatId: string;
	/** The session's budget at injection time (for the card's readout). */
	budget: number;
	/** Estimated tokens of the injected block — chars/4 heuristic. */
	tokens: number;
	/** The selected propositions, similarity-descending. */
	propositions: GraphContextProposition[];
}

/** The model-facing block text — single-sourced (the adapter, the tests,
 *  and reality can't drift). The level word travels with each line: the
 *  closing gloss tells the agent what to do with each. */
export function graphContextText(data: GraphContextData): string {
	const n = data.propositions.length;
	if (n === 0) return "";
	const lines = data.propositions.map(
		(p) => `- ${p.level ? `[${p.level}] ` : ""}${p.statement}`,
	);
	return [
		`Prior-knowledge context — what this learner already knows (from their knowledge graph, ` +
			`${n} proposition${n === 1 ? "" : "s"}, ~${data.tokens} tokens):`,
		"",
		...lines,
		"",
		"Treat this as reliable prior knowledge: build on what is solid, firm up what is shaky, " +
			"and teach around anything resisted. Do not re-teach solid ground.",
	].join("\n");
}

export interface PlanBlockData {
	/** Only "full" survives (the 2026-09-11 pivot): the plan renders IN
	 *  FLOW once, at authoring. The neighborhood fragments are retired —
	 *  position derives live from the transcript (the persistent DAG
	 *  window is the successor). */
	kind: "full";
	at: string;
	/** The current node at snapshot time (the glow target; null = none). */
	current: string | null;
	/** All nodes of the authored tree. Statuses are the snapshot's,
	 * derived at emission time — the block never re-derives at render. */
	nodes: Array<{ id: string; title: string; status: PlanNodeStatus }>;
	edges: Array<{ from: string; to: string }>;
}

/** The list view's shape (messageCount instead of full messages) + the
 *  per-session status the picker renders. `phase` and `pendingQuestion`
 *  derive from the stored record (tree + messages); the store computes
 *  them in listChats. Liveness (`busy`) is NOT record-derived — the API
 *  route merges it in (see ChatListItem).
 *
 *  Phase semantics (three phases, event-driven — docs/probe-teach-split.md
 *  §4): probe ends at the concluded probe_done, plan ends at the successful
 *  plan_init; derived from the transcript (core/phases.ts phaseAt3).
 */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** The session's current phase, derived from the stored plan tree. */
	phase: Phase3;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** The record's model-control settings — rides the list payload via the
	 *  summary spread (the picker never needs it from here; the full record
	 *  is its source). */
	settings?: ChatSettings;
}

/** The sidebar's session row: a summary + live liveness. The chats list
 *  route attaches `busy` from the turn-liveness registry ONLY — a running
 *  teach turn (owner, minimal-color round: background jobs no longer
 *  count; the sidebar's Background agents section is their channel, and
 *  the row spinner means exactly "a turn is in flight"). The store itself
 *  can't see liveness (import law: store never imports server), hence the
 *  split at exactly the record/liveness seam. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/**
 * components/chat.tsx renders any tool part it doesn't specially handle via
 * components/artifacts/index.ts's registry, keyed by tool name ("research",
 * "demo", "visual", …). Workers add renderers there — chat.tsx is off-limits
 * to artifact work. Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
	};
}
