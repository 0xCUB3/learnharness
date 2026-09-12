"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ChatListItem, Phase3 } from "@/src/core";

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

/** Phase colors for the session dot — one system with the header chip
 *  and the transcript dividers (globals.css --phase-*). Static class
 *  strings per phase: Tailwind can't compile dynamic class names. */
const PHASE_FILL: Record<Phase3, string> = {
	probe: "bg-phase-probe",
	plan: "bg-phase-plan",
	teach: "bg-phase-teach",
};
const PHASE_RING: Record<Phase3, string> = {
	probe: "border-phase-probe",
	plan: "border-phase-plan",
	teach: "border-phase-teach",
};

/**
 * The session dot, left of the title. TWO channels, one dot: COLOR is the
 * phase (probe/plan/teach — sky/violet/emerald), FILL+MOTION is what's
 * owed. Pulsing = the teacher is working (rare, time-sensitive — the only
 * state that deserves motion). Solid = a question awaits the learner's
 * answer (the DOMINANT resting state of real sessions — calm by design,
 * no animation). Hollow = nothing owed, idle. A pending answer outranks
 * "working": if a question is owed, that's the blocking fact.
 */
function SessionDot({ phase, pending, busy }: { phase: Phase3; pending: boolean; busy: boolean }) {
	if (pending) {
		return (
			<span
				data-testid="session-dot-awaiting"
				title="Waiting for your answer"
				className={cn("size-2 shrink-0 rounded-full", PHASE_FILL[phase])}
			>
				<span className="sr-only">Waiting for your answer</span>
			</span>
		);
	}
	if (busy) {
		return (
			<span
				data-testid="session-dot-working"
				title="Teacher is working"
				className={cn("size-2 shrink-0 rounded-full", PHASE_FILL[phase], "lh-dot-breathe")}
			>
				<span className="sr-only">Teacher is working</span>
			</span>
		);
	}
	return (
		<span
			data-testid="session-dot-idle"
			aria-hidden
			className={cn(
				"size-2 shrink-0 rounded-full border-2 bg-transparent",
				PHASE_RING[phase],
			)}
		/>
	);
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	return new Date(iso).toLocaleDateString();
}

/** The row's second line: state replaces the message count when the state
 *  is the more useful fact (most resting sessions are awaiting an answer —
 *  that's what the learner scans for). */
function sessionMeta(chat: ChatListItem): string {
	if (chat.pendingQuestion) return `Waiting for your answer · ${timeAgo(chat.updatedAt)}`;
	if (chat.busy) return "Teacher is working…";
	return `${chat.messageCount} messages · ${new Date(chat.updatedAt).toLocaleDateString()}`;
}

/**
 * One session row: the status dot, then title + state-aware meta. Exported
 * for render tests — pure function of the list item.
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
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
				active && "bg-accent font-medium",
			)}
		>
			<SessionDot phase={chat.phase} pending={chat.pendingQuestion} busy={chat.busy} />
			<span className="min-w-0 flex-1">
				<span className="block truncate">{chat.title}</span>
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

	/* New session: one POST, then hello. Search: a client-side filter over
	   the poll snapshot — no server round trip. Both were visual-only in
	   the wave-5 mock; wiring each is a single tiny handler. */
	const newSession = useCallback(async () => {
		const res = await fetch("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		const d = (await res.json().catch(() => null)) as { id?: string } | null;
		if (d?.id) router.push(`/chat/${d.id}`);
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
					<span className="text-xxs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
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
