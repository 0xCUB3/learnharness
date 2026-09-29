"use client";

/**
 * The problem-set list (practice slice 5): rows of sets — title, date,
 * status, problem/graded counts — click through to the exam page; a
 * delete affordance in the delete-session dialog's shape; "New problem
 * set" opens the creation dialog. Polls /api/practice/sets (2s, the
 * graph-view reveal-poll idiom) while ANY set is still generating, so
 * statuses live-update; a settled list stops polling.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { PlusIcon, TrashIcon } from "lucide-react";
import type { ProblemSet } from "@/src/core";
import { PracticeDialog } from "@/components/practice-dialog";

/** A set's status word — plain and honest, no invented progress. */
export function setStatusWord(set: Pick<ProblemSet, "status">): string {
	return set.status === "partitioning" ? "partitioning" : set.status === "generating" ? "generating" : set.status;
}

/** The list's pure body — exported for SSR pins. Rows are buttons
 *  (click-through); the delete affordance is a nested icon button. */
export function PracticeListBody({
	sets,
	onOpen,
	onDelete,
	onNew,
}: {
	sets: ProblemSet[];
	onOpen: (id: string) => void;
	onDelete: (set: ProblemSet) => void;
	onNew: () => void;
}) {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-6" data-testid="practice-list">
			<div className="flex items-center justify-between">
				<h1 className="font-title text-3xl tracking-tight">Practice</h1>
				<button
					type="button"
					data-testid="practice-new"
					onClick={onNew}
					className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
				>
					<PlusIcon className="size-3.5" />
					New problem set
				</button>
			</div>

			{sets.length === 0 && (
				<div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground" data-testid="practice-empty">
					No problem sets yet — create one from a session.
				</div>
			)}

			<div className="flex flex-col gap-2">
				{sets.map((set) => {
					const ready = set.problems.filter((p) => p.status === "ready").length;
					const graded = set.problems.filter((p) => p.grade).length;
					return (
						<div key={set.id} className="flex items-stretch gap-1">
							<button
								type="button"
								data-testid={`practice-row-${set.id}`}
								onClick={() => onOpen(set.id)}
								className="flex flex-1 items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50"
							>
								<span className="min-w-0">
									<span className="block truncate font-medium">{set.title}</span>
									<span className="block text-xs text-muted-foreground">
										{set.createdAt.slice(0, 10)} · {set.problems.length > 0 ? `${ready}/${set.problems.length} problems` : "no problems yet"}
										{graded > 0 ? ` · ${graded} graded` : ""}
									</span>
								</span>
								<span
									data-testid={`practice-status-${set.id}`}
									className={`shrink-0 text-xs uppercase tracking-wide ${
										set.status === "error" ? "text-destructive" : "text-muted-foreground"
									}`}
								>
									{setStatusWord(set)}
								</span>
							</button>
							<button
								type="button"
								data-testid={`practice-delete-${set.id}`}
								aria-label={`Delete ${set.title}`}
								onClick={() => onDelete(set)}
								className="flex items-center rounded-xl border px-3 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
							>
								<TrashIcon className="size-4" />
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** The delete confirm — the delete-session dialog's shape (no mode
 *  checkbox: a set has no preserve-graph question). Pure body + portal
 *  wrapper. */
export function DeleteSetBody({
	title,
	busy,
	failure,
	onClose,
	onRun,
}: {
	title: string;
	busy: boolean;
	failure: string | null;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete problem set"
			data-testid="delete-set-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="font-title text-2xl tracking-tight text-destructive">Delete problem set?</h2>
			<p className="mt-2 font-mono text-sm">{title}</p>
			<p className="mt-3 text-sm text-muted-foreground">
				The set and its problems are removed. Nothing in the graph or your sessions changes.
			</p>
			{failure && (
				<p data-testid="delete-set-error" className="mt-3 text-sm text-destructive">
					{failure}
				</p>
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
					data-testid="delete-set-run"
					onClick={onRun}
					disabled={busy}
					className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
}

export function PracticeListPage({ initialSets }: { initialSets: ProblemSet[] }) {
	const router = useRouter();
	const [sets, setSets] = useState<ProblemSet[]>(initialSets);
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState<ProblemSet | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [deleteFailure, setDeleteFailure] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/practice/sets", { cache: "no-store" });
			if (!res.ok) return;
			const d = (await res.json()) as { sets: ProblemSet[] };
			setSets(d.sets);
		} catch {
			// a transient failure on the poll keeps the last snapshot
		}
	}, []);

	// The reveal poll: while any set is partitioning/generating, statuses
	// live-update; a settled list goes quiet.
	const anyRunning = sets.some((s) => s.status === "partitioning" || s.status === "generating");
	useEffect(() => {
		if (!anyRunning) return;
		const t = setInterval(() => void refresh(), 2000);
		return () => clearInterval(t);
	}, [anyRunning, refresh]);

	const runDelete = useCallback(async () => {
		if (!deleting || deleteBusy) return;
		setDeleteBusy(true);
		setDeleteFailure(null);
		try {
			const res = await fetch(`/api/practice/sets/${deleting.id}`, { method: "DELETE" });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setDeleteFailure(body.error ?? `Delete failed (${res.status})`);
				setDeleteBusy(false);
				return;
			}
			setDeleting(null);
			setDeleteBusy(false);
			await refresh();
		} catch {
			setDeleteFailure("Delete failed — network error. Try again.");
			setDeleteBusy(false);
		}
	}, [deleting, deleteBusy, refresh]);

	return (
		<>
			<PracticeListBody
				sets={sets}
				onOpen={(id) => router.push(`/practice/${id}`)}
				onDelete={(set) => setDeleting(set)}
				onNew={() => setCreating(true)}
			/>
			{creating && <PracticeDialog onClose={() => setCreating(false)} />}
			{deleting &&
				createPortal(
					<div
						className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
						onClick={() => {
							if (!deleteBusy) setDeleting(null);
						}}
					>
						<DeleteSetBody
							title={deleting.title}
							busy={deleteBusy}
							failure={deleteFailure}
							onClose={() => setDeleting(null)}
							onRun={() => void runDelete()}
						/>
					</div>,
					document.body,
				)}
		</>
	);
}
