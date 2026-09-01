"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckIcon, ChevronsRightIcon, ListTreeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { planNodeStatus, type PlanNode, type PlanNodeStatus, type PlanTree } from "@/src/core";

/**
* The persistent plan-tree panel (vision §2 "Persistent tree view", W7).
*
* A collapsible column on the right side of the session: the whole tree, at
* all times, with per-node status (done / current / next / upcoming) derived
* from the SAME object the teacher edits — no separate state channel. The
* data source is the transcript itself: every plan_* tool returns the full
* updated tree in its output, so the panel scans backward for the LATEST
* output-available plan part and renders its tree. Live during streaming:
* set_current / mark_done outputs flip the panel mid-session.
*
* The panel and the agent's tools share one object with two faces (agent
* edits it, UI renders it) — the phase seam in the transcript
* (PhaseDivider, message-level) marks the transition; THIS panel is the
* surface for every plan_* part (they render nothing inline, by design).
*
* Quiet register (matches the phase dividers): hairline border, muted
* text, one highlighted row for the current position. Collapses to a thin
* rail; the preference persists in localStorage. Hidden below `xl`
* (CSS-only).
*/

/** localStorage key for the collapse preference (matches lh:sidebar-open). */
const STORAGE_KEY = "lh:tree-panel-collapsed";

/**
* Minimal structural slice of a UI message — anything with typed parts.
* (Same shape-of-shapes trick as src/core/phases.ts.)
*/
export interface TreePanelMessage {
	parts: ReadonlyArray<{ type: string; state?: string; output?: unknown }>;
}

/**
* The latest plan tree in the transcript: scans messages (and parts) backward
* for the LAST `tool-plan_*` part with an output available and returns its
* `output.tree`. A failed op ({ok:false}) still carries the current tree, so
* it counts; a malformed/missing output falls through to the next candidate.
* Null when no plan output exists yet (probe phase / pre-plan sessions).
*/
export function latestTree(
	messages: readonly TreePanelMessage[],
): PlanTree | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const parts = messages[m]?.parts;
		if (!parts) continue;
		for (let p = parts.length - 1; p >= 0; p--) {
			const part = parts[p]!;
			if (
				!part.type.startsWith("tool-plan_") ||
				part.state !== "output-available"
			)
				continue;
			const output = part.output as { tree?: PlanTree } | undefined;
			if (output?.tree && Array.isArray(output.tree.nodes)) return output.tree;
		}
	}
	return null;
}

/** Topological layout of a tree: display order + dependency depth per node. */
export interface TopoLayout {
	/** Nodes in topological order (prerequisites first), deterministically tie-broken by authoring order. */
	order: PlanNode[];
	/** Longest-path depth from a root — drives indentation (a DAG, not a tree: a node indents under its DEEPEST prerequisite). */
	depth: Map<string, number>;
}

/** Kahn's algorithm over the tree's `requires` edges. Server ops already guarantee a DAG. */
export function topoLayout(tree: PlanTree): TopoLayout {
	const index = new Map(tree.nodes.map((n, i) => [n.id, i] as const));
	const indegree = new Map<string, number>(
		tree.nodes.map((n) => [n.id, 0] as const),
	);
	const dependents = new Map<string, string[]>();
	for (const e of tree.edges) {
		if (!index.has(e.from) || !index.has(e.to)) continue; // defensive: dangling ids
		indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
		const list = dependents.get(e.from);
		if (list) list.push(e.to);
		else dependents.set(e.from, [e.to]);
	}

	// Deterministic: among the ready nodes always emit the earliest-authored first.
	const ready = tree.nodes
		.filter((n) => (indegree.get(n.id) ?? 0) === 0)
		.map((n) => n.id);
	const order: PlanNode[] = [];
	const depth = new Map<string, number>();
	const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
	while (ready.length > 0) {
		ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
		const id = ready.shift()!;
		const node = byId.get(id);
		if (node) order.push(node);
		let d = 0;
		for (const e of tree.edges) {
			if (e.to === id) d = Math.max(d, (depth.get(e.from) ?? 0) + 1);
		}
		depth.set(id, d);
		for (const t of dependents.get(id) ?? []) {
			const left = (indegree.get(t) ?? 0) - 1;
			indegree.set(t, left);
			if (left === 0) ready.push(t);
		}
	}
	// Unreachable only if the DAG invariant broke; keep every node visible regardless.
	for (const n of tree.nodes) {
		if (!depth.has(n.id)) {
			order.push(n);
			depth.set(n.id, 0);
		}
	}
	return { order, depth };
}

/**
* The "next" node (vision §2 lists it as a distinct state): the first
* upcoming node in topological order whose prerequisites are ALL done — the
* head of the unlocked frontier. Null when nothing is ready (or all done).
*/
export function nextNodeId(
	tree: PlanTree,
	order: readonly PlanNode[],
): string | null {
	const done = new Set(tree.doneNodeIds);
	for (const n of order) {
		if (planNodeStatus(tree, n.id) !== "upcoming") continue;
		const blocked = tree.edges.some((e) => e.to === n.id && !done.has(e.from));
		if (!blocked) return n.id;
	}
	return null;
}

// ─── panel ───────────────────────────────────────────────────────────────────

