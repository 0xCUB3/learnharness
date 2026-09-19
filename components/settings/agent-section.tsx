"use client";
/**
 * The Agent section (settings-app wave): background-role model overrides,
 * the tool toggles, and the prompt override switches — three GROUPS
 * (owner, 2026-09-20: clear separation — Models / Tools / System prompts),
 * ONE section (PUT /api/settings/agent replaces the whole agent object,
 * so every change composes models+tools+prompts together from the record).
 *
 * The role selects (owner, 2026-09-20) are the EXACT same dropdown as the
 * chat model selector — the shared ModelMenuList/ThinkingMenuList from
 * ./model-menu.tsx (fuzzy search, arrow-walk, Enter pick). The collapsed
 * trigger keeps the thin select look; the opened menu is the model
 * picker's. Menus open DOWNWARD here (the dialog sits mid-screen); the
 * chat control opens upward — the shell belongs to each mount, the body
 * is shared.
 *
 * Tools — the owner's final list (2026-09-19): research, demo, visual, pdf.
 * Absent key = enabled in the schema; the UI writes explicit booleans for
 * all four (simpler to reason about, sanitize-equivalent).
 *
 * Models: each of the six background roles defaults to config.ts's pin
 * (no override). The Default row clears the model override; the stored id
 * stays VISIBLE even when the catalog no longer contains it — a trigger
 * showing "Default" over a live override would lie about the record.
 *
 * Prompts: GET /api/settings/prompts segments; the switch requires an
 * override FILE (route-enforced), so a file-less row dims whole-row
 * (graph-view graying) until one is written. Switch state lives in this
 * section's PUT; text writes through the segment route.
 */

import { useEffect, useRef, useState } from "react";
import { BACKGROUND_MODEL_ROLES, type AgentSettings, type BackgroundModelRole, type ModelCatalogEntry } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";
import { ModelMenuList, ThinkingMenuList } from "./model-menu";

/** The role's display label — schema ids are camelCase, the label is human. */
const ROLE_LABEL: Record<BackgroundModelRole, string> = {
	researcher: "Researcher",
	demoBuilder: "Demo builder",
	visualMaker: "Visual maker",
	extractor: "Extractor",
	auditor: "Auditor",
	labeler: "Labeler",
};

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

/** Compose: one tool toggled, the rest of the section carried verbatim.
 *  Pure — exported for tests. */
export function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, [id]: on } };
}

/** Compose: one role's model/thinking override. Empty model = absent
 *  override (Default); empty thinking = thinking falls back. Pure — tests. */
export function composeRoleModel(
	agent: AgentSettings | undefined,
	role: BackgroundModelRole,
	modelId: string,
	thinking: string,
): AgentSettings {
	const prev = agent?.models?.[role];
	const models = { ...agent?.models };
	if (!modelId && !thinking) delete models[role];
	else {
		models[role] = {
			...(modelId ? { model: { provider: "openrouter", id: modelId } } : {}),
			...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
		};
	}
	return { ...agent, models };
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
}: {
	value: string;
	/** What the trigger shows when there is no override ("Default"). */
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			aria-expanded={open}
			data-testid={testid}
			onClick={onClick}
			className="flex h-7 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
		>
			<span className="max-w-52 truncate">{value || emptyLabel}</span>
			<span aria-hidden className="text-muted-foreground">
				▾
			</span>
		</button>
	);
}

