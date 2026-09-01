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
	/** The tool output payload when done (ResearchResult | DemoResult | VisualResult). */
	result?: unknown;
	error?: string;
}

/**
 * THE ASYNC PROTOCOL — "client-side-tool semantics, server-side fulfillment":
 *
 *  1. Job tools (research / demo / visual) are CLIENT-SIDE tools (no execute),
 *     exactly like quiz/ask. The model calls one; the server turn ends with the
 *     tool part in `input-available` state. (The teacher is prompted to say its
 *     piece BEFORE calling, since its turn ends at the call.)
 *  2. chat-handler's onFinish (the integration point) scans the new assistant
 *     message for job tool parts and spawns one background runner per part
 *     (src/agent/subagents/…, W2/W6). The job store (src/store/jobs.ts) is
 *     keyed by toolCallId.
 *  3. On completion the runner REWRITES the part in the stored chat record to
 *     `output-available` with the job result as output (read-modify-write of
 *     the LATEST record — never a stale copy).
 *  4. The client polls GET /api/jobs?chatId=… while any job part is pending;
 *     when a part flips, it re-syncs messages from the server
 *     (ChatActionsContext.syncFromServer) and the existing
 *     `sendAutomaticallyWhen` continuation fires — the teacher receives the
 *     result as a normal tool output and resumes. No new stream machinery.
 *
 *  5. The composer gate (findPendingToolCall) covers ONLY quiz/ask — but the
 *     protocol still forbids sending a user message while a job part is
 *     pending (an unanswered tool call in the outbound list breaks provider
 *     conversion). So job parts ALSO gate SENDING, with a distinct affordance
 *     ("waiting for <job>…" + live activity) — the learner can keep reading,
 *     scrolling, and typing notes in the field; the send unlocks on arrival.
 *     True mid-job interjection (concurrent turns) is a documented later
 *     upgrade, not v1.
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
