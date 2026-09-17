"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon } from "lucide-react";
import { ActivitySection } from "@/components/activity-dock";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ChatListItem } from "@/src/core";

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

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a teach turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * phases only advance (all sessions end in Teaching — phase-as-signal was
 * decoration, now retired app-wide), and question-pending is the dominant
 * RESTING state of real sessions — a resting state has no scan value, so
 * the meta line's "Waiting for your answer" text carries it. Idle is the
 * absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line: the state when a state exists (waiting/working),
 *  otherwise just how long ago. The message count is DROPPED (owner,
 *  typography round 5): it informed no decision — clutter. messageCount
 *  still rides the API payload, so this is a one-line flip back if it's
 *  ever wanted. */
function sessionMeta(chat: ChatListItem): string {
	if (chat.pendingQuestion) return `Waiting for your answer · ${timeAgo(chat.updatedAt)}`;
	if (chat.busy) return "Teacher is working…";
	return timeAgo(chat.updatedAt);
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta. Exported for render tests — pure function of the
 * list item.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className={cn(
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
				active && "bg-accent",
			)}
		>
			<SessionStatus busy={chat.busy} />
			<span className="min-w-0 flex-1">
				{/* Titles are the learner's/teacher's WORDS — Source Sans 3, the
				    same voice the words were typed in (every input is lh-prose);
				    the meta line below stays JetBrains Mono (machine data). One
				    rule, finally applied to the picker too (owner, typography
				    round): mono = chrome, Source Sans = human words. */}
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{chat.title}</span>
				<span className="block text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
		</button>
	);
}

function SessionsSidebar() {
	const { open, toggle } = useSidebar();
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [query, setQuery] = useState("");
	const pathname = usePathname();
	const router = useRouter();

	/* New session (owner, 2026-09-13): NO POST — the button opens the
	   sessionless draft view; the session is created only when the first
	   message is sent (and that message becomes its title). Search: a
	   client-side filter over the poll snapshot — no server round trip. */
	const newSession = useCallback(() => {
		router.push("/chat/new");
	}, [router]);

	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!chats) return chats;
		if (!q) return chats;
		return chats.filter((c) => c.title.toLowerCase().includes(q));
	}, [chats, query]);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			const d = (await res.json()) as { chats: ChatListItem[] };
			setChats(d.chats);
		} catch {
			// a transient failure on the periodic poll keeps the last snapshot
			setChats((prev) => prev ?? []);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// Poll while open: the statuses are live (a question lands in another
		// session, a turn finishes in the background) and the payload is tiny.
		// Pause while the tab is hidden; navigation refetches via pathname.
		const id = setInterval(() => {
			if (!document.hidden) void refresh();
		}, 2500);
		return () => clearInterval(id);
	}, [open, pathname, refresh]);

	return (
		<aside
			className={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-72" : "w-0")}
			aria-hidden={!open}
		>
			<div className="flex h-full w-72 flex-col border-r bg-background">
				{/* LH wordmark — the owner's header; close toggle sits at the edge. */}
				<div className="flex items-center justify-between px-4 py-3">
					<Link href="/" className="text-sm font-bold uppercase tracking-widest hover:opacity-80">
						LH
					</Link>
					<Button variant="ghost" size="icon" aria-label="Close sidebar" onClick={toggle}>
						<PanelLeftCloseIcon className="size-4" />
					</Button>
				</div>

				<button
					type="button"
					data-testid="new-session"
					onClick={() => void newSession()}
					className="mx-3 mb-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<PlusIcon className="size-3" />
					New session
					<span className="sr-only">create a new session</span>
				</button>

				<div className="mx-3 mb-1 flex items-center gap-2">
					<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
					<span className="relative flex-1">
						<Input
							data-testid="session-search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search..."
							aria-label="Search sessions"
							className="h-6 rounded-sm border-border bg-background pl-6 text-xs placeholder:text-muted-foreground/60"
						/>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
					</span>
				</div>

				<div className="flex-1 overflow-y-auto p-2">
					{shown === null ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
					) : shown.length === 0 ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">
							{query.trim() ? "No sessions match." : "No sessions yet."}
						</div>
					) : (
						shown.map((c) => (
							<SessionRow
								key={c.id}
								chat={c}
								active={pathname === `/chat/${c.id}`}
								onOpen={() => router.push(`/chat/${c.id}`)}
							/>
						))
					)}
				</div>

					{/* Background agents (owner, sidebar round): the section is
					    ALWAYS here — empty means empty (the header sits alone); it
					    populates and grows when processes run. The session list is
					    flex-1, so this pins to the bottom. Sidebar closed = the
					    learner opted out (no ambient signal, user decision). */}
					<ActivitySection />
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
