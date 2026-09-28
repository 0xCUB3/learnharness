/**
 * Knowledge-graph contracts — nodes, ledgers, extraction findings
 *
 * The minimal implementation of the graph vision (docs/vision.md §1, the
 * 2026-09-02 redesign): every node is a TRUE proposition; edges are follows
 * (derivable) and supports (grounds without entailing); provenance is
 * message-granular; extraction is free-form and post-hoc, fully decoupled
 * from the session's plan tree. The graph is an extraction of the reasoning
 * chains from all teaching sessions (and imported notes) — NOTHING else:
 * no quiz outcomes, no understanding assessments (2026-09-27 cleanup —
 * understanding becomes practice-module territory). Anything not
 * yet decided (the state model, strength derivation, selection strategies) is deliberately NOT here — transitional
 * stubs carry the renderer until those land.
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/vision.md.
 */
// ─── Knowledge graph (vision §1 — global, cross-session) ────────────────────

/** Two relations only (DECIDED 2026-09-02): follows = b is derivable from a;
 *  supports = a grounds b without entailing it. No scalars, no encoded
 *  strength — strength is derived at read time from topology. */
import type { CallUsage, ExtractionRunUsage } from "./chat.ts";

export type EdgeType = "follows" | "supports";

/** What one extraction run merged into the graph ledgers — the merger's
 *  output, also persisted in extraction-run usage records (contracts/chat). */
export interface EmissionStats {
	/** New graph nodes appended. */
	nodes: number;
	/** New edge assertions appended. */
	edges: number;
}

/** One provenance point — message-granular (DECIDED 2026-09-02): nodes and
 *  edges record every (chat, message) where they came up, deep-linkable to
 *  the exact transcript point. Auditor-drawn bridging edges carry the chat
 *  but NO message anchor (nothing in the transcript asserts them — the
 *  auditor is the asserter); messageId is "" there. */
export interface ProvenancePoint {
	/** The chat this point anchors to — or a notes source id ("src_…"):
	 *  imports carry no message anchors (provenance is the file itself,
	 *  recorded through the mapping line + the source record). */
	chatId: string;
	messageId: string;
}

/** One imported notes file — the format-agnostic front door's bookkeeping
 *  (DECIDED 2026-09-13): personal notes in ARBITRARY formats run through the
 *  same extractor → auditor → merger pipeline, with the file itself as the
 *  provenance anchor. There is no chat: the detail card shows the file path
 *  as a STATIC entry (not a link). The run's usage log lives here,
 *  mirroring ChatRecord.extractions. Ids are "src_" + hash of the file
 *  path — deterministic, so re-importing the same file re-runs extraction
 *  against the same source id (mappings dedupe by it). */
export interface NotesSource {
	id: string;
	filePath: string;
	/** ISO — when this file was imported (the checkpoint's foldedAt). */
	importedAt: string;
	/** The run's usage log — same append-only discipline as
	 *  ChatRecord.extractions, idempotent per startedAt. */
	extractions?: ExtractionRunUsage[];
}

/** What one cluster-naming refresh did — the namer's ClusterRefreshStats,
 *  contract-shaped so the agent layer needs no contracts import.
 *  Structural twins stay interchangeable. */
export interface NamingRunStats {
	/** Communities the current graph divides into (all sizes). */
	detected: number;
	/** Communities that kept a label via core-survival. */
	claimed: number;
	/** Communities sent to the namer (unnamed, size >= MIN_CLUSTER_SIZE). */
	named: number;
	/** Labeling records actually appended (idempotent dedupe may shrink). */
	appended: number;
}


export interface GraphNode {
	/** Opaque stable id, store-assigned: "n_" + nanoid-like. */
	id: string;
	/** A very short label for the node — a compact handle like a glossary
	 *  headword ("Will to power", "Divine command theory"): what the graph
	 *  shows at a glance. Presentational only — not unique, not an identity
	 *  key, never precise: the statement carries the precision. Set at
	 *  creation (first line defines); a link-append never changes it. */
	name: string;
	/** The minimal proposition — one true, self-contained statement, at
	 *  full precision. The IDENTITY ANCHOR: the auditor recognizes a
	 *  re-encounter by judgment against this (link-or-create), not by
	 *  string matching. Shown in the detail card; the canvas label is the
	 *  name. */
	statement: string;
	/** Verbatim phrasings sessions used for this proposition (the identity
	 *  audit trail — how the world said what the node says). */
	aliases: string[];
	createdAt: string;
	/** Every (chat, message) point where this proposition came up. */
	provenance: ProvenancePoint[];
}

