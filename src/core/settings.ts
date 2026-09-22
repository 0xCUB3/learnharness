/**
 * THE USER SETTINGS RECORD's shape + sanitizer (settings-storage wave,
 * 2026-09-19): one versioned, DELTA-shaped record at the data-dir seam
 * (config.SETTINGS_FILE) holding every non-secret product preference.
 *
 * DELTA SEMANTICS (owner decision, 2026-09-19): the record stores EXPLICIT
 * user choices only — ABSENT keys resolve to the factory defaults compiled
 * into this module (FACTORY_SETTINGS). MODELS are the exception (owner,
 * 2026-09-22 — BYOK all the way down): no factory pins exist, so an absent
 * model key resolves to EMPTY and the per-need gates refuse honestly. A
 * software update that ADDS a knob (new
 * tool, new role, new appearance field) therefore needs no migration: old
 * records simply lack the new keys. `version` is a PRIVATE schema counter
 * for BREAKING shape changes only (field renamed / meaning changed) —
 * unrelated to the app release version. Migrations live in the adapter
 * (src/store/settings.ts), not here.
 *
 * Sanitizer contract (mirrors render-settings.ts discipline): whatever
 * arrives from disk or the network passes through sanitizeUserSettings
 * before use — never trusted raw. Strict on known fields, PRESERVES
 * unknown keys verbatim (a newer record must never be destroyed by an
 * older app reading it). Invalid known values degrade gracefully:
 * out-of-range numbers CLAMP, wrong-typed/invalid fields DROP (resolve to
 * factory default), never throw.
 *
 * Browser-safe: pure logic + types only, no node imports. The resolved
 * (fully concrete) view lives in settings-resolution.ts.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRole } from "../../config.ts";
import type { ChatSettings } from "./contracts/chat.ts";
import type { SearchEngineId } from "./search.ts";

/** The schema version this code understands. Bump ONLY for breaking shape
 *  changes (a field renamed/meaning changed); pure additions never bump. */
export const CURRENT_SETTINGS_VERSION = 1;

/** The background-agent roles whose models the Agent settings expose.
 *  The conversation pair (prober/teacher) stays out — chat-controlled via
 *  the strong slot (one controller, the model picker). Tests pin the set. */
export const BACKGROUND_MODEL_ROLES = [
	"researcher",
	"demoBuilder",
	"visualMaker",
	"extractor",
	"auditor",
	"labeler",
] as const;

export type BackgroundModelRole = (typeof BACKGROUND_MODEL_ROLES)[number];

/** A per-role model/thinking override — every field independent (absent
 *  field = that aspect falls back to config.ts's pin for the role). */
export interface RoleModelOverride {
	/** The model swap: both coordinates or neither (mirrors ChatSettings.model). */
	model?: { provider: string; id: string };
	/** The thinking budget swap. */
	thinkingLevel?: ThinkingLevel;
}

// ─── Model slots (model slots wave, 2026-09-20) ──────────────────────────────

/** The capability tiers a user can pin models into (owner-settled mapping):
 *  strong = prober + teacher (also the per-session default-teacher
 *  starting point); cheap = researcher, demo-builder, extractor, auditor,
 *  labeler; vision = visual-maker + pdf-reader. Resolution per role:
 *  ROLE OVERRIDE → slot → factory pin. */
export const MODEL_SLOTS = ["strong", "cheap", "vision"] as const;
export type ModelSlotName = (typeof MODEL_SLOTS)[number];

/** The machine-readable NOT-CONFIGURED refusal envelope (owner, 2026-09-22):
 *  every per-need gate — the turn gate in chat-handler, a job spawn, a
 *  notes import — refuses with this exact shape. HTTP callers get 503 +
 *  this JSON; in-band consumers (the job record's error field) carry the
 *  human `error` line. `missing` names the slot TIER(S) the refused
 *  action needs and found unset. */
