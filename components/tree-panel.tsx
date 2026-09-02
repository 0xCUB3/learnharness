"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	CheckIcon,
	ChevronsRightIcon,
	ListTreeIcon,
	MaximizeIcon,
	MinusIcon,
	NetworkIcon,
	PlusIcon,
} from "lucide-react";
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
* Three modes, one persisted preference: the LIST (nested — the default,
* and the always-visible "collapsed" view), the GRAPH (expanded: a
* hand-built mermaid-style diagram — full styling control, no mermaid
* renderer — with drag-pan + wheel-zoom whose FLOOR is fit-to-panel), and
* the RAIL (thin strip). Quiet register throughout (matches the phase
* dividers): hairline borders, muted text, one highlighted node for the
* current position. Hidden below `xl` (CSS-only).
*/

/** localStorage: the mode persists as "lh:tree-panel-mode"
 *  ("rail" | "list" | "graph"); the pre-graph key
 *  ("lh:tree-panel-collapsed": "1" rail / "0" list) is the fallback. */
/** The panel width per mode — the aside AND its fixed inner layer (see
 *  TreePanel: the inner layer must not squish while the aside animates). */
const PANEL_WIDTH: Record<PanelMode, string> = {
	rail: "w-10",
	list: "w-64",
	graph: "w-96",
};

const MODE_KEY = "lh:tree-panel-mode";
const LEGACY_KEY = "lh:tree-panel-collapsed";

/** The three panel modes: rail (fully collapsed) | list (default) | graph. */
type PanelMode = "rail" | "list" | "graph";

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

/**
 * The panel mode lives in the ROOT layout, not in TreePanel. TreePanel is
 * per-page (chat sessions remount it on every navigation), so a local copy
 * would paint its default first and then "correct" to the stored mode —
 * with the animated frame, opening a session visibly opened-then-closed
 * the panel. In the root layout the mode survives navigations untouched,
 * exactly like the left sidebar's open state (SidebarProvider).
 */
const TreePanelModeContext = createContext<{ mode: PanelMode; go: (next: PanelMode) => void }>({
	mode: "list",
	go: () => {},
});

/** Root-layout persistence of the panel mode (rail | list | graph). */
export function TreePanelModeProvider({ children }: { children: React.ReactNode }) {
	// SSR default: "list" — server and client first-render agree (no
	// hydration mismatch). The stored preference applies on mount, and
	// the provider itself never remounts, so after that first correction
	// the mode is simply THERE on every session you open.
	const [mode, setMode] = useState<PanelMode>("list");

	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(MODE_KEY);
			if (stored === "rail" || stored === "list" || stored === "graph") {
				setMode(stored);
			} else {
				// legacy key (pre-graph): "1" = the collapsed rail
				const legacy = window.localStorage.getItem(LEGACY_KEY);
				if (legacy === "1") setMode("rail");
			}
		} catch {
			// private mode / storage disabled — the preference is simply not persisted
		}
	}, []);

	const go = useCallback((next: PanelMode) => {
		setMode(next);
		try {
			window.localStorage.setItem(MODE_KEY, next);
		} catch {
			// see above
		}
	}, []);

	return <TreePanelModeContext.Provider value={{ mode, go }}>{children}</TreePanelModeContext.Provider>;
}

