"use client";
/**
 * The Appearance + Graph sections (thin settings wave).
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and hand the delta back so the CSS
 * variables move IMMEDIATELY (the section's whole point — it must DO
 * something). Hex inputs commit on blur/Enter; the background derives the
 * raised/accent/edge palette in code (components/settings/appearance.tsx).
 * Mode is dark-only this wave: control rendered DISABLED with a note — the
 * light palette is the design wave's work, and a lying control is worse
 * than an honest disabled one.
 *
 * Graph graying (owner, 2026-09-20) follows the graph viewer's render-panel
 * convention: the whole row dims when a parent is off (stored values
 * persist but resolve inert — the switch shows stored, the dim effective).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsSaved } from "@/components/settings-signal";
import { EMBEDDING_PRICES, type AppearanceSettings, type GraphSettings } from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { useSettingsDialog } from "./settings-dialog.tsx";
import { CommitInput, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

/** One row of GET /api/models/embeddings (the live-federated BYOK
 *  catalog). The server twin is src/server/embeddings.ts's
 *  EmbeddingCatalogModel — components may not import the server layer,
 *  and the shape is exactly these two strings. */
interface EmbeddingCatalogModel {
	id: string;
	name: string;
}

/** Pure: the price line for a catalog row — USD per 1M INPUT tokens
 *  (embeddings emit no output). Unlisted models stay honestly "—"
 *  (never zero). The label convention is the model menu's. */
