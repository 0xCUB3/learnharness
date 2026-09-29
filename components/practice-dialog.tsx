"use client";

/**
 * The problem-set creation dialog (practice slice 5, 2026-09-29;
 * cluster-picker fix same evening): the three parameter dials + the
 * CLUSTER picker → POST /api/practice/sets → router.push to the new
 * exam page. In the delete-session dialog's shape (portaled z-50, pure
 * body exported for SSR pins).
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
import type { GraphClusterGroup } from "@/src/core";

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
	clusters,
	selectedKey,
	onSelect,
	busy,
	failure,
	onOpenSettings,
	onClose,
	onRun,
}: {
	values: Record<(typeof PRACTICE_DIALS)[number]["key"], number>;
	onDial: (key: (typeof PRACTICE_DIALS)[number]["key"], v: number) => void;
	clusters: GraphClusterGroup[];
	selectedKey: string | null;
	onSelect: (key: string) => void;
	busy: boolean;
	failure: PracticeFailure | null;
	onOpenSettings: () => void;
	onClose: () => void;
	onRun: () => void;
}) {
	const canRun = !busy && selectedKey !== null;
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

			{/* The cluster: a birth-session group of the graph, resolved to
			    node ids on create (graph-domain, owner 2026-09-29). */}
			<div className="mt-4 flex flex-col gap-1">
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Cluster</span>
				<div className="max-h-40 overflow-y-auto rounded-lg border" data-testid="practice-dialog-clusters">
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
								{cluster.label ?? <span className="text-muted-foreground/60">unlabeled cluster</span>}
							</span>
							<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
								{cluster.kind === "notes" ? "notes · " : ""}
								{cluster.nodeCount} propositions
							</span>
						</button>
					))}
					{clusters.length === 0 && (
						<div className="px-3 py-2 text-sm text-muted-foreground">
							No clusters yet — a cluster appears once a session births its first proposition.
						</div>
					)}
				</div>
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
					{failure.code === "empty_selection" ? "Nothing practicable is left in that cluster — the graph changed." : failure.error}
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
export function PracticeDialog({ onClose }: { onClose: () => void }) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [values, setValues] = useState<Record<(typeof PRACTICE_DIALS)[number]["key"], number>>({
		searchSolutionRatio: 0.5,
		cueDistance: 0.5,
		presentation: 0.5,
	});
	const [clusters, setClusters] = useState<GraphClusterGroup[] | null>(null);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<PracticeFailure | null>(null);

	// The picker's truth is the graph's clustering (fresh on open).
	useEffect(() => {
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
		const picked = (clusters ?? []).find((c) => c.key === selectedKey);
		if (!picked || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch("/api/practice/sets", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					nodeIds: picked.nodeIds,
					params: values,
					title: picked.label ?? undefined,
				}),
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
	}, [clusters, selectedKey, busy, values, router]);

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
