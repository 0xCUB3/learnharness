"use client";
/**
 * The Agent section (settings-app wave): the THREE MODEL SLOTS, the tool
 * toggles + the search-engine preference, and the prompt override
 * switches — three GROUPS (owner, 2026-09-20: clear separation — Models /
 * Tools / System prompts).
 *
 * Model slots (model-slots wave, 2026-09-20, owner ruling: SLOTS ONLY —
 * the six per-role rows disappeared; per-role overrides remain in the
 * schema for a future advanced surface): Strong = Prober + Teacher, Cheap
 * = the five workhorse roles, Vision = Visual maker + PDF reader. Each
 * slot row carries the shared dropdown (fuzzy search, arrow-walk, Enter
 * pick — ModelMenuList/ThinkingMenuList from ./model-menu.tsx) over the
 * FEDERATED catalog (/api/models serves only keyed providers, fresh per
 * call — saving a key in Keys immediately widens this picker). The
 * vision slot filters to image-capable models (Model.input). The slots
 * live in the `models` settings section (PUT /api/settings/models — slot
 * pins are engine-level, not per-chat); the rest of the section writes
 * the `agent` section as before. Resolution per tier: slot override →
 * factory pin (GET /api/models' `slots` — resolved, cannot drift from
 * what runs). The Default row clears the slot override; a stored id stays
 * VISIBLE even when its provider's key lapsed out of the catalog — a
 * trigger showing "Default" over a live override would lie about the
 * record.
 *
 * Search engine (search wave, 2026-09-20, owner: no default — an engine
 * is live iff its key is present; with a key the engine AUTO-activates,
 * the explicit choice is only a preference between live engines): a row
 * in the Tools group, Tavily / Brave via the same shared-menu look, with
 * the live reason line from /api/search. No engine key at all → the row
 * grays whole-row (a choice without a key would only BLOCK the other
 * engine's auto-activation).
 *
 * Tools — the owner's final list (2026-09-19): research, demo, visual, pdf.
 * Absent key = enabled in the schema; the UI writes explicit booleans for
 * all four (simpler to reason about, sanitize-equivalent).
 *
 * Prompts: GET /api/settings/prompts segments; the switch requires an
 * override FILE (route-enforced), so a file-less row dims whole-row
 * (graph-view graying) until one is written. Switch state lives in this
 * section's PUT; text writes through the segment route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsSaved } from "@/components/settings-signal";
import { defaultOrderLevel, populateLevel } from "@/components/thinking-default";
import type React from "react";
import {
	MODEL_SLOTS,
	type AgentSettings,
	type ModelCatalogEntry,
	type ModelSlotName,
	type ModelsSettings,
} from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";
import { ModelMenuList, ThinkingMenuList } from "./model-menu";

/** One slot's display identity — the tier's roster as the row hint rides
 *  with the resolved default (owner: the hint ALWAYS names the default). */
const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Strong", roster: "Prober + Teacher" },
	cheap: { label: "Cheap", roster: "Researcher, demo builder, extractor, auditor, labeler" },
	vision: { label: "Vision", roster: "Visual maker + PDF reader" },
};

/** The search engines this wave ships (src/core/search.ts) + their labels. */
const SEARCH_ENGINES = ["tavily", "brave"] as const;

/** The owner's final toggleable-tool list (confirm with the user before
 *  changing — the Teacher stream settled this 2026-09-19). */
export const TOGGLE_TOOLS = ["research", "demo", "visual", "pdf"] as const;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** SegmentInfo as GET /api/settings/prompts returns it. */
interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}

/** The GET /api/models response fields this section consumes. */
interface ModelsBody {
	models: ModelCatalogEntry[];
	/** The three tiers' RESOLVED pins (BYOK: NULL per unset tier — no
	 *  factory floor) — machinery only (the thinking list fallback); the
	 *  rows' displays read the record override, never a phantom pin. */
	slots: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: string } | null>;
}

/** Compose: one tool toggled, the rest of the section carried verbatim.
 *  Pure — exported for tests. */
