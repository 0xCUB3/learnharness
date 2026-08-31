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
	graph: path.join(ROOT, "data", "graph"),
} as const;

/**
 * The extraction pipeline (vision §1 construction): the sole graph writer.
 * Triggered per chat once this many NEW quiz answers have landed since the
 * chat's last extraction checkpoint (LH_EXTRACT_N). The trigger mechanism is
 * a v1 placeholder — deliberately isolated behind one seam
 * (server/turn-service.ts) so it can be swapped without touching the
 * pipeline.
 */
export const EXTRACTION = { everyNQuizAnswers: Number(process.env.LH_EXTRACT_N ?? 3) } as const;

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's extraction
 * pipeline. Line shapes: src/core/contracts.ts.
 */
export const LEDGER_FILES = {
	nodes: path.join(PATHS.graph, "nodes.jsonl"),
	edges: path.join(PATHS.graph, "edges.jsonl"),
	events: path.join(PATHS.graph, "events.jsonl"),
	mappings: path.join(PATHS.graph, "mappings.jsonl"),
	sessions: path.join(PATHS.graph, "sessions.jsonl"),
} as const;
