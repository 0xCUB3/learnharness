"use client";

/**
 * The model + thinking control (model-control wave, 2026-09-12) — the stats
 * bar's right side. ONE controller for the conversation agents (prober +
 * teacher are functionally one agent); background sub-agents stay
 * config-pinned. Writes go to PUT /api/chats/[id]/settings (validated
 * server-side against pi-ai's catalog) and take effect on the next turn by
 * construction — the agents are stateless per turn.
 *
 * The data is pi-ai's catalog (GET /api/models): the model menu is a fuzzy
 * search over "provider id name" (core/fuzzy.ts — pi's /model pattern), and
 * the thinking menu lists EXACTLY the chosen model's supported levels
 * (getSupportedThinkingLevels — GLM-5.3-flash shows low|high|max, never a
 * level it would silently clamp). Menus open ABOVE the buttons (the
 * composer owns everything below).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	fuzzyScore,
	type ChatSettings,
	type ModelCatalogEntry,
	type ModelCatalogResponse,
} from "@/src/core";
import { formatTokens, prettyModel } from "@/components/usage-format";

/** GET /api/models is fetched once per page load and shared by every
 *  picker instance (the catalog is static within a pi-ai version). */
let catalogCache: ModelCatalogResponse | undefined;
let catalogInflight: Promise<ModelCatalogResponse> | undefined;

function fetchCatalog(): Promise<ModelCatalogResponse> {
	catalogInflight ??= fetch("/api/models")
		.then((r) => {
			if (!r.ok) throw new Error(`catalog request failed: ${r.status}`);
			return r.json() as Promise<ModelCatalogResponse>;
		})
		.then((c) => {
			catalogCache = c;
			return c;
		})
		.catch((err) => {
			catalogInflight = undefined; // retry on next mount
			throw err;
		});
	return catalogInflight;
}

function useModelCatalog(): ModelCatalogResponse | undefined {
	const [catalog, setCatalog] = useState(catalogCache);
	useEffect(() => {
		if (catalogCache) return;
		let alive = true;
		fetchCatalog()
			.then((c) => alive && setCatalog(c))
			.catch(() => {
				/* the picker stays closed on failure; the buttons still display
				   the effective model from props */
			});
		return () => {
			alive = false;
		};
	}, []);
	return catalog;
}

const LEVEL_LABEL: Record<string, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Xhigh",
	max: "Max",
};

