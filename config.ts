import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam (the Electron contract, 2026-09-17): LH_DATA_DIR
 * relocates every MUTABLE record — chat sessions, graph ledgers, the
 * embedding model cache — when set. The desktop shell points it at
 * userData so nothing is written inside the read-only .app bundle
 * (macOS translocation guarantees the bundle is read-only anyway).
 * Unset (plain web dev / repo work) it resolves to the repo's data/,
 * byte-for-byte as before. Read-only assets (prompts) stay ROOT-anchored
 * on purpose: they ship inside the app bundle by design.
 */
const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	data: DATA_ROOT,
	/** Chat sessions (AI SDK UIMessage transcripts, one JSON file per chat). */
	chats: path.join(DATA_ROOT, "chats"),
	graph: path.join(DATA_ROOT, "graph"),
	/** transformers.js model cache (server-side embeddings, ~300MB).
	 * null in dev = keep the package default (the model is already
	 * downloaded there); under LH_DATA_DIR the packaged app must never
	 * try to cache inside its own bundle. */
	modelCache: process.env.LH_DATA_DIR ? path.join(DATA_ROOT, "models") : null,
} as const;

// ─── Models ────────────────────────────────────────────────────────────────
// THE single place every LLM is chosen and tuned. .env stays for secrets
// (API keys) only — model choice and thinking budget are product tuning,
// not deployment environment, and this section is the one place they grow.
// `effort` is pi's thinking-level scale (off|minimal|low|medium|high|xhigh
// |max): the per-model truth lives in pi-ai's catalog (thinkingLevelMap) —
// getSupportedThinkingLevels(model) lists what a model actually accepts,
// and streamSimple clamps any other value to the nearest supported one
// (e.g. GLM-5.3-flash supports exactly low|high|max).

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSpec {
	/** OpenRouter model id (e.g. "z-ai/glm-5.3-flash") — must exist in pi-ai's catalog. */
	model: string;
	/** Thinking budget — what the model may spend on reasoning tokens. */
	effort: ThinkingLevel;
}

export const MODELS = {
	/** The prober (agent A) — edge-bracketing questions; keep it lively and adaptive. */
	prober: { model: "z-ai/glm-5.3-flash", effort: "low" },
	/** The teacher (agent B) — planning + streaming, lesson-facing: smart, but keep it lively. */
	teacher: { model: "z-ai/glm-5.3-flash", effort: "low" },
	/** Background sub-agents: fast and cheap beats deep thought. */
	researcher: { model: "z-ai/glm-5.3-flash", effort: "low" },
	demoBuilder: { model: "z-ai/glm-5.3-flash", effort: "low" },
	/** Must be vision-capable: it looks at rendered SVGs. */
	visualMaker: { model: "qwen/qwen3.8-flash", effort: "low" },
	/** Extraction is judgment over given evidence — light thinking suffices. */
	extractor: { model: "z-ai/glm-5.3-flash", effort: "low" },
	/** The auditor verifies evidence exists; keep it cheap. */
	auditor: { model: "z-ai/glm-5.3-flash", effort: "low" },
	/** Names detected communities — one singular call, given member names
	 * + statements. Purely a labeling flourish; keep it cheap. */
	labeler: { model: "z-ai/glm-5.3-flash", effort: "low" },
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
/**
 * The extraction trigger (vision-extraction-coverage.md, 2026-09-15): a run
 * fires when a chat's UNCOVERED transcript tokens reach the chunk budget.
 * Runs are token-budgeted batches of the oldest uncovered messages — this
 * knob is the transcript share of the extractor's context (it also carries
 * the whole graph + instructions), so it bounds both cost and chunk size.
 * Replaces the old every-3-quiz-answers trigger, which never fired for
 * quiz-less sessions.
 */
export const EXTRACTION = { chunkTokens: 4096 } as const;

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
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry;
	 *  the checkpoint's replacement for chat extractions — notes keep
	 *  sessions.jsonl, whole-file as they are). */
	coverage: path.join(PATHS.graph, "coverage.jsonl"),
	/** LLM-named community records (contracts/graph.ts ClusterLabeling). */
	clusterLabels: path.join(PATHS.graph, "cluster-labels.jsonl"),
} as const;

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export const SOURCES_FILE = path.join(PATHS.graph, "sources.json");
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export const POSITIONS_FILE = path.join(PATHS.graph, "positions.json");

/** The embedding ledger: one L2-normalized vector per node id, all from
 * ONE model (swapping models re-embeds everything — vectors from
 * different models live in incompatible spaces). Read-modify-write
 * JSON like positions/sources. */
export const EMBEDDINGS_FILE = path.join(PATHS.graph, "embeddings.json");

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/render-settings.ts.
 */
export const RENDER_SETTINGS_FILE = path.join(PATHS.graph, "render-settings.json");

/**
 * DEFAULT settings — THE default model + thinking level + knowledge-context
 * budget (owner, 2026-09-18): the new-session surfaces' controls are the
 * settings page for the default model. There is NO baked-in default —
 * BYOK first boot shows "no model" until the user picks one, and their
 * last choice IS the default from then on. One small JSON blob,
 * read-modify-write, written only through app/api/settings/defaults.
 */
export const DEFAULT_SETTINGS_FILE = path.join(DATA_ROOT, "default-settings.json");