export const MODELS_NOT_CONFIGURED_CODE = "models_not_configured" as const;
export interface ModelsNotConfigured {
	/** Human-readable — safe to render as-is. */
	error: string;
	/** The machine discriminator the client switches on. */
	code: typeof MODELS_NOT_CONFIGURED_CODE;
	/** Which slot tiers the refused action needs ("strong" | "cheap" | "vision"). */
	missing: ModelSlotName[];
}
export function modelsNotConfigured(missing: ModelSlotName[]): ModelsNotConfigured {
	return {
		error: "No model configured — set up your models first",
		code: MODELS_NOT_CONFIGURED_CODE,
		missing,
	};
}
/** The typed throw for in-process seams (extraction pipeline): callers
 *  catch it to skip honestly (trigger) or surface the 503 envelope
 *  (routes) instead of logging a failure. */
export class ModelsNotConfiguredError extends Error {
	readonly envelope: ModelsNotConfigured;
	constructor(missing: ModelSlotName[]) {
		super(modelsNotConfigured(missing).error);
		this.name = "ModelsNotConfiguredError";
		this.envelope = modelsNotConfigured(missing);
	}
}

/** One slot's stored state. BYOK (owner, 2026-09-22): the WRITE side
 *  requires model (a level alone can never run — no factory floor); the
 *  sanitizer keeps whatever is on disk, but RESOLUTION treats a slot
 *  without a model as unset (inert level, no phantom default). */
export interface ModelSlot {
	/** The model swap: both coordinates or neither. */
	model?: { provider: string; id: string };
	/** The thinking budget swap. */
	thinkingLevel?: ThinkingLevel;
}

/** The `models` settings section (owner decision 2026-09-20: a dedicated
 *  section — slots are engine-level choices, not one session's). All slots
 *  optional: an absent slot means every role of its tier runs whatever the
 *  deeper tiers of the chain resolve to (per-role override → factory pin). */
export interface ModelsSettings {
	strong?: ModelSlot;
	cheap?: ModelSlot;
	vision?: ModelSlot;
}

/** First-run gate (model-slots wave, owner 2026-09-20): the app refuses
 *  to start chats until the user has actively picked all three slots —
 *  there ARE no defaults for 33 providers; a configured app is one whose
 *  models section carries a model in every slot. Thinking levels stay
 *  optional (absent = the resolved tier's budget). */
export function slotsConfigured(models: ModelsSettings | undefined): boolean {
	return Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model);
}

/** Which slot a role draws from (model slots wave, 2026-09-20). Includes the
 *  conversation pair and pdfReader (not BackgroundModelRoles — the slot
 *  tier spans every role; only background roles surface per-role overrides). */
export const ROLE_SLOT: Readonly<Record<ModelRole, ModelSlotName>> = {
	prober: "strong",
	teacher: "strong",
	researcher: "cheap",
	demoBuilder: "cheap",
	extractor: "cheap",
	auditor: "cheap",
	labeler: "cheap",
	visualMaker: "vision",
	pdfReader: "vision",
};

/** General settings — app-level behavior. Version DISPLAY and plans login
 *  live outside the record (package.json / auth.json) by owner decision. */
export interface GeneralSettings {
	/** Auto-update the app (default ON). Mechanism ships in a later wave. */
	autoUpdate?: boolean;
}

/** Agent settings — everything about the non-conversation machinery. */
export interface AgentSettings {
	/** Background-role model/thinking overrides (absent role = config pin). */
	models?: Partial<Record<BackgroundModelRole, RoleModelOverride>>;
	/** Tool toggles keyed by tool id (absent key = enabled). User-level
	 *  only — no per-chat override (owner decision 2026-09-19). */
	tools?: Record<string, boolean>;
	/** Search-engine preference (search wave, 2026-09-20). OPTIONAL by
	 *  owner decision: setting a key auto-activates its engine — the user
	 *  never chooses an engine to make search work. An explicit choice only
	 *  pins the preference (e.g. when BOTH keys are present); the chosen
	 *  engine must still have its key, else search is honestly unavailable.
	 *  Absent + no key = unavailable (no silent fallback, no default). */
	search?: { engine?: SearchEngineId };
	/** System-prompt override SWITCHES keyed by segment path (absent key =
	 *  off). Switch-on requires the override file to exist (enforced by the
	 *  route); the switch is explicit so users keep a file on disk but run
	 *  the source default to compare (owner decision 2026-09-19). */
	prompts?: Record<string, boolean>;
}

