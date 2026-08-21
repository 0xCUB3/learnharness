"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatSummary } from "@/src/store/chats";

export function Home({ chats }: { chats: ChatSummary[] }) {
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
		<main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 py-10">
			<h1 className="mb-1 text-2xl font-semibold">Learning Harness</h1>
			<p className="mb-8 text-sm text-muted-foreground">
				A teacher with a memory. Start a session on anything you want to understand.
			</p>

			<form
				className="mb-10 flex gap-2"
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
				/>
				<Button type="submit" disabled={!topic.trim() || busy}>
					{busy ? "Starting…" : "Start"}
				</Button>
			</form>

			<h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">Sessions</h2>
			{chats.length === 0 ? (
				<p className="text-sm text-muted-foreground">No sessions yet.</p>
			) : (
				<div className="flex flex-col gap-2">
					{chats.map((c) => (
						<button
							key={c.id}
							type="button"
							onClick={() => router.push(`/chat/${c.id}`)}
							className="rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent"
						>
							<div className="truncate font-medium">{c.title}</div>
							<div className="text-xs text-muted-foreground">
								{c.messageCount} messages · {new Date(c.updatedAt).toLocaleString()}
							</div>
						</button>
					))}
				</div>
			)}
		</main>
	);
}
