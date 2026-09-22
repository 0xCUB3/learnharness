"use client";
/**
 * The first-run setup flow (model-slots wave, 2026-09-20, owner design
 * "A — composer CTA + send interception"): chats cannot start until the
 * user has picked all three model slots — there are no defaults for 33
 * providers. The graph view's new-session dock (the app's home, where
 * chats start) shows a "Set up your models" CTA while unconfigured;
 * submitting a topic — or sending on /chat/new — opens THIS dialog with
 * the draft preserved; Save stores the slots and the queued message
 * sends.
 *
 * STAGED BY DEPENDENCY (owner, 2026-09-20: "first keys, then models —
 * there's no point presenting the model picker before the user has set a
 * key because there are no models to pick then"):
 *   Stage 1 — no keyed provider: "add a provider key first" + a button
 *     that deep-links the settings dialog on Keys. The draft lives in
 *     the caller's state, untouched; after the key lands the next
 *     submit/CTA click reopens here at stage 2 (the /api/models check is
 *     fresh per open — saving a key immediately widens the pickers).
 *   Stage 2 — Strong → Cheap → Vision pickers over the FEDERATED catalog
 *     (keyed providers only), the vision slot filtered to image-capable
 *     models, in the app's shared dropdown language (ModelMenuList).
 *     All three required (owner: no skip, no defaults); Save PUTs the
 *     models section and reports onDone(models).
 *
 * Closable without configuring (Esc/backdrop/✕) — browsing the app stays
 * possible; the GATE is the send interception, not the dialog. The
 * settings-dialog visual language: dim backdrop, border rounded-md card,
 * CMU title, z-50.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type React from "react";
import { type ModelCatalogEntry, type ModelSlotName, type ModelsSettings } from "@/src/core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList } from "@/components/settings/model-menu";
import { MenuShell } from "@/components/menu-shell";

/** The pickers' slot identity — same roster language as the Agent
 *  section's slot rows. */
const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Strong", roster: "Prober + Teacher" },
	cheap: { label: "Cheap", roster: "Researcher, demo builder, extractor, auditor, labeler" },
	vision: { label: "Vision", roster: "Visual maker + PDF reader" },
};
const SLOT_ORDER: readonly ModelSlotName[] = ["strong", "cheap", "vision"];

/** The GET /api/models response fields the flow consumes. */
interface ModelsBody {
	models: ModelCatalogEntry[];
	providers: { id: string; keyPresent: boolean }[];
}

/** Pure: which stage the flow opens at — no keyed provider = keys first
 *  (owner's dependency ordering). Exported for tests. */
export function setupStage(
	providers: { id: string; keyPresent: boolean }[] | null,
): "keys" | "pickers" {
	if (providers === null) return "keys"; // fetch failed → the honest fallback
	return providers.some((p) => p.keyPresent) ? "pickers" : "keys";
}