/** Markdown-rendering knobs — the bare-bones set (owner decision). */
export interface MdRenderingSettings {
	/** Heading font weight (100–900, default 900). CSS resolves the nearest
	 *  available weight of the chosen font — no font introspection needed. */
	headingWeight?: number;
	/** Color for **bold** spans (default #ffffff). */
	boldColor?: string | null;
	/** Color for *italic* spans (default #ffffff). */
	italicColor?: string | null;
}

/** Appearance settings — mode, colors, type, markdown emphasis. */
export interface AppearanceSettings {
	/** "dark" | "light" (default dark). */
	mode?: "dark" | "light";
	/** The one user-chosen color; everything else derives per-mode in code.
	 *  null = the mode's default background. */
	background?: string | null;
	/** The main reading font (everything that is Source Sans 3 today), by
	 *  name — user-chosen from installed fonts. null = Source Sans 3. */
	fontFamily?: string | null;
	/** Reading font size in px (12–24, default 16). Headings render as
	 *  multiples of this, so one knob scales the document coherently. */
	proseFontSize?: number;
	/** Session names in CMU Serif (default true — today's look). */
	sessionNameSerif?: boolean;
	mdRendering?: MdRenderingSettings;
}

/** Knowledge-graph settings — a strict dependency ladder (owner decision
 *  2026-09-19): graph → embedding → clustering → labeling, each rung only
 *  meaningful when its parent is on (the UI grays dependents out; stored
 *  values persist but resolve inert). All default true. */
export interface GraphSettings {
	/** MASTER: off = no extraction, no auditor, no embedding, no
	 *  graph-context injection, no clustering. Data stays stored. */
	enabled?: boolean;
	/** Vector embedding + graph-context injection (consumes vectors even
	 *  without clustering — hence its own rung). */
	embedding?: boolean;
	/** Cluster computation + settle (needs embedding). */
	clustering?: boolean;
	/** The LLM cluster-namer (needs clustering). */
	labeling?: boolean;
}

/** THE record. Every section optional (delta); unknown top-level keys are
 *  preserved verbatim by the sanitizer (forward-compat with newer records). */
export interface UserSettings {
	version: number;
	general?: GeneralSettings;
	/** Today's default-settings.json content — the new-session surfaces'
	 *  controls. NOT shown in the settings panel (owner decision). */
	chat?: ChatSettings;
	agent?: AgentSettings;
	/** The strong/cheap/vision model slots (model slots wave, 2026-09-20). */
	models?: ModelsSettings;
	appearance?: AppearanceSettings;
	graph?: GraphSettings;
	[key: string]: unknown;
}

/** Factory defaults for everything core can pin (owner decisions
 *  2026-09-19). NO factory models exist anywhere (owner, 2026-09-22 — BYOK
 *  all the way down): the chat section and every slot stay empty until the
 *  user picks, and the per-need gates refuse honestly; tools default on;
 *  prompts default off — hence their absence here. */
export interface FactorySettings {
	version: number;
	general: Required<GeneralSettings>;
	appearance: {
		mode: "dark" | "light";
		background: string | null;
		fontFamily: string | null;
		proseFontSize: number;
		sessionNameSerif: boolean;
		mdRendering: {
			headingWeight: number;
			boldColor: string | null;
			italicColor: string | null;
		};
	};
	graph: Required<GraphSettings>;
}

