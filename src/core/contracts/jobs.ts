/**
 * Sub-agent job contracts — the async ack-and-steer protocol
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
import type { UIMessage } from "ai";

// ─── Async sub-agent jobs (vision §2.5; plan.md Wave 0 protocol) ────────────

export type JobKind = "research" | "demo" | "visual";
export type JobStatus = "running" | "done" | "error";

export interface JobRecord {
	id: string;
	kind: JobKind;
	chatId: string;
	/** The tool part this job fulfills. */
	toolCallId: string;
	status: JobStatus;
	/** Latest human-readable activity line, e.g. `web_search: "sigma.js v3"`. */
	activity: string;
	createdAt: string;
	updatedAt: string;
	/** The sub-agent's result (steer-artifact payload). */
	result?: unknown;
	error?: string;
	/** Money channel (observability, 2026-09): accumulated token usage of
	 * the sub-agent's run, written by the runner as steps complete. Cost is
	 * inferred at read time (core/prices.ts). Absent on pre-2026-09 jobs and
	 * until the runner's capture lands — renderers show "—", never zero. */
	usage?: JobUsage;
}

/** A sub-agent run's accumulated usage — the same accounting shape as a
 * chat turn (contracts/chat.ts CallUsage), flattened to one running total
 * plus a step count. */
export interface JobUsage {
	/** The OpenRouter model id that ran the sub-agent. */
	model: string;
	/** Running totals summed over the run's model calls so far. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	/** How many model calls the run has made (each bills separately). */
	steps: number;
}

/**
 * THE ASYNC PROTOCOL — "ack now, steer later" (the pi sub-agents model,
 * vision §2.5):
 *
 *  1. Job tools (research / demo / visual) are SERVER-EXECUTED. The model
 *     calls one MID-TURN; execute creates the job record, fires the
 *     background runner, and resolves IMMEDIATELY with an acknowledgement
 *     ("dispatched — continue your turn"). The teacher's turn does NOT end
 *     at the call: it keeps teaching, may dispatch other independent jobs
 *     (full parallelism), and ends whenever it ends. The tool part's output
 *     is the ack, forever.
 *
 *  2. The background runner (src/agent/subagents/runner.ts) runs the kind's
 *     sub-agent loop — isolated context, modelFor(role), the
 *     verify-never-one-shot doctrine (headless-tested demos, looked-at SVGs,
 *     sourced briefs) — tracking a live activity line in the job record.
 *     ONE central client poll of GET /api/jobs?chatId=… (in Chat) drives every
 *     job surface: the transcript dispatch cards (live activity by
 *     toolCallId, quiet one-liner after delivery), the sub-agents sidebar
 *     panel, and the single re-sync when a job settles.
 *
 *  3. On completion the runner builds a STEER MESSAGE (buildSubagentSteer)
 *     and hands it to the wake pipeline (src/server/jobs.ts): a user-role
 *     UIMessage carrying the result — a text part with what the MODEL needs
 *     (the research brief, the builder's notes), plus a data-subagent-artifact
 *     part with what the UI renders (the full result: brief + sources /
 *     SVG / demo HTML). Provider conversion drops data parts, so artifact
 *     payloads never enter the teacher's context. metadata.subagentResult
 *     identifies the job; the UI renders these as sub-agent result cards,
 *     NEVER as learner interjections.
 *
 *  4. The wake pipeline delivers the steer by firing a SERVER-SIDE teacher
 *     turn through the same turn composition as a client request
 *     (handleChatRequest) — write-ahead persist, turn liveness, extraction
 *     trigger: one code path. A per-chat serialized queue: a steer waits
 *     while a turn is in flight OR a question tool part is pending (an
 *     unanswered client-side tool call breaks provider conversion — the
 *     steer fires right after the learner's continuation), then fires; a 409
 *     (a client turn raced in) retries. Delivery is idempotent per jobId, so
 *     a crashed wake can be re-entered by the stale-job recovery sweep. The
 *     job's status flips to done/error only AFTER the wake turn completes —
 *     a polling client that sees the flip re-syncs once and gets the
 *     finished record.
 *
 *     CONTINUATION COALESCING: the idle window above can starve — a
 *     quiz-chaining teacher ends every turn with a new pending check, so
 *     the gates never stay open long enough for a wake to fire. The fix:
 *     when a client turn wins the turn registry, the handler CLAIMS every
 *     queued, undelivered steer (jobs.ts claimSteers) and appends it after
 *     the learner's answer in that very turn — conversion-safe, because the
 *     answered quiz carries its output. Every answer flushes pending
 *     steers immediately; the wake pump remains for turns that end with no
 *     pending question. The pump re-checks steerDelivered right before
 *     firing, so a claim racing the pump converges to exactly one delivery.
 *
 *  5. No pending job parts ever exist, so the composer never gates on jobs
 *     (the learner can interject mid-job; the steer queues behind their
 *     turn) and job tool outputs never trigger the client-side
 *     sendAutomatically continuation — that mechanism stays quiz/ask-only.
 */

