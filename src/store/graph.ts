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
 * Implements core/ports.ts GraphStore. data/graph/* is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter). Same idioms as src/store/chats.ts:
 * sync fs, no framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES } from "../../config.ts";
import type {
	GraphEdge,
	GraphNode,
	LedgerEvent,
	LedgerEventKind,
	NodeMapping,
	ProvenancePoint,
	SessionCheckpoint,
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

const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.statement) &&
	isString(v.description) &&
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
};