export function TreePanel({
	messages,
}: {
	messages: readonly TreePanelMessage[];
}) {
	const tree = useMemo(() => latestTree(messages), [messages]);
	const { mode, go } = useContext(TreePanelModeContext);

	// Empty state: no tree yet → the panel does not render at all. It appears
	// the moment plan_init's output lands and updates live from there.
	if (!tree || tree.nodes.length === 0) return null;

	// ONE animated container, exactly like the left sidebar: the aside
	// animates its width (sidebar-motion transition cascades from the
	// provider and is mount-gated there) while the inner layer keeps a
	// FIXED width and is clipped by overflow-hidden — content never
	// reflows mid-transition, so no scrollbar flash or overshoot. The
	// mode's content just swaps instantly inside the steady frame.
	return (
		<aside
			data-testid="tree-panel"
			className={cn(
				"sidebar-motion hidden shrink-0 overflow-hidden border-l border-border/60 bg-card/30 duration-200 xl:flex",
				PANEL_WIDTH[mode],
			)}
		>
			<div className={cn("flex h-full flex-col", PANEL_WIDTH[mode])}>
				{mode === "rail" ? (
					<TreePanelRail
						doneCount={tree.doneNodeIds.length}
						totalCount={tree.nodes.length}
						onExpand={() => go("list")}
					/>
				) : mode === "graph" ? (
					<TreeGraphPanel tree={tree} onShowList={() => go("list")} onCollapse={() => go("rail")} />
				) : (
					<TreePanelBody tree={tree} onShowGraph={() => go("graph")} onCollapse={() => go("rail")} />
				)}
			</div>
		</aside>
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
		<div
			data-testid="tree-panel-rail"
			className="flex h-full flex-col items-center gap-3 py-3"
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
		</div>
	);
}

