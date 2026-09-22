"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelCatalogEntry, ModelCatalogResponse, ModelsSettings } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList, ThinkingMenuList } from "@/components/settings/model-menu";
import { composeSlotModel } from "@/components/settings/agent-section";

/** GET /api/models is cached per page load for instant menu opens, but
 *  the federation is LIVE per call — keys saved mid-session widen the
 *  catalog immediately server-side. ModelControl therefore re-fetches on
 *  every model-menu open (stale-while-revalidate: the cached list shows
 *  instantly, the fresh one swaps in while the menu is open). */
let catalogCache: ModelCatalogResponse | undefined;
let catalogInflight: Promise<ModelCatalogResponse> | undefined;

function fetchCatalog(force = false): Promise<ModelCatalogResponse> {
	if (force) {
		catalogCache = undefined;
		catalogInflight = undefined;
	}
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
			catalogInflight = undefined; // retry on next mount/open
			throw err;
		});
	return catalogInflight;
}

function useModelCatalog(): { catalog: ModelCatalogResponse | undefined; refresh: () => void } {
	const [catalog, setCatalog] = useState(catalogCache);
	useEffect(() => {
		if (catalogCache) return;
		let alive = true;
		fetchCatalog()
			.then((c) => alive && setCatalog(c))
			.catch(() => {
				/* the picker stays closed on failure; the buttons still
				   display the strong slot from the record fetch */
			});
		return () => {
			alive = false;
		};
	}, []);
	const refresh = useCallback(() => {
		fetchCatalog(true)
			.then(setCatalog)
			.catch(() => {
				/* refresh is best-effort: the cached list stays on failure */
			});
	}, []);
	return { catalog, refresh };
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

/**
 * THE STRONG-SLOT CONTROL (fix wave, owner ruling: "one and the same").
 * The composer's model + thinking pills ARE the strong slot — the tier
 * that runs prober + teacher. Reads: the raw models section (GET
 * /api/settings) for the user's pick, plus the federated catalog for the
 * menus. Writes: PUT /api/settings/models via composeSlotModel — the same
 * seam the settings Agent section and the SetupDialog write, so there is
 * exactly one strong slot in the world and every surface edits it.
 *
 * Unpicked reads "—" (the no-factory-fallback language: the UI never
 * presents a default model; the engine-side pin still resolves, the UI
 * never claims it). Legacy per-chat model overrides on old records keep
 * resolving server-side — the UI simply no longer writes that field
 * anywhere.
 */
export function ModelControl() {
	const { catalog, refresh } = useModelCatalog();
	const [models, setModels] = useState<ModelsSettings | undefined>();
	const [open, setOpen] = useState<"model" | "thinking" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings: { models?: ModelsSettings } | null }>)
			.then((body) => alive && setModels(body.settings?.models ?? undefined))
			.catch(() => {
				/* the record fetch failing leaves the control read-only
				   ("—" triggers, closed menus) — same posture as a
				   catalog failure */
			});
		return () => {
			alive = false;
		};
	}, []);

	const override = models?.strong;
	const effectiveId = override?.model?.id;
	const effectiveProvider = override?.model?.provider;
	const effectiveLevel = override?.thinkingLevel;
	const entry = catalog?.models.find(
		(m) => m.id === effectiveId && m.provider === effectiveProvider,
	);
	const levels = entry?.supportedLevels ?? [];

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

	// One write seam: composeSlotModel preserves the cheap/vision siblings
	// (replace-whole-section discipline) and the per-field independence of
	// model + thinkingLevel within the strong slot.
	const save = useCallback(
		async (next: ModelsSettings) => {
			setError(null);
			try {
				const res = await fetch("/api/settings/models", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setError(body.error ?? `settings rejected (${res.status})`);
					return;
				}
				setModels(next);
				setOpen(null);
			} catch {
				setError("Could not reach the server — try again.");
			}
		},
		[],
	);

	// Shortcut seams (keyboard wave A): ⌘K opens the model menu (the
	// universal command convention); Shift+Tab cycles the thinking level
	// up the ladder (wrapping) — the owner's replacement for browser
	// tab-focus. Both work from any focus, including mid-typing.
	useEffect(() => {
		const onOpenPicker = () => {
			setOpen("model");
			setError(null);
			refresh(); // mid-session key changes widen the menu (cache fix)
		};
		window.addEventListener("lh:kbd-open-model-picker", onOpenPicker);
		return () => window.removeEventListener("lh:kbd-open-model-picker", onOpenPicker);
	}, [refresh]);

	useEffect(() => {
		const onCycleThinking = () => {
			if (levels.length === 0) return;
			const idx = effectiveLevel === undefined ? -1 : levels.indexOf(effectiveLevel);
			const next = levels[(idx + 1) % levels.length];
			if (next === undefined) return;
			void save(composeSlotModel(models, "strong", effectiveProvider ?? "", effectiveId ?? "", next));
		};
		window.addEventListener("lh:kbd-cycle-thinking", onCycleThinking);
		return () => window.removeEventListener("lh:kbd-cycle-thinking", onCycleThinking);
	}, [levels, effectiveLevel, effectiveProvider, effectiveId, models, save]);

	// Selecting a model (click and Enter share one path): keep the
	// thinking level only when the new model supports it — otherwise
	// drop it (a carry-over would 400 at the server's catalog gate).
	const pickModel = (m: ModelCatalogEntry) => {
		const nextLevel =
			effectiveLevel !== undefined && m.supportedLevels.includes(effectiveLevel) ? effectiveLevel : undefined;
		void save(composeSlotModel(models, "strong", m.provider, m.id, nextLevel ?? ""));
	};

	// Stale-while-revalidate on manual open too (⌘K covers the keyboard
	// path above): the cached list shows instantly, the fresh federation
	// swaps in when it lands.
	const openMenu = (kind: "model" | "thinking") => {
		setOpen((o) => (o === kind ? null : kind));
		setError(null);
		if (kind === "model") refresh();
	};

	return (
		<div ref={containerRef} className="relative flex items-center gap-1.5" data-testid="model-control">
			<button
				type="button"
				data-testid="stats-model"
				onClick={() => openMenu("model")}
				aria-expanded={open === "model"}
				title="Strong tier model (prober + teacher) — set app-wide"
				className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 transition-colors hover:border-border hover:bg-muted"
			>
				<span className="text-card-foreground">{effectiveId ? prettyModel(effectiveId) : "—"}</span>
				<span aria-hidden className="text-xs text-muted-foreground">▾</span>
			</button>
			<button
				type="button"
				data-testid="stats-thinking"
				onClick={() => {
					// No model picked → nothing to set a level FOR: the click
					// is a no-op, never an empty menu.
					if (entry === undefined) return;
					openMenu("thinking");
				}}
				aria-expanded={open === "thinking"}
				title="Strong tier thinking level — set app-wide"
				className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 transition-colors hover:border-border hover:bg-muted"
			>
				{/* Just the level — the button reads like the model button reads
				   the model name (owner, stats-control round 1). */}
				<span className="text-card-foreground">
					{effectiveLevel === undefined ? "—" : (LEVEL_LABEL[effectiveLevel] ?? effectiveLevel)}
				</span>
				<span aria-hidden className="text-xs text-muted-foreground">▾</span>
			</button>

			{/* The shared dropdown body (extracted 2026-09-20): the agent
			    settings' slot selects and the setup dialog use the exact same
			    one. */}
			{open === "model" && (
				<div
					data-testid="model-menu"
					className="absolute bottom-full right-0 z-40 mb-1.5 flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					<ModelMenuList
						models={catalog?.models}
						effectiveId={effectiveId}
						effectiveProvider={effectiveProvider}
						onPick={pickModel}
						footer={
							catalog && catalog.models.length === 0
								? "No models — add a provider key in Keys"
								: "Strong tier — runs prober + teacher, app-wide"
						}
					/>
				</div>
			)}

			{open === "thinking" && (
				<div
					data-testid="thinking-menu"
					className="absolute bottom-full right-0 z-40 mb-1.5 flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<ThinkingMenuList
						levels={catalog ? levels : []}
						effectiveLevel={effectiveLevel}
						onPick={(level) =>
							void save(composeSlotModel(models, "strong", effectiveProvider ?? "", effectiveId ?? "", level as ThinkingLevel))
						}
						empty={catalog ? (effectiveId ? `${prettyModel(effectiveId)} has no thinking levels.` : "Pick a model first.") : "Loading…"}
						footer="Levels this model actually supports"
					/>
					{error && <div className="mt-1 text-destructive">{error}</div>}
				</div>
			)}
		</div>
	);
}