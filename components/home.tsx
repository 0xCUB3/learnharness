"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon } from "lucide-react";
import { GraphView } from "@/components/graph-view";
import { GraphContextControl, effectiveContextTokens } from "@/components/graph-context-control";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import type { ChatSettings, TurnUsage } from "@/src/core";

/**
 * Home — the knowledge graph is the main view, full-bleed edge to edge
 * (owner, graph-view round 1): the canvas owns the whole column, running
 * under the header and the new-session dock, both of which float over it
 * with no gradient scrims. Sessions live in the toggleable sidebar.
 */
export function Home() {
	const router = useRouter();
	const [topic, setTopic] = useState("");
	const [busy, setBusy] = useState(false);
	// The model+thinking selection made pre-chat — lifted from the StatsBar's
	// ModelControl, carried to the chat POST then PUT-on-create (the model
	// picker defers its save when chatId is empty; see components/model-picker).
	const [settings, setSettings] = useState<ChatSettings | undefined>(undefined);

	const start = async () => {
		const t = topic.trim();
		if (!t || busy) return;
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
					    session yet, so the free LEFT side carries the knowledge-context
					    budget (session-data slot), while the RIGHT keeps the model +
					    thinking control (deferred save). */}
					<StatsBar
						turns={[] as TurnUsage[]}
						chatId=""
						settings={settings}
						onSettingsSaved={setSettings}
						leftSlot={
							<GraphContextControl
								value={effectiveContextTokens(settings)}
								onChange={(tokens) =>
									setSettings((s) => ({ ...s, graphContextTokens: tokens }))
								}
							/>
						}
					/>
				</div>
			</div>
		</div>
	);
}