export interface ResearchToolInput {
	question: string;
	/** What the teacher needs it for — focuses the research brief. */
	context?: string;
}

export interface ResearchResult {
	brief: string;
	sources: { title: string; url: string }[];
}

export interface DemoToolInput {
	title: string;
	/** Precise brief: concept, parameters/interactions, visual style. */
	brief: string;
}

export interface DemoResult {
	title: string;
	/** Self-contained single-file HTML/JS document (sandboxed-iframe ready). */
	html: string;
	/** The builder sub-agent headlessly executed the demo before delivery. */
	tested: true;
	notes?: string;
}

export interface VisualToolInput {
	/** Precise brief for ONE visual (what it must show, exactly). */
	brief: string;
}

export interface VisualResult {
	/** Complete SVG markup (verified by the maker looking at the render). */
	svg: string;
	notes?: string;
}

// ─── Sub-agent steer messages (THE ASYNC PROTOCOL §3–4) ─────────────────────

/** Message metadata marking a sub-agent steer (contracts.ts §3). */
export interface SubagentResultMeta {
	jobId: string;
	kind: JobKind;
	toolCallId: string;
}

/** The data-subagent-artifact part payload: what the UI renders. */
export interface SubagentArtifactData {
	kind: JobKind;
	result: ResearchResult | DemoResult | VisualResult;
}

/**
 * The steer message: user-role on the wire (UIMessage roles are fixed), but
 * NEVER a learner interjection — metadata.subagentResult is the marker the
 * UI branches on, and the artifact rides the data part (stripped by provider
 * conversion, so the model sees only the text part).
 */
export interface SubagentSteerMessage extends UIMessage {
	role: "user";
	metadata: { subagentResult: SubagentResultMeta };
	parts: [
		{ type: "text"; text: string },
		{ type: "data-subagent-artifact"; data: SubagentArtifactData },
	];
}

/** Whether a result is the failure shape (html/svg empty, failure brief). */
export function isSubagentFailure(kind: JobKind, result: ResearchResult | DemoResult | VisualResult): boolean {
	if (kind === "research") {
		const r = result as ResearchResult;
		return r.sources.length === 0 && /^Research failed:/i.test(r.brief);
	}
	if (kind === "demo") {
		const r = result as DemoResult;
		return typeof r.html !== "string" || r.html.length === 0;
	}
	const r = result as VisualResult;
	return typeof r.svg !== "string" || r.svg.length === 0;
}

/** The model-facing text of a steer: what the result IS, what to do with it. */
function steerText(kind: JobKind, result: ResearchResult | DemoResult | VisualResult): string {
	if (isSubagentFailure(kind, result)) {
		if (kind === "research")
			return `${(result as ResearchResult).brief}\n\nContinue with what you can establish and flag the uncertainty to the learner.`;
		if (kind === "demo")
			return `The demo "${(result as DemoResult).title}" could not be built: ${
				(result as DemoResult).notes ?? "unknown reason"
			}. Fall back to explaining in prose; if the brief was the problem, re-call demo with a tighter one.`;
		return `The figure could not be made: ${(result as VisualResult).notes ?? "unknown reason"}. Fall back to prose or mermaid, or re-call visual with a tighter brief.`;
	}
	if (kind === "research")
		return `Research complete — the researcher's full brief follows. Weave it into the lesson and cite its sources when you use its findings:\n\n${(result as ResearchResult).brief}`;
	if (kind === "demo")
		return `The demo "${(result as DemoResult).title}" is built, headlessly tested, and rendered in the lesson. Builder notes: ${
			(result as DemoResult).notes ?? "(none)"
		}.\nTeach with it — reference its controls by name and point the learner at what to try.`;
	return `The figure is drawn, verified by inspection, and rendered in the lesson. Maker notes: ${
		(result as VisualResult).notes ?? "(none)"
	}.\nReference its elements as you teach.`;
}

/**
 * Build the steer message for a finished job (pure — shared by the runner,
 * the wake pipeline, and tests). Deterministic id per job makes re-delivery
 * idempotent.
 */
export function buildSubagentSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
	result: ResearchResult | DemoResult | VisualResult,
): SubagentSteerMessage {
	return {
		id: `steer_${job.id}`,
		role: "user",
		metadata: { subagentResult: { jobId: job.id, kind: job.kind, toolCallId: job.toolCallId } },
		parts: [
			{ type: "text", text: steerText(job.kind, result) },
			{ type: "data-subagent-artifact", data: { kind: job.kind, result } },
		],
	};
}

/** True when the transcript already carries this job's steer (idempotent delivery). */
export function steerDelivered(messages: UIMessage[], jobId: string): boolean {
	return messages.some(
		(m) => (m.metadata as { subagentResult?: { jobId?: string } } | undefined)?.subagentResult?.jobId === jobId,
	);
}

