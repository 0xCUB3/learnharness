"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon } from "lucide-react";
import { GraphView } from "@/components/graph-view";
import { SetupDialog } from "@/components/setup-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { useDefaultSettings } from "@/components/default-settings";
import { DictationBar, useDictation } from "@/components/dictation";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import type { ChatSettings, TurnUsage } from "@/src/core";

/**
 * Home — the knowledge graph is the main view, full-bleed edge to edge
 * (owner, graph-view round 1): the canvas owns the whole column, running
 * under the header and the new-session dock, both of which float over it
 * with no gradient scrims. Sessions live in the toggleable sidebar.
 */
export function Home({ initialSettings, initialConfigured }: { initialSettings: ChatSettings | null; initialConfigured: boolean }) {
	const router = useRouter();
	const [topic, setTopic] = useState("");
	// First-run gate (model-slots wave, owner 2026-09-20): chats cannot
	// start until the user has picked all three slots — no defaults for
	// 33 providers. The dock shows the CTA while unconfigured; submitting
	// a topic opens the setup dialog WITH THE DRAFT PRESERVED (Save
	// stores the slots and the queued message sends).
	const [configured, setConfigured] = useState(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	const { open: openSettings } = useSettingsDialog();
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// topic draft; the strip lives in the stats bar's middle slot.
	const dictation = useDictation({
		append: (t) => setTopic((v) => (v ? v.replace(/\s+$/, "") + " " + t : t)),
	});
	const [busy, setBusy] = useState(false);
	// THE default settings (owner, 2026-09-18): this topic dock IS the
	// settings page for the default model — no baked-in default exists; the
	// user's last choice (server-rendered in via initialSettings, shared
	// with /chat/new through data/default-settings.json) IS the default.
	// Still carried to the chat POST then PUT-on-create (the model picker
	// defers its save when chatId is empty; see components/model-picker).
	const { settings, save: saveDraft } = useDefaultSettings(initialSettings);

	const start = async (force = false) => {
		const t = topic.trim();
		if (!t || busy) return;
		// Unconfigured: the send INTERCEPTS into the setup flow (the draft
		// stays in the textarea; Save completes and this re-runs). `force`
		// is the onDone path — the state this closure captured is still
		// the pre-save `configured`, the state update hasn't landed yet.
		if (!configured && !force) {
			setSetupOpen(true);
			return;
		}
		setBusy(true);
		try {
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			const { id } = (await res.json()) as { id: string };
			if (settings) {
				// Best-effort persist — the selection was made pre-chat.
				await fetch(`/api/chats/${id}/settings`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(settings),
				}).catch(() => {});
			}
			router.push(`/chat/${id}?prompt=${encodeURIComponent(t)}`);
		} catch {
			setBusy(false);
		}
	};

	return (
		<div className="relative h-dvh">
			{/* Window-drag strip (merged chrome, owner 2026-09-17): a dedicated
			    mask element, deliberately FIRST in the DOM. Electron's app-region
			    mask resolves by DOM order — a no-drag element subtracts only drag
			    regions that came EARLIER in the tree — not by z-index, so the
			    header's old inline drag region (after <main>) re-added itself over
			    the graph chrome row's carve-out and the buttons dragged the window.
			    Placed first, every carved control (chrome row, node detail card,
			    the toggle) comes later and subtracts correctly. Pure mask: it
			    never needs to receive events — the mask routes the pixels. */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />

			{/* Graph — the main view, full-bleed (owner, graph-view round 1): no
			    padding on any side; the canvas runs from the sidebar to the right
			    edge and from the bottom to the top, under everything else. */}
			<main className="absolute inset-0">
				<GraphView />
			</main>

			{/* Header floats over the graph — pointer-events-none except the
			    toggle, so the canvas stays draggable/hoverable around it. Carries
			    no app-region of its own: the strip's drag comes from the mask
			    div above, and the toggle's lh-no-drag subtracts from it (it is
			    later in the tree, so the subtraction sticks). */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>

			{/* New session — same floating blob as the chat composer, docked
			    OVER the graph (no gradient: the graph runs clean under it to the
			    bottom edge). Matches chat.tsx's DOCK geometry (max-w-[46rem]
			    px-4) so nothing shifts when a session starts (owner). */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 pb-5">
				<div className="pointer-events-auto mx-auto w-full max-w-[46rem] px-4">
					{!configured && (
						<div className="mb-2 flex justify-center">
							<button
								type="button"
								data-testid="setup-cta"
								onClick={() => setSetupOpen(true)}
								className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
							>
								Set up your models — chats start after the three picks
							</button>
						</div>
					)}
					<form
						className="flex items-end gap-1.5 rounded-2xl border bg-card p-1.5 shadow-lg"
					onSubmit={(e) => {
						e.preventDefault();
						void start();
					}}
				>
					<textarea
						value={topic}
						onChange={(e) => setTopic(e.target.value)}
						onKeyDown={(e) => {
							// Esc ends dictation (the dictate decisions: click-again or
							// Esc) — stopPropagation claims it (keyboard wave A) so
							// the window chain doesn't also abort a turn.
							if (e.key === "Escape" && dictation.active) {
								e.preventDefault();
								e.stopPropagation();
								dictation.cancel();
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void start();
							}
						}}
						placeholder="What do you want to learn?"
						autoFocus
						rows={1}
						className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
					/>
					<button
						type="submit"
						aria-label="Start session"
						disabled={!topic.trim() || busy}
						className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40"
					>
						<CornerDownLeftIcon className="size-5" />
						</button>
					</form>
					{/* Same as the chat view's under-composer stats bar (owner) — no
					    session yet, so the LEFT side renders nothing (wave 7 sweep)
					    while the RIGHT keeps the strong-slot control (fix wave: the
					    pills write /api/settings/models). */}
					<StatsBar
						dictationSlot={<DictationBar dictation={dictation} />}
						turns={[] as TurnUsage[]}
					/>
				</div>
			</div>

			{/* First-run setup (unconfigured): the CTA's target and the send
			    interception's landing surface. onDone replays the intercepted
			    draft; onOpenKeys deep-links the settings dialog (stage 1). */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setConfigured(true);
					setSetupOpen(false);
					void start(true); // the queued draft sends
				}}
				onOpenKeys={() => {
					setSetupOpen(false);
					openSettings("keys");
				}}
			/>
		</div>
	);
}
