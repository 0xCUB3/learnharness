"use client";

import { useCallback, useEffect, useState } from "react";
import { ListChecksIcon, Loader2Icon } from "lucide-react";
import { formatTokens } from "@/components/usage-format";

/**
 * The extraction-coverage control (vision-extraction-coverage.md, settled
 * 2026-09-15): the graph view's window into WHAT THE PIPELINE HAS COVERED.
 * One button in the top-right chrome opens a panel with the exact coverage
 * of every session — covered/uncovered tokens and message counts — and a
 * per-session "Extract" button: the manual answer to an aborted run, a
 * pipeline error, or a session that went dormant under the chunk budget.
 *
 * Data: GET /api/graph/coverage (uncovered is DERIVED server-side —
 * fingerprint the transcript, diff the ledger — never dual-tracked).
 * Manual runs: POST /api/graph/coverage/extract; the run then surfaces in
 * the status chips + this panel's running row, and the graph refetches when
 * it finishes (the parent's runs-empty transition). The panel polls only
 * while open — no new standing poll.
 */

interface CoverageChat {
	chatId: string;
	title: string;
	updatedAt: string;
	totalMessages: number;
	coveredMessages: number;
	uncoveredMessages: number;
	coveredTokens: number;
	uncoveredTokens: number;
	running: boolean;
}

export function GraphCoverageControl({ refreshKey = 0 }: { refreshKey?: number }) {
	const [open, setOpen] = useState(false);
	const [chats, setChats] = useState<CoverageChat[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [extracting, setExtracting] = useState<string[]>([]); // click-pending ids (optimistic until the poll says running)

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/graph/coverage");
			if (!res.ok) return;
			const data = (await res.json()) as { chats: CoverageChat[] };
			setChats(data.chats);
			setLoaded(true);
			// Drop click-pending ids the server now reports as running (or
			// that have finished — coverage moved, so the row settled).
			setExtracting((ids) => ids.filter((id) => data.chats.find((c) => c.chatId === id)?.running === true));
		} catch {
			/* transient — the next tick retries */
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		void load();
		const timer = setInterval(load, 2000);
		return () => clearInterval(timer);
	}, [open, load, refreshKey]);

	const onExtract = async (chatId: string) => {
		setExtracting((ids) => [...ids, chatId]);
		try {
			const res = await fetch("/api/graph/coverage/extract", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatId }),
			});
			if (!res.ok && res.status !== 409) {
				console.error("manual extraction failed:", res.status);
				setExtracting((ids) => ids.filter((id) => id !== chatId));
				return;
			}
			// 409 = already running (e.g. the trigger raced us): the row's
			// running flag takes over on the next poll.
			void load();
		} catch {
			setExtracting((ids) => ids.filter((id) => id !== chatId));
		}
	};

	const pending = (chat: CoverageChat) => chat.running || extracting.includes(chat.chatId);
	return (
		<div className="relative">
			<button
				type="button"
				title="Extraction coverage — what the knowledge graph has covered"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`flex size-11 items-center justify-center rounded-xl border bg-card/85 shadow-lg backdrop-blur transition-colors hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				<ListChecksIcon className="size-4" />
			</button>
			{open && (
				<div className="absolute right-0 top-full mt-2">
					<CoveragePanel
						chats={chats}
						loaded={loaded}
						isBusy={(c) => pending(c)}
						onExtract={(c) => void onExtract(c.chatId)}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * The panel body — exported for static-render tests. Rows: exact coverage
 * numbers per session, "Extract" for the uncovered ones, "Running" while a
 * run is in flight.
 */
export function CoveragePanel({
	chats,
	loaded,
	isBusy,
	onExtract,
}: {
	chats: CoverageChat[];
	loaded: boolean;
	isBusy: (chat: CoverageChat) => boolean;
	onExtract: (chat: CoverageChat) => void;
}) {
	const anyUncovered = chats.some((c) => c.uncoveredTokens > 0 || c.uncoveredMessages > 0);
	return (
		<div
			data-testid="coverage-panel"
			className="flex max-h-[60vh] w-[24rem] flex-col rounded-xl border bg-card/85 p-2.5 shadow-lg backdrop-blur"
		>
			<div className="mb-1.5 flex items-baseline justify-between px-1">
				<span className="text-xs font-medium uppercase tracking-widest text-muted-foreground/70">
					Extraction coverage
				</span>
				<span className="text-xs text-muted-foreground">uncovered first</span>
			</div>
			{!anyUncovered && (
				<p className="px-1 py-2 text-xs text-muted-foreground">
					{loaded ? "Every session is fully extracted — nothing pending." : "…"}
				</p>
			)}
			<div className="flex flex-col gap-1 overflow-y-auto">
				{chats.map((c) => (
					<CoverageRow key={c.chatId} chat={c} busy={isBusy(c)} onExtract={() => onExtract(c)} />
				))}
			</div>
		</div>
	);
}

function CoverageRow({ chat, busy, onExtract }: { chat: CoverageChat; busy: boolean; onExtract: () => void }) {
	return (
		<div className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-accent/50" data-testid="coverage-row">
			<div className="min-w-0 flex-1">
				<div className="truncate text-xs text-foreground">{chat.title}</div>
				<div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
					{busy ? (
						<span className="flex items-center gap-1">
							<Loader2Icon className="size-3 animate-spin" /> extracting…
						</span>
					) : (
						<>
							<span className="tabular-nums">{formatTokens(chat.coveredTokens)} covered</span>
							{chat.uncoveredTokens > 0 && (
								<span className="tabular-nums text-foreground">
									{formatTokens(chat.uncoveredTokens)} uncovered
								</span>
							)}
							{chat.uncoveredTokens === 0 && <span>· complete</span>}
							{chat.uncoveredMessages > 0 && (
								<span className="tabular-nums">({chat.uncoveredMessages} msgs)</span>
							)}
						</>
					)}
				</div>
			</div>
			<button
				type="button"
				disabled={busy || chat.uncoveredTokens === 0}
				onClick={onExtract}
				className="shrink-0 rounded-lg border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
			>
				{busy ? "Running" : "Extract"}
			</button>
		</div>
	);
}