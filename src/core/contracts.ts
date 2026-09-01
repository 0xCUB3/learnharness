/**
 * Shared contracts — the single source of truth every component codes against.
 * Pure types + protocol docs + tiny pure helpers; type-only imports of "ai"
 * (safe everywhere: server, client, tests). See docs/vision.md (§ refs).
 */

import type { UIMessage } from "ai";

// ─── Plan tree (vision §2 "formal plan tree") ────────────────────────────────
// A session-scoped dependency tree authored by the teacher via plan tools.
// One substrate with the global graph: tree nodes fold into graph nodes.

export interface PlanNode {
	/** Opaque, agent-chosen slug, stable across edits: "chain-rule-intuition". */
	id: string;
	/** Short label for the tree panel. */
	title: string;
	/** 1-2 sentences: what this node covers. */
	summary?: string;
}

export interface PlanEdge {
	/** Prerequisite node id. */
	from: string;
	/** Node that depends on `from`. */
	to: string;
}

export interface PlanTree {
	nodes: PlanNode[];
	edges: PlanEdge[];
	currentNodeId: string | null;
	doneNodeIds: string[];
	/** Increments on every mutation — lets the UI animate/react to changes. */
	version: number;
}

/** Derived, never stored: status of a node for the panel (vision §2). */
export type PlanNodeStatus = "done" | "current" | "upcoming";

export function planNodeStatus(tree: PlanTree, nodeId: string): PlanNodeStatus {
	if (tree.currentNodeId === nodeId) return "current";
	if (tree.doneNodeIds.includes(nodeId)) return "done";
	return "upcoming";
}

/**
 * Plan tools (W1 implements; server-side WITH execute, mutate the chat's
 * stored tree, and return the full updated tree so the panel can render the
 * latest state straight from the stream). Every tool returns PlanToolResult.
 * Tool names: plan_init, plan_add_node, plan_update_node, plan_remove_node,
 * plan_add_edge, plan_remove_edge, plan_set_current, plan_mark_done.
 * The tree panel derives its display from the LATEST plan tool output in the
 * transcript (live during streaming) — no separate state channel.
 */
export interface PlanToolResult {
	ok: boolean;
	error?: string;
	tree: PlanTree;
}

// ─── Knowledge graph (vision §1 — global, cross-session) ────────────────────

export type EdgeType = "requires" | "supports";

export interface GraphNode {
	/** Opaque stable id, store-assigned: "n_" + nanoid-like. */
	id: string;
	/** Short name / header for the fact (2-6 words) — the rendering handle.
	 *  NODE THEORY: a node is an OBJECTIVE fact, never learner- or
	 *  session-relative. No "the learner understands…", no "this session
	 *  covered…" — just the fact, world-facing. The learner's relationship
	 *  to the fact lives ENTIRELY in the event ledger: state labels are
	 *  derived from quiz outcomes, never written into the node. */
	name: string;
	/** Canonical proposition statement — the full fact, one reasoning step,
	 *  also objective (no learner / teacher / session references). */
	statement: string;
	/** Verbatim alternate statements from sessions (merge target audit trail). */
	aliases: string[];
	kind: "truth" | "misconception";
	createdAt: string;
}

export interface GraphEdge {
	/** Prerequisite GraphNode id. */
	from: string;
	to: string;
	type: EdgeType;
	/** Chat ids that asserted this edge (teacher may simplify — auditable). */
	provenance: string[];
}

/** mappings.jsonl line — the session→graph identity map: the extraction
 *  pipeline's proposition (identified by its source id) → the graph node it
 *  merged into. The merge audit trail: one line per (chat, graph node). */
export interface NodeMapping {
	chatId: string;
	/** The writer's local id for the proposition — a plan-tree node id when
	 *  tree-derived, else the extractor's proposition id ("p1", …). */
	sourceId: string;
	graphNodeId: string;
}

/** sessions.jsonl line — the emission checkpoint for one chat (which chats
 *  have been folded, and through which updatedAt — never fold twice). */
export interface SessionCheckpoint {
	chatId: string;
	/** The chat record's `updatedAt` at the time of the fold. */
	foldedAt: string;
}

export type LedgerEventKind =
	| "probe-correct"
	| "probe-miss"
	| "dont-know"
	| "misconception-signaled"
	| "taught"
	| "check-correct"
	| "check-incorrect";

export interface LedgerEvent {
	/** null = not yet attributed (untagged probe events; consolidation assigns). */
	nodeId: string | null;
	kind: LedgerEventKind;
	chatId: string;
	at: string;
	/** Idempotency key: the quiz part's toolCallId or `taught:<treeNodeId>` —
	 * re-emission of the same chat must never double-record an event. */
	ref?: string;
	/** The learner's quiz note — diagnostic gold (vision §1 calibration). */
	note?: string;
	/** The quiz question text, when nodeId is null (later attribution input). */
	question?: string;
}

