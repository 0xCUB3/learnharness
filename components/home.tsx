"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon, WaypointsIcon } from "lucide-react";
import { SidebarToggle } from "@/components/sidebar";

/**
 * Home — the knowledge graph is the main view (placeholder until the graph
 * pipeline lands), with the new-session blob docked below it. Sessions live
 * in the toggleable sidebar.
 */
export function Home() {
	const router = useRouter();
	const [topic, setTopic] = useState("");
	const [busy, setBusy] = useState(false);

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

			{/* Graph — the main view. Placeholder until the knowledge graph lands. */}
			<main className="flex flex-1 items-center justify-center px-4">
				<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
					<WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
					<div className="text-lg font-medium text-foreground">Knowledge graph</div>
					<p className="max-w-sm text-sm">
						Every session you complete will map what you know — and where the edge of your
						understanding is — right here.
					</p>
				</div>
			</main>

			{/* New session — same floating blob as the chat composer. */}
			<div className="pb-4">
				<div className="mx-auto w-full max-w-3xl px-4">
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
						className="field-sizing-content max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground"
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
				</div>
			</div>
		</div>
	);
}