/** The expanded panel (list mode): header + the node list in topological order. */
export function TreePanelBody({
	tree,
	onShowGraph,
	onCollapse,
}: {
	tree: PlanTree;
	/** Expand into the mermaid-style graph view. */
	onShowGraph: () => void;
	onCollapse: () => void;
}) {
	const { order, depth } = useMemo(() => topoLayout(tree), [tree]);
	const nextId = useMemo(() => nextNodeId(tree, order), [tree, order]);
	const doneCount = tree.doneNodeIds.length;
	const totalCount = tree.nodes.length;

	return (
		<div className="flex h-full flex-col">
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
					onClick={onShowGraph}
					title="Show plan graph"
					aria-label="Show plan graph"
					className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				>
					<NetworkIcon className="size-3.5" />
				</button>
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
		</div>
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

// ─── the graph (expanded view) ────────────────────────────────────────────────
//
// A hand-built mermaid-style diagram — NOT mermaid's renderer: the styling
// stays in this app's design language (phase colors, quiet strokes) and the
// status coloring maps 1:1 onto the list's marks. Boxes top-down (vertical
// space is the cheap axis here), layered by topoLayout depth, authoring
// order within a layer, edges as vertical bezier curves.

/** Graph geometry (px): node boxes and the gaps that carry the arrows. */
export const NODE_W = 176;
export const NODE_H = 48;
export const GAP_X = 28;
export const GAP_Y = 64;

/** Top-left position per node + the diagram's extent. */
export interface GraphLayout {
	x: Map<string, number>;
	y: Map<string, number>;
	width: number;
	height: number;
}

/**
 * Layered positions: depth = row (top-down), authoring order within the
 * row, each row centered on the widest one. No crossing-reduction pass —
 * the teacher authors nodes in dependency order as a rule, and v1 keeps
 * the layout deterministic and readable over prettier.
 */
export function graphLayout(order: readonly PlanNode[], depth: ReadonlyMap<string, number>): GraphLayout {
	const layers: PlanNode[][] = [];
	for (const n of order) {
		const d = depth.get(n.id) ?? 0;
		if (!layers[d]) layers[d] = [];
		layers[d].push(n);
	}
	const rowWidth = (l: PlanNode[]) => l.length * NODE_W + (l.length - 1) * GAP_X;
	let maxWidth = 0;
	for (const l of layers) maxWidth = Math.max(maxWidth, rowWidth(l));
	const x = new Map<string, number>();
	const y = new Map<string, number>();
	layers.forEach((l, d) => {
		const start = (maxWidth - rowWidth(l)) / 2;
		l.forEach((n, i) => {
			x.set(n.id, start + i * (NODE_W + GAP_X));
			y.set(n.id, d * (NODE_H + GAP_Y));
		});
	});
	const height = layers.length * NODE_H + (layers.length - 1) * GAP_Y;
	return { x, y, width: maxWidth, height: Math.max(height, 0) };
}

/**
 * Wrap a node title to at most `maxLines` lines of at most `maxChars`
 * (greedy word wrap); overflow ends in an ellipsis, a single oversized
 * word is hard-clamped. Pure — unit-tested.
 */
export function wrapTitle(title: string, maxChars = 22, maxLines = 2): string[] {
	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	for (const w of words) {
		const last = lines[lines.length - 1];
		const fits = last !== undefined && last.length + 1 + w.length <= maxChars;
		if (fits) {
			lines[lines.length - 1] = `${last} ${w}`;
		} else if (lines.length < maxLines) {
			lines.push(w.length > maxChars ? `${w.slice(0, maxChars - 1)}…` : w);
		} else {
			// out of lines: mark the last one as truncated (once)
			const lastLine = lines[lines.length - 1];
			if (lastLine !== undefined && !lastLine.endsWith("…")) {
				lines[lines.length - 1] = lastLine.length >= maxChars
					? `${lastLine.slice(0, maxChars - 1)}…`
					: `${lastLine}…`;
			}
		}
	}
	return lines;
}

/** Box + label styling per status — the graph's face of the list's marks:
 *  done = colored in (the teach-phase green), current = the position,
 *  next = the unlocked ring, upcoming = quiet. */
const GRAPH_BOX: Record<PlanNodeStatus, string> = {
	done: "fill-phase-teach/10 stroke-phase-teach/50",
	current: "fill-primary/10 stroke-primary",
	upcoming: "fill-card stroke-border",
};
const GRAPH_TEXT: Record<PlanNodeStatus, string> = {
	done: "fill-muted-foreground text-xs",
	current: "fill-foreground text-xs font-medium",
	upcoming: "fill-muted-foreground/80 text-xs",
};

const GRAPH_HEADER_BTN =
	"flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground";
const GRAPH_ZOOM_BTN =
	"pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground";

/** Zoom bounds: never below fit-to-panel (the graph can't disappear into
 *  nothing — fully zoomed out IS the fit), never above 2×. */
const ZOOM_MAX = 2;
const ZOOM_FLOOR = 0.15;

/** The graph's view transform: zoom + translation (viewport px). */
export interface GraphView {
	zoom: number;
	x: number;
	y: number;
}

/** The fit-centered view: the whole bw×bh graph centered in the w×h
 *  viewport — fully zoomed out is EXACTLY this, nothing to pan. */
export function fitGraphView(
	box: { w: number; h: number },
	viewport: { w: number; h: number },
	zoom: number,
): GraphView {
	return { zoom, x: (viewport.w - box.w * zoom) / 2, y: (viewport.h - box.h * zoom) / 2 };
}

/**
 * One zoom step toward `focus` (viewport px), clamped to [floor, ZOOM_MAX].
 * At the floor the view SNAPS to the fit-centered position: fully zoomed
 * out is THE fit view — centered, pan locked (the component enforces it).
 */
export function zoomedGraphView(
	view: GraphView,
	factor: number,
	floor: number,
	focus: { x: number; y: number },
	box: { w: number; h: number },
	viewport: { w: number; h: number },
): GraphView {
	const zoom = Math.min(Math.max(view.zoom * factor, floor), ZOOM_MAX);
	if (zoom === view.zoom) return view;
	if (zoom <= floor) return fitGraphView(box, viewport, floor);
	const k = zoom / view.zoom;
	return { zoom, x: focus.x - (focus.x - view.x) * k, y: focus.y - (focus.y - view.y) * k };
}

/**
 * The interactive diagram: drag to pan, wheel to zoom (to the cursor), the
 * fit button resets. The zoom floor is fit-to-panel — at it, the view is
 * EXACTLY the centered fit and panning is locked (there is nothing to
 * move). Auto-fits on first measure and on layout changes while the view
 * sits at the floor; once the learner zooms in or pans, the view is theirs
 * (until they return to the floor or press fit). SSR-safe: all measurement
 * lives in effects. The zoom controls sit INSIDE the pan surface but
 * never start a drag (pointer capture would swallow their clicks).
 */
export function TreeGraph({ tree }: { tree: PlanTree }) {
	const { order, depth } = useMemo(() => topoLayout(tree), [tree]);
	const nextId = useMemo(() => nextNodeId(tree, order), [tree, order]);
	const layout = useMemo(() => graphLayout(order, depth), [order, depth]);

	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });

	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			setSize({ w: el.clientWidth, h: el.clientHeight });
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// The zoom floor: fully zoomed out, the whole diagram fits the panel.
	// Pad 16: the fit view IS the default — slim margins fit more graph.
	const fitZoom = useMemo(() => {
		const pad = 16;
		if (!size.w || !size.h || layout.width === 0) return 1;
		return Math.max(
			ZOOM_FLOOR,
			Math.min((size.w - pad) / layout.width, (size.h - pad) / layout.height, 1),
		);
	}, [size, layout]);

	const [view, setView] = useState<GraphView>({ x: 0, y: 0, zoom: 1 });
	const userAdjustedRef = useRef(false);
	const box = useMemo(() => ({ w: layout.width, h: layout.height }), [layout]);
	// Epsilon: zoom is float; "at the floor" needs a tolerance.
	const atFloor = view.zoom <= fitZoom + 1e-9;

	// Being AT the floor re-arms auto-fit: fully zoomed out is the default
	// view, so later layout changes (tree edits) keep it fitting.
	useEffect(() => {
		if (atFloor) userAdjustedRef.current = false;
	}, [atFloor]);

	// Auto-fit (first measure, layout changes) — suppressed once the learner
	// takes manual control, until they return to the floor (or press fit).
	useEffect(() => {
		if (userAdjustedRef.current || !size.w || !size.h) return;
		setView(fitGraphView(box, size, fitZoom));
	}, [fitZoom, size, box]);

	// Wheel zoom to the cursor. Non-passive so the page never scrolls instead.
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // Firefox line mode
			const factor = Math.exp(-dy * 0.0015);
			const rect = el.getBoundingClientRect();
			setView((v) =>
				zoomedGraphView(
					v,
					factor,
					fitZoom,
					{ x: e.clientX - rect.left, y: e.clientY - rect.top },
					box,
					size,
				),
			);
			userAdjustedRef.current = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [fitZoom, box, size]);

	// Drag pan. Guards: the zoom controls sit inside the pan surface — their
	// pointerdown must NOT capture (capture redirects the click away from
	// the button — the bug that made them feel dead). And at the fit floor
	// there is nothing to pan: don't even begin (the cursor stays honest).
	const dragRef = useRef<{
		px: number;
		py: number;
		x: number;
		y: number;
		moved: boolean;
	} | null>(null);
	const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button")) return;
		if (atFloor) return;
		dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
		e.currentTarget.classList.add("cursor-grabbing");
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (!d) return;
		d.moved = true;
		setView((v) =>
			v.zoom <= fitZoom + 1e-9
				? v
				: { ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) },
		);
	};
	const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (d) {
			dragRef.current = null;
			if (d.moved) userAdjustedRef.current = true;
		}
		e.currentTarget.classList.remove("cursor-grabbing");
	};

	// Button zoom steps toward the viewport center (same math as wheel).
	const stepZoom = (factor: number) => {
		userAdjustedRef.current = true;
		setView((v) =>
			zoomedGraphView(v, factor, fitZoom, { x: size.w / 2, y: size.h / 2 }, box, size),
		);
	};
	const fitView = () => {
		userAdjustedRef.current = false;
		if (!size.w || !size.h) return;
		setView(fitGraphView(box, size, fitZoom));
	};

	return (
		<div
			ref={viewportRef}
			data-testid="plan-graph"
			className={cn(
				"relative min-h-0 flex-1 touch-none overflow-hidden select-none",
				atFloor ? "cursor-default" : "cursor-grab",
			)}
			onPointerDown={startDrag}
			onPointerMove={moveDrag}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
		>
			<div
				className="absolute top-0 left-0 origin-top-left"
				style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
			>
				<svg width={layout.width} height={layout.height} role="img" aria-label="Plan tree graph">
					<defs>
						<marker
							id="lh-plan-arrow"
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="6"
							markerHeight="6"
							orient="auto-start-reverse"
						>
							<path d="M0,1 L7,4 L0,7 z" className="fill-muted-foreground/50" />
						</marker>
					</defs>
					{tree.edges.map((e) => {
						const x1 = (layout.x.get(e.from) ?? 0) + NODE_W / 2;
						const y1 = (layout.y.get(e.from) ?? 0) + NODE_H;
						const x2 = (layout.x.get(e.to) ?? 0) + NODE_W / 2;
						const y2 = layout.y.get(e.to) ?? 0;
						const mid = (y1 + y2) / 2;
						return (
							<path
								key={`${e.from}->${e.to}`}
								d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
								className="fill-none stroke-muted-foreground/40"
								strokeWidth={1.5}
								markerEnd="url(#lh-plan-arrow)"
							/>
						);
					})}
					{order.map((n) => {
						const status: PlanNodeStatus = planNodeStatus(tree, n.id);
						const lines = wrapTitle(n.title);
						return (
							<g
								key={n.id}
								transform={`translate(${layout.x.get(n.id) ?? 0}, ${layout.y.get(n.id) ?? 0})`}
								data-testid={`graph-node-${n.id}`}
								data-status={status}
								data-next={n.id === nextId ? "true" : undefined}
							>
								<title>{n.summary ? `${n.title} — ${n.summary}` : n.title}</title>
								<rect width={NODE_W} height={NODE_H} rx={10} className={GRAPH_BOX[status]} strokeWidth={1.5} />
								{status === "current" && (
									<circle cx={NODE_W - 12} cy={12} r={3} className="fill-primary" aria-hidden />
								)}
								{lines.map((line, i) => (
									<text
										key={i}
										x={12}
										y={lines.length === 1 ? 29 : 19 + i * 14}
										className={GRAPH_TEXT[status]}
									>
										{line}
									</text>
								))}
							</g>
						);
					})}
				</svg>
			</div>

			{/* Quiet affordances: the hint and the zoom controls. */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-2">
				<span className="text-[10px] text-muted-foreground/60">Drag to pan · scroll to zoom</span>
				<div className="flex gap-1">
					<button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => stepZoom(1 / 1.25)} className={GRAPH_ZOOM_BTN}>
						<MinusIcon className="size-3.5" />
					</button>
					<button type="button" title="Fit plan to panel" aria-label="Fit plan to panel" onClick={fitView} data-testid="graph-fit" className={GRAPH_ZOOM_BTN}>
						<MaximizeIcon className="size-3.5" />
					</button>
					<button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => stepZoom(1.25)} className={GRAPH_ZOOM_BTN}>
						<PlusIcon className="size-3.5" />
					</button>
				</div>
			</div>
		</div>
	);
}

