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
import type { ChatSettings, ModelCatalogEntry, ModelCatalogResponse } from "@/src/core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList, ThinkingMenuList } from "@/components/settings/model-menu";

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


export function ModelControl({
	chatId,
	settings,
	onSaved,
	fallbackModelId,
	noDefaultModel,
}: {
	chatId: string;
	/** The record's current settings (undefined = config pin). */
	settings?: ChatSettings;
	/** Lifts the persisted settings into the chat view's state. */
	onSaved: (settings: ChatSettings) => void;
	/** The last turn's actual model (from the turns log) — the label until
	 *  the catalog (with config's defaults) finishes loading. */
	fallbackModelId?: string;
	/** Default-surfaces only (owner, 2026-09-18): NO baked-in default —
	 *  unset settings render "no model"/"—" (BYOK first boot), never the
	 *  config pin. Chat surfaces keep the catalog-default fallback (the
	 *  engine runs the pin, so the control shows what will run). */
	noDefaultModel?: boolean;
}) {
	const catalog = useModelCatalog();
	const [open, setOpen] = useState<"model" | "thinking" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const defaults = catalog?.defaults;
	const effectiveId = noDefaultModel
		? settings?.model?.id
		: (settings?.model?.id ?? defaults?.model.id ?? fallbackModelId);
	const effectiveLevel = noDefaultModel
		? settings?.thinkingLevel
		: (settings?.thinkingLevel ?? defaults?.thinkingLevel);
	const entry = catalog?.models.find((m) => m.id === effectiveId);
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
			setError(null);
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


	return (
		<div ref={containerRef} className="relative flex items-center gap-1.5" data-testid="model-control">
			<button
				type="button"
				data-testid="stats-model"
				onClick={() => {
					setOpen((o) => (o === "model" ? null : "model"));
					setError(null);
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
					// No model yet (noDefaultModel first boot) → nothing to set a
					// level FOR: the click is a no-op, never an empty menu.
					if (entry === undefined) return;
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

			{/* The shared dropdown body (extracted 2026-09-20): the agent
			    settings' role selects use the exact same one. */}
			{open === "model" && (
				<div
					data-testid="model-menu"
					className="absolute bottom-full right-0 z-40 mb-1.5 flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					<ModelMenuList
						models={catalog?.models}
						effectiveId={effectiveId}
						onPick={pickModel}
						footer="Applies to the next turn · background agents stay config-pinned"
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
						onPick={(level) => void save({ ...(settings ?? {}), thinkingLevel: level as ChatSettings["thinkingLevel"] })}
						empty={catalog ? (effectiveId ? `${prettyModel(effectiveId)} has no thinking levels.` : "Pick a model first.") : "Loading…"}
						footer="Levels this model actually supports"
					/>
					{error && <div className="mt-1 text-destructive">{error}</div>}
				</div>
			)}
		</div>
	);
}