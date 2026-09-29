"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** The impact read's shape (GET /api/graph/nodes/[id]): counts of what
 *  full death would take with it, plus the referencing session/source
 *  ids — the CLIENT joins display names from its snapshot (chats map +
 *  imported-notes file paths). DRIFT FIX (2026-09-30, found via the
 *  chain-table delete): quizEvents/observations were removed from the
 *  server's NodeDeletionImpact when the quiz-events ledger died in the
 *  practice-arc schema slim — the dialog kept rendering the dead
 *  fields as undefined. The facts below now match what the server can
 *  honestly report: links + referencing sessions. */
export interface NodeImpact {
	edges: number;
	sessions: string[];
}

/** Join an id to its display name: chat titles from the snapshot's
 *  sessions map, imported-notes paths from fileSources; an unknown id
 *  renders honestly as itself. Exported pure for render pins. */
export function sessionNameOf(
	id: string,
	sessions: Record<string, string>,
	fileSources: Record<string, string>,
): string {
	return sessions[id] ?? fileSources[id] ?? id;
}

/** The 409 extraction_running line (owner phrasing, node interlude):
 *  the server's error names the extraction; the ACTIVITY DOCK is the
 *  surface the user actually watches drain. Exported pure for pins. */
export const EXTRACTION_RETRY_LINE = "An extraction is running — try again when the activity dock drains.";

/** The fact line for one count — honest plurals, no theater ("0 edges"
 *  reads plainly; hiding a zero fact would understate the blast). */