export function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, [id]: on } };
}

/** The research tool runs on the search port — the teacher registry DROPS
 *  it when no engine is live (chat-handler's searchAvailable, the same
 *  /api/search signal the section fetches). Pure — exported for tests.
 *  Teacher-stream flag 2026-09-22: the settings row grays on the SAME
 *  signal, so the row and the actual registry availability can never
 *  disagree. `search === null` (loading/failed) grays NOTHING. */
export function researchToolUnavailable(
	toolId: string,
	search: { available: boolean } | null,
): boolean {
	return toolId === "research" && search !== null && !search.available;
}

/** Compose: one slot's model/thinking override. Empty model = absent
 *  override (Default — falls to the factory pin); empty thinking = the
 *  tier keeps its resolved thinking budget. Per-field independence, same
 *  as the schema's ModelSlot. Pure — exported for tests. */
export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const prev = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(provider && id ? { model: { provider, id } } : prev?.model ? { model: prev.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}

/** Compose: the search-engine preference. null = the explicit pin is
 *  REMOVED (auto-activation takes over — the schema's resting state).
 *  Pure — exported for tests. */
export function composeSearchEngine(
	agent: AgentSettings | undefined,
	engine: (typeof SEARCH_ENGINES)[number] | null,
): AgentSettings {
	if (engine === null) {
		if (!agent?.search) return { ...agent };
		const { search: _drop, ...rest } = agent;
		return { ...rest } as AgentSettings;
	}
	return { ...agent, search: { engine } };
}

/** Compose: one prompt switch. on = explicit true; off = key REMOVED
 *  (absent = off is the schema's resting state; explicit false is the
 *  same thing but noisier). Pure — tests. */
export function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}

/** The collapsed select look (owner: "the look of the collapsed menu is
 *  good") — now a button that opens the shared model-picker dropdown. */
function MenuTrigger({
	value,
	emptyLabel,
	ariaLabel,
	testid,
	open,
	onClick,
	widthClass,
	disabled,
}: {
	value: string;
	/** What the trigger shows when there is no override ("Default"). */
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
	/** Owner (2026-09-20): the thinking trigger is FIXED at the width the
	 *  Default state needs (values shifting it mid-edit shifted the row);
	 *  the model trigger takes the same width as a MINIMUM — its values
	 *  genuinely vary in length. */
	widthClass: string;
	/** The no-key search state grays the whole row; the trigger follows. */
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			aria-expanded={open}
			data-testid={testid}
			onClick={() => {
				if (!disabled) onClick();
			}}
			className={`flex h-7 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors ${
				disabled ? "cursor-not-allowed" : "hover:border-muted-foreground/50"
			} ${widthClass}`}
		>
			<span className="min-w-0 flex-1 truncate">{value || emptyLabel}</span>
			<span aria-hidden className="text-muted-foreground">
				▾
			</span>
		</button>
	);
}

/* The section's dropdowns all mount the shared MenuShell (fix wave chunk
 * B): portaled to document.body, fixed-anchored to the open trigger by
 * testid (the section's one-ref pattern), opening DOWN with the shell's
 * viewport cap and auto-flip. data-lh-menu rides the shell — the
 * outside-click contract's exemption mark. */