/** The expanded panel (graph mode): wider, the diagram, and the mode toggles. */
export function TreeGraphPanel({
	tree,
	onShowList,
	onCollapse,
}: {
	tree: PlanTree;
	onShowList: () => void;
	onCollapse: () => void;
}) {
	const doneCount = tree.doneNodeIds.length;
	const totalCount = tree.nodes.length;
	return (
		<div data-testid="tree-graph-panel" className="flex h-full flex-col">
			<header className="flex items-center gap-2 px-3 py-2.5">
				<NetworkIcon className="size-3.5 text-muted-foreground" />
				<span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Plan</span>
				<span
					className="ml-auto text-[11px] tabular-nums text-muted-foreground"
					title={`${doneCount} of ${totalCount} nodes done`}
				>
					{doneCount}/{totalCount}
				</span>
				<button
					type="button"
					onClick={onShowList}
					title="Show as list"
					aria-label="Show as list"
					className={GRAPH_HEADER_BTN}
				>
					<ListTreeIcon className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={onCollapse}
					title="Hide plan"
					aria-label="Hide plan"
					className={GRAPH_HEADER_BTN}
				>
					<ChevronsRightIcon className="size-3.5" />
				</button>
			</header>
			<TreeGraph tree={tree} />
		</div>
	);
}
