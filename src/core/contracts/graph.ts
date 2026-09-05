/**
 * Knowledge-graph contracts — nodes, ledgers, extraction findings
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
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

