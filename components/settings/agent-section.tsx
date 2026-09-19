"use client";
/**
 * The Agent section (thin settings wave): background-role model overrides,
 * the tool toggles, and the prompt override switches — three blocks, ONE
 * section (PUT /api/settings/agent replaces the whole agent object, so
 * every change composes models+tools+prompts together from the record).
 *
 * Tools — the owner's final list (2026-09-19): research, demo, visual, pdf.
 * Absent key = enabled in the schema; the UI writes explicit booleans for
 * all four (simpler to reason about, sanitize-equivalent).
 *
 * Models: each of the six background roles gets a Default option (absent
 * override = config.ts's pin) plus the /api/models catalog. The thinking
 * select shows the CHOSEN model's supported levels when a model override
 * exists; without one the factory model is unknown client-side, so the
 * standard levels list (the server sanitizer accepts any valid level).
 *
 * Prompts: GET /api/settings/prompts segments; the switch requires an
 * override FILE (route-enforced), the text writes through the segment
 * route. Switch state lives in this section's PUT; text does not.
 */

import { useEffect, useState } from "react";
import {
	BACKGROUND_MODEL_ROLES,
	type AgentSettings,
	type BackgroundModelRole,
} from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelCatalogEntry } from "@/src/core";
import { SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

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

	// The catalog + the prompt segments — one fetch each per page load.
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

	const segmentRow = (info: SegmentInfo) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					hint={fileExists ? undefined : "no override file — write one below to enable the switch"}
					testid={`prompt-row-${info.path}`}
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
			{/* ── Models ── */}
			{BACKGROUND_MODEL_ROLES.map((role) => {
				const override = agent?.models?.[role];
				const modelId = override?.model?.id ?? "";
				const thinking = override?.thinkingLevel ?? "";
				const chosen = catalog?.find((m) => m.id === modelId);
				const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
				return (
					<SettingsRow
						key={role}
						label={ROLE_LABEL[role]}
						hint={modelId ? undefined : "Default — the config pin applies"}
						testid={`role-row-${role}`}
					>
						<span className="flex items-center gap-2">
							<ThinSelect
								value={modelId}
								ariaLabel={`${ROLE_LABEL[role]} model`}
								testid={`role-model-${role}`}
								onChange={(id) => onSectionChange(composeRoleModel(agent, role, id, thinking))}
							>
								<option value="">Default</option>
								{/* The stored id stays VISIBLE even when the catalog
								    hasn't loaded (SSR) or no longer contains it —
								    a select that silently shows "Default" over a
								    live override would lie about the record. */}
								{modelId && !catalog?.some((m) => m.id === modelId) && (
									<option value={modelId}>{modelId}</option>
								)}
								{catalog?.map((m) => (
									<option key={m.id} value={m.id}>
										{m.name}
									</option>
								))}
							</ThinSelect>
							<ThinSelect
								value={thinking}
								ariaLabel={`${ROLE_LABEL[role]} thinking`}
								testid={`role-thinking-${role}`}
								onChange={(level) => onSectionChange(composeRoleModel(agent, role, modelId, level))}
							>
								<option value="">Default</option>
								{levels.map((l) => (
									<option key={l} value={l}>
										{l}
									</option>
								))}
							</ThinSelect>
						</span>
					</SettingsRow>
				);
			})}

			{/* ── Tools ── */}
			{TOGGLE_TOOLS.map((id) => (
				<SettingsRow key={id} label={`Tool · ${id}`} testid={`tool-row-${id}`}>
					<Toggle
						checked={agent?.tools?.[id] ?? true}
						label={`tool ${id}`}
						onChange={(on) => onSectionChange(composeTool(agent, id, on))}
					/>
				</SettingsRow>
			))}

			{/* ── Prompts ── */}
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
		</>
	);
}