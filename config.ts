import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	data: path.join(ROOT, "data"),
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	chats: path.join(ROOT, "data", "chats"),
	/** Old pi session JSONLs — retroactive bootstrap input only. */
	sessions: path.join(ROOT, "data", "sessions"),
	graph: path.join(ROOT, "data", "graph"),
} as const;

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's emission
 * pipeline. Line shapes: src/core/contracts.ts.
 */
export const LEDGER_FILES = {
	nodes: path.join(PATHS.graph, "nodes.jsonl"),
	edges: path.join(PATHS.graph, "edges.jsonl"),
	events: path.join(PATHS.graph, "events.jsonl"),
	mappings: path.join(PATHS.graph, "mappings.jsonl"),
	sessions: path.join(PATHS.graph, "sessions.jsonl"),
} as const;

/**
 * The legacy V0 scaffold (src/ledger.ts, src/cli.ts, src/extract/) writes
 * HERE instead — dormant pre-pivot reference code with its own line shapes
 * (src/schema.ts). Kept compiling for the future retroactive bootstrap,
 * which will target the contracts.ts shapes, not these.
 */
export const LEGACY_LEDGER_FILES = {
	nodes: path.join(PATHS.data, "legacy-graph", "nodes.jsonl"),
	edges: path.join(PATHS.data, "legacy-graph", "edges.jsonl"),
	events: path.join(PATHS.data, "legacy-graph", "events.jsonl"),
	mappings: path.join(PATHS.data, "legacy-graph", "mappings.jsonl"),
	sessions: path.join(PATHS.data, "legacy-graph", "sessions.jsonl"),
} as const;
