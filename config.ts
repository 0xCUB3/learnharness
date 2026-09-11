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

// ─── Models ────────────────────────────────────────────────────────────────
// THE single place every LLM is chosen and tuned. .env stays for secrets
// (API keys) only — model choice and thinking budget are product tuning,
// not deployment environment, and this section is the one place they grow.
// `effort` is OpenRouter's reasoning scale (docs: reasoning-tokens):
// "none" | "minimal" | "low" | "medium" | "high" | "xhigh".
// "none" disables reasoning tokens entirely.

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelSpec {
	/** OpenRouter model id (e.g. "z-ai/glm-5.3-flash"). */
	model: string;
	/** Thinking budget — what the model may spend on reasoning tokens. */
	effort: ReasoningEffort;
}

export const MODELS = {
	/** The prober (agent A) — edge-bracketing questions; keep it lively and adaptive. */
	prober: { model: "z-ai/glm-5.3-flash", effort: "minimal" },
	/** The teacher (agent B) — planning + streaming, lesson-facing: smart, but keep it lively. */
	teacher: { model: "z-ai/glm-5.3-flash", effort: "minimal" },
	/** Background sub-agents: fast and cheap beats deep thought. */
	researcher: { model: "z-ai/glm-5.3-flash", effort: "minimal" },
	demoBuilder: { model: "z-ai/glm-5.3-flash", effort: "minimal" },
	/** Must be vision-capable: it looks at rendered SVGs. */
	visualMaker: { model: "qwen/qwen3.8-max", effort: "minimal" },
	/** Extraction is judgment over given evidence — light thinking suffices. */
	extractor: { model: "z-ai/glm-5.3-flash", effort: "minimal" },
	/** The auditor verifies evidence exists; keep it cheap. */
	auditor: { model: "z-ai/glm-5.3-flash", effort: "minimal" },
} satisfies Record<string, ModelSpec>;

export type ModelRole = keyof typeof MODELS;

/**
 * The extraction pipeline (vision §1 construction): the sole graph writer.
 * Triggered per chat once this many NEW quiz answers have landed since the
 * chat's last extraction checkpoint. The trigger mechanism is a v1
 * placeholder — deliberately isolated behind one seam
 * (server/turn-service.ts) so it can be swapped without touching the
 * pipeline.
 */
export const EXTRACTION = { everyNQuizAnswers: 3 } as const;

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
