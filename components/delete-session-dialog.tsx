"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatDeleteMode, ChatListItem } from "@/src/core";

/** The locked two-option design (owner 2026-09-22/23) — plain-language
 *  consequences, the graph-touching option says so. Exported pure for
 *  render pins: the copy is design, not implementation. */
export const DELETE_OPTIONS: {
	mode: ChatDeleteMode;
	testid: string;
	title: string;
	body: string;
}[] = [
	{
		mode: "preserve-graph",
		testid: "delete-option-preserve",
		title: "Delete the session only",
		body: "Everything this session added to the graph stays — topics, links, and notes it produced remain untouched.",
	},
	{
		mode: "delete-nodes",
		testid: "delete-option-nodes",
		title: "Also remove its graph traces",
		body: "This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only this session created are removed entirely.",
	},
];

/**
 * Session deletion (wave 6 chunk A) — THE destructive-confirmation surface,
 * portaled z-50 like the setup dialog. Two options per the locked design,
 * consequences in plain language; the one that touches the graph says so:
 *
 *   preserve-graph  the session record, its jobs, and its extraction
 *                   bookkeeping die; the graph keeps every contribution.
 *   delete-nodes    the session's ledger traces go too — shared topics
 *                   survive (other sessions / imported notes still
 *                   reference them), topics only this session created
 *                   are removed entirely.
 *
 * Retryable failures render honestly with a Try-again: 409 turn_in_flight /
 * jobs_running ("wait for running work") and 503 extraction_winding_down
 * ("in a moment") both clear on their own — the server's error line is
 * already written for the user; we show it verbatim.
 */
export function DeleteSessionDialog({
	chat,
	onClose,
	onDeleted,
}: {
	/** The session up for deletion; null = closed. */
	chat: Pick<ChatListItem, "id" | "title"> | null;
	onClose: () => void;
	/** Success path — the sidebar owns navigation + list patching. */
	onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
}) {
	const [busy, setBusy] = useState<ChatDeleteMode | null>(null);
	// The failure carries the mode it came from — Try-again re-runs THAT
	// mode (busy is back to null by then, so it can't be read off busy).
	const [failure, setFailure] = useState<{ code: string; error: string; mode: ChatDeleteMode } | null>(null);

	// Fresh state per session: closing resets, opening a new chat starts clean.
	useEffect(() => {
		if (!chat) {
			setBusy(null);
			setFailure(null);
		}
	}, [chat]);

	// Esc closes (claimed — a menu/dialog Esc must not also abort a turn).
	useEffect(() => {
		if (!chat) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [chat, onClose]);

	const run = async (mode: ChatDeleteMode) => {
		if (!chat || busy) return;
		setBusy(mode);
		setFailure(null);
		try {
			const res = await fetch(`/api/chats/${chat.id}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json()) as {
				ok?: boolean;
				error?: string;
				code?: string;
				graphRevision?: number;
			};
			if (!res.ok) {
				// 409 (turn/jobs running) and 503 (extraction winding down) are
				// both retryable — keep the dialog open, show the server's line.
				setFailure({
					code: body.code ?? "error",
					error: body.error ?? `Delete failed (${res.status})`,
					mode,
				});
				setBusy(null);
				return;
			}
			onDeleted(chat.id, mode, body.graphRevision ?? 0);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again.", mode });
			setBusy(null);
		}
	};

	if (!chat) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			onClick={() => {
				if (!busy) onClose();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Delete session"
				data-testid="delete-session-dialog"
				onClick={(e) => e.stopPropagation()}
				className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="font-title text-2xl tracking-tight">Delete “{chat.title}”?</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					This permanently removes the session — its messages, background jobs, and extraction records. Pick how
					far it reaches:
				</p>
				<div className="mt-4 flex flex-col gap-2">
					{DELETE_OPTIONS.map((option) => (
						<button
							key={option.mode}
							type="button"
							data-testid={option.testid}
							disabled={busy !== null}
							onClick={() => void run(option.mode)}
							className="flex flex-col items-start rounded-lg border border-border/60 px-4 py-3 text-left transition-colors hover:bg-accent disabled:opacity-40"
						>
							<span className="text-sm text-foreground">{option.title}</span>
							<span className="mt-1 text-xs text-muted-foreground">{option.body}</span>
						</button>
					))}
				</div>
				{failure && (
					<div
						role="alert"
						data-testid="delete-failure"
						className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
					>
						<span className="text-foreground">{failure.error}</span>
						<button
							type="button"
							data-testid="delete-retry"
							onClick={() => failure && void run(failure.mode)}
							disabled={busy !== null}
							className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
						>
							Try again
						</button>
					</div>
				)}
				<div className="mt-4 flex justify-end">
					<button
						type="button"
						data-testid="delete-cancel"
						onClick={onClose}
						disabled={busy !== null}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
					>
						{busy ? "Deleting…" : "Cancel"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}