export function TreePanel({
	messages,
}: {
	messages: readonly TreePanelMessage[];
}) {
	const tree = useMemo(() => latestTree(messages), [messages]);

	// Start expanded so server and client first-render agree (no hydration
	// mismatch); the stored preference is applied after mount. Same pattern
	// as the sidebar.
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(STORAGE_KEY);
			if (stored !== null) setCollapsed(stored === "1");
		} catch {
			// private mode / storage disabled — the preference is simply not persisted
		}
	}, []);

	const toggle = () => {
		const next = !collapsed;
		setCollapsed(next);
		try {
			window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
		} catch {
			// see above
		}
	};

	// Empty state: no tree yet → the panel does not render at all. It appears
	// the moment plan_init's output lands and updates live from there.
	if (!tree || tree.nodes.length === 0) return null;

	return collapsed ? (
		<TreePanelRail
			doneCount={tree.doneNodeIds.length}
			totalCount={tree.nodes.length}
			onExpand={toggle}
		/>
	) : (
		<TreePanelBody tree={tree} onCollapse={toggle} />
	);
}

/** The collapsed panel: a thin strip with the map icon + quiet progress. */
export function TreePanelRail({
	doneCount,
	totalCount,
	onExpand,
}: {
	doneCount: number;
	totalCount: number;
	onExpand: () => void;
}) {
	return (
		<aside
			data-testid="tree-panel-rail"
			className="hidden w-10 shrink-0 flex-col items-center gap-3 border-l border-border/60 py-3 xl:flex"
		>
			<button
				type="button"
				onClick={onExpand}
				title="Show plan"
				aria-label="Show plan"
				className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
			>
				<ListTreeIcon className="size-4" />
			</button>
			<span
				className="text-[10px] tracking-widest text-muted-foreground/70 [writing-mode:vertical-rl]"
				title={`${doneCount} of ${totalCount} nodes done`}
			>
				{doneCount}/{totalCount}
			</span>
		</aside>
	);
}

/** The expanded panel: header + the node list in topological order. */
export function TreePanelBody({
	tree,
	onCollapse,
}: {
	tree: PlanTree;
	onCollapse: () => void;
}) {
	const { order, depth } = useMemo(() => topoLayout(tree), [tree]);
	const nextId = useMemo(() => nextNodeId(tree, order), [tree, order]);
	const doneCount = tree.doneNodeIds.length;
	const totalCount = tree.nodes.length;

	return (
		<aside
			data-testid="tree-panel"
			className="hidden w-64 shrink-0 flex-col border-l border-border/60 bg-card/30 xl:flex"
		>
			<header className="flex items-center gap-2 px-3 py-2.5">
				<ListTreeIcon className="size-3.5 text-muted-foreground" />
				<span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
					Plan
				</span>
				<span
					className="ml-auto text-[11px] tabular-nums text-muted-foreground"
					title={`${doneCount} of ${totalCount} nodes done`}
				>
					{doneCount}/{totalCount}
				</span>
				<button
					type="button"
					onClick={onCollapse}
					title="Hide plan"
					aria-label="Hide plan"
					className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				>
					<ChevronsRightIcon className="size-3.5" />
				</button>
			</header>

			{/* Keyed by tree.version: every mutation (contracts.ts) bumps it, so a
			    set_current/mark_done visibly re-animates the list mid-session. */}
			<nav
				key={tree.version}
				className="dock-variant min-h-0 flex-1 overflow-y-auto px-2 pb-4"
				aria-label="Plan tree"
			>
				<ol className="flex flex-col">
					{order.map((node) => {
						const status: PlanNodeStatus = planNodeStatus(tree, node.id);
						return (
							<li
								key={node.id}
								data-testid={`tree-node-${node.id}`}
								data-status={status}
								data-next={node.id === nextId ? "true" : undefined}
								title={node.summary || undefined}
								style={{ marginLeft: (depth.get(node.id) ?? 0) * 12 }}
								className={cn(
									"flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm",
									status === "current" && "bg-primary/10 text-foreground",
									status === "done" && "text-muted-foreground",
									status === "upcoming" && "text-muted-foreground/70",
								)}
							>
								<StatusMark status={status} next={node.id === nextId} />
								<span className="min-w-0 flex-1">
									<span className="flex items-baseline gap-1.5">
										<span
											className={cn(
												"truncate",
												status === "current" && "font-medium",
											)}
										>
											{node.title}
										</span>
										{node.id === nextId && (
											<span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary/80">
												next
											</span>
										)}
									</span>
									{/* The current position also surfaces its summary — the "where
									    we are, what this covers" answer without hovering. */}
									{status === "current" && node.summary && (
										<span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
											{node.summary}
										</span>
									)}
								</span>
							</li>
						);
					})}
				</ol>
			</nav>
		</aside>
	);
}

/** The per-state glyph: a settled check, the position dot, an unlocked ring, a hollow ring. */
function StatusMark({
	status,
	next = false,
}: {
	status: PlanNodeStatus;
	next?: boolean;
}) {
	switch (status) {
		case "done":
			return (
				<CheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
			);
		case "current":
			return (
				<span
					className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
					aria-hidden
				/>
			);
		case "upcoming":
			return (
				<span
					className={cn(
						"mt-1.5 size-2 shrink-0 rounded-full border",
						next ? "border-primary/60" : "border-muted-foreground/40",
					)}
					aria-hidden
				/>
			);
	}
}
