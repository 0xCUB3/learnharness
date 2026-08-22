"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatSummary } from "@/src/store/chats";

/**
 * Toggleable sidebar — NOT a modal drawer: no backdrop, no focus theft. It
 * sits inline next to the content and can stay open while working in a
 * session. Open state persists across pages (provider lives in the root
 * layout) and across reloads (localStorage).
 */

const STORAGE_KEY = "lh:sidebar-open";

const SidebarContext = createContext<{ open: boolean; toggle: () => void }>({
	open: false,
	toggle: () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	// Start closed so server and client first-render agree (no hydration
	// mismatch); the stored value is applied after mount.
	const [open, setOpen] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		const stored = localStorage.getItem(STORAGE_KEY);
		// Default: open (first run introduces the sidebar).
		setOpen(stored === null ? true : stored === "1");
		setMounted(true);
	}, []);

	const toggle = useCallback(() => {
		setOpen((v) => {
			localStorage.setItem(STORAGE_KEY, v ? "0" : "1");
			return !v;
		});
	}, []);

	return (
		<SidebarContext.Provider value={{ open, toggle }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/** Hamburger for page headers — only visible when the sidebar is closed. */
export function SidebarToggle() {
	const { open, toggle } = useSidebar();
	if (open) return null;
	return (
		<Button variant="ghost" size="icon" aria-label="Open sidebar" onClick={toggle}>
			<PanelLeftOpenIcon className="size-5" />
		</Button>
	);
}

function SessionsSidebar() {
	const { open, toggle } = useSidebar();
	const [chats, setChats] = useState<ChatSummary[] | null>(null);
	const pathname = usePathname();
	const router = useRouter();

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		fetch("/api/chats", { cache: "no-store" })
			.then((r) => r.json())
			.then((d: { chats: ChatSummary[] }) => !cancelled && setChats(d.chats))
			.catch(() => !cancelled && setChats([]));
		return () => {
			cancelled = true;
		};
	}, [open, pathname]);

	return (
		<aside
			className={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-72" : "w-0")}
			aria-hidden={!open}
		>
			<div className="flex h-full w-72 flex-col border-r bg-background">
				<div className="flex items-center justify-between px-4 py-3">
					<Link href="/" className="font-semibold tracking-tight hover:opacity-80">
						Learning Harness
					</Link>
					<Button variant="ghost" size="icon" aria-label="Close sidebar" onClick={toggle}>
						<PanelLeftCloseIcon className="size-4" />
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
									onClick={() => router.push(`/chat/${c.id}`)}
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
			</div>
		</aside>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<>
			<SessionsSidebar />
			<main className="min-w-0 flex-1">{children}</main>
		</>
	);
}