export const FACTORY_SETTINGS: FactorySettings = {
	version: CURRENT_SETTINGS_VERSION,
	general: { autoUpdate: true },
	appearance: {
		mode: "dark",
		background: null, // the dark default (#141414) lives in the mode's derivation curve
		fontFamily: null, // Source Sans 3
		proseFontSize: 16,
		sessionNameSerif: true,
		mdRendering: { headingWeight: 900, boldColor: null, italicColor: null },
	},
	graph: { enabled: true, embedding: true, clustering: true, labeling: true },
};

// ─── Sanitizer ─────────────────────────────────────────────────────────────

const PROSE_FONT_MIN = 12;
const PROSE_FONT_MAX = 24;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** #rgb / #rrggbb (case-insensitive) — the only color format we accept. */
export function isHexColor(value: string): boolean {
	return /^#[0-9a-fA-F]{3}$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Coerce an arbitrary hex-or-null field: null and valid hex pass through,
 *  anything else becomes null (the factory/per-mode default). */
function sanitizeHexOrNull(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value === "string" && isHexColor(value)) return value;
	return null;
}

const boolOrDrop = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;

function sanitizeGeneral(raw: Record<string, unknown>): GeneralSettings {
	const out: GeneralSettings = {};
	const autoUpdate = boolOrDrop(raw.autoUpdate);
	if (autoUpdate !== undefined) out.autoUpdate = autoUpdate;
	return out;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function sanitizeRoleOverride(raw: unknown): RoleModelOverride | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: RoleModelOverride = {};
	if (
		typeof r.model === "object" &&
		r.model !== null &&
		!Array.isArray(r.model) &&
		typeof (r.model as Record<string, unknown>).provider === "string" &&
		typeof (r.model as Record<string, unknown>).id === "string"
	) {
		out.model = {
			provider: (r.model as { provider: string }).provider,
			id: (r.model as { id: string }).id,
		};
	}
	if (typeof r.thinkingLevel === "string" && THINKING_LEVELS.includes(r.thinkingLevel as ThinkingLevel)) {
		out.thinkingLevel = r.thinkingLevel as ThinkingLevel;
	}
	return Object.keys(out).length ? out : undefined;
}

/** The models section (model slots wave, 2026-09-20): each slot keeps
 *  only well-formed parts — the same shape rules as a role override, so a
 *  stale client can't park junk in a slot. */
function sanitizeModels(raw: Record<string, unknown>): ModelsSettings {
	const out: ModelsSettings = {};
	for (const slot of MODEL_SLOTS) {
		const cleaned = sanitizeRoleOverride(raw[slot]);
		if (cleaned) out[slot] = cleaned;
	}
	return out;
}

function sanitizeBooleanMap(raw: unknown): Record<string, boolean> | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "boolean") out[key] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

function sanitizeAgent(raw: Record<string, unknown>): AgentSettings {
	const out: AgentSettings = {};
	if (raw.models !== null && typeof raw.models === "object" && !Array.isArray(raw.models)) {
		const models: Partial<Record<BackgroundModelRole, RoleModelOverride>> = {};
		for (const [role, override] of Object.entries(raw.models as Record<string, unknown>)) {
			if ((BACKGROUND_MODEL_ROLES as readonly string[]).includes(role)) {
				const cleaned = sanitizeRoleOverride(override);
				if (cleaned) models[role as BackgroundModelRole] = cleaned;
			}
		}
		if (Object.keys(models).length) out.models = models;
	}
	const tools = sanitizeBooleanMap(raw.tools);
	if (tools) out.tools = tools;
	const prompts = sanitizeBooleanMap(raw.prompts);
	if (prompts) out.prompts = prompts;
	// Search preference: lenient read side (an unknown engine id drops;
	// the write side's parser is strict — a stale client can't brick the
	// record, it just loses the pin and auto-detection resumes).
	if (raw.search !== null && typeof raw.search === "object" && !Array.isArray(raw.search)) {
		const engine = (raw.search as Record<string, unknown>).engine;
		if (engine === "tavily" || engine === "brave") out.search = { engine };
	}
	return out;
}

