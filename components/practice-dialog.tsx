"use client";

/**
 * The problem-set creation dialog (practice slice 5, 2026-09-29;
 * cluster-picker + discretized-axes fixes same evening): the three
 * NAMED-LEVEL parameters — a 5-detent ladder slider, a 3-detent cue
 * slider, a Theory|Application toggle — + the CLUSTER picker → POST
 * /api/practice/sets → router.push to the new exam page. In the
 * delete-session dialog's shape (portaled z-50, pure body exported for
 * SSR pins).
 *
 * GRAPH-DOMAIN, NOT CHAT-DOMAIN (owner ruling 2026-09-29): problem sets
 * take NODES. The picker lists the birth-session clusters the graph
 * view renders (GET /api/graph/clusters); picking one resolves to its
 * member node ids, and the cluster's label rides along as the set's
 * title. This dialog is the ONLY creation entry for now — the graph-view
 * cluster entry comes later with the free-form selection UI.
 *
 * Honest failures inline: 400 empty_selection (the vanished-nodes edge
 * — the cluster's propositions are gone) renders the honest line;
 * 503 (models/key refusal) renders the server's line + an "Open
 * settings" deep link (the zero-keys precedent — setup owns the fix,
 * the dialog owns the pointer).
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { CUE_LEVELS, LADDER_RUNGS, PRESENTATIONS } from "@/src/core";
import type { GraphClusterGroup, PracticeParams } from "@/src/core";

/** The creation defaults (owner, 2026-09-29): rung 2 Direct exercise,
 *  cue 1 Adjacent context, Theory. */
export const DEFAULT_PRACTICE_PARAMS: PracticeParams = {
	ladderRung: 2,
	cueDistance: 1,
	presentation: "theory",
};

/** The two creation modes (chains overlay, owner plan 2026-09-29):
 *  "cluster" — the /practice page's picker (stays cluster-ONLY, owner
 *  ruling 2026-09-29); "custom" — the graph view's chain table hands in
 *  a free-form node selection; no picker, a selection summary instead. */
export type PracticeDialogMode = "cluster" | "custom";

/** The custom mode's handoff: the flat node-id selection + the derived
 *  shape (chainsForSelection over the selection — the overlay computes
 *  it for its pinned preview and passes the same numbers here). */
export interface PracticeSelection {
	nodeIds: string[];
	propositions: number;
	chains: number;
}

export interface PracticeFailure {
	status: number;
	error: string;
	code?: string;
}

/** The dialog's pure body — exported for SSR pins (the delete-session /
 *  settings body pattern). The wrapper owns state + fetch + portal. */
