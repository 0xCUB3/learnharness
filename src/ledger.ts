/**
 * Append-only JSONL ledgers. Same philosophy as the design: the ledgers are
 * the source of truth; everything else is derived and recomputable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { LEGACY_LEDGER_FILES as LEDGER_FILES } from "../config.ts";

export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export function append<T>(file: string, record: T): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
}

export function readAll<T>(file: string): T[] {
	if (!fs.existsSync(file)) return [];
	const out: T[] = [];
	for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) out.push(JSON.parse(trimmed) as T);
	}
	return out;
}

// Typed helpers ───────────────────────────────────────────────────────────────

import type {
	GraphEdge,
	GraphNode,
	KnowledgeEvent,
	SessionMapping,
	SessionRecord,
} from "./schema.ts";

export const ledgers = {
	appendSession(record: SessionRecord) {
		// Session records are unique per id — skip if already ingested.
		if (readAll<SessionRecord>(LEDGER_FILES.sessions).some((s) => s.id === record.id)) return false;
		append(LEDGER_FILES.sessions, record);
		return true;
	},
	sessions: () => readAll<SessionRecord>(LEDGER_FILES.sessions),

	appendNode(node: GraphNode) {
		append(LEDGER_FILES.nodes, node);
	},
	nodes: () => readAll<GraphNode>(LEDGER_FILES.nodes),

	appendEdge(edge: GraphEdge) {
		append(LEDGER_FILES.edges, edge);
	},
	edges: () => readAll<GraphEdge>(LEDGER_FILES.edges),

	appendEvent(event: KnowledgeEvent) {
		append(LEDGER_FILES.events, event);
	},
	events: () => readAll<KnowledgeEvent>(LEDGER_FILES.events),

	appendMapping(mapping: SessionMapping) {
		append(LEDGER_FILES.mappings, mapping);
	},
	mappings: () => readAll<SessionMapping>(LEDGER_FILES.mappings),
};
