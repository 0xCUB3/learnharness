/**
 * Knowledge-graph contracts — nodes, ledgers, extraction findings
 *
 * The minimal implementation of the graph vision (docs/vision.md §1, the
 * 2026-09-02 redesign): every node is a TRUE proposition; edges are follows
 * (derivable) and supports (grounds without entailing); provenance is
 * message-granular; extraction is free-form and post-hoc, fully decoupled
 * from the session's plan tree; the event ledger records quiz outcomes plus
 * the extractor's per-proposition understanding observations. Anything not
 * yet decided (the state model, strength derivation, understanding
 * treatment, selection strategies) is deliberately NOT here — transitional
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
export type EdgeType = "follows" | "supports";

/** One provenance point — message-granular (DECIDED 2026-09-02): nodes and
 *  edges record every (chat, message) where they came up, deep-linkable to
 *  the exact transcript point. */
export interface ProvenancePoint {
	chatId: string;
	messageId: string;
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

/**
 * Event kinds (DECIDED 2026-09-02): quiz outcomes only — correct / miss /
 * dont-know — plus `observation`, the extractor's per-proposition
 * understanding note joining the ledger as a session-scoped observation
 * (named-word scale; treatment pending the state-model ideation). No
 * `taught` events at all; no misconception kind — a misconception is a
 * TRUE correction in the graph, and the wrongness lives here, in the
 * ledger, until the state model exists.
 */
export type LedgerEventKind = "correct" | "miss" | "dont-know" | "observation";

export interface LedgerEvent {
	/** null = not yet attributed. */
	nodeId: string | null;
	kind: LedgerEventKind;
	chatId: string;
	at: string;
	/** Idempotency key: the quiz part's toolCallId, or `obs:<sourceId>` for
	 *  understanding observations — re-emission of the same chat must never
	 *  double-record an event. */
	ref?: string;
	/** The learner's quiz note — diagnostic gold (vision §1 calibration). */
	note?: string;
	/** The quiz question text, when nodeId is null (later attribution input). */
	question?: string;
}

/**
 * Store format (src/store/graph.ts): JSONL ledgers at config.LEDGER_FILES
 * (nodes/edges/events/mappings/sessions), all append-only.
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
 * merger), tree-blind and post-hoc: the extractor reads only the transcript
 * and proposes propositions/edges/quiz-attribution with verbatim evidence;
 * the auditor sees the extractor's output PLUS the current graph, owns
 * faithfulness (evidence check) and identity (link-or-create: point each
 * proposition at the existing node it is, or let it be created — recording
 * the session's phrasings as aliases); the merger (core/graph.ts,
 * deterministic) applies the verdicts and appends.
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
	 *  wrongness lives in the event ledger, never in the node. */
	statement: string;
	/** Verbatim phrasings the session used. */
	aliases: string[];
	/** The message ids where this proposition came up — provenance. */
	messages: string[];
	/** Verbatim transcript quotes backing the proposition. */
	evidence: string[];
	/** The extractor's understanding note for this proposition IN THIS
	 *  session — a named-word scale ("solid", "shaky", "accepted",
	 *  "resisted"), no numbers. Joins the ledger as an observation event;
	 *  treatment pending the state-model ideation. */
	understanding?: string;
}

/** One proposed relation between two propositions. */
export interface ExtractedEdge {
	/** Proposition id that is followed / supported. */
	from: string;
	to: string;
	type: EdgeType;
	/** The message ids where this relation was asserted — provenance. */
	messages: string[];
	/** Verbatim transcript quotes backing the relation. */
	evidence: string[];
}

/**
 * The extractor's quiz attribution — its ONLY say about quiz events. Event
 * kinds, timestamps, idempotency refs, notes and question texts are all
 * rebuilt deterministically by the merger from the transcript's quiz tool
 * parts; the LLM supplies exactly the judgment call: WHICH proposition each
 * quiz tested. Tree-blind, so EVERY quiz attributes here (there is no tree
 * mapping to lean on) — retroactively against the whole transcript.
 */
export interface ExtractionAttribution {
	/** quiz toolCallId → proposition id; null / missing = unattributed (the
	 *  event lands with nodeId null + the question text, a later-
	 *  attribution input). */
	quiz: Record<string, string | null>;
}

/** The extractor's output shape. */
export interface SessionFindings {
	propositions: ExtractedProposition[];
	edges: ExtractedEdge[];
	attribution: ExtractionAttribution;
}

/** The auditor's verdict on one proposition: the findings, plus `linkTo` —
 *  the identity judgment. Absent = create a new node. */
export interface AuditedProposition extends ExtractedProposition {
	/** The existing GraphNode id this proposition IS — the auditor's
	 *  identity verdict. On link, the session's phrasings (statement,
	 *  aliases) join the node's aliases and the provenance unions.
	 *  Conservative: when unsure, leave it out — duplicates over wrong
	 *  merges. */
	linkTo?: string;
}

/** The auditor's output: the verified findings (with identity verdicts),
 * plus the drops (the audit trail of what was rejected and why). */
export interface AuditResult {
	propositions: AuditedProposition[];
	edges: ExtractedEdge[];
	attribution: ExtractionAttribution;
	/** Dropped candidates: proposition id, edge "from→to", or attribution
	 *  toolCallId — with the reason. */
	dropped: { ref: string; reason: string }[];
}

/** The GET /api/graph payload — everything the home view's PURE renderer needs. */
export interface GraphSnapshot {
	nodes: GraphNode[];
	edges: GraphEdge[];
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
