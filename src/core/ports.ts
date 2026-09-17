/**
 * Storage ports (the hexagonal seams — vision §1 "storage stays swappable").
 *
 * One port per ENTITY, with domain operations — never one generic
 * key/value interface. Core and the service layer that orbits it code
 * against these types only; concrete adapters live in src/store/ (fs
 * JSON/JSONL today, SQLite drop-in later) and are wired exactly once, in
 * the composition root (src/server/stores.ts). Dependencies point one way:
 * adapters may import core; core NEVER imports an adapter.
 */

import type { UIMessage } from "ai";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	GraphEdge,
	GraphNode,
	JobKind,
	JobRecord,
	LedgerEvent,
	ExtractionRunUsage,
	NodeMapping,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	TurnUsage,
	NotesSource,
	ClusterLabeling,
	EmbeddingsLedger,
} from "./contracts.ts";

// ─── ChatStore — the session record's home (data/chats) ─────────────────────

export interface ChatStore {
	/** Create a session record (persisted immediately). */
	createChat(title: string): ChatRecord;
	/** The full record, or null if unknown id / corrupt file. */
	getChat(id: string): ChatRecord | null;
	/** All sessions, newest activity first (the sidebar's list view). */
	listChats(): ChatSummary[];
	/** Persist the full message list (client state + new response) after a turn. */
	saveMessages(id: string, messages: UIMessage[]): void;
	/** Persist the session plan tree (plan tools call this in execute). */
	saveTree(id: string, tree: PlanTree): void;
	/** Append one usage entry to the record's turn log (the money channel,
	 * 2026-09): idempotent per turn id — each request carries its own, so
	 * a turn persisted twice appends once while continuation turns (which
	 * share a response message id) each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): void;
	/** Append one extraction-run usage entry — idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): void;
	/** Persist the per-chat model/thinking settings (the model control).
	 *  Replace-whole: the picker sends the complete settings object. */
	saveSettings(id: string, settings: ChatSettings): void;
	/** Rename a session (the header's click-to-edit title, 2026-09-17).
	 * Like saveSettings: a rename is NOT conversation activity — updatedAt
	 * stays put, so sidebar order never churns on a rename. */
	renameChat(id: string, title: string): ChatRecord;
}

// ─── GraphStore — the append-only evidence ledgers (data/graph) ──────────────
// v1 surface = the five JSONL ledgers (nodes / edges / events / mappings /
// sessions). Reads return the raw append-order lines; merging edge assertions
// by (from, to, type) is DERIVED in core/graph.ts — the store never decides.
// The extraction pipeline (next stage) becomes the sole writer; this read
// surface stays.

export interface GraphStore {
	/** Append one GraphNode (ids are unique — no merging needed). */
	appendNode(node: GraphNode): void;
	/** Raw node lines in append order. */
	readNodes(): GraphNode[];

	/** Append one edge ASSERTION (a second session asserting the same
	 *  (from, to, type) appends another line; readers merge). */
	appendEdge(assertion: GraphEdge): void;
	readEdges(): GraphEdge[];

	/** Append one quiz outcome / understanding observation. */
	appendEvent(event: LedgerEvent): void;
	readEvents(): LedgerEvent[];

	/** Append one identity-map line (chat's tree node → graph node). */
	appendMapping(mapping: NodeMapping): void;
	readMappings(): NodeMapping[];

	/** Append one emission checkpoint. */
	appendCheckpoint(checkpoint: SessionCheckpoint): void;
	readCheckpoints(): SessionCheckpoint[];
	/** Message-granular extraction coverage (vision-extraction-coverage.md):
	 *  append-only; one line per covered message. The chat-extraction
	 *  checkpoint — "uncovered" is derived from these, never tracked. */
	appendCoverage(entry: CoverageEntry): void;
	readCoverage(): CoverageEntry[];

	/** Append one cluster labeling — idempotent by id (the id hashes the
	 *  sorted core, so identical member sets dedupe). */
	appendClusterLabel(labeling: ClusterLabeling): void;
	readClusterLabels(): ClusterLabeling[];

	/** Upsert one imported-notes source record (config.SOURCES_FILE — a
	 *  JSON map, not a ledger; an upsert keeps the existing usage log). */
	upsertSource(source: NotesSource): void;
	/** Every notes source record, by id order-insensitive. */
	readSources(): NotesSource[];
	/** Append one run's usage to a source record — idempotent per
	 *  startedAt, mirroring ChatRecord.extractions. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void;

	/** The layout ledger (config.POSITIONS_FILE): nodeId → resting {x,y}.
	 *  WRITTEN ONLY by the incremental settle after a merge (core/layout.ts
	 *  settleGraphLayout) — read-only for everything else. */
	readPositions(): Record<string, Position>;
	/** Replace the whole ledger (the settle is a full-graph computation). */
	writePositions(positions: Record<string, Position>): void;

	/** The embedding ledger (config.EMBEDDINGS_FILE). WRITTEN ONLY by
	 *  the embedder (server/embeddings.ts) after a merge — read-only for
	 *  clustering consumers (snapshot, settle, namer). */
	readEmbeddings(): EmbeddingsLedger;
	/** Replace the whole ledger (embedding is a full-batch computation). */
	writeEmbeddings(ledger: EmbeddingsLedger): void;
}

// ─── JobStore — background sub-agent jobs (data/jobs) ─────────────────────────

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** First activity line (defaults to "starting"). */
	activity?: string;
}

/** Mergeable fields — identity (id, kind, chatId, toolCallId, createdAt) is immutable. */
export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	/** Create a running job (keyed by toolCallId for spawn dedup). */
	createJob(init: CreateJobInit): JobRecord;
	getJob(id: string): JobRecord | null;
	/** Merge a patch into the record; null if unknown id. */
	updateJob(id: string, patch: JobPatch): JobRecord | null;
	/** All jobs for a chat, newest activity first. */
	listJobs(chatId: string): JobRecord[];
	/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
	findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null;
}
