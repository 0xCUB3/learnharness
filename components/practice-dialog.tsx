"use client";

/**
 * The problem-set creation dialog (practice slice 5, 2026-09-29): the
 * three parameter dials + the session picker → POST /api/practice/sets
 * → router.push to the new exam page. In the delete-session dialog's
 * shape (portaled z-50, pure body exported for SSR pins).
 *
 * TWO OPEN MODES:
 *   - generic (the list page's "New problem set"): a session picker —
 *     the selection is "everything this session touched";
 *   - preselected (the sidebar's "Practice this session's
 *     propositions"): picker hidden, the session shown locked.
 *
 * Honest failures inline: 400 empty_selection → "This session has no
 * propositions yet" (verbatim per brief); 503 (models/key refusal) →
 * the server's line + an "Open settings" deep link (the zero-keys
 * precedent — setup owns the fix, the dialog owns the pointer).
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import type { ChatListItem } from "@/src/core";

/** The three dials — key order matches PracticeParams; anchors are the
 *  honest display (a raw 0..1 number tells the learner nothing). */
export const PRACTICE_DIALS = [
	{ key: "searchSolutionRatio", label: "Search ↔ Solve", anchors: "flashcard · competition" },
	{ key: "cueDistance", label: "Cue distance", anchors: "near the lesson · far transfer" },
	{ key: "presentation", label: "Presentation", anchors: "theory · application" },
] as const;

export interface PracticeFailure {
	status: number;
	error: string;
	code?: string;
}

/** The dialog's pure body — exported for SSR pins (the delete-session /
 *  settings body pattern). The wrapper owns state + fetch + portal. */
export function PracticeDialogBody({
	values,
	onDial,
	chats,
	selectedId,
	onSelect,
	lockedTitle,
	busy,
	failure,
	onOpenSettings,
	onClose,
	onRun,
}: {
	values: Record<(typeof PRACTICE_DIALS)[number]["key"], number>;
	onDial: (key: (typeof PRACTICE_DIALS)[number]["key"], v: number) => void;
	/** Null = preselected mode (picker hidden, `lockedTitle` shown). */
	chats: ChatListItem[] | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	lockedTitle: string | null;
	busy: boolean;
	failure: PracticeFailure | null;
	onOpenSettings: () => void;
	onClose: () => void;
	onRun: () => void;
}) {
	const canRun = !busy && (lockedTitle !== null || selectedId !== null);
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="New problem set"
			data-testid="practice-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[85vh] w-[32rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="font-title text-2xl tracking-tight">New problem set</h2>

			{/* The session: everything it touched (any provenance point). */}
			<div className="mt-4 flex flex-col gap-1">
				{lockedTitle !== null ? (
					<div data-testid="practice-dialog-locked" className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
						<span className="text-muted-foreground">From session — </span>
						<span className="font-medium">{lockedTitle}</span>
					</div>
				) : (
					<>
						<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Session</span>
						<div className="max-h-40 overflow-y-auto rounded-lg border" data-testid="practice-dialog-sessions">
							{(chats ?? []).map((chat) => (
								<button
									type="button"
									key={chat.id}
									data-testid={`practice-session-${chat.id}`}
									onClick={() => onSelect(chat.id)}
									className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
										selectedId === chat.id ? "bg-accent" : ""
									}`}
								>
									<span className="truncate">{chat.title}</span>
									{selectedId === chat.id && <span className="ml-2 text-xs text-muted-foreground">selected</span>}
								</button>
							))}
							{(chats ?? []).length === 0 && (
								<div className="px-3 py-2 text-sm text-muted-foreground">No sessions yet.</div>
							)}
						</div>
					</>
				)}
			</div>

			{/* The three dials (SettingSlider's markup, anchors as display). */}
			<div className="mt-4 flex flex-col gap-3">
				{PRACTICE_DIALS.map((dial) => (
					<label key={dial.key} className="flex flex-col gap-1">
						<span className="flex items-center justify-between text-[11px] text-muted-foreground">
							{dial.label}
							<span className="text-muted-foreground/80">{dial.anchors}</span>
						</span>
						<input
							type="range"
							min={0}
							max={1}
							step={0.1}
							value={values[dial.key]}
							data-testid={`dial-${dial.key}`}
							onChange={(e) => onDial(dial.key, Number(e.target.value))}
							className="h-1.5 w-full accent-primary"
						/>
					</label>
				))}
			</div>

			{failure && (
				<div data-testid="practice-dialog-error" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{failure.code === "empty_selection" ? "This session has no propositions yet" : failure.error}
					{failure.status === 503 && (
						<button
							type="button"
							data-testid="practice-dialog-open-settings"
							onClick={onOpenSettings}
							className="ml-2 underline underline-offset-2"
						>
							Open settings
						</button>
					)}
				</div>
			)}

			<div className="mt-5 flex justify-end gap-2">
				<button
					type="button"
					onClick={onClose}
					disabled={busy}
					className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="practice-dialog-create"
					onClick={onRun}
					disabled={!canRun}
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
				>
					{busy ? "Creating…" : "Create"}
				</button>
			</div>
		</div>
	);
}

/** The stateful wrapper: fetches the session list (generic mode), runs
 *  the create POST, navigates on 202. Null `preselected` = generic. */
export function PracticeDialog({
	preselected,
	onClose,
}: {
	preselected: { chatId: string; title: string } | null;
	onClose: () => void;
}) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [values, setValues] = useState<Record<(typeof PRACTICE_DIALS)[number]["key"], number>>({
		searchSolutionRatio: 0.5,
		cueDistance: 0.5,
		presentation: 0.5,
	});
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<PracticeFailure | null>(null);

	// Generic mode: the picker's truth is the chat list (fresh on open).
	useEffect(() => {
		if (preselected) return;
		let alive = true;
		fetch("/api/chats", { cache: "no-store" })
			.then((res) => res.json() as Promise<{ chats: ChatListItem[] }>)
			.then((d) => {
				if (alive) setChats(d.chats);
			})
			.catch(() => {
				if (alive) setChats([]);
			});
		return () => {
			alive = false;
		};
	}, [preselected]);

	// Esc closes (claimed, the delete-session discipline).
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const run = useCallback(async () => {
		const chatId = preselected?.chatId ?? selectedId;
		if (!chatId || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch("/api/practice/sets", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatId, params: values }),
			});
			const body = (await res.json()) as { id?: string; error?: string; code?: string };
			if (!res.ok || !body.id) {
				setFailure({ status: res.status, error: body.error ?? `Create failed (${res.status})`, code: body.code });
				setBusy(false);
				return;
			}
			router.push(`/practice/${body.id}`);
		} catch {
			setFailure({ status: 0, error: "Create failed — network error. Try again." });
			setBusy(false);
		}
	}, [preselected, selectedId, busy, values, router]);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			onClick={() => {
				if (!busy) onClose();
			}}
		>
			<PracticeDialogBody
				values={values}
				onDial={(key, v) => setValues((prev) => ({ ...prev, [key]: v }))}
				chats={preselected ? null : (chats ?? [])}
				selectedId={selectedId}
				onSelect={setSelectedId}
				lockedTitle={preselected?.title ?? null}
				busy={busy}
				failure={failure}
				onOpenSettings={() => openSettings()}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}