export function AgentSection({
	agent,
	models,
	onSectionChange,
	onModelsChange,
}: {
	agent: AgentSettings | undefined;
	/** The `models` section (slot pins — engine-level, PUT /api/settings/models). */
	models: ModelsSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onSectionChange: (next: AgentSettings) => void;
	/** Writes the composed models section (slots — replace-PUT discipline). */
	onModelsChange: (next: ModelsSettings) => void;
}) {
	const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
	/** The three tiers' resolved pins — GET /api/models `slots`. The rows'
	 *  Default hints and thinking lists resolve from it. */
	const [slots, setSlots] = useState<ModelsBody["slots"] | null>(null);
	/** The live search state (/api/search) — the row's reason line. */
	const [search, setSearch] = useState<{ available: boolean; engine: string | null; reason: string } | null>(null);
	/** Which search engines have a key (/api/keys) — the no-keys-anywhere
	 *  state grays the row; per-engine marks ride the menu rows. */
	const [engineKeys, setEngineKeys] = useState<Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>>>({});
	const [prompts, setPrompts] = useState<{ prober: SegmentInfo[]; teacher: SegmentInfo[] } | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>({});
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);
	/** One open dropdown for the whole section: which slot (or the search
	 *  row), which kind. */
	const [openMenu, setOpenMenu] = useState<{ target: ModelSlotName | "search"; kind: "model" | "thinking" | "engine" } | null>(null);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	const refreshSearch = () =>
		fetch("/api/search")
			.then((r) => r.json())
			.then((body: { available: boolean; engine: string | null; reason: string }) => setSearch(body))
			.catch(() => setSearch(null));

	// The catalog (federated: keyed providers only), the resolved slots,
	// the prompt segments, and the search engines' key presence — one
	// fetch each per section mount. The models read ALSO re-runs on the
	// cross-surface signal (fix wave: another surface's write re-reads
	// into the slot rows live).
	const readModels = useCallback(() => {
		fetch("/api/models")
			.then((r) => r.json())
			.then((body: ModelsBody) => {
				setCatalog(body.models);
				setSlots(body.slots);
			})
			.catch(() => setCatalog(null));
	}, []);

	useSettingsSaved((section) => {
		if (section === "models") readModels();
	});

	useEffect(() => {
		readModels();
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => setPrompts(null));
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys: { id: string; present: boolean }[] }) => {
				const present: Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>> = {};
				for (const id of SEARCH_ENGINES) {
					const envVar = id === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
					present[id] = body.keys.some((k) => k.id === envVar && k.present);
				}
				setEngineKeys(present);
			})
			.catch(() => {});
	}, []);

	// The reason line re-reads /api/search AFTER an engine write lands —
	// the write updates the `agent` prop (the dialog's record mirror), so
	// keying on the pin avoids the race where the fetch beat the PUT and
	// the hint contradicted the trigger it sits under.
	useEffect(() => {
		refreshSearch();
	}, [agent?.search?.engine]);

	// The dropdown contract (the chat model selector's, mirrored): any
	// click outside the open menu — or an Esc — closes it. Esc is CLAIMED
	// with stopPropagation so the settings dialog behind does NOT also
	// close. A pointerdown on the backdrop is left for the dialog (its own
	// click closes everything); a click inside the dialog just closes us.
	useEffect(() => {
		if (openMenu === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setOpenMenu(null);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpenMenu(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openMenu]);

	async function saveSegment(path: string, text: string) {		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			setSegmentStatus(`Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
			return;
		}
		// Refetch: file presence gates the switch, so the view must track it.
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body));
		setSegmentStatus(`Saved ${path}`);
	}

	async function deleteSegment(path: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			setSegmentStatus(`Delete failed: ${res.status}`);
			return;
		}
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body));
	}

		/** The search-engine menu row — label + the quiet live-key mark. */
	const engineOption = (
		id: (typeof SEARCH_ENGINES)[number] | "auto",
		label: string,
		active: boolean,
		live: boolean | null,
		onPick: () => void,
	) => (
		<button
			key={id}
			type="button"
			data-testid={`engine-option-${id}`}
			onClick={onPick}
			className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted ${
				active ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
			}`}
		>
			<span>{label}</span>
			<span className="text-muted-foreground">
				{live === null ? (active && <span aria-hidden>✓</span>) : live ? <span aria-hidden>✓ key</span> : <span aria-hidden>· no key</span>}
			</span>
		</button>
	);

	const segmentRow = (info: SegmentInfo) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					hint={fileExists ? undefined : "no override file yet — write one below"}
					testid={`prompt-row-${info.path}`}
					dimmed={!fileExists}
				>
					<Toggle
						checked={info.enabled && fileExists}
						disabled={!fileExists}
						label={`prompt ${info.path}`}
						onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))}
					/>
				</SettingsRow>
				<button
					type="button"
					onClick={() => {
						setOpenSegment(open ? null : info.path);
						setSegmentStatus(null);
					}}
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
				>
					{open ? "Hide text" : "Show text"}
				</button>
				{open && (
					<div className="mt-1 flex flex-col gap-2">
						{info.shared && (
							<p className="text-xs text-muted-foreground/70">Shared base — appears in both agents.</p>
						)}
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Source</p>
							<textarea
								readOnly
								value={info.sourceText}
								aria-label={`source ${info.path}`}
								className="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"
							/>
						</div>
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Override</p>
							<textarea
								value={segmentDraft[info.path] ?? info.overrideText ?? ""}
								onChange={(e) => setSegmentDraft({ ...segmentDraft, [info.path]: e.target.value })}
								aria-label={`override ${info.path}`}
								placeholder="Write the override text…"
								className="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"
							/>
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")}
								className="text-xs text-foreground underline-offset-2 hover:underline"
							>
								Save override
							</button>
							{fileExists && (
								<button
									type="button"
									onClick={() => void deleteSegment(info.path)}
									className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
								>
									Delete override
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};



	return (
		<>
			<SettingsGroup label="Models" testid="group-models">
				{MODEL_SLOTS.map((slot) => {
					const override = models?.[slot];
					const modelId = override?.model?.id ?? "";
					const provider = override?.model?.provider ?? "";
					const thinking = override?.thinkingLevel ?? "";
					// The tier's resolved pin is machinery only now (owner, fix
					// wave): the UI never names the factory fallback — the hint
					// carries the roster, the triggers read "—" when unpicked — but
					// the pin still governs the thinking level LIST when no override
					// names a model to read levels from.
					const pin = slots?.[slot];
					// The model whose levels govern the thinking list: the
					// override, else the resolved pin (when it's in the federated
					// catalog); the standard ladder as the last fallback.
					const coord = override?.model ?? pin?.model;
					const chosen = coord ? catalog?.find((m) => m.id === coord.id && m.provider === coord.provider) : undefined;
					const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
					const thisMenuOpen = openMenu?.target === slot ? openMenu.kind : null;
					// Vision slots pick from image-capable models only.
					const slotCatalog =
						slot === "vision" ? catalog?.filter((m) => m.input.includes("image")) : catalog;
					return (
						<SettingsRow
							key={slot}
							label={SLOT_META[slot].label}
							hint={SLOT_META[slot].roster}
							testid={`slot-row-${slot}`}
						>
							{/* The anchor for the outside-click contract is the
							    span holding BOTH triggers of the open menu. */}
							<span
								ref={thisMenuOpen ? menuAnchorRef : undefined}
								className="relative flex items-center gap-2"
							>
								<MenuTrigger
									value={modelId ? prettyModel(modelId) : ""}
									emptyLabel="—"
									ariaLabel={`${SLOT_META[slot].label} model`}
									testid={`slot-model-${slot}`}
									open={thisMenuOpen === "model"}
									onClick={() => setOpenMenu(thisMenuOpen === "model" ? null : { target: slot, kind: "model" })}
									widthClass="min-w-20"
								/>
								<MenuTrigger
									// Legacy display (chunk 2 item 4): no stored level + a known
									// model → the RESOLVED level (the ordering's first supported —
									// what the engine build runs). Display-only until a pick writes.
									value={thinking || (chosen ? defaultOrderLevel(levels) : "")}
									emptyLabel="—"
									ariaLabel={`${SLOT_META[slot].label} thinking`}
									testid={`slot-thinking-${slot}`}
									open={thisMenuOpen === "thinking"}
									onClick={() => setOpenMenu(thisMenuOpen === "thinking" ? null : { target: slot, kind: "thinking" })}
									widthClass="w-20"
								/>
								{thisMenuOpen === "model" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-model-${slot}`}
										testid={`slot-model-menu-${slot}`}
										menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ModelMenuList
											models={slotCatalog ?? undefined}
											effectiveId={modelId}
											effectiveProvider={provider}
											onPick={(entry) => {
												// Auto-populate (chunk 2, owner: "populate everywhere"): the
												// fresh pick writes a level — the stored one rides as-is
												// (the write clamps server-side), else the ordering's level.
												const next = populateLevel(thinking || undefined, entry.supportedLevels);
												onModelsChange(composeSlotModel(models, slot, entry.provider, entry.id, next));
												setOpenMenu(null);
											}}
											footer={
												catalog && catalog.length === 0
													? "No models — add a provider key in Keys"
													: "Runs every agent of this tier"
											}
										/>
									</MenuShell>
								)}
								{thisMenuOpen === "thinking" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-thinking-${slot}`}
										testid={`slot-thinking-menu-${slot}`}
										menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ThinkingMenuList
											levels={levels.map(String)}
											// The ✓ sits on the RESOLVED level for legacy unset records —
											// the same one the trigger shows.
											effectiveLevel={thinking || (chosen ? defaultOrderLevel(levels) : undefined)}
											onPick={(level) => {
												onModelsChange(composeSlotModel(models, slot, provider, modelId, level));
												setOpenMenu(null);
											}}
										/>
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})}
			</SettingsGroup>

			<SettingsGroup label="Tools" testid="group-tools">
				{TOGGLE_TOOLS.map((id) => {
					// Research needs a live search engine; the row + toggle gray
					// on the same signal the registry drops the tool on (see
					// researchToolUnavailable). The reason rides as the hint.
					const searchDown = researchToolUnavailable(id, search);
					return (
						<SettingsRow
							key={id}
							label={`Tool · ${id}`}
							hint={searchDown ? search?.reason : undefined}
							testid={`tool-row-${id}`}
							dimmed={searchDown}
						>
							<Toggle
								checked={agent?.tools?.[id] ?? true}
								disabled={searchDown}
								label={`tool ${id}`}
								onChange={(on) => onSectionChange(composeTool(agent, id, on))}
							/>
						</SettingsRow>
					);
				})}
				{(() => {
					const engine = agent?.search?.engine ?? null;
					const anyKey = engineKeys.tavily === true || engineKeys.brave === true;
					const open = openMenu?.target === "search";
					return (
						<SettingsRow
							label="Search engine"
							hint={search?.reason ?? undefined}
							testid="search-engine-row"
							dimmed={!anyKey}
						>
							<span ref={open ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
								<MenuTrigger
									value={engine === "tavily" ? "Tavily" : engine === "brave" ? "Brave" : ""}
									emptyLabel="Automatic"
									ariaLabel="Search engine"
									testid="search-engine-trigger"
									open={open}
									onClick={() => setOpenMenu(open ? null : { target: "search", kind: "engine" })}
									widthClass="min-w-20"
									disabled={!anyKey}
								/>
								{open && (
									<MenuShell
										preferredSide="down"
											anchorTestid="search-engine-trigger"
										testid="search-engine-menu"
										menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										{engineOption("auto", "Automatic", engine === null, null, () => {
											onSectionChange(composeSearchEngine(agent, null));
											setOpenMenu(null);
										})}
										{SEARCH_ENGINES.map((id) =>
											engineOption(id, id === "tavily" ? "Tavily" : "Brave", engine === id, engineKeys[id] ?? false, () => {
												onSectionChange(composeSearchEngine(agent, id));
												setOpenMenu(null);
											}),
										)}
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})()}
			</SettingsGroup>

			<SettingsGroup label="System prompts" testid="group-prompts">
				{prompts === null ? (
					<p className="text-xs text-muted-foreground/70">Loading prompt segments…</p>
				) : (
					<div className="flex flex-col gap-4">
						{(["prober", "teacher"] as const).map((who) => (
							<div key={who}>
								<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{who}</p>
								<div className="flex flex-col gap-2">
									{prompts[who].map((info) => segmentRow(info))}
								</div>
							</div>
						))}
						{segmentStatus && <p className="text-xs text-muted-foreground/70">{segmentStatus}</p>}
					</div>
				)}
			</SettingsGroup>
		</>
	);
}
