import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
	root: ROOT,
	extensions: path.join(ROOT, "extensions"),
	teacherPrompt: path.join(ROOT, "teacher", "system-prompt.md"),
	data: path.join(ROOT, "data"),
	/** Hermetic pi agentDir: settings, auth, and NOTHING from ~/.pi/agent except a symlinked auth.json. */
	agentDir: path.join(ROOT, "data", "agent"),
	sessions: path.join(ROOT, "data", "sessions"),
	graph: path.join(ROOT, "data", "graph"),
} as const;

export const LEDGER_FILES = {
	nodes: path.join(PATHS.graph, "nodes.jsonl"),
	edges: path.join(PATHS.graph, "edges.jsonl"),
	events: path.join(PATHS.graph, "events.jsonl"),
	mappings: path.join(PATHS.graph, "mappings.jsonl"),
	sessions: path.join(PATHS.graph, "sessions.jsonl"),
} as const;