function sanitizeMdRendering(raw: unknown): MdRenderingSettings {
	const out: MdRenderingSettings = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	const r = raw as Record<string, unknown>;
	if (typeof r.headingWeight === "number" && Number.isFinite(r.headingWeight)) {
		out.headingWeight = clamp(Math.round(r.headingWeight), 100, 900);
	}
	if (r.boldColor !== undefined) out.boldColor = sanitizeHexOrNull(r.boldColor);
	if (r.italicColor !== undefined) out.italicColor = sanitizeHexOrNull(r.italicColor);
	return out;
}

function sanitizeAppearance(raw: Record<string, unknown>): AppearanceSettings {
	const out: AppearanceSettings = {};
	if (raw.mode === "dark" || raw.mode === "light") out.mode = raw.mode;
	if (raw.background !== undefined) out.background = sanitizeHexOrNull(raw.background);
	if (raw.fontFamily !== undefined) {
		out.fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily : null;
	}
	if (typeof raw.proseFontSize === "number" && Number.isFinite(raw.proseFontSize)) {
		out.proseFontSize = clamp(Math.round(raw.proseFontSize), PROSE_FONT_MIN, PROSE_FONT_MAX);
	}
	const sessionNameSerif = boolOrDrop(raw.sessionNameSerif);
	if (sessionNameSerif !== undefined) out.sessionNameSerif = sessionNameSerif;
	if (raw.mdRendering !== undefined) out.mdRendering = sanitizeMdRendering(raw.mdRendering);
	return out;
}

function sanitizeGraph(raw: Record<string, unknown>): GraphSettings {
	const out: GraphSettings = {};
	const enabled = boolOrDrop(raw.enabled);
	if (enabled !== undefined) out.enabled = enabled;
	const embedding = boolOrDrop(raw.embedding);
	if (embedding !== undefined) out.embedding = embedding;
	const clustering = boolOrDrop(raw.clustering);
	if (clustering !== undefined) out.clustering = clustering;
	const labeling = boolOrDrop(raw.labeling);
	if (labeling !== undefined) out.labeling = labeling;
	return out;
}

/**
 * Coerce arbitrary JSON (disk file, network body) into a valid delta record:
 * known fields validated strictly (invalid ones drop/clamp per module doc),
 * UNKNOWN KEYS PRESERVED VERBATIM (a newer record must survive an older
 * app). Never throws. Non-objects → null.
 */
export function sanitizeUserSettings(raw: unknown): UserSettings | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out: UserSettings = {
		version: typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 1 ? r.version : CURRENT_SETTINGS_VERSION,
	};
	if (r.general !== null && typeof r.general === "object" && !Array.isArray(r.general)) {
		out.general = sanitizeGeneral(r.general as Record<string, unknown>);
	}
	if (r.chat !== null && typeof r.chat === "object" && !Array.isArray(r.chat)) {
		// The chat section is ChatSettings — its fields are plain and the
		// section is written exclusively through the validated route
		// (parseSettingsBody + validateChatSettings), so pass through as-is;
		// a hand-corrupted value fails loudly downstream, same as today.
		out.chat = r.chat as ChatSettings;
	}
	if (r.agent !== null && typeof r.agent === "object" && !Array.isArray(r.agent)) {
		out.agent = sanitizeAgent(r.agent as Record<string, unknown>);
	}
	if (r.appearance !== null && typeof r.appearance === "object" && !Array.isArray(r.appearance)) {
		out.appearance = sanitizeAppearance(r.appearance as Record<string, unknown>);
	}
	if (r.models !== null && typeof r.models === "object" && !Array.isArray(r.models)) {
		const models = sanitizeModels(r.models as Record<string, unknown>);
		if (Object.keys(models).length) out.models = models;
	}
	if (r.graph !== null && typeof r.graph === "object" && !Array.isArray(r.graph)) {
		out.graph = sanitizeGraph(r.graph as Record<string, unknown>);
	}
	// Unknown top-level keys ride along untouched (forward-compat).
	for (const [key, value] of Object.entries(r)) {
		if (!(key in out)) out[key] = value;
	}
	return out;
}