export interface GraphEdge {
	from: string;
	to: string;
	type: EdgeType;
	/** Every (chat, message) point where this relation was asserted. */
	provenance: ProvenancePoint[];
}

/** mappings.jsonl line — the session→graph identity map: the extraction
 *  pipeline's proposition (identified by its run-local source id) → the
 *  graph node it resolved to (created or linked). The audit trail of the
 *  auditor's identity verdicts; also the chat-scoped resolution table the
 *  merger uses to point events and edges at node ids. */
export interface NodeMapping {
	chatId: string;
	/** The extractor's run-local proposition id ("p1", …). */
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

/** coverage.jsonl line (vision-extraction-coverage.md, settled 2026-09-15):
 *  ONE MESSAGE of one chat has been extracted — by content fingerprint over
 *  exactly what the extraction view sees. The MESSAGE is the unit of
 *  coverage; "uncovered" is derived (fingerprint the current transcript,
 *  diff) — never dual-tracked. A quiz answer merging into the asking
 *  message changes its fingerprint: the message re-opens itself, only
 *  itself. Chat extractions write these instead of whole-chat checkpoints;
 *  notes imports keep the checkpoint (a file is one shot). */
export interface CoverageEntry {
	chatId: string;
	/** sha256 of the message's view lines — "covered" means exactly this. */
	fp: string;
	/** chars/4 estimate of the message's view — display + budgeting. */
	tokens: number;
	/** ISO — when this message's last extraction run merged. */
	foldedAt: string;
}

/**
 * Store format (src/store/graph.ts): JSONL ledgers at config.LEDGER_FILES
 * (nodes/edges/mappings/sessions), all append-only.
 *
 *   nodes.jsonl    one line per node — the FIRST line for an id defines
 *                  name/statement/createdAt; later lines for the
 *                  same id are link-appends (a session's re-encounter):
 *                  their statements/aliases join `aliases`, their
 *                  provenance unions; the name stays the first line's.
 *                  getGraph merges by id.
 *   edges.jsonl    one line per edge ASSERTION; readers merge by
 *                  (from,to,type), unioning provenance.
 *
 * The derived graph is rebuilt by reading the ledgers — store events,
 * derive state. sessions.jsonl is the extraction checkpoint: which chats
 * the extraction pipeline has processed, and through which updatedAt
 * (never extract the same turns twice).
 *
 * The EXTRACTION PIPELINE is the sole graph writer (extractor → auditor →
 * merger), tree-blind and post-hoc (2026-09-27 cleanup — clear separation
 * of work): the extractor is the ONLY stage that sees the raw source
 * (whole session as readable markdown, or raw notes) and extracts the
 * reasoning chains — propositions (lonely relevant ones included) plus
 * follows/supports edges, with verbatim evidence; the auditor NEVER sees
 * the source — its job is preparing the merge: identity verdicts
 * (link-or-create, merging equivalent forms of the same proposition) via
 * graph-exploration tools (find / list_sessions / list_propositions), and
 * it may draw BRIDGING edges from existing graph nodes to the new
 * propositions; the merger (core/graph.ts, deterministic) applies the
 * verdicts and appends. Quiz events and understanding observations are
 * GONE — the pipeline is the only session→graph bridge, and it carries
 * propositions + edges, nothing else.
 */

// ─── Extraction findings (extractor output → audit → merger input) ───────────

/** One proposed proposition — a node candidate (or a re-encounter of one). */
export interface ExtractedProposition {
	/** Extractor-local id ("p1", …) referenced by edges + attribution. */
	id: string;
	/** A very short label — a few words, a compact handle like a glossary
	 *  headword. Not a sentence, needn't be unique or self-contained: the
	 *  statement carries the precision. Becomes the node's name on create;
	 *  on link, the existing node keeps its name. */
	name: string;
	/** The minimal proposition — a true, self-contained, world-facing
	 *  statement, at full precision. No learner / teacher / session
	 *  references: misconceptions are stated as the true correction, and
	 *  wrongness is never recorded in the graph (2026-09-27: the event
	 *  ledger is gone). */
	statement: string;
	/** Verbatim phrasings the session used. */
	aliases: string[];
	/** The message ids where this proposition came up — provenance. */
	messages: string[];
	/** Verbatim transcript quotes backing the proposition. */
	evidence: string[];
}

/** One proposed relation. Endpoints are extractor-local proposition ids
 *  ("p1", …); the AUDITOR may also emit bridging edges whose from/to is an
 *  EXISTING graph node id (connecting the new content to what the graph
 *  already holds) — the merger resolves both. */
export interface ExtractedEdge {
	/** Proposition id (or, for auditor-drawn bridges, a graph node id)
	 *  that is followed / supported. */
	from: string;
	/** Proposition id (or graph node id) that follows / is supported. */
	to: string;
	type: EdgeType;
	/** The message ids where this relation was asserted — provenance. */
	messages: string[];
	/** Verbatim transcript quotes backing the relation. */
	evidence: string[];
}

/** The extractor's output shape: the raw reasoning chains. */
export interface SessionFindings {
	propositions: ExtractedProposition[];
	edges: ExtractedEdge[];
}

/** The auditor's verdict on one proposition: the findings, plus `linkTo` —
 *  the identity judgment. Absent = create a new node. */
export interface AuditedProposition extends ExtractedProposition {
	/** The existing GraphNode id this proposition IS — the auditor's
	 *  identity verdict. On link, the session's phrasings (statement,
	 *  aliases) join the node's aliases and the provenance unions.
	 *  EQUIVALENCE BIAS (2026-09-27): paraphrases, rewordings, and
	 *  compressions of the same claim MERGE — do not create a duplicate
	 *  because the wording differs. Only genuinely distinct propositions
	 *  stay apart. */
	linkTo?: string;
}

/** The auditor's output: the findings with identity verdicts, plus any
 *  bridging edges drawn to existing graph nodes. No drop channel — the
 *  auditor never rejects; the extractor is fully trusted (2026-09-27). */
export interface AuditResult {
	propositions: AuditedProposition[];
	edges: ExtractedEdge[];
}

/** The GET /api/graph payload — everything the home view's PURE renderer needs. */

/** One rendered cluster in the snapshot payload (vision §1). Members are
 * node ids; the renderer draws the hull from member positions at draw
 * time and gates the label inversely on the node-label zoom control. */
export interface Cluster {
	/** The labeling record id when claimed; unlabeled clusters still
	 * appear (hull, no name) with a member-hash id. */
	id: string;
	/** null until the naming call has minted/claimed a labeling. */
	label: string | null;
	/** Node ids, sorted. Hull + centroid are renderer concerns. */
	members: string[];
}

export interface GraphSnapshot {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** chatId → title, for every chat that touched the graph. */
	sessions: Record<string, string>;
	/** srcId → file path, for every IMPORTED NOTES file that touched the
	 *  graph (the format-agnostic front door): a static provenance entry —
	 *  the detail card shows the path as plain text, not a link. */
	fileSources: Record<string, string>;
	/** nodeId → chatIds that touched the node (click-through provenance). */
	nodeSessions: Record<string, string[]>;
	/** Structural communities (Louvain over follows+supports), size ≥ 3,
	 * joined with persisted LLM labelings. Purely structural — never
	 * depends on layout. */
	clusters: Cluster[];
	/** Resting layout positions per node id, when a positions ledger
	 *  exists (core/layout.ts settle writes it). Absent on a fresh graph —
	 *  the view then falls back to its own one-shot forceAtlas2 pass. */
	positions?: Record<string, Position>;
}

/** A node's resting position in layout space (the positions ledger). */
export interface Position {
	x: number;
	y: number;
}

/** Derive a short chat title from the learner's first message (pure).
 *  Used on chat creation; deterministic so tests can pin it. */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}
