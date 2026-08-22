"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WaypointsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SessionDrawer } from "@/components/session-drawer";

/**
 * Home — the knowledge graph is the main view (placeholder until the graph
 * pipeline lands), with the new-session input docked below it. Sessions live
 * in the hamburger drawer.
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
				<SessionDrawer />
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

			{/* New session input */}
			<div className="px-4 pb-6">
				<form
					className="mx-auto flex w-full max-w-2xl gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void start();
					}}
				>
					<Input
						value={topic}
						onChange={(e) => setTopic(e.target.value)}
						placeholder="What do you want to learn?"
						autoFocus
						className="h-11"
					/>
					<Button type="submit" disabled={!topic.trim() || busy} className="h-11">
						{busy ? "Starting…" : "Start"}
					</Button>
				</form>
			</div>
		</div>
	);
}
