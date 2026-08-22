/**
 * Shared contracts — the single source of truth every workstream codes against.
 * Pure types + protocol docs; no runtime code, no imports (safe everywhere:
 * server, client, tests). See docs/plan.md (waves) and docs/vision.md (§ refs).
 *
 * Owners: orchestrator wrote this file. Workers: do NOT edit it; if a contract
 * looks wrong or is missing something you need, ask the orchestrator.
 */

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
	/** Canonical proposition statement. */
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
	/** The learner's quiz note — diagnostic gold (vision §1 calibration). */
	note?: string;
	/** The quiz question text, when nodeId is null (later attribution input). */
	question?: string;
}

/**
 * Store format (W4 implements src/store/graph.ts): JSONL ledgers at
 * config.LEDGER_FILES (nodes/edges/events/mappings/sessions). The derived
 * graph is rebuilt by reading the ledgers — store events, derive state.
 * sessions.jsonl tracks which chats have been folded into the graph
 * (emission checkpoint — never fold the same turn twice).
 *
 * v1 emission (naive union, deterministic, no LLM): a chat's plan tree folds
 * in — node title → statement (aliases empty), tree edges → requires edges,
 * mark_done → "taught" events; quiz parts with input.nodeId → probe / check
 * events (+ note); quiz parts without nodeId → events with nodeId null.
 */

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