export function SetupDialog({
	open,
	onClose,
	/** Saved: the models section landed; the caller marks configured and
	 *  replays the intercepted draft. */
	onDone,
	/** Deep-link to the Keys section ("add a provider key first"). */
	onOpenKeys,
}: {
	open: boolean;
	onClose: () => void;
	onDone: (models: ModelsSettings) => void;
	onOpenKeys: () => void;
}) {
	const [body, setBody] = useState<ModelsBody | null>(null);
	const [failed, setFailed] = useState(false);
	const [picked, setPicked] = useState<Partial<Record<ModelSlotName, ModelCatalogEntry>>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openSlot, setOpenSlot] = useState<ModelSlotName | null>(null);
	/** The open slot's trigger wrapper — the shared shell's anchor (fix
	 *  wave chunk B): one menu open at a time, so one ref suffices, and
	 *  the menu PORTALS out of this dialog's overflow-hidden frame — it
	 *  extends beyond the dialog exactly like the settings menus do. */
	const triggerRef = useRef<HTMLDivElement>(null);

	// Fresh /api/models per open — a key saved a moment ago (stage 1 →
	// Keys → back) widens the pickers immediately, no restart.
	useEffect(() => {
		if (!open) return;
		setPicked({});
		setError(null);
		fetch("/api/models")
			.then((r) => r.json())
			.then((b: ModelsBody) => {
				setBody(b);
				setFailed(false);
			})
			.catch(() => setFailed(true));
	}, [open]);

	// Esc + outside-click — layered dismissal, closable WITHOUT
	// configuring (browsing stays possible; the gate is the send
	// interception, not this dialog). An open slot menu eats Esc first
	// (and any click outside it); only a bare Esc closes the dialog.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (openSlot !== null) setOpenSlot(null);
			else onClose();
		};
		const onPointerDown = (e: PointerEvent) => {
			if (openSlot === null) return;
			const t = e.target as Element;
			if (t.closest("[data-lh-menu]") || t.closest(`[data-testid="setup-trigger-${openSlot}"]`)) return;
			setOpenSlot(null);
		};
		window.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open, onClose, openSlot]);

	if (!open) return null;

	const stage = failed ? "keys" : setupStage(body ? body.providers : null);
	const allPicked = SLOT_ORDER.every((s) => picked[s]);

	async function save() {
		if (!allPicked || saving) return;
		setSaving(true);
		setError(null);
		const models: ModelsSettings = {};
		for (const slot of SLOT_ORDER) models[slot] = { model: { provider: picked[slot]!.provider, id: picked[slot]!.id } };
		const res = await fetch("/api/settings/models", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(models),
		}).catch(() => null);
		if (!res || !res.ok) {
			setSaving(false);
			setError(res ? `Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}` : "Save failed — network");
			return;
		}
		onDone(models);
	}

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			data-testid="setup-backdrop"
			onClick={onClose}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Set up your models"
				data-testid="setup-dialog"
				className="settings-dialog-pop flex max-h-[85vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
					<h2 className="font-title text-2xl tracking-tight">Set up your models</h2>
					<button
						type="button"
						aria-label="Close setup"
						data-testid="setup-close"
						onClick={onClose}
						className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
					>
						✕
					</button>
				</header>

				{stage === "keys" ? (
					<div className="flex flex-col gap-3 px-6 py-5" data-testid="setup-stage-keys">
						<p className="text-sm text-foreground">
							{failed ? "Model catalog could not be loaded — check the connection and retry." : "First, add a provider key."}
						</p>
						<p className="text-xs text-muted-foreground">
							The model pickers list only what your keys unlock — there is nothing to pick until one exists.
						</p>
						<div>
							<button
								type="button"
								data-testid="setup-open-keys"
								onClick={onOpenKeys}
								className="rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
							>
								Open Keys settings
							</button>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-4 overflow-y-auto px-6 py-5" data-testid="setup-stage-pickers">
						<p className="text-xs text-muted-foreground">
							Pick the model for each tier — all three are required before chats can start.
						</p>
						{SLOT_ORDER.map((slot) => {
							const entry = picked[slot];
							const catalog =
								slot === "vision" ? body?.models.filter((m) => m.input.includes("image")) : body?.models;
							return (
								<div key={slot} data-testid={`setup-slot-${slot}`} className="flex flex-col gap-1.5">
									<span className="font-ui text-sm text-foreground">{SLOT_META[slot].label}</span>
									<span className="text-xs text-muted-foreground/70">{SLOT_META[slot].roster}</span>
									<div ref={openSlot === slot ? triggerRef : undefined} className="relative">
										<button
											type="button"
											aria-label={`${SLOT_META[slot].label} model`}
											data-testid={`setup-trigger-${slot}`}
											aria-expanded={openSlot === slot}
											onClick={() => setOpenSlot(openSlot === slot ? null : slot)}
											className="flex h-7 min-w-40 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
										>
											<span className="min-w-0 flex-1 truncate">{entry ? prettyModel(entry.id) : "Pick a model…"}</span>
											<span aria-hidden className="text-muted-foreground">
												▾
											</span>
										</button>
										{openSlot === slot && (
											<MenuShell
												anchorRef={triggerRef}
												testid={`setup-menu-${slot}`}
												preferredSide="down"
												align="left"
												menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
											>
												<ModelMenuList
													models={catalog}
													effectiveId={entry?.id}
													effectiveProvider={entry?.provider}
													onPick={(m) => {
														setPicked((prev) => ({ ...prev, [slot]: m }));
														setOpenSlot(null);
													}}
													footer={catalog && catalog.length === 0 ? "No image-capable models — widen the provider keys" : undefined}
												/>
											</MenuShell>
										)}
									</div>
								</div>
							);
						})}
						<div className="flex items-center gap-3">
							<button
								type="button"
								data-testid="setup-save"
								disabled={!allPicked || saving}
								onClick={() => void save()}
								className="rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{saving ? "Saving…" : "Save models"}
							</button>
							{error && <p className="text-xs text-red-400">{error}</p>}
						</div>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