export function PracticeDialogBody({
	mode = "cluster",
	params,
	onParam,
	note,
	onNote,
	clusters,
	selectedKey,
	onSelect,
	selection,
	busy,
	failure,
	onOpenSettings,
	onClose,
	onRun,
}: {
	mode?: PracticeDialogMode;
	params: PracticeParams;
	onParam: (patch: Partial<PracticeParams>) => void;
	/** The learner's free-form note (owner, 2026-09-29) — optional,
	 *  typing-only; carried to the partitioner + generators as additional
	 *  input they weigh but need not follow. */
	note: string;
	onNote: (note: string) => void;
	clusters: GraphClusterGroup[];
	selectedKey: string | null;
	onSelect: (key: string) => void;
	/** The custom mode's handoff (chain-table selections). */
	selection?: PracticeSelection;
	busy: boolean;
	failure: PracticeFailure | null;
	onOpenSettings: () => void;
	onClose: () => void;
	onRun: () => void;
}) {
	const canRun = !busy && (mode === "custom" ? (selection?.nodeIds.length ?? 0) > 0 : selectedKey !== null);
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

			{/* The cluster picker — CLUSTER mode only (custom mode replaces
			    it with the selection summary below): a birth-session group of
			    the graph, resolved to node ids on create (graph-domain, owner
			    2026-09-29). */}
			{mode === "cluster" && (
				<div className="mt-4 flex flex-col gap-1">
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">
					Cluster
				</span>
				<div
					className="max-h-40 overflow-y-auto rounded-lg border"
					data-testid="practice-dialog-clusters"
				>
					{clusters.map((cluster) => (
						<button
							type="button"
							key={cluster.key}
							data-testid={`practice-cluster-${cluster.key}`}
							onClick={() => onSelect(cluster.key)}
							className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
								selectedKey === cluster.key ? "bg-accent" : ""
							}`}
						>
							<span className="min-w-0 truncate">
								{cluster.label ?? (
									<span className="text-muted-foreground/60">
										unlabeled cluster
									</span>
								)}
							</span>
							<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
								{cluster.kind === "notes" ? "notes · " : ""}
								{cluster.nodeCount} propositions
							</span>
						</button>
					))}
					{clusters.length === 0 && (
						<div className="px-3 py-2 text-sm text-muted-foreground">
							No clusters yet — a cluster appears once a session births its
							first proposition.
						</div>
					)}
				</div>
			</div>
			)}

			{/* CUSTOM mode: no picker — the chain table already chose. The
			    dated default title (the pipeline's own `Practice — date`,
			    stamped server-side when no title is posted) + the derived
			    shape of the handoff. */}
			{mode === "custom" && (
				<div className="mt-4 flex flex-col gap-1" data-testid="practice-dialog-selection">
					<span className="text-xs uppercase tracking-widest text-muted-foreground/70">
						Selection
					</span>
					<div className="rounded-lg border bg-accent/30 px-3 py-2 text-sm">
						<div className="text-muted-foreground">Practice — {new Date().toISOString().slice(0, 10)}</div>
						<div data-testid="practice-dialog-selection-line">
							{selection?.propositions ?? 0} {selection?.propositions === 1 ? "proposition" : "propositions"} →{" "}
							{selection?.chains ?? 0} {selection?.chains === 1 ? "chain" : "chains"}
						</div>
					</div>
				</div>
			)}

			{/* The three parameters — named levels, never a number to
			    interpolate (owner, 2026-09-29). Stepped sliders snap to the
			    detents; each shows the level's NAME + its one-line
			    definition; presentation is a two-segment toggle. */}
			<div className="mt-4 flex flex-col gap-3">
				<div className="flex flex-col gap-1">
					<span className="flex items-center justify-between text-[11px] text-muted-foreground">
						Ladder
						<span className="text-muted-foreground/80">0 · 1 · 2 · 3 · 4</span>
					</span>
					<input
						type="range"
						min={0}
						max={4}
						step={1}
						value={params.ladderRung}
						data-testid="param-ladder"
						onChange={(e) =>
							onParam({
								ladderRung: Number(
									e.target.value,
								) as PracticeParams["ladderRung"],
							})
						}
						className="h-1.5 w-full accent-primary"
					/>
					<span data-testid="param-ladder-level" className="text-xs">
						<span className="font-medium">
							{LADDER_RUNGS[params.ladderRung].name}
						</span>
						<span className="text-muted-foreground">
							{" "}
							— {LADDER_RUNGS[params.ladderRung].definition}
						</span>
					</span>
				</div>
				<div className="flex flex-col gap-1">
					<span className="flex items-center justify-between text-[11px] text-muted-foreground">
						Cue distance
						<span className="text-muted-foreground/80">0 · 1 · 2</span>
					</span>
					<input
						type="range"
						min={0}
						max={2}
						step={1}
						value={params.cueDistance}
						data-testid="param-cue"
						onChange={(e) =>
							onParam({
								cueDistance: Number(
									e.target.value,
								) as PracticeParams["cueDistance"],
							})
						}
						className="h-1.5 w-full accent-primary"
					/>
					<span data-testid="param-cue-level" className="text-xs">
						<span className="font-medium">
							{CUE_LEVELS[params.cueDistance].name}
						</span>
						<span className="text-muted-foreground">
							{" "}
							— {CUE_LEVELS[params.cueDistance].definition}
						</span>
					</span>
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-[11px] text-muted-foreground">
						Presentation
					</span>
					<div className="flex gap-1" data-testid="param-presentation">
						{(["theory", "application"] as const).map((pres) => (
							<button
								type="button"
								key={pres}
								data-testid={`param-presentation-${pres}`}
								onClick={() => onParam({ presentation: pres })}
								className={`flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors ${
									params.presentation === pres
										? "border-primary bg-primary/10 font-medium text-foreground"
										: "text-muted-foreground hover:bg-accent"
								}`}
							>
								{PRESENTATIONS[pres].name}
							</button>
						))}
					</div>
					<span
						data-testid="param-presentation-level"
						className="text-xs text-muted-foreground"
					>
						{PRESENTATIONS[params.presentation].definition}
					</span>
				</div>
				{/* The learner's free-form note — the last word before create:
			    wishes for the problems, weighed by the agents, nothing owed. */}
				<div className="flex flex-col gap-1">
					<span className="text-[11px] text-muted-foreground">
						Anything else? (optional)
					</span>
					<textarea
						value={note}
						data-testid="practice-note"
						onChange={(e) => onNote(e.target.value)}
						rows={3}
						maxLength={2000}
						placeholder="Anything you want the problems to lean toward — situations, emphasis, context about you. The agents weigh it; nothing is promised."
						className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
					/>
				</div>
			</div>

			{failure && (
				<div
					data-testid="practice-dialog-error"
					className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					{failure.code === "empty_selection"
						? "Nothing practicable is left in that cluster — the graph changed."
						: failure.error}
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

/** The stateful wrapper: fetches the cluster list, runs the create POST
 *  (nodeIds + the cluster's label as title + params), navigates on 202. */
export function PracticeDialog({
	mode = "cluster",
	selection,
	onClose,
}: {
	mode?: PracticeDialogMode;
	selection?: PracticeSelection;
	onClose: () => void;
}) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [params, setParams] = useState<PracticeParams>({
		...DEFAULT_PRACTICE_PARAMS,
	});
	const [note, setNote] = useState("");
	const [clusters, setClusters] = useState<GraphClusterGroup[] | null>(null);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<PracticeFailure | null>(null);

	// The picker's truth is the graph's clustering (fresh on open).
	// The picker's truth is the graph's clustering (fresh on open) —
	// cluster mode only; custom mode arrives with its selection in hand.
	useEffect(() => {
		if (mode !== "cluster") return;
		let alive = true;
		fetch("/api/graph/clusters", { cache: "no-store" })
			.then((res) => res.json() as Promise<{ clusters: GraphClusterGroup[] }>)
			.then((d) => {
				if (alive) setClusters(d.clusters);
			})
			.catch(() => {
				if (alive) setClusters([]);
			});
		return () => {
			alive = false;
		};
	}, []);

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
		if (busy) return;
		// The POST payload, by mode: custom mode sends the chain table's
		// nodeIds with NO title (the pipeline stamps its dated default);
		// cluster mode resolves the group + posts its label as title.
		let postNodeIds: string[];
		let postTitle: string | undefined;
		if (mode === "custom") {
			if (!selection || selection.nodeIds.length === 0) return;
			postNodeIds = selection.nodeIds;
			postTitle = undefined;
		} else {
			const picked = (clusters ?? []).find((c) => c.key === selectedKey);
			if (!picked) return;
			postNodeIds = picked.nodeIds;
			postTitle = picked.label ?? undefined;
		}
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch("/api/practice/sets", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					nodeIds: postNodeIds,
					params,
					title: postTitle,
					note: note.trim() || undefined,
				}),
			});
			const body = (await res.json()) as {
				id?: string;
				error?: string;
				code?: string;
			};
			if (!res.ok || !body.id) {
				setFailure({
					status: res.status,
					error: body.error ?? `Create failed (${res.status})`,
					code: body.code,
				});
				setBusy(false);
				return;
			}
			router.push(`/practice/${body.id}`);
		} catch {
			setFailure({
				status: 0,
				error: "Create failed — network error. Try again.",
			});
			setBusy(false);
		}
	}, [mode, selection, clusters, selectedKey, busy, params, note, router]);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			onClick={() => {
				if (!busy) onClose();
			}}
		>
			<PracticeDialogBody
				mode={mode}
				params={params}
				selection={selection}
				onParam={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
				note={note}
				onNote={setNote}
				clusters={clusters ?? []}
				selectedKey={selectedKey}
				onSelect={setSelectedKey}
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