export function countLine(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Node deletion (node interlude, Platform's 50bfcba engine) — the
 * confirm surface, portaled z-50 like the session-delete dialog whose
 * tone it follows. FULL DEATH by owner ruling: the node, every edge
 * touching it, every quiz/observation event naming it, its mapping
 * lines, its position. The impact facts render plainly so the user
 * weighs the blast radius; "this cannot be undone" says the permanence.
 *
 * The 409 extraction_running gets the dock phrasing (the server's
 * honest line names the extraction; the ACTIVITY DOCK is the surface
 * the user actually watches drain) with a Try-again — the run is never
 * aborted server-side, it clears on its own. The 404 (deleted elsewhere
 * meanwhile) states it plainly and closes into the same refresh: the
 * next snapshot read tells the truth.
 */
/** The dialog's pure body — exported for SSR pins (the settings-dialog
 *  body pattern). The wrapper owns state + effects + the portal. */
export function DeleteNodeBody({
	nodes,
	joins,
	impact,
	busy,
	failure,
	onClose,
	onRun,
}: {
	/** One node (the canvas context menu) or many (the chain table's
	 *  selection, owner 2026-09-29 night: THE deletion view). One renders
	 *  exactly as always; many pluralize the title and list the names. */
	nodes: { id: string; name: string }[];
	joins: { sessions: Record<string, string>; fileSources: Record<string, string> };
	impact: NodeImpact | "loading" | "gone";
	busy: boolean;
	failure: { code: string; error: string } | null;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete topic"
			data-testid="delete-node-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="font-title text-2xl tracking-tight text-destructive">
				{nodes.length === 1 ? "Delete node?" : `Delete ${nodes.length} propositions?`}
			</h2>
			{/* The node name(s) below the title in JetBrains Mono (owner,
			    2026-09-24): the name is the payload — mono suits it, and
			    NO code-block chrome (the font already says code), sized up
			    to text-lg so it reads. Same shape as the session dialog.
			    A multi-selection lists its names (capped at 8 + "and K
			    more" — the facts below already carry the full blast). */}
			<div className="mt-1.5">
				{nodes.length === 1 ? (
					<code data-testid="node-name-code" className="font-mono text-lg text-foreground">
						{nodes[0]?.name}
					</code>
				) : (
					<code data-testid="node-names-code" className="font-mono text-lg text-foreground">
						{nodes.slice(0, 8).map((n) => n.name).join(", ")}
						{nodes.length > 8 ? `, and ${nodes.length - 8} more` : ""}
					</code>
				)}
			</div>
			{impact === "loading" && (
				<p className="mt-2 text-sm text-muted-foreground" data-testid="node-impact-loading">
					Reading what this would remove…
				</p>
			)}
			{impact === "gone" && (
				<div className="mt-2">
					<p className="text-sm text-muted-foreground">
						This topic is no longer in the graph — it was already removed elsewhere.
					</p>
					<div className="mt-4 flex justify-end">
						<button
							type="button"
							data-testid="node-delete-vanished-close"
							onClick={onClose}
							className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							Close
						</button>
					</div>
				</div>
			)}
			{typeof impact === "object" && (
				<>
					<p className="mt-2 text-sm text-muted-foreground">
						This permanently removes the topic and everything attached to it — this cannot be undone:
					</p>
					<ul
						data-testid="node-impact-facts"
						className="mt-3 space-y-1 rounded-lg border border-border/60 px-4 py-3 text-sm"
					>
						<li>{countLine(impact.edges, "link to another topic", "links to other topics")}</li>
						<li className="text-muted-foreground">
							Referenced by{" "}
							{impact.sessions.length === 0
								? "no session"
								: impact.sessions
										.map((id) => sessionNameOf(id, joins.sessions, joins.fileSources))
										.join(", ")}
						</li>
					</ul>
					{failure && (
						<div
							role="alert"
							data-testid="node-delete-failure"
							className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
						>
							<span className="text-foreground">
								{failure.code === "extraction_running" ? EXTRACTION_RETRY_LINE : failure.error}
							</span>
							<button
								type="button"
								data-testid="node-delete-retry"
								onClick={onRun}
								disabled={busy}
								className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
							>
								Try again
							</button>
						</div>
					)}
					<div className="mt-4 flex justify-end gap-2">
						<button
							type="button"
							data-testid="node-delete-cancel"
							onClick={onClose}
							disabled={busy}
							className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
						>
							Cancel
						</button>
						<button
							type="button"
							data-testid="node-delete-confirm"
							onClick={onRun}
							disabled={busy}
							// Destructive red (owner, polish round) — the
							// app's established destructive pair (chat's
							// refusal banner): border + text, fill on hover.
							className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
						>
							{busy ? "Deleting…" : "Delete"}
						</button>
					</div>
				</>
			)}
		</div>
	);
}

export function DeleteNodeDialog({
	nodes,
	joins,
	onClose,
	onDeleted,
}: {
	/** The nodes up for deletion; null/empty = closed. One (the canvas
	 *  context menu) or many (the chain table's selection). Names from
	 *  the client's snapshot — what the user sees is what the dialog
	 *  names. */
	nodes: { id: string; name: string }[] | null;
	joins: { sessions: Record<string, string>; fileSources: Record<string, string> };
	onClose: () => void;
	/** Success path — the graph view dispatches lh:graph-revision so the
	 *  snapshot refetches (node, edges, label vanish; clusters shrink or
	 *  unrender below the server's minimum). graphRevision rides the
	 *  event; 0 when the response carried none (a vanished node). The
	 *  deleted ids ride along so selection-side callers can prune. */
	onDeleted: (nodeIds: string[], graphRevision: number) => void;
}) {
	const [impact, setImpact] = useState<NodeImpact | "loading" | "gone">("loading");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);

	// Fresh state per node: closing resets; opening another node refetches.
	useEffect(() => {
		if (!nodes || nodes.length === 0) {
			setImpact("loading");
			setBusy(false);
			setFailure(null);
		}
	}, [nodes]);

	// The pre-flight impact read — for the dialog the user just opened.
	// A multi-selection reads every node and AGGREGATES: summed counts,
	// unioned referencing sessions (deduped, first-seen order). All-404
	// ("gone elsewhere meanwhile" for every one) is the honest gone state;
	// a mix renders the living ones' blast.
	useEffect(() => {
		if (!nodes || nodes.length === 0) return;
		let cancelled = false;
		setImpact("loading");
		setFailure(null);
		(async () => {
			try {
				const impacts = await Promise.all(
					nodes.map(async (n) => {
						const res = await fetch(`/api/graph/nodes/${encodeURIComponent(n.id)}`);
						if (res.status === 404) return null;
						if (!res.ok) throw new Error(String(res.status));
						return (await res.json()) as NodeImpact;
					}),
				);
				if (cancelled) return;
				const live = impacts.filter((i): i is NodeImpact => i !== null);
				if (live.length === 0) {
					setImpact("gone");
					return;
				}
				const seen = new Set<string>();
				const sessions: string[] = [];
				for (const i of live) for (const id of i.sessions) if (!seen.has(id)) { seen.add(id); sessions.push(id); }
				setImpact({
					edges: live.reduce((a, i) => a + i.edges, 0),
					sessions,
				});
			} catch {
				if (!cancelled) setImpact("gone"); // honest fallback, no facts invented
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [nodes]);

	// Esc closes (claimed — a dialog Esc must not also abort a turn).
	useEffect(() => {
		if (!nodes || nodes.length === 0) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [nodes, onClose]);

	// Sequential full deaths — never parallel (the store's revision
	// counter and the sweep must observe them in order). A failure STOPS
	// the run: what died, died; the failure line names why the rest
	// still stands (extraction_running especially must not be plowed
	// through). onDeleted fires with everything that actually died.
	const run = async () => {
		if (!nodes || nodes.length === 0 || busy) return;
		setBusy(true);
		setFailure(null);
		const dead: string[] = [];
		let revision = 0;
		try {
			for (const n of nodes) {
				const res = await fetch(`/api/graph/nodes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
				const body = (await res.json()) as {
					error?: string;
					code?: string;
					graphRevision?: number;
				};
				if (!res.ok) {
					setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
					setBusy(false);
					if (dead.length > 0) onDeleted(dead, revision);
					return;
				}
				dead.push(n.id);
				revision = body.graphRevision ?? revision;
			}
			onDeleted(dead, revision);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
			if (dead.length > 0) onDeleted(dead, revision);
		}
	};

	if (!nodes || nodes.length === 0) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			onClick={() => {
				if (!busy) onClose();
			}}
		>
			<DeleteNodeBody
				nodes={nodes}
				joins={joins}
				impact={impact}
				busy={busy}
				failure={failure}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}
