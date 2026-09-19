/**
 * GraphStore — the fs JSONL adapter: five append-only ledgers at
 * config.LEDGER_FILES (contracts.ts "v1 emission").
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   edges.jsonl    GraphEdge        — one line per edge ASSERTION (a second
 *                                      session asserting the same (from,to,type)
 *                                      appends another line; reads merge)
 *   events.jsonl    LedgerEvent      — quiz outcomes + understanding observations
 *   mappings.jsonl  NodeMapping      — the session→graph identity map:
 *                                      (chatId, sourceId) → graphNodeId
 *   sessions.jsonl  SessionCheckpoint— emission checkpoints (foldedAt)
 *
 * Plus config.SOURCES_FILE (sources.json): the imported-notes bookkeeping
 * (NOT a ledger) — one JSON map, src-id → NotesSource, read-modify-write
 * like a chat file. The format-agnostic front door (2026-09-13).
 *
 * Implements core/ports.ts GraphStore. data/graph/* is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter). Same idioms as src/store/chats.ts:
 * sync fs, no framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EMBEDDINGS_FILE, LEDGER_FILES, POSITIONS_FILE, SOURCES_FILE } from "../../config.ts";
import type {
	ClusterLabeling,
	EmbeddingsLedger,
	GraphEdge,
	GraphNode,
	ExtractionRunUsage,
	LedgerEvent,
	LedgerEventKind,
	NotesSource,
	NodeMapping,
	Position,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
	NamingRunUsage,
} from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";

// ─── JSONL primitives ────────────────────────────────────────────────────────

function appendLine<T>(file: string, record: T): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — nothing has ever been emitted
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read — a torn
			// append must never take the home graph down with it.
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Strict shape guards — anything not matching a W4 ledger shape is skipped. */
function readValid<T>(file: string, isValid: (v: unknown) => v is T): T[] {
	return readRawLines(file).filter(isValid);
}

/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);

const isNamingStats = (v: unknown): v is NamingRunUsage["stats"] =>
	isRecord(v) &&
	["detected", "claimed", "named", "appended"].every((k) => typeof v[k] === "number");

const isNamingRun = (v: unknown): v is NamingRunUsage =>
	isRecord(v) &&
	typeof v.startedAt === "number" &&
	isString(v.at) &&
	typeof v.durationMs === "number" &&
	isString(v.model) &&
	Array.isArray(v.steps) &&
	isNamingStats(v.stats);

const isClusterLabeling = (v: unknown): v is ClusterLabeling =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.label) &&
	Array.isArray(v.core) &&
	v.core.every(isString) &&
	isString(v.createdAt);

const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

const EDGE_TYPES = ["follows", "supports"] as const;

const isGraphEdge = (v: unknown): v is GraphEdge =>
	isRecord(v) &&
	isString(v.from) &&
	isString(v.to) &&
	(EDGE_TYPES as readonly string[]).includes(v.type as string) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

const EVENT_KINDS: readonly LedgerEventKind[] = ["correct", "miss", "dont-know", "observation"];

const isLedgerEvent = (v: unknown): v is LedgerEvent =>
	isRecord(v) &&
	(v.nodeId === null || isString(v.nodeId)) &&
	(EVENT_KINDS as readonly string[]).includes(v.kind as string) &&
	isString(v.chatId) &&
	isString(v.at);

const isNodeMapping = (v: unknown): v is NodeMapping =>
	isRecord(v) && isString(v.chatId) && isString(v.sourceId) && isString(v.graphNodeId);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

// ─── the port implementation ────────────────────────────────────────────────

