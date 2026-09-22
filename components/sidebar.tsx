"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { ActivitySection } from "@/components/activity-dock";
import { LhMark } from "@/components/lh-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
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

/*
 * Narrow-window behavior (owner, 2026-09-17): below SIDEBAR_AUTOCLOSE the
 * sidebar would squeeze the page below the 640px window floor (the two
 * numbers compose: 640 + 288 sidebar = 928), so it auto-closes — and
 * auto-RESTORES when the window widens again (owner choice: the sidebar
 * pops back, not a manual re-open). The whole behavior is one expression:
 * rendered = pref && !narrow, where pref is the persisted user choice.
 * Manual closes persist and stay closed; auto-close does not touch the
 * preference. Opening the sidebar while narrow asks the Electron shell to
 * widen the window to the threshold (window.lh.expandWindow, IPC in
 * electron/main.cjs) — the resize listener flips `narrow` and the sidebar
 * appears. In the plain browser there is no window to widen and no
 * suppression — a narrow tab opens the sidebar if the user says so.
 *
 * Mirrors SIDEBAR_AUTOCLOSE in electron/main.cjs — keep in sync.
 */
const SIDEBAR_AUTOCLOSE = 928;

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		lh?: { expandWindow: () => void };
	}
}

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
	const [narrow, setNarrow] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// Electron shell detection (merged chrome, 2026-09-17): keys the
		// .lh-electron CSS (app/globals.css) that turns the header bands
		// into the window's drag surface. Post-mount only — server HTML
		// and first client render must agree (no hydration mismatch),
		// and in the plain browser the class never appears.
		if (IS_ELECTRON) {
			document.documentElement.classList.add("lh-electron");
		}

		const stored = localStorage.getItem(STORAGE_KEY);
		// Default: open (first run introduces the sidebar).
		setOpen(stored === null ? true : stored === "1");
		setMounted(true);
	}, []);

	// Narrow-window auto-close/auto-restore (see SIDEBAR_AUTOCLOSE note):
	// fires only on actual resizes — a boolean compare, no layout work.
	// Both this and the mount effect land before the first paint, so a
	// narrow window never flashes the open sidebar on load.
	useEffect(() => {
		if (!IS_ELECTRON) return; // plain-browser tabs open freely
		const onResize = () => setNarrow(window.innerWidth < SIDEBAR_AUTOCLOSE);
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const toggle = useCallback(() => {
		// Opening while narrow (auto-closed, or the user's own closed-at-
		// narrow): ask the shell to widen to the threshold — the resize
		// listener flips `narrow` and the sidebar appears. The preference
		// persists like any other open, so a restart at a narrow width
		// still auto-restores when widened.
		if (narrow && !open) {
			localStorage.setItem(STORAGE_KEY, "0");
			setOpen(true);
			window.lh?.expandWindow();
			return;
		}
		setOpen((v) => {
			localStorage.setItem(STORAGE_KEY, v ? "0" : "1");
			return !v;
		});
	}, [narrow, open]);

	// ⌘B (keyboard wave A): the global shortcut dispatches lh:toggle-sidebar;
	// the context is the one place that owns open state, so it listens here.
	useEffect(() => {
		const onToggle = () => toggle();
		window.addEventListener("lh:toggle-sidebar", onToggle);
		return () => window.removeEventListener("lh:toggle-sidebar", onToggle);
	}, [toggle]);

	return (
		<SidebarContext.Provider value={{ open: open && !narrow, toggle }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/** Hamburger for page headers — only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount) —
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses —
 *  no popping in either direction. */
export function SidebarToggle() {
	const { open, toggle } = useSidebar();
	return (
		<span
			className={cn(
				"sidebar-motion lh-no-drag relative flex h-9 shrink-0 overflow-hidden duration-200",
				open ? "w-0 -mr-3" : "w-9 mr-0 lh-closed-toggle",
			)}
		>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open}
				tabIndex={open ? -1 : 0}
				onClick={toggle}
				className={cn("sidebar-motion duration-200", open ? "pointer-events-none opacity-0" : "opacity-100")}
			>
				{/* Owner, round 6: size-4, SAME as the close glyph — the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
		</span>
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
	kbdSelected = false,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
	/** Keyboard-cycle highlight (shortcut wave A: Alt+↑/↓ + Alt+Enter) —
	 *  visually distinct from the active session, which stays filled. */
	kbdSelected?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			data-testid={kbdSelected ? "session-row-kbd" : undefined}
			className={cn(
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
				active && "bg-accent",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
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
	const { open: openSettings } = useSettingsDialog();

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

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch lh:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	/* ── Keyboard seams (shortcut wave A, 2026-09-17) ── The sidebar owns
	   every session-list interaction, so the shortcuts land here: ⌘⇧F
	   focuses the search field; Alt+↑/↓ cycle the list (opening the sidebar
	   if it's closed — the keys work from anywhere, like the toggle does);
	   Alt+Enter opens the selected session. The selection is a row index
	   into `shown`, so a typed query narrows the cycle to the matches.
	   Mouse and keyboard coexist: hovering doesn't claim, a click or an
	   open clears the selection. */
	const [kbdIndex, setKbdIndex] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onFocusSearch = () => {
			if (!open) toggle();
			// A clipped (overflow-hidden) input still focuses — the sidebar's
			// slide-in doesn't gate the keystroke.
			requestAnimationFrame(() => searchRef.current?.focus());
		};
		window.addEventListener("lh:kbd-sessions-search", onFocusSearch);
		return () => window.removeEventListener("lh:kbd-sessions-search", onFocusSearch);
	}, [open, toggle]);

	useEffect(() => {
		const cycle = (dir: 1 | -1) => {
			setKbdIndex((i) => {
				const n = shown?.length ?? 0;
				if (n === 0) return null;
				if (i === null) return dir === 1 ? 0 : n - 1;
				return (i + dir + n) % n;
			});
		};
		const onPrev = () => {
			if (!open) toggle();
			cycle(-1);
		};
		const onNext = () => {
			if (!open) toggle();
			cycle(1);
		};
		const onOpenSelected = () => {
			const target = kbdIndex !== null ? shown?.[kbdIndex] : undefined;
			if (target) {
				router.push(`/chat/${target.id}`);
				setKbdIndex(null);
			}
		};
		window.addEventListener("lh:kbd-cycle-session-prev", onPrev);
		window.addEventListener("lh:kbd-cycle-session-next", onNext);
		window.addEventListener("lh:kbd-open-session", onOpenSelected);
		return () => {
			window.removeEventListener("lh:kbd-cycle-session-prev", onPrev);
			window.removeEventListener("lh:kbd-cycle-session-next", onNext);
			window.removeEventListener("lh:kbd-open-session", onOpenSelected);
		};
		// kbdIndex is read (not upserted) so Alt+Enter pushes OUTSIDE any
		// state updater — a router.push inside one is setState-in-render.
	}, [open, toggle, shown, router, kbdIndex]);

	// Keep the kbd-selected row in view (the rows are the container's only
	// buttons, so the index matches).
	useEffect(() => {
		if (kbdIndex === null) return;
		listRef.current?.querySelectorAll("button")[kbdIndex]?.scrollIntoView({ block: "nearest" });
	}, [kbdIndex]);

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
				{/* LH wordmark — the owner's header; close toggle sits at the edge.
				    Merged chrome (2026-09-17): in Electron this band is the
				    window's drag surface and starts after the traffic lights
				    (.lh-lights-gutter); in the browser those classes are inert. */}
				<div className="lh-drag lh-lights-gutter flex items-center justify-between px-4 py-3">
					{/* The owner's mark (2026-09-17) replaces the "LH" text — still the
					    home link, still vertically centered by the band's items-center.
					    The 92px .lh-lights-gutter keeps it clear of the traffic lights
					    with the lights' own edge-inset as the gap. */}
					{/* Hover mirrors the ghost toggle buttons (owner ask, 2026-09-17):
					    same size-9 chip geometry, same hover:bg-accent treatment. */}
					<Link
						href="/"
						aria-label="Home"
						className="lh-no-drag flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
					>
						<LhMark className="size-6" />
					</Link>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Close sidebar"
						onClick={toggle}
						className="lh-no-drag"
					>
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
							ref={searchRef}
							data-testid="session-search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							// Esc leaves the search (owner, keyboard wave): blur back
							// to normal, and claim the key so the window Esc chain
							// (dictation / abort) doesn't also fire.
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									e.currentTarget.blur();
								}
							}}
							placeholder="Search..."
							aria-label="Search sessions"
							className="h-6 rounded-sm border-border bg-background pl-6 text-xs placeholder:text-muted-foreground/60"
						/>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
					</span>
				</div>

				<div ref={listRef} className="flex-1 overflow-y-auto p-2">
					{shown === null ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
					) : shown.length === 0 ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">
							{query.trim() ? "No sessions match." : "No sessions yet."}
						</div>
					) : (
						shown.map((c, i) => (
							<SessionRow
								key={c.id}
								chat={c}
								active={pathname === `/chat/${c.id}`}
								kbdSelected={i === kbdIndex}
								onOpen={() => {
									setKbdIndex(null);
									router.push(`/chat/${c.id}`);
								}}
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

					{/* Settings entry (settings-app wave): same row language as
					    New session — quiet, bottom-pinned, opens the centered
					    dialog (also mod+, in the keyboard registry). */}
					<div className="px-3 pb-3 pt-1">
						<button
							type="button"
							onClick={() => openSettings()}
							data-testid="settings-entry"
							className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<SettingsIcon className="size-3" />
							Settings
						</button>
					</div>
				</div>
			</aside>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SettingsDialogProvider>
			<SessionsSidebar />
			<main className="min-w-0 flex-1">{children}</main>
			{/* The single document-level keydown listener (keyboard wave A) —
			    after the content in the tree, but it's window-level so order only
			    matters for the events it dispatches, never for DOM priority. */}
			<KeyboardShortcuts />
		</SettingsDialogProvider>
	);
}
