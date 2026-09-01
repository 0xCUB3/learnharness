"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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

/** The left-edge phase strip color — one system with the header chip and
 *  the transcript dividers (globals.css --phase-*). */
const PHASE_STRIP: Record<Phase3, string> = {
	probe: "bg-phase-probe",
	plan: "bg-phase-plan",
	teach: "bg-phase-teach",
};

/**
 * The session-status dot, left of the title. One visual family: a pulsing
 * attention ring when an answer is owed (your move — the session is blocked
 * on the learner), a quietly breathing dot while the teacher works (a turn
 * running or a background job in flight), and NOTHING when it's simply the
 * learner's turn to type — quiet is the correct default. A pending answer
 * outranks "working": there is nothing else for the learner to do first.
 */
function SessionStatusDot({ pending, busy }: { pending: boolean; busy: boolean }) {
	const label = pending ? "Waiting for your answer" : busy ? "Teacher is working" : null;
	return (
		<span className="flex w-3 shrink-0 items-center justify-center" title={label ?? undefined}>
			{pending ? (
				<span
					data-testid="session-dot-attention"
					className="size-2 rounded-full bg-attention lh-dot-attention"
				/>
			) : busy ? (
				<span
					data-testid="session-dot-working"
					className="size-2 rounded-full bg-muted-foreground lh-dot-breathe"
				/>
			) : (
				/* empty slot: keeps every title on the same baseline */
				<span className="size-2" />
			)}
			{label && <span className="sr-only">{label}</span>}
		</span>
	);
}

/**
 * One session row: the leftmost phase strip (bookmark tick, one color system
 * with the header chip and transcript dividers), the status dot, then title
 * + meta. Exported for render tests — pure function of the list item.
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
			<span
				data-testid={`phase-strip-${chat.phase}`}
				className={cn(
					"absolute top-2 bottom-2 left-0.5 w-[3px] rounded-full",
					PHASE_STRIP[chat.phase],
				)}
				aria-hidden
			/>
			<SessionStatusDot pending={chat.pendingQuestion} busy={chat.busy} />
			<span className="min-w-0 flex-1">
				<span className="block truncate">{chat.title}</span>
				<span className="block text-xs text-muted-foreground">
					{chat.messageCount} messages · {new Date(chat.updatedAt).toLocaleDateString()}
				</span>
			</span>
		</button>
	);
}

function SessionsSidebar() {
	const { open, toggle } = useSidebar();
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const pathname = usePathname();
	const router = useRouter();

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
						chats.map((c) => (
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