export function AgentSection({
	agent,
	onSectionChange,
}: {
	agent: AgentSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onSectionChange: (next: AgentSettings) => void;
}) {
	const [catalog, setCatalog] = useState<ModelCatalogEntry[] | null>(null);
	const [prompts, setPrompts] = useState<{ prober: SegmentInfo[]; teacher: SegmentInfo[] } | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>({});
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);
	/** One open dropdown for the whole section: which role, which kind. */
	const [openMenu, setOpenMenu] = useState<{ role: BackgroundModelRole; kind: "model" | "thinking" } | null>(null);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	// The catalog + the prompt segments — one fetch each per section mount.
	useEffect(() => {
		fetch("/api/models")
			.then((r) => r.json())
			.then((body: { models: ModelCatalogEntry[] }) => setCatalog(body.models))
			.catch(() => setCatalog(null));
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { prober: SegmentInfo[]; teacher: SegmentInfo[] }) => setPrompts(body))
			.catch(() => setPrompts(null));
	}, []);

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

	async function saveSegment(path: string, text: string) {
		setSegmentStatus(null);
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

	/** The pinned Default row — clears this control's override (absent key
	 *  = config pin). Same row language as the shared menu's list rows. */
	const defaultRow = (active: boolean, onPick: () => void) => (
		<button
			type="button"
			data-testid="menu-default"
			onClick={onPick}
			className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted ${
				active ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
			}`}
		>
			<span>Default</span>
			{active && <span aria-hidden>✓</span>}
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
				{BACKGROUND_MODEL_ROLES.map((role) => {
					const override = agent?.models?.[role];
					const modelId = override?.model?.id ?? "";
					const thinking = override?.thinkingLevel ?? "";
					const chosen = catalog?.find((m) => m.id === modelId);
					// The thinking levels this role can pick: the chosen
					// model's when one is pinned; the standard list when the
					// config pin applies (the pin's model is unknown client-side).
					const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
					const thisMenuOpen =
						openMenu?.role === role ? openMenu.kind : null;
					return (
						<SettingsRow
							key={role}
							label={ROLE_LABEL[role]}
							hint={modelId ? undefined : "Default — the config pin applies"}
							testid={`role-row-${role}`}
						>
							{/* The anchor for the outside-click contract is the
							    span holding BOTH triggers of the open menu. */}
							<span
								ref={thisMenuOpen ? menuAnchorRef : undefined}
								className={`relative flex items-center gap-2 ${thisMenuOpen ? "z-10" : ""}`}
							>
								<MenuTrigger
									value={modelId ? prettyModel(modelId) : ""}
									emptyLabel="Default"
									ariaLabel={`${ROLE_LABEL[role]} model`}
									testid={`role-model-${role}`}
									open={thisMenuOpen === "model"}
									onClick={() => setOpenMenu(thisMenuOpen === "model" ? null : { role, kind: "model" })}
								/>
								<MenuTrigger
									value={thinking}
									emptyLabel="Default"
									ariaLabel={`${ROLE_LABEL[role]} thinking`}
									testid={`role-thinking-${role}`}
									open={thisMenuOpen === "thinking"}
									onClick={() => setOpenMenu(thisMenuOpen === "thinking" ? null : { role, kind: "thinking" })}
								/>
								{thisMenuOpen === "model" && (
									<div
										data-testid={`role-model-menu-${role}`}
										className="absolute top-full right-0 z-40 mt-1 flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl"
									>
										{defaultRow(
											modelId === "",
											() => {
												onSectionChange(composeRoleModel(agent, role, "", thinking));
												setOpenMenu(null);
											},
										)}
										<ModelMenuList
											models={catalog ?? undefined}
											effectiveId={modelId || undefined}
											onPick={(entry) => {
												onSectionChange(composeRoleModel(agent, role, entry.id, thinking));
												setOpenMenu(null);
											}}
											footer="Applied to every run of this role"
										/>
									</div>
								)}
								{thisMenuOpen === "thinking" && (
									<div
										data-testid={`role-thinking-menu-${role}`}
										className="absolute top-full right-0 z-40 mt-1 flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
									>
										{defaultRow(
											thinking === "",
											() => {
												onSectionChange(composeRoleModel(agent, role, modelId, ""));
												setOpenMenu(null);
											},
										)}
										<ThinkingMenuList
											levels={levels.map(String)}
											effectiveLevel={thinking || undefined}
											onPick={(level) => {
												onSectionChange(composeRoleModel(agent, role, modelId, level));
												setOpenMenu(null);
											}}
										/>
									</div>
								)}
							</span>
						</SettingsRow>
					);
				})}
			</SettingsGroup>

			<SettingsGroup label="Tools" testid="group-tools">
				{TOGGLE_TOOLS.map((id) => (
					<SettingsRow key={id} label={`Tool · ${id}`} testid={`tool-row-${id}`}>
						<Toggle
							checked={agent?.tools?.[id] ?? true}
							label={`tool ${id}`}
							onChange={(on) => onSectionChange(composeTool(agent, id, on))}
						/>
					</SettingsRow>
				))}
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