export function embeddingPriceLabel(id: string): string {
	const price = EMBEDDING_PRICES[id];
	if (!price) return "—";
	const fmt = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2)}`;
	return `${fmt(price.input)}/1M in`;
}

/** Pure: which ladder rungs need a configured embedding model to do
 *  anything — everything but the master switch. */
export function needsEmbeddingModel(key: "enabled" | "embedding" | "clustering" | "labeling"): boolean {
	return key !== "enabled";
}

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved } = useAppearance();
	const md = appearance?.mdRendering;

	return (
		<>
			<SettingsRow label="Mode" hint="Light ships with the design wave" testid="row-mode" dimmed>
				<ThinSelect value="dark" ariaLabel="mode" onChange={() => {}} testid="select-mode" disabled>
					<option value="dark">Dark</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Background"
				hint={`Empty = ${resolved.background ?? "#141414"}`}
				testid="row-background"
			>
				<CommitInput
					value={appearance?.background ?? ""}
					placeholder="#141414"
					ariaLabel="background hex"
					testid="input-background"
					onCommit={(v) => onSectionChange({ ...appearance, background: v === "" ? null : v })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Reading font"
				hint="Empty = Source Sans 3"
				testid="row-font"
			>
				<CommitInput
					value={appearance?.fontFamily ?? ""}
					placeholder="Source Sans 3"
					ariaLabel="font family"
					testid="input-font"
					onCommit={(v) => onSectionChange({ ...appearance, fontFamily: v === "" ? null : v })}
				/>
			</SettingsRow>
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="16"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): omit the key so the record
						// UNSETS and the field stays empty (absence, not null, is the
						// unset for numbers). Number("") is 0, so the old clamp wrote 12.
						if (v === "") {
							onSectionChange({ ...appearance, proseFontSize: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Session names in serif" testid="row-session-serif">
				<Toggle
					checked={appearance?.sessionNameSerif ?? true}
					label="session names serif"
					onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="900"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): Number("") is 0, so
						// Absence is the unset representation — the old clamp wrote 100.
						if (v === "") {
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Bold color" hint="Empty = #c96b4a" testid="row-bold-color">
				<CommitInput
					value={md?.boldColor ?? ""}
					placeholder="#c96b4a"
					ariaLabel="bold color"
					testid="input-bold-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, boldColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
			<SettingsRow label="Italic color" hint="Empty = #6fa9d6" testid="row-italic-color">
				<CommitInput
					value={md?.italicColor ?? ""}
					placeholder="#6fa9d6"
					ariaLabel="italic color"
					testid="input-italic-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, italicColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
		</>
	);
}

const LADDER: readonly {
	key: "enabled" | "embedding" | "clustering" | "labeling";
	label: string;
	needs: "enabled" | "embedding" | "clustering" | "labeling" | null;
}[] = [
	{ key: "enabled", label: "Graph", needs: null },
	{ key: "embedding", label: "Embedding", needs: "enabled" },
	{ key: "clustering", label: "Clustering", needs: "embedding" },
	{ key: "labeling", label: "Labeling", needs: "clustering" },
];

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	const { open: openSettingsSection } = useSettingsDialog();
	// The BYOK embedding catalog — null until the first fetch lands.
	const [catalog, setCatalog] = useState<EmbeddingCatalogModel[] | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement>(null);
	// The re-embed gate: a pick that differs from the stored model, held
	// until the user answers the confirm strip (or the graph turns out to
	// be empty — nothing to re-embed, the write lands directly).
	const [pending, setPending] = useState<EmbeddingCatalogModel | null>(null);
	// null while the count fetch is in flight; -1 when it failed (the
	// confirm line then omits the number rather than guessing one).
	const [pendingCount, setPendingCount] = useState<number | null>(null);

	// Stored values (the switches show these) vs EFFECTIVE values (a
	// stored-on rung under a broken chain is inert — the schema's ladder).
	const stored = {
		enabled: graph?.enabled ?? true,
		embedding: graph?.embedding ?? true,
		clustering: graph?.clustering ?? true,
		labeling: graph?.labeling ?? true,
	};
	const effective = {
		enabled: stored.enabled,
		embedding: stored.enabled && stored.embedding,
		clustering: stored.enabled && stored.embedding && stored.clustering,
		labeling: stored.enabled && stored.embedding && stored.clustering && stored.labeling,
	};
	// No embedding model = the whole ladder under the master switch is
	// inert (the embedding port refuses without one) — those rows gray
	// out with a hint pointing at the picker below (owner, wave 6).
	const modelUnset = !graph?.embeddingModel;

	const commitPickRef = useRef(onSectionChange);
	commitPickRef.current = onSectionChange;
	const commitRef = useRef<(id: string | null) => void>(null);
	commitRef.current = (id) => commitPickRef.current({ ...graph, embeddingModel: id });

	// Catalog: fetch on mount and re-read on any settings save — keying a
	// provider changes what this list can offer.
	const refreshCatalog = useCallback(async () => {
		try {
			const resp = await fetch("/api/models/embeddings");
			if (!resp.ok) return;
			const list = (await resp.json()) as EmbeddingCatalogModel[];
			if (Array.isArray(list)) setCatalog(list);
		} catch {
			// leave the last known list; the empty-add path stays clickable
		}
	}, []);
	useEffect(() => {
		void refreshCatalog();
	}, [refreshCatalog]);
	useSettingsSaved(() => {
		void refreshCatalog();
	});

	// Dismissal: the agent-section contract — outside pointerdown closes
	// unless it lands inside the menu or on the anchor; Escape is CLAIMED
	// so the dialog behind stays put.
	useEffect(() => {
		if (!menuOpen) return;
		const onPointer = (e: PointerEvent) => {
			const t = e.target as HTMLElement;
			if (t.closest("[data-lh-menu]") || anchorRef.current?.contains(t)) return;
			setMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey, true);
		return () => {
		document.removeEventListener("pointerdown", onPointer);
		document.removeEventListener("keydown", onKey, true);
		};
	}, [menuOpen]);

	// A held pick: count the graph's propositions. Zero = nothing to
	// re-embed, so the write lands without a confirm (the strip would be
	// noise). Otherwise the strip shows the honest number.
	useEffect(() => {
		if (!pending) return;
		let cancelled = false;
		(async () => {
			let n = -1;
			try {
				const resp = await fetch("/api/graph");
				const snap = (await resp.json()) as { nodes?: unknown };
				if (Array.isArray(snap.nodes)) n = snap.nodes.length;
			} catch {
				// count unknown — the strip reads "all propositions"
			}
			if (cancelled) return;
			if (n === 0) {
				setPending(null);
				setPendingCount(null);
				commitRef.current?.(pending.id);
			} else {
				setPendingCount(n);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [pending]);

	const pick = (m: EmbeddingCatalogModel | null) => {
		setMenuOpen(false);
		if (m === null) {
			// Unset never re-embeds — the port just stops resolving.
			if (graph?.embeddingModel != null) commitRef.current?.(null);
			return;
		}
		if (m.id === graph?.embeddingModel) return;
		setPending(m);
		setPendingCount(null);
	};

	// The trigger's label: the catalog row's name when known, else the raw
	// slug (a key may have been removed after the model was set).
	const currentName = useMemo(() => {
		const id = graph?.embeddingModel ?? null;
		if (!id) return null;
		return catalog?.find((m) => m.id === id)?.name ?? id;
	}, [graph?.embeddingModel, catalog]);

	return (
		<>
			{LADDER.map(({ key, label, needs }) => {
				// Touchable only when every ancestor is EFFECTIVELY on, and
				// (below the master switch) only when a model is configured.
				const parentOn = needs === null ? true : effective[needs];
				const inert = !parentOn || (needsEmbeddingModel(key) && modelUnset);
				return (
					<SettingsRow
						key={key}
						label={label}
						testid={`graph-row-${key}`}
						dimmed={inert}
						hint={parentOn && needsEmbeddingModel(key) && modelUnset ? "Needs an embedding model" : undefined}
					>
						<Toggle
							checked={stored[key]}
							disabled={inert}
							label={`graph ${key}`}
							onChange={(on) => onSectionChange({ ...graph, [key]: on })}
						/>
					</SettingsRow>
				);
			})}

			{/* The embedding-model picker — the setting every rung above
			    depends on. Empty catalog means no provider key is set: the
			    trigger BECOMES the deep link to the Keys section. */}
			<SettingsRow label="Embedding model" testid="graph-row-embedding-model">
				{catalog === null ? (
					<span className="text-xs text-muted-foreground">Loading…</span>
				) : catalog.length === 0 ? (
					<button
						type="button"
						data-testid="embedding-model-empty"
						onClick={() => openSettingsSection("keys")}
						className="rounded-lg border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
					>
						Add a provider key first…
					</button>
				) : (
					<button
						ref={anchorRef}
						type="button"
						data-testid="embedding-model-trigger"
						onClick={() => setMenuOpen((o) => !o)}
						className="max-w-56 truncate rounded-lg border border-border/60 px-2 py-1 text-xs text-card-foreground transition-colors hover:bg-muted"
						title={graph?.embeddingModel ?? undefined}
					>
						{currentName ?? "—"}
					</button>
				)}
			</SettingsRow>

			{/* The re-embed confirm — switching models rewrites every vector
			    in the graph (the staleness machinery, next background pass).
			    Honesty over comfort: the count is the user's decision input. */}
			{pending && (
				<div
					data-testid="embedding-reembed-confirm"
					className="rounded-xl border border-border/60 bg-background p-3 text-xs"
				>
					<p className="text-card-foreground">Switch to {pending.name}?</p>
					<p className="mt-1 text-muted-foreground">
						{pendingCount === null
							? "Counting the graph’s propositions…"
							: pendingCount > 0
							? `All ${pendingCount.toLocaleString()} propositions in the graph will be re-embedded with the new model (runs with the next background pass).`
							: "All propositions in the graph will be re-embedded with the new model (runs with the next background pass)."}
					</p>
					{pendingCount !== null && (
						<div className="mt-2 flex gap-2">
							<button
								type="button"
								data-testid="embedding-reembed-yes"
								onClick={() => {
									commitRef.current?.(pending.id);
								setPending(null);
								setPendingCount(null);
							}}
								className="rounded-lg border border-border/60 px-2.5 py-1 text-card-foreground transition-colors hover:bg-muted"
							>
								Switch model
							</button>
							<button
								type="button"
								data-testid="embedding-reembed-no"
								onClick={() => {
									setPending(null);
								setPendingCount(null);
							}}
								className="rounded-lg border border-border/60 px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted"
							>
								Cancel
							</button>
						</div>
					)}
				</div>
			)}

			{menuOpen && catalog !== null && catalog.length > 0 && (
				<MenuShell
					anchorRef={anchorRef}
					testid="embedding-model-menu"
					preferredSide="down"
					align="right"
					menuClass="flex w-[20rem] flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<button
						type="button"
						data-testid="embedding-option-unset"
						onClick={() => pick(null)}
						className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
							modelUnset ? "bg-muted/60" : ""
						}`}
					>
						<span className="text-card-foreground">Unset</span>
						<span className="text-muted-foreground">stop embedding</span>
					</button>
					{catalog.map((m) => (
						<button
							key={m.id}
							type="button"
							data-testid={`embedding-option-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
							onClick={() => pick(m)}
							className={`flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
								m.id === graph?.embeddingModel ? "bg-muted/60" : ""
							}`}
					>
						<span className="flex items-center justify-between gap-2">
							<span className="truncate text-card-foreground">{m.name}</span>
							<span
								className="shrink-0 tabular-nums text-muted-foreground"
								title="USD per 1M input tokens"
							>
								{embeddingPriceLabel(m.id)}
							</span>
						</span>
						{/* The full slug — ids are colon-safe (openrouter:openai/…),
					    never split, shown as stored. */}
						<span className="truncate text-muted-foreground">{m.id}</span>
					</button>
					))}
				</MenuShell>
			)}
		</>
	);
}