export const graphStore: GraphStore = {
	appendNode(node: GraphNode): void {
		appendLine(LEDGER_FILES.nodes, node);
	},
	/** Raw node lines in append order. A node id may appear on more than
	 *  one line (a later session's LINK-append: phrasings + provenance); the
	 *  derivation (core/graph.ts getGraph) merges lines by id. */
	readNodes(): GraphNode[] {
		return readValid(LEDGER_FILES.nodes, isGraphNode);
	},

	/** Append one edge ASSERTION; readers merge lines by (from,to,type). */
	appendEdge(assertion: GraphEdge): void {
		appendLine(LEDGER_FILES.edges, assertion);
	},
	readEdges(): GraphEdge[] {
		return readValid(LEDGER_FILES.edges, isGraphEdge);
	},

	appendEvent(event: LedgerEvent): void {
		appendLine(LEDGER_FILES.events, event);
	},
	readEvents(): LedgerEvent[] {
		return readValid(LEDGER_FILES.events, isLedgerEvent);
	},

	appendMapping(mapping: NodeMapping): void {
		appendLine(LEDGER_FILES.mappings, mapping);
	},
	readMappings(): NodeMapping[] {
		return readValid(LEDGER_FILES.mappings, isNodeMapping);
	},

	appendCheckpoint(checkpoint: SessionCheckpoint): void {
		appendLine(LEDGER_FILES.sessions, checkpoint);
	},
	readCheckpoints(): SessionCheckpoint[] {
		return readValid(LEDGER_FILES.sessions, isCheckpoint);
	},

	appendCoverage(entry: CoverageEntry): void {
		appendLine(LEDGER_FILES.coverage, entry);
	},
	readCoverage(): CoverageEntry[] {
		return readValid(LEDGER_FILES.coverage, isCoverageEntry);
	},

	// ── cluster labelings (config.LEDGER_FILES.clusterLabels) ──

	/** Idempotent by id: the id is a hash of the sorted core, so re-appending
	 *  the same member set (re-naming races, idempotent re-runs) is a no-op. */
	appendClusterLabel(labeling: ClusterLabeling): void {
		if (this.readClusterLabels().some((l) => l.id === labeling.id)) return;
		appendLine(LEDGER_FILES.clusterLabels, labeling);
	},
	readClusterLabels(): ClusterLabeling[] {
		return readValid(LEDGER_FILES.clusterLabels, isClusterLabeling);
	},

	// ── cluster-naming run usage (config.LEDGER_FILES.namingRuns) ──

	/** Idempotent per startedAt — the same discipline as every usage
	 *  channel (chats.appendExtractionUsage, appendSourceUsage). */
	appendNamingUsage(entry: NamingRunUsage): void {
		if (this.readNamingRuns().some((r) => r.startedAt === entry.startedAt)) return;
		appendLine(LEDGER_FILES.namingRuns, entry);
	},
	readNamingRuns(): NamingRunUsage[] {
		return readValid(LEDGER_FILES.namingRuns, isNamingRun);
	},

	// ── imported-notes bookkeeping (config.SOURCES_FILE — a JSON map) ──

	/** Upsert: keeps the existing record's usage log when re-importing. */
	upsertSource(source: NotesSource): void {
		const all = readSourceMap();
		const prev = all[source.id];
		all[source.id] = prev ? { ...source, extractions: prev.extractions } : source;
		writeSourceMap(all);
	},
	readSources(): NotesSource[] {
		return Object.values(readSourceMap());
	},
	/** Idempotent per startedAt — same discipline as chats.appendExtractionUsage. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
		const all = readSourceMap();
		const source = all[id];
		if (!source) return; // no such source — nothing to bill against
		source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
			? source.extractions
			: [...(source.extractions ?? []), entry];
		writeSourceMap(all);
	},

	// ── the layout ledger (config.POSITIONS_FILE — a JSON map) ──
	readPositions(): Record<string, Position> {
		return readPositionMap();
	},
	writePositions(positions: Record<string, Position>): void {
		writePositionMap(positions);
	},
	readEmbeddings(): EmbeddingsLedger {
		return readEmbeddingsLedger();
	},
	writeEmbeddings(ledger: EmbeddingsLedger): void {
		writeEmbeddingsLedger(ledger);
	},
};

/** positions.json — { positions, updatedAt }. Read-modify-write, NOT
 *  append-only: the settle is a full-graph computation, so it replaces the
 *  whole map. The updatedAt stamp exists for future live-physics conflict
 *  handling (a browser commit must be able to detect "the graph changed
 *  underneath me"); reads just return the map. */
function readPositionMap(): Record<string, Position> {
	let raw: string;
	try {
		raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
	} catch {
		return {}; // no ledger yet — nothing has ever settled
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(parsed.positions)) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	} catch {
		return {};
	}
}

function writePositionMap(positions: Record<string, Position>): void {
	fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
	fs.writeFileSync(
		POSITIONS_FILE,
		JSON.stringify({ positions, updatedAt: new Date().toISOString() }, null, "\t"),
		"utf-8",
	);
}

/** embeddings.json — the whole EmbeddingsLedger at once. Missing/corrupt
 *  file reads as an EMPTY ledger (model "") so consumers see "nothing
 *  embedded yet" rather than an error; the embedder backfills. */
function readEmbeddingsLedger(): EmbeddingsLedger {
	let raw: string;
	try {
		raw = fs.readFileSync(EMBEDDINGS_FILE, "utf-8");
	} catch {
		return { model: "", dim: 0, vectors: {}, clusters: [], updatedAt: "" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return { model: "", dim: 0, vectors: {}, clusters: [], updatedAt: "" };
		const model = typeof parsed.model === "string" ? parsed.model : "";
		const dim = typeof parsed.dim === "number" && Number.isFinite(parsed.dim) ? parsed.dim : 0;
		const vectors: Record<string, number[]> = {};
		if (isRecord(parsed.vectors)) {
			for (const [id, value] of Object.entries(parsed.vectors)) {
				if (
					Array.isArray(value) &&
					value.length > 0 &&
					value.every((x) => typeof x === "number" && Number.isFinite(x))
				) {
					vectors[id] = value as number[];
				}
			}
		}
		const clusters: Array<{ members: string[] }> = [];
		if (Array.isArray(parsed.clusters)) {
			for (const c of parsed.clusters) {
				if (
					isRecord(c) &&
					Array.isArray(c.members) &&
					c.members.length > 0 &&
					c.members.every((m) => typeof m === "string")
				) {
					clusters.push({ members: [...(c.members as string[])] });
				}
			}
		}
		return { model, dim, vectors, clusters, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
	} catch {
		return { model: "", dim: 0, vectors: {}, clusters: [], updatedAt: "" };
	}
}

function writeEmbeddingsLedger(ledger: EmbeddingsLedger): void {
	fs.mkdirSync(path.dirname(EMBEDDINGS_FILE), { recursive: true });
	fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(ledger, null, "\t"), "utf-8");
}

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

/** sources.json — { id: NotesSource }. Read-modify-write, NOT append-only:
 *  the usage log lives inside the record (like a chat's JSON file). */
function readSourceMap(): Record<string, NotesSource> {
	let raw: string;
	try {
		raw = fs.readFileSync(SOURCES_FILE, "utf-8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, NotesSource> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (isNotesSource(value)) out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function writeSourceMap(map: Record<string, NotesSource>): void {
	fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true });
	fs.writeFileSync(SOURCES_FILE, JSON.stringify(map, null, "\t"), "utf-8");
}

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);
