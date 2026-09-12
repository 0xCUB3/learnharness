"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon } from "lucide-react";
import { GraphView } from "@/components/graph-view";
import { SidebarToggle } from "@/components/sidebar";
import { StatsBar } from "@/components/stats-bar";
import type { ChatSettings, TurnUsage } from "@/src/core";

/**
 * Home — the knowledge graph is the main view (placeholder until the graph
 * pipeline lands), with the new-session blob docked below it. Sessions live
 * in the toggleable sidebar.
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
		<div className="flex h-dvh flex-col">
			<header className="flex items-center gap-2 px-3 py-2">
				<SidebarToggle />
			</header>

			{/* Graph — the main view (W4: sigma.js render of the derived graph). */}
			<main className="min-h-0 flex-1 px-4 py-2">
				<GraphView />
			</main>

			{/* New session — same floating blob as the chat composer. */}
			<div className="pb-4">
				{/* Matches chat.tsx's DOCK geometry (max-w-[46rem] px-4) so nothing
			    shifts when a session starts (owner). */}
			<div className="mx-auto w-full max-w-[46rem] px-4">
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
						className="field-sizing-content lh-prose max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
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
					    session yet, so money/context fold as "—"; the model +
					    thinking control still works (deferred save). */}
					<StatsBar
						turns={[] as TurnUsage[]}
						chatId=""
						settings={settings}
						onSettingsSaved={setSettings}
					/>
				</div>
			</div>
		</div>
	);
}