/**
 * Store format (src/store/graph.ts): JSONL ledgers at config.LEDGER_FILES
 * (nodes/edges/events/mappings/sessions). The derived graph is rebuilt by
 * reading the ledgers — store events, derive state. sessions.jsonl is the
 * extraction checkpoint: which chats the extraction pipeline has processed,
 * and through which updatedAt (never extract the same turns twice).
 *
 * The EXTRACTION PIPELINE is the sole graph writer (extractor → auditor →
 * merger): the extractor proposes propositions/edges/attribution with
 * verbatim evidence, the auditor drops anything unbacked, and the merger
 * (core/graph.ts, deterministic) resolves identity against the existing
 * ledgers and appends. See SessionFindings below.
 */

// ─── Extraction findings (extractor output → audit → merger input) ───────────

/** One proposed proposition — a node candidate. */
export interface ExtractedProposition {
	/** Extractor-local id ("p1", …) referenced by edges + attribution. */
	id: string;
	/** Short name / header for the fact (2-6 words) — the rendering handle. */
	name: string;
	/** Canonical one-reasoning-step statement — an objective, world-facing
	 *  fact (no learner / teacher / session references; the learner's
	 *  relationship to it is carried only by the event attribution). */
	statement: string;
	/** Verbatim alternate phrasings from the session (merge aliases). */
	aliases: string[];
	kind: "truth" | "misconception";
	/** The plan-tree node this came from, when it did (mapping provenance). */
	treeNodeId?: string;
	/** Verbatim transcript quotes backing the proposition. */
	evidence: string[];
}

/** One proposed relation between two propositions. */
export interface ExtractedEdge {
	/** Proposition id that is the prerequisite / support. */
	from: string;
	/** Proposition id that depends on / is supported by `from`. */
	to: string;
	type: EdgeType;
	/** Verbatim transcript quotes backing the relation. */
	evidence: string[];
}

/** The extractor's event attribution — its ONLY say about events. The kinds,
 * timestamps, idempotency refs, notes and question texts are all rebuilt
 * deterministically by the merger from the transcript's quiz / mark_done
 * tool parts; the LLM supplies exactly the judgment call: WHICH proposition
 * each one is about (vision open question: probes attribute retroactively,
 * against the whole transcript — a pre-tree probe can map to a proposition
 * the tree only articulates later). */
/** The extractor's event attribution — its ONLY say about events. Event
 *  kinds, timestamps, idempotency refs, notes and question texts are all
 *  rebuilt deterministically by the merger from the transcript's tool
 *  parts, and TAGGED events (quiz nodeId, mark_done tree node) resolve
 *  deterministically through the proposition mapping. The LLM supplies
 *  exactly the one judgment call that needs it — the vision's open
 *  probe-attribution question: WHICH proposition did an UNTAGGED probe
 *  test? Answered retroactively against the whole transcript — a pre-tree
 *  probe can map to a proposition the tree only articulates later. */
export interface ExtractionAttribution {
	/** UNTAGGED quiz toolCallId → proposition id; missing / null =
	 *  unattributed (the event lands with nodeId null + the question text,
	 *  exactly like unattributable probes always did). */
	quiz: Record<string, string | null>;
}

/** The extractor's — and, filtered, the auditor's — output shape. */
export interface SessionFindings {
	propositions: ExtractedProposition[];
	edges: ExtractedEdge[];
	attribution: ExtractionAttribution;
}

/** The auditor's verdict: the verified subset, plus the drops (for the log —
 *  the audit trail of what was rejected and why). */
export interface AuditResult extends SessionFindings {
	/** Dropped candidates: proposition id, edge "from→to", or attribution
	 *  toolCallId — with the reason. */
	dropped: { ref: string; reason: string }[];
}

/** Per-node state class for the home view (vision §1 "Home page") — derived,
 * never stored: taught if ANY taught event; else the LATEST quiz event decides
 * (known / missed / dont-know); a node with no events is a candidate. */
export type NodeStateClass = "taught" | "known" | "missed" | "dont-know" | "candidate";

/** The GET /api/graph payload — everything the home view's PURE renderer needs. */
export interface GraphSnapshot {
	nodes: GraphNode[];
	edges: GraphEdge[];
	nodeStates: Record<string, NodeStateClass>;
	/** chatId → title, for every chat that touched the graph. */
	sessions: Record<string, string>;
	/** nodeId → chatIds that touched the node (click-through provenance). */
	nodeSessions: Record<string, string[]>;
}

/** Derive a short chat title from the learner's first message (pure).
 *  Used on chat creation; deterministic so tests can pin it. */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}

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
}

/** The list view's shape (messageCount instead of full messages). */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

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

// ─── Demo iframe bridge (W6) ────────────────────────────────────────────────
// postMessage protocol between the sandboxed demo iframe and its parent card.
// The bridge script is auto-injected into every demo HTML by the demo-card
// renderer (never the model's job): ResizeObserver → DEMO_RESIZE with the
// document height; window.onerror → DEMO_ERROR with the message.

export interface DemoResizeMessage {
	type: "demo-resize";
	height: number;
}

export interface DemoErrorMessage {
	type: "demo-error";
	message: string;
}

export type DemoBridgeMessage = DemoResizeMessage | DemoErrorMessage;

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