/** USD per 1M tokens, compact: "$0.08 in · $0.25 out". */
function priceLabel(cost: ModelCatalogEntry["cost"]): string {
	const fmt = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2)}`;
	return `${fmt(cost.input)}/${fmt(cost.output)}`;
}

export function ModelControl({
	chatId,
	settings,
	onSaved,
	fallbackModelId,
}: {
	chatId: string;
	/** The record's current settings (undefined = config pin). */
	settings?: ChatSettings;
	/** Lifts the persisted settings into the chat view's state. */
	onSaved: (settings: ChatSettings) => void;
	/** The last turn's actual model (from the turns log) — the label until
	 *  the catalog (with config's defaults) finishes loading. */
	fallbackModelId?: string;
}) {
	const catalog = useModelCatalog();
	const [open, setOpen] = useState<"model" | "thinking" | null>(null);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	/** The arrow-walked result (owner polish, 2026-09-17): arrows move it
	 *  through `results` while focus STAYS in the search field; Enter
	 *  picks it (or the first result when nothing is walked). */
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	const defaults = catalog?.defaults;
	const effectiveId = settings?.model?.id ?? defaults?.model.id ?? fallbackModelId;
	const effectiveLevel =
		settings?.thinkingLevel ?? defaults?.thinkingLevel;
	const entry = catalog?.models.find((m) => m.id === effectiveId);
	const levels = entry?.supportedLevels ?? [];

	// Focus the search box when the model menu opens (pi's /model feel).
	useEffect(() => {
		if (open === "model") searchRef.current?.focus();
	}, [open]);
	// Keep the arrow-walked result visible in the scrolling list.
	useEffect(() => {
		if (open !== "model" || menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx, open]);

	// The intuitive dropdown contract (owner, stats-control round 1): any
	// click outside the open menu — or an Esc keypress — closes it. Only the
	// menu's own surface keeps it open (the toggle buttons live inside the
	// same container and handle their own toggling in onClick).
	useEffect(() => {
		if (open === null) return;
		const onPointerDown = (e: PointerEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(null);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Claim the Esc (keyboard wave A): the window-level chain must
				// not ALSO stop dictation / abort the turn under this menu.
				e.stopPropagation();
				setOpen(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const save = useCallback(
		async (next: ChatSettings) => {
			setError(null);
			// Home view (pre-chat): defer — the selection rides along on the
			// chat POST and is PUT after creation (onSaved is still lifted).
			if (!chatId) {
				onSaved(next);
				setOpen(null);
				return;
			}
			try {
				const res = await fetch(`/api/chats/${chatId}/settings`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setError(body.error ?? `settings rejected (${res.status})`);
					return;
				}
				const { settings: saved } = (await res.json()) as { settings: ChatSettings };
				onSaved(saved);
				setOpen(null);
			} catch {
				setError("Could not reach the server — try again.");
			}
		},
		[chatId, onSaved],
	);

	// Shortcut seams (keyboard wave A): ⌘K opens the model menu (the
	// universal command convention); Shift+Tab cycles the thinking level
	// up the ladder (wrapping) — the owner's replacement for browser
	// tab-focus. Both work from any focus, including mid-typing.
	useEffect(() => {
		const onOpenPicker = () => {
			setOpen("model");
			setQuery("");
			setError(null);
			setMenuIdx(null);
		};
		window.addEventListener("lh:kbd-open-model-picker", onOpenPicker);
		return () => window.removeEventListener("lh:kbd-open-model-picker", onOpenPicker);
	}, []);

	useEffect(() => {
		const onCycleThinking = () => {
			if (levels.length === 0) return;
			const idx = effectiveLevel === undefined ? -1 : levels.indexOf(effectiveLevel);
			void save({ ...(settings ?? {}), thinkingLevel: levels[(idx + 1) % levels.length] });
		};
		window.addEventListener("lh:kbd-cycle-thinking", onCycleThinking);
		return () => window.removeEventListener("lh:kbd-cycle-thinking", onCycleThinking);
	}, [levels, effectiveLevel, save, settings]);

	// Selecting a model (click and Enter share one path): keep the
	// thinking level only when the new model supports it — otherwise
	// drop it (config fallback clamps honestly; a carry-over would 400).
	// Replace-whole discipline: spread the current settings — a model pick
	// must not silently clear a sibling override (graphContextTokens).
	const pickModel = (m: ModelCatalogEntry) => {
		const nextLevel =
			effectiveLevel !== undefined && m.supportedLevels.includes(effectiveLevel)
				? effectiveLevel
				: undefined;
		void save({ ...(settings ?? {}), model: { provider: m.provider, id: m.id }, thinkingLevel: nextLevel });
	};

	// The filtered, ranked model list.
	const results = (catalog?.models ?? [])
		.map((m) => ({ m, s: fuzzyScore(query, m.provider, m.id, m.name) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => (b.s! - a.s!) || a.m.id.localeCompare(b.m.id))
		.map((r) => r.m);

	return (
		<div ref={containerRef} className="relative flex items-center gap-1.5" data-testid="model-control">
			<button
				type="button"
				data-testid="stats-model"
				onClick={() => {
					setOpen((o) => (o === "model" ? null : "model"));
					setQuery("");
					setError(null);
					setMenuIdx(null);
				}}
				aria-expanded={open === "model"}
				title="Conversation model — applies next turn"
				className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 transition-colors hover:border-border hover:bg-muted"
			>
				<span className="text-card-foreground">{effectiveId ? prettyModel(effectiveId) : "—"}</span>
					<span aria-hidden className="text-xs text-muted-foreground">▾</span>
			</button>
			<button
				type="button"
				data-testid="stats-thinking"
				onClick={() => {
					setOpen((o) => (o === "thinking" ? null : "thinking"));
					setError(null);
				}}
				aria-expanded={open === "thinking"}
				title="Thinking level — applies next turn"
				className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 transition-colors hover:border-border hover:bg-muted"
			>
				{/* Just the level — the button reads like the model button reads
				   the model name (owner, stats-control round 1). */}
				<span className="text-card-foreground">
					{effectiveLevel === undefined ? "—" : (LEVEL_LABEL[effectiveLevel] ?? effectiveLevel)}
				</span>
				<span aria-hidden className="text-xs text-muted-foreground">▾</span>
			</button>

			{open === "model" && (
				<div
					data-testid="model-menu"
					className="absolute bottom-full right-0 z-40 mb-1.5 flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<input
						ref={searchRef}
						data-testid="model-search"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setMenuIdx(null); // new query → the walk restarts on Enter/↓
						}}
						// The menu keyboard machine (owner polish): focus STAYS in the
						// search field — ↑/↓ walk the filtered results (clamped, no
						// wrap), Enter picks the walked row (or the first result when
						// nothing is walked). stopPropagation keeps these keys out of
						// every other listener while the menu is open.
						onKeyDown={(e) => {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								e.stopPropagation();
								if (results.length === 0) return;
								setMenuIdx((i) =>
									e.key === "ArrowDown"
										? Math.min((i ?? -1) + 1, results.length - 1)
										: Math.max((i ?? results.length) - 1, 0),
								);
							} else if (e.key === "Enter") {
								const chosen = results[menuIdx ?? 0];
								if (chosen) {
									e.preventDefault();
									e.stopPropagation();
									pickModel(chosen);
								}
							}
						}}
						placeholder="Search models…"
						className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
					/>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					{!catalog && (
						<div className="px-2 py-3 text-center text-muted-foreground">Loading models…</div>
					)}
					{catalog && results.length === 0 && (
						<div className="px-2 py-3 text-center text-muted-foreground">No models match.</div>
					)}
					<ul ref={listRef} data-testid="model-list" className="flex max-h-72 flex-col overflow-y-auto px-1">
						{results.map((m, i) => (
							<li key={`${m.provider}/${m.id}`}>
								<button
									type="button"
									data-testid={`model-option-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
									data-idx={i}
									onClick={() => pickModel(m)}
									className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
										i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
									}${m.id === effectiveId && i !== menuIdx ? " bg-muted/60" : ""}`}
								>
									<span className="flex items-center justify-between gap-2">
										<span className="truncate text-card-foreground">{m.name}</span>
										<span className="shrink-0 tabular-nums text-muted-foreground" title="USD per 1M tokens in/out">
											{priceLabel(m.cost)}
										</span>
									</span>
									<span className="flex items-center justify-between gap-2 text-muted-foreground">
										<span className="truncate">{m.id}</span>
										<span className="shrink-0 tabular-nums">{formatTokens(m.contextWindow)}</span>
									</span>
								</button>
							</li>
						))}
					</ul>
					<div className="mt-1 border-t px-2 pt-1.5 text-xs text-muted-foreground">
						Applies to the next turn · background agents stay config-pinned
					</div>
				</div>
			)}

			{open === "thinking" && (
				<div
					data-testid="thinking-menu"
					className="absolute bottom-full right-0 z-40 mb-1.5 flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{!catalog && <div className="px-2 py-3 text-center text-muted-foreground">Loading…</div>}
					{catalog && levels.length === 0 && (
						<div className="px-2 py-3 text-center text-muted-foreground">
							{effectiveId ? `${prettyModel(effectiveId)} has no thinking levels.` : "Pick a model first."}
						</div>
					)}
					{levels.map((level) => (
						<button
							key={level}
							type="button"
							data-testid={`thinking-option-${level}`}
							onClick={() => void save({ ...(settings ?? {}), thinkingLevel: level })}
							className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted ${
								level === effectiveLevel ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
							}`}
						>
							<span>{LEVEL_LABEL[level] ?? level}</span>
							{level === effectiveLevel && <span aria-hidden>✓</span>}
						</button>
					))}
					{error && <div className="mt-1 text-destructive">{error}</div>}
					<div className="mt-1 border-t px-2 pt-1.5 text-xs text-muted-foreground">
						Levels this model actually supports
					</div>
				</div>
			)}
		</div>
	);
}