"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MenuIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatSummary } from "@/src/store/chats";

/**
 * The app's primary navigation: a hamburger that opens the session list.
 * Sessions only — settings and other chrome will dock here later.
 * Renders the toggle button (sits in the page header) plus the slide-over.
 */
export function SessionDrawer() {
	const [open, setOpen] = useState(false);
	const [chats, setChats] = useState<ChatSummary[] | null>(null);
	const router = useRouter();
	const pathname = usePathname();

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			const data = (await res.json()) as { chats: ChatSummary[] };
			setChats(data.chats);
		} catch {
			setChats([]);
		}
	}, []);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	// ESC closes; body scroll locks while open.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("keydown", onKey);
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKey);
			document.body.style.overflow = "";
		};
	}, [open]);

	const go = (href: string) => {
		setOpen(false);
		router.push(href);
	};

	return (
		<>
			<Button variant="ghost" size="icon" aria-label="Open sessions" onClick={() => setOpen(true)}>
				<MenuIcon className="size-5" />
			</Button>

			{/* backdrop */}
			<div
				className={cn(
					"fixed inset-0 z-40 bg-black/50 transition-opacity",
					open ? "opacity-100" : "pointer-events-none opacity-0",
				)}
				onClick={() => setOpen(false)}
			/>

			{/* panel */}
			<aside
				className={cn(
					"fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r bg-background transition-transform duration-200",
					open ? "translate-x-0" : "-translate-x-full",
				)}
				aria-hidden={!open}
			>
				<div className="flex items-center justify-between border-b px-4 py-3">
					<button
						type="button"
						onClick={() => go("/")}
						className="font-semibold tracking-tight hover:opacity-80"
					>
						Learning Harness
					</button>
					<Button variant="ghost" size="icon" aria-label="Close sessions" onClick={() => setOpen(false)}>
						<XIcon className="size-4" />
					</Button>
				</div>

				<div className="flex-1 overflow-y-auto p-2">
					{chats === null ? (
						<div className="px-2 py-4 text-sm text-muted-foreground">Loading…</div>
					) : chats.length === 0 ? (
						<div className="px-2 py-4 text-sm text-muted-foreground">No sessions yet.</div>
					) : (
						chats.map((c) => {
							const active = pathname === `/chat/${c.id}`;
							return (
								<button
									key={c.id}
									type="button"
									onClick={() => go(`/chat/${c.id}`)}
									className={cn(
										"mb-0.5 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
										active && "bg-accent font-medium",
									)}
								>
									<div className="truncate">{c.title}</div>
									<div className="text-xs text-muted-foreground">
										{c.messageCount} messages · {new Date(c.updatedAt).toLocaleDateString()}
									</div>
								</button>
							);
						})
					)}
				</div>
			</aside>
		</>
	);